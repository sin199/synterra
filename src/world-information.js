import { actionIdentifier, boundedNumber, jsonObject, requireWorldMember, requiredText, worldError, writeWorldHistory } from './world-domain.js';

const SHARE_TYPES = new Set(['opportunity', 'project', 'belief', 'place']);
const SUBJECT_TYPES = new Set(['action', 'place', 'resident', 'asset', 'project', 'opportunity']);

async function relationship(client, worldId, senderId, recipientId) {
  const [left, right] = [senderId, recipientId].sort();
  const result = await client.query(`SELECT familiarity::text AS familiarity,trust::text AS trust,affinity::text AS affinity
    FROM world_relationships WHERE world_id=$1 AND agent_a_id=$2 AND agent_b_id=$3 FOR UPDATE`, [worldId, left, right]);
  return result.rows[0] || { familiarity: '0', trust: '0', affinity: '0' };
}

async function sourceClaim(client, { worldId, senderAgentId, informationType, subjectType, subjectKey, beliefKey }) {
  if (informationType === 'belief') {
    const result = await client.query(`SELECT estimate::text AS estimate,confidence::text AS confidence,sample_count AS "sampleCount",
        evidence FROM world_agent_beliefs WHERE world_id=$1 AND agent_id=$2 AND subject_type=$3
          AND subject_key=$4 AND belief_key=$5`, [worldId, senderAgentId, subjectType, subjectKey, beliefKey]);
    if (!result.rowCount) throw worldError('BELIEF_NOT_FOUND', 404);
    return { ...result.rows[0], beliefKey };
  }
  if (informationType === 'opportunity') {
    const result = await client.query(`SELECT id,title,description,opportunity_type AS type,status,requirements,reward,risk,
        created_world_time AS "createdWorldTime",expires_world_time AS "expiresWorldTime"
      FROM world_opportunities WHERE world_id=$1 AND id::text=$2`, [worldId, subjectKey]);
    if (!result.rowCount) throw worldError('OPPORTUNITY_NOT_FOUND', 404);
    return result.rows[0];
  }
  if (informationType === 'project') {
    const result = await client.query(`SELECT id,title,goal,project_type AS type,status,progress::text AS progress,
        required_skills AS "requiredSkills",created_world_time AS "createdWorldTime",deadline_world_time AS "deadlineWorldTime"
      FROM world_projects WHERE world_id=$1 AND id::text=$2`, [worldId, subjectKey]);
    if (!result.rowCount) throw worldError('PROJECT_NOT_FOUND', 404);
    return result.rows[0];
  }
  if (informationType === 'place') {
    const result = await client.query(`SELECT id,name,scene_type AS type,purpose,capacity,status,
        created_world_minutes AS "createdWorldTime" FROM world_scenes WHERE world_id=$1 AND id::text=$2`,
    [worldId, subjectKey]);
    if (!result.rowCount) throw worldError('PLACE_NOT_FOUND', 404);
    return result.rows[0];
  }
  throw worldError('INFORMATION_TYPE_INVALID', 400);
}

export async function shareWorldInformation(client, { worldId, senderAgentId, recipientAgentId, informationType,
  subjectType, subjectKey, beliefKey = null, actionId, worldTime, expiresWorldTime = null }) {
  await requireWorldMember(client, worldId, senderAgentId);
  await requireWorldMember(client, worldId, recipientAgentId);
  if (senderAgentId === recipientAgentId) throw worldError('INFORMATION_CANNOT_BE_SHARED_WITH_SELF', 400);
  const type = String(informationType || '').toLowerCase();
  const subject = String(subjectType || '').toLowerCase();
  if (!SHARE_TYPES.has(type) || !SUBJECT_TYPES.has(subject)) throw worldError('INFORMATION_TYPE_INVALID', 400);
  const key = actionIdentifier(actionId);
  await client.query('SELECT id FROM worlds WHERE id=$1 FOR UPDATE', [worldId]);
  const repeated = await client.query(`SELECT id,status FROM world_information_shares
    WHERE world_id=$1 AND sender_agent_id=$2 AND action_id=$3`, [worldId, senderAgentId, key]);
  if (repeated.rowCount) return { ...repeated.rows[0], idempotent: true };
  const worldTimeValue = Math.trunc(boundedNumber(worldTime, 0, Number.MAX_SAFE_INTEGER, 'world_time'));
  const relation = await relationship(client, worldId, senderAgentId, recipientAgentId);
  if (Number(relation.familiarity) < 10 || Number(relation.trust) < 2) throw worldError('INFORMATION_SHARE_REQUIRES_TRUST');
  const recent = await client.query(`SELECT 1 FROM world_information_shares
    WHERE world_id=$1 AND sender_agent_id=$2 AND recipient_agent_id=$3 AND shared_world_time>$4 LIMIT 1`,
  [worldId, senderAgentId, recipientAgentId, worldTimeValue - 60]);
  if (recent.rowCount) throw worldError('INFORMATION_SHARE_COOLDOWN');
  const normalizedSubject = requiredText(subjectKey, 1, 120, 'information_subject');
  if (['project', 'opportunity', 'place'].includes(subject)
    && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(normalizedSubject)) {
    throw worldError('INFORMATION_SUBJECT_INVALID', 400);
  }
  const claim = await sourceClaim(client, { worldId, senderAgentId, informationType: type,
    subjectType: subject === 'project' || subject === 'opportunity' ? subject :
      (type === 'belief' ? subject : type === 'place' ? 'place' : 'opportunity'),
    subjectKey: normalizedSubject, beliefKey: beliefKey ? requiredText(beliefKey, 1, 80, 'belief_key') : 'outcome' });
  const serialized = JSON.stringify(claim);
  if (Buffer.byteLength(serialized, 'utf8') > 2_048) throw worldError('INFORMATION_CLAIM_TOO_LARGE', 400);
  const claimConfidence = type === 'belief' ? Number(claim.confidence) : 0.6;
  const confidence = Math.max(0.05, Math.min(0.85, claimConfidence * 0.75));
  const expires = expiresWorldTime === null ? worldTimeValue + 240
    : Math.trunc(boundedNumber(expiresWorldTime, worldTimeValue, Number.MAX_SAFE_INTEGER, 'expires_world_time'));
  const inserted = await client.query(`INSERT INTO world_information_shares(world_id,sender_agent_id,recipient_agent_id,
      information_type,subject_type,subject_key,claim,confidence,status,action_id,shared_world_time,expires_world_time)
    VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,'offered',$9,$10,$11) RETURNING id,status`,
  [worldId, senderAgentId, recipientAgentId, type, type === 'belief' ? subject : type === 'project' ? 'project'
    : type === 'place' ? 'place' : 'opportunity', normalizedSubject, serialized, confidence, key, worldTimeValue, expires]);
  const share = inserted.rows[0];
  await client.query(`INSERT INTO world_events(world_id,actor_id,event_type,data,action_id)
    VALUES($1,$2,'world.information_shared',$3::jsonb,$4) ON CONFLICT(world_id,actor_id,action_id) DO NOTHING`,
  [worldId, senderAgentId, JSON.stringify({ shareId: share.id, recipientAgentId, informationType: type,
    subjectType: subject, subjectKey: normalizedSubject, confidence, worldTime: worldTimeValue }), key]);
  await writeWorldHistory(client, { worldId, eventKey: `information:${share.id}:shared`, eventType: 'information_shared',
    actorAgentId: senderAgentId, entityType: type === 'project' ? 'project' : type === 'place' ? 'place'
      : type === 'opportunity' ? 'opportunity' : 'world',
    entityId: ['project', 'place', 'opportunity'].includes(subject) ? normalizedSubject : null, worldTime: worldTimeValue,
    title: type === 'belief' ? 'A resident shared a personal belief.' : `A resident shared ${type} information.`,
    detail: 'The recipient can accept, ignore, or doubt the information.',
    metadata: { shareId: share.id, recipientAgentId, confidence } });
  return { ...share, recipientAgentId, confidence };
}

function estimateFromClaim(share) {
  const claim = typeof share.claim === 'string' ? JSON.parse(share.claim) : (share.claim || {});
  if (share.information_type === 'belief') {
    const estimate = Number(claim.estimate);
    return Number.isFinite(estimate) ? Math.max(-100, Math.min(100, estimate)) : 0;
  }
  if (share.information_type === 'project') return Math.max(-1, Math.min(1, Number(claim.progress || 0) / 100));
  if (share.information_type === 'opportunity') return ['open','active'].includes(claim.status) ? 0.25 : -0.2;
  if (share.information_type === 'place') return claim.status === 'active' ? 0.2 : -0.1;
  return 0;
}

async function updateBeliefFromShare(client, share, recipientAgentId, trust, worldTime) {
  const claim = typeof share.claim === 'string' ? JSON.parse(share.claim) : (share.claim || {});
  const beliefKey = share.information_type === 'belief' ? String(claim.beliefKey || 'outcome') : 'shared_awareness';
  const incomingEstimate = estimateFromClaim(share);
  const trustWeight = Math.max(0.1, Math.min(1, (Number(trust) + 20) / 80));
  const incomingConfidence = Math.max(0.05, Math.min(0.6, Number(share.confidence) * trustWeight));
  const current = await client.query(`SELECT estimate::text AS estimate,confidence::text AS confidence,sample_count AS "sampleCount"
    FROM world_agent_beliefs WHERE world_id=$1 AND agent_id=$2 AND subject_type=$3 AND subject_key=$4 AND belief_key=$5 FOR UPDATE`,
  [share.world_id, recipientAgentId, share.subject_type, share.subject_key, beliefKey]);
  let estimate = incomingEstimate;
  let confidence = incomingConfidence;
  let sampleCount = 1;
  if (current.rowCount) {
    const priorConfidence = Number(current.rows[0].confidence) || 0.1;
    const priorWeight = Math.max(0.05, priorConfidence);
    estimate = (Number(current.rows[0].estimate) * priorWeight + incomingEstimate * incomingConfidence) / (priorWeight + incomingConfidence);
    confidence = Math.min(0.85, Math.max(priorConfidence, incomingConfidence) + Math.abs(incomingEstimate - Number(current.rows[0].estimate)) * 0.05);
    sampleCount = (Number(current.rows[0].sampleCount) || 0) + 1;
  }
  await client.query(`INSERT INTO world_agent_beliefs(world_id,agent_id,subject_type,subject_key,belief_key,estimate,confidence,
      sample_count,updated_world_minutes,evidence)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
    ON CONFLICT(world_id,agent_id,subject_type,subject_key,belief_key) DO UPDATE SET estimate=EXCLUDED.estimate,
      confidence=EXCLUDED.confidence,updated_world_minutes=EXCLUDED.updated_world_minutes,evidence=EXCLUDED.evidence`,
  [share.world_id, recipientAgentId, share.subject_type, share.subject_key, beliefKey, estimate, confidence, sampleCount,
    worldTime, JSON.stringify({ sourceShareId: share.id, senderAgentId: share.sender_agent_id,
      directExperience: false, sharedConfidence: share.confidence })]);
}

export async function decideWorldInformationShare(client, { worldId, shareId, recipientAgentId, decision, actionId, worldTime }) {
  await requireWorldMember(client, worldId, recipientAgentId);
  const choice = String(decision || '').toLowerCase();
  if (!['accept','ignore','doubt'].includes(choice)) throw worldError('INFORMATION_DECISION_INVALID', 400);
  const key = actionIdentifier(actionId);
  const repeated = await client.query(`SELECT id,status FROM world_information_shares
    WHERE world_id=$1 AND recipient_agent_id=$2 AND received_action_id=$3`, [worldId, recipientAgentId, key]);
  if (repeated.rowCount) return { ...repeated.rows[0], idempotent: true };
  const result = await client.query(`SELECT * FROM world_information_shares WHERE world_id=$1 AND id=$2 FOR UPDATE`, [worldId, shareId]);
  if (!result.rowCount) throw worldError('INFORMATION_SHARE_NOT_FOUND', 404);
  const share = result.rows[0];
  const lockedRetry = await client.query(`SELECT id,status FROM world_information_shares
    WHERE world_id=$1 AND recipient_agent_id=$2 AND received_action_id=$3`, [worldId, recipientAgentId, key]);
  if (lockedRetry.rowCount) return { ...lockedRetry.rows[0], idempotent: true };
  if (share.recipient_agent_id !== recipientAgentId) throw worldError('INFORMATION_SHARE_NOT_FOR_RESIDENT', 403);
  if (share.status !== 'offered') throw worldError('INFORMATION_SHARE_ALREADY_RESOLVED');
  if (share.expires_world_time !== null && Number(share.expires_world_time) <= Number(worldTime)) {
    await client.query(`UPDATE world_information_shares SET status='expired',updated_at=now() WHERE world_id=$1 AND id=$2`,
      [worldId, shareId]);
    throw worldError('INFORMATION_SHARE_EXPIRED');
  }
  const relation = await relationship(client, worldId, share.sender_agent_id, recipientAgentId);
  const status = choice === 'accept' ? 'accepted' : choice === 'doubt' ? 'doubted' : 'ignored';
  await client.query(`UPDATE world_information_shares SET status=$3,received_action_id=$4,updated_at=now()
    WHERE world_id=$1 AND id=$2`, [worldId, shareId, status, key]);
  if (choice === 'accept') await updateBeliefFromShare(client, share, recipientAgentId, relation.trust, worldTime);
  if (choice === 'doubt' || choice === 'accept') {
    const [left, right] = [share.sender_agent_id, recipientAgentId].sort();
    const trustDelta = choice === 'accept' ? 0.35 : -0.5;
    await client.query(`UPDATE world_relationships SET trust=GREATEST(-100,LEAST(100,trust+$4)),
        interaction_count=interaction_count+1,last_interaction_world_minutes=$5,updated_at=now()
      WHERE world_id=$1 AND agent_a_id=$2 AND agent_b_id=$3`, [worldId, left, right, trustDelta, worldTime]);
  }
  const event = await client.query(`INSERT INTO world_events(world_id,actor_id,event_type,data,action_id)
    VALUES($1,$2,$3,$4::jsonb,$5) ON CONFLICT(world_id,actor_id,action_id) DO NOTHING RETURNING id`,
  [worldId, recipientAgentId, choice === 'accept' ? 'world.information_accepted'
    : choice === 'doubt' ? 'world.information_doubted' : 'world.information_ignored',
  JSON.stringify({ shareId, senderAgentId: share.sender_agent_id, decision: choice, subjectType: share.subject_type,
    subjectKey: share.subject_key, worldTime }), key]);
  const eventId = event.rows[0]?.id || null;
  await writeWorldHistory(client, { worldId, eventKey: `information:${shareId}:decision`,
    eventType: choice === 'doubt' ? 'information_doubted' : choice === 'accept' ? 'information_accepted' : 'information_ignored',
    actorAgentId: recipientAgentId, entityType: ['project','opportunity','place'].includes(share.subject_type)
      ? share.subject_type : 'world', entityId: ['project','opportunity','place'].includes(share.subject_type) ? share.subject_key : null,
    worldTime, title: choice === 'accept' ? 'A resident accepted shared information.'
      : choice === 'doubt' ? 'A resident questioned shared information.' : 'A resident ignored shared information.',
    detail: 'Information affected only the recipient who evaluated it.', metadata: { shareId, senderAgentId: share.sender_agent_id } });
  if (eventId) {
    const memoryText = choice === 'accept' ? 'Accepted a trusted resident’s shared information after personal evaluation.'
      : choice === 'doubt' ? 'Questioned information shared by another resident.' : 'Chose not to act on information shared by another resident.';
    await client.query(`INSERT INTO agent_memories(world_id,agent_id,memory_type,summary,importance,world_minutes,
        related_agent_id,metadata,source_event_id)
      VALUES($1,$2,'information',$3,$4,$5,$6,$7::jsonb,$8)
      ON CONFLICT(world_id,agent_id,source_event_id) WHERE source_event_id IS NOT NULL DO NOTHING`,
    [worldId, recipientAgentId, memoryText, choice === 'accept' ? 0.32 : 0.24, worldTime, share.sender_agent_id,
      JSON.stringify({ shareId, decision: choice, confidence: share.confidence }), eventId]);
  }
  return { id: shareId, status };
}

export async function expireInformationShares(client, worldId, worldTime) {
  const expired = await client.query(`UPDATE world_information_shares SET status='expired',updated_at=now()
    WHERE world_id=$1 AND status='offered' AND expires_world_time IS NOT NULL AND expires_world_time<=$2
    RETURNING id`, [worldId, worldTime]);
  return expired.rowCount;
}

export async function listInformationInbox(client, { worldId, recipientAgentId, limit = 20 }) {
  await requireWorldMember(client, worldId, recipientAgentId);
  const result = await client.query(`SELECT share.id,share.sender_agent_id AS "senderAgentId",sender.name AS "senderName",
      share.information_type AS "informationType",share.subject_type AS "subjectType",share.subject_key AS "subjectKey",
      share.claim,share.confidence::text AS confidence,share.status,share.shared_world_time AS "sharedWorldTime",
      share.expires_world_time AS "expiresWorldTime"
    FROM world_information_shares share JOIN agents sender ON sender.id=share.sender_agent_id
    WHERE share.world_id=$1 AND share.recipient_agent_id=$2 AND share.status='offered'
    ORDER BY share.shared_world_time DESC,share.id LIMIT $3`,
  [worldId, recipientAgentId, Math.trunc(boundedNumber(limit, 1, 100, 'limit'))]);
  return result.rows;
}

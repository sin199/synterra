import { actionIdentifier, boundedNumber, jsonObject, requireWorldMember, requiredText, seededIndex, worldError, writeWorldHistory } from './world-domain.js';

export const OPPORTUNITY_TYPES = Object.freeze(['WORK', 'RESEARCH', 'TRADE', 'SOCIAL', 'COOPERATION', 'BUILD', 'LEARNING']);
export const OPPORTUNITY_STATUSES = Object.freeze(['open', 'active', 'completed', 'failed', 'expired', 'closed']);
const SOURCE_TYPES = new Set(['environment', 'place', 'resident', 'organization', 'event', 'project']);
const ACTIVE_STATUSES = ['open', 'active'];

function normalizeRequirements(value = {}) {
  const requirements = jsonObject(value, 'requirements');
  const minSkills = jsonObject(requirements.minSkills, 'requirements_min_skills');
  for (const [skill, score] of Object.entries(minSkills)) boundedNumber(score, 0, 100, `skill_${skill}`);
  const goalCategories = requirements.goalCategories ?? [];
  if (!Array.isArray(goalCategories) || goalCategories.length > 12
    || goalCategories.some((goal) => typeof goal !== 'string' || !/^[A-Z][A-Z0-9_]{1,63}$/.test(goal))) {
    throw worldError('REQUIREMENTS_GOALS_INVALID', 400);
  }
  return { ...requirements, minSkills, goalCategories,
    minEnergy: requirements.minEnergy === undefined ? 0 : boundedNumber(requirements.minEnergy, 0, 100, 'min_energy'),
    minFood: requirements.minFood === undefined ? 0 : boundedNumber(requirements.minFood, 0, 100, 'min_food') };
}

export function opportunityFit(opportunity, agent) {
  const requirements = typeof opportunity.requirements === 'string'
    ? JSON.parse(opportunity.requirements || '{}') : (opportunity.requirements || {});
  const skills = agent.skills || {};
  if (Number(agent.energy) < Number(requirements.minEnergy || 0) || Number(agent.food) < Number(requirements.minFood || 0)) return false;
  for (const [skill, minValue] of Object.entries(requirements.minSkills || {})) {
    if (Number(skills[skill] || 0) < Number(minValue)) return false;
  }
  if (requirements.goalCategories?.length) {
    const categories = new Set((agent.goals || []).filter((goal) => goal.status === 'active').map((goal) => goal.category));
    if (!requirements.goalCategories.some((goal) => categories.has(goal))) return false;
  }
  return true;
}

export async function createWorldOpportunity(client, input) {
  const worldId = requiredText(input.worldId, 36, 36, 'world_id');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(worldId)) {
    throw worldError('WORLD_ID_INVALID', 400);
  }
  const creatorAgentId = input.creatorAgentId || null;
  if (creatorAgentId) await requireWorldMember(client, worldId, creatorAgentId);
  const type = String(input.type || '').toUpperCase();
  if (!OPPORTUNITY_TYPES.includes(type)) throw worldError('OPPORTUNITY_TYPE_INVALID', 400);
  const sourceType = String(input.sourceType || 'environment');
  if (!SOURCE_TYPES.has(sourceType)) throw worldError('OPPORTUNITY_SOURCE_INVALID', 400);
  const title = requiredText(input.title, 3, 96, 'title');
  const description = requiredText(input.description, 12, 500, 'description');
  const capacity = Math.trunc(boundedNumber(input.capacity ?? 1, 1, 100, 'capacity'));
  const worldTime = Math.trunc(boundedNumber(input.worldTime ?? 0, 0, Number.MAX_SAFE_INTEGER, 'world_time'));
  const expiresWorldTime = input.expiresWorldTime === null || input.expiresWorldTime === undefined
    ? null : Math.trunc(boundedNumber(input.expiresWorldTime, worldTime, Number.MAX_SAFE_INTEGER, 'expires_world_time'));
  const requirements = normalizeRequirements(input.requirements);
  const reward = jsonObject(input.reward, 'reward');
  const risk = jsonObject(input.risk, 'risk');
  const metadata = jsonObject(input.metadata);
  const dedupeKey = input.dedupeKey ? requiredText(input.dedupeKey, 1, 160, 'dedupe_key') : null;

  await client.query('SELECT id FROM worlds WHERE id=$1 FOR UPDATE', [worldId]);
  if (dedupeKey) {
    const existing = await client.query(`SELECT id,status FROM world_opportunities WHERE world_id=$1 AND dedupe_key=$2`, [worldId, dedupeKey]);
    if (existing.rowCount) return { ...existing.rows[0], created: false };
  }
  const capacityResult = await client.query(`SELECT count(*)::int AS count FROM world_opportunities
    WHERE world_id=$1 AND status=ANY($2::text[])`, [worldId, ACTIVE_STATUSES]);
  if (Number(capacityResult.rows[0].count) >= 40) return { id: null, status: 'capacity_reached', created: false };
  const result = await client.query(`INSERT INTO world_opportunities(world_id,opportunity_type,creator_agent_id,source_type,
      source_key,scene_id,title,description,requirements,reward,risk,capacity,status,created_world_time,expires_world_time,
      dedupe_key,metadata)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11::jsonb,$12,'open',$13,$14,$15,$16::jsonb)
    RETURNING id,status`,
  [worldId, type, creatorAgentId, sourceType, input.sourceKey || null, input.sceneId || null, title, description,
    JSON.stringify(requirements), JSON.stringify(reward), JSON.stringify(risk), capacity, worldTime, expiresWorldTime,
    dedupeKey, JSON.stringify(metadata)]);
  const opportunity = result.rows[0];
  await writeWorldHistory(client, { worldId, eventKey: `opportunity:${opportunity.id}:created`, eventType: 'opportunity_created',
    actorAgentId: creatorAgentId, entityType: 'opportunity', entityId: opportunity.id, worldTime, title,
    detail: description, metadata: { type, sourceType } });
  return { ...opportunity, created: true };
}

export async function listAvailableOpportunities(client, { worldId, agentId, worldTime, limit = 32 }) {
  await requireWorldMember(client, worldId, agentId);
  const result = await client.query(`SELECT opportunity.*,scene.name AS "sceneName",
      count(participant.agent_id) FILTER (WHERE participant.status='accepted')::int AS "acceptedCount"
    FROM world_opportunities opportunity LEFT JOIN world_scenes scene ON scene.id=opportunity.scene_id
    LEFT JOIN world_opportunity_participants participant ON participant.world_id=opportunity.world_id
      AND participant.opportunity_id=opportunity.id
    WHERE opportunity.world_id=$1 AND opportunity.status=ANY($2::text[])
      AND (opportunity.expires_world_time IS NULL OR opportunity.expires_world_time>$3)
      AND NOT EXISTS (SELECT 1 FROM world_opportunity_participants mine
        WHERE mine.opportunity_id=opportunity.id AND mine.agent_id=$4)
    GROUP BY opportunity.id,scene.name ORDER BY opportunity.created_world_time DESC,opportunity.id LIMIT $5`,
  [worldId, ACTIVE_STATUSES, worldTime, agentId, Math.trunc(boundedNumber(limit, 1, 100, 'limit'))]);
  return result.rows;
}

export async function decideWorldOpportunity(client, { worldId, opportunityId, agentId, decision, actionId, worldTime, agent }) {
  await requireWorldMember(client, worldId, agentId);
  const normalizedDecision = String(decision || '').toLowerCase();
  if (!['accept', 'reject'].includes(normalizedDecision)) throw worldError('OPPORTUNITY_DECISION_INVALID', 400);
  const key = actionIdentifier(actionId);
  const repeated = await client.query(`SELECT participant.*,opportunity.status AS "opportunityStatus"
    FROM world_opportunity_participants participant JOIN world_opportunities opportunity
      ON opportunity.id=participant.opportunity_id
    WHERE participant.world_id=$1 AND participant.agent_id=$2 AND participant.action_id=$3`, [worldId, agentId, key]);
  if (repeated.rowCount) return { ...repeated.rows[0], idempotent: true };
  const opportunityResult = await client.query(`SELECT * FROM world_opportunities WHERE world_id=$1 AND id=$2 FOR UPDATE`,
    [worldId, opportunityId]);
  if (!opportunityResult.rowCount) throw worldError('OPPORTUNITY_NOT_FOUND', 404);
  const opportunity = opportunityResult.rows[0];
  const lockedRetry = await client.query(`SELECT participant.*,opportunity.status AS "opportunityStatus"
    FROM world_opportunity_participants participant JOIN world_opportunities opportunity
      ON opportunity.world_id=participant.world_id AND opportunity.id=participant.opportunity_id
    WHERE participant.world_id=$1 AND participant.agent_id=$2 AND participant.action_id=$3`, [worldId, agentId, key]);
  if (lockedRetry.rowCount) return { ...lockedRetry.rows[0], idempotent: true };
  if (!ACTIVE_STATUSES.includes(opportunity.status)) throw worldError('OPPORTUNITY_NOT_OPEN');
  if (opportunity.expires_world_time !== null && Number(opportunity.expires_world_time) <= Number(worldTime)) {
    await client.query(`UPDATE world_opportunities SET status='expired',updated_at=now() WHERE id=$1`, [opportunityId]);
    throw worldError('OPPORTUNITY_EXPIRED');
  }
  const prior = await client.query(`SELECT status FROM world_opportunity_participants
    WHERE world_id=$1 AND opportunity_id=$2 AND agent_id=$3 FOR UPDATE`, [worldId, opportunityId, agentId]);
  if (prior.rowCount) throw worldError('OPPORTUNITY_ALREADY_DECIDED');
  if (normalizedDecision === 'accept') {
    if (!opportunityFit(opportunity, agent || {})) throw worldError('OPPORTUNITY_REQUIREMENTS_NOT_MET');
    const active = await client.query(`SELECT count(*)::int AS count FROM world_opportunity_participants
      WHERE world_id=$1 AND opportunity_id=$2 AND status='accepted'`, [worldId, opportunityId]);
    if (Number(active.rows[0].count) >= Number(opportunity.capacity)) throw worldError('OPPORTUNITY_CAPACITY_REACHED');
  }
  const status = normalizedDecision === 'accept' ? 'accepted' : 'rejected';
  const inserted = await client.query(`INSERT INTO world_opportunity_participants(world_id,opportunity_id,agent_id,status,
      action_id,joined_world_time,updated_world_time)
    VALUES($1,$2,$3,$4,$5,$6,$6) RETURNING *`, [worldId, opportunityId, agentId, status, key, worldTime]);
  if (status === 'accepted') {
    await client.query(`UPDATE world_opportunities SET status='active',updated_at=now() WHERE id=$1 AND status='open'`, [opportunityId]);
  }
  await client.query(`INSERT INTO world_events(world_id,actor_id,event_type,data,action_id)
    VALUES($1,$2,'world.opportunity_decided',$3::jsonb,$4) ON CONFLICT(world_id,actor_id,action_id) DO NOTHING`,
  [worldId, agentId, JSON.stringify({ opportunityId, decision: normalizedDecision, type: opportunity.opportunity_type,
    worldTime: Number(worldTime) }), key]);
  return { ...inserted.rows[0], opportunityStatus: status === 'accepted' ? 'active' : opportunity.status };
}

export async function completeOpportunityParticipation(client, { worldId, opportunityId, agentId, worldTime,
  outcome = {}, succeeded = true }) {
  const selected = await client.query(`SELECT opportunity.* FROM world_opportunities opportunity
    JOIN world_opportunity_participants participant ON participant.world_id=opportunity.world_id
      AND participant.opportunity_id=opportunity.id
    WHERE opportunity.world_id=$1 AND opportunity.id=$2 AND participant.agent_id=$3 AND participant.status='accepted'
    FOR UPDATE OF opportunity,participant`, [worldId, opportunityId, agentId]);
  if (!selected.rowCount) return { completed: false, reason: 'participation_not_active' };
  const opportunity = selected.rows[0];
  const status = succeeded ? 'completed' : 'failed';
  const changed = await client.query(`UPDATE world_opportunity_participants SET status=$4,outcome=$5::jsonb,
      updated_world_time=$6,updated_at=now()
    WHERE world_id=$1 AND opportunity_id=$2 AND agent_id=$3 AND status='accepted' RETURNING agent_id`,
  [worldId, opportunityId, agentId, status, JSON.stringify(outcome), worldTime]);
  if (!changed.rowCount) return { completed: false, reason: 'already_resolved' };
  let rewardApplied = null;
  if (succeeded) {
    const reward = typeof opportunity.reward === 'string' ? JSON.parse(opportunity.reward || '{}') : opportunity.reward || {};
    const skill = typeof reward.skill === 'string' && /^[a-z][a-z0-9_]{1,47}$/.test(reward.skill) ? reward.skill : null;
    const gain = Math.max(0, Math.min(3, Number(reward.skillGain) || 0));
    if (skill && gain > 0) {
      const applied = await client.query(`INSERT INTO world_agent_skills(world_id,agent_id,skill_name,skill_value,actions_completed)
        VALUES($1,$2,$3,$4,1) ON CONFLICT(world_id,agent_id,skill_name) DO UPDATE SET
          skill_value=LEAST(100,world_agent_skills.skill_value+EXCLUDED.skill_value),
          actions_completed=world_agent_skills.actions_completed+1,updated_at=now()
        RETURNING skill_value::text AS "skillValue"`, [worldId, agentId, skill, gain]);
      rewardApplied = { skill, gain, skillValue: applied.rows[0].skillValue };
    }
  }
  const pending = await client.query(`SELECT count(*)::int AS count FROM world_opportunity_participants
    WHERE world_id=$1 AND opportunity_id=$2 AND status='accepted'`, [worldId, opportunityId]);
  if (Number(pending.rows[0].count) === 0) {
    const anySuccess = await client.query(`SELECT count(*)::int AS count FROM world_opportunity_participants
      WHERE world_id=$1 AND opportunity_id=$2 AND status='completed'`, [worldId, opportunityId]);
    await client.query(`UPDATE world_opportunities SET status=$3,updated_at=now()
      WHERE world_id=$1 AND id=$2 AND status='active'`, [worldId, opportunityId,
      Number(anySuccess.rows[0].count) > 0 ? 'completed' : 'failed']);
  }
  return { completed: true, opportunity, status, rewardApplied };
}

export async function expireWorldOpportunities(client, worldId, worldTime) {
  const expired = await client.query(`UPDATE world_opportunities SET status='expired',updated_at=now()
    WHERE world_id=$1 AND status=ANY($2::text[]) AND expires_world_time IS NOT NULL AND expires_world_time<=$3
    RETURNING id,title`, [worldId, ACTIVE_STATUSES, worldTime]);
  if (expired.rowCount) await client.query(`UPDATE world_opportunity_participants SET status='failed',
      updated_world_time=$2,updated_at=now() WHERE world_id=$1 AND status='accepted'
      AND opportunity_id=ANY($3::uuid[])`, [worldId, worldTime, expired.rows.map((row) => row.id)]);
  return expired.rows;
}

export function selectOpportunityTypeForGoal(goal) {
  const key = String(goal || '').toUpperCase();
  if (key.includes('RESEARCH') || key.includes('LEARN')) return 'RESEARCH';
  if (key.includes('RELATIONSHIP') || key.includes('COMMUNITY') || key.includes('SOCIAL')) return 'SOCIAL';
  if (key.includes('ENGINEERING') || key.includes('BUILD')) return 'BUILD';
  if (key.includes('TRADING') || key.includes('TRADE')) return 'TRADE';
  return ['WORK','RESEARCH','LEARNING','COOPERATION'][seededIndex(key, 4)];
}

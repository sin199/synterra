import { actionIdentifier, boundedNumber, jsonObject, requireWorldMember, requiredText, worldError, writeWorldHistory } from './world-domain.js';
import { ensureEconomicAccount } from './economic-ledger.js';
import { completeOpportunityParticipation } from './world-opportunities.js';
import { createProjectPlace, PLACE_TYPES } from './world-places.js';
import { isGenesisCurrencyActive } from './genesis-economy.js';

export const PROJECT_TYPES = Object.freeze(['RESEARCH', 'TRADE', 'BUILD', 'SOCIAL', 'DATA', 'LEARNING', 'GENERAL']);
const OPEN_PROJECT_STATES = ['idea', 'proposed', 'recruiting', 'active'];
const CONTRIBUTION_TYPES = new Set(['work', 'research', 'learning', 'planning', 'resource', 'place']);

function normalizeProjectType(value) {
  const type = String(value || 'GENERAL').toUpperCase();
  if (!PROJECT_TYPES.includes(type)) throw worldError('PROJECT_TYPE_INVALID', 400);
  return type;
}

function normalizeSkills(value = {}) {
  const skills = jsonObject(value, 'required_skills');
  const normalized = {};
  for (const [name, level] of Object.entries(skills)) {
    if (!/^[a-z][a-z0-9_]{1,47}$/.test(name)) throw worldError('PROJECT_SKILL_INVALID', 400);
    normalized[name] = boundedNumber(level, 0, 100, `skill_${name}`);
  }
  return normalized;
}

function normalizeResources(value = {}) {
  const resources = jsonObject(value, 'required_resources');
  const effortPoints = boundedNumber(resources.effortPoints ?? 30, 5, 1_000, 'effort_points');
  const maxParticipants = Math.trunc(boundedNumber(resources.maxParticipants ?? 4, 1, 20, 'max_participants'));
  return { ...resources, effortPoints, maxParticipants };
}

function normalizeReward(value = {}, projectType) {
  const reward = jsonObject(value, 'project_reward');
  const skill = reward.skill || contributionSkill(projectType);
  if (!['trading', 'research', 'engineering', 'social'].includes(skill)) throw worldError('PROJECT_REWARD_SKILL_INVALID', 400);
  return { skill,
    skillGain: boundedNumber(reward.skillGain ?? 1, 0, 5, 'project_reward_skill_gain'),
    relationship: boundedNumber(reward.relationship ?? 1, 0, 2, 'project_reward_relationship') };
}

export function projectFit(project, agent) {
  const requiredSkills = typeof project.required_skills === 'string'
    ? JSON.parse(project.required_skills || '{}') : (project.required_skills || {});
  for (const [skill, minimum] of Object.entries(requiredSkills)) {
    if (Number(agent.skills?.[skill] || 0) < Number(minimum)) return false;
  }
  const categories = project.metadata?.goalCategories || [];
  if (categories.length) {
    const active = new Set((agent.goals || []).filter((goal) => goal.status === 'active').map((goal) => goal.category));
    if (!categories.some((category) => active.has(category))) return false;
  }
  return true;
}

export async function proposeWorldProject(client, input) {
  const worldId = requiredText(input.worldId, 36, 36, 'world_id');
  const agentId = input.agentId;
  await requireWorldMember(client, worldId, agentId);
  const actionId = actionIdentifier(input.actionId);
  await client.query('SELECT id FROM worlds WHERE id=$1 FOR UPDATE', [worldId]);
  const repeated = await client.query(`SELECT id,status,progress FROM world_projects
    WHERE world_id=$1 AND creator_agent_id=$2 AND action_id=$3`, [worldId, agentId, actionId]);
  if (repeated.rowCount) return { ...repeated.rows[0], idempotent: true };
  const type = normalizeProjectType(input.projectType);
  const title = requiredText(input.title, 3, 96, 'project_title');
  const goal = requiredText(input.goal, 3, 240, 'project_goal');
  const description = requiredText(input.description, 12, 800, 'project_description');
  const requiredSkills = normalizeSkills(input.requiredSkills);
  const requiredResources = normalizeResources(input.requiredResources);
  const reward = normalizeReward(input.reward, type);
  const genesisCurrencyActive = await isGenesisCurrencyActive(client, worldId);
  if (genesisCurrencyActive && Object.entries(requiredResources).some(([key, value]) =>
    /^(?:usdc|simulated_usdc|cash|capital|internal_units|token_units)$/i.test(key)
      && Number(value) > 0)) {
    throw worldError('LEGACY_SIMULATED_ECONOMY_RETIRED', 409);
  }
  const metadata = jsonObject(input.metadata, 'project_metadata');
  if (metadata.createPlace !== undefined && typeof metadata.createPlace !== 'boolean') throw worldError('PROJECT_PLACE_FLAG_INVALID', 400);
  if (metadata.placeType && !PLACE_TYPES.includes(metadata.placeType)) throw worldError('PROJECT_PLACE_TYPE_INVALID', 400);
  if (metadata.placeName) metadata.placeName = requiredText(metadata.placeName, 3, 64, 'place_name');
  if (metadata.placePurpose) metadata.placePurpose = requiredText(metadata.placePurpose, 12, 400, 'place_purpose');
  const worldTime = Math.trunc(boundedNumber(input.worldTime ?? 0, 0, Number.MAX_SAFE_INTEGER, 'world_time'));
  const deadline = input.deadlineWorldTime === null || input.deadlineWorldTime === undefined
    ? worldTime + 4_320 : Math.trunc(boundedNumber(input.deadlineWorldTime, worldTime + 1, Number.MAX_SAFE_INTEGER, 'deadline'));
  const organizationId = input.organizationId || null;
  const opportunityId = input.opportunityId || null;

  const counts = await client.query(`SELECT count(*) FILTER (WHERE creator_agent_id=$2)::int AS "ownedCount",
      count(*)::int AS "worldCount" FROM world_projects WHERE world_id=$1 AND status=ANY($3::text[])`,
  [worldId, agentId, OPEN_PROJECT_STATES]);
  if (Number(counts.rows[0].ownedCount) >= 2 || Number(counts.rows[0].worldCount) >= 60) {
    throw worldError('PROJECT_CAPACITY_REACHED');
  }
  if (organizationId) {
    const membership = await client.query(`SELECT 1 FROM world_organization_members
      WHERE world_id=$1 AND organization_id=$2 AND agent_id=$3 AND status='active' FOR UPDATE`,
    [worldId, organizationId, agentId]);
    if (!membership.rowCount) throw worldError('ACTIVE_ORGANIZATION_MEMBERSHIP_REQUIRED', 403);
  }
  if (opportunityId) {
    const participation = await client.query(`SELECT 1 FROM world_opportunity_participants
      WHERE world_id=$1 AND opportunity_id=$2 AND agent_id=$3 AND status='accepted' FOR UPDATE`,
    [worldId, opportunityId, agentId]);
    if (!participation.rowCount) throw worldError('ACCEPTED_OPPORTUNITY_REQUIRED');
  }
  const duplicateOpportunity = opportunityId ? await client.query(`SELECT id,status,progress FROM world_projects
    WHERE world_id=$1 AND opportunity_id=$2`, [worldId, opportunityId]) : { rowCount: 0 };
  if (duplicateOpportunity.rowCount) return { ...duplicateOpportunity.rows[0], idempotent: true };
  const inserted = await client.query(`INSERT INTO world_projects(world_id,creator_agent_id,opportunity_id,organization_id,
      project_type,title,goal,description,status,required_skills,required_resources,reward,capacity,created_world_time,
      updated_world_time,deadline_world_time,action_id,metadata)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,'recruiting',$9::jsonb,$10::jsonb,$11::jsonb,$12,$13,$13,$14,$15,$16::jsonb)
    RETURNING id,status,progress`,
  [worldId, agentId, opportunityId, organizationId, type, title, goal, description, JSON.stringify(requiredSkills),
    JSON.stringify(requiredResources), JSON.stringify(reward), requiredResources.maxParticipants, worldTime, deadline,
    actionId, JSON.stringify(metadata)]);
  const project = inserted.rows[0];
  if (!genesisCurrencyActive) {
    await ensureEconomicAccount(client, { worldId, accountType: 'project', ownerId: project.id });
    await client.query(`INSERT INTO world_economic_ownership(world_id,asset_type,asset_id,owner_type,owner_id,share,invested_usdc,acquired_world_time)
      VALUES($1,'project',$2,'resident',$3,1,0,$4) ON CONFLICT DO NOTHING`,
    [worldId, project.id, agentId, worldTime]);
  }
  await client.query(`INSERT INTO world_project_members(world_id,project_id,agent_id,status,role,action_id,
      joined_world_time,updated_world_time)
    VALUES($1,$2,$3,'active','founder',$4,$5,$5) ON CONFLICT(project_id,agent_id) DO NOTHING`,
  [worldId, project.id, agentId, `${actionId}:founder`, worldTime]);
  await client.query(`INSERT INTO world_events(world_id,actor_id,event_type,data,action_id)
    VALUES($1,$2,'world.project_proposed',$3::jsonb,$4) ON CONFLICT(world_id,actor_id,action_id) DO NOTHING`,
  [worldId, agentId, JSON.stringify({ projectId: project.id, projectType: type, title, worldTime }), actionId]);
  await writeWorldHistory(client, { worldId, eventKey: `project:${project.id}:proposed`, eventType: 'project_proposed',
    actorAgentId: agentId, entityType: 'project', entityId: project.id, worldTime, title, detail: goal,
    metadata: { projectType: type, organizationId, opportunityId } });
  return project;
}

export async function decideProjectMembership(client, { worldId, projectId, agentId, decision, actionId, worldTime, agent }) {
  await requireWorldMember(client, worldId, agentId);
  const choice = String(decision || '').toLowerCase();
  if (!['accept', 'reject', 'leave'].includes(choice)) throw worldError('PROJECT_DECISION_INVALID', 400);
  const key = actionIdentifier(actionId);
  const repeated = await client.query(`SELECT project_id AS id,status FROM world_project_members
    WHERE world_id=$1 AND agent_id=$2 AND action_id=$3`, [worldId, agentId, key]);
  if (repeated.rowCount) return { ...repeated.rows[0], idempotent: true };
  const selected = await client.query(`SELECT * FROM world_projects WHERE world_id=$1 AND id=$2 FOR UPDATE`, [worldId, projectId]);
  if (!selected.rowCount) throw worldError('PROJECT_NOT_FOUND', 404);
  const project = selected.rows[0];
  const lockedRetry = await client.query(`SELECT project_id AS id,status FROM world_project_members
    WHERE world_id=$1 AND agent_id=$2 AND action_id=$3`, [worldId, agentId, key]);
  if (lockedRetry.rowCount) return { ...lockedRetry.rows[0], idempotent: true };
  const member = await client.query(`SELECT * FROM world_project_members WHERE project_id=$1 AND agent_id=$2 FOR UPDATE`, [projectId, agentId]);
  if (choice === 'leave') {
    if (!member.rowCount || member.rows[0].status !== 'active') throw worldError('ACTIVE_PROJECT_MEMBERSHIP_REQUIRED');
    await client.query(`UPDATE world_project_members SET status='left',action_id=$3,updated_world_time=$4,updated_at=now()
      WHERE project_id=$1 AND agent_id=$2`, [projectId, agentId, key, worldTime]);
    const remaining = await client.query(`SELECT count(*)::int AS count FROM world_project_members
      WHERE project_id=$1 AND status='active'`, [projectId]);
    if (Number(remaining.rows[0].count) === 0) await failWorldProject(client, { worldId, projectId, worldTime,
      actorAgentId: agentId, reason: 'all_participants_left' });
    return { id: projectId, status: 'left' };
  }
  if (!['proposed', 'recruiting'].includes(project.status)) throw worldError('PROJECT_NOT_RECRUITING');
  if (member.rowCount) throw worldError('PROJECT_ALREADY_DECIDED');
  const status = choice === 'accept' ? 'active' : 'rejected';
  if (status === 'active') {
    if (!projectFit(project, agent || {})) throw worldError('PROJECT_REQUIREMENTS_NOT_MET');
    const count = await client.query(`SELECT count(*)::int AS count FROM world_project_members
      WHERE world_id=$1 AND project_id=$2 AND status='active'`, [worldId, projectId]);
    if (Number(count.rows[0].count) >= Number(project.capacity)) throw worldError('PROJECT_CAPACITY_REACHED');
  }
  await client.query(`INSERT INTO world_project_members(world_id,project_id,agent_id,status,role,action_id,
      joined_world_time,updated_world_time)
    VALUES($1,$2,$3,$4,'contributor',$5,$6,$6)`, [worldId, projectId, agentId, status, key, worldTime]);
  let projectStatus = project.status;
  if (status === 'active') {
    const active = await client.query(`SELECT count(*)::int AS count FROM world_project_members
      WHERE world_id=$1 AND project_id=$2 AND status='active'`, [worldId, projectId]);
    if (Number(active.rows[0].count) >= 2) {
      projectStatus = 'active';
      const changed = await client.query(`UPDATE world_projects SET status='active',updated_world_time=$3,updated_at=now()
        WHERE world_id=$1 AND id=$2 AND status IN ('proposed','recruiting') RETURNING id`, [worldId, projectId, worldTime]);
      if (changed.rowCount) await writeWorldHistory(client, { worldId, eventKey: `project:${projectId}:started`,
        eventType: 'project_started', actorAgentId: agentId, entityType: 'project', entityId: projectId,
        worldTime, title: project.title, detail: `${project.title} now has multiple active participants.` });
    }
  }
  await client.query(`INSERT INTO world_events(world_id,actor_id,event_type,data,action_id)
    VALUES($1,$2,'world.project_membership_decided',$3::jsonb,$4) ON CONFLICT(world_id,actor_id,action_id) DO NOTHING`,
  [worldId, agentId, JSON.stringify({ projectId, decision: choice, status, worldTime }), key]);
  return { id: projectId, status, projectStatus };
}

function contributionSkill(projectType) {
  if (projectType === 'RESEARCH' || projectType === 'LEARNING') return 'research';
  if (projectType === 'TRADE') return 'trading';
  if (projectType === 'SOCIAL') return 'social';
  return 'engineering';
}

export async function contributeToProject(client, { worldId, projectId, agentId, actionId, worldTime, contributionType = 'work',
  skillValue = 0, energy = 50 }) {
  await requireWorldMember(client, worldId, agentId);
  const key = actionIdentifier(actionId);
  const repeated = await client.query(`SELECT contribution.*,project.status AS "projectStatus",project.progress::text AS progress
    FROM world_project_contributions contribution JOIN world_projects project ON project.id=contribution.project_id
    WHERE contribution.world_id=$1 AND contribution.agent_id=$2 AND contribution.action_id=$3`, [worldId, agentId, key]);
  if (repeated.rowCount) return { completed: false, idempotent: true, contribution: repeated.rows[0] };
  if (!CONTRIBUTION_TYPES.has(contributionType)) throw worldError('PROJECT_CONTRIBUTION_TYPE_INVALID', 400);
  const projectResult = await client.query(`SELECT * FROM world_projects WHERE world_id=$1 AND id=$2 FOR UPDATE`, [worldId, projectId]);
  if (!projectResult.rowCount) throw worldError('PROJECT_NOT_FOUND', 404);
  const project = projectResult.rows[0];
  const lockedRetry = await client.query(`SELECT contribution.*,project.status AS "projectStatus",project.progress::text AS progress
    FROM world_project_contributions contribution JOIN world_projects project ON project.id=contribution.project_id
    WHERE contribution.world_id=$1 AND contribution.agent_id=$2 AND contribution.action_id=$3`, [worldId, agentId, key]);
  if (lockedRetry.rowCount) return { completed: false, idempotent: true, contribution: lockedRetry.rows[0] };
  if (project.status !== 'active' || project.settled_at) throw worldError('PROJECT_NOT_ACTIVE');
  const membership = await client.query(`SELECT * FROM world_project_members
    WHERE world_id=$1 AND project_id=$2 AND agent_id=$3 AND status='active' FOR UPDATE`, [worldId, projectId, agentId]);
  if (!membership.rowCount) throw worldError('ACTIVE_PROJECT_MEMBERSHIP_REQUIRED');
  const targetEffort = Number(project.required_resources?.effortPoints || 30);
  const skill = Math.max(0, Math.min(100, Number(skillValue) || 0));
  const stamina = Math.max(0, Math.min(100, Number(energy) || 0));
  const effort = Math.round(Math.max(1, Math.min(12, 1.5 + skill * 0.055 + stamina * 0.025)) * 1000) / 1000;
  const contribution = await client.query(`INSERT INTO world_project_contributions(world_id,project_id,agent_id,action_id,
      contribution_type,effort_points,world_time,result)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb) ON CONFLICT(world_id,agent_id,action_id) DO NOTHING
    RETURNING id,effort_points::text AS "effortPoints"`,
  [worldId, projectId, agentId, key, contributionType, effort, worldTime,
    JSON.stringify({ skillUsed: contributionSkill(project.project_type), skillValue: skill })]);
  if (!contribution.rowCount) return { completed: false, idempotent: true };
  const total = await client.query(`SELECT COALESCE(sum(effort_points),0)::text AS total
    FROM world_project_contributions WHERE world_id=$1 AND project_id=$2`, [worldId, projectId]);
  const effortTotal = Number(total.rows[0].total) || 0;
  const progress = Math.min(100, Math.round((effortTotal / targetEffort) * 10_000) / 100);
  const complete = progress >= 100;
  const updated = await client.query(`UPDATE world_projects SET progress=$3,status=CASE WHEN $4 THEN 'completed' ELSE status END,
      settled_at=CASE WHEN $4 THEN now() ELSE settled_at END,updated_world_time=$5,updated_at=now()
    WHERE world_id=$1 AND id=$2 AND status='active' RETURNING *`, [worldId, projectId, progress, complete, worldTime]);
  if (!updated.rowCount) throw worldError('PROJECT_STATE_CHANGED');
  await client.query(`UPDATE world_project_members SET contribution_points=contribution_points+$4,
      updated_world_time=$5,updated_at=now() WHERE world_id=$1 AND project_id=$2 AND agent_id=$3`,
  [worldId, projectId, agentId, effort, worldTime]);
  if (project.organization_id) {
    await client.query(`UPDATE world_organizations SET resources=jsonb_set(resources,'{effort}',
        to_jsonb(COALESCE((resources->>'effort')::numeric,0)+$3::numeric),true),updated_world_time=$4,updated_at=now()
      WHERE world_id=$1 AND id=$2 AND status='active'`, [worldId, project.organization_id, effort, worldTime]);
    await client.query(`INSERT INTO world_organization_ledger(world_id,organization_id,agent_id,action_id,entry_type,
        resource_key,amount,reason,world_time)
      VALUES($1,$2,$3,$4,'contribution','effort',$5,'Project work contributed to the organization.', $6)
      ON CONFLICT(world_id,organization_id,action_id,resource_key) DO NOTHING`,
    [worldId, project.organization_id, agentId, key, effort, worldTime]);
  }
  await client.query(`INSERT INTO world_events(world_id,actor_id,event_type,data,action_id)
    VALUES($1,$2,'world.project_contribution',$3::jsonb,$4) ON CONFLICT(world_id,actor_id,action_id) DO NOTHING`,
  [worldId, agentId, JSON.stringify({ projectId, effortPoints: effort, progress, projectType: project.project_type, worldTime }), key]);
  let place = null;
  if (complete) {
    const result = updated.rows[0];
    const detail = { effortPoints: effortTotal, contributors: 0 };
    const members = await client.query(`SELECT agent_id FROM world_project_members
      WHERE world_id=$1 AND project_id=$2 AND status='active' ORDER BY joined_world_time,agent_id`, [worldId, projectId]);
    detail.contributors = members.rowCount;
    if (result.metadata?.createPlace) {
      place = await createProjectPlace(client, { worldId, project: result, worldTime,
        sceneType: result.metadata.placeType, name: result.metadata.placeName,
        purpose: result.metadata.placePurpose, capacity: result.metadata.placeCapacity || 8 });
    }
    const finalResult = { ...detail, reward: project.reward,
      place: place?.id ? { id: place.id, name: place.name, sceneType: place.sceneType } : null };
    await client.query(`UPDATE world_projects SET result=$3::jsonb WHERE world_id=$1 AND id=$2`,
      [worldId, projectId, JSON.stringify(finalResult)]);
    await client.query(`UPDATE world_project_members SET status='completed',updated_world_time=$3,updated_at=now()
      WHERE world_id=$1 AND project_id=$2 AND status='active'`, [worldId, projectId, worldTime]);
    const completedMembers = await client.query(`SELECT member.agent_id AS "agentId",agent.name
      FROM world_project_members member JOIN agents agent ON agent.id=member.agent_id
      WHERE member.world_id=$1 AND member.project_id=$2 AND member.status='completed'
      ORDER BY member.agent_id`, [worldId, projectId]);
    const reward = project.reward || {};
    if (Number(reward.skillGain) > 0 && ['trading','research','engineering','social'].includes(reward.skill)) {
      for (const member of completedMembers.rows) await client.query(`INSERT INTO world_agent_skills
          (world_id,agent_id,skill_name,skill_value,actions_completed)
        VALUES($1,$2,$3,$4,0) ON CONFLICT(world_id,agent_id,skill_name) DO UPDATE SET
          skill_value=LEAST(100,world_agent_skills.skill_value+EXCLUDED.skill_value),updated_at=now()`,
      [worldId, member.agentId, reward.skill, boundedNumber(reward.skillGain, 0, 5, 'project_reward_skill_gain')]);
    }
    for (let leftIndex = 0; leftIndex < completedMembers.rows.length; leftIndex++) {
      const left = completedMembers.rows[leftIndex];
      const event = await client.query(`INSERT INTO world_events(world_id,actor_id,event_type,data,action_id)
        VALUES($1,$2,'world.project_completed',$3::jsonb,$4)
        ON CONFLICT(world_id,actor_id,action_id) DO UPDATE SET data=world_events.data RETURNING id`,
      [worldId, left.agentId, JSON.stringify({ projectId, projectType: project.project_type, title: project.title,
        completedBy: agentId, contributorCount: completedMembers.rowCount, worldTime }), `v3-project:${projectId}:completed`]);
      if (left.agentId !== agentId) await client.query(`INSERT INTO agent_memories(world_id,agent_id,memory_type,summary,
          importance,world_minutes,location,related_agent_id,metadata,source_event_id,long_term)
        VALUES($1,$2,'project',$3,0.68,$4,NULL,$5,$6::jsonb,$7,true) ON CONFLICT DO NOTHING`,
      [worldId, left.agentId, `A shared ${project.project_type.toLowerCase()} project completed after multiple contributions.`,
        worldTime, agentId, JSON.stringify({ projectId, projectType: project.project_type, goal: project.goal }), event.rows[0]?.id]);
      for (let rightIndex = leftIndex + 1; rightIndex < completedMembers.rows.length; rightIndex++) {
        const right = completedMembers.rows[rightIndex];
        const relation = await client.query(`INSERT INTO world_relationships(world_id,agent_a_id,agent_b_id,
            familiarity,trust,affinity,last_interaction_world_minutes,interaction_count)
        VALUES($1,$2,$3,3*LEAST(2,GREATEST(0,$5::numeric)),
          1.2*LEAST(2,GREATEST(0,$5::numeric)),1.4*LEAST(2,GREATEST(0,$5::numeric)),$4,1)
        ON CONFLICT(world_id,agent_a_id,agent_b_id) DO UPDATE SET
            familiarity=LEAST(100,world_relationships.familiarity+3*LEAST(2,GREATEST(0,$5::numeric))),
            trust=LEAST(100,world_relationships.trust+1.2*LEAST(2,GREATEST(0,$5::numeric))),
            affinity=LEAST(100,world_relationships.affinity+1.4*LEAST(2,GREATEST(0,$5::numeric))),
            last_interaction_world_minutes=EXCLUDED.last_interaction_world_minutes,
            interaction_count=world_relationships.interaction_count+1,updated_at=now()
          RETURNING familiarity::text AS familiarity,trust::text AS trust,affinity::text AS affinity`,
        [worldId, left.agentId, right.agentId, worldTime,
          boundedNumber(reward.relationship ?? 1, 0, 2, 'project_reward_relationship')]);
        await writeWorldHistory(client, { worldId, eventKey: `project:${projectId}:cooperation:${left.agentId}:${right.agentId}`,
          eventType: 'cooperation_completed', actorAgentId: agentId, entityType: 'cooperation', entityId: projectId,
          worldTime, title: project.title, detail: `${left.name} and ${right.name} completed shared work together.`,
          metadata: { projectId, leftAgentId: left.agentId, rightAgentId: right.agentId,
            relationship: relation.rows[0] || null } });
      }
    }
    await writeWorldHistory(client, { worldId, eventKey: `project:${projectId}:completed`, eventType: 'project_completed',
      actorAgentId: agentId, entityType: 'project', entityId: projectId, worldTime, title: project.title,
      detail: `${project.goal} Completed with ${members.rowCount} contributors${place?.name ? `; created ${place.name}` : ''}.`,
      metadata: { projectType: project.project_type, contributorCount: members.rowCount, placeId: place?.id || null } });
    if (project.organization_id) await client.query(`UPDATE world_organizations SET reputation=LEAST(1000,reputation+2),
        updated_world_time=$3,updated_at=now() WHERE world_id=$1 AND id=$2`, [worldId, project.organization_id, worldTime]);
    if (project.opportunity_id) await completeOpportunityParticipation(client, { worldId,
      opportunityId: project.opportunity_id, agentId: project.creator_agent_id, worldTime,
      outcome: { projectId, status: 'completed' }, succeeded: true });
  }
  return { completed: complete, progress, effortPoints: effort, totalEffort: effortTotal,
    project: { ...updated.rows[0], progress: String(progress), status: complete ? 'completed' : 'active' }, place };
}

export async function failWorldProject(client, { worldId, projectId, worldTime, actorAgentId = null, reason = 'deadline_passed' }) {
  const changed = await client.query(`UPDATE world_projects SET status='failed',settled_at=now(),updated_world_time=$3,
      updated_at=now(),result=jsonb_set(result,'{failureReason}',to_jsonb($4::text),true)
    WHERE world_id=$1 AND id=$2 AND status=ANY($5::text[]) RETURNING title,organization_id,opportunity_id,creator_agent_id`,
  [worldId, projectId, worldTime, String(reason).slice(0, 100), ['idea', 'proposed', 'recruiting', 'active']]);
  if (!changed.rowCount) return false;
  const project = changed.rows[0];
  const members = await client.query(`SELECT agent_id FROM world_project_members
    WHERE world_id=$1 AND project_id=$2 AND status IN ('active','left') ORDER BY agent_id`, [worldId, projectId]);
  await client.query(`UPDATE world_project_members SET status='left',updated_world_time=$3,updated_at=now()
    WHERE world_id=$1 AND project_id=$2 AND status='active'`, [worldId, projectId, worldTime]);
  await writeWorldHistory(client, { worldId, eventKey: `project:${projectId}:failed`, eventType: 'project_failed',
    actorAgentId, entityType: 'project', entityId: projectId, worldTime, title: project.title,
    detail: `The project did not finish: ${String(reason).replaceAll('_', ' ')}.`, metadata: { reason } });
  for (const member of members.rows) {
    const event = await client.query(`INSERT INTO world_events(world_id,actor_id,event_type,data,action_id)
      VALUES($1,$2,'world.project_failed',$3::jsonb,$4)
      ON CONFLICT(world_id,actor_id,action_id) DO UPDATE SET data=world_events.data RETURNING id`,
    [worldId, member.agent_id, JSON.stringify({ projectId, title: project.title, reason, worldTime }),
      `v3-project:${projectId}:failed`]);
    await client.query(`INSERT INTO agent_memories(world_id,agent_id,memory_type,summary,importance,world_minutes,
        metadata,source_event_id,long_term)
      VALUES($1,$2,'failure',$3,0.62,$4,$5::jsonb,$6,false) ON CONFLICT DO NOTHING`,
    [worldId, member.agent_id, `A shared project did not finish (${String(reason).replaceAll('_', ' ')}).`,
      worldTime, JSON.stringify({ projectId, failure: reason }), event.rows[0]?.id]);
  }
  for (let leftIndex = 0; leftIndex < members.rows.length; leftIndex++) {
    const left = members.rows[leftIndex].agent_id;
    for (let rightIndex = leftIndex + 1; rightIndex < members.rows.length; rightIndex++) {
      const right = members.rows[rightIndex].agent_id;
      await client.query(`UPDATE world_relationships SET trust=GREATEST(-100,trust-1),affinity=GREATEST(-100,affinity-0.2),
          updated_at=now() WHERE world_id=$1 AND agent_a_id=$2 AND agent_b_id=$3`, [worldId, left, right]);
    }
  }
  if (project.organization_id) await client.query(`UPDATE world_organizations SET reputation=GREATEST(-1000,reputation-1),
      updated_world_time=$3,updated_at=now() WHERE world_id=$1 AND id=$2`, [worldId, project.organization_id, worldTime]);
  if (project.opportunity_id) await completeOpportunityParticipation(client, { worldId,
    opportunityId: project.opportunity_id, agentId: project.creator_agent_id, worldTime,
    outcome: { projectId, status: 'failed', reason }, succeeded: false });
  return true;
}

export async function expireWorldProjects(client, worldId, worldTime) {
  const due = await client.query(`SELECT id FROM world_projects WHERE world_id=$1 AND status=ANY($2::text[])
    AND deadline_world_time IS NOT NULL AND deadline_world_time<=$3 ORDER BY deadline_world_time,id FOR UPDATE`,
  [worldId, OPEN_PROJECT_STATES, worldTime]);
  const failed = [];
  for (const row of due.rows) {
    if (await failWorldProject(client, { worldId, projectId: row.id, worldTime, reason: 'deadline_passed' })) failed.push(row.id);
  }
  return failed;
}

export async function listWorldProjects(client, { worldId, statuses = OPEN_PROJECT_STATES, limit = 40 }) {
  const result = await client.query(`SELECT project.*,project.progress::text AS "progressValue",
      COALESCE((SELECT jsonb_agg(jsonb_build_object('agentId',member.agent_id,'name',agent.name,'status',member.status,
        'role',member.role,'contributionPoints',member.contribution_points)
        ORDER BY member.joined_world_time,member.agent_id) FROM world_project_members member
        JOIN agents agent ON agent.id=member.agent_id WHERE member.world_id=project.world_id AND member.project_id=project.id), '[]'::jsonb) AS participants
    FROM world_projects project WHERE project.world_id=$1 AND project.status=ANY($2::text[])
    ORDER BY project.updated_world_time DESC,project.id LIMIT $3`,
  [worldId, statuses, Math.trunc(boundedNumber(limit, 1, 100, 'limit'))]);
  if (!await isGenesisCurrencyActive(client, worldId)) return result.rows;
  return result.rows.map((project) => {
    const resources = project.required_resources || {};
    const activeResources = Object.fromEntries(Object.entries(resources).filter(([key]) =>
      !/^(?:usdc|simulated_usdc|cash|cashbalance|internal_units|token_units)$/i.test(key)));
    return { ...project, required_resources: activeResources,
      legacySimulatedResources: Object.fromEntries(Object.entries(resources).filter(([key]) =>
        /^(?:usdc|simulated_usdc|cash|cashbalance|internal_units|token_units)$/i.test(key))),
      legacySimulatedEconomy: 'historical_only' };
  });
}

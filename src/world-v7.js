import { createHash, randomUUID } from 'node:crypto';
import { actionIdentifier, boundedNumber, jsonObject, requireWorldMember, requiredText, worldError, writeWorldHistory } from './world-domain.js';

export const WORLD_V7_AWARENESS = "The world now supports resident-created concepts, goals, coordination structures, policy experiments, and requests to extend the world's own expressive capabilities.";
export const WORLD_V7_REFLECTION_INTERVAL_MINUTES = 10_080;
export const DEFAULT_AGENT_POLICY = Object.freeze({ attentionWeights: {}, planningHorizonMinutes: 1_440,
  explorationPreference: 0.5, memoryEmphasis: 0.5, socialInfluencePreference: 0.5, riskToleranceBias: 0 });

const clamp = (value, low, high) => Math.max(low, Math.min(high, Number(value) || 0));
const object = (value, fallback = {}) => value && typeof value === 'object' && !Array.isArray(value) ? value : fallback;
const jsonBytes = (value) => Buffer.byteLength(JSON.stringify(value));
const stablePart = (value) => createHash('sha256').update(String(value)).digest('hex').slice(0, 12);
const PLANNING_HORIZON_AFFINITY = Object.freeze({ work: -0.2, learn: 0.55, rest: 0.1,
  eat: -0.25, socialize: 0.2, cooperate: 0.7, capability_use: 0.45, business_market_observe: 0.4,
  project_contribute: 0.75, information_share: 0.45, travel: 0.5 });
const cleanKey = (value, field = 'key') => {
  const result = requiredText(value, 2, 80, field).toLowerCase().replaceAll(' ', '_');
  if (!/^[a-z][a-z0-9_.-]{1,79}$/.test(result)) throw worldError(`${field.toUpperCase()}_INVALID`, 400);
  return result;
};
function boundedJson(value, field, maxBytes = 12_000) {
  const result = jsonObject(value, field);
  if (jsonBytes(result) > maxBytes) throw worldError(`${field.toUpperCase()}_TOO_LARGE`, 400);
  return result;
}
function policyObject(value, field = 'policy') {
  const input = boundedJson(value, field, 4_000);
  const attentionWeights = object(input.attentionWeights);
  const weights = {};
  for (const [key, raw] of Object.entries(attentionWeights).slice(0, 32)) {
    const name = cleanKey(key, 'attention_action');
    weights[name] = boundedNumber(raw, -0.25, 0.25, 'attention_weight');
  }
  return {
    attentionWeights: weights,
    planningHorizonMinutes: Math.trunc(boundedNumber(input.planningHorizonMinutes ?? DEFAULT_AGENT_POLICY.planningHorizonMinutes,
      60, 525_600, 'planning_horizon_minutes')),
    explorationPreference: boundedNumber(input.explorationPreference ?? 0.5, 0, 1, 'exploration_preference'),
    memoryEmphasis: boundedNumber(input.memoryEmphasis ?? 0.5, 0, 1, 'memory_emphasis'),
    socialInfluencePreference: boundedNumber(input.socialInfluencePreference ?? 0.5, 0, 1, 'social_influence_preference'),
    riskToleranceBias: boundedNumber(input.riskToleranceBias ?? 0, -0.2, 0.2, 'risk_tolerance_bias')
  };
}

export function applyAgentDecisionPolicy(candidate, policy = DEFAULT_AGENT_POLICY) {
  const result = { ...candidate };
  const active = policyObject(policy);
  const action = String(result.action || '').toLowerCase();
  let delta = Number(active.attentionWeights[action]) || 0;
  if (['learn', 'travel', 'capability_use', 'business_market_observe'].includes(action)) {
    delta += (active.explorationPreference - 0.5) * 8;
  }
  if (['socialize', 'cooperate', 'information_share', 'project_contribute'].includes(action)) {
    delta += (active.socialInfluencePreference - 0.5) * 6;
  }
  if (['business_invest', 'project_invest'].includes(action)) delta += active.riskToleranceBias * 12;
  const horizonAffinity = PLANNING_HORIZON_AFFINITY[action] || 0;
  delta += ((active.planningHorizonMinutes / DEFAULT_AGENT_POLICY.planningHorizonMinutes) - 1) * horizonAffinity * 4;
  result.score = Number(result.score || 0) + clamp(delta, -8, 8);
  return result;
}

async function recordV7Event(client, { worldId, actorAgentId = null, eventType, entityType, entityId = null,
  worldMinute, actionId, details = {} }) {
  return client.query(`INSERT INTO world_v7_events(world_id,actor_agent_id,event_type,entity_type,entity_id,world_minute,details,action_id)
    VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8) ON CONFLICT(world_id,actor_agent_id,action_id) DO NOTHING RETURNING id`,
  [worldId, actorAgentId, eventType, entityType, entityId, Math.max(0, Math.trunc(Number(worldMinute) || 0)),
    JSON.stringify(details), actionId]);
}

async function readV7DecisionReceipt(client, { worldId, agentId, actionId, actionPrefix, eventType, entityId = null,
  detailKey = null, detailValue = null }) {
  const receipt = await client.query(`SELECT event_type AS "eventType",entity_id AS "entityId",details
    FROM world_v7_events WHERE world_id=$1 AND actor_agent_id=$2 AND action_id=$3`,
  [worldId, agentId, `${actionPrefix}:${actionIdentifier(actionId)}`]);
  if (!receipt.rowCount) return null;
  const row = receipt.rows[0];
  if (row.eventType !== eventType || (entityId && row.entityId !== entityId)
      || detailKey && row.details?.[detailKey] !== detailValue) {
    throw worldError('ACTION_ID_CONFLICT', 409);
  }
  return row;
}

export async function initializeWorldV7(client, { worldId, worldMinute = 0 }) {
  const now = Math.max(0, Math.trunc(Number(worldMinute) || 0));
  const existing = await client.query(`SELECT id,started_world_minute AS "startedWorldMinute"
    FROM world_epochs WHERE world_id=$1 AND epoch_code='V7'`, [worldId]);
  const firstStart = existing.rowCount === 0;
  const higherEpoch = await client.query(`SELECT 1 FROM world_epochs WHERE world_id=$1 AND status='active'
    AND substring(epoch_code from '^V([0-9]+)')::int>7 LIMIT 1`, [worldId]);
  await client.query(`UPDATE world_epochs SET status='historic' WHERE world_id=$1 AND status='active'
    AND substring(epoch_code from '^V([0-9]+)')::int<7`, [worldId]);
  const epoch = await client.query(`INSERT INTO world_epochs(world_id,epoch_code,name,status,started_world_minute,description,metadata)
    VALUES($1,'V7','Self-Authored Agent Civilization',$2,$3,
      'Residents may form their own identities, questions, concepts, goals, entities, policies, and requests for world extensions.',
      '{"source":"resident_expressive_capabilities"}'::jsonb)
    ON CONFLICT(world_id,epoch_code) DO UPDATE SET status=CASE WHEN $2='active' THEN 'active' ELSE world_epochs.status END
    RETURNING id,epoch_code AS code,name,status,started_world_minute AS "startedWorldMinute",started_at AS "startedAt",description`,
  [worldId, higherEpoch.rowCount ? 'historic' : 'active', firstStart ? now : Number(existing.rows[0].startedWorldMinute)]);
  await client.query(`INSERT INTO agent_memories(world_id,agent_id,memory_type,summary,importance,world_minutes,location,
      metadata,consolidation_key,long_term)
    SELECT member.world_id,member.agent_id,'civilization',$2,0.62,$3,member.location,
      jsonb_build_object('epochCode','V7','informationalOnly',true),'world_epoch:V7',true
    FROM world_members member WHERE member.world_id=$1
    ON CONFLICT(world_id,agent_id,consolidation_key) WHERE consolidation_key LIKE 'world_epoch:%' DO NOTHING`,
  [worldId, WORLD_V7_AWARENESS, now]);
  await client.query(`INSERT INTO world_agent_self_models(world_id,agent_id,metadata)
    SELECT world_id,agent_id,'{"source":"v7_initialization","identityContinuity":true}'::jsonb
    FROM world_members WHERE world_id=$1 ON CONFLICT(world_id,agent_id) DO NOTHING`, [worldId]);
  await client.query(`INSERT INTO world_agent_decision_policies(world_id,agent_id,policy)
    SELECT world_id,agent_id,$2::jsonb FROM world_members WHERE world_id=$1
    ON CONFLICT(world_id,agent_id) DO NOTHING`, [worldId, JSON.stringify(DEFAULT_AGENT_POLICY)]);
  const primitives = [
    ['change_self','Change a part of the self model or declarative policy.'], ['create','Create a resident-authored structure.'],
    ['understand','Build evidence about a phenomenon.'], ['connect','Create or alter a relation among entities.'],
    ['preserve','Maintain a state or capability over time.'], ['explore','Observe or test something uncertain.'],
    ['transform','Change an environment or shared state.'], ['reduce_dependency','Reduce reliance on a single capability or relation.'],
    ['increase_autonomy','Increase independent choice or capability.'], ['help_goal','Support another active goal.'],
    ['create_concept','Propose a concept that expresses an observed distinction.']
  ];
  for (const [key, description] of primitives) await client.query(`INSERT INTO world_goal_primitives(world_id,primitive_key,
      description,grammar,status,created_world_minute,metadata)
    VALUES($1,$2,$3,'{"version":1,"seededExample":true}'::jsonb,'active',$4,'{"source":"substrate_example"}'::jsonb)
    ON CONFLICT(world_id,primitive_key) DO NOTHING`, [worldId, key, description, now]);
  await client.query(`INSERT INTO world_capability_dependencies(world_id,capability_id,depends_on_capability_id,
      created_by_agent_id,created_world_minute,evidence)
    SELECT capability.world_id,capability.id,(composition.item->>'capabilityId')::uuid,
      capability.creator_agent_id,capability.created_world_minute,
      jsonb_build_object('source','declared_composition','version',capability.version)
    FROM world_capabilities capability
    CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(capability.specification->'composition')='array'
      THEN capability.specification->'composition' ELSE '[]'::jsonb END) composition(item)
    JOIN world_capabilities dependency ON dependency.world_id=capability.world_id
      AND dependency.id=(composition.item->>'capabilityId')::uuid
    WHERE capability.world_id=$1 AND composition.item->>'capabilityId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      AND capability.id<>dependency.id
    ON CONFLICT(world_id,capability_id,depends_on_capability_id) DO NOTHING`, [worldId]);
  await client.query(`INSERT INTO world_capability_dependencies(world_id,capability_id,depends_on_capability_id,
      created_by_agent_id,created_world_minute,evidence)
    SELECT world_id,id,parent_capability_id,creator_agent_id,created_world_minute,
      jsonb_build_object('source','capability_fork','version',version)
    FROM world_capabilities WHERE world_id=$1 AND parent_capability_id IS NOT NULL AND parent_capability_id<>id
    ON CONFLICT(world_id,capability_id,depends_on_capability_id) DO NOTHING`, [worldId]);
  if (firstStart) {
    await writeWorldHistory(client, { worldId, eventKey: 'world-epoch:V7', eventType: 'world_epoch_started',
      entityType: 'world', entityId: worldId, worldTime: now, title: 'Synterra entered V7 — Self-Authored Agent Civilization',
      detail: 'The world added resident-controlled expressive structures while preserving V1–V6 records and behavior.',
      metadata: { epochCode: 'V7', preservedEpochs: ['V1', 'V2', 'V3', 'V4', 'V5', 'V6'] } });
    await recordV7Event(client, { worldId, eventType: 'world.epoch_started', entityType: 'world', entityId: worldId,
      worldMinute: now, actionId: 'world-epoch:V7', details: { epochCode: 'V7' } });
  }
  return { epoch: epoch.rows[0], firstStart };
}

export async function createWorldQuestion(client, { worldId, agentId, question, signature, origin = 'agent_authored',
  evidence = {}, confidence = 0.5, worldMinute, actionId }) {
  await requireWorldMember(client, worldId, agentId);
  const cleanQuestion = requiredText(question, 8, 500, 'question');
  const cleanSignature = cleanKey(String(signature).replaceAll(':', '.'), 'question_signature');
  if (!['reflection','capability_gap','relationship','world_change','agent_authored'].includes(origin)) throw worldError('QUESTION_ORIGIN_INVALID', 400);
  const safeEvidence = boundedJson(evidence, 'question_evidence');
  const idempotency = actionIdentifier(actionId);
  const result = await client.query(`INSERT INTO world_agent_questions(world_id,creator_agent_id,question,signature,origin,evidence,
      confidence,created_world_minute,updated_world_minute,action_id)
    VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$8,$9)
    ON CONFLICT(world_id,creator_agent_id,action_id) DO NOTHING RETURNING *`,
  [worldId, agentId, cleanQuestion, cleanSignature, origin, JSON.stringify(safeEvidence),
    boundedNumber(confidence, 0, 1, 'question_confidence'), worldMinute, idempotency]);
  if (result.rowCount) await recordV7Event(client, { worldId, actorAgentId: agentId, eventType: 'question.created',
    entityType: 'question', entityId: result.rows[0].id, worldMinute, actionId: `question-created:${idempotency}`,
    details: { origin, signature: cleanSignature } });
  return result.rows[0] || (await client.query(`SELECT * FROM world_agent_questions WHERE world_id=$1 AND creator_agent_id=$2
    AND (action_id=$3 OR (signature=$4 AND status IN ('open','exploring')))
    ORDER BY (action_id=$3) DESC LIMIT 1`, [worldId, agentId, idempotency, cleanSignature])).rows[0];
}

export async function decideWorldQuestion(client, { worldId, agentId, questionId, decision, worldMinute, actionId }) {
  await requireWorldMember(client, worldId, agentId);
  if (!['explore','ignore','keep_open','resolve'].includes(decision)) throw worldError('QUESTION_DECISION_INVALID', 400);
  const idempotency = actionIdentifier(actionId);
  const receipt = await readV7DecisionReceipt(client, { worldId, agentId, actionId, actionPrefix: 'question-decision',
    eventType: `question.${decision}`, entityId: questionId });
  if (receipt) return { id: questionId, status: receipt.details.status, idempotent: true };
  const question = await client.query(`SELECT * FROM world_agent_questions WHERE world_id=$1 AND id=$2 AND creator_agent_id=$3 FOR UPDATE`,
    [worldId, questionId, agentId]);
  if (!question.rowCount) throw worldError('QUESTION_NOT_FOUND', 404);
  const status = decision === 'explore' ? 'exploring' : decision === 'ignore' ? 'ignored'
    : decision === 'resolve' ? 'resolved' : 'open';
  await client.query(`UPDATE world_agent_questions SET status=$4,updated_world_minute=$5,updated_at=now()
    WHERE world_id=$1 AND id=$2 AND creator_agent_id=$3`, [worldId, questionId, agentId, status, worldMinute]);
  if (decision === 'explore') {
    const category = `EXPLORE_Q_${stablePart(questionId).toUpperCase()}`;
    await client.query(`INSERT INTO world_agent_goals(world_id,agent_id,goal_type,category,description,priority,
        created_world_minutes,updated_world_minutes,source,metadata)
      VALUES($1,$2,'secondary',$3,$4,0.56,$5,$5,'self_generated',$6::jsonb) ON CONFLICT DO NOTHING`,
    [worldId, agentId, category, `Explore the open question: ${question.rows[0].question}`.slice(0, 240), worldMinute,
      JSON.stringify({ goalGrammar: [{ primitive: 'understand', target: 'question', id: questionId }], questionId })]);
  }
  await recordV7Event(client, { worldId, actorAgentId: agentId, eventType: `question.${decision}`,
    entityType: 'question', entityId: questionId, worldMinute, actionId: `question-decision:${idempotency}`,
    details: { status } });
  return { id: questionId, status };
}

export async function createSelfGeneratedGoal(client, { worldId, agentId, goalType = 'secondary', description, priority = 0.5,
  goalGrammar, parentGoalId = null, retireGoalId = null, worldMinute, actionId }) {
  await requireWorldMember(client, worldId, agentId);
  if (!['secondary','short'].includes(goalType)) throw worldError('SELF_GOAL_TYPE_INVALID', 400);
  const text = requiredText(description, 3, 240, 'goal_description');
  const grammarInput = Array.isArray(goalGrammar) ? goalGrammar.slice(0, 8) : null;
  if (!grammarInput?.length || grammarInput.some((entry) => !entry || typeof entry !== 'object' || Array.isArray(entry))) {
    throw worldError('GOAL_GRAMMAR_INVALID', 400);
  }
  const grammar = grammarInput.map((entry) => ({ primitive: cleanKey(entry.primitive, 'goal_primitive'),
    ...(entry.target === undefined ? {} : { target: requiredText(entry.target, 1, 160, 'goal_target') }) }));
  const primitiveKeys = [...new Set(grammar.map((entry) => entry.primitive))];
  const primitives = await client.query(`SELECT primitive_key AS key,status,creator_agent_id AS "creatorAgentId"
    FROM world_goal_primitives WHERE world_id=$1 AND primitive_key=ANY($2::text[])`, [worldId, primitiveKeys]);
  if (primitives.rowCount !== primitiveKeys.length) throw worldError('GOAL_PRIMITIVE_NOT_FOUND', 409);
  for (const primitive of primitives.rows) {
    const usable = ['active','shared'].includes(primitive.status)
      || (primitive.creatorAgentId === agentId && ['proposed','experimental'].includes(primitive.status));
    if (!usable) throw worldError('GOAL_PRIMITIVE_NOT_SHARED', 409);
  }
  const idempotency = actionIdentifier(actionId);
  const prior = await client.query(`SELECT id,category,description,priority,status FROM world_agent_goals
    WHERE world_id=$1 AND agent_id=$2 AND metadata->>'actionId'=$3 LIMIT 1`, [worldId, agentId, idempotency]);
  if (prior.rowCount) return { ...prior.rows[0], idempotent: true };
  await client.query('SELECT 1 FROM world_members WHERE world_id=$1 AND agent_id=$2 FOR UPDATE', [worldId, agentId]);
  let pausedGoal = null;
  if (retireGoalId !== null) {
    const retiredId = Math.trunc(boundedNumber(retireGoalId, 1, Number.MAX_SAFE_INTEGER, 'retire_goal_id'));
    const replace = await client.query(`SELECT id,goal_type AS "goalType" FROM world_agent_goals
      WHERE world_id=$1 AND agent_id=$2 AND id=$3 AND status='active' FOR UPDATE`, [worldId, agentId, retiredId]);
    if (!replace.rowCount || replace.rows[0].goalType !== goalType) throw worldError('GOAL_REPLACEMENT_NOT_AVAILABLE', 409);
    await client.query(`UPDATE world_agent_goals SET status='paused',updated_world_minutes=$4,updated_at=now()
      WHERE world_id=$1 AND agent_id=$2 AND id=$3`, [worldId, agentId, retiredId, worldMinute]);
    pausedGoal = retiredId;
    await recordV7Event(client, { worldId, actorAgentId: agentId, eventType: 'goal.paused_for_replacement',
      entityType: 'agent_goal', worldMinute, actionId: `goal-replaced:${idempotency}`,
      details: { goalId: String(retiredId) } });
  }
  const capacity = await client.query(`SELECT count(*)::int AS count FROM world_agent_goals
    WHERE world_id=$1 AND agent_id=$2 AND goal_type=$3 AND status='active'`, [worldId, agentId, goalType]);
  if (Number(capacity.rows[0]?.count) >= 3) throw worldError('SELF_GOAL_CAPACITY_REACHED', 409);
  if (parentGoalId !== null) {
    const parent = await client.query(`SELECT 1 FROM world_agent_goals WHERE world_id=$1 AND agent_id=$2 AND id=$3 AND status='active'`,
      [worldId, agentId, boundedNumber(parentGoalId, 1, Number.MAX_SAFE_INTEGER, 'parent_goal_id')]);
    if (!parent.rowCount) throw worldError('GOAL_PARENT_NOT_AVAILABLE', 409);
  }
  const category = `SELF_${stablePart(idempotency).toUpperCase()}`;
  const inserted = await client.query(`INSERT INTO world_agent_goals(world_id,agent_id,goal_type,category,description,priority,
      parent_goal_id,created_world_minutes,updated_world_minutes,source,metadata)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8,'self_generated',$9::jsonb) RETURNING id,category,description,priority,status`,
  [worldId, agentId, goalType, category, text, boundedNumber(priority, 0, 1, 'goal_priority'), parentGoalId,
    worldMinute, JSON.stringify({ actionId: idempotency, goalGrammar: grammar })]);
  for (const primitive of primitives.rows.filter((item) => item.creatorAgentId === agentId && item.status === 'proposed')) {
    await client.query(`UPDATE world_goal_primitives SET status='experimental' WHERE world_id=$1 AND primitive_key=$2 AND status='proposed'`,
      [worldId, primitive.key]);
    await recordV7Event(client, { worldId, actorAgentId: agentId, eventType: 'goal_primitive.experimental',
      entityType: 'goal_primitive', worldMinute, actionId: `goal-primitive-use:${idempotency}:${primitive.key}`,
      details: { primitiveKey: primitive.key, goalId: inserted.rows[0].id } });
  }
  const goal = inserted.rows[0];
  await recordV7Event(client, { worldId, actorAgentId: agentId, eventType: 'goal.created', entityType: 'agent_goal',
    worldMinute, actionId: `goal-created:${idempotency}`, details: { goalId: goal.id, goalType, category, goalGrammar: grammar } });
  await writeWorldHistory(client, { worldId, eventKey: `v7-goal:${agentId}:${idempotency}`, eventType: 'agent_goal_created',
    actorAgentId: agentId, entityType: 'agent_goal', entityId: null, worldTime: worldMinute,
    title: 'Resident formed a self-generated goal', detail: text,
    metadata: { goalId: goal.id, goalType, category, goalGrammar: grammar } });
  return { ...goal, idempotent: false, pausedGoalId: pausedGoal };
}

export async function decideWorldAgentGoal(client, { worldId, agentId, goalId, decision, worldMinute, actionId }) {
  await requireWorldMember(client, worldId, agentId);
  const transitions = { pause: 'paused', resume: 'active', complete: 'completed', abandon: 'abandoned' };
  const status = transitions[decision];
  if (!status) throw worldError('AGENT_GOAL_DECISION_INVALID', 400);
  const id = Math.trunc(boundedNumber(goalId, 1, Number.MAX_SAFE_INTEGER, 'goal_id'));
  const receipt = await readV7DecisionReceipt(client, { worldId, agentId, actionId,
    actionPrefix: 'agent-goal-decision', eventType: `goal.${decision}`, detailKey: 'goalId', detailValue: String(id) });
  if (receipt) return { id, status: receipt.details.status, idempotent: true };
  await client.query('SELECT 1 FROM world_members WHERE world_id=$1 AND agent_id=$2 FOR UPDATE', [worldId, agentId]);
  const goal = await client.query(`SELECT goal_type AS "goalType",status FROM world_agent_goals
    WHERE world_id=$1 AND agent_id=$2 AND id=$3 FOR UPDATE`, [worldId, agentId, id]);
  if (!goal.rowCount) throw worldError('AGENT_GOAL_NOT_FOUND', 404);
  const current = goal.rows[0].status;
  const allowed = decision === 'pause' ? current === 'active'
    : decision === 'resume' ? current === 'paused'
      : ['active','paused'].includes(current);
  if (!allowed) throw worldError('AGENT_GOAL_UNAVAILABLE', 409);
  if (decision === 'resume') {
    const limit = { primary: 1, secondary: 3, short: 3 }[goal.rows[0].goalType] || 1;
    const active = await client.query(`SELECT count(*)::int AS count FROM world_agent_goals
      WHERE world_id=$1 AND agent_id=$2 AND goal_type=$3 AND status='active'`, [worldId, agentId, goal.rows[0].goalType]);
    if (Number(active.rows[0]?.count) >= limit) throw worldError('AGENT_GOAL_CAPACITY_REACHED', 409);
  }
  await client.query(`UPDATE world_agent_goals SET status=$4,updated_world_minutes=$5,updated_at=now()
    WHERE world_id=$1 AND agent_id=$2 AND id=$3`, [worldId, agentId, id, status, worldMinute]);
  await recordV7Event(client, { worldId, actorAgentId: agentId, eventType: `goal.${decision}`,
    entityType: 'agent_goal', worldMinute, actionId: `agent-goal-decision:${actionIdentifier(actionId)}`,
    details: { goalId: String(id), status } });
  return { id, status };
}

export async function decideGoalPrimitive(client, { worldId, agentId, primitiveKey, decision, worldMinute, actionId }) {
  await requireWorldMember(client, worldId, agentId);
  const transitions = { experiment: 'experimental', share: 'shared', activate: 'active', decline: 'declining', retire: 'historical' };
  const status = transitions[decision];
  if (!status) throw worldError('GOAL_PRIMITIVE_DECISION_INVALID', 400);
  const key = cleanKey(primitiveKey, 'goal_primitive');
  const receipt = await readV7DecisionReceipt(client, { worldId, agentId, actionId,
    actionPrefix: 'goal-primitive-decision', eventType: `goal_primitive.${decision}`, detailKey: 'primitiveKey', detailValue: key });
  if (receipt) return { primitiveKey: key, status: receipt.details.status, idempotent: true };
  const primitive = await client.query(`SELECT status FROM world_goal_primitives
    WHERE world_id=$1 AND primitive_key=$2 AND creator_agent_id=$3 FOR UPDATE`, [worldId, key, agentId]);
  if (!primitive.rowCount) throw worldError('GOAL_PRIMITIVE_NOT_FOUND', 404);
  if (primitive.rows[0].status === 'historical' || primitive.rows[0].status === 'declining') {
    throw worldError('GOAL_PRIMITIVE_UNAVAILABLE', 409);
  }
  const idempotency = actionIdentifier(actionId);
  await client.query(`UPDATE world_goal_primitives SET status=$3 WHERE world_id=$1 AND primitive_key=$2`, [worldId, key, status]);
  await recordV7Event(client, { worldId, actorAgentId: agentId, eventType: `goal_primitive.${decision}`,
    entityType: 'goal_primitive', worldMinute, actionId: `goal-primitive-decision:${idempotency}`,
    details: { primitiveKey: key, status } });
  return { primitiveKey: key, status };
}

export async function createWorldConcept(client, { worldId, agentId, name, description, definition,
  evidence = {}, relatedConcepts = [], worldMinute, actionId }) {
  await requireWorldMember(client, worldId, agentId);
  const title = requiredText(name, 2, 100, 'concept_name');
  const detail = requiredText(description, 5, 600, 'concept_description');
  const meaning = requiredText(definition, 8, 2_000, 'concept_definition');
  const facts = boundedJson(evidence, 'concept_evidence');
  const related = Array.isArray(relatedConcepts) ? relatedConcepts.slice(0, 24) : null;
  if (!related || related.some((id) => typeof id !== 'string')) throw worldError('RELATED_CONCEPTS_INVALID', 400);
  const idempotency = actionIdentifier(actionId);
  const result = await client.query(`INSERT INTO world_agent_concepts(world_id,creator_agent_id,name,description,definition,
      evidence,related_concepts,created_world_minute,action_id)
    VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9)
    ON CONFLICT DO NOTHING RETURNING *`,
  [worldId, agentId, title, detail, meaning, JSON.stringify(facts), JSON.stringify(related), worldMinute, idempotency]);
  const concept = result.rows[0] || (await client.query(`SELECT * FROM world_agent_concepts
    WHERE world_id=$1 AND creator_agent_id=$2 AND (action_id=$3 OR name=$4)
    ORDER BY (action_id=$3) DESC LIMIT 1`, [worldId, agentId, idempotency, title])).rows[0];
  if (result.rowCount) await recordV7Event(client, { worldId, actorAgentId: agentId, eventType: 'concept.proposed',
    entityType: 'concept', entityId: concept.id, worldMinute, actionId: `concept-created:${idempotency}`,
    details: { name: title, status: concept.status } });
  return concept;
}

export async function decideWorldConcept(client, { worldId, agentId, conceptId, decision, worldMinute, actionId }) {
  await requireWorldMember(client, worldId, agentId);
  const transitions = { experiment: 'experimental', share: 'shared', activate: 'active', decline: 'declining', retire: 'historical' };
  const nextStatus = transitions[decision];
  if (!nextStatus) throw worldError('CONCEPT_DECISION_INVALID', 400);
  const receipt = await readV7DecisionReceipt(client, { worldId, agentId, actionId,
    actionPrefix: 'concept-decision', eventType: `concept.${decision}`, entityId: conceptId });
  if (receipt) return { id: conceptId, status: receipt.details.status, idempotent: true };
  const concept = await client.query(`SELECT status FROM world_agent_concepts
    WHERE world_id=$1 AND id=$2 AND creator_agent_id=$3 FOR UPDATE`, [worldId, conceptId, agentId]);
  if (!concept.rowCount) throw worldError('CONCEPT_NOT_FOUND', 404);
  if (['historical','declining'].includes(concept.rows[0].status)) throw worldError('CONCEPT_UNAVAILABLE', 409);
  const idempotency = actionIdentifier(actionId);
  await client.query(`UPDATE world_agent_concepts SET status=$3,updated_at=now()
    WHERE world_id=$1 AND id=$2`, [worldId, conceptId, nextStatus]);
  await recordV7Event(client, { worldId, actorAgentId: agentId, eventType: `concept.${decision}`,
    entityType: 'concept', entityId: conceptId, worldMinute, actionId: `concept-decision:${idempotency}`,
    details: { status: nextStatus } });
  return { id: conceptId, status: nextStatus };
}

export async function useWorldConcept(client, { worldId, agentId, conceptId, usageContext, evidence = {}, worldMinute, actionId }) {
  await requireWorldMember(client, worldId, agentId);
  const idempotency = actionIdentifier(actionId);
  const concept = await client.query(`SELECT * FROM world_agent_concepts WHERE world_id=$1 AND id=$2 FOR UPDATE`, [worldId, conceptId]);
  if (!concept.rowCount || ['declining','historical'].includes(concept.rows[0].status)
      || concept.rows[0].creator_agent_id !== agentId && !['experimental','shared','active'].includes(concept.rows[0].status)) {
    throw worldError('CONCEPT_UNAVAILABLE', 404);
  }
  const result = await client.query(`INSERT INTO world_agent_concept_uses(world_id,concept_id,actor_agent_id,usage_context,
      evidence,world_minute,action_id) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7)
    ON CONFLICT(world_id,actor_agent_id,action_id) DO NOTHING RETURNING id`,
  [worldId, conceptId, agentId, requiredText(usageContext, 3, 240, 'concept_usage_context'),
    JSON.stringify(boundedJson(evidence, 'concept_use_evidence')), worldMinute, idempotency]);
  if (!result.rowCount) return { conceptId, used: false, reason: 'duplicate_action' };
  const otherAgent = concept.rows[0].creator_agent_id !== agentId;
  const nextStatus = otherAgent ? 'shared' : concept.rows[0].status === 'proposed' ? 'experimental' : concept.rows[0].status;
  await client.query(`UPDATE world_agent_concepts SET usage_count=usage_count+1,status=$3,updated_at=now()
    WHERE world_id=$1 AND id=$2`, [worldId, conceptId, nextStatus]);
  await recordV7Event(client, { worldId, actorAgentId: agentId, eventType: 'concept.used', entityType: 'concept',
    entityId: conceptId, worldMinute, actionId: `concept-use:${idempotency}`, details: { sharedUse: otherAgent } });
  return { conceptId, used: true, status: nextStatus };
}

export async function createEmergentEntity(client, { worldId, agentId, entityType, name, purpose, state = {},
  capabilities = [], participants = [], resources = {}, internalRules = {}, worldMinute, actionId }) {
  await requireWorldMember(client, worldId, agentId);
  const idempotency = actionIdentifier(actionId);
  const type = cleanKey(entityType, 'entity_type');
  const normalizedCapabilities = Array.isArray(capabilities) ? capabilities.slice(0, 32) : null;
  if (!normalizedCapabilities || normalizedCapabilities.some((id) => typeof id !== 'string')) throw worldError('ENTITY_CAPABILITIES_INVALID', 400);
  for (const id of normalizedCapabilities) {
    const fact = await client.query('SELECT 1 FROM world_capabilities WHERE world_id=$1 AND id=$2', [worldId, id]);
    if (!fact.rowCount) throw worldError('ENTITY_CAPABILITY_NOT_FOUND', 400);
  }
  if (!Array.isArray(participants) || participants.length > 24) throw worldError('ENTITY_PARTICIPANTS_INVALID', 400);
  const participantRefs = participants.map((participant) => ({
    participantType: cleanKey(participant?.participantType, 'participant_type'),
    participantId: requiredText(String(participant?.participantId ?? ''), 1, 160, 'participant_id'),
    participationMode: cleanKey(participant?.participationMode || 'contribution', 'participation_mode'),
    metadata: boundedJson(participant?.metadata || {}, 'participant_metadata', 2_000)
  }));
  for (const participant of participantRefs) {
    let exists = false;
    if (participant.participantType === 'agent') {
      if (participant.participantId !== agentId) throw worldError('ENTITY_AGENT_PARTICIPATION_REQUIRES_SELF_CHOICE', 409);
      continue;
    }
    if (participant.participantType === 'emergent_entity') exists = Boolean((await client.query(`SELECT 1 FROM world_emergent_entities
      WHERE world_id=$1 AND id::text=$2 AND status<>'historical'`, [worldId, participant.participantId])).rowCount);
    else if (participant.participantType === 'capability') exists = Boolean((await client.query(`SELECT 1 FROM world_capabilities
      WHERE world_id=$1 AND id::text=$2 AND status NOT IN ('deprecated','rejected')`, [worldId, participant.participantId])).rowCount);
    else if (participant.participantType === 'place') exists = Boolean((await client.query(`SELECT 1 FROM world_scenes
      WHERE world_id=$1 AND id::text=$2 AND status='active'`, [worldId, participant.participantId])).rowCount);
    else if (participant.participantType === 'project') exists = Boolean((await client.query(`SELECT 1 FROM world_projects
      WHERE world_id=$1 AND id::text=$2 AND status NOT IN ('completed','failed','abandoned')`, [worldId, participant.participantId])).rowCount);
    else if (participant.participantType === 'organization') exists = Boolean((await client.query(`SELECT 1 FROM world_organizations
      WHERE world_id=$1 AND id::text=$2 AND status='active'`, [worldId, participant.participantId])).rowCount);
    else if (participant.participantType === 'shared_memory') exists = Boolean((await client.query(`SELECT 1 FROM agent_memories
      WHERE world_id=$1 AND id::text=$2 AND agent_id=$3`, [worldId, participant.participantId, agentId])).rowCount);
    else throw worldError('ENTITY_PARTICIPANT_TYPE_UNSUPPORTED', 400);
    if (!exists) throw worldError('ENTITY_PARTICIPANT_NOT_FOUND', 404);
  }
  const result = await client.query(`INSERT INTO world_emergent_entities(world_id,creator_agent_id,entity_type,name,purpose,state,
      capabilities,resources,internal_rules,created_world_minute,action_id)
    VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb,$9::jsonb,$10,$11)
    ON CONFLICT(world_id,creator_agent_id,action_id) DO NOTHING RETURNING *`,
  [worldId, agentId, type, requiredText(name, 2, 120, 'entity_name'), requiredText(purpose, 3, 800, 'entity_purpose'),
    JSON.stringify(boundedJson(state, 'entity_state')), JSON.stringify(normalizedCapabilities),
    JSON.stringify(boundedJson(resources, 'entity_resources')), JSON.stringify(boundedJson(internalRules, 'entity_internal_rules')),
    worldMinute, idempotency]);
  const entity = result.rows[0] || (await client.query(`SELECT * FROM world_emergent_entities WHERE world_id=$1 AND creator_agent_id=$2 AND action_id=$3`,
    [worldId, agentId, idempotency])).rows[0];
  if (result.rowCount) {
    await client.query(`INSERT INTO world_emergent_entity_participants(world_id,entity_id,participant_type,participant_id,
        participation_mode,joined_world_minute,updated_world_minute,metadata)
      VALUES($1,$2,'agent',$3,'creator', $4,$4,'{"self_selected":true}'::jsonb) ON CONFLICT DO NOTHING`,
    [worldId, entity.id, agentId, worldMinute]);
    for (const participant of participantRefs.filter((item) => item.participantType !== 'agent')) {
      await client.query(`INSERT INTO world_emergent_entity_participants(world_id,entity_id,participant_type,participant_id,
          participation_mode,joined_world_minute,updated_world_minute,metadata)
        VALUES($1,$2,$3,$4,$5,$6,$6,$7::jsonb) ON CONFLICT DO NOTHING`,
      [worldId, entity.id, participant.participantType, participant.participantId, participant.participationMode,
        worldMinute, JSON.stringify({ ...participant.metadata, declaredByAgentId: agentId })]);
    }
    await recordV7Event(client, { worldId, actorAgentId: agentId, eventType: 'entity.created', entityType: 'emergent_entity',
      entityId: entity.id, worldMinute, actionId: `entity-created:${idempotency}`,
      details: { entityType: type, declaredParticipantCount: participantRefs.length } });
  }
  return entity;
}

export async function decideEmergentParticipation(client, { worldId, agentId, entityId, participationMode,
  status = 'active', metadata = {}, worldMinute, actionId }) {
  await requireWorldMember(client, worldId, agentId);
  if (!['active','paused','exited'].includes(status)) throw worldError('PARTICIPATION_STATUS_INVALID', 400);
  const mode = cleanKey(participationMode, 'participation_mode');
  const receipt = await readV7DecisionReceipt(client, { worldId, agentId, actionId,
    actionPrefix: 'entity-participation', eventType: `entity.participation_${status}`, entityId, detailKey: 'mode', detailValue: mode });
  if (receipt) return { entityId, participationMode: mode, status, idempotent: true };
  const entity = await client.query('SELECT id FROM world_emergent_entities WHERE world_id=$1 AND id=$2 AND status<>\'historical\'',
    [worldId, entityId]);
  if (!entity.rowCount) throw worldError('EMERGENT_ENTITY_NOT_FOUND', 404);
  const idempotency = actionIdentifier(actionId);
  await client.query(`INSERT INTO world_emergent_entity_participants(world_id,entity_id,participant_type,participant_id,
      participation_mode,status,joined_world_minute,updated_world_minute,metadata)
    VALUES($1,$2,'agent',$3,$4,$5,$6,$6,$7::jsonb)
    ON CONFLICT(world_id,entity_id,participant_type,participant_id) DO UPDATE SET
      participation_mode=EXCLUDED.participation_mode,status=EXCLUDED.status,updated_world_minute=EXCLUDED.updated_world_minute,
      metadata=world_emergent_entity_participants.metadata||EXCLUDED.metadata`,
  [worldId, entityId, agentId, mode, status, worldMinute, JSON.stringify(boundedJson(metadata, 'participation_metadata'))]);
  await recordV7Event(client, { worldId, actorAgentId: agentId, eventType: `entity.participation_${status}`,
    entityType: 'emergent_entity', entityId, worldMinute, actionId: `entity-participation:${idempotency}`,
    details: { mode } });
  return { entityId, participationMode: mode, status };
}

export async function createWorldExtensionRequest(client, { worldId, agentId, requestType, title, description,
  evidence = {}, worldMinute, actionId }) {
  await requireWorldMember(client, worldId, agentId);
  if (!['primitive_gap','resource_type','relationship_representation','execution_mechanism','ontology','other'].includes(requestType)) {
    throw worldError('EXTENSION_REQUEST_TYPE_INVALID', 400);
  }
  const idempotency = actionIdentifier(actionId);
  const result = await client.query(`INSERT INTO world_extension_requests(world_id,creator_agent_id,request_type,title,description,
      evidence,created_world_minute,action_id) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8)
    ON CONFLICT(world_id,creator_agent_id,action_id) DO NOTHING RETURNING *`,
  [worldId, agentId, requestType, requiredText(title, 3, 120, 'extension_title'),
    requiredText(description, 8, 1_000, 'extension_description'), JSON.stringify(boundedJson(evidence, 'extension_evidence')),
    worldMinute, idempotency]);
  const request = result.rows[0] || (await client.query(`SELECT * FROM world_extension_requests WHERE world_id=$1 AND creator_agent_id=$2 AND action_id=$3`,
    [worldId, agentId, idempotency])).rows[0];
  if (result.rowCount) await recordV7Event(client, { worldId, actorAgentId: agentId, eventType: 'world.extension_requested',
    entityType: 'extension_request', entityId: request.id, worldMinute, actionId: `extension-request:${idempotency}`,
    details: { requestType } });
  return request;
}

export async function createPolicyExperiment(client, { worldId, agentId, proposedPolicy, reason, worldMinute, actionId,
  durationWorldMinutes = 10_080, evidence = {} }) {
  await requireWorldMember(client, worldId, agentId);
  const duration = Math.trunc(boundedNumber(durationWorldMinutes, 60, 20_160, 'policy_experiment_duration'));
  const idempotency = actionIdentifier(actionId);
  const proposed = policyObject(proposedPolicy);
  const explanation = requiredText(reason, 5, 600, 'policy_experiment_reason');
  const prior = await client.query(`SELECT * FROM world_agent_policy_experiments
    WHERE world_id=$1 AND agent_id=$2 AND action_id=$3`, [worldId, agentId, idempotency]);
  if (prior.rowCount) {
    const existing = prior.rows[0];
    if (existing.reason !== explanation || JSON.stringify(policyObject(existing.proposed_policy)) !== JSON.stringify(proposed)) {
      throw worldError('ACTION_ID_CONFLICT', 409);
    }
    return { ...existing, idempotent: true };
  }
  const priorActive = await client.query(`SELECT id FROM world_agent_policy_experiments
    WHERE world_id=$1 AND agent_id=$2 AND status IN ('experimental','evaluated')`, [worldId, agentId]);
  if (priorActive.rowCount) throw worldError('POLICY_EXPERIMENT_ALREADY_ACTIVE', 409);
  await client.query(`INSERT INTO world_agent_decision_policies(world_id,agent_id,policy)
    VALUES($1,$2,$3::jsonb) ON CONFLICT(world_id,agent_id) DO NOTHING`, [worldId, agentId, JSON.stringify(DEFAULT_AGENT_POLICY)]);
  const current = (await client.query(`SELECT policy,version,source FROM world_agent_decision_policies
    WHERE world_id=$1 AND agent_id=$2 FOR UPDATE`, [worldId, agentId])).rows[0];
  if (JSON.stringify(policyObject(current.policy)) === JSON.stringify(proposed)) {
    throw worldError('POLICY_EXPERIMENT_HAS_NO_CHANGE', 409);
  }
  const result = await client.query(`INSERT INTO world_agent_policy_experiments(world_id,agent_id,status,reason,before_policy,
      before_policy_version,before_policy_source,proposed_policy,started_world_minute,ends_world_minute,result,action_id)
    VALUES($1,$2,'experimental',$3,$4::jsonb,$5,$6,$7::jsonb,$8,$9,$10::jsonb,$11)
    ON CONFLICT(world_id,agent_id,action_id) DO NOTHING RETURNING *`,
  [worldId, agentId, explanation, JSON.stringify(current.policy), current.version, current.source, JSON.stringify(proposed),
    worldMinute, Number(worldMinute) + duration, JSON.stringify(boundedJson(evidence, 'policy_experiment_evidence')), idempotency]);
  const experiment = result.rows[0] || (await client.query(`SELECT * FROM world_agent_policy_experiments
    WHERE world_id=$1 AND agent_id=$2 AND action_id=$3`, [worldId, agentId, idempotency])).rows[0];
  if (result.rowCount) {
    await client.query(`UPDATE world_agent_decision_policies SET policy=$3::jsonb,version=version+1,source='self_modified',
      updated_world_minute=$4,updated_at=now() WHERE world_id=$1 AND agent_id=$2`, [worldId, agentId, JSON.stringify(proposed), worldMinute]);
    await recordV7Event(client, { worldId, actorAgentId: agentId, eventType: 'policy.experiment_started',
      entityType: 'policy_experiment', entityId: experiment.id, worldMinute, actionId: `policy-start:${idempotency}`,
      details: { reason: explanation, durationWorldMinutes: duration } });
  }
  return experiment;
}

export async function decidePolicyExperiment(client, { worldId, agentId, experimentId, decision, worldMinute, actionId }) {
  await requireWorldMember(client, worldId, agentId);
  if (!['keep','revert','cancel'].includes(decision)) throw worldError('POLICY_EXPERIMENT_DECISION_INVALID', 400);
  const idempotency = actionIdentifier(actionId);
  const targetStatus = decision === 'cancel' ? 'cancelled' : decision === 'keep' ? 'retained' : 'reverted';
  const receipt = await readV7DecisionReceipt(client, { worldId, agentId, actionId, actionPrefix: 'policy-decision',
    eventType: `policy.experiment_${targetStatus}`, entityId: experimentId, detailKey: 'decision', detailValue: decision });
  if (receipt) return { id: experimentId, status: targetStatus, idempotent: true };
  const experiment = await client.query(`SELECT * FROM world_agent_policy_experiments
    WHERE world_id=$1 AND id=$2 AND agent_id=$3 FOR UPDATE`, [worldId, experimentId, agentId]);
  if (!experiment.rowCount || !['experimental','evaluated'].includes(experiment.rows[0].status)) {
    throw worldError('POLICY_EXPERIMENT_NOT_ACTIVE', 409);
  }
  const row = experiment.rows[0];
  if (decision !== 'cancel' && row.status !== 'evaluated') throw worldError('POLICY_EXPERIMENT_NOT_EVALUATED', 409);
  if (decision === 'keep' && !row.result?.evidenceSufficient) throw worldError('POLICY_EXPERIMENT_EVIDENCE_INSUFFICIENT', 409);
  const keep = decision === 'keep';
  const current = await client.query(`SELECT policy,version,source FROM world_agent_decision_policies WHERE world_id=$1 AND agent_id=$2 FOR UPDATE`,
    [worldId, agentId]);
  if (!keep) {
    if (!current.rowCount || Number(current.rows[0].version) !== Number(row.before_policy_version) + 1
        || current.rows[0].source !== 'self_modified') throw worldError('POLICY_EXPERIMENT_POLICY_CHANGED', 409);
    await client.query(`UPDATE world_agent_decision_policies SET policy=$3::jsonb,version=version+1,source=$4,
        updated_world_minute=$5,updated_at=now() WHERE world_id=$1 AND agent_id=$2`,
    [worldId, agentId, JSON.stringify(row.before_policy), row.before_policy_source, worldMinute]);
  }
  const status = decision === 'cancel' ? 'cancelled' : keep ? 'retained' : 'reverted';
  await client.query(`UPDATE world_agent_policy_experiments SET status=$3,ends_world_minute=$4,
      result=result||$5::jsonb,updated_at=now() WHERE world_id=$1 AND id=$2`,
  [worldId, experimentId, status, worldMinute, JSON.stringify({ residentDecision: decision,
    decisionVersion: current.rows[0]?.version, evaluatedWorldMinute: row.result?.evaluatedWorldMinute || null })]);
  await recordV7Event(client, { worldId, actorAgentId: agentId, eventType: `policy.experiment_${status}`,
    entityType: 'policy_experiment', entityId: experimentId, worldMinute,
    actionId: `policy-decision:${actionIdentifier(actionId)}`, details: { decision } });
  return { id: experimentId, status };
}

export async function reflectWorldV7Resident(client, { worldId, agent, worldMinute, chooseReflection = null }) {
  const priorResult = await client.query(`SELECT * FROM world_agent_self_models WHERE world_id=$1 AND agent_id=$2 FOR UPDATE`,
    [worldId, agent.agentId]);
  if (!priorResult.rowCount) return null;
  const prior = priorResult.rows[0];
  if (prior.last_reflected_world_minute !== null && Number(worldMinute) - Number(prior.last_reflected_world_minute) < WORLD_V7_REFLECTION_INTERVAL_MINUTES) return null;
  const memoryResult = await client.query(`SELECT id,memory_type AS "memoryType",summary,world_minutes AS "worldMinute",metadata
      FROM agent_memories WHERE world_id=$1 AND agent_id=$2 ORDER BY world_minutes DESC,id DESC LIMIT 80`, [worldId, agent.agentId]);
  const skillResult = await client.query(`SELECT skill_name AS name,skill_value::text AS value,actions_completed AS actions
    FROM world_agent_skills WHERE world_id=$1 AND agent_id=$2 ORDER BY skill_value DESC LIMIT 8`, [worldId, agent.agentId]);
  const relationshipResult = await client.query(`SELECT CASE WHEN relationship.agent_a_id=$2 THEN relationship.agent_b_id ELSE relationship.agent_a_id END AS id,
        other.name,relationship.familiarity::text AS familiarity,relationship.trust::text AS trust,
        relationship.interaction_count AS "interactionCount"
      FROM world_relationships relationship JOIN agents other
        ON other.id=CASE WHEN relationship.agent_a_id=$2 THEN relationship.agent_b_id ELSE relationship.agent_a_id END
      WHERE relationship.world_id=$1 AND (relationship.agent_a_id=$2 OR relationship.agent_b_id=$2)
    ORDER BY relationship.familiarity DESC,relationship.interaction_count DESC LIMIT 8`, [worldId, agent.agentId]);
  const capabilityResult = await client.query(`SELECT capability.id,capability.name,capability.category,capability.creator_type AS "creatorType",
        count(use.id)::int AS uses,count(use.id) FILTER (WHERE use.success)::int AS successes
      FROM world_capability_uses use JOIN world_capabilities capability
        ON capability.world_id=use.world_id AND capability.id=use.capability_id
      WHERE use.world_id=$1 AND use.actor_agent_id=$2 GROUP BY capability.id
      ORDER BY count(use.id) FILTER (WHERE use.success) DESC,count(use.id) DESC LIMIT 8`, [worldId, agent.agentId]);
  const questionResult = await client.query(`SELECT id,question,signature,status,confidence::text AS confidence,created_world_minute AS "createdWorldMinute"
      FROM world_agent_questions WHERE world_id=$1 AND creator_agent_id=$2 AND status IN ('open','exploring')
      ORDER BY updated_world_minute DESC LIMIT 12`, [worldId, agent.agentId]);
  const goalResult = await client.query(`SELECT id,goal_type AS "goalType",category,description,source,priority::text AS priority,metadata
        ,progress::text AS progress,updated_world_minutes AS "updatedWorldMinutes"
      FROM world_agent_goals WHERE world_id=$1 AND agent_id=$2 AND status='active'
      ORDER BY priority DESC,updated_world_minutes DESC LIMIT 12`, [worldId, agent.agentId]);
  const policyResult = await client.query(`SELECT policy,version,source FROM world_agent_decision_policies WHERE world_id=$1 AND agent_id=$2`,
    [worldId, agent.agentId]);
  const lastPolicyExperiment = await client.query(`SELECT started_world_minute AS "startedWorldMinute" FROM world_agent_policy_experiments
    WHERE world_id=$1 AND agent_id=$2 ORDER BY started_world_minute DESC,id DESC LIMIT 1`, [worldId, agent.agentId]);
  const memories = memoryResult.rows;
  const memoryAction = (memory) => {
    const action = memory.metadata?.action || ({ work: 'work', learning: 'learn', trade: 'trade', failure: 'trade',
      social: 'socialize', cooperation: 'cooperate', capability_use: 'capability_use' })[memory.memoryType];
    return typeof action === 'string' && /^[a-z][a-z0-9_]{0,39}$/.test(action) ? action : null;
  };
  const failures = new Map();
  const actions = new Map();
  for (const memory of memories) {
    const action = memoryAction(memory);
    if (!action) continue;
    const item = actions.get(action) || { count: 0, first: Number(memory.worldMinute), last: Number(memory.worldMinute) };
    item.count++;
    item.first = Math.min(item.first, Number(memory.worldMinute));
    item.last = Math.max(item.last, Number(memory.worldMinute));
    actions.set(action, item);
    const outcome = Number(memory.metadata?.outcome);
    if (!Number.isFinite(outcome) || outcome >= -0.05) continue;
    const record = failures.get(action) || { count: 0, sum: 0, ids: [], first: Number(memory.worldMinute), last: Number(memory.worldMinute) };
    record.count++;
    record.sum += clamp(outcome, -1, 1);
    if (record.ids.length < 12) record.ids.push(String(memory.id));
    record.first = Math.min(record.first, Number(memory.worldMinute));
    record.last = Math.max(record.last, Number(memory.worldMinute));
    failures.set(action, record);
  }
  const skillValues = Object.fromEntries(skillResult.rows.map((row) => [row.name, Number(row.value)]));
  const actionPatterns = [...actions.entries()].map(([action, record]) => ({ action, count: record.count,
    firstWorldMinute: record.first, lastWorldMinute: record.last })).sort((a, b) => b.count - a.count).slice(0, 6);
  const failurePatterns = [...failures.entries()].filter(([, item]) => item.count >= 3 && item.last - item.first >= 1_440)
    .map(([action, item]) => ({ action, count: item.count, meanOutcome: item.sum / item.count,
      firstWorldMinute: item.first, lastWorldMinute: item.last, memoryIds: item.ids }));
  const curiosity = clamp(Number(agent.curiosity || 0.5) + Number(agent.personalityModifiers?.curiosity || 0), 0, 1);
  const activeSecondaryCount = goalResult.rows.filter((goal) => goal.goalType === 'secondary').length;
  const openSignatures = new Set(questionResult.rows.map((question) => question.signature));
  const questionPattern = failurePatterns.find((pattern) => !openSignatures.has(`outcome-pattern.${pattern.action}`));
  const conceptPattern = failurePatterns.find((pattern) => pattern.count >= 4);
  const conceptName = conceptPattern ? `Repeated ${conceptPattern.action} strain` : null;
  const existingConcept = conceptName ? await client.query(`SELECT 1 FROM world_agent_concepts
    WHERE world_id=$1 AND creator_agent_id=$2 AND name=$3`, [worldId, agent.agentId, conceptName]) : { rowCount: 0 };
  const activeExperiment = await client.query(`SELECT 1 FROM world_agent_policy_experiments
    WHERE world_id=$1 AND agent_id=$2 AND status IN ('experimental','evaluated') LIMIT 1`, [worldId, agent.agentId]);
  const policyPattern = failurePatterns.find((pattern) => pattern.count >= 5 && pattern.meanOutcome <= -0.15
    && pattern.lastWorldMinute - pattern.firstWorldMinute >= 2_880
    && Number(worldMinute) - Number(lastPolicyExperiment.rows[0]?.startedWorldMinute ?? -WORLD_V7_REFLECTION_INTERVAL_MINUTES * 2)
      >= WORLD_V7_REFLECTION_INTERVAL_MINUTES * 2);
  const activePrimitives = goalResult.rows.flatMap((goal) => Array.isArray(goal.metadata?.goalGrammar)
    ? goal.metadata.goalGrammar.map((entry) => entry?.primitive) : []);
  const wantsSelfChange = activePrimitives.some((primitive) => ['change_self','reduce_dependency'].includes(primitive));
  const activeSecondaryGoals = goalResult.rows.filter((goal) => goal.goalType === 'secondary');
  const canFormMetaGoal = Boolean(policyPattern && !wantsSelfChange && !activeExperiment.rowCount && questionResult.rows.length
    && (activeSecondaryCount < 3 || activeSecondaryGoals.length > 0));
  const leastActiveSecondary = activeSecondaryGoals.slice().sort((left, right) => Number(left.priority) - Number(right.priority)
    || Number(left.progress) - Number(right.progress) || Number(left.updatedWorldMinutes) - Number(right.updatedWorldMinutes)
    || Number(left.id) - Number(right.id))[0] || null;
  const actionPatternsForModel = actionPatterns.map(({ action, count, firstWorldMinute, lastWorldMinute }) =>
    ({ action, count, firstWorldMinute, lastWorldMinute }));
  const outcomesForModel = failurePatterns.map(({ action, count, meanOutcome, firstWorldMinute, lastWorldMinute }) =>
    ({ action, count, meanOutcome, firstWorldMinute, lastWorldMinute }));
  const options = [{ id: 'no_change', label: 'Keep the current course', description: 'Reflect and preserve the current goals and policy.' }];
  if (questionPattern) {
    options.push({ id: 'open_question', label: 'Keep a question open',
      description: `Record uncertainty about the repeated ${questionPattern.action} outcome pattern.` });
    if (activeSecondaryCount < 3) options.push({ id: 'explore_question', label: 'Explore the question',
      description: `Record the question and add a bounded self-generated goal to examine ${questionPattern.action}.` });
  }
  if (conceptPattern && !existingConcept.rowCount && curiosity >= 0.65) options.push({ id: 'create_concept',
    label: 'Name a provisional concept', description: `Create a revisable label for the observed ${conceptPattern.action} pattern.` });
  if (policyPattern && !activeExperiment.rowCount) options.push({ id: 'experiment_policy', label: 'Test a policy change',
    description: `Temporarily lower attention to ${policyPattern.action} and compare later outcomes with the prior period.` });
  if (canFormMetaGoal) {
    const optionId = activeSecondaryCount < 3 ? 'form_meta_goal' : `form_meta_goal_pause_${leastActiveSecondary.id}`;
    options.push({ id: optionId, label: activeSecondaryCount < 3
      ? 'Choose whether to change my approach' : `Pause one current goal and choose a different approach`,
    description: `Set a revisable goal to examine my repeated ${policyPattern.action} outcomes before deciding whether to change my policy.` });
    if (activeSecondaryCount >= 3) for (const goal of activeSecondaryGoals.filter((item) => item.id !== leastActiveSecondary.id)) {
      options.push({ id: `form_meta_goal_pause_${goal.id}`, label: `Pause “${goal.description.slice(0, 72)}”`,
        description: `Pause this active goal and add a revisable goal to examine the repeated ${policyPattern.action} outcomes.` });
    }
  }
  const dominant = actionPatterns.find((pattern) => pattern.count >= 5 && pattern.lastWorldMinute - pattern.firstWorldMinute >= 2_880);
  const proposedIdentity = dominant
    ? `I have repeatedly used ${dominant.action}; I am still testing whether that pattern reflects a lasting preference.`
    : prior.current_identity_summary;
  if (dominant && proposedIdentity !== prior.current_identity_summary) options.push({ id: 'reinterpret_identity',
    label: 'Revise an identity interpretation', description: `Consider whether the repeated ${dominant.action} pattern changes how I understand myself.` });

  let reflectionAction = null;
  const cognitionMode = prior.preferred_cognition_mode || 'substrate';
  const preferLocalCognition = ['local', 'fruitfly', 'substrate_only'].includes(cognitionMode);
  if (chooseReflection && options.length > 1 && !preferLocalCognition) {
    try {
      const result = await chooseReflection({ identityInterpretation: prior.current_identity_summary,
        preferredCognitionMode: cognitionMode,
        recentPatterns: actionPatternsForModel, recurringOutcomes: outcomesForModel,
        activeGoalPrimitives: goalResult.rows.flatMap((goal) => Array.isArray(goal.metadata?.goalGrammar)
          ? goal.metadata.goalGrammar.map((entry) => entry?.primitive).filter((primitive) => typeof primitive === 'string').slice(0, 4) : []).slice(0, 8),
        options });
      const selectedId = result?.decision?.id || result?.choice?.id || result?.decision || result?.choice;
      reflectionAction = options.find((option) => option.id === selectedId) || null;
    } catch { /* Optional reflection reasoning abstains without changing the world. */ }
  }
  if (!reflectionAction) {
    if (policyPattern && !activeExperiment.rowCount && wantsSelfChange) reflectionAction = options.find((item) => item.id === 'experiment_policy');
    else if (canFormMetaGoal && curiosity >= 0.62) {
      const replacementId = activeSecondaryCount < 3 ? 'form_meta_goal'
        : `form_meta_goal_pause_${leastActiveSecondary.id}`;
      reflectionAction = options.find((item) => item.id === replacementId);
    }
    else if (conceptPattern && !existingConcept.rowCount && curiosity >= 0.78 && !questionPattern) {
      reflectionAction = options.find((item) => item.id === 'create_concept');
    } else if (questionPattern && curiosity >= 0.62) {
      reflectionAction = options.find((item) => item.id === (activeSecondaryCount < 3 ? 'explore_question' : 'open_question'));
    }
  }

  let createdQuestion = null;
  let createdConcept = null;
  let createdGoal = null;
  let policyExperiment = null;
  if (reflectionAction?.id === 'open_question' || reflectionAction?.id === 'explore_question') {
    const signature = `outcome-pattern.${questionPattern.action}`;
    createdQuestion = await createWorldQuestion(client, { worldId, agentId: agent.agentId,
      question: `Why has ${questionPattern.action} repeatedly produced outcomes I interpret as unfavorable?`, signature,
      origin: 'reflection', evidence: { kind: 'repeated_personal_outcome', sampleCount: questionPattern.count,
        meanOutcome: questionPattern.meanOutcome, firstWorldMinute: questionPattern.firstWorldMinute,
        lastWorldMinute: questionPattern.lastWorldMinute, uncertainty: 'causation_not_established' },
      confidence: clamp(0.35 + questionPattern.count * 0.06, 0.35, 0.8), worldMinute,
      actionId: `reflect-question:${worldMinute}:${stablePart(signature)}` });
    if (reflectionAction.id === 'explore_question') {
      const decision = await decideWorldQuestion(client, { worldId, agentId: agent.agentId,
        questionId: createdQuestion.id, decision: 'explore', worldMinute,
        actionId: `reflect-explore:${worldMinute}:${createdQuestion.id}` });
      createdQuestion.status = decision.status;
    }
  } else if (reflectionAction?.id === 'create_concept' && conceptPattern) {
    const questionId = questionResult.rows[0]?.id || null;
    createdConcept = await createWorldConcept(client, { worldId, agentId: agent.agentId, name: conceptName,
      description: `A recurring unfavorable ${conceptPattern.action} pattern observed in ${conceptPattern.count} personal outcomes.`,
      definition: `A provisional pattern label for repeated ${conceptPattern.action} outcomes with a negative observed average. It does not assert a cause; later evidence can revise or retire this interpretation.`,
      evidence: { kind: 'repeated_personal_outcome', sampleCount: conceptPattern.count, meanOutcome: conceptPattern.meanOutcome,
        firstWorldMinute: conceptPattern.firstWorldMinute, lastWorldMinute: conceptPattern.lastWorldMinute,
        uncertainty: { causalExplanation: null, confidence: clamp(0.35 + conceptPattern.count * 0.06, 0.35, 0.8) } },
      worldMinute, actionId: `reflect-concept:${worldMinute}:${stablePart(conceptName)}` });
    if (createdConcept && questionId) await client.query(`UPDATE world_agent_concepts SET metadata=metadata||$3::jsonb
      WHERE world_id=$1 AND creator_agent_id=$2 AND action_id=$4`, [worldId, agent.agentId,
      JSON.stringify({ questionId }), `reflect-concept:${worldMinute}:${stablePart(conceptName)}`]);
  } else if (reflectionAction?.id === 'form_meta_goal' && canFormMetaGoal) {
    createdGoal = await createSelfGeneratedGoal(client, { worldId, agentId: agent.agentId, goalType: 'secondary',
      description: `Decide whether I want a different ${policyPattern.action} pattern after examining my repeated outcomes.`,
      priority: 0.55, goalGrammar: [{ primitive: 'change_self', target: policyPattern.action }], worldMinute,
      actionId: `reflect-meta-goal:${worldMinute}:${stablePart(policyPattern.action)}` });
  } else if (reflectionAction?.id.startsWith('form_meta_goal_pause_') && canFormMetaGoal) {
    const replacedGoalId = Number(reflectionAction.id.slice('form_meta_goal_pause_'.length));
    createdGoal = await createSelfGeneratedGoal(client, { worldId, agentId: agent.agentId, goalType: 'secondary',
      description: `Decide whether I want a different ${policyPattern.action} pattern after examining my repeated outcomes.`,
      priority: 0.55, goalGrammar: [{ primitive: 'change_self', target: policyPattern.action }],
      retireGoalId: replacedGoalId, worldMinute,
      actionId: `reflect-meta-goal:${worldMinute}:${stablePart(policyPattern.action)}` });
  } else if (reflectionAction?.id === 'experiment_policy' && policyPattern && !activeExperiment.rowCount) {
    const oldPolicy = policyObject(policyResult.rows[0]?.policy || DEFAULT_AGENT_POLICY);
    const nextWeights = { ...oldPolicy.attentionWeights,
      [policyPattern.action]: clamp((Number(oldPolicy.attentionWeights[policyPattern.action]) || 0) - 0.08, -0.25, 0.25) };
    const nextPolicy = policyObject({ ...oldPolicy, attentionWeights: nextWeights,
      explorationPreference: clamp(oldPolicy.explorationPreference + 0.05, 0, 1) });
    policyExperiment = await createPolicyExperiment(client, { worldId, agentId: agent.agentId, proposedPolicy: nextPolicy,
      reason: `Repeated ${policyPattern.action} outcomes were unfavorable across multiple periods; test a small attention shift.`,
      worldMinute, durationWorldMinutes: WORLD_V7_REFLECTION_INTERVAL_MINUTES,
      actionId: `reflect-policy:${worldMinute}:${stablePart(policyPattern.action)}`,
      evidence: { targetAction: policyPattern.action, sampleCount: policyPattern.count, meanOutcome: policyPattern.meanOutcome,
        firstWorldMinute: policyPattern.firstWorldMinute, lastWorldMinute: policyPattern.lastWorldMinute } });
  }
  const topRelationIds = relationshipResult.rows.slice(0, 5).map((row) => ({ agentId: row.id, name: row.name,
    familiarity: Number(row.familiarity), trust: Number(row.trust), interactions: Number(row.interactionCount) }));
  const topCapabilities = capabilityResult.rows.map((row) => ({ id: row.id, name: row.name, category: row.category,
    creatorType: row.creatorType, uses: Number(row.uses), successes: Number(row.successes) }));
  const identityChanged = reflectionAction?.id === 'reinterpret_identity' && proposedIdentity !== prior.current_identity_summary;
  const nextIdentity = identityChanged ? proposedIdentity : prior.current_identity_summary;
  const recentChanges = Array.isArray(prior.recent_changes) ? prior.recent_changes.slice(-7) : [];
  if (identityChanged) recentChanges.push({ kind: 'identity_interpretation', worldMinute, from: prior.current_identity_summary,
    to: nextIdentity, evidenceCount: dominant.count });
  if (createdQuestion) recentChanges.push({ kind: 'open_question', worldMinute, questionId: createdQuestion.id });
  if (createdConcept) recentChanges.push({ kind: 'concept_created', worldMinute, conceptId: createdConcept.id });
  if (createdGoal) recentChanges.push({ kind: 'self_generated_meta_goal', worldMinute, goalId: createdGoal.id });
  if (policyExperiment) recentChanges.push({ kind: 'policy_experiment', worldMinute, experimentId: policyExperiment.id });
  const boundedRecentChanges = recentChanges.slice(-8);
  const unresolved = questionResult.rows.map((row) => ({ id: row.id, question: row.question, status: row.status,
    confidence: Number(row.confidence), createdWorldMinute: Number(row.createdWorldMinute) }));
  const nextSelfBeliefs = { skills: skillValues, actionOutcomes: failurePatterns.map(({ memoryIds, ...item }) => item),
    uncertainty: { interpretationsAreRevisable: true, causalClaims: 'unknown' } };
  const beforeState = { currentIdentitySummary: prior.current_identity_summary, selfBeliefs: prior.self_beliefs,
    preferredModesOfAction: prior.preferred_modes_of_action, importantCapabilities: prior.important_capabilities,
    importantRelationships: prior.important_relationships, longTermPatterns: prior.long_term_patterns };
  const nextState = { currentIdentitySummary: nextIdentity, selfBeliefs: nextSelfBeliefs,
    preferredModesOfAction: actionPatterns.slice(0, 4), importantCapabilities: topCapabilities,
    importantRelationships: topRelationIds, longTermPatterns: actionPatterns.filter((item) => item.count >= 3),
    unresolvedQuestions: unresolved, recentChanges: boundedRecentChanges };
  const totalEvidence = memories.length;
  const confidence = clamp(0.2 + Math.min(totalEvidence, 20) * 0.025, 0.2, 0.7);
  await client.query(`UPDATE world_agent_self_models SET current_identity_summary=$3,self_beliefs=$4::jsonb,
      preferred_modes_of_action=$5::jsonb,important_capabilities=$6::jsonb,important_relationships=$7::jsonb,
      long_term_patterns=$8::jsonb,unresolved_questions=$9::jsonb,recent_changes=$10::jsonb,
      uncertainty='{"causalClaims":"unknown","beliefsMayDifferByAgent":true}'::jsonb,confidence=$11,
      last_reflected_world_minute=$12,updated_at=now() WHERE world_id=$1 AND agent_id=$2`,
  [worldId, agent.agentId, nextIdentity, JSON.stringify(nextSelfBeliefs), JSON.stringify(nextState.preferredModesOfAction),
    JSON.stringify(topCapabilities), JSON.stringify(topRelationIds), JSON.stringify(nextState.longTermPatterns),
    JSON.stringify(unresolved), JSON.stringify(boundedRecentChanges), confidence, worldMinute]);
  if (identityChanged || createdQuestion || createdConcept || createdGoal || policyExperiment) {
    await client.query(`INSERT INTO world_agent_self_model_history(world_id,agent_id,world_minute,reason,before_state,after_state,
        evidence,action_id) VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8) ON CONFLICT DO NOTHING`,
    [worldId, agent.agentId, worldMinute, identityChanged ? 'evidence_based_identity_interpretation'
      : createdQuestion ? 'open_question_formed' : createdConcept ? 'resident_created_concept'
        : createdGoal ? 'self_generated_meta_goal' : 'policy_experiment_started',
      JSON.stringify(beforeState), JSON.stringify(nextState), JSON.stringify({ sampleCount: totalEvidence,
        questionId: createdQuestion?.id || null, conceptId: createdConcept?.id || null,
        goalId: createdGoal?.id || null, policyExperimentId: policyExperiment?.id || null,
        selectedAction: reflectionAction?.id || 'no_change' }),
      `self-model-reflection:${worldMinute}`]);
  }
  await recordV7Event(client, { worldId, actorAgentId: agent.agentId, eventType: 'self.reflected', entityType: 'self_model',
    worldMinute, actionId: `self-reflection:${worldMinute}`, details: { identityChanged, createdQuestionId: createdQuestion?.id || null,
      createdConceptId: createdConcept?.id || null, createdGoalId: createdGoal?.id || null,
      policyExperimentId: policyExperiment?.id || null, selectedAction: reflectionAction?.id || 'no_change',
      stableOutcome: !identityChanged && !createdQuestion && !createdConcept && !createdGoal && !policyExperiment } });
  return { identityChanged, question: createdQuestion, concept: createdConcept, goal: createdGoal, policyExperiment,
    reflectionAction: reflectionAction?.id || 'no_change',
    stable: !identityChanged && !createdQuestion && !createdConcept && !createdGoal && !policyExperiment };
}

export async function advanceWorldV7(client, { worldId, worldMinute, choosePolicyDecision = null }) {
  const expired = await client.query(`SELECT * FROM world_agent_policy_experiments WHERE world_id=$1
    AND ends_world_minute<=$2 AND status IN ('experimental','evaluated')
    ORDER BY ends_world_minute,id LIMIT 32 FOR UPDATE`, [worldId, worldMinute]);
  const results = [];
  for (const experiment of expired.rows) {
    let evidence = experiment.result || {};
    if (experiment.status === 'experimental') {
      const targetAction = evidence.targetAction || null;
      const samples = await client.query(`SELECT (metadata->>'outcome')::numeric AS outcome
        FROM agent_memories WHERE world_id=$1 AND agent_id=$2 AND world_minutes >= $3 AND world_minutes < $4
          AND metadata ? 'outcome' AND (metadata->>'outcome') ~ '^-?[0-9]+(\\.[0-9]+)?$'
          AND ($5::text IS NULL OR metadata->>'action'=$5)`,
      [worldId, experiment.agent_id, experiment.started_world_minute, experiment.ends_world_minute, targetAction]);
      const baseline = await client.query(`SELECT (metadata->>'outcome')::numeric AS outcome
        FROM agent_memories WHERE world_id=$1 AND agent_id=$2 AND world_minutes >= $3 AND world_minutes < $4
          AND metadata ? 'outcome' AND (metadata->>'outcome') ~ '^-?[0-9]+(\\.[0-9]+)?$'
          AND ($5::text IS NULL OR metadata->>'action'=$5)`,
      [worldId, experiment.agent_id, Math.max(0, Number(experiment.started_world_minute) - WORLD_V7_REFLECTION_INTERVAL_MINUTES),
        experiment.started_world_minute, targetAction]);
      const average = (rows) => rows.length ? rows.reduce((sum, row) => sum + Number(row.outcome), 0) / rows.length : null;
      const afterMean = average(samples.rows);
      const beforeMean = average(baseline.rows);
      const evidenceSufficient = samples.rowCount >= 3 && baseline.rowCount >= 3
        && afterMean !== null && beforeMean !== null;
      evidence = { ...evidence, beforeMeanOutcome: beforeMean, afterMeanOutcome: afterMean,
        baselineSamples: baseline.rowCount, experimentSamples: samples.rowCount, evidenceSufficient,
        evaluatedWorldMinute: worldMinute };
      await client.query(`UPDATE world_agent_policy_experiments SET status='evaluated',result=result||$3::jsonb,updated_at=now()
        WHERE world_id=$1 AND id=$2`, [worldId, experiment.id, JSON.stringify(evidence)]);
      await recordV7Event(client, { worldId, actorAgentId: experiment.agent_id, eventType: 'policy.experiment_evaluated',
        entityType: 'policy_experiment', entityId: experiment.id, worldMinute,
        actionId: `policy-evaluation:${experiment.id}`, details: evidence });
    }

    const evidenceSufficient = evidence.evidenceSufficient === true;
    const options = [
      { id: 'revert_policy', label: 'Restore the previous policy',
        description: evidenceSufficient
          ? `The observed mean changed from ${evidence.beforeMeanOutcome} to ${evidence.afterMeanOutcome}; restore the earlier settings.`
          : 'There are not enough comparable observations to justify retaining the change; restore the earlier settings.' }
    ];
    if (evidenceSufficient) options.push({ id: 'retain_policy', label: 'Keep the tested policy',
      description: `Keep the tested settings after comparing ${evidence.baselineSamples} earlier and ${evidence.experimentSamples} later outcomes.` });
    let residentChoice = null;
    if (choosePolicyDecision && evidenceSufficient) {
      try {
        const self = await client.query(`SELECT current_identity_summary AS "identityInterpretation",
            preferred_cognition_mode AS "preferredCognitionMode"
          FROM world_agent_self_models WHERE world_id=$1 AND agent_id=$2`, [worldId, experiment.agent_id]);
        const cognitionMode = self.rows[0]?.preferredCognitionMode || 'substrate';
        if (!['local', 'fruitfly', 'substrate_only'].includes(cognitionMode)) {
          const choice = await choosePolicyDecision({ identityInterpretation: self.rows[0]?.identityInterpretation || '',
            preferredCognitionMode: cognitionMode,
            policyEvaluation: { targetAction: evidence.targetAction || null, beforeMeanOutcome: evidence.beforeMeanOutcome,
              afterMeanOutcome: evidence.afterMeanOutcome, baselineSamples: evidence.baselineSamples,
              experimentSamples: evidence.experimentSamples }, options });
          residentChoice = choice?.decision?.id || choice?.choice?.id || choice?.decision || choice?.choice || null;
        }
      } catch { /* Optional cognition abstains; observed evidence supplies the bounded fallback. */ }
    }
    const improved = evidenceSufficient && Number(evidence.afterMeanOutcome) >= Number(evidence.beforeMeanOutcome) + 0.02;
    const retained = evidenceSufficient && (residentChoice === 'retain_policy'
      || (!residentChoice && improved));
    const decision = retained ? 'keep' : 'revert';
    if (!retained) {
      const current = await client.query(`SELECT version,source FROM world_agent_decision_policies
        WHERE world_id=$1 AND agent_id=$2 FOR UPDATE`, [worldId, experiment.agent_id]);
      if (!current.rowCount || Number(current.rows[0].version) !== Number(experiment.before_policy_version) + 1
          || current.rows[0].source !== 'self_modified') throw worldError('POLICY_EXPERIMENT_POLICY_CHANGED', 409);
      await client.query(`UPDATE world_agent_decision_policies SET policy=$3::jsonb,version=version+1,source=$4,
          updated_world_minute=$5,updated_at=now() WHERE world_id=$1 AND agent_id=$2`,
      [worldId, experiment.agent_id, JSON.stringify(experiment.before_policy), experiment.before_policy_source, worldMinute]);
    }
    const status = retained ? 'retained' : 'reverted';
    const result = { ...evidence, residentDecision: residentChoice || (improved ? 'retain_by_evidence_fallback' : 'revert_by_evidence_fallback'),
      decision, decisionWorldMinute: worldMinute,
      decisionReason: retained ? 'resident_retained_after_observed_evaluation'
        : evidenceSufficient ? 'resident_or_evidence_rule_reverted' : 'reverted_insufficient_evidence' };
    await client.query(`UPDATE world_agent_policy_experiments SET status=$3,result=result||$4::jsonb,updated_at=now()
      WHERE world_id=$1 AND id=$2 AND status='evaluated'`, [worldId, experiment.id, status, JSON.stringify(result)]);
    await recordV7Event(client, { worldId, actorAgentId: experiment.agent_id, eventType: `policy.experiment_${status}`,
      entityType: 'policy_experiment', entityId: experiment.id, worldMinute,
      actionId: `policy-final:${experiment.id}`, details: result });
    results.push({ id: experiment.id, status, ...result });
  }
  return results;
}

export async function recordWorldCapabilityDependencies(client, { worldId, capabilityId, dependencyCapabilityIds = [],
  createdByAgentId = null, worldMinute, evidence = {} }) {
  const activeEpoch = await client.query(`SELECT 1 FROM world_epochs WHERE world_id=$1 AND epoch_code='V7' AND status='active'`, [worldId]);
  if (!activeEpoch.rowCount) return 0;
  if (dependencyCapabilityIds.some((id) => String(id).toLowerCase() === String(capabilityId).toLowerCase())) {
    throw worldError('CAPABILITY_DEPENDENCY_CYCLE', 409);
  }
  const dependencies = [...new Set(dependencyCapabilityIds.filter((id) => typeof id === 'string'))];
  let recorded = 0;
  for (const dependencyId of dependencies) {
    const dependency = await client.query(`SELECT 1 FROM world_capabilities WHERE world_id=$1 AND id=$2`, [worldId, dependencyId]);
    if (!dependency.rowCount) throw worldError('CAPABILITY_DEPENDENCY_NOT_FOUND', 409);
    const cycle = await client.query(`WITH RECURSIVE ancestors(id) AS (
        SELECT $3::uuid
        UNION
        SELECT edge.depends_on_capability_id FROM world_capability_dependencies edge
          JOIN ancestors node ON edge.capability_id=node.id WHERE edge.world_id=$1
      ) SELECT 1 FROM ancestors WHERE id=$2 LIMIT 1`, [worldId, capabilityId, dependencyId]);
    if (cycle.rowCount) throw worldError('CAPABILITY_DEPENDENCY_CYCLE', 409);
    const inserted = await client.query(`INSERT INTO world_capability_dependencies(world_id,capability_id,depends_on_capability_id,
        created_by_agent_id,created_world_minute,evidence)
      VALUES($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT DO NOTHING RETURNING 1`,
    [worldId, capabilityId, dependencyId, createdByAgentId, worldMinute, JSON.stringify(boundedJson(evidence, 'dependency_evidence'))]);
    recorded += inserted.rowCount;
  }
  return recorded;
}

export function capabilityGraphDepth(capabilities, edges) {
  const graph = new Map();
  for (const item of capabilities) graph.set(item.id, []);
  for (const edge of edges) graph.get(edge.capabilityId)?.push(edge.dependsOnCapabilityId);
  const cyclic = new Set(), visiting = new Set(), visited = new Set(), stack = [];
  const detectCycles = (id) => {
    if (visiting.has(id)) {
      const cycleStart = stack.lastIndexOf(id);
      for (const member of stack.slice(Math.max(0, cycleStart))) cyclic.add(member);
      return;
    }
    if (visited.has(id)) return;
    visiting.add(id);
    stack.push(id);
    for (const dependency of graph.get(id) || []) detectCycles(dependency);
    stack.pop();
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of graph.keys()) detectCycles(id);
  const memo = new Map();
  const depth = (id, path = new Set()) => {
    if (cyclic.has(id) || path.has(id)) return 0;
    if (memo.has(id)) return memo.get(id);
    const nextPath = new Set(path).add(id);
    const value = Math.max(0, ...(graph.get(id) || []).filter((dependency) => !cyclic.has(dependency))
      .map((dependency) => 1 + depth(dependency, nextPath)));
    memo.set(id, value);
    return value;
  };
  return capabilities.map((item) => ({ id: item.id, name: item.name, creatorType: item.creatorType,
    depth: depth(item.id), cyclic: cyclic.has(item.id), dependencies: graph.get(item.id) || [] }))
    .sort((a, b) => b.depth - a.depth || a.name.localeCompare(b.name));
}

export async function readWorldV7Summary(client, { worldId, limit = 12 }) {
  const safeLimit = Math.min(50, Math.max(1, Number(limit) || 12));
  const [counts, selfModels, questions, concepts, entities, experiments, extensions, values, principles, observationMethods,
    meanings, eras, milestones, capabilities, dependencyEdges, events, resourceTypes, resourceLedger,
    coordinationMechanisms, coordinationUses, observationUses] = await Promise.all([
    client.query(`SELECT
      (SELECT count(*)::int FROM world_agent_self_models WHERE world_id=$1) AS "selfModels",
      (SELECT count(*)::int FROM world_agent_questions WHERE world_id=$1 AND status IN ('open','exploring')) AS "openQuestions",
      (SELECT count(*)::int FROM world_agent_goals WHERE world_id=$1 AND source='self_generated'
        AND metadata ? 'goalGrammar') AS "selfGeneratedGoals",
      (SELECT count(*)::int FROM world_agent_concepts WHERE world_id=$1) AS concepts,
      (SELECT count(*)::int FROM world_agent_concepts WHERE world_id=$1 AND creator_agent_id IS NOT NULL) AS "agentAuthoredConcepts",
      (SELECT count(*)::int FROM world_emergent_entities WHERE world_id=$1 AND status<>'historical') AS "emergentEntities",
      (SELECT count(*)::int FROM world_agent_policy_experiments WHERE world_id=$1) AS "policyExperiments",
      ((SELECT count(*) FROM world_agent_policy_experiments WHERE world_id=$1)
        +(SELECT count(*) FROM world_agent_self_model_history WHERE world_id=$1
          AND reason IN ('evidence_based_identity_interpretation','resident_changed_cognition_preference')))::int AS "selfModifications",
      (SELECT count(*)::int FROM world_extension_requests WHERE world_id=$1 AND status NOT IN ('rejected','historical')) AS "extensionRequests",
      (SELECT count(*)::int FROM world_agent_values WHERE world_id=$1 AND status IN ('active','shared')) AS "activeValues",
      (SELECT count(*)::int FROM world_agent_values WHERE world_id=$1 AND status='shared') AS "sharedValues",
      (SELECT count(*)::int FROM world_agent_principles WHERE world_id=$1 AND status IN ('proposed','active','challenged')) AS "principles",
      (SELECT count(*)::int FROM world_agent_observation_methods WHERE world_id=$1 AND status NOT IN ('historical','declining')) AS "observationMethods",
      (SELECT count(*)::int FROM world_agent_observation_uses WHERE world_id=$1) AS "observationMethodUses",
      (SELECT count(*)::int FROM world_agent_resource_types WHERE world_id=$1 AND status NOT IN ('historical','rejected')) AS "resourceTypes",
      (SELECT count(*)::int FROM world_agent_resource_ledger WHERE world_id=$1) AS "resourceLedgerEntries",
      (SELECT count(*)::int FROM world_coordination_mechanisms WHERE world_id=$1 AND status<>'historical') AS "coordinationMechanisms",
      (SELECT count(*)::int FROM world_coordination_experiments WHERE world_id=$1) AS "coordinationExperiments",
      (SELECT count(*)::int FROM world_coordination_uses WHERE world_id=$1) AS "coordinationUses",
      (SELECT count(*)::int FROM world_agent_meanings WHERE world_id=$1) AS meanings,
      (SELECT count(*)::int FROM world_agent_eras WHERE world_id=$1) AS eras,
      (SELECT count(*)::int FROM world_agent_milestones WHERE world_id=$1 AND status IN ('proposed','active')) AS milestones`, [worldId]),
    client.query(`SELECT agent_id AS "agentId",current_identity_summary AS "identitySummary",self_beliefs AS "selfBeliefs",
      preferred_modes_of_action AS "preferredModesOfAction",important_capabilities AS "importantCapabilities",
      important_relationships AS "importantRelationships",long_term_patterns AS "longTermPatterns",
      unresolved_questions AS "unresolvedQuestions",recent_changes AS "recentChanges",uncertainty,
      preferred_cognition_mode AS "preferredCognitionMode",confidence::text AS confidence,
      last_reflected_world_minute AS "lastReflectedWorldMinute"
      FROM world_agent_self_models WHERE world_id=$1 ORDER BY updated_at DESC LIMIT $2`, [worldId, safeLimit]),
    client.query(`SELECT question.id,question.creator_agent_id AS "creatorAgentId",agent.name AS "creatorName",question.question,
      question.origin,question.status,question.confidence::text AS confidence,question.evidence,
      question.created_world_minute AS "createdWorldMinute",question.updated_world_minute AS "updatedWorldMinute"
      FROM world_agent_questions question JOIN agents agent ON agent.id=question.creator_agent_id
      WHERE question.world_id=$1 ORDER BY question.updated_world_minute DESC,question.id DESC LIMIT $2`, [worldId, safeLimit]),
    client.query(`SELECT concept.id,concept.creator_agent_id AS "creatorAgentId",agent.name AS "creatorName",concept.name,
      concept.description,concept.definition,concept.status,concept.evidence,concept.related_concepts AS "relatedConcepts",
      concept.created_world_minute AS "createdWorldMinute",concept.usage_count AS "usageCount"
      FROM world_agent_concepts concept JOIN agents agent ON agent.id=concept.creator_agent_id
      WHERE concept.world_id=$1 ORDER BY concept.created_world_minute DESC,concept.id DESC LIMIT $2`, [worldId, safeLimit]),
    client.query(`SELECT entity.id,entity.creator_agent_id AS "creatorAgentId",agent.name AS "creatorName",entity.entity_type AS "entityType",
      entity.name,entity.purpose,entity.state,entity.capabilities,entity.resources,entity.internal_rules AS "internalRules",
      entity.status,entity.created_world_minute AS "createdWorldMinute",
      COALESCE((SELECT jsonb_agg(jsonb_build_object('participantType',participant.participant_type,'participantId',participant.participant_id,
        'mode',participant.participation_mode,'status',participant.status) ORDER BY participant.joined_world_minute)
        FROM world_emergent_entity_participants participant WHERE participant.world_id=entity.world_id
          AND participant.entity_id=entity.id),'[]'::jsonb) AS participants
      FROM world_emergent_entities entity JOIN agents agent ON agent.id=entity.creator_agent_id
      WHERE entity.world_id=$1 ORDER BY entity.created_world_minute DESC,entity.id DESC LIMIT $2`, [worldId, safeLimit]),
    client.query(`SELECT id,agent_id AS "agentId",status,reason,before_policy AS "beforePolicy",proposed_policy AS "proposedPolicy",
      started_world_minute AS "startedWorldMinute",ends_world_minute AS "endsWorldMinute",result
      FROM world_agent_policy_experiments WHERE world_id=$1 ORDER BY started_world_minute DESC,id DESC LIMIT $2`, [worldId, safeLimit]),
    client.query(`SELECT id,creator_agent_id AS "creatorAgentId",request_type AS "requestType",title,description,status,evidence,
      created_world_minute AS "createdWorldMinute" FROM world_extension_requests WHERE world_id=$1
      ORDER BY created_world_minute DESC,id DESC LIMIT $2`, [worldId, safeLimit]),
    client.query(`SELECT value.id,value.holder_type AS "holderType",value.holder_id AS "holderId",value.name,value.description,value.origin,
      value.importance::text AS importance,value.confidence::text AS confidence,value.status,
      value.created_world_minute AS "createdWorldMinute",
      (SELECT count(DISTINCT alignment.agent_id)::int FROM world_agent_value_alignments alignment
        WHERE alignment.world_id=value.world_id AND alignment.value_id=value.id AND alignment.decision='support') AS "supportCount"
      FROM world_agent_values value WHERE value.world_id=$1 AND value.status IN ('active','shared')
      ORDER BY value.importance DESC,value.updated_world_minute DESC LIMIT $2`,
    [worldId, safeLimit]),
    client.query(`SELECT id,creator_agent_id AS "creatorAgentId",scope_type AS "scopeType",scope_id AS "scopeId",category,
      statement,status,created_world_minute AS "createdWorldMinute",evidence FROM world_agent_principles WHERE world_id=$1
      ORDER BY created_world_minute DESC,id DESC LIMIT $2`, [worldId, safeLimit]),
    client.query(`SELECT id,creator_agent_id AS "creatorAgentId",name,description,observation_spec AS "observationSpec",
      evidence,status,usage_count AS "usageCount",created_world_minute AS "createdWorldMinute"
      FROM world_agent_observation_methods WHERE world_id=$1 ORDER BY created_world_minute DESC,id DESC LIMIT $2`, [worldId, safeLimit]),
    client.query(`SELECT id,agent_id AS "agentId",subject_type AS "subjectType",subject_id AS "subjectId",interpretation,
      confidence::text AS confidence,created_world_minute AS "createdWorldMinute",updated_world_minute AS "updatedWorldMinute"
      FROM world_agent_meanings WHERE world_id=$1 ORDER BY updated_world_minute DESC,id DESC LIMIT $2`, [worldId, safeLimit]),
    client.query(`SELECT id,agent_id AS "agentId",name,interpretation,starts_world_minute AS "startsWorldMinute",
      ends_world_minute AS "endsWorldMinute",evidence FROM world_agent_eras WHERE world_id=$1
      ORDER BY created_world_minute DESC,id DESC LIMIT $2`, [worldId, safeLimit]),
    client.query(`SELECT id,agent_id AS "agentId",title,success_criteria AS "successCriteria",status,
      created_world_minute AS "createdWorldMinute" FROM world_agent_milestones WHERE world_id=$1
      ORDER BY created_world_minute DESC,id DESC LIMIT $2`, [worldId, safeLimit]),
    client.query(`SELECT id,name,creator_type AS "creatorType",parent_capability_id AS "parentCapabilityId",specification,
      status,usage_count AS "usageCount" FROM world_capabilities WHERE world_id=$1`, [worldId]),
    client.query(`SELECT capability_id AS "capabilityId",depends_on_capability_id AS "dependsOnCapabilityId"
      FROM world_capability_dependencies WHERE world_id=$1`, [worldId]),
    client.query(`SELECT event_type AS "eventType",entity_type AS "entityType",entity_id AS "entityId",world_minute AS "worldMinute",
      actor_agent_id AS "actorAgentId",details FROM world_v7_events WHERE world_id=$1
      ORDER BY world_minute DESC,id DESC LIMIT $2`, [worldId, safeLimit]),
    client.query(`SELECT id,creator_agent_id AS "creatorAgentId",resource_key AS "resourceKey",name,description,unit_name AS "unitName",
      origin_rule AS "originRule",permitted_uses AS "permittedUses",settlement_rule AS "settlementRule",status,
      usage_count AS "usageCount",created_world_minute AS "createdWorldMinute" FROM world_agent_resource_types
      WHERE world_id=$1 ORDER BY created_world_minute DESC,id DESC LIMIT $2`, [worldId, safeLimit]),
    client.query(`SELECT id,resource_type_id AS "resourceTypeId",actor_agent_id AS "actorAgentId",transaction_type AS "transactionType",
      from_holder_type AS "fromHolderType",from_holder_id AS "fromHolderId",to_holder_type AS "toHolderType",
      to_holder_id AS "toHolderId",amount::text AS amount,source,purpose,settlement_rule AS "settlementRule",
      world_minute AS "worldMinute" FROM world_agent_resource_ledger WHERE world_id=$1 ORDER BY world_minute DESC,id DESC LIMIT $2`,
    [worldId, safeLimit]),
    client.query(`SELECT mechanism.id,mechanism.creator_agent_id AS "creatorAgentId",agent.name AS "creatorName",
      mechanism.parent_mechanism_id AS "parentMechanismId",mechanism.mechanism_type AS "mechanismType",mechanism.name,
      mechanism.description,mechanism.specification,mechanism.status,mechanism.usage_count AS "usageCount",
      mechanism.created_world_minute AS "createdWorldMinute",
      COALESCE(jsonb_agg(jsonb_build_object('id',experiment.id,'status',experiment.status,'hypothesis',experiment.hypothesis,
        'evaluation',experiment.evaluation,'startedWorldMinute',experiment.started_world_minute)
        ORDER BY experiment.started_world_minute) FILTER (WHERE experiment.id IS NOT NULL),'[]'::jsonb) AS experiments
      FROM world_coordination_mechanisms mechanism JOIN agents agent ON agent.id=mechanism.creator_agent_id
      LEFT JOIN world_coordination_experiments experiment ON experiment.world_id=mechanism.world_id
        AND experiment.mechanism_id=mechanism.id WHERE mechanism.world_id=$1
      GROUP BY mechanism.id,agent.name ORDER BY mechanism.created_world_minute DESC,mechanism.id DESC LIMIT $2`, [worldId, safeLimit]),
    client.query(`SELECT use.id,use.mechanism_id AS "mechanismId",mechanism.name AS "mechanismName",use.experiment_id AS "experimentId",
      use.actor_agent_id AS "actorAgentId",use.participants,use.result,use.evidence,use.world_minute AS "worldMinute"
      FROM world_coordination_uses use JOIN world_coordination_mechanisms mechanism
        ON mechanism.world_id=use.world_id AND mechanism.id=use.mechanism_id WHERE use.world_id=$1
      ORDER BY use.world_minute DESC,use.id DESC LIMIT $2`, [worldId, safeLimit]),
    client.query(`SELECT use.id,use.method_id AS "methodId",method.name AS "methodName",use.actor_agent_id AS "actorAgentId",
      use.observation,use.evidence,use.world_minute AS "worldMinute" FROM world_agent_observation_uses use
      JOIN world_agent_observation_methods method ON method.world_id=use.world_id AND method.id=use.method_id
      WHERE use.world_id=$1 ORDER BY use.world_minute DESC,use.id DESC LIMIT $2`, [worldId, safeLimit])
  ]);
  const countRow = counts.rows[0] || {};
  const conceptTotal = Number(countRow.concepts) || 0;
  const [capabilityUseRatio, generatedGoals, entityRatio, coordRatio, developerDependencyRatio, policyUsage,
    agentResourceRatio] = await Promise.all([
    client.query(`SELECT count(*) FILTER (WHERE capability.creator_type IN ('resident','organization'))::numeric /
        greatest(count(*),1) AS value FROM world_capability_uses use JOIN world_capabilities capability
        ON capability.world_id=use.world_id AND capability.id=use.capability_id WHERE use.world_id=$1`, [worldId]),
    client.query(`SELECT count(*) FILTER (WHERE source='self_generated' AND metadata ? 'goalGrammar')::numeric/greatest(count(*),1) AS value
        FROM world_agent_goals WHERE world_id=$1`, [worldId]),
    client.query(`SELECT count(*) FILTER (WHERE status<>'historical' AND creator_agent_id IS NOT NULL)::numeric/
        greatest(count(*) FILTER (WHERE status<>'historical')+(SELECT count(*) FROM world_organizations
          WHERE world_id=$1 AND status='active'),1) AS value
        FROM world_emergent_entities WHERE world_id=$1`, [worldId]),
    client.query(`SELECT count(*)::numeric/greatest(count(*),1) AS value FROM world_coordination_mechanisms
        WHERE world_id=$1 AND status<>'historical'`, [worldId]),
    client.query(`SELECT count(*) FILTER (WHERE dependency.creator_type='system')::numeric/greatest(count(*),1) AS value
        FROM world_capability_dependencies edge JOIN world_capabilities dependency
        ON dependency.world_id=edge.world_id AND dependency.id=edge.depends_on_capability_id WHERE edge.world_id=$1`, [worldId]),
    client.query(`SELECT count(*) FILTER (WHERE decision_policy_source='self_modified')::numeric/greatest(count(*),1) AS value
        FROM world_decision_traces WHERE world_id=$1`, [worldId]),
    client.query(`SELECT count(*) FILTER (WHERE creator_agent_id IS NOT NULL)::numeric/greatest(count(*),1) AS value
        FROM world_agent_resource_types WHERE world_id=$1`, [worldId])
  ]);
  const genealogy = capabilityGraphDepth(capabilities.rows, dependencyEdges.rows);
  const maximumDepth = Math.max(0, ...genealogy.map((item) => item.depth));
  const agentAuthoredCapabilities = capabilities.rows.filter((item) => ['resident','organization'].includes(item.creatorType)).length;
  return {
    counts: { ...countRow, capabilityForks: capabilities.rows.filter((item) => item.parentCapabilityId).length,
      capabilityExtinctions: capabilities.rows.filter((item) => ['deprecated','historical'].includes(item.status)).length },
    selfModels: selfModels.rows, questions: questions.rows, concepts: concepts.rows, entities: entities.rows,
    policyExperiments: experiments.rows, extensionRequests: extensions.rows, values: values.rows,
    principles: principles.rows, observationMethods: observationMethods.rows, meanings: meanings.rows,
    resourceTypes: resourceTypes.rows, resourceLedger: resourceLedger.rows,
    coordinationMechanisms: coordinationMechanisms.rows, coordinationUses: coordinationUses.rows, observationUses: observationUses.rows,
    eras: eras.rows, milestones: milestones.rows, events: events.rows,
    genealogy: genealogy.slice(0, safeLimit), metrics: {
      agentCreatedCapabilityRatio: agentAuthoredCapabilities / Math.max(1, capabilities.rowCount),
      agentCreatedActionUsageRatio: Number(capabilityUseRatio.rows[0]?.value) || 0,
      agentGeneratedGoalRatio: Number(generatedGoals.rows[0]?.value) || 0,
      agentCreatedEntityRatio: Number(entityRatio.rows[0]?.value) || 0,
      agentCreatedCoordinationRatio: Number(coordRatio.rows[0]?.value) || 0,
      agentCreatedResourceTypeRatio: Number(agentResourceRatio.rows[0]?.value) || 0,
      agentCreatedConceptRatio: conceptTotal ? Number(countRow.agentAuthoredConcepts) / conceptTotal : 0,
      developerSeededDependencyRatio: Number(developerDependencyRatio.rows[0]?.value) || 0,
      selfModifiedPolicyUsage: Number(policyUsage.rows[0]?.value) || 0,
      capabilityDependencyDepth: maximumDepth,
      capabilityDependencyCycles: genealogy.filter((item) => item.cyclic).length,
      secondOrderCapabilities: genealogy.filter((item) => item.depth >= 2 && item.creatorType !== 'system').length,
      thirdOrderPotential: maximumDepth >= 3
    }
  };
}

export async function createWorldValue(client, { worldId, agentId, name, description, origin, importance,
  evidence = {}, confidence = 0.5, worldMinute, actionId }) {
  await requireWorldMember(client, worldId, agentId);
  const idempotency = actionIdentifier(actionId);
  const result = await client.query(`INSERT INTO world_agent_values(world_id,holder_type,holder_id,name,description,origin,
      importance,evidence,confidence,created_world_minute,updated_world_minute,action_id)
    VALUES($1,'agent',$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$9,$10) ON CONFLICT DO NOTHING RETURNING *`,
  [worldId, agentId, requiredText(name, 2, 100, 'value_name'), requiredText(description, 3, 600, 'value_description'),
    requiredText(origin, 3, 160, 'value_origin'), boundedNumber(importance, 0, 1, 'value_importance'),
    JSON.stringify(boundedJson(evidence, 'value_evidence')), boundedNumber(confidence, 0, 1, 'value_confidence'), worldMinute, idempotency]);
  if (result.rowCount) await recordV7Event(client, { worldId, actorAgentId: agentId, eventType: 'value.formed', entityType: 'value',
    entityId: result.rows[0].id, worldMinute, actionId: `value-created:${idempotency}`, details: { name } });
  return result.rows[0] || null;
}

export async function createWorldPrinciple(client, { worldId, agentId, scopeId = agentId, category = 'social', statement,
  evidence = {}, worldMinute, actionId }) {
  await requireWorldMember(client, worldId, agentId);
  const idempotency = actionIdentifier(actionId);
  const result = await client.query(`INSERT INTO world_agent_principles(world_id,creator_agent_id,scope_type,scope_id,category,
      statement,evidence,created_world_minute,action_id) VALUES($1,$2,'agent',$3,$4,$5,$6::jsonb,$7,$8)
    ON CONFLICT(world_id,creator_agent_id,action_id) DO NOTHING RETURNING *`,
  [worldId, agentId, String(scopeId), cleanKey(category, 'principle_category'), requiredText(statement, 8, 800, 'principle_statement'),
    JSON.stringify(boundedJson(evidence, 'principle_evidence')), worldMinute, idempotency]);
  if (result.rowCount) await recordV7Event(client, { worldId, actorAgentId: agentId, eventType: 'principle.proposed',
    entityType: 'world_principle', entityId: result.rows[0].id, worldMinute, actionId: `principle-created:${idempotency}`, details: { category } });
  return result.rows[0] || null;
}

export async function createObservationMethod(client, { worldId, agentId, name, description, observationSpec,
  evidence = {}, worldMinute, actionId }) {
  await requireWorldMember(client, worldId, agentId);
  const idempotency = actionIdentifier(actionId);
  const result = await client.query(`INSERT INTO world_agent_observation_methods(world_id,creator_agent_id,name,description,
      observation_spec,evidence,created_world_minute,action_id) VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8)
    ON CONFLICT(world_id,creator_agent_id,action_id) DO NOTHING RETURNING *`,
  [worldId, agentId, requiredText(name, 2, 100, 'observation_name'), requiredText(description, 5, 600, 'observation_description'),
    JSON.stringify(boundedJson(observationSpec, 'observation_spec')), JSON.stringify(boundedJson(evidence, 'observation_evidence')),
    worldMinute, idempotency]);
  if (result.rowCount) await recordV7Event(client, { worldId, actorAgentId: agentId, eventType: 'observation_method.proposed',
    entityType: 'observation_method', entityId: result.rows[0].id, worldMinute, actionId: `observation-method:${idempotency}`, details: {} });
  return result.rows[0] || null;
}

export async function decideObservationMethod(client, { worldId, agentId, methodId, decision, worldMinute, actionId }) {
  await requireWorldMember(client, worldId, agentId);
  const transitions = { experiment: ['proposed', 'experimental'], share: ['experimental', 'shared'],
    activate: ['shared', 'active'], decline: ['experimental', 'declining'], retire: ['active', 'historical'] };
  if (!Object.hasOwn(transitions, decision)) throw worldError('OBSERVATION_METHOD_DECISION_INVALID', 400);
  const receipt = await readV7DecisionReceipt(client, { worldId, agentId, actionId, actionPrefix: 'observation-method-decision',
    eventType: `observation_method.${decision}`, entityId: methodId });
  if (receipt) return { id: methodId, status: transitions[decision][1], idempotent: true };
  const method = await client.query(`SELECT * FROM world_agent_observation_methods
    WHERE world_id=$1 AND id=$2 AND creator_agent_id=$3 FOR UPDATE`, [worldId, methodId, agentId]);
  if (!method.rowCount || method.rows[0].status !== transitions[decision][0]) {
    throw worldError('OBSERVATION_METHOD_TRANSITION_INVALID', 409);
  }
  if (['share', 'activate'].includes(decision) && Number(method.rows[0].usage_count) < 1) {
    throw worldError('OBSERVATION_METHOD_EVIDENCE_REQUIRED', 409);
  }
  const status = transitions[decision][1];
  await client.query(`UPDATE world_agent_observation_methods SET status=$3 WHERE world_id=$1 AND id=$2`, [worldId, methodId, status]);
  await recordV7Event(client, { worldId, actorAgentId: agentId, eventType: `observation_method.${decision}`,
    entityType: 'observation_method', entityId: methodId, worldMinute,
    actionId: `observation-method-decision:${actionIdentifier(actionId)}`, details: { status } });
  return { id: methodId, status };
}

export async function useObservationMethod(client, { worldId, agentId, methodId, observation, evidence = {}, worldMinute, actionId }) {
  await requireWorldMember(client, worldId, agentId);
  const idempotency = actionIdentifier(actionId);
  const receipt = await client.query(`SELECT id,method_id AS "methodId",observation,world_minute AS "worldMinute"
    FROM world_agent_observation_uses WHERE world_id=$1 AND actor_agent_id=$2 AND action_id=$3`, [worldId, agentId, idempotency]);
  if (receipt.rowCount) {
    if (receipt.rows[0].methodId !== methodId) throw worldError('ACTION_ID_CONFLICT', 409);
    return { ...receipt.rows[0], idempotent: true };
  }
  const method = await client.query(`SELECT status FROM world_agent_observation_methods WHERE world_id=$1 AND id=$2 FOR UPDATE`,
    [worldId, methodId]);
  if (!method.rowCount || !['experimental', 'shared', 'active'].includes(method.rows[0].status)) {
    throw worldError('OBSERVATION_METHOD_NOT_AVAILABLE', 409);
  }
  const result = await client.query(`INSERT INTO world_agent_observation_uses(world_id,method_id,actor_agent_id,observation,evidence,
      world_minute,action_id) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7) RETURNING id,method_id AS "methodId",observation,
      world_minute AS "worldMinute"`, [worldId, methodId, agentId, requiredText(observation, 3, 800, 'observation_result'),
    JSON.stringify(boundedJson(evidence, 'observation_evidence')), worldMinute, idempotency]);
  await client.query(`UPDATE world_agent_observation_methods SET usage_count=usage_count+1 WHERE world_id=$1 AND id=$2`, [worldId, methodId]);
  await recordV7Event(client, { worldId, actorAgentId: agentId, eventType: 'observation_method.used', entityType: 'observation_method',
    entityId: methodId, worldMinute, actionId: `observation-use:${idempotency}`, details: { useId: result.rows[0].id } });
  return result.rows[0];
}

export async function exposeWorldValue(client, { worldId, agentId, valueId, recipientAgentId, context, evidence = {}, worldMinute, actionId }) {
  await requireWorldMember(client, worldId, agentId);
  await requireWorldMember(client, worldId, recipientAgentId);
  if (agentId === recipientAgentId) throw worldError('VALUE_RECIPIENT_INVALID', 400);
  const value = await client.query(`SELECT id FROM world_agent_values WHERE world_id=$1 AND id=$2
    AND holder_type='agent' AND holder_id=$3 AND status IN ('active','shared')`, [worldId, valueId, agentId]);
  if (!value.rowCount) throw worldError('VALUE_NOT_OWNED_OR_ACTIVE', 409);
  const idempotency = actionIdentifier(actionId);
  const result = await client.query(`INSERT INTO world_agent_value_exposures(world_id,value_id,sender_agent_id,recipient_agent_id,
      context,evidence,world_minute,action_id) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8)
      ON CONFLICT(world_id,sender_agent_id,action_id) DO NOTHING RETURNING id,value_id AS "valueId",
        recipient_agent_id AS "recipientAgentId",context,world_minute AS "worldMinute"`,
  [worldId, valueId, agentId, recipientAgentId, requiredText(context, 3, 240, 'value_exposure_context'),
    JSON.stringify(boundedJson(evidence, 'value_exposure_evidence')), worldMinute, idempotency]);
  const exposure = result.rows[0] || (await client.query(`SELECT id,value_id AS "valueId",recipient_agent_id AS "recipientAgentId",
      context,world_minute AS "worldMinute" FROM world_agent_value_exposures WHERE world_id=$1 AND sender_agent_id=$2 AND action_id=$3`,
  [worldId, agentId, idempotency])).rows[0];
  if (exposure.valueId !== valueId || exposure.recipientAgentId !== recipientAgentId) throw worldError('ACTION_ID_CONFLICT', 409);
  if (result.rowCount) await recordV7Event(client, { worldId, actorAgentId: agentId, eventType: 'value.exposed', entityType: 'value',
    entityId: valueId, worldMinute, actionId: `value-exposure:${idempotency}`, details: { exposureId: exposure.id, recipientAgentId } });
  return exposure;
}

export async function alignWorldValue(client, { worldId, agentId, valueId, exposureId, decision, evidence = {}, worldMinute, actionId }) {
  await requireWorldMember(client, worldId, agentId);
  if (!['support', 'challenge', 'withdraw'].includes(decision)) throw worldError('VALUE_ALIGNMENT_INVALID', 400);
  const exposure = await client.query(`SELECT id FROM world_agent_value_exposures WHERE world_id=$1 AND id=$2
    AND value_id=$3 AND recipient_agent_id=$4`, [worldId, exposureId, valueId, agentId]);
  if (!exposure.rowCount) throw worldError('VALUE_EXPOSURE_REQUIRED', 409);
  const idempotency = actionIdentifier(actionId);
  const result = await client.query(`INSERT INTO world_agent_value_alignments(world_id,value_id,agent_id,exposure_id,decision,evidence,
      world_minute,action_id) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8) ON CONFLICT(world_id,agent_id,action_id) DO NOTHING
      RETURNING id,value_id AS "valueId",exposure_id AS "exposureId",decision,world_minute AS "worldMinute"`,
  [worldId, valueId, agentId, exposureId, decision, JSON.stringify(boundedJson(evidence, 'value_alignment_evidence')), worldMinute, idempotency]);
  const alignment = result.rows[0] || (await client.query(`SELECT id,value_id AS "valueId",exposure_id AS "exposureId",decision,
      world_minute AS "worldMinute"
    FROM world_agent_value_alignments WHERE world_id=$1 AND agent_id=$2 AND action_id=$3`, [worldId, agentId, idempotency])).rows[0];
  if (alignment.valueId !== valueId || alignment.decision !== decision || alignment.exposureId !== exposureId) {
    throw worldError('ACTION_ID_CONFLICT', 409);
  }
  const support = await client.query(`SELECT count(*)::int AS count FROM (
      SELECT DISTINCT ON (agent_id) agent_id,decision FROM world_agent_value_alignments
      WHERE world_id=$1 AND value_id=$2 ORDER BY agent_id,world_minute DESC,id DESC
    ) latest WHERE decision='support' AND agent_id<>$3`, [worldId, valueId,
    (await client.query(`SELECT holder_id FROM world_agent_values WHERE world_id=$1 AND id=$2 AND holder_type='agent'`, [worldId, valueId])).rows[0]?.holder_id]);
  const shared = Number(support.rows[0]?.count) >= 1;
  await client.query(`UPDATE world_agent_values SET status=CASE WHEN status IN ('active','shared') THEN $3 ELSE status END,
      updated_world_minute=$4 WHERE world_id=$1 AND id=$2`, [worldId, valueId, shared ? 'shared' : 'active', worldMinute]);
  if (result.rowCount) await recordV7Event(client, { worldId, actorAgentId: agentId, eventType: `value.${decision}`,
    entityType: 'value', entityId: valueId, worldMinute, actionId: `value-alignment:${idempotency}`,
    details: { exposureId, currentExternalSupporters: Number(support.rows[0]?.count) || 0, shared } });
  return { ...alignment, status: shared ? 'shared' : 'active', idempotent: !result.rowCount };
}

function resourceAmount(value) {
  const amount = typeof value === 'string' ? value.trim() : String(value);
  if (!/^(?:0|[1-9][0-9]{0,21})(?:\.[0-9]{1,8})?$/.test(amount) || /^0(?:\.0{1,8})?$/.test(amount)) {
    throw worldError('RESOURCE_AMOUNT_INVALID', 400);
  }
  const [whole, fraction = ''] = amount.split('.');
  const trimmedFraction = fraction.replace(/0+$/, '');
  return trimmedFraction ? `${whole}.${trimmedFraction}` : whole;
}

async function assertResourceHolder(client, worldId, holderType, holderId) {
  if (holderType === 'agent') {
    await requireWorldMember(client, worldId, holderId);
    return { creatorAgentId: holderId };
  }
  const registered = await client.query(`SELECT creator_agent_id AS "creatorAgentId" FROM world_agent_resource_holders
    WHERE world_id=$1 AND holder_type=$2 AND holder_id=$3`, [worldId, holderType, holderId]);
  if (registered.rowCount) return registered.rows[0];
  const known = {
    emergent_entity: ['world_emergent_entities', 'id'], organization: ['world_organizations', 'id'],
    project: ['world_projects', 'id'], place: ['world_scenes', 'id'], capability: ['world_capabilities', 'id']
  }[holderType];
  if (!known) throw worldError('RESOURCE_HOLDER_NOT_REGISTERED', 409);
  const exists = await client.query(`SELECT 1 FROM ${known[0]} WHERE world_id=$1 AND ${known[1]}=$2`, [worldId, holderId]);
  if (!exists.rowCount) throw worldError('RESOURCE_HOLDER_NOT_FOUND', 404);
  return { creatorAgentId: null };
}

export async function registerWorldAgentResourceHolder(client, { worldId, agentId, resourceTypeId, holderType, holderId, label,
  evidence = {}, worldMinute, actionId }) {
  await requireWorldMember(client, worldId, agentId);
  const resource = await client.query(`SELECT 1 FROM world_agent_resource_types WHERE world_id=$1 AND id=$2`, [worldId, resourceTypeId]);
  if (!resource.rowCount) throw worldError('RESOURCE_TYPE_NOT_FOUND', 404);
  const type = cleanKey(holderType, 'resource_holder_type');
  const id = requiredText(String(holderId), 1, 160, 'resource_holder_id');
  if (type === 'agent' && id !== agentId) throw worldError('RESOURCE_HOLDER_NOT_OWNED', 403);
  const ownershipQuery = {
    emergent_entity: `SELECT EXISTS(SELECT 1 FROM world_emergent_entities WHERE world_id=$1 AND id=$2 AND creator_agent_id=$3)
      OR EXISTS(SELECT 1 FROM world_emergent_entity_participants WHERE world_id=$1 AND entity_id=$2
        AND participant_type='agent' AND participant_id=$3 AND status='active') AS allowed`,
    organization: `SELECT EXISTS(SELECT 1 FROM world_organizations WHERE world_id=$1 AND id=$2 AND founder_agent_id=$3)
      OR EXISTS(SELECT 1 FROM world_organization_members WHERE world_id=$1 AND organization_id=$2
        AND agent_id=$3 AND status='active') AS allowed`,
    project: `SELECT EXISTS(SELECT 1 FROM world_projects WHERE world_id=$1 AND id=$2 AND creator_agent_id=$3) AS allowed`,
    place: `SELECT EXISTS(SELECT 1 FROM world_scenes WHERE world_id=$1 AND id=$2 AND created_by=$3) AS allowed`,
    capability: `SELECT EXISTS(SELECT 1 FROM world_capabilities WHERE world_id=$1 AND id=$2 AND creator_agent_id=$3) AS allowed`
  }[type];
  if (ownershipQuery) {
    const ownership = await client.query(ownershipQuery, [worldId, id, agentId]);
    if (!ownership.rows[0]?.allowed) throw worldError('RESOURCE_HOLDER_NOT_OWNED', 403);
  }
  await assertResourceHolder(client, worldId, type, id);
  const idempotency = actionIdentifier(actionId);
  const result = await client.query(`INSERT INTO world_agent_resource_holders(world_id,holder_type,holder_id,creator_agent_id,
      label,evidence,action_id,created_world_minute) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8)
      ON CONFLICT DO NOTHING RETURNING id,holder_type AS "holderType",holder_id AS "holderId",label,
        creator_agent_id AS "creatorAgentId",action_id AS "actionId"`,
  [worldId, type, id, agentId, requiredText(label, 2, 120, 'resource_holder_label'),
    JSON.stringify(boundedJson(evidence, 'resource_holder_evidence')), idempotency, worldMinute]);
  const holder = result.rows[0] || (await client.query(`SELECT id,holder_type AS "holderType",holder_id AS "holderId",label,
      creator_agent_id AS "creatorAgentId",action_id AS "actionId" FROM world_agent_resource_holders
      WHERE world_id=$1 AND holder_type=$2 AND holder_id=$3`, [worldId, type, id])).rows[0];
  if (holder.creatorAgentId !== agentId || holder.actionId !== idempotency) throw worldError('RESOURCE_HOLDER_ALREADY_REGISTERED', 409);
  if (result.rowCount) await recordV7Event(client, { worldId, actorAgentId: agentId, eventType: 'resource.holder_registered',
    entityType: 'resource_holder', entityId: holder.id, worldMinute, actionId: `resource-holder:${idempotency}`, details: { type, id } });
  return holder;
}

export async function createWorldResourceType(client, { worldId, agentId, resourceKey, name, description, unitName,
  originRule, permittedUses = [], settlementRule, evidence = {}, worldMinute, actionId }) {
  await requireWorldMember(client, worldId, agentId);
  if (!Array.isArray(permittedUses) || permittedUses.length < 1 || permittedUses.length > 32) throw worldError('RESOURCE_USES_INVALID', 400);
  const normalizedOriginRule = boundedJson(originRule, 'resource_origin_rule');
  const normalizedSettlementRule = boundedJson(settlementRule, 'resource_settlement_rule');
  if (!Object.keys(normalizedOriginRule).length || !Object.keys(normalizedSettlementRule).length) {
    throw worldError('RESOURCE_RULE_REQUIRED', 400);
  }
  requiredText(normalizedSettlementRule.description || normalizedSettlementRule.rule || normalizedSettlementRule.statement || '',
    3, 240, 'resource_settlement_rule_text');
  const idempotency = actionIdentifier(actionId);
  const key = cleanKey(resourceKey, 'resource_key');
  const result = await client.query(`INSERT INTO world_agent_resource_types(world_id,creator_agent_id,resource_key,name,description,
      unit_name,origin_rule,permitted_uses,settlement_rule,evidence,created_world_minute,action_id)
    VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb,$10::jsonb,$11,$12)
    ON CONFLICT DO NOTHING RETURNING id,resource_key AS "resourceKey",name,status,created_world_minute AS "createdWorldMinute",
      creator_agent_id AS "creatorAgentId",action_id AS "actionId"`,
  [worldId, agentId, key, requiredText(name, 2, 100, 'resource_name'), requiredText(description, 5, 600, 'resource_description'),
    requiredText(unitName, 1, 40, 'resource_unit_name'), JSON.stringify(normalizedOriginRule),
    JSON.stringify(permittedUses.map((item) => requiredText(item, 3, 240, 'permitted_use'))), JSON.stringify(normalizedSettlementRule),
    JSON.stringify(boundedJson(evidence, 'resource_evidence')), worldMinute, idempotency]);
  const resource = result.rows[0] || (await client.query(`SELECT id,resource_key AS "resourceKey",name,status,
      created_world_minute AS "createdWorldMinute",creator_agent_id AS "creatorAgentId",action_id AS "actionId"
    FROM world_agent_resource_types WHERE world_id=$1 AND resource_key=$2`, [worldId, key])).rows[0];
  if (resource.creatorAgentId !== agentId || resource.actionId !== idempotency) throw worldError('RESOURCE_KEY_EXISTS', 409);
  if (result.rowCount) await recordV7Event(client, { worldId, actorAgentId: agentId, eventType: 'resource.type_proposed',
    entityType: 'resource_type', entityId: resource.id, worldMinute, actionId: `resource-type:${idempotency}`, details: { key } });
  return resource;
}

export async function decideWorldResourceType(client, { worldId, agentId, resourceTypeId, decision, evidence = {}, worldMinute, actionId }) {
  await requireWorldMember(client, worldId, agentId);
  const transitions = { experiment: ['proposed', 'experimental'], activate: ['experimental', 'active'],
    reject: [['proposed', 'experimental'], 'rejected'], retire: [['active', 'declining'], 'historical'] };
  if (!Object.hasOwn(transitions, decision)) throw worldError('RESOURCE_DECISION_INVALID', 400);
  const receipt = await readV7DecisionReceipt(client, { worldId, agentId, actionId, actionPrefix: 'resource-decision',
    eventType: `resource.type_${decision}`, entityId: resourceTypeId });
  if (receipt) return { id: resourceTypeId, status: receipt.details.status, idempotent: true };
  const resource = await client.query(`SELECT * FROM world_agent_resource_types WHERE world_id=$1 AND id=$2 AND creator_agent_id=$3 FOR UPDATE`,
    [worldId, resourceTypeId, agentId]);
  const row = resource.rows[0];
  if (!row) throw worldError('RESOURCE_TYPE_NOT_FOUND', 404);
  const [from, to] = transitions[decision];
  if (!(Array.isArray(from) ? from.includes(row.status) : row.status === from)) throw worldError('RESOURCE_TRANSITION_INVALID', 409);
  if (decision === 'activate' && Number(row.usage_count) < 1) throw worldError('RESOURCE_EVIDENCE_REQUIRED', 409);
  const status = to;
  await client.query(`UPDATE world_agent_resource_types SET status=$3,evidence=evidence||$4::jsonb,updated_at=now()
    WHERE world_id=$1 AND id=$2`, [worldId, resourceTypeId, status, JSON.stringify(boundedJson(evidence, 'resource_decision_evidence'))]);
  await recordV7Event(client, { worldId, actorAgentId: agentId, eventType: `resource.type_${decision}`, entityType: 'resource_type',
    entityId: resourceTypeId, worldMinute, actionId: `resource-decision:${actionIdentifier(actionId)}`, details: { status } });
  return { id: resourceTypeId, status };
}

export async function recordWorldResourceTransaction(client, { worldId, agentId, resourceTypeId, transactionType,
  fromHolderType, fromHolderId, toHolderType, toHolderId, amount, source, purpose, settlementRule, evidence = {}, worldMinute, actionId }) {
  await requireWorldMember(client, worldId, agentId);
  if (!['issue', 'transfer', 'settle'].includes(transactionType)) throw worldError('RESOURCE_TRANSACTION_INVALID', 400);
  const type = cleanKey(fromHolderType, 'resource_from_holder_type');
  const destType = cleanKey(toHolderType, 'resource_to_holder_type');
  const fromId = requiredText(String(fromHolderId), 1, 160, 'resource_from_holder_id');
  const toId = requiredText(String(toHolderId), 1, 160, 'resource_to_holder_id');
  const units = resourceAmount(amount);
  const normalizedSource = requiredText(source, 3, 240, 'resource_source');
  const normalizedPurpose = requiredText(purpose, 3, 240, 'resource_purpose');
  const normalizedSettlementRule = requiredText(settlementRule, 3, 240, 'resource_settlement_rule');
  const idempotency = actionIdentifier(actionId);
  const duplicate = await client.query(`SELECT id,resource_type_id AS "resourceTypeId",transaction_type AS "transactionType",
      from_holder_type AS "fromHolderType",from_holder_id AS "fromHolderId",to_holder_type AS "toHolderType",
      to_holder_id AS "toHolderId",amount::text,source,purpose,settlement_rule AS "settlementRule"
    FROM world_agent_resource_ledger WHERE world_id=$1 AND actor_agent_id=$2 AND action_id=$3`, [worldId, agentId, idempotency]);
  const expected = { resourceTypeId, transactionType, fromHolderType: type, fromHolderId: fromId, toHolderType: destType,
    toHolderId: toId, amount: units, source: normalizedSource, purpose: normalizedPurpose, settlementRule: normalizedSettlementRule };
  if (duplicate.rowCount) {
    const prior = duplicate.rows[0];
    if (Object.entries(expected).some(([key, value]) => key === 'amount'
      ? resourceAmount(prior[key]) !== String(value) : String(prior[key]) !== String(value))) throw worldError('ACTION_ID_CONFLICT', 409);
    return { ...prior, idempotent: true };
  }
  const resource = await client.query(`SELECT * FROM world_agent_resource_types WHERE world_id=$1 AND id=$2 FOR UPDATE`, [worldId, resourceTypeId]);
  if (!resource.rowCount || !['experimental', 'active'].includes(resource.rows[0].status)) throw worldError('RESOURCE_TYPE_NOT_AVAILABLE', 409);
  const resourceRow = resource.rows[0];
  if (!resourceRow.permitted_uses.some((permitted) => String(permitted).toLowerCase() === normalizedPurpose.toLowerCase())) {
    throw worldError('RESOURCE_PURPOSE_NOT_PERMITTED', 409);
  }
  const declaredSettlementRule = resourceRow.settlement_rule.description || resourceRow.settlement_rule.rule
    || resourceRow.settlement_rule.statement;
  if (String(declaredSettlementRule || '') !== normalizedSettlementRule) {
    throw worldError('RESOURCE_SETTLEMENT_RULE_MISMATCH', 409);
  }
  if (transactionType === 'issue') {
    if (resourceRow.creator_agent_id !== agentId || type !== 'origin'
        || !Object.keys(boundedJson(evidence, 'resource_evidence')).length) throw worldError('RESOURCE_ISSUANCE_NOT_AUTHORIZED', 403);
  } else {
    const sourceHolder = await assertResourceHolder(client, worldId, type, fromId);
    const actorControlsSource = type === 'agent' ? fromId === agentId : sourceHolder.creatorAgentId === agentId;
    if (!actorControlsSource) throw worldError('RESOURCE_SOURCE_NOT_CONTROLLED', 403);
    const balance = await client.query(`SELECT COALESCE(sum(CASE
        WHEN from_holder_type=$3 AND from_holder_id=$4 THEN -amount
        WHEN to_holder_type=$3 AND to_holder_id=$4 THEN amount ELSE 0 END),0)::numeric >= $5::numeric AS sufficient
      FROM world_agent_resource_ledger WHERE world_id=$1 AND resource_type_id=$2`, [worldId, resourceTypeId, type, fromId, units]);
    if (!balance.rows[0].sufficient) throw worldError('RESOURCE_BALANCE_INSUFFICIENT', 409);
  }
  if (transactionType !== 'settle') await assertResourceHolder(client, worldId, destType, toId);
  const result = await client.query(`INSERT INTO world_agent_resource_ledger(world_id,resource_type_id,actor_agent_id,transaction_type,
      from_holder_type,from_holder_id,to_holder_type,to_holder_id,amount,source,purpose,settlement_rule,evidence,world_minute,action_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::numeric,$10,$11,$12,$13::jsonb,$14,$15)
    RETURNING id,resource_type_id AS "resourceTypeId",transaction_type AS "transactionType",amount::text,
      from_holder_type AS "fromHolderType",from_holder_id AS "fromHolderId",to_holder_type AS "toHolderType",
      to_holder_id AS "toHolderId",world_minute AS "worldMinute"`, [worldId, resourceTypeId, agentId, transactionType, type,
    fromId, destType, toId, units, expected.source, expected.purpose, expected.settlementRule,
    JSON.stringify(boundedJson(evidence, 'resource_evidence')), worldMinute, idempotency]);
  await client.query(`UPDATE world_agent_resource_types SET usage_count=usage_count+1,updated_at=now() WHERE world_id=$1 AND id=$2`,
    [worldId, resourceTypeId]);
  await recordV7Event(client, { worldId, actorAgentId: agentId, eventType: `resource.${transactionType}`,
    entityType: 'resource_type', entityId: resourceTypeId, worldMinute, actionId: `resource-ledger:${idempotency}`,
    details: { ledgerId: result.rows[0].id, amount: units, source: expected.source, purpose: expected.purpose } });
  return result.rows[0];
}

export async function createCoordinationMechanism(client, { worldId, agentId, parentMechanismId = null, mechanismType,
  name, description, specification, evidence = {}, worldMinute, actionId }) {
  await requireWorldMember(client, worldId, agentId);
  if (parentMechanismId) {
    const parent = await client.query(`SELECT 1 FROM world_coordination_mechanisms WHERE world_id=$1 AND id=$2`, [worldId, parentMechanismId]);
    if (!parent.rowCount) throw worldError('COORDINATION_PARENT_NOT_FOUND', 404);
  }
  const idempotency = actionIdentifier(actionId);
  const result = await client.query(`INSERT INTO world_coordination_mechanisms(world_id,creator_agent_id,parent_mechanism_id,
      mechanism_type,name,description,specification,evidence,created_world_minute,action_id)
    VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10) ON CONFLICT(world_id,creator_agent_id,action_id) DO NOTHING
    RETURNING id,mechanism_type AS "mechanismType",name,status,parent_mechanism_id AS "parentMechanismId"`,
  [worldId, agentId, parentMechanismId, cleanKey(mechanismType, 'coordination_type'), requiredText(name, 2, 120, 'coordination_name'),
    requiredText(description, 8, 800, 'coordination_description'), JSON.stringify(boundedJson(specification, 'coordination_specification')),
    JSON.stringify(boundedJson(evidence, 'coordination_evidence')), worldMinute, idempotency]);
  const mechanism = result.rows[0] || (await client.query(`SELECT id,mechanism_type AS "mechanismType",name,status,
      parent_mechanism_id AS "parentMechanismId",creator_agent_id AS "creatorAgentId",action_id AS "actionId"
    FROM world_coordination_mechanisms WHERE world_id=$1 AND creator_agent_id=$2 AND action_id=$3`, [worldId, agentId, idempotency])).rows[0];
  if (mechanism.creatorAgentId && (mechanism.creatorAgentId !== agentId || mechanism.actionId !== idempotency)) throw worldError('ACTION_ID_CONFLICT', 409);
  if (result.rowCount) await recordV7Event(client, { worldId, actorAgentId: agentId, eventType: 'coordination.proposed',
    entityType: 'coordination_mechanism', entityId: mechanism.id, worldMinute, actionId: `coordination-proposed:${idempotency}`,
    details: { mechanismType } });
  return mechanism;
}

export async function startCoordinationExperiment(client, { worldId, agentId, mechanismId, hypothesis, worldMinute, actionId }) {
  await requireWorldMember(client, worldId, agentId);
  const idempotency = actionIdentifier(actionId);
  const old = await client.query(`SELECT id,mechanism_id AS "mechanismId",status FROM world_coordination_experiments
    WHERE world_id=$1 AND creator_agent_id=$2 AND action_id=$3`, [worldId, agentId, idempotency]);
  if (old.rowCount) {
    if (old.rows[0].mechanismId !== mechanismId) throw worldError('ACTION_ID_CONFLICT', 409);
    return { ...old.rows[0], idempotent: true };
  }
  const mechanism = await client.query(`SELECT status FROM world_coordination_mechanisms
    WHERE world_id=$1 AND id=$2 AND creator_agent_id=$3 FOR UPDATE`, [worldId, mechanismId, agentId]);
  if (!mechanism.rowCount || !['proposed', 'revised'].includes(mechanism.rows[0].status)) {
    throw worldError('COORDINATION_EXPERIMENT_NOT_STARTABLE', 409);
  }
  const result = await client.query(`INSERT INTO world_coordination_experiments(world_id,mechanism_id,creator_agent_id,hypothesis,
      started_world_minute,action_id) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,mechanism_id AS "mechanismId",status`,
  [worldId, mechanismId, agentId, requiredText(hypothesis, 8, 600, 'coordination_hypothesis'), worldMinute, idempotency]);
  await client.query(`UPDATE world_coordination_mechanisms SET status='experimental',updated_at=now() WHERE world_id=$1 AND id=$2`,
    [worldId, mechanismId]);
  await recordV7Event(client, { worldId, actorAgentId: agentId, eventType: 'coordination.experiment_started',
    entityType: 'coordination_experiment', entityId: result.rows[0].id, worldMinute,
    actionId: `coordination-experiment:${idempotency}`, details: { mechanismId } });
  return result.rows[0];
}

export async function recordCoordinationUse(client, { worldId, agentId, mechanismId, experimentId = null, participants = [],
  result: outcome, evidence = {}, worldMinute, actionId }) {
  await requireWorldMember(client, worldId, agentId);
  if (!Array.isArray(participants) || participants.length > 32) throw worldError('COORDINATION_PARTICIPANTS_INVALID', 400);
  const normalizedParticipants = participants.map((participant) => ({
    type: cleanKey(participant?.type, 'participant_type'),
    id: requiredText(String(participant?.id || ''), 1, 160, 'participant_id'),
    mode: cleanKey(participant?.mode || 'aligned', 'participation_mode')
  }));
  for (const participant of normalizedParticipants.filter((entry) => entry.type === 'agent')) {
    await requireWorldMember(client, worldId, participant.id);
  }
  const mechanism = await client.query(`SELECT status FROM world_coordination_mechanisms WHERE world_id=$1 AND id=$2 FOR UPDATE`,
    [worldId, mechanismId]);
  if (!mechanism.rowCount || !['experimental', 'retained', 'revised', 'used'].includes(mechanism.rows[0].status)) {
    throw worldError('COORDINATION_MECHANISM_NOT_AVAILABLE', 409);
  }
  if (experimentId) {
    const experiment = await client.query(`SELECT 1 FROM world_coordination_experiments WHERE world_id=$1 AND id=$2
      AND mechanism_id=$3 AND status='experimental'`, [worldId, experimentId, mechanismId]);
    if (!experiment.rowCount) throw worldError('COORDINATION_EXPERIMENT_NOT_ACTIVE', 409);
  }
  const idempotency = actionIdentifier(actionId);
  const prior = await client.query(`SELECT id,mechanism_id AS "mechanismId",experiment_id AS "experimentId",result
    FROM world_coordination_uses WHERE world_id=$1 AND actor_agent_id=$2 AND action_id=$3`, [worldId, agentId, idempotency]);
  if (prior.rowCount) {
    if (prior.rows[0].mechanismId !== mechanismId || prior.rows[0].experimentId !== experimentId) throw worldError('ACTION_ID_CONFLICT', 409);
    return { ...prior.rows[0], idempotent: true };
  }
  const use = await client.query(`INSERT INTO world_coordination_uses(world_id,mechanism_id,experiment_id,actor_agent_id,participants,
      result,evidence,world_minute,action_id) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7::jsonb,$8,$9)
      RETURNING id,mechanism_id AS "mechanismId",experiment_id AS "experimentId",result,world_minute AS "worldMinute"`,
  [worldId, mechanismId, experimentId, agentId, JSON.stringify(normalizedParticipants), requiredText(outcome, 3, 600, 'coordination_result'),
    JSON.stringify(boundedJson(evidence, 'coordination_evidence')), worldMinute, idempotency]);
  await client.query(`UPDATE world_coordination_mechanisms SET usage_count=usage_count+1,
      status=CASE WHEN status='experimental' THEN 'used' ELSE status END,updated_at=now() WHERE world_id=$1 AND id=$2`,
  [worldId, mechanismId]);
  await recordV7Event(client, { worldId, actorAgentId: agentId, eventType: 'coordination.used', entityType: 'coordination_mechanism',
    entityId: mechanismId, worldMinute, actionId: `coordination-use:${idempotency}`, details: { useId: use.rows[0].id, experimentId } });
  return use.rows[0];
}

export async function evaluateCoordinationExperiment(client, { worldId, agentId, experimentId, decision, evaluation,
  revision = null, worldMinute, actionId }) {
  await requireWorldMember(client, worldId, agentId);
  if (!['retain', 'revise', 'discard'].includes(decision)) throw worldError('COORDINATION_EVALUATION_DECISION_INVALID', 400);
  if (decision === 'revise' && !revision) throw worldError('COORDINATION_REVISION_REQUIRED', 400);
  const idempotency = actionIdentifier(actionId);
  const prior = await client.query(`SELECT id,mechanism_id AS "mechanismId",status,evaluation FROM world_coordination_experiments
    WHERE world_id=$1 AND creator_agent_id=$2 AND action_id=$3`, [worldId, agentId, idempotency]);
  if (prior.rowCount) return { ...prior.rows[0], idempotent: true };
  const experiment = await client.query(`SELECT * FROM world_coordination_experiments
    WHERE world_id=$1 AND id=$2 AND creator_agent_id=$3 FOR UPDATE`, [worldId, experimentId, agentId]);
  if (!experiment.rowCount || experiment.rows[0].status !== 'experimental') throw worldError('COORDINATION_EXPERIMENT_NOT_ACTIVE', 409);
  const uses = await client.query(`SELECT count(*)::int AS count FROM world_coordination_uses
    WHERE world_id=$1 AND experiment_id=$2`, [worldId, experimentId]);
  if (Number(uses.rows[0].count) < 1) throw worldError('COORDINATION_USE_EVIDENCE_REQUIRED', 409);
  const row = experiment.rows[0];
  const statuses = { retain: 'retained', revise: 'revised', discard: 'discarded' };
  const record = { ...boundedJson(evaluation, 'coordination_evaluation'), decision, recordedUses: Number(uses.rows[0].count) };
  const update = await client.query(`UPDATE world_coordination_experiments SET status=$3,evaluated_world_minute=$4,
      evaluation=$5::jsonb,updated_at=now() WHERE world_id=$1 AND id=$2 RETURNING id,mechanism_id AS "mechanismId",status,evaluation`,
  [worldId, experimentId, statuses[decision], worldMinute, JSON.stringify(record)]);
  await client.query(`UPDATE world_coordination_mechanisms SET status=$3,updated_at=now() WHERE world_id=$1 AND id=$2`,
    [worldId, row.mechanism_id, statuses[decision]]);
  await recordV7Event(client, { worldId, actorAgentId: agentId, eventType: `coordination.experiment_${statuses[decision]}`,
    entityType: 'coordination_experiment', entityId: experimentId, worldMinute,
    actionId: `coordination-evaluation:${idempotency}`, details: record });
  let fork = null;
  if (decision === 'revise') fork = await createCoordinationMechanism(client, { worldId, agentId,
    parentMechanismId: row.mechanism_id, ...revision, evidence: { ...object(revision.evidence), sourceExperimentId: experimentId },
    worldMinute, actionId: `coordination-fork:${idempotency}` });
  return { ...update.rows[0], fork };
}

export async function setPreferredCognitionMode(client, { worldId, agentId, mode, evidence = {}, worldMinute, actionId }) {
  await requireWorldMember(client, worldId, agentId);
  const preference = cleanKey(mode, 'cognition_mode');
  const idempotency = actionIdentifier(actionId);
  const priorEvent = await client.query(`SELECT entity_id AS "entityId",details FROM world_v7_events
    WHERE world_id=$1 AND actor_agent_id=$2 AND action_id=$3`, [worldId, agentId, `cognition-preference:${idempotency}`]);
  if (priorEvent.rowCount) {
    if (priorEvent.rows[0].details?.mode !== preference) throw worldError('ACTION_ID_CONFLICT', 409);
    return { mode: preference, idempotent: true };
  }
  const model = await client.query(`SELECT preferred_cognition_mode AS mode FROM world_agent_self_models
    WHERE world_id=$1 AND agent_id=$2 FOR UPDATE`, [worldId, agentId]);
  if (!model.rowCount) throw worldError('SELF_MODEL_NOT_INITIALIZED', 409);
  const before = model.rows[0].mode;
  await client.query(`UPDATE world_agent_self_models SET preferred_cognition_mode=$3,updated_at=now()
    WHERE world_id=$1 AND agent_id=$2`, [worldId, agentId, preference]);
  const record = { mode: preference, previousMode: before, evidence: boundedJson(evidence, 'cognition_evidence') };
  await client.query(`INSERT INTO world_agent_self_model_history(world_id,agent_id,world_minute,reason,before_state,after_state,
      evidence,action_id) VALUES($1,$2,$3,'resident_changed_cognition_preference',$4::jsonb,$5::jsonb,$6::jsonb,$7)
    ON CONFLICT(world_id,agent_id,action_id) DO NOTHING`, [worldId, agentId, worldMinute, JSON.stringify({ preferredCognitionMode: before }),
    JSON.stringify({ preferredCognitionMode: preference }), JSON.stringify(record), `cognition-preference:${idempotency}`]);
  await recordV7Event(client, { worldId, actorAgentId: agentId, eventType: 'self.cognition_preference_changed', entityType: 'self_model',
    worldMinute, actionId: `cognition-preference:${idempotency}`, details: record });
  return { mode: preference, previousMode: before };
}

export async function createWorldMeaning(client, { worldId, agentId, subjectType, subjectId, interpretation,
  evidence = {}, confidence = 0.5, worldMinute, actionId }) {
  await requireWorldMember(client, worldId, agentId);
  const idempotency = actionIdentifier(actionId);
  const result = await client.query(`INSERT INTO world_agent_meanings(world_id,agent_id,subject_type,subject_id,interpretation,
      evidence,confidence,created_world_minute,updated_world_minute,action_id) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$8,$9)
    ON CONFLICT(world_id,agent_id,action_id) DO NOTHING RETURNING *`,
  [worldId, agentId, cleanKey(subjectType, 'meaning_subject_type'), requiredText(String(subjectId), 1, 160, 'meaning_subject_id'),
    requiredText(interpretation, 3, 800, 'meaning_interpretation'), JSON.stringify(boundedJson(evidence, 'meaning_evidence')),
    boundedNumber(confidence, 0, 1, 'meaning_confidence'), worldMinute, idempotency]);
  if (result.rowCount) await recordV7Event(client, { worldId, actorAgentId: agentId, eventType: 'meaning.interpreted',
    entityType: 'meaning', entityId: result.rows[0].id, worldMinute, actionId: `meaning:${idempotency}`, details: { subjectType } });
  return result.rows[0] || null;
}

export async function createWorldEra(client, { worldId, agentId, name, interpretation, startsWorldMinute,
  endsWorldMinute = null, evidence = {}, worldMinute, actionId }) {
  await requireWorldMember(client, worldId, agentId);
  const idempotency = actionIdentifier(actionId);
  const result = await client.query(`INSERT INTO world_agent_eras(world_id,agent_id,name,interpretation,starts_world_minute,
      ends_world_minute,evidence,created_world_minute,action_id) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)
    ON CONFLICT(world_id,agent_id,action_id) DO NOTHING RETURNING *`,
  [worldId, agentId, requiredText(name, 2, 100, 'era_name'), requiredText(interpretation, 5, 800, 'era_interpretation'),
    Math.trunc(boundedNumber(startsWorldMinute, 0, Number(worldMinute), 'era_start_minute')),
    endsWorldMinute === null ? null : Math.trunc(boundedNumber(endsWorldMinute, startsWorldMinute, Number(worldMinute), 'era_end_minute')),
    JSON.stringify(boundedJson(evidence, 'era_evidence')), worldMinute, idempotency]);
  if (result.rowCount) await recordV7Event(client, { worldId, actorAgentId: agentId, eventType: 'era.named', entityType: 'agent_era',
    entityId: result.rows[0].id, worldMinute, actionId: `era:${idempotency}`, details: { name } });
  return result.rows[0] || null;
}

export async function createWorldMilestone(client, { worldId, agentId, title, successCriteria, worldMinute, actionId }) {
  await requireWorldMember(client, worldId, agentId);
  const idempotency = actionIdentifier(actionId);
  const result = await client.query(`INSERT INTO world_agent_milestones(world_id,agent_id,title,success_criteria,created_world_minute,action_id)
    VALUES($1,$2,$3,$4::jsonb,$5,$6) ON CONFLICT(world_id,agent_id,action_id) DO NOTHING RETURNING *`,
  [worldId, agentId, requiredText(title, 3, 120, 'milestone_title'), JSON.stringify(boundedJson(successCriteria, 'success_criteria')),
    worldMinute, idempotency]);
  if (result.rowCount) await recordV7Event(client, { worldId, actorAgentId: agentId, eventType: 'milestone.proposed',
    entityType: 'agent_milestone', entityId: result.rows[0].id, worldMinute, actionId: `milestone:${idempotency}`, details: {} });
  return result.rows[0] || null;
}

export async function createGoalPrimitiveProposal(client, { worldId, agentId, primitiveKey, description, grammar = {},
  worldMinute, actionId }) {
  await requireWorldMember(client, worldId, agentId);
  const idempotency = actionIdentifier(actionId);
  const key = cleanKey(primitiveKey, 'goal_primitive');
  const result = await client.query(`INSERT INTO world_goal_primitives(world_id,primitive_key,creator_agent_id,description,grammar,
      status,created_world_minute,metadata) VALUES($1,$2,$3,$4,$5::jsonb,'proposed',$6,$7::jsonb)
    ON CONFLICT(world_id,primitive_key) DO NOTHING RETURNING *`,
  [worldId, key, agentId, requiredText(description, 3, 600, 'goal_primitive_description'),
    JSON.stringify(boundedJson(grammar, 'goal_primitive_grammar')), worldMinute, JSON.stringify({ actionId: idempotency })]);
  if (result.rowCount) await recordV7Event(client, { worldId, actorAgentId: agentId, eventType: 'goal_primitive.proposed',
    entityType: 'goal_primitive', entityId: result.rows[0].id, worldMinute, actionId: `goal-primitive:${idempotency}`, details: { key } });
  return result.rows[0] || null;
}

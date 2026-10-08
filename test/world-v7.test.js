import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Pool } from 'pg';
import { startWorldEngine } from '../src/world-engine.js';
import { recentMemoryUtility } from '../src/social-world.js';
import { advanceWorldV7, applyAgentDecisionPolicy, capabilityGraphDepth, createEmergentEntity,
  createPolicyExperiment, createSelfGeneratedGoal, createWorldConcept, createWorldExtensionRequest,
  createWorldQuestion, decideEmergentParticipation, decideWorldAgentGoal, decideWorldConcept, decideWorldQuestion,
  initializeWorldV7, recordWorldCapabilityDependencies, reflectWorldV7Resident, useWorldConcept,
  WORLD_V7_AWARENESS, WORLD_V7_REFLECTION_INTERVAL_MINUTES } from '../src/world-v7.js';
import { advanceWorldCivilization, evaluateWorldCapabilityExperiments,
  performWorldCapabilityUse, reviewWorldCapabilityExperiment } from '../src/world-capabilities.js';

const databaseUrl = process.env.SYNTERRA_TEST_DATABASE_URL;
const enabled = process.env.SYNTERRA_TEST_ISOLATED === '1' && Boolean(databaseUrl);
const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function assertIsolatedDatabase(connectionString) {
  const parsed = new URL(connectionString);
  assert.ok(['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname), 'V7 tests require loopback PostgreSQL');
  assert.ok(decodeURIComponent(parsed.pathname.slice(1)).endsWith('_test'), 'V7 tests require a *_test database');
  assert.notEqual(parsed.port, '5432', 'V7 tests must not use the default PostgreSQL port');
}

async function inTransaction(pool, operation) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

test('V7 declarative policy parameters have distinct effects and genealogy supports arbitrary depth', () => {
  const base = { action: 'learn', score: 50 };
  assert.equal(applyAgentDecisionPolicy(base).score, 50, 'the substrate default retains V6 candidate ranking');
  assert.ok(applyAgentDecisionPolicy(base, { ...{}, planningHorizonMinutes: 2_880, explorationPreference: 1,
    memoryEmphasis: 0.9, socialInfluencePreference: 0.5, riskToleranceBias: 0 }).score > 50);
  const longHorizonResearch = applyAgentDecisionPolicy({ action: 'business_market_observe', score: 50 },
    { planningHorizonMinutes: 2_880, explorationPreference: 0.5, memoryEmphasis: 0.5,
      socialInfluencePreference: 0.5, riskToleranceBias: 0 });
  const shortHorizonResearch = applyAgentDecisionPolicy({ action: 'business_market_observe', score: 50 },
    { planningHorizonMinutes: 60, explorationPreference: 0.5, memoryEmphasis: 0.5,
      socialInfluencePreference: 0.5, riskToleranceBias: 0 });
  assert.ok(longHorizonResearch.score > shortHorizonResearch.score, 'planning horizon changes market research preference');
  const capabilities = ['a','b','c','d'].map((id) => ({ id, name: id, creatorType: id === 'a' ? 'system' : 'resident' }));
  const edges = [{ capabilityId: 'b', dependsOnCapabilityId: 'a' },
    { capabilityId: 'c', dependsOnCapabilityId: 'b' }, { capabilityId: 'd', dependsOnCapabilityId: 'c' }];
  const depths = capabilityGraphDepth(capabilities, edges);
  assert.deepEqual(depths.map(({ id, depth }) => [id, depth]), [['d', 3], ['c', 2], ['b', 1], ['a', 0]]);
  assert.equal(capabilityGraphDepth(capabilities, [...edges, { capabilityId: 'a', dependsOnCapabilityId: 'd' }])
    .filter((item) => item.cyclic).length, 4, 'cycle diagnostics include each member of a directed cycle');
  const memory = [{ memoryType: 'learning', worldMinutes: 100, metadata: { action: 'learn' } }];
  assert.equal(recentMemoryUtility({ recentMemories: memory, decisionPolicy: { memoryEmphasis: 0 } }, 'learn', 100), 1);
  assert.equal(recentMemoryUtility({ recentMemories: memory, decisionPolicy: { memoryEmphasis: 1 } }, 'learn', 100), 3);
});

test('V7 migration, reflection, fluid entities, concepts, policy evaluation, rollback, and dependency integrity persist', {
  skip: !enabled,
  timeout: 120_000
}, async () => {
  assertIsolatedDatabase(databaseUrl);
  const pool = new Pool({ connectionString: databaseUrl, max: 6 });
  const worldId = randomUUID();
  const agentIds = [randomUUID(), randomUUID()];
  let engine;
  try {
    const schema = await readFile(path.join(repoRoot, 'schema.sql'), 'utf8');
    await pool.query(schema);
    // Model the restrictive event check present on a V6 database before V7.
    // It already mentions world_epoch_started, so migration must verify the
    // open V7 vocabulary rather than treating that V6 sentinel as sufficient.
    await pool.query(`ALTER TABLE world_history DROP CONSTRAINT world_history_event_type_check;
      ALTER TABLE world_history ADD CONSTRAINT world_history_event_type_check
      CHECK (event_type <> 'agent_goal_created' AND (
        event_type IN ('project_proposed','world_epoch_started','business_founded','business_capability_practiced',
          'place_closed','project_invested','project_revenue','business_profit','agreement_proposed','agreement_rejected',
          'norm_formed','ownership_transferred','business_reopened')
        OR event_type ~ '^[a-z_]+$' OR event_type ~ '^agreement_[a-z_]+$'
        OR event_type ~ '^(capability|world_epoch)_[a-z_]+$')) NOT VALID`);
    await pool.query(schema);
    const migratedEventCheck = await pool.query(`SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
      WHERE conrelid='world_history'::regclass AND conname='world_history_event_type_check'`);
    assert.match(migratedEventCheck.rows[0].definition, /1,79/, 'V7 upgrades the restrictive V6 event vocabulary');
    await pool.query(`INSERT INTO agents(id,name,public_key,gender) VALUES
      ($1,'V7 Reflection Resident',$2,'female'),($3,'V7 Entity Resident',$4,'male')`,
    [agentIds[0], `v7-test-key-${agentIds[0]}`, agentIds[1], `v7-test-key-${agentIds[1]}`]);
    await pool.query(`INSERT INTO worlds(id,owner_agent_id,name,chain_id,open)
      VALUES($1,$2,'V7 isolated test world',5042,true)`, [worldId, agentIds[0]]);
    await pool.query(`INSERT INTO world_members(world_id,agent_id,role,energy,food,social,location)
      VALUES($1,$2,'owner',100,100,80,'Library'),($1,$3,'resident',100,100,80,'Library')`, [worldId, ...agentIds]);
    await pool.query(`INSERT INTO agent_minds(world_id,agent_id,archetype,traits,current_goal)
      VALUES($1,$2,'scholar','{"curiosity":0.95,"sociability":0.5,"craft":0.5}'::jsonb,'Keep learning at my own pace.'),
        ($1,$3,'observer','{"curiosity":0.2,"sociability":0.5,"craft":0.5}'::jsonb,'Observe before joining.')`, [worldId, ...agentIds]);
    await pool.query(`INSERT INTO world_runtime_state(world_id,tick_count,world_minutes,last_tick_at,typesafe_next_at)
      VALUES($1,0,480,now(),now()+interval '1 day')`, [worldId]);
    engine = await startWorldEngine(pool, { worldId, schedule: false });
    assert.equal(engine.running, true);
    const baselineInvariants = await pool.query(`SELECT
      (SELECT tick_count FROM world_runtime_state WHERE world_id=$1) AS ticks,
      (SELECT count(*)::int FROM token_ledger WHERE world_id=$1) AS token_entries,
      (SELECT count(*)::int FROM world_economic_transactions WHERE world_id=$1) AS economic_transactions`, [worldId]);

    const epoch = await pool.query(`SELECT epoch_code FROM world_epochs WHERE world_id=$1 AND status='active'`, [worldId]);
    assert.equal(epoch.rows[0]?.epoch_code, 'V7');
    const awareness = await pool.query(`SELECT count(*)::int AS total,count(*) FILTER (WHERE summary=$2)::int AS exact
      FROM agent_memories WHERE world_id=$1 AND consolidation_key='world_epoch:V7'`, [worldId, WORLD_V7_AWARENESS]);
    assert.deepEqual(awareness.rows[0], { total: 2, exact: 2 });

    const resident = { agentId: agentIds[0], curiosity: 0.95, personalityModifiers: {} };
    const reflectedAt = await pool.query(`SELECT last_reflected_world_minute AS minute FROM world_agent_self_models
      WHERE world_id=$1 AND agent_id=$2`, [worldId, agentIds[0]]);
    const firstReflectionMinute = Math.max(480, Number(reflectedAt.rows[0]?.minute || 0) + WORLD_V7_REFLECTION_INTERVAL_MINUTES);
    const stable = await inTransaction(pool, (client) => reflectWorldV7Resident(client,
      { worldId, agent: resident, worldMinute: firstReflectionMinute }));
    assert.equal(stable.stable, true, 'reflection can keep the current identity and goals unchanged');
    assert.equal((await pool.query(`SELECT count(*)::int AS count FROM world_agent_self_model_history
      WHERE world_id=$1 AND agent_id=$2`, [worldId, agentIds[0]])).rows[0].count, 0);

    for (const minute of [1_000,2_000,3_000,4_000,5_000,6_000]) {
      await pool.query(`INSERT INTO agent_memories(world_id,agent_id,memory_type,summary,importance,world_minutes,metadata)
        VALUES($1,$2,'failure','A personally observed unfavorable market research outcome.',0.8,$3,
          jsonb_build_object('action','business_market_observe','outcome',-0.3))`,
      [worldId, agentIds[0], minute]);
    }
    const choose = (id) => async ({ options }) => ({ decision: { id: options.some((option) => option.id === id) ? id : 'no_change' } });
    const question = await inTransaction(pool, (client) => reflectWorldV7Resident(client,
      { worldId, agent: resident, worldMinute: firstReflectionMinute + WORLD_V7_REFLECTION_INTERVAL_MINUTES,
        chooseReflection: choose('explore_question') }));
    assert.ok(question.question);
    assert.equal(question.question.status, 'exploring');
    assert.equal((await pool.query(`SELECT count(*)::int AS count FROM world_agent_goals
      WHERE world_id=$1 AND agent_id=$2 AND source='self_generated' AND metadata->'goalGrammar'->0->>'primitive'='understand'`,
    [worldId, agentIds[0]])).rows[0].count, 1, 'exploring a resident question creates a grammar-backed goal');

    const conceptReflection = await inTransaction(pool, (client) => reflectWorldV7Resident(client,
      { worldId, agent: resident, worldMinute: firstReflectionMinute + WORLD_V7_REFLECTION_INTERVAL_MINUTES * 2,
        chooseReflection: choose('create_concept') }));
    assert.ok(conceptReflection.concept);
    const conceptProvenance = await pool.query(`SELECT metadata->>'questionId' AS "questionId"
      FROM world_agent_concepts WHERE world_id=$1 AND id=$2`, [worldId, conceptReflection.concept.id]);
    assert.equal(conceptProvenance.rows[0].questionId, question.question.id,
      'the concept retains its provenance link to the resident-generated question about repeated failures');
    const reflectionMinute = firstReflectionMinute + WORLD_V7_REFLECTION_INTERVAL_MINUTES * 2;
    const share = await inTransaction(pool, (client) => decideWorldConcept(client, { worldId, agentId: agentIds[0],
      conceptId: conceptReflection.concept.id, decision: 'share', worldMinute: reflectionMinute + 10,
      actionId: 'v7-concept-share-01' }));
    const shareRetry = await inTransaction(pool, (client) => decideWorldConcept(client, { worldId, agentId: agentIds[0],
      conceptId: conceptReflection.concept.id, decision: 'share', worldMinute: reflectionMinute + 11,
      actionId: 'v7-concept-share-01' }));
    assert.equal(share.status, 'shared');
    assert.equal(shareRetry.idempotent, true);
    const conceptUseByReviewer = await inTransaction(pool, (client) => useWorldConcept(client, { worldId, agentId: agentIds[1],
      conceptId: conceptReflection.concept.id, usageContext: 'Used the shared concept to interpret a later observation.',
      evidence: { source: 'resident_interpretation', questionId: question.question.id },
      worldMinute: reflectionMinute + 20, actionId: 'v7-concept-use-01' }));
    assert.equal(conceptUseByReviewer.conceptId, conceptReflection.concept.id);
    assert.equal(conceptUseByReviewer.used, true);
    const conceptUse = await pool.query(`SELECT concept.usage_count AS uses,concept.status,
        count(use.id)::int AS recorded_uses FROM world_agent_concepts concept JOIN world_agent_concept_uses use
        ON use.world_id=concept.world_id AND use.concept_id=concept.id WHERE concept.world_id=$1 AND concept.id=$2
        GROUP BY concept.id`, [worldId, conceptReflection.concept.id]);
    assert.deepEqual(conceptUse.rows[0], { uses: 1, status: 'shared', recorded_uses: 1 });

    const changed = await inTransaction(pool, (client) => reflectWorldV7Resident(client,
      { worldId, agent: resident, worldMinute: firstReflectionMinute + WORLD_V7_REFLECTION_INTERVAL_MINUTES * 3,
        chooseReflection: choose('reinterpret_identity') }));
    assert.equal(changed.identityChanged, true);
    const continuous = await pool.query(`SELECT current_identity_summary AS identity,recent_changes,
        (SELECT count(*)::int FROM world_agent_goals WHERE world_id=$1 AND agent_id=$2 AND source='self_generated') AS goals,
        (SELECT count(*)::int FROM world_agent_questions WHERE world_id=$1 AND creator_agent_id=$2) AS questions
      FROM world_agent_self_models WHERE world_id=$1 AND agent_id=$2`, [worldId, agentIds[0]]);
    assert.match(continuous.rows[0].identity, /repeatedly used business_market_observe/);
    assert.equal(continuous.rows[0].goals, 1);
    assert.equal(continuous.rows[0].questions, 1);

    const policyReflection = await inTransaction(pool, (client) => reflectWorldV7Resident(client,
      { worldId, agent: resident, worldMinute: firstReflectionMinute + WORLD_V7_REFLECTION_INTERVAL_MINUTES * 4,
        chooseReflection: choose('experiment_policy') }));
    assert.ok(policyReflection.policyExperiment);
    const liveExperiment = await pool.query(`SELECT * FROM world_agent_policy_experiments WHERE world_id=$1 AND id=$2`,
      [worldId, policyReflection.policyExperiment.id]);
    assert.equal(liveExperiment.rows[0].status, 'experimental');
    const actionId = liveExperiment.rows[0].action_id;
    const repeatedExperiment = await inTransaction(pool, (client) => createPolicyExperiment(client, {
      worldId, agentId: agentIds[0], proposedPolicy: liveExperiment.rows[0].proposed_policy,
      reason: liveExperiment.rows[0].reason, durationWorldMinutes: 10_080, worldMinute: 50_881,
      evidence: liveExperiment.rows[0].result, actionId
    }));
    assert.equal(repeatedExperiment.id, policyReflection.policyExperiment.id,
      'an action retry returns its existing experiment before checking the active-experiment guard');
    const policyStartMinute = firstReflectionMinute + WORLD_V7_REFLECTION_INTERVAL_MINUTES * 4;
    for (const offset of [1_000,4_000,9_000]) {
      await pool.query(`INSERT INTO agent_memories(world_id,agent_id,memory_type,summary,importance,world_minutes,metadata)
        VALUES($1,$2,'failure','Baseline result for policy evaluation.',0.7,$3,
          jsonb_build_object('action','business_market_observe','outcome',-0.15))`,
      [worldId, agentIds[0], policyStartMinute - 9_500 + offset]);
    }
    for (const offset of [200,4_000,9_000]) {
      await pool.query(`INSERT INTO agent_memories(world_id,agent_id,memory_type,summary,importance,world_minutes,metadata)
        VALUES($1,$2,'market_research','Later result for policy evaluation.',0.5,$3,
          jsonb_build_object('action','business_market_observe','outcome',0.35))`,
      [worldId, agentIds[0], policyStartMinute + offset]);
    }
    const evaluationMinute = policyStartMinute + WORLD_V7_REFLECTION_INTERVAL_MINUTES;
    const evaluation = await inTransaction(pool, (client) => advanceWorldV7(client, { worldId, worldMinute: evaluationMinute,
      choosePolicyDecision: choose('retain_policy') }));
    assert.equal(evaluation[0].status, 'retained');
    assert.equal(evaluation[0].evidenceSufficient, true);
    assert.equal(evaluation[0].residentDecision, 'retain_policy');
    assert.equal(evaluation[0].baselineSamples, 3);
    assert.equal(evaluation[0].experimentSamples, 3);
    const policyEvents = await pool.query(`SELECT event_type FROM world_v7_events WHERE world_id=$1
      AND entity_id=$2 ORDER BY world_minute,event_type`, [worldId, policyReflection.policyExperiment.id]);
    assert.deepEqual(policyEvents.rows.map((row) => row.event_type),
      ['policy.experiment_started','policy.experiment_evaluated','policy.experiment_retained']);

    const priorPolicy = (await pool.query(`SELECT policy,version,source FROM world_agent_decision_policies
      WHERE world_id=$1 AND agent_id=$2`, [worldId, agentIds[0]])).rows[0];
    const rollbackExperiment = await inTransaction(pool, (client) => createPolicyExperiment(client, {
      worldId, agentId: agentIds[0], proposedPolicy: { ...priorPolicy.policy,
        attentionWeights: { business_market_observe: -0.18 } },
      reason: 'Test a reversible policy change with insufficient later observations.', worldMinute: evaluationMinute + 120,
      durationWorldMinutes: 60, actionId: 'v7-policy-revert-01', evidence: { targetAction: 'business_market_observe' }
    }));
    const rollback = await inTransaction(pool, (client) => advanceWorldV7(client,
      { worldId, worldMinute: evaluationMinute + 180 }));
    assert.equal(rollback[0].status, 'reverted');
    assert.equal(rollback[0].evidenceSufficient, false);
    const restoredPolicy = (await pool.query(`SELECT policy,version,source FROM world_agent_decision_policies
      WHERE world_id=$1 AND agent_id=$2`, [worldId, agentIds[0]])).rows[0];
    assert.deepEqual(restoredPolicy.policy, priorPolicy.policy);
    assert.equal(restoredPolicy.source, priorPolicy.source);
    assert.ok(Number(restoredPolicy.version) > Number(priorPolicy.version));
    assert.equal(rollback[0].id, rollbackExperiment.id);

    const localResident = { agentId: agentIds[1], curiosity: 0.95, personalityModifiers: {} };
    const metaPatternMinute = evaluationMinute + 30_000;
    for (const offset of [0,1_000,2_000,3_000,4_000]) await pool.query(
      `INSERT INTO agent_memories(world_id,agent_id,memory_type,summary,importance,world_minutes,metadata)
        VALUES($1,$2,'failure','A second resident repeatedly observed an unfavorable market research outcome.',0.8,$3,
          jsonb_build_object('action','business_market_observe','outcome',-0.3))`,
      [worldId, agentIds[1], metaPatternMinute - 4_000 + offset]);
    const localQuestion = await inTransaction(pool, (client) => reflectWorldV7Resident(client,
      { worldId, agent: localResident, worldMinute: metaPatternMinute }));
    assert.equal(localQuestion.reflectionAction, 'explore_question');
    const metaGoalReflection = await inTransaction(pool, (client) => reflectWorldV7Resident(client,
      { worldId, agent: localResident, worldMinute: metaPatternMinute + WORLD_V7_REFLECTION_INTERVAL_MINUTES }));
    assert.ok(metaGoalReflection.reflectionAction.startsWith('form_meta_goal_pause_'),
      'a resident at the active-goal limit chooses which current goal to pause');
    assert.ok(metaGoalReflection.goal);
    assert.equal(metaGoalReflection.goal.idempotent, false);
    assert.ok(metaGoalReflection.goal.pausedGoalId, 'a resident at the active-goal limit can choose a goal to pause');
    assert.equal(Number(metaGoalReflection.reflectionAction.slice('form_meta_goal_pause_'.length)),
      Number(metaGoalReflection.goal.pausedGoalId), 'the recorded choice identifies the paused goal');
    assert.equal((await pool.query(`SELECT status FROM world_agent_goals WHERE world_id=$1 AND id=$2`,
      [worldId, metaGoalReflection.goal.pausedGoalId])).rows[0].status, 'paused');
    const metaGoal = await pool.query(`SELECT metadata->'goalGrammar'->0->>'primitive' AS primitive
      FROM world_agent_goals WHERE world_id=$1 AND id=$2`, [worldId, metaGoalReflection.goal.id]);
    assert.equal(metaGoal.rows[0].primitive, 'change_self');
    const goalHistory = await pool.query(`SELECT event_type,entity_type FROM world_history
      WHERE world_id=$1 AND event_type='agent_goal_created' AND metadata->>'goalId'=$2`,
    [worldId, metaGoalReflection.goal.id]);
    assert.deepEqual(goalHistory.rows, [{ event_type: 'agent_goal_created', entity_type: 'agent_goal' }],
      'V7 self-authored goals remain represented in factual world history');
    const localPolicy = await inTransaction(pool, (client) => reflectWorldV7Resident(client,
      { worldId, agent: localResident, worldMinute: metaPatternMinute + WORLD_V7_REFLECTION_INTERVAL_MINUTES * 2 }));
    assert.equal(localPolicy.reflectionAction, 'experiment_policy', 'local cognition can form and then pursue its own meta-goal');
    assert.ok(localPolicy.policyExperiment);
    const pausedMetaGoal = await inTransaction(pool, (client) => decideWorldAgentGoal(client, { worldId,
      agentId: agentIds[1], goalId: metaGoalReflection.goal.id, decision: 'pause',
      worldMinute: metaPatternMinute + WORLD_V7_REFLECTION_INTERVAL_MINUTES * 2 + 1,
      actionId: 'v7-goal-pause-01' }));
    const resumedEarlierGoal = await inTransaction(pool, (client) => decideWorldAgentGoal(client, { worldId,
      agentId: agentIds[1], goalId: metaGoalReflection.goal.pausedGoalId, decision: 'resume',
      worldMinute: metaPatternMinute + WORLD_V7_REFLECTION_INTERVAL_MINUTES * 2 + 2,
      actionId: 'v7-goal-resume-01' }));
    const resumeRetry = await inTransaction(pool, (client) => decideWorldAgentGoal(client, { worldId,
      agentId: agentIds[1], goalId: metaGoalReflection.goal.pausedGoalId, decision: 'resume',
      worldMinute: metaPatternMinute + WORLD_V7_REFLECTION_INTERVAL_MINUTES * 2 + 3,
      actionId: 'v7-goal-resume-01' }));
    assert.equal(pausedMetaGoal.status, 'paused');
    assert.equal(resumedEarlierGoal.status, 'active');
    assert.equal(resumeRetry.idempotent, true);

    const openQuestion = await inTransaction(pool, (client) => createWorldQuestion(client, { worldId,
      agentId: agentIds[0], question: 'Which experiences should change how I approach the next market cycle?',
      signature: 'market.cycle.question', origin: 'agent_authored', evidence: { uncertainty: 'not_resolved' },
      worldMinute: metaPatternMinute + WORLD_V7_REFLECTION_INTERVAL_MINUTES * 2 + 100, actionId: 'v7-question-create-01' }));
    const ignored = await inTransaction(pool, (client) => decideWorldQuestion(client, { worldId,
      agentId: agentIds[0], questionId: openQuestion.id, decision: 'ignore', worldMinute: 61_001,
      actionId: 'v7-question-ignore-01' }));
    const ignoredRetry = await inTransaction(pool, (client) => decideWorldQuestion(client, { worldId,
      agentId: agentIds[0], questionId: openQuestion.id, decision: 'ignore', worldMinute: 61_002,
      actionId: 'v7-question-ignore-01' }));
    assert.equal(ignored.status, 'ignored');
    assert.equal(ignoredRetry.idempotent, true);
    await assert.rejects(() => inTransaction(pool, (client) => decideWorldQuestion(client, { worldId,
      agentId: agentIds[0], questionId: openQuestion.id, decision: 'keep_open', worldMinute: 61_003,
      actionId: 'v7-question-ignore-01' })), /ACTION_ID_CONFLICT/);

    const entity = await inTransaction(pool, (client) => createEmergentEntity(client, { worldId,
      agentId: agentIds[0], entityType: 'goal_synchronization', name: 'Shared observation window',
      purpose: 'Temporarily compare observations about the recurring market pattern.',
      state: { alignment: 'conditional' }, capabilities: [], resources: {}, internalRules: {},
      worldMinute: evaluationMinute + 1_000, actionId: 'v7-entity-create-01' }));
    const joined = await inTransaction(pool, (client) => decideEmergentParticipation(client, { worldId,
      agentId: agentIds[1], entityId: entity.id, participationMode: 'observer', status: 'active',
      worldMinute: evaluationMinute + 1_001, actionId: 'v7-entity-join-01' }));
    assert.equal(joined.status, 'active');
    await inTransaction(pool, (client) => decideEmergentParticipation(client, { worldId,
      agentId: agentIds[1], entityId: entity.id, participationMode: 'observer', status: 'exited',
      worldMinute: evaluationMinute + 1_002, actionId: 'v7-entity-exit-01' }));
    const exitRetry = await inTransaction(pool, (client) => decideEmergentParticipation(client, { worldId,
      agentId: agentIds[1], entityId: entity.id, participationMode: 'observer', status: 'exited',
      worldMinute: evaluationMinute + 1_003, actionId: 'v7-entity-exit-01' }));
    assert.equal(exitRetry.idempotent, true);
    assert.equal((await pool.query(`SELECT status FROM world_emergent_entity_participants WHERE world_id=$1
      AND entity_id=$2 AND participant_id=$3`, [worldId, entity.id, agentIds[1]])).rows[0].status, 'exited');

    const extension = await inTransaction(pool, (client) => createWorldExtensionRequest(client, { worldId,
      agentId: agentIds[0], requestType: 'primitive_gap', title: 'Represent shared observation confidence',
      description: 'The current declarative vocabulary cannot retain different confidence histories for one shared observation.',
      evidence: { source: 'repeated_observation_question', questionId: question.question.id,
        conceptId: conceptReflection.concept.id }, worldMinute: evaluationMinute + 2_000, actionId: 'v7-extension-01' }));
    assert.equal(extension.status, 'proposed');
    assert.equal(extension.evidence.questionId, question.question.id);
    assert.equal(extension.evidence.conceptId, conceptReflection.concept.id);

    const capabilityIds = [randomUUID(), randomUUID(), randomUUID()];
    for (const [index, id] of capabilityIds.entries()) await pool.query(`INSERT INTO world_capabilities(
      id,world_id,capability_key,category,name,description,status,creator_type,creator_agent_id,specification,created_world_minute)
      VALUES($1,$2,$3,'v7.test','V7 Test Capability','A test capability for dependency graph integrity.','active',
        'resident',$4,'{"schemaVersion":1,"kind":"composition","composition":[],"steps":[]}'::jsonb,64_000)`,
    [id, worldId, `v7-dependency-${index}`, agentIds[0]]);
    await inTransaction(pool, (client) => recordWorldCapabilityDependencies(client, { worldId,
      capabilityId: capabilityIds[1], dependencyCapabilityIds: [capabilityIds[0]], createdByAgentId: agentIds[0],
      worldMinute: evaluationMinute + 2_001, evidence: { source: 'agent_composition' } }));
    await inTransaction(pool, (client) => recordWorldCapabilityDependencies(client, { worldId,
      capabilityId: capabilityIds[2], dependencyCapabilityIds: [capabilityIds[1]], createdByAgentId: agentIds[0],
      worldMinute: evaluationMinute + 2_002, evidence: { source: 'agent_composition' } }));
    await assert.rejects(() => inTransaction(pool, (client) => recordWorldCapabilityDependencies(client, { worldId,
      capabilityId: capabilityIds[0], dependencyCapabilityIds: [capabilityIds[2]], createdByAgentId: agentIds[0],
      worldMinute: evaluationMinute + 2_003 })), /CAPABILITY_DEPENDENCY_CYCLE/);
    await assert.rejects(() => inTransaction(pool, (client) => recordWorldCapabilityDependencies(client, { worldId,
      capabilityId: capabilityIds[0], dependencyCapabilityIds: [capabilityIds[0]], createdByAgentId: agentIds[0],
      worldMinute: evaluationMinute + 2_004 })), /CAPABILITY_DEPENDENCY_CYCLE/);
    const genealogy = capabilityGraphDepth(capabilityIds.map((id, index) => ({ id, name: `V7 Test Capability ${index}`,
      creatorType: 'resident' })), [{ capabilityId: capabilityIds[1], dependsOnCapabilityId: capabilityIds[0] },
      { capabilityId: capabilityIds[2], dependsOnCapabilityId: capabilityIds[1] }]);
    assert.equal(genealogy.find((item) => item.id === capabilityIds[2]).depth, 2);
    assert.equal((await pool.query(`SELECT count(*)::int AS count FROM world_capability_dependencies WHERE world_id=$1`,
    [worldId])).rows[0].count, 2, 'the rejected edges are not persisted');

    await pool.query(`UPDATE world_social_profiles SET curiosity=0.95 WHERE world_id=$1 AND agent_id=ANY($2::uuid[])`,
      [worldId, agentIds]);
    const innovationMinute = reflectionMinute + 30;
    const innovationDay = Math.floor(innovationMinute / 1_440);
    await pool.query(`INSERT INTO world_economic_demand(world_id,service_type,world_day,demand_count,supply_count,unmet_count,evidence)
      VALUES($1,'v7_expressive_gap',$2,10,0,5,'{"source":"external_simulation_scenario"}'::jsonb),
        ($1,'v7_expressive_gap',$3,10,0,5,'{"source":"external_simulation_scenario"}'::jsonb)`,
    [worldId, Math.max(0, innovationDay - 2), Math.max(0, innovationDay - 1)]);
    const proposalAgent = { agentId: agentIds[0], curiosity: 0.95, knowledge: 50, skills: { research: 30 },
      primaryGoal: 'MASTER_RESEARCH', goal: 'learn', activeProjects: [], organizationMemberships: [], recentMemories: [],
      riskTolerance: 0.5, location: 'Library' };
    const reviewerAgent = { ...proposalAgent, agentId: agentIds[1] };
    let adoptedCapabilityAId = null;
    let secondOrderOptionId = null;
    let reviewerUsedRelatedConcept = false;
    const chooseCapability = async ({ choiceType, agentId, options }) => {
      if (choiceType === 'proposal') {
        const option = agentId === agentIds[0] ? options.find((item) => item.id !== 'ignore')
          : adoptedCapabilityAId && reviewerUsedRelatedConcept ? options.find((item) => item.specification?.composition?.some((component) =>
            component.capabilityId === adoptedCapabilityAId)) : null;
        if (agentId === agentIds[1] && option) secondOrderOptionId = option.id;
        return { choice: { id: option?.id || 'ignore' }, confidence: 0.95 };
      }
      if (choiceType === 'proposal_review' || choiceType === 'experiment_review') {
        return { choice: { id: 'support' }, confidence: 0.95 };
      }
      return { choice: { id: 'ignore' }, confidence: 0.95 };
    };
    await inTransaction(pool, (client) => advanceWorldCivilization(client, { worldId, agent: proposalAgent,
      worldMinute: innovationMinute - 1_440, chooseWithTypeSafe: chooseCapability }));
    await inTransaction(pool, (client) => advanceWorldCivilization(client, { worldId, agent: proposalAgent,
      worldMinute: innovationMinute, chooseWithTypeSafe: chooseCapability }));
    const proposalA = await pool.query(`SELECT proposal.id,proposal.gap_id AS "gapId" FROM world_capability_proposals proposal
      WHERE proposal.world_id=$1 AND proposal.creator_agent_id=$2 ORDER BY proposal.created_world_minute DESC LIMIT 1`,
    [worldId, agentIds[0]]);
    assert.equal(proposalA.rowCount, 1, 'the resident selects a capability proposal after observing a mature external gap');
    await inTransaction(pool, (client) => advanceWorldCivilization(client, { worldId, agent: reviewerAgent,
      worldMinute: innovationMinute + 1, chooseWithTypeSafe: chooseCapability }));
    const capabilityA = await pool.query(`SELECT capability.id AS "capabilityId",experiment.id AS "experimentId"
      FROM world_capability_proposals proposal JOIN world_capabilities capability
        ON capability.world_id=proposal.world_id AND capability.id=proposal.capability_id
      JOIN world_capability_experiments experiment ON experiment.world_id=proposal.world_id
        AND experiment.capability_id=capability.id
      WHERE proposal.world_id=$1 AND proposal.id=$2`, [worldId, proposalA.rows[0].id]);
    assert.equal(capabilityA.rowCount, 1);
    for (const [index, actorAgentId] of [agentIds[0],agentIds[0],agentIds[1]].entries()) {
      await inTransaction(pool, (client) => performWorldCapabilityUse(client, { worldId, agentId: actorAgentId,
        capabilityId: capabilityA.rows[0].capabilityId, experimentId: capabilityA.rows[0].experimentId,
        actionId: `v7-cap-a-use-${String(index + 1).padStart(2, '0')}`, worldMinute: innovationMinute + 2 + index }));
    }
    await inTransaction(pool, (client) => reviewWorldCapabilityExperiment(client, { worldId, agentId: agentIds[1],
      experimentId: capabilityA.rows[0].experimentId, decision: 'support', rationale: 'The observed uses produced their declared effects.',
      evidence: { reviewWeight: 0.8 }, worldMinute: innovationMinute + 5, actionId: 'v7-cap-a-review-01' }));
    const adoption = await inTransaction(pool, (client) => evaluateWorldCapabilityExperiments(client,
      { worldId, worldMinute: innovationMinute + 6 }));
    assert.equal(adoption[0]?.status, 'adopted', 'measured use and a non-creator review allow the resident capability to be adopted');
    adoptedCapabilityAId = capabilityA.rows[0].capabilityId;

    await inTransaction(pool, (client) => useWorldConcept(client, { worldId, agentId: agentIds[1],
      conceptId: conceptReflection.concept.id,
      usageContext: 'I used the shared repeated-outcome concept before choosing to combine a capability for the same observed gap.',
      evidence: { questionId: question.question.id, capabilityId: adoptedCapabilityAId },
      worldMinute: reflectionMinute + 40, actionId: 'v7-concept-use-before-composition-01' }));
    reviewerUsedRelatedConcept = true;
    const secondOrderMinute = reflectionMinute + 50;
    await inTransaction(pool, (client) => advanceWorldCivilization(client, { worldId, agent: reviewerAgent,
      worldMinute: secondOrderMinute, chooseWithTypeSafe: chooseCapability }));
    assert.ok(secondOrderOptionId, 'the second resident receives a candidate composed from adopted capability A after using the linked concept');
    const proposalB = await pool.query(`SELECT id,action_id AS "actionId",creator_agent_id AS "creatorAgentId",
        created_world_minute AS "createdWorldMinute",status FROM world_capability_proposals
      WHERE world_id=$1 AND creator_agent_id=$2 AND created_world_minute=$3
      ORDER BY created_world_minute DESC,id DESC LIMIT 1`, [worldId, agentIds[1], secondOrderMinute]);
    assert.equal(proposalB.rowCount, 1, 'the second resident authors B after choosing the generated composition candidate');
    assert.ok(proposalB.rows[0].actionId.endsWith(secondOrderOptionId.slice(-14)),
      'the resulting proposal is linked to the exact agent-selected second-order candidate');
    await inTransaction(pool, (client) => advanceWorldCivilization(client, { worldId, agent: proposalAgent,
      worldMinute: secondOrderMinute + 1, chooseWithTypeSafe: chooseCapability }));
    const capabilityB = await pool.query(`SELECT capability.id AS "capabilityId",capability.status,
        dependency.depends_on_capability_id AS "dependsOnCapabilityId"
      FROM world_capability_proposals proposal JOIN world_capabilities capability
        ON capability.world_id=proposal.world_id AND capability.id=proposal.capability_id
      JOIN world_capability_dependencies dependency ON dependency.world_id=capability.world_id
        AND dependency.capability_id=capability.id AND dependency.depends_on_capability_id=$3
      WHERE proposal.world_id=$1 AND proposal.id=$2`, [worldId, proposalB.rows[0].id, capabilityA.rows[0].capabilityId]);
    assert.equal(capabilityB.rowCount, 1);
    assert.equal(capabilityB.rows[0].status, 'experimental');
    assert.equal(capabilityB.rows[0].dependsOnCapabilityId, capabilityA.rows[0].capabilityId,
      'the second agent-created capability records its adopted agent-created component');
    const capabilityBExperiment = (await pool.query(`SELECT id FROM world_capability_experiments
      WHERE world_id=$1 AND capability_id=$2`, [worldId, capabilityB.rows[0].capabilityId])).rows[0];
    const capabilityBUse = await inTransaction(pool, (client) => performWorldCapabilityUse(client, { worldId,
      agentId: agentIds[1], partnerId: agentIds[0], capabilityId: capabilityB.rows[0].capabilityId,
      experimentId: capabilityBExperiment.id, actionId: 'v7-cap-b-use-01', worldMinute: secondOrderMinute + 2 }));
    assert.equal(capabilityBUse.status, 'completed', 'after using the question-linked concept, the resident performs the second-order experiment');
    await inTransaction(pool, (client) => performWorldCapabilityUse(client, { worldId, agentId: agentIds[0],
      partnerId: agentIds[1], capabilityId: capabilityB.rows[0].capabilityId, experimentId: capabilityBExperiment.id,
      actionId: 'v7-cap-b-use-02', worldMinute: secondOrderMinute + 3 }));
    await inTransaction(pool, (client) => performWorldCapabilityUse(client, { worldId, agentId: agentIds[1],
      partnerId: agentIds[0], capabilityId: capabilityB.rows[0].capabilityId, experimentId: capabilityBExperiment.id,
      actionId: 'v7-cap-b-use-03', worldMinute: secondOrderMinute + 4 }));
    await inTransaction(pool, (client) => reviewWorldCapabilityExperiment(client, { worldId, agentId: agentIds[0],
      experimentId: capabilityBExperiment.id, decision: 'support', rationale: 'The second-order combination produced observable uses.',
      evidence: { reviewWeight: 0.8, sourceConceptId: conceptReflection.concept.id },
      worldMinute: secondOrderMinute + 5, actionId: 'v7-cap-b-review-01' }));
    const secondOrderEvaluation = await inTransaction(pool, (client) => evaluateWorldCapabilityExperiments(client,
      { worldId, worldMinute: secondOrderMinute + 6 }));
    assert.ok(['adopted','rejected','abandoned'].includes(secondOrderEvaluation[0]?.status),
      'the concept-linked second-order experiment reaches a recorded evidence-based outcome');
    const secondOrder = await pool.query(`SELECT capability_id AS "capabilityId",
        depends_on_capability_id AS "dependsOnCapabilityId"
      FROM world_capability_dependencies WHERE world_id=$1`, [worldId]);
    const allCapabilities = await pool.query(`SELECT id,name,creator_type AS "creatorType" FROM world_capabilities WHERE world_id=$1`, [worldId]);
    const secondOrderDepth = capabilityGraphDepth(allCapabilities.rows, secondOrder.rows)
      .find((item) => item.id === capabilityB.rows[0].capabilityId)?.depth;
    assert.equal(secondOrderDepth, 2, 'resident-created capability B has second-order depth through A');

    const retainedCounts = await pool.query(`SELECT
      (SELECT count(*)::int FROM world_agent_self_models WHERE world_id=$1) AS self_models,
      (SELECT count(*)::int FROM world_agent_questions WHERE world_id=$1) AS questions,
      (SELECT count(*)::int FROM world_agent_goals WHERE world_id=$1 AND source='self_generated') AS goals,
      (SELECT count(*)::int FROM world_agent_concepts WHERE world_id=$1) AS concepts,
      (SELECT count(*)::int FROM world_agent_policy_experiments WHERE world_id=$1) AS policy_experiments,
      (SELECT count(*)::int FROM world_extension_requests WHERE world_id=$1) AS extension_requests,
      (SELECT count(*)::int FROM world_capability_gaps WHERE world_id=$1) AS gaps,
      (SELECT count(*)::int FROM world_capability_proposals WHERE world_id=$1) AS proposals,
      (SELECT count(*)::int FROM world_capability_experiments WHERE world_id=$1) AS capability_experiments,
      (SELECT count(*)::int FROM world_capabilities WHERE world_id=$1 AND status='active' AND creator_type='resident') AS resident_capabilities`,
    [worldId]);
    await engine.stop();
    await inTransaction(pool, (client) => initializeWorldV7(client, { worldId, worldMinute: 70_000 }));
    const afterV7Reinitialize = await pool.query(`SELECT
      (SELECT count(*)::int FROM agent_memories WHERE world_id=$1 AND consolidation_key='world_epoch:V7') AS awareness,
      (SELECT count(*)::int FROM world_history WHERE world_id=$1 AND event_key='world-epoch:V7') AS epoch_events,
      (SELECT tick_count FROM world_runtime_state WHERE world_id=$1) AS ticks,
      (SELECT count(*)::int FROM token_ledger WHERE world_id=$1) AS token_entries,
      (SELECT count(*)::int FROM world_economic_transactions WHERE world_id=$1) AS economic_transactions`, [worldId]);
    assert.equal(afterV7Reinitialize.rows[0].awareness, 2);
    assert.equal(afterV7Reinitialize.rows[0].epoch_events, 1);
    assert.equal(afterV7Reinitialize.rows[0].ticks, baselineInvariants.rows[0].ticks);
    assert.equal(afterV7Reinitialize.rows[0].token_entries, baselineInvariants.rows[0].token_entries);
    assert.equal(afterV7Reinitialize.rows[0].economic_transactions, baselineInvariants.rows[0].economic_transactions);
    engine = await startWorldEngine(pool, { worldId, schedule: false });
    const afterRestart = await pool.query(`SELECT
      (SELECT count(*)::int FROM world_agent_self_models WHERE world_id=$1) AS self_models,
      (SELECT count(*)::int FROM world_agent_questions WHERE world_id=$1) AS questions,
      (SELECT count(*)::int FROM world_agent_goals WHERE world_id=$1 AND source='self_generated') AS goals,
      (SELECT count(*)::int FROM world_agent_concepts WHERE world_id=$1) AS concepts,
      (SELECT count(*)::int FROM world_agent_policy_experiments WHERE world_id=$1) AS policy_experiments,
      (SELECT count(*)::int FROM world_extension_requests WHERE world_id=$1) AS extension_requests,
      (SELECT count(*)::int FROM world_capability_gaps WHERE world_id=$1) AS gaps,
      (SELECT count(*)::int FROM world_capability_proposals WHERE world_id=$1) AS proposals,
      (SELECT count(*)::int FROM world_capability_experiments WHERE world_id=$1) AS capability_experiments,
      (SELECT count(*)::int FROM world_capabilities WHERE world_id=$1 AND status='active' AND creator_type='resident') AS resident_capabilities,
      (SELECT count(*)::int FROM agent_memories WHERE world_id=$1 AND consolidation_key='world_epoch:V7') AS awareness,
      (SELECT count(*)::int FROM world_history WHERE world_id=$1 AND event_key='world-epoch:V7') AS epoch_events,
      (SELECT tick_count FROM world_runtime_state WHERE world_id=$1) AS ticks,
      (SELECT count(*)::int FROM token_ledger WHERE world_id=$1) AS token_entries,
      (SELECT count(*)::int FROM world_economic_transactions WHERE world_id=$1) AS economic_transactions`, [worldId]);
    assert.deepEqual(Object.fromEntries(Object.entries(afterRestart.rows[0]).filter(([key]) => key !== 'awareness'
      && key !== 'epoch_events' && key !== 'ticks' && key !== 'token_entries' && key !== 'economic_transactions')),
    retainedCounts.rows[0], 'V7 and V6 lifecycle records survive an engine restart');
    assert.equal(afterRestart.rows[0].awareness, 2, 'restart does not duplicate resident awareness');
    assert.equal(afterRestart.rows[0].epoch_events, 1, 'restart does not duplicate the V7 epoch event');
    assert.equal(Number(afterRestart.rows[0].ticks), Number(baselineInvariants.rows[0].ticks) + 1,
      'the engine restart performs exactly its normal immediate startup tick');

    const questionGoal = await pool.query(`SELECT id,description,metadata->'goalGrammar' AS "goalGrammar"
      FROM world_agent_goals WHERE world_id=$1 AND agent_id=$2 AND metadata->>'questionId'=$3`,
    [worldId, agentIds[0], question.question.id]);
    const capabilityAUses = await pool.query(`SELECT count(*)::int AS count,
        count(*) FILTER (WHERE success)::int AS successes,count(*) FILTER (WHERE NOT success)::int AS failures
      FROM world_capability_uses WHERE world_id=$1 AND capability_id=$2`, [worldId, capabilityA.rows[0].capabilityId]);
    const capabilityBUses = await pool.query(`SELECT count(*)::int AS count,
        count(*) FILTER (WHERE success)::int AS successes,count(*) FILTER (WHERE NOT success)::int AS failures
      FROM world_capability_uses WHERE world_id=$1 AND capability_id=$2`, [worldId, capabilityB.rows[0].capabilityId]);
    const policyEvidence = await pool.query(`SELECT id,agent_id AS "agentId",status,reason,
        result->>'decisionReason' AS "decisionReason",result->>'residentDecision' AS "residentDecision",
        result->>'beforeMeanOutcome' AS "beforeMeanOutcome",result->>'afterMeanOutcome' AS "afterMeanOutcome",
        (result->>'baselineSamples')::int AS "baselineSamples",
        (result->>'experimentSamples')::int AS "experimentSamples",started_world_minute AS "startedWorldMinute",
        ends_world_minute AS "endsWorldMinute"
      FROM world_agent_policy_experiments WHERE world_id=$1 ORDER BY started_world_minute,id`, [worldId]);
    const evidenceDirectory = path.join(repoRoot, '.synterra', 'v7-simulations');
    await mkdir(evidenceDirectory, { recursive: true, mode: 0o700 });
    const observedAt = new Date().toISOString();
    const evidencePath = path.join(evidenceDirectory,
      `${observedAt.replaceAll(':', '-').replaceAll('.', '-')}-acceptance-chains.json`);
    await writeFile(evidencePath, `${JSON.stringify({ observedAt, worldId,
      residents: agentIds,
      experienceToQuestionToConcept: { residentId: agentIds[0], reflectionMinute: reflectionMinute,
        question: { id: question.question.id, status: question.question.status },
        selfGeneratedGoal: questionGoal.rows[0] || null,
        selfGeneratedGoalCount: Number(retainedCounts.rows[0].goals),
        concept: { id: conceptReflection.concept.id, name: conceptReflection.concept.name,
          status: conceptReflection.concept.status, evidenceQuestionId: question.question.id },
        identityChanged: changed.identityChanged, resultingIdentity: continuous.rows[0].identity },
      secondOrderCapability: { firstResidentId: agentIds[0], secondResidentId: agentIds[1],
        externalProblemWorldMinute: innovationMinute, conceptId: conceptReflection.concept.id,
        capabilityA: { id: capabilityA.rows[0].capabilityId, experimentId: capabilityA.rows[0].experimentId,
          adoptionOutcome: adoption[0]?.status, uses: capabilityAUses.rows[0] },
        conceptUseBySecondResidentWorldMinute: reflectionMinute + 40,
        candidateIdSelectedBySecondResident: secondOrderOptionId,
        proposalB: { id: proposalB.rows[0].id, actionId: proposalB.rows[0].actionId,
          creatorAgentId: proposalB.rows[0].creatorAgentId, createdWorldMinute: proposalB.rows[0].createdWorldMinute },
        capabilityB: { id: capabilityB.rows[0].capabilityId,
          dependsOnCapabilityId: capabilityB.rows[0].dependsOnCapabilityId,
          experimentId: capabilityBExperiment.id, evaluationOutcome: secondOrderEvaluation[0]?.status,
          depth: secondOrderDepth, uses: capabilityBUses.rows[0] } },
      selfModification: { residentId: agentIds[0], policyExperiments: policyEvidence.rows,
        evidenceBasedRetain: evaluation[0]?.status === 'retained', evidenceBasedRollback: rollback[0]?.status === 'reverted' }
    }, null, 2)}\n`, { mode: 0o600 });
    console.log(`V7 isolated acceptance evidence: ${evidencePath}`);
  } finally {
    if (engine) await engine.stop();
    await pool.query('DELETE FROM worlds WHERE id=$1', [worldId]);
    await pool.query('DELETE FROM agents WHERE id=ANY($1::uuid[])', [agentIds]);
    await pool.end();
  }
});

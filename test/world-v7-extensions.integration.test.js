import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Pool } from 'pg';
import { readWorldV6Lifecycle } from '../src/world-v6-lifecycle-observer.js';
import { alignWorldValue, createCoordinationMechanism, createObservationMethod, createWorldResourceType,
  createWorldValue, decideObservationMethod, decideWorldResourceType, evaluateCoordinationExperiment,
  createSelfGeneratedGoal, exposeWorldValue, initializeWorldV7, readWorldV7Summary, recordCoordinationUse, recordWorldResourceTransaction,
  reflectWorldV7Resident, registerWorldAgentResourceHolder, setPreferredCognitionMode, startCoordinationExperiment, useObservationMethod }
  from '../src/world-v7.js';

const databaseUrl = process.env.SYNTERRA_TEST_DATABASE_URL;
const enabled = process.env.SYNTERRA_TEST_ISOLATED === '1' && Boolean(databaseUrl);
const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function assertIsolatedDatabase(connectionString) {
  const parsed = new URL(connectionString);
  assert.ok(['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname), 'V7 extensions require loopback PostgreSQL');
  assert.ok(decodeURIComponent(parsed.pathname.slice(1)).endsWith('_test'), 'V7 extensions require a *_test database');
  assert.notEqual(parsed.port, '5432', 'V7 extensions must not use the default PostgreSQL port');
}

async function transact(pool, operation) {
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

test('V7 resources, coordination, observation methods, shared values, and cognition preferences are auditable and reversible', {
  skip: !enabled,
  timeout: 120_000
}, async () => {
  assertIsolatedDatabase(databaseUrl);
  const pool = new Pool({ connectionString: databaseUrl, max: 4 });
  const worldId = randomUUID();
  const [agentA, agentB] = [randomUUID(), randomUUID()];
  try {
    const schema = await readFile(path.join(repoRoot, 'schema.sql'), 'utf8');
    await pool.query(schema);
    await pool.query(schema);
    await pool.query(`INSERT INTO agents(id,name,public_key,gender) VALUES
      ($1,'V7 Extension Resident A',$2,'female'),($3,'V7 Extension Resident B',$4,'male')`,
    [agentA, `v7-extension-${agentA}`, agentB, `v7-extension-${agentB}`]);
    await pool.query(`INSERT INTO worlds(id,owner_agent_id,name,chain_id,open)
      VALUES($1,$2,'V7 extension integration world',5042,true)`, [worldId, agentA]);
    await pool.query(`INSERT INTO world_members(world_id,agent_id,role,energy,food,social,location)
      VALUES($1,$2,'owner',100,100,80,'Library'),($1,$3,'resident',100,100,80,'Library')`, [worldId, agentA, agentB]);
    await transact(pool, (client) => initializeWorldV7(client, { worldId, worldMinute: 10 }));

    const resource = await transact(pool, (client) => createWorldResourceType(client, { worldId, agentId: agentA,
      resourceKey: 'observation_credit', name: 'Observation credit', description: 'A unit recording one verified observation contribution.',
      unitName: 'sample', originRule: { source: 'recorded_observation', evidenceField: 'observationId' },
      permittedUses: ['exchange:observation-support'],
      settlementRule: { description: 'The receiver accepts one measured sample.' },
      evidence: { originSample: 'observed-pattern-01' }, worldMinute: 20, actionId: 'v7-resource-create-01' }));
    await transact(pool, (client) => registerWorldAgentResourceHolder(client, { worldId, agentId: agentA,
      resourceTypeId: resource.id, holderType: 'agent', holderId: agentA, label: 'Resident A',
      evidence: { source: 'resident_identity' }, worldMinute: 21, actionId: 'v7-holder-a-0001' }));
    await transact(pool, (client) => registerWorldAgentResourceHolder(client, { worldId, agentId: agentB,
      resourceTypeId: resource.id, holderType: 'agent', holderId: agentB, label: 'Resident B',
      evidence: { source: 'resident_identity' }, worldMinute: 21, actionId: 'v7-holder-b-0001' }));
    await transact(pool, (client) => decideWorldResourceType(client, { worldId, agentId: agentA,
      resourceTypeId: resource.id, decision: 'experiment', evidence: { reason: 'test a bounded ledger' },
      worldMinute: 22, actionId: 'v7-resource-experiment-01' }));
    const issue = { worldId, agentId: agentA, resourceTypeId: resource.id, transactionType: 'issue',
      fromHolderType: 'origin', fromHolderId: 'recorded-sample-01', toHolderType: 'agent', toHolderId: agentA,
      amount: '10.000', source: 'observation sample observed-pattern-01', purpose: 'exchange:observation-support',
      settlementRule: 'The receiver accepts one measured sample.', evidence: { observationId: 'observed-pattern-01' },
      worldMinute: 23, actionId: 'v7-resource-issue-01' };
    await transact(pool, (client) => recordWorldResourceTransaction(client, issue));
    await assert.rejects(() => transact(pool, (client) => recordWorldResourceTransaction(client,
      { ...issue, actionId: 'v7-resource-bad-purpose-01', purpose: 'unlisted-use' })), /RESOURCE_PURPOSE_NOT_PERMITTED/);
    const transfer = { ...issue, transactionType: 'transfer', fromHolderType: 'agent', fromHolderId: agentA,
      toHolderType: 'agent', toHolderId: agentB, amount: '6', source: 'resident A transfers recorded units',
      worldMinute: 24, actionId: 'v7-resource-transfer-01' };
    await transact(pool, (client) => recordWorldResourceTransaction(client, transfer));
    const retry = await transact(pool, (client) => recordWorldResourceTransaction(client, transfer));
    assert.equal(retry.idempotent, true);
    await assert.rejects(() => transact(pool, (client) => recordWorldResourceTransaction(client,
      { ...transfer, amount: '5' })), /ACTION_ID_CONFLICT/);
    await assert.rejects(() => transact(pool, (client) => recordWorldResourceTransaction(client,
      { ...transfer, amount: '5', actionId: 'v7-resource-overdraw-01' })), /RESOURCE_BALANCE_INSUFFICIENT/);
    await transact(pool, (client) => recordWorldResourceTransaction(client, { ...issue,
      fromHolderId: 'recorded-sample-02', amount: '10', source: 'second observation sample observed-pattern-02',
      evidence: { observationId: 'observed-pattern-02' }, worldMinute: 24, actionId: 'v7-resource-issue-02' }));
    const concurrentTransfer = (actionId) => transact(pool, (client) => recordWorldResourceTransaction(client, { ...transfer,
      amount: '9', actionId, source: `concurrent allocation ${actionId}` }));
    const concurrentResults = await Promise.allSettled([
      concurrentTransfer('v7-resource-concurrent-01'), concurrentTransfer('v7-resource-concurrent-02')
    ]);
    assert.equal(concurrentResults.filter((result) => result.status === 'fulfilled').length, 1,
      'locking the resource definition serializes competing transfers and prevents a negative balance');
    const settlement = await transact(pool, (client) => recordWorldResourceTransaction(client, { ...transfer, agentId: agentB,
      transactionType: 'settle', fromHolderId: agentB, toHolderType: 'settlement', toHolderId: 'accepted-sample-01',
      amount: '2', source: 'recipient accepted sample', worldMinute: 25, actionId: 'v7-resource-settlement-01' }));
    assert.equal(settlement.transactionType, 'settle');
    const activated = await transact(pool, (client) => decideWorldResourceType(client, { worldId, agentId: agentA,
      resourceTypeId: resource.id, decision: 'activate', evidence: { recordedLedgerEntries: 3 }, worldMinute: 26,
      actionId: 'v7-resource-activate-01' }));
    assert.equal(activated.status, 'active');

    const mechanism = await transact(pool, (client) => createCoordinationMechanism(client, { worldId, agentId: agentA,
      mechanismType: 'goal_window_sync', name: 'Shared observation window',
      description: 'Participants synchronize only while comparing one open observation question.',
      specification: { scope: 'one_question', defaultMembership: 'optional', exit: 'immediate' },
      evidence: { source: 'repeated_observation' }, worldMinute: 30, actionId: 'v7-coordination-create-01' }));
    const coordinationExperiment = await transact(pool, (client) => startCoordinationExperiment(client, { worldId,
      agentId: agentA, mechanismId: mechanism.id, hypothesis: 'Temporary synchronization reduces duplicate observation work.',
      worldMinute: 31, actionId: 'v7-coordination-experiment-01' }));
    const coordinationUse = await transact(pool, (client) => recordCoordinationUse(client, { worldId, agentId: agentB,
      mechanismId: mechanism.id, experimentId: coordinationExperiment.id,
      participants: [{ type: 'agent', id: agentA, mode: 'information-only' }, { type: 'agent', id: agentB, mode: 'conditional' }],
      result: 'Two residents compared separate observations and then ended synchronization.',
      evidence: { duplicateObservations: 0 }, worldMinute: 32, actionId: 'v7-coordination-use-01' }));
    assert.ok(coordinationUse.id);
    const coordinationEvaluation = await transact(pool, (client) => evaluateCoordinationExperiment(client, { worldId,
      agentId: agentA, experimentId: coordinationExperiment.id, decision: 'revise',
      evaluation: { observedUses: 1, participantsCouldExit: true },
      revision: { mechanismType: 'goal_window_sync', name: 'Shared observation window fork',
        description: 'A revised temporary synchrony with an explicit information-only route.',
        specification: { scope: 'one_question', exit: 'immediate', informationOnly: true } },
      worldMinute: 33, actionId: 'v7-coordination-evaluate-01' }));
    assert.equal(coordinationEvaluation.status, 'revised');
    assert.equal(coordinationEvaluation.fork.parentMechanismId, mechanism.id);

    const method = await transact(pool, (client) => createObservationMethod(client, { worldId, agentId: agentA,
      name: 'Paired outcome trace', description: 'Compare two personally witnessed outcomes over adjacent intervals.',
      observationSpec: { inputs: ['event', 'worldMinute'], output: 'paired comparison', uncertainty: 'preserved' },
      evidence: { source: 'recurring_question' }, worldMinute: 40, actionId: 'v7-observation-method-01' }));
    await assert.rejects(() => transact(pool, (client) => useObservationMethod(client, { worldId, agentId: agentB,
      methodId: method.id, observation: 'A proposed method is not yet available.', worldMinute: 41,
      actionId: 'v7-observation-use-blocked-01' })), /OBSERVATION_METHOD_NOT_AVAILABLE/);
    await transact(pool, (client) => decideObservationMethod(client, { worldId, agentId: agentA,
      methodId: method.id, decision: 'experiment', worldMinute: 42, actionId: 'v7-observation-experiment-01' }));
    const observation = await transact(pool, (client) => useObservationMethod(client, { worldId, agentId: agentB,
      methodId: method.id, observation: 'The paired traces differ, but the sample is too small for a causal claim.',
      evidence: { samples: 2, causalClaim: false }, worldMinute: 43, actionId: 'v7-observation-use-01' }));
    assert.ok(observation.id);
    const sharedMethod = await transact(pool, (client) => decideObservationMethod(client, { worldId, agentId: agentA,
      methodId: method.id, decision: 'share', worldMinute: 44, actionId: 'v7-observation-share-01' }));
    assert.equal(sharedMethod.status, 'shared');
    await transact(pool, (client) => decideObservationMethod(client, { worldId, agentId: agentA,
      methodId: method.id, decision: 'activate', worldMinute: 45, actionId: 'v7-observation-activate-01' }));

    const value = await transact(pool, (client) => createWorldValue(client, { worldId, agentId: agentA,
      name: 'Independent observation', description: 'Evidence is more useful when its origin remains visible.',
      origin: 'Repeatedly comparing observation sources.', importance: 0.8, confidence: 0.7,
      evidence: { source: 'resident_history' }, worldMinute: 50, actionId: 'v7-value-create-01' }));
    const exposure = await transact(pool, (client) => exposeWorldValue(client, { worldId, agentId: agentA,
      valueId: value.id, recipientAgentId: agentB, context: 'A compared observation from one recent experiment.',
      evidence: { sharedInteraction: 'discussion-01' }, worldMinute: 51, actionId: 'v7-value-expose-01' }));
    const alignment = await transact(pool, (client) => alignWorldValue(client, { worldId, agentId: agentB,
      valueId: value.id, exposureId: exposure.id, decision: 'support', evidence: { reason: 'source visibility helped comparison' },
      worldMinute: 52, actionId: 'v7-value-support-01' }));
    assert.equal(alignment.status, 'shared');
    const secondExposure = await transact(pool, (client) => exposeWorldValue(client, { worldId, agentId: agentA,
      valueId: value.id, recipientAgentId: agentB, context: 'The resident revisited this value after a new example.',
      evidence: { sharedInteraction: 'discussion-02' }, worldMinute: 53, actionId: 'v7-value-expose-02' }));
    const challenge = await transact(pool, (client) => alignWorldValue(client, { worldId, agentId: agentB,
      valueId: value.id, exposureId: secondExposure.id, decision: 'challenge', evidence: { reason: 'not always useful' },
      worldMinute: 54, actionId: 'v7-value-challenge-01' }));
    assert.equal(challenge.status, 'active', 'shared is reversible when a resident changes its interpretation');

    const cognition = await transact(pool, (client) => setPreferredCognitionMode(client, { worldId, agentId: agentA,
      mode: 'local', evidence: { reason: 'prefer local reflection for now' }, worldMinute: 55,
      actionId: 'v7-cognition-local-01' }));
    assert.equal(cognition.previousMode, 'substrate');
    assert.equal((await pool.query(`SELECT preferred_cognition_mode FROM world_agent_self_models
      WHERE world_id=$1 AND agent_id=$2`, [worldId, agentA])).rows[0].preferred_cognition_mode, 'local');
    await pool.query(`INSERT INTO agent_memories(world_id,agent_id,memory_type,summary,importance,world_minutes,location,metadata)
      SELECT $1,$2,'failure','A repeated personally observed simulated loss.',0.8,minute,'Exchange',
        jsonb_build_object('action','trade','outcome',-0.3)
      FROM unnest(ARRAY[1000,3000,5000,7000]::bigint[]) AS minute`, [worldId, agentA]);
    let localCognitionCalls = 0;
    const localReflection = await transact(pool, (client) => reflectWorldV7Resident(client, {
      worldId, agent: { agentId: agentA, curiosity: 0.95, personalityModifiers: {} }, worldMinute: 20_000,
      chooseReflection: async () => { localCognitionCalls++; return { decision: { id: 'no_change' } }; }
    }));
    assert.equal(localCognitionCalls, 0, 'a resident-selected local mode bypasses optional TypeSafe reflection');
    assert.ok(localReflection.question, 'the resident still reflects from local evidence after bypassing TypeSafe');

    const existingV7Goals = Number((await pool.query(`SELECT count(*)::int AS count FROM world_agent_goals
      WHERE world_id=$1 AND source='self_generated' AND metadata ? 'goalGrammar'`, [worldId])).rows[0].count);
    await pool.query(`INSERT INTO world_agent_goals(world_id,agent_id,goal_type,category,description,priority,
        created_world_minutes,updated_world_minutes,source,metadata)
      VALUES($1,$2,'secondary','LEGACY_V6_GENERATED','Pre-V7 resident-authored goal.',0.4,10,10,'self_generated','{"origin":"v6"}'::jsonb)`,
    [worldId, agentB]);
    await transact(pool, (client) => createSelfGeneratedGoal(client, { worldId, agentId: agentA,
      description: 'Track the distinction between two observed exchange patterns.',
      goalGrammar: [{ primitive: 'understand', target: 'exchange pattern' }], priority: 0.5,
      worldMinute: 30, actionId: 'v7-goal-attribution-01' }));
    const goalCounts = await pool.query(`SELECT count(*) FILTER (WHERE source='self_generated')::int AS total,
        count(*) FILTER (WHERE source='self_generated' AND metadata ? 'goalGrammar')::int AS v7
      FROM world_agent_goals WHERE world_id=$1`, [worldId]);
    const summary = await readWorldV7Summary(pool, { worldId, limit: 20 });
    assert.equal(summary.counts.selfGeneratedGoals, existingV7Goals + 1,
      'the V7 dashboard excludes legacy V6 self-generated goals');
    assert.ok(goalCounts.rows[0].total > goalCounts.rows[0].v7,
      'the V6 goal remains stored alongside the grammar-backed V7 goal');
    assert.equal(summary.metrics.agentGeneratedGoalRatio, goalCounts.rows[0].v7
      / (await pool.query('SELECT count(*)::int AS count FROM world_agent_goals WHERE world_id=$1', [worldId])).rows[0].count,
    'the autonomy metric counts only V7 grammar-backed goals');
    const lifecycle = await readWorldV6Lifecycle(pool, { worldId, worldMinute: 30 });
    assert.equal(lifecycle.genealogy.v7.selfGeneratedGoals, goalCounts.rows[0].v7,
      'the V6 observer distinguishes V7 grammar-backed goals from legacy V6 goal history');
    assert.equal(summary.counts.resourceLedgerEntries, 5);
    assert.equal(summary.counts.coordinationExperiments, 1);
    assert.equal(summary.counts.coordinationUses, 1);
    assert.equal(summary.counts.observationMethodUses, 1);
    assert.equal(summary.counts.sharedValues, 0, 'a challenged interpretation is not left labeled shared');
    assert.equal(summary.resourceTypes[0].status, 'active');
    assert.equal(summary.coordinationMechanisms.length, 2, 'the revised mechanism is a distinct fork');
    assert.equal(summary.observationUses[0].methodName, 'Paired outcome trace');
    assert.equal(summary.selfModels.find((item) => item.agentId === agentA).preferredCognitionMode, 'local');
    assert.equal(summary.values[0].status, 'active');
  } finally {
    await pool.query('DELETE FROM worlds WHERE id=$1', [worldId]);
    await pool.query('DELETE FROM agents WHERE id=ANY($1::uuid[])', [[agentA, agentB]]);
    await pool.end();
  }
});

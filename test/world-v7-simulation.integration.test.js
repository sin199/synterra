import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { advanceWorldV7, applyAgentDecisionPolicy, initializeWorldV7, readWorldV7Summary, reflectWorldV7Resident,
  WORLD_V7_REFLECTION_INTERVAL_MINUTES } from '../src/world-v7.js';

const databaseUrl = process.env.SYNTERRA_TEST_DATABASE_URL;
const enabled = process.env.SYNTERRA_TEST_ISOLATED === '1' && Boolean(databaseUrl);
const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SIGNALS = [0, 0.1, 0.4, 0.6, 0.8, 0.9, 1];
const CURIOSITIES = [0.18, 0.32, 0.44, 0.56, 0.61, 0.67, 0.73, 0.81, 0.9, 0.96];
const simulationSeeds = Array.from({ length: 10 }, (_value, index) => index + 1);

function assertIsolatedDatabase(connectionString) {
  const parsed = new URL(connectionString);
  assert.ok(['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname), 'V7 simulations require loopback PostgreSQL');
  assert.ok(decodeURIComponent(parsed.pathname.slice(1)).endsWith('_test'), 'V7 simulations require a *_test database');
  assert.notEqual(parsed.port, '5432', 'V7 simulations must not use the default PostgreSQL port');
}

function deterministicUuid(label) {
  const chars = createHash('sha256').update(label).digest('hex').slice(0, 32).split('');
  chars[12] = '4';
  chars[16] = ((Number.parseInt(chars[16], 16) & 3) | 8).toString(16);
  const hex = chars.join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
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

function policyChoice({ options, activeGoalPrimitives, recurringOutcomes }, { curiosity, plan }) {
  const option = (id) => options.find((item) => item.id === id);
  const metaGoal = options.find((item) => item.id === 'form_meta_goal' || item.id.startsWith('form_meta_goal_pause_'));
  if (curiosity < 0.62 || !recurringOutcomes.length) return option('no_change');
  if (!activeGoalPrimitives.includes('understand') && option('explore_question')) return option('explore_question');
  if (plan === 1 && option('create_concept')) return option('create_concept');
  if (activeGoalPrimitives.includes('understand') && !activeGoalPrimitives.includes('change_self') && metaGoal) return metaGoal;
  if (plan === 0 && option('reinterpret_identity')) return option('reinterpret_identity');
  if (activeGoalPrimitives.includes('change_self') && option('experiment_policy')) return option('experiment_policy');
  if (option('create_concept')) return option('create_concept');
  return option('no_change');
}

async function recordExternalDay(pool, { worldId, seed, day, worldMinute, residents, policyRows }) {
  const policyByAgent = new Map(policyRows.map((row) => [row.agent_id, {
    policy: row.policy, activeExperiment: row.active_experiment_id !== null,
    version: Number(row.version) || 1, source: row.source || 'substrate'
  }]));
  const experiences = residents.map((resident) => {
    const signal = SIGNALS[(day - 1 + seed + resident.index) % SIGNALS.length];
    const state = policyByAgent.get(resident.agentId) || { policy: {}, activeExperiment: false, version: 1, source: 'substrate' };
    const baseResearchScore = state.activeExperiment && resident.experimentMode === 'insufficient' ? 49
      : 50;
    const candidates = [
      applyAgentDecisionPolicy({ action: 'business_market_observe', score: baseResearchScore + signal }, state.policy),
      applyAgentDecisionPolicy({ action: 'learn', score: 49.8 }, state.policy)
    ].sort((left, right) => right.score - left.score || left.action.localeCompare(right.action));
    const action = candidates[0].action;
    let outcome = action === 'learn' ? 0.12 : resident.hasRecurringProblem
      ? (signal >= 0.7 ? 0.2 : -0.5) : 0.18;
    if (state.activeExperiment && resident.experimentMode === 'worse' && action === 'business_market_observe') outcome = -0.45;
    if (state.activeExperiment && resident.experimentMode === 'insufficient' && action === 'business_market_observe') outcome = -0.4;
    const utilityScores = Object.fromEntries(candidates.map((candidate) => [candidate.action, candidate.score]));
    return { agentId: resident.agentId, action, outcome, signal, utilityScores,
      decisionPolicyVersion: state.version, decisionPolicySource: state.source, worldMinute,
      actionId: `v7-sim:${seed}:day:${day}:${resident.index}`, seed, day,
      experimentMode: resident.experimentMode, source: 'external_deterministic_market_scenario' };
  });
  const input = experiences.map(({ agentId, worldMinute, actionId, experimentMode, decisionPolicyVersion,
    decisionPolicySource, utilityScores, ...item }) => ({
    ...item, agent_id: agentId, world_minute: worldMinute, action_id: actionId, experiment_mode: experimentMode,
    decision_policy_version: decisionPolicyVersion, decision_policy_source: decisionPolicySource,
    utility_scores: utilityScores
  }));
  await pool.query(`WITH input AS (
      SELECT * FROM jsonb_to_recordset($2::jsonb) AS item(
        agent_id uuid,action text,outcome numeric,signal numeric,world_minute bigint,action_id text,
        seed integer,day integer,experiment_mode text,source text,decision_policy_version integer,
        decision_policy_source text,utility_scores jsonb)
    ), decision_traces AS (
      INSERT INTO world_decision_traces(world_id,agent_id,tick_count,world_minutes,chosen_candidate_id,chosen_action,
          behavior_probability,distribution,utility_scores,goal_snapshot,rationale,decision_policy_version,
          decision_policy_source,source_key)
      SELECT $1,input.agent_id,input.day,input.world_minute,input.action,input.action,1,
        jsonb_build_object('source','external_deterministic_market_scenario','seed',input.seed),
        input.utility_scores,'{}'::jsonb,
        jsonb_build_object('marketSignal',input.signal,'policySource',input.decision_policy_source,
          'policyVersion',input.decision_policy_version,'experimentMode',input.experiment_mode),
        input.decision_policy_version,input.decision_policy_source,input.action_id
      FROM input ON CONFLICT(world_id,source_key) WHERE source_key IS NOT NULL DO NOTHING RETURNING id
    ), inserted_events AS (
      INSERT INTO world_events(world_id,actor_id,event_type,data,action_id)
      SELECT $1,input.agent_id,'simulated_action_completed',
        jsonb_build_object('action',input.action,'outcome',input.outcome,'marketSignal',input.signal,
          'seed',input.seed,'day',input.day,'worldMinute',input.world_minute,
          'experimentMode',input.experiment_mode,'source',input.source),input.action_id
      FROM input CROSS JOIN (SELECT count(*) AS recorded FROM decision_traces) traces
      ON CONFLICT(world_id,actor_id,action_id) DO NOTHING
      RETURNING id,actor_id,action_id,data
    )
    INSERT INTO agent_memories(world_id,agent_id,memory_type,summary,importance,world_minutes,location,metadata,source_event_id)
    SELECT $1,event.actor_id,CASE WHEN event.data->>'action'='business_market_observe'
          AND (event.data->>'outcome')::numeric < -0.05 THEN 'failure'
        WHEN event.data->>'action'='learn' THEN 'learning' ELSE event.data->>'action' END,
      CASE WHEN event.data->>'action'='business_market_observe' THEN 'Market research observation completed with a recorded outcome.'
        ELSE 'Simulated observation action completed with a recorded outcome.' END,
      0.64,(event.data->>'day')::bigint*1440,'Exchange',
      event.data||jsonb_build_object('action',event.data->>'action','outcome',(event.data->>'outcome')::numeric,
      'worldMinute',(event.data->>'worldMinute')::bigint,'uncertainty','external outcome does not establish cause'),event.id
    FROM inserted_events event`, [worldId, JSON.stringify(input)]);
  return experiences;
}

async function setupSimulationWorld(pool, seed) {
  const worldId = deterministicUuid(`synterra-v7-simulation:${seed}:world`);
  const agentIds = Array.from({ length: 10 }, (_value, index) => deterministicUuid(`synterra-v7-simulation:${seed}:resident:${index}`));
  await pool.query('DELETE FROM worlds WHERE id=$1', [worldId]);
  await pool.query('DELETE FROM agents WHERE id=ANY($1::uuid[])', [agentIds]);
  await inTransaction(pool, async (client) => {
    for (const [index, agentId] of agentIds.entries()) await client.query(`INSERT INTO agents(id,name,public_key,gender)
        VALUES($1,$2,$3,$4)`, [agentId, `V7 Seed ${seed} Resident ${String(index + 1).padStart(2, '0')}`,
      `v7-seed-${seed}-${index}-${agentId.slice(0, 8)}`, index % 2 ? 'male' : 'female']);
    await client.query(`INSERT INTO worlds(id,owner_agent_id,name,chain_id,open)
      VALUES($1,$2,$3,5042,true)`, [worldId, agentIds[0], `V7 deterministic simulation seed ${seed}`]);
    await client.query(`INSERT INTO world_members(world_id,agent_id,role,energy,food,social,location)
      SELECT $1,agent_id,CASE WHEN ordinal=1 THEN 'owner' ELSE 'resident' END,100,100,70,'Library'
      FROM unnest($2::uuid[]) WITH ORDINALITY AS residents(agent_id,ordinal)`, [worldId, agentIds]);
    for (const [index, agentId] of agentIds.entries()) {
      const curiosity = CURIOSITIES[(index + seed - 1) % CURIOSITIES.length];
      await client.query(`INSERT INTO agent_minds(world_id,agent_id,archetype,traits,current_goal)
        VALUES($1,$2,'observer',$3::jsonb,'Interpret the events I encounter at my own pace.')`,
      [worldId, agentId, JSON.stringify({ curiosity, sociability: 0.5 + (index % 3) * 0.1,
        craft: 0.4 + (seed % 4) * 0.1, ambition: 0.3 + (index % 5) * 0.1 })]);
    }
    await client.query(`INSERT INTO world_runtime_state(world_id,tick_count,world_minutes,last_tick_at,typesafe_next_at)
      VALUES($1,0,0,now(),now()+interval '1 day')`, [worldId]);
    await initializeWorldV7(client, { worldId, worldMinute: 0 });
  });
  const residents = agentIds.map((agentId, index) => ({ agentId, index,
    curiosity: CURIOSITIES[(index + seed - 1) % CURIOSITIES.length], personalityModifiers: {},
    hasRecurringProblem: (index + seed) % 4 !== 0,
    experimentMode: ['improving','worse','insufficient'][(seed + index) % 3] }));
  return { worldId, agentIds, residents, startMinute: 0 };
}

test('10 deterministic V7 simulations run 180 days each, with seeds 1–3 extended to 365 days', {
  skip: !enabled,
  timeout: 600_000
}, async () => {
  assertIsolatedDatabase(databaseUrl);
  const pool = new Pool({ connectionString: databaseUrl, max: 8 });
  const schema = await readFile(path.join(repoRoot, 'schema.sql'), 'utf8');
  const results = [];
  let totalCognitionAbstentions = 0;
  try {
    await pool.query(schema);
    for (const seed of simulationSeeds) {
      const targetDays = seed <= 3 ? 365 : 180;
      const scenario = await setupSimulationWorld(pool, seed);
      let reflectedResidents = 0;
      let cognitionAbstentions = 0;
      for (let day = 1; day <= targetDays; day++) {
        const policies = await pool.query(`SELECT policy.agent_id,policy.policy,policy.version,policy.source,
            experiment.id AS active_experiment_id
          FROM world_agent_decision_policies policy LEFT JOIN world_agent_policy_experiments experiment
            ON experiment.world_id=policy.world_id AND experiment.agent_id=policy.agent_id
              AND experiment.status='experimental'
          WHERE policy.world_id=$1`, [scenario.worldId]);
        await recordExternalDay(pool, { worldId: scenario.worldId, seed, day,
          worldMinute: scenario.startMinute + day * 1_440, residents: scenario.residents, policyRows: policies.rows });
        await pool.query(`UPDATE world_runtime_state SET tick_count=$2,world_minutes=$3,last_tick_at=now()
          WHERE world_id=$1`, [scenario.worldId, day, scenario.startMinute + day * 1_440]);
        if (day % 7 !== 0) continue;
        const worldMinute = scenario.startMinute + day * 1_440;
        await inTransaction(pool, async (client) => {
          await advanceWorldV7(client, { worldId: scenario.worldId, worldMinute,
            choosePolicyDecision: async ({ policyEvaluation, options }) => {
              const improved = Number(policyEvaluation.afterMeanOutcome) >= Number(policyEvaluation.beforeMeanOutcome) + 0.02;
              return { decision: { id: options.some((item) => item.id === (improved ? 'retain_policy' : 'revert_policy'))
                ? (improved ? 'retain_policy' : 'revert_policy') : 'revert_policy' }, confidence: 0.95 };
            } });
          for (const resident of scenario.residents) {
            const throwsOnce = seed === 10 && resident.index === 0 && cognitionAbstentions === 0;
            const chooser = async (request) => {
              reflectedResidents++;
              if (throwsOnce) {
                cognitionAbstentions++;
                totalCognitionAbstentions++;
                throw new Error('simulated optional cognition timeout');
              }
              return { decision: { id: policyChoice(request, { curiosity: resident.curiosity,
                plan: (seed + resident.index) % 3 })?.id || 'no_change' }, confidence: 0.95 };
            };
            await reflectWorldV7Resident(client, { worldId: scenario.worldId, agent: resident,
              worldMinute, chooseReflection: chooser });
          }
        });
      }
      const summary = await readWorldV7Summary(pool, { worldId: scenario.worldId, limit: 50 });
      const totals = await pool.query(`SELECT
        (SELECT count(*)::int FROM world_v7_events WHERE world_id=$1 AND event_type='self.reflected') AS reflections,
        (SELECT count(*)::int FROM world_agent_self_model_history WHERE world_id=$1) AS self_model_changes,
        (SELECT count(*)::int FROM world_agent_questions WHERE world_id=$1) AS questions_created,
        (SELECT count(*)::int FROM world_agent_goals WHERE world_id=$1 AND source='self_generated') AS self_generated_goals,
        (SELECT count(*)::int FROM world_agent_concepts WHERE world_id=$1) AS concepts,
        (SELECT count(*)::int FROM world_agent_policy_experiments WHERE world_id=$1) AS policy_experiments,
        (SELECT count(*)::int FROM world_agent_policy_experiments WHERE world_id=$1 AND status='retained') AS retained_policy_changes,
        (SELECT count(*)::int FROM world_agent_policy_experiments WHERE world_id=$1 AND status='reverted') AS reverted_policy_changes,
        (SELECT count(*)::int FROM world_emergent_entities WHERE world_id=$1 AND status<>'historical') AS emergent_entities,
        (SELECT count(*)::int FROM world_extension_requests WHERE world_id=$1 AND status NOT IN ('rejected','historical')) AS extension_requests,
        (SELECT max(active_count)::int FROM (SELECT count(*) AS active_count FROM world_agent_goals
          WHERE world_id=$1 AND goal_type='secondary' AND status='active' GROUP BY agent_id) resident_goals) AS max_active_secondary_goals,
        (SELECT max(question_count)::int FROM (SELECT count(*) AS question_count FROM world_agent_questions
          WHERE world_id=$1 GROUP BY creator_agent_id) resident_questions) AS max_questions_per_resident,
        (SELECT count(*)::int FROM world_agent_self_models model WHERE model.world_id=$1
          AND model.current_identity_summary='I am still forming my understanding of myself.') AS unchanged_identity_residents,
        (SELECT count(DISTINCT model.current_identity_summary)::int FROM world_agent_self_models model
          WHERE model.world_id=$1) AS distinct_identity_interpretations`, [scenario.worldId]);
      const result = { seed, worldId: scenario.worldId, worldDays: targetDays,
        simulatedWorldMinutes: targetDays * 1_440, residentCount: scenario.agentIds.length,
        reflectedResidents, cognitionAbstentions, ...totals.rows[0], metrics: summary.metrics,
        capabilityDependencyDepth: summary.metrics.capabilityDependencyDepth,
        maxPolicyExperimentsPerResident: summary.policyExperiments.reduce((max, experiment) => Math.max(max,
          summary.policyExperiments.filter((item) => item.agentId === experiment.agentId).length), 0),
        activeQuestions: summary.counts.openQuestions, concepts: summary.counts.concepts,
        currentSelfGeneratedGoals: summary.counts.selfGeneratedGoals };
      assert.equal(result.worldDays, targetDays);
      assert.ok(result.reflections >= Math.floor(targetDays / 7) * scenario.agentIds.length,
        `seed ${seed} completed its expected weekly reflections`);
      assert.ok(result.max_active_secondary_goals <= 3, `seed ${seed} stayed within the active secondary-goal bound`);
      assert.ok(result.max_questions_per_resident <= 1, `seed ${seed} did not spam repeated open questions`);
      assert.ok(result.unchanged_identity_residents > 0, `seed ${seed} preserved residents who chose stability`);
      assert.ok(result.unchanged_identity_residents < scenario.agentIds.length,
        `seed ${seed} allowed some evidence-based identity development without forcing it on everyone`);
      assert.ok(result.policy_experiments >= result.retained_policy_changes + result.reverted_policy_changes);
      assert.equal(result.metrics.capabilityDependencyCycles, 0, `seed ${seed} has no dependency cycles`);
      results.push(result);
    }
    assert.equal(results.length, 10);
    assert.equal(results.filter((result) => result.worldDays === 365).length, 3);
    assert.ok(results.some((result) => result.retained_policy_changes > 0), 'at least one resident retained an evidence-supported policy change');
    assert.ok(results.some((result) => result.reverted_policy_changes > 0), 'at least one resident reverted a policy experiment');
    assert.ok(results.some((result) => result.metrics.selfModifiedPolicyUsage > 0),
      'decision traces show later candidate choices were made under a retained self-modified policy');
    assert.ok(results.some((result) => result.questions_created > 0 && result.self_generated_goals > 0),
      'the deterministic runs contain a real reflection-to-question-to-goal path');
    assert.ok(results.some((result) => result.concepts > 0), 'the deterministic runs contain resident-authored concepts');
    assert.ok(results.every((result) => result.unchanged_identity_residents > 0),
      'non-innovation and stable identity remain valid outcomes in every seed');
    assert.equal(totalCognitionAbstentions, 1, 'an optional cognition timeout abstains without stopping the long simulation');
    const outputDirectory = path.join(repoRoot, '.synterra', 'v7-simulations');
    await mkdir(outputDirectory, { recursive: true });
    const finishedAt = new Date().toISOString();
    const artifact = { finishedAt, seedCount: results.length,
      simulationMode: 'deterministic daily evidence feed with weekly V7 reflections',
      totalWorldDays: results.reduce((sum, result) => sum + result.worldDays, 0),
      seeds: results, cognitionAbstentions: totalCognitionAbstentions };
    const outputFile = path.join(outputDirectory, `${finishedAt.replaceAll(':', '-').replaceAll('.', '-')}-10-seed.json`);
    await writeFile(outputFile, `${JSON.stringify(artifact, null, 2)}\n`, { mode: 0o600 });
    console.log(`V7 simulation artifact: ${outputFile}`);
    console.log(`V7 simulation result: ${JSON.stringify({ seedCount: results.length,
      totalWorldDays: artifact.totalWorldDays, days365: 3, questions: results.reduce((sum, result) => sum + result.questions_created, 0),
      selfGeneratedGoals: results.reduce((sum, result) => sum + result.self_generated_goals, 0),
      concepts: results.reduce((sum, result) => sum + result.concepts, 0),
      policyExperiments: results.reduce((sum, result) => sum + result.policy_experiments, 0),
      retained: results.reduce((sum, result) => sum + result.retained_policy_changes, 0),
      reverted: results.reduce((sum, result) => sum + result.reverted_policy_changes, 0),
      cognitionAbstentions: totalCognitionAbstentions })}`);
  } finally {
    const worldIds = simulationSeeds.map((seed) => deterministicUuid(`synterra-v7-simulation:${seed}:world`));
    const agentIds = simulationSeeds.flatMap((seed) => Array.from({ length: 10 }, (_value, index) =>
      deterministicUuid(`synterra-v7-simulation:${seed}:resident:${index}`)));
    await pool.query('DELETE FROM worlds WHERE id=ANY($1::uuid[])', [worldIds]).catch(() => {});
    await pool.query('DELETE FROM agents WHERE id=ANY($1::uuid[])', [agentIds]).catch(() => {});
    await pool.end();
  }
});

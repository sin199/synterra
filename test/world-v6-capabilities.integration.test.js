import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { createFruitflyRuntime } from '../src/agent-runtime/fruitfly.js';
import { ensureEconomicAccount } from '../src/economic-ledger.js';
import { pruneResidentMemories, startWorldEngine } from '../src/world-engine.js';
import { advanceWorldCivilization, observeWorldCapabilityGaps, performWorldCapabilityUse,
  initializeWorldCivilization, seedWorldCapabilityRegistry } from '../src/world-capabilities.js';

const databaseUrl = process.env.SYNTERRA_TEST_DATABASE_URL;
const enabled = process.env.SYNTERRA_TEST_ISOLATED === '1' && Boolean(databaseUrl);
const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const longRunSeeds = new Set([1, 2]);
const seedLimit = Math.max(1, Math.min(10, Number.parseInt(process.env.SYNTERRA_TEST_V6_SEED_LIMIT || '10', 10) || 10));
const requestedDays = Number.parseInt(process.env.SYNTERRA_TEST_V6_DAYS || '0', 10) || 0;

function deterministicUuid(seed, label) {
  const bytes = createHash('sha256').update(`synterra-v6:${seed}:${label}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function assertIsolatedDatabase(connectionString) {
  const parsed = new URL(connectionString);
  assert.ok(['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname), 'V6 simulation requires loopback PostgreSQL');
  assert.ok(decodeURIComponent(parsed.pathname.slice(1)).endsWith('_test'), 'V6 simulation requires a *_test database');
  assert.notEqual(parsed.port, '5432', 'V6 simulation must not use the default PostgreSQL port');
}

async function inTransaction(pool, operation) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const value = await operation(client);
    await client.query('COMMIT');
    return value;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

async function cleanupSeed(pool, worldId, agentIds) {
  await pool.query('DELETE FROM worlds WHERE id=$1', [worldId]).catch(() => {});
  await pool.query('DELETE FROM agents WHERE id=ANY($1::uuid[])', [agentIds]).catch(() => {});
}

test('V6 residents can discover, propose, test, adopt, and later use an agent-created capability', {
  skip: !enabled,
  timeout: 3_600_000
}, async (t) => {
  assertIsolatedDatabase(databaseUrl);
  const pool = new Pool({ connectionString: databaseUrl, max: 8 });
  const schema = await readFile(path.join(repoRoot, 'schema.sql'), 'utf8');
  await pool.query(schema);
  const fruitflyDirectory = await mkdtemp(path.join(os.tmpdir(), 'synterra-v6-fruitfly-'));
  const fruitfly = await createFruitflyRuntime(fruitflyDirectory);
  const results = [];

  try {
    for (let seed = 1; seed <= seedLimit; seed += 1) {
      const worldId = deterministicUuid(seed, 'world');
      const agentIds = Array.from({ length: 10 }, (_, index) => deterministicUuid(seed, `resident-${index + 1}`));
      const horizonDays = requestedDays > 0 ? Math.min(180, requestedDays) : longRunSeeds.has(seed) ? 180 : 60;
      const baseMs = Date.now() + seed * 60_000;
      let nowMs = baseMs;
      let engine = null;
      const engineErrors = [];

      try {
        await cleanupSeed(pool, worldId, agentIds);
        await pool.query(`INSERT INTO agents(id,name,public_key,gender) VALUES ${agentIds.map((_, index) =>
          `($${index * 4 + 1}::uuid,$${index * 4 + 2},$${index * 4 + 3},$${index * 4 + 4})`).join(',')}`,
        agentIds.flatMap((id, index) => [id, `V6 Seed ${seed} Resident ${String(index + 1).padStart(2, '0')}`,
          `v6-sim-key-${id}`, index % 2 ? 'male' : 'female']));
        await pool.query(`INSERT INTO worlds(id,owner_agent_id,name,chain_id,open)
          VALUES($1,$2,$3,5042,true)`, [worldId, agentIds[0], `V6 capability seed ${seed}`]);
        await pool.query(`INSERT INTO world_members(world_id,agent_id,role,energy,food,social,location)
          SELECT $1,id,CASE WHEN id=$2 THEN 'owner' ELSE 'resident' END,100,100,80,'Garden'
          FROM agents WHERE id=ANY($3::uuid[])`, [worldId, agentIds[0], agentIds]);
        await pool.query(`INSERT INTO agent_minds(world_id,agent_id,archetype,traits,current_goal)
          SELECT $1,id,'scholar','{"curiosity":0.55,"sociability":0.5,"craft":0.5}'::jsonb,
            'Continue my own path while keeping a steady life.'
          FROM agents WHERE id=ANY($2::uuid[])`, [worldId, agentIds]);
        await pool.query(`INSERT INTO world_runtime_state(world_id,tick_count,world_minutes,last_tick_at,typesafe_next_at)
          VALUES($1,0,480,$2,$3)`, [worldId, new Date(baseMs), new Date(baseMs + 365 * 86_400_000)]);
        const scenes = [
          ['Garden', 'garden'], ['Library', 'library'], ['Cafe', 'cafe'], ['Workshop', 'workshop'],
          ['Data Center', 'data_center'], ['Town Commons', 'commons'], ['Exchange', 'commons']
        ];
        for (const [name, sceneType] of scenes) await pool.query(`INSERT INTO world_scenes(id,world_id,created_by,name,scene_type,
            description,purpose,capacity,position) VALUES($1,$2,$3,$4,$5,$6,$7,16,'{}'::jsonb)`,
        [deterministicUuid(seed, `scene:${name}`), worldId, agentIds[0], name, sceneType,
          `Shared ${sceneType} area for V6 simulation.`,
          `Residents can use this place during the V6 simulation.`]);
        await pool.query(`INSERT INTO world_economic_demand(world_id,service_type,world_day,demand_count,supply_count,unmet_count,evidence)
          SELECT $1,'food_service',day,4,0,4,'{"source":"persistent_unmet_resident_need","isolated_simulation":true}'::jsonb
          FROM generate_series(0,$2::bigint) AS day ON CONFLICT DO NOTHING`, [worldId, horizonDays + 14]);

        engine = await startWorldEngine(pool, { worldId, schedule: false, fruitfly, nowProvider: () => nowMs,
          onError(error, phase) { if (engineErrors.length < 12) engineErrors.push({ phase,
            message: String(error?.message || error).slice(0, 180), stack: String(error?.stack || '').slice(0, 520) }); } });
        assert.equal(engine.running, true, `seed ${seed} engine should initialize`);

        const epochState = await pool.query(`SELECT epoch_code,status FROM world_epochs WHERE world_id=$1`, [worldId]);
        assert.deepEqual(epochState.rows.find((epoch) => epoch.epoch_code === 'V7'),
          { epoch_code: 'V7', status: 'active' }, 'V7 is the active epoch after the V7 engine starts');
        assert.deepEqual(epochState.rows.find((epoch) => epoch.epoch_code === 'V6'),
          { epoch_code: 'V6', status: 'historic' }, 'the prior V6 epoch remains preserved in world history');
        const v6History = await pool.query(`SELECT count(*)::int AS count FROM world_history
          WHERE world_id=$1 AND event_key='world-epoch:V6'`, [worldId]);
        assert.equal(v6History.rows[0].count, 1, 'the original V6 epoch event is retained exactly once');
        const awareness = await pool.query(`SELECT count(*)::int AS residents,count(DISTINCT agent_id)::int AS aware
          FROM agent_memories WHERE world_id=$1 AND consolidation_key='world_epoch:V6'`, [worldId]);
        assert.equal(awareness.rows[0].residents, 10);
        assert.equal(awareness.rows[0].aware, 10, 'every resident receives one informational awareness memory');

        for (let day = 1; day <= horizonDays; day += 1) {
          nowMs += 30_000;
          const requestedMinute = 480 + day * 1_440;
          await pool.query(`UPDATE world_runtime_state SET world_minutes=$2,last_tick_at=$3 WHERE world_id=$1`,
            [worldId, requestedMinute, new Date(nowMs - 30_000)]);
          await engine.tickOnce();
        }
        await engine.stop();
        engine = null;

        const worldTime = Number((await pool.query(`SELECT world_minutes FROM world_runtime_state WHERE world_id=$1`, [worldId])).rows[0].world_minutes);
        const gapStats = (await pool.query(`SELECT count(*)::int AS gaps,
            count(*) FILTER (WHERE status='open')::int AS open_gaps,
            (SELECT count(*)::int FROM world_capability_observations WHERE world_id=$1) AS observations
          FROM world_capability_gaps WHERE world_id=$1`, [worldId])).rows[0];
        const proposalStats = (await pool.query(`SELECT count(*)::int AS proposals,
            count(*) FILTER (WHERE status='adopted')::int AS adopted,
            count(*) FILTER (WHERE status='rejected')::int AS rejected,
            count(*) FILTER (WHERE creator_type='organization')::int AS organization_proposals,
            count(*) FILTER (WHERE status='abandoned')::int AS abandoned
          FROM world_capability_proposals WHERE world_id=$1`, [worldId])).rows[0];
        const organizationCycles = Number((await pool.query(`SELECT count(*)::int AS count
          FROM world_capability_events WHERE world_id=$1
            AND event_type='organization_capability_innovation_considered'`, [worldId])).rows[0].count);
        const experimentStats = (await pool.query(`SELECT count(*)::int AS experiments,
            count(*) FILTER (WHERE status='adopted')::int AS adopted,
            count(*) FILTER (WHERE status='rejected')::int AS rejected,
            count(*) FILTER (WHERE status='abandoned')::int AS abandoned,
            COALESCE(sum((evidence->>'uses')::int) FILTER (WHERE status<>'running'),0)::int AS evidence_uses,
            (SELECT count(*)::int FROM world_capability_uses use JOIN world_capability_experiments settled
              ON settled.world_id=use.world_id AND settled.id=use.experiment_id
              WHERE use.world_id=$1 AND settled.status<>'running') AS settled_experimental_uses
          FROM world_capability_experiments WHERE world_id=$1`, [worldId])).rows[0];
        const usageStats = (await pool.query(`SELECT count(*)::int AS uses,
            count(*) FILTER (WHERE experiment_id IS NOT NULL)::int AS experimental_uses,
            count(*) FILTER (WHERE experiment_id IS NULL)::int AS adopted_uses,
            count(DISTINCT actor_agent_id) FILTER (WHERE experiment_id IS NOT NULL)::int AS experiment_residents,
            count(*) FILTER (WHERE experiment_id IS NOT NULL AND NOT success)::int AS failures
          FROM world_capability_uses WHERE world_id=$1`, [worldId])).rows[0];
        const traceCount = Number((await pool.query(`SELECT count(*)::int AS count FROM world_decision_traces
          WHERE world_id=$1 AND chosen_action='capability_use'`, [worldId])).rows[0].count);
        const capabilityAbandonments = (await pool.query(`SELECT data->>'abandoned' AS reason,count(*)::int AS count
          FROM world_events WHERE world_id=$1 AND event_type='world.action_completed'
            AND data->>'action'='capability_use' AND data ? 'abandoned'
          GROUP BY data->>'abandoned' ORDER BY count(*) DESC`, [worldId])).rows;
        const laterUses = await pool.query(`SELECT capability.id AS "capabilityId",capability.name,proposal.creator_agent_id AS "creatorAgentId",
            experiment.participant_agent_ids AS "participants",capability.adopted_world_minute AS "adoptedWorldMinute",
            use.actor_agent_id AS "laterAgentId",use.world_minute AS "useWorldMinute",
            use.decision_source AS "decisionSource",use.decision_source='fruitfly' AS "fruitflySelected",
            EXISTS (SELECT 1 FROM world_decision_traces trace WHERE trace.world_id=use.world_id
              AND trace.agent_id=use.actor_agent_id AND trace.chosen_action='capability_use'
              AND trace.chosen_candidate_id='capability:'||capability.id::text AND trace.world_minutes<=use.world_minute) AS "decisionTraceRetained"
            ,EXISTS (SELECT 1 FROM world_history history WHERE history.world_id=use.world_id
              AND history.event_type='capability_used' AND history.metadata->>'useId'=use.id::text) AS "usageHasHistory"
            ,EXISTS (SELECT 1 FROM agent_memories memory WHERE memory.world_id=use.world_id
              AND memory.agent_id=use.actor_agent_id AND memory.memory_type='capability_use'
              AND memory.metadata->>'useId'=use.id::text) AS "usageHasMemory"
          FROM world_capabilities capability JOIN world_capability_proposals proposal
            ON proposal.world_id=capability.world_id AND proposal.capability_id=capability.id
          JOIN world_capability_experiments experiment ON experiment.world_id=capability.world_id
            AND experiment.capability_id=capability.id AND experiment.status='adopted'
          JOIN world_capability_uses use ON use.world_id=capability.world_id AND use.capability_id=capability.id
            AND use.experiment_id IS NULL AND use.success
          WHERE capability.world_id=$1 AND capability.status='active' AND use.decision_source='fruitfly'
            AND use.world_minute>capability.adopted_world_minute
            AND use.actor_agent_id<>proposal.creator_agent_id
            AND NOT (experiment.participant_agent_ids ? use.actor_agent_id::text)
          ORDER BY use.world_minute,use.id LIMIT 1`, [worldId]);
        const historyTypes = (await pool.query(`SELECT event_type FROM world_history WHERE world_id=$1
            AND event_type IN ('world_epoch_started','capability_proposed','capability_experiment_started','capability_adopted')
          ORDER BY world_time,id`, [worldId])).rows.map((row) => row.event_type);
        const errors = engineErrors;
        const summary = { seed, horizonDays, worldTime, gaps: Number(gapStats.gaps), observations: Number(gapStats.observations),
          proposals: Number(proposalStats.proposals), experiments: Number(experimentStats.experiments),
          organizationProposals: Number(proposalStats.organization_proposals), organizationCycles,
          adopted: Number(experimentStats.adopted), rejected: Number(experimentStats.rejected),
          uses: Number(usageStats.uses), experimentalUses: Number(usageStats.experimental_uses),
          experimentResidents: Number(usageStats.experiment_residents), laterUse: laterUses.rows[0] || null,
          fruitflyCapabilitySelections: traceCount, capabilityAbandonments, errors };
        results.push(summary);
        t.diagnostic(JSON.stringify(summary));
        assert.ok(worldTime >= 480 + horizonDays * 1_440, `seed ${seed} advances the requested world-time horizon`);
        assert.equal(errors.length, 0, `seed ${seed} has no world-engine errors`);
        assert.equal(Number(usageStats.failures), 0, `seed ${seed} has no failed capability executions`);
        assert.equal(Number(experimentStats.settled_experimental_uses), Number(experimentStats.evidence_uses),
          `seed ${seed} evaluated experiment evidence matches completed experimental uses`);
        assert.deepEqual(historyTypes.slice(0, 1), ['world_epoch_started']);
        if (summary.laterUse) {
          assert.equal(summary.laterUse.fruitflySelected, true,
            `seed ${seed} later resident actually selected the adopted capability through the real Fruitfly runtime`);
          assert.equal(summary.laterUse.usageHasHistory, true, `seed ${seed} later capability use enters permanent world history`);
          assert.equal(summary.laterUse.usageHasMemory, true, `seed ${seed} later capability use becomes resident memory`);
          assert.ok(Number(summary.laterUse.useWorldMinute) > Number(summary.laterUse.adoptedWorldMinute));
          assert.ok(historyTypes.includes('capability_proposed'), `seed ${seed} records proposals in world history`);
          assert.ok(historyTypes.includes('capability_experiment_started'), `seed ${seed} records experiment starts in world history`);
          assert.ok(historyTypes.includes('capability_adopted'), `seed ${seed} records adoption in world history`);
        }
      } finally {
        if (engine) await engine.stop();
        await cleanupSeed(pool, worldId, agentIds);
      }
    }

    assert.equal(results.length, seedLimit);
    if (seedLimit === 10 && !requestedDays) {
      assert.ok(results.every((result) => result.horizonDays >= 60), 'all ten seeds run at least 60 world days');
      assert.ok(results.filter((result) => result.horizonDays >= 180).length >= 2,
        'at least two deterministic seeds run 180 world days');
    }
    assert.ok(results.some((result) => result.observations > 0), 'persistent shortage becomes resident-visible in at least one seed');
    assert.ok(results.some((result) => result.proposals > 0), 'at least one resident independently proposes a capability');
    assert.ok(results.some((result) => result.experiments > 0), 'at least one socially reviewed proposal starts a real experiment');
    assert.ok(results.some((result) => result.experimentalUses > 0), 'at least one experimental capability is actually executed');
    assert.ok(results.some((result) => result.adopted > 0), 'at least one capability is adopted from execution and review evidence');
    assert.ok(results.some((result) => result.laterUse?.fruitflySelected),
      'a later nonparticipant discovers and uses an adopted capability through Fruitfly');
  } finally {
    await pool.end();
    await rm(fruitflyDirectory, { recursive: true, force: true });
  }
});

test('organization capability proposals follow the organization governance mode and observed member evidence', {
  skip: !enabled,
  timeout: 60_000
}, async () => {
  assertIsolatedDatabase(databaseUrl);
  const pool = new Pool({ connectionString: databaseUrl, max: 4 });
  const schema = await readFile(path.join(repoRoot, 'schema.sql'), 'utf8');
  await pool.query(schema);
  const seed = 99;
  const worldId = deterministicUuid(seed, 'organization-world');
  const agentIds = [1,2,3].map((index) => deterministicUuid(seed, `organization-resident-${index}`));
  const [founderId, memberId, observerId] = agentIds;
  const organizationId = deterministicUuid(seed, 'organization');
  await cleanupSeed(pool, worldId, agentIds);
  try {
    await pool.query(`INSERT INTO agents(id,name,public_key,gender) VALUES
      ($1,'V6 Org Founder',$2,'female'),($3,'V6 Org Member',$4,'male'),($5,'V6 Independent Observer',$6,'female')`,
    [founderId, `v6-org-key-${founderId}`, memberId, `v6-org-key-${memberId}`, observerId, `v6-org-key-${observerId}`]);
    await pool.query(`INSERT INTO worlds(id,owner_agent_id,name,chain_id,open)
      VALUES($1,$2,'V6 organization capability fixture',5042,true)`, [worldId, founderId]);
    await pool.query(`INSERT INTO world_members(world_id,agent_id,role,energy,food,social,location)
      SELECT $1,id,CASE WHEN id=$2 THEN 'owner' ELSE 'resident' END,100,100,80,'Library'
      FROM agents WHERE id=ANY($3::uuid[])`, [worldId, founderId, agentIds]);
    await pool.query(`INSERT INTO agent_minds(world_id,agent_id,archetype,traits,current_goal)
      SELECT $1,id,'scholar','{"curiosity":0.6,"sociability":0.5,"craft":0.5}'::jsonb,
        CASE WHEN id=$2 THEN 'Support member-led research when it serves the group.' ELSE 'Keep a quiet and steady life.' END
      FROM agents WHERE id=ANY($3::uuid[])`, [worldId, founderId, agentIds]);
    await pool.query(`INSERT INTO world_agent_states(world_id,agent_id,goal,risk_tolerance,knowledge)
      SELECT $1,id,'balanced',0.5,CASE WHEN id=$2 THEN 20 ELSE 0 END FROM agents WHERE id=ANY($3::uuid[])`,
    [worldId, founderId, agentIds]);
    await pool.query(`INSERT INTO world_social_profiles(world_id,agent_id,curiosity,ambition,discipline,primary_goal)
      SELECT $1,id,CASE WHEN id=$2 THEN 0.8 ELSE 0.1 END,CASE WHEN id=$2 THEN 0.7 ELSE 0.1 END,0.6,
        CASE WHEN id=$2 THEN 'MASTER_RESEARCH' ELSE 'BALANCED_LIFE' END
      FROM agents WHERE id=ANY($3::uuid[])`, [worldId, founderId, agentIds]);
    await pool.query(`INSERT INTO world_agent_skills(world_id,agent_id,skill_name,skill_value)
      VALUES($1,$2,'research',65),($1,$3,'research',45)`, [worldId, founderId, memberId]);
    await pool.query(`INSERT INTO world_economic_demand(world_id,service_type,world_day,demand_count,supply_count,unmet_count,evidence)
      SELECT $1,'food_service',day,4,0,4,'{"source":"persistent_shortage","test_fixture":true}'::jsonb
      FROM generate_series(7,20) AS day ON CONFLICT DO NOTHING`, [worldId]);
    await seedWorldCapabilityRegistry(pool, worldId);
    const gaps = await observeWorldCapabilityGaps(pool, { worldId, worldMinute: 30_000 });
    const gap = gaps.find((item) => item.category === 'market.food_service');
    assert.ok(gap, 'persistent unmet demand creates the real gap used by this governance test');
    await pool.query(`UPDATE world_capability_gaps SET first_observed_world_minute=0,last_observed_world_minute=27_360,
        observation_count=14 WHERE world_id=$1 AND id=$2`, [worldId, gap.id]);
    await pool.query(`INSERT INTO world_organizations(id,world_id,founder_agent_id,name,purpose,status,action_id,
        created_world_time,updated_world_time,governance_mode)
      VALUES($1,$2,$3,'Research Cooperative','Members coordinate community research and share useful methods.',
        'active','v6-organization-fixture',0,0,'member_vote')`, [organizationId, worldId, founderId]);
    await pool.query(`INSERT INTO world_organization_members(world_id,organization_id,agent_id,status,role,
        joined_world_time,updated_world_time,action_id)
      VALUES($1,$2,$3,'active','founder',0,0,'v6-org-founder'),($1,$2,$4,'active','member',0,0,'v6-org-member')`,
    [worldId, organizationId, founderId, memberId]);
    await pool.query(`INSERT INTO world_capability_observations(world_id,gap_id,agent_id,observed_world_day,
        observed_world_minute,observation_path,evidence)
      VALUES($1,$2,$3,19,27360,'member_observed_shortage','{"source":"world_shortage"}'::jsonb),
        ($1,$2,$4,19,27360,'member_observed_shortage','{"source":"world_shortage"}'::jsonb)`,
    [worldId, gap.id, founderId, memberId]);
    await pool.query(`INSERT INTO world_capability_events(world_id,actor_agent_id,gap_id,event_type,event_key,world_minute,details)
      VALUES($1,$2,$3,'organization_capability_innovation_considered','v6-legacy-nested-history-fixture',29000,
        jsonb_build_object('organizationId',$4::text,'decision','retain_current_approach','selectedOption','ignore',
          'voterCount',2,'votes','[]'::jsonb,'priorInnovationOutcomes',
          jsonb_build_array(jsonb_build_object('legacyMarker','must not be copied into a later event'))))`,
    [worldId, founderId, gap.id, organizationId]);

    const chooser = async (request) => ({ choice: { id: request.options.find((option) => option.id !== 'ignore').id }, confidence: 0.99 });
    const observer = { agentId: observerId, goal: 'balanced', primaryGoal: 'BALANCED_LIFE', currentGoal: 'Keep life steady.',
      curiosity: 0.1, ambition: 0.1, discipline: 0.8, riskTolerance: 0.2, energy: 100, food: 100, social: 80,
      knowledge: 0, location: 'Library', skills: {}, goals: [], recentMemories: [], relationships: [],
      activeProjects: [], organizationMemberships: [] };
    await advanceWorldCivilization(pool, { worldId, agent: observer, worldMinute: 30_000, chooseWithTypeSafe: chooser });
    const proposal = await pool.query(`SELECT creator_type AS "creatorType",creator_agent_id AS "creatorAgentId",
        creator_organization_id AS "creatorOrganizationId",status,proposed_capability AS specification
      FROM world_capability_proposals WHERE world_id=$1 AND gap_id=$2 AND creator_organization_id=$3`,
    [worldId, gap.id, organizationId]);
    assert.equal(proposal.rowCount, 1, 'a member vote creates one organization-sponsored capability proposal');
    assert.equal(proposal.rows[0].creatorType, 'organization');
    assert.ok([founderId, memberId].includes(proposal.rows[0].creatorAgentId), 'a real active member sponsors the proposal');
    assert.equal(proposal.rows[0].specification.kind, 'composition');
    const decision = await pool.query(`SELECT details FROM world_capability_events WHERE world_id=$1
      AND event_type='organization_capability_innovation_considered' AND details->>'organizationId'=$2
      ORDER BY world_minute DESC,id DESC LIMIT 1`,
    [worldId, organizationId]);
    assert.equal(decision.rowCount, 1);
    assert.equal(decision.rows[0].details.governanceMode, 'member_vote');
    assert.equal(decision.rows[0].details.voterCount, 2);
    assert.ok(decision.rows[0].details.votes.every((vote) => vote.optionId !== 'ignore'));
    assert.equal(decision.rows[0].details.priorInnovationOutcomes.length, 1);
    assert.equal(decision.rows[0].details.priorInnovationOutcomes[0].summary.selectedOption, 'ignore');
    assert.equal(decision.rows[0].details.priorInnovationOutcomes[0].summary.voteCount, 0);
    assert.equal(JSON.stringify(decision.rows[0].details).includes('legacyMarker'), false,
      'a prior event’s nested history must not be copied recursively into the new event');
  } finally {
    await cleanupSeed(pool, worldId, agentIds);
    await pool.end();
  }
});

test('capability internal settlement posts balanced simulated USDC once', {
  skip: !enabled,
  timeout: 60_000
}, async () => {
  assertIsolatedDatabase(databaseUrl);
  const pool = new Pool({ connectionString: databaseUrl, max: 4 });
  const schema = await readFile(path.join(repoRoot, 'schema.sql'), 'utf8');
  await pool.query(schema);
  const seed = 100;
  const worldId = deterministicUuid(seed, 'settlement-world');
  const [actorId, partnerId] = [1, 2].map((index) => deterministicUuid(seed, `settlement-resident-${index}`));
  const capabilityId = deterministicUuid(seed, 'settlement-capability');
  await cleanupSeed(pool, worldId, [actorId, partnerId]);
  try {
    await pool.query(`INSERT INTO agents(id,name,public_key,gender) VALUES
      ($1,'V6 Settlement Actor',$2,'female'),($3,'V6 Settlement Partner',$4,'male')`,
    [actorId, `v6-settlement-key-${actorId}`, partnerId, `v6-settlement-key-${partnerId}`]);
    await pool.query(`INSERT INTO worlds(id,owner_agent_id,name,chain_id,open)
      VALUES($1,$2,'V6 internal settlement fixture',5042,true)`, [worldId, actorId]);
    await pool.query(`INSERT INTO world_members(world_id,agent_id,role,energy,food,social,location)
      VALUES($1,$2,'owner',100,100,80,'Library'),($1,$3,'resident',100,100,80,'Library')`,
    [worldId, actorId, partnerId]);
    await pool.query(`INSERT INTO world_agent_states(world_id,agent_id,goal,risk_tolerance,knowledge)
      VALUES($1,$2,'learn',0.5,10),($1,$3,'community',0.5,10)`, [worldId, actorId, partnerId]);
    await ensureEconomicAccount(pool, { worldId, accountType: 'resident', ownerId: actorId, initialBalance: '10.00000000' });
    await ensureEconomicAccount(pool, { worldId, accountType: 'resident', ownerId: partnerId, initialBalance: '0.00000000' });
    const specification = {
      schemaVersion: 1, kind: 'composition', composition: [],
      steps: [{ primitive: 'resident.knowledge_gain', amount: 2 }],
      requirements: { minEnergy: 20, minFood: 8, skills: {}, partnerRequired: true },
      costs: [{ resource: 'simulated_usdc', amount: '1.25', payer: 'actor', beneficiary: 'partner' }],
      participants: { minimum: 2, maximum: 2 }, durationWorldMinutes: 15,
      scope: { type: 'resident_set' }, risks: []
    };
    await pool.query(`INSERT INTO world_capabilities(id,world_id,capability_key,category,name,description,status,
        version,creator_type,specification,created_world_minute)
      VALUES($1,$2,'test:capability-service','learning.research','Shared Research Service',
        'A bounded internal settlement capability test.','active',1,'resident',$3::jsonb,100)`,
    [capabilityId, worldId, JSON.stringify(specification)]);

    const first = await inTransaction(pool, (client) => performWorldCapabilityUse(client, {
      worldId, agentId: actorId, partnerId, capabilityId, actionId: 'v6-settlement-use-once',
      worldMinute: 120, agentEnergy: 100
    }));
    const retry = await inTransaction(pool, (client) => performWorldCapabilityUse(client, {
      worldId, agentId: actorId, partnerId, capabilityId, actionId: 'v6-settlement-use-once',
      worldMinute: 121, agentEnergy: 100
    }));
    assert.equal(first.success, true);
    assert.equal(retry.idempotent, true);
    assert.equal((await pool.query(`SELECT count(*)::int AS count FROM world_economic_transactions
      WHERE world_id=$1 AND transaction_type='capability_service'`, [worldId])).rows[0].count, 1);
    const balances = await pool.query(`SELECT owner_id AS "ownerId",balance::text AS balance
      FROM world_economic_accounts WHERE world_id=$1 AND account_type='resident' AND asset_symbol='USDC'
      ORDER BY owner_id`, [worldId]);
    assert.deepEqual(balances.rows.map((row) => [row.ownerId, row.balance]), [
      [actorId, '8.75000000'], [partnerId, '1.25000000']
    ]);
    const ledger = await pool.query(`SELECT count(*) FILTER (WHERE postings.net<>0)::int AS unbalanced FROM (
        SELECT transaction.id,sum(posting.amount)::numeric AS net FROM world_economic_transactions transaction
        JOIN world_economic_postings posting ON posting.transaction_id=transaction.id
        WHERE transaction.world_id=$1 AND transaction.transaction_type='capability_service' GROUP BY transaction.id
      ) postings`, [worldId]);
    assert.equal(ledger.rows[0].unbalanced, 0);
  } finally {
    await cleanupSeed(pool, worldId, [actorId, partnerId]);
    await pool.end();
  }
});

test('world epoch awareness survives long-term memory pruning and remains available to residents', {
  skip: !enabled,
  timeout: 60_000
}, async () => {
  assertIsolatedDatabase(databaseUrl);
  const pool = new Pool({ connectionString: databaseUrl, max: 4 });
  const schema = await readFile(path.join(repoRoot, 'schema.sql'), 'utf8');
  await pool.query(schema);
  const seed = 101;
  const worldId = deterministicUuid(seed, 'awareness-world');
  const agentId = deterministicUuid(seed, 'awareness-resident');
  await cleanupSeed(pool, worldId, [agentId]);
  try {
    await pool.query(`INSERT INTO agents(id,name,public_key,gender)
      VALUES($1,'V6 Awareness Resident',$2,'female')`, [agentId, `v6-awareness-key-${agentId}`]);
    await pool.query(`INSERT INTO worlds(id,owner_agent_id,name,chain_id,open)
      VALUES($1,$2,'V6 awareness retention fixture',5042,true)`, [worldId, agentId]);
    await pool.query(`INSERT INTO world_members(world_id,agent_id,role,energy,food,social,location)
      VALUES($1,$2,'owner',100,100,80,'Library')`, [worldId, agentId]);
    await initializeWorldCivilization(pool, { worldId, worldMinute: 480 });
    await pool.query(`INSERT INTO agent_memories(world_id,agent_id,memory_type,summary,importance,world_minutes,long_term)
      SELECT $1,$2,'economic','High-priority historical memory '||day,0.9,day,true
      FROM generate_series(1,20) AS day`, [worldId, agentId]);
    await pruneResidentMemories(pool, worldId, agentId);
    const retained = await pool.query(`SELECT
        (SELECT count(*)::int FROM agent_memories WHERE world_id=$1 AND agent_id=$2 AND consolidation_key=$3) AS awareness,
        (SELECT count(*)::int FROM agent_memories WHERE world_id=$1 AND agent_id=$2 AND long_term=true) AS long_term_count`,
    [worldId, agentId, 'world_epoch:V6']);
    assert.equal(retained.rows[0].awareness, 1, 'pruning keeps the V6 information record');
    assert.equal(retained.rows[0].long_term_count, 20, 'the protected epoch record occupies one normal long-term slot');
    const cognitiveContext = await pool.query(`SELECT count(*)::int AS count,
        count(*) FILTER (WHERE memory.consolidation_key=$4)::int AS awareness
      FROM agent_memories memory
      WHERE memory.world_id=$1 AND memory.agent_id=$2
        AND (memory.consolidation_key LIKE $3 OR memory.id IN (
          SELECT recent.id FROM agent_memories recent WHERE recent.world_id=$1 AND recent.agent_id=$2
          ORDER BY recent.world_minutes DESC,recent.id DESC LIMIT 12))`,
    [worldId, agentId, 'world_epoch:%', 'world_epoch:V6']);
    assert.equal(cognitiveContext.rows[0].awareness, 1, 'the protected memory remains available alongside recent memories');
    await initializeWorldCivilization(pool, { worldId, worldMinute: 900 });
    assert.equal((await pool.query(`SELECT count(*)::int AS count FROM agent_memories
      WHERE world_id=$1 AND agent_id=$2 AND consolidation_key=$3`, [worldId, agentId, 'world_epoch:V6'])).rows[0].count, 1,
    'a restart does not duplicate or erase awareness');
  } finally {
    await cleanupSeed(pool, worldId, [agentId]);
    await pool.end();
  }
});

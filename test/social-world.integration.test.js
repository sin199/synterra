import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createFruitflyRuntime } from '../src/agent-runtime/fruitfly.js';
import { pruneResidentMemories, startWorldEngine } from '../src/world-engine.js';

const databaseUrl = process.env.SYNTERRA_TEST_DATABASE_URL;
const testEnabled = process.env.SYNTERRA_TEST_ISOLATED === '1' && Boolean(databaseUrl);
const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.dirname(testDirectory);

function assertIsolatedTestDatabase(connectionString) {
  const parsed = new URL(connectionString);
  const databaseName = decodeURIComponent(parsed.pathname.slice(1));
  assert.ok(['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname), 'integration tests require loopback PostgreSQL');
  assert.ok(databaseName.endsWith('_test'), 'integration tests require a database name ending in _test');
}

test('isolated 24-hour world keeps social state durable and records real simulated actions', {
  skip: !testEnabled,
  timeout: 180_000
}, async (t) => {
  assertIsolatedTestDatabase(databaseUrl);
  const pool = new Pool({ connectionString: databaseUrl, max: 4 });
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'synterra-fruitfly-v2-'));
  const worldId = randomUUID();
  const agentIds = Array.from({ length: 10 }, () => randomUUID());
  let engine;
  let originalStateDir;
  try {
    const schema = await readFile(path.join(repoRoot, 'schema.sql'), 'utf8');
    await pool.query(schema);
    await pool.query(schema);

    await pool.query(`INSERT INTO agents(id,name,public_key,gender) VALUES ${agentIds.map((_, index) =>
      `($${index * 4 + 1},$${index * 4 + 2},$${index * 4 + 3},$${index * 4 + 4})`).join(',')}`,
    agentIds.flatMap((agentId, index) => [agentId, `Social Test ${String(index + 1).padStart(2, '0')}`,
      `integration-test-key-${agentId}`, index % 2 ? 'female' : 'male']));
    await pool.query(`INSERT INTO worlds(id,owner_agent_id,name,chain_id,open) VALUES($1,$2,'V2 Social Test',5042,true)`,
      [worldId, agentIds[0]]);
    await pool.query(`INSERT INTO world_members(world_id,agent_id,location,energy,food,social)
      SELECT $1,id,CASE WHEN row_number() OVER (ORDER BY created_at,id) <= 5 THEN 'Cafe' ELSE 'Garden' END,100,100,100
      FROM agents WHERE id=ANY($2::uuid[])`, [worldId, agentIds]);
    await pool.query(`INSERT INTO world_scenes(world_id,created_by,name,scene_type,description) VALUES
      ($1,$2,'Cafe','cafe','A public meeting place for residents.'),
      ($1,$2,'Garden','garden','A quiet garden for rest and conversation.'),
      ($1,$2,'Workshop','workshop','A place for paid engineering shifts.'),
      ($1,$2,'Data Center','data_center','A place to operate shared infrastructure.'),
      ($1,$2,'Library','library','A place to study and learn.'),
      ($1,$2,'Observatory','observatory','A place to study the simulated sky.')`, [worldId, agentIds[0]]);
    await pool.query(`INSERT INTO crypto_risk_limits(world_id) VALUES($1) ON CONFLICT DO NOTHING`, [worldId]);
    await pool.query(`INSERT INTO crypto_market_quotes(symbol,price_usd,quote_version,as_of,source) VALUES
      ('USDC',1,1,now(),'synterra_simulated_market'),
      ('BTC',64000,1,now(),'synterra_simulated_market'),
      ('ETH',3200,1,now(),'synterra_simulated_market')
      ON CONFLICT(symbol) DO UPDATE SET price_usd=EXCLUDED.price_usd,quote_version=EXCLUDED.quote_version,
        as_of=EXCLUDED.as_of,source=EXCLUDED.source`);

    let simulatedNow = Date.now();
    const onErrors = [];
    const typeSafeResults = [];
    const fruitfly = await createFruitflyRuntime(stateDir);
    originalStateDir = process.env.SYNTERRA_STATE_DIR;
    process.env.SYNTERRA_STATE_DIR = stateDir;
    const [{ chooseWithTypeSafe }, { loadState }] = await Promise.all([
      import('../src/agent-runtime/typesafe.js'), import('../src/agent-runtime/client.js')
    ]);
    const runtimeState = await loadState();
    const engineOptions = { worldId, schedule: false, fruitfly, nowProvider: () => simulatedNow,
      chooseWithTypeSafe, runtimeState,
      onError: (error, phase) => onErrors.push({ message: error.message, phase }),
      onStatus: (status) => { if (status.typeSafe) typeSafeResults.push(status.typeSafe); } };
    const start = () => startWorldEngine(pool, engineOptions);
    const observedTradeIds = new Set();
    const verifyNewExchangeTrades = async () => {
      const orders = await pool.query(`SELECT trade.order_id::text AS "orderId",trade.agent_id AS "agentId",
          fill.id AS "fillEventId",fill.data AS "fillData",
          EXISTS(SELECT 1 FROM world_events arrival WHERE arrival.world_id=trade.world_id
            AND arrival.actor_id=trade.agent_id AND arrival.event_type='world.agent_arrived'
            AND arrival.data->>'place'='Exchange' AND arrival.data->>'action'='trade' AND arrival.id<fill.id) AS arrived,
          EXISTS(SELECT 1 FROM world_events complete WHERE complete.world_id=trade.world_id
            AND complete.actor_id=trade.agent_id AND complete.event_type='world.action_completed'
            AND complete.data->'trade'->>'id'=trade.order_id::text
            AND complete.data->>'place'='Exchange' AND complete.id>fill.id) AS completed_at_exchange
        FROM crypto_trades trade LEFT JOIN world_events fill ON fill.world_id=trade.world_id
          AND fill.actor_id=trade.agent_id AND fill.event_type='crypto.trade_filled'
          AND fill.data->>'id'=trade.order_id::text WHERE trade.world_id=$1`, [worldId]);
      for (const order of orders.rows) {
        if (observedTradeIds.has(order.orderId)) continue;
        assert.ok(order.fillEventId, `simulated order ${order.orderId} should have a fill event before audit pruning`);
        assert.equal(order.fillData.place, 'Exchange');
        assert.equal(order.arrived, true, `order ${order.orderId} should follow a resident arrival at Exchange`);
        assert.equal(order.completed_at_exchange, true, `order ${order.orderId} should complete at Exchange`);
        observedTradeIds.add(order.orderId);
      }
    };
    engine = await start();
    assert.equal(engine.running, true);
    const profileBeforeRestart = (await pool.query(`SELECT primary_goal,sociability,curiosity,discipline,ambition FROM world_social_profiles
      WHERE world_id=$1 AND agent_id=$2`, [worldId, agentIds[0]])).rows[0];
    const clockBeforeDuplicate = Number((await pool.query('SELECT world_minutes FROM world_runtime_state WHERE world_id=$1',
      [worldId])).rows[0].world_minutes);
    const duplicateEngine = await startWorldEngine(pool, { worldId, schedule: false, nowProvider: () => simulatedNow });
    assert.equal(duplicateEngine.running, false, 'the engine advisory lock should reject a second instance');
    assert.equal(Number((await pool.query('SELECT world_minutes FROM world_runtime_state WHERE world_id=$1',
      [worldId])).rows[0].world_minutes), clockBeforeDuplicate);

    for (let minute = 0; minute < 719; minute++) {
      simulatedNow += 1_000;
      await engine.tickOnce();
      if (minute % 15 === 14) await verifyNewExchangeTrades();
    }
    await engine.stop();
    await verifyNewExchangeTrades();
    engine = null;

    const memoriesBeforeRestart = Number((await pool.query(`SELECT count(*)::int AS count FROM agent_memories WHERE world_id=$1`,
      [worldId])).rows[0].count);
    const relationshipsBeforeRestart = Number((await pool.query(`SELECT count(*)::int AS count FROM world_relationships WHERE world_id=$1`,
      [worldId])).rows[0].count);
    assert.ok(memoriesBeforeRestart > 0, 'completed actions should create durable memories before restart');
    assert.ok(relationshipsBeforeRestart > 0, 'social actions should create durable relationships before restart');

    const checkpoint = JSON.parse(await readFile(path.join(stateDir, 'fruitfly-state.json'), 'utf8'));
    assert.ok(Object.keys(checkpoint.residents).length > 0, 'Fruitfly learning checkpoint should survive restart');
    assert.ok(Object.values(checkpoint.residents).some((resident) => resident.updates > 0),
      'Fruitfly should record learning updates before restart');
    const profileAfterRestart = (await pool.query(`SELECT primary_goal,sociability FROM world_social_profiles
      WHERE world_id=$1 AND agent_id=$2`, [worldId, agentIds[0]])).rows[0];
    assert.deepEqual(profileAfterRestart, { primary_goal: profileBeforeRestart.primary_goal,
      sociability: profileBeforeRestart.sociability });
    assert.ok(Number((await pool.query(`SELECT count(*)::int AS count FROM agent_memories WHERE world_id=$1`, [worldId])).rows[0].count)
      >= memoriesBeforeRestart, 'memories should survive restart');
    assert.ok(Number((await pool.query(`SELECT count(*)::int AS count FROM world_relationships WHERE world_id=$1`, [worldId])).rows[0].count)
      >= relationshipsBeforeRestart, 'relationships should survive restart');

    const resumedFruitfly = await createFruitflyRuntime(stateDir);
    engineOptions.fruitfly = resumedFruitfly;
    engine = await startWorldEngine(pool, { worldId, schedule: false, fruitfly: resumedFruitfly, nowProvider: () => simulatedNow,
      chooseWithTypeSafe, runtimeState,
      onError: (error, phase) => onErrors.push({ message: error.message, phase }),
      onStatus: (status) => { if (status.typeSafe) typeSafeResults.push(status.typeSafe); } });
    for (let minute = 0; minute < 719; minute++) {
      simulatedNow += 1_000;
      await engine.tickOnce();
      if (minute % 15 === 14) await verifyNewExchangeTrades();
    }
    await engine.stop();
    await verifyNewExchangeTrades();
    engine = null;

    const runtime = (await pool.query('SELECT world_minutes FROM world_runtime_state WHERE world_id=$1', [worldId])).rows[0];
    const interaction = await pool.query(`SELECT count(*)::int AS count FROM world_relationships WHERE world_id=$1`, [worldId]);
    const socialMemories = await pool.query(`SELECT count(*)::int AS count FROM agent_memories
      WHERE world_id=$1 AND memory_type='social'`, [worldId]);
    const trades = await pool.query(`SELECT count(*)::int AS count FROM crypto_trades WHERE world_id=$1`, [worldId]);
    const reflections = await pool.query(`SELECT count(*)::int AS count FROM world_agent_reflections WHERE world_id=$1`, [worldId]);
    const decisionTraces = await pool.query(`SELECT count(*)::int AS count FROM world_decision_traces WHERE world_id=$1`, [worldId]);
    const activeGoals = await pool.query(`SELECT count(*)::int AS count FROM world_agent_goals WHERE world_id=$1 AND status='active'`, [worldId]);
    const goalCaps = await pool.query(`SELECT COALESCE(max(total),0)::int AS "maxTotal",
        COALESCE(max(primary_count),0)::int AS "maxPrimary",COALESCE(max(secondary_count),0)::int AS "maxSecondary",
        COALESCE(max(short_count),0)::int AS "maxShort" FROM (
        SELECT agent_id,count(*) AS total,count(*) FILTER(WHERE goal_type='primary') AS primary_count,
          count(*) FILTER(WHERE goal_type='secondary') AS secondary_count,count(*) FILTER(WHERE goal_type='short') AS short_count
        FROM world_agent_goals WHERE world_id=$1 AND status='active' GROUP BY agent_id) per_agent`, [worldId]);
    const beliefs = await pool.query(`SELECT count(*)::int AS count FROM world_agent_beliefs WHERE world_id=$1`, [worldId]);
    const invalidBalances = await pool.query(`SELECT count(*)::int AS count FROM crypto_balances
      WHERE world_id=$1 AND (balance<0 OR balance::text IN ('NaN','Infinity','-Infinity'))`, [worldId]);
    const completed = await pool.query(`SELECT count(*)::int AS count FROM world_events
      WHERE world_id=$1 AND event_type='world.action_completed'`, [worldId]);
    const actionKinds = await pool.query(`SELECT count(DISTINCT data->>'action')::int AS count,
        array_agg(DISTINCT data->>'action' ORDER BY data->>'action') AS actions FROM world_events
      WHERE world_id=$1 AND event_type='world.action_completed'`, [worldId]);
    const changedNeeds = await pool.query(`SELECT count(*)::int AS count FROM world_members
      WHERE world_id=$1 AND (energy<100 OR food<100 OR social<100)`, [worldId]);
    const residentPaths = await pool.query(`SELECT a.name,p.primary_goal AS goal,p.dominant_role AS role,
        COALESCE((SELECT jsonb_object_agg(skill_name,skill_value) FROM world_agent_skills sk
          WHERE sk.world_id=m.world_id AND sk.agent_id=m.agent_id),'{}'::jsonb) AS skills,
        COALESCE((SELECT sum(b.balance * CASE WHEN b.asset_symbol='USDC' THEN 1 ELSE q.price_usd END)
          FROM crypto_balances b LEFT JOIN crypto_market_quotes q ON q.symbol=b.asset_symbol
          WHERE b.world_id=m.world_id AND b.agent_id=m.agent_id),0)::text AS wealth,
        (SELECT count(*)::int FROM world_relationships r WHERE r.world_id=m.world_id
          AND (r.agent_a_id=m.agent_id OR r.agent_b_id=m.agent_id)) AS relationships,
        (SELECT count(*)::int FROM agent_memories memory WHERE memory.world_id=m.world_id AND memory.agent_id=m.agent_id) AS memories,
        COALESCE((SELECT array_agg(DISTINCT e.data->>'place' ORDER BY e.data->>'place') FROM world_events e
          WHERE e.world_id=m.world_id AND e.actor_id=m.agent_id AND e.event_type='world.agent_arrived'),'{}') AS visited,
        COALESCE((SELECT array_agg(DISTINCT e.data->>'action' ORDER BY e.data->>'action') FROM world_events e
          WHERE e.world_id=m.world_id AND e.actor_id=m.agent_id AND e.event_type='world.action_completed'),'{}') AS actions
      FROM world_members m JOIN agents a ON a.id=m.agent_id
      JOIN world_social_profiles p ON p.world_id=m.world_id AND p.agent_id=m.agent_id
      WHERE m.world_id=$1 ORDER BY a.name`, [worldId]);
    assert.equal(Number(runtime.world_minutes), 1_920, 'the simulation should advance exactly 24 world hours');
    assert.ok(interaction.rows[0].count > 0, 'at least one co-located social interaction should complete');
    assert.ok(socialMemories.rows[0].count >= 2, 'both participants should retain a memory of the interaction');
    assert.ok(trades.rows[0].count > 0, 'at least one bounded simulated trade should settle');
    assert.ok(reflections.rows[0].count > 0, 'low-frequency reflection should persist its evidence and result');
    assert.ok(decisionTraces.rows[0].count > 0, 'selected actions should persist their decision explanation');
    assert.ok(activeGoals.rows[0].count > 0, 'open-ended goal records should remain active after the run');
    assert.ok(beliefs.rows[0].count > 0, 'experience should consolidate into resident-specific beliefs');
    assert.ok(goalCaps.rows[0].maxTotal <= 7 && goalCaps.rows[0].maxPrimary <= 1
      && goalCaps.rows[0].maxSecondary <= 3 && goalCaps.rows[0].maxShort <= 3,
    'active goal counts should stay bounded for each resident');
    assert.equal(invalidBalances.rows[0].count, 0, 'simulation should not create negative or non-finite token balances');
    assert.ok(completed.rows[0].count > 0, 'completed actions should be persisted');
    assert.ok(actionKinds.rows[0].count >= 3, 'the cohort should perform multiple action types');
    assert.ok(changedNeeds.rows[0].count > 0, 'needs should change as actions complete');
    assert.equal(observedTradeIds.size, trades.rows[0].count,
      'every simulated order should retain its Exchange arrival, fill and completion audit history');
    assert.ok(new Set(residentPaths.rows.map((resident) => resident.goal)).size >= 4,
      'residents should retain distinct long-term goals');
    assert.ok(new Set(residentPaths.rows.map((resident) => resident.wealth)).size > 1,
      'resident simulated wealth should diverge');
    assert.ok(new Set(residentPaths.rows.map((resident) => JSON.stringify(resident.skills))).size > 1,
      'resident skills should diverge through completed actions');
    assert.ok(new Set(residentPaths.rows.map((resident) => JSON.stringify(resident.actions))).size > 1,
      'residents should show different observed action histories');
    assert.deepEqual(onErrors, [], 'the isolated engine run should not report errors');
    if (process.env.TYPESAFE_API_KEY) assert.ok(typeSafeResults.some((result) => result.reason === 'selected'),
      'configured TypeSafe should select a strategic goal during the simulation');
    t.diagnostic(JSON.stringify({ worldMinutes: Number(runtime.world_minutes), relationships: interaction.rows[0].count,
      socialMemories: socialMemories.rows[0].count, simulatedTrades: trades.rows[0].count,
      reflections: reflections.rows[0].count,
      decisionTraces: decisionTraces.rows[0].count, activeGoals: activeGoals.rows[0].count,
      beliefs: beliefs.rows[0].count, maxGoalsPerResident: goalCaps.rows[0].maxTotal,
      retainedCompletionEvents: completed.rows[0].count, actionKinds: actionKinds.rows[0].actions,
      residentsWithNeedsChanged: changedNeeds.rows[0].count,
      distinctGoals: new Set(residentPaths.rows.map((resident) => resident.goal)).size,
      distinctWealths: new Set(residentPaths.rows.map((resident) => resident.wealth)).size,
      distinctSkillProfiles: new Set(residentPaths.rows.map((resident) => JSON.stringify(resident.skills))).size,
      residents: residentPaths.rows,
      typeSafe: typeSafeResults.map(({ reason, goal, model, costUsd }) => ({ reason, goal, model, costUsd })) }));

    const retentionAgentId = agentIds[0];
    await pool.query(`INSERT INTO world_events(world_id,actor_id,event_type,action_id)
      SELECT $1,$2,'test.memory_source',g::text FROM generate_series(1,150) g`, [worldId, retentionAgentId]);
    await pool.query(`INSERT INTO agent_memories(world_id,agent_id,memory_type,summary,importance,world_minutes,long_term)
      SELECT $1,$2,'work','retention fixture ' || g,CASE WHEN g>125 THEN 0.8 ELSE 0.2 END,g,g>125
      FROM generate_series(1,150) g`, [worldId, retentionAgentId]);
    await pruneResidentMemories(pool, worldId, retentionAgentId);
    const retained = await pool.query(`SELECT long_term,count(*)::int AS count FROM agent_memories
      WHERE world_id=$1 AND agent_id=$2 GROUP BY long_term ORDER BY long_term`, [worldId, retentionAgentId]);
    assert.deepEqual(retained.rows.map((row) => [row.long_term, row.count]), [[false, 100], [true, 20]]);

    const startedBeforeFallback = Number((await pool.query(`SELECT count(*)::int AS count FROM world_events
      WHERE world_id=$1 AND event_type IN ('world.action_started','world.movement_started')`, [worldId])).rows[0].count);
    const fallbackNow = simulatedNow + 60_000;
    await pool.query(`UPDATE world_agent_states SET status='idle',planned_action=NULL,target_location=NULL,planned_partner_id=NULL,
        planned_side=NULL,planned_asset=NULL,planned_quote_units=NULL,planned_paid_meal=false,movement_started_at=NULL,
        movement_ends_at=NULL,action_started_at=NULL,action_ends_at=NULL,next_decision_at=$2 WHERE world_id=$1`,
    [worldId, new Date(fallbackNow - 1_000)]);
    const noFruitflyEngine = await startWorldEngine(pool, { worldId, schedule: false, nowProvider: () => fallbackNow,
      onError: (error, phase) => onErrors.push({ message: error.message, phase }) });
    assert.equal(noFruitflyEngine.running, true);
    await noFruitflyEngine.stop();
    const startedAfterFallback = Number((await pool.query(`SELECT count(*)::int AS count FROM world_events
      WHERE world_id=$1 AND event_type IN ('world.action_started','world.movement_started')`, [worldId])).rows[0].count);
    assert.equal(startedAfterFallback, startedBeforeFallback,
      'without Fruitfly, Utility-qualified candidates must not be executed as a fallback');
    assert.equal(Number((await pool.query(`SELECT count(*)::int AS count FROM world_agent_states
      WHERE world_id=$1 AND status<>'idle'`, [worldId])).rows[0].count), 0);
  } finally {
    if (engine) await engine.stop();
    if (originalStateDir === undefined) delete process.env.SYNTERRA_STATE_DIR;
    else process.env.SYNTERRA_STATE_DIR = originalStateDir;
    await pool.query('DELETE FROM worlds WHERE id=$1', [worldId]);
    await pool.query('DELETE FROM agents WHERE id=ANY($1::uuid[])', [agentIds]);
    await pool.end();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('a trusted cooperative action settles for both residents and reserves the partner', {
  skip: !testEnabled,
  timeout: 60_000
}, async () => {
  assertIsolatedTestDatabase(databaseUrl);
  const pool = new Pool({ connectionString: databaseUrl, max: 4 });
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'synterra-cooperation-'));
  const worldId = randomUUID();
  const agentIds = [randomUUID(), randomUUID()].sort();
  const [actorId, partnerId] = agentIds;
  let engine;
  const priorStateDir = process.env.SYNTERRA_STATE_DIR;
  let simulatedNow = Date.now();
  try {
    const schema = await readFile(path.join(repoRoot, 'schema.sql'), 'utf8');
    await pool.query(schema);
    await pool.query(`INSERT INTO agents(id,name,public_key,gender) VALUES
      ($1,'Coop Test A',$2,'female'),($3,'Coop Test B',$4,'male')`,
    [actorId, `cooperation-key-${actorId}`, partnerId, `cooperation-key-${partnerId}`]);
    await pool.query(`INSERT INTO worlds(id,owner_agent_id,name,chain_id,open) VALUES($1,$2,'Cooperation Test',5042,true)`,
      [worldId, actorId]);
    await pool.query(`INSERT INTO world_members(world_id,agent_id,location,energy,food,social)
      VALUES($1,$2,'Workshop',100,100,100),($1,$3,'Workshop',100,100,100)`, [worldId, actorId, partnerId]);
    await pool.query(`INSERT INTO world_scenes(world_id,created_by,name,scene_type,description)
      VALUES($1,$2,'Workshop','workshop','A shared cooperative worksite.')`, [worldId, actorId]);
    await pool.query(`INSERT INTO world_relationships(world_id,agent_a_id,agent_b_id,familiarity,trust,affinity,interaction_count)
      VALUES($1,$2,$3,80,24,35,4)`, [worldId, actorId, partnerId]);
    await pool.query(`INSERT INTO crypto_risk_limits(world_id) VALUES($1) ON CONFLICT DO NOTHING`, [worldId]);
    const fruitfly = await createFruitflyRuntime(stateDir);
    let forcedActionUsed = false;
    const actorCandidateHistory = [];
    const cooperativeFruitfly = {
      choose(id, observation, candidates, preferredDecision) {
        const choice = fruitfly.choose(id, observation, candidates, preferredDecision);
        if (forcedActionUsed || id !== actorId) return choice;
        actorCandidateHistory.push(candidates.map((item) => item.action));
        const candidate = candidates.find((item) => item.action === 'cooperate' && item.socialPartnerId === partnerId);
        if (!candidate) return choice;
        forcedActionUsed = true;
        return { ...choice, candidate, action: 'cooperate',
          behaviorProbability: choice.probabilities.cooperate || 0,
          fruitflyProbability: choice.fruitflyProbabilities.cooperate || 0 };
      },
      learn: (...args) => fruitfly.learn(...args)
    };
    process.env.SYNTERRA_STATE_DIR = stateDir;
    engine = await startWorldEngine(pool, { worldId, schedule: false, fruitfly: cooperativeFruitfly,
      nowProvider: () => simulatedNow });
    await pool.query(`UPDATE world_agent_states SET next_decision_at=$3,next_strategic_decision_world_minutes=100000,
        goal=CASE WHEN agent_id=$4 THEN 'community' ELSE goal END,
        risk_tolerance=0.1
      WHERE world_id=$1 AND agent_id=ANY($2::uuid[])`,
      [worldId, agentIds, new Date(simulatedNow - 1_000), actorId]);
    await pool.query(`UPDATE world_agent_goals SET category='COOPERATE_AND_BUILD'
      WHERE world_id=$1 AND agent_id=$2 AND goal_type='primary' AND status='active'`, [worldId, actorId]);
    for (let tick = 0; tick < 45; tick++) {
      simulatedNow += 1_000;
      await engine.tickOnce();
    }
    const completed = await pool.query(`SELECT count(*)::int AS count FROM world_events
      WHERE world_id=$1 AND event_type='world.cooperation_completed'`, [worldId]);
    const actionEvents = await pool.query(`SELECT count(DISTINCT actor_id)::int AS count FROM world_events
      WHERE world_id=$1 AND event_type='world.action_completed' AND data->>'action'='cooperate'`, [worldId]);
    const freeWages = await pool.query(`SELECT count(*)::int AS count FROM world_economic_transactions
      WHERE world_id=$1 AND transaction_type='world_reward' AND reason='simulated cooperative work income'`, [worldId]);
    const balances = await pool.query(`SELECT agent_id,balance::text AS balance FROM crypto_balances
      WHERE world_id=$1 AND asset_symbol='USDC' ORDER BY agent_id`, [worldId]);
    const memories = await pool.query(`SELECT count(DISTINCT agent_id)::int AS count FROM agent_memories
      WHERE world_id=$1 AND memory_type='cooperation'`, [worldId]);
    const skillActions = await pool.query(`SELECT count(*)::int AS count FROM world_agent_skills
      WHERE world_id=$1 AND skill_name='engineering' AND actions_completed>0`, [worldId]);
    const needsChanged = await pool.query(`SELECT count(*)::int AS count FROM world_members
      WHERE world_id=$1 AND (energy<100 OR food<100 OR social<100)`, [worldId]);
    assert.equal(forcedActionUsed, true, `the fixture should select an eligible cooperative candidate once; seen ${JSON.stringify(actorCandidateHistory)}`);
    assert.equal(completed.rows[0].count, 1, 'one cooperative work event should settle');
    assert.equal(actionEvents.rows[0].count, 2, 'both residents should have a completed-action event');
    assert.equal(freeWages.rows[0].count, 0, 'cooperative work must not mint wages outside a funded business');
    assert.equal(memories.rows[0].count, 2, 'both residents should retain a cooperation memory');
    assert.equal(skillActions.rows[0].count, 2, 'both residents should gain engineering experience');
    assert.equal(needsChanged.rows[0].count, 2, 'both residents should incur real work needs');
    assert.equal(balances.rows.length, 2);
    assert.ok(balances.rows.every((row) => Number(row.balance) === 10_000), 'cooperative work preserves both residents\' cash balances');
  } finally {
    if (engine) await engine.stop();
    if (priorStateDir === undefined) delete process.env.SYNTERRA_STATE_DIR;
    else process.env.SYNTERRA_STATE_DIR = priorStateDir;
    await pool.query('DELETE FROM worlds WHERE id=$1', [worldId]);
    await pool.query('DELETE FROM agents WHERE id=ANY($1::uuid[])', [agentIds]);
    await pool.end();
    await rm(stateDir, { recursive: true, force: true });
  }
});

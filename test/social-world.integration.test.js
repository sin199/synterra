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
import { fundTestResidents } from './helpers/economic-fixtures.js';

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

async function legacyPaperTradingSnapshot(pool, worldId, tokenAddress) {
  const globalTables = new Set(['crypto_market_quotes', 'robinhood_market_state']);
  const tokenTables = new Set(['robinhood_tokens', 'robinhood_market_quotes']);
  const tables = [
    ['crypto_risk_limits', 'SELECT to_jsonb(row) AS data FROM crypto_risk_limits row WHERE world_id=$1'],
    ['crypto_market_quotes', 'SELECT to_jsonb(row) AS data FROM crypto_market_quotes row ORDER BY symbol'],
    ['crypto_balances', 'SELECT to_jsonb(row) AS data FROM crypto_balances row WHERE world_id=$1 ORDER BY agent_id,asset_symbol'],
    ['crypto_ledger', 'SELECT to_jsonb(row) AS data FROM crypto_ledger row WHERE world_id=$1 ORDER BY id'],
    ['crypto_orders', 'SELECT to_jsonb(row) AS data FROM crypto_orders row WHERE world_id=$1 ORDER BY id'],
    ['crypto_trades', 'SELECT to_jsonb(row) AS data FROM crypto_trades row WHERE world_id=$1 ORDER BY id'],
    ['robinhood_market_state', 'SELECT to_jsonb(row) AS data FROM robinhood_market_state row WHERE id=1'],
    ['robinhood_tokens', 'SELECT to_jsonb(row) AS data FROM robinhood_tokens row WHERE token_address=$1'],
    ['robinhood_market_quotes', 'SELECT to_jsonb(row) AS data FROM robinhood_market_quotes row WHERE token_address=$1'],
    ['robinhood_paper_positions', 'SELECT to_jsonb(row) AS data FROM robinhood_paper_positions row WHERE world_id=$1 ORDER BY agent_id,token_address'],
    ['robinhood_paper_orders', 'SELECT to_jsonb(row) AS data FROM robinhood_paper_orders row WHERE world_id=$1 ORDER BY id'],
    ['robinhood_paper_ledger', 'SELECT to_jsonb(row) AS data FROM robinhood_paper_ledger row WHERE world_id=$1 ORDER BY id']
  ];
  const snapshot = {};
  for (const [table, sql] of tables) {
    const params = globalTables.has(table) ? [] : tokenTables.has(table) ? [tokenAddress] : [worldId];
    snapshot[table] = (await pool.query(sql, params)).rows;
  }
  return snapshot;
}

async function seedLegacyPaperTradingHistory(pool, worldId, agentId) {
  const makeAddress = () => `0x${randomUUID().replaceAll('-', '').repeat(2).slice(0, 40)}`;
  const tokenAddress = makeAddress();
  const curveAddress = makeAddress();
  const pairTokenAddress = makeAddress();
  const launchTxHash = `0x${randomUUID().replaceAll('-', '').padEnd(64, '0')}`;
  const cryptoOrderId = randomUUID();
  const robinhoodOrderId = randomUUID();
  await pool.query(`INSERT INTO crypto_risk_limits(world_id) VALUES($1)`, [worldId]);
  await pool.query(`INSERT INTO crypto_balances(world_id,agent_id,asset_symbol,balance) VALUES
    ($1,$2,'USDC',10000),($1,$2,'BTC',0.25)`, [worldId, agentId]);
  await pool.query(`INSERT INTO crypto_ledger(world_id,agent_id,asset_symbol,amount,entry_type,reference_id,reason) VALUES
    ($1,$2,'USDC',10000,'seed','legacy-seed','legacy paper balance'),
    ($1,$2,'BTC',0.25,'buy','legacy-buy','legacy paper purchase')`, [worldId, agentId]);
  await pool.query(`INSERT INTO crypto_orders(id,world_id,agent_id,action_id,side,asset_symbol,quote_version,quantity,
      price_usd,notional_usd,fee_usdc,status,data) VALUES($1,$2,$3,'legacy-crypto-order','buy','BTC',1,0.25,64000,
      16000,16,'filled','{"historical":true}'::jsonb)`, [cryptoOrderId, worldId, agentId]);
  await pool.query(`INSERT INTO crypto_trades(order_id,world_id,agent_id,side,asset_symbol,quantity,price_usd,notional_usd,fee_usdc)
    VALUES($1,$2,$3,'buy','BTC',0.25,64000,16000,16)`, [cryptoOrderId, worldId, agentId]);
  await pool.query(`INSERT INTO robinhood_tokens(token_address,curve_address,symbol,name,decimals,pair_token_address,
      launch_config_id,launch_block,launch_tx_hash,last_quote_at)
    VALUES($1,$2,'HIST','Historical token',18,$3,1,9876,$4,now())`, [tokenAddress, curveAddress, pairTokenAddress, launchTxHash]);
  await pool.query(`INSERT INTO robinhood_market_quotes(token_address,quote_version,block_number,curve_address,quote_asset,
      quote_reserve_raw,token_reserve_raw,sellable_tokens_raw,fee_bps,tax_bps,graduated,native_per_token,native_usd_price,
      price_usd,as_of,source,trade_supported) VALUES($1,1,9876,$2,'WETH',1000000000000000000,1000000000000000000000,
      500000000000000000000,100,200,false,0.001,2400,2.4,now(),'legacy-test-snapshot',true)`, [tokenAddress, curveAddress]);
  await pool.query(`INSERT INTO robinhood_paper_positions(world_id,agent_id,token_address,quantity_raw)
    VALUES($1,$2,$3,1000000000000000000)`, [worldId, agentId, tokenAddress]);
  await pool.query(`INSERT INTO robinhood_paper_orders(id,world_id,agent_id,action_id,side,token_address,quote_version,
      token_amount_raw,native_quote_raw,notional_usd,fee_usdc,status,data)
    VALUES($1,$2,$3,'legacy-robinhood-order','buy',$4,1,1000000000000000000,1000000000000000,2.4,0.024,'filled','{"historical":true}'::jsonb)`,
  [robinhoodOrderId, worldId, agentId, tokenAddress]);
  await pool.query(`INSERT INTO robinhood_paper_ledger(world_id,agent_id,token_address,order_id,side,quantity_delta_raw)
    VALUES($1,$2,$3,$4,'buy',1000000000000000000)`, [worldId, agentId, tokenAddress, robinhoodOrderId]);
  return tokenAddress;
}

test('isolated 24-hour world keeps social state durable and leaves legacy paper trading records untouched', {
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
    const legacyTokenAddress = await seedLegacyPaperTradingHistory(pool, worldId, agentIds[0]);
    const legacyHistoryBefore = await legacyPaperTradingSnapshot(pool, worldId, legacyTokenAddress);
    await pool.query(schema);
    const importedPaperAccounts = await pool.query(`SELECT account_type,asset_symbol,balance::text AS balance
      FROM world_economic_accounts WHERE world_id=$1 AND owner_id=$2`, [worldId, agentIds[0]]);
    assert.equal(importedPaperAccounts.rowCount, 0,
      'reapplying the schema must retain historical paper balances without importing them into active resident accounts');

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
    let forcedSocialAction = false;
    const residentFruitfly = {
      choose(agentId, observation, candidates, preferred) {
        const choice = fruitfly.choose(agentId, observation, candidates, preferred);
        const social = candidates.find((candidate) => candidate.action === 'socialize' && candidate.socialPartnerId);
        if (agentId === agentIds[0] && !forcedSocialAction && social) {
          forcedSocialAction = true;
          return { ...choice, candidate: social, action: 'socialize',
            behaviorProbability: choice.probabilities.socialize || 0,
            fruitflyProbability: choice.fruitflyProbabilities.socialize || 0 };
        }
        return choice;
      },
      learn: (...args) => fruitfly.learn(...args)
    };
    const engineOptions = { worldId, schedule: false, fruitfly: residentFruitfly, nowProvider: () => simulatedNow,
      chooseWithTypeSafe, runtimeState,
      onError: (error, phase) => onErrors.push({ message: error.message, phase }),
      onStatus: (status) => { if (status.typeSafe) typeSafeResults.push(status.typeSafe); } };
    const start = () => startWorldEngine(pool, engineOptions);
    engine = await start();
    assert.equal(engine.running, true);
    let profileBeforeRestart;
    const clockBeforeDuplicate = Number((await pool.query('SELECT world_minutes FROM world_runtime_state WHERE world_id=$1',
      [worldId])).rows[0].world_minutes);
    const duplicateEngine = await startWorldEngine(pool, { worldId, schedule: false, nowProvider: () => simulatedNow });
    assert.equal(duplicateEngine.running, false, 'the engine advisory lock should reject a second instance');
    assert.equal(Number((await pool.query('SELECT world_minutes FROM world_runtime_state WHERE world_id=$1',
      [worldId])).rows[0].world_minutes), clockBeforeDuplicate);

    for (let minute = 0; minute < 719; minute++) {
      simulatedNow += 1_000;
      await engine.tickOnce();
    }
    profileBeforeRestart = (await pool.query(`SELECT primary_goal,sociability FROM world_social_profiles
      WHERE world_id=$1 AND agent_id=$2`, [worldId, agentIds[0]])).rows[0];
    await engine.stop();
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
    }
    await engine.stop();
    engine = null;

    const runtime = (await pool.query('SELECT world_minutes FROM world_runtime_state WHERE world_id=$1', [worldId])).rows[0];
    const interaction = await pool.query(`SELECT count(*)::int AS count FROM world_relationships WHERE world_id=$1`, [worldId]);
    const socialMemories = await pool.query(`SELECT count(*)::int AS count FROM agent_memories
      WHERE world_id=$1 AND memory_type='social'`, [worldId]);
    const legacyHistoryAfter = await legacyPaperTradingSnapshot(pool, worldId, legacyTokenAddress);
    const tradingActions = await pool.query(`SELECT count(*)::int AS count FROM world_events
      WHERE world_id=$1 AND (event_type LIKE 'crypto.%'
        OR data->>'action' IN ('trade','trade_crypto','trade_meme','trade_hold'))`, [worldId]);
    const tradingCandidates = await pool.query(`SELECT count(*)::int AS count FROM world_agent_states state
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(state.fruitfly_candidates,'[]'::jsonb)) candidate
      WHERE state.world_id=$1 AND candidate->>'action' IN ('trade','trade_crypto','trade_meme','trade_hold')`, [worldId]);
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
        COALESCE((SELECT account.balance::text FROM world_economic_accounts account
          WHERE account.world_id=m.world_id AND account.account_type='resident' AND account.owner_id=m.agent_id
            AND account.asset_symbol='USDC'),'0.00000000') AS wealth,
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
    assert.deepEqual(legacyHistoryAfter, legacyHistoryBefore,
      'legacy balances, quotes, orders, positions and scan observations remain unchanged');
    assert.equal(tradingActions.rows[0].count, 0, 'the engine must not record new resident trading actions');
    assert.equal(tradingCandidates.rows[0].count, 0, 'resident candidate sets must not contain removed trading actions');
    assert.ok(reflections.rows[0].count > 0, 'low-frequency reflection should persist its evidence and result');
    assert.ok(decisionTraces.rows[0].count > 0, 'selected actions should persist their decision explanation');
    assert.ok(activeGoals.rows[0].count > 0, 'open-ended goal records should remain active after the run');
    assert.ok(beliefs.rows[0].count > 0, 'experience should consolidate into resident-specific beliefs');
    assert.ok(goalCaps.rows[0].maxTotal <= 7 && goalCaps.rows[0].maxPrimary <= 1
      && goalCaps.rows[0].maxSecondary <= 3 && goalCaps.rows[0].maxShort <= 3,
    'active goal counts should stay bounded for each resident');
    assert.ok(completed.rows[0].count > 0, 'completed actions should be persisted');
    assert.ok(actionKinds.rows[0].count >= 3, 'the cohort should perform multiple action types');
    assert.ok(changedNeeds.rows[0].count > 0, 'needs should change as actions complete');
    assert.ok(new Set(residentPaths.rows.map((resident) => resident.goal)).size >= 4,
      'residents should retain distinct long-term goals');
    assert.ok(new Set(residentPaths.rows.map((resident) => JSON.stringify(resident.skills))).size > 1,
      'resident skills should diverge through completed actions');
    assert.ok(new Set(residentPaths.rows.map((resident) => JSON.stringify(resident.actions))).size > 1,
      'residents should show different observed action histories');
    assert.deepEqual(onErrors, [], 'the isolated engine run should not report errors');
    if (process.env.TYPESAFE_API_KEY) assert.ok(typeSafeResults.some((result) => result.reason === 'selected'),
      'configured TypeSafe should select a strategic goal during the simulation');
    t.diagnostic(JSON.stringify({ worldMinutes: Number(runtime.world_minutes), relationships: interaction.rows[0].count,
      socialMemories: socialMemories.rows[0].count, legacyTradingRows: Object.fromEntries(
        Object.entries(legacyHistoryAfter).map(([table, rows]) => [table, rows.length])),
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
    await inTransaction(pool, (client) => fundTestResidents(client, { worldId, agentIds }));
    await pool.query(`INSERT INTO world_scenes(world_id,created_by,name,scene_type,description)
      VALUES($1,$2,'Workshop','workshop','A shared cooperative worksite.')`, [worldId, actorId]);
    await pool.query(`INSERT INTO world_relationships(world_id,agent_a_id,agent_b_id,familiarity,trust,affinity,interaction_count)
      VALUES($1,$2,$3,80,24,35,4)`, [worldId, actorId, partnerId]);
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
    const balances = await pool.query(`SELECT owner_id AS agent_id,balance::text AS balance FROM world_economic_accounts
      WHERE world_id=$1 AND account_type='resident' AND asset_symbol='USDC' ORDER BY owner_id`, [worldId]);
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
    assert.ok(balances.rows.every((row) => Number(row.balance) === 10_000),
      'cooperative work preserves residents\' internally funded USDC balances');
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

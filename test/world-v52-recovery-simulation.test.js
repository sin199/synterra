import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { createFruitflyRuntime } from '../src/agent-runtime/fruitfly.js';
import { initialMind } from '../src/agent-runtime/mind.js';
import { closeWorldBusiness, completeWorldBusinessShift, economicDashboardSql, foundWorldBusiness,
  purchaseWorldBusinessService, readEconomicRecoveryMetrics } from '../src/world-businesses.js';
import { startWorldEngine } from '../src/world-engine.js';

const databaseUrl = process.env.SYNTERRA_TEST_DATABASE_URL;
const enabled = process.env.SYNTERRA_TEST_ISOLATED === '1' && Boolean(databaseUrl);
const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const stepSeconds = 30;
const recoveryDays = 30;
const initialEconomyDays = 1;
const seedLimit = Math.max(1, Math.min(10, Number.parseInt(process.env.SYNTERRA_TEST_RECOVERY_SEED_LIMIT || '10', 10) || 10));
const seedNumbers = Array.from({ length: seedLimit }, (_, index) => index + 1);

function deterministicUuid(seed, label) {
  const bytes = createHash('sha256').update(`synterra-v5.2-recovery:${seed}:${label}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function assertIsolatedDatabase(connectionString) {
  const parsed = new URL(connectionString);
  assert.ok(['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname), 'recovery simulation requires loopback PostgreSQL');
  assert.ok(decodeURIComponent(parsed.pathname.slice(1)).endsWith('_test'), 'recovery DB name must end in _test');
  assert.notEqual(parsed.port, '5432', 'recovery simulation must not use the default PostgreSQL port');
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

test(`10-seed collapse/recovery simulation runs ${recoveryDays} world days after a legal provider shutdown`, {
  skip: !enabled,
  timeout: 3_600_000
}, async (t) => {
  assertIsolatedDatabase(databaseUrl);
  const pool = new Pool({ connectionString: databaseUrl, max: 6 });
  const schema = await readFile(path.join(repoRoot, 'schema.sql'), 'utf8');
  await pool.query(schema);
  const results = [];
  try {
    for (const seed of seedNumbers) {
      const worldId = deterministicUuid(seed, 'world');
      const agentIds = Array.from({ length: 10 }, (_, index) => deterministicUuid(seed, `resident-${index + 1}`));
      const ownerId = agentIds[0];
      const baseMs = Date.now() + seed * 60_000;
      const stepsBeforeCollapse = initialEconomyDays * 1_440 / stepSeconds;
      const stepsAfterCollapse = recoveryDays * 1_440 / stepSeconds;
      let nowMs = baseMs;
      let engine = null;
      const engineErrors = [];
      const fruitflyDir = await mkdtemp(path.join(os.tmpdir(), `synterra-v52-${seed}-`));
      try {
        await pool.query('DELETE FROM worlds WHERE id=$1', [worldId]);
        await pool.query('DELETE FROM agents WHERE id=ANY($1::uuid[])', [agentIds]);
        await pool.query(`INSERT INTO agents(id,name,public_key,gender) VALUES ${agentIds.map((_, index) =>
          `($${index * 3 + 1},$${index * 3 + 2},$${index * 3 + 3},'${index % 2 ? 'male' : 'female'}')`).join(',')}`,
        agentIds.flatMap((id, index) => [id, `V52 Seed ${seed} Resident ${String(index + 1).padStart(2, '0')}`, `v52-sim-key-${id}`]));
        await pool.query(`INSERT INTO worlds(id,owner_agent_id,name,chain_id,open)
          VALUES($1,$2,$3,5042,true)`, [worldId, ownerId, `V5.2 Recovery Seed ${seed}`]);
        const places = [
          ['Town Commons', 'commons', { x: 0, z: 0 }], ['Garden', 'garden', { x: -0.65, z: -0.4 }],
          ['Library', 'library', { x: 0.55, z: -0.65 }], ['Cafe', 'cafe', { x: 0.7, z: 0.4 }],
          ['Workshop', 'workshop', { x: -0.5, z: 0.65 }], ['Data Center', 'data_center', { x: -0.1, z: -0.8 }],
          ['Exchange', 'commons', { x: 0.05, z: 0.1 }]
        ];
        for (const [name, sceneType, position] of places) await pool.query(`INSERT INTO world_scenes(world_id,created_by,name,
            scene_type,description,purpose,capacity,position)
          VALUES($1,$2,$3,$4,$5,$6,16,$7::jsonb)`, [worldId, ownerId, name, sceneType,
          `Recovery experiment ${sceneType} environment.`, `Seed ${seed} shared ${sceneType} environment.`, JSON.stringify(position)]);
        for (const [index, agentId] of agentIds.entries()) {
          const mind = initialMind((index + seed - 1) % 10 + 1);
          await pool.query(`INSERT INTO world_members(world_id,agent_id,role,energy,food,social,location)
              VALUES($1,$2,$3,100,100,100,$4)`, [worldId, agentId, index === 0 ? 'owner' : 'resident',
            places[index % places.length][0]]);
          await pool.query(`INSERT INTO agent_minds(world_id,agent_id,archetype,traits,current_goal)
              VALUES($1,$2,$3,$4::jsonb,$5)`, [worldId, agentId, mind.archetype, JSON.stringify(mind.traits), mind.currentGoal]);
        }
        await pool.query(`INSERT INTO crypto_market_quotes(symbol,price_usd,quote_version,as_of,source) VALUES
          ('USDC',1,1,$1,'synterra_simulated_market'),('BTC',65000,1,$1,'synterra_simulated_market'),
          ('ETH',2500,1,$1,'synterra_simulated_market') ON CONFLICT(symbol) DO UPDATE SET
          price_usd=EXCLUDED.price_usd,quote_version=EXCLUDED.quote_version,as_of=EXCLUDED.as_of,
          source=EXCLUDED.source`, [new Date(baseMs)]);
        await pool.query(`INSERT INTO world_runtime_state(world_id,tick_count,world_minutes,last_tick_at,typesafe_next_at)
          VALUES($1,0,480,$2,$3)`, [worldId, new Date(baseMs - stepSeconds * 1_000), new Date(baseMs + 90 * 86_400_000)]);

        const fruitfly = await createFruitflyRuntime(fruitflyDir);
        engine = await startWorldEngine(pool, { worldId, schedule: false, fruitfly, nowProvider: () => nowMs,
          onError(error, phase) { if (engineErrors.length < 10) engineErrors.push({ phase,
            message: String(error?.message || error).slice(0, 180) }); } });
        assert.equal(engine.running, true);

        const providerSpecs = [
          { founder: agentIds[0], businessType: 'food', serviceType: 'food_service', place: 'Cafe',
            name: `Seed ${seed} Food Provider`, service: 'Prepared Meal', price: '12.00000000' },
          { founder: agentIds[1], businessType: 'research', serviceType: 'research_service', place: 'Library',
            name: `Seed ${seed} Research Provider`, service: 'Research Notes', price: '35.00000000' },
          { founder: agentIds[2], businessType: 'social', serviceType: 'social_service', place: 'Town Commons',
            name: `Seed ${seed} Social Provider`, service: 'Community Session', price: '18.00000000' }
        ];
        const providers = [];
        for (const [index, spec] of providerSpecs.entries()) {
          const placeId = (await pool.query('SELECT id FROM world_scenes WHERE world_id=$1 AND name=$2', [worldId, spec.place])).rows[0].id;
          const result = await inTransaction(pool, (client) => foundWorldBusiness(client, { worldId, agentId: spec.founder,
            actionId: `v52-seed-${seed}-initial-business-${index}`, worldTime: 480,
            proposal: { name: spec.name, businessType: spec.businessType,
              purpose: `Respond to resident ${spec.serviceType} needs in the normal-economy phase.`,
              serviceType: spec.serviceType, serviceName: spec.service,
              serviceDescription: `${spec.service} supplied from actual resident production.`,
              basePriceUsdc: spec.price, capitalUsdc: '250.00000000', placeId } }));
          providers.push({ ...spec, businessId: result.id, serviceId: result.serviceId });
          await inTransaction(pool, (client) => completeWorldBusinessShift(client, { worldId, businessId: result.id,
            serviceId: result.serviceId, agentId: spec.founder, actionId: `v52-seed-${seed}-initial-production-${index}`,
            worldTime: 481 }));
          const customerId = agentIds[(index + 4) % agentIds.length];
          await inTransaction(pool, (client) => purchaseWorldBusinessService(client, { worldId, serviceId: result.serviceId,
            customerAgentId: customerId, actionId: `v52-seed-${seed}-initial-purchase-${index}`, worldTime: 482 + index,
            maxPriceUsdc: '100.00000000', demand: 8, supply: 0, wealth: 10_000, priceSensitivity: 0.4 }));
        }

        for (let index = 0; index < stepsBeforeCollapse; index += 1) {
          nowMs += stepSeconds * 1_000;
          await engine.tickOnce();
        }
        const baselineActivity = await pool.query(`SELECT
            count(*) FILTER (WHERE event_type='world.action_completed')::int AS actions,
            (SELECT count(*)::int FROM world_business_orders order_row WHERE order_row.world_id=$1
              AND order_row.status='fulfilled') AS purchases
          FROM world_events WHERE world_id=$1`, [worldId]);
        assert.ok(Number(baselineActivity.rows[0].actions) > 0, 'initial economy phase must execute resident behavior');
        assert.ok(Number(baselineActivity.rows[0].purchases) >= providerSpecs.length,
          'initial economy must contain actual paid service delivery before collapse');
        const beforeCollapse = await pool.query(`SELECT world_minutes FROM world_runtime_state WHERE world_id=$1`, [worldId]);
        const collapseMinute = Number(beforeCollapse.rows[0].world_minutes);
        const allBusinesses = await pool.query(`SELECT id,founder_agent_id AS "founderAgentId",status FROM world_businesses
          WHERE world_id=$1 ORDER BY founded_world_time,id`, [worldId]);
        for (const business of allBusinesses.rows) if (!['closed','bankrupt'].includes(business.status)) {
          await inTransaction(pool, (client) => closeWorldBusiness(client, { worldId, businessId: business.id,
            founderAgentId: business.founderAgentId, actionId: `v52-seed-${seed}-collapse-${business.id}`,
            worldTime: collapseMinute }));
        }
        const collapsed = await pool.query(`SELECT count(*)::int AS businesses,
            count(*) FILTER (WHERE status IN ('closed','bankrupt'))::int AS closed
          FROM world_businesses WHERE world_id=$1`, [worldId]);
        assert.ok(Number(collapsed.rows[0].businesses) > 0);
        assert.equal(Number(collapsed.rows[0].closed), Number(collapsed.rows[0].businesses),
          'the collapse phase must close every provider before observing recovery');

        for (let index = 0; index < stepsAfterCollapse; index += 1) {
          nowMs += stepSeconds * 1_000;
          await engine.tickOnce();
        }
        await engine.stop();
        engine = null;

        const finalClock = Number((await pool.query(`SELECT world_minutes FROM world_runtime_state WHERE world_id=$1`, [worldId])).rows[0].world_minutes);
        assert.equal(finalClock, collapseMinute + recoveryDays * 1_440, 'world time advances through the full recovery window');
        const recovery = await readEconomicRecoveryMetrics(pool, { worldId, worldMinutes: finalClock,
          windowMinutes: recoveryDays * 1_440 });
        const businessState = (await pool.query(`SELECT count(*)::int AS businesses,
            count(*) FILTER (WHERE status='active')::int AS active,
            count(*) FILTER (WHERE status IN ('closed','bankrupt'))::int AS closed,
            count(*) FILTER (WHERE founded_world_time>$2)::int AS births
          FROM world_businesses WHERE world_id=$1`, [worldId, collapseMinute])).rows[0];
        const observations = (await pool.query(`SELECT count(*)::int AS count FROM world_emergence_events
          WHERE world_id=$1 AND system='business' AND stage='shortage_observed' AND world_minutes>$2`,
        [worldId, collapseMinute])).rows[0].count;
        const blockerCounts = (await pool.query(`SELECT reason_code AS reason,count(*)::int AS count
          FROM world_emergence_events WHERE world_id=$1 AND system='business' AND stage='blocked'
            AND world_minutes>$2 GROUP BY reason_code ORDER BY count(*) DESC LIMIT 6`, [worldId, collapseMinute])).rows;
        const economicAudit = (await pool.query(`SELECT count(*)::int AS unbalanced FROM world_economic_transactions tx
          LEFT JOIN LATERAL (SELECT count(*)::int AS postings,COALESCE(sum(amount),0) AS net
            FROM world_economic_postings posting WHERE posting.transaction_id=tx.id) p ON true
          WHERE tx.world_id=$1 AND (p.postings<>2 OR p.net<>0)`, [worldId])).rows[0];
        const summary = { seed, worldId, collapseMinute, worldMinutes: finalClock, recovery,
          businesses: businessState, shortageObservations: Number(observations), blockers: blockerCounts,
          engineErrors, unbalanced: Number(economicAudit.unbalanced) };
        results.push(summary);
        t.diagnostic(JSON.stringify({ seed, collapseMinute, worldMinutes: finalClock, observations: summary.shortageObservations,
          candidates: recovery.recoveryCandidates, selected: recovery.recoverySelected, actions: recovery.recoveryActions,
          births: recovery.businessBirths, reopens: recovery.businessReopens, employment: recovery.employmentEntries,
          activeSupply: recovery.activeSupply, blockers: blockerCounts, engineErrors }));
        assert.equal(engineErrors.length, 0, 'the world engine must not log an error during recovery');
        assert.equal(summary.unbalanced, 0, 'recovery actions preserve a balanced economic ledger');
      } finally {
        if (engine) await engine.stop();
        await rm(fruitflyDir, { recursive: true, force: true });
      }
    }
    assert.equal(results.length, seedNumbers.length);
    assert.ok(results.some((result) => result.shortageObservations > 0),
      'persistent unmet demand must become observable in at least one deterministic seed');
    assert.ok(results.some((result) => result.recovery.recoveryActions > 0),
      'the recovery system must produce at least one real action across the 10 seeds');
    assert.ok(results.some((result) => Number(result.businesses.births) > 0
      || result.recovery.businessReopens > 0 || result.recovery.employmentEntries > 0),
    'at least one seed must form new supply, reopen, or enter employment after collapse');
  } finally {
    await pool.end();
  }
});

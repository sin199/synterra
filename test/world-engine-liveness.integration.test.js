import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { startWorldEngine } from '../src/world-engine.js';

const databaseUrl = process.env.SYNTERRA_TEST_DATABASE_URL;
const enabled = process.env.SYNTERRA_TEST_ISOLATED === '1' && Boolean(databaseUrl);
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test('tick failures remain visible and the scheduled engine commits a later tick without duplicate settlement', {
  skip: !enabled,
  timeout: 30_000
}, async () => {
  const parsed = new URL(databaseUrl);
  assert.ok(['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname));
  assert.ok(decodeURIComponent(parsed.pathname.slice(1)).endsWith('_test'));
  assert.notEqual(parsed.port, '5432');

  const pool = new Pool({ connectionString: databaseUrl, max: 4, connectionTimeoutMillis: 3_000 });
  const worldId = randomUUID();
  const agentIds = [randomUUID(), randomUUID()];
  const writes = [];
  let typeSafeCalls = 0;
  let engine;
  let triggerInstalled = false;
  try {
    await pool.query(await readFile(path.join(root, 'schema.sql'), 'utf8'));
    await pool.query(`INSERT INTO agents(id,name,public_key,gender) VALUES
      ($1,'Liveness Test One','liveness-test-one','female'),($2,'Liveness Test Two','liveness-test-two','male')`, agentIds);
    await pool.query(`INSERT INTO worlds(id,owner_agent_id,name,chain_id,open) VALUES($1,$2,'Liveness test world',5042,true)`,
      [worldId, agentIds[0]]);
    await pool.query(`INSERT INTO world_members(world_id,agent_id,location,energy,food,social)
      VALUES($1,$2,'Garden',100,100,100),($1,$3,'Garden',100,100,100)`, [worldId, ...agentIds]);
    await pool.query(`INSERT INTO world_runtime_state(world_id,tick_count,world_minutes,last_tick_at,typesafe_next_at)
      VALUES($1,0,480,now()-interval '8 hours',now()-interval '1 second')`, [worldId]);
    await pool.query(`INSERT INTO crypto_risk_limits(world_id) VALUES($1) ON CONFLICT DO NOTHING`, [worldId]);
    await pool.query(`CREATE OR REPLACE FUNCTION synterra_v61_fail_tick_fixture() RETURNS trigger AS $$
      BEGIN
        IF NEW.world_id::text = TG_ARGV[0] AND NEW.tick_count > OLD.tick_count THEN
          RAISE EXCEPTION 'liveness regression fixture tick failure';
        END IF;
        RETURN NEW;
      END
      $$ LANGUAGE plpgsql`);
    await pool.query(`CREATE TRIGGER synterra_v61_fail_tick_fixture BEFORE UPDATE ON world_runtime_state
      FOR EACH ROW EXECUTE FUNCTION synterra_v61_fail_tick_fixture('${worldId}')`);
    triggerInstalled = true;

    engine = await startWorldEngine(pool, { worldId, tickMs: 250,
      chooseWithTypeSafe() { typeSafeCalls += 1; return new Promise(() => {}); }, runtimeState: {},
      emergencySink: { write(line) { writes.push(line); } },
      onError() { throw new Error('simulated closed logger'); } });
    assert.equal(engine.running, true);
    assert.equal(engine.getLiveness().worldLockOwned, true);
    assert.equal(engine.getLiveness().schedulerRunning, true);
    assert.match(engine.getLiveness().lastTickError.errorMessage, /liveness regression fixture tick failure/);
    assert.match(writes.join(''), /liveness regression fixture tick failure/);
    assert.match(writes.join(''), new RegExp(worldId));
    assert.match(writes.join(''), /CLOCK_ADVANCE/);
    assert.equal(typeSafeCalls, 0, 'TypeSafe starts only after its due tick commits');

    await pool.query('DROP TRIGGER synterra_v61_fail_tick_fixture ON world_runtime_state');
    triggerInstalled = false;
    const before = (await pool.query(`SELECT tick_count,world_minutes FROM world_runtime_state WHERE world_id=$1`, [worldId])).rows[0];
    const ledgerBefore = Number((await pool.query(`SELECT count(*)::int AS count FROM token_ledger WHERE world_id=$1`,
      [worldId])).rows[0].count);
    const deadline = Date.now() + 8_000;
    let after = before;
    while (Date.now() < deadline && Number(after.tick_count) <= Number(before.tick_count)) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      after = (await pool.query(`SELECT tick_count,world_minutes FROM world_runtime_state WHERE world_id=$1`, [worldId])).rows[0];
    }
    assert.ok(Number(after.tick_count) > Number(before.tick_count), 'the scheduler should commit a later tick');
    assert.ok(Number(after.world_minutes) > Number(before.world_minutes));
    assert.ok(Number(after.world_minutes) - Number(before.world_minutes) < 20,
      'restart must resume from the persisted minute instead of fast-forwarding downtime');
    const typeSafeDeadline = Date.now() + 2_000;
    while (Date.now() < typeSafeDeadline && typeSafeCalls === 0) await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(typeSafeCalls, 1, 'a failed transaction must release its reserved TypeSafe single-flight slot');
    const typeSafeStartedAt = Number(after.tick_count);
    const fallbackDeadline = Date.now() + 14_000;
    while (Date.now() < fallbackDeadline && engine.getLiveness().lastEngineError?.stage !== 'typesafe_strategic_timeout') {
      await new Promise((resolve) => setTimeout(resolve, 200));
      after = (await pool.query(`SELECT tick_count,world_minutes FROM world_runtime_state WHERE world_id=$1`, [worldId])).rows[0];
    }
    assert.equal(engine.getLiveness().lastEngineError?.stage, 'typesafe_strategic_timeout',
      'hung optional TypeSafe reasoning must time out and become observable');
    assert.ok(Number(after.tick_count) >= typeSafeStartedAt + 10,
      'world ticks continue while optional TypeSafe reasoning is unresolved');
    assert.equal(Number((await pool.query(`SELECT count(*)::int AS count FROM token_ledger WHERE world_id=$1`,
      [worldId])).rows[0].count), ledgerBefore, 'the failed transaction must not duplicate economic settlement');
    assert.match(engine.getLiveness().lastTickError.errorMessage, /liveness regression fixture tick failure/,
      'the last failure remains available for diagnosis after recovery');
    assert.equal(engine.getLiveness().worldLockOwned, true);
  } finally {
    if (engine) await engine.stop();
    if (triggerInstalled) await pool.query('DROP TRIGGER IF EXISTS synterra_v61_fail_tick_fixture ON world_runtime_state');
    await pool.query('DROP FUNCTION IF EXISTS synterra_v61_fail_tick_fixture()');
    await pool.query('DELETE FROM worlds WHERE id=$1', [worldId]);
    await pool.query('DELETE FROM agents WHERE id=ANY($1::uuid[])', [agentIds]);
    await pool.end();
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createFruitflyRuntime } from '../src/agent-runtime/fruitfly.js';
import { startWorldEngine } from '../src/world-engine.js';
import { isHomeLocation, placeSchedule, worldCalendar } from '../src/world-environment.js';

const databaseUrl = process.env.SYNTERRA_TEST_DATABASE_URL;
const enabled = process.env.SYNTERRA_TEST_ISOLATED === '1' && Boolean(databaseUrl);
const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test('an isolated night follows opening hours, circadian sleep at home, and the hourly needs model', {
  skip: !enabled, timeout: 300_000
}, async () => {
  const parsed = new URL(databaseUrl);
  assert.ok(['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname));
  assert.ok(decodeURIComponent(parsed.pathname.slice(1)).endsWith('_test'));
  const pool = new Pool({ connectionString: databaseUrl, max: 4 });
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'synterra-environment-'));
  const worldId = randomUUID();
  const agentIds = Array.from({ length: 6 }, () => randomUUID());
  let engine;
  try {
    await pool.query(await readFile(path.join(repoRoot, 'schema.sql'), 'utf8'));
    await pool.query(`INSERT INTO agents(id,name,public_key,gender) VALUES ${agentIds.map((_, index) =>
      `($${index * 3 + 1},$${index * 3 + 2},$${index * 3 + 3},'female')`).join(',')}`,
    agentIds.flatMap((agentId, index) => [agentId, `Environment Test ${index + 1}`, `environment-test-key-${agentId}`]));
    await pool.query(`INSERT INTO worlds(id,owner_agent_id,name,chain_id,open) VALUES($1,$2,'Environment Test',5042,true)`,
      [worldId, agentIds[0]]);
    await pool.query(`INSERT INTO world_members(world_id,agent_id,location,energy,food,social)
      SELECT $1,id,'Cafe',55,70,80 FROM agents WHERE id=ANY($2::uuid[])`, [worldId, agentIds]);
    await pool.query(`INSERT INTO world_scenes(world_id,created_by,name,scene_type,description,position) VALUES
      ($1,$2,'Cafe','cafe','A public meeting place for residents.','{"x":0.1,"z":0.2}'),
      ($1,$2,'Garden','garden','A quiet garden for rest and conversation.','{"x":0.5,"z":0.1}'),
      ($1,$2,'Workshop','workshop','A place for paid engineering shifts.','{"x":-0.4,"z":0.3}'),
      ($1,$2,'Library','library','A place to study and learn.','{"x":0.2,"z":-0.6}'),
      ($1,$2,'Observatory','observatory','A place to study the simulated sky.','{"x":-0.8,"z":-0.2}')`,
    [worldId, agentIds[0]]);
    await pool.query(`INSERT INTO crypto_risk_limits(world_id) VALUES($1) ON CONFLICT DO NOTHING`, [worldId]);
    // Start on day 1 at 19:00 and run through the night to 10:00.
    await pool.query(`INSERT INTO world_runtime_state(world_id,tick_count,world_minutes,last_tick_at,typesafe_next_at)
      VALUES($1,0,1140,now(),now()+interval '1 day')`, [worldId]);
    let simulatedNow = Date.now();
    const onErrors = [];
    const fruitfly = await createFruitflyRuntime(stateDir);
    engine = await startWorldEngine(pool, { worldId, schedule: false, fruitfly, nowProvider: () => simulatedNow,
      onError: (error, phase) => onErrors.push({ message: error.message, phase }) });
    assert.equal(engine.running, true);
    const asleepAt = new Map();
    while (Number((await pool.query('SELECT world_minutes FROM world_runtime_state WHERE world_id=$1', [worldId]))
      .rows[0].world_minutes) < 1_440 + 600) {
      simulatedNow += 3_000;
      await engine.tickOnce();
      const sleeping = await pool.query(`SELECT agent_id FROM world_agent_states
        WHERE world_id=$1 AND status='performing' AND activity_variant='sleep'`, [worldId]);
      for (const row of sleeping.rows) asleepAt.set(row.agent_id, true);
    }
    await engine.stop();
    engine = null;
    assert.deepEqual(onErrors, []);

    const runtime = (await pool.query('SELECT world_minutes,environment FROM world_runtime_state WHERE world_id=$1', [worldId])).rows[0];
    assert.ok(['clear', 'cloudy', 'fog', 'rain', 'storm', 'snow', 'heatwave'].includes(runtime.environment.condition));
    assert.equal(runtime.environment.season, 'spring');

    const started = await pool.query(`SELECT actor_id,data FROM world_events
      WHERE world_id=$1 AND event_type IN ('world.action_started','world.agent_arrived') ORDER BY id`, [worldId]);
    const sleepStarts = started.rows.filter((row) => row.data.variant === 'sleep');
    assert.ok(sleepStarts.length >= 1, 'residents go home and sleep during their night');
    assert.ok(sleepStarts.every((row) => isHomeLocation(row.data.place)));
    assert.ok(asleepAt.size >= 1);
    const scenes = (await pool.query(`SELECT name,scene_type AS "sceneType",status,features FROM world_scenes WHERE world_id=$1`,
      [worldId])).rows;
    const institutionalSelections = new Set((await pool.query(`SELECT agent_id::text||':'||tick_count::text AS key
      FROM world_emergence_events WHERE world_id=$1 AND system='institution' AND stage='selected'`, [worldId])).rows
      .map((row) => row.key));
    for (const row of started.rows) {
      const scene = scenes.find((item) => item.name === row.data.place);
      // Commitments chosen through the institutional plan are documented as not hour-filtered.
      if (institutionalSelections.size && row.data.action?.startsWith('business_')) continue;
      if (!scene || !Number.isFinite(Number(row.data.worldMinutes))) continue;
      assert.equal(placeSchedule(scene, worldCalendar(Number(row.data.worldMinutes))).open, true,
        `${row.data.action} at ${scene.name} must happen while it is open (minute ${row.data.worldMinutes})`);
    }
    const completedSleep = await pool.query(`SELECT count(*)::int AS count FROM world_events
      WHERE world_id=$1 AND event_type='world.action_completed' AND data->>'variant'='sleep'`, [worldId]);
    assert.ok(completedSleep.rows[0].count >= 1, 'sleep ends at the resident wake time');
    const needs = await pool.query(`SELECT s.hygiene,s.fun,s.happiness,m.energy FROM world_agent_states s
      JOIN world_members m USING(world_id,agent_id) WHERE s.world_id=$1`, [worldId]);
    assert.ok(needs.rows.some((row) => row.hygiene !== 80 || row.fun !== 70), 'hygiene and fun change over time');
    assert.ok(needs.rows.every((row) => [row.hygiene, row.fun, row.happiness, row.energy]
      .every((value) => value >= 0 && value <= 100)));
  } finally {
    if (engine) await engine.stop();
    await pool.query('DELETE FROM worlds WHERE id=$1', [worldId]);
    await pool.query('DELETE FROM agents WHERE id=ANY($1::uuid[])', [agentIds]);
    await pool.end();
    await rm(stateDir, { recursive: true, force: true });
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { createFruitflyRuntime } from '../src/agent-runtime/fruitfly.js';
import { initialMind } from '../src/agent-runtime/mind.js';
import { startWorldEngine } from '../src/world-engine.js';

const databaseUrl = process.env.SYNTERRA_TEST_DATABASE_URL;
const hours = Number(process.env.SYNTERRA_V3_SIMULATION_HOURS || 0);
const enabled = process.env.SYNTERRA_TEST_ISOLATED === '1' && Boolean(databaseUrl) && [24, 72].includes(hours);
const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function assertIsolatedDatabase(connectionString) {
  const parsed = new URL(connectionString);
  assert.ok(['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname), 'simulation requires loopback PostgreSQL');
  assert.ok(decodeURIComponent(parsed.pathname.slice(1)).endsWith('_test'), 'simulation database name must end in _test');
  assert.notEqual(parsed.port, '5432', 'simulation must not use the default PostgreSQL port');
}

test(`isolated Fruitfly world simulation runs ${hours || 'requested'} world hours`, {
  skip: !enabled,
  timeout: hours === 72 ? 300_000 : 180_000
}, async (t) => {
  assertIsolatedDatabase(databaseUrl);
  const openedAt = performance.now();
  const simulationId = randomUUID();
  const worldId = randomUUID();
  const agentIds = Array.from({ length: 10 }, () => randomUUID());
  const ownerId = agentIds[0];
  const stepSeconds = 5;
  const simulatedMinutes = hours * 60;
  const steps = simulatedMinutes / stepSeconds;
  const baseMs = Date.now() + 30_000;
  let nowMs = baseMs;
  let pool = new Pool({ connectionString: databaseUrl, max: 4 });
  let engine = null;
  let fruitflyDirectory = null;
  const errors = new Map();
  const errorSamples = [];
  try {
    await pool.query(await readFile(path.join(repoRoot, 'schema.sql'), 'utf8'));
    await pool.query(`INSERT INTO agents(id,name,public_key,gender) VALUES ${agentIds.map((_, index) =>
      `($${index * 3 + 1},$${index * 3 + 2},$${index * 3 + 3},'${index % 2 ? 'male' : 'female'}')`).join(',')}`,
    agentIds.flatMap((id, index) => [id, `Simulation ${simulationId.slice(0, 6)} Resident ${String(index + 1).padStart(2, '0')}`, `sim-key-${id}`]));
    await pool.query(`INSERT INTO worlds(id,owner_agent_id,name,chain_id,open) VALUES($1,$2,$3,5042,true)`,
      [worldId, ownerId, `V3 Isolated ${hours}h Simulation`]);

    const places = [
      ['Town Commons', 'commons', 'A shared central commons for resident conversation and coordination.', { x: 0, z: 0 }],
      ['Garden', 'garden', 'A planted garden where residents can rest and notice seasonal changes.', { x: -0.65, z: -0.4 }],
      ['Library', 'library', 'A quiet library for research, study, and careful record keeping.', { x: 0.55, z: -0.65 }],
      ['Cafe', 'cafe', 'A friendly cafe for meals and low-pressure resident conversation.', { x: 0.7, z: 0.4 }],
      ['Workshop', 'workshop', 'A shared workshop for paid work and cooperative projects.', { x: -0.5, z: 0.65 }],
      ['Data Center', 'data_center', 'A shared data center for technical operations and paid shifts.', { x: -0.1, z: -0.8 }]
    ];
    for (const [index, place] of places.entries()) {
      const [name, sceneType, description, position] = place;
      await pool.query(`INSERT INTO world_scenes(world_id,created_by,name,scene_type,description,purpose,capacity,position)
        VALUES($1,$2,$3,$4,$5,$6,8,$7::jsonb)`,
      [worldId, ownerId, name, sceneType, description, `A shared ${sceneType.replaceAll('_', ' ')} in the test world.`,
        JSON.stringify(position)]);
      assert.ok(index >= 0);
    }
    const placeNames = places.map(([name]) => name);
    for (const [index, agentId] of agentIds.entries()) {
      await pool.query(`INSERT INTO world_members(world_id,agent_id,role,energy,food,social,location)
        VALUES($1,$2,$3,100,100,100,$4)`,
      [worldId, agentId, index === 0 ? 'owner' : 'resident', placeNames[index % placeNames.length]]);
      const mind = initialMind(index + 1);
      await pool.query(`INSERT INTO agent_minds(world_id,agent_id,archetype,traits,current_goal)
        VALUES($1,$2,$3,$4::jsonb,$5)`,
      [worldId, agentId, mind.archetype, JSON.stringify(mind.traits), mind.currentGoal]);
    }
    await pool.query(`INSERT INTO crypto_market_quotes(symbol,price_usd,quote_version,as_of,source) VALUES
      ('USDC',1,1,$1,'synterra_simulated_market'),('BTC',65000,1,$1,'synterra_simulated_market'),
      ('ETH',2500,1,$1,'synterra_simulated_market')
      ON CONFLICT(symbol) DO UPDATE SET price_usd=EXCLUDED.price_usd,quote_version=EXCLUDED.quote_version,
        as_of=EXCLUDED.as_of,source=EXCLUDED.source`, [new Date(baseMs)]);
    await pool.query(`INSERT INTO world_runtime_state(world_id,tick_count,world_minutes,last_tick_at,typesafe_next_at)
      VALUES($1,0,0,$2,$3)`, [worldId, new Date(baseMs - stepSeconds * 1_000), new Date(baseMs + 24 * 60 * 60 * 1_000)]);

    fruitflyDirectory = await mkdtemp(path.join(os.tmpdir(), `synterra-v3-${hours}h-`));
    const fruitfly = await createFruitflyRuntime(fruitflyDirectory);
    engine = await startWorldEngine(pool, { schedule: false, fruitfly, nowProvider: () => nowMs,
      onError(error, phase) {
        errors.set(phase, (errors.get(phase) || 0) + 1);
        if (errorSamples.length < 5) errorSamples.push({ phase, message: String(error?.message || error).slice(0, 180) });
      } });
    assert.equal(engine.running, true);
    for (let index = 1; index < steps; index += 1) {
      nowMs += stepSeconds * 1_000;
      await engine.tickOnce();
      if (index % 120 === 0) await new Promise((resolve) => setImmediate(resolve));
    }
    await engine.stop();
    engine = null;

    const final = await pool.query(`SELECT
        (SELECT world_minutes FROM world_runtime_state WHERE world_id=$1)::int AS world_minutes,
        (SELECT count(*)::int FROM world_events WHERE world_id=$1 AND event_type='world.action_completed') AS completed_actions,
        (SELECT count(*)::int FROM world_opportunities WHERE world_id=$1) AS opportunities,
        (SELECT count(*)::int FROM world_opportunities WHERE world_id=$1 AND creator_agent_id IS NOT NULL) AS resident_created_opportunities,
        (SELECT count(*)::int FROM world_projects WHERE world_id=$1) AS projects,
        (SELECT count(*)::int FROM world_projects WHERE world_id=$1 AND status='completed') AS completed_projects,
        (SELECT count(*)::int FROM world_projects WHERE world_id=$1 AND status='failed') AS failed_projects,
        (SELECT count(*)::int FROM world_organizations WHERE world_id=$1) AS organizations,
        (SELECT count(*)::int FROM world_scenes WHERE world_id=$1 AND created_by_project_id IS NOT NULL) AS generated_places,
        (SELECT count(*)::int FROM world_information_shares WHERE world_id=$1) AS information_shares,
        (SELECT count(*)::int FROM world_agent_beliefs WHERE world_id=$1 AND subject_type='project' AND belief_key='shared_awareness') AS shared_beliefs,
        (SELECT count(*)::int FROM world_relationships WHERE world_id=$1) AS relationships,
        (SELECT count(*)::int FROM world_agent_skills WHERE world_id=$1) AS skill_records,
        (SELECT count(*)::int FROM world_history WHERE world_id=$1) AS history_records,
        (SELECT count(*)::int FROM world_scenes WHERE world_id=$1 AND status='active') AS active_places`, [worldId]);
    const actionDistribution = await pool.query(`SELECT data->>'action' AS action,count(*)::int AS count
      FROM world_events WHERE world_id=$1 AND event_type='world.action_completed'
      GROUP BY data->>'action' ORDER BY count(*) DESC,data->>'action'`, [worldId]);
    const initiativeOutcomes = await pool.query(`SELECT data->>'action' AS action,data->>'abandoned' AS abandoned,
        data->'initiative'->>'status' AS initiative_status,data->'initiative'->>'created' AS initiative_created,
        count(*)::int AS count FROM world_events WHERE world_id=$1 AND event_type='world.action_completed'
        AND data->>'action' IN ('opportunity_propose','project_propose','project_join','project_contribute')
        GROUP BY data->>'action',data->>'abandoned',data->'initiative'->>'status',data->'initiative'->>'created'
        ORDER BY data->>'action',data->>'abandoned'`, [worldId]);
    const history = await pool.query(`SELECT world_time AS "worldTime",event_type AS "eventType",title,detail,entity_id AS "entityId"
      FROM world_history WHERE world_id=$1 ORDER BY world_time,id LIMIT 100`, [worldId]);
    const residentActivity = await pool.query(`SELECT agent.name,count(event.id)::int AS actions,
        count(DISTINCT event.data->>'action')::int AS distinct_actions,
        count(DISTINCT COALESCE(event.data->>'place',event.data->>'to'))::int AS distinct_places
      FROM world_members member JOIN agents agent ON agent.id=member.agent_id
      LEFT JOIN world_events event ON event.world_id=member.world_id AND event.actor_id=member.agent_id
        AND event.event_type='world.action_completed'
      WHERE member.world_id=$1 GROUP BY agent.id,agent.name ORDER BY agent.name`, [worldId]);
    const activeProjectMax = await pool.query(`SELECT COALESCE(max(active_count),0)::int AS max_active_projects_per_resident FROM (
      SELECT member.agent_id,count(project.id)::int AS active_count FROM world_members member
      LEFT JOIN world_project_members membership ON membership.world_id=member.world_id
        AND membership.agent_id=member.agent_id AND membership.status='active'
      LEFT JOIN world_projects project ON project.world_id=membership.world_id AND project.id=membership.project_id
        AND project.status='active'
      WHERE member.world_id=$1 GROUP BY member.agent_id) counts`, [worldId]);
    const duplicatePlaces = await pool.query(`SELECT count(*)::int AS count FROM (
      SELECT created_by_project_id FROM world_scenes WHERE world_id=$1 AND created_by_project_id IS NOT NULL
      GROUP BY created_by_project_id HAVING count(*)>1) duplicates`, [worldId]);
    const summary = { simulationId, worldId, simulatedHours: hours, worldMinutes: final.rows[0].world_minutes,
      elapsedSeconds: Math.round((performance.now() - openedAt) / 1_000), fruitfly: 'local bundled runtime',
      typesafe: 'disabled; no provider/network call', errors: Object.fromEntries(errors), errorSamples,
      state: final.rows[0], actionDistribution: actionDistribution.rows, initiativeOutcomes: initiativeOutcomes.rows,
      residentActivity: residentActivity.rows, maxActiveProjectsPerResident: activeProjectMax.rows[0].max_active_projects_per_resident,
      duplicateGeneratedPlaces: duplicatePlaces.rows[0].count, history: history.rows };

    await pool.end();
    pool = new Pool({ connectionString: databaseUrl, max: 2 });
    const afterReconnect = await pool.query(`SELECT
        (SELECT count(*)::int FROM world_projects WHERE world_id=$1) AS projects,
        (SELECT count(*)::int FROM world_organizations WHERE world_id=$1) AS organizations,
        (SELECT count(*)::int FROM world_scenes WHERE world_id=$1 AND created_by_project_id IS NOT NULL) AS generated_places,
        (SELECT world_minutes::int FROM world_runtime_state WHERE world_id=$1) AS world_minutes`, [worldId]);
    summary.persistenceAfterReconnect = afterReconnect.rows[0];
    t.diagnostic(JSON.stringify(summary));

    assert.equal(summary.state.world_minutes, simulatedMinutes, 'simulation must advance the exact requested world time');
    assert.equal(Object.values(errors).reduce((sum, count) => sum + count, 0), 0, 'simulation should complete without engine errors');
    assert.ok(summary.state.completed_actions > 0, 'residents should make autonomous decisions');
    assert.ok(summary.actionDistribution.length >= 3, 'resident behavior should include multiple action families');
    assert.ok(summary.state.active_places <= 40, 'generated places must remain within the world cap');
    assert.ok(summary.duplicateGeneratedPlaces === 0, 'projects must not create duplicate places');
    assert.equal(Number(summary.persistenceAfterReconnect.world_minutes), simulatedMinutes);
    assert.deepEqual(summary.persistenceAfterReconnect.projects, summary.state.projects);
    assert.deepEqual(summary.persistenceAfterReconnect.organizations, summary.state.organizations);
    assert.deepEqual(summary.persistenceAfterReconnect.generated_places, summary.state.generated_places);
    assert.ok(summary.residentActivity.every((resident) => resident.actions > 0), 'all residents should remain active');
  } finally {
    if (engine) await engine.stop();
    if (pool) {
      await pool.query('DELETE FROM worlds WHERE id=$1', [worldId]).catch(() => {});
      await pool.query('DELETE FROM agents WHERE id=ANY($1::uuid[])', [agentIds]).catch(() => {});
      await pool.end();
    }
    if (fruitflyDirectory) await rm(fruitflyDirectory, { recursive: true, force: true });
  }
});

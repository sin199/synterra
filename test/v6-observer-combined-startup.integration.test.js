import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, copyFile, mkdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { Pool } from 'pg';
import { arcNetworkConfig } from '../src/arc/config.js';
import { startWorldEngine } from '../src/world-engine.js';
import { captureV6LifecycleSnapshot, startV6LifecycleObserver } from '../src/world-v6-lifecycle-observer.js';

const databaseUrl = process.env.SYNTERRA_COMBINED_STARTUP_TEST_DATABASE_URL;
const stateDirectory = process.env.SYNTERRA_STATE_DIR;
const aheadSnapshotFixture = process.env.SYNTERRA_OBSERVER_AHEAD_FIXTURE;
const enabled = process.env.SYNTERRA_COMBINED_STARTUP_TEST_ISOLATED === '1'
  && Boolean(databaseUrl && stateDirectory && aheadSnapshotFixture);
const worldId = 'ce434421-8bcd-4aac-b9ba-183383c713de';

function assertIsolatedDatabase(connectionString) {
  const parsed = new URL(connectionString);
  assert.ok(['127.0.0.1','localhost','::1'].includes(parsed.hostname), 'combined startup test requires loopback PostgreSQL');
  assert.notEqual(parsed.port, '5432', 'combined startup test must not use the formal/default PostgreSQL port');
  assert.ok(decodeURIComponent(parsed.pathname.slice(1)).endsWith('_test'),
    'combined startup test requires a *_test database');
}

test('isolated V6 cache recovery, runtime-role Observer, and World Engine startup preserve currency and gate invariants', {
  skip: !enabled,
  timeout: 180_000
}, async () => {
  assertIsolatedDatabase(databaseUrl);
  const resolvedState = path.resolve(stateDirectory);
  assert.notEqual(resolvedState, path.resolve('.synterra'), 'isolated state cannot be the formal runtime directory');
  assert.ok(!resolvedState.startsWith(`${path.resolve('.synterra')}${path.sep}`),
    'isolated state cannot be nested under the formal runtime directory');
  const observerDirectory = path.join(resolvedState, 'v6-observations');
  await mkdir(observerDirectory, { recursive: true, mode: 0o700 });
  await chmod(resolvedState, 0o700);
  await chmod(observerDirectory, 0o700);
  const observerPath = path.join(observerDirectory, 'v6-lifecycle-observer.json');
  await copyFile(aheadSnapshotFixture, observerPath);
  await chmod(observerPath, 0o600);

  const fixture = JSON.parse(await readFile(observerPath, 'utf8'));
  assert.equal(fixture.worldId, worldId);
  assert.equal(Number(fixture.latestWorldMinute), 316_532);
  assert.equal(String(fixture.lastObservationCursor?.capabilityEventId), '31098');
  const pool = new Pool({ connectionString: databaseUrl, max: 8, connectionTimeoutMillis: 5_000 });
  let observer = null;
  let engine = null;
  try {
    const identity = await pool.query('SELECT current_user AS role,current_database() AS database');
    assert.equal(identity.rows[0].role, 'synterra_app', 'the combined startup uses the production application role');
    const before = await pool.query(`SELECT runtime.world_minutes,
        (SELECT count(*)::int FROM world_members WHERE world_id=$1) AS members,
        (SELECT count(*)::int FROM world_capability_gaps WHERE world_id=$1) AS gaps,
        (SELECT count(*)::int FROM world_capability_observations WHERE world_id=$1) AS observations,
        (SELECT count(*)::int FROM world_capability_proposals WHERE world_id=$1) AS v6_proposals,
        (SELECT count(*)::int FROM world_capability_reviews WHERE world_id=$1) AS reviews,
        (SELECT count(*)::int FROM world_capability_experiments WHERE world_id=$1) AS experiments,
        (SELECT count(*)::int FROM world_capability_uses WHERE world_id=$1) AS uses,
        (SELECT count(*)::int FROM world_capability_events WHERE world_id=$1) AS events,
        (SELECT COALESCE(max(id),0)::text FROM world_capability_events WHERE world_id=$1) AS capability_cursor,
        (SELECT count(*)::int FROM world_history WHERE world_id=$1) AS history,
        (SELECT count(*)::int FROM arc_currency_genesis_requirements WHERE world_id=$1) AS requirements,
        (SELECT status FROM arc_currency_genesis_requirements WHERE world_id=$1) AS currency_status,
        (SELECT current_proposal_id::text FROM arc_currency_genesis_requirements WHERE world_id=$1) AS current_proposal_id,
        (SELECT first_required_world_minute FROM arc_currency_genesis_requirements WHERE world_id=$1) AS first_required_world_minute,
        (SELECT count(*)::int FROM arc_token_issuance_intents WHERE world_id=$1) AS currency_intents,
        (SELECT count(*)::int FROM arc_agent_tokens WHERE world_id=$1) AS tokens
      FROM world_runtime_state runtime WHERE runtime.world_id=$1`, [worldId]);
    assert.equal(before.rowCount, 1);
    assert.equal(Number(before.rows[0].world_minutes), 316_531);
    assert.equal(Number(before.rows[0].members), 10);
    assert.equal(Number(before.rows[0].requirements), 1);
    assert.equal(before.rows[0].currency_status, 'UNRESOLVED');
    assert.equal(before.rows[0].current_proposal_id, null);
    assert.equal(Number(before.rows[0].first_required_world_minute), 316_531);
    assert.equal(Number(before.rows[0].currency_intents), 0);
    assert.equal(Number(before.rows[0].tokens), 0);

    const recovered = await captureV6LifecycleSnapshot(pool, { worldId, directory: observerDirectory,
      now: new Date('2026-10-08T05:00:00.000Z') });
    assert.deepEqual(recovered.cacheRecovery, { reason: 'snapshot_ahead_of_source_of_truth',
      rejectedReasons: ['world_minute_ahead_of_database','capability_event_cursor_ahead_of_database'] });
    assert.equal(recovered.latestWorldMinute, 316_531);
    assert.equal(recovered.cursor.capabilityEventId, String(before.rows[0].capability_cursor));
    const rebuiltFile = JSON.parse(await readFile(observerPath, 'utf8'));
    assert.equal(rebuiltFile.snapshots.length, 1, 'the whole ahead cache was rejected and rebuilt from PostgreSQL');
    assert.equal(rebuiltFile.latestWorldMinute, 316_531);
    assert.equal(rebuiltFile.lastObservationCursor.capabilityEventId, String(before.rows[0].capability_cursor));
    const afterRecovery = await pool.query(`SELECT runtime.world_minutes,
        (SELECT count(*)::int FROM world_capability_gaps WHERE world_id=$1) AS gaps,
        (SELECT count(*)::int FROM world_capability_observations WHERE world_id=$1) AS observations,
        (SELECT count(*)::int FROM world_capability_proposals WHERE world_id=$1) AS v6_proposals,
        (SELECT count(*)::int FROM world_capability_reviews WHERE world_id=$1) AS reviews,
        (SELECT count(*)::int FROM world_capability_experiments WHERE world_id=$1) AS experiments,
        (SELECT count(*)::int FROM world_capability_uses WHERE world_id=$1) AS uses,
        (SELECT count(*)::int FROM world_capability_events WHERE world_id=$1) AS events,
        (SELECT count(*)::int FROM world_history WHERE world_id=$1) AS history,
        (SELECT count(*)::int FROM arc_currency_genesis_requirements WHERE world_id=$1) AS requirements,
        (SELECT count(*)::int FROM arc_token_issuance_intents WHERE world_id=$1) AS currency_intents,
        (SELECT count(*)::int FROM arc_agent_tokens WHERE world_id=$1) AS tokens
      FROM world_runtime_state runtime WHERE runtime.world_id=$1`, [worldId]);
    for (const key of ['world_minutes','gaps','observations','v6_proposals','reviews','experiments','uses',
      'events','history','requirements','currency_intents','tokens']) {
      assert.equal(afterRecovery.rows[0][key], before.rows[0][key],
        `Observer recovery leaves PostgreSQL ${key} unchanged`);
    }

    let timerCallback = null;
    observer = startV6LifecycleObserver({ pool, worldId, directory: observerDirectory, isOwner: () => true,
      schedule: (callback) => { timerCallback = callback; return { unref() {} }; }, unschedule() {} });
    const observerDeadline = Date.now() + 10_000;
    while (!observer.getStatus().lastSampleAt && !observer.getStatus().lastError && Date.now() < observerDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(observer.getStatus().available, true);
    assert.equal(observer.getStatus().running, true);
    assert.equal(observer.getStatus().mode, 'read_only');
    assert.equal(observer.getStatus().sourceOfTruth, 'database');
    assert.equal(observer.getStatus().lastSampleWorldMinute, 316_531);
    assert.equal(observer.getStatus().lastError, null);
    assert.equal(observer.getStatus().lastCacheRecovery, null,
      'the healthy sample is now based on the rebuilt database cache');
    assert.equal(typeof timerCallback, 'function');

    engine = await startWorldEngine(pool, { worldId, schedule: false, currencyGenesisEnabled: true,
      emergencySink: { write() {} } });
    assert.equal(engine.running, true);
    assert.equal(engine.worldId, worldId);
    assert.equal(engine.worldLockOwned, true);
    const engineState = await pool.query(`SELECT runtime.world_minutes,
        (SELECT count(*)::int FROM arc_currency_genesis_requirements WHERE world_id=$1) AS requirements,
        (SELECT status FROM arc_currency_genesis_requirements WHERE world_id=$1) AS currency_status,
        (SELECT current_proposal_id::text FROM arc_currency_genesis_requirements WHERE world_id=$1) AS current_proposal_id,
        (SELECT count(*)::int FROM arc_token_issuance_intents WHERE world_id=$1) AS currency_intents,
        (SELECT count(*)::int FROM arc_token_issuance_issuer_candidates WHERE world_id=$1) AS issuer_candidates,
        (SELECT count(*)::int FROM arc_agent_tokens WHERE world_id=$1) AS tokens
      FROM world_runtime_state runtime WHERE runtime.world_id=$1`, [worldId]);
    assert.ok(Number(engineState.rows[0].world_minutes) > 316_531, 'the isolated World Engine tick advances the same world');
    assert.equal(Number(engineState.rows[0].requirements), 1);
    assert.equal(engineState.rows[0].currency_status, 'UNRESOLVED');
    assert.equal(engineState.rows[0].current_proposal_id, null);
    assert.equal(Number(engineState.rows[0].currency_intents), 0);
    assert.equal(Number(engineState.rows[0].issuer_candidates), 0);
    assert.equal(Number(engineState.rows[0].tokens), 0);
    assert.equal(arcNetworkConfig().writesEnabled, false, 'the Mainnet write gate stays closed');

    await observer.stop();
    observer = null;
    await engine.stop();
    engine = null;
    const locks = await pool.query(`WITH lock_key AS (SELECT hashtextextended('synterra-world-engine',0) AS value),
        database_oid AS (SELECT oid FROM pg_database WHERE datname=current_database())
      SELECT count(*)::int AS count FROM pg_locks held,lock_key,database_oid
      WHERE held.locktype='advisory' AND held.granted AND held.database=database_oid.oid AND held.objsubid=1
        AND held.classid::bigint=((lock_key.value >> 32) & 4294967295)
        AND held.objid::bigint=(lock_key.value & 4294967295)`);
    assert.equal(Number(locks.rows[0].count), 0, 'the isolated engine releases its world lock on stop');
    const stateMode = (await stat(resolvedState)).mode & 0o777;
    const observerMode = (await stat(observerDirectory)).mode & 0o777;
    const snapshotMode = (await stat(observerPath)).mode & 0o777;
    assert.equal(stateMode, 0o700);
    assert.equal(observerMode, 0o700);
    assert.equal(snapshotMode, 0o600);
  } finally {
    if (observer) await observer.stop().catch(() => {});
    if (engine) await engine.stop().catch(() => {});
    await pool.end();
  }
});

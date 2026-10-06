import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWorldLiveness, reportWorldEngineError, settleOptionalReasoning } from '../src/world-engine-diagnostics.js';

test('world engine errors fall back to stderr when logger handling throws and redact connection secrets', () => {
  const writes = [];
  const record = reportWorldEngineError({
    error: new Error('database request failed at postgresql://resident:secret@localhost/synterra'),
    stage: 'tick', worldId: 'world-1', worldMinute: 190_412, tickCount: 189_932,
    phase: 'ORGANIZATION_CAPABILITY_REVIEW', timestamp: new Date('2026-10-06T03:00:00.000Z'),
    onError() { throw new Error('logger closed'); },
    emergencySink: { write(line) { writes.push(line); } }
  });

  assert.equal(writes.length, 1);
  const emergency = JSON.parse(writes[0]);
  assert.equal(emergency.timestamp, '2026-10-06T03:00:00.000Z');
  assert.equal(emergency.worldId, 'world-1');
  assert.equal(emergency.worldMinute, 190_412);
  assert.equal(emergency.tickCount, 189_932);
  assert.equal(emergency.phase, 'ORGANIZATION_CAPABILITY_REVIEW');
  assert.equal(emergency.errorName, 'Error');
  assert.match(emergency.errorMessage, /redacted database URL/);
  assert.doesNotMatch(writes[0], /resident:secret|DATABASE_URL/);
  assert.equal(record.errorMessage, emergency.errorMessage);
});

test('optional TypeSafe reasoning times out to a fallback and converts errors to a fallback', async () => {
  const never = new Promise(() => {});
  const timed = await settleOptionalReasoning(never, { timeoutMs: 15, fallback: null });
  assert.equal(timed.value, null);
  assert.equal(timed.timedOut, true);

  const failed = await settleOptionalReasoning(Promise.reject(new Error('provider unavailable')),
    { timeoutMs: 100, fallback: null });
  assert.equal(failed.value, null);
  assert.equal(failed.timedOut, false);
  assert.match(failed.error.message, /provider unavailable/);
});

test('world liveness distinguishes a healthy HTTP service from a stale or unlocked world', () => {
  const checkedAt = new Date('2026-10-06T03:00:00.000Z');
  const runtime = { world_id: 'world-1', world_minutes: '190412', tick_count: '189932',
    last_tick_at: new Date('2026-10-06T02:59:50.000Z') };
  const engine = { running: true, worldLockOwned: true, schedulerRunning: true,
    lastTickPhase: 'TICK_COMPLETE', lastSuccessfulPhase: 'TICK_COMPLETE' };
  const healthy = buildWorldLiveness({ databaseHealthy: true, runtime, engine, checkedAt });
  assert.equal(healthy.serviceHealthy, true);
  assert.equal(healthy.worldTickHealthy, true);
  assert.equal(healthy.secondsSinceLastTick, 10);

  const stale = buildWorldLiveness({ databaseHealthy: true, runtime: {
    ...runtime, last_tick_at: new Date('2026-10-06T02:50:00.000Z') }, engine, checkedAt });
  assert.equal(stale.ok, true);
  assert.equal(stale.serviceHealthy, true);
  assert.equal(stale.worldTickHealthy, false);

  const unlocked = buildWorldLiveness({ databaseHealthy: true, runtime, engine: {
    ...engine, worldLockOwned: false }, checkedAt });
  assert.equal(unlocked.worldTickHealthy, false);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { classifyV6GapMaturity, persistV6LifecycleSnapshot, readV6LifecycleObserverState,
  safeV6LifecycleObserverError, startV6LifecycleObserver, unavailableV6LifecycleObserverStatus,
  V6_LIFECYCLE_OBSERVER_SNAPSHOT_LIMIT } from '../src/world-v6-lifecycle-observer.js';

test('V6 observer maturity uses the same repeated-observation and world-age gates as resident decisions', () => {
  assert.deepEqual(classifyV6GapMaturity({ observationCount: 1, firstObservedWorldMinute: 0, status: 'open' }, 2_000),
    { mature: false, ageWorldMinutes: 2_000, blockers: ['needs_repeated_observation'] });
  assert.deepEqual(classifyV6GapMaturity({ observationCount: 2, firstObservedWorldMinute: 1_000, status: 'open' }, 2_439),
    { mature: false, ageWorldMinutes: 1_439, blockers: ['minimum_world_age_not_reached'] });
  assert.deepEqual(classifyV6GapMaturity({ observationCount: 2, firstObservedWorldMinute: 1_000, status: 'open' }, 2_440),
    { mature: true, ageWorldMinutes: 1_440, blockers: [] });
  assert.equal(classifyV6GapMaturity({ observationCount: 2, firstObservedWorldMinute: 0, status: 'stale' }, 2_000).mature, false);
});

test('V6 observer snapshots are private, bounded, restart-readable, and unique per world minute', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'synterra-v6-observer-'));
  try {
    const summary = (minute, useCount = minute) => ({ worldId: 'observer-test-world', worldMinute: minute,
      counts: { gaps: 2, matureGaps: 1, proposals: 3, candidateCycles: 4, validNoAction: 1,
        experiments: 2, adoptedCapabilities: 1, capabilityUses: useCount },
      genealogy: { maximumDepth: 2, secondOrderCapabilities: 1 } });
    let last;
    for (let minute = 1; minute <= V6_LIFECYCLE_OBSERVER_SNAPSHOT_LIMIT + 5; minute += 1) {
      last = await persistV6LifecycleSnapshot(directory, { worldId: 'observer-test-world', worldMinute: minute,
        summary: summary(minute), cursor: { capabilityEventId: String(minute), v7EventCreatedAt: null },
        observedAt: new Date(minute * 1_000).toISOString() });
    }
    assert.equal(last.snapshotCount, V6_LIFECYCLE_OBSERVER_SNAPSHOT_LIMIT);
    const statePath = path.join(directory, 'v6-lifecycle-observer.json');
    const persisted = JSON.parse(await readFile(statePath, 'utf8'));
    assert.equal(persisted.snapshots[0].worldMinute, 6);
    assert.equal((await stat(statePath)).mode & 0o777, 0o600);
    await persistV6LifecycleSnapshot(directory, { worldId: 'observer-test-world', worldMinute: 101,
      summary: summary(101), cursor: { capabilityEventId: '101', v7EventCreatedAt: null },
      observedAt: new Date(999_000).toISOString() });
    const sameCursorState = JSON.parse(await readFile(statePath, 'utf8'));
    assert.equal(sameCursorState.snapshots.length, V6_LIFECYCLE_OBSERVER_SNAPSHOT_LIMIT,
      'the same minute and event cursor update poll time without adding a duplicate sample');
    await persistV6LifecycleSnapshot(directory, { worldId: 'observer-test-world', worldMinute: 101,
      summary: summary(101, 500), cursor: { capabilityEventId: '102', v7EventCreatedAt: null },
      observedAt: new Date(1_000_000).toISOString() });
    const advancedCursorState = JSON.parse(await readFile(statePath, 'utf8'));
    assert.equal(advancedCursorState.snapshots.length, V6_LIFECYCLE_OBSERVER_SNAPSHOT_LIMIT,
      'a cursor advance within the same minute updates the existing sample instead of appending');
    assert.equal(advancedCursorState.snapshots.at(-1).cursor.capabilityEventId, '102');
    assert.equal(advancedCursorState.snapshots.at(-1).counts.capabilityUses, 500);
    assert.equal(advancedCursorState.lastObservationCursor.capabilityEventId, '102');
    assert.equal(advancedCursorState.lastPollAt, new Date(1_000_000).toISOString());
    const beforeWorldChange = await readFile(statePath, 'utf8');
    await assert.rejects(persistV6LifecycleSnapshot(directory, { worldId: 'replacement-world', worldMinute: 1,
      summary: summary(1), cursor: { capabilityEventId: '1', v7EventCreatedAt: null },
      observedAt: new Date(1_000_000).toISOString() }), { message: 'V6_OBSERVER_WORLD_ID_CHANGED' });
    assert.equal(await readFile(statePath, 'utf8'), beforeWorldChange,
      'a changed world identity fails closed and preserves the prior bounded observer history');
    const restored = await readV6LifecycleObserverState(directory, 'observer-test-world');
    assert.equal(restored.latestWorldMinute, V6_LIFECYCLE_OBSERVER_SNAPSHOT_LIMIT + 5);
    assert.equal(restored.snapshotCount, V6_LIFECYCLE_OBSERVER_SNAPSHOT_LIMIT);
    assert.equal(restored.lastObservationCursor.capabilityEventId, '102');
    assert.equal(await readV6LifecycleObserverState(directory, 'another-world'), null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('V6 observer owns one read-only scheduler and resumes its sample status after restart', async () => {
  const directory = path.join(os.tmpdir(), 'synterra-v6-observer-runtime-test');
  const timers = new Set();
  const timerEvents = [];
  const samples = [
    { lastPollAt: '2026-10-07T00:15:00.000Z', latestSnapshotAt: '2026-10-07T00:15:00.000Z',
      latestWorldMinute: 501, latestFindingCount: 4, snapshotCount: 12 },
    { lastPollAt: '2026-10-07T00:30:00.000Z', latestSnapshotAt: '2026-10-07T00:30:00.000Z',
      latestWorldMinute: 516, latestFindingCount: 3, snapshotCount: 13 }
  ];
  const prior = { lastPollAt: '2026-10-07T00:00:00.000Z', latestSnapshotAt: '2026-10-07T00:00:00.000Z',
    latestWorldMinute: 486, latestFindingCount: 5, snapshotCount: 11 };
  const schedule = (callback, delay) => {
    const timer = { callback, delay, unref() {} };
    timers.add(timer);
    timerEvents.push({ type: 'scheduled', delay });
    return timer;
  };
  const unschedule = (timer) => { timers.delete(timer); timerEvents.push({ type: 'cleared' }); };
  const options = { pool: {}, worldId: 'observer-test-world', directory,
    intervalMs: 15 * 60_000, schedule, unschedule,
    readState: async () => prior,
    captureSnapshot: async () => samples.shift() };
  const controllers = [];
  try {
    const first = startV6LifecycleObserver(options);
    controllers.push(first);
    const duplicate = startV6LifecycleObserver(options);
    assert.strictEqual(duplicate, first, 'a second registration reuses the active runtime controller');
    assert.equal(timers.size, 1, 'only one interval is active');
    assert.equal(timerEvents.filter((event) => event.type === 'scheduled').length, 1);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(first.getStatus(), {
      available: true, running: true, worldId: 'observer-test-world', mode: 'read_only', sourceOfTruth: 'database', samplingIntervalMinutes: 15,
      lastSampleAt: '2026-10-07T00:15:00.000Z', lastSampleWorldMinute: 501, lastFindingCount: 4,
      lastError: null, reason: null
    });
    assert.equal(Object.hasOwn(first.getStatus(), 'automationExists'), false,
      'observer availability does not depend on a Codex automation');
    await first.stop();
    assert.equal(first.getStatus().available, false);
    assert.equal(first.getStatus().running, false);
    assert.equal(timers.size, 0);

    let finishSecondCapture;
    const secondSample = new Promise((resolve) => { finishSecondCapture = resolve; });
    const second = startV6LifecycleObserver({ ...options, captureSnapshot: () => secondSample });
    controllers.push(second);
    assert.equal(timers.size, 1, 'restart registers one replacement interval');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(second.getStatus().lastSampleWorldMinute, 486,
      'the last successful sample is restored before the first post-restart sample finishes');
    finishSecondCapture(samples.shift());
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(second.getStatus().lastSampleAt, '2026-10-07T00:30:00.000Z');
    assert.equal(second.getStatus().lastFindingCount, 3);
    await second.stop();
    assert.equal(timers.size, 0);
  } finally {
    for (const controller of controllers) await controller.stop();
  }
});

test('V6 observer reports a real unavailable reason and retains the last successful sample on failure', async () => {
  const safeError = safeV6LifecycleObserverError(Object.assign(
    new Error('connection failed: postgres://resident:secret@localhost:5432/synterra?token=private'), { code: 'ECONNREFUSED' }));
  assert.match(safeError, /\[redacted database URL\]/);
  assert.doesNotMatch(safeError, /resident|secret|private/);

  const unavailable = unavailableV6LifecycleObserverStatus({
    snapshot: { lastPollAt: '2026-10-07T00:00:00.000Z', latestWorldMinute: 486, latestFindingCount: 5 },
    reason: 'world_lock_not_owned'
  });
  assert.equal(unavailable.available, false);
  assert.equal(unavailable.running, false);
  assert.equal(unavailable.worldId, null);
  assert.equal(unavailable.reason, 'world_lock_not_owned');
  assert.equal(unavailable.lastSampleWorldMinute, 486);

  const unregistered = startV6LifecycleObserver({ pool: {}, worldId: 'observer-scheduler-failure-world',
    directory: path.join(os.tmpdir(), 'observer-scheduler-failure-world'),
    schedule: () => { throw Object.assign(new Error('timer registration failed'), { code: 'TIMER_FAILED' }); },
    onError() {}, captureSnapshot: async () => { throw new Error('must not sample without a scheduler'); } });
  assert.equal(unregistered.getStatus().available, false);
  assert.equal(unregistered.getStatus().running, false);
  assert.equal(unregistered.getStatus().reason, 'scheduler_registration_failed');
  assert.match(unregistered.getStatus().lastError, /^TIMER_FAILED: timer registration failed$/);
  await unregistered.stop();

  let logged = 0;
  const observer = startV6LifecycleObserver({ pool: {}, worldId: 'observer-failure-world',
    directory: path.join(os.tmpdir(), 'observer-failure-world'), intervalMs: 60_000,
    schedule: (callback) => ({ callback, unref() {} }), unschedule() {},
    readState: async () => ({ lastPollAt: '2026-10-07T00:00:00.000Z', latestWorldMinute: 486,
      latestFindingCount: 5 }),
    captureSnapshot: async () => { throw Object.assign(new Error('read-only sample unavailable'), { code: 'SAMPLE_FAILED' }); },
    onError: () => { logged += 1; }
  });
  try {
    await new Promise((resolve) => setImmediate(resolve));
    const status = observer.getStatus();
    assert.equal(status.available, true, 'a failed poll does not make the registered observer disappear');
    assert.equal(status.running, true);
    assert.equal(status.lastSampleWorldMinute, 486);
    assert.equal(status.lastFindingCount, 5);
    assert.match(status.lastError, /^SAMPLE_FAILED: read-only sample unavailable$/);
    assert.equal(logged, 1);
  } finally {
    await observer.stop();
  }
});

test('V6 observer stops sampling and reports unavailability when world-lock ownership is lost', async () => {
  let ownsWorldLock = true;
  let captureCount = 0;
  const timers = new Set();
  const observer = startV6LifecycleObserver({ pool: {}, worldId: 'observer-lock-loss-world',
    directory: path.join(os.tmpdir(), 'observer-lock-loss-world'), isOwner: () => ownsWorldLock,
    schedule: (callback) => {
      const timer = { callback, unref() {} };
      timers.add(timer);
      return timer;
    },
    unschedule: (timer) => timers.delete(timer),
    readState: async () => null,
    captureSnapshot: async () => {
      captureCount += 1;
      return { lastPollAt: '2026-10-07T01:00:00.000Z', latestWorldMinute: 600, latestFindingCount: 0 };
    }
  });
  try {
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(captureCount, 1);
    const timer = [...timers][0];
    ownsWorldLock = false;
    const status = observer.getStatus();
    assert.equal(status.available, false);
    assert.equal(status.running, false);
    assert.equal(status.reason, 'world_lock_not_owned');
    assert.equal(timers.size, 0, 'loss of world-lock ownership clears the observer interval');
    timer.callback();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(captureCount, 1, 'a stale scheduler callback cannot sample after ownership is lost');
  } finally {
    await observer.stop();
  }
});

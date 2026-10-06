import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { classifyV6GapMaturity, persistV6LifecycleSnapshot, readV6LifecycleObserverState,
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

test('V6 observer snapshots are private, bounded, restart-readable, and deduplicate an unchanged cursor', async () => {
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
    assert.equal(JSON.parse(await readFile(statePath, 'utf8')).snapshots.length, V6_LIFECYCLE_OBSERVER_SNAPSHOT_LIMIT,
      'the same minute and event cursor update the poll time without adding a duplicate historical sample');
    const beforeWorldChange = await readFile(statePath, 'utf8');
    await assert.rejects(persistV6LifecycleSnapshot(directory, { worldId: 'replacement-world', worldMinute: 1,
      summary: summary(1), cursor: { capabilityEventId: '1', v7EventCreatedAt: null },
      observedAt: new Date(1_000_000).toISOString() }), { message: 'V6_OBSERVER_WORLD_ID_CHANGED' });
    assert.equal(await readFile(statePath, 'utf8'), beforeWorldChange,
      'a changed world identity fails closed and preserves the prior bounded observer history');
    const restored = await readV6LifecycleObserverState(directory, 'observer-test-world');
    assert.equal(restored.latestWorldMinute, V6_LIFECYCLE_OBSERVER_SNAPSHOT_LIMIT + 5);
    assert.equal(restored.snapshotCount, V6_LIFECYCLE_OBSERVER_SNAPSHOT_LIMIT);
    assert.equal(restored.lastObservationCursor.capabilityEventId, String(V6_LIFECYCLE_OBSERVER_SNAPSHOT_LIMIT + 5));
    assert.equal(await readV6LifecycleObserverState(directory, 'another-world'), null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

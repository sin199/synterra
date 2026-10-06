import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { formatV6LifecycleObserverStatus } from '../site/v6-observer-status.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test('World Evolution UI presents live observer health from the dedicated API status', async () => {
  const [app, html, server] = await Promise.all([
    readFile(path.join(root, 'site/app.js'), 'utf8'),
    readFile(path.join(root, 'site/index.html'), 'utf8'),
    readFile(path.join(root, 'src/server.js'), 'utf8')
  ]);
  assert.match(app, /evolution\.v6LifecycleObserver/);
  assert.match(html, /id="world-v6-lifecycle-observer-status"/);
  assert.match(app, /formatV6LifecycleObserverStatus\(observerStatus\)/);
  assert.match(server, /v6LifecycleObserver:\s*v6LifecycleObserverStatus/);
  assert.match(server, /v6LifecycleObserver:\s*observerStatus/);
  assert.match(server, /pathOnly === '\/v6-observer-status\.js'/,
    'the imported browser module is available through the unauthenticated local static route');
  assert.match(server, /app\.get\('\/v6-observer-status\.js'/);
  assert.match(server, /readFile\(path\.join\(SITE_ROOT, 'v6-observer-status\.js'\)\)/);
  assert.doesNotMatch(server, /v6Lifecycle\.observerSnapshot\s*=/,
    'observer runtime status stays separate from V6 lifecycle facts');
});

test('observer status formatter distinguishes running read-only from real unavailability', () => {
  assert.equal(formatV6LifecycleObserverStatus(null), 'Observer status not reported by API',
    'a missing status field is not presented as a missing observer');
  const running = formatV6LifecycleObserverStatus({ available: true, running: true, mode: 'read_only',
    sourceOfTruth: 'database', lastSampleAt: '2026-10-07T00:15:00.000Z', lastSampleWorldMinute: 501,
    lastFindingCount: 4 }, 'en-US');
  assert.match(running, /Running · Read-only/);
  assert.match(running, /Database source of truth/);
  assert.match(running, /World minute: 501/);
  assert.match(running, /Integrity findings: 4/);

  const unavailable = formatV6LifecycleObserverStatus({ available: false, running: false,
    reason: 'world_lock_not_owned', lastSampleAt: '2026-10-07T00:00:00.000Z', lastSampleWorldMinute: 486 }, 'en-US');
  assert.match(unavailable, /Observer unavailable · world_lock_not_owned/);
  assert.match(unavailable, /Last sample:/);
  assert.match(unavailable, /World minute: 486/);
});

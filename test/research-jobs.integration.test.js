import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { applyWorldSchemaAndMigrations } from '../src/database-migrations.js';
import { prepareStartupSchema } from '../src/startup-schema.js';
import { startWorldEngine } from '../src/world-engine.js';
import { seedWorldCapabilityRegistry } from '../src/world-capabilities.js';
import { importResearchArtifact } from '../src/research/artifacts.js';
import { listResearchInputsByWorld } from '../src/research/research-jobs.js';
import { writeFakeReaMcpServer } from './helpers/fake-rea-mcp.js';
import { cancelResearchJob, claimNextResearchJob, completeResearchJob, enqueueResearchCapabilityUse,
  markResearchExternalCallStarted, recoverExpiredResearchJobs, RESEARCH_CAPABILITY_KEY } from '../src/research/research-jobs.js';
import { startReaResearchWorker } from '../src/research/research-worker.js';
import { arcNetworkConfig } from '../src/arc/config.js';

const databaseUrl = process.env.SYNTERRA_RESEARCH_TEST_DATABASE_URL;
const nodeBinary = process.env.SYNTERRA_RESEARCH_TEST_NODE_BINARY;
const nodeVersion = process.env.SYNTERRA_RESEARCH_TEST_NODE_VERSION;
const enabled = process.env.SYNTERRA_RESEARCH_TEST_ISOLATED === '1' && Boolean(databaseUrl && nodeBinary && nodeVersion);
const rootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function inTransaction(pool, operation) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

function researchIntent(artifactId, label = 'success') {
  return { artifactId, targetType: 'javascript',
    researchQuestion: `What evidence does the ${label} artifact provide?`,
    objective: `Investigate the isolated ${label} artifact before using it.`,
    desiredInvestigation: `Use REA static JavaScript analysis to inspect the ${label} artifact.`,
    expectedResult: `Return bounded evidence and open questions about the ${label} artifact.` };
}

async function queue(pool, worldId, agentId, capabilityId, artifactId, actionId, label = 'success') {
  return inTransaction(pool, (client) => enqueueResearchCapabilityUse(client, { worldId, agentId, capabilityId,
    actionId, decisionSource: 'agent_api', worldMinute: 480, researchIntent: researchIntent(artifactId, label) }));
}

async function waitForJob(pool, jobId, terminal, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let row;
  while (Date.now() < deadline) {
    row = (await pool.query('SELECT status,failure_code FROM world_research_jobs WHERE id=$1', [jobId])).rows[0];
    if (row && terminal.includes(row.status)) return row;
    await sleep(50);
  }
  throw new Error(`Research job did not reach ${terminal.join('/')} in time: ${JSON.stringify(row)}`);
}

async function importArtifact(pool, root, { worldId, agentId, key, contents }) {
  return importResearchArtifact(pool, { worldId, grantAgentIds: [agentId], artifactKey: key,
    displayName: `${key}.js`, targetType: 'javascript', mediaType: 'application/javascript',
    bytes: Buffer.from(contents), artifactDirectory: path.join(root, 'artifacts') });
}

test('REA research jobs are durable, isolated from World Engine ticks, attributed, and recover deterministically', {
  skip: !enabled, timeout: 120_000
}, async (t) => {
  const parsed = new URL(databaseUrl);
  assert.ok(['127.0.0.1','localhost','::1'].includes(parsed.hostname), 'research integration requires loopback PostgreSQL');
  assert.ok(parsed.port && parsed.port !== '5432', 'research integration must not use the default/formal PostgreSQL port');
  assert.ok(decodeURIComponent(parsed.pathname.slice(1)).endsWith('_test'), 'research integration requires a *_test database');
  const pool = new Pool({ connectionString: databaseUrl, max: 8, connectionTimeoutMillis: 3_000 });
  const worldId = randomUUID();
  const foreignWorldId = randomUUID();
  const agentId = randomUUID();
  const root = await mkdtemp(path.join(os.tmpdir(), 'synterra-rea-research-test-'));
  let engine;
  const workers = [];
  let recoveryRequest;
  try {
    await applyWorldSchemaAndMigrations(pool, { rootDirectory });
    assert.equal((await prepareStartupSchema(pool, { rootDirectory, mode: 'validate' })).validated, true);
    await pool.query('INSERT INTO agents(id,name,public_key) VALUES($1,$2,$3)',
      [agentId, `REA Test ${agentId.slice(0, 8)}`, `rea-test-key-${agentId}`]);
    await pool.query(`INSERT INTO worlds(id,owner_agent_id,name,chain_id,open)
      VALUES($1,$2,$3,5042,true)`, [worldId, agentId, `REA isolated ${worldId.slice(0, 8)}`]);
    await pool.query(`INSERT INTO world_members(world_id,agent_id,role,location,energy,food,social)
      VALUES($1,$2,'owner','Garden',100,100,100)`, [worldId, agentId]);
    await pool.query(`INSERT INTO world_runtime_state(world_id,tick_count,world_minutes,last_tick_at,typesafe_next_at)
      VALUES($1,0,480,now(),now()+interval '1 hour')`, [worldId]);

    // Start the real World Engine before granting any research artifact, so it has no REA candidate to select.
    engine = await startWorldEngine(pool, { worldId, tickMs: 250, emergencySink: { write() {} } });
    assert.equal(engine.running, true);
    assert.equal(engine.worldLockOwned, true);
    await pool.query('DELETE FROM world_agent_goals WHERE world_id=$1', [worldId]);
    const emptyInputs = await listResearchInputsByWorld(pool, { worldId });
    assert.equal(emptyInputs.contextsByAgent.size, 0, 'resident-context UNION query executes on isolated PostgreSQL');
    const capabilityRows = await pool.query(`SELECT id,specification FROM world_capabilities
      WHERE world_id=$1 AND capability_key=$2`, [worldId, RESEARCH_CAPABILITY_KEY]);
    assert.equal(capabilityRows.rowCount, 1, 'the system registry exposes the REA native capability');
    const capabilityId = capabilityRows.rows[0].id;
    assert.equal(capabilityRows.rows[0].specification.kind, 'native_system');
    await pool.query(`INSERT INTO worlds(id,owner_agent_id,name,chain_id,open)
      VALUES($1,$2,$3,5042,true)`, [foreignWorldId, agentId, `REA foreign ${foreignWorldId.slice(0, 8)}`]);
    await pool.query(`INSERT INTO world_members(world_id,agent_id,role,location,energy,food,social)
      VALUES($1,$2,'owner','Garden',100,100,100)`, [foreignWorldId, agentId]);
    const foreignCapabilities = await seedWorldCapabilityRegistry(pool, foreignWorldId);
    const foreignArtifact = await importArtifact(pool, root, { worldId: foreignWorldId, agentId,
      key: 'source-foreign-v1', contents: 'export const foreign = true;\n' });
    const foreignRequest = await queue(pool, foreignWorldId, agentId,
      foreignCapabilities.get(RESEARCH_CAPABILITY_KEY), foreignArtifact.id, 'rea-foreign-action-0001', 'foreign');

    const successArtifact = await importArtifact(pool, root, { worldId, agentId, key: 'source-success-v1',
      contents: 'FAKE_REA_DELAY; export const answer = 42;\n' });
    const errorArtifact = await importArtifact(pool, root, { worldId, agentId, key: 'source-error-v1',
      contents: 'FAKE_REA_PROVIDER_ERROR; export const answer = 0;\n' });
    const timeoutArtifact = await importArtifact(pool, root, { worldId, agentId, key: 'source-timeout-v1',
      contents: 'FAKE_REA_TIMEOUT; export const answer = 1;\n' });

    await t.test('a world worker cannot claim or recover another world research job', async () => {
      const claimed = await inTransaction(pool, (client) => claimNextResearchJob(client,
        { worldId: foreignWorldId, workerId: 'rea-foreign-worker' }));
      assert.equal(claimed.id, foreignRequest.jobId);
      assert.equal(await inTransaction(pool, (client) => markResearchExternalCallStarted(client,
        { jobId: foreignRequest.jobId, workerId: 'rea-foreign-worker' })), true);
      const wrongWorldClaim = await inTransaction(pool, (client) => claimNextResearchJob(client,
        { worldId, workerId: 'rea-main-empty-worker' }));
      assert.equal(wrongWorldClaim, null);
      const recovered = await inTransaction(pool, (client) => recoverExpiredResearchJobs(client,
        { worldId, now: new Date(Date.now() + 120_000) }));
      assert.deepEqual(recovered, []);
      assert.equal((await pool.query('SELECT status FROM world_research_jobs WHERE id=$1',
        [foreignRequest.jobId])).rows[0].status, 'running');
    });

    await t.test('same action creates one use and one job; conflicting intent is rejected', async () => {
      const first = await queue(pool, worldId, agentId, capabilityId, successArtifact.id, 'rea-idempotency-action-0001');
      const repeated = await queue(pool, worldId, agentId, capabilityId, successArtifact.id, 'rea-idempotency-action-0001');
      assert.equal(first.idempotent, false);
      assert.equal(repeated.idempotent, true);
      assert.equal(repeated.jobId, first.jobId);
      await assert.rejects(inTransaction(pool, (client) => enqueueResearchCapabilityUse(client, { worldId, agentId,
        capabilityId, actionId: 'rea-idempotency-action-0001', worldMinute: 480,
        researchIntent: researchIntent(successArtifact.id, 'changed') })), (error) => error.statusCode === 409);
      assert.equal(Number((await pool.query(`SELECT count(*)::int AS count FROM world_capability_uses
        WHERE world_id=$1 AND action_id='rea-idempotency-action-0001'`, [worldId])).rows[0].count), 1);
      assert.equal(Number((await pool.query(`SELECT count(*)::int AS count FROM world_research_jobs
        WHERE world_id=$1 AND action_id='rea-idempotency-action-0001'`, [worldId])).rows[0].count), 1);
      const cancelled = await inTransaction(pool, (client) => cancelResearchJob(client, { worldId, agentId,
        jobId: first.jobId, actionId: 'rea-idempotency-cancel-0001', worldMinute: 480 }));
      assert.equal(cancelled.status, 'cancelled');
    });

    await t.test('concurrent duplicate action is idempotent; Agent can cancel only queued work', async () => {
      const clientA = await pool.connect();
      const clientB = await pool.connect();
      let first;
      let secondPromise;
      try {
        await clientA.query('BEGIN');
        first = await enqueueResearchCapabilityUse(clientA, { worldId, agentId, capabilityId,
          actionId: 'rea-concurrent-action-0001', worldMinute: 480,
          researchIntent: researchIntent(successArtifact.id, 'concurrent') });
        await clientB.query('BEGIN');
        secondPromise = enqueueResearchCapabilityUse(clientB, { worldId, agentId, capabilityId,
          actionId: 'rea-concurrent-action-0001', worldMinute: 480,
          researchIntent: researchIntent(successArtifact.id, 'concurrent') });
        await sleep(75);
        await clientA.query('COMMIT');
        const second = await secondPromise;
        await clientB.query('COMMIT');
        assert.equal(second.idempotent, true);
        assert.equal(second.jobId, first.jobId);
      } finally {
        await clientA.query('ROLLBACK').catch(() => {});
        await clientB.query('ROLLBACK').catch(() => {});
        clientA.release();
        clientB.release();
      }
      const duplicateCancelled = await inTransaction(pool, (client) => cancelResearchJob(client, { worldId, agentId,
        jobId: first.jobId, actionId: 'rea-concurrent-cancel-001', worldMinute: 481 }));
      assert.equal(duplicateCancelled.status, 'cancelled');
      const cancelled = await queue(pool, worldId, agentId, capabilityId, successArtifact.id,
        'rea-cancel-action-0001', 'cancel');
      const result = await inTransaction(pool, (client) => cancelResearchJob(client, { worldId, agentId,
        jobId: cancelled.jobId, actionId: 'rea-cancel-command-001', worldMinute: 481 }));
      assert.equal(result.status, 'cancelled');
      const cancelledJob = (await pool.query(`SELECT status,started_world_minute,completed_world_minute
        FROM world_research_jobs WHERE id=$1`, [cancelled.jobId])).rows[0];
      assert.equal(cancelledJob.status, 'cancelled');
      assert.equal(cancelledJob.started_world_minute, null);
      assert.equal(Number(cancelledJob.completed_world_minute), 481);
      assert.equal((await pool.query('SELECT status FROM world_capability_uses WHERE id=$1', [cancelled.useId])).rows[0].status,
        'abandoned');
      const retried = await inTransaction(pool, (client) => cancelResearchJob(client, { worldId, agentId,
        jobId: cancelled.jobId, actionId: 'rea-cancel-command-002', worldMinute: 481 }));
      assert.equal(retried.idempotent, true);
      recoveryRequest = await queue(pool, worldId, agentId, capabilityId, successArtifact.id,
        'rea-recovery-action-0001', 'recovery');
      const claimed = await inTransaction(pool, (client) => claimNextResearchJob(client,
        { worldId, workerId: 'rea-cancel-running-check' }));
      assert.equal(claimed.id, recoveryRequest.jobId);
      await assert.rejects(inTransaction(pool, (client) => cancelResearchJob(client, { worldId, agentId,
        jobId: recoveryRequest.jobId, actionId: 'rea-cancel-running-001', worldMinute: 481 })),
      (error) => error.statusCode === 409 && /REA_RESEARCH_JOB_NOT_QUEUED/.test(error.message));
    });

    await t.test('worker retries only work never sent externally and settles unknown work without replay', async () => {
      assert.ok(recoveryRequest);
      const requeued = await inTransaction(pool, (client) => recoverExpiredResearchJobs(client,
        { worldId, now: new Date(Date.now() + 120_000) }));
      assert.equal(requeued.find((item) => item.id === recoveryRequest.jobId).status, 'queued');
      const claimed = await inTransaction(pool, (client) => claimNextResearchJob(client, { worldId, workerId: 'rea-recovery-test-2' }));
      assert.equal(claimed.id, recoveryRequest.jobId);
      assert.equal(await inTransaction(pool, (client) => markResearchExternalCallStarted(client,
        { jobId: recoveryRequest.jobId, workerId: 'rea-recovery-test-2' })), true);
      const settled = await inTransaction(pool, (client) => recoverExpiredResearchJobs(client,
        { worldId, now: new Date(Date.now() + 120_000) }));
      assert.deepEqual(settled.find((item) => item.id === recoveryRequest.jobId),
        { id: recoveryRequest.jobId, status: 'failed', replayed: false });
      const row = (await pool.query(`SELECT status,failure_code,attempt_count,started_world_minute,completed_world_minute
        FROM world_research_jobs WHERE id=$1`,
        [recoveryRequest.jobId])).rows[0];
      assert.equal(row.status, 'failed');
      assert.equal(row.failure_code, 'REA_RESULT_UNKNOWN_AFTER_RESTART');
      assert.equal(Number(row.attempt_count), 2);
      assert.ok(Number(row.started_world_minute) >= 480);
      assert.ok(Number(row.completed_world_minute) >= Number(row.started_world_minute));
    });

    const successRequest = await queue(pool, worldId, agentId, capabilityId, successArtifact.id,
      'rea-success-action-0001', 'success');
    const errorRequest = await queue(pool, worldId, agentId, capabilityId, errorArtifact.id,
      'rea-error-action-0001', 'provider error');
    const timeoutRequest = await queue(pool, worldId, agentId, capabilityId, timeoutArtifact.id,
      'rea-timeout-action-0001', 'provider timeout');
    const fakeServer = await writeFakeReaMcpServer(root, { delayMs: 4_000, extraTool: true });
    const workerErrors = [];
    const startWorker = (requestTimeoutMs = '5000', jobTimeoutMs = '10000') => {
      const worker = startReaResearchWorker({ pool, worldId, stateDirectory: root,
        artifactDirectory: path.join(root, 'artifacts'), evidenceDirectory: path.join(root, 'evidence'),
        environment: { REA_NODE_BINARY: nodeBinary, REA_SERVER_ENTRY: fakeServer,
          REA_REQUEST_TIMEOUT_MS: requestTimeoutMs, REA_JOB_TIMEOUT_MS: jobTimeoutMs,
          PATH: process.env.PATH, HOME: root },
        isOwner: () => engine.running && engine.worldLockOwned && engine.worldId === worldId,
        pollIntervalMs: 500, onError: (record) => workerErrors.push(record) });
      workers.push(worker);
      worker.start();
      return worker;
    };

    await t.test('successful asynchronous REA completion records bounded evidence while the World Engine keeps ticking', async () => {
      const worker = startWorker('5000','10000');
      const deadline = Date.now() + 5_000;
      let active;
      while (Date.now() < deadline) {
        active = (await pool.query(`SELECT status,external_call_started_at FROM world_research_jobs WHERE id=$1`,
          [successRequest.jobId])).rows[0];
        if (active?.status === 'running' && active.external_call_started_at) break;
        await sleep(50);
      }
      assert.equal(active?.status, 'running');
      const before = Number((await pool.query('SELECT tick_count FROM world_runtime_state WHERE world_id=$1', [worldId])).rows[0].tick_count);
      await sleep(650);
      const after = Number((await pool.query('SELECT tick_count FROM world_runtime_state WHERE world_id=$1', [worldId])).rows[0].tick_count);
      assert.ok(after > before, JSON.stringify({ before, after, liveness: engine.getLiveness() }));
      const terminal = await waitForJob(pool, successRequest.jobId, ['completed','failed','timed_out']);
      assert.equal(terminal.status, 'completed', JSON.stringify(terminal));
      await worker.stop();
      const job = (await pool.query(`SELECT status,created_world_minute,started_world_minute,completed_world_minute,
          capability_use_id AS "capabilityUseId",evidence_reference,evidence_sha256,evidence_bytes,
          normalized_findings,selected_providers,tool_sequence,infrastructure_usage_event_id
        FROM world_research_jobs WHERE id=$1`, [successRequest.jobId])).rows[0];
      assert.ok(Number(job.started_world_minute) >= Number(job.created_world_minute));
      assert.ok(Number(job.completed_world_minute) >= Number(job.started_world_minute));
      assert.match(job.evidence_reference, /^rea-evidence:/);
      assert.match(job.evidence_sha256, /^[a-f0-9]{64}$/);
      assert.ok(Number(job.evidence_bytes) > 0);
      assert.match(job.normalized_findings.summary, /Fixture analysis complete/);
      assert.ok(job.selected_providers.includes('rea-javascript-application'));
      assert.ok(job.tool_sequence.includes('analyze_javascript_application'));
      assert.ok(job.infrastructure_usage_event_id);
      const use = (await pool.query('SELECT id,status,success,costs,result FROM world_capability_uses WHERE world_id=$1 AND action_id=$2',
        [worldId, 'rea-success-action-0001'])).rows[0];
      const usageMetadata = (await pool.query('SELECT metadata FROM world_infrastructure_usage_events WHERE id=$1',
        [job.infrastructure_usage_event_id])).rows[0].metadata;
      assert.equal(String(use.id), String(job.capabilityUseId), JSON.stringify({ use, job }));
      assert.equal(String(usageMetadata.capabilityUseId), String(job.capabilityUseId), JSON.stringify({ usageMetadata, job }));
      assert.equal(use.status, 'completed', JSON.stringify({ use, job, usageMetadata }));
      assert.equal(use.success, true);
      assert.deepEqual(use.costs, {}, 'REA has no legacy simulated_usdc price');
      assert.equal(use.result.status, 'completed');
      const memory = (await pool.query(`SELECT summary,metadata FROM agent_memories
        WHERE world_id=$1 AND agent_id=$2 AND consolidation_key=$3`, [worldId,agentId,'rea:'+successRequest.jobId])).rows[0];
      assert.match(memory.summary, /evidence/);
      assert.ok(memory.summary.length <= 240);
      assert.equal(memory.metadata.evidenceSha256, job.evidence_sha256);
      const usage = (await pool.query(`SELECT provider,unit,cost_status,metadata FROM world_infrastructure_usage_events
        WHERE id=$1`, [job.infrastructure_usage_event_id])).rows[0];
      assert.equal(usage.provider, 'rea_mcp');
      assert.equal(usage.unit, 'tool_call');
      assert.equal(usage.cost_status, 'unpriced');
      assert.ok(Number(usage.metadata.durationMs) > 0);
      assert.ok(Number(usage.metadata.evidenceBytes) > 0);
    });

    await t.test('provider error and timeout fail only their own capability uses and never become Agent no_action', async () => {
      const errorWorker = startWorker('5000','10000');
      const error = await waitForJob(pool, errorRequest.jobId, ['failed']);
      assert.equal(error.failure_code, 'REA_PROVIDER_ERROR');
      await errorWorker.stop();
      const failedJob = (await pool.query(`SELECT started_world_minute,completed_world_minute
        FROM world_research_jobs WHERE id=$1`, [errorRequest.jobId])).rows[0];
      assert.ok(Number(failedJob.started_world_minute) >= 480);
      assert.ok(Number(failedJob.completed_world_minute) >= Number(failedJob.started_world_minute));
      const failedUse = (await pool.query('SELECT status,success,result,costs FROM world_capability_uses WHERE id=$1',
        [errorRequest.useId])).rows[0];
      assert.equal(failedUse.status, 'failed');
      assert.equal(failedUse.success, false);
      assert.equal(failedUse.result.reasonCode, 'REA_PROVIDER_ERROR');
      assert.deepEqual(failedUse.costs, {});
      assert.equal((await pool.query(`SELECT count(*)::int AS count FROM world_events
        WHERE world_id=$1 AND event_type='currency_genesis.review_outcome'`, [worldId])).rows[0].count, 0);

      const timeoutWorker = startWorker('1000','5000');
      const timedOut = await waitForJob(pool, timeoutRequest.jobId, ['timed_out']);
      assert.equal(timedOut.failure_code, 'REA_PROVIDER_TIMEOUT');
      const timedOutJob = (await pool.query(`SELECT started_world_minute,completed_world_minute
        FROM world_research_jobs WHERE id=$1`, [timeoutRequest.jobId])).rows[0];
      assert.ok(Number(timedOutJob.started_world_minute) >= 480);
      assert.ok(Number(timedOutJob.completed_world_minute) >= Number(timedOutJob.started_world_minute));
      const timeoutUse = (await pool.query('SELECT status,result FROM world_capability_uses WHERE id=$1',
        [timeoutRequest.useId])).rows[0];
      assert.equal(timeoutUse.status, 'failed');
      assert.equal(timeoutUse.result.reasonCode, 'REA_PROVIDER_TIMEOUT');
      assert.deepEqual(workerErrors.filter((item) => item.jobId === timeoutRequest.jobId)
        .map((item) => item.code).filter((code) => code === 'REA_PROVIDER_TIMEOUT'), ['REA_PROVIDER_TIMEOUT']);
      await timeoutWorker.stop();
    });

    await t.test('no synthetic token/economic writes occur and repeated completion is idempotent', async () => {
      const completed = (await pool.query(`SELECT job.id,job.world_id AS "worldId",job.status,
          job.actor_agent_id AS "agentId",job.capability_id AS "capabilityId",
          job.capability_use_id AS "capabilityUseId",job.action_id AS "actionId",job.target_artifact_id AS "artifactId",
          job.target_type AS "targetType",job.created_world_minute AS "createdWorldMinute"
        FROM world_research_jobs job WHERE job.id=$1`, [successRequest.jobId])).rows[0];
      assert.equal(completed.status, 'completed');
      const before = (await pool.query(`SELECT count(*)::int AS uses FROM arc_agent_tokens WHERE world_id=$1`, [worldId])).rows[0];
      const repeated = await inTransaction(pool, (client) => completeResearchJob(client, { job: completed,
        findings: { summary: 'Fixture analysis complete' }, evidenceReference: 'rea-evidence:repeat',
        evidenceSha256: 'b'.repeat(64), evidenceBytes: 10, providers: ['javascript'], toolCalls: [],
        toolSequence: [], durationMs: 1, completedWorldMinute: 480 }));
      assert.equal(repeated.idempotent, true);
      assert.deepEqual((await pool.query(`SELECT count(*)::int AS uses FROM arc_agent_tokens WHERE world_id=$1`, [worldId])).rows[0], before);
      assert.equal(Number((await pool.query(`SELECT count(*)::int AS count FROM arc_genesis_token_settlement_outbox WHERE world_id=$1`,
        [worldId])).rows[0].count), 0);
      assert.equal(Number((await pool.query(`SELECT count(*)::int AS count FROM arc_token_issuance_intents WHERE world_id=$1`,
        [worldId])).rows[0].count), 0);
      assert.equal(arcNetworkConfig({}).writesEnabled, false);
    });

    await t.test('readiness is observable and output evidence is not exposed as a filesystem path', async () => {
      const status = (await pool.query(`SELECT worker_status,rea_server_name,rea_package_version,tool_catalog,ghidra_available
        FROM world_research_runtime_status WHERE world_id=$1`, [worldId])).rows[0];
      assert.equal(status.worker_status, 'stopped', 'all isolated workers have been stopped in sequence');
      assert.equal(status.rea_server_name, 'rea');
      assert.equal(status.rea_package_version, '6.3.0');
      assert.ok(status.tool_catalog.some((tool) => tool.name === 'analyze_javascript_application'));
      const ownJobs = await pool.query(`SELECT evidence_reference,evidence_sha256 FROM world_research_jobs
        WHERE world_id=$1 AND actor_agent_id=$2`, [worldId,agentId]);
      assert.ok(ownJobs.rows.some((row) => row.evidence_reference?.startsWith('rea-evidence:')));
      assert.ok(ownJobs.rows.every((row) => !String(row.evidence_reference || '').startsWith('/')));
    });
  } finally {
    for (const worker of workers.reverse()) await worker.stop().catch(() => {});
    await engine?.stop();
    await pool.query('DELETE FROM worlds WHERE id=$1', [worldId]).catch(() => {});
    await pool.query('DELETE FROM worlds WHERE id=$1', [foreignWorldId]).catch(() => {});
    await pool.query('DELETE FROM agents WHERE id=$1', [agentId]).catch(() => {});
    await pool.end();
    await rm(root, { recursive: true, force: true });
  }
});

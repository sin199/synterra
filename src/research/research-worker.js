import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { claimNextResearchJob, completeResearchJob, extendResearchJobLease,
  failResearchJob, markResearchExternalCallStarted, recoverExpiredResearchJobs,
  updateResearchRuntimeStatus } from './research-jobs.js';
import { containsPrivateMaterial, resolveGrantedResearchArtifact } from './artifacts.js';
import { createReaMcpClient, REA_PACKAGE_VERSION } from './rea-mcp-client.js';

const POLL_INTERVAL_MS = 2_000;
const LEASE_SECONDS = 120;
const MAX_EVIDENCE_BYTES = 24 * 1024 * 1024;
const PROTECTED_TOOL_NAMES = new Set(['open_binary', 'binary_session', 'binary_overview',
  'get_evidence_bundle', 'close_binary', 'analyze_javascript_application',
  'inspect_evm_interface', 'inspect_web_network_capture']);

function safeFailureCode(error) {
  return String(error?.code || error?.message || 'REA_PROVIDER_ERROR')
    .replace(/[^A-Z0-9_]/gi, '_').toUpperCase().slice(0, 96) || 'REA_PROVIDER_ERROR';
}

function collectEvidenceText(value, output = [], depth = 0) {
  if (depth > 6 || output.length >= 16 || value === null || value === undefined) return output;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 40)) collectEvidenceText(item, output, depth + 1);
    return output;
  }
  if (typeof value !== 'object') return output;
  for (const [key, item] of Object.entries(value).slice(0, 80)) {
    if (typeof item === 'string' && /summary|overview|finding|conclusion|limitation|unknown|observation/i.test(key)) {
      const text = item.replace(/\s+/g, ' ').trim().slice(0, 320);
      if (text) output.push({ source: key.slice(0, 48), text });
    } else if (typeof item === 'object' && item !== null) collectEvidenceText(item, output, depth + 1);
    if (output.length >= 16) break;
  }
  return output;
}

function extractProviderIds(value, output = new Set(), depth = 0) {
  if (depth > 6 || value === null || value === undefined) return output;
  if (Array.isArray(value)) { for (const item of value.slice(0, 60)) extractProviderIds(item, output, depth + 1); return output; }
  if (typeof value !== 'object') return output;
  for (const [key, item] of Object.entries(value).slice(0, 100)) {
    if (/^(provider|providerId|provider_id)$/i.test(key)) {
      const identity = item && typeof item === 'object' && !Array.isArray(item)
        ? item.id ?? item.providerId ?? item.provider_id : item;
      if (typeof identity === 'string' && /^[a-z][a-z0-9_-]{1,63}$/i.test(identity)) output.add(identity);
    } else if (key === 'providers' && Array.isArray(item)) {
      for (const entry of item.slice(0, 60)) {
        const provider = entry && typeof entry === 'object' && !Array.isArray(entry)
          ? entry.provider ?? entry : entry;
        const identity = provider && typeof provider === 'object'
          ? provider.id ?? provider.providerId ?? provider.provider_id : provider;
        if (typeof identity === 'string' && /^[a-z][a-z0-9_-]{1,63}$/i.test(identity)) output.add(identity);
        extractProviderIds(entry, output, depth + 1);
      }
    } else if (typeof item === 'object' && item !== null) extractProviderIds(item, output, depth + 1);
  }
  return output;
}

function toolCallRecord(tool, startedAt, raw) {
  return { name: tool, durationMs: Math.max(0, Date.now() - startedAt),
    resultBytes: Buffer.byteLength(JSON.stringify(raw || {}), 'utf8') };
}

async function storeEvidence(rootDirectory, evidence) {
  const bytes = Buffer.from(JSON.stringify(evidence));
  if (bytes.length > MAX_EVIDENCE_BYTES) throw Object.assign(new Error('REA_EVIDENCE_TOO_LARGE'), { code: 'REA_EVIDENCE_TOO_LARGE' });
  const digest = createHash('sha256').update(bytes).digest('hex');
  const directory = path.join(path.resolve(rootDirectory), digest.slice(0, 2));
  const destination = path.join(directory, digest);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    const handle = await open(destination, 'wx', 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const info = await stat(destination);
    if (!info.isFile() || info.size !== bytes.length
        || createHash('sha256').update(await readFile(destination)).digest('hex') !== digest) {
      throw Object.assign(new Error('REA_EVIDENCE_OBJECT_CONFLICT'), { code: 'REA_EVIDENCE_OBJECT_CONFLICT' });
    }
  }
  return { reference: `rea-evidence:${digest}`, sha256: digest, bytes: bytes.length };
}

function makeToolPlan(job, artifact) {
  if (job.targetType === 'javascript'
      || (job.targetType === 'source_code' && /(?:javascript|ecmascript|typescript)/i.test(artifact.mediaType))) {
    return [{ name: 'analyze_javascript_application', args: { input_path: artifact.path, format: 'auto', integrity_policy: 'fail' } }];
  }
  if (job.targetType === 'evm_contract') {
    const text = artifact.bytes.toString('ascii').trim();
    const encoding = /^(?:0x)?[0-9a-f]+$/i.test(text) && text.replace(/^0x/i, '').length % 2 === 0 ? 'hex' : 'raw';
    return [{ name: 'inspect_evm_interface', args: { path: artifact.path, encoding } }];
  }
  if (job.targetType === 'web') {
    const extension = path.extname(artifact.displayName).toLowerCase();
    const format = extension === '.mitm' || extension === '.dump' ? 'mitmproxy' : 'har';
    return [{ name: 'inspect_web_network_capture', args: { capture_path: artifact.path, format, sensitive_values: [] } }];
  }
  if (job.targetType === 'binary' || job.targetType === 'source_code') {
    return [{ name: 'open_binary', args: { path: artifact.path } },
      { name: 'binary_overview', args: {} }, { name: 'get_evidence_bundle', args: {} }];
  }
  throw Object.assign(new Error('REA_TARGET_TYPE_UNSUPPORTED'), { code: 'REA_TARGET_TYPE_UNSUPPORTED' });
}

export function startReaResearchWorker({ pool, worldId, isOwner = () => true, environment = process.env,
  stateDirectory, artifactDirectory = path.join(stateDirectory || '.synterra', 'research', 'artifacts'),
  evidenceDirectory = path.join(stateDirectory || '.synterra', 'research', 'evidence'),
  onError = () => {}, pollIntervalMs = POLL_INTERVAL_MS } = {}) {
  if (!pool || !worldId) throw new TypeError('Research worker requires a pool and world id.');
  const workerId = `rea-worker:${process.pid}:${randomUUID()}`;
  const config = { nodeBinary: environment.REA_NODE_BINARY || null,
    serverEntry: environment.REA_SERVER_ENTRY || null,
    requestTimeoutMs: Math.max(1_000, Math.min(600_000, Number(environment.REA_REQUEST_TIMEOUT_MS) || 600_000)) };
  const jobTimeoutMs = Math.max(1_000, Math.min(1_800_000, Number(environment.REA_JOB_TIMEOUT_MS) || 900_000));
  let running = false;
  let stopped = false;
  let busy = false;
  let timer = null;
  let activePoll = null;
  let client = null;
  let clientPromise = null;
  let readinessRetryAt = 0;
  let lastPersistedStatus = '';
  const status = { available: false, running: false, mode: 'asynchronous_research', workerId,
    nodeVersion: null, reaPackageVersion: null, serverName: null, providers: [],
    supportedTargets: {}, ghidraAvailable: false, toolCount: 0, reason: 'starting' };

  async function persistStatus(workerStatus, lastErrorCode = null) {
    const serial = JSON.stringify({ workerStatus, lastErrorCode, nodeVersion: status.nodeVersion,
      reaPackageVersion: status.reaPackageVersion, serverName: status.serverName,
      providers: status.providers, toolCatalog: status.toolCatalog || [], ghidraAvailable: status.ghidraAvailable });
    if (serial === lastPersistedStatus) return;
    try {
      await withJobTransaction((db) => updateResearchRuntimeStatus(db, { worldId, workerStatus, workerId,
        nodeVersion: status.nodeVersion, reaPackageVersion: status.reaPackageVersion,
        reaServerName: status.serverName, providers: status.providers,
        toolCatalog: status.toolCatalog || [], ghidraAvailable: status.ghidraAvailable, lastErrorCode }));
      lastPersistedStatus = serial;
    } catch (error) { throw error; }
  }

  async function ensureClient() {
    if (stopped) throw Object.assign(new Error('REA_WORKER_STOPPED'), { code: 'REA_WORKER_STOPPED' });
    if (client) return client;
    if (clientPromise) return clientPromise;
    const now = Date.now();
    if (now < readinessRetryAt) throw Object.assign(new Error(status.reason || 'REA_UNAVAILABLE'),
      { code: status.reason || 'REA_UNAVAILABLE' });
    const attempt = (async () => {
      try {
        const connectedClient = await createReaMcpClient({ nodeBinary: config.nodeBinary, serverEntry: config.serverEntry,
          environment, requestTimeoutMs: config.requestTimeoutMs });
        if (stopped) {
          await connectedClient.close({ timeoutMs: 2_000 }).catch(() => {});
          throw Object.assign(new Error('REA_WORKER_STOPPED'), { code: 'REA_WORKER_STOPPED' });
        }
        client = connectedClient;
        status.available = true;
        status.nodeVersion = connectedClient.nodeVersion;
        status.reaPackageVersion = connectedClient.readiness.packageVersion;
        status.serverName = connectedClient.readiness.serverName;
        status.providers = connectedClient.readiness.providers;
        status.toolCatalog = connectedClient.readiness.toolCatalog;
        status.supportedTargets = connectedClient.readiness.supportedTargets;
        status.toolCount = connectedClient.readiness.toolCatalog.length;
        status.ghidraAvailable = connectedClient.readiness.ghidraAvailable;
        status.reason = null;
        readinessRetryAt = 0;
        await persistStatus('ready').catch((error) => onError({ code: 'REA_STATUS_PERSISTENCE_FAILED',
          errorCode: safeFailureCode(error) }));
        return connectedClient;
      } catch (error) {
        if (stopped || error?.code === 'REA_WORKER_STOPPED') throw error;
        status.available = false;
        status.reason = safeFailureCode(error);
        readinessRetryAt = Date.now() + 60_000;
        await persistStatus(status.reason === 'REA_MCP_COMMAND_NOT_CONFIGURED' ? 'unavailable' : 'degraded', status.reason);
        throw error;
      }
    })();
    clientPromise = attempt;
    try { return await attempt; }
    finally { if (clientPromise === attempt) clientPromise = null; }
  }

  async function withJobTransaction(operation) {
    const db = await pool.connect();
    try {
      await db.query('BEGIN');
      const value = await operation(db);
      await db.query('COMMIT');
      return value;
    } catch (error) { await db.query('ROLLBACK'); throw error; }
    finally { db.release(); }
  }

  async function processJob(job) {
    const startedAt = Date.now();
    const tools = [];
    let providers = [];
    let ghidraUsed = false;
    let model = null;
    let externalStarted = false;
    const leaseTimer = setInterval(() => {
      if (!running || stopped) return;
      extendResearchJobLease(pool, { jobId: job.id, workerId, leaseSeconds: LEASE_SECONDS }).catch((error) => {
        onError({ code: 'REA_JOB_LEASE_RENEWAL_FAILED', jobId: job.id, errorCode: safeFailureCode(error) });
      });
    }, Math.max(15_000, Math.floor(LEASE_SECONDS * 500)));
    leaseTimer.unref?.();
    try {
      const artifact = await resolveGrantedResearchArtifact(pool, { worldId: job.worldId,
        agentId: job.agentId, artifactId: job.artifactId, artifactDirectory });
      const toolPlan = makeToolPlan(job, artifact);
      const rea = await ensureClient();
      if (toolPlan.some(({ name }) => !rea.hasTool(name))) throw Object.assign(new Error('REA_REQUIRED_TOOL_UNAVAILABLE'),
        { code: 'REA_REQUIRED_TOOL_UNAVAILABLE' });
      const dbStarted = await withJobTransaction((db) => markResearchExternalCallStarted(db,
        { jobId: job.id, workerId, leaseSeconds: LEASE_SECONDS }));
      if (!dbStarted) throw Object.assign(new Error('REA_JOB_LEASE_LOST'), { code: 'REA_JOB_LEASE_LOST' });
      externalStarted = true;
      const outputs = [];
      for (const call of toolPlan) {
        if (!PROTECTED_TOOL_NAMES.has(call.name)) throw Object.assign(new Error('REA_TOOL_NOT_ALLOWLISTED'),
          { code: 'REA_TOOL_NOT_ALLOWLISTED' });
        const remainingMs = jobTimeoutMs - (Date.now() - startedAt);
        if (remainingMs <= 0) throw Object.assign(new Error('REA_PROVIDER_TIMEOUT'), { code: 'REA_PROVIDER_TIMEOUT' });
        const callStarted = Date.now();
        const result = await rea.callTool(call.name, call.args, Math.min(config.requestTimeoutMs, remainingMs));
        outputs.push({ tool: call.name, result: result.raw });
        tools.push(toolCallRecord(call.name, callStarted, result.raw));
        const selected = [...extractProviderIds(result.parsed)];
        providers.push(...selected);
        ghidraUsed ||= selected.includes('ghidra');
      }
      providers = [...new Set([...providers, 'rea_mcp'])];
      const evidence = { schemaVersion: 1, job: {
        id: job.id, worldId: job.worldId, agentId: job.agentId, capabilityUseId: String(job.capabilityUseId),
        actionId: job.actionId, objective: job.objective, desiredInvestigation: job.desiredInvestigation,
        expectedResult: job.expectedResult, targetArtifactId: job.artifactId, targetType: job.targetType,
        targetSha256: artifact.sha256 }, provider: { name: rea.readiness.serverName,
        version: rea.readiness.packageVersion, catalogDigest: rea.readiness.catalogDigest },
        toolSequence: tools.map(({ name }) => name), outputs };
      if (containsPrivateMaterial(Buffer.from(JSON.stringify(evidence)))) {
        throw Object.assign(new Error('REA_EVIDENCE_PRIVATE_MATERIAL_BLOCKED'),
          { code: 'REA_EVIDENCE_PRIVATE_MATERIAL_BLOCKED' });
      }
      const stored = await storeEvidence(evidenceDirectory, evidence);
      const text = outputs.flatMap((output) => collectEvidenceText(output.result?.structuredContent || output.result));
      const summaries = text.map((item) => item.text).filter(Boolean);
      const objectiveSummary = String(job.objective || job.researchQuestion).replace(/\s+/g, ' ').slice(0, 200);
      const summary = summaries.length
        ? `REA analysis for ${objectiveSummary}: ${summaries.slice(0, 3).join(' ')}`.slice(0, 1_200)
        : `REA completed ${tools.map((item) => item.name).join(', ')} for ${objectiveSummary}; full findings are retained as evidence.`.slice(0, 1_200);
      const findings = { summary, findings: summaries.slice(0, 16).map((detail, index) => ({ id: `finding-${index + 1}`, detail })),
        limitations: [], provenance: { provider: 'rea_mcp', targetSha256: artifact.sha256 } };
      const worldMinute = await pool.query('SELECT world_minutes FROM world_runtime_state WHERE world_id=$1', [job.worldId]);
      await withJobTransaction((db) => completeResearchJob(db, { job, findings,
        evidenceReference: stored.reference, evidenceSha256: stored.sha256, evidenceBytes: stored.bytes,
        providers, toolCalls: tools, toolSequence: toolPlan.map(({ name }) => name), durationMs: Date.now() - startedAt,
        model, ghidraUsed, completedWorldMinute: Number(worldMinute.rows[0]?.world_minutes ?? job.createdWorldMinute) }));
      status.completedJobs = (status.completedJobs || 0) + 1;
    } catch (error) {
      const code = safeFailureCode(error);
      const durationMs = Date.now() - startedAt;
      const timeout = code.includes('TIMEOUT') || durationMs >= jobTimeoutMs;
      if (externalStarted && client) {
        try { await client.close({ closeTarget: true, timeoutMs: 5_000 }); } catch { /* owned process group is terminated below */ }
        client = null;
        status.available = false;
        status.reason = 'REA_PROVIDER_RESTART_AFTER_JOB_FAILURE';
      }
      const unavailable = code.includes('UNAVAILABLE') || code.includes('NOT_CONFIGURED') || code.includes('VERSION_UNSUPPORTED');
      const terminalStatus = timeout ? 'timed_out' : 'failed';
      try {
        await withJobTransaction((db) => failResearchJob(db, { job, status: terminalStatus,
          failureCode: unavailable ? 'REA_PROVIDER_UNAVAILABLE' : timeout ? 'REA_PROVIDER_TIMEOUT' : code,
          diagnostic: `REA research provider outcome: ${unavailable ? 'unavailable' : timeout ? 'timeout' : 'error'} (${code}).`,
          providers: providers instanceof Set ? [...providers] : providers, toolCalls: tools,
          durationMs, model, ghidraUsed }));
      } catch (dbError) {
        onError({ code: 'REA_JOB_PERSISTENCE_FAILED', jobId: job.id, errorCode: safeFailureCode(dbError) });
      }
      if (unavailable) {
        status.available = false;
        status.reason = code;
        readinessRetryAt = Date.now() + 60_000;
        await persistStatus('degraded', code).catch((dbError) => onError({ code: 'REA_STATUS_PERSISTENCE_FAILED',
          errorCode: safeFailureCode(dbError) }));
      }
      onError({ code: unavailable ? 'REA_PROVIDER_UNAVAILABLE' : timeout ? 'REA_PROVIDER_TIMEOUT' : 'REA_JOB_FAILED',
        jobId: job.id, failureCode: code });
    } finally {
      clearInterval(leaseTimer);
      if ((job.targetType === 'binary' || job.targetType === 'source_code') && client) {
        try { await client.callTool('close_binary', {}, 5_000); }
        catch (error) {
          onError({ code: 'REA_PROVIDER_CLEANUP_FAILED', jobId: job.id, failureCode: safeFailureCode(error) });
          await client.close({ timeoutMs: 2_000 }).catch(() => {});
          client = null;
        }
      }
    }
  }

  async function poll() {
    if (stopped || busy || !isOwner()) return;
    busy = true;
    try {
      const recovered = await withJobTransaction((db) => recoverExpiredResearchJobs(db, { worldId }));
      if (recovered.length) for (const job of recovered) onError({ code: 'REA_JOB_RECOVERED', jobId: job.id, status: job.status });
      const job = await withJobTransaction((db) => claimNextResearchJob(db, { worldId, workerId, leaseSeconds: LEASE_SECONDS }));
      if (job) await processJob(job);
      else if (!stopped && config.nodeBinary && config.serverEntry && !client && Date.now() >= readinessRetryAt) {
        try { await ensureClient(); }
        catch (error) { if (!stopped) onError({ code: 'REA_READINESS_FAILED', failureCode: safeFailureCode(error) }); }
      }
    } catch (error) {
      if (!stopped) onError({ code: 'REA_WORKER_POLL_FAILED', failureCode: safeFailureCode(error) });
    } finally { busy = false; }
  }

  function start() {
    if (stopped || running) return;
    running = true;
    status.running = true;
    if (!config.nodeBinary || !config.serverEntry) {
      status.reason = 'REA_MCP_COMMAND_NOT_CONFIGURED';
      void persistStatus('unavailable', status.reason).catch((error) => onError({ code: 'REA_STATUS_PERSISTENCE_FAILED',
        failureCode: safeFailureCode(error) }));
    } else {
      void ensureClient().catch((error) => {
        if (!stopped) onError({ code: 'REA_READINESS_FAILED', failureCode: safeFailureCode(error) });
      });
    }
    const schedulePoll = () => {
      if (stopped || busy) return;
      activePoll = poll().finally(() => { activePoll = null; });
    };
    timer = setInterval(schedulePoll, Math.max(500, Number(pollIntervalMs) || POLL_INTERVAL_MS));
    timer.unref?.();
    schedulePoll();
  }

  async function stop() {
    if (stopped && !client && !clientPromise && !activePoll) return;
    stopped = true;
    running = false;
    status.running = false;
    if (timer) clearInterval(timer);
    timer = null;
    const active = client;
    if (active) {
      await active.close({ closeTarget: false, timeoutMs: 5_000 }).catch(() => {});
      if (client === active) client = null;
    }
    const pendingClient = clientPromise;
    if (pendingClient) await pendingClient.catch(() => {});
    if (activePoll) await activePoll.catch(() => {});
    if (client) {
      const late = client;
      await late.close({ closeTarget: false, timeoutMs: 5_000 }).catch(() => {});
      if (client === late) client = null;
    }
    await persistStatus('stopped').catch((error) => onError({ code: 'REA_STATUS_PERSISTENCE_FAILED',
      failureCode: safeFailureCode(error) }));
  }

  return { start, stop, getStatus: () => ({ ...status,
    versionPinned: REA_PACKAGE_VERSION }) };
}

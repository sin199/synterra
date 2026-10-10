import { execFile } from 'node:child_process';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
export const REA_PACKAGE_VERSION = '6.3.0';
export const REA_PROTOCOL_VERSION = '2025-03-26';
const MAX_JSON_LINE_BYTES = 32 * 1024 * 1024;

function codedError(code, message = code) {
  return Object.assign(new Error(message), { code });
}

export function isReaCompatibleNodeVersion(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(version || ''));
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (major === 22) return minor >= 19;
  if (major === 24) return minor >= 11;
  return major >= 26;
}

function allowlistedEnvironment(input, nodeBinary) {
  const names = ['HOME', 'TMPDIR', 'TEMP', 'LANG', 'LC_ALL', 'GHIDRA_INSTALL_DIR', 'JAVA_HOME',
    'REA_HOME', 'REA_CONFIG_DIR', 'REA_GHIDRA_STARTUP_TIMEOUT_MS'];
  const env = Object.fromEntries(names.filter((name) => typeof input?.[name] === 'string')
    .map((name) => [name, input[name]]));
  const inheritedPath = typeof input?.PATH === 'string' ? input.PATH : '/usr/bin:/bin';
  env.PATH = `${path.dirname(nodeBinary)}${path.delimiter}${inheritedPath}`;
  return env;
}

function parseToolResult(result) {
  if (result?.structuredContent && typeof result.structuredContent === 'object') return result.structuredContent;
  const block = result?.content?.find((item) => item.type === 'text' && typeof item.text === 'string');
  if (!block) return null;
  try { return JSON.parse(block.text); } catch { return { text: block.text.slice(0, 12_000) }; }
}

function summarizeSession(session, tools) {
  const wrapper = session?.result || session;
  const identity = wrapper?.server_identity || {};
  const packageIdentity = identity.package || {};
  const catalog = identity.catalog || {};
  const digest = catalog.digests?.combined_sha256 || null;
  const candidates = Array.isArray(wrapper?.analysis_provider_candidates) ? wrapper.analysis_provider_candidates : [];
  const providers = candidates.map((candidate) => ({
    id: String(candidate.provider?.id || 'unknown'),
    name: String(candidate.provider?.name || candidate.provider?.id || 'unknown'),
    version: candidate.provider?.version || null,
    status: String(candidate.availability?.status || 'unknown'),
    reasonCode: candidate.availability?.code || null,
    reason: candidate.availability?.reason || null,
    selected: Boolean(candidate.selected)
  }));
  const toolCatalog = tools.map((tool) => ({ name: tool.name,
    description: String(tool.description || '').slice(0, 280) }));
  const uniqueNames = new Set(toolCatalog.map((tool) => tool.name));
  const identityValid = packageIdentity.name === 'rea-agents' && packageIdentity.version === REA_PACKAGE_VERSION
    && identity.server?.name === 'rea' && identity.server?.version === REA_PACKAGE_VERSION
    && /^[a-f0-9]{64}$/.test(String(digest || ''))
    && Number(catalog.counts?.mcp_tools) === toolCatalog.length && uniqueNames.size === toolCatalog.length;
  const ghidra = providers.find((provider) => provider.id === 'ghidra') || null;
  return { identityValid, serverName: identity.server?.name || null,
    packageVersion: packageIdentity.version || null, catalogDigest: digest,
    toolCatalog, providers, ghidraAvailable: ghidra?.status === 'available',
    supportedTargets: {
      binary: uniqueNames.has('open_binary') && uniqueNames.has('binary_session'),
      javascript: uniqueNames.has('analyze_javascript_application'),
      evm_contract: uniqueNames.has('inspect_evm_interface'),
      web: uniqueNames.has('inspect_web_network_capture')
    } };
}

function signalOwnedProcessTree(child, signal) {
  try {
    if (process.platform !== 'win32' && child.pid) {
      process.kill(-child.pid, signal);
      return;
    }
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
  } catch (error) {
    if (error.code !== 'ESRCH') {
      try { child.kill(signal); } catch { /* process exit is observed by the bounded waiter */ }
    }
  }
}

async function terminateOwnedProcessTree(child, timeoutMs = 5_000) {
  signalOwnedProcessTree(child, 'SIGTERM');
  const graceMs = Math.min(1_000, Math.max(250, Math.trunc(Number(timeoutMs) || 0)));
  await new Promise((resolve) => setTimeout(resolve, graceMs));
  signalOwnedProcessTree(child, 'SIGKILL');
}

export async function createReaMcpClient({ nodeBinary, serverEntry, environment = process.env,
  requestTimeoutMs = 30_000, cwd = null } = {}) {
  if (typeof nodeBinary !== 'string' || !path.isAbsolute(nodeBinary)
      || typeof serverEntry !== 'string' || !path.isAbsolute(serverEntry)) {
    throw codedError('REA_MCP_COMMAND_NOT_CONFIGURED');
  }
  let versionOutput;
  try {
    ({ stdout: versionOutput } = await execFileAsync(nodeBinary, ['--version'], { timeout: 5_000, maxBuffer: 4_096,
      env: allowlistedEnvironment(environment, nodeBinary) }));
  } catch { throw codedError('REA_NODE_RUNTIME_UNAVAILABLE'); }
  const nodeVersion = String(versionOutput).trim();
  if (!isReaCompatibleNodeVersion(nodeVersion)) throw codedError('REA_NODE_VERSION_UNSUPPORTED', nodeVersion);

  const child = spawn(nodeBinary, [serverEntry, 'mcp'], { cwd: cwd || path.dirname(serverEntry),
    env: allowlistedEnvironment(environment, nodeBinary), stdio: ['pipe', 'pipe', 'pipe'],
    detached: process.platform !== 'win32' });
  let stdoutBuffer = '';
  let stderrTail = '';
  let nextId = 0;
  let closed = false;
  const pending = new Map();
  const rejectAll = (error) => {
    for (const [id, request] of pending) { clearTimeout(request.timer); request.reject(error); pending.delete(id); }
  };
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk;
    if (Buffer.byteLength(stdoutBuffer) > MAX_JSON_LINE_BYTES) {
      rejectAll(codedError('REA_MCP_MESSAGE_TOO_LARGE'));
      child.kill('SIGTERM');
      return;
    }
    for (;;) {
      const newline = stdoutBuffer.indexOf('\n');
      if (newline < 0) break;
      const line = stdoutBuffer.slice(0, newline).trim();
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); }
      catch { rejectAll(codedError('REA_MCP_PROTOCOL_INVALID')); child.kill('SIGTERM'); return; }
      if (message.id !== undefined && pending.has(message.id)) {
        const request = pending.get(message.id);
        pending.delete(message.id);
        clearTimeout(request.timer);
        if (message.error) request.reject(codedError('REA_MCP_REQUEST_FAILED',
          String(message.error.message || message.error.code || 'REA MCP request failed')));
        else request.resolve(message.result);
      }
    }
  });
  child.stderr.on('data', (chunk) => { stderrTail = `${stderrTail}${chunk}`.slice(-4_000); });
  child.once('error', () => { closed = true; rejectAll(codedError('REA_MCP_PROCESS_ERROR')); });
  child.once('exit', (code, signal) => {
    closed = true;
    rejectAll(codedError('REA_MCP_PROCESS_EXITED', `REA MCP exited (${code ?? signal ?? 'unknown'}).`));
  });
  child.stdin.on('error', () => { closed = true; rejectAll(codedError('REA_MCP_PROCESS_EXITED')); });

  function sendNotification(method, params = {}) {
    if (closed || child.stdin.destroyed) return false;
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
    return true;
  }

  function request(method, params = {}, timeoutMs = requestTimeoutMs) {
    if (closed || child.stdin.destroyed) return Promise.reject(codedError('REA_MCP_PROCESS_EXITED'));
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(codedError('REA_MCP_REQUEST_TIMEOUT'));
      }, Math.max(1_000, Math.min(600_000, Number(timeoutMs) || requestTimeoutMs)));
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  try {
    const initialized = await request('initialize', { protocolVersion: REA_PROTOCOL_VERSION,
      capabilities: {}, clientInfo: { name: 'synterra-rea-adapter', version: '0.1.0' } }, 15_000);
    const serverInfo = initialized?.serverInfo;
    if (serverInfo?.name !== 'rea' || serverInfo?.version !== REA_PACKAGE_VERSION) {
      throw codedError('REA_MCP_SERVER_IDENTITY_MISMATCH');
    }
    sendNotification('notifications/initialized');
    const listing = await request('tools/list', {}, 30_000);
    const tools = Array.isArray(listing?.tools) ? listing.tools : [];
    if (!tools.length || tools.some((tool) => typeof tool.name !== 'string')) throw codedError('REA_MCP_TOOL_CATALOG_UNAVAILABLE');
    const sessionResult = await request('tools/call', { name: 'binary_session', arguments: {} }, 30_000);
    if (sessionResult?.isError) throw codedError('REA_MCP_SERVER_IDENTITY_UNAVAILABLE');
    const session = parseToolResult(sessionResult);
    const readiness = summarizeSession(session, tools);
    if (!readiness.identityValid) throw codedError('REA_MCP_CATALOG_IDENTITY_MISMATCH');
    const toolNames = new Set(tools.map((tool) => tool.name));
    return {
      nodeVersion, serverInfo, readiness,
      hasTool: (name) => toolNames.has(name),
      async callTool(name, args = {}, timeoutMs = requestTimeoutMs) {
        if (!toolNames.has(name)) throw codedError('REA_TOOL_UNAVAILABLE');
        const result = await request('tools/call', { name, arguments: args }, timeoutMs);
        if (result?.isError) {
          const parsed = parseToolResult(result);
          const message = typeof parsed?.text === 'string' ? parsed.text : JSON.stringify(parsed || {}).slice(0, 1_000);
          throw codedError('REA_PROVIDER_ERROR', message || 'REA provider returned an error.');
        }
        return { raw: result, parsed: parseToolResult(result) };
      },
      async close({ closeTarget = false, timeoutMs = 5_000 } = {}) {
        if (!closed && closeTarget && toolNames.has('close_binary')) {
          try { await request('tools/call', { name: 'close_binary', arguments: {} }, timeoutMs); } catch { /* process teardown remains bounded */ }
        }
        await terminateOwnedProcessTree(child, timeoutMs);
      },
      get stderrTail() { return stderrTail; }
    };
  } catch (error) {
    await terminateOwnedProcessTree(child, 2_000);
    throw error;
  }
}

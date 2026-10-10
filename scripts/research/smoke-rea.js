import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createReaMcpClient } from '../../src/research/rea-mcp-client.js';

const nodeBinary = process.env.REA_NODE_BINARY;
const serverEntry = process.env.REA_SERVER_ENTRY;
if (!nodeBinary || !serverEntry) {
  console.error(JSON.stringify({ outcome: 'unavailable', reason: 'REA_SMOKE_CONFIG_MISSING',
    required: ['REA_NODE_BINARY', 'REA_SERVER_ENTRY'] }));
  process.exitCode = 2;
} else {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'synterra-rea-smoke-'));
  let client;
  try {
    const fixtureDirectory = path.join(temporaryDirectory, 'harmless-js-fixture');
    await mkdir(fixtureDirectory, { mode: 0o700 });
    await writeFile(path.join(fixtureDirectory, 'package.json'), JSON.stringify({
      name: 'synterra-rea-smoke-fixture', version: '1.0.0', type: 'module'
    }), { mode: 0o600 });
    await writeFile(path.join(fixtureDirectory, 'index.js'),
      ['export function add(left, right) { return left + right; }',
        'export const smokeMarker = "synterra-rea-local-smoke";'].join('\n'),
      { mode: 0o600 });
    const environment = { PATH: process.env.PATH || '/usr/bin:/bin',
      HOME: temporaryDirectory, TMPDIR: temporaryDirectory, TEMP: temporaryDirectory };
    client = await createReaMcpClient({ nodeBinary, serverEntry, environment, requestTimeoutMs: 90_000 });
    if (!client.readiness.supportedTargets.javascript
        || !client.hasTool('analyze_javascript_application')) {
      throw Object.assign(new Error('REA_JAVASCRIPT_TARGET_UNAVAILABLE'), { code: 'REA_JAVASCRIPT_TARGET_UNAVAILABLE' });
    }
    const { parsed } = await client.callTool('analyze_javascript_application', {
      input_path: fixtureDirectory, format: 'directory', integrity_policy: 'fail'
    }, 90_000);
    const result = parsed?.normalized_result;
    if (!result || !Number.isFinite(Number(result.statistics?.parsed_javascript_files))
        || Number(result.statistics.parsed_javascript_files) < 1) {
      throw Object.assign(new Error('REA_JAVASCRIPT_ANALYSIS_INCOMPLETE'), { code: 'REA_JAVASCRIPT_ANALYSIS_INCOMPLETE' });
    }
    console.log(JSON.stringify({ outcome: 'passed', nodeVersion: client.nodeVersion,
      packageVersion: client.readiness.packageVersion, serverName: client.readiness.serverName,
      protocol: '2025-03-26', toolCount: client.readiness.toolCatalog.length,
      javascriptProvider: parsed.provider?.id || null,
      parsedJavaScriptFiles: result.statistics.parsed_javascript_files,
      ghidraAvailable: client.readiness.ghidraAvailable }));
  } catch (error) {
    console.error(JSON.stringify({ outcome: 'failed', code: error.code || 'REA_SMOKE_FAILED' }));
    process.exitCode = 1;
  } finally {
    await client?.close().catch(() => {});
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

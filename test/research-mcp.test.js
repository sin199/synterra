import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { createReaMcpClient, isReaCompatibleNodeVersion } from '../src/research/rea-mcp-client.js';

const nodeBinary = process.env.SYNTERRA_RESEARCH_TEST_NODE_BINARY || null;
const enabled = Boolean(nodeBinary && isReaCompatibleNodeVersion(process.env.SYNTERRA_RESEARCH_TEST_NODE_VERSION));

function fakeServerSource({ delayMs = 0, extraTool = false } = {}) {
  return `import { createInterface } from 'node:readline';
const tools = [
  {name:'binary_session',description:'REA runtime identity and provider catalog'},
  {name:'analyze_javascript_application',description:'Analyze a bounded JavaScript artifact'},
  {name:'close_binary',description:'Close a binary session'},
  ...( ${Boolean(extraTool)} ? [{name:'fixture_dynamic_tool',description:'Fixture-only dynamically discovered tool'}] : [])
];
const digest = '${'a'.repeat(64)}';
const session = {server_identity:{package:{name:'rea-agents',version:'6.3.0'},server:{name:'rea',version:'6.3.0'},catalog:{digests:{combined_sha256:digest},counts:{mcp_tools:tools.length}}},analysis_provider_candidates:[{provider:{id:'javascript',name:'JavaScript native',version:'fixture'},availability:{status:'available',code:null,reason:null},selected:true},{provider:{id:'ghidra',name:'Ghidra'},availability:{status:'unavailable',code:'not_configured',reason:'fixture'}}]};
const leaked = ['DATABASE_URL','TYPESAFE_API_KEY','PRIVATE_KEY'].some(name => Boolean(process.env[name]));
const send = value => process.stdout.write(JSON.stringify(value)+'\\n');
const input = createInterface({input:process.stdin});
input.on('line', async line => {
  let request; try { request=JSON.parse(line); } catch { return; }
  if (!('id' in request)) return;
  if (request.method==='initialize') return send({jsonrpc:'2.0',id:request.id,result:{protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:leaked?'secret-leaked':'rea',version:'6.3.0'}}});
  if (request.method==='tools/list') return send({jsonrpc:'2.0',id:request.id,result:{tools}});
  if (request.method==='tools/call') {
    const name=request.params?.name;
    if (name==='binary_session') return send({jsonrpc:'2.0',id:request.id,result:{structuredContent:session}});
    if (name==='analyze_javascript_application') {
      await new Promise(resolve=>setTimeout(resolve,${Math.max(0, Number(delayMs)||0)}));
      return send({jsonrpc:'2.0',id:request.id,result:{structuredContent:{summary:'Fixture analysis complete',findings:[{finding:'A bounded fixture was analyzed.'}],providers:[{provider:{id:'javascript'}}]}}});
    }
    if (name==='close_binary') return send({jsonrpc:'2.0',id:request.id,result:{structuredContent:{closed:true}}});
    return send({jsonrpc:'2.0',id:request.id,error:{code:-32601,message:'unknown fixture tool'}});
  }
  send({jsonrpc:'2.0',id:request.id,error:{code:-32601,message:'unknown fixture method'}});
});`;
}

async function withFakeServer(options, run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'synterra-fake-rea-'));
  const serverEntry = path.join(directory, 'fake-rea.mjs');
  await writeFile(serverEntry, fakeServerSource(options), { mode: 0o600 });
  try { return await run({ directory, serverEntry }); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

test('fake REA MCP handshake verifies server identity, dynamic catalog, providers, and excludes Synterra secrets', {
  skip: !enabled, timeout: 30_000
}, async () => withFakeServer({ extraTool: true }, async ({ directory, serverEntry }) => {
  const client = await createReaMcpClient({ nodeBinary, serverEntry, requestTimeoutMs: 5_000,
    environment: { PATH: process.env.PATH, HOME: directory, DATABASE_URL: 'database-secret-sentinel',
      TYPESAFE_API_KEY: 'typesafe-secret-sentinel', PRIVATE_KEY: 'private-key-secret-sentinel' } });
  try {
    assert.equal(client.nodeVersion, process.env.SYNTERRA_RESEARCH_TEST_NODE_VERSION);
    assert.equal(client.serverInfo.name, 'rea');
    assert.equal(client.readiness.packageVersion, '6.3.0');
    assert.equal(client.readiness.toolCatalog.length, 4);
    assert.equal(client.hasTool('fixture_dynamic_tool'), true);
    assert.equal(client.readiness.supportedTargets.javascript, true);
    assert.equal(client.readiness.ghidraAvailable, false);
    const result = await client.callTool('analyze_javascript_application',
      { input_path: path.join(directory, 'artifact.js'), format: 'auto', integrity_policy: 'fail' }, 5_000);
    assert.equal(result.parsed.summary, 'Fixture analysis complete');
  } finally { await client.close(); }
}));

test('fake REA MCP request timeout is typed and its owned process group is terminated', {
  skip: !enabled, timeout: 15_000
}, async () => withFakeServer({ delayMs: 5_000 }, async ({ directory, serverEntry }) => {
  const client = await createReaMcpClient({ nodeBinary, serverEntry,
    environment: { PATH: process.env.PATH, HOME: directory }, requestTimeoutMs: 5_000 });
  await assert.rejects(client.callTool('analyze_javascript_application', { input_path: '/fixture.js' }, 1_000),
    (error) => error.code === 'REA_MCP_REQUEST_TIMEOUT');
  await client.close({ timeoutMs: 250 });
}));

import path from 'node:path';
import { writeFile } from 'node:fs/promises';

export async function writeFakeReaMcpServer(directory, { delayMs = 5_000, extraTool = false,
  initializeDelayMs = 0, pidFile = null } = {}) {
  const serverEntry = path.join(directory, 'fake-rea.mjs');
  const source = `import { createInterface } from 'node:readline';
import { readFile, writeFile } from 'node:fs/promises';
const tools = [
  {name:'binary_session',description:'REA runtime identity and provider catalog'},
  {name:'analyze_javascript_application',description:'Analyze a bounded JavaScript artifact'},
  {name:'close_binary',description:'Close a binary session'},
  ...(${Boolean(extraTool)} ? [{name:'fixture_dynamic_tool',description:'Fixture-only dynamically discovered tool'}] : [])
];
const digest = '${'a'.repeat(64)}';
const session = {server_identity:{package:{name:'rea-agents',version:'6.3.0'},server:{name:'rea',version:'6.3.0'},catalog:{digests:{combined_sha256:digest},counts:{mcp_tools:tools.length}}},analysis_provider_candidates:[{provider:{id:'javascript',name:'JavaScript native',version:'fixture'},availability:{status:'available',code:null,reason:null},selected:true},{provider:{id:'ghidra',name:'Ghidra'},availability:{status:'unavailable',code:'not_configured',reason:'fixture'}}]};
const leaked = ['DATABASE_URL','TYPESAFE_API_KEY','PRIVATE_KEY'].some(name => Boolean(process.env[name]));
const initializeDelayMs = ${Math.max(0, Number(initializeDelayMs) || 0)};
const pidFile = ${JSON.stringify(pidFile)};
const send = value => process.stdout.write(JSON.stringify(value)+'\\n');
const input = createInterface({input:process.stdin});
input.on('line', async line => {
  let request; try { request=JSON.parse(line); } catch { return; }
  if (!('id' in request)) return;
  if (request.method==='initialize') {
    if (pidFile) await writeFile(pidFile,String(process.pid),{mode:0o600});
    if (initializeDelayMs) await new Promise(resolve=>setTimeout(resolve,initializeDelayMs));
    return send({jsonrpc:'2.0',id:request.id,result:{protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:leaked?'secret-leaked':'rea',version:'6.3.0'}}});
  }
  if (request.method==='tools/list') return send({jsonrpc:'2.0',id:request.id,result:{tools}});
  if (request.method==='tools/call') {
    const name=request.params?.name;
    if (name==='binary_session') return send({jsonrpc:'2.0',id:request.id,result:{structuredContent:session}});
    if (name==='analyze_javascript_application') {
      const file=String(request.params?.arguments?.input_path||'');
      const bytes=await readFile(file).catch(()=>Buffer.alloc(0));
      const mode=bytes.toString('utf8');
      if (mode.includes('FAKE_REA_PROVIDER_ERROR')) return send({jsonrpc:'2.0',id:request.id,result:{isError:true,content:[{type:'text',text:'fixture provider error'}]}});
      if (mode.includes('FAKE_REA_TIMEOUT') || mode.includes('FAKE_REA_DELAY')) await new Promise(resolve=>setTimeout(resolve,${Math.max(1_000, Number(delayMs)||5_000)}));
      return send({jsonrpc:'2.0',id:request.id,result:{structuredContent:{provider:{id:'rea-javascript-application',name:'REA JavaScript application analyzer',version:'1'},normalized_result:{summary:'Fixture analysis complete',findings:[{finding:'A bounded fixture was analyzed.'}]}}}});
    }
    if (name==='close_binary') return send({jsonrpc:'2.0',id:request.id,result:{structuredContent:{closed:true}}});
    return send({jsonrpc:'2.0',id:request.id,error:{code:-32601,message:'unknown fixture tool'}});
  }
  send({jsonrpc:'2.0',id:request.id,error:{code:-32601,message:'unknown fixture method'}});
});`;
  await writeFile(serverEntry, source, { mode: 0o600 });
  return serverEntry;
}

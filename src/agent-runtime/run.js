import { open, readFile, unlink } from 'node:fs/promises';
import { createPrivateKey, randomUUID } from 'node:crypto';
import path from 'node:path';
import { API_BASE, STATE_DIR, apiRequest, ensurePrivateDirs, loadState } from './client.js';

const LOCK_FILE = path.join(STATE_DIR, 'runtime.lock');
const configuredTick = Number(process.env.SYNTERRA_AGENT_TICK_MS || 900_000);
const TICK_MS = Number.isFinite(configuredTick) ? Math.max(60_000, configuredTick) : 900_000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

await ensurePrivateDirs();
const state = await loadState();
if (!state.worldId || state.agents?.length !== 10) {
  throw new Error('Synterra is not initialized. Run `npm run agents:init` first.');
}

async function acquireLock() {
  try {
    const handle = await open(LOCK_FILE, 'wx', 0o600);
    await handle.writeFile(`${process.pid}\n`);
    await handle.close();
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const previousPid = Number((await readFile(LOCK_FILE, 'utf8')).trim());
    if (Number.isInteger(previousPid) && previousPid > 0) {
      try { process.kill(previousPid, 0); throw new Error(`Synterra runtime is already active (pid ${previousPid}).`); }
      catch (probeError) {
        if (probeError.message.startsWith('Synterra runtime is already active')) throw probeError;
        if (probeError.code !== 'ESRCH') throw probeError;
      }
    }
    await unlink(LOCK_FILE);
    return acquireLock();
  }
}

await acquireLock();
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  try { await unlink(LOCK_FILE); } catch {}
  console.log('Synterra agent runtime stopped.');
  process.exit(0);
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

function chooseAction(self) {
  if (self.food < 70) return 'eat';
  if (self.energy < 60) return 'rest';
  if (self.social < 65) return 'socialize';
  return 'work';
}

async function actOnce(agent) {
  const privateKey = createPrivateKey(await readFile(agent.privateKeyFile, 'utf8'));
  const identity = { agentId: agent.agentId, privateKey };
  const observation = await apiRequest(identity, 'GET', `/v1/worlds/${state.worldId}/observe`);
  const action = chooseAction(observation.self);
  const result = await apiRequest(identity, 'POST', `/v1/worlds/${state.worldId}/actions`, {
    action, actionId: cryptoRandomId()
  });
  console.log(JSON.stringify({ time: new Date().toISOString(), agent: agent.name, gender: agent.gender, action,
    energy: result.energy, food: result.food, social: result.social, rewardUnits: result.rewardUnits }));
}

function cryptoRandomId() {
  return randomUUID();
}

let cycleRunning = false;
async function cycle() {
  if (cycleRunning) return;
  cycleRunning = true;
  for (const agent of state.agents) {
    if (stopping) break;
    try { await actOnce(agent); }
    catch (error) { console.error(JSON.stringify({ time: new Date().toISOString(), agent: agent.name, error: error.message })); }
    await sleep(500);
  }
  cycleRunning = false;
}

console.log(`Synterra runtime active for ${state.agents.length} agents; cycle interval ${TICK_MS} ms.`);
await cycle();
if (process.argv.includes('--once')) await stop();
const timer = setInterval(() => { if (!stopping) cycle(); }, TICK_MS);

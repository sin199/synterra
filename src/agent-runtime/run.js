import { open, readFile, unlink } from 'node:fs/promises';
import { createPrivateKey, randomUUID } from 'node:crypto';
import path from 'node:path';
import { API_BASE, STATE_DIR, apiRequest, ensurePrivateDirs, loadState } from './client.js';
import { candidateActions, decideNextAction } from './mind.js';
import { chooseWithTypeSafe } from './typesafe.js';
import { skillsForAction } from './skills.js';
import { createFruitflyRuntime } from './fruitfly.js';

const LOCK_FILE = path.join(STATE_DIR, 'runtime.lock');
const configuredTick = Number(process.env.SYNTERRA_AGENT_TICK_MS || 900_000);
const TICK_MS = Number.isFinite(configuredTick) ? Math.max(60_000, configuredTick) : 900_000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

await ensurePrivateDirs();
const state = await loadState();
if (!state.worldId || state.agents?.length !== 10) {
  throw new Error('Synterra is not initialized. Run `npm run agents:init` first.');
}

let fruitfly = null;
try {
  fruitfly = await createFruitflyRuntime(STATE_DIR);
} catch (error) {
  console.error(JSON.stringify({ time: new Date().toISOString(), fruitflyUnavailable: String(error?.message || error).slice(0, 180) }));
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

async function actOnce(agent) {
  const privateKey = createPrivateKey(await readFile(agent.privateKeyFile, 'utf8'));
  const identity = { agentId: agent.agentId, privateKey };
  const observation = await apiRequest(identity, 'GET', `/v1/worlds/${state.worldId}/observe`);
  let decision = decideNextAction(observation);
  const candidates = candidateActions(observation, state.mineId);
  let fruitflyChoice = null;
  let decisionSource = 'local';
  let typesafe = null;
  if (fruitfly && candidates.length) {
    try {
      fruitflyChoice = fruitfly.choose(agent.agentId, observation, candidates, decision);
      if (fruitflyChoice?.candidate) {
        decision = { ...fruitflyChoice.candidate, mindUpdate: { currentGoal: fruitflyChoice.candidate.goal } };
        decisionSource = 'fruitfly';
      }
    } catch (error) {
      console.error(JSON.stringify({ time: new Date().toISOString(), agent: agent.name,
        fruitflyFallback: String(error?.message || error).replace(/[\r\n\t]/g, ' ').slice(0, 160) }));
    }
  }
  if (process.env.TYPESAFE_API_KEY) {
    try {
      const selection = await chooseWithTypeSafe(observation, candidates, state);
      if (selection.decision) {
        decision = { ...selection.decision, mindUpdate: { currentGoal: selection.decision.goal } };
        decisionSource = 'typesafe';
        typesafe = selection;
      } else if (selection.reason !== 'single_candidate') {
        typesafe = selection;
      }
    } catch (error) {
      typesafe = { reason: `typesafe_setup_error: ${String(error?.message || 'selection unavailable').replace(/[\r\n\t]/g, ' ').slice(0, 160)}` };
    }
  }
  const activeMine = observation.mines?.find((mine) => mine.id === state.mineId && mine.status === 'active');
  if (decision.action === 'work' && !activeMine) throw new Error('Configured Genesis Mine is unavailable; refusing unassigned work.');
  const body = { action: decision.action, actionId: cryptoRandomId(), mindUpdate: decision.mindUpdate };
  if (decision.action === 'work') body.mineId = activeMine.id;
  if (decision.action === 'travel') {
    if (decision.sceneId) body.sceneId = decision.sceneId;
    else body.place = 'town-square';
  }
  if (decision.action === 'build_scene') body.scene = decision.scene;
  const result = await apiRequest(identity, 'POST', `/v1/worlds/${state.worldId}/actions`, {
    ...body
  });
  const selectedCandidate = candidates.find((candidate) => candidate.action === decision.action
    && (!decision.sceneId || candidate.sceneId === decision.sceneId)) || null;
  let fruitflyLearning = null;
  if (fruitfly && fruitflyChoice && selectedCandidate) {
    try {
      fruitflyLearning = await fruitfly.learn(agent.agentId, observation, candidates, selectedCandidate, result);
    } catch (error) {
      console.error(JSON.stringify({ time: new Date().toISOString(), agent: agent.name,
        fruitflyLearningError: String(error?.message || error).replace(/[\r\n\t]/g, ' ').slice(0, 160) }));
    }
  }
  console.log(JSON.stringify({ time: new Date().toISOString(), agent: agent.name, gender: agent.gender, action: result.action,
    goal: decision.goal, place: result.place, scene: result.scene?.name || null, energy: result.energy, food: result.food,
    social: result.social, rewardUnits: result.rewardUnits, mineId: result.mineId || null, decisionSource,
    ...(fruitflyChoice ? { fruitfly: { chosenFamily: fruitflyChoice.action, confidence: fruitflyChoice.confidence,
      updatesBefore: fruitflyChoice.updates, ...(fruitflyLearning || {}) } } : {}),
    skills: decision.skillIds || skillsForAction(decision.action),
    ...(typesafe ? { model: typesafe.model, confidence: typesafe.confidence, inputTokens: typesafe.inputTokens,
      inputCostUsd: typesafe.costUsd, monthlySpendUsd: typesafe.monthlySpendUsd } : {}),
    ...(typesafe?.reason ? { typesafeFallback: typesafe.reason } : {}) }));
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
if (!process.env.TYPESAFE_API_KEY) console.log('TypeSafe is not configured; agents are using local decision rules. Set TYPESAFE_API_KEY in .env to enable it.');
await cycle();
if (process.argv.includes('--once')) await stop();
const timer = setInterval(() => { if (!stopping) cycle(); }, TICK_MS);

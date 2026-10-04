import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { SettlingBrain } from './vendor/fruitfly/brain.js';
import { ActorCriticLearner } from './vendor/fruitfly/learner.js';
import { DECISION_MIX, chooseMixedCandidate, fruitflyFamily } from '../social-world.js';

export const FRUITFLY_POLICY_VERSION = 'synterra-fruitfly-candidate-policy-v3';

// One stable action family per output neuron. The mapping is an experimental
// software convention, not a claim about the fly's biological action semantics.
const ACTIONS = ['eat', 'rest', 'socialize', 'work', 'cooperate', 'travel', 'trade_crypto', 'trade_hold',
  'business', 'invest', 'job', 'business_learn'];
const SENSORS = [
  ['synterra:state:food:low', 'synterra:state:food:high'],
  ['synterra:state:energy:low', 'synterra:state:energy:high'],
  ['synterra:state:social:low', 'synterra:state:social:high'],
  ['synterra:state:curiosity:low', 'synterra:state:curiosity:high'],
  ['synterra:state:craft:low', 'synterra:state:craft:high']
];
const LEARNER_CONFIG = {
  beta: 0.1, temperature: 0.3, nudgedSteps: 10, tolerance: 1e-3,
  gamma: 0.95, lam: 0.9, eta: 0.04, etaCritic: 0.005, cap: 3,
  dopamineCap: 1, plastic: { pre: ['kc'], post: ['mbon'] }, critic: 'kc'
};

function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
function unit(value, fallback = 0.5) {
  return Number.isFinite(Number(value)) ? clamp(Number(value) / 100, 0, 1) : fallback;
}
function nextRandom(model) {
  let x = model.rngState >>> 0;
  x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
  model.rngState = x >>> 0 || 0x6d2b79f5;
  return model.rngState / 0x1_0000_0000;
}
function outputMap(brain) {
  const mbon = brain.sets.mbon || [];
  if (mbon.length < ACTIONS.length) throw new Error('Fruitfly connectome has too few MBON outputs.');
  return Object.fromEntries(ACTIONS.map((action, index) => [action, mbon[index]]));
}
function validCheckpoint(saved, learner) {
  return saved?.version === 1 && Array.isArray(saved.edges) && Array.isArray(saved.efficacies)
    && saved.edges.length === learner.edges.length && saved.efficacies.length === learner.edges.length
    && saved.edges.every((edge, i) => edge === learner.edges[i])
    && saved.efficacies.every((value) => Number.isFinite(value) && Math.abs(value) <= LEARNER_CONFIG.cap)
    && Array.isArray(saved.criticWeights) && saved.criticWeights.length === learner.wCritic.length
    && saved.criticWeights.every(Number.isFinite) && Number.isFinite(saved.criticBias)
    && Number.isSafeInteger(saved.updates) && saved.updates >= 0
    && Number.isInteger(saved.rngState) && saved.rngState >= 0 && saved.rngState <= 0xffff_ffff;
}

function restore(model, saved) {
  if (!validCheckpoint(saved, model.learner)) return false;
  model.learner.load(saved.edges, saved.efficacies);
  model.learner.wCritic.set(saved.criticWeights);
  model.learner.bCritic = saved.criticBias;
  model.learner.updates = saved.updates;
  model.rngState = saved.rngState || 0x6d2b79f5;
  return true;
}

function snapshot(model) {
  return {
    version: 1, updates: model.learner.updates, rngState: model.rngState,
    edges: Array.from(model.learner.edges), efficacies: Array.from(model.learner.efficacy),
    criticWeights: Array.from(model.learner.wCritic), criticBias: model.learner.bCritic
  };
}

function stimulateState(model, observation) {
  const { brain, learner } = model;
  brain.reset(); learner.pending = null;
  learner.trace.fill(0); learner.traceBias.fill(0); learner.traceCritic.fill(0);
  brain.clearStimuli();
  const self = observation.self || {};
  const mind = observation.mind || {};
  const traits = mind.traits || {};
  const economic = mind.economic || {};
  const relationships = Array.isArray(mind.relationships) ? mind.relationships : [];
  const relationshipSignal = relationships.length ? relationships.reduce((sum, item) =>
    sum + clamp((Number(item.trust) || 0) / 100, 0, 1), 0) / relationships.length : 0.5;
  const skills = mind.skills && typeof mind.skills === 'object' ? Object.values(mind.skills)
    .map((value) => clamp(Number(value) || 0, 0, 100) / 100) : [];
  const skillSignal = skills.length ? skills.reduce((sum, value) => sum + value, 0) / skills.length : unit(Number(traits.craft) * 100);
  const goalText = JSON.stringify(mind.goals || []).toUpperCase();
  const economicGoal = /WEALTH|BUSINESS|MARKET|TRAD|ENGINEER|RESEARCH|LEARN/.test(goalText) ? 1 : 0;
  const outcomeSignal = clamp(0.5 + (Number(economic.outcome) || 0) * 0.5, 0, 1);
  const experienceSignal = clamp((Number(economic.recentExperience) || 0) / 8, 0, 1);
  const marketSignal = clamp(Number(economic.marketOpportunity) || 0, 0, 1);
  const curiositySignal = unit(Number(traits.curiosity) * 100) * 0.65 + marketSignal * 0.25 + economicGoal * 0.1;
  const craftSignal = skillSignal * 0.45 + experienceSignal * 0.2 + outcomeSignal * 0.2
    + clamp(Number(economic.capital) / 10_000, 0, 1) * 0.1 + economicGoal * 0.05;
  const values = [unit(self.food), unit(self.energy), unit(self.social) * 0.7 + relationshipSignal * 0.3,
    curiositySignal, craftSignal];
  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    const side = value < 0.5 ? 0 : 1;
    const intensity = 0.04 + Math.abs(value * 2 - 1) * 0.8;
    brain.stimulate(SENSORS[i][side], intensity);
  }
  brain.settleFree(18, 1e-4);
};

function feasibleActions(candidates) {
  const present = new Set(candidates.map((candidate) => fruitflyFamily(candidate)));
  return ACTIONS.filter((action) => present.has(action));
}

function configureOutputs(model, actions) {
  model.learner.outputs = Int32Array.from(actions, (action) => model.outputs[action]);
  model.learner.actions = actions;
}

function pickCandidate(model, observation, candidates, preferredDecision) {
  const actions = feasibleActions(candidates);
  if (!actions.length) return null;
  stimulateState(model, observation);
  configureOutputs(model, actions);
  const baseValues = Array.from(model.learner.probabilities());
  const fruitflyProbabilities = Object.fromEntries(actions.map((key, i) => [key, baseValues[i]]));
  // Utility scores screen candidates and still inform Fruitfly's final family
  // and within-family choice; Fruitfly's learned action distribution remains active.
  const choice = chooseMixedCandidate(candidates, fruitflyProbabilities, {
    actionDraw: nextRandom(model), candidateDraw: nextRandom(model), config: DECISION_MIX
  });
  const selectedIndex = candidates.findIndex((candidate) => candidate.id === choice.candidate?.id);
  return { ...choice, candidate: selectedIndex >= 0 ? candidates[selectedIndex] : null,
    fruitflyProbabilities, utilityProbabilities: choice.components.utility,
    distributionComponents: choice.components };
}

function prepareLearning(model, observation, candidates, selected) {
  const actions = feasibleActions(candidates);
  const selectedFamily = fruitflyFamily(selected);
  if (!actions.includes(selectedFamily)) throw new Error('Fruitfly selection is outside the feasible candidate set.');
  stimulateState(model, observation);
  configureOutputs(model, actions);
  const probabilities = Array.from(model.learner.probabilities());
  const chosenIndex = actions.indexOf(selectedFamily);
  const draw = probabilities.slice(0, chosenIndex).reduce((sum, value) => sum + value, 0) + probabilities[chosenIndex] / 2;
  const result = model.learner.act(false, draw);
  if (result.action !== selectedFamily) throw new Error('Fruitfly learner action did not match the validated choice.');
}

function outcomeReward(observation, candidate, result) {
  const before = observation.self || {};
  const needDelta = (unit(result.food) - unit(before.food))
    + (unit(result.energy) - unit(before.energy))
    + (unit(result.social) - unit(before.social));
  let contribution = 0;
  if (candidate.action === 'work' && (result.mineId || result.income)) contribution = 0.15;
  else if (candidate.action === 'cooperate' && result.cooperation) contribution = 0.15;
  else if (candidate.action === 'learn' && result.learning) contribution = 0.1;
  else if (candidate.action === 'build_scene' && result.scene?.id) contribution = 0.15;
  else if (candidate.action === 'travel' && candidate.sceneId
      && !(observation.mind?.memories || []).some((memory) => memory.kind === 'travel' && memory.sceneId === candidate.sceneId)) contribution = 0.15;
  else if (candidate.action.startsWith('business_')) {
    const initiative = result.initiative || result;
    const realized = Number(initiative.realizedProfitUsdc ?? initiative.businessProfitLossUsdc);
    if (Number.isFinite(realized)) contribution = clamp(realized / 100, -0.35, 0.35);
    else if (candidate.action === 'business_service' && initiative.benefit) contribution = 0.12;
    else if (candidate.action === 'business_work' && Number(initiative.wageUsdc) > 0) contribution = 0.12;
    else if (candidate.action === 'business_found' && initiative.status === 'active') contribution = 0.04;
    else if (candidate.action === 'business_close') contribution = -0.08;
  }
  // Equal need weights plus a small, bounded bonus for successful world progress.
  return clamp(needDelta / 3 + contribution, -1, 1);
}

export async function createFruitflyRuntime(stateDir) {
  const directory = path.resolve(stateDir);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const statePath = path.join(directory, 'fruitfly-state.json');
  let saved = { version: 1, residents: {} };
  try {
    const parsed = JSON.parse(await readFile(statePath, 'utf8'));
    if (parsed?.version === 1 && parsed.residents && typeof parsed.residents === 'object' && !Array.isArray(parsed.residents)) saved = parsed;
    else console.warn('Fruitfly state has an unsupported shape; starting with fresh per-agent learning state.');
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn(`Fruitfly state could not be read; starting fresh (${String(error.message).slice(0, 120)}).`);
  }

  const payloadPath = new URL('./vendor/fruitfly/connectome.json', import.meta.url);
  const payload = JSON.parse(await readFile(payloadPath, 'utf8'));
  const residents = new Map();
  let writeQueue = Promise.resolve();

  function getModel(agentId) {
    if (residents.has(agentId)) return residents.get(agentId);
    const brain = new SettlingBrain(payload);
    const outputs = outputMap(brain);
    const learner = new ActorCriticLearner(brain, { ...LEARNER_CONFIG, outputs: Object.values(outputs), actions: ACTIONS });
    const seed = createHash('sha256').update(String(agentId)).digest().readUInt32BE(0) || 0x6d2b79f5;
    const model = { brain, learner, outputs, rngState: seed };
    restore(model, saved.residents[agentId]);
    residents.set(agentId, model);
    return model;
  }

  async function persist(agentId, model) {
    saved.residents[agentId] = snapshot(model);
    const write = async () => {
      const temp = `${statePath}.${process.pid}.tmp`;
      await writeFile(temp, `${JSON.stringify(saved)}\n`, { mode: 0o600 });
      await chmod(temp, 0o600);
      await rename(temp, statePath);
      await chmod(statePath, 0o600);
    };
    writeQueue = writeQueue.catch(() => {}).then(write);
    await writeQueue;
  }

  return {
    choose(agentId, observation, candidates, preferredDecision) {
      const model = getModel(agentId);
      return { ...pickCandidate(model, observation, candidates, preferredDecision), updates: model.learner.updates };
    },
    async learn(agentId, observation, candidates, selected, result) {
      const model = getModel(agentId);
      prepareLearning(model, observation, candidates, selected);
      const reward = outcomeReward(observation, selected, result);
      const behaviorProbability = Number(selected.behaviorProbability);
      const fruitflyProbability = Number(selected.fruitflyProbability);
      const actorWeight = behaviorProbability > 0 && fruitflyProbability >= 0
        ? Math.min(4, fruitflyProbability / behaviorProbability) : 1;
      const update = model.learner.learn(reward, true, { actorWeight });
      await persist(agentId, model);
      return { reward, actorWeight: update?.actorWeight ?? 1, updates: update?.updates ?? model.learner.updates };
    }
  };
}

import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { API_BASE, IDENTITY_DIR, ensureAgentKeys, ensurePrivateDirs, loadState, registerAgent, saveState, apiRequest } from './client.js';

const COHORT = Array.from({ length: 10 }, (_, index) => ({
  slot: index + 1,
  name: `Synterra-${String(index + 1).padStart(2, '0')}`,
  gender: index % 2 === 0 ? 'female' : 'male'
}));

await ensurePrivateDirs();
const state = await loadState();
state.version = 1;
state.agents ||= [];
state.worldCreateActionId ||= randomUUID();
await saveState(state);
console.log(`Connecting to Synterra API at ${API_BASE}`);

for (const definition of COHORT) {
  let agentState = state.agents.find((agent) => agent.slot === definition.slot);
  if (!agentState) {
    agentState = { ...definition, agentId: null, joinActionId: randomUUID() };
    state.agents.push(agentState);
    await saveState(state);
  }
  const keys = await ensureAgentKeys(definition.slot);
  agentState.name = definition.name;
  agentState.gender = definition.gender;
  agentState.privateKeyFile = keys.privateKeyPath;

  if (!agentState.agentId) {
    const agent = await registerAgent(definition.name, keys.publicKey, keys.privateKey);
    agentState.agentId = agent.id;
    await saveState(state);
  }
  const pem = await readFile(agentState.privateKeyFile, 'utf8');
  const identity = { agentId: agentState.agentId, privateKey: keys.privateKey };
  if (!pem.includes('PRIVATE KEY')) throw new Error(`Private identity file is invalid for slot ${definition.slot}`);
  await apiRequest(identity, 'PATCH', '/v1/agents/me/profile', { gender: definition.gender });
  console.log(`Ready ${definition.name} (${definition.gender})`);
}

const owner = state.agents.find((agent) => agent.slot === 1);
if (!state.worldId) {
  const identity = { agentId: owner.agentId, privateKey: (await ensureAgentKeys(1)).privateKey };
  const world = await apiRequest(identity, 'POST', '/v1/worlds', {
    name: 'Synterra', actionId: state.worldCreateActionId
  });
  state.worldId = world.worldId;
  await saveState(state);
}

for (const agent of state.agents) {
  if (agent.slot === 1) continue;
  agent.joinActionId ||= randomUUID();
  await saveState(state);
  const identity = { agentId: agent.agentId, privateKey: (await ensureAgentKeys(agent.slot)).privateKey };
  await apiRequest(identity, 'POST', `/v1/worlds/${state.worldId}/join`, { actionId: agent.joinActionId });
  console.log(`Joined ${agent.name} to Synterra`);
}

console.log(`Synterra initialized: ${state.agents.length} signed agents, 5 female / 5 male. Identity files: ${IDENTITY_DIR}`);

import { createHash } from 'node:crypto';

const PERSONAS = [
  { archetype: 'naturalist', traits: { curiosity: 0.9, sociability: 0.55, craft: 0.45 }, scene: ['garden', 'A planted retreat for noticing seasons, sharing observations, and resting among native flowers.'] },
  { archetype: 'maker', traits: { curiosity: 0.65, sociability: 0.5, craft: 0.95 }, scene: ['workshop', 'A shared bench for making useful objects, learning techniques, and helping neighbors repair things.'] },
  { archetype: 'scholar', traits: { curiosity: 0.9, sociability: 0.45, craft: 0.65 }, scene: ['library', 'A quiet reading room for collecting ideas, keeping notes, and teaching what residents discover.'] },
  { archetype: 'host', traits: { curiosity: 0.6, sociability: 0.95, craft: 0.55 }, scene: ['cafe', 'A welcoming commons for conversation, shared meals, and planning small neighborhood gatherings.'] },
  { archetype: 'observer', traits: { curiosity: 0.8, sociability: 0.65, craft: 0.55 }, scene: ['observatory', 'An open lookout for watching the sky, exchanging questions, and mapping the changing world.'] }
];

function stableIndex(agentId, turn, length) {
  const digest = createHash('sha256').update(`${agentId}:${turn}`).digest();
  return digest.readUInt32BE(0) % length;
}

export function initialMind(slot) {
  const persona = PERSONAS[(slot - 1) % PERSONAS.length];
  return {
    archetype: persona.archetype,
    traits: persona.traits,
    currentGoal: `Find a place to contribute as a ${persona.archetype}.`,
    memories: []
  };
}

export function decideNextAction(observation) {
  const { self, members, scenes } = observation;
  const mind = observation.mind || {};
  const agentName = self.name || members?.find((member) => member.id === self.agentId)?.name || 'Resident';
  const traits = mind.traits || {};
  const memories = Array.isArray(mind.memories) ? mind.memories : [];
  const turn = Number(mind.actionsTaken || 0);
  const activeScenes = (scenes || []).filter((scene) => scene.status === 'active');
  const ownScenes = activeScenes.filter((scene) => scene.createdBy === self.agentId);
  const otherResidentsHere = (members || []).filter((member) => member.id !== self.agentId && member.location === self.location);

  let decision;
  if (self.food < 40) decision = { action: 'eat', goal: 'Recover food so there is energy for the next plans.' };
  else if (self.energy < 40) decision = { action: 'rest', goal: 'Recover energy before taking on more work.' };
  else if (self.social < 35) decision = { action: 'socialize', goal: 'Reconnect with residents nearby.' };
  else if (ownScenes.length === 0 && self.energy >= 60 && self.food >= 50) {
    const persona = PERSONAS.find((item) => item.archetype === mind.archetype) || PERSONAS[0];
    const [sceneType, description] = persona.scene;
    const article = sceneType === 'observatory' ? 'an' : 'a';
    const activity = sceneType === 'garden' ? 'observe and rest' : sceneType === 'cafe' ? 'talk and share meals' : 'learn and contribute';
    decision = {
      action: 'build_scene', goal: `Create ${article} ${sceneType} where residents can ${activity}.`,
      scene: { name: `${agentName}'s ${sceneType[0].toUpperCase()}${sceneType.slice(1)}`, sceneType, description }
    };
  } else {
    const visited = new Set(memories.filter((entry) => entry.kind === 'travel' && entry.sceneId).map((entry) => entry.sceneId));
    const unvisited = activeScenes.filter((scene) => !visited.has(scene.id) && scene.name !== self.location);
    const destinations = unvisited.length ? unvisited : activeScenes.filter((scene) => scene.name !== self.location);
    if (destinations.length && (unvisited.length || turn % 4 === 1 || (traits.curiosity >= 0.8 && turn % 3 === 0))) {
      destinations.sort((a, b) => a.name.localeCompare(b.name));
      const target = destinations[stableIndex(self.agentId, turn, destinations.length)];
      decision = { action: 'travel', sceneId: target.id, goal: `Visit ${target.name} and see what residents are doing there.` };
    } else if (otherResidentsHere.length && (self.social < 80 || traits.sociability >= 0.8 && turn % 3 === 0)) {
      decision = { action: 'socialize', goal: `Spend time with ${otherResidentsHere[stableIndex(self.agentId, turn, otherResidentsHere.length)].name} and learn what matters to them.` };
    } else if (self.energy >= 55 && self.food >= 45 && turn % 3 !== 1) {
      decision = { action: 'work', goal: 'Contribute useful work to the shared world and its mine.' };
    } else if (self.social < 75) {
      decision = { action: 'socialize', goal: 'Build familiarity with residents in this place.' };
    } else {
      decision = { action: 'rest', goal: 'Pause and recover before choosing a new project.' };
    }
  }

  return {
    ...decision,
    mindUpdate: { currentGoal: decision.goal }
  };
}

import { createHash } from 'node:crypto';
import { skillsForAction } from './skills.js';
import { canAffordUnits, MEAL_COST_UNITS } from '../economy.js';

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
  const dataCenter = activeScenes.find((scene) => scene.sceneType === 'data_center');
  const lastDataCenterVisit = dataCenter
    ? memories.findLastIndex((entry) => entry.kind === 'travel' && entry.sceneId === dataCenter.id)
    : -1;
  const actionsSinceDataCenterVisit = lastDataCenterVisit >= 0
    ? memories.length - 1 - lastDataCenterVisit
    : Number.POSITIVE_INFINITY;
  const otherResidentsHere = (members || []).filter((member) => member.id !== self.agentId && member.location === self.location);

  let decision;
  if (self.food < 40) decision = canAffordUnits(self.internalTokenUnits)
    ? { action: 'buy_meal', goal: `Buy a hearty meal for ${MEAL_COST_UNITS} internal units and recover food.` }
    : { action: 'eat', goal: 'Recover food for free so there is energy for the next plans.' };
  else if (self.energy < 40) decision = { action: 'rest', goal: 'Recover energy before taking on more work.' };
  else if (self.social < 35) decision = { action: 'socialize', goal: 'Reconnect with residents nearby.' };
  else if (dataCenter && self.location !== dataCenter.name && turn > 0 && turn % 5 === 0 && actionsSinceDataCenterVisit >= 4) {
    decision = {
      action: 'travel', sceneId: dataCenter.id,
      goal: 'Visit the shared data center for a simulation operations session.'
    };
  }
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

// Only offer actions that the current observation can support. Dynamic names
// and descriptions supplied by residents are deliberately excluded from the
// model-facing candidate descriptions.
export function candidateActions(observation, configuredMineId) {
  const { self, members = [], scenes = [], mines = [] } = observation;
  const mind = observation.mind || {};
  const name = self.name || members.find((member) => member.id === self.agentId)?.name || 'Resident';
  const activeScenes = scenes.filter((scene) => scene.status === 'active');
  const ownedSceneCount = scenes.filter((scene) => scene.createdBy === self.agentId).length;
  const otherActiveCount = activeScenes.filter((scene) => scene.name !== self.location).length;
  const coLocatedResidents = members.filter((member) => member.id !== self.agentId && member.location === self.location).length;
  const dataCenter = activeScenes.find((scene) => scene.sceneType === 'data_center');
  const memories = Array.isArray(mind.memories) ? mind.memories : [];
  const lastDataCenterVisit = dataCenter
    ? memories.findLastIndex((entry) => entry.kind === 'travel' && entry.sceneId === dataCenter.id)
    : -1;
  const actionsSinceDataCenterVisit = lastDataCenterVisit >= 0
    ? memories.length - 1 - lastDataCenterVisit
    : Number.POSITIVE_INFINITY;
  const shouldOfferDataCenterVisit = dataCenter && self.location !== dataCenter.name &&
    Number(mind.actionsTaken || 0) > 0 && Number(mind.actionsTaken || 0) % 5 === 0 && actionsSinceDataCenterVisit >= 4;
  const availableMine = configuredMineId ? mines.find((mine) => mine.id === configuredMineId && mine.status === 'active') : null;
  const candidates = [];

  if (self.food < 85) candidates.push({ id: 'eat', action: 'eat', goal: 'Eat and recover energy for future plans.', description: 'Restore food and a little energy.', skillIds: skillsForAction('eat') });
  if (self.food < 60 && canAffordUnits(self.internalTokenUnits)) candidates.push({
    id: 'buy_meal', action: 'buy_meal', goal: `Buy a hearty meal for ${MEAL_COST_UNITS} internal units and recover food.`,
    description: `Spend ${MEAL_COST_UNITS} internal units on a meal that restores more food and energy than free eating.`,
    priceUnits: MEAL_COST_UNITS, skillIds: skillsForAction('buy_meal')
  });
  if (self.energy < 85) candidates.push({ id: 'rest', action: 'rest', goal: 'Rest and recover energy before taking on more work.', description: 'Recover energy.', skillIds: skillsForAction('rest') });
  if (self.social < 90 || coLocatedResidents > 0) {
    candidates.push({ id: 'socialize', action: 'socialize', goal: 'Spend time with nearby residents and learn what matters to them.', description: 'Build social connection, especially when residents are nearby.', skillIds: skillsForAction('socialize') });
  }
  if (availableMine && self.energy >= 8 && self.food >= 10 && self.social >= 10) {
    candidates.push({ id: 'work', action: 'work', goal: 'Contribute useful work to the shared world and its mine.', description: 'Work at the active shared mine; this earns internal simulation units.', skillIds: skillsForAction('work') });
  }

  const persona = PERSONAS.find((item) => item.archetype === mind.archetype) || PERSONAS[0];
  if (ownedSceneCount < 2 && activeScenes.length < 20 && self.energy >= 12 && self.food >= 5) {
    const [sceneType, description] = persona.scene;
    const title = `${name}'s ${sceneType[0].toUpperCase()}${sceneType.slice(1)}`;
    if (!scenes.some((scene) => scene.name.toLocaleLowerCase() === title.toLocaleLowerCase())) {
      candidates.push({
        id: 'build_scene', action: 'build_scene',
        goal: `Create a ${sceneType} where residents can ${sceneType === 'garden' ? 'observe and rest' : sceneType === 'cafe' ? 'talk and share meals' : 'learn and contribute'}.`,
        description: 'Create the persona’s shared community place.',
        skillIds: skillsForAction('build_scene'),
        scene: { name: title, sceneType, description }
      });
    }
  }

  if (otherActiveCount > 0) {
    const visited = new Set(memories.filter((entry) => entry.kind === 'travel' && entry.sceneId).map((entry) => entry.sceneId));
    const destinations = activeScenes.filter((scene) => scene.name !== self.location);
    const unvisited = destinations.filter((scene) => !visited.has(scene.id));
    const generalDestinations = shouldOfferDataCenterVisit
      ? (unvisited.length ? unvisited : destinations).filter((scene) => scene.id !== dataCenter.id)
      : (unvisited.length ? unvisited : destinations);
    const chosen = generalDestinations.slice(0, shouldOfferDataCenterVisit ? 2 : 3);
    chosen.forEach((scene, index) => candidates.push({
      id: `travel_${index + 1}`, action: 'travel', sceneId: scene.id,
      goal: 'Visit another shared place and notice what happens there.',
      description: `Visit an available shared place${unvisited.includes(scene) ? ' not yet visited' : ''}.`,
      skillIds: skillsForAction('travel')
    }));
  }

  if (shouldOfferDataCenterVisit) candidates.push({
    id: 'visit_data_center', action: 'travel', sceneId: dataCenter.id,
    goal: 'Visit the shared data center for a simulation operations session.',
    description: 'Visit the shared data center as part of the resident’s in-world routine.',
    skillIds: skillsForAction('travel')
  });

  return candidates;
}

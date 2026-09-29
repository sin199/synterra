export const WORLD_SKILLS = Object.freeze({
  care: Object.freeze({ name: 'Care', focus: 'Keep food and energy at workable levels.', actions: ['eat', 'rest'] }),
  explore: Object.freeze({ name: 'Explore', focus: 'Visit places the resident has not experienced yet.', actions: ['travel'] }),
  community: Object.freeze({ name: 'Community', focus: 'Build familiarity through nearby social activity.', actions: ['socialize'] }),
  building: Object.freeze({ name: 'Building', focus: 'Create useful shared places when capacity and needs allow.', actions: ['build_scene'] }),
  contribution: Object.freeze({ name: 'Contribution', focus: 'Contribute work to the active shared mine.', actions: ['work'] })
});

const ARCHETYPE_PRIORITIES = Object.freeze({
  naturalist: { care: 0.20, explore: 0.40, community: 0.15, building: 0.20, contribution: 0.05 },
  maker: { care: 0.10, explore: 0.10, community: 0.10, building: 0.35, contribution: 0.35 },
  scholar: { care: 0.10, explore: 0.45, community: 0.15, building: 0.20, contribution: 0.10 },
  host: { care: 0.15, explore: 0.10, community: 0.50, building: 0.15, contribution: 0.10 },
  observer: { care: 0.10, explore: 0.50, community: 0.25, building: 0.10, contribution: 0.05 }
});

export function skillProfile(archetype) {
  const priorities = ARCHETYPE_PRIORITIES[archetype] || ARCHETYPE_PRIORITIES.observer;
  return Object.entries(WORLD_SKILLS).map(([id, skill]) => ({ id, name: skill.name, focus: skill.focus, priority: priorities[id] }));
}

export function skillsForAction(action) {
  return Object.entries(WORLD_SKILLS).filter(([, skill]) => skill.actions.includes(action)).map(([id]) => id);
}

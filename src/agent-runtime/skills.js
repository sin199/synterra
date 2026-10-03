export const WORLD_SKILLS = Object.freeze({
  care: Object.freeze({ name: 'Care', focus: 'Keep food and energy at workable levels.', actions: ['eat', 'buy_meal', 'rest'] }),
  explore: Object.freeze({ name: 'Explore', focus: 'Visit places the resident has not experienced yet.', actions: ['travel'] }),
  community: Object.freeze({ name: 'Community', focus: 'Build familiarity through nearby social activity.', actions: ['socialize'] }),
  building: Object.freeze({ name: 'Building', focus: 'Create useful shared places when capacity and needs allow.', actions: ['build_scene'] }),
  contribution: Object.freeze({ name: 'Contribution', focus: 'Contribute work to the active shared mine.', actions: ['work'] }),
  markets: Object.freeze({ name: 'Markets', focus: 'Review paper markets and manage bounded simulated portfolios.', actions: ['trade_crypto', 'trade_meme', 'trade_hold'] })
});

const ARCHETYPE_PRIORITIES = Object.freeze({
  naturalist: { care: 0.18, explore: 0.36, community: 0.14, building: 0.18, contribution: 0.04, markets: 0.10 },
  maker: { care: 0.09, explore: 0.09, community: 0.09, building: 0.32, contribution: 0.32, markets: 0.09 },
  scholar: { care: 0.09, explore: 0.40, community: 0.14, building: 0.18, contribution: 0.09, markets: 0.10 },
  host: { care: 0.14, explore: 0.09, community: 0.45, building: 0.14, contribution: 0.09, markets: 0.09 },
  observer: { care: 0.09, explore: 0.45, community: 0.23, building: 0.09, contribution: 0.05, markets: 0.09 }
});

export function skillProfile(archetype) {
  const priorities = ARCHETYPE_PRIORITIES[archetype] || ARCHETYPE_PRIORITIES.observer;
  return Object.entries(WORLD_SKILLS).map(([id, skill]) => ({ id, name: skill.name, focus: skill.focus, priority: priorities[id] }));
}

export function skillsForAction(action) {
  return Object.entries(WORLD_SKILLS).filter(([, skill]) => skill.actions.includes(action)).map(([id]) => id);
}

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  activityDurationSeconds, activityNeedEffects, activityVariant, chronotype, enrichMapEnvironment,
  environmentEventIdeas, environmentTransitions, homeLocation, hourlyNeedUpdate, isHomeLocation, placePosition,
  placeSchedule, restRequired, sleepState, travelSeconds, weatherForecast, worldCalendar, worldEnvironment, worldWeather
} from '../src/world-environment.js';
import { buildActivityCandidates } from '../src/world-engine.js';
import { qualifyUtilityCandidates } from '../src/social-world.js';

const SEED = '11111111-2222-4333-8444-555555555555';
const DAY = 1_440;
const at = (day, hour, minute = 0) => (day - 1) * DAY + hour * 60 + minute;
const scenes = [
  { id: 'garden', name: 'Garden', sceneType: 'garden', status: 'active', capacity: 8, position: { x: 0.5, z: 0.1 } },
  { id: 'workshop', name: 'Workshop', sceneType: 'workshop', status: 'active', capacity: 8, position: { x: -0.4, z: 0.3 } },
  { id: 'library', name: 'Library', sceneType: 'library', status: 'active', capacity: 8, position: { x: 0.2, z: -0.6 } },
  { id: 'cafe', name: 'Cafe', sceneType: 'cafe', status: 'active', capacity: 2, position: { x: 0.1, z: 0.2 } },
  { id: 'observatory', name: 'Observatory', sceneType: 'observatory', status: 'active', capacity: 8, position: { x: -0.8, z: -0.2 } },
  { id: 'data-center', name: 'Data Center', sceneType: 'data_center', status: 'active', capacity: 8, position: { x: 0.7, z: -0.5 } }
];
function resident(overrides = {}) {
  return { agentId: 'resident-env-01', goal: 'balanced', riskTolerance: 0.3, energy: 80, food: 80, social: 70,
    happiness: 60, knowledge: 20, hygiene: 80, fun: 70, internalUnits: '0', usdc: '10000', btc: '0', eth: '0',
    traits: {}, location: 'Garden', ...overrides };
}
function agentWithChronotype(id) {
  for (let index = 0; index < 200; index++) if (chronotype(`resident-${index}`).id === id) return `resident-${index}`;
  throw new Error(`no ${id} fixture`);
}

test('calendar derives weekday, weekend, season, year and day phase from world minutes', () => {
  const start = worldCalendar(480);
  assert.equal(start.day, 1);
  assert.equal(start.weekday, 'Monday');
  assert.equal(start.season, 'spring');
  assert.equal(start.time, '08:00');
  assert.equal(start.phase, 'morning');
  assert.equal(worldCalendar(at(6, 12)).isWeekend, true);
  assert.equal(worldCalendar(at(7, 12)).weekday, 'Sunday');
  assert.equal(worldCalendar(at(8, 3)).weekday, 'Monday');
  assert.equal(worldCalendar(at(8, 3)).season, 'summer');
  assert.equal(worldCalendar(at(22, 3)).season, 'winter');
  assert.equal(worldCalendar(at(29, 3)).year, 2);
  assert.equal(worldCalendar(at(1, 2)).isNight, true);
  assert.equal(worldCalendar(at(1, 13)).daylight > 0.9, true);
  assert.equal(worldCalendar(at(1, 10)).isWorkHours, true);
  assert.equal(worldCalendar(at(6, 10)).isWorkHours, false);
});

test('weather is deterministic, persistent within a block, seasonal, and varied over a year', () => {
  assert.deepEqual(worldWeather(SEED, 600), worldWeather(SEED, 600));
  for (let block = 0; block < 40; block++) {
    const first = worldWeather(SEED, block * 180 + 600), last = worldWeather(SEED, block * 180 + 600 + 179);
    if (first.block === last.block && !['fog', 'heatwave'].includes(first.condition) && !['fog', 'heatwave'].includes(last.condition)
        && first.temperatureC > 1 && last.temperatureC > 1) assert.equal(first.condition, last.condition);
  }
  const seen = new Set();
  const seasonTemps = { spring: [], summer: [], autumn: [], winter: [] };
  for (let minute = 0; minute < 28 * DAY; minute += 60) {
    const weather = worldWeather(SEED, minute);
    seen.add(weather.condition);
    seasonTemps[worldCalendar(minute).season].push(weather.temperatureC);
    assert.ok(weather.outdoorComfort >= 0 && weather.outdoorComfort <= 1);
    assert.ok(weather.travelFactor >= 1);
  }
  for (const condition of ['clear', 'cloudy', 'rain', 'storm']) assert.ok(seen.has(condition), `${condition} should occur in a year`);
  const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
  assert.ok(mean(seasonTemps.summer) > mean(seasonTemps.spring));
  assert.ok(mean(seasonTemps.spring) > mean(seasonTemps.winter));
  assert.equal(weatherForecast(SEED, 600, 4).length, 4);
  assert.notDeepEqual(worldWeather(SEED, 600), worldWeather('another-world-seed-value-000000000000', 600));
});

test('places follow weekly opening hours, overnight observatory sessions, and storm closures', () => {
  const workshop = scenes[1], cafe = scenes[3], observatory = scenes[4], garden = scenes[0];
  assert.equal(placeSchedule(workshop, worldCalendar(at(1, 10))).open, true);
  assert.equal(placeSchedule(workshop, worldCalendar(at(1, 21))).open, false);
  assert.equal(placeSchedule(workshop, worldCalendar(at(1, 21))).opensAt, '07:00');
  assert.equal(placeSchedule(workshop, worldCalendar(at(7, 12))).open, false, 'workshops close on Sunday');
  assert.equal(placeSchedule(cafe, worldCalendar(at(1, 3))).open, false);
  assert.equal(placeSchedule(observatory, worldCalendar(at(2, 1))).open, true, 'night session carries past midnight');
  assert.equal(placeSchedule(observatory, worldCalendar(at(2, 17))).open, false);
  assert.equal(placeSchedule(garden, worldCalendar(at(1, 3)), { condition: 'storm' }).open, false);
  assert.equal(placeSchedule(garden, worldCalendar(at(1, 3)), { condition: 'clear' }).open, true);
  assert.equal(placeSchedule({ ...cafe, features: { openingHours: { weekday: [[0, 24]] } } }, worldCalendar(at(1, 3))).open, true);
  assert.equal(placeSchedule({ ...cafe, status: 'inactive' }, worldCalendar(at(1, 12))).open, false);
  assert.equal(placeSchedule({ name: homeLocation('x') }, worldCalendar(at(1, 3))).open, true);
});

test('space: positions are stable, homes sit outside the town, travel time grows with distance and bad weather', () => {
  assert.deepEqual(placePosition('Exchange'), { x: 0, z: 0 });
  assert.deepEqual(placePosition(scenes[0]), { x: 0.5, z: 0.1 });
  assert.deepEqual(placePosition({ name: 'Unpositioned Hall' }), placePosition({ name: 'Unpositioned Hall' }));
  const home = placePosition(homeLocation('resident-env-01'));
  assert.ok(Math.hypot(home.x, home.z) > 1);
  assert.equal(isHomeLocation(homeLocation('a')), true);
  const near = travelSeconds(scenes[3], scenes[0], { seed: 's' });
  const far = travelSeconds(scenes[4], scenes[5], { seed: 's' });
  const stormy = travelSeconds(scenes[4], scenes[5], { seed: 's', weather: { travelFactor: 1.6 } });
  assert.ok(far > near && stormy > far && stormy <= 32 && near >= 3);
});

test('circadian sleep windows differ by chronotype and sleep lasts until wake time', () => {
  const lark = agentWithChronotype('lark'), owl = agentWithChronotype('owl');
  assert.equal(sleepState(lark, 22 * 60 + 30).inWindow, true);
  assert.equal(sleepState(owl, 22 * 60 + 30).inWindow, false);
  assert.equal(sleepState(owl, 3 * 60).inWindow, true);
  const calendar = worldCalendar(at(1, 23, 30));
  const variant = activityVariant({ action: 'rest', location: homeLocation(lark), agentId: lark, calendar, weather: {} });
  assert.equal(variant, 'sleep');
  assert.equal(activityDurationSeconds('rest', 9, { variant, agentId: lark, calendar }), 390, 'lark sleeps until 06:00');
  assert.equal(activityVariant({ action: 'rest', location: homeLocation(lark), agentId: lark,
    calendar: worldCalendar(at(1, 14)), weather: {} }), 'home_rest');
  assert.equal(activityDurationSeconds('work', 16, { calendar }), 16);
  assert.equal(restRequired({ agentId: lark, energy: 40 }, { calendar: worldCalendar(at(2, 3)) }), true);
  assert.equal(restRequired({ agentId: lark, energy: 90 }, { calendar: worldCalendar(at(2, 3)) }), false);
});

test('hourly needs: sleep restores energy, work drains hygiene and fun, mood follows needs and weather', () => {
  const calendar = worldCalendar(at(1, 3));
  const weather = { condition: 'clear', temperatureC: 15, moodModifier: 0 };
  const sleeper = hourlyNeedUpdate({ agentId: 'a', energy: 30, food: 70, social: 60, happiness: 50, hygiene: 70, fun: 60,
    status: 'performing', plannedAction: 'rest', activityVariant: 'sleep' }, { hours: 2, calendar, weather });
  assert.equal(sleeper.asleep, true);
  assert.equal(sleeper.energy, 52);
  assert.ok(sleeper.food >= 67 && sleeper.food <= 69);
  const worker = hourlyNeedUpdate({ agentId: 'b', energy: 70, food: 70, social: 60, happiness: 60, hygiene: 70, fun: 60,
    status: 'performing', plannedAction: 'work' }, { hours: 4, calendar: worldCalendar(at(1, 14)), weather });
  assert.ok(worker.hygiene <= 59 && worker.fun <= 51 && worker.energy < 70);
  const content = hourlyNeedUpdate({ agentId: 'c', energy: 95, food: 95, social: 95, happiness: 40, hygiene: 95, fun: 95,
    status: 'idle' }, { hours: 3, calendar: worldCalendar(at(6, 14)), weather: { ...weather, moodModifier: 4 } });
  assert.ok(content.happiness > 40, 'well-met needs lift mood');
  const stormy = hourlyNeedUpdate({ agentId: 'c', energy: 40, food: 40, social: 40, happiness: 80, hygiene: 40, fun: 40,
    status: 'idle' }, { hours: 3, calendar, weather: { ...weather, moodModifier: -6 } });
  assert.ok(stormy.happiness < 80, 'unmet needs and storms lower mood');
  for (const value of Object.values(stormy)) if (typeof value === 'number') assert.ok(value >= 0 && value <= 100);
});

test('activity variants and need effects reflect place, time and weather', () => {
  const night = worldCalendar(at(1, 23)), saturdayEvening = worldCalendar(at(6, 19));
  assert.equal(activityVariant({ action: 'learn', location: 'Observatory', sceneType: 'observatory', calendar: night,
    weather: { condition: 'clear' } }), 'stargazing');
  assert.equal(activityVariant({ action: 'learn', location: 'Observatory', sceneType: 'observatory', calendar: night,
    weather: { condition: 'rain' } }), 'observatory_study');
  assert.equal(activityVariant({ action: 'socialize', location: 'Garden', sceneType: 'garden', calendar: saturdayEvening,
    weather: {} }), 'gathering');
  assert.equal(activityVariant({ action: 'eat', location: homeLocation('x'), calendar: night, weather: {} }), 'home_meal');
  assert.ok(activityNeedEffects({ action: 'rest', variant: 'home_rest' }).hygiene >= 60);
  assert.ok(activityNeedEffects({ action: 'rest', variant: 'sleep' }).hygiene > 0, 'waking up includes washing at home');
  assert.ok(activityNeedEffects({ action: 'socialize', variant: 'gathering' }).fun > activityNeedEffects({ action: 'socialize', variant: 'chat' }).fun);
  assert.ok(activityNeedEffects({ action: 'work', variant: 'workshop_shift' }).hygiene < 0);
  assert.equal(activityNeedEffects({ action: 'work', abandoned: true }).fun, -1);
});

test('environment-aware candidates drop closed or full places and add home sleep at night', () => {
  const lark = agentWithChronotype('lark');
  const night = worldEnvironment(SEED, at(2, 2));
  const candidates = buildActivityCandidates(resident({ agentId: lark, energy: 45 }), scenes,
    { tick: 5, worldMinutes: night.calendar.worldMinutes, environment: night, occupancy: { Garden: 1 } });
  assert.ok(candidates.length > 0);
  assert.equal(candidates.some((item) => ['Workshop', 'Library', 'Cafe'].includes(item.targetLocation)), false,
    'closed places are not feasible destinations');
  assert.ok(candidates.every((item) => ['rest', 'eat'].includes(item.action)), 'an exhausted resident at night only rests or eats');
  assert.equal(candidates[0].targetLocation, homeLocation(lark), 'going home to sleep ranks first deep at night');
  const qualified = qualifyUtilityCandidates(candidates);
  assert.ok(qualified.length >= 1 && qualified.length <= 8);

  const noon = worldEnvironment(SEED, at(2, 12));
  const full = buildActivityCandidates(resident({ agentId: lark, food: 20 }), scenes,
    { tick: 6, worldMinutes: noon.calendar.worldMinutes, environment: noon, occupancy: { Cafe: 2, Garden: 1 } });
  assert.equal(full.some((item) => item.targetLocation === 'Cafe'), false, 'a full cafe cannot take another visitor');
  assert.ok(full.some((item) => item.action === 'eat' && item.targetLocation === homeLocation(lark)), 'home cooking remains available');
});

test('weekday working hours raise work utility relative to the weekend', () => {
  const agent = resident({ agentId: agentWithChronotype('neutral'), location: 'Workshop', fun: 70 });
  const workScore = (minute) => {
    const environment = worldEnvironment(SEED, minute);
    return buildActivityCandidates(agent, scenes, { tick: 1, worldMinutes: minute, environment, occupancy: { Workshop: 1 } })
      .find((item) => item.id === 'work:workshop')?.score;
  };
  assert.ok(workScore(at(2, 10)) > workScore(at(6, 10)));
});

test('legacy callers without an environment keep the original candidate semantics', () => {
  const candidates = buildActivityCandidates(resident({ energy: 10, goal: 'wellbeing', happiness: 30 }), scenes, { tick: 3 });
  assert.equal(candidates.some((item) => isHomeLocation(item.targetLocation)), false);
  assert.equal(candidates[0].action, 'rest');
});

test('environment transitions and emergent ideas are keyed once per window', () => {
  const current = worldEnvironment(SEED, at(8, 0));
  const events = environmentTransitions({ season: 'spring', condition: 'storm' }, current);
  assert.ok(events.some((event) => event.eventType === 'season_changed' && event.eventKey === 'season:1:summer'));
  if (current.weather.condition !== 'storm') assert.ok(events.some((event) => event.eventType === 'weather_changed'));
  assert.deepEqual(environmentTransitions({ season: current.calendar.season, condition: current.weather.condition }, current), []);
  const calendar = worldCalendar(at(6, 18));
  const ideas = environmentEventIdeas({ scenes, calendar, weather: { condition: 'clear', label: 'Clear', outdoorComfort: 0.9, block: 1 },
    previousWeather: { condition: 'storm' } });
  assert.ok(ideas.some((idea) => idea.dedupeKey === `environment:gathering:${calendar.dayIndex}` && idea.type === 'SOCIAL'));
  assert.ok(ideas.some((idea) => idea.type === 'WORK' && idea.dedupeKey === 'environment:storm-cleanup:1'));
  const nightIdeas = environmentEventIdeas({ scenes, calendar: worldCalendar(at(2, 22)),
    weather: { condition: 'clear', label: 'Clear', outdoorComfort: 0.7, block: 2 } });
  assert.ok(nightIdeas.some((idea) => idea.type === 'LEARNING' && idea.sceneId === 'observatory'));
  for (const idea of [...ideas, ...nightIdeas]) assert.ok(idea.title.length <= 96 && idea.description.length >= 12);
});

test('map enrichment only adds fields', () => {
  const mapScenes = scenes.map((scene) => ({ ...scene, residentCount: 1 }));
  const residents = [{ id: 'resident-env-01', name: 'Ada', location: homeLocation('resident-env-01'), currentStatus: 'performing',
    activityVariant: 'sleep', targetLocation: null }];
  const events = [{ place: homeLocation('resident-env-01') }];
  const environment = enrichMapEnvironment({ worldSeed: SEED, worldMinutes: at(1, 3), scenes: mapScenes, residents, events });
  assert.equal(environment.calendar.time, '03:00');
  assert.equal(environment.forecast.length, 4);
  assert.equal(mapScenes[0].id, 'garden');
  assert.equal(typeof mapScenes[1].openNow, 'boolean');
  assert.deepEqual(mapScenes[0].resolvedPosition, { x: 0.5, z: 0.1 });
  assert.equal(residents[0].asleep, true);
  assert.equal(residents[0].locationLabel, "Ada's home");
  assert.equal(events[0].placeLabel, "Ada's home");
});

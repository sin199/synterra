// World environment model: calendar, seasons, weather, place schedules, space,
// circadian rhythm, and need dynamics. Everything here is deterministic and pure
// (no I/O), so the World Engine can recompute the same environment for the same
// world minute after a restart and tests can reproduce it exactly.
//
// The environment only shapes feasibility (closed or full places, storms) and
// Utility scores. It never selects an action: Fruitfly still chooses among the
// Utility-qualified candidates exactly as before.
import { createHash } from 'node:crypto';

export const MINUTES_PER_DAY = 1_440;
export const DAYS_PER_WEEK = 7;
export const SEASON_DAYS = 7;
export const SEASONS = Object.freeze(['spring', 'summer', 'autumn', 'winter']);
export const WEEKDAYS = Object.freeze(['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']);
export const WEATHER_BLOCK_MINUTES = 180;
export const HOME_PREFIX = 'home:';
export const EXCHANGE_LOCATION = 'Exchange';
export const NEED_KEYS = Object.freeze(['energy', 'food', 'social', 'hygiene', 'fun']);

const SUN = Object.freeze({
  spring: { rise: 390, set: 1_110 }, summer: { rise: 330, set: 1_200 },
  autumn: { rise: 405, set: 1_080 }, winter: { rise: 450, set: 1_005 }
});
const CLIMATE = Object.freeze({
  spring: { baseTemp: 14, swing: 6, rainAt: 0.64, stormAt: 0.80 },
  summer: { baseTemp: 25, swing: 7, rainAt: 0.70, stormAt: 0.77 },
  autumn: { baseTemp: 12, swing: 5, rainAt: 0.61, stormAt: 0.79 },
  winter: { baseTemp: 1, swing: 4, rainAt: 0.65, stormAt: 0.82 }
});
const WEATHER_TRAITS = Object.freeze({
  clear: { comfort: 1, travel: 1, mood: 4, label: 'Clear' },
  cloudy: { comfort: 0.85, travel: 1, mood: 0, label: 'Cloudy' },
  fog: { comfort: 0.7, travel: 1.15, mood: -1, label: 'Fog' },
  rain: { comfort: 0.35, travel: 1.25, mood: -3, label: 'Rain' },
  snow: { comfort: 0.4, travel: 1.5, mood: 1, label: 'Snow' },
  storm: { comfort: 0, travel: 1.6, mood: -6, label: 'Storm' },
  heatwave: { comfort: 0.4, travel: 1.1, mood: -3, label: 'Heatwave' }
});
export const NOTABLE_WEATHER = Object.freeze(new Set(['rain', 'snow', 'storm', 'heatwave', 'fog']));

const ALWAYS = Object.freeze([[0, MINUTES_PER_DAY]]);
const hours = (...pairs) => Object.freeze(pairs.map(([open, close]) => Object.freeze([open * 60, close * 60])));
// exposure: 0 indoor, 0.5 covered/partly outdoor, 1 fully outdoor. Intervals are
// minutes of the day; a close above 1440 runs past midnight into the next day.
export const PLACE_PROFILES = Object.freeze({
  garden: { exposure: 1, weekday: ALWAYS, weekend: ALWAYS, closesInStorm: true },
  commons: { exposure: 0.5, weekday: ALWAYS, weekend: ALWAYS, closesInStorm: false },
  cafe: { exposure: 0, weekday: hours([7, 22]), weekend: hours([8, 23]) },
  library: { exposure: 0, weekday: hours([8, 21]), weekend: hours([10, 18]) },
  workshop: { exposure: 0, weekday: hours([7, 19]), weekend: hours([9, 15]), sunday: [] },
  studio: { exposure: 0, weekday: hours([9, 22]), weekend: hours([10, 22]) },
  observatory: { exposure: 0.5, weekday: hours([10, 16], [19, 26]), weekend: hours([10, 16], [18, 27]) },
  data_center: { exposure: 0, weekday: ALWAYS, weekend: ALWAYS },
  exchange: { exposure: 0, weekday: ALWAYS, weekend: ALWAYS }
});
const CHRONOTYPES = Object.freeze([
  { id: 'lark', sleepStart: 22 * 60, sleepEnd: 6 * 60 },
  { id: 'neutral', sleepStart: 23 * 60, sleepEnd: 7 * 60 },
  { id: 'owl', sleepStart: 30, sleepEnd: 8 * 60 + 30 }
]);
const PHYSICAL_ACTIONS = new Set(['work', 'cooperate', 'business_work', 'project_contribute']);
const LEISURE_ACTIONS = new Set(['socialize', 'rest', 'eat']);

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}
function clamp(value, min = 0, max = 100) { return Math.max(min, Math.min(max, finite(value, min))); }
function round(value, digits = 3) { const factor = 10 ** digits; return Math.round(value * factor) / factor; }
function unitHash(seed) { return createHash('sha256').update(String(seed)).digest().readUInt32BE(0) / 0x1_0000_0000; }
function hhmm(minuteOfDay) {
  const value = ((Math.round(minuteOfDay) % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  return `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
}

export function worldCalendar(worldMinutes) {
  const minutes = Math.max(0, Math.trunc(finite(worldMinutes)));
  const dayIndex = Math.floor(minutes / MINUTES_PER_DAY);
  const minuteOfDay = minutes % MINUTES_PER_DAY;
  const weekdayIndex = dayIndex % DAYS_PER_WEEK;
  const season = SEASONS[Math.floor(dayIndex / SEASON_DAYS) % SEASONS.length];
  const sun = SUN[season];
  const hour = Math.floor(minuteOfDay / 60);
  let daylight = 0;
  if (minuteOfDay > sun.rise - 30 && minuteOfDay < sun.set + 30) {
    const span = sun.set - sun.rise + 60;
    daylight = Math.max(0, Math.sin(Math.PI * (minuteOfDay - sun.rise + 30) / span));
  }
  const phase = minuteOfDay < 300 ? 'night' : minuteOfDay < 420 ? 'dawn' : minuteOfDay < 720 ? 'morning'
    : minuteOfDay < 840 ? 'midday' : minuteOfDay < 1_080 ? 'afternoon' : minuteOfDay < 1_380 ? 'evening' : 'night';
  return {
    worldMinutes: minutes, day: dayIndex + 1, dayIndex, minuteOfDay, hour, minute: minuteOfDay % 60,
    time: hhmm(minuteOfDay), weekdayIndex, weekday: WEEKDAYS[weekdayIndex], isWeekend: weekdayIndex >= 5,
    week: Math.floor(dayIndex / DAYS_PER_WEEK) + 1, season, seasonDay: (dayIndex % SEASON_DAYS) + 1,
    year: Math.floor(dayIndex / (SEASON_DAYS * SEASONS.length)) + 1, phase,
    isNight: minuteOfDay < sun.rise || minuteOfDay >= sun.set, daylight: round(daylight),
    sunrise: hhmm(sun.rise), sunset: hhmm(sun.set),
    isMealTime: (minuteOfDay >= 420 && minuteOfDay < 570) || (minuteOfDay >= 720 && minuteOfDay < 840)
      || (minuteOfDay >= 1_080 && minuteOfDay < 1_230),
    isWorkHours: weekdayIndex < 5 && minuteOfDay >= 540 && minuteOfDay < 1_020
  };
}

function weatherSample(seed, block) {
  return 0.5 * unitHash(`${seed}:weather:${block}`) + 0.3 * unitHash(`${seed}:weather:${block - 1}`)
    + 0.2 * unitHash(`${seed}:weather:${block - 2}`);
}

export function worldWeather(worldSeed, worldMinutes) {
  const calendar = worldCalendar(worldMinutes);
  const block = Math.floor(calendar.worldMinutes / WEATHER_BLOCK_MINUTES);
  const climate = CLIMATE[calendar.season];
  const wetness = weatherSample(worldSeed, block);
  const dailyWave = Math.cos(((calendar.minuteOfDay - 15 * 60) / MINUTES_PER_DAY) * Math.PI * 2);
  const dayAnomaly = (unitHash(`${worldSeed}:temp:${calendar.dayIndex}`) - 0.5) * 6;
  const cloudCooling = wetness > 0.55 ? (wetness - 0.55) * 8 : 0;
  const temperatureC = round(climate.baseTemp + climate.swing * dailyWave + dayAnomaly - cloudCooling, 1);
  let condition = 'clear';
  if (wetness >= climate.stormAt) condition = temperatureC <= 1 ? 'snow' : 'storm';
  else if (wetness >= climate.rainAt) condition = temperatureC <= 1 ? 'snow' : 'rain';
  else if (wetness >= 0.55) condition = 'cloudy';
  else if (calendar.minuteOfDay >= 300 && calendar.minuteOfDay < 540 && wetness >= 0.47
    && calendar.season !== 'summer') condition = 'fog';
  if (condition === 'clear' && temperatureC >= 31) condition = 'heatwave';
  const traits = WEATHER_TRAITS[condition];
  const temperaturePenalty = temperatureC < 12 ? (12 - temperatureC) * 0.025 : temperatureC > 26 ? (temperatureC - 26) * 0.03 : 0;
  const outdoorComfort = round(clamp(traits.comfort - temperaturePenalty, 0, 1)
    * (calendar.isNight ? 0.75 : 1));
  return {
    condition, label: traits.label, temperatureC, block,
    precipitation: ['rain', 'storm', 'snow'].includes(condition) ? round(clamp((wetness - climate.rainAt) * 5, 0.1, 1)) : 0,
    cloudCover: round(clamp((wetness - 0.3) * 2, 0, 1)),
    windKph: Math.round(6 + unitHash(`${worldSeed}:wind:${block}`) * 14 + (condition === 'storm' ? 45 : 0)),
    outdoorComfort, travelFactor: round(traits.travel * (calendar.isNight ? 1.1 : 1)),
    moodModifier: traits.mood + (calendar.daylight > 0.3 && condition === 'clear' ? 1 : 0),
    startsAtWorldMinute: block * WEATHER_BLOCK_MINUTES, endsAtWorldMinute: (block + 1) * WEATHER_BLOCK_MINUTES
  };
}

export function weatherForecast(worldSeed, worldMinutes, blocks = 4) {
  const start = Math.floor(Math.max(0, finite(worldMinutes)) / WEATHER_BLOCK_MINUTES) + 1;
  return Array.from({ length: Math.max(0, Math.min(8, blocks)) }, (_, index) => {
    const at = (start + index) * WEATHER_BLOCK_MINUTES;
    const weather = worldWeather(worldSeed, at);
    return { startsAtWorldMinute: at, time: worldCalendar(at).time, day: worldCalendar(at).day,
      condition: weather.condition, label: weather.label, temperatureC: weather.temperatureC };
  });
}

export function worldEnvironment(worldSeed, worldMinutes) {
  return { calendar: worldCalendar(worldMinutes), weather: worldWeather(worldSeed, worldMinutes) };
}

export function isHomeLocation(location) { return typeof location === 'string' && location.startsWith(HOME_PREFIX); }
export function homeLocation(agentId) { return `${HOME_PREFIX}${agentId}`; }

function validIntervals(value) {
  if (!Array.isArray(value) || value.length > 4) return null;
  const result = [];
  for (const item of value) {
    if (!Array.isArray(item) || item.length !== 2) return null;
    const [open, close] = item.map((part) => finite(part, NaN));
    if (!Number.isFinite(open) || !Number.isFinite(close) || open < 0 || open >= 24 || close <= open || close > 48) return null;
    result.push([Math.round(open * 60), Math.round(close * 60)]);
  }
  return result;
}

export function placeProfile(scene) {
  if (!scene) return null;
  const type = scene.name === EXCHANGE_LOCATION ? 'exchange' : scene.sceneType || scene.scene_type;
  const base = PLACE_PROFILES[type] || { exposure: 0, weekday: ALWAYS, weekend: ALWAYS };
  const override = scene.features && typeof scene.features === 'object' ? scene.features.openingHours : null;
  const weekday = validIntervals(override?.weekday) || base.weekday;
  const weekend = validIntervals(override?.weekend) || (override?.weekday && validIntervals(override.weekday)) || base.weekend;
  const sunday = override ? weekend : base.sunday || weekend;
  return { ...base, type, weekday, weekend, sunday };
}

function intervalsFor(profile, weekdayIndex) {
  if (weekdayIndex === 6) return profile.sunday;
  return weekdayIndex === 5 ? profile.weekend : profile.weekday;
}

export function placeSchedule(scene, calendar, weather = null) {
  if (isHomeLocation(scene?.name)) return { open: true, alwaysOpen: true, opensAt: null, closesAt: null, reason: null };
  const profile = placeProfile(scene);
  if (!profile) return { open: false, alwaysOpen: false, opensAt: null, closesAt: null, reason: 'unknown' };
  if (scene.status && scene.status !== 'active') {
    return { open: false, alwaysOpen: false, opensAt: null, closesAt: null, reason: 'inactive', exposure: profile.exposure };
  }
  const minute = calendar.minuteOfDay;
  const today = intervalsFor(profile, calendar.weekdayIndex);
  const yesterday = intervalsFor(profile, (calendar.weekdayIndex + 6) % 7);
  const alwaysOpen = today.length === 1 && today[0][0] === 0 && today[0][1] >= MINUTES_PER_DAY;
  let current = today.find(([open, close]) => minute >= open && minute < close);
  if (!current) {
    const carry = yesterday.find(([, close]) => close > MINUTES_PER_DAY && minute < close - MINUTES_PER_DAY);
    if (carry) current = [carry[0] - MINUTES_PER_DAY, carry[1] - MINUTES_PER_DAY];
  }
  const stormClosed = Boolean(profile.closesInStorm && weather?.condition === 'storm');
  let opensAt = null;
  if (!current) {
    const next = today.find(([open]) => open > minute);
    if (next) opensAt = hhmm(next[0]);
    else for (let offset = 1; offset <= 7 && !opensAt; offset++) {
      const intervals = intervalsFor(profile, (calendar.weekdayIndex + offset) % 7);
      if (intervals.length) opensAt = hhmm(intervals[0][0]);
    }
  }
  return {
    open: Boolean(current) && !stormClosed, alwaysOpen, exposure: profile.exposure,
    opensAt, closesAt: current && !alwaysOpen ? hhmm(current[1]) : null,
    minutesUntilClose: current && !alwaysOpen ? current[1] - minute : null,
    reason: stormClosed ? 'storm' : current ? null : 'closed_hours',
    hours: { weekday: profile.weekday.map(([o, c]) => `${hhmm(o)}-${hhmm(c)}`),
      weekend: profile.weekend.map(([o, c]) => `${hhmm(o)}-${hhmm(c)}`),
      sunday: profile.sunday.map(([o, c]) => `${hhmm(o)}-${hhmm(c)}`) }
  };
}

export function placePosition(sceneOrLocation) {
  const scene = typeof sceneOrLocation === 'string' ? { name: sceneOrLocation } : (sceneOrLocation || {});
  const name = String(scene.name || '');
  if (!name || name === EXCHANGE_LOCATION || name === 'town-square') return { x: 0, z: 0 };
  const position = scene.position && typeof scene.position === 'object' ? scene.position : null;
  if (position && Number.isFinite(Number(position.x)) && Number.isFinite(Number(position.z))) {
    return { x: Number(position.x), z: Number(position.z) };
  }
  if (isHomeLocation(name)) {
    const angle = unitHash(`home-angle:${name}`) * Math.PI * 2;
    const radius = 1.08 + unitHash(`home-radius:${name}`) * 0.12;
    return { x: round(Math.cos(angle) * radius), z: round(Math.sin(angle) * radius) };
  }
  const angle = unitHash(`place-angle:${name}`) * Math.PI * 2;
  const radius = 0.32 + unitHash(`place-radius:${name}`) * 0.58;
  return { x: round(Math.cos(angle) * radius), z: round(Math.sin(angle) * radius) };
}

export function placeDistance(from, to) {
  const a = placePosition(from), b = placePosition(to);
  return Math.hypot(a.x - b.x, a.z - b.z);
}

// Real seconds (= world minutes) of walking between two places.
export function travelSeconds(from, to, { weather = null, seed = '' } = {}) {
  const distance = placeDistance(from, to);
  const factor = finite(weather?.travelFactor, 1);
  const jitter = Math.floor(unitHash(`travel:${seed}`) * 3);
  return Math.max(3, Math.min(32, Math.round((3 + distance * 10) * factor) + jitter));
}

export function chronotype(agentId) {
  return CHRONOTYPES[Math.floor(unitHash(`chronotype:${agentId}`) * CHRONOTYPES.length) % CHRONOTYPES.length];
}

function minutesBetween(from, to) { return ((to - from) % MINUTES_PER_DAY + MINUTES_PER_DAY) % MINUTES_PER_DAY; }

export function sleepState(agentId, minuteOfDay) {
  const type = chronotype(agentId);
  const windowLength = minutesBetween(type.sleepStart, type.sleepEnd);
  const intoWindow = minutesBetween(type.sleepStart, minuteOfDay);
  const inWindow = intoWindow < windowLength;
  const untilStart = minutesBetween(minuteOfDay, type.sleepStart);
  const pressure = inWindow ? 0.65 + 0.35 * Math.min(1, intoWindow / (windowLength / 2))
    : untilStart <= 120 ? 0.5 * (1 - untilStart / 120) : 0;
  return { chronotype: type.id, inWindow, pressure: round(pressure),
    minutesUntilWake: inWindow ? windowLength - intoWindow : null,
    sleepWindow: { start: hhmm(type.sleepStart), end: hhmm(type.sleepEnd) } };
}

export function isSleepVariant(variant) { return variant === 'sleep'; }

// The concrete form of an activity follows from where and when it happens; it is
// derived from world state after Fruitfly has already chosen the action.
export function activityVariant({ action, location, sceneType = null, agentId = null, calendar, weather }) {
  const home = isHomeLocation(location);
  if (action === 'rest') {
    if (home) {
      const sleep = sleepState(agentId, calendar.minuteOfDay);
      return sleep.inWindow || sleep.pressure >= 0.4 ? 'sleep' : 'home_rest';
    }
    if (sceneType === 'garden') return finite(weather?.outdoorComfort, 0.5) >= 0.6 ? 'garden_stroll' : 'garden_rest';
    return 'rest';
  }
  if (action === 'eat') {
    if (home) return 'home_meal';
    if (sceneType === 'cafe') return 'cafe_meal';
    if (sceneType === 'garden') return finite(weather?.outdoorComfort, 0.5) >= 0.6 ? 'picnic' : 'snack';
    return 'meal';
  }
  if (action === 'learn') {
    if (sceneType === 'observatory') return calendar.isNight && ['clear', 'heatwave'].includes(weather?.condition)
      ? 'stargazing' : 'observatory_study';
    return 'library_study';
  }
  if (action === 'socialize') {
    if ((sceneType === 'garden' || sceneType === 'commons') && calendar.isWeekend && calendar.phase === 'evening') return 'gathering';
    return sceneType === 'cafe' ? 'coffee_chat' : 'chat';
  }
  if (action === 'work' || action === 'cooperate') {
    if (sceneType === 'data_center') return calendar.isNight ? 'night_shift' : 'data_shift';
    return 'workshop_shift';
  }
  return null;
}

// Seconds the activity occupies. Sleep lasts until the resident's wake time.
export function activityDurationSeconds(action, baseSeconds, { variant = null, agentId = null, calendar = null } = {}) {
  if (action === 'rest' && variant === 'sleep' && calendar) {
    const sleep = sleepState(agentId, calendar.minuteOfDay);
    const minutes = sleep.inWindow ? sleep.minutesUntilWake : minutesBetween(calendar.minuteOfDay, chronotype(agentId).sleepEnd);
    return Math.max(90, Math.min(540, Math.round(minutes)));
  }
  if (action === 'rest' && variant === 'home_rest') return Math.max(baseSeconds, 25);
  if (action === 'eat' && variant === 'home_meal') return Math.max(baseSeconds, 20);
  if (action === 'learn' && variant === 'stargazing') return Math.max(baseSeconds, 30);
  return baseSeconds;
}

// Extra need effects of a completed activity, beyond the engine's original
// energy/food/social/happiness/knowledge deltas.
export function activityNeedEffects({ action, variant = null, weather = null, abandoned = false }) {
  const effects = { energy: 0, food: 0, social: 0, happiness: 0, knowledge: 0, hygiene: 0, fun: 0 };
  if (abandoned) return { ...effects, fun: -1 };
  const comfort = finite(weather?.outdoorComfort, 0.6);
  switch (variant || action) {
    // Waking includes a morning wash at home.
    case 'sleep': Object.assign(effects, { energy: 4, happiness: 3, hygiene: 30, food: -2 }); break;
    case 'home_rest': Object.assign(effects, { energy: -12, happiness: 2, hygiene: 65, fun: 3 }); break;
    case 'garden_stroll': Object.assign(effects, { happiness: 2, fun: 8 + Math.round(comfort * 4), hygiene: -1 }); break;
    case 'garden_rest': Object.assign(effects, { energy: -6, fun: 2, hygiene: -2 }); break;
    case 'home_meal': Object.assign(effects, { food: -8, energy: -4, fun: 1, hygiene: -1 }); break;
    case 'cafe_meal': Object.assign(effects, { fun: 4, social: 2 }); break;
    case 'picnic': Object.assign(effects, { fun: 6, happiness: 1 }); break;
    case 'snack': Object.assign(effects, { food: -10 }); break;
    case 'stargazing': Object.assign(effects, { fun: 10, happiness: 4 }); break;
    case 'observatory_study': case 'library_study': Object.assign(effects, { fun: 2 }); break;
    case 'gathering': Object.assign(effects, { fun: 14, social: 6, happiness: 2 }); break;
    case 'coffee_chat': case 'chat': Object.assign(effects, { fun: 9 }); break;
    case 'night_shift': Object.assign(effects, { energy: -4, hygiene: -8, fun: -5 }); break;
    case 'data_shift': case 'workshop_shift': Object.assign(effects, { hygiene: -8, fun: -4 }); break;
    case 'trade': Object.assign(effects, { fun: 3 }); break;
    case 'rest': Object.assign(effects, { fun: 2 }); break;
    default:
      if (PHYSICAL_ACTIONS.has(action)) Object.assign(effects, { hygiene: -6, fun: -3 });
      else if (action) Object.assign(effects, { hygiene: -1, fun: -1 });
  }
  return effects;
}

// Hourly passive need dynamics. Residents asleep recover energy gradually;
// awake residents drift down faster at night, in heat, cold, or while working.
export function hourlyNeedUpdate(resident, { hours = 1, calendar, weather }) {
  const h = Math.max(0, Math.min(24, Math.trunc(finite(hours))));
  const current = Object.fromEntries(['energy', 'food', 'social', 'happiness', 'hygiene', 'fun']
    .map((key) => [key, clamp(resident[key] ?? (key === 'hygiene' ? 80 : key === 'fun' ? 70 : 60))]));
  if (!h) return { ...current, asleep: false };
  const asleep = resident.status === 'performing' && isSleepVariant(resident.activityVariant);
  const sleep = sleepState(resident.agentId, calendar.minuteOfDay);
  const performing = resident.status === 'performing' ? String(resident.plannedAction || '') : '';
  const temperature = finite(weather?.temperatureC, 18);
  const rate = { energy: 0, food: 0, social: 0, hygiene: 0, fun: 0 };
  if (asleep) Object.assign(rate, { energy: 11, food: -1, social: -0.25, hygiene: -0.5, fun: 0 });
  else {
    rate.energy = -1 - (sleep.inWindow ? 1.5 : 0) - (temperature >= 30 ? 0.5 : 0);
    rate.food = -2 - (temperature <= 3 ? 0.5 : 0) - (PHYSICAL_ACTIONS.has(performing) ? 0.5 : 0);
    rate.social = -1 - (calendar.isWeekend ? 0.5 : 0);
    rate.hygiene = -1.5 - (PHYSICAL_ACTIONS.has(performing) ? 1.5 : 0) - (temperature >= 28 ? 0.5 : 0);
    rate.fun = -1.5 - (PHYSICAL_ACTIONS.has(performing) ? 1 : 0) + (LEISURE_ACTIONS.has(performing) ? 1.5 : 0);
  }
  const next = { ...current };
  // Deterministic dithering applies fractional hourly rates on average without randomness.
  const worldHour = Math.floor(finite(calendar.worldMinutes) / 60);
  for (const [index, key] of NEED_KEYS.entries()) {
    const total = rate[key] * h;
    const whole = Math.trunc(total);
    const fraction = Math.abs(total - whole);
    const threshold = unitHash(`dither:${resident.agentId}:${key}:${worldHour}:${index}`);
    next[key] = Math.round(clamp(current[key] + whole + (fraction > threshold ? Math.sign(total) : 0)));
  }
  // Mood follows how well needs are met instead of decaying on a fixed schedule.
  const wellbeing = next.energy * 0.22 + next.food * 0.22 + next.social * 0.2 + next.fun * 0.2 + next.hygiene * 0.16;
  const target = clamp(wellbeing + finite(weather?.moodModifier) + (calendar.isWeekend ? 3 : 0));
  const blend = 1 - (0.85 ** h);
  next.happiness = Math.round(clamp(current.happiness + (target - current.happiness) * blend));
  return { ...next, asleep };
}

// Utility-only adjustments: never selects an action, only removes infeasible
// destinations (closed, full, storm-exposed) and adjusts scores.
export function applyEnvironmentToCandidates(options, agent, scenes, context) {
  const env = context.environment;
  if (!env?.calendar) return options;
  const { calendar, weather } = env;
  const sceneByName = new Map((scenes || []).map((scene) => [scene.name, scene]));
  // occupancy: residents currently at each place (the caller included).
  const occupancy = context.occupancy || {};
  const sleep = sleepState(agent.agentId, calendar.minuteOfDay);
  const fun = clamp(agent.fun ?? 70), hygiene = clamp(agent.hygiene ?? 80);
  const exhaustedNight = restRequired(agent, env);
  const result = [];
  for (const option of options) {
    // Deep in the resident's own night with little energy left, only restorative actions stay feasible.
    if (exhaustedNight && !['rest', 'eat'].includes(option.action)) continue;
    const scene = sceneByName.get(option.targetLocation);
    const here = option.targetLocation === agent.location;
    if (scene) {
      const schedule = placeSchedule(scene, calendar, weather);
      if (!schedule.open) continue;
      // Do not walk to a place that will close before the visit can finish.
      if (!here && schedule.minutesUntilClose !== null && schedule.minutesUntilClose < 45) continue;
      const capacity = Math.max(1, finite(scene.capacity, 8));
      const visitors = Math.max(0, finite(occupancy[scene.name]) + (here ? 0 : 1));
      // Arriving would exceed the place's capacity: not a feasible destination.
      if (!here && visitors > capacity) continue;
      option.score -= Math.max(0, visitors / capacity - 0.6) * 10;
      if (schedule.exposure > 0) option.score += (finite(weather?.outdoorComfort, 0.6) - 0.55) * 18 * schedule.exposure;
      option.placeOpenUntil = schedule.closesAt;
    }
    if (!here) option.score -= placeDistance(agent.location, option.targetLocation) * 4 * finite(weather?.travelFactor, 1);
    else option.score += 2;
    const sceneType = scene?.sceneType || null;
    if (option.action === 'work' || option.action === 'cooperate') {
      option.score += calendar.isWorkHours ? 8 : calendar.phase === 'evening' ? -6 : calendar.phase === 'night' ? -12 : 0;
      if (calendar.isWeekend) option.score -= 6;
      if (sceneType === 'data_center' && calendar.phase === 'night') option.score += 4;
      option.score -= Math.max(0, 45 - fun) * 0.2;
    } else if (option.action === 'socialize') {
      option.score += calendar.phase === 'evening' ? 8 : calendar.phase === 'night' ? -10 : 0;
      if (calendar.isWeekend) option.score += 6;
      option.score += Math.max(0, 70 - fun) * 0.25 - Math.max(0, 40 - hygiene) * 0.35;
    } else if (option.action === 'eat') {
      if (calendar.isMealTime) option.score += 8;
      if (sceneType === 'cafe') option.score += Math.max(0, 60 - fun) * 0.1;
    } else if (option.action === 'learn') {
      if (calendar.phase === 'morning') option.score += 4;
      if (sceneType === 'observatory') option.score += calendar.isNight
        ? (['clear', 'heatwave'].includes(weather?.condition) ? 12 + Math.max(0, 70 - fun) * 0.15 : -6) : 0;
    } else if (option.action === 'rest' && sceneType === 'garden') {
      option.score += Math.max(0, 70 - fun) * 0.2 - (sleep.inWindow ? 10 : 0);
    }
    if (sleep.inWindow && !['rest', 'eat'].includes(option.action)) option.score -= sleep.pressure * 22;
    result.push(option);
  }
  return result;
}

export function restRequired(agent, environment) {
  if (!environment?.calendar) return false;
  const sleep = sleepState(agent.agentId, environment.calendar.minuteOfDay);
  return sleep.inWindow && sleep.pressure >= 0.8 && clamp(agent.energy) < 60;
}

export function homeActivityCandidates(agent, context) {
  const env = context.environment;
  if (!env?.calendar) return [];
  const { calendar, weather } = env;
  const home = homeLocation(agent.agentId);
  const energy = clamp(agent.energy), food = clamp(agent.food);
  const hygiene = clamp(agent.hygiene ?? 80);
  const sleep = sleepState(agent.agentId, calendar.minuteOfDay);
  const distancePenalty = agent.location === home ? -2 : placeDistance(agent.location, home) * 3 * finite(weather?.travelFactor, 1);
  const sleepy = sleep.inWindow || sleep.pressure >= 0.4;
  const restScore = sleepy
    ? 30 + sleep.pressure * 48 + Math.max(0, 85 - energy) * 0.45
    : 12 + Math.max(0, 70 - hygiene) * 0.85 + Math.max(0, 40 - energy) * 0.4;
  const options = [{ id: `rest:home:${agent.agentId}`, action: 'rest', targetLocation: home,
    goal: sleepy ? 'Go home and sleep through the night.' : 'Go home to wash up and recover.',
    description: sleepy ? 'Sleep at home until morning.' : 'Wash, change, and recover at home.',
    score: restScore - distancePenalty, plannedPaidMeal: false, side: null, asset: null, quoteUnits: null,
    socialPartnerId: null, socialPartnerName: null, home: true }];
  if (food < 80) options.push({ id: `eat:home:${agent.agentId}`, action: 'eat', targetLocation: home,
    goal: 'Cook a simple meal at home.', description: 'Cook a simple meal at home.',
    score: 15 + Math.max(0, 80 - food) * 0.7 + (calendar.isMealTime ? 6 : 0) + (sleep.inWindow ? 4 : 0)
      + (weather?.condition === 'storm' ? 6 : 0) - distancePenalty,
    plannedPaidMeal: false, side: null, asset: null, quoteUnits: null, socialPartnerId: null, socialPartnerName: null,
    home: true });
  return options;
}

// Emergent, environment-driven opportunities, created at most once per window.
export function environmentEventIdeas({ scenes = [], calendar, weather, previousWeather = null }) {
  const ideas = [];
  const open = (scene) => placeSchedule(scene, calendar, weather).open;
  const active = scenes.filter((scene) => scene.status === 'active');
  const gatherPlace = active.find((scene) => ['garden', 'commons'].includes(scene.sceneType) && open(scene));
  if (gatherPlace && calendar.isWeekend && calendar.hour >= 17 && calendar.hour < 21
      && finite(weather.outdoorComfort) >= 0.55) ideas.push({
    type: 'SOCIAL', sourceType: 'event', sceneId: gatherPlace.id, sourceKey: `gathering:${calendar.dayIndex}`,
    dedupeKey: `environment:gathering:${calendar.dayIndex}`,
    title: `${calendar.weekday} evening gathering at ${gatherPlace.name}`,
    description: `Pleasant ${weather.label.toLowerCase()} weather on a ${calendar.weekday} evening invites residents to gather at ${gatherPlace.name}.`,
    requirements: { minEnergy: 15, minFood: 10 }, capacity: 6, reward: { skill: 'social', skillGain: 1, goalProgress: 2 },
    risk: { effort: 'low' }, expiresWorldTime: calendar.worldMinutes + 180,
    metadata: { needReason: 'weekend_evening_gathering', season: calendar.season, weather: weather.condition }
  });
  const observatory = active.find((scene) => scene.sceneType === 'observatory' && open(scene));
  if (observatory && calendar.isNight && ['clear', 'heatwave'].includes(weather.condition)) ideas.push({
    type: 'LEARNING', sourceType: 'event', sceneId: observatory.id, sourceKey: `stargazing:${calendar.dayIndex}`,
    dedupeKey: `environment:stargazing:${calendar.dayIndex}`,
    title: `Clear-sky observation night at ${observatory.name}`,
    description: 'A clear night sky makes this a rare chance for shared observation and careful note taking.',
    requirements: { minEnergy: 15, minFood: 8, minSkills: { research: 3 } }, capacity: 4,
    reward: { skill: 'research', skillGain: 1.5, goalProgress: 3 }, risk: { effort: 'low' },
    expiresWorldTime: calendar.worldMinutes + 180, metadata: { needReason: 'clear_night_sky', season: calendar.season }
  });
  const garden = active.find((scene) => scene.sceneType === 'garden');
  if (garden && previousWeather?.condition === 'storm' && weather.condition !== 'storm') ideas.push({
    type: 'WORK', sourceType: 'event', sceneId: garden.id, sourceKey: `storm-cleanup:${weather.block}`,
    dedupeKey: `environment:storm-cleanup:${weather.block}`,
    title: `Clear storm debris at ${garden.name}`,
    description: `The storm left debris around ${garden.name}; residents can restore the shared space together.`,
    requirements: { minEnergy: 20, minFood: 10 }, capacity: 4, reward: { effortCredit: 2, goalProgress: 2 },
    risk: { effort: 'moderate' }, expiresWorldTime: calendar.worldMinutes + 360,
    metadata: { needReason: 'storm_damage', season: calendar.season }
  });
  return ideas;
}

export function environmentTransitions(previous, current) {
  const events = [];
  const before = previous && typeof previous === 'object' ? previous : {};
  if (before.season && before.season !== current.calendar.season) events.push({
    eventType: 'season_changed', eventKey: `season:${current.calendar.year}:${current.calendar.season}`,
    title: `${current.calendar.season[0].toUpperCase()}${current.calendar.season.slice(1)} begins`,
    detail: `Year ${current.calendar.year}: days run ${current.calendar.sunrise}–${current.calendar.sunset}.`
  });
  if (before.condition !== current.weather.condition && (NOTABLE_WEATHER.has(current.weather.condition)
      || NOTABLE_WEATHER.has(before.condition))) events.push({
    eventType: 'weather_changed', eventKey: `weather:${current.weather.block}`,
    title: NOTABLE_WEATHER.has(current.weather.condition) ? `${current.weather.label} arrives`
      : `${before.condition ? `${before.condition[0].toUpperCase()}${before.condition.slice(1)}` : 'Weather'} clears`,
    detail: `${current.weather.label}, ${current.weather.temperatureC}°C on ${current.calendar.weekday} ${current.calendar.time}.`
  });
  return events;
}

export function environmentSnapshot(environment) {
  return { season: environment.calendar.season, year: environment.calendar.year, day: environment.calendar.day,
    condition: environment.weather.condition, temperatureC: environment.weather.temperatureC,
    block: environment.weather.block };
}

export function locationLabel(location, residentsById = new Map()) {
  if (!isHomeLocation(location)) return location || null;
  const owner = residentsById.get(location.slice(HOME_PREFIX.length));
  return owner?.name ? `${owner.name}'s home` : 'Home';
}

// Additive fields for the localhost map snapshot. Existing fields are untouched.
export function enrichMapEnvironment({ worldSeed, worldMinutes, scenes = [], residents = [], events = [] }) {
  const environment = worldEnvironment(worldSeed, worldMinutes);
  const { calendar, weather } = environment;
  for (const scene of scenes) {
    const schedule = placeSchedule(scene, calendar, weather);
    const capacity = Math.max(1, finite(scene.capacity, 8));
    Object.assign(scene, { openNow: schedule.open, opensAt: schedule.opensAt, closesAt: schedule.closesAt,
      closedReason: schedule.reason, openingHours: schedule.hours || null, exposure: schedule.exposure ?? 0,
      indoor: (schedule.exposure ?? 0) === 0, crowding: round(finite(scene.residentCount) / capacity),
      resolvedPosition: placePosition(scene) });
  }
  const residentsById = new Map(residents.map((resident) => [resident.id, resident]));
  for (const resident of residents) {
    const sleep = sleepState(resident.id, calendar.minuteOfDay);
    const homeKey = homeLocation(resident.id);
    Object.assign(resident, {
      chronotype: sleep.chronotype, sleepWindow: sleep.sleepWindow, inSleepWindow: sleep.inWindow,
      asleep: resident.currentStatus === 'performing' && resident.activityVariant === 'sleep',
      atHome: isHomeLocation(resident.location),
      home: { location: homeKey, label: locationLabel(homeKey, residentsById), position: placePosition(homeKey) },
      locationLabel: locationLabel(resident.location, residentsById),
      targetLocationLabel: resident.targetLocation ? locationLabel(resident.targetLocation, residentsById) : null
    });
  }
  for (const event of events) if (isHomeLocation(event.place)) event.placeLabel = locationLabel(event.place, residentsById);
  return { ...environment, forecast: weatherForecast(worldSeed, worldMinutes, 4) };
}

// Feasibility for strategic/initiative candidates: walking to a place that is
// closed (hours, storm, inactive) or will close within 45 minutes is infeasible.
// Candidates acted on where the resident already is, at home, at Exchange, or at
// a location that is not a scene are unaffected.
export function destinationFeasible(candidate, agent, scenes, environment) {
  if (!environment?.calendar || !candidate?.targetLocation || candidate.targetLocation === agent.location) return true;
  const scene = (scenes || []).find((item) => item.name === candidate.targetLocation);
  if (!scene) return true;
  const schedule = placeSchedule(scene, environment.calendar, environment.weather);
  return schedule.open && (schedule.minutesUntilClose === null || schedule.minutesUntilClose >= 45);
}

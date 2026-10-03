import { createHash } from 'node:crypto';
import { chargeMeal, MEAL_COST_UNITS, canAffordUnits } from './economy.js';
import { formatUnits, multiplyUnits, parsePositiveUnits, parseSignedUnits } from './crypto-market.js';
import { ensureCryptoAccount, executeCryptoTrade } from './crypto-trading.js';

export const WORLD_TICK_MS = 1_000;
const TYPE_SAFE_INTERVAL_MS = 30 * 60_000;
const MAX_CATCH_UP_SECONDS = 30;
const ACTION_SECONDS = Object.freeze({ work: 16, learn: 11, rest: 9, eat: 8, socialize: 12, trade: 7 });
const GOALS = Object.freeze(['wealth','learn','community','wellbeing','balanced','wealth','learn','community','wellbeing','balanced']);
const RISK_TOLERANCE = Object.freeze([0.78,0.28,0.52,0.22,0.68,0.35,0.82,0.47,0.70,0.40]);
const ALLOWED_GOALS = new Set(['wealth','learn','community','wellbeing','balanced']);
const FINITE_STAT_KEYS = ['energy','food','social','happiness','knowledge'];

function stableInt(input) {
  return createHash('sha256').update(String(input)).digest().readUInt32BE(0);
}

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export function clamp(value, min = 0, max = 100) {
  return Math.max(min, Math.min(max, finite(value, min)));
}

export function initialWorldAgentProfile(slot) {
  const index = Math.max(0, Math.trunc(finite(slot, 0))) % GOALS.length;
  return { goal: GOALS[index], riskTolerance: RISK_TOLERANCE[index], happiness: 60, knowledge: 20 };
}

export function movementProgress(startedAt, endsAt, now = Date.now()) {
  const start = new Date(startedAt).getTime();
  const end = new Date(endsAt).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return 1;
  return clamp((now - start) / (end - start), 0, 1);
}

function priceTrend(asset, quotes, previous) {
  const quote = quotes.find((item) => item.symbol === asset);
  const before = finite(previous?.[asset]);
  const current = finite(quote?.priceUsd);
  return before > 0 && current > 0 ? (current - before) / before : 0;
}

function sceneOptions(scenes, types) {
  return scenes.filter((scene) => scene.status === 'active' && types.includes(scene.sceneType));
}

function candidate({ id, action, place, goal, description = goal, score, plannedPaidMeal = false, side, asset, quoteUnits }) {
  return { id, action, targetLocation: place, goal, description, score, plannedPaidMeal, side: side || null,
    asset: asset || null, quoteUnits: quoteUnits || null };
}

export function buildActivityCandidates(agent, scenes, context = {}) {
  const options = [];
  const energy = clamp(agent.energy), food = clamp(agent.food), social = clamp(agent.social);
  const happiness = clamp(agent.happiness), knowledge = clamp(agent.knowledge);
  const goal = ALLOWED_GOALS.has(agent.goal) ? agent.goal : 'balanced';
  const units = String(agent.internalUnits ?? '0');
  const cash = finite(agent.usdc);
  const btc = finite(agent.btc), eth = finite(agent.eth);
  const btcQuote = finite(context.quotes?.find((item) => item.symbol === 'BTC')?.priceUsd);
  const ethQuote = finite(context.quotes?.find((item) => item.symbol === 'ETH')?.priceUsd);
  const nav = cash + btc * btcQuote + eth * ethQuote;
  const recentTradeMs = agent.lastTradeAt ? Date.now() - new Date(agent.lastTradeAt).getTime() : Infinity;
  const canTrade = finite(agent.riskTolerance) >= 0.65 && ['wealth','balanced'].includes(goal) &&
    recentTradeMs >= 180_000 && cash >= 75 && nav > 0;

  const workshops = sceneOptions(scenes, ['workshop']);
  const dataCenters = sceneOptions(scenes, ['data_center']);
  const libraries = sceneOptions(scenes, ['library']);
  const observatories = sceneOptions(scenes, ['observatory']);
  const gardens = sceneOptions(scenes, ['garden']);
  const cafes = sceneOptions(scenes, ['cafe']);

  for (const place of [...workshops, ...dataCenters]) {
    const dataCenter = place.sceneType === 'data_center';
    const score = 28 + (goal === 'wealth' ? 22 : 0) + (cash < 7_500 ? 18 : cash < 9_500 ? 8 : 0) +
      (dataCenter && goal === 'learn' ? 8 : 0) + (dataCenter ? finite(agent.traits?.craft) * 3 : 0);
    options.push(candidate({ id: `work:${place.id}`, action: 'work', place: place.name,
      goal: dataCenter ? 'Complete a paid data-center shift and learn from its operations.' : 'Complete a paid workshop shift and contribute to the local economy.', score }));
  }
  for (const place of [...libraries, ...observatories]) {
    const observatory = place.sceneType === 'observatory';
    const score = 23 + (goal === 'learn' ? 27 : 0) + Math.max(0, 82 - knowledge) * 0.72 +
      finite(agent.traits?.curiosity) * 8 + (observatory ? 4 : 0);
    options.push(candidate({ id: `learn:${place.id}`, action: 'learn', place: place.name,
      goal: observatory ? 'Study current observations and record useful knowledge.' : 'Study in the library and deepen knowledge.', score }));
  }
  for (const place of gardens) {
    options.push(candidate({ id: `rest:${place.id}`, action: 'rest', place: place.name,
      goal: 'Rest in the garden and restore energy and mood.',
      score: 24 + (goal === 'wellbeing' ? 20 : 0) + Math.max(0, 88 - energy) * 0.68 + Math.max(0, 82 - happiness) * 0.34 }));
    options.push(candidate({ id: `eat:${place.id}`, action: 'eat', place: place.name,
      goal: 'Take a simple break to restore food and energy.', score: 18 + Math.max(0, 75 - food) * 0.73 }));
  }
  for (const place of cafes) {
    const paid = canAffordUnits(units, MEAL_COST_UNITS);
    options.push(candidate({ id: `eat:${place.id}`, action: 'eat', place: place.name, plannedPaidMeal: paid,
      goal: paid ? 'Have a hearty meal at the cafe using internal world units.' : 'Take a simple meal break at the cafe.',
      score: 17 + Math.max(0, 86 - food) * 0.78 + (paid ? 4 : 0) + (goal === 'community' ? 3 : 0) }));
    options.push(candidate({ id: `socialize:${place.id}`, action: 'socialize', place: place.name,
      goal: 'Meet other residents at the cafe and build social connection.',
      score: 22 + (goal === 'community' ? 24 : 0) + Math.max(0, 90 - social) * 0.58 +
        finite(context.residentsAt?.[place.name]) * 2 + finite(agent.traits?.sociability) * 5 }));
  }

  if (canTrade) {
    const risk = finite(agent.riskTolerance);
    for (const [asset, balance, price] of [['BTC', btc, btcQuote], ['ETH', eth, ethQuote]]) {
      if (!(price > 0)) continue;
      const holdingValue = balance * price;
      const momentum = priceTrend(asset, context.quotes || [], context.previousQuotes || {});
      const buyAllowed = cash >= 75 && holdingValue + 50 <= nav * 0.5 && momentum >= -0.008;
      if (buyAllowed) options.push(candidate({ id: `trade:buy:${asset}`, action: 'trade', place: 'Exchange', side: 'buy', asset,
        quoteUnits: '50.00000000', goal: `Review the simulated ${asset} market at Exchange and buy a bounded amount if risk remains acceptable.`,
        score: 34 + risk * 28 + (goal === 'wealth' ? 12 : 0) + Math.max(-5, Math.min(7, momentum * 1000)) }));
      if (holdingValue >= 20 && momentum < 0.002) {
        const notional = Math.min(holdingValue * 0.1, nav * 0.1, 50);
        if (notional >= 10) options.push(candidate({ id: `trade:sell:${asset}`, action: 'trade', place: 'Exchange', side: 'sell', asset,
          quoteUnits: notional.toFixed(8), goal: `Trim a small ${asset} position at Exchange while keeping the order within risk limits.`,
          score: 30 + risk * 20 + Math.max(-3, Math.min(12, -momentum * 1000)) }));
      }
    }
  }

  if (!options.length && scenes.length) {
    const place = scenes.find((scene) => scene.status === 'active') || scenes[0];
    options.push(candidate({ id: `rest:${place.id}`, action: 'rest', place: place.name,
      goal: 'Pause and recover before choosing a new project.', score: 1 }));
  }
  for (const option of options) {
    option.score += (stableInt(`${agent.agentId}:${context.tick || 0}:${option.id}`) % 1000) / 100;
  }
  return options.sort((left, right) => right.score - left.score);
}

export function chooseActivity(agent, scenes, context = {}) {
  return buildActivityCandidates(agent, scenes, context)[0] || null;
}

function actionId(agentId, tick, stage) {
  return `world:${tick}:${agentId}:${stage}`;
}

function safeJson(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value;
}

async function recordWorldEvent(client, worldId, agentId, tick, type, data) {
  await client.query(`INSERT INTO world_events(world_id,actor_id,event_type,data,action_id)
    VALUES($1,$2,$3,$4,$5) ON CONFLICT(world_id,actor_id,action_id) DO NOTHING`,
  [worldId, agentId, type, data, actionId(agentId, tick, type.split('.').at(-1))]);
}

async function setMindGoal(client, worldId, agentId, goal, action, summary) {
  const prior = await client.query('SELECT archetype,traits,memories FROM agent_minds WHERE world_id=$1 AND agent_id=$2 FOR UPDATE', [worldId, agentId]);
  const row = prior.rows[0];
  const memories = Array.isArray(row?.memories) ? row.memories : [];
  if (summary) memories.push({ kind: action, summary, at: new Date().toISOString() });
  await client.query(`INSERT INTO agent_minds(world_id,agent_id,archetype,traits,current_goal,memories,actions_taken)
    VALUES($1,$2,$3,$4,$5,$6,$7)
    ON CONFLICT(world_id,agent_id) DO UPDATE SET current_goal=EXCLUDED.current_goal,
      memories=EXCLUDED.memories,actions_taken=agent_minds.actions_taken+$7,updated_at=now()`,
  [worldId, agentId, row?.archetype || 'observer', JSON.stringify(row?.traits || { curiosity: 0.6, sociability: 0.5, craft: 0.5 }),
    String(goal).slice(0, 160), JSON.stringify(memories.slice(-24)), summary ? 1 : 0]);
}

async function adjustUsdc(client, worldId, agentId, amount, type, referenceId, reason) {
  const currentResult = await client.query(`SELECT balance::text AS balance FROM crypto_balances
    WHERE world_id=$1 AND agent_id=$2 AND asset_symbol='USDC' FOR UPDATE`, [worldId, agentId]);
  const before = parsePositiveUnits(currentResult.rows[0]?.balance || '0', { allowZero: true });
  const after = before + parseSignedUnits(amount);
  if (after < 0n) throw Object.assign(new Error('SIMULATED_USDC_BALANCE_TOO_LOW'), { statusCode: 409 });
  await client.query(`INSERT INTO crypto_balances(world_id,agent_id,asset_symbol,balance)
    VALUES($1,$2,'USDC',$3) ON CONFLICT(world_id,agent_id,asset_symbol)
    DO UPDATE SET balance=EXCLUDED.balance,updated_at=now()`, [worldId, agentId, formatUnits(after)]);
  await client.query(`INSERT INTO crypto_ledger(world_id,agent_id,asset_symbol,amount,entry_type,reference_id,reason)
    VALUES($1,$2,'USDC',$3,$4,$5,$6) ON CONFLICT(world_id,agent_id,asset_symbol,reference_id) DO NOTHING`,
  [worldId, agentId, amount, type, referenceId, reason]);
  return formatUnits(after);
}

function incrementStat(value, delta) { return Math.trunc(clamp(finite(value) + delta)); }

function updatedNeeds(agent, deltas) {
  return Object.fromEntries(FINITE_STAT_KEYS.map((key) => [key, incrementStat(agent[key], finite(deltas[key]))]));
}

async function completeActivity(client, worldId, agent, runtime, quotes, now) {
  const activity = agent.planned_action;
  const place = agent.location;
  const profile = `${agent.agentId}:${runtime.tick_count}:${activity}`;
  let needs = { energy: 0, food: 0, social: 0, happiness: 0, knowledge: 0 };
  let result = { action: activity, place };
  if (activity === 'work') {
    const dataCenter = agent.scene_type === 'data_center';
    const amount = 20 + (stableInt(`${profile}:wage`) % (dataCenter ? 71 : 61));
    await adjustUsdc(client, worldId, agent.agentId, `${amount}.00000000`, 'work_income',
      `${actionId(agent.agentId, runtime.tick_count, 'work_income')}:USDC`, dataCenter ? 'simulated data center wages' : 'simulated workshop wages');
    needs = { energy: -8, food: -6, social: -2, happiness: 2, knowledge: dataCenter ? 3 : 1 };
    result.income = { amount: `${amount}.00000000`, asset: 'USDC', simulated: true };
  } else if (activity === 'learn') {
    needs = { energy: -5, food: -2, social: 0, happiness: agent.scene_type === 'observatory' ? 3 : 1,
      knowledge: 6 + stableInt(`${profile}:study`) % 9 };
    result.learning = { knowledge: needs.knowledge };
  } else if (activity === 'rest') {
    needs = { energy: 24, food: -1, social: 0, happiness: 5, knowledge: 0 };
  } else if (activity === 'eat') {
    if (agent.planned_paid_meal) {
      try {
        const meal = await chargeMeal(client, { worldId, agentId: agent.agentId, actionId: actionId(agent.agentId, runtime.tick_count, 'meal') });
        needs = { energy: 15, food: 70, social: 2, happiness: 4, knowledge: 0 };
        result.meal = { spentUnits: meal.spentUnits, balanceUnits: meal.balanceUnits };
      } catch (error) {
        if (error.message !== 'INSUFFICIENT_INTERNAL_UNITS') throw error;
        needs = { energy: 10, food: 45, social: 3, happiness: 2, knowledge: 0 };
        result.meal = { free: true, reason: 'internal_units_unavailable' };
      }
    } else needs = { energy: 10, food: 45, social: 3, happiness: 2, knowledge: 0 };
  } else if (activity === 'socialize') {
    const nearby = await client.query(`SELECT count(*)::int AS count FROM world_members
      WHERE world_id=$1 AND location=$2 AND agent_id<>$3`, [worldId, place, agent.agentId]);
    const count = Math.min(3, finite(nearby.rows[0]?.count));
    needs = { energy: -2, food: -1, social: 18 + count * 2, happiness: 4 + count * 2, knowledge: count ? 1 : 0 };
    result.residentsNearby = count;
  } else if (activity === 'trade') {
    const quote = quotes.find((item) => item.symbol === agent.planned_asset);
    if (place !== 'Exchange' || !quote || !agent.planned_side || !agent.planned_quote_units) {
      result.abandoned = 'exchange_or_quote_unavailable';
    } else {
      const trade = await executeCryptoTrade(client, { worldId, agentId: agent.agentId,
        actionId: actionId(agent.agentId, runtime.tick_count, 'trade'), side: agent.planned_side,
        asset: agent.planned_asset, quoteUnits: String(agent.planned_quote_units), quote: { ...quote, all: quotes } });
      result.trade = { id: trade.orderId, side: trade.side, asset: trade.asset, quantity: trade.quantity,
        priceUsd: trade.executionPriceUsd, notionalUsd: trade.notionalUsd, feeUsdc: trade.feeUsdc, simulated: true };
      await recordWorldEvent(client, worldId, agent.agentId, runtime.tick_count, 'crypto.trade_filled',
        { ...result.trade, action: 'trade', place, timestamp: now.toISOString() });
      await client.query(`UPDATE world_agent_states SET last_trade_at=$3 WHERE world_id=$1 AND agent_id=$2`,
        [worldId, agent.agentId, now]);
      needs.energy = -1;
    }
  }

  const next = updatedNeeds(agent, needs);
  result.energy = next.energy;
  result.food = next.food;
  result.social = next.social;
  await client.query(`UPDATE world_members SET energy=$3,food=$4,social=$5 WHERE world_id=$1 AND agent_id=$2`,
    [worldId, agent.agentId, next.energy, next.food, next.social]);
  await client.query(`UPDATE world_agent_states SET happiness=$3,knowledge=$4,status='idle',planned_action=NULL,
      target_location=NULL,planned_side=NULL,planned_asset=NULL,planned_quote_units=NULL,planned_paid_meal=false,
      fruitfly_observation='{}'::jsonb,fruitfly_candidates='[]'::jsonb,fruitfly_selected='{}'::jsonb,
      movement_started_at=NULL,movement_ends_at=NULL,action_started_at=NULL,action_ends_at=NULL,
      next_decision_at=$5,updated_at=$6 WHERE world_id=$1 AND agent_id=$2`,
  [worldId, agent.agentId, next.happiness, next.knowledge, new Date(now.getTime() + 5_000 + stableInt(`${profile}:think`) % 11_000), now]);
  const summary = activity === 'work' ? `Completed a paid shift at ${place}.`
    : activity === 'learn' ? `Studied at ${place} and gained knowledge.`
      : activity === 'rest' ? `Rested at ${place}.`
        : activity === 'eat' ? `Ate at ${place}.`
          : activity === 'socialize' ? `Socialized at ${place}.`
            : result.trade ? `Completed a simulated ${result.trade.side} of ${result.trade.asset} at Exchange.` : 'Skipped an unavailable simulated trade.';
  await setMindGoal(client, worldId, agent.agentId, agent.current_goal || agent.goal, activity, summary);
  await recordWorldEvent(client, worldId, agent.agentId, runtime.tick_count, 'world.action_completed', {
    ...result, needs: next, status: 'completed', worldMinutes: finite(runtime.world_minutes)
  });
  const observation = safeJson(agent.fruitfly_observation);
  const candidates = Array.isArray(agent.fruitfly_candidates) ? agent.fruitfly_candidates : [];
  const selected = safeJson(agent.fruitfly_selected);
  return observation.self && candidates.length && selected.id
    ? { agentId: agent.agentId, observation, candidates, selected, result }
    : null;
}

function marketSnapshot(quotes) {
  return Object.fromEntries(quotes.filter((quote) => ['BTC','ETH'].includes(quote.symbol))
    .map((quote) => [quote.symbol, String(quote.priceUsd)]));
}

function publicWorldClock(row, running = true) {
  const worldMinutes = Number(row.world_minutes);
  const minuteOfDay = worldMinutes % 1_440;
  return {
    running,
    tickCount: Number(row.tick_count),
    worldMinutes,
    day: Math.floor(worldMinutes / 1_440) + 1,
    hour: Math.floor(minuteOfDay / 60),
    minute: minuteOfDay % 60,
    lastTickAt: row.last_tick_at
  };
}

async function ensureAgentRows(pool, worldId) {
  const members = await pool.query(`SELECT m.agent_id FROM world_members m
    WHERE m.world_id=$1 ORDER BY m.joined_at,m.agent_id`, [worldId]);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const [index, member] of members.rows.entries()) {
      const profile = initialWorldAgentProfile(index);
      await client.query(`INSERT INTO world_agent_states(world_id,agent_id,goal,risk_tolerance,happiness,knowledge,next_decision_at)
        VALUES($1,$2,$3,$4,$5,$6,now()+($7::text || ' seconds')::interval) ON CONFLICT(world_id,agent_id) DO NOTHING`,
      [worldId, member.agent_id, profile.goal, profile.riskTolerance, profile.happiness, profile.knowledge, String(3 + index * 3)]);
      await ensureCryptoAccount(client, { worldId, agentId: member.agent_id });
    }
    await client.query(`INSERT INTO world_runtime_state(world_id,tick_count,world_minutes,last_tick_at,market_snapshot,typesafe_next_at)
      VALUES($1,0,480,now(),'{}'::jsonb,now()) ON CONFLICT(world_id) DO NOTHING`, [worldId]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

async function readEngineSnapshot(pool, worldId) {
  const [world, members, scenes, quotes] = await Promise.all([
    pool.query('SELECT name FROM worlds WHERE id=$1', [worldId]),
    pool.query(`SELECT a.id AS "agentId",a.name,am.archetype,am.traits,am.current_goal AS "currentGoal",am.actions_taken AS "actionsTaken",
        m.energy,m.food,m.social,m.location,s.goal,s.risk_tolerance AS "riskTolerance",s.happiness,s.knowledge,
        coalesce((SELECT balance::text FROM crypto_balances b WHERE b.world_id=m.world_id AND b.agent_id=m.agent_id AND b.asset_symbol='USDC'),'0') AS usdc,
        coalesce((SELECT balance::text FROM crypto_balances b WHERE b.world_id=m.world_id AND b.agent_id=m.agent_id AND b.asset_symbol='BTC'),'0') AS btc,
        coalesce((SELECT balance::text FROM crypto_balances b WHERE b.world_id=m.world_id AND b.agent_id=m.agent_id AND b.asset_symbol='ETH'),'0') AS eth
      FROM world_members m JOIN agents a ON a.id=m.agent_id JOIN world_agent_states s ON s.world_id=m.world_id AND s.agent_id=m.agent_id
      LEFT JOIN agent_minds am ON am.world_id=m.world_id AND am.agent_id=m.agent_id
      WHERE m.world_id=$1 ORDER BY m.joined_at,a.name`, [worldId]),
    pool.query(`SELECT id,name,scene_type AS "sceneType",status FROM world_scenes WHERE world_id=$1 ORDER BY created_at,id`, [worldId]),
    pool.query(`SELECT symbol,price_usd::text AS "priceUsd",quote_version AS "quoteVersion",as_of AS "asOf",source
      FROM crypto_market_quotes ORDER BY symbol`)
  ]);
  const runtime = (await pool.query('SELECT tick_count,world_minutes,last_tick_at,market_snapshot,typesafe_next_at FROM world_runtime_state WHERE world_id=$1', [worldId])).rows[0];
  return { name: world.rows[0]?.name || 'Synterra', members: members.rows, scenes: scenes.rows, quotes: quotes.rows, runtime };
}

async function runStrategicTypeSafe(pool, worldId, chooseWithTypeSafe, runtimeState) {
  const snapshot = await readEngineSnapshot(pool, worldId);
  if (!snapshot.members.length) return null;
  const index = stableInt(`${worldId}:${snapshot.runtime.tick_count}:typesafe`) % snapshot.members.length;
  const resident = snapshot.members[index];
  const goalCandidates = [
    { id: 'wealth', action: 'work', goal: 'Prioritize sustainable simulated income and bounded Exchange participation.', description: 'Build simulated savings through paid work; only trade at Exchange with existing risk limits.' },
    { id: 'learn', action: 'learn', goal: 'Prioritize study, observation, and growing useful knowledge.', description: 'Spend more time learning in the library or observatory.' },
    { id: 'community', action: 'socialize', goal: 'Prioritize helpful social connection with nearby residents.', description: 'Spend more time meeting residents in shared places.' },
    { id: 'wellbeing', action: 'rest', goal: 'Prioritize energy, food, and a steady mood.', description: 'Prefer rest and simple care when needs are low.' },
    { id: 'balanced', action: 'travel', goal: 'Balance paid work, learning, health, and social needs.', description: 'Keep a varied routine based on current needs.' }
  ];
  const traits = safeJson(resident.traits);
  const observation = {
    self: { agentId: resident.agentId, energy: resident.energy, food: resident.food, social: resident.social,
      location: resident.location, internalTokenUnits: '0' },
    members: snapshot.members.map((member) => ({ id: member.agentId, name: member.name, location: member.location })),
    scenes: snapshot.scenes,
    mind: { archetype: resident.archetype || 'observer', traits, currentGoal: resident.currentGoal,
      actionsTaken: resident.actionsTaken, memories: [] },
    market: { quotes: snapshot.quotes },
    trading: { balances: { USDC: resident.usdc, BTC: resident.btc, ETH: resident.eth }, positions: [],
      netAssetValueUsd: resident.usdc, risk: { simulatedOnly: true } }
  };
  const selection = await chooseWithTypeSafe(observation, goalCandidates, runtimeState, []);
  const selectedGoal = selection.decision?.id;
  if (!ALLOWED_GOALS.has(selectedGoal)) return { reason: selection.reason || 'fallback', resident: resident.name };
  const result = await pool.query(`UPDATE world_agent_states SET goal=$3,updated_at=now()
    WHERE world_id=$1 AND agent_id=$2 RETURNING goal`, [worldId, resident.agentId, selectedGoal]);
  if (!result.rowCount) return { reason: 'resident_state_missing', resident: resident.name };
  const selectedDescription = goalCandidates.find((item) => item.id === selectedGoal).goal;
  await pool.query(`UPDATE agent_minds SET current_goal=$3,updated_at=now() WHERE world_id=$1 AND agent_id=$2`,
    [worldId, resident.agentId, selectedDescription]);
  await pool.query(`INSERT INTO world_events(world_id,actor_id,event_type,data,action_id)
    VALUES($1,$2,'world.goal_updated',$3,$4) ON CONFLICT(world_id,actor_id,action_id) DO NOTHING`,
  [worldId, resident.agentId, { goal: selectedGoal, decisionSource: 'typesafe', simulated: true },
    actionId(resident.agentId, snapshot.runtime.tick_count, 'goal_updated')]);
  return { reason: 'selected', resident: resident.name, goal: selectedGoal,
    model: selection.model || null, costUsd: selection.costUsd ?? null };
}

export async function startWorldEngine(pool, { onError = () => {}, onStatus = () => {}, chooseWithTypeSafe = null,
  runtimeState = null, fruitfly = null, tickMs = WORLD_TICK_MS } = {}) {
  const worldResult = await pool.query(`SELECT w.id FROM worlds w WHERE w.open=true
    ORDER BY w.created_at DESC LIMIT 1`);
  if (!worldResult.rowCount) return { running: false, reason: 'no_open_world', stop: async () => {} };
  const worldId = worldResult.rows[0].id;
  await ensureAgentRows(pool, worldId);

  const lockClient = await pool.connect();
  const lock = await lockClient.query(`SELECT pg_try_advisory_lock(hashtextextended('synterra-world-engine',0)) AS acquired`);
  if (!lock.rows[0].acquired) {
    lockClient.release();
    onStatus({ running: false, reason: 'another_server_owns_world_loop' });
    return { running: false, reason: 'another_server_owns_world_loop', stop: async () => {} };
  }

  let stopped = false;
  let tickInProgress = false;
  let activeTick = null;
  let typeSafeTask = null;
  let fruitflyTask = null;
  let nextTypeSafeAt = 0;
  let typeSafeInProgress = false;
  let errorCount = 0;
  let nextRetryAt = 0;
  let lastErrorLoggedAt = 0;
  let suppressedErrors = 0;

  async function tick() {
    if (stopped || tickInProgress || Date.now() < nextRetryAt) return;
    tickInProgress = true;
    let shouldAskTypeSafe = false;
    const fruitflyOutcomes = [];
    try {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const clockResult = await client.query(`SELECT tick_count,world_minutes,last_tick_at,typesafe_next_at,market_snapshot
          FROM world_runtime_state WHERE world_id=$1 FOR UPDATE`, [worldId]);
        if (!clockResult.rowCount) throw new Error('WORLD_RUNTIME_STATE_MISSING');
        const clock = clockResult.rows[0];
        const now = new Date();
        const previousAt = new Date(clock.last_tick_at).getTime();
        const elapsed = Math.max(1, Math.min(MAX_CATCH_UP_SECONDS,
          Math.floor((now.getTime() - (Number.isFinite(previousAt) ? previousAt : now.getTime())) / 1_000)));
        const tickCount = Number(clock.tick_count) + elapsed;
        const worldMinutes = Number(clock.world_minutes) + elapsed;
        const oldHour = Math.floor(Number(clock.world_minutes) / 60);
        const newHour = Math.floor(worldMinutes / 60);
        const decayHours = Math.min(24, Math.max(0, newHour - oldHour));
        await client.query(`UPDATE world_runtime_state SET tick_count=$2,world_minutes=$3,last_tick_at=$4,updated_at=$4
          WHERE world_id=$1`, [worldId, tickCount, worldMinutes, now]);
        const quoteResult = await client.query(`SELECT symbol,price_usd::text AS "priceUsd",quote_version AS "quoteVersion",as_of AS "asOf",source
          FROM crypto_market_quotes ORDER BY symbol`);
        const quotes = quoteResult.rows.map((quote) => ({ ...quote, quoteVersion: Number(quote.quoteVersion) }));
        const priorSnapshot = safeJson(clock.market_snapshot);
        const nextSnapshot = marketSnapshot(quotes);
        const typeSafeDueAt = new Date(clock.typesafe_next_at).getTime();
        shouldAskTypeSafe = Boolean(chooseWithTypeSafe && !typeSafeInProgress && Date.now() >= typeSafeDueAt &&
          Date.now() >= nextTypeSafeAt);
        if (shouldAskTypeSafe) {
          typeSafeInProgress = true;
          nextTypeSafeAt = Date.now() + TYPE_SAFE_INTERVAL_MS;
          await client.query(`UPDATE world_runtime_state SET typesafe_next_at=$2 WHERE world_id=$1`,
            [worldId, new Date(nextTypeSafeAt)]);
        }
        await client.query(`UPDATE world_runtime_state SET market_snapshot=$2::jsonb WHERE world_id=$1`, [worldId, JSON.stringify(nextSnapshot)]);
        if (decayHours > 0) {
          await client.query(`UPDATE world_members SET energy=greatest(0,energy-$2),food=greatest(0,food-$3),social=greatest(0,social-$4)
            WHERE world_id=$1`, [worldId, decayHours, decayHours * 2, decayHours]);
          await client.query(`UPDATE world_agent_states SET happiness=greatest(0,happiness-$2),updated_at=$3
            WHERE world_id=$1`, [worldId, decayHours, now]);
        }
        const membersResult = await client.query(`SELECT m.world_id,m.agent_id,a.name,m.energy,m.food,m.social,m.location,
            am.archetype,am.traits,am.memories,am.current_goal,am.actions_taken,
            s.goal,s.risk_tolerance AS risk_tolerance,s.happiness,s.knowledge,s.status,s.planned_action,s.target_location,
            s.planned_side,s.planned_asset,s.planned_quote_units::text AS planned_quote_units,s.planned_paid_meal,
            s.fruitfly_observation,s.fruitfly_candidates,s.fruitfly_selected,
            s.movement_started_at,s.movement_ends_at,s.action_started_at,s.action_ends_at,s.next_decision_at,s.last_trade_at,
            coalesce((SELECT balance::text FROM crypto_balances b WHERE b.world_id=m.world_id AND b.agent_id=m.agent_id AND b.asset_symbol='USDC'),'0') AS usdc,
            coalesce((SELECT balance::text FROM crypto_balances b WHERE b.world_id=m.world_id AND b.agent_id=m.agent_id AND b.asset_symbol='BTC'),'0') AS btc,
            coalesce((SELECT balance::text FROM crypto_balances b WHERE b.world_id=m.world_id AND b.agent_id=m.agent_id AND b.asset_symbol='ETH'),'0') AS eth,
            coalesce((SELECT sum(amount)::text FROM token_ledger l WHERE l.world_id=m.world_id AND l.agent_id=m.agent_id),'0') AS internal_units
          FROM world_members m JOIN agents a ON a.id=m.agent_id
          JOIN world_agent_states s ON s.world_id=m.world_id AND s.agent_id=m.agent_id
          LEFT JOIN agent_minds am ON am.world_id=m.world_id AND am.agent_id=m.agent_id
          WHERE m.world_id=$1 ORDER BY m.joined_at,a.name FOR UPDATE OF m,s`, [worldId]);
        const scenesResult = await client.query(`SELECT id,name,scene_type AS "sceneType",status FROM world_scenes
          WHERE world_id=$1 ORDER BY created_at,id`, [worldId]);
        const scenes = scenesResult.rows;
        const placeCounts = Object.fromEntries(membersResult.rows.map((member) => [member.location,
          membersResult.rows.filter((other) => other.location === member.location).length - 1]));

        for (const row of membersResult.rows) {
          const agent = { ...row, agentId: row.agent_id, riskTolerance: finite(row.risk_tolerance),
            lastTradeAt: row.last_trade_at, planned_paid_meal: row.planned_paid_meal };
          if (agent.status === 'walking' && new Date(agent.movement_ends_at).getTime() <= now.getTime()) {
            const destination = agent.target_location;
            await client.query('UPDATE world_members SET location=$3 WHERE world_id=$1 AND agent_id=$2', [worldId, agent.agentId, destination]);
            const duration = ACTION_SECONDS[agent.planned_action] || 10;
            await client.query(`UPDATE world_agent_states SET status='performing',movement_started_at=NULL,movement_ends_at=NULL,
                action_started_at=$3,action_ends_at=$4,updated_at=$3 WHERE world_id=$1 AND agent_id=$2`,
            [worldId, agent.agentId, now, new Date(now.getTime() + duration * 1_000)]);
            await recordWorldEvent(client, worldId, agent.agentId, tickCount, 'world.agent_arrived',
              { place: destination, action: agent.planned_action, worldMinutes, at: now.toISOString() });
            await recordWorldEvent(client, worldId, agent.agentId, tickCount, 'world.action_started',
              { place: destination, action: agent.planned_action, worldMinutes, at: now.toISOString() });
            await setMindGoal(client, worldId, agent.agentId, agent.current_goal || agent.goal, agent.planned_action, null);
          } else if (agent.status === 'performing' && new Date(agent.action_ends_at).getTime() <= now.getTime()) {
            const placeResult = scenes.find((scene) => scene.name === agent.location);
            const learning = await completeActivity(client, worldId, { ...agent, scene_type: placeResult?.sceneType || null },
              { tick_count: tickCount, world_minutes: worldMinutes }, quotes, now);
            if (learning) fruitflyOutcomes.push(learning);
          } else if (agent.status === 'idle' && new Date(agent.next_decision_at).getTime() <= now.getTime()) {
            const candidates = buildActivityCandidates(agent, scenes, { tick: tickCount, quotes,
              previousQuotes: priorSnapshot, residentsAt: placeCounts });
            let activity = candidates[0] || null;
            let flyObservation = null;
            let flyCandidates = [];
            let flySelected = null;
            if (fruitfly && candidates.length) {
              flyObservation = { self: { agentId: agent.agentId, energy: agent.energy, food: agent.food, social: agent.social },
                mind: { archetype: agent.archetype || 'observer', traits: safeJson(agent.traits),
                  actionsTaken: agent.actions_taken, memories: Array.isArray(agent.memories) ? agent.memories.slice(-24) : [] } };
              flyCandidates = candidates.map(({ id, action, targetLocation, goal, description, plannedPaidMeal,
                side, asset, quoteUnits, score }) => ({ id, action, targetLocation, goal, description, plannedPaidMeal,
                side, asset, quoteUnits, score }));
              try {
                const choice = fruitfly.choose(agent.agentId, flyObservation, flyCandidates, activity);
                if (choice?.candidate) {
                  activity = choice.candidate;
                  flySelected = choice.candidate;
                }
              } catch (error) { onError(error, 'fruitfly_choice'); }
            }
            if (!activity) {
              await client.query(`UPDATE world_agent_states SET next_decision_at=$3,updated_at=$4
                WHERE world_id=$1 AND agent_id=$2`, [worldId, agent.agentId, new Date(now.getTime() + 30_000), now]);
              continue;
            }
            const duration = ACTION_SECONDS[activity.action] || 10;
            const tradeFields = activity.action === 'trade'
              ? [activity.side, activity.asset, activity.quoteUnits] : [null, null, null];
            if (activity.targetLocation !== agent.location) {
              const travelSeconds = 6 + stableInt(`${agent.agentId}:${tickCount}:travel`) % 11;
              const movementEnd = new Date(now.getTime() + travelSeconds * 1_000);
              await client.query(`UPDATE world_agent_states SET status='walking',planned_action=$3,target_location=$4,
                  planned_side=$5,planned_asset=$6,planned_quote_units=$7,planned_paid_meal=$8,
                  fruitfly_observation=$11::jsonb,fruitfly_candidates=$12::jsonb,fruitfly_selected=$13::jsonb,
                  movement_started_at=$9,movement_ends_at=$10,action_started_at=NULL,action_ends_at=NULL,
                  updated_at=$9 WHERE world_id=$1 AND agent_id=$2`,
              [worldId, agent.agentId, activity.action, activity.targetLocation, ...tradeFields, Boolean(activity.plannedPaidMeal), now, movementEnd,
                JSON.stringify(flyObservation || {}), JSON.stringify(flyCandidates), JSON.stringify(flySelected || {})]);
              await setMindGoal(client, worldId, agent.agentId, activity.goal, activity.action,
                `Started traveling from ${agent.location} to ${activity.targetLocation}.`);
              await recordWorldEvent(client, worldId, agent.agentId, tickCount, 'world.movement_started',
                { from: agent.location, to: activity.targetLocation, place: agent.location, action: activity.action,
                  startedAt: now.toISOString(), arrivesAt: movementEnd.toISOString(), worldMinutes });
            } else {
              await client.query(`UPDATE world_agent_states SET status='performing',planned_action=$3,target_location=NULL,
                  planned_side=$4,planned_asset=$5,planned_quote_units=$6,planned_paid_meal=$7,
                  fruitfly_observation=$10::jsonb,fruitfly_candidates=$11::jsonb,fruitfly_selected=$12::jsonb,
                  movement_started_at=NULL,movement_ends_at=NULL,action_started_at=$8,action_ends_at=$9,updated_at=$8
                WHERE world_id=$1 AND agent_id=$2`,
              [worldId, agent.agentId, activity.action, ...tradeFields, Boolean(activity.plannedPaidMeal), now,
                new Date(now.getTime() + duration * 1_000), JSON.stringify(flyObservation || {}),
                JSON.stringify(flyCandidates), JSON.stringify(flySelected || {})]);
              await setMindGoal(client, worldId, agent.agentId, activity.goal, activity.action, null);
              await recordWorldEvent(client, worldId, agent.agentId, tickCount, 'world.action_started',
                { place: agent.location, action: activity.action, worldMinutes, at: now.toISOString() });
            }
          }
        }
        if (tickCount % 60 < elapsed) {
          await client.query(`DELETE FROM world_events WHERE world_id=$1 AND event_type LIKE 'world.%'
            AND id IN (SELECT id FROM world_events WHERE world_id=$1 AND event_type LIKE 'world.%'
              ORDER BY id DESC OFFSET 1_000)`, [worldId]);
        }
        await client.query('COMMIT');
        const recovered = errorCount > 0;
        errorCount = 0;
        onStatus({ running: true, worldId, tickCount, worldMinutes, residents: membersResult.rowCount,
          ...(recovered ? { recovered: true, suppressedErrors } : {}) });
        suppressedErrors = 0;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally { client.release(); }
      if (fruitfly && fruitflyOutcomes.length) {
        fruitflyTask = Promise.all(fruitflyOutcomes.map((outcome) => fruitfly.learn(outcome.agentId,
          outcome.observation, outcome.candidates, outcome.selected, outcome.result)))
          .catch((error) => onError(error, 'fruitfly_learning'))
          .finally(() => { fruitflyTask = null; });
      }
      if (shouldAskTypeSafe && chooseWithTypeSafe && runtimeState) {
        typeSafeTask = runStrategicTypeSafe(pool, worldId, chooseWithTypeSafe, runtimeState)
          .then((result) => { if (result?.reason === 'selected') onStatus({ running: true, typeSafe: result }); })
          .catch((error) => onError(error, 'typesafe_selection'))
          .finally(() => { typeSafeInProgress = false; typeSafeTask = null; });
      }
    } catch (error) {
      errorCount += 1;
      nextRetryAt = Date.now() + Math.min(30_000, 1_000 * 2 ** Math.min(errorCount, 5));
      if (Date.now() - lastErrorLoggedAt >= 60_000) {
        lastErrorLoggedAt = Date.now();
        onError(error, 'tick');
      } else suppressedErrors += 1;
    } finally { tickInProgress = false; }
  }

  const timer = setInterval(() => {
    if (activeTick || stopped) return;
    activeTick = tick().finally(() => { activeTick = null; });
  }, Math.max(250, Math.trunc(finite(tickMs, WORLD_TICK_MS))));
  timer.unref?.();
  await tick();
  onStatus({ running: true, worldId, tickMs });

  return {
    running: true,
    worldId,
    async stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      if (activeTick) await activeTick;
      if (typeSafeTask) await typeSafeTask;
      if (fruitflyTask) await fruitflyTask;
      try { await lockClient.query(`SELECT pg_advisory_unlock(hashtextextended('synterra-world-engine',0))`); }
      finally { lockClient.release(); }
    }
  };
}

export async function worldClock(pool, worldId, running = true) {
  const result = await pool.query(`SELECT tick_count,world_minutes,last_tick_at FROM world_runtime_state WHERE world_id=$1`, [worldId]);
  return result.rowCount ? publicWorldClock(result.rows[0], running) : null;
}

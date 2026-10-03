import test from 'node:test';
import assert from 'node:assert/strict';
import { buildActivityCandidates, chooseActivity, clamp, initialWorldAgentProfile, movementProgress } from '../src/world-engine.js';

const scenes = [
  { id: 'garden', name: 'Garden', sceneType: 'garden', status: 'active' },
  { id: 'workshop', name: 'Workshop', sceneType: 'workshop', status: 'active' },
  { id: 'library', name: 'Library', sceneType: 'library', status: 'active' },
  { id: 'cafe', name: 'Cafe', sceneType: 'cafe', status: 'active' },
  { id: 'observatory', name: 'Observatory', sceneType: 'observatory', status: 'active' },
  { id: 'data-center', name: 'Data Center', sceneType: 'data_center', status: 'active' },
  { id: 'generated-studio', name: 'Resident Workshop Annex', sceneType: 'studio', status: 'active' },
  { id: 'generated-commons', name: 'Open Commons', sceneType: 'commons', status: 'active' }
];

function agent(overrides = {}) {
  return {
    agentId: 'resident-01', goal: 'balanced', riskTolerance: 0.3, energy: 80, food: 80, social: 70,
    happiness: 60, knowledge: 20, internalUnits: '0', usdc: '10000', btc: '0', eth: '0', traits: {},
    ...overrides
  };
}

test('initial profiles are bounded and differentiated', () => {
  const profiles = Array.from({ length: 10 }, (_, index) => initialWorldAgentProfile(index));
  assert.equal(new Set(profiles.map((profile) => profile.goal)).size, 5);
  assert.ok(profiles.every((profile) => profile.riskTolerance >= 0 && profile.riskTolerance <= 1));
  assert.deepEqual(initialWorldAgentProfile(10), initialWorldAgentProfile(0));
});

test('urgent low energy selects restorative activity', () => {
  const chosen = chooseActivity(agent({ goal: 'wellbeing', energy: 10, happiness: 30 }), scenes, { tick: 3 });
  assert.equal(chosen.action, 'rest');
  assert.equal(chosen.targetLocation, 'Garden');
});

test('low food can choose a meal paid from internal units', () => {
  const chosen = chooseActivity(agent({ goal: 'community', food: 8, internalUnits: '4', energy: 90 }), scenes, { tick: 9 });
  assert.equal(chosen.action, 'eat');
  assert.equal(chosen.targetLocation, 'Cafe');
  assert.equal(chosen.plannedPaidMeal, true);
});

test('utility decision offers bounded BTC/ETH orders only for a market-capable resident', () => {
  const quotes = [
    { symbol: 'BTC', priceUsd: '64000.00000000' },
    { symbol: 'ETH', priceUsd: '3200.00000000' }
  ];
  const trader = agent({ goal: 'wealth', riskTolerance: 0.78, energy: 90, food: 90,
    lastTradeAt: null, usdc: '10000', btc: '0', eth: '0' });
  const candidates = buildActivityCandidates(trader, scenes, { tick: 11, quotes, previousQuotes: { BTC: '63900', ETH: '3190' } });
  const order = candidates.find((item) => item.action === 'trade');
  assert.ok(order);
  assert.equal(order.targetLocation, 'Exchange');
  assert.equal(order.side, 'buy');
  assert.ok(Number(order.quoteUnits) <= 50);
  const nonTrader = buildActivityCandidates(agent({ goal: 'learn', riskTolerance: 0.2 }), scenes, { tick: 11, quotes });
  assert.equal(nonTrader.some((item) => item.action === 'trade'), false);
});

test('resident-created studio and commons are valid destinations for autonomous activities', () => {
  const work = buildActivityCandidates(agent({ energy: 80, food: 80 }), scenes, { tick: 13 })
    .find((item) => item.action === 'work' && item.targetLocation === 'Resident Workshop Annex');
  assert.ok(work, 'generated studio can receive a work action and walk-in destination');
  const social = buildActivityCandidates(agent({ status: 'idle', energy: 80, food: 80, social: 10 }), scenes, {
    tick: 14, worldMinutes: 200, residentsAtLocation: { 'Open Commons': [
      { agentId: 'resident-02', name: 'Resident 02', status: 'idle', energy: 80, food: 80, social: 50 }
    ] }
  }).find((item) => item.action === 'socialize' && item.targetLocation === 'Open Commons');
  assert.ok(social, 'generated commons can receive a social action and walk-in destination');
});

test('state values and movement interpolation stay finite and bounded', () => {
  assert.equal(clamp(Number.NaN), 0);
  assert.equal(clamp(Infinity), 0);
  assert.equal(clamp(120), 100);
  assert.equal(movementProgress('bad timestamp', 'also bad', 0), 1);
  assert.equal(movementProgress(1000, 3000, 2000), 0.5);
});

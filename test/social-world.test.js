import test from 'node:test';
import assert from 'node:assert/strict';
import { buildActivityCandidates } from '../src/world-engine.js';
import {
  DECISION_MIX, SOCIAL_COOLDOWN_WORLD_MINUTES, addSkillGain, canCooperatePair, canSocializePair,
  chooseMixedCandidate, clampPersonality, clampRelationship, clampSkill, deriveDominantRole,
  effectivePersonality, goalActionUtility, goalProgress, initialSkillValues, initialSocialProfile,
  lastRealizedSalePnl, memoryForCompletedAction, mixedDecisionDistribution, qualifyUtilityCandidates, recentMemoryUtility,
  qualifyLayeredStrategicCandidates, fruitflyFamily, reflectionDue, reflectionProposal, seededGoalSet,
  skillGainForAction, socialCooldownReady, updateRelationship
} from '../src/social-world.js';

const scenes = [
  { id: 'garden', name: 'Garden', sceneType: 'garden', status: 'active' },
  { id: 'workshop', name: 'Workshop', sceneType: 'workshop', status: 'active' },
  { id: 'library', name: 'Library', sceneType: 'library', status: 'active' },
  { id: 'cafe', name: 'Cafe', sceneType: 'cafe', status: 'active' },
  { id: 'observatory', name: 'Observatory', sceneType: 'observatory', status: 'active' },
  { id: 'data-center', name: 'Data Center', sceneType: 'data_center', status: 'active' }
];

function agent(overrides = {}) {
  return { agentId: 'resident-01', status: 'idle', goal: 'balanced', primaryGoal: 'BALANCED_LIFE', riskTolerance: 0.8,
    sociability: 0.5, curiosity: 0.5, discipline: 0.5, ambition: 0.5,
    energy: 80, food: 80, social: 70, happiness: 60, knowledge: 20, internalUnits: '0', usdc: '10000',
    btc: '0', eth: '0', skills: { trading: 10, research: 10, engineering: 10, social: 10 }, relationships: [],
    recentMemories: [], ...overrides };
}

test('social personality and skills are stable, bounded and differentiated across residents', () => {
  const profiles = Array.from({ length: 10 }, (_, slot) => initialSocialProfile(`resident-${slot}`, slot));
  const skills = Array.from({ length: 10 }, (_, slot) => initialSkillValues(`resident-${slot}`, slot));
  assert.deepEqual(profiles[3], initialSocialProfile('resident-3', 3));
  assert.equal(new Set(profiles.map((profile) => profile.primaryGoal)).size, 6);
  for (const profile of profiles) {
    for (const key of ['sociability', 'curiosity', 'discipline', 'ambition']) assert.ok(profile[key] >= 0 && profile[key] <= 1);
    assert.ok(profile.priceSensitivity >= 0.2 && profile.priceSensitivity <= 0.85);
  }
  assert.ok(new Set(profiles.map((profile) => profile.priceSensitivity)).size > 5);
  assert.ok(new Set(skills.map((profile) => JSON.stringify(profile))).size > 8);
  assert.ok(skills.every((profile) => Object.values(profile).every((value) => value >= 0 && value <= 100)));
});

test('all social state clamps handle malformed and out-of-range values', () => {
  assert.equal(clampPersonality(Number.NaN), 0.5);
  assert.equal(clampPersonality(4), 1);
  assert.equal(clampSkill(Infinity), 0);
  assert.equal(addSkillGain(99.9, 1), 100);
  assert.equal(clampRelationship(-150), -100);
  assert.equal(clampRelationship(150, 0, 100), 100);
});

test('skills grow only for mapped completed actions and growth per action is small', () => {
  assert.deepEqual(skillGainForAction('work', 'Data Center'), { engineering: 0.35, research: 0.2 });
  assert.deepEqual(skillGainForAction('trade', 'Exchange'), { trading: 0.45 });
  assert.deepEqual(skillGainForAction('socialize', 'Cafe', false), {});
  assert.deepEqual(skillGainForAction('socialize', 'Cafe', true), { social: 0.5 });
  assert.equal(addSkillGain(20, 0.5), 20.5);
  assert.equal(addSkillGain(100, 0.5), 100);
});

test('memories describe only completed actions with observed results', () => {
  const work = memoryForCompletedAction({ action: 'work', place: 'Workshop', result: { income: { amount: '63.00000000' } } });
  assert.match(work.summary, /earned 63\.00000000 simulated USDC/);
  assert.equal(work.memoryType, 'work');
  const trade = memoryForCompletedAction({ action: 'trade', place: 'Exchange', result: { trade: {
    side: 'sell', asset: 'BTC', notionalUsd: '49', priceUsd: '60000', feeUsdc: '0.05', realizedPnlUsd: -3
  } } });
  assert.equal(trade.memoryType, 'failure');
  assert.equal(trade.importance, 0.76);
  assert.equal(memoryForCompletedAction({ action: 'trade', place: 'Exchange', result: { abandoned: 'quote_missing' } }), null);
  assert.equal(memoryForCompletedAction({ action: 'socialize', place: 'Cafe', result: {} }), null);
  assert.equal(memoryForCompletedAction({ action: 'work', place: 'Workshop', result: {} }), null);
});

test('average-cost realized sale PnL uses simulated fills and fees', () => {
  const pnl = lastRealizedSalePnl([
    { side: 'buy', quantity: '2', notionalUsd: '200', feeUsdc: '1' },
    { side: 'buy', quantity: '2', notionalUsd: '240', feeUsdc: '1' },
    { side: 'sell', quantity: '1', notionalUsd: '125', feeUsdc: '1' }
  ]);
  assert.equal(pnl, 13.5);
  assert.equal(lastRealizedSalePnl([]), null);
});

test('relationships are symmetric single-pair values with bounded deltas', () => {
  assert.deepEqual(updateRelationship({ familiarity: 98, trust: 99, affinity: -99, interactionCount: 2 },
    { familiarity: 8, trust: 5, affinity: -5, interactionCount: 1 }),
  { familiarity: 100, trust: 100, affinity: -100, interactionCount: 3 });
  assert.equal(updateRelationship({ familiarity: 20 }, { familiarity: 8 }).familiarity, 28);
});

test('social interactions require a co-located available resident and active cafe or garden', () => {
  const actor = { agentId: 'a', status: 'idle', location: 'Cafe' };
  const partner = { agentId: 'b', status: 'idle', location: 'Cafe', lastInteractionWorldMinutes: null };
  const cafe = { name: 'Cafe', sceneType: 'cafe', status: 'active' };
  assert.equal(canSocializePair({ actor, partner, scene: cafe, worldMinutes: 100 }), true);
  assert.equal(canSocializePair({ actor, partner: { ...partner, status: 'walking' }, scene: cafe, worldMinutes: 100 }), false);
  assert.equal(canSocializePair({ actor, partner: { ...partner, location: 'Garden' }, scene: cafe, worldMinutes: 100 }), false);
  assert.equal(canSocializePair({ actor, partner, scene: { ...cafe, status: 'closed' }, worldMinutes: 100 }), false);
  assert.equal(canSocializePair({ actor, partner, scene: { ...cafe, sceneType: 'workshop' }, worldMinutes: 100 }), false);
});

test('cooperative work requires a real meeting at an active workplace and prior trust', () => {
  const scene = { name: 'Workshop', sceneType: 'workshop', status: 'active' };
  const actor = { agentId: 'a', status: 'idle', location: 'Workshop' };
  const partner = { agentId: 'b', status: 'idle', location: 'Workshop', relationship: { familiarity: 20, trust: 5 } };
  assert.equal(canCooperatePair({ actor, partner, scene, worldMinutes: 100 }), true);
  assert.equal(canCooperatePair({ actor, partner: { ...partner, relationship: { familiarity: 14, trust: 4 } }, scene, worldMinutes: 100 }), false);
  assert.equal(canCooperatePair({ actor, partner: { ...partner, location: 'Data Center' }, scene, worldMinutes: 100 }), false);
  assert.equal(canCooperatePair({ actor, partner: { ...partner, status: 'walking' }, scene, worldMinutes: 100 }), false);
  assert.deepEqual(skillGainForAction('cooperate', 'Workshop', true), { engineering: 0.45 });
});

test('social cooldown blocks a pair until 45 world minutes pass', () => {
  assert.equal(SOCIAL_COOLDOWN_WORLD_MINUTES, 45);
  assert.equal(socialCooldownReady(100, 144), false);
  assert.equal(socialCooldownReady(100, 145), true);
  assert.equal(socialCooldownReady(null, 100), true);
});

test('stable goals and personality change real Utility scores', () => {
  const common = { tick: 22, worldMinutes: 500, residentsAtLocation: { Cafe: [{ agentId: 'friend', name: 'Synterra-02', status: 'idle' }] } };
  const person = agent({ agentId: 'utility-person', location: 'Cafe', riskTolerance: 0.2 });
  const baseline = buildActivityCandidates(person, scenes, common);
  const engineer = buildActivityCandidates({ ...person, primaryGoal: 'MASTER_ENGINEERING', discipline: 0.9,
    ambition: 0.9, skills: { ...person.skills, engineering: 70 } }, scenes, common);
  const goalOnly = buildActivityCandidates({ ...person, primaryGoal: 'MASTER_ENGINEERING' }, scenes, common);
  const skillOnly = buildActivityCandidates({ ...person, skills: { ...person.skills, engineering: 70 } }, scenes, common);
  const personalityOnly = buildActivityCandidates({ ...person, discipline: 0.95, ambition: 0.95 }, scenes, common);
  const baselineWork = baseline.find((candidate) => candidate.action === 'work' && candidate.targetLocation === 'Workshop');
  const engineerWork = engineer.find((candidate) => candidate.action === 'work' && candidate.targetLocation === 'Workshop');
  const score = (candidates) => candidates.find((candidate) => candidate.action === 'work'
    && candidate.targetLocation === 'Workshop').score;
  assert.ok(engineerWork.score > baselineWork.score + 20);
  assert.ok(score(goalOnly) > score(baseline));
  assert.ok(score(skillOnly) > score(baseline));
  assert.ok(score(personalityOnly) > score(baseline));
  assert.ok(baseline.some((candidate) => candidate.action === 'socialize'));
});

test('sociability and relationship familiarity alter social Utility', () => {
  const socialContext = { tick: 4, worldMinutes: 100,
    residentsAtLocation: { Cafe: [{ agentId: 'resident-02', name: 'Synterra-02', status: 'idle' }] } };
  const low = buildActivityCandidates(agent({ agentId: 'resident-01', location: 'Cafe', sociability: 0.1 }), scenes, socialContext)
    .find((candidate) => candidate.action === 'socialize');
  const unfamiliarCandidates = buildActivityCandidates(agent({ agentId: 'resident-01', location: 'Cafe', sociability: 0.7 }), scenes, socialContext);
  const familiarCandidates = buildActivityCandidates(agent({ agentId: 'resident-01', location: 'Cafe', sociability: 0.7,
    relationships: [{ otherAgentId: 'resident-02', familiarity: 80, affinity: 30, lastInteractionWorldMinutes: 0 }] }), scenes, socialContext)
  const unfamiliar = unfamiliarCandidates.find((candidate) => candidate.action === 'socialize');
  const known = familiarCandidates.find((candidate) => candidate.action === 'socialize');
  assert.ok(known.score > low.score + 10);
  assert.ok(known.score > unfamiliar.score);
  assert.equal(buildActivityCandidates(agent({ location: 'Cafe' }), scenes, { tick: 4, worldMinutes: 100 })
    .some((candidate) => candidate.action === 'socialize'), false);
});

test('recent simulated trading loss reduces Exchange utility temporarily', () => {
  const context = { tick: 11, worldMinutes: 1_000, nowMs: Date.now(),
    quotes: [{ symbol: 'BTC', priceUsd: '64000' }, { symbol: 'ETH', priceUsd: '3200' }], previousQuotes: {} };
  const trader = agent({ agentId: 'trader', goal: 'wealth', primaryGoal: 'MASTER_TRADING', lastTradeAt: null });
  const before = buildActivityCandidates(trader, scenes, context).find((candidate) => candidate.action === 'trade');
  const after = buildActivityCandidates({ ...trader, recentMemories: [{ memoryType: 'failure', worldMinutes: 900,
    metadata: { asset: 'BTC', realizedPnlUsd: -40 } }] }, scenes, context).find((candidate) => candidate.action === 'trade');
  assert.ok(before);
  assert.ok(after.score < before.score);
  assert.equal(recentMemoryUtility({ recentMemories: [{ memoryType: 'failure', worldMinutes: 200,
    metadata: { asset: 'BTC', realizedPnlUsd: -40 } }] }, 'trade', 1_000), 0);
  const learningMemory = [{ memoryType: 'learning', worldMinutes: 1_000, metadata: { action: 'learn' } }];
  assert.equal(recentMemoryUtility({ recentMemories: learningMemory, decisionPolicy: { memoryEmphasis: 0 } }, 'learn', 1_000), 1);
  assert.equal(recentMemoryUtility({ recentMemories: learningMemory, decisionPolicy: { memoryEmphasis: 1 } }, 'learn', 1_000), 3);
});

test('personal history changes Utility eligibility instead of weighting Fruitfly choice', () => {
  const historyEvidence = [
    { id: 'work', action: 'work', score: 100 },
    { id: 'learn', action: 'learn', score: 90 },
    { id: 'socialize', action: 'socialize', score: 80 },
    { id: 'trade', action: 'trade', score: 78 },
    { id: 'rest', action: 'rest', score: 70 }
  ];
  const afterLoss = historyEvidence.map((candidate) => candidate.id === 'trade'
    ? { ...candidate, score: 50 } : candidate);
  const beforeEligible = qualifyUtilityCandidates(historyEvidence);
  const afterEligible = qualifyUtilityCandidates(afterLoss);
  assert.ok(beforeEligible.some((candidate) => candidate.id === 'trade'));
  assert.ok(!afterEligible.some((candidate) => candidate.id === 'trade'));
});

test('strategic Top-K reserves distinct Fruitfly families so repeated production cannot crowd out hiring', () => {
  const candidates = [
    ...Array.from({ length: 7 }, (_, index) => ({ id: `production-${index}`, action: 'business_work', score: 100 - index })),
    { id: 'meal-service', action: 'business_service', serviceType: 'food_service', score: 94 },
    { id: 'new-business', action: 'business_found', score: 82 },
    { id: 'job-application', action: 'business_apply', score: 78 },
    { id: 'price-review', action: 'business_price', score: 63 },
    { id: 'project-proposal', action: 'project_propose', score: 90 },
    { id: 'project-join', action: 'project_join', score: 68 },
    { id: 'low-value', action: 'goal_review', score: 20 }
  ];
  const eligible = qualifyLayeredStrategicCandidates(candidates);
  assert.equal(fruitflyFamily('business_work'), 'work');
  assert.equal(fruitflyFamily('business_apply'), 'job');
  assert.equal(fruitflyFamily({ action: 'business_service', serviceType: 'research_service' }), 'travel');
  assert.ok(eligible.some((candidate) => candidate.id === 'job-application'));
  assert.ok(eligible.some((candidate) => candidate.id === 'production-0'));
  assert.ok(eligible.length > 1 && eligible.length <= 8);
  assert.ok(eligible.filter((candidate) => candidate.action === 'business_work').length > 1,
    'near-best offers from a qualified family should remain available to Fruitfly');
});

test('high-effort actions lose eligibility when needs are critically low', () => {
  const candidates = buildActivityCandidates(agent({ energy: 8, food: 5 }), scenes, {
    tick: 2, worldMinutes: 200, quotes: [{ symbol: 'BTC', priceUsd: '64000' }, { symbol: 'ETH', priceUsd: '3200' }]
  });
  assert.equal(candidates.some((candidate) => ['work','learn','trade','socialize'].includes(candidate.action)), false);
  assert.ok(candidates.some((candidate) => candidate.action === 'rest' || candidate.action === 'eat'));
});

test('history Utility and Fruitfly probabilities mix without removing feasible action families', () => {
  const candidates = [
    { action: 'work', id: 'work', score: 100 }, { action: 'learn', id: 'learn', score: 80 },
    { action: 'socialize', id: 'social', score: -100 }, { action: 'trade', id: 'trade-buy', score: 60 },
    { action: 'trade', id: 'trade-sell', score: 55 }, { action: 'eat', id: 'eat', score: 10 }
  ];
  const fruitfly = { work: 0.25, travel: 0.25, socialize: 0.1, trade_crypto: 0.2, eat: 0.2 };
  const distribution = mixedDecisionDistribution(candidates, fruitfly);
  assert.deepEqual(distribution.families.map((candidate) => candidate.action).sort(), ['eat', 'learn', 'socialize', 'trade', 'work']);
  assert.equal(Object.keys(distribution.probabilities).length, 5);
  assert.ok(Math.abs(Object.values(distribution.probabilities).reduce((sum, value) => sum + value, 0) - 1) < 1e-12);
  assert.ok(Object.values(distribution.probabilities).every((probability) => probability > 0));
  assert.deepEqual(DECISION_MIX, { fruitfly: 0.65, utility: 0.30, exploration: 0.05, utilityTemperature: 18 });
  const picked = chooseMixedCandidate(candidates, fruitfly, { actionDraw: 0.999999, candidateDraw: 0.5 });
  assert.equal(picked.action, 'work');
  assert.ok(picked.behaviorProbability > 0);
  assert.ok(picked.fruitflyProbability > 0);
});

test('goals and reflections use experience, create next steps and keep personality bounded', () => {
  const seeded = seededGoalSet('resident', 0);
  assert.equal(seeded.primary.category, 'BUILD_WEALTH');
  assert.equal(seeded.short.length, 1);
  assert.ok(goalActionUtility({ action: 'work', targetLocation: 'Workshop' }, [seeded.primary]) > 0);
  const proposal = reflectionProposal({
    profile: { riskModifier: 0, personalityModifiers: { sociability: 0, curiosity: 0, discipline: 0, ambition: 0 } },
    memories: [
      { memoryType: 'failure', metadata: { realizedPnlUsd: -25 } },
      { memoryType: 'failure', metadata: { realizedPnlUsd: -12 } },
      { memoryType: 'failure', metadata: { realizedPnlUsd: -8 } }
    ],
    skills: { research: 52, engineering: 15 }, needs: { energy: 80, food: 80, social: 70 }, worldMinutes: 700
  });
  assert.equal(proposal.nextGoal.category, 'RECOVER_FINANCIAL_STABILITY');
  assert.equal(proposal.riskModifier, -0.01);
  assert.equal(proposal.modifiers.discipline, 0.01);
  const capped = reflectionProposal({ profile: { riskModifier: -0.15, personalityModifiers: { sociability: 0.15 } },
    memories: [{ memoryType: 'social' }, { memoryType: 'social' }, { memoryType: 'failure', metadata: { realizedPnlUsd: -1 } }],
    skills: {}, needs: {}, worldMinutes: 800 });
  assert.equal(capped.modifiers.sociability, 0.15);
  assert.equal(capped.riskModifier, -0.15);
  assert.equal(effectivePersonality({ sociability: 0.9, personalityModifiers: { sociability: 0.15 } }).sociability, 1);
});

test('reflection cadence and important-event cooldown are bounded in world time', () => {
  assert.equal(reflectionDue({ worldMinutes: 359, lastReflectionWorldMinutes: 0 }), false);
  assert.equal(reflectionDue({ worldMinutes: 360, lastReflectionWorldMinutes: 0 }), true);
  assert.equal(reflectionDue({ worldMinutes: 59, lastReflectionWorldMinutes: 0, important: true }), false);
  assert.equal(reflectionDue({ worldMinutes: 60, lastReflectionWorldMinutes: 0, important: true }), true);
});

test('goal progress stays bounded and advances milestone stages from durable metrics', () => {
  const result = goalProgress('BUILD_RELATIONSHIPS', { relationships: [{ familiarity: 100, interactionCount: 12 }] });
  assert.ok(result.progress >= 0 && result.progress <= 100);
  assert.ok(result.milestones >= 1);
  assert.equal(goalProgress('MASTER_RESEARCH', { skills: { research: 50 }, skillActions: { research: 20 } }, 1).milestones, 2);
});

test('a short-term goal raises the Utility score for its concrete next step', () => {
  const context = { tick: 38, worldMinutes: 2_000 };
  const resident = agent({ agentId: 'short-goal-plan' });
  const baseline = buildActivityCandidates(resident, scenes, context);
  const planned = buildActivityCandidates({ ...resident, goals: [
    { goalType: 'short', category: 'PRACTICE_ENGINEERING', priority: 1, status: 'active' }
  ] }, scenes, context);
  const workScore = (candidates) => candidates.find((candidate) => candidate.action === 'work'
    && candidate.targetLocation === 'Data Center').score;
  assert.ok(workScore(planned) > workScore(baseline));
});

test('profession role follows persistent skills and goal without locking a resident', () => {
  assert.equal(deriveDominantRole({ trading: 12, research: 12, engineering: 12, social: 12 }, 'BALANCED_LIFE'), 'generalist');
  assert.equal(deriveDominantRole({ trading: 90, research: 12, engineering: 12, social: 12 }, 'MASTER_TRADING'), 'trader');
  assert.equal(deriveDominantRole({ trading: 12, research: 20, engineering: 25, social: 12 }, 'MASTER_ENGINEERING'), 'engineer');
});

test('a resident remembers another resident only after an actual social interaction result', () => {
  const memory = memoryForCompletedAction({ action: 'socialize', place: 'Cafe', result: {
    socialInteraction: { partnerId: 'resident-02', partnerName: 'Synterra-02', relationship: { familiarity: 8 } }
  } });
  assert.equal(memory.relatedAgentId, 'resident-02');
  assert.match(memory.summary, /Met Synterra-02 at Cafe/);
});

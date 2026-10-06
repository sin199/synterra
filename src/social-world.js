import { createHash } from 'node:crypto';

export const PERSONALITY_FIELDS = Object.freeze(['sociability', 'curiosity', 'discipline', 'ambition']);
export const SOCIAL_GOALS = Object.freeze([
  'BUILD_WEALTH', 'MASTER_TRADING', 'MASTER_RESEARCH', 'MASTER_ENGINEERING', 'BUILD_RELATIONSHIPS', 'BALANCED_LIFE'
]);
export const SOCIAL_SKILLS = Object.freeze(['trading', 'research', 'engineering', 'social']);
export const SOCIAL_ROLES = Object.freeze(['researcher', 'engineer', 'trader', 'worker', 'socialite', 'generalist']);
export const SOCIAL_COOLDOWN_WORLD_MINUTES = 45;
export const DECISION_MIX = Object.freeze({ fruitfly: 0.65, utility: 0.30, exploration: 0.05, utilityTemperature: 18 });
// Utility determines candidate eligibility only; Fruitfly remains responsible for the final choice.
export const UTILITY_CANDIDATE_POLICY = Object.freeze({ thresholdRatio: 0.75, minimum: 3, maximum: 8 });
export const LAYERED_STRATEGIC_CANDIDATE_POLICY = Object.freeze({
  thresholdRatio: 0.75, minimumPerLayer: 2, maximumPerLayer: 4, maximumTotal: 8
});
export const REFLECTION_CADENCE_WORLD_MINUTES = 360;
export const IMPORTANT_REFLECTION_COOLDOWN_WORLD_MINUTES = 60;
export const ADAPTIVE_PERSONALITY_LIMIT = 0.15;
export const ADAPTIVE_PERSONALITY_STEP = 0.01;
export const GOAL_LIMITS = Object.freeze({ primary: 1, secondary: 3, short: 3 });

const GOAL_SKILL = Object.freeze({
  MASTER_TRADING: 'trading', MASTER_RESEARCH: 'research', MASTER_ENGINEERING: 'engineering', BUILD_RELATIONSHIPS: 'social'
});

function stableUnit(value, salt) {
  return createHash('sha256').update(`${value}:${salt}`).digest().readUInt32BE(0) / 0x1_0000_0000;
}

export function clampFinite(value, min, max, fallback = min) {
  const number = Number(value);
  return Math.max(min, Math.min(max, Number.isFinite(number) ? number : fallback));
}

export function clampPersonality(value) { return Math.round(clampFinite(value, 0, 1, 0.5) * 1000) / 1000; }
export function clampSkill(value) { return Math.round(clampFinite(value, 0, 100, 0) * 100) / 100; }
export function clampRelationship(value, min = -100, max = 100) {
  return Math.round(clampFinite(value, min, max, 0) * 100) / 100;
}

export function initialSocialProfile(agentId, slot = 0) {
  const personality = Object.fromEntries(PERSONALITY_FIELDS.map((field) => {
    const raw = 0.18 + stableUnit(agentId, field) * 0.7;
    return [field, clampPersonality(Math.round(raw * 20) / 20)];
  }));
  const goalIndex = Math.abs(Math.trunc(Number(slot) || 0)) % SOCIAL_GOALS.length;
  return {
    ...personality,
    // Stable economic trait; it affects the quoted price, not Fruitfly's selector.
    priceSensitivity: clampPersonality(Math.round((0.2 + stableUnit(agentId, 'price-sensitivity') * 0.65) * 100) / 100),
    primaryGoal: SOCIAL_GOALS[goalIndex],
    goalProgress: 0,
    goalMilestones: 0,
    goalStartedWorldMinutes: 0,
    goalLastUpdatedWorldMinutes: null,
    lastReflectionWorldMinutes: null,
    personalityModifiers: Object.fromEntries(PERSONALITY_FIELDS.map((field) => [field, 0])),
    riskModifier: 0,
    dominantRole: 'generalist'
  };
}

export function effectivePersonality(profile = {}) {
  return Object.fromEntries(PERSONALITY_FIELDS.map((field) => [field,
    clampPersonality(clampPersonality(profile[field]) + clampFinite(profile.personalityModifiers?.[field],
      -ADAPTIVE_PERSONALITY_LIMIT, ADAPTIVE_PERSONALITY_LIMIT, 0))]));
}

export function seededGoalSet(agentId, slot = 0) {
  const profile = initialSocialProfile(agentId, slot);
  const primary = profile.primaryGoal;
  const secondary = primary === 'BUILD_WEALTH'
    ? [{ category: 'BUILD_ENGINEERING', description: 'Become more capable at useful technical work.', priority: 0.58 }]
    : primary === 'BUILD_RELATIONSHIPS'
      ? [{ category: 'GROW_SKILLS', description: 'Develop a skill that creates opportunities with others.', priority: 0.58 }]
      : [{ category: 'CARE_FOR_NEEDS', description: 'Keep energy, food and wellbeing steady while pursuing larger goals.', priority: 0.58 }];
  return {
    primary: { category: primary, description: goalDescription(primary), priority: 1 },
    secondary,
    short: [{ category: 'MAINTAIN_BALANCE', description: 'Choose a useful next step while keeping immediate needs in view.', priority: 0.45 }]
  };
}

export function goalDescription(goal) {
  const descriptions = {
    BUILD_WEALTH: 'Build durable simulated savings through work, learning and considered opportunities.',
    MASTER_TRADING: 'Develop market judgment while respecting the existing Exchange and risk rules.',
    MASTER_RESEARCH: 'Build research capability by studying, observing and applying what is learned.',
    MASTER_ENGINEERING: 'Become more capable at engineering through useful work and practice.',
    BUILD_RELATIONSHIPS: 'Build reciprocal, durable connections through real encounters and cooperation.',
    BALANCED_LIFE: 'Develop a satisfying life that balances wellbeing, capability and connection.'
  };
  return descriptions[goal] || 'Pursue a meaningful path shaped by recent experience.';
}

export function decisionFamilies(candidates) {
  const families = new Map();
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    if (!candidate || !Number.isFinite(Number(candidate.score))) continue;
    const family = fruitflyFamily(candidate);
    const current = families.get(family);
    if (!current || Number(candidate.score) > Number(current.score)) families.set(family, candidate);
  }
  return [...families.values()].sort((a, b) => fruitflyFamily(a).localeCompare(fruitflyFamily(b)));
}

export function qualifyUtilityCandidates(candidates, policy = UTILITY_CANDIDATE_POLICY) {
  const ranked = (Array.isArray(candidates) ? candidates : [])
    .filter((candidate) => candidate && Number.isFinite(Number(candidate.score)))
    .sort((left, right) => Number(right.score) - Number(left.score));
  if (ranked.length <= 1) return ranked;
  const maximum = Math.max(2, Math.trunc(Number(policy.maximum) || UTILITY_CANDIDATE_POLICY.maximum));
  const minimum = Math.min(maximum, Math.max(2, Math.trunc(Number(policy.minimum) || UTILITY_CANDIDATE_POLICY.minimum)));
  const ratio = clampFinite(policy.thresholdRatio, 0.1, 1, UTILITY_CANDIDATE_POLICY.thresholdRatio);
  const best = Number(ranked[0].score);
  const threshold = best >= 0 ? best * ratio : best - Math.abs(best) * (1 - ratio);
  const qualified = ranked.filter((candidate) => Number(candidate.score) >= threshold);
  const selected = qualified.length >= minimum ? qualified : ranked.slice(0, minimum);
  return selected.slice(0, maximum);
}

export function qualifyLayeredStrategicCandidates(candidates, policy = LAYERED_STRATEGIC_CANDIDATE_POLICY) {
  const rankedCandidates = (Array.isArray(candidates) ? candidates : [])
    .filter((candidate) => candidate && Number.isFinite(Number(candidate.score)));
  // Qualify distinct Fruitfly output families first. Otherwise repeated offers
  // from one family can consume the whole strategic Top-K and hide another
  // feasible economic path. Restore near-best offers from selected families
  // afterward so Fruitfly retains its within-family choice.
  const ranked = decisionFamilies(rankedCandidates);
  const economic = ranked.filter((candidate) => candidate.action.startsWith('business_')
    || ['project_invest','project_distribute'].includes(candidate.action)
    || (candidate.action === 'organization_contribute' && candidate.contributionType === 'capital'));
  const general = ranked.filter((candidate) => !economic.includes(candidate));
  if (!ranked.length) return [];
  const mixedLayers = economic.length > 0 && general.length > 0;
  const layerPolicy = mixedLayers ? { thresholdRatio: policy.thresholdRatio,
    minimum: policy.minimumPerLayer, maximum: policy.maximumPerLayer } : undefined;
  const selected = mixedLayers ? [...qualifyUtilityCandidates(economic, layerPolicy),
    ...qualifyUtilityCandidates(general, layerPolicy)] : qualifyUtilityCandidates(ranked);
  const maximumTotal = Math.max(2, Math.trunc(Number(policy.maximumTotal) || 8));
  let retainedFamilies = selected;
  if (retainedFamilies.length > maximumTotal) {
    const bestEconomic = selected.filter((candidate) => economic.includes(candidate))
      .sort((left, right) => Number(right.score) - Number(left.score))[0];
    const bestGeneral = selected.filter((candidate) => general.includes(candidate))
      .sort((left, right) => Number(right.score) - Number(left.score))[0];
    const reserved = [bestEconomic, bestGeneral].filter(Boolean);
    const rest = selected.filter((candidate) => !reserved.includes(candidate))
      .sort((left, right) => Number(right.score) - Number(left.score));
    retainedFamilies = [...reserved, ...rest.slice(0, maximumTotal - reserved.length)];
  }
  const ratio = clampFinite(policy.thresholdRatio, 0.1, 1, UTILITY_CANDIDATE_POLICY.thresholdRatio);
  const familyThreshold = (best) => best >= 0 ? best * ratio : best - Math.abs(best) * (1 - ratio);
  const selectedFamilyScores = new Map(retainedFamilies.map((candidate) =>
    [fruitflyFamily(candidate), Number(candidate.score)]));
  const retainedIds = new Set(retainedFamilies.map((candidate) => candidate.id));
  const alternatives = rankedCandidates.filter((candidate) => {
    const family = fruitflyFamily(candidate);
    const best = selectedFamilyScores.get(family);
    return best !== undefined && !retainedIds.has(candidate.id) && Number(candidate.score) >= familyThreshold(best);
  }).sort((left, right) => Number(right.score) - Number(left.score));
  return [...retainedFamilies, ...alternatives.slice(0, maximumTotal - retainedFamilies.length)];
}

export function softmaxUtilities(candidates, temperature = DECISION_MIX.utilityTemperature) {
  const ranked = decisionFamilies(candidates);
  if (!ranked.length) return {};
  const t = Math.max(0.1, clampFinite(temperature, 0.1, 1_000, DECISION_MIX.utilityTemperature));
  const max = Math.max(...ranked.map((item) => Number(item.score)));
  const exponentials = ranked.map((item) => Math.exp((Number(item.score) - max) / t));
  const total = exponentials.reduce((sum, value) => sum + value, 0);
  return Object.fromEntries(ranked.map((item, index) => [fruitflyFamily(item), exponentials[index] / total]));
}

export function mixedDecisionDistribution(candidates, fruitflyProbabilities = {}, config = DECISION_MIX) {
  const ranked = decisionFamilies(candidates);
  if (!ranked.length) return { families: [], probabilities: {}, components: {} };
  const actions = ranked.map((candidate) => fruitflyFamily(candidate));
  const utility = softmaxUtilities(ranked, config.utilityTemperature);
  const flyRaw = fruitflyProbabilities && typeof fruitflyProbabilities === 'object' ? fruitflyProbabilities : {};
  const flyTotal = actions.reduce((sum, action) => sum + Math.max(0, Number(flyRaw[action]) || 0), 0);
  const fly = Object.fromEntries(actions.map((action) => [action, flyTotal > 0
    ? Math.max(0, Number(flyRaw[action]) || 0) / flyTotal : 1 / actions.length]));
  const probabilities = Object.fromEntries(actions.map((action) => [action,
    config.fruitfly * fly[action] + config.utility * utility[action] + config.exploration / actions.length]));
  return { families: ranked, probabilities, components: { fruitfly: fly, utility, exploration: Object.fromEntries(actions.map((key) => [key, 1 / actions.length])) } };
}

export function chooseMixedCandidate(candidates, fruitflyProbabilities, { actionDraw = 0.5, candidateDraw = 0.5,
  config = DECISION_MIX } = {}) {
  const distribution = mixedDecisionDistribution(candidates, fruitflyProbabilities, config);
  const draw = clampFinite(actionDraw, 0, 1 - Number.EPSILON, 0.5);
  let accumulated = 0;
  let action = null;
  for (const [family, probability] of Object.entries(distribution.probabilities)) {
    accumulated += probability;
    if (draw < accumulated) { action = family; break; }
  }
  action ||= Object.keys(distribution.probabilities).at(-1) || null;
  if (!action) return { candidate: null, action: null, ...distribution };
  const options = (Array.isArray(candidates) ? candidates : []).filter((candidate) => fruitflyFamily(candidate) === action);
  const max = Math.max(...options.map((candidate) => Number(candidate.score) || 0));
  const weights = options.map((candidate) => Math.exp(((Number(candidate.score) || 0) - max) /
    Math.max(0.1, Number(config.utilityTemperature) || DECISION_MIX.utilityTemperature)));
  const total = weights.reduce((sum, value) => sum + value, 0);
  let residual = clampFinite(candidateDraw, 0, 1 - Number.EPSILON, 0.5) * total;
  let selected = options.at(-1) || null;
  for (let index = 0; index < options.length; index++) {
    residual -= weights[index];
    if (residual < 0) { selected = options[index]; break; }
  }
  return { candidate: selected, action, confidence: distribution.probabilities[action] || 0,
    behaviorProbability: distribution.probabilities[action] || 0, fruitflyProbability: distribution.components.fruitfly[action] || 0,
    utilityScores: Object.fromEntries(distribution.families.map((item) => [fruitflyFamily(item), Number(item.score)])),
    fruitflyProbabilities: distribution.components.fruitfly, utilityProbabilities: distribution.components.utility,
    distributionComponents: distribution.components,
    ...distribution };
}

export function reflectionDue({ worldMinutes, lastReflectionWorldMinutes, important = false }) {
  const now = Number(worldMinutes);
  if (!Number.isFinite(now)) return false;
  if (lastReflectionWorldMinutes === null || lastReflectionWorldMinutes === undefined) return true;
  const elapsed = now - Number(lastReflectionWorldMinutes);
  return Number.isFinite(elapsed) && elapsed >= (important ? IMPORTANT_REFLECTION_COOLDOWN_WORLD_MINUTES : REFLECTION_CADENCE_WORLD_MINUTES);
}

export function reflectionProposal({ profile = {}, memories = [], skills = {}, relationships = [], balances = {}, needs = {},
  currentGoal = null, worldMinutes = 0 }) {
  const recent = (Array.isArray(memories) ? memories : []).slice(0, 20);
  const losses = recent.filter((memory) => Number(memory.metadata?.realizedPnlUsd) < 0).length;
  const wins = recent.filter((memory) => Number(memory.metadata?.realizedPnlUsd) > 0).length;
  const workSuccesses = recent.filter((memory) => memory.memoryType === 'work' && Number(memory.metadata?.incomeUsd) > 0).length;
  const socialSuccesses = recent.filter((memory) => memory.memoryType === 'social').length;
  const modifiers = Object.fromEntries(PERSONALITY_FIELDS.map((field) => [field,
    clampFinite(profile.personalityModifiers?.[field], -ADAPTIVE_PERSONALITY_LIMIT, ADAPTIVE_PERSONALITY_LIMIT, 0)]));
  const riskModifier = clampFinite(profile.riskModifier, -ADAPTIVE_PERSONALITY_LIMIT, ADAPTIVE_PERSONALITY_LIMIT, 0);
  const nudge = (field, direction) => {
    if (!direction) return;
    modifiers[field] = clampFinite(modifiers[field] + Math.sign(direction) * ADAPTIVE_PERSONALITY_STEP,
      -ADAPTIVE_PERSONALITY_LIMIT, ADAPTIVE_PERSONALITY_LIMIT, 0);
  };
  if (socialSuccesses >= 2) nudge('sociability', 1);
  if (workSuccesses >= 2) nudge('discipline', 1);
  if (losses >= 2) nudge('discipline', 1);
  if (wins >= 2 && losses === 0) nudge('ambition', 1);
  const nextRiskModifier = clampFinite(riskModifier + (losses >= 2 ? -ADAPTIVE_PERSONALITY_STEP : wins >= 3 ? ADAPTIVE_PERSONALITY_STEP : 0),
    -ADAPTIVE_PERSONALITY_LIMIT, ADAPTIVE_PERSONALITY_LIMIT, 0);
  const rankedSkill = Object.entries(skills).sort((a, b) => Number(b[1]) - Number(a[1]));
  const bestSkill = rankedSkill[0]?.[0] || 'research';
  const weakNeed = ['energy', 'food', 'social'].sort((a, b) => Number(needs[a] ?? 50) - Number(needs[b] ?? 50))[0];
  const wealth = Number(balances.netWorthUsd) || 0;
  const bestRelation = [...relationships].sort((a, b) => Number(b.familiarity) - Number(a.familiarity))[0];
  let nextGoal = null;
  if (losses >= 3) nextGoal = { category: 'RECOVER_FINANCIAL_STABILITY', description: 'Rebuild stable simulated resources after a run of realized losses.', source: 'experience', metadata: { losses } };
  else if (weakNeed === 'energy' || weakNeed === 'food') nextGoal = { category: 'RESTORE_WELLBEING', description: 'Restore daily wellbeing, then return to longer-term pursuits.', source: 'experience', metadata: { need: weakNeed } };
  else if (bestRelation && Number(bestRelation.familiarity) >= 40 && Number(bestRelation.trust) >= 8) {
    nextGoal = { category: 'COOPERATE_WITH_RESIDENT', description: `Find a useful opportunity to work or learn with ${bestRelation.name || 'a trusted resident'}.`,
      source: 'relationship', parentGoalId: currentGoal?.id || null, metadata: { agentId: bestRelation.otherAgentId } };
  } else if (wealth >= 5_000) nextGoal = { category: 'DIVERSIFY_ACTIVITY', description: 'Use accumulated resources to broaden skills and opportunities.', source: 'experience', metadata: { wealth } };
  else nextGoal = { category: `DEVELOP_${bestSkill.toUpperCase()}`, description: `Build ${bestSkill} through actions that create durable capability.`,
    source: 'experience', metadata: { skill: bestSkill, weakNeed } };
  return { worldMinutes: Math.max(0, Math.trunc(Number(worldMinutes) || 0)), modifiers,
    riskModifier: nextRiskModifier, nextGoal, dominantRole: deriveDominantRole(skills, currentGoal?.category),
    rationale: { recentMemories: recent.length, losses, wins, workSuccesses, socialSuccesses, bestSkill, weakNeed, wealth } };
}

export function initialSkillValues(agentId, slot = 0) {
  const archetype = Math.abs(Math.trunc(Number(slot) || 0)) % 4;
  const favored = SOCIAL_SKILLS[archetype];
  return Object.fromEntries(SOCIAL_SKILLS.map((skill) => {
    const variation = Math.floor(stableUnit(agentId, `skill:${skill}`) * 10);
    return [skill, clampSkill(8 + variation + (skill === favored ? 8 : 0))];
  }));
}

export function skillGainForAction(action, place, hadPartner = false) {
  if (action === 'trade') return { trading: 0.45 };
  if (action === 'learn') return { research: 0.5 };
  if (action === 'work' || action === 'cooperate') return place === 'Data Center'
    ? { engineering: 0.35, research: 0.2 } : { engineering: 0.45 };
  if (action === 'socialize' && hadPartner) return { social: 0.5 };
  return {};
}

export function addSkillGain(value, gain) { return clampSkill(clampSkill(value) + clampFinite(gain, 0, 2, 0)); }

export function memoryForCompletedAction({ action, result = {}, place, worldMinutes }) {
  if (action === 'work' && result.income) return {
    memoryType: 'work', summary: `Worked at ${place} and earned ${result.income.amount} simulated USDC.`, importance: 0.25,
    metadata: { action, incomeUsd: Number(result.income.amount), outcome: 0.2 }
  };
  if (action === 'learn' && result.learning) return {
    memoryType: 'learning', summary: `Studied at ${place} and gained ${result.learning.knowledge} knowledge.`, importance: 0.28,
    metadata: { action, knowledge: result.learning.knowledge, outcome: 0.2 }
  };
  if (action === 'trade' && result.trade && !result.abandoned) {
    const loss = Number(result.trade.realizedPnlUsd) < 0;
    return { memoryType: loss ? 'failure' : 'trade',
      summary: `${result.trade.side === 'buy' ? 'Bought' : 'Sold'} ${result.trade.asset} for ${result.trade.notionalUsd} simulated USDC at Exchange.`,
      importance: loss ? 0.76 : 0.48,
      metadata: { action, asset: result.trade.asset, side: result.trade.side, notionalUsd: result.trade.notionalUsd,
        priceUsd: result.trade.priceUsd, feeUsdc: result.trade.feeUsdc,
        ...(Number.isFinite(result.trade.realizedPnlUsd) ? { realizedPnlUsd: result.trade.realizedPnlUsd,
          outcome: clampFinite(result.trade.realizedPnlUsd / 100, -1, 1, 0) } : {}) }
    };
  }
  if (action === 'socialize' && result.socialInteraction) return {
    memoryType: 'social', summary: `Met ${result.socialInteraction.partnerName} at ${place}.`, importance: 0.48,
    relatedAgentId: result.socialInteraction.partnerId,
    metadata: { action, outcome: 0.2, familiarity: result.socialInteraction.relationship?.familiarity,
      trust: result.socialInteraction.relationship?.trust, affinity: result.socialInteraction.relationship?.affinity }
  };
  if (action === 'cooperate' && result.cooperation) return {
    memoryType: 'cooperation', summary: `Worked with ${result.cooperation.partnerName} at ${place}; both residents contributed and earned simulated income.`,
    importance: 0.68, relatedAgentId: result.cooperation.partnerId,
    metadata: { action, outcome: 0.35, cooperationReward: result.cooperation.incomeUsd }
  };
  return null;
}

export function canonicalPair(leftId, rightId) {
  const left = String(leftId);
  const right = String(rightId);
  if (!left || !right || left === right) return null;
  return left < right ? [left, right] : [right, left];
}

export function updateRelationship(current = {}, delta = {}) {
  return {
    familiarity: clampRelationship(clampRelationship(current.familiarity, 0, 100) + clampFinite(delta.familiarity, -10, 10, 0), 0, 100),
    trust: clampRelationship(clampRelationship(current.trust) + clampFinite(delta.trust, -10, 10, 0)),
    affinity: clampRelationship(clampRelationship(current.affinity) + clampFinite(delta.affinity, -10, 10, 0)),
    interactionCount: Math.max(0, Math.trunc(clampFinite(Number(current.interactionCount || 0) + Number(delta.interactionCount || 0), 0, 2_147_483_647, 0)))
  };
}

export function socialCooldownReady(lastInteractionWorldMinutes, worldMinutes) {
  if (lastInteractionWorldMinutes === null || lastInteractionWorldMinutes === undefined) return true;
  const last = Number(lastInteractionWorldMinutes);
  const now = Number(worldMinutes);
  return Number.isFinite(last) && Number.isFinite(now) && now - last >= SOCIAL_COOLDOWN_WORLD_MINUTES;
}

export function canSocializePair({ actor, partner, scene, worldMinutes }) {
  const actorMayBePerformingSocially = actor?.status === 'idle' || (actor?.status === 'performing' && actor?.planned_action === 'socialize');
  return Boolean(actor && partner && actor.agentId !== partner.agentId && actorMayBePerformingSocially
    && partner.status === 'idle' && actor.location === partner.location && scene?.status === 'active'
    && ['cafe', 'garden', 'commons'].includes(scene.sceneType)
    && socialCooldownReady(partner.lastInteractionWorldMinutes, worldMinutes));
}

export function canCooperatePair({ actor, partner, scene, worldMinutes }) {
  if (!actor || !partner || actor.agentId === partner.agentId || actor.status !== 'idle' || partner.status !== 'idle') return false;
  if (actor.location !== partner.location || scene?.name !== actor.location || scene?.status !== 'active'
      || !['workshop', 'data_center'].includes(scene.sceneType)) return false;
  const relation = partner.relationship || {};
  return (Number(relation.familiarity) >= 15 || Number(relation.trust) >= 5)
    && socialCooldownReady(partner.lastInteractionWorldMinutes, worldMinutes);
}

function goalActionAffinity(category, action, candidate = {}, metadata = {}) {
  const key = String(category || '').toUpperCase();
  if (['BUILD_WEALTH', 'RECOVER_FINANCIAL_STABILITY'].includes(key)) return action === 'work' ? 1 : action === 'trade' ? 0.28 : 0;
  if (['MASTER_TRADING', 'DEVELOP_TRADING'].includes(key) || key.includes('TRADING')) return action === 'trade' ? 1 : action === 'learn' ? 0.18 : 0;
  if (['MASTER_RESEARCH', 'DEVELOP_RESEARCH', 'LEAD_LOCAL_RESEARCH'].includes(key) || key.includes('RESEARCH')) return action === 'learn' ? 1 : action === 'work' && candidate.targetLocation === 'Data Center' ? 0.35 : 0;
  if (['MASTER_ENGINEERING', 'DEVELOP_ENGINEERING'].includes(key) || key.includes('ENGINEERING')) return action === 'work' || action === 'cooperate' ? 1 : 0;
  if (['BUILD_RELATIONSHIPS', 'BUILD_SOCIAL_SKILL', 'GROW_SKILLS', 'COOPERATE_AND_BUILD'].includes(key) || key.includes('SOCIAL')) return action === 'socialize' || action === 'cooperate' ? 1 : 0;
  if (['RESTORE_WELLBEING', 'CARE_FOR_NEEDS', 'IMPROVE_QUALITY_OF_LIFE'].includes(key)) return action === 'rest' || action === 'eat' ? 1 : 0;
  if (key === 'RESTORE_NEEDS') return metadata.need === 'energy' ? action === 'rest' ? 1 : 0
    : metadata.need === 'food' ? action === 'eat' ? 1 : 0 : action === 'socialize' ? 1 : 0;
  if (key.startsWith('PRACTICE_')) return goalActionAffinity(key.slice('PRACTICE_'.length), action, candidate, metadata);
  if (key === 'COOPERATE_WITH_RESIDENT') return action === 'cooperate' &&
    (!metadata.agentId || metadata.agentId === candidate.socialPartnerId) ? 1 : 0;
  if (key === 'DIVERSIFY_ACTIVITY') return ['work', 'learn', 'socialize'].includes(action) ? 0.48 : 0.1;
  const wantedSkill = String(metadata.skill || key.replace(/^DEVELOP_/, '')).toLowerCase();
  if (wantedSkill === 'engineering') return action === 'work' || action === 'cooperate' ? 0.8 : 0;
  if (wantedSkill === 'research') return action === 'learn' ? 0.8 : 0;
  if (wantedSkill === 'social') return action === 'socialize' || action === 'cooperate' ? 0.8 : 0;
  if (wantedSkill === 'trading') return action === 'trade' ? 0.8 : 0;
  return 0;
}

export function goalActionUtility(candidate, goals = []) {
  return (Array.isArray(goals) ? goals : []).reduce((sum, goal) => {
    if (goal?.status && goal.status !== 'active') return sum;
    const metadata = goal?.metadata || {};
    const grammar = Array.isArray(metadata.goalGrammar) ? metadata.goalGrammar : [];
    const primitiveAffinity = grammar.reduce((best, entry) => {
      const primitive = String(entry?.primitive || '').toLowerCase();
      const action = candidate?.action;
      const affinities = {
        change_self: ['learn', 'goal_review'],
        create: ['work', 'project_propose', 'capability_use'],
        understand: ['learn', 'business_market_observe', 'capability_use'],
        connect: ['socialize', 'cooperate', 'information_share', 'project_contribute'],
        preserve: ['rest', 'eat', 'work'],
        explore: ['learn', 'travel', 'business_market_observe', 'capability_use'],
        transform: ['work', 'project_contribute', 'capability_use'],
        reduce_dependency: ['learn', 'work', 'business_market_observe'],
        increase_autonomy: ['learn', 'work', 'capability_use'],
        help_goal: ['work', 'learn', 'cooperate', 'project_contribute'],
        create_concept: ['learn', 'business_market_observe']
      }[primitive] || [];
      return Math.max(best, affinities.includes(action) ? 0.85 : 0);
    }, 0);
    const affinity = Math.max(primitiveAffinity,
      goalActionAffinity(goal?.category, candidate?.action, candidate, metadata));
    const priority = clampFinite(goal?.priority, 0, 1, goal?.goalType === 'primary' ? 1 : 0.5);
    const scale = goal.goalType === 'primary' ? 26 : goal.goalType === 'secondary' ? 11 : 8;
    return sum + affinity * priority * scale;
  }, 0);
}

export function chooseSocialPartner(agent, scene, partners, worldMinutes) {
  return (Array.isArray(partners) ? partners : [])
    .filter((partner) => canSocializePair({ actor: { ...agent, location: scene.name }, partner: { ...partner, location: scene.name }, scene, worldMinutes }))
    .sort((left, right) => {
      const leftRelation = Number(left.relationship?.familiarity || 0) + Number(left.relationship?.affinity || 0) * 0.25;
      const rightRelation = Number(right.relationship?.familiarity || 0) + Number(right.relationship?.affinity || 0) * 0.25;
      return rightRelation - leftRelation || String(left.agentId).localeCompare(String(right.agentId));
    })[0] || null;
}

export function recentMemoryUtility(agent, action, worldMinutes) {
  const memories = Array.isArray(agent.recentMemories) ? agent.recentMemories : [];
  let adjustment = 0;
  for (const memory of memories) {
    const age = Number(worldMinutes) - Number(memory.worldMinutes);
    if (!Number.isFinite(age) || age < 0 || age > 720) continue;
    const decay = Math.max(0, 1 - age / 720);
    const metadata = memory.metadata && typeof memory.metadata === 'object' ? memory.metadata : {};
    if (action === 'trade' && ['trade', 'failure'].includes(memory.memoryType) && metadata.asset
        && Number(metadata.realizedPnlUsd) < 0) {
      adjustment -= Math.min(16, 4 + Math.abs(Number(metadata.realizedPnlUsd)) * 0.15) * decay;
    } else if (action === 'trade' && ['trade', 'failure'].includes(memory.memoryType) && metadata.asset
        && Number(metadata.realizedPnlUsd) > 0) {
      adjustment += Math.min(5, Number(metadata.realizedPnlUsd) * 0.05) * decay;
    } else if (action === 'work' && memory.memoryType === 'work' && Number(metadata.incomeUsd) > 0) {
      adjustment += Math.min(4, Number(metadata.incomeUsd) * 0.025) * decay;
    } else if (action === 'learn' && memory.memoryType === 'learning') {
      adjustment += 2 * decay;
    } else if (action === 'cooperate' && ['cooperation', 'social'].includes(memory.memoryType)
        && Number(memory.metadata?.cooperationReward) > 0) {
      adjustment += 3 * decay;
    }
  }
  const memoryEmphasis = clampFinite(agent.decisionPolicy?.memoryEmphasis, 0, 1, 0.5);
  return clampFinite(adjustment * (0.5 + memoryEmphasis), -18, 8, 0);
}

export function deriveDominantRole(skills = {}, goal = 'BALANCED_LIFE') {
  const category = String(goal || '').toUpperCase();
  const goalSkill = GOAL_SKILL[category] || (category.includes('TRADING') ? 'trading'
    : category.includes('RESEARCH') ? 'research' : category.includes('ENGINEERING') ? 'engineering'
      : category.includes('SOCIAL') ? 'social' : null);
  const scores = Object.fromEntries(SOCIAL_SKILLS.map((skill) => [skill,
    clampSkill(skills[skill]) + (skill === goalSkill ? 12 : 0)]));
  const ranked = Object.entries(scores).sort((left, right) => right[1] - left[1]);
  if (ranked[0][1] - ranked.at(-1)[1] < 9 && goal === 'BALANCED_LIFE') return 'generalist';
  return ({ trading: 'trader', research: 'researcher', engineering: 'engineer', social: 'socialite' })[ranked[0][0]] || 'worker';
}

export function goalMetric(goal, state = {}) {
  const skills = state.skills || {};
  const actions = state.skillActions || {};
  const category = String(goal || '').toUpperCase();
  if (['BUILD_WEALTH', 'RECOVER_FINANCIAL_STABILITY'].includes(category)) return Math.max(0, Number(state.workIncomeUsd) || 0) / 1_000;
  if (['BUILD_RELATIONSHIPS', 'COOPERATE_WITH_RESIDENT'].includes(category)) {
    const relationships = Array.isArray(state.relationships) ? state.relationships : [];
    return relationships.reduce((sum, item) => sum + Math.max(0, Number(item.familiarity) || 0) / 100
      + Math.max(0, Number(item.interactionCount) || 0) * 0.02, 0);
  }
  const skill = GOAL_SKILL[category] || (category.includes('TRADING') ? 'trading'
    : category.includes('RESEARCH') ? 'research' : category.includes('ENGINEERING') ? 'engineering'
      : category.includes('SOCIAL') ? 'social' : null);
  if (skill) return (clampSkill(skills[skill]) + Math.max(0, Number(actions[skill]) || 0) * 0.1) / 20;
  const needs = state.needs || {};
  const balance = ['energy', 'food', 'social'].reduce((sum, key) => sum + (100 - Math.abs(clampFinite(needs[key], 0, 100, 50) - 70)), 0) / 3;
  if (['RESTORE_WELLBEING', 'CARE_FOR_NEEDS', 'IMPROVE_QUALITY_OF_LIFE'].includes(category)) return balance / 20;
  if (category === 'DIVERSIFY_ACTIVITY') return Math.min(5, new Set(state.recentActions || []).size) + Math.max(0, Number(state.completedActions) || 0) * 0.002;
  return Math.max(0, Number(state.completedActions) || 0) * 0.01;
}

export function goalProgress(goal, state = {}, previousMilestones = 0) {
  const metric = goalMetric(goal, state);
  const prior = Math.max(0, Math.trunc(Number(previousMilestones) || 0));
  const milestones = Math.max(prior, Math.floor(metric));
  const progress = clampFinite((metric - prior) * 100, 0, 100, 0);
  return { progress: Math.round(progress * 100) / 100, milestones, metric };
}

export function lastRealizedSalePnl(trades) {
  let quantity = 0;
  let costBasis = 0;
  let lastRealized = null;
  for (const trade of Array.isArray(trades) ? trades : []) {
    const tradeQuantity = Number(trade.quantity);
    const notional = Number(trade.notionalUsd);
    const fee = Number(trade.feeUsdc);
    if (!(tradeQuantity > 0) || !Number.isFinite(notional) || !Number.isFinite(fee)) continue;
    if (trade.side === 'buy') {
      quantity += tradeQuantity;
      costBasis += notional + fee;
    } else if (trade.side === 'sell') {
      const sold = Math.min(quantity, tradeQuantity);
      const averageCost = quantity > 0 ? costBasis / quantity : 0;
      lastRealized = notional - fee - averageCost * sold;
      quantity = Math.max(0, quantity - sold);
      costBasis = Math.max(0, costBasis - averageCost * sold);
    }
  }
  return Number.isFinite(lastRealized) ? Math.round(lastRealized * 1e8) / 1e8 : null;
}

export function fruitflyFamily(candidateOrAction) {
  const candidate = candidateOrAction && typeof candidateOrAction === 'object' ? candidateOrAction : {};
  const action = String(candidate.action || candidateOrAction || '');
  if (action === 'trade' || action === 'trade_meme') return 'trade_crypto';
  if (action === 'learn') return 'travel';
  if (action === 'capability_use') return 'business_learn';
  if (['business_skill_practice', 'business_market_observe'].includes(action)) return 'business_learn';
  if (['opportunity', 'opportunity_reject'].includes(action)) return 'travel';
  if (['business_invest','project_invest','project_distribute'].includes(action)) return 'invest';
  if (['business_apply','business_withdraw','business_leave','business_hire','business_reject'].includes(action)) return 'job';
  if (['agreement_propose','agreement_respond','commitment_resolve'].includes(action)) return 'business';
  if (action === 'business_service') {
    const serviceType = candidate.serviceType || candidate.service_type;
    if (serviceType === 'food_service') return 'eat';
    if (serviceType === 'social_service') return 'socialize';
    if (serviceType === 'trading_service') return 'trade_crypto';
    if (serviceType === 'engineering_service') return 'work';
    if (serviceType === 'research_service') return 'travel';
    return 'business';
  }
  if (['opportunity_propose', 'project_propose', 'project_join', 'project_reject', 'project_contribute',
    'project_leave', 'project_invest', 'project_distribute', 'place_create', 'goal_review',
    'business_found','business_price','business_distribute','business_close','business_seek_cofounder',
    'business_reopen'].includes(action)) return 'business';
  if (action === 'business_work') return 'work';
  if (['organization_found', 'organization_join', 'organization_reject', 'organization_leave',
    'organization_invite', 'organization_contribute', 'organization_propose', 'organization_vote',
    'information_share', 'information_accept',
    'information_ignore', 'information_doubt'].includes(action)) return 'socialize';
  return action;
}

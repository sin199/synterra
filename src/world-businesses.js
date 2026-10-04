import { randomUUID } from 'node:crypto';
import { formatUnits, parsePositiveUnits } from './crypto-market.js';
import { ensureEconomicAccount, getEconomicAccount, postEconomicTransfer, transferBetweenAccounts } from './economic-ledger.js';

const SERVICE_INFO = Object.freeze({
  research_service: { type: 'research', label: 'Research Notes', skill: 'research', base: '35.00000000',
    capabilities: { research: 0.8, engineering: 0.1, trading: 0.1 } },
  engineering_service: { type: 'engineering', label: 'Engineering Support', skill: 'engineering', base: '45.00000000',
    capabilities: { engineering: 0.75, research: 0.2, trading: 0.05 } },
  social_service: { type: 'social', label: 'Community Session', skill: 'social', base: '18.00000000',
    capabilities: { social: 0.65, engineering: 0.1, research: 0.1, trading: 0.15 }, network: 0.1 },
  food_service: { type: 'food', label: 'Prepared Meal', skill: 'social', base: '12.00000000',
    capabilities: { social: 0.45, engineering: 0.25, research: 0.1, trading: 0.2 }, discipline: 0.15 },
  trading_service: { type: 'market_research', label: 'Market Research Brief', skill: 'trading', base: '30.00000000',
    capabilities: { trading: 0.65, research: 0.25, engineering: 0.05, social: 0.05 }, experience: 'trade' }
});
const SERVICE_BENEFITS = Object.freeze({
  food_service: { food: 70, energy: 15, social: 4, happiness: 6 },
  social_service: { social: 28, happiness: 10, knowledge: 2 },
  engineering_service: { knowledge: 16, happiness: 4 },
  trading_service: { knowledge: 14, happiness: 4 },
  research_service: { knowledge: 18, happiness: 5 }
});
const MIN_FOUNDER_CASH = 250;
const FOUNDER_CAPITAL = '250.00000000';
const RESIDENT_FOUNDER_RESERVE = 1_000;
const BUSINESS_RETRY_COOLDOWN_WORLD_MINUTES = 3 * 1_440;
const BUSINESS_APPLICATION_TTL_WORLD_MINUTES = 2_880;
const MIN_INVESTMENT = '10.00000000';
const RUN_COST_PER_DAY = '5.00000000';
const MAX_DISTRIBUTION_SHARE = 0.2;
const error = (code, statusCode = 409) => Object.assign(new Error(code), { statusCode });
const clamp = (value, low, high) => Math.max(low, Math.min(high, Number(value) || 0));

function validText(value, min, max) {
  return typeof value === 'string' && value.trim().length >= min && value.trim().length <= max;
}

function capabilityScore(skills = {}, info = {}) {
  const weightedSkills = Object.entries(info.capabilities || {}).reduce((sum, [skill, weight]) =>
    sum + clamp(Number(skills[skill]) || 0, 0, 100) * weight, 0);
  const discipline = Number(info.discipline || 0) * clamp(Number(info.agentDiscipline) || 0, 0, 1) * 100;
  return clamp(weightedSkills + discipline, 0, 100);
}

function relevantExperience(agent, serviceType, info) {
  const memories = Array.isArray(agent.recentMemories) ? agent.recentMemories : [];
  const memoryCount = memories.filter((memory) => {
    const type = String(memory.memoryType || '');
    const action = String(memory.metadata?.action || '');
    if (info.experience === 'trade') return ['trade', 'economic', 'business'].includes(type) || action === 'trade';
    if (serviceType === 'food_service') return type === 'business' || action === 'eat' || action === 'business_service';
    if (serviceType === 'social_service') return type === 'social' || type === 'business';
    if (serviceType === 'engineering_service') return type === 'work' || type === 'project' || action === 'work';
    return type === 'learning' || type === 'project' || type === 'business';
  }).length;
  return Math.min(12, memoryCount * 2);
}

export function businessCapabilityFit(agent, serviceType, context = {}, { organizationId = null } = {}) {
  const info = SERVICE_INFO[serviceType];
  if (!info) return { score: 0, ownScore: 0, teamScore: 0, teamAgentIds: [], requiredSkill: null };
  const ownScore = capabilityScore(agent.skills || {}, { ...info, agentDiscipline: agent.discipline });
  let teamScore = ownScore;
  let teamAgentIds = [agent.agentId].filter(Boolean);
  if (organizationId) {
    const organization = (agent.organizationMemberships || []).find((item) => item.id === organizationId
      && item.memberStatus === 'active' && item.status === 'active');
    if (organization) {
      const memberIds = [...new Set([agent.agentId, ...(organization.memberIds || [])].filter(Boolean))];
      const teamSkills = {};
      for (const memberId of memberIds) {
        const skills = context.residentSkills?.[memberId] || (memberId === agent.agentId ? agent.skills : {});
        for (const skill of Object.keys(info.capabilities || {})) {
          teamSkills[skill] = Math.max(Number(teamSkills[skill]) || 0, Number(skills?.[skill]) || 0);
        }
      }
      teamScore = capabilityScore(teamSkills, { ...info, agentDiscipline: agent.discipline });
      if (organization.memberStatus === 'active') teamAgentIds = memberIds;
    }
  }
  const experience = relevantExperience(agent, serviceType, info);
  const completedProjects = (agent.completedProjects || []).filter((item) => item.status === 'completed').length;
  const businessHistory = (context.businesses || []).filter((business) => business.founder_agent_id === agent.agentId
    || isBusinessBeneficiary(agent.agentId, business, context.ownership || [])).length;
  const network = Math.min(8, (agent.relationships || []).filter((item) => Number(item.trust) >= 2
    && Number(item.familiarity) >= 10).length * 1.5);
  const learningReadiness = clamp((Number(agent.curiosity) || 0.5) * 4 + (Number(agent.discipline) || 0.5) * 3, 0, 7);
  const reputation = clamp(Number(agent.reputation || agent.businessReputation || 0), -100, 100) * 0.04;
  const projectExperience = Math.min(8, completedProjects * 1.5);
  const businessExperience = Math.min(8, businessHistory * 2);
  const score = clamp(Math.max(ownScore, teamScore) + experience + projectExperience + businessExperience
    + learningReadiness + reputation + (info.network ? network * info.network : 0), 0, 100);
  return { score, ownScore, teamScore, teamAgentIds, requiredSkill: info.skill,
    experienceBonus: experience, projectExperience, businessExperience, learningReadiness,
    reputationBonus: reputation, networkBonus: info.network ? network * info.network : 0 };
}

function chooseCapitalSource(agent) {
  const cash = Number(agent.usdc || agent.usdcBalance || 0);
  const fundedOrganization = (agent.organizationMemberships || []).find((organization) => organization.status === 'active'
    && organization.memberStatus === 'active' && Number(organization.cashBalance || 0) >= MIN_FOUNDER_CASH);
  const fundedProject = (agent.activeProjects || []).find((membership) => {
    const project = (agent.economicProjects || []).find((item) => item.id === membership.id && item.status === 'active');
    return project && Number(project.cash_balance || 0) >= MIN_FOUNDER_CASH;
  });
  return cash >= RESIDENT_FOUNDER_RESERVE ? { type: 'resident', ownerId: agent.agentId }
    : fundedOrganization ? { type: 'organization', ownerId: fundedOrganization.id }
      : fundedProject ? { type: 'project', ownerId: fundedProject.id } : null;
}

function chooseBusinessSourceAndCapability(agent, serviceType, context = {}) {
  const source = chooseCapitalSource({ ...agent, activeProjects: context.activeProjects || agent.activeProjects,
    economicProjects: context.economicProjects || agent.economicProjects });
  let capability = businessCapabilityFit(agent, serviceType, context,
    { organizationId: source?.type === 'organization' ? source.ownerId : null });

  // Prefer a funded active team when its combined capabilities improve the fit;
  // capability itself is a continuous advantage, never a startup license.
  const organizations = (agent.organizationMemberships || []).filter((organization) =>
    organization.status === 'active' && organization.memberStatus === 'active'
      && Number(organization.cashBalance || 0) >= MIN_FOUNDER_CASH)
    .map((organization) => ({ organization, capability: businessCapabilityFit(agent, serviceType, context,
      { organizationId: organization.id }) }))
    .sort((left, right) => right.capability.score - left.capability.score
      || String(left.organization.id).localeCompare(String(right.organization.id)));
  if (organizations.length && organizations[0].capability.score > capability.score) {
    const best = organizations[0];
    return { capitalSource: { type: 'organization', ownerId: best.organization.id },
      capability: best.capability };
  }
  return { capitalSource: source, capability };
}

function businessServiceSkill(serviceType) {
  if (serviceType === 'engineering_service') return 'engineering';
  if (serviceType === 'trading_service') return 'trading';
  if (serviceType === 'food_service' || serviceType === 'social_service') return 'social';
  return 'research';
}

function outstandingServiceDemand(demandRow, stockUnits = 0) {
  const demandCount = Number(demandRow?.demandCount ?? demandRow?.demand_count);
  if (!Number.isFinite(demandCount)) return Math.max(0, Number(demandRow?.unmetCount ?? demandRow?.unmet_count) || 0);
  const reportedSupply = Number(demandRow?.supplyCount ?? demandRow?.supply_count) || 0;
  return Math.max(0, demandCount - Math.max(reportedSupply, Number(stockUnits) || 0));
}

function serviceNeedValue(agent, serviceType, skills = {}) {
  const benefit = SERVICE_BENEFITS[serviceType] || {};
  const food = Number(agent.food) || 0;
  const social = Number(agent.social) || 0;
  const knowledge = Number(agent.knowledge) || 0;
  if (serviceType === 'food_service') {
    return Math.min(benefit.food || 0, Math.max(0, 78 - food)) * 0.75
      + Math.min(benefit.energy || 0, Math.max(0, 65 - (Number(agent.energy) || 0))) * 0.2;
  }
  if (serviceType === 'social_service') {
    return Math.min(benefit.social || 0, Math.max(0, 64 - social)) * 1.2
      + Math.min(benefit.happiness || 0, Math.max(0, 80 - (Number(agent.happiness) || 0))) * 0.25
      + clamp(Number(agent.sociability) || 0.5, 0, 1) * 4;
  }
  if (serviceType === 'engineering_service') {
    return Math.min(benefit.knowledge || 0, Math.max(0, 50 - knowledge)) * 1.3
      + clamp(Number(skills.engineering) || 0, 0, 100) * 0.08;
  }
  if (serviceType === 'trading_service') {
    return Math.min(benefit.knowledge || 0, Math.max(0, 60 - knowledge)) * 0.8
      + clamp(Number(skills.trading) || 0, 0, 100) * 0.1;
  }
  return Math.min(benefit.knowledge || 0, Math.max(0, 60 - knowledge)) * 1.4
    + clamp(Number(skills.research) || 0, 0, 100) * 0.08;
}

function serviceDistancePenalty(agent, service, scenes = []) {
  const targetLocation = service.placeName || service.place_name;
  if (!targetLocation || targetLocation === agent.location) return 0;
  const from = scenes.find((scene) => scene.name === agent.location)?.position;
  const to = scenes.find((scene) => scene.name === targetLocation)?.position;
  const coordinate = (position) => {
    if (!position || typeof position !== 'object') return null;
    const x = Number(position.x);
    const z = Number(position.z ?? position.y);
    return Number.isFinite(x) && Number.isFinite(z) ? { x, z } : null;
  };
  const origin = coordinate(from);
  const destination = coordinate(to);
  if (!origin || !destination) return 4;
  // Scene coordinates are normalized world space; cap travel friction so it
  // cannot outweigh a substantial unmet need or a documented service benefit.
  return Math.min(10, Math.hypot(origin.x - destination.x, origin.z - destination.z) * 6);
}

export function explainBusinessOpportunityGaps(agent, context = {}, candidates = []) {
  const serviceCandidates = new Map(candidates.map((item) => [item.businessProposal?.serviceType
    || item.preparationServiceType || item.cofounderProposal?.serviceType, item]).filter(([serviceType]) => serviceType));
  const unmet = new Map((context.demand || []).map((row) => [row.serviceType, Number(row.unmetCount) || 0]));
  const rows = [];
  for (const [serviceType, info] of Object.entries(SERVICE_INFO)) {
    const demand = (context.demand || []).find((item) => item.serviceType === serviceType) || {};
    const { capitalSource, capability: fit } = chooseBusinessSourceAndCapability(agent, serviceType, context);
    const candidate = serviceCandidates.get(serviceType);
    const ownedBusinesses = (context.businesses || []).filter((business) => business.founder_agent_id === agent.agentId
      || isBusinessBeneficiary(agent.agentId, business, context.ownership || []));
    const activeBusiness = ownedBusinesses.some((business) => business.status === 'active');
    const failureWorldTime = Math.max(...ownedBusinesses.filter((business) => ['inactive','closed','bankrupt'].includes(business.status))
      .map((business) => Number(business.metadata?.closedWorldTime || business.metadata?.lastLossWorldTime
        || business.founded_world_time || business.foundedWorldTime)).filter(Number.isFinite), Number.NEGATIVE_INFINITY);
    const retryReady = Number(context.worldMinutes || 0) - failureWorldTime >= BUSINESS_RETRY_COOLDOWN_WORLD_MINUTES;
    let reasonCode = 'CANDIDATE_CREATED';
    if (candidate) reasonCode = 'CANDIDATE_CREATED';
    else if (demand.known === false) reasonCode = 'MARKET_NOT_OBSERVED';
    else if ((unmet.get(serviceType) || 0) <= 0) reasonCode = Number(demand.demandCount) > 0
      && Number(demand.supplyCount) >= Number(demand.demandCount) ? 'STRONG_COMPETITION' : 'NO_UNMET_DEMAND';
    else if (activeBusiness) reasonCode = 'BUSINESS_ALREADY_ACTIVE';
    else if (!retryReady) reasonCode = 'BUSINESS_RETRY_COOLDOWN';
    else if (!capitalSource) reasonCode = 'INSUFFICIENT_CAPITAL';
    else if (Number(agent.energy) < 20 || Number(agent.food) < 15) reasonCode = 'ENERGY_TOO_LOW';
    else if (serviceType === 'trading_service' && Number(agent.riskTolerance) < 0.2) reasonCode = 'RISK_TOO_HIGH';
    else if (Number(demand.supplyCount) >= Math.max(2, Number(demand.demandCount))) reasonCode = 'STRONG_COMPETITION';
    else if (String(agent.primaryGoal || agent.goal || '').trim()
      && !/WEALTH|BUSINESS|MARKET|TRAD|COMMUNITY|RELATION|BUILD|RESEARCH|LEARN|ENGINEER/i
      .test(String(agent.primaryGoal || agent.goal)) && Number(agent.ambition || 0) < 0.35) reasonCode = 'GOAL_MISMATCH';
    const partner = bestTrustedCofounder(agent, serviceType, context);
    rows.push({ serviceType, reasonCode, action: candidate?.action || null,
      additionalReasonCodes: [
        ...(fit.ownScore < 28 && fit.teamScore < 28 ? ['CAPABILITY_TOO_LOW'] : []),
        ...(fit.ownScore < 28 && !partner ? ['NO_PARTNER'] : []),
        ...(fit.ownScore < fit.score && !partner ? ['TEAM_CAPABILITY_UNAVAILABLE'] : []),
        ...(String(agent.primaryGoal || agent.goal || '').trim()
          && !/WEALTH|BUSINESS|MARKET|TRAD|COMMUNITY|RELATION|BUILD|RESEARCH|LEARN|ENGINEER/i
            .test(String(agent.primaryGoal || agent.goal)) && Number(agent.ambition || 0) < 0.35
          ? ['GOAL_MISMATCH'] : [])
      ],
      demandCount: Number(demand.demandCount) || 0,
      supplyCount: Number(demand.supplyCount) || 0, unmetCount: Number(demand.unmetCount) || 0,
      known: demand.known !== false, awareness: demand.awareness || 'local',
      capabilityFit: fit.score, ownCapabilityFit: fit.ownScore, teamCapabilityFit: fit.teamScore,
      requiredSkill: info.skill, capitalAvailable: Boolean(capitalSource),
      learningAvailable: fit.ownScore < 70, partnerAvailable: Boolean(partner) });
  }
  return rows;
}

function bestTrustedCofounder(agent, serviceType, context = {}) {
  const info = SERVICE_INFO[serviceType];
  if (!info) return null;
  const ownSkills = agent.skills || {};
  const candidates = (agent.organizationPartners || []).filter((partner) => Number(partner.trust) >= 5
    && Number(partner.familiarity) >= 25
    && !partner.alreadySharedOrganization && partner.partnerId !== agent.agentId);
  const compatible = candidates.map((partner) => {
    const partnerSkills = context.residentSkills?.[partner.partnerId] || {};
    const combined = Object.fromEntries(Object.keys(info.capabilities || {}).map((skill) =>
      [skill, Math.max(Number(ownSkills[skill]) || 0, Number(partnerSkills[skill]) || 0)]));
    const teamScore = capabilityScore(combined, { ...info, agentDiscipline: Math.max(
      Number(agent.discipline) || 0, Number(partner.discipline) || 0) });
    const ownScore = capabilityScore(ownSkills, { ...info, agentDiscipline: agent.discipline });
    const partnerScore = capabilityScore(partnerSkills, { ...info, agentDiscipline: partner.discipline });
    const contributed = Object.keys(info.capabilities || {}).some((skill) =>
      Number(partnerSkills[skill]) > Number(ownSkills[skill] || 0));
    const ownGoal = String(agent.primaryGoal || agent.goal || '').toUpperCase();
    const partnerGoal = String(partner.partnerGoal || '').toUpperCase();
    const goalCompatible = !partnerGoal || !ownGoal || ownGoal === partnerGoal
      || !['BUILD_WEALTH','MASTER_TRADING','MASTER_RESEARCH','MASTER_ENGINEERING'].some((goal) =>
        ownGoal.includes(goal) && partnerGoal.includes(goal));
    return { ...partner, teamScore, ownScore, partnerScore, contributed, goalCompatible };
  }).filter((partner) => partner.contributed && partner.goalCompatible && partner.teamScore > partner.ownScore)
    .sort((left, right) => right.teamScore - left.teamScore || Number(right.trust) - Number(left.trust)
      || String(left.partnerId).localeCompare(String(right.partnerId)));
  return compatible[0] || null;
}

function ceilMoney(value) {
  return (Math.round(Math.max(0, Number(value) || 0) * 1e8) / 1e8).toFixed(8);
}

function allocateProRata(total, owners) {
  const amount = typeof total === 'bigint' ? total : parsePositiveUnits(String(total), { allowZero: true });
  const weights = owners.map((owner) => parsePositiveUnits(String(owner.share), { allowZero: true }));
  const weightTotal = weights.reduce((sum, weight) => sum + weight, 0n);
  if (amount < 0n || weightTotal <= 0n) throw error('ECONOMIC_OWNERSHIP_INVALID');
  let assigned = 0n;
  return owners.map((owner, index) => {
    const share = index === owners.length - 1 ? amount - assigned : amount * weights[index] / weightTotal;
    assigned += share;
    return { owner, amount: share };
  });
}

async function assertOrganizationContributor(client, worldId, organizationId, agentId) {
  const membership = await client.query(`SELECT 1 FROM world_organization_members member
    JOIN world_organizations organization ON organization.world_id=member.world_id AND organization.id=member.organization_id
    WHERE member.world_id=$1 AND member.organization_id=$2 AND member.agent_id=$3
      AND member.status='active' AND organization.status='active' FOR UPDATE OF member,organization`,
  [worldId, organizationId, agentId]);
  if (!membership.rowCount) throw error('ACTIVE_ORGANIZATION_MEMBERSHIP_REQUIRED', 403);
}

function businessBeneficialShare(agentId, business, ownership = []) {
  const queued = (business?.owners || ownership.filter((item) => item.assetType === 'business'
    && item.assetId === business?.id)).map((owner) => ({ type: owner.ownerType, id: owner.ownerId,
      share: Number(owner.share) || 0, path: new Set([`${owner.ownerType}:${owner.ownerId}`]) }));
  let residentShare = 0;
  while (queued.length) {
    const current = queued.pop();
    const key = `${current.type}:${current.id}`;
    if (current.type === 'resident' && current.id === agentId) { residentShare += current.share; continue; }
    if (current.type === 'organization' || current.type === 'project') {
      for (const owner of ownership) if (owner.assetType === current.type && owner.assetId === current.id) {
        const nextKey = `${owner.ownerType}:${owner.ownerId}`;
        if (current.path.has(nextKey)) continue;
        queued.push({ type: owner.ownerType, id: owner.ownerId, share: current.share * (Number(owner.share) || 0),
          path: new Set([...current.path, nextKey]) });
      }
    }
  }
  return Math.min(1, residentShare);
}

function isBusinessBeneficiary(agentId, business, ownership = []) {
  return businessBeneficialShare(agentId, business, ownership) > 0;
}

async function readBusinessBeneficialShare(client, worldId, businessId, agentId) {
  const beneficiary = await client.query(`WITH RECURSIVE owners(owner_type,owner_id,share,path) AS (
      SELECT owner_type,owner_id,share::numeric,ARRAY[owner_type||':'||owner_id::text]
      FROM world_economic_ownership WHERE world_id=$1 AND asset_type='business' AND asset_id=$2
      UNION ALL
      SELECT parent.owner_type,parent.owner_id,owners.share*parent.share,
        owners.path||(parent.owner_type||':'||parent.owner_id::text)
      FROM owners JOIN world_economic_ownership parent ON parent.world_id=$1
        AND parent.asset_type=owners.owner_type AND parent.asset_id=owners.owner_id
      WHERE owners.owner_type IN ('organization','project')
        AND NOT (parent.owner_type||':'||parent.owner_id::text)=ANY(owners.path)
    )
    SELECT COALESCE(sum(share),0)::text AS share FROM owners WHERE owner_type='resident' AND owner_id=$3`,
  [worldId, businessId, agentId]);
  return Number(beneficiary.rows[0]?.share) || 0;
}

async function assertNotBusinessBeneficiary(client, worldId, businessId, agentId) {
  if (await readBusinessBeneficialShare(client, worldId, businessId, agentId) > 0) {
    throw error('BUSINESS_OWNER_CANNOT_BE_OWN_CUSTOMER');
  }
}

async function requireBusinessOwner(client, worldId, businessId, agentId) {
  if (await readBusinessBeneficialShare(client, worldId, businessId, agentId) <= 0) {
    throw error('BUSINESS_OWNER_REQUIRED', 403);
  }
}

export function quoteBusinessPrice({ basePrice, demand = 1, supply = 1, reputation = 0, relationship = 0,
  wealth = 10_000, priceSensitivity = 0.5 }) {
  const base = Number(basePrice);
  if (!Number.isFinite(base) || base <= 0) throw new Error('BUSINESS_PRICE_INVALID');
  const scarcity = clamp((Number(demand) - Number(supply)) / Math.max(1, Number(demand)), -1, 1);
  const trustLift = clamp(Number(relationship) / 100, -0.2, 0.2);
  const reputationLift = clamp(Number(reputation) / 100, -0.15, 0.15);
  const wealthAdjustment = clamp((Number(wealth) - 1_000) / 50_000, -0.05, 0.1) * clamp(priceSensitivity, 0, 1);
  const multiplier = clamp(1 + scarcity * 0.2 + reputationLift + trustLift * 0.2 + wealthAdjustment, 0.65, 1.8);
  return ceilMoney(base * multiplier);
}

export function deriveWorldEconomicDemand(residents = [], businesses = [], worldMinutes = 0) {
  const demand = new Map(Object.keys(SERVICE_INFO).map((key) => [key, { demandCount: 0, evidence: [] }]));
  for (const resident of residents) {
    const goal = String(resident.primaryGoal || resident.primary_goal || '').toUpperCase();
    const food = Number(resident.food) || 0;
    const social = Number(resident.social) || 0;
    const knowledge = Number(resident.knowledge) || 0;
    const skills = typeof resident.skills === 'object' && resident.skills ? resident.skills : {};
    const add = (type, reason) => {
      const row = demand.get(type);
      if (!row) return;
      row.demandCount++;
      if (row.evidence.length < 8) row.evidence.push({ agentId: resident.agent_id || resident.agentId,
        reason, worldMinutes: Math.max(0, Math.trunc(Number(worldMinutes) || 0)) });
    };
    if (food < 78) add('food_service', 'low_food');
    if (knowledge < 60 || goal.includes('RESEARCH') || goal.includes('LEARN')) add('research_service', 'learning_need');
    if (social < 68 || goal.includes('RELATIONSHIP') || goal.includes('COMMUNITY')) add('social_service', 'social_need');
    if (Number(skills.engineering) < 45 && (goal.includes('ENGINEERING') || goal.includes('BUILD'))) add('engineering_service', 'engineering_goal');
    if (goal.includes('TRADING') || goal.includes('WEALTH')) add('trading_service', 'market_information_need');
  }
  const supply = new Map();
  for (const item of businesses) if (item.active !== false
      && !['inactive','closed','bankrupt'].includes(item.businessStatus || item.status)) {
    const serviceType = item.serviceType || item.service_type;
    const stock = Number(item.stockUnits ?? item.stock_units) || 0;
    if (serviceType) supply.set(serviceType, (supply.get(serviceType) || 0) + Math.max(0, stock));
  }
  return [...demand.entries()].map(([serviceType, item]) => ({ serviceType, demandCount: item.demandCount,
    supplyCount: supply.get(serviceType) || 0,
    unmetCount: Math.max(0, item.demandCount - (supply.get(serviceType) || 0)), evidence: item.evidence }));
}

function residentDemandTypes(resident) {
  return new Set(deriveWorldEconomicDemand([resident], [], 0)
    .filter((item) => item.demandCount > 0).map((item) => item.serviceType));
}

/**
 * Build one resident's market view from nearby needs, their own needs, trusted
 * contacts and retained market beliefs. Only the Exchange exposes world totals.
 */
export function perceiveResidentEconomicMarket(agent, context = {}) {
  const worldMinutes = Math.max(0, Math.trunc(Number(context.worldMinutes) || 0));
  const location = String(agent.location || '');
  const agentId = String(agent.agentId || agent.agent_id || '');
  const scenes = context.scenes || [];
  // The current schema represents the public Exchange as an active Commons
  // scene named "Exchange"; it does not allow a separate `exchange` scene type.
  const atExchange = scenes.some((scene) => scene.name === location && scene.status === 'active'
    && (scene.sceneType === 'exchange' || scene.name === 'Exchange'));
  const residentsNearby = (context.residentsAtLocation?.[location] || context.nearbyResidents || [])
    .filter((resident) => (resident.agentId || resident.agent_id) !== agentId);
  const localResidents = [agent, ...residentsNearby];
  const localNeeds = new Map(Object.keys(SERVICE_INFO).map((serviceType) => [serviceType, 0]));
  const localOtherNeeds = new Map(Object.keys(SERVICE_INFO).map((serviceType) => [serviceType, 0]));
  for (const resident of localResidents) for (const serviceType of residentDemandTypes(resident)) {
    localNeeds.set(serviceType, (localNeeds.get(serviceType) || 0) + 1);
    if ((resident.agentId || resident.agent_id) !== agentId) {
      localOtherNeeds.set(serviceType, (localOtherNeeds.get(serviceType) || 0) + 1);
    }
  }
  const memories = Array.isArray(agent.recentMemories) ? agent.recentMemories : [];
  const beliefs = Array.isArray(agent.beliefs) ? agent.beliefs : [];
  const relationships = Array.isArray(agent.relationships) ? agent.relationships : [];
  const recentBusinessEvidence = memories.filter((memory) => worldMinutes
    - Number(memory.worldMinutes ?? memory.world_minutes ?? 0) >= 0
    && worldMinutes - Number(memory.worldMinutes ?? memory.world_minutes ?? 0) <= 10_080);
  const marketBeliefs = new Map(beliefs.filter((belief) => (belief.subjectType || belief.subject_type) === 'market'
    && (belief.beliefKey || belief.belief_key) === 'unmet_demand'
    && worldMinutes - Number(belief.updatedWorldMinutes ?? belief.updated_world_minutes ?? 0) >= 0
    && worldMinutes - Number(belief.updatedWorldMinutes ?? belief.updated_world_minutes ?? 0) <= 10_080)
    .map((belief) => [belief.subjectKey || belief.subject_key, belief]));
  const knownBusinessIds = new Set();
  const trustedFounderIds = new Set(relationships.filter((item) => Number(item.trust) >= 5
    && Number(item.familiarity) >= 15).map((item) => item.otherAgentId || item.other_agent_id));
  for (const memory of recentBusinessEvidence) {
    const id = memory.metadata?.businessId || memory.metadata?.initiative?.businessId;
    if (id) knownBusinessIds.add(String(id));
  }
  const businessRows = context.businesses || [];
  const serviceRows = context.services || [];
  const isOwnBusiness = (business) => (business.founder_agent_id || business.founderAgentId) === agentId
    || isBusinessBeneficiary(agentId, business, context.ownership || []);
  const isRememberedBusiness = (business) => {
    const founderId = business.founder_agent_id || business.founderAgentId;
    return knownBusinessIds.has(String(business.id || '')) || trustedFounderIds.has(founderId)
      || recentBusinessEvidence.some((memory) => (memory.relatedAgentId || memory.related_agent_id) === founderId);
  };
  const businessAtLocation = (business) => {
    const placeId = business.place_id || business.placeId;
    return scenes.find((scene) => scene.id === placeId)?.name === location;
  };
  const serviceKnownFromMemory = (service, founderId) => recentBusinessEvidence.some((memory) => {
    const metadata = memory.metadata || {};
    const initiative = metadata.initiative || {};
    return (memory.relatedAgentId || memory.related_agent_id) === founderId
      || metadata.businessId === service.business_id || initiative.businessId === service.business_id
      || metadata.serviceId === service.id || initiative.serviceId === service.id;
  });
  const visibleServices = serviceRows.filter((service) => {
    const business = businessRows.find((item) => item.id === service.business_id);
    const founderId = service.founderAgentId || service.founder_agent_id
      || business?.founder_agent_id || business?.founderAgentId;
    return atExchange || service.placeName === location || service.place_name === location
      || trustedFounderIds.has(founderId) || knownBusinessIds.has(String(service.business_id))
      || serviceKnownFromMemory(service, founderId);
  });
  const visibleBusinessIds = new Set(visibleServices.map((service) => String(service.business_id)));
  const businesses = businessRows.filter((business) => atExchange || isOwnBusiness(business)
    || businessAtLocation(business) || isRememberedBusiness(business)
    || visibleBusinessIds.has(String(business.id)));
  for (const business of businesses) visibleBusinessIds.add(String(business.id));
  const jobs = (context.jobs || []).filter((job) => atExchange
    || visibleBusinessIds.has(String(job.business_id || job.businessId)));
  const applications = (context.applications || []).filter((application) =>
    application.agent_id === agentId || application.agentId === agentId || application.founderAgentId === agentId);
  const employment = (context.employment || []).filter((item) => item.agent_id === agentId || item.agentId === agentId
    || visibleBusinessIds.has(String(item.business_id || item.businessId)));
  const organizationIds = new Set((agent.organizationMemberships || []).map((item) => String(item.id)));
  const projectIds = new Set([...(agent.activeProjects || []), ...(agent.projectMemberships || [])]
    .map((item) => String(item.id || item.projectId || item.project_id || '')));
  for (const memory of recentBusinessEvidence) {
    const id = memory.metadata?.projectId || memory.metadata?.initiative?.projectId;
    if (id) projectIds.add(String(id));
  }
  const economicProjects = (context.economicProjects || []).filter((project) => atExchange
    || project.creator_agent_id === agentId || project.creatorAgentId === agentId
    || projectIds.has(String(project.id))
    || (project.owners || []).some((owner) => owner.ownerType === 'resident' && owner.ownerId === agentId));
  const visibleProjectIds = new Set(economicProjects.map((project) => String(project.id)));
  const ownership = (context.ownership || []).filter((item) => {
    const type = item.assetType || item.asset_type;
    const assetId = item.assetId || item.asset_id;
    if (type === 'business') return atExchange || visibleBusinessIds.has(String(assetId));
    if (type === 'project') return atExchange || visibleProjectIds.has(String(assetId));
    if (type === 'organization') return atExchange || organizationIds.has(String(assetId));
    return false;
  });
  const organizations = (context.organizations || []).filter((item) => atExchange || organizationIds.has(String(item.id)));
  const knownResidentIds = new Set([agentId, ...trustedFounderIds]);
  for (const organization of agent.organizationMemberships || []) if (organization.status === 'active') {
    for (const memberId of organization.memberIds || []) knownResidentIds.add(memberId);
  }
  for (const partner of agent.organizationPartners || []) if (partner.partnerId) knownResidentIds.add(partner.partnerId);
  const residentSkills = Object.fromEntries(Object.entries(context.residentSkills || {})
    .filter(([residentId]) => knownResidentIds.has(residentId)));
  const visibleStock = new Map();
  for (const service of visibleServices) visibleStock.set(service.service_type,
    (visibleStock.get(service.service_type) || 0) + Math.max(0, Number(service.stock_units) || 0));
  const globalDemand = new Map((context.demand || []).map((row) => [row.serviceType, row]));
  const demand = Object.keys(SERVICE_INFO).map((serviceType) => {
    const remembered = marketBeliefs.get(serviceType);
    const rememberedEvidence = remembered?.evidence && typeof remembered.evidence === 'object' ? remembered.evidence : {};
    const observedAt = Number(rememberedEvidence.observedWorldMinutes
      ?? remembered?.updatedWorldMinutes ?? remembered?.updated_world_minutes ?? 0);
    const memoryAge = remembered ? Math.max(0, worldMinutes - observedAt) : 10_080;
    const memoryDecay = remembered ? Math.max(0, 1 - memoryAge / 10_080) : 0;
    const personalNeed = (residentDemandTypes(agent).has(serviceType) ? 1 : 0);
    const nearbyNeed = localOtherNeeds.get(serviceType) || 0;
    const hasPriorKnowledge = Boolean(remembered) || recentBusinessEvidence.some((memory) =>
      memory.metadata?.serviceType === serviceType || memory.metadata?.initiative?.serviceType === serviceType);
    const directlyObserved = atExchange || personalNeed > 0 || nearbyNeed > 0;
    const known = directlyObserved || hasPriorKnowledge;
    const globalRow = globalDemand.get(serviceType) || {};
    const visibleDemand = atExchange ? Number(globalRow.demandCount) || 0 : localNeeds.get(serviceType) || 0;
    const visibleSupply = atExchange ? Number(globalRow.supplyCount) || 0 : visibleStock.get(serviceType) || 0;
    const rememberedDemand = Math.max(0, Number(rememberedEvidence.demandCount) || 0) * memoryDecay;
    const rememberedSupply = Math.max(0, Number(rememberedEvidence.supplyCount) || 0) * memoryDecay;
    const rememberedOtherDemand = Math.max(0, Number(rememberedEvidence.otherDemandCount) || 0) * memoryDecay;
    const demandCount = directlyObserved ? visibleDemand : rememberedDemand;
    const supplyCount = directlyObserved ? visibleSupply : rememberedSupply;
    const otherDemandCount = atExchange ? Math.max(0, (Number(globalRow.demandCount) || 0) - personalNeed)
      : nearbyNeed > 0 ? nearbyNeed : rememberedOtherDemand;
    const confidence = atExchange ? 0.95 : nearbyNeed > 0 ? 0.72 : personalNeed > 0 ? 0.58
      : remembered ? Math.max(0, Number(remembered.confidence) * memoryDecay) : 0;
    return { serviceType, known, awareness: atExchange ? 'exchange' : nearbyNeed ? 'local_residents'
      : personalNeed ? 'personal_need' : hasPriorKnowledge ? 'memory' : 'unknown',
      directlyObserved, awarenessConfidence: confidence, demandCount, otherDemandCount,
      supplyCount, unmetCount: Math.max(0, demandCount - supplyCount),
      personalNeed: personalNeed > 0, nearbyDemandCount: nearbyNeed,
      rememberedEstimate: remembered ? (Number(remembered.estimate) || 0) * memoryDecay : null };
  });
  return { demand, services: visibleServices, businesses, jobs, applications, employment, ownership,
    organizations, economicProjects, residentSkills,
    discoveredFrom: atExchange ? 'public_exchange' : 'personal_and_local_observation' };
}

export async function observeResidentEconomicMarket(client, { worldId, agent, context = {}, worldMinutes }) {
  if (!Array.isArray(agent.beliefs)) agent.beliefs = [];
  const perception = perceiveResidentEconomicMarket(agent, { ...context, worldMinutes });
  for (const item of perception.demand) {
    if (!item.directlyObserved) {
      const existing = agent.beliefs.find((belief) => (belief.subjectType || belief.subject_type) === 'market'
        && (belief.subjectKey || belief.subject_key) === item.serviceType
        && (belief.beliefKey || belief.belief_key) === 'unmet_demand');
      if (existing) {
        const decayed = { ...existing, estimate: item.rememberedEstimate ?? existing.estimate,
          confidence: item.awarenessConfidence };
        agent.beliefs = agent.beliefs.map((belief) => belief === existing ? decayed : belief);
      }
      continue;
    }
    const estimate = item.demandCount > 0 ? item.unmetCount / item.demandCount : 0;
    const evidence = { awareness: item.awareness, demandCount: item.demandCount,
      otherDemandCount: item.otherDemandCount, supplyCount: item.supplyCount,
      unmetCount: item.unmetCount, confidence: item.awarenessConfidence, location: agent.location,
      observedWorldMinutes: worldMinutes };
    await client.query(`INSERT INTO world_agent_beliefs(world_id,agent_id,subject_type,subject_key,belief_key,
        estimate,confidence,sample_count,updated_world_minutes,evidence)
      VALUES($1,$2,'market',$3,'unmet_demand',$4,$5,1,$6,$7::jsonb)
      ON CONFLICT(world_id,agent_id,subject_type,subject_key,belief_key) DO UPDATE SET
        estimate=(world_agent_beliefs.estimate*world_agent_beliefs.sample_count+EXCLUDED.estimate)
          /(world_agent_beliefs.sample_count+1),
        confidence=LEAST(0.98,GREATEST(world_agent_beliefs.confidence,EXCLUDED.confidence)),
        sample_count=world_agent_beliefs.sample_count+1,updated_world_minutes=EXCLUDED.updated_world_minutes,
        evidence=EXCLUDED.evidence`, [worldId, agent.agentId, item.serviceType, estimate,
      item.awarenessConfidence, worldMinutes, JSON.stringify(evidence)]);
    const existing = agent.beliefs.find((belief) => (belief.subjectType || belief.subject_type) === 'market'
      && (belief.subjectKey || belief.subject_key) === item.serviceType
      && (belief.beliefKey || belief.belief_key) === 'unmet_demand');
    const belief = { subjectType: 'market', subjectKey: item.serviceType, beliefKey: 'unmet_demand',
      estimate, confidence: item.awarenessConfidence, sampleCount: Number(existing?.sampleCount || 0) + 1,
      updatedWorldMinutes: worldMinutes, evidence };
    agent.beliefs = existing ? agent.beliefs.map((entry) => entry === existing ? belief : entry)
      : [...agent.beliefs, belief];
  }
  return perception;
}

export async function loadWorldBusinessContext(client, worldId, worldMinutes = 0, residents = []) {
  const [businesses, services, jobs, applications, employment, ownership, organizations, projects, places] = await Promise.all([
    client.query(`SELECT business.*,account.balance::text AS cash_balance,
        COALESCE((business.metadata->>'lastDistributionWorldTime')::bigint,0) AS last_distribution_world_time,
        COALESCE((SELECT jsonb_agg(jsonb_build_object('ownerType',owner.owner_type,'ownerId',owner.owner_id,
          'share',owner.share::text,'investedUsdc',owner.invested_usdc::text))
          FROM world_economic_ownership owner WHERE owner.world_id=business.world_id
            AND owner.asset_type='business' AND owner.asset_id=business.id),'[]'::jsonb) AS owners,
        COALESCE((SELECT sum(posting.amount) FROM world_economic_postings posting
          JOIN world_economic_transactions tx ON tx.id=posting.transaction_id
          WHERE posting.account_id=account.id AND tx.transaction_type='business_revenue'),0)::text AS revenue,
        COALESCE((SELECT -sum(posting.amount) FROM world_economic_postings posting
          JOIN world_economic_transactions tx ON tx.id=posting.transaction_id
          WHERE posting.account_id=account.id AND tx.transaction_type IN ('business_expense','business_wage','maintenance')),
          0)::text AS expenses
      FROM world_businesses business LEFT JOIN world_economic_accounts account
        ON account.world_id=business.world_id AND account.account_key='business:'||business.id::text AND account.asset_symbol='USDC'
      WHERE business.world_id=$1 ORDER BY business.founded_world_time,business.id`, [worldId]),
    client.query(`SELECT service.*,business.name AS "businessName",business.founder_agent_id AS "founderAgentId",
        business.status AS "businessStatus",business.reputation AS "businessReputation",
        business.place_id AS "placeId",place.name AS "placeName",account.balance::text AS "businessCash"
      FROM world_business_services service JOIN world_businesses business ON business.id=service.business_id
      LEFT JOIN world_scenes place ON place.world_id=business.world_id AND place.id=business.place_id
      LEFT JOIN world_economic_accounts account ON account.world_id=business.world_id
        AND account.account_key='business:'||business.id::text AND account.asset_symbol='USDC'
      WHERE service.world_id=$1 AND service.active=true AND business.status='active'
        AND (place.id IS NULL OR place.status='active')
      ORDER BY service.created_world_time,service.id`, [worldId]),
    client.query(`SELECT job.*,business.founder_agent_id AS "founderAgentId",business.name AS "businessName",
        business.status AS "businessStatus",account.balance::text AS "businessCash",
        COALESCE((SELECT count(*)::int FROM world_business_applications application
          WHERE application.job_id=job.id AND application.status='pending'),0) AS "pendingCount"
      FROM world_business_jobs job JOIN world_businesses business ON business.id=job.business_id
      LEFT JOIN world_economic_accounts account ON account.world_id=job.world_id
        AND account.account_key='business:'||business.id::text AND account.asset_symbol='USDC'
      WHERE job.world_id=$1 AND job.status IN ('open','filled') AND business.status='active'
      ORDER BY job.created_world_time,job.id`, [worldId]),
    client.query(`SELECT application.*,business.founder_agent_id AS "founderAgentId",business.name AS "businessName",
        business.status AS "businessStatus",job.status AS "jobStatus",
        business_cash.balance::text AS "businessCash",applicant.name AS agent_name,
        job.role,job.required_skill AS "requiredSkill",job.wage_usdc::text AS wage
      FROM world_business_applications application JOIN world_businesses business ON business.id=application.business_id
      JOIN world_business_jobs job ON job.id=application.job_id
      JOIN agents applicant ON applicant.id=application.agent_id
      LEFT JOIN world_economic_accounts business_cash ON business_cash.world_id=application.world_id
        AND business_cash.account_key='business:'||business.id::text AND business_cash.asset_symbol='USDC'
      WHERE application.world_id=$1 ORDER BY application.created_world_time,application.id`, [worldId]),
    client.query(`SELECT employment.*,business.name AS "businessName",business.status AS "businessStatus",business.place_id AS "placeId",
        business_cash.balance::text AS "businessCash",
        place.name AS "placeName",job.required_skill AS "requiredSkill",job.role,
        service.id AS "serviceId",service.service_type AS "serviceType"
      FROM world_business_employment employment JOIN world_businesses business ON business.id=employment.business_id
      JOIN world_business_jobs job ON job.id=employment.job_id
      LEFT JOIN world_economic_accounts business_cash ON business_cash.world_id=employment.world_id
        AND business_cash.account_key='business:'||business.id::text AND business_cash.asset_symbol='USDC'
      LEFT JOIN world_scenes place ON place.world_id=business.world_id AND place.id=business.place_id
      LEFT JOIN LATERAL (SELECT id,service_type FROM world_business_services
        WHERE business_id=business.id AND active=true ORDER BY created_world_time,id LIMIT 1) service ON true
      WHERE employment.world_id=$1 AND employment.status='active'`, [worldId]),
    client.query(`SELECT asset_type AS "assetType",asset_id AS "assetId",owner_type AS "ownerType",owner_id AS "ownerId",
        share::text AS share,invested_usdc::text AS "investedUsdc"
      FROM world_economic_ownership WHERE world_id=$1`, [worldId]),
    client.query(`SELECT organization.id,organization.name,organization.status,account.balance::text AS cash_balance
      FROM world_organizations organization LEFT JOIN world_economic_accounts account
        ON account.world_id=organization.world_id AND account.account_key='organization:'||organization.id::text
          AND account.asset_symbol='USDC'
      WHERE organization.world_id=$1`, [worldId]),
    client.query(`SELECT project.id,project.creator_agent_id,project.organization_id,project.status,project.title,
        project.created_world_time,account.balance::text AS cash_balance,
        COALESCE((project.metadata->>'lastDistributionWorldTime')::bigint,0) AS last_distribution_world_time,
        COALESCE((SELECT sum(posting.amount) FROM world_economic_postings posting
          JOIN world_economic_transactions tx ON tx.id=posting.transaction_id
          WHERE posting.account_id=account.id AND tx.transaction_type IN ('place_revenue','profit_distribution','maintenance')),
          0)::text AS realized_profit_usdc,
        COALESCE(jsonb_agg(jsonb_build_object('ownerType',owner.owner_type,'ownerId',owner.owner_id,
          'share',owner.share::text,'investedUsdc',owner.invested_usdc::text))
          FILTER (WHERE owner.owner_id IS NOT NULL),'[]'::jsonb) AS owners
      FROM world_projects project LEFT JOIN world_economic_accounts account
        ON account.world_id=project.world_id AND account.account_key='project:'||project.id::text AND account.asset_symbol='USDC'
      LEFT JOIN world_economic_ownership owner ON owner.world_id=project.world_id
        AND owner.asset_type='project' AND owner.asset_id=project.id
      WHERE project.world_id=$1 GROUP BY project.id,account.id,account.balance`, [worldId]),
    client.query(`SELECT scene.id,scene.name,scene.status,scene.operating_cost_usdc::text AS operating_cost_usdc,
        scene.revenue_enabled,scene.revenue_share_bps,scene.created_by,scene.created_by_organization_id,
        COALESCE(jsonb_agg(jsonb_build_object('ownerType',owner.owner_type,'ownerId',owner.owner_id,
          'share',owner.share::text)) FILTER (WHERE owner.owner_id IS NOT NULL),'[]'::jsonb) AS owners
      FROM world_scenes scene LEFT JOIN world_economic_ownership owner ON owner.world_id=scene.world_id
        AND owner.asset_type='place' AND owner.asset_id=scene.id
      WHERE scene.world_id=$1 GROUP BY scene.id`, [worldId])
  ]);
  const demand = deriveWorldEconomicDemand(residents, services.rows, worldMinutes);
  await persistWorldEconomicDemand(client, worldId, worldMinutes, demand);
  const residentSkills = Object.fromEntries(residents.map((resident) => [resident.agent_id || resident.agentId,
    resident.skills || {}]));
  return { businesses: businesses.rows, services: services.rows, jobs: jobs.rows,
    applications: applications.rows, employment: employment.rows, ownership: ownership.rows, demand,
    organizations: organizations.rows, projects: projects.rows, places: places.rows, residentSkills, worldMinutes };
}

async function persistWorldEconomicDemand(client, worldId, worldMinutes, rows) {
  const worldDay = Math.floor(Number(worldMinutes) / 1_440);
  for (const row of rows) await client.query(`INSERT INTO world_economic_demand(world_id,service_type,world_day,
      demand_count,supply_count,unmet_count,evidence,updated_at)
    VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,now())
    ON CONFLICT(world_id,service_type,world_day) DO UPDATE SET demand_count=EXCLUDED.demand_count,
      supply_count=EXCLUDED.supply_count,unmet_count=EXCLUDED.unmet_count,evidence=EXCLUDED.evidence,updated_at=now()`,
  [worldId, row.serviceType, worldDay, row.demandCount, row.supplyCount, row.unmetCount, JSON.stringify({ residents: row.evidence })]);
}

export function buildBusinessCandidates(agent, context = {}) {
  const options = [];
  const cash = Number(agent.usdc || agent.usdcBalance || 0);
  const energy = Number(agent.energy) || 0;
  const food = Number(agent.food) || 0;
  const skills = agent.skills || {};
  const memories = agent.recentMemories || [];
  const relationships = agent.relationships || [];
  const businesses = context.businesses || [];
  const services = context.services || [];
  const jobs = context.jobs || [];
  const employment = context.employment || [];
  const owned = businesses.filter((business) => business.founder_agent_id === agent.agentId
    || isBusinessBeneficiary(agent.agentId, business, context.ownership || []));
  const activeOwned = owned.filter((business) => business.status === 'active');
  const employed = employment.find((item) => item.agent_id === agent.agentId || item.agentId === agent.agentId);
  const unmet = (context.demand || []).filter((item) => item.known !== false && Number(item.unmetCount) > 0)
    .sort((left, right) => right.unmetCount - left.unmetCount || left.serviceType.localeCompare(right.serviceType));
  const worldMinutes = Math.max(0, Math.trunc(Number(context.worldMinutes) || 0));
  const recentFailureTimes = owned.filter((business) => ['inactive','closed','bankrupt'].includes(business.status))
    .map((business) => Number(business.metadata?.closedWorldTime || business.metadata?.lastLossWorldTime
      || business.founded_world_time || business.foundedWorldTime))
    .filter(Number.isFinite);
  const lastFailureWorldTime = Math.max(...recentFailureTimes, Number.NEGATIVE_INFINITY);
  const businessRetryReady = worldMinutes - lastFailureWorldTime >= BUSINESS_RETRY_COOLDOWN_WORLD_MINUTES;
  const goal = String(agent.primaryGoal || agent.goal || '').toUpperCase();
  if (!activeOwned.length && businessRetryReady) for (const demand of unmet) {
    const spec = SERVICE_INFO[demand.serviceType];
    if (!spec) continue;
    const { capitalSource: serviceCapitalSource, capability } = chooseBusinessSourceAndCapability(agent,
      demand.serviceType, { ...context, activeProjects: context.activeProjects || agent.activeProjects,
        economicProjects: context.economicProjects || agent.economicProjects });
    const relationToService = relationships.find((item) => item.memoryType === 'business'
      && item.serviceType === demand.serviceType);
    const businessBeliefs = (agent.beliefs || []).filter((belief) => belief.subjectType === 'business'
      && belief.beliefKey === 'business_outcome');
    const beliefEstimate = businessBeliefs.length
      ? businessBeliefs.reduce((sum, belief) => sum + Number(belief.estimate || 0) * Number(belief.confidence || 0), 0)
        / businessBeliefs.length : 0;
    const partner = bestTrustedCofounder(agent, demand.serviceType, context);
    const outsideDemand = Number(demand.otherDemandCount ?? demand.demandCount) || 0;
    if (outsideDemand > 0 && serviceCapitalSource && energy >= 20 && food >= 15) {
      const businessNameBase = `${String(agent.name || 'Resident').slice(0, 42)} ${spec.label} Studio`.slice(0, 68);
      const existingNames = businesses.map((business) => String(business.name || ''));
      let businessName = businessNameBase;
      let ordinal = 2;
      while (existingNames.includes(businessName)) businessName = `${businessNameBase.slice(0, 72)} ${ordinal++}`;
      const serviceGoal = `${Number(demand.unmetCount)} observed unmet requests for ${spec.label.toLowerCase()}`;
      const organization = serviceCapitalSource.type === 'organization'
        ? (agent.organizationMemberships || []).find((item) => item.id === serviceCapitalSource.ownerId) : null;
      const proposal = { name: businessName.slice(0, 80), businessType: spec.type,
        purpose: `Meet ${serviceGoal} with a ${spec.type} service grounded in the founders' capabilities.`,
        serviceType: demand.serviceType, serviceName: spec.label,
        serviceDescription: `${spec.label} prepared by ${agent.name || 'a resident'} from resident demand and completed work.`,
        basePriceUsdc: spec.base, capitalUsdc: FOUNDER_CAPITAL, capitalSource: serviceCapitalSource,
        projectId: serviceCapitalSource.type === 'project' ? serviceCapitalSource.ownerId : null,
        placeId: context.scenes?.find((scene) => scene.status === 'active'
          && (spec.type === 'food' ? scene.sceneType === 'cafe' : spec.type === 'social' ? ['cafe','commons'].includes(scene.sceneType)
            : spec.type === 'research' ? ['library','observatory'].includes(scene.sceneType)
              : scene.sceneType === 'data_center'))?.id || null,
        requiredSkill: spec.skill,
        foundingReason: 'observed_unmet_demand_and_capability_fit',
        capabilityGap: Math.max(0, 50 - capability.score),
        capabilityFit: capability.score, capabilityTeamAgentIds: organization?.memberIds || [agent.agentId],
        founderSkillProfile: { ...skills } };
      const memoryOutcome = memories.filter((memory) => memory.memoryType === 'business'
        || memory.metadata?.serviceType === demand.serviceType).length;
      const goalFit = /WEALTH|BUSINESS|MARKET|TRAD|COMMUNITY|RELATION|BUILD|RESEARCH|LEARN|ENGINEER/i.test(goal) ? 8 : 0;
      const riskFit = 6 - Math.abs(clamp(Number(agent.riskTolerance) || 0.5, 0, 1) - 0.55) * 12;
      const motive = goalFit + clamp(Number(agent.ambition || 0.5), 0, 1) * 10
        + riskFit * (demand.serviceType === 'trading_service' ? 1 : 0.25)
        + Math.max(-8, Math.min(8, beliefEstimate * 8)) + memoryOutcome * 2
        + Math.max(-4, Math.min(4, Number(relationToService?.trust || 0) * 0.2))
        - Math.min(18, Number(demand.supplyCount) * 3);
      options.push({ id: `business:found:${demand.serviceType}`, action: 'business_found',
        targetLocation: agent.location,
        goal: `Evaluate committing ${FOUNDER_CAPITAL} simulated USDC to meet ${serviceGoal}; estimated capability fit ${capability.score.toFixed(1)}.`,
        businessProposal: proposal, score: 28 + Math.min(30, Number(demand.unmetCount) * 6)
          + capability.score * 0.22 + motive - Math.max(0, 45 - capability.score) * 0.28
          - (demand.awarenessConfidence ? (1 - Number(demand.awarenessConfidence)) * 6 : 0) });
    }
    if (partner && energy >= 20 && food >= 15 && partner.teamScore > capability.ownScore) {
      const goalService = spec.label.toLowerCase();
      const organizationName = `${String(agent.name || 'Resident').slice(0, 32)} ${spec.type} Partnership`;
      options.push({ id: `business:seek-cofounder:${demand.serviceType}:${partner.partnerId}`,
        action: 'business_seek_cofounder', targetLocation: agent.location,
        goal: `Invite trusted collaborator ${partner.partnerName || partner.partnerId} to combine capabilities for ${goalService} demand.`,
        cofounderProposal: { partnerId: partner.partnerId, partnerName: partner.partnerName,
          projectId: partner.projectId, serviceType: demand.serviceType, capabilityFit: partner.teamScore,
          organizationProposal: { name: organizationName,
            purpose: `Combine resident capabilities to respond to observed ${goalService} demand.`,
            projectId: partner.projectId, inviteAgentId: partner.partnerId } },
        score: 31 + Math.min(24, Number(demand.unmetCount) * 5) + partner.teamScore * 0.25
          + clamp(Number(partner.trust) || 0, 0, 100) * 0.08 + clamp(Number(agent.ambition) || 0, 0, 1) * 8 });
    }
    if (capability.ownScore < 70 && energy >= 15 && food >= 8) {
      const targetSkill = spec.skill;
      const practicedRecently = memories.some((memory) => memory.metadata?.action === 'business_skill_practice'
        && memory.metadata?.skill === targetSkill && worldMinutes - Number(memory.worldMinutes || 0) < 720);
      if (!practicedRecently) options.push({ id: `business:skill-practice:${demand.serviceType}:${targetSkill}`,
        action: 'business_skill_practice', targetLocation: context.scenes?.find((scene) => scene.status === 'active'
          && (targetSkill === 'research' ? ['library','observatory'].includes(scene.sceneType)
            : targetSkill === 'engineering' ? ['workshop','data_center'].includes(scene.sceneType)
              : targetSkill === 'social' ? ['cafe','garden','commons'].includes(scene.sceneType) : scene.sceneType === 'exchange'))?.name
            || agent.location,
        goal: `Practice ${targetSkill} because ${demand.unmetCount} unmet ${spec.type} service requests could become a future opportunity.`,
        preparationSkill: targetSkill, preparationServiceType: demand.serviceType,
        score: 27 + Math.min(20, Number(demand.unmetCount) * 4)
          + Math.min(24, (70 - capability.ownScore) * 0.34)
          + (goal.includes(targetSkill.toUpperCase()) ? 8 : 0) });
    }
  }

  for (const job of jobs) {
    if (job.status === 'open' && job.businessStatus === 'active' && !employed
        && job.founderAgentId !== agent.agentId && cash >= 0 && energy >= 25 && food >= 15
        && !(context.applications || []).some((application) => application.agent_id === agent.agentId
          && application.job_id === job.id)) {
      const required = job.requiredSkill;
      const skillValue = required ? Number(skills[required]) || 0 : 0;
      const wage = Number(job.wage_usdc || job.wage || 0);
      const businessCash = Number(job.businessCash) || 0;
      if (wage > 0 && businessCash >= wage * 8) options.push({
        id: `business:apply:${job.id}`, action: 'business_apply', targetLocation: agent.location,
        goal: `Apply for ${job.role} at ${job.businessName}; the wage is funded by the employer's business account.`,
        jobId: job.id, businessId: job.business_id || job.businessId,
        score: 40 + Math.min(16, skillValue * 0.2) + Math.min(10, wage * 0.4)
          + (cash < 2_500 ? 8 : 0) + (goal.includes('WEALTH') ? 8 : 0)
          + (goal.includes('ENGINEERING') && required === 'engineering' ? 8 : 0)
      });
    }
  }
  for (const application of context.applications || []) {
    if ((application.agent_id === agent.agentId || application.agentId === agent.agentId)
        && application.status === 'pending' && application.businessStatus === 'active'
        && application.jobStatus === 'open') {
      const age = Math.max(0, worldMinutes - Number(application.created_world_time ?? application.createdWorldTime ?? worldMinutes));
      if (age >= 720) options.push({ id: `business:withdraw:${application.id}`, action: 'business_withdraw',
        targetLocation: agent.location,
        goal: `Withdraw your pending application for ${application.role || 'the open role'} at ${application.businessName || 'the business'} if you no longer want it.`,
        applicationId: application.id, businessId: application.business_id || application.businessId,
        score: 16 + Math.min(8, (age - 720) / 270) });
    }
  }
  for (const application of context.applications || []) if (application.founderAgentId === agent.agentId
      && application.status === 'pending' && application.businessStatus === 'active' && application.jobStatus === 'open') {
    const relation = relationships.find((item) => item.otherAgentId === application.agent_id);
    const applicantSkill = Number(context.residentSkills?.[application.agent_id]?.[application.requiredSkill]) || 0;
    const wage = Number(application.wage || 0);
    const payrollRunway = wage > 0 ? Number(application.businessCash || 0) / wage : 0;
    if (wage > 0 && payrollRunway >= 8) options.push({ id: `business:hire:${application.id}`, action: 'business_hire', targetLocation: agent.location,
      goal: `Review ${application.agent_name || 'a resident'}'s application for ${application.role}, considering skill and working capital.`,
      applicationId: application.id, businessId: application.business_id,
      score: 48 + Math.min(16, applicantSkill * 0.2) + Math.min(10, payrollRunway * 0.5)
        + Math.max(-4, Number(relation?.trust || 0) * 0.2) });
    options.push({ id: `business:reject:${application.id}`, action: 'business_reject', targetLocation: agent.location,
      goal: `Decline ${application.agent_name || 'the resident'}'s application if the role, skill fit, or business finances do not align.`,
      applicationId: application.id, businessId: application.business_id,
      score: 8 + Math.max(0, 12 - applicantSkill * 0.2)
        + (Number(application.businessCash) < Number(application.wage) * 8 ? 8 : 0)
        + (Number(relation?.trust || 0) < 0 ? 6 : 0) });
  }
  if (employed && energy >= 20 && food >= 12) {
    const service = services.find((item) => item.business_id === employed.business_id && item.active);
    const unmetDemand = Number((context.demand || []).find((item) => item.serviceType === service?.service_type)?.unmetCount) || 0;
    if (service && employed.businessStatus === 'active' && Number(employed.wage_usdc || employed.wage) > 0
        && Number(employed.businessCash) >= Number(employed.wage_usdc || employed.wage) && unmetDemand > 0) {
      options.push({ id: `business:work:${employed.business_id}:${Math.floor(worldMinutes / 360)}`,
        action: 'business_work', targetLocation: employed.placeName || agent.location,
        goal: `Complete a paid ${employed.role} shift at ${employed.businessName}, producing a real service unit.`,
        businessId: employed.business_id, serviceId: service.id, employmentId: employed.id,
        score: 30 + (goal.includes('WEALTH') ? 8 : 0) + Number(skills[employed.requiredSkill] || 0) * 0.14
          + unmetDemand * 5 });
    }
  }
  if (employed && (employed.businessStatus !== 'active'
      || Number(employed.businessCash || 0) < Number(employed.wage_usdc || employed.wage) * 3
      || (jobs || []).some((job) => job.status === 'open' && job.business_id !== employed.business_id
        && Number(job.businessCash) >= Number(job.wage_usdc) * 3))) {
    options.push({ id: `business:leave:${employed.id}`, action: 'business_leave', targetLocation: agent.location,
      goal: `Leave ${employed.businessName} if its payroll is unstable or a better funded role fits your skills.`,
      employmentId: employed.id, businessId: employed.business_id,
      score: 17 + (employed.businessStatus !== 'active' ? 18 : 0)
        + (Number(employed.businessCash || 0) < Number(employed.wage_usdc || employed.wage) * 3 ? 10 : 0)
        + (goal.includes('WEALTH') ? 4 : 0) });
  }
  if (!employed) for (const business of activeOwned) {
    const service = services.find((item) => item.business_id === business.id && item.active);
    if (!service || energy < 20 || food < 12) continue;
    const wage = Number((jobs || []).find((job) => job.business_id === business.id && job.status === 'open')?.wage_usdc || 0);
    if ((Number(business.cash_balance) || 0) < wage) continue;
    const serviceType = service.service_type;
    const demandRow = (context.demand || []).find((item) => item.serviceType === serviceType);
    const stockUnits = Math.max(0, Number(service.stock_units ?? service.stockUnits) || 0);
    const outstandingDemand = outstandingServiceDemand(demandRow, stockUnits);
    if (outstandingDemand <= 0) continue;
    const skill = businessServiceSkill(serviceType);
    const skillValue = Number(skills[skill]) || 0;
    options.push({ id: `business:work:${business.id}:${Math.floor(worldMinutes / 180)}`,
      action: 'business_work', targetLocation: service.placeName || agent.location,
      goal: `Produce one ${service.name} unit for ${business.name}; only funded employees receive wages.`,
      businessId: business.id, serviceId: service.id,
      score: clamp(50 + Math.min(20, outstandingDemand * 4) + (stockUnits === 0 ? 12 : Math.min(8, outstandingDemand * 3))
        + skillValue * 0.08 + (goal.includes('WEALTH') ? 4 : 0), 0, 100) });
  }

  for (const service of services) {
    const business = businesses.find((item) => item.id === service.business_id);
    const indirectlyOwned = business && isBusinessBeneficiary(agent.agentId, business, context.ownership || []);
    if (service.founderAgentId === agent.agentId || indirectlyOwned
        || Number(service.stock_units ?? service.stockUnits) <= 0 || cash <= 0) continue;
    const serviceType = service.service_type || service.serviceType;
    const need = serviceType === 'food_service' ? Number(agent.food) < 76
      : serviceType === 'social_service' ? Number(agent.social) < 62 || goal.includes('COMMUNITY') || goal.includes('RELATIONSHIP')
        : serviceType === 'trading_service' ? goal.includes('TRADING') || goal.includes('WEALTH')
          : serviceType === 'engineering_service' ? goal.includes('ENGINEERING') || Number(agent.knowledge) < 45
            : Number(agent.knowledge) < 62 || goal.includes('RESEARCH') || goal.includes('LEARN');
    if (!need) continue;
    const relation = relationships.find((item) => item.otherAgentId === service.founderAgentId);
    const demandRow = (context.demand || []).find((item) => item.serviceType === serviceType);
    const pricingContext = { demand: demandRow?.demandCount || 1, supply: demandRow?.supplyCount || 0,
      relationship: relation ? Number(relation.familiarity) * 0.3 + Number(relation.trust) * 0.7 : 0,
      wealth: cash, priceSensitivity: Number(agent.priceSensitivity ?? 0.5) };
    const quote = quoteBusinessPrice({ basePrice: service.base_price_usdc || service.basePriceUsdc,
      ...pricingContext, reputation: service.businessReputation || 0 });
    if (cash < Number(quote)) continue;
    const benefitUtility = serviceNeedValue(agent, serviceType, skills);
    const pricePenalty = Number(quote) * (cash < 1_000 ? 0.24 : cash < 3_000 ? 0.12 : 0.06);
    const goalFit = serviceType === 'food_service' ? 0
      : serviceType === 'social_service' ? (goal.includes('COMMUNITY') || goal.includes('RELATIONSHIP') ? 12 : 0)
        : serviceType === 'trading_service' ? (goal.includes('TRADING') || goal.includes('WEALTH') ? 18 : 0)
          : serviceType === 'engineering_service' ? (goal.includes('ENGINEERING') ? 12 : 0)
            : (goal.includes('RESEARCH') || goal.includes('LEARN') ? 12 : 0);
    const pastOutcome = memories.filter((memory) => memory.relatedAgentId === service.founderAgentId
      && memory.memoryType === 'business').length * 1.5;
    const serviceExperience = (agent.beliefs || []).find((belief) => belief.subjectType === 'business'
      && belief.subjectKey === String(service.business_id) && belief.beliefKey === 'service_experience');
    const experienceAge = Math.max(0, worldMinutes - Number(serviceExperience?.updatedWorldMinutes
      ?? serviceExperience?.updated_world_minutes ?? worldMinutes));
    const experienceFreshness = Math.max(0, 1 - experienceAge / 10_080);
    const experienceValue = clamp(Number(serviceExperience?.estimate) || 0, -1, 1)
      * clamp(Number(serviceExperience?.confidence) || 0, 0, 1) * experienceFreshness * 12;
    const reputationValue = clamp(Number(service.businessReputation) || 0, -100, 100) * 0.12;
    const relationshipValue = relation ? clamp(Number(relation.trust) * 0.16
      + Number(relation.familiarity) * 0.04, -8, 8) : 0;
    const travelCost = serviceDistancePenalty(agent, service, context.scenes || []);
    options.push({ id: `business:service:${service.id}`, action: 'business_service',
      targetLocation: service.placeName || agent.location,
      goal: `Choose whether to buy ${service.name} from ${service.businessName} at ${quote} simulated USDC.`,
      serviceId: service.id, businessId: service.business_id, serviceType,
      maxPriceUsdc: quote, pricingContext, score: 32 + benefitUtility * 0.65 + goalFit + reputationValue
        + relationshipValue + Math.min(6, pastOutcome) + experienceValue - pricePenalty - travelCost });
  }

  for (const project of context.economicProjects || []) {
    const member = (agent.activeProjects || []).some((item) => item.id === project.id);
    const invested = (project.owners || []).some((owner) => owner.ownerType === 'resident' && owner.ownerId === agent.agentId);
    if (member && !invested && ['active','recruiting'].includes(project.status) && cash >= 200) {
      const relation = relationships.find((item) => item.otherAgentId === project.creator_agent_id);
      const projectBelief = (agent.beliefs || []).find((belief) => belief.subjectType === 'project'
        && belief.subjectKey === project.id && belief.beliefKey === 'economic_outcome');
      options.push({ id: `project:invest:${project.id}`, action: 'project_invest', targetLocation: agent.location,
        goal: `Consider contributing 100 simulated USDC to ${project.title} for a recorded project ownership share.`,
        projectId: project.id, amountUsdc: '100.00000000',
        score: 12 + Number(projectBelief?.estimate || 0) * Number(projectBelief?.confidence || 0) * 8
          + Number(relation?.trust || 0) * 0.25 + (goal.includes('WEALTH') ? 5 : 0)
          + Math.min(5, Number(project.cash_balance || 0) / 1000) });
    }
    const projectShare = Number((project.owners || []).find((owner) => owner.ownerType === 'resident'
      && owner.ownerId === agent.agentId)?.share || 0);
    if (projectShare > 0 && Number(project.cash_balance || 0) >= 26
        && Number(project.realized_profit_usdc || 0) >= 1
        && worldMinutes - Number(project.last_distribution_world_time || 0) >= 1_440) {
      options.push({ id: `project:distribute:${project.id}:${Math.floor(worldMinutes / 1_440)}`,
        action: 'project_distribute', targetLocation: agent.location, projectId: project.id,
        goal: `Release a small share of project revenue to project owners while retaining a treasury buffer.`,
        score: 14 + projectShare * 8 + (goal.includes('WEALTH') ? 4 : 0) });
    }
  }

  for (const business of activeOwned) {
    const cashOnHand = Number(business.cash_balance) || 0;
    const profit = Number(business.revenue || 0) - Number(business.expenses || 0);
    const ownedShares = businessBeneficialShare(agent.agentId, business, context.ownership || []);
    if (cashOnHand >= 500 && profit >= 100 && ownedShares > 0 && context.worldMinutes - Number(business.last_distribution_world_time || 0) >= 1_440) {
      options.push({ id: `business:distribute:${business.id}:${Math.floor(worldMinutes / 1_440)}`,
        action: 'business_distribute', targetLocation: agent.location,
        goal: `Distribute only a small share of realized operating profit while retaining working capital.`,
        businessId: business.id, score: 18 + Math.min(16, profit / 100) + ownedShares * 8 });
    }
    if (cashOnHand >= 100 && ownedShares < 1 && context.worldMinutes - Number(business.founded_world_time) > 1_440) {
      // Existing owners do not make a secondary sale in V4; only outside residents see investment candidates below.
    }
    if (Number(business.consecutive_loss_days) >= 2
        && (business.founder_agent_id === agent.agentId || ownedShares >= 0.5)) {
      options.push({ id: `business:close:${business.id}`, action: 'business_close', targetLocation: agent.location,
        goal: `Review whether ${business.name} should stop before further costs erode its remaining capital.`,
        businessId: business.id, score: 18 + Number(business.consecutive_loss_days || 0) * 4
          + (cashOnHand < RUN_COST_PER_DAY ? 8 : 0) });
    }
    for (const service of services.filter((item) => item.business_id === business.id)) {
      const demandRow = (context.demand || []).find((item) => item.serviceType === service.service_type);
      const due = worldMinutes - Number(service.price_review_world_time || 0) >= 1_440;
      if (due && demandRow) {
        const scarce = Number(demandRow.demandCount) > Number(demandRow.supplyCount) * 2;
        options.push({ id: `business:price:${service.id}:${Math.floor(worldMinutes / 1_440)}`,
          action: 'business_price', targetLocation: agent.location,
          goal: scarce ? 'Review raising the offer price modestly because observed demand exceeds available supply.'
            : 'Review lowering the offer price modestly to attract residents when supply exceeds demand.',
          serviceId: service.id, businessId: business.id, direction: scarce ? 'raise' : 'lower',
          score: 14 + Math.abs(Number(demandRow.demandCount) - Number(demandRow.supplyCount)) * 3
            + Number(agent.ambition || 0.5) * 4 });
      }
    }
  }
  for (const business of businesses.filter((item) => item.status === 'active')) {
    const owner = (business.owners || []).find((item) => item.ownerType === 'resident' && item.ownerId === agent.agentId);
    const relation = relationships.find((item) => item.otherAgentId === business.founder_agent_id);
    const trusted = Number(relation?.trust || 0) >= 2 || memories.some((memory) => memory.relatedAgentId === business.founder_agent_id
      && memory.memoryType === 'business');
    if (owner || business.founder_agent_id === agent.agentId || !trusted || cash < 200
        || Number(business.revenue || 0) <= Number(business.expenses || 0)) continue;
    const expected = Number(business.cash_balance || 0);
    if (expected < 100) continue;
    options.push({ id: `business:invest:${business.id}`, action: 'business_invest', targetLocation: agent.location,
      goal: `Consider a bounded simulated USDC investment in ${business.name} based on its history and a trusted relationship.`,
      businessId: business.id, amountUsdc: '100.00000000',
      score: 14 + Number(business.reputation || 0) * 0.2 + Number(relation?.trust || 0) * 0.35
        + Math.min(12, (Number(business.revenue || 0) - Number(business.expenses || 0)) / 100)
        + (goal.includes('WEALTH') ? 5 : 0) });
  }
  return options.filter((item) => Number.isFinite(item.score)).sort((left, right) => right.score - left.score);
}

export async function practiceWorldBusinessCapability(client, { worldId, agentId, skill, serviceType, actionId, worldTime }) {
  if (!['social','trading','research','engineering'].includes(skill) || !Object.hasOwn(SERVICE_INFO, serviceType)) {
    throw error('BUSINESS_PREPARATION_INVALID', 400);
  }
  const eventKey = `business-capability-practice:${agentId}:${actionId}`;
  const history = await client.query(`INSERT INTO world_history(world_id,event_key,event_type,actor_agent_id,entity_type,
      entity_id,world_time,title,detail,metadata)
    VALUES($1,$2,'business_capability_practiced',$3,'business',NULL,$4,$5,$6,$7::jsonb)
    ON CONFLICT(world_id,event_key) DO NOTHING RETURNING id`, [worldId, eventKey, agentId, worldTime,
    `Practiced ${skill} for ${SERVICE_INFO[serviceType].type} services.`,
    `Practiced ${skill} after observing unmet ${SERVICE_INFO[serviceType].type} service demand.`,
    JSON.stringify({ skill, serviceType, actionId })]);
  if (!history.rowCount) {
    const existing = await client.query('SELECT id FROM world_history WHERE world_id=$1 AND event_key=$2', [worldId, eventKey]);
    return { id: existing.rows[0]?.id || null, skill, serviceType, skillGain: 0, idempotent: true };
  }
  await client.query(`INSERT INTO world_agent_skills(world_id,agent_id,skill_name,skill_value,actions_completed)
    VALUES($1,$2,$3,1.5,1) ON CONFLICT(world_id,agent_id,skill_name) DO UPDATE SET
      skill_value=LEAST(100,world_agent_skills.skill_value+1.5),
      actions_completed=world_agent_skills.actions_completed+1,updated_at=now()`, [worldId, agentId, skill]);
  return { id: history.rows[0].id, skill, serviceType, skillGain: 1.5, idempotent: false };
}

async function recordHistory(client, { worldId, eventKey, eventType, actorAgentId, entityType, entityId,
  worldTime, title, detail, metadata = {} }) {
  await client.query(`INSERT INTO world_history(world_id,event_key,event_type,actor_agent_id,entity_type,entity_id,
      world_time,title,detail,metadata)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb) ON CONFLICT(world_id,event_key) DO NOTHING`,
  [worldId, eventKey, eventType, actorAgentId || null, entityType, entityId || null, worldTime,
    String(title).slice(0, 120), String(detail).slice(0, 600), JSON.stringify(metadata)]);
}

async function readBusiness(client, worldId, businessId, forUpdate = false) {
  const result = await client.query(`SELECT business.*,account.balance::text AS cash_balance
    FROM world_businesses business LEFT JOIN world_economic_accounts account
      ON account.world_id=business.world_id AND account.account_key='business:'||business.id::text AND account.asset_symbol='USDC'
    WHERE business.world_id=$1 AND business.id=$2 ${forUpdate ? 'FOR UPDATE OF business' : ''}`,
  [worldId, businessId]);
  if (!result.rowCount) throw error('BUSINESS_NOT_FOUND', 404);
  return result.rows[0];
}

export async function foundWorldBusiness(client, { worldId, agentId, actionId, proposal, worldTime }) {
  if (!proposal || !validText(proposal.name, 3, 80) || !validText(proposal.businessType, 2, 48)
      || !/^[a-z][a-z0-9_]{1,47}$/.test(proposal.businessType)
      || !validText(proposal.purpose, 12, 400) || !Object.hasOwn(SERVICE_INFO, proposal.serviceType)
      || !validText(proposal.serviceName, 3, 96) || !validText(proposal.serviceDescription, 12, 400)) {
    throw error('BUSINESS_PROPOSAL_INVALID', 400);
  }
  const existing = await client.query(`SELECT id,name,status FROM world_businesses
    WHERE world_id=$1 AND founder_agent_id=$2 AND action_id=$3`, [worldId, agentId, actionId]);
  if (existing.rowCount) return { ...existing.rows[0], idempotent: true };
  if (proposal.capitalSource?.type && !['resident','organization','project'].includes(proposal.capitalSource.type)) {
    throw error('BUSINESS_CAPITAL_SOURCE_INVALID', 400);
  }
  const capitalSource = proposal.capitalSource?.type === 'organization'
    ? { accountType: 'organization', ownerId: proposal.capitalSource.ownerId }
    : proposal.capitalSource?.type === 'project'
      ? { accountType: 'project', ownerId: proposal.capitalSource.ownerId }
      : { accountType: 'resident', ownerId: agentId };
  if (capitalSource.accountType === 'organization') {
    await assertOrganizationContributor(client, worldId, capitalSource.ownerId, agentId);
  } else if (capitalSource.accountType === 'project') {
    const projectMember = await client.query(`SELECT 1 FROM world_project_members member
      JOIN world_projects project ON project.world_id=member.world_id AND project.id=member.project_id
      WHERE member.world_id=$1 AND member.project_id=$2 AND member.agent_id=$3
        AND member.status='active' AND project.status='active' FOR UPDATE OF member,project`,
    [worldId, capitalSource.ownerId, agentId]);
    if (!projectMember.rowCount) throw error('ACTIVE_PROJECT_MEMBERSHIP_REQUIRED', 403);
  }
  if (proposal.placeId) {
    const place = await client.query(`SELECT 1 FROM world_scenes WHERE world_id=$1 AND id=$2 AND status='active' FOR UPDATE`,
      [worldId, proposal.placeId]);
    if (!place.rowCount) throw error('BUSINESS_PLACE_UNAVAILABLE', 404);
  }
  if (proposal.projectId && (capitalSource.accountType !== 'project' || proposal.projectId !== capitalSource.ownerId)) {
    throw error('BUSINESS_PROJECT_SOURCE_MISMATCH', 400);
  }
  const cash = await getEconomicAccount(client, { worldId, ...capitalSource, asset: 'USDC', forUpdate: true });
  const capital = formatUnits(parsePositiveUnits(String(proposal.capitalUsdc || FOUNDER_CAPITAL)));
  if (!cash || parsePositiveUnits(capital) < parsePositiveUnits(FOUNDER_CAPITAL)
      || Number(cash.balance) < MIN_FOUNDER_CASH || parsePositiveUnits(cash.balance) < parsePositiveUnits(capital)) {
    throw error('INSUFFICIENT_FOUNDER_CAPITAL');
  }
  const id = randomUUID();
  const inserted = await client.query(`INSERT INTO world_businesses(id,world_id,founder_agent_id,name,business_type,purpose,
      place_id,source_project_id,status,valuation_usdc,founded_world_time,action_id,metadata)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,'active',$9,$10,$11,$12::jsonb)
    RETURNING id,name,business_type AS "businessType",status,founded_world_time AS "foundedWorldTime"`,
  [id, worldId, agentId, proposal.name.trim(), proposal.businessType, proposal.purpose.trim(), proposal.placeId || null,
    proposal.projectId || (capitalSource.accountType === 'project' ? capitalSource.ownerId : null),
    capital, worldTime, actionId, JSON.stringify({ serviceType: proposal.serviceType,
      foundingReason: proposal.foundingReason || 'observed_unmet_demand',
      capabilityFit: Number.isFinite(Number(proposal.capabilityFit)) ? Number(proposal.capabilityFit) : null,
      capabilityTeamAgentIds: Array.isArray(proposal.capabilityTeamAgentIds) ? proposal.capabilityTeamAgentIds : [agentId],
      founderSkillProfile: proposal.founderSkillProfile && typeof proposal.founderSkillProfile === 'object'
        ? proposal.founderSkillProfile : {} })]);
  const businessAccount = await ensureEconomicAccount(client, { worldId, accountType: 'business', ownerId: id, key: `business:${id}` });
  const ownerType = capitalSource.accountType;
  await transferBetweenAccounts(client, { worldId,
    source: capitalSource, destination: { accountType: 'business', ownerId: id, key: `business:${id}` },
    amount: capital, transactionType: 'business_found', reason: `Founding capital committed to ${proposal.name}.`,
    worldTime, actionId: `business-capital:${actionId}`, referenceId: id });
  await client.query(`INSERT INTO world_economic_ownership(world_id,asset_type,asset_id,owner_type,owner_id,share,invested_usdc,acquired_world_time)
    VALUES($1,'business',$2,$3,$4,1,$5,$6)`, [worldId, id, ownerType, capitalSource.ownerId, capital, worldTime]);
  const service = (await client.query(`INSERT INTO world_business_services(world_id,business_id,service_type,name,description,
      base_price_usdc,stock_units,action_id,created_world_time)
    VALUES($1,$2,$3,$4,$5,$6,0,$7,$8) RETURNING id`, [worldId, id, proposal.serviceType, proposal.serviceName.trim(),
    proposal.serviceDescription.trim(), proposal.basePriceUsdc || SERVICE_INFO[proposal.serviceType].base,
    `${actionId}:service`, worldTime])).rows[0];
  await client.query(`INSERT INTO world_business_jobs(world_id,business_id,role,required_skill,wage_usdc,status,created_world_time,action_id)
    VALUES($1,$2,$3,$4,'15.00000000','open',$5,$6)`, [worldId, id,
    `${SERVICE_INFO[proposal.serviceType].skill[0].toUpperCase()}${SERVICE_INFO[proposal.serviceType].skill.slice(1)} Associate`,
    SERVICE_INFO[proposal.serviceType].skill, worldTime, `${actionId}:opening`]);
  await recordHistory(client, { worldId, eventKey: `business-founded:${id}`, eventType: 'business_founded',
    actorAgentId: agentId, entityType: 'business', entityId: id, worldTime, title: proposal.name,
    detail: `${proposal.name} opened with ${capital} simulated USDC of founder capital and offers ${proposal.serviceName}.`,
    metadata: { serviceId: service.id, serviceType: proposal.serviceType, capital, accountId: businessAccount.id } });
  return { ...inserted.rows[0], serviceId: service.id, capitalUsdc: capital, idempotent: false };
}

export async function applyToWorldBusinessJob(client, { worldId, jobId, agentId, actionId, worldTime }) {
  const job = await client.query(`SELECT job.*,business.status AS "businessStatus",business.founder_agent_id AS "founderAgentId",
      account.balance::text AS "businessCash"
    FROM world_business_jobs job JOIN world_businesses business ON business.id=job.business_id
    LEFT JOIN world_economic_accounts account ON account.world_id=job.world_id
      AND account.account_key='business:'||business.id::text AND account.asset_symbol='USDC'
    WHERE job.world_id=$1 AND job.id=$2 AND job.status='open' AND business.status='active' FOR UPDATE OF job,business`,
  [worldId, jobId]);
  if (!job.rowCount) throw error('BUSINESS_JOB_UNAVAILABLE', 404);
  const row = job.rows[0];
  if (row.founderAgentId === agentId) throw error('FOUNDER_CANNOT_APPLY_TO_OWN_ROLE');
  const requiredPayrollReserve = parsePositiveUnits(String(row.wage_usdc)) * 8n;
  if (parsePositiveUnits(String(row.businessCash || '0'), { allowZero: true }) < requiredPayrollReserve) {
    throw error('BUSINESS_CANNOT_FUND_JOB');
  }
  const existing = await client.query(`SELECT id,status FROM world_business_applications WHERE job_id=$1 AND agent_id=$2`, [jobId, agentId]);
  if (existing.rowCount) return { id: existing.rows[0].id, status: existing.rows[0].status, idempotent: true };
  const inserted = await client.query(`INSERT INTO world_business_applications(world_id,job_id,business_id,agent_id,status,
      action_id,created_world_time,updated_world_time)
    VALUES($1,$2,$3,$4,'pending',$5,$6,$6) RETURNING id,status`,
  [worldId, jobId, row.business_id, agentId, actionId, worldTime]);
  return { ...inserted.rows[0], businessId: row.business_id, jobId };
}

export async function expirePendingWorldBusinessApplications(client, { worldId, worldTime }) {
  const expired = await client.query(`WITH due AS MATERIALIZED (
      SELECT application.id,application.agent_id,application.business_id,application.job_id,
        CASE WHEN business.status<>'active' THEN 'business_unavailable'
          WHEN job.status='filled' THEN 'job_filled'
          WHEN job.status='closed' THEN 'job_closed'
          ELSE 'application_ttl' END AS reason
      FROM world_business_applications application
      JOIN world_business_jobs job ON job.world_id=application.world_id AND job.id=application.job_id
      JOIN world_businesses business ON business.world_id=application.world_id AND business.id=application.business_id
      WHERE application.world_id=$1 AND application.status='pending'
        AND (business.status<>'active' OR job.status IN ('filled','closed')
          OR application.created_world_time<=$2::bigint-$3::bigint)
      ORDER BY application.created_world_time,application.id
      FOR UPDATE OF application SKIP LOCKED
    ), updated AS (
      UPDATE world_business_applications application SET status='expired',updated_world_time=$2
      FROM due WHERE application.world_id=$1 AND application.id=due.id
      RETURNING application.id,application.agent_id,application.business_id,application.job_id
    )
    SELECT updated.id,updated.agent_id AS "applicantId",updated.business_id AS "businessId",
      updated.job_id AS "jobId",due.reason
    FROM updated JOIN due ON due.id=updated.id ORDER BY updated.id`,
  [worldId, worldTime, BUSINESS_APPLICATION_TTL_WORLD_MINUTES]);
  for (const row of expired.rows) {
    await client.query(`INSERT INTO world_events(world_id,actor_id,event_type,data,action_id)
      VALUES($1,$2,'business.application_expired',$3,$4) ON CONFLICT(world_id,actor_id,action_id) DO NOTHING`,
    [worldId, row.applicantId, { applicationId: row.id, businessId: row.businessId,
      jobId: row.jobId, reason: row.reason, worldTime }, `business-application-expired:${row.id}`]);
  }
  return { expired: expired.rowCount, applications: expired.rows };
}

export async function withdrawWorldBusinessApplication(client, { worldId, applicationId, agentId, actionId, worldTime }) {
  const application = await client.query(`SELECT application.id,application.agent_id,application.business_id,
      application.job_id,application.status,application.action_id,business.name AS "businessName",job.role
    FROM world_business_applications application
    JOIN world_businesses business ON business.world_id=application.world_id AND business.id=application.business_id
    JOIN world_business_jobs job ON job.world_id=application.world_id AND job.id=application.job_id
    WHERE application.world_id=$1 AND application.id=$2 FOR UPDATE OF application`, [worldId, applicationId]);
  if (!application.rowCount) throw error('BUSINESS_APPLICATION_NOT_FOUND', 404);
  const row = application.rows[0];
  if (row.agent_id !== agentId) throw error('BUSINESS_APPLICATION_APPLICANT_REQUIRED', 403);
  if (row.status === 'withdrawn' && row.action_id === actionId) {
    return { id: row.id, status: 'withdrawn', businessId: row.business_id, jobId: row.job_id, idempotent: true };
  }
  if (row.status !== 'pending') throw error('BUSINESS_APPLICATION_NOT_PENDING');
  await client.query(`UPDATE world_business_applications SET status='withdrawn',action_id=$3,updated_world_time=$4
    WHERE world_id=$1 AND id=$2`, [worldId, applicationId, actionId, worldTime]);
  await client.query(`INSERT INTO world_events(world_id,actor_id,event_type,data,action_id)
    VALUES($1,$2,'business.application_withdrawn',$3,$4) ON CONFLICT(world_id,actor_id,action_id) DO NOTHING`,
  [worldId, agentId, { applicationId, businessId: row.business_id, jobId: row.job_id,
    businessName: row.businessName, role: row.role, worldTime }, actionId]);
  return { id: applicationId, status: 'withdrawn', businessId: row.business_id, jobId: row.job_id, idempotent: false };
}

export async function leaveWorldBusinessJob(client, { worldId, employmentId, agentId, actionId, worldTime }) {
  const eventKey = `business-employment-left:${actionId}`;
  const prior = await client.query(`SELECT entity_id AS "employmentId",metadata FROM world_history
    WHERE world_id=$1 AND event_key=$2`, [worldId, eventKey]);
  if (prior.rowCount) return { employmentId: prior.rows[0].employmentId, ...prior.rows[0].metadata, idempotent: true };
  const employment = await client.query(`SELECT employment.*,business.name AS "businessName",business.status AS "businessStatus",
      job.role,job.id AS "jobId"
    FROM world_business_employment employment JOIN world_businesses business
      ON business.world_id=employment.world_id AND business.id=employment.business_id
    JOIN world_business_jobs job ON job.world_id=employment.world_id AND job.id=employment.job_id
    WHERE employment.world_id=$1 AND employment.id=$2 AND employment.agent_id=$3 AND employment.status='active'
    FOR UPDATE OF employment,business,job`, [worldId, employmentId, agentId]);
  if (!employment.rowCount) throw error('BUSINESS_EMPLOYMENT_NOT_FOUND', 404);
  const row = employment.rows[0];
  await client.query(`UPDATE world_business_employment SET status='left',ended_world_time=$3
    WHERE world_id=$1 AND id=$2`, [worldId, employmentId, worldTime]);
  await client.query(`UPDATE world_business_jobs SET status=CASE WHEN $3='active' THEN 'open' ELSE 'closed' END
    WHERE world_id=$1 AND id=$2`, [worldId, row.jobId, row.businessStatus]);
  const metadata = { businessId: row.business_id, jobId: row.jobId, role: row.role, status: 'left' };
  await recordHistory(client, { worldId, eventKey, eventType: 'business_employment', actorAgentId: agentId,
    entityType: 'job', entityId: row.jobId, worldTime, title: `${row.businessName} role ended`,
    detail: `A resident left the ${row.role} role at ${row.businessName}.`, metadata });
  return { employmentId, ...metadata, idempotent: false };
}

export async function decideWorldBusinessApplication(client, { worldId, applicationId, founderAgentId, decision, actionId, worldTime }) {
  if (!['accept','reject'].includes(decision)) throw error('BUSINESS_APPLICATION_DECISION_INVALID', 400);
  const application = await client.query(`SELECT application.*,business.founder_agent_id AS "founderAgentId",
      job.status AS "jobStatus",job.wage_usdc::text AS wage,job.role,job.id AS "jobId",business.name AS "businessName"
    FROM world_business_applications application JOIN world_businesses business ON business.id=application.business_id
    JOIN world_business_jobs job ON job.id=application.job_id
    WHERE application.world_id=$1 AND application.id=$2
    FOR UPDATE OF application,business,job`, [worldId, applicationId]);
  if (!application.rowCount) throw error('BUSINESS_APPLICATION_NOT_FOUND', 404);
  const row = application.rows[0];
  if (row.founderAgentId !== founderAgentId) throw error('BUSINESS_OWNER_REQUIRED', 403);
  if (row.status !== 'pending') {
    if (row.action_id !== actionId) throw error('BUSINESS_APPLICATION_NOT_PENDING', 409);
    if (row.status === 'rejected') return { id: applicationId, status: 'rejected', applicantId: row.agent_id, idempotent: true };
    const employment = await client.query(`SELECT id,wage_usdc::text AS wage FROM world_business_employment
      WHERE world_id=$1 AND job_id=$2 AND agent_id=$3 AND status IN ('active','terminated')
      ORDER BY started_world_time DESC LIMIT 1`, [worldId, row.jobId, row.agent_id]);
    return { id: employment.rows[0]?.id || applicationId, applicationId, status: 'active',
      employeeId: row.agent_id, wage: employment.rows[0]?.wage || row.wage, idempotent: true };
  }
  if (decision === 'reject') {
    const updated = await client.query(`UPDATE world_business_applications SET status='rejected',action_id=$3,updated_world_time=$4
      WHERE id=$1 AND world_id=$2 RETURNING status`, [applicationId, worldId, actionId, worldTime]);
    return { id: applicationId, status: updated.rows[0].status, applicantId: row.agent_id };
  }
  const employed = await client.query(`SELECT 1 FROM world_business_employment WHERE world_id=$1 AND agent_id=$2 AND status='active'`,
  [worldId, row.agent_id]);
  if (employed.rowCount || row.jobStatus !== 'open') throw error('BUSINESS_JOB_FILLED');
  const funds = await getEconomicAccount(client, { worldId, accountType: 'business', ownerId: row.business_id, forUpdate: true });
  const requiredPayrollReserve = parsePositiveUnits(String(row.wage)) * 8n;
  if (!funds || parsePositiveUnits(funds.balance, { allowZero: true }) < requiredPayrollReserve) {
    throw error('BUSINESS_CANNOT_FUND_JOB');
  }
  const employment = await client.query(`INSERT INTO world_business_employment(world_id,business_id,job_id,agent_id,wage_usdc,status,started_world_time)
    VALUES($1,$2,$3,$4,$5,'active',$6) RETURNING id`, [worldId, row.business_id, row.jobId, row.agent_id, row.wage, worldTime]);
  await client.query(`UPDATE world_business_applications SET status='accepted',action_id=$3,updated_world_time=$4
    WHERE id=$1 AND world_id=$2`, [applicationId, worldId, actionId, worldTime]);
  await client.query(`UPDATE world_business_jobs SET status='filled' WHERE id=$1`, [row.jobId]);
  const expiredApplications = await expirePendingWorldBusinessApplications(client, { worldId, worldTime });
  await recordHistory(client, { worldId, eventKey: `business-hire:${employment.rows[0].id}`, eventType: 'business_employment',
    actorAgentId: founderAgentId, entityType: 'job', entityId: row.jobId, worldTime, title: `${row.businessName} hired a worker`,
    detail: `A resident accepted the ${row.role} job at ${row.businessName} with a ${row.wage} simulated USDC shift wage.`,
    metadata: { employmentId: employment.rows[0].id, employeeId: row.agent_id, wage: row.wage,
      expiredApplications: expiredApplications.expired } });
  return { id: employment.rows[0].id, applicationId, status: 'active', employeeId: row.agent_id, wage: row.wage,
    expiredApplications: expiredApplications.expired };
}

export async function purchaseWorldBusinessService(client, { worldId, serviceId, customerAgentId, actionId, worldTime,
  maxPriceUsdc, demand = 1, supply = 1, relationship = 0, wealth = 0, priceSensitivity = 0.5 }) {
  const prior = await client.query(`SELECT id,status,price_usdc::text AS price,transaction_id AS "transactionId"
    FROM world_business_orders WHERE world_id=$1 AND customer_agent_id=$2 AND action_id=$3`, [worldId, customerAgentId, actionId]);
  if (prior.rowCount) return { ...prior.rows[0], idempotent: true };
  const selected = await client.query(`SELECT service.*,business.name AS "businessName",business.status AS "businessStatus",
      business.reputation AS "businessReputation",business.founder_agent_id AS "founderAgentId",
      place.id AS "placeId",place.name AS "placeName",place.revenue_enabled AS "placeRevenueEnabled",
      place.revenue_share_bps AS "placeRevenueShareBps",place.status AS "placeStatus"
    FROM world_business_services service JOIN world_businesses business ON business.id=service.business_id
    LEFT JOIN world_scenes place ON place.world_id=business.world_id AND place.id=business.place_id
    WHERE service.world_id=$1 AND service.id=$2 AND service.active=true AND business.status='active'
    FOR UPDATE OF service,business`, [worldId, serviceId]);
  if (!selected.rowCount) throw error('BUSINESS_SERVICE_UNAVAILABLE', 404);
  const service = selected.rows[0];
  if (service.founderAgentId === customerAgentId) throw error('BUSINESS_OWNER_CANNOT_BE_OWN_CUSTOMER');
  if (service.placeId && service.placeStatus !== 'active') throw error('BUSINESS_VENUE_CLOSED');
  await assertNotBusinessBeneficiary(client, worldId, service.business_id, customerAgentId);
  if (service.stock_units < 1) throw error('BUSINESS_SERVICE_OUT_OF_STOCK');
  const quotedPrice = quoteBusinessPrice({ basePrice: service.base_price_usdc, demand, supply,
    reputation: service.businessReputation, relationship, wealth, priceSensitivity });
  if (maxPriceUsdc && Number(quotedPrice) > Number(maxPriceUsdc) + 1e-8) throw error('BUSINESS_PRICE_CHANGED');
  const customer = await getEconomicAccount(client, { worldId, accountType: 'resident', ownerId: customerAgentId, forUpdate: true });
  if (!customer || parsePositiveUnits(customer.balance, { allowZero: true }) < parsePositiveUnits(quotedPrice)) {
    throw error('INSUFFICIENT_SIMULATED_USDC');
  }
  const venueOwners = service.placeId && service.placeRevenueEnabled && Number(service.placeRevenueShareBps) > 0
    ? await client.query(`SELECT owner_type AS "ownerType",owner_id AS "ownerId",share::text AS share
        FROM world_economic_ownership WHERE world_id=$1 AND asset_type='place' AND asset_id=$2
        ORDER BY owner_type,owner_id`, [worldId, service.placeId]) : { rows: [] };
  const grossAmount = parsePositiveUnits(quotedPrice);
  const venueFeeAmount = venueOwners.rows.length
    ? grossAmount * BigInt(Math.min(2500, Number(service.placeRevenueShareBps))) / 10_000n : 0n;
  const venueFee = formatUnits(venueFeeAmount);
  const businessRevenue = formatUnits(grossAmount - venueFeeAmount);
  if (parsePositiveUnits(businessRevenue) <= 0n) throw error('BUSINESS_VENUE_FEE_INVALID');
  const transaction = await transferBetweenAccounts(client, { worldId,
    source: { accountType: 'resident', ownerId: customerAgentId },
    destination: { accountType: 'business', ownerId: service.business_id, key: `business:${service.business_id}` },
    amount: businessRevenue, transactionType: 'business_revenue',
    reason: `Resident purchased ${service.name} from ${service.businessName}.`, worldTime,
    actionId: `business-order-payment:${actionId}`, referenceId: serviceId,
    metadata: { serviceId, customerAgentId, businessId: service.business_id, grossPrice: quotedPrice, venueFee } });
  const venueTransactions = [];
  const venueAllocations = venueFeeAmount > 0n ? allocateProRata(venueFeeAmount, venueOwners.rows) : [];
  for (const { owner, amount } of venueAllocations) {
    const ownerShare = parsePositiveUnits(owner.share, { allowZero: true });
    if (amount <= 0n) continue;
    const placeAccount = await ensureEconomicAccount(client, { worldId, accountType: owner.ownerType,
      ownerId: owner.ownerId, key: owner.ownerType === 'project' ? `project:${owner.ownerId}` : null });
    const paid = await postEconomicTransfer(client, { worldId,
      sourceAccountId: customer.id, destinationAccountId: placeAccount.id, asset: 'USDC', amount: formatUnits(amount),
      transactionType: 'place_revenue', reason: `Venue fee for service at ${service.placeName}.`, worldTime,
      actionId: `business-order-venue:${actionId}:${owner.ownerType}:${owner.ownerId}`, referenceId: service.placeId,
      metadata: { serviceId, businessId: service.business_id, customerAgentId, ownerShare: ownerShare.toString() } });
    venueTransactions.push(paid.transactionId);
  }
  await client.query(`UPDATE world_business_services SET stock_units=stock_units-1 WHERE id=$1 AND stock_units>0`, [serviceId]);
  const benefit = SERVICE_BENEFITS[service.service_type] || { knowledge: 10 };
  const order = await client.query(`INSERT INTO world_business_orders(world_id,business_id,service_id,customer_agent_id,
      price_usdc,status,action_id,world_time,benefit,transaction_id)
    VALUES($1,$2,$3,$4,$5,'fulfilled',$6,$7,$8::jsonb,$9) RETURNING id`,
  [worldId, service.business_id, serviceId, customerAgentId, quotedPrice, actionId, worldTime,
    JSON.stringify({ serviceType: service.service_type, name: service.name, benefits: benefit,
      venueFee, venueTransactionIds: venueTransactions }), transaction.transactionId]);
  await client.query(`UPDATE world_businesses SET reputation=LEAST(1000,reputation+1),last_revenue_world_time=$3,updated_at=now()
    WHERE world_id=$1 AND id=$2`, [worldId, service.business_id, worldTime]);
  const previousOrders = await client.query(`SELECT count(*)::int AS count FROM world_business_orders WHERE business_id=$1 AND id<>$2`,
    [service.business_id, order.rows[0].id]);
  await recordHistory(client, { worldId, eventKey: `business-customer:${order.rows[0].id}`,
    eventType: Number(previousOrders.rows[0]?.count || 0) === 0 ? 'business_first_customer' : 'business_revenue',
    actorAgentId: customerAgentId, entityType: 'order', entityId: order.rows[0].id, worldTime, title: service.businessName,
    detail: `${service.businessName} earned ${quotedPrice} simulated USDC from a resident service purchase.`,
    metadata: { businessId: service.business_id, serviceId, customerAgentId, amount: quotedPrice } });
  return { orderId: order.rows[0].id, businessId: service.business_id, serviceId, status: 'fulfilled',
    priceUsdc: quotedPrice, transactionId: transaction.transactionId,
    businessRevenueUsdc: businessRevenue, venueFeeUsdc: venueFee, venueTransactionIds: venueTransactions,
    benefit, serviceType: service.service_type, serviceName: service.name, businessName: service.businessName,
    businessFounderAgentId: service.founderAgentId, idempotent: false };
}

export async function completeWorldBusinessShift(client, { worldId, businessId, serviceId, agentId, employmentId = null,
  actionId, worldTime }) {
  const previous = await client.query(`SELECT production.id,service.service_type AS "serviceType",service.stock_units AS "stockUnits"
    FROM world_business_production production JOIN world_business_services service ON service.id=production.service_id
    WHERE production.world_id=$1 AND production.action_id=$2`, [worldId, actionId]);
  if (previous.rowCount) return { businessId, serviceId, serviceType: previous.rows[0].serviceType,
    stockUnits: previous.rows[0].stockUnits, idempotent: true };
  const business = await readBusiness(client, worldId, businessId, true);
  if (business.status !== 'active') throw error('BUSINESS_NOT_ACTIVE');
  const service = await client.query(`SELECT * FROM world_business_services WHERE world_id=$1 AND business_id=$2
    AND id=$3 AND active=true FOR UPDATE`, [worldId, businessId, serviceId]);
  if (!service.rowCount) throw error('BUSINESS_SERVICE_UNAVAILABLE', 404);
  let wage = null;
  if (employmentId) {
    const employment = await client.query(`SELECT * FROM world_business_employment WHERE world_id=$1 AND business_id=$2
      AND agent_id=$3 AND id=$4 AND status='active' FOR UPDATE`, [worldId, businessId, agentId, employmentId]);
    if (!employment.rowCount) throw error('BUSINESS_EMPLOYMENT_REQUIRED', 403);
    wage = employment.rows[0].wage_usdc;
    await transferBetweenAccounts(client, { worldId,
      source: { accountType: 'business', ownerId: businessId, key: `business:${businessId}` },
      destination: { accountType: 'resident', ownerId: agentId }, amount: wage,
      transactionType: 'business_wage', reason: `Paid shift wage for ${business.name}.`, worldTime,
      actionId: `business-wage:${actionId}`, referenceId: employmentId, metadata: { businessId, employmentId } });
  } else {
    if (business.founder_agent_id !== agentId) await requireBusinessOwner(client, worldId, businessId, agentId);
  }
  await client.query(`INSERT INTO world_business_production(world_id,business_id,service_id,agent_id,employment_id,
      action_id,units,world_time) VALUES($1,$2,$3,$4,$5,$6,1,$7)`,
  [worldId, businessId, serviceId, agentId, employmentId, actionId, worldTime]);
  const updated = await client.query(`UPDATE world_business_services SET stock_units=stock_units+1
    WHERE id=$1 RETURNING stock_units`, [serviceId]);
  return { businessId, serviceId, serviceType: service.rows[0].service_type,
    businessName: business.name, businessFounderAgentId: business.founder_agent_id,
    stockUnits: updated.rows[0].stock_units, wageUsdc: wage, producerAgentId: agentId, employmentId };
}

export async function investInWorldBusiness(client, { worldId, businessId, investorAgentId, amount, actionId, worldTime,
  fundingSource = { type: 'resident', ownerId: investorAgentId } }) {
  const business = await readBusiness(client, worldId, businessId, true);
  if (business.status !== 'active') throw error('BUSINESS_NOT_ACTIVE');
  const existingTransfer = await client.query(`SELECT id FROM world_economic_transactions
    WHERE world_id=$1 AND action_id=$2`, [worldId, `business-investment:${actionId}`]);
  if (existingTransfer.rowCount) {
    const existingOwner = await client.query(`SELECT share::text AS share FROM world_economic_ownership
      WHERE world_id=$1 AND asset_type='business' AND asset_id=$2 AND owner_type=$3 AND owner_id=$4`,
    [worldId, businessId, fundingSource.type, fundingSource.ownerId]);
    return { businessId, amountUsdc: formatUnits(parsePositiveUnits(String(amount))),
      share: Number(existingOwner.rows[0]?.share || 0), transactionId: existingTransfer.rows[0].id, idempotent: true };
  }
  const amountUsdc = formatUnits(parsePositiveUnits(String(amount)));
  if (parsePositiveUnits(amountUsdc) < parsePositiveUnits(MIN_INVESTMENT)) throw error('ECONOMIC_INVESTMENT_TOO_SMALL', 400);
  if (!['resident','organization'].includes(fundingSource.type)) throw error('BUSINESS_INVESTMENT_SOURCE_INVALID', 400);
  if (fundingSource.type === 'organization') {
    await assertOrganizationContributor(client, worldId, fundingSource.ownerId, investorAgentId);
    const organizationCash = await getEconomicAccount(client, { worldId, accountType: 'organization',
      ownerId: fundingSource.ownerId, forUpdate: true });
    if (!organizationCash || parsePositiveUnits(organizationCash.balance, { allowZero: true })
        < parsePositiveUnits(amountUsdc) + parsePositiveUnits('100.00000000')) throw error('INSUFFICIENT_SIMULATED_USDC');
  } else {
    const investorCash = await getEconomicAccount(client, { worldId, accountType: 'resident', ownerId: investorAgentId, forUpdate: true });
    if (!investorCash || parsePositiveUnits(investorCash.balance, { allowZero: true })
        < parsePositiveUnits(amountUsdc) + parsePositiveUnits('100.00000000')) throw error('INSUFFICIENT_SIMULATED_USDC');
  }
  const existing = await client.query(`SELECT share::text AS share FROM world_economic_ownership
    WHERE world_id=$1 AND asset_type='business' AND asset_id=$2 AND owner_type=$3 AND owner_id=$4 FOR UPDATE`,
  [worldId, businessId, fundingSource.type, fundingSource.ownerId]);
  if (existing.rowCount) throw error('BUSINESS_ALREADY_OWNED_BY_INVESTOR');
  const valuation = Math.max(Number(business.valuation_usdc) || 0, 100);
  const newShare = clamp(Number(amountUsdc) / (valuation + Number(amountUsdc)), 0.01, 0.35);
  const currentOwners = await client.query(`SELECT owner_type,owner_id,share::text AS share FROM world_economic_ownership
    WHERE world_id=$1 AND asset_type='business' AND asset_id=$2 ORDER BY owner_type,owner_id FOR UPDATE`, [worldId, businessId]);
  if (!currentOwners.rowCount || currentOwners.rows.reduce((sum, row) => sum + Number(row.share), 0) > 1.000001) {
    throw error('BUSINESS_OWNERSHIP_INVALID');
  }
  const transfer = await transferBetweenAccounts(client, { worldId,
    source: { accountType: fundingSource.type, ownerId: fundingSource.ownerId },
    destination: { accountType: 'business', ownerId: businessId, key: `business:${businessId}` },
    amount: amountUsdc, transactionType: 'business_investment', reason: `Investment in ${business.name}.`, worldTime,
    actionId: `business-investment:${actionId}`, referenceId: businessId });
  await client.query(`UPDATE world_economic_ownership SET share=share*(1-$3::numeric),updated_at=now()
    WHERE world_id=$1 AND asset_type='business' AND asset_id=$2`, [worldId, businessId, newShare]);
  await client.query(`INSERT INTO world_economic_ownership(world_id,asset_type,asset_id,owner_type,owner_id,share,invested_usdc,acquired_world_time)
    VALUES($1,'business',$2,$3,$4,$5,$6,$7)`,
  [worldId, businessId, fundingSource.type, fundingSource.ownerId, newShare, amountUsdc, worldTime]);
  await client.query(`UPDATE world_businesses SET valuation_usdc=valuation_usdc+$3::numeric,updated_at=now()
    WHERE world_id=$1 AND id=$2`, [worldId, businessId, amountUsdc]);
  await recordHistory(client, { worldId, eventKey: `business-investment:${actionId}`, eventType: 'business_invested',
    actorAgentId: investorAgentId, entityType: 'business', entityId: businessId, worldTime, title: business.name,
    detail: `A resident invested ${amountUsdc} simulated USDC and received ${(newShare * 100).toFixed(2)}% ownership.`,
    metadata: { amountUsdc, share: newShare, transactionId: transfer.transactionId } });
  return { businessId, amountUsdc, share: newShare, transactionId: transfer.transactionId, idempotent: false,
    investorType: fundingSource.type, investorId: fundingSource.ownerId };
}

export async function investInWorldProject(client, { worldId, projectId, investorAgentId, amount, actionId, worldTime }) {
  const project = await client.query(`SELECT * FROM world_projects WHERE world_id=$1 AND id=$2 FOR UPDATE`,
    [worldId, projectId]);
  if (!project.rowCount || !['active','recruiting'].includes(project.rows[0].status)) throw error('PROJECT_NOT_INVESTABLE', 404);
  const prior = await client.query(`SELECT metadata FROM world_history WHERE world_id=$1 AND event_key=$2`,
    [worldId, `project-investment:${actionId}`]);
  if (prior.rowCount) return { projectId, ...prior.rows[0].metadata, idempotent: true };
  const member = await client.query(`SELECT 1 FROM world_project_members WHERE world_id=$1 AND project_id=$2
    AND agent_id=$3 AND status='active' FOR UPDATE`, [worldId, projectId, investorAgentId]);
  if (!member.rowCount) throw error('ACTIVE_PROJECT_MEMBERSHIP_REQUIRED', 403);
  const amountUsdc = formatUnits(parsePositiveUnits(String(amount)));
  if (parsePositiveUnits(amountUsdc) < parsePositiveUnits(MIN_INVESTMENT)) throw error('ECONOMIC_INVESTMENT_TOO_SMALL', 400);
  const resident = await getEconomicAccount(client, { worldId, accountType: 'resident', ownerId: investorAgentId,
    asset: 'USDC', forUpdate: true });
  if (!resident || parsePositiveUnits(resident.balance, { allowZero: true })
      < parsePositiveUnits(amountUsdc) + parsePositiveUnits('100.00000000')) throw error('INSUFFICIENT_SIMULATED_USDC');
  await ensureEconomicAccount(client, { worldId, accountType: 'project', ownerId: projectId });
  const owners = await client.query(`SELECT owner_type,owner_id,share::text AS share,invested_usdc::text AS invested_usdc
    FROM world_economic_ownership WHERE world_id=$1 AND asset_type='project' AND asset_id=$2
    ORDER BY owner_type,owner_id FOR UPDATE`, [worldId, projectId]);
  if (!owners.rowCount || owners.rows.reduce((sum, owner) => sum + Number(owner.share), 0) > 1.000001) {
    throw error('PROJECT_OWNERSHIP_INVALID');
  }
  const committed = owners.rows.reduce((sum, owner) => sum + Number(owner.invested_usdc), 0);
  const newShare = clamp(Number(amountUsdc) / (250 + committed + Number(amountUsdc)), 0.01, 0.35);
  const transfer = await transferBetweenAccounts(client, { worldId,
    source: { accountType: 'resident', ownerId: investorAgentId },
    destination: { accountType: 'project', ownerId: projectId }, amount: amountUsdc,
    transactionType: 'project_investment', reason: `Investment in project ${project.rows[0].title}.`,
    worldTime, actionId: `project-investment:${actionId}`, referenceId: projectId });
  await client.query(`UPDATE world_economic_ownership SET share=share*(1-$3::numeric),updated_at=now()
    WHERE world_id=$1 AND asset_type='project' AND asset_id=$2`, [worldId, projectId, newShare]);
  await client.query(`INSERT INTO world_economic_ownership(world_id,asset_type,asset_id,owner_type,owner_id,share,invested_usdc,acquired_world_time)
    VALUES($1,'project',$2,'resident',$3,$4,$5,$6)
    ON CONFLICT(world_id,asset_type,asset_id,owner_type,owner_id) DO UPDATE SET
      share=world_economic_ownership.share+EXCLUDED.share,
      invested_usdc=world_economic_ownership.invested_usdc+EXCLUDED.invested_usdc,updated_at=now()`,
  [worldId, projectId, investorAgentId, newShare, amountUsdc, worldTime]);
  await recordHistory(client, { worldId, eventKey: `project-investment:${actionId}`, eventType: 'project_invested',
    actorAgentId: investorAgentId, entityType: 'project', entityId: projectId, worldTime,
    title: project.rows[0].title,
    detail: `A resident invested ${amountUsdc} simulated USDC and received ${(newShare * 100).toFixed(2)}% project ownership.`,
    metadata: { amountUsdc, share: newShare, transactionId: transfer.transactionId } });
  return { projectId, title: project.rows[0].title, amountUsdc, share: newShare,
    transactionId: transfer.transactionId, idempotent: false };
}

export async function distributeWorldProjectRevenue(client, { worldId, projectId, ownerAgentId, actionId, worldTime }) {
  const project = await client.query(`SELECT * FROM world_projects WHERE world_id=$1 AND id=$2 FOR UPDATE`,
    [worldId, projectId]);
  if (!project.rowCount) throw error('PROJECT_NOT_FOUND', 404);
  const prior = await client.query(`SELECT metadata FROM world_history WHERE world_id=$1 AND event_key=$2`,
    [worldId, `project-distribution:${actionId}`]);
  if (prior.rowCount) return { projectId, ...prior.rows[0].metadata, idempotent: true };
  const owners = await client.query(`SELECT owner_type,owner_id,share::text AS share FROM world_economic_ownership
    WHERE world_id=$1 AND asset_type='project' AND asset_id=$2 ORDER BY owner_type,owner_id FOR UPDATE`, [worldId, projectId]);
  if (!owners.rows.some((owner) => owner.owner_type === 'resident' && owner.owner_id === ownerAgentId)) {
    throw error('PROJECT_OWNER_REQUIRED', 403);
  }
  const account = await getEconomicAccount(client, { worldId, accountType: 'project', ownerId: projectId,
    asset: 'USDC', forUpdate: true });
  if (!account) throw error('ECONOMIC_ACCOUNT_NOT_FOUND', 404);
  const realized = await client.query(`SELECT COALESCE(sum(posting.amount),0)::text AS profit
    FROM world_economic_postings posting JOIN world_economic_transactions tx ON tx.id=posting.transaction_id
    WHERE posting.account_id=$1 AND tx.transaction_type IN ('place_revenue','profit_distribution','maintenance')`, [account.id]);
  const profitUnits = parsePositiveUnits(realized.rows[0].profit || '0', { allowZero: true });
  const balanceUnits = parsePositiveUnits(account.balance || '0', { allowZero: true });
  const distributionUnits = [profitUnits * BigInt(Math.round(MAX_DISTRIBUTION_SHARE * 10_000)) / 10_000n,
    balanceUnits > parsePositiveUnits('25.00000000') ? balanceUnits - parsePositiveUnits('25.00000000') : 0n]
    .reduce((minimum, value) => value < minimum ? value : minimum);
  if (distributionUnits < parsePositiveUnits('1.00000000') || !owners.rowCount) throw error('PROJECT_REVENUE_NOT_DISTRIBUTABLE');
  const outcomes = [];
  for (const { owner, amount } of allocateProRata(distributionUnits, owners.rows)) {
    if (amount <= 0n) continue;
    const paid = await transferBetweenAccounts(client, { worldId,
      source: { accountType: 'project', ownerId: projectId },
      destination: { accountType: owner.owner_type, ownerId: owner.owner_id }, amount: formatUnits(amount),
      transactionType: 'profit_distribution', reason: `Project revenue share from ${project.rows[0].title}.`,
      worldTime, actionId: `project-profit:${actionId}:${owner.owner_type}:${owner.owner_id}`,
      referenceId: projectId, metadata: { ownerShare: owner.share } });
    outcomes.push({ ownerType: owner.owner_type, ownerId: owner.owner_id,
      amount: formatUnits(amount), share: owner.share, transactionId: paid.transactionId });
  }
  const profit = formatUnits(profitUnits);
  const distribution = formatUnits(distributionUnits);
  const metadata = { profitUsdc: profit, distributedUsdc: distribution, outcomes };
  await recordHistory(client, { worldId, eventKey: `project-distribution:${actionId}`, eventType: 'project_revenue',
    actorAgentId: ownerAgentId, entityType: 'project', entityId: projectId, worldTime,
    title: project.rows[0].title,
    detail: `${project.rows[0].title} distributed ${distribution} simulated USDC of realized project revenue.`,
    metadata });
  await client.query(`UPDATE world_projects SET metadata=metadata||jsonb_build_object('lastDistributionWorldTime',$3::bigint),updated_at=now()
    WHERE world_id=$1 AND id=$2`, [worldId, projectId, worldTime]);
  return { projectId, ...metadata, idempotent: false };
}

export async function reviewWorldBusinessPrice(client, { worldId, businessId, serviceId, agentId, direction, actionId, worldTime, demand, supply }) {
  if (!['raise','lower'].includes(direction)) throw error('BUSINESS_PRICE_DIRECTION_INVALID', 400);
  const service = await client.query(`SELECT service.*,business.founder_agent_id AS "founderAgentId"
    FROM world_business_services service JOIN world_businesses business ON business.id=service.business_id
    WHERE service.world_id=$1 AND service.business_id=$2 AND service.id=$3 AND business.status='active'
    FOR UPDATE OF service,business`, [worldId, businessId, serviceId]);
  if (!service.rowCount) throw error('BUSINESS_SERVICE_UNAVAILABLE', 404);
  const row = service.rows[0];
  if (row.founderAgentId !== agentId) await requireBusinessOwner(client, worldId, businessId, agentId);
  const prior = await client.query(`SELECT metadata FROM world_history WHERE world_id=$1 AND event_key=$2`,
    [worldId, `business-price:${actionId}`]);
  if (prior.rowCount) return { businessId, serviceId, ...prior.rows[0].metadata, idempotent: true };
  const oldPrice = Number(row.base_price_usdc);
  const next = ceilMoney(clamp(oldPrice * (direction === 'raise' ? 1.1 : 0.9), oldPrice * 0.65, oldPrice * 1.8));
  await client.query(`UPDATE world_business_services SET base_price_usdc=$4,price_review_world_time=$5 WHERE world_id=$1 AND business_id=$2 AND id=$3`,
  [worldId, businessId, serviceId, next, worldTime]);
  await recordHistory(client, { worldId, eventKey: `business-price:${actionId}`, eventType: 'business_price_changed',
    actorAgentId: agentId, entityType: 'business', entityId: businessId, worldTime, title: row.name,
    detail: `${row.name} adjusted its base simulated USDC price from ${oldPrice.toFixed(2)} to ${Number(next).toFixed(2)} after reviewing demand.`,
    metadata: { serviceId, oldPrice, newPrice: next, demand, supply } });
  return { businessId, serviceId, oldPriceUsdc: oldPrice.toFixed(8), newPriceUsdc: next };
}

export async function distributeWorldBusinessProfit(client, { worldId, businessId, ownerAgentId, actionId, worldTime }) {
  const business = await readBusiness(client, worldId, businessId, true);
  if (business.founder_agent_id !== ownerAgentId) await requireBusinessOwner(client, worldId, businessId, ownerAgentId);
  const account = await getEconomicAccount(client, { worldId, accountType: 'business', ownerId: businessId, forUpdate: true });
  const prior = await client.query(`SELECT metadata FROM world_history WHERE world_id=$1 AND event_key=$2`,
    [worldId, `business-distribution:${actionId}`]);
  if (prior.rowCount) return { businessId, ...prior.rows[0].metadata, idempotent: true };
  const owners = await client.query(`SELECT owner_type,owner_id,share::text AS share FROM world_economic_ownership
    WHERE world_id=$1 AND asset_type='business' AND asset_id=$2 ORDER BY owner_type,owner_id FOR UPDATE`, [worldId, businessId]);
  const totals = await client.query(`SELECT COALESCE(sum(posting.amount) FILTER (WHERE tx.transaction_type='business_revenue'),0)::text AS revenue,
      COALESCE(-sum(posting.amount) FILTER (WHERE tx.transaction_type IN ('business_expense','business_wage','maintenance')
        AND posting.amount<0),0)::text AS expenses,
      COALESCE(-sum(posting.amount) FILTER (WHERE tx.transaction_type='profit_distribution' AND posting.amount<0),0)::text AS distributed
    FROM world_economic_postings posting JOIN world_economic_transactions tx ON tx.id=posting.transaction_id
    WHERE posting.account_id=$1`, [account.id]);
  const revenueUnits = parsePositiveUnits(totals.rows[0].revenue || '0', { allowZero: true });
  const expenseUnits = parsePositiveUnits(totals.rows[0].expenses || '0', { allowZero: true });
  const profitUnits = revenueUnits > expenseUnits ? revenueUnits - expenseUnits : 0n;
  const distributedUnits = parsePositiveUnits(totals.rows[0].distributed || '0', { allowZero: true });
  const undistributedUnits = profitUnits > distributedUnits ? profitUnits - distributedUnits : 0n;
  const balanceUnits = parsePositiveUnits(account.balance || '0', { allowZero: true });
  const distributionUnits = [undistributedUnits * BigInt(Math.round(MAX_DISTRIBUTION_SHARE * 10_000)) / 10_000n,
    balanceUnits > parsePositiveUnits('100.00000000') ? balanceUnits - parsePositiveUnits('100.00000000') : 0n]
    .reduce((minimum, value) => value < minimum ? value : minimum);
  if (distributionUnits < parsePositiveUnits('1.00000000') || !owners.rowCount) throw error('BUSINESS_PROFIT_NOT_DISTRIBUTABLE');
  const outcomes = [];
  for (const { owner, amount: scaledAmount } of allocateProRata(distributionUnits, owners.rows)) {
    const share = Number(owner.share);
    const amount = formatUnits(scaledAmount);
    if (scaledAmount <= 0n) continue;
    const destination = owner.owner_type === 'resident'
      ? { accountType: 'resident', ownerId: owner.owner_id }
      : { accountType: owner.owner_type, ownerId: owner.owner_id };
    const result = await transferBetweenAccounts(client, { worldId,
      source: { accountType: 'business', ownerId: businessId, key: `business:${businessId}` }, destination,
      amount, transactionType: 'profit_distribution', reason: `Profit share from ${business.name}.`, worldTime,
      actionId: `profit:${actionId}:${owner.owner_type}:${owner.owner_id}`, referenceId: businessId });
    outcomes.push({ ownerType: owner.owner_type, ownerId: owner.owner_id, amount, share, transactionId: result.transactionId });
  }
  const profit = formatUnits(profitUnits);
  const distribution = formatUnits(distributionUnits);
  const remainingProfit = formatUnits(undistributedUnits - distributionUnits);
  await recordHistory(client, { worldId, eventKey: `business-distribution:${actionId}`, eventType: 'business_revenue',
    actorAgentId: ownerAgentId, entityType: 'business', entityId: businessId, worldTime, title: business.name,
    detail: `${business.name} distributed ${distribution} simulated USDC from realized operating profit.`,
    metadata: { distribution: outcomes, profitUsdc: profit, distributedUsdc: distribution,
      undistributedProfitUsdc: remainingProfit } });
  await client.query(`UPDATE world_businesses SET metadata=metadata||jsonb_build_object('lastDistributionWorldTime',$3::bigint),updated_at=now()
    WHERE world_id=$1 AND id=$2`, [worldId, businessId, worldTime]);
  return { businessId, profitUsdc: profit, distributedUsdc: distribution,
    undistributedProfitUsdc: remainingProfit, outcomes };
}

export async function closeWorldBusiness(client, { worldId, businessId, founderAgentId, actionId, worldTime, bankrupt = false }) {
  const business = await readBusiness(client, worldId, businessId, true);
  if (business.founder_agent_id !== founderAgentId
      && await readBusinessBeneficialShare(client, worldId, businessId, founderAgentId) < 0.5) {
    throw error('BUSINESS_OWNER_REQUIRED', 403);
  }
  if (business.status === 'closed' || business.status === 'bankrupt') return { id: businessId,
    name: business.name, status: business.status, idempotent: true };
  const status = bankrupt ? 'bankrupt' : 'closed';
  await client.query(`UPDATE world_businesses SET status=$3,
      metadata=metadata||jsonb_build_object('closedWorldTime',$4::bigint,'closedReason',$5::text),updated_at=now()
    WHERE world_id=$1 AND id=$2`, [worldId, businessId, status, worldTime, bankrupt ? 'owner_declared_bankruptcy' : 'owner_closed']);
  await client.query(`UPDATE world_business_services SET active=false WHERE world_id=$1 AND business_id=$2`, [worldId, businessId]);
  await client.query(`UPDATE world_business_jobs SET status='closed' WHERE world_id=$1 AND business_id=$2 AND status='open'`, [worldId, businessId]);
  await client.query(`UPDATE world_business_employment SET status='terminated',ended_world_time=$3
    WHERE world_id=$1 AND business_id=$2 AND status='active'`, [worldId, businessId, worldTime]);
  const expiredApplications = await expirePendingWorldBusinessApplications(client, { worldId, worldTime });
  await recordHistory(client, { worldId, eventKey: `business-close:${businessId}:${actionId}`,
    eventType: 'business_closed', actorAgentId: founderAgentId, entityType: 'business', entityId: businessId,
    worldTime, title: business.name, detail: `${business.name} ${bankrupt ? 'became insolvent' : 'closed'}; its history and ownership records remain.`,
    metadata: { status, cashBalance: business.cash_balance, expiredApplications: expiredApplications.expired } });
  return { id: businessId, name: business.name, status, expiredApplications: expiredApplications.expired };
}

export async function settleWorldBusinessMaintenance(client, { worldId, worldTime }) {
  const day = Math.floor(Number(worldTime) / 1_440);
  await ensureEconomicAccount(client, { worldId, accountType: 'system', key: 'system:maintenance-sink' });
  const businesses = await client.query(`SELECT business.id,business.name,business.founder_agent_id AS "founderAgentId",
      business.consecutive_loss_days AS "lossDays",business.metadata,account.balance::text AS cash
    FROM world_businesses business LEFT JOIN world_economic_accounts account
      ON account.world_id=business.world_id AND account.account_key='business:'||business.id::text AND account.asset_symbol='USDC'
    WHERE business.world_id=$1 AND business.status IN ('active','inactive') ORDER BY business.id FOR UPDATE OF business`, [worldId]);
  let charged = 0;
  const outcomes = [];
  for (const business of businesses.rows) {
    const actionId = `business-maintenance:${business.id}:${day}`;
    const prior = await client.query(`SELECT 1 FROM world_economic_transactions WHERE world_id=$1 AND action_id=$2`, [worldId, actionId]);
    if (prior.rowCount) continue;
    const periodStart = Math.max(0, (day - 1) * 1_440);
    const periodEnd = day * 1_440;
    const period = await client.query(`SELECT
        COALESCE(sum(posting.amount) FILTER (WHERE transaction.transaction_type='business_revenue'),0)::text AS revenue,
        COALESCE(-sum(posting.amount) FILTER (WHERE transaction.transaction_type IN
          ('business_expense','business_wage','maintenance')),0)::text AS expenses
      FROM world_economic_accounts account
      LEFT JOIN world_economic_postings posting ON posting.account_id=account.id
      LEFT JOIN world_economic_transactions transaction ON transaction.id=posting.transaction_id
        AND transaction.world_id=account.world_id AND transaction.world_time >= $3 AND transaction.world_time < $4
      WHERE account.world_id=$1 AND account.account_key='business:'||$2::text AND account.asset_symbol='USDC'`,
    [worldId, business.id, periodStart, periodEnd]);
    const dailyRevenue = Number(period.rows[0]?.revenue) || 0;
    const dailyExpenses = Number(period.rows[0]?.expenses) || 0;
    const dailyNet = dailyRevenue - dailyExpenses;
    const lossDays = dailyNet < -1e-8 ? Number(business.lossDays || 0) + 1 : 0;
    const missedMaintenanceDays = Math.max(0, Number(business.metadata?.maintenanceMissedDays) || 0);
    try {
      await transferBetweenAccounts(client, { worldId,
        source: { accountType: 'business', ownerId: business.id, key: `business:${business.id}` },
        destination: { accountType: 'system', key: 'system:maintenance-sink' }, amount: RUN_COST_PER_DAY,
        transactionType: 'maintenance', reason: `Daily operating and maintenance expense for ${business.name}.`,
        worldTime, actionId, referenceId: business.id });
      await client.query(`UPDATE world_businesses SET status='active',consecutive_loss_days=$3,
          metadata=metadata||jsonb_build_object('maintenanceMissedDays',0,
            'lastDailyOperatingResultUsdc',$4::text,'lastDailyOperatingWorldDay',$5::bigint),updated_at=now()
        WHERE world_id=$1 AND id=$2`, [worldId, business.id, lossDays, dailyNet.toFixed(8), day]);
      charged++;
    } catch (cause) {
      if (cause.message !== 'INSUFFICIENT_SIMULATED_USDC' && cause.message !== 'ECONOMIC_ACCOUNT_NOT_FOUND') throw cause;
      const nextMissedMaintenanceDays = missedMaintenanceDays + 1;
      const status = nextMissedMaintenanceDays >= 3 ? 'bankrupt' : 'inactive';
      await client.query(`UPDATE world_businesses SET status=$3,consecutive_loss_days=$4,
          metadata=metadata||jsonb_build_object('lastLossWorldTime',$5::bigint,'maintenanceMissedDays',$6::int,
            'lastDailyOperatingResultUsdc',$7::text,'lastDailyOperatingWorldDay',$8::bigint)
            ||CASE WHEN $3='bankrupt' THEN jsonb_build_object('closedWorldTime',$5::bigint,
              'closedReason','operating_costs','bankruptcyReason','insufficient_maintenance_liquidity') ELSE '{}'::jsonb END,
          updated_at=now() WHERE world_id=$1 AND id=$2`, [worldId, business.id, status, lossDays, worldTime,
        nextMissedMaintenanceDays, dailyNet.toFixed(8), day]);
      if (status === 'bankrupt') {
        await client.query(`UPDATE world_business_services SET active=false WHERE world_id=$1 AND business_id=$2`, [worldId, business.id]);
        await client.query(`UPDATE world_business_jobs SET status='closed' WHERE world_id=$1 AND business_id=$2`, [worldId, business.id]);
        await client.query(`UPDATE world_business_employment SET status='terminated',ended_world_time=$3
          WHERE world_id=$1 AND business_id=$2 AND status='active'`, [worldId, business.id, worldTime]);
        await recordHistory(client, { worldId, eventKey: `business-bankrupt:${business.id}:${day}`,
          eventType: 'business_loss', actorAgentId: business.founderAgentId, entityType: 'business', entityId: business.id,
          worldTime, title: business.name, detail: `${business.name} could not cover its operating costs for three consecutive world days and became bankrupt.`,
          metadata: { cashBalance: business.cash, consecutiveLossDays: lossDays, missedMaintenanceDays: nextMissedMaintenanceDays,
            bankruptcyReason: 'insufficient_maintenance_liquidity' } });
      }
    }
    const status = (await client.query(`SELECT status FROM world_businesses WHERE world_id=$1 AND id=$2`,
      [worldId, business.id])).rows[0]?.status || 'unknown';
    const outcome = { id: business.id, name: business.name, founderAgentId: business.founderAgentId, status,
      dailyRevenueUsdc: dailyRevenue.toFixed(8), dailyExpensesUsdc: dailyExpenses.toFixed(8),
      dailyNetOperatingResultUsdc: dailyNet.toFixed(8), consecutiveLossDays: lossDays,
      missedMaintenanceDays: status === 'active' ? 0 : missedMaintenanceDays + 1,
      bankruptcyReason: status === 'bankrupt' ? 'insufficient_maintenance_liquidity' : null };
    outcomes.push(outcome);
    if (dailyNet < -1e-8 || dailyNet > 1e-8) await recordHistory(client, {
      worldId, eventKey: `business-daily-outcome:${business.id}:${day}`,
      eventType: dailyNet < 0 ? 'business_loss' : 'business_profit', actorAgentId: business.founderAgentId,
      entityType: 'business', entityId: business.id, worldTime, title: business.name,
      detail: `${business.name} recorded ${dailyNet < 0 ? 'an operating loss' : 'operating profit'} of ${dailyNet.toFixed(8)} simulated USDC for world day ${day}.`,
      metadata: { worldDay: day, revenueUsdc: dailyRevenue.toFixed(8), expensesUsdc: dailyExpenses.toFixed(8),
        netOperatingResultUsdc: dailyNet.toFixed(8), consecutiveLossDays: lossDays, status }
    });
  }
  const expiredApplications = await expirePendingWorldBusinessApplications(client, { worldId, worldTime });
  return { day, charged, observed: businesses.rowCount, outcomes,
    expiredApplications: expiredApplications.expired };
}

export async function settleWorldPlaceMaintenance(client, { worldId, worldTime }) {
  const day = Math.floor(Number(worldTime) / 1_440);
  const places = await client.query(`SELECT place.id,place.name,place.status,place.operating_cost_usdc::text AS cost,
      place.maintenance_missed_days AS missed_days,COALESCE(ownership.owners,'[]'::jsonb) AS owners
    FROM world_scenes place LEFT JOIN LATERAL (
      SELECT jsonb_agg(jsonb_build_object('ownerType',owner.owner_type,'ownerId',owner.owner_id,
        'share',owner.share::text)) AS owners
      FROM world_economic_ownership owner WHERE owner.world_id=place.world_id
        AND owner.asset_type='place' AND owner.asset_id=place.id
    ) ownership ON true
    WHERE place.world_id=$1 AND place.operating_cost_usdc>0 AND place.status IN ('active','inactive')
      AND place.last_maintenance_world_day<$2
    ORDER BY place.id FOR UPDATE OF place`, [worldId, day]);
  let maintained = 0;
  let suspended = 0;
  for (const place of places.rows) {
    const owners = place.owners || [];
    const allocations = owners.length ? allocateProRata(parsePositiveUnits(place.cost), owners) : [];
    const sources = [];
    let funded = owners.length > 0;
    for (const { owner, amount } of allocations) {
      if (amount <= 0n) continue;
      const account = await getEconomicAccount(client, { worldId, accountType: owner.ownerType,
        ownerId: owner.ownerId, asset: 'USDC', forUpdate: true });
      if (!account || parsePositiveUnits(account.balance, { allowZero: true }) < amount) {
        funded = false;
        break;
      }
      sources.push({ owner, account, amount });
    }
    if (!funded) {
      const missedDays = Number(place.missed_days || 0) + 1;
      const status = missedDays >= 3 ? 'inactive' : place.status;
      await client.query(`UPDATE world_scenes SET status=$3,maintenance_missed_days=$4,
          last_maintenance_world_day=$5 WHERE world_id=$1 AND id=$2`, [worldId, place.id, status, missedDays, day]);
      await recordHistory(client, { worldId, eventKey: `place-maintenance-missed:${place.id}:${day}`,
        eventType: 'place_maintenance', entityType: 'place', entityId: place.id, worldTime,
        title: place.name, detail: `${place.name} could not fund its daily ${place.cost} simulated USDC maintenance charge (${missedDays}/3 missed days).`,
        metadata: { cost: place.cost, missedDays, status } });
      if (status === 'inactive') suspended++;
      continue;
    }
    for (const { owner, account, amount } of sources) {
      const system = await ensureEconomicAccount(client, { worldId, accountType: 'system', key: 'system:maintenance-sink' });
      await postEconomicTransfer(client, { worldId, sourceAccountId: account.id, destinationAccountId: system.id,
        asset: 'USDC', amount: formatUnits(amount), transactionType: 'maintenance',
        reason: `Daily place maintenance for ${place.name}.`, worldTime,
        actionId: `place-maintenance:${place.id}:${day}:${owner.ownerType}:${owner.ownerId}`,
        referenceId: place.id, metadata: { ownerType: owner.ownerType, ownerId: owner.ownerId } });
    }
    await client.query(`UPDATE world_scenes SET status='active',maintenance_missed_days=0,last_maintenance_world_day=$3
      WHERE world_id=$1 AND id=$2`, [worldId, place.id, day]);
    await recordHistory(client, { worldId, eventKey: `place-maintenance:${place.id}:${day}`,
      eventType: 'place_maintenance', entityType: 'place', entityId: place.id, worldTime,
      title: place.name, detail: `${place.name} paid ${place.cost} simulated USDC in daily maintenance.`,
      metadata: { cost: place.cost, owners } });
    maintained++;
  }
  return { day, maintained, suspended, observed: places.rowCount };
}

export async function listWorldBusinesses(client, { worldId, limit = 100 } = {}) {
  const result = await client.query(`SELECT business.id,business.name,business.founder_agent_id AS "founderAgentId",
      founder.name AS "founderName",business.business_type AS "businessType",business.purpose,business.status,
      business.reputation::text AS reputation,business.founded_world_time AS "createdWorldTime",
      business.last_revenue_world_time AS "lastRevenueWorldTime",business.consecutive_loss_days AS "lossDays",
      business.place_id AS "placeId",place.name AS "placeName",account.balance::text AS "cashBalance",
      COALESCE(revenue.amount,0)::text AS revenue,
      COALESCE(expenses.amount,0)::text AS expenses,
      (COALESCE(revenue.amount,0)-COALESCE(expenses.amount,0))::text AS "profitLoss",
      COALESCE(owners.items,'[]'::jsonb) AS owners,
      COALESCE(services.items,'[]'::jsonb) AS services,
      COALESCE(jobs.items,'[]'::jsonb) AS jobs,
      COALESCE(workers.items,'[]'::jsonb) AS workers,
      COALESCE(customers.order_count,0)::int AS "orderCount",
      COALESCE(customers.customer_count,0)::int AS "customerCount",
      COALESCE(history.items,'[]'::jsonb) AS history
    FROM world_businesses business JOIN agents founder ON founder.id=business.founder_agent_id
    LEFT JOIN world_scenes place ON place.world_id=business.world_id AND place.id=business.place_id
    LEFT JOIN world_economic_accounts account ON account.world_id=business.world_id
      AND account.account_key='business:'||business.id::text AND account.asset_symbol='USDC'
    LEFT JOIN LATERAL (SELECT sum(posting.amount) AS amount FROM world_economic_postings posting
      JOIN world_economic_transactions tx ON tx.id=posting.transaction_id
      WHERE posting.account_id=account.id AND tx.transaction_type='business_revenue') revenue ON true
    LEFT JOIN LATERAL (SELECT -sum(posting.amount) AS amount FROM world_economic_postings posting
      JOIN world_economic_transactions tx ON tx.id=posting.transaction_id
      WHERE posting.account_id=account.id AND tx.transaction_type IN ('business_expense','business_wage','maintenance')) expenses ON true
    LEFT JOIN LATERAL (SELECT jsonb_agg(jsonb_build_object('ownerType',owner.owner_type,'ownerId',owner.owner_id,
        'share',owner.share::text,'investedUsdc',owner.invested_usdc::text)
        ORDER BY owner.owner_type,owner.owner_id) AS items
      FROM world_economic_ownership owner WHERE owner.world_id=business.world_id
        AND owner.asset_type='business' AND owner.asset_id=business.id) owners ON true
    LEFT JOIN LATERAL (SELECT jsonb_agg(jsonb_build_object('id',service.id,'type',service.service_type,'name',service.name,
        'description',service.description,'basePriceUsdc',service.base_price_usdc::text,
        'stockUnits',service.stock_units,'active',service.active) ORDER BY service.created_world_time,service.id) AS items
      FROM world_business_services service WHERE service.world_id=business.world_id AND service.business_id=business.id) services ON true
    LEFT JOIN LATERAL (SELECT jsonb_agg(jsonb_build_object('id',job.id,'role',job.role,
        'requiredSkill',job.required_skill,'wageUsdc',job.wage_usdc::text,'status',job.status,
        'employeeId',employment.agent_id,'employeeName',employee.name)
        ORDER BY job.created_world_time,job.id) AS items
      FROM world_business_jobs job LEFT JOIN world_business_employment employment
        ON employment.world_id=job.world_id AND employment.job_id=job.id AND employment.status='active'
      LEFT JOIN agents employee ON employee.id=employment.agent_id
      WHERE job.world_id=business.world_id AND job.business_id=business.id) jobs ON true
    LEFT JOIN LATERAL (SELECT jsonb_agg(jsonb_build_object('agentId',employment.agent_id,'name',employee.name,
        'role',job.role,'wageUsdc',employment.wage_usdc::text,'startedWorldTime',employment.started_world_time)
        ORDER BY employment.started_world_time,employment.agent_id) AS items
      FROM world_business_employment employment JOIN agents employee ON employee.id=employment.agent_id
      JOIN world_business_jobs job ON job.world_id=employment.world_id AND job.id=employment.job_id
      WHERE employment.world_id=business.world_id AND employment.business_id=business.id AND employment.status='active') workers ON true
    LEFT JOIN LATERAL (SELECT count(*)::int AS order_count,count(DISTINCT customer_agent_id)::int AS customer_count
      FROM world_business_orders WHERE world_id=business.world_id AND business_id=business.id AND status='fulfilled') customers ON true
    LEFT JOIN LATERAL (SELECT jsonb_agg(jsonb_build_object('eventType',event_type,'worldTime',world_time,
        'title',title,'detail',detail,'metadata',metadata) ORDER BY world_time DESC,id DESC) AS items
      FROM (SELECT event_type,world_time,title,detail,metadata,id FROM world_history
        WHERE world_id=business.world_id AND entity_type='business' AND entity_id=business.id
        ORDER BY world_time DESC,id DESC LIMIT 6) recent) history ON true
    WHERE business.world_id=$1 ORDER BY business.founded_world_time DESC,business.id LIMIT $2`,
  [worldId, Math.max(1, Math.min(200, Math.trunc(Number(limit) || 100)))]);
  return result.rows;
}

export function economicDashboardSql(worldIdPlaceholder = '$1') {
  const world = worldIdPlaceholder;
  return `WITH RECURSIVE resident_assets(resident_id,asset_type,asset_id,share,path) AS (
      SELECT owner.owner_id,owner.asset_type,owner.asset_id,owner.share::numeric,
        ARRAY[owner.asset_type||':'||owner.asset_id::text]
      FROM world_economic_ownership owner WHERE owner.world_id=${world} AND owner.owner_type='resident'
        AND owner.asset_type IN ('business','organization','project')
      UNION ALL
      SELECT parent.resident_id,child.asset_type,child.asset_id,parent.share*child.share,
        parent.path||(child.asset_type||':'||child.asset_id::text)
      FROM resident_assets parent JOIN world_economic_ownership child ON child.world_id=${world}
        AND child.owner_type=parent.asset_type AND child.owner_id=parent.asset_id
      WHERE parent.asset_type IN ('organization','project')
        AND NOT (child.asset_type||':'||child.asset_id::text)=ANY(parent.path)
    ), entity_values AS (
      SELECT account.account_type AS asset_type,account.owner_id AS asset_id,
        sum(account.balance*COALESCE(quote.price_usd,0)) AS value_usd
      FROM world_economic_accounts account LEFT JOIN crypto_market_quotes quote ON quote.symbol=account.asset_symbol
      WHERE account.world_id=${world} AND account.account_type IN ('business','organization','project')
      GROUP BY account.account_type,account.owner_id
    )
    SELECT
      (SELECT count(*)::int FROM world_businesses WHERE world_id=${world}) AS businesses,
      (SELECT count(*)::int FROM world_businesses WHERE world_id=${world} AND status='active') AS active_businesses,
      (SELECT count(*)::int FROM world_businesses WHERE world_id=${world} AND status IN ('closed','bankrupt')) AS closed_businesses,
      (SELECT count(*)::int FROM world_business_employment WHERE world_id=${world} AND status='active') AS employment_count,
      (SELECT COALESCE(sum(tx.amount),0)::text FROM world_economic_transactions tx WHERE tx.world_id=${world} AND tx.transaction_type='business_revenue') AS business_revenue,
      (SELECT COALESCE(-sum(posting.amount),0)::text
        FROM world_economic_postings posting
        JOIN world_economic_transactions tx ON tx.id=posting.transaction_id
        JOIN world_economic_accounts account ON account.id=posting.account_id
        WHERE tx.world_id=${world} AND account.account_type='business' AND account.asset_symbol='USDC'
          AND posting.amount<0 AND tx.transaction_type IN ('business_expense','business_wage','maintenance')) AS business_expenses,
      ((SELECT COALESCE(sum(tx.amount),0) FROM world_economic_transactions tx
          WHERE tx.world_id=${world} AND tx.transaction_type='business_revenue')
        -(SELECT COALESCE(-sum(posting.amount),0)
          FROM world_economic_postings posting
          JOIN world_economic_transactions tx ON tx.id=posting.transaction_id
          JOIN world_economic_accounts account ON account.id=posting.account_id
          WHERE tx.world_id=${world} AND account.account_type='business' AND account.asset_symbol='USDC'
            AND posting.amount<0 AND tx.transaction_type IN ('business_expense','business_wage','maintenance')))::text AS business_profit_loss,
      (SELECT COALESCE(sum(tx.amount),0)::text FROM world_economic_transactions tx WHERE tx.world_id=${world}
        AND tx.transaction_type IN ('business_investment','project_investment')) AS investment_volume,
      (SELECT COALESCE(sum(balance),0)::text FROM world_economic_accounts WHERE world_id=${world}
        AND account_type<>'system' AND asset_symbol='USDC') AS usdc_circulation,
      ((SELECT COALESCE(sum(account.balance*COALESCE(quote.price_usd,0)),0)
        FROM world_economic_accounts account LEFT JOIN crypto_market_quotes quote ON quote.symbol=account.asset_symbol
        WHERE account.world_id=${world} AND account.account_type='resident')
        +(SELECT COALESCE(sum(resident_assets.share*entity_values.value_usd),0)
          FROM resident_assets JOIN entity_values USING(asset_type,asset_id)))::text AS total_resident_net_worth_usd`;
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBusinessCandidates, businessCapabilityFit, deriveWorldEconomicDemand, explainBusinessOpportunityGaps,
  observeResidentEconomicMarket, perceiveResidentEconomicMarket, quoteBusinessPrice } from '../src/world-businesses.js';
import { fruitflyFamily, qualifyLayeredStrategicCandidates, qualifyUtilityCandidates } from '../src/social-world.js';

test('economic demand subtracts actual snake_case and camelCase service inventory', () => {
  const residents = [{ agent_id: 'resident-a', food: 20, social: 100, knowledge: 100, skills: {} },
    { agentId: 'resident-b', food: 25, social: 100, knowledge: 100, skills: {} }];
  const demand = deriveWorldEconomicDemand(residents, [
    { service_type: 'food_service', stock_units: 1, status: 'active' },
    { serviceType: 'food_service', stockUnits: 1, status: 'active' },
    { service_type: 'research_service', stock_units: 20, status: 'inactive' }
  ], 1_500);
  const food = demand.find((row) => row.serviceType === 'food_service');
  const research = demand.find((row) => row.serviceType === 'research_service');
  assert.equal(food.demandCount, 2);
  assert.equal(food.supplyCount, 2);
  assert.equal(food.unmetCount, 0);
  assert.equal(research.supplyCount, 0);
});

test('market perception hides remote demand, businesses and jobs until the Exchange or a local relationship reveals them', () => {
  const resident = { agentId: 'resident-a', name: 'Ada', location: 'Library', food: 96, social: 92,
    knowledge: 90, skills: {}, primaryGoal: 'BALANCED_LIFE', relationships: [], recentMemories: [],
    beliefs: [], organizationMemberships: [], activeProjects: [], projectMemberships: [], organizationPartners: [] };
  const business = { id: 'business-remote', founder_agent_id: 'founder-b', place_id: 'cafe-id', status: 'active',
    owners: [] };
  const context = { worldMinutes: 1_000, scenes: [
    { id: 'library-id', name: 'Library', sceneType: 'library', status: 'active' },
    { id: 'cafe-id', name: 'Cafe', sceneType: 'cafe', status: 'active' },
    { id: 'exchange-id', name: 'Exchange', sceneType: 'commons', status: 'active' }
  ], demand: [{ serviceType: 'research_service', demandCount: 8, supplyCount: 0, unmetCount: 8 }],
  businesses: [business], services: [{ id: 'service-remote', business_id: business.id, founderAgentId: 'founder-b',
    placeName: 'Cafe', service_type: 'research_service', stock_units: 1 }],
  jobs: [{ id: 'job-remote', business_id: business.id, status: 'open' }],
  applications: [{ id: 'private-application', business_id: business.id, founderAgentId: 'founder-b', agent_id: 'resident-c' }],
  employment: [{ id: 'employment-remote', business_id: business.id, agent_id: 'resident-c' }],
  ownership: [{ assetType: 'business', assetId: business.id, ownerType: 'resident', ownerId: 'founder-b', share: '1' }],
  economicProjects: [], organizations: [], residentSkills: { 'founder-b': { research: 99 } } };

  const localView = perceiveResidentEconomicMarket(resident, context);
  assert.equal(localView.demand.find((item) => item.serviceType === 'research_service').known, false);
  assert.equal(localView.demand.find((item) => item.serviceType === 'research_service').demandCount, 0);
  assert.deepEqual(localView.services, []);
  assert.deepEqual(localView.businesses, []);
  assert.deepEqual(localView.jobs, []);
  assert.deepEqual(localView.applications, []);
  assert.deepEqual(localView.employment, []);
  assert.deepEqual(localView.residentSkills, {});

  const exchangeView = perceiveResidentEconomicMarket({ ...resident, location: 'Exchange' }, context);
  assert.equal(exchangeView.demand.find((item) => item.serviceType === 'research_service').demandCount, 8);
  assert.equal(exchangeView.services.length, 1);
  assert.equal(exchangeView.jobs.length, 1);
  assert.deepEqual(exchangeView.applications, [], 'another resident\'s job application stays private');

  const trustedView = perceiveResidentEconomicMarket({ ...resident, relationships: [
    { otherAgentId: 'founder-b', trust: 5, familiarity: 15 }
  ] }, context);
  assert.equal(trustedView.services.length, 1);
  assert.equal(trustedView.jobs.length, 1);
  assert.deepEqual(trustedView.residentSkills, { 'founder-b': { research: 99 } });
});

test('remembered market evidence decays without refreshing its observation time', async () => {
  const resident = { agentId: 'resident-a', location: 'Library', food: 96, social: 92, knowledge: 90,
    skills: {}, primaryGoal: 'BALANCED_LIFE', relationships: [], recentMemories: [], organizationMemberships: [],
    activeProjects: [], projectMemberships: [], organizationPartners: [], beliefs: [{ subjectType: 'market',
      subjectKey: 'food_service', beliefKey: 'unmet_demand', estimate: 0.75, confidence: 0.8,
      sampleCount: 1, updatedWorldMinutes: 0, evidence: { demandCount: 8, otherDemandCount: 6,
        supplyCount: 2, observedWorldMinutes: 0 } }] };
  const context = { scenes: [{ id: 'library', name: 'Library', sceneType: 'library', status: 'active' }],
    demand: [{ serviceType: 'food_service', demandCount: 10, supplyCount: 0, unmetCount: 10 }],
    residentsAtLocation: { Library: [] } };
  const perception = perceiveResidentEconomicMarket(resident, { ...context, worldMinutes: 5_040 });
  const remembered = perception.demand.find((item) => item.serviceType === 'food_service');
  assert.equal(remembered.known, true);
  assert.equal(remembered.directlyObserved, false);
  assert.equal(remembered.demandCount, 4);
  assert.equal(remembered.supplyCount, 1);
  assert.equal(remembered.otherDemandCount, 3);
  assert.equal(remembered.awarenessConfidence, 0.4);

  const writes = [];
  const actor = { ...resident, beliefs: resident.beliefs.map((belief) => ({ ...belief })) };
  await observeResidentEconomicMarket({ query: async (...args) => { writes.push(args); return { rowCount: 1 }; } },
    { worldId: 'world-a', agent: actor, context, worldMinutes: 5_040 });
  assert.equal(writes.length, 0, 'remembering old evidence must not keep its database timestamp fresh');
  assert.equal(actor.beliefs[0].estimate, 0.375);

  const directActor = { ...resident, food: 40, beliefs: [] };
  await observeResidentEconomicMarket({ query: async (...args) => { writes.push(args); return { rowCount: 1 }; } },
    { worldId: 'world-a', agent: directActor, context, worldMinutes: 5_041 });
  assert.equal(writes.length, 1);
  assert.match(writes[0][0], /VALUES\(\$1,\$2,'market'/);
});

test('prices respond to scarcity and stay within the configured quote bounds', () => {
  const scarce = quoteBusinessPrice({ basePrice: '10', demand: 10, supply: 0, wealth: 10_000 });
  const abundant = quoteBusinessPrice({ basePrice: '10', demand: 1, supply: 20, wealth: 10_000 });
  assert.ok(Number(scarce) > 10);
  assert.ok(Number(abundant) < 10);
  assert.ok(Number(quoteBusinessPrice({ basePrice: '10', demand: 1, supply: 1e9 })) >= 6.5);
  const lowSensitivity = quoteBusinessPrice({ basePrice: '10', demand: 1, supply: 1, wealth: 10_000, priceSensitivity: 0 });
  const highSensitivity = quoteBusinessPrice({ basePrice: '10', demand: 1, supply: 1, wealth: 10_000, priceSensitivity: 1 });
  assert.ok(Number(highSensitivity) > Number(lowSensitivity));
});

test('business candidates require observed unmet demand, working capital, and viable needs', () => {
  const resident = { agentId: 'resident-a', name: 'Ada', usdc: '10000', energy: 80, food: 70,
    skills: { research: 80, engineering: 10 }, primaryGoal: 'WEALTH', location: 'Library', ambition: 0.7 };
  const baseContext = { worldMinutes: 500, demand: [{ serviceType: 'research_service', demandCount: 3,
    supplyCount: 0, unmetCount: 3 }],
    businesses: [], services: [], jobs: [], employment: [], organizationMemberships: [], economicProjects: [], scenes: [] };
  const originalProposal = buildBusinessCandidates(resident, baseContext).find((item) => item.action === 'business_found')?.businessProposal;
  assert.ok(originalProposal);
  const retryContext = { ...baseContext, businesses: [
    { name: originalProposal.name, founder_agent_id: resident.agentId, status: 'bankrupt' },
    { name: `${originalProposal.name} 2`, founder_agent_id: resident.agentId, status: 'closed' }
  ] };
  const retryProposal = buildBusinessCandidates(resident, retryContext).find((item) => item.action === 'business_found')?.businessProposal;
  assert.notEqual(retryProposal?.name, originalProposal.name);
  assert.notEqual(retryProposal?.name, `${originalProposal.name} 2`);
  assert.ok(!buildBusinessCandidates({ ...resident, usdc: '100' }, baseContext)
    .some((item) => item.action === 'business_found'));
  assert.ok(!buildBusinessCandidates({ ...resident, energy: 10 }, baseContext)
    .some((item) => item.action === 'business_found'));
  assert.ok(!buildBusinessCandidates(resident, { ...baseContext,
    demand: [{ serviceType: 'research_service', demandCount: 0, supplyCount: 0, unmetCount: 0 }] })
    .some((item) => item.action === 'business_found'));
  const underqualified = buildBusinessCandidates({ ...resident, skills: { research: 19, engineering: 10 } }, baseContext);
  const lowFitFounder = underqualified.find((item) => item.action === 'business_found');
  const regularFitFounder = buildBusinessCandidates(resident, baseContext).find((item) => item.action === 'business_found');
  assert.ok(lowFitFounder, 'low capability lowers expected fit but does not act as a career license');
  assert.ok(lowFitFounder.score < regularFitFounder.score, 'capability fit continuously changes the candidate value');
  assert.ok(underqualified.some((item) => item.action === 'business_skill_practice'),
    'unmet demand and a skill gap should create a preparation action');
  const recentFailure = { ...baseContext, businesses: [{ founder_agent_id: resident.agentId, status: 'bankrupt',
    business_type: 'research', founded_world_time: '100', metadata: { serviceType: 'research_service', closedWorldTime: 400 } }] };
  assert.ok(!buildBusinessCandidates(resident, recentFailure).some((item) => item.action === 'business_found'),
    'a failed business has a three day restart cooldown');
  assert.ok(buildBusinessCandidates(resident, { ...recentFailure, worldMinutes: 4_720 })
    .some((item) => item.action === 'business_found'), 'business creation can resume after the cooldown');
});

test('retry cooldown is sector scoped and excludes passive minority investors and ordinary employees', () => {
  const passive = { agentId: 'passive-investor', name: 'Ada', usdc: '10000', energy: 80, food: 70,
    skills: { social: 60, research: 80 }, primaryGoal: 'WEALTH', ambition: 0.7 };
  const failed = { id: 'failed-food', founder_agent_id: 'someone-else', status: 'closed',
    metadata: { serviceType: 'food_service', closedWorldTime: 1_400, closedReason: 'owner_closed' } };
  const sharedOwners = Array.from({ length: 10 }, (_, index) => ({ assetType: 'business', assetId: failed.id,
    ownerType: 'resident', ownerId: index === 0 ? passive.agentId : `resident-${index}`, share: '0.1' }));
  const context = { worldMinutes: 1_500,
    demand: [{ serviceType: 'food_service', demandCount: 4, supplyCount: 0, unmetCount: 4 },
      { serviceType: 'research_service', demandCount: 2, supplyCount: 0, unmetCount: 2 }],
    businesses: [failed], ownership: sharedOwners, employment: [], operatorHistory: [],
    services: [], jobs: [], organizationMemberships: [], economicProjects: [], scenes: [] };
  const passiveCandidates = buildBusinessCandidates(passive, context);
  assert.ok(passiveCandidates.some((item) => item.action === 'business_found'
    && item.businessProposal.serviceType === 'food_service'),
  'a 10% passive share must not inherit the founder cooldown');
  const controller = { ...passive, agentId: 'resident-9' };
  const controlled = buildBusinessCandidates(controller, { ...context, ownership: sharedOwners.map((owner) => ({
    ...owner, share: owner.ownerId === controller.agentId ? '0.6' : '0.04444444'
  })) });
  assert.ok(!controlled.some((item) => item.action === 'business_found'
    && item.businessProposal.serviceType === 'food_service'), 'a majority controller observes the failed-sector cooldown');
  assert.ok(controlled.some((item) => item.action === 'business_found'
    && item.businessProposal.serviceType === 'research_service'), 'a food failure does not freeze other sectors');

  const worker = { ...passive, agentId: 'ordinary-worker' };
  const employeeContext = { ...context, ownership: [], operatorHistory: [{ agentId: worker.agentId,
    businessId: failed.id, role: 'Food Associate', startedWorldTime: 1_000, endedWorldTime: 1_450 }] };
  assert.ok(buildBusinessCandidates(worker, employeeContext).some((item) => item.action === 'business_found'
    && item.businessProposal.serviceType === 'food_service'), 'ordinary employee history is not operator exposure');
});

test('persistent unmet demand is observable without any provider, and some residents receive a bounded ambient signal', () => {
  const scenes = [{ id: 'library', name: 'Library', sceneType: 'library', status: 'active' },
    { id: 'exchange', name: 'Exchange', sceneType: 'commons', status: 'active' }];
  const demand = [{ serviceType: 'food_service', demandCount: 4, supplyCount: 0, unmetCount: 4 }];
  const atExchange = perceiveResidentEconomicMarket({ agentId: 'exchange-observer', name: 'Ada', location: 'Exchange',
    food: 90, social: 90, knowledge: 90, skills: {}, relationships: [], recentMemories: [], beliefs: [] },
  { worldMinutes: 1_440, scenes, demand, businesses: [], services: [] });
  const observed = atExchange.demand.find((item) => item.serviceType === 'food_service');
  assert.equal(observed.known, true);
  assert.equal(observed.unmetCount, 4);
  assert.equal(observed.awareness, 'exchange');

  const ambientResidents = Array.from({ length: 200 }, (_, index) => ({ agentId: `ambient-${index}`,
    name: `Resident ${index}`, location: 'Library', curiosity: 0.6, food: 90, social: 90, knowledge: 90,
    skills: { research: 40, engineering: 30, trading: 30, social: 30 }, primaryGoal: 'BALANCED_LIFE',
    relationships: [], recentMemories: [], beliefs: [], organizationMemberships: [], activeProjects: [],
    projectMemberships: [], organizationPartners: [] }));
  const signal = ambientResidents.map((resident) => perceiveResidentEconomicMarket(resident,
    { worldMinutes: 1_440, scenes, demand, businesses: [], services: [] })).find((view) => view.marketSignals.length > 0);
  assert.ok(signal, 'stable resident-specific sampling lets the empty market be discovered outside Exchange');
});

test('failure memories alter recovery strategy scores instead of freezing the agent', () => {
  const resident = { agentId: 'recovering-resident', name: 'Ada', usdc: '10000', energy: 80, food: 70,
    skills: { social: 60, research: 45, engineering: 25, trading: 25 }, primaryGoal: 'WEALTH', ambition: 0.7,
    curiosity: 0.7, location: 'Exchange', relationships: [], recentMemories: [] };
  const context = { worldMinutes: 1_500, marketSignals: [{ serviceType: 'food_service', signalUnmetCount: 4 }],
    demand: [{ serviceType: 'food_service', known: true, awareness: 'exchange', demandCount: 4,
      supplyCount: 0, unmetCount: 4, otherDemandCount: 3 }],
    businesses: [], services: [], allBusinessServices: [], jobs: [], employment: [], applications: [],
    ownership: [], operatorHistory: [], organizationMemberships: [], economicProjects: [], activeProjects: [],
    residentSkills: {}, scenes: [{ id: 'exchange', name: 'Exchange', sceneType: 'commons', status: 'active' }] };
  const before = buildBusinessCandidates(resident, context);
  const after = buildBusinessCandidates({ ...resident, recentMemories: [{ memoryType: 'business', worldMinutes: 1_400,
    summary: 'The previous food business closed after repeated operating losses.',
    metadata: { action: 'business_close', serviceType: 'food_service', outcome: 'closed' } }] }, context);
  const find = (items, action) => items.find((item) => item.action === action
    && (item.marketObservationServiceType === 'food_service' || item.businessProposal?.serviceType === 'food_service'
      || item.preparationServiceType === 'food_service'));
  assert.ok(find(after, 'business_found').score < find(before, 'business_found').score,
    'failure memory lowers immediate same-sector restart utility');
  assert.ok(find(after, 'business_market_observe').score > find(before, 'business_market_observe').score,
    'the same failure raises the value of gathering market evidence');
  assert.ok(find(after, 'business_skill_practice').score > find(before, 'business_skill_practice').score,
    'the same failure also raises the value of preparation');
});

test('market observation and reopening stay inside existing Fruitfly output families', () => {
  assert.equal(fruitflyFamily({ action: 'business_market_observe' }), 'business_learn');
  assert.equal(fruitflyFamily({ action: 'business_reopen' }), 'business');
});

test('failed supplier agreements add replacement units to an agent market observation idempotently', async () => {
  const calls = [];
  let savedEvent = null;
  const client = { query: async (sql, params) => {
    calls.push({ sql, params });
    if (/SELECT data FROM world_events/.test(sql)) return savedEvent
      ? { rowCount: 1, rows: [{ data: savedEvent }] } : { rowCount: 0, rows: [] };
    if (/SELECT evidence,estimate::text AS estimate/.test(sql)) return { rowCount: 0, rows: [] };
    if (/FROM world_economic_demand/.test(sql)) return { rowCount: 1, rows: [{ demandCount: 4,
      supplyCount: 0, unmetCount: 4, worldDay: 2 }] };
    if (/AS "replacementUnits"/.test(sql)) return { rowCount: 1, rows: [{ failedContractCount: 1, replacementUnits: 2 }] };
    if (/INSERT INTO world_events/.test(sql)) savedEvent = JSON.parse(params[2]);
    return { rowCount: 1, rows: [] };
  } };
  const { observeWorldBusinessMarket } = await import('../src/world-businesses.js');
  const result = await observeWorldBusinessMarket(client, { worldId: 'world-a', agentId: 'resident-a',
    serviceType: 'food_service', actionId: 'observe-once', worldTime: 2_900, location: 'Exchange' });
  assert.equal(result.demandCount, 6);
  assert.equal(result.unmetCount, 6);
  assert.equal(result.replacementUnits, 2);
  assert.equal(result.failedContractCount, 1);
  assert.match(calls.find((call) => /AS "replacementUnits"/.test(call.sql)).sql, /commitment\.status='fulfilled'/);

  calls.length = 0;
  const retry = await observeWorldBusinessMarket(client, { worldId: 'world-a', agentId: 'resident-a',
    serviceType: 'food_service', actionId: 'observe-once', worldTime: 2_900 });
  assert.equal(retry.idempotent, true);
  assert.equal(calls.filter((call) => /FROM world_economic_demand/.test(call.sql)).length, 0,
    'a retry returns its stored observation without reading demand or incrementing the belief');
});

test('transferable skill fit qualifies a non-dominant trading capability', () => {
  const resident = { agentId: 'resident-trader', name: 'Ada', usdc: '10000', energy: 80, food: 70,
    social: 50, knowledge: 50, skills: { research: 62, engineering: 58, trading: 35, social: 20 },
    primaryGoal: 'BUILD_WEALTH', ambition: 0.7, riskTolerance: 0.8, location: 'Exchange' };
  const context = { worldMinutes: 500, demand: [{ serviceType: 'trading_service', demandCount: 2, supplyCount: 0, unmetCount: 2 }],
    businesses: [], services: [], jobs: [], employment: [], organizationMemberships: [], economicProjects: [], scenes: [] };
  assert.equal(Object.entries(resident.skills).sort((a, b) => b[1] - a[1])[0][0], 'research');
  const fit = businessCapabilityFit(resident, 'trading_service', context);
  assert.ok(fit.score >= 28, `combined trading capability fit should clear threshold: ${fit.score}`);
  const candidate = buildBusinessCandidates(resident, context).find((item) => item.action === 'business_found'
    && item.businessProposal.serviceType === 'trading_service');
  assert.ok(candidate, 'a research-dominant resident can evaluate real trading demand using secondary skills');
});

test('active organization capability and funds can fill the founder skill gap', () => {
  const resident = { agentId: 'resident-founder', name: 'Grace', usdc: '5000', energy: 80, food: 70,
    social: 45, knowledge: 25, skills: { research: 15, engineering: 10, trading: 8, social: 12 },
    primaryGoal: 'BUILD_WEALTH', ambition: 0.7, riskTolerance: 0.8, location: 'Exchange',
    organizationMemberships: [{ id: 'org-traders', status: 'active', memberStatus: 'active', cashBalance: '1000',
      memberIds: ['resident-founder', 'resident-partner'] }] };
  const context = { worldMinutes: 500, demand: [{ serviceType: 'trading_service', demandCount: 3, supplyCount: 0, unmetCount: 3 }],
    businesses: [], services: [], jobs: [], employment: [], economicProjects: [], scenes: [],
    residentSkills: { 'resident-founder': resident.skills,
      'resident-partner': { research: 20, engineering: 12, trading: 80, social: 15 } } };
  const fit = businessCapabilityFit(resident, 'trading_service', context, { organizationId: 'org-traders' });
  assert.ok(fit.ownScore < 28);
  assert.ok(fit.score >= 28);
  const candidate = buildBusinessCandidates(resident, context).find((item) => item.action === 'business_found'
    && item.businessProposal.serviceType === 'trading_service');
  assert.ok(candidate, 'the organization should make its members\' combined skills operationally usable');
  assert.deepEqual(candidate.businessProposal.capitalSource, { type: 'organization', ownerId: 'org-traders' });
  assert.deepEqual(candidate.businessProposal.capabilityTeamAgentIds, ['resident-founder', 'resident-partner']);
});

test('trusted project collaborators create a cofounder path when the resident lacks capability', () => {
  const resident = { agentId: 'resident-founder', name: 'Grace', usdc: '5000', energy: 80, food: 70,
    social: 45, knowledge: 25, skills: { research: 18, engineering: 8, trading: 10, social: 15 },
    primaryGoal: 'BUILD_WEALTH', ambition: 0.7, riskTolerance: 0.8, location: 'Exchange',
    organizationPartners: [{ partnerId: 'resident-trader', partnerName: 'Turing', trust: 30, familiarity: 40,
      sharedProjectCount: 2, alreadySharedOrganization: false, partnerGoal: 'MASTER_TRADING', projectId: 'project-one' }] };
  const context = { worldMinutes: 500, demand: [{ serviceType: 'trading_service', demandCount: 3, supplyCount: 0, unmetCount: 3 }],
    businesses: [], services: [], jobs: [], employment: [], organizationMemberships: [], economicProjects: [], scenes: [],
    residentSkills: { 'resident-founder': resident.skills,
      'resident-trader': { research: 25, engineering: 10, trading: 82, social: 20 } } };
  const candidate = buildBusinessCandidates(resident, context).find((item) => item.action === 'business_seek_cofounder');
  assert.ok(candidate);
  assert.equal(candidate.cofounderProposal.partnerId, 'resident-trader');
  assert.equal(candidate.cofounderProposal.serviceType, 'trading_service');
});

test('business preparation and cofounder actions reuse Fruitfly action families', () => {
  assert.equal(fruitflyFamily('business_skill_practice'), 'business_learn');
  assert.equal(fruitflyFamily('business_seek_cofounder'), 'business');
});

test('business funnel diagnostics distinguish demand, capability, capital, needs, risk and goals', () => {
  const context = { worldMinutes: 500, demand: [{ serviceType: 'trading_service', demandCount: 2,
    supplyCount: 0, unmetCount: 2 }], businesses: [], services: [], jobs: [], employment: [],
  organizationMemberships: [], economicProjects: [], scenes: [] };
  const capable = { agentId: 'resident', usdc: '10000', energy: 80, food: 70,
    skills: { trading: 80, research: 20, engineering: 20, social: 20 }, primaryGoal: 'BALANCED_LIFE',
    ambition: 0.2, riskTolerance: 0.8, relationships: [], organizationPartners: [] };
  const reason = (agent, overrides = {}) => explainBusinessOpportunityGaps({ ...agent, ...overrides },
    { ...context, ...overrides.context }).find((item) => item.serviceType === 'trading_service');
  assert.equal(reason(capable, { usdc: '100' }).reasonCode, 'INSUFFICIENT_CAPITAL');
  assert.equal(reason(capable, { energy: 10 }).reasonCode, 'ENERGY_TOO_LOW');
  assert.equal(reason(capable, { riskTolerance: 0.1 }).reasonCode, 'RISK_TOO_HIGH');
  assert.equal(reason(capable, { primaryGoal: 'CARE_FOR_NEEDS', ambition: 0.2 }).reasonCode, 'GOAL_MISMATCH');
  const lowCapability = reason({ ...capable, skills: { trading: 5, research: 5, engineering: 5, social: 5 } });
  assert.ok(lowCapability.additionalReasonCodes.includes('CAPABILITY_TOO_LOW'),
    'capability is reported as a preparation signal, not a hard startup ban');
  assert.ok(lowCapability.additionalReasonCodes.includes('NO_PARTNER'));
  assert.equal(reason(capable, { context: { demand: [{ serviceType: 'trading_service', demandCount: 2,
    supplyCount: 2, unmetCount: 0 }] } }).reasonCode, 'STRONG_COMPETITION');
  assert.equal(reason(capable, { context: { demand: [] } }).reasonCode, 'NO_UNMET_DEMAND');
  assert.equal(reason(capable, { context: { businesses: [{ founder_agent_id: 'resident', business_type: 'market_research',
    status: 'bankrupt', metadata: { serviceType: 'trading_service', closedWorldTime: 490 } }] } }).reasonCode,
  'BUSINESS_RETRY_COOLDOWN');
});

test('business hiring and service candidates require funded payroll and reflect buyer intent', () => {
  const resident = { agentId: 'resident-worker', name: 'Grace', usdc: '500', energy: 80, food: 70,
    social: 35, knowledge: 20, skills: { research: 80, engineering: 10, social: 10, trading: 10 },
    primaryGoal: 'MASTER_RESEARCH', relationships: [], recentMemories: [], location: 'Library' };
  const job = { id: 'job-a', business_id: 'business-a', founderAgentId: 'founder-a', businessName: 'Research Studio',
    businessStatus: 'active', status: 'open', requiredSkill: 'research', wage_usdc: '15', businessCash: '119' };
  const context = { worldMinutes: 2_000, businesses: [], services: [], jobs: [job], employment: [], applications: [],
    ownership: [], organizationMemberships: [], economicProjects: [], demand: [] };
  assert.ok(!buildBusinessCandidates(resident, context).some((candidate) => candidate.action === 'business_apply'));
  const fundedJob = { ...job, businessCash: '120' };
  const application = { id: 'application-a', business_id: 'business-a', founderAgentId: 'founder-a',
    businessStatus: 'active', jobStatus: 'open', status: 'pending', agent_id: resident.agentId,
    requiredSkill: 'research', wage: '15', businessCash: '119', role: 'Research Associate' };
  const employerCandidates = buildBusinessCandidates({ ...resident, agentId: 'founder-a' }, { ...context,
    jobs: [], applications: [application], residentSkills: { [resident.agentId]: resident.skills } });
  assert.ok(!employerCandidates.some((candidate) => candidate.action === 'business_hire'));
  const wellFundedApplication = { ...application, businessCash: '250' };
  const fundedCandidates = buildBusinessCandidates({ ...resident, agentId: 'founder-a' }, { ...context,
    jobs: [], applications: [wellFundedApplication], residentSkills: { [resident.agentId]: resident.skills } });
  assert.ok(fundedCandidates.some((candidate) => candidate.action === 'business_hire'));
  assert.ok(buildBusinessCandidates(resident, { ...context, jobs: [fundedJob] })
    .some((candidate) => candidate.action === 'business_apply'));

  const fundedContractDemand = [{ agreement_id: 'agreement-a', business_id: 'business-a', service_id: 'service-a',
    remaining_units: 2, stock_units: 0, active_employee_count: 0, price_usdc: '20.00' }];
  const baseApply = buildBusinessCandidates(resident, { ...context, jobs: [fundedJob] })
    .find((candidate) => candidate.action === 'business_apply');
  const contractApply = buildBusinessCandidates(resident, { ...context, jobs: [fundedJob],
    contractDemand: fundedContractDemand }).find((candidate) => candidate.action === 'business_apply');
  assert.equal(contractApply.businessHiringReason, 'FULFILL_CONTRACT');
  assert.equal(contractApply.score, baseApply.score + 10,
    'a funded contract with a production capacity gap increases the worker application candidate score');
  const baseHire = buildBusinessCandidates({ ...resident, agentId: 'founder-a' }, { ...context,
    jobs: [], applications: [wellFundedApplication], residentSkills: { [resident.agentId]: resident.skills } })
    .find((candidate) => candidate.action === 'business_hire');
  const contractHire = buildBusinessCandidates({ ...resident, agentId: 'founder-a' }, { ...context,
    jobs: [], applications: [wellFundedApplication], residentSkills: { [resident.agentId]: resident.skills },
    contractDemand: fundedContractDemand }).find((candidate) => candidate.action === 'business_hire');
  assert.equal(contractHire.businessHiringReason, 'FULFILL_CONTRACT');
  assert.equal(contractHire.score, baseHire.score + 18,
    'a funded contract with a production capacity gap increases the employer hiring candidate score');
  const coveredContract = { ...fundedContractDemand[0], remaining_units: 1, active_employee_count: 1 };
  const coveredHire = buildBusinessCandidates({ ...resident, agentId: 'founder-a' }, { ...context,
    jobs: [], applications: [wellFundedApplication], residentSkills: { [resident.agentId]: resident.skills },
    contractDemand: [coveredContract] }).find((candidate) => candidate.action === 'business_hire');
  assert.equal(coveredHire.businessHiringReason, null,
    'a contract already covered by inventory and active employee capacity does not create a hiring preference');

  const pendingOwnApplication = { ...application, id: 'application-own', agent_id: resident.agentId,
    businessName: 'Research Studio', created_world_time: 1_000 };
  const applicantCandidates = buildBusinessCandidates(resident, { ...context, jobs: [],
    applications: [pendingOwnApplication] });
  assert.ok(applicantCandidates.some((candidate) => candidate.action === 'business_withdraw'
    && candidate.applicationId === pendingOwnApplication.id),
  'an applicant can choose to withdraw a long-pending application');
  const recentApplication = buildBusinessCandidates(resident, { ...context, jobs: [], applications: [
    { ...pendingOwnApplication, created_world_time: 1_281 }
  ] });
  assert.ok(!recentApplication.some((candidate) => candidate.action === 'business_withdraw'),
    'withdrawal is not proposed immediately after applying');

  const service = { id: 'service-a', business_id: 'business-a', founderAgentId: 'founder-a',
    businessName: 'Research Studio', businessReputation: 4, service_type: 'research_service',
    stock_units: 1, base_price_usdc: '35', active: true };
  const buyer = buildBusinessCandidates(resident, { ...context, services: [service], demand: [
    { serviceType: 'research_service', demandCount: 5, supplyCount: 1, unmetCount: 4 }
  ] }).find((candidate) => candidate.action === 'business_service');
  assert.ok(buyer);
  assert.ok(buyer.score >= 30, 'a buyer with a matching research goal and learning need treats the service as material');
  assert.equal(buyer.serviceType, 'research_service');
  assert.deepEqual(buyer.pricingContext, { demand: 5, supply: 1, relationship: 0,
    wealth: 500, priceSensitivity: 0.5 });
  assert.equal(buyer.maxPriceUsdc, quoteBusinessPrice({ basePrice: service.base_price_usdc,
    ...buyer.pricingContext, reputation: service.businessReputation }));
  assert.equal(fruitflyFamily(buyer), 'travel');
  assert.equal(fruitflyFamily({ action: 'business_service', serviceType: 'engineering_service' }), 'work');
  assert.equal(fruitflyFamily({ action: 'business_service', serviceType: 'social_service' }), 'socialize');
  assert.equal(fruitflyFamily({ action: 'business_service', serviceType: 'trading_service' }), 'business');

  const foodBuyer = { ...resident, agentId: 'resident-worker', usdc: '10000', energy: 80, food: 20,
    social: 80, knowledge: 80, location: 'Exchange', primaryGoal: 'CARE_FOR_NEEDS',
    relationships: [], recentMemories: [], beliefs: [] };
  const ownedBusiness = { id: 'owned-business', founder_agent_id: foodBuyer.agentId, status: 'active', cash_balance: '0' };
  const foodProvider = { id: 'food-provider', founder_agent_id: 'provider-a', status: 'active', cash_balance: '100' };
  const foodService = { id: 'food-service', business_id: foodProvider.id, founderAgentId: 'provider-a',
    businessName: 'Meal Studio', service_type: 'food_service', placeName: 'Cafe',
    stock_units: 2, base_price_usdc: '12', active: true };
  const foodDemand = [{ serviceType: 'food_service', demandCount: 8, supplyCount: 2, unmetCount: 6 }];
  const foodMarket = { ...context, scenes: [
    { name: 'Exchange', position: { x: 0, z: 0 }, status: 'active' },
    { name: 'Cafe', position: { x: 0.5, z: 0 }, status: 'active' }
  ], businesses: [ownedBusiness, foodProvider], services: [foodService], demand: foodDemand };
  const foodCandidates = buildBusinessCandidates(foodBuyer, foodMarket);
  const meal = foodCandidates.find((candidate) => candidate.action === 'business_service');
  assert.ok(meal && meal.score >= 55, 'a hungry, solvent resident values an in-stock meal by its need relief');
  assert.equal(fruitflyFamily(meal), 'eat', 'service type must reach Fruitfly family routing');
  const nearbyMeal = buildBusinessCandidates({ ...foodBuyer, location: 'Cafe' }, foodMarket)
    .find((candidate) => candidate.action === 'business_service');
  assert.ok(nearbyMeal.score > meal.score, 'travel distance to a provider must lower purchase utility');
  assert.equal(meal.targetLocation, 'Cafe');
  const economicChoiceSet = qualifyLayeredStrategicCandidates([...foodCandidates,
    { id: 'price-review', action: 'business_price', score: 72 },
    { id: 'project-proposal', action: 'project_propose', score: 80 }]);
  assert.ok(economicChoiceSet.some((candidate) => candidate.id === meal.id),
    'a high-need customer purchase remains eligible beside another strong business strategy');

  const customerBelief = (estimate) => ({ subjectType: 'business', subjectKey: foodProvider.id,
    beliefKey: 'service_experience', estimate, confidence: 0.8, updatedWorldMinutes: 2_000 });
  const withPositiveExperience = buildBusinessCandidates({ ...foodBuyer, beliefs: [customerBelief(0.8)] },
    { ...foodMarket, worldMinutes: 2_000 })
    .find((candidate) => candidate.action === 'business_service');
  const withNegativeExperience = buildBusinessCandidates({ ...foodBuyer, beliefs: [customerBelief(-0.8)] },
    { ...foodMarket, worldMinutes: 2_000 })
    .find((candidate) => candidate.action === 'business_service');
  assert.ok(withPositiveExperience.score > meal.score && meal.score > withNegativeExperience.score,
    'a customer’s service outcome belief should raise or lower future purchase utility');
  const lowerBalanceMeal = buildBusinessCandidates({ ...foodBuyer, usdc: '500' },
    foodMarket)
    .find((candidate) => candidate.action === 'business_service');
  assert.ok(lowerBalanceMeal.score < meal.score, 'a less affordable price should lower purchase utility');
});

test('business production follows unmet demand and founders do not close on cumulative costs alone', () => {
  const resident = { agentId: 'resident-owner', name: 'Ada', usdc: '10000', energy: 80, food: 70,
    skills: { research: 80 }, primaryGoal: 'BUILD_WEALTH', location: 'Library' };
  const business = { id: 'business-a', founder_agent_id: resident.agentId, status: 'active',
    cash_balance: '100', revenue: '0', expenses: '200', consecutive_loss_days: 0 };
  const service = { id: 'service-a', business_id: business.id, service_type: 'research_service',
    active: true, stock_units: 0, placeName: 'Library' };
  const base = { worldMinutes: 3_000, businesses: [business], services: [service], jobs: [], employment: [],
    demand: [{ serviceType: 'research_service', unmetCount: 0 }], ownership: [] };
  assert.ok(!buildBusinessCandidates(resident, base).some((candidate) => candidate.action === 'business_work'),
    'production is skipped when stocked supply already meets observed demand');
  assert.ok(!buildBusinessCandidates(resident, base).some((candidate) => candidate.action === 'business_close'),
    'cumulative historical expenses do not make a business look unable to meet its next bill');
  const demandDriven = buildBusinessCandidates(resident, { ...base,
    demand: [{ serviceType: 'research_service', unmetCount: 2 }] });
  const production = demandDriven.find((candidate) => candidate.action === 'business_work');
  assert.ok(production);
  assert.ok(production.score >= 71.25, 'zero inventory plus unmet demand makes production eligible against a 95-point alternative');
  assert.ok(qualifyUtilityCandidates([production, { id: 'opportunity', score: 95 },
    { id: 'project', score: 89 }, { id: 'social', score: 80 }]).some((candidate) => candidate.id === production.id));
  assert.ok(buildBusinessCandidates(resident, { ...base,
    businesses: [{ ...business, consecutive_loss_days: 2 }] }).some((candidate) => candidate.action === 'business_close'),
  'owners can close before a third consecutive missed maintenance payment becomes bankruptcy');
});

test('residents cannot create customer revenue by buying from an entity they beneficially own', () => {
  const resident = { agentId: 'resident-a', usdc: '10000', energy: 80, food: 70, social: 30, knowledge: 20,
    skills: {}, relationships: [], organizationMemberships: [], activeProjects: [], primaryGoal: 'LEARN' };
  const business = { id: 'business-a', founder_agent_id: 'resident-b', status: 'active', cash_balance: '1000',
    revenue: '1200', expenses: '100', reputation: 5,
    owners: [{ ownerType: 'organization', ownerId: 'organization-a', share: '1' }] };
  const service = { id: 'service-a', business_id: 'business-a', founderAgentId: 'resident-b', service_type: 'research_service',
    stock_units: 2, base_price_usdc: '35', businessStatus: 'active' };
  const context = { worldMinutes: 2_000, demand: [{ serviceType: 'research_service', demandCount: 5, supplyCount: 2 }],
    businesses: [business], services: [service], jobs: [], employment: [], economicProjects: [],
    organizationMemberships: [], ownership: [{ assetType: 'organization', assetId: 'organization-a',
      ownerType: 'resident', ownerId: resident.agentId, share: '1' }] };
  const actions = buildBusinessCandidates(resident, context);
  assert.ok(!actions.some((item) => item.action === 'business_service'));
  assert.ok(actions.some((item) => item.action === 'business_price'));
  assert.ok(!actions.some((item) => item.action === 'business_found'));
});

test('new economic actions map into existing Fruitfly output families', () => {
  assert.equal(fruitflyFamily('project_invest'), 'invest');
  assert.equal(fruitflyFamily('project_distribute'), 'invest');
  assert.equal(fruitflyFamily('business_invest'), 'invest');
  assert.equal(fruitflyFamily('business_found'), 'business');
  assert.equal(fruitflyFamily('business_apply'), 'job');
  assert.equal(fruitflyFamily('business_skill_practice'), 'business_learn');
  assert.equal(fruitflyFamily('business_market_observe'), 'business_learn');
  assert.equal(fruitflyFamily('business_reopen'), 'business');
  assert.equal(fruitflyFamily('agreement_propose'), 'business');
  assert.equal(fruitflyFamily('agreement_respond'), 'business');
  assert.equal(fruitflyFamily('commitment_resolve'), 'business');
  assert.equal(fruitflyFamily('organization_propose'), 'socialize');
  assert.equal(fruitflyFamily('organization_vote'), 'socialize');
  assert.equal(fruitflyFamily('opportunity_propose'), 'business');
  assert.equal(fruitflyFamily('business_work'), 'work');
  assert.equal(fruitflyFamily('business_service'), 'business');
});

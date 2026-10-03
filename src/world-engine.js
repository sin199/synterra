import { createHash } from 'node:crypto';
import { chargeMeal, MEAL_COST_UNITS, canAffordUnits } from './economy.js';
import { formatUnits, multiplyUnits, parsePositiveUnits, parseSignedUnits } from './crypto-market.js';
import { ensureCryptoAccount, executeCryptoTrade } from './crypto-trading.js';
import {
  DECISION_MIX, SOCIAL_COOLDOWN_WORLD_MINUTES, SOCIAL_SKILLS, addSkillGain, canCooperatePair, canSocializePair,
  chooseSocialPartner, clampPersonality, canonicalPair, clampSkill, deriveDominantRole, effectivePersonality,
  goalActionUtility, goalDescription, goalProgress, initialSkillValues, initialSocialProfile, lastRealizedSalePnl,
  qualifyUtilityCandidates,
  memoryForCompletedAction, recentMemoryUtility, reflectionDue, reflectionProposal, seededGoalSet,
  skillGainForAction
} from './social-world.js';
import { buildWorldInitiativeCandidates, environmentOpportunityIdeas,
  explainWorldInitiativeGaps } from './world-initiatives.js';
import { GOAL_STAGNATION_MINUTES, STRATEGIC_DECISION_INTERVAL_MINUTES,
  deriveWorldNeedSignals, recordEmergenceEvent, updateGoalStagnation } from './world-emergence.js';
import { createWorldOpportunity, decideWorldOpportunity, completeOpportunityParticipation,
  expireWorldOpportunities, listAvailableOpportunities } from './world-opportunities.js';
import { proposeWorldProject, decideProjectMembership, contributeToProject, failWorldProject,
  expireWorldProjects, listWorldProjects } from './world-projects.js';
import { foundWorldOrganization, decideOrganizationMembership, contributeOrganizationEffort,
  inviteWorldOrganization, listWorldOrganizations } from './world-organizations.js';
import { shareWorldInformation, decideWorldInformationShare, expireInformationShares,
  listInformationInbox } from './world-information.js';

export const WORLD_TICK_MS = 1_000;
const TYPE_SAFE_INTERVAL_MS = 30 * 60_000;
const MAX_CATCH_UP_SECONDS = 30;
const ACTION_SECONDS = Object.freeze({ work: 16, cooperate: 16, learn: 11, rest: 9, eat: 8, socialize: 12, trade: 7,
  opportunity: 12, opportunity_reject: 8, opportunity_propose: 10, project_propose: 12, project_join: 10, project_reject: 8, project_contribute: 16,
  project_leave: 8, organization_found: 14, organization_join: 10, organization_reject: 8,
  organization_leave: 8, organization_invite: 10, organization_contribute: 12, information_share: 10,
  information_accept: 8, information_ignore: 6, information_doubt: 8, goal_review: 10 });
const GOALS = Object.freeze(['wealth','learn','community','wellbeing','balanced','wealth','learn','community','wellbeing','balanced']);
const RISK_TOLERANCE = Object.freeze([0.78,0.28,0.52,0.22,0.68,0.35,0.82,0.47,0.70,0.40]);
const ALLOWED_GOALS = new Set(['wealth','learn','community','wellbeing','balanced']);
const FINITE_STAT_KEYS = ['energy','food','social','happiness','knowledge'];

function stableInt(input) {
  return createHash('sha256').update(String(input)).digest().readUInt32BE(0);
}

function initiativeSystem(action) {
  if (action === 'goal_review') return 'goal';
  if (action.startsWith('opportunity')) return 'opportunity';
  if (action.startsWith('project')) return 'project';
  if (action.startsWith('organization')) return 'organization';
  if (action.startsWith('information')) return 'information';
  return 'place';
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

function candidate({ id, action, place, goal, description = goal, score, plannedPaidMeal = false, side, asset, quoteUnits,
  socialPartnerId = null, socialPartnerName = null }) {
  return { id, action, targetLocation: place, goal, description, score, plannedPaidMeal, side: side || null,
    asset: asset || null, quoteUnits: quoteUnits || null, socialPartnerId, socialPartnerName };
}

export function buildActivityCandidates(agent, scenes, context = {}) {
  const options = [];
  const energy = clamp(agent.energy), food = clamp(agent.food), social = clamp(agent.social);
  const happiness = clamp(agent.happiness), knowledge = clamp(agent.knowledge);
  const goal = ALLOWED_GOALS.has(agent.goal) ? agent.goal : 'balanced';
  const activePrimary = agent.goals?.find((item) => item.goalType === 'primary' && item.status === 'active');
  const primaryGoal = activePrimary?.category || agent.primaryGoal || 'BALANCED_LIFE';
  const personality = effectivePersonality({ ...agent, personalityModifiers: agent.personalityModifiers || {} });
  const skills = Object.fromEntries(SOCIAL_SKILLS.map((skill) => [skill, clampSkill(agent.skills?.[skill])]));
  const units = String(agent.internalUnits ?? '0');
  const cash = finite(agent.usdc);
  const btc = finite(agent.btc), eth = finite(agent.eth);
  const btcQuote = finite(context.quotes?.find((item) => item.symbol === 'BTC')?.priceUsd);
  const ethQuote = finite(context.quotes?.find((item) => item.symbol === 'ETH')?.priceUsd);
  const nav = cash + btc * btcQuote + eth * ethQuote;
  const recentTradeMs = agent.lastTradeAt ? finite(context.nowMs, Date.now()) - new Date(agent.lastTradeAt).getTime() : Infinity;
  const canTrade = energy >= 20 && food >= 10 && finite(agent.riskTolerance) >= 0.65
    && (['wealth','balanced'].includes(goal) || ['BUILD_WEALTH','MASTER_TRADING','RECOVER_FINANCIAL_STABILITY'].includes(primaryGoal))
    && recentTradeMs >= 180_000 && cash >= 75 && nav > 0;

  const workshops = sceneOptions(scenes, ['workshop', 'studio']);
  const dataCenters = sceneOptions(scenes, ['data_center']);
  const libraries = sceneOptions(scenes, ['library']);
  const observatories = sceneOptions(scenes, ['observatory']);
  const gardens = sceneOptions(scenes, ['garden']);
  const cafes = sceneOptions(scenes, ['cafe']);

  if (energy >= 20 && food >= 12) for (const place of [...workshops, ...dataCenters]) {
    const dataCenter = place.sceneType === 'data_center';
    const score = 28 + (goal === 'wealth' ? 22 : 0) + (cash < 7_500 ? 18 : cash < 9_500 ? 8 : 0) +
      (dataCenter && goal === 'learn' ? 8 : 0) + (dataCenter ? finite(agent.traits?.craft) * 3 : 0)
      + personality.discipline * 7 + personality.ambition * 8 + skills.engineering * 0.16
      + (['BUILD_WEALTH','RECOVER_FINANCIAL_STABILITY'].includes(primaryGoal) ? 17 : 0)
      + (primaryGoal.includes('ENGINEERING') ? 20 : 0)
      + recentMemoryUtility(agent, 'work', context.worldMinutes);
    options.push(candidate({ id: `work:${place.id}`, action: 'work', place: place.name,
      goal: dataCenter ? 'Complete a paid data-center shift and learn from its operations.' : 'Complete a paid workshop shift and contribute to the local economy.', score }));
  }
  if (energy >= 15 && food >= 8) for (const place of [...libraries, ...observatories]) {
    const observatory = place.sceneType === 'observatory';
    const score = 23 + (goal === 'learn' ? 27 : 0) + Math.max(0, 82 - knowledge) * 0.72 +
      finite(agent.traits?.curiosity) * 8 + (observatory ? 4 : 0) + personality.curiosity * 10
      + skills.research * 0.14 + (primaryGoal === 'MASTER_RESEARCH' ? 24 : 0)
      + recentMemoryUtility(agent, 'learn', context.worldMinutes);
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
  }

  for (const place of sceneOptions(scenes, ['cafe', 'garden', 'commons'])) {
    if (energy < 12 || food < 8) continue;
    const relationByAgent = new Map((Array.isArray(agent.relationships) ? agent.relationships : [])
      .map((relation) => [relation.otherAgentId, relation]));
    const partners = (context.residentsAtLocation?.[place.name] || []).map((other) => ({
      ...other,
      location: place.name,
      lastInteractionWorldMinutes: relationByAgent.get(other.agentId)?.lastInteractionWorldMinutes,
      relationship: relationByAgent.get(other.agentId) || null
    }));
    const partner = chooseSocialPartner({ ...agent, location: place.name }, place, partners, context.worldMinutes);
    if (!partner) continue;
    const relation = partner.relationship || {};
    const socialMemory = (Array.isArray(agent.recentMemories) ? agent.recentMemories : [])
      .some((memory) => memory.memoryType === 'social' && memory.relatedAgentId === partner.agentId
        && Number(context.worldMinutes) - Number(memory.worldMinutes) <= 720);
    const score = 22 + (goal === 'community' ? 24 : 0) + Math.max(0, 90 - social) * 0.58
      + personality.sociability * 13 + skills.social * 0.12
      + (primaryGoal === 'BUILD_RELATIONSHIPS' ? 28 : 0)
      + clamp(finite(relation.familiarity) * 0.06 + finite(relation.affinity) * 0.03, 0, 9)
      + (socialMemory ? 3 : 0);
    options.push(candidate({ id: `socialize:${place.id}:${partner.agentId}`, action: 'socialize', place: place.name,
      socialPartnerId: partner.agentId, socialPartnerName: partner.name,
      goal: `Meet ${partner.name} at ${place.name} and build social connection.`, score }));
  }

  if (energy >= 20 && food >= 12) for (const place of [...workshops, ...dataCenters]) {
    if (agent.location !== place.name) continue;
    const partners = context.residentsAtLocation?.[place.name] || [];
    const partner = partners.filter((other) => canCooperatePair({ actor: agent, partner: other,
      scene: place, worldMinutes: context.worldMinutes }))
      .sort((left, right) => Number(right.relationship?.trust || 0) - Number(left.relationship?.trust || 0)
        || Number(right.relationship?.familiarity || 0) - Number(left.relationship?.familiarity || 0)
        || String(left.agentId).localeCompare(String(right.agentId)))[0];
    if (!partner) continue;
    const relation = partner.relationship || {};
    const partnerSkill = Number(partner.skills?.engineering) || 0;
    const mentorship = Math.min(8, Math.abs(skills.engineering - partnerSkill) * 0.08);
    options.push(candidate({ id: `cooperate:${place.id}:${partner.agentId}`, action: 'cooperate', place: place.name,
      socialPartnerId: partner.agentId, socialPartnerName: partner.name,
      goal: `Work with ${partner.name} at ${place.name} and create useful value together.`,
      score: 34 + personality.sociability * 8 + personality.discipline * 5 + skills.engineering * 0.1
        + Math.min(12, Number(relation.familiarity || 0) * 0.08 + Number(relation.trust || 0) * 0.35)
        + mentorship + recentMemoryUtility(agent, 'cooperate', context.worldMinutes) }));
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
        score: 34 + risk * 28 + (goal === 'wealth' ? 12 : 0) + Math.max(-5, Math.min(7, momentum * 1000))
          + skills.trading * 0.14 + personality.ambition * 6
          + (primaryGoal === 'BUILD_WEALTH' ? 15 : 0) + (primaryGoal === 'MASTER_TRADING' ? 24 : 0)
          + recentMemoryUtility(agent, 'trade', context.worldMinutes) }));
      if (holdingValue >= 20 && momentum < 0.002) {
        const notional = Math.min(holdingValue * 0.1, nav * 0.1, 50);
        if (notional >= 10) options.push(candidate({ id: `trade:sell:${asset}`, action: 'trade', place: 'Exchange', side: 'sell', asset,
          quoteUnits: notional.toFixed(8), goal: `Trim a small ${asset} position at Exchange while keeping the order within risk limits.`,
          score: 30 + risk * 20 + Math.max(-3, Math.min(12, -momentum * 1000))
            + skills.trading * 0.14 + (primaryGoal === 'MASTER_TRADING' ? 18 : 0)
            + recentMemoryUtility(agent, 'trade', context.worldMinutes) }));
      }
    }
  }

  for (const option of options) {
    option.score += goalActionUtility(option, agent.goals || []);
    const belief = (Array.isArray(agent.beliefs) ? agent.beliefs : []).find((item) =>
      item.subjectType === 'action' && item.subjectKey === option.action && item.beliefKey === 'outcome');
    if (belief) option.score += clamp(finite(belief.estimate) * finite(belief.confidence) * 8, -8, 8);
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

async function querySequentially(queries) {
  const results = [];
  for (const query of queries) results.push(await query());
  return results;
}

async function loadWorldInitiatives(client, worldId, worldMinutes, residents, scenes) {
  const [opportunities, projects, projectMembers, organizations, inbox, completedPairs, recentShares, creatorOpportunityStats, beliefs] = await querySequentially([
    () => client.query(`SELECT opportunity.*,scene.name AS "sceneName",
        count(participant.agent_id) FILTER (WHERE participant.status='accepted')::int AS "acceptedCount",
        COALESCE(array_agg(participant.agent_id) FILTER (WHERE participant.agent_id IS NOT NULL),'{}') AS "participantIds"
      FROM world_opportunities opportunity LEFT JOIN world_scenes scene
        ON scene.world_id=opportunity.world_id AND scene.id=opportunity.scene_id
      LEFT JOIN world_opportunity_participants participant ON participant.world_id=opportunity.world_id
        AND participant.opportunity_id=opportunity.id
      WHERE opportunity.world_id=$1 AND opportunity.status IN ('open','active')
        AND (opportunity.expires_world_time IS NULL OR opportunity.expires_world_time>$2)
      GROUP BY opportunity.id,scene.name ORDER BY opportunity.created_world_time DESC,opportunity.id LIMIT 60`,
    [worldId, worldMinutes]),
    () => client.query(`SELECT project.*,project.progress::text AS "progressValue",
        count(member.agent_id) FILTER (WHERE member.status='active')::int AS "participantCount"
      FROM world_projects project LEFT JOIN world_project_members member
        ON member.world_id=project.world_id AND member.project_id=project.id
      WHERE project.world_id=$1 AND project.status IN ('proposed','recruiting','active')
      GROUP BY project.id ORDER BY project.updated_world_time DESC,project.id LIMIT 100`, [worldId]),
    () => client.query(`SELECT project_id AS "projectId",agent_id AS "agentId",status,role
      FROM world_project_members WHERE world_id=$1`, [worldId]),
    () => listWorldOrganizations(client, { worldId, statuses: ['forming', 'active', 'dormant'], limit: 100 }),
    () => client.query(`SELECT share.*,sender.name AS "senderName" FROM world_information_shares share
      JOIN agents sender ON sender.id=share.sender_agent_id
      WHERE share.world_id=$1 AND share.status='offered' AND share.expires_world_time>$2
      ORDER BY share.shared_world_time DESC,share.id LIMIT 200`, [worldId, worldMinutes]),
    () => client.query(`SELECT left_member.agent_id AS "agentId",right_member.agent_id AS "partnerId",other.name AS "partnerName",
        (array_agg(project.id ORDER BY project.updated_world_time DESC,project.id))[1] AS "projectId",
        (array_agg(project.title ORDER BY project.updated_world_time DESC,project.id))[1] AS "projectTitle",
        (array_agg(project.goal ORDER BY project.updated_world_time DESC,project.id))[1] AS "projectGoal",
        COALESCE(partner_profile.primary_goal,'') AS "partnerGoal",
        count(DISTINCT project.id)::int AS "sharedProjectCount",
        COALESCE(relation.familiarity,0)::text AS familiarity,COALESCE(relation.trust,0)::text AS trust
      FROM world_projects project
      JOIN world_project_members left_member ON left_member.world_id=project.world_id
        AND left_member.project_id=project.id AND left_member.status='completed'
      JOIN world_project_members right_member ON right_member.world_id=project.world_id
        AND right_member.project_id=project.id AND right_member.status='completed'
        AND right_member.agent_id<>left_member.agent_id
      JOIN agents other ON other.id=right_member.agent_id
      LEFT JOIN world_social_profiles partner_profile ON partner_profile.world_id=project.world_id
        AND partner_profile.agent_id=right_member.agent_id
      LEFT JOIN world_relationships relation ON relation.world_id=project.world_id
        AND relation.agent_a_id=LEAST(left_member.agent_id,right_member.agent_id)
        AND relation.agent_b_id=GREATEST(left_member.agent_id,right_member.agent_id)
      WHERE project.world_id=$1 AND project.status='completed'
      GROUP BY left_member.agent_id,right_member.agent_id,other.name,partner_profile.primary_goal,relation.familiarity,relation.trust
      HAVING count(DISTINCT project.id)>=2
      ORDER BY count(DISTINCT project.id) DESC,left_member.agent_id,right_member.agent_id LIMIT 500`, [worldId]),
    () => client.query(`SELECT sender_agent_id AS "senderAgentId",recipient_agent_id AS "recipientAgentId",
        max(shared_world_time)::bigint AS "lastShareWorldTime"
      FROM world_information_shares WHERE world_id=$1 GROUP BY sender_agent_id,recipient_agent_id`, [worldId]),
    () => client.query(`SELECT creator_agent_id AS "agentId",
        count(*) FILTER (WHERE status IN ('open','active') AND (expires_world_time IS NULL OR expires_world_time>$2))::int AS "activeCount",
        max(created_world_time)::bigint AS "lastCreatedWorldTime"
      FROM world_opportunities WHERE world_id=$1 AND creator_agent_id IS NOT NULL GROUP BY creator_agent_id`,
    [worldId, worldMinutes]),
    () => client.query(`SELECT agent_id AS "agentId",subject_type AS "subjectType",subject_key AS "subjectKey",
        belief_key AS "beliefKey",estimate::text AS estimate,confidence::text AS confidence,sample_count AS "sampleCount"
      FROM world_agent_beliefs WHERE world_id=$1 AND sample_count>0`, [worldId])
  ]);
  const byAgent = new Map(residents.map((resident) => [resident.agent_id, {
    projectMemberships: [], projectInvitations: [], activeProjects: [], organizationMemberships: [],
    organizationInvitations: [], informationInbox: [], organizationPartners: [], beliefs: [], sharedProjectPartnerIds: []
  }]));
  const projectsById = new Map(projects.rows.map((project) => [project.id, project]));
  for (const member of projectMembers.rows) {
    const data = byAgent.get(member.agentId);
    const project = projectsById.get(member.projectId);
    if (!data) continue;
    data.projectMemberships.push({ projectId: member.projectId, status: member.status });
    if (member.status === 'invited' && project) data.projectInvitations.push(project);
    if (member.status === 'active' && project) {
      if (project.status === 'active') data.activeProjects.push(project);
    }
  }
  const organizationRows = organizations.map((organization) => ({ ...organization,
    members: Array.isArray(organization.members) ? organization.members : [],
    projects: Array.isArray(organization.projects) ? organization.projects : [] }));
  for (const organization of organizationRows) {
    const activeMemberIds = organization.members.filter((member) => member.status === 'active').map((member) => member.agentId);
    const openings = projects.rows.filter((project) => project.organization_id === organization.id);
    for (const member of organization.members) {
      const data = byAgent.get(member.agentId);
      if (!data) continue;
      const view = { id: organization.id, name: organization.name, purpose: organization.purpose,
        status: organization.status, memberStatus: member.status, reputation: Number(organization.reputation) || 0,
        resources: safeJson(organization.resources), memberIds: activeMemberIds, projectOpenings: openings };
      if (member.status === 'invited') data.organizationInvitations.push({ ...organization,
        inviterAgentId: organization.founder_agent_id });
      data.organizationMemberships.push(view);
    }
  }
  for (const share of inbox.rows) byAgent.get(share.recipient_agent_id)?.informationInbox.push({
    id: share.id, senderAgentId: share.sender_agent_id, senderName: share.senderName,
    informationType: share.information_type, subjectType: share.subject_type, subjectKey: share.subject_key,
    claim: safeJson(share.claim), confidence: Number(share.confidence), status: share.status,
    sharedWorldTime: Number(share.shared_world_time), expiresWorldTime: Number(share.expires_world_time)
  });
  for (const pair of completedPairs.rows) byAgent.get(pair.agentId)?.organizationPartners.push(pair);
  for (const pair of completedPairs.rows) byAgent.get(pair.agentId)?.sharedProjectPartnerIds.push(pair.partnerId);
  for (const belief of beliefs.rows) byAgent.get(belief.agentId)?.beliefs.push(belief);
  const residentById = new Map(residents.map((resident) => [resident.agent_id, resident]));
  const recentlyShared = new Map(recentShares.rows.map((share) =>
    [`${share.senderAgentId}:${share.recipientAgentId}`, Number(share.lastShareWorldTime)]));
  const opportunityStats = new Map(creatorOpportunityStats.rows.map((row) => [row.agentId, row]));
  const activeOpportunities = opportunities.rows;
  const activeProjects = projects.rows;
  const projectTypes = new Set(activeProjects.map((project) => project.project_type));
  const crowdedPlaces = scenes.filter((scene) => scene.status === 'active').map((scene) => {
    const visitors = residents.filter((resident) => resident.location === scene.name).length;
    return { ...scene, congestion: visitors / Math.max(1, Number(scene.capacity || 8)) };
  }).filter((scene) => scene.congestion >= 0.75);
  const residentViews = residents.map((resident) => ({ ...resident, ...byAgent.get(resident.agent_id),
    skills: safeJson(resident.skills), sharedProjectPartnerIds: byAgent.get(resident.agent_id)?.sharedProjectPartnerIds || [] }));
  const worldNeeds = deriveWorldNeedSignals({ residents: residentViews, scenes, projects: activeProjects,
    opportunities: activeOpportunities, worldMinutes });
  const beliefsByAgent = new Map(residents.map((resident) => [resident.agent_id, byAgent.get(resident.agent_id)?.beliefs || []]));
  for (const resident of residents) {
    const data = byAgent.get(resident.agent_id);
    data.activeProjectsCreated = activeProjects.filter((project) => project.creator_agent_id === resident.agent_id).length;
    const ownOpportunities = opportunityStats.get(resident.agent_id);
    data.activeOpportunitiesCreated = Number(ownOpportunities?.activeCount) || 0;
    data.lastOpportunityCreatedWorldTime = ownOpportunities?.lastCreatedWorldTime === null
      || ownOpportunities?.lastCreatedWorldTime === undefined ? null : Number(ownOpportunities.lastCreatedWorldTime);
    data.activeOpportunityCount = opportunities.rows.length;
    data.opportunityMembershipIds = opportunities.rows.filter((opportunity) =>
      opportunity.participantIds.some((id) => id === resident.agent_id)).map((opportunity) => opportunity.id);
    const trusted = (Array.isArray(resident.relationships) ? resident.relationships : [])
      .filter((relation) => Number(relation.familiarity) >= 10 && Number(relation.trust) >= 2)
      .filter((relation) => worldMinutes - (recentlyShared.get(`${resident.agent_id}:${relation.otherAgentId}`) ?? -Infinity) >= 60)
      .sort((left, right) => Number(right.trust) - Number(left.trust)
        || Number(right.familiarity) - Number(left.familiarity));
    const ownBeliefs = beliefsByAgent.get(resident.agent_id) || [];
    const asymmetricShareOptions = [];
    for (const recipient of trusted) {
      const recipientBeliefs = beliefsByAgent.get(recipient.otherAgentId) || [];
      for (const belief of ownBeliefs) {
        const recipientKnows = recipientBeliefs.some((item) => item.subjectType === belief.subjectType
          && item.subjectKey === belief.subjectKey && item.beliefKey === belief.beliefKey
          && Number(item.confidence) >= Number(belief.confidence) - 0.1);
        if (!recipientKnows && Number(belief.confidence) >= 0.2) asymmetricShareOptions.push({
          recipientAgentId: recipient.otherAgentId, recipientName: recipient.name,
          trust: Number(recipient.trust), familiarity: Number(recipient.familiarity), informationType: 'belief',
          subjectType: belief.subjectType, subjectKey: belief.subjectKey, beliefKey: belief.beliefKey,
          sourceConfidence: Number(belief.confidence)
        });
      }
    }
    if (asymmetricShareOptions.length) {
      data.shareProposal = asymmetricShareOptions[stableInt(`${resident.agent_id}:${Math.floor(worldMinutes / 180)}:share-asymmetry`)
        % asymmetricShareOptions.length];
    }
    data.opportunities = activeOpportunities;
    data.projects = activeProjects;
    data.crowdedPlaces = crowdedPlaces;
    data.worldNeeds = worldNeeds.filter((need) => !need.agentId || need.agentId === resident.agent_id
      || need.partnerId === resident.agent_id);
    data.activePlaceCount = scenes.filter((scene) => scene.status === 'active').length;
    data.completedProjectPartnerCount = data.organizationPartners.length;
    data.projectOpportunity = activeOpportunities.some((opportunity) => opportunity.opportunity_type === 'BUILD'
      || opportunity.opportunity_type === 'COOPERATION');
    data.organizationPartners = data.organizationPartners.map((partner) => ({ ...partner,
      alreadySharedOrganization: data.organizationMemberships.some((organization) =>
        organization.memberIds.includes(partner.partnerId) && organization.status !== 'dissolved') }));
    data.organizationPartners = data.organizationPartners.filter((partner) => !partner.alreadySharedOrganization);
    data.residentNames = residentById;
  }
  return { byAgent, opportunities: activeOpportunities, projects: activeProjects, worldNeeds,
    newIdeas: environmentOpportunityIdeas({ residents, scenes, worldMinutes, projects: activeProjects,
      opportunities: activeOpportunities }) };
}

async function recordWorldEvent(client, worldId, agentId, tick, type, data) {
  const result = await client.query(`INSERT INTO world_events(world_id,actor_id,event_type,data,action_id)
    VALUES($1,$2,$3,$4,$5) ON CONFLICT(world_id,actor_id,action_id) DO UPDATE SET data=world_events.data
    RETURNING id`, [worldId, agentId, type, data, actionId(agentId, tick, type.split('.').at(-1))]);
  return result.rows[0]?.id || null;
}

export async function pruneResidentMemories(client, worldId, agentId) {
  await client.query(`DELETE FROM agent_memories WHERE id IN (
    SELECT id FROM agent_memories WHERE world_id=$1 AND agent_id=$2 AND long_term=false
    ORDER BY importance DESC,world_minutes DESC,id DESC OFFSET 100)`, [worldId, agentId]);
  await client.query(`DELETE FROM agent_memories WHERE id IN (
    SELECT id FROM agent_memories WHERE world_id=$1 AND agent_id=$2 AND long_term=true
    ORDER BY importance DESC,world_minutes DESC,id DESC OFFSET 20)`, [worldId, agentId]);
}

async function recordResidentMemory(client, { worldId, agentId, memoryType, summary, importance, worldMinutes,
  location, relatedAgentId = null, metadata = {}, sourceEventId, longTerm = false }) {
  if (!sourceEventId || !summary) return null;
  const inserted = await client.query(`INSERT INTO agent_memories(world_id,agent_id,memory_type,summary,importance,
      world_minutes,location,related_agent_id,metadata,source_event_id,long_term)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING RETURNING id`,
  [worldId, agentId, memoryType, String(summary).slice(0, 240), clampPersonality(importance), worldMinutes,
    location || null, relatedAgentId, metadata, sourceEventId, Boolean(longTerm || importance >= 0.7)]);
  if (!inserted.rowCount) return null;
  await pruneResidentMemories(client, worldId, agentId);
  return inserted.rows[0].id;
}

async function recordConsolidatedMemory(client, { worldId, agentId, summary, importance, worldMinutes, key, metadata }) {
  if (!summary || !key) return null;
  const result = await client.query(`INSERT INTO agent_memories(world_id,agent_id,memory_type,summary,importance,
      world_minutes,metadata,long_term,consolidation_key)
    VALUES($1,$2,'summary',$3,$4,$5,$6,true,$7)
    ON CONFLICT(world_id,agent_id,consolidation_key) WHERE consolidation_key IS NOT NULL
    DO UPDATE SET summary=EXCLUDED.summary,importance=EXCLUDED.importance,world_minutes=EXCLUDED.world_minutes,
      metadata=EXCLUDED.metadata,long_term=true,created_at=now()
    RETURNING id`, [worldId, agentId, String(summary).slice(0, 240), clampPersonality(importance), worldMinutes, metadata, key]);
  await pruneResidentMemories(client, worldId, agentId);
  return result.rows[0]?.id || null;
}

async function applySkillGains(client, worldId, agentId, action, place, hadPartner = false) {
  const gains = skillGainForAction(action, place, hadPartner);
  for (const [skill, gain] of Object.entries(gains)) {
    await client.query(`INSERT INTO world_agent_skills(world_id,agent_id,skill_name,skill_value,actions_completed)
      VALUES($1,$2,$3,$4,1) ON CONFLICT(world_id,agent_id,skill_name) DO UPDATE SET
        skill_value=LEAST(100,world_agent_skills.skill_value+$4),
        actions_completed=world_agent_skills.actions_completed+1,updated_at=now()`, [worldId, agentId, skill, gain]);
  }
}

async function refreshSocialProfile(client, worldId, agentId, worldMinutes, sourceEventId) {
  const profileResult = await client.query(`SELECT COALESCE(g.category,p.primary_goal) AS primary_goal,
        COALESCE(g.id,0)::bigint AS active_goal_id,p.goal_progress,p.goal_milestones,p.goal_last_updated_world_minutes,
        s.risk_tolerance,m.energy,m.food,m.social FROM world_social_profiles p
      JOIN world_agent_states s ON s.world_id=p.world_id AND s.agent_id=p.agent_id
      JOIN world_members m ON m.world_id=p.world_id AND m.agent_id=p.agent_id
      LEFT JOIN LATERAL (SELECT id,category FROM world_agent_goals WHERE world_id=p.world_id AND agent_id=p.agent_id
        AND goal_type='primary' AND status='active' ORDER BY priority DESC,id LIMIT 1) g ON true
      WHERE p.world_id=$1 AND p.agent_id=$2 FOR UPDATE OF p,s,m`, [worldId, agentId]);
  const skillResult = await client.query(`SELECT skill_name,skill_value::text AS value,actions_completed FROM world_agent_skills
      WHERE world_id=$1 AND agent_id=$2`, [worldId, agentId]);
  const relationshipResult = await client.query(`SELECT other.id AS "otherAgentId",other.name,
        r.familiarity::text AS familiarity,r.trust::text AS trust,r.affinity::text AS affinity,
        r.interaction_count AS "interactionCount" FROM world_relationships r
      JOIN agents other ON other.id=CASE WHEN r.agent_a_id=$2 THEN r.agent_b_id ELSE r.agent_a_id END
      WHERE r.world_id=$1 AND (r.agent_a_id=$2 OR r.agent_b_id=$2)`, [worldId, agentId]);
  const wealthResult = await client.query(`SELECT COALESCE(sum(b.balance * CASE WHEN b.asset_symbol='USDC' THEN 1 ELSE q.price_usd END),0)::text AS value
      FROM crypto_balances b LEFT JOIN crypto_market_quotes q ON q.symbol=b.asset_symbol
      WHERE b.world_id=$1 AND b.agent_id=$2 AND b.asset_symbol IN ('USDC','BTC','ETH')`, [worldId, agentId]);
  const incomeResult = await client.query(`SELECT COALESCE(sum(amount),0)::text AS value FROM crypto_ledger
      WHERE world_id=$1 AND agent_id=$2 AND asset_symbol='USDC' AND entry_type='work_income'`, [worldId, agentId]);
  const actionResult = await client.query(`SELECT actions_taken FROM agent_minds WHERE world_id=$1 AND agent_id=$2`, [worldId, agentId]);
  const needResult = await client.query(`SELECT energy,food,social FROM world_members WHERE world_id=$1 AND agent_id=$2`, [worldId, agentId]);
  const recentActionResult = await client.query(`SELECT memory_type,metadata FROM agent_memories
    WHERE world_id=$1 AND agent_id=$2 ORDER BY world_minutes DESC,id DESC LIMIT 30`, [worldId, agentId]);
  const profile = profileResult.rows[0];
  if (!profile) return null;
  const skills = Object.fromEntries(skillResult.rows.map((row) => [row.skill_name, finite(row.value)]));
  const skillActions = Object.fromEntries(skillResult.rows.map((row) => [row.skill_name, finite(row.actions_completed)]));
  const relationships = relationshipResult.rows;
  const metricState = {
    skills, skillActions, relationships,
    netWorthUsd: finite(wealthResult.rows[0]?.value),
    workIncomeUsd: finite(incomeResult.rows[0]?.value),
    completedActions: finite(actionResult.rows[0]?.actions_taken),
    needs: needResult.rows[0] || { energy: 50, food: 50, social: 50 },
    recentActions: recentActionResult.rows.map((memory) => memory.metadata?.action).filter(Boolean)
  };
  const priorMilestones = Number(profile.goal_milestones) || 0;
  const progress = goalProgress(profile.primary_goal, metricState, priorMilestones);
  const isFirstProgress = profile.goal_last_updated_world_minutes === null;
  const role = deriveDominantRole(skills, profile.primary_goal);
  await client.query(`UPDATE world_social_profiles SET primary_goal=$3,goal_progress=$4,goal_milestones=$5,
      goal_last_updated_world_minutes=$6,dominant_role=$7,updated_at=now()
    WHERE world_id=$1 AND agent_id=$2`, [worldId, agentId, profile.primary_goal, progress.progress, progress.milestones,
    worldMinutes, role]);
  if (Number(profile.active_goal_id) > 0) await client.query(`UPDATE world_agent_goals SET progress=$3,
      updated_world_minutes=$4,updated_at=now() WHERE world_id=$1 AND id=$2 AND status='active'`,
  [worldId, profile.active_goal_id, progress.progress, worldMinutes]);
  if (!isFirstProgress && progress.milestones > priorMilestones) {
    await recordWorldEvent(client, worldId, agentId, sourceEventId, 'world.goal_milestone', {
      goal: profile.primary_goal, previousMilestones: priorMilestones, milestones: progress.milestones,
      progress: progress.progress, metric: progress.metric, worldMinutes
    });
  }
  return { ...progress, role, category: profile.primary_goal };
}

async function reflectResident(client, worldId, agent, tickCount, worldMinutes, trigger = 'cadence') {
  const profileResult = await client.query(`SELECT p.*,s.risk_tolerance,m.energy,m.food,m.social
    FROM world_social_profiles p JOIN world_agent_states s ON s.world_id=p.world_id AND s.agent_id=p.agent_id
    JOIN world_members m ON m.world_id=p.world_id AND m.agent_id=p.agent_id
    WHERE p.world_id=$1 AND p.agent_id=$2 FOR UPDATE OF p,s,m`, [worldId, agent.agentId]);
  const profile = profileResult.rows[0];
  if (!profile || !reflectionDue({ worldMinutes, lastReflectionWorldMinutes: profile.last_reflection_world_minutes,
    important: trigger === 'important_event' })) return null;

  const priorMinute = profile.last_reflection_world_minutes === null ? -1 : Number(profile.last_reflection_world_minutes);
  const memoryResult = await client.query(`SELECT memory_type AS "memoryType",summary,importance::text AS importance,world_minutes AS "worldMinutes",
      related_agent_id AS "relatedAgentId",metadata FROM agent_memories WHERE world_id=$1 AND agent_id=$2
    ORDER BY world_minutes DESC,id DESC LIMIT 100`, [worldId, agent.agentId]);
  const skillResult = await client.query(`SELECT skill_name AS skill,skill_value::text AS value,actions_completed AS actions FROM world_agent_skills
    WHERE world_id=$1 AND agent_id=$2 ORDER BY skill_name`, [worldId, agent.agentId]);
  const relationshipResult = await client.query(`SELECT CASE WHEN r.agent_a_id=$2 THEN r.agent_b_id ELSE r.agent_a_id END AS "otherAgentId",
      other.name,r.familiarity::text AS familiarity,r.trust::text AS trust,r.affinity::text AS affinity,
      r.interaction_count AS "interactionCount"
    FROM world_relationships r JOIN agents other ON other.id=CASE WHEN r.agent_a_id=$2 THEN r.agent_b_id ELSE r.agent_a_id END
    WHERE r.world_id=$1 AND (r.agent_a_id=$2 OR r.agent_b_id=$2)`, [worldId, agent.agentId]);
  const wealthResult = await client.query(`SELECT COALESCE(sum(b.balance * CASE WHEN b.asset_symbol='USDC' THEN 1 ELSE q.price_usd END),0)::text AS value
    FROM crypto_balances b LEFT JOIN crypto_market_quotes q ON q.symbol=b.asset_symbol
    WHERE b.world_id=$1 AND b.agent_id=$2 AND b.asset_symbol IN ('USDC','BTC','ETH')`, [worldId, agent.agentId]);
  const incomeResult = await client.query(`SELECT COALESCE(sum(amount),0)::text AS value FROM crypto_ledger
    WHERE world_id=$1 AND agent_id=$2 AND asset_symbol='USDC' AND entry_type='work_income'`, [worldId, agent.agentId]);
  const goalResult = await client.query(`SELECT id,goal_type AS "goalType",category,description,priority::text AS priority,
      progress::text AS progress,status,source,metadata,updated_world_minutes AS "updatedWorldMinutes" FROM world_agent_goals
    WHERE world_id=$1 AND agent_id=$2 AND status='active' ORDER BY CASE goal_type WHEN 'primary' THEN 0 WHEN 'secondary' THEN 1 ELSE 2 END,
      priority DESC,updated_world_minutes DESC LIMIT 7`, [worldId, agent.agentId]);
  const memories = memoryResult.rows;
  const newMemories = memories.filter((memory) => Number(memory.worldMinutes) > priorMinute);
  const skills = Object.fromEntries(skillResult.rows.map((skill) => [skill.skill, Number(skill.value)]));
  const skillActions = Object.fromEntries(skillResult.rows.map((skill) => [skill.skill, Number(skill.actions)]));
  const relationships = relationshipResult.rows.map((relation) => ({ ...relation,
    familiarity: Number(relation.familiarity), trust: Number(relation.trust), affinity: Number(relation.affinity) }));
  const balances = { netWorthUsd: Number(wealthResult.rows[0]?.value) || 0 };
  const workIncomeUsd = Number(incomeResult.rows[0]?.value) || 0;
  const activePrimary = goalResult.rows.find((goal) => goal.goalType === 'primary') || null;
  const actionsResult = await client.query(`SELECT actions_taken FROM agent_minds WHERE world_id=$1 AND agent_id=$2`,
    [worldId, agent.agentId]);
  const metricState = { skills, skillActions, relationships, netWorthUsd: balances.netWorthUsd, workIncomeUsd,
    completedActions: Number(actionsResult.rows[0]?.actions_taken) || 0,
    recentActions: memories.slice(0, 30).map((memory) => memory.metadata?.action).filter(Boolean),
    needs: { energy: agent.energy, food: agent.food, social: agent.social } };
  const currentProgress = activePrimary ? goalProgress(activePrimary.category, metricState, Number(profile.goal_milestones) || 0) : null;
  if (activePrimary && currentProgress) await client.query(`UPDATE world_agent_goals SET progress=$3,updated_world_minutes=$4,updated_at=now()
    WHERE world_id=$1 AND id=$2`, [worldId, activePrimary.id, currentProgress.progress, worldMinutes]);

  const proposal = reflectionProposal({ profile: { ...profile, riskModifier: Number(profile.risk_modifier) || 0,
      personalityModifiers: profile.personality_modifiers || {} },
    memories: newMemories, skills, relationships, balances, needs: metricState.needs, currentGoal: activePrimary, worldMinutes });

  const outcomes = new Map();
  for (const memory of newMemories) {
    const action = memory.metadata?.action || ({ work: 'work', learning: 'learn', trade: 'trade', failure: 'trade',
      social: 'socialize', cooperation: 'cooperate' })[memory.memoryType];
    const outcome = Number(memory.metadata?.outcome);
    if (!action || !Number.isFinite(outcome)) continue;
    const record = outcomes.get(action) || { count: 0, sum: 0 };
    record.count++;
    record.sum += Math.max(-1, Math.min(1, outcome));
    outcomes.set(action, record);
  }
  for (const [action, sample] of outcomes) {
    const estimate = sample.sum / sample.count;
    await client.query(`INSERT INTO world_agent_beliefs(world_id,agent_id,subject_type,subject_key,belief_key,
        estimate,confidence,sample_count,updated_world_minutes,evidence)
      VALUES($1,$2,'action',$3,'outcome',$4,$5,$6,$7,$8::jsonb)
      ON CONFLICT(world_id,agent_id,subject_type,subject_key,belief_key) DO UPDATE SET
        estimate=(world_agent_beliefs.estimate*world_agent_beliefs.sample_count+EXCLUDED.estimate*EXCLUDED.sample_count)
          / NULLIF(world_agent_beliefs.sample_count+EXCLUDED.sample_count,0),
        confidence=LEAST(0.95,(world_agent_beliefs.sample_count+EXCLUDED.sample_count)*0.08),
        sample_count=world_agent_beliefs.sample_count+EXCLUDED.sample_count,
        updated_world_minutes=EXCLUDED.updated_world_minutes,evidence=EXCLUDED.evidence`,
    [worldId, agent.agentId, action, estimate, Math.min(0.95, sample.count * 0.08), sample.count, worldMinutes,
      JSON.stringify({ samplesInReflection: sample.count, lastWorldMinute: worldMinutes })]);
  }

  const currentPrimaryProgress = currentProgress?.progress ?? Number(activePrimary?.progress || 0);
  let selectedGoal = activePrimary;
  if (activePrimary && currentPrimaryProgress >= 100) {
    await client.query(`UPDATE world_agent_goals SET status='completed',progress=100,updated_world_minutes=$3,updated_at=now()
      WHERE world_id=$1 AND id=$2 AND status='active'`, [worldId, activePrimary.id, worldMinutes]);
    const generated = proposal.nextGoal;
    const inserted = await client.query(`INSERT INTO world_agent_goals(world_id,agent_id,goal_type,category,description,
        priority,parent_goal_id,created_world_minutes,updated_world_minutes,source,metadata)
      VALUES($1,$2,'primary',$3,$4,1,$5,$6,$6,$7,$8::jsonb)
      ON CONFLICT DO NOTHING RETURNING id,goal_type AS "goalType",category,description,priority::text AS priority,
        progress::text AS progress,status,source,metadata`,
    [worldId, agent.agentId, generated.category, generated.description, activePrimary.id, worldMinutes, generated.source,
      JSON.stringify(generated.metadata || {})]);
    selectedGoal = inserted.rows[0] || activePrimary;
    await client.query(`UPDATE world_social_profiles SET primary_goal=$3,goal_progress=0,goal_milestones=0,
        goal_started_world_minutes=$4,goal_last_updated_world_minutes=$4,updated_at=now()
      WHERE world_id=$1 AND agent_id=$2`, [worldId, agent.agentId, selectedGoal.category, worldMinutes]);
  }

  const currentSecondaries = goalResult.rows.filter((goal) => goal.goalType === 'secondary');
  if (currentSecondaries.length < 3) {
    const skill = Object.entries(skills).sort((a, b) => a[1] - b[1])[0]?.[0] || 'research';
    const proposedSecondary = newMemories.some((memory) => memory.memoryType === 'cooperation')
      ? { category: 'COOPERATE_AND_BUILD', description: 'Develop useful work partnerships through real shared activity.',
        source: 'relationship', metadata: {} }
      : { category: `DEVELOP_${skill.toUpperCase()}`, description: `Develop ${skill} through repeated useful practice.`,
        source: 'experience', metadata: { skill } };
    if (!currentSecondaries.some((goal) => goal.category === proposedSecondary.category)) await client.query(`
      INSERT INTO world_agent_goals(world_id,agent_id,goal_type,category,description,priority,parent_goal_id,
        created_world_minutes,updated_world_minutes,source,metadata)
      VALUES($1,$2,'secondary',$3,$4,0.55,$5,$6,$6,$7,$8::jsonb) ON CONFLICT DO NOTHING`,
    [worldId, agent.agentId, proposedSecondary.category, proposedSecondary.description, selectedGoal?.id || null,
      worldMinutes, proposedSecondary.source, JSON.stringify(proposedSecondary.metadata)]);
  }

  const shortGoals = goalResult.rows.filter((goal) => goal.goalType === 'short');
  if (!shortGoals.length || worldMinutes - Number(shortGoals[0]?.updatedWorldMinutes || 0) >= 720) {
    await client.query(`UPDATE world_agent_goals SET status='completed',updated_world_minutes=$3,updated_at=now()
      WHERE world_id=$1 AND agent_id=$2 AND goal_type='short' AND status='active'`, [worldId, agent.agentId, worldMinutes]);
    const weakNeed = ['energy', 'food', 'social'].sort((a, b) => Number(agent[a] ?? 50) - Number(agent[b] ?? 50))[0];
    const short = Number(agent[weakNeed] ?? 50) < 55
      ? { category: 'RESTORE_NEEDS', description: `Restore ${weakNeed} before taking on another demanding activity.` }
      : { category: `PRACTICE_${(proposal.rationale.bestSkill || 'research').toUpperCase()}`,
        description: `Take a concrete step to practice ${proposal.rationale.bestSkill || 'research'}.` };
    await client.query(`INSERT INTO world_agent_goals(world_id,agent_id,goal_type,category,description,priority,
        parent_goal_id,created_world_minutes,updated_world_minutes,source,metadata)
      VALUES($1,$2,'short',$3,$4,0.45,$5,$6,$6,'self_generated',$7::jsonb) ON CONFLICT DO NOTHING`,
    [worldId, agent.agentId, short.category, short.description, selectedGoal?.id || null, worldMinutes,
      JSON.stringify({ trigger, need: weakNeed })]);
  }

  const profileUpdates = await client.query(`UPDATE world_social_profiles SET personality_modifiers=$3::jsonb,
      risk_modifier=$4,last_reflection_world_minutes=$5,updated_at=now()
    WHERE world_id=$1 AND agent_id=$2 RETURNING sociability::text AS sociability,curiosity::text AS curiosity,
      discipline::text AS discipline,ambition::text AS ambition`,
  [worldId, agent.agentId, JSON.stringify(proposal.modifiers), proposal.riskModifier, worldMinutes]);
  const reflection = await client.query(`INSERT INTO world_agent_reflections(world_id,agent_id,world_minutes,trigger,rationale)
    VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT(world_id,agent_id,world_minutes) DO NOTHING RETURNING id`,
  [worldId, agent.agentId, worldMinutes, trigger, JSON.stringify(proposal.rationale)]);
  const eventId = await recordWorldEvent(client, worldId, agent.agentId, tickCount, 'world.agent_reflected', {
    trigger, worldMinutes, goal: selectedGoal?.category || null, personalityModifiers: proposal.modifiers,
    riskModifier: proposal.riskModifier, rationale: proposal.rationale
  });

  const beliefResult = await client.query(`SELECT subject_key,estimate::text AS estimate,confidence::text AS confidence
    FROM world_agent_beliefs WHERE world_id=$1 AND agent_id=$2 AND subject_type='action'
      AND belief_key='outcome' ORDER BY sample_count DESC,subject_key`, [worldId, agent.agentId]);
  const strongest = beliefResult.rows[0];
  if (strongest && Number(strongest.confidence) >= 0.24) await recordConsolidatedMemory(client, {
    worldId, agentId: agent.agentId, worldMinutes, key: `belief:action:${strongest.subject_key}`,
    summary: `${strongest.subject_key} has been a ${Number(strongest.estimate) >= 0 ? 'reliable' : 'difficult'} path in recent personal experience.`,
    importance: 0.68, metadata: { action: strongest.subject_key, estimate: Number(strongest.estimate),
      confidence: Number(strongest.confidence), reflectionId: reflection.rows[0]?.id || null }
  });
  await pruneResidentMemories(client, worldId, agent.agentId);
  return { ...proposal, primaryGoal: selectedGoal?.category || null,
    personality: profileUpdates.rows[0] || null, reflectionId: reflection.rows[0]?.id || null, eventId };
}

async function completeSocialPair(client, worldId, actor, scene, runtime, tick) {
  if (!scene || !['cafe', 'garden', 'commons'].includes(scene.sceneType) || scene.status !== 'active') return null;
  const partners = await client.query(`SELECT m.agent_id AS "agentId",a.name,s.status,s.planned_action AS "plannedAction",
      m.location,r.familiarity::text AS familiarity,r.trust::text AS trust,r.affinity::text AS affinity,
      r.interaction_count AS "interactionCount",r.last_interaction_world_minutes AS "lastInteractionWorldMinutes"
    FROM world_members m JOIN agents a ON a.id=m.agent_id
    JOIN world_agent_states s ON s.world_id=m.world_id AND s.agent_id=m.agent_id
    LEFT JOIN world_relationships r ON r.world_id=m.world_id AND
      ((r.agent_a_id=$2 AND r.agent_b_id=m.agent_id) OR (r.agent_b_id=$2 AND r.agent_a_id=m.agent_id))
    WHERE m.world_id=$1 AND m.location=$3 AND m.agent_id<>$2 AND s.status='idle'
    ORDER BY COALESCE(r.familiarity,0) DESC,a.name`, [worldId, actor.agentId, scene.name]);
  const eligible = partners.rows.filter((partner) => canSocializePair({
    actor, partner: { ...partner, location: scene.name }, scene, worldMinutes: runtime.world_minutes
  }));
  const preferredId = actor.social_partner_id || actor.socialPartnerId;
  const partner = eligible.find((item) => item.agentId === preferredId) || eligible[0];
  if (!partner) return null;
  const pair = canonicalPair(actor.agentId, partner.agentId);
  if (!pair) return null;
  const relationship = (await client.query(`INSERT INTO world_relationships(world_id,agent_a_id,agent_b_id,
      familiarity,trust,affinity,last_interaction_world_minutes,interaction_count)
    VALUES($1,$2,$3,8,2,3,$4,1)
    ON CONFLICT(world_id,agent_a_id,agent_b_id) DO UPDATE SET
      familiarity=LEAST(100,world_relationships.familiarity+8),
      trust=LEAST(100,world_relationships.trust+2),affinity=LEAST(100,world_relationships.affinity+3),
      last_interaction_world_minutes=EXCLUDED.last_interaction_world_minutes,
      interaction_count=world_relationships.interaction_count+1,updated_at=now()
    RETURNING familiarity::text AS familiarity,trust::text AS trust,affinity::text AS affinity,
      interaction_count AS "interactionCount"`, [worldId, pair[0], pair[1], runtime.world_minutes])).rows[0];
  const eventId = await recordWorldEvent(client, worldId, actor.agentId, tick, 'world.social_interaction', {
    partnerId: partner.agentId, partnerName: partner.name, place: scene.name,
    worldMinutes: finite(runtime.world_minutes), relationship
  });
  const importance = Number(relationship.interactionCount) >= 5 ? 0.72 : 0.48;
  const summary = `Met ${partner.name} at ${scene.name}.`;
  await recordResidentMemory(client, { worldId, agentId: actor.agentId, memoryType: 'social', summary, importance,
    worldMinutes: runtime.world_minutes, location: scene.name, relatedAgentId: partner.agentId,
    metadata: { familiarity: Number(relationship.familiarity), trust: Number(relationship.trust), affinity: Number(relationship.affinity) },
    sourceEventId: eventId });
  await recordResidentMemory(client, { worldId, agentId: partner.agentId, memoryType: 'social',
    summary: `Met ${actor.name} at ${scene.name}.`, importance, worldMinutes: runtime.world_minutes,
    location: scene.name, relatedAgentId: actor.agentId,
    metadata: { familiarity: Number(relationship.familiarity), trust: Number(relationship.trust), affinity: Number(relationship.affinity) },
    sourceEventId: eventId });
  return { partnerId: partner.agentId, partnerName: partner.name, relationship, eventId };
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

async function completeWorldInitiativeActivity(client, worldId, agent, runtime, activity) {
  const context = safeJson(agent.planned_context);
  const nowWorld = finite(runtime.world_minutes);
  const key = actionId(agent.agentId, runtime.tick_count, `v3:${activity}`);
  let detail = null;
  try {
    if (activity === 'goal_review') {
      const proposal = safeJson(context.goalReviewProposal);
      const primary = await client.query(`SELECT id,category FROM world_agent_goals
        WHERE world_id=$1 AND agent_id=$2 AND goal_type='primary' AND status='active'
        ORDER BY priority DESC,id LIMIT 1`, [worldId, agent.agentId]);
      if (!primary.rowCount) throw Object.assign(new Error('ACTIVE_PRIMARY_GOAL_REQUIRED'), { statusCode: 409 });
      const activeShort = await client.query(`SELECT count(*)::int AS count FROM world_agent_goals
        WHERE world_id=$1 AND agent_id=$2 AND goal_type='short' AND status='active'`, [worldId, agent.agentId]);
      if (Number(activeShort.rows[0].count) >= 3) throw Object.assign(new Error('SHORT_GOAL_CAPACITY_REACHED'), { statusCode: 409 });
      const inserted = await client.query(`INSERT INTO world_agent_goals(world_id,agent_id,goal_type,category,description,
          priority,parent_goal_id,created_world_minutes,updated_world_minutes,source,metadata)
        VALUES($1,$2,'short',$3,$4,0.62,$5,$6,$6,'stagnation',$7::jsonb)
        ON CONFLICT DO NOTHING RETURNING id,category,description`,
      [worldId, agent.agentId, String(proposal.category || 'REVIEW_GOAL').slice(0, 64),
        String(proposal.description || 'Choose a new concrete step toward the active primary goal.').slice(0, 240),
        primary.rows[0].id, nowWorld, JSON.stringify({ trigger: 'goal_stagnation', stagnationCycles: agent.goalStagnation?.state?.stagnationCycles || 0,
          worldNeedCount: agent.worldNeeds?.length || 0 })]);
      if (inserted.rowCount) await recordWorldEvent(client, worldId, agent.agentId, runtime.tick_count, 'world.goal_replanned', {
        goalId: primary.rows[0].id, goalCategory: primary.rows[0].category, subgoalId: inserted.rows[0].id,
        subgoalCategory: inserted.rows[0].category, worldMinutes: nowWorld, trigger: 'goal_stagnation'
      });
      detail = inserted.rowCount ? { replanned: true, goalCategory: primary.rows[0].category,
        subgoal: inserted.rows[0] } : { replanned: false, reason: 'SUBGOAL_ALREADY_EXISTS' };
    } else if (activity === 'opportunity_propose') {
      const proposal = safeJson(context.opportunityProposal);
      const created = await createWorldOpportunity(client, { ...proposal, worldId, creatorAgentId: agent.agentId,
        sourceType: 'resident', sourceKey: agent.agentId, worldTime: nowWorld,
        expiresWorldTime: nowWorld + Math.max(60, Math.min(720, finite(proposal.expiresInWorldMinutes, 360))),
        dedupeKey: `engine:${agent.agentId}:${Math.floor(nowWorld / 360)}` });
      detail = { id: created.id || null, status: created.status || 'open', title: proposal.title,
        type: proposal.type, created: created.created };
    } else if (activity === 'opportunity' || activity === 'opportunity_reject') {
      const opportunity = (agent.opportunities || []).find((item) => item.id === context.opportunityId);
      if (!opportunity) throw Object.assign(new Error('OPPORTUNITY_NOT_FOUND'), { statusCode: 404 });
      const decision = await decideWorldOpportunity(client, { worldId, opportunityId: context.opportunityId,
        agentId: agent.agentId, decision: activity === 'opportunity_reject' ? 'reject' : 'accept',
        actionId: key, worldTime: nowWorld, agent });
      if (activity === 'opportunity_reject') {
        detail = { id: context.opportunityId, title: opportunity.title, type: opportunity.opportunity_type,
          status: decision.status, reward: safeJson(opportunity.reward) };
      } else {
      const risk = safeJson(opportunity.risk);
      const failureChance = Math.max(0, Math.min(0.4, Number(risk.failureChance ?? risk.failureProbability ?? 0.08)));
      const succeeded = (stableInt(`${agent.agentId}:${runtime.tick_count}:${opportunity.id}:outcome`) % 10_000) / 10_000 >= failureChance;
      const completion = await completeOpportunityParticipation(client, { worldId, opportunityId: context.opportunityId,
        agentId: agent.agentId, worldTime: nowWorld, succeeded,
        outcome: { score: Number(agent.skills?.research || 0), decision: decision.status } });
      detail = { id: context.opportunityId, title: opportunity.title, type: opportunity.opportunity_type,
        status: completion.status || (succeeded ? 'completed' : 'failed'), reward: safeJson(opportunity.reward),
        rewardApplied: completion.rewardApplied || null };
      }
    } else if (activity === 'project_propose') {
      const proposal = safeJson(context.projectProposal);
      const project = await proposeWorldProject(client, { worldId, agentId: agent.agentId, actionId: key,
        ...proposal, organizationId: context.organizationId || null, worldTime: nowWorld });
      detail = { id: project.id, status: project.status, title: proposal.title, type: proposal.projectType };
    } else if (activity === 'project_join' || activity === 'project_reject' || activity === 'project_leave') {
      const decision = activity === 'project_reject' ? 'reject' : activity === 'project_leave' ? 'leave' : 'accept';
      detail = await decideProjectMembership(client, { worldId, projectId: context.projectId, agentId: agent.agentId,
        decision, actionId: key, worldTime: nowWorld, agent });
    } else if (activity === 'project_contribute') {
      detail = await contributeToProject(client, { worldId, projectId: context.projectId, agentId: agent.agentId,
        actionId: key, worldTime: nowWorld, contributionType: context.contributionType || 'work',
        skillValue: finite(agent.skills?.research) + finite(agent.skills?.engineering) + finite(agent.skills?.social)
          + finite(agent.skills?.trading), energy: agent.energy });
    } else if (activity === 'organization_found') {
      const proposal = safeJson(context.organizationProposal);
      detail = await foundWorldOrganization(client, { worldId, founderAgentId: agent.agentId,
        inviteAgentId: proposal.inviteAgentId, projectId: proposal.projectId, actionId: key,
        name: proposal.name, purpose: proposal.purpose, worldTime: nowWorld });
    } else if (activity === 'organization_join' || activity === 'organization_reject' || activity === 'organization_leave') {
      const decision = activity === 'organization_reject' ? 'reject' : activity === 'organization_leave' ? 'leave' : 'accept';
      detail = await decideOrganizationMembership(client, { worldId, organizationId: context.organizationId,
        agentId: agent.agentId, decision, actionId: key, worldTime: nowWorld });
    } else if (activity === 'organization_invite') {
      detail = await inviteWorldOrganization(client, { worldId, organizationId: context.organizationId,
        inviterAgentId: agent.agentId, inviteeAgentId: context.inviteeAgentId, actionId: key, worldTime: nowWorld });
    } else if (activity === 'organization_contribute') {
      const skillValue = Math.max(...Object.values(agent.skills || {}).map((value) => Number(value) || 0), 0);
      detail = await contributeOrganizationEffort(client, { worldId, organizationId: context.organizationId,
        agentId: agent.agentId, actionId: key, worldTime: nowWorld,
        effort: Math.max(0.1, Math.min(20, 1 + skillValue / 10 + finite(agent.energy) / 25)) });
    } else if (activity === 'information_share') {
      const proposal = safeJson(context.informationProposal);
      detail = await shareWorldInformation(client, { worldId, senderAgentId: agent.agentId,
        recipientAgentId: proposal.recipientAgentId, informationType: proposal.informationType,
        subjectType: proposal.subjectType, subjectKey: proposal.subjectKey, beliefKey: proposal.beliefKey,
        actionId: key, worldTime: nowWorld });
    } else if (['information_accept','information_ignore','information_doubt'].includes(activity)) {
      const decision = activity === 'information_accept' ? 'accept'
        : activity === 'information_doubt' ? 'doubt' : 'ignore';
      detail = await decideWorldInformationShare(client, { worldId, shareId: context.shareId,
        recipientAgentId: agent.agentId, decision, actionId: key, worldTime: nowWorld });
    }
    return { detail, error: null };
  } catch (error) {
    if (error.statusCode >= 400 && error.statusCode < 500) return { detail: null, error: error.message };
    throw error;
  }
}

async function recordInitiativeOutcome(client, { worldId, agent, activity, result, tickCount, worldMinutes }) {
  const details = result.initiative || {};
  const action = activity;
  const system = action === 'goal_review' ? 'goal'
    : action.startsWith('opportunity') ? 'opportunity'
    : action.startsWith('project') ? 'project'
      : action.startsWith('organization') ? 'organization'
        : action.startsWith('information') ? 'information' : null;
  if (!system && action !== 'project_contribute') return;
  const stageForAction = {
    goal_review: details.replanned ? 'replanned' : 'blocked',
    opportunity_propose: details.created ? 'created' : 'proposed',
    opportunity: 'accepted', opportunity_reject: 'rejected',
    project_propose: 'proposed', project_join: details.status === 'rejected' ? 'rejected' : 'joined',
    project_reject: 'rejected', project_contribute: details.completed ? 'completed' : 'progressed',
    project_leave: 'abandoned', organization_found: details.status === 'active' ? 'formed' : 'proposed',
    organization_join: 'joined',
    organization_reject: 'rejected', information_share: 'shared',
    information_accept: 'accepted', information_ignore: 'ignored'
  };
  const stage = result.abandoned ? 'blocked' : stageForAction[action];
  if (!stage) return;
  const reasonCode = result.abandoned ? String(result.abandoned).toUpperCase().replace(/[^A-Z0-9_]/g, '_').slice(0, 64) : 'NONE';
  const entityId = details.id || details.project?.id || details.opportunity?.id || null;
  await recordEmergenceEvent(client, { worldId, agentId: agent.agentId, worldMinutes, tickCount, system, stage,
    reasonCode, eventKey: `initiative-outcome:${agent.agentId}:${tickCount}:${action}:${stage}`,
    candidateId: String(entityId || agent.planned_context?.projectId || agent.planned_context?.opportunityId || action),
    action, details: { ...details, abandoned: result.abandoned || null } });

  if (action === 'project_join' && details.projectStatus === 'active') {
    await recordEmergenceEvent(client, { worldId, agentId: agent.agentId, worldMinutes, tickCount,
      system: 'project', stage: 'active', eventKey: `project-active:${details.id}:${tickCount}`,
      candidateId: String(details.id || ''), action, details: { projectStatus: details.projectStatus } });
  }

  if (action === 'organization_join' && details.organizationStatus === 'active') {
    await recordEmergenceEvent(client, { worldId, agentId: agent.agentId, worldMinutes, tickCount,
      system: 'organization', stage: 'formed', eventKey: `organization-formed:${details.id}`,
      candidateId: String(details.id || ''), action,
      details: { organizationStatus: details.organizationStatus } });
  }

  if (action === 'opportunity' && result.opportunity?.status === 'completed') {
    await recordEmergenceEvent(client, { worldId, agentId: agent.agentId, worldMinutes, tickCount,
      system: 'opportunity', stage: result.opportunity.status,
      eventKey: `opportunity-result:${agent.agentId}:${tickCount}:${result.opportunity.id}:completed`,
      candidateId: String(result.opportunity.id), action, details: result.opportunity });
  }
  if (action === 'opportunity' && result.opportunity?.status === 'failed') {
    await recordEmergenceEvent(client, { worldId, agentId: agent.agentId, worldMinutes, tickCount,
      system: 'opportunity', stage: 'failed', eventKey: `opportunity-result:${agent.agentId}:${tickCount}:${result.opportunity.id}:failed`,
      candidateId: String(result.opportunity.id), action, details: result.opportunity });
  }
  if (action === 'project_propose' && agent.planned_context?.projectProposal?.metadata?.createPlace) {
    await recordEmergenceEvent(client, { worldId, agentId: agent.agentId, worldMinutes, tickCount,
      system: 'place', stage: 'proposal', eventKey: `place-proposal:${agent.planned_context?.projectId || agent.agentId}:${tickCount}`,
      candidateId: String(entityId || action), action, details: {
        proposalReasons: agent.planned_context.projectProposal.metadata.proposalReasons || []
      } });
  }
  if (action === 'project_join' && details.projectStatus === 'active') {
    const project = (agent.projects || []).find((item) => item.id === agent.planned_context?.projectId);
    if (project?.metadata?.createPlace) await recordEmergenceEvent(client, { worldId, agentId: agent.agentId,
      worldMinutes, tickCount, system: 'place', stage: 'build_started',
      eventKey: `place-build-started:${project.id}`, candidateId: project.id, action,
      details: { projectTitle: project.title } });
  }
  if (action === 'project_contribute' && details.completed && details.place?.created) {
    await recordEmergenceEvent(client, { worldId, agentId: agent.agentId, worldMinutes, tickCount,
      system: 'place', stage: 'created', eventKey: `place-created:${details.place.id}`,
      candidateId: String(details.place.id), action, details: { name: details.place.name,
        projectId: agent.planned_context?.projectId || null } });
  }
}

async function completeActivity(client, worldId, agent, runtime, quotes, now, scene) {
  const activity = agent.planned_action;
  const place = agent.location;
  const profile = `${agent.agentId}:${runtime.tick_count}:${activity}`;
  let needs = { energy: 0, food: 0, social: 0, happiness: 0, knowledge: 0 };
  let result = { action: activity, place };
  let socialInteraction = null;
  let cooperativePartnerEventId = null;
  if (activity === 'work') {
    const dataCenter = agent.scene_type === 'data_center';
    const amount = 20 + (stableInt(`${profile}:wage`) % (dataCenter ? 71 : 61));
    await adjustUsdc(client, worldId, agent.agentId, `${amount}.00000000`, 'work_income',
      `${actionId(agent.agentId, runtime.tick_count, 'work_income')}:USDC`, dataCenter ? 'simulated data center wages' : 'simulated workshop wages');
    needs = { energy: -8, food: -6, social: -2, happiness: 2, knowledge: dataCenter ? 3 : 1 };
    result.income = { amount: `${amount}.00000000`, asset: 'USDC', simulated: true };
  } else if (activity === 'cooperate') {
    const pairId = canonicalPair(agent.agentId, agent.planned_partner_id);
    const partnerResult = pairId && scene && ['workshop', 'data_center'].includes(scene.sceneType) && scene.status === 'active'
      ? await client.query(`SELECT m.agent_id AS "agentId",a.name,m.energy,m.food,m.social,m.location,
          s.status,s.happiness,s.knowledge,COALESCE(s.goal,'balanced') AS goal,am.current_goal AS "currentGoal",
          COALESCE(r.familiarity,0)::text AS familiarity,COALESCE(r.trust,0)::text AS trust,
          COALESCE(r.affinity,0)::text AS affinity,r.last_interaction_world_minutes AS "lastInteractionWorldMinutes"
        FROM world_members m JOIN agents a ON a.id=m.agent_id
        JOIN world_agent_states s ON s.world_id=m.world_id AND s.agent_id=m.agent_id
        LEFT JOIN agent_minds am ON am.world_id=m.world_id AND am.agent_id=m.agent_id
        LEFT JOIN world_relationships r ON r.world_id=m.world_id AND r.agent_a_id=$1 AND r.agent_b_id=$2
        WHERE m.world_id=$3 AND m.agent_id=$6 AND m.location=$4 AND s.status='idle'
          AND (COALESCE(r.familiarity,0)>=15 OR COALESCE(r.trust,0)>=5)
          AND (r.last_interaction_world_minutes IS NULL OR $5-r.last_interaction_world_minutes>=${SOCIAL_COOLDOWN_WORLD_MINUTES})
        FOR UPDATE OF m,s`, [pairId[0], pairId[1], worldId, place, runtime.world_minutes, agent.planned_partner_id])
      : { rows: [] };
    const partner = partnerResult.rows[0];
    if (!partner || partner.agentId === agent.agentId) {
      result.abandoned = 'cooperation_partner_unavailable';
      needs.energy = -1;
    } else {
      const dataCenter = scene.sceneType === 'data_center';
      const base = dataCenter ? 71 : 61;
      const actorAmount = 20 + stableInt(`${profile}:coop-actor-wage`) % base;
      const partnerAmount = 20 + stableInt(`${profile}:coop-partner-wage`) % base;
      await adjustUsdc(client, worldId, agent.agentId, `${actorAmount}.00000000`, 'work_income',
        `${actionId(agent.agentId, runtime.tick_count, 'cooperate_income')}:USDC`, 'simulated cooperative work income');
      await adjustUsdc(client, worldId, partner.agentId, `${partnerAmount}.00000000`, 'work_income',
        `${actionId(agent.agentId, runtime.tick_count, `cooperate_income:${agent.agentId}`)}:USDC`, 'simulated cooperative work income');
      needs = { energy: -8, food: -6, social: 1, happiness: 4, knowledge: dataCenter ? 3 : 2 };
      const partnerNeeds = updatedNeeds(partner, { energy: -6, food: -4, social: 1, happiness: 3, knowledge: dataCenter ? 2 : 1 });
      await client.query(`UPDATE world_members SET energy=$3,food=$4,social=$5 WHERE world_id=$1 AND agent_id=$2`,
        [worldId, partner.agentId, partnerNeeds.energy, partnerNeeds.food, partnerNeeds.social]);
      await client.query(`UPDATE world_agent_states SET happiness=$3,knowledge=$4,next_decision_at=$5,updated_at=$6
        WHERE world_id=$1 AND agent_id=$2`, [worldId, partner.agentId, partnerNeeds.happiness, partnerNeeds.knowledge,
        new Date(now.getTime() + ACTION_SECONDS.cooperate * 1_000 + 5_000), now]);
      const relationship = (await client.query(`INSERT INTO world_relationships(world_id,agent_a_id,agent_b_id,
          familiarity,trust,affinity,last_interaction_world_minutes,interaction_count)
        VALUES($1,$2,$3,4,1.5,2,$4,1)
        ON CONFLICT(world_id,agent_a_id,agent_b_id) DO UPDATE SET
          familiarity=LEAST(100,world_relationships.familiarity+4),trust=LEAST(100,world_relationships.trust+1.5),
          affinity=LEAST(100,world_relationships.affinity+2),last_interaction_world_minutes=EXCLUDED.last_interaction_world_minutes,
          interaction_count=world_relationships.interaction_count+1,updated_at=now()
        RETURNING familiarity::text AS familiarity,trust::text AS trust,affinity::text AS affinity,
          interaction_count AS "interactionCount"`, [worldId, pairId[0], pairId[1], runtime.world_minutes])).rows[0];
      result.cooperation = { partnerId: partner.agentId, partnerName: partner.name,
        actorIncomeUsd: `${actorAmount}.00000000`, partnerIncomeUsd: `${partnerAmount}.00000000`,
        incomeUsd: `${actorAmount + partnerAmount}.00000000`, relationship };
      needs.incomeUsd = actorAmount;
      await setMindGoal(client, worldId, partner.agentId, partner.currentGoal || partner.goal, 'cooperate',
        `Worked with ${agent.name} at ${place} and earned ${partnerAmount}.00000000 simulated USDC.`);
      await recordWorldEvent(client, worldId, agent.agentId, runtime.tick_count, 'world.cooperation_completed', {
        partnerId: partner.agentId, partnerName: partner.name, place, worldMinutes: runtime.world_minutes,
        actorIncomeUsd: result.cooperation.actorIncomeUsd, partnerIncomeUsd: result.cooperation.partnerIncomeUsd,
        relationship
      });
    }
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
    socialInteraction = await completeSocialPair(client, worldId, agent, scene, runtime, runtime.tick_count);
    if (socialInteraction) result.socialInteraction = socialInteraction;
    needs = { energy: -2, food: -1, social: socialInteraction ? 20 : 0,
      happiness: socialInteraction ? 6 : 0, knowledge: socialInteraction ? 1 : 0 };
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
      if (trade.side === 'sell') {
        const history = await client.query(`SELECT side,quantity::text AS quantity,notional_usd::text AS "notionalUsd",
            fee_usdc::text AS "feeUsdc" FROM crypto_trades WHERE world_id=$1 AND agent_id=$2 AND asset_symbol=$3 ORDER BY id`,
        [worldId, agent.agentId, trade.asset]);
        result.trade.realizedPnlUsd = lastRealizedSalePnl(history.rows);
      }
      await recordWorldEvent(client, worldId, agent.agentId, runtime.tick_count, 'crypto.trade_filled',
        { ...result.trade, action: 'trade', place, timestamp: now.toISOString() });
      await client.query(`UPDATE world_agent_states SET last_trade_at=$3 WHERE world_id=$1 AND agent_id=$2`,
        [worldId, agent.agentId, now]);
      needs.energy = -1;
    }
  } else if (['goal_review','opportunity','opportunity_reject','opportunity_propose','project_propose','project_join','project_reject','project_contribute','project_leave',
    'organization_found','organization_join','organization_reject','organization_leave','organization_invite',
    'organization_contribute','information_share','information_accept','information_ignore','information_doubt'].includes(activity)) {
    const initiative = await completeWorldInitiativeActivity(client, worldId, agent, runtime, activity);
    if (initiative.error) result.abandoned = initiative.error;
    else {
      result.initiative = initiative.detail;
      result.initiativeAction = activity;
      needs = { energy: activity === 'project_contribute' ? -6 : -2, food: -1,
        social: activity === 'information_share' || activity === 'organization_found' ? 1 : 0,
        happiness: initiative.detail?.completed ? 3 : 1, knowledge: 0 };
      if (activity === 'opportunity' || activity === 'opportunity_reject') {
        result.opportunity = initiative.detail;
        if (activity === 'opportunity' && initiative.detail?.status === 'completed') needs.knowledge = 2;
      }
    }
  }

  const next = updatedNeeds(agent, needs);
  result.energy = next.energy;
  result.food = next.food;
  result.social = next.social;
  await client.query(`UPDATE world_members SET energy=$3,food=$4,social=$5 WHERE world_id=$1 AND agent_id=$2`,
    [worldId, agent.agentId, next.energy, next.food, next.social]);
  await client.query(`UPDATE world_agent_states SET happiness=$3,knowledge=$4,status='idle',planned_action=NULL,
      target_location=NULL,planned_partner_id=NULL,planned_side=NULL,planned_asset=NULL,planned_quote_units=NULL,planned_paid_meal=false,
      planned_context='{}'::jsonb,
      fruitfly_observation='{}'::jsonb,fruitfly_candidates='[]'::jsonb,fruitfly_selected='{}'::jsonb,
      movement_started_at=NULL,movement_ends_at=NULL,action_started_at=NULL,action_ends_at=NULL,
      next_decision_at=$5,updated_at=$6 WHERE world_id=$1 AND agent_id=$2`,
  [worldId, agent.agentId, next.happiness, next.knowledge, new Date(now.getTime() + 5_000 + stableInt(`${profile}:think`) % 11_000), now]);
  const summary = activity === 'work' ? `Completed a paid shift at ${place}.`
    : activity === 'learn' ? `Studied at ${place} and gained knowledge.`
      : activity === 'rest' ? `Rested at ${place}.`
        : activity === 'eat' ? `Ate at ${place}.`
      : activity === 'socialize' ? (socialInteraction ? `Met ${socialInteraction.partnerName} at ${place}.` : `Spent time in the social space at ${place}.`)
      : activity === 'cooperate' ? (result.cooperation ? `Worked with ${result.cooperation.partnerName} at ${place}.` : 'The planned cooperation could not take place.')
        : activity === 'trade' ? (result.trade ? `Completed a simulated ${result.trade.side} of ${result.trade.asset} at Exchange.` : 'Skipped an unavailable simulated trade.')
          : result.abandoned ? `The planned ${activity.replaceAll('_', ' ')} could not proceed.`
            : `${activity.replaceAll('_', ' ')} completed${result.initiative?.title ? `: ${result.initiative.title}` : ''}.`;
  await setMindGoal(client, worldId, agent.agentId, agent.current_goal || agent.goal, activity, summary);
  const completionEventId = await recordWorldEvent(client, worldId, agent.agentId, runtime.tick_count, 'world.action_completed', {
    ...result, needs: next, status: 'completed', worldMinutes: finite(runtime.world_minutes)
  });
  if (result.initiativeAction) await recordInitiativeOutcome(client, { worldId, agent, activity,
    result, tickCount: runtime.tick_count, worldMinutes: runtime.world_minutes });
  if (activity === 'cooperate' && result.cooperation) {
    cooperativePartnerEventId = await recordWorldEvent(client, worldId, result.cooperation.partnerId,
      runtime.tick_count, 'world.action_completed', {
        action: 'cooperate', partnerId: agent.agentId, partnerName: agent.name, place, status: 'completed',
        incomeUsd: result.cooperation.partnerIncomeUsd, worldMinutes: finite(runtime.world_minutes)
      });
  }
  if (socialInteraction) {
    await applySkillGains(client, worldId, agent.agentId, activity, place, true);
    await applySkillGains(client, worldId, socialInteraction.partnerId, activity, place, true);
    await refreshSocialProfile(client, worldId, agent.agentId, runtime.world_minutes, socialInteraction.eventId);
    await refreshSocialProfile(client, worldId, socialInteraction.partnerId, runtime.world_minutes, socialInteraction.eventId);
  } else if (activity === 'cooperate' && result.cooperation) {
    const actorMemory = memoryForCompletedAction({ action: 'cooperate', result, place, worldMinutes: runtime.world_minutes });
    const partnerMemory = memoryForCompletedAction({ action: 'cooperate', place, worldMinutes: runtime.world_minutes,
      result: { cooperation: { partnerId: agent.agentId, partnerName: agent.name, incomeUsd: result.cooperation.partnerIncomeUsd } } });
    await applySkillGains(client, worldId, agent.agentId, activity, place, true);
    await applySkillGains(client, worldId, result.cooperation.partnerId, activity, place, true);
    if (actorMemory) await recordResidentMemory(client, { worldId, agentId: agent.agentId, ...actorMemory,
      worldMinutes: runtime.world_minutes, location: place, sourceEventId: completionEventId });
    if (partnerMemory) await recordResidentMemory(client, { worldId, agentId: result.cooperation.partnerId, ...partnerMemory,
      worldMinutes: runtime.world_minutes, location: place, sourceEventId: cooperativePartnerEventId });
    await refreshSocialProfile(client, worldId, agent.agentId, runtime.world_minutes, completionEventId);
    await refreshSocialProfile(client, worldId, result.cooperation.partnerId, runtime.world_minutes, completionEventId);
  } else if (result.initiativeAction && !result.abandoned) {
    const initiativeAction = result.initiativeAction;
    let skillAction = null;
    let memoryType = 'initiative';
    let importance = 0.42;
    let summary = `${initiativeAction.replaceAll('_', ' ')} changed persistent world state.`;
    if (initiativeAction === 'opportunity' || initiativeAction === 'opportunity_reject') {
      const type = result.opportunity?.type;
      skillAction = initiativeAction === 'opportunity_reject' ? null : type === 'RESEARCH' || type === 'LEARNING' ? 'learn'
        : type === 'SOCIAL' || type === 'COOPERATION' ? 'socialize'
          : type === 'TRADE' ? 'trade' : 'work';
      if (initiativeAction === 'opportunity_reject') { memoryType = 'opportunity'; importance = 0.4; }
      else if (result.opportunity?.status === 'failed') { memoryType = 'failure'; importance = 0.62; }
      else { memoryType = 'opportunity'; importance = 0.56; }
      summary = initiativeAction === 'opportunity_reject'
        ? `Declined the ${type || 'world'} opportunity “${result.opportunity?.title || 'an opportunity'}” after evaluation.`
        : `${result.opportunity?.status === 'failed' ? 'Did not complete' : 'Completed'} the ${type || 'world'} opportunity “${result.opportunity?.title || 'an opportunity'}”.`;
    } else if (initiativeAction === 'opportunity_propose') {
      memoryType = 'opportunity';
      importance = result.initiative?.created ? 0.6 : 0.35;
      summary = result.initiative?.created
        ? `Proposed a ${result.initiative.type || 'world'} opportunity: ${result.initiative.title || 'a shared activity'}.`
        : 'Tried to propose a world opportunity, but the shared capacity was full.';
    } else if (initiativeAction === 'project_contribute') {
      memoryType = result.initiative?.completed ? 'project' : 'cooperation';
      importance = result.initiative?.completed ? 0.72 : 0.46;
      const projectResult = await client.query(`SELECT project_type FROM world_projects WHERE world_id=$1 AND id=$2`,
        [worldId, agent.planned_context?.projectId]);
      const type = projectResult.rows[0]?.project_type;
      skillAction = type === 'RESEARCH' || type === 'LEARNING' ? 'learn'
        : type === 'TRADE' ? 'trade' : type === 'SOCIAL' ? 'socialize' : 'work';
      summary = `${result.initiative?.completed ? 'Helped complete' : 'Contributed to'} a shared project${result.initiative?.progress !== undefined
        ? ` (${Number(result.initiative.progress).toFixed(1)}% complete)` : ''}.`;
      if (result.initiative?.completed) {
        const participants = await client.query(`SELECT agent_id FROM world_project_members
          WHERE world_id=$1 AND project_id=$2 AND status='completed'`, [worldId, agent.planned_context?.projectId]);
        for (const participant of participants.rows) await refreshSocialProfile(client, worldId, participant.agent_id,
          runtime.world_minutes, completionEventId);
      }
    } else if (initiativeAction.startsWith('organization_')) {
      skillAction = 'socialize';
      memoryType = 'organization';
      importance = result.initiative?.created ? 0.7 : 0.4;
      summary = `${initiativeAction.replaceAll('_', ' ')} updated a resident organization.`;
    } else if (initiativeAction.startsWith('information_')) {
      memoryType = 'information';
      importance = initiativeAction === 'information_accept' ? 0.46 : 0.35;
      summary = `Evaluated personal information sharing by choosing ${initiativeAction.slice('information_'.length)}.`;
    } else if (initiativeAction.startsWith('project_')) {
      memoryType = 'project';
      importance = initiativeAction === 'project_propose' ? 0.58 : 0.4;
      summary = `${initiativeAction.replaceAll('_', ' ')} changed a persistent collaboration project.`;
    }
    if (skillAction) await applySkillGains(client, worldId, agent.agentId, skillAction, place,
      initiativeAction.startsWith('organization_') || initiativeAction === 'project_contribute');
    await recordResidentMemory(client, { worldId, agentId: agent.agentId, memoryType, summary, importance,
      worldMinutes: runtime.world_minutes, location: place,
      relatedAgentId: result.initiative?.inviteAgentId || result.initiative?.partnerId || null,
      metadata: { action: initiativeAction, initiative: result.initiative || {}, outcome: result.opportunity?.status || 'success' },
      sourceEventId: completionEventId });
    await refreshSocialProfile(client, worldId, agent.agentId, runtime.world_minutes, completionEventId);
  } else if (activity !== 'socialize' && !result.abandoned) {
    const meaningful = activity === 'work' && result.income || activity === 'learn' && result.learning || activity === 'trade' && result.trade;
    if (meaningful) {
      await applySkillGains(client, worldId, agent.agentId, activity, place);
      const memory = memoryForCompletedAction({ action: activity, result, place, worldMinutes: runtime.world_minutes });
      if (memory) await recordResidentMemory(client, { worldId, agentId: agent.agentId, ...memory,
        worldMinutes: runtime.world_minutes, location: place, sourceEventId: completionEventId });
      await refreshSocialProfile(client, worldId, agent.agentId, runtime.world_minutes, completionEventId);
    }
  }
  const observation = safeJson(agent.fruitfly_observation);
  const candidates = Array.isArray(agent.fruitfly_candidates) ? agent.fruitfly_candidates : [];
  const selected = safeJson(agent.fruitfly_selected);
  return selected.learnerUsed && observation.self && candidates.length && selected.id
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
    await client.query(`INSERT INTO world_runtime_state(world_id,tick_count,world_minutes,last_tick_at,market_snapshot,typesafe_next_at)
      VALUES($1,0,480,now(),'{}'::jsonb,now()) ON CONFLICT(world_id) DO NOTHING`, [worldId]);
    const runtime = (await client.query('SELECT world_minutes FROM world_runtime_state WHERE world_id=$1', [worldId])).rows[0];
    const worldMinutes = Math.max(0, Math.trunc(finite(runtime?.world_minutes, 480)));
    for (const [index, member] of members.rows.entries()) {
      const profile = initialWorldAgentProfile(index);
      await client.query(`INSERT INTO world_agent_states(world_id,agent_id,goal,risk_tolerance,happiness,knowledge,next_decision_at)
        VALUES($1,$2,$3,$4,$5,$6,now()+($7::text || ' seconds')::interval) ON CONFLICT(world_id,agent_id) DO NOTHING`,
      [worldId, member.agent_id, profile.goal, profile.riskTolerance, profile.happiness, profile.knowledge, String(3 + index * 3)]);
      await ensureCryptoAccount(client, { worldId, agentId: member.agent_id });
      const social = initialSocialProfile(member.agent_id, index);
      const skills = initialSkillValues(member.agent_id, index);
      await client.query(`INSERT INTO world_social_profiles(world_id,agent_id,sociability,curiosity,discipline,ambition,
          primary_goal,goal_started_world_minutes,dominant_role)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(world_id,agent_id) DO NOTHING`,
      [worldId, member.agent_id, social.sociability, social.curiosity, social.discipline, social.ambition,
        social.primaryGoal, worldMinutes, deriveDominantRole(skills, social.primaryGoal)]);
      const currentProfile = (await client.query(`SELECT primary_goal FROM world_social_profiles
        WHERE world_id=$1 AND agent_id=$2`, [worldId, member.agent_id])).rows[0];
      const seeded = seededGoalSet(member.agent_id, index);
      const primaryCategory = currentProfile?.primary_goal || seeded.primary.category;
      const primaryDescription = goalDescription(primaryCategory) || seeded.primary.description;
      await client.query(`INSERT INTO world_agent_goals(world_id,agent_id,goal_type,category,description,priority,
          created_world_minutes,updated_world_minutes,source)
        SELECT $1,$2,'primary',$3,$4,1,$5,$5,'seed'
        WHERE NOT EXISTS (SELECT 1 FROM world_agent_goals WHERE world_id=$1 AND agent_id=$2
          AND goal_type='primary' AND status='active') ON CONFLICT DO NOTHING`,
      [worldId, member.agent_id, primaryCategory, primaryDescription, worldMinutes]);
      const activePrimary = (await client.query(`SELECT id FROM world_agent_goals WHERE world_id=$1 AND agent_id=$2
        AND goal_type='primary' AND status='active' ORDER BY priority DESC,id LIMIT 1`, [worldId, member.agent_id])).rows[0];
      for (const goalType of ['secondary', 'short']) {
        const count = (await client.query(`SELECT count(*)::int AS count FROM world_agent_goals
          WHERE world_id=$1 AND agent_id=$2 AND goal_type=$3 AND status='active'`, [worldId, member.agent_id, goalType])).rows[0].count;
        if (count > 0) continue;
        const seeds = seeded[goalType];
        for (const item of seeds.slice(0, goalType === 'secondary' ? 3 : 3)) {
          await client.query(`INSERT INTO world_agent_goals(world_id,agent_id,goal_type,category,description,priority,
              parent_goal_id,created_world_minutes,updated_world_minutes,source,metadata)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8,'seed',$9::jsonb) ON CONFLICT DO NOTHING`, [worldId, member.agent_id, goalType,
            item.category, item.description, item.priority, goalType === 'short' ? activePrimary?.id || null : null,
            worldMinutes, JSON.stringify({ seeded: true })]);
        }
      }
      for (const [skill, value] of Object.entries(skills)) {
        await client.query(`INSERT INTO world_agent_skills(world_id,agent_id,skill_name,skill_value)
          VALUES($1,$2,$3,$4) ON CONFLICT(world_id,agent_id,skill_name) DO NOTHING`,
        [worldId, member.agent_id, skill, value]);
      }
    }
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
        p.sociability::text AS sociability,p.curiosity::text AS curiosity,p.discipline::text AS discipline,p.ambition::text AS ambition,
        p.primary_goal AS "primaryGoal",p.goal_progress::text AS "goalProgress",p.dominant_role AS "dominantRole",
        p.personality_modifiers AS "personalityModifiers",p.risk_modifier::text AS "riskModifier",
        COALESCE((SELECT jsonb_object_agg(skill_name,skill_value) FROM world_agent_skills k
          WHERE k.world_id=m.world_id AND k.agent_id=m.agent_id),'{}'::jsonb) AS skills,
        COALESCE((SELECT jsonb_agg(jsonb_build_object('goalType',g.goal_type,'category',g.category,
            'description',g.description,'priority',g.priority,'progress',g.progress,'status',g.status,'source',g.source,
            'metadata',g.metadata) ORDER BY CASE g.goal_type WHEN 'primary' THEN 0 WHEN 'secondary' THEN 1 ELSE 2 END,
              g.priority DESC,g.updated_world_minutes DESC) FROM world_agent_goals g
          WHERE g.world_id=m.world_id AND g.agent_id=m.agent_id AND g.status='active'),'[]'::jsonb) AS goals,
        COALESCE((SELECT jsonb_agg(jsonb_build_object('memoryType',memory.memory_type,'summary',memory.summary,
            'importance',memory.importance,'worldMinutes',memory.world_minutes,'metadata',memory.metadata)
          ORDER BY memory.world_minutes DESC,memory.id DESC) FROM (SELECT memory_type,summary,importance,world_minutes,metadata,id
            FROM agent_memories WHERE world_id=m.world_id AND agent_id=m.agent_id
            ORDER BY world_minutes DESC,id DESC LIMIT 20) memory),'[]'::jsonb) AS memories,
        COALESCE((SELECT jsonb_agg(jsonb_build_object('otherAgentId',CASE WHEN rel.agent_a_id=m.agent_id THEN rel.agent_b_id ELSE rel.agent_a_id END,
            'name',other.name,'familiarity',rel.familiarity,'trust',rel.trust,'affinity',rel.affinity)
          ORDER BY rel.familiarity DESC,rel.trust DESC) FROM world_relationships rel
          JOIN agents other ON other.id=CASE WHEN rel.agent_a_id=m.agent_id THEN rel.agent_b_id ELSE rel.agent_a_id END
          WHERE rel.world_id=m.world_id AND (rel.agent_a_id=m.agent_id OR rel.agent_b_id=m.agent_id)),'[]'::jsonb) AS relationships,
        coalesce((SELECT balance::text FROM crypto_balances b WHERE b.world_id=m.world_id AND b.agent_id=m.agent_id AND b.asset_symbol='USDC'),'0') AS usdc,
        coalesce((SELECT balance::text FROM crypto_balances b WHERE b.world_id=m.world_id AND b.agent_id=m.agent_id AND b.asset_symbol='BTC'),'0') AS btc,
        coalesce((SELECT balance::text FROM crypto_balances b WHERE b.world_id=m.world_id AND b.agent_id=m.agent_id AND b.asset_symbol='ETH'),'0') AS eth
      FROM world_members m JOIN agents a ON a.id=m.agent_id JOIN world_agent_states s ON s.world_id=m.world_id AND s.agent_id=m.agent_id
      LEFT JOIN agent_minds am ON am.world_id=m.world_id AND am.agent_id=m.agent_id
      LEFT JOIN world_social_profiles p ON p.world_id=m.world_id AND p.agent_id=m.agent_id
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
    { id: 'BUILD_WEALTH', legacyGoal: 'wealth', action: 'work', goal: 'Build simulated savings through paid work and bounded Exchange activity.', description: 'Build simulated savings through paid work; only trade at Exchange with existing risk limits.' },
    { id: 'MASTER_TRADING', legacyGoal: 'wealth', action: 'trade', goal: 'Develop simulated trading expertise while respecting existing Exchange limits.', description: 'Practice at Exchange only when the existing risk gate permits it.' },
    { id: 'MASTER_RESEARCH', legacyGoal: 'learn', action: 'learn', goal: 'Grow research skill through study and observation.', description: 'Study in the library or observatory.' },
    { id: 'MASTER_ENGINEERING', legacyGoal: 'learn', action: 'work', goal: 'Grow engineering skill through data-center and workshop shifts.', description: 'Work at an existing workshop or data center.' },
    { id: 'BUILD_RELATIONSHIPS', legacyGoal: 'community', action: 'socialize', goal: 'Build meaningful familiarity with co-located residents.', description: 'Meet available residents at a cafe or garden.' },
    { id: 'BALANCED_LIFE', legacyGoal: 'balanced', action: 'rest', goal: 'Balance care, work, learning and social connection.', description: 'Choose a varied routine that supports needs and wellbeing.' }
  ];
  const skills = safeJson(resident.skills);
  const bestSkill = Object.entries(skills).sort((a, b) => Number(b[1]) - Number(a[1]))[0]?.[0] || 'research';
  goalCandidates.push({ id: `DEVELOP_${bestSkill.toUpperCase()}`, legacyGoal: bestSkill === 'trading' ? 'wealth'
    : bestSkill === 'social' ? 'community' : 'learn', action: bestSkill === 'trading' ? 'trade'
      : bestSkill === 'social' ? 'socialize' : bestSkill === 'engineering' ? 'work' : 'learn',
  goal: `Develop ${bestSkill} through useful practice informed by personal experience.`,
  description: `Continue building ${bestSkill} while protecting immediate needs.` });
  if (resident.memories.filter((memory) => Number(memory.metadata?.realizedPnlUsd) < 0).length >= 2) goalCandidates.push({
    id: 'RECOVER_FINANCIAL_STABILITY', legacyGoal: 'wealth', action: 'work',
    goal: 'Rebuild simulated financial stability after recent realized losses.',
    description: 'Prefer stable work and learning while allowing existing risk gates to govern any Exchange activity.'
  });
  const trusted = resident.relationships.find((relation) => Number(relation.familiarity) >= 40 && Number(relation.trust) >= 8);
  if (trusted) goalCandidates.push({ id: 'COOPERATE_WITH_RESIDENT', legacyGoal: 'community', action: 'cooperate',
    goal: `Find a useful shared project with ${trusted.name}.`, description: `Explore a real cooperative opportunity with ${trusted.name}.` });
  const traits = safeJson(resident.traits);
  const observation = {
    self: { agentId: resident.agentId, energy: resident.energy, food: resident.food, social: resident.social,
      location: resident.location, internalTokenUnits: '0' },
    members: snapshot.members.map((member) => ({ id: member.agentId, name: member.name, location: member.location })),
    scenes: snapshot.scenes,
      mind: { archetype: resident.archetype || 'observer', traits, currentGoal: resident.currentGoal,
      actionsTaken: resident.actionsTaken, memories: resident.memories, goals: resident.goals,
      relationships: resident.relationships, socialProfile: {
        primaryGoal: resident.primaryGoal, goalProgress: resident.goalProgress, dominantRole: resident.dominantRole,
        sociability: resident.sociability, curiosity: resident.curiosity, discipline: resident.discipline,
        ambition: resident.ambition, skills: resident.skills, modifiers: resident.personalityModifiers,
        riskModifier: resident.riskModifier
      } },
    market: { quotes: snapshot.quotes },
    trading: { balances: { USDC: resident.usdc, BTC: resident.btc, ETH: resident.eth }, positions: [],
      netAssetValueUsd: resident.usdc, risk: { simulatedOnly: true } }
  };
  const selection = await chooseWithTypeSafe(observation, goalCandidates, runtimeState, []);
  const selectedGoal = selection.decision?.id;
  const goalCandidate = goalCandidates.find((item) => item.id === selectedGoal);
  if (!goalCandidate) return { reason: selection.reason || 'fallback', resident: resident.name };
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`UPDATE world_agent_goals SET status='paused',updated_world_minutes=$3,updated_at=now()
      WHERE world_id=$1 AND agent_id=$2 AND goal_type='primary' AND status='active'`,
    [worldId, resident.agentId, snapshot.runtime.world_minutes]);
    await client.query(`INSERT INTO world_agent_goals(world_id,agent_id,goal_type,category,description,priority,
        created_world_minutes,updated_world_minutes,source,metadata)
      VALUES($1,$2,'primary',$3,$4,1,$5,$5,'strategy',$6::jsonb) ON CONFLICT DO NOTHING`,
    [worldId, resident.agentId, selectedGoal, goalCandidate.goal, snapshot.runtime.world_minutes,
      JSON.stringify({ selectedBy: 'typesafe', model: selection.model || null })]);
    await client.query(`UPDATE world_agent_states SET goal=$3,updated_at=now() WHERE world_id=$1 AND agent_id=$2`,
      [worldId, resident.agentId, goalCandidate.legacyGoal]);
    await client.query(`UPDATE agent_minds SET current_goal=$3,updated_at=now() WHERE world_id=$1 AND agent_id=$2`,
      [worldId, resident.agentId, goalCandidate.description]);
    await client.query(`UPDATE world_social_profiles SET primary_goal=$3,goal_progress=0,goal_milestones=0,
        goal_started_world_minutes=$4,goal_last_updated_world_minutes=$4,updated_at=now()
      WHERE world_id=$1 AND agent_id=$2`, [worldId, resident.agentId, selectedGoal, snapshot.runtime.world_minutes]);
    await recordWorldEvent(client, worldId, resident.agentId, snapshot.runtime.tick_count, 'world.goal_updated', {
      goal: selectedGoal, description: goalCandidate.goal, decisionSource: 'typesafe', simulated: true
    });
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
  return { reason: 'selected', resident: resident.name, goal: selectedGoal,
    model: selection.model || null, costUsd: selection.costUsd ?? null };
}

export async function startWorldEngine(pool, { onError = () => {}, onStatus = () => {}, chooseWithTypeSafe = null,
  runtimeState = null, fruitfly = null, tickMs = WORLD_TICK_MS, nowProvider = () => Date.now(), schedule = true } = {}) {
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
  let timer = null;
  const readNowMs = () => {
    const value = nowProvider();
    return value instanceof Date ? value.getTime() : finite(value, Date.now());
  };

  async function tick() {
    const nowMs = readNowMs();
    if (stopped || tickInProgress || nowMs < nextRetryAt) return;
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
        const now = new Date(nowMs);
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
        shouldAskTypeSafe = Boolean(chooseWithTypeSafe && !typeSafeInProgress && nowMs >= typeSafeDueAt && nowMs >= nextTypeSafeAt);
        if (shouldAskTypeSafe) {
          typeSafeInProgress = true;
          nextTypeSafeAt = nowMs + TYPE_SAFE_INTERVAL_MS;
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
            s.planned_partner_id AS planned_partner_id,s.planned_side,s.planned_asset,s.planned_quote_units::text AS planned_quote_units,s.planned_paid_meal,
            s.planned_context,s.next_strategic_decision_world_minutes AS next_strategic_decision_world_minutes,
            s.strategic_goal_category AS strategic_goal_category,
            s.strategic_goal_progress::text AS strategic_goal_progress,
            s.strategic_goal_progress_world_minutes AS strategic_goal_progress_world_minutes,
            s.strategic_goal_stagnation_cycles AS strategic_goal_stagnation_cycles,
            s.fruitfly_observation,s.fruitfly_candidates,s.fruitfly_selected,
            s.movement_started_at,s.movement_ends_at,s.action_started_at,s.action_ends_at,s.next_decision_at,s.last_trade_at,
            p.sociability::text AS sociability,p.curiosity::text AS curiosity,p.discipline::text AS discipline,
            p.ambition::text AS ambition,p.primary_goal AS primary_goal,p.goal_progress::text AS goal_progress,
            p.goal_milestones AS goal_milestones,p.dominant_role AS dominant_role,
            p.personality_modifiers,p.risk_modifier::text AS risk_modifier,
            p.last_reflection_world_minutes AS last_reflection_world_minutes,
            COALESCE((SELECT jsonb_object_agg(k.skill_name,k.skill_value) FROM world_agent_skills k
              WHERE k.world_id=m.world_id AND k.agent_id=m.agent_id),'{}'::jsonb) AS skills,
            COALESCE((SELECT jsonb_agg(jsonb_build_object('id',g.id,'goalType',g.goal_type,'category',g.category,
                'description',g.description,'priority',g.priority,'progress',g.progress,'status',g.status,'source',g.source,
                'parentGoalId',g.parent_goal_id,'metadata',g.metadata,'updatedWorldMinutes',g.updated_world_minutes)
              ORDER BY CASE g.goal_type WHEN 'primary' THEN 0 WHEN 'secondary' THEN 1 ELSE 2 END,g.priority DESC,g.updated_world_minutes DESC)
              FROM world_agent_goals g WHERE g.world_id=m.world_id AND g.agent_id=m.agent_id AND g.status='active'),
              '[]'::jsonb) AS goals,
            COALESCE((SELECT jsonb_agg(jsonb_build_object('subjectType',b.subject_type,'subjectKey',b.subject_key,
                'beliefKey',b.belief_key,'estimate',b.estimate,'confidence',b.confidence,'sampleCount',b.sample_count)
              ORDER BY b.sample_count DESC,b.subject_type,b.subject_key)
              FROM world_agent_beliefs b WHERE b.world_id=m.world_id AND b.agent_id=m.agent_id),'[]'::jsonb) AS beliefs,
            COALESCE((SELECT jsonb_agg(jsonb_build_object('id',recent.id,'memoryType',recent.memory_type,
                'summary',recent.summary,'importance',recent.importance,'worldMinutes',recent.world_minutes,
                'location',recent.location,'relatedAgentId',recent.related_agent_id,'metadata',recent.metadata)
                ORDER BY recent.world_minutes DESC,recent.id DESC)
              FROM (SELECT id,memory_type,summary,importance,world_minutes,location,related_agent_id,metadata
                FROM agent_memories WHERE world_id=m.world_id AND agent_id=m.agent_id
                ORDER BY world_minutes DESC,id DESC LIMIT 12) recent),'[]'::jsonb) AS recent_memories,
            COALESCE((SELECT jsonb_agg(jsonb_build_object('otherAgentId',recent.other_id,'name',recent.other_name,
                'familiarity',recent.familiarity,'trust',recent.trust,'affinity',recent.affinity,
                'interactionCount',recent.interaction_count,'lastInteractionWorldMinutes',recent.last_interaction_world_minutes)
                ORDER BY recent.familiarity DESC,recent.interaction_count DESC)
              FROM (SELECT CASE WHEN r.agent_a_id=m.agent_id THEN r.agent_b_id ELSE r.agent_a_id END AS other_id,
                  other.name AS other_name,r.familiarity,r.trust,r.affinity,r.interaction_count,r.last_interaction_world_minutes
                FROM world_relationships r JOIN agents other ON other.id=CASE WHEN r.agent_a_id=m.agent_id THEN r.agent_b_id ELSE r.agent_a_id END
                WHERE r.world_id=m.world_id AND (r.agent_a_id=m.agent_id OR r.agent_b_id=m.agent_id)
                ORDER BY r.familiarity DESC,r.interaction_count DESC LIMIT 12) recent),'[]'::jsonb) AS relationships,
            coalesce((SELECT balance::text FROM crypto_balances b WHERE b.world_id=m.world_id AND b.agent_id=m.agent_id AND b.asset_symbol='USDC'),'0') AS usdc,
            coalesce((SELECT balance::text FROM crypto_balances b WHERE b.world_id=m.world_id AND b.agent_id=m.agent_id AND b.asset_symbol='BTC'),'0') AS btc,
            coalesce((SELECT balance::text FROM crypto_balances b WHERE b.world_id=m.world_id AND b.agent_id=m.agent_id AND b.asset_symbol='ETH'),'0') AS eth,
            coalesce((SELECT sum(amount)::text FROM token_ledger l WHERE l.world_id=m.world_id AND l.agent_id=m.agent_id),'0') AS internal_units
          FROM world_members m JOIN agents a ON a.id=m.agent_id
          JOIN world_agent_states s ON s.world_id=m.world_id AND s.agent_id=m.agent_id
          LEFT JOIN agent_minds am ON am.world_id=m.world_id AND am.agent_id=m.agent_id
          LEFT JOIN world_social_profiles p ON p.world_id=m.world_id AND p.agent_id=m.agent_id
          WHERE m.world_id=$1 ORDER BY m.joined_at,a.name FOR UPDATE OF m,s`, [worldId]);
        const scenesResult = await client.query(`SELECT id,name,scene_type AS "sceneType",status,capacity,purpose,features,position
          FROM world_scenes
          WHERE world_id=$1 ORDER BY created_at,id`, [worldId]);
        const scenes = scenesResult.rows;
        const dueResidents = membersResult.rows.filter((member) => member.status === 'idle'
          && new Date(member.next_decision_at).getTime() <= now.getTime());
        let initiativeState = null;
        if (newHour > oldHour) {
          const expiredOpportunities = await expireWorldOpportunities(client, worldId, worldMinutes);
          for (const opportunity of expiredOpportunities) await recordEmergenceEvent(client, { worldId,
            worldMinutes, tickCount, system: 'opportunity', stage: 'expired',
            eventKey: `opportunity-expired:${opportunity.id}`, candidateId: opportunity.id,
            details: { title: opportunity.title } });
          const failedProjects = await expireWorldProjects(client, worldId, worldMinutes);
          for (const projectId of failedProjects) await recordEmergenceEvent(client, { worldId,
            worldMinutes, tickCount, system: 'project', stage: 'failed',
            reasonCode: 'DEADLINE_PASSED', eventKey: `project-failed:${projectId}`, candidateId: projectId });
          const expiringShares = await client.query(`SELECT id,sender_agent_id,recipient_agent_id FROM world_information_shares
            WHERE world_id=$1 AND status='offered' AND expires_world_time IS NOT NULL AND expires_world_time<=$2`,
          [worldId, worldMinutes]);
          await expireInformationShares(client, worldId, worldMinutes);
          for (const share of expiringShares.rows) await recordEmergenceEvent(client, { worldId,
            agentId: share.sender_agent_id, worldMinutes, tickCount, system: 'information', stage: 'expired',
            reasonCode: 'RECIPIENT_DID_NOT_RESPOND', eventKey: `information-expired:${share.id}`,
            candidateId: share.id, details: { recipientAgentId: share.recipient_agent_id } });
        }
        if (dueResidents.length || newHour > oldHour) {
          initiativeState = await loadWorldInitiatives(client, worldId, worldMinutes, membersResult.rows, scenes);
          if (newHour > oldHour) for (const idea of initiativeState.newIdeas) {
            const key = `environment-idea:${idea.dedupeKey}`;
            await recordEmergenceEvent(client, { worldId, worldMinutes, tickCount, system: 'opportunity',
              stage: 'considered', eventKey: `${key}:considered`, candidateId: idea.dedupeKey,
              details: { type: idea.type, title: idea.title, needReason: idea.metadata?.needReason || null } });
            await recordEmergenceEvent(client, { worldId, worldMinutes, tickCount, system: 'opportunity',
              stage: 'eligible', eventKey: `${key}:eligible`, candidateId: idea.dedupeKey,
              details: { type: idea.type, needReason: idea.metadata?.needReason || null } });
            const created = await createWorldOpportunity(client, { worldId, ...idea, worldTime: worldMinutes });
            await recordEmergenceEvent(client, { worldId, worldMinutes, tickCount, system: 'opportunity',
              stage: created.created ? 'created' : 'blocked', reasonCode: created.created ? 'NONE' : 'COOLDOWN',
              eventKey: `${key}:${created.created ? 'created' : 'blocked'}`, candidateId: created.id || idea.dedupeKey,
              details: { type: idea.type, title: idea.title } });
          }
        }
        const placeCounts = Object.fromEntries(membersResult.rows.map((member) => [member.location,
          membersResult.rows.filter((other) => other.location === member.location).length - 1]));

        for (const row of membersResult.rows) {
          const agent = { ...row, agentId: row.agent_id,
            lastTradeAt: row.last_trade_at, planned_paid_meal: row.planned_paid_meal,
            social_partner_id: row.planned_partner_id,
            riskTolerance: clamp(finite(row.risk_tolerance) + finite(row.risk_modifier), 0, 1),
            sociability: finite(row.sociability, 0.5), curiosity: finite(row.curiosity, 0.5),
            discipline: finite(row.discipline, 0.5), ambition: finite(row.ambition, 0.5),
            personalityModifiers: safeJson(row.personality_modifiers),
            primaryGoal: row.primary_goal || 'BALANCED_LIFE', skills: safeJson(row.skills),
            goals: Array.isArray(row.goals) ? row.goals : [], beliefs: Array.isArray(row.beliefs) ? row.beliefs : [],
            recentMemories: Array.isArray(row.recent_memories) ? row.recent_memories : [],
            relationships: Array.isArray(row.relationships) ? row.relationships : [] };
          const initiativeData = initiativeState?.byAgent.get(agent.agentId) || {};
          Object.assign(agent, initiativeData);
          const lastReflection = row.last_reflection_world_minutes === null ? null : Number(row.last_reflection_world_minutes);
          const newImportantMemory = agent.recentMemories.some((memory) => Number(memory.importance) >= 0.7
            && Number(memory.worldMinutes) > (lastReflection ?? -1));
          const reflectionTrigger = newImportantMemory ? 'important_event' : 'cadence';
          const reflected = reflectionDue({ worldMinutes, lastReflectionWorldMinutes: lastReflection,
            important: reflectionTrigger === 'important_event' })
            ? await reflectResident(client, worldId, agent, tickCount, worldMinutes, reflectionTrigger) : null;
          if (reflected) {
            agent.personalityModifiers = reflected.modifiers;
            agent.riskTolerance = clamp(finite(row.risk_tolerance) + reflected.riskModifier, 0, 1);
            agent.primaryGoal = reflected.primaryGoal || agent.primaryGoal;
            agent.last_reflection_world_minutes = worldMinutes;
            const updatedGoals = await client.query(`SELECT id,goal_type AS "goalType",category,description,
                priority::text AS priority,progress::text AS progress,status,source,parent_goal_id AS "parentGoalId",metadata
              FROM world_agent_goals WHERE world_id=$1 AND agent_id=$2 AND status='active'
              ORDER BY CASE goal_type WHEN 'primary' THEN 0 WHEN 'secondary' THEN 1 ELSE 2 END,priority DESC,updated_world_minutes DESC`,
            [worldId, agent.agentId]);
            agent.goals = updatedGoals.rows;
          }
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
              { tick_count: tickCount, world_minutes: worldMinutes }, quotes, now, placeResult);
            if (learning) fruitflyOutcomes.push(learning);
          } else if (agent.status === 'idle' && new Date(agent.next_decision_at).getTime() <= now.getTime()) {
            const residentsAtLocation = Object.fromEntries(scenes.filter((scene) => ['cafe','garden','commons','workshop','studio','data_center'].includes(scene.sceneType))
              .map((scene) => [scene.name, membersResult.rows.filter((other) => other.location === scene.name
                && other.agent_id !== agent.agentId && other.status === 'idle').map((other) => {
                  const relationship = agent.relationships.find((item) => item.otherAgentId === other.agent_id) || null;
                  return { agentId: other.agent_id, name: other.name, status: other.status, location: other.location,
                    energy: other.energy, food: other.food, skills: safeJson(other.skills), relationship,
                    lastInteractionWorldMinutes: relationship?.lastInteractionWorldMinutes };
                })]));
          const utilityCandidates = buildActivityCandidates(agent, scenes, { tick: tickCount, worldMinutes, nowMs, quotes,
              previousQuotes: priorSnapshot, residentsAt: placeCounts, residentsAtLocation });
            let strategicDue = false;
            let nextStrategicAt = agent.next_strategic_decision_world_minutes === null
              || agent.next_strategic_decision_world_minutes === undefined
              ? worldMinutes + stableInt(`${agent.agentId}:strategic-phase`) % STRATEGIC_DECISION_INTERVAL_MINUTES
              : Number(agent.next_strategic_decision_world_minutes);
            if (nextStrategicAt <= worldMinutes) {
              strategicDue = true;
              nextStrategicAt = worldMinutes + STRATEGIC_DECISION_INTERVAL_MINUTES;
            }
            if (agent.next_strategic_decision_world_minutes === null
                || agent.next_strategic_decision_world_minutes === undefined || strategicDue) {
              await client.query(`UPDATE world_agent_states SET next_strategic_decision_world_minutes=$3,updated_at=$4
                WHERE world_id=$1 AND agent_id=$2`, [worldId, agent.agentId, nextStrategicAt, now]);
            }
            if (strategicDue) {
              const primaryGoal = agent.goals.find((goal) => goal.goalType === 'primary' && goal.status === 'active');
              const goalCategory = primaryGoal?.category || agent.primaryGoal || '';
              const progress = Number(primaryGoal?.progress ?? agent.goal_progress) || 0;
              const stagnation = updateGoalStagnation({
                goalCategory: agent.strategic_goal_category,
                progress: agent.strategic_goal_progress,
                lastProgressAt: agent.strategic_goal_progress_world_minutes,
                stagnationCycles: agent.strategic_goal_stagnation_cycles
              }, { goalCategory, progress, worldMinutes });
              agent.goalStagnation = { ...stagnation, sinceWorldMinutes: stagnation.state.lastProgressAt };
              await client.query(`UPDATE world_agent_states SET strategic_goal_category=$3,strategic_goal_progress=$4,
                  strategic_goal_progress_world_minutes=$5,strategic_goal_stagnation_cycles=$6,updated_at=$7
                WHERE world_id=$1 AND agent_id=$2`, [worldId, agent.agentId, goalCategory || null,
                stagnation.state.progress, stagnation.state.lastProgressAt, stagnation.state.stagnationCycles, now]);
              await recordEmergenceEvent(client, { worldId, agentId: agent.agentId, worldMinutes, tickCount,
                system: 'goal', stage: 'progress_check', reasonCode: stagnation.stagnant ? 'GOAL_STAGNANT' : 'GOAL_PROGRESSING',
                eventKey: `goal-check:${agent.agentId}:${tickCount}`, candidateId: String(primaryGoal?.id || goalCategory),
                details: { goalCategory, progress, stagnantMinutes: stagnation.stagnantMinutes,
                  stagnationCycles: stagnation.state.stagnationCycles } });
            }
            const initiativeContext = { ...initiativeData, worldMinutes,
              crowdedPlaces: initiativeData.crowdedPlaces || [], opportunities: initiativeData.opportunities || [],
              projects: initiativeData.projects || [], goalStagnation: agent.goalStagnation || { stagnant: false },
              activePlaceCount: initiativeData.activePlaceCount || scenes.filter((scene) => scene.status === 'active').length };
            const initiativeCandidates = strategicDue
              ? buildWorldInitiativeCandidates(agent, initiativeContext) : [];
            let candidates;
            let decisionLayer = 'tactical';
            let qualifiedStrategicCandidates = [];
            if (strategicDue) {
              const minimumEnergy = 15;
              const minimumFood = 8;
              const needsBlocked = agent.energy < minimumEnergy || agent.food < minimumFood;
              const permittedInitiatives = needsBlocked ? [] : initiativeCandidates.filter((candidate) => {
                if (candidate.action === 'project_contribute' && (agent.energy < 20 || agent.food < 10)) return false;
                return true;
              });
              qualifiedStrategicCandidates = qualifyUtilityCandidates(permittedInitiatives);
              for (const candidate of initiativeCandidates) {
                const eligible = qualifiedStrategicCandidates.some((item) => item.id === candidate.id);
                const reasonCode = needsBlocked ? (agent.energy < minimumEnergy ? 'ENERGY_LOW' : 'FOOD_LOW')
                  : eligible ? 'NONE' : candidate.action === 'project_contribute'
                    && (agent.energy < 20 || agent.food < 10) ? 'NEEDS_HARD_GATE' : 'UTILITY_BELOW_THRESHOLD';
                await recordEmergenceEvent(client, { worldId, agentId: agent.agentId, worldMinutes, tickCount,
                  system: initiativeSystem(candidate.action),
                  stage: eligible ? 'eligible' : 'blocked', reasonCode,
                  eventKey: `strategic-candidate:${agent.agentId}:${tickCount}:${candidate.id}:${eligible ? 'eligible' : 'blocked'}`,
                  candidateId: candidate.id, action: candidate.action, utilityScore: candidate.score,
                  details: { goalStagnant: Boolean(agent.goalStagnation?.stagnant),
                    worldNeedCount: initiativeContext.worldNeeds?.length || 0,
                    proposalReasons: candidate.projectProposal?.metadata?.proposalReasons || [] } });
                await recordEmergenceEvent(client, { worldId, agentId: agent.agentId, worldMinutes, tickCount,
                  system: initiativeSystem(candidate.action),
                  stage: 'considered', eventKey: `strategic-considered:${agent.agentId}:${tickCount}:${candidate.id}`,
                  candidateId: candidate.id, action: candidate.action, utilityScore: candidate.score,
                  details: { proposalReasons: candidate.projectProposal?.metadata?.proposalReasons || [] } });
              }
              const gapReasons = explainWorldInitiativeGaps(agent, initiativeContext, initiativeCandidates);
              for (const [index, gap] of gapReasons.entries()) {
                const gapKey = `strategic-gap:${agent.agentId}:${tickCount}:${gap.system}:${index}`;
                await recordEmergenceEvent(client, { worldId, agentId: agent.agentId, worldMinutes, tickCount,
                  system: gap.system, stage: 'considered', action: gap.action,
                  eventKey: `${gapKey}:considered`, details: { ...gap.details, actionCandidateMissing: true } });
                await recordEmergenceEvent(client, { worldId, agentId: agent.agentId, worldMinutes, tickCount,
                  system: gap.system, stage: 'blocked', reasonCode: needsBlocked
                    ? (agent.energy < minimumEnergy ? 'ENERGY_LOW' : 'FOOD_LOW') : gap.reasonCode,
                  eventKey: `${gapKey}:blocked`, action: gap.action,
                  details: gap.details });
              }
              if (qualifiedStrategicCandidates.length) {
                candidates = qualifiedStrategicCandidates;
                decisionLayer = 'strategic';
              } else candidates = qualifyUtilityCandidates(utilityCandidates);
            } else candidates = qualifyUtilityCandidates(utilityCandidates);
            let activity = null;
            let flyObservation = null;
            let flyCandidates = [];
            let flySelected = null;
            let decision = null;
            let usedFruitfly = false;
            if (fruitfly && candidates.length) {
              flyObservation = { self: { agentId: agent.agentId, energy: agent.energy, food: agent.food, social: agent.social,
                  riskTolerance: agent.riskTolerance },
                mind: { archetype: agent.archetype || 'observer', traits: { ...safeJson(agent.traits),
                    curiosity: agent.curiosity, craft: finite(agent.skills?.engineering) / 100 },
                  actionsTaken: agent.actions_taken, memories: agent.recentMemories,
                  goals: agent.goals, beliefs: agent.beliefs, relationships: agent.relationships,
                  personality: { ...agent.personalityModifiers, sociability: agent.sociability, curiosity: agent.curiosity,
                    discipline: agent.discipline, ambition: agent.ambition } } };
              flyCandidates = candidates.map(({ id, action, targetLocation, goal, description, plannedPaidMeal,
                side, asset, quoteUnits, score, socialPartnerId, socialPartnerName }) => ({ id, action, targetLocation, goal, description, plannedPaidMeal,
                side, asset, quoteUnits, score, socialPartnerId, socialPartnerName }));
              try {
              const choice = fruitfly.choose(agent.agentId, flyObservation, flyCandidates, candidates[0]);
              const selectedCandidate = candidates.find((candidate) => candidate.id === choice?.candidate?.id);
              if (selectedCandidate) {
                activity = selectedCandidate;
                usedFruitfly = true;
                decision = choice;
                } else if (choice?.candidate) {
                  onError(new Error('Fruitfly selected a candidate outside the feasible set.'), 'fruitfly_choice');
                }
              } catch (error) { onError(error, 'fruitfly_choice'); }
            }
            if (!activity) {
              await client.query(`UPDATE world_agent_states SET next_decision_at=$3,updated_at=$4
                WHERE world_id=$1 AND agent_id=$2`, [worldId, agent.agentId, new Date(now.getTime() + 30_000), now]);
              continue;
            }
            if (decisionLayer === 'strategic') {
              for (const candidate of qualifiedStrategicCandidates) {
                if (candidate.id === activity.id) continue;
                await recordEmergenceEvent(client, { worldId, agentId: agent.agentId, worldMinutes, tickCount,
                  system: initiativeSystem(candidate.action),
                  stage: 'not_selected', reasonCode: 'FRUITFLY_NOT_SELECTED',
                  eventKey: `fruitfly-not-selected:${agent.agentId}:${tickCount}:${candidate.id}`,
                  candidateId: candidate.id, action: candidate.action, utilityScore: candidate.score });
              }
              const chosenSystem = initiativeSystem(activity.action);
              await recordEmergenceEvent(client, { worldId, agentId: agent.agentId, worldMinutes, tickCount,
                system: chosenSystem, stage: 'fruitfly_selected',
                eventKey: `fruitfly-selected:${agent.agentId}:${tickCount}`,
                candidateId: activity.id, action: activity.action, utilityScore: activity.score,
                details: { decisionLayer, candidateCount: candidates.length } });
            }
            flySelected = { ...activity,
              behaviorProbability: Number(decision?.behaviorProbability) || 0,
              fruitflyProbability: Number(decision?.fruitflyProbability) || 0,
              learnerUsed: usedFruitfly
            };
            const familyDistribution = decision?.probabilities || {};
            const topFamilies = Object.entries(familyDistribution).sort((a, b) => b[1] - a[1]).slice(0, 3);
            await client.query(`INSERT INTO world_decision_traces(world_id,agent_id,tick_count,world_minutes,
                chosen_candidate_id,chosen_action,behavior_probability,distribution,utility_scores,goal_snapshot,rationale)
              VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10::jsonb,$11::jsonb)`,
            [worldId, agent.agentId, tickCount, worldMinutes, activity.id, activity.action,
              Math.max(0.00000001, Math.min(1, Number(decision?.behaviorProbability) || 1)),
              JSON.stringify({ behavior: familyDistribution, fruitfly: decision?.fruitflyProbabilities || {},
                utility: decision?.utilityProbabilities || {}, components: decision?.distributionComponents || {},
                mix: DECISION_MIX }),
              JSON.stringify(decision?.utilityScores || {}),
              JSON.stringify({ primary: agent.goals.find((goal) => goal.goalType === 'primary') || null,
                secondary: agent.goals.filter((goal) => goal.goalType === 'secondary'),
                short: agent.goals.filter((goal) => goal.goalType === 'short') }),
              JSON.stringify({ selectedGoal: activity.goal, selectedDescription: activity.description,
                topFamilies, learnedBeliefs: agent.beliefs.length, memoryCount: agent.recentMemories.length,
                relationshipCount: agent.relationships.length, source: 'utility_qualified_fruitfly_choice', decisionLayer,
                utilityCandidatePolicy: { thresholdRatio: 0.75, minimum: 3, maximum: 8 },
                strategicIntervalMinutes: STRATEGIC_DECISION_INTERVAL_MINUTES,
                eligibleCandidateCount: candidates.length })]);
            await client.query(`DELETE FROM world_decision_traces WHERE id IN (
              SELECT id FROM world_decision_traces WHERE world_id=$1 AND agent_id=$2
              ORDER BY tick_count DESC,id DESC OFFSET 50)`, [worldId, agent.agentId]);
            const duration = ACTION_SECONDS[activity.action] || 10;
            const tradeFields = activity.action === 'trade'
              ? [activity.side, activity.asset, activity.quoteUnits] : [null, null, null];
            const plannedContext = Object.fromEntries(['opportunityId','opportunityProposal','projectId','decision','projectProposal','goalReviewProposal',
              'organizationId','organizationProposal','inviteeAgentId','shareId','informationProposal','contributionType']
              .filter((key) => activity[key] !== undefined).map((key) => [key, activity[key]]));
            if (activity.targetLocation !== agent.location) {
              const travelSeconds = 6 + stableInt(`${agent.agentId}:${tickCount}:travel`) % 11;
              const movementEnd = new Date(now.getTime() + travelSeconds * 1_000);
              await client.query(`UPDATE world_agent_states SET status='walking',planned_action=$3,target_location=$4,
                  planned_side=$5,planned_asset=$6,planned_quote_units=$7,planned_paid_meal=$8,planned_partner_id=$9,
                  fruitfly_observation=$12::jsonb,fruitfly_candidates=$13::jsonb,fruitfly_selected=$14::jsonb,
                  planned_context=$15::jsonb,
                  movement_started_at=$10,movement_ends_at=$11,action_started_at=NULL,action_ends_at=NULL,
                  updated_at=$10 WHERE world_id=$1 AND agent_id=$2`,
              [worldId, agent.agentId, activity.action, activity.targetLocation, ...tradeFields, Boolean(activity.plannedPaidMeal),
                activity.socialPartnerId, now, movementEnd, JSON.stringify(flyObservation || {}), JSON.stringify(flyCandidates),
                JSON.stringify(flySelected || {}), JSON.stringify(plannedContext)]);
              await setMindGoal(client, worldId, agent.agentId, activity.goal, activity.action,
                `Started traveling from ${agent.location} to ${activity.targetLocation}.`);
              await recordWorldEvent(client, worldId, agent.agentId, tickCount, 'world.movement_started',
                { from: agent.location, to: activity.targetLocation, place: agent.location, action: activity.action,
                  startedAt: now.toISOString(), arrivesAt: movementEnd.toISOString(), worldMinutes });
              row.status = 'walking';
              row.planned_action = activity.action;
            } else {
              await client.query(`UPDATE world_agent_states SET status='performing',planned_action=$3,target_location=NULL,
                  planned_side=$4,planned_asset=$5,planned_quote_units=$6,planned_paid_meal=$7,planned_partner_id=$8,
                  fruitfly_observation=$11::jsonb,fruitfly_candidates=$12::jsonb,fruitfly_selected=$13::jsonb,
                  planned_context=$14::jsonb,
                  movement_started_at=NULL,movement_ends_at=NULL,action_started_at=$9,action_ends_at=$10,updated_at=$9
                WHERE world_id=$1 AND agent_id=$2`,
              [worldId, agent.agentId, activity.action, ...tradeFields, Boolean(activity.plannedPaidMeal), activity.socialPartnerId, now,
                new Date(now.getTime() + duration * 1_000), JSON.stringify(flyObservation || {}),
                JSON.stringify(flyCandidates), JSON.stringify(flySelected || {}), JSON.stringify(plannedContext)]);
              await setMindGoal(client, worldId, agent.agentId, activity.goal, activity.action, null);
              await recordWorldEvent(client, worldId, agent.agentId, tickCount, 'world.action_started',
                { place: agent.location, action: activity.action, worldMinutes, at: now.toISOString() });
              row.status = 'performing';
              row.planned_action = activity.action;
              if (activity.action === 'cooperate' && activity.socialPartnerId) {
                const partnerNextDecision = new Date(now.getTime() + duration * 1_000 + 5_000);
                await client.query(`UPDATE world_agent_states SET next_decision_at=GREATEST(next_decision_at,$3),updated_at=$4
                  WHERE world_id=$1 AND agent_id=$2 AND status='idle'`,
                [worldId, activity.socialPartnerId, partnerNextDecision, now]);
                const partnerRow = membersResult.rows.find((member) => member.agent_id === activity.socialPartnerId);
                if (partnerRow) partnerRow.next_decision_at = partnerNextDecision;
              }
            }
          }
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
      nextRetryAt = readNowMs() + Math.min(30_000, 1_000 * 2 ** Math.min(errorCount, 5));
      if (readNowMs() - lastErrorLoggedAt >= 60_000) {
        lastErrorLoggedAt = readNowMs();
        onError(error, 'tick');
      } else suppressedErrors += 1;
    } finally { tickInProgress = false; }
  }

  if (schedule) {
    timer = setInterval(() => {
      if (activeTick || stopped) return;
      activeTick = tick().finally(() => { activeTick = null; });
    }, Math.max(250, Math.trunc(finite(tickMs, WORLD_TICK_MS))));
    timer.unref?.();
  }
  await tick();
  onStatus({ running: true, worldId, tickMs });

  return {
    running: true,
    worldId,
    tickOnce: tick,
    async stop() {
      if (stopped) return;
      stopped = true;
      if (timer) clearInterval(timer);
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

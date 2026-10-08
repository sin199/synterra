import { createHash } from 'node:crypto';
import { chargeMeal, MEAL_COST_UNITS, canAffordUnits } from './economy.js';
import {
  DECISION_MIX, SOCIAL_COOLDOWN_WORLD_MINUTES, SOCIAL_SKILLS, addSkillGain, canCooperatePair, canSocializePair,
  chooseSocialPartner, clampPersonality, canonicalPair, clampSkill, deriveDominantRole, effectivePersonality,
  goalActionUtility, goalDescription, goalProgress, initialSkillValues, initialSocialProfile,
  qualifyUtilityCandidates, qualifyLayeredStrategicCandidates,
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
import { expireInstitutionalState, planInstitutionalAction, proposeWorldAgreement, proposeOrganizationGovernance,
  recordAgreementExecutionStage,
  resolveWorldCommitment, respondToWorldAgreement, voteOrganizationProposal } from './world-institutions.js';
import { applyToWorldBusinessJob, buildBusinessCandidates, closeWorldBusiness,
  completeWorldBusinessShift, decideWorldBusinessApplication, distributeWorldBusinessProfit,
  distributeWorldProjectRevenue, foundWorldBusiness, investInWorldBusiness, investInWorldProject,
  expirePendingWorldBusinessApplications, leaveWorldBusinessJob, loadWorldBusinessContext, purchaseWorldBusinessService,
  reopenWorldBusiness,
  observeWorldBusinessMarket,
  observeResidentEconomicMarket,
  practiceWorldBusinessCapability, reviewWorldBusinessPrice, settleWorldBusinessMaintenance,
  withdrawWorldBusinessApplication,
  settleWorldPlaceMaintenance, explainBusinessOpportunityGaps } from './world-businesses.js';
import { advanceWorldCivilization, buildCapabilityUseCandidates, initializeWorldCivilization,
  listWorldCapabilityUses, performWorldCapabilityUse, CIVILIZATION_REVIEW_INTERVAL_MINUTES } from './world-capabilities.js';
import { reportWorldEngineError, settleOptionalReasoning, worldEngineErrorRecord, WORLD_TICK_STALE_AFTER_MS,
  WORLD_TICK_WATCHDOG_INTERVAL_MS } from './world-engine-diagnostics.js';
import { advanceWorldV7, applyAgentDecisionPolicy, initializeWorldV7, reflectWorldV7Resident,
  WORLD_V7_REFLECTION_INTERVAL_MINUTES } from './world-v7.js';
import { activityDurationSeconds, activityNeedEffects, activityVariant, applyEnvironmentToCandidates,
  destinationFeasible, environmentEventIdeas, environmentSnapshot, environmentTransitions, homeActivityCandidates, hourlyNeedUpdate,
  travelSeconds, worldEnvironment } from './world-environment.js';
import { writeWorldHistory } from './world-domain.js';
import { advanceWorldCurrencyGenesis, ensureWorldCurrencyGenesisRequirement } from './world-token-issuance.js';
import { ensureResidentEconomicAccounts } from './economic-ledger.js';

export const WORLD_TICK_MS = 1_000;
const TYPE_SAFE_INTERVAL_MS = 30 * 60_000;
const CIVILIZATION_REASONING_TIMEOUT_MS = 10_500;
const CIVILIZATION_REASONING_BUDGET_MS = 15_000;
const WORLD_DB_STATEMENT_TIMEOUT_MS = 30_000;
const MAX_CATCH_UP_SECONDS = 30;
const INSTITUTIONAL_RETRY_WORLD_MINUTES = 60;
const ACTION_SECONDS = Object.freeze({ work: 16, cooperate: 16, learn: 11, rest: 9, eat: 8, socialize: 12,
  opportunity: 12, opportunity_reject: 8, opportunity_propose: 10, project_propose: 12, project_join: 10, project_reject: 8, project_contribute: 16,
  project_leave: 8, organization_found: 14, organization_join: 10, organization_reject: 8,
  organization_leave: 8, organization_invite: 10, organization_contribute: 12, information_share: 10,
  information_accept: 8, information_ignore: 6, information_doubt: 8, goal_review: 10,
  project_invest: 12, project_distribute: 10,
  business_found: 18, business_service: 12, business_apply: 10, business_leave: 8, business_hire: 10,
  business_withdraw: 6,
  business_work: 16, business_invest: 12, business_price: 10, business_distribute: 10, business_close: 10,
  business_skill_practice: 12, business_seek_cofounder: 14, business_market_observe: 12, business_reopen: 18,
  agreement_propose: 12, agreement_respond: 8, commitment_resolve: 8, organization_propose: 12, organization_vote: 8,
  capability_use: 15 });
const GOALS = Object.freeze(['wealth','learn','community','wellbeing','balanced','wealth','learn','community','wellbeing','balanced']);
const RISK_TOLERANCE = Object.freeze([0.78,0.28,0.52,0.22,0.68,0.35,0.82,0.47,0.70,0.40]);
const ALLOWED_GOALS = new Set(['wealth','learn','community','wellbeing','balanced']);
const FINITE_STAT_KEYS = ['energy','food','social','happiness','knowledge'];
const ECONOMIC_RECOVERY_ACTIONS = new Set(['business_market_observe','business_found','business_reopen',
  'business_seek_cofounder','business_skill_practice','business_apply','business_leave','business_work',
  'business_invest','agreement_propose','project_propose','organization_found','organization_join']);

function stableInt(input) {
  return createHash('sha256').update(String(input)).digest().readUInt32BE(0);
}

function initiativeSystem(action) {
  if (action === 'goal_review') return 'goal';
  if (action.startsWith('agreement') || action === 'commitment_resolve') return 'institution';
  if (action.startsWith('opportunity')) return 'opportunity';
  if (action.startsWith('project')) return 'project';
  if (action.startsWith('organization')) return 'organization';
  if (action.startsWith('information')) return 'information';
  if (action.startsWith('business')) return 'business';
  return 'place';
}

function recoveryBlocker(reasonCode) {
  const value = String(reasonCode || '').toUpperCase();
  if (value.includes('COOLDOWN')) return 'COOLDOWN';
  if (value.includes('CAPITAL')) return 'NO_CAPITAL';
  if (value.includes('CAPABILITY')) return 'NO_CAPABILITY';
  if (value.includes('PARTNER') || value.includes('TEAM_CAPABILITY')) return 'NO_PARTNER';
  if (value.includes('MARKET_NOT_OBSERVED') || value.includes('MARKET_KNOWLEDGE')) return 'NO_MARKET_KNOWLEDGE';
  if (value.includes('RISK')) return 'RISK_TOO_HIGH';
  return 'OTHER';
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

function sceneOptions(scenes, types) {
  return scenes.filter((scene) => scene.status === 'active' && types.includes(scene.sceneType));
}

function candidate({ id, action, place, goal, description = goal, score, plannedPaidMeal = false,
  socialPartnerId = null, socialPartnerName = null }) {
  return { id, action, targetLocation: place, goal, description, score, plannedPaidMeal, socialPartnerId, socialPartnerName };
}

export function buildActivityCandidates(agent, scenes, context = {}) {
  let options = [];
  const energy = clamp(agent.energy), food = clamp(agent.food), social = clamp(agent.social);
  const happiness = clamp(agent.happiness), knowledge = clamp(agent.knowledge);
  const goal = ALLOWED_GOALS.has(agent.goal) ? agent.goal : 'balanced';
  const activePrimary = agent.goals?.find((item) => item.goalType === 'primary' && item.status === 'active');
  const primaryGoal = activePrimary?.category || agent.primaryGoal || 'BALANCED_LIFE';
  const personality = effectivePersonality({ ...agent, personalityModifiers: agent.personalityModifiers || {} });
  const skills = Object.fromEntries(SOCIAL_SKILLS.map((skill) => [skill, clampSkill(agent.skills?.[skill])]));
  const units = String(agent.internalUnits ?? '0');
  const cash = finite(agent.usdc);
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

  if (context.environment) {
    // Time, weather, opening hours, capacity, distance and circadian state only
    // adjust feasibility and Utility scores; Fruitfly still makes the choice.
    options = applyEnvironmentToCandidates(options, agent, scenes, context);
    options.push(...homeActivityCandidates(agent, context));
  }
  for (const option of options) {
    option.score += goalActionUtility(option, agent.goals || []);
    const belief = (Array.isArray(agent.beliefs) ? agent.beliefs : []).find((item) =>
      item.subjectType === 'action' && item.subjectKey === option.action && item.beliefKey === 'outcome');
    if (belief) option.score += clamp(finite(belief.estimate) * finite(belief.confidence) * 8, -8, 8);
  }
  for (let index = 0; index < options.length; index++) options[index] = applyAgentDecisionPolicy(options[index], agent.decisionPolicy);

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
        belief_key AS "beliefKey",estimate::text AS estimate,confidence::text AS confidence,sample_count AS "sampleCount",
        updated_world_minutes AS "updatedWorldMinutes",evidence
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
  for (const belief of beliefs.rows) byAgent.get(belief.agentId)?.beliefs.push({ ...belief,
    updatedWorldMinutes: Number(belief.updatedWorldMinutes), evidence: safeJson(belief.evidence) });
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
    const networkAgentIds = new Set((resident.relationships || [])
      .filter((relation) => Number(relation.trust) >= 2 && Number(relation.familiarity) >= 10)
      .map((relation) => relation.otherAgentId).filter(Boolean));
    for (const organization of data.organizationMemberships.filter((item) => item.status === 'active'
      && item.memberStatus === 'active')) for (const memberId of organization.memberIds || []) {
      if (memberId !== resident.agent_id) networkAgentIds.add(memberId);
    }
    const activeProjectIds = new Set(data.projectMemberships.filter((membership) => membership.status === 'active')
      .map((membership) => membership.projectId));
    for (const membership of projectMembers.rows) if (membership.status === 'active'
        && activeProjectIds.has(membership.projectId) && membership.agentId !== resident.agent_id) {
      networkAgentIds.add(membership.agentId);
    }
    data.marketKnowledgeSources = [...networkAgentIds].flatMap((agentId) =>
      (beliefsByAgent.get(agentId) || []).filter((belief) => belief.subjectType === 'market'
        && belief.beliefKey === 'unmet_demand').map((belief) => ({ ...belief, agentId })));
    data.residentNames = residentById;
  }
  const economy = await loadWorldBusinessContext(client, worldId, worldMinutes, residents);
  const organizationById = new Map(organizations.map((organization) => [organization.id, organization]));
  for (const resident of residents) {
    const data = byAgent.get(resident.agent_id);
    if (!data) continue;
    data.organizationMemberships = data.organizationMemberships.map((membership) => {
      const organization = organizationById.get(membership.id);
      return { ...membership, cashBalance: Number(organization?.cash_balance || 0) };
    });
    data.businesses = economy.businesses;
    data.services = economy.services;
    data.jobs = economy.jobs;
    data.applications = economy.applications;
    data.employment = economy.employment;
    data.ownership = economy.ownership;
    data.demand = economy.demand;
    data.failedContractDemand = economy.failedContractDemand;
    data.contractDemand = economy.contractDemand;
    data.organizations = economy.organizations;
    data.economicProjects = economy.projects;
    data.places = economy.places;
    data.residentSkills = economy.residentSkills;
    data.worldMinutes = worldMinutes;
    data.scenes = scenes;
  }
  return { byAgent, opportunities: activeOpportunities, projects: activeProjects, worldNeeds, economy,
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
    SELECT memory.id FROM agent_memories memory WHERE memory.world_id=$1 AND memory.agent_id=$2 AND memory.long_term=true
      AND (memory.consolidation_key IS NULL OR memory.consolidation_key NOT LIKE 'world_epoch:%')
    ORDER BY memory.importance DESC,memory.world_minutes DESC,memory.id DESC
    OFFSET GREATEST(0,20-(SELECT count(*) FROM agent_memories epoch_memory
      WHERE epoch_memory.world_id=$1 AND epoch_memory.agent_id=$2 AND epoch_memory.long_term=true
        AND epoch_memory.consolidation_key LIKE 'world_epoch:%')))`, [worldId, agentId]);
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

export async function recordConsolidatedMemory(client, { worldId, agentId, summary, importance, worldMinutes,
  key, metadata, memoryType = 'summary', relatedAgentId = null, sourceEventId = null }) {
  if (!summary || !key) return null;
  const result = await client.query(`INSERT INTO agent_memories(world_id,agent_id,memory_type,summary,importance,
      world_minutes,related_agent_id,metadata,source_event_id,long_term,consolidation_key)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,true,$10)
    ON CONFLICT(world_id,agent_id,consolidation_key) WHERE consolidation_key IS NOT NULL
    DO UPDATE SET memory_type=EXCLUDED.memory_type,summary=EXCLUDED.summary,importance=EXCLUDED.importance,
      world_minutes=EXCLUDED.world_minutes,related_agent_id=EXCLUDED.related_agent_id,metadata=EXCLUDED.metadata,
      source_event_id=COALESCE(EXCLUDED.source_event_id,agent_memories.source_event_id),
      long_term=true,created_at=now()
    RETURNING id`, [worldId, agentId, memoryType, String(summary).slice(0, 240), clampPersonality(importance),
    worldMinutes, relatedAgentId, metadata, sourceEventId, key]);
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
  const wealthResult = await client.query(`SELECT COALESCE(sum(balance),0)::text AS value
      FROM world_economic_accounts WHERE world_id=$1 AND account_type='resident' AND account_key=$2 AND asset_symbol='USDC'`,
  [worldId, agentId]);
  const incomeResult = await client.query(`SELECT COALESCE(sum(posting.amount),0)::text AS value
    FROM world_economic_accounts account JOIN world_economic_postings posting ON posting.account_id=account.id
    JOIN world_economic_transactions tx ON tx.id=posting.transaction_id
    WHERE tx.world_id=$1 AND account.account_type='resident' AND account.account_key=$2
      AND account.asset_symbol='USDC' AND posting.amount>0`, [worldId, agentId]);
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
  const wealthResult = await client.query(`SELECT COALESCE(sum(balance),0)::text AS value
    FROM world_economic_accounts WHERE world_id=$1 AND account_type='resident' AND account_key=$2 AND asset_symbol='USDC'`,
  [worldId, agent.agentId]);
  const incomeResult = await client.query(`SELECT COALESCE(sum(posting.amount),0)::text AS value
    FROM world_economic_accounts account JOIN world_economic_postings posting ON posting.account_id=account.id
    JOIN world_economic_transactions tx ON tx.id=posting.transaction_id
    WHERE tx.world_id=$1 AND account.account_type='resident' AND account.account_key=$2
      AND account.asset_symbol='USDC' AND posting.amount>0`, [worldId, agent.agentId]);
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
    const action = memory.metadata?.action || ({ work: 'work', learning: 'learn',
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
    } else if (activity === 'project_invest') {
      detail = await investInWorldProject(client, { worldId, projectId: context.projectId,
        investorAgentId: agent.agentId, amount: context.amountUsdc, actionId: key, worldTime: nowWorld });
    } else if (activity === 'project_distribute') {
      detail = await distributeWorldProjectRevenue(client, { worldId, projectId: context.projectId,
        ownerAgentId: agent.agentId, actionId: key, worldTime: nowWorld });
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
        contributionType: context.contributionType || 'effort', amountUsdc: context.contributionAmountUsdc,
        effort: Math.max(0.1, Math.min(20, 1 + skillValue / 10 + finite(agent.energy) / 25)) });
    } else if (activity === 'business_found') {
      const proposal = safeJson(context.businessProposal);
      detail = await foundWorldBusiness(client, { worldId, agentId: agent.agentId,
        actionId: key, proposal, worldTime: nowWorld });
    } else if (activity === 'business_market_observe') {
      detail = await observeWorldBusinessMarket(client, { worldId, agentId: agent.agentId,
        serviceType: context.marketObservationServiceType, actionId: key, worldTime: nowWorld, location: agent.location });
    } else if (activity === 'business_reopen') {
      detail = await reopenWorldBusiness(client, { worldId, agentId: agent.agentId,
        actionId: key, proposal: safeJson(context.reopenProposal), worldTime: nowWorld });
    } else if (activity === 'business_skill_practice') {
      detail = await practiceWorldBusinessCapability(client, { worldId, agentId: agent.agentId,
        skill: context.preparationSkill, serviceType: context.preparationServiceType,
        actionId: key, worldTime: nowWorld });
    } else if (activity === 'business_seek_cofounder') {
      const proposal = safeJson(context.cofounderProposal);
      const organizationProposal = safeJson(proposal.organizationProposal);
      const organization = await foundWorldOrganization(client, { worldId, founderAgentId: agent.agentId,
        inviteAgentId: proposal.partnerId, projectId: organizationProposal.projectId,
        name: organizationProposal.name, purpose: organizationProposal.purpose,
        actionId: key, worldTime: nowWorld, metadata: { economicPreparation: true,
          serviceType: proposal.serviceType, capabilityFit: proposal.capabilityFit } });
      detail = { ...organization, partnerId: proposal.partnerId, partnerName: proposal.partnerName,
        serviceType: proposal.serviceType, preparation: 'SEEK_COFOUNDER' };
    } else if (activity === 'business_apply') {
      detail = await applyToWorldBusinessJob(client, { worldId, jobId: context.jobId,
        agentId: agent.agentId, actionId: key, worldTime: nowWorld });
    } else if (activity === 'business_withdraw') {
      detail = await withdrawWorldBusinessApplication(client, { worldId, applicationId: context.applicationId,
        agentId: agent.agentId, actionId: key, worldTime: nowWorld });
    } else if (activity === 'business_leave') {
      detail = await leaveWorldBusinessJob(client, { worldId, employmentId: context.employmentId,
        agentId: agent.agentId, actionId: key, worldTime: nowWorld });
    } else if (activity === 'business_hire' || activity === 'business_reject') {
      detail = await decideWorldBusinessApplication(client, { worldId, applicationId: context.applicationId,
        founderAgentId: agent.agentId, decision: activity === 'business_hire' ? 'accept' : 'reject',
        actionId: key, worldTime: nowWorld });
    } else if (activity === 'business_work') {
      detail = await completeWorldBusinessShift(client, { worldId, businessId: context.businessId,
        serviceId: context.serviceId, employmentId: context.employmentId || null,
        contractAgreementId: context.contractAgreementId || null, commitmentId: context.commitmentId || null,
        agentId: agent.agentId, actionId: key, worldTime: nowWorld });
    } else if (activity === 'business_service') {
      const service = (agent.services || []).find((item) => item.id === context.serviceId);
      const demandRow = (agent.demand || []).find((item) => item.serviceType === service?.service_type);
      const relation = agent.relationships.find((item) => item.otherAgentId === service?.founderAgentId);
      const pricingContext = context.pricingContext || {};
      detail = await purchaseWorldBusinessService(client, { worldId, serviceId: context.serviceId,
        customerAgentId: agent.agentId, actionId: key, worldTime: nowWorld,
        maxPriceUsdc: context.maxPriceUsdc, contractAgreementId: context.contractAgreementId || null,
        demand: pricingContext.demand ?? demandRow?.demandCount ?? 1,
        supply: pricingContext.supply ?? demandRow?.supplyCount ?? 0,
        relationship: pricingContext.relationship ?? (relation ? Number(relation.familiarity) * 0.3
          + Number(relation.trust) * 0.7 : 0),
        wealth: pricingContext.wealth ?? agent.usdc,
        priceSensitivity: pricingContext.priceSensitivity ?? agent.priceSensitivity });
    } else if (activity === 'business_invest') {
      detail = await investInWorldBusiness(client, { worldId, businessId: context.businessId,
        investorAgentId: agent.agentId, amount: context.amountUsdc, fundingSource: context.fundingSource,
        actionId: key, worldTime: nowWorld });
    } else if (activity === 'business_price') {
      const service = (agent.services || []).find((item) => item.id === context.serviceId);
      const demandRow = (agent.demand || []).find((item) => item.serviceType === service?.service_type);
      detail = await reviewWorldBusinessPrice(client, { worldId, businessId: context.businessId,
        serviceId: context.serviceId, agentId: agent.agentId, direction: context.direction,
        actionId: key, worldTime: nowWorld, demand: demandRow?.demandCount || 0,
        supply: demandRow?.supplyCount || 0 });
    } else if (activity === 'business_distribute') {
      detail = await distributeWorldBusinessProfit(client, { worldId, businessId: context.businessId,
        ownerAgentId: agent.agentId, actionId: key, worldTime: nowWorld });
    } else if (activity === 'business_close') {
      detail = await closeWorldBusiness(client, { worldId, businessId: context.businessId,
        founderAgentId: agent.agentId, actionId: key, worldTime: nowWorld });
    } else if (activity === 'agreement_propose') {
      detail = await proposeWorldAgreement(client, { worldId, proposerAgentId: agent.agentId,
        counterpartyAgentId: context.counterpartyAgentId, agreementType: context.agreementType,
        terms: context.agreementTerms, actionId: key, worldTime: nowWorld,
        expiresInWorldMinutes: context.expiresInWorldMinutes || 4_320,
        parentAgreementId: context.parentAgreementId || null });
    } else if (activity === 'agreement_respond') {
      detail = await respondToWorldAgreement(client, { worldId, agreementId: context.agreementId,
        agentId: agent.agentId, decision: context.decision, counterTerms: context.counterTerms,
        actionId: key, worldTime: nowWorld });
    } else if (activity === 'commitment_resolve') {
      detail = await resolveWorldCommitment(client, { worldId, commitmentId: context.commitmentId,
        agentId: agent.agentId, outcome: context.outcome, actionId: key, worldTime: nowWorld });
    } else if (activity === 'organization_propose') {
      detail = await proposeOrganizationGovernance(client, { worldId, organizationId: context.organizationId,
        proposerAgentId: agent.agentId, proposalType: context.proposalType, payload: context.proposalPayload,
        actionId: key, worldTime: nowWorld, expiresInWorldMinutes: context.expiresInWorldMinutes || 4_320 });
    } else if (activity === 'organization_vote') {
      detail = await voteOrganizationProposal(client, { worldId, proposalId: context.proposalId,
        agentId: agent.agentId, decision: context.decision, actionId: key, worldTime: nowWorld });
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
        : action.startsWith('agreement') || action === 'commitment_resolve' ? 'institution'
        : action.startsWith('information') ? 'information'
          : action.startsWith('business') ? 'business' : null;
  if (!system && action !== 'project_contribute') return;
  const stageForAction = {
    goal_review: details.replanned ? 'replanned' : 'blocked',
    opportunity_propose: details.created ? 'created' : 'proposed',
    opportunity: 'accepted', opportunity_reject: 'rejected',
    project_propose: 'proposed', project_join: details.status === 'rejected' ? 'rejected' : 'joined',
    project_reject: 'rejected', project_contribute: details.completed ? 'completed' : 'progressed',
    project_leave: 'abandoned', project_invest: 'invested', project_distribute: 'distributed',
    organization_found: details.status === 'active' ? 'formed' : 'proposed',
    organization_join: 'joined',
    organization_reject: 'rejected', information_share: 'shared',
    information_accept: 'accepted', information_ignore: 'ignored',
    business_found: 'founded', business_service: 'purchased', business_apply: 'applied',
    business_market_observe: 'market_observed', business_reopen: 'reopened',
    business_withdraw: 'withdrawn',
    business_leave: 'left',
    business_hire: 'hired', business_reject: 'rejected', business_work: 'produced',
    business_invest: 'invested', business_price: 'price_changed', business_distribute: 'distributed',
    business_close: 'closed', business_seek_cofounder: 'partner_sought',
    business_skill_practice: 'capability_practiced',
    agreement_propose: 'proposed', agreement_respond: details.status || 'responded',
    commitment_resolve: details.status || 'resolved', organization_propose: 'proposed',
    organization_vote: details.status || 'voted'
  };
  const stage = result.abandoned ? 'blocked' : stageForAction[action];
  if (!stage) return;
  const reasonCode = result.abandoned ? String(result.abandoned).toUpperCase().replace(/[^A-Z0-9_]/g, '_').slice(0, 64)
    : action === 'business_found' ? 'BUSINESS_STARTED'
      : action === 'business_seek_cofounder' ? 'COFOUNDER_INVITED'
        : action === 'business_skill_practice' ? 'CAPABILITY_PRACTICED'
          : action === 'business_market_observe' ? (Number(details.unmetCount) > 0 || Number(details.replacementUnits) > 0
            ? 'SHORTAGE_OBSERVED' : 'MARKET_OBSERVED_NO_SHORTAGE')
            : action === 'business_reopen' ? 'BUSINESS_REOPENED' : 'NONE';
  const entityId = details.id || details.businessId || details.orderId || details.project?.id || details.opportunity?.id || null;
  await recordEmergenceEvent(client, { worldId, agentId: agent.agentId, worldMinutes, tickCount, system, stage,
    reasonCode, eventKey: `initiative-outcome:${agent.agentId}:${tickCount}:${action}:${stage}`,
    candidateId: String(entityId || agent.planned_context?.projectId || agent.planned_context?.opportunityId || action),
    action, details: { ...details, abandoned: result.abandoned || null } });

  if (ECONOMIC_RECOVERY_ACTIONS.has(action) && !result.abandoned) {
    await recordEmergenceEvent(client, { worldId, agentId: agent.agentId, worldMinutes, tickCount,
      system: 'business', stage: 'recovery_action', reasonCode: action.toUpperCase(),
      eventKey: `recovery-action:${agent.agentId}:${tickCount}:${action}`,
      candidateId: String(entityId || agent.planned_context?.businessId || action), action,
      details: { serviceType: details.serviceType || agent.planned_context?.businessProposal?.serviceType
          || agent.planned_context?.preparationServiceType
          || agent.planned_context?.marketObservationServiceType || agent.planned_context?.reopenProposal?.serviceType || null,
        counterpartyAgentId: details.counterpartyAgentId || details.partnerId || null,
        outcomeStage: stage, recoveryAction: true } });
  }

  if (action === 'business_market_observe' && !result.abandoned
      && (Number(details.unmetCount) > 0 || Number(details.replacementUnits) > 0)) {
    await recordEmergenceEvent(client, { worldId, agentId: agent.agentId, worldMinutes, tickCount,
      system: 'business', stage: 'shortage_observed', reasonCode: Number(details.replacementUnits) > 0
        ? 'SUPPLIER_FAILED' : 'UNMET_DEMAND',
      eventKey: `shortage-observed:${agent.agentId}:${tickCount}:${details.serviceType}`,
      candidateId: String(details.serviceType), action, details: { serviceType: details.serviceType,
        unmetCount: details.unmetCount, replacementUnits: details.replacementUnits || 0,
        failedContractCount: details.failedContractCount || 0, worldMinutes: details.observedWorldMinutes } });
  }

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

async function recordEconomicBelief(client, { worldId, agentId, businessId, worldMinutes, evidence }) {
  if (!businessId) return;
  const result = await client.query(`SELECT business.founder_agent_id AS founder,
      business.status,account.id AS account_id,
      COALESCE(sum(posting.amount) FILTER (WHERE transaction.transaction_type='business_revenue'
        AND posting.amount>0),0)::numeric AS revenue,
      COALESCE(-sum(posting.amount) FILTER (WHERE transaction.transaction_type IN
        ('business_expense','business_wage','maintenance') AND posting.amount<0),0)::numeric AS expenses
    FROM world_businesses business LEFT JOIN world_economic_accounts account
      ON account.world_id=business.world_id AND account.account_key='business:'||business.id::text
        AND account.asset_symbol='USDC'
    LEFT JOIN world_economic_postings posting ON posting.account_id=account.id
    LEFT JOIN world_economic_transactions transaction ON transaction.id=posting.transaction_id
    WHERE business.world_id=$1 AND business.id=$2
    GROUP BY business.id,account.id`, [worldId, businessId]);
  if (!result.rowCount) return;
  const row = result.rows[0];
  const revenue = Number(row.revenue) || 0;
  const expenses = Number(row.expenses) || 0;
  const netOperating = revenue - expenses;
  const measuredRevenue = Number.isFinite(Number(evidence?.dailyRevenueUsdc))
    ? Number(evidence.dailyRevenueUsdc) : revenue;
  const measuredExpenses = Number.isFinite(Number(evidence?.dailyExpensesUsdc))
    ? Number(evidence.dailyExpensesUsdc) : expenses;
  const measuredNet = measuredRevenue - measuredExpenses;
  const measuredEstimate = Math.max(-1, Math.min(1, measuredNet / Math.max(100, measuredRevenue + measuredExpenses)));
  const stakeholders = await client.query(`SELECT $3::uuid AS agent_id
      UNION SELECT owner_id FROM world_economic_ownership WHERE world_id=$1 AND asset_type='business'
        AND asset_id=$2 AND owner_type='resident'
      UNION SELECT agent_id FROM world_business_employment WHERE world_id=$1 AND business_id=$2`,
  [worldId, businessId, row.founder]);
  const upsert = async (residentId, beliefKey, value, confidence, details) => client.query(`INSERT INTO world_agent_beliefs(
      world_id,agent_id,subject_type,subject_key,belief_key,estimate,confidence,sample_count,updated_world_minutes,evidence)
    VALUES($1,$2,'business',$3,$4,$5,$6,1,$7,$8::jsonb)
    ON CONFLICT(world_id,agent_id,subject_type,subject_key,belief_key) DO UPDATE SET
      estimate=(world_agent_beliefs.estimate*world_agent_beliefs.sample_count+EXCLUDED.estimate)
        /(world_agent_beliefs.sample_count+1),
      confidence=LEAST(0.98,(world_agent_beliefs.sample_count+1)*0.08+EXCLUDED.confidence*0.2),
      sample_count=world_agent_beliefs.sample_count+1,updated_world_minutes=EXCLUDED.updated_world_minutes,
      evidence=EXCLUDED.evidence`, [worldId, residentId, businessId, beliefKey, value, confidence,
    worldMinutes, JSON.stringify(details)]);
  const financialEvidence = { ...(evidence || {}), status: row.status, revenueUsdc: measuredRevenue.toFixed(8),
    operatingExpensesUsdc: measuredExpenses.toFixed(8), netOperatingResultUsdc: measuredNet.toFixed(8),
    allTimeRevenueUsdc: revenue.toFixed(8), allTimeOperatingExpensesUsdc: expenses.toFixed(8),
    allTimeNetOperatingResultUsdc: netOperating.toFixed(8),
    measure: evidence?.action === 'business_daily_settlement'
      ? 'posted_business_revenue_less_posted_daily_wages_expenses_and_maintenance'
      : 'posted_business_revenue_less_posted_wages_expenses_and_maintenance' };
  for (const stakeholder of stakeholders.rows) {
    await upsert(stakeholder.agent_id, 'business_outcome', measuredEstimate,
      Math.min(0.95, 0.25 + Math.log1p(revenue + expenses) / 20), financialEvidence);
  }
  if (evidence?.action === 'business_service') {
    const benefit = evidence.benefit && typeof evidence.benefit === 'object' ? evidence.benefit : {};
    const benefitValue = ['food','energy','social','happiness','knowledge']
      .reduce((sum, key) => sum + Math.max(0, Number(benefit[key]) || 0), 0);
    const price = Math.max(0, Number(evidence.amountUsdc) || 0);
    const wealth = Math.max(1, Number(evidence.wealth) || 1);
    const customerExperience = Math.max(-1, Math.min(1, benefitValue / 40 - price / wealth));
    await upsert(agentId, 'service_experience', customerExperience, 0.35,
      { ...financialEvidence, personalBenefit: benefit, paidUsdc: price.toFixed(8) });
  }
}

async function completeActivity(client, worldId, agent, runtime, now, scene, onAutonomousBusinessAction = null,
  environment = null) {
  const activity = agent.planned_action;
  const place = agent.location;
  const variant = agent.activity_variant || null;
  const profile = `${agent.agentId}:${runtime.tick_count}:${activity}`;
  let needs = { energy: 0, food: 0, social: 0, happiness: 0, knowledge: 0 };
  let result = { action: activity, place };
  let socialInteraction = null;
  let cooperativePartnerEventId = null;
  if (activity === 'work') {
    const dataCenter = agent.scene_type === 'data_center';
    needs = { energy: -8, food: -6, social: -2, happiness: 2, knowledge: dataCenter ? 3 : 1 };
    result.work = { output: dataCenter ? 'shared data-center operations' : 'shared workshop contribution',
      usdcEarned: '0.00000000', fundedBy: null };
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
        output: dataCenter ? 'shared data-center operations' : 'shared workshop contribution', relationship };
      await setMindGoal(client, worldId, partner.agentId, partner.currentGoal || partner.goal, 'cooperate',
        `Worked with ${agent.name} at ${place}; the shift improved shared capability and their relationship.`);
      await recordWorldEvent(client, worldId, agent.agentId, runtime.tick_count, 'world.cooperation_completed', {
        partnerId: partner.agentId, partnerName: partner.name, place, worldMinutes: runtime.world_minutes,
        output: result.cooperation.output, relationship
      });
    }
  } else if (activity === 'learn') {
    needs = { energy: -5, food: -2, social: 0, happiness: agent.scene_type === 'observatory' ? 3 : 1,
      knowledge: 6 + stableInt(`${profile}:study`) % 9 };
    result.learning = { knowledge: needs.knowledge };
  } else if (activity === 'rest') {
    // Sleep restores energy gradually through the hourly need model instead.
    needs = variant === 'sleep' ? { energy: 0, food: 0, social: 0, happiness: 0, knowledge: 0 }
      : { energy: 24, food: -1, social: 0, happiness: 5, knowledge: 0 };
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
  } else if (activity === 'capability_use') {
    try {
      const use = await performWorldCapabilityUse(client, { worldId, agentId: agent.agentId,
        partnerId: agent.planned_partner_id || agent.planned_context?.capabilityContext?.partnerAgentId || null,
        capabilityId: agent.planned_context?.capabilityId,
        experimentId: agent.planned_context?.capabilityExperimentId || null,
        selectionSource: agent.planned_context?.capabilitySelectionSource || 'utility_fallback',
        actionId: actionId(agent.agentId, runtime.tick_count, 'capability-use'),
        worldMinute: runtime.world_minutes, agentEnergy: agent.energy });
      result.capability = use;
      needs.energy = -Number(use.costs?.energy || 0);
      needs.food = -Number(use.costs?.food || 0);
    } catch (error) {
      if (Number(error?.statusCode) >= 500 || !Number(error?.statusCode)) throw error;
      result.abandoned = String(error.message || 'capability_use_unavailable').slice(0, 96);
      needs.energy = -1;
      needs.food = -1;
    }
  } else if (['goal_review','opportunity','opportunity_reject','opportunity_propose','project_propose','project_join','project_reject','project_contribute','project_leave',
    'project_invest','project_distribute',
    'organization_found','organization_join','organization_reject','organization_leave','organization_invite',
    'organization_contribute','information_share','information_accept','information_ignore','information_doubt',
    'business_found','business_service','business_apply','business_withdraw','business_leave','business_hire','business_reject','business_work',
    'business_invest','business_price','business_distribute','business_close','business_skill_practice','business_seek_cofounder',
    'business_market_observe','business_reopen',
    'agreement_propose','agreement_respond','commitment_resolve','organization_propose','organization_vote'].includes(activity)) {
    const initiative = await completeWorldInitiativeActivity(client, worldId, agent, runtime, activity);
    result.initiativeAction = activity;
    if (initiative.error) result.abandoned = initiative.error;
    else {
      result.initiative = initiative.detail;
      needs = { energy: activity === 'project_contribute' ? -6 : -2, food: -1,
        social: activity === 'information_share' || activity === 'organization_found' ? 1 : 0,
        happiness: initiative.detail?.completed ? 3 : 1, knowledge: 0 };
      if (activity === 'business_service' && initiative.detail?.benefit) {
        for (const key of ['energy','food','social','happiness','knowledge']) {
          needs[key] = (Number(needs[key]) || 0) + (Number(initiative.detail.benefit[key]) || 0);
        }
      }
      if (activity === 'opportunity' || activity === 'opportunity_reject') {
        result.opportunity = initiative.detail;
        if (activity === 'opportunity' && initiative.detail?.status === 'completed') needs.knowledge = 2;
      }
    }
  }

  const environmentalEffects = activityNeedEffects({ action: activity, variant,
    weather: environment?.weather || null, abandoned: Boolean(result.abandoned) });
  for (const key of FINITE_STAT_KEYS) needs[key] = (Number(needs[key]) || 0) + (environmentalEffects[key] || 0);
  const next = updatedNeeds(agent, needs);
  const nextHygiene = incrementStat(agent.hygiene ?? 80, environmentalEffects.hygiene);
  const nextFun = incrementStat(agent.fun ?? 70, environmentalEffects.fun);
  result.energy = next.energy;
  result.food = next.food;
  result.social = next.social;
  result.hygiene = nextHygiene;
  result.fun = nextFun;
  if (variant) result.variant = variant;
  if (environment?.weather) result.weather = environment.weather.condition;
  await client.query(`UPDATE world_members SET energy=$3,food=$4,social=$5 WHERE world_id=$1 AND agent_id=$2`,
    [worldId, agent.agentId, next.energy, next.food, next.social]);
  await client.query(`UPDATE world_agent_states SET hygiene=$3,fun=$4,activity_variant=NULL WHERE world_id=$1 AND agent_id=$2`,
    [worldId, agent.agentId, nextHygiene, nextFun]);
  await client.query(`UPDATE world_agent_states SET happiness=$3,knowledge=$4,status='idle',planned_action=NULL,
      target_location=NULL,planned_partner_id=NULL,planned_side=NULL,planned_asset=NULL,planned_quote_units=NULL,planned_paid_meal=false,
      planned_context='{}'::jsonb,
      fruitfly_observation='{}'::jsonb,fruitfly_candidates='[]'::jsonb,fruitfly_selected='{}'::jsonb,
      movement_started_at=NULL,movement_ends_at=NULL,action_started_at=NULL,action_ends_at=NULL,
      next_decision_at=$5,updated_at=$6 WHERE world_id=$1 AND agent_id=$2`,
  [worldId, agent.agentId, next.happiness, next.knowledge, new Date(now.getTime() + 5_000 + stableInt(`${profile}:think`) % 11_000), now]);
  const summary = activity === 'work' ? `Contributed a work shift at ${place}; shared work does not mint simulated USDC.`
    : activity === 'learn' ? `Studied at ${place} and gained knowledge.`
      : activity === 'rest' ? (variant === 'sleep' ? 'Slept at home.' : variant === 'home_rest' ? 'Washed up and recovered at home.'
        : `Rested at ${place}.`)
        : activity === 'eat' ? (variant === 'home_meal' ? 'Cooked and ate a meal at home.' : `Ate at ${place}.`)
      : activity === 'socialize' ? (socialInteraction ? `Met ${socialInteraction.partnerName} at ${place}.` : `Spent time in the social space at ${place}.`)
      : activity === 'cooperate' ? (result.cooperation ? `Worked with ${result.cooperation.partnerName} at ${place}.` : 'The planned cooperation could not take place.')
          : result.abandoned ? `The planned ${activity.replaceAll('_', ' ')} could not proceed.`
            : `${activity.replaceAll('_', ' ')} completed${result.initiative?.title ? `: ${result.initiative.title}` : ''}.`;
  await setMindGoal(client, worldId, agent.agentId, agent.current_goal || agent.goal, activity, summary);
  const completionEventId = await recordWorldEvent(client, worldId, agent.agentId, runtime.tick_count, 'world.action_completed', {
    ...result, needs: next, status: 'completed', worldMinutes: finite(runtime.world_minutes)
  });
  if (activity === 'business_service' && result.initiativeAction === 'business_service'
      && result.initiative?.status === 'fulfilled' && !result.initiative?.idempotent
      && typeof onAutonomousBusinessAction === 'function') {
    await onAutonomousBusinessAction(client, {
      worldId,
      worldActionId: actionId(agent.agentId, runtime.tick_count, 'arc-business-service-settlement'),
      worldEventId: completionEventId,
      fromAgentId: agent.agentId,
      toAgentId: result.initiative.businessFounderAgentId,
      orderId: result.initiative.orderId,
      businessId: result.initiative.businessId,
      simulatedAmountUsdc: result.initiative.priceUsdc,
      worldMinute: finite(runtime.world_minutes)
    });
  }
  if (result.initiativeAction) await recordInitiativeOutcome(client, { worldId, agent, activity,
    result, tickCount: runtime.tick_count, worldMinutes: runtime.world_minutes });
  if (activity === 'cooperate' && result.cooperation) {
    cooperativePartnerEventId = await recordWorldEvent(client, worldId, result.cooperation.partnerId,
      runtime.tick_count, 'world.action_completed', {
        action: 'cooperate', partnerId: agent.agentId, partnerName: agent.name, place, status: 'completed',
        output: result.cooperation.output, worldMinutes: finite(runtime.world_minutes)
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
      result: { cooperation: { partnerId: agent.agentId, partnerName: agent.name, output: result.cooperation.output } } });
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
    let business = null;
    let skillAction = null;
    let memoryType = 'initiative';
    let importance = 0.42;
    let summary = `${initiativeAction.replaceAll('_', ' ')} changed persistent world state.`;
    let relatedAgentId = null;
    if (initiativeAction === 'opportunity' || initiativeAction === 'opportunity_reject') {
      const type = result.opportunity?.type;
      skillAction = initiativeAction === 'opportunity_reject' ? null : type === 'RESEARCH' || type === 'LEARNING' ? 'learn'
        : type === 'SOCIAL' || type === 'COOPERATION' ? 'socialize'
          : type === 'TRADE' ? 'work' : 'work';
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
        : type === 'TRADE' ? 'work' : type === 'SOCIAL' ? 'socialize' : 'work';
      summary = `${result.initiative?.completed ? 'Helped complete' : 'Contributed to'} a shared project${result.initiative?.progress !== undefined
        ? ` (${Number(result.initiative.progress).toFixed(1)}% complete)` : ''}.`;
      if (result.initiative?.completed) {
        const participants = await client.query(`SELECT agent_id FROM world_project_members
          WHERE world_id=$1 AND project_id=$2 AND status='completed'`, [worldId, agent.planned_context?.projectId]);
        for (const participant of participants.rows) await refreshSocialProfile(client, worldId, participant.agent_id,
          runtime.world_minutes, completionEventId);
      }
    } else if (initiativeAction === 'project_invest' || initiativeAction === 'project_distribute') {
      const investment = initiativeAction === 'project_invest';
      memoryType = 'economic';
      importance = result.initiative?.idempotent ? 0.25 : 0.58;
      const project = (agent.economicProjects || []).find((item) => item.id === result.initiative?.projectId
        || item.id === agent.planned_context?.projectId);
      const projectName = result.initiative?.title || project?.title || 'a shared project';
      summary = investment
        ? `Invested ${result.initiative?.amountUsdc || 'simulated USDC'} in ${projectName} and received a recorded ownership share.`
        : `Distributed ${result.initiative?.distributedUsdc || 'simulated USDC'} from ${projectName} to its owners.`;
      await client.query(`INSERT INTO world_agent_beliefs(world_id,agent_id,subject_type,subject_key,belief_key,
          estimate,confidence,sample_count,updated_world_minutes,evidence)
        VALUES($1,$2,'project',$3,'economic_outcome',$4,0.25,1,$5,$6::jsonb)
        ON CONFLICT(world_id,agent_id,subject_type,subject_key,belief_key) DO UPDATE SET
          estimate=(world_agent_beliefs.estimate*world_agent_beliefs.sample_count+EXCLUDED.estimate)
            /(world_agent_beliefs.sample_count+1),
          confidence=LEAST(0.95,(world_agent_beliefs.sample_count+1)*0.08),
          sample_count=world_agent_beliefs.sample_count+1,updated_world_minutes=EXCLUDED.updated_world_minutes,
          evidence=EXCLUDED.evidence`, [worldId, agent.agentId, result.initiative?.projectId || agent.planned_context?.projectId,
        investment ? 0.1 : Number(result.initiative?.distributedUsdc) > 0 ? 0.55 : -0.1,
        runtime.world_minutes, JSON.stringify({ action: initiativeAction,
          amountUsdc: result.initiative?.amountUsdc || result.initiative?.distributedUsdc || null,
          share: result.initiative?.share || null, projectName })]);
    } else if (initiativeAction.startsWith('agreement_') || initiativeAction === 'commitment_resolve') {
      memoryType = 'contract';
      importance = ['agreement_propose','agreement_respond'].includes(initiativeAction) ? 0.66 : 0.56;
      relatedAgentId = result.initiative?.counterpartyAgentId || agent.planned_context?.counterpartyAgentId
        || result.initiative?.proposerAgentId || null;
      summary = initiativeAction === 'agreement_propose'
        ? `Proposed a ${agent.planned_context?.agreementType?.replaceAll('_',' ') || 'social'} agreement with another resident.`
        : initiativeAction === 'agreement_respond'
          ? `Responded to a ${agent.planned_context?.agreementType?.replaceAll('_',' ') || 'social'} agreement proposal: ${result.initiative?.status || 'reviewed'}.`
          : `Reviewed a future commitment and recorded the outcome ${result.initiative?.status || 'resolved'}.`;
    } else if (initiativeAction.startsWith('organization_')) {
      skillAction = 'socialize';
      memoryType = 'organization';
      importance = result.initiative?.created ? 0.7 : 0.4;
      summary = `${initiativeAction.replaceAll('_', ' ')} updated a resident organization.`;
    } else if (initiativeAction.startsWith('business_')) {
      business = (agent.businesses || []).find((item) => item.id === result.initiative?.businessId
        || item.id === result.initiative?.id || item.id === result.initiative?.businessId);
      const businessName = result.initiative?.name || result.initiative?.businessName || business?.name || 'a resident business';
      memoryType = 'business';
      importance = initiativeAction === 'business_found' || initiativeAction === 'business_close' ? 0.68 : 0.5;
      skillAction = initiativeAction === 'business_work' ? 'work'
        : initiativeAction === 'business_service' ? (result.initiative?.serviceType === 'food_service'
          || result.initiative?.serviceType === 'social_service' ? 'social'
          : result.initiative?.serviceType === 'engineering_service' ? 'work' : 'learn')
          : initiativeAction === 'business_seek_cofounder' ? 'socialize'
          : initiativeAction === 'business_found' ? 'work' : null;
      if (initiativeAction === 'business_found') summary = `Committed ${result.initiative?.capitalUsdc || 'simulated USDC'} to start ${businessName} around observed demand.`;
      else if (initiativeAction === 'business_market_observe') summary = `Checked ${result.initiative?.serviceType || 'a service'} demand at Exchange: ${result.initiative?.unmetCount || 0} unmet requests out of ${result.initiative?.demandCount || 0}.`;
      else if (initiativeAction === 'business_reopen') summary = `Reopened ${businessName} with fresh working capital after reviewing current ${result.initiative?.serviceType || 'service'} demand.`;
      else if (initiativeAction === 'business_skill_practice') {
        memoryType = 'learning';
        summary = `Practiced ${result.initiative?.skill || 'a skill'} after noticing demand for ${result.initiative?.serviceType || 'a service'}, gaining ${result.initiative?.skillGain || 0} capability.`;
      }
      else if (initiativeAction === 'business_seek_cofounder') summary = `Invited ${result.initiative?.partnerName || 'a trusted collaborator'} to explore a ${result.initiative?.serviceType || 'service'} partnership.`;
      else if (initiativeAction === 'business_service') summary = `Paid ${result.initiative?.priceUsdc || 'simulated USDC'} for ${result.initiative?.serviceName || 'a service'}; the service changed personal needs and funded its provider.`;
      else if (initiativeAction === 'business_work') summary = `Produced a ${result.initiative?.serviceType || 'service'} unit for ${businessName}${result.initiative?.wageUsdc ? ` and received a funded ${result.initiative.wageUsdc} shift wage` : ''}.`;
      else if (initiativeAction === 'business_invest') summary = `Invested ${result.initiative?.amountUsdc || 'simulated USDC'} in ${businessName} for an ownership share.`;
      else if (initiativeAction === 'business_close') summary = `Closed ${businessName} after its finances no longer supported continuing.`;
      else if (initiativeAction === 'business_apply') summary = `Applied for a funded role at ${businessName}.`;
      else if (initiativeAction === 'business_withdraw') summary = `Withdrew a pending application at ${businessName}.`;
      else if (initiativeAction === 'business_leave') summary = `Left the ${result.initiative?.role || 'role'} position at ${businessName}.`;
      else if (initiativeAction === 'business_hire') summary = `Accepted an application and created paid employment at ${businessName}.`;
      else if (initiativeAction === 'business_reject') summary = `Declined a job application at ${businessName}.`;
      else if (initiativeAction === 'business_price') summary = `Adjusted the service price at ${businessName} after reviewing demand and supply.`;
      else if (initiativeAction === 'business_distribute') summary = `Distributed ${result.initiative?.distributedUsdc || 'simulated USDC'} from realized profit at ${businessName}.`;
      const businessId = result.initiative?.businessId || agent.planned_context?.businessId
        || (['business_found','business_close'].includes(initiativeAction) ? result.initiative?.id : null);
      await recordEconomicBelief(client, { worldId, agentId: agent.agentId,
        businessId,
        worldMinutes: runtime.world_minutes, evidence: { action: initiativeAction,
          amountUsdc: result.initiative?.priceUsdc || result.initiative?.amountUsdc || null,
          benefit: result.initiative?.benefit || null, wealth: agent.usdc,
          serviceType: result.initiative?.serviceType || null, status: result.initiative?.status || null } });
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
      relatedAgentId: relatedAgentId || result.initiative?.inviteAgentId || result.initiative?.partnerId || null,
      metadata: { action: initiativeAction,
        serviceType: result.initiative?.serviceType || agent.planned_context?.preparationServiceType
          || agent.planned_context?.marketObservationServiceType || agent.planned_context?.reopenProposal?.serviceType
          || business?.metadata?.serviceType || null,
        initiative: result.initiative || {}, outcome: result.opportunity?.status || 'success' },
      sourceEventId: completionEventId });
    if (['business_work','business_service'].includes(initiativeAction) && result.initiative?.businessId) {
      const businessId = result.initiative.businessId;
      const work = initiativeAction === 'business_work';
      const summary = work
        ? `Worked for ${result.initiative.businessName || 'a business'}, produced ${result.initiative.serviceType || 'one service'} inventory, and received ${result.initiative.wageUsdc || 'no'} simulated USDC wage.`
        : `Purchased ${result.initiative.serviceName || 'a service'} from ${result.initiative.businessName || 'a business'} for ${result.initiative.priceUsdc || 'simulated USDC'}; the service changed resident needs.`;
      await recordConsolidatedMemory(client, { worldId, agentId: agent.agentId,
        memoryType: 'business', summary, importance: 0.74, worldMinutes: runtime.world_minutes,
        key: `business:${businessId}:resident-economic-experience`,
        relatedAgentId: result.initiative.businessFounderAgentId || null,
        metadata: { action: initiativeAction, businessId, serviceId: result.initiative.serviceId || null,
          sourceEventId: completionEventId,
          serviceType: result.initiative.serviceType || null, orderId: result.initiative.orderId || null,
          employmentId: result.initiative.employmentId || null, wageUsdc: result.initiative.wageUsdc || null,
          priceUsdc: result.initiative.priceUsdc || null, benefit: result.initiative.benefit || null,
          outcome: 1 } });
    }
    await refreshSocialProfile(client, worldId, agent.agentId, runtime.world_minutes, completionEventId);
  } else if (activity !== 'socialize' && !result.abandoned) {
  const meaningful = activity === 'work' && result.work || activity === 'learn' && result.learning;
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
    await client.query(`UPDATE world_agent_states SET status='idle',planned_action=NULL,target_location=NULL,
        planned_side=NULL,planned_asset=NULL,planned_quote_units=NULL,fruitfly_observation='{}'::jsonb,
        fruitfly_candidates='[]'::jsonb,fruitfly_selected='{}'::jsonb,movement_started_at=NULL,
        movement_ends_at=NULL,action_started_at=NULL,action_ends_at=NULL,next_decision_at=now(),updated_at=now()
      WHERE world_id=$1 AND planned_action IN ('trade','trade_crypto','trade_meme','trade_hold')`, [worldId]);
    await client.query(`INSERT INTO world_runtime_state(world_id,tick_count,world_minutes,last_tick_at,typesafe_next_at)
      VALUES($1,0,480,now(),now()) ON CONFLICT(world_id) DO NOTHING`, [worldId]);
    const runtime = (await client.query('SELECT world_minutes FROM world_runtime_state WHERE world_id=$1', [worldId])).rows[0];
    const worldMinutes = Math.max(0, Math.trunc(finite(runtime?.world_minutes, 480)));
    for (const [index, member] of members.rows.entries()) {
      const profile = initialWorldAgentProfile(index);
      await client.query(`INSERT INTO world_agent_states(world_id,agent_id,goal,risk_tolerance,happiness,knowledge,next_decision_at)
        VALUES($1,$2,$3,$4,$5,$6,now()+($7::text || ' seconds')::interval) ON CONFLICT(world_id,agent_id) DO NOTHING`,
      [worldId, member.agent_id, profile.goal, profile.riskTolerance, profile.happiness, profile.knowledge, String(3 + index * 3)]);
      await ensureResidentEconomicAccounts(client, { worldId, agentId: member.agent_id, worldTime: worldMinutes });
      const social = initialSocialProfile(member.agent_id, index);
      const skills = initialSkillValues(member.agent_id, index);
      await client.query(`INSERT INTO world_social_profiles(world_id,agent_id,sociability,curiosity,discipline,ambition,
          price_sensitivity,primary_goal,goal_started_world_minutes,dominant_role)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(world_id,agent_id) DO NOTHING`,
      [worldId, member.agent_id, social.sociability, social.curiosity, social.discipline, social.ambition,
        social.priceSensitivity, social.primaryGoal, worldMinutes, deriveDominantRole(skills, social.primaryGoal)]);
      await client.query(`UPDATE world_social_profiles SET price_sensitivity=$3,updated_at=now()
        WHERE world_id=$1 AND agent_id=$2 AND price_sensitivity=0.500`,
      [worldId, member.agent_id, social.priceSensitivity]);
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
  const [world, members, scenes] = await Promise.all([
    pool.query('SELECT name FROM worlds WHERE id=$1', [worldId]),
    pool.query(`SELECT a.id AS "agentId",a.name,am.archetype,am.traits,am.current_goal AS "currentGoal",am.actions_taken AS "actionsTaken",
        m.energy,m.food,m.social,m.location,s.goal,s.risk_tolerance AS "riskTolerance",s.happiness,s.knowledge,
        p.sociability::text AS sociability,p.curiosity::text AS curiosity,p.discipline::text AS discipline,p.ambition::text AS ambition,
        p.primary_goal AS "primaryGoal",p.goal_progress::text AS "goalProgress",p.dominant_role AS "dominantRole",
        p.personality_modifiers AS "personalityModifiers",p.risk_modifier::text AS "riskModifier",
        p.price_sensitivity::text AS "priceSensitivity",
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
        coalesce((SELECT balance::text FROM world_economic_accounts account WHERE account.world_id=m.world_id
          AND account.account_type='resident' AND account.account_key=m.agent_id::text AND account.asset_symbol='USDC'),'0') AS usdc
      FROM world_members m JOIN agents a ON a.id=m.agent_id JOIN world_agent_states s ON s.world_id=m.world_id AND s.agent_id=m.agent_id
      LEFT JOIN agent_minds am ON am.world_id=m.world_id AND am.agent_id=m.agent_id
      LEFT JOIN world_social_profiles p ON p.world_id=m.world_id AND p.agent_id=m.agent_id
      WHERE m.world_id=$1 ORDER BY m.joined_at,a.name`, [worldId]),
    pool.query(`SELECT id,name,scene_type AS "sceneType",status FROM world_scenes WHERE world_id=$1 ORDER BY created_at,id`, [worldId])
  ]);
  const runtime = (await pool.query('SELECT tick_count,world_minutes,last_tick_at,typesafe_next_at FROM world_runtime_state WHERE world_id=$1', [worldId])).rows[0];
  return { name: world.rows[0]?.name || 'Synterra', members: members.rows, scenes: scenes.rows, runtime };
}

async function runStrategicTypeSafe(pool, worldId, chooseWithTypeSafe, runtimeState) {
  const snapshot = await readEngineSnapshot(pool, worldId);
  if (!snapshot.members.length) return null;
  const index = stableInt(`${worldId}:${snapshot.runtime.tick_count}:typesafe`) % snapshot.members.length;
  const resident = snapshot.members[index];
  const goalCandidates = [
    { id: 'BUILD_WEALTH', legacyGoal: 'wealth', action: 'work', goal: 'Build simulated savings through useful work and business activity.', description: 'Build savings through existing work and business opportunities.' },
    { id: 'MASTER_RESEARCH', legacyGoal: 'learn', action: 'learn', goal: 'Grow research skill through study and observation.', description: 'Study in the library or observatory.' },
    { id: 'MASTER_ENGINEERING', legacyGoal: 'learn', action: 'work', goal: 'Grow engineering skill through data-center and workshop shifts.', description: 'Work at an existing workshop or data center.' },
    { id: 'BUILD_RELATIONSHIPS', legacyGoal: 'community', action: 'socialize', goal: 'Build meaningful familiarity with co-located residents.', description: 'Meet available residents at a cafe or garden.' },
    { id: 'BALANCED_LIFE', legacyGoal: 'balanced', action: 'rest', goal: 'Balance care, work, learning and social connection.', description: 'Choose a varied routine that supports needs and wellbeing.' }
  ];
  const skills = safeJson(resident.skills);
  const bestSkill = Object.entries(skills).sort((a, b) => Number(b[1]) - Number(a[1]))[0]?.[0] || 'research';
  goalCandidates.push({ id: `DEVELOP_${bestSkill.toUpperCase()}`, legacyGoal: bestSkill === 'social' ? 'community'
    : bestSkill === 'trading' ? 'wealth' : 'learn', action: bestSkill === 'social' ? 'socialize'
      : bestSkill === 'engineering' ? 'work' : 'learn',
  goal: `Develop ${bestSkill} through useful practice informed by personal experience.`,
  description: `Continue building ${bestSkill} while protecting immediate needs.` });
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
    economic: { internalUsdcBalance: resident.usdc }
  };
  const selection = await chooseWithTypeSafe(observation, goalCandidates, runtimeState, []);
  const selectedGoal = selection.decision?.id;
  const goalCandidate = goalCandidates.find((item) => item.id === selectedGoal);
  if (!goalCandidate) return { reason: selection.reason || 'fallback', resident: resident.name };
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Ticks lock runtime state before resident/profile/goal rows. Serialize this short
    // apply step with ticks so a reflection cannot hold a profile while this holds state.
    await client.query('SELECT tick_count FROM world_runtime_state WHERE world_id=$1 FOR UPDATE', [worldId]);
    await client.query(`UPDATE world_agent_states SET goal=$3,updated_at=now() WHERE world_id=$1 AND agent_id=$2`,
      [worldId, resident.agentId, goalCandidate.legacyGoal]);
    await client.query(`UPDATE world_agent_goals SET status='paused',updated_world_minutes=$3,updated_at=now()
      WHERE world_id=$1 AND agent_id=$2 AND goal_type='primary' AND status='active'`,
    [worldId, resident.agentId, snapshot.runtime.world_minutes]);
    await client.query(`INSERT INTO world_agent_goals(world_id,agent_id,goal_type,category,description,priority,
        created_world_minutes,updated_world_minutes,source,metadata)
      VALUES($1,$2,'primary',$3,$4,1,$5,$5,'strategy',$6::jsonb) ON CONFLICT DO NOTHING`,
    [worldId, resident.agentId, selectedGoal, goalCandidate.goal, snapshot.runtime.world_minutes,
      JSON.stringify({ selectedBy: 'typesafe', model: selection.model || null })]);
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

export async function startWorldEngine(pool, { worldId: requestedWorldId = null, onError = () => {}, onStatus = () => {}, chooseWithTypeSafe = null,
  chooseCivilizationOption = null, chooseWorldV7Reflection = null,
  currencyGenesisEnabled = false, authorCurrencyProposal = null,
  onAutonomousBusinessAction = null,
  runtimeState = null, fruitfly = null, tickMs = WORLD_TICK_MS, nowProvider = () => Date.now(), schedule = true,
  emergencySink = process.stderr } = {}) {
  const readNowMs = () => {
    const value = nowProvider();
    return value instanceof Date ? value.getTime() : finite(value, Date.now());
  };
  const worldResult = await pool.query(`SELECT w.id FROM worlds w WHERE w.open=true AND ($1::uuid IS NULL OR w.id=$1)
    ORDER BY w.created_at DESC LIMIT 1`, [requestedWorldId]);
  if (!worldResult.rowCount) return { running: false, reason: 'no_open_world', stop: async () => {} };
  const worldId = worldResult.rows[0].id;
  await ensureAgentRows(pool, worldId);

  const lockClient = await pool.connect();
  const lock = await lockClient.query(`SELECT pg_try_advisory_lock(hashtextextended('synterra-world-engine',0)) AS acquired,
    pg_backend_pid() AS owner_pid`);
  if (!lock.rows[0].acquired) {
    lockClient.release();
    onStatus({ running: false, reason: 'another_server_owns_world_loop' });
    return { running: false, worldId, worldLockOwned: false, schedulerRunning: false,
      reason: 'another_server_owns_world_loop', getLiveness() { return this; }, stop: async () => {} };
  }

  const diagnostics = {
    worldId,
    engineStartedAt: new Date(readNowMs()).toISOString(),
    worldMinute: null,
    tickCount: null,
    persistedWorldMinute: null,
    persistedTickCount: null,
    worldLockOwnerPid: Number(lock.rows[0].owner_pid),
    worldLockOwned: true,
    schedulerRunning: false,
    tickInProgress: false,
    activeTickStartedAt: null,
    lastSchedulerFireAt: null,
    lastTickPhase: 'STARTUP',
    lastSuccessfulPhase: null,
    lastTickStartedAt: null,
    lastTickCompletedAt: null,
    lastTickError: null,
    lastEngineError: null,
    watchdogLastRecoveryAt: null
  };
  let resumeBaselineMs = readNowMs();

  const reportError = (error, stage, { tickFailure = false, phase = diagnostics.lastTickPhase } = {}) => {
    const record = reportWorldEngineError({ error, stage, worldId,
      worldMinute: diagnostics.worldMinute ?? diagnostics.persistedWorldMinute,
      tickCount: diagnostics.tickCount ?? diagnostics.persistedTickCount,
      phase, onError, emergencySink, timestamp: new Date(readNowMs()) });
    diagnostics.lastEngineError = record;
    if (tickFailure) diagnostics.lastTickError = record;
    return record;
  };
  const setPhase = (phase) => { diagnostics.lastTickPhase = String(phase).slice(0, 80); };
  const phaseSucceeded = (phase = diagnostics.lastTickPhase) => {
    diagnostics.lastSuccessfulPhase = String(phase).slice(0, 80);
  };

  try {
    const initialize = await pool.connect();
    try {
      await initialize.query('BEGIN');
      const clock = await initialize.query(`SELECT world_minutes FROM world_runtime_state WHERE world_id=$1 FOR UPDATE`, [worldId]);
      if (!clock.rowCount) throw new Error('WORLD_RUNTIME_STATE_MISSING');
      await initializeWorldCivilization(initialize, { worldId, worldMinute: Number(clock.rows[0].world_minutes) });
      await initializeWorldV7(initialize, { worldId, worldMinute: Number(clock.rows[0].world_minutes) });
      if (currencyGenesisEnabled) await ensureWorldCurrencyGenesisRequirement(initialize,
        { worldId, worldMinute: Number(clock.rows[0].world_minutes) });
        const unscheduled = await initialize.query(`SELECT agent_id FROM world_agent_states
        WHERE world_id=$1 AND next_civilization_review_world_minutes IS NULL ORDER BY agent_id`, [worldId]);
      for (const resident of unscheduled.rows) {
        const phase = 1 + stableInt(`${worldId}:${resident.agent_id}:civilization-phase`) % CIVILIZATION_REVIEW_INTERVAL_MINUTES;
        await initialize.query(`UPDATE world_agent_states SET next_civilization_review_world_minutes=$3
          WHERE world_id=$1 AND agent_id=$2 AND next_civilization_review_world_minutes IS NULL`,
        [worldId, resident.agent_id, Number(clock.rows[0].world_minutes) + phase]);
      }
      diagnostics.worldMinute = Number(clock.rows[0].world_minutes);
      diagnostics.persistedWorldMinute = diagnostics.worldMinute;
      const currentClock = await initialize.query(`SELECT tick_count FROM world_runtime_state WHERE world_id=$1`, [worldId]);
      diagnostics.tickCount = Number(currentClock.rows[0]?.tick_count) || 0;
      diagnostics.persistedTickCount = diagnostics.tickCount;
      await initialize.query('COMMIT');
    } catch (error) {
      await initialize.query('ROLLBACK');
      throw error;
    } finally { initialize.release(); }
  } catch (error) {
    try { await lockClient.query(`SELECT pg_advisory_unlock(hashtextextended('synterra-world-engine',0))`); }
    finally { lockClient.release(); }
    throw error;
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
  let watchdogTimer = null;
  let watchdogInProgress = false;
  let staleEpisodeReported = false;
  let civilizationReasoningDeadline = 0;
  let civilizationChoiceInFlight = null;

  const chooseCivilizationOptionBounded = async (request) => {
    if (!chooseCivilizationOption || Date.now() >= civilizationReasoningDeadline || civilizationChoiceInFlight) return null;
    const timeoutMs = Math.max(1, Math.min(CIVILIZATION_REASONING_TIMEOUT_MS,
      civilizationReasoningDeadline - Date.now()));
    const operation = Promise.resolve().then(() => chooseCivilizationOption(request, runtimeState));
    civilizationChoiceInFlight = operation;
    operation.finally(() => {
      if (civilizationChoiceInFlight === operation) civilizationChoiceInFlight = null;
    }).catch(() => {});
    try {
      const result = await settleOptionalReasoning(operation, { timeoutMs, fallback: null });
      if (result.error) reportError(result.error, 'typesafe_civilization_selection',
        { tickFailure: false, phase: diagnostics.lastTickPhase });
      if (result.timedOut) reportError(new Error(`Optional TypeSafe civilization reasoning exceeded ${timeoutMs}ms.`),
        'typesafe_civilization_timeout', { tickFailure: false, phase: diagnostics.lastTickPhase });
      return result.value;
    } catch (error) { reportError(error, 'typesafe_civilization_selection', { tickFailure: false }); return null; }
  };

  const chooseWorldV7ReflectionBounded = async (request) => {
    if (!chooseWorldV7Reflection || Date.now() >= civilizationReasoningDeadline || civilizationChoiceInFlight) return null;
    const timeoutMs = Math.max(1, Math.min(CIVILIZATION_REASONING_TIMEOUT_MS,
      civilizationReasoningDeadline - Date.now()));
    const operation = Promise.resolve().then(() => chooseWorldV7Reflection(request, runtimeState));
    civilizationChoiceInFlight = operation;
    operation.finally(() => {
      if (civilizationChoiceInFlight === operation) civilizationChoiceInFlight = null;
    }).catch(() => {});
    try {
      const result = await settleOptionalReasoning(operation, { timeoutMs, fallback: null });
      if (result.error) reportError(result.error, 'typesafe_v7_reflection',
        { tickFailure: false, phase: diagnostics.lastTickPhase });
      if (result.timedOut) reportError(new Error(`Optional TypeSafe V7 reflection exceeded ${timeoutMs}ms.`),
        'typesafe_v7_reflection_timeout', { tickFailure: false, phase: diagnostics.lastTickPhase });
      return result.value;
    } catch (error) {
      reportError(error, 'typesafe_v7_reflection', { tickFailure: false });
      return null;
    }
  };

  async function verifyWorldLock() {
    const result = await lockClient.query({
      text: `WITH lock_key AS (SELECT hashtextextended('synterra-world-engine',0) AS value),
          database_oid AS (SELECT oid FROM pg_database WHERE datname=current_database())
        SELECT pg_backend_pid() AS owner_pid,EXISTS (
          SELECT 1 FROM pg_locks held,lock_key,database_oid
          WHERE held.locktype='advisory' AND held.pid=pg_backend_pid() AND held.granted
            AND held.database=database_oid.oid AND held.objsubid=1
            AND held.classid::bigint=((lock_key.value >> 32) & 4294967295)
            AND held.objid::bigint=(lock_key.value & 4294967295)) AS owned`,
      query_timeout: 5_000
    });
    diagnostics.worldLockOwnerPid = Number(result.rows[0]?.owner_pid) || null;
    diagnostics.worldLockOwned = Boolean(result.rows[0]?.owned);
    return diagnostics.worldLockOwned;
  }

  async function tick() {
    const nowMs = readNowMs();
    if (stopped || !diagnostics.worldLockOwned || tickInProgress || nowMs < nextRetryAt) return;
    tickInProgress = true;
    diagnostics.tickInProgress = true;
    diagnostics.lastTickStartedAt = new Date(nowMs).toISOString();
    diagnostics.activeTickStartedAt = diagnostics.lastTickStartedAt;
    civilizationReasoningDeadline = Date.now() + CIVILIZATION_REASONING_BUDGET_MS;
    setPhase('TICK_START');
    phaseSucceeded('TICK_START');
    let shouldAskTypeSafe = false;
    let typeSafeTaskStarted = false;
    const fruitflyOutcomes = [];
    try {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`SET LOCAL statement_timeout = '${WORLD_DB_STATEMENT_TIMEOUT_MS}ms'`);
        const clockResult = await client.query(`SELECT tick_count,world_minutes,last_tick_at,typesafe_next_at,environment
          FROM world_runtime_state WHERE world_id=$1 FOR UPDATE`, [worldId]);
        if (!clockResult.rowCount) throw new Error('WORLD_RUNTIME_STATE_MISSING');
        const clock = clockResult.rows[0];
        const now = new Date(nowMs);
        const previousAt = resumeBaselineMs ?? new Date(clock.last_tick_at).getTime();
        const elapsed = Math.max(1, Math.min(MAX_CATCH_UP_SECONDS,
          Math.floor((now.getTime() - (Number.isFinite(previousAt) ? previousAt : now.getTime())) / 1_000)));
        const tickCount = Number(clock.tick_count) + elapsed;
      const worldMinutes = Number(clock.world_minutes) + elapsed;
      const oldHour = Math.floor(Number(clock.world_minutes) / 60);
      const newHour = Math.floor(worldMinutes / 60);
      const oldWorldDay = Math.floor(Number(clock.world_minutes) / 1_440);
      const newWorldDay = Math.floor(worldMinutes / 1_440);
      const decayHours = Math.min(24, Math.max(0, newHour - oldHour));
      setPhase('CLOCK_ADVANCE');
      await client.query(`UPDATE world_runtime_state SET tick_count=$2,world_minutes=$3,last_tick_at=$4,updated_at=$4
          WHERE world_id=$1`, [worldId, tickCount, worldMinutes, now]);
      diagnostics.worldMinute = worldMinutes;
      diagnostics.tickCount = tickCount;
      const environment = worldEnvironment(worldId, worldMinutes);
      const previousEnvironment = safeJson(clock.environment);
      const environmentTransitionsDue = newHour > oldHour ? environmentTransitions(previousEnvironment, environment) : [];
      if (newHour > oldHour || !previousEnvironment.condition) {
        await client.query(`UPDATE world_runtime_state SET environment=$2::jsonb WHERE world_id=$1`,
          [worldId, JSON.stringify(environmentSnapshot(environment))]);
        for (const transition of environmentTransitionsDue) {
          await writeWorldHistory(client, { worldId, eventKey: transition.eventKey, eventType: transition.eventType,
            entityType: 'environment', worldTime: worldMinutes, title: transition.title, detail: transition.detail,
            metadata: { season: environment.calendar.season, weather: environment.weather.condition,
              temperatureC: environment.weather.temperatureC, previous: previousEnvironment } });
        }
      }
      phaseSucceeded('CLOCK_ADVANCE');
      setPhase('DAILY_ECONOMY');
      if (newWorldDay > oldWorldDay) {
        const businessSettlement = await settleWorldBusinessMaintenance(client, { worldId, worldTime: newWorldDay * 1_440 });
        for (const outcome of businessSettlement.outcomes || []) {
          await recordEconomicBelief(client, { worldId, agentId: outcome.founderAgentId, businessId: outcome.id,
            worldMinutes: newWorldDay * 1_440, evidence: { action: 'business_daily_settlement',
              dailyRevenueUsdc: outcome.dailyRevenueUsdc, dailyExpensesUsdc: outcome.dailyExpensesUsdc,
              dailyOperatingResultUsdc: outcome.dailyNetOperatingResultUsdc,
              serviceType: outcome.serviceType, consecutiveLossDays: outcome.consecutiveLossDays,
              missedMaintenanceDays: outcome.missedMaintenanceDays,
              bankruptcyReason: outcome.bankruptcyReason } });
          const result = Number(outcome.dailyNetOperatingResultUsdc) || 0;
          const sign = result < -1e-8 ? 'lost' : result > 1e-8 ? 'earned' : 'broke even';
          await recordConsolidatedMemory(client, { worldId, agentId: outcome.founderAgentId,
            summary: `${outcome.name} ${sign} ${Math.abs(result).toFixed(2)} simulated USDC on world day ${businessSettlement.day}; status ${outcome.status}.`,
            memoryType: 'business', importance: outcome.status === 'bankrupt' ? 0.9 : result < 0 ? 0.58 : 0.48,
            worldMinutes: newWorldDay * 1_440, key: `business:${outcome.id}:daily-outcome`,
            metadata: { businessId: outcome.id, serviceType: outcome.serviceType,
              worldDay: businessSettlement.day, status: outcome.status,
              dailyRevenueUsdc: outcome.dailyRevenueUsdc, dailyExpensesUsdc: outcome.dailyExpensesUsdc,
              dailyNetOperatingResultUsdc: outcome.dailyNetOperatingResultUsdc,
              consecutiveLossDays: outcome.consecutiveLossDays, missedMaintenanceDays: outcome.missedMaintenanceDays,
              bankruptcyReason: outcome.bankruptcyReason } });
        }
        await settleWorldPlaceMaintenance(client, { worldId, worldTime: newWorldDay * 1_440 });
      }
      phaseSucceeded('DAILY_ECONOMY');
        const typeSafeDueAt = new Date(clock.typesafe_next_at).getTime();
        shouldAskTypeSafe = Boolean(chooseWithTypeSafe && !typeSafeInProgress && nowMs >= typeSafeDueAt && nowMs >= nextTypeSafeAt);
        if (shouldAskTypeSafe) {
          typeSafeInProgress = true;
          nextTypeSafeAt = nowMs + TYPE_SAFE_INTERVAL_MS;
          await client.query(`UPDATE world_runtime_state SET typesafe_next_at=$2 WHERE world_id=$1`,
            [worldId, new Date(nextTypeSafeAt)]);
        }
        setPhase('RESIDENT_UPDATE');
        if (decayHours > 0) {
          // Residents without an engine state row keep the original flat decay.
          await client.query(`UPDATE world_members m SET energy=greatest(0,energy-$2),food=greatest(0,food-$3),social=greatest(0,social-$4)
            WHERE m.world_id=$1 AND NOT EXISTS (SELECT 1 FROM world_agent_states s WHERE s.world_id=m.world_id AND s.agent_id=m.agent_id)`,
          [worldId, decayHours, decayHours * 2, decayHours]);
          const needRows = await client.query(`SELECT m.agent_id AS "agentId",m.energy,m.food,m.social,s.happiness,s.hygiene,s.fun,
              s.status,s.planned_action AS "plannedAction",s.activity_variant AS "activityVariant"
            FROM world_members m JOIN world_agent_states s ON s.world_id=m.world_id AND s.agent_id=m.agent_id
            WHERE m.world_id=$1 ORDER BY m.agent_id FOR UPDATE OF m,s`, [worldId]);
          const updates = needRows.rows.map((resident) => ({ agentId: resident.agentId,
            ...hourlyNeedUpdate(resident, { hours: decayHours, calendar: environment.calendar, weather: environment.weather }) }));
          if (updates.length) {
            const column = (key) => updates.map((item) => item[key]);
            await client.query(`UPDATE world_members m SET energy=u.energy,food=u.food,social=u.social
              FROM unnest($2::uuid[],$3::int[],$4::int[],$5::int[]) AS u(agent_id,energy,food,social)
              WHERE m.world_id=$1 AND m.agent_id=u.agent_id`,
            [worldId, column('agentId'), column('energy'), column('food'), column('social')]);
            await client.query(`UPDATE world_agent_states s SET happiness=u.happiness,hygiene=u.hygiene,fun=u.fun,updated_at=$6
              FROM unnest($2::uuid[],$3::int[],$4::int[],$5::int[]) AS u(agent_id,happiness,hygiene,fun)
              WHERE s.world_id=$1 AND s.agent_id=u.agent_id`,
            [worldId, column('agentId'), column('happiness'), column('hygiene'), column('fun'), now]);
          }
        }
        const membersResult = await client.query(`SELECT m.world_id,m.agent_id,a.name,m.energy,m.food,m.social,m.location,
            am.archetype,am.traits,am.memories,am.current_goal,am.actions_taken,
            s.goal,s.risk_tolerance AS risk_tolerance,s.happiness,s.knowledge,s.hygiene,s.fun,s.activity_variant,
            s.status,s.planned_action,s.target_location,
            s.planned_partner_id AS planned_partner_id,s.planned_paid_meal,
            s.planned_context,s.next_strategic_decision_world_minutes AS next_strategic_decision_world_minutes,
            s.next_institutional_review_world_minutes AS next_institutional_review_world_minutes,
            s.next_civilization_review_world_minutes AS next_civilization_review_world_minutes,
            s.strategic_goal_category AS strategic_goal_category,
            s.strategic_goal_progress::text AS strategic_goal_progress,
            s.strategic_goal_progress_world_minutes AS strategic_goal_progress_world_minutes,
            s.strategic_goal_stagnation_cycles AS strategic_goal_stagnation_cycles,
            s.fruitfly_observation,s.fruitfly_candidates,s.fruitfly_selected,
            s.movement_started_at,s.movement_ends_at,s.action_started_at,s.action_ends_at,s.next_decision_at,
            p.sociability::text AS sociability,p.curiosity::text AS curiosity,p.discipline::text AS discipline,
            p.ambition::text AS ambition,p.primary_goal AS primary_goal,p.goal_progress::text AS goal_progress,
            p.goal_milestones AS goal_milestones,p.dominant_role AS dominant_role,
            p.personality_modifiers,p.risk_modifier::text AS risk_modifier,
            p.price_sensitivity::text AS price_sensitivity,
            p.last_reflection_world_minutes AS last_reflection_world_minutes,
            v7.last_reflected_world_minute AS v7_last_reflected_world_minute,
            COALESCE(v7policy.policy,'{"attentionWeights":{},"planningHorizonMinutes":1440,"explorationPreference":0.5,"memoryEmphasis":0.5,"socialInfluencePreference":0.5,"riskToleranceBias":0}'::jsonb) AS decision_policy,
            COALESCE(v7policy.version,0) AS decision_policy_version,
            COALESCE(v7policy.source,'substrate') AS decision_policy_source,
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
              FROM (SELECT memory.id,memory.memory_type,memory.summary,memory.importance,memory.world_minutes,
                  memory.location,memory.related_agent_id,memory.metadata
                FROM agent_memories memory WHERE memory.world_id=m.world_id AND memory.agent_id=m.agent_id
                  AND (memory.consolidation_key LIKE 'world_epoch:%' OR memory.id IN (
                    SELECT recent.id FROM agent_memories recent WHERE recent.world_id=m.world_id AND recent.agent_id=m.agent_id
                    ORDER BY recent.world_minutes DESC,recent.id DESC LIMIT 12))) recent),'[]'::jsonb) AS recent_memories,
            COALESCE((SELECT jsonb_agg(jsonb_build_object('otherAgentId',recent.other_id,'name',recent.other_name,
                'familiarity',recent.familiarity,'trust',recent.trust,'affinity',recent.affinity,
                'interactionCount',recent.interaction_count,'lastInteractionWorldMinutes',recent.last_interaction_world_minutes)
                ORDER BY recent.familiarity DESC,recent.interaction_count DESC)
              FROM (SELECT CASE WHEN r.agent_a_id=m.agent_id THEN r.agent_b_id ELSE r.agent_a_id END AS other_id,
                  other.name AS other_name,r.familiarity,r.trust,r.affinity,r.interaction_count,r.last_interaction_world_minutes
                FROM world_relationships r JOIN agents other ON other.id=CASE WHEN r.agent_a_id=m.agent_id THEN r.agent_b_id ELSE r.agent_a_id END
                WHERE r.world_id=m.world_id AND (r.agent_a_id=m.agent_id OR r.agent_b_id=m.agent_id)
                ORDER BY r.familiarity DESC,r.interaction_count DESC LIMIT 12) recent),'[]'::jsonb) AS relationships,
            coalesce((SELECT balance::text FROM world_economic_accounts account WHERE account.world_id=m.world_id
              AND account.account_type='resident' AND account.account_key=m.agent_id::text AND account.asset_symbol='USDC'),'0') AS usdc,
            coalesce((SELECT sum(amount)::text FROM token_ledger l WHERE l.world_id=m.world_id AND l.agent_id=m.agent_id),'0') AS internal_units
          FROM world_members m JOIN agents a ON a.id=m.agent_id
          JOIN world_agent_states s ON s.world_id=m.world_id AND s.agent_id=m.agent_id
          LEFT JOIN agent_minds am ON am.world_id=m.world_id AND am.agent_id=m.agent_id
          LEFT JOIN world_social_profiles p ON p.world_id=m.world_id AND p.agent_id=m.agent_id
          LEFT JOIN world_agent_self_models v7 ON v7.world_id=m.world_id AND v7.agent_id=m.agent_id
          LEFT JOIN world_agent_decision_policies v7policy ON v7policy.world_id=m.world_id AND v7policy.agent_id=m.agent_id
          WHERE m.world_id=$1 ORDER BY m.joined_at,a.name FOR UPDATE OF m,s`, [worldId]);
        const scenesResult = await client.query(`SELECT id,name,scene_type AS "sceneType",status,capacity,purpose,features,position
          FROM world_scenes
          WHERE world_id=$1 ORDER BY created_at,id`, [worldId]);
        const scenes = scenesResult.rows;
        let capabilityOptions = await listWorldCapabilityUses(client, { worldId, limit: 100 });
        const placeIdsByName = Object.fromEntries(scenes.map((scene) => [scene.name, scene.id]));
        const dueResidents = membersResult.rows.filter((member) => member.status === 'idle'
          && new Date(member.next_decision_at).getTime() <= now.getTime());
        phaseSucceeded('RESIDENT_UPDATE');
        setPhase('INSTITUTIONAL_EXPIRY');
        let initiativeState = null;
        if (newHour > oldHour) {
          await expireInstitutionalState(client, { worldId, worldTime: worldMinutes });
          await expirePendingWorldBusinessApplications(client, { worldId, worldTime: worldMinutes });
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
          const environmentIdeas = newHour > oldHour ? environmentEventIdeas({ scenes, calendar: environment.calendar,
            weather: environment.weather, previousWeather: previousEnvironment.condition
              ? { condition: previousEnvironment.condition } : null }) : [];
          if (newHour > oldHour) for (const idea of [...initiativeState.newIdeas, ...environmentIdeas]) {
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
        phaseSucceeded('INSTITUTIONAL_EXPIRY');
        const occupancy = {};
        for (const member of membersResult.rows) occupancy[member.location] = (occupancy[member.location] || 0) + 1;
        const placeCounts = Object.fromEntries(membersResult.rows.map((member) => [member.location,
          membersResult.rows.filter((other) => other.location === member.location).length - 1]));

        for (const row of membersResult.rows) {
          const agent = { ...row, agentId: row.agent_id,
            currentGoal: row.current_goal || row.goal || 'balanced',
            planned_paid_meal: row.planned_paid_meal,
            nextInstitutionalReviewWorldMinutes: row.next_institutional_review_world_minutes === null
              ? null : Number(row.next_institutional_review_world_minutes),
            nextCivilizationReviewWorldMinutes: row.next_civilization_review_world_minutes === null
              ? null : Number(row.next_civilization_review_world_minutes),
            social_partner_id: row.planned_partner_id,
            riskTolerance: clamp(finite(row.risk_tolerance) + finite(row.risk_modifier), 0, 1),
            priceSensitivity: finite(row.price_sensitivity, 0.5),
            sociability: finite(row.sociability, 0.5), curiosity: finite(row.curiosity, 0.5),
            discipline: finite(row.discipline, 0.5), ambition: finite(row.ambition, 0.5),
            personalityModifiers: safeJson(row.personality_modifiers),
            decisionPolicy: safeJson(row.decision_policy), decisionPolicyVersion: Number(row.decision_policy_version) || 0,
            decisionPolicySource: row.decision_policy_source || 'substrate',
            primaryGoal: row.primary_goal || 'BALANCED_LIFE', skills: safeJson(row.skills),
            goals: Array.isArray(row.goals) ? row.goals : [], beliefs: Array.isArray(row.beliefs) ? row.beliefs : [],
            recentMemories: Array.isArray(row.recent_memories) ? row.recent_memories : [],
            relationships: Array.isArray(row.relationships) ? row.relationships : [] };
          const initiativeData = initiativeState?.byAgent.get(agent.agentId) || {};
          Object.assign(agent, initiativeData);
          if (agent.status === 'idle') {
            let nextCivilizationAt = agent.nextCivilizationReviewWorldMinutes;
            if (nextCivilizationAt === null || nextCivilizationAt === undefined) {
              nextCivilizationAt = worldMinutes + 1
                + stableInt(`${worldId}:${agent.agentId}:civilization-phase`) % CIVILIZATION_REVIEW_INTERVAL_MINUTES;
              await client.query(`UPDATE world_agent_states SET next_civilization_review_world_minutes=$3,updated_at=$4
                WHERE world_id=$1 AND agent_id=$2`, [worldId, agent.agentId, nextCivilizationAt, now]);
            } else if (nextCivilizationAt <= worldMinutes) {
              nextCivilizationAt = worldMinutes + CIVILIZATION_REVIEW_INTERVAL_MINUTES;
              await client.query(`UPDATE world_agent_states SET next_civilization_review_world_minutes=$3,updated_at=$4
                WHERE world_id=$1 AND agent_id=$2`, [worldId, agent.agentId, nextCivilizationAt, now]);
              setPhase('V6_CIVILIZATIONAL_REVIEW');
              let lastCivilizationPhase = null;
              await advanceWorldCivilization(client, { worldId, agent, worldMinute: worldMinutes,
                chooseWithTypeSafe: chooseCivilizationOption ? chooseCivilizationOptionBounded : null,
                onPhase(phase) {
                  if (lastCivilizationPhase) phaseSucceeded(lastCivilizationPhase);
                  lastCivilizationPhase = phase;
                  setPhase(phase);
                } });
              if (lastCivilizationPhase) phaseSucceeded(lastCivilizationPhase);
              if (currencyGenesisEnabled) {
                setPhase('CURRENCY_GENESIS_RESIDENT_REVIEW');
                await advanceWorldCurrencyGenesis(client, { worldId, agent, worldMinute: worldMinutes,
                  chooseWithTypeSafe: chooseCivilizationOption ? chooseCivilizationOptionBounded : null,
                  ...(authorCurrencyProposal ? { authorProposal: authorCurrencyProposal } : {}) });
                phaseSucceeded('CURRENCY_GENESIS_RESIDENT_REVIEW');
              }
              setPhase('RESIDENT_COGNITION');
              capabilityOptions = await listWorldCapabilityUses(client, { worldId, limit: 100 });
              phaseSucceeded('RESIDENT_COGNITION');
            }
            agent.nextCivilizationReviewWorldMinutes = nextCivilizationAt;
          }
          const lastReflection = row.last_reflection_world_minutes === null ? null : Number(row.last_reflection_world_minutes);
          const newImportantMemory = agent.recentMemories.some((memory) => Number(memory.importance) >= 0.7
            && Number(memory.worldMinutes) > (lastReflection ?? -1));
          const reflectionTrigger = newImportantMemory ? 'important_event' : 'cadence';
          setPhase('RESIDENT_REFLECTION');
          const reflected = reflectionDue({ worldMinutes, lastReflectionWorldMinutes: lastReflection,
            important: reflectionTrigger === 'important_event' })
            ? await reflectResident(client, worldId, agent, tickCount, worldMinutes, reflectionTrigger) : null;
          phaseSucceeded('RESIDENT_REFLECTION');
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
          const lastV7Reflection = row.v7_last_reflected_world_minute === null
            ? null : Number(row.v7_last_reflected_world_minute);
          if (lastV7Reflection === null || worldMinutes - lastV7Reflection >= WORLD_V7_REFLECTION_INTERVAL_MINUTES) {
            setPhase('V7_SELF_REFLECTION');
            await reflectWorldV7Resident(client, { worldId, agent, worldMinute: worldMinutes,
              chooseReflection: chooseWorldV7Reflection ? chooseWorldV7ReflectionBounded : null });
            const currentPolicy = await client.query(`SELECT policy,version,source FROM world_agent_decision_policies
              WHERE world_id=$1 AND agent_id=$2`, [worldId, agent.agentId]);
            if (currentPolicy.rowCount) {
              agent.decisionPolicy = safeJson(currentPolicy.rows[0].policy);
              agent.decisionPolicyVersion = Number(currentPolicy.rows[0].version) || 0;
              agent.decisionPolicySource = currentPolicy.rows[0].source;
            }
            phaseSucceeded('V7_SELF_REFLECTION');
          }
          if (agent.status === 'walking' && new Date(agent.movement_ends_at).getTime() <= now.getTime()) {
            setPhase('RESIDENT_MOVEMENT');
            const destination = agent.target_location;
            await client.query('UPDATE world_members SET location=$3 WHERE world_id=$1 AND agent_id=$2', [worldId, agent.agentId, destination]);
            const destinationScene = scenes.find((scene) => scene.name === destination);
            const arrivalVariant = activityVariant({ action: agent.planned_action, location: destination,
              sceneType: destinationScene?.sceneType || null, agentId: agent.agentId,
              calendar: environment.calendar, weather: environment.weather });
            const duration = activityDurationSeconds(agent.planned_action, ACTION_SECONDS[agent.planned_action] || 10,
              { variant: arrivalVariant, agentId: agent.agentId, calendar: environment.calendar });
            await client.query(`UPDATE world_agent_states SET status='performing',movement_started_at=NULL,movement_ends_at=NULL,
                action_started_at=$3,action_ends_at=$4,activity_variant=$5,updated_at=$3 WHERE world_id=$1 AND agent_id=$2`,
            [worldId, agent.agentId, now, new Date(now.getTime() + duration * 1_000), arrivalVariant]);
            row.activity_variant = arrivalVariant;
            await recordWorldEvent(client, worldId, agent.agentId, tickCount, 'world.agent_arrived',
              { place: destination, action: agent.planned_action, worldMinutes, at: now.toISOString() });
            await recordWorldEvent(client, worldId, agent.agentId, tickCount, 'world.action_started',
              { place: destination, action: agent.planned_action, variant: arrivalVariant, worldMinutes, at: now.toISOString(),
                weather: environment.weather.condition });
            await setMindGoal(client, worldId, agent.agentId, agent.current_goal || agent.goal, agent.planned_action, null);
            phaseSucceeded('RESIDENT_MOVEMENT');
          } else if (agent.status === 'performing' && new Date(agent.action_ends_at).getTime() <= now.getTime()) {
            const completedAction = String(agent.planned_action || '');
            const completionPhase = completedAction === 'capability_use' ? 'CAPABILITY_EXPERIMENTS'
              : completedAction.startsWith('business') ? 'ECONOMY'
                : completedAction.startsWith('agreement') || completedAction === 'commitment_resolve'
                  ? 'AGREEMENTS' : 'ACTION_COMPLETION';
            setPhase(completionPhase);
            const placeResult = scenes.find((scene) => scene.name === agent.location);
            const learning = await completeActivity(client, worldId, { ...agent, scene_type: placeResult?.sceneType || null },
              { tick_count: tickCount, world_minutes: worldMinutes }, now, placeResult, onAutonomousBusinessAction,
              environment);
            phaseSucceeded(completionPhase);
            if (learning) fruitflyOutcomes.push(learning);
          } else if (agent.status === 'idle' && new Date(agent.next_decision_at).getTime() <= now.getTime()) {
            const residentsAtLocation = Object.fromEntries(scenes.filter((scene) => ['cafe','garden','commons','workshop','studio','data_center'].includes(scene.sceneType))
              .map((scene) => [scene.name, membersResult.rows.filter((other) => other.location === scene.name
                && other.agent_id !== agent.agentId && other.status === 'idle').map((other) => {
                  const relationship = agent.relationships.find((item) => item.otherAgentId === other.agent_id) || null;
                  return { agentId: other.agent_id, name: other.name, status: other.status, location: other.location,
                    energy: other.energy, food: other.food, social: other.social, knowledge: other.knowledge,
                    primaryGoal: other.primary_goal, skills: safeJson(other.skills), relationship,
                    lastInteractionWorldMinutes: relationship?.lastInteractionWorldMinutes };
                })]));
          const nativeUtilityCandidates = buildActivityCandidates(agent, scenes, { tick: tickCount, worldMinutes, nowMs,
            residentsAt: placeCounts, residentsAtLocation, environment, occupancy });
          const capabilityCandidates = await buildCapabilityUseCandidates(agent, capabilityOptions, {
            worldMinutes, residentsAtLocation, placeIdsByName,
            maxAlternativeScore: Math.max(0, ...nativeUtilityCandidates.map((candidate) => Number(candidate.score) || 0)) });
          const utilityCandidates = [...nativeUtilityCandidates,
            ...capabilityCandidates.filter((candidate) => destinationFeasible(candidate, agent, scenes, environment))];
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
            let institutionalDue = false;
            let nextInstitutionalAt = agent.nextInstitutionalReviewWorldMinutes;
            if (nextInstitutionalAt === null || nextInstitutionalAt === undefined) {
              const phase = stableInt(`${agent.agentId}:institutional-phase`) % 1_440;
              nextInstitutionalAt = worldMinutes + phase;
              institutionalDue = phase === 0;
            } else if (nextInstitutionalAt <= worldMinutes) institutionalDue = true;
            if (institutionalDue) nextInstitutionalAt = worldMinutes + 1_440;
            if (agent.nextInstitutionalReviewWorldMinutes === null || agent.nextInstitutionalReviewWorldMinutes === undefined
                || institutionalDue) {
              await client.query(`UPDATE world_agent_states SET next_institutional_review_world_minutes=$3,updated_at=$4
                WHERE world_id=$1 AND agent_id=$2`, [worldId, agent.agentId, nextInstitutionalAt, now]);
              agent.nextInstitutionalReviewWorldMinutes = nextInstitutionalAt;
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
            let businessContext = initiativeContext;
            if (strategicDue) {
              const marketView = await observeResidentEconomicMarket(client, { worldId, agent,
                context: { ...initiativeContext, residentsAtLocation }, worldMinutes });
              agent.demand = marketView.demand;
              agent.services = marketView.services;
              businessContext = { ...initiativeContext, ...marketView,
                residentsAtLocation, demand: marketView.demand };
            }
            const businessCandidates = strategicDue ? buildBusinessCandidates(agent, businessContext) : [];
            const initiativeCandidates = strategicDue
              ? [...buildWorldInitiativeCandidates(agent, initiativeContext), ...businessCandidates, ...capabilityCandidates] : [];
            let candidates;
            let decisionLayer = 'tactical';
            let qualifiedStrategicCandidates = [];
            let permittedInitiatives = [];
            if (strategicDue) {
              const minimumEnergy = 15;
              const minimumFood = 8;
              const needsBlocked = agent.energy < minimumEnergy || agent.food < minimumFood;
              permittedInitiatives = needsBlocked ? [] : initiativeCandidates.filter((candidate) => {
                if (candidate.action === 'project_contribute' && (agent.energy < 20 || agent.food < 10)) return false;
                return destinationFeasible(candidate, agent, scenes, environment);
              });
              qualifiedStrategicCandidates = qualifyLayeredStrategicCandidates(permittedInitiatives);
              for (const gap of explainBusinessOpportunityGaps(agent, businessContext, businessCandidates)) {
                const reasonCodes = [gap.reasonCode, ...(gap.additionalReasonCodes || [])];
                for (const originalReason of new Set(reasonCodes)) {
                  const hasCandidate = ['CANDIDATE_CREATED','RECOVERY_OBSERVATION_AVAILABLE'].includes(originalReason);
                  const reasonCode = hasCandidate ? 'CANDIDATE_GENERATED' : recoveryBlocker(originalReason);
                  const stage = hasCandidate ? 'recovery_candidate' : 'blocked';
                  const candidate = businessCandidates.find((item) => item.businessProposal?.serviceType === gap.serviceType
                    || item.preparationServiceType === gap.serviceType || item.cofounderProposal?.serviceType === gap.serviceType
                    || item.marketObservationServiceType === gap.serviceType || item.reopenProposal?.serviceType === gap.serviceType);
                  await recordEmergenceEvent(client, { worldId, agentId: agent.agentId, worldMinutes, tickCount,
                    system: 'business', stage, reasonCode,
                    eventKey: `business-opportunity:${agent.agentId}:${tickCount}:${gap.serviceType}:${originalReason}`,
                    candidateId: `${gap.serviceType}:${gap.action || 'none'}`, action: gap.action || 'business_found',
                    utilityScore: candidate?.score,
                    details: { originalReasonCode: originalReason, demandCount: gap.demandCount,
                      supplyCount: gap.supplyCount, unmetCount: gap.unmetCount,
                      capabilityFit: gap.capabilityFit, ownCapabilityFit: gap.ownCapabilityFit,
                      teamCapabilityFit: gap.teamCapabilityFit, requiredSkill: gap.requiredSkill,
                      capitalAvailable: gap.capitalAvailable, learningAvailable: gap.learningAvailable,
                      partnerAvailable: gap.partnerAvailable, awareness: gap.awareness,
                      marketKnown: gap.known, decisionLayer: 'economic' } });
                }
              }
              for (const candidate of initiativeCandidates) {
                const eligible = qualifiedStrategicCandidates.some((item) => item.id === candidate.id);
                const reasonCode = needsBlocked ? (agent.energy < minimumEnergy ? 'ENERGY_LOW' : 'FOOD_LOW')
                  : eligible ? 'NONE' : candidate.action === 'project_contribute'
                    && (agent.energy < 20 || agent.food < 10) ? 'NEEDS_HARD_GATE'
                    : !destinationFeasible(candidate, agent, scenes, environment) ? 'PLACE_CLOSED'
                    : candidate.action.startsWith('business_')
                      ? (qualifiedStrategicCandidates.length >= 8 ? 'NO_STRATEGIC_SLOT' : 'OTHER')
                      : 'UTILITY_BELOW_THRESHOLD';
                if (ECONOMIC_RECOVERY_ACTIONS.has(candidate.action)) await recordEmergenceEvent(client, {
                  worldId, agentId: agent.agentId, worldMinutes, tickCount, system: 'business',
                  stage: 'recovery_candidate', reasonCode: 'CANDIDATE_GENERATED',
                  eventKey: `recovery-candidate:${agent.agentId}:${tickCount}:${candidate.id}`,
                  candidateId: candidate.id, action: candidate.action, utilityScore: candidate.score,
                  details: { serviceType: candidate.businessProposal?.serviceType || candidate.preparationServiceType
                      || candidate.cofounderProposal?.serviceType || candidate.marketObservationServiceType
                      || candidate.reopenProposal?.serviceType || null,
                    recoveryEligible: eligible } });
                await recordEmergenceEvent(client, { worldId, agentId: agent.agentId, worldMinutes, tickCount,
                  system: initiativeSystem(candidate.action),
                  stage: eligible ? 'eligible' : 'blocked', reasonCode,
                  eventKey: `strategic-candidate:${agent.agentId}:${tickCount}:${candidate.id}:${eligible ? 'eligible' : 'blocked'}`,
                  candidateId: candidate.id, action: candidate.action, utilityScore: candidate.score,
                  details: { goalStagnant: Boolean(agent.goalStagnation?.stagnant),
                    worldNeedCount: initiativeContext.worldNeeds?.length || 0,
                    proposalReasons: candidate.projectProposal?.metadata?.proposalReasons || [],
                    filterReason: !eligible && candidate.action.startsWith('business_') ? reasonCode : null } });
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
            let institutionalPlan = null;
            let institutionalPlanEligible = false;
            if (institutionalDue) {
              institutionalPlan = await planInstitutionalAction(client, { worldId, agent, worldTime: worldMinutes });
              if (institutionalPlan) {
                await recordEmergenceEvent(client, { worldId, agentId: agent.agentId, worldMinutes, tickCount,
                  system: 'institution', stage: 'considered', eventKey: `institution:${agent.agentId}:${tickCount}:considered`,
                  candidateId: institutionalPlan.id, action: institutionalPlan.action, utilityScore: institutionalPlan.score,
                  details: institutionalPlan.institutionalTrace || {} });
                const minimumEnergy = institutionalPlan.action === 'business_work' ? 20 : 15;
                const minimumFood = institutionalPlan.action === 'business_work' ? 12 : 8;
                const needsReason = agent.energy < minimumEnergy ? 'ENERGY_LOW'
                  : agent.food < minimumFood ? 'FOOD_LOW' : null;
                if (!needsReason) {
                  const baseCandidates = decisionLayer === 'strategic' ? permittedInitiatives : utilityCandidates;
                  const combined = [...baseCandidates, institutionalPlan];
                  candidates = decisionLayer === 'strategic'
                    ? qualifyLayeredStrategicCandidates(combined) : qualifyUtilityCandidates(combined);
                  if (decisionLayer === 'strategic') qualifiedStrategicCandidates = candidates;
                  else decisionLayer = 'tactical_institutional';
                  institutionalPlanEligible = candidates.some((item) => item.id === institutionalPlan.id);
                }
                if (needsReason) {
                  await recordEmergenceEvent(client, { worldId, agentId: agent.agentId, worldMinutes, tickCount,
                    system: 'institution', stage: 'blocked', reasonCode: needsReason,
                    eventKey: `institution:${agent.agentId}:${tickCount}:blocked`,
                    candidateId: institutionalPlan.id, action: institutionalPlan.action, utilityScore: institutionalPlan.score,
                    details: { ...institutionalPlan.institutionalTrace, requiredEnergy: minimumEnergy,
                      requiredFood: minimumFood, energy: agent.energy, food: agent.food } });
                } else {
                  await recordEmergenceEvent(client, { worldId, agentId: agent.agentId, worldMinutes, tickCount,
                    system: 'institution', stage: institutionalPlanEligible ? 'eligible' : 'blocked',
                    reasonCode: institutionalPlanEligible ? 'NONE' : 'UTILITY_BELOW_THRESHOLD',
                    eventKey: `institution:${agent.agentId}:${tickCount}:${institutionalPlanEligible ? 'eligible' : 'blocked'}`,
                    candidateId: institutionalPlan.id, action: institutionalPlan.action, utilityScore: institutionalPlan.score,
                    details: { ...institutionalPlan.institutionalTrace,
                      eligibleCandidateCount: candidates.length } });
                }
                const retryAt = worldMinutes + INSTITUTIONAL_RETRY_WORLD_MINUTES;
                await client.query(`UPDATE world_agent_states SET next_institutional_review_world_minutes=$3,updated_at=$4
                  WHERE world_id=$1 AND agent_id=$2`, [worldId, agent.agentId, retryAt, now]);
                agent.nextInstitutionalReviewWorldMinutes = retryAt;
              }
            }
            setPhase('TACTICAL_DECISIONS');
            let activity = null;
            let flyObservation = null;
            let flyCandidates = [];
            let flySelected = null;
            let decision = null;
            let usedFruitfly = false;
            if (fruitfly && candidates.length) {
              const businessBeliefs = agent.beliefs.filter((belief) => belief.subjectType === 'business'
                && belief.beliefKey === 'business_outcome');
              const marketBeliefs = agent.beliefs.filter((belief) => belief.subjectType === 'market'
                && belief.beliefKey === 'unmet_demand');
              const economicOutcome = businessBeliefs.length ? businessBeliefs.reduce((sum, belief) =>
                sum + Number(belief.estimate || 0) * Number(belief.confidence || 0), 0) / businessBeliefs.length : 0;
              flyObservation = { self: { agentId: agent.agentId, energy: agent.energy, food: agent.food, social: agent.social,
                  riskTolerance: agent.riskTolerance, usdc: agent.usdc, knowledge: agent.knowledge },
                mind: { archetype: agent.archetype || 'observer', traits: { ...safeJson(agent.traits),
                    curiosity: agent.curiosity, craft: finite(agent.skills?.engineering) / 100 },
                  actionsTaken: agent.actions_taken, memories: agent.recentMemories,
                  goals: agent.goals, beliefs: agent.beliefs, relationships: agent.relationships,
                  skills: agent.skills, economic: { outcome: economicOutcome,
                    marketOpportunity: marketBeliefs.reduce((sum, belief) => sum + Math.max(0, Number(belief.estimate) || 0), 0)
                      / Math.max(1, marketBeliefs.length), capital: agent.usdc,
                    recentExperience: agent.recentMemories.filter((memory) => memory.memoryType === 'business'
                      || memory.memoryType === 'economic').length },
                  personality: { ...agent.personalityModifiers, sociability: agent.sociability, curiosity: agent.curiosity,
                    discipline: agent.discipline, ambition: agent.ambition } } };
              flyCandidates = candidates.map((candidate) => ({ ...candidate }));
              try {
              const choice = fruitfly.choose(agent.agentId, flyObservation, flyCandidates, candidates[0]);
              const selectedCandidate = candidates.find((candidate) => candidate.id === choice?.candidate?.id);
              if (selectedCandidate) {
                activity = selectedCandidate;
                usedFruitfly = true;
                decision = choice;
                } else if (choice?.candidate) {
                  reportError(new Error('Fruitfly selected a candidate outside the feasible set.'), 'fruitfly_choice');
                }
              } catch (error) { reportError(error, 'fruitfly_choice'); }
            }
            phaseSucceeded('TACTICAL_DECISIONS');
            if (!activity) {
              await client.query(`UPDATE world_agent_states SET next_decision_at=$3,updated_at=$4
                WHERE world_id=$1 AND agent_id=$2`, [worldId, agent.agentId, new Date(now.getTime() + 30_000), now]);
              continue;
            }
            if (institutionalPlan && institutionalPlanEligible) {
              const selectedPlan = institutionalPlan.id === activity.id;
              await recordEmergenceEvent(client, { worldId, agentId: agent.agentId, worldMinutes, tickCount,
                system: 'institution', stage: selectedPlan ? 'selected' : 'not_selected',
                reasonCode: selectedPlan ? 'NONE' : 'FRUITFLY_NOT_SELECTED',
                eventKey: `institution:${agent.agentId}:${tickCount}:${selectedPlan ? 'selected' : 'not-selected'}`,
                candidateId: institutionalPlan.id, action: institutionalPlan.action,
                utilityScore: institutionalPlan.score,
                details: { ...(institutionalPlan.institutionalTrace || {}), selectedByFruitfly: selectedPlan && usedFruitfly,
                  selectedAction: activity.action } });
              if (institutionalPlan.institutionalTrace?.agreementId) {
                await recordAgreementExecutionStage(client, { worldId,
                  agreementId: institutionalPlan.institutionalTrace.agreementId,
                  stage: selectedPlan ? 'action_selected' : 'candidate_not_selected', worldTime: worldMinutes,
                  agentId: agent.agentId,
                  eventKey: `${tickCount}:${institutionalPlan.id}:${selectedPlan ? 'selected' : 'not-selected'}`,
                  reasonCode: selectedPlan ? null : 'FRUITFLY_NOT_SELECTED',
                  details: { candidateId: institutionalPlan.id, action: institutionalPlan.action,
                    selectedAction: activity.action, commitmentId: institutionalPlan.commitmentId || null } });
              }
            }
            if (decisionLayer === 'strategic') {
              for (const candidate of qualifiedStrategicCandidates) {
                if (candidate.id === activity.id || candidate.id === institutionalPlan?.id) continue;
                await recordEmergenceEvent(client, { worldId, agentId: agent.agentId, worldMinutes, tickCount,
                  system: initiativeSystem(candidate.action),
                  stage: 'not_selected', reasonCode: 'FRUITFLY_NOT_SELECTED',
                  eventKey: `fruitfly-not-selected:${agent.agentId}:${tickCount}:${candidate.id}`,
                  candidateId: candidate.id, action: candidate.action, utilityScore: candidate.score,
                  details: { filterReason: 'Fruitfly selected another qualified candidate.' } });
              }
              const chosenSystem = initiativeSystem(activity.action);
              await recordEmergenceEvent(client, { worldId, agentId: agent.agentId, worldMinutes, tickCount,
                system: chosenSystem, stage: 'fruitfly_selected',
                eventKey: `fruitfly-selected:${agent.agentId}:${tickCount}`,
                candidateId: activity.id, action: activity.action, utilityScore: activity.score,
                details: { decisionLayer, candidateCount: candidates.length } });
              if (ECONOMIC_RECOVERY_ACTIONS.has(activity.action)) await recordEmergenceEvent(client, {
                worldId, agentId: agent.agentId, worldMinutes, tickCount, system: 'business',
                stage: 'recovery_selected', reasonCode: 'FRUITFLY_SELECTED',
                eventKey: `recovery-selected:${agent.agentId}:${tickCount}:${activity.id}`,
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
                chosen_candidate_id,chosen_action,behavior_probability,distribution,utility_scores,goal_snapshot,rationale,
                decision_policy_version,decision_policy_source)
              VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10::jsonb,$11::jsonb,$12,$13)`,
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
                eligibleCandidateCount: candidates.length }), agent.decisionPolicyVersion || 0,
              agent.decisionPolicySource || 'substrate']);
            await client.query(`DELETE FROM world_decision_traces WHERE id IN (
              SELECT id FROM world_decision_traces WHERE world_id=$1 AND agent_id=$2
              ORDER BY tick_count DESC,id DESC OFFSET 50)`, [worldId, agent.agentId]);
            const localScene = scenes.find((scene) => scene.name === agent.location);
            const localVariant = activity.targetLocation === agent.location ? activityVariant({ action: activity.action,
              location: agent.location, sceneType: localScene?.sceneType || null, agentId: agent.agentId,
              calendar: environment.calendar, weather: environment.weather }) : null;
            const duration = activityDurationSeconds(activity.action, ACTION_SECONDS[activity.action] || 10,
              { variant: localVariant, agentId: agent.agentId, calendar: environment.calendar });
            const plannedContext = Object.fromEntries(['opportunityId','opportunityProposal','projectId','decision','projectProposal','goalReviewProposal',
              'capabilityId','capabilityExperimentId','capabilityContext',
              'organizationId','organizationProposal','inviteeAgentId','shareId','informationProposal','contributionType',
              'businessProposal','cofounderProposal','preparationSkill','preparationServiceType',
              'marketObservationServiceType','reopenProposal',
              'businessId','serviceId','jobId','applicationId','maxPriceUsdc','amountUsdc','fundingSource',
              'direction','contributionAmountUsdc','employmentId','pricingContext','counterpartyAgentId','agreementType',
              'contractAgreementId',
              'agreementTerms','agreementId','counterTerms','expiresInWorldMinutes','parentAgreementId','commitmentId','outcome',
              'proposalId','proposalType','proposalPayload','institutionalTrace']
              .filter((key) => activity[key] !== undefined).map((key) => [key, activity[key]]));
            if (activity.action === 'capability_use') {
              plannedContext.capabilitySelectionSource = usedFruitfly ? 'fruitfly' : 'utility_fallback';
            }
            if (activity.targetLocation !== agent.location) {
              const walkSeconds = travelSeconds(scenes.find((scene) => scene.name === agent.location) || agent.location,
                scenes.find((scene) => scene.name === activity.targetLocation) || activity.targetLocation,
                { weather: environment.weather, seed: `${agent.agentId}:${tickCount}` });
              const movementEnd = new Date(now.getTime() + walkSeconds * 1_000);
              await client.query(`UPDATE world_agent_states SET status='walking',planned_action=$3,target_location=$4,activity_variant=NULL,
                  planned_side=NULL,planned_asset=NULL,planned_quote_units=NULL,planned_paid_meal=$5,planned_partner_id=$6,
                  fruitfly_observation=$9::jsonb,fruitfly_candidates=$10::jsonb,fruitfly_selected=$11::jsonb,
                  planned_context=$12::jsonb,
                  movement_started_at=$7,movement_ends_at=$8,action_started_at=NULL,action_ends_at=NULL,
                  updated_at=$7 WHERE world_id=$1 AND agent_id=$2`,
              [worldId, agent.agentId, activity.action, activity.targetLocation, Boolean(activity.plannedPaidMeal),
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
              await client.query(`UPDATE world_agent_states SET status='performing',planned_action=$3,target_location=NULL,activity_variant=$12,
                  planned_side=NULL,planned_asset=NULL,planned_quote_units=NULL,planned_paid_meal=$4,planned_partner_id=$5,
                  fruitfly_observation=$8::jsonb,fruitfly_candidates=$9::jsonb,fruitfly_selected=$10::jsonb,
                  planned_context=$11::jsonb,
                  movement_started_at=NULL,movement_ends_at=NULL,action_started_at=$6,action_ends_at=$7,updated_at=$6
                WHERE world_id=$1 AND agent_id=$2`,
              [worldId, agent.agentId, activity.action, Boolean(activity.plannedPaidMeal), activity.socialPartnerId, now,
                new Date(now.getTime() + duration * 1_000), JSON.stringify(flyObservation || {}),
                JSON.stringify(flyCandidates), JSON.stringify(flySelected || {}), JSON.stringify(plannedContext), localVariant]);
              row.activity_variant = localVariant;
              await setMindGoal(client, worldId, agent.agentId, activity.goal, activity.action, null);
              await recordWorldEvent(client, worldId, agent.agentId, tickCount, 'world.action_started',
                { place: agent.location, action: activity.action, variant: localVariant, worldMinutes, at: now.toISOString(),
                  weather: environment.weather.condition });
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
        if (tickCount % 60 === 0) {
          setPhase('V7_POLICY_EVALUATION');
          await advanceWorldV7(client, { worldId, worldMinute: worldMinutes,
            choosePolicyDecision: chooseWorldV7Reflection ? chooseWorldV7ReflectionBounded : null });
          phaseSucceeded('V7_POLICY_EVALUATION');
        }
        setPhase('PERSISTENCE');
        await client.query('COMMIT');
        diagnostics.persistedWorldMinute = worldMinutes;
        diagnostics.persistedTickCount = tickCount;
        diagnostics.lastTickCompletedAt = new Date(readNowMs()).toISOString();
        resumeBaselineMs = null;
        phaseSucceeded('PERSISTENCE');
        setPhase('TICK_COMPLETE');
        phaseSucceeded('TICK_COMPLETE');
        staleEpisodeReported = false;
        const recovered = errorCount > 0;
        errorCount = 0;
        try { onStatus({ running: true, worldId, tickCount, worldMinutes, residents: membersResult.rowCount,
          ...(recovered ? { recovered: true, suppressedErrors } : {}) }); }
        catch (error) { reportError(error, 'status_callback'); }
        suppressedErrors = 0;
      } catch (error) {
        try { await client.query('ROLLBACK'); }
        catch (rollbackError) { reportError(rollbackError, 'tick_rollback'); }
        throw error;
      } finally { client.release(); }
      if (fruitfly && fruitflyOutcomes.length) {
        fruitflyTask = Promise.all(fruitflyOutcomes.map((outcome) => fruitfly.learn(outcome.agentId,
          outcome.observation, outcome.candidates, outcome.selected, outcome.result)))
          .catch((error) => reportError(error, 'fruitfly_learning'))
          .finally(() => { fruitflyTask = null; });
      }
      if (shouldAskTypeSafe && chooseWithTypeSafe && runtimeState) {
        const operation = runStrategicTypeSafe(pool, worldId, chooseWithTypeSafe, runtimeState);
        typeSafeTask = settleOptionalReasoning(operation, { timeoutMs: 12_000, fallback: { reason: 'timeout' } })
          .then(({ value, timedOut, error }) => {
            if (error) reportError(error, 'typesafe_selection');
            if (timedOut) reportError(new Error('Optional TypeSafe strategic selection exceeded 12000ms.'), 'typesafe_strategic_timeout');
            else if (value?.reason === 'selected') {
              try { onStatus({ running: true, typeSafe: value }); }
              catch (error) { reportError(error, 'status_callback'); }
            }
          })
          .finally(() => { typeSafeInProgress = false; typeSafeTask = null; });
        typeSafeTaskStarted = true;
      }
    } catch (error) {
      errorCount += 1;
      nextRetryAt = readNowMs() + Math.min(30_000, 1_000 * 2 ** Math.min(errorCount, 5));
      const timestamp = new Date(readNowMs());
      diagnostics.lastTickError = worldEngineErrorRecord({ error, stage: 'tick', worldId,
        worldMinute: diagnostics.worldMinute, tickCount: diagnostics.tickCount,
        phase: diagnostics.lastTickPhase, timestamp });
      if (readNowMs() - lastErrorLoggedAt >= 60_000) {
        lastErrorLoggedAt = readNowMs();
        reportError(error, 'tick', { tickFailure: true });
      } else suppressedErrors += 1;
    } finally {
      if (shouldAskTypeSafe && !typeSafeTaskStarted) {
        typeSafeInProgress = false;
        nextTypeSafeAt = 0;
      }
      tickInProgress = false;
      diagnostics.tickInProgress = false;
      diagnostics.activeTickStartedAt = null;
    }
  }

  const actualTickMs = Math.max(250, Math.trunc(finite(tickMs, WORLD_TICK_MS)));
  const scheduledTick = () => {
    diagnostics.lastSchedulerFireAt = new Date(readNowMs()).toISOString();
    if (activeTick || stopped) return;
    activeTick = tick()
      .catch((error) => { reportError(error, 'scheduler_tick_rejection', { tickFailure: true }); })
      .finally(() => { activeTick = null; });
  };
  const startScheduler = () => {
    if (stopped || !diagnostics.worldLockOwned || timer) return;
    timer = setInterval(scheduledTick, actualTickMs);
    timer.unref?.();
    diagnostics.schedulerRunning = true;
    diagnostics.lastSchedulerFireAt = new Date(readNowMs()).toISOString();
  };
  const runWatchdog = async () => {
    if (watchdogInProgress || stopped) return;
    watchdogInProgress = true;
    try {
      if (!await verifyWorldLock()) {
        if (timer) clearInterval(timer);
        timer = null;
        diagnostics.schedulerRunning = false;
        reportError(new Error('World advisory lock is no longer owned by this engine; scheduler was stopped safely.'),
          'watchdog_world_lock_lost', { phase: diagnostics.lastTickPhase });
        return;
      }
      const checkedAt = readNowMs();
      const successfulAt = new Date(diagnostics.lastTickCompletedAt || diagnostics.engineStartedAt).getTime();
      const stale = Number.isFinite(successfulAt) && checkedAt - successfulAt > WORLD_TICK_STALE_AFTER_MS;
      const lastFireAt = diagnostics.lastSchedulerFireAt ? new Date(diagnostics.lastSchedulerFireAt).getTime() : NaN;
      const schedulerStale = !Number.isFinite(lastFireAt) || checkedAt - lastFireAt > Math.max(5_000, actualTickMs * 5);
      if (schedulerStale && !activeTick && !tickInProgress && !stopped) {
        if (timer) clearInterval(timer);
        timer = null;
        startScheduler();
        diagnostics.watchdogLastRecoveryAt = new Date(checkedAt).toISOString();
        reportError(new Error('World tick watchdog restarted an idle scheduler after its pulse became stale.'),
          'watchdog_scheduler_recovery', { phase: diagnostics.lastTickPhase });
      } else if (stale && !staleEpisodeReported) {
        staleEpisodeReported = true;
        const reason = activeTick || tickInProgress
          ? 'World tick has remained in progress without a successful commit beyond the liveness threshold.'
          : 'World tick scheduler is firing but no recent tick has committed.';
        reportError(new Error(reason), 'watchdog_stale_world', { phase: diagnostics.lastTickPhase });
      } else if (!stale) staleEpisodeReported = false;
    } catch (error) {
      diagnostics.worldLockOwned = false;
      if (timer) clearInterval(timer);
      timer = null;
      diagnostics.schedulerRunning = false;
      reportError(error, 'watchdog_lock_check');
    } finally { watchdogInProgress = false; }
  };
  if (schedule) {
    startScheduler();
    watchdogTimer = setInterval(() => { void runWatchdog(); }, WORLD_TICK_WATCHDOG_INTERVAL_MS);
    watchdogTimer.unref?.();
  }
  await tick();
  try { onStatus({ running: true, worldId, tickMs: actualTickMs }); }
  catch (error) { reportError(error, 'status_callback'); }

  return {
    running: true,
    worldId,
    get worldLockOwned() { return diagnostics.worldLockOwned; },
    getLiveness() {
      return { running: !stopped, worldId, worldMinute: diagnostics.persistedWorldMinute,
        tickCount: diagnostics.persistedTickCount, worldLockOwned: diagnostics.worldLockOwned,
        worldLockOwnerPid: diagnostics.worldLockOwnerPid,
        schedulerRunning: diagnostics.schedulerRunning, tickInProgress: diagnostics.tickInProgress,
        activeTickStartedAt: diagnostics.activeTickStartedAt, lastSchedulerFireAt: diagnostics.lastSchedulerFireAt,
        lastTickPhase: diagnostics.lastTickPhase, lastSuccessfulPhase: diagnostics.lastSuccessfulPhase,
        lastTickStartedAt: diagnostics.lastTickStartedAt, lastTickCompletedAt: diagnostics.lastTickCompletedAt,
        lastTickError: diagnostics.lastTickError, lastEngineError: diagnostics.lastEngineError,
        watchdogLastRecoveryAt: diagnostics.watchdogLastRecoveryAt };
    },
    tickOnce: tick,
    async stop() {
      if (stopped) return;
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
      diagnostics.schedulerRunning = false;
      if (watchdogTimer) clearInterval(watchdogTimer);
      watchdogTimer = null;
      if (activeTick) await activeTick;
      if (typeSafeTask) await typeSafeTask;
      if (fruitflyTask) await fruitflyTask;
      try {
        const unlock = await lockClient.query(`SELECT pg_advisory_unlock(hashtextextended('synterra-world-engine',0)) AS unlocked`);
        diagnostics.worldLockOwned = !unlock.rows[0]?.unlocked;
      } catch (error) { diagnostics.worldLockOwned = false; reportError(error, 'lock_release'); }
      finally { lockClient.release(); }
    }
  };
}

export async function worldClock(pool, worldId, running = true) {
  const result = await pool.query(`SELECT tick_count,world_minutes,last_tick_at FROM world_runtime_state WHERE world_id=$1`, [worldId]);
  return result.rowCount ? publicWorldClock(result.rows[0], running) : null;
}

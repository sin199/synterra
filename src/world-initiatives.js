import { opportunityFit } from './world-opportunities.js';
import { projectFit } from './world-projects.js';

const clamp = (value, low = 0, high = 100) => Math.max(low, Math.min(high, Number(value) || 0));
const primaryCategory = (agent) => agent.goals?.find((item) => item.goalType === 'primary' && item.status === 'active')?.category
  || agent.primaryGoal || '';

function goalSkill(category) {
  const key = String(category).toUpperCase();
  if (key.includes('RESEARCH') || key.includes('LEARN')) return 'research';
  if (key.includes('ENGINEERING') || key.includes('BUILD')) return 'engineering';
  if (key.includes('TRADING') || key.includes('TRADE')) return 'trading';
  if (key.includes('RELATIONSHIP') || key.includes('COMMUNITY') || key.includes('SOCIAL')) return 'social';
  return null;
}

function matchedSkill(type) {
  if (type === 'RESEARCH' || type === 'LEARNING') return 'research';
  if (type === 'TRADE') return 'trading';
  if (type === 'SOCIAL') return 'social';
  return 'engineering';
}

function relationshipValue(relation) {
  return Math.max(0, Math.min(100, Number(relation?.familiarity) || 0)) * 0.3
    + Math.max(-20, Math.min(80, Number(relation?.trust) || 0)) * 0.7;
}

function projectTypeFor(agent, context) {
  const category = primaryCategory(agent).toUpperCase();
  if (category.includes('RESEARCH') || Number(agent.skills?.research) >= 45) return 'RESEARCH';
  if (category.includes('ENGINEERING') || context.crowdedPlaces?.length) return 'BUILD';
  if (category.includes('TRADING') || Number(agent.skills?.trading) >= 45) return 'TRADE';
  if (category.includes('RELATIONSHIP') || category.includes('COMMUNITY')) return 'SOCIAL';
  if (Number(agent.skills?.research) >= Number(agent.skills?.engineering || 0)) return 'LEARNING';
  if (Number(agent.skills?.engineering) > 25) return 'DATA';
  return 'GENERAL';
}

export function deriveProjectProposal(agent, context = {}) {
  const type = projectTypeFor(agent, context);
  const skill = matchedSkill(type);
  const levels = agent.skills || {};
  const category = primaryCategory(agent);
  const places = context.crowdedPlaces || [];
  const crowded = places[0] || null;
  const createPlace = Boolean(type === 'BUILD' && crowded && crowded.congestion >= 0.75
    && Number(context.activePlaceCount ?? 0) < 40);
  const needTypes = new Set((context.worldNeeds || []).map((need) => need.type));
  const proposalReasons = [];
  if (context.goalStagnation?.stagnant) proposalReasons.push('GOAL_STAGNATION');
  if (needTypes.has('skill_opportunity_shortage')) proposalReasons.push('WORLD_SCARCITY');
  if (context.projectOpportunity) proposalReasons.push('HIGH_VALUE_OPPORTUNITY');
  if ((context.repeatedCooperationCount || 0) > 0) proposalReasons.push('REPEATED_COOPERATION');
  if (needTypes.has('unused_complementary_skills')) proposalReasons.push('SKILL_COMPLEMENTARITY');
  if ((agent.organizationMemberships || []).some((item) => item.memberStatus === 'active')) proposalReasons.push('ORGANIZATION_NEED');
  if (crowded?.congestion >= 0.75) proposalReasons.push('PLACE_CONGESTION');
  if ((agent.beliefs || []).some((belief) => Number(belief.confidence) >= 0.4
      && Number(belief.estimate) > 0.25)) proposalReasons.push('FUTURE_GAIN_BELIEF');
  if (primaryCategory(agent)) proposalReasons.push('PERSONAL_GOAL');
  const titleSet = {
    RESEARCH: ['Shared Field Study', 'Local Research Notes', 'Open Questions Project'],
    LEARNING: ['Peer Learning Circle', 'Skill Exchange Project', 'Practice and Study Group'],
    BUILD: ['Community Workshop Extension', 'Shared Place Improvement', 'Neighborhood Infrastructure Project'],
    TRADE: ['Market Observation Project', 'Exchange Research Notes', 'Risk Review Study'],
    SOCIAL: ['Resident Gathering Project', 'Community Connections', 'Shared Social Space Project'],
    DATA: ['World Operations Study', 'Systems Improvement Project', 'Data Center Reliability Work'],
    GENERAL: ['Resident Collaboration Project', 'Shared World Initiative', 'Common Ground Project']
  }[type];
  const hash = [...String(agent.agentId)].reduce((sum, char) => sum + char.charCodeAt(0), 0);
  const title = titleSet[hash % titleSet.length];
  const sceneType = type === 'RESEARCH' || type === 'LEARNING' ? 'library'
    : type === 'DATA' ? 'data_center' : type === 'SOCIAL' ? 'commons' : 'studio';
  const goal = type === 'BUILD' ? `Create a useful alternative to the crowded ${crowded?.name || 'shared place'}.`
    : type === 'RESEARCH' ? 'Combine different research skills to produce a useful local study.'
      : type === 'TRADE' ? 'Compare resident market beliefs and document a careful simulated market review.'
        : type === 'SOCIAL' ? 'Make it easier for residents to meet and maintain useful relationships.'
          : `Practice ${skill} together and share the result with residents.`;
  return { projectType: type, title, goal,
    description: `${goal} Participation requires several actions, compatible skills, and shared follow-through.`,
    requiredSkills: { [skill]: Math.min(55, Math.max(12, Number(levels[skill] || 0) * 0.35)) },
    requiredResources: { effortPoints: createPlace ? 45 : 28, maxParticipants: createPlace ? 6 : 4 },
    reward: { skill, skillGain: 2, relationship: 1 },
    metadata: { createPlace, placeType: sceneType, proposalReasons,
      placePurpose: createPlace ? `A resident-created alternative for ${crowded.name} that adds capacity for the shared world.` : null,
      placeCapacity: 10, goalCategories: category ? [category] : [], initiativeSource: 'personal_goal_and_environment',
      crowdedSceneId: crowded?.id || null } };
}

export function deriveOpportunityProposal(agent) {
  const category = primaryCategory(agent).toUpperCase();
  const levels = agent.skills || {};
  const skill = goalSkill(category) || Object.entries(levels).sort((left, right) => Number(right[1]) - Number(left[1]))[0]?.[0] || 'research';
  const type = skill === 'research' ? 'RESEARCH' : skill === 'engineering' ? 'BUILD'
    : skill === 'trading' ? 'TRADE' : skill === 'social' ? 'SOCIAL' : 'LEARNING';
  const place = String(agent.location || 'the shared world').slice(0, 48);
  const title = type === 'RESEARCH' ? `Compare research notes near ${place}`
    : type === 'BUILD' ? `Plan a useful improvement near ${place}`
      : type === 'TRADE' ? `Review market assumptions near ${place}`
        : type === 'SOCIAL' ? `Arrange a resident meetup near ${place}`
          : `Share a learning exercise near ${place}`;
  const skillLevel = Math.max(0, Number(levels[skill]) || 0);
  return { type, title,
    description: `A resident-proposed ${type.toLowerCase()} activity shaped by ${agent.name || 'a resident'}'s ${skill} experience. Participants can decide independently whether it fits their current needs and goals.`,
    requirements: { minEnergy: 15, minFood: 8, minSkills: { [skill]: Math.max(5, Math.min(30, Math.floor(skillLevel * 0.4))) } },
    reward: { skill, skillGain: 1.5, goalProgress: 2 },
    risk: { effort: 'low', failureChance: 0.08 }, capacity: 2, expiresInWorldMinutes: 360 };
}

function relevance(agent, action, context = {}) {
  const category = primaryCategory(agent).toUpperCase();
  const skill = goalSkill(category);
  const match = action.includes('research') ? skill === 'research'
    : action.includes('organization') || action.includes('social') || action.includes('information') ? skill === 'social'
      : action.includes('trade') ? skill === 'trading'
        : action.includes('build') || action.includes('project') ? skill === 'engineering' : false;
  const memoryBoost = (agent.recentMemories || []).some((memory) =>
    String(memory.memoryType || '').includes('project') || String(memory.memoryType || '').includes('cooperation')) ? 3 : 0;
  const stagnationBoost = context.goalStagnation?.stagnant
    ? Math.min(18, 8 + Math.max(0, Number(context.goalStagnation.stagnantMinutes || 0) / 240)) : 0;
  const needs = context.worldNeeds || [];
  const needBoost = Math.min(20, needs.reduce((sum, need) => sum + Number(need.severity || 0)
    * (action.includes('project') || action.includes('build') ? 10 : 5), 0));
  const frustrationBoost = (agent.recentMemories || []).some((memory) => memory.memoryType === 'failure'
    && Number(context.worldMinutes || 0) - Number(memory.worldMinutes || 0) <= 720) ? 4 : 0;
  return (match ? 12 : 0) + memoryBoost + clamp(context.ambition || agent.ambition || 0, 0, 1) * 6
    + stagnationBoost + needBoost + frustrationBoost;
}

export function explainWorldInitiativeGaps(agent, context = {}, candidates = []) {
  const has = (action) => candidates.some((candidate) => candidate.action === action);
  const energy = Number(agent.energy) || 0;
  const food = Number(agent.food) || 0;
  const worldMinutes = Math.max(0, Number(context.worldMinutes) || 0);
  const needs = context.worldNeeds || [];
  const reasons = [];
  const record = (system, reasonCode, details = {}, action = null) => reasons.push({ system, reasonCode, details, action });

  if (!has('opportunity_propose')) {
    const reason = energy < 30 ? 'ENERGY_LOW' : food < 20 ? 'FOOD_LOW'
      : Number(agent.activeOpportunitiesCreated || 0) >= 1 ? 'CAPACITY'
        : Number(context.activeOpportunityCount || 0) >= 32 ? 'CAPACITY'
          : worldMinutes - Number(agent.lastOpportunityCreatedWorldTime || 0) < 360
            && agent.lastOpportunityCreatedWorldTime !== null && agent.lastOpportunityCreatedWorldTime !== undefined
            ? 'COOLDOWN' : 'NO_COMPATIBLE_GOAL';
    record('opportunity', reason, { actionCandidateMissing: true }, 'opportunity_propose');
  }
  if (!has('project_propose')) {
    const reason = energy < 35 ? 'ENERGY_LOW' : food < 20 ? 'FOOD_LOW'
      : (agent.activeProjects || []).length >= 1 ? 'CAPACITY'
        : Number(agent.activeProjectsCreated || 0) >= 2 ? 'CAPACITY'
          : (context.projects || []).some((project) => project.status === 'recruiting'
            && project.creator_agent_id === agent.agentId) ? 'COOLDOWN'
            : needs.length ? 'UTILITY_BELOW_THRESHOLD' : 'NO_SCARCITY';
    record('project', reason, { actionCandidateMissing: true }, 'project_propose');
  }
  if (!has('organization_found')) {
    const relationships = Array.isArray(agent.relationships) ? agent.relationships : [];
    const partners = context.organizationPartners || agent.organizationPartners || [];
    const existingPartners = (agent.organizationMemberships || []).flatMap((organization) =>
      organization.status === 'dissolved' ? [] : organization.memberIds || []);
    const hasTrustedPartner = relationships.some((relation) => Number(relation.trust) >= 5
      && Number(relation.familiarity) >= 25);
    const sharedPartners = partners.filter((partner) => Number(partner.sharedProjectCount || 0) >= 1);
    const trustedSharedPartners = sharedPartners.filter((partner) => Number(partner.trust) >= 5
      && Number(partner.familiarity) >= 25);
    const hasAvailableSharedPartner = trustedSharedPartners.some((partner) =>
      !existingPartners.includes(partner.partnerId || partner.agentId));
    const reason = !relationships.length && !partners.length ? 'NO_PARTNER'
      : !hasTrustedPartner && !trustedSharedPartners.length ? 'INSUFFICIENT_TRUST'
        : !sharedPartners.length ? 'INSUFFICIENT_SHARED_WORK'
          : !trustedSharedPartners.length ? 'INSUFFICIENT_TRUST'
          : !hasAvailableSharedPartner ? 'ALREADY_ORGANIZED'
            : 'INSUFFICIENT_SHARED_WORK';
    record('organization', reason, { trustedPartner: hasTrustedPartner, sharedPartnerCount: sharedPartners.length }, 'organization_found');
  }
  if (!has('information_share')) {
    const relationships = Array.isArray(agent.relationships) ? agent.relationships : [];
    const hasTrusted = relationships.some((relation) => Number(relation.trust) >= 2
      && Number(relation.familiarity) >= 10);
    record('information', hasTrusted ? 'NO_INFORMATION_ASYMMETRY'
      : relationships.length ? 'INSUFFICIENT_TRUST' : 'NO_PARTNER', { actionCandidateMissing: true, trustedPartner: hasTrusted }, 'information_share');
  }
  const proposal = deriveProjectProposal(agent, context);
  if (!proposal.metadata.createPlace) {
    record('place', Number(context.activePlaceCount || 0) >= 40 ? 'CAPACITY'
      : (context.crowdedPlaces || []).length ? 'INSUFFICIENT_RESOURCE' : 'NO_SCARCITY', { actionCandidateMissing: true }, 'project_propose');
  }
  return reasons;
}

export function buildWorldInitiativeCandidates(agent, context = {}) {
  const options = [];
  const skill = goalSkill(primaryCategory(agent));
  const energy = Number(agent.energy) || 0;
  const food = Number(agent.food) || 0;
  const activeProjects = agent.activeProjects || [];
  const projectMemberships = new Set((agent.projectMemberships || []).map((item) => item.projectId));
  const organizationMemberships = agent.organizationMemberships || [];
  const opportunityMemberships = new Set(agent.opportunityMembershipIds || []);

  if (energy >= 30 && food >= 20 && Number(agent.activeOpportunitiesCreated || 0) < 1
    && Number(context.activeOpportunityCount || 0) < 32
    && (agent.lastOpportunityCreatedWorldTime === null || agent.lastOpportunityCreatedWorldTime === undefined
      || Number(context.worldMinutes || 0) - Number(agent.lastOpportunityCreatedWorldTime) >= 360)) {
    const proposal = deriveOpportunityProposal(agent);
    const proposalSkill = Object.keys(proposal.requirements.minSkills)[0];
    options.push({ id: `opportunity:propose:${proposal.type}`, action: 'opportunity_propose',
      targetLocation: agent.location, goal: `Offer a small ${proposal.type.toLowerCase()} opportunity shaped by your experience.`,
      opportunityProposal: proposal, score: 21 + (goalSkill(primaryCategory(agent)) === proposalSkill ? 10 : 0)
        + Number(agent.skills?.[proposalSkill] || 0) * 0.12 + relevance(agent, 'project', context) });
  }

  for (const opportunity of context.opportunities || []) {
    if (!opportunityMemberships.has(opportunity.id)) {
      const accepted = Number(opportunity.acceptedCount) || 0;
      const fits = opportunityFit(opportunity, agent);
      if (fits && accepted < Number(opportunity.capacity || 1)) {
        const typeSkill = matchedSkill(opportunity.opportunity_type);
        const place = opportunity.sceneName || agent.location;
        options.push({ id: `opportunity:${opportunity.id}`, action: 'opportunity', targetLocation: place,
          goal: `Evaluate and take part in “${opportunity.title}” if it fits current priorities.`,
          description: opportunity.description, opportunityId: opportunity.id,
          opportunityType: opportunity.opportunity_type, score: 30 + (typeSkill === skill ? 16 : 0)
            + Number(agent.skills?.[typeSkill] || 0) * 0.12 + relevance(agent, 'project', context)
            + (Number(opportunity.confidence) || 0) * 2 });
      }
      options.push({ id: `opportunity:reject:${opportunity.id}`, action: 'opportunity_reject',
        targetLocation: agent.location, goal: `Decline ${opportunity.title} if its requirements or timing do not fit.`,
        opportunityId: opportunity.id, opportunityType: opportunity.opportunity_type,
        score: fits ? 7 + relevance(agent, 'project', context) * 0.1 : 24 + relevance(agent, 'project', context) * 0.15 });
    }
  }

  const proposal = deriveProjectProposal(agent, context);
  if (energy >= 35 && food >= 20 && activeProjects.length < 1 && (agent.activeProjectsCreated || 0) < 2) {
    const requiredSkill = Object.keys(proposal.requiredSkills)[0];
    const alreadyExists = (context.projects || []).some((project) => project.status === 'recruiting'
      && project.creator_agent_id === agent.agentId && project.project_type === proposal.projectType);
    if (!alreadyExists) options.push({ id: `project:propose:${proposal.projectType}`, action: 'project_propose',
      targetLocation: agent.location, goal: proposal.goal, description: proposal.description,
      projectProposal: proposal, score: 26 + (skill === requiredSkill ? 18 : 0)
        + Number(agent.skills?.[requiredSkill] || 0) * 0.2 + (context.projectOpportunity ? 8 : 0)
        + relevance(agent, 'project', context) + (proposal.metadata.createPlace ? 5 : 0) });
  }

  for (const project of context.projects || []) {
    if (['recruiting','proposed'].includes(project.status) && !projectMemberships.has(project.id)) {
      const typeSkill = matchedSkill(project.project_type);
      const relation = (agent.relationships || []).find((item) => item.otherAgentId === project.creator_agent_id);
      const fits = projectFit(project, agent);
      const hasRoom = Number(project.participantCount || 0) < Number(project.capacity || 4);
      if (fits && hasRoom) options.push({ id: `project:join:${project.id}`, action: 'project_join', targetLocation: agent.location,
          goal: `Decide whether to join ${project.title} based on its purpose and your current goals.`,
          projectId: project.id, decision: 'accept', score: 28 + (typeSkill === skill ? 18 : 0)
            + Number(agent.skills?.[typeSkill] || 0) * 0.15 + relationshipValue(relation) * 0.16
            + relevance(agent, 'project', context) });
      options.push({ id: `project:reject:${project.id}`, action: 'project_reject', targetLocation: agent.location,
        goal: `Consider declining ${project.title} if its timing or purpose does not fit your plans.`,
        projectId: project.id, decision: 'reject', score: (fits && hasRoom ? 5 : 24)
          + (typeSkill === skill ? 0 : 8) + (Number(agent.energy) < 35 || Number(agent.food) < 20 ? 10 : 0)
          + (Number(relation?.trust) < 0 ? 6 : 0) });
    }
  }

  for (const project of activeProjects) {
    const typeSkill = matchedSkill(project.project_type);
    options.push({ id: `project:contribute:${project.id}`, action: 'project_contribute',
      targetLocation: project.sceneName || agent.location, goal: `Contribute useful ${typeSkill} effort to ${project.title}.`,
      projectId: project.id, contributionType: typeSkill === 'research' ? 'research'
        : typeSkill === 'trading' ? 'planning' : typeSkill === 'social' ? 'planning' : 'work',
      score: 35 + (typeSkill === skill ? 18 : 0) + Number(agent.skills?.[typeSkill] || 0) * 0.16
        + relevance(agent, 'project', context) + Number(project.progress || 0) * 0.04 });
    if (Number(project.deadline_world_time) - Number(context.worldMinutes || 0) < 120
      && Number(project.progress) < 10) options.push({ id: `project:leave:${project.id}`, action: 'project_leave',
      targetLocation: agent.location, goal: `Reconsider whether ${project.title} still deserves your effort.`,
      projectId: project.id, score: 12 + (skill !== typeSkill ? 10 : 0) });
  }

  for (const invitation of agent.projectInvitations || []) {
    if (projectFit(invitation, agent)) options.push({ id: `project:invitation:${invitation.id}`, action: 'project_join',
      targetLocation: agent.location, goal: `Decide whether to join the invitation for ${invitation.title}.`,
      projectId: invitation.id, score: 32 + relevance(agent, 'project', context) });
  }

  for (const organization of agent.organizationInvitations || []) {
    const inviter = (agent.relationships || []).find((item) => item.otherAgentId === organization.inviterAgentId);
    options.push({ id: `organization:join:${organization.id}`, action: 'organization_join',
      targetLocation: agent.location, goal: `Consider joining ${organization.name} based on its purpose and the inviter you know.`,
      organizationId: organization.id, decision: 'accept', score: 22 + relationshipValue(inviter) * 0.2
        + relevance(agent, 'organization', context) + (organization.status === 'active' ? 3 : 0) });
    options.push({ id: `organization:reject:${organization.id}`, action: 'organization_reject',
      targetLocation: agent.location, goal: `Decide whether ${organization.name} is not a good fit for you right now.`,
      organizationId: organization.id, decision: 'reject', score: 12 + (Number(inviter?.trust) < 0 ? 8 : 0)
        + (Number(organization.reputation) < -2 ? 8 : 0) });
  }

  if (organizationMemberships.some((organization) => organization.memberStatus === 'active')) {
    for (const organization of organizationMemberships.filter((item) => item.memberStatus === 'active')) {
      options.push({ id: `organization:contribute:${organization.id}`, action: 'organization_contribute',
        targetLocation: agent.location, goal: `Contribute time and skill effort to ${organization.name}.`,
        organizationId: organization.id, contributionType: 'effort', score: 22 + relevance(agent, 'organization', context)
          + Math.min(8, Number(organization.reputation) / 10) });
      if (Number(agent.usdc || agent.usdcBalance || 0) >= 150 && Number(organization.cashBalance || 0) < 500) {
        options.push({ id: `organization:capital:${organization.id}:${Math.floor(Number(context.worldMinutes || 0) / 360)}`,
          action: 'organization_contribute', targetLocation: agent.location,
          goal: `Contribute a small amount of your own simulated USDC to ${organization.name}'s treasury for shared economic projects.`,
          organizationId: organization.id, contributionType: 'capital', contributionAmountUsdc: '25.00000000',
          score: 18 + Math.max(0, 500 - Number(organization.cashBalance || 0)) / 40
            + relevance(agent, 'organization', context) });
      }
      if (organization.projectOpenings?.length) {
        for (const project of organization.projectOpenings) {
          if (!projectMemberships.has(project.id) && projectFit(project, agent)) options.push({
            id: `project:org-join:${project.id}`, action: 'project_join', targetLocation: agent.location,
            goal: `Join the organization project ${project.title} if it fits your skills.`, projectId: project.id,
            score: 34 + relevance(agent, 'project', context) + Number(agent.skills?.[matchedSkill(project.project_type)] || 0) * 0.12
          });
        }
      }
      if (activeProjects.length < 1 && organization.status === 'active') {
        options.push({ id: `project:org-propose:${organization.id}:${proposal.projectType}`, action: 'project_propose',
          targetLocation: agent.location, goal: proposal.goal, description: proposal.description,
          organizationId: organization.id, projectProposal: proposal,
          score: 32 + relevance(agent, 'project', context) + (Number(organization.resources?.effort) >= 10 ? 5 : 0) });
      }
      const invitee = (agent.relationships || []).filter((relation) => Number(relation.trust) >= 2
        && Number(relation.familiarity) >= 10 && relation.otherAgentId !== agent.agentId
        && !organization.memberIds?.includes(relation.otherAgentId))
        .sort((left, right) => Number(right.trust) - Number(left.trust)
          || Number(right.familiarity) - Number(left.familiarity))[0];
      if (invitee) options.push({ id: `organization:invite:${organization.id}:${invitee.otherAgentId}`,
        action: 'organization_invite', targetLocation: agent.location,
        goal: `Invite ${invitee.name} to consider contributing to ${organization.name}.`,
        organizationId: organization.id, inviteeAgentId: invitee.otherAgentId,
        score: 18 + Number(invitee.trust) * 0.3 + Number(invitee.familiarity) * 0.12
          + relevance(agent, 'organization', context) });
      if (organization.memberIds?.length > 1) {
        options.push({ id: `organization:leave:${organization.id}`, action: 'organization_leave',
          targetLocation: agent.location, goal: `Reconsider your ongoing role in ${organization.name}.`,
          organizationId: organization.id, decision: 'leave', score: 5
            + (Number(organization.reputation) < -2 ? 12 : 0) + (activeProjects.length ? -8 : 0) });
      }
    }
  }

  for (const partner of context.organizationPartners || []) {
    const partnerId = partner.partnerId || partner.agentId;
    const alreadyShared = (agent.organizationMemberships || []).some((organization) =>
      organization.memberIds?.includes(partnerId) && organization.status !== 'dissolved');
    if (!alreadyShared && Number(partner.sharedProjectCount || 0) >= 1
        && Number(partner.trust) >= 5 && Number(partner.familiarity) >= 25) {
      const safeName = partner.projectTitle || 'Shared Work';
      options.push({ id: `organization:found:${partnerId}:${partner.projectId}`, action: 'organization_found',
        targetLocation: agent.location, goal: `Consider making a lasting group with ${partner.name} after shared work.`,
        organizationProposal: { inviteAgentId: partnerId, projectId: partner.projectId,
          name: `${safeName.slice(0, 48)} Collective`,
          purpose: `Continue cooperating on the shared goal: ${partner.projectGoal || 'useful work for the world'}.`,
          sharedProjectCount: Number(partner.sharedProjectCount), partnerGoal: partner.partnerGoal },
        score: 27 + Number(partner.trust) * 0.45 + Number(partner.familiarity) * 0.18 + relevance(agent, 'organization', context) });
    }
  }

  const lastStagnationReview = Math.max(0, ...((agent.goals || []).filter((item) => item.source === 'stagnation')
    .map((item) => Number(item.updatedWorldMinutes ?? item.updated_world_minutes) || 0)));
  if (context.goalStagnation?.stagnant
      && (agent.goals || []).filter((item) => item.goalType === 'short' && item.status === 'active').length < 3
      && Number(context.worldMinutes || 0) - lastStagnationReview >= 720) {
    const need = (context.worldNeeds || []).filter((item) => !item.agentId || item.agentId === agent.agentId)
      .sort((left, right) => Number(right.severity || 0) - Number(left.severity || 0))[0];
    const skillChoice = Object.entries(agent.skills || {}).sort((left, right) => Number(right[1]) - Number(left[1]))[0]?.[0] || skill || 'research';
    const proposal = need?.type === 'scene_congestion'
      ? { category: 'BUILD_ALTERNATIVE_PLACE', description: `Replan the stalled goal around capacity needs at ${need.sceneName}.` }
      : need?.type === 'trusted_partner_without_shared_work' || need?.type === 'unused_complementary_skills'
        ? { category: 'START_SHARED_PROJECT', description: 'Replan the stalled goal around a useful project with a trusted, complementary resident.' }
        : { category: `PRACTICE_${skillChoice.toUpperCase()}`, description: `Replan the stalled goal through a concrete ${skillChoice} subgoal.` };
    options.push({ id: `goal:review:${agent.agentId}:${Math.floor(Number(context.worldMinutes || 0) / 720)}`,
      action: 'goal_review', targetLocation: agent.location,
      goal: 'Review a long-stalled goal and add a concrete next step without discarding the resident’s long-term aim.',
      goalReviewProposal: proposal,
      score: 30 + Math.min(14, Number(context.goalStagnation.stagnantMinutes || 0) / 120)
        + Number(agent.discipline || 0.5) * 7 + Number(agent.curiosity || 0.5) * 6
        + relevance(agent, 'project', context) });
  }

  const share = context.shareProposal;
  if (share?.recipientAgentId) options.push({ id: `information:share:${share.recipientAgentId}:${share.subjectKey}`,
    action: 'information_share', targetLocation: agent.location,
    goal: `Decide whether sharing a personal observation would help ${share.recipientName}.`,
    informationProposal: share, score: 16 + Number(share.trust || 0) * 0.3
      + Number(share.familiarity || 0) * 0.12 + relevance(agent, 'information', context) });

  for (const message of agent.informationInbox || []) {
    const relation = (agent.relationships || []).find((item) => item.otherAgentId === message.senderAgentId);
    const trust = Number(relation?.trust) || 0;
    const confidence = Number(message.confidence) || 0;
    const alignment = message.informationType === 'project' && skill === goalSkill(message.claim?.type) ? 8
      : message.informationType === 'opportunity' && message.claim?.status === 'open' ? 5 : 0;
    options.push({ id: `information:accept:${message.id}`, action: 'information_accept', targetLocation: agent.location,
      goal: `Evaluate information from ${message.senderName}; accepting updates only your personal belief.`,
      shareId: message.id, score: 14 + trust * 0.34 + confidence * 18 + alignment + relevance(agent, 'information', context) });
    options.push({ id: `information:ignore:${message.id}`, action: 'information_ignore', targetLocation: agent.location,
      goal: 'Leave this information unadopted for now.', shareId: message.id,
      score: 9 + (trust < 0 ? Math.abs(trust) * 0.18 : 0) + (confidence < 0.35 ? 5 : 0) });
    options.push({ id: `information:doubt:${message.id}`, action: 'information_doubt', targetLocation: agent.location,
      goal: 'Record that this information seems uncertain to you.', shareId: message.id,
      score: 8 + (trust < 10 ? 12 : 0) + (confidence < 0.45 ? 8 : 0)
        + clamp(agent.discipline || 0.5, 0, 1) * 5 - trust * 0.12 });
  }

  return options;
}

export function environmentOpportunityIdeas({ residents = [], scenes = [], worldMinutes = 0, projects = [], opportunities = [] } = {}) {
  const result = [];
  const activeProjects = new Set(projects.filter((project) => ['recruiting','proposed','active'].includes(project.status))
    .map((project) => project.project_type));
  const researchDemand = residents.filter((resident) => goalSkill(primaryCategory(resident)) === 'research').length;
  const researchSupply = projects.filter((project) => ['proposed','recruiting','active'].includes(project.status)
    && ['RESEARCH','LEARNING'].includes(project.project_type)).length
    + opportunities.filter((item) => ['open','active'].includes(item.status)
      && ['RESEARCH','LEARNING'].includes(item.opportunity_type)).length;
  const researchShortage = researchDemand >= 2 && researchSupply < researchDemand;
  const incomeDemand = residents.filter((resident) => Number(resident.usdc || 0) < 100).length;
  const incomeSupply = opportunities.filter((item) => ['open','active'].includes(item.status)
    && ['WORK','INCOME'].includes(item.opportunity_type)).length;
  const incomeShortage = incomeDemand >= 2 && incomeSupply < incomeDemand;
  for (const scene of scenes.filter((item) => item.status === 'active')) {
    const visitors = residents.filter((resident) => resident.location === scene.name).length;
    const congestion = visitors / Math.max(1, Number(scene.capacity || 8));
    if (scene.sceneType === 'library' && researchShortage && !activeProjects.has('RESEARCH')
        && !activeProjects.has('LEARNING')) result.push({
      type: 'RESEARCH', sourceType: 'place', sceneId: scene.id, sourceKey: `${scene.id}:${Math.floor(worldMinutes / 240)}`,
      dedupeKey: `environment:research:${scene.id}:${Math.floor(worldMinutes / 240)}`,
      title: `Investigate a question at ${scene.name}`,
      description: 'Compare resident knowledge and produce a small, useful finding for the world.',
      requirements: { minSkills: { research: 5 }, minEnergy: 10, minFood: 5 }, capacity: 2,
      reward: { skill: 'research', skillGain: 1.5, goalProgress: 3 }, risk: { effort: 'moderate' },
      expiresWorldTime: worldMinutes + 180, metadata: { needReason: 'research_capacity_shortage',
        researchDemand, researchSupply }
    });
    if (scene.sceneType === 'workshop' && incomeShortage) result.push({
      type: 'WORK', sourceType: 'environment', sceneId: scene.id,
      sourceKey: `${scene.id}:${Math.floor(worldMinutes / 240)}:income`,
      dedupeKey: `environment:income:${scene.id}:${Math.floor(worldMinutes / 240)}`,
      title: `Find useful paid work near ${scene.name}`,
      description: 'Residents with low simulated balances have limited income opportunities; identify a bounded useful shift.',
      requirements: { minEnergy: 15, minFood: 8 }, capacity: Math.min(4, Math.max(2, incomeDemand)),
      reward: { effortCredit: 1 }, risk: { effort: 'low' }, expiresWorldTime: worldMinutes + 180,
      metadata: { needReason: 'income_opportunity_shortage', incomeDemand, incomeSupply }
    });
    if (congestion >= 0.75 && scene.capacity) result.push({
      type: scene.sceneType === 'cafe' || scene.sceneType === 'commons' ? 'SOCIAL' : 'BUILD',
      sourceType: 'place', sceneId: scene.id, sourceKey: `${scene.id}:${Math.floor(worldMinutes / 240)}:crowding`,
      dedupeKey: `environment:crowding:${scene.id}:${Math.floor(worldMinutes / 240)}`,
      title: `Find room around ${scene.name}`,
      description: `Residents often gather at ${scene.name}; explore an alternative arrangement that fits the community.`,
      requirements: { minSkills: { ...(scene.sceneType === 'workshop' ? { engineering: 4 } : { social: 4 }) } },
      capacity: 3, reward: { effortCredit: 2, goalProgress: 2 }, risk: { congestion, notHardCapacity: true },
      expiresWorldTime: worldMinutes + 240
    });
  }
  return result;
}

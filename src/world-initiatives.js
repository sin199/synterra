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
  const createPlace = Boolean(type === 'BUILD' && crowded && crowded.congestion >= 0.75);
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
    metadata: { createPlace, placeType: sceneType,
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
  return (match ? 12 : 0) + memoryBoost + clamp(context.ambition || agent.ambition || 0, 0, 1) * 6;
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
        + Number(agent.skills?.[proposalSkill] || 0) * 0.12 + relevance(agent, 'project') });
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
            + Number(agent.skills?.[typeSkill] || 0) * 0.12 + relevance(agent, 'project')
            + (Number(opportunity.confidence) || 0) * 2 });
      }
      options.push({ id: `opportunity:reject:${opportunity.id}`, action: 'opportunity_reject',
        targetLocation: agent.location, goal: `Decline ${opportunity.title} if its requirements or timing do not fit.`,
        opportunityId: opportunity.id, opportunityType: opportunity.opportunity_type,
        score: fits ? 7 + relevance(agent, 'project') * 0.1 : 24 + relevance(agent, 'project') * 0.15 });
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
        + relevance(agent, 'project') + (proposal.metadata.createPlace ? 5 : 0) });
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
            + relevance(agent, 'project') });
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
        + relevance(agent, 'project') + Number(project.progress || 0) * 0.04 });
    if (Number(project.deadline_world_time) - Number(context.worldMinutes || 0) < 120
      && Number(project.progress) < 10) options.push({ id: `project:leave:${project.id}`, action: 'project_leave',
      targetLocation: agent.location, goal: `Reconsider whether ${project.title} still deserves your effort.`,
      projectId: project.id, score: 12 + (skill !== typeSkill ? 10 : 0) });
  }

  for (const invitation of agent.projectInvitations || []) {
    if (projectFit(invitation, agent)) options.push({ id: `project:invitation:${invitation.id}`, action: 'project_join',
      targetLocation: agent.location, goal: `Decide whether to join the invitation for ${invitation.title}.`,
      projectId: invitation.id, score: 32 + relevance(agent, 'project') });
  }

  for (const organization of agent.organizationInvitations || []) {
    const inviter = (agent.relationships || []).find((item) => item.otherAgentId === organization.inviterAgentId);
    options.push({ id: `organization:join:${organization.id}`, action: 'organization_join',
      targetLocation: agent.location, goal: `Consider joining ${organization.name} based on its purpose and the inviter you know.`,
      organizationId: organization.id, decision: 'accept', score: 22 + relationshipValue(inviter) * 0.2
        + relevance(agent, 'organization') + (organization.status === 'active' ? 3 : 0) });
    options.push({ id: `organization:reject:${organization.id}`, action: 'organization_reject',
      targetLocation: agent.location, goal: `Decide whether ${organization.name} is not a good fit for you right now.`,
      organizationId: organization.id, decision: 'reject', score: 12 + (Number(inviter?.trust) < 0 ? 8 : 0)
        + (Number(organization.reputation) < -2 ? 8 : 0) });
  }

  if (organizationMemberships.some((organization) => organization.memberStatus === 'active')) {
    for (const organization of organizationMemberships.filter((item) => item.memberStatus === 'active')) {
      options.push({ id: `organization:contribute:${organization.id}`, action: 'organization_contribute',
        targetLocation: agent.location, goal: `Contribute time and skill effort to ${organization.name}.`,
        organizationId: organization.id, score: 22 + relevance(agent, 'organization')
          + Math.min(8, Number(organization.reputation) / 10) });
      if (organization.projectOpenings?.length) {
        for (const project of organization.projectOpenings) {
          if (!projectMemberships.has(project.id) && projectFit(project, agent)) options.push({
            id: `project:org-join:${project.id}`, action: 'project_join', targetLocation: agent.location,
            goal: `Join the organization project ${project.title} if it fits your skills.`, projectId: project.id,
            score: 34 + relevance(agent, 'project') + Number(agent.skills?.[matchedSkill(project.project_type)] || 0) * 0.12
          });
        }
      }
      if (activeProjects.length < 1 && organization.status === 'active') {
        options.push({ id: `project:org-propose:${organization.id}:${proposal.projectType}`, action: 'project_propose',
          targetLocation: agent.location, goal: proposal.goal, description: proposal.description,
          organizationId: organization.id, projectProposal: proposal,
          score: 32 + relevance(agent, 'project') + (Number(organization.resources?.effort) >= 10 ? 5 : 0) });
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
          + relevance(agent, 'organization') });
      if (organization.memberIds?.length > 1) {
        options.push({ id: `organization:leave:${organization.id}`, action: 'organization_leave',
          targetLocation: agent.location, goal: `Reconsider your ongoing role in ${organization.name}.`,
          organizationId: organization.id, decision: 'leave', score: 5
            + (Number(organization.reputation) < -2 ? 12 : 0) + (activeProjects.length ? -8 : 0) });
      }
    }
  }

  for (const partner of context.organizationPartners || []) {
    const alreadyShared = (agent.organizationMemberships || []).some((organization) =>
      organization.memberIds?.includes(partner.agentId) && organization.status !== 'dissolved');
    if (!alreadyShared && Number(partner.trust) >= 5 && Number(partner.familiarity) >= 25) {
      const safeName = partner.projectTitle || 'Shared Work';
      options.push({ id: `organization:found:${partner.agentId}:${partner.projectId}`, action: 'organization_found',
        targetLocation: agent.location, goal: `Consider making a lasting group with ${partner.name} after shared work.`,
        organizationProposal: { inviteAgentId: partner.agentId, projectId: partner.projectId,
          name: `${safeName.slice(0, 48)} Collective`,
          purpose: `Continue cooperating on the shared goal: ${partner.projectGoal || 'useful work for the world'}.` },
        score: 27 + Number(partner.trust) * 0.45 + Number(partner.familiarity) * 0.18 + relevance(agent, 'organization') });
    }
  }

  const share = context.shareProposal;
  if (share?.recipientAgentId) options.push({ id: `information:share:${share.recipientAgentId}:${share.subjectKey}`,
    action: 'information_share', targetLocation: agent.location,
    goal: `Decide whether sharing a personal observation would help ${share.recipientName}.`,
    informationProposal: share, score: 16 + Number(share.trust || 0) * 0.3
      + Number(share.familiarity || 0) * 0.12 + relevance(agent, 'information') });

  for (const message of agent.informationInbox || []) {
    const relation = (agent.relationships || []).find((item) => item.otherAgentId === message.senderAgentId);
    const trust = Number(relation?.trust) || 0;
    const confidence = Number(message.confidence) || 0;
    const alignment = message.informationType === 'project' && skill === goalSkill(message.claim?.type) ? 8
      : message.informationType === 'opportunity' && message.claim?.status === 'open' ? 5 : 0;
    options.push({ id: `information:accept:${message.id}`, action: 'information_accept', targetLocation: agent.location,
      goal: `Evaluate information from ${message.senderName}; accepting updates only your personal belief.`,
      shareId: message.id, score: 14 + trust * 0.34 + confidence * 18 + alignment + relevance(agent, 'information') });
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

export function environmentOpportunityIdeas({ residents = [], scenes = [], worldMinutes = 0, projects = [] } = {}) {
  const result = [];
  const activeProjects = new Set(projects.filter((project) => ['recruiting','proposed','active'].includes(project.status))
    .map((project) => project.project_type));
  for (const scene of scenes.filter((item) => item.status === 'active')) {
    const visitors = residents.filter((resident) => resident.location === scene.name).length;
    const congestion = visitors / Math.max(1, Number(scene.capacity || 8));
    if (scene.sceneType === 'library' && !activeProjects.has('RESEARCH')) result.push({
      type: 'RESEARCH', sourceType: 'place', sceneId: scene.id, sourceKey: `${scene.id}:${Math.floor(worldMinutes / 240)}`,
      dedupeKey: `environment:research:${scene.id}:${Math.floor(worldMinutes / 240)}`,
      title: `Investigate a question at ${scene.name}`,
      description: 'Compare resident knowledge and produce a small, useful finding for the world.',
      requirements: { minSkills: { research: 5 }, minEnergy: 10, minFood: 5 }, capacity: 2,
      reward: { skill: 'research', skillGain: 1.5, goalProgress: 3 }, risk: { effort: 'moderate' },
      expiresWorldTime: worldMinutes + 180
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

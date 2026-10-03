import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { fruitflyFamily, qualifyUtilityCandidates, UTILITY_CANDIDATE_POLICY } from '../src/social-world.js';
import { createFruitflyRuntime } from '../src/agent-runtime/fruitfly.js';
import { buildActivityCandidates } from '../src/world-engine.js';
import { createWorldOpportunity, decideWorldOpportunity, completeOpportunityParticipation,
  expireWorldOpportunities, opportunityFit } from '../src/world-opportunities.js';
import { deriveProjectProposal, deriveOpportunityProposal, buildWorldInitiativeCandidates } from '../src/world-initiatives.js';
import { createProjectPlace, generatedPlaceName } from '../src/world-places.js';
import { proposeWorldProject, decideProjectMembership, contributeToProject, failWorldProject } from '../src/world-projects.js';
import { foundWorldOrganization, inviteWorldOrganization, decideOrganizationMembership,
  contributeOrganizationEffort } from '../src/world-organizations.js';
import { shareWorldInformation, decideWorldInformationShare } from '../src/world-information.js';

const databaseUrl = process.env.SYNTERRA_TEST_DATABASE_URL;
const testEnabled = process.env.SYNTERRA_TEST_ISOLATED === '1' && Boolean(databaseUrl);
const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function assertIsolatedTestDatabase(connectionString) {
  const parsed = new URL(connectionString);
  assert.ok(['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname), 'V3 integration tests require loopback PostgreSQL');
  assert.ok(decodeURIComponent(parsed.pathname.slice(1)).endsWith('_test'), 'V3 integration tests require a _test database');
}

async function transaction(pool, callback) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

test('utility qualification uses fixed threshold and top-K while preserving multiple candidates', () => {
  const candidates = [100, 96, 81, 75, 74, 50, 10, 1, -2]
    .map((score, index) => ({ id: `candidate-${index}`, action: `action-${index}`, score }));
  const qualified = qualifyUtilityCandidates(candidates);
  assert.deepEqual(qualified.map((item) => item.score), [100, 96, 81, 75]);
  assert.ok(qualified.length >= UTILITY_CANDIDATE_POLICY.minimum);
  assert.ok(qualified.length <= UTILITY_CANDIDATE_POLICY.maximum);
  assert.deepEqual(qualifyUtilityCandidates(candidates.slice(0, 2)), candidates.slice(0, 2));
});

test('utility qualification fills its minimum from the ranked candidates', () => {
  const candidates = [100, 20, 10, 0].map((score, index) => ({ id: String(index), score }));
  assert.deepEqual(qualifyUtilityCandidates(candidates).map((item) => item.score), [100, 20, 10]);
});

test('Fruitfly keeps its eight output families while learning from every V3 action family', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'synterra-fruitfly-v3-'));
  try {
    const fruitfly = await createFruitflyRuntime(directory);
    const observation = { self: { agentId: 'resident-v3', energy: 80, food: 70, social: 60 },
      mind: { archetype: 'scholar', traits: { curiosity: 0.8, craft: 0.6 }, memories: [], goals: [],
        relationships: [], personality: {} } };
    const actions = ['opportunity_propose', 'opportunity', 'opportunity_reject', 'project_propose',
      'project_join', 'project_reject', 'project_contribute', 'project_leave', 'organization_found',
      'organization_join', 'organization_reject', 'organization_leave', 'organization_invite',
      'organization_contribute', 'information_share', 'information_accept', 'information_ignore', 'information_doubt'];
    for (const [index, action] of actions.entries()) {
      const candidate = { id: `v3-choice-${index}`, action, score: 20 + index };
      const decision = fruitfly.choose('resident-v3', observation, [candidate], candidate);
      assert.equal(decision.candidate.id, candidate.id);
      await fruitfly.learn('resident-v3', observation, [candidate], decision.candidate,
        { energy: 80, food: 70, social: 60 });
    }
    assert.ok(fruitflyFamily('project_propose') === 'cooperate');
    assert.ok(fruitflyFamily('information_share') === 'socialize');
    assert.ok(fruitflyFamily('opportunity') === 'travel');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('opportunity requirements enforce needs, skills, and goal fit as hard eligibility', () => {
  const opportunity = { requirements: { minEnergy: 25, minFood: 10,
    minSkills: { research: 20 }, goalCategories: ['MASTER_RESEARCH'] } };
  const agent = { energy: 40, food: 50, skills: { research: 22 },
    goals: [{ category: 'MASTER_RESEARCH', status: 'active' }] };
  assert.equal(opportunityFit(opportunity, agent), true);
  assert.equal(opportunityFit(opportunity, { ...agent, energy: 24 }), false);
  assert.equal(opportunityFit(opportunity, { ...agent, skills: { research: 19 } }), false);
  assert.equal(opportunityFit(opportunity, { ...agent, goals: [] }), false);
});

test('initiative candidates reflect personal skills, relationships, and decisions', () => {
  const agent = { agentId: 'resident-a', location: 'Library', energy: 75, food: 68, ambition: 0.7,
    primaryGoal: 'MASTER_RESEARCH', skills: { research: 42, engineering: 17, trading: 11, social: 24 },
    goals: [{ goalType: 'primary', category: 'MASTER_RESEARCH', status: 'active', priority: 1 }],
    relationships: [{ otherAgentId: 'resident-b', familiarity: 35, trust: 11, affinity: 20 }],
    recentMemories: [{ memoryType: 'cooperation', worldMinutes: 90 }], projectMemberships: [],
    organizationMemberships: [], activeProjects: [], activeProjectsCreated: 0 };
  const proposal = deriveProjectProposal(agent, {});
  assert.equal(proposal.projectType, 'RESEARCH');
  const candidates = buildWorldInitiativeCandidates(agent, { worldMinutes: 100,
    opportunities: [{ id: 'op-a', opportunity_type: 'RESEARCH', title: 'Research a finding',
      description: 'Compare evidence from residents.', capacity: 2, acceptedCount: 0, requirements: {}, reward: {} }],
    projects: [{ id: 'project-a', project_type: 'RESEARCH', creator_agent_id: 'resident-b', status: 'recruiting',
      title: 'Study notes', capacity: 4, participantCount: 1, required_skills: { research: 10 }, metadata: {} }] });
  assert.ok(candidates.some((item) => item.action === 'opportunity' && item.opportunityId === 'op-a'));
  assert.ok(candidates.some((item) => item.action === 'opportunity_reject' && item.opportunityId === 'op-a'));
  assert.ok(candidates.some((item) => item.action === 'project_join' && item.projectId === 'project-a'));
  assert.ok(candidates.some((item) => item.action === 'project_reject' && item.projectId === 'project-a'));
  assert.ok(candidates.some((item) => item.action === 'project_propose'));
});

test('residents can autonomously propose bounded opportunities from personal skills and needs', () => {
  const resident = { agentId: 'resident-a', name: 'Resident A', location: 'Library', energy: 75, food: 70,
    primaryGoal: 'MASTER_RESEARCH', skills: { research: 42, engineering: 17, trading: 11, social: 24 },
    goals: [{ goalType: 'primary', category: 'MASTER_RESEARCH', status: 'active' }] };
  const proposal = deriveOpportunityProposal(resident);
  assert.equal(proposal.type, 'RESEARCH');
  assert.ok(proposal.capacity <= 2);
  assert.ok(proposal.expiresInWorldMinutes <= 360);
  assert.equal(proposal.reward.skill, 'research');
  assert.equal(proposal.reward.internalUnits, undefined);
  const candidate = buildWorldInitiativeCandidates(resident, { worldMinutes: 500, activeOpportunityCount: 4 })
    .find((item) => item.action === 'opportunity_propose');
  assert.ok(candidate);
  assert.equal(buildWorldInitiativeCandidates({ ...resident, energy: 20 }, { worldMinutes: 500 })
    .some((item) => item.action === 'opportunity_propose'), false);
  assert.equal(buildWorldInitiativeCandidates({ ...resident, activeOpportunitiesCreated: 1 }, { worldMinutes: 500 })
    .some((item) => item.action === 'opportunity_propose'), false);
  assert.equal(buildWorldInitiativeCandidates({ ...resident, lastOpportunityCreatedWorldTime: 400 }, { worldMinutes: 500 })
    .some((item) => item.action === 'opportunity_propose'), false);
});

test('place fallback names are deterministic but vary by project and ordinal', () => {
  const project = { id: 'project-a', projectType: 'RESEARCH' };
  assert.equal(generatedPlaceName(project), generatedPlaceName(project));
  assert.notEqual(generatedPlaceName(project, 0), generatedPlaceName(project, 1));
});

test('isolated V3 lifecycles settle cooperatively and persist across database reconnects', {
  skip: !testEnabled,
  timeout: 120_000
}, async (t) => {
  assertIsolatedTestDatabase(databaseUrl);
  let pool = new Pool({ connectionString: databaseUrl, max: 4 });
  const worldId = randomUUID();
  const agentIds = [randomUUID(), randomUUID(), randomUUID()];
  const [founderId, partnerId, thirdId] = agentIds;
  try {
    const schema = await readFile(path.join(repoRoot, 'schema.sql'), 'utf8');
    await pool.query(schema);
    await pool.query(schema);
    await pool.query(`INSERT INTO agents(id,name,public_key,gender) VALUES
      ($1,'V3 Founder',$2,'female'),($3,'V3 Partner',$4,'male'),($5,'V3 Resident',$6,'female')`,
    [founderId, `v3-key-${founderId}`, partnerId, `v3-key-${partnerId}`, thirdId, `v3-key-${thirdId}`]);
    await pool.query(`INSERT INTO worlds(id,owner_agent_id,name,chain_id,open) VALUES($1,$2,'V3 Isolated Test',5042,true)`,
      [worldId, founderId]);
    await pool.query(`INSERT INTO world_members(world_id,agent_id,location,energy,food,social)
      VALUES($1,$2,'Library',90,90,80),($1,$3,'Workshop',85,80,75),($1,$4,'Library',30,60,65)`,
    [worldId, founderId, partnerId, thirdId]);
    const [left, right] = [founderId, partnerId].sort();
    await pool.query(`INSERT INTO world_relationships(world_id,agent_a_id,agent_b_id,familiarity,trust,affinity,interaction_count)
      VALUES($1,$2,$3,40,20,30,5)`, [worldId, left, right]);
    await pool.query(`INSERT INTO world_scenes(world_id,created_by,name,scene_type,description)
      VALUES($1,$2,'Library','library','A quiet place for careful research.'),
        ($1,$2,'Workshop','workshop','A shared place to make useful things.')`, [worldId, founderId]);

    const infeasible = await transaction(pool, (client) => createWorldOpportunity(client, { worldId,
      type: 'BUILD', sourceType: 'environment', title: 'Build a larger observatory',
      description: 'Review the needs before taking on this construction task.', requirements: { minEnergy: 80,
        minSkills: { engineering: 99 } }, capacity: 1, worldTime: 10, expiresWorldTime: 100,
      dedupeKey: 'v3:test:infeasible' }));
    const residentFacts = { agentId: thirdId, location: 'Library', energy: 30, food: 60,
      skills: { engineering: 10 }, goals: [] };
    const rejectionCandidates = buildWorldInitiativeCandidates(residentFacts, {
      opportunities: [{ id: infeasible.id, opportunity_type: 'BUILD', title: 'Build a larger observatory',
        description: 'Review the needs before taking on this construction task.', capacity: 1, requirements: {
          minEnergy: 80, minSkills: { engineering: 99 } } }], projects: [] });
    assert.ok(rejectionCandidates.some((item) => item.action === 'opportunity_reject'));
    assert.ok(!rejectionCandidates.some((item) => item.action === 'opportunity'),
      'a resident without enough energy and skill cannot accept the opportunity');
    const rejected = await transaction(pool, (client) => decideWorldOpportunity(client, { worldId,
      opportunityId: infeasible.id, agentId: thirdId, decision: 'reject', actionId: 'v3-reject-op-001', worldTime: 11,
      agent: residentFacts }));
    assert.equal(rejected.status, 'rejected');
    const rejectedRetry = await transaction(pool, (client) => decideWorldOpportunity(client, { worldId,
      opportunityId: infeasible.id, agentId: thirdId, decision: 'reject', actionId: 'v3-reject-op-001', worldTime: 11,
      agent: residentFacts }));
    assert.equal(rejectedRetry.idempotent, true);

    const library = await pool.query("SELECT id FROM world_scenes WHERE world_id=$1 AND name='Library'", [worldId]);
    const acceptedOpportunity = await transaction(pool, (client) => createWorldOpportunity(client, { worldId,
      type: 'RESEARCH', sourceType: 'place', sceneId: library.rows[0].id,
      title: 'Compare local research notes', description: 'Compare evidence and write a concise finding for residents.',
      requirements: { minEnergy: 10, minSkills: { research: 5 } }, capacity: 1, worldTime: 20,
      reward: { skill: 'research', skillGain: 1.5 },
      expiresWorldTime: 80, dedupeKey: 'v3:test:accepted' }));
    const partnerFacts = { agentId: partnerId, location: 'Library', energy: 85, food: 80,
      skills: { research: 30, engineering: 50 }, goals: [{ category: 'MASTER_RESEARCH', status: 'active' }] };
    const accepted = await transaction(pool, (client) => decideWorldOpportunity(client, { worldId,
      opportunityId: acceptedOpportunity.id, agentId: partnerId, decision: 'accept', actionId: 'v3-accept-op-001',
      worldTime: 21, agent: partnerFacts }));
    assert.equal(accepted.status, 'accepted');
    const completion = await transaction(pool, (client) => completeOpportunityParticipation(client, { worldId,
      opportunityId: acceptedOpportunity.id, agentId: partnerId, worldTime: 22, succeeded: true,
      outcome: { test: 'accepted' } }));
    assert.equal(completion.status, 'completed');
    assert.equal(completion.rewardApplied.skill, 'research');
    assert.equal(Number((await pool.query(`SELECT skill_value FROM world_agent_skills
      WHERE world_id=$1 AND agent_id=$2 AND skill_name='research'`, [worldId, partnerId])).rows[0].skill_value), 1.5);
    assert.equal((await transaction(pool, (client) => completeOpportunityParticipation(client, { worldId,
      opportunityId: acceptedOpportunity.id, agentId: partnerId, worldTime: 23, succeeded: true }))).completed, false);

    const expiring = await transaction(pool, (client) => createWorldOpportunity(client, { worldId,
      type: 'LEARNING', title: 'Read a short field note', description: 'Check one concise note before its expiration.',
      worldTime: 30, expiresWorldTime: 31, dedupeKey: 'v3:test:expiring' }));
    await transaction(pool, (client) => decideWorldOpportunity(client, { worldId, opportunityId: expiring.id,
      agentId: thirdId, decision: 'accept', actionId: 'v3-accept-exp-01', worldTime: 30,
      agent: { ...residentFacts, energy: 50, food: 50 } }));
    assert.equal((await transaction(pool, (client) => expireWorldOpportunities(client, worldId, 31))).length, 1);
    const expiredParticipant = await pool.query(`SELECT status FROM world_opportunity_participants
      WHERE world_id=$1 AND opportunity_id=$2 AND agent_id=$3`, [worldId, expiring.id, thirdId]);
    assert.equal(expiredParticipant.rows[0].status, 'failed');

    const project = await transaction(pool, (client) => proposeWorldProject(client, { worldId, agentId: founderId,
      actionId: 'v3-project-create-001', projectType: 'BUILD', title: 'Community Research Annex',
      goal: 'Create a useful shared place for research.',
      description: 'Contributors will build a shared annex through several rounds of useful engineering work.',
      requiredSkills: { engineering: 10 }, requiredResources: { effortPoints: 12, maxParticipants: 3 },
      reward: { skill: 'engineering', skillGain: 2, relationship: 1 },
      metadata: { createPlace: true, placeType: 'library', placeName: 'Community Research Annex',
        placePurpose: 'A resident-built place for cooperative research and study.', placeCapacity: 12 }, worldTime: 40 }));
    assert.equal(project.status, 'recruiting');
    assert.equal((await transaction(pool, (client) => proposeWorldProject(client, { worldId, agentId: founderId,
      actionId: 'v3-project-create-001', projectType: 'BUILD', title: 'Community Research Annex',
      goal: 'Create a useful shared place for research.',
      description: 'Contributors will build a shared annex through several rounds of useful engineering work.',
      requiredResources: { effortPoints: 12, maxParticipants: 3 }, worldTime: 40 }))).idempotent, true);
    const projectFacts = { ...partnerFacts, goals: [] };
    const declinedProject = await transaction(pool, (client) => decideProjectMembership(client, { worldId,
      projectId: project.id, agentId: thirdId, decision: 'reject', actionId: 'v3-project-reject-01', worldTime: 41,
      agent: { ...residentFacts, goals: [] } }));
    assert.equal(declinedProject.status, 'rejected');
    const joinedProject = await transaction(pool, (client) => decideProjectMembership(client, { worldId,
      projectId: project.id, agentId: partnerId, decision: 'accept', actionId: 'v3-project-join-001', worldTime: 42,
      agent: projectFacts }));
    assert.equal(joinedProject.status, 'active');
    const firstContribution = await transaction(pool, (client) => contributeToProject(client, { worldId,
      projectId: project.id, agentId: partnerId, actionId: 'v3-project-work-001', worldTime: 43,
      contributionType: 'work', skillValue: 50, energy: 100 }));
    assert.equal(firstContribution.completed, false);
    const finalContribution = await transaction(pool, (client) => contributeToProject(client, { worldId,
      projectId: project.id, agentId: founderId, actionId: 'v3-project-work-002', worldTime: 44,
      contributionType: 'work', skillValue: 50, energy: 100 }));
    assert.equal(finalContribution.completed, true);
    assert.equal(finalContribution.project.status, 'completed');
    assert.equal(finalContribution.place.created, true);
    assert.equal(finalContribution.place.createdByProjectId, project.id);
    const repeatedContribution = await transaction(pool, (client) => contributeToProject(client, { worldId,
      projectId: project.id, agentId: founderId, actionId: 'v3-project-work-002', worldTime: 45,
      contributionType: 'work', skillValue: 50, energy: 100 }));
    assert.equal(repeatedContribution.idempotent, true);
    assert.equal(Number((await pool.query(`SELECT count(*)::int AS count FROM world_project_contributions
      WHERE world_id=$1 AND project_id=$2`, [worldId, project.id])).rows[0].count), 2);
    assert.equal(Number((await pool.query(`SELECT count(*)::int AS count FROM world_agent_skills
      WHERE world_id=$1 AND agent_id=ANY($2::uuid[]) AND skill_name='engineering' AND skill_value>=2`,
    [worldId, [founderId, partnerId]])).rows[0].count), 2, 'successful projects distribute their bounded skill reward');
    assert.equal(Number((await pool.query(`SELECT trust FROM world_relationships
      WHERE world_id=$1 AND agent_a_id=$2 AND agent_b_id=$3`, [worldId, left, right])).rows[0].trust), 21.2);
    const repeatedPlace = await transaction(pool, (client) => createProjectPlace(client, { worldId,
      project: finalContribution.project, worldTime: 45 }));
    assert.equal(repeatedPlace.created, false);
    assert.equal(Number((await pool.query(`SELECT count(*)::int AS count FROM world_scenes
      WHERE world_id=$1 AND created_by_project_id=$2`, [worldId, project.id])).rows[0].count), 1);
    assert.ok(finalContribution.place.position && Object.keys(finalContribution.place.position).length === 2);

    const organization = await transaction(pool, (client) => foundWorldOrganization(client, { worldId,
      founderAgentId: founderId, inviteAgentId: partnerId, projectId: project.id,
      actionId: 'v3-org-found-001', name: 'Research Collective',
      purpose: 'Continue collaborative research and maintain the new community annex.', worldTime: 50 }));
    assert.equal(organization.created, true);
    const rejectedInvite = await transaction(pool, (client) => decideOrganizationMembership(client, { worldId,
      organizationId: organization.id, agentId: partnerId, decision: 'reject', actionId: 'v3-org-reject-01', worldTime: 51 }));
    assert.equal(rejectedInvite.status, 'rejected');
    const reinvite = await transaction(pool, (client) => inviteWorldOrganization(client, { worldId,
      organizationId: organization.id, inviterAgentId: founderId, inviteeAgentId: partnerId,
      actionId: 'v3-org-invite-002', worldTime: 52 }));
    assert.equal(reinvite.status, 'invited');
    const joinedOrganization = await transaction(pool, (client) => decideOrganizationMembership(client, { worldId,
      organizationId: organization.id, agentId: partnerId, decision: 'accept', actionId: 'v3-org-accept-01', worldTime: 53 }));
    assert.equal(joinedOrganization.status, 'active');
    assert.equal(joinedOrganization.organizationStatus, 'active');
    const orgContribution = await transaction(pool, (client) => contributeOrganizationEffort(client, { worldId,
      organizationId: organization.id, agentId: partnerId, actionId: 'v3-org-effort-01', effort: 3, worldTime: 54 }));
    assert.equal(Number(orgContribution.effort), 3);
    assert.equal((await transaction(pool, (client) => contributeOrganizationEffort(client, { worldId,
      organizationId: organization.id, agentId: partnerId, actionId: 'v3-org-effort-01', effort: 3, worldTime: 55 }))).idempotent, true);

    const shared = await transaction(pool, (client) => shareWorldInformation(client, { worldId,
      senderAgentId: founderId, recipientAgentId: partnerId, informationType: 'project', subjectType: 'project',
      subjectKey: project.id, actionId: 'v3-share-project-01', worldTime: 60 }));
    const acceptedShare = await transaction(pool, (client) => decideWorldInformationShare(client, { worldId,
      shareId: shared.id, recipientAgentId: partnerId, decision: 'accept', actionId: 'v3-share-accept-01', worldTime: 61 }));
    assert.equal(acceptedShare.status, 'accepted');
    assert.equal((await transaction(pool, (client) => decideWorldInformationShare(client, { worldId,
      shareId: shared.id, recipientAgentId: partnerId, decision: 'accept', actionId: 'v3-share-accept-01', worldTime: 62 }))).idempotent, true);
    const personalBelief = await pool.query(`SELECT sample_count,estimate FROM world_agent_beliefs
      WHERE world_id=$1 AND agent_id=$2 AND subject_type='project' AND subject_key=$3 AND belief_key='shared_awareness'`,
    [worldId, partnerId, project.id]);
    assert.equal(personalBelief.rows[0].sample_count, 1);
    assert.equal(Number(personalBelief.rows[0].estimate), 1);

    const organizationProject = await transaction(pool, (client) => proposeWorldProject(client, { worldId,
      agentId: partnerId, organizationId: organization.id, actionId: 'v3-org-project-001', projectType: 'RESEARCH',
      title: 'Annex Study Notes', goal: 'Collect a useful local study.',
      description: 'Members compare observations and preserve the results for future residents.', worldTime: 70,
      requiredResources: { effortPoints: 20, maxParticipants: 3 } }));
    assert.ok(organizationProject.id, 'active organizations can carry their own projects');
    await transaction(pool, (client) => decideProjectMembership(client, { worldId, projectId: organizationProject.id,
      agentId: founderId, decision: 'accept', actionId: 'v3-org-project-join-1', worldTime: 71,
      agent: { ...residentFacts, goals: [] } }));
    const failedOnce = await transaction(pool, (client) => failWorldProject(client, { worldId,
      projectId: organizationProject.id, worldTime: 90, actorAgentId: partnerId, reason: 'test_failure' }));
    const failedTwice = await transaction(pool, (client) => failWorldProject(client, { worldId,
      projectId: organizationProject.id, worldTime: 91, actorAgentId: partnerId, reason: 'test_failure' }));
    assert.equal(failedOnce, true);
    assert.equal(failedTwice, false, 'project failure and consequences must settle once');
    assert.equal(Number((await pool.query(`SELECT count(*)::int AS count FROM world_history
      WHERE world_id=$1 AND event_key=$2`, [worldId, `project:${organizationProject.id}:failed`])).rows[0].count), 1);

    const beforeReconnect = await pool.query(`SELECT
        (SELECT count(*)::int FROM world_projects WHERE world_id=$1) AS projects,
        (SELECT count(*)::int FROM world_organizations WHERE world_id=$1) AS organizations,
        (SELECT count(*)::int FROM world_scenes WHERE world_id=$1 AND created_by_project_id IS NOT NULL) AS places,
        (SELECT count(*)::int FROM world_opportunities WHERE world_id=$1) AS opportunities`, [worldId]);
    await pool.end();
    pool = new Pool({ connectionString: databaseUrl, max: 2 });
    const afterReconnect = await pool.query(`SELECT
        (SELECT count(*)::int FROM world_projects WHERE world_id=$1) AS projects,
        (SELECT count(*)::int FROM world_organizations WHERE world_id=$1) AS organizations,
        (SELECT count(*)::int FROM world_scenes WHERE world_id=$1 AND created_by_project_id IS NOT NULL) AS places,
        (SELECT count(*)::int FROM world_opportunities WHERE world_id=$1) AS opportunities`, [worldId]);
    assert.deepEqual(afterReconnect.rows[0], beforeReconnect.rows[0], 'V3 world objects survive a process/database reconnect');
    assert.equal(Number(afterReconnect.rows[0].places), 1);
    t.diagnostic(JSON.stringify({ worldId, persisted: afterReconnect.rows[0], completedProject: project.id,
      createdPlace: finalContribution.place.name, organization: organization.name,
      acceptedOpportunity: acceptedOpportunity.id, failedProject: organizationProject.id }));
  } finally {
    if (pool) {
      await pool.query('DELETE FROM worlds WHERE id=$1', [worldId]);
      await pool.query('DELETE FROM agents WHERE id=ANY($1::uuid[])', [agentIds]);
      await pool.end();
    }
  }
});

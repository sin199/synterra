import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { Pool } from 'pg';
import { applyWorldSchemaAndMigrations } from '../src/database-migrations.js';
import { prepareStartupSchema } from '../src/startup-schema.js';
import { importResearchArtifact } from '../src/research/artifacts.js';
import { listResearchInputsByWorld, enqueueResearchCapabilityUse, RESEARCH_CAPABILITY_KEY } from '../src/research/research-jobs.js';
import { buildCapabilityUseCandidates, seedWorldCapabilityRegistry } from '../src/world-capabilities.js';

const databaseUrl = process.env.SYNTERRA_RESEARCH_TEST_DATABASE_URL;
const enabled = process.env.SYNTERRA_RESEARCH_TEST_ISOLATED === '1' && Boolean(databaseUrl);
const rootDirectory = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

async function inTransaction(pool, operation) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}

async function addGoal(pool, worldId, agentId, category, description) {
  return (await pool.query(`INSERT INTO world_agent_goals(world_id,agent_id,goal_type,category,description,source)
    VALUES($1,$2,'secondary',$3,$4,'seed') RETURNING id::text AS id`, [worldId, agentId, category, description])).rows[0].id;
}

async function addArtifact(pool, artifactDirectory, { worldId, key, grantAgentIds, relations = [] }) {
  return inTransaction(pool, (client) => importResearchArtifact(client, { worldId, grantAgentIds, relations,
    originReference: 'operator:isolated relation test fixture', artifactKey: key, displayName: `${key}.js`,
    targetType: 'javascript', mediaType: 'application/javascript', bytes: Buffer.from(`export const ${key.replaceAll('-', '_')} = 1;`),
    artifactDirectory }));
}

test('REA opportunities require matching artifact grants and live typed relation semantics', {
  skip: !enabled, timeout: 120_000
}, async () => {
  const parsed = new URL(databaseUrl);
  assert.ok(['localhost','127.0.0.1','::1'].includes(parsed.hostname));
  assert.ok(parsed.port && parsed.port !== '5432');
  assert.ok(decodeURIComponent(parsed.pathname.slice(1)).endsWith('_test'));
  const pool = new Pool({ connectionString: databaseUrl, max: 6, connectionTimeoutMillis: 3_000 });
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), 'synterra-rea-relations-'));
  const artifactDirectory = path.join(stateDirectory, 'artifacts');
  const worldId = randomUUID();
  const ownerId = randomUUID();
  const workerId = randomUUID();
  const outsiderId = randomUUID();
  try {
    await applyWorldSchemaAndMigrations(pool, { rootDirectory });
    assert.equal((await prepareStartupSchema(pool, { rootDirectory, mode: 'validate' })).validated, true);
    const schemaReplay = await applyWorldSchemaAndMigrations(pool, { rootDirectory });
    assert.deepEqual(schemaReplay.applied, [], 'schema and numbered migrations remain idempotent after 0005/0006 exist');
    assert.ok(schemaReplay.alreadyApplied.includes('0006_research_artifact_relations.sql'));
    assert.equal((await prepareStartupSchema(pool, { rootDirectory, mode: 'validate' })).validated, true);
    for (const [agentId, name] of [[ownerId,'Relation Owner'],[workerId,'Relation Worker'],[outsiderId,'Relation Outsider']]) {
      await pool.query('INSERT INTO agents(id,name,public_key) VALUES($1,$2,$3)', [agentId, name, `pk-${agentId}`]);
    }
    await pool.query(`INSERT INTO worlds(id,owner_agent_id,name,chain_id,open) VALUES($1,$2,'REA relation fixture',5042,true)`,
      [worldId, ownerId]);
    for (const [agentId, role] of [[ownerId,'owner'],[workerId,'resident'],[outsiderId,'resident']]) {
      await pool.query(`INSERT INTO world_members(world_id,agent_id,role,location) VALUES($1,$2,$3,'Garden')`,
        [worldId,agentId,role]);
    }
    const capabilityIds = await seedWorldCapabilityRegistry(pool, worldId);
    const capabilityId = capabilityIds.get(RESEARCH_CAPABILITY_KEY);
    const ownerGoal1 = await addGoal(pool, worldId, ownerId, 'RESEARCH_ONE', 'Research the first fixture goal.');
    const ownerGoal2 = await addGoal(pool, worldId, ownerId, 'RESEARCH_TWO', 'Research the second fixture goal.');
    const workerGoal = await addGoal(pool, worldId, workerId, 'RESEARCH_WORKER', 'Research the worker fixture goal.');

    const noRelation = await addArtifact(pool, artifactDirectory, { worldId, key: 'artifact-no-relation', grantAgentIds: [ownerId] });
    const unboundArtifact = await addArtifact(pool, artifactDirectory, { worldId, key: 'artifact-unbound', grantAgentIds: [ownerId] });
    await pool.query(`INSERT INTO world_research_artifact_relations(world_id,artifact_id,goal_id,provenance)
      VALUES($1,$2,$3,'operator_intake')`, [worldId,noRelation.id,workerGoal]);
    const mismatchCountBefore = (await pool.query('SELECT count(*)::int AS count FROM world_research_artifacts WHERE world_id=$1',
      [worldId])).rows[0].count;
    await assert.rejects(addArtifact(pool, artifactDirectory, { worldId, key: 'artifact-invalid-mismatch',
      grantAgentIds: [ownerId], relations: [{ type: 'goal', id: workerGoal }] }),
    (error) => error.message === 'REA_ARTIFACT_RELATION_GRANT_MISMATCH');
    await assert.rejects(addArtifact(pool, artifactDirectory, { worldId, key: 'artifact-invalid-id',
      grantAgentIds: [ownerId], relations: [{ type: 'goal', id: 'not-a-goal-id' }] }),
    (error) => error.message === 'REA_ARTIFACT_RELATION_ID_INVALID');
    await assert.rejects(addArtifact(pool, artifactDirectory, { worldId, key: 'artifact-missing-relation',
      grantAgentIds: [ownerId], relations: [{ type: 'goal', id: '9999999999999999' }] }),
    (error) => error.message === 'REA_ARTIFACT_RELATION_NOT_ACTIVE' && error.statusCode === 409);
    const foreignWorldId = randomUUID();
    await pool.query(`INSERT INTO worlds(id,owner_agent_id,name,chain_id,open)
      VALUES($1,$2,'REA relation foreign fixture',5042,true)`, [foreignWorldId,ownerId]);
    await pool.query(`INSERT INTO world_members(world_id,agent_id,role,location)
      VALUES($1,$2,'owner','Garden')`, [foreignWorldId,ownerId]);
    const foreignGoal = await addGoal(pool, foreignWorldId, ownerId, 'FOREIGN_RESEARCH', 'A goal in another world.');
    await assert.rejects(addArtifact(pool, artifactDirectory, { worldId, key: 'artifact-cross-world-relation',
      grantAgentIds: [ownerId], relations: [{ type: 'goal', id: foreignGoal }] }),
    (error) => error.message === 'REA_ARTIFACT_RELATION_NOT_ACTIVE' && error.statusCode === 409);
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM world_research_artifacts WHERE world_id=$1',
      [worldId])).rows[0].count, mismatchCountBefore,
    'invalid relations create no artifact rows');

    const goalArtifact1 = await addArtifact(pool, artifactDirectory, { worldId, key: 'artifact-goal-one',
      grantAgentIds: [ownerId], relations: [{ type: 'goal', id: ownerGoal1, relevanceDescription: 'Evidence for goal one.' }] });
    const goalArtifact2 = await addArtifact(pool, artifactDirectory, { worldId, key: 'artifact-goal-two',
      grantAgentIds: [ownerId], relations: [{ type: 'goal', id: ownerGoal2, relevanceDescription: 'Evidence for goal two.' }] });

    const projectId = randomUUID();
    await pool.query(`INSERT INTO world_projects(id,world_id,creator_agent_id,project_type,title,goal,description,status,
        created_world_time,updated_world_time,action_id)
      VALUES($1,$2,$3,'RESEARCH','Active project','Review this artifact','An active test project with an explicit member.','active',0,0,'relation-project')`,
    [projectId,worldId,ownerId]);
    await pool.query(`INSERT INTO world_project_members(world_id,project_id,agent_id,status,role,action_id,joined_world_time,updated_world_time)
      VALUES($1,$2,$3,'active','founder','relation-project-member',0,0)`, [worldId,projectId,ownerId]);
    const projectArtifact = await addArtifact(pool, artifactDirectory, { worldId, key: 'artifact-project',
      grantAgentIds: [ownerId], relations: [{ type: 'project', id: projectId }] });

    const businessId = randomUUID();
    await pool.query(`INSERT INTO world_businesses(id,world_id,founder_agent_id,name,business_type,purpose,status,founded_world_time,action_id)
      VALUES($1,$2,$3,'Active Workshop','research_service','An active business for relation validation.','active',0,'relation-business')`,
    [businessId,worldId,ownerId]);
    const jobId = randomUUID();
    await pool.query(`INSERT INTO world_business_jobs(id,world_id,business_id,role,wage_usdc,status,created_world_time,action_id)
      VALUES($1,$2,$3,'Researcher',5,'open',0,'relation-business-job')`, [jobId,worldId,businessId]);
    await pool.query(`INSERT INTO world_business_employment(id,world_id,business_id,job_id,agent_id,wage_usdc,status,started_world_time)
      VALUES($1,$2,$3,$4,$5,5,'active',0)`, [randomUUID(),worldId,businessId,jobId,workerId]);
    const founderBusinessArtifact = await addArtifact(pool, artifactDirectory, { worldId, key: 'artifact-business-founder',
      grantAgentIds: [ownerId], relations: [{ type: 'business', id: businessId }] });
    const employeeBusinessArtifact = await addArtifact(pool, artifactDirectory, { worldId, key: 'artifact-business-employee',
      grantAgentIds: [workerId], relations: [{ type: 'business', id: businessId }] });

    const organizationId = randomUUID();
    await pool.query(`INSERT INTO world_organizations(id,world_id,founder_agent_id,name,purpose,status,action_id,created_world_time,updated_world_time)
      VALUES($1,$2,$3,'Active Research Group','An active organization for relation validation.','active','relation-org',0,0)`,
    [organizationId,worldId,ownerId]);
    await pool.query(`INSERT INTO world_organization_members(world_id,organization_id,agent_id,status,role,joined_world_time,updated_world_time,action_id)
      VALUES($1,$2,$3,'active','member',0,0,'relation-org-member')`, [worldId,organizationId,workerId]);
    const organizationArtifact = await addArtifact(pool, artifactDirectory, { worldId, key: 'artifact-organization',
      grantAgentIds: [workerId], relations: [{ type: 'organization', id: organizationId }] });

    const artifacts = [noRelation,unboundArtifact,goalArtifact1,goalArtifact2,projectArtifact,founderBusinessArtifact,
      employeeBusinessArtifact,organizationArtifact];
    const relationInputs = await listResearchInputsByWorld(pool, { worldId });
    const ownerPairs = relationInputs.researchOpportunitiesByAgent.get(ownerId)
      .map((item) => `${item.artifactKey}:${item.relationType}:${item.relationId}`).sort();
    assert.deepEqual(ownerPairs, [
      `artifact-business-founder:business:${businessId}`,
      `artifact-goal-one:goal:${ownerGoal1}`,
      `artifact-goal-two:goal:${ownerGoal2}`,
      `artifact-project:project:${projectId}`
    ].sort(), 'only explicitly linked artifacts/relations become owner opportunities');
    const workerPairs = relationInputs.researchOpportunitiesByAgent.get(workerId)
      .map((item) => `${item.artifactKey}:${item.relationType}:${item.relationId}`).sort();
    assert.deepEqual(workerPairs, [
      `artifact-business-employee:business:${businessId}`,
      `artifact-organization:organization:${organizationId}`
    ].sort(), 'active employee and active organization membership are eligible');
    assert.equal(relationInputs.researchOpportunitiesByAgent.has(outsiderId), false);

    const provenance = await pool.query(`SELECT artifact.intake_method,artifact.origin_reference,artifact.created_by_agent_id,
        relation.provenance,relation.relevance_description
      FROM world_research_artifacts artifact JOIN world_research_artifact_relations relation
        ON relation.world_id=artifact.world_id AND relation.artifact_id=artifact.id
      WHERE artifact.id=$1`, [goalArtifact1.id]);
    assert.equal(provenance.rows[0].intake_method, 'operator_intake');
    assert.equal(provenance.rows[0].origin_reference, 'operator:isolated relation test fixture');
    assert.equal(provenance.rows[0].created_by_agent_id, null);
    assert.equal(provenance.rows[0].provenance, 'operator_intake');
    assert.equal(provenance.rows[0].relevance_description, 'Evidence for goal one.');

    const specification = (await pool.query(`SELECT id,name,specification FROM world_capabilities
      WHERE world_id=$1 AND capability_key=$2`, [worldId,RESEARCH_CAPABILITY_KEY])).rows[0];
    const ownerAgent = { agentId: ownerId, location: 'Garden', goals: [{ id: ownerGoal1, goalType: 'primary', status: 'active' }],
      curiosity: 0.5, skills: { research: 2 }, recentMemories: [] };
    const before = await pool.query(`SELECT (SELECT count(*) FROM world_capability_uses WHERE world_id=$1)::int AS uses,
      (SELECT count(*) FROM world_research_jobs WHERE world_id=$1)::int AS jobs,
      (SELECT count(*) FROM world_infrastructure_usage_events WHERE world_id=$1)::int AS metering`, [worldId]);
    const candidates = await buildCapabilityUseCandidates(ownerAgent, [specification], { researchInputs: relationInputs });
    assert.deepEqual(candidates.map((candidate) => candidate.capabilityContext.researchIntent.artifactId).sort(),
      [goalArtifact1.id,goalArtifact2.id,projectArtifact.id,founderBusinessArtifact.id].sort());
    assert.ok(candidates.every((candidate) => candidate.action === 'capability_use'));
    assert.equal(candidates.some((candidate) => candidate.capabilityContext.researchIntent.artifactId === unboundArtifact.id),
      false, 'an explicit grant without any active relation cannot produce a candidate');
    const after = await pool.query(`SELECT (SELECT count(*) FROM world_capability_uses WHERE world_id=$1)::int AS uses,
      (SELECT count(*) FROM world_research_jobs WHERE world_id=$1)::int AS jobs,
      (SELECT count(*) FROM world_infrastructure_usage_events WHERE world_id=$1)::int AS metering`, [worldId]);
    assert.deepEqual(after.rows[0], before.rows[0], 'candidate construction creates no use/job/metering rows');

    await assert.rejects(inTransaction(pool, (client) => enqueueResearchCapabilityUse(client, { worldId, agentId: ownerId,
      capabilityId: specification.id, actionId: 'relation-unbound-enqueue-0001', worldMinute: 100,
      researchIntent: { artifactId: unboundArtifact.id, targetType: 'javascript',
        researchQuestion: 'What does this unbound artifact contain?', objective: 'Investigate this unbound test artifact.',
        desiredInvestigation: 'Inspect its harmless fixture content.', expectedResult: 'Return a bounded summary.',
        relationType: 'goal', relationId: String(ownerGoal1) } })),
    (error) => error.statusCode === 409 && error.message === 'REA_ARTIFACT_RELATION_NOT_ACTIVE');
    assert.deepEqual((await pool.query(`SELECT (SELECT count(*) FROM world_capability_uses WHERE world_id=$1)::int AS uses,
      (SELECT count(*) FROM world_research_jobs WHERE world_id=$1)::int AS jobs`, [worldId])).rows[0],
    { uses: before.rows[0].uses, jobs: before.rows[0].jobs },
    'direct enqueue cannot bypass the explicit artifact relation check');

    const historyArtifact = goalArtifact1;
    const request = await inTransaction(pool, (client) => enqueueResearchCapabilityUse(client, { worldId, agentId: ownerId,
      capabilityId: specification.id, actionId: 'relation-history-job-0001', worldMinute: 100,
      researchIntent: candidates.find((candidate) => candidate.capabilityContext.researchIntent.artifactId === historyArtifact.id)
        .capabilityContext.researchIntent }));
    const historyBefore = (await pool.query(`SELECT id,status,target_artifact_id AS artifact_id,goal_id,evidence_reference
      FROM world_research_jobs WHERE id=$1`, [request.jobId])).rows[0];

    await pool.query("UPDATE world_agent_goals SET status='completed' WHERE world_id=$1 AND id=$2", [worldId,ownerGoal1]);
    await pool.query("UPDATE world_project_members SET status='left' WHERE world_id=$1 AND project_id=$2 AND agent_id=$3",
      [worldId,projectId,ownerId]);
    await pool.query("UPDATE world_business_employment SET status='terminated' WHERE world_id=$1 AND business_id=$2 AND agent_id=$3",
      [worldId,businessId,workerId]);
    await pool.query("UPDATE world_organization_members SET status='left' WHERE world_id=$1 AND organization_id=$2 AND agent_id=$3",
      [worldId,organizationId,workerId]);
    await pool.query(`UPDATE world_research_artifact_relations SET active=false
      WHERE world_id=$1 AND artifact_id=$2`, [worldId,goalArtifact2.id]);
    await assert.rejects(addArtifact(pool, artifactDirectory, { worldId, key: 'artifact-goal-two', grantAgentIds: [ownerId],
      relations: [{ type: 'goal', id: ownerGoal2 }] }),
    (error) => error.message === 'REA_ARTIFACT_RELATION_INACTIVE' && error.statusCode === 409);
    const inactiveInputs = await listResearchInputsByWorld(pool, { worldId });
    assert.equal(inactiveInputs.researchOpportunitiesByAgent.get(ownerId)
      .some((item) => [goalArtifact1.id,goalArtifact2.id,projectArtifact.id].includes(String(item.id))), false);
    assert.equal((inactiveInputs.researchOpportunitiesByAgent.get(workerId) || [])
      .some((item) => [employeeBusinessArtifact.id,organizationArtifact.id].includes(String(item.id))), false);
    const historyAfter = (await pool.query(`SELECT id,status,target_artifact_id AS artifact_id,goal_id,evidence_reference
      FROM world_research_jobs WHERE id=$1`, [request.jobId])).rows[0];
    assert.deepEqual(historyAfter, historyBefore, 'deactivation removes current opportunities but preserves queued job history');
    assert.equal((await pool.query('SELECT active FROM world_research_artifacts WHERE id=$1', [goalArtifact1.id])).rows[0].active, true);
    assert.equal(artifacts.length, 8);
  } finally {
    await pool.end();
    await rm(stateDirectory, { recursive: true, force: true });
  }
});

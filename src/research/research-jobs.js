import { createHash, randomUUID } from 'node:crypto';
import { actionIdentifier, requireWorldMember, requiredText, writeWorldHistory } from '../world-domain.js';
import { recordInfrastructureUsageEvent } from '../infrastructure-metering.js';

export const RESEARCH_CAPABILITY_KEY = 'technical_reverse_engineering_research';
export const RESEARCH_CAPABILITY_SPEC = Object.freeze({ schemaVersion: 1, kind: 'native_system',
  systemKey: RESEARCH_CAPABILITY_KEY, targetTypes: ['binary', 'source_code', 'javascript', 'evm_contract', 'web'],
  agentInput: { researchQuestion: 'string', artifactId: 'granted_artifact_uuid', targetType: 'known_artifact_type',
    relation: 'optional_goal_project_business_or_organization', objective: 'string',
    desiredInvestigation: 'string', expectedResult: 'string' } });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TARGET_TYPES = new Set(['binary', 'source_code', 'javascript', 'evm_contract', 'web']);

function jsonValue(value, fallback = {}) {
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch { return fallback; }
  }
  return value && typeof value === 'object' ? value : fallback;
}

function cleanErrorCode(value, fallback = 'REA_PROVIDER_ERROR') {
  const code = String(value || '').replace(/[^A-Z0-9_]/gi, '_').toUpperCase().slice(0, 96);
  return /^[A-Z][A-Z0-9_]{2,95}$/.test(code) ? code : fallback;
}

function cleanDiagnostic(value) {
  return String(value || '').replace(/(?:sk|pk|api)[-_ ]?(?:live|test)?[-_ ]?[A-Za-z0-9]{16,}/gi, '[redacted]')
    .replace(/((?:DATABASE_URL|PRIVATE_KEY|SECRET|TOKEN|API_KEY)\s*[:=]\s*)[^\s,;]+/gi, '$1[redacted]')
    .replace(/\b(?:0x)?[a-f0-9]{64}\b/gi, '[redacted-hash-or-key]')
    .slice(0, 2_000);
}

export function normalizeResearchIntent(value, artifact = null) {
  const intent = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  if (!UUID_RE.test(String(intent.artifactId || ''))) throw Object.assign(new Error('REA_ARTIFACT_ID_INVALID'), { statusCode: 400 });
  const researchQuestion = requiredText(intent.researchQuestion, 8, 1_200, 'REA_RESEARCH_QUESTION_INVALID');
  const objective = requiredText(intent.objective, 8, 1_600, 'REA_RESEARCH_OBJECTIVE_INVALID');
  const desiredInvestigation = requiredText(intent.desiredInvestigation, 1, 1_200, 'REA_DESIRED_INVESTIGATION_INVALID');
  const expectedResult = requiredText(intent.expectedResult, 1, 800, 'REA_EXPECTED_RESULT_INVALID');
  const relationType = intent.relationType ?? null;
  const relationId = intent.relationId ?? null;
  if (relationType !== null && !['goal', 'project', 'business', 'organization'].includes(relationType)) {
    throw Object.assign(new Error('REA_RELATION_TYPE_INVALID'), { statusCode: 400 });
  }
  const validRelationId = relationType === 'goal'
    ? /^[1-9]\d{0,15}$/.test(String(relationId || ''))
    : relationId === null || UUID_RE.test(String(relationId));
  if ((relationType === null) !== (relationId === null) || !validRelationId) {
    throw Object.assign(new Error('REA_RELATION_ID_INVALID'), { statusCode: 400 });
  }
  if (artifact && String(intent.artifactId) !== String(artifact.id)) {
    throw Object.assign(new Error('REA_ARTIFACT_REFERENCE_MISMATCH'), { statusCode: 409 });
  }
  if (artifact && String(intent.targetType || '') !== String(artifact.targetType)) {
    throw Object.assign(new Error('REA_TARGET_TYPE_MISMATCH'), { statusCode: 409 });
  }
  const targetType = String(artifact?.targetType || intent.targetType || '');
  if (!TARGET_TYPES.has(targetType)) throw Object.assign(new Error('REA_TARGET_TYPE_UNSUPPORTED'), { statusCode: 400 });
  return { researchQuestion, objective, desiredInvestigation, expectedResult,
    artifactId: String(intent.artifactId), targetType,
    relationType, relationId: relationId ? String(relationId) : null };
}

export async function listResearchInputsByWorld(client, { worldId }) {
  const [artifacts, contexts] = await Promise.all([
    client.query(`SELECT artifact_grant.agent_id AS "agentId",artifact.id,artifact.artifact_key AS "artifactKey",
        artifact.display_name AS "displayName",artifact.target_type AS "targetType",artifact.sha256,
        artifact.byte_size AS "byteSize",artifact.media_type AS "mediaType"
      FROM world_research_artifacts artifact
      JOIN world_research_artifact_grants artifact_grant ON artifact_grant.world_id=artifact.world_id AND artifact_grant.artifact_id=artifact.id
      WHERE artifact.world_id=$1 AND artifact.active=true
      ORDER BY artifact.created_at DESC,artifact.id LIMIT 2000`, [worldId]),
    client.query(`SELECT * FROM (
      SELECT agent_id AS "agentId",'goal'::text AS "relationType",id::text AS "relationId",
        COALESCE(NULLIF(description,''),category) AS objective,category AS label,goal_type AS "goalType",priority::text AS priority
      FROM world_agent_goals WHERE world_id=$1 AND status='active'
      UNION ALL
      SELECT member.agent_id,'project'::text,project.id::text,
        concat_ws(': ',project.title,project.goal,project.description),project.title,NULL::text,NULL::text
      FROM world_project_members member JOIN world_projects project
        ON project.world_id=member.world_id AND project.id=member.project_id
      WHERE member.world_id=$1 AND member.status='active' AND project.status='active'
      UNION ALL
      SELECT business.founder_agent_id,'business'::text,business.id::text,
        concat_ws(': ',business.name,business.purpose),business.name,NULL::text,NULL::text
      FROM world_businesses business WHERE business.world_id=$1 AND business.status='active'
      UNION ALL
      SELECT employment.agent_id,'business'::text,business.id::text,
        concat_ws(': ',business.name,business.purpose),business.name,NULL::text,NULL::text
      FROM world_business_employment employment JOIN world_businesses business
        ON business.world_id=employment.world_id AND business.id=employment.business_id
      WHERE employment.world_id=$1 AND employment.status='active' AND business.status='active'
      UNION ALL
      SELECT member.agent_id,'organization'::text,organization.id::text,
        concat_ws(': ',organization.name,organization.purpose),organization.name,NULL::text,NULL::text
      FROM world_organization_members member JOIN world_organizations organization
        ON organization.world_id=member.world_id AND organization.id=member.organization_id
      WHERE member.world_id=$1 AND member.status='active' AND organization.status='active'
    ) AS research_contexts
      ORDER BY "agentId",CASE "relationType" WHEN 'goal' THEN 0 WHEN 'project' THEN 1 ELSE 2 END,
        "priority" DESC NULLS LAST,"relationId" LIMIT 4000`, [worldId])
  ]);
  const artifactsByAgent = new Map();
  for (const artifact of artifacts.rows) {
    const entries = artifactsByAgent.get(artifact.agentId) || [];
    entries.push(artifact);
    artifactsByAgent.set(artifact.agentId, entries);
  }
  const contextsByAgent = new Map();
  for (const context of contexts.rows) {
    const entries = contextsByAgent.get(context.agentId) || [];
    entries.push(context);
    contextsByAgent.set(context.agentId, entries);
  }
  return { artifactsByAgent, contextsByAgent };
}

async function validateResearchRelation(client, { worldId, agentId, relationType, relationId }) {
  if (!relationType) return;
  const queries = {
    goal: `SELECT 1 FROM world_agent_goals WHERE world_id=$1 AND agent_id=$2 AND id=$3 AND status='active'`,
    project: `SELECT 1 FROM world_project_members member JOIN world_projects project
      ON project.world_id=member.world_id AND project.id=member.project_id
      WHERE member.world_id=$1 AND member.agent_id=$2 AND member.project_id=$3
        AND member.status='active' AND project.status='active'`,
    business: `SELECT 1 FROM world_businesses business WHERE business.world_id=$1 AND business.id=$3
      AND business.status='active' AND (business.founder_agent_id=$2 OR EXISTS (
        SELECT 1 FROM world_business_employment employment WHERE employment.world_id=business.world_id
          AND employment.business_id=business.id AND employment.agent_id=$2 AND employment.status='active'))`,
    organization: `SELECT 1 FROM world_organization_members member JOIN world_organizations organization
      ON organization.world_id=member.world_id AND organization.id=member.organization_id
      WHERE member.world_id=$1 AND member.agent_id=$2 AND member.organization_id=$3
        AND member.status='active' AND organization.status='active'`
  };
  const result = await client.query(queries[relationType], [worldId, agentId, relationId]);
  if (!result.rowCount) throw Object.assign(new Error('REA_RESEARCH_RELATION_NOT_ACTIVE'), { statusCode: 409 });
}

export async function enqueueResearchCapabilityUse(client, { worldId, agentId, capabilityId, actionId: rawActionId,
  decisionSource = 'utility_fallback', worldMinute, researchIntent }) {
  await requireWorldMember(client, worldId, agentId);
  const actionId = actionIdentifier(rawActionId);
  const selected = await client.query(`SELECT id,name,status,specification FROM world_capabilities
    WHERE world_id=$1 AND id=$2`, [worldId, capabilityId]);
  if (!selected.rowCount || selected.rows[0].status !== 'active') {
    throw Object.assign(new Error('CAPABILITY_NOT_USABLE'), { statusCode: 409 });
  }
  const spec = jsonValue(selected.rows[0].specification);
  if (spec.kind !== 'native_system' || spec.systemKey !== RESEARCH_CAPABILITY_KEY) {
    throw Object.assign(new Error('CAPABILITY_NOT_RESEARCH_SYSTEM'), { statusCode: 409 });
  }
  const artifactResult = await client.query(`SELECT artifact.id,artifact.target_type AS "targetType",
      artifact.display_name AS "displayName",artifact.sha256,artifact.byte_size AS "byteSize"
    FROM world_research_artifacts artifact JOIN world_research_artifact_grants artifact_grant
      ON artifact_grant.world_id=artifact.world_id AND artifact_grant.artifact_id=artifact.id
    WHERE artifact.world_id=$1 AND artifact.id=$2 AND artifact_grant.agent_id=$3 AND artifact.active=true`,
  [worldId, researchIntent?.artifactId, agentId]);
  if (!artifactResult.rowCount) throw Object.assign(new Error('REA_ARTIFACT_NOT_AVAILABLE_TO_AGENT'), { statusCode: 403 });
  const artifact = artifactResult.rows[0];
  const intent = normalizeResearchIntent(researchIntent, artifact);
  await validateResearchRelation(client, { worldId, agentId, relationType: intent.relationType, relationId: intent.relationId });
  const existing = await client.query(`SELECT usage.id AS "useId",usage.capability_id AS "capabilityId",
      usage.status,job.id AS "jobId",job.status AS "jobStatus",job.research_question AS "researchQuestion",
      job.objective,job.target_artifact_id AS "artifactId",job.target_type AS "targetType",
      job.desired_investigation AS "desiredInvestigation",job.expected_result AS "expectedResult",
      job.goal_id AS "goalId",job.project_id AS "projectId",job.business_id AS "businessId",
      job.organization_id AS "organizationId"
    FROM world_capability_uses usage LEFT JOIN world_research_jobs job
      ON job.world_id=usage.world_id AND job.capability_use_id=usage.id
    WHERE usage.world_id=$1 AND usage.action_id=$2`, [worldId, actionId]);
  const existingMatchesIntent = (row) => {
    if (String(row.capabilityId) !== String(capabilityId) || !row.jobId) {
      throw Object.assign(new Error('CAPABILITY_ACTION_ID_CONFLICT'), { statusCode: 409 });
    }
    const relationMatches = intent.relationType === 'goal' ? String(row.goalId) === intent.relationId
      : intent.relationType === 'project' ? String(row.projectId) === intent.relationId
        : intent.relationType === 'business' ? String(row.businessId) === intent.relationId
          : intent.relationType === 'organization' ? String(row.organizationId) === intent.relationId
            : !row.goalId && !row.projectId && !row.businessId && !row.organizationId;
    if (row.researchQuestion !== intent.researchQuestion || row.objective !== intent.objective
        || String(row.artifactId) !== intent.artifactId || row.targetType !== intent.targetType
        || row.desiredInvestigation !== intent.desiredInvestigation || row.expectedResult !== intent.expectedResult
        || !relationMatches) throw Object.assign(new Error('CAPABILITY_ACTION_ID_CONFLICT'), { statusCode: 409 });
    return row;
  };
  if (existing.rowCount) {
    const row = existingMatchesIntent(existing.rows[0]);
    return { useId: String(row.useId), jobId: String(row.jobId), status: row.status,
      jobStatus: row.jobStatus, idempotent: true };
  }
  const decisionSourceValue = ['agent_api', 'fruitfly', 'utility_fallback'].includes(decisionSource)
    ? decisionSource : 'utility_fallback';
  const minute = Math.max(0, Math.trunc(Number(worldMinute) || 0));
  const use = await client.query(`INSERT INTO world_capability_uses(world_id,capability_id,actor_agent_id,action_id,
      decision_source,world_minute,status,success,costs,effects,side_effects,result)
    VALUES($1,$2,$3,$4,$5,$6,'pending',false,'{}'::jsonb,'[]'::jsonb,'[]'::jsonb,$7::jsonb)
    ON CONFLICT(world_id,action_id) DO NOTHING RETURNING id`,
  [worldId, capabilityId, agentId, actionId, decisionSourceValue, minute,
    JSON.stringify({ status: 'pending', success: false, costStatus: 'unpriced', effects: [] })]);
  if (!use.rowCount) {
    const duplicate = await client.query(`SELECT usage.id AS "useId",usage.capability_id AS "capabilityId",
        usage.status,job.id AS "jobId",job.status AS "jobStatus",job.research_question AS "researchQuestion",
        job.objective,job.target_artifact_id AS "artifactId",job.target_type AS "targetType",
        job.desired_investigation AS "desiredInvestigation",job.expected_result AS "expectedResult",
        job.goal_id AS "goalId",job.project_id AS "projectId",job.business_id AS "businessId",
        job.organization_id AS "organizationId"
      FROM world_capability_uses usage LEFT JOIN world_research_jobs job
        ON job.world_id=usage.world_id AND job.capability_use_id=usage.id
      WHERE usage.world_id=$1 AND usage.action_id=$2`, [worldId, actionId]);
    if (!duplicate.rowCount) {
      throw Object.assign(new Error('CAPABILITY_ACTION_ID_CONFLICT'), { statusCode: 409 });
    }
    const row = existingMatchesIntent(duplicate.rows[0]);
    return { useId: String(row.useId), jobId: String(row.jobId), status: row.status,
      jobStatus: row.jobStatus, idempotent: true };
  }
  const useId = use.rows[0].id;
  const jobId = randomUUID();
  await client.query(`INSERT INTO world_research_jobs(id,world_id,actor_agent_id,capability_id,capability_use_id,
      action_id,goal_id,project_id,business_id,organization_id,research_question,objective,target_artifact_id,target_type,
      desired_investigation,expected_result,created_world_minute)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
  [jobId, worldId, agentId, capabilityId, useId, actionId,
    intent.relationType === 'goal' ? intent.relationId : null,
    intent.relationType === 'project' ? intent.relationId : null,
    intent.relationType === 'business' ? intent.relationId : null,
    intent.relationType === 'organization' ? intent.relationId : null,
    intent.researchQuestion, intent.objective, intent.artifactId, intent.targetType,
    intent.desiredInvestigation, intent.expectedResult, minute]);
  await client.query(`UPDATE world_capabilities SET usage_count=usage_count+1,updated_at=now()
    WHERE world_id=$1 AND id=$2`, [worldId, capabilityId]);
  await client.query(`INSERT INTO world_capability_events(world_id,actor_agent_id,capability_id,event_type,event_key,world_minute,details)
    VALUES($1,$2,$3,'capability_use_queued',$4,$5,$6::jsonb) ON CONFLICT(world_id,event_key) DO NOTHING`,
  [worldId, agentId, capabilityId, `rea-job:${jobId}:queued`, minute,
    JSON.stringify({ useId: String(useId), jobId, actionId, artifactId: intent.artifactId,
      relationType: intent.relationType, relationId: intent.relationId })]);
  await client.query(`INSERT INTO world_events(world_id,actor_id,event_type,data,action_id)
    VALUES($1,$2,'world.capability_use_queued',$3::jsonb,$4) ON CONFLICT(world_id,actor_id,action_id) DO NOTHING`,
  [worldId, agentId, JSON.stringify({ capabilityId, capabilityUseId: String(useId), researchJobId: jobId,
    status: 'queued', researchQuestion: intent.researchQuestion, artifactId: intent.artifactId, worldMinute: minute }), actionId]);
  return { useId: String(useId), jobId, status: 'pending', jobStatus: 'queued', idempotent: false };
}

export async function claimNextResearchJob(client, { worldId, workerId, leaseSeconds = 90 } = {}) {
  if (!worldId || !workerId) throw new TypeError('Research job claim requires worldId and workerId.');
  const boundedLease = Math.max(30, Math.min(600, Math.trunc(Number(leaseSeconds) || 90)));
  const result = await client.query(`WITH candidate AS (
      SELECT job.id FROM world_research_jobs job WHERE job.world_id=$1 AND job.status='queued'
      ORDER BY job.created_at,job.id LIMIT 1 FOR UPDATE SKIP LOCKED
    ) UPDATE world_research_jobs job SET status='running',worker_id=$2,
        started_at=COALESCE(job.started_at,now()),lease_expires_at=now()+($3::int * interval '1 second'),
        started_world_minute=COALESCE(job.started_world_minute,
          (SELECT state.world_minutes FROM world_runtime_state state WHERE state.world_id=job.world_id)),
        attempt_count=job.attempt_count+1,updated_at=now()
      FROM candidate WHERE job.id=candidate.id
      RETURNING job.id,job.world_id AS "worldId",job.actor_agent_id AS "agentId",job.capability_id AS "capabilityId",
        job.capability_use_id AS "capabilityUseId",job.action_id AS "actionId",job.research_question AS "researchQuestion",
        job.objective,job.target_artifact_id AS "artifactId",job.target_type AS "targetType",
        job.desired_investigation AS "desiredInvestigation",job.expected_result AS "expectedResult",
        job.created_world_minute AS "createdWorldMinute",job.attempt_count AS "attemptCount"`, [worldId, workerId, boundedLease]);
  if (!result.rowCount) return null;
  const use = await client.query(`UPDATE world_capability_uses SET status='running',result=jsonb_set(result,'{status}','"running"'::jsonb)
    WHERE world_id=$2 AND id=$1 AND status='pending' RETURNING id`,
  [result.rows[0].capabilityUseId, worldId]);
  if (!use.rowCount) throw Object.assign(new Error('REA_CAPABILITY_USE_NOT_PENDING'), { code: 'REA_CAPABILITY_USE_NOT_PENDING' });
  return result.rows[0];
}

export async function markResearchExternalCallStarted(client, { jobId, workerId, leaseSeconds = 90 }) {
  const result = await client.query(`UPDATE world_research_jobs SET external_call_started_at=COALESCE(external_call_started_at,now()),
      lease_expires_at=now()+($3::int * interval '1 second'),updated_at=now()
    WHERE id=$1 AND worker_id=$2 AND status='running' RETURNING id`, [jobId, workerId, leaseSeconds]);
  return result.rowCount === 1;
}

export async function extendResearchJobLease(client, { jobId, workerId, leaseSeconds = 90 }) {
  const result = await client.query(`UPDATE world_research_jobs SET lease_expires_at=now()+($3::int * interval '1 second'),updated_at=now()
    WHERE id=$1 AND worker_id=$2 AND status='running' RETURNING id`, [jobId, workerId, leaseSeconds]);
  return result.rowCount === 1;
}

async function recordResearchUsage(client, { job, providers, toolCalls, durationMs, evidenceBytes, model, ghidraUsed }) {
  const tools = Array.isArray(toolCalls) ? toolCalls : [];
  const calls = tools.length;
  return recordInfrastructureUsageEvent(client, { worldId: job.worldId, attributionType: 'agent', agentId: job.agentId,
    actionId: `rea-job:${job.id}`, resourceCategory: 'high_cost_research', provider: 'rea_mcp', model: model || null,
    worldMinute: job.createdWorldMinute, quantityRaw: String(Math.max(1, calls)),
    unit: calls ? 'tool_call' : 'job_attempt', costStatus: 'unpriced',
    metadata: { researchJobId: job.id, capabilityUseId: String(job.capabilityUseId), providers: providers || [],
      toolCalls: tools, durationMs: Math.max(0, Math.trunc(Number(durationMs) || 0)),
      evidenceBytes: Math.max(0, Math.trunc(Number(evidenceBytes) || 0)), ghidraUsed: Boolean(ghidraUsed) } });
}

export async function completeResearchJob(client, { job, findings, evidenceReference, evidenceSha256, evidenceBytes,
  providers = [], toolCalls = [], toolSequence = [], durationMs = 0, model = null, ghidraUsed = false,
  completedWorldMinute = null }) {
  if (!/^[0-9a-f]{64}$/.test(String(evidenceSha256 || ''))) throw new Error('REA_EVIDENCE_HASH_INVALID');
  const summary = requiredText(findings?.summary, 1, 1_200, 'REA_FINDINGS_SUMMARY_INVALID');
  const normalized = { summary, findings: Array.isArray(findings?.findings) ? findings.findings.slice(0, 16) : [],
    limitations: Array.isArray(findings?.limitations) ? findings.limitations.slice(0, 12) : [],
    provenance: { provider: 'rea_mcp', artifactId: String(job.artifactId), evidenceSha256 } };
  const locked = await client.query('SELECT status FROM world_research_jobs WHERE id=$1 FOR UPDATE', [job.id]);
  if (!locked.rowCount) throw new Error('REA_JOB_NOT_FOUND');
  if (locked.rows[0].status === 'completed') return { idempotent: true, status: 'completed' };
  if (locked.rows[0].status !== 'running') throw new Error('REA_JOB_NOT_RUNNING');
  const usageEvent = await recordResearchUsage(client, { job, providers, toolCalls, durationMs, evidenceBytes, model, ghidraUsed });
  const result = await client.query(`UPDATE world_research_jobs SET status='completed',completed_at=now(),
      completed_world_minute=COALESCE($2,created_world_minute),evidence_reference=$3,evidence_sha256=$4,
      evidence_bytes=$5,normalized_findings=$6::jsonb,selected_providers=$7::jsonb,tool_sequence=$8::jsonb,
      tool_calls=$9::jsonb,infrastructure_usage_event_id=$10,lease_expires_at=NULL,updated_at=now()
    WHERE id=$1 AND status='running' RETURNING id`,
  [job.id, completedWorldMinute, String(evidenceReference || '').slice(0, 240), evidenceSha256,
    Math.max(0, Math.trunc(Number(evidenceBytes) || 0)), JSON.stringify(normalized), JSON.stringify(providers),
    JSON.stringify(toolSequence), JSON.stringify(toolCalls), usageEvent.id]);
  if (!result.rowCount) {
    const existing = await client.query('SELECT status FROM world_research_jobs WHERE id=$1', [job.id]);
    if (existing.rows[0]?.status === 'completed') return { idempotent: true, status: 'completed' };
    throw new Error('REA_JOB_NOT_RUNNING');
  }
  const use = await client.query(`UPDATE world_capability_uses SET status='completed',success=true,costs='{}'::jsonb,
      effects='[]'::jsonb,side_effects=$3::jsonb,result=$4::jsonb
    WHERE world_id=$2 AND id=$1 AND status='running' RETURNING id`,
  [job.capabilityUseId, job.worldId, JSON.stringify([{ type: 'research_evidence', evidenceSha256 }]),
    JSON.stringify({ status: 'completed', success: true, jobId: job.id, evidenceReference,
      evidenceSha256, evidenceBytes, summary })]);
  if (!use.rowCount) {
    const current = await client.query('SELECT status FROM world_capability_uses WHERE world_id=$1 AND id=$2',
      [job.worldId, job.capabilityUseId]);
    const state = current.rows[0]?.status || 'missing';
    throw Object.assign(new Error(`REA_CAPABILITY_USE_STATE_MISMATCH:${state}`), { code: 'REA_CAPABILITY_USE_STATE_MISMATCH' });
  }
  await client.query(`UPDATE world_capabilities SET success_count=success_count+1,updated_at=now()
    WHERE world_id=$1 AND id=$2`, [job.worldId, job.capabilityId]);
  await client.query(`INSERT INTO world_capability_events(world_id,actor_agent_id,capability_id,event_type,event_key,world_minute,details)
    VALUES($1,$2,$3,'capability_used',$4,$5,$6::jsonb) ON CONFLICT(world_id,event_key) DO NOTHING`,
  [job.worldId, job.agentId, job.capabilityId, `rea-job:${job.id}:completed`,
    Number(completedWorldMinute ?? job.createdWorldMinute), JSON.stringify({ jobId: job.id,
      capabilityUseId: String(job.capabilityUseId), evidenceSha256, evidenceReference, findings: normalized })]);
  const event = await client.query(`INSERT INTO world_events(world_id,actor_id,event_type,data,action_id)
      VALUES($1,$2,'world.capability_used',$3::jsonb,$4) ON CONFLICT(world_id,actor_id,action_id) DO UPDATE
      SET data=EXCLUDED.data RETURNING id`, [job.worldId, job.agentId,
    JSON.stringify({ capabilityId: job.capabilityId, capabilityUseId: String(job.capabilityUseId),
      researchJobId: job.id, status: 'completed', evidenceSha256, evidenceReference,
      summary, worldMinute: Number(completedWorldMinute ?? job.createdWorldMinute) }), job.actionId]);
  await writeWorldHistory(client, { worldId: job.worldId, eventKey: `capability-use:${job.capabilityUseId}`,
    eventType: 'capability_used', actorAgentId: job.agentId, entityType: 'capability', entityId: job.capabilityId,
    worldTime: Number(completedWorldMinute ?? job.createdWorldMinute), title: 'Research capability completed',
    detail: `REA produced evidence-backed findings for this resident research request.`,
    metadata: { researchJobId: job.id, capabilityUseId: String(job.capabilityUseId), evidenceSha256, evidenceReference } });
  const memorySummary = `Research findings: ${summary.slice(0, 150)} [evidence ${evidenceSha256.slice(0, 12)}]`.slice(0, 240);
  await client.query(`INSERT INTO agent_memories(world_id,agent_id,memory_type,summary,importance,world_minutes,
      metadata,source_event_id,long_term,consolidation_key)
    VALUES($1,$2,'research',$3,0.66,$4,$5::jsonb,$6,false,$7)
    ON CONFLICT(world_id,agent_id,consolidation_key) WHERE consolidation_key IS NOT NULL DO NOTHING`,
  [job.worldId, job.agentId, memorySummary, Number(completedWorldMinute ?? job.createdWorldMinute),
    JSON.stringify({ source: 'rea_capability_use', researchJobId: job.id, capabilityUseId: String(job.capabilityUseId),
      evidenceReference, evidenceSha256, summary: summary.slice(0, 1_200) }), event.rows[0]?.id || null, `rea:${job.id}`]);
  return { idempotent: false, status: 'completed', evidenceSha256, usageEventId: usageEvent.id };
}

export async function failResearchJob(client, { job, status = 'failed', failureCode, diagnostic, providers = [],
  toolCalls = [], durationMs = 0, model = null, ghidraUsed = false }) {
  if (!['failed', 'timed_out', 'cancelled'].includes(status)) throw new Error('REA_JOB_TERMINAL_STATUS_INVALID');
  const code = cleanErrorCode(failureCode);
  const locked = await client.query('SELECT status FROM world_research_jobs WHERE id=$1 FOR UPDATE', [job.id]);
  if (!locked.rowCount) throw new Error('REA_JOB_NOT_FOUND');
  if (['failed','timed_out','cancelled','completed'].includes(locked.rows[0].status)) {
    return { idempotent: true, status: locked.rows[0].status };
  }
  if (!['queued','running'].includes(locked.rows[0].status)) throw new Error('REA_JOB_NOT_TERMINALIZABLE');
  const usageEvent = await recordResearchUsage(client, { job, providers, toolCalls, durationMs, evidenceBytes: 0, model, ghidraUsed });
  const result = await client.query(`UPDATE world_research_jobs job SET status=$2,completed_at=now(),
      completed_world_minute=COALESCE(job.completed_world_minute,
        (SELECT state.world_minutes FROM world_runtime_state state WHERE state.world_id=job.world_id)),
      failure_code=$3,failure_diagnostic=$4,selected_providers=$5::jsonb,tool_calls=$6::jsonb,
      infrastructure_usage_event_id=$7,lease_expires_at=NULL,updated_at=now()
    WHERE job.id=$1 AND job.status IN ('queued','running') RETURNING job.id`,
  [job.id, status, code, cleanDiagnostic(diagnostic), JSON.stringify(providers), JSON.stringify(toolCalls), usageEvent.id]);
  if (!result.rowCount) {
    const existing = await client.query('SELECT status FROM world_research_jobs WHERE id=$1', [job.id]);
    if (existing.rows[0] && ['failed','timed_out','cancelled','completed'].includes(existing.rows[0].status)) {
      return { idempotent: true, status: existing.rows[0].status };
    }
    throw new Error('REA_JOB_NOT_TERMINALIZABLE');
  }
  await client.query(`UPDATE world_capability_uses SET status='failed',success=false,costs='{}'::jsonb,
      effects='[]'::jsonb,side_effects='[]'::jsonb,result=$2::jsonb
    WHERE id=$1 AND status IN ('pending','running')`,
  [job.capabilityUseId, JSON.stringify({ status, success: false, jobId: job.id, reasonCode: code })]);
  await client.query(`UPDATE world_capabilities SET failure_count=failure_count+1,updated_at=now()
    WHERE world_id=$1 AND id=$2`, [job.worldId, job.capabilityId]);
  await client.query(`INSERT INTO world_capability_events(world_id,actor_agent_id,capability_id,event_type,event_key,world_minute,details)
    VALUES($1,$2,$3,'capability_use_failed',$4,$5,$6::jsonb) ON CONFLICT(world_id,event_key) DO NOTHING`,
  [job.worldId, job.agentId, job.capabilityId, `rea-job:${job.id}:${status}`, job.createdWorldMinute,
    JSON.stringify({ jobId: job.id, capabilityUseId: String(job.capabilityUseId), status, failureCode: code })]);
  await client.query(`INSERT INTO world_events(world_id,actor_id,event_type,data,action_id)
    VALUES($1,$2,'world.capability_use_failed',$3::jsonb,$4) ON CONFLICT(world_id,actor_id,action_id) DO UPDATE
    SET data=EXCLUDED.data`, [job.worldId, job.agentId, JSON.stringify({ capabilityId: job.capabilityId,
    capabilityUseId: String(job.capabilityUseId), researchJobId: job.id, status, failureCode: code,
    diagnostic: cleanDiagnostic(diagnostic), worldMinute: job.createdWorldMinute }), job.actionId]);
  return { idempotent: false, status, failureCode: code, usageEventId: usageEvent.id };
}

export async function recoverExpiredResearchJobs(client, { worldId, now = new Date() } = {}) {
  if (!worldId) throw new TypeError('Research job recovery requires worldId.');
  const expired = await client.query(`SELECT id,world_id AS "worldId",actor_agent_id AS "agentId",
      capability_id AS "capabilityId",capability_use_id AS "capabilityUseId",action_id AS "actionId",
      created_world_minute AS "createdWorldMinute",external_call_started_at AS "externalCallStartedAt"
    FROM world_research_jobs WHERE world_id=$1 AND status='running' AND lease_expires_at < $2
    ORDER BY lease_expires_at,id FOR UPDATE SKIP LOCKED`, [worldId, now]);
  const recovered = [];
  for (const job of expired.rows) {
    if (job.externalCallStartedAt) {
      await failResearchJob(client, { job, status: 'failed', failureCode: 'REA_RESULT_UNKNOWN_AFTER_RESTART',
        diagnostic: 'Worker lease expired after external execution was marked started; automatic replay was suppressed.' });
      recovered.push({ id: job.id, status: 'failed', replayed: false });
    } else {
      await client.query(`UPDATE world_research_jobs SET status='queued',worker_id=NULL,lease_expires_at=NULL,updated_at=now()
        WHERE id=$1 AND status='running'`, [job.id]);
      await client.query(`UPDATE world_capability_uses SET status='pending',result=jsonb_set(result,'{status}','"pending"'::jsonb)
        WHERE id=$1 AND status='running'`, [job.capabilityUseId]);
      recovered.push({ id: job.id, status: 'queued', replayed: false });
    }
  }
  return recovered;
}

export async function cancelResearchJob(client, { worldId, agentId, jobId, actionId: rawActionId, worldMinute }) {
  const actionId = actionIdentifier(rawActionId);
  const result = await client.query(`UPDATE world_research_jobs SET status='cancelled',completed_at=now(),
      completed_world_minute=$4,
      worker_id=NULL,lease_expires_at=NULL,failure_code='AGENT_CANCELLED',
      failure_diagnostic='Cancelled by the requesting Agent before provider execution.',updated_at=now()
    WHERE world_id=$1 AND actor_agent_id=$2 AND id=$3 AND status='queued'
    RETURNING id,capability_use_id AS "capabilityUseId",capability_id AS "capabilityId",created_world_minute AS "createdWorldMinute"`,
  [worldId, agentId, jobId, Math.max(0, Math.trunc(Number(worldMinute) || 0))]);
  if (!result.rowCount) {
    const current = await client.query(`SELECT status FROM world_research_jobs
      WHERE world_id=$1 AND actor_agent_id=$2 AND id=$3`, [worldId, agentId, jobId]);
    if (!current.rowCount) throw Object.assign(new Error('REA_RESEARCH_JOB_NOT_FOUND'), { statusCode: 404 });
    if (current.rows[0].status === 'cancelled') return { idempotent: true, status: 'cancelled' };
    throw Object.assign(new Error('REA_RESEARCH_JOB_NOT_QUEUED'), { statusCode: 409 });
  }
  const job = result.rows[0];
  await client.query(`UPDATE world_capability_uses SET status='abandoned',success=false,
      result=jsonb_build_object('status','cancelled','success',false,'jobId',$2::text,'reasonCode','AGENT_CANCELLED')
    WHERE id=$1 AND status='pending'`, [job.capabilityUseId, job.id]);
  await client.query(`INSERT INTO world_capability_events(world_id,actor_agent_id,capability_id,event_type,event_key,world_minute,details)
    VALUES($1,$2,$3,'capability_use_cancelled',$4,$5,$6::jsonb) ON CONFLICT(world_id,event_key) DO NOTHING`,
  [worldId, agentId, job.capabilityId, `rea-job:${job.id}:cancelled`, Math.max(0, Math.trunc(Number(worldMinute) || 0)),
    JSON.stringify({ jobId: job.id, capabilityUseId: String(job.capabilityUseId), actionId })]);
  return { id: String(job.id), status: 'cancelled', idempotent: false };
}

export async function updateResearchRuntimeStatus(client, { worldId, workerStatus, workerId, nodeVersion,
  reaPackageVersion, reaServerName, providers = [], toolCatalog = [], ghidraAvailable = false,
  lastErrorCode = null }) {
  const status = ['stopped','starting','ready','degraded','unavailable','error'].includes(workerStatus)
    ? workerStatus : 'error';
  await client.query(`INSERT INTO world_research_runtime_status(world_id,worker_status,worker_id,node_version,
      rea_package_version,rea_server_name,providers,tool_catalog,ghidra_available,checked_at,last_error_code,updated_at)
    VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,now(),$10,now())
    ON CONFLICT(world_id) DO UPDATE SET worker_status=EXCLUDED.worker_status,worker_id=EXCLUDED.worker_id,
      node_version=EXCLUDED.node_version,rea_package_version=EXCLUDED.rea_package_version,
      rea_server_name=EXCLUDED.rea_server_name,providers=EXCLUDED.providers,tool_catalog=EXCLUDED.tool_catalog,
      ghidra_available=EXCLUDED.ghidra_available,checked_at=EXCLUDED.checked_at,
      last_error_code=EXCLUDED.last_error_code,updated_at=now()`,
  [worldId, status, workerId || null, nodeVersion || null, reaPackageVersion || null, reaServerName || null,
    JSON.stringify(providers), JSON.stringify(toolCatalog), Boolean(ghidraAvailable), lastErrorCode ? cleanErrorCode(lastErrorCode) : null]);
}

export async function readResearchWorldStatus(client, { worldId, limit = 30 }) {
  const [runtime, counts, jobs, usage] = await Promise.all([
    client.query(`SELECT worker_status AS "workerStatus",worker_id AS "workerId",node_version AS "nodeVersion",
        rea_package_version AS "reaPackageVersion",rea_server_name AS "reaServerName",providers,tool_catalog AS "toolCatalog",
        ghidra_available AS "ghidraAvailable",checked_at AS "checkedAt",last_error_code AS "lastErrorCode"
      FROM world_research_runtime_status WHERE world_id=$1`, [worldId]),
    client.query(`SELECT status,count(*)::int AS count FROM world_research_jobs WHERE world_id=$1 GROUP BY status`, [worldId]),
    client.query(`SELECT job.id,job.actor_agent_id AS "agentId",agent.name AS "agentName",job.capability_use_id AS "capabilityUseId",
        job.action_id AS "actionId",job.status,job.research_question AS "researchQuestion",job.target_type AS "targetType",
        artifact.artifact_key AS "artifactKey",artifact.display_name AS "artifactName",job.evidence_reference AS "evidenceReference",
        job.evidence_sha256 AS "evidenceSha256",job.failure_code AS "failureCode",job.created_at AS "createdAt",
        job.started_at AS "startedAt",job.completed_at AS "completedAt"
      FROM world_research_jobs job JOIN agents agent ON agent.id=job.actor_agent_id
      JOIN world_research_artifacts artifact ON artifact.world_id=job.world_id AND artifact.id=job.target_artifact_id
      WHERE job.world_id=$1 ORDER BY job.created_at DESC,job.id DESC LIMIT $2`,
    [worldId, Math.max(1, Math.min(100, Math.trunc(Number(limit) || 30)))]),
    client.query(`SELECT event.id,event.agent_id AS "agentId",agent.name AS "agentName",event.action_id AS "actionId",
        event.provider,event.model,event.world_minute AS "worldMinute",event.quantity_raw::text AS "quantityRaw",
        event.unit,event.cost_status AS "costStatus",event.metadata,event.created_at AS "createdAt"
      FROM world_infrastructure_usage_events event LEFT JOIN agents agent ON agent.id=event.agent_id
      WHERE event.world_id=$1 AND event.resource_category='high_cost_research'
      ORDER BY event.created_at DESC,event.id DESC LIMIT $2`, [worldId, Math.max(1, Math.min(100, Math.trunc(Number(limit) || 30)))])
  ]);
  return { readiness: runtime.rows[0] || { workerStatus: 'unavailable', providers: [], toolCatalog: [], ghidraAvailable: false,
    lastErrorCode: 'REA_WORKER_NOT_REGISTERED' }, counts: Object.fromEntries(counts.rows.map((row) => [row.status, row.count])),
  jobs: jobs.rows, infrastructureUsage: usage.rows };
}

export async function listAgentResearchJobs(client, { worldId, agentId, limit = 30 }) {
  const result = await client.query(`SELECT job.id,job.capability_use_id AS "capabilityUseId",job.action_id AS "actionId",
      job.status,job.research_question AS "researchQuestion",job.objective,job.target_type AS "targetType",
      artifact.artifact_key AS "artifactKey",artifact.display_name AS "artifactName",
      job.normalized_findings AS findings,job.evidence_reference AS "evidenceReference",
      job.evidence_sha256 AS "evidenceSha256",job.failure_code AS "failureCode",
      job.failure_diagnostic AS "failureDiagnostic",job.created_world_minute AS "createdWorldMinute",
      job.started_world_minute AS "startedWorldMinute",job.completed_world_minute AS "completedWorldMinute",
      job.created_at AS "createdAt",job.started_at AS "startedAt",job.completed_at AS "completedAt"
    FROM world_research_jobs job JOIN world_research_artifacts artifact
      ON artifact.world_id=job.world_id AND artifact.id=job.target_artifact_id
    WHERE job.world_id=$1 AND job.actor_agent_id=$2
    ORDER BY job.created_at DESC,job.id DESC LIMIT $3`,
  [worldId, agentId, Math.max(1, Math.min(100, Math.trunc(Number(limit) || 30)))]);
  return result.rows;
}

export function evidenceSha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

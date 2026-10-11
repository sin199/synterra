import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { requiredText } from '../world-domain.js';

export const MAX_RESEARCH_ARTIFACT_BYTES = 32 * 1024 * 1024;
const TARGET_TYPES = new Set(['binary', 'source_code', 'javascript', 'evm_contract', 'web']);
const PRIVATE_CONTENT = [
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/i,
  /(?:^|[^A-Z0-9_])(?:DATABASE_URL|[A-Z0-9_]{0,96}?(?:PRIVATE_KEY|SECRET_KEY|API_KEY|ACCESS_TOKEN|AUTH_TOKEN)[A-Z0-9_]{0,96})["']?\s*[:=]\s*["']?[^\s,"';}]{8,}/i,
  /\b(?:sk|pk)-(?:live|test)-[A-Za-z0-9]{20,}\b/i,
  /\bBearer\s+[A-Za-z0-9._~+\/-]{24,}/i,
  /\b0x[a-f0-9]{64}\b/i
];

function artifactError(code, statusCode = 400) {
  return Object.assign(new Error(code), { statusCode });
}

export function containsPrivateMaterial(bytes) {
  const content = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []);
  return PRIVATE_CONTENT.some((pattern) => pattern.test(content.toString('latin1')));
}

function validateArtifactPayload({ artifactKey, displayName, targetType, mediaType, bytes }) {
  const key = requiredText(artifactKey, 8, 120, 'REA_ARTIFACT_KEY_INVALID');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(key)) throw artifactError('REA_ARTIFACT_KEY_INVALID');
  const name = requiredText(displayName, 1, 180, 'REA_ARTIFACT_DISPLAY_NAME_INVALID');
  if (/[\\/\0]/.test(name) || /(^|\.)env(?:\.|$)|private.?key|credentials?/i.test(name)) {
    throw artifactError('REA_ARTIFACT_NAME_NOT_ALLOWED', 403);
  }
  if (!TARGET_TYPES.has(targetType)) throw artifactError('REA_ARTIFACT_TARGET_TYPE_INVALID');
  const type = requiredText(mediaType, 1, 120, 'REA_ARTIFACT_MEDIA_TYPE_INVALID').toLowerCase();
  if (!/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(type)) {
    throw artifactError('REA_ARTIFACT_MEDIA_TYPE_INVALID');
  }
  const content = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []);
  if (!content.length || content.length > MAX_RESEARCH_ARTIFACT_BYTES) throw artifactError('REA_ARTIFACT_SIZE_INVALID', 413);
  if (containsPrivateMaterial(content)) throw artifactError('REA_ARTIFACT_PRIVATE_MATERIAL_BLOCKED', 403);
  return { artifactKey: key, displayName: name, targetType, mediaType: type, bytes: content,
    byteSize: content.length, sha256: createHash('sha256').update(content).digest('hex') };
}

const RELATION_ID_VALIDATORS = Object.freeze({
  goal: (value) => /^[1-9]\d{0,15}$/.test(value),
  project: (value) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value),
  business: (value) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value),
  organization: (value) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
});

function normalizeArtifactRelations(relations) {
  if (!Array.isArray(relations)) throw artifactError('REA_ARTIFACT_RELATIONS_INVALID');
  const normalized = new Map();
  for (const relation of relations) {
    const type = String(relation?.type || '');
    const id = String(relation?.id || '');
    if (!Object.hasOwn(RELATION_ID_VALIDATORS, type) || !RELATION_ID_VALIDATORS[type](id)) {
      throw artifactError('REA_ARTIFACT_RELATION_ID_INVALID');
    }
    const relevanceDescription = relation.relevanceDescription == null ? null
      : requiredText(relation.relevanceDescription, 1, 500, 'REA_ARTIFACT_RELATION_DESCRIPTION_INVALID');
    const key = `${type}:${id}`;
    const existing = normalized.get(key);
    if (existing && existing.relevanceDescription !== relevanceDescription) {
      throw artifactError('REA_ARTIFACT_RELATION_DUPLICATE_CONFLICT');
    }
    normalized.set(key, { type, id, relevanceDescription });
  }
  return [...normalized.values()];
}

function normalizeOriginReference(value) {
  const origin = requiredText(value, 1, 500, 'REA_ARTIFACT_ORIGIN_REQUIRED');
  if (/[\u0000-\u001f\u007f]/.test(origin) || /^\/(?:\/|[^/])/i.test(origin)
      || /^[a-z]:[\\/]/i.test(origin) || /^file:/i.test(origin)) {
    throw artifactError('REA_ARTIFACT_ORIGIN_INVALID');
  }
  if (/^https?:/i.test(origin)) {
    let url;
    try { url = new URL(origin); } catch { throw artifactError('REA_ARTIFACT_ORIGIN_INVALID'); }
    if (url.protocol !== 'https:' || url.username || url.password) throw artifactError('REA_ARTIFACT_ORIGIN_INVALID');
  } else if (!/^operator:[a-zA-Z0-9][a-zA-Z0-9 ._:-]{0,180}$/i.test(origin)) {
    throw artifactError('REA_ARTIFACT_ORIGIN_INVALID');
  }
  return origin;
}

async function validateArtifactRelation(client, { worldId, relation, grantAgentIds }) {
  const tableAndColumn = {
    goal: ['world_agent_goals', 'goal_id'],
    project: ['world_projects', 'project_id'],
    business: ['world_businesses', 'business_id'],
    organization: ['world_organizations', 'organization_id']
  };
  const [table] = tableAndColumn[relation.type];
  const active = await client.query(`SELECT 1 FROM ${table} WHERE world_id=$1 AND id=$2 AND status='active'`,
    [worldId, relation.id]);
  if (!active.rowCount) throw artifactError('REA_ARTIFACT_RELATION_NOT_ACTIVE', 409);
  const eligibleQueries = {
    goal: `SELECT agent_id AS "agentId" FROM world_agent_goals WHERE world_id=$1 AND id=$2 AND status='active'`,
    project: `SELECT member.agent_id AS "agentId" FROM world_project_members member
      JOIN world_projects project ON project.world_id=member.world_id AND project.id=member.project_id
      WHERE project.world_id=$1 AND project.id=$2 AND project.status='active' AND member.status='active'`,
    business: `SELECT business.founder_agent_id AS "agentId" FROM world_businesses business
      WHERE business.world_id=$1 AND business.id=$2 AND business.status='active'
      UNION SELECT employment.agent_id FROM world_business_employment employment
      JOIN world_businesses business ON business.world_id=employment.world_id AND business.id=employment.business_id
      WHERE business.world_id=$1 AND business.id=$2 AND business.status='active' AND employment.status='active'`,
    organization: `SELECT member.agent_id AS "agentId" FROM world_organization_members member
      JOIN world_organizations organization ON organization.world_id=member.world_id
        AND organization.id=member.organization_id
      WHERE organization.world_id=$1 AND organization.id=$2 AND organization.status='active'
        AND member.status='active'`
  };
  const eligible = await client.query(eligibleQueries[relation.type], [worldId, relation.id]);
  if (!eligible.rows.some((row) => grantAgentIds.includes(String(row.agentId)))) {
    throw artifactError('REA_ARTIFACT_RELATION_GRANT_MISMATCH', 409);
  }
}

async function ensureContentAddressedObject(rootDirectory, sha256, bytes) {
  const root = path.resolve(rootDirectory);
  const directory = path.join(root, sha256.slice(0, 2));
  const filePath = path.join(directory, sha256);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    const handle = await open(filePath, 'wx', 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); }
    finally { await handle.close(); }
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const info = await stat(filePath);
    if (!info.isFile() || info.size !== bytes.length
        || createHash('sha256').update(await readFile(filePath)).digest('hex') !== sha256) {
      throw artifactError('REA_ARTIFACT_OBJECT_COLLISION', 409);
    }
  }
  return filePath;
}

export async function importResearchArtifact(client, { worldId, createdByAgentId = null,
  grantAgentIds = [], relations = [], originReference, artifactKey, displayName, targetType, mediaType, bytes, artifactDirectory }) {
  if (!artifactDirectory) throw artifactError('REA_ARTIFACT_STORE_NOT_CONFIGURED', 503);
  const value = validateArtifactPayload({ artifactKey, displayName, targetType, mediaType, bytes });
  const origin = normalizeOriginReference(originReference);
  const normalizedRelations = normalizeArtifactRelations(relations);
  const grants = [...new Set(grantAgentIds.map(String))];
  if (createdByAgentId) grants.push(String(createdByAgentId));
  const uniqueGrants = [...new Set(grants)];
  if (!uniqueGrants.length) throw artifactError('REA_ARTIFACT_GRANT_REQUIRED');
  const memberResult = await client.query(`SELECT agent_id FROM world_members
    WHERE world_id=$1 AND agent_id=ANY($2::uuid[])`, [worldId, uniqueGrants]);
  if (memberResult.rowCount !== uniqueGrants.length) throw artifactError('REA_ARTIFACT_GRANT_MEMBER_REQUIRED', 403);
  if (createdByAgentId && !uniqueGrants.includes(String(createdByAgentId))) {
    throw artifactError('REA_ARTIFACT_CREATOR_GRANT_REQUIRED');
  }
  for (const relation of normalizedRelations) {
    await validateArtifactRelation(client, { worldId, relation, grantAgentIds: uniqueGrants });
  }
  const storageKey = value.sha256;
  await ensureContentAddressedObject(artifactDirectory, value.sha256, value.bytes);
  const inserted = await client.query(`INSERT INTO world_research_artifacts(id,world_id,artifact_key,display_name,target_type,
      storage_key,sha256,byte_size,media_type,created_by_agent_id,intake_method,origin_reference)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'operator_intake',$11)
    ON CONFLICT(world_id,artifact_key) DO NOTHING RETURNING id,sha256`,
  [randomUUID(), worldId, value.artifactKey, value.displayName, value.targetType, storageKey, value.sha256,
    value.byteSize, value.mediaType, createdByAgentId, origin]);
  let artifact = inserted.rows[0] || null;
  if (!artifact) {
    const existing = await client.query(`SELECT id,sha256 FROM world_research_artifacts
      WHERE world_id=$1 AND artifact_key=$2`, [worldId, value.artifactKey]);
    if (!existing.rowCount || existing.rows[0].sha256 !== value.sha256) throw artifactError('REA_ARTIFACT_KEY_CONFLICT', 409);
    artifact = existing.rows[0];
  }
  for (const agentId of uniqueGrants) {
    await client.query(`INSERT INTO world_research_artifact_grants(world_id,artifact_id,agent_id)
      VALUES($1,$2,$3) ON CONFLICT(world_id,artifact_id,agent_id) DO NOTHING`, [worldId, artifact.id, agentId]);
  }
  for (const relation of normalizedRelations) {
    const relationColumn = { goal: 'goal_id', project: 'project_id', business: 'business_id', organization: 'organization_id' }[relation.type];
    const existing = await client.query(`SELECT active FROM world_research_artifact_relations
      WHERE world_id=$1 AND artifact_id=$2 AND ${relationColumn}=$3`, [worldId, artifact.id, relation.id]);
    if (existing.rowCount && !existing.rows[0].active) throw artifactError('REA_ARTIFACT_RELATION_INACTIVE', 409);
    await client.query(`INSERT INTO world_research_artifact_relations(world_id,artifact_id,${relationColumn},provenance,
        relevance_description)
      VALUES($1,$2,$3,'operator_intake',$4) ON CONFLICT DO NOTHING`,
    [worldId, artifact.id, relation.id, relation.relevanceDescription]);
  }
  return { id: String(artifact.id), artifactKey: value.artifactKey, targetType: value.targetType,
    byteSize: value.byteSize, sha256: value.sha256, intakeMethod: 'operator_intake', originReference: origin,
    relationCount: normalizedRelations.length };
}

export async function resolveGrantedResearchArtifact(client, { worldId, agentId, artifactId, artifactDirectory }) {
  if (!artifactDirectory) throw artifactError('REA_ARTIFACT_STORE_NOT_CONFIGURED', 503);
  const result = await client.query(`SELECT artifact.id,artifact.artifact_key AS "artifactKey",
      artifact.display_name AS "displayName",artifact.target_type AS "targetType",artifact.storage_key AS "storageKey",
      artifact.sha256,artifact.byte_size AS "byteSize",artifact.media_type AS "mediaType"
    FROM world_research_artifacts artifact JOIN world_research_artifact_grants artifact_grant
      ON artifact_grant.world_id=artifact.world_id AND artifact_grant.artifact_id=artifact.id
    WHERE artifact.world_id=$1 AND artifact.id=$2 AND artifact_grant.agent_id=$3 AND artifact.active=true`,
  [worldId, artifactId, agentId]);
  if (!result.rowCount) throw artifactError('REA_ARTIFACT_NOT_AVAILABLE_TO_AGENT', 403);
  const artifact = result.rows[0];
  if (!/^[a-f0-9]{64}$/.test(artifact.storageKey) || artifact.storageKey !== artifact.sha256) {
    throw artifactError('REA_ARTIFACT_STORAGE_REFERENCE_INVALID', 409);
  }
  const root = path.resolve(artifactDirectory);
  const candidate = path.join(root, artifact.storageKey.slice(0, 2), artifact.storageKey);
  const realRoot = await realpath(root);
  const targetPath = await realpath(candidate);
  if (!targetPath.startsWith(`${realRoot}${path.sep}`)) throw artifactError('REA_ARTIFACT_PATH_OUTSIDE_STORE', 403);
  const info = await stat(targetPath);
  if (!info.isFile() || info.size !== Number(artifact.byteSize)) throw artifactError('REA_ARTIFACT_OBJECT_MISMATCH', 409);
  const bytes = await readFile(targetPath);
  if (createHash('sha256').update(bytes).digest('hex') !== artifact.sha256) {
    throw artifactError('REA_ARTIFACT_DIGEST_MISMATCH', 409);
  }
  return { ...artifact, path: targetPath, bytes };
}

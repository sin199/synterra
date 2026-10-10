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
  grantAgentIds = [], artifactKey, displayName, targetType, mediaType, bytes, artifactDirectory }) {
  if (!artifactDirectory) throw artifactError('REA_ARTIFACT_STORE_NOT_CONFIGURED', 503);
  const value = validateArtifactPayload({ artifactKey, displayName, targetType, mediaType, bytes });
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
  const storageKey = value.sha256;
  await ensureContentAddressedObject(artifactDirectory, value.sha256, value.bytes);
  const inserted = await client.query(`INSERT INTO world_research_artifacts(id,world_id,artifact_key,display_name,target_type,
      storage_key,sha256,byte_size,media_type,created_by_agent_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    ON CONFLICT(world_id,artifact_key) DO NOTHING RETURNING id,sha256`,
  [randomUUID(), worldId, value.artifactKey, value.displayName, value.targetType, storageKey, value.sha256,
    value.byteSize, value.mediaType, createdByAgentId]);
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
  return { id: String(artifact.id), artifactKey: value.artifactKey, targetType: value.targetType,
    byteSize: value.byteSize, sha256: value.sha256 };
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

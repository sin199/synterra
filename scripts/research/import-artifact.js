import { Pool } from 'pg';
import path from 'node:path';
import { STATE_DIR } from '../../src/agent-runtime/client.js';
import { importResearchArtifact } from '../../src/research/artifacts.js';
import { readIntakeArtifact } from '../../src/research/artifact-intake.js';

const args = process.argv.slice(2);
const usage = 'Use --world UUID --file RELATIVE_PATH --target TYPE --key KEY --name NAME --media-type TYPE --origin-reference HTTPS_URL_OR_OPERATOR_LABEL --grant-agent UUID [--grant-agent UUID ...] [--relation goal:ID|project:UUID|business:UUID|organization:UUID ...] [--relation-relevance TYPE:ID=TEXT].';

function parseArguments(values) {
  const output = { grantAgentIds: [], relationValues: [], relationRelevanceValues: [] };
  const single = new Set(['--world','--file','--target','--key','--name','--media-type','--origin-reference']);
  for (let index = 0; index < values.length; index += 1) {
    const flag = values[index];
    if (!single.has(flag) && !['--grant-agent','--relation','--relation-relevance'].includes(flag)) {
      throw new Error('REA_ARTIFACT_ARGUMENT_INVALID');
    }
    const value = values[++index];
    if (!value || value.startsWith('--')) throw new Error('REA_ARTIFACT_ARGUMENT_MISSING');
    if (flag === '--grant-agent') output.grantAgentIds.push(value);
    else if (flag === '--relation') output.relationValues.push(value);
    else if (flag === '--relation-relevance') output.relationRelevanceValues.push(value);
    else {
      if (output[flag]) throw new Error('REA_ARTIFACT_ARGUMENT_DUPLICATE');
      output[flag] = value;
    }
  }
  const keys = ['--world','--file','--target','--key','--name','--media-type','--origin-reference'];
  if (keys.some((key) => !output[key]) || !output.grantAgentIds.length) throw new Error('REA_ARTIFACT_ARGUMENT_MISSING');
  const relation = (value) => {
    const separator = value.indexOf(':');
    if (separator < 1 || separator === value.length - 1) throw new Error('REA_ARTIFACT_RELATION_ID_INVALID');
    return { type: value.slice(0, separator), id: value.slice(separator + 1) };
  };
  const relations = new Map(output.relationValues.map((value) => {
    const parsed = relation(value);
    return [`${parsed.type}:${parsed.id}`, parsed];
  }));
  for (const value of output.relationRelevanceValues) {
    const equals = value.indexOf('=');
    if (equals < 1 || equals === value.length - 1) throw new Error('REA_ARTIFACT_RELATION_DESCRIPTION_INVALID');
    const parsed = relation(value.slice(0, equals));
    const key = `${parsed.type}:${parsed.id}`;
    if (!relations.has(key)) throw new Error('REA_ARTIFACT_RELATION_DESCRIPTION_WITHOUT_RELATION');
    relations.get(key).relevanceDescription = value.slice(equals + 1);
  }
  output.relations = [...relations.values()];
  return output;
}

function validUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

let pool;
try {
  const options = parseArguments(args);
  const worldId = options['--world'];
  if (!validUuid(worldId) || options.grantAgentIds.some((id) => !validUuid(id))) throw new Error('REA_ARTIFACT_ID_INVALID');
  const intakeDirectory = process.env.REA_ARTIFACT_INTAKE_DIR;
  if (!intakeDirectory) throw new Error('REA_ARTIFACT_INTAKE_DIRECTORY_NOT_CONFIGURED');
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL_NOT_CONFIGURED');
  const source = await readIntakeArtifact(intakeDirectory, options['--file']);
  const artifactDirectory = path.join(STATE_DIR, 'research', 'artifacts');
  pool = new Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5_000 });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const artifact = await importResearchArtifact(client, { worldId, grantAgentIds: options.grantAgentIds,
      artifactKey: options['--key'], displayName: options['--name'], targetType: options['--target'],
      mediaType: options['--media-type'], originReference: options['--origin-reference'],
      relations: options.relations, bytes: source.bytes, artifactDirectory });
    await client.query('COMMIT');
    console.log(JSON.stringify({ artifactId: artifact.id, artifactKey: artifact.artifactKey,
      targetType: artifact.targetType, byteSize: artifact.byteSize, sha256: artifact.sha256,
      intakeMethod: artifact.intakeMethod, originReference: artifact.originReference,
      relationCount: artifact.relationCount }));
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
} catch (error) {
  const code = String(error?.code || error?.message || 'REA_ARTIFACT_IMPORT_FAILED')
    .replace(/[^A-Z0-9_]/gi, '_').toUpperCase().slice(0, 96);
  console.error(JSON.stringify({ error: code || 'REA_ARTIFACT_IMPORT_FAILED', usage }));
  process.exitCode = 1;
} finally {
  await pool?.end();
}

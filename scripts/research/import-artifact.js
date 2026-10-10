import { Pool } from 'pg';
import path from 'node:path';
import { STATE_DIR } from '../../src/agent-runtime/client.js';
import { importResearchArtifact } from '../../src/research/artifacts.js';
import { readIntakeArtifact } from '../../src/research/artifact-intake.js';

const args = process.argv.slice(2);
const usage = 'Use --world UUID --file RELATIVE_PATH --target TYPE --key KEY --name NAME --media-type TYPE --grant-agent UUID [--grant-agent UUID ...].';

function parseArguments(values) {
  const output = { grantAgentIds: [] };
  const single = new Set(['--world','--file','--target','--key','--name','--media-type']);
  for (let index = 0; index < values.length; index += 1) {
    const flag = values[index];
    if (!single.has(flag) && flag !== '--grant-agent') throw new Error('REA_ARTIFACT_ARGUMENT_INVALID');
    const value = values[++index];
    if (!value || value.startsWith('--')) throw new Error('REA_ARTIFACT_ARGUMENT_MISSING');
    if (flag === '--grant-agent') output.grantAgentIds.push(value);
    else {
      if (output[flag]) throw new Error('REA_ARTIFACT_ARGUMENT_DUPLICATE');
      output[flag] = value;
    }
  }
  const keys = ['--world','--file','--target','--key','--name','--media-type'];
  if (keys.some((key) => !output[key]) || !output.grantAgentIds.length) throw new Error('REA_ARTIFACT_ARGUMENT_MISSING');
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
      mediaType: options['--media-type'], bytes: source.bytes, artifactDirectory });
    await client.query('COMMIT');
    console.log(JSON.stringify({ artifactId: artifact.id, artifactKey: artifact.artifactKey,
      targetType: artifact.targetType, byteSize: artifact.byteSize, sha256: artifact.sha256 }));
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

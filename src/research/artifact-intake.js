import { realpath, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { MAX_RESEARCH_ARTIFACT_BYTES } from './artifacts.js';

function intakeError(code) {
  return Object.assign(new Error(code), { code });
}

export async function readIntakeArtifact(intakeDirectory, relativePath) {
  if (typeof intakeDirectory !== 'string' || !path.isAbsolute(intakeDirectory)) {
    throw intakeError('REA_ARTIFACT_INTAKE_DIRECTORY_INVALID');
  }
  if (typeof relativePath !== 'string' || !relativePath.trim() || path.isAbsolute(relativePath)
      || relativePath.includes('\0')) throw intakeError('REA_ARTIFACT_INTAKE_PATH_INVALID');
  const root = await realpath(intakeDirectory);
  const candidate = path.resolve(root, relativePath);
  if (candidate === root || !candidate.startsWith(`${root}${path.sep}`)) {
    throw intakeError('REA_ARTIFACT_INTAKE_PATH_OUTSIDE_ROOT');
  }
  const resolved = await realpath(candidate);
  if (!resolved.startsWith(`${root}${path.sep}`)) throw intakeError('REA_ARTIFACT_INTAKE_PATH_OUTSIDE_ROOT');
  const info = await stat(resolved);
  if (!info.isFile()) throw intakeError('REA_ARTIFACT_INTAKE_NOT_REGULAR_FILE');
  if (info.size < 1 || info.size > MAX_RESEARCH_ARTIFACT_BYTES) {
    throw intakeError('REA_ARTIFACT_SIZE_INVALID');
  }
  const bytes = await readFile(resolved);
  if (bytes.length !== info.size) throw intakeError('REA_ARTIFACT_INTAKE_FILE_CHANGED');
  return { bytes, byteSize: info.size };
}

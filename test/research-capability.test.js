import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, symlink, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { buildCapabilityUseCandidates } from '../src/world-capabilities.js';
import { containsPrivateMaterial, MAX_RESEARCH_ARTIFACT_BYTES } from '../src/research/artifacts.js';
import { readIntakeArtifact } from '../src/research/artifact-intake.js';
import { normalizeResearchIntent, RESEARCH_CAPABILITY_KEY, RESEARCH_CAPABILITY_SPEC } from '../src/research/research-jobs.js';
import { isReaCompatibleNodeVersion } from '../src/research/rea-mcp-client.js';

test('REA is an optional native-system capability and only produces a candidate when a granted artifact and resident context exist', async () => {
  assert.equal(RESEARCH_CAPABILITY_SPEC.kind, 'native_system');
  assert.equal(RESEARCH_CAPABILITY_SPEC.systemKey, RESEARCH_CAPABILITY_KEY);
  const capability = { id: randomUUID(), name: 'Technical reverse-engineering research',
    specification: RESEARCH_CAPABILITY_SPEC };
  const agent = { agentId: randomUUID(), goals: [{ id: '41', goalType: 'primary', status: 'active' }],
    primaryGoal: 'Understand a dependency', curiosity: 0.7, skills: { research: 4 }, recentMemories: [] };
  assert.deepEqual(await buildCapabilityUseCandidates(agent, [capability], { researchInputs: {
    artifactsByAgent: new Map(), contextsByAgent: new Map() } }), [], 'no grant/context means no research candidate');
  const artifactId = randomUUID();
  const candidates = await buildCapabilityUseCandidates(agent, [capability], { worldMinutes: 100,
    researchInputs: { artifactsByAgent: new Map([[agent.agentId, [{ id: artifactId,
      displayName: 'Dependency source', targetType: 'javascript' }]]]),
    contextsByAgent: new Map([[agent.agentId, [{ relationType: 'goal', relationId: '41',
      label: 'LEARNING', objective: 'Understand a dependency before using it.' }]]]) } });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].action, 'capability_use');
  assert.equal(candidates[0].capabilityContext.researchIntent.artifactId, artifactId);
  assert.equal(candidates[0].capabilityContext.researchIntent.relationType, 'goal');
  assert.equal(candidates[0].capabilityContext.researchIntent.expectedResult.length > 0, true);
  assert.equal(candidates[0].researchJobId, undefined, 'candidate construction does not enqueue work');
});

test('research intent accepts only a granted artifact reference and typed active world relation', () => {
  const artifactId = randomUUID();
  const normalized = normalizeResearchIntent({ artifactId, targetType: 'source_code',
    researchQuestion: 'What security properties does this code show?',
    objective: 'Review the dependency before integration.', desiredInvestigation: 'Inspect exported entry points and trust boundaries.',
    expectedResult: 'A short summary with evidence and unresolved questions.', relationType: 'project', relationId: randomUUID() },
  { id: artifactId, targetType: 'source_code' });
  assert.equal(normalized.artifactId, artifactId);
  assert.equal(normalized.targetType, 'source_code');
  assert.throws(() => normalizeResearchIntent({ artifactId: '/etc/passwd', targetType: 'source_code' }),
    /REA_ARTIFACT_ID_INVALID/);
  assert.throws(() => normalizeResearchIntent({ artifactId, targetType: 'binary', researchQuestion: 'A sufficiently long question?',
    objective: 'A sufficiently long objective.', desiredInvestigation: 'Inspect safely.', expectedResult: 'Summary.' },
  { id: artifactId, targetType: 'source_code' }), /REA_TARGET_TYPE_MISMATCH/);
});

test('known private material is scanned through the entire artifact, not only its prefix', () => {
  const bytes = Buffer.concat([Buffer.alloc(1_100_000, 0x61), Buffer.from('\nPRIVATE_KEY=secret-material-123456789\n')]);
  assert.ok(bytes.length < MAX_RESEARCH_ARTIFACT_BYTES);
  assert.equal(containsPrivateMaterial(bytes), true);
  assert.equal(containsPrivateMaterial(Buffer.from('ordinary source code with a 0x1234 value')), false);
});

test('artifact intake refuses absolute, traversing, and symlink-resolved paths outside the staging directory', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'synterra-rea-intake-'));
  const outside = await mkdtemp(path.join(os.tmpdir(), 'synterra-rea-outside-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); });
  await mkdir(path.join(root, 'nested'));
  await writeFile(path.join(root, 'nested', 'sample.js'), 'export const answer = 42;');
  await writeFile(path.join(outside, 'secret.txt'), 'outside');
  await symlink(path.join(outside, 'secret.txt'), path.join(root, 'escape.txt'));
  assert.equal((await readIntakeArtifact(root, 'nested/sample.js')).bytes.toString(), 'export const answer = 42;');
  await assert.rejects(readIntakeArtifact(root, path.join(root, 'nested', 'sample.js')), /REA_ARTIFACT_INTAKE_PATH_INVALID/);
  await assert.rejects(readIntakeArtifact(root, '../synterra-rea-outside'), /REA_ARTIFACT_INTAKE_PATH_OUTSIDE_ROOT/);
  await assert.rejects(readIntakeArtifact(root, 'escape.txt'), /REA_ARTIFACT_INTAKE_PATH_OUTSIDE_ROOT/);
});

test('REA compatibility rejects the production Node 25 line and requires supported minor versions', () => {
  assert.equal(isReaCompatibleNodeVersion('v22.18.0'), false);
  assert.equal(isReaCompatibleNodeVersion('v22.19.0'), true);
  assert.equal(isReaCompatibleNodeVersion('v24.10.0'), false);
  assert.equal(isReaCompatibleNodeVersion('v24.21.0'), true);
  assert.equal(isReaCompatibleNodeVersion('v25.7.0'), false);
  assert.equal(isReaCompatibleNodeVersion('v26.0.0'), true);
});

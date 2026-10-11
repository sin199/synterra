import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, symlink, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { buildCapabilityUseCandidates } from '../src/world-capabilities.js';
import { createFruitflyRuntime } from '../src/agent-runtime/fruitfly.js';
import { containsPrivateMaterial, MAX_RESEARCH_ARTIFACT_BYTES } from '../src/research/artifacts.js';
import { readIntakeArtifact } from '../src/research/artifact-intake.js';
import { listResearchInputsByWorld, normalizeResearchIntent, RESEARCH_CAPABILITY_KEY, RESEARCH_CAPABILITY_SPEC } from '../src/research/research-jobs.js';
import { isReaCompatibleNodeVersion } from '../src/research/rea-mcp-client.js';

test('REA is optional and only produces candidates from explicit granted-artifact relation opportunities', async () => {
  assert.equal(RESEARCH_CAPABILITY_SPEC.kind, 'native_system');
  assert.equal(RESEARCH_CAPABILITY_SPEC.systemKey, RESEARCH_CAPABILITY_KEY);
  assert.match(RESEARCH_CAPABILITY_SPEC.agentInput.relation, /explicit_active/);
  const capability = { id: randomUUID(), name: 'Technical reverse-engineering research',
    specification: RESEARCH_CAPABILITY_SPEC };
  const agent = { agentId: 'agent-a', goals: [{ id: '41', goalType: 'primary', status: 'active' }],
    primaryGoal: 'Understand a dependency', curiosity: 0.7, skills: { research: 4 }, recentMemories: [] };
  assert.deepEqual(await buildCapabilityUseCandidates(agent, [capability], { researchInputs: {
    researchOpportunitiesByAgent: new Map() } }), [], 'a grant without an explicit relation does not make a candidate');
  const artifactId = randomUUID();
  const unrelatedAgent = randomUUID();
  const opportunity = { id: artifactId, displayName: 'Dependency source', targetType: 'javascript',
    relationType: 'goal', relationId: '41', label: 'LEARNING',
    objective: 'Understand a dependency before using it.', provenance: 'operator_intake' };
  const unrelated = await buildCapabilityUseCandidates(agent, [capability], { researchInputs: {
    researchOpportunitiesByAgent: new Map([[unrelatedAgent, [opportunity]]]) } });
  assert.deepEqual(unrelated, [], 'another Agent goal cannot be paired with this Agent grant');
  let sideEffects = 0;
  let cognitionCalls = 0;
  const candidates = await buildCapabilityUseCandidates(agent, [capability], { worldMinutes: 100,
    researchInputs: { researchOpportunitiesByAgent: new Map([[agent.agentId, [opportunity]]]) },
    chooseWithTypeSafe: async () => { cognitionCalls += 1; },
    recordJob: () => { sideEffects += 1; }, recordUsage: () => { sideEffects += 1; } });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].action, 'capability_use');
  assert.equal(candidates[0].capabilityContext.researchIntent.artifactId, artifactId);
  assert.equal(candidates[0].capabilityContext.researchIntent.relationType, 'goal');
  assert.equal(candidates[0].capabilityContext.researchIntent.relationId, '41');
  assert.equal(candidates[0].capabilityContext.researchIntent.expectedResult.length > 0, true);
  assert.equal(candidates[0].researchJobId, undefined, 'candidate construction does not enqueue work');
  assert.equal(sideEffects, 0, 'candidate construction does not create jobs or meter infrastructure');
  assert.equal(cognitionCalls, 0, 'candidate construction does not invoke a cognition provider');

  const fruitflyDirectory = await mkdtemp(path.join(os.tmpdir(), 'synterra-rea-fruitfly-'));
  try {
    const fruitfly = await createFruitflyRuntime(fruitflyDirectory);
    const rest = { id: 'ordinary-rest-candidate', action: 'rest', score: 100 };
    const selection = fruitfly.choose(agent.agentId,
      { self: { food: 20, energy: 90, social: 80 }, mind: { traits: { curiosity: 0.2 }, goals: [], skills: {} } },
      [candidates[0], rest], candidates[0]);
    assert.equal(selection.candidate.id, rest.id, 'Fruitfly can select another feasible action over REA');
  } finally { await rm(fruitflyDirectory, { recursive: true, force: true }); }

  const secondArtifactId = randomUUID();
  const secondGoalId = '42';
  const exactPairs = await buildCapabilityUseCandidates(agent, [capability], { researchInputs: {
    researchOpportunitiesByAgent: new Map([
      [agent.agentId, [opportunity, { ...opportunity, id: secondArtifactId, relationId: secondGoalId }]]
    ]) } });
  assert.deepEqual(exactPairs.map((item) => [item.capabilityContext.researchIntent.artifactId,
    item.capabilityContext.researchIntent.relationId]), [[artifactId, '41'], [secondArtifactId, secondGoalId]]);
  assert.notEqual(exactPairs[0].id, exactPairs[1].id, 'each explicit pair has a distinct candidate identity');
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
  assert.equal(normalized.relationType, 'project');
  assert.throws(() => normalizeResearchIntent({ artifactId, targetType: 'source_code',
    researchQuestion: 'What security properties does this code show?',
    objective: 'Review the dependency before integration.', desiredInvestigation: 'Inspect safely.',
    expectedResult: 'A short bounded summary.' }, { id: artifactId, targetType: 'source_code' }), /REA_RELATION_ID_INVALID/);
  assert.throws(() => normalizeResearchIntent({ artifactId: '/etc/passwd', targetType: 'source_code' }),
    /REA_ARTIFACT_ID_INVALID/);
  assert.throws(() => normalizeResearchIntent({ artifactId, targetType: 'binary', researchQuestion: 'A sufficiently long question?',
    objective: 'A sufficiently long objective.', desiredInvestigation: 'Inspect safely.', expectedResult: 'Summary.',
    relationType: 'goal', relationId: '41' },
  { id: artifactId, targetType: 'source_code' }), /REA_TARGET_TYPE_MISMATCH/);
});

test('research-input query joins artifact grant, explicit binding, and active relation membership in one result', async () => {
  const queries = [];
  const inputs = await listResearchInputsByWorld({ query: async (sql) => { queries.push(sql); return { rows: [] }; } },
    { worldId: randomUUID() });
  assert.equal(queries.length, 1);
  assert.match(queries[0], /WITH active_relation_contexts AS/);
  assert.match(queries[0], /JOIN world_research_artifact_grants/);
  assert.match(queries[0], /FROM world_research_artifact_relations/);
  assert.match(queries[0], /project\.status='active' AND member\.status='active'/);
  assert.match(queries[0], /business\.founder_agent_id/);
  assert.match(queries[0], /employment\.status='active'/);
  assert.match(queries[0], /organization\.status='active' AND member\.status='active'/);
  assert.equal(inputs.researchOpportunitiesByAgent.size, 0);
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

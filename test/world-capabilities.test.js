import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildCapabilityUseCandidates, validateCapabilitySpecification } from '../src/world-capabilities.js';
import { fruitflyFamily } from '../src/social-world.js';

const residentId = '10000000-0000-4000-8000-000000000001';
const partnerId = '10000000-0000-4000-8000-000000000002';

function capabilitySpec(overrides = {}) {
  return {
    schemaVersion: 1,
    kind: 'composition',
    composition: [],
    steps: [{ primitive: 'resident.knowledge_gain', amount: 2 }],
    requirements: { minEnergy: 20, minFood: 8, skills: {} },
    costs: [{ resource: 'energy', amount: 2 }, { resource: 'food', amount: 1 }],
    participants: { minimum: 1, maximum: 1 },
    durationWorldMinutes: 15,
    scope: { type: 'resident_set' },
    risks: [],
    ...overrides
  };
}

test('capability specifications support extensible compositions of allowlisted effects', () => {
  const primitiveCapabilityId = randomUUID();
  const specification = validateCapabilitySpecification(capabilitySpec({
    composition: [{ capabilityId: primitiveCapabilityId, parameters: { amount: 3 } }],
    steps: [{ primitive: 'resident.skill_gain', skill: 'research', amount: 1.5 }],
    evolvesCapabilityId: randomUUID()
  }));

  assert.equal(specification.kind, 'composition');
  assert.equal(specification.composition[0].capabilityId, primitiveCapabilityId);
  assert.equal(specification.steps[0].primitive, 'resident.skill_gain');
  assert.equal(specification.evolvesCapabilityId.length, 36);
  assert.throws(() => validateCapabilitySpecification(capabilitySpec({
    steps: [{ primitive: 'run_arbitrary_code', source: 'process.exit()' }]
  })), { message: 'CAPABILITY_PRIMITIVE_UNSUPPORTED', statusCode: 400 });
});

test('adopted capabilities enter the future resident choice set and use an existing Fruitfly family', async () => {
  const capabilityId = randomUUID();
  const candidate = (await buildCapabilityUseCandidates({
    agentId: residentId, location: 'Library', energy: 90, food: 80,
    primaryGoal: 'MASTER_RESEARCH', curiosity: 0.9,
    skills: { research: 80 }, recentMemories: []
  }, [{ id: capabilityId, name: 'Shared Research Practice', description: 'A resident-created research practice.',
    category: 'learning.research', status: 'active', version: 1,
    specification: capabilitySpec(), experimentScope: {}, experimentStatus: null, experimentId: null }],
  { worldMinutes: 20_000, maxAlternativeScore: 100 }))[0];

  assert.equal(candidate.action, 'capability_use');
  assert.equal(candidate.capabilityId, capabilityId);
  assert.equal(candidate.capabilityExperimentId, null);
  assert.ok(candidate.score >= 75, 'a curious, research-aligned resident can pass the unchanged utility threshold');
  assert.equal(fruitflyFamily(candidate), 'business_learn');
});

test('experimental capabilities remain limited to named participants until adoption', async () => {
  const capabilityId = randomUUID();
  const row = { id: capabilityId, name: 'Bounded Practice', description: 'A bounded capability experiment.',
    category: 'learning.research', status: 'experimental', version: 1, experimentId: randomUUID(),
    experimentStatus: 'running', specification: capabilitySpec(),
    experimentScope: { scopeType: 'resident_set', scopeId: null, participantAgentIds: [residentId, partnerId] } };
  const resident = { agentId: '10000000-0000-4000-8000-000000000003', location: 'Library', energy: 90, food: 80,
    curiosity: 0.8, skills: {}, recentMemories: [] };
  const excluded = await buildCapabilityUseCandidates(resident, [row], { worldMinutes: 20_000 });
  assert.equal(excluded.length, 0);

  const participant = await buildCapabilityUseCandidates({ ...resident, agentId: partnerId }, [row], { worldMinutes: 20_000 });
  assert.equal(participant.length, 1);
  assert.equal(participant[0].capabilityExperimentId, row.experimentId);
});

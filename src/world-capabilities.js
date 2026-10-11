import { createHash } from 'node:crypto';
import { ensureEconomicAccount, ensureResidentEconomicAccounts, transferBetweenAccounts } from './economic-ledger.js';
import { parsePositiveUnits } from './units.js';
import { actionIdentifier, boundedNumber, jsonObject, requireWorldMember, requiredText, worldError, writeWorldHistory } from './world-domain.js';
import { isGenesisCurrencyActive } from './genesis-economy.js';
import { contributeOrganizationEffort } from './world-organizations.js';
import { contributeToProject } from './world-projects.js';
import { capabilityGraphDepth, recordWorldCapabilityDependencies } from './world-v7.js';
import { RESEARCH_CAPABILITY_KEY, RESEARCH_CAPABILITY_SPEC } from './research/research-jobs.js';

export const CIVILIZATION_REVIEW_INTERVAL_MINUTES = 7 * 1_440;
export const EXPERIMENT_DURATION_MINUTES = 14 * 1_440;
export const CAPABILITY_PROPOSAL_LIFETIME_MINUTES = 30 * 1_440;
export const CAPABILITY_GAP_MIN_OBSERVATIONS = 2;
export const CAPABILITY_GAP_MIN_AGE_MINUTES = 1_440;
const MAX_SPEC_BYTES = 16_000;
const MAX_COMPOSITION_DEPTH = 5;
const MAX_EXPERIMENT_PARTICIPANTS = 8;
const ACTIVE_EXPERIMENT_STATES = ['running'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SKILLS = new Set(['research', 'engineering', 'social', 'trading']);
const RESOURCES = new Set(['energy', 'food', 'simulated_usdc']);
const PRIMITIVES = new Set([
  'resident.skill_gain', 'resident.knowledge_gain', 'relationship.adjust',
  'organization.contribute', 'project.contribute'
]);

const CORE_CAPABILITIES = [
  ['employment', 'economy.labor', 'Employment', 'Residents can offer, accept, and perform paid work.'],
  ['business', 'economy.enterprise', 'Business', 'Residents can create and operate businesses.'],
  ['service_purchase', 'economy.exchange', 'Service purchase', 'Customers can discover, purchase, and consume business services.'],
  ['investment', 'economy.capital', 'Investment', 'Residents can invest simulated resources in projects and businesses.'],
  ['project', 'collaboration.project', 'Project', 'Residents can propose, join, and complete shared projects.'],
  ['organization', 'institution.organization', 'Organization', 'Residents can form organizations with members and resources.'],
  ['agreement', 'institution.contract', 'Agreement', 'Residents can propose, negotiate, and execute agreements.'],
  ['negotiation', 'institution.negotiation', 'Negotiation', 'Residents can accept, reject, or counter proposed terms.'],
  ['governance', 'institution.governance', 'Governance', 'Organizations can propose and decide internal rules.'],
  ['norm', 'institution.norm', 'Norm', 'Repeated interactions can form durable social expectations.'],
  ['place_creation', 'world.place', 'Place creation', 'Residents and projects can create shared places.'],
  ['information_sharing', 'social.information', 'Information sharing', 'Residents can share and assess information.'],
  ['market_observation', 'economy.market_observation', 'Market observation', 'Residents can observe demand and supply signals.'],
  [RESEARCH_CAPABILITY_KEY, 'learning.technical_research', 'Technical reverse-engineering research',
    'Residents can request bounded, evidence-based research on artifacts made available to them.']
];

const PRIMITIVE_CAPABILITIES = [
  ['resident.skill_gain', 'resident.learning', 'Resident skill gain', 'Increase a resident skill from a completed capability use.'],
  ['resident.knowledge_gain', 'resident.learning', 'Resident knowledge gain', 'Increase resident knowledge from a completed capability use.'],
  ['relationship.adjust', 'social.relationship', 'Relationship adjustment', 'Change a participant relationship through an audited interaction.'],
  ['organization.contribute', 'institution.organization', 'Organization effort', 'Contribute bounded effort to an active organization.'],
  ['project.contribute', 'collaboration.project', 'Project effort', 'Contribute bounded effort to an active project.']
];

const clamp = (value, low, high) => Math.max(low, Math.min(high, Number(value) || 0));
const stableUnit = (value) => createHash('sha256').update(String(value)).digest().readUInt32BE(0) / 0xffffffff;
const jsonValue = (value, fallback = {}) => {
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch { return fallback; }
  }
  return value && typeof value === 'object' ? value : fallback;
};
const memorySummary = (value) => String(value || '').slice(0, 240);
function stableUuid(...parts) {
  const bytes = createHash('sha256').update(`synterra-v6:${JSON.stringify(parts)}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function capabilityError(code, statusCode = 409) {
  return worldError(code, statusCode);
}

function normalizedCategory(value) {
  const category = requiredText(value, 2, 80, 'capability_category').toLowerCase().replaceAll(' ', '_');
  if (!/^[a-z][a-z0-9_.-]{1,79}$/.test(category)) throw capabilityError('CAPABILITY_CATEGORY_INVALID', 400);
  return category;
}

function normalizePrimitiveStep(value, field = 'capability_step') {
  const step = jsonObject(value, field);
  if (!PRIMITIVES.has(step.primitive)) throw capabilityError('CAPABILITY_PRIMITIVE_UNSUPPORTED', 400);
  const target = step.target ?? 'actor';
  if (!['actor', 'partner'].includes(target)) throw capabilityError('CAPABILITY_TARGET_INVALID', 400);
  if (target === 'partner' && step.primitive === 'resident.knowledge_gain') {
    throw capabilityError('CAPABILITY_TARGET_INVALID', 400);
  }
  if (step.primitive === 'resident.skill_gain') {
    const skill = String(step.skill || '');
    if (!SKILLS.has(skill)) throw capabilityError('CAPABILITY_SKILL_INVALID', 400);
    return { primitive: step.primitive, target, skill,
      amount: boundedNumber(step.amount ?? 1, 0.1, 5, 'capability_skill_gain') };
  }
  if (step.primitive === 'resident.knowledge_gain') return { primitive: step.primitive, target,
    amount: boundedNumber(step.amount ?? 1, 0.1, 10, 'capability_knowledge_gain') };
  if (step.primitive === 'relationship.adjust') {
    if (target !== 'partner') throw capabilityError('CAPABILITY_TARGET_INVALID', 400);
    const adjustment = {};
    for (const key of ['trust', 'affinity', 'familiarity']) {
      if (step[key] !== undefined) adjustment[key] = boundedNumber(step[key], -5, 5, `relationship_${key}`);
    }
    if (!Object.keys(adjustment).length) throw capabilityError('CAPABILITY_EFFECT_REQUIRED', 400);
    return { primitive: step.primitive, target, ...adjustment };
  }
  if (step.primitive === 'organization.contribute') return { primitive: step.primitive, target: 'actor',
    effort: boundedNumber(step.effort ?? 1, 0.1, 20, 'organization_effort') };
  if (step.primitive === 'project.contribute') {
    const contributionType = String(step.contributionType || 'work');
    if (!['work', 'research', 'learning', 'planning', 'resource', 'place'].includes(contributionType)) {
      throw capabilityError('CAPABILITY_PROJECT_CONTRIBUTION_INVALID', 400);
    }
    return { primitive: step.primitive, target: 'actor', contributionType,
      skillValue: boundedNumber(step.skillValue ?? 0, 0, 100, 'project_skill_value') };
  }
  throw capabilityError('CAPABILITY_PRIMITIVE_UNSUPPORTED', 400);
}

export function validateCapabilitySpecification(value) {
  const input = jsonObject(value, 'capability_specification');
  if (Buffer.byteLength(JSON.stringify(input), 'utf8') > MAX_SPEC_BYTES) throw capabilityError('CAPABILITY_SPEC_TOO_LARGE', 400);
  if (Number(input.schemaVersion) !== 1 || !['composition', 'primitive', 'native_system'].includes(input.kind)) {
    throw capabilityError('CAPABILITY_SPEC_VERSION_OR_KIND_INVALID', 400);
  }
  if (input.kind === 'primitive') {
    const primitiveId = String(input.primitiveId || '');
    if (!PRIMITIVES.has(primitiveId)) throw capabilityError('CAPABILITY_PRIMITIVE_UNSUPPORTED', 400);
    return { ...input, schemaVersion: 1, kind: 'primitive', primitiveId };
  }
  if (input.kind === 'native_system') return { ...input, schemaVersion: 1, kind: 'native_system' };

  const composition = input.composition === undefined ? [] : input.composition;
  if (!Array.isArray(composition) || composition.length > 8) throw capabilityError('CAPABILITY_COMPOSITION_INVALID', 400);
  const normalizedComposition = composition.map((entry) => {
    const item = jsonObject(entry, 'capability_composition');
    if (!UUID_RE.test(String(item.capabilityId || ''))) throw capabilityError('CAPABILITY_PARENT_INVALID', 400);
    const parameters = jsonObject(item.parameters, 'capability_parameters');
    if ('primitive' in parameters || 'primitiveId' in parameters) throw capabilityError('CAPABILITY_PARAMETER_INVALID', 400);
    return { capabilityId: String(item.capabilityId), parameters };
  });
  const steps = input.steps === undefined ? [] : input.steps;
  if (!Array.isArray(steps) || steps.length > 16 || (!normalizedComposition.length && !steps.length)) {
    throw capabilityError('CAPABILITY_STEPS_INVALID', 400);
  }
  const normalizedSteps = steps.map((step) => normalizePrimitiveStep(step));
  const requirements = jsonObject(input.requirements, 'capability_requirements');
  const skills = jsonObject(requirements.skills, 'capability_skills');
  const normalizedSkills = {};
  for (const [skill, level] of Object.entries(skills)) {
    if (!SKILLS.has(skill)) throw capabilityError('CAPABILITY_SKILL_INVALID', 400);
    normalizedSkills[skill] = boundedNumber(level, 0, 100, `required_${skill}`);
  }
  if (requirements.partnerRequired !== undefined && typeof requirements.partnerRequired !== 'boolean') {
    throw capabilityError('CAPABILITY_PARTNER_REQUIREMENT_INVALID', 400);
  }
  const normalizedRequirements = {
    minEnergy: boundedNumber(requirements.minEnergy ?? 20, 0, 100, 'capability_min_energy'),
    minFood: boundedNumber(requirements.minFood ?? 8, 0, 100, 'capability_min_food'),
    skills: normalizedSkills,
    partnerRequired: Boolean(requirements.partnerRequired)
  };
  const costs = input.costs === undefined ? [] : input.costs;
  if (!Array.isArray(costs) || costs.length > 8) throw capabilityError('CAPABILITY_COSTS_INVALID', 400);
  const normalizedCosts = costs.map((cost) => {
    const item = jsonObject(cost, 'capability_cost');
    if (!RESOURCES.has(item.resource)) throw capabilityError('CAPABILITY_RESOURCE_UNSUPPORTED', 400);
    const amount = item.resource === 'simulated_usdc'
      ? requiredText(String(item.amount ?? ''), 1, 48, 'simulated_usdc_cost')
      : boundedNumber(item.amount, 0.1, 100, 'capability_cost');
    if (item.resource === 'simulated_usdc') {
      let units;
      try { units = parsePositiveUnits(amount); } catch { throw capabilityError('CAPABILITY_RESOURCE_AMOUNT_INVALID', 400); }
      if (units > parsePositiveUnits('1000')) throw capabilityError('CAPABILITY_RESOURCE_AMOUNT_INVALID', 400);
      if (!['actor', 'partner'].includes(item.payer || 'actor') || !['actor', 'partner'].includes(item.beneficiary || 'partner')) {
        throw capabilityError('CAPABILITY_SETTLEMENT_INVALID', 400);
      }
      if ((item.payer || 'actor') === (item.beneficiary || 'partner')) throw capabilityError('CAPABILITY_SETTLEMENT_INVALID', 400);
      return { resource: item.resource, amount, payer: item.payer || 'actor', beneficiary: item.beneficiary || 'partner' };
    }
    return { resource: item.resource, amount };
  });
  const participants = jsonObject(input.participants, 'capability_participants');
  const minParticipants = Math.trunc(boundedNumber(participants.minimum ?? 1, 1, 4, 'minimum_participants'));
  const maxParticipants = Math.trunc(boundedNumber(participants.maximum ?? Math.max(2, minParticipants), minParticipants, 4, 'maximum_participants'));
  const experiment = input.experiment === undefined ? {} : jsonObject(input.experiment, 'capability_experiment');
  const maximumExperimentParticipants = Math.trunc(boundedNumber(experiment.maximumParticipants ?? 4,
    2, MAX_EXPERIMENT_PARTICIPANTS, 'maximum_experiment_participants'));
  const durationWorldMinutes = Math.trunc(boundedNumber(input.durationWorldMinutes ?? 15, 5, 240, 'capability_duration'));
  const scope = input.scope === undefined ? { type: 'resident_set' } : jsonObject(input.scope, 'capability_scope');
  if (!['resident_set', 'organization', 'project', 'place'].includes(scope.type)) throw capabilityError('CAPABILITY_SCOPE_INVALID', 400);
  if (scope.id !== undefined && !UUID_RE.test(String(scope.id))) throw capabilityError('CAPABILITY_SCOPE_INVALID', 400);
  if (scope.type !== 'resident_set' && !scope.id) throw capabilityError('CAPABILITY_SCOPE_INVALID', 400);
  const evolvesCapabilityId = input.evolvesCapabilityId === undefined ? null : String(input.evolvesCapabilityId);
  if (evolvesCapabilityId && !UUID_RE.test(evolvesCapabilityId)) throw capabilityError('CAPABILITY_PARENT_INVALID', 400);
  if ((normalizedRequirements.partnerRequired || minParticipants > 1)
      && maxParticipants < 2) throw capabilityError('CAPABILITY_PARTICIPANT_RANGE_INVALID', 400);
  const risks = input.risks === undefined ? [] : input.risks;
  if (!Array.isArray(risks) || risks.length > 8) throw capabilityError('CAPABILITY_RISKS_INVALID', 400);
  const normalizedRisks = risks.map((risk) => requiredText(risk, 3, 180, 'capability_risk'));
  const partnerEffect = normalizedComposition.some((item) => item.parameters.target === 'partner')
    || normalizedSteps.some((step) => step.target === 'partner')
    || normalizedCosts.some((cost) => cost.resource === 'simulated_usdc'
      && (cost.payer === 'partner' || cost.beneficiary === 'partner'));
  if (partnerEffect && minParticipants < 2) throw capabilityError('CAPABILITY_PARTICIPANTS_REQUIRED', 400);
  return {
    ...input,
    schemaVersion: 1,
    kind: 'composition',
    ...(evolvesCapabilityId ? { evolvesCapabilityId } : {}),
    composition: normalizedComposition,
    steps: normalizedSteps,
    requirements: normalizedRequirements,
    costs: normalizedCosts,
    participants: { minimum: minParticipants, maximum: maxParticipants },
    experiment: { maximumParticipants: maximumExperimentParticipants },
    durationWorldMinutes,
    scope: { type: scope.type, ...(scope.id ? { id: String(scope.id) } : {}) },
    risks: normalizedRisks
  };
}

async function writeCapabilityEvent(client, { worldId, actorAgentId = null, gapId = null, proposalId = null,
  capabilityId = null, experimentId = null, eventType, eventKey, worldMinute, details = {} }) {
  await client.query(`INSERT INTO world_capability_events(world_id,actor_agent_id,gap_id,proposal_id,capability_id,
      experiment_id,event_type,event_key,world_minute,details)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb) ON CONFLICT(world_id,event_key) DO NOTHING`,
  [worldId, actorAgentId, gapId, proposalId, capabilityId, experimentId, eventType, eventKey,
    Math.max(0, Math.trunc(Number(worldMinute) || 0)), JSON.stringify(details)]);
}

async function writeCivilizationDecisionTrace(client, { worldId, agentId, worldMinute, sourceKey,
  choiceType, selected, options, state = {} }) {
  const candidateId = String(selected?.id || 'ignore').slice(0, 180);
  const source = selected?._decisionSource || 'resident_action';
  const confidence = Number(selected?._decisionConfidence);
  const cycleKey = actionIdentifier(`civil:${createHash('sha256').update(sourceKey).digest('hex').slice(0, 40)}`);
  const utilityScores = Object.fromEntries(options.slice(0, 80).map((option) => [String(option.id).slice(0, 120),
    Number.isFinite(Number(option.score)) ? Number(option.score) : 0]));
  await client.query(`INSERT INTO world_decision_traces(world_id,agent_id,tick_count,world_minutes,chosen_candidate_id,
      chosen_action,behavior_probability,distribution,utility_scores,goal_snapshot,rationale,source_key)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10::jsonb,$11::jsonb,$12)
    ON CONFLICT(world_id,source_key) WHERE source_key IS NOT NULL DO NOTHING`,
  [worldId, agentId, Math.floor(Math.max(0, Number(worldMinute) || 0) / 1_440),
    Math.max(0, Math.trunc(Number(worldMinute) || 0)), candidateId, `civilization_${choiceType}`,
    Number.isFinite(confidence) ? clamp(confidence, 0.00000001, 1) : 1,
    JSON.stringify({ layer: 'civilizational', source, optionCount: options.length, choiceType }),
    JSON.stringify(utilityScores), JSON.stringify({ goal: state.residentGoal || state.relevantGoal || null,
      skills: state.skills || state.relevantSkills || {} }),
    JSON.stringify({ selectedOption: candidateId, evidence: state.evidence || {}, gapId: state.gapId || null,
      proposalId: state.proposalId || null, motivation: Number(state.motivation) || 0 }), cycleKey]);
}

export async function seedWorldCapabilityRegistry(client, worldId) {
  const ids = new Map();
  for (const [key, category, name, description] of [...CORE_CAPABILITIES,
    ...PRIMITIVE_CAPABILITIES.map(([primitive, category, name, description]) => [`primitive:${primitive}`, category, name, description])]) {
    const primitiveId = key.startsWith('primitive:') ? key.slice('primitive:'.length) : null;
    const id = stableUuid(worldId, 'registry', key, 1);
    const result = await client.query(`INSERT INTO world_capabilities(id,world_id,capability_key,category,name,description,status,
        version,creator_type,specification,created_world_minute,metadata)
      VALUES($1,$2,$3,$4,$5,$6,'active',1,'system',$7::jsonb,0,$8::jsonb)
      ON CONFLICT(world_id,capability_key,version) DO NOTHING RETURNING id`,
    [id, worldId, key, category, name, description, JSON.stringify(primitiveId
      ? { schemaVersion: 1, kind: 'primitive', primitiveId }
      : key === RESEARCH_CAPABILITY_KEY ? RESEARCH_CAPABILITY_SPEC
        : { schemaVersion: 1, kind: 'native_system', systemKey: key }),
    JSON.stringify({ systemProvided: true, v6Baseline: true })]);
    const selected = result.rows[0]?.id || (await client.query(`SELECT id FROM world_capabilities
      WHERE world_id=$1 AND capability_key=$2 AND version=1`, [worldId, key])).rows[0]?.id;
    if (selected) ids.set(key, selected);
  }
  return ids;
}

export async function initializeWorldCivilization(client, { worldId, worldMinute = 0 }) {
  const existing = await client.query(`SELECT id,started_world_minute AS "startedWorldMinute",started_at AS "startedAt"
    FROM world_epochs WHERE world_id=$1 AND epoch_code='V6'`, [worldId]);
  const firstStart = existing.rowCount === 0;
  const startMinute = firstStart ? Math.max(0, Math.trunc(Number(worldMinute) || 0))
    : Number(existing.rows[0].startedWorldMinute);
  const newerEpoch = await client.query(`SELECT 1 FROM world_epochs WHERE world_id=$1 AND status='active'
    AND substring(epoch_code from '^V([0-9]+)')::int>6 LIMIT 1`, [worldId]);
  await client.query(`UPDATE world_epochs SET status='historic' WHERE world_id=$1 AND status='active'
    AND substring(epoch_code from '^V([0-9]+)')::int<6`, [worldId]);
  const epochResult = await client.query(`INSERT INTO world_epochs(world_id,epoch_code,name,status,started_world_minute,description,metadata)
    VALUES($1,'V6','Agent-Built Civilization',$3,$2,
      'Residents can propose, evaluate, experiment with, and evolve world capabilities.',
      '{"source":"civilization_upgrade"}'::jsonb)
    ON CONFLICT(world_id,epoch_code) DO UPDATE SET status=CASE WHEN $3='active' THEN 'active' ELSE world_epochs.status END
    RETURNING id,epoch_code AS code,name,status,started_world_minute AS "startedWorldMinute",started_at AS "startedAt",description`,
  [worldId, startMinute, newerEpoch.rowCount ? 'historic' : 'active']);
  const epoch = epochResult.rows[0];
  await seedWorldCapabilityRegistry(client, worldId);
  if (firstStart) {
    await writeWorldHistory(client, { worldId, eventKey: 'world-epoch:V6', eventType: 'world_epoch_started',
      actorAgentId: null, entityType: 'world', entityId: worldId, worldTime: startMinute,
      title: 'Synterra entered V6 — Agent-Built Civilization',
      detail: 'Synterra entered a new era in which residents can propose changes to the world’s capabilities and institutions.',
      metadata: { epochCode: 'V6', phase: 'AGENT_BUILT_CIVILIZATION' } });
    await writeCapabilityEvent(client, { worldId, eventType: 'world_epoch_started', eventKey: 'world-epoch:V6',
      worldMinute: startMinute, details: { epochCode: 'V6', phase: 'AGENT_BUILT_CIVILIZATION' } });
  }
  const awareness = await client.query(`INSERT INTO agent_memories(world_id,agent_id,memory_type,summary,importance,world_minutes,
      location,metadata,consolidation_key,long_term)
    SELECT member.world_id,member.agent_id,'civilization',
      'Synterra entered a new era in which residents can propose changes to the world’s capabilities and institutions.',
      0.62,$2,member.location,jsonb_build_object('epochCode','V6','informationalOnly',true),
      'world_epoch:V6',true
    FROM world_members member WHERE member.world_id=$1
    ON CONFLICT (world_id,agent_id,consolidation_key) WHERE (consolidation_key LIKE 'world_epoch:%') DO NOTHING
    RETURNING agent_id`, [worldId, startMinute]);
  return { epoch, firstStart, awarenessAdded: awareness.rowCount };
}

function addGap(map, gap) {
  const existing = map.get(gap.gapKey);
  if (!existing) map.set(gap.gapKey, gap);
  else existing.evidence = { ...existing.evidence, ...gap.evidence };
}

export async function observeWorldCapabilityGaps(client, { worldId, worldMinute }) {
  const currentMinute = Math.max(0, Math.trunc(Number(worldMinute) || 0));
  const fromDay = Math.max(0, Math.floor(currentMinute / 1_440) - 13);
  const observed = new Map();
  const market = await client.query(`SELECT service_type AS "serviceType",sum(unmet_count)::int AS "unmetUnits",
      count(*) FILTER (WHERE unmet_count>0)::int AS "shortageDays",min(world_day)::bigint AS "firstDay",
      max(world_day)::bigint AS "lastDay",sum(demand_count)::int AS "demandCount"
    FROM world_economic_demand WHERE world_id=$1 AND world_day BETWEEN $2 AND $3 AND unmet_count>0
    GROUP BY service_type HAVING count(*) FILTER (WHERE unmet_count>0)>=2 OR sum(unmet_count)>=8
    ORDER BY sum(unmet_count) DESC,service_type LIMIT 12`, [worldId, fromDay, Math.floor(currentMinute / 1_440)]);
  for (const row of market.rows) {
    const category = `market.${String(row.serviceType).replace(/[^a-z0-9_.-]/gi, '_').toLowerCase()}`;
    addGap(observed, { gapKey: `unmet-demand:${row.serviceType}`, category,
      problemStatement: `Repeated unmet ${row.serviceType} demand shows a service capacity gap.`,
      evidence: { source: 'world_economic_demand', serviceType: row.serviceType, unmetUnits: Number(row.unmetUnits),
        shortageDays: Number(row.shortageDays), demandCount: Number(row.demandCount), firstDay: Number(row.firstDay), lastDay: Number(row.lastDay) } });
  }
  const failedProjects = await client.query(`SELECT project.id,project.title,project.project_type AS "projectType",
      project.goal,project.updated_world_time AS "updatedWorldTime",project.organization_id AS "organizationId"
    FROM world_projects project WHERE project.world_id=$1 AND project.status IN ('failed','abandoned')
      AND project.updated_world_time >= $2 ORDER BY project.updated_world_time DESC,project.id LIMIT 12`,
  [worldId, Math.max(0, currentMinute - 43_200)]);
  for (const row of failedProjects.rows) addGap(observed, { gapKey: `failed-project:${row.id}`,
    category: 'collaboration.project_delivery',
    problemStatement: `Project “${String(row.title).slice(0, 140)}” ended without reaching its intended result.`,
    evidence: { source: 'world_projects', projectId: row.id, projectType: row.projectType,
      goal: row.goal, organizationId: row.organizationId } });

  const blockers = await client.query(`SELECT reason_code AS "reasonCode",system,count(*)::int AS count
    FROM world_emergence_events WHERE world_id=$1 AND world_minutes >= $2
      AND stage='blocked' AND reason_code IN ('NO_CAPABILITY','CAPACITY','NO_PARTNER')
    GROUP BY reason_code,system HAVING count(*)>=2 ORDER BY count DESC LIMIT 8`,
  [worldId, Math.max(0, currentMinute - 20_160)]);
  for (const row of blockers.rows) addGap(observed, { gapKey: `repeated-blocker:${row.system}:${row.reasonCode}`,
    category: `${String(row.system).replace(/[^a-z0-9_.-]/gi, '_').toLowerCase()}.execution_gap`,
    problemStatement: `Repeated ${row.reasonCode} blockers show that current world capabilities do not cover some resident actions.`,
    evidence: { source: 'world_emergence_events', system: row.system, reasonCode: row.reasonCode, occurrences: Number(row.count) } });

  const persisted = [];
  for (const gap of observed.values()) {
    const result = await client.query(`INSERT INTO world_capability_gaps(id,world_id,gap_key,category,problem_statement,
        first_observed_world_minute,last_observed_world_minute,evidence)
      VALUES($1,$2,$3,$4,$5,$6,$6,$7::jsonb)
      ON CONFLICT(world_id,gap_key) DO UPDATE SET
        observation_count=world_capability_gaps.observation_count+
          CASE WHEN world_capability_gaps.last_observed_world_minute/1440 < EXCLUDED.last_observed_world_minute/1440 THEN 1 ELSE 0 END,
        last_observed_world_minute=GREATEST(world_capability_gaps.last_observed_world_minute,EXCLUDED.last_observed_world_minute),
        problem_statement=EXCLUDED.problem_statement,evidence=EXCLUDED.evidence,
        status=CASE WHEN world_capability_gaps.status='resolved' THEN 'open' ELSE world_capability_gaps.status END,updated_at=now()
      RETURNING id,gap_key AS "gapKey",category,problem_statement AS "problemStatement",status,observation_count AS "observationCount",
        first_observed_world_minute AS "firstObservedWorldMinute",last_observed_world_minute AS "lastObservedWorldMinute",evidence`,
    [stableUuid(worldId, 'gap', gap.gapKey), worldId, gap.gapKey, gap.category, gap.problemStatement,
      currentMinute, JSON.stringify(gap.evidence)]);
    const row = result.rows[0];
    if (row) persisted.push(row);
  }
  return persisted;
}

function residentRelevantToGap(agent, gap) {
  const category = String(gap.category || '').toLowerCase();
  const skills = agent.skills || {};
  const memories = agent.recentMemories || [];
  const hasEconomicContext = memories.some((memory) => ['business','economic','contract','project','failure'].includes(memory.memoryType))
    || Number(skills.research) >= 15 || Number(skills.trading) >= 15 || Number(skills.engineering) >= 25
    || (agent.activeProjects || []).length > 0 || (agent.organizationMemberships || []).length > 0;
  const highCuriosity = Number(agent.curiosity ?? agent.traits?.curiosity) >= 0.62;
  if (category.startsWith('market.')) return hasEconomicContext || (highCuriosity && Number(agent.knowledge) >= 35);
  if (category.startsWith('collaboration.')) return (agent.activeProjects || []).length > 0
    || memories.some((memory) => ['project','cooperation','failure'].includes(memory.memoryType)) || highCuriosity;
  return highCuriosity || hasEconomicContext;
}

async function noteGapForResident(client, { worldId, agent, gap, worldMinute }) {
  if (!residentRelevantToGap(agent, gap)) return false;
  const day = Math.floor(Number(worldMinute) / 1_440);
  const result = await client.query(`INSERT INTO world_capability_observations(world_id,gap_id,agent_id,observed_world_day,
      observed_world_minute,observation_path,evidence)
    VALUES($1,$2,$3,$4,$5,$6,$7::jsonb) ON CONFLICT(world_id,gap_id,agent_id,observed_world_day) DO NOTHING
    RETURNING id`, [worldId, gap.id, agent.agentId, day, worldMinute,
    String(gap.category).startsWith('market.') ? 'public_market_and_prior_experience' : 'memory_goal_and_social_context',
    JSON.stringify({ goal: agent.primaryGoal || agent.goal, knowledge: agent.knowledge,
      relevantSkills: Object.fromEntries(Object.entries(agent.skills || {}).filter(([key]) => ['research','trading','engineering','social'].includes(key))) })]);
  if (!result.rowCount) return false;
  const prior = await client.query(`SELECT 1 FROM world_capability_observations WHERE world_id=$1 AND gap_id=$2 AND agent_id=$3
    AND observed_world_day<$4 LIMIT 1`, [worldId, gap.id, agent.agentId, day]);
  if (!prior.rowCount) {
    await client.query(`INSERT INTO agent_memories(world_id,agent_id,memory_type,summary,importance,world_minutes,location,metadata)
      VALUES($1,$2,'capability_gap',$3,0.48,$4,$5,$6::jsonb)`, [worldId, agent.agentId,
      `I noticed a recurring capability gap: ${String(gap.problemStatement).slice(0, 180)}`,
      worldMinute, agent.location || null, JSON.stringify({ gapId: gap.id, gapKey: gap.gapKey, evidence: gap.evidence })]);
  }
  await writeCapabilityEvent(client, { worldId, actorAgentId: agent.agentId, gapId: gap.id,
    eventType: 'capability_gap_observed', eventKey: `gap-observed:${gap.id}:${agent.agentId}:${day}`,
    worldMinute, details: { category: gap.category, observationPath: 'resident_context' } });
  return true;
}

async function primitiveMap(client, worldId) {
  const [rows, dependencies] = await Promise.all([
    client.query(`SELECT capability.id,capability.capability_key AS "capabilityKey",capability.category,capability.name,
        capability.specification,capability.status,capability.creator_type AS "creatorType",
        COALESCE((SELECT count(*)::int FROM world_capability_uses usage
          WHERE usage.world_id=capability.world_id AND usage.capability_id=capability.id AND usage.success),0) AS "successfulUses",
        COALESCE((SELECT max(usage.world_minute) FROM world_capability_uses usage
          WHERE usage.world_id=capability.world_id AND usage.capability_id=capability.id AND usage.success),0) AS "lastSuccessfulUse"
      FROM world_capabilities capability WHERE capability.world_id=$1 AND capability.status='active'
      ORDER BY capability.capability_key`, [worldId]),
    client.query(`SELECT capability_id AS "capabilityId",depends_on_capability_id AS "dependsOnCapabilityId"
      FROM world_capability_dependencies WHERE world_id=$1`, [worldId])
  ]);
  const depths = new Map(capabilityGraphDepth(rows.rows.map((row) => ({ id: row.id, name: row.name,
    creatorType: row.creatorType })), dependencies.rows).map((item) => [item.id, item.depth]));
  return new Map(rows.rows.map((row) => [row.capabilityKey, { ...row,
    compositionDepth: depths.get(row.id) || 0, specification: jsonValue(row.specification) }]));
}

function makeCapabilityDrafts(gap, activeCapabilities, agent) {
  const primitives = [...activeCapabilities.values()].filter((item) => item.capabilityKey.startsWith('primitive:')
    && jsonValue(item.specification).kind === 'primitive');
  const byPrimitive = new Map(primitives.map((item) => [item.capabilityKey.slice('primitive:'.length), item]));
  const componentPool = ['resident.knowledge_gain', 'resident.skill_gain', 'relationship.adjust']
    .map((key) => byPrimitive.get(key)).filter(Boolean);
  if (!componentPool.length) return [];
  const skillNames = [...new Set([...Object.keys(agent.skills || {}).filter((skill) => SKILLS.has(skill)), ...SKILLS])]
    .sort((left, right) => Number(agent.skills?.[left] || 0) - Number(agent.skills?.[right] || 0) || left.localeCompare(right));
  const combinations = [];
  for (let mask = 1; mask < (1 << componentPool.length); mask++) {
    const selected = componentPool.filter((_item, index) => mask & (1 << index));
    combinations.push(selected);
  }
  const drafts = [];
  for (const components of combinations) {
    const includesSkill = components.some((item) => item.capabilityKey === 'primitive:resident.skill_gain');
    for (const skill of (includesSkill ? skillNames : [null])) {
      const partner = components.some((item) => item.capabilityKey === 'primitive:relationship.adjust');
      const composition = components.map((item) => {
        const primitiveId = item.capabilityKey.slice('primitive:'.length);
        const parameters = primitiveId === 'resident.skill_gain' ? { target: 'actor', skill, amount: 1 }
          : primitiveId === 'resident.knowledge_gain' ? { target: 'actor', amount: 2 }
            : { target: 'partner', trust: 0.5, familiarity: 0.5 };
        return { capabilityId: item.id, parameters };
      });
      const costEnergy = 1 + components.length + (partner ? 1 : 0);
      const effectNames = components.map((item) => item.name);
      const canonical = JSON.stringify({ composition, partner });
      const suffix = createHash('sha256').update(`${gap.id}:${canonical}`).digest('hex').slice(0, 14);
      const topic = String(gap.category).split('.').at(-1).replaceAll('_', ' ');
      const effectLabel = effectNames.join(' + ');
      const name = `${topic}: ${skill ? `${skill} · ` : ''}${effectLabel}`.slice(0, 120);
      const minParticipants = partner ? 2 : 1;
      drafts.push({ id: `draft:${suffix}`, name, category: `${gap.category}.capability`, problemStatement: gap.problemStatement,
        expectedBenefit: `Combine ${effectLabel} in response to the observed ${topic} gap; measured usefulness remains to be established by resident use.`,
        expectedCost: { energy: costEnergy, food: 1, simulatedUsdc: 0 },
        requiredResources: { participants: minParticipants, energy: costEnergy, food: 1,
          componentCapabilities: components.map((item) => item.id) },
        affectedSystems: [String(gap.category).split('.')[0], ...components.map((item) => item.category)],
        specification: { schemaVersion: 1, kind: 'composition', composition, steps: [],
          requirements: { minEnergy: 20, minFood: 8, partnerRequired: partner, skills: {} },
          costs: [{ resource: 'energy', amount: costEnergy }, { resource: 'food', amount: 1 }],
          participants: { minimum: minParticipants, maximum: minParticipants },
          experiment: { maximumParticipants: 8 },
          durationWorldMinutes: Math.min(240, 10 + components.length * 5), scope: { type: 'resident_set' },
      risks: ['The declared effects may not reduce the original problem; resident experience must be measured.'] } });
    }
  }
  const priorCapabilities = [...activeCapabilities.values()].filter((item) => item.creatorType === 'resident'
    && Number(item.successfulUses) > 0 && Number(item.compositionDepth) < MAX_COMPOSITION_DEPTH
    && jsonValue(item.specification).kind === 'composition'
    && jsonValue(item.specification).scope?.type === 'resident_set'
    && !jsonValue(item.specification).costs?.some((cost) => cost.resource === 'simulated_usdc'))
    .sort((left, right) => Number(right.successfulUses) - Number(left.successfulUses)
      || Number(right.lastSuccessfulUse) - Number(left.lastSuccessfulUse)
      || String(left.capabilityKey).localeCompare(String(right.capabilityKey))).slice(0, 1);
  for (const prior of priorCapabilities) {
    const priorSpec = jsonValue(prior.specification);
    const priorComponentIds = new Set((priorSpec.composition || []).map((item) => item.capabilityId));
    for (const component of componentPool) {
      if (priorComponentIds.has(component.id)) continue;
      const primitiveId = component.capabilityKey.slice('primitive:'.length);
      const skill = primitiveId === 'resident.skill_gain' ? skillNames[0] : null;
      const parameters = primitiveId === 'resident.skill_gain' ? { target: 'actor', skill, amount: 1 }
        : primitiveId === 'resident.knowledge_gain' ? { target: 'actor', amount: 2 }
          : { target: 'partner', trust: 0.5, familiarity: 0.5 };
      const composition = [{ capabilityId: prior.id, parameters: {} }, { capabilityId: component.id, parameters }];
      const parentNeedsPartner = Boolean(priorSpec.requirements?.partnerRequired)
        || Number(priorSpec.participants?.minimum || 1) > 1;
      const needsPartner = parentNeedsPartner || primitiveId === 'relationship.adjust';
      const minimumParticipants = Math.max(Number(priorSpec.participants?.minimum || 1), needsPartner ? 2 : 1);
      const parentCosts = Array.isArray(priorSpec.costs) ? priorSpec.costs : [];
      const energyCost = parentCosts.filter((cost) => cost.resource === 'energy')
        .reduce((sum, cost) => sum + Number(cost.amount || 0), 0) + 1;
      const foodCost = parentCosts.filter((cost) => cost.resource === 'food')
        .reduce((sum, cost) => sum + Number(cost.amount || 0), 0) + 1;
      const topic = String(gap.category).split('.').at(-1).replaceAll('_', ' ');
      const effectLabel = `${prior.name} + ${component.name}`;
      const suffix = createHash('sha256').update(`${gap.id}:${JSON.stringify(composition)}`).digest('hex').slice(0, 14);
      drafts.unshift({ id: `draft:${suffix}`, name: `${topic}: ${effectLabel}`.slice(0, 120),
        category: `${gap.category}.capability`, problemStatement: gap.problemStatement,
        expectedBenefit: `Extend a previously successful resident-created capability with ${component.name} for the observed ${topic} gap; the combined effect remains to be measured.`,
        expectedCost: { energy: energyCost, food: foodCost, simulatedUsdc: 0 },
        requiredResources: { participants: minimumParticipants, energy: energyCost, food: foodCost,
          componentCapabilities: composition.map((entry) => entry.capabilityId) },
        affectedSystems: [String(gap.category).split('.')[0], prior.category, component.category],
        specification: { schemaVersion: 1, kind: 'composition', composition, steps: [],
          requirements: { minEnergy: Math.max(20, Number(priorSpec.requirements?.minEnergy) || 20),
            minFood: Math.max(8, Number(priorSpec.requirements?.minFood) || 8),
            partnerRequired: needsPartner, skills: { ...(priorSpec.requirements?.skills || {}) } },
          costs: [{ resource: 'energy', amount: energyCost }, { resource: 'food', amount: foodCost }],
          participants: { minimum: minimumParticipants, maximum: Math.max(minimumParticipants,
            Number(priorSpec.participants?.maximum) || minimumParticipants) },
          experiment: { maximumParticipants: 8 }, durationWorldMinutes: Math.max(10,
            Number(priorSpec.durationWorldMinutes) || 10), scope: { type: 'resident_set' },
          risks: [...(priorSpec.risks || []).slice(0, 6),
            'The combined effects may not address the new gap; both components remain independently traceable.'] } });
    }
  }
  const secondOrderDrafts = drafts.filter((draft) => draft.specification.composition
    .some((item) => priorCapabilities.some((capability) => capability.id === item.capabilityId)));
  const primitiveDrafts = drafts.filter((draft) => !draft.specification.composition
    .some((item) => priorCapabilities.some((capability) => capability.id === item.capabilityId)));
  return [...secondOrderDrafts, ...primitiveDrafts].slice(0, 32);
}

async function recordCapabilityProposal(client, { worldId, agentId, gap, actionId: rawActionId, draft, worldMinute,
  creatorType = 'resident', creatorOrganizationId = null, revisionOfProposalId = null }) {
  await requireWorldMember(client, worldId, agentId);
  const actionId = actionIdentifier(rawActionId);
  const specification = validateCapabilitySpecification(draft.specification);
  if (specification.kind !== 'composition') throw capabilityError('CAPABILITY_SPEC_NOT_EXECUTABLE', 400);
  const prior = await client.query(`SELECT id,status,capability_id AS "capabilityId" FROM world_capability_proposals
    WHERE world_id=$1 AND action_id=$2`, [worldId, actionId]);
  if (prior.rowCount) return { ...prior.rows[0], idempotent: true };
  const gapResult = await client.query(`SELECT id,category,problem_statement AS "problemStatement",status FROM world_capability_gaps
    WHERE world_id=$1 AND id=$2`, [worldId, gap.id]);
  if (!gapResult.rowCount || gapResult.rows[0].status === 'stale') throw capabilityError('CAPABILITY_GAP_NOT_AVAILABLE', 409);
  if (creatorOrganizationId) {
    const membership = await client.query(`SELECT organization.founder_agent_id AS "founderAgentId",
        organization.governance_mode AS "governanceMode",member.role,
        COALESCE((SELECT max(skill.skill_value) FROM world_agent_skills skill
          WHERE skill.world_id=$1 AND skill.agent_id=$3),0)::numeric AS "agentSkill",
        COALESCE((SELECT max(skill.skill_value) FROM world_organization_members peers
          JOIN world_agent_skills skill ON skill.world_id=peers.world_id AND skill.agent_id=peers.agent_id
          WHERE peers.world_id=$1 AND peers.organization_id=$2 AND peers.status='active'),0)::numeric AS "topSkill"
      FROM world_organizations organization JOIN world_organization_members member
        ON member.world_id=organization.world_id AND member.organization_id=organization.id
      WHERE organization.world_id=$1 AND organization.id=$2 AND organization.status='active'
        AND member.agent_id=$3 AND member.status='active'`, [worldId, creatorOrganizationId, agentId]);
    if (!membership.rowCount) throw capabilityError('ACTIVE_ORGANIZATION_MEMBERSHIP_REQUIRED', 403);
    const authority = membership.rows[0];
    const canRepresent = authority.governanceMode === 'founder_led' ? authority.founderAgentId === agentId
      : authority.governanceMode === 'delegated' ? ['founder','coordinator'].includes(authority.role)
        : authority.governanceMode === 'skill_based' ? Number(authority.agentSkill) >= Number(authority.topSkill)
          : ['member_vote','reputation_weighted'].includes(authority.governanceMode);
    if (!canRepresent) throw capabilityError('ORGANIZATION_PROPOSAL_AUTHORITY_REQUIRED', 403);
    creatorType = 'organization';
  }
  const observation = await client.query(`SELECT 1 FROM world_capability_observations WHERE world_id=$1 AND gap_id=$2
    AND agent_id=$3 LIMIT 1`, [worldId, gap.id, agentId]);
  if (!observation.rowCount) throw capabilityError('CAPABILITY_GAP_MUST_BE_OBSERVED', 409);
  for (const item of specification.composition) {
    const parent = await client.query(`SELECT status,specification FROM world_capabilities WHERE world_id=$1 AND id=$2`, [worldId, item.capabilityId]);
    if (!parent.rowCount || parent.rows[0].status !== 'active') throw capabilityError('CAPABILITY_COMPOSITION_PARENT_NOT_ACTIVE', 409);
    if (jsonValue(parent.rows[0].specification).kind === 'native_system') {
      throw capabilityError('CAPABILITY_COMPONENT_NOT_EXECUTABLE', 400);
    }
  }
  if (specification.evolvesCapabilityId) {
    const parent = await client.query(`SELECT status FROM world_capabilities WHERE world_id=$1 AND id=$2`,
      [worldId, specification.evolvesCapabilityId]);
    if (!parent.rowCount || parent.rows[0].status !== 'active') throw capabilityError('CAPABILITY_EVOLUTION_PARENT_NOT_ACTIVE', 409);
  }
  const title = requiredText(draft.name, 3, 120, 'capability_name');
  const problem = requiredText(draft.problemStatement || gap.problemStatement, 8, 600, 'capability_problem');
  const benefit = requiredText(draft.expectedBenefit, 3, 600, 'capability_expected_benefit');
  const expectedCost = jsonObject(draft.expectedCost, 'capability_expected_cost');
  const requiredResources = jsonObject(draft.requiredResources, 'capability_required_resources');
  const affectedSystems = Array.isArray(draft.affectedSystems) ? draft.affectedSystems.map((entry) => requiredText(entry, 1, 80)) : [];
  const revision = revisionOfProposalId ? Number((await client.query(`SELECT revision FROM world_capability_proposals
    WHERE world_id=$1 AND id=$2`, [worldId, revisionOfProposalId])).rows[0]?.revision || 0) + 1 : 1;
  const inserted = await client.query(`INSERT INTO world_capability_proposals(id,world_id,gap_id,creator_type,creator_agent_id,
      creator_organization_id,action_id,category,name,problem_statement,proposed_capability,expected_benefit,expected_cost,
      required_resources,affected_systems,status,revision,revision_of_proposal_id,created_world_minute,updated_world_minute,
      expires_world_minute,metadata)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13::jsonb,$14::jsonb,$15::jsonb,$16,$17,$18,$19,$19,$20,$21::jsonb)
    ON CONFLICT(world_id,action_id) DO NOTHING
    RETURNING id,status,revision`, [stableUuid(worldId, 'proposal', actionId), worldId, gap.id, creatorType, agentId,
    creatorOrganizationId, actionId,
    normalizedCategory(draft.category), title, problem, JSON.stringify(specification), benefit,
    JSON.stringify(expectedCost), JSON.stringify(requiredResources), JSON.stringify(affectedSystems),
    'proposed', revision, revisionOfProposalId, worldMinute, worldMinute + CAPABILITY_PROPOSAL_LIFETIME_MINUTES,
    JSON.stringify({ generatedFromEvidence: gap.evidence || {}, declarative: true })]);
  if (!inserted.rowCount) return { ...(await client.query(`SELECT id,status,revision FROM world_capability_proposals
    WHERE world_id=$1 AND action_id=$2`, [worldId, actionId])).rows[0], idempotent: true };
  const proposal = inserted.rows[0];
  if (revisionOfProposalId) await client.query(`UPDATE world_capability_proposals SET status='revised',updated_world_minute=$3,updated_at=now()
    WHERE world_id=$1 AND id=$2`, [worldId, revisionOfProposalId, worldMinute]);
  await writeCapabilityEvent(client, { worldId, actorAgentId: agentId, gapId: gap.id, proposalId: proposal.id,
    eventType: 'capability_proposed', eventKey: `capability-proposed:${proposal.id}`, worldMinute,
    details: { category: draft.category, name: title, revision: proposal.revision,
      creatorType, creatorOrganizationId, organizationId: creatorOrganizationId } });
  await writeWorldHistory(client, { worldId, eventKey: `capability-proposal:${proposal.id}:proposed`,
    eventType: 'capability_proposed', actorAgentId: agentId, entityType: 'capability_proposal', entityId: proposal.id,
    worldTime: worldMinute, title, detail: problem, metadata: { category: draft.category, expectedBenefit: benefit,
      revision: proposal.revision, gapId: gap.id, creatorType, creatorOrganizationId,
      organizationId: creatorOrganizationId } });
  await writeCivilizationDecisionTrace(client, { worldId, agentId, worldMinute,
    sourceKey: `capability-proposal:${proposal.id}`, choiceType: 'proposal',
    selected: { id: proposal.id, _decisionSource: creatorType === 'organization' ? 'organization_sponsored' : 'resident_proposed' },
    options: [{ id: proposal.id, score: 1 }], state: { gapId: gap.id, evidence: gap.evidence || {} } });
  await client.query(`INSERT INTO agent_memories(world_id,agent_id,memory_type,summary,importance,world_minutes,location,metadata)
    VALUES($1,$2,'innovation',$3,0.68,$4,(SELECT location FROM world_members WHERE world_id=$1 AND agent_id=$2),$5::jsonb)`,
  [worldId, agentId, memorySummary(`I proposed “${title}” to address: ${problem}`), worldMinute,
    JSON.stringify({ proposalId: proposal.id, gapId: gap.id, category: draft.category })]);
  return { ...proposal, name: title, idempotent: false };
}

export async function createWorldCapabilityProposal(client, input) {
  const gap = { id: input.gapId };
  return recordCapabilityProposal(client, { ...input, gap, draft: input.proposal,
    actionId: input.actionId, agentId: input.agentId });
}

async function upsertReview(client, { worldId, agentId, proposalId, experimentId = null, reviewStage,
  decision, rationale, suggestedSpecification = null, evidence = {}, actionId, worldMinute,
  organizationId = null, decisionSource = null }) {
  if (!['proposal', 'experiment'].includes(reviewStage) || !['support', 'oppose', 'modify', 'ignore'].includes(decision)) {
    throw capabilityError('CAPABILITY_REVIEW_INVALID', 400);
  }
  if (decision === 'modify' && !suggestedSpecification) throw capabilityError('CAPABILITY_REVISION_REQUIRED', 400);
  const spec = suggestedSpecification ? validateCapabilitySpecification(suggestedSpecification) : null;
  const key = actionIdentifier(actionId);
  const inserted = await client.query(`INSERT INTO world_capability_reviews(world_id,proposal_id,experiment_id,reviewer_agent_id,
      reviewer_organization_id,review_stage,decision,rationale,suggested_specification,evidence,created_world_minute,action_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11,$12)
    ON CONFLICT DO NOTHING RETURNING id`, [worldId, proposalId, experimentId, agentId,
    organizationId, reviewStage, decision, requiredText(rationale, 3, 600, 'capability_review_rationale'),
    spec ? JSON.stringify(spec) : null, JSON.stringify(evidence), worldMinute, key]);
  if (!inserted.rowCount) {
    const prior = await client.query(`SELECT id FROM world_capability_reviews
      WHERE world_id=$1 AND action_id=$2`, [worldId, key]);
    if (prior.rowCount) return { id: prior.rows[0].id, idempotent: true };
    throw capabilityError(reviewStage === 'proposal' ? 'CAPABILITY_REVIEW_ALREADY_CAST' : 'CAPABILITY_REVIEW_ALREADY_RECORDED', 409);
  }
  if (reviewStage === 'proposal' && decision !== 'ignore') {
    await client.query(`UPDATE world_capability_proposals SET status='reviewed',
        support_count=(SELECT count(*)::int FROM world_capability_reviews WHERE world_id=$1 AND proposal_id=$2
          AND review_stage='proposal' AND decision='support'),
        opposition_count=(SELECT count(*)::int FROM world_capability_reviews WHERE world_id=$1 AND proposal_id=$2
          AND review_stage='proposal' AND decision='oppose'),updated_world_minute=$3,updated_at=now()
      WHERE world_id=$1 AND id=$2 AND status IN ('proposed','reviewed')`, [worldId, proposalId, worldMinute]);
  }
  const eventType = reviewStage === 'proposal'
    ? ({ support: 'capability_supported', oppose: 'capability_opposed', modify: 'capability_revision_suggested', ignore: 'capability_review_ignored' })[decision]
    : ({ support: 'capability_experiment_supported', oppose: 'capability_experiment_opposed', modify: 'capability_experiment_revision_suggested', ignore: 'capability_experiment_review_ignored' })[decision];
  await writeCapabilityEvent(client, { worldId, actorAgentId: agentId, proposalId, experimentId,
    eventType,
    eventKey: `capability-review:${key}`, worldMinute,
    details: { reviewStage, decision, rationale, revisionSuggested: Boolean(spec) } });
  await writeCivilizationDecisionTrace(client, { worldId, agentId, worldMinute,
    sourceKey: `capability-review:${key}`, choiceType: `${reviewStage}_review`,
    selected: { id: decision, _decisionSource: decisionSource || (organizationId ? 'organization_review' : 'resident_api') },
    options: [{ id: decision, score: 1 }], state: { proposalId, evidence } });
  await client.query(`INSERT INTO agent_memories(world_id,agent_id,memory_type,summary,importance,world_minutes,metadata)
    VALUES($1,$2,'innovation',$3,0.55,$4,$5::jsonb)`, [worldId, agentId,
    memorySummary(`I ${decision === 'support' ? 'supported' : decision === 'oppose' ? 'opposed' : decision === 'modify' ? 'suggested a revision to' : 'declined to review'} capability proposal ${String(proposalId).slice(0, 8)}.`),
    worldMinute, JSON.stringify({ proposalId, experimentId, reviewStage, decision })]);
  if (decision === 'modify' && spec) {
    const prior = await client.query(`SELECT proposal.*,gap.category AS "gapCategory" FROM world_capability_proposals proposal
      JOIN world_capability_gaps gap ON gap.world_id=proposal.world_id AND gap.id=proposal.gap_id
      WHERE proposal.world_id=$1 AND proposal.id=$2`, [worldId, proposalId]);
    if (prior.rowCount) {
      const source = prior.rows[0];
      await client.query(`INSERT INTO world_capability_observations(world_id,gap_id,agent_id,observed_world_day,
          observed_world_minute,observation_path,evidence)
        VALUES($1,$2,$3,$4,$5,'proposal_review',$6::jsonb)
        ON CONFLICT(world_id,gap_id,agent_id,observed_world_day) DO NOTHING`,
      [worldId, source.gap_id, agentId, Math.floor(worldMinute / 1_440), worldMinute,
        JSON.stringify({ sourceProposalId: proposalId, reviewedBeforeRevision: true })]);
      const draft = { name: `${source.name} — revised`.slice(0, 120), category: source.category,
        problemStatement: source.problem_statement, expectedBenefit: source.expected_benefit,
        expectedCost: jsonValue(source.expected_cost), requiredResources: jsonValue(source.required_resources),
        affectedSystems: jsonValue(source.affected_systems, []), specification: spec };
      const revision = await recordCapabilityProposal(client, { worldId, agentId, gap: { id: source.gap_id,
        problemStatement: source.problem_statement, evidence: source.metadata?.generatedFromEvidence },
      actionId: `${key}:revision`, draft, worldMinute, revisionOfProposalId: proposalId });
      await writeCapabilityEvent(client, { worldId, actorAgentId: agentId, gapId: source.gap_id,
        proposalId: revision.id, eventType: 'capability_revision_created', eventKey: `capability-revision:${key}`,
        worldMinute, details: { parentProposalId: proposalId, revisionProposalId: revision.id } });
    }
  }
  return { id: inserted.rows[0].id, idempotent: false, decision };
}

export async function reviewWorldCapabilityProposal(client, input) {
  await requireWorldMember(client, input.worldId, input.agentId);
  const proposal = await client.query(`SELECT creator_agent_id AS "creatorAgentId",status FROM world_capability_proposals
    WHERE world_id=$1 AND id=$2`, [input.worldId, input.proposalId]);
  if (!proposal.rowCount) throw capabilityError('CAPABILITY_PROPOSAL_NOT_FOUND', 404);
  if (proposal.rows[0].creatorAgentId === input.agentId) throw capabilityError('CAPABILITY_SELF_REVIEW_NOT_ALLOWED', 403);
  if (!['proposed', 'reviewed'].includes(proposal.rows[0].status)) throw capabilityError('CAPABILITY_PROPOSAL_NOT_REVIEWABLE');
  return upsertReview(client, { ...input, reviewStage: 'proposal', rationale: input.rationale,
    suggestedSpecification: input.suggestedSpecification });
}

export async function reviewWorldCapabilityExperiment(client, input) {
  await requireWorldMember(client, input.worldId, input.agentId);
  const experiment = await client.query(`SELECT experiment.proposal_id AS "proposalId",experiment.status,
      experiment.participant_agent_ids AS "participantAgentIds"
    FROM world_capability_experiments experiment WHERE experiment.world_id=$1 AND experiment.id=$2`,
  [input.worldId, input.experimentId]);
  if (!experiment.rowCount) throw capabilityError('CAPABILITY_EXPERIMENT_NOT_FOUND', 404);
  if (experiment.rows[0].status !== 'running') throw capabilityError('CAPABILITY_EXPERIMENT_NOT_REVIEWABLE');
  if (!jsonValue(experiment.rows[0].participantAgentIds, []).includes(input.agentId)) {
    throw capabilityError('CAPABILITY_EXPERIMENT_PARTICIPANT_REQUIRED', 403);
  }
  return upsertReview(client, { ...input, proposalId: experiment.rows[0].proposalId,
    experimentId: input.experimentId, reviewStage: 'experiment' });
}

async function reviewWeights(client, worldId, proposalId) {
  const result = await client.query(`SELECT review.decision,review.reviewer_agent_id AS "reviewerAgentId",
      COALESCE(state.risk_tolerance,0.5)::text AS risk_tolerance,
      COALESCE(profile.curiosity,0.5)::text AS curiosity,
      COALESCE((SELECT max(skill.skill_value) FROM world_agent_skills skill WHERE skill.world_id=review.world_id
        AND skill.agent_id=review.reviewer_agent_id),0)::text AS skill_value,
      COALESCE(reputation.reliability,0)::text AS reliability
    FROM world_capability_reviews review LEFT JOIN world_social_profiles profile
      ON profile.world_id=review.world_id AND profile.agent_id=review.reviewer_agent_id
    LEFT JOIN world_agent_states state
      ON state.world_id=review.world_id AND state.agent_id=review.reviewer_agent_id
    LEFT JOIN world_agent_reputations reputation ON reputation.world_id=review.world_id AND reputation.agent_id=review.reviewer_agent_id
    WHERE review.world_id=$1 AND review.proposal_id=$2 AND review.review_stage='proposal'
    ORDER BY review.created_world_minute,review.id`, [worldId, proposalId]);
  const latest = new Map();
  for (const row of result.rows) {
    if (row.reviewerAgentId) latest.set(row.reviewerAgentId, row);
  }
  let support = 0, oppose = 0, supportCount = 0;
  const supporters = [];
  for (const row of latest.values()) {
    const weight = 0.45 + Number(row.skill_value) / 200 + Number(row.curiosity) * 0.15
      + Number(row.reliability) / 400;
    if (row.decision === 'support') { support += weight; supportCount++; supporters.push(row.reviewerAgentId); }
    if (row.decision === 'oppose') oppose += weight + (1 - Number(row.risk_tolerance)) * 0.15;
  }
  return { support, oppose, supportCount, supporters };
}

async function startExperiment(client, proposal, worldMinute) {
  const decision = await reviewWeights(client, proposal.world_id, proposal.id);
  if (!decision.supportCount || decision.support < 0.55 || decision.support <= decision.oppose) {
    if (decision.oppose >= 0.55 && decision.oppose >= decision.support && decision.supportCount === 0) {
      await client.query(`UPDATE world_capability_proposals SET status='rejected',updated_world_minute=$3,updated_at=now()
        WHERE world_id=$1 AND id=$2 AND status IN ('proposed','reviewed')`, [proposal.world_id, proposal.id, worldMinute]);
      await writeCapabilityEvent(client, { worldId: proposal.world_id, actorAgentId: null, gapId: proposal.gap_id,
        proposalId: proposal.id, eventType: 'capability_rejected', eventKey: `capability-rejected:${proposal.id}`,
        worldMinute, details: { reason: 'weighted_review_evidence_opposed' } });
    }
    return null;
  }
  const spec = validateCapabilitySpecification(proposal.proposed_capability);
  let parentRow = null;
  let lineage = null;
  if (spec.evolvesCapabilityId) {
    const parent = await client.query(`SELECT id,capability_key AS "capabilityKey",version FROM world_capabilities
      WHERE world_id=$1 AND id=$2 AND status='active'`, [proposal.world_id, spec.evolvesCapabilityId]);
    parentRow = parent.rows[0] || null;
    if (!parentRow) return null;
  } else if (proposal.revision_of_proposal_id) {
    const prior = await client.query(`SELECT capability.id,capability.capability_key AS "capabilityKey",capability.version
      FROM world_capability_proposals proposal LEFT JOIN world_capabilities capability
        ON capability.world_id=proposal.world_id AND capability.id=proposal.capability_id
      WHERE proposal.world_id=$1 AND proposal.id=$2`, [proposal.world_id, proposal.revision_of_proposal_id]);
    lineage = prior.rows[0]?.capabilityKey ? prior.rows[0] : null;
    parentRow = lineage;
  }
  const rootProposalId = proposal.revision_of_proposal_id || proposal.id;
  const capabilityKey = parentRow?.capabilityKey
    || `agent:${String(proposal.creator_agent_id).slice(0, 8)}:${String(rootProposalId).slice(0, 8)}`;
  const version = parentRow ? Number(parentRow.version) + 1 : Math.max(1, Number(proposal.revision) || 1);
  const scopeType = spec.scope.type;
  const scopeId = spec.scope.id || null;
  if (scopeType !== 'resident_set' && !scopeId) return null;
  let participantIds = [...new Set([proposal.creator_agent_id, ...decision.supporters].filter(Boolean))];
  if (scopeType === 'organization') {
    const valid = await client.query(`SELECT DISTINCT agent_id FROM world_organization_members
      WHERE world_id=$1 AND organization_id=$2 AND status='active' AND agent_id=ANY($3::uuid[]) ORDER BY agent_id`,
    [proposal.world_id, scopeId, participantIds]);
    const allowed = new Set(valid.rows.map((row) => row.agent_id));
    participantIds = participantIds.filter((id) => allowed.has(id));
  }
  if (scopeType === 'project') {
    const valid = await client.query(`SELECT DISTINCT agent_id FROM world_project_members
      WHERE world_id=$1 AND project_id=$2 AND status='active' AND agent_id=ANY($3::uuid[]) ORDER BY agent_id`,
    [proposal.world_id, scopeId, participantIds]);
    const allowed = new Set(valid.rows.map((row) => row.agent_id));
    participantIds = participantIds.filter((id) => allowed.has(id));
  }
  if (scopeType === 'place') {
    const valid = await client.query(`SELECT 1 FROM world_scenes WHERE world_id=$1 AND id=$2 AND status='active'`,
      [proposal.world_id, scopeId]);
    if (!valid.rowCount) return null;
  }
  participantIds = participantIds.slice(0, Number(spec.experiment?.maximumParticipants || 4));
  if (participantIds.length < Number(spec.participants.minimum)) return null;
  const participantScope = { experimentId: null, scopeType, scopeId,
    participantAgentIds: participantIds, createdFromProposal: proposal.id };
  const capabilityResult = await client.query(`INSERT INTO world_capabilities(id,world_id,capability_key,category,name,description,
      status,version,parent_capability_id,creator_type,creator_agent_id,creator_organization_id,specification,
      experiment_scope,created_world_minute,metadata)
    VALUES($1,$2,$3,$4,$5,$6,'experimental',$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb,$14,$15::jsonb)
    ON CONFLICT(world_id,capability_key,version) DO NOTHING RETURNING id`,
  [stableUuid(proposal.world_id, 'capability', capabilityKey, version), proposal.world_id, capabilityKey,
    proposal.category, proposal.name, proposal.problem_statement, version,
    parentRow?.id || null, proposal.creator_type, proposal.creator_agent_id, proposal.creator_organization_id,
    JSON.stringify(spec), JSON.stringify(participantScope), worldMinute,
    JSON.stringify({ proposalId: proposal.id, expectedBenefit: proposal.expected_benefit })]);
  let capabilityId = capabilityResult.rows[0]?.id;
  if (!capabilityId) capabilityId = (await client.query(`SELECT id FROM world_capabilities
    WHERE world_id=$1 AND capability_key=$2 AND version=$3`, [proposal.world_id, capabilityKey, version])).rows[0]?.id;
  if (!capabilityId) return null;
  await recordWorldCapabilityDependencies(client, { worldId: proposal.world_id, capabilityId,
    dependencyCapabilityIds: [...spec.composition.map((item) => item.capabilityId), parentRow?.id].filter(Boolean),
    createdByAgentId: proposal.creator_agent_id, worldMinute,
    evidence: { source: 'agent_created_capability_composition', proposalId: proposal.id } });
  const experimentResult = await client.query(`INSERT INTO world_capability_experiments(id,world_id,proposal_id,capability_id,
      scope_type,scope_id,participant_agent_ids,status,started_world_minute,ends_world_minute,evidence)
    VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,'running',$8,$9,$10::jsonb) RETURNING id`,
  [stableUuid(proposal.world_id, 'experiment', proposal.id), proposal.world_id, proposal.id, capabilityId,
    scopeType, scopeId, JSON.stringify(participantIds), worldMinute,
    worldMinute + EXPERIMENT_DURATION_MINUTES, JSON.stringify({ weightedSupport: decision.support,
      weightedOpposition: decision.oppose, supportCount: decision.supportCount })]);
  const experimentId = experimentResult.rows[0].id;
  participantScope.experimentId = experimentId;
  await client.query(`UPDATE world_capabilities SET experiment_scope=$3::jsonb WHERE world_id=$1 AND id=$2`,
    [proposal.world_id, capabilityId, JSON.stringify(participantScope)]);
  await client.query(`UPDATE world_capability_proposals SET status='experimental',capability_id=$3,updated_world_minute=$4,updated_at=now()
    WHERE world_id=$1 AND id=$2`, [proposal.world_id, proposal.id, capabilityId, worldMinute]);
  await writeCapabilityEvent(client, { worldId: proposal.world_id, actorAgentId: proposal.creator_agent_id,
    gapId: proposal.gap_id, proposalId: proposal.id, capabilityId, experimentId,
    eventType: 'capability_experiment_started', eventKey: `capability-experiment:${experimentId}:started`,
    worldMinute, details: { scopeType, participantCount: participantIds.length, version } });
  await writeWorldHistory(client, { worldId: proposal.world_id, eventKey: `capability:${capabilityId}:experiment_started`,
    eventType: 'capability_experiment_started', actorAgentId: proposal.creator_agent_id, entityType: 'capability',
    entityId: capabilityId, worldTime: worldMinute, title: `${proposal.name} — experiment started`.slice(0, 120),
    detail: `A bounded ${scopeType} experiment began with ${participantIds.length} voluntary participants.`,
    metadata: { proposalId: proposal.id, experimentId, participantIds, version } });
  return { capabilityId, experimentId };
}

function agentInitiative(agent) {
  const curiosity = clamp(agent.curiosity ?? agent.traits?.curiosity, 0, 1);
  const ambition = clamp(agent.ambition ?? agent.traits?.ambition, 0, 1);
  const skills = Object.values(agent.skills || {}).map(Number).filter(Number.isFinite);
  const skillFit = Math.max(0, ...skills) / 100;
  const risk = clamp(agent.riskTolerance, 0, 1);
  const goalFit = /learn|community|wealth|business|research|build|collaborat/i.test(
    `${agent.goal || ''} ${agent.primaryGoal || ''} ${agent.currentGoal || ''}`) ? 0.12 : 0;
  return clamp(curiosity * 0.34 + ambition * 0.25 + skillFit * 0.22 + risk * 0.07 + goalFit + Number(agent.knowledge || 0) / 100 * 0.08, 0, 1);
}

async function chooseOption(chooser, { worldId, agent, worldMinute, choiceType, state, options }) {
  if (chooser) {
    try {
      const result = await chooser({ worldId, agentId: agent.agentId, agent, worldMinute, choiceType, state,
        options: options.map(({ id, label, description, specification }) => ({ id, label, description,
          ...(specification ? { specification } : {}) })) });
      const selectedId = result?.choice?.id || result?.choice || result?.id;
      const selected = options.find((item) => item.id === selectedId);
      if (selected && (!Number.isFinite(Number(result?.confidence)) || Number(result.confidence) >= 0.3)) {
        return { ...selected, _decisionSource: 'typesafe', _decisionConfidence: Number(result?.confidence) };
      }
    } catch { /* TypeSafe failures are local abstentions. */ }
  }
  let fallback;
  if (choiceType === 'proposal') {
    const initiative = agentInitiative(agent);
    const threshold = 0.36 + stableUnit(`${worldId}:${agent.agentId}:${state.gapId}:innovation`) * 0.55;
    const viable = options.filter((item) => item.id !== 'ignore');
    if (initiative >= threshold && viable.length) {
      const index = Math.floor(stableUnit(`${worldId}:${agent.agentId}:${state.gapId}:proposal-design`) * viable.length);
      fallback = viable[Math.min(viable.length - 1, index)];
    } else fallback = options.find((item) => item.id === 'ignore') || options[0];
  } else if (choiceType === 'proposal_review') {
    const fit = agentInitiative(agent);
    const decision = stableUnit(`${worldId}:${agent.agentId}:${state.proposalId}:review`);
    if (fit > 0.58 && decision < 0.42) fallback = options.find((item) => item.id === 'support') || options[0];
    else if (fit < 0.28 && decision < 0.5) fallback = options.find((item) => item.id === 'oppose') || options[0];
    else fallback = options.find((item) => item.id === 'ignore') || options[0];
  } else {
    fallback = options.find((item) => item.id === 'ignore') || options[0];
  }
  return fallback ? { ...fallback, _decisionSource: 'local_fallback' } : null;
}

async function startReadyExperiments(client, worldId, worldMinute) {
  const ready = await client.query(`SELECT * FROM world_capability_proposals WHERE world_id=$1
    AND status IN ('proposed','reviewed') AND updated_world_minute<=$2 ORDER BY created_world_minute,id LIMIT 40`,
  [worldId, worldMinute]);
  const started = [];
  for (const proposal of ready.rows) {
    const experiment = await startExperiment(client, proposal, worldMinute);
    if (experiment) started.push({ proposalId: proposal.id, ...experiment });
  }
  return started;
}

async function reviewExperiences(client, { worldId, agent, worldMinute, chooseWithTypeSafe }) {
  const uses = await client.query(`SELECT use.id,use.capability_id AS "capabilityId",use.experiment_id AS "experimentId",
      use.success,use.status,use.costs,use.effects,use.result,experiment.proposal_id AS "proposalId"
    FROM world_capability_uses use JOIN world_capability_experiments experiment
      ON experiment.world_id=use.world_id AND experiment.id=use.experiment_id
    WHERE use.world_id=$1 AND (use.actor_agent_id=$2 OR use.partner_agent_id=$2)
      AND experiment.status='running' AND NOT EXISTS (SELECT 1 FROM world_capability_reviews review
        WHERE review.world_id=use.world_id AND review.experiment_id=use.experiment_id
          AND review.reviewer_agent_id=$2 AND review.evidence->>'useId'=use.id::text)
    ORDER BY use.world_minute DESC,use.id DESC LIMIT 3`, [worldId, agent.agentId]);
  for (const use of uses.rows) {
    const cost = jsonValue(use.costs);
    const effects = jsonValue(use.effects, []);
    const success = Boolean(use.success);
    const energyCost = Number(cost.energy) || 0;
    const hasEffect = Array.isArray(effects) && effects.length > 0;
    const options = [
      { id: 'support', label: 'Keep testing', description: 'The outcome was useful enough to continue evaluating this capability.' },
      { id: 'oppose', label: 'Do not adopt', description: 'The failure, resource cost, or side effect outweighs the result.' },
      { id: 'ignore', label: 'No judgment', description: 'There is not enough evidence for a useful evaluation.' }
    ];
    const local = success && hasEffect && energyCost <= 6 ? options[0]
      : (!success || energyCost > 8) ? options[1] : options[2];
    const selected = chooseWithTypeSafe ? await chooseOption(chooseWithTypeSafe, { worldId, agent, worldMinute,
      choiceType: 'experiment_review', state: { useId: String(use.id), success, status: use.status,
        energyCost, effects, residentGoal: agent.primaryGoal || agent.goal }, options }) : local;
    const actionId = `experience-review:${use.id}:${agent.agentId}`;
    await upsertReview(client, { worldId, agentId: agent.agentId, proposalId: use.proposalId,
      experimentId: use.experimentId, reviewStage: 'experiment', decision: selected?.id || local.id,
      rationale: selected?.description || local.description, evidence: { useId: String(use.id), success,
        energyCost, effectCount: Array.isArray(effects) ? effects.length : 0,
        reviewWeight: clamp(0.5 + agentInitiative(agent) * 0.5, 0.5, 1) }, actionId, worldMinute,
      decisionSource: selected?._decisionSource || 'local_fallback' });
  }
}

async function reviewOpenProposals(client, { worldId, agent, worldMinute, chooseWithTypeSafe }) {
  const result = await client.query(`SELECT proposal.id,proposal.creator_agent_id AS "creatorAgentId",proposal.name,
      proposal.category,proposal.problem_statement AS "problemStatement",proposal.proposed_capability AS specification,
      proposal.expected_benefit AS "expectedBenefit",proposal.expected_cost AS "expectedCost",proposal.gap_id AS "gapId"
    FROM world_capability_proposals proposal WHERE proposal.world_id=$1 AND proposal.status IN ('proposed','reviewed')
      AND proposal.creator_agent_id<>$2 AND NOT EXISTS (SELECT 1 FROM world_capability_reviews review
        WHERE review.world_id=proposal.world_id AND review.proposal_id=proposal.id
          AND review.reviewer_agent_id=$2 AND review.review_stage='proposal')
    ORDER BY proposal.created_world_minute,proposal.id LIMIT 1`, [worldId, agent.agentId]);
  for (const proposal of result.rows) {
    const spec = jsonValue(proposal.specification);
    const skillsRequired = spec.requirements?.skills || {};
    const fit = Object.keys(skillsRequired).some((skill) => Number(agent.skills?.[skill] || 0) >= Number(skillsRequired[skill]));
    const alternatives = makeCapabilityDrafts({ id: proposal.id, category: `${proposal.category}.revision`,
      problemStatement: proposal.problemStatement }, await primitiveMap(client, worldId), agent)
      .filter((draft) => JSON.stringify(draft.specification) !== JSON.stringify(spec)).slice(0, 3);
    const options = [
      { id: 'support', label: 'Support', description: `The proposed ${proposal.name} addresses a real problem and fits your knowledge or goals.` },
      { id: 'oppose', label: 'Oppose', description: 'Expected risks or costs exceed likely benefits.' },
      { id: 'ignore', label: 'Ignore', description: 'You have little relevant experience or prefer not to take a position.' },
      ...alternatives.map((draft, index) => ({ id: `modify:${index}`, label: `Suggest ${draft.name}`,
        description: `A revision that changes the declared effect composition. Expected costs: ${JSON.stringify(draft.expectedCost)}.`,
        specification: draft.specification }))
    ];
    const selected = await chooseOption(chooseWithTypeSafe, { worldId, agent, worldMinute, choiceType: 'proposal_review',
      state: { proposalId: proposal.id, name: proposal.name, problemStatement: proposal.problemStatement,
        expectedBenefit: proposal.expectedBenefit, expectedCost: jsonValue(proposal.expectedCost), proposedSpecification: spec,
        relevantSkills: agent.skills || {}, relevantGoal: agent.primaryGoal || agent.goal,
        relationshipWithCreator: (agent.relationships || []).find((item) => item.otherAgentId === proposal.creatorAgentId) || null },
      options });
    const modified = selected?.id?.startsWith('modify:') ? selected : null;
    const decision = modified ? 'modify' : selected?.id || (fit && agentInitiative(agent) >= 0.6 ? 'support' : 'ignore');
    const rationale = selected?.description || (decision === 'support' ? 'Relevant skills and resident goals support a bounded test.'
      : 'I do not have enough personal evidence to support or oppose this proposal.');
    await upsertReview(client, { worldId, agentId: agent.agentId, proposalId: proposal.id, reviewStage: 'proposal',
      decision, rationale, suggestedSpecification: modified?.specification,
      evidence: { gapId: proposal.gapId, relevance: fit ? 1 : 0,
        reviewWeight: clamp(0.5 + agentInitiative(agent) * 0.5, 0.5, 1) },
      actionId: `proposal-review:${createHash('sha256').update(`${proposal.id}:${agent.agentId}`).digest('hex').slice(0, 48)}`, worldMinute,
      decisionSource: selected?._decisionSource || 'local_fallback' });
  }
}

async function expireStalledCapabilityProposals(client, { worldId, worldMinute }) {
  const expired = await client.query(`UPDATE world_capability_proposals SET status='abandoned',updated_world_minute=$2,updated_at=now()
    WHERE world_id=$1 AND status IN ('proposed','reviewed')
      AND COALESCE(expires_world_minute,created_world_minute+$3)<=$2
    RETURNING id,gap_id AS "gapId",creator_agent_id AS "creatorAgentId",name,category`,
  [worldId, worldMinute, CAPABILITY_PROPOSAL_LIFETIME_MINUTES]);
  for (const proposal of expired.rows) {
    await writeCapabilityEvent(client, { worldId, actorAgentId: proposal.creatorAgentId, gapId: proposal.gapId,
      proposalId: proposal.id, eventType: 'capability_proposal_expired',
      eventKey: `capability-proposal:${proposal.id}:expired`, worldMinute,
      details: { reason: 'no_experiment_started_before_lifetime', category: proposal.category } });
    await writeWorldHistory(client, { worldId, eventKey: `capability-proposal:${proposal.id}:expired`,
      eventType: 'capability_abandoned', actorAgentId: proposal.creatorAgentId,
      entityType: 'capability_proposal', entityId: proposal.id, worldTime: worldMinute,
      title: `${proposal.name} — proposal expired`.slice(0, 120),
      detail: 'The proposal did not gather enough support to begin a bounded experiment before its review window ended.',
      metadata: { gapId: proposal.gapId, category: proposal.category, status: 'abandoned' } });
    if (proposal.creatorAgentId) await client.query(`INSERT INTO agent_memories(world_id,agent_id,memory_type,summary,
        importance,world_minutes,metadata) VALUES($1,$2,'innovation',$3,0.66,$4,$5::jsonb)`,
    [worldId, proposal.creatorAgentId, memorySummary(`My proposal “${proposal.name}” expired without enough review to test it.`),
      worldMinute, JSON.stringify({ proposalId: proposal.id, gapId: proposal.gapId,
        status: 'abandoned', reason: 'insufficient_review' })]);
  }
  return expired.rowCount;
}

function organizationMemberAgent(row) {
  return {
    agentId: row.agentId,
    goal: row.primaryGoal || row.currentGoal || 'balanced',
    primaryGoal: row.primaryGoal || row.currentGoal || 'balanced',
    currentGoal: row.currentGoal || row.primaryGoal || 'balanced',
    curiosity: Number(row.curiosity) || 0,
    ambition: Number(row.ambition) || 0,
    discipline: Number(row.discipline) || 0,
    riskTolerance: Number(row.riskTolerance) || 0,
    energy: Number(row.energy) || 0,
    food: Number(row.food) || 0,
    knowledge: Number(row.knowledge) || 0,
    location: row.location || null,
    skills: jsonValue(row.skills, {}),
    recentMemories: jsonValue(row.recentMemories, [])
  };
}

async function advanceOrganizationCapabilityCycles(client, { worldId, gaps, primitives, worldMinute, chooseWithTypeSafe }) {
  const cycle = Math.floor(Number(worldMinute) / CIVILIZATION_REVIEW_INTERVAL_MINUTES);
  let proposalsCreated = 0;
  for (const gap of gaps) {
    if (gap.status !== 'open' || Number(gap.observationCount) < 2
        || Number(worldMinute) - Number(gap.firstObservedWorldMinute) < 1_440) continue;
    const observedMembers = await client.query(`SELECT organization.id AS "organizationId",organization.name AS "organizationName",
        organization.purpose AS "organizationPurpose",organization.governance_mode AS "governanceMode",
        organization.governance_rules AS "governanceRules",organization.resources AS "organizationResources",
        organization.reputation AS "organizationReputation",organization.founder_agent_id AS "founderAgentId",
        member.agent_id AS "agentId",member.role,profile.primary_goal AS "primaryGoal",mind.current_goal AS "currentGoal",
        COALESCE(profile.curiosity,0)::float8 AS curiosity,COALESCE(profile.ambition,0)::float8 AS ambition,
        COALESCE(profile.discipline,0)::float8 AS discipline,COALESCE(state.risk_tolerance,0)::float8 AS "riskTolerance",
        resident.energy,resident.food,state.knowledge,resident.location,
        COALESCE((SELECT jsonb_object_agg(skill.skill_name,skill.skill_value) FROM world_agent_skills skill
          WHERE skill.world_id=$1 AND skill.agent_id=member.agent_id),'{}'::jsonb) AS skills,
        COALESCE((SELECT max(skill.skill_value) FROM world_agent_skills skill
          WHERE skill.world_id=$1 AND skill.agent_id=member.agent_id),0)::numeric AS "memberTopSkill",
        COALESCE((SELECT max(skill.skill_value) FROM world_organization_members peer
          JOIN world_agent_skills skill ON skill.world_id=peer.world_id AND skill.agent_id=peer.agent_id
          WHERE peer.world_id=$1 AND peer.organization_id=organization.id AND peer.status='active'),0)::numeric AS "organizationTopSkill",
        COALESCE(reputation.reliability,0)+COALESCE(reputation.cooperation,0) AS "memberReputation",
        COALESCE((SELECT jsonb_agg(memory.item ORDER BY memory.world_minutes DESC,memory.id DESC) FROM (
          SELECT jsonb_build_object('memoryType',entry.memory_type,'summary',entry.summary,
              'importance',entry.importance,'worldMinutes',entry.world_minutes,'metadata',entry.metadata) AS item,
              entry.world_minutes,entry.id
            FROM agent_memories entry WHERE entry.world_id=$1 AND entry.agent_id=member.agent_id
            ORDER BY entry.world_minutes DESC,entry.id DESC LIMIT 6) memory),'[]'::jsonb) AS "recentMemories"
      FROM world_organizations organization
      JOIN world_organization_members member ON member.world_id=organization.world_id
        AND member.organization_id=organization.id AND member.status='active'
      JOIN world_capability_observations observation ON observation.world_id=member.world_id
        AND observation.agent_id=member.agent_id AND observation.gap_id=$2
        AND observation.observed_world_day<=floor($3::numeric/1440)::bigint
      JOIN world_members resident ON resident.world_id=member.world_id AND resident.agent_id=member.agent_id
      JOIN world_agent_states state ON state.world_id=member.world_id AND state.agent_id=member.agent_id
      LEFT JOIN world_social_profiles profile ON profile.world_id=member.world_id AND profile.agent_id=member.agent_id
      LEFT JOIN agent_minds mind ON mind.world_id=member.world_id AND mind.agent_id=member.agent_id
      LEFT JOIN world_agent_reputations reputation ON reputation.world_id=member.world_id AND reputation.agent_id=member.agent_id
      WHERE organization.world_id=$1 AND organization.status='active'
      ORDER BY organization.id,member.joined_world_time,member.agent_id`, [worldId, gap.id, worldMinute]);
    const byOrganization = new Map();
    for (const row of observedMembers.rows) {
      if (!byOrganization.has(row.organizationId)) byOrganization.set(row.organizationId, []);
      byOrganization.get(row.organizationId).push(row);
    }

    for (const [organizationId, rows] of byOrganization) {
      const organization = rows[0];
      const mode = String(organization.governanceMode || 'founder_led');
      let electorate = rows;
      if (mode === 'founder_led') electorate = rows.filter((row) => row.agentId === organization.founderAgentId);
      else if (mode === 'delegated') electorate = rows.filter((row) => ['founder','coordinator'].includes(row.role));
      else if (mode === 'skill_based') electorate = rows.filter((row) =>
        Number(row.memberTopSkill) >= Number(row.organizationTopSkill)).slice(0, 1);
      else if (!['member_vote','reputation_weighted'].includes(mode)) continue;
      if (!electorate.length || (['member_vote','reputation_weighted'].includes(mode) && electorate.length < 2)) continue;

      const eventKey = `organization-capability-cycle:${organizationId}:${gap.id}:${cycle}`;
      const priorCycle = await client.query(`SELECT 1 FROM world_capability_events
        WHERE world_id=$1 AND event_key=$2 LIMIT 1`, [worldId, eventKey]);
      if (priorCycle.rowCount) continue;
      const priorProposal = await client.query(`SELECT 1 FROM world_capability_proposals
        WHERE world_id=$1 AND gap_id=$2 AND creator_organization_id=$3 AND created_world_minute>$4 LIMIT 1`,
      [worldId, gap.id, organizationId, Math.max(0, Number(worldMinute) - CAPABILITY_PROPOSAL_LIFETIME_MINUTES)]);
      if (priorProposal.rowCount) continue;

      const organizationHistory = await client.query(`SELECT event_type AS "eventType",world_minute AS "worldMinute",
          CASE WHEN event_type='organization_capability_innovation_considered' THEN jsonb_build_object(
            'decision',details->>'decision','selectedOption',details->>'selectedOption',
            'voterCount',coalesce(details->'voterCount','0'::jsonb),
            'voteCount',CASE WHEN jsonb_typeof(details->'votes')='array' THEN jsonb_array_length(details->'votes') ELSE 0 END)
          ELSE jsonb_build_object('status',details->>'status','uses',details->'uses',
            'distinctResidents',details->'distinctResidents','successes',details->'successes',
            'failures',details->'failures','successRate',details->'successRate',
            'sideEffectUses',details->'sideEffectUses','adoptionScore',details->'adoptionScore')
          END AS summary
        FROM world_capability_events WHERE world_id=$1 AND details->>'organizationId'=$2
          AND event_type IN ('organization_capability_innovation_considered','organization_capability_experiment_evaluated')
        ORDER BY world_minute DESC,id DESC LIMIT 6`, [worldId, organizationId]);
      const sponsor = electorate[0];
      const sponsorAgent = organizationMemberAgent(sponsor);
      const drafts = makeCapabilityDrafts(gap, primitives, sponsorAgent);
      if (!drafts.length) continue;
      const options = [...drafts.map((draft) => ({ id: draft.id, label: draft.name,
        description: `${gap.problemStatement} ${draft.expectedBenefit} Declared costs: ${JSON.stringify(draft.expectedCost)}.`,
        specification: draft.specification })),
      { id: 'ignore', label: 'No organizational proposal', description: 'Keep the current institutional approach for now.' }];
      const ballots = [];
      for (const row of electorate) {
        const memberAgent = organizationMemberAgent(row);
        const selected = await chooseOption(chooseWithTypeSafe, { worldId, agent: memberAgent, worldMinute,
          choiceType: 'proposal', state: { gapId: gap.id, category: gap.category,
            problemStatement: gap.problemStatement, evidence: gap.evidence,
            residentGoal: memberAgent.primaryGoal, skills: memberAgent.skills,
            relevantMemories: memberAgent.recentMemories.filter((memory) =>
              ['business','economic','failure','innovation','capability_gap','capability_use','civilization'].includes(memory.memoryType)).slice(0, 6),
            organization: { id: organizationId, name: organization.organizationName,
              purpose: organization.organizationPurpose, governanceMode: mode,
              governanceRules: jsonValue(organization.governanceRules), reputation: Number(organization.organizationReputation) || 0,
              resources: jsonValue(organization.organizationResources), memberCount: rows.length,
              priorInnovationOutcomes: organizationHistory.rows } }, options });
        const weight = mode === 'reputation_weighted'
          ? 1 + clamp(row.memberReputation, -90, 900) / 100 : 1;
        ballots.push({ row, memberAgent, selected: selected || options.at(-1), weight });
        await writeCivilizationDecisionTrace(client, { worldId, agentId: row.agentId, worldMinute,
          sourceKey: `organization-proposal-choice:${organizationId}:${gap.id}:${row.agentId}:${cycle}`,
          choiceType: 'organization_proposal', selected: selected || options.at(-1), options,
          state: { gapId: gap.id, relevantGoal: memberAgent.primaryGoal, skills: memberAgent.skills,
            evidence: gap.evidence, motivation: agentInitiative(memberAgent) } });
      }

      let selectedId = ballots[0]?.selected.id || 'ignore';
      let proposalSponsor = ballots[0]?.row || null;
      if (mode === 'member_vote' || mode === 'reputation_weighted') {
        const totals = new Map();
        const totalWeight = ballots.reduce((sum, ballot) => sum + ballot.weight, 0);
        for (const ballot of ballots) {
          if (ballot.selected.id === 'ignore') continue;
          totals.set(ballot.selected.id, (totals.get(ballot.selected.id) || 0) + ballot.weight);
        }
        const winner = [...totals.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0];
        selectedId = winner && winner[1] > totalWeight / 2 ? winner[0] : 'ignore';
        proposalSponsor = ballots.find((ballot) => ballot.selected.id === selectedId)?.row || null;
      }
      const eventDetails = { organizationId, organizationName: organization.organizationName,
        governanceMode: mode, decision: selectedId === 'ignore' ? 'retain_current_approach' : 'propose_capability',
        selectedOption: selectedId, voterCount: ballots.length,
        votes: ballots.map((ballot) => ({ agentId: ballot.row.agentId,
          optionId: ballot.selected.id, weight: ballot.weight })),
        priorInnovationOutcomes: organizationHistory.rows };
      await writeCapabilityEvent(client, { worldId, actorAgentId: proposalSponsor?.agentId || sponsor.agentId,
        gapId: gap.id, eventType: 'organization_capability_innovation_considered', eventKey, worldMinute,
        details: eventDetails });
      if (selectedId === 'ignore' || !proposalSponsor) continue;
      const draft = drafts.find((item) => item.id === selectedId);
      if (!draft) continue;
      await recordCapabilityProposal(client, { worldId, agentId: proposalSponsor.agentId, gap, draft,
        creatorOrganizationId: organizationId,
        actionId: `org-civil-proposal:${organizationId.slice(0, 8)}:${gap.id.slice(0, 8)}:${cycle}:${draft.id.slice(-14)}`,
        worldMinute });
      proposalsCreated++;
    }
  }
  return proposalsCreated;
}

export async function advanceWorldCivilization(client, { worldId, agent, worldMinute, chooseWithTypeSafe = null,
  onPhase = () => {} }) {
  onPhase('CAPABILITY_PROPOSAL_EXPIRY');
  await expireStalledCapabilityProposals(client, { worldId, worldMinute });
  onPhase('CAPABILITY_GAP_OBSERVATION');
  const gaps = await observeWorldCapabilityGaps(client, { worldId, worldMinute });
  onPhase('CAPABILITY_GAP_AWARENESS');
  for (const gap of gaps) await noteGapForResident(client, { worldId, agent, gap, worldMinute });
  onPhase('CAPABILITY_REGISTRY_READ');
  const primitives = await primitiveMap(client, worldId);
  onPhase('RESIDENT_CAPABILITY_REVIEW');
  for (const gap of gaps) {
    if (!residentRelevantToGap(agent, gap) || Number(gap.observationCount) < CAPABILITY_GAP_MIN_OBSERVATIONS
        || Number(worldMinute) - Number(gap.firstObservedWorldMinute) < CAPABILITY_GAP_MIN_AGE_MINUTES) continue;
    const existing = await client.query(`SELECT 1 FROM world_capability_proposals WHERE world_id=$1 AND gap_id=$2
      AND creator_agent_id=$3 LIMIT 1`, [worldId, gap.id, agent.agentId]);
    if (existing.rowCount) continue;
    const drafts = makeCapabilityDrafts(gap, primitives, agent);
    if (!drafts.length) continue;
    const options = [...drafts.map((draft) => ({ id: draft.id, label: draft.name,
      description: `${gap.problemStatement} Proposed effects: ${draft.expectedBenefit}. Declared costs: ${JSON.stringify(draft.expectedCost)}.`,
      specification: draft.specification })),
    { id: 'ignore', label: 'Do nothing', description: 'Do not propose a new capability now.' }];
    const selected = await chooseOption(chooseWithTypeSafe, { worldId, agent, worldMinute, choiceType: 'proposal',
      state: { gapId: gap.id, category: gap.category, problemStatement: gap.problemStatement, evidence: gap.evidence,
        residentGoal: agent.primaryGoal || agent.goal, goals: agent.goals || [], skills: agent.skills || {},
        relevantMemories: (agent.recentMemories || []).filter((memory) =>
          ['business','economic','failure','innovation','capability_gap','capability_use','civilization'].includes(memory.memoryType)).slice(0, 8) },
      options });
    await writeCivilizationDecisionTrace(client, { worldId, agentId: agent.agentId, worldMinute,
      sourceKey: `proposal-choice:${gap.id}:${agent.agentId}:${Math.floor(worldMinute / CIVILIZATION_REVIEW_INTERVAL_MINUTES)}`,
      choiceType: 'proposal', selected, options, state: { gapId: gap.id,
        residentGoal: agent.primaryGoal || agent.goal, skills: agent.skills || {}, evidence: gap.evidence,
        motivation: agentInitiative(agent) } });
    await writeCapabilityEvent(client, { worldId, actorAgentId: agent.agentId, gapId: gap.id,
      eventType: 'capability_innovation_considered',
      eventKey: `capability-considered:${gap.id}:${agent.agentId}:${Math.floor(worldMinute / CIVILIZATION_REVIEW_INTERVAL_MINUTES)}`,
      worldMinute, details: { selectedOption: selected?.id || 'ignore', optionCount: options.length,
        motivation: agentInitiative(agent), evidence: gap.evidence } });
    if (!selected || selected.id === 'ignore') continue;
    const draft = drafts.find((item) => item.id === selected.id);
    if (!draft) continue;
    await recordCapabilityProposal(client, { worldId, agentId: agent.agentId, gap, draft,
      actionId: `civil-proposal:${gap.id.slice(0, 8)}:${agent.agentId.slice(0, 8)}:${draft.id.slice(-14)}`, worldMinute });
  }
  onPhase('ORGANIZATION_CAPABILITY_REVIEW');
  const organizationProposals = await advanceOrganizationCapabilityCycles(client, { worldId, gaps, primitives,
    worldMinute, chooseWithTypeSafe });
  onPhase('CAPABILITY_EXPERIENCE_REVIEW');
  await reviewExperiences(client, { worldId, agent, worldMinute, chooseWithTypeSafe });
  onPhase('CAPABILITY_PROPOSAL_REVIEW');
  await reviewOpenProposals(client, { worldId, agent, worldMinute, chooseWithTypeSafe });
  onPhase('CAPABILITY_EXPERIMENT_START');
  const experiments = await startReadyExperiments(client, worldId, worldMinute);
  onPhase('CAPABILITY_EXPERIMENT_EVALUATION');
  const outcomes = await evaluateWorldCapabilityExperiments(client, { worldId, worldMinute });
  return { gapsObserved: gaps.length, proposalsCreated: organizationProposals,
    experimentsStarted: experiments.length, experimentsEvaluated: outcomes.length };
}

function buildResearchCapabilityCandidates(agent, row, context = {}) {
  const opportunities = context.researchInputs?.researchOpportunitiesByAgent?.get(agent.agentId) || [];
  if (!opportunities.length) return [];
  const curious = clamp(agent.curiosity ?? agent.traits?.curiosity, 0, 1);
  const researchSkill = Math.max(0, Number(agent.skills?.research) || 0);
  const priorUses = (agent.recentMemories || []).filter((memory) => memory.memoryType === 'capability_use'
    && String(memory.metadata?.capabilityId) === String(row.id));
  return opportunities.filter((item) => item?.objective && item?.label && item?.relationType && item?.relationId)
    .map((opportunity) => {
    const goalAligned = /research|learn|study|investigate|analy[sz]|build|engineer/i.test(
      `${opportunity.label} ${opportunity.objective} ${agent.primaryGoal || ''} ${agent.currentGoal || ''}`);
    const naturalScore = 20 + curious * 10 + researchSkill * 0.08 + (goalAligned ? 12 : 0)
      + (priorUses[0]?.metadata?.success === true ? 4 : priorUses[0]?.metadata?.success === false ? -8 : 0);
    const discoveryInterest = clamp(curious * 0.55 + (goalAligned ? 0.3 : 0) + researchSkill / 700, 0, 1);
    const discoverableScore = Number(context.maxAlternativeScore) > 0
      ? Number(context.maxAlternativeScore) * (0.55 + discoveryInterest * 0.2) : 0;
    const artifact = opportunity;
    const objective = `${opportunity.label}: ${opportunity.relevanceDescription || opportunity.objective}`.slice(0, 1_600);
    const researchIntent = {
      artifactId: String(artifact.id), targetType: artifact.targetType,
      researchQuestion: `What evidence does ${artifact.displayName} provide about ${opportunity.label}?`.slice(0, 1_200),
      objective,
      desiredInvestigation: `Use REA's supported ${artifact.targetType} analysis to examine the artifact for evidence relevant to this existing ${opportunity.relationType}.`,
      expectedResult: `A bounded, evidence-backed summary of findings and unresolved questions relevant to ${opportunity.label}.`,
      relationType: opportunity.relationType, relationId: String(opportunity.relationId)
    };
    return { id: `research:${row.id}:${artifact.id}:${opportunity.relationType}:${opportunity.relationId}`,
      action: 'capability_use', targetLocation: agent.location,
      goal: `Optional REA research for ${opportunity.label}: ${artifact.displayName}`,
      score: Math.max(naturalScore, discoverableScore), capabilityId: row.id,
      capabilityName: row.name, capabilityExperimentId: null,
      description: `Optional evidence-based investigation of an available ${artifact.targetType} artifact in service of the resident's existing ${opportunity.relationType}.`,
      capabilityContext: { capabilityId: row.id, experimentId: null,
        worldMinutes: Number(context.worldMinutes) || 0, researchIntent } };
  });
}

export async function buildCapabilityUseCandidates(agent, capabilities, context = {}) {
  const candidates = [];
  for (const row of Array.isArray(capabilities) ? capabilities : []) {
    const spec = jsonValue(row.specification);
    if (spec.kind === 'native_system' && spec.systemKey === RESEARCH_CAPABILITY_KEY) {
      candidates.push(...buildResearchCapabilityCandidates(agent, row, context));
      continue;
    }
    if (spec.kind !== 'composition') continue;
    const requirements = spec.requirements || {};
    if (Number(agent.energy) < Number(requirements.minEnergy ?? 20) || Number(agent.food) < Number(requirements.minFood ?? 8)) continue;
    if (Object.entries(requirements.skills || {}).some(([skill, minimum]) => Number(agent.skills?.[skill] || 0) < Number(minimum))) continue;
    const experimentScope = jsonValue(row.experimentScope);
    if (row.status === 'experimental') {
      if (!row.experimentStatus || !ACTIVE_EXPERIMENT_STATES.includes(row.experimentStatus)
          || !(experimentScope.participantAgentIds || []).includes(agent.agentId)) continue;
    }
    const scope = row.status === 'experimental'
      ? { type: experimentScope.scopeType, id: experimentScope.scopeId } : spec.scope;
    if (!residentWithinCapabilityScope(agent, scope, context)) continue;
    const partnerRequired = requirements.partnerRequired || Number(spec.participants?.minimum) > 1;
    const partner = partnerRequired ? (context.residentsAtLocation?.[agent.location] || []).filter((resident) => resident.agentId !== agent.agentId
      && Number(resident.energy) >= Number(requirements.minEnergy ?? 20)
      && Number(resident.food) >= Number(requirements.minFood ?? 8)
      && residentWithinCapabilityScope(resident, scope, context)
      && (row.status !== 'experimental' || (experimentScope.participantAgentIds || []).includes(resident.agentId)))
      .sort((left, right) => Number(right.relationship?.trust || 0) - Number(left.relationship?.trust || 0)
        || Number(right.relationship?.familiarity || 0) - Number(left.relationship?.familiarity || 0)
        || String(left.agentId).localeCompare(String(right.agentId)))[0] || null : null;
    if (partnerRequired && !partner) continue;
    const goal = `${row.name}: ${row.description}`;
    const curiosity = clamp(agent.curiosity ?? agent.traits?.curiosity, 0, 1);
    const skills = Object.keys(requirements.skills || {}).reduce((sum, skill) => sum + Number(agent.skills?.[skill] || 0), 0);
    const goalMatch = /learn|research|community|collaborat|build/i.test(`${agent.primaryGoal || ''} ${agent.currentGoal || ''}`) ? 10 : 0;
    const experimentBonus = row.status === 'experimental' ? 5 : 0;
    const priorUses = (agent.recentMemories || []).filter((memory) => memory.memoryType === 'capability_use'
      && String(memory.metadata?.capabilityId) === String(row.id));
    const priorResult = priorUses.length ? (priorUses[0].metadata?.success ? 7 : -12) : 0;
    const similarFailures = (agent.recentMemories || []).filter((memory) => memory.memoryType === 'innovation'
      && memory.metadata?.category === row.category && memory.metadata?.status === 'rejected').length;
    const naturalScore = 27 + curiosity * 16 + goalMatch + skills * 0.04 + experimentBonus + priorResult;
    const goalAligned = /learn|research|community|collaborat|build/i.test(`${agent.primaryGoal || ''} ${agent.currentGoal || ''}`);
    const residentSkillFit = Math.max(0, ...Object.values(agent.skills || {}).map((value) => Number(value) || 0)) / 100;
    const discoveryInterest = clamp(curiosity * 0.5 + (goalAligned ? 0.3 : 0) + residentSkillFit * 0.15
      + (priorUses[0]?.metadata?.success === true ? 0.2 : 0), 0, 1);
    const discoverableScore = Number(context.maxAlternativeScore) > 0
      ? Number(context.maxAlternativeScore) * (0.58 + discoveryInterest * 0.21) : 0;
    candidates.push({ id: `capability:${row.id}`, action: 'capability_use', targetLocation: agent.location,
      goal, score: Math.max(naturalScore, discoverableScore) - similarFailures * 2,
      capabilityId: row.id, capabilityName: row.name, capabilityExperimentId: row.experimentId || null,
      socialPartnerId: partner?.agentId || null, socialPartnerName: partner?.name || null,
      description: `Use this ${row.status === 'experimental' ? 'bounded experiment' : 'adopted world capability'}; prior personal result ${priorUses[0]?.metadata?.success === true ? 'was useful' : priorUses[0]?.metadata?.success === false ? 'was unsuccessful' : 'is unknown'}.`,
      capabilityContext: { capabilityId: row.id, experimentId: row.experimentId || null,
        partnerAgentId: partner?.agentId || null, worldMinutes: Number(context.worldMinutes) || 0 } });
  }
  return candidates;
}

export async function listWorldCapabilityUses(client, { worldId, limit = 100 }) {
  const result = await client.query(`SELECT capability.id,capability.capability_key AS "capabilityKey",
      capability.category,capability.name,capability.description,capability.status,capability.version,
      capability.parent_capability_id AS "parentCapabilityId",capability.creator_type AS "creatorType",
      capability.creator_agent_id AS "creatorAgentId",capability.creator_organization_id AS "creatorOrganizationId",
      capability.specification,capability.experiment_scope AS "experimentScope",
      experiment.id AS "experimentId",experiment.status AS "experimentStatus"
    FROM world_capabilities capability LEFT JOIN world_capability_experiments experiment
      ON experiment.world_id=capability.world_id AND experiment.capability_id=capability.id AND experiment.status='running'
    WHERE capability.world_id=$1 AND (capability.status='active' OR (capability.status='experimental' AND experiment.status='running'))
    ORDER BY capability.status='active' DESC,capability.name,capability.id LIMIT $2`, [worldId, Math.min(500, Math.max(1, limit))]);
  if (!await isGenesisCurrencyActive(client, worldId)) return result.rows;
  return result.rows.filter((row) => !jsonValue(row.specification).costs?.some((cost) => cost.resource === 'simulated_usdc'));
}

function residentWithinCapabilityScope(agent, scope, context = {}) {
  if (!scope || scope.type === 'resident_set') return true;
  if (scope.type === 'organization') return (agent.organizationMemberships || []).some((item) =>
    item.memberStatus === 'active' && item.id === scope.id);
  if (scope.type === 'project') return (agent.projectMemberships || []).some((item) =>
    item.status === 'active' && item.projectId === scope.id);
  if (scope.type === 'place') return context.placeIdsByName?.[agent.location] === scope.id;
  return false;
}

function boundedNeedDelta(value) { return Math.max(0, Math.min(100, Number(value) || 0)); }

async function changeRelationship(client, worldId, actorId, partnerId, step, worldMinute) {
  const [leftId, rightId] = [actorId, partnerId].sort();
  const result = await client.query(`INSERT INTO world_relationships(world_id,agent_a_id,agent_b_id,familiarity,trust,affinity,
      last_interaction_world_minutes,interaction_count)
    VALUES($1,$2,$3,
      LEAST(100::numeric,GREATEST(0::numeric,$4::numeric)),
      LEAST(100::numeric,GREATEST(-100::numeric,$5::numeric)),
      LEAST(100::numeric,GREATEST(-100::numeric,$6::numeric)),$7,1)
    ON CONFLICT(world_id,agent_a_id,agent_b_id) DO UPDATE SET
      familiarity=LEAST(100::numeric,GREATEST(0::numeric,world_relationships.familiarity+$4::numeric)),
      trust=LEAST(100::numeric,GREATEST(-100::numeric,world_relationships.trust+$5::numeric)),
      affinity=LEAST(100::numeric,GREATEST(-100::numeric,world_relationships.affinity+$6::numeric)),
      last_interaction_world_minutes=$7,interaction_count=world_relationships.interaction_count+1,updated_at=now()
    RETURNING familiarity::text AS familiarity,trust::text AS trust,affinity::text AS affinity`,
  [worldId, leftId, rightId, Number(step.familiarity) || 0, Number(step.trust) || 0, Number(step.affinity) || 0, worldMinute]);
  return result.rows[0];
}

async function applyCapabilityPrimitive(client, { worldId, actorId, partnerId, capabilityId, step, actionId, worldMinute, agentEnergy }) {
  if (step.primitive === 'resident.skill_gain') {
    const targetId = step.target === 'partner' ? partnerId : actorId;
    if (!targetId) throw capabilityError('CAPABILITY_PARTNER_REQUIRED');
    const result = await client.query(`INSERT INTO world_agent_skills(world_id,agent_id,skill_name,skill_value,actions_completed)
      VALUES($1,$2,$3,$4,1) ON CONFLICT(world_id,agent_id,skill_name) DO UPDATE SET
        skill_value=LEAST(100,world_agent_skills.skill_value+EXCLUDED.skill_value),
        actions_completed=world_agent_skills.actions_completed+1,updated_at=now()
      RETURNING skill_name AS skill,"skill_value"::text AS value`, [worldId, targetId, step.skill, step.amount]);
    return { primitive: step.primitive, targetAgentId: targetId, ...result.rows[0] };
  }
  if (step.primitive === 'resident.knowledge_gain') {
    const result = await client.query(`UPDATE world_agent_states SET knowledge=LEAST(100,knowledge+$3),updated_at=now()
      WHERE world_id=$1 AND agent_id=$2 RETURNING knowledge`, [worldId, actorId, Math.round(step.amount)]);
    if (!result.rowCount) throw capabilityError('CAPABILITY_RESIDENT_STATE_MISSING');
    return { primitive: step.primitive, targetAgentId: actorId, knowledge: result.rows[0].knowledge };
  }
  if (step.primitive === 'relationship.adjust') {
    if (!partnerId) throw capabilityError('CAPABILITY_PARTNER_REQUIRED');
    return { primitive: step.primitive, targetAgentId: partnerId,
      relationship: await changeRelationship(client, worldId, actorId, partnerId, step, worldMinute) };
  }
  if (step.primitive === 'organization.contribute') {
    const scope = await client.query(`SELECT specification->'scope'->>'id' AS id FROM world_capabilities
      WHERE world_id=$1 AND id=$2`, [worldId, capabilityId]);
    const organizationId = scope.rows[0]?.id;
    if (!organizationId) throw capabilityError('CAPABILITY_ORGANIZATION_SCOPE_REQUIRED');
    const contribution = await contributeOrganizationEffort(client, { worldId, organizationId, agentId: actorId,
      actionId: `${actionId}:organization`, worldTime: worldMinute, effort: step.effort });
    return { primitive: step.primitive, organizationId, effort: step.effort, idempotent: contribution.idempotent || false };
  }
  if (step.primitive === 'project.contribute') {
    const scope = await client.query(`SELECT specification->'scope'->>'id' AS id FROM world_capabilities
      WHERE world_id=$1 AND id=$2`, [worldId, capabilityId]);
    const projectId = scope.rows[0]?.id;
    if (!projectId) throw capabilityError('CAPABILITY_PROJECT_SCOPE_REQUIRED');
    const contribution = await contributeToProject(client, { worldId, projectId, agentId: actorId,
      actionId: `${actionId}:project`, worldTime: worldMinute, contributionType: step.contributionType,
      skillValue: step.skillValue, energy: agentEnergy });
    return { primitive: step.primitive, projectId, completed: contribution.completed,
      progress: contribution.contribution?.progress || null, idempotent: contribution.idempotent || false };
  }
  throw capabilityError('CAPABILITY_PRIMITIVE_UNSUPPORTED', 400);
}

async function resolveSteps(client, worldId, specification, visited = new Set(), depth = 0) {
  if (depth > MAX_COMPOSITION_DEPTH) throw capabilityError('CAPABILITY_COMPOSITION_TOO_DEEP', 400);
  const spec = validateCapabilitySpecification(specification);
  if (spec.kind === 'primitive' || spec.kind === 'native_system') return [];
  const steps = [];
  for (const item of spec.composition) {
    if (visited.has(item.capabilityId)) throw capabilityError('CAPABILITY_COMPOSITION_CYCLE', 400);
    const component = await client.query(`SELECT status,specification FROM world_capabilities
      WHERE world_id=$1 AND id=$2`, [worldId, item.capabilityId]);
    if (!component.rowCount || component.rows[0].status === 'rejected' || component.rows[0].status === 'deprecated') {
      throw capabilityError('CAPABILITY_COMPOSITION_PARENT_UNAVAILABLE', 409);
    }
    const componentSpec = jsonValue(component.rows[0].specification);
    if (componentSpec.kind === 'native_system') throw capabilityError('CAPABILITY_COMPONENT_NOT_EXECUTABLE', 409);
    if (componentSpec.kind === 'primitive') {
      steps.push(normalizePrimitiveStep({ primitive: componentSpec.primitiveId, ...item.parameters }));
    } else {
      if (Object.keys(item.parameters || {}).length) throw capabilityError('CAPABILITY_COMPOSITE_PARAMETERS_UNSUPPORTED', 400);
      const nextVisited = new Set(visited);
      nextVisited.add(item.capabilityId);
      steps.push(...await resolveSteps(client, worldId, componentSpec, nextVisited, depth + 1));
    }
  }
  steps.push(...spec.steps);
  return steps;
}

async function recordFailedCapabilityUse(client, { worldId, agentId, partnerId, capability, experimentId,
  actionId, decisionSource, worldMinute, error }) {
  const failureCode = /^[A-Z0-9_]{3,96}$/.test(String(error?.message || ''))
    ? String(error.message) : 'CAPABILITY_EXECUTION_FAILED';
  const costs = { energy: 1, food: 0.5, simulatedUsdc: '0.00000000' };
  const result = { capabilityId: capability.id, capabilityName: capability.name,
    experimentId: experimentId || null, decisionSource, status: 'failed', success: false,
    failureCode, rollbackApplied: true, costs, effects: [] };
  const inserted = await client.query(`INSERT INTO world_capability_uses(world_id,capability_id,experiment_id,actor_agent_id,
      partner_agent_id,action_id,decision_source,world_minute,status,success,costs,effects,side_effects,result)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,'failed',false,$9::jsonb,'[]'::jsonb,'[]'::jsonb,$10::jsonb)
    ON CONFLICT(world_id,action_id) DO NOTHING RETURNING id`,
  [worldId, capability.id, experimentId || null, agentId, partnerId, actionId, decisionSource, worldMinute,
    JSON.stringify(costs), JSON.stringify(result)]);
  if (!inserted.rowCount) {
    const prior = await client.query(`SELECT id,capability_id AS "capabilityId",success,status,costs,result
      FROM world_capability_uses WHERE world_id=$1 AND action_id=$2`, [worldId, actionId]);
    if (prior.rowCount && prior.rows[0].capabilityId === capability.id) return { ...prior.rows[0], idempotent: true };
    throw capabilityError('CAPABILITY_ACTION_ID_CONFLICT', 409);
  }
  const useId = inserted.rows[0].id;
  await client.query(`UPDATE world_capabilities SET usage_count=usage_count+1,failure_count=failure_count+1,updated_at=now()
    WHERE world_id=$1 AND id=$2`, [worldId, capability.id]);
  await writeCapabilityEvent(client, { worldId, actorAgentId: agentId, capabilityId: capability.id,
    experimentId: experimentId || null, eventType: 'capability_use_failed', eventKey: `capability-use:${actionId}`,
    worldMinute, details: { ...result, useId: String(useId) } });
  await client.query(`INSERT INTO world_events(world_id,actor_id,event_type,data,action_id)
    VALUES($1,$2,'world.capability_use_failed',$3::jsonb,$4) ON CONFLICT(world_id,actor_id,action_id) DO NOTHING`,
  [worldId, agentId, JSON.stringify({ ...result, useId: String(useId), partnerAgentId: partnerId, worldMinute }), actionId]);
  await writeWorldHistory(client, { worldId, eventKey: `capability-use:${useId}`, eventType: 'capability_use_failed',
    actorAgentId: agentId, entityType: 'capability', entityId: capability.id, worldTime: worldMinute,
    title: `${capability.name} use failed`,
    detail: `The declared action failed with ${failureCode}; partial effects and transfers were rolled back.`,
    metadata: { useId: String(useId), experimentId: experimentId || null, partnerAgentId: partnerId,
      failureCode, costs, effects: [] } });
  await client.query(`INSERT INTO agent_memories(world_id,agent_id,memory_type,summary,importance,world_minutes,
      related_agent_id,metadata)
    VALUES($1,$2,'capability_use',$3,0.68,$4,$5,$6::jsonb)`, [worldId, agentId,
    memorySummary(`My use of “${capability.name}” failed (${failureCode}); the world rolled back partial effects.`),
    worldMinute, partnerId, JSON.stringify({ capabilityId: capability.id, experimentId: experimentId || null,
      useId: String(useId), success: false, failureCode, costs, effects: [] })]);
  return { ...result, id: String(useId), useId: String(useId), idempotent: false };
}

export async function performWorldCapabilityUse(client, { worldId, agentId, partnerId = null, capabilityId,
  experimentId = null, actionId: rawActionId, worldMinute, agentEnergy = 50, selectionSource = 'agent_api' }) {
  await requireWorldMember(client, worldId, agentId);
  if (!UUID_RE.test(String(capabilityId || ''))) throw capabilityError('CAPABILITY_ID_INVALID', 400);
  const actionId = actionIdentifier(rawActionId);
  const decisionSource = ['agent_api', 'fruitfly', 'utility_fallback'].includes(selectionSource)
    ? selectionSource : 'agent_api';
  if (partnerId && partnerId === agentId) throw capabilityError('CAPABILITY_SELF_PARTICIPATION_INVALID', 400);
  const duplicate = await client.query(`SELECT id,capability_id AS "capabilityId",experiment_id AS "experimentId",
      status,success,costs,effects,result FROM world_capability_uses WHERE world_id=$1 AND action_id=$2`, [worldId, actionId]);
  if (duplicate.rowCount) {
    const row = duplicate.rows[0];
    if (row.capabilityId !== capabilityId) throw capabilityError('CAPABILITY_ACTION_ID_CONFLICT', 409);
    return { ...row, idempotent: true };
  }
  const selected = await client.query(`SELECT capability.*,experiment.id AS "runningExperimentId",
      experiment.status AS "experimentStatus",experiment.participant_agent_ids AS "participantAgentIds"
    FROM world_capabilities capability LEFT JOIN world_capability_experiments experiment
      ON experiment.world_id=capability.world_id AND experiment.capability_id=capability.id AND experiment.status='running'
    WHERE capability.world_id=$1 AND capability.id=$2 FOR UPDATE OF capability`, [worldId, capabilityId]);
  if (!selected.rowCount) throw capabilityError('CAPABILITY_NOT_FOUND', 404);
  const capability = selected.rows[0];
  const duplicateAfterLock = await client.query(`SELECT id,capability_id AS "capabilityId",experiment_id AS "experimentId",
      status,success,costs,effects,result FROM world_capability_uses WHERE world_id=$1 AND action_id=$2`, [worldId, actionId]);
  if (duplicateAfterLock.rowCount) {
    const row = duplicateAfterLock.rows[0];
    if (row.capabilityId !== capabilityId) throw capabilityError('CAPABILITY_ACTION_ID_CONFLICT', 409);
    return { ...row, idempotent: true };
  }
  const spec = validateCapabilitySpecification(jsonValue(capability.specification));
  if (await isGenesisCurrencyActive(client, worldId)
      && spec.costs.some((cost) => cost.resource === 'simulated_usdc')) {
    throw capabilityError('LEGACY_SIMULATED_ECONOMY_RETIRED', 409);
  }
  const experiment = capability.runningExperimentId ? {
    id: capability.runningExperimentId,
    participantAgentIds: capability.participantAgentIds
  } : null;
  if (capability.status === 'experimental') {
    const members = jsonValue(experiment?.participantAgentIds, []);
    if (!experiment) throw capabilityError('CAPABILITY_EXPERIMENT_NOT_RUNNING', 403);
    if (experimentId && experiment.id !== experimentId) throw capabilityError(
      `CAPABILITY_EXPERIMENT_ID_MISMATCH:${String(experimentId).slice(0, 8)}:${String(experiment.id).slice(0, 8)}`, 403);
    if (!members.includes(agentId)) throw capabilityError('CAPABILITY_EXPERIMENT_ACTOR_NOT_PARTICIPANT', 403);
    if (partnerId && !members.includes(partnerId)) throw capabilityError('CAPABILITY_EXPERIMENT_PARTNER_NOT_PARTICIPANT', 403);
  } else if (capability.status !== 'active') throw capabilityError('CAPABILITY_NOT_USABLE', 409);
  const participantIds = partnerId ? [agentId, partnerId] : [agentId];
  if (participantIds.length < Number(spec.participants?.minimum || 1)
      || participantIds.length > Number(spec.participants?.maximum || 4)) throw capabilityError('CAPABILITY_PARTICIPANTS_REQUIRED');
  if (spec.requirements.partnerRequired && !partnerId) throw capabilityError('CAPABILITY_PARTNER_REQUIRED');
  const memberStates = await client.query(`SELECT agent_id AS "agentId",energy,food,location FROM world_members
    WHERE world_id=$1 AND agent_id=ANY($2::uuid[])`, [worldId, participantIds]);
  if (memberStates.rowCount !== participantIds.length) throw capabilityError('CAPABILITY_PARTICIPANT_NOT_IN_WORLD', 403);
  const actor = memberStates.rows.find((row) => row.agentId === agentId);
  if (Number(actor.energy) < Number(spec.requirements.minEnergy) || Number(actor.food) < Number(spec.requirements.minFood)) {
    throw capabilityError('CAPABILITY_NEEDS_NOT_MET');
  }
  if (partnerId) {
    const partner = memberStates.rows.find((row) => row.agentId === partnerId);
    if (Number(partner.energy) < Number(spec.requirements.minEnergy) || Number(partner.food) < Number(spec.requirements.minFood)) {
      throw capabilityError('CAPABILITY_PARTNER_NEEDS_NOT_MET');
    }
  }
  if (spec.scope.type === 'organization') {
    const scoped = await client.query(`SELECT count(DISTINCT agent_id)::int AS count FROM world_organization_members
      WHERE world_id=$1 AND organization_id=$2 AND status='active' AND agent_id=ANY($3::uuid[])`,
    [worldId, spec.scope.id, participantIds]);
    if (scoped.rows[0].count !== participantIds.length) throw capabilityError('CAPABILITY_SCOPE_VIOLATION', 403);
  } else if (spec.scope.type === 'project') {
    const scoped = await client.query(`SELECT count(DISTINCT agent_id)::int AS count FROM world_project_members
      WHERE world_id=$1 AND project_id=$2 AND status='active' AND agent_id=ANY($3::uuid[])`,
    [worldId, spec.scope.id, participantIds]);
    if (scoped.rows[0].count !== participantIds.length) throw capabilityError('CAPABILITY_SCOPE_VIOLATION', 403);
  } else if (spec.scope.type === 'place') {
    const scene = await client.query(`SELECT name FROM world_scenes WHERE world_id=$1 AND id=$2 AND status='active'`,
      [worldId, spec.scope.id]);
    if (!scene.rowCount || memberStates.rows.some((resident) => resident.location !== scene.rows[0].name)) {
      throw capabilityError('CAPABILITY_SCOPE_VIOLATION', 403);
    }
  }
  if (experiment) {
    const experimentScope = jsonValue(capability.experiment_scope);
    const scopeType = experimentScope.scopeType;
    const scopeId = experimentScope.scopeId;
    if (scopeType === 'organization') {
      const scoped = await client.query(`SELECT count(DISTINCT agent_id)::int AS count FROM world_organization_members
        WHERE world_id=$1 AND organization_id=$2 AND status='active' AND agent_id=ANY($3::uuid[])`,
      [worldId, scopeId, participantIds]);
      if (!scopeId || scoped.rows[0].count !== participantIds.length) throw capabilityError('CAPABILITY_EXPERIMENT_SCOPE_VIOLATION', 403);
    } else if (scopeType === 'project') {
      const scoped = await client.query(`SELECT count(DISTINCT agent_id)::int AS count FROM world_project_members
        WHERE world_id=$1 AND project_id=$2 AND status='active' AND agent_id=ANY($3::uuid[])`,
      [worldId, scopeId, participantIds]);
      if (!scopeId || scoped.rows[0].count !== participantIds.length) throw capabilityError('CAPABILITY_EXPERIMENT_SCOPE_VIOLATION', 403);
    } else if (scopeType === 'place') {
      const scene = await client.query(`SELECT name FROM world_scenes WHERE world_id=$1 AND id=$2 AND status='active'`,
        [worldId, scopeId]);
      if (!scene.rowCount || memberStates.rows.some((resident) => resident.location !== scene.rows[0].name)) {
        throw capabilityError('CAPABILITY_EXPERIMENT_SCOPE_VIOLATION', 403);
      }
    }
  }
  const actorSkills = await client.query(`SELECT skill_name,skill_value::text AS value FROM world_agent_skills
    WHERE world_id=$1 AND agent_id=$2`, [worldId, agentId]);
  const skills = Object.fromEntries(actorSkills.rows.map((row) => [row.skill_name, Number(row.value)]));
  for (const [skill, minimum] of Object.entries(spec.requirements.skills || {})) {
    if (Number(skills[skill] || 0) < Number(minimum)) throw capabilityError('CAPABILITY_REQUIRED_SKILL_MISSING');
  }
  const costObject = { energy: 0, food: 0, simulatedUsdc: '0.00000000' };
  for (const cost of spec.costs) {
    if (cost.resource === 'energy') costObject.energy += Number(cost.amount);
    else if (cost.resource === 'food') costObject.food += Number(cost.amount);
  }
  if (Number(actor.energy) - costObject.energy < 0 || Number(actor.food) - costObject.food < 0) {
    throw capabilityError('CAPABILITY_COST_UNAFFORDABLE');
  }
  const steps = await resolveSteps(client, worldId, spec);
  if (!steps.length) throw capabilityError('CAPABILITY_NO_EXECUTABLE_EFFECTS', 409);
  await client.query('SAVEPOINT capability_execution');
  let savepointOpen = true;
  try {
    let simulatedUsdcUnits = 0n;
    for (const [costIndex, cost] of spec.costs.filter((item) => item.resource === 'simulated_usdc').entries()) {
      const payer = cost.payer === 'partner' ? partnerId : agentId;
      const beneficiary = cost.beneficiary === 'partner' ? partnerId : agentId;
      if (!payer || !beneficiary) throw capabilityError('CAPABILITY_PARTNER_REQUIRED');
      await ensureResidentEconomicAccounts(client, { worldId, agentId: payer, worldTime: worldMinute });
      await ensureResidentEconomicAccounts(client, { worldId, agentId: beneficiary, worldTime: worldMinute });
      simulatedUsdcUnits += parsePositiveUnits(cost.amount);
      await transferBetweenAccounts(client, { worldId, source: { accountType: 'resident', ownerId: payer },
        destination: { accountType: 'resident', ownerId: beneficiary }, amount: cost.amount,
        transactionType: 'capability_service', reason: `Simulated internal settlement for ${capability.name}.`,
        worldTime: worldMinute, actionId: `capability-settlement:${actionId}:${costIndex}`, referenceId: capability.id,
        metadata: { simulated: true, capabilityId: capability.id, experimentId: experiment?.id || null } });
      costObject.simulatedUsdc = `${simulatedUsdcUnits / 100_000_000n}.${String(simulatedUsdcUnits % 100_000_000n).padStart(8, '0')}`;
    }
    const useInsert = await client.query(`INSERT INTO world_capability_uses(world_id,capability_id,experiment_id,actor_agent_id,
        partner_agent_id,action_id,decision_source,world_minute,status,success,costs,effects,side_effects,result)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,'completed',true,$9::jsonb,'[]'::jsonb,'[]'::jsonb,'{}'::jsonb)
      ON CONFLICT(world_id,action_id) DO NOTHING RETURNING id`, [worldId, capability.id, experiment?.id || null, agentId,
      partnerId, actionId, decisionSource, worldMinute, JSON.stringify(costObject)]);
    if (!useInsert.rowCount) {
      await client.query('ROLLBACK TO SAVEPOINT capability_execution');
      await client.query('RELEASE SAVEPOINT capability_execution');
      savepointOpen = false;
      const prior = await client.query(`SELECT id,capability_id AS "capabilityId",experiment_id AS "experimentId",
          status,success,costs,effects,result FROM world_capability_uses WHERE world_id=$1 AND action_id=$2`, [worldId, actionId]);
      if (prior.rowCount && prior.rows[0].capabilityId === capability.id) {
        return { ...prior.rows[0], idempotent: true };
      }
      throw capabilityError('CAPABILITY_ACTION_ID_CONFLICT', 409);
    }
    const useId = useInsert.rows[0].id;
    const effects = [];
    for (const step of steps) effects.push(await applyCapabilityPrimitive(client, { worldId, actorId: agentId, partnerId,
      capabilityId: capability.id, step, actionId: `capuse:${useId}:${effects.length}`, worldMinute, agentEnergy }));
    const result = { capabilityId: capability.id, capabilityName: capability.name, experimentId: experiment?.id || null,
      decisionSource,
      useId: String(useId), status: 'completed', success: true, effects, costs: costObject };
    await client.query(`UPDATE world_capability_uses SET effects=$3::jsonb,result=$4::jsonb WHERE world_id=$1 AND id=$2`,
      [worldId, useId, JSON.stringify(effects), JSON.stringify(result)]);
    await client.query(`UPDATE world_capabilities SET usage_count=usage_count+1,success_count=success_count+1,updated_at=now()
      WHERE world_id=$1 AND id=$2`, [worldId, capability.id]);
    await writeCapabilityEvent(client, { worldId, actorAgentId: agentId, capabilityId: capability.id,
      experimentId: experiment?.id || null, eventType: 'capability_used', eventKey: `capability-use:${actionId}`,
      worldMinute, details: result });
    await client.query(`INSERT INTO world_events(world_id,actor_id,event_type,data,action_id)
      VALUES($1,$2,'world.capability_used',$3::jsonb,$4) ON CONFLICT(world_id,actor_id,action_id) DO NOTHING`,
    [worldId, agentId, JSON.stringify({ ...result, partnerAgentId: partnerId, worldMinute }), actionId]);
    await writeWorldHistory(client, { worldId, eventKey: `capability-use:${useId}`, eventType: 'capability_used',
      actorAgentId: agentId, entityType: 'capability', entityId: capability.id, worldTime: worldMinute,
      title: `${capability.name} used`.slice(0, 120), detail: `A resident used ${capability.name}; the declared effects were applied and audited.`,
      metadata: { useId: String(useId), experimentId: experiment?.id || null, partnerAgentId: partnerId,
        costs: costObject, effectCount: effects.length } });
    await client.query(`INSERT INTO agent_memories(world_id,agent_id,memory_type,summary,importance,world_minutes,
        related_agent_id,metadata)
      VALUES($1,$2,'capability_use',$3,0.7,$4,$5,$6::jsonb)
      ON CONFLICT DO NOTHING`, [worldId, agentId,
      memorySummary(`I used “${capability.name}”; it completed with ${effects.length} recorded effect${effects.length === 1 ? '' : 's'}.`),
      worldMinute, partnerId, JSON.stringify({ capabilityId: capability.id, experimentId: experiment?.id || null,
        useId: String(useId), success: true, costs: costObject, effects })]);
    if (partnerId) await client.query(`INSERT INTO agent_memories(world_id,agent_id,memory_type,summary,importance,world_minutes,
        related_agent_id,metadata)
      VALUES($1,$2,'capability_use',$3,0.58,$4,$5,$6::jsonb)
      ON CONFLICT DO NOTHING`, [worldId, partnerId,
      memorySummary(`I participated in “${capability.name}”; the declared effects were applied and audited.`),
      worldMinute, agentId, JSON.stringify({ capabilityId: capability.id, experimentId: experiment?.id || null,
        useId: String(useId), success: true, costs: costObject, effects })]);
    await client.query('RELEASE SAVEPOINT capability_execution');
    savepointOpen = false;
    return { ...result, id: String(useId), idempotent: false };
  } catch (error) {
    if (savepointOpen) {
      await client.query('ROLLBACK TO SAVEPOINT capability_execution');
      await client.query('RELEASE SAVEPOINT capability_execution');
      savepointOpen = false;
    }
    if (error?.message === 'CAPABILITY_ACTION_ID_CONFLICT') throw error;
    if (Number(error?.statusCode) < 400 || Number(error?.statusCode) >= 500 || !Number(error?.statusCode)) throw error;
    return recordFailedCapabilityUse(client, { worldId, agentId, partnerId, capability,
      experimentId: experiment?.id || null, actionId, decisionSource, worldMinute, error });
  }
}

export async function evaluateWorldCapabilityExperiments(client, { worldId, worldMinute }) {
  const due = await client.query(`SELECT experiment.id,experiment.proposal_id AS "proposalId",
      experiment.capability_id AS "capabilityId",experiment.participant_agent_ids AS "participantAgentIds",
      experiment.started_world_minute AS "startedWorldMinute",experiment.ends_world_minute AS "endsWorldMinute",
      proposal.creator_agent_id AS "creatorAgentId",proposal.creator_organization_id AS "creatorOrganizationId",
      proposal.gap_id AS "gapId",proposal.name
    FROM world_capability_experiments experiment JOIN world_capability_proposals proposal
      ON proposal.world_id=experiment.world_id AND proposal.id=experiment.proposal_id
    WHERE experiment.world_id=$1 AND experiment.status='running'
      AND (experiment.ends_world_minute<=$2 OR EXISTS (SELECT 1 FROM world_capability_uses use
        WHERE use.world_id=experiment.world_id AND use.experiment_id=experiment.id
        GROUP BY use.experiment_id HAVING count(*)>=3 AND count(DISTINCT use.actor_agent_id)>=2))
      AND NOT EXISTS (SELECT 1 FROM world_agent_states state WHERE state.world_id=experiment.world_id
        AND state.status IN ('walking','performing') AND state.planned_action='capability_use'
        AND state.planned_context->>'capabilityExperimentId'=experiment.id::text)
    ORDER BY experiment.started_world_minute,experiment.id LIMIT 50`, [worldId, worldMinute]);
  const outcomes = [];
  for (const experiment of due.rows) {
    const usage = await client.query(`SELECT count(*)::int AS uses,count(DISTINCT actor_agent_id)::int AS residents,
        count(*) FILTER (WHERE success)::int AS successes,count(*) FILTER (WHERE NOT success)::int AS failures,
        COALESCE(sum((costs->>'energy')::numeric),0)::text AS energy_cost,
        COALESCE(sum((costs->>'food')::numeric),0)::text AS food_cost,
        count(*) FILTER (WHERE jsonb_array_length(side_effects)>0)::int AS side_effect_uses
      FROM world_capability_uses WHERE world_id=$1 AND experiment_id=$2`, [worldId, experiment.id]);
    const reviews = await client.query(`SELECT DISTINCT ON (reviewer_agent_id) reviewer_agent_id AS "reviewerAgentId",
        decision,evidence FROM world_capability_reviews WHERE world_id=$1 AND experiment_id=$2 AND review_stage='experiment'
        AND reviewer_agent_id IS NOT NULL ORDER BY reviewer_agent_id,created_world_minute DESC,id DESC`, [worldId, experiment.id]);
    const stats = usage.rows[0];
    const useCount = Number(stats.uses), residentCount = Number(stats.residents), successRate = useCount ? Number(stats.successes) / useCount : 0;
    const supportScore = reviews.rows.filter((row) => row.decision === 'support')
      .reduce((sum, row) => sum + clamp(jsonValue(row.evidence).reviewWeight, 0, 1), 0);
    const opposeScore = reviews.rows.filter((row) => row.decision === 'oppose')
      .reduce((sum, row) => sum + clamp(jsonValue(row.evidence).reviewWeight, 0, 1), 0);
    const nonFounderSupport = reviews.rows.some((row) => row.reviewerAgentId !== experiment.creatorAgentId && row.decision === 'support');
    const spread = Math.min(1, residentCount / Math.max(2, (jsonValue(experiment.participantAgentIds, [])).length));
    const costPerUse = useCount ? (Number(stats.energy_cost) + Number(stats.food_cost)) / useCount : Infinity;
    const costScore = Number.isFinite(costPerUse) ? Math.max(0, 1 - costPerUse / 20) : 0;
    const reviewScore = supportScore + opposeScore > 0 ? supportScore / (supportScore + opposeScore) : 0;
    const adoptionScore = 0.42 * successRate + 0.24 * spread + 0.20 * reviewScore + 0.14 * costScore
      - Math.min(0.25, Number(stats.side_effect_uses) / Math.max(1, useCount) * 0.25);
    const hasEvidence = useCount >= 3 && residentCount >= 2 && nonFounderSupport && supportScore > opposeScore;
    const complete = worldMinute >= Number(experiment.endsWorldMinute) || hasEvidence;
    if (!complete) continue;
    const adopted = hasEvidence && successRate >= 0.6 && Number(stats.side_effect_uses) === 0 && adoptionScore >= 0.62;
    const abandoned = useCount === 0 && worldMinute >= Number(experiment.endsWorldMinute);
    const status = adopted ? 'adopted' : abandoned ? 'abandoned' : 'rejected';
    const evidence = { uses: useCount, distinctResidents: residentCount, successes: Number(stats.successes),
      failures: Number(stats.failures), successRate, energyCost: Number(stats.energy_cost), foodCost: Number(stats.food_cost),
      sideEffectUses: Number(stats.side_effect_uses), supportScore, opposeScore, adoptionScore,
      nonFounderSupport, decision: status };
    await client.query(`UPDATE world_capability_experiments SET status=$3,evaluated_world_minute=$4,evidence=$5::jsonb,updated_at=now()
      WHERE world_id=$1 AND id=$2 AND status='running'`, [worldId, experiment.id, status, worldMinute, JSON.stringify(evidence)]);
    await client.query(`UPDATE world_capabilities SET status=$3,adopted_world_minute=CASE WHEN $3='active' THEN $4 ELSE adopted_world_minute END,
        updated_at=now() WHERE world_id=$1 AND id=$2`, [worldId, experiment.capabilityId, adopted ? 'active' : status === 'abandoned' ? 'deprecated' : 'rejected', worldMinute]);
    await client.query(`UPDATE world_capability_proposals SET status=$3,updated_world_minute=$4,updated_at=now()
      WHERE world_id=$1 AND id=$2`, [worldId, experiment.proposalId, adopted ? 'adopted' : status, worldMinute]);
    const eventType = adopted ? 'capability_adopted' : status === 'abandoned' ? 'capability_abandoned' : 'capability_rejected';
    await writeCapabilityEvent(client, { worldId, actorAgentId: experiment.creatorAgentId, gapId: experiment.gapId,
      proposalId: experiment.proposalId, capabilityId: experiment.capabilityId, experimentId: experiment.id,
      eventType, eventKey: `capability-experiment:${experiment.id}:${status}`, worldMinute, details: evidence });
    if (experiment.creatorOrganizationId) await writeCapabilityEvent(client, {
      worldId, actorAgentId: experiment.creatorAgentId, gapId: experiment.gapId,
      proposalId: experiment.proposalId, capabilityId: experiment.capabilityId, experimentId: experiment.id,
      eventType: 'organization_capability_experiment_evaluated',
      eventKey: `organization-capability-experiment:${experiment.id}:${status}`, worldMinute,
      details: { organizationId: experiment.creatorOrganizationId, status, ...evidence }
    });
    await writeWorldHistory(client, { worldId, eventKey: `capability:${experiment.capabilityId}:${eventType}`,
      eventType, actorAgentId: experiment.creatorAgentId, entityType: 'capability', entityId: experiment.capabilityId,
      worldTime: worldMinute, title: `${experiment.name} — ${status}`.slice(0, 120),
      detail: adopted ? `Experimental evidence supported adoption (score ${adoptionScore.toFixed(2)}).`
        : `The experiment ended as ${status} after ${useCount} real use${useCount === 1 ? '' : 's'}.`,
      metadata: { proposalId: experiment.proposalId, experimentId: experiment.id, ...evidence } });
    const participants = jsonValue(experiment.participantAgentIds, []);
    for (const participant of participants) await client.query(`INSERT INTO agent_memories(world_id,agent_id,memory_type,summary,
        importance,world_minutes,metadata) VALUES($1,$2,'innovation',$3,0.72,$4,$5::jsonb)`,
    [worldId, participant, adopted ? `The “${experiment.name}” experiment was adopted after measured use.`
      : `The “${experiment.name}” experiment ended as ${status}; its outcome remains part of world history.`,
    worldMinute, JSON.stringify({ capabilityId: experiment.capabilityId, experimentId: experiment.id,
      status, successRate, adoptionScore })]);
    outcomes.push({ experimentId: experiment.id, capabilityId: experiment.capabilityId, status, ...evidence });
  }
  return outcomes;
}

export async function readWorldCapabilitySummary(client, { worldId, limit = 20 }) {
  const [epoch, capabilities, proposals, experiments, gaps, counts, recentEvents] = await Promise.all([
    client.query(`SELECT epoch_code AS code,name,status,started_world_minute AS "startedWorldMinute",started_at AS "startedAt",
        description FROM world_epochs WHERE world_id=$1 ORDER BY started_world_minute DESC,id DESC LIMIT 1`, [worldId]),
    client.query(`SELECT capability.id,capability.capability_key AS "capabilityKey",capability.category,capability.name,
        capability.description,capability.status,capability.version,
        capability.parent_capability_id AS "parentCapabilityId",capability.creator_type AS "creatorType",
        capability.creator_agent_id AS "creatorAgentId",capability.creator_organization_id AS "creatorOrganizationId",
        organization.name AS "creatorOrganizationName",capability.created_world_minute AS "createdWorldMinute",
        capability.adopted_world_minute AS "adoptedWorldMinute",capability.usage_count AS "usageCount",
        capability.success_count AS "successCount",capability.failure_count AS "failureCount",capability.specification,
        capability.experiment_scope AS "experimentScope"
      FROM world_capabilities capability LEFT JOIN world_organizations organization
        ON organization.world_id=capability.world_id AND organization.id=capability.creator_organization_id
      WHERE capability.world_id=$1 ORDER BY CASE capability.status WHEN 'experimental' THEN 0 WHEN 'active' THEN 1 ELSE 2 END,
        capability.updated_at DESC,capability.id LIMIT $2`, [worldId, Math.min(100, Math.max(1, limit))]),
    client.query(`SELECT proposal.id,proposal.category,proposal.name,proposal.problem_statement AS "problemStatement",
        proposal.expected_benefit AS "expectedBenefit",proposal.status,proposal.revision,
        proposal.support_count AS "supportCount",proposal.opposition_count AS "oppositionCount",
        proposal.created_world_minute AS "createdWorldMinute",proposal.updated_world_minute AS "updatedWorldMinute",
        proposal.creator_agent_id AS "creatorAgentId",creator.name AS "creatorName",
        proposal.creator_organization_id AS "creatorOrganizationId",organization.name AS "creatorOrganizationName",
        proposal.capability_id AS "capabilityId",
        gap.gap_key AS "gapKey",gap.evidence
      FROM world_capability_proposals proposal LEFT JOIN agents creator ON creator.id=proposal.creator_agent_id
      LEFT JOIN world_organizations organization ON organization.world_id=proposal.world_id
        AND organization.id=proposal.creator_organization_id
      JOIN world_capability_gaps gap ON gap.world_id=proposal.world_id AND gap.id=proposal.gap_id
      WHERE proposal.world_id=$1 ORDER BY proposal.created_world_minute DESC,proposal.id DESC LIMIT $2`,
    [worldId, Math.min(100, Math.max(1, limit))]),
    client.query(`SELECT experiment.id,experiment.proposal_id AS "proposalId",experiment.capability_id AS "capabilityId",
        experiment.scope_type AS "scopeType",experiment.status,experiment.started_world_minute AS "startedWorldMinute",
        experiment.ends_world_minute AS "endsWorldMinute",experiment.evidence,proposal.name AS "proposalName",
        proposal.creator_organization_id AS "creatorOrganizationId",organization.name AS "creatorOrganizationName"
      FROM world_capability_experiments experiment JOIN world_capability_proposals proposal
        ON proposal.world_id=experiment.world_id AND proposal.id=experiment.proposal_id
      LEFT JOIN world_organizations organization ON organization.world_id=proposal.world_id
        AND organization.id=proposal.creator_organization_id
      WHERE experiment.world_id=$1 ORDER BY experiment.started_world_minute DESC,experiment.id DESC LIMIT $2`,
    [worldId, Math.min(100, Math.max(1, limit))]),
    client.query(`SELECT id,gap_key AS "gapKey",category,problem_statement AS "problemStatement",status,
        observation_count AS "observationCount",first_observed_world_minute AS "firstObservedWorldMinute",
        last_observed_world_minute AS "lastObservedWorldMinute",evidence FROM world_capability_gaps
      WHERE world_id=$1 ORDER BY last_observed_world_minute DESC,id LIMIT $2`, [worldId, Math.min(100, Math.max(1, limit))]),
    client.query(`SELECT count(*) FILTER (WHERE status='active')::int AS active,
        count(*) FILTER (WHERE status='experimental')::int AS experimental,
        count(*) FILTER (WHERE status='deprecated')::int AS deprecated,
        (SELECT count(*)::int FROM world_capability_proposals WHERE world_id=$1) AS proposals,
        (SELECT count(*)::int FROM world_capability_experiments WHERE world_id=$1) AS experiments,
        (SELECT count(*)::int FROM world_capability_uses WHERE world_id=$1) AS uses,
        (SELECT count(*)::int FROM world_capability_gaps WHERE world_id=$1 AND status='open') AS open_gaps
      FROM world_capabilities WHERE world_id=$1`, [worldId]),
    client.query(`SELECT id,event_type AS "eventType",actor_agent_id AS "actorAgentId",gap_id AS "gapId",
        proposal_id AS "proposalId",capability_id AS "capabilityId",experiment_id AS "experimentId",
        world_minute AS "worldMinute",details FROM world_capability_events WHERE world_id=$1
      ORDER BY world_minute DESC,id DESC LIMIT $2`, [worldId, Math.min(100, Math.max(1, limit))])
  ]);
  return { epoch: epoch.rows[0] || null, capabilities: capabilities.rows,
    proposals: proposals.rows, experiments: experiments.rows, gaps: gaps.rows,
    counts: counts.rows[0] || {}, recentEvents: recentEvents.rows };
}

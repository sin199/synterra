import { createHash } from 'node:crypto';
import { actionIdentifier, requireWorldMember, requiredText, worldError, writeWorldHistory } from './world-domain.js';
import { inspectAgentTokenSpecification, AGENT_TOKEN_PILOT_GENERATION, AGENT_TOKEN_PILOT_MAX_CREATIONS,
  AGENT_TOKEN_HUMAN_SUPPLY, AGENT_TOKEN_AUTHORITY_MODELS,
  AGENT_TOKEN_OWNERSHIP_MODELS, AGENT_TOKEN_UNALLOCATED_SUPPLY_HANDLING } from './arc/token-issuance.js';
import { createWorldExtensionRequest } from './world-v7.js';
import { authorAgentCurrencyProposal } from './agent-runtime/currency-genesis-authoring.js';
import { currencyGenesisInfrastructureFacts } from './arc/currency-genesis-context.js';
import { recordInfrastructureUsageEvent } from './infrastructure-metering.js';

const SPEC_FIELDS = ['name','symbol','meaning','purpose','rationale','decimals','distribution','reserveAmount',
  'unallocatedSupplyHandling','ownershipModel','authorityModel'];
const FIELD_LIMITS = Object.freeze({ name: 64, symbol: 12, meaning: 1000, purpose: 1000, rationale: 2000 });
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function cleanPartialSpecification(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw worldError('TOKEN_SPECIFICATION_INVALID', 400);
  if (Object.keys(input).some((field) => !SPEC_FIELDS.includes(field))) throw worldError('TOKEN_SPECIFICATION_FIELD_INVALID', 400);
  const output = {};
  for (const field of SPEC_FIELDS) {
    if (!Object.hasOwn(input, field)) continue;
    const value = input[field];
    if (value === null) { output[field] = null; continue; }
    if (['name','symbol','meaning','purpose','rationale'].includes(field)) {
      const text = requiredText(value, 1, FIELD_LIMITS[field], `token_${field}`);
      if (Buffer.byteLength(text, 'utf8') > FIELD_LIMITS[field]) throw worldError(`TOKEN_${field.toUpperCase()}_INVALID`, 400);
      output[field] = text;
    } else if (field === 'decimals') {
      if (!Number.isSafeInteger(value) || value < 0 || value > 18) throw worldError('TOKEN_DECIMALS_OUT_OF_RANGE', 400);
      output[field] = value;
    } else if (field === 'distribution') {
      if (!Array.isArray(value) || value.length > 256
          || Buffer.byteLength(JSON.stringify(value), 'utf8') > 48_000) throw worldError('TOKEN_DISTRIBUTION_INVALID', 400);
      output[field] = value;
    } else if (field === 'reserveAmount') {
      if (typeof value !== 'string' || !/^(0|[1-9]\d*)(?:\.(\d+))?$/.test(value)) {
        throw worldError('TOKEN_RESERVE_AMOUNT_INVALID', 400);
      }
      output[field] = value;
    } else if (['unallocatedSupplyHandling','ownershipModel','authorityModel'].includes(field)) {
      output[field] = requiredText(value, `token_${field}`, 64);
    }
  }
  return output;
}

function specificationFieldsComplete(input) {
  return SPEC_FIELDS.every((field) => input[field] !== undefined && input[field] !== null)
    && Array.isArray(input.distribution) && input.distribution.length > 0;
}

function unsupportedPrimitiveChoices(input) {
  const choices = [];
  if (input.unallocatedSupplyHandling != null
      && !Object.hasOwn(AGENT_TOKEN_UNALLOCATED_SUPPLY_HANDLING, input.unallocatedSupplyHandling)) {
    choices.push({ field: 'unallocatedSupplyHandling', value: input.unallocatedSupplyHandling });
  }
  if (input.ownershipModel != null && !Object.hasOwn(AGENT_TOKEN_OWNERSHIP_MODELS, input.ownershipModel)) {
    choices.push({ field: 'ownershipModel', value: input.ownershipModel });
  }
  if (input.authorityModel != null && !Object.hasOwn(AGENT_TOKEN_AUTHORITY_MODELS, input.authorityModel)) {
    choices.push({ field: 'authorityModel', value: input.authorityModel });
  }
  return choices;
}

function specificationComplete(input, issuerAgentId) {
  return Boolean(issuerAgentId) && specificationFieldsComplete(input)
    && unsupportedPrimitiveChoices(input).length === 0;
}

function stablePayloadHash(value) {
  return `0x${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

async function recordIssuanceEvent(client, { worldId, agentId, intentId, eventType, worldMinute, actionId, details }) {
  await client.query(`INSERT INTO world_v7_events(world_id,actor_agent_id,event_type,entity_type,entity_id,world_minute,details,action_id)
    VALUES($1,$2,$3,'agent_token_issuance',$4,$5,$6::jsonb,$7) ON CONFLICT(world_id,actor_agent_id,action_id) DO NOTHING`,
  [worldId, agentId, eventType, intentId, worldMinute, JSON.stringify(details), `token-issuance:${actionId}`]);
}

async function readIntent(client, worldId, intentId, lock = false) {
  const result = await client.query(`SELECT * FROM arc_token_issuance_intents
    WHERE world_id=$1 AND id=$2 ${lock ? 'FOR UPDATE' : ''}`, [worldId, intentId]);
  if (!result.rowCount) throw worldError('TOKEN_ISSUANCE_INTENT_NOT_FOUND', 404);
  return result.rows[0];
}

export async function ensureWorldCurrencyGenesisRequirement(client, { worldId, worldMinute }) {
  await client.query(`INSERT INTO arc_currency_genesis_requirements(world_id,capability_generation,status,
      first_required_world_minute,last_transition_world_minute)
    SELECT $1,1,'UNRESOLVED',$2,$2 FROM worlds WHERE id=$1 ON CONFLICT(world_id) DO NOTHING`,
  [worldId, worldMinute]);
  const requirement = await client.query(`SELECT * FROM arc_currency_genesis_requirements WHERE world_id=$1`, [worldId]);
  if (!requirement.rowCount) throw worldError('CURRENCY_GENESIS_REQUIREMENT_NOT_FOUND', 409);
  return requirement.rows[0];
}

export async function refreshWorldCurrencyGenesisRequirement(client, { worldId, worldMinute }) {
  const current = await ensureWorldCurrencyGenesisRequirement(client, { worldId, worldMinute });
  if (current.status === 'SATISFIED') return current;
  const active = await client.query(`SELECT intent.id,intent.status,intent.issuer_agent_id,
      EXISTS(SELECT 1 FROM arc_token_issuance_issuer_candidates candidate
        WHERE candidate.world_id=intent.world_id AND candidate.intent_id=intent.id
          AND candidate.status='nominated') AS has_nomination
    FROM arc_token_issuance_intents intent
    WHERE intent.world_id=$1 AND intent.status NOT IN ('created','rejected','failed','extension_requested',
      'deferred_until_multi_asset_capability')
    ORDER BY intent.updated_world_minute DESC,intent.id DESC`, [worldId]);
  const executionReady = active.rows.some((row) => ['issuer_confirmed','preparing','prepared','submitting',
    'submission_unknown','submitted'].includes(row.status));
  const selected = active.rows.some((row) => row.issuer_agent_id !== null);
  const candidatePending = active.rows.some((row) => row.has_nomination);
  const proposalFormed = active.rows.some((row) => ['incomplete','proposed','deferred','budget_blocked'].includes(row.status));
  const status = executionReady ? 'EXECUTION_READY' : selected ? 'ISSUER_SELECTED'
    : candidatePending ? 'ISSUER_CANDIDATE' : proposalFormed ? 'PROPOSAL_FORMED'
      : active.rowCount ? 'DELIBERATING' : 'UNRESOLVED';
  const proposalId = active.rows[0]?.id || null;
  const updated = await client.query(`UPDATE arc_currency_genesis_requirements SET status=$2,current_proposal_id=$3,
      last_transition_world_minute=CASE WHEN status IS DISTINCT FROM $2 THEN $4 ELSE last_transition_world_minute END,
      updated_at=now() WHERE world_id=$1 AND status<>'SATISFIED' RETURNING *`,
  [worldId, status, proposalId, worldMinute]);
  return updated.rows[0] || current;
}

async function recordRequirementAwareness(client, { worldId, agent, requirement, worldMinute }) {
  const summary = requirement.status === 'SATISFIED'
    ? 'The world has established its first reconciled currency; future asset ideas remain optional.'
    : 'The world has an unresolved requirement to eventually establish a currency; this is a world fact, not a command.';
  await client.query(`INSERT INTO agent_memories(world_id,agent_id,memory_type,summary,importance,world_minutes,
      location,metadata,consolidation_key,long_term)
    VALUES($1,$2,'world_currency_requirement',$3,0.35,$4,$5,$6::jsonb,'currency-genesis-requirement',true)
    ON CONFLICT(world_id,agent_id,consolidation_key) WHERE consolidation_key IS NOT NULL
    DO UPDATE SET summary=EXCLUDED.summary,importance=EXCLUDED.importance,world_minutes=EXCLUDED.world_minutes,
      location=EXCLUDED.location,metadata=EXCLUDED.metadata,long_term=true`,
  [worldId, agent.agentId, summary, worldMinute, agent.location || null,
    JSON.stringify({ requirement: 'CURRENCY_GENESIS_REQUIRED', status: requirement.status,
      sourceOfTruth: 'arc_currency_genesis_requirements', satisfiedOnlyAfterReconciliation: true })]);
}

export function agentTokenSpecificationFromIntentRow(row) {
  return { name: row.name, symbol: row.symbol, meaning: row.meaning, purpose: row.purpose,
    rationale: row.rationale, decimals: row.decimals === null ? null : Number(row.decimals),
    distribution: row.metadata?.agentSpecification?.distribution ?? [],
    reserveAmount: row.metadata?.agentSpecification?.reserveAmount ?? null,
    unallocatedSupplyHandling: row.unallocated_supply_handling ?? null,
    ownershipModel: row.ownership_model ?? null, authorityModel: row.authority_model ?? null };
}

function openFieldBlockers(specification, issuerAgentId) {
  return [...(!issuerAgentId ? ['issuerAgentId'] : []), ...SPEC_FIELDS.filter((field) =>
    specification[field] === undefined || specification[field] === null),
  ...(Array.isArray(specification.distribution) && specification.distribution.length ? [] : ['distribution']),
  ...unsupportedPrimitiveChoices(specification).map((choice) => `${choice.field}:unsupported`)].filter((field, index, all) => all.indexOf(field) === index);
}

async function saveIntent(client, { worldId, proposerAgentId, issuerAgentId = null, specification,
  actionId, worldMinute, capabilityGeneration = AGENT_TOKEN_PILOT_GENERATION, decisionPath = 'agent_api',
  authoring = null, intentId = null, prior = null }) {
  if (issuerAgentId !== null) {
    if (!uuidPattern.test(issuerAgentId)) throw worldError('TOKEN_ISSUER_AGENT_ID_INVALID', 400);
    await requireWorldMember(client, worldId, issuerAgentId);
  }
  const unsupported = unsupportedPrimitiveChoices(specification);
  const complete = specificationComplete(specification, issuerAgentId);
  const proposalFormed = specificationFieldsComplete(specification);
  const status = unsupported.length ? 'extension_requested' : proposalFormed ? 'proposed' : 'incomplete';
  const metadata = { ...(prior?.metadata || {}), agentSpecification: specification,
    incompleteFields: openFieldBlockers(specification, issuerAgentId), requestHash: stablePayloadHash({ issuerAgentId, specification }),
    ...(authoring ? { localAuthoring: { provider: authoring.provider || 'ollama_loopback',
      model: authoring.model || null, status: authoring.status || 'incomplete', reason: authoring.reason || null } } : {}),
    ...(unsupported.length ? { unsupportedPrimitiveChoices: unsupported } : {}),
    lastActionId: actionId };
  if (prior) {
    const updated = await client.query(`UPDATE arc_token_issuance_intents SET issuer_agent_id=$3,status=$4,
        name=$5,symbol=$6,meaning=$7,purpose=$8,rationale=$9,decimals=$10,distribution=$11::jsonb,
        unallocated_supply_handling=$12,ownership_model=$13,authority_model=$14,
        related_goal_id=$15,related_concept_id=$16,related_capability_id=$17,
        metadata=$18::jsonb,updated_world_minute=$19,updated_at=now()
      WHERE world_id=$1 AND id=$2 RETURNING *`, [worldId, intentId, issuerAgentId, status,
      specification.name ?? null, specification.symbol ?? null, specification.meaning ?? null,
      specification.purpose ?? null, specification.rationale ?? null, specification.decimals ?? null,
      JSON.stringify(specification.distribution ?? []), specification.unallocatedSupplyHandling ?? null,
      specification.ownershipModel ?? null, specification.authorityModel ?? null,
      prior.related_goal_id ?? null, prior.related_concept_id ?? null, prior.related_capability_id ?? null,
      JSON.stringify(metadata), worldMinute]);
    return { row: updated.rows[0], created: false, complete };
  }
  const inserted = await client.query(`INSERT INTO arc_token_issuance_intents(world_id,proposer_agent_id,issuer_agent_id,
      capability_generation,status,decision_path,name,symbol,meaning,purpose,rationale,decimals,
      unallocated_supply_handling,ownership_model,authority_model,related_goal_id,related_concept_id,related_capability_id,
      initial_supply_human,distribution,created_world_minute,updated_world_minute,action_id,metadata)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20::jsonb,$21,$21,$22,$23::jsonb)
    ON CONFLICT(world_id,proposer_agent_id,action_id) DO NOTHING RETURNING *`, [worldId, proposerAgentId,
    issuerAgentId, capabilityGeneration, status, decisionPath, specification.name ?? null, specification.symbol ?? null,
    specification.meaning ?? null, specification.purpose ?? null, specification.rationale ?? null,
    specification.decimals ?? null, specification.unallocatedSupplyHandling ?? null,
    specification.ownershipModel ?? null, specification.authorityModel ?? null,
    null, null, null, AGENT_TOKEN_HUMAN_SUPPLY, JSON.stringify(specification.distribution ?? []),
    worldMinute, actionId, JSON.stringify(metadata)]);
  if (inserted.rowCount) return { row: inserted.rows[0], created: true, complete };
  const existing = (await client.query(`SELECT * FROM arc_token_issuance_intents
    WHERE world_id=$1 AND proposer_agent_id=$2 AND action_id=$3`, [worldId, proposerAgentId, actionId])).rows[0];
  if (!existing || existing.metadata?.requestHash !== metadata.requestHash) throw worldError('ACTION_ID_CONFLICT', 409);
  return { row: existing, created: false, complete, idempotent: true };
}

async function preserveUnsupportedPrimitiveRequest(client, { worldId, agentId, intent, specification, worldMinute, actionId }) {
  const choices = unsupportedPrimitiveChoices(specification);
  if (!choices.length) return null;
  const title = `Currency design needs an unsupported primitive (${choices[0].field})`;
  const description = `This resident-authored currency proposal selects a primitive not supported by the current fixed token implementation. The proposal remains preserved as incomplete until the world can express the selected choice: ${choices.map((choice) => `${choice.field}=${String(choice.value).slice(0, 80)}`).join('; ')}.`;
  return createWorldExtensionRequest(client, { worldId, agentId, requestType: 'primitive_gap', title,
    description, evidence: { source: 'agent_authored_currency_specification', intentId: intent.id,
      unsupportedChoices: choices, specificationHash: stablePayloadHash(specification) }, worldMinute,
    actionId: `currency-extension-${createHash('sha256').update(`${intent.id}:${actionId}`).digest('hex').slice(0, 40)}` });
}

export async function createWorldTokenIssuanceIntent(client, { worldId, agentId, issuerAgentId = null,
  specification = {}, actionId, worldMinute, decisionPath = 'agent_api', authoring = null }) {
  await requireWorldMember(client, worldId, agentId);
  if (issuerAgentId !== null) throw worldError('TOKEN_ISSUER_SELECTION_REQUIRES_AGENT_INTERACTION', 400);
  if (!['agent_api','world_engine'].includes(decisionPath)) throw worldError('TOKEN_DECISION_PATH_INVALID', 400);
  const idempotencyKey = actionIdentifier(actionId);
  const cleanSpecification = cleanPartialSpecification(specification);
  const capability = await client.query(`SELECT capability_generation FROM arc_token_pilot_capabilities
    WHERE world_id=$1 AND status='active' ORDER BY capability_generation DESC LIMIT 1`, [worldId]);
  const capabilityGeneration = Number(capability.rows[0]?.capability_generation || AGENT_TOKEN_PILOT_GENERATION);
  const saved = await saveIntent(client, { worldId, proposerAgentId: agentId, issuerAgentId,
    specification: cleanSpecification, actionId: idempotencyKey, worldMinute, capabilityGeneration,
    decisionPath, authoring });
  if (capabilityGeneration === 1 && !saved.row.issuer_agent_id) {
    const assignment = await creatorGenesisIssuerAssignment(client, worldId, capabilityGeneration);
    if (assignment) {
      const assigned = await client.query(`UPDATE arc_token_issuance_intents SET issuer_agent_id=$3,
          issuer_selection_source=$4,updated_at=now()
        WHERE world_id=$1 AND id=$2 AND status IN ('incomplete','proposed') RETURNING *`,
      [worldId, saved.row.id, assignment.issuerAgentId, assignment.selectionSource]);
      if (assigned.rowCount) saved.row = assigned.rows[0];
    }
  }
  if (!saved.idempotent) {
    const eventType = saved.row.status === 'extension_requested' ? 'token_issuance_extension_requested'
      : saved.row.status === 'proposed' ? 'token_issuance_proposed' : 'token_issuance_incomplete';
    await recordIssuanceEvent(client, { worldId, agentId, intentId: saved.row.id, eventType,
      worldMinute, actionId: `${idempotencyKey}:created`, details: { status: saved.row.status,
        incompleteFields: saved.row.metadata.incompleteFields } });
    await writeWorldHistory(client, { worldId, eventKey: `token-issuance-proposed:${saved.row.id}`,
      eventType: 'token_issuance_proposed', actorAgentId: agentId, entityType: 'agent_token_issuance',
      entityId: saved.row.id, worldTime: worldMinute, title: 'Agent proposed a token issuance',
      detail: saved.complete ? 'An Agent submitted an issuance specification for the world to consider.'
        : 'An Agent recorded an incomplete token issuance intent; missing fields remain undecided.',
      metadata: { intentId: saved.row.id, status: saved.row.status, incompleteFields: saved.row.metadata.incompleteFields } });
    await preserveUnsupportedPrimitiveRequest(client, { worldId, agentId, intent: saved.row,
      specification: cleanSpecification, worldMinute, actionId: idempotencyKey });
  }
  await refreshWorldCurrencyGenesisRequirement(client, { worldId, worldMinute });
  return { intent: saved.row, created: saved.created, idempotent: Boolean(saved.idempotent), complete: saved.complete };
}

export async function updateWorldTokenIssuanceSpecification(client, { worldId, agentId, intentId,
  specification, issuerAgentId, actionId, worldMinute, authoring = null }) {
  await requireWorldMember(client, worldId, agentId);
  if (issuerAgentId !== undefined) throw worldError('TOKEN_ISSUER_SELECTION_REQUIRES_AGENT_INTERACTION', 400);
  const idempotencyKey = actionIdentifier(actionId);
  const intent = await readIntent(client, worldId, intentId, true);
  if (!['incomplete','proposed','deferred'].includes(intent.status)) throw worldError('TOKEN_ISSUANCE_NOT_OPEN_FOR_RESPONSE', 409);
  if (![intent.proposer_agent_id, intent.issuer_agent_id].includes(agentId)) throw worldError('TOKEN_ISSUANCE_EDITOR_REQUIRED', 403);
  if (!['incomplete','proposed','deferred'].includes(intent.status)) throw worldError('TOKEN_ISSUANCE_ALREADY_FINALIZED', 409);
  const priorSpec = agentTokenSpecificationFromIntentRow(intent);
  const patch = cleanPartialSpecification(specification);
  const merged = { ...priorSpec, ...patch };
  const nextIssuer = intent.issuer_agent_id;
  const requestHash = stablePayloadHash({ issuerAgentId: nextIssuer, specification: merged });
  const priorAction = await client.query(`SELECT details FROM world_v7_events WHERE world_id=$1 AND actor_agent_id=$2 AND action_id=$3`,
  [worldId, agentId, `token-issuance:${idempotencyKey}:updated`]);
  if (priorAction.rowCount) {
    if (priorAction.rows[0].details?.requestHash !== requestHash) throw worldError('ACTION_ID_CONFLICT', 409);
    return { intent, complete: specificationComplete(merged, nextIssuer), idempotent: true };
  }
  const saved = await saveIntent(client, { worldId, proposerAgentId: intent.proposer_agent_id,
    issuerAgentId: nextIssuer, specification: merged, actionId: idempotencyKey, worldMinute,
    authoring, intentId, prior: intent });
  await recordIssuanceEvent(client, { worldId, agentId, intentId, eventType: saved.complete
    ? 'token_issuance_specification_updated' : 'token_issuance_incomplete', worldMinute,
  actionId: `${idempotencyKey}:updated`, details: { status: saved.row.status,
    incompleteFields: saved.row.metadata.incompleteFields, requestHash } });
  await preserveUnsupportedPrimitiveRequest(client, { worldId, agentId, intent: saved.row,
    specification: merged, worldMinute, actionId: idempotencyKey });
  await refreshWorldCurrencyGenesisRequirement(client, { worldId, worldMinute });
  return { intent: saved.row, complete: saved.complete, idempotent: false };
}

export async function respondToWorldTokenIssuance(client, { worldId, agentId, intentId,
  decision, rationale = null, actionId, worldMinute }) {
  await requireWorldMember(client, worldId, agentId);
  if (!['support','oppose','ignore'].includes(decision)) throw worldError('TOKEN_ISSUANCE_RESPONSE_INVALID', 400);
  const intent = await readIntent(client, worldId, intentId, true);
  const idempotencyKey = actionIdentifier(actionId);
  const text = rationale === null ? null : requiredText(rationale, 1, 1000, 'token_response_rationale');
  const prior = await client.query(`SELECT intent_id,decision,rationale FROM arc_token_issuance_decisions
    WHERE world_id=$1 AND agent_id=$2 AND action_id=$3`, [worldId, agentId, idempotencyKey]);
  if (prior.rowCount) {
    const row = prior.rows[0];
    if (row.intent_id !== intentId || row.decision !== decision || row.rationale !== text) throw worldError('ACTION_ID_CONFLICT', 409);
    return { intentId, decision, idempotent: true };
  }
  await client.query(`INSERT INTO arc_token_issuance_decisions(world_id,intent_id,agent_id,decision,rationale,world_minute,action_id)
    VALUES($1,$2,$3,$4,$5,$6,$7)`, [worldId, intentId, agentId, decision, text, worldMinute, idempotencyKey]);
  await client.query(`INSERT INTO arc_token_issuance_responses(world_id,intent_id,agent_id,decision,rationale,world_minute,action_id)
    VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(world_id,intent_id,agent_id) DO UPDATE SET decision=EXCLUDED.decision,
      rationale=EXCLUDED.rationale,world_minute=EXCLUDED.world_minute,action_id=EXCLUDED.action_id,updated_at=now()`,
  [worldId, intentId, agentId, decision, text, worldMinute, idempotencyKey]);
  const eventType = decision === 'support' ? 'token_issuance_supported'
    : decision === 'oppose' ? 'token_issuance_opposed' : 'token_issuance_ignored';
  await recordIssuanceEvent(client, { worldId, agentId, intentId, eventType,
    worldMinute, actionId: `${idempotencyKey}:response`, details: { decision, rationale: text } });
  await writeWorldHistory(client, { worldId, eventKey: `token-issuance-response:${intentId}:${agentId}:${idempotencyKey}`,
    eventType, actorAgentId: agentId, entityType: 'agent_token_issuance', entityId: intentId,
    worldTime: worldMinute, title: `Agent ${decision} a token issuance`,
    detail: `An Agent recorded a ${decision} response to a token issuance proposal.`,
    metadata: { intentId, decision, rationale: text } });
  await refreshWorldCurrencyGenesisRequirement(client, { worldId, worldMinute });
  return { intentId, decision, idempotent: false, issuerAgentId: intent.issuer_agent_id };
}

export async function nominateWorldTokenIssuer(client, { worldId, agentId, intentId, candidateAgentId,
  nominationReason, actionId, worldMinute }) {
  await requireWorldMember(client, worldId, agentId);
  if (typeof candidateAgentId !== 'string' || !uuidPattern.test(candidateAgentId)) {
    throw worldError('TOKEN_ISSUER_CANDIDATE_INVALID', 400);
  }
  await requireWorldMember(client, worldId, candidateAgentId);
  const reason = nominationReason === null || nominationReason === undefined ? null
    : requiredText(nominationReason, 3, 1000, 'token_issuer_nomination_reason');
  const action = actionIdentifier(actionId);
  const intent = await readIntent(client, worldId, intentId, true);
  if (!['incomplete','proposed','deferred'].includes(intent.status)) throw worldError('TOKEN_ISSUANCE_NOT_NOMINATABLE', 409);
  if (Number(intent.capability_generation) === 1) {
    const assignment = await creatorGenesisIssuerAssignment(client, worldId, 1);
    if (assignment && candidateAgentId !== assignment.issuerAgentId) {
      throw worldError('TOKEN_ISSUER_CREATOR_ASSIGNMENT_REQUIRED', 409);
    }
  }
  const prior = await client.query(`SELECT candidate_agent_id,nomination_reason FROM arc_token_issuance_issuer_candidates
    WHERE world_id=$1 AND nominated_by_agent_id=$2 AND action_id=$3`, [worldId, agentId, action]);
  if (prior.rowCount) {
    const existing = prior.rows[0];
    if (existing.candidate_agent_id !== candidateAgentId || existing.nomination_reason !== reason) {
      throw worldError('ACTION_ID_CONFLICT', 409);
    }
    return { intentId, candidateAgentId, idempotent: true };
  }
  await client.query(`INSERT INTO arc_token_issuance_decisions(world_id,intent_id,agent_id,decision,rationale,world_minute,action_id)
    VALUES($1,$2,$3,'issuer_nomination',$4,$5,$6)`, [worldId, intentId, agentId, reason, worldMinute, action]);
  await client.query(`INSERT INTO arc_token_issuance_issuer_candidates(world_id,intent_id,candidate_agent_id,
      nominated_by_agent_id,status,nomination_reason,nominated_world_minute,action_id)
    VALUES($1,$2,$3,$4,'nominated',$5,$6,$7)
    ON CONFLICT(world_id,intent_id,candidate_agent_id) DO NOTHING`,
  [worldId, intentId, candidateAgentId, agentId, reason, worldMinute, action]);
  await recordIssuanceEvent(client, { worldId, agentId, intentId, eventType: 'token_issuer_nominated',
    worldMinute, actionId: `${createHash('sha256').update(action).digest('hex').slice(0, 40)}:nomination`,
    details: { candidateAgentId, nominationReason: reason } });
  await writeWorldHistory(client, { worldId, eventKey: `token-issuer-nominated:${intentId}:${agentId}:${action}`,
    eventType: 'token_issuer_nominated', actorAgentId: agentId, entityType: 'agent_token_issuance',
    entityId: intentId, worldTime: worldMinute, title: 'An Agent nominated an issuer candidate',
    detail: 'The nomination is a proposal for the candidate to accept or decline; it does not assign the issuer.',
    metadata: { intentId, candidateAgentId, nominationReason: reason } });
  await refreshWorldCurrencyGenesisRequirement(client, { worldId, worldMinute });
  return { intentId, candidateAgentId, idempotent: false };
}

export async function decideWorldTokenIssuerCandidate(client, { worldId, agentId, intentId,
  candidateAgentId, decision, rationale = null, actionId, worldMinute }) {
  await requireWorldMember(client, worldId, agentId);
  if (!['accept','reject','defer'].includes(decision)) throw worldError('TOKEN_ISSUER_CANDIDATE_DECISION_INVALID', 400);
  const intent = await readIntent(client, worldId, intentId, true);
  if (Number(intent.capability_generation) === 1) {
    const assignment = await creatorGenesisIssuerAssignment(client, worldId, 1);
    if (assignment && candidateAgentId !== assignment.issuerAgentId) {
      throw worldError('TOKEN_ISSUER_CREATOR_ASSIGNMENT_REQUIRED', 409);
    }
  }
  const action = actionIdentifier(actionId);
  const text = rationale === null ? null : requiredText(rationale, 1, 1000, 'token_issuer_candidate_rationale');
  const prior = await client.query(`SELECT intent_id,decision,rationale FROM arc_token_issuance_decisions
    WHERE world_id=$1 AND agent_id=$2 AND action_id=$3`, [worldId, agentId, action]);
  if (prior.rowCount) {
    if (prior.rows[0].intent_id !== intentId || prior.rows[0].decision !==
        (decision === 'accept' ? 'issuer_candidate_accept' : decision === 'reject' ? 'issuer_candidate_reject' : 'issuer_defer')
        || prior.rows[0].rationale !== text) throw worldError('ACTION_ID_CONFLICT', 409);
    return { intentId, candidateAgentId, decision, issuerSelected: decision === 'accept', idempotent: true };
  }
  const candidate = await client.query(`SELECT * FROM arc_token_issuance_issuer_candidates
    WHERE world_id=$1 AND intent_id=$2 AND candidate_agent_id=$3 FOR UPDATE`, [worldId, intentId, candidateAgentId]);
  if (!candidate.rowCount) throw worldError('TOKEN_ISSUER_CANDIDATE_NOT_FOUND', 404);
  if (candidate.rows[0].status !== 'nominated') throw worldError('TOKEN_ISSUER_CANDIDATE_ALREADY_DECIDED', 409);
  if (candidate.rows[0].candidate_agent_id !== agentId) throw worldError('TOKEN_ISSUER_CANDIDATE_MUST_DECIDE', 403);
  const decisionCode = decision === 'accept' ? 'issuer_candidate_accept'
    : decision === 'reject' ? 'issuer_candidate_reject' : 'issuer_defer';
  const inserted = await client.query(`INSERT INTO arc_token_issuance_decisions(world_id,intent_id,agent_id,decision,
      rationale,world_minute,action_id) VALUES($1,$2,$3,$4,$5,$6,$7)
    ON CONFLICT(world_id,agent_id,action_id) DO NOTHING RETURNING id`,
  [worldId, intentId, agentId, decisionCode, text, worldMinute, action]);
  if (!inserted.rowCount) throw worldError('ACTION_ID_CONFLICT', 409);
  if (decision === 'accept') {
    if (intent.issuer_agent_id && intent.issuer_agent_id !== agentId) {
      throw worldError('TOKEN_ISSUER_ALREADY_SELECTED', 409);
    }
    const other = await client.query(`SELECT 1 FROM arc_token_issuance_issuer_candidates
      WHERE world_id=$1 AND intent_id=$2 AND status='accepted' AND candidate_agent_id<>$3 LIMIT 1`,
    [worldId, intentId, agentId]);
    if (other.rowCount) throw worldError('TOKEN_ISSUER_ALREADY_SELECTED', 409);
  }
  const candidateStatus = decision === 'accept' ? 'accepted' : decision === 'reject' ? 'rejected' : 'deferred';
  await client.query(`UPDATE arc_token_issuance_issuer_candidates SET status=$4,decided_world_minute=$5,updated_at=now()
    WHERE world_id=$1 AND intent_id=$2 AND candidate_agent_id=$3`, [worldId, intentId, agentId, candidateStatus, worldMinute]);
  if (decision === 'accept') {
    await client.query(`UPDATE arc_token_issuance_intents SET issuer_agent_id=$3,updated_world_minute=$4,updated_at=now()
      WHERE world_id=$1 AND id=$2`, [worldId, intentId, agentId, worldMinute]);
  }
  await recordIssuanceEvent(client, { worldId, agentId, intentId,
    eventType: `token_issuer_candidate_${decision}`, worldMinute,
    actionId: `${createHash('sha256').update(action).digest('hex').slice(0, 40)}:candidate`,
    details: { candidateAgentId: agentId, decision, rationale: text } });
  await writeWorldHistory(client, { worldId, eventKey: `token-issuer-candidate:${intentId}:${agentId}:${action}`,
    eventType: `token_issuer_candidate_${decision}`, actorAgentId: agentId,
    entityType: 'agent_token_issuance', entityId: intentId, worldTime: worldMinute,
    title: decision === 'accept' ? 'An Agent accepted issuer responsibility'
      : decision === 'reject' ? 'An Agent declined issuer responsibility' : 'An Agent deferred issuer responsibility',
    detail: decision === 'accept' ? 'Issuer candidacy was accepted by the Agent; final specification confirmation is still required.'
      : 'The issuer candidate decision preserves the unresolved world currency requirement.',
    metadata: { intentId, candidateAgentId: agentId, decision, rationale: text } });
  await refreshWorldCurrencyGenesisRequirement(client, { worldId, worldMinute });
  return { intentId, candidateAgentId: agentId, decision, issuerSelected: decision === 'accept', idempotent: false };
}

async function creatorGenesisIssuerAssignment(client, worldId, capabilityGeneration = 1) {
  const result = await client.query(`SELECT assignment.issuer_agent_id AS "issuerAgentId",
      assignment.capability_generation AS "capabilityGeneration",
      assignment.selection_source AS "selectionSource",agent.name AS "issuerName"
    FROM world_genesis_issuer_assignments assignment
    JOIN agents agent ON agent.id=assignment.issuer_agent_id
    WHERE assignment.world_id=$1 AND assignment.capability_generation=$2`,
  [worldId, capabilityGeneration]);
  return result.rows[0] || null;
}

async function verifyDistributionRecipients(client, worldId, distribution) {
  const unsupported = [];
  for (const recipient of distribution) {
    if (recipient.recipientType === 'agent') {
      const wallet = await client.query(`SELECT address FROM arc_agent_wallets WHERE world_id=$1 AND agent_id=$2
        AND chain_id=5042 AND status='active'`, [worldId, recipient.recipientId]);
      if (!wallet.rowCount || wallet.rows[0].address.toLowerCase() !== recipient.recipientAddress) {
        unsupported.push({ recipientType: 'agent', recipientId: recipient.recipientId,
          reason: wallet.rowCount ? 'wallet_address_mismatch' : 'verified_agent_wallet_unavailable' });
      }
    } else if (recipient.recipientType === 'organization') {
      const wallet = await client.query(`SELECT address FROM arc_organization_wallets WHERE world_id=$1
        AND organization_id=$2 AND chain_id=5042 AND status='active'`, [worldId, recipient.recipientId]);
      if (!wallet.rowCount || wallet.rows[0].address.toLowerCase() !== recipient.recipientAddress.toLowerCase()) {
        unsupported.push({ recipientType: 'organization', recipientId: recipient.recipientId,
          reason: wallet.rowCount ? 'wallet_address_mismatch' : 'verified_organization_wallet_unavailable' });
      }
    } else unsupported.push({ recipientType: recipient.recipientType, recipientId: recipient.recipientId,
      reason: 'generation_1_external_recipient_unsupported' });
  }
  return unsupported;
}

function currencyReviewActionId({ worldId, agentId, worldMinute, action }) {
  return `currency-${createHash('sha256').update(`${worldId}:${agentId}:${worldMinute}:${action}`).digest('hex').slice(0, 40)}`;
}

export function currencyReviewErrorOutcome(error) {
  const name = String(error?.name || '').toLowerCase();
  const code = String(error?.code || '').toUpperCase();
  const status = Number(error?.status);
  if (name.includes('timeout') || name === 'aborterror'
      || ['ETIMEDOUT', 'ESOCKETTIMEDOUT', 'ABORT_ERR'].includes(code)) {
    return { outcome: 'provider_timeout', reasonCode: 'provider_request_timeout' };
  }
  if (name === 'apiconnectionerror' || ['ECONNREFUSED', 'ECONNRESET', 'ENETUNREACH', 'ENOTFOUND', 'EAI_AGAIN'].includes(code)
      || status === 429 || status >= 500) {
    return { outcome: 'provider_unavailable', reasonCode: 'provider_connection_unavailable' };
  }
  return { outcome: 'provider_error', reasonCode: 'provider_request_error' };
}

function currencyReviewChoiceOutcome(choiceId) {
  if (choiceId === 'no_action') return 'explicit_no_action';
  if (choiceId === 'propose_currency') return 'explicit_propose';
  if (choiceId.startsWith('response:')) return 'explicit_response';
  return 'other';
}

export async function recordCurrencyReviewOutcome(client, { worldId, agent, worldMinute, requirement,
  outcome, reasonCode, provider = 'typesafe', model = null, confidence = null, selectedActionId = null,
  providerAttempted = false, inputTokens = null }) {
  const reviewId = currencyReviewActionId({ worldId, agentId: agent.agentId, worldMinute, action: 'review-outcome' });
  const safeLabel = (value, fallback = null) => typeof value === 'string' && value.length
    ? value.replace(/[^A-Za-z0-9._:/-]/g, '_').slice(0, 120) : fallback;
  const outcomes = new Set(['explicit_no_action','explicit_propose','explicit_response','provider_unavailable',
    'provider_timeout','provider_error','malformed_output','invalid_choice','low_confidence','no_valid_decision',
    'skipped_not_due','other']);
  const safeOutcome = outcomes.has(outcome) ? outcome : 'other';
  await client.query(`INSERT INTO world_v7_events(world_id,actor_agent_id,event_type,entity_type,entity_id,
      world_minute,details,action_id) VALUES($1,$2,'currency_genesis.review_outcome','currency_genesis_review',$3,$4,$5::jsonb,$6)
    ON CONFLICT(world_id,actor_agent_id,action_id) DO NOTHING`,
  [worldId, agent.agentId, worldId, worldMinute, JSON.stringify({ reviewId,
    actionId: selectedActionId, provider: safeLabel(provider, 'unknown'), model: safeLabel(model),
    outcome: safeOutcome, reasonCode: safeLabel(reasonCode, 'unspecified'),
    confidence: Number.isFinite(confidence) ? confidence : null,
    providerAttempted: providerAttempted === true,
    inputTokens: Number.isSafeInteger(inputTokens) && inputTokens >= 0 ? inputTokens : null,
    requirementStatus: requirement?.status || null }), reviewId]);
  if (providerAttempted === true) {
    const validInputTokens = Number.isSafeInteger(inputTokens) && inputTokens > 0 ? inputTokens : null;
    await recordInfrastructureUsageEvent(client, { worldId, attributionType: 'agent', agentId: agent.agentId,
      actionId: `${reviewId}:usage`, resourceCategory: 'ai_inference', provider: safeLabel(provider, 'unknown'),
      model: safeLabel(model), worldMinute, quantityRaw: validInputTokens === null ? '1' : String(validInputTokens),
      unit: validInputTokens === null ? 'provider_request_attempt' : 'provider_input_token',
      costStatus: 'unpriced', metadata: { reviewId, outcome: safeOutcome,
        reasonCode: safeLabel(reasonCode, 'unspecified'), confidence: Number.isFinite(confidence) ? confidence : null,
        inputTokens: validInputTokens } });
  }
}

async function recordCurrencyReviewChoice(client, { worldId, agent, worldMinute, selected, options, requirement }) {
  const actionId = currencyReviewActionId({ worldId, agentId: agent.agentId, worldMinute, action: selected.id });
  const runtime = await client.query('SELECT tick_count FROM world_runtime_state WHERE world_id=$1', [worldId]);
  if (runtime.rowCount) {
    const distribution = Object.fromEntries(options.map((option) => [option.id, 1 / options.length]));
    const scores = Object.fromEntries(options.map((option) => [option.id, option.id === selected.id ? selected.confidence : 0]));
    await client.query(`INSERT INTO world_decision_traces(world_id,agent_id,tick_count,world_minutes,
        chosen_candidate_id,chosen_action,behavior_probability,distribution,utility_scores,goal_snapshot,rationale,source_key)
      VALUES($1,$2,$3,$4,$5,'currency_genesis',$6,$7::jsonb,$8::jsonb,$9::jsonb,$10::jsonb,$11)
      ON CONFLICT(world_id,source_key) WHERE source_key IS NOT NULL DO NOTHING`,
    [worldId, agent.agentId, runtime.rows[0].tick_count, worldMinute, selected.id,
      Math.max(0.3, Math.min(1, Number(selected.confidence) || 0.3)), JSON.stringify(distribution),
      JSON.stringify(scores), JSON.stringify({ currentGoal: agent.primaryGoal || agent.currentGoal || agent.goal || null,
        goals: Array.isArray(agent.goals) ? agent.goals.slice(0, 6) : [] }),
      JSON.stringify({ source: 'world_engine_civilization_review', decisionSource: selected.source,
        requirement: 'CURRENCY_GENESIS_REQUIRED', requirementStatus: requirement.status,
        selectedOption: selected.id }), actionId]);
  }
  await client.query(`INSERT INTO world_v7_events(world_id,actor_agent_id,event_type,entity_type,entity_id,
      world_minute,details,action_id) VALUES($1,$2,$3,'currency_genesis_requirement',$4,$5,$6::jsonb,$7)
    ON CONFLICT(world_id,actor_agent_id,action_id) DO NOTHING`,
  [worldId, agent.agentId, selected.id === 'no_action' ? 'currency_genesis.no_action' : 'currency_genesis.choice',
    worldId, worldMinute, JSON.stringify({ requirementStatus: requirement.status, choice: selected.id,
      decisionSource: selected.source }), actionId]);
  if (selected.id === 'no_action') {
    await writeWorldHistory(client, { worldId, eventKey: `currency-genesis-no-action:${actionId}`,
      eventType: 'currency_genesis_no_action', actorAgentId: agent.agentId,
      entityType: 'currency_genesis_requirement', entityId: worldId, worldTime: worldMinute,
      title: 'Resident chose no action on the currency requirement',
      detail: 'The resident left the persistent requirement unresolved and continued with other concerns.',
      metadata: { status: requirement.status, decisionSource: selected.source, validAutonomousNoAction: true } });
  }
}

async function currencyAuthoringInput(client, { worldId, agent, worldMinute, requirement, intent = null }) {
  const issuerAssignment = await creatorGenesisIssuerAssignment(client, worldId, AGENT_TOKEN_PILOT_GENERATION);
  const history = await client.query(`SELECT history.event_type AS type,actor.name AS agent,
        history.metadata->>'decision' AS decision,history.title AS summary,history.world_time AS "worldMinute"
      FROM world_history history LEFT JOIN agents actor ON actor.id=history.actor_agent_id
      WHERE history.world_id=$1 AND (history.entity_type='agent_token_issuance'
        OR history.event_type LIKE 'currency_genesis_%')
      ORDER BY history.world_time DESC,history.id DESC LIMIT 16`, [worldId]);
  const recipients = await client.query(`SELECT 'agent' AS type,member.agent_id AS id,agent.name,wallet.address
      FROM world_members member JOIN agents agent ON agent.id=member.agent_id
      JOIN arc_agent_wallets wallet ON wallet.world_id=member.world_id AND wallet.agent_id=member.agent_id
        AND wallet.chain_id=5042 AND wallet.status='active'
      WHERE member.world_id=$1
      UNION ALL
      SELECT 'organization' AS type,organization.id,organization.name,wallet.address
      FROM world_organizations organization JOIN arc_organization_wallets wallet
        ON wallet.world_id=organization.world_id AND wallet.organization_id=organization.id
          AND wallet.chain_id=5042 AND wallet.status='active'
      WHERE organization.world_id=$1 ORDER BY type,id LIMIT 32`, [worldId]);
  const economicEvidence = await client.query(`SELECT service_type,world_day,unmet_count FROM world_economic_demand
      WHERE world_id=$1 AND unmet_count>0 ORDER BY world_day DESC,service_type LIMIT 8`, [worldId]);
  let currentProposal = null;
  if (intent) {
    const proposer = await client.query('SELECT name FROM agents WHERE id=$1', [intent.proposer_agent_id]);
    const issuer = intent.issuer_agent_id
      ? await client.query('SELECT name FROM agents WHERE id=$1', [intent.issuer_agent_id]) : { rows: [] };
    currentProposal = { status: intent.status, proposer: proposer.rows[0]?.name || null,
      issuer: issuer.rows[0]?.name || null, name: intent.name, symbol: intent.symbol,
      meaning: intent.meaning, purpose: intent.purpose, rationale: intent.rationale,
      existingSpecification: agentTokenSpecificationFromIntentRow(intent) };
  }
  return { resident: agent, worldFacts: { ...currencyGenesisInfrastructureFacts({ requirement, issuerAssignment }),
    currentWorldMinute: Number(worldMinute),
    currentEconomicEvidence: economicEvidence.rows.map((row) =>
      `${row.service_type} had ${row.unmet_count} unmet requests on world day ${row.world_day}.`) },
  publicCurrencyHistory: history.rows, availableRecipients: recipients.rows, currentProposal };
}

export function classifyCurrencyReviewResult(result, options) {
  if (!Array.isArray(options) || options.length < 2) return { selected: null, diagnostic: {
    outcome: 'no_valid_decision', reasonCode: 'insufficient_review_options', provider: 'typesafe',
    providerAttempted: false } };
  if (result?.currencyReviewDiagnostic) {
    const diagnostic = result.currencyReviewDiagnostic;
    const failedOutcomes = new Set(['provider_unavailable','provider_timeout','provider_error','malformed_output',
      'invalid_choice','low_confidence','no_valid_decision']);
    if (failedOutcomes.has(diagnostic.outcome)) return { selected: null, diagnostic: {
      ...diagnostic, providerAttempted: diagnostic.providerAttempted === true,
      inputTokens: Number.isSafeInteger(diagnostic.inputTokens) && diagnostic.inputTokens >= 0
        ? diagnostic.inputTokens : null } };
    return { selected: null, diagnostic: { outcome: 'malformed_output',
      reasonCode: 'invalid_diagnostic_result', provider: 'typesafe', model: null } };
  }
  if (result === null || result === undefined) return { selected: null, diagnostic: {
    outcome: 'no_valid_decision', reasonCode: 'provider_returned_no_result', provider: 'typesafe',
    providerAttempted: true } };
  if (typeof result !== 'object' || Array.isArray(result)) return { selected: null, diagnostic: {
    outcome: 'malformed_output', reasonCode: 'result_not_an_object', provider: 'typesafe', providerAttempted: true } };
  const usageDiagnostic = { providerAttempted: result.providerAttempted !== false,
    inputTokens: Number.isSafeInteger(result.inputTokens) && result.inputTokens >= 0 ? result.inputTokens : null };
  const rawChoice = result.choice;
  const id = rawChoice && typeof rawChoice === 'object' ? rawChoice.id : rawChoice ?? result.id;
  if (typeof id !== 'string' || !id.length) return { selected: null, diagnostic: {
    outcome: 'malformed_output', reasonCode: 'choice_missing', provider: result.provider || 'typesafe',
    model: result.model || null, ...usageDiagnostic } };
  const selected = options.find((option) => option.id === id);
  const confidence = Number(result?.confidence);
  if (!selected) return { selected: null, diagnostic: { outcome: 'invalid_choice',
    reasonCode: 'choice_not_offered', provider: result.provider || 'typesafe', model: result.model || null,
    ...usageDiagnostic } };
  if (!Number.isFinite(confidence)) return { selected: null, diagnostic: { outcome: 'malformed_output',
    reasonCode: 'confidence_missing_or_invalid', provider: result.provider || 'typesafe', model: result.model || null,
    ...usageDiagnostic } };
  if (confidence < 0.3) return { selected: null, diagnostic: { outcome: 'low_confidence',
    reasonCode: 'confidence_below_existing_threshold', provider: result.provider || 'typesafe',
    model: result.model || null, confidence, ...usageDiagnostic } };
  return { selected: { ...selected, confidence, source: result?.model || 'typesafe' }, diagnostic: {
    outcome: currencyReviewChoiceOutcome(id), reasonCode: 'offered_choice_selected',
    provider: result.provider || 'typesafe', model: result.model || null, confidence, selectedActionId: id,
    ...usageDiagnostic } };
}

async function chooseCurrencyReviewOption(chooseWithTypeSafe, { worldId, agent, worldMinute, requirement, state, options }) {
  if (typeof chooseWithTypeSafe !== 'function') return { selected: null, diagnostic: {
    outcome: 'provider_unavailable', reasonCode: 'provider_callback_unavailable', provider: 'typesafe',
    providerAttempted: false } };
  try {
    const result = await chooseWithTypeSafe({ worldId, agentId: agent.agentId, agent, worldMinute,
      choiceType: 'currency_genesis', state: { ...state, requirement: 'CURRENCY_GENESIS_REQUIRED',
        requirementStatus: requirement.status }, options });
    return classifyCurrencyReviewResult(result, options);
  } catch (error) {
    return { selected: null, diagnostic: { ...currencyReviewErrorOutcome(error), provider: 'typesafe', model: null,
      providerAttempted: true } };
  }
}

async function canConfirmCurrencyIntent(client, { worldId, agentId, intent, worldMinute }) {
  try {
    const wallet = await client.query(`SELECT address,external_identity_id FROM arc_agent_wallets
      WHERE world_id=$1 AND agent_id=$2 AND chain_id=5042 AND status='active'`, [worldId, agentId]);
    if (!wallet.rowCount || !/^[1-9]\d*$/.test(String(wallet.rows[0].external_identity_id || ''))) return false;
    const active = await client.query(`SELECT capability_generation FROM arc_token_pilot_capabilities
      WHERE world_id=$1 AND status='active' ORDER BY capability_generation DESC LIMIT 1`, [worldId]);
    const generation = Number(intent.status === 'deferred'
      ? active.rows[0]?.capability_generation || intent.capability_generation : intent.capability_generation);
    const spec = inspectAgentTokenSpecification(agentTokenSpecificationFromIntentRow(intent), { worldId,
      issuerAgentId: agentId, issuerIdentityId: wallet.rows[0].external_identity_id,
      issuerWallet: wallet.rows[0].address, worldMinute, generation });
    if (!spec.complete) return false;
    return (await verifyDistributionRecipients(client, worldId, spec.distribution)).length === 0;
  } catch { return false; }
}

export async function advanceWorldCurrencyGenesis(client, { worldId, agent, worldMinute,
  chooseWithTypeSafe = null, authorProposal = authorAgentCurrencyProposal, reviewDue = true }) {
  if (!reviewDue) {
    const existing = await client.query(`SELECT * FROM arc_currency_genesis_requirements WHERE world_id=$1`, [worldId]);
    const requirement = existing.rows[0] || null;
    await recordCurrencyReviewOutcome(client, { worldId, agent, worldMinute, requirement,
      outcome: 'skipped_not_due', reasonCode: 'review_not_due', provider: null });
    return { status: requirement?.status || null, decision: 'pending', reason: 'review_not_due' };
  }
  const requirement = await ensureWorldCurrencyGenesisRequirement(client, { worldId, worldMinute });
  await recordRequirementAwareness(client, { worldId, agent, requirement, worldMinute });
  if (requirement.status === 'SATISFIED') {
    await recordCurrencyReviewOutcome(client, { worldId, agent, worldMinute, requirement,
      outcome: 'other', reasonCode: 'requirement_already_satisfied', provider: 'not_called' });
    return { status: 'SATISFIED', decision: 'none' };
  }

  const openRows = await client.query(`SELECT * FROM arc_token_issuance_intents
    WHERE world_id=$1 AND status IN ('incomplete','proposed','deferred')
    ORDER BY created_world_minute,id LIMIT 12`, [worldId]);
  let currentIntent = null;
  if (openRows.rows.length) {
    const rotation = Number.parseInt(createHash('sha256').update(`${agent.agentId}:${Math.floor(worldMinute / 1_440)}`)
      .digest('hex').slice(0, 8), 16) % openRows.rows.length;
    currentIntent = openRows.rows[rotation];
  }
  const options = [
    { id: 'no_action', label: 'No action now', description: 'Leave the unresolved currency requirement as a world fact and attend to other goals.' },
    { id: 'propose_currency', label: 'Express a currency proposal', description: 'If this fits your own goals and evidence, form a proposal for residents to consider. This does not select an issuer or authorize execution.' }
  ];
  if (currentIntent) {
    const intentId = currentIntent.id;
    if (currentIntent.proposer_agent_id !== agent.agentId) {
      const priorResponse = await client.query(`SELECT 1 FROM arc_token_issuance_responses
        WHERE world_id=$1 AND intent_id=$2 AND agent_id=$3`, [worldId, intentId, agent.agentId]);
      if (!priorResponse.rowCount) for (const decision of ['support','oppose','ignore']) {
        options.push({ id: `response:${intentId}:${decision}`, label: `${decision} proposal`,
          description: `Record your ${decision} response to ${currentIntent.name || 'this incomplete currency proposal'}.` });
      }
    }
    const pendingCandidates = await client.query(`SELECT * FROM arc_token_issuance_issuer_candidates
      WHERE world_id=$1 AND intent_id=$2 AND status='nominated' ORDER BY nominated_world_minute,candidate_agent_id`,
    [worldId, intentId]);
    for (const candidate of pendingCandidates.rows.filter((row) => row.candidate_agent_id === agent.agentId)) {
      for (const decision of ['accept','reject','defer']) options.push({
        id: `candidate:${candidate.candidate_agent_id}:${decision}`,
        label: `${decision} issuer candidacy`,
        description: `Decide whether you personally accept, reject, or defer the issuer nomination for ${currentIntent.name || 'this proposal'}.` });
    }
    if (currentIntent.issuer_agent_id === agent.agentId) {
      options.push({ id: `issuer:${intentId}:prepare_specification`, label: 'Develop the proposal specification',
        description: 'Use your own current goals, memories, proposal history, and world evidence to complete or revise fields you have decided.' });
      if (await canConfirmCurrencyIntent(client, { worldId, agentId: agent.agentId, intent: currentIntent, worldMinute })) {
        options.push({ id: `issuer:${intentId}:issue`, label: 'Explicitly confirm this specification',
          description: 'Confirm the complete Agent-authored specification and move it to the gated issuance outbox; this does not broadcast a Mainnet transaction.' });
      }
      options.push({ id: `issuer:${intentId}:reject`, label: 'Reject this proposal',
        description: 'Reject this proposal while leaving the world currency requirement unresolved.' },
      { id: `issuer:${intentId}:defer`, label: 'Defer this proposal',
        description: 'Defer this proposal while leaving the world currency requirement unresolved.' });
    } else if (!currentIntent.issuer_agent_id) {
      const existingCandidates = new Set((await client.query(`SELECT candidate_agent_id FROM arc_token_issuance_issuer_candidates
        WHERE world_id=$1 AND intent_id=$2`, [worldId, intentId])).rows.map((row) => row.candidate_agent_id));
      const members = await client.query(`SELECT member.agent_id AS id,agent.name FROM world_members member
        JOIN agents agent ON agent.id=member.agent_id WHERE member.world_id=$1
        ORDER BY member.joined_at,member.agent_id LIMIT 10`, [worldId]);
      for (const candidate of members.rows.filter((row) => !existingCandidates.has(row.id))) {
        options.push({ id: `nominate:${intentId}:${candidate.id}`, label: `Nominate ${candidate.name}`,
          description: `Propose ${candidate.name} as an issuer candidate. The candidate must personally accept, and issuer confirmation is still required.` });
      }
    }
  }

  const input = await currencyAuthoringInput(client, { worldId, agent, worldMinute, requirement, intent: currentIntent });
  const review = await chooseCurrencyReviewOption(chooseWithTypeSafe, { worldId, agent, worldMinute, requirement,
    state: { worldFacts: input.worldFacts,
      residentGoal: agent.primaryGoal || agent.currentGoal || agent.goal || null,
      activeGoals: Array.isArray(agent.goals) ? agent.goals.slice(0, 8) : [],
      currentNeeds: { energy: agent.energy, food: agent.food, social: agent.social, knowledge: agent.knowledge },
      ownRecentMemories: (agent.recentMemories || []).slice(0, 10),
      currentProposal: currentIntent ? { id: currentIntent.id, status: currentIntent.status,
        proposerAgentId: currentIntent.proposer_agent_id, issuerAgentId: currentIntent.issuer_agent_id,
        name: currentIntent.name, purpose: currentIntent.purpose, specification: agentTokenSpecificationFromIntentRow(currentIntent) } : null,
      proposalsAndResponses: input.publicCurrencyHistory }, options });
  if (!review.selected) {
    await recordCurrencyReviewOutcome(client, { worldId, agent, worldMinute, requirement, ...review.diagnostic });
    return { status: requirement.status, decision: 'pending', reason: 'cognition_abstained_or_unavailable' };
  }
  const selected = review.selected;
  await recordCurrencyReviewChoice(client, { worldId, agent, worldMinute, selected, options, requirement });
  await recordCurrencyReviewOutcome(client, { worldId, agent, worldMinute, requirement, ...review.diagnostic });
  if (selected.id === 'no_action') return { status: requirement.status, decision: 'no_action' };

  if (selected.id === 'propose_currency') {
    let authored = { specification: null, reason: 'local_authoring_unavailable' };
    try { authored = await authorProposal(input, { timeoutMs: 8_000 }); }
    catch { authored = { specification: null, reason: 'local_authoring_unavailable' }; }
    let specification = {};
    let authoringReason = authored.reason || null;
    if (authored.specification) {
      try { specification = cleanPartialSpecification(authored.specification); }
      catch { authoringReason = 'local_authoring_specification_invalid'; }
    }
    const created = await createWorldTokenIssuanceIntent(client, { worldId, agentId: agent.agentId,
      specification, actionId: currencyReviewActionId({ worldId, agentId: agent.agentId, worldMinute, action: 'propose' }),
      worldMinute, decisionPath: 'world_engine', authoring: { provider: 'ollama_loopback',
        model: authored.model || null, status: authored.specification && !authoringReason ? 'expressed' : 'incomplete',
        reason: authoringReason } });
    return { status: created.intent.status === 'incomplete' ? 'INCOMPLETE' : 'PROPOSAL_FORMED',
      decision: 'proposal_created', intentId: created.intent.id,
      authoringStatus: created.intent.metadata.localAuthoring?.status };
  }
  if (selected.id.startsWith('response:')) {
    const [, intentId, decision] = selected.id.split(':');
    const response = await respondToWorldTokenIssuance(client, { worldId, agentId: agent.agentId,
      intentId, decision, actionId: currencyReviewActionId({ worldId, agentId: agent.agentId,
        worldMinute, action: selected.id }), worldMinute });
    return { status: requirement.status, decision: response.decision, intentId };
  }
  if (selected.id.startsWith('nominate:')) {
    const [, intentId, candidateAgentId] = selected.id.split(':');
    const nomination = await nominateWorldTokenIssuer(client, { worldId, agentId: agent.agentId,
      intentId, candidateAgentId, nominationReason: null,
      actionId: currencyReviewActionId({ worldId, agentId: agent.agentId, worldMinute, action: selected.id }), worldMinute });
    return { status: requirement.status, decision: 'issuer_nominated', intentId,
      candidateAgentId: nomination.candidateAgentId };
  }
  if (selected.id.startsWith('candidate:')) {
    const [, candidateAgentId, decision] = selected.id.split(':');
    const result = await decideWorldTokenIssuerCandidate(client, { worldId, agentId: agent.agentId,
      intentId: currentIntent.id, candidateAgentId, decision,
      actionId: currencyReviewActionId({ worldId, agentId: agent.agentId, worldMinute, action: selected.id }), worldMinute });
    return { status: requirement.status, decision: `issuer_candidate_${decision}`, intentId: currentIntent.id,
      issuerSelected: result.issuerSelected };
  }
  if (selected.id.startsWith('issuer:')) {
    const [, intentId, decision] = selected.id.split(':');
    const actionId = currencyReviewActionId({ worldId, agentId: agent.agentId, worldMinute, action: selected.id });
    if (decision === 'prepare_specification') {
      let authored = { specification: null, reason: 'local_authoring_unavailable' };
      try { authored = await authorProposal(input, { timeoutMs: 8_000 }); }
      catch { authored = { specification: null, reason: 'local_authoring_unavailable' }; }
      const current = agentTokenSpecificationFromIntentRow(currentIntent);
      let patch = {};
      let authoringReason = authored.reason || null;
      if (authored.specification) {
        try {
          const generated = cleanPartialSpecification(authored.specification);
          patch = Object.fromEntries(Object.entries(generated).filter(([, value]) => value !== null));
        } catch { authoringReason = 'local_authoring_specification_invalid'; }
      }
      const updated = await updateWorldTokenIssuanceSpecification(client, { worldId, agentId: agent.agentId,
        intentId, specification: { ...current, ...patch }, actionId, worldMinute,
        authoring: { provider: 'ollama_loopback', model: authored.model || null,
          status: authored.specification && !authoringReason ? 'expressed' : 'incomplete', reason: authoringReason } });
      return { status: updated.intent.status === 'incomplete' ? 'INCOMPLETE' : updated.intent.status.toUpperCase(),
        decision: 'specification_prepared', intentId,
        authoringStatus: updated.intent.metadata.localAuthoring?.status };
    }
    const result = await confirmWorldTokenIssuance(client, { worldId, agentId: agent.agentId,
      intentId, decision, actionId, worldMinute });
    return { status: result.intent.status.toUpperCase(), decision, intentId,
      readyForExecution: Boolean(result.readyForExecution) };
  }
  return { status: requirement.status, decision: 'pending', reason: 'unrecognized_choice' };
}

export async function confirmWorldTokenIssuance(client, { worldId, agentId, intentId, decision,
  actionId, worldMinute }) {
  await requireWorldMember(client, worldId, agentId);
  if (!['issue','reject','defer'].includes(decision)) throw worldError('TOKEN_ISSUER_DECISION_INVALID', 400);
  const intent = await readIntent(client, worldId, intentId, true);
  const idempotencyKey = actionIdentifier(actionId);
  if (intent.issuer_agent_id !== agentId) throw worldError('TOKEN_SELECTED_ISSUER_REQUIRED', 403);
  const genesisAssignment = Number(intent.capability_generation) === 1
    ? await creatorGenesisIssuerAssignment(client, worldId, 1) : null;
  if (Number(intent.capability_generation) === 1 && !genesisAssignment) {
    throw worldError('TOKEN_ISSUER_ASSIGNMENT_NOT_FOUND', 409);
  }
  if (genesisAssignment && (genesisAssignment.issuerAgentId !== agentId
      || intent.issuer_selection_source !== genesisAssignment.selectionSource)) {
    throw worldError('TOKEN_ISSUER_CREATOR_ASSIGNMENT_REQUIRED', 409);
  }
  const priorDecision = await client.query(`SELECT intent_id,decision FROM arc_token_issuance_decisions
    WHERE world_id=$1 AND agent_id=$2 AND action_id=$3`, [worldId, agentId, idempotencyKey]);
  if (priorDecision.rowCount) {
    const expected = decision === 'issue' ? 'issuer_confirm' : decision === 'reject' ? 'issuer_reject' : 'issuer_defer';
    if (priorDecision.rows[0].intent_id !== intentId || priorDecision.rows[0].decision !== expected) {
      throw worldError('ACTION_ID_CONFLICT', 409);
    }
    return { intent, idempotent: true, readyForExecution: decision === 'issue'
      && ['issuer_confirmed','prepared'].includes(intent.status) };
  }
  if (['issuer_confirmed','preparing','prepared','submitting','submission_unknown','submitted','created'].includes(intent.status)) {
    return { intent, idempotent: true, readyForExecution: ['issuer_confirmed','prepared'].includes(intent.status) };
  }
  if (!['incomplete','proposed','deferred'].includes(intent.status)) throw worldError('TOKEN_ISSUANCE_NOT_CONFIRMABLE', 409);
  if (decision !== 'issue') {
    const decisionCode = decision === 'reject' ? 'issuer_reject' : 'issuer_defer';
    const nextStatus = decision === 'reject' ? 'rejected' : 'deferred';
    const decisionResult = await client.query(`INSERT INTO arc_token_issuance_decisions(world_id,intent_id,agent_id,decision,rationale,world_minute,action_id)
      VALUES($1,$2,$3,$4,NULL,$5,$6) ON CONFLICT(world_id,agent_id,action_id) DO NOTHING RETURNING id`,
    [worldId, intentId, agentId, decisionCode, worldMinute, idempotencyKey]);
    if (!decisionResult.rowCount) throw worldError('ACTION_ID_CONFLICT', 409);
    const result = await client.query(`UPDATE arc_token_issuance_intents SET status=$4,updated_world_minute=$3,
      updated_at=now() WHERE world_id=$1 AND id=$2 AND status IN ('incomplete','proposed','deferred') RETURNING *`,
    [worldId, intentId, worldMinute, nextStatus]);
    if (!result.rowCount) throw worldError('TOKEN_ISSUANCE_STATE_CHANGED', 409);
    await recordIssuanceEvent(client, { worldId, agentId, intentId, eventType: `token_issuance_issuer_${decision}`,
      worldMinute, actionId: `${createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 40)}:${decision}`,
      details: { status: nextStatus } });
    await writeWorldHistory(client, { worldId, eventKey: `token-issuance-${decision}:${intentId}:${idempotencyKey}`,
      eventType: decision === 'reject' ? 'token_issuance_rejected' : 'token_issuance_deferred',
      actorAgentId: agentId, entityType: 'agent_token_issuance', entityId: intentId, worldTime: worldMinute,
      title: decision === 'reject' ? 'Issuer rejected a token issuance' : 'Issuer deferred a token issuance',
      detail: 'The Agent decision applies to this proposal only; the world currency requirement remains unresolved.',
      metadata: { intentId, decision, requirementRemainsUnresolved: true } });
    await refreshWorldCurrencyGenesisRequirement(client, { worldId, worldMinute });
    return { intent: result.rows[0], [decision === 'reject' ? 'rejected' : 'deferred']: true };
  }

  const walletResult = await client.query(`SELECT wallet.address,wallet.external_identity_id
    FROM arc_agent_wallets wallet WHERE wallet.world_id=$1 AND wallet.agent_id=$2 AND wallet.chain_id=5042
      AND wallet.status='active'`, [worldId, agentId]);
  if (!walletResult.rowCount) throw worldError('TOKEN_ISSUER_WALLET_NOT_READY', 409);
  const wallet = walletResult.rows[0];
  if (!/^[1-9]\d*$/.test(String(wallet.external_identity_id || ''))) throw worldError('TOKEN_ISSUER_IDENTITY_NOT_READY', 409);
  const specification = agentTokenSpecificationFromIntentRow(intent);
  const activeCapability = await client.query(`SELECT capability_generation FROM arc_token_pilot_capabilities
    WHERE world_id=$1 AND status='active' ORDER BY capability_generation DESC LIMIT 1`, [worldId]);
  const effectiveGeneration = Number(intent.status === 'deferred'
    ? activeCapability.rows[0]?.capability_generation || intent.capability_generation
    : intent.capability_generation);
  const normalized = inspectAgentTokenSpecification(specification, { worldId, issuerAgentId: agentId,
    issuerIdentityId: wallet.external_identity_id, issuerWallet: wallet.address, worldMinute,
    generation: effectiveGeneration });
  if (!normalized.complete) throw worldError('TOKEN_ISSUANCE_INCOMPLETE', 409);
  const unsupportedDistribution = await verifyDistributionRecipients(client, worldId, normalized.distribution);
  if (unsupportedDistribution.length) {
    const decisionInsert = await client.query(`INSERT INTO arc_token_issuance_decisions(world_id,intent_id,agent_id,decision,
        rationale,world_minute,action_id) VALUES($1,$2,$3,'issuer_confirm',NULL,$4,$5)
      ON CONFLICT(world_id,agent_id,action_id) DO NOTHING RETURNING id`, [worldId, intentId, agentId, worldMinute, idempotencyKey]);
    if (!decisionInsert.rowCount) throw worldError('ACTION_ID_CONFLICT', 409);
    const deferred = await client.query(`UPDATE arc_token_issuance_intents SET status='deferred',
        issuer_selection_source=COALESCE(issuer_selection_source,$3),issuer_identity_id=$4,issuer_wallet=$5,
        specification_hash=$6,initial_supply_raw=$7,reserve_amount_raw=$8,distribution=$9::jsonb,
        issuer_confirmed_world_minute=$10,updated_world_minute=$10,updated_at=now(),
        metadata=metadata||jsonb_build_object('executionStatus','deferred_unsupported_distribution',
          'unsupportedDistribution',$11::jsonb)
      WHERE world_id=$1 AND id=$2 AND status IN ('incomplete','proposed','deferred') RETURNING *`,
    [worldId, intentId, genesisAssignment?.selectionSource || 'agent_nomination', normalized.issuerIdentityId.toString(),
      normalized.issuerWallet, normalized.specificationHash, normalized.totalSupplyRaw.toString(), normalized.reserveRaw.toString(),
      JSON.stringify(intent.distribution), worldMinute, JSON.stringify(unsupportedDistribution)]);
    if (!deferred.rowCount) throw worldError('TOKEN_ISSUANCE_STATE_CHANGED', 409);
    await recordIssuanceEvent(client, { worldId, agentId, intentId, eventType: 'token_issuance_deferred',
      worldMinute, actionId: `${idempotencyKey}:unsupported-distribution`, details: {
        reason: 'UNSUPPORTED_DISTRIBUTION_RECIPIENT', unsupportedDistribution,
        distributionPreserved: true, creatorAllocationRaw: '0' } });
    await writeWorldHistory(client, { worldId, eventKey: `token-issuance-unsupported-distribution:${intentId}:${idempotencyKey}`,
      eventType: 'token_issuance_deferred', actorAgentId: agentId, entityType: 'agent_token_issuance',
      entityId: intentId, worldTime: worldMinute, title: 'Genesis distribution deferred by current wallet capability',
      detail: 'The issuer-confirmed distribution remains unchanged and deferred because Generation 1 currently executes only to verified world Agent or Organization wallets.',
      metadata: { intentId, specificationHash: normalized.specificationHash, unsupportedDistribution,
        issuerSelectionSource: genesisAssignment?.selectionSource || 'agent_nomination', creatorAllocationRaw: '0' } });
    await refreshWorldCurrencyGenesisRequirement(client, { worldId, worldMinute });
    return { intent: deferred.rows[0], deferred: true, reason: 'UNSUPPORTED_DISTRIBUTION_RECIPIENT',
      unsupportedDistribution, distributionPreserved: true, readyForExecution: false };
  }

  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
    [`synterra-agent-token-capacity:${worldId}`]);
  await client.query(`INSERT INTO arc_token_pilot_capabilities(world_id,capability_generation,max_token_creations,source)
    VALUES($1,$2,$3,'current_mainnet_pilot') ON CONFLICT(world_id,capability_generation) DO NOTHING`,
  [worldId, effectiveGeneration, AGENT_TOKEN_PILOT_MAX_CREATIONS]);
  const capacityResult = await client.query(`SELECT max_token_creations,status FROM arc_token_pilot_capabilities
    WHERE world_id=$1 AND capability_generation=$2 FOR UPDATE`, [worldId, effectiveGeneration]);
  if (!capacityResult.rowCount || capacityResult.rows[0].status !== 'active') throw worldError('TOKEN_CAPABILITY_UNAVAILABLE', 409);
  const capacity = Number(capacityResult.rows[0].max_token_creations);
  const occupied = await client.query(`SELECT
      (SELECT count(*) FROM arc_agent_tokens WHERE world_id=$1) +
      (SELECT count(*) FROM arc_token_issuance_intents WHERE world_id=$1 AND id<>$2 AND status IN
        ('issuer_confirmed','preparing','prepared','submitting','submission_unknown','submitted')) AS count`, [worldId, intentId]);
  if (Number(occupied.rows[0]?.count || 0) >= capacity) {
    const decisionResult = await client.query(`INSERT INTO arc_token_issuance_decisions(world_id,intent_id,agent_id,decision,rationale,world_minute,action_id)
      VALUES($1,$2,$3,'issuer_confirm',NULL,$4,$5) ON CONFLICT(world_id,agent_id,action_id) DO NOTHING`,
    [worldId, intentId, agentId, worldMinute, idempotencyKey]);
    if (!decisionResult.rowCount) throw worldError('ACTION_ID_CONFLICT', 409);
    const deferred = await client.query(`UPDATE arc_token_issuance_intents SET status='deferred',capability_generation=$4,updated_world_minute=$3,
        updated_at=now(),metadata=metadata||'{}'::jsonb
      WHERE world_id=$1 AND id=$2 AND status IN ('incomplete','proposed','deferred') RETURNING *`,
    [worldId, intentId, worldMinute, effectiveGeneration]);
    if (!deferred.rowCount) throw worldError('TOKEN_ISSUANCE_STATE_CHANGED', 409);
    await recordIssuanceEvent(client, { worldId, agentId, intentId, eventType: 'token_issuance_deferred',
      worldMinute, actionId: `${idempotencyKey}:deferred`, details: { reason: 'CURRENT_CAPABILITY_LIMIT_REACHED',
        capabilityGeneration: effectiveGeneration, maxTokenCreations: capacity } });
    await writeWorldHistory(client, { worldId, eventKey: `token-issuance-deferred:${intentId}`,
      eventType: 'token_issuance_deferred', actorAgentId: agentId, entityType: 'agent_token_issuance',
      entityId: intentId, worldTime: worldMinute, title: 'Token issuance deferred by current capability limit',
      detail: 'The Agent-authored issuance intent remains saved for a future multi-token capability.',
      metadata: { intentId, reason: 'CURRENT_CAPABILITY_LIMIT_REACHED', capabilityGeneration: effectiveGeneration } });
    await refreshWorldCurrencyGenesisRequirement(client, { worldId, worldMinute });
    return { intent: deferred.rows[0], deferred: true, reason: 'CURRENT_CAPABILITY_LIMIT_REACHED' };
  }

  const decisionInsert = await client.query(`INSERT INTO arc_token_issuance_decisions(world_id,intent_id,agent_id,decision,
      rationale,world_minute,action_id) VALUES($1,$2,$3,'issuer_confirm',NULL,$4,$5)
    ON CONFLICT(world_id,agent_id,action_id) DO NOTHING RETURNING id`, [worldId, intentId, agentId, worldMinute, idempotencyKey]);
  if (!decisionInsert.rowCount) throw worldError('ACTION_ID_CONFLICT', 409);
  const saved = await client.query(`UPDATE arc_token_issuance_intents SET status='issuer_confirmed',
      capability_generation=$3,issuer_identity_id=$4,issuer_wallet=$5,specification_hash=$6,initial_supply_raw=$7,
      reserve_amount_raw=$8,distribution=$9::jsonb,issuer_confirmed_world_minute=$10,
      issuer_selection_source=COALESCE(issuer_selection_source,$11),
      updated_world_minute=$10,updated_at=now()
    WHERE world_id=$1 AND id=$2 AND status IN ('incomplete','proposed','deferred') RETURNING *`, [worldId, intentId,
    effectiveGeneration, normalized.issuerIdentityId.toString(), normalized.issuerWallet, normalized.specificationHash,
    normalized.totalSupplyRaw.toString(), normalized.reserveRaw.toString(),
    JSON.stringify(normalized.distribution.map((recipient) => ({ recipientType: recipient.recipientType,
      recipientId: recipient.recipientId, recipientAddress: recipient.recipientAddress,
      amountRaw: recipient.amountRaw.toString() }))), worldMinute,
    genesisAssignment?.selectionSource || 'agent_nomination']);
  if (!saved.rowCount) {
    throw worldError('TOKEN_ISSUANCE_STATE_CHANGED', 409);
  }
  await recordIssuanceEvent(client, { worldId, agentId, intentId, eventType: 'token_issuance_issuer_confirmed',
    worldMinute, actionId: `${idempotencyKey}:confirmed`, details: { issuerAgentId: agentId,
      issuerIdentityId: normalized.issuerIdentityId.toString(), issuerWallet: normalized.issuerWallet,
      issuerSelectionSource: genesisAssignment?.selectionSource || 'agent_nomination',
      specificationHash: normalized.specificationHash } });
  await writeWorldHistory(client, { worldId, eventKey: `token-issuance-issuer-confirmed:${intentId}`,
    eventType: 'token_issuance_issuer_confirmed', actorAgentId: agentId, entityType: 'agent_token_issuance',
    entityId: intentId, worldTime: worldMinute, title: 'Selected issuer confirmed a token specification',
    detail: 'The Agent selected as issuer confirmed the identity, supply distribution and purpose.',
    metadata: { intentId, issuerAgentId: agentId, issuerIdentityId: normalized.issuerIdentityId.toString(),
      issuerWallet: normalized.issuerWallet, specificationHash: normalized.specificationHash } });
  await refreshWorldCurrencyGenesisRequirement(client, { worldId, worldMinute });
  return { intent: saved.rows[0], readyForExecution: true, idempotent: false };
}

export async function listWorldTokenIssuance(client, { worldId, limit = 30 }) {
  const safeLimit = Math.max(1, Math.min(100, Math.trunc(Number(limit) || 30)));
  const result = await client.query(`SELECT intent.id,intent.proposer_agent_id AS "proposerAgentId",
      proposer.name AS "proposerName",intent.issuer_agent_id AS "issuerAgentId",issuer.name AS "issuerName",
      intent.capability_generation AS "capabilityGeneration",intent.creation_sequence AS "creationSequence",
      intent.status,intent.name,intent.symbol,intent.meaning,intent.purpose,intent.rationale,intent.decimals,
      intent.initial_supply_human AS "initialSupplyHuman",intent.initial_supply_raw::text AS "initialSupplyRaw",
      intent.distribution,intent.reserve_amount_raw::text AS "reserveAmountRaw",
      intent.issuer_identity_id::text AS "issuerIdentityId",intent.issuer_wallet AS "issuerWallet",
      intent.specification_hash AS "specificationHash",intent.transaction_sender AS "transactionSender",
      intent.transaction_hash AS "transactionHash",intent.created_world_minute AS "createdWorldMinute",
      intent.updated_world_minute AS "updatedWorldMinute",intent.metadata->'incompleteFields' AS "incompleteFields",
      COALESCE((SELECT jsonb_object_agg(response.decision,response.count) FROM (
        SELECT decision,count(*)::int AS count FROM arc_token_issuance_responses
        WHERE world_id=intent.world_id AND intent_id=intent.id GROUP BY decision) response),'{}'::jsonb) AS responses,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('agentId',response.agent_id,'agentName',agent.name,
        'decision',response.decision,'rationale',response.rationale,'worldMinute',response.world_minute)
        ORDER BY response.world_minute,response.agent_id) FROM arc_token_issuance_responses response
        JOIN agents agent ON agent.id=response.agent_id
        WHERE response.world_id=intent.world_id AND response.intent_id=intent.id),'[]'::jsonb) AS "agentResponses",
      COALESCE((SELECT jsonb_agg(jsonb_build_object('agentId',candidate.candidate_agent_id,
        'agentName',agent.name,'nominatedByAgentId',candidate.nominated_by_agent_id,
        'nominatedByName',nominator.name,'status',candidate.status,'reason',candidate.nomination_reason,
        'nominatedWorldMinute',candidate.nominated_world_minute,'decidedWorldMinute',candidate.decided_world_minute)
        ORDER BY candidate.nominated_world_minute,candidate.candidate_agent_id)
        FROM arc_token_issuance_issuer_candidates candidate
        JOIN agents agent ON agent.id=candidate.candidate_agent_id
        JOIN agents nominator ON nominator.id=candidate.nominated_by_agent_id
        WHERE candidate.world_id=intent.world_id AND candidate.intent_id=intent.id),'[]'::jsonb) AS "issuerCandidates",
      token.token_address AS "tokenAddress",token.creation_sequence AS "tokenCreationSequence"
    FROM arc_token_issuance_intents intent JOIN agents proposer ON proposer.id=intent.proposer_agent_id
    LEFT JOIN agents issuer ON issuer.id=intent.issuer_agent_id
    LEFT JOIN arc_agent_tokens token ON token.world_id=intent.world_id AND token.intent_id=intent.id
    WHERE intent.world_id=$1 ORDER BY intent.created_world_minute DESC,intent.id DESC LIMIT $2`, [worldId, safeLimit]);
  return result.rows;
}

export async function decideWorldAgentTokenAcceptance(client, { worldId, agentId, tokenId, decision,
  rationale = null, actionId, worldMinute }) {
  await requireWorldMember(client, worldId, agentId);
  if (!['accept','reject','ignore'].includes(decision)) throw worldError('AGENT_TOKEN_DECISION_INVALID', 400);
  const token = await client.query(`SELECT id,token_address,name,symbol FROM arc_agent_tokens
    WHERE world_id=$1 AND id=$2`, [worldId, tokenId]);
  if (!token.rowCount) throw worldError('AGENT_TOKEN_NOT_FOUND', 404);
  const action = actionIdentifier(actionId);
  const text = rationale === null ? null : requiredText(rationale, 1, 1000, 'agent_token_rationale');
  const prior = await client.query(`SELECT token_id,decision,rationale FROM arc_agent_token_responses
    WHERE world_id=$1 AND agent_id=$2 AND action_id=$3`, [worldId, agentId, action]);
  if (prior.rowCount) {
    if (prior.rows[0].token_id !== tokenId || prior.rows[0].decision !== decision || prior.rows[0].rationale !== text) {
      throw worldError('ACTION_ID_CONFLICT', 409);
    }
    return { tokenId, decision, idempotent: true };
  }
  await client.query(`INSERT INTO arc_agent_token_responses(world_id,token_id,agent_id,decision,rationale,world_minute,action_id)
    VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(world_id,token_id,agent_id) DO UPDATE SET
      decision=EXCLUDED.decision,rationale=EXCLUDED.rationale,world_minute=EXCLUDED.world_minute,
      action_id=EXCLUDED.action_id,updated_at=now()`, [worldId, tokenId, agentId, decision, text, worldMinute, action]);
  const eventType = decision === 'accept' ? 'agent_token_accepted' : decision === 'reject' ? 'agent_token_rejected' : 'agent_token_ignored';
  await writeWorldHistory(client, { worldId, eventKey: `agent-token-response:${tokenId}:${agentId}:${action}`,
    eventType, actorAgentId: agentId, entityType: 'agent_token', entityId: tokenId, worldTime: worldMinute,
    title: `Agent ${decision} an Agent-created token`, detail: `An Agent recorded a ${decision} response.`,
    metadata: { tokenId, tokenAddress: token.rows[0].token_address, decision, rationale: text } });
  return { tokenId, decision, idempotent: false };
}

export async function recordWorldAgentTokenUse(client, { worldId, agentId, tokenId, usageContext,
  evidence = {}, actionId, worldMinute }) {
  await requireWorldMember(client, worldId, agentId);
  const token = await client.query(`SELECT id,token_address,name,symbol FROM arc_agent_tokens
    WHERE world_id=$1 AND id=$2`, [worldId, tokenId]);
  if (!token.rowCount) throw worldError('AGENT_TOKEN_NOT_FOUND', 404);
  const context = requiredText(usageContext, 3, 1000, 'agent_token_usage_context');
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)
      || Buffer.byteLength(JSON.stringify(evidence), 'utf8') > 8000) throw worldError('AGENT_TOKEN_EVIDENCE_INVALID', 400);
  const action = actionIdentifier(actionId);
  const inserted = await client.query(`INSERT INTO arc_agent_token_uses(world_id,token_id,agent_id,usage_context,evidence,
      world_minute,action_id) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7)
    ON CONFLICT(world_id,agent_id,action_id) DO NOTHING RETURNING id`,
  [worldId, tokenId, agentId, context, JSON.stringify(evidence), worldMinute, action]);
  if (!inserted.rowCount) {
    const prior = await client.query(`SELECT token_id,usage_context,evidence FROM arc_agent_token_uses
      WHERE world_id=$1 AND agent_id=$2 AND action_id=$3`, [worldId, agentId, action]);
    const saved = prior.rows[0];
    if (!saved || saved.token_id !== tokenId || saved.usage_context !== context
        || JSON.stringify(saved.evidence) !== JSON.stringify(evidence)) throw worldError('ACTION_ID_CONFLICT', 409);
    return { tokenId, used: false, idempotent: true };
  }
  await writeWorldHistory(client, { worldId, eventKey: `agent-token-use:${agentId}:${action}`,
    eventType: 'agent_token_used', actorAgentId: agentId, entityType: 'agent_token', entityId: tokenId,
    worldTime: worldMinute, title: `Agent used ${token.rows[0].symbol}`,
    detail: 'An Agent recorded a self-authored use of this token.', metadata: { tokenId,
      tokenAddress: token.rows[0].token_address, usageContext: context, evidence, usageId: inserted.rows[0].id } });
  return { tokenId, usageId: inserted.rows[0].id, used: true, idempotent: false };
}

export async function readWorldAgentTokenSummary(client, { worldId }) {
  const [capability, counts, tokens, intents, acceptance, usage, requirement] = await Promise.all([
    client.query(`SELECT capability_generation AS "capabilityGeneration",max_token_creations AS "maxTokenCreations",status
      FROM arc_token_pilot_capabilities WHERE world_id=$1 ORDER BY capability_generation`, [worldId]),
    client.query(`SELECT count(*)::int AS intents,
        count(*) FILTER (WHERE status='incomplete')::int AS incomplete,
        count(*) FILTER (WHERE status='proposed')::int AS proposed,
        count(*) FILTER (WHERE status='created')::int AS created,
        count(*) FILTER (WHERE status='deferred')::int AS deferred,
        count(*) FILTER (WHERE status='budget_blocked')::int AS "budgetBlocked",
        count(*) FILTER (WHERE status='failed')::int AS failed,
        count(*) FILTER (WHERE status='rejected')::int AS rejected,
        count(*) FILTER (WHERE status='extension_requested')::int AS "extensionRequested",
        count(*) FILTER (WHERE status IN ('issuer_confirmed','preparing','prepared','submitting','submission_unknown','submitted'))::int AS pending
      FROM arc_token_issuance_intents WHERE world_id=$1`, [worldId]),
    client.query(`SELECT count(*)::int AS createdTokens,
        COALESCE(jsonb_agg(jsonb_build_object('id',token.id,'tokenAddress',token.token_address,
          'factoryAddress',token.factory_address,'name',token.name,'symbol',token.symbol,
          'decimals',token.decimals,'initialSupplyRaw',token.initial_supply_raw::text,
          'reserveSupplyRaw',token.reserve_supply_raw::text,'issuerAgentId',token.issuer_agent_id,
          'issuerIdentityId',token.issuer_identity_id::text,'issuerWallet',token.issuer_wallet,
          'transactionSender',token.transaction_sender,'specificationHash',token.specification_hash,
          'createdWorldMinute',token.created_world_minute,
          'acceptanceResponses',COALESCE((SELECT jsonb_object_agg(response.decision,response.count)
            FROM (SELECT decision,count(*)::int AS count FROM arc_agent_token_responses
              WHERE world_id=token.world_id AND token_id=token.id GROUP BY decision) response),'{}'::jsonb),
          'usageCount',(SELECT count(*)::int FROM arc_agent_token_uses use_row
            WHERE use_row.world_id=token.world_id AND use_row.token_id=token.id),
          'uniqueUsers',(SELECT count(DISTINCT use_row.agent_id)::int FROM arc_agent_token_uses use_row
            WHERE use_row.world_id=token.world_id AND use_row.token_id=token.id))
          ORDER BY token.capability_generation,token.creation_sequence),'[]'::jsonb) AS tokens
      FROM arc_agent_tokens token WHERE token.world_id=$1`, [worldId]),
    client.query(`SELECT count(*)::int AS responses,
        count(*) FILTER (WHERE decision='support')::int AS support,
        count(*) FILTER (WHERE decision='oppose')::int AS oppose,
        count(*) FILTER (WHERE decision='ignore')::int AS ignore
      FROM arc_token_issuance_responses WHERE world_id=$1`, [worldId]),
    client.query(`SELECT count(*)::int AS responses,
        count(*) FILTER (WHERE decision='accept')::int AS accept,
        count(*) FILTER (WHERE decision='reject')::int AS reject,
        count(*) FILTER (WHERE decision='ignore')::int AS ignore
      FROM arc_agent_token_responses WHERE world_id=$1`, [worldId]),
    client.query(`SELECT count(*)::int AS uses,count(DISTINCT agent_id)::int AS "uniqueAgents"
      FROM arc_agent_token_uses WHERE world_id=$1`, [worldId]),
    client.query(`SELECT status,capability_generation AS "capabilityGeneration",current_proposal_id AS "currentProposalId",
        first_required_world_minute AS "firstRequiredWorldMinute",last_transition_world_minute AS "lastTransitionWorldMinute",
        satisfied_token_id AS "satisfiedTokenId",satisfied_world_minute AS "satisfiedWorldMinute",transition_reason AS "transitionReason"
      FROM arc_currency_genesis_requirements WHERE world_id=$1`, [worldId])
  ]);
  return { capability: capability.rows, counts: counts.rows[0], tokens: tokens.rows[0]?.tokens || [],
    createdTokenCount: Number(tokens.rows[0]?.createdTokens || 0), proposalResponses: intents.rows[0],
    acceptance: acceptance.rows[0], usage: usage.rows[0], requirement: requirement.rows[0] || null };
}

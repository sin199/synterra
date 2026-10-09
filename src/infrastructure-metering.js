import { isDeepStrictEqual } from 'node:util';

const RESOURCE_CATEGORIES = new Set(['ai_inference', 'high_cost_research', 'long_term_storage',
  'server_compute', 'indexing', 'settlement', 'arc_execution', 'other']);
const ATTRIBUTION_TYPES = new Set(['world', 'agent', 'organization']);
const COST_STATUSES = new Set(['unpriced', 'estimated', 'actual']);
const COST_CURRENCIES = new Set(['USD', 'ARC_USDC']);
const COST_EVIDENCE_SOURCES = new Set(['provider_reported', 'invoice', 'arc_receipt', 'operator_estimate', 'unknown']);

function meteringError(code, statusCode = 400) {
  return Object.assign(new Error(code), { code, statusCode });
}

function positiveInteger(value, code) {
  const raw = typeof value === 'bigint' ? value.toString() : String(value ?? '');
  if (!/^[1-9]\d*$/.test(raw)) throw meteringError(code);
  return raw;
}

function optionalNonNegativeInteger(value, code) {
  if (value === null || value === undefined) return null;
  const raw = typeof value === 'bigint' ? value.toString() : String(value);
  if (!/^(?:0|[1-9]\d*)$/.test(raw)) throw meteringError(code);
  return raw;
}

function plainMetadata(value) {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw meteringError('INFRASTRUCTURE_USAGE_METADATA_INVALID');
  let serialized;
  try { serialized = JSON.stringify(value); }
  catch { throw meteringError('INFRASTRUCTURE_USAGE_METADATA_INVALID'); }
  if (Buffer.byteLength(serialized, 'utf8') > 16_384) throw meteringError('INFRASTRUCTURE_USAGE_METADATA_TOO_LARGE');
  return JSON.parse(serialized);
}

function normalizeUsage(input) {
  if (!input || !ATTRIBUTION_TYPES.has(input.attributionType)) throw meteringError('INFRASTRUCTURE_ATTRIBUTION_INVALID');
  const hasAgent = typeof input.agentId === 'string' && input.agentId.length > 0;
  const hasOrganization = typeof input.organizationId === 'string' && input.organizationId.length > 0;
  if ((input.attributionType === 'world' && (hasAgent || hasOrganization))
      || (input.attributionType === 'agent' && (!hasAgent || hasOrganization))
      || (input.attributionType === 'organization' && (hasAgent || !hasOrganization))) {
    throw meteringError('INFRASTRUCTURE_ATTRIBUTION_INVALID');
  }
  const actionId = typeof input.actionId === 'string' ? input.actionId.trim() : '';
  if (actionId.length < 8 || actionId.length > 180) throw meteringError('INFRASTRUCTURE_USAGE_ACTION_ID_INVALID');
  const resourceCategory = String(input.resourceCategory || '');
  if (!RESOURCE_CATEGORIES.has(resourceCategory)) throw meteringError('INFRASTRUCTURE_RESOURCE_CATEGORY_INVALID');
  const provider = typeof input.provider === 'string' ? input.provider.trim() : '';
  const unit = typeof input.unit === 'string' ? input.unit.trim() : '';
  if (!provider || provider.length > 120 || !unit || unit.length > 80) throw meteringError('INFRASTRUCTURE_USAGE_LABEL_INVALID');
  const costStatus = input.costStatus || 'unpriced';
  if (!COST_STATUSES.has(costStatus)) throw meteringError('INFRASTRUCTURE_COST_STATUS_INVALID');
  const costCurrency = input.costCurrency || null;
  const costChainId = input.costChainId === undefined || input.costChainId === null ? null : Number(input.costChainId);
  const costMicrounits = optionalNonNegativeInteger(input.costMicrounits, 'INFRASTRUCTURE_COST_AMOUNT_INVALID');
  if (costStatus === 'unpriced' && (costCurrency !== null || costChainId !== null || costMicrounits !== null)) {
    throw meteringError('INFRASTRUCTURE_UNPRICED_COST_MUST_BE_EMPTY');
  }
  if (costStatus !== 'unpriced' && (!COST_CURRENCIES.has(costCurrency) || costMicrounits === null)) {
    throw meteringError('INFRASTRUCTURE_COST_EVIDENCE_REQUIRED');
  }
  const costEvidenceSource = input.costEvidenceSource || null;
  if (costCurrency === 'ARC_USDC' && costChainId !== 5042) throw meteringError('INFRASTRUCTURE_ARC_USDC_CHAIN_INVALID');
  if (costCurrency === 'USD' && costChainId !== null) throw meteringError('INFRASTRUCTURE_USD_CHAIN_INVALID');
  if (costEvidenceSource !== null && !COST_EVIDENCE_SOURCES.has(costEvidenceSource)) {
    throw meteringError('INFRASTRUCTURE_COST_EVIDENCE_SOURCE_INVALID');
  }
  if (costStatus === 'estimated' && !['provider_reported', 'invoice', 'arc_receipt', 'operator_estimate'].includes(costEvidenceSource)) {
    throw meteringError('INFRASTRUCTURE_ESTIMATED_COST_EVIDENCE_REQUIRED');
  }
  if (costStatus === 'actual' && !['provider_reported', 'invoice', 'arc_receipt'].includes(costEvidenceSource)) {
    throw meteringError('INFRASTRUCTURE_ACTUAL_COST_EVIDENCE_REQUIRED');
  }
  if (costStatus === 'actual' && costCurrency === 'ARC_USDC' && costEvidenceSource !== 'arc_receipt') {
    throw meteringError('INFRASTRUCTURE_ARC_USDC_RECEIPT_REQUIRED');
  }
  const worldMinute = Number(input.worldMinute);
  if (!Number.isSafeInteger(worldMinute) || worldMinute < 0) throw meteringError('INFRASTRUCTURE_WORLD_MINUTE_INVALID');
  return { attributionType: input.attributionType, agentId: hasAgent ? input.agentId : null,
    organizationId: hasOrganization ? input.organizationId : null, actionId, resourceCategory, provider,
    model: typeof input.model === 'string' && input.model.length ? input.model.slice(0, 120) : null,
    worldMinute, quantityRaw: positiveInteger(input.quantityRaw, 'INFRASTRUCTURE_USAGE_QUANTITY_INVALID'),
    unit, costStatus, costCurrency, costChainId, costMicrounits, costEvidenceSource,
    costEvidenceReference: typeof input.costEvidenceReference === 'string'
      ? input.costEvidenceReference.slice(0, 240) : null,
    metadata: plainMetadata(input.metadata) };
}

function sameUsage(row, usage) {
  return row.attribution_type === usage.attributionType && row.agent_id === usage.agentId
    && row.organization_id === usage.organizationId && row.resource_category === usage.resourceCategory
    && row.provider === usage.provider && row.model === usage.model
    && String(row.world_minute) === String(usage.worldMinute)
    && String(row.quantity_raw) === usage.quantityRaw && row.unit === usage.unit
    && row.cost_status === usage.costStatus && row.cost_currency === usage.costCurrency
    && (row.cost_chain_id === null ? null : Number(row.cost_chain_id)) === usage.costChainId
    && (row.cost_microunits === null ? null : String(row.cost_microunits)) === usage.costMicrounits
    && row.cost_evidence_source === usage.costEvidenceSource
    && row.cost_evidence_reference === usage.costEvidenceReference
    && isDeepStrictEqual(row.metadata, usage.metadata);
}

// Append-only metering records consumption/cost evidence. It never calculates or collects a fee.
export async function recordInfrastructureUsageEvent(client, input) {
  const usage = normalizeUsage(input);
  const inserted = await client.query(`INSERT INTO world_infrastructure_usage_events(world_id,attribution_type,
      agent_id,organization_id,action_id,resource_category,provider,model,world_minute,quantity_raw,unit,
      cost_status,cost_currency,cost_chain_id,cost_microunits,cost_evidence_source,cost_evidence_reference,metadata)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::jsonb)
    ON CONFLICT(world_id,action_id) DO NOTHING RETURNING id`, [input.worldId, usage.attributionType, usage.agentId,
    usage.organizationId, usage.actionId, usage.resourceCategory, usage.provider, usage.model, usage.worldMinute,
    usage.quantityRaw, usage.unit, usage.costStatus, usage.costCurrency, usage.costChainId, usage.costMicrounits,
    usage.costEvidenceSource, usage.costEvidenceReference, JSON.stringify(usage.metadata)]);
  if (inserted.rowCount) return { id: inserted.rows[0].id, created: true };
  const existing = await client.query(`SELECT id,attribution_type,agent_id,organization_id,resource_category,
      provider,model,world_minute,quantity_raw::text AS quantity_raw,unit,cost_status,cost_currency,
      cost_chain_id,cost_microunits::text AS cost_microunits,cost_evidence_source,cost_evidence_reference,metadata
    FROM world_infrastructure_usage_events WHERE world_id=$1 AND action_id=$2`, [input.worldId, usage.actionId]);
  if (!existing.rowCount || !sameUsage(existing.rows[0], usage)) {
    throw meteringError('INFRASTRUCTURE_USAGE_ACTION_CONFLICT', 409);
  }
  return { id: existing.rows[0].id, created: false };
}

export async function listInfrastructureUsageEvents(client, { worldId, attributionType = null,
  agentId = null, organizationId = null, limit = 100 } = {}) {
  const boundedLimit = Math.max(1, Math.min(500, Math.trunc(Number(limit) || 100)));
  const result = await client.query(`SELECT id,world_id AS "worldId",attribution_type AS "attributionType",
      agent_id AS "agentId",organization_id AS "organizationId",action_id AS "actionId",
      resource_category AS "resourceCategory",provider,model,world_minute AS "worldMinute",
      quantity_raw::text AS "quantityRaw",unit,cost_status AS "costStatus",cost_currency AS "costCurrency",
      cost_chain_id AS "costChainId",cost_microunits::text AS "costMicrounits",cost_evidence_source AS "costEvidenceSource",
      cost_evidence_reference AS "costEvidenceReference",metadata,created_at AS "createdAt"
    FROM world_infrastructure_usage_events WHERE world_id=$1
      AND ($2::text IS NULL OR attribution_type=$2)
      AND ($3::uuid IS NULL OR agent_id=$3)
      AND ($4::uuid IS NULL OR organization_id=$4)
    ORDER BY world_minute DESC,created_at DESC,id DESC LIMIT $5`,
  [worldId, attributionType, agentId, organizationId, boundedLimit]);
  return result.rows;
}

// Policies are stored separately from Agent taxes; there is no default policy or fee collection path.
export async function listOperatorInfrastructureFeePolicies(client, { worldId, status = null } = {}) {
  const result = await client.query(`SELECT id,world_id AS "worldId",policy_key AS "policyKey",
      policy_version AS "policyVersion",resource_category AS "resourceCategory",payer_scope AS "payerScope",
      fee_class AS "feeClass",status,pricing_model AS "pricingModel",settlement_asset AS "settlementAsset",
      settlement_token_id AS "settlementTokenId",rate_raw::text AS "rateRaw",rate_unit AS "rateUnit",
      created_at AS "createdAt" FROM world_infrastructure_fee_policies
    WHERE world_id=$1 AND ($2::text IS NULL OR status=$2)
    ORDER BY policy_key,policy_version DESC`, [worldId, status]);
  return result.rows;
}

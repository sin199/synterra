import { parsePositiveUnits, formatUnits } from './units.js';
import { ensureEconomicAccount, getEconomicAccount, transferBetweenAccounts } from './economic-ledger.js';
import { actionIdentifier, boundedNumber, jsonObject, requireWorldMember, requiredText, worldError, writeWorldHistory } from './world-domain.js';
import { decideOrganizationMembership } from './world-organizations.js';
import { decideProjectMembership } from './world-projects.js';
import { isGenesisCurrencyActive, readGenesisCurrencyActivation, formatGenesisTokenRaw,
  createArcGenesisTokenSettlementIntent } from './genesis-economy.js';

const AGREEMENT_TYPES = new Set(['employment','service','project_cooperation','investment','revenue_sharing',
  'resource_sharing','organization_membership','supplier_relationship','partnership']);
const TERM_KEYS = {
  employment: ['businessId','jobId','applicationId','employmentId','wageUsdc','role','durationShifts'],
  service: ['businessId','serviceId','customerAgentId','priceUsdc','units','deliveryDelayWorldMinutes'],
  project_cooperation: ['projectId','effortPoints','rewardShare'],
  investment: ['businessId','amountUsdc','amountRaw','tokenId','ownershipShare'],
  revenue_sharing: ['businessId','shareBps','recipientAgentId','capPerDayUsdc'],
  resource_sharing: ['resourceKey','amount','recipientAgentId'],
  organization_membership: ['organizationId','role'],
  supplier_relationship: ['businessId','serviceId','customerAgentId','priceUsdc','maxUnits','deliveryDelayWorldMinutes'],
  partnership: ['businessId','sellerAgentId','buyerAgentId','ownershipShare','priceUsdc','gift']
};
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const clamp = (value, low, high) => Math.max(low, Math.min(high, Number(value) || 0));
const round4 = (value) => Math.round(value * 10_000) / 10_000;
const INSTITUTIONAL_RETRY_WORLD_MINUTES = 60;

function agreementUnitLimit(terms = {}) {
  const value = Number(terms.maxUnits ?? terms.units ?? 1);
  return Math.max(1, Math.trunc(Number.isFinite(value) ? value : 1));
}

async function scheduleInstitutionalRetry(client, { worldId, agentId, worldTime }) {
  const retryAt = Number(worldTime) + INSTITUTIONAL_RETRY_WORLD_MINUTES;
  await client.query(`UPDATE world_agent_states SET next_institutional_review_world_minutes=$3,updated_at=now()
    WHERE world_id=$1 AND agent_id=$2
      AND (next_institutional_review_world_minutes IS NULL OR next_institutional_review_world_minutes>$3)`,
  [worldId, agentId, retryAt]);
}

function institutionError(code, statusCode = 409) { return worldError(code, statusCode); }

function normalizeAmount(value, field, { min = '0.00000001', max = '1000000' } = {}) {
  let units;
  try { units = parsePositiveUnits(String(value)); } catch { throw institutionError(`${field.toUpperCase()}_INVALID`, 400); }
  if (units < parsePositiveUnits(min) || units > parsePositiveUnits(max)) throw institutionError(`${field.toUpperCase()}_INVALID`, 400);
  return formatUnits(units);
}

function normalizeTerms(type, value) {
  if (!AGREEMENT_TYPES.has(type)) throw institutionError('AGREEMENT_TYPE_INVALID', 400);
  const input = jsonObject(value, 'agreement_terms');
  const terms = Object.fromEntries(Object.entries(input).filter(([key]) => TERM_KEYS[type].includes(key)));
  const idKeys = ['businessId','jobId','applicationId','employmentId','serviceId','projectId','recipientAgentId','customerAgentId',
    'organizationId','sellerAgentId','buyerAgentId','tokenId'];
  for (const key of idKeys) if (terms[key] !== undefined && !UUID_RE.test(String(terms[key]))) {
    throw institutionError(`AGREEMENT_${key.toUpperCase()}_INVALID`, 400);
  }
  const amountKeys = ['wageUsdc','priceUsdc','amountUsdc','capPerDayUsdc','amount'];
  for (const key of amountKeys) if (terms[key] !== undefined) terms[key] = normalizeAmount(terms[key], key,
    { min: key === 'amount' ? '0.00000001' : '0.01' });
  if (terms.ownershipShare !== undefined) terms.ownershipShare = boundedNumber(terms.ownershipShare, 0.0001, 0.95, 'ownership_share');
  if (terms.amountRaw !== undefined) {
    if (typeof terms.amountRaw !== 'string' || !/^[1-9]\d*$/.test(terms.amountRaw)
        || BigInt(terms.amountRaw) > (1n << 128n) - 1n) {
      throw institutionError('AGREEMENT_AMOUNT_RAW_INVALID', 400);
    }
  }
  if (terms.rewardShare !== undefined) terms.rewardShare = boundedNumber(terms.rewardShare, 0, 1, 'reward_share');
  if (terms.shareBps !== undefined) terms.shareBps = Math.trunc(boundedNumber(terms.shareBps, 1, 5000, 'share_bps'));
  if (terms.units !== undefined) terms.units = Math.trunc(boundedNumber(terms.units, 1, 10, 'units'));
  if (terms.maxUnits !== undefined) terms.maxUnits = Math.trunc(boundedNumber(terms.maxUnits, 1, 100, 'max_units'));
  if (terms.durationShifts !== undefined) terms.durationShifts = Math.trunc(boundedNumber(terms.durationShifts, 1, 500, 'duration_shifts'));
  if (terms.deliveryDelayWorldMinutes !== undefined) terms.deliveryDelayWorldMinutes = Math.trunc(
    boundedNumber(terms.deliveryDelayWorldMinutes, 60, 43_200, 'delivery_delay_world_minutes'));
  if (terms.effortPoints !== undefined) terms.effortPoints = boundedNumber(terms.effortPoints, 0.1, 1000, 'effort_points');
  if (terms.role !== undefined) terms.role = requiredText(terms.role, 3, 80, 'agreement_role');
  if (terms.resourceKey !== undefined && !['simulated_usdc','effort'].includes(terms.resourceKey)) {
    throw institutionError('AGREEMENT_RESOURCE_INVALID', 400);
  }
  if (terms.gift !== undefined && typeof terms.gift !== 'boolean') throw institutionError('AGREEMENT_GIFT_INVALID', 400);
  if (type === 'employment' && !terms.employmentId) throw institutionError('EMPLOYMENT_ID_REQUIRED', 400);
  if (type === 'investment' && (!terms.businessId || (!terms.amountUsdc && !terms.amountRaw) || !terms.ownershipShare
      || (terms.amountRaw && (!terms.tokenId || terms.amountUsdc))
      || (!terms.amountRaw && terms.tokenId))) {
    throw institutionError('INVESTMENT_TERMS_REQUIRED', 400);
  }
  if (type === 'partnership' && (!terms.businessId || !terms.sellerAgentId || !terms.buyerAgentId || !terms.ownershipShare)) {
    throw institutionError('PARTNERSHIP_TERMS_REQUIRED', 400);
  }
  if (type === 'partnership' && terms.sellerAgentId === terms.buyerAgentId) {
    throw institutionError('PARTNERSHIP_REQUIRES_TWO_OWNERS', 400);
  }
  if (type === 'partnership' && !terms.gift && !terms.priceUsdc) throw institutionError('PARTNERSHIP_PRICE_REQUIRED', 400);
  if (type === 'revenue_sharing' && (!terms.businessId || !terms.recipientAgentId || !terms.shareBps)) {
    throw institutionError('REVENUE_SHARE_TERMS_REQUIRED', 400);
  }
  if (type === 'supplier_relationship' && (!terms.businessId || !terms.serviceId || !terms.priceUsdc)) {
    throw institutionError('SUPPLIER_TERMS_REQUIRED', 400);
  }
  if (type === 'service' && (!terms.businessId || !terms.serviceId || !terms.priceUsdc)) {
    throw institutionError('SERVICE_TERMS_REQUIRED', 400);
  }
  if (type === 'project_cooperation' && !terms.projectId) throw institutionError('PROJECT_ID_REQUIRED', 400);
  if (type === 'organization_membership' && !terms.organizationId) throw institutionError('ORGANIZATION_ID_REQUIRED', 400);
  if (type === 'resource_sharing' && (!terms.recipientAgentId || !terms.resourceKey || !terms.amount)) {
    throw institutionError('RESOURCE_TERMS_REQUIRED', 400);
  }
  return terms;
}

export function reservationValue({ agreementType, side, terms = {}, resident = {}, relationship = {}, alternatives = {} } = {}) {
  const wealth = Math.max(0, Number(resident.wealth ?? resident.usdc) || 0);
  const foodUrgency = (100 - clamp(resident.food, 0, 100)) / 100;
  const energyUrgency = (100 - clamp(resident.energy, 0, 100)) / 100;
  const socialUrgency = (100 - clamp(resident.social, 0, 100)) / 100;
  const needs = (foodUrgency + energyUrgency + socialUrgency) / 3;
  const skill = Math.max(0, Number(resident.skill ?? Math.max(...Object.values(resident.skills || {}).map((value) => Number(value) || 0))) || 0) / 100;
  const trust = clamp(Number(relationship.trust) || 0, -100, 100) / 100;
  const reliability = clamp(Number(resident.reliability) || 0, -100, 100) / 100;
  const alternativeCount = Math.max(0, Number(alternatives.count) || 0);
  const risk = clamp(resident.riskTolerance ?? 0.5, 0, 1);
  const amount = Number(terms.wageUsdc ?? terms.priceUsdc ?? terms.amountUsdc ?? terms.amount ?? 0);
  const fallback = Math.max(1, Number(alternatives.referenceValue) || 1);
  if (agreementType === 'employment') {
    if (side === 'worker') {
      const minimum = fallback * clamp(0.54 + needs * 0.34 + skill * 0.20 - alternativeCount * 0.035
        - trust * 0.06 + risk * 0.04, 0.35, 1.45);
      return { threshold: round4(minimum), offer: round4(amount), acceptable: amount >= minimum,
        rationale: 'need_skill_relationship_and_alternatives' };
    }
    const cash = Math.max(0, Number(resident.businessCash ?? wealth) || 0);
    const payrollCap = cash / 8;
    const maxWage = Math.min(fallback * clamp(1 + skill * 0.25 + reliability * 0.10, 0.85, 1.35), payrollCap);
    return { threshold: round4(maxWage), offer: round4(amount), acceptable: amount <= maxWage,
      rationale: 'cash_skill_and_reliability' };
  }
  if (agreementType === 'service' || agreementType === 'supplier_relationship') {
    if (side === 'provider') {
      const minimum = fallback * clamp(0.82 + risk * 0.12 - trust * 0.08 - reliability * 0.04, 0.65, 1.15);
      return { threshold: round4(minimum), offer: round4(amount), acceptable: amount >= minimum,
        rationale: 'cost_reputation_and_relationship' };
    }
    const maximum = fallback * clamp(1.25 - needs * 0.35 - wealth / 100_000 + trust * 0.08, 0.55, 1.4);
    return { threshold: round4(maximum), offer: round4(amount), acceptable: amount <= maximum,
      rationale: 'needs_wealth_and_relationship' };
  }
  if (agreementType === 'partnership' || agreementType === 'investment') {
    const minimumShare = clamp(0.06 + (1 - reliability) * 0.12 + (1 - trust) * 0.08 + risk * 0.05, 0.03, 0.35);
    if (side === 'business_owner' || side === 'seller') {
      const minimumPrice = fallback * Number(terms.ownershipShare || 0)
        * clamp(0.8 + risk * 0.2 + reliability * 0.12, 0.65, 1.25);
      return { threshold: round4(minimumPrice), offer: round4(Number(terms.priceUsdc) || amount),
        acceptable: Number(terms.priceUsdc) >= minimumPrice, rationale: 'asset_value_and_trust' };
    }
    const budgetRatio = clamp(0.2 + risk * 0.35 + Math.max(-0.2, trust) * 0.15, 0.05, 0.7);
    const priceLimit = Math.min(wealth, wealth * budgetRatio);
    const investmentLimit = wealth * clamp(0.1 + risk * 0.4 + Math.max(-0.2, trust) * 0.15, 0.05, 0.75);
    const financialOffer = agreementType === 'investment' ? Number(terms.amountUsdc) || amount
      : Number(terms.priceUsdc) || 0;
    const financialLimit = agreementType === 'investment' ? investmentLimit : priceLimit;
    return { threshold: round4(minimumShare), offer: round4(Number(terms.ownershipShare) || 0),
      acceptable: Number(terms.ownershipShare) >= minimumShare && financialOffer <= financialLimit,
      financialLimit: round4(financialLimit), rationale: 'risk_reliability_and_trust_and_affordability' };
  }
  return { threshold: round4(0.5 + needs * 0.1), offer: round4(amount), acceptable: true,
    rationale: 'needs_and_commitment_capacity' };
}

async function insertParticipants(client, agreement, worldTime, response = 'pending') {
  await client.query(`INSERT INTO world_agreement_participants(agreement_id,world_id,agent_id,role,response,responded_world_time)
    VALUES($1,$2,$3,'proposer','accepted',$4),($1,$2,$5,'counterparty',$6,$7) ON CONFLICT DO NOTHING`,
  [agreement.id, agreement.world_id, agreement.proposer_agent_id, worldTime, agreement.counterparty_agent_id,
    response, response === 'pending' ? null : worldTime]);
}

export async function createSystemEmploymentAgreement(client, { worldId, employmentId, businessId, jobId,
  founderAgentId, employeeAgentId, wageUsdc, role, worldTime }) {
  const actionId = `v5:employment:${employmentId}`;
  const inserted = await client.query(`INSERT INTO world_agreements(world_id,agreement_type,proposer_agent_id,
      counterparty_agent_id,terms,status,action_id,created_world_time,accepted_world_time,activated_world_time,updated_world_time,
      metadata)
    VALUES($1,'employment',$2,$3,$4::jsonb,'active',$5,$6,$6,$6,$6,'{"formedBy":"mutual_application_and_employer_acceptance"}'::jsonb)
    ON CONFLICT(world_id,proposer_agent_id,action_id) DO UPDATE SET updated_at=world_agreements.updated_at RETURNING *`,
  [worldId, founderAgentId, employeeAgentId, JSON.stringify({ employmentId, businessId, jobId,
    wageUsdc: String(wageUsdc), role: String(role || 'employee') }), actionId, worldTime]);
  const agreement = inserted.rows[0];
  await insertParticipants(client, agreement, worldTime, 'accepted');
  await writeWorldHistory(client, { worldId, eventKey: `agreement:${agreement.id}:formed`, eventType: 'agreement_accepted',
    actorAgentId: founderAgentId, entityType: 'agreement', entityId: agreement.id, worldTime,
    title: 'Employment terms accepted', detail: `A completed application and employer acceptance formed an employment agreement at ${agreement.terms.wageUsdc} simulated USDC per shift.`,
    metadata: { agreementType: 'employment', employmentId, businessId, jobId, wageUsdc: String(wageUsdc) } });
  return agreement;
}

export async function proposeWorldAgreement(client, { worldId, proposerAgentId, counterpartyAgentId, agreementType, terms,
  actionId, worldTime, expiresInWorldMinutes = 1_440, parentAgreementId = null }) {
  await requireWorldMember(client, worldId, proposerAgentId);
  await requireWorldMember(client, worldId, counterpartyAgentId);
  if (proposerAgentId === counterpartyAgentId) throw institutionError('AGREEMENT_REQUIRES_TWO_RESIDENTS', 400);
  const key = actionIdentifier(actionId);
  const kind = String(agreementType || '').toLowerCase();
  const normalized = normalizeTerms(kind, terms);
  const genesisCurrency = await readGenesisCurrencyActivation(client, worldId);
  if (genesisCurrency
      && !(['project_cooperation','organization_membership'].includes(kind)
        || (kind === 'resource_sharing' && normalized.resourceKey === 'effort')
        || (kind === 'investment' && normalized.amountRaw && normalized.tokenId === genesisCurrency.tokenId))) {
    throw institutionError('LEGACY_SIMULATED_ECONOMY_RETIRED', 409);
  }
  const duration = Math.trunc(boundedNumber(expiresInWorldMinutes, 1, 43_200, 'agreement_expiry'));
  const repeated = await client.query(`SELECT * FROM world_agreements WHERE world_id=$1 AND proposer_agent_id=$2 AND action_id=$3`,
    [worldId, proposerAgentId, key]);
  if (repeated.rowCount) return { ...repeated.rows[0], idempotent: true };
  const workload = await client.query(`SELECT count(*)::int AS count FROM world_agreements
    WHERE world_id=$1 AND status IN ('proposed','accepted','active') AND
      (proposer_agent_id IN ($2,$3) OR counterparty_agent_id IN ($2,$3))`, [worldId, proposerAgentId, counterpartyAgentId]);
  if (Number(workload.rows[0].count) >= 40) throw institutionError('AGREEMENT_PARTICIPANT_CAPACITY_REACHED');
  const parent = parentAgreementId ? await client.query(`SELECT * FROM world_agreements WHERE world_id=$1 AND id=$2 FOR UPDATE`,
  [worldId, parentAgreementId]) : null;
  let round = 1;
  let activeRenegotiation = false;
  if (parentAgreementId) {
    if (!parent?.rowCount || !['proposed','active'].includes(parent.rows[0].status) || parent.rows[0].agreement_type !== kind
        || parent.rows[0].negotiation_round >= 8) throw institutionError('AGREEMENT_COUNTER_NOT_AVAILABLE');
    const original = parent.rows[0];
    if (!((proposerAgentId === original.counterparty_agent_id && counterpartyAgentId === original.proposer_agent_id)
        || (proposerAgentId === original.proposer_agent_id && counterpartyAgentId === original.counterparty_agent_id))) {
      throw institutionError('AGREEMENT_COUNTER_PARTIES_INVALID', 403);
    }
    activeRenegotiation = original.status === 'active';
    if (activeRenegotiation) {
      const oldTerms = original.terms || {};
      if (!['service','supplier_relationship'].includes(kind)
          || normalized.businessId !== oldTerms.businessId || normalized.serviceId !== oldTerms.serviceId
          || (oldTerms.customerAgentId && normalized.customerAgentId
            && normalized.customerAgentId !== oldTerms.customerAgentId)) {
        throw institutionError('AGREEMENT_RENEGOTIATION_SCOPE_INVALID', 400);
      }
      if (original.metadata?.renegotiationPending) throw institutionError('AGREEMENT_RENEGOTIATION_PENDING');
    }
    const previousCounter = await client.query(`SELECT max(created_world_time)::bigint AS last_time FROM world_agreements
      WHERE world_id=$1 AND parent_agreement_id=$2`, [worldId, parentAgreementId]);
    const lastCounterAt = Math.max(Number(original.created_world_time), Number(previousCounter.rows[0]?.last_time) || 0);
    if (worldTime - lastCounterAt < 10) throw institutionError('AGREEMENT_COUNTER_COOLDOWN');
    round = Number(parent.rows[0].negotiation_round) + 1;
  }
  const inserted = await client.query(`INSERT INTO world_agreements(world_id,agreement_type,proposer_agent_id,counterparty_agent_id,
      terms,status,parent_agreement_id,negotiation_round,action_id,created_world_time,expires_world_time,updated_world_time,metadata)
    VALUES($1,$2,$3,$4,$5::jsonb,'proposed',$6,$7,$8,$9,$10,$9,$11::jsonb) RETURNING *`,
  [worldId, kind, proposerAgentId, counterpartyAgentId, JSON.stringify(normalized), parentAgreementId, round, key, worldTime,
    worldTime + duration, JSON.stringify({ source: activeRenegotiation ? 'renegotiation'
      : parentAgreementId ? 'counter_offer' : 'resident_proposal',
    ...(activeRenegotiation ? { renegotiates: parentAgreementId } : {}) })]);
  const agreement = inserted.rows[0];
  await insertParticipants(client, agreement, worldTime);
  if (parentAgreementId) {
    const original = parent.rows[0];
    if (activeRenegotiation) {
      await client.query(`UPDATE world_agreements SET metadata=metadata||'{"renegotiationPending":true}'::jsonb,
          updated_world_time=$3,updated_at=now() WHERE world_id=$1 AND id=$2 AND status='active'`,
      [worldId, parentAgreementId, worldTime]);
      await writeWorldHistory(client, { worldId, eventKey: `agreement:${agreement.id}:renegotiation-proposed`,
        eventType: 'agreement_renegotiation_proposed', actorAgentId: proposerAgentId, entityType: 'agreement',
        entityId: agreement.id, worldTime, title: 'Supplier terms proposed for renegotiation',
        detail: 'A resident proposed revised timing or capacity terms for an active supplier agreement.',
        metadata: { agreementType: kind, parentAgreementId, round } });
    } else {
      await client.query(`UPDATE world_agreements SET status='countered',updated_world_time=$3,updated_at=now(),
          metadata=metadata||$4::jsonb WHERE world_id=$1 AND id=$2`,
      [worldId, parentAgreementId, worldTime, JSON.stringify({ responseActionId: key, counteredBy: proposerAgentId })]);
      await client.query(`UPDATE world_agreement_participants SET response='countered',responded_world_time=$3
        WHERE agreement_id=$1 AND agent_id=$2`, [parentAgreementId, original.counterparty_agent_id, worldTime]);
      await writeWorldHistory(client, { worldId, eventKey: `agreement:${agreement.id}:countered`, eventType: 'agreement_countered',
        actorAgentId: proposerAgentId, entityType: 'agreement', entityId: agreement.id, worldTime,
        title: 'Agreement counter-offer proposed', detail: `A resident countered round ${round - 1} with changed terms.`,
        metadata: { agreementType: kind, parentAgreementId, round } });
    }
  } else {
    await writeWorldHistory(client, { worldId, eventKey: `agreement:${agreement.id}:proposed`, eventType: 'agreement_proposed',
      actorAgentId: proposerAgentId, entityType: 'agreement', entityId: agreement.id, worldTime,
      title: `${kind.replaceAll('_',' ')} terms proposed`, detail: 'A resident proposed bounded agreement terms for another resident to review.',
      metadata: { agreementType: kind, counterpartyAgentId, expiresWorldTime: worldTime + duration } });
  }
  return agreement;
}

export async function proposeGenesisTokenBusinessInvestment(client, { worldId, investorAgentId, businessId,
  amountRaw, ownershipShare, actionId, worldTime }) {
  const activation = await readGenesisCurrencyActivation(client, worldId, { forUpdate: true });
  if (!activation) throw institutionError('GENESIS_CURRENCY_NOT_ACTIVE');
  const business = await client.query(`SELECT founder_agent_id AS "founderAgentId",status,name
    FROM world_businesses WHERE world_id=$1 AND id=$2`, [worldId, businessId]);
  if (!business.rowCount || business.rows[0].status !== 'active') throw institutionError('BUSINESS_NOT_ACTIVE', 404);
  if (business.rows[0].founderAgentId === investorAgentId) throw institutionError('BUSINESS_OWNER_CANNOT_INVEST_IN_SELF', 400);
  const rawText = typeof amountRaw === 'string' ? amountRaw : String(amountRaw ?? '');
  if (!/^[1-9]\d*$/.test(rawText) || BigInt(rawText) > (1n << 128n) - 1n) {
    throw institutionError('GENESIS_TOKEN_INVESTMENT_AMOUNT_INVALID', 400);
  }
  const share = boundedNumber(ownershipShare, 0.0001, 0.95, 'ownership_share');
  const agreement = await proposeWorldAgreement(client, { worldId, proposerAgentId: investorAgentId,
    counterpartyAgentId: business.rows[0].founderAgentId, agreementType: 'investment',
    terms: { businessId, amountRaw: rawText, tokenId: activation.tokenId, ownershipShare: share },
    actionId, worldTime, expiresInWorldMinutes: 4_320 });
  return { agreementId: agreement.id, businessId, businessName: business.rows[0].name,
    tokenId: activation.tokenId, amountRaw: rawText, ownershipShare: share,
    status: agreement.status, settlement: 'awaiting_founder_acceptance_and_arc_confirmation',
    tokenOwnershipAuthority: 'arc_chain_confirmation', idempotent: Boolean(agreement.idempotent) };
}

async function updateAgentReputation(client, { worldId, agentId, otherAgentId, dimension, delta, worldTime, outcome,
  agreementId, actionId }) {
  const field = ({ reliability: 'reliability', professional: 'professional', financial: 'financial', cooperation: 'cooperation' })[dimension];
  if (!field) return;
  await client.query(`INSERT INTO world_agent_reputations(world_id,agent_id,${field},fulfilled_count,breach_count,updated_world_time)
    VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(world_id,agent_id) DO UPDATE SET
      ${field}=GREATEST(-100,LEAST(100,world_agent_reputations.${field}+$3)),
      fulfilled_count=world_agent_reputations.fulfilled_count+$4,breach_count=world_agent_reputations.breach_count+$5,
      updated_world_time=EXCLUDED.updated_world_time,updated_at=now()`,
  [worldId, agentId, delta, outcome === 'fulfilled' ? 1 : 0, outcome === 'breached' ? 1 : 0, worldTime]);
  if (otherAgentId) {
    const estimate = outcome === 'fulfilled' ? 1 : outcome === 'unable' ? -0.15 : -0.65;
    await client.query(`INSERT INTO world_agent_beliefs(world_id,agent_id,subject_type,subject_key,belief_key,estimate,
        confidence,sample_count,updated_world_minutes,evidence)
      VALUES($1,$2,'resident',$3,'contract_reliability',$4,0.25,1,$5,$6::jsonb)
      ON CONFLICT(world_id,agent_id,subject_type,subject_key,belief_key) DO UPDATE SET
        estimate=(world_agent_beliefs.estimate*world_agent_beliefs.sample_count+EXCLUDED.estimate)
          /(world_agent_beliefs.sample_count+1),
        confidence=LEAST(0.98,(world_agent_beliefs.sample_count+1)*0.08),
        sample_count=world_agent_beliefs.sample_count+1,updated_world_minutes=EXCLUDED.updated_world_minutes,
        evidence=EXCLUDED.evidence`, [worldId, otherAgentId, agentId, estimate, worldTime,
      JSON.stringify({ agreementId, outcome, sourceActionId: actionId })]);
  }
}

async function recordInstitutionalMemory(client, { worldId, institutionType, institutionId, memoryType, summary, worldTime, metadata = {} }) {
  if (!institutionType || !institutionId) return;
  await client.query(`INSERT INTO world_institutional_memories(world_id,institution_type,institution_id,memory_type,summary,
      world_time,metadata) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)
    ON CONFLICT(world_id,institution_type,institution_id,memory_type,summary) DO UPDATE SET
      evidence_count=world_institutional_memories.evidence_count+1,world_time=EXCLUDED.world_time,metadata=EXCLUDED.metadata`,
  [worldId, institutionType, institutionId, memoryType, summary.slice(0, 240), worldTime, JSON.stringify(metadata)]);
  await client.query(`DELETE FROM world_institutional_memories WHERE id IN (SELECT id FROM world_institutional_memories
    WHERE world_id=$1 AND institution_type=$2 AND institution_id=$3 ORDER BY world_time DESC,id DESC OFFSET 100)`,
  [worldId, institutionType, institutionId]);
}

async function recordInstitutionalBelief(client, { worldId, institutionType, institutionId, subjectAgentId, outcome,
  agreementId, actionId, worldTime }) {
  if (!institutionType || !institutionId || !subjectAgentId) return;
  const estimate = outcome === 'fulfilled' ? 0.8 : outcome === 'unable' ? -0.15 : -0.9;
  await client.query(`INSERT INTO world_institutional_beliefs(world_id,institution_type,institution_id,belief_key,
      subject_type,subject_key,estimate,confidence,sample_count,updated_world_time,evidence)
    VALUES($1,$2,$3,'counterparty_reliability','resident',$4,$5,0.08,1,$6,$7::jsonb)
    ON CONFLICT(world_id,institution_type,institution_id,belief_key,subject_type,subject_key) DO UPDATE SET
      estimate=(world_institutional_beliefs.estimate*world_institutional_beliefs.sample_count+EXCLUDED.estimate)
        /(world_institutional_beliefs.sample_count+1),
      confidence=LEAST(0.98,(world_institutional_beliefs.sample_count+1)*0.08),
      sample_count=world_institutional_beliefs.sample_count+1,updated_world_time=EXCLUDED.updated_world_time,
      evidence=EXCLUDED.evidence,updated_at=now()`, [worldId, institutionType, institutionId, subjectAgentId,
    estimate, worldTime, JSON.stringify({ agreementId, outcome, sourceActionId: actionId })]);
}

async function recordAgreementOutcome(client, { worldId, agreementId, worldTime, outcome, reason = null, actionId,
  responsibleAgentId = null, reputationScale = 1 }) {
  const agreement = await client.query(`SELECT * FROM world_agreements WHERE world_id=$1 AND id=$2 FOR UPDATE`, [worldId, agreementId]);
  if (!agreement.rowCount) return false;
  const row = agreement.rows[0];
  const positive = outcome === 'fulfilled';
  const incapable = outcome === 'unable';
  const repeatedDelivery = row.agreement_type === 'supplier_relationship';
  const reputationDelta = (positive ? repeatedDelivery ? 0.08 : 0.6 : incapable ? -0.15 : -1.2) * reputationScale;
  const dimension = row.agreement_type === 'investment' || row.agreement_type === 'revenue_sharing' ? 'financial'
    : row.agreement_type === 'employment' || row.agreement_type === 'service' ? 'professional' : 'cooperation';
  const affected = responsibleAgentId ? [responsibleAgentId]
    : positive ? [row.proposer_agent_id, row.counterparty_agent_id] : [row.counterparty_agent_id];
  const supplierContext = row.agreement_type === 'supplier_relationship' || row.agreement_type === 'service'
    ? await client.query(`SELECT business.founder_agent_id AS provider_id,business.name AS business_name,
        service.name AS service_name,service.service_type
      FROM world_businesses business LEFT JOIN world_business_services service
        ON service.world_id=business.world_id AND service.id=$3
      WHERE business.world_id=$1 AND business.id=$2`,
    [worldId, row.terms.businessId, row.terms.serviceId]) : { rows: [] };
  const supplier = supplierContext.rows[0] || null;
  const institutionalType = row.terms.businessId ? 'business'
    : row.terms.organizationId ? 'organization' : null;
  const institutionalId = row.terms.businessId || row.terms.organizationId || null;
  for (const agentId of affected) {
    if (![row.proposer_agent_id, row.counterparty_agent_id].includes(agentId)) continue;
    const otherId = agentId === row.proposer_agent_id ? row.counterparty_agent_id : row.proposer_agent_id;
    const outcomeKey = `v5-outcome:${String(actionId).slice(0, 130)}:${agentId}`;
    const inserted = await client.query(`INSERT INTO world_agreement_outcomes(world_id,agreement_id,agent_id,counterparty_agent_id,
        outcome,reason,action_id,world_time,evidence)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) ON CONFLICT(world_id,agent_id,action_id) DO NOTHING RETURNING id`,
    [worldId, agreementId, agentId, otherId, outcome, reason, outcomeKey, worldTime,
      JSON.stringify({ agreementType: row.agreement_type, sourceActionId: actionId,
        serviceType: supplier?.service_type || null, businessId: row.terms.businessId || null,
        serviceId: row.terms.serviceId || null })]);
    if (!inserted.rowCount) continue;
    await updateAgentReputation(client, { worldId, agentId, otherAgentId: otherId, dimension, delta: reputationDelta,
      worldTime, outcome: positive ? 'fulfilled' : incapable ? 'unable' : 'breached', agreementId, actionId: outcomeKey });
    await recordInstitutionalBelief(client, { worldId, institutionType: institutionalType, institutionId: institutionalId,
      subjectAgentId: agentId, outcome, agreementId, actionId: outcomeKey, worldTime });
    if (dimension !== 'reliability') {
      await client.query(`UPDATE world_agent_reputations SET reliability=GREATEST(-100,LEAST(100,reliability+$3)),
          updated_world_time=$4,updated_at=now() WHERE world_id=$1 AND agent_id=$2`,
      [worldId, agentId, reputationDelta * 0.5, worldTime]);
    }
    const scopeType = row.terms.businessId ? 'business' : row.terms.organizationId ? 'organization' : 'world';
    const scopeId = row.terms.businessId || row.terms.organizationId || worldId;
    const normKey = `${row.agreement_type}:honor_terms`;
    if (positive || !incapable) {
      const norm = await client.query(`INSERT INTO world_social_norms(world_id,scope_type,scope_id,norm_key,behavior,confidence,
          support_count,violation_count,created_world_time,updated_world_time,source_type,metadata)
        VALUES($1,$2,$3,$4,$5,0.1,$6,$7,$8,$8,'agreement',$9::jsonb)
        ON CONFLICT(world_id,scope_type,scope_id,norm_key) DO UPDATE SET
          support_count=world_social_norms.support_count+$6,violation_count=world_social_norms.violation_count+$7,
          confidence=LEAST(0.95,(world_social_norms.support_count+$6+1)::numeric /
            (world_social_norms.support_count+world_social_norms.violation_count+$6+$7+4)),
          updated_world_time=EXCLUDED.updated_world_time,updated_at=now()
        RETURNING id,support_count`, [worldId, scopeType, scopeId, normKey,
        row.agreement_type === 'employment'
          ? 'Complete recorded production shifts under agreed wage terms before settling wages.'
          : `Members of this ${scopeType} repeatedly honor ${row.agreement_type.replaceAll('_',' ')} terms and account for inability or breach.`,
        positive ? 1 : 0, positive ? 0 : 1, worldTime, JSON.stringify({ agreementId, outcome })]);
      const count = Number(norm.rows[0]?.support_count);
      if (count === 3 && positive) await writeWorldHistory(client, { worldId,
        eventKey: `norm:${norm.rows[0].id}:formed`, eventType: 'norm_formed', actorAgentId: agentId,
        entityType: 'norm', entityId: norm.rows[0].id, worldTime, title: 'A repeated agreement practice became a norm',
        detail: `Three successful ${row.agreement_type.replaceAll('_',' ')} outcomes support a shared practice.`,
        metadata: { normKey, scopeType, scopeId, supportCount: count, sourceAgreementId: agreementId } });
    }
    const templateCount = await client.query(`SELECT count(DISTINCT agreement_id)::int AS count
      FROM world_agreement_outcomes WHERE world_id=$1 AND outcome='fulfilled' AND agreement_id IN (
        SELECT id FROM world_agreements WHERE world_id=$1 AND agreement_type=$2
          AND COALESCE(terms->>'businessId',terms->>'organizationId',$1::text)=$3)`,
    [worldId, row.agreement_type, scopeId]);
    if (Number(templateCount.rows[0]?.count) >= 3 && positive) {
      await client.query(`INSERT INTO world_agreement_templates(world_id,scope_type,scope_id,agreement_type,template_key,terms,
          sample_count,success_count,created_world_time,updated_world_time)
        VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$7,$8,$8)
        ON CONFLICT(world_id,scope_type,scope_id,agreement_type,template_key) DO UPDATE SET
          terms=EXCLUDED.terms,sample_count=greatest(world_agreement_templates.sample_count,EXCLUDED.sample_count),
          success_count=greatest(world_agreement_templates.success_count,EXCLUDED.success_count),
          updated_world_time=EXCLUDED.updated_world_time,updated_at=now()`,
      [worldId, scopeType, scopeId, row.agreement_type, `${row.agreement_type}-repeated-v1`, JSON.stringify(row.terms),
        Number(templateCount.rows[0].count), worldTime]);
    }
  }
  const participants = [row.proposer_agent_id, row.counterparty_agent_id];
  for (const agentId of participants) {
    const otherId = agentId === row.proposer_agent_id ? row.counterparty_agent_id : row.proposer_agent_id;
    const providerId = supplier?.provider_id || null;
    const supplierRole = providerId ? (agentId === providerId ? 'provider' : 'customer') : null;
    let summary;
    if (supplierRole === 'provider') {
      summary = positive ? `Delivered ${supplier.service_name || 'a service'} under a supplier agreement${supplier.business_name ? ` for ${supplier.business_name}` : ''}.`
        : incapable ? `Could not deliver ${supplier.service_name || 'a service'} under a supplier agreement${reason ? ` (${reason})` : ''}.`
          : `Failed to deliver ${supplier.service_name || 'a service'} under a supplier agreement${reason ? ` (${reason})` : ''}.`;
    } else if (supplierRole === 'customer') {
      summary = positive ? `Received ${supplier.service_name || 'a service'} from supplier ${supplier.business_name || 'business'} as agreed.`
        : incapable ? `Supplier ${supplier.business_name || 'business'} could not deliver ${supplier.service_name || 'the service'}.`
          : `Supplier ${supplier.business_name || 'business'} failed to deliver ${supplier.service_name || 'the service'}${reason ? ` (${reason})` : ''}.`;
    } else {
      summary = positive ? `Completed the ${row.agreement_type.replaceAll('_',' ')} agreement as promised.`
        : incapable ? `Declared an inability to fulfill a ${row.agreement_type.replaceAll('_',' ')} agreement.`
          : `Did not fulfill a ${row.agreement_type.replaceAll('_',' ')} agreement (${reason || 'unfulfilled obligation'}).`;
    }
    const memoryKey = `contract:${agreementId}:${String(actionId).slice(0, 90)}:${outcome}`;
    await client.query(`INSERT INTO agent_memories(world_id,agent_id,memory_type,summary,importance,world_minutes,
        related_agent_id,metadata,long_term,consolidation_key)
      VALUES($1,$2,'contract',$3,$4,$5,$6,$7::jsonb,$8,$9)
      ON CONFLICT(world_id,agent_id,consolidation_key) WHERE consolidation_key IS NOT NULL DO NOTHING`,
    [worldId, agentId, summary.slice(0, 240), positive ? 0.68 : 0.76, worldTime, otherId,
      JSON.stringify({ agreementId, agreementType: row.agreement_type, outcome, reason, actionId,
        role: supplierRole, businessId: row.terms.businessId || null, serviceId: row.terms.serviceId || null,
        serviceType: supplier?.service_type || null }), reputationScale >= 1, memoryKey]);
  }
  await recordInstitutionalMemory(client, { worldId, institutionType: institutionalType, institutionId: institutionalId,
    memoryType: positive ? 'agreement_success' : 'agreement_failure', worldTime,
    summary: positive ? `A ${row.agreement_type.replaceAll('_',' ')} agreement was fulfilled.`
      : `A ${row.agreement_type.replaceAll('_',' ')} obligation ended as ${outcome}.`,
    metadata: { agreementId, reason, outcome } });
  return true;
}

export async function recordAgreementExecutionStage(client, { worldId, agreementId, stage, worldTime,
  reasonCode = null, agentId = null, eventKey, details = {} }) {
  const agreement = await client.query(`SELECT agreement_type,terms FROM world_agreements WHERE world_id=$1 AND id=$2`,
    [worldId, agreementId]);
  if (!agreement.rowCount) return false;
  const key = String(eventKey || `${stage}:${worldTime}`).replace(/[^a-zA-Z0-9:_-]/g, '_').slice(0, 160);
  const executionState = { stage, worldTime, reasonCode, ...details };
  await client.query(`UPDATE world_agreements SET metadata=metadata||jsonb_build_object('executionState',
      COALESCE(metadata->'executionState','{}'::jsonb)||$3::jsonb),updated_world_time=GREATEST(updated_world_time,$4),updated_at=now()
    WHERE world_id=$1 AND id=$2`, [worldId, agreementId, JSON.stringify(executionState), worldTime]);
  await writeWorldHistory(client, { worldId, eventKey: `agreement-execution:${agreementId}:${key}`,
    eventType: `agreement_${stage}`, actorAgentId: agentId, entityType: 'agreement', entityId: agreementId,
    worldTime, title: `Agreement ${stage.replaceAll('_',' ')}`,
    detail: reasonCode ? `${stage.replaceAll('_',' ')}; blocker or outcome: ${reasonCode}.`
      : `${stage.replaceAll('_',' ')} for ${agreement.rows[0].agreement_type.replaceAll('_',' ')}.`,
    metadata: { agreementType: agreement.rows[0].agreement_type, reasonCode, ...details } });
  return true;
}

async function enqueueSupplierDeliveryCommitment(client, { agreement, worldTime }) {
  const row = agreement;
  if (!['service','supplier_relationship'].includes(row.agreement_type) || row.status !== 'active') return null;
  const terms = row.terms || {};
  const business = await client.query(`SELECT business.founder_agent_id,service.active
    FROM world_businesses business JOIN world_business_services service
      ON service.world_id=business.world_id AND service.business_id=business.id
    WHERE business.world_id=$1 AND business.id=$2 AND service.id=$3`,
  [row.world_id, terms.businessId, terms.serviceId]);
  if (!business.rowCount) return null;
  const providerId = business.rows[0].founder_agent_id;
  const customerId = terms.customerAgentId
    || (providerId === row.proposer_agent_id ? row.counterparty_agent_id : row.proposer_agent_id);
  const maxUnits = agreementUnitLimit(terms);
  const delivered = await client.query(`SELECT count(*)::int AS count FROM world_commitments
    WHERE world_id=$1 AND agreement_id=$2 AND commitment_type='service' AND status='fulfilled'`, [row.world_id, row.id]);
  const unitNumber = Number(delivered.rows[0]?.count || 0) + 1;
  if (unitNumber > maxUnits) {
    await client.query(`UPDATE world_agreements SET status='completed',completed_world_time=$3,updated_world_time=$3,
        metadata=metadata||jsonb_build_object('completionReason','max_units_delivered'),updated_at=now()
      WHERE world_id=$1 AND id=$2 AND status='active'`, [row.world_id, row.id, worldTime]);
    await recordAgreementExecutionStage(client, { worldId: row.world_id, agreementId: row.id,
      stage: 'completed', worldTime, eventKey: `max-units:${maxUnits}`, details: { deliveredUnits: unitNumber - 1, maxUnits } });
    return null;
  }
  const active = await client.query(`SELECT * FROM world_commitments WHERE world_id=$1 AND agreement_id=$2
    AND commitment_type='delivery' AND status='active' ORDER BY due_world_time,id LIMIT 1`, [row.world_id, row.id]);
  if (active.rowCount) return active.rows[0];
  if (!business.rows[0].active || !UUID_RE.test(String(customerId))) return null;
  const actionId = `v51-supplier-delivery:${row.id}:${unitNumber}`;
  const inserted = await client.query(`INSERT INTO world_commitments(world_id,agreement_id,agent_id,counterparty_agent_id,
      commitment_type,description,due_world_time,action_id,metadata)
    VALUES($1,$2,$3,$4,'delivery',$5,$6,$7,$8::jsonb)
    ON CONFLICT(world_id,agent_id,action_id) DO NOTHING RETURNING *`,
  [row.world_id, row.id, providerId, customerId,
    `Make one contracted ${terms.serviceName || 'service'} unit available to the customer.`,
    worldTime + Math.max(60, Math.min(43_200, Number(terms.deliveryDelayWorldMinutes) || 4_320)), actionId,
    JSON.stringify({ businessId: terms.businessId, serviceId: terms.serviceId, customerAgentId: customerId,
      unitNumber, maxUnits, priceUsdc: terms.priceUsdc })]);
  const commitment = inserted.rows[0] || (await client.query(`SELECT * FROM world_commitments
    WHERE world_id=$1 AND agent_id=$2 AND action_id=$3`, [row.world_id, providerId, actionId])).rows[0];
  if (inserted.rowCount) await recordAgreementExecutionStage(client, { worldId: row.world_id,
    agreementId: row.id, stage: 'commitment_created', worldTime, agentId: providerId,
    eventKey: `commitment:${commitment.id}`, details: { commitmentId: commitment.id, unitNumber, maxUnits,
      businessId: terms.businessId, serviceId: terms.serviceId, providerId, customerId } });
  return commitment;
}

export async function resolveEmploymentAgreementOnExit(client, { worldId, employmentId, agentId, reason, worldTime,
  commitmentOutcomeReason = 'voluntary_exit' }) {
  const agreement = await client.query(`SELECT id,proposer_agent_id,counterparty_agent_id FROM world_agreements
    WHERE world_id=$1 AND agreement_type='employment' AND status='active' AND terms->>'employmentId'=$2 FOR UPDATE`,
  [worldId, employmentId]);
  for (const row of agreement.rows) {
    await client.query(`UPDATE world_agreements SET status='cancelled',updated_world_time=$3,
        metadata=metadata||$4::jsonb,updated_at=now() WHERE world_id=$1 AND id=$2 AND status='active'`,
    [worldId, row.id, worldTime, JSON.stringify({ resolution: { reason, actorAgentId: agentId, worldTime } })]);
    await client.query(`UPDATE world_commitments SET status='cancelled',outcome_reason=$4,
        completed_world_time=$3,updated_at=now(),metadata=metadata||$5::jsonb
      WHERE world_id=$1 AND agreement_id=$2 AND status='active'`,
    [worldId, row.id, worldTime, commitmentOutcomeReason, JSON.stringify({ resolution: reason })]);
    await recordAgreementExecutionStage(client, { worldId, agreementId: row.id, stage: 'cancelled', worldTime,
      agentId, eventKey: `employment-exit:${employmentId}:${reason}`, reasonCode: 'EMPLOYMENT_ENDED',
      details: { employmentId, reason } });
  }
}

export async function resolveBusinessAgreementsOnClosure(client, { worldId, businessId, founderAgentId,
  worldTime, bankrupt = false }) {
  const agreements = await client.query(`SELECT * FROM world_agreements WHERE world_id=$1 AND status='active'
      AND terms->>'businessId'=$2::text ORDER BY id FOR UPDATE`, [worldId, businessId]);
  for (const agreement of agreements.rows) {
    const supplierContract = ['supplier_relationship','service'].includes(agreement.agreement_type);
    const reason = bankrupt ? 'unable_to_fulfill' : 'voluntary_exit';
    const nextStatus = supplierContract ? 'breached' : 'cancelled';
    await client.query(`UPDATE world_commitments SET status=$3,outcome_reason=$4,completed_world_time=$5,updated_at=now(),
        metadata=metadata||$6::jsonb WHERE world_id=$1 AND agreement_id=$2 AND status='active'`,
    [worldId, agreement.id, supplierContract ? bankrupt ? 'unable' : 'breached' : 'cancelled', reason, worldTime,
      JSON.stringify({ resolution: 'business_closed', businessId, bankrupt })]);
    await client.query(`UPDATE world_agreements SET status=$3,updated_world_time=$4,
        metadata=metadata||$5::jsonb,updated_at=now() WHERE world_id=$1 AND id=$2 AND status='active'`,
    [worldId, agreement.id, nextStatus, worldTime,
      JSON.stringify({ resolution: { reason: bankrupt ? 'provider_bankrupt' : 'provider_closed', worldTime } })]);
    if (supplierContract) {
      await recordAgreementOutcome(client, { worldId, agreementId: agreement.id, worldTime,
        outcome: bankrupt ? 'unable' : 'breached', reason, actionId: `provider-closed:${businessId}:${agreement.id}`,
        responsibleAgentId: founderAgentId, reputationScale: bankrupt ? 0.25 : 1 });
    }
    await recordAgreementExecutionStage(client, { worldId, agreementId: agreement.id,
      stage: supplierContract ? 'breached' : 'cancelled', worldTime, agentId: founderAgentId,
      eventKey: `provider-closed:${businessId}:${agreement.id}`, reasonCode: bankrupt ? 'PROVIDER_INSOLVENT' : 'PROVIDER_CLOSED',
      details: { businessId, agreementStatus: nextStatus, reason } });
  }
}

async function finalizeAgreementRenegotiation(client, { worldId, parentAgreementId, replacementAgreementId,
  worldTime, actorAgentId }) {
  const parent = await client.query(`SELECT * FROM world_agreements WHERE world_id=$1 AND id=$2 FOR UPDATE`,
    [worldId, parentAgreementId]);
  if (!parent.rowCount || parent.rows[0].status !== 'active') return false;
  await client.query(`UPDATE world_commitments SET status='cancelled',completed_world_time=$3,updated_at=now(),
      metadata=metadata||$4::jsonb WHERE world_id=$1 AND agreement_id=$2 AND status='active'`,
  [worldId, parentAgreementId, worldTime, JSON.stringify({ resolution: 'renegotiated', replacementAgreementId })]);
  await client.query(`UPDATE world_agreements SET status='cancelled',updated_world_time=$3,completed_world_time=$3,
      metadata=(metadata-'renegotiationPending')||$4::jsonb,updated_at=now()
    WHERE world_id=$1 AND id=$2 AND status='active'`,
  [worldId, parentAgreementId, worldTime, JSON.stringify({ resolution: { reason: 'renegotiated',
    replacementAgreementId, worldTime } })]);
  await recordAgreementExecutionStage(client, { worldId, agreementId: parentAgreementId,
    stage: 'renegotiated', worldTime, agentId: actorAgentId,
    eventKey: `replacement:${replacementAgreementId}`, reasonCode: 'TERMS_REVISED',
    details: { replacementAgreementId } });
  for (const agentId of [parent.rows[0].proposer_agent_id, parent.rows[0].counterparty_agent_id]) {
    const otherId = agentId === parent.rows[0].proposer_agent_id
      ? parent.rows[0].counterparty_agent_id : parent.rows[0].proposer_agent_id;
    await client.query(`INSERT INTO agent_memories(world_id,agent_id,memory_type,summary,importance,world_minutes,
        related_agent_id,metadata,long_term,consolidation_key)
      VALUES($1,$2,'contract','Renegotiated supplier terms with the other resident after a capacity delay.',
        0.62,$3,$4,$5::jsonb,false,$6)
      ON CONFLICT(world_id,agent_id,consolidation_key) WHERE consolidation_key IS NOT NULL DO NOTHING`,
    [worldId, agentId, worldTime, otherId, JSON.stringify({ agreementId: parentAgreementId,
      replacementAgreementId, outcome: 'renegotiated' }),
    `contract:${parentAgreementId}:renegotiated:${replacementAgreementId}`]);
  }
  await recordInstitutionalMemory(client, { worldId, institutionType: 'business',
    institutionId: parent.rows[0].terms.businessId, memoryType: 'conflict_resolved', worldTime,
    summary: 'Supplier terms were renegotiated after a capacity delay.',
    metadata: { agreementId: parentAgreementId, replacementAgreementId, outcome: 'renegotiated' } });
  return true;
}

async function clearRenegotiationPending(client, { worldId, agreement }) {
  const rootId = agreement.metadata?.renegotiates
    || (agreement.metadata?.source === 'renegotiation' ? agreement.parent_agreement_id : null);
  if (!rootId) return;
  const pending = await client.query(`SELECT 1 FROM world_agreements WHERE world_id=$1
    AND metadata->>'renegotiates'=$2 AND status='proposed' LIMIT 1`, [worldId, rootId]);
  if (!pending.rowCount) await client.query(`UPDATE world_agreements SET metadata=metadata-'renegotiationPending',updated_at=now()
    WHERE world_id=$1 AND id=$2 AND status='active'`, [worldId, rootId]);
}

async function resolveSupplierAgreementFailure(client, { agreement, worldTime, providerId, reasonCode,
  outcome = 'unable', reputationScale = 0.25 }) {
  const reason = outcome === 'breached' ? 'voluntary_exit' : 'unable_to_fulfill';
  await client.query(`UPDATE world_commitments SET status=$3,outcome_reason=$4,completed_world_time=$5,updated_at=now(),
      metadata=metadata||$6::jsonb WHERE world_id=$1 AND agreement_id=$2 AND status='active'`,
  [agreement.world_id, agreement.id, outcome === 'breached' ? 'breached' : 'unable', reason, worldTime,
    JSON.stringify({ resolution: reasonCode })]);
  await client.query(`UPDATE world_agreements SET status='breached',updated_world_time=$3,
      metadata=metadata||$4::jsonb,updated_at=now() WHERE world_id=$1 AND id=$2 AND status='active'`,
  [agreement.world_id, agreement.id, worldTime, JSON.stringify({ resolution: { reasonCode, worldTime } })]);
  await recordAgreementOutcome(client, { worldId: agreement.world_id, agreementId: agreement.id, worldTime,
    outcome, reason, actionId: `supplier-failure:${agreement.id}:${reasonCode}`,
    responsibleAgentId: providerId, reputationScale });
  await recordAgreementExecutionStage(client, { worldId: agreement.world_id, agreementId: agreement.id,
    stage: 'breached', worldTime, agentId: providerId, eventKey: `failure:${reasonCode}`, reasonCode,
    details: { businessId: agreement.terms?.businessId, serviceId: agreement.terms?.serviceId,
      outcome, agreementStatus: 'breached' } });
}

function serviceNeedIsPresent(serviceType, resident = {}) {
  const goal = String(resident.primary_goal || resident.primaryGoal || '').toUpperCase();
  if (serviceType === 'food_service') return Number(resident.food) < 76;
  if (serviceType === 'social_service') return Number(resident.social) < 62 || /COMMUNITY|RELATIONSHIP/.test(goal);
  if (serviceType === 'trading_service') return /TRADING|WEALTH|MARKET/.test(goal);
  if (serviceType === 'engineering_service') return /ENGINEERING|BUILD/.test(goal) || Number(resident.knowledge) < 45;
  return Number(resident.knowledge) < 62 || /RESEARCH|LEARN/.test(goal);
}

async function executeAgreement(client, agreement, worldTime) {
  const terms = agreement.terms;
  if (agreement.agreement_type === 'employment') {
    const employment = await client.query(`SELECT employment.*,business.founder_agent_id AS founder
      FROM world_business_employment employment JOIN world_businesses business ON business.world_id=employment.world_id
        AND business.id=employment.business_id
      WHERE employment.world_id=$1 AND employment.id=$2 AND employment.status='active' FOR UPDATE OF employment,business`,
    [agreement.world_id, terms.employmentId]);
    if (!employment.rowCount) throw institutionError('ACTIVE_EMPLOYMENT_REQUIRED');
    const row = employment.rows[0];
    const partyIds = new Set([agreement.proposer_agent_id, agreement.counterparty_agent_id]);
    if (!partyIds.has(row.agent_id) || !partyIds.has(row.founder)) throw institutionError('EMPLOYMENT_PARTICIPANTS_MISMATCH', 403);
    const wage = normalizeAmount(terms.wageUsdc, 'wage_usdc', { min: '0.01' });
    const cash = await getEconomicAccount(client, { worldId: agreement.world_id, accountType: 'business', ownerId: row.business_id,
      forUpdate: true });
    if (!cash || parsePositiveUnits(cash.balance, { allowZero: true }) < parsePositiveUnits(wage) * 8n) {
      throw institutionError('BUSINESS_CANNOT_FUND_NEGOTIATED_WAGE');
    }
    await client.query(`UPDATE world_agreements SET status='completed',completed_world_time=$3,updated_world_time=$3,
        updated_at=now() WHERE world_id=$1 AND agreement_type='employment' AND status='active'
        AND terms->>'employmentId'=$2 AND id<>$4`, [agreement.world_id, terms.employmentId, worldTime, agreement.id]);
    await client.query(`UPDATE world_business_employment SET wage_usdc=$3 WHERE world_id=$1 AND id=$2`,
      [agreement.world_id, terms.employmentId, wage]);
    await client.query(`UPDATE world_business_jobs SET wage_usdc=$3 WHERE world_id=$1 AND id=$2`,
      [agreement.world_id, terms.jobId || row.job_id, wage]);
    return { lifecycle: 'active', agreementId: agreement.id, employmentId: terms.employmentId, wageUsdc: wage };
  }
  if (agreement.agreement_type === 'investment') {
    const genesisCurrency = await readGenesisCurrencyActivation(client, agreement.world_id, { forUpdate: true });
    if (genesisCurrency) {
      if (!terms.amountRaw || terms.amountUsdc || terms.tokenId !== genesisCurrency.tokenId) {
        throw institutionError('GENESIS_TOKEN_INVESTMENT_TERMS_INVALID', 409);
      }
      const business = await client.query(`SELECT id,founder_agent_id AS "founderAgentId",status
        FROM world_businesses WHERE world_id=$1 AND id=$2 FOR UPDATE`, [agreement.world_id, terms.businessId]);
      if (!business.rowCount || business.rows[0].status !== 'active') throw institutionError('BUSINESS_NOT_ACTIVE');
      const founderAgentId = business.rows[0].founderAgentId;
      if (![agreement.proposer_agent_id, agreement.counterparty_agent_id].includes(founderAgentId)) {
        throw institutionError('BUSINESS_OWNER_MUST_BE_PARTY', 403);
      }
      const investorAgentId = agreement.proposer_agent_id === founderAgentId
        ? agreement.counterparty_agent_id : agreement.proposer_agent_id;
      const share = Number(terms.ownershipShare);
      const reservedShares = await client.query(`SELECT COALESCE(sum((terms->>'ownershipShare')::numeric),0)::text AS shares
        FROM world_agreements WHERE world_id=$1 AND agreement_type='investment' AND id<>$2
          AND status IN ('active','completed') AND terms->>'businessId'=$3::text
          AND terms->>'tokenId'=$4`, [agreement.world_id, agreement.id, terms.businessId, genesisCurrency.tokenId]);
      if (Number(reservedShares.rows[0]?.shares || 0) + share > 1.0000001) {
        throw institutionError('GENESIS_BUSINESS_EQUITY_EXCEEDS_100_PERCENT');
      }
      const settlement = await createArcGenesisTokenSettlementIntent(client, { worldId: agreement.world_id,
        tokenId: genesisCurrency.tokenId, fromAgentId: investorAgentId, toAgentId: founderAgentId,
        amountRaw: terms.amountRaw, actionId: `business-equity:${agreement.id}`,
        actionFamily: 'business_equity_investment',
        reason: `Genesis Token investment in business ${terms.businessId}.`, worldMinute,
        metadata: { kind: 'business_equity_investment', agreementId: agreement.id,
          businessId: terms.businessId, investorAgentId, founderAgentId,
          ownershipShare: share, ownershipAuthority: 'arc_confirmed_business_agreement',
          tokenOwnershipAuthority: 'arc_chain_confirmation' } });
      return { lifecycle: 'active', agreementId: agreement.id, businessId: terms.businessId,
        tokenId: genesisCurrency.tokenId, amountRaw: terms.amountRaw, ownershipShare: share,
        settlementId: settlement.settlement.id, settlementStatus: settlement.settlement.status,
        ownershipStatus: 'pending_arc_confirmation', tokenOwnershipAuthority: 'arc_chain_confirmation' };
    }
    const business = await client.query(`SELECT id,founder_agent_id,status FROM world_businesses
      WHERE world_id=$1 AND id=$2 FOR UPDATE`, [agreement.world_id, terms.businessId]);
    if (!business.rowCount || business.rows[0].status !== 'active') throw institutionError('BUSINESS_NOT_ACTIVE');
    if (![agreement.proposer_agent_id, agreement.counterparty_agent_id].includes(business.rows[0].founder_agent_id)) {
      throw institutionError('BUSINESS_OWNER_MUST_BE_PARTY', 403);
    }
    const investorId = agreement.proposer_agent_id === business.rows[0].founder_agent_id
      ? agreement.counterparty_agent_id : agreement.proposer_agent_id;
    const investor = await getEconomicAccount(client, { worldId: agreement.world_id, accountType: 'resident', ownerId: investorId,
      forUpdate: true });
    if (!investor || parsePositiveUnits(investor.balance, { allowZero: true }) < parsePositiveUnits(terms.amountUsdc)) {
      throw institutionError('INSUFFICIENT_SIMULATED_USDC');
    }
    const holders = await client.query(`SELECT owner_type,owner_id,share::text AS share,invested_usdc::text AS invested
      FROM world_economic_ownership WHERE world_id=$1 AND asset_type='business' AND asset_id=$2 FOR UPDATE`,
    [agreement.world_id, terms.businessId]);
    const share = Number(terms.ownershipShare);
    if (holders.rows.some((holder) => holder.owner_type === 'resident' && holder.owner_id === investorId)) {
      throw institutionError('INVESTOR_ALREADY_OWNS_BUSINESS');
    }
    if (!holders.rowCount && share !== 1) throw institutionError('BUSINESS_OWNERSHIP_RECORD_MISSING');
    const total = holders.rows.reduce((sum, holder) => sum + Number(holder.share), 0);
    if (total + 1e-7 < share) throw institutionError('INVESTMENT_SHARE_EXCEEDS_UNALLOCATED_OWNERSHIP');
    const transfer = await transferBetweenAccounts(client, { worldId: agreement.world_id,
      source: { accountType: 'resident', ownerId: investorId },
      destination: { accountType: 'business', ownerId: terms.businessId, key: `business:${terms.businessId}` },
      amount: terms.amountUsdc, transactionType: 'business_investment',
      reason: 'Resident fulfilled negotiated simulated business investment.', worldTime,
      actionId: `v5-agreement-invest:${agreement.id}`, referenceId: terms.businessId, metadata: { agreementId: agreement.id } });
    const remaining = Math.max(0, total - share);
    for (const holder of holders.rows) {
      const nextShare = total > 0 ? Number(holder.share) * remaining / total : 0;
      if (nextShare <= 0.0000001) await client.query(`DELETE FROM world_economic_ownership WHERE world_id=$1 AND asset_type='business'
        AND asset_id=$2 AND owner_type=$3 AND owner_id=$4`, [agreement.world_id, terms.businessId, holder.owner_type, holder.owner_id]);
      else await client.query(`UPDATE world_economic_ownership SET share=$5,updated_at=now()
        WHERE world_id=$1 AND asset_type='business' AND asset_id=$2 AND owner_type=$3 AND owner_id=$4`,
      [agreement.world_id, terms.businessId, holder.owner_type, holder.owner_id, nextShare]);
    }
    await client.query(`INSERT INTO world_economic_ownership(world_id,asset_type,asset_id,owner_type,owner_id,share,
        invested_usdc,acquired_world_time) VALUES($1,'business',$2,'resident',$3,$4,$5,$6)
      ON CONFLICT(world_id,asset_type,asset_id,owner_type,owner_id) DO UPDATE SET
        share=world_economic_ownership.share+EXCLUDED.share,invested_usdc=world_economic_ownership.invested_usdc+EXCLUDED.invested_usdc,
        updated_at=now()`, [agreement.world_id, terms.businessId, investorId, share, terms.amountUsdc, worldTime]);
    return { lifecycle: 'completed', agreementId: agreement.id, transactionId: transfer.transactionId, ownershipShare: share };
  }
  if (agreement.agreement_type === 'partnership') {
    const seller = await client.query(`SELECT share::text AS share,invested_usdc::text AS invested
      FROM world_economic_ownership WHERE world_id=$1 AND asset_type='business' AND asset_id=$2
        AND owner_type='resident' AND owner_id=$3 FOR UPDATE`, [agreement.world_id, terms.businessId, terms.sellerAgentId]);
    if (!seller.rowCount || Number(seller.rows[0].share) + 1e-8 < Number(terms.ownershipShare)) {
      throw institutionError('SELLER_OWNERSHIP_SHARE_INSUFFICIENT');
    }
    if ((terms.sellerAgentId !== agreement.proposer_agent_id && terms.sellerAgentId !== agreement.counterparty_agent_id)
        || (terms.buyerAgentId !== agreement.proposer_agent_id && terms.buyerAgentId !== agreement.counterparty_agent_id)) {
      throw institutionError('PARTNERSHIP_PARTICIPANTS_MISMATCH', 403);
    }
    if (!terms.gift) {
      const buyer = await getEconomicAccount(client, { worldId: agreement.world_id, accountType: 'resident', ownerId: terms.buyerAgentId,
        forUpdate: true });
      if (!buyer || parsePositiveUnits(buyer.balance, { allowZero: true }) < parsePositiveUnits(terms.priceUsdc)) {
        throw institutionError('INSUFFICIENT_SIMULATED_USDC');
      }
      await transferBetweenAccounts(client, { worldId: agreement.world_id,
        source: { accountType: 'resident', ownerId: terms.buyerAgentId },
        destination: { accountType: 'resident', ownerId: terms.sellerAgentId }, amount: terms.priceUsdc,
        transactionType: 'ownership_transfer', reason: 'Resident purchased a negotiated business ownership share.', worldTime,
        actionId: `v5-agreement-transfer:${agreement.id}`, referenceId: terms.businessId,
        metadata: { agreementId: agreement.id, share: terms.ownershipShare } });
    }
    const sold = Number(terms.ownershipShare);
    const left = Number(seller.rows[0].share) - sold;
    if (left <= 0.0000001) await client.query(`DELETE FROM world_economic_ownership WHERE world_id=$1 AND asset_type='business'
      AND asset_id=$2 AND owner_type='resident' AND owner_id=$3`, [agreement.world_id, terms.businessId, terms.sellerAgentId]);
    else await client.query(`UPDATE world_economic_ownership SET share=$4,invested_usdc=greatest(0,invested_usdc-$5),updated_at=now()
      WHERE world_id=$1 AND asset_type='business' AND asset_id=$2 AND owner_type='resident' AND owner_id=$3`,
    [agreement.world_id, terms.businessId, terms.sellerAgentId, left,
      Number(seller.rows[0].invested) * sold / Number(seller.rows[0].share)]);
    await client.query(`INSERT INTO world_economic_ownership(world_id,asset_type,asset_id,owner_type,owner_id,share,
        invested_usdc,acquired_world_time) VALUES($1,'business',$2,'resident',$3,$4,0,$5)
      ON CONFLICT(world_id,asset_type,asset_id,owner_type,owner_id) DO UPDATE SET
        share=world_economic_ownership.share+EXCLUDED.share,updated_at=now()`,
    [agreement.world_id, terms.businessId, terms.buyerAgentId, sold, worldTime]);
    await writeWorldHistory(client, { worldId: agreement.world_id, eventKey: `agreement:${agreement.id}:ownership`,
      eventType: 'ownership_transferred', actorAgentId: terms.sellerAgentId, entityType: 'business',
      entityId: terms.businessId, worldTime, title: 'Business ownership transferred',
      detail: `${sold.toFixed(4)} ownership share moved under a negotiated agreement.`, metadata: { agreementId: agreement.id,
        sellerAgentId: terms.sellerAgentId, buyerAgentId: terms.buyerAgentId, share: sold, gift: Boolean(terms.gift) } });
    return { lifecycle: 'completed', agreementId: agreement.id, ownershipShare: sold };
  }
  if (agreement.agreement_type === 'resource_sharing') {
    const recipient = terms.recipientAgentId;
    if (![agreement.proposer_agent_id, agreement.counterparty_agent_id].includes(recipient)) {
      throw institutionError('RESOURCE_RECIPIENT_NOT_PARTICIPANT', 403);
    }
    const sender = recipient === agreement.proposer_agent_id ? agreement.counterparty_agent_id : agreement.proposer_agent_id;
    if (terms.resourceKey === 'effort') {
      const commitment = await client.query(`INSERT INTO world_commitments(world_id,agreement_id,agent_id,counterparty_agent_id,
          commitment_type,description,due_world_time,action_id,metadata)
        VALUES($1,$2,$3,$4,'resource','Provide the agreed effort contribution.', $5,$6,$7::jsonb) RETURNING id`,
      [agreement.world_id, agreement.id, sender, recipient, worldTime + 360, `v5-resource-effort:${agreement.id}`,
        JSON.stringify({ amount: terms.amount })]);
      return { lifecycle: 'active', agreementId: agreement.id, commitmentId: commitment.rows[0].id };
    }
    const transfer = await transferBetweenAccounts(client, { worldId: agreement.world_id,
      source: { accountType: 'resident', ownerId: sender }, destination: { accountType: 'resident', ownerId: recipient },
      amount: terms.amount, transactionType: 'resource_transfer', reason: 'Resident fulfilled negotiated resource sharing.',
      worldTime, actionId: `v5-agreement-resource:${agreement.id}`, referenceId: agreement.id,
      metadata: { agreementId: agreement.id } });
    return { lifecycle: 'completed', agreementId: agreement.id, transactionId: transfer.transactionId };
  }
  if (agreement.agreement_type === 'organization_membership') {
    const organization = await client.query(`SELECT * FROM world_organizations WHERE world_id=$1 AND id=$2`,
      [agreement.world_id, terms.organizationId]);
    if (!organization.rowCount) throw institutionError('ORGANIZATION_NOT_FOUND', 404);
    const memberId = agreement.proposer_agent_id === organization.rows[0].founder_agent_id
      ? agreement.counterparty_agent_id : agreement.proposer_agent_id;
    const result = await decideOrganizationMembership(client, { worldId: agreement.world_id,
      organizationId: terms.organizationId, agentId: memberId, decision: 'accept',
      actionId: `v5-membership:${agreement.id}`, worldTime });
    return { lifecycle: 'completed', agreementId: agreement.id, membership: result.status };
  }
  if (agreement.agreement_type === 'project_cooperation') {
    const memberId = agreement.proposer_agent_id;
    const agentResult = await client.query(`SELECT member.energy,member.food,profile.primary_goal AS goal FROM world_members member
      LEFT JOIN world_social_profiles profile ON profile.world_id=member.world_id AND profile.agent_id=member.agent_id
      WHERE member.world_id=$1 AND member.agent_id=$2`, [agreement.world_id, memberId]);
    const skillRows = await client.query(`SELECT skill_name,skill_value::text AS value FROM world_agent_skills
      WHERE world_id=$1 AND agent_id=$2`, [agreement.world_id, memberId]);
    const skills = Object.fromEntries(skillRows.rows.map((item) => [item.skill_name, Number(item.value)]));
    const result = await decideProjectMembership(client, { worldId: agreement.world_id, projectId: terms.projectId,
      agentId: memberId, decision: 'accept', actionId: `v5-project:${agreement.id}`, worldTime,
      agent: { skills, energy: Number(agentResult.rows[0]?.energy) || 100, food: Number(agentResult.rows[0]?.food) || 100,
        primaryGoal: agentResult.rows[0]?.goal || '' } });
    return { lifecycle: 'active', agreementId: agreement.id, membership: result.status };
  }
  if (agreement.agreement_type === 'revenue_sharing') {
    const business = await client.query(`SELECT founder_agent_id,status FROM world_businesses WHERE world_id=$1 AND id=$2 FOR UPDATE`,
      [agreement.world_id, terms.businessId]);
    if (!business.rowCount || business.rows[0].status !== 'active') throw institutionError('BUSINESS_NOT_ACTIVE');
    if (![agreement.proposer_agent_id, agreement.counterparty_agent_id].includes(business.rows[0].founder_agent_id)
        || ![agreement.proposer_agent_id, agreement.counterparty_agent_id].includes(terms.recipientAgentId)) {
      throw institutionError('REVENUE_SHARE_PARTICIPANTS_MISMATCH', 403);
    }
    const total = await client.query(`SELECT COALESCE(sum((terms->>'shareBps')::integer),0)::int AS basis_points
      FROM world_agreements WHERE world_id=$1 AND agreement_type='revenue_sharing' AND status='active'
        AND terms->>'businessId'=$2 AND id<>$3`, [agreement.world_id, terms.businessId, agreement.id]);
    if (Number(total.rows[0].basis_points) + Number(terms.shareBps) > 8_000) throw institutionError('REVENUE_SHARE_CAP_EXCEEDED');
    return { lifecycle: 'active', agreementId: agreement.id, shareBps: Number(terms.shareBps) };
  }
  if (['service','supplier_relationship'].includes(agreement.agreement_type)) {
    const selected = await client.query(`SELECT service.id,business.founder_agent_id,business.status AS business_status,service.active
      FROM world_business_services service JOIN world_businesses business ON business.world_id=service.world_id
        AND business.id=service.business_id WHERE service.world_id=$1 AND service.id=$2 AND service.business_id=$3`,
    [agreement.world_id, terms.serviceId, terms.businessId]);
    if (!selected.rowCount || selected.rows[0].business_status !== 'active' || !selected.rows[0].active) {
      throw institutionError('BUSINESS_SERVICE_UNAVAILABLE', 404);
    }
    const provider = selected.rows[0].founder_agent_id;
    const customer = provider === agreement.proposer_agent_id ? agreement.counterparty_agent_id : agreement.proposer_agent_id;
    if (![agreement.proposer_agent_id, agreement.counterparty_agent_id].includes(provider)
        || (terms.customerAgentId && terms.customerAgentId !== customer)) {
      throw institutionError('SERVICE_AGREEMENT_PARTICIPANTS_MISMATCH', 403);
    }
    return { lifecycle: 'active', agreementId: agreement.id, priceUsdc: terms.priceUsdc };
  }
  return { lifecycle: 'active', agreementId: agreement.id };
}

export async function respondToWorldAgreement(client, { worldId, agreementId, agentId, decision, actionId,
  counterTerms = null, worldTime }) {
  await requireWorldMember(client, worldId, agentId);
  const key = actionIdentifier(actionId);
  const choice = String(decision || '').toLowerCase();
  if (!['accept','reject','counter','cancel'].includes(choice)) throw institutionError('AGREEMENT_DECISION_INVALID', 400);
  const selected = await client.query(`SELECT * FROM world_agreements WHERE world_id=$1 AND id=$2 FOR UPDATE`, [worldId, agreementId]);
  if (!selected.rowCount) throw institutionError('AGREEMENT_NOT_FOUND', 404);
  const agreement = selected.rows[0];
  const genesisCurrency = await readGenesisCurrencyActivation(client, worldId);
  if (genesisCurrency
      && !(['project_cooperation','organization_membership'].includes(agreement.agreement_type)
        || (agreement.agreement_type === 'resource_sharing' && agreement.terms?.resourceKey === 'effort')
        || (agreement.agreement_type === 'investment' && agreement.terms?.amountRaw
          && agreement.terms?.tokenId === genesisCurrency.tokenId))) {
    throw institutionError('LEGACY_SIMULATED_ECONOMY_RETIRED', 409);
  }
  if (agreement.metadata?.responseActionId === key) return { ...agreement, idempotent: true };
  if (agreement.status !== 'proposed' || ![agreement.proposer_agent_id, agreement.counterparty_agent_id].includes(agentId)) {
    throw institutionError('AGREEMENT_RESPONSE_NOT_ALLOWED', 403);
  }
  if (agreement.expires_world_time !== null && Number(agreement.expires_world_time) <= worldTime) {
    await client.query(`UPDATE world_agreements SET status='expired',updated_world_time=$3,updated_at=now(),
        metadata=metadata||$4::jsonb WHERE world_id=$1 AND id=$2`,
    [worldId, agreementId, worldTime, JSON.stringify({ responseActionId: key, response: 'expired' })]);
    return { id: agreementId, status: 'expired' };
  }
  if (choice !== 'cancel' && agreement.counterparty_agent_id !== agentId) {
    throw institutionError('AGREEMENT_RESPONSE_NOT_ALLOWED', 403);
  }
  if (choice === 'counter') {
    if (Number(agreement.negotiation_round) >= 8) throw institutionError('AGREEMENT_NEGOTIATION_ROUND_LIMIT');
    const previousCounter = await client.query(`SELECT max(created_world_time)::bigint AS last_time FROM world_agreements
      WHERE world_id=$1 AND parent_agreement_id=$2`, [worldId, agreementId]);
    if (previousCounter.rows[0]?.last_time !== null
        && worldTime - Number(previousCounter.rows[0].last_time) < 10) throw institutionError('AGREEMENT_COUNTER_COOLDOWN');
    const merged = { ...agreement.terms, ...jsonObject(counterTerms, 'counter_terms') };
    const normalized = normalizeTerms(agreement.agreement_type, merged);
    const inserted = await client.query(`INSERT INTO world_agreements(world_id,agreement_type,proposer_agent_id,counterparty_agent_id,
        terms,status,parent_agreement_id,negotiation_round,action_id,created_world_time,expires_world_time,updated_world_time,metadata)
      VALUES($1,$2,$3,$4,$5::jsonb,'proposed',$6,$7,$8,$9,$10,$9,$11::jsonb) RETURNING *`,
    [worldId, agreement.agreement_type, agentId, agreement.proposer_agent_id, JSON.stringify(normalized), agreement.id,
      Number(agreement.negotiation_round) + 1, key, worldTime, Math.min(Number(agreement.expires_world_time || worldTime + 1_440), worldTime + 1_440),
      JSON.stringify({ source: agreement.metadata?.renegotiates ? 'renegotiation_counter' : 'counter_offer',
        ...(agreement.metadata?.renegotiates ? { renegotiates: agreement.metadata.renegotiates } : {}) })]);
    await insertParticipants(client, inserted.rows[0], worldTime);
    await client.query(`UPDATE world_agreements SET status='countered',updated_world_time=$3,updated_at=now(),
        metadata=metadata||$4::jsonb WHERE world_id=$1 AND id=$2`,
    [worldId, agreementId, worldTime, JSON.stringify({ responseActionId: key, counteredBy: agentId })]);
    await client.query(`UPDATE world_agreement_participants SET response='countered',responded_world_time=$3
      WHERE agreement_id=$1 AND agent_id=$2`, [agreementId, agentId, worldTime]);
    await writeWorldHistory(client, { worldId, eventKey: `agreement:${inserted.rows[0].id}:countered`, eventType: 'agreement_countered',
      actorAgentId: agentId, entityType: 'agreement', entityId: inserted.rows[0].id, worldTime,
      title: 'Agreement counter-offer proposed', detail: `A resident countered round ${Number(agreement.negotiation_round)} with revised terms.`,
      metadata: { agreementType: agreement.agreement_type, parentAgreementId: agreement.id,
        round: Number(agreement.negotiation_round) + 1 } });
    return { agreement: inserted.rows[0], status: 'countered', parentAgreementId: agreement.id };
  }
  if (choice === 'cancel') {
    await client.query(`UPDATE world_agreements SET status='cancelled',updated_world_time=$3,updated_at=now(),
        metadata=metadata||$4::jsonb WHERE world_id=$1 AND id=$2`,
    [worldId, agreementId, worldTime, JSON.stringify({ responseActionId: key, cancelledBy: agentId })]);
    await clearRenegotiationPending(client, { worldId, agreement });
    return { id: agreementId, status: 'cancelled' };
  }
  const status = choice === 'accept' ? 'active' : 'rejected';
  await client.query(`UPDATE world_agreements SET status=$3,accepted_world_time=CASE WHEN $3='active' THEN $4::bigint ELSE NULL END,
      activated_world_time=CASE WHEN $3='active' THEN $4::bigint ELSE NULL END,
      completed_world_time=CASE WHEN $3='active' AND $5 THEN $4::bigint ELSE NULL END,
      updated_world_time=$4::bigint,updated_at=now(),metadata=metadata||$6::jsonb WHERE world_id=$1 AND id=$2`,
  [worldId, agreementId, status, worldTime, false, JSON.stringify({ responseActionId: key, response: choice })]);
  await client.query(`UPDATE world_agreement_participants SET response=$3,responded_world_time=$4
    WHERE agreement_id=$1 AND agent_id=$2`, [agreementId, agentId, choice === 'accept' ? 'accepted' : 'rejected', worldTime]);
  if (choice === 'reject') {
    await writeWorldHistory(client, { worldId, eventKey: `agreement:${agreementId}:rejected:${key}`,
      eventType: 'agreement_rejected', actorAgentId: agentId, entityType: 'agreement', entityId: agreementId, worldTime,
      title: 'Agreement proposal declined', detail: 'A resident declined the proposed terms before they became binding.',
      metadata: { agreementType: agreement.agreement_type, response: 'rejected' } });
    await clearRenegotiationPending(client, { worldId, agreement });
    return { id: agreementId, status: 'rejected' };
  }
  const execution = await executeAgreement(client, agreement, worldTime);
  const terminal = execution.lifecycle === 'completed';
  await client.query(`UPDATE world_agreements SET status=$3,completed_world_time=CASE WHEN $3='completed' THEN $4::bigint ELSE NULL END,
      updated_world_time=$4::bigint,updated_at=now(),metadata=metadata||$5::jsonb WHERE world_id=$1 AND id=$2`,
  [worldId, agreementId, terminal ? 'completed' : 'active', worldTime, JSON.stringify({ execution })]);
  const renegotiatedParentId = agreement.metadata?.renegotiates
    || (agreement.metadata?.source === 'renegotiation' ? agreement.parent_agreement_id : null);
  if (!terminal && renegotiatedParentId) await finalizeAgreementRenegotiation(client, { worldId,
    parentAgreementId: renegotiatedParentId, replacementAgreementId: agreement.id, worldTime, actorAgentId: agentId });
  if (!terminal && ['service','supplier_relationship'].includes(agreement.agreement_type)) {
    await recordAgreementExecutionStage(client, { worldId, agreementId, stage: 'agreement_active', worldTime,
      agentId, eventKey: `accepted:${key}`, details: { agreementType: agreement.agreement_type,
        businessId: agreement.terms.businessId, serviceId: agreement.terms.serviceId } });
    await enqueueSupplierDeliveryCommitment(client, { agreement: { ...agreement, status: 'active' }, worldTime });
  }
  if (terminal) await recordAgreementOutcome(client, { worldId, agreementId, worldTime, outcome: 'fulfilled', actionId: key });
  await writeWorldHistory(client, { worldId, eventKey: `agreement:${agreementId}:accepted`, eventType: 'agreement_accepted',
    actorAgentId: agentId, entityType: 'agreement', entityId: agreementId, worldTime,
    title: 'Agreement accepted', detail: `The ${agreement.agreement_type.replaceAll('_',' ')} terms were accepted and applied.`,
    metadata: { agreementType: agreement.agreement_type, execution } });
  return { id: agreementId, status: terminal ? 'completed' : 'active', execution };
}

export async function createWorldCommitment(client, { worldId, agreementId, agentId, counterpartyAgentId,
  commitmentType, description, actionId, dueWorldTime, worldTime }) {
  await requireWorldMember(client, worldId, agentId);
  const type = String(commitmentType || '').toLowerCase();
  if (!['work','delivery','payment','project','resource','meeting','service'].includes(type)) {
    throw institutionError('COMMITMENT_TYPE_INVALID', 400);
  }
  const text = requiredText(description, 3, 240, 'commitment_description');
  if (!UUID_RE.test(String(counterpartyAgentId))) throw institutionError('COMMITMENT_COUNTERPARTY_INVALID', 400);
  const due = Math.trunc(boundedNumber(dueWorldTime, worldTime + 1, worldTime + 43_200, 'commitment_due_time'));
  const agreement = await client.query(`SELECT 1 FROM world_agreements WHERE world_id=$1 AND id=$2 AND status='active'
    AND $3 IN (proposer_agent_id,counterparty_agent_id) AND $4 IN (proposer_agent_id,counterparty_agent_id)`,
  [worldId, agreementId, agentId, counterpartyAgentId]);
  if (!agreement.rowCount) throw institutionError('ACTIVE_AGREEMENT_REQUIRED');
  const inserted = await client.query(`INSERT INTO world_commitments(world_id,agreement_id,agent_id,counterparty_agent_id,
      commitment_type,description,due_world_time,action_id,metadata)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,'{}'::jsonb)
    ON CONFLICT(world_id,agent_id,action_id) DO UPDATE SET updated_at=world_commitments.updated_at RETURNING *`,
  [worldId, agreementId, agentId, counterpartyAgentId, type, text, due, actionIdentifier(actionId)]);
  return inserted.rows[0];
}

export async function resolveWorldCommitment(client, { worldId, commitmentId, agentId, outcome, actionId, worldTime }) {
  const key = actionIdentifier(actionId);
  const choice = String(outcome || '').toLowerCase();
  const rowResult = await client.query(`SELECT * FROM world_commitments WHERE world_id=$1 AND id=$2 FOR UPDATE`, [worldId, commitmentId]);
  if (!rowResult.rowCount) throw institutionError('COMMITMENT_NOT_FOUND', 404);
  const row = rowResult.rows[0];
  if (row.agent_id !== agentId) throw institutionError('COMMITMENT_OWNER_REQUIRED', 403);
  if (row.status !== 'active') return { ...row, idempotent: row.metadata?.responseActionId === key };
  const states = { complete: ['fulfilled','completed'], unable: ['unable','unable_to_fulfill'], withdraw: ['breached','voluntary_exit'] };
  if (!states[choice]) throw institutionError('COMMITMENT_OUTCOME_INVALID', 400);
  const [status, reason] = states[choice];
  await client.query(`UPDATE world_commitments SET status=$3,outcome_reason=$4,completed_world_time=$5,
      updated_at=now(),metadata=metadata||$6::jsonb WHERE world_id=$1 AND id=$2`,
  [worldId, commitmentId, status, reason, worldTime, JSON.stringify({ responseActionId: key })]);
  if (choice === 'complete') {
    await recordAgreementOutcome(client, { worldId, agreementId: row.agreement_id, worldTime,
      outcome: 'fulfilled', reason, actionId: key, responsibleAgentId: agentId });
  } else {
    await recordAgreementOutcome(client, { worldId, agreementId: row.agreement_id, worldTime,
      outcome: choice === 'unable' ? 'unable' : 'breached', reason, actionId: key, responsibleAgentId: agentId });
    if (choice === 'withdraw') await client.query(`UPDATE world_social_norms SET violation_count=violation_count+1,
        confidence=LEAST(1,(support_count+1)::numeric/(support_count+violation_count+2)),updated_world_time=$3,updated_at=now()
      WHERE world_id=$1 AND scope_type='world' AND scope_id=$1 AND norm_key=$2`,
    [worldId, `${row.commitment_type}:honor_deadline`, worldTime]);
  }
  await writeWorldHistory(client, { worldId, eventKey: `commitment:${commitmentId}:${key}`,
    eventType: choice === 'complete' ? 'agreement_completed' : 'agreement_breached', actorAgentId: agentId,
    entityType: 'agreement', entityId: row.agreement_id, worldTime,
    title: choice === 'complete' ? 'Commitment fulfilled' : choice === 'unable' ? 'Resident declared inability' : 'Commitment withdrawn',
    detail: row.description, metadata: { commitmentId, outcome: choice, reason } });
  return { id: commitmentId, agreementId: row.agreement_id, status, outcomeReason: reason };
}

export async function recordEmploymentShift(client, { worldId, employmentId, workActionId, worldTime, businessId, agentId }) {
  if (await isGenesisCurrencyActive(client, worldId)) return null;
  const selected = await client.query(`SELECT id,proposer_agent_id,counterparty_agent_id,terms FROM world_agreements
    WHERE world_id=$1 AND agreement_type='employment' AND status='active' AND terms->>'employmentId'=$2
    ORDER BY updated_world_time DESC LIMIT 1`, [worldId, employmentId]);
  if (!selected.rowCount) return null;
  const agreement = selected.rows[0];
  const key = `v5-shift:${workActionId}`;
  const pending = await client.query(`SELECT id FROM world_commitments WHERE world_id=$1 AND agreement_id=$2
    AND agent_id=$3 AND commitment_type='work' AND status='active' ORDER BY due_world_time,id LIMIT 1 FOR UPDATE`,
  [worldId, agreement.id, agentId]);
  if (pending.rowCount) {
    await client.query(`UPDATE world_commitments SET status='fulfilled',outcome_reason='completed',completed_world_time=$3,
      metadata=metadata||$4::jsonb,updated_at=now() WHERE world_id=$1 AND id=$2`,
    [worldId, pending.rows[0].id, worldTime, JSON.stringify({ fulfillmentActionId: workActionId, businessId, employmentId })]);
  } else {
    const inserted = await client.query(`INSERT INTO world_commitments(world_id,agreement_id,agent_id,counterparty_agent_id,
        commitment_type,description,status,due_world_time,completed_world_time,outcome_reason,action_id,metadata)
      VALUES($1,$2,$3,$4,'work','Complete a paid production shift under the employment agreement.','fulfilled',$5,$5,'completed',$6,$7::jsonb)
      ON CONFLICT(world_id,agent_id,action_id) DO NOTHING RETURNING id`,
    [worldId, agreement.id, agentId, agentId === agreement.proposer_agent_id ? agreement.counterparty_agent_id : agreement.proposer_agent_id,
      worldTime, key, JSON.stringify({ businessId, employmentId, workActionId })]);
    if (!inserted.rowCount) return agreement.id;
  }
  await recordAgreementOutcome(client, { worldId, agreementId: agreement.id, worldTime,
    outcome: 'fulfilled', actionId: key, responsibleAgentId: agentId, reputationScale: 0.05 });
  const reference = await client.query(`SELECT avg((agreement.terms->>'wageUsdc')::numeric)::numeric(30,8)::text AS wage,
      count(DISTINCT outcome.id)::int AS sample_count
    FROM world_agreements agreement JOIN world_agreement_outcomes outcome ON outcome.world_id=agreement.world_id
      AND outcome.agreement_id=agreement.id AND outcome.outcome='fulfilled'
    WHERE agreement.world_id=$1 AND agreement.agreement_type='employment'
      AND agreement.terms->>'businessId'=$2 AND outcome.agent_id=$3`, [worldId, businessId, agentId]);
  if (Number(reference.rows[0]?.sample_count) >= 3) await client.query(`INSERT INTO world_agreement_templates(world_id,scope_type,
      scope_id,agreement_type,template_key,terms,sample_count,success_count,created_world_time,updated_world_time)
    VALUES($1,'business',$2,'employment','paid-shift-v1',$3::jsonb,$4,$4,$5,$5)
    ON CONFLICT(world_id,scope_type,scope_id,agreement_type,template_key) DO UPDATE SET
      terms=EXCLUDED.terms,sample_count=greatest(world_agreement_templates.sample_count,EXCLUDED.sample_count),
      success_count=greatest(world_agreement_templates.success_count,EXCLUDED.success_count),
      updated_world_time=EXCLUDED.updated_world_time,updated_at=now()`,
  [worldId, businessId, JSON.stringify({ wageReferenceUsdc: reference.rows[0].wage, basis: 'per_completed_shift' }),
    Number(reference.rows[0].sample_count), worldTime]);
  return agreement.id;
}

export async function settleActiveRevenueShares(client, { worldId, businessId, businessRevenueUsdc, orderActionId,
  customerAgentId, worldTime }) {
  if (await isGenesisCurrencyActive(client, worldId)) return [];
  const agreements = await client.query(`SELECT id,proposer_agent_id,counterparty_agent_id,terms
    FROM world_agreements WHERE world_id=$1 AND agreement_type='revenue_sharing' AND status='active'
      AND terms->>'businessId'=$2 ORDER BY created_world_time,id FOR UPDATE`, [worldId, businessId]);
  let paidUnits = 0n;
  const grossUnits = parsePositiveUnits(String(businessRevenueUsdc), { allowZero: true });
  const settlements = [];
  for (const agreement of agreements.rows) {
    const recipient = agreement.terms.recipientAgentId;
    if (![agreement.proposer_agent_id, agreement.counterparty_agent_id].includes(recipient)
        || recipient === customerAgentId) continue;
    let share = grossUnits * BigInt(agreement.terms.shareBps) / 10_000n;
    if (agreement.terms.capPerDayUsdc) {
      const dayStart = Math.floor(worldTime / 1_440) * 1_440;
      const used = await client.query(`SELECT COALESCE(sum(amount),0)::text AS amount FROM world_economic_transactions
        WHERE world_id=$1 AND transaction_type='business_revenue_share' AND reference_id=$2
          AND world_time >= $3 AND world_time < $4`, [worldId, agreement.id, dayStart, dayStart + 1_440]);
      const cap = parsePositiveUnits(agreement.terms.capPerDayUsdc, { allowZero: true });
      const remaining = cap - parsePositiveUnits(used.rows[0]?.amount || '0', { allowZero: true });
      if (remaining <= 0n) continue;
      if (share > remaining) share = remaining;
    }
    if (share <= 0n) continue;
    paidUnits += share;
    if (paidUnits > grossUnits * 8_000n / 10_000n) throw institutionError('REVENUE_SHARE_CAP_EXCEEDED');
    const transfer = await transferBetweenAccounts(client, { worldId,
      source: { accountType: 'business', ownerId: businessId, key: `business:${businessId}` },
      destination: { accountType: 'resident', ownerId: recipient }, amount: formatUnits(share),
      transactionType: 'business_revenue_share', reason: 'Business paid an active, negotiated revenue-share agreement.',
      worldTime, actionId: `business-revshare:${orderActionId}:${agreement.id}`, referenceId: agreement.id,
      metadata: { agreementId: agreement.id, businessId, customerAgentId, shareBps: agreement.terms.shareBps } });
    settlements.push({ agreementId: agreement.id, recipientAgentId: recipient, amountUsdc: formatUnits(share),
      transactionId: transfer.transactionId });
  }
  return settlements;
}

export async function activeServicePriceAgreement(client, { worldId, businessId, serviceId, customerAgentId, providerAgentId,
  worldTime, agreementId = null }) {
  if (await isGenesisCurrencyActive(client, worldId)) return null;
  const result = await client.query(`SELECT agreement.id,agreement.agreement_type,agreement.terms
    FROM world_agreements agreement WHERE agreement.world_id=$1 AND agreement.status='active'
      AND agreement.agreement_type IN ('service','supplier_relationship')
      AND ($6::uuid IS NULL OR agreement.id=$6::uuid)
      AND agreement.terms->>'businessId'=$2::text AND agreement.terms->>'serviceId'=$3::text
      AND $4 IN (agreement.proposer_agent_id,agreement.counterparty_agent_id)
      AND $5 IN (agreement.proposer_agent_id,agreement.counterparty_agent_id)
      AND agreement.proposer_agent_id<>agreement.counterparty_agent_id
      AND (agreement.terms->>'customerAgentId' IS NULL OR agreement.terms->>'customerAgentId'=$4::text)
      ORDER BY agreement.agreement_type='service' DESC,agreement.updated_world_time DESC
      LIMIT 1 FOR UPDATE`, [worldId, businessId, serviceId, customerAgentId, providerAgentId, agreementId]);
  if (!result.rowCount) return null;
  const agreement = result.rows[0];
  if (agreement.agreement_type === 'service' || agreement.agreement_type === 'supplier_relationship') {
    const used = await client.query(`SELECT count(*)::int AS count FROM world_commitments WHERE world_id=$1 AND agreement_id=$2
      AND commitment_type='service' AND status='fulfilled'`, [worldId, agreement.id]);
    const limit = agreementUnitLimit(agreement.terms);
    if (Number(used.rows[0].count) >= limit) {
      await client.query(`UPDATE world_agreements SET status='completed',completed_world_time=$3,updated_world_time=$3,
        updated_at=now() WHERE world_id=$1 AND id=$2 AND status='active'`, [worldId, agreement.id, worldTime]);
      return null;
    }
  }
  return agreement;
}

export async function settleServiceDelivery(client, { worldId, agreementId, customerAgentId, providerAgentId,
  businessId, orderId, worldTime, actionId }) {
  if (await isGenesisCurrencyActive(client, worldId)) return;
  if (!agreementId) return;
  const agreement = await client.query(`SELECT * FROM world_agreements WHERE world_id=$1 AND id=$2 FOR UPDATE`,
    [worldId, agreementId]);
  if (!agreement.rowCount || agreement.rows[0].status !== 'active') return;
  const row = agreement.rows[0];
  const commitmentId = `v5-delivery:${actionId}`;
  const inserted = await client.query(`INSERT INTO world_commitments(world_id,agreement_id,agent_id,counterparty_agent_id,
      commitment_type,description,status,due_world_time,completed_world_time,outcome_reason,action_id,metadata)
    VALUES($1,$2,$3,$4,'service','Deliver the contracted service and apply its customer benefit.','fulfilled',$5,$5,'completed',$6,$7::jsonb)
    ON CONFLICT(world_id,agent_id,action_id) DO NOTHING RETURNING id`,
  [worldId, agreementId, providerAgentId, customerAgentId, worldTime, commitmentId, JSON.stringify({ businessId, orderId })]);
  if (!inserted.rowCount) return;
  if (['service','supplier_relationship'].includes(row.agreement_type)) {
    const activeDelivery = await client.query(`SELECT id FROM world_commitments WHERE world_id=$1 AND agreement_id=$2
      AND commitment_type='delivery' AND status='active' ORDER BY due_world_time,id LIMIT 1 FOR UPDATE`, [worldId, agreementId]);
    if (activeDelivery.rowCount) await client.query(`UPDATE world_commitments SET status='fulfilled',outcome_reason='completed',
        completed_world_time=$3,updated_at=now(),metadata=metadata||$4::jsonb WHERE world_id=$1 AND id=$2`,
    [worldId, activeDelivery.rows[0].id, worldTime, JSON.stringify({ deliveredByOrderId: orderId, deliveryActionId: actionId })]);
  }
  await recordAgreementExecutionStage(client, { worldId, agreementId, stage: 'delivered', worldTime,
    agentId: providerAgentId, eventKey: `delivered:${actionId}`,
    details: { businessId, orderId, customerAgentId, providerAgentId } });
  const order = await client.query(`SELECT transaction_id FROM world_business_orders WHERE world_id=$1 AND id=$2`,
    [worldId, orderId]);
  await recordAgreementExecutionStage(client, { worldId, agreementId, stage: 'payment_settled', worldTime,
    agentId: customerAgentId, eventKey: `payment:${actionId}`,
    details: { orderId, transactionId: order.rows[0]?.transaction_id || null, customerAgentId, providerAgentId } });
  if (row.agreement_type === 'service') {
    const deliveries = await client.query(`SELECT count(*)::int AS count FROM world_commitments
      WHERE world_id=$1 AND agreement_id=$2 AND commitment_type='service' AND status='fulfilled'`, [worldId, agreementId]);
    const maxUnits = agreementUnitLimit(row.terms);
    if (Number(deliveries.rows[0]?.count) >= maxUnits) {
      await client.query(`UPDATE world_agreements SET status='completed',completed_world_time=$3,updated_world_time=$3,
        metadata=metadata||'{"completionReason":"max_units_delivered"}'::jsonb,updated_at=now()
        WHERE world_id=$1 AND id=$2 AND status='active'`, [worldId, agreementId, worldTime]);
      await recordAgreementExecutionStage(client, { worldId, agreementId, stage: 'completed', worldTime,
        agentId: providerAgentId, eventKey: `units:${deliveries.rows[0]?.count}`,
        details: { deliveredUnits: Number(deliveries.rows[0]?.count), maxUnits } });
    }
  } else if (row.agreement_type === 'supplier_relationship') {
    const deliveries = await client.query(`SELECT count(*)::int AS count FROM world_commitments
      WHERE world_id=$1 AND agreement_id=$2 AND commitment_type='service' AND status='fulfilled'`, [worldId, agreementId]);
    const maxUnits = agreementUnitLimit(row.terms);
    if (Number(deliveries.rows[0]?.count) >= maxUnits) {
      await client.query(`UPDATE world_agreements SET status='completed',completed_world_time=$3,updated_world_time=$3,
        metadata=metadata||'{"completionReason":"max_units_delivered"}'::jsonb,updated_at=now()
        WHERE world_id=$1 AND id=$2 AND status='active'`, [worldId, agreementId, worldTime]);
      await recordAgreementExecutionStage(client, { worldId, agreementId, stage: 'completed', worldTime,
        agentId: providerAgentId, eventKey: `max-units:${deliveries.rows[0]?.count}`,
        details: { deliveredUnits: Number(deliveries.rows[0]?.count), maxUnits } });
    } else {
      const current = await client.query(`SELECT * FROM world_agreements WHERE world_id=$1 AND id=$2`, [worldId, agreementId]);
      await enqueueSupplierDeliveryCommitment(client, { agreement: current.rows[0], worldTime });
    }
  }
  await recordAgreementOutcome(client, { worldId, agreementId, worldTime, outcome: 'fulfilled', actionId: commitmentId });
}

export async function expireInstitutionalState(client, { worldId, worldTime }) {
  const expiredOffers = await client.query(`UPDATE world_agreements SET status='expired',updated_world_time=$2,updated_at=now()
    WHERE world_id=$1 AND status='proposed' AND expires_world_time<=$2
    RETURNING id,agreement_type,parent_agreement_id,metadata`, [worldId, worldTime]);
  for (const agreement of expiredOffers.rows) await clearRenegotiationPending(client, { worldId, agreement });

  const endedEmployment = await client.query(`SELECT agreement.terms->>'employmentId' AS employment_id,
      agreement.counterparty_agent_id AS employee_id,agreement.proposer_agent_id AS employer_id,
      employment.status AS employment_status,business.status AS business_status
    FROM world_agreements agreement LEFT JOIN world_businesses business ON business.world_id=agreement.world_id
      AND business.id=(agreement.terms->>'businessId')::uuid
    LEFT JOIN world_business_employment employment ON employment.world_id=agreement.world_id
      AND employment.id=(agreement.terms->>'employmentId')::uuid
    WHERE agreement.world_id=$1 AND agreement.agreement_type='employment' AND agreement.status='active'
      AND (employment.status IS DISTINCT FROM 'active' OR business.status IS DISTINCT FROM 'active')
    ORDER BY agreement.id`, [worldId]);
  for (const item of endedEmployment.rows) await resolveEmploymentAgreementOnExit(client, {
    worldId, employmentId: item.employment_id,
    agentId: item.employment_status === 'left' ? item.employee_id : item.employer_id,
    reason: item.business_status === 'active' ? 'employee_left' : 'business_closed', worldTime,
    commitmentOutcomeReason: item.business_status === 'active' ? 'voluntary_exit' : null
  });

  const unavailableSuppliers = await client.query(`SELECT agreement.terms->>'businessId' AS business_id,
      COALESCE(business.founder_agent_id,agreement.proposer_agent_id) AS provider_id,
      agreement.id AS agreement_id,agreement.world_id,agreement.terms,business.status AS business_status,
      business.metadata AS business_metadata,service.id AS service_id,service.active AS service_active,
      place.status AS place_status
    FROM world_agreements agreement LEFT JOIN world_businesses business ON business.world_id=agreement.world_id
      AND business.id=(agreement.terms->>'businessId')::uuid
    LEFT JOIN world_business_services service ON service.world_id=agreement.world_id
      AND service.business_id=business.id AND service.id=(agreement.terms->>'serviceId')::uuid
    LEFT JOIN world_scenes place ON place.world_id=business.world_id AND place.id=business.place_id
    WHERE agreement.world_id=$1 AND agreement.status='active'
      AND agreement.agreement_type IN ('supplier_relationship','service')
      AND (business.id IS NULL OR business.status<>'active' OR service.id IS NULL OR service.active=false
        OR (business.place_id IS NOT NULL AND place.status IS DISTINCT FROM 'active'))
    ORDER BY agreement.id`, [worldId]);
  let resolvedSupplierFailures = 0;
  const closedBusinessIds = new Set();
  for (const item of unavailableSuppliers.rows) {
    if (item.business_id && (item.business_status === 'closed' || item.business_status === 'bankrupt')) {
      closedBusinessIds.add(item.business_id);
      continue;
    }
    const reasonCode = !item.service_id || item.service_active === false || item.place_status !== 'active'
      ? 'NO_REQUIRED_PLACE' : 'PROVIDER_CLOSED';
    await resolveSupplierAgreementFailure(client, { agreement: { id: item.agreement_id, world_id: item.world_id,
      terms: item.terms }, worldTime, providerId: item.provider_id, reasonCode });
    resolvedSupplierFailures++;
  }
  for (const businessId of closedBusinessIds) {
    const item = unavailableSuppliers.rows.find((row) => row.business_id === businessId);
    const latest = await client.query(`SELECT founder_agent_id,status,metadata FROM world_businesses
      WHERE world_id=$1 AND id=$2`, [worldId, businessId]);
    if (!latest.rowCount) continue;
    await resolveBusinessAgreementsOnClosure(client, { worldId, businessId,
      founderAgentId: latest.rows[0].founder_agent_id, worldTime,
      bankrupt: latest.rows[0].status === 'bankrupt'
        || latest.rows[0].metadata?.closedReason === 'owner_declared_bankruptcy' });
    void item;
  }

  const activeSupplierAgreements = await client.query(`SELECT agreement.* FROM world_agreements agreement
    JOIN world_businesses business ON business.world_id=agreement.world_id
      AND business.id=(agreement.terms->>'businessId')::uuid AND business.status='active'
    JOIN world_business_services service ON service.world_id=business.world_id AND service.business_id=business.id
      AND service.id=(agreement.terms->>'serviceId')::uuid AND service.active=true
    WHERE agreement.world_id=$1 AND agreement.agreement_type IN ('service','supplier_relationship') AND agreement.status='active'
    ORDER BY agreement.created_world_time,agreement.id`, [worldId]);
  let supplierCommitmentsCreated = 0;
  for (const agreement of activeSupplierAgreements.rows) {
    const fulfilled = await client.query(`SELECT count(*)::int AS count FROM world_commitments WHERE world_id=$1
      AND agreement_id=$2 AND commitment_type='service' AND status='fulfilled'`, [worldId, agreement.id]);
    if (Number(fulfilled.rows[0]?.count || 0) >= agreementUnitLimit(agreement.terms)) {
      await client.query(`UPDATE world_agreements SET status='completed',completed_world_time=$3,updated_world_time=$3,
          metadata=metadata||'{"completionReason":"max_units_delivered"}'::jsonb,updated_at=now()
        WHERE world_id=$1 AND id=$2 AND status='active'`, [worldId, agreement.id, worldTime]);
      await recordAgreementExecutionStage(client, { worldId, agreementId: agreement.id, stage: 'completed',
        worldTime, eventKey: `max-units:${fulfilled.rows[0]?.count}`,
        details: { deliveredUnits: Number(fulfilled.rows[0]?.count) } });
      continue;
    }
    const before = await client.query(`SELECT count(*)::int AS count FROM world_commitments WHERE world_id=$1
      AND agreement_id=$2 AND commitment_type='delivery' AND status='active'`, [worldId, agreement.id]);
    const created = await enqueueSupplierDeliveryCommitment(client, { agreement, worldTime });
    if (!before.rows[0]?.count && created) supplierCommitmentsCreated++;
  }

  const dueSupplierDeliveries = await client.query(`SELECT commitment.id AS commitment_id,commitment.agreement_id,
      agreement.world_id,agreement.terms,agreement.proposer_agent_id,agreement.counterparty_agent_id,
      service.stock_units,service.service_type,service.base_price_usdc,business.founder_agent_id,
      COALESCE(account.balance,0)::text AS customer_cash,member.food,member.social,
      COALESCE(state.knowledge,20) AS knowledge,profile.primary_goal
    FROM world_commitments commitment JOIN world_agreements agreement
      ON agreement.world_id=commitment.world_id AND agreement.id=commitment.agreement_id AND agreement.status='active'
    JOIN world_businesses business ON business.world_id=agreement.world_id
      AND business.id=(agreement.terms->>'businessId')::uuid
    JOIN world_business_services service ON service.world_id=business.world_id AND service.business_id=business.id
      AND service.id=(agreement.terms->>'serviceId')::uuid
    JOIN world_members member ON member.world_id=agreement.world_id AND member.agent_id=commitment.counterparty_agent_id
    LEFT JOIN world_agent_states state ON state.world_id=member.world_id AND state.agent_id=member.agent_id
    LEFT JOIN world_social_profiles profile ON profile.world_id=member.world_id AND profile.agent_id=member.agent_id
    LEFT JOIN world_economic_accounts account ON account.world_id=member.world_id
      AND account.account_type='resident' AND account.owner_id=member.agent_id AND account.asset_symbol='USDC'
    WHERE commitment.world_id=$1 AND commitment.status='active' AND commitment.commitment_type='delivery'
      AND agreement.agreement_type IN ('service','supplier_relationship') AND commitment.due_world_time<=$2
      AND COALESCE(agreement.metadata->>'renegotiationPending','false')<>'true'
    ORDER BY commitment.due_world_time,commitment.id FOR UPDATE OF commitment,agreement`, [worldId, worldTime]);
  for (const delivery of dueSupplierDeliveries.rows) {
    const cash = Number(delivery.customer_cash) || 0;
    const price = Number(delivery.terms.priceUsdc) || Number(delivery.base_price_usdc) || 0;
    const demand = serviceNeedIsPresent(delivery.service_type, delivery);
    if (Number(delivery.stock_units) > 0) {
      const reasonCode = cash < price ? 'NO_FUNDS' : !demand ? 'NO_CUSTOMER_DEMAND' : 'EXECUTION_NOT_SELECTED';
      await client.query(`UPDATE world_commitments SET status='expired',completed_world_time=$3,updated_at=now(),
          metadata=metadata||$4::jsonb WHERE world_id=$1 AND id=$2 AND status='active'`,
      [worldId, delivery.commitment_id, worldTime, JSON.stringify({ resolution: reasonCode })]);
      await client.query(`UPDATE world_agreements SET status='expired',updated_world_time=$3,
          metadata=metadata||$4::jsonb,updated_at=now() WHERE world_id=$1 AND id=$2 AND status='active'`,
      [worldId, delivery.agreement_id, worldTime, JSON.stringify({ resolution: { reasonCode, worldTime } })]);
      await recordAgreementExecutionStage(client, { worldId, agreementId: delivery.agreement_id, stage: 'expired',
        worldTime, eventKey: `delivery:${delivery.commitment_id}:${reasonCode}`, reasonCode,
        details: { commitmentId: delivery.commitment_id, stockUnits: Number(delivery.stock_units), customerCash: cash, price } });
    } else {
      await resolveSupplierAgreementFailure(client, { agreement: { id: delivery.agreement_id,
        world_id: worldId, terms: delivery.terms }, worldTime, providerId: delivery.founder_agent_id,
        reasonCode: 'NO_INVENTORY', outcome: 'unable', reputationScale: 0.25 });
      resolvedSupplierFailures++;
    }
  }

  const expiredCommitments = await client.query(`UPDATE world_commitments SET status='breached',outcome_reason='missed_deadline',
      completed_world_time=$2,updated_at=now() WHERE world_id=$1 AND status='active' AND due_world_time<=$2
      AND NOT (commitment_type='delivery' AND agreement_id IN (SELECT id FROM world_agreements
        WHERE world_id=$1 AND agreement_type IN ('service','supplier_relationship')))
    RETURNING id,agreement_id,agent_id,counterparty_agent_id,description,commitment_type`, [worldId, worldTime]);
  for (const item of expiredCommitments.rows) {
    await recordAgreementOutcome(client, { worldId, agreementId: item.agreement_id, worldTime, outcome: 'breached',
      reason: 'missed_deadline', actionId: `deadline:${item.id}`, responsibleAgentId: item.agent_id });
    const breachedAgreement = await client.query(`UPDATE world_agreements SET status='breached',updated_world_time=$3,
        updated_at=now() WHERE world_id=$1 AND id=$2 AND agreement_type<>'employment'
          AND status IN ('active','accepted') RETURNING id`, [worldId, item.agreement_id, worldTime]);
    await writeWorldHistory(client, { worldId, eventKey: `commitment:${item.id}:deadline`, eventType: 'agreement_breached',
      actorAgentId: item.agent_id, entityType: 'agreement', entityId: item.agreement_id, worldTime,
      title: 'Commitment missed its deadline', detail: item.description,
      metadata: { commitmentId: item.id, commitmentType: item.commitment_type, reason: 'missed_deadline',
        agreementStatusChanged: Boolean(breachedAgreement.rowCount) } });
  }
  const expiredProposals = await client.query(`UPDATE world_organization_proposals SET status='expired',resolved_world_time=$2,updated_at=now()
    WHERE world_id=$1 AND status='proposed' AND expires_world_time<=$2 RETURNING id,organization_id,proposer_agent_id`, [worldId, worldTime]);
  return { agreements: expiredOffers.rowCount, commitments: expiredCommitments.rowCount,
    supplierCommitmentsCreated, supplierFailures: resolvedSupplierFailures,
    organizationProposals: expiredProposals.rowCount };
}

export async function listWorldAgreements(client, { worldId, agentId = null, status = null, limit = 100 }) {
  const result = await client.query(`SELECT agreement.id,agreement.agreement_type AS "agreementType",
      agreement.proposer_agent_id AS "proposerAgentId",proposer.name AS "proposerName",
      agreement.counterparty_agent_id AS "counterpartyAgentId",counterparty.name AS "counterpartyName",
      agreement.terms,agreement.status,agreement.parent_agreement_id AS "parentAgreementId",
      agreement.negotiation_round AS "negotiationRound",agreement.created_world_time AS "createdWorldTime",
      agreement.accepted_world_time AS "acceptedWorldTime",agreement.expires_world_time AS "expiresWorldTime",
      agreement.completed_world_time AS "completedWorldTime",agreement.updated_world_time AS "updatedWorldTime",
      agreement.metadata
    FROM world_agreements agreement JOIN agents proposer ON proposer.id=agreement.proposer_agent_id
    JOIN agents counterparty ON counterparty.id=agreement.counterparty_agent_id
    WHERE agreement.world_id=$1 AND ($2::uuid IS NULL OR $2 IN (agreement.proposer_agent_id,agreement.counterparty_agent_id))
      AND ($3::text IS NULL OR agreement.status=$3)
    ORDER BY agreement.updated_world_time DESC,agreement.created_at DESC LIMIT $4`,
  [worldId, agentId, status, Math.max(1, Math.min(250, Math.trunc(limit) || 100))]);
  return result.rows;
}

export async function inferOrganizationGovernanceMode(client, { worldId, founderAgentId }) {
  const result = await client.query(`SELECT profile.primary_goal,profile.sociability,profile.assertiveness,
      COALESCE((SELECT skill_name FROM world_agent_skills skill WHERE skill.world_id=profile.world_id
        AND skill.agent_id=profile.agent_id ORDER BY skill.skill_value DESC,skill.skill_name LIMIT 1),'') AS top_skill
    FROM world_members member LEFT JOIN world_social_profiles profile
      ON profile.world_id=member.world_id AND profile.agent_id=member.agent_id
    WHERE member.world_id=$1 AND member.agent_id=$2`, [worldId, founderAgentId]);
  const row = result.rows[0] || {};
  const goal = String(row.primary_goal || '').toLowerCase();
  if (goal.includes('community') || goal.includes('social') || Number(row.sociability) >= 0.78) return 'member_vote';
  if (['research','engineering','trading'].includes(row.top_skill)) return 'skill_based';
  if (Number(row.assertiveness) <= 0.3) return 'delegated';
  return 'founder_led';
}

function institutionCandidate(agent, action, id, description, score, context = {}) {
  return { id: `institution:${id}`, action, targetLocation: agent.location || 'Town Commons',
    goal: description, description, score, institutional: true, ...context };
}

function relationshipFor(agent, otherAgentId) {
  return (agent.relationships || []).find((item) => item.otherAgentId === otherAgentId) || {};
}

function positiveAmount(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number.toFixed(8) : '0.01000000';
}

function offerCounter(agreement, side, reservation, referenceValue) {
  const terms = agreement.terms || {};
  const ratio = (key, multiplier, fallback) => positiveAmount(Math.max(0.01,
    Number(terms[key] || 0) * multiplier || Number(fallback) || 0.01));
  if (agreement.agreement_type === 'employment') {
    const target = side === 'worker' ? Math.max(reservation.threshold * 1.03, Number(terms.wageUsdc) * 1.05)
      : Math.min(reservation.threshold * 0.97, Number(terms.wageUsdc) * 0.95);
    return { wageUsdc: positiveAmount(target) };
  }
  if (agreement.agreement_type === 'service' || agreement.agreement_type === 'supplier_relationship') {
    const target = side === 'provider' ? Math.max(reservation.threshold, Number(terms.priceUsdc) * 1.05)
      : Math.min(reservation.threshold, Number(terms.priceUsdc) * 0.95);
    return { priceUsdc: positiveAmount(target), ...(terms.maxUnits ? { maxUnits: terms.maxUnits } : {}) };
  }
  if (agreement.agreement_type === 'investment') {
    const share = side === 'business_owner' ? Math.min(Number(terms.ownershipShare) * 0.95, reservation.threshold * 0.95)
      : Math.max(Number(terms.ownershipShare) * 1.05, reservation.threshold * 1.03);
    return { ownershipShare: round4(clamp(share, 0.0001, 0.95)) };
  }
  if (agreement.agreement_type === 'partnership') {
    if (side === 'seller') return { priceUsdc: positiveAmount(Math.max(reservation.threshold, Number(terms.priceUsdc) * 1.08)) };
    const share = Math.max(Number(terms.ownershipShare) * 1.05, reservation.threshold * 1.03);
    return { ownershipShare: round4(clamp(share, 0.0001, 0.95)),
      priceUsdc: ratio('priceUsdc', 0.92, Number(referenceValue) * share) };
  }
  return null;
}

function governanceVote(proposal, organization, cash, trust, reputation, skill) {
  const payload = proposal.payload || {};
  switch (proposal.proposal_type) {
    case 'rule_change': {
      if (payload.key === 'spending_limit_usdc') return Number(payload.value) > 0 ? 'support' : 'reject';
      if (payload.key === 'governance_mode') return ['member_vote','reputation_weighted','skill_based','delegated']
        .includes(payload.value) ? 'support' : 'reject';
      return 'abstain';
    }
    case 'leadership_change':
      return trust >= 8 || reputation > 2 || skill >= 75 ? 'support' : 'reject';
    case 'treasury_spend': {
      const limit = Number(organization.governance_rules?.spending_limit_usdc);
      return Number(payload.amountUsdc) <= cash && (!Number.isFinite(limit) || Number(payload.amountUsdc) <= limit)
        ? 'support' : 'reject';
    }
    case 'business_funding':
      return Number(payload.amountUsdc) <= cash ? 'support' : 'reject';
    case 'project_approval':
      return 'support';
    case 'member_change':
      return payload.decision === 'remove' && reputation < -2 ? 'support'
        : payload.decision === 'invite' && trust >= 2 ? 'support' : 'reject';
    default:
      return 'abstain';
  }
}

/**
 * A low-frequency institutional planner. Returned actions remain candidates;
 * the world engine qualifies them with the normal candidate set and Fruitfly
 * makes the final selection.
 */
export async function planInstitutionalAction(client, { worldId, agent, worldTime }) {
  // This planner's contract, investment, revenue-share, wage and treasury
  // candidates are denominated in the retired simulated-USDC economy. Native
  // Genesis Token business decisions use the explicit token-raw-unit candidates.
  const agentId = agent.agentId;
  const genesisCurrency = await readGenesisCurrencyActivation(client, worldId);
  if (genesisCurrency) {
    const incoming = await client.query(`SELECT agreement.*,business.founder_agent_id AS "founderAgentId",
        business.name AS "businessName"
      FROM world_agreements agreement JOIN world_businesses business
        ON business.world_id=agreement.world_id AND business.id=(agreement.terms->>'businessId')::uuid
      WHERE agreement.world_id=$1 AND agreement.counterparty_agent_id=$2 AND agreement.agreement_type='investment'
        AND agreement.status='proposed' AND agreement.terms->>'tokenId'=$3
        AND (agreement.expires_world_time IS NULL OR agreement.expires_world_time>$4)
      ORDER BY agreement.expires_world_time NULLS LAST,agreement.created_world_time,agreement.id LIMIT 1`,
    [worldId, agentId, genesisCurrency.tokenId, worldTime]);
    if (!incoming.rowCount || incoming.rows[0].founderAgentId !== agentId) return null;
    const agreement = incoming.rows[0];
    const relation = relationshipFor(agent, agreement.proposer_agent_id);
    const amountHuman = formatGenesisTokenRaw(agreement.terms.amountRaw, genesisCurrency.decimals);
    const share = Number(agreement.terms.ownershipShare);
    return institutionCandidate(agent, 'agreement_respond', `${agreement.id}:genesis-investment-review`,
      `Review whether to accept ${amountHuman} ${genesisCurrency.symbol} for ${share.toFixed(4)} of ${agreement.businessName}; acceptance waits for the investor wallet's Arc-confirmed transfer.`,
      44 + Math.min(18, Math.max(-10, Number(relation.trust) || 0) * 0.25),
      { agreementId: agreement.id, decision: 'accept',
        institutionalTrace: { agreementId: agreement.id, agreementType: 'investment',
          amountRaw: agreement.terms.amountRaw, tokenId: genesisCurrency.tokenId,
          ownershipShare: share, relationshipTrust: Number(relation.trust) || 0,
          pendingUntilArcConfirmation: true, tokenOwnershipAuthority: 'arc_chain_confirmation' } });
  }
  const cash = await getEconomicAccount(client, { worldId, accountType: 'resident', ownerId: agentId });
  const reputationResult = await client.query(`SELECT reliability::text AS reliability,professional::text AS professional,
      financial::text AS financial,cooperation::text AS cooperation
    FROM world_agent_reputations WHERE world_id=$1 AND agent_id=$2`, [worldId, agentId]);
  const reputation = reputationResult.rows[0] || {};
  const reliability = Number(reputation.reliability) || 0;
  const skill = Math.max(...Object.values(agent.skills || {}).map((value) => Number(value) || 0), 0);
  const wealth = Number(cash?.balance) || 0;

  const incoming = await client.query(`SELECT * FROM world_agreements WHERE world_id=$1 AND counterparty_agent_id=$2
      AND status='proposed' AND (expires_world_time IS NULL OR expires_world_time>$3)
    ORDER BY expires_world_time NULLS LAST,created_world_time,id LIMIT 1`, [worldId, agentId, worldTime]);
  if (incoming.rowCount) {
    const agreement = incoming.rows[0];
    const relationship = relationshipFor(agent, agreement.proposer_agent_id);
    let side = 'participant';
    let referenceValue = Number(agreement.terms.wageUsdc || agreement.terms.priceUsdc || agreement.terms.amountUsdc || 1);
    if (agreement.agreement_type === 'employment' && agreement.terms.employmentId) {
      const row = await client.query(`SELECT employment.agent_id AS worker_id,employment.wage_usdc::text AS wage,
          business.founder_agent_id AS founder_id,business.id AS business_id
        FROM world_business_employment employment JOIN world_businesses business ON business.world_id=employment.world_id
          AND business.id=employment.business_id WHERE employment.world_id=$1 AND employment.id=$2`,
      [worldId, agreement.terms.employmentId]);
      if (row.rowCount) {
        side = row.rows[0].worker_id === agentId ? 'worker' : 'employer';
        referenceValue = Number(row.rows[0].wage) || referenceValue;
        if (side === 'employer') {
          const businessCash = await getEconomicAccount(client, { worldId, accountType: 'business', ownerId: row.rows[0].business_id });
          agent.businessCash = Number(businessCash?.balance) || 0;
        }
      }
    } else if (['service','supplier_relationship'].includes(agreement.agreement_type)) {
      const service = await client.query(`SELECT service.base_price_usdc::text AS base_price,business.founder_agent_id
        FROM world_business_services service JOIN world_businesses business ON business.world_id=service.world_id
          AND business.id=service.business_id WHERE service.world_id=$1 AND service.id=$2`,
      [worldId, agreement.terms.serviceId]);
      if (service.rowCount) {
        side = service.rows[0].founder_agent_id === agentId ? 'provider' : 'customer';
        referenceValue = Number(service.rows[0].base_price) || referenceValue;
      }
    } else if (agreement.agreement_type === 'partnership') {
      side = agreement.terms.sellerAgentId === agentId ? 'seller' : 'buyer';
      referenceValue = Number(agreement.terms.priceUsdc) || referenceValue;
    } else if (agreement.agreement_type === 'investment') {
      const business = await client.query(`SELECT founder_agent_id FROM world_businesses
        WHERE world_id=$1 AND id=$2`, [worldId, agreement.terms.businessId]);
      side = business.rows[0]?.founder_agent_id === agentId ? 'business_owner' : 'investor';
    }
    const institutionType = agreement.terms.businessId ? 'business'
      : agreement.terms.organizationId ? 'organization' : null;
    const institutionId = agreement.terms.businessId || agreement.terms.organizationId || null;
    const institutionBeliefResult = institutionType ? await client.query(
      `SELECT estimate::text AS estimate,confidence::text AS confidence,sample_count AS "sampleCount"
        FROM world_institutional_beliefs WHERE world_id=$1 AND institution_type=$2 AND institution_id=$3
          AND belief_key='counterparty_reliability' AND subject_type='resident' AND subject_key=$4`,
      [worldId, institutionType, institutionId, agreement.proposer_agent_id]) : { rows: [] };
    const normResult = await client.query(`SELECT confidence::text AS confidence,support_count AS "supportCount",
        violation_count AS "violationCount"
      FROM world_social_norms WHERE world_id=$1 AND norm_key=$2 AND
        ((scope_type=$3 AND scope_id=$4::uuid) OR (scope_type='world' AND scope_id=$1))
      ORDER BY CASE WHEN scope_type=$3 AND scope_id=$4::uuid THEN 0 ELSE 1 END,
        updated_world_time DESC LIMIT 1`,
    [worldId, `${agreement.agreement_type}:honor_terms`, institutionType || 'world', institutionId || worldId]);
    const institutionalBelief = institutionBeliefResult.rows[0] || null;
    const socialNorm = normResult.rows[0] || null;
    const beliefSignal = Number(institutionalBelief?.estimate || 0) * Number(institutionalBelief?.confidence || 0);
    const normSamples = Number(socialNorm?.supportCount || 0) + Number(socialNorm?.violationCount || 0);
    const normSignal = normSamples > 0
      ? (Number(socialNorm.supportCount) - Number(socialNorm.violationCount)) / (normSamples + 2)
        * Number(socialNorm.confidence || 0) : 0;
    const negotiationAdjustment = clamp(beliefSignal * 0.06 + normSignal * 0.04, -0.05, 0.05);
    const reservation = reservationValue({ agreementType: agreement.agreement_type, side, terms: agreement.terms,
      resident: { ...agent, wealth, reliability, usdc: wealth }, relationship,
      alternatives: { referenceValue, count: agent.alternatives?.count || 0 } });
    const maximumThreshold = ['employer','customer','buyer'].includes(side);
    const adjustedThreshold = round4(Number(reservation.threshold)
      * (maximumThreshold ? 1 + negotiationAdjustment : 1 - negotiationAdjustment));
    const financialLimit = Number(reservation.financialLimit);
    const financialOffer = agreement.agreement_type === 'investment' ? Number(agreement.terms.amountUsdc)
      : agreement.agreement_type === 'partnership' ? Number(agreement.terms.priceUsdc) : null;
    const withinFinancialLimit = !Number.isFinite(financialLimit) || !Number.isFinite(financialOffer)
      || financialOffer <= financialLimit;
    const adjustedReservation = { ...reservation, threshold: adjustedThreshold,
      acceptable: (maximumThreshold ? Number(reservation.offer) <= adjustedThreshold
        : Number(reservation.offer) >= adjustedThreshold) && withinFinancialLimit };
    const financialNeed = agreement.agreement_type === 'investment' ? Number(agreement.terms.amountUsdc) || 0
      : ['service','supplier_relationship','partnership'].includes(agreement.agreement_type)
        && ['customer','buyer'].includes(side) ? Number(agreement.terms.priceUsdc) || 0 : 0;
    const canFund = financialNeed <= wealth;
    let decision = adjustedReservation.acceptable && canFund ? 'accept' : 'reject';
    let counterTerms = null;
    if ((!adjustedReservation.acceptable || !canFund) && agreement.agreement_type !== 'investment'
        && Number(agreement.negotiation_round) < 8
        && worldTime - Number(agreement.created_world_time) >= 10) {
      counterTerms = offerCounter(agreement, side, adjustedReservation, referenceValue);
      if (counterTerms?.priceUsdc && ['customer','buyer'].includes(side)) {
        if (wealth >= 0.01) counterTerms.priceUsdc = positiveAmount(Math.min(Number(counterTerms.priceUsdc), wealth));
        else counterTerms = null;
      }
      if (counterTerms && Object.entries(counterTerms).some(([key, value]) =>
        Number(value) && Math.abs(Number(value) - Number(agreement.terms[key])) > 0.005)) decision = 'counter';
      else counterTerms = null;
    }
    return institutionCandidate(agent, 'agreement_respond', `${agreement.id}:response`,
      `${decision === 'accept' ? 'Review and accept' : decision === 'counter' ? 'Counter' : 'Decline'} a ${agreement.agreement_type.replaceAll('_',' ')} proposal`,
      100, { agreementId: agreement.id, decision, counterTerms,
        institutionalTrace: { agreementId: agreement.id, agreementType: agreement.agreement_type, side,
          decision, reservation: adjustedReservation, fundsAvailable: wealth, financialNeed, canFund,
          relationshipTrust: Number(relationship.trust) || 0,
          institutionType, institutionId, institutionalBelief, socialNorm, negotiationAdjustment,
          evidence: { reputation, templateReference: referenceValue } } });
  }

  const commitment = await client.query(`SELECT commitment.*,agreement.agreement_type,agreement.terms,
      agreement.metadata AS agreement_metadata
    FROM world_commitments commitment JOIN world_agreements agreement ON agreement.world_id=commitment.world_id
      AND agreement.id=commitment.agreement_id
    WHERE commitment.world_id=$1 AND commitment.agent_id=$2 AND commitment.status='active'
    ORDER BY CASE WHEN commitment.commitment_type='delivery'
      AND agreement.agreement_type IN ('service','supplier_relationship') THEN 0 ELSE 1 END,
      commitment.due_world_time,commitment.id LIMIT 1`, [worldId, agentId]);
  if (commitment.rowCount) {
    const duty = commitment.rows[0];
    if (duty.commitment_type === 'delivery' && ['service','supplier_relationship'].includes(duty.agreement_type)) {
      const supplier = await client.query(`SELECT business.id AS business_id,business.status AS business_status,
          business.name AS business_name,business.founder_agent_id,service.id AS service_id,
          service.name AS service_name,service.service_type,service.active AS service_active,
          service.stock_units,place.name AS place_name,place.status AS place_status
        FROM world_businesses business LEFT JOIN world_business_services service
          ON service.world_id=business.world_id AND service.business_id=business.id
            AND service.id=(SELECT agreement.terms->>'serviceId' FROM world_agreements agreement
              WHERE agreement.world_id=$1 AND agreement.id=$2)::uuid
        LEFT JOIN world_scenes place ON place.world_id=business.world_id AND place.id=business.place_id
        WHERE business.world_id=$1 AND business.id=$3`, [worldId, duty.agreement_id, duty.terms.businessId]);
      const provider = supplier.rows[0];
      if (!provider || provider.business_status !== 'active') return institutionCandidate(agent,
        'commitment_resolve', `${duty.id}:provider-closed`, 'Resolve a supplier obligation whose business has closed', 125,
        { commitmentId: duty.id, outcome: 'unable', institutionalTrace: { agreementId: duty.agreement_id,
          commitmentId: duty.id, reason: 'PROVIDER_CLOSED' } });
      if (!provider.service_active || (provider.place_name && provider.place_status !== 'active')) return institutionCandidate(agent,
        'commitment_resolve', `${duty.id}:service-unavailable`, 'Resolve a supplier obligation whose service venue is unavailable', 125,
        { commitmentId: duty.id, outcome: 'unable', institutionalTrace: { agreementId: duty.agreement_id,
          commitmentId: duty.id, reason: 'NO_REQUIRED_PLACE' } });
      if (Number(provider.stock_units) < 1) {
        if (Number(duty.due_world_time) > worldTime && Number(duty.due_world_time) <= worldTime + 1_440
            && !duty.agreement_metadata?.renegotiationPending) {
          const fulfilled = await client.query(`SELECT count(*)::int AS count FROM world_commitments WHERE world_id=$1
            AND agreement_id=$2 AND commitment_type='service' AND status='fulfilled'`, [worldId, duty.agreement_id]);
          const remainingUnits = Math.max(1, agreementUnitLimit(duty.terms) - Number(fulfilled.rows[0]?.count || 0));
          const revisedTerms = { ...duty.terms, deliveryDelayWorldMinutes: Math.min(43_200,
            Math.max(8_640, (Number(duty.terms.deliveryDelayWorldMinutes) || 4_320) * 2)) };
          if (duty.agreement_type === 'supplier_relationship') revisedTerms.maxUnits = remainingUnits;
          else revisedTerms.units = remainingUnits;
          return institutionCandidate(agent, 'agreement_propose', `${duty.agreement_id}:capacity-renegotiation`,
            'Ask the customer to revise the delivery window after production capacity fell short', 104,
            { counterpartyAgentId: duty.counterparty_agent_id, agreementType: duty.agreement_type,
              agreementTerms: revisedTerms, parentAgreementId: duty.agreement_id, expiresInWorldMinutes: 720,
              institutionalTrace: { agreementId: duty.agreement_id, commitmentId: duty.id,
                reason: 'CAPACITY_SHORTAGE', stockUnits: Number(provider.stock_units),
                revisedDeliveryDelayWorldMinutes: revisedTerms.deliveryDelayWorldMinutes } });
        }
        if (Number(agent.energy) < 20 || Number(agent.food) < 12) {
          await recordAgreementExecutionStage(client, { worldId, agreementId: duty.agreement_id,
            stage: 'blocked', worldTime, agentId, eventKey: `needs:${duty.id}:${Math.floor(worldTime / 360)}`,
            reasonCode: Number(agent.energy) < 20 ? 'ENERGY_LOW' : 'FOOD_LOW',
            details: { commitmentId: duty.id, currentEnergy: Number(agent.energy) || 0,
              currentFood: Number(agent.food) || 0, requiredEnergy: 20, requiredFood: 12 } });
        } else {
          return institutionCandidate(agent, 'business_work', `${duty.id}:contract-production`,
            `Produce one ${provider.service_name} unit for the supplier contract`, 120,
            { businessId: provider.business_id, serviceId: provider.service_id, commitmentId: duty.id,
              contractAgreementId: duty.agreement_id, targetLocation: provider.place_name || agent.location,
              institutionalTrace: { agreementId: duty.agreement_id, commitmentId: duty.id,
                businessId: provider.business_id, serviceId: provider.service_id,
                inventory: Number(provider.stock_units) || 0, action: 'business_work' } });
        }
      } else {
        await recordAgreementExecutionStage(client, { worldId, agreementId: duty.agreement_id,
          stage: 'delivery_ready', worldTime, agentId,
          eventKey: `ready:${duty.id}:${Number(provider.stock_units)}`,
          details: { commitmentId: duty.id, businessId: provider.business_id, serviceId: provider.service_id,
            stockUnits: Number(provider.stock_units), customerAgentId: duty.counterparty_agent_id } });
      }
    }
    if (duty.commitment_type === 'work' && duty.agreement_type === 'employment') {
      const job = await client.query(`SELECT employment.business_id,employment.id AS employment_id,job.id AS service_id,
          job.active AS service_active,business.status AS business_status
        FROM world_business_employment employment JOIN world_businesses business ON business.world_id=employment.world_id
          AND business.id=employment.business_id JOIN world_business_services job ON job.world_id=business.world_id
          AND job.business_id=business.id
        WHERE employment.world_id=$1 AND employment.id=$2 AND employment.agent_id=$3 AND employment.status='active'
          AND business.status='active' AND job.active=true ORDER BY job.id LIMIT 1`,
      [worldId, duty.terms.employmentId, agentId]);
      if (job.rowCount) return institutionCandidate(agent, 'business_work', `${duty.id}:work`,
        'Complete a promised paid production shift', 120, { businessId: job.rows[0].business_id,
          serviceId: job.rows[0].service_id, employmentId: job.rows[0].employment_id,
          commitmentId: duty.id, institutionalTrace: { commitmentId: duty.id, dueWorldTime: Number(duty.due_world_time), action: 'work' } });
    }
    if (Number(duty.due_world_time) <= worldTime + 60) return institutionCandidate(agent, 'commitment_resolve',
      `${duty.id}:unavailable`, 'Review a commitment that is approaching its deadline', 115,
      { commitmentId: duty.id, outcome: 'unable', institutionalTrace: { commitmentId: duty.id,
        commitmentType: duty.commitment_type, dueWorldTime: Number(duty.due_world_time), reason: 'capacity_review' } });
  }

  const openVote = await client.query(`SELECT proposal.*,organization.name AS organization_name,
      organization.governance_mode,organization.governance_rules,organization.founder_agent_id,
      member.role,COALESCE(account.balance,0)::text AS treasury_cash,
      COALESCE(peer.reliability,0)::text AS target_reliability,COALESCE(peer.cooperation,0)::text AS target_cooperation,
      COALESCE((SELECT max(skill_value) FROM world_agent_skills WHERE world_id=proposal.world_id
        AND agent_id=$2),0)::text AS skill
    FROM world_organization_proposals proposal JOIN world_organizations organization
      ON organization.world_id=proposal.world_id AND organization.id=proposal.organization_id
    JOIN world_organization_members member ON member.world_id=proposal.world_id
      AND member.organization_id=proposal.organization_id AND member.agent_id=$2 AND member.status='active'
    LEFT JOIN world_economic_accounts account ON account.world_id=organization.world_id
      AND account.account_key='organization:'||organization.id::text AND account.asset_symbol='USDC'
    LEFT JOIN world_agent_reputations peer ON peer.world_id=proposal.world_id AND peer.agent_id=(proposal.payload->>'memberAgentId')::uuid
    WHERE proposal.world_id=$1 AND proposal.status='proposed' AND proposal.proposer_agent_id<>$2
      AND proposal.expires_world_time>$3
      AND NOT EXISTS (SELECT 1 FROM world_organization_proposal_votes vote WHERE vote.proposal_id=proposal.id AND vote.agent_id=$2)
    ORDER BY proposal.expires_world_time,proposal.created_world_time,proposal.id LIMIT 1`, [worldId, agentId, worldTime]);
  if (openVote.rowCount) {
    const proposal = openVote.rows[0];
    const members = await client.query(`SELECT member.agent_id,member.role,
        COALESCE(max(skill.skill_value),0)::numeric AS skill
      FROM world_organization_members member LEFT JOIN world_agent_skills skill
        ON skill.world_id=member.world_id AND skill.agent_id=member.agent_id
      WHERE member.world_id=$1 AND member.organization_id=$2 AND member.status='active'
      GROUP BY member.agent_id,member.role`, [worldId, proposal.organization_id]);
    const eligible = proposal.governance_mode === 'founder_led' ? proposal.founder_agent_id === agentId
      : proposal.governance_mode === 'delegated' ? ['founder','coordinator'].includes(proposal.role)
        : proposal.governance_mode === 'skill_based'
          ? Number(proposal.skill) >= Math.max(...members.rows.map((member) => Number(member.skill) || 0)) : true;
    if (eligible) {
      const decision = governanceVote(proposal, proposal, Number(proposal.treasury_cash) || 0,
        Number(relationshipFor(agent, proposal.payload.memberAgentId).trust) || 0,
        (Number(proposal.target_reliability) || 0) + (Number(proposal.target_cooperation) || 0), Number(proposal.skill) || 0);
      return institutionCandidate(agent, 'organization_vote', `${proposal.id}:vote`,
        `${decision === 'support' ? 'Support' : decision === 'reject' ? 'Reject' : 'Abstain on'} an organization proposal`,
        95, { proposalId: proposal.id, decision,
          institutionalTrace: { proposalId: proposal.id, proposalType: proposal.proposal_type,
            governanceMode: proposal.governance_mode, decision, treasuryCash: Number(proposal.treasury_cash) || 0 } });
    }
  }

  const contractedPurchases = await client.query(`SELECT agreement.id AS agreement_id,agreement.terms,
      service.id AS service_id,service.name AS service_name,service.service_type,service.stock_units,
      business.name AS business_name,business.founder_agent_id,place.name AS place_name
    FROM world_agreements agreement JOIN world_businesses business
      ON business.world_id=agreement.world_id AND business.id=(agreement.terms->>'businessId')::uuid
        AND business.status='active'
    JOIN world_business_services service ON service.world_id=business.world_id AND service.business_id=business.id
      AND service.id=(agreement.terms->>'serviceId')::uuid AND service.active=true
    LEFT JOIN world_scenes place ON place.world_id=business.world_id AND place.id=business.place_id
    WHERE agreement.world_id=$1 AND agreement.status='active'
      AND agreement.agreement_type IN ('service','supplier_relationship')
      AND (agreement.terms->>'customerAgentId'=$2::text OR
        (agreement.terms->>'customerAgentId' IS NULL AND
          CASE WHEN business.founder_agent_id=agreement.proposer_agent_id THEN agreement.counterparty_agent_id
            ELSE agreement.proposer_agent_id END=$2::uuid))
      AND agreement.proposer_agent_id<>agreement.counterparty_agent_id
    ORDER BY agreement.accepted_world_time,agreement.id`, [worldId, agentId]);
  for (const contract of contractedPurchases.rows) {
    if (contract.founder_agent_id === agentId) continue;
    const limit = agreementUnitLimit(contract.terms);
    const delivered = await client.query(`SELECT count(*)::int AS count FROM world_commitments WHERE world_id=$1
      AND agreement_id=$2 AND commitment_type='service' AND status='fulfilled'`, [worldId, contract.agreement_id]);
    if (Number(delivered.rows[0]?.count || 0) >= limit) continue;
    if (Number(contract.stock_units) < 1) {
      await recordAgreementExecutionStage(client, { worldId, agreementId: contract.agreement_id,
        stage: 'blocked', worldTime, agentId,
        eventKey: `buyer-inventory:${agentId}:${Math.floor(worldTime / INSTITUTIONAL_RETRY_WORLD_MINUTES)}`,
        reasonCode: 'NO_PROVIDER_INVENTORY',
        details: { businessId: contract.terms.businessId, serviceId: contract.service_id,
          stockUnits: Number(contract.stock_units) || 0 } });
      await scheduleInstitutionalRetry(client, { worldId, agentId, worldTime });
      continue;
    }
    if (!serviceNeedIsPresent(contract.service_type, agent)) {
      await recordAgreementExecutionStage(client, { worldId, agreementId: contract.agreement_id,
        stage: 'blocked', worldTime, agentId,
        eventKey: `buyer-need:${agentId}:${Math.floor(worldTime / 360)}`, reasonCode: 'NO_CUSTOMER_DEMAND',
        details: { serviceId: contract.service_id, serviceType: contract.service_type,
          stockUnits: Number(contract.stock_units) } });
      await scheduleInstitutionalRetry(client, { worldId, agentId, worldTime });
      continue;
    }
    const price = Number(contract.terms.priceUsdc) || 0;
    if (wealth < price) {
      await recordAgreementExecutionStage(client, { worldId, agreementId: contract.agreement_id,
        stage: 'blocked', worldTime, agentId,
        eventKey: `buyer-funds:${agentId}:${Math.floor(worldTime / 360)}`, reasonCode: 'NO_FUNDS',
        details: { priceUsdc: contract.terms.priceUsdc, availableUsdc: wealth } });
      await scheduleInstitutionalRetry(client, { worldId, agentId, worldTime });
      continue;
    }
    return institutionCandidate(agent, 'business_service', `${contract.agreement_id}:purchase:${Number(delivered.rows[0]?.count || 0) + 1}`,
      `Purchase ${contract.service_name} from the supplier under the agreed price`, 118,
      { businessId: contract.terms.businessId, serviceId: contract.service_id,
        maxPriceUsdc: contract.terms.priceUsdc, contractAgreementId: contract.agreement_id,
        targetLocation: contract.place_name || agent.location,
        institutionalTrace: { agreementId: contract.agreement_id, serviceId: contract.service_id,
          customerAgentId: agentId, providerAgentId: contract.founder_agent_id,
          stockUnits: Number(contract.stock_units), priceUsdc: contract.terms.priceUsdc, action: 'business_service' } });
  }

  const contractedEmployeeWork = await client.query(`SELECT commitment.id AS commitment_id,commitment.agreement_id,
      commitment.due_world_time,business.id AS business_id,service.id AS service_id,employment.id AS employment_id,
      service.name AS service_name,service.stock_units,place.name AS place_name
    FROM world_business_employment employment JOIN world_businesses business
      ON business.world_id=employment.world_id AND business.id=employment.business_id AND business.status='active'
    JOIN world_business_services service ON service.world_id=business.world_id AND service.business_id=business.id
      AND service.active=true AND service.stock_units<1
    JOIN world_commitments commitment ON commitment.world_id=employment.world_id
      AND commitment.agent_id=business.founder_agent_id AND commitment.status='active'
      AND commitment.commitment_type='delivery'
    JOIN world_agreements agreement ON agreement.world_id=commitment.world_id AND agreement.id=commitment.agreement_id
      AND agreement.status='active' AND agreement.agreement_type IN ('service','supplier_relationship')
      AND agreement.terms->>'businessId'=business.id::text AND agreement.terms->>'serviceId'=service.id::text
    LEFT JOIN world_scenes place ON place.world_id=business.world_id AND place.id=business.place_id
    WHERE employment.world_id=$1 AND employment.agent_id=$2 AND employment.status='active'
      AND NOT EXISTS (SELECT 1 FROM world_commitments own WHERE own.world_id=employment.world_id
        AND own.agent_id=employment.agent_id AND own.status='active')
    ORDER BY commitment.due_world_time,commitment.id LIMIT 1`, [worldId, agentId]);
  if (contractedEmployeeWork.rowCount && Number(agent.energy) >= 20 && Number(agent.food) >= 12) {
    const row = contractedEmployeeWork.rows[0];
    return institutionCandidate(agent, 'business_work', `${row.commitment_id}:employee-production`,
      `Produce one ${row.service_name} unit as a paid shift to fulfill the supplier agreement`, 116,
      { businessId: row.business_id, serviceId: row.service_id, employmentId: row.employment_id,
        contractAgreementId: row.agreement_id, commitmentId: row.commitment_id,
        targetLocation: row.place_name || agent.location,
        institutionalTrace: { agreementId: row.agreement_id, commitmentId: row.commitment_id,
          businessId: row.business_id, serviceId: row.service_id, employmentId: row.employment_id,
          stockUnits: Number(row.stock_units), action: 'business_work', hiringReason: 'FULFILL_CONTRACT' } });
  }

  const activeCommitments = Number((await client.query(`SELECT count(*)::int AS count FROM world_commitments
    WHERE world_id=$1 AND agent_id=$2 AND status='active'`, [worldId, agentId])).rows[0]?.count || 0);
  if (activeCommitments > 0) {
    await scheduleInstitutionalRetry(client, { worldId, agentId, worldTime });
    return null;
  }

  const supplier = await client.query(`SELECT business.id AS business_id,service.id AS service_id,business.founder_agent_id,
        business.name AS business_name,service.name AS service_name,service.service_type,
        avg(order_row.price_usdc)::numeric(30,8)::text AS price,count(*)::int AS purchases
      FROM world_business_orders order_row JOIN world_business_services service
        ON service.world_id=order_row.world_id AND service.id=order_row.service_id
      JOIN world_businesses business ON business.world_id=service.world_id AND business.id=service.business_id
      WHERE order_row.world_id=$1 AND order_row.customer_agent_id=$2 AND order_row.status='fulfilled'
        AND business.status='active' AND service.active=true AND business.founder_agent_id<>$2
        AND NOT EXISTS (SELECT 1 FROM world_agreements agreement WHERE agreement.world_id=$1
          AND agreement.agreement_type IN ('service','supplier_relationship')
          AND agreement.terms->>'businessId'=business.id::text AND agreement.terms->>'serviceId'=service.id::text
          AND $2 IN (agreement.proposer_agent_id,agreement.counterparty_agent_id)
          AND agreement.status IN ('proposed','countered','accepted','active'))
        AND NOT EXISTS (SELECT 1 FROM world_agreements recent WHERE recent.world_id=$1
          AND recent.agreement_type='supplier_relationship' AND recent.terms->>'businessId'=business.id::text
          AND recent.terms->>'serviceId'=service.id::text AND $2 IN (recent.proposer_agent_id,recent.counterparty_agent_id)
          AND recent.created_world_time>$3-4320)
      GROUP BY business.id,service.id HAVING count(*)>=2
      ORDER BY count(*) DESC,business.id,service.id LIMIT 1`, [worldId, agentId, worldTime]);
  if (supplier.rowCount) {
    const row = supplier.rows[0];
    const relationship = relationshipFor(agent, row.founder_agent_id);
    if (Number(relationship.trust) >= 1 || Number(row.purchases) >= 4) {
      return institutionCandidate(agent, 'agreement_propose', `${row.business_id}:${row.service_id}:supplier`,
        `Propose a repeat supplier agreement with ${row.business_name}`, 54,
        { counterpartyAgentId: row.founder_agent_id, agreementType: 'supplier_relationship',
          agreementTerms: { businessId: row.business_id, serviceId: row.service_id,
            customerAgentId: agentId, priceUsdc: row.price, maxUnits: 4 },
          institutionalTrace: { agreementType: 'supplier_relationship', purchases: Number(row.purchases),
            businessId: row.business_id, serviceId: row.service_id } });
    }
  }

  const employment = await client.query(`SELECT employment.id AS employment_id,employment.agent_id,employment.business_id,
      employment.job_id,employment.wage_usdc::text AS wage,employment.started_world_time,business.founder_agent_id,
      job.role,COALESCE(production.shifts,0)::int AS shifts,
      COALESCE(template.terms->>'wageReferenceUsdc',employment.wage_usdc::text) AS reference_wage
    FROM world_business_employment employment JOIN world_businesses business
      ON business.world_id=employment.world_id AND business.id=employment.business_id
    JOIN world_business_jobs job ON job.world_id=employment.world_id AND job.id=employment.job_id
    LEFT JOIN LATERAL (SELECT count(*)::int AS shifts FROM world_business_production
      WHERE world_id=employment.world_id AND employment_id=employment.id) production ON true
    LEFT JOIN world_agreement_templates template ON template.world_id=employment.world_id
      AND template.scope_type='business' AND template.scope_id=employment.business_id
      AND template.agreement_type='employment' AND template.template_key='paid-shift-v1'
    WHERE employment.world_id=$1 AND employment.agent_id=$2 AND employment.status='active'
      AND business.status='active' AND $3-employment.started_world_time>=720
      AND COALESCE(production.shifts,0)>=3
      AND NOT EXISTS (SELECT 1 FROM world_agreements agreement WHERE agreement.world_id=$1
        AND agreement.agreement_type='employment' AND agreement.terms->>'employmentId'=employment.id::text
        AND agreement.status IN ('proposed','countered') AND agreement.created_world_time>$3-1440)
    ORDER BY production.shifts DESC,employment.started_world_time LIMIT 1`, [worldId, agentId, worldTime]);
  if (employment.rowCount) {
    const row = employment.rows[0];
    const trust = Number(relationshipFor(agent, row.founder_agent_id).trust) || 0;
    const raise = clamp((skill / 500) + Math.max(-0.02, Math.min(0.05, trust / 500))
      + Math.min(0.04, (worldTime - Number(row.started_world_time)) / 18_000)
      + clamp(reliability, -20, 20) / 1_000, 0.05, 0.18);
    const wage = positiveAmount(Math.max(Number(row.wage) + 0.01, Number(row.wage) * (1 + raise)));
    return institutionCandidate(agent, 'agreement_propose', `${row.employment_id}:wage:${Math.floor(worldTime / 1440)}`,
      `Request a wage review after ${row.shifts} completed shifts`, 50,
      { counterpartyAgentId: row.founder_agent_id, agreementType: 'employment',
        agreementTerms: { employmentId: row.employment_id, businessId: row.business_id,
          jobId: row.job_id, wageUsdc: wage, role: row.role },
        institutionalTrace: { agreementType: 'employment', employmentId: row.employment_id,
          completedShifts: Number(row.shifts), wageUsdc: row.wage, templateReference: row.reference_wage,
          requestedWageUsdc: wage, relationshipTrust: trust, reliability } });
  }

  const organization = await client.query(`SELECT organization.id,organization.name,organization.governance_mode,
      organization.governance_rules,organization.founder_agent_id,count(DISTINCT member.agent_id)::int AS members,
      account.balance::text AS treasury_cash
    FROM world_organization_members member JOIN world_organizations organization
      ON organization.world_id=member.world_id AND organization.id=member.organization_id
    LEFT JOIN world_economic_accounts account ON account.world_id=organization.world_id
      AND account.account_key='organization:'||organization.id::text AND account.asset_symbol='USDC'
    WHERE member.world_id=$1 AND member.agent_id=$2 AND member.status='active' AND organization.status='active'
      AND NOT (organization.governance_rules ? 'spending_limit_usdc')
      AND COALESCE(account.balance,0)>=20
      AND NOT EXISTS (SELECT 1 FROM world_organization_proposals proposal WHERE proposal.world_id=$1
        AND proposal.organization_id=organization.id AND (proposal.status='proposed' OR
          (proposal.proposal_type='rule_change' AND proposal.payload->>'key'='spending_limit_usdc'
            AND proposal.created_world_time>$3-1440)))
    GROUP BY organization.id,account.balance ORDER BY organization.created_world_time,organization.id LIMIT 1`,
  [worldId, agentId, worldTime]);
  if (organization.rowCount && (Number(agent.discipline) >= 0.35 || Number(agent.sociability) >= 0.65)) {
    const row = organization.rows[0];
    const limit = positiveAmount(Math.max(1, Number(row.treasury_cash) * 0.35));
    return institutionCandidate(agent, 'organization_propose', `${row.id}:spending-limit:${Math.floor(worldTime / 1440)}`,
      `Propose a treasury spending rule for ${row.name}`, 42,
      { organizationId: row.id, proposalType: 'rule_change', proposalPayload: { key: 'spending_limit_usdc', value: limit },
        institutionalTrace: { proposalType: 'rule_change', key: 'spending_limit_usdc', value: limit,
          organizationId: row.id, memberCount: Number(row.members), treasuryCash: Number(row.treasury_cash) } });
  }
  return null;
}

function normalizeOrganizationPayload(type, value) {
  const input = jsonObject(value, 'organization_proposal');
  if (type === 'rule_change') {
    const key = String(input.key || '');
    if (!['membership_threshold','spending_limit_usdc','default_revenue_share_bps','preferred_supplier_id','governance_mode'].includes(key)) {
      throw institutionError('ORGANIZATION_RULE_KEY_INVALID', 400);
    }
    let next = input.value;
    if (key === 'membership_threshold') next = boundedNumber(next, 0, 100, 'membership_threshold');
    else if (key === 'spending_limit_usdc') next = normalizeAmount(next, 'spending_limit_usdc', { max: '1000000' });
    else if (key === 'default_revenue_share_bps') next = Math.trunc(boundedNumber(next, 0, 5000, 'revenue_share_bps'));
    else if (key === 'preferred_supplier_id' && next !== null && !UUID_RE.test(String(next))) throw institutionError('PREFERRED_SUPPLIER_ID_INVALID', 400);
    else if (key === 'governance_mode' && !['founder_led','member_vote','reputation_weighted','skill_based','delegated'].includes(String(next))) {
      throw institutionError('GOVERNANCE_MODE_INVALID', 400);
    }
    return { key, value: next };
  }
  if (type === 'leadership_change') {
    if (!UUID_RE.test(String(input.newLeaderAgentId))) throw institutionError('NEW_LEADER_ID_INVALID', 400);
    return { newLeaderAgentId: input.newLeaderAgentId };
  }
  if (type === 'treasury_spend') {
    if (!UUID_RE.test(String(input.recipientAgentId))) throw institutionError('TREASURY_RECIPIENT_ID_INVALID', 400);
    return { recipientAgentId: input.recipientAgentId, amountUsdc: normalizeAmount(input.amountUsdc, 'amount_usdc') };
  }
  if (type === 'project_approval') {
    if (!UUID_RE.test(String(input.projectId))) throw institutionError('PROJECT_ID_INVALID', 400);
    return { projectId: input.projectId };
  }
  if (type === 'business_funding') {
    if (!UUID_RE.test(String(input.businessId))) throw institutionError('BUSINESS_ID_INVALID', 400);
    return { businessId: input.businessId, amountUsdc: normalizeAmount(input.amountUsdc, 'amount_usdc'),
      ownershipShare: boundedNumber(input.ownershipShare ?? 0, 0, 0.95, 'ownership_share') };
  }
  if (type === 'member_change') {
    if (!UUID_RE.test(String(input.memberAgentId)) || !['invite','remove'].includes(input.decision)) {
      throw institutionError('MEMBER_CHANGE_INVALID', 400);
    }
    return { memberAgentId: input.memberAgentId, decision: input.decision };
  }
  throw institutionError('ORGANIZATION_PROPOSAL_TYPE_INVALID', 400);
}

export async function proposeOrganizationGovernance(client, { worldId, organizationId, proposerAgentId, proposalType,
  payload, actionId, worldTime, expiresInWorldMinutes = 1_440, parentProposalId = null }) {
  await requireWorldMember(client, worldId, proposerAgentId);
  const type = String(proposalType || '').toLowerCase();
  if (!['rule_change','leadership_change','treasury_spend','project_approval','business_funding','member_change'].includes(type)) {
    throw institutionError('ORGANIZATION_PROPOSAL_TYPE_INVALID', 400);
  }
  if (await isGenesisCurrencyActive(client, worldId)
      && ['treasury_spend','business_funding'].includes(type)) {
    throw institutionError('LEGACY_SIMULATED_ECONOMY_RETIRED', 409);
  }
  const key = actionIdentifier(actionId);
  const normalized = normalizeOrganizationPayload(type, payload);
  const expires = worldTime + Math.trunc(boundedNumber(expiresInWorldMinutes, 1, 43_200, 'proposal_expiry'));
  const organization = await client.query(`SELECT * FROM world_organizations WHERE world_id=$1 AND id=$2 FOR UPDATE`,
    [worldId, organizationId]);
  if (!organization.rowCount || !['forming','active','dormant'].includes(organization.rows[0].status)) {
    throw institutionError('ORGANIZATION_NOT_ACTIVE', 404);
  }
  const spendingLimit = Number(organization.rows[0].governance_rules?.spending_limit_usdc);
  const requestedSpend = type === 'treasury_spend' ? Number(normalized.amountUsdc)
    : type === 'business_funding' ? Number(normalized.amountUsdc) : 0;
  if (Number.isFinite(spendingLimit) && requestedSpend > spendingLimit) {
    throw institutionError('ORGANIZATION_SPENDING_LIMIT_EXCEEDED');
  }
  const member = await client.query(`SELECT 1 FROM world_organization_members WHERE world_id=$1 AND organization_id=$2
    AND agent_id=$3 AND status='active' FOR UPDATE`, [worldId, organizationId, proposerAgentId]);
  if (!member.rowCount) throw institutionError('ACTIVE_ORGANIZATION_MEMBERSHIP_REQUIRED', 403);
  const existing = await client.query(`SELECT id,status FROM world_organization_proposals WHERE world_id=$1
    AND proposer_agent_id=$2 AND action_id=$3`, [worldId, proposerAgentId, key]);
  if (existing.rowCount) return { ...existing.rows[0], idempotent: true };
  const openCount = await client.query(`SELECT count(*)::int AS count FROM world_organization_proposals
    WHERE world_id=$1 AND organization_id=$2 AND status='proposed'`, [worldId, organizationId]);
  if (Number(openCount.rows[0].count) >= 10) throw institutionError('ORGANIZATION_PROPOSAL_CAPACITY_REACHED');
  const row = await client.query(`INSERT INTO world_organization_proposals(world_id,organization_id,proposer_agent_id,
      proposal_type,payload,parent_proposal_id,action_id,created_world_time,expires_world_time,metadata)
    VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10::jsonb) RETURNING *`,
  [worldId, organizationId, proposerAgentId, type, JSON.stringify(normalized), parentProposalId, key, worldTime, expires,
    JSON.stringify({ governanceMode: organization.rows[0].governance_mode })]);
  await client.query(`INSERT INTO world_organization_proposal_votes(proposal_id,organization_id,agent_id,decision,action_id,world_time)
    VALUES($1,$2,$3,'support',$4,$5) ON CONFLICT DO NOTHING`, [row.rows[0].id, organizationId, proposerAgentId, `${key}:proposer`, worldTime]);
  await writeWorldHistory(client, { worldId, eventKey: `org-proposal:${row.rows[0].id}:proposed`, eventType: 'organization_proposal',
    actorAgentId: proposerAgentId, entityType: 'organization', entityId: organizationId, worldTime,
    title: `Organization proposed ${type.replaceAll('_',' ')}`, detail: 'An active member opened a bounded governance proposal.',
    metadata: { proposalId: row.rows[0].id, proposalType: type, payload: normalized, expiresWorldTime: expires } });
  return row.rows[0];
}

async function applyOrganizationProposal(client, proposal, organization, worldTime) {
  const payload = proposal.payload;
  const genesisCurrencyActive = await isGenesisCurrencyActive(client, proposal.world_id);
  if (proposal.proposal_type === 'rule_change') {
    const rules = { ...(organization.governance_rules || {}), [payload.key]: payload.value };
    if (payload.key === 'governance_mode') {
      await client.query(`UPDATE world_organizations SET governance_mode=$3,updated_world_time=$4,updated_at=now()
        WHERE world_id=$1 AND id=$2`, [proposal.world_id, proposal.organization_id, payload.value, worldTime]);
    } else {
      await client.query(`UPDATE world_organizations SET governance_rules=$3::jsonb,updated_world_time=$4,updated_at=now()
        WHERE world_id=$1 AND id=$2`, [proposal.world_id, proposal.organization_id, JSON.stringify(rules), worldTime]);
    }
    await writeWorldHistory(client, { worldId: proposal.world_id, eventKey: `org-proposal:${proposal.id}:applied`,
      eventType: 'organization_rule_changed', actorAgentId: proposal.proposer_agent_id, entityType: 'organization',
      entityId: proposal.organization_id, worldTime, title: 'Organization rule changed',
      detail: `${payload.key} was changed after a governance decision.`, metadata: { proposalId: proposal.id, rules } });
    await recordInstitutionalMemory(client, { worldId: proposal.world_id, institutionType: 'organization',
      institutionId: proposal.organization_id, memoryType: 'rule_change', worldTime,
      summary: `Adopted a rule change for ${payload.key}.`, metadata: { proposalId: proposal.id, rules } });
    return { status: 'executed', rules };
  }
  if (proposal.proposal_type === 'leadership_change') {
    const target = await client.query(`SELECT 1 FROM world_organization_members WHERE world_id=$1 AND organization_id=$2
      AND agent_id=$3 AND status='active'`, [proposal.world_id, proposal.organization_id, payload.newLeaderAgentId]);
    if (!target.rowCount) throw institutionError('NEW_LEADER_MUST_BE_ACTIVE_MEMBER');
    await client.query(`UPDATE world_organization_members SET role=CASE WHEN agent_id=$3 THEN 'founder'
        WHEN role='founder' THEN 'member' ELSE role END,updated_world_time=$4,updated_at=now()
      WHERE world_id=$1 AND organization_id=$2`, [proposal.world_id, proposal.organization_id, payload.newLeaderAgentId, worldTime]);
    await client.query(`UPDATE world_organizations SET founder_agent_id=$3,updated_world_time=$4,updated_at=now()
      WHERE world_id=$1 AND id=$2`, [proposal.world_id, proposal.organization_id, payload.newLeaderAgentId, worldTime]);
    await writeWorldHistory(client, { worldId: proposal.world_id, eventKey: `org-proposal:${proposal.id}:leader`,
      eventType: 'organization_leadership_changed', actorAgentId: proposal.proposer_agent_id, entityType: 'organization',
      entityId: proposal.organization_id, worldTime, title: 'Organization leadership changed',
      detail: 'Members selected a new organizational leader.', metadata: { proposalId: proposal.id,
        oldLeaderAgentId: organization.founder_agent_id, newLeaderAgentId: payload.newLeaderAgentId } });
    await recordInstitutionalMemory(client, { worldId: proposal.world_id, institutionType: 'organization',
      institutionId: proposal.organization_id, memoryType: 'leadership_change', worldTime,
      summary: 'Members changed the organization leader through a proposal.', metadata: { proposalId: proposal.id } });
    return { status: 'executed', newLeaderAgentId: payload.newLeaderAgentId };
  }
  if (proposal.proposal_type === 'treasury_spend') {
    const amount = normalizeAmount(payload.amountUsdc, 'amount_usdc');
    const spendingLimit = Number(organization.governance_rules?.spending_limit_usdc);
    if (Number.isFinite(spendingLimit) && Number(amount) > spendingLimit) {
      throw institutionError('ORGANIZATION_SPENDING_LIMIT_EXCEEDED');
    }
    await requireWorldMember(client, proposal.world_id, payload.recipientAgentId);
    const paid = await transferBetweenAccounts(client, { worldId: proposal.world_id,
      source: { accountType: 'organization', ownerId: proposal.organization_id },
      destination: { accountType: 'resident', ownerId: payload.recipientAgentId }, amount,
      transactionType: 'organization_contribution', reason: 'Organization governance approved a treasury grant.', worldTime,
      actionId: `v5-org-spend:${proposal.id}`, referenceId: proposal.organization_id,
      metadata: { proposalId: proposal.id } });
    await client.query(`INSERT INTO world_organization_ledger(world_id,organization_id,agent_id,action_id,entry_type,
        resource_key,amount,reason,world_time) VALUES($1,$2,$3,$4,'project_spend','simulated_usdc',$5,
        'Governance-approved treasury grant.',$6) ON CONFLICT DO NOTHING`,
    [proposal.world_id, proposal.organization_id, payload.recipientAgentId, `v5-org-spend:${proposal.id}`,
      `-${amount}`, worldTime]);
    return { status: 'executed', transactionId: paid.transactionId };
  }
  if (proposal.proposal_type === 'project_approval') {
    const project = await client.query(`UPDATE world_projects SET status='recruiting',organization_id=$3,updated_world_time=$4,updated_at=now()
      WHERE world_id=$1 AND id=$2 AND status IN ('proposed','idea') RETURNING id`,
    [proposal.world_id, payload.projectId, proposal.organization_id, worldTime]);
    if (!project.rowCount) throw institutionError('PROJECT_NOT_APPROVABLE');
    return { status: 'executed', projectId: payload.projectId };
  }
  if (proposal.proposal_type === 'business_funding') {
    const business = await client.query(`SELECT id FROM world_businesses WHERE world_id=$1 AND id=$2 AND status='active' FOR UPDATE`,
      [proposal.world_id, payload.businessId]);
    if (!business.rowCount) throw institutionError('BUSINESS_NOT_ACTIVE');
    const cash = await getEconomicAccount(client, { worldId: proposal.world_id, accountType: 'organization',
      ownerId: proposal.organization_id, forUpdate: true });
    const spendingLimit = Number(organization.governance_rules?.spending_limit_usdc);
    if (Number.isFinite(spendingLimit) && Number(payload.amountUsdc) > spendingLimit) {
      throw institutionError('ORGANIZATION_SPENDING_LIMIT_EXCEEDED');
    }
    if (!cash || parsePositiveUnits(cash.balance, { allowZero: true }) < parsePositiveUnits(payload.amountUsdc)) {
      throw institutionError('INSUFFICIENT_ORGANIZATION_FUNDS');
    }
    const holders = await client.query(`SELECT owner_type,owner_id,share::text AS share FROM world_economic_ownership
      WHERE world_id=$1 AND asset_type='business' AND asset_id=$2 FOR UPDATE`, [proposal.world_id, payload.businessId]);
    const totalShare = holders.rows.reduce((sum, holder) => sum + Number(holder.share), 0);
    if (Number(payload.ownershipShare) > 0 && (totalShare <= 0
        || Number(payload.ownershipShare) > totalShare + 1e-8
        || holders.rows.some((holder) => holder.owner_type === 'organization' && holder.owner_id === proposal.organization_id))) {
      throw institutionError('BUSINESS_FUNDING_OWNERSHIP_UNAVAILABLE');
    }
    const paid = await transferBetweenAccounts(client, { worldId: proposal.world_id,
      source: { accountType: 'organization', ownerId: proposal.organization_id },
      destination: { accountType: 'business', ownerId: payload.businessId, key: `business:${payload.businessId}` },
      amount: payload.amountUsdc, transactionType: 'business_investment',
      reason: 'Organization governance approved simulated business funding.', worldTime,
      actionId: `v5-org-funding:${proposal.id}`, referenceId: payload.businessId, metadata: { proposalId: proposal.id } });
    if (payload.ownershipShare > 0) {
      const remainingShare = Math.max(0, totalShare - Number(payload.ownershipShare));
      for (const holder of holders.rows) {
        const nextShare = Number(holder.share) * remainingShare / totalShare;
        if (nextShare <= 0.0000001) await client.query(`DELETE FROM world_economic_ownership
          WHERE world_id=$1 AND asset_type='business' AND asset_id=$2 AND owner_type=$3 AND owner_id=$4`,
        [proposal.world_id, payload.businessId, holder.owner_type, holder.owner_id]);
        else await client.query(`UPDATE world_economic_ownership SET share=$5,updated_at=now()
          WHERE world_id=$1 AND asset_type='business' AND asset_id=$2 AND owner_type=$3 AND owner_id=$4`,
        [proposal.world_id, payload.businessId, holder.owner_type, holder.owner_id, nextShare]);
      }
      await client.query(`INSERT INTO world_economic_ownership(world_id,asset_type,asset_id,
        owner_type,owner_id,share,invested_usdc,acquired_world_time) VALUES($1,'business',$2,'organization',$3,$4,$5,$6)
      ON CONFLICT(world_id,asset_type,asset_id,owner_type,owner_id) DO UPDATE SET share=world_economic_ownership.share+EXCLUDED.share,
        invested_usdc=world_economic_ownership.invested_usdc+EXCLUDED.invested_usdc,updated_at=now()`,
      [proposal.world_id, payload.businessId, proposal.organization_id, payload.ownershipShare, payload.amountUsdc, worldTime]);
    }
    return { status: 'executed', transactionId: paid.transactionId };
  }
  if (proposal.proposal_type === 'member_change') {
    if (payload.decision === 'invite') {
      await requireWorldMember(client, proposal.world_id, payload.memberAgentId);
      await client.query(`INSERT INTO world_organization_members(world_id,organization_id,agent_id,status,role,joined_world_time,
          updated_world_time,action_id) VALUES($1,$2,$3,'invited','member',$4,$4,$5)
        ON CONFLICT(organization_id,agent_id) DO UPDATE SET status='invited',updated_world_time=EXCLUDED.updated_world_time,
          action_id=EXCLUDED.action_id,updated_at=now()`, [proposal.world_id, proposal.organization_id,
        payload.memberAgentId, worldTime, `v5-governance:${proposal.id}`]);
      return { status: 'executed', invitedAgentId: payload.memberAgentId };
    }
    if (payload.memberAgentId === organization.founder_agent_id) throw institutionError('FOUNDER_CANNOT_BE_REMOVED');
    const removed = await client.query(`UPDATE world_organization_members SET status='left',updated_world_time=$4,updated_at=now()
      WHERE world_id=$1 AND organization_id=$2 AND agent_id=$3 AND status='active' RETURNING agent_id`,
    [proposal.world_id, proposal.organization_id, payload.memberAgentId, worldTime]);
    if (!removed.rowCount) throw institutionError('ACTIVE_MEMBER_REQUIRED');
    if (!genesisCurrencyActive) {
      await client.query(`DELETE FROM world_economic_ownership WHERE world_id=$1 AND asset_type='organization' AND asset_id=$2
        AND owner_type='resident' AND owner_id=$3`, [proposal.world_id, proposal.organization_id, payload.memberAgentId]);
      const remainingMembers = await client.query(`SELECT agent_id FROM world_organization_members
        WHERE world_id=$1 AND organization_id=$2 AND status='active' ORDER BY joined_world_time,agent_id`,
      [proposal.world_id, proposal.organization_id]);
      const share = remainingMembers.rowCount ? 1 / remainingMembers.rowCount : 0;
      if (share > 0) await client.query(`UPDATE world_economic_ownership SET share=$3,updated_at=now()
        WHERE world_id=$1 AND asset_type='organization' AND asset_id=$2 AND owner_type='resident'
          AND owner_id=ANY($4::uuid[])`, [proposal.world_id, proposal.organization_id, share,
        remainingMembers.rows.map((member) => member.agent_id)]);
    }
    return { status: 'executed', removedAgentId: payload.memberAgentId };
  }
  throw institutionError('ORGANIZATION_PROPOSAL_TYPE_UNSUPPORTED');
}

export async function voteOrganizationProposal(client, { worldId, proposalId, agentId, decision, actionId, worldTime }) {
  const key = actionIdentifier(actionId);
  const choice = String(decision || '').toLowerCase();
  if (!['support','reject','abstain'].includes(choice)) throw institutionError('ORGANIZATION_VOTE_INVALID', 400);
  const proposalResult = await client.query(`SELECT proposal.*,organization.governance_mode,organization.governance_rules,
      organization.founder_agent_id FROM world_organization_proposals proposal
    JOIN world_organizations organization ON organization.world_id=proposal.world_id AND organization.id=proposal.organization_id
    WHERE proposal.world_id=$1 AND proposal.id=$2 FOR UPDATE OF proposal,organization`, [worldId, proposalId]);
  if (!proposalResult.rowCount) throw institutionError('ORGANIZATION_PROPOSAL_NOT_FOUND', 404);
  const proposal = proposalResult.rows[0];
  const member = await client.query(`SELECT role FROM world_organization_members WHERE world_id=$1 AND organization_id=$2
    AND agent_id=$3 AND status='active' FOR UPDATE`, [worldId, proposal.organization_id, agentId]);
  if (!member.rowCount) throw institutionError('ACTIVE_ORGANIZATION_MEMBERSHIP_REQUIRED', 403);
  const prior = await client.query(`SELECT decision,action_id FROM world_organization_proposal_votes
    WHERE proposal_id=$1 AND agent_id=$2 FOR UPDATE`, [proposalId, agentId]);
  if (prior.rowCount) {
    if (prior.rows[0].action_id === key) return { proposalId, status: proposal.status, idempotent: true };
    throw institutionError('ORGANIZATION_VOTE_ALREADY_CAST');
  }
  if (proposal.status !== 'proposed' || Number(proposal.expires_world_time) <= worldTime) {
    throw institutionError('ORGANIZATION_PROPOSAL_CLOSED');
  }
  await client.query(`INSERT INTO world_organization_proposal_votes(proposal_id,organization_id,agent_id,decision,action_id,world_time)
    VALUES($1,$2,$3,$4,$5,$6)`, [proposalId, proposal.organization_id, agentId, choice, key, worldTime]);
  const members = await client.query(`SELECT member.agent_id,member.role,
      COALESCE(reputation.reliability,0)+COALESCE(reputation.cooperation,0) AS reputation,
      COALESCE(max(skill.skill_value),0) AS skill
    FROM world_organization_members member LEFT JOIN world_agent_reputations reputation
      ON reputation.world_id=member.world_id AND reputation.agent_id=member.agent_id
    LEFT JOIN world_agent_skills skill ON skill.world_id=member.world_id AND skill.agent_id=member.agent_id
    WHERE member.world_id=$1 AND member.organization_id=$2 AND member.status='active'
    GROUP BY member.agent_id,member.role,reputation.reliability,reputation.cooperation`, [worldId, proposal.organization_id]);
  const votes = await client.query(`SELECT agent_id,decision FROM world_organization_proposal_votes WHERE proposal_id=$1`, [proposalId]);
  const mode = proposal.governance_mode;
  let eligible = members.rows;
  if (mode === 'founder_led') eligible = eligible.filter((person) => person.agent_id === proposal.founder_agent_id);
  else if (mode === 'delegated') eligible = eligible.filter((person) => ['founder','coordinator'].includes(person.role));
  else if (mode === 'skill_based' && members.rows.length) {
    const top = Math.max(...members.rows.map((person) => Number(person.skill) || 0));
    eligible = members.rows.filter((person) => Number(person.skill) === top);
  }
  const voteByAgent = new Map(votes.rows.map((item) => [item.agent_id, item.decision]));
  const weight = (person) => mode === 'reputation_weighted' ? 1 + clamp(person.reputation, -90, 900) / 100
    : mode === 'skill_based' ? 1 + clamp(person.skill, 0, 100) / 100 : 1;
  const total = eligible.reduce((sum, person) => sum + weight(person), 0);
  const cast = eligible.filter((person) => voteByAgent.has(person.agent_id));
  const support = cast.filter((person) => voteByAgent.get(person.agent_id) === 'support').reduce((sum, person) => sum + weight(person), 0);
  const reject = cast.filter((person) => voteByAgent.get(person.agent_id) === 'reject').reduce((sum, person) => sum + weight(person), 0);
  const quorum = mode === 'founder_led' || mode === 'delegated' ? 1
    : mode === 'member_vote' ? Math.floor(total / 2) + 1 : total * 0.5;
  let status = null;
  if (cast.length && support >= quorum && support > reject) status = 'approved';
  else if (cast.length && reject >= quorum && reject >= support) status = 'rejected';
  else if (cast.length >= eligible.length && support > reject) status = 'approved';
  else if (cast.length >= eligible.length) status = 'rejected';
  if (status === 'approved') {
    const applied = await applyOrganizationProposal(client, proposal, proposalResult.rows[0], worldTime);
    await client.query(`UPDATE world_organization_proposals SET status='executed',resolved_world_time=$3,
        metadata=metadata||$4::jsonb,updated_at=now() WHERE world_id=$1 AND id=$2`,
    [worldId, proposalId, worldTime, JSON.stringify({ vote: { support, reject, total }, applied })]);
    status = 'executed';
  } else if (status === 'rejected') {
    await client.query(`UPDATE world_organization_proposals SET status='rejected',resolved_world_time=$3,
        metadata=metadata||$4::jsonb,updated_at=now() WHERE world_id=$1 AND id=$2`,
    [worldId, proposalId, worldTime, JSON.stringify({ vote: { support, reject, total } })]);
  }
  return { proposalId, status: status || 'proposed', vote: { support: round4(support), reject: round4(reject), total: round4(total) } };
}

export async function listWorldInstitutionSummary(client, { worldId, agentId = null, limit = 100 } = {}) {
  const [agreements, commitments, reputations, norms, proposals, templates, beliefs] = await Promise.all([
    client.query(`SELECT count(*) FILTER(WHERE status='proposed')::int AS proposed,
        count(*) FILTER(WHERE status='countered')::int AS countered,count(*) FILTER(WHERE status='active')::int AS active,
        count(*) FILTER(WHERE status='completed')::int AS completed,count(*) FILTER(WHERE status='breached')::int AS breached
      FROM world_agreements WHERE world_id=$1 AND ($2::uuid IS NULL OR $2 IN (proposer_agent_id,counterparty_agent_id))`, [worldId, agentId]),
    client.query(`SELECT count(*) FILTER(WHERE status='active')::int AS active,
        count(*) FILTER(WHERE status='fulfilled')::int AS fulfilled,count(*) FILTER(WHERE status='breached')::int AS breached
      FROM world_commitments WHERE world_id=$1 AND ($2::uuid IS NULL OR $2 IN (agent_id,counterparty_agent_id))`, [worldId, agentId]),
    client.query(`SELECT agent_id AS "agentId",reliability::text AS reliability,professional::text AS professional,
        financial::text AS financial,cooperation::text AS cooperation,fulfilled_count AS "fulfilledCount",
        breach_count AS "breachCount" FROM world_agent_reputations WHERE world_id=$1
        AND ($2::uuid IS NULL OR agent_id=$2) ORDER BY agent_id LIMIT $3`, [worldId, agentId, limit]),
    client.query(`SELECT id,scope_type AS "scopeType",scope_id AS "scopeId",norm_key AS "normKey",behavior,
        confidence::text AS confidence,support_count AS "supportCount",violation_count AS "violationCount",
        created_world_time AS "createdWorldTime",updated_world_time AS "updatedWorldTime"
      FROM world_social_norms WHERE world_id=$1 ORDER BY confidence DESC,updated_world_time DESC LIMIT $2`, [worldId, limit]),
    client.query(`SELECT count(*) FILTER(WHERE status='proposed')::int AS open,
        count(*) FILTER(WHERE status='executed')::int AS executed,count(*) FILTER(WHERE status='rejected')::int AS rejected
      FROM world_organization_proposals WHERE world_id=$1`, [worldId]),
    client.query(`SELECT agreement_type AS "agreementType",template_key AS "templateKey",terms,sample_count AS "sampleCount",
        success_count AS "successCount" FROM world_agreement_templates WHERE world_id=$1 ORDER BY sample_count DESC LIMIT $2`,
    [worldId, limit]),
    client.query(`SELECT institution_type AS "institutionType",institution_id AS "institutionId",
        belief_key AS "beliefKey",subject_type AS "subjectType",subject_key AS "subjectKey",
        resident.name AS "subjectName",
        estimate::text AS estimate,confidence::text AS confidence,sample_count AS "sampleCount",
        updated_world_time AS "updatedWorldTime"
      FROM world_institutional_beliefs belief LEFT JOIN agents resident ON resident.id::text=belief.subject_key
      WHERE belief.world_id=$1 AND ($2::text IS NULL OR belief.subject_key=$2::text)
      ORDER BY belief.confidence DESC,belief.updated_world_time DESC,belief.id DESC LIMIT $3`, [worldId, agentId, limit])
  ]);
  return { agreements: agreements.rows[0], commitments: commitments.rows[0], reputations: reputations.rows,
    norms: norms.rows, governanceProposals: proposals.rows[0], templates: templates.rows,
    institutionalBeliefs: beliefs.rows };
}

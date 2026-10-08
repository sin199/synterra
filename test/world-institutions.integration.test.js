import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { getEconomicAccount } from '../src/economic-ledger.js';
import { fundTestResidents } from './helpers/economic-fixtures.js';
import { applyToWorldBusinessJob, completeWorldBusinessShift, decideWorldBusinessApplication,
  closeWorldBusiness, foundWorldBusiness, purchaseWorldBusinessService } from '../src/world-businesses.js';
import { startWorldEngine } from '../src/world-engine.js';
import { createWorldCommitment, expireInstitutionalState, listWorldInstitutionSummary,
  planInstitutionalAction, proposeOrganizationGovernance, proposeWorldAgreement,
  respondToWorldAgreement, voteOrganizationProposal } from '../src/world-institutions.js';
import { foundWorldOrganization } from '../src/world-organizations.js';

const databaseUrl = process.env.SYNTERRA_TEST_DATABASE_URL;
const enabled = process.env.SYNTERRA_TEST_ISOLATED === '1' && Boolean(databaseUrl);
const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function assertIsolatedDatabase(connectionString) {
  const parsed = new URL(connectionString);
  assert.ok(['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname), 'V5 tests require loopback PostgreSQL');
  assert.ok(decodeURIComponent(parsed.pathname.slice(1)).endsWith('_test'), 'V5 tests require a database ending in _test');
  assert.notEqual(parsed.port, '5432', 'V5 tests must not use the default PostgreSQL port');
}

async function inTransaction(pool, operation) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

test('V5 agreements negotiate, execute against V4 ledger, affect cognition, governance and durable norms', {
  skip: !enabled,
  timeout: 120_000
}, async () => {
  assertIsolatedDatabase(databaseUrl);
  const pool = new Pool({ connectionString: databaseUrl, max: 4 });
  const worldId = randomUUID();
  const [founderId, workerId, investorId, customerId] = Array.from({ length: 4 }, () => randomUUID());
  const residents = [founderId, workerId, investorId, customerId];
  let engine;
  let fruitflyDirectory;
  try {
    await pool.query(await readFile(path.join(repoRoot, 'schema.sql'), 'utf8'));
    await pool.query(`INSERT INTO agents(id,name,public_key,gender) VALUES
      ($1::uuid,'V5 Founder','v5-founder-'||$1::uuid::text,'male'),
      ($2::uuid,'V5 Worker','v5-worker-'||$2::uuid::text,'female'),
      ($3::uuid,'V5 Investor','v5-investor-'||$3::uuid::text,'male'),
      ($4::uuid,'V5 Customer','v5-customer-'||$4::uuid::text,'female')`, residents);
    await pool.query(`INSERT INTO worlds(id,owner_agent_id,name,chain_id,open) VALUES($1,$2,'V5 Institutions Integration',5042,true)`,
      [worldId, founderId]);
    await pool.query(`INSERT INTO world_members(world_id,agent_id,location,energy,food,social)
      SELECT $1,id,'Workshop',90,90,90 FROM agents WHERE id=ANY($2::uuid[])`, [worldId, residents]);
    await inTransaction(pool, (client) => fundTestResidents(client, { worldId, agentIds: residents }));
    await pool.query(`INSERT INTO world_agent_skills(world_id,agent_id,skill_name,skill_value,actions_completed)
      VALUES($1,$2,'research',50,5),($1,$3,'research',50,5)`, [worldId, founderId, workerId]);
    const [leftId, rightId] = [founderId, workerId].sort();
    await pool.query(`INSERT INTO world_relationships(world_id,agent_a_id,agent_b_id,familiarity,trust,affinity,interaction_count)
      VALUES($1,$2,$3,40,10,25,4)`, [worldId, leftId, rightId]);

    const business = await inTransaction(pool, (client) => foundWorldBusiness(client, { worldId, agentId: founderId,
      actionId: 'v5-business-found', worldTime: 0, proposal: { name: 'Resident Research Studio',
        businessType: 'research', purpose: 'Produce useful research notes through paid resident work.',
        serviceType: 'research_service', serviceName: 'Research Notes',
        serviceDescription: 'A resident prepared research note based on completed study.',
        basePriceUsdc: '20.00000000', capitalUsdc: '250.00000000' } }));
    const jobId = (await pool.query(`SELECT id FROM world_business_jobs WHERE world_id=$1 AND business_id=$2`,
      [worldId, business.id])).rows[0].id;
    const application = await inTransaction(pool, (client) => applyToWorldBusinessJob(client, { worldId,
      jobId, agentId: workerId, actionId: 'v5-worker-application', worldTime: 10 }));
    const hired = await inTransaction(pool, (client) => decideWorldBusinessApplication(client, { worldId,
      applicationId: application.id, founderAgentId: founderId, decision: 'accept', actionId: 'v5-worker-hired', worldTime: 20 }));
    assert.equal(hired.status, 'active');

    for (const [index, worldTime] of [40, 900, 1_800].entries()) {
      await inTransaction(pool, (client) => completeWorldBusinessShift(client, { worldId, businessId: business.id,
        serviceId: business.serviceId, employmentId: hired.id, agentId: workerId,
        actionId: `v5-initial-shift-${index + 1}`, worldTime }));
    }
    const businessCashAfterShifts = Number((await getEconomicAccount(pool, { worldId,
      accountType: 'business', ownerId: business.id })).balance);
    const workerAgent = { agentId: workerId, location: 'Workshop', energy: 90, food: 90, social: 90,
      riskTolerance: 0.5, skills: { research: 50 }, reliability: 0, sociability: 0.5, discipline: 0.6,
      relationships: [{ otherAgentId: founderId, trust: 10 }] };
    const wagePlan = await planInstitutionalAction(pool, { worldId, agent: workerAgent, worldTime: 1_810 });
    assert.equal(wagePlan?.action, 'agreement_propose', 'three completed shifts should create an evidence-based wage review');
    assert.equal(wagePlan.agreementType, 'employment');
    const wageOffer = await inTransaction(pool, (client) => proposeWorldAgreement(client, { worldId,
      proposerAgentId: workerId, counterpartyAgentId: founderId, agreementType: wagePlan.agreementType,
      terms: wagePlan.agreementTerms, actionId: 'v5-wage-proposal', worldTime: 1_810 }));
    const founderAgent = { agentId: founderId, location: 'Workshop', energy: 90, food: 90, social: 90,
      riskTolerance: 0.5, skills: { research: 50 }, reliability: 0, sociability: 0.5, discipline: 0.7,
      relationships: [{ otherAgentId: workerId, trust: 10 }] };
    const counterPlan = await planInstitutionalAction(pool, { worldId, agent: founderAgent, worldTime: 1_825 });
    assert.equal(counterPlan?.agreementId, wageOffer.id);
    assert.equal(counterPlan.decision, 'counter', 'the employer should make a bounded counter-offer within its payroll capacity');
    assert.ok(Number(counterPlan.institutionalTrace.institutionalBelief?.sampleCount) >= 3,
      'the business retains its own evidence-based belief about the employee');
    assert.ok(Number(counterPlan.institutionalTrace.socialNorm?.supportCount) >= 3,
      'repeated production shifts establish a scoped employment norm');
    assert.ok(counterPlan.institutionalTrace.negotiationAdjustment > 0,
      'institutional belief and repeated practice adjust this later negotiation threshold');
    const countered = await inTransaction(pool, (client) => respondToWorldAgreement(client, { worldId,
      agreementId: wageOffer.id, agentId: founderId, decision: 'counter', counterTerms: counterPlan.counterTerms,
      actionId: 'v5-wage-counter', worldTime: 1_825 }));
    assert.equal(countered.status, 'countered');
    const counterId = countered.agreement.id;
    const workerAcceptance = await planInstitutionalAction(pool, { worldId, agent: workerAgent, worldTime: 1_840 });
    assert.equal(workerAcceptance.agreementId, counterId);
    assert.equal(workerAcceptance.decision, 'accept');
    const acceptedWage = await inTransaction(pool, (client) => respondToWorldAgreement(client, { worldId,
      agreementId: counterId, agentId: workerId, decision: 'accept', actionId: 'v5-wage-accept', worldTime: 1_840 }));
    assert.equal(acceptedWage.status, 'active');
    const negotiatedWage = Number(acceptedWage.execution.wageUsdc);
    assert.ok(negotiatedWage > Number(hired.wage), 'accepted counter should alter the employment wage');
    assert.ok(businessCashAfterShifts >= negotiatedWage * 8, 'accepted terms remain within the existing payroll reserve');

    const activeEmploymentAgreement = (await pool.query(`SELECT id FROM world_agreements WHERE world_id=$1
      AND agreement_type='employment' AND status='active' AND terms->>'employmentId'=$2`, [worldId, hired.id])).rows[0];
    const commitment = await inTransaction(pool, (client) => createWorldCommitment(client, { worldId,
      agreementId: activeEmploymentAgreement.id, agentId: workerId, counterpartyAgentId: founderId,
      commitmentType: 'work', description: 'Complete the next paid research production shift.',
      actionId: 'v5-promised-shift', dueWorldTime: 2_200, worldTime: 1_850 }));
    const workPlan = await planInstitutionalAction(pool, { worldId, agent: workerAgent, worldTime: 1_860 });
    assert.equal(workPlan?.commitmentId, commitment.id);
    assert.equal(workPlan?.action, 'business_work', 'an active work commitment must be scheduled before unrelated strategy');
    const workerCashBefore = Number((await getEconomicAccount(pool, { worldId,
      accountType: 'resident', ownerId: workerId })).balance);
    const production = await inTransaction(pool, (client) => completeWorldBusinessShift(client, { worldId,
      businessId: business.id, serviceId: business.serviceId, employmentId: hired.id, agentId: workerId,
      actionId: 'v5-promised-production', worldTime: 1_870 }));
    const workerCashAfter = Number((await getEconomicAccount(pool, { worldId,
      accountType: 'resident', ownerId: workerId })).balance);
    assert.ok(Math.abs(workerCashAfter - workerCashBefore - negotiatedWage) < 1e-7,
      'production settles the negotiated wage exactly once');
    assert.equal(production.stockUnits, 4, 'employee work increased service inventory');
    assert.equal((await pool.query(`SELECT status FROM world_commitments WHERE world_id=$1 AND id=$2`,
      [worldId, commitment.id])).rows[0].status, 'fulfilled');
    assert.ok(Number((await pool.query(`SELECT reliability FROM world_agent_reputations WHERE world_id=$1 AND agent_id=$2`,
      [worldId, workerId])).rows[0].reliability) > 0, 'reliable production changes the worker reputation');
    assert.ok(Number((await pool.query(`SELECT count(*)::int FROM agent_memories WHERE world_id=$1 AND agent_id=$2
      AND memory_type='contract'`, [worldId, workerId])).rows[0].count) > 0, 'the work outcome enters agent memory');
    assert.ok(Number((await pool.query(`SELECT count(*)::int FROM world_agreement_templates WHERE world_id=$1
      AND agreement_type='employment' AND template_key='paid-shift-v1'`, [worldId])).rows[0].count) === 1,
    'three completed production shifts form a persistent paid-shift template');

    const serviceAgreement = await inTransaction(pool, (client) => proposeWorldAgreement(client, { worldId,
      proposerAgentId: founderId, counterpartyAgentId: customerId, agreementType: 'service',
      terms: { businessId: business.id, serviceId: business.serviceId, customerAgentId: customerId,
        priceUsdc: '20.00000000', units: 1 }, actionId: 'v5-service-terms', worldTime: 1_880 }));
    await inTransaction(pool, (client) => respondToWorldAgreement(client, { worldId, agreementId: serviceAgreement.id,
      agentId: customerId, decision: 'accept', actionId: 'v5-service-accept', worldTime: 1_890 }));
    const revenueShare = await inTransaction(pool, (client) => proposeWorldAgreement(client, { worldId,
      proposerAgentId: founderId, counterpartyAgentId: workerId, agreementType: 'revenue_sharing',
      terms: { businessId: business.id, recipientAgentId: workerId, shareBps: 1000 },
      actionId: 'v5-revenue-share', worldTime: 1_900 }));
    await inTransaction(pool, (client) => respondToWorldAgreement(client, { worldId, agreementId: revenueShare.id,
      agentId: workerId, decision: 'accept', actionId: 'v5-revenue-share-accept', worldTime: 1_910 }));
    const customerBefore = Number((await getEconomicAccount(pool, { worldId,
      accountType: 'resident', ownerId: customerId })).balance);
    const purchase = await inTransaction(pool, (client) => purchaseWorldBusinessService(client, { worldId,
      serviceId: business.serviceId, customerAgentId: customerId, actionId: 'v5-service-order', worldTime: 1_920,
      maxPriceUsdc: '20.00000000', demand: 4, supply: 1, wealth: customerBefore, priceSensitivity: 0.5 }));
    assert.equal(purchase.status, 'fulfilled');
    assert.deepEqual(purchase.benefit, { knowledge: 18, happiness: 5 });
    assert.ok(Number(purchase.revenueShareUsdc) > 0, 'the active revenue share settles from the same business sale');
    const customerAfter = Number((await getEconomicAccount(pool, { worldId,
      accountType: 'resident', ownerId: customerId })).balance);
    assert.equal(customerBefore - customerAfter, 20, 'customer pays the negotiated simulated price');
    assert.equal((await pool.query(`SELECT status FROM world_agreements WHERE world_id=$1 AND id=$2`,
      [worldId, serviceAgreement.id])).rows[0].status, 'completed');
    await inTransaction(pool, (client) => purchaseWorldBusinessService(client, { worldId,
      serviceId: business.serviceId, customerAgentId: customerId, actionId: 'v5-service-order', worldTime: 1_921,
      maxPriceUsdc: '20.00000000', demand: 4, supply: 1, wealth: customerAfter, priceSensitivity: 0.5 }));
    assert.equal(Number((await pool.query(`SELECT count(*)::int FROM world_economic_transactions WHERE world_id=$1
      AND action_id LIKE 'business-revshare:v5-service-order:%'`, [worldId])).rows[0].count), 1,
    'retrying the purchase cannot settle the revenue share twice');

    await pool.query(`UPDATE world_business_services SET stock_units=0 WHERE world_id=$1 AND id=$2`, [worldId, business.serviceId]);
    const supplierAgreement = await inTransaction(pool, (client) => proposeWorldAgreement(client, { worldId,
      proposerAgentId: founderId, counterpartyAgentId: customerId, agreementType: 'supplier_relationship',
      terms: { businessId: business.id, serviceId: business.serviceId, customerAgentId: customerId,
        priceUsdc: '20.00000000', maxUnits: 1 }, actionId: 'v5-supplier-terms', worldTime: 1_925 }));
    await inTransaction(pool, (client) => respondToWorldAgreement(client, { worldId, agreementId: supplierAgreement.id,
      agentId: customerId, decision: 'accept', actionId: 'v5-supplier-accept', worldTime: 1_926 }));
    const competingServiceAgreement = await inTransaction(pool, (client) => proposeWorldAgreement(client, { worldId,
      proposerAgentId: founderId, counterpartyAgentId: customerId, agreementType: 'service',
      terms: { businessId: business.id, serviceId: business.serviceId, customerAgentId: customerId,
        priceUsdc: '22.00000000', units: 1 }, actionId: 'v5-competing-service-terms', worldTime: 1_927 }));
    await inTransaction(pool, (client) => respondToWorldAgreement(client, { worldId,
      agreementId: competingServiceAgreement.id, agentId: customerId, decision: 'accept',
      actionId: 'v5-competing-service-accept', worldTime: 1_928 }));
    const supplierDelivery = (await pool.query(`SELECT id FROM world_commitments WHERE world_id=$1 AND agreement_id=$2
      AND commitment_type='delivery' AND status='active'`, [worldId, supplierAgreement.id])).rows[0];
    assert.ok(supplierDelivery, 'accepting supplier terms creates a durable provider delivery commitment');
    const supplierWorkPlan = await planInstitutionalAction(pool, { worldId, agent: workerAgent, worldTime: 1_930 });
    assert.equal(supplierWorkPlan?.action, 'business_work', 'a supplier with no stock receives a production candidate');
    assert.equal(supplierWorkPlan.contractAgreementId, supplierAgreement.id);
    assert.equal(supplierWorkPlan.commitmentId, supplierDelivery.id);
    assert.equal(supplierWorkPlan.employmentId, hired.id, 'an active employee can take contract-driven production work');
    const contractWorkerCashBefore = Number((await getEconomicAccount(pool, { worldId,
      accountType: 'resident', ownerId: workerId })).balance);
    const supplierProduction = await inTransaction(pool, (client) => completeWorldBusinessShift(client, { worldId,
      businessId: business.id, serviceId: business.serviceId, agentId: workerId, employmentId: hired.id,
      contractAgreementId: supplierWorkPlan.contractAgreementId, commitmentId: supplierWorkPlan.commitmentId,
      actionId: 'v5-supplier-production', worldTime: 1_940 }));
    assert.equal(Number(supplierProduction.stockUnits), 1, 'production makes one unit available to fulfill the contract');
    assert.equal(supplierProduction.agreementId, supplierAgreement.id,
      'production history points to the supplier agreement even when other agreements exist');
    assert.ok(Math.abs(Number((await getEconomicAccount(pool, { worldId, accountType: 'resident', ownerId: workerId })).balance)
      - contractWorkerCashBefore - negotiatedWage) < 1e-7,
    'a contract production shift settles the employee wage');
    const buyerAgent = { agentId: customerId, location: 'Workshop', energy: 90, food: 90, social: 90,
      knowledge: 20, primaryGoal: 'BALANCED_LIFE', riskTolerance: 0.4,
      skills: {}, relationships: [], reliability: 0.1, sociability: 0.5, discipline: 0.5 };
    const supplierPurchasePlan = await planInstitutionalAction(pool, { worldId, agent: buyerAgent, worldTime: 1_950 });
    assert.equal(supplierPurchasePlan?.action, 'business_service');
    assert.equal(supplierPurchasePlan.contractAgreementId, supplierAgreement.id,
      'the customer selects the specific active supplier agreement');
    const supplierPurchase = await inTransaction(pool, (client) => purchaseWorldBusinessService(client, { worldId,
      serviceId: business.serviceId, customerAgentId: customerId, actionId: 'v5-supplier-order', worldTime: 1_960,
      maxPriceUsdc: '20.00000000', contractAgreementId: supplierPurchasePlan.contractAgreementId }));
    assert.equal(supplierPurchase.priceUsdc, '20.00000000',
      'the supplier contract price is honored instead of a competing service price');
    const supplierSettlement = await pool.query(`SELECT agreement.status,delivery.status AS delivery_status,
        order_row.agreement_id,order_row.status AS order_status
      FROM world_agreements agreement JOIN world_commitments delivery ON delivery.world_id=agreement.world_id
        AND delivery.agreement_id=agreement.id AND delivery.commitment_type='delivery'
      JOIN world_business_orders order_row ON order_row.world_id=agreement.world_id
        AND order_row.id=$3
      WHERE agreement.world_id=$1 AND agreement.id=$2`, [worldId, supplierAgreement.id, supplierPurchase.orderId]);
    assert.equal(supplierSettlement.rows[0].status, 'completed');
    assert.equal(supplierSettlement.rows[0].delivery_status, 'fulfilled');
    assert.equal(supplierSettlement.rows[0].order_status, 'fulfilled');
    assert.equal(supplierSettlement.rows[0].agreement_id, supplierAgreement.id,
      'the order, payment, and service delivery settle against the same agreement');
    assert.equal(Number((await pool.query(`SELECT count(*)::int FROM world_agreement_outcomes
      WHERE world_id=$1 AND agreement_id=$2 AND outcome='fulfilled' AND action_id LIKE 'v5-outcome:v5-delivery:%'`,
    [worldId, supplierAgreement.id])).rows[0].count), 2,
    'both parties receive one idempotent fulfillment outcome');
    await pool.query(`UPDATE world_commitments SET status='cancelled',completed_world_time=1_970
      WHERE world_id=$1 AND agreement_id=$2 AND status='active'`, [worldId, competingServiceAgreement.id]);
    await pool.query(`UPDATE world_agreements SET status='cancelled',updated_world_time=1_970
      WHERE world_id=$1 AND id=$2 AND status='active'`, [worldId, competingServiceAgreement.id]);

    const serviceBase = (await pool.query(`SELECT base_price_usdc::text AS price FROM world_business_services
      WHERE world_id=$1 AND id=$2`, [worldId, business.serviceId])).rows[0].price;
    const renegotiatedAgreement = await inTransaction(pool, (client) => proposeWorldAgreement(client, { worldId,
      proposerAgentId: founderId, counterpartyAgentId: customerId, agreementType: 'supplier_relationship',
      terms: { businessId: business.id, serviceId: business.serviceId, customerAgentId: customerId,
        priceUsdc: serviceBase, maxUnits: 1 }, actionId: 'v5-renegotiation-origin', worldTime: 2_000 }));
    await inTransaction(pool, (client) => respondToWorldAgreement(client, { worldId,
      agreementId: renegotiatedAgreement.id, agentId: customerId, decision: 'accept',
      actionId: 'v5-renegotiation-origin-accept', worldTime: 2_001 }));
    await pool.query(`UPDATE world_business_services SET stock_units=0 WHERE world_id=$1 AND id=$2`, [worldId, business.serviceId]);
    const renegotiationDelivery = (await pool.query(`SELECT id,due_world_time FROM world_commitments
      WHERE world_id=$1 AND agreement_id=$2 AND commitment_type='delivery' AND status='active'`,
    [worldId, renegotiatedAgreement.id])).rows[0];
    const renegotiationPlan = await planInstitutionalAction(pool, { worldId, agent: founderAgent,
      worldTime: Number(renegotiationDelivery.due_world_time) - 1_200 });
    assert.equal(renegotiationPlan?.action, 'agreement_propose',
      'a provider facing a capacity deadline can propose revised delivery terms');
    assert.equal(renegotiationPlan.parentAgreementId, renegotiatedAgreement.id);
    const renegotiation = await inTransaction(pool, (client) => proposeWorldAgreement(client, { worldId,
      proposerAgentId: founderId, counterpartyAgentId: customerId, agreementType: renegotiationPlan.agreementType,
      terms: renegotiationPlan.agreementTerms, actionId: 'v5-capacity-renegotiation',
      parentAgreementId: renegotiationPlan.parentAgreementId,
      expiresInWorldMinutes: renegotiationPlan.expiresInWorldMinutes,
      worldTime: Number(renegotiationDelivery.due_world_time) - 1_200 }));
    assert.equal((await pool.query(`SELECT metadata->>'renegotiationPending' AS pending FROM world_agreements
      WHERE world_id=$1 AND id=$2`, [worldId, renegotiatedAgreement.id])).rows[0].pending, 'true');
    const renegotiationAcceptance = await inTransaction(pool, (client) => respondToWorldAgreement(client, { worldId,
      agreementId: renegotiation.id, agentId: customerId, decision: 'accept',
      actionId: 'v5-capacity-renegotiation-accept', worldTime: Number(renegotiationDelivery.due_world_time) - 1_199 }));
    assert.equal(renegotiationAcceptance.status, 'active');
    assert.equal((await pool.query(`SELECT status,metadata->'resolution'->>'reason' AS reason
      FROM world_agreements WHERE world_id=$1 AND id=$2`, [worldId, renegotiatedAgreement.id])).rows[0].reason,
    'renegotiated', 'mutual renegotiation replaces the old active obligation without recording a breach');
    assert.equal((await pool.query(`SELECT status FROM world_commitments WHERE world_id=$1 AND id=$2`,
      [worldId, renegotiationDelivery.id])).rows[0].status, 'cancelled');
    assert.ok(Number((await pool.query(`SELECT count(*)::int FROM agent_memories WHERE world_id=$1
      AND memory_type='contract' AND metadata->>'outcome'='renegotiated'`, [worldId])).rows[0].count) >= 2,
    'both residents remember the renegotiated supplier terms');

    const closedBusiness = await inTransaction(pool, (client) => foundWorldBusiness(client, { worldId,
      agentId: investorId, actionId: 'v5-closure-business', worldTime: 3_000,
      proposal: { name: 'Temporary Supply Studio', businessType: 'research',
        purpose: 'A temporary provider used to verify contract closure handling.', serviceType: 'research_service',
        serviceName: 'Research Packet', serviceDescription: 'A prepared research packet for resident customers.',
        basePriceUsdc: '12.00000000', capitalUsdc: '250.00000000' } }));
    const closedServiceId = (await pool.query(`SELECT id FROM world_business_services WHERE world_id=$1 AND business_id=$2`,
      [worldId, closedBusiness.id])).rows[0].id;
    const closureAgreement = await inTransaction(pool, (client) => proposeWorldAgreement(client, { worldId,
      proposerAgentId: investorId, counterpartyAgentId: customerId, agreementType: 'supplier_relationship',
      terms: { businessId: closedBusiness.id, serviceId: closedServiceId, customerAgentId: customerId,
        priceUsdc: '12.00000000', maxUnits: 1 }, actionId: 'v5-closure-supplier', worldTime: 3_010 }));
    await inTransaction(pool, (client) => respondToWorldAgreement(client, { worldId, agreementId: closureAgreement.id,
      agentId: customerId, decision: 'accept', actionId: 'v5-closure-supplier-accept', worldTime: 3_011 }));
    const closedDeliveryId = (await pool.query(`SELECT id FROM world_commitments WHERE world_id=$1 AND agreement_id=$2
      AND commitment_type='delivery' AND status='active'`, [worldId, closureAgreement.id])).rows[0].id;
    await inTransaction(pool, (client) => closeWorldBusiness(client, { worldId, businessId: closedBusiness.id,
      founderAgentId: investorId, actionId: 'v5-provider-closed', worldTime: 3_012 }));
    assert.equal((await pool.query(`SELECT status FROM world_agreements WHERE world_id=$1 AND id=$2`,
      [worldId, closureAgreement.id])).rows[0].status, 'breached');
    assert.equal((await pool.query(`SELECT status FROM world_commitments WHERE world_id=$1 AND id=$2`,
      [worldId, closedDeliveryId])).rows[0].status, 'breached');
    assert.ok(Number((await pool.query(`SELECT breach_count FROM world_agent_reputations WHERE world_id=$1 AND agent_id=$2`,
      [worldId, investorId])).rows[0].breach_count) > 0, 'closure changes provider reputation');
    assert.ok(Number((await pool.query(`SELECT count(*)::int FROM agent_memories WHERE world_id=$1
      AND metadata->>'agreementId'=$2 AND memory_type='contract'`, [worldId, closureAgreement.id])).rows[0].count) >= 2,
    'closure outcome enters both participants’ memories');

    const investment = await inTransaction(pool, (client) => proposeWorldAgreement(client, { worldId,
      proposerAgentId: founderId, counterpartyAgentId: investorId, agreementType: 'investment',
      terms: { businessId: business.id, amountUsdc: '50.00000000', ownershipShare: 0.2 },
      actionId: 'v5-investment-proposal', worldTime: 1_930 }));
    await inTransaction(pool, (client) => respondToWorldAgreement(client, { worldId, agreementId: investment.id,
      agentId: investorId, decision: 'accept', actionId: 'v5-investment-accept', worldTime: 1_940 }));
    const partnership = await inTransaction(pool, (client) => proposeWorldAgreement(client, { worldId,
      proposerAgentId: founderId, counterpartyAgentId: customerId, agreementType: 'partnership',
      terms: { businessId: business.id, sellerAgentId: founderId, buyerAgentId: customerId,
        ownershipShare: 0.1, priceUsdc: '20.00000000', gift: false },
      actionId: 'v5-partnership-proposal', worldTime: 1_950 }));
    await inTransaction(pool, (client) => respondToWorldAgreement(client, { worldId, agreementId: partnership.id,
      agentId: customerId, decision: 'accept', actionId: 'v5-partnership-accept', worldTime: 1_960 }));
    const ownership = await pool.query(`SELECT owner_id,share::text AS share FROM world_economic_ownership
      WHERE world_id=$1 AND asset_type='business' AND asset_id=$2`, [worldId, business.id]);
    assert.ok(Math.abs(ownership.rows.reduce((sum, holder) => sum + Number(holder.share), 0) - 1) < 1e-8,
      'investment and partnership transfer conserve total business ownership');
    assert.equal(Number(ownership.rows.find((holder) => holder.owner_id === investorId).share), 0.2);
    assert.equal(Number(ownership.rows.find((holder) => holder.owner_id === customerId).share), 0.1);

    await pool.query(`INSERT INTO world_relationships(world_id,agent_a_id,agent_b_id,familiarity,trust,affinity,interaction_count)
      VALUES($1,$2,$3,40,10,25,4)`, [worldId, ...[founderId, customerId].sort()]);
    const organization = await inTransaction(pool, (client) => foundWorldOrganization(client, { worldId,
      founderAgentId: founderId, inviteAgentId: customerId, actionId: 'v5-org-found', name: 'Research Cooperative',
      purpose: 'Coordinate paid research work and shared study across residents.', worldTime: 1_970,
      metadata: { economicPreparation: true, serviceType: 'research_service' } }));
    await pool.query(`UPDATE world_organization_members SET status='active',updated_world_time=1971
      WHERE world_id=$1 AND organization_id=$2 AND agent_id=$3`, [worldId, organization.id, customerId]);
    await pool.query(`UPDATE world_organizations SET governance_mode='member_vote' WHERE world_id=$1 AND id=$2`,
      [worldId, organization.id]);
    await inTransaction(pool, async (client) => {
      const treasury = await getEconomicAccount(client, { worldId, accountType: 'organization', ownerId: organization.id });
      const founderCash = await getEconomicAccount(client, { worldId, accountType: 'resident', ownerId: founderId });
      assert.ok(Number(founderCash.balance) > 100);
      assert.ok(treasury);
      const { transferBetweenAccounts } = await import('../src/economic-ledger.js');
      await transferBetweenAccounts(client, { worldId, source: { accountType: 'resident', ownerId: founderId },
        destination: { accountType: 'organization', ownerId: organization.id }, amount: '50.00000000',
        transactionType: 'organization_contribution', reason: 'Test capital for a governance proposal.',
        worldTime: 1_972, actionId: 'v5-org-treasury-seed', referenceId: organization.id });
    });
    const governanceProposal = await inTransaction(pool, (client) => proposeOrganizationGovernance(client, { worldId,
      organizationId: organization.id, proposerAgentId: founderId, proposalType: 'rule_change',
      payload: { key: 'spending_limit_usdc', value: '10.00000000' }, actionId: 'v5-spending-rule', worldTime: 1_980 }));
    const governanceResult = await inTransaction(pool, (client) => voteOrganizationProposal(client, { worldId,
      proposalId: governanceProposal.id, agentId: customerId, decision: 'support', actionId: 'v5-spending-vote', worldTime: 1_981 }));
    assert.equal(governanceResult.status, 'executed');
    const repeatedVote = await inTransaction(pool, (client) => voteOrganizationProposal(client, { worldId,
      proposalId: governanceProposal.id, agentId: customerId, decision: 'support', actionId: 'v5-spending-vote', worldTime: 1_982 }));
    assert.equal(repeatedVote.idempotent, true, 'a retry after proposal execution returns the prior vote result');
    assert.equal((await pool.query(`SELECT governance_rules->>'spending_limit_usdc' AS limit FROM world_organizations
      WHERE world_id=$1 AND id=$2`, [worldId, organization.id])).rows[0].limit, '10.00000000');

    const firstResource = await inTransaction(pool, (client) => proposeWorldAgreement(client, { worldId,
      proposerAgentId: founderId, counterpartyAgentId: workerId, agreementType: 'resource_sharing',
      terms: { resourceKey: 'simulated_usdc', amount: '10.00000000', recipientAgentId: workerId },
      actionId: 'v5-resource-original', worldTime: 2_000 }));
    const resourceCounter = await inTransaction(pool, (client) => respondToWorldAgreement(client, { worldId,
      agreementId: firstResource.id, agentId: workerId, decision: 'counter', counterTerms: { amount: '12.00000000' },
      actionId: 'v5-resource-counter', worldTime: 2_015 }));
    assert.equal(resourceCounter.status, 'countered');
    assert.equal((await pool.query(`SELECT count(*)::int FROM world_agreement_participants WHERE agreement_id=$1`,
      [resourceCounter.agreement.id])).rows[0].count, 2, 'counter-offers persist participant response rows');
    const completedCounter = await inTransaction(pool, (client) => respondToWorldAgreement(client, { worldId,
      agreementId: resourceCounter.agreement.id, agentId: founderId, decision: 'accept',
      actionId: 'v5-resource-counter-accept', worldTime: 2_025 }));
    assert.equal(completedCounter.status, 'completed');
    for (const [index, proposerAgentId, counterpartyAgentId, amount, recipientAgentId, worldTime] of [
      [1, workerId, founderId, '3.00000000', founderId, 2_040],
      [2, founderId, workerId, '4.00000000', workerId, 2_050]
    ]) {
      const agreement = await inTransaction(pool, (client) => proposeWorldAgreement(client, { worldId,
        proposerAgentId, counterpartyAgentId, agreementType: 'resource_sharing',
        terms: { resourceKey: 'simulated_usdc', amount, recipientAgentId },
        actionId: `v5-resource-repeat-${index}`, worldTime }));
      const accepted = await inTransaction(pool, (client) => respondToWorldAgreement(client, { worldId,
        agreementId: agreement.id, agentId: counterpartyAgentId, decision: 'accept',
        actionId: `v5-resource-repeat-accept-${index}`, worldTime: worldTime + 1 }));
      assert.equal(accepted.status, 'completed');
    }
    const effortAgreement = await inTransaction(pool, (client) => proposeWorldAgreement(client, { worldId,
      proposerAgentId: workerId, counterpartyAgentId: founderId, agreementType: 'resource_sharing',
      terms: { resourceKey: 'effort', amount: '1.00000000', recipientAgentId: founderId },
      actionId: 'v5-effort-agreement', worldTime: 2_060 }));
    await inTransaction(pool, (client) => respondToWorldAgreement(client, { worldId, agreementId: effortAgreement.id,
      agentId: founderId, decision: 'accept', actionId: 'v5-effort-accept', worldTime: 2_061 }));
    const missedWorkCommitment = await inTransaction(pool, (client) => createWorldCommitment(client, { worldId,
      agreementId: activeEmploymentAgreement.id, agentId: workerId, counterpartyAgentId: founderId,
      commitmentType: 'work', description: 'Complete a scheduled employment shift by its deadline.',
      actionId: 'v5-missed-employment-shift', dueWorldTime: 2_100, worldTime: 2_062 }));
    const effortCommitment = (await pool.query(`SELECT id,due_world_time FROM world_commitments
      WHERE world_id=$1 AND agreement_id=$2 AND status='active'`, [worldId, effortAgreement.id])).rows[0];
    const founderBeliefBeforeBreach = Number((await pool.query(`SELECT estimate FROM world_agent_beliefs WHERE world_id=$1
      AND agent_id=$2 AND subject_type='resident' AND subject_key=$3 AND belief_key='contract_reliability'`,
    [worldId, founderId, workerId])).rows[0].estimate);
    const expiry = await inTransaction(pool, (client) => expireInstitutionalState(client, { worldId,
      worldTime: Math.max(Number(effortCommitment.due_world_time), Number(missedWorkCommitment.due_world_time)) }));
    assert.equal(expiry.commitments, 2);
    assert.equal((await pool.query(`SELECT status FROM world_agreements WHERE world_id=$1 AND id=$2`,
      [worldId, effortAgreement.id])).rows[0].status, 'breached');
    assert.ok(Number((await pool.query(`SELECT breach_count FROM world_agent_reputations WHERE world_id=$1 AND agent_id=$2`,
      [worldId, workerId])).rows[0].breach_count) > 0, 'a missed obligation damages the responsible resident reputation');
    const founderBeliefAfterBreach = Number((await pool.query(`SELECT estimate FROM world_agent_beliefs WHERE world_id=$1 AND agent_id=$2
      AND subject_type='resident' AND subject_key=$3 AND belief_key='contract_reliability'`,
    [worldId, founderId, workerId])).rows[0].estimate);
    assert.ok(founderBeliefAfterBreach < founderBeliefBeforeBreach,
      'breach lowers the counterparty private reliability belief after earlier successful cooperation');
    const institutionalBeliefAfterBreach = Number((await pool.query(`SELECT estimate FROM world_institutional_beliefs
      WHERE world_id=$1 AND institution_type='business' AND institution_id=$2
        AND belief_key='counterparty_reliability' AND subject_type='resident' AND subject_key=$3`,
    [worldId, business.id, workerId])).rows[0].estimate);
    assert.ok(institutionalBeliefAfterBreach < 0.8,
      'the business-specific reliability belief updates after the worker breaches a later agreement');
    const norm = await pool.query(`SELECT support_count,violation_count,confidence FROM world_social_norms
      WHERE world_id=$1 AND scope_type='world' AND norm_key='resource_sharing:honor_terms'`, [worldId]);
    assert.ok(Number(norm.rows[0].support_count) >= 3 && Number(norm.rows[0].violation_count) >= 1,
      'repeat fulfillment creates a norm and later breach is recorded as a violation');
    assert.ok(Number((await pool.query(`SELECT count(*)::int FROM world_agreement_templates WHERE world_id=$1
      AND agreement_type='resource_sharing'`, [worldId])).rows[0].count) >= 1,
    'repeated successful agreements produce a durable contract template');

    const ledger = await pool.query(`SELECT count(*)::int AS transactions,
        count(*) FILTER(WHERE audit.postings<>2 OR audit.net<>0)::int AS unbalanced
      FROM world_economic_transactions tx CROSS JOIN LATERAL (
        SELECT count(*)::int AS postings,COALESCE(sum(posting.amount),0) AS net
        FROM world_economic_postings posting WHERE posting.transaction_id=tx.id) audit
      WHERE tx.world_id=$1`, [worldId]);
    assert.ok(Number(ledger.rows[0].transactions) > 10);
    assert.equal(ledger.rows[0].unbalanced, 0, 'all agreement settlement stays on the V4 double-entry ledger');
    const summary = await listWorldInstitutionSummary(pool, { worldId, limit: 20 });
    assert.ok(Number(summary.agreements.completed) >= 5);
    assert.ok(summary.norms.some((item) => item.normKey === 'resource_sharing:honor_terms'));
    assert.ok((await pool.query(`SELECT count(*)::int FROM world_history WHERE world_id=$1
      AND event_type IN ('agreement_countered','agreement_accepted','agreement_completed','agreement_breached',
        'organization_rule_changed','norm_formed','ownership_transferred')`, [worldId])).rows[0].count > 0);

    await pool.query(`UPDATE world_commitments SET status='cancelled',completed_world_time=2_200
      WHERE world_id=$1 AND commitment_type='delivery' AND status='active'`, [worldId]);
    await pool.query(`UPDATE world_agreements SET status='cancelled',updated_world_time=2_200
      WHERE world_id=$1 AND agreement_type IN ('service','supplier_relationship') AND status='active'`, [worldId]);
    const engineAgreement = await inTransaction(pool, (client) => proposeWorldAgreement(client, { worldId,
      proposerAgentId: founderId, counterpartyAgentId: customerId, agreementType: 'supplier_relationship',
      terms: { businessId: business.id, serviceId: business.serviceId, customerAgentId: customerId,
        priceUsdc: serviceBase, maxUnits: 1 }, actionId: 'v5-engine-contract', worldTime: 2_210 }));
    await inTransaction(pool, (client) => respondToWorldAgreement(client, { worldId, agreementId: engineAgreement.id,
      agentId: customerId, decision: 'accept', actionId: 'v5-engine-contract-accept', worldTime: 2_211 }));
    const engineDelivery = (await pool.query(`SELECT id FROM world_commitments WHERE world_id=$1 AND agreement_id=$2
      AND commitment_type='delivery' AND status='active'`, [worldId, engineAgreement.id])).rows[0];
    assert.ok(engineDelivery, 'an accepted supplier agreement remains an unresolved engine task');
    await pool.query(`UPDATE world_commitments SET status='cancelled',outcome_reason='voluntary_exit',
        completed_world_time=2_100 WHERE world_id=$1 AND agent_id=$2 AND status='active' AND id<>$3`,
    [worldId, founderId, engineDelivery.id]);
    await pool.query(`UPDATE world_agreements SET status='expired',updated_world_time=2_100
      WHERE world_id=$1 AND status IN ('proposed','countered') AND $2 IN (proposer_agent_id,counterparty_agent_id)`,
    [worldId, founderId]);
    await pool.query(`INSERT INTO world_scenes(world_id,created_by,name,scene_type,description,purpose,capacity,features,position)
      VALUES($1,$2,'Research Garden','garden','A quiet garden for short resident breaks.','Restore energy and mood.',12,'{}','{}'),
        ($1,$2,'Commons Cafe','cafe','A cafe for meals and everyday resident activity.','Eat and meet residents.',12,'{}','{}')`,
    [worldId, founderId]);
    await pool.query(`INSERT INTO world_agent_states(world_id,agent_id,goal,risk_tolerance,next_decision_at)
      SELECT world_id,agent_id,'balanced',0.4,now()+interval '1 day' FROM world_members WHERE world_id=$1
      ON CONFLICT(world_id,agent_id) DO UPDATE SET status='idle',planned_action=NULL,target_location=NULL,
        movement_started_at=NULL,movement_ends_at=NULL,action_started_at=NULL,action_ends_at=NULL,
        next_decision_at=now()+interval '1 day'`, [worldId]);
    await pool.query(`UPDATE world_agent_states SET next_decision_at=now()-interval '1 minute',
        next_strategic_decision_world_minutes=100_000,next_institutional_review_world_minutes=0
      WHERE world_id=$1 AND agent_id=$2`, [worldId, founderId]);
    fruitflyDirectory = await import('node:fs/promises').then(({ mkdtemp }) => mkdtemp('/tmp/synterra-v5-runtime-'));
    const { createFruitflyRuntime } = await import('../src/agent-runtime/fruitfly.js');
    const fruitfly = await createFruitflyRuntime(fruitflyDirectory);
    const engineErrors = [];
    await pool.query(`INSERT INTO world_runtime_state(world_id,tick_count,world_minutes,last_tick_at,typesafe_next_at)
      VALUES($1,0,0,now()-interval '1 minute',now()+interval '1 day')
      ON CONFLICT(world_id) DO UPDATE SET tick_count=0,world_minutes=0,last_tick_at=now()-interval '1 minute',
        typesafe_next_at=now()+interval '1 day'`, [worldId]);
    engine = await startWorldEngine(pool, { worldId, schedule: false, fruitfly, nowProvider: () => Date.now(),
      onError: (error, context) => engineErrors.push(`${context}: ${error.message}`) });
    assert.equal(engine.running, true, `integration engine must start: ${engine.reason || 'no reason returned'}`);
    assert.deepEqual(engineErrors, [], `integration engine tick must be clean: ${engineErrors.join('; ')}`);
    const engineState = (await pool.query(`SELECT fruitfly_candidates,fruitfly_selected,planned_context,planned_action,
        status,next_decision_at,next_institutional_review_world_minutes
      FROM world_agent_states WHERE world_id=$1 AND agent_id=$2`, [worldId, founderId])).rows[0];
    const engineClock = (await pool.query(`SELECT tick_count,world_minutes,last_tick_at FROM world_runtime_state WHERE world_id=$1`,
      [worldId])).rows[0];
    const contractCandidateId = `institution:${engineDelivery.id}:contract-production`;
    assert.ok(engineState.fruitfly_candidates.some((item) => item.id === contractCandidateId),
      `the active contract work remains in the Utility-qualified Fruitfly candidate set: ${JSON.stringify({
        expected: contractCandidateId, plannedAction: engineState.planned_action,
        status: engineState.status, nextDecisionAt: engineState.next_decision_at,
        nextInstitutionalAt: engineState.next_institutional_review_world_minutes, clock: engineClock,
        selected: engineState.fruitfly_selected,
        candidates: engineState.fruitfly_candidates.map(({ id, action, score }) => ({ id, action, score }))
      })}`);
    assert.ok(new Set(engineState.fruitfly_candidates.map((item) => item.action)).size >= 2,
      'Fruitfly retains multiple qualified action families instead of being forced to the contract action');
    assert.equal(engineState.fruitfly_selected.learnerUsed, true,
      'Fruitfly makes the final choice from the qualified candidate set');
    assert.ok(engineState.fruitfly_candidates.some((item) => item.id === engineState.fruitfly_selected.id),
      'the chosen candidate is one of the candidates passed to Fruitfly');
    const engineDecision = await pool.query(`SELECT chosen_candidate_id FROM world_decision_traces
      WHERE world_id=$1 AND agent_id=$2 ORDER BY tick_count DESC LIMIT 1`, [worldId, founderId]);
    assert.equal(engineDecision.rows[0]?.chosen_candidate_id, engineState.fruitfly_selected.id,
      'the durable decision trace matches Fruitfly’s selected candidate');
    const institutionalSchema = await pool.query(`SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
      WHERE conrelid='world_emergence_events'::regclass AND conname='world_emergence_events_system_check'`);
    assert.match(institutionalSchema.rows[0].definition, /institution/);
    await engine.stop();
    engine = null;
  } finally {
    if (engine) await engine.stop();
    await pool.query('DELETE FROM worlds WHERE id=$1', [worldId]).catch(() => {});
    await pool.query('DELETE FROM agents WHERE id=ANY($1::uuid[])', [residents]).catch(() => {});
    await pool.end();
    if (fruitflyDirectory) {
      const { rm } = await import('node:fs/promises');
      await rm(fruitflyDirectory, { recursive: true, force: true });
    }
  }
});

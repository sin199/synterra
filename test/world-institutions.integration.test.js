import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { ensureCryptoAccount } from '../src/crypto-trading.js';
import { getEconomicAccount } from '../src/economic-ledger.js';
import { applyToWorldBusinessJob, completeWorldBusinessShift, decideWorldBusinessApplication,
  foundWorldBusiness, purchaseWorldBusinessService } from '../src/world-businesses.js';
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
    await pool.query(`INSERT INTO crypto_risk_limits(world_id,starting_usdc) VALUES($1,10000)
      ON CONFLICT(world_id) DO NOTHING`, [worldId]);
    await inTransaction(pool, async (client) => {
      for (const agentId of residents) await ensureCryptoAccount(client, { worldId, agentId });
    });
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

    fruitflyDirectory = await import('node:fs/promises').then(({ mkdtemp }) => mkdtemp('/tmp/synterra-v5-runtime-'));
    const { createFruitflyRuntime } = await import('../src/agent-runtime/fruitfly.js');
    const fruitfly = await createFruitflyRuntime(fruitflyDirectory);
    await pool.query(`INSERT INTO world_runtime_state(world_id,tick_count,world_minutes,last_tick_at,typesafe_next_at)
      VALUES($1,0,0,now()-interval '1 minute',now()+interval '1 day')`, [worldId]);
    engine = await startWorldEngine(pool, { worldId, schedule: false, fruitfly, nowProvider: () => Date.now() });
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

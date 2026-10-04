import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { ensureCryptoAccount } from '../src/crypto-trading.js';
import { ensureEconomicAccount, getEconomicAccount, postEconomicTransfer } from '../src/economic-ledger.js';
import { applyToWorldBusinessJob, closeWorldBusiness, completeWorldBusinessShift,
  decideWorldBusinessApplication, distributeWorldBusinessProfit, distributeWorldProjectRevenue,
  economicDashboardSql, foundWorldBusiness, investInWorldBusiness, investInWorldProject,
  leaveWorldBusinessJob, listWorldBusinesses, purchaseWorldBusinessService,
  observeResidentEconomicMarket, practiceWorldBusinessCapability, settleWorldBusinessMaintenance,
  settleWorldPlaceMaintenance } from '../src/world-businesses.js';
import { contributeOrganizationEffort, decideOrganizationMembership, foundWorldOrganization } from '../src/world-organizations.js';
import { decideProjectMembership, proposeWorldProject } from '../src/world-projects.js';

const databaseUrl = process.env.SYNTERRA_TEST_DATABASE_URL;
const testEnabled = process.env.SYNTERRA_TEST_ISOLATED === '1' && Boolean(databaseUrl);
const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function assertIsolatedTestDatabase(connectionString) {
  const parsed = new URL(connectionString);
  assert.ok(['127.0.0.1','localhost','::1'].includes(parsed.hostname), 'V4 integration requires loopback PostgreSQL');
  assert.ok(decodeURIComponent(parsed.pathname.slice(1)).endsWith('_test'), 'V4 integration requires a database ending in _test');
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

test('V4 economy settles business, project, organization and place value without creating ledger imbalance', {
  skip: !testEnabled,
  timeout: 120_000
}, async () => {
  assertIsolatedTestDatabase(databaseUrl);
  let pool = new Pool({ connectionString: databaseUrl, max: 4 });
  const worldId = randomUUID();
  const [founderId, workerId, customerId, investorId] = Array.from({ length: 4 }, () => randomUUID());
  const agents = [founderId, workerId, customerId, investorId];
  let businessId;
  let projectId;
  let organizationId;
  try {
    const schema = await readFile(path.join(repoRoot, 'schema.sql'), 'utf8');
    await pool.query(schema);
    await pool.query(schema);
    await pool.query(`INSERT INTO agents(id,name,public_key,gender) VALUES
      ($1::uuid,'V4 Founder','v4-founder-key-'||$1::text,'male'),($2::uuid,'V4 Worker','v4-worker-key-'||$2::text,'female'),
      ($3::uuid,'V4 Customer','v4-customer-key-'||$3::text,'female'),($4::uuid,'V4 Investor','v4-investor-key-'||$4::text,'male')`, agents);
    await pool.query(`INSERT INTO worlds(id,owner_agent_id,name,chain_id,open) VALUES($1,$2,'V4 Economy Integration',5042,true)`,
      [worldId, founderId]);
    await pool.query(`INSERT INTO world_members(world_id,agent_id,location,energy,food,social)
      SELECT $1,id,'Cafe',100,100,100 FROM agents WHERE id=ANY($2::uuid[])`, [worldId, agents]);
    await pool.query(`INSERT INTO world_agent_skills(world_id,agent_id,skill_name,skill_value)
      VALUES($1,$2,'research',40)`, [worldId, workerId]);
    await pool.query(`INSERT INTO crypto_risk_limits(world_id,starting_usdc) VALUES($1,10000)
      ON CONFLICT(world_id) DO NOTHING`, [worldId]);
    await pool.query(`INSERT INTO crypto_market_quotes(symbol,price_usd,quote_version,as_of,source) VALUES
      ('USDC',1,1,now(),'synterra_simulated_market'),('BTC',60000,1,now(),'synterra_simulated_market'),
      ('ETH',3000,1,now(),'synterra_simulated_market') ON CONFLICT(symbol) DO UPDATE SET
      price_usd=EXCLUDED.price_usd,quote_version=EXCLUDED.quote_version,as_of=EXCLUDED.as_of,source=EXCLUDED.source`);
    await inTransaction(pool, async (client) => {
      for (const agentId of agents) await ensureCryptoAccount(client, { worldId, agentId });
    });
    await pool.query(`INSERT INTO world_scenes(world_id,created_by,name,scene_type,description,status,
        purpose,capacity,features,position) VALUES($1,$2,'Exchange','commons','Shared economic workspace.','active',
        'A place to meet and buy services.',24,'{}','{}')`, [worldId, founderId]);
    await inTransaction(pool, (client) => observeResidentEconomicMarket(client, { worldId, worldMinutes: 600,
      agent: { agentId: founderId, location: 'Exchange', energy: 80, food: 40, social: 90, knowledge: 90,
        skills: {}, beliefs: [], relationships: [], recentMemories: [], organizationMemberships: [],
        activeProjects: [], projectMemberships: [], organizationPartners: [] },
      context: { scenes: [{ name: 'Exchange', sceneType: 'commons', status: 'active' }], demand: [
        { serviceType: 'food_service', demandCount: 4, supplyCount: 1 },
        { serviceType: 'research_service', demandCount: 3, supplyCount: 0 }
      ], residentsAtLocation: { Exchange: [] } } }));
    const persistedMarketBelief = await pool.query(`SELECT estimate::text,confidence::text,evidence
      FROM world_agent_beliefs WHERE world_id=$1 AND agent_id=$2 AND subject_type='market'
        AND subject_key='food_service' AND belief_key='unmet_demand'`, [worldId, founderId]);
    assert.equal(persistedMarketBelief.rowCount, 1, 'schema accepts resident market beliefs');
    assert.equal(persistedMarketBelief.rows[0].evidence.observedWorldMinutes, 600);

    const concurrentPractice = await Promise.all(Array.from({ length: 2 }, () => inTransaction(pool, (client) =>
      practiceWorldBusinessCapability(client, { worldId, agentId: founderId, skill: 'trading',
        serviceType: 'trading_service', actionId: 'v4-practice-once', worldTime: 599 }))));
    assert.deepEqual(concurrentPractice.map((result) => result.skillGain).sort((a, b) => a - b), [0, 1.5]);
    assert.equal(Number((await pool.query(`SELECT skill_value FROM world_agent_skills
      WHERE world_id=$1 AND agent_id=$2 AND skill_name='trading'`, [worldId, founderId])).rows[0].skill_value), 1.5,
    'concurrent retries of one practice action must add capability only once');

    const proposal = { name: 'Resident Research Studio', businessType: 'research',
      purpose: 'Turn unmet research needs into useful notes for other residents.', serviceType: 'research_service',
      serviceName: 'Research Notes', serviceDescription: 'Resident prepared research notes based on completed study.',
      basePriceUsdc: '35.00000000', capitalUsdc: '250.00000000' };
    const found = await inTransaction(pool, (client) => foundWorldBusiness(client, { worldId, agentId: founderId,
      actionId: 'v4-found-business-1', proposal, worldTime: 600 }));
    businessId = found.id;
    assert.equal(found.capitalUsdc, '250.00000000');
    const founderCash = await getEconomicAccount(pool, { worldId, accountType: 'resident', ownerId: founderId });
    assert.equal(Number(founderCash.balance), 9750);
    assert.equal((await inTransaction(pool, (client) => foundWorldBusiness(client, { worldId, agentId: founderId,
      actionId: 'v4-found-business-1', proposal, worldTime: 600 }))).id, businessId);

    const jobId = (await pool.query('SELECT id FROM world_business_jobs WHERE world_id=$1 AND business_id=$2',
      [worldId, businessId])).rows[0].id;
    const application = await inTransaction(pool, (client) => applyToWorldBusinessJob(client, { worldId,
      jobId, agentId: workerId, actionId: 'v4-application-1', worldTime: 610 }));
    const hired = await inTransaction(pool, (client) => decideWorldBusinessApplication(client, { worldId,
      applicationId: application.id, founderAgentId: founderId, decision: 'accept', actionId: 'v4-hire-1', worldTime: 620 }));
    assert.equal(hired.status, 'active');
    assert.equal((await inTransaction(pool, (client) => decideWorldBusinessApplication(client, { worldId,
      applicationId: application.id, founderAgentId: founderId, decision: 'accept', actionId: 'v4-hire-1', worldTime: 621 }))).idempotent, true);

    const employmentId = hired.id;
    const serviceId = found.serviceId;
    const firstShift = await inTransaction(pool, (client) => completeWorldBusinessShift(client, { worldId,
      businessId, serviceId, employmentId, agentId: workerId, actionId: 'v4-shift-1', worldTime: 630 }));
    assert.equal(firstShift.stockUnits, 1);
    const workerCashAfterShift = await getEconomicAccount(pool, { worldId, accountType: 'resident', ownerId: workerId });
    assert.equal(Number(workerCashAfterShift.balance), 10015);
    await inTransaction(pool, (client) => completeWorldBusinessShift(client, { worldId, businessId, serviceId,
      employmentId, agentId: workerId, actionId: 'v4-shift-1', worldTime: 631 }));
    assert.equal(Number((await getEconomicAccount(pool, { worldId, accountType: 'resident', ownerId: workerId })).balance), 10015);

    await assert.rejects(inTransaction(pool, (client) => purchaseWorldBusinessService(client, { worldId, serviceId,
      customerAgentId: founderId, actionId: 'v4-self-purchase', worldTime: 640, maxPriceUsdc: '100.00000000' })),
    (error) => error.message === 'BUSINESS_OWNER_CANNOT_BE_OWN_CUSTOMER');
    const order = await inTransaction(pool, (client) => purchaseWorldBusinessService(client, { worldId, serviceId,
      customerAgentId: customerId, actionId: 'v4-order-1', worldTime: 640, maxPriceUsdc: '100.00000000',
      demand: 10, supply: 1, wealth: 10_000, priceSensitivity: 0.9 }));
    assert.equal(order.status, 'fulfilled');
    assert.deepEqual(order.benefit, { knowledge: 18, happiness: 5 },
      'the paid research service must deliver the stronger learning benefit used by buyer utility');
    const customerBalanceAfterOrder = (await getEconomicAccount(pool, { worldId, accountType: 'resident', ownerId: customerId })).balance;
    const repeatedOrder = await inTransaction(pool, (client) => purchaseWorldBusinessService(client, { worldId, serviceId,
      customerAgentId: customerId, actionId: 'v4-order-1', worldTime: 641, maxPriceUsdc: '100.00000000' }));
    assert.equal(repeatedOrder.idempotent, true);
    assert.equal((await getEconomicAccount(pool, { worldId, accountType: 'resident', ownerId: customerId })).balance,
      customerBalanceAfterOrder);

    const transferSource = await getEconomicAccount(pool, { worldId, accountType: 'business', ownerId: businessId });
    const transferDestination = await getEconomicAccount(pool, { worldId, accountType: 'resident', ownerId: workerId });
    const retryTransfer = { worldId, sourceAccountId: transferSource.id, destinationAccountId: transferDestination.id,
      amount: '1.00000000', transactionType: 'business_wage', reason: 'Paid shift wage for Resident Research Studio.',
      actionId: 'v4-idempotent-clock-drift', referenceId: employmentId };
    await inTransaction(pool, (client) => postEconomicTransfer(client, { ...retryTransfer, worldTime: 780 }));
    const repeatedTransfer = await inTransaction(pool, (client) => postEconomicTransfer(client,
      { ...retryTransfer, worldTime: 781 }));
    assert.equal(repeatedTransfer.idempotent, true, 'a retry after the world clock advances must preserve the original settlement');
    assert.equal(Number((await pool.query(`SELECT count(*)::int AS count FROM world_economic_transactions
      WHERE world_id=$1 AND action_id=$2`, [worldId, retryTransfer.actionId])).rows[0].count), 1);

    const investment = await inTransaction(pool, (client) => investInWorldBusiness(client, { worldId, businessId,
      investorAgentId: investorId, amount: '50.00000000', actionId: 'v4-business-investment', worldTime: 650 }));
    assert.ok(investment.share > 0 && investment.share < 0.35);
    const project = await inTransaction(pool, (client) => proposeWorldProject(client, { worldId, agentId: founderId,
      actionId: 'v4-economic-project', projectType: 'BUILD', title: 'Cafe Market Project',
      goal: 'Operate a shared venue that funds its research project.',
      description: 'Create a project owned cafe where residents can buy research services.',
      requiredSkills: {}, requiredResources: { maxParticipants: 4 }, reward: {}, worldTime: 660,
      metadata: { createPlace: true, placeType: 'cafe' } }));
    projectId = project.id;
    await inTransaction(pool, (client) => decideProjectMembership(client, { worldId, projectId,
      agentId: workerId, decision: 'accept', actionId: 'v4-project-join', worldTime: 670, agent: { skills: {}, goals: [] } }));
    await inTransaction(pool, (client) => investInWorldProject(client, { worldId, projectId,
      investorAgentId: workerId, amount: '100.00000000', actionId: 'v4-project-investment', worldTime: 680 }));
    const projectAccountBefore = await getEconomicAccount(pool, { worldId, accountType: 'project', ownerId: projectId });
    assert.equal(Number(projectAccountBefore.balance), 100);

    const placeId = randomUUID();
    await pool.query(`INSERT INTO world_scenes(id,world_id,created_by,name,scene_type,description,status,purpose,capacity,
        features,position,created_world_minutes,created_by_project_id,operating_cost_usdc,revenue_enabled,revenue_share_bps)
      VALUES($1,$2,$3,'Cafe Market','cafe','Project owned cafe for service trade.','active','A shared cafe market.',12,
        '{}','{}',690,$4,5,true,2500)`, [placeId, worldId, founderId, projectId]);
    await pool.query(`INSERT INTO world_economic_ownership(world_id,asset_type,asset_id,owner_type,owner_id,share,acquired_world_time)
      VALUES($1,'place',$2,'project',$3,1,690)`, [worldId, placeId, projectId]);
    await pool.query('UPDATE world_businesses SET place_id=$3 WHERE world_id=$1 AND id=$2', [worldId, businessId, placeId]);
    await inTransaction(pool, (client) => completeWorldBusinessShift(client, { worldId, businessId, serviceId,
      employmentId, agentId: workerId, actionId: 'v4-shift-2', worldTime: 700 }));
    const orderAtPlace = await inTransaction(pool, (client) => purchaseWorldBusinessService(client, { worldId, serviceId,
      customerAgentId: customerId, actionId: 'v4-order-at-place', worldTime: 710, maxPriceUsdc: '100.00000000',
      demand: 10, supply: 1, wealth: Number(customerBalanceAfterOrder), priceSensitivity: 0.4 }));
    assert.ok(Number(orderAtPlace.venueFeeUsdc) > 0);
    const projectAccountAfterOrder = await getEconomicAccount(pool, { worldId, accountType: 'project', ownerId: projectId });
    assert.ok(Number(projectAccountAfterOrder.balance) > Number(projectAccountBefore.balance));
    const projectDistribution = await inTransaction(pool, (client) => distributeWorldProjectRevenue(client, { worldId,
      projectId, ownerAgentId: founderId, actionId: 'v4-project-distribution', worldTime: 720 }));
    assert.ok(Number(projectDistribution.distributedUsdc) >= 1);
    assert.equal((await inTransaction(pool, (client) => distributeWorldProjectRevenue(client, { worldId,
      projectId, ownerAgentId: founderId, actionId: 'v4-project-distribution', worldTime: 721 }))).idempotent, true);
    const firstBusinessDistribution = await inTransaction(pool, (client) => distributeWorldBusinessProfit(client, {
      worldId, businessId, ownerAgentId: founderId, actionId: 'v4-business-distribution-1', worldTime: 725 }));
    assert.ok(Number(firstBusinessDistribution.distributedUsdc) > 0);
    const secondBusinessDistribution = await inTransaction(pool, (client) => distributeWorldBusinessProfit(client, {
      worldId, businessId, ownerAgentId: founderId, actionId: 'v4-business-distribution-2', worldTime: 726 }));
    assert.equal(secondBusinessDistribution.profitUsdc, firstBusinessDistribution.profitUsdc,
      'owner distributions reduce undistributed profit, not operating profit');
    assert.ok(Number(secondBusinessDistribution.undistributedProfitUsdc)
      < Number(firstBusinessDistribution.undistributedProfitUsdc));

    await pool.query(`UPDATE world_projects SET status='completed' WHERE world_id=$1 AND id=$2`, [worldId, projectId]);
    await pool.query(`UPDATE world_project_members SET status='completed' WHERE world_id=$1 AND project_id=$2`, [worldId, projectId]);
    const [agentA, agentB] = [founderId, workerId].sort();
    await pool.query(`INSERT INTO world_relationships(world_id,agent_a_id,agent_b_id,familiarity,trust,affinity,interaction_count)
      VALUES($1,$2,$3,40,10,25,3) ON CONFLICT(world_id,agent_a_id,agent_b_id) DO UPDATE SET familiarity=40,trust=10`,
    [worldId, agentA, agentB]);
    const organization = await inTransaction(pool, (client) => foundWorldOrganization(client, { worldId,
      founderAgentId: founderId, inviteAgentId: workerId, actionId: 'v4-organization',
      name: 'Cafe Operators', purpose: 'Coordinate a shared resident cafe and its service income.',
      worldTime: 730, projectId }));
    organizationId = organization.id;
    await inTransaction(pool, (client) => decideOrganizationMembership(client, { worldId, organizationId,
      agentId: workerId, decision: 'accept', actionId: 'v4-org-accept', worldTime: 740 }));
    for (let index = 0; index < 3; index++) await inTransaction(pool, (client) => contributeOrganizationEffort(client, {
      worldId, organizationId, agentId: founderId, actionId: `v4-org-capital-${index}`, worldTime: 750 + index,
      contributionType: 'capital', amountUsdc: 100 }));
    const orgBusiness = await inTransaction(pool, (client) => foundWorldBusiness(client, { worldId, agentId: founderId,
      actionId: 'v4-org-business', proposal: { ...proposal, name: 'Organization Research Desk', placeId: null,
        capitalSource: { type: 'organization', ownerId: organizationId } }, worldTime: 770 }));
    assert.equal(Number((await getEconomicAccount(pool, { worldId, accountType: 'organization', ownerId: organizationId })).balance), 50);
    assert.equal((await listWorldBusinesses(pool, { worldId, limit: 10 })).find((item) => item.id === orgBusiness.id).owners[0].ownerType,
      'organization');
    await assert.rejects(inTransaction(pool, (client) => purchaseWorldBusinessService(client, { worldId,
      serviceId: orgBusiness.serviceId, customerAgentId: founderId, actionId: 'v4-indirect-self-purchase', worldTime: 780,
      maxPriceUsdc: '100.00000000' })), (error) => error.message === 'BUSINESS_OWNER_CANNOT_BE_OWN_CUSTOMER');

    const residentOwnedPlaceId = randomUUID();
    await pool.query(`INSERT INTO world_scenes(id,world_id,created_by,name,scene_type,description,status,purpose,capacity,
        features,position,created_world_minutes,operating_cost_usdc)
      VALUES($1,$2,$3,'Investor Studio','studio','A resident funded private work and research place.','active',
        'A private resident owned research studio.',8,'{}','{}',780,12)`, [residentOwnedPlaceId, worldId, investorId]);
    await pool.query(`INSERT INTO world_economic_ownership(world_id,asset_type,asset_id,owner_type,owner_id,share,acquired_world_time)
      VALUES($1,'place',$2,'resident',$3,1,780)`, [worldId, residentOwnedPlaceId, investorId]);
    await inTransaction(pool, (client) => settleWorldPlaceMaintenance(client, { worldId, worldTime: 1_440 }));

    const dashboard = (await pool.query(economicDashboardSql(), [worldId])).rows[0];
    assert.equal(Number(dashboard.businesses), 2);
    assert.ok(Number(dashboard.business_revenue) > 0);
    assert.ok(Number(dashboard.investment_volume) >= 150);
    const expectedCirculation = (await pool.query(`SELECT COALESCE(sum(balance),0)::text AS balance
      FROM world_economic_accounts WHERE world_id=$1 AND account_type<>'system' AND asset_symbol='USDC'`, [worldId])).rows[0].balance;
    assert.equal(dashboard.usdc_circulation, expectedCirculation,
      'USDC circulation includes balances held by businesses, projects, and organizations');
    const expectedBusinessExpenses = (await pool.query(`SELECT COALESCE(-sum(posting.amount),0)::text AS amount
      FROM world_economic_postings posting JOIN world_economic_transactions tx ON tx.id=posting.transaction_id
      JOIN world_economic_accounts account ON account.id=posting.account_id
      WHERE tx.world_id=$1 AND account.account_type='business' AND account.asset_symbol='USDC'
        AND posting.amount<0 AND tx.transaction_type IN ('business_expense','business_wage','maintenance')`, [worldId])).rows[0].amount;
    assert.equal(dashboard.business_expenses, expectedBusinessExpenses,
      'resident owned place maintenance is not counted as a business expense');
    assert.equal(Number(dashboard.business_profit_loss),
      Number(dashboard.business_revenue) - Number(expectedBusinessExpenses));
    const ledger = await pool.query(`SELECT count(*) FILTER (WHERE postings.net<>0)::int AS unbalanced FROM (
        SELECT tx.id,sum(posting.amount)::numeric AS net FROM world_economic_transactions tx
        JOIN world_economic_postings posting ON posting.transaction_id=tx.id WHERE tx.world_id=$1 GROUP BY tx.id
      ) postings`, [worldId]);
    assert.equal(ledger.rows[0].unbalanced, 0);
    const mirror = await pool.query(`SELECT count(*)::int AS drift FROM world_economic_accounts account
      LEFT JOIN crypto_balances legacy ON legacy.world_id=account.world_id AND legacy.agent_id=account.owner_id
        AND legacy.asset_symbol=account.asset_symbol
      WHERE account.world_id=$1 AND account.account_type='resident' AND account.balance<>COALESCE(legacy.balance,0)`, [worldId]);
    assert.equal(mirror.rows[0].drift, 0);

    const orphanBusiness = await inTransaction(pool, (client) => foundWorldBusiness(client, { worldId, agentId: customerId,
      actionId: 'v4-bankruptcy-business', proposal: { ...proposal, name: 'Short Lived Studio', placeId: null }, worldTime: 800 }));
    for (let day = 1; day <= 53; day++) {
      await inTransaction(pool, (client) => settleWorldBusinessMaintenance(client, { worldId, worldTime: 800 + day * 1_440 }));
      if (day === 2) {
        const losses = await pool.query('SELECT status,consecutive_loss_days FROM world_businesses WHERE world_id=$1 AND id=$2',
          [worldId, orphanBusiness.id]);
        assert.equal(losses.rows[0].status, 'active');
        assert.equal(losses.rows[0].consecutive_loss_days, 1,
          'a business can meet maintenance while its posted daily operating result still records a loss');
      }
    }
    const bankrupt = (await pool.query('SELECT status FROM world_businesses WHERE world_id=$1 AND id=$2',
      [worldId, orphanBusiness.id])).rows[0];
    assert.equal(bankrupt.status, 'bankrupt');
    const maintenance = await pool.query(`SELECT account.balance::text AS balance,count(tx.id)::int AS transactions
      FROM world_economic_accounts account LEFT JOIN world_economic_transactions tx ON tx.world_id=account.world_id
        AND tx.reference_id=$2 AND tx.transaction_type='maintenance'
      WHERE account.world_id=$1 AND account.account_type='business' AND account.owner_id=$3
      GROUP BY account.id`, [worldId, orphanBusiness.id, orphanBusiness.id]);
    assert.equal(maintenance.rows[0].balance, '0.00000000', 'daily operating costs must debit the business account');
    assert.equal(maintenance.rows[0].transactions, 50,
      'the business should survive its funded 50 operating days before losses can legitimately bankrupt it');
    await inTransaction(pool, (client) => settleWorldPlaceMaintenance(client, { worldId, worldTime: 1_440 }));
    await inTransaction(pool, (client) => settleWorldPlaceMaintenance(client, { worldId, worldTime: 1_440 }));
    const placeMaintenanceCount = Number((await pool.query(`SELECT count(*)::int AS count FROM world_economic_transactions
      WHERE world_id=$1 AND reference_id=$2 AND transaction_type='maintenance'`, [worldId, placeId])).rows[0].count);
    assert.equal(placeMaintenanceCount, 1, 'place maintenance must settle once per world day');

    const snapshot = await pool.query(`SELECT (SELECT count(*)::int FROM world_businesses WHERE world_id=$1) AS businesses,
        (SELECT count(*)::int FROM world_economic_transactions WHERE world_id=$1) AS transactions,
        (SELECT count(*)::int FROM world_business_employment WHERE world_id=$1 AND status='active') AS employment`, [worldId]);
    await pool.end();
    pool = new Pool({ connectionString: databaseUrl, max: 2 });
    const restored = await pool.query(`SELECT (SELECT count(*)::int FROM world_businesses WHERE world_id=$1) AS businesses,
        (SELECT count(*)::int FROM world_economic_transactions WHERE world_id=$1) AS transactions,
        (SELECT count(*)::int FROM world_business_employment WHERE world_id=$1 AND status='active') AS employment`, [worldId]);
    assert.deepEqual(restored.rows[0], snapshot.rows[0]);
  } finally {
    await pool.query('DELETE FROM worlds WHERE id=$1', [worldId]).catch(() => {});
    await pool.query('DELETE FROM agents WHERE id=ANY($1::uuid[])', [agents]).catch(() => {});
    await pool.end();
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { getEconomicAccount } from '../src/economic-ledger.js';
import { fundTestResidents } from './helpers/economic-fixtures.js';
import { closeWorldBusiness, foundWorldBusiness, observeWorldBusinessMarket, reopenWorldBusiness } from '../src/world-businesses.js';

const databaseUrl = process.env.SYNTERRA_TEST_DATABASE_URL;
const enabled = process.env.SYNTERRA_TEST_ISOLATED === '1' && Boolean(databaseUrl);
const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function assertIsolatedDatabase(connectionString) {
  const parsed = new URL(connectionString);
  assert.ok(['127.0.0.1','localhost','::1'].includes(parsed.hostname), 'V5.2 integration requires loopback PostgreSQL');
  assert.ok(decodeURIComponent(parsed.pathname.slice(1)).endsWith('_test'), 'V5.2 integration requires a *_test database');
  assert.notEqual(parsed.port, '5432', 'V5.2 integration must not use the default PostgreSQL port');
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
  } finally { client.release(); }
}

test('V5.2 shortage observation can fund and reopen a failed provider without ledger drift', {
  skip: !enabled,
  timeout: 120_000
}, async () => {
  assertIsolatedDatabase(databaseUrl);
  const pool = new Pool({ connectionString: databaseUrl, max: 4 });
  const worldId = randomUUID();
  const [founderId, customerId] = [randomUUID(), randomUUID()];
  try {
    await pool.query(await readFile(path.join(repoRoot, 'schema.sql'), 'utf8'));
    await pool.query(`DELETE FROM world_economic_demand WHERE world_id=$1`, [worldId]);
    await pool.query(`INSERT INTO agents(id,name,public_key,gender) VALUES
      ($1::uuid,'V5.2 Reopen Founder','v52-founder-'||$1::text,'female'),
      ($2::uuid,'V5.2 Reopen Customer','v52-customer-'||$2::text,'male')`, [founderId, customerId]);
    await pool.query(`INSERT INTO worlds(id,owner_agent_id,name,chain_id,open)
      VALUES($1,$2,'V5.2 Reopen Integration',5042,true)`, [worldId, founderId]);
    await pool.query(`INSERT INTO world_members(world_id,agent_id,location,energy,food,social)
      VALUES($1,$2,'Exchange',90,80,70),($1,$3,'Exchange',90,80,70)`, [worldId, founderId, customerId]);
    await inTransaction(pool, (client) => fundTestResidents(client, { worldId, agentIds: [founderId, customerId] }));
    const placeId = randomUUID();
    await pool.query(`INSERT INTO world_scenes(id,world_id,created_by,name,scene_type,description,status,purpose,
        capacity,features,position) VALUES($1,$2,$3,'Exchange','commons','A shared market research place.',
        'active','Observe resident service demand.',12,'{}','{}')`, [placeId, worldId, founderId]);

    const proposal = { name: 'Reopenable Food Cooperative', businessType: 'food', purpose: 'Serve verified unmet meal demand.',
      serviceType: 'food_service', serviceName: 'Prepared Meals',
      serviceDescription: 'Meals prepared for residents after market observation.', basePriceUsdc: '12.00000000',
      capitalUsdc: '250.00000000', placeId };
    const founded = await inTransaction(pool, (client) => foundWorldBusiness(client, { worldId, agentId: founderId,
      actionId: 'v52-reopen-found', proposal, worldTime: 1_400 }));
    const closed = await inTransaction(pool, (client) => closeWorldBusiness(client, { worldId, businessId: founded.id,
      founderAgentId: founderId, actionId: 'v52-reopen-close', worldTime: 1_410 }));
    assert.equal(closed.status, 'closed');
    await pool.query(`INSERT INTO world_economic_demand(world_id,service_type,world_day,demand_count,supply_count,
        unmet_count,evidence) VALUES($1,'food_service',1,4,0,4,'{"source":"persistent_shortage"}')`, [worldId]);

    const observation = await inTransaction(pool, (client) => observeWorldBusinessMarket(client, { worldId,
      agentId: founderId, serviceType: 'food_service', actionId: 'v52-observe-food-shortage', worldTime: 1_500,
      location: 'Exchange' }));
    assert.equal(observation.demandCount, 4);
    assert.equal(observation.unmetCount, 4);
    assert.equal(observation.supplyCount, 0);
    const belief = await pool.query(`SELECT estimate::text,confidence::text,evidence FROM world_agent_beliefs
      WHERE world_id=$1 AND agent_id=$2 AND subject_type='market' AND subject_key='food_service'
        AND belief_key='unmet_demand'`, [worldId, founderId]);
    assert.equal(belief.rowCount, 1);
    assert.equal(belief.rows[0].evidence.awareness, 'exchange_market_research');

    const founderCashBefore = Number((await getEconomicAccount(pool, { worldId, accountType: 'resident', ownerId: founderId })).balance);
    const reopenProposal = { businessId: founded.id, serviceType: 'food_service', capitalUsdc: '250.00000000',
      serviceName: 'Prepared Meals 2', serviceDescription: 'Meals produced after the cooperative reopens.' };
    const reopened = await inTransaction(pool, (client) => reopenWorldBusiness(client, { worldId, agentId: founderId,
      actionId: 'v52-reopen-on-shortage', proposal: reopenProposal, worldTime: 1_500 }));
    assert.equal(reopened.status, 'active');
    assert.equal(reopened.reopened, true);
    assert.equal(reopened.serviceType, 'food_service');
    assert.equal(reopened.capitalUsdc, '250.00000000');
    const retry = await inTransaction(pool, (client) => reopenWorldBusiness(client, { worldId, agentId: founderId,
      actionId: 'v52-reopen-on-shortage', proposal: reopenProposal, worldTime: 1_501 }));
    assert.equal(retry.idempotent, true);
    assert.equal(retry.transactionId, reopened.transactionId);

    const state = await pool.query(`SELECT business.status AS "businessStatus",service.active AS "serviceActive",
        (SELECT count(*)::int FROM world_business_jobs job WHERE job.world_id=business.world_id
          AND job.business_id=business.id AND job.status='open') AS "openJobs",
        account.balance::text AS "businessCash"
      FROM world_businesses business JOIN world_business_services service ON service.business_id=business.id
        AND service.world_id=business.world_id
      JOIN world_economic_accounts account ON account.world_id=business.world_id
        AND account.account_key='business:'||business.id::text AND account.asset_symbol='USDC'
      WHERE business.world_id=$1 AND business.id=$2`, [worldId, founded.id]);
    assert.equal(state.rows[0].businessStatus, 'active');
    assert.equal(state.rows[0].serviceActive, true);
    assert.ok(state.rows[0].openJobs > 0, 'reopening creates a real hiring path');
    assert.equal(Number(state.rows[0].businessCash), 500,
      'the reopened business retains its original 250 and receives one new 250 working-capital transfer');
    const founderCashAfter = Number((await getEconomicAccount(pool, { worldId, accountType: 'resident', ownerId: founderId })).balance);
    assert.equal(founderCashBefore - founderCashAfter, 250);
    const transaction = await pool.query(`SELECT tx.id,tx.amount::text AS amount,count(posting.id)::int AS postings,
        sum(posting.amount)::text AS net FROM world_economic_transactions tx
      JOIN world_economic_postings posting ON posting.transaction_id=tx.id
      WHERE tx.world_id=$1 AND tx.action_id='business-reopen:'||$2::text||':v52-reopen-on-shortage'
      GROUP BY tx.id`, [worldId, founded.id]);
    assert.equal(transaction.rowCount, 1, 'reopen capital settles exactly once');
    assert.equal(transaction.rows[0].amount, '250.00000000');
    assert.equal(transaction.rows[0].postings, 2);
    assert.equal(Number(transaction.rows[0].net), 0);
  } finally {
    await pool.query('DELETE FROM worlds WHERE id=$1', [worldId]).catch(() => {});
    await pool.query('DELETE FROM agents WHERE id=ANY($1::uuid[])', [[founderId, customerId]]).catch(() => {});
    await pool.end();
  }
});

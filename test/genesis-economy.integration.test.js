import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { id, Interface, keccak256 } from 'ethers';
import { Pool } from 'pg';
import { applyWorldSchemaAndMigrations } from '../src/database-migrations.js';
import { arcNetworkConfig } from '../src/arc/config.js';
import { enqueueArcAgentEconomicAction } from '../src/arc/agent-economic-action.js';
import { prepareGenesisTokenSettlementAuthorization, recordGenesisTokenSettlementSubmission } from '../src/arc/genesis-token-settlement-api.js';
import { ARC_GENESIS_TOKEN_ERC20_INTERFACE, ARC_GENESIS_TOKEN_SETTLEMENT_INTERFACE,
  auditGenesisTokenSettlementReceipt, buildGenesisTokenSettlementCall, buildGenesisTokenSettlementWalletAuthorization,
  genesisSettlementWorldId } from '../src/arc/genesis-token-settlement.js';
import { ArcGenesisTokenSettlementReconciler } from '../src/arc/genesis-token-settlement-reconciler.js';
import { createArcGenesisTokenSettlementIntent, genesisSettlementActionHash, readActiveGenesisTokenAssets,
  readGenesisBusinessEquity, readGenesisCurrencyActivation,
  readGenesisTokenWalletSnapshots } from '../src/genesis-economy.js';
import { confirmWorldTokenIssuance, createWorldTokenIssuanceIntent } from '../src/world-token-issuance.js';
import { getEconomicAccount } from '../src/economic-ledger.js';
import { completeWorldBusinessShift, buildBusinessCandidates, investInWorldBusiness,
  applyToWorldBusinessJob, decideWorldBusinessApplication, leaveWorldBusinessJob, listWorldBusinesses,
  loadWorldBusinessContext, publishGenesisTokenJobWage, publishGenesisTokenServicePrice,
  purchaseWorldBusinessService } from '../src/world-businesses.js';
import { acceptGenesisTokenEmploymentWage } from '../src/world-businesses.js';

const databaseUrl = process.env.SYNTERRA_TEST_DATABASE_URL;
const enabled = process.env.SYNTERRA_TEST_ISOLATED === '1' && Boolean(databaseUrl);
const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CHAIN_ID = 5042;
const randomHash = () => `0x${randomBytes(32).toString('hex')}`;
const randomAddress = () => `0x${randomBytes(20).toString('hex')}`;
const TOKEN_ADDRESS = randomAddress();
const SETTLEMENT_ADDRESS = randomAddress();
const OWNER_ADDRESS = randomAddress();
const CUSTOMER_ADDRESS = randomAddress();
const EMPLOYEE_ADDRESS = randomAddress();
const SCA_ADDRESS = randomAddress();
const ORGANIZATION_ADDRESS = randomAddress();
const FACTORY_ADDRESS = randomAddress();
const CODE = '0x6001600055';
const TX_HASH = randomHash();

function assertIsolatedDatabase(connectionString) {
  const url = new URL(connectionString);
  assert.ok(['127.0.0.1', 'localhost', '::1'].includes(url.hostname), 'Genesis integration must use loopback PostgreSQL');
  assert.ok(url.port && url.port !== '5432', 'Genesis integration must not use the formal/default PostgreSQL port');
  assert.ok(decodeURIComponent(url.pathname.slice(1)).endsWith('_test'), 'Genesis integration requires a *_test database');
}

async function seedWorld(pool) {
  const worldId = randomUUID();
  const founderId = randomUUID();
  const customerId = randomUUID();
  const employeeId = randomUUID();
  const scaId = randomUUID();
  const organizationId = randomUUID();
  const businessId = randomUUID();
  const serviceId = randomUUID();
  const jobId = randomUUID();
  const reentryJobId = randomUUID();
  const employmentId = randomUUID();
  const intentId = randomUUID();
  const tokenId = randomUUID();
  const specificationHash = randomHash();
  const issuanceTransactionHash = randomHash();
  const activationTransactionHash = randomHash();
  const paperTokenAddress = `0x${randomUUID().replaceAll('-', '').padEnd(40, '0')}`;
  const paperCurveAddress = `0x${randomUUID().replaceAll('-', '').padEnd(40, '0')}`;
  const paperPairAddress = `0x${randomUUID().replaceAll('-', '').padEnd(40, '0')}`;

  await pool.query(`INSERT INTO agents(id,name,public_key) VALUES
    ($1,'Genesis Economy Founder',$2),($3,'Genesis Economy Customer',$4),
    ($5,'Genesis Economy Employee',$6),($7,'Genesis Economy SCA Resident',$8)`,
  [founderId, `genesis-founder-${founderId}`, customerId, `genesis-customer-${customerId}`,
    employeeId, `genesis-employee-${employeeId}`, scaId, `genesis-sca-${scaId}`]);
  await pool.query(`INSERT INTO worlds(id,owner_agent_id,name,chain_id) VALUES($1,$2,'Genesis Economy Isolation',5042)`,
    [worldId, founderId]);
  await pool.query(`INSERT INTO world_members(world_id,agent_id,role,location) VALUES
    ($1,$2,'owner','town-square'),($1,$3,'resident','town-square'),($1,$4,'resident','workshop'),($1,$5,'resident','cafe')`,
  [worldId, founderId, customerId, employeeId, scaId]);
  await pool.query(`INSERT INTO world_organizations(id,world_id,name,purpose,founder_agent_id,status,action_id,
      created_world_time,updated_world_time)
    VALUES($1,$2,'Genesis Economy Organization','An isolated wallet ownership fixture for settlement testing.',
      $3,'active','genesis-org-fixture',900,900)`,
  [organizationId, worldId, founderId]);

  await pool.query(`INSERT INTO world_businesses(id,world_id,founder_agent_id,name,business_type,purpose,status,
      valuation_usdc,founded_world_time,action_id,metadata)
    VALUES($1,$2,$3,'Historical Quote Research Studio','research','A fixture business with retained legacy simulated quotes.','active',
      120.00000000,100,'genesis-business-fixture','{"serviceType":"research_service"}')`,
  [businessId, worldId, founderId]);
  await pool.query(`INSERT INTO world_business_services(id,world_id,business_id,service_type,name,description,
      base_price_usdc,stock_units,action_id,created_world_time)
    VALUES($1,$2,$3,'research_service','Research Brief','A useful research brief produced from completed study.',12.50000000,20,
      'genesis-service-fixture',100)`, [serviceId, worldId, businessId]);
  await pool.query(`INSERT INTO world_business_jobs(id,world_id,business_id,role,required_skill,wage_usdc,status,
      created_world_time,action_id) VALUES
    ($1,$2,$3,'Research Associate','research',3.25000000,'filled',100,'genesis-job-fixture'),
    ($4,$2,$3,'Research Editor','research',NULL,'open',120,'genesis-reentry-job-fixture')`,
  [jobId, worldId, businessId, reentryJobId]);
  await pool.query(`INSERT INTO world_business_employment(id,world_id,business_id,job_id,agent_id,wage_usdc,status,started_world_time)
    VALUES($1,$2,$3,$4,$5,3.25000000,'active',105)`, [employmentId, worldId, businessId, jobId, employeeId]);
  await pool.query(`INSERT INTO world_economic_ownership(world_id,asset_type,asset_id,owner_type,owner_id,share,
      invested_usdc,acquired_world_time) VALUES
      ($1,'business',$2,'resident',$3,0.6000000,120.00000000,100),
      ($1,'business',$2,'resident',$4,0.4000000,80.00000000,110)`,
  [worldId, businessId, founderId, customerId]);

  await pool.query(`INSERT INTO world_economic_accounts(world_id,account_type,account_key,owner_id,asset_symbol,balance)
    VALUES($1,'resident',$2::text,$2::uuid,'USDC',700.00000000),($1,$3,$4,$5,'USDC',850.00000000)`,
  [worldId, founderId, 'business', `business:${businessId}`, businessId]);
  const accounts = await pool.query(`SELECT account_key,id FROM world_economic_accounts WHERE world_id=$1
    AND account_key=ANY($2::text[])`, [worldId, [founderId, `business:${businessId}`]]);
  const accountIds = Object.fromEntries(accounts.rows.map((row) => [row.account_key, row.id]));
  const ledgerClient = await pool.connect();
  try {
    await ledgerClient.query('BEGIN');
    const legacyTransaction = await ledgerClient.query(`INSERT INTO world_economic_transactions(world_id,action_id,transaction_type,
        source_account_id,destination_account_id,asset_symbol,amount,reason,world_time)
      VALUES($1,'legacy-usdc-service-revenue','business_revenue',$2,$3,'USDC',12.50000000,
        'Historical simulated service revenue fixture.',110) RETURNING id`,
    [worldId, accountIds[founderId], accountIds[`business:${businessId}`]]);
    await ledgerClient.query(`INSERT INTO world_economic_postings(transaction_id,account_id,amount) VALUES
      ($1,$2,-12.50000000),($1,$3,12.50000000)`,
    [legacyTransaction.rows[0].id, accountIds[founderId], accountIds[`business:${businessId}`]]);
    await ledgerClient.query('COMMIT');
  } catch (error) {
    await ledgerClient.query('ROLLBACK');
    throw error;
  } finally { ledgerClient.release(); }
  await pool.query(`INSERT INTO token_ledger(world_id,agent_id,amount,entry_type,reason,action_id)
    VALUES($1,$2,321.00000000,'mined','legacy internal unit history','legacy-token-fixture')`, [worldId, founderId]);
  await pool.query(`INSERT INTO crypto_balances(world_id,agent_id,asset_symbol,balance) VALUES
    ($1,$2,'USDC',300.00000000),($1,$2,'BTC',0.12500000)`, [worldId, founderId]);
  await pool.query(`INSERT INTO crypto_ledger(world_id,agent_id,asset_symbol,amount,entry_type,reference_id,reason) VALUES
    ($1,$2,'USDC',300.00000000,'seed','legacy-usdc-seed','legacy USDC balance'),
    ($1,$2,'BTC',0.12500000,'buy','legacy-btc-buy','legacy BTC purchase')`, [worldId, founderId]);
  const cryptoOrderId = randomUUID();
  await pool.query(`INSERT INTO crypto_orders(id,world_id,agent_id,action_id,side,asset_symbol,quote_version,quantity,
      price_usd,notional_usd,fee_usdc,status,data)
    VALUES($1,$2,$3,'legacy-crypto-order','buy','BTC',1,0.12500000,64000,8000,8,'filled','{"history":"preserve"}')`,
  [cryptoOrderId, worldId, founderId]);
  await pool.query(`INSERT INTO crypto_trades(order_id,world_id,agent_id,side,asset_symbol,quantity,price_usd,notional_usd,fee_usdc)
    VALUES($1,$2,$3,'buy','BTC',0.12500000,64000,8000,8)`, [cryptoOrderId, worldId, founderId]);
  await pool.query(`INSERT INTO robinhood_tokens(token_address,curve_address,symbol,name,decimals,pair_token_address,
      launch_config_id,launch_block,launch_tx_hash)
    VALUES($1,$2,'OLD','Old paper token',18,$3,1,1000,$4)`,
  [paperTokenAddress, paperCurveAddress, paperPairAddress, TX_HASH]);
  const paperOrderId = randomUUID();
  await pool.query(`INSERT INTO robinhood_paper_positions(world_id,agent_id,token_address,quantity_raw)
    VALUES($1,$2,$3,9000000000000000000)`, [worldId, founderId, paperTokenAddress]);
  await pool.query(`INSERT INTO robinhood_paper_orders(id,world_id,agent_id,action_id,side,token_address,quote_version,
      token_amount_raw,native_quote_raw,notional_usd,fee_usdc,status,data)
    VALUES($1,$2,$3,'legacy-robinhood-order','buy',$4,1,9000000000000000000,1000000000000000,9,0.09,'filled','{"history":"preserve"}')`,
  [paperOrderId, worldId, founderId, paperTokenAddress]);
  await pool.query(`INSERT INTO robinhood_paper_ledger(world_id,agent_id,token_address,order_id,side,quantity_delta_raw)
    VALUES($1,$2,$3,$4,'buy',9000000000000000000)`, [worldId, founderId, paperTokenAddress, paperOrderId]);
  await pool.query(`INSERT INTO world_business_orders(world_id,business_id,service_id,customer_agent_id,price_usdc,
      status,action_id,world_time,benefit)
    VALUES($1,$2,$3,$4,12.50000000,'fulfilled','legacy-business-order',110,'{"knowledge":2}')`,
  [worldId, businessId, serviceId, customerId]);

  const issuerWallet = `0x${randomUUID().replaceAll('-', '').padEnd(40, '0')}`;
  await pool.query(`INSERT INTO arc_token_issuance_intents(id,world_id,proposer_agent_id,issuer_agent_id,status,
      decision_path,name,symbol,meaning,purpose,rationale,decimals,unallocated_supply_handling,ownership_model,
      authority_model,initial_supply_raw,distribution,reserve_amount_raw,issuer_identity_id,issuer_wallet,
      specification_hash,transaction_sender,transaction_hash,transaction_block,transaction_log_index,
      created_world_minute,issuer_confirmed_world_minute,updated_world_minute,action_id,issuer_selection_source)
    VALUES($1,$2,$3,$3,'created','agent_api','Genesis Fixture Token','GFT','A test-only asset','Isolated Genesis economy testing',
      'Fixture only',6,'fully_distributed','erc20_holder_owned','no_mint_no_burn',1000000000000000,
      jsonb_build_array(jsonb_build_object('recipientAddress',$4::text,'amountRaw','1000000000000000')),
      0,1001,$5,$6,$5,$7,100,0,1000,1000,1000,'genesis-issuance-fixture','creator_genesis_assignment')`,
  [intentId, worldId, founderId, OWNER_ADDRESS, issuerWallet, specificationHash, issuanceTransactionHash]);
  await pool.query(`INSERT INTO arc_agent_tokens(id,world_id,intent_id,capability_generation,creation_sequence,chain_id,
      token_address,factory_address,name,symbol,decimals,unallocated_supply_handling,ownership_model,authority_model,
      initial_supply_raw,reserve_supply_raw,issuer_agent_id,issuer_identity_id,issuer_wallet,transaction_sender,
      specification_hash,transaction_hash,block_number,log_index,created_world_minute)
    VALUES($1,$2,$3,1,1,$4,$5,$6,'Genesis Fixture Token','GFT',6,'fully_distributed','erc20_holder_owned',
      'no_mint_no_burn',1000000000000000,0,$7,1001,$8,$8,$9,$10,100,0,1000)`,
  [tokenId, worldId, intentId, CHAIN_ID, TOKEN_ADDRESS, FACTORY_ADDRESS, founderId, issuerWallet,
    specificationHash, issuanceTransactionHash]);
  await pool.query(`INSERT INTO world_genesis_issuer_assignments(world_id,capability_generation,issuer_agent_id,
      selection_source,assigned_world_minute) VALUES($1,1,$2,'creator_genesis_assignment',990)`, [worldId, founderId]);
  await pool.query(`INSERT INTO arc_currency_genesis_requirements(world_id,capability_generation,status,
      satisfied_token_id,satisfied_world_minute,first_required_world_minute,last_transition_world_minute)
    VALUES($1,1,'SATISFIED',$2,1000,900,1000)`, [worldId, tokenId]);
  await pool.query(`INSERT INTO world_genesis_currency_activations(world_id,capability_generation,token_id,chain_id,
      issuer_agent_id,issuer_selection_source,transaction_hash,block_number,world_minute,creator_allocation_raw)
    VALUES($1,1,$2,$3,$4,'creator_genesis_assignment',$5,100,1000,0)`,
  [worldId, tokenId, CHAIN_ID, founderId, activationTransactionHash]);

  await pool.query(`INSERT INTO arc_agent_wallets(world_id,agent_id,chain_id,address,provider,account_type,status,external_identity_id)
    VALUES($1,$2,$3,$4,'external_kms','eoa','active','9001'),($1,$5,$3,$6,'external_kms','eoa','active',NULL),
      ($1,$7,$3,$8,'external_kms','eoa','active',NULL),($1,$9,$3,$10,'external_kms','sca','active',NULL)`,
  [worldId, founderId, CHAIN_ID, OWNER_ADDRESS, customerId, CUSTOMER_ADDRESS, employeeId, EMPLOYEE_ADDRESS, scaId, SCA_ADDRESS]);
  await pool.query(`INSERT INTO arc_organization_wallets(world_id,organization_id,chain_id,address,provider,account_type,status)
    VALUES($1,$2,$3,$4,'external_kms','sca','active')`, [worldId, organizationId, CHAIN_ID, ORGANIZATION_ADDRESS]);
  const observedAt = new Date();
  await pool.query(`INSERT INTO world_genesis_token_balance_snapshots(world_id,token_id,chain_id,wallet_address,
      agent_id,balance_raw,block_number,observed_at) VALUES
      ($1,$2,$3,$4,$5,1000000000,100,$6),($1,$2,$3,$7,$8,3000000,100,$6),
      ($1,$2,$3,$9,$10,0,100,$6),($1,$2,$3,$11,$12,7000000,100,$6)`,
  [worldId, tokenId, CHAIN_ID, OWNER_ADDRESS, founderId, observedAt,
    CUSTOMER_ADDRESS, customerId, EMPLOYEE_ADDRESS, employeeId, SCA_ADDRESS, scaId]);
  await pool.query(`INSERT INTO arc_genesis_token_settlement_contracts(world_id,token_id,chain_id,contract_address,
      runtime_code_hash,verified_block,status,observed_at,approved_at)
    VALUES($1,$2,$3,$4,$5,90,'active',now(),now())`,
  [worldId, tokenId, CHAIN_ID, SETTLEMENT_ADDRESS, keccak256(CODE)]);
  return { worldId, founderId, customerId, employeeId, scaId, organizationId,
    businessId, serviceId, jobId, reentryJobId, employmentId, intentId, tokenId, paperTokenAddress, observedAt };
}

async function snapshotLegacyRecords(pool, fixture) {
  const { worldId, founderId, paperTokenAddress } = fixture;
  const queries = {
    tokenLedger: [`SELECT to_jsonb(row) AS value FROM token_ledger row WHERE world_id=$1 ORDER BY id`, [worldId]],
    economicAccounts: [`SELECT to_jsonb(row) AS value FROM world_economic_accounts row WHERE world_id=$1 ORDER BY account_key,asset_symbol`, [worldId]],
    businessOwnership: [`SELECT to_jsonb(row) AS value FROM world_economic_ownership row WHERE world_id=$1 ORDER BY asset_type,asset_id,owner_type,owner_id`, [worldId]],
    economicTransactions: [`SELECT to_jsonb(row) AS value FROM world_economic_transactions row WHERE world_id=$1 ORDER BY id`, [worldId]],
    economicPostings: [`SELECT to_jsonb(posting) AS value FROM world_economic_postings posting
      JOIN world_economic_transactions tx ON tx.id=posting.transaction_id WHERE tx.world_id=$1 ORDER BY posting.id`, [worldId]],
    cryptoBalances: [`SELECT to_jsonb(row) AS value FROM crypto_balances row WHERE world_id=$1 ORDER BY agent_id,asset_symbol`, [worldId]],
    cryptoLedger: [`SELECT to_jsonb(row) AS value FROM crypto_ledger row WHERE world_id=$1 ORDER BY id`, [worldId]],
    cryptoOrders: [`SELECT to_jsonb(row) AS value FROM crypto_orders row WHERE world_id=$1 ORDER BY id`, [worldId]],
    cryptoTrades: [`SELECT to_jsonb(row) AS value FROM crypto_trades row WHERE world_id=$1 ORDER BY id`, [worldId]],
    paperPositions: [`SELECT to_jsonb(row) AS value FROM robinhood_paper_positions row WHERE world_id=$1 ORDER BY agent_id,token_address`, [worldId]],
    paperOrders: [`SELECT to_jsonb(row) AS value FROM robinhood_paper_orders row WHERE world_id=$1 ORDER BY id`, [worldId]],
    paperLedger: [`SELECT to_jsonb(row) AS value FROM robinhood_paper_ledger row WHERE world_id=$1 ORDER BY id`, [worldId]],
    businessOrders: [`SELECT to_jsonb(row) AS value FROM world_business_orders row WHERE world_id=$1 ORDER BY id`, [worldId]],
    businessServices: [`SELECT to_jsonb(row) AS value FROM world_business_services row WHERE world_id=$1 ORDER BY id`, [worldId]],
    businessJobs: [`SELECT to_jsonb(row) AS value FROM world_business_jobs row WHERE world_id=$1 ORDER BY id`, [worldId]],
    employment: [`SELECT id,world_id,business_id,job_id,agent_id,wage_usdc,status,started_world_time
      FROM world_business_employment WHERE world_id=$1 AND id=$2`, [worldId, fixture.employmentId]],
    paperToken: [`SELECT to_jsonb(row) AS value FROM robinhood_tokens row WHERE token_address=$1`, [paperTokenAddress]]
  };
  const result = {};
  for (const [key, [sql, values]] of Object.entries(queries)) {
    result[key] = (await pool.query(sql, values)).rows.map((row) => row.value);
  }
  return result;
}

function fakeReadOnlyArcRpc({ worldId }) {
  const calls = [];
  const logQueries = [];
  const receipts = new Map();
  const transactions = new Map();
  const settlementInterface = ARC_GENESIS_TOKEN_SETTLEMENT_INTERFACE;
  let logs = [];
  let failBalanceReadAfterReceipt = false;
  let balanceReadFailures = 0;
  const rpc = {
    calls,
    async getChainId() { calls.push('getChainId'); return CHAIN_ID; },
    async getBlockNumber() { calls.push('getBlockNumber'); return '0x100'; },
    async getCode() { calls.push('getCode'); return CODE; },
    async getLogs(filter) { calls.push('getLogs'); logQueries.push(filter); return logs; },
    async getTransactionReceipt(hash) {
      calls.push('getTransactionReceipt');
      if (failBalanceReadAfterReceipt) { balanceReadFailures += 1; failBalanceReadAfterReceipt = false; }
      return receipts.get(hash.toLowerCase()) || null;
    },
    async getTransaction(hash) { calls.push('getTransaction'); return transactions.get(hash.toLowerCase()) || null; },
    async call(transaction) {
      calls.push('eth_call');
      const selector = String(transaction.data || '').slice(0, 10).toLowerCase();
      if (selector === settlementInterface.getFunction('worldId').selector.toLowerCase()) {
        return settlementInterface.encodeFunctionResult('worldId', [`0x${worldId.replaceAll('-', '')}`]);
      }
      if (selector === settlementInterface.getFunction('token').selector.toLowerCase()) {
        return settlementInterface.encodeFunctionResult('token', [TOKEN_ADDRESS]);
      }
      if (selector === ARC_GENESIS_TOKEN_ERC20_INTERFACE.getFunction('balanceOf').selector.toLowerCase()) {
        if (balanceReadFailures > 0) {
          balanceReadFailures -= 1;
          throw Object.assign(new Error('Temporary isolated balance read failure.'), { code: 'ARC_TEMPORARY_BALANCE_READ' });
        }
        return ARC_GENESIS_TOKEN_ERC20_INTERFACE.encodeFunctionResult('balanceOf', [1000000000n]);
      }
      throw new Error(`Unexpected read-only Arc call selector: ${selector}`);
    }
  };
  let writeAttempts = 0;
  const readOnlyRpc = new Proxy(rpc, { get(target, property, receiver) {
    if (typeof property === 'string' && /^(send|broadcast|sign|relay|submit|estimateGas)/i.test(property)) {
      return async () => { writeAttempts += 1; throw new Error(`Arc write method forbidden in isolated test: ${property}`); };
    }
    return Reflect.get(target, property, receiver);
  } });
  return { rpc: readOnlyRpc, calls, logQueries,
    setLogs(value) { logs = value; },
    failNextBalanceReadAfterReceipt() { failBalanceReadAfterReceipt = true; },
    setReceipt(hash, value) { receipts.set(hash.toLowerCase(), value); },
    setTransaction(hash, value) { transactions.set(hash.toLowerCase(), value); },
    get writeAttempts() { return writeAttempts; } };
}

test('Genesis economy preserves simulated history, removes its active authority, and prepares only wallet-authorized Arc settlement', {
  skip: !enabled,
  timeout: 120_000
}, async (t) => {
  assertIsolatedDatabase(databaseUrl);
  const pool = new Pool({ connectionString: databaseUrl, max: 6 });
  let fixture;
  let reconciler;
  try {
    await pool.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='synterra_app')
      THEN CREATE ROLE synterra_app; END IF; END $$`);
    await applyWorldSchemaAndMigrations(pool, { rootDirectory: repoRoot });
    fixture = await seedWorld(pool);
    const before = await snapshotLegacyRecords(pool, fixture);
    const activation = await readGenesisCurrencyActivation(pool, fixture.worldId);
    assert.equal(activation.tokenId, fixture.tokenId);
    assert.equal(activation.issuerSelectionSource, 'creator_genesis_assignment');
    assert.equal(activation.creatorAllocationRaw, '0');

    const externalRecipientAddress = randomAddress();
    const externalDistribution = [{ recipientType: 'external', recipientId: null,
      recipientAddress: externalRecipientAddress, amount: '1000000000' }];
    const externalProposal = await createWorldTokenIssuanceIntent(pool, { worldId: fixture.worldId,
      agentId: fixture.founderId, specification: { name: 'Deferred External Design', symbol: 'DEXT',
        meaning: 'An issuer-authored distribution retained for later capability.',
        purpose: 'Preserve the issuer\'s original allocation intent.', rationale: 'External allocation is not yet executable.',
        decimals: 0, distribution: externalDistribution, reserveAmount: '0',
        unallocatedSupplyHandling: 'fully_distributed', ownershipModel: 'erc20_holder_owned',
        authorityModel: 'no_mint_no_burn' }, actionId: 'external-genesis-distribution-proposal',
      worldMinute: 20_000, decisionPath: 'world_engine' });
    assert.equal(externalProposal.intent.status, 'proposed');
    assert.equal(externalProposal.intent.issuer_agent_id, fixture.founderId);
    assert.equal(externalProposal.intent.issuer_selection_source, 'creator_genesis_assignment');
    const unsupportedConfirmation = await confirmWorldTokenIssuance(pool, { worldId: fixture.worldId,
      agentId: fixture.founderId, intentId: externalProposal.intent.id, decision: 'issue',
      actionId: 'external-genesis-distribution-confirmation', worldMinute: 20_001 });
    assert.equal(unsupportedConfirmation.deferred, true);
    assert.equal(unsupportedConfirmation.reason, 'UNSUPPORTED_DISTRIBUTION_RECIPIENT');
    assert.equal(unsupportedConfirmation.distributionPreserved, true);
    assert.equal(unsupportedConfirmation.intent.status, 'deferred');
    assert.deepEqual(unsupportedConfirmation.intent.distribution, externalDistribution,
      'an unsupported recipient is retained verbatim instead of being removed or reallocated');
    assert.equal(unsupportedConfirmation.intent.metadata.executionStatus, 'deferred_unsupported_distribution');
    assert.equal(unsupportedConfirmation.intent.metadata.unsupportedDistribution[0].reason,
      'generation_1_external_recipient_unsupported');
    assert.equal(Number((await pool.query(`SELECT count(*)::int AS count FROM arc_agent_tokens WHERE world_id=$1`,
      [fixture.worldId])).rows[0].count), 1, 'deferring the allocation does not create a token');
    assert.equal(arcNetworkConfig({ MAINNET_WRITE_GATE: 'true' }).writesEnabled, false,
      'an environment override cannot open the hard-closed Mainnet write gate');

    const legacyOutboxBefore = await pool.query(`SELECT count(*)::int AS count FROM arc_settlement_outbox WHERE world_id=$1`,
      [fixture.worldId]);
    const retiredSettlement = await enqueueArcAgentEconomicAction(pool, { worldId: fixture.worldId,
      worldActionId: 'post-genesis-legacy-action', fromAgentId: fixture.customerId, toAgentId: fixture.founderId,
      simulatedAmountUsdc: '12.50000000', worldMinute: 20_000 });
    assert.equal(retiredSettlement.skipped, true);
    assert.equal(retiredSettlement.reason, 'GENESIS_CURRENCY_ACTIVE');
    const legacyOutboxAfter = await pool.query(`SELECT count(*)::int AS count FROM arc_settlement_outbox WHERE world_id=$1`,
      [fixture.worldId]);
    assert.equal(legacyOutboxAfter.rows[0].count, legacyOutboxBefore.rows[0].count,
      'post-Genesis simulated-USDC events do not create legacy Arc settlement outbox rows');

    const businesses = await listWorldBusinesses(pool, { worldId: fixture.worldId });
    const business = businesses.find((row) => row.id === fixture.businessId);
    assert.ok(business);
    assert.equal(business.cashBalance, null);
    assert.equal(business.revenue, null);
    assert.equal(business.services[0].basePriceUsdc, null);
    assert.equal(business.services[0].tokenPriceRaw, null, 'legacy USDC quote is not converted to TOKEN');
    assert.equal(business.jobs[0].wageUsdc, null);
    assert.equal(business.jobs[0].wageRaw, null, 'legacy USDC wage is not converted to TOKEN');
    assert.equal(business.workers.length, 0, 'pre-Genesis USDC employment is not an active Token-wage job');
    assert.equal(business.historicalEmployment.length, 1);
    assert.equal(business.historicalEmployment[0].legacyWage, 'historical_only');
    assert.deepEqual(business.owners.map((owner) => ({ ownerId: owner.ownerId, share: owner.share })),
      [{ ownerId: fixture.founderId, share: '1' }],
    'pre-Genesis simulated business ownership remains historical and has no current governance/equity authority');
    assert.ok(business.owners.every((owner) => owner.investedUsdc === null));
    assert.equal(business.legacySimulatedEconomy, 'historical_only');
    assert.equal(await getEconomicAccount(pool, { worldId: fixture.worldId, accountType: 'resident', ownerId: fixture.founderId }), null,
      'historical simulated USDC accounts are not readable as current purchasing power after activation');

    const confirmedAgreementId = randomUUID();
    const pendingAgreementId = randomUUID();
    await pool.query(`INSERT INTO world_agreements(id,world_id,agreement_type,proposer_agent_id,counterparty_agent_id,
        terms,status,action_id,created_world_time,accepted_world_time,activated_world_time,completed_world_time,
        updated_world_time,metadata) VALUES
        ($1,$2,'investment',$3,$4,$5::jsonb,'completed','confirmed-genesis-investment',200,200,200,201,201,$6::jsonb),
        ($7,$2,'investment',$8,$4,$9::jsonb,'active','pending-genesis-investment',202,202,202,NULL,202,$10::jsonb)`,
    [confirmedAgreementId, fixture.worldId, fixture.employeeId, fixture.founderId,
      JSON.stringify({ businessId: fixture.businessId, tokenId: fixture.tokenId, amountRaw: '5000000', ownershipShare: 0.25 }),
      JSON.stringify({ execution: { settlementId: randomUUID(), settlementStatus: 'final',
        ownershipStatus: 'arc_confirmed_business_equity', transactionHash: TX_HASH, blockNumber: '101' } }),
      pendingAgreementId, fixture.customerId,
      JSON.stringify({ businessId: fixture.businessId, tokenId: fixture.tokenId, amountRaw: '1000000', ownershipShare: 0.1 }),
      JSON.stringify({ execution: { settlementId: randomUUID(), settlementStatus: 'prepared',
        ownershipStatus: 'pending_arc_confirmation' } })]);
    const employeeEquity = await readGenesisBusinessEquity(pool, { worldId: fixture.worldId,
      agentId: fixture.employeeId, tokenId: fixture.tokenId });
    const customerEquity = await readGenesisBusinessEquity(pool, { worldId: fixture.worldId,
      agentId: fixture.customerId, tokenId: fixture.tokenId });
    assert.equal(employeeEquity.investments.length, 1, 'only Arc-confirmed Genesis Token settlement activates business equity');
    assert.equal(employeeEquity.investments[0].transactionHash, TX_HASH);
    assert.equal(customerEquity.investments.length, 0, 'pending Token obligations do not create economic ownership');
    assert.equal(customerEquity.pendingObligations.length, 1);
    const equityBusinesses = await listWorldBusinesses(pool, { worldId: fixture.worldId });
    const equityBusiness = equityBusinesses.find((row) => row.id === fixture.businessId);
    assert.deepEqual(equityBusiness.owners.map((owner) => ({ ownerId: owner.ownerId, share: String(owner.share) })),
      [{ ownerId: fixture.founderId, share: '0.75' }, { ownerId: fixture.employeeId, share: '0.25' }]);
    assert.equal(equityBusiness.genesisPendingEquityObligations.length, 1);
    const cognitionContext = await loadWorldBusinessContext(pool, fixture.worldId, 20_000, []);
    assert.deepEqual(cognitionContext.ownership.map((owner) => ({ ownerId: owner.ownerId, share: String(owner.share) })),
      [{ ownerId: fixture.founderId, share: '0.75' }, { ownerId: fixture.employeeId, share: '0.25' }],
    'resident cognition receives only founder record and Arc-confirmed Token equity; legacy simulated investor shares are excluded');
    assert.equal(cognitionContext.employment[0].economicStatus, 'historical_only');
    assert.equal(cognitionContext.employment[0].wage_usdc, null);

    const repricingOptions = buildBusinessCandidates({ agentId: fixture.founderId, name: 'Founder',
      energy: 90, food: 90, skills: { research: 50 }, primaryGoal: 'BUILD_WEALTH',
      genesisTokenSpendableRaw: '1000000000', genesisTokenObservedAt: new Date() }, {
      genesisCurrencyActive: true,
      genesisCurrency: { tokenId: fixture.tokenId, symbol: 'GFT', decimals: 6,
        initialSupplyRaw: '1000000000000000' },
      worldMinutes: 20_000,
      businesses: [{ id: fixture.businessId, founder_agent_id: fixture.founderId, status: 'active' }],
      allBusinessServices: [{ id: fixture.serviceId, business_id: fixture.businessId, name: 'Research Brief', active: true,
        tokenPriceRaw: null, tokenPriceEffectiveWorldMinute: 0 }],
      jobs: [{ id: fixture.jobId, business_id: fixture.businessId, role: 'Research Associate', status: 'filled',
        requiredSkill: 'research', businessStatus: 'active', tokenWageRaw: null, tokenWageEffectiveWorldMinute: 0 }],
      employment: []
    });
    assert.ok(repricingOptions.some((option) => option.action === 'business_token_price'
      && option.businessId === fixture.businessId && option.serviceId === fixture.serviceId),
    'the owner has an autonomous explicit TOKEN repricing action');
    assert.ok(repricingOptions.some((option) => option.action === 'business_token_wage'
      && option.businessId === fixture.businessId && option.jobId === fixture.jobId),
    'the owner has an autonomous explicit TOKEN wage action');
    assert.ok(repricingOptions.every((option) => option.action !== 'business_price'),
      'post-Genesis choices do not route through simulated-USDC repricing');

    const employeeWageOptions = buildBusinessCandidates({ agentId: fixture.employeeId, name: 'Employee', energy: 90,
      food: 90, skills: { research: 50 }, primaryGoal: 'BUILD_WEALTH' }, {
      genesisCurrencyActive: true,
      genesisCurrency: { tokenId: fixture.tokenId, symbol: 'GFT', decimals: 6,
        initialSupplyRaw: '1000000000000000' },
      worldMinutes: 20_000,
      employment: [{ id: fixture.employmentId, agent_id: fixture.employeeId, status: 'active',
        wageTokenId: null, wageRaw: null, tokenWageTokenId: fixture.tokenId,
        tokenWageRaw: '5000000', businessName: 'Historical Quote Research Studio' }],
      businesses: [{ id: fixture.businessId, founder_agent_id: fixture.founderId, status: 'active' }],
      jobs: [{ id: fixture.reentryJobId, business_id: fixture.businessId, businessName: 'Historical Quote Research Studio',
        founderAgentId: fixture.founderId, status: 'open', businessStatus: 'active', requiredSkill: 'research',
        tokenWageTokenId: fixture.tokenId, tokenWageRaw: '1000000', businessSpendableRaw: '1000000000' }],
      applications: []
    });
    assert.ok(employeeWageOptions.some((option) => option.action === 'business_wage_accept'
      && option.employmentId === fixture.employmentId),
    'resident can autonomously accept a fresh owner-published Token wage for a historical employment relationship');
    assert.ok(employeeWageOptions.some((option) => option.action === 'business_apply'
      && option.jobId === fixture.reentryJobId),
    'historical active USDC employment does not suppress current Token job applications');

    await publishGenesisTokenJobWage(pool, { worldId: fixture.worldId, businessId: fixture.businessId,
      jobId: fixture.reentryJobId, agentId: fixture.founderId, wageRaw: '1000000',
      actionId: 'owner-token-reentry-wage', worldTime: 20_009 });
    const reentryApplication = await applyToWorldBusinessJob(pool, { worldId: fixture.worldId,
      jobId: fixture.reentryJobId, agentId: fixture.employeeId, actionId: 'employee-token-reentry-application',
      worldTime: 20_009 });
    assert.equal(reentryApplication.status, 'pending',
      'the application API accepts a separate current Token role while preserving the old employment row');
    const reentryHire = await decideWorldBusinessApplication(pool, { worldId: fixture.worldId,
      applicationId: reentryApplication.id, founderAgentId: fixture.founderId, decision: 'accept',
      actionId: 'owner-token-reentry-hire', worldTime: 20_010 });
    assert.equal(reentryHire.status, 'active',
      'the hiring decision treats historical simulated employment as non-authoritative');
    const reentryEmployment = await pool.query(`SELECT wage_usdc::text AS "legacyWageUsdc",
        wage_token_id AS "tokenId",wage_raw::text AS "wageRaw",status
      FROM world_business_employment WHERE world_id=$1 AND id=$2`, [fixture.worldId, reentryHire.id]);
    assert.deepEqual(reentryEmployment.rows[0], { legacyWageUsdc: null, tokenId: fixture.tokenId,
      wageRaw: '1000000', status: 'active' });
    await leaveWorldBusinessJob(pool, { worldId: fixture.worldId, employmentId: reentryHire.id,
      agentId: fixture.employeeId, actionId: 'employee-token-reentry-leave', worldTime: 20_010 });

    await assert.rejects(() => purchaseWorldBusinessService(pool, { worldId: fixture.worldId,
      serviceId: fixture.serviceId, customerAgentId: fixture.customerId, actionId: 'legacy-service-payment',
      worldTime: 20_001, maxPriceUsdc: '999.00' }), (error) => error.message === 'GENESIS_TOKEN_MAX_PRICE_INVALID');
    await assert.rejects(() => investInWorldBusiness(pool, { worldId: fixture.worldId,
      businessId: fixture.businessId, investorAgentId: fixture.founderId, amount: '20.00',
      actionId: 'legacy-investment', worldTime: 20_002 }), (error) => error.message === 'LEGACY_SIMULATED_ECONOMY_RETIRED');
    await assert.rejects(() => completeWorldBusinessShift(pool, { worldId: fixture.worldId,
      businessId: fixture.businessId, serviceId: fixture.serviceId, agentId: fixture.employeeId,
      employmentId: fixture.employmentId, actionId: 'legacy-wage-shift', worldTime: 20_003 }),
    (error) => error.message === 'BUSINESS_EMPLOYMENT_REQUIRES_EXPLICIT_TOKEN_WAGE_ACCEPTANCE');
    assert.equal((await pool.query(`SELECT count(*)::int AS count FROM world_genesis_token_business_orders WHERE world_id=$1`,
      [fixture.worldId])).rows[0].count, 0, 'legacy USDC cannot create a new Genesis Token service order');

    const servicePrice = await publishGenesisTokenServicePrice(pool, { worldId: fixture.worldId,
      businessId: fixture.businessId, serviceId: fixture.serviceId, agentId: fixture.founderId,
      priceRaw: '2500000', actionId: 'owner-token-service-price', worldTime: 20_010 });
    assert.equal(servicePrice.priceRaw, '2500000');
    const tokenWage = await publishGenesisTokenJobWage(pool, { worldId: fixture.worldId,
      businessId: fixture.businessId, jobId: fixture.jobId, agentId: fixture.founderId,
      wageRaw: '5000000', actionId: 'owner-token-job-wage', worldTime: 20_011 });
    assert.equal(tokenWage.wageRaw, '5000000');
    await acceptGenesisTokenEmploymentWage(pool, { worldId: fixture.worldId, employmentId: fixture.employmentId,
      agentId: fixture.employeeId, actionId: 'employee-accept-token-wage', worldTime: 20_012 });
    const employmentWage = await pool.query(`SELECT wage_usdc::text AS "legacyWageUsdc",
        wage_token_id AS "tokenId",wage_raw::text AS "wageRaw"
      FROM world_business_employment WHERE world_id=$1 AND id=$2`, [fixture.worldId, fixture.employmentId]);
    assert.equal(employmentWage.rows[0].legacyWageUsdc, '3.25000000');
    assert.equal(employmentWage.rows[0].tokenId, fixture.tokenId);
    assert.equal(employmentWage.rows[0].wageRaw, '5000000');
    const acceptedWageContext = await loadWorldBusinessContext(pool, fixture.worldId, 20_013, []);
    assert.equal(acceptedWageContext.employment[0].economicStatus, 'active_token_wage');
    assert.equal(acceptedWageContext.employment[0].wageTokenId, fixture.tokenId);
    assert.equal(acceptedWageContext.employment[0].wageRaw, '5000000');
    assert.equal(acceptedWageContext.employment[0].requiresTokenWageAcceptance, false);
    const workCandidates = buildBusinessCandidates({ agentId: fixture.employeeId, name: 'Employee', energy: 90,
      food: 90, skills: { research: 50 }, primaryGoal: 'BUILD_WEALTH', genesisTokenSpendableRaw: '0',
      genesisTokenObservedAt: new Date() }, acceptedWageContext);
    assert.ok(workCandidates.some((candidate) => candidate.action === 'business_work'
      && candidate.businessId === fixture.businessId && candidate.serviceId === fixture.serviceId
      && candidate.employmentId === fixture.employmentId),
    'an active employee with a current accepted Token wage can autonomously consider a funded work shift');
    const currentBusiness = (await listWorldBusinesses(pool, { worldId: fixture.worldId }))
      .find((row) => row.id === fixture.businessId);
    assert.equal(currentBusiness.workers.length, 1);
    assert.equal(currentBusiness.workers[0].economicStatus, 'active_token_wage');
    assert.equal(currentBusiness.historicalEmployment.length, 0);
    const shift = await completeWorldBusinessShift(pool, { worldId: fixture.worldId, businessId: fixture.businessId,
      serviceId: fixture.serviceId, agentId: fixture.employeeId, employmentId: fixture.employmentId,
      actionId: 'employee-token-shift', worldTime: 20_013 });
    assert.equal(shift.wageRaw, '5000000');
    assert.equal(shift.settlementStatus, 'prepared');
    assert.equal(shift.walletAuthorization, 'employer_agent_wallet');

    const order = await purchaseWorldBusinessService(pool, { worldId: fixture.worldId, serviceId: fixture.serviceId,
      customerAgentId: fixture.customerId, actionId: 'customer-token-service-order', worldTime: 20_014,
      maxPriceRaw: '3000000' });
    assert.equal(order.status, 'pending_settlement');
    assert.equal(order.amountRaw, '2500000');
    assert.equal(order.chainOwnershipAuthority, 'arc_confirmation');
    assert.ok(order.settlementId);
    const unsettled = await pool.query(`SELECT status,transaction_hash,block_number FROM arc_genesis_token_settlement_outbox
      WHERE world_id=$1 AND id=ANY($2::uuid[]) ORDER BY world_action_id`,
    [fixture.worldId, [shift.settlementId, order.settlementId]]);
    assert.equal(unsettled.rowCount, 2);
    assert.ok(unsettled.rows.every((row) => row.status === 'prepared' && row.transaction_hash === null && row.block_number === null),
      'an internal prepared obligation never claims chain-confirmed ownership');

    const snapshots = await readGenesisTokenWalletSnapshots(pool, { worldId: fixture.worldId });
    const scaWallet = snapshots.wallets.find((wallet) => wallet.ownerId === fixture.scaId);
    assert.equal(scaWallet.balanceRaw, '7000000', 'observed SCA holdings remain truthful chain assets');
    assert.equal(scaWallet.spendableRaw, '7000000', 'smart-wallet spendability is based on observed Arc balance and reservations');
    assert.equal(scaWallet.authorizationSupported, true);
    const scaSettlement = await createArcGenesisTokenSettlementIntent(pool, { worldId: fixture.worldId,
      tokenId: fixture.tokenId, fromAgentId: fixture.scaId, toAgentId: fixture.customerId,
      amountRaw: '1000000', actionId: 'sca-payer-settlement', actionFamily: 'test_payment',
      reason: 'The SCA payer authorizes this settlement through its own wallet.', worldMinute: 20_015 });
    assert.equal(scaSettlement.settlement.metadata.payerWalletAccountType, 'sca');
    const scaAuthorization = buildGenesisTokenSettlementWalletAuthorization(scaSettlement.settlement, {
      tokenAddress: TOKEN_ADDRESS, settlementContract: SETTLEMENT_ADDRESS, walletAccountType: 'sca',
      spendingPolicy: { perActionLimitRaw: '1000000', dailyLimitRaw: '3000000', actionFamilies: ['test_payment'] }
    });
    assert.equal(scaAuthorization.payerWalletAccountType, 'sca');
    assert.equal(scaAuthorization.transactionSenderMustEqualPayer, false,
      'outer transaction senders such as wallet relayers do not replace the SCA payer identity');
    assert.equal(scaAuthorization.settlementContractEnforcesPayerAsMsgSender, true);
    assert.ok(scaAuthorization.calls.every((call) => call.from.toLowerCase() === SCA_ADDRESS.toLowerCase()));
    const encodedSCAEvent = ARC_GENESIS_TOKEN_SETTLEMENT_INTERFACE.encodeEventLog('TokenSettlement', [
      genesisSettlementWorldId(fixture.worldId), TOKEN_ADDRESS,
      genesisSettlementActionHash(fixture.worldId, scaSettlement.settlement.world_action_id),
      SCA_ADDRESS, CUSTOMER_ADDRESS, 1000000n, id('test_payment'), scaSettlement.settlement.reason_hash, 20_015
    ]);
    const scaReceiptAudit = auditGenesisTokenSettlementReceipt({ ...scaSettlement.settlement,
      settlement_contract: SETTLEMENT_ADDRESS, token_address: TOKEN_ADDRESS, from_wallet_account_type: 'sca' }, {
      transactionHash: TX_HASH, status: 1, blockNumber: '0x66', logs: [{ address: SETTLEMENT_ADDRESS,
        topics: encodedSCAEvent.topics, data: encodedSCAEvent.data, logIndex: '0x0' }]
    }, { hash: TX_HASH, chainId: CHAIN_ID, from: randomAddress(), to: randomAddress(), data: '0x1234' });
    assert.equal(scaReceiptAudit.consistent, true,
      'the verified settlement contract event proves the SCA called settle even when its outer transaction is relayed');

    await assert.rejects(() => prepareGenesisTokenSettlementAuthorization(pool, { worldId: fixture.worldId,
      settlementId: order.settlementId, agentId: fixture.customerId, writesEnabled: false }),
    (error) => error.code === 'ARC_MAINNET_WRITE_GATE_CLOSED');
    await assert.rejects(() => recordGenesisTokenSettlementSubmission(pool, { worldId: fixture.worldId,
      settlementId: order.settlementId, agentId: fixture.customerId, transactionHash: TX_HASH,
      writesEnabled: false }), (error) => error.code === 'ARC_MAINNET_WRITE_GATE_CLOSED');

    const unsignedAuthorization = buildGenesisTokenSettlementWalletAuthorization({
      world_id: fixture.worldId, world_action_id: 'unsigned-wallet-authorization',
      from_address: CUSTOMER_ADDRESS, to_address: OWNER_ADDRESS, settlement_contract: SETTLEMENT_ADDRESS,
      amount_raw: '2500000', reason_hash: `0x${'77'.repeat(32)}`, action_family: 'business_service_payment',
      created_world_minute: 20_014
    }, { tokenAddress: TOKEN_ADDRESS, settlementContract: SETTLEMENT_ADDRESS,
      spendingPolicy: { perActionLimitRaw: '3000000', dailyLimitRaw: '10000000',
        actionFamilies: ['business_service_payment'] } });
    assert.equal(unsignedAuthorization.authorization, 'payer_agent_wallet_signature');
    assert.equal(unsignedAuthorization.custody, 'non_custodial');
    assert.equal(unsignedAuthorization.settlementContractNeverCustodiesToken, true);
    assert.equal(unsignedAuthorization.calls.length, 3);
    assert.equal(unsignedAuthorization.calls[0].purpose, 'set_agent_chosen_spending_policy');
    assert.equal(unsignedAuthorization.calls[1].purpose, 'approve_exact_token_allowance');
    assert.equal(unsignedAuthorization.calls[2].purpose, 'settle_directly_from_agent_wallet');
    assert.equal(unsignedAuthorization.spendingPolicy.perActionLimitRaw, '3000000');
    assert.equal(unsignedAuthorization.spendingPolicy.dailyLimitRaw, '10000000');
    assert.equal(unsignedAuthorization.calls.every((call) => call.from.toLowerCase() === CUSTOMER_ADDRESS.toLowerCase()), true,
      'the payer Agent wallet is the explicit sender for every authorization call');
    assert.throws(() => buildGenesisTokenSettlementWalletAuthorization({
      world_id: fixture.worldId, world_action_id: 'missing-policy', from_address: CUSTOMER_ADDRESS,
      to_address: OWNER_ADDRESS, settlement_contract: SETTLEMENT_ADDRESS, amount_raw: '2500000',
      reason_hash: `0x${'77'.repeat(32)}`, action_family: 'business_service_payment', created_world_minute: 20_014
    }, { tokenAddress: TOKEN_ADDRESS, settlementContract: SETTLEMENT_ADDRESS }),
    (error) => error.code === 'ARC_GENESIS_TOKEN_EXPLICIT_SPENDING_POLICY_REQUIRED');
    assert.throws(() => buildGenesisTokenSettlementWalletAuthorization({
      world_id: fixture.worldId, world_action_id: 'underfunded-policy', from_address: CUSTOMER_ADDRESS,
      to_address: OWNER_ADDRESS, settlement_contract: SETTLEMENT_ADDRESS, amount_raw: '2500000',
      reason_hash: `0x${'77'.repeat(32)}`, action_family: 'business_service_payment', created_world_minute: 20_014
    }, { tokenAddress: TOKEN_ADDRESS, settlementContract: SETTLEMENT_ADDRESS,
      spendingPolicy: { perActionLimitRaw: '2000000', dailyLimitRaw: '10000000',
        actionFamilies: ['business_service_payment'] } }),
    (error) => error.code === 'ARC_GENESIS_TOKEN_POLICY_DOES_NOT_COVER_SETTLEMENT');

    const fakeArc = fakeReadOnlyArcRpc({ worldId: fixture.worldId });
    await recordGenesisTokenSettlementSubmission(pool, { worldId: fixture.worldId,
      settlementId: order.settlementId, agentId: fixture.customerId, submissionUnknown: true,
      latestBlock: 250, writesEnabled: true });
    const recoveryRow = (await pool.query(`SELECT outbox.*,token.token_address,
        payer_wallet.account_type AS from_wallet_account_type
      FROM arc_genesis_token_settlement_outbox outbox
      JOIN arc_agent_tokens token ON token.world_id=outbox.world_id AND token.id=outbox.token_id
      LEFT JOIN arc_agent_wallets payer_wallet ON payer_wallet.world_id=outbox.world_id
        AND payer_wallet.agent_id=outbox.from_agent_id AND payer_wallet.chain_id=outbox.chain_id
        AND lower(payer_wallet.address)=lower(outbox.from_address)
      WHERE outbox.world_id=$1 AND outbox.id=$2`, [fixture.worldId, order.settlementId])).rows[0];
    const recoveryBlock = Number(recoveryRow.submission_start_block) + 1;
    assert.ok(recoveryBlock <= 256, 'the recovered log is within the isolated RPC latest block');
    const recoveryEvent = ARC_GENESIS_TOKEN_SETTLEMENT_INTERFACE.encodeEventLog('TokenSettlement', [
      genesisSettlementWorldId(recoveryRow.world_id), recoveryRow.token_address,
      genesisSettlementActionHash(recoveryRow.world_id, recoveryRow.world_action_id),
      recoveryRow.from_address, recoveryRow.to_address, BigInt(recoveryRow.amount_raw),
      id(recoveryRow.action_family), recoveryRow.reason_hash, BigInt(recoveryRow.created_world_minute)
    ]);
    const matchingLog = { address: recoveryRow.settlement_contract, topics: recoveryEvent.topics,
      data: recoveryEvent.data, blockNumber: `0x${recoveryBlock.toString(16)}`,
      transactionHash: TX_HASH, logIndex: '0x0' };
    fakeArc.setLogs([matchingLog]);
    reconciler = new ArcGenesisTokenSettlementReconciler({ pool, rpcClient: fakeArc.rpc, intervalMs: 60_000 });
    await reconciler.start({ worldId: fixture.worldId });
    assert.equal(reconciler.getStatus().mode, 'read_only_reconciliation');
    assert.equal(fakeArc.writeAttempts, 0, 'reconciliation has no Arc write method available or called');
    assert.ok(fakeArc.calls.includes('eth_call'));
    const pendingRecovery = reconciler.getStatus().lastResult.results.find((result) => result.id === order.settlementId);
    assert.equal(pendingRecovery.reason, 'matching_log_audit_pending',
      'a matching event without readable receipt and transaction remains pending');
    const recoveryBlockHex = `0x${recoveryBlock.toString(16)}`;
    assert.equal(fakeArc.logQueries[0].fromBlock, recoveryBlockHex);
    assert.equal(fakeArc.logQueries[0].toBlock, '0x100');
    const heldCursor = await pool.query(`SELECT reconciliation_log_cursor_block::text AS cursor,status,transaction_hash
      FROM arc_genesis_token_settlement_outbox WHERE world_id=$1 AND id=$2`, [fixture.worldId, order.settlementId]);
    assert.deepEqual(heldCursor.rows[0], { cursor: String(recoveryBlock - 1),
      status: 'submission_unknown', transaction_hash: null },
      'the persisted cursor stops immediately before the matching event block');

    const recoveryTransaction = { hash: TX_HASH, chainId: CHAIN_ID, from: recoveryRow.from_address,
      to: recoveryRow.settlement_contract, data: buildGenesisTokenSettlementCall(recoveryRow) };
    const recoveryReceipt = { transactionHash: TX_HASH, status: 1,
      blockNumber: `0x${recoveryBlock.toString(16)}`, logs: [{ address: matchingLog.address,
        topics: matchingLog.topics, data: matchingLog.data, logIndex: matchingLog.logIndex }] };
    fakeArc.setTransaction(TX_HASH, recoveryTransaction);
    fakeArc.setReceipt(TX_HASH, recoveryReceipt);
    fakeArc.failNextBalanceReadAfterReceipt();
    const auditButUnpersisted = await reconciler.reconcilePending();
    const transientSaveFailure = auditButUnpersisted.results.find((result) => result.id === order.settlementId);
    assert.equal(transientSaveFailure.finding, 'ARC_TEMPORARY_BALANCE_READ',
      'a transient balance read failure cannot be mistaken for a reconciled settlement');
    assert.equal(fakeArc.logQueries[1].fromBlock, recoveryBlockHex,
      'the block remains the retry start until the audited settlement is durably reconciled');
    const cursorAfterSaveFailure = await pool.query(`SELECT reconciliation_log_cursor_block::text AS cursor,status,
        transaction_hash FROM arc_genesis_token_settlement_outbox WHERE world_id=$1 AND id=$2`,
    [fixture.worldId, order.settlementId]);
    assert.deepEqual(cursorAfterSaveFailure.rows[0], { cursor: String(recoveryBlock - 1),
      status: 'submission_unknown', transaction_hash: null });

    const recovered = await reconciler.reconcilePending();
    const recoveredResult = recovered.results.find((result) => result.id === order.settlementId);
    assert.equal(recoveredResult.status, 'final', 'the retry reconciles the existing on-chain submission');
    assert.equal(fakeArc.logQueries[2].fromBlock, recoveryBlockHex,
      'the successful retry still starts at the matching event block');
    const reconciledRow = await pool.query(`SELECT status,transaction_hash,block_number::text AS block_number,
        reconciliation_log_cursor_block::text AS cursor
      FROM arc_genesis_token_settlement_outbox WHERE world_id=$1 AND id=$2`, [fixture.worldId, order.settlementId]);
    assert.deepEqual(reconciledRow.rows[0], { status: 'final', transaction_hash: TX_HASH,
      block_number: String(recoveryBlock), cursor: '256' });
    const reconciledOrder = await pool.query(`SELECT status FROM world_genesis_token_business_orders
      WHERE world_id=$1 AND settlement_outbox_id=$2`, [fixture.worldId, order.settlementId]);
    assert.deepEqual(reconciledOrder.rows, [{ status: 'fulfilled' }]);
    const settlementHistory = await pool.query(`SELECT count(*)::int AS count FROM world_history
      WHERE world_id=$1 AND event_key=$2`, [fixture.worldId, `genesis-service-settlement:${order.settlementId}`]);
    assert.equal(settlementHistory.rows[0].count, 1,
      'the same settlement produces one economic history event');

    const stateBeforeRepeatedReconciliation = { outbox: reconciledRow.rows[0], order: reconciledOrder.rows[0],
      historyCount: settlementHistory.rows[0].count };
    const repeatedReconciliation = await reconciler.reconcilePending();
    assert.deepEqual(repeatedReconciliation.results, [], 'a terminal settlement is not applied a second time');
    assert.equal(fakeArc.logQueries.length, 3, 'the terminal settlement is not rescanned after reconciliation');
    const finalOutbox = await pool.query(`SELECT status,transaction_hash,block_number::text AS block_number,
        reconciliation_log_cursor_block::text AS cursor
      FROM arc_genesis_token_settlement_outbox WHERE world_id=$1 AND id=$2`, [fixture.worldId, order.settlementId]);
    const finalOrder = await pool.query(`SELECT status FROM world_genesis_token_business_orders
      WHERE world_id=$1 AND settlement_outbox_id=$2`, [fixture.worldId, order.settlementId]);
    const finalHistory = await pool.query(`SELECT count(*)::int AS count FROM world_history
      WHERE world_id=$1 AND event_key=$2`, [fixture.worldId, `genesis-service-settlement:${order.settlementId}`]);
    assert.deepEqual({ outbox: finalOutbox.rows[0], order: finalOrder.rows[0],
      historyCount: finalHistory.rows[0].count }, stateBeforeRepeatedReconciliation,
    'repeated reconciliation leaves the confirmed settlement and its single economic record unchanged');
    assert.equal(fakeArc.writeAttempts, 0, 'reconciliation retries never rebroadcast the transaction');
    await reconciler.stop();
    assert.equal(fakeArc.writeAttempts, 0);
    const stillPrepared = await pool.query(`SELECT count(*)::int AS count FROM arc_genesis_token_settlement_outbox
      WHERE world_id=$1 AND status='prepared' AND transaction_hash IS NULL`, [fixture.worldId]);
    assert.equal(stillPrepared.rows[0].count, 2);

    const repriced = await listWorldBusinesses(pool, { worldId: fixture.worldId });
    const repricedBusiness = repriced.find((row) => row.id === fixture.businessId);
    assert.equal(repricedBusiness.services[0].basePriceUsdc, null);
    assert.equal(repricedBusiness.services[0].tokenPriceRaw, '2500000');
    assert.equal(repricedBusiness.jobs[0].wageUsdc, null);
    assert.equal(repricedBusiness.jobs[0].wageRaw, '5000000');
    const activeAssets = await readActiveGenesisTokenAssets(pool, { worldId: fixture.worldId, ownerAgentId: fixture.founderId });
    assert.equal(activeAssets.length, 1);
    assert.equal(activeAssets[0].tokenAddress, TOKEN_ADDRESS);
    assert.equal(activeAssets[0].balanceRaw, '1000000000');
    await publishGenesisTokenJobWage(pool, { worldId: fixture.worldId, businessId: fixture.businessId,
      jobId: fixture.jobId, agentId: fixture.founderId, wageRaw: '6000000',
      actionId: 'owner-token-job-wage-revision', worldTime: 20_020 });
    const revisedWageContext = await loadWorldBusinessContext(pool, fixture.worldId, 20_020, []);
    const revisedWageOptions = buildBusinessCandidates({ agentId: fixture.employeeId, name: 'Employee', energy: 90,
      food: 90, skills: { research: 50 }, primaryGoal: 'BUILD_WEALTH' }, revisedWageContext);
    assert.ok(revisedWageOptions.some((option) => option.action === 'business_wage_accept'
      && option.employmentId === fixture.employmentId),
    'a resident may accept a later explicit owner repricing even when an earlier Token wage was accepted');
    await acceptGenesisTokenEmploymentWage(pool, { worldId: fixture.worldId, employmentId: fixture.employmentId,
      agentId: fixture.employeeId, actionId: 'employee-accept-token-wage-revision', worldTime: 20_021 });
    const updatedWorker = (await listWorldBusinesses(pool, { worldId: fixture.worldId }))
      .find((row) => row.id === fixture.businessId).workers[0];
    assert.equal(updatedWorker.wageRaw, '6000000');
    assert.equal(updatedWorker.requiresTokenWageAcceptance, false);
    assert.deepEqual(await snapshotLegacyRecords(pool, fixture), before,
      'Genesis activation and post-Genesis activity leave all historical simulated assets and USDC quotes unchanged');
  } finally {
    if (reconciler) await reconciler.stop();
    try {
      if (fixture) {
        await pool.query('DELETE FROM world_genesis_token_business_orders WHERE world_id=$1', [fixture.worldId]);
        await pool.query('DELETE FROM arc_genesis_token_settlement_contracts WHERE world_id=$1', [fixture.worldId]);
        await pool.query('DELETE FROM arc_genesis_token_settlement_outbox WHERE world_id=$1', [fixture.worldId]);
        await pool.query('DELETE FROM world_genesis_token_balance_snapshots WHERE world_id=$1', [fixture.worldId]);
        await pool.query('DELETE FROM world_business_service_token_terms WHERE world_id=$1', [fixture.worldId]);
        await pool.query('DELETE FROM world_business_job_token_terms WHERE world_id=$1', [fixture.worldId]);
        await pool.query('DELETE FROM world_business_employment WHERE world_id=$1', [fixture.worldId]);
        await pool.query('DELETE FROM world_genesis_currency_activations WHERE world_id=$1', [fixture.worldId]);
        await pool.query('DELETE FROM arc_currency_genesis_requirements WHERE world_id=$1', [fixture.worldId]);
        await pool.query('DELETE FROM arc_agent_tokens WHERE world_id=$1', [fixture.worldId]);
        await pool.query('DELETE FROM arc_token_issuance_intents WHERE world_id=$1', [fixture.worldId]);
        await pool.query('DELETE FROM worlds WHERE id=$1', [fixture.worldId]);
      }
    } finally { await pool.end(); }
  }
});

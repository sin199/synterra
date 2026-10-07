import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Interface, keccak256 } from 'ethers';
import { Pool } from 'pg';
import { foundWorldBusiness } from '../src/world-businesses.js';
import { startWorldEngine } from '../src/world-engine.js';
import { applyWorldSchemaAndMigrations } from '../src/database-migrations.js';
import { prepareArcCapabilityProvenance } from '../src/arc/provenance.js';
import { prepareArcWorldCheckpoint } from '../src/arc/checkpoints.js';
import { indexTrackedUsdcTransfers } from '../src/arc/indexer.js';
import { ARC_MAINNET_CHAIN_ID, ARC_MAINNET_USDC_ADDRESS } from '../src/arc/config.js';
import { ARC_SETTLEMENT_POLICY_INTERFACE, enqueueArcAgentEconomicAction } from '../src/arc/agent-economic-action.js';
import { ArcReadOnlyObserver } from '../src/arc/observer.js';
import { ArcSettlementOutboxWorker } from '../src/arc/settlement-worker.js';
import { DeterministicFakeArcSigner, createIsolatedArcMainnetConfig } from './helpers/arc-mainnet-fakes.js';
import { ARC_SETTLEMENT_INTERFACE, toArcBytes16Uuid } from '../src/arc/settlement.js';

const databaseUrl = process.env.SYNTERRA_TEST_DATABASE_URL;
const enabled = process.env.SYNTERRA_TEST_ISOLATED === '1' && Boolean(databaseUrl);
const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CONTRACT = '0x1111111111111111111111111111111111111111';
const PAYER = '0x2222222222222222222222222222222222222222';
const RECIPIENT = '0x3333333333333333333333333333333333333333';
const HASH = `0x${'ab'.repeat(32)}`;
const SYSTEM_EMITTER = '0xffffFFFfFFffffffffffffffFfFFFfffFFFfFFfE';
const RUNTIME_CODE = '0x6001600055';
const RUNTIME_CODE_HASH = keccak256(RUNTIME_CODE);
const IDENTITY_INTERFACE = new Interface([
  'function worldId() view returns (bytes16)',
  'function usdc() view returns (address)'
]);
const TOKEN_INTERFACE = new Interface([
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function decimals() view returns (uint8)'
]);

function assertIsolatedDatabase(connectionString) {
  const parsed = new URL(connectionString);
  assert.ok(['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname), 'Arc integration requires loopback PostgreSQL');
  assert.notEqual(parsed.port, '5432', 'Arc integration must not use the formal/default PostgreSQL port');
  assert.ok(decodeURIComponent(parsed.pathname.slice(1)).endsWith('_test'), 'Arc integration requires a *_test database');
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

function fakeMainnetRpc({ worldId, config }) {
  const calls = [];
  const rpc = {
    config,
    calls,
    async getChainId() { return ARC_MAINNET_CHAIN_ID; },
    async getBlockNumber() { return '0x1234'; },
    async getBlock() { return { number: '0x1234', baseFeePerGas: '0x4a817c800', transactions: [] }; },
    async getCode(address) { return address.toLowerCase() === CONTRACT.toLowerCase() ? RUNTIME_CODE : '0x6001'; },
    async getBalance() { return '0x3635c9adc5dea00000'; },
    async getTransactionCount() { return '0x0'; },
    async estimateGas() { return '0x5208'; },
    async maxPriorityFeePerGas() { return '0x0'; },
    async getTransactionReceipt() { return null; },
    async getLogs() { return []; },
    async health() { return { configured: true, chainId: ARC_MAINNET_CHAIN_ID,
      expectedChainId: ARC_MAINNET_CHAIN_ID, rpcHealthy: true, latestBlock: 0x1234,
      provider: 'isolated-deterministic-mainnet-fixture', latencyMs: 1, error: null }; },
    async call(transaction) {
      const selector = String(transaction.data || '').slice(0, 10).toLowerCase();
      calls.push(selector);
      if (transaction.to.toLowerCase() === ARC_MAINNET_USDC_ADDRESS.toLowerCase()) {
        if (selector === TOKEN_INTERFACE.getFunction('decimals').selector.toLowerCase()) {
          return TOKEN_INTERFACE.encodeFunctionResult('decimals', [6]);
        }
        if (selector === TOKEN_INTERFACE.getFunction('balanceOf').selector.toLowerCase()) {
          return TOKEN_INTERFACE.encodeFunctionResult('balanceOf', [1_000_000_000n]);
        }
        if (selector === TOKEN_INTERFACE.getFunction('allowance').selector.toLowerCase()) {
          return TOKEN_INTERFACE.encodeFunctionResult('allowance', [1_000_000_000n]);
        }
      }
      if (selector === IDENTITY_INTERFACE.getFunction('worldId').selector.toLowerCase()) {
        return IDENTITY_INTERFACE.encodeFunctionResult('worldId', [toArcBytes16Uuid(worldId)]);
      }
      if (selector === IDENTITY_INTERFACE.getFunction('usdc').selector.toLowerCase()) {
        return IDENTITY_INTERFACE.encodeFunctionResult('usdc', [ARC_MAINNET_USDC_ADDRESS]);
      }
      if (selector === ARC_SETTLEMENT_POLICY_INTERFACE.getFunction('spendingPolicies').selector.toLowerCase()) {
        return ARC_SETTLEMENT_POLICY_INTERFACE.encodeFunctionResult('spendingPolicies',
          [100_000_000n, 500_000_000n, 0n, 0, true, false]);
      }
      if (selector === ARC_SETTLEMENT_POLICY_INTERFACE.getFunction('allowedActionFamilies').selector.toLowerCase()) {
        return ARC_SETTLEMENT_POLICY_INTERFACE.encodeFunctionResult('allowedActionFamilies', [true]);
      }
      if (selector === ARC_SETTLEMENT_POLICY_INTERFACE.getFunction('completedActions').selector.toLowerCase()) {
        return ARC_SETTLEMENT_POLICY_INTERFACE.encodeFunctionResult('completedActions', [false]);
      }
      throw new Error(`Unexpected isolated Arc eth_call selector: ${selector}`);
    }
  };
  return rpc;
}

test('Arc Mainnet Agent action reaches persistent outbox, policy evaluation, and fake signer on isolated PostgreSQL', {
  skip: !enabled,
  timeout: 120_000
}, async () => {
  assertIsolatedDatabase(databaseUrl);
  const pool = new Pool({ connectionString: databaseUrl, max: 4 });
  const worldId = randomUUID();
  const payerId = randomUUID();
  const recipientId = randomUUID();
  const rootCapabilityId = randomUUID();
  const childCapabilityId = randomUUID();
  const txHash = HASH;
  const nowMs = Date.now();
  let engine = null;
  let worker = null;
  try {
    await applyWorldSchemaAndMigrations(pool, { rootDirectory: repoRoot });
    await pool.query(`INSERT INTO agents(id,name,public_key) VALUES
      ($1,'Arc Mainnet Test Resident A',$2),($3,'Arc Mainnet Test Resident B',$4)`,
    [payerId, `arc-mainnet-test-${payerId}`, recipientId, `arc-mainnet-test-${recipientId}`]);
    await pool.query(`INSERT INTO worlds(id,owner_agent_id,name,chain_id)
      VALUES($1,$2,'Arc Mainnet isolated integration world',$3)`, [worldId, payerId, ARC_MAINNET_CHAIN_ID]);
    await pool.query(`INSERT INTO world_members(world_id,agent_id,role,location)
      VALUES($1,$2,'owner','town-square'),($1,$3,'resident','town-square')`, [worldId, payerId, recipientId]);
    await pool.query(`INSERT INTO world_runtime_state(world_id,tick_count,world_minutes,last_tick_at,typesafe_next_at)
      VALUES($1,0,3000,$2,$2)`, [worldId, new Date(nowMs - 2_000)]);
    await pool.query(`INSERT INTO world_epochs(world_id,epoch_code,name,status,started_world_minute,description)
      VALUES($1,'V7','V7 isolated Arc integration epoch','active',1000,'Mainnet-only fake-provider integration')`, [worldId]);
    await pool.query(`INSERT INTO world_capabilities(id,world_id,capability_key,category,name,description,status,
        version,parent_capability_id,creator_type,creator_agent_id,specification,created_world_minute,adopted_world_minute)
      VALUES($1,$3,'arc-mainnet-test-root','coordination','Arc root capability','Developer seeded test capability','active',1,NULL,
        'system',NULL,'{"steps":["observe"]}'::jsonb,100,100),
        ($2,$3,'arc-mainnet-test-child','coordination','Arc child capability','Resident created test capability','active',1,$1,
        'resident',$4,'{"steps":["observe","share"]}'::jsonb,200,250)`,
    [rootCapabilityId, childCapabilityId, worldId, payerId]);
    await pool.query(`INSERT INTO world_agent_states(world_id,agent_id,goal,risk_tolerance,next_decision_at)
      VALUES($1,$2,'balanced',0.5,$3),($1,$4,'balanced',0.5,$3)`, [worldId, payerId, new Date(nowMs + 86_400_000), recipientId]);

    const config = createIsolatedArcMainnetConfig({ ARC_SETTLEMENT_RUNTIME_CODE_HASH: RUNTIME_CODE_HASH });
    const rpcClient = fakeMainnetRpc({ worldId, config });

    engine = await startWorldEngine(pool, { worldId, nowProvider: () => nowMs, schedule: false,
      onAutonomousBusinessAction: enqueueArcAgentEconomicAction, emergencySink: { write() {} } });
    assert.equal(engine.running, true);
    await pool.query(`UPDATE world_agent_states SET next_decision_at=$3 WHERE world_id=$1 AND agent_id=ANY($2::uuid[])`,
      [worldId, [payerId, recipientId], new Date(nowMs + 86_400_000)]);

    const business = await inTransaction(pool, (client) => foundWorldBusiness(client, { worldId, agentId: recipientId,
      actionId: 'arc-mainnet-business-seed', worldTime: 3000,
      proposal: { name: 'Arc Research Studio', businessType: 'research', purpose: 'Offer a research service in the isolated integration world.',
        serviceType: 'research_service', serviceName: 'Research Notes',
        serviceDescription: 'A deterministic research service for the isolated Arc integration world.', capitalUsdc: '250.00000000' } }));

    await pool.query(`UPDATE world_agent_states SET status='performing',planned_action='business_work',
        planned_context=$3::jsonb,action_started_at=$4,action_ends_at=$5,next_decision_at=$6
      WHERE world_id=$1 AND agent_id=$2`, [worldId, recipientId,
      JSON.stringify({ businessId: business.id, serviceId: business.serviceId }),
      new Date(nowMs - 30_000), new Date(nowMs - 1), new Date(nowMs + 86_400_000)]);
    await engine.tickOnce();
    const production = await pool.query(`SELECT data FROM world_events
      WHERE world_id=$1 AND actor_id=$2 AND event_type='world.action_completed'
        AND data->>'initiativeAction'='business_work' ORDER BY id DESC LIMIT 1`, [worldId, recipientId]);
    assert.equal(production.rowCount, 1, 'the business founder autonomously produced service stock through the World Engine');
    assert.equal(production.rows[0].data.abandoned, undefined);

    await pool.query(`UPDATE world_agent_states SET status='performing',planned_action='business_service',
        planned_context=$3::jsonb,action_started_at=$4,action_ends_at=$5,next_decision_at=$6
      WHERE world_id=$1 AND agent_id=$2`, [worldId, payerId,
      JSON.stringify({ serviceId: business.serviceId, maxPriceUsdc: '500.00000000' }),
      new Date(nowMs - 30_000), new Date(nowMs - 1), new Date(nowMs + 86_400_000)]);
    await engine.tickOnce();

    const actionResult = await pool.query(`SELECT id,data FROM world_events
      WHERE world_id=$1 AND actor_id=$2 AND event_type='world.action_completed'
        AND data->>'initiativeAction'='business_service' ORDER BY id DESC LIMIT 1`, [worldId, payerId]);
    assert.equal(actionResult.rowCount, 1, 'the World Engine completed the resident-selected service action');
    const outboxBeforePolicy = await pool.query(`SELECT world_action_id,world_event_id,chain_id,status,
        from_agent_id,to_agent_id,action_family,simulated_amount_usdc,created_world_minute,metadata
      FROM arc_settlement_outbox WHERE world_id=$1`, [worldId]);
    assert.equal(outboxBeforePolicy.rowCount, 1, 'the autonomous action wrote a persistent outbox row');
    assert.equal(Number(outboxBeforePolicy.rows[0].chain_id), ARC_MAINNET_CHAIN_ID);
    assert.equal(outboxBeforePolicy.rows[0].status, 'policy_pending');
    assert.equal(outboxBeforePolicy.rows[0].from_agent_id, payerId);
    assert.equal(outboxBeforePolicy.rows[0].to_agent_id, recipientId);
    assert.equal(outboxBeforePolicy.rows[0].action_family, 'resident_service_purchase');
    assert.equal(String(outboxBeforePolicy.rows[0].world_event_id), String(actionResult.rows[0].id));
    const replayedOutbox = await inTransaction(pool, (client) => enqueueArcAgentEconomicAction(client, {
      worldId, worldActionId: outboxBeforePolicy.rows[0].world_action_id,
      worldEventId: actionResult.rows[0].id, fromAgentId: payerId, toAgentId: recipientId,
      simulatedAmountUsdc: String(outboxBeforePolicy.rows[0].simulated_amount_usdc),
      worldMinute: Number(outboxBeforePolicy.rows[0].created_world_minute),
      orderId: outboxBeforePolicy.rows[0].metadata.orderId,
      businessId: outboxBeforePolicy.rows[0].metadata.businessId
    }));
    assert.equal(replayedOutbox.created, false, 'replaying the same completed Agent action does not duplicate its settlement intent');
    assert.equal(String((await pool.query(`SELECT count(*)::int AS count FROM arc_settlement_outbox WHERE world_id=$1`,
      [worldId])).rows[0].count), '1');

    await pool.query(`INSERT INTO arc_agent_wallets(world_id,agent_id,chain_id,address,provider,account_type,status)
      VALUES($1,$2,$3,$4,'external_kms','eoa','active'),($1,$5,$3,$6,'external_kms','eoa','active')`,
    [worldId, payerId, ARC_MAINNET_CHAIN_ID, PAYER, recipientId, RECIPIENT]);
    await pool.query(`INSERT INTO arc_spending_policies(world_id,agent_id,chain_id,token_address,
        per_action_limit_base_units,daily_limit_base_units,settlement_basis_points,allowed_action_families,
        allowed_contracts,emergency_paused,policy_version)
      VALUES($1,$2,$3,$4,100000000,500000000,10000,ARRAY['resident_service_purchase'],ARRAY[$5],false,1)`,
    [worldId, payerId, ARC_MAINNET_CHAIN_ID, ARC_MAINNET_USDC_ADDRESS, CONTRACT]);

    const submitted = [];
    const signer = new DeterministicFakeArcSigner({ config,
      addresses: { [payerId]: PAYER, [recipientId]: RECIPIENT }, transactionHash: txHash,
      submitted });
    worker = new ArcSettlementOutboxWorker({ pool, config,
      env: { ARC_SETTLEMENT_CONTRACT_ADDRESS: CONTRACT }, signer, rpcClient,
      isOwner: () => true, intervalMs: 60_000 });
    await worker.start();
    const workerStatus = worker.getStatus();
    assert.equal(workerStatus.running, true);
    assert.ok(workerStatus.lastResult, `the outbox worker completed its startup pass: ${JSON.stringify(workerStatus)}`);
    assert.equal(workerStatus.lastResult.policyProcessed, true);
    assert.equal(workerStatus.lastResult.status, 'submitted');
    assert.equal(submitted.length, 1, 'only the deterministic fake signer receives the production-built transaction');
    assert.equal(submitted[0].chainId, ARC_MAINNET_CHAIN_ID);
    assert.equal(submitted[0].to, CONTRACT);
    assert.ok(rpcClient.calls.includes(ARC_SETTLEMENT_POLICY_INTERFACE.getFunction('spendingPolicies').selector.toLowerCase()),
      'the worker read and evaluated the on-chain spending policy');
    const outboxAfterPolicy = await pool.query(`SELECT status,transaction_hash,amount_base_units,policy_reason
      FROM arc_settlement_outbox WHERE world_id=$1`, [worldId]);
    assert.equal(outboxAfterPolicy.rows[0].status, 'submitted');
    assert.equal(outboxAfterPolicy.rows[0].transaction_hash, txHash);
    assert.ok(BigInt(outboxAfterPolicy.rows[0].amount_base_units) > 0n);
    assert.equal(outboxAfterPolicy.rows[0].policy_reason, 'ONCHAIN_POLICY_APPROVED');

    const checkpointClient = await pool.connect();
    try {
      const checkpoint = await prepareArcWorldCheckpoint(checkpointClient, { worldId, chainId: ARC_MAINNET_CHAIN_ID });
      const replay = await prepareArcWorldCheckpoint(checkpointClient, { worldId, chainId: ARC_MAINNET_CHAIN_ID });
      assert.equal(checkpoint.due, true);
      assert.equal(checkpoint.checkpoint.version, '1');
      assert.equal(replay.due, false, 'a world minute with an existing checkpoint is not checkpointed twice');
      assert.equal(replay.reason, 'world_minute_not_advanced');
      assert.equal(Number((await pool.query(`SELECT count(*)::int AS count FROM arc_world_checkpoints
        WHERE world_id=$1 AND chain_id=$2`, [worldId, ARC_MAINNET_CHAIN_ID])).rows[0].count), 1);
      const capability = await prepareArcCapabilityProvenance(checkpointClient, {
        worldId, capabilityId: childCapabilityId, chainId: ARC_MAINNET_CHAIN_ID
      });
      const capabilityReplay = await prepareArcCapabilityProvenance(checkpointClient, {
        worldId, capabilityId: childCapabilityId, chainId: ARC_MAINNET_CHAIN_ID
      });
      assert.equal(capability.created, true);
      assert.equal(capabilityReplay.created, false);
      assert.equal(capability.provenance.creator_type, 'resident');
      assert.equal(capability.provenance.parent_capability_id, rootCapabilityId);
      assert.equal(capability.provenance.adopted_world_minute, '250');
    } finally { checkpointClient.release(); }

    const indexed = await indexTrackedUsdcTransfers({ client: pool, rpc: { async getLogs() {
      return [{ transactionHash: txHash, blockNumber: '0x123', logIndex: '0x0', blockHash: HASH,
        address: SYSTEM_EMITTER, topics: [HASH], data: '0x' }];
    } }, chainId: ARC_MAINNET_CHAIN_ID, sourceKey: `arc-mainnet-isolated:${worldId}`, worldId,
    trackedWallets: [PAYER], startBlock: 1n, latestBlock: 300n, maxBlockCount: 500n, maxPages: 1 });
    assert.equal(indexed.indexedLogs, 1);

    const observer = new ArcReadOnlyObserver({ pool, config,
      env: { ARC_SETTLEMENT_CONTRACT_ADDRESS: CONTRACT,
        ARC_WORLD_REGISTRY_ADDRESS: '0x4444444444444444444444444444444444444444',
        ARC_CAPABILITY_PROVENANCE_ADDRESS: '0x5555555555555555555555555555555555555555' },
      rpcClient, isOwner: () => true, intervalMs: 60_000 });
    try {
      await observer.start({ worldId });
      const status = observer.getStatus();
      assert.equal(status.running, true);
      assert.equal(status.mode, 'read_only');
      assert.equal(status.worldId, worldId);
      assert.equal(status.usdc.verified, true);
      assert.equal(status.arcMainnet.pendingSettlements, 1);
      assert.equal(status.arcMainnet.settlementEnabled, false);
      assert.equal(status.database.capabilityProvenance.total, 1);
      assert.equal(status.database.recentSettlements[0].transactionHash, txHash);
    } finally { await observer.stop(); }
  } finally {
    if (worker) await worker.stop();
    if (engine) await engine.stop();
    await pool.end();
  }
});

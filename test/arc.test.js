import test from 'node:test';
import assert from 'node:assert/strict';
import { ARC_CAPABILITY_PROVENANCE_INTERFACE, buildArcCapabilityProvenanceTransaction } from '../src/arc/provenance.js';
import { buildWorldRegistryCheckpointTransaction, prepareArcWorldCheckpoint } from '../src/arc/checkpoints.js';
import { buildWorldCheckpointRoots } from '../src/arc/commitments.js';
import { arcNetworkConfig, ARC_MAINNET_CHAIN_ID,
  ARC_MAINNET_USDC_ADDRESS, parseArcNativeGasUnits,
  parseArcUsdcTokenUnits, formatArcNativeGasUnits, formatArcUsdcTokenUnits,
  assertArcChainId } from '../src/arc/config.js';
import { indexArcContractEvents, indexTrackedUsdcTransfers,
  buildTrackedUsdcTransferFilters } from '../src/arc/indexer.js';
import { ArcRpcClient } from '../src/arc/rpc.js';
import { ARC_SETTLEMENT_INTERFACE, arcActionFamilyHash, arcReasonHash,
  arcWorldActionHash, auditArcSettlementReceipt, prepareArcSettlement,
  reconcileArcSettlementById, reconcileArcSettlementReceipt, submitArcSettlement } from '../src/arc/settlement.js';
import { ArcReadOnlyObserver } from '../src/arc/observer.js';
import { summarizeArcObserverHealth } from '../src/arc/status.js';
import { buildArcEip1559FeeFields, ExternalKmsArcSigner } from '../src/arc/wallet-provider.js';
import { createIsolatedArcMainnetConfig } from './helpers/arc-mainnet-fakes.js';

const WORLD_ID = 'ce434421-8bcd-4aac-b9ba-183383c713de';
const AGENT_ID = 'adca48db-4492-4b39-98fa-b67c2548ba41';
const RECIPIENT_ID = '7c4a06a7-c346-4966-b3cc-5a5064a4e9ed';
const CONTRACT = '0x1111111111111111111111111111111111111111';
const PAYER = '0x2222222222222222222222222222222222222222';
const RECIPIENT = '0x3333333333333333333333333333333333333333';
const HASH = `0x${'ab'.repeat(32)}`;
const ZERO = `0x${'00'.repeat(32)}`;

test('Arc config is Mainnet-only and keeps native gas and ERC-20 USDC precision separate', () => {
  const mainnet = arcNetworkConfig({ ARC_ENV: 'mainnet' });
  assert.equal(mainnet.chainId, ARC_MAINNET_CHAIN_ID);
  assert.equal(mainnet.usdcAddress, ARC_MAINNET_USDC_ADDRESS);
  assert.equal(mainnet.nativeGasDecimals, 18);
  assert.equal(mainnet.usdcTokenDecimals, 6);
  assert.equal(parseArcNativeGasUnits('1.000000000000000001'), 1_000_000_000_000_000_001n);
  assert.equal(parseArcUsdcTokenUnits('1.000001'), 1_000_001n);
  assert.equal(formatArcNativeGasUnits(1_000_000_000_000_000_001n), '1.000000000000000001');
  assert.equal(formatArcUsdcTokenUnits(1_000_001n), '1.000001');
  assert.throws(() => parseArcUsdcTokenUnits('0.0000001'), RangeError);
  assert.throws(() => assertArcChainId('0x4cef52', mainnet), { code: 'ARC_CHAIN_ID_MISMATCH' });
  assert.throws(() => arcNetworkConfig({ ARC_ENV: 'staging' }), { code: 'ARC_MAINNET_ONLY' });
  assert.throws(() => arcNetworkConfig({ ARC_ENV: 'testnet' }), { code: 'ARC_MAINNET_ONLY' });
  assert.throws(() => arcNetworkConfig({ ARC_RPC_URL: 'https://rpc.testnet.arc.io' }), TypeError);
  assert.throws(() => arcNetworkConfig({ ARC_RPC_URL: 'https://not-arc.example' }), TypeError);
});

test('health API status is truthful and excludes detailed resident wallet and settlement records', () => {
  const config = arcNetworkConfig({ ARC_ENV: 'mainnet' });
  const publicStatus = summarizeArcObserverHealth({ available: true, running: true, mode: 'read_only',
    worldId: WORLD_ID, network: { name: 'mainnet', chainId: 5042, explorerUrl: 'https://explorer.arc.io' },
    lastSampleAt: '2026-10-07T00:00:00Z', lastSampleWorldMinute: 3000, lastFindingCount: 0,
    rpc: { configured: true, chainId: 5042, expectedChainId: 5042, rpcHealthy: true, latestBlock: 12 },
    usdc: { verified: true, address: ARC_MAINNET_USDC_ADDRESS, erc20Decimals: 6 },
    arcMainnet: { configured: true, chainId: 5042, rpcHealthy: true, pendingSettlements: 0,
      failedSettlements: 0, settlementEnabled: false },
    database: { walletBalances: [{ address: PAYER }], recentSettlements: [{ amountBaseUnits: '1' }] }
  }, config);
  assert.equal(publicStatus.available, true);
  assert.equal(publicStatus.running, true);
  assert.equal(publicStatus.mode, 'read_only');
  assert.equal(publicStatus.lastSampleWorldMinute, 3000);
  assert.equal(publicStatus.usdc.nativeGasDecimals, 18);
  assert.equal(publicStatus.arcMainnet.chainId, 5042);
  assert.equal(publicStatus.database.worldMinute, null);
  assert.equal(publicStatus.database.wallets.total, 0);
  assert.equal(JSON.stringify(publicStatus).includes(PAYER), false);
  assert.equal(JSON.stringify(publicStatus).includes('walletBalances'), false);
  assert.equal(JSON.stringify(publicStatus).includes('recentSettlements'), false);
  assert.equal(JSON.stringify(publicStatus).includes('deployerAddress'), false);
});

test('Mainnet writes stay gated and fake signer callbacks are never reached while closed', async () => {
  const config = arcNetworkConfig({ ARC_ENV: 'mainnet' });
  assert.equal(config.writesEnabled, false);
  let broadcastCalls = 0;
  const signer = new ExternalKmsArcSigner({ config,
    addressForResident: async () => PAYER,
    submitTransaction: async () => { broadcastCalls += 1; return { hash: HASH }; } });
  await assert.rejects(signer.sendTransaction(AGENT_ID, { to: CONTRACT, chainId: ARC_MAINNET_CHAIN_ID,
    value: 0n, maxFeePerGas: 20_000_000_000n, maxPriorityFeePerGas: 0n }),
  { code: 'ARC_MAINNET_PREFLIGHT_REQUIRED' });
  assert.equal(broadcastCalls, 0);
});

test('environment flags cannot open the Mainnet write gate', () => {
  const config = arcNetworkConfig({ ARC_ENV: 'mainnet', ARC_MAINNET_PREFLIGHT_APPROVED: 'true',
    ARC_MAINNET_WRITES_ENABLED: 'true' });
  assert.equal(config.writesEnabled, false);
});

test('Arc RPC rejects write methods, fails closed on primary chain mismatch, and verifies official backups', async () => {
  const mainnet = arcNetworkConfig({ ARC_ENV: 'mainnet', ARC_RPC_URL: 'https://rpc.mainnet.arc.io',
    ARC_RPC_FALLBACK_URLS: 'https://rpc.blockdaemon.mainnet.arc.io' });
  const calls = [];
  const fetchImpl = async (url, options) => {
    const request = JSON.parse(options.body);
    calls.push({ url, method: request.method });
    if (url.includes('rpc.mainnet.arc.io')) return { ok: true, status: 200, json: async () => ({ result: '0x1' }) };
    return { ok: true, status: 200, json: async () => ({ result: '0x13b2' }) };
  };
  const rpc = new ArcRpcClient({ config: mainnet, fetchImpl });
  await assert.rejects(rpc.getChainId(), { code: 'ARC_CHAIN_ID_MISMATCH' });
  assert.deepEqual(calls.map((call) => call.url), ['https://rpc.mainnet.arc.io']);
  await assert.rejects(rpc.request('eth_sendRawTransaction', ['0x1234']), { code: 'ARC_RPC_METHOD_NOT_READ_ONLY' });

  const fallbackCalls = [];
  const fallbackRpc = new ArcRpcClient({ config: mainnet, fetchImpl: async (url, options) => {
    const request = JSON.parse(options.body);
    fallbackCalls.push({ url, method: request.method });
    if (url.includes('rpc.mainnet.arc.io')) throw new Error('offline');
    return { ok: true, status: 200, json: async () => ({ result: request.method === 'eth_chainId' ? '0x13b2' : '0x123' }) };
  } });
  assert.equal(await fallbackRpc.getBlockNumber(), '0x123');
  assert.ok(fallbackCalls.some((call) => call.url.includes('blockdaemon') && call.method === 'eth_chainId'));
});

test('Arc fee fields preserve the conservative 20 Gwei recommendation and current base fee requirement', () => {
  const floor = 20_000_000_000n;
  assert.deepEqual(buildArcEip1559FeeFields({ baseFeePerGas: floor, recommendedMinimum: floor }), {
    maxFeePerGas: floor, maxPriorityFeePerGas: 0n
  });
  assert.deepEqual(buildArcEip1559FeeFields({ baseFeePerGas: 21_000_000_000n,
    maxPriorityFeePerGas: 2_000_000_000n, recommendedMinimum: floor }), {
    maxFeePerGas: 23_000_000_000n, maxPriorityFeePerGas: 2_000_000_000n
  });
  assert.throws(() => buildArcEip1559FeeFields({ baseFeePerGas: floor,
    maxFeePerGas: floor - 1n, recommendedMinimum: floor }), { code: 'ARC_MAX_FEE_BELOW_RECOMMENDATION' });
  assert.throws(() => buildArcEip1559FeeFields({ baseFeePerGas: floor,
    maxPriorityFeePerGas: 2n, maxFeePerGas: floor, recommendedMinimum: floor }), { code: 'ARC_MAX_FEE_BELOW_CURRENT_REQUIREMENT' });
});

test('Arc signer rejects non-zero native value before invoking the external signer callback', async () => {
  const config = createIsolatedArcMainnetConfig();
  let broadcastCalls = 0;
  const signer = new ExternalKmsArcSigner({ config, addressForResident: async () => PAYER,
    submitTransaction: async () => { broadcastCalls += 1; return { hash: HASH }; } });
  await assert.rejects(signer.sendTransaction(AGENT_ID, { to: CONTRACT, chainId: ARC_MAINNET_CHAIN_ID,
    value: 1n, maxFeePerGas: 20_000_000_000n, maxPriorityFeePerGas: 0n }),
  { code: 'ARC_NATIVE_VALUE_FORBIDDEN' });
  assert.equal(broadcastCalls, 0);
});

function makeSettlementClient() {
  const rows = new Map();
  const costReservations = new Map();
  const pilotBudget = { id: 1, spent_usdc_base_units: 0n, reserved_usdc_base_units: 0n };
  const client = { rows, costReservations, pilotBudget,
    async query(sql, values = []) {
      if (sql.startsWith('SELECT * FROM arc_mainnet_pilot_budget')) {
        return { rowCount: 1, rows: [pilotBudget] };
      }
      if (sql.startsWith('SELECT * FROM arc_mainnet_pilot_cost_reservations')) {
        const reservation = costReservations.get(`${values[0]}:${values[1]}`);
        return { rowCount: reservation ? 1 : 0, rows: reservation ? [reservation] : [] };
      }
      if (sql.startsWith('UPDATE arc_mainnet_pilot_cost_reservations SET status=$3')) {
        const reservation = costReservations.get(`${values[0]}:${values[1]}`);
        if (!reservation) return { rowCount: 0, rows: [] };
        reservation.status = values[2];
        if (values[3]) reservation.transaction_hash = values[3];
        return { rowCount: 1, rows: [reservation] };
      }
      if (sql.startsWith("UPDATE arc_mainnet_pilot_cost_reservations SET status='settled'")) {
        const reservation = [...costReservations.values()].find((item) => item.id === values[0]);
        if (!reservation) return { rowCount: 0, rows: [] };
        Object.assign(reservation, { status: 'settled', actual_cost_usdc_base_units: values[1],
          gas_used: values[2], effective_gas_price: values[3] });
        return { rowCount: 1, rows: [reservation] };
      }
      if (sql.startsWith('UPDATE arc_mainnet_pilot_budget SET reserved_usdc_base_units=reserved_usdc_base_units-$1')) {
        pilotBudget.reserved_usdc_base_units -= BigInt(values[0]);
        pilotBudget.spent_usdc_base_units += BigInt(values[1]);
        return { rowCount: 1, rows: [pilotBudget] };
      }
      if (sql.includes('INSERT INTO arc_settlement_outbox')) {
        const key = `${values[0]}:${values[1]}`;
        if (rows.has(key)) return { rowCount: 0, rows: [] };
        const row = { id: '7c4a06a7-c346-4966-b3cc-5a5064a4e9ed', world_id: values[0], world_action_id: values[1],
          world_event_id: values[2], chain_id: values[3], settlement_contract: values[4], token_address: values[5],
          from_agent_id: values[6], to_agent_id: values[7], from_address: values[8], to_address: values[9],
          simulated_amount_usdc: values[10], amount_base_units: String(values[11]), action_family: values[12],
          reason_hash: values[13], created_world_minute: values[14], status: 'prepared', transaction_hash: null,
          nonce: null, submission_start_block: null, reconciliation_cursor_block: null,
          reconciliation_tx_cursor_block: null,
          submission_attempt_id: null, block_number: null, log_index: null };
        rows.set(key, row);
        rows.set(row.id, row);
        return { rowCount: 1, rows: [row] };
      }
      if (sql.startsWith('SELECT * FROM arc_settlement_outbox WHERE world_id')) {
        const row = rows.get(`${values[0]}:${values[1]}`);
        return { rowCount: row ? 1 : 0, rows: row ? [row] : [] };
      }
      if (sql.startsWith('SELECT * FROM arc_settlement_outbox WHERE id')) {
        const row = rows.get(values[0]);
        return { rowCount: row ? 1 : 0, rows: row ? [row] : [] };
      }
      if (sql.startsWith('UPDATE arc_settlement_outbox SET status=\'submitting\'')) {
        const row = rows.get(values[0]);
        if (!row || row.status !== 'prepared' || row.transaction_hash) return { rowCount: 0, rows: [] };
        row.status = 'submitting'; row.submission_attempt_id = values[1];
        return { rowCount: 1, rows: [row] };
      }
      if (sql.startsWith('UPDATE arc_settlement_outbox SET status=\'submitted\',transaction_hash=$3')) {
        const row = rows.get(values[0]);
        if (!row || row.submission_attempt_id !== values[1]) return { rowCount: 0, rows: [] };
        row.status = 'submitted'; row.transaction_hash = values[2];
        return { rowCount: 1, rows: [row] };
      }
      if (sql.startsWith('UPDATE arc_settlement_outbox SET status=\'submitted\',transaction_hash=$2')) {
        const row = rows.get(values[0]);
        if (!row || row.status !== 'submission_unknown' || row.transaction_hash) return { rowCount: 0, rows: [] };
        row.status = 'submitted'; row.transaction_hash = values[1];
        return { rowCount: 1, rows: [row] };
      }
      if (sql.startsWith('UPDATE arc_settlement_outbox SET status=\'submission_unknown\'')) {
        const row = rows.get(values[0]); row.status = 'submission_unknown';
        return { rowCount: 1, rows: [row] };
      }
      if (sql.startsWith('UPDATE arc_settlement_outbox SET status=\'final\'')) {
        const row = rows.get(values[0]); row.status = 'final'; row.block_number = values[1]; row.log_index = values[2];
        return { rowCount: 1, rows: [row] };
      }
      return { rowCount: 0, rows: [] };
    }
  };
  return client;
}

function seedPilotCostReservation(client, settlement, status = 'reserved') {
  const reservedCost = 10_000_000n;
  client.pilotBudget.reserved_usdc_base_units += reservedCost;
  client.costReservations.set(`settlement:${settlement.id}`, {
    id: `cost-${settlement.id}`, operation_type: 'settlement', operation_id: settlement.id,
    world_id: settlement.world_id, chain_id: ARC_MAINNET_CHAIN_ID,
    transfer_usdc_base_units: '1000001', gas_limit: '50000', max_fee_per_gas: '20000000000',
    reserved_cost_usdc_base_units: reservedCost.toString(), status, transaction_hash: settlement.transaction_hash || null
  });
}

const settlementInput = (overrides = {}) => ({ worldId: WORLD_ID, worldActionId: 'resident-action-0001',
  worldEventId: '1234', chainId: ARC_MAINNET_CHAIN_ID, settlementContract: CONTRACT,
  tokenAddress: ARC_MAINNET_USDC_ADDRESS, fromAgentId: AGENT_ID, toAgentId: RECIPIENT_ID,
  fromAddress: PAYER, toAddress: RECIPIENT, amountBaseUnits: 1_000_001n, simulatedAmountUsdc: '1.00000100',
  actionFamily: 'service', reason: 'resident provided a verified service', createdWorldMinute: '1440', ...overrides });

test('settlement intents are idempotent and reject action ID reuse with changed economic terms', async () => {
  const client = makeSettlementClient();
  const first = await prepareArcSettlement(client, settlementInput());
  const repeated = await prepareArcSettlement(client, settlementInput());
  assert.equal(first.created, true);
  assert.equal(repeated.created, false);
  assert.equal(repeated.settlement.amount_base_units, '1000001');
  await assert.rejects(prepareArcSettlement(client, settlementInput({ amountBaseUnits: 2_000_000n })),
    { code: 'ARC_SETTLEMENT_IDEMPOTENCY_CONFLICT' });
});

test('settlement submission can only be claimed once and retry reconciles instead of resending', async () => {
  const client = makeSettlementClient();
  const { settlement } = await prepareArcSettlement(client, settlementInput());
  seedPilotCostReservation(client, settlement);
  const config = createIsolatedArcMainnetConfig();
  let submissions = 0;
  const signer = new ExternalKmsArcSigner({ config, addressForResident: async () => PAYER,
    submitTransaction: async () => { submissions += 1; return { hash: HASH }; } });
  const rpcClient = { async getChainId() { return ARC_MAINNET_CHAIN_ID; },
    async getBlock() { return { baseFeePerGas: '0x4a817c800' }; }, async getTransactionReceipt() { return null; } };
  const buildTransaction = async () => ({ to: CONTRACT, value: 0n, data: '0x1234' });
  const first = await submitArcSettlement({ client, settlementId: settlement.id, signer, rpcClient,
    residentId: AGENT_ID, buildTransaction });
  assert.equal(first.submitted, true);
  const retry = await submitArcSettlement({ client, settlementId: settlement.id, signer, rpcClient,
    residentId: AGENT_ID, buildTransaction });
  assert.equal(retry.submitted, false);
  assert.equal(retry.reconciliation.pending, true);
  assert.equal(submissions, 1);
});

test('settlement submission cannot retry an unknown transaction without its hash', async () => {
  const client = makeSettlementClient();
  const { settlement } = await prepareArcSettlement(client, settlementInput());
  seedPilotCostReservation(client, settlement, 'submission_unknown');
  settlement.status = 'submission_unknown';
  const result = await reconcileArcSettlementById(client, { settlementId: settlement.id,
    rpcClient: { async getTransactionReceipt() { throw new Error('must not query without hash'); } } });
  assert.equal(result.needsManualReconciliation, true);
  assert.equal(result.finding, 'UNKNOWN_SUBMISSION_METADATA_INCOMPLETE');
});

function settlementEventLog(settlement, logIndex = '0x2') {
  const event = ARC_SETTLEMENT_INTERFACE.getEvent('Settlement');
  const encoded = ARC_SETTLEMENT_INTERFACE.encodeEventLog(event, [
    `0x${WORLD_ID.replaceAll('-', '')}`, arcWorldActionHash(settlement.world_action_id), PAYER, RECIPIENT,
    BigInt(settlement.amount_base_units), arcActionFamilyHash(settlement.action_family), settlement.reason_hash,
    BigInt(settlement.created_world_minute)
  ]);
  return { address: CONTRACT, topics: encoded.topics, data: encoded.data, logIndex,
    transactionHash: HASH, blockNumber: '0x123', blockHash: `0x${'cd'.repeat(32)}` };
}

test('unknown submission recovery finds the exact settlement event and finalizes without resending', async () => {
  const client = makeSettlementClient();
  const { settlement } = await prepareArcSettlement(client, settlementInput());
  seedPilotCostReservation(client, settlement, 'submission_unknown');
  Object.assign(settlement, { status: 'submission_unknown', nonce: '0', from_address: PAYER, to_address: RECIPIENT,
    submission_start_block: '100', reconciliation_cursor_block: '100', reconciliation_tx_cursor_block: '100' });
  const rpcClient = { async getChainId() { return ARC_MAINNET_CHAIN_ID; }, async getBlockNumber() { return '0x123'; },
    async getBlock() { return null; }, async getTransactionCount() { return '0x0'; },
    async getLogs() { return [settlementEventLog(settlement)]; },
    async getTransactionReceipt() { return { transactionHash: HASH, status: '0x1', blockNumber: '0x123',
      gasUsed: '0x5208', effectiveGasPrice: '0x4a817c800',
      logs: [settlementEventLog(settlement)] }; } };
  const recovered = await reconcileArcSettlementById(client, { settlementId: settlement.id, rpcClient });
  assert.equal(recovered.status, 'final');
  assert.equal(recovered.settlement.transaction_hash, HASH);
  assert.equal(recovered.settlement.block_number, '291');
});

test('settlement receipt audit matches chain, event payload, and finality status before reconciliation', async () => {
  const row = { world_id: WORLD_ID, world_action_id: 'resident-action-0001', settlement_contract: CONTRACT,
    from_address: PAYER, to_address: RECIPIENT, amount_base_units: '1000001', action_family: 'service',
    reason_hash: arcReasonHash('resident provided a verified service'), created_world_minute: '1440',
    transaction_hash: HASH, status: 'submitted' };
  const receipt = { transactionHash: HASH, status: '0x1', blockNumber: '0x123', logs: [settlementEventLog(row)] };
  assert.deepEqual(auditArcSettlementReceipt(row, receipt), { consistent: true, finding: null, blockNumber: '291' });
  const client = makeSettlementClient();
  const { settlement } = await prepareArcSettlement(client, settlementInput());
  settlement.status = 'submitted'; settlement.transaction_hash = HASH;
  seedPilotCostReservation(client, settlement, 'submitted');
  const final = await reconcileArcSettlementReceipt(client, { settlement,
    receipt: { ...receipt, gasUsed: '0x5208', effectiveGasPrice: '0x4a817c800' } });
  assert.equal(final.status, 'final');
  assert.equal(final.settlement.block_number, '291');
  assert.equal(final.settlement.log_index, 2);
  assert.equal(auditArcSettlementReceipt(row, { ...receipt, status: '0x0' }).finding, 'ARC_TRANSACTION_REVERTED');
});

function makeIndexerClient() {
  const events = new Map();
  const cursors = new Map();
  const insertedOrder = [];
  return { events, cursors, insertedOrder,
    async query(sql, values = []) {
      if (sql.startsWith('SELECT last_indexed_block')) {
        const row = cursors.get(`${values[0]}:${values[1]}`);
        return { rowCount: row ? 1 : 0, rows: row ? [{ last_indexed_block: row }] : [] };
      }
      if (sql.startsWith('INSERT INTO arc_indexed_events')) {
        const key = `${values[0]}:${values[1]}:${values[2]}`;
        if (events.has(key)) return { rowCount: 0, rows: [] };
        events.set(key, values); insertedOrder.push(`${values[3]}:${values[2]}`);
        return { rowCount: 1, rows: [] };
      }
      if (sql.startsWith('INSERT INTO arc_indexer_state')) {
        cursors.set(`${values[0]}:${values[1]}`, values[2]);
        return { rowCount: 1, rows: [] };
      }
      return { rowCount: 0, rows: [] };
    }
  };
}

function rpcLog(transactionHash, blockNumber, logIndex, address = '0xffffFFFfFFffffffffffffffFfFFFfffFFFfFFfE') {
  return { transactionHash, blockNumber: `0x${blockNumber.toString(16)}`, logIndex: `0x${logIndex.toString(16)}`,
    blockHash: `0x${'aa'.repeat(32)}`, address, topics: [HASH], data: '0x', transactionIndex: '0x0' };
}

test('USDC indexer bounds log queries, orders by block and log index, and deduplicates replayed events', async () => {
  const client = makeIndexerClient();
  const log1 = rpcLog(`0x${'01'.repeat(32)}`, 10, 1);
  const log2 = rpcLog(`0x${'02'.repeat(32)}`, 9, 4);
  const filters = buildTrackedUsdcTransferFilters([PAYER, PAYER], 1n, 9_999n);
  assert.equal(filters.length, 2);
  assert.equal(filters[0].toBlock, '0x270f');
  const rpc = { async getLogs() { return [log1, log2]; } };
  const indexed = await indexTrackedUsdcTransfers({ client, rpc, chainId: ARC_MAINNET_CHAIN_ID,
    sourceKey: 'test-wallets', trackedWallets: [PAYER], startBlock: 1n, latestBlock: 10n,
    maxBlockCount: 100n, maxPages: 1 });
  assert.equal(indexed.indexedLogs, 2, 'the same transfer returned by from/to filters is recorded once');
  assert.deepEqual(client.insertedOrder, ['9:4', '10:1']);
  const replay = await indexTrackedUsdcTransfers({ client, rpc, chainId: ARC_MAINNET_CHAIN_ID,
    sourceKey: 'test-wallets', trackedWallets: [PAYER], startBlock: 1n, latestBlock: 10n,
    maxBlockCount: 100n, maxPages: 1 });
  assert.equal(replay.indexedLogs, 0);
  assert.equal(client.events.size, 2);
});

test('contract indexer validates filters and records an empty page cursor for restart-safe catch-up', async () => {
  const client = makeIndexerClient();
  const rpc = { async getLogs() { return []; } };
  const result = await indexArcContractEvents({ client, rpc, chainId: ARC_MAINNET_CHAIN_ID,
    sourceKey: 'contract', contractAddress: CONTRACT, topic0: HASH, startBlock: 7n,
    latestBlock: 7n, maxBlockCount: 1n, maxPages: 1 });
  assert.equal(result.lastIndexedBlock, '7');
  assert.equal(client.cursors.get(`${ARC_MAINNET_CHAIN_ID}:contract`), '7');
  assert.throws(() => indexArcContractEvents({ client, rpc, chainId: ARC_MAINNET_CHAIN_ID,
    sourceKey: 'bad', contractAddress: 'bad', topic0: HASH }), TypeError);
});

function checkpointClient() {
  const inserted = [];
  return { inserted,
    async query(sql, values = []) {
      if (sql.startsWith('SELECT world_minutes')) return { rowCount: 1, rows: [{ world_minutes: '3000' }] };
      if (sql.includes('SELECT epoch_code')) return { rowCount: 1, rows: [{ code: 'V7' }] };
      if (sql.includes('max(version)')) return { rowCount: 1, rows: [{ version: '0' }] };
      if (sql.includes('FROM arc_world_checkpoints WHERE world_id=$1 AND chain_id=$2')) {
        return { rowCount: 0, rows: [] };
      }
      if (sql.includes('AS root')) return { rowCount: 1, rows: [{ count: '2', root: 'ab'.repeat(32) }] };
      if (sql.startsWith('INSERT INTO arc_world_checkpoints')) {
        const row = { id: '7c4a06a7-c346-4966-b3cc-5a5064a4e9ed', world_id: values[0], chain_id: values[1],
          world_minute: values[2], epoch: values[3], version: values[4], previous_checkpoint_id: values[5],
          history_segment_root: values[6], simulation_ledger_segment_root: values[7], history_root: values[8],
          simulation_ledger_root: values[9], capability_root: values[10], status: 'prepared', metadata: JSON.parse(values[11]) };
        inserted.push({ sql, values, row });
        return { rowCount: 1, rows: [row] };
      }
      return { rowCount: 0, rows: [] };
    }
  };
}

test('checkpoint preparation records deterministic roots, per-chain cursors, and EVM-safe transaction data', async () => {
  const roots = buildWorldCheckpointRoots({ history: [{ id: 1, kind: 'tick' }],
    simulationLedger: [{ amount: 7n }], capabilities: [] });
  assert.match(roots.historyRoot, /^0x[0-9a-f]{64}$/);
  assert.equal(roots.leafCounts.capabilities, 0);
  const client = checkpointClient();
  const prepared = await prepareArcWorldCheckpoint(client, { worldId: WORLD_ID, chainId: ARC_MAINNET_CHAIN_ID });
  assert.equal(prepared.due, true);
  assert.equal(prepared.checkpoint.version, '1');
  assert.ok(client.inserted[0].sql.includes('metadata'));
  assert.ok(client.inserted[0].sql.includes('ON CONFLICT(world_id,chain_id,world_minute)'));
  const transaction = buildWorldRegistryCheckpointTransaction({ registryAddress: CONTRACT, worldId: WORLD_ID,
    worldMinute: '3000', epoch: 'V7', version: '1', historyRoot: roots.historyRoot,
    simulationLedgerRoot: roots.simulationLedgerRoot, capabilityRoot: roots.capabilityRoot });
  assert.deepEqual(Object.keys(transaction).sort(), ['data', 'to', 'value']);
  assert.equal(transaction.value, 0n);
  assert.equal(transaction.to, CONTRACT);
  assert.equal(BigInt(`0x${transaction.data.slice(-64)}`), BigInt(roots.capabilityRoot));
  assert.throws(() => buildWorldRegistryCheckpointTransaction({ registryAddress: CONTRACT, worldId: WORLD_ID,
    worldMinute: '1', epoch: 'unknown', version: '1', historyRoot: HASH,
    simulationLedgerRoot: HASH, capabilityRoot: HASH }), TypeError);
});

test('capability provenance transaction encodes creator kind, parent, version, status and adoption minute', () => {
  const transaction = buildArcCapabilityProvenanceTransaction({ registryAddress: CONTRACT, provenance: {
    capability_id: RECIPIENT_ID, creator_type: 'resident', creator_agent_id: AGENT_ID,
    creator_organization_id: null, parent_capability_id: null, specification_hash: HASH,
    version: '2', anchored_world_minute: '1500', adopted_world_minute: '1400', capability_status: 'active'
  } });
  assert.deepEqual(Object.keys(transaction).sort(), ['data', 'to', 'value']);
  const decoded = ARC_CAPABILITY_PROVENANCE_INTERFACE.decodeFunctionData('anchor', transaction.data);
  assert.equal(decoded.capabilityId.toLowerCase(), `0x${RECIPIENT_ID.replaceAll('-', '')}`);
  assert.equal(decoded.creatorType, 2n);
  assert.equal(decoded.creatorId.toLowerCase(), `0x${AGENT_ID.replaceAll('-', '')}`);
  assert.equal(decoded.version, 2n);
  assert.equal(decoded.worldMinute, 1500n);
  assert.equal(decoded.adoptedWorldMinute, 1400n);
  assert.equal(decoded.status, 3n);
});

test('Arc observer exposes read-only status and does not submit economic transactions', async () => {
  const sqlCalls = [];
  const client = { async query(sql) {
    sqlCalls.push(sql.trim());
    if (sql.includes('pg_try_advisory_lock')) return { rowCount: 1, rows: [{ acquired: true, owner_pid: 123 }] };
    return { rowCount: 1, rows: [{ acquired: true }] };
  }, release() {} };
  const pool = { async connect() { return client; }, async query({ text } = {}) {
    const sql = String(text || arguments[0]).trim();
    sqlCalls.push(sql);
    if (sql.includes('FROM world_runtime_state')) return { rowCount: 1, rows: [{ worldMinute: '100', lastTickAt: new Date() }] };
    if (sql.includes('GROUP BY status')) return { rowCount: 0, rows: [] };
    if (sql.includes('SELECT * FROM arc_settlement_outbox')) return { rowCount: 0, rows: [] };
    if (sql.includes('SELECT agent_id,address FROM arc_agent_wallets')) return { rowCount: 0, rows: [] };
    if (sql.includes('SELECT count(*)::int AS count')) return { rowCount: 1, rows: [{ count: 0 }] };
    if (sql.includes('last_indexed_block')) return { rowCount: 0, rows: [] };
    return { rowCount: 1, rows: [] };
  } };
  const rpc = { async health() { return { configured: true, chainId: ARC_MAINNET_CHAIN_ID,
    expectedChainId: ARC_MAINNET_CHAIN_ID, rpcHealthy: true, latestBlock: 123, latencyMs: 2, error: null }; },
  async getCode() { return '0x1234'; }, async call() { return `0x${'0'.repeat(63)}6`; },
  async getBlockNumber() { return '0x7b'; } };
  const observer = new ArcReadOnlyObserver({ pool, config: arcNetworkConfig({ ARC_ENV: 'mainnet' }),
    env: { ARC_ENV: 'mainnet' }, rpcClient: rpc, intervalMs: 60_000 });
  try {
    await observer.start({ worldId: WORLD_ID });
    const status = observer.getStatus();
    assert.equal(status.available, true);
    assert.equal(status.running, true);
    assert.equal(status.mode, 'read_only');
    assert.equal(status.lastSampleWorldMinute, 100);
    assert.equal(status.usdc.verified, true);
    assert.equal(status.usdc.erc20Decimals, 6);
    assert.equal(status.arcMainnet.settlementEnabled, false);
    assert.equal(status.database.walletBalances.length, 0);
    assert.equal(sqlCalls.some((sql) => /\b(INSERT|UPDATE|DELETE)\b/i.test(sql)), false,
      'the observer does not create or advance settlement lifecycle records when no indexer source is configured');
  } finally { await observer.stop(); }
});

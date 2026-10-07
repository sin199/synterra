import { randomUUID } from 'node:crypto';
import { Interface, id, getAddress } from 'ethers';
import { assertArcChainId, assertArcMainnetChainId, assertArcWriteAllowed } from './config.js';
import { assertArcSigner, buildVerifiedArcTransaction } from './wallet-provider.js';
import { markArcNonceReservation, markStaleArcSubmissionsUnknown, saveArcReconciliationCursor } from './nonce-manager.js';

export const ARC_SETTLEMENT_INTERFACE = new Interface([
  'function settle(bytes32 worldActionId, address recipient, uint256 amount, bytes32 actionFamilyHash, bytes32 reasonHash, uint64 createdWorldMinute)',
  'event Settlement(bytes16 indexed worldId, bytes32 indexed worldActionId, address indexed payer, address recipient, uint256 amount, bytes32 actionFamilyHash, bytes32 reasonHash, uint64 createdWorldMinute)'
]);

export function toArcBytes16Uuid(value, label = 'UUID') {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new TypeError(`${label} must be a UUID.`);
  }
  return `0x${value.replaceAll('-', '').toLowerCase()}`;
}

export function arcWorldActionHash(worldActionId) {
  if (typeof worldActionId !== 'string' || worldActionId.length < 8 || worldActionId.length > 160) {
    throw new TypeError('worldActionId must contain 8 to 160 characters.');
  }
  return id(worldActionId);
}

export function arcActionFamilyHash(actionFamily) {
  if (typeof actionFamily !== 'string' || actionFamily.length < 1 || actionFamily.length > 96) {
    throw new TypeError('actionFamily must contain 1 to 96 characters.');
  }
  return id(actionFamily);
}

export function arcReasonHash(reason) {
  if (typeof reason !== 'string' || reason.trim().length < 1 || reason.length > 2_000) {
    throw new TypeError('reason must contain 1 to 2000 characters.');
  }
  return id(reason);
}

function positiveIntegerString(value, name) {
  if (typeof value === 'bigint') {
    if (value <= 0n) throw new RangeError(`${name} must be positive.`);
    return value.toString();
  }
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) {
    throw new TypeError(`${name} must be a positive integer string or bigint.`);
  }
  return BigInt(value).toString();
}

function normalizedAddress(value, name) {
  try { return getAddress(value).toLowerCase(); }
  catch { throw new TypeError(`${name} must be a valid EVM address.`); }
}

function equivalentIntent(row, intent) {
  return row.world_id === intent.worldId
    && row.world_action_id === intent.worldActionId
    && String(row.world_event_id || '') === String(intent.worldEventId || '')
    && Number(row.chain_id) === Number(intent.chainId)
    && row.settlement_contract.toLowerCase() === intent.settlementContract.toLowerCase()
    && row.token_address.toLowerCase() === intent.tokenAddress.toLowerCase()
    && row.from_agent_id === intent.fromAgentId
    && row.to_agent_id === (intent.toAgentId || null)
    && row.from_address.toLowerCase() === intent.fromAddress.toLowerCase()
    && row.to_address.toLowerCase() === intent.toAddress.toLowerCase()
    && String(row.amount_base_units) === intent.amountBaseUnits
    && row.action_family === intent.actionFamily
    && row.reason_hash.toLowerCase() === intent.reasonHash.toLowerCase()
    && String(row.simulated_amount_usdc) === intent.simulatedAmountUsdc
    && String(row.created_world_minute) === String(intent.createdWorldMinute);
}

export async function prepareArcSettlement(client, input) {
  const intent = {
    worldId: input.worldId,
    worldActionId: input.worldActionId,
    worldEventId: input.worldEventId || null,
    chainId: Number(input.chainId),
    settlementContract: normalizedAddress(input.settlementContract, 'settlementContract'),
    tokenAddress: normalizedAddress(input.tokenAddress, 'tokenAddress'),
    fromAgentId: input.fromAgentId,
    toAgentId: input.toAgentId || null,
    fromAddress: normalizedAddress(input.fromAddress, 'fromAddress'),
    toAddress: normalizedAddress(input.toAddress, 'toAddress'),
    amountBaseUnits: positiveIntegerString(input.amountBaseUnits, 'amountBaseUnits'),
    simulatedAmountUsdc: input.simulatedAmountUsdc,
    actionFamily: input.actionFamily,
    reasonHash: input.reasonHash || arcReasonHash(input.reason),
    createdWorldMinute: String(input.createdWorldMinute)
  };
  assertArcMainnetChainId(intent.chainId);
  if (typeof intent.simulatedAmountUsdc !== 'string' || !/^(0|[1-9]\d*)\.\d{8}$/.test(intent.simulatedAmountUsdc)
      || BigInt(intent.simulatedAmountUsdc.replace('.', '')) <= 0n) {
    throw new TypeError('simulatedAmountUsdc must be an explicit positive eight-decimal string.');
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(intent.reasonHash)) throw new TypeError('reasonHash must be a 32-byte hex value.');
  if (!/^(0|[1-9]\d*)$/.test(intent.createdWorldMinute)) throw new TypeError('createdWorldMinute must be a non-negative integer.');

  const inserted = await client.query(`INSERT INTO arc_settlement_outbox(world_id,world_action_id,world_event_id,chain_id,
      settlement_contract,token_address,from_agent_id,to_agent_id,from_address,to_address,simulated_amount_usdc,
      amount_base_units,action_family,reason_hash,status,policy_reason,created_world_minute)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'prepared','settlement_intent_prepared',$15)
    ON CONFLICT(world_id,world_action_id) DO NOTHING RETURNING *`, [
    intent.worldId, intent.worldActionId, intent.worldEventId, intent.chainId, intent.settlementContract,
    intent.tokenAddress, intent.fromAgentId, intent.toAgentId, intent.fromAddress, intent.toAddress,
    intent.simulatedAmountUsdc, intent.amountBaseUnits, intent.actionFamily, intent.reasonHash, intent.createdWorldMinute
  ]);
  const row = inserted.rows[0] || (await client.query(
    'SELECT * FROM arc_settlement_outbox WHERE world_id=$1 AND world_action_id=$2', [intent.worldId, intent.worldActionId]
  )).rows[0];
  if (!row) throw new Error('Arc settlement insert did not return or find its idempotent row.');
  if (!equivalentIntent(row, intent)) {
    const error = new Error('An Arc settlement action ID was reused with different transfer details.');
    error.code = 'ARC_SETTLEMENT_IDEMPOTENCY_CONFLICT';
    throw error;
  }
  return { settlement: row, created: inserted.rowCount === 1 };
}

export async function claimArcSettlementSubmission(client, settlementId) {
  const attemptId = randomUUID();
  const claimed = await client.query(`UPDATE arc_settlement_outbox SET status='submitting',submission_attempt_id=$2,
      submission_started_at=now()
    WHERE id=$1 AND status='prepared' AND transaction_hash IS NULL RETURNING *`, [settlementId, attemptId]);
  if (claimed.rowCount) return { claimed: true, attemptId, settlement: claimed.rows[0] };
  const existing = (await client.query('SELECT * FROM arc_settlement_outbox WHERE id=$1', [settlementId])).rows[0];
  if (!existing) {
    const error = new Error('Arc settlement intent was not found.');
    error.code = 'ARC_SETTLEMENT_NOT_FOUND';
    throw error;
  }
  return { claimed: false, attemptId: null, settlement: existing };
}

export async function markArcSettlementSubmitted(client, { settlementId, attemptId, transactionHash }) {
  if (typeof transactionHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(transactionHash)) {
    throw new TypeError('transactionHash must be a 32-byte hex value.');
  }
  const result = await client.query(`UPDATE arc_settlement_outbox SET status='submitted',transaction_hash=$3,
      submitted_at=COALESCE(submitted_at,now())
    WHERE id=$1 AND submission_attempt_id=$2 AND status IN ('submitting','submission_unknown')
      AND (transaction_hash IS NULL OR lower(transaction_hash)=lower($3)) RETURNING *`,
  [settlementId, attemptId, transactionHash]);
  if (result.rowCount) {
    await markArcNonceReservation(client, { outboxId: settlementId, status: 'submitted', transactionHash });
    return result.rows[0];
  }
  const existing = (await client.query('SELECT * FROM arc_settlement_outbox WHERE id=$1', [settlementId])).rows[0];
  if (existing?.transaction_hash?.toLowerCase() === transactionHash.toLowerCase()) {
    await markArcNonceReservation(client, { outboxId: settlementId, status: 'submitted', transactionHash });
    return existing;
  }
  const error = new Error('Arc settlement submission state changed before its transaction hash was recorded.');
  error.code = 'ARC_SETTLEMENT_SUBMISSION_STATE_CONFLICT';
  throw error;
}

export async function markArcSettlementSubmissionUnknown(client, { settlementId, attemptId }) {
  const result = await client.query(`UPDATE arc_settlement_outbox SET status='submission_unknown'
    WHERE id=$1 AND submission_attempt_id=$2 AND status='submitting' RETURNING *`, [settlementId, attemptId]);
  await markArcNonceReservation(client, { outboxId: settlementId, status: 'unknown' });
  if (result.rowCount) return result.rows[0];
  return (await client.query('SELECT * FROM arc_settlement_outbox WHERE id=$1', [settlementId])).rows[0] || null;
}

async function releaseArcSettlementSubmission(client, { settlementId, attemptId }) {
  await client.query(`UPDATE arc_settlement_outbox SET status='prepared',submission_attempt_id=NULL,submission_started_at=NULL
    WHERE id=$1 AND submission_attempt_id=$2 AND status='submitting' AND transaction_hash IS NULL`,
  [settlementId, attemptId]);
}

export async function submitArcSettlement({ client, settlementId, signer, rpcClient, residentId, buildTransaction }) {
  assertArcSigner(signer, signer?.config);
  assertArcWriteAllowed(signer.config, { operation: 'USDC settlement' });
  if (typeof buildTransaction !== 'function') throw new TypeError('buildTransaction callback is required.');
  if (!rpcClient || typeof rpcClient.getChainId !== 'function'
      || typeof rpcClient.getTransactionReceipt !== 'function') {
    throw new TypeError('Verified Arc RPC client is required for settlement submission and reconciliation.');
  }
  assertArcChainId(await rpcClient.getChainId(), signer.config);
  const settlementBeforeClaim = (await client.query('SELECT * FROM arc_settlement_outbox WHERE id=$1', [settlementId])).rows[0];
  if (!settlementBeforeClaim) {
    const error = new Error('Arc settlement intent was not found.');
    error.code = 'ARC_SETTLEMENT_NOT_FOUND';
    throw error;
  }
  if (settlementBeforeClaim.status !== 'prepared') {
    const reconciliation = await reconcileArcSettlementById(client, { settlementId, rpcClient });
    return { submitted: false, idempotent: true, needsManualReconciliation: reconciliation.needsManualReconciliation || false,
      reconciliation, settlement: reconciliation.settlement || settlementBeforeClaim };
  }
  const claim = await claimArcSettlementSubmission(client, settlementId);
  if (!claim.claimed) return { submitted: false, idempotent: true, settlement: claim.settlement };
  let transaction;
  try {
    const prepared = await buildTransaction(claim.settlement);
    if (Number(signer.config.chainId) !== Number(claim.settlement.chain_id)) {
      const error = new Error('Settlement and wallet provider are configured for different chains.');
      error.code = 'ARC_CHAIN_ID_MISMATCH';
      throw error;
    }
    transaction = await buildVerifiedArcTransaction({ transaction: prepared, config: signer.config, rpcClient,
      expectedTo: claim.settlement.settlement_contract });
  } catch (error) {
    await releaseArcSettlementSubmission(client, { settlementId, attemptId: claim.attemptId });
    throw error;
  }
  try {
    const response = await signer.sendTransaction(residentId, transaction);
    if (!response?.hash) throw new Error('Wallet provider did not return a transaction hash.');
    const settlement = await markArcSettlementSubmitted(client, { settlementId,
      attemptId: claim.attemptId, transactionHash: response.hash });
    return { submitted: true, idempotent: false, transactionHash: response.hash, settlement };
  } catch (error) {
    await markArcSettlementSubmissionUnknown(client, { settlementId, attemptId: claim.attemptId });
    throw error;
  }
}

function isSuccessfulReceipt(receipt) {
  return receipt?.status === 1 || receipt?.status === '0x1' || receipt?.status === '0x01';
}

function matchingSettlementLog(row, receipt) {
  const worldId = toArcBytes16Uuid(row.world_id).toLowerCase();
  const actionHash = arcWorldActionHash(row.world_action_id).toLowerCase();
  return (receipt.logs || []).filter((log) => log.address?.toLowerCase() === row.settlement_contract.toLowerCase())
    .map((log) => {
      try { return ARC_SETTLEMENT_INTERFACE.parseLog(log); }
      catch { return null; }
    })
    .find((event) => event
      && event.name === 'Settlement'
      && String(event.args.worldId).toLowerCase() === worldId
      && String(event.args.worldActionId).toLowerCase() === actionHash
      && String(event.args.payer).toLowerCase() === row.from_address.toLowerCase()
      && String(event.args.recipient).toLowerCase() === row.to_address.toLowerCase()
      && BigInt(event.args.amount) === BigInt(row.amount_base_units)
      && String(event.args.actionFamilyHash).toLowerCase() === arcActionFamilyHash(row.action_family).toLowerCase()
      && String(event.args.reasonHash).toLowerCase() === row.reason_hash.toLowerCase()
      && BigInt(event.args.createdWorldMinute) === BigInt(row.created_world_minute));
}

export function auditArcSettlementReceipt(settlement, receipt) {
  const receiptHash = receipt?.hash || receipt?.transactionHash;
  if (!settlement?.transaction_hash || receiptHash?.toLowerCase() !== settlement.transaction_hash.toLowerCase()) {
    return { consistent: false, finding: 'TRANSACTION_HASH_MISMATCH' };
  }
  if (!isSuccessfulReceipt(receipt)) return { consistent: false, finding: 'ARC_TRANSACTION_REVERTED' };
  if (!matchingSettlementLog(settlement, receipt)) return { consistent: false, finding: 'SETTLEMENT_EVENT_MISMATCH' };
  return { consistent: true, finding: null,
    blockNumber: receipt.blockNumber === undefined ? null : BigInt(receipt.blockNumber).toString() };
}

export async function reconcileArcSettlementReceipt(client, { settlement, receipt }) {
  if (!receipt) return { status: settlement.status, pending: true, mismatch: false };
  const receiptHash = receipt.hash || receipt.transactionHash;
  if (!settlement.transaction_hash || receiptHash?.toLowerCase() !== settlement.transaction_hash.toLowerCase()) {
    return { status: settlement.status, pending: false, mismatch: true, finding: 'TRANSACTION_HASH_MISMATCH' };
  }
  if (!isSuccessfulReceipt(receipt)) {
    const failed = await client.query(`UPDATE arc_settlement_outbox SET status='failed',block_number=$2,
        finalized_at=now(),failure_code='ARC_TRANSACTION_REVERTED'
      WHERE id=$1 AND status IN ('submitted','submission_unknown') RETURNING *`,
    [settlement.id, receipt.blockNumber ? BigInt(receipt.blockNumber).toString() : null]);
    await markArcNonceReservation(client, { outboxId: settlement.id, status: 'reconciled' });
    return { status: failed.rows[0]?.status || settlement.status, pending: false, mismatch: false,
      finding: null, settlement: failed.rows[0] || settlement };
  }
  const event = matchingSettlementLog(settlement, receipt);
  if (!event) return { status: settlement.status, pending: false, mismatch: true, finding: 'SETTLEMENT_EVENT_MISMATCH' };
  const eventLog = (receipt.logs || []).find((log) => {
    try {
      const parsed = ARC_SETTLEMENT_INTERFACE.parseLog(log);
      return log.address?.toLowerCase() === settlement.settlement_contract.toLowerCase()
        && parsed.name === 'Settlement'
        && String(parsed.args.worldActionId).toLowerCase() === arcWorldActionHash(settlement.world_action_id).toLowerCase();
    } catch { return false; }
  });
  const finalized = await client.query(`UPDATE arc_settlement_outbox SET status='final',block_number=$2,log_index=$3,
      finalized_at=COALESCE(finalized_at,now()),failure_code=NULL
    WHERE id=$1 AND transaction_hash=$4 AND status IN ('submitted','submission_unknown','final') RETURNING *`,
  [settlement.id, BigInt(receipt.blockNumber).toString(), Number(BigInt(eventLog.logIndex)), settlement.transaction_hash]);
  await markArcNonceReservation(client, { outboxId: settlement.id, status: 'reconciled' });
  return { status: finalized.rows[0]?.status || settlement.status, pending: false, mismatch: false,
    finding: null, settlement: finalized.rows[0] || settlement };
}

function blockHex(value) { return `0x${BigInt(value).toString(16)}`; }

function expectedSettlementTopics(settlement) {
  const event = ARC_SETTLEMENT_INTERFACE.getEvent('Settlement');
  return ARC_SETTLEMENT_INTERFACE.encodeEventLog(event, [toArcBytes16Uuid(settlement.world_id),
    arcWorldActionHash(settlement.world_action_id), settlement.from_address, settlement.to_address,
    BigInt(settlement.amount_base_units), arcActionFamilyHash(settlement.action_family), settlement.reason_hash,
    BigInt(settlement.created_world_minute)]).topics;
}

function expectedSettlementCalldata(settlement) {
  return ARC_SETTLEMENT_INTERFACE.encodeFunctionData('settle', [arcWorldActionHash(settlement.world_action_id),
    settlement.to_address, BigInt(settlement.amount_base_units), arcActionFamilyHash(settlement.action_family),
    settlement.reason_hash, BigInt(settlement.created_world_minute)]).toLowerCase();
}

function transactionMatchesSettlement(transaction, settlement) {
  try {
    const chainId = transaction.chainId === undefined ? ARC_MAINNET_CHAIN_ID : Number(BigInt(transaction.chainId));
    return chainId === ARC_MAINNET_CHAIN_ID
      && String(transaction.from || '').toLowerCase() === settlement.from_address.toLowerCase()
      && BigInt(transaction.nonce) === BigInt(settlement.nonce)
      && String(transaction.to || '').toLowerCase() === settlement.settlement_contract.toLowerCase()
      && BigInt(transaction.value || '0x0') === 0n
      && String(transaction.input || transaction.data || '').toLowerCase() === expectedSettlementCalldata(settlement);
  } catch { return false; }
}

async function saveDiscoveredSubmissionHash(client, settlement, transactionHash) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(transactionHash || '')) {
    throw new TypeError('Recovered Arc transaction hash is invalid.');
  }
  const saved = await client.query(`UPDATE arc_settlement_outbox SET status='submitted',transaction_hash=$2,
      submitted_at=COALESCE(submitted_at,now()),reconciliation_reason=NULL,updated_at=now()
    WHERE id=$1 AND status='submission_unknown' AND transaction_hash IS NULL RETURNING *`,
  [settlement.id, transactionHash]);
  const row = saved.rows[0] || (await client.query('SELECT * FROM arc_settlement_outbox WHERE id=$1', [settlement.id])).rows[0];
  if (row?.transaction_hash?.toLowerCase() !== transactionHash.toLowerCase()) {
    return { recovered: false, finding: 'RECOVERED_HASH_CONFLICT', settlement: row || settlement };
  }
  await markArcNonceReservation(client, { outboxId: settlement.id, status: 'submitted', transactionHash });
  return { recovered: true, settlement: row };
}

export async function recoverUnknownArcSettlementSubmission(client, { settlement, rpcClient,
  maxLogBlockCount = 9_999n, maxTransactionBlockCount = 64n }) {
  if (settlement.status !== 'submission_unknown' || settlement.transaction_hash) {
    return { recovered: false, pending: true, settlement };
  }
  if (!settlement.settlement_contract || !settlement.from_address || !settlement.to_address
      || settlement.nonce === null || settlement.nonce === undefined
      || settlement.amount_base_units === null || !settlement.reason_hash) {
    return { recovered: false, needsManualReconciliation: true,
      finding: 'UNKNOWN_SUBMISSION_METADATA_INCOMPLETE', settlement };
  }
  if (!rpcClient || typeof rpcClient.getLogs !== 'function' || typeof rpcClient.getBlock !== 'function'
      || typeof rpcClient.getBlockNumber !== 'function' || typeof rpcClient.getTransactionCount !== 'function') {
    return { recovered: false, needsManualReconciliation: true,
      finding: 'UNKNOWN_SUBMISSION_SCAN_UNAVAILABLE', settlement };
  }
  assertArcMainnetChainId(await rpcClient.getChainId());
  const latest = BigInt(await rpcClient.getBlockNumber());
  const initial = settlement.submission_start_block ?? settlement.reconciliation_cursor_block;
  if (initial === null || initial === undefined) {
    return { recovered: false, needsManualReconciliation: true,
      finding: 'UNKNOWN_SUBMISSION_START_BLOCK_MISSING', settlement };
  }
  const topics = expectedSettlementTopics(settlement);
  const logCursor = BigInt(settlement.reconciliation_cursor_block ?? initial);
  const maxLogs = BigInt(maxLogBlockCount);
  if (maxLogs < 1n || maxLogs > 9_999n) throw new RangeError('Unknown submission log scan must be bounded to 9,999 blocks.');
  if (logCursor <= latest) {
    const logEnd = logCursor + maxLogs - 1n < latest ? logCursor + maxLogs - 1n : latest;
    const logs = await rpcClient.getLogs({ address: settlement.settlement_contract,
      fromBlock: blockHex(logCursor), toBlock: blockHex(logEnd), topics });
    for (const log of logs || []) {
      if (log.removed || String(log.address || '').toLowerCase() !== settlement.settlement_contract.toLowerCase()) continue;
      if (!matchingSettlementLog(settlement, { logs: [log] })) continue;
      const recovered = await saveDiscoveredSubmissionHash(client, settlement, log.transactionHash);
      return { ...recovered, pending: recovered.recovered, source: 'settlement_event_log' };
    }
    await saveArcReconciliationCursor(client, { outboxId: settlement.id,
      nextBlock: logEnd + 1n, cursorType: 'logs', reason: 'SETTLEMENT_EVENT_NOT_FOUND_IN_SCANNED_RANGE' });
  }

  let txCursor = BigInt(settlement.reconciliation_tx_cursor_block ?? initial);
  const maxTransactions = BigInt(maxTransactionBlockCount);
  if (maxTransactions < 1n || maxTransactions > 256n) {
    throw new RangeError('Unknown submission full-block scan must be bounded to 256 blocks.');
  }
  if (txCursor <= latest) {
    const txEnd = txCursor + maxTransactions - 1n < latest ? txCursor + maxTransactions - 1n : latest;
    for (let blockNumber = txCursor; blockNumber <= txEnd; blockNumber += 1n) {
      const block = await rpcClient.getBlock(blockHex(blockNumber), true);
      if (!block) return { recovered: false, pending: true, settlement, scannedThrough: (blockNumber - 1n).toString() };
      for (const transaction of block.transactions || []) {
        if (String(transaction.from || '').toLowerCase() !== settlement.from_address.toLowerCase()
            || BigInt(transaction.nonce ?? -1) !== BigInt(settlement.nonce)) continue;
        if (!transactionMatchesSettlement(transaction, settlement)) {
          await saveArcReconciliationCursor(client, { outboxId: settlement.id,
            nextBlock: txEnd + 1n, cursorType: 'transactions', reason: 'NONCE_CONSUMED_BY_DIFFERENT_TRANSACTION' });
          return { recovered: false, needsManualReconciliation: true,
            finding: 'NONCE_CONSUMED_BY_DIFFERENT_TRANSACTION', settlement };
        }
        const recovered = await saveDiscoveredSubmissionHash(client, settlement, transaction.hash);
        return { ...recovered, pending: recovered.recovered, source: 'full_block_transaction' };
      }
    }
    txCursor = txEnd + 1n;
    await saveArcReconciliationCursor(client, { outboxId: settlement.id,
      nextBlock: txCursor, cursorType: 'transactions', reason: 'TRANSACTION_NONCE_NOT_FOUND_IN_SCANNED_RANGE' });
  }
  if (txCursor > latest) {
    const latestNonce = BigInt(await rpcClient.getTransactionCount(settlement.from_address, 'latest'));
    if (latestNonce > BigInt(settlement.nonce)) {
      return { recovered: false, needsManualReconciliation: true,
        finding: 'NONCE_CONSUMED_BY_UNMATCHED_TRANSACTION', settlement };
    }
  }
  return { recovered: false, pending: true, settlement, scannedThrough: (txCursor - 1n).toString() };
}

export async function reconcileArcSettlementById(client, { settlementId, rpcClient }) {
  const settlement = (await client.query('SELECT * FROM arc_settlement_outbox WHERE id=$1', [settlementId])).rows[0];
  if (!settlement) {
    const error = new Error('Arc settlement intent was not found.');
    error.code = 'ARC_SETTLEMENT_NOT_FOUND';
    throw error;
  }
  if (['prepared', 'failed'].includes(settlement.status)) {
    return { status: settlement.status, pending: settlement.status === 'prepared', mismatch: false, settlement };
  }
  if (!settlement.transaction_hash) {
    const recovered = await recoverUnknownArcSettlementSubmission(client, { settlement, rpcClient });
    if (!recovered.recovered) return { status: settlement.status, pending: recovered.pending || false,
      mismatch: false, ...recovered };
    return reconcileArcSettlementById(client, { settlementId, rpcClient });
  }
  if (!rpcClient || typeof rpcClient.getTransactionReceipt !== 'function') {
    throw new TypeError('Arc RPC client is required to reconcile a submitted settlement.');
  }
  const receipt = await rpcClient.getTransactionReceipt(settlement.transaction_hash);
  if (!receipt) return { status: settlement.status, pending: true, mismatch: false, settlement };
  return reconcileArcSettlementReceipt(client, { settlement, receipt });
}

export async function reconcilePendingArcSettlements(pool, { rpcClient, limit = 20, staleSubmissionLeaseMinutes = 2 } = {}) {
  const pageSize = Math.max(1, Math.min(100, Math.trunc(Number(limit) || 20)));
  await markStaleArcSubmissionsUnknown(pool, { leaseMinutes: staleSubmissionLeaseMinutes });
  const pending = await pool.query(`SELECT id FROM arc_settlement_outbox
    WHERE transaction_hash IS NOT NULL AND status='submitted'
      OR status='submission_unknown'
    ORDER BY CASE WHEN status='submission_unknown' THEN 0 ELSE 1 END,created_at,id
    LIMIT $1`, [pageSize]);
  const results = [];
  for (const row of pending.rows) {
    try {
      results.push({ settlementId: row.id, ...(await reconcileArcSettlementById(pool, {
        settlementId: row.id, rpcClient })) });
    } catch (error) {
      results.push({ settlementId: row.id, errorCode: String(error?.code || 'ARC_RECONCILIATION_ERROR')
        .replace(/[^A-Z0-9_]/gi, '').slice(0, 80) });
    }
  }
  return { processed: results.length, results };
}

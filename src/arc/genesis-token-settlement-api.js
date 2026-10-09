import { randomUUID } from 'node:crypto';
import { buildGenesisTokenSettlementCall, buildGenesisTokenSettlementWalletAuthorization } from './genesis-token-settlement.js';
import { assertArcChainId } from './config.js';

function coded(code, statusCode = 409) {
  return Object.assign(new Error(code), { code, statusCode });
}

function publicSettlement(row) {
  return {
    id: row.id,
    worldId: row.world_id,
    actionId: row.world_action_id,
    tokenId: row.token_id,
    tokenAddress: row.token_address,
    tokenSymbol: row.token_symbol,
    tokenDecimals: Number(row.token_decimals),
    chainId: Number(row.chain_id),
    settlementContract: row.settlement_contract,
    fromAgentId: row.from_agent_id,
    fromWalletAccountType: row.from_wallet_account_type || row.metadata?.payerWalletAccountType || null,
    toAgentId: row.to_agent_id,
    toOrganizationId: row.to_organization_id,
    fromAddress: row.from_address,
    toAddress: row.to_address,
    amountRaw: String(row.amount_raw),
    actionFamily: row.action_family,
    status: row.status,
    transactionHash: row.transaction_hash,
    blockNumber: row.block_number === null ? null : String(row.block_number),
    createdWorldMinute: Number(row.created_world_minute),
    createdAt: row.created_at,
    finalizedAt: row.finalized_at,
    failureCode: row.failure_code,
    ownershipAuthority: row.status === 'final' ? 'arc_chain_confirmation' : 'arc_chain_confirmation_pending',
    custody: 'non_custodial'
  };
}

async function readSettlementForAgent(client, { worldId, settlementId, agentId, forUpdate = false }) {
  const result = await client.query(`SELECT outbox.*,token.token_address,token.symbol AS token_symbol,
      token.decimals AS token_decimals,payer_wallet.account_type AS from_wallet_account_type
    FROM arc_genesis_token_settlement_outbox outbox
    JOIN arc_agent_tokens token ON token.world_id=outbox.world_id AND token.id=outbox.token_id
    LEFT JOIN arc_agent_wallets payer_wallet ON payer_wallet.world_id=outbox.world_id
      AND payer_wallet.agent_id=outbox.from_agent_id AND payer_wallet.chain_id=outbox.chain_id
      AND lower(payer_wallet.address)=lower(outbox.from_address)
    WHERE outbox.world_id=$1 AND outbox.id=$2 AND (outbox.from_agent_id=$3 OR outbox.to_agent_id=$3)
    ${forUpdate ? 'FOR UPDATE OF outbox' : ''}`, [worldId, settlementId, agentId]);
  if (!result.rowCount) throw coded('GENESIS_SETTLEMENT_NOT_FOUND', 404);
  return result.rows[0];
}

export async function readGenesisTokenSettlement(client, { worldId, settlementId, agentId }) {
  const row = await readSettlementForAgent(client, { worldId, settlementId, agentId });
  return publicSettlement(row);
}

export async function prepareGenesisTokenSettlementAuthorization(client, { worldId, settlementId, agentId,
  writesEnabled = false, spendingPolicy = null }) {
  // Keep the current build fail-closed. This check intentionally precedes any
  // data lookup so a closed gate cannot accidentally expose runnable calldata.
  if (!writesEnabled) throw coded('ARC_MAINNET_WRITE_GATE_CLOSED', 409);
  const row = await readSettlementForAgent(client, { worldId, settlementId, agentId });
  if (row.from_agent_id !== agentId) throw coded('GENESIS_SETTLEMENT_PAYER_ONLY', 403);
  if (row.status !== 'prepared') throw coded('GENESIS_SETTLEMENT_NOT_PREPARED', 409);
  if (!row.settlement_contract || !row.token_address || !row.from_wallet_account_type) {
    throw coded('GENESIS_SETTLEMENT_CONFIGURATION_UNAVAILABLE', 503);
  }
  return buildGenesisTokenSettlementWalletAuthorization(row, { tokenAddress: row.token_address,
    settlementContract: row.settlement_contract, spendingPolicy, walletAccountType: row.from_wallet_account_type });
}

export async function recordGenesisTokenSettlementSubmission(client, { worldId, settlementId, agentId,
  transactionHash = null, submissionUnknown = false, latestBlock = null, writesEnabled = false, rpcClient = null }) {
  if (!writesEnabled) throw coded('ARC_MAINNET_WRITE_GATE_CLOSED', 409);
  if (Boolean(transactionHash) === Boolean(submissionUnknown)) {
    throw coded('GENESIS_SETTLEMENT_SUBMISSION_INVALID', 400);
  }
  const row = await readSettlementForAgent(client, { worldId, settlementId, agentId, forUpdate: true });
  if (row.from_agent_id !== agentId) throw coded('GENESIS_SETTLEMENT_PAYER_ONLY', 403);
  if (!['eoa','sca','msca'].includes(row.from_wallet_account_type)) {
    throw coded('GENESIS_SETTLEMENT_WALLET_AUTHORIZATION_UNSUPPORTED', 409);
  }
  if (transactionHash !== null && !/^0x[0-9a-fA-F]{64}$/.test(transactionHash)) {
    throw coded('GENESIS_SETTLEMENT_TRANSACTION_HASH_INVALID', 400);
  }
  if (row.status === 'submitted' && transactionHash
      && row.transaction_hash?.toLowerCase() === transactionHash.toLowerCase()) {
    return { settlement: publicSettlement(row), idempotent: true };
  }
  if (row.status !== 'prepared' && row.status !== 'submission_unknown') {
    throw coded('GENESIS_SETTLEMENT_NOT_SUBMITTABLE', 409);
  }
  if (submissionUnknown && (!Number.isSafeInteger(Number(latestBlock)) || Number(latestBlock) < 0)) {
    throw coded('GENESIS_SETTLEMENT_SUBMISSION_BLOCK_REQUIRED', 400);
  }

  if (transactionHash) {
    if (!rpcClient || typeof rpcClient.getTransaction !== 'function') {
      throw coded('GENESIS_SETTLEMENT_READONLY_RPC_UNAVAILABLE', 503);
    }
    const transaction = await rpcClient.getTransaction(transactionHash);
    if (!transaction) throw coded('GENESIS_SETTLEMENT_TRANSACTION_NOT_FOUND', 404);
    try { assertArcChainId(transaction.chainId); }
    catch { throw coded('GENESIS_SETTLEMENT_TRANSACTION_CHAIN_MISMATCH', 400); }
    const directEoaMismatch = row.from_wallet_account_type === 'eoa'
      && (String(transaction.from || '').toLowerCase() !== row.from_address.toLowerCase()
        || String(transaction.to || '').toLowerCase() !== String(row.settlement_contract || '').toLowerCase()
        || String(transaction.data || transaction.input || '').toLowerCase() !== buildGenesisTokenSettlementCall(row));
    if (String(transaction.hash || '').toLowerCase() !== transactionHash.toLowerCase() || directEoaMismatch) {
      throw coded('GENESIS_SETTLEMENT_TRANSACTION_MISMATCH', 400);
    }
  }

  const update = submissionUnknown
    ? await client.query(`UPDATE arc_genesis_token_settlement_outbox SET status='submission_unknown',
        transaction_hash=NULL,submission_attempt_id=COALESCE(submission_attempt_id,$3),
        submission_started_at=COALESCE(submission_started_at,now()),submission_start_block=COALESCE(submission_start_block,$4),
        updated_at=now() WHERE id=$1 AND world_id=$2 AND status IN ('prepared','submission_unknown') RETURNING *`,
    [settlementId, worldId, randomUUID(), String(latestBlock)])
    : await client.query(`UPDATE arc_genesis_token_settlement_outbox SET status='submitted',transaction_hash=$3,
        submission_attempt_id=COALESCE(submission_attempt_id,$4),submission_started_at=COALESCE(submission_started_at,now()),
        submitted_at=COALESCE(submitted_at,now()),updated_at=now()
      WHERE id=$1 AND world_id=$2 AND status IN ('prepared','submission_unknown')
        AND (transaction_hash IS NULL OR lower(transaction_hash)=lower($3)) RETURNING *`,
    [settlementId, worldId, transactionHash, randomUUID()]);
  if (!update.rowCount) throw coded('GENESIS_SETTLEMENT_SUBMISSION_RACE', 409);
  const refreshed = await readSettlementForAgent(client, { worldId, settlementId, agentId });
  return { settlement: publicSettlement(refreshed), idempotent: false };
}

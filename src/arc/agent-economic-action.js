import { randomUUID } from 'node:crypto';
import { id, Interface, keccak256 } from 'ethers';
import { assertArcMainnetChainId, ARC_MAINNET_CHAIN_ID, ARC_MAINNET_USDC_ADDRESS, ARC_USDC_TOKEN_DECIMALS,
  simulatedUsdcToArcTokenUnits } from './config.js';
import { assertArcSigner, buildVerifiedArcTransaction } from './wallet-provider.js';
import { reserveArcNonce, releaseArcNonceReservation } from './nonce-manager.js';
import { reserveArcMainnetPilotCost } from './pilot-budget.js';
import { ARC_SETTLEMENT_INTERFACE, arcReasonHash, arcWorldActionHash,
  submitArcSettlement, toArcBytes16Uuid } from './settlement.js';

export const ARC_AGENT_SERVICE_ACTION_FAMILY = 'resident_service_purchase';
export const ARC_SETTLEMENT_POLICY_INTERFACE = new Interface([
  'function spendingPolicies(address) view returns (uint128 perActionLimit,uint128 dailyLimit,uint128 spentToday,uint64 dayIndex,bool initialized,bool paused)',
  'function allowedActionFamilies(address,bytes32) view returns (bool)',
  'function completedActions(bytes32) view returns (bool)'
]);
const ARC_SETTLEMENT_IDENTITY_INTERFACE = new Interface([
  'function worldId() view returns (bytes16)',
  'function usdc() view returns (address)'
]);
const ERC20_POLICY_INTERFACE = new Interface([
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function decimals() view returns (uint8)'
]);

function uuid(value, label) {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new TypeError(`${label} must be a UUID.`);
  }
  return value;
}

function amountString(value) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)\.\d{8}$/.test(value) || BigInt(value.replace('.', '')) <= 0n) {
    throw new TypeError('Simulated USDC amount must be a positive eight-decimal string.');
  }
  return value;
}

export async function enqueueArcAgentEconomicAction(client, input) {
  const worldId = uuid(input.worldId, 'worldId');
  const fromAgentId = uuid(input.fromAgentId, 'fromAgentId');
  const toAgentId = uuid(input.toAgentId, 'toAgentId');
  if (fromAgentId === toAgentId) throw new TypeError('An agent cannot settle a service purchase to itself.');
  if (typeof input.worldActionId !== 'string' || input.worldActionId.length < 8 || input.worldActionId.length > 160) {
    throw new TypeError('worldActionId must contain 8 to 160 characters.');
  }
  if (!Number.isSafeInteger(Number(input.worldMinute)) || Number(input.worldMinute) < 0) {
    throw new TypeError('worldMinute must be a non-negative safe integer.');
  }
  const genesisActivation = await client.query(`SELECT 1 FROM world_genesis_currency_activations
    WHERE world_id=$1`, [worldId]);
  if (genesisActivation.rowCount) {
    return { outbox: null, created: false, skipped: true, reason: 'GENESIS_CURRENCY_ACTIVE' };
  }
  const simulatedAmountUsdc = amountString(input.simulatedAmountUsdc);
  const actionFamily = ARC_AGENT_SERVICE_ACTION_FAMILY;
  const reason = `Autonomous resident service purchase ${String(input.orderId || input.worldActionId).slice(0, 120)}.`;
  const reasonHash = arcReasonHash(reason);
  const inserted = await client.query(`INSERT INTO arc_settlement_outbox(world_id,world_action_id,world_event_id,
      chain_id,token_address,from_agent_id,to_agent_id,simulated_amount_usdc,action_family,reason_hash,
      status,policy_reason,created_world_minute,metadata)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'policy_pending','awaiting_explicit_wallet_and_spending_policy',$11,$12::jsonb)
    ON CONFLICT(world_id,world_action_id) DO NOTHING RETURNING *`, [worldId, input.worldActionId,
    input.worldEventId || null, ARC_MAINNET_CHAIN_ID, ARC_MAINNET_USDC_ADDRESS, fromAgentId, toAgentId,
    simulatedAmountUsdc, actionFamily, reasonHash, String(input.worldMinute),
    JSON.stringify({ orderId: input.orderId || null, businessId: input.businessId || null,
      settlementAmountSource: 'explicit_agent_policy_basis_points', simulationLedgerIsNotRealValue: true })]);
  const row = inserted.rows[0] || (await client.query(`SELECT * FROM arc_settlement_outbox
    WHERE world_id=$1 AND world_action_id=$2`, [worldId, input.worldActionId])).rows[0];
  if (!row || row.from_agent_id !== fromAgentId || row.to_agent_id !== toAgentId
      || String(row.simulated_amount_usdc) !== simulatedAmountUsdc
      || row.action_family !== actionFamily || row.reason_hash.toLowerCase() !== reasonHash.toLowerCase()) {
    const error = new Error('Autonomous economic action settlement outbox idempotency conflict.');
    error.code = 'ARC_ACTION_OUTBOX_IDEMPOTENCY_CONFLICT';
    throw error;
  }
  return { outbox: row, created: inserted.rowCount === 1 };
}

function temporaryReason(code) { return { status: 'policy_pending', code }; }
function rejectedReason(code) { return { status: 'policy_rejected', code }; }

export function evaluateArcOffchainSettlementPolicy({ simulatedAmountUsdc, basisPoints,
  perActionLimitBaseUnits, dailyLimitBaseUnits, spentTodayBaseUnits }) {
  const amountBaseUnits = simulatedUsdcToArcTokenUnits(simulatedAmountUsdc, Number(basisPoints));
  if (amountBaseUnits <= 0n) return { allowed: false, reason: 'SETTLEMENT_POLICY_DISABLED', amountBaseUnits };
  const perActionLimit = BigInt(perActionLimitBaseUnits);
  const dailyLimit = BigInt(dailyLimitBaseUnits);
  const spentToday = BigInt(spentTodayBaseUnits);
  if (amountBaseUnits > perActionLimit) return { allowed: false, reason: 'PER_ACTION_LIMIT_EXCEEDED', amountBaseUnits };
  if (spentToday + amountBaseUnits > dailyLimit) return { allowed: false, reason: 'DAILY_LIMIT_EXCEEDED', amountBaseUnits };
  return { allowed: true, amountBaseUnits };
}

export async function readArcOnchainSettlementPolicy(rpcClient, { contractAddress, walletAddress,
  worldId, actionFamily = ARC_AGENT_SERVICE_ACTION_FAMILY, worldActionId }) {
  assertArcMainnetChainId(rpcClient.config?.chainId);
  const code = await rpcClient.getCode(contractAddress, 'latest');
  if (!code || code === '0x') return { available: false, reason: 'SETTLEMENT_CONTRACT_NOT_DEPLOYED' };
  const expectedCodeHash = rpcClient.config?.settlementRuntimeCodeHash;
  if (!expectedCodeHash) return { available: false, reason: 'SETTLEMENT_RUNTIME_CODE_HASH_NOT_CONFIGURED' };
  if (keccak256(code).toLowerCase() !== expectedCodeHash.toLowerCase()) {
    return { available: false, reason: 'SETTLEMENT_RUNTIME_CODE_HASH_MISMATCH' };
  }
  const [rawWorldId, rawUsdc] = await Promise.all([
    rpcClient.call({ to: contractAddress, data: ARC_SETTLEMENT_IDENTITY_INTERFACE.encodeFunctionData('worldId') }, 'latest'),
    rpcClient.call({ to: contractAddress, data: ARC_SETTLEMENT_IDENTITY_INTERFACE.encodeFunctionData('usdc') }, 'latest')
  ]);
  const deployedWorldId = ARC_SETTLEMENT_IDENTITY_INTERFACE.decodeFunctionResult('worldId', rawWorldId)[0];
  const deployedUsdc = ARC_SETTLEMENT_IDENTITY_INTERFACE.decodeFunctionResult('usdc', rawUsdc)[0];
  if (String(deployedWorldId).toLowerCase() !== toArcBytes16Uuid(worldId).toLowerCase()) {
    return { available: false, reason: 'SETTLEMENT_WORLD_ID_MISMATCH' };
  }
  if (String(deployedUsdc).toLowerCase() !== ARC_MAINNET_USDC_ADDRESS.toLowerCase()) {
    return { available: false, reason: 'SETTLEMENT_USDC_ADDRESS_MISMATCH' };
  }
  const familyHash = id(actionFamily);
  const [rawPolicy, allowedRaw, completedRaw] = await Promise.all([
    rpcClient.call({ to: contractAddress,
      data: ARC_SETTLEMENT_POLICY_INTERFACE.encodeFunctionData('spendingPolicies', [walletAddress]) }, 'latest'),
    rpcClient.call({ to: contractAddress,
      data: ARC_SETTLEMENT_POLICY_INTERFACE.encodeFunctionData('allowedActionFamilies', [walletAddress, familyHash]) }, 'latest'),
    rpcClient.call({ to: contractAddress,
      data: ARC_SETTLEMENT_POLICY_INTERFACE.encodeFunctionData('completedActions', [arcWorldActionHash(worldActionId)]) }, 'latest')
  ]);
  const policy = ARC_SETTLEMENT_POLICY_INTERFACE.decodeFunctionResult('spendingPolicies', rawPolicy);
  const allowed = ARC_SETTLEMENT_POLICY_INTERFACE.decodeFunctionResult('allowedActionFamilies', allowedRaw)[0];
  const completed = ARC_SETTLEMENT_POLICY_INTERFACE.decodeFunctionResult('completedActions', completedRaw)[0];
  return { available: true, perActionLimitBaseUnits: BigInt(policy.perActionLimit),
    dailyLimitBaseUnits: BigInt(policy.dailyLimit), spentTodayBaseUnits: BigInt(policy.spentToday),
    dayIndex: BigInt(policy.dayIndex), initialized: Boolean(policy.initialized), paused: Boolean(policy.paused),
    actionFamilyAllowed: Boolean(allowed), completed: Boolean(completed), actionFamilyHash: familyHash,
    deployedWorldId, deployedUsdc, runtimeCodeHash: expectedCodeHash.toLowerCase() };
}

async function verifyArcNativeUsdcContract(rpcClient) {
  const code = await rpcClient.getCode(ARC_MAINNET_USDC_ADDRESS, 'latest');
  if (!code || code === '0x') return { verified: false, reason: 'CANONICAL_USDC_CODE_MISSING' };
  const rawDecimals = await rpcClient.call({ to: ARC_MAINNET_USDC_ADDRESS,
    data: ERC20_POLICY_INTERFACE.encodeFunctionData('decimals') }, 'latest');
  const decimals = Number(ERC20_POLICY_INTERFACE.decodeFunctionResult('decimals', rawDecimals)[0]);
  return decimals === ARC_USDC_TOKEN_DECIMALS
    ? { verified: true, decimals }
    : { verified: false, reason: 'CANONICAL_USDC_DECIMALS_MISMATCH' };
}

async function readWalletSettlementAuthorization(rpcClient, { tokenAddress, walletAddress, contractAddress }) {
  const balanceData = ERC20_POLICY_INTERFACE.encodeFunctionData('balanceOf', [walletAddress]);
  const allowanceData = ERC20_POLICY_INTERFACE.encodeFunctionData('allowance', [walletAddress, contractAddress]);
  const [nativeBalance, tokenBalanceRaw, allowanceRaw, pendingNonce] = await Promise.all([
    rpcClient.getBalance(walletAddress, 'latest'),
    rpcClient.call({ to: tokenAddress, data: balanceData }, 'latest'),
    rpcClient.call({ to: tokenAddress, data: allowanceData }, 'latest'),
    rpcClient.getTransactionCount(walletAddress, 'pending')
  ]);
  const tokenBalance = BigInt(ERC20_POLICY_INTERFACE.decodeFunctionResult('balanceOf', tokenBalanceRaw)[0]);
  const allowance = BigInt(ERC20_POLICY_INTERFACE.decodeFunctionResult('allowance', allowanceRaw)[0]);
  return { nativeBalanceWei: BigInt(nativeBalance), tokenBalanceBaseUnits: tokenBalance,
    allowanceBaseUnits: allowance, pendingNonce: BigInt(pendingNonce) };
}

export async function claimArcPolicyEvaluation(client) {
  const claimToken = randomUUID();
    const claimed = await client.query(`WITH candidate AS (
      SELECT id FROM arc_settlement_outbox
      WHERE status IN ('policy_pending','prepared')
        OR (status='policy_checking' AND policy_claimed_at<now()-interval '5 minutes')
      ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1)
    UPDATE arc_settlement_outbox outbox SET status='policy_checking',policy_attempt_id=$1,policy_claimed_at=now()
    FROM candidate WHERE outbox.id=candidate.id RETURNING outbox.*`, [claimToken]);
  return claimed.rows[0] ? { outbox: claimed.rows[0], claimToken } : null;
}

async function savePolicyResult(client, { outbox, claimToken }, result, fields = {}) {
  const outboxId = outbox?.id;
  if (!outboxId || !claimToken) throw new TypeError('A claimed Arc settlement outbox row is required.');
  const updated = await client.query(`UPDATE arc_settlement_outbox SET status=$3,policy_reason=$4,
      settlement_contract=COALESCE($5,settlement_contract),from_address=COALESCE($6,from_address),
      to_address=COALESCE($7,to_address),amount_base_units=COALESCE($8,amount_base_units),
      policy_version=COALESCE($9,policy_version),nonce=COALESCE($10,nonce),submission_start_block=COALESCE($11,submission_start_block),
      metadata=COALESCE($12::jsonb,metadata),updated_at=now()
    WHERE id=$1 AND status='policy_checking' AND policy_attempt_id=$2 RETURNING *`, [outboxId, claimToken,
    result.status, result.code, fields.contractAddress || null, fields.fromAddress || null, fields.toAddress || null,
    fields.amountBaseUnits?.toString() || null, fields.policyVersion || null, fields.nonce?.toString() || null,
    fields.startBlock?.toString() || null, fields.metadata ? JSON.stringify(fields.metadata) : null]);
  if (!updated.rowCount) {
    const error = new Error('Arc settlement policy claim changed while evaluation was in progress.');
    error.code = 'ARC_POLICY_CLAIM_LOST';
    throw error;
  }
  if (result.status !== 'prepared') await releaseArcNonceReservation(client, outboxId);
  return updated.rows[0];
}

export async function evaluateNextArcSettlementPolicy({ pool, config, env, signer, rpcClient }) {
  assertArcMainnetChainId(config?.chainId);
  if (!config.writesEnabled || !signer) return { processed: false, reason: 'MAINNET_SIGNER_OR_WRITE_GATE_PENDING' };
  assertArcSigner(signer, config);
  const claimClient = await pool.connect();
  let claim;
  try {
    await claimClient.query('BEGIN');
    claim = await claimArcPolicyEvaluation(claimClient);
    await claimClient.query('COMMIT');
  } catch (error) {
    await claimClient.query('ROLLBACK');
    throw error;
  } finally { claimClient.release(); }
  if (!claim) return { processed: false, reason: 'OUTBOX_EMPTY' };
  const outbox = claim.outbox;
  const releaseToPending = async (code) => {
    const client = await pool.connect();
    try { return await savePolicyResult(client, claim, temporaryReason(code)); }
    finally { client.release(); }
  };
  const reject = async (code) => {
    const client = await pool.connect();
    try { return await savePolicyResult(client, claim, rejectedReason(code)); }
    finally { client.release(); }
  };

  const contractAddress = env.ARC_SETTLEMENT_CONTRACT_ADDRESS;
  if (!/^0x[0-9a-fA-F]{40}$/.test(contractAddress || '')) {
    await releaseToPending('SETTLEMENT_CONTRACT_NOT_CONFIGURED');
    return { processed: true, status: 'policy_pending', reason: 'SETTLEMENT_CONTRACT_NOT_CONFIGURED' };
  }
  const client = await pool.connect();
  try {
    const configResult = await client.query(`SELECT policy.per_action_limit_base_units::text AS per_action_limit,
        policy.daily_limit_base_units::text AS daily_limit,policy.settlement_basis_points,
        policy.allowed_action_families,policy.allowed_contracts,policy.emergency_paused,policy.policy_version,
        wallet.address AS from_address,wallet.provider AS signer_provider
      FROM arc_spending_policies policy JOIN arc_agent_wallets wallet
        ON wallet.world_id=policy.world_id AND wallet.agent_id=policy.agent_id AND wallet.chain_id=policy.chain_id
      WHERE policy.world_id=$1 AND policy.agent_id=$2 AND policy.chain_id=$3
        AND wallet.status='active'`, [outbox.world_id, outbox.from_agent_id, ARC_MAINNET_CHAIN_ID]);
    const recipient = await client.query(`SELECT address FROM arc_agent_wallets
      WHERE world_id=$1 AND agent_id=$2 AND chain_id=$3 AND status='active'`,
    [outbox.world_id, outbox.to_agent_id, ARC_MAINNET_CHAIN_ID]);
    if (!configResult.rowCount || !recipient.rowCount) {
      await releaseToPending(!configResult.rowCount ? 'PAYER_WALLET_OR_POLICY_NOT_CONFIGURED' : 'RECIPIENT_WALLET_NOT_CONFIGURED');
      return { processed: true, status: 'policy_pending', reason: 'WALLET_OR_POLICY_NOT_CONFIGURED' };
    }
    const policy = configResult.rows[0];
    const recipientAddress = recipient.rows[0].address;
    if (policy.emergency_paused) return { processed: true, ...(await reject('OFFCHAIN_POLICY_PAUSED')) };
    if (!policy.allowed_action_families.includes(outbox.action_family)) return { processed: true, ...(await reject('OFFCHAIN_ACTION_FAMILY_NOT_ALLOWED')) };
    if (!policy.allowed_contracts.some((address) => address.toLowerCase() === contractAddress.toLowerCase())) {
      return { processed: true, ...(await reject('OFFCHAIN_CONTRACT_NOT_ALLOWED')) };
    }
    if (policy.signer_provider !== signer.providerName) {
      await releaseToPending('SIGNER_PROVIDER_DOES_NOT_MATCH_WALLET');
      return { processed: true, status: 'policy_pending', reason: 'SIGNER_PROVIDER_DOES_NOT_MATCH_WALLET' };
    }
    const signerAddress = await signer.getAddressForResident(outbox.from_agent_id);
    if (signerAddress.toLowerCase() !== policy.from_address.toLowerCase()) {
      return { processed: true, ...(await reject('SIGNER_ADDRESS_DOES_NOT_MATCH_MAPPED_WALLET')) };
    }
    const spent = await client.query(`SELECT COALESCE(sum(amount_base_units),0)::text AS amount
      FROM arc_settlement_outbox WHERE world_id=$1 AND from_agent_id=$2 AND chain_id=$3
        AND created_at >= date_trunc('day',now()) AND status IN ('prepared','submitting','submission_unknown','submitted','final')`,
    [outbox.world_id, outbox.from_agent_id, ARC_MAINNET_CHAIN_ID]);
    const policyDecision = evaluateArcOffchainSettlementPolicy({ simulatedAmountUsdc: String(outbox.simulated_amount_usdc),
      basisPoints: Number(policy.settlement_basis_points), perActionLimitBaseUnits: policy.per_action_limit,
      dailyLimitBaseUnits: policy.daily_limit, spentTodayBaseUnits: spent.rows[0].amount });
    if (!policyDecision.allowed) return { processed: true, ...(await reject(policyDecision.reason)) };

    const tokenVerification = await verifyArcNativeUsdcContract(rpcClient);
    if (!tokenVerification.verified) {
      await releaseToPending(tokenVerification.reason);
      return { processed: true, status: 'policy_pending', reason: tokenVerification.reason };
    }
    const onchainPolicy = await readArcOnchainSettlementPolicy(rpcClient, { contractAddress,
      walletAddress: signerAddress, worldId: outbox.world_id,
      actionFamily: outbox.action_family, worldActionId: outbox.world_action_id });
    if (!onchainPolicy.available) {
      await releaseToPending(onchainPolicy.reason);
      return { processed: true, status: 'policy_pending', reason: onchainPolicy.reason };
    }
    if (!onchainPolicy.initialized) return { processed: true, ...(await reject('ONCHAIN_POLICY_MISSING')) };
    if (onchainPolicy.paused) return { processed: true, ...(await reject('ONCHAIN_POLICY_PAUSED')) };
    if (!onchainPolicy.actionFamilyAllowed) return { processed: true, ...(await reject('ONCHAIN_ACTION_FAMILY_NOT_ALLOWED')) };
    if (onchainPolicy.completed) return { processed: true, ...(await reject('ONCHAIN_ACTION_ALREADY_COMPLETED')) };
    if (policyDecision.amountBaseUnits > onchainPolicy.perActionLimitBaseUnits) {
      return { processed: true, ...(await reject('ONCHAIN_PER_ACTION_LIMIT_EXCEEDED')) };
    }
    if (onchainPolicy.spentTodayBaseUnits + policyDecision.amountBaseUnits > onchainPolicy.dailyLimitBaseUnits) {
      return { processed: true, ...(await reject('ONCHAIN_DAILY_LIMIT_EXCEEDED')) };
    }
    const auth = await readWalletSettlementAuthorization(rpcClient, { tokenAddress: ARC_MAINNET_USDC_ADDRESS,
      walletAddress: signerAddress, contractAddress });
    if (auth.allowanceBaseUnits < policyDecision.amountBaseUnits) {
      await releaseToPending('USDC_ALLOWANCE_NOT_APPROVED');
      return { processed: true, status: 'policy_pending', reason: 'USDC_ALLOWANCE_NOT_APPROVED' };
    }
    const balanceTokenUnits18 = policyDecision.amountBaseUnits * 10n ** 12n;
    const callData = ARC_SETTLEMENT_INTERFACE.encodeFunctionData('settle', [arcWorldActionHash(outbox.world_action_id),
      recipientAddress, policyDecision.amountBaseUnits, id(outbox.action_family), outbox.reason_hash,
      BigInt(outbox.created_world_minute)]);
    let reservation;
    try {
      reservation = await reserveArcNonce(pool, { chainId: ARC_MAINNET_CHAIN_ID,
        signerAddress, outboxId: outbox.id, pendingNonce: auth.pendingNonce,
        startBlock: BigInt(await rpcClient.getBlockNumber()) });
    } catch (error) {
      if (error?.code === 'ARC_NONCE_RECONCILIATION_REQUIRED') {
        await releaseToPending(error.code);
        return { processed: true, status: 'policy_pending', reason: error.code };
      }
      throw error;
    }
    const transaction = await buildVerifiedArcTransaction({ config, rpcClient,
      transaction: { to: contractAddress, value: 0n, data: callData,
        from: signerAddress, nonce: reservation.nonce } });
    const estimatedGas = typeof rpcClient.estimateGas === 'function'
      ? BigInt(await rpcClient.estimateGas({ ...transaction, from: signerAddress })) : null;
    if (estimatedGas === null || estimatedGas <= 0n) {
      await releaseToPending('MAINNET_GAS_ESTIMATE_UNAVAILABLE');
      return { processed: true, status: 'policy_pending', reason: 'MAINNET_GAS_ESTIMATE_UNAVAILABLE' };
    }
    const gasLimit = (estimatedGas * 120n + 99n) / 100n;
    const requiredBalance18 = balanceTokenUnits18 + gasLimit * BigInt(transaction.maxFeePerGas);
    if (BigInt(auth.nativeBalanceWei) < requiredBalance18) {
      await releaseToPending('INSUFFICIENT_SHARED_USDC_FOR_TRANSFER_AND_GAS');
      return { processed: true, status: 'policy_pending', reason: 'INSUFFICIENT_SHARED_USDC_FOR_TRANSFER_AND_GAS' };
    }
    const saveClient = await pool.connect();
    let prepared;
    let budgetExceeded = false;
    try {
      await saveClient.query('BEGIN');
      try {
        await reserveArcMainnetPilotCost(saveClient, { operationType: 'settlement', operationId: String(outbox.id),
          worldId: outbox.world_id, transferUsdcBaseUnits: policyDecision.amountBaseUnits,
          gasLimit, maxFeePerGas: transaction.maxFeePerGas });
      } catch (error) {
        if (error?.code !== 'ARC_MAINNET_PILOT_COST_CAP_EXCEEDED') throw error;
        budgetExceeded = true;
        prepared = await savePolicyResult(saveClient, claim, rejectedReason(error.code));
      }
      if (!budgetExceeded) {
      prepared = await savePolicyResult(saveClient, claim, { status: 'prepared', code: 'ONCHAIN_POLICY_APPROVED' }, {
        contractAddress, fromAddress: signerAddress, toAddress: recipientAddress,
        amountBaseUnits: policyDecision.amountBaseUnits, policyVersion: policy.policy_version,
        nonce: reservation.nonce, startBlock: reservation.startBlock,
        metadata: { gasLimit: gasLimit.toString(), maxFeePerGas: transaction.maxFeePerGas.toString(),
          maxPriorityFeePerGas: transaction.maxPriorityFeePerGas.toString(), pendingNonce: auth.pendingNonce.toString(),
          nativeBalanceWei: auth.nativeBalanceWei.toString(), erc20BalanceBaseUnits: auth.tokenBalanceBaseUnits.toString(),
          sharedUnderlyingUsdcBalance: true }
      });
      }
      await saveClient.query('COMMIT');
    } catch (error) {
      await saveClient.query('ROLLBACK');
      const releaseClient = await pool.connect();
      try {
        await releaseClient.query('BEGIN');
        await savePolicyResult(releaseClient, claim, temporaryReason('PILOT_BUDGET_RESERVATION_FAILED'));
        await releaseClient.query('COMMIT');
      } catch (releaseError) {
        await releaseClient.query('ROLLBACK');
        throw releaseError;
      } finally { releaseClient.release(); }
      return { processed: true, status: 'policy_pending', reason: error.code || 'PILOT_BUDGET_RESERVATION_FAILED' };
    } finally { saveClient.release(); }
    if (budgetExceeded) return { processed: true, status: prepared.status, reason: 'ARC_MAINNET_PILOT_COST_CAP_EXCEEDED' };
    const submission = await submitArcSettlement({ client: pool, settlementId: prepared.id, signer, rpcClient,
      residentId: outbox.from_agent_id, buildTransaction: async (settlement) => ({
        to: contractAddress, from: signerAddress, nonce: BigInt(settlement.nonce), gasLimit, value: 0n,
        data: ARC_SETTLEMENT_INTERFACE.encodeFunctionData('settle', [arcWorldActionHash(settlement.world_action_id),
          settlement.to_address, BigInt(settlement.amount_base_units), id(settlement.action_family), settlement.reason_hash,
          BigInt(settlement.created_world_minute)])
      }) });
    return { processed: true, status: submission.settlement.status, settlementId: prepared.id,
      transactionHash: submission.transactionHash || null };
  } finally { client.release(); }
}

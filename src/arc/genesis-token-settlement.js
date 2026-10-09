import { getAddress, id, Interface, keccak256 } from 'ethers';
import { ARC_MAINNET_CHAIN_ID, assertArcChainId } from './config.js';

export const ARC_GENESIS_TOKEN_SETTLEMENT_INTERFACE = new Interface([
  'function worldId() view returns (bytes16)',
  'function token() view returns (address)',
  'function completedActions(bytes32) view returns (bool)',
  'function spendingPolicies(address) view returns (uint128 perActionLimit,uint128 dailyLimit,uint128 spentToday,uint64 dayIndex,bool initialized,bool paused)',
  'function allowedActionFamilies(address,bytes32) view returns (bool)',
  'function setSpendingPolicy(uint128 perActionLimit,uint128 dailyLimit,bytes32[] actionFamilies)',
  'function settle(bytes32 worldActionId,address recipient,uint256 amountRaw,bytes32 actionFamilyHash,bytes32 reasonHash,uint64 createdWorldMinute)',
  'event TokenSettlement(bytes16 indexed worldId,address indexed token,bytes32 indexed worldActionId,address payer,address recipient,uint256 amountRaw,bytes32 actionFamilyHash,bytes32 reasonHash,uint64 createdWorldMinute)'
]);

export const ARC_GENESIS_TOKEN_ERC20_INTERFACE = new Interface([
  'function allowance(address owner,address spender) view returns (uint256)',
  'function approve(address spender,uint256 amount) returns (bool)',
  'function balanceOf(address owner) view returns (uint256)'
]);

function coded(code) { return Object.assign(new Error(code), { code }); }

export function genesisSettlementWorldId(worldId) {
  const hex = String(worldId).replaceAll('-', '');
  if (!/^[0-9a-f]{32}$/i.test(hex)) throw coded('ARC_GENESIS_SETTLEMENT_WORLD_ID_INVALID');
  return `0x${hex.toLowerCase()}`;
}

export function buildGenesisTokenSettlementCall(settlement) {
  if (!settlement || !/^0x[0-9a-fA-F]{40}$/.test(settlement.to_address || '')
      || !/^0x[0-9a-fA-F]{64}$/.test(settlement.reason_hash || '')) throw coded('ARC_GENESIS_SETTLEMENT_ROW_INVALID');
  const minute = BigInt(settlement.created_world_minute);
  const amount = BigInt(settlement.amount_raw);
  if (minute <= 0n || amount <= 0n || amount > (1n << 128n) - 1n) throw coded('ARC_GENESIS_SETTLEMENT_ROW_INVALID');
  return ARC_GENESIS_TOKEN_SETTLEMENT_INTERFACE.encodeFunctionData('settle', [
    id(`${settlement.world_id}:${settlement.world_action_id}`), getAddress(settlement.to_address), amount,
    id(String(settlement.action_family)), settlement.reason_hash, minute
  ]).toLowerCase();
}

export function buildGenesisTokenApprovalCall(settlementContract, amountRaw = '0') {
  if (!/^0x[0-9a-fA-F]{40}$/.test(settlementContract || '')) throw coded('ARC_GENESIS_SETTLEMENT_CONTRACT_INVALID');
  const amount = BigInt(amountRaw);
  if (amount < 0n || amount > (1n << 256n) - 1n) throw coded('ARC_GENESIS_TOKEN_APPROVAL_AMOUNT_INVALID');
  return ARC_GENESIS_TOKEN_ERC20_INTERFACE.encodeFunctionData('approve', [getAddress(settlementContract), amount]).toLowerCase();
}

export function buildGenesisTokenSpendingPolicyCall(settlementContract, { perActionLimitRaw,
  dailyLimitRaw, actionFamilies }) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(settlementContract || '') || !Array.isArray(actionFamilies)
      || actionFamilies.length > 16) throw coded('ARC_GENESIS_TOKEN_POLICY_INVALID');
  const perAction = BigInt(perActionLimitRaw);
  const daily = BigInt(dailyLimitRaw);
  const families = actionFamilies.map((family) => id(String(family)));
  if (perAction < 0n || daily < perAction || daily > (1n << 128n) - 1n
      || (perAction === 0n) !== (families.length === 0)
      || new Set(families).size !== families.length) throw coded('ARC_GENESIS_TOKEN_POLICY_INVALID');
  return ARC_GENESIS_TOKEN_SETTLEMENT_INTERFACE.encodeFunctionData('setSpendingPolicy',
    [perAction, daily, families]).toLowerCase();
}

/**
 * Construct unsigned calls for the Agent wallet to review and sign itself.
 * This helper contains no signer, RPC writer, relay, or submission path. The caller
 * must still enforce the separately approved Mainnet authorization gate.
 */
export function buildGenesisTokenSettlementWalletAuthorization(settlement, { tokenAddress,
  settlementContract, approvalRaw = null, spendingPolicy, walletAccountType = 'eoa' }) {
  const supportedWalletTypes = new Set(['eoa','sca','msca']);
  if (!settlement || !/^0x[0-9a-fA-F]{40}$/.test(settlement.from_address || '')
      || !/^0x[0-9a-fA-F]{40}$/.test(tokenAddress || '')
      || !/^0x[0-9a-fA-F]{40}$/.test(settlementContract || '')
      || settlement.from_address.toLowerCase() === settlement.to_address?.toLowerCase()
      || !supportedWalletTypes.has(walletAccountType)) {
    throw coded('ARC_GENESIS_SETTLEMENT_AUTHORIZATION_INVALID');
  }
  const amountRaw = BigInt(settlement.amount_raw);
  const approvedRaw = approvalRaw === null ? amountRaw : BigInt(approvalRaw);
  if (approvedRaw < amountRaw || approvedRaw > (1n << 256n) - 1n) {
    throw coded('ARC_GENESIS_TOKEN_ALLOWANCE_TOO_LOW');
  }
  if (!spendingPolicy || !Array.isArray(spendingPolicy.actionFamilies)
      || !spendingPolicy.actionFamilies.includes(String(settlement.action_family))) {
    throw coded('ARC_GENESIS_TOKEN_EXPLICIT_SPENDING_POLICY_REQUIRED');
  }
  let perActionLimitRaw;
  let dailyLimitRaw;
  try {
    perActionLimitRaw = BigInt(spendingPolicy.perActionLimitRaw);
    dailyLimitRaw = BigInt(spendingPolicy.dailyLimitRaw);
  } catch {
    throw coded('ARC_GENESIS_TOKEN_POLICY_INVALID');
  }
  if (perActionLimitRaw < amountRaw || dailyLimitRaw < perActionLimitRaw) {
    throw coded('ARC_GENESIS_TOKEN_POLICY_DOES_NOT_COVER_SETTLEMENT');
  }
  const policyCall = buildGenesisTokenSpendingPolicyCall(settlementContract, spendingPolicy);
  return {
    chainId: ARC_MAINNET_CHAIN_ID,
    payer: getAddress(settlement.from_address),
    payerWalletAccountType: walletAccountType,
    recipient: getAddress(settlement.to_address),
    authorization: 'payer_agent_wallet_signature',
    custody: 'non_custodial',
    policyActionFamily: String(settlement.action_family),
    policyActionFamilyHash: id(String(settlement.action_family)).toLowerCase(),
    calls: [
      { purpose: 'set_agent_chosen_spending_policy', from: getAddress(settlement.from_address),
        to: getAddress(settlementContract), value: '0', data: policyCall },
      { purpose: 'approve_exact_token_allowance', from: getAddress(settlement.from_address),
        to: getAddress(tokenAddress), value: '0',
        data: buildGenesisTokenApprovalCall(settlementContract, amountRaw.toString()) },
      { purpose: 'settle_directly_from_agent_wallet', from: getAddress(settlement.from_address),
        to: getAddress(settlementContract), value: '0', data: buildGenesisTokenSettlementCall(settlement) }
    ],
    spendingPolicy: { perActionLimitRaw: perActionLimitRaw.toString(), dailyLimitRaw: dailyLimitRaw.toString(),
      actionFamilies: [...spendingPolicy.actionFamilies] },
    executionSemantics: walletAccountType === 'eoa'
      ? 'payer_eoa_signs_calls_in_order; stop_on_first_failure'
      : 'payer_smart_wallet_authorizes_calls_in_order; stop_on_first_failure',
    transactionSenderMustEqualPayer: walletAccountType === 'eoa',
    settlementContractEnforcesPayerAsMsgSender: true,
    settlementContractNeverCustodiesToken: true
  };
}

export function auditGenesisTokenSettlementReceipt(settlement, receipt, transaction) {
  const transactionHash = String(receipt?.transactionHash || receipt?.hash || '').toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(transactionHash)
      || (settlement.transaction_hash && transactionHash !== settlement.transaction_hash.toLowerCase())) {
    return { consistent: false, finding: 'TRANSACTION_HASH_MISMATCH' };
  }
  const walletAccountType = settlement.from_wallet_account_type || settlement.walletAccountType
    || settlement.metadata?.payerWalletAccountType || 'eoa';
  if (!settlement.settlement_contract || !transaction
      || !['eoa','sca','msca'].includes(walletAccountType)) {
    return { consistent: false, finding: 'WALLET_AUTHORIZATION_MISMATCH' };
  }
  if (walletAccountType === 'eoa'
      && (String(transaction.to || '').toLowerCase() !== settlement.settlement_contract.toLowerCase()
        || String(transaction.from || '').toLowerCase() !== settlement.from_address.toLowerCase()
        || String(transaction.data || transaction.input || '').toLowerCase() !== buildGenesisTokenSettlementCall(settlement))) {
    return { consistent: false, finding: 'WALLET_AUTHORIZATION_MISMATCH' };
  }
  if (transaction.chainId !== undefined && transaction.chainId !== null) {
    try { assertArcChainId(transaction.chainId); }
    catch { return { consistent: false, finding: 'TRANSACTION_CHAIN_ID_MISMATCH' }; }
  }
  if (!(receipt.status === 1 || receipt.status === '0x1' || receipt.status === '0x01')) {
    return { consistent: false, finding: 'ARC_TRANSACTION_REVERTED', reverted: true, transactionHash };
  }
  const expectedWorldId = genesisSettlementWorldId(settlement.world_id).toLowerCase();
  const expectedActionId = id(`${settlement.world_id}:${settlement.world_action_id}`).toLowerCase();
  const expectedFamily = id(String(settlement.action_family)).toLowerCase();
  const expectedAmount = BigInt(settlement.amount_raw);
  const expectedMinute = BigInt(settlement.created_world_minute);
  let match = null;
  for (const log of receipt.logs || []) {
    if (String(log.address || '').toLowerCase() !== String(settlement.settlement_contract).toLowerCase()) continue;
    try {
      const event = ARC_GENESIS_TOKEN_SETTLEMENT_INTERFACE.parseLog(log);
      if (event.name === 'TokenSettlement'
          && String(event.args.worldId).toLowerCase() === expectedWorldId
          && String(event.args.token).toLowerCase() === String(settlement.token_address || settlement.tokenAddress).toLowerCase()
          && String(event.args.worldActionId).toLowerCase() === expectedActionId
          && String(event.args.payer).toLowerCase() === settlement.from_address.toLowerCase()
          && String(event.args.recipient).toLowerCase() === settlement.to_address.toLowerCase()
          && BigInt(event.args.amountRaw) === expectedAmount
          && String(event.args.actionFamilyHash).toLowerCase() === expectedFamily
          && String(event.args.reasonHash).toLowerCase() === settlement.reason_hash.toLowerCase()
          && BigInt(event.args.createdWorldMinute) === expectedMinute) { match = { event, log }; break; }
    } catch { /* unrelated log */ }
  }
  if (!match) return { consistent: false, finding: 'SETTLEMENT_EVENT_MISMATCH' };
  return { consistent: true, finding: null, blockNumber: BigInt(receipt.blockNumber).toString(),
    logIndex: Number(BigInt(match.log.logIndex)), transactionHash };
}

export function verifyGenesisSettlementContractState({ actualWorldId, expectedWorldId,
  actualTokenAddress, expectedTokenAddress, chainId }) {
  assertArcChainId(chainId, { name: 'mainnet', chainId: ARC_MAINNET_CHAIN_ID });
  if (String(actualWorldId).toLowerCase() !== genesisSettlementWorldId(expectedWorldId).toLowerCase()) {
    throw coded('ARC_GENESIS_SETTLEMENT_WORLD_MISMATCH');
  }
  if (getAddress(actualTokenAddress) !== getAddress(expectedTokenAddress)) throw coded('ARC_GENESIS_SETTLEMENT_TOKEN_MISMATCH');
  return true;
}

export function genesisSettlementRuntimeCodeHash(bytecode) {
  if (typeof bytecode !== 'string' || !/^0x[0-9a-fA-F]+$/.test(bytecode)) throw coded('ARC_GENESIS_SETTLEMENT_RUNTIME_CODE_INVALID');
  return keccak256(bytecode).toLowerCase();
}

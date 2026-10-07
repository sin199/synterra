import { ARC_MAINNET_CHAIN_ID, ARC_MAX_FEE_PER_GAS_RECOMMENDATION, assertArcChainId, assertArcWriteAllowed } from './config.js';

export function buildArcEip1559FeeFields({ baseFeePerGas, maxPriorityFeePerGas = 0n,
  maxFeePerGas, recommendedMinimum = ARC_MAX_FEE_PER_GAS_RECOMMENDATION }) {
  const baseFee = BigInt(baseFeePerGas);
  const priorityFee = BigInt(maxPriorityFeePerGas);
  const minimum = BigInt(recommendedMinimum);
  if (baseFee < 0n || priorityFee < 0n || minimum <= 0n) {
    throw new RangeError('Arc fee inputs must be non-negative and the floor positive.');
  }
  const requiredMaximum = baseFee + priorityFee;
  const maximumFee = maxFeePerGas === undefined
    ? (requiredMaximum > minimum ? requiredMaximum : minimum) : BigInt(maxFeePerGas);
  if (maximumFee < minimum) {
    const error = new Error('Arc maxFeePerGas is below the conservative 20 Gwei recommendation.');
    error.code = 'ARC_MAX_FEE_BELOW_RECOMMENDATION';
    throw error;
  }
  if (maximumFee < requiredMaximum) {
    const error = new Error('Arc maxFeePerGas is below the latest base fee plus priority fee.');
    error.code = 'ARC_MAX_FEE_BELOW_CURRENT_REQUIREMENT';
    throw error;
  }
  if (priorityFee >= maximumFee) throw new RangeError('maxPriorityFeePerGas must be below maxFeePerGas.');
  return { maxFeePerGas: maximumFee, maxPriorityFeePerGas: priorityFee };
}

function validateTransactionEnvelope(config, transaction) {
  if (config?.name !== 'mainnet' || Number(config.chainId) !== ARC_MAINNET_CHAIN_ID
      || Number(transaction?.chainId) !== ARC_MAINNET_CHAIN_ID) {
    const error = new Error('Arc signer requires the verified Arc Mainnet transaction chain ID.');
    error.code = 'ARC_CHAIN_ID_MISMATCH';
    throw error;
  }
  if (typeof transaction.to !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(transaction.to)) {
    throw new TypeError('Arc signer requires an explicit EVM transaction target.');
  }
  if (transaction.value !== undefined && BigInt(transaction.value) !== 0n) {
    const error = new Error('Synterra Arc contract calls must not send native value.');
    error.code = 'ARC_NATIVE_VALUE_FORBIDDEN';
    throw error;
  }
  if (transaction.gasPrice !== undefined || transaction.maxFeePerGas === undefined
      || transaction.maxPriorityFeePerGas === undefined) {
    const error = new Error('Arc transactions must use explicit EIP-1559 fee fields.');
    error.code = 'ARC_EIP1559_FEES_REQUIRED';
    throw error;
  }
  buildArcEip1559FeeFields({ baseFeePerGas: 0n, maxFeePerGas: transaction.maxFeePerGas,
    maxPriorityFeePerGas: transaction.maxPriorityFeePerGas });
}

export class ArcSigner {
  constructor({ config, providerName }) {
    if (config?.name !== 'mainnet' || config?.chainId !== ARC_MAINNET_CHAIN_ID) {
      const error = new Error('Arc Mainnet signer configuration is required.');
      error.code = 'ARC_MAINNET_ONLY';
      throw error;
    }
    this.config = config;
    this.providerName = String(providerName || 'external_signer').slice(0, 64);
  }

  async getAddressForResident(_residentId) {
    throw new Error('ArcSigner must implement getAddressForResident().');
  }

  async sendTransaction(_residentId, _transaction) {
    throw new Error('ArcSigner must implement sendTransaction().');
  }
}

// Infrastructure transactions (factory calls, checkpoints and provenance)
// use a separate sender identity from resident wallets and Agent issuers.
export class ArcInfrastructureSigner {
  constructor({ config, providerName }) {
    if (config?.name !== 'mainnet' || config?.chainId !== ARC_MAINNET_CHAIN_ID) {
      const error = new Error('Arc Mainnet infrastructure signer configuration is required.');
      error.code = 'ARC_MAINNET_ONLY';
      throw error;
    }
    this.config = config;
    this.providerName = String(providerName || 'external_signer').slice(0, 64);
  }

  async getAddress() { throw new Error('ArcInfrastructureSigner must implement getAddress().'); }
  async sendTransaction(_transaction) { throw new Error('ArcInfrastructureSigner must implement sendTransaction().'); }
}

class CallbackArcInfrastructureSigner extends ArcInfrastructureSigner {
  #getAddress;
  #submitTransaction;

  constructor({ config, getAddress, submitTransaction, providerName }) {
    super({ config, providerName });
    if (typeof getAddress !== 'function' || typeof submitTransaction !== 'function') {
      throw new TypeError('Infrastructure signer address and transaction callbacks are required.');
    }
    this.#getAddress = getAddress;
    this.#submitTransaction = submitTransaction;
  }

  async getAddress() {
    const address = await this.#getAddress();
    if (typeof address !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
      const error = new Error('Infrastructure signer returned an invalid public address.');
      error.code = 'ARC_INFRASTRUCTURE_ADDRESS_INVALID';
      throw error;
    }
    return address;
  }

  async sendTransaction(transaction) {
    assertArcWriteAllowed(this.config, { operation: 'infrastructure transaction submission' });
    validateTransactionEnvelope(this.config, transaction);
    const response = await this.#submitTransaction(Object.freeze({ ...transaction }));
    if (!response || typeof response.hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(response.hash)) {
      const error = new Error('Infrastructure signer did not return a valid transaction hash.');
      error.code = 'ARC_SIGNER_TRANSACTION_HASH_MISSING';
      throw error;
    }
    return { hash: response.hash, providerName: this.providerName };
  }
}

export class ExternalKmsArcInfrastructureSigner extends CallbackArcInfrastructureSigner {
  constructor({ config, getAddress, submitTransaction }) {
    super({ config, getAddress, submitTransaction, providerName: 'external_kms' });
  }
}

export class ManagedWalletArcInfrastructureSigner extends CallbackArcInfrastructureSigner {
  constructor({ config, getAddress, submitTransaction, providerName = 'managed_wallet' }) {
    super({ config, getAddress, submitTransaction, providerName });
  }
}

export function assertArcInfrastructureSigner(signer, config) {
  if (!(signer instanceof ArcInfrastructureSigner) || signer.config !== config
      || typeof signer.getAddress !== 'function' || typeof signer.sendTransaction !== 'function') {
    const error = new TypeError('Infrastructure Arc execution requires a configured infrastructure signer.');
    error.code = 'ARC_INFRASTRUCTURE_SIGNER_INTERFACE_REQUIRED';
    throw error;
  }
  return signer;
}

class CallbackArcSigner extends ArcSigner {
  #addressForResident;
  #submitTransaction;

  constructor({ config, addressForResident, submitTransaction, providerName }) {
    super({ config, providerName });
    if (typeof addressForResident !== 'function' || typeof submitTransaction !== 'function') {
      throw new TypeError('Arc signer address and transaction callbacks are required.');
    }
    this.#addressForResident = addressForResident;
    this.#submitTransaction = submitTransaction;
  }

  async getAddressForResident(residentId) {
    const address = await this.#addressForResident(residentId);
    if (typeof address !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
      const error = new Error('Arc signer returned an invalid public address.');
      error.code = 'ARC_WALLET_ADDRESS_INVALID';
      throw error;
    }
    return address;
  }

  async sendTransaction(residentId, transaction) {
    assertArcWriteAllowed(this.config, { operation: 'transaction submission' });
    validateTransactionEnvelope(this.config, transaction);
    const response = await this.#submitTransaction(residentId, Object.freeze({ ...transaction }));
    if (!response || typeof response.hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(response.hash)) {
      const error = new Error('Arc signer did not return a valid transaction hash.');
      error.code = 'ARC_SIGNER_TRANSACTION_HASH_MISSING';
      throw error;
    }
    return { hash: response.hash, providerName: this.providerName };
  }
}

export class ExternalKmsArcSigner extends CallbackArcSigner {
  constructor({ config, addressForResident, submitTransaction }) {
    super({ config, addressForResident, submitTransaction, providerName: 'external_kms' });
  }
}

export class ManagedWalletArcSigner extends CallbackArcSigner {
  constructor({ config, addressForResident, submitTransaction, providerName = 'managed_wallet' }) {
    super({ config, addressForResident, submitTransaction, providerName });
  }
}

export function assertArcSigner(signer, config) {
  if (!(signer instanceof ArcSigner) || signer.config !== config
      || typeof signer.getAddressForResident !== 'function'
      || typeof signer.sendTransaction !== 'function') {
    const error = new TypeError('Production Arc execution requires a configured ArcSigner implementation.');
    error.code = 'ARC_SIGNER_INTERFACE_REQUIRED';
    throw error;
  }
  return signer;
}

export async function buildVerifiedArcTransaction({ transaction, config, rpcClient, expectedTo = null }) {
  assertArcWriteAllowed(config, { operation: 'transaction submission' });
  if (!rpcClient || typeof rpcClient.getChainId !== 'function' || typeof rpcClient.getBlock !== 'function') {
    throw new TypeError('Verified Arc Mainnet RPC client is required to prepare transaction fees.');
  }
  assertArcChainId(await rpcClient.getChainId(), config);
  const block = await rpcClient.getBlock('latest', false);
  if (!block?.baseFeePerGas) {
    const error = new Error('Arc latest block did not expose the EIP-1559 base fee.');
    error.code = 'ARC_BASE_FEE_UNAVAILABLE';
    throw error;
  }
  if (expectedTo && transaction.to?.toLowerCase() !== expectedTo.toLowerCase()) {
    const error = new Error('Arc transaction target differs from the configured contract.');
    error.code = 'ARC_TRANSACTION_TARGET_MISMATCH';
    throw error;
  }
  if (transaction.gasPrice !== undefined) {
    const error = new Error('Arc transactions must use EIP-1559 fee fields.');
    error.code = 'ARC_LEGACY_GAS_PRICE_FORBIDDEN';
    throw error;
  }
  let tip = transaction.maxPriorityFeePerGas;
  if (tip === undefined && typeof rpcClient.maxPriorityFeePerGas === 'function') {
    tip = await rpcClient.maxPriorityFeePerGas();
  }
  const fees = buildArcEip1559FeeFields({ baseFeePerGas: block.baseFeePerGas,
    maxPriorityFeePerGas: tip === undefined ? 0n : tip,
    maxFeePerGas: transaction.maxFeePerGas, recommendedMinimum: config.maxFeePerGasRecommendation });
  const result = { ...transaction, ...fees, chainId: ARC_MAINNET_CHAIN_ID };
  validateTransactionEnvelope(config, result);
  return result;
}

import { ArcSigner, buildArcEip1559FeeFields } from '../../src/arc/wallet-provider.js';
import { ARC_MAINNET_CHAIN_ID, arcNetworkConfig, assertArcWriteAllowed } from '../../src/arc/config.js';

export function createIsolatedArcMainnetConfig(env = {}) {
  return Object.freeze({ ...arcNetworkConfig({ ARC_ENV: 'mainnet', ...env }), writesEnabled: true });
}

export class DeterministicFakeArcSigner extends ArcSigner {
  #addresses;
  #transactionHash;
  #submitted;

  constructor({ config, addresses, transactionHash, submitted = [], providerName = 'external_kms' }) {
    super({ config, providerName });
    if (!['external_kms','managed_wallet'].includes(providerName)) {
      throw new TypeError('Isolated fake signer must emulate a supported Arc wallet provider.');
    }
    if (!addresses || typeof addresses !== 'object') throw new TypeError('Fake signer addresses are required.');
    if (typeof transactionHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(transactionHash)) {
      throw new TypeError('Fake signer transaction hash must be a 32-byte hex value.');
    }
    this.#addresses = addresses;
    this.#transactionHash = transactionHash;
    this.#submitted = submitted;
  }

  async getAddressForResident(residentId) {
    const value = this.#addresses[residentId];
    if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(value)) {
      throw new TypeError('Isolated fake signer has no address for this resident.');
    }
    return value;
  }

  async sendTransaction(residentId, transaction) {
    assertArcWriteAllowed(this.config, { operation: 'isolated fake transaction submission' });
    if (Number(transaction?.chainId) !== ARC_MAINNET_CHAIN_ID || typeof transaction.to !== 'string'
        || !/^0x[0-9a-fA-F]{40}$/.test(transaction.to) || BigInt(transaction.value ?? 0) !== 0n) {
      throw new TypeError('Isolated fake signer only accepts a zero-value Arc Mainnet contract call.');
    }
    buildArcEip1559FeeFields({ baseFeePerGas: 0n,
      maxFeePerGas: transaction.maxFeePerGas, maxPriorityFeePerGas: transaction.maxPriorityFeePerGas,
      recommendedMinimum: this.config.maxFeePerGasRecommendation });
    this.#submitted.push(structuredClone(transaction));
    return { hash: this.#transactionHash, providerName: this.providerName };
  }
}

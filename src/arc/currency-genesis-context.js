import { arcNetworkConfig } from './config.js';

// Infrastructure facts are shared by cognition providers, never token design defaults.
export function currencyGenesisInfrastructureFacts({ requirement, config = arcNetworkConfig() }) {
  const network = `Arc ${config.name[0].toUpperCase()}${config.name.slice(1)}`;
  return Object.freeze({
    executionNetwork: network,
    chainId: config.chainId,
    tokenCreationTarget: network,
    networkRole: 'the blockchain execution environment for this pilot',
    mainnetWriteGate: config.writesEnabled,
    // Reconciliation atomically records both fields; prepared/submitted is not creation.
    onchainStatus: requirement?.status === 'SATISFIED' && requirement.satisfied_token_id
      ? 'created' : 'not yet created'
  });
}

import { arcNetworkConfig } from './config.js';
import { AGENT_TOKEN_HUMAN_SUPPLY, AGENT_TOKEN_PILOT_GENERATION } from './token-issuance.js';

// Infrastructure facts are shared by cognition providers, never token design defaults.
export function currencyGenesisInfrastructureFacts({ requirement, issuerAssignment = null, config = arcNetworkConfig() }) {
  const network = `Arc ${config.name[0].toUpperCase()}${config.name.slice(1)}`;
  return Object.freeze({
    currencyRequirement: 'CURRENCY_GENESIS_REQUIRED',
    requirementStatus: requirement?.status || null,
    currencyRequirementMandatory: requirement?.status !== 'SATISFIED',
    genesisIssuer: typeof issuerAssignment?.issuerName === 'string' ? issuerAssignment.issuerName : null,
    generation: Number.isSafeInteger(Number(issuerAssignment?.capabilityGeneration))
      ? Number(issuerAssignment.capabilityGeneration) : AGENT_TOKEN_PILOT_GENERATION,
    issuerSelectionSource: typeof issuerAssignment?.selectionSource === 'string'
      ? issuerAssignment.selectionSource : null,
    totalHumanReadableSupply: AGENT_TOKEN_HUMAN_SUPPLY,
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

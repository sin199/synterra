function pageText(value, name) {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`Official Arc documentation page ${name} is empty.`);
  return value.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

function requiredMatch(text, expression, label) {
  const match = text.match(expression);
  if (!match) {
    const error = new Error(`Official Arc documentation no longer contains the expected ${label} reference.`);
    error.code = 'ARC_OFFICIAL_DOCUMENTATION_CLAIM_NOT_FOUND';
    error.claim = label;
    throw error;
  }
  return match;
}

export function extractArcOfficialClaims(pages) {
  const rpc = pageText(pages.rpcEndpoints, 'rpcEndpoints');
  const contracts = pageText(pages.contractAddresses, 'contractAddresses');
  const evm = pageText(pages.evmDifferences, 'evmDifferences');
  const gas = pageText(pages.gasAndFees, 'gasAndFees');
  const events = pageText(pages.usdcSystemEvents, 'usdcSystemEvents');
  const finality = pageText(pages.deterministicFinality, 'deterministicFinality');
  const circle = pageText(pages.circleUsdcAddresses, 'circleUsdcAddresses');

  const mainnetUsdc = requiredMatch(contracts,
    /Mainnet\s+Testnet\s+Contract Address Notes\s+USDC\s+(0x[\da-f]{40})\s+Optional ERC-20 interface/i,
    'Arc Mainnet USDC address')[1];
  const circleUsdc = requiredMatch(circle, /\bArc\s+(0x[\da-f]{40})\b/i,
    'Circle Arc USDC address')[1];
  const erc8004Header = /ERC-8004\s+Mainnet\s+Testnet\s+Contract Address Notes/i.exec(contracts);
  if (!erc8004Header) {
    const error = new Error('Official Arc documentation is missing the ERC-8004 network address table.');
    error.code = 'ARC_OFFICIAL_DOCUMENTATION_CLAIM_NOT_FOUND';
    error.claim = 'ERC-8004 mainnet addresses';
    throw error;
  }
  const firstTableHeading = contracts.indexOf('Contract Address Notes', erc8004Header.index);
  const secondTableHeading = contracts.indexOf('Contract Address Notes', firstTableHeading + 1);
  if (firstTableHeading < 0 || secondTableHeading < 0) {
    const error = new Error('Official Arc documentation no longer separates ERC-8004 Mainnet and Testnet registries.');
    error.code = 'ARC_OFFICIAL_DOCUMENTATION_CLAIM_NOT_FOUND';
    error.claim = 'ERC-8004 mainnet addresses';
    throw error;
  }
  const erc8004MainnetRows = contracts.slice(firstTableHeading + 'Contract Address Notes'.length, secondTableHeading);
  const erc8004 = Object.fromEntries(['IdentityRegistry', 'ReputationRegistry', 'ValidationRegistry'].map((name) => [
    name, requiredMatch(erc8004MainnetRows, new RegExp(`${name}\\s+(0x[\\da-f]{40})`, 'i'), `ERC-8004 ${name} Mainnet address`)[1]
  ]));

  const gasRecommendation = requiredMatch(gas,
    /Set maxFeePerGas to at least\s+([\d,]+)\s*Gwei/i, 'maxFeePerGas recommendation');
  const gasParametersScopeNote = /parameters on this page reflect the current Arc Testnet configuration/i.test(gas);
  const rpcEndpoints = {
    primary: requiredMatch(rpc, /Primary \(Circle\)\s+(https:\/\/rpc\.mainnet\.arc\.io)\b/i, 'Circle Mainnet RPC')[1],
    blockdaemon: requiredMatch(rpc, /Blockdaemon\s+(https:\/\/rpc\.blockdaemon\.mainnet\.arc\.io)\b/i, 'Blockdaemon Mainnet RPC')[1],
    drpc: requiredMatch(rpc, /dRPC\s+(https:\/\/rpc\.drpc\.mainnet\.arc\.io)\b/i, 'dRPC Mainnet RPC')[1],
    quicknode: requiredMatch(rpc, /QuickNode\s+(https:\/\/rpc\.quicknode\.mainnet\.arc\.io)\b/i, 'QuickNode Mainnet RPC')[1]
  };
  const nativeAndTokenSemantics = /native interface \(18 decimals\)/i.test(evm)
    && /ERC-20 interface \(6 decimals\)/i.test(evm)
    && /share one balance/i.test(evm);
  if (!nativeAndTokenSemantics) {
    const error = new Error('Official Arc documentation no longer confirms the distinct native and ERC-20 USDC precision views.');
    error.code = 'ARC_OFFICIAL_DOCUMENTATION_CLAIM_NOT_FOUND';
    error.claim = 'native and ERC-20 USDC semantics';
    throw error;
  }
  const usdcSystemEmitter = requiredMatch(events,
    /Native USDC \(system, EIP-7708\)\s+(0x[\da-f]{40})\s+Transfer\s+18/i,
    'native USDC system event emitter')[1];
  const zeroAddressBehavior = /Transfers to the zero address are forbidden/i.test(evm)
    && /value-bearing transfer to 0x0 reverts/i.test(evm)
    && /zero-value transfer to 0x0 succeeds/i.test(evm);
  if (!zeroAddressBehavior) {
    const error = new Error('Official Arc documentation no longer confirms zero-address transfer behavior.');
    error.code = 'ARC_OFFICIAL_DOCUMENTATION_CLAIM_NOT_FOUND';
    error.claim = 'zero-address value behavior';
    throw error;
  }
  const erc8183MainnetListed = /ERC-8183\s+Mainnet\s+Testnet\s+Contract Address Notes\s+[^.]{0,240}0x[\da-f]{40}/i.test(contracts);
  const erc8183TestnetOnly = !erc8183MainnetListed
    && /Arc Testnet hosts a reference implementation of the ERC-8183 agentic commerce standard/i.test(contracts);
  const finalityClaim = requiredMatch(finality,
    /deterministic finality delivers irreversible transaction settlement in under one second/i,
    'deterministic finality statement')[0];
  const chainId = Number(requiredMatch(rpc, /Chain ID \(Mainnet\)\s+(\d+)/i, 'Arc Mainnet chain ID')[1]);

  return {
    chainId,
    rpcEndpoints,
    usdc: { arcMainnetAddress: mainnetUsdc, circleAddress: circleUsdc,
      addressesMatch: mainnetUsdc.toLowerCase() === circleUsdc.toLowerCase(),
      nativeGasDecimals: 18, erc20Decimals: 6, sharedUnderlyingBalance: true },
    maxFeePerGasRecommendation: {
      gwei: Number(gasRecommendation[1].replaceAll(',', '')),
      parametersPageHasTestnetScopeCaveat: gasParametersScopeNote,
      mainnetProtocolFloorConfirmed: false
    },
    usdcSystemEmitter,
    zeroAddressBehavior: { nonZeroValueReverts: true, zeroValueSucceeds: true },
    deterministicFinalityStatement: finalityClaim,
    erc8004MainnetAddresses: erc8004,
    erc8183: { mainnetListed: erc8183MainnetListed, testnetOnlyReferenceListed: erc8183TestnetOnly }
  };
}

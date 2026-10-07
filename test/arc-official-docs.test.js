import test from 'node:test';
import assert from 'node:assert/strict';
import { extractArcOfficialClaims } from '../src/arc/official-docs.js';

const usdc = '0x3600000000000000000000000000000000000000';
const identity = '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432';
const reputation = '0x8004BAa17C55a88189AE136b182e5fdA19dE9b63';
const validation = '0x8004Cc8439f36fd5F9F049D9fF86523Df6dAAB58';
const emitter = '0xffffFFFfFFffffffffffffffFfFFFfffFFFfFFfE';

function pages(overrides = {}) {
  return {
    rpcEndpoints: '<main>Chain ID (Mainnet) 5042 Mainnet endpoints Primary (Circle) https://rpc.mainnet.arc.io Blockdaemon https://rpc.blockdaemon.mainnet.arc.io dRPC https://rpc.drpc.mainnet.arc.io QuickNode https://rpc.quicknode.mainnet.arc.io</main>',
    contractAddresses: `<main>Mainnet Testnet Contract Address Notes USDC ${usdc} Optional ERC-20 interface for interacting with the native USDC balance. ERC-8004 Mainnet Testnet Contract Address Notes IdentityRegistry ${identity} Registers identities ReputationRegistry ${reputation} Records feedback ValidationRegistry ${validation} Handles validation Contract Address Notes IdentityRegistry 0x8004B663056A597Dffe9eCcC1965A193B7388713 ERC-8183 Arc Testnet hosts a reference implementation of the ERC-8183 agentic commerce standard.</main>`,
    evmDifferences: '<main>Native USDC is native interface (18 decimals). ERC-20 interface (6 decimals). They share one balance. Transfers to the zero address are forbidden. A value-bearing transfer to 0x0 reverts; a zero-value transfer to 0x0 succeeds.</main>',
    gasAndFees: '<main>Set maxFeePerGas to at least 20 Gwei. The parameters on this page reflect the current Arc Testnet configuration.</main>',
    usdcSystemEvents: `<main>Native USDC (system, EIP-7708) ${emitter} Transfer 18</main>`,
    deterministicFinality: '<main>Arc deterministic finality delivers irreversible transaction settlement in under one second.</main>',
    circleUsdcAddresses: `<main>Arc ${usdc}</main>`,
    ...overrides
  };
}

test('official documentation claims separate Mainnet facts from Testnet-only ERC-8183 availability', () => {
  const claims = extractArcOfficialClaims(pages());
  assert.equal(claims.chainId, 5042);
  assert.equal(claims.rpcEndpoints.primary, 'https://rpc.mainnet.arc.io');
  assert.deepEqual(claims.usdc, { arcMainnetAddress: usdc, circleAddress: usdc,
    addressesMatch: true, nativeGasDecimals: 18, erc20Decimals: 6, sharedUnderlyingBalance: true });
  assert.equal(claims.maxFeePerGasRecommendation.gwei, 20);
  assert.equal(claims.maxFeePerGasRecommendation.parametersPageHasTestnetScopeCaveat, true);
  assert.equal(claims.maxFeePerGasRecommendation.mainnetProtocolFloorConfirmed, false);
  assert.equal(claims.usdcSystemEmitter.toLowerCase(), emitter.toLowerCase());
  assert.deepEqual(claims.erc8183, { mainnetListed: false, testnetOnlyReferenceListed: true });
  assert.equal(claims.erc8004MainnetAddresses.IdentityRegistry, identity);
  assert.equal(claims.erc8004MainnetAddresses.ReputationRegistry, reputation);
  assert.equal(claims.erc8004MainnetAddresses.ValidationRegistry, validation);
});

test('official documentation parser exposes disagreements between Arc and Circle USDC references', () => {
  const claims = extractArcOfficialClaims(pages({ circleUsdcAddresses: '<main>Arc 0x1111111111111111111111111111111111111111</main>' }));
  assert.equal(claims.usdc.addressesMatch, false);
});

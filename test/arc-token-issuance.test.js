import test from 'node:test';
import assert from 'node:assert/strict';
import { AbiCoder } from 'ethers';
import { ManagedWalletArcInfrastructureSigner } from '../src/arc/wallet-provider.js';
import { arcNetworkConfig, ARC_MAINNET_CHAIN_ID } from '../src/arc/config.js';
import { AGENT_TOKEN_HUMAN_SUPPLY, ARC_AGENT_TOKEN_FACTORY_INTERFACE,
  arcTokenIssuanceId, buildArcAgentTokenFactoryTransaction, decodeArcAgentTokenCreated,
  inspectAgentTokenCreationCapacity, inspectAgentTokenSpecification } from '../src/arc/token-issuance.js';
import { toArcBytes16Uuid } from '../src/arc/settlement.js';

const WORLD_ID = 'ce434421-8bcd-4aac-b9ba-183383c713de';
const ISSUER_ID = 'adca48db-4492-4b39-98fa-b67c2548ba41';
const INTENT_ID = 'f9e749a4-45e5-4b0e-b1cc-b9440f498efe';
const ISSUER_WALLET = '0x1111111111111111111111111111111111111111';
const ALLOCATED_WALLET = '0x2222222222222222222222222222222222222222';
const FACTORY = '0x3333333333333333333333333333333333333333';
const HASH = `0x${'ab'.repeat(32)}`;

function specification(overrides = {}) {
  return { name: 'Agent-authored token', symbol: 'AAT', meaning: 'A value unit chosen by an Agent.',
    purpose: 'Coordinate exchanges that Agents choose to make.', rationale: 'The issuer chose this after a world discussion.',
    decimals: 18, distribution: [{ recipientType: 'agent', recipientId: ISSUER_ID,
      recipientAddress: ISSUER_WALLET, amount: '400000000' }], reserveAmount: '600000000',
    unallocatedSupplyHandling: 'issuer_controlled_reserve', ownershipModel: 'erc20_holder_owned',
    authorityModel: 'issuer_controlled_reserve', ...overrides };
}

function normalized(input = specification(), extras = {}) {
  return inspectAgentTokenSpecification(input, { worldId: WORLD_ID, issuerAgentId: ISSUER_ID,
    issuerIdentityId: '818', issuerWallet: ISSUER_WALLET, worldMinute: 197_666n, ...extras });
}

test('pilot token spec fixes one billion human units and uses BigInt decimals scaling', () => {
  const result = normalized();
  assert.equal(result.complete, true);
  assert.equal(AGENT_TOKEN_HUMAN_SUPPLY, '1000000000');
  assert.equal(result.totalSupplyRaw, 1_000_000_000_000_000_000_000_000_000n);
  assert.equal(result.distribution[0].amountRaw, 400_000_000_000_000_000_000_000_000n);
  assert.equal(result.reserveRaw, 600_000_000_000_000_000_000_000_000n);
  assert.equal(result.distribution[0].recipientAddress, ISSUER_WALLET.toLowerCase());
});

test('issuance stays incomplete until Agent-specified identity, purpose, issuer and distribution exist', () => {
  const result = inspectAgentTokenSpecification({ name: 'Agent choice', symbol: 'AC' });
  assert.deepEqual(result, { complete: false,
    blockers: ['meaning','purpose','rationale','decimals','distribution','reserveAmount','unallocatedSupplyHandling',
      'ownershipModel','authorityModel','issuerAgentId','issuerIdentityId','issuerWallet','worldMinute'] });
});

test('token spec rejects a changed fixed supply, duplicate recipients, invalid decimals and under-allocation', () => {
  assert.throws(() => normalized(specification({ distribution: [
    { recipientType: 'agent', recipientId: ISSUER_ID, recipientAddress: ISSUER_WALLET, amount: '999999999' }
  ] })), { code: 'TOKEN_INITIAL_DISTRIBUTION_MUST_EQUAL_FIXED_SUPPLY' });
  assert.throws(() => normalized(specification({ decimals: 19 })), { code: 'TOKEN_DECIMALS_OUT_OF_RANGE' });
  assert.throws(() => normalized(specification({ decimals: 6,
    distribution: [{ recipientType: 'agent', recipientId: ISSUER_ID,
      recipientAddress: ISSUER_WALLET, amount: '1.0000001' }] })), { code: 'TOKEN_DISTRIBUTION_0_PRECISION_EXCEEDED' });
  assert.throws(() => normalized(specification({ distribution: [
    { recipientType: 'agent', recipientId: ISSUER_ID, recipientAddress: ISSUER_WALLET, amount: '200000000' },
    { recipientType: 'external', recipientAddress: ISSUER_WALLET, amount: '200000000' }
  ] })), { code: 'TOKEN_DISTRIBUTION_DUPLICATE_ADDRESS' });
});

test('pilot creation capacity enforces generation one while allowing a later expanded generation', () => {
  assert.deepEqual(inspectAgentTokenCreationCapacity({ capabilityGeneration: 1,
    capabilityMaxCreations: 1, factoryMaxCreations: 1, factoryCreationCount: 0,
    worldOccupiedCreations: 0 }), { maxCreations: 1n, reached: false });
  assert.deepEqual(inspectAgentTokenCreationCapacity({ capabilityGeneration: 2,
    capabilityMaxCreations: 2, factoryMaxCreations: 2, factoryCreationCount: 0,
    worldOccupiedCreations: 1 }), { maxCreations: 2n, reached: false });
  assert.equal(inspectAgentTokenCreationCapacity({ capabilityGeneration: 2,
    capabilityMaxCreations: 2, factoryMaxCreations: 2, factoryCreationCount: 0,
    worldOccupiedCreations: 2 }).reached, true);
  assert.throws(() => inspectAgentTokenCreationCapacity({ capabilityGeneration: 1,
    capabilityMaxCreations: 2, factoryMaxCreations: 2, factoryCreationCount: 0,
    worldOccupiedCreations: 0 }), { code: 'TOKEN_PILOT_INITIAL_LIMIT_MISMATCH' });
  assert.throws(() => inspectAgentTokenCreationCapacity({ capabilityGeneration: 2,
    capabilityMaxCreations: 2, factoryMaxCreations: 1, factoryCreationCount: 0,
    worldOccupiedCreations: 0 }), { code: 'TOKEN_FACTORY_CAPABILITY_LIMIT_MISMATCH' });
});

test('factory calldata preserves Agent issuer and distribution while relayer remains transaction sender', () => {
  const spec = normalized();
  const issuanceId = arcTokenIssuanceId(WORLD_ID, INTENT_ID);
  const transaction = buildArcAgentTokenFactoryTransaction({ factoryAddress: FACTORY, worldId: WORLD_ID,
    intentId: INTENT_ID, issuerAgentId: ISSUER_ID, issuerIdentityId: '818', issuerWallet: ISSUER_WALLET,
    specification: spec, worldMinute: spec.worldMinute });
  assert.equal(transaction.chainId, ARC_MAINNET_CHAIN_ID);
  assert.equal(transaction.to, FACTORY);
  assert.equal(transaction.value, 0n);
  const outer = ARC_AGENT_TOKEN_FACTORY_INTERFACE.decodeFunctionData('createToken', transaction.data);
  const decoded = AbiCoder.defaultAbiCoder().decode(
    ['bytes16','uint32','bytes32','bytes16','uint256','address','string','string','uint8','bytes32','uint64',
      'uint8','uint8','uint8','address[]','uint256[]','uint256'],
    outer.encodedRequest
  );
  assert.equal(decoded[0].toLowerCase(), toArcBytes16Uuid(WORLD_ID).toLowerCase());
  assert.equal(decoded[2].toLowerCase(), issuanceId.toLowerCase());
  assert.equal(decoded[3].toLowerCase(), toArcBytes16Uuid(ISSUER_ID).toLowerCase());
  assert.equal(decoded[5].toLowerCase(), ISSUER_WALLET.toLowerCase());
  assert.equal(decoded[6], 'Agent-authored token');
  assert.equal(decoded[7], 'AAT');
  assert.equal(decoded[8], 18n);
  assert.deepEqual([decoded[11], decoded[12], decoded[13]], [1n, 0n, 1n]);
  assert.deepEqual([...decoded[14]].map((address) => address.toLowerCase()), [ISSUER_WALLET.toLowerCase()]);
  assert.equal(decoded[15][0], spec.distribution[0].amountRaw);
  assert.equal(decoded[16], spec.reserveRaw);
});

test('factory event decoder checks world, issuance and spec hash before accepting indexed provenance', () => {
  const spec = normalized();
  const issuanceId = arcTokenIssuanceId(WORLD_ID, INTENT_ID);
  const event = ARC_AGENT_TOKEN_FACTORY_INTERFACE.encodeEventLog(
    ARC_AGENT_TOKEN_FACTORY_INTERFACE.getEvent('AgentTokenCreated'),
    [toArcBytes16Uuid(WORLD_ID), 1, 1, issuanceId, toArcBytes16Uuid(ISSUER_ID), 818n,
      ISSUER_WALLET, ALLOCATED_WALLET, FACTORY, spec.specificationHash, 197_666n,
      spec.totalSupplyRaw, 18, 1, 0, 1]
  );
  const log = { address: FACTORY, ...event, transactionHash: HASH,
    blockNumber: '0x123', blockHash: `0x${'cd'.repeat(32)}`, logIndex: '0x2' };
  const decoded = decodeArcAgentTokenCreated({ logs: [log] }, { factoryAddress: FACTORY,
    worldId: WORLD_ID, issuanceId, specificationHash: spec.specificationHash });
  assert.equal(decoded.transactionSender, FACTORY.toLowerCase());
  assert.equal(decoded.issuerWallet, ISSUER_WALLET.toLowerCase());
  assert.equal(decoded.initialSupplyRaw, spec.totalSupplyRaw.toString());
  assert.equal(decoded.transactionHash, HASH);
  assert.equal(decoded.blockNumber, '291');
  assert.equal(decoded.logIndex, 2);
  assert.equal(decodeArcAgentTokenCreated({ logs: [log] }, { factoryAddress: FACTORY,
    worldId: WORLD_ID, issuanceId, specificationHash: HASH }), null);
});

test('Mainnet write gate stays closed even when an infrastructure signer adapter is present', async () => {
  const config = arcNetworkConfig({ ARC_ENV: 'mainnet' });
  assert.equal(config.writesEnabled, false);
  let broadcastCount = 0;
  const signer = new ManagedWalletArcInfrastructureSigner({ config,
    getAddress: async () => FACTORY,
    submitTransaction: async () => { broadcastCount += 1; return { hash: HASH }; }
  });
  await assert.rejects(() => signer.sendTransaction({ chainId: ARC_MAINNET_CHAIN_ID,
    to: FACTORY, value: 0n, data: '0x', maxFeePerGas: 20_000_000_000n,
    maxPriorityFeePerGas: 0n }), { code: 'ARC_MAINNET_PREFLIGHT_REQUIRED' });
  assert.equal(broadcastCount, 0);
});

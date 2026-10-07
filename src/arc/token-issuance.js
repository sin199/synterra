import { AbiCoder, getAddress, id, Interface, keccak256, toUtf8Bytes } from 'ethers';
import { assertArcMainnetChainId, ARC_MAINNET_CHAIN_ID } from './config.js';
import { toArcBytes16Uuid } from './settlement.js';

export const AGENT_TOKEN_PILOT_GENERATION = 1;
export const AGENT_TOKEN_PILOT_MAX_CREATIONS = 1;
export const AGENT_TOKEN_HUMAN_SUPPLY = '1000000000';
export const AGENT_TOKEN_MAX_DECIMALS = 18;
export const AGENT_TOKEN_UNALLOCATED_SUPPLY_HANDLING = Object.freeze({
  fully_distributed: 0, issuer_controlled_reserve: 1, locked_reserve: 2
});
export const AGENT_TOKEN_OWNERSHIP_MODELS = Object.freeze({ erc20_holder_owned: 0 });
export const AGENT_TOKEN_AUTHORITY_MODELS = Object.freeze({
  no_mint_no_burn: 0, issuer_controlled_reserve: 1, locked_reserve: 2
});

export function inspectAgentTokenCreationCapacity({ capabilityGeneration, capabilityMaxCreations,
  factoryMaxCreations, factoryCreationCount, worldOccupiedCreations }) {
  const generation = Number(capabilityGeneration);
  if (!Number.isSafeInteger(generation) || generation < 1 || generation > 0xffff_ffff) {
    throw invalid('TOKEN_CAPABILITY_GENERATION_INVALID');
  }
  let limit;
  let factoryLimit;
  let factoryCount;
  let occupied;
  try {
    limit = BigInt(capabilityMaxCreations);
    factoryLimit = BigInt(factoryMaxCreations);
    factoryCount = BigInt(factoryCreationCount);
    occupied = BigInt(worldOccupiedCreations);
  } catch { throw invalid('TOKEN_CAPABILITY_LIMIT_INVALID'); }
  if (limit < 1n || factoryLimit < 1n || factoryCount < 0n || occupied < 0n) {
    throw invalid('TOKEN_CAPABILITY_LIMIT_INVALID');
  }
  if (generation === AGENT_TOKEN_PILOT_GENERATION && limit !== BigInt(AGENT_TOKEN_PILOT_MAX_CREATIONS)) {
    throw invalid('TOKEN_PILOT_INITIAL_LIMIT_MISMATCH');
  }
  if (factoryLimit !== limit) throw invalid('TOKEN_FACTORY_CAPABILITY_LIMIT_MISMATCH');
  return { maxCreations: limit, reached: factoryCount >= limit || occupied >= limit };
}

export const ARC_AGENT_TOKEN_FACTORY_INTERFACE = new Interface([
  'function worldId() view returns (bytes16)',
  'function writer() view returns (address)',
  'function maxTokenCreationsPerWorld() view returns (uint32)',
  'function creationCount() view returns (uint32)',
  'function tokenForIssuance(bytes32 issuanceId) view returns (address)',
  'function specificationForIssuance(bytes32 issuanceId) view returns (bytes32)',
  'function createToken(bytes encodedRequest) returns (address tokenAddress,uint32 sequence,bool created)',
  'event AgentTokenCreated(bytes16 indexed worldId,uint32 indexed capabilityGeneration,uint32 indexed creationSequence,bytes32 issuanceId,bytes16 issuerAgentId,uint256 issuerIdentityId,address issuerWallet,address tokenAddress,address transactionSender,bytes32 specificationHash,uint64 worldMinute,uint256 initialSupplyRaw,uint8 decimals,uint8 unallocatedSupplyHandling,uint8 ownershipModel,uint8 authorityModel)'
]);
export const ARC_AGENT_TOKEN_INTERFACE = new Interface([
  'function worldId() view returns (bytes16)',
  'function capabilityGeneration() view returns (uint32)',
  'function issuanceId() view returns (bytes32)',
  'function issuerAgentId() view returns (bytes16)',
  'function issuerIdentityId() view returns (uint256)',
  'function issuerWallet() view returns (address)',
  'function specificationHash() view returns (bytes32)',
  'function createdWorldMinute() view returns (uint64)',
  'function initialSupply() view returns (uint256)',
  'function reservedSupply() view returns (uint256)',
  'function balanceOf(address account) view returns (uint256)',
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function unallocatedSupplyHandling() view returns (uint8)',
  'function ownershipModel() view returns (uint8)',
  'function authorityModel() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
  'event ReserveReleased(bytes16 indexed worldId,bytes32 indexed issuanceId,bytes32 indexed releaseId,address issuerWallet,address[] recipients,uint256[] amountsRaw,uint256 remainingReservedRaw,uint64 worldMinute)'
]);
export const AGENT_TOKEN_RESERVE_INTERFACE = new Interface([
  'function releaseReserved(bytes32 releaseId,address[] recipients,uint256[] amountsRaw,uint64 worldMinute)',
  'event ReserveReleased(bytes16 indexed worldId,bytes32 indexed issuanceId,bytes32 indexed releaseId,address issuerWallet,address[] recipients,uint256[] amountsRaw,uint256 remainingReservedRaw,uint64 worldMinute)'
]);

function invalid(code) { return Object.assign(new Error(code), { code }); }

function requiredText(value, field, maxBytes) {
  if (typeof value !== 'string') throw invalid(`TOKEN_${field.toUpperCase()}_REQUIRED`);
  const text = value.trim();
  if (!text || Buffer.byteLength(text, 'utf8') > maxBytes) throw invalid(`TOKEN_${field.toUpperCase()}_INVALID`);
  return text;
}

function parseHumanTokenUnits(value, decimals, field, { allowZero = false } = {}) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)(?:\.(\d+))?$/.test(value)) {
    throw invalid(`TOKEN_${field.toUpperCase()}_INVALID`);
  }
  const [whole, fraction = ''] = value.split('.');
  if (fraction.length > decimals) throw invalid(`TOKEN_${field.toUpperCase()}_PRECISION_EXCEEDED`);
  const scale = 10n ** BigInt(decimals);
  const raw = BigInt(whole) * scale + BigInt((fraction + '0'.repeat(decimals)).slice(0, decimals) || '0');
  if (!allowZero && raw === 0n) throw invalid(`TOKEN_${field.toUpperCase()}_MUST_BE_POSITIVE`);
  if (raw > (1n << 256n) - 1n) throw invalid(`TOKEN_${field.toUpperCase()}_OUT_OF_RANGE`);
  return raw;
}

function normalizeRecipient(item, index, decimals) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) throw invalid('TOKEN_DISTRIBUTION_INVALID');
  let recipientAddress;
  try { recipientAddress = getAddress(item.recipientAddress).toLowerCase(); }
  catch { throw invalid(`TOKEN_DISTRIBUTION_ADDRESS_INVALID_${index}`); }
  if (recipientAddress === `0x${'0'.repeat(40)}`) throw invalid(`TOKEN_DISTRIBUTION_ADDRESS_INVALID_${index}`);
  const recipientType = item.recipientType;
  if (!['agent','organization','external'].includes(recipientType)) throw invalid(`TOKEN_DISTRIBUTION_TYPE_INVALID_${index}`);
  const recipientId = item.recipientId === undefined || item.recipientId === null ? null : String(item.recipientId);
  if (recipientType === 'agent' || recipientType === 'organization') {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(recipientId || '')) {
      throw invalid(`TOKEN_DISTRIBUTION_ID_REQUIRED_${index}`);
    }
  } else if (recipientId !== null) throw invalid(`TOKEN_DISTRIBUTION_EXTERNAL_ID_FORBIDDEN_${index}`);
  const amountRaw = parseHumanTokenUnits(item.amount, decimals, `distribution_${index}`);
  return { recipientType, recipientId, recipientAddress, amountRaw };
}

export function inspectAgentTokenSpecification(input, { worldId = null, issuerAgentId = null,
  issuerIdentityId = null, issuerWallet = null, worldMinute = null,
  generation = AGENT_TOKEN_PILOT_GENERATION } = {}) {
  const value = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const blockers = [];
  for (const key of ['name','symbol','meaning','purpose','rationale','decimals','distribution','reserveAmount',
    'unallocatedSupplyHandling','ownershipModel','authorityModel']) {
    if (value[key] === undefined || value[key] === null || value[key] === '') blockers.push(key);
  }
  if (!issuerAgentId) blockers.push('issuerAgentId');
  if (!issuerIdentityId) blockers.push('issuerIdentityId');
  if (!issuerWallet) blockers.push('issuerWallet');
  if (worldMinute === null || worldMinute === undefined) blockers.push('worldMinute');
  if (blockers.length) return { complete: false, blockers };

  const name = requiredText(value.name, 'name', 64);
  const symbol = requiredText(value.symbol, 'symbol', 12);
  if (!/^[A-Za-z0-9._-]{1,12}$/.test(symbol)) throw invalid('TOKEN_SYMBOL_INVALID');
  const meaning = requiredText(value.meaning, 'meaning', 1000);
  const purpose = requiredText(value.purpose, 'purpose', 1000);
  const rationale = requiredText(value.rationale, 'rationale', 2000);
  const unallocatedSupplyHandling = requiredText(value.unallocatedSupplyHandling, 'unallocatedSupplyHandling', 48);
  const ownershipModel = requiredText(value.ownershipModel, 'ownershipModel', 48);
  const authorityModel = requiredText(value.authorityModel, 'authorityModel', 48);
  const unallocatedSupplyHandlingId = AGENT_TOKEN_UNALLOCATED_SUPPLY_HANDLING[unallocatedSupplyHandling];
  const ownershipModelId = AGENT_TOKEN_OWNERSHIP_MODELS[ownershipModel];
  const authorityModelId = AGENT_TOKEN_AUTHORITY_MODELS[authorityModel];
  if (unallocatedSupplyHandlingId === undefined || ownershipModelId === undefined || authorityModelId === undefined) {
    throw invalid('TOKEN_PRIMITIVE_CHOICE_UNSUPPORTED');
  }
  if (!Number.isSafeInteger(value.decimals) || value.decimals < 0 || value.decimals > AGENT_TOKEN_MAX_DECIMALS) {
    throw invalid('TOKEN_DECIMALS_OUT_OF_RANGE');
  }
  if (!Array.isArray(value.distribution) || value.distribution.length > 256) throw invalid('TOKEN_DISTRIBUTION_INVALID');
  const decimals = value.decimals;
  const totalSupplyRaw = BigInt(AGENT_TOKEN_HUMAN_SUPPLY) * (10n ** BigInt(decimals));
  if (totalSupplyRaw > (1n << 256n) - 1n) throw invalid('TOKEN_SUPPLY_OUT_OF_RANGE');
  const distribution = value.distribution.map((item, index) => normalizeRecipient(item, index, decimals));
  const addresses = new Set();
  for (const recipient of distribution) {
    if (addresses.has(recipient.recipientAddress)) throw invalid('TOKEN_DISTRIBUTION_DUPLICATE_ADDRESS');
    addresses.add(recipient.recipientAddress);
  }
  const reserveRaw = parseHumanTokenUnits(value.reserveAmount, decimals, 'reserve_amount', { allowZero: true });
  const allocatedRaw = distribution.reduce((total, item) => total + item.amountRaw, 0n);
  if (allocatedRaw + reserveRaw !== totalSupplyRaw) throw invalid('TOKEN_INITIAL_DISTRIBUTION_MUST_EQUAL_FIXED_SUPPLY');
  const handlingMatchesReserve = (unallocatedSupplyHandling === 'fully_distributed' && reserveRaw === 0n)
    || (unallocatedSupplyHandling !== 'fully_distributed' && reserveRaw > 0n);
  const authorityMatchesHandling = (unallocatedSupplyHandling === 'fully_distributed' && authorityModel === 'no_mint_no_burn')
    || (unallocatedSupplyHandling === 'issuer_controlled_reserve' && authorityModel === 'issuer_controlled_reserve')
    || (unallocatedSupplyHandling === 'locked_reserve' && authorityModel === 'locked_reserve');
  if (!handlingMatchesReserve || !authorityMatchesHandling || ownershipModel !== 'erc20_holder_owned') {
    throw invalid('TOKEN_PRIMITIVE_SEMANTICS_UNSUPPORTED');
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(worldId || '')
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(issuerAgentId || '')) {
    throw invalid('TOKEN_WORLD_OR_ISSUER_ID_INVALID');
  }
  let issuerIdentity;
  try { issuerIdentity = BigInt(issuerIdentityId); } catch { throw invalid('TOKEN_ISSUER_IDENTITY_INVALID'); }
  if (issuerIdentity <= 0n || issuerIdentity > (1n << 256n) - 1n) throw invalid('TOKEN_ISSUER_IDENTITY_INVALID');
  let normalizedIssuerWallet;
  try { normalizedIssuerWallet = getAddress(issuerWallet).toLowerCase(); }
  catch { throw invalid('TOKEN_ISSUER_WALLET_INVALID'); }
  const minute = BigInt(worldMinute);
  if (minute < 0n || minute > (1n << 64n) - 1n) throw invalid('TOKEN_WORLD_MINUTE_INVALID');
  if (!Number.isSafeInteger(generation) || generation < 1 || generation > 0xffff_ffff) throw invalid('TOKEN_GENERATION_INVALID');

  const canonicalDistribution = distribution.slice().sort((left, right) => left.recipientAddress.localeCompare(right.recipientAddress));
  const canonicalSpec = {
    schema: 'synterra-agent-token-spec-v1', worldId, capabilityGeneration: generation,
    issuerAgentId, issuerIdentityId: issuerIdentity.toString(), issuerWallet: normalizedIssuerWallet,
    name, symbol, meaning, purpose, rationale, decimals, unallocatedSupplyHandling,
    ownershipModel, authorityModel, humanSupply: AGENT_TOKEN_HUMAN_SUPPLY,
    initialSupplyRaw: totalSupplyRaw.toString(), reserveRaw: reserveRaw.toString(),
    distribution: canonicalDistribution.map((recipient) => ({ recipientType: recipient.recipientType,
      recipientId: recipient.recipientId, recipientAddress: recipient.recipientAddress,
      amountRaw: recipient.amountRaw.toString() })), worldMinute: minute.toString()
  };
  const specificationHash = keccak256(toUtf8Bytes(JSON.stringify(canonicalSpec)));
  return { complete: true, blockers: [], canonicalSpec, specificationHash, totalSupplyRaw,
    reserveRaw, distribution: canonicalDistribution, unallocatedSupplyHandling,
    unallocatedSupplyHandlingId, ownershipModel, ownershipModelId, authorityModel, authorityModelId,
    issuerIdentityId: issuerIdentity,
    issuerWallet: normalizedIssuerWallet, worldMinute: minute, generation };
}

export function arcTokenIssuanceId(worldId, intentId) {
  return keccak256(toUtf8Bytes(`synterra-agent-token-issuance-v1:${worldId}:${intentId}`));
}

export function buildArcAgentTokenFactoryTransaction({ factoryAddress, worldId, intentId, issuerAgentId,
  issuerIdentityId, issuerWallet, specification, worldMinute }) {
  assertArcMainnetChainId(ARC_MAINNET_CHAIN_ID);
  if (typeof factoryAddress !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(factoryAddress)) {
    throw invalid('TOKEN_FACTORY_ADDRESS_INVALID');
  }
  if (!specification?.complete) throw invalid('TOKEN_SPECIFICATION_INCOMPLETE');
  const issuanceId = arcTokenIssuanceId(worldId, intentId);
  const spec = specification.canonicalSpec;
  const recipients = specification.distribution.map((entry) => entry.recipientAddress);
  const amountsRaw = specification.distribution.map((entry) => entry.amountRaw);
  const encodedRequest = AbiCoder.defaultAbiCoder().encode(
    ['bytes16','uint32','bytes32','bytes16','uint256','address','string','string','uint8','bytes32','uint64',
      'uint8','uint8','uint8','address[]','uint256[]','uint256'],
    [toArcBytes16Uuid(worldId), specification.generation, issuanceId, toArcBytes16Uuid(issuerAgentId),
      BigInt(issuerIdentityId), getAddress(issuerWallet), spec.name, spec.symbol, spec.decimals,
      specification.specificationHash, BigInt(worldMinute), specification.unallocatedSupplyHandlingId,
      specification.ownershipModelId, specification.authorityModelId, recipients, amountsRaw, specification.reserveRaw]
  );
  return { chainId: ARC_MAINNET_CHAIN_ID, to: getAddress(factoryAddress), value: 0n,
    data: ARC_AGENT_TOKEN_FACTORY_INTERFACE.encodeFunctionData('createToken', [encodedRequest]) };
}

export function decodeArcAgentTokenCreated(receipt, { factoryAddress, worldId, issuanceId,
  specificationHash = null } = {}) {
  const matching = (receipt?.logs || []).filter((log) => log.address?.toLowerCase() === factoryAddress?.toLowerCase())
    .map((log) => {
      try { return { log, event: ARC_AGENT_TOKEN_FACTORY_INTERFACE.parseLog(log) }; }
      catch { return null; }
    }).find((entry) => entry?.event?.name === 'AgentTokenCreated'
      && String(entry.event.args.worldId).toLowerCase() === toArcBytes16Uuid(worldId).toLowerCase()
      && String(entry.event.args.issuanceId).toLowerCase() === issuanceId.toLowerCase()
      && (!specificationHash || String(entry.event.args.specificationHash).toLowerCase() === specificationHash.toLowerCase()));
  if (!matching) return null;
  const log = matching.log;
  const event = matching.event;
  return { worldId: String(event.args.worldId), capabilityGeneration: Number(event.args.capabilityGeneration),
    creationSequence: Number(event.args.creationSequence), issuanceId: String(event.args.issuanceId),
    issuerAgentId: String(event.args.issuerAgentId), issuerIdentityId: BigInt(event.args.issuerIdentityId).toString(),
    issuerWallet: String(event.args.issuerWallet).toLowerCase(), tokenAddress: String(event.args.tokenAddress).toLowerCase(),
    transactionSender: String(event.args.transactionSender).toLowerCase(), specificationHash: String(event.args.specificationHash),
    worldMinute: BigInt(event.args.worldMinute).toString(), initialSupplyRaw: BigInt(event.args.initialSupplyRaw).toString(),
    decimals: Number(event.args.decimals), unallocatedSupplyHandling: Number(event.args.unallocatedSupplyHandling),
    ownershipModel: Number(event.args.ownershipModel), authorityModel: Number(event.args.authorityModel),
    transactionHash: log?.transactionHash?.toLowerCase() || null,
    blockNumber: log?.blockNumber === undefined ? null : BigInt(log.blockNumber).toString(),
    logIndex: log?.logIndex === undefined ? null : Number(BigInt(log.logIndex)),
    blockHash: log?.blockHash?.toLowerCase() || null };
}

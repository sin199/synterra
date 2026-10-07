export const ARC_NATIVE_GAS_DECIMALS = 18;
export const ARC_USDC_TOKEN_DECIMALS = 6;
export const ARC_MAINNET_CHAIN_ID = 5042;
export const ARC_MAINNET_USDC_ADDRESS = '0x3600000000000000000000000000000000000000';
export const ARC_SYSTEM_USDC_TRANSFER_EMITTER = '0xffffFFFfFFffffffffffffffFfFFFfffFFFfFFfE';
export const ARC_TRANSFER_TOPIC0 = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
// Arc's current docs recommend a 20 Gwei maxFeePerGas minimum. Their fee page
// also says its fee parameters are Testnet-scoped, so this remains a
// conservative recommendation rather than a verified Mainnet protocol floor.
export const ARC_MAX_FEE_PER_GAS_RECOMMENDATION = 20_000_000_000n;

const MAINNET_RPCS = Object.freeze({
  circle: 'https://rpc.mainnet.arc.io',
  blockdaemon: 'https://rpc.blockdaemon.mainnet.arc.io',
  drpc: 'https://rpc.drpc.mainnet.arc.io',
  quicknode: 'https://rpc.quicknode.mainnet.arc.io'
});
const ALLOWED_RPC_HOSTS = new Set(Object.values(MAINNET_RPCS).map((value) => new URL(value).hostname));
const ERC8004_MAINNET = Object.freeze({
  identity: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
  reputation: '0x8004BAa17C55a88189AE136b182e5fdA19dE9b63',
  validation: '0x8004Cc8439f36fd5F9F049D9fF86523Df6dAAB58'
});

function verifiedMainnetRpc(value, label) {
  let parsed;
  try { parsed = new URL(value); }
  catch { throw new TypeError(`${label} must be an official Arc Mainnet HTTPS RPC URL.`); }
  if (parsed.protocol !== 'https:' || !ALLOWED_RPC_HOSTS.has(parsed.hostname.toLowerCase())
      || parsed.username || parsed.password || parsed.search || parsed.hash || (parsed.pathname !== '/' && parsed.pathname !== '')) {
    throw new TypeError(`${label} must use an allowlisted official Arc Mainnet RPC endpoint.`);
  }
  return parsed.origin;
}

export function arcNetworkConfig(env = process.env) {
  if (env.ARC_ENV && env.ARC_ENV !== 'mainnet') {
    const error = new Error('This build supports Arc Mainnet only.');
    error.code = 'ARC_MAINNET_ONLY';
    throw error;
  }
  const primaryRpcUrl = verifiedMainnetRpc(env.ARC_RPC_URL || MAINNET_RPCS.circle, 'ARC_RPC_URL');
  const configuredFallbacks = String(env.ARC_RPC_FALLBACK_URLS || '').trim();
  const backupRpcUrls = !configuredFallbacks
    ? Object.values(MAINNET_RPCS).filter((url) => url !== primaryRpcUrl)
    : configuredFallbacks.split(',').map((url) => verifiedMainnetRpc(url.trim(), 'ARC_RPC_FALLBACK_URLS'))
      .filter((url, index, urls) => url !== primaryRpcUrl && urls.indexOf(url) === index);
  const settlementRuntimeCodeHash = String(env.ARC_SETTLEMENT_RUNTIME_CODE_HASH || '').trim();
  if (settlementRuntimeCodeHash && !/^0x[0-9a-fA-F]{64}$/.test(settlementRuntimeCodeHash)) {
    throw new TypeError('ARC_SETTLEMENT_RUNTIME_CODE_HASH must be a 32-byte code hash.');
  }
  return Object.freeze({
    name: 'mainnet',
    chainId: ARC_MAINNET_CHAIN_ID,
    primaryRpcUrl,
    backupRpcUrls: Object.freeze(backupRpcUrls),
    explorerUrl: 'https://explorer.arc.io',
    usdcAddress: ARC_MAINNET_USDC_ADDRESS,
    usdcTokenDecimals: ARC_USDC_TOKEN_DECIMALS,
    nativeGasDecimals: ARC_NATIVE_GAS_DECIMALS,
    maxFeePerGasRecommendation: ARC_MAX_FEE_PER_GAS_RECOMMENDATION,
    erc8004: ERC8004_MAINNET,
    erc8183: null,
    settlementRuntimeCodeHash: settlementRuntimeCodeHash || null,
    // Mainnet writes stay closed in this build. Environment variables alone
    // must never cross the user's explicit Mainnet write gate.
    writesEnabled: false
  });
}

export function assertArcWriteAllowed(config, { operation = 'write' } = {}) {
  if (config?.name !== 'mainnet' || config?.chainId !== ARC_MAINNET_CHAIN_ID) {
    const error = new Error('Arc Mainnet is the only supported network.');
    error.code = 'ARC_MAINNET_ONLY';
    throw error;
  }
  if (!config.writesEnabled) {
    const error = new Error(`Arc Mainnet ${operation} is disabled until the Mainnet preflight is approved.`);
    error.code = 'ARC_MAINNET_PREFLIGHT_REQUIRED';
    throw error;
  }
}

function parseDecimalUnits(value, decimals, label, { allowZero = true } = {}) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)(?:\.(\d+))?$/.test(value)) {
    throw new TypeError(`${label} must be a non-negative decimal string.`);
  }
  const [whole, fraction = ''] = value.split('.');
  if (fraction.length > decimals) throw new RangeError(`${label} supports at most ${decimals} decimal places.`);
  const scale = 10n ** BigInt(decimals);
  const units = BigInt(whole) * scale + BigInt((fraction + '0'.repeat(decimals)).slice(0, decimals) || '0');
  if (!allowZero && units === 0n) throw new RangeError(`${label} must be greater than zero.`);
  return units;
}

function formatDecimalUnits(units, decimals, label) {
  if (typeof units !== 'bigint' || units < 0n) throw new TypeError(`${label} must be a non-negative bigint.`);
  const scale = 10n ** BigInt(decimals);
  const whole = units / scale;
  const fraction = String(units % scale).padStart(decimals, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : String(whole);
}

export function parseArcUsdcTokenUnits(value, options) {
  return parseDecimalUnits(value, ARC_USDC_TOKEN_DECIMALS, 'ERC-20 USDC amount', options);
}

export function formatArcUsdcTokenUnits(units) {
  return formatDecimalUnits(units, ARC_USDC_TOKEN_DECIMALS, 'ERC-20 USDC units');
}

export function parseArcNativeGasUnits(value, options) {
  return parseDecimalUnits(value, ARC_NATIVE_GAS_DECIMALS, 'native Arc gas amount', options);
}

export function formatArcNativeGasUnits(units) {
  return formatDecimalUnits(units, ARC_NATIVE_GAS_DECIMALS, 'native Arc gas units');
}

export function simulatedUsdcToArcTokenUnits(value, basisPoints) {
  if (!Number.isInteger(basisPoints) || basisPoints < 0 || basisPoints > 10_000) {
    throw new RangeError('Explicit settlement basis points must be an integer from 0 through 10000.');
  }
  const simulated8dp = parseDecimalUnits(value, 8, 'simulated USDC amount');
  return (simulated8dp / 100n) * BigInt(basisPoints) / 10_000n;
}

export function assertArcChainId(actualChainId, config = arcNetworkConfig()) {
  const actual = typeof actualChainId === 'string' && /^0x[0-9a-f]+$/i.test(actualChainId)
    ? Number(BigInt(actualChainId)) : Number(actualChainId);
  if (config?.name !== 'mainnet' || config?.chainId !== ARC_MAINNET_CHAIN_ID
      || !Number.isSafeInteger(actual) || actual !== ARC_MAINNET_CHAIN_ID) {
    const error = new Error(`Arc Mainnet RPC chain ID mismatch: expected ${ARC_MAINNET_CHAIN_ID}, received ${String(actualChainId)}.`);
    error.code = 'ARC_CHAIN_ID_MISMATCH';
    error.expectedChainId = ARC_MAINNET_CHAIN_ID;
    error.actualChainId = Number.isSafeInteger(actual) ? actual : null;
    throw error;
  }
  return actual;
}

export function assertArcMainnetChainId(chainId) {
  const actual = Number(chainId);
  if (!Number.isSafeInteger(actual) || actual !== ARC_MAINNET_CHAIN_ID) {
    const error = new RangeError('Only Arc Mainnet chain ID 5042 is supported.');
    error.code = 'ARC_MAINNET_ONLY';
    throw error;
  }
  return actual;
}

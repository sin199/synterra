import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Interface, keccak256 } from 'ethers';
import { arcNetworkConfig, ARC_MAINNET_USDC_ADDRESS, ARC_SYSTEM_USDC_TRANSFER_EMITTER,
  ARC_TRANSFER_TOPIC0, ARC_USDC_TOKEN_DECIMALS, ARC_NATIVE_GAS_DECIMALS,
  ARC_MAX_FEE_PER_GAS_RECOMMENDATION, formatArcNativeGasUnits } from '../../src/arc/config.js';
import { ArcRpcClient } from '../../src/arc/rpc.js';
import { extractArcOfficialClaims } from '../../src/arc/official-docs.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const ERC20 = new Interface(['function decimals() view returns (uint8)',
  'function name() view returns (string)', 'function symbol() view returns (string)',
  'function balanceOf(address) view returns (uint256)']);
const SOURCE_URLS = Object.freeze({
  rpcEndpoints: 'https://docs.arc.io/arc/references/rpc-endpoints',
  contractAddresses: 'https://docs.arc.io/arc/references/contract-addresses',
  evmDifferences: 'https://docs.arc.io/arc/references/evm-differences',
  gasAndFees: 'https://docs.arc.io/arc/references/gas-and-fees',
  usdcSystemEvents: 'https://docs.arc.io/arc/references/usdc-system-events',
  deterministicFinality: 'https://docs.arc.io/arc/concepts/deterministic-finality',
  circleUsdcAddresses: 'https://developers.circle.com/stablecoins/usdc-contract-addresses',
  circleSupportedChains: 'https://developers.circle.com/wallets/supported-blockchains'
});

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (token === '--write') { result.write = true; continue; }
    if (!['--rpc', '--deployer', '--treasury'].includes(token)) {
      throw new TypeError(`Unknown option: ${token}`);
    }
    const value = argv[++index];
    if (!value || value.startsWith('--')) throw new TypeError(`${token} requires a value.`);
    result[token.slice(2)] = value;
  }
  return result;
}

function normalizeAddress(value, label) {
  if (value === undefined) return null;
  if (!/^0x[0-9a-fA-F]{40}$/.test(value) || /^0x0{40}$/i.test(value)) {
    throw new TypeError(`${label} must be an explicitly supplied, non-zero EVM address.`);
  }
  return value;
}

function hexQuantity(value) { return `0x${BigInt(value).toString(16)}`; }
function errorCode(error) { return String(error?.code || 'RPC_READ_FAILED').replace(/[^A-Z0-9_]/gi, '').slice(0, 80); }

async function checkOfficialDocumentation() {
  return Promise.all(Object.entries(SOURCE_URLS).map(async ([topic, url]) => {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(12_000) });
      const body = await response.text();
      return { topic, url, status: response.status, finalUrl: response.url,
        contentBytes: Buffer.byteLength(body),
        sha256: createHash('sha256').update(body).digest('hex'),
        retrievedAt: new Date().toISOString(), documentText: response.ok ? body : null };
    } catch (error) {
      return { topic, url, status: 'unavailable', errorCode: errorCode(error), retrievedAt: new Date().toISOString() };
    }
  }));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const deployer = normalizeAddress(args.deployer, '--deployer');
  const treasury = normalizeAddress(args.treasury, '--treasury');
  const config = arcNetworkConfig({ ARC_ENV: 'mainnet', ...(args.rpc ? { ARC_RPC_URL: args.rpc } : {}) });
  const documentationChecks = await checkOfficialDocumentation();
  const unavailableDocumentation = documentationChecks.filter((check) => check.status !== 200);
  if (unavailableDocumentation.length) {
    const error = new Error(`Official documentation read failed for: ${unavailableDocumentation.map((check) => check.topic).join(', ')}.`);
    error.code = 'ARC_OFFICIAL_DOCUMENTATION_UNAVAILABLE';
    throw error;
  }
  const documentationPages = Object.fromEntries(documentationChecks.map((check) => [check.topic, check.documentText]));
  const officialClaims = extractArcOfficialClaims(documentationPages);
  const documentedMaxFeePerGasRecommendation = BigInt(officialClaims.maxFeePerGasRecommendation.gwei) * 1_000_000_000n;
  if (officialClaims.chainId !== config.chainId) {
    const error = new Error(`Official documentation and configured Arc network disagree on chain ID (${officialClaims.chainId} vs ${config.chainId}).`);
    error.code = 'ARC_CHAIN_ID_MISMATCH';
    throw error;
  }
  if (!officialClaims.usdc.addressesMatch
      || officialClaims.usdc.arcMainnetAddress.toLowerCase() !== ARC_MAINNET_USDC_ADDRESS.toLowerCase()) {
    const error = new Error('Official Arc and Circle USDC contract references disagree with the configured Mainnet token address.');
    error.code = 'ARC_OFFICIAL_USDC_ADDRESS_MISMATCH';
    throw error;
  }
  if (officialClaims.usdcSystemEmitter.toLowerCase() !== ARC_SYSTEM_USDC_TRANSFER_EMITTER.toLowerCase()) {
    const error = new Error('The configured USDC system-event emitter differs from the current official reference.');
    error.code = 'ARC_SYSTEM_EMITTER_MISMATCH';
    throw error;
  }
  if (documentedMaxFeePerGasRecommendation !== ARC_MAX_FEE_PER_GAS_RECOMMENDATION) {
    const error = new Error('The configured conservative maxFeePerGas recommendation differs from current official documentation.');
    error.code = 'ARC_FEE_RECOMMENDATION_CHANGED';
    throw error;
  }
  for (const [name, address] of Object.entries(config.erc8004)) {
    const key = ({ identity: 'IdentityRegistry', reputation: 'ReputationRegistry', validation: 'ValidationRegistry' })[name];
    if (officialClaims.erc8004MainnetAddresses[key]?.toLowerCase() !== address.toLowerCase()) {
      const error = new Error(`Official ERC-8004 Mainnet reference changed for ${key}.`);
      error.code = 'ARC_ERC8004_ADDRESS_MISMATCH';
      throw error;
    }
  }
  if (!officialClaims.rpcEndpoints.primary.endsWith(new URL(config.primaryRpcUrl).host)) {
    const error = new Error('Configured Arc Mainnet RPC endpoint differs from the current official primary endpoint.');
    error.code = 'ARC_RPC_ENDPOINT_MISMATCH';
    throw error;
  }
  const rpc = new ArcRpcClient({ config, timeoutMs: 12_000 });
  const [chainId, blockNumberHex, latestBlock] = await Promise.all([
    rpc.getChainId(), rpc.getBlockNumber(), rpc.getBlock('latest', false)
  ]);
  if (chainId !== config.chainId) {
    const error = new Error(`Official documentation and Arc Mainnet RPC disagree on chain ID (${config.chainId} vs ${chainId}).`);
    error.code = 'ARC_CHAIN_ID_MISMATCH';
    throw error;
  }

  const usdcCode = await rpc.getCode(ARC_MAINNET_USDC_ADDRESS, 'latest');
  const [decimalsHex, nameHex, symbolHex] = await Promise.all([
    rpc.call({ to: ARC_MAINNET_USDC_ADDRESS, data: ERC20.encodeFunctionData('decimals') }, 'latest'),
    rpc.call({ to: ARC_MAINNET_USDC_ADDRESS, data: ERC20.encodeFunctionData('name') }, 'latest'),
    rpc.call({ to: ARC_MAINNET_USDC_ADDRESS, data: ERC20.encodeFunctionData('symbol') }, 'latest')
  ]);
  const decimals = Number(BigInt(decimalsHex));
  if (decimals !== ARC_USDC_TOKEN_DECIMALS || decimals !== officialClaims.usdc.erc20Decimals || usdcCode === '0x') {
    throw new Error('The official USDC address did not return the expected deployed token code and decimals.');
  }

  const systemEmitterCode = await rpc.getCode(ARC_SYSTEM_USDC_TRANSFER_EMITTER, 'latest');
  const latestBlockNumber = BigInt(latestBlock.number);
  let systemTransferLogs = { available: false, reason: null, fromBlockHex: null, toBlockHex: null, count: null };
  try {
    const fromBlock = latestBlockNumber > 9n ? latestBlockNumber - 9n : 0n;
    const logs = await rpc.getLogs({ address: ARC_SYSTEM_USDC_TRANSFER_EMITTER, topics: [ARC_TRANSFER_TOPIC0],
      fromBlock: hexQuantity(fromBlock), toBlock: latestBlock.number });
    systemTransferLogs = { available: true, fromBlockHex: hexQuantity(fromBlock),
      toBlockHex: latestBlock.number, count: logs.length };
  } catch (error) { systemTransferLogs.reason = errorCode(error); }

  const [feeHistory, priorityFee] = await Promise.all([
    rpc.feeHistory('0x4', 'latest', [50]), rpc.maxPriorityFeePerGas()
  ]);
  const registryCode = {};
  for (const [name, address] of Object.entries(config.erc8004)) {
    const code = await rpc.getCode(address, 'latest');
    registryCode[name] = { address, deployed: code !== '0x', runtimeCodeBytes: (code.length - 2) / 2,
      runtimeCodeHash: code === '0x' ? null : keccak256(code) };
  }

  let zeroAddressNonZeroValueCall;
  try {
    const response = await fetch(config.primaryRpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'zero-address-readonly-check', method: 'eth_call',
        params: [{ from: ARC_SYSTEM_USDC_TRANSFER_EMITTER, to: ZERO_ADDRESS, value: '0x1' }, 'latest'] }),
      signal: AbortSignal.timeout(12_000) });
    const body = await response.json();
    if (!response.ok || body.error) {
      const message = String(body.error?.message || '');
      zeroAddressNonZeroValueCall = { result: message.includes('Zero address not allowed')
        ? 'reverted_zero_address_not_allowed' : 'reverted_or_rpc_rejected',
        errorCode: body.error?.code ?? `HTTP_${response.status}`, transactionSubmitted: false };
    } else zeroAddressNonZeroValueCall = { result: 'returned', transactionSubmitted: false };
  } catch (error) {
    zeroAddressNonZeroValueCall = { result: 'rpc_unavailable', errorCode: errorCode(error), transactionSubmitted: false };
  }

  const accountRead = async (address) => {
    if (!address) return { status: 'PENDING MAINNET SIGNER CONFIGURATION' };
    const [nativeBalance, tokenBalance, pendingNonce] = await Promise.all([
      rpc.getBalance(address, 'latest'),
      rpc.call({ to: ARC_MAINNET_USDC_ADDRESS, data: ERC20.encodeFunctionData('balanceOf', [address]) }, 'latest'),
      rpc.getTransactionCount(address, 'pending')
    ]);
    return { address, nativeUsdcBalanceBaseUnits: BigInt(nativeBalance).toString(),
      nativeUsdcBalance: formatArcNativeGasUnits(BigInt(nativeBalance)), nativeGasDecimals: ARC_NATIVE_GAS_DECIMALS,
      erc20UsdcBalanceBaseUnits: BigInt(ERC20.decodeFunctionResult('balanceOf', tokenBalance)[0]).toString(),
      erc20UsdcDecimals: ARC_USDC_TOKEN_DECIMALS,
      pendingNonce: BigInt(pendingNonce).toString() };
  };
  const accounts = { deployer: await accountRead(deployer), treasury: await accountRead(treasury) };
  const backupRpcChecks = [];
  for (const url of config.backupRpcUrls) {
    const backup = new ArcRpcClient({ config: arcNetworkConfig({ ARC_ENV: 'mainnet', ARC_RPC_URL: url,
      ARC_RPC_FALLBACK_URLS: config.primaryRpcUrl }), timeoutMs: 12_000 });
    try {
      const [backupChainId, backupBlock] = await Promise.all([backup.getChainId(), backup.getBlockNumber()]);
      backupRpcChecks.push({ provider: new URL(url).hostname, chainId: backupChainId,
        blockNumberHex: backupBlock, status: 'verified_mainnet' });
    } catch (error) {
      if (error.code === 'ARC_CHAIN_ID_MISMATCH') throw error;
      backupRpcChecks.push({ provider: new URL(url).hostname, status: 'unavailable', errorCode: errorCode(error) });
    }
  }

  const result = {
    verifiedAt: new Date().toISOString(), verificationMode: 'official_documentation_plus_read_only_mainnet_json_rpc',
    noMainnetWritesPerformed: true, testnetConnected: false,
    sources: Object.entries(SOURCE_URLS).map(([topic, url]) => ({ topic, url })),
    documentationChecks: documentationChecks.map(({ documentText, ...check }) => check),
    officialDocumentationEvidence: {
      chainId: { value: officialClaims.chainId, source: SOURCE_URLS.rpcEndpoints },
      mainnetRpcEndpoints: officialClaims.rpcEndpoints,
      usdc: { ...officialClaims.usdc,
        arcSource: SOURCE_URLS.contractAddresses, circleSource: SOURCE_URLS.circleUsdcAddresses },
      maxFeePerGasRecommendation: { ...officialClaims.maxFeePerGasRecommendation,
        source: SOURCE_URLS.gasAndFees,
        note: officialClaims.maxFeePerGasRecommendation.parametersPageHasTestnetScopeCaveat
          ? 'The page recommends 20 Gwei for maxFeePerGas but states its current fee parameters are Testnet-scoped; this is recorded as a conservative recommendation, not a verified Mainnet protocol floor.'
          : null },
      nativeUsdcSystemEmitter: { address: officialClaims.usdcSystemEmitter, source: SOURCE_URLS.usdcSystemEvents },
      zeroAddressBehavior: officialClaims.zeroAddressBehavior,
      deterministicFinalityStatement: officialClaims.deterministicFinalityStatement,
      erc8004MainnetAddresses: { ...officialClaims.erc8004MainnetAddresses, source: SOURCE_URLS.contractAddresses },
      erc8183: { ...officialClaims.erc8183, source: SOURCE_URLS.contractAddresses }
    },
    documentationClaims: {
      chainId: { documented: officialClaims.chainId, rpcHex: `0x${officialClaims.chainId.toString(16)}`, matched: chainId === officialClaims.chainId },
      primaryRpc: officialClaims.rpcEndpoints.primary,
      backupRpcOptions: Object.entries(officialClaims.rpcEndpoints).filter(([name]) => name !== 'primary').map(([, url]) => new URL(url).hostname),
      usdcAddress: officialClaims.usdc.arcMainnetAddress, usdcAddressSource: SOURCE_URLS.contractAddresses,
      nativeUsdcGasDecimals: ARC_NATIVE_GAS_DECIMALS, erc20UsdcDecimals: ARC_USDC_TOKEN_DECIMALS,
      maxFeePerGasRecommendationWei: documentedMaxFeePerGasRecommendation.toString(),
      mainnetProtocolMaxFeeFloorConfirmed: officialClaims.maxFeePerGasRecommendation.mainnetProtocolFloorConfirmed,
      deterministicFinality: Boolean(officialClaims.deterministicFinalityStatement),
      systemUsdcEmitter: officialClaims.usdcSystemEmitter,
      erc8183MainnetStatus: officialClaims.erc8183.mainnetListed ? 'MAINNET_AVAILABLE' : 'NOT_AVAILABLE'
    },
    network: { name: 'Arc Mainnet', chainId, documentationChainId: 5042, rpcChainIdHex: '0x13b2',
      primaryRpc: config.primaryRpcUrl, backupRpcChecks,
      latestBlockObservation: { ethBlockNumberHex: blockNumberHex, ethGetBlockByNumberLatestHex: latestBlock.number,
        hash: latestBlock.hash, timestampHex: latestBlock.timestamp, baseFeePerGasHex: latestBlock.baseFeePerGas || null } },
    usdc: { canonicalAddress: ARC_MAINNET_USDC_ADDRESS,
      ethGetCode: { nonEmpty: usdcCode !== '0x', byteLength: (usdcCode.length - 2) / 2, runtimeCodeHash: keccak256(usdcCode) },
      erc20: { decimals, decimalsHex, name: ERC20.decodeFunctionResult('name', nameHex)[0],
        symbol: ERC20.decodeFunctionResult('symbol', symbolHex)[0] },
      nativeAccounting: { asset: 'USDC', precisionDecimals: ARC_NATIVE_GAS_DECIMALS,
        semantics: 'Native gas balance and ERC-20 USDC are two precision views of the same underlying balance; never sum them.' },
      erc20SettlementPrecisionDecimals: ARC_USDC_TOKEN_DECIMALS },
    gas: { currency: 'USDC', pricingModel: 'EIP-1559',
      documentedMaxFeePerGasRecommendationWei: documentedMaxFeePerGasRecommendation.toString(),
      mainnetProtocolFloorStatus: officialClaims.maxFeePerGasRecommendation.mainnetProtocolFloorConfirmed
        ? 'VERIFIED' : 'NOT_CONFIRMED_BY_CURRENT_MAINNET_DOCUMENTATION',
      observedLatestBaseFeePerGasWei: latestBlock.baseFeePerGas ? BigInt(latestBlock.baseFeePerGas).toString() : null,
      documentationScopeNote: officialClaims.maxFeePerGasRecommendation.parametersPageHasTestnetScopeCaveat
        ? 'Arc gas documentation cautions that fee parameters on the page are currently Testnet-scoped.' : null,
      observedLatestBaseFeePerGasHex: latestBlock.baseFeePerGas || null,
      observedFeeHistoryBaseFeesHex: feeHistory.baseFeePerGas,
      observedMaxPriorityFeePerGasHex: priorityFee,
      finalFeeRule: 'Refresh Mainnet fee fields immediately before any separately authorized write.' },
    finality: { model: 'deterministic BFT finality',
      officialExpectation: 'Arc documentation describes irreversible, deterministic transaction settlement in under one second.' },
    systemUsdcEvents: { nativeTransferEmitter: ARC_SYSTEM_USDC_TRANSFER_EMITTER, transferTopic0: ARC_TRANSFER_TOPIC0,
      emitterCodeNonEmpty: systemEmitterCode !== '0x', emitterRuntimeCodeBytes: (systemEmitterCode.length - 2) / 2,
      latestBlockEthGetLogs: systemTransferLogs,
      indexingRule: 'Token-contract and system-emitter Transfer records may describe one underlying balance movement; index by emitter and do not double count.' },
    zeroAddressValue: { rule: 'non-zero native value to address(0) is expected to revert; zero value remains valid',
      readOnlyEthCall: zeroAddressNonZeroValueCall },
    erc8004: { mainnetStatus: Object.values(registryCode).every((item) => item.deployed)
      ? 'MAINNET_AVAILABLE' : 'NOT_AVAILABLE', source: SOURCE_URLS.contractAddresses, registries: registryCode,
      reuseDecision: 'Available for evaluation only; no identity registration was performed.' },
    erc8183: { mainnetStatus: 'NOT_AVAILABLE', mainnetAddress: null,
      source: SOURCE_URLS.contractAddresses,
      reuseDecision: 'No Mainnet deployment is listed by the current official Arc contract-address reference.' },
    mainnetAccounts: accounts,
    walletArchitecture: { signerProvider: 'PENDING MAINNET SIGNER CONFIGURATION',
      keyHandling: 'No signer secrets were read, stored, logged, or included in this artifact.' }
  };

  const serialized = `${JSON.stringify(result, null, 2)}\n`;
  if (args.write) {
    const output = path.join(ROOT, 'deployments/arc-mainnet-network-verification.json');
    await writeFile(output, serialized, { mode: 0o644 });
    process.stdout.write(`${output}\n`);
  } else process.stdout.write(serialized);
}

main().catch((error) => {
  const code = errorCode(error);
  process.stderr.write(`${code}: ${error.message}\n`);
  process.exitCode = 1;
});

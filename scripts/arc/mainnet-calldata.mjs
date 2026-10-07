import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Interface, keccak256 } from 'ethers';
import { ARC_MAINNET_CHAIN_ID, ARC_MAINNET_USDC_ADDRESS, arcNetworkConfig,
  formatArcNativeGasUnits } from '../../src/arc/config.js';
import { ArcRpcClient } from '../../src/arc/rpc.js';
import { buildArcEip1559FeeFields } from '../../src/arc/wallet-provider.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CONTRACTS = Object.freeze([
  { name: 'SynterraWorldRegistry', source: 'SynterraWorldRegistry.sol', args: ['worldId','owner','checkpointWriter','identityWriter'] },
  { name: 'SynterraSettlement', source: 'SynterraSettlement.sol', args: ['worldId','usdc','emergencyOperator'] },
  { name: 'SynterraCapabilityProvenance', source: 'SynterraCapabilityProvenance.sol', args: ['worldId','owner','writer'] },
  { name: 'SynterraAgentTokenFactory', source: 'SynterraAgentTokenFactory.sol',
    args: ['worldId','owner','writer','maxTokenCreationsPerWorld'] }
]);
const ADDRESS_ARGS = new Set(['registry-owner','checkpoint-writer','identity-writer',
  'settlement-operator','provenance-owner','provenance-writer','agent-token-factory-owner',
  'agent-token-factory-writer','deployer']);

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (token === '--manifest-only' || token === '--estimate') { result[token.slice(2).replaceAll('-', '')] = true; continue; }
    const key = token.startsWith('--') ? token.slice(2) : '';
    if (!ADDRESS_ARGS.has(key) && !['world-id','rpc','output'].includes(key)) {
      throw new TypeError(`Unknown option: ${token}`);
    }
    const value = argv[++index];
    if (!value || value.startsWith('--')) throw new TypeError(`${token} requires a value.`);
    result[key] = value;
  }
  return result;
}

function normalizeAddress(value, label) {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(value) || /^0x0{40}$/i.test(value)) {
    throw new TypeError(`${label} must be an explicitly supplied, non-zero EVM address.`);
  }
  return value;
}

function uuidBytes16(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new TypeError('--world-id must be a valid UUID for the existing Synterra world.');
  }
  const hex = value.replaceAll('-', '').toLowerCase();
  if (/^0+$/.test(hex)) throw new TypeError('--world-id must be non-zero.');
  return `0x${hex}`;
}

async function readArtifacts() {
  const values = [];
  for (const contract of CONTRACTS) {
    const filename = path.join(ROOT, 'contracts/out', contract.source, `${contract.name}.json`);
    let artifact;
    try { artifact = JSON.parse(await readFile(filename, 'utf8')); }
    catch { throw new Error(`Missing Foundry artifact ${filename}; run forge build first.`); }
    const creationBytecode = String(artifact.bytecode?.object || '').replace(/^0x/, '');
    const runtimeBytecode = String(artifact.deployedBytecode?.object || '').replace(/^0x/, '');
    if (!/^([0-9a-fA-F]{2})+$/.test(creationBytecode)
        || !/^([0-9a-fA-F]{2})+$/.test(runtimeBytecode)
        || Object.keys(artifact.bytecode?.linkReferences || {}).length) {
      throw new Error(`Foundry artifact for ${contract.name} has missing, malformed, or linked bytecode.`);
    }
    const iface = new Interface(artifact.abi);
    const constructor = iface.fragments.find((fragment) => fragment.type === 'constructor');
    values.push({ ...contract, artifact, iface, creationBytecode: `0x${creationBytecode}`,
      runtimeBytecode: `0x${runtimeBytecode}`,
      constructorSignature: constructor
        ? `constructor(${constructor.inputs.map((input) => input.type).join(',')})` : 'constructor()',
      creationBytecodeHash: keccak256(`0x${creationBytecode}`),
      runtimeBytecodeHash: keccak256(`0x${runtimeBytecode}`) });
  }
  return values;
}

function contractManifest(artifacts) {
  return { network: 'Arc Mainnet', chainId: ARC_MAINNET_CHAIN_ID,
    generatedAt: new Date().toISOString(), mode: 'offline_contract_bytecode_manifest',
    noMainnetWritesPerformed: true,
    contracts: artifacts.map((item) => ({ name: item.name, source: `contracts/src/${item.source}`,
      constructorSignature: item.constructorSignature, constructorArgumentNames: item.args,
      creationBytecodeBytes: (item.creationBytecode.length - 2) / 2,
      creationBytecodeHash: item.creationBytecodeHash,
      runtimeBytecodeBytes: (item.runtimeBytecode.length - 2) / 2,
      runtimeBytecodeHash: item.runtimeBytecodeHash })) };
}

function deploymentArgs(options) {
  const worldId = uuidBytes16(options['world-id']);
  const registryOwner = normalizeAddress(options['registry-owner'], '--registry-owner');
  const checkpointWriter = normalizeAddress(options['checkpoint-writer'], '--checkpoint-writer');
  const identityWriter = normalizeAddress(options['identity-writer'], '--identity-writer');
  const settlementOperator = normalizeAddress(options['settlement-operator'], '--settlement-operator');
  const provenanceOwner = normalizeAddress(options['provenance-owner'], '--provenance-owner');
  const provenanceWriter = normalizeAddress(options['provenance-writer'], '--provenance-writer');
  const agentTokenFactoryOwner = normalizeAddress(options['agent-token-factory-owner'], '--agent-token-factory-owner');
  const agentTokenFactoryWriter = normalizeAddress(options['agent-token-factory-writer'], '--agent-token-factory-writer');
  if (new Set([registryOwner.toLowerCase(), checkpointWriter.toLowerCase(), identityWriter.toLowerCase()]).size !== 3) {
    throw new TypeError('Registry owner, checkpoint writer, and identity writer must be distinct.');
  }
  if (provenanceOwner.toLowerCase() === provenanceWriter.toLowerCase()) {
    throw new TypeError('Provenance owner and writer must be distinct.');
  }
  if (agentTokenFactoryOwner.toLowerCase() === agentTokenFactoryWriter.toLowerCase()) {
    throw new TypeError('Agent token factory owner and writer must be distinct.');
  }
  return { worldId, registryOwner, checkpointWriter, identityWriter, settlementOperator,
    provenanceOwner, provenanceWriter, agentTokenFactoryOwner, agentTokenFactoryWriter };
}

function assembleDeployments(artifacts, args) {
  const byName = new Map(artifacts.map((item) => [item.name, item]));
  const constructorValues = {
    SynterraWorldRegistry: [args.worldId, args.registryOwner, args.checkpointWriter, args.identityWriter],
    SynterraSettlement: [args.worldId, ARC_MAINNET_USDC_ADDRESS, args.settlementOperator],
    SynterraCapabilityProvenance: [args.worldId, args.provenanceOwner, args.provenanceWriter],
    SynterraAgentTokenFactory: [args.worldId, args.agentTokenFactoryOwner, args.agentTokenFactoryWriter, 1]
  };
  return CONTRACTS.map(({ name }) => {
    const item = byName.get(name);
    const encodedArgs = item.iface.encodeDeploy(constructorValues[name]);
    const initCode = `${item.creationBytecode}${encodedArgs.slice(2)}`;
    return { name, chainId: ARC_MAINNET_CHAIN_ID, from: null, to: null, value: '0x0',
      constructorArgs: Object.fromEntries(item.args.map((key, index) => [key, constructorValues[name][index]])),
      transactionData: initCode, creationCodeHash: item.creationBytecodeHash,
      runtimeCodeHash: item.runtimeBytecodeHash, initCodeHash: keccak256(initCode),
      initCodeBytes: (initCode.length - 2) / 2, estimatedGas: null, maxFeePerGas: null,
      estimatedMaximumNativeUsdcFee: null, nonce: null };
  });
}

async function estimateDeployments(deployments, options) {
  const deployer = normalizeAddress(options.deployer, '--deployer');
  const config = arcNetworkConfig({ ARC_ENV: 'mainnet', ...(options.rpc ? { ARC_RPC_URL: options.rpc } : {}) });
  const rpc = new ArcRpcClient({ config, timeoutMs: 12_000 });
  const chainId = await rpc.getChainId();
  if (chainId !== ARC_MAINNET_CHAIN_ID) throw new Error('Arc documentation and Mainnet RPC chain IDs disagree.');
  const [block, tipHex, pendingNonceHex] = await Promise.all([
    rpc.getBlock('latest', false), rpc.maxPriorityFeePerGas(), rpc.getTransactionCount(deployer, 'pending')
  ]);
  const fees = buildArcEip1559FeeFields({ baseFeePerGas: BigInt(block.baseFeePerGas),
    maxPriorityFeePerGas: BigInt(tipHex), recommendedMinimum: config.maxFeePerGasRecommendation });
  let nonce = BigInt(pendingNonceHex);
  for (const deployment of deployments) {
    const estimatedGas = BigInt(await rpc.estimateGas({ from: deployer,
      data: deployment.transactionData, value: '0x0' }));
    deployment.from = deployer;
    deployment.estimatedGas = estimatedGas.toString();
    deployment.maxFeePerGas = fees.maxFeePerGas.toString();
    deployment.estimatedMaximumNativeUsdcFee = formatArcNativeGasUnits(estimatedGas * fees.maxFeePerGas);
    deployment.nonce = nonce.toString();
    nonce += 1n;
  }
  return { estimation: { status: 'read_only_rpc_estimate', sampledAt: new Date().toISOString(),
    chainId, provider: new URL(config.primaryRpcUrl).hostname,
    latestBlock: BigInt(block.number).toString(), baseFeePerGas: BigInt(block.baseFeePerGas).toString(),
    maxPriorityFeePerGas: BigInt(tipHex).toString(), maxFeePerGas: fees.maxFeePerGas.toString(),
    pendingNonce: BigInt(pendingNonceHex).toString(), estimatedFeesAreNotAQuote: true } };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const artifacts = await readArtifacts();
  if (options.manifestonly) {
    const output = `${JSON.stringify(contractManifest(artifacts), null, 2)}\n`;
    if (options.output) await writeFile(path.resolve(options.output), output, { mode: 0o644 });
    else process.stdout.write(output);
    return;
  }
  const values = deploymentArgs(options);
  const deployments = assembleDeployments(artifacts, values);
  const result = { generatedAt: new Date().toISOString(), network: 'Arc Mainnet',
    chainId: ARC_MAINNET_CHAIN_ID, mode: 'offline_deployment_calldata_only',
    noMainnetWritesPerformed: true, requiresSeparateMainnetPreflightApproval: true,
    deployerAddress: options.deployer ? normalizeAddress(options.deployer, '--deployer') : null,
    settlementUsdcAddress: ARC_MAINNET_USDC_ADDRESS,
    worldId: options['world-id'], contracts: deployments };
  if (options.estimate) Object.assign(result, await estimateDeployments(deployments, options));
  const output = `${JSON.stringify(result, null, 2)}\n`;
  if (options.output) await writeFile(path.resolve(options.output), output, { mode: 0o600, flag: 'wx' });
  else process.stdout.write(output);
}

main().catch((error) => {
  process.stderr.write(`${String(error?.message || 'Deployment calldata generation failed.')}\n`);
  process.exitCode = 1;
});

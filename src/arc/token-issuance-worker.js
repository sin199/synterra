import { randomUUID } from 'node:crypto';
import { getAddress, keccak256 } from 'ethers';
import { assertArcChainId, assertArcMainnetChainId, ARC_MAINNET_CHAIN_ID } from './config.js';
import { ARC_AGENT_TOKEN_FACTORY_INTERFACE, AGENT_TOKEN_PILOT_MAX_CREATIONS,
  AGENT_TOKEN_HUMAN_SUPPLY,
  ARC_AGENT_TOKEN_INTERFACE,
  arcTokenIssuanceId, buildArcAgentTokenFactoryTransaction, decodeArcAgentTokenCreated,
  inspectAgentTokenCreationCapacity, inspectAgentTokenSpecification } from './token-issuance.js';
import { agentTokenSpecificationFromIntentRow } from '../world-token-issuance.js';
import { buildArcEip1559FeeFields, assertArcInfrastructureSigner } from './wallet-provider.js';
import { reserveArcInfrastructureNonce, markArcInfrastructureNonce,
  releaseArcInfrastructureNonce } from './infrastructure-nonce.js';
import { reserveArcMainnetPilotCost, releaseArcMainnetPilotCost, setArcMainnetPilotCostStatus,
  settleArcMainnetPilotCost } from './pilot-budget.js';
import { indexArcContractEvents } from './indexer.js';
import { writeWorldHistory } from '../world-domain.js';
import { toArcBytes16Uuid } from './settlement.js';
import { lockGenesisCurrencyActivation } from '../genesis-economy.js';

export const ARC_AGENT_TOKEN_WORKER_LOCK_NAME = 'synterra-arc-agent-token-issuance-worker';
const POLL_INTERVAL_MS = 2_000;
const MAX_INDEX_PAGES = 2;

function coded(code) { return Object.assign(new Error(code), { code }); }
function safeCode(error) { return String(error?.code || 'ARC_TOKEN_WORKER_ERROR').replace(/[^A-Z0-9_]/gi, '').slice(0, 80); }
function equalAddress(left, right) { return typeof left === 'string' && typeof right === 'string'
  && left.toLowerCase() === right.toLowerCase(); }
function validHash(value) { return typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value); }
function parseStartBlock(value) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const text = String(value).trim();
  if (!/^(?:0x[0-9a-fA-F]+|\d+)$/.test(text)) throw coded('ARC_TOKEN_FACTORY_DEPLOYMENT_BLOCK_INVALID');
  return BigInt(text).toString();
}

async function withTransaction(pool, operation) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

function intentSpecification(row) {
  const minute = BigInt(row.issuer_confirmed_world_minute ?? row.updated_world_minute);
  const specification = inspectAgentTokenSpecification(agentTokenSpecificationFromIntentRow(row), {
    worldId: row.world_id, issuerAgentId: row.issuer_agent_id,
    issuerIdentityId: row.issuer_identity_id, issuerWallet: row.issuer_wallet,
    worldMinute: minute, generation: Number(row.capability_generation)
  });
  if (!specification.complete || specification.specificationHash?.toLowerCase()
      !== String(row.specification_hash || '').toLowerCase()) throw coded('TOKEN_SPECIFICATION_HASH_MISMATCH');
  return specification;
}

function receiptSucceeded(receipt) {
  return receipt?.status === 1 || receipt?.status === true || receipt?.status === '0x1' || receipt?.status === '0x01';
}

export class ArcAgentTokenIssuanceWorker {
  #pool;
  #config;
  #env;
  #signer;
  #rpc;
  #isOwner;
  #onError;
  #lockClient = null;
  #timer = null;
  #active = false;
  #status;
  #worldId = null;

  constructor({ pool, config, env = process.env, signer = null, rpcClient, isOwner = () => true,
    onError = () => {}, intervalMs = POLL_INTERVAL_MS }) {
    if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') {
      throw new TypeError('PostgreSQL pool is required for Agent token issuance work.');
    }
    if (!config || config.name !== 'mainnet' || Number(config.chainId) !== ARC_MAINNET_CHAIN_ID) {
      throw coded('ARC_MAINNET_ONLY');
    }
    this.#pool = pool;
    this.#config = config;
    this.#env = env;
    this.#signer = signer;
    this.#rpc = rpcClient;
    this.#isOwner = isOwner;
    this.intervalMs = Math.max(1_000, Number(intervalMs) || POLL_INTERVAL_MS);
    this.#status = { available: true, running: false, mode: 'read_only_reconciliation',
      worldId: null, writesEnabled: false, factoryConfigured: false, factoryVerified: false,
      providerName: signer?.providerName || null, lastProcessedAt: null, lastResult: null,
      lastError: null, reason: 'world_engine_lock_not_owned', integrityFindings: [] };
  }

  getStatus() { return structuredClone(this.#status); }

  #factoryAddress() {
    const value = String(this.#env.ARC_AGENT_TOKEN_FACTORY_ADDRESS || '').trim();
    if (!value) return null;
    if (!/^0x[0-9a-fA-F]{40}$/.test(value) || /^0x0{40}$/i.test(value)) throw coded('ARC_TOKEN_FACTORY_ADDRESS_INVALID');
    return getAddress(value);
  }

  #factoryRuntimeHash() {
    const value = String(this.#env.ARC_AGENT_TOKEN_FACTORY_RUNTIME_CODE_HASH || '').trim();
    if (!value) return null;
    if (!validHash(value)) throw coded('ARC_TOKEN_FACTORY_RUNTIME_HASH_INVALID');
    return value.toLowerCase();
  }

  #deploymentBlock() { return parseStartBlock(this.#env.ARC_AGENT_TOKEN_FACTORY_DEPLOYMENT_BLOCK); }

  async #callFactory(address, method, args = [], blockTag = 'latest') {
    const data = ARC_AGENT_TOKEN_FACTORY_INTERFACE.encodeFunctionData(method, args);
    const result = await this.#rpc.call({ to: address, data }, blockTag);
    return ARC_AGENT_TOKEN_FACTORY_INTERFACE.decodeFunctionResult(method, result);
  }

  async #verifyFactory({ requireSigner = false } = {}) {
    const address = this.#factoryAddress();
    const expectedCodeHash = this.#factoryRuntimeHash();
    if (!address) throw coded('ARC_TOKEN_FACTORY_NOT_CONFIGURED');
    if (!expectedCodeHash) throw coded('ARC_TOKEN_FACTORY_RUNTIME_HASH_NOT_CONFIGURED');
    const code = await this.#rpc.getCode(address, 'latest');
    if (!code || code === '0x' || keccak256(code).toLowerCase() !== expectedCodeHash) {
      throw coded('ARC_TOKEN_FACTORY_RUNTIME_CODE_MISMATCH');
    }
    const [worldId, writer, maxCreations, creationCount] = await Promise.all([
      this.#callFactory(address, 'worldId'), this.#callFactory(address, 'writer'),
      this.#callFactory(address, 'maxTokenCreationsPerWorld'), this.#callFactory(address, 'creationCount')
    ]);
    if (String(worldId[0]).toLowerCase() !== toArcBytes16Uuid(this.#worldId).toLowerCase()) {
      throw coded('ARC_TOKEN_FACTORY_WORLD_MISMATCH');
    }
    if (Number(maxCreations[0]) < 1 || Number(maxCreations[0]) > 0xffff_ffff) throw coded('ARC_TOKEN_FACTORY_LIMIT_INVALID');
    let signerAddress = null;
    if (requireSigner) {
      assertArcInfrastructureSigner(this.#signer, this.#config);
      signerAddress = getAddress(await this.#signer.getAddress());
      if (!equalAddress(signerAddress, writer[0])) throw coded('ARC_TOKEN_FACTORY_WRITER_MISMATCH');
    }
    this.#status.factoryVerified = true;
    this.#status.factoryConfigured = true;
    this.#status.factoryAddress = address.toLowerCase();
    this.#status.onchainCreationCount = Number(creationCount[0]);
    this.#status.onchainCreationLimit = Number(maxCreations[0]);
    this.#status.factoryWriter = String(writer[0]).toLowerCase();
    return { address, signerAddress, creationCount: BigInt(creationCount[0]),
      maxCreations: BigInt(maxCreations[0]), writer: getAddress(writer[0]) };
  }

  async #indexFactoryEvents(latestBlock) {
    const address = this.#factoryAddress();
    const deploymentBlock = this.#deploymentBlock();
    if (!address || deploymentBlock === null) return { configured: false,
      reason: address ? 'factory_deployment_block_not_configured' : 'factory_not_configured' };
    const client = await this.#pool.connect();
    try {
      return await indexArcContractEvents({ client, rpc: this.#rpc, chainId: this.#config.chainId,
        sourceKey: `agent-token-factory:${address.toLowerCase()}`, worldId: this.#worldId,
        contractAddress: address,
        topic0: ARC_AGENT_TOKEN_FACTORY_INTERFACE.getEvent('AgentTokenCreated').topicHash,
        startBlock: deploymentBlock, latestBlock, maxPages: MAX_INDEX_PAGES });
    } finally { client.release(); }
  }

  async #matchingIndexedEvent(row) {
    const issuanceId = arcTokenIssuanceId(row.world_id, row.id);
    const indexed = await this.#pool.query(`SELECT payload FROM arc_indexed_events
      WHERE chain_id=$1 AND lower(emitter_address)=lower($2) AND world_id=$3
        AND event_topic0=$4 ORDER BY block_number,log_index`, [this.#config.chainId,
      this.#factoryAddress(), row.world_id,
      ARC_AGENT_TOKEN_FACTORY_INTERFACE.getEvent('AgentTokenCreated').topicHash.toLowerCase()]);
    for (const entry of indexed.rows) {
      const decoded = decodeArcAgentTokenCreated({ logs: [entry.payload] }, {
        factoryAddress: this.#factoryAddress(), worldId: row.world_id,
        issuanceId, specificationHash: row.specification_hash
      });
      if (decoded) return decoded;
    }
    return null;
  }

  async #claimIntent() {
    return withTransaction(this.#pool, async (client) => {
      const result = await client.query(`SELECT * FROM arc_token_issuance_intents
        WHERE world_id=$1 AND status='issuer_confirmed'
        ORDER BY issuer_confirmed_world_minute,id LIMIT 1 FOR UPDATE SKIP LOCKED`, [this.#worldId]);
      if (!result.rowCount) return null;
      const row = result.rows[0];
      await client.query(`UPDATE arc_token_issuance_intents SET status='preparing',preparing_started_at=now(),updated_at=now()
        WHERE world_id=$1 AND id=$2`, [this.#worldId, row.id]);
      return row;
    });
  }

  async #returnIntentToQueue(intentId, code, status = 'issuer_confirmed') {
    await this.#pool.query(`UPDATE arc_token_issuance_intents SET status=$3,preparing_started_at=NULL,
        metadata=metadata||jsonb_build_object('lastPreparationError',$4,'lastPreparationErrorAt',now()),updated_at=now()
      WHERE world_id=$1 AND id=$2 AND status='preparing'`, [this.#worldId, intentId, status, code]);
  }

  async #deferIntent(client, row, reason, maxTokenCreations = AGENT_TOKEN_PILOT_MAX_CREATIONS) {
    const saved = await client.query(`UPDATE arc_token_issuance_intents SET status='deferred',preparing_started_at=NULL,
        updated_world_minute=(SELECT world_minutes FROM world_runtime_state WHERE world_id=$1),updated_at=now(),
        metadata=metadata||jsonb_build_object('deferredReason',$3,'deferredAt',now())
      WHERE world_id=$1 AND id=$2 RETURNING *`, [this.#worldId, row.id, reason]);
    await writeWorldHistory(client, { worldId: this.#worldId, eventKey: `token-issuance-deferred:${row.id}`,
      eventType: 'token_issuance_deferred', actorAgentId: row.issuer_agent_id,
      entityType: 'agent_token_issuance', entityId: row.id,
      worldTime: saved.rows[0]?.updated_world_minute || row.updated_world_minute,
      title: 'Token issuance deferred by current capability limit',
      detail: 'The Agent-authored issuance intent remains saved for a future multi-token capability.',
      metadata: { intentId: row.id, reason, capabilityGeneration: row.capability_generation,
        maxTokenCreations } });
    return saved.rows[0];
  }

  async #prepare(row, factory) {
    const spec = intentSpecification(row);
    const issuanceId = arcTokenIssuanceId(row.world_id, row.id);
    const existingToken = await this.#callFactory(factory.address, 'tokenForIssuance', [issuanceId]);
    if (existingToken[0] !== '0x0000000000000000000000000000000000000000') {
      await this.#pool.query(`UPDATE arc_token_issuance_intents SET status='submission_unknown',
          submission_start_block=COALESCE(submission_start_block,$3),preparing_started_at=NULL,
          metadata=metadata||jsonb_build_object('factoryAlreadyKnowsIssuance',true),updated_at=now()
        WHERE world_id=$1 AND id=$2 AND status='preparing'`,
      [this.#worldId, row.id, this.#deploymentBlock() || '0']);
      return { processed: true, status: 'submission_unknown', reason: 'factory_mapping_preexisting' };
    }
    const capabilityResult = await this.#pool.query(`SELECT capability_generation,max_token_creations
      FROM arc_token_pilot_capabilities WHERE world_id=$1 AND status='active'
      ORDER BY capability_generation DESC LIMIT 1`, [this.#worldId]);
    if (!capabilityResult.rowCount) throw coded('TOKEN_ACTIVE_CAPABILITY_NOT_FOUND');
    const activeGeneration = Number(capabilityResult.rows[0].capability_generation);
    if (!Number.isSafeInteger(activeGeneration) || activeGeneration < Number(row.capability_generation)) {
      throw coded('TOKEN_INTENT_CAPABILITY_GENERATION_UNAVAILABLE');
    }
    const occupiedResult = await this.#pool.query(`SELECT
        (SELECT count(*) FROM arc_agent_tokens WHERE world_id=$1) +
        (SELECT count(*) FROM arc_token_issuance_intents WHERE world_id=$1 AND id<>$2 AND status IN
          ('issuer_confirmed','preparing','prepared','submitting','submission_unknown','submitted')) AS count`,
    [this.#worldId, row.id]);
    const capacity = inspectAgentTokenCreationCapacity({ capabilityGeneration: activeGeneration,
      capabilityMaxCreations: capabilityResult.rows[0].max_token_creations,
      factoryMaxCreations: factory.maxCreations, factoryCreationCount: factory.creationCount,
      worldOccupiedCreations: occupiedResult.rows[0]?.count || 0 });
    if (capacity.reached) {
      const deferred = await withTransaction(this.#pool, (client) => this.#deferIntent(client, row,
        'CURRENT_CAPABILITY_LIMIT_REACHED', capacity.maxCreations.toString()));
      return { processed: true, status: deferred.status, reason: 'CURRENT_CAPABILITY_LIMIT_REACHED' };
    }

    const worldMinute = BigInt(row.issuer_confirmed_world_minute);
    const prepared = buildArcAgentTokenFactoryTransaction({ factoryAddress: factory.address,
      worldId: this.#worldId, intentId: row.id, issuerAgentId: row.issuer_agent_id,
      issuerIdentityId: row.issuer_identity_id, issuerWallet: row.issuer_wallet,
      specification: spec, worldMinute });
    const chainId = await this.#rpc.getChainId();
    assertArcChainId(chainId, this.#config);
    const [block, tipHex, pendingNonceHex, estimatedGasHex, signerBalanceHex] = await Promise.all([
      this.#rpc.getBlock('latest', false), this.#rpc.maxPriorityFeePerGas(),
      this.#rpc.getTransactionCount(factory.signerAddress, 'pending'),
      this.#rpc.estimateGas({ from: factory.signerAddress, to: factory.address,
        value: '0x0', data: prepared.data }), this.#rpc.getBalance(factory.signerAddress, 'latest')
    ]);
    if (!block?.baseFeePerGas || !block.number) throw coded('ARC_BASE_FEE_UNAVAILABLE');
    const fees = buildArcEip1559FeeFields({ baseFeePerGas: BigInt(block.baseFeePerGas),
      maxPriorityFeePerGas: BigInt(tipHex), recommendedMinimum: this.#config.maxFeePerGasRecommendation });
    const estimatedGas = BigInt(estimatedGasHex);
    const gasLimit = estimatedGas + estimatedGas / 5n + 1n;
    const gasCeilingWei = gasLimit * fees.maxFeePerGas;
    if (BigInt(signerBalanceHex) < gasCeilingWei) throw coded('INSUFFICIENT_MAINNET_GAS_BALANCE');
    const startBlock = BigInt(block.number) + 1n;
    const pendingNonce = BigInt(pendingNonceHex);
    await withTransaction(this.#pool, async (client) => {
      const locked = await client.query(`SELECT status FROM arc_token_issuance_intents
        WHERE world_id=$1 AND id=$2 FOR UPDATE`, [this.#worldId, row.id]);
      if (locked.rows[0]?.status !== 'preparing') throw coded('TOKEN_ISSUANCE_STATE_CHANGED');
      const nonce = await reserveArcInfrastructureNonce(client, { chainId: ARC_MAINNET_CHAIN_ID,
        address: factory.signerAddress, operationType: 'token_creation', operationId: String(row.id),
        pendingNonce, startBlock });
      await reserveArcMainnetPilotCost(client, { operationType: 'token_creation', operationId: String(row.id),
        worldId: this.#worldId, transferUsdcBaseUnits: 0n, gasLimit, maxFeePerGas: fees.maxFeePerGas });
      const fullTransaction = { ...prepared, from: factory.signerAddress, nonce: nonce.nonce,
        gasLimit, maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas };
      const saved = await client.query(`UPDATE arc_token_issuance_intents SET status='prepared',preparing_started_at=NULL,
          nonce=$3,gas_limit=$4,max_fee_per_gas=$5,submission_start_block=$6,
          transaction_sender=$7,prepared_calldata=$8,metadata=metadata||$9::jsonb,updated_at=now()
        WHERE world_id=$1 AND id=$2 AND status='preparing' RETURNING id`, [this.#worldId, row.id,
        nonce.nonce.toString(), gasLimit.toString(), fees.maxFeePerGas.toString(), startBlock.toString(),
        factory.signerAddress, fullTransaction.data,
        JSON.stringify({ maxPriorityFeePerGas: fees.maxPriorityFeePerGas.toString(),
          quotedBaseFeePerGas: BigInt(block.baseFeePerGas).toString(), estimatedGas: estimatedGas.toString(),
          reservedCostUsdcBaseUnits: (await client.query(`SELECT reserved_cost_usdc_base_units::text AS amount
            FROM arc_mainnet_pilot_cost_reservations WHERE operation_type='token_creation' AND operation_id=$1`,
          [String(row.id)])).rows[0]?.amount || null })]);
      if (!saved.rowCount) throw coded('TOKEN_ISSUANCE_STATE_CHANGED');
    });
    return { processed: true, status: 'prepared', intentId: row.id,
      gasLimit: gasLimit.toString(), maxFeePerGas: fees.maxFeePerGas.toString() };
  }

  async #claimPrepared() {
    return withTransaction(this.#pool, async (client) => {
      const result = await client.query(`SELECT * FROM arc_token_issuance_intents
        WHERE world_id=$1 AND status='prepared' ORDER BY issuer_confirmed_world_minute,id
        LIMIT 1 FOR UPDATE SKIP LOCKED`, [this.#worldId]);
      return result.rows[0] || null;
    });
  }

  async #returnPreparedToQueue(row, reason) {
    return withTransaction(this.#pool, async (client) => {
      const updated = await client.query(`UPDATE arc_token_issuance_intents SET status='issuer_confirmed',
          nonce=NULL,gas_limit=NULL,max_fee_per_gas=NULL,submission_start_block=NULL,transaction_sender=NULL,
          prepared_calldata=NULL,preparing_started_at=NULL,
          metadata=metadata||jsonb_build_object('lastPreSubmitError',$3,'lastPreSubmitErrorAt',now()),updated_at=now()
        WHERE world_id=$1 AND id=$2 AND status='prepared' RETURNING id`, [this.#worldId, row.id, reason]);
      if (!updated.rowCount) throw coded('TOKEN_ISSUANCE_STATE_CHANGED');
      const nonceReleased = await releaseArcInfrastructureNonce(client, { operationType: 'token_creation',
        operationId: String(row.id) });
      const budgetReleased = await releaseArcMainnetPilotCost(client, { operationType: 'token_creation',
        operationId: String(row.id) });
      if (!nonceReleased || !budgetReleased) throw coded('TOKEN_PRE_SUBMIT_RESERVATION_MISSING');
      return { processed: true, status: 'issuer_confirmed', intentId: row.id, reason };
    });
  }

  async #submit(row, factory) {
    let signerAddress;
    let transaction;
    try {
      signerAddress = getAddress(await this.#signer.getAddress());
      if (!equalAddress(signerAddress, row.transaction_sender) || !equalAddress(signerAddress, factory.writer)) {
        throw coded('ARC_TOKEN_FACTORY_WRITER_MISMATCH');
      }
      transaction = { chainId: ARC_MAINNET_CHAIN_ID, to: factory.address, from: signerAddress,
        value: 0n, data: row.prepared_calldata, nonce: BigInt(row.nonce), gasLimit: BigInt(row.gas_limit),
        maxFeePerGas: BigInt(row.max_fee_per_gas), maxPriorityFeePerGas: BigInt(row.metadata?.maxPriorityFeePerGas) };
      const signerBalance = BigInt(await this.#rpc.getBalance(signerAddress, 'latest'));
      if (signerBalance < transaction.gasLimit * transaction.maxFeePerGas) {
        throw coded('INSUFFICIENT_MAINNET_GAS_BALANCE');
      }
    } catch (error) {
      return this.#returnPreparedToQueue(row, safeCode(error));
    }
    const attemptId = randomUUID();
    await withTransaction(this.#pool, async (client) => {
      const claim = await client.query(`UPDATE arc_token_issuance_intents SET status='submitting',
          submission_attempt_id=$3,submission_started_at=now(),updated_at=now()
        WHERE world_id=$1 AND id=$2 AND status='prepared' RETURNING id`, [this.#worldId, row.id, attemptId]);
      if (!claim.rowCount) throw coded('TOKEN_ISSUANCE_STATE_CHANGED');
      await markArcInfrastructureNonce(client, { operationType: 'token_creation',
        operationId: String(row.id), status: 'submitting' });
      await setArcMainnetPilotCostStatus(client, { operationType: 'token_creation',
        operationId: String(row.id), status: 'submitting' });
    });
    try {
      const response = await this.#signer.sendTransaction(transaction);
      if (!validHash(response?.hash)) throw coded('ARC_SIGNER_TRANSACTION_HASH_MISSING');
      await withTransaction(this.#pool, async (client) => {
        await client.query(`UPDATE arc_token_issuance_intents SET status='submitted',transaction_hash=$3,
            updated_at=now() WHERE world_id=$1 AND id=$2 AND status='submitting'`,
        [this.#worldId, row.id, response.hash]);
        await markArcInfrastructureNonce(client, { operationType: 'token_creation', operationId: String(row.id),
          status: 'submitted', transactionHash: response.hash });
        await setArcMainnetPilotCostStatus(client, { operationType: 'token_creation',
          operationId: String(row.id), status: 'submitted', transactionHash: response.hash });
      });
      return { processed: true, status: 'submitted', intentId: row.id, transactionHash: response.hash };
    } catch (error) {
      await withTransaction(this.#pool, async (client) => {
        await client.query(`UPDATE arc_token_issuance_intents SET status='submission_unknown',updated_at=now(),
            metadata=metadata||jsonb_build_object('lastSubmissionError',$3,'lastSubmissionErrorAt',now())
          WHERE world_id=$1 AND id=$2 AND status='submitting'`, [this.#worldId, row.id, safeCode(error)]);
        await markArcInfrastructureNonce(client, { operationType: 'token_creation', operationId: String(row.id),
          status: 'submission_unknown' });
        await setArcMainnetPilotCostStatus(client, { operationType: 'token_creation',
          operationId: String(row.id), status: 'submission_unknown' });
      });
      return { processed: true, status: 'submission_unknown', intentId: row.id, reason: safeCode(error) };
    }
  }

  async #pendingIntents() {
    const result = await this.#pool.query(`SELECT * FROM arc_token_issuance_intents
      WHERE world_id=$1 AND status IN ('submitted','submission_unknown')
      ORDER BY issuer_confirmed_world_minute,id LIMIT 50`, [this.#worldId]);
    return result.rows;
  }

  async #recoverInterruptedWork() {
    return withTransaction(this.#pool, async (client) => {
      const preparing = await client.query(`UPDATE arc_token_issuance_intents SET status='issuer_confirmed',
          preparing_started_at=NULL,metadata=metadata||jsonb_build_object('recoveredInterruptedPreparationAt',now()),updated_at=now()
        WHERE world_id=$1 AND status='preparing' AND preparing_started_at < now()-interval '2 minutes'
        RETURNING id`, [this.#worldId]);
      const submitting = await client.query(`UPDATE arc_token_issuance_intents SET status='submission_unknown',
          metadata=metadata||jsonb_build_object('recoveredInterruptedSubmissionAt',now()),updated_at=now()
        WHERE world_id=$1 AND status='submitting' AND submission_started_at < now()-interval '30 seconds'
        RETURNING id`, [this.#worldId]);
      for (const row of submitting.rows) {
        await markArcInfrastructureNonce(client, { operationType: 'token_creation',
          operationId: String(row.id), status: 'submission_unknown' });
        await setArcMainnetPilotCostStatus(client, { operationType: 'token_creation',
          operationId: String(row.id), status: 'submission_unknown' });
      }
      return { preparation: preparing.rowCount, submission: submitting.rowCount };
    });
  }

  async #verifyCreatedToken(row, receipt, expectedEvent, factory) {
    const issuanceId = arcTokenIssuanceId(row.world_id, row.id);
    const event = decodeArcAgentTokenCreated(receipt, { factoryAddress: factory.address,
      worldId: this.#worldId, issuanceId, specificationHash: row.specification_hash });
    if (!event) throw coded('TOKEN_CREATION_EVENT_MISSING_OR_MISMATCHED');
    if (expectedEvent && (event.transactionHash !== expectedEvent.transactionHash
        || event.tokenAddress !== expectedEvent.tokenAddress
        || event.creationSequence !== expectedEvent.creationSequence)) throw coded('TOKEN_CREATION_INDEX_RECEIPT_MISMATCH');
    if (!equalAddress(event.transactionSender, row.transaction_sender)
        || event.capabilityGeneration !== Number(row.capability_generation)
        || event.creationSequence < 1
        || event.issuerAgentId.toLowerCase() !== toArcBytes16Uuid(row.issuer_agent_id).toLowerCase()
        || event.issuerIdentityId !== String(row.issuer_identity_id)
        || !equalAddress(event.issuerWallet, row.issuer_wallet)
        || event.specificationHash.toLowerCase() !== row.specification_hash.toLowerCase()) {
      throw coded('TOKEN_CREATION_PROVENANCE_MISMATCH');
    }
    const spec = intentSpecification(row);
    if (event.initialSupplyRaw !== spec.totalSupplyRaw.toString()
        || event.decimals !== Number(row.decimals)
        || event.unallocatedSupplyHandling !== spec.unallocatedSupplyHandlingId
        || event.ownershipModel !== spec.ownershipModelId
        || event.authorityModel !== spec.authorityModelId
        || event.worldMinute !== String(row.issuer_confirmed_world_minute)) throw coded('TOKEN_CREATION_SUPPLY_OR_MINUTE_MISMATCH');
    const code = await this.#rpc.getCode(event.tokenAddress, 'latest');
    if (!code || code === '0x') throw coded('CREATED_TOKEN_RUNTIME_CODE_MISSING');
    const verificationBlockTag = `0x${BigInt(receipt.blockNumber).toString(16)}`;
    const [factoryToken, factorySpecificationHash, factoryCreationCount] = await Promise.all([
      this.#callFactory(factory.address, 'tokenForIssuance', [issuanceId], verificationBlockTag),
      this.#callFactory(factory.address, 'specificationForIssuance', [issuanceId], verificationBlockTag),
      this.#callFactory(factory.address, 'creationCount', [], verificationBlockTag)
    ]);
    if (!equalAddress(factoryToken[0], event.tokenAddress)
        || String(factorySpecificationHash[0]).toLowerCase() !== row.specification_hash.toLowerCase()
        || BigInt(factoryCreationCount[0]) < BigInt(event.creationSequence)) {
      throw coded('TOKEN_FACTORY_MAPPING_MISMATCH');
    }
    const read = async (method) => {
      const data = ARC_AGENT_TOKEN_INTERFACE.encodeFunctionData(method);
      const output = await this.#rpc.call({ to: event.tokenAddress, data }, verificationBlockTag);
      return ARC_AGENT_TOKEN_INTERFACE.decodeFunctionResult(method, output)[0];
    };
    const [onchainWorldId, onchainGeneration, onchainIssuanceId, onchainIssuerId, onchainIdentity,
      onchainWallet, onchainSpecificationHash, onchainWorldMinute, onchainInitialSupply,
      onchainName, onchainSymbol, onchainDecimals, onchainTotalSupply, onchainReservedSupply,
      onchainHandling, onchainOwnership, onchainAuthority] = await Promise.all([
      read('worldId'), read('capabilityGeneration'), read('issuanceId'), read('issuerAgentId'),
      read('issuerIdentityId'), read('issuerWallet'), read('specificationHash'), read('createdWorldMinute'),
      read('initialSupply'), read('name'), read('symbol'), read('decimals'), read('totalSupply'),
      read('reservedSupply'), read('unallocatedSupplyHandling'), read('ownershipModel'), read('authorityModel')
    ]);
    if (String(onchainWorldId).toLowerCase() !== toArcBytes16Uuid(this.#worldId).toLowerCase()
        || Number(onchainGeneration) !== Number(row.capability_generation)
        || String(onchainIssuanceId).toLowerCase() !== issuanceId.toLowerCase()
        || String(onchainIssuerId).toLowerCase() !== toArcBytes16Uuid(row.issuer_agent_id).toLowerCase()
        || String(onchainIdentity) !== String(row.issuer_identity_id)
        || !equalAddress(onchainWallet, row.issuer_wallet)
        || String(onchainSpecificationHash).toLowerCase() !== row.specification_hash.toLowerCase()
        || BigInt(onchainWorldMinute) !== BigInt(row.issuer_confirmed_world_minute)
        || BigInt(onchainInitialSupply) !== spec.totalSupplyRaw
        || String(onchainName) !== row.name || String(onchainSymbol) !== row.symbol
        || Number(onchainDecimals) !== Number(row.decimals)
        || BigInt(onchainTotalSupply) !== spec.totalSupplyRaw || BigInt(onchainReservedSupply) !== spec.reserveRaw
        || Number(onchainHandling) !== spec.unallocatedSupplyHandlingId
        || Number(onchainOwnership) !== spec.ownershipModelId || Number(onchainAuthority) !== spec.authorityModelId) {
      throw coded('TOKEN_CONTRACT_STATE_MISMATCH');
    }
    const balances = await Promise.all(spec.distribution.map(async (recipient) => {
      const output = await this.#rpc.call({ to: event.tokenAddress,
        data: ARC_AGENT_TOKEN_INTERFACE.encodeFunctionData('balanceOf', [recipient.recipientAddress]) }, verificationBlockTag);
      return BigInt(ARC_AGENT_TOKEN_INTERFACE.decodeFunctionResult('balanceOf', output)[0]);
    }));
    if (balances.some((balance, index) => balance < spec.distribution[index].amountRaw)) {
      throw coded('TOKEN_DISTRIBUTION_BALANCE_MISMATCH');
    }
    const reserveBalanceOutput = await this.#rpc.call({ to: event.tokenAddress,
      data: ARC_AGENT_TOKEN_INTERFACE.encodeFunctionData('balanceOf', [event.tokenAddress]) }, verificationBlockTag);
    const reserveBalance = BigInt(ARC_AGENT_TOKEN_INTERFACE.decodeFunctionResult('balanceOf', reserveBalanceOutput)[0]);
    if (reserveBalance !== spec.reserveRaw) throw coded('TOKEN_RESERVE_BALANCE_MISMATCH');
    return { event, spec };
  }

  async #finalize(row, receipt, expectedEvent, factory) {
    if (receipt?.status === undefined || receipt?.status === null) throw coded('ARC_TOKEN_RECEIPT_STATUS_UNAVAILABLE');
    if (!receiptSucceeded(receipt)) return this.#recordFailedReceipt(row, receipt, 'ARC_TOKEN_CREATION_REVERTED');
    const { event, spec } = await this.#verifyCreatedToken(row, receipt, expectedEvent, factory);
    const receiptHash = String(receipt.transactionHash || expectedEvent?.transactionHash || row.transaction_hash).toLowerCase();
    if (!validHash(receiptHash) || (row.transaction_hash && row.transaction_hash.toLowerCase() !== receiptHash)) {
      throw coded('TOKEN_CREATION_TRANSACTION_HASH_MISMATCH');
    }
    const blockNumber = BigInt(receipt.blockNumber ?? expectedEvent?.blockNumber).toString();
    const gasUsed = BigInt(receipt.gasUsed).toString();
    const effectiveGasPrice = BigInt(receipt.effectiveGasPrice).toString();
    return withTransaction(this.#pool, async (client) => {
      if (event.capabilityGeneration === 1) {
        await lockGenesisCurrencyActivation(client, this.#worldId);
      }
      let genesisAssignment = null;
      if (event.capabilityGeneration === 1) {
        const assignment = await client.query(`SELECT issuer_agent_id,selection_source
          FROM world_genesis_issuer_assignments WHERE world_id=$1 AND capability_generation=1 FOR SHARE`, [this.#worldId]);
        genesisAssignment = assignment.rows[0] || null;
        if (!genesisAssignment || genesisAssignment.issuer_agent_id !== row.issuer_agent_id
            || genesisAssignment.selection_source !== row.issuer_selection_source
            || genesisAssignment.selection_source !== 'creator_genesis_assignment') {
          throw coded('CURRENCY_GENESIS_ISSUER_PROVENANCE_MISMATCH');
        }
      }
      const insertion = await client.query(`INSERT INTO arc_agent_tokens(world_id,intent_id,capability_generation,
          creation_sequence,chain_id,token_address,name,symbol,decimals,initial_supply_raw,reserve_supply_raw,
          issuer_agent_id,issuer_identity_id,issuer_wallet,transaction_sender,specification_hash,transaction_hash,
          block_number,log_index,created_world_minute,metadata,factory_address)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21::jsonb,$22)
        ON CONFLICT(world_id,intent_id) DO NOTHING RETURNING *`, [this.#worldId, row.id,
        event.capabilityGeneration, event.creationSequence, ARC_MAINNET_CHAIN_ID, event.tokenAddress,
        row.name, row.symbol, row.decimals, spec.totalSupplyRaw.toString(), spec.reserveRaw.toString(),
        row.issuer_agent_id, row.issuer_identity_id, row.issuer_wallet, event.transactionSender,
        row.specification_hash, receiptHash, blockNumber, event.logIndex,
        row.issuer_confirmed_world_minute,
        JSON.stringify({ humanSupply: AGENT_TOKEN_HUMAN_SUPPLY,
          issuerMeaning: row.meaning, purpose: row.purpose, rationale: row.rationale,
          createdWorldMinute: event.worldMinute }), factory.address.toLowerCase()]);
      let token = insertion.rows[0];
      if (!token) {
        token = (await client.query(`SELECT * FROM arc_agent_tokens WHERE world_id=$1 AND intent_id=$2 FOR UPDATE`,
          [this.#worldId, row.id])).rows[0];
        if (!token || !equalAddress(token.token_address, event.tokenAddress)
            || !equalAddress(token.factory_address, factory.address)
            || token.transaction_hash.toLowerCase() !== receiptHash
            || token.specification_hash.toLowerCase() !== row.specification_hash.toLowerCase()
            || Number(token.capability_generation) !== event.capabilityGeneration
            || Number(token.creation_sequence) !== event.creationSequence
            || token.issuer_agent_id !== row.issuer_agent_id
            || String(token.issuer_identity_id) !== String(row.issuer_identity_id)
            || !equalAddress(token.issuer_wallet, row.issuer_wallet)
            || !equalAddress(token.transaction_sender, event.transactionSender)
            || Number(token.log_index) !== event.logIndex
            || String(token.block_number) !== blockNumber) {
          throw coded('TOKEN_CREATION_DATABASE_IDEMPOTENCY_CONFLICT');
        }
      }
      const completedIntent = await client.query(`UPDATE arc_token_issuance_intents SET status='created',creation_sequence=$3,
          transaction_hash=$4,transaction_block=$5,transaction_log_index=$6,transaction_sender=$7,
          preparing_started_at=NULL,updated_world_minute=GREATEST(updated_world_minute,$8),updated_at=now(),
          metadata=metadata||jsonb_build_object('createdTokenId',$9,'createdTokenAddress',$10)
        WHERE world_id=$1 AND id=$2 AND status IN ('submitting','submission_unknown','submitted','created') RETURNING id`,
      [this.#worldId, row.id, event.creationSequence, receiptHash, blockNumber, event.logIndex,
        event.transactionSender, event.worldMinute, token.id, event.tokenAddress]);
      if (!completedIntent.rowCount) throw coded('TOKEN_CREATION_INTENT_STATE_MISMATCH');
      if (event.capabilityGeneration === 1) {
        const satisfied = await client.query(`UPDATE arc_currency_genesis_requirements SET status='SATISFIED',
            current_proposal_id=$2,satisfied_token_id=$3,satisfied_world_minute=$4,
            last_transition_world_minute=$4,updated_at=now()
          WHERE world_id=$1 AND capability_generation=1
            AND (status<>'SATISFIED' OR satisfied_token_id=$3)
          RETURNING satisfied_token_id`, [this.#worldId, row.id, token.id, event.worldMinute]);
        if (!satisfied.rowCount) {
          const existingRequirement = await client.query(`SELECT status,satisfied_token_id
            FROM arc_currency_genesis_requirements WHERE world_id=$1 AND capability_generation=1`, [this.#worldId]);
          if (!existingRequirement.rowCount || existingRequirement.rows[0].status !== 'SATISFIED'
              || existingRequirement.rows[0].satisfied_token_id !== token.id) {
            throw coded('CURRENCY_GENESIS_RECONCILIATION_STATE_MISMATCH');
          }
        }
        const activation = await client.query(`INSERT INTO world_genesis_currency_activations(world_id,
            capability_generation,token_id,chain_id,issuer_agent_id,issuer_selection_source,transaction_hash,
            block_number,world_minute,creator_allocation_raw)
          VALUES($1,1,$2,$3,$4,'creator_genesis_assignment',$5,$6,$7,0)
          ON CONFLICT(world_id) DO NOTHING RETURNING token_id`,
        [this.#worldId, token.id, ARC_MAINNET_CHAIN_ID, row.issuer_agent_id, receiptHash, blockNumber, event.worldMinute]);
        if (!activation.rowCount) {
          const existingActivation = await client.query(`SELECT token_id,issuer_agent_id,issuer_selection_source,
              transaction_hash,block_number::text AS block_number,creator_allocation_raw::text AS creator_allocation_raw
            FROM world_genesis_currency_activations WHERE world_id=$1`, [this.#worldId]);
          const savedActivation = existingActivation.rows[0];
          if (!savedActivation || savedActivation.token_id !== token.id
              || savedActivation.issuer_agent_id !== row.issuer_agent_id
              || savedActivation.issuer_selection_source !== 'creator_genesis_assignment'
              || savedActivation.transaction_hash.toLowerCase() !== receiptHash
              || String(savedActivation.block_number) !== blockNumber
              || String(savedActivation.creator_allocation_raw) !== '0') {
            throw coded('GENESIS_CURRENCY_ACTIVATION_IDEMPOTENCY_CONFLICT');
          }
        }
        await writeWorldHistory(client, { worldId: this.#worldId,
          eventKey: `genesis-currency-activated:${token.id}`, eventType: 'genesis_currency_activated',
          actorAgentId: null, entityType: 'genesis_currency', entityId: token.id,
          worldTime: event.worldMinute, title: 'GENESIS_CURRENCY_ACTIVATED',
          detail: 'The Agent-authored Genesis Token was confirmed on Arc Mainnet, its issuance was reconciled, and the world economy crossed into the token era.',
          metadata: { semanticEvent: 'GENESIS_CURRENCY_ACTIVATED', tokenId: token.id,
            tokenAddress: event.tokenAddress, chainId: ARC_MAINNET_CHAIN_ID, transactionHash: receiptHash,
            blockNumber, specificationHash: row.specification_hash, issuerAgentId: row.issuer_agent_id,
            issuerSelectionSource: genesisAssignment.selection_source, creatorAllocationRaw: '0' } });
      }
      await markArcInfrastructureNonce(client, { operationType: 'token_creation',
        operationId: String(row.id), status: 'reconciled', transactionHash: receiptHash });
      await settleArcMainnetPilotCost(client, { operationType: 'token_creation', operationId: String(row.id),
        receiptStatus: receipt.status, gasUsed, effectiveGasPrice });
      await writeWorldHistory(client, { worldId: this.#worldId,
        eventKey: `token-issuance-created:${row.id}`, eventType: 'agent_token_created',
        actorAgentId: row.issuer_agent_id, entityType: 'agent_token', entityId: token.id,
        worldTime: event.worldMinute, title: `Agent created ${row.name} (${row.symbol})`,
        detail: 'The issuer-authored token was verified from the Arc Mainnet receipt and contract state.',
        metadata: { intentId: row.id, tokenAddress: event.tokenAddress, transactionHash: receiptHash,
          factoryAddress: factory.address.toLowerCase(), transactionSender: event.transactionSender, issuerAgentId: row.issuer_agent_id,
          issuerIdentityId: String(row.issuer_identity_id), issuerWallet: row.issuer_wallet,
          specificationHash: row.specification_hash, initialSupplyHuman: AGENT_TOKEN_HUMAN_SUPPLY,
          initialSupplyRaw: spec.totalSupplyRaw.toString(), decimals: Number(row.decimals),
          creationSequence: event.creationSequence, blockNumber, logIndex: event.logIndex } });
      return { processed: true, status: 'created', intentId: row.id,
        tokenAddress: event.tokenAddress, transactionHash: receiptHash };
    });
  }

  async #recordFailedReceipt(row, receipt, failureCode) {
    const gasUsed = BigInt(receipt.gasUsed ?? 0).toString();
    const effectiveGasPrice = BigInt(receipt.effectiveGasPrice ?? row.max_fee_per_gas ?? 0).toString();
    return withTransaction(this.#pool, async (client) => {
      await client.query(`UPDATE arc_token_issuance_intents SET status='failed',transaction_block=$3,
          metadata=metadata||jsonb_build_object('failureCode',$4),updated_at=now()
        WHERE world_id=$1 AND id=$2 AND status IN ('submitting','submission_unknown','submitted')`,
      [this.#worldId, row.id, receipt.blockNumber ? BigInt(receipt.blockNumber).toString() : null, failureCode]);
      await markArcInfrastructureNonce(client, { operationType: 'token_creation',
        operationId: String(row.id), status: 'failed', transactionHash: receipt.transactionHash || null });
      await settleArcMainnetPilotCost(client, { operationType: 'token_creation', operationId: String(row.id),
        receiptStatus: receipt.status, gasUsed, effectiveGasPrice });
      await writeWorldHistory(client, { worldId: this.#worldId,
        eventKey: `token-issuance-failed:${row.id}`, eventType: 'agent_token_creation_failed',
        actorAgentId: row.issuer_agent_id, entityType: 'agent_token_issuance', entityId: row.id,
        worldTime: row.issuer_confirmed_world_minute,
        title: 'Agent token creation failed on Arc Mainnet',
        detail: 'The creation transaction reverted; the issuer intent and receipt remain recorded.',
        metadata: { intentId: row.id, failureCode, transactionHash: receipt.transactionHash || row.transaction_hash || null,
          blockNumber: receipt.blockNumber ? BigInt(receipt.blockNumber).toString() : null } });
      return { processed: true, status: 'failed', intentId: row.id, reason: failureCode };
    });
  }

  async #reconcilePending(factory) {
    const results = [];
    const pending = await this.#pendingIntents();
    for (const row of pending) {
      let candidate = null;
      if (!row.transaction_hash) candidate = await this.#matchingIndexedEvent(row);
      const transactionHash = row.transaction_hash || candidate?.transactionHash || null;
      if (!transactionHash) continue;
      if (candidate && !row.transaction_hash) {
        await withTransaction(this.#pool, async (client) => {
          await client.query(`UPDATE arc_token_issuance_intents SET status='submitted',transaction_hash=$3,updated_at=now()
            WHERE world_id=$1 AND id=$2 AND status='submission_unknown'`, [this.#worldId, row.id, candidate.transactionHash]);
          await markArcInfrastructureNonce(client, { operationType: 'token_creation',
            operationId: String(row.id), status: 'submitted', transactionHash: candidate.transactionHash });
          await setArcMainnetPilotCostStatus(client, { operationType: 'token_creation',
            operationId: String(row.id), status: 'submitted', transactionHash: candidate.transactionHash });
        });
      }
      const receipt = await this.#rpc.getTransactionReceipt(transactionHash);
      if (!receipt) continue;
      results.push(await this.#finalize(row, receipt, candidate, factory));
    }
    return results;
  }

  async #process() {
    if (this.#active || !this.#status.running || !this.#isOwner()) return;
    this.#active = true;
    try {
      this.#status.factoryConfigured = Boolean(this.#factoryAddress());
      this.#status.factoryVerified = false;
      const chainId = await this.#rpc.getChainId();
      assertArcChainId(chainId, this.#config);
      const recovered = await this.#recoverInterruptedWork();
      let indexed = { configured: false, reason: 'factory_not_configured' };
      let factory = null;
      if (this.#status.factoryConfigured) {
        factory = await this.#verifyFactory({ requireSigner: this.#config.writesEnabled && Boolean(this.#signer) });
        const latestBlock = await this.#rpc.getBlockNumber();
        indexed = await this.#indexFactoryEvents(latestBlock);
        const reconciled = await this.#reconcilePending(factory);
        this.#status.lastResult = { indexed, recovered, reconciled: reconciled.length,
          created: reconciled.filter((entry) => entry.status === 'created').length };
      } else {
        this.#status.lastResult = { indexed, recovered, reconciled: 0, created: 0 };
      }
      const canWrite = Boolean(this.#config.writesEnabled && this.#signer && factory);
      this.#status.writesEnabled = Boolean(this.#config.writesEnabled);
      this.#status.mode = canWrite ? 'mainnet_write_enabled' : 'read_only_reconciliation';
      if (!canWrite) {
        this.#status.reason = !this.#config.writesEnabled ? 'mainnet_write_gate_closed'
          : !this.#signer ? 'infrastructure_signer_not_configured' : 'token_factory_not_configured';
      } else {
        const row = await this.#claimPrepared();
        if (row) this.#status.lastResult.submission = await this.#submit(row, factory);
        else {
          const intent = await this.#claimIntent();
          if (intent) {
            try { this.#status.lastResult.preparation = await this.#prepare(intent, factory); }
            catch (error) {
              const code = safeCode(error);
              const blockedByBudget = code === 'ARC_MAINNET_PILOT_COST_CAP_EXCEEDED';
              await this.#returnIntentToQueue(intent.id, code, blockedByBudget ? 'budget_blocked' : 'issuer_confirmed');
              if (blockedByBudget) this.#status.lastResult.preparation = { processed: true,
                status: 'budget_blocked', intentId: intent.id, reason: code };
              else throw error;
            }
          }
          this.#status.reason = null;
        }
      }
      this.#status.lastProcessedAt = new Date().toISOString();
      this.#status.lastError = null;
    } catch (error) {
      const code = safeCode(error);
      this.#status.lastError = { code };
      this.#status.reason = code.toLowerCase();
      this.#status.integrityFindings = code.includes('MISMATCH') || code.includes('INVALID')
        ? [{ code, worldId: this.#worldId }] : this.#status.integrityFindings;
      this.#onError({ code });
    } finally { this.#active = false; }
  }

  async start({ worldId }) {
    if (this.#timer) return this;
    if (typeof worldId !== 'string' || !/^[0-9a-f-]{36}$/i.test(worldId) || !this.#isOwner()) {
      this.#status.reason = 'world_engine_lock_not_owned';
      return this;
    }
    this.#worldId = worldId;
    this.#status.worldId = worldId;
    const lockClient = await this.#pool.connect();
    try {
      const result = await lockClient.query(`SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS acquired`,
        [`${ARC_AGENT_TOKEN_WORKER_LOCK_NAME}:${worldId}`]);
      if (!result.rows[0]?.acquired) {
        lockClient.release();
        this.#status.reason = 'another_token_issuance_worker_owns_lock';
        return this;
      }
      this.#lockClient = lockClient;
      this.#status.running = true;
      this.#status.reason = null;
    } catch (error) {
      lockClient.release();
      this.#status.reason = 'worker_lock_failed';
      this.#status.lastError = { code: safeCode(error) };
      this.#onError({ code: safeCode(error) });
      return this;
    }
    await this.#process();
    this.#timer = setInterval(() => this.#process().catch(() => {}), this.intervalMs);
    this.#timer.unref?.();
    return this;
  }

  async stop() {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    if (this.#lockClient) {
      try { await this.#lockClient.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',
        [`${ARC_AGENT_TOKEN_WORKER_LOCK_NAME}:${this.#worldId}`]); } catch { /* client release also drops the session lock */ }
      this.#lockClient.release();
      this.#lockClient = null;
    }
    this.#status.running = false;
    if (!this.#status.reason) this.#status.reason = 'worker_stopped';
  }
}

export function startArcAgentTokenIssuanceWorker(options) {
  return new ArcAgentTokenIssuanceWorker(options);
}

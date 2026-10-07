import { ARC_MAINNET_USDC_ADDRESS, arcNetworkConfig } from './config.js';
import { ArcRpcClient } from './rpc.js';
import { indexArcContractEvents, indexTrackedUsdcTransfers } from './indexer.js';
import { ARC_SETTLEMENT_INTERFACE, auditArcSettlementReceipt } from './settlement.js';

export const ARC_OBSERVER_LOCK_NAME = 'synterra-arc-read-only-observer';
export const ARC_OBSERVER_INTERVAL_MS = 60_000;

function isAddress(value) { return typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value); }
function configuredAddress(env, name) {
  const value = env[name];
  return isAddress(value) ? value : null;
}
function parsedStartBlock(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'string' && /^0x[0-9a-f]+$/i.test(value)) return BigInt(value).toString();
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value).toString();
  return null;
}
function countByStatus(rows) {
  return Object.fromEntries(rows.map((row) => [row.status, Number(row.count)]));
}
function sanitizeError(error) {
  const code = String(error?.code || 'ARC_OBSERVER_ERROR').replace(/[^A-Z0-9_]/gi, '').slice(0, 80);
  return { code, message: error?.code === 'ARC_CHAIN_ID_MISMATCH'
    ? 'Arc RPC chain ID did not match the verified network.' : 'Arc read-only observation failed.' };
}

async function readDatabaseSummary(pool, { worldId, chainId, usdcAddress, explorerUrl, rpcHealth, addresses, env }) {
  const [world, wallets, settlementGroups, checkpoints, provenance, indexer, latestSettlements, allWallets] = await Promise.all([
    pool.query(`SELECT runtime.world_minutes AS "worldMinute",runtime.last_tick_at AS "lastTickAt"
      FROM world_runtime_state runtime WHERE runtime.world_id=$1`, [worldId]),
    pool.query(`SELECT status,count(*)::int AS count FROM arc_agent_wallets
      WHERE world_id=$1 AND chain_id=$2 GROUP BY status ORDER BY status`, [worldId, chainId]),
    pool.query(`SELECT status,count(*)::int AS count,COALESCE(sum(amount_base_units),0)::text AS "amountBaseUnits"
      FROM arc_settlement_outbox WHERE world_id=$1 AND chain_id=$2 GROUP BY status ORDER BY status`, [worldId, chainId]),
    pool.query(`SELECT status,count(*)::int AS count FROM arc_world_checkpoints
      WHERE world_id=$1 AND chain_id=$2 GROUP BY status ORDER BY status`, [worldId, chainId]),
    pool.query(`SELECT status,count(*)::int AS count FROM arc_capability_provenance
      WHERE world_id=$1 AND chain_id=$2 GROUP BY status ORDER BY status`, [worldId, chainId]),
    pool.query(`SELECT source_key AS "sourceKey",last_indexed_block AS "lastIndexedBlock",updated_at AS "updatedAt"
      FROM arc_indexer_state WHERE chain_id=$1 ORDER BY source_key`, [chainId]),
    pool.query(`SELECT * FROM arc_settlement_outbox WHERE world_id=$1 AND chain_id=$2
      ORDER BY created_at DESC,id DESC LIMIT 50`, [worldId, chainId]),
    pool.query(`SELECT agent_id,address FROM arc_agent_wallets WHERE world_id=$1 AND chain_id=$2 AND status='active'
      ORDER BY agent_id`, [worldId, chainId])
  ]);

  const walletCounts = countByStatus(wallets.rows);
  const settlementCounts = countByStatus(settlementGroups.rows);
  const settlementAmounts = Object.fromEntries(settlementGroups.rows.map((row) => [row.status, row.amountBaseUnits]));
  const checkpointCounts = countByStatus(checkpoints.rows);
  const provenanceCounts = countByStatus(provenance.rows);
  const lastIndexedBlock = indexer.rows.length
    ? indexer.rows.reduce((max, row) => BigInt(row.lastIndexedBlock) > max ? BigInt(row.lastIndexedBlock) : max, 0n).toString()
    : null;
  const latestBlock = rpcHealth?.latestBlock;
  let indexerLag = null;
  const findings = [];
  if (lastIndexedBlock !== null && latestBlock !== null && latestBlock !== undefined) {
    const difference = BigInt(latestBlock) - BigInt(lastIndexedBlock);
    if (difference < 0n) findings.push({ code: 'INDEXER_CURSOR_AHEAD_OF_CHAIN_HEAD', entityType: 'indexer',
      entityId: null, detail: 'Saved block cursor is greater than the RPC head returned during this sample.' });
    else indexerLag = difference.toString();
  }

  let rpcReceiptChecks = 0;
  if (rpcHealth?.rpcHealthy) {
    for (const settlement of latestSettlements.rows.filter((row) => row.transaction_hash
      && ['submitted', 'submission_unknown', 'final'].includes(row.status)).slice(0, 20)) {
      try {
        const receipt = await addresses.rpc.getTransactionReceipt(settlement.transaction_hash);
        if (!receipt) {
          if (settlement.status === 'final') findings.push({ code: 'FINAL_SETTLEMENT_RECEIPT_MISSING',
            entityType: 'settlement', entityId: settlement.id,
            detail: 'Database says final but RPC returned no transaction receipt.' });
          continue;
        }
        rpcReceiptChecks += 1;
        const audited = auditArcSettlementReceipt(settlement, receipt);
        if (!audited.consistent) findings.push({ code: audited.finding, entityType: 'settlement',
          entityId: settlement.id, detail: 'Read-only receipt/event comparison disagrees with the saved settlement record.' });
        else if (settlement.status !== 'final') findings.push({ code: 'SETTLEMENT_RECEIPT_AWAITS_DATABASE_RECONCILIATION',
          entityType: 'settlement', entityId: settlement.id,
          detail: 'Arc receipt and settlement event are final; the database row has not been marked final.' });
      } catch {
        findings.push({ code: 'SETTLEMENT_RECEIPT_READ_FAILED', entityType: 'settlement',
          entityId: settlement.id, detail: 'Receipt could not be checked against the configured Arc RPC providers.' });
      }
    }
  }

  const deploymentBlock = parsedStartBlock(env.ARC_SETTLEMENT_DEPLOYMENT_BLOCK);
  const transferStartBlock = parsedStartBlock(env.ARC_USDC_INDEXER_START_BLOCK);
  const readinessBlockers = [];
  if (!configuredAddress(env, 'ARC_SETTLEMENT_CONTRACT_ADDRESS')) readinessBlockers.push('settlement_contract_not_deployed');
  if (!configuredAddress(env, 'ARC_WORLD_REGISTRY_ADDRESS')) readinessBlockers.push('world_registry_not_deployed');
  if (!configuredAddress(env, 'ARC_CAPABILITY_PROVENANCE_ADDRESS')) readinessBlockers.push('capability_provenance_contract_not_deployed');
  if (!allWallets.rowCount) readinessBlockers.push('no_agent_wallets_mapped');
  const walletProviderConfigured = Boolean(addresses.signerConfigured);
  if (!walletProviderConfigured) readinessBlockers.push('wallet_provider_not_configured');
  readinessBlockers.push('mainnet_write_gate_closed_in_this_build');

  const uncertainSubmissions = await pool.query(`SELECT count(*)::int AS count
    FROM arc_settlement_outbox WHERE world_id=$1 AND chain_id=$2 AND status IN ('submitting','submission_unknown')
      AND transaction_hash IS NULL`, [worldId, chainId]);
  for (const row of uncertainSubmissions.rows) {
    if (Number(row.count) > 0) findings.push({ code: 'UNKNOWN_SETTLEMENT_SUBMISSION_WITHOUT_HASH',
      entityType: 'settlement', entityId: null,
      detail: `${row.count} submission(s) may have reached the network but have no saved transaction hash; automatic retry is blocked.` });
  }

  const walletBalances = [];
  if (rpcHealth?.rpcHealthy && usdcAddress && allWallets.rowCount) {
    const decimalsCall = (address) => `0x70a08231${address.slice(2).toLowerCase().padStart(64, '0')}`;
    const balanceResults = await Promise.all(allWallets.rows.map(async (wallet) => {
      const address = String(wallet.address);
      if (!isAddress(address)) return { agentId: wallet.agent_id, address, error: 'invalid_wallet_address' };
      try {
      const [nativeBalance, tokenBalance, pendingNonce] = await Promise.all([
        addresses.rpc.getBalance(address, 'latest'),
        addresses.rpc.call({ to: usdcAddress, data: decimalsCall(address) }, 'latest'),
        addresses.rpc.getTransactionCount(address, 'pending')
      ]);
        return { agentId: wallet.agent_id, address,
          nativeGasBalanceBaseUnits: BigInt(nativeBalance).toString(),
          nativeGasDecimals: 18,
          erc20UsdcBalanceBaseUnits: BigInt(tokenBalance).toString(),
          erc20UsdcDecimals: 6,
          pendingNonce: BigInt(pendingNonce).toString(),
          sharedUnderlyingUsdcBalance: true };
      } catch {
        return { agentId: wallet.agent_id, address, error: 'wallet_balance_read_failed' };
      }
    }));
    walletBalances.push(...balanceResults);
    for (const wallet of balanceResults.filter((item) => item.error)) {
      findings.push({ code: 'ARC_WALLET_BALANCE_READ_FAILED', entityType: 'wallet',
        entityId: wallet.agentId, detail: 'A resident wallet balance could not be read from the configured Arc RPC.' });
    }
  }

  return {
    worldMinute: world.rows[0]?.worldMinute === undefined ? null : Number(world.rows[0].worldMinute),
    worldLastTickAt: world.rows[0]?.lastTickAt || null,
    wallets: { total: Object.values(walletCounts).reduce((sum, value) => sum + value, 0), byStatus: walletCounts },
    settlements: {
      byStatus: settlementCounts,
      amountBaseUnitsByStatus: settlementAmounts,
      pending: ['policy_pending','policy_checking','prepared', 'submitting', 'submission_unknown', 'submitted']
        .reduce((sum, status) => sum + Number(settlementCounts[status] || 0), 0),
      failed: Number(settlementCounts.failed || 0),
      final: Number(settlementCounts.final || 0)
    },
    checkpoints: { byStatus: checkpointCounts, total: Object.values(checkpointCounts).reduce((sum, value) => sum + value, 0) },
    capabilityProvenance: { byStatus: provenanceCounts, total: Object.values(provenanceCounts).reduce((sum, value) => sum + value, 0) },
    recentSettlements: latestSettlements.rows.map((row) => ({
      id: row.id,
      actionId: row.world_action_id,
      status: row.status,
      chainId: Number(row.chain_id),
      amountBaseUnits: row.amount_base_units === null ? null : String(row.amount_base_units),
      fromAddress: row.from_address,
      toAddress: row.to_address,
      transactionHash: row.transaction_hash,
      blockNumber: row.block_number === null ? null : String(row.block_number),
      logIndex: row.log_index,
      createdAt: row.created_at,
      transactionUrl: row.transaction_hash && /^0x[0-9a-fA-F]{64}$/.test(row.transaction_hash)
        ? `${explorerUrl}/tx/${row.transaction_hash}` : null
    })),
    indexer: { configured: indexer.rows.length > 0, sources: indexer.rows.map((row) => ({
      sourceKey: row.sourceKey, lastIndexedBlock: String(row.lastIndexedBlock), updatedAt: row.updatedAt
    })), lastIndexedBlock, lag: indexerLag },
    receiptChecks: rpcReceiptChecks,
    reconciliationFindings: findings,
    readinessBlockers,
    settlementContractAddress: configuredAddress(env, 'ARC_SETTLEMENT_CONTRACT_ADDRESS'),
    worldRegistryAddress: configuredAddress(env, 'ARC_WORLD_REGISTRY_ADDRESS'),
    capabilityProvenanceAddress: configuredAddress(env, 'ARC_CAPABILITY_PROVENANCE_ADDRESS'),
    deployerAddress: configuredAddress(env, 'ARC_DEPLOYER_ADDRESS'),
    treasuryAddress: configuredAddress(env, 'ARC_WORLD_TREASURY_ADDRESS'),
    usdcAddress,
    walletProviderConfigured,
    walletBalances,
    settlementEnabled: false,
    settlementDisableReason: 'mainnet_write_gate_closed_in_this_build',
    deploymentStartBlock: deploymentBlock,
    usdcTransferStartBlock: transferStartBlock
  };
}

export class ArcReadOnlyObserver {
  #pool;
  #config;
  #env;
  #rpc;
  #intervalMs;
  #isOwner;
  #onError;
  #signerConfigured;
  #lockClient = null;
  #timer = null;
  #sampleInProgress = false;
  #status;

  constructor({ pool, config = arcNetworkConfig(), env = process.env, rpcClient = null,
    intervalMs = ARC_OBSERVER_INTERVAL_MS, isOwner = () => true, onError = () => {}, signerConfigured = false }) {
    if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') {
      throw new TypeError('PostgreSQL pool is required for Arc observation.');
    }
    this.#pool = pool;
    this.#config = config;
    this.#env = env;
    this.#rpc = rpcClient || new ArcRpcClient({ config });
    this.#intervalMs = Math.max(15_000, Number(intervalMs) || ARC_OBSERVER_INTERVAL_MS);
    this.#isOwner = isOwner;
    this.#onError = onError;
    this.#signerConfigured = signerConfigured === true;
    this.#status = {
      available: true,
      running: false,
      mode: 'read_only',
      sourceOfTruth: 'database_and_arc_chain',
      worldId: null,
      samplingIntervalMs: this.#intervalMs,
      lastSampleAt: null,
      lastSampleWorldMinute: null,
      lastFindingCount: null,
      lastError: null,
      rpc: { configured: true, chainId: config.chainId, expectedChainId: config.chainId, rpcHealthy: false,
        provider: null, latestBlock: null, latestBlockHash: null, baseFeePerGas: null, latencyMs: null, checkedAt: null,
        error: null },
      network: { name: config.name, chainId: config.chainId, explorerUrl: config.explorerUrl },
      arcMainnet: null,
      reason: 'observer_not_started'
    };
  }

  getStatus() { return structuredClone(this.#status); }

  getArcMainnetStatus() {
    return structuredClone(this.#status.arcMainnet || {
      configured: true, chainId: this.#config.chainId, rpcHealthy: false, latestBlock: null,
      lastIndexedBlock: null, indexerLag: null, deployerAddress: null, treasuryAddress: null,
      pendingSettlements: 0, failedSettlements: 0
    });
  }

  async start({ worldId }) {
    if (this.#timer) return this;
    if (!worldId || !this.#isOwner()) {
      this.#status.reason = 'world_engine_lock_not_owned';
      return this;
    }
    const lockClient = await this.#pool.connect();
    try {
      const result = await lockClient.query(`SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS acquired,
        pg_backend_pid() AS owner_pid`, [ARC_OBSERVER_LOCK_NAME]);
      if (!result.rows[0].acquired) {
        lockClient.release();
        this.#status.reason = 'another_arc_observer_owns_lock';
        return this;
      }
      this.#lockClient = lockClient;
      this.#status.running = true;
      this.#status.reason = null;
      this.#status.worldId = worldId;
      this.#status.ownerPid = Number(result.rows[0].owner_pid);
    } catch (error) {
      lockClient.release();
      this.#status.reason = 'observer_lock_failed';
      this.#status.lastError = sanitizeError(error);
      this.#onError(error);
      return this;
    }
    await this.sample();
    this.#timer = setInterval(() => this.sample().catch((error) => this.#onError(error)), this.#intervalMs);
    this.#timer.unref();
    return this;
  }

  async #runIndexer(latestBlock) {
    const settlementContract = configuredAddress(this.#env, 'ARC_SETTLEMENT_CONTRACT_ADDRESS');
    const results = [];
    if (settlementContract) {
      const code = await this.#rpc.getCode(settlementContract, 'latest');
      if (code === '0x') return [{ configured: false, source: 'settlements', reason: 'configured_contract_has_no_code' }];
      const dbClient = await this.#pool.connect();
      try {
        results.push(await indexArcContractEvents({ client: dbClient, rpc: this.#rpc,
          chainId: this.#config.chainId, sourceKey: `settlement:${settlementContract.toLowerCase()}`,
          worldId: this.#status.worldId, contractAddress: settlementContract,
          topic0: ARC_SETTLEMENT_INTERFACE.getEvent('Settlement').topicHash,
          startBlock: parsedStartBlock(this.#env.ARC_SETTLEMENT_DEPLOYMENT_BLOCK), latestBlock,
          eventType: 'arc_settlement', maxPages: 1 }));
      } finally { dbClient.release(); }
    }
    const transferStartBlock = parsedStartBlock(this.#env.ARC_USDC_INDEXER_START_BLOCK);
    if (transferStartBlock !== null) {
      const walletRows = await this.#pool.query(`SELECT address FROM arc_agent_wallets
        WHERE world_id=$1 AND chain_id=$2 AND status='active' ORDER BY agent_id`, [this.#status.worldId, this.#config.chainId]);
      if (walletRows.rowCount) {
        const dbClient = await this.#pool.connect();
        try {
          results.push(await indexTrackedUsdcTransfers({ client: dbClient, rpc: this.#rpc,
            chainId: this.#config.chainId, sourceKey: `resident-usdc:${this.#status.worldId}`,
            worldId: this.#status.worldId, trackedWallets: walletRows.rows.map((row) => row.address),
            startBlock: transferStartBlock, latestBlock, maxPages: 1 }));
        } finally { dbClient.release(); }
      }
    }
    return results;
  }

  async sample() {
    if (!this.#status.running || this.#sampleInProgress || !this.#isOwner()) return this.getStatus();
    this.#sampleInProgress = true;
    const findings = [];
    try {
      const rpc = await this.#rpc.health();
      if (rpc.error?.code === 'ARC_CHAIN_ID_MISMATCH') findings.push({ code: 'ARC_RPC_CHAIN_ID_MISMATCH',
        entityType: 'rpc', entityId: null, detail: rpc.error.message });
      let usdc = { verified: false, address: this.#config.usdcAddress, codeNonEmpty: false, erc20Decimals: null };
      if (rpc.rpcHealthy) {
        const code = await this.#rpc.getCode(this.#config.usdcAddress, 'latest');
        const rawDecimals = await this.#rpc.call({ to: this.#config.usdcAddress, data: '0x313ce567' }, 'latest');
        const decimals = Number(BigInt(rawDecimals));
        usdc = { verified: code !== '0x' && decimals === 6, address: this.#config.usdcAddress,
          codeNonEmpty: code !== '0x', erc20Decimals: decimals };
        if (!usdc.codeNonEmpty || decimals !== 6) findings.push({ code: 'CANONICAL_USDC_RUNTIME_MISMATCH',
          entityType: 'token', entityId: ARC_MAINNET_USDC_ADDRESS,
          detail: 'USDC code or ERC-20 decimals differ from the verified reference.' });
      }
      const database = await readDatabaseSummary(this.#pool, { worldId: this.#status.worldId,
        chainId: this.#config.chainId, usdcAddress: this.#config.usdcAddress, explorerUrl: this.#config.explorerUrl,
        rpcHealth: rpc, addresses: { rpc: this.#rpc, signerConfigured: this.#signerConfigured }, env: this.#env });
      let indexerRuns = [];
      if (rpc.rpcHealthy) {
        try { indexerRuns = await this.#runIndexer(rpc.latestBlock); }
        catch (error) {
          findings.push({ code: 'ARC_INDEXER_READ_FAILED', entityType: 'indexer', entityId: null,
            detail: 'Indexer read failed; the cursor was not advanced for the failed page.' });
          this.#onError(error);
        }
      }
      findings.push(...database.reconciliationFindings);
      const deduplicatedFindings = [...new Map(findings.map((finding) =>
        [`${finding.code}:${finding.entityType}:${finding.entityId || ''}`, finding])).values()];
      const status = {
        available: true,
        running: true,
        mode: 'read_only',
        sourceOfTruth: 'database_and_arc_chain',
        worldId: this.#status.worldId,
        samplingIntervalMs: this.#intervalMs,
        lastSampleAt: new Date().toISOString(),
        lastSampleWorldMinute: database.worldMinute,
        lastFindingCount: deduplicatedFindings.length,
        lastError: null,
        rpc,
        usdc,
        network: { name: this.#config.name, chainId: this.#config.chainId, explorerUrl: this.#config.explorerUrl },
        arcMainnet: {
          configured: true,
          chainId: rpc.chainId,
          rpcHealthy: rpc.rpcHealthy,
          latestBlock: rpc.latestBlock,
          lastIndexedBlock: database.indexer.lastIndexedBlock,
          indexerLag: database.indexer.lag,
          indexerConfigured: database.indexer.configured || indexerRuns.some((run) => run.configured),
          indexerRuns,
          deployerAddress: database.deployerAddress,
          treasuryAddress: database.treasuryAddress,
          settlementContractAddress: database.settlementContractAddress,
          worldRegistryAddress: database.worldRegistryAddress,
          capabilityProvenanceAddress: database.capabilityProvenanceAddress,
          pendingSettlements: database.settlements.pending,
          failedSettlements: database.settlements.failed,
          settlementEnabled: database.settlementEnabled,
          settlementDisableReason: database.settlementDisableReason,
          usdcAddress: database.usdcAddress,
          usdcErc20Decimals: usdc.erc20Decimals,
          nativeGasDecimals: this.#config.nativeGasDecimals,
          rpcLatencyMs: rpc.latencyMs,
          lastSampleAt: null
        },
        database,
        findings: deduplicatedFindings,
        reason: rpc.rpcHealthy ? null : 'arc_rpc_unavailable'
      };
      status.arcMainnet.lastSampleAt = status.lastSampleAt;
      this.#status = status;
      return this.getStatus();
    } catch (error) {
      const safeError = sanitizeError(error);
      this.#status.lastError = safeError;
      this.#status.lastSampleAt = new Date().toISOString();
      this.#status.lastFindingCount = null;
      this.#status.reason = safeError.code === 'ARC_CHAIN_ID_MISMATCH' ? 'arc_rpc_chain_id_mismatch' : 'sample_failed';
      this.#status.rpc = await this.#rpc.health();
      this.#onError(error);
      return this.getStatus();
    } finally {
      this.#sampleInProgress = false;
    }
  }

  async stop() {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    if (this.#lockClient) {
      try { await this.#lockClient.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [ARC_OBSERVER_LOCK_NAME]); }
      catch { /* releasing the dedicated client also releases a session lock */ }
      this.#lockClient.release();
      this.#lockClient = null;
    }
    this.#status.running = false;
    this.#status.reason = 'observer_stopped';
  }
}

export function startArcReadOnlyObserver(options) {
  const observer = new ArcReadOnlyObserver(options);
  return observer;
}

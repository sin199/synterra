import { ARC_MAINNET_CHAIN_ID, assertArcChainId } from './config.js';
import { ARC_GENESIS_TOKEN_ERC20_INTERFACE, ARC_GENESIS_TOKEN_SETTLEMENT_INTERFACE,
  auditGenesisTokenSettlementReceipt,
  genesisSettlementRuntimeCodeHash, genesisSettlementWorldId,
  verifyGenesisSettlementContractState } from './genesis-token-settlement.js';
import { genesisSettlementActionHash, upsertGenesisTokenBalanceObservation } from '../genesis-economy.js';

export const ARC_GENESIS_SETTLEMENT_RECONCILER_LOCK_NAME = 'synterra-arc-genesis-settlement-reconciler';
const DEFAULT_INTERVAL_MS = 15_000;
const MAX_LOG_BLOCK_RANGE = 2_000n;

function coded(code) { return Object.assign(new Error(code), { code }); }
function quantity(value) {
  if (typeof value === 'string' && /^0x[0-9a-f]+$/i.test(value)) return BigInt(value);
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value);
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  throw coded('ARC_GENESIS_RPC_QUANTITY_INVALID');
}
function asHex(value) { return `0x${BigInt(value).toString(16)}`; }
function statusCode(error) { return String(error?.code || 'ARC_GENESIS_RECONCILIATION_ERROR').replace(/[^A-Z0-9_]/gi, '').slice(0, 96); }
function cursorBeforeLog(log, fromBlock) {
  try {
    const logBlock = quantity(log?.blockNumber);
    return (logBlock < fromBlock ? fromBlock : logBlock) - 1n;
  } catch {
    return fromBlock - 1n;
  }
}

async function inTransaction(pool, callback) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

export class ArcGenesisTokenSettlementReconciler {
  #pool;
  #rpc;
  #worldId = null;
  #isOwner;
  #onError;
  #lockClient = null;
  #timer = null;
  #processing = false;
  #status;

  constructor({ pool, rpcClient, isOwner = () => true, onError = () => {}, intervalMs = DEFAULT_INTERVAL_MS }) {
    if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') {
      throw new TypeError('PostgreSQL pool is required for Genesis settlement reconciliation.');
    }
    if (!rpcClient || typeof rpcClient.getChainId !== 'function' || typeof rpcClient.getTransactionReceipt !== 'function'
        || typeof rpcClient.getLogs !== 'function' || typeof rpcClient.call !== 'function') {
      throw new TypeError('Read-only Arc RPC client is required for Genesis settlement reconciliation.');
    }
    this.#pool = pool;
    this.#rpc = rpcClient;
    this.#isOwner = isOwner;
    this.#onError = onError;
    this.intervalMs = Math.max(5_000, Number(intervalMs) || DEFAULT_INTERVAL_MS);
    this.#status = { available: true, running: false, mode: 'read_only_reconciliation', worldId: null,
      lastProcessedAt: null, lastResult: null, lastError: null, reason: 'world_engine_lock_not_owned' };
  }

  getStatus() { return structuredClone(this.#status); }

  async #readContractAndToken() {
    const activation = await this.#pool.query(`SELECT activation.world_id,activation.token_id,
        token.token_address,activation.chain_id,contract.contract_address,contract.runtime_code_hash,
        contract.verified_block
      FROM world_genesis_currency_activations activation
      JOIN arc_agent_tokens token ON token.world_id=activation.world_id AND token.id=activation.token_id
      JOIN arc_genesis_token_settlement_contracts contract ON contract.world_id=activation.world_id
        AND contract.token_id=activation.token_id AND contract.chain_id=activation.chain_id AND contract.status='active'
      WHERE activation.world_id=$1`, [this.#worldId]);
    if (!activation.rowCount) return null;
    const row = activation.rows[0];
    assertArcChainId(await this.#rpc.getChainId());
    if (Number(row.chain_id) !== ARC_MAINNET_CHAIN_ID) throw coded('ARC_GENESIS_SETTLEMENT_CHAIN_MISMATCH');
    const code = await this.#rpc.getCode(row.contract_address, 'latest');
    if (!code || code === '0x' || genesisSettlementRuntimeCodeHash(code) !== row.runtime_code_hash.toLowerCase()) {
      throw coded('ARC_GENESIS_SETTLEMENT_RUNTIME_CODE_HASH_MISMATCH');
    }
    const [worldResult, tokenResult] = await Promise.all([
      this.#rpc.call({ to: row.contract_address,
        data: ARC_GENESIS_TOKEN_SETTLEMENT_INTERFACE.encodeFunctionData('worldId') }, 'latest'),
      this.#rpc.call({ to: row.contract_address,
        data: ARC_GENESIS_TOKEN_SETTLEMENT_INTERFACE.encodeFunctionData('token') }, 'latest')
    ]);
    const actualWorldId = ARC_GENESIS_TOKEN_SETTLEMENT_INTERFACE.decodeFunctionResult('worldId', worldResult)[0];
    const actualTokenAddress = ARC_GENESIS_TOKEN_SETTLEMENT_INTERFACE.decodeFunctionResult('token', tokenResult)[0];
    verifyGenesisSettlementContractState({ actualWorldId, expectedWorldId: row.world_id,
      actualTokenAddress, expectedTokenAddress: row.token_address, chainId: row.chain_id });
    return row;
  }

  async #readActivatedToken() {
    const result = await this.#pool.query(`SELECT activation.world_id,activation.token_id,
        activation.chain_id,token.token_address
      FROM world_genesis_currency_activations activation
      JOIN arc_agent_tokens token ON token.world_id=activation.world_id AND token.id=activation.token_id
      WHERE activation.world_id=$1`, [this.#worldId]);
    if (!result.rowCount) return null;
    const token = result.rows[0];
    assertArcChainId(await this.#rpc.getChainId());
    if (Number(token.chain_id) !== ARC_MAINNET_CHAIN_ID) throw coded('ARC_GENESIS_SETTLEMENT_CHAIN_MISMATCH');
    const code = await this.#rpc.getCode(token.token_address, 'latest');
    if (!code || code === '0x') throw coded('ARC_GENESIS_TOKEN_RUNTIME_CODE_UNAVAILABLE');
    return token;
  }

  async #observeWalletBalances(token) {
    const wallets = await this.#pool.query(`SELECT 'agent'::text AS owner_type,agent_id AS owner_id,address
        FROM arc_agent_wallets WHERE world_id=$1 AND chain_id=$2 AND status='active'
      UNION ALL
      SELECT 'organization'::text AS owner_type,organization_id AS owner_id,address
        FROM arc_organization_wallets WHERE world_id=$1 AND chain_id=$2 AND status='active'
      ORDER BY owner_type,owner_id`, [this.#worldId, ARC_MAINNET_CHAIN_ID]);
    const block = quantity(await this.#rpc.getBlockNumber());
    const observations = await Promise.all(wallets.rows.map(async (wallet) => {
      try {
        return { wallet, balanceRaw: await this.#readBalance(token.token_address, wallet.address, block) };
      } catch (error) {
        return { wallet, error: statusCode(error) };
      }
    }));
    const observedAt = new Date();
    await inTransaction(this.#pool, async (client) => {
      for (const observation of observations) {
        if (observation.error) continue;
        await upsertGenesisTokenBalanceObservation(client, { worldId: this.#worldId,
          tokenId: token.token_id, walletAddress: observation.wallet.address,
          agentId: observation.wallet.owner_type === 'agent' ? observation.wallet.owner_id : null,
          organizationId: observation.wallet.owner_type === 'organization' ? observation.wallet.owner_id : null,
          balanceRaw: observation.balanceRaw, blockNumber: block.toString(), observedAt });
      }
    });
    return { blockNumber: block.toString(), walletsObserved: observations.filter((item) => !item.error).length,
      walletReadFailures: observations.filter((item) => item.error).map((item) => ({
        ownerType: item.wallet.owner_type, ownerId: item.wallet.owner_id, reason: item.error })) };
  }

  async #findUnknownSubmit(row, contract, latestBlock) {
    let from = quantity(row.reconciliation_log_cursor_block ?? row.submission_start_block ?? '0') + 1n;
    const first = quantity(row.submission_start_block ?? '0');
    if (from < first) from = first;
    if (from > latestBlock) return { receipt: null, transaction: null, cursor: latestBlock.toString(), matchedLog: false };
    const to = from + MAX_LOG_BLOCK_RANGE - 1n < latestBlock ? from + MAX_LOG_BLOCK_RANGE - 1n : latestBlock;
    const topics = ARC_GENESIS_TOKEN_SETTLEMENT_INTERFACE.encodeFilterTopics('TokenSettlement', [
      genesisSettlementWorldId(row.world_id), row.token_address,
      genesisSettlementActionHash(row.world_id, row.world_action_id)
    ]);
    const logs = await this.#rpc.getLogs({ address: row.settlement_contract, topics,
      fromBlock: asHex(from), toBlock: asHex(to) });
    for (const log of logs || []) {
      if (!log) continue;
      const cursor = cursorBeforeLog(log, from).toString();
      if (!log.transactionHash) {
        return { receipt: null, transaction: null, cursor, matchedLog: true, pendingAudit: true };
      }
      const [receipt, transaction] = await Promise.all([
        this.#rpc.getTransactionReceipt(log.transactionHash), this.#rpc.getTransaction(log.transactionHash)
      ]);
      if (!receipt || !transaction) return { receipt: null, transaction: null, cursor,
        matchedLog: true, pendingAudit: true };
      const audited = auditGenesisTokenSettlementReceipt(row, receipt, transaction);
      if (audited.consistent || (audited.reverted && transaction.to?.toLowerCase() === row.settlement_contract.toLowerCase())) {
        return { receipt, transaction, audit: audited, cursor: to.toString(), matchedLog: true };
      }
      return { receipt, transaction, audit: audited, cursor, matchedLog: true, pendingAudit: true };
    }
    return { receipt: null, transaction: null, cursor: to.toString(), matchedLog: false };
  }

  async #saveUnknownSubmitCursor(row, cursor, transactionHash = null) {
    await this.#pool.query(`UPDATE arc_genesis_token_settlement_outbox
      SET reconciliation_log_cursor_block=GREATEST(COALESCE(reconciliation_log_cursor_block,0),$3),updated_at=now()
      WHERE id=$1 AND world_id=$2 AND ((status='submission_unknown' AND transaction_hash IS NULL)
        OR (status IN ('final','failed') AND $4::text IS NOT NULL AND lower(transaction_hash)=lower($4)))`,
    [row.id, row.world_id, cursor, transactionHash]);
  }

  async #readBalance(tokenAddress, walletAddress, block) {
    const data = ARC_GENESIS_TOKEN_ERC20_INTERFACE.encodeFunctionData('balanceOf', [walletAddress]);
    const raw = await this.#rpc.call({ to: tokenAddress, data }, asHex(block));
    return BigInt(ARC_GENESIS_TOKEN_ERC20_INTERFACE.decodeFunctionResult('balanceOf', raw)[0]).toString();
  }

  async #saveChainOutcome(row, audit, transaction, receipt, latestBlock) {
    if (!audit?.consistent && !audit?.reverted) return { status: 'pending', finding: audit?.finding || null };
    const transactionHash = String(receipt.transactionHash || transaction.hash || '').toLowerCase();
    const blockNumber = quantity(receipt.blockNumber).toString();
    const latest = await this.#rpc.getBlockNumber();
    const observationBlock = quantity(latest);
    const [payerBalance, payeeBalance] = await Promise.all([
      this.#readBalance(row.token_address, row.from_address, observationBlock),
      this.#readBalance(row.token_address, row.to_address, observationBlock)
    ]);
    return inTransaction(this.#pool, async (client) => {
      const saved = await client.query(`UPDATE arc_genesis_token_settlement_outbox SET status=$3,
          transaction_hash=$4,block_number=$5,log_index=$6,submitted_at=COALESCE(submitted_at,now()),
          finalized_at=now(),failure_code=$7,updated_at=now()
        WHERE id=$1 AND world_id=$2 AND status IN ('submitted','submission_unknown')
          AND (transaction_hash IS NULL OR lower(transaction_hash)=lower($4)) RETURNING id,status`,
      [row.id, row.world_id, audit.reverted ? 'failed' : 'final', transactionHash, blockNumber,
        Number.isInteger(audit.logIndex) ? audit.logIndex : 0,
        audit.reverted ? 'ARC_TRANSACTION_REVERTED' : null]);
      if (!saved.rowCount) {
        const existing = await client.query(`SELECT status,transaction_hash FROM arc_genesis_token_settlement_outbox WHERE id=$1`, [row.id]);
        if (existing.rows[0]?.status === (audit.reverted ? 'failed' : 'final')
            && existing.rows[0]?.transaction_hash?.toLowerCase() === transactionHash) {
          return { status: existing.rows[0].status, idempotent: true };
        }
        return { status: 'conflict', finding: 'OUTBOX_CHANGED_DURING_RECONCILIATION' };
      }
      const orders = await client.query(`UPDATE world_genesis_token_business_orders SET status=$2,finalized_at=now()
        WHERE settlement_outbox_id=$1 AND status='pending_settlement' RETURNING id,service_id,action_id,amount_raw::text AS amount_raw`,
      [row.id, audit.reverted ? 'failed' : 'fulfilled']);
      for (const order of orders.rows) {
        if (audit.reverted) await client.query(`UPDATE world_business_services SET stock_units=stock_units+1
          WHERE world_id=$1 AND id=$2`, [row.world_id, order.service_id]);
        else {
          await client.query(`INSERT INTO world_history(world_id,event_key,event_type,actor_agent_id,entity_type,entity_id,
              world_time,title,detail,metadata)
            VALUES($1,$2,'business_token_service_settled',$3,'order',$4,$5,'Genesis Token service settlement confirmed',
              'Arc confirmed the payer-authorized Genesis Token transfer; the chain is the ownership source of truth.',$6::jsonb)
            ON CONFLICT(world_id,event_key) DO NOTHING`, [row.world_id, `genesis-service-settlement:${row.id}`,
            row.from_agent_id, order.id, row.created_world_minute,
            JSON.stringify({ settlementId: row.id, transactionHash, blockNumber,
              amountRaw: order.amount_raw, tokenId: row.token_id, recipientAgentId: row.to_agent_id })]);
        }
      }
      if (row.action_family === 'business_equity_investment' && row.metadata?.agreementId) {
        const agreementStatus = audit.reverted ? 'cancelled' : 'completed';
        await client.query(`UPDATE world_agreements SET status=$3,
            completed_world_time=CASE WHEN $3='completed' THEN $4::bigint ELSE NULL END,
            updated_world_time=$4,metadata=metadata||jsonb_build_object('execution',
              COALESCE(metadata->'execution','{}'::jsonb)||$5::jsonb),updated_at=now()
          WHERE world_id=$1 AND id=$2 AND agreement_type='investment' AND status='active'`,
        [row.world_id, row.metadata.agreementId, agreementStatus, row.created_world_minute,
          JSON.stringify({ settlementId: row.id, settlementStatus: audit.reverted ? 'failed' : 'final',
            transactionHash, blockNumber, ownershipStatus: audit.reverted ? 'cancelled' : 'arc_confirmed_business_equity',
            tokenOwnershipAuthority: 'arc_chain_confirmation', failureCode: audit.reverted ? 'ARC_TRANSACTION_REVERTED' : null })]);
        await client.query(`INSERT INTO world_history(world_id,event_key,event_type,actor_agent_id,entity_type,entity_id,
            world_time,title,detail,metadata)
          VALUES($1,$2,$3,$4,'agreement',$5,$6,$7,$8,$9::jsonb) ON CONFLICT(world_id,event_key) DO NOTHING`,
        [row.world_id, `genesis-business-equity-settlement:${row.id}`,
          audit.reverted ? 'business_token_investment_failed' : 'business_token_investment_settled',
          row.from_agent_id, row.metadata.agreementId, row.created_world_minute,
          audit.reverted ? 'Genesis Token business investment failed' : 'Genesis Token business equity confirmed',
          audit.reverted ? 'The investor authorized a transfer but Arc reverted it; no business equity was assigned.'
            : 'Arc confirmed the investor wallet transfer; the separately agreed business equity is now effective.',
          JSON.stringify({ settlementId: row.id, tokenId: row.token_id, amountRaw: String(row.amount_raw),
            investorAgentId: row.from_agent_id, businessId: row.metadata.businessId,
            ownershipShare: row.metadata.ownershipShare, transactionHash, blockNumber,
            tokenOwnershipAuthority: 'arc_chain_confirmation' })]);
      }
      if (row.action_family === 'business_profit_distribution') {
        await client.query(`INSERT INTO world_history(world_id,event_key,event_type,actor_agent_id,entity_type,entity_id,
            world_time,title,detail,metadata)
          VALUES($1,$2,$3,$4,'business',$5,$6,$7,$8,$9::jsonb) ON CONFLICT(world_id,event_key) DO NOTHING`,
        [row.world_id, `genesis-business-profit-settlement:${row.id}`,
          audit.reverted ? 'business_token_profit_distribution_failed' : 'business_token_profit_distribution_settled',
          row.from_agent_id, row.metadata.businessId, row.created_world_minute,
          audit.reverted ? 'Genesis Token profit distribution failed' : 'Genesis Token profit distribution confirmed',
          audit.reverted ? 'Arc reverted the payer-authorized transfer; no investor received this distribution.'
            : 'Arc confirmed the payer-authorized Genesis Token profit distribution.',
          JSON.stringify({ settlementId: row.id, tokenId: row.token_id, amountRaw: String(row.amount_raw),
            recipientAgentId: row.to_agent_id, businessId: row.metadata.businessId,
            sourceActionId: row.metadata.sourceActionId, transactionHash, blockNumber,
            tokenOwnershipAuthority: 'arc_chain_confirmation' })]);
      }
      const observedAt = new Date();
      await upsertGenesisTokenBalanceObservation(client, { worldId: row.world_id, tokenId: row.token_id,
        walletAddress: row.from_address, agentId: row.from_agent_id, balanceRaw: payerBalance,
        blockNumber: observationBlock.toString(), observedAt });
      await upsertGenesisTokenBalanceObservation(client, { worldId: row.world_id, tokenId: row.token_id,
        walletAddress: row.to_address, agentId: row.to_agent_id, organizationId: row.to_organization_id,
        balanceRaw: payeeBalance, blockNumber: observationBlock.toString(), observedAt });
      return { status: audit.reverted ? 'failed' : 'final', transactionHash, blockNumber,
        logIndex: Number.isInteger(audit.logIndex) ? audit.logIndex : 0, balancesObserved: true };
    });
  }

  async reconcilePending() {
    if (!this.#worldId) throw coded('ARC_GENESIS_RECONCILER_WORLD_REQUIRED');
    if (this.#processing) return { processed: false, reason: 'reconciliation_in_progress', results: [] };
    if (!this.#isOwner()) return { processed: false, reason: 'world_engine_lock_not_owned', results: [] };
    this.#processing = true;
    try {
      const token = await this.#readActivatedToken();
      if (!token) return { processed: true, reason: 'genesis_currency_not_active', results: [] };
      const walletBalances = await this.#observeWalletBalances(token);
      const contract = await this.#readContractAndToken();
      if (!contract) return { processed: true, reason: 'settlement_contract_unavailable',
        walletBalances, results: [] };
      const rows = await this.#pool.query(`SELECT outbox.*,token.token_address AS token_address,
          payer_wallet.account_type AS from_wallet_account_type
        FROM arc_genesis_token_settlement_outbox outbox
        JOIN arc_agent_tokens token ON token.world_id=outbox.world_id AND token.id=outbox.token_id
        LEFT JOIN arc_agent_wallets payer_wallet ON payer_wallet.world_id=outbox.world_id
          AND payer_wallet.agent_id=outbox.from_agent_id AND payer_wallet.chain_id=outbox.chain_id
          AND lower(payer_wallet.address)=lower(outbox.from_address)
        WHERE outbox.world_id=$1 AND outbox.status IN ('submission_unknown','submitted')
        ORDER BY outbox.created_at,outbox.id LIMIT 100`, [this.#worldId]);
      const latestBlock = quantity(await this.#rpc.getBlockNumber());
      const results = [];
      for (const row of rows.rows) {
        try {
          let receipt = null;
          let transaction = null;
          let audit = null;
          let recovered = null;
          if (row.transaction_hash) {
            [receipt, transaction] = await Promise.all([
              this.#rpc.getTransactionReceipt(row.transaction_hash), this.#rpc.getTransaction(row.transaction_hash)
            ]);
            if (!receipt || !transaction) { results.push({ id: row.id, status: row.status, reason: 'receipt_pending' }); continue; }
            audit = auditGenesisTokenSettlementReceipt(row, receipt, transaction);
          } else if (row.status === 'submission_unknown') {
            recovered = await this.#findUnknownSubmit(row, contract, latestBlock);
            receipt = recovered.receipt;
            transaction = recovered.transaction;
            audit = recovered.audit;
            if (recovered.cursor && (!recovered.matchedLog || recovered.pendingAudit)) {
              await this.#saveUnknownSubmitCursor(row, recovered.cursor);
            }
            if (!receipt || !transaction) {
              results.push({ id: row.id, status: row.status,
                reason: recovered.pendingAudit ? 'matching_log_audit_pending' : 'unknown_submit_not_found' });
              continue;
            }
          }
          if (!audit?.consistent && !audit?.reverted) {
            results.push({ id: row.id, status: row.status, finding: audit?.finding || 'CHAIN_EVIDENCE_INCOMPLETE' });
            continue;
          }
          const outcome = await this.#saveChainOutcome(row, audit, transaction, receipt, latestBlock);
          if (recovered?.matchedLog && !recovered.pendingAudit && recovered.cursor
              && ['final','failed'].includes(outcome.status)) {
            const transactionHash = String(receipt.transactionHash || transaction.hash || '').toLowerCase();
            await this.#saveUnknownSubmitCursor(row, recovered.cursor, transactionHash);
          }
          results.push({ id: row.id, ...outcome });
        } catch (error) { results.push({ id: row.id, status: row.status, finding: statusCode(error) }); }
      }
      return { processed: true, reason: null, walletBalances, results };
    } finally { this.#processing = false; }
  }

  async #process() {
    if (!this.#status.running || !this.#isOwner()) return;
    try {
      this.#status.lastResult = await this.reconcilePending();
      this.#status.lastProcessedAt = new Date().toISOString();
      this.#status.lastError = null;
      this.#status.reason = this.#status.lastResult.reason || null;
    } catch (error) {
      this.#status.lastError = { code: statusCode(error) };
      this.#status.reason = 'reconciliation_failed';
      this.#onError(this.#status.lastError);
    }
  }

  async start({ worldId }) {
    if (this.#timer) return this;
    if (!worldId || !this.#isOwner()) { this.#status.reason = 'world_engine_lock_not_owned'; return this; }
    this.#worldId = worldId;
    this.#status.worldId = worldId;
    const lockClient = await this.#pool.connect();
    try {
      const lock = await lockClient.query(`SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS acquired`,
        [`${ARC_GENESIS_SETTLEMENT_RECONCILER_LOCK_NAME}:${worldId}`]);
      if (!lock.rows[0]?.acquired) {
        lockClient.release();
        this.#status.reason = 'another_genesis_settlement_reconciler_owns_lock';
        return this;
      }
      this.#lockClient = lockClient;
      this.#status.running = true;
      this.#status.reason = 'read_only_arc_reconciliation';
    } catch (error) {
      lockClient.release();
      this.#status.lastError = { code: statusCode(error) };
      this.#status.reason = 'reconciler_lock_failed';
      this.#onError(this.#status.lastError);
      return this;
    }
    await this.#process();
    this.#timer = setInterval(() => { this.#process().catch(() => {}); }, this.intervalMs);
    this.#timer.unref?.();
    return this;
  }

  async stop() {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    if (this.#lockClient) {
      try { await this.#lockClient.query(`SELECT pg_advisory_unlock(hashtextextended($1,0))`,
        [`${ARC_GENESIS_SETTLEMENT_RECONCILER_LOCK_NAME}:${this.#worldId}`]); } catch { /* connection close releases lock */ }
      this.#lockClient.release();
      this.#lockClient = null;
    }
    this.#status.running = false;
    if (!this.#status.reason) this.#status.reason = 'worker_stopped';
  }
}

export function startArcGenesisTokenSettlementReconciler(options) {
  const reconciler = new ArcGenesisTokenSettlementReconciler(options);
  return reconciler;
}

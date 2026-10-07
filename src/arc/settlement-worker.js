import { evaluateNextArcSettlementPolicy } from './agent-economic-action.js';
import { reconcilePendingArcSettlements } from './settlement.js';
export const ARC_SETTLEMENT_WORKER_LOCK_NAME = 'synterra-arc-settlement-outbox-worker';
const POLL_INTERVAL_MS = 2_000;

export class ArcSettlementOutboxWorker {
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

  constructor({ pool, config, env = process.env, signer = null, rpcClient, isOwner = () => true,
    onError = () => {}, intervalMs = POLL_INTERVAL_MS }) {
    if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') {
      throw new TypeError('PostgreSQL pool is required for Arc settlement work.');
    }
    if (!config || config.name !== 'mainnet' || Number(config.chainId) !== 5042) {
      const error = new Error('Arc settlement worker supports Mainnet only.');
      error.code = 'ARC_MAINNET_ONLY';
      throw error;
    }
    this.#pool = pool;
    this.#config = config;
    this.#env = env;
    this.#signer = signer;
    this.#rpc = rpcClient;
    this.#isOwner = isOwner;
    this.#onError = onError;
    this.intervalMs = Math.max(1_000, Number(intervalMs) || POLL_INTERVAL_MS);
    this.#status = { available: true, running: false, mode: 'read_only_reconciliation', providerName: signer?.providerName || null,
      lastProcessedAt: null, lastResult: null, lastError: null, reason: 'mainnet_write_gate_closed' };
  }

  getStatus() { return structuredClone(this.#status); }

  async #process() {
    if (this.#active || !this.#status.running || !this.#isOwner()) return;
    this.#active = true;
    try {
      const reconciliation = await reconcilePendingArcSettlements(this.#pool, { rpcClient: this.#rpc });
      const canEvaluatePolicy = this.#config.writesEnabled && this.#signer;
      const policy = canEvaluatePolicy
        ? await evaluateNextArcSettlementPolicy({ pool: this.#pool, config: this.#config,
          env: this.#env, signer: this.#signer, rpcClient: this.#rpc })
        : { processed: false, reason: this.#config.writesEnabled ? 'mainnet_signer_not_configured' : 'mainnet_write_gate_closed' };
      this.#status.lastProcessedAt = new Date().toISOString();
      this.#status.lastResult = { reconciliationProcessed: reconciliation.processed,
        policyProcessed: policy.processed, status: policy.status || null,
        reason: policy.reason || null, reconciled: reconciliation.results.filter((row) => row.status === 'final' || row.status === 'failed').length };
      this.#status.lastError = null;
    } catch (error) {
      const code = String(error?.code || 'ARC_SETTLEMENT_WORKER_ERROR').replace(/[^A-Z0-9_]/gi, '').slice(0, 80);
      this.#status.lastError = { code };
      this.#onError({ code });
    } finally { this.#active = false; }
  }

  async start() {
    if (this.#timer) return this;
    if (!this.#isOwner()) { this.#status.reason = 'world_engine_lock_not_owned'; return this; }
    const lockClient = await this.#pool.connect();
    try {
      const result = await lockClient.query(`SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS acquired`,
        [ARC_SETTLEMENT_WORKER_LOCK_NAME]);
      if (!result.rows[0]?.acquired) {
        lockClient.release();
        this.#status.reason = 'another_settlement_worker_owns_lock';
        return this;
      }
      this.#lockClient = lockClient;
      this.#status.running = true;
      this.#status.mode = this.#config.writesEnabled && this.#signer
        ? 'mainnet_write_enabled' : 'read_only_reconciliation';
      this.#status.reason = this.#config.writesEnabled && !this.#signer
        ? 'mainnet_signer_not_configured' : this.#config.writesEnabled ? null : 'mainnet_write_gate_closed';
    } catch (error) {
      lockClient.release();
      this.#status.reason = 'worker_lock_failed';
      this.#status.lastError = { code: String(error?.code || 'ARC_WORKER_LOCK_ERROR') };
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
      try { await this.#lockClient.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',
        [ARC_SETTLEMENT_WORKER_LOCK_NAME]); } catch { /* closing the dedicated client releases the lock */ }
      this.#lockClient.release();
      this.#lockClient = null;
    }
    this.#status.running = false;
    if (this.#status.reason === null) this.#status.reason = 'worker_stopped';
  }
}

export function startArcSettlementOutboxWorker(options) {
  return new ArcSettlementOutboxWorker(options);
}

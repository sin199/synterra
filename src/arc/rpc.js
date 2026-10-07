import { assertArcChainId } from './config.js';

const READ_ONLY_METHODS = new Set([
  'eth_blockNumber', 'eth_call', 'eth_chainId', 'eth_estimateGas', 'eth_feeHistory', 'eth_gasPrice',
  'eth_getBalance', 'eth_getBlockByHash', 'eth_getBlockByNumber', 'eth_getCode',
  'eth_getLogs', 'eth_getStorageAt', 'eth_getTransactionByHash', 'eth_getTransactionCount', 'eth_getTransactionReceipt',
  'eth_maxPriorityFeePerGas'
]);

const CHAIN_ID_CACHE_MS = 5 * 60_000;

function providerLabel(url) {
  try { return new URL(url).hostname.toLowerCase(); }
  catch { return 'configured-rpc'; }
}

function typedError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  return error;
}

export class ArcRpcClient {
  #config;
  #fetch;
  #timeoutMs;
  #requestId = 0;
  #verifiedChainIds = new Map();
  #lastProvider = null;

  constructor({ config, fetchImpl = globalThis.fetch, timeoutMs = 5_000 }) {
    if (!config?.chainId || !config?.primaryRpcUrl) throw new TypeError('Verified Arc network config is required.');
    if (typeof fetchImpl !== 'function') throw new TypeError('Fetch implementation is required.');
    this.#config = config;
    this.#fetch = fetchImpl;
    this.#timeoutMs = timeoutMs;
  }

  get config() { return this.#config; }

  async #requestUrl(url, method, params) {
    let response;
    try {
      response = await this.#fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++this.#requestId, method, params }),
        signal: AbortSignal.timeout(this.#timeoutMs)
      });
    } catch {
      throw typedError('ARC_RPC_UNAVAILABLE', 'Arc RPC request failed before a response was received.');
    }
    let body;
    try { body = await response.json(); }
    catch { throw typedError('ARC_RPC_INVALID_RESPONSE', 'Arc RPC returned a non-JSON response.', { httpStatus: response.status }); }
    if (!response.ok) throw typedError('ARC_RPC_HTTP_ERROR', 'Arc RPC returned an HTTP error.', { httpStatus: response.status });
    if (body?.error) {
      throw typedError('ARC_RPC_METHOD_ERROR', 'Arc RPC rejected a read request.', {
        rpcCode: Number(body.error.code),
        rpcMessage: String(body.error.message || '').slice(0, 240),
        rpcData: typeof body.error.data === 'string' ? body.error.data.slice(0, 512) : undefined
      });
    }
    if (!Object.hasOwn(body || {}, 'result')) throw typedError('ARC_RPC_INVALID_RESPONSE', 'Arc RPC response is missing a result.');
    return body.result;
  }

  async #verifyEndpoint(url, { primary = false } = {}) {
    const verifiedAt = this.#verifiedChainIds.get(url) || 0;
    if (Date.now() - verifiedAt < CHAIN_ID_CACHE_MS) return;
    const actual = await this.#requestUrl(url, 'eth_chainId', []);
    try { assertArcChainId(actual, this.#config); }
    catch (error) {
      error.provider = providerLabel(url);
      error.primary = primary;
      throw error;
    }
    this.#verifiedChainIds.set(url, Date.now());
  }

  async request(method, params = []) {
    if (!READ_ONLY_METHODS.has(method)) {
      throw typedError('ARC_RPC_METHOD_NOT_READ_ONLY', `ArcRpcClient does not permit ${String(method)}.`);
    }
    if (!Array.isArray(params)) throw new TypeError('JSON-RPC params must be an array.');
    const urls = [this.#config.primaryRpcUrl, ...this.#config.backupRpcUrls];
    const failures = [];
    for (const [index, url] of urls.entries()) {
      const primary = index === 0;
      try {
        await this.#verifyEndpoint(url, { primary });
        let result;
        try { result = await this.#requestUrl(url, method, params); }
        catch (error) {
          if (error.rpcCode !== -32014) throw error;
          await new Promise((resolve) => setTimeout(resolve, 150));
          result = await this.#requestUrl(url, method, params);
        }
        this.#lastProvider = providerLabel(url);
        return result;
      } catch (error) {
        if (error.code === 'ARC_CHAIN_ID_MISMATCH' && primary) throw error;
        failures.push({ provider: providerLabel(url), code: error.code || 'ARC_RPC_ERROR',
          ...(error.httpStatus ? { httpStatus: error.httpStatus } : {}),
          ...(error.rpcCode !== undefined ? { rpcCode: error.rpcCode } : {}) });
      }
    }
    throw typedError('ARC_RPC_UNAVAILABLE', 'All configured Arc RPC providers failed a read request.', { failures });
  }

  async getChainId() {
    const value = await this.request('eth_chainId', []);
    return assertArcChainId(value, this.#config);
  }

  async getBlockNumber() { return this.request('eth_blockNumber', []); }
  async getBlock(tag = 'latest', fullTransactions = false) {
    return this.request('eth_getBlockByNumber', [tag, Boolean(fullTransactions)]);
  }
  async getCode(address, blockTag = 'latest') { return this.request('eth_getCode', [address, blockTag]); }
  async getBalance(address, blockTag = 'latest') { return this.request('eth_getBalance', [address, blockTag]); }
  async getTransactionCount(address, blockTag = 'pending') { return this.request('eth_getTransactionCount', [address, blockTag]); }
  async estimateGas(transaction, blockTag = 'latest') { return this.request('eth_estimateGas', [transaction, blockTag]); }
  async call(transaction, blockTag = 'latest') { return this.request('eth_call', [transaction, blockTag]); }
  async getLogs(filter) { return this.request('eth_getLogs', [filter]); }
  async getTransactionReceipt(hash) { return this.request('eth_getTransactionReceipt', [hash]); }
  async getTransaction(hash) { return this.request('eth_getTransactionByHash', [hash]); }
  async gasPrice() { return this.request('eth_gasPrice', []); }
  async maxPriorityFeePerGas() { return this.request('eth_maxPriorityFeePerGas', []); }
  async feeHistory(blockCount = '0x5', newestBlock = 'latest', rewardPercentiles = [50]) {
    return this.request('eth_feeHistory', [blockCount, newestBlock, rewardPercentiles]);
  }

  async health() {
    const checkedAt = new Date().toISOString();
    const started = Date.now();
    try {
      const [chainId, block] = await Promise.all([this.getChainId(), this.getBlock('latest', false)]);
      return {
        configured: true,
        chainId,
        expectedChainId: this.#config.chainId,
        rpcHealthy: true,
        provider: this.#lastProvider,
        latestBlock: block?.number ? Number(BigInt(block.number)) : null,
        latestBlockHash: block?.hash || null,
        baseFeePerGas: block?.baseFeePerGas || null,
        latencyMs: Date.now() - started,
        checkedAt,
        error: null
      };
    } catch (error) {
      return {
        configured: true,
        chainId: this.#config.chainId,
        expectedChainId: this.#config.chainId,
        rpcHealthy: false,
        provider: error.provider || this.#lastProvider,
        latestBlock: null,
        latestBlockHash: null,
        baseFeePerGas: null,
        latencyMs: Date.now() - started,
        checkedAt,
        error: {
          code: error.code || 'ARC_RPC_ERROR',
          message: error.code === 'ARC_CHAIN_ID_MISMATCH' ? error.message : 'Arc RPC read failed.',
          failures: error.failures || undefined
        }
      };
    }
  }
}

import { assertArcMainnetChainId, ARC_SYSTEM_USDC_TRANSFER_EMITTER, ARC_TRANSFER_TOPIC0 } from './config.js';

export const ARC_GET_LOGS_MAX_BLOCK_COUNT = 9_999n;

function asBigInt(value, name) {
  try {
    const parsed = typeof value === 'bigint' ? value : BigInt(value);
    if (parsed < 0n) throw new Error();
    return parsed;
  } catch {
    throw new TypeError(`${name} must be a non-negative integer.`);
  }
}

function toHexBlock(value) { return `0x${value.toString(16)}`; }

function normalizeAddresses(addresses) {
  return [...new Set((addresses || []).map((value) => {
    if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(value)) {
      throw new TypeError('Tracked wallet addresses must be valid EVM addresses.');
    }
    return value.toLowerCase();
  }))].sort();
}

function topicAddress(address) { return `0x${address.slice(2).padStart(64, '0')}`; }

export function buildTrackedUsdcTransferFilters(addresses, fromBlock, toBlock) {
  const tracked = normalizeAddresses(addresses);
  const from = toHexBlock(asBigInt(fromBlock, 'fromBlock'));
  const to = toHexBlock(asBigInt(toBlock, 'toBlock'));
  if (!tracked.length) return [];
  const indexedAddresses = tracked.map(topicAddress);
  return [
    { address: ARC_SYSTEM_USDC_TRANSFER_EMITTER, fromBlock: from, toBlock: to,
      topics: [ARC_TRANSFER_TOPIC0, indexedAddresses] },
    { address: ARC_SYSTEM_USDC_TRANSFER_EMITTER, fromBlock: from, toBlock: to,
      topics: [ARC_TRANSFER_TOPIC0, null, indexedAddresses] }
  ];
}

function normalizeLog(log) {
  if (!log || !/^0x[0-9a-fA-F]{64}$/.test(log.transactionHash || '')
      || !/^0x[0-9a-fA-F]{64}$/.test(log.blockHash || '')
      || !Number.isSafeInteger(Number(BigInt(log.logIndex)))) {
    throw new TypeError('Arc RPC returned a malformed log.');
  }
  return {
    transactionHash: log.transactionHash.toLowerCase(),
    logIndex: Number(BigInt(log.logIndex)),
    blockNumber: BigInt(log.blockNumber).toString(),
    blockHash: log.blockHash.toLowerCase(),
    address: String(log.address).toLowerCase(),
    topics: Array.isArray(log.topics) ? log.topics.map((topic) => String(topic).toLowerCase()) : [],
    data: String(log.data || '0x').toLowerCase(),
    transactionIndex: log.transactionIndex === undefined ? null : Number(BigInt(log.transactionIndex)),
    removed: Boolean(log.removed)
  };
}

function compareLogs(left, right) {
  const blockDelta = BigInt(left.blockNumber) - BigInt(right.blockNumber);
  if (blockDelta !== 0n) return blockDelta < 0n ? -1 : 1;
  return left.logIndex - right.logIndex;
}

async function readCursor(client, chainId, sourceKey, startBlock) {
  const state = await client.query('SELECT last_indexed_block FROM arc_indexer_state WHERE chain_id=$1 AND source_key=$2',
    [chainId, sourceKey]);
  if (state.rowCount) return BigInt(state.rows[0].last_indexed_block) + 1n;
  if (startBlock === undefined || startBlock === null) return null;
  return asBigInt(startBlock, 'startBlock');
}

async function persistPage(client, { chainId, sourceKey, worldId, eventType, logs, lastBlock }) {
  await client.query('BEGIN');
  try {
    for (const log of logs) {
      await client.query(`INSERT INTO arc_indexed_events(chain_id,transaction_hash,log_index,block_number,
          block_hash,emitter_address,event_topic0,world_id,event_type,payload)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
        ON CONFLICT(chain_id,transaction_hash,log_index) DO NOTHING`, [
        chainId, log.transactionHash, log.logIndex, log.blockNumber, log.blockHash, log.address,
        log.topics[0] || null, worldId || null, eventType, JSON.stringify(log)
      ]);
    }
    await client.query(`INSERT INTO arc_indexer_state(chain_id,source_key,last_indexed_block,updated_at)
      VALUES($1,$2,$3,now()) ON CONFLICT(chain_id,source_key) DO UPDATE SET
        last_indexed_block=GREATEST(arc_indexer_state.last_indexed_block,EXCLUDED.last_indexed_block),updated_at=now()`,
    [chainId, sourceKey, lastBlock.toString()]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

async function scanLogs({ client, rpc, chainId, sourceKey, worldId = null, eventType,
  startBlock = null, latestBlock = null, getFilters, maxBlockCount = ARC_GET_LOGS_MAX_BLOCK_COUNT,
  maxPages = 1 }) {
  const maxCount = asBigInt(maxBlockCount, 'maxBlockCount');
  assertArcMainnetChainId(chainId);
  const pageLimit = Number(maxPages);
  if (maxCount < 1n || maxCount > ARC_GET_LOGS_MAX_BLOCK_COUNT) {
    throw new RangeError('Arc eth_getLogs windows may contain at most 9,999 blocks.');
  }
  if (!Number.isSafeInteger(pageLimit) || pageLimit < 1 || pageLimit > 100) {
    throw new RangeError('maxPages must be an integer from 1 to 100.');
  }
  const latest = latestBlock === null ? BigInt(await rpc.getBlockNumber()) : asBigInt(latestBlock, 'latestBlock');
  const cursor = await readCursor(client, chainId, sourceKey, startBlock);
  if (cursor === null) return { configured: false, indexedLogs: 0, lastIndexedBlock: null, latestBlock: latest.toString() };
  if (cursor > latest) return { configured: true, indexedLogs: 0, lastIndexedBlock: cursor - 1n, latestBlock: latest.toString() };
  let nextBlock = cursor;
  let indexedLogs = 0;
  let pages = 0;
  while (nextBlock <= latest && pages < pageLimit) {
    const endBlock = nextBlock + maxCount - 1n < latest ? nextBlock + maxCount - 1n : latest;
    const filters = getFilters(nextBlock, endBlock);
    const seen = new Map();
    for (const filter of filters) {
      const logs = await rpc.getLogs(filter);
      for (const rawLog of logs) {
        const log = normalizeLog(rawLog);
        seen.set(`${log.transactionHash}:${log.logIndex}`, log);
      }
    }
    const ordered = [...seen.values()].sort(compareLogs);
    await persistPage(client, { chainId, sourceKey, worldId, eventType, logs: ordered, lastBlock: endBlock });
    indexedLogs += ordered.length;
    nextBlock = endBlock + 1n;
    pages += 1;
  }
  return { configured: true, indexedLogs, pages, caughtUp: nextBlock > latest,
    lastIndexedBlock: (nextBlock - 1n).toString(), latestBlock: latest.toString() };
}

export function indexArcContractEvents({ client, rpc, chainId, sourceKey, worldId = null,
  contractAddress, topic0, startBlock = null, latestBlock = null, eventType = 'contract_event',
  maxBlockCount = ARC_GET_LOGS_MAX_BLOCK_COUNT, maxPages = 1 }) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(contractAddress || '')) throw new TypeError('contractAddress must be valid.');
  if (!/^0x[0-9a-fA-F]{64}$/.test(topic0 || '')) throw new TypeError('topic0 must be a 32-byte hex value.');
  const address = contractAddress.toLowerCase();
  return scanLogs({ client, rpc, chainId, sourceKey, worldId, eventType, startBlock, latestBlock, maxBlockCount, maxPages,
    getFilters: (fromBlock, toBlock) => [{ address, fromBlock: toHexBlock(fromBlock), toBlock: toHexBlock(toBlock), topics: [topic0] }] });
}

export function indexTrackedUsdcTransfers({ client, rpc, chainId, sourceKey, worldId = null,
  trackedWallets = [], startBlock = null, latestBlock = null, maxBlockCount = ARC_GET_LOGS_MAX_BLOCK_COUNT,
  maxPages = 1 }) {
  const addresses = normalizeAddresses(trackedWallets);
  if (!addresses.length) return Promise.resolve({ configured: false, indexedLogs: 0, lastIndexedBlock: null, reason: 'no_wallet_addresses' });
  return scanLogs({ client, rpc, chainId, sourceKey, worldId, eventType: 'usdc_native_transfer', startBlock,
    latestBlock, maxBlockCount, maxPages,
    getFilters: (fromBlock, toBlock) => buildTrackedUsdcTransferFilters(addresses, fromBlock, toBlock) });
}

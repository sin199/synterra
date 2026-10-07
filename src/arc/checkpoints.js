import { concat, id, keccak256, Interface } from 'ethers';
import { assertArcMainnetChainId } from './config.js';
import { toArcBytes16Uuid } from './settlement.js';

const WORLD_REGISTRY_INTERFACE = new Interface([
  'function checkpoint(uint64 worldMinute, uint64 epoch, uint64 version, bytes32 historyRoot, bytes32 simulationLedgerRoot, bytes32 capabilityRoot)'
]);

const CHECKPOINT_MINIMUM_INTERVAL_WORLD_MINUTES = 1_440;

const ROOT_QUERIES = Object.freeze({
  history: [
    ['world_events', `SELECT count(*)::text AS count,encode(digest(COALESCE(string_agg(
        encode(digest(to_jsonb(source_row)::text,'sha256'),'hex'),'' ORDER BY source_row.id),''),'sha256'),'hex') AS root
      FROM world_events source_row WHERE world_id=$1`],
    ['world_history', `SELECT count(*)::text AS count,encode(digest(COALESCE(string_agg(
        encode(digest(to_jsonb(source_row)::text,'sha256'),'hex'),'' ORDER BY source_row.id),''),'sha256'),'hex') AS root
      FROM world_history source_row WHERE world_id=$1`]
  ],
  simulationLedger: [
    ['world_economic_transactions', `SELECT count(*)::text AS count,encode(digest(COALESCE(string_agg(
        encode(digest(to_jsonb(source_row)::text,'sha256'),'hex'),'' ORDER BY source_row.id),''),'sha256'),'hex') AS root
      FROM world_economic_transactions source_row WHERE world_id=$1`],
      ['world_economic_postings', `SELECT count(*)::text AS count,encode(digest(COALESCE(string_agg(
        encode(digest(to_jsonb(posting)::text,'sha256'),'hex'),'' ORDER BY posting.id),''),'sha256'),'hex') AS root
      FROM world_economic_postings posting JOIN world_economic_transactions tx
        ON tx.id=posting.transaction_id WHERE tx.world_id=$1`],
    ['world_economic_accounts', `SELECT count(*)::text AS count,encode(digest(COALESCE(string_agg(
        encode(digest(to_jsonb(source_row)::text,'sha256'),'hex'),'' ORDER BY source_row.id),''),'sha256'),'hex') AS root
      FROM world_economic_accounts source_row WHERE world_id=$1`],
    ['token_ledger', `SELECT count(*)::text AS count,encode(digest(COALESCE(string_agg(
        encode(digest(to_jsonb(source_row)::text,'sha256'),'hex'),'' ORDER BY source_row.id),''),'sha256'),'hex') AS root
      FROM token_ledger source_row WHERE world_id=$1`],
    ['crypto_ledger', `SELECT count(*)::text AS count,encode(digest(COALESCE(string_agg(
        encode(digest(to_jsonb(source_row)::text,'sha256'),'hex'),'' ORDER BY source_row.id),''),'sha256'),'hex') AS root
      FROM crypto_ledger source_row WHERE world_id=$1`],
    ['crypto_balances', `SELECT count(*)::text AS count,encode(digest(COALESCE(string_agg(
        encode(digest(to_jsonb(source_row)::text,'sha256'),'hex'),'' ORDER BY source_row.agent_id,source_row.asset_symbol),''),'sha256'),'hex') AS root
      FROM crypto_balances source_row WHERE world_id=$1`],
    ['robinhood_paper_ledger', `SELECT count(*)::text AS count,encode(digest(COALESCE(string_agg(
        encode(digest(to_jsonb(source_row)::text,'sha256'),'hex'),'' ORDER BY source_row.id),''),'sha256'),'hex') AS root
      FROM robinhood_paper_ledger source_row WHERE world_id=$1`],
    ['robinhood_paper_positions', `SELECT count(*)::text AS count,encode(digest(COALESCE(string_agg(
        encode(digest(to_jsonb(source_row)::text,'sha256'),'hex'),'' ORDER BY source_row.agent_id,source_row.token_address),''),'sha256'),'hex') AS root
      FROM robinhood_paper_positions source_row WHERE world_id=$1`]
  ],
  capabilities: [
    ['world_capabilities', `SELECT count(*)::text AS count,encode(digest(COALESCE(string_agg(
        encode(digest(to_jsonb(source_row)::text,'sha256'),'hex'),'' ORDER BY source_row.id),''),'sha256'),'hex') AS root
      FROM world_capabilities source_row WHERE world_id=$1`]
  ]
});

async function collectRoots(client, worldId) {
  const output = {};
  for (const [group, queries] of Object.entries(ROOT_QUERIES)) {
    const leaves = [];
    let rowCount = 0n;
    for (const [source, sql] of queries) {
      const result = await client.query(sql, [worldId]);
      const row = result.rows[0];
      rowCount += BigInt(row.count);
      leaves.push({ source, count: row.count, root: `0x${row.root}` });
    }
    output[group] = { root: keccak256(concat(leaves.map((leaf) => id(JSON.stringify(leaf)))),), count: rowCount.toString(), sources: leaves };
  }
  return output;
}

function parseEpochNumber(code) {
  const match = /^V([1-9]\d*)$/.exec(String(code || ''));
  if (!match) throw new TypeError('epoch must be a positive V-number.');
  return Number(match[1]);
}

function uint64(value, name, { allowZero = true } = {}) {
  let parsed;
  try { parsed = BigInt(value); }
  catch { throw new TypeError(`${name} must be an integer.`); }
  if (parsed < (allowZero ? 0n : 1n) || parsed > 0xffff_ffff_ffff_ffffn) {
    throw new RangeError(`${name} is outside the uint64 range.`);
  }
  return parsed;
}

export async function prepareArcWorldCheckpoint(client, { worldId, chainId,
  minimumIntervalWorldMinutes = CHECKPOINT_MINIMUM_INTERVAL_WORLD_MINUTES, importantEvent = false }) {
  if (typeof worldId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(worldId)) {
    throw new TypeError('worldId must be a UUID.');
  }
  assertArcMainnetChainId(chainId);
  const minimumInterval = uint64(minimumIntervalWorldMinutes, 'minimumIntervalWorldMinutes');
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
  try {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`arc-checkpoint:${worldId}:${chainId}`]);
    const runtime = await client.query('SELECT world_minutes FROM world_runtime_state WHERE world_id=$1', [worldId]);
    const epoch = await client.query(`SELECT epoch_code AS code FROM world_epochs WHERE world_id=$1
      ORDER BY (status='active') DESC,started_world_minute DESC,id DESC LIMIT 1`, [worldId]);
    const prior = await client.query(`SELECT * FROM arc_world_checkpoints WHERE world_id=$1 AND chain_id=$2
      AND status IN ('prepared','submitted','final') ORDER BY world_minute DESC,version DESC LIMIT 1`, [worldId, chainId]);
    const maxVersion = await client.query(`SELECT COALESCE(max(version),0)::text AS version
      FROM arc_world_checkpoints WHERE world_id=$1 AND chain_id=$2`, [worldId, chainId]);
    if (!runtime.rowCount) throw new Error('World runtime row not found for checkpoint preparation.');
    const worldMinute = BigInt(runtime.rows[0].world_minutes);
    const epochCode = epoch.rows[0]?.code || 'V1';
    const previous = prior.rows[0] || null;
    const version = uint64(BigInt(maxVersion.rows[0].version) + 1n, 'checkpoint version', { allowZero: false });
    if (previous && worldMinute <= BigInt(previous.world_minute)) {
      await client.query('ROLLBACK');
      return { due: false, reason: 'world_minute_not_advanced', worldMinute: worldMinute.toString() };
    }
    if (previous && !importantEvent
        && worldMinute - BigInt(previous.world_minute) < minimumInterval) {
      await client.query('ROLLBACK');
      return { due: false, reason: 'checkpoint_interval_not_reached',
        worldMinute: worldMinute.toString(), lastCheckpointWorldMinute: String(previous.world_minute) };
    }
    const roots = await collectRoots(client, worldId);
    const priorHistoryRoot = previous?.history_root || `0x${'00'.repeat(32)}`;
    const priorLedgerRoot = previous?.simulation_ledger_root || `0x${'00'.repeat(32)}`;
    const historyRoot = keccak256(concat([priorHistoryRoot, roots.history.root]));
    const simulationLedgerRoot = keccak256(concat([priorLedgerRoot, roots.simulationLedger.root]));
    const capabilityRoot = roots.capabilities.root;
    const inserted = await client.query(`INSERT INTO arc_world_checkpoints(world_id,chain_id,world_minute,epoch,version,
        previous_checkpoint_id,history_segment_root,simulation_ledger_segment_root,history_root,
        simulation_ledger_root,capability_root,status,metadata)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'prepared',$12::jsonb)
      ON CONFLICT(world_id,chain_id,world_minute) DO NOTHING RETURNING *`, [
      worldId, chainId, worldMinute.toString(), epochCode, version.toString(), previous?.id || null,
      roots.history.root, roots.simulationLedger.root, historyRoot, simulationLedgerRoot, capabilityRoot,
      JSON.stringify({ roots: Object.fromEntries(Object.entries(roots).map(([key, value]) => [key,
        { count: value.count, sourceCounts: Object.fromEntries(value.sources.map((source) => [source.source, source.count])) }])) })
    ]);
    if (!inserted.rowCount) {
      const existing = (await client.query('SELECT * FROM arc_world_checkpoints WHERE world_id=$1 AND chain_id=$2 AND world_minute=$3',
        [worldId, chainId, worldMinute.toString()])).rows[0];
      if (existing?.history_root === historyRoot && existing?.simulation_ledger_root === simulationLedgerRoot
          && existing?.capability_root === capabilityRoot && existing?.epoch === epochCode) {
        await client.query('COMMIT');
        return { due: true, created: false, idempotent: true, checkpoint: existing, roots };
      }
      const error = new Error('A different checkpoint already exists for this world minute.');
      error.code = 'ARC_CHECKPOINT_IDEMPOTENCY_CONFLICT';
      throw error;
    }
    await client.query('COMMIT');
    return { due: true, created: true, idempotent: false, checkpoint: inserted.rows[0], roots };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

export function buildWorldRegistryCheckpointTransaction({ registryAddress, worldId,
  worldMinute, epoch, version, historyRoot, simulationLedgerRoot, capabilityRoot }) {
  if (typeof registryAddress !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(registryAddress)) {
    throw new TypeError('registryAddress must be a valid EVM address.');
  }
  toArcBytes16Uuid(worldId, 'worldId');
  const worldMinuteNumber = uint64(worldMinute, 'worldMinute', { allowZero: false });
  const epochNumber = typeof epoch === 'number' ? epoch : parseEpochNumber(epoch);
  if (!Number.isSafeInteger(epochNumber) || epochNumber < 1) throw new RangeError('epoch must be a positive safe integer.');
  const versionNumber = uint64(version, 'version', { allowZero: false });
  uint64(epochNumber, 'epoch', { allowZero: false });
  const transaction = {
    to: registryAddress,
    value: 0n,
    data: WORLD_REGISTRY_INTERFACE.encodeFunctionData('checkpoint', [worldMinuteNumber, epochNumber,
      versionNumber, historyRoot, simulationLedgerRoot, capabilityRoot])
  };
  return transaction;
}

export function checkpointWorldUuid(worldId) { return toArcBytes16Uuid(worldId); }

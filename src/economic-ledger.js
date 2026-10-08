import { parsePositiveUnits, formatUnits } from './units.js';

const ASSETS = new Set(['USDC']);
const ACCOUNT_TYPES = new Set(['resident', 'organization', 'business', 'project', 'system']);

function ledgerError(code, statusCode = 409) {
  return Object.assign(new Error(code), { statusCode });
}

function accountKey(type, ownerId, explicitKey) {
  if (explicitKey) return String(explicitKey).slice(0, 160);
  if (type === 'system') throw ledgerError('SYSTEM_ACCOUNT_KEY_REQUIRED', 400);
  if (!ownerId) throw ledgerError('ECONOMIC_ACCOUNT_OWNER_REQUIRED', 400);
  // Resident accounts use the resident UUID as their stable account key.
  return type === 'resident' ? String(ownerId) : `${type}:${ownerId}`.slice(0, 160);
}

export async function ensureEconomicAccount(client, { worldId, accountType, ownerId = null, key = null,
  asset = 'USDC', initialBalance = '0.00000000' }) {
  if (!ACCOUNT_TYPES.has(accountType) || !ASSETS.has(asset)) throw ledgerError('ECONOMIC_ACCOUNT_INVALID', 400);
  const normalizedKey = accountKey(accountType, ownerId, key);
  const inserted = await client.query(`INSERT INTO world_economic_accounts(world_id,account_type,account_key,owner_id,asset_symbol,balance)
    VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(world_id,account_key,asset_symbol) DO NOTHING
    RETURNING id,world_id,account_type AS "accountType",account_key AS key,owner_id AS "ownerId",asset_symbol AS asset,balance::text AS balance`,
  [worldId, accountType, normalizedKey, ownerId, asset, initialBalance]);
  if (inserted.rowCount) return inserted.rows[0];
  const existing = await client.query(`SELECT id,world_id,account_type AS "accountType",account_key AS key,
      owner_id AS "ownerId",asset_symbol AS asset,balance::text AS balance
    FROM world_economic_accounts WHERE world_id=$1 AND account_key=$2 AND asset_symbol=$3`, [worldId, normalizedKey, asset]);
  if (!existing.rowCount || existing.rows[0].accountType !== accountType) throw ledgerError('ECONOMIC_ACCOUNT_CONFLICT');
  return existing.rows[0];
}

export async function ensureResidentEconomicAccounts(client, { worldId, agentId, worldTime = 0 }) {
  void worldTime;
  await ensureEconomicAccount(client, { worldId, accountType: 'resident', ownerId: agentId, asset: 'USDC' });
}

export async function getEconomicAccount(client, { worldId, accountType, ownerId = null, key = null, asset = 'USDC', forUpdate = false }) {
  const normalizedKey = accountKey(accountType, ownerId, key);
  const result = await client.query(`SELECT id,world_id,account_type AS "accountType",account_key AS key,
      owner_id AS "ownerId",asset_symbol AS asset,balance::text AS balance
    FROM world_economic_accounts WHERE world_id=$1 AND account_key=$2 AND asset_symbol=$3 ${forUpdate ? 'FOR UPDATE' : ''}`,
  [worldId, normalizedKey, asset]);
  return result.rows[0] || null;
}

export async function postEconomicTransfer(client, { worldId, sourceAccountId, destinationAccountId, asset = 'USDC', amount,
  transactionType, reason, worldTime = 0, actionId, referenceId = null, metadata = {} }) {
  if (!ASSETS.has(asset) || !transactionType || typeof reason !== 'string' || reason.trim().length < 3
      || typeof actionId !== 'string' || actionId.length < 1 || actionId.length > 180) {
    throw ledgerError('ECONOMIC_TRANSFER_INVALID', 400);
  }
  if (!sourceAccountId || sourceAccountId === destinationAccountId) throw ledgerError('ECONOMIC_TRANSFER_ACCOUNTS_INVALID', 400);
  const normalized = formatUnits(parsePositiveUnits(String(amount)));
  const amountScaled = parsePositiveUnits(normalized);
  const tick = Math.max(0, Math.trunc(Number(worldTime) || 0));
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`economy:${worldId}:${actionId}`]);
  const duplicate = await client.query(`SELECT id,action_id AS "actionId",transaction_type AS "transactionType",
      source_account_id AS "sourceAccountId",destination_account_id AS "destinationAccountId",
      asset_symbol AS asset,amount::text AS amount,reason,reference_id AS "referenceId"
    FROM world_economic_transactions
    WHERE world_id=$1 AND action_id=$2`, [worldId, actionId]);
  if (duplicate.rowCount) {
    const prior = duplicate.rows[0];
    // actionId identifies the transfer; the world clock may advance before a retry arrives.
    const same = prior.transactionType === transactionType && prior.sourceAccountId === sourceAccountId
      && prior.destinationAccountId === destinationAccountId && prior.asset === asset
      && parsePositiveUnits(prior.amount).toString() === amountScaled.toString()
      && prior.reason === reason.trim().slice(0, 240) && prior.referenceId === referenceId;
    if (!same) throw ledgerError('ECONOMIC_ACTION_ID_CONFLICT');
    return { transactionId: prior.id, amount: normalized, asset, idempotent: true };
  }
  const accounts = await client.query(`SELECT id,world_id,account_type AS "accountType",asset_symbol AS asset,
      balance::text AS balance FROM world_economic_accounts WHERE world_id=$1 AND id=ANY($2::uuid[])
    ORDER BY id FOR UPDATE`, [worldId, [sourceAccountId, destinationAccountId]]);
  if (accounts.rowCount !== 2) throw ledgerError('ECONOMIC_ACCOUNT_NOT_FOUND', 404);
  const source = accounts.rows.find((row) => row.id === sourceAccountId);
  const destination = accounts.rows.find((row) => row.id === destinationAccountId);
  if (!source || !destination || source.asset !== asset || destination.asset !== asset) throw ledgerError('ECONOMIC_ASSET_MISMATCH');
  if (source.accountType !== 'system' && parsePositiveUnits(source.balance, { allowZero: true }) < amountScaled) {
    throw ledgerError('INSUFFICIENT_SIMULATED_USDC');
  }
  const inserted = await client.query(`INSERT INTO world_economic_transactions(world_id,action_id,transaction_type,
      source_account_id,destination_account_id,asset_symbol,amount,reason,world_time,reference_id,metadata)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb) ON CONFLICT(world_id,action_id) DO NOTHING
    RETURNING id`, [worldId, actionId, transactionType, sourceAccountId, destinationAccountId, asset, normalized,
    reason.trim().slice(0, 240), tick, referenceId, JSON.stringify(metadata || {})]);
  if (!inserted.rowCount) {
    const prior = await client.query('SELECT id FROM world_economic_transactions WHERE world_id=$1 AND action_id=$2', [worldId, actionId]);
    return { transactionId: prior.rows[0]?.id || null, idempotent: true };
  }
  const transactionId = inserted.rows[0].id;
  await client.query(`INSERT INTO world_economic_postings(transaction_id,account_id,amount) VALUES
    ($1,$2,-($3::numeric)),($1,$4,$3::numeric)`, [transactionId, sourceAccountId, normalized, destinationAccountId]);
  const changed = await client.query(`UPDATE world_economic_accounts SET balance=balance+$3::numeric,updated_at=now()
    WHERE world_id=$1 AND id=$2 RETURNING account_type AS "accountType",owner_id AS "ownerId",asset_symbol AS asset,balance::text AS balance`,
  [worldId, destinationAccountId, normalized]);
  const debited = await client.query(`UPDATE world_economic_accounts SET balance=balance-$3::numeric,updated_at=now()
    WHERE world_id=$1 AND id=$2 AND (account_type='system' OR balance >= $3::numeric)
    RETURNING account_type AS "accountType",owner_id AS "ownerId",asset_symbol AS asset,balance::text AS balance`,
  [worldId, sourceAccountId, normalized]);
  if (!debited.rowCount) throw ledgerError('INSUFFICIENT_SIMULATED_USDC');
  return { transactionId, amount: normalized, asset, idempotent: false };
}

export async function transferBetweenAccounts(client, { worldId, source, destination, asset = 'USDC', ...details }) {
  const sourceAccount = await getEconomicAccount(client, { worldId, ...source, asset });
  const destinationAccount = await getEconomicAccount(client, { worldId, ...destination, asset });
  if (!sourceAccount || !destinationAccount) throw ledgerError('ECONOMIC_ACCOUNT_NOT_FOUND', 404);
  return postEconomicTransfer(client, { worldId, sourceAccountId: sourceAccount.id,
    destinationAccountId: destinationAccount.id, asset, ...details });
}

export async function readAccountBalance(client, { worldId, accountType, ownerId = null, key = null, asset = 'USDC' }) {
  const account = await getEconomicAccount(client, { worldId, accountType, ownerId, key, asset });
  return account?.balance || '0.00000000';
}

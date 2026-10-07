import { assertArcMainnetChainId } from './config.js';

const ACTIVE_NONCE_STATES = ['reserved', 'submitted', 'unknown'];

function address(value) {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new TypeError('Arc nonce reservation requires a valid signer address.');
  }
  return value.toLowerCase();
}

function nonNegative(value, label) {
  let parsed;
  try { parsed = BigInt(value); }
  catch { throw new TypeError(`${label} must be a non-negative integer.`); }
  if (parsed < 0n) throw new RangeError(`${label} must be a non-negative integer.`);
  return parsed;
}

function errorWithCode(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export async function reserveArcNonce(pool, { chainId, signerAddress, outboxId, pendingNonce, startBlock }) {
  assertArcMainnetChainId(chainId);
  const normalizedAddress = address(signerAddress);
  const observedNonce = nonNegative(pendingNonce, 'pendingNonce');
  const start = nonNegative(startBlock, 'startBlock');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
      [`arc-nonce:${chainId}:${normalizedAddress}`]);
    const existing = await client.query(`SELECT id,status,nonce::text AS nonce,start_block::text AS start_block
      FROM arc_nonce_reservations WHERE outbox_id=$1 FOR UPDATE`, [outboxId]);
    const unresolved = await client.query(`SELECT outbox_id FROM arc_nonce_reservations
      WHERE chain_id=$1 AND lower(address)=lower($2) AND status=ANY($3::text[]) AND outbox_id<>$4
      ORDER BY nonce LIMIT 1 FOR UPDATE`, [chainId, normalizedAddress, ACTIVE_NONCE_STATES, outboxId]);
    if (unresolved.rowCount) throw errorWithCode('ARC_NONCE_RECONCILIATION_REQUIRED',
      'An earlier nonce for this signer is unresolved; automatic nonce advancement is blocked.');

    const cursor = await client.query(`SELECT next_nonce::text AS next_nonce FROM arc_nonce_cursors
      WHERE chain_id=$1 AND lower(address)=lower($2) FOR UPDATE`, [chainId, normalizedAddress]);
    const savedNext = cursor.rowCount ? BigInt(cursor.rows[0].next_nonce) : 0n;
    const existingRow = existing.rows[0] || null;
    if (existingRow && !['reserved', 'released'].includes(existingRow.status)) {
      throw errorWithCode('ARC_NONCE_RESERVATION_NOT_REUSABLE',
        'This settlement already has a nonce reservation in a non-reusable state.');
    }
    const existingNonce = existingRow ? BigInt(existingRow.nonce) : -1n;
    const nonce = existingRow?.status === 'reserved' && existingNonce >= observedNonce
      ? existingNonce : [savedNext, observedNonce].reduce((max, value) => value > max ? value : max, 0n);
    if (existingRow) {
      await client.query(`UPDATE arc_nonce_reservations SET nonce=$2,status='reserved',start_block=$3,
          transaction_hash=NULL,updated_at=now() WHERE id=$1`, [existingRow.id, nonce.toString(), start.toString()]);
    } else {
      await client.query(`INSERT INTO arc_nonce_reservations(chain_id,address,nonce,outbox_id,status,start_block)
        VALUES($1,$2,$3,$4,'reserved',$5)`, [chainId, normalizedAddress, nonce.toString(), outboxId, start.toString()]);
    }
    await client.query(`INSERT INTO arc_nonce_cursors(chain_id,address,next_nonce,updated_at)
      VALUES($1,$2,$3,now()) ON CONFLICT(chain_id,address) DO UPDATE SET
        next_nonce=GREATEST(arc_nonce_cursors.next_nonce,EXCLUDED.next_nonce),updated_at=now()`,
    [chainId, normalizedAddress, (nonce + 1n).toString()]);
    await client.query(`UPDATE arc_settlement_outbox SET nonce=$2,submission_start_block=$3,
        reconciliation_cursor_block=COALESCE(reconciliation_cursor_block,$3),reconciliation_tx_cursor_block=COALESCE(reconciliation_tx_cursor_block,$3),updated_at=now()
      WHERE id=$1`, [outboxId, nonce.toString(), start.toString()]);
    await client.query('COMMIT');
    return { nonce, startBlock: start, reused: Boolean(existingRow && existingRow.status === 'reserved' && existingNonce === nonce) };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function markArcNonceReservation(poolOrClient, { outboxId, status, transactionHash = null }) {
  if (!['reserved', 'submitted', 'unknown', 'reconciled', 'released'].includes(status)) {
    throw new TypeError('Arc nonce reservation status is invalid.');
  }
  const result = await poolOrClient.query(`UPDATE arc_nonce_reservations SET status=$2,
      transaction_hash=COALESCE($3,transaction_hash),updated_at=now() WHERE outbox_id=$1
      AND status=ANY($4::text[]) RETURNING id`, [outboxId, status, transactionHash,
    status === 'unknown' ? ['reserved', 'submitted', 'unknown']
      : status === 'submitted' ? ['reserved', 'submitted', 'unknown']
        : status === 'reconciled' ? ['reserved', 'submitted', 'unknown', 'reconciled']
          : status === 'released' ? ['reserved', 'released'] : ['reserved']]);
  return result.rowCount === 1;
}

export async function releaseArcNonceReservation(poolOrClient, outboxId) {
  const result = await poolOrClient.query(`WITH released AS (
      UPDATE arc_nonce_reservations SET status='released',updated_at=now()
      WHERE outbox_id=$1 AND status='reserved' RETURNING chain_id,address,nonce
    )
    UPDATE arc_nonce_cursors cursor SET next_nonce=LEAST(cursor.next_nonce,released.nonce),updated_at=now()
    FROM released WHERE cursor.chain_id=released.chain_id AND lower(cursor.address)=lower(released.address)
    RETURNING cursor.next_nonce::text AS next_nonce`, [outboxId]);
  return result.rowCount > 0;
}

export async function markStaleArcSubmissionsUnknown(pool, { leaseMinutes = 2 } = {}) {
  const lease = Math.max(1, Math.min(30, Math.trunc(Number(leaseMinutes) || 2)));
  return pool.query(`WITH stale AS (
      UPDATE arc_settlement_outbox SET status='submission_unknown',
          reconciliation_reason='SUBMISSION_LEASE_EXPIRED',updated_at=now()
      WHERE status='submitting' AND transaction_hash IS NULL
        AND submission_started_at < now() - ($1::text || ' minutes')::interval
      RETURNING id
    )
    UPDATE arc_nonce_reservations reservation SET status='unknown',updated_at=now()
    FROM stale WHERE reservation.outbox_id=stale.id AND reservation.status IN ('reserved','unknown')
    RETURNING reservation.outbox_id`, [lease]);
}

export async function saveArcReconciliationCursor(client, { outboxId, nextBlock, cursorType = 'logs', reason = null }) {
  const cursor = nonNegative(nextBlock, 'nextBlock');
  const column = cursorType === 'transactions' ? 'reconciliation_tx_cursor_block' : 'reconciliation_cursor_block';
  if (!['logs', 'transactions'].includes(cursorType)) throw new TypeError('Unknown reconciliation cursor type.');
  return client.query(`UPDATE arc_settlement_outbox SET ${column}=$2,reconciliation_reason=$3,updated_at=now()
    WHERE id=$1 AND status='submission_unknown' AND transaction_hash IS NULL RETURNING id`,
  [outboxId, cursor.toString(), reason]);
}

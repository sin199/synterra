import { assertArcMainnetChainId } from './config.js';

const ACTIVE_STATES = ['reserved','submitting','submission_unknown','submitted'];
const OPERATION_TYPES = new Set(['token_creation','token_reserve_release','deployment','checkpoint','provenance']);

function nonNegative(value, label) {
  let parsed;
  try { parsed = BigInt(value); } catch { throw new TypeError(`${label} must be a non-negative integer.`); }
  if (parsed < 0n) throw new RangeError(`${label} must be a non-negative integer.`);
  return parsed;
}

function normalizeAddress(value) {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new TypeError('Infrastructure nonce reservation requires an EVM address.');
  }
  return value.toLowerCase();
}

function coded(code) { return Object.assign(new Error(code), { code }); }

// Caller owns a PostgreSQL transaction; nonce, operation state and global
// pilot-budget changes can therefore commit or roll back together.
export async function reserveArcInfrastructureNonce(client, { chainId, address, operationType, operationId,
  pendingNonce, startBlock }) {
  assertArcMainnetChainId(chainId);
  const signerAddress = normalizeAddress(address);
  const observedNonce = nonNegative(pendingNonce, 'pendingNonce');
  const start = nonNegative(startBlock, 'startBlock');
  if (!OPERATION_TYPES.has(operationType)) throw new TypeError('Infrastructure nonce operation type is unsupported.');
  if (typeof operationId !== 'string' || operationId.length < 1 || operationId.length > 180) {
    throw new TypeError('Infrastructure nonce operationId must contain 1 to 180 characters.');
  }
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
    [`arc-infra-nonce:${chainId}:${signerAddress}`]);
  const existing = await client.query(`SELECT id,status,nonce::text AS nonce,start_block::text AS start_block
    FROM arc_infrastructure_nonce_reservations WHERE operation_type=$1 AND operation_id=$2 FOR UPDATE`,
  [operationType, operationId]);
  const unresolved = await client.query(`SELECT operation_id FROM arc_infrastructure_nonce_reservations
    WHERE chain_id=$1 AND lower(address)=lower($2) AND status=ANY($3::text[])
      AND NOT (operation_type=$4 AND operation_id=$5) ORDER BY nonce LIMIT 1 FOR UPDATE`,
  [chainId, signerAddress, ACTIVE_STATES, operationType, operationId]);
  if (unresolved.rowCount) throw coded('ARC_INFRA_NONCE_RECONCILIATION_REQUIRED');
  const cursor = await client.query(`SELECT next_nonce::text AS next_nonce FROM arc_infrastructure_nonce_cursors
    WHERE chain_id=$1 AND lower(address)=lower($2) FOR UPDATE`, [chainId, signerAddress]);
  const savedNext = cursor.rowCount ? BigInt(cursor.rows[0].next_nonce) : 0n;
  const prior = existing.rows[0] || null;
  if (prior && !['reserved','released'].includes(prior.status)) throw coded('ARC_INFRA_NONCE_NOT_REUSABLE');
  const priorNonce = prior ? BigInt(prior.nonce) : -1n;
  const nonce = prior?.status === 'reserved' && priorNonce >= observedNonce
    ? priorNonce : [savedNext, observedNonce].reduce((max, value) => value > max ? value : max, 0n);
  if (prior) {
    await client.query(`UPDATE arc_infrastructure_nonce_reservations SET nonce=$2,start_block=$3,status='reserved',
      transaction_hash=NULL,updated_at=now() WHERE id=$1`, [prior.id, nonce.toString(), start.toString()]);
  } else {
    await client.query(`INSERT INTO arc_infrastructure_nonce_reservations(chain_id,address,operation_type,operation_id,
      nonce,start_block,status) VALUES($1,$2,$3,$4,$5,$6,'reserved')`,
    [chainId, signerAddress, operationType, operationId, nonce.toString(), start.toString()]);
  }
  await client.query(`INSERT INTO arc_infrastructure_nonce_cursors(chain_id,address,next_nonce,updated_at)
    VALUES($1,$2,$3,now()) ON CONFLICT(chain_id,address) DO UPDATE SET
      next_nonce=GREATEST(arc_infrastructure_nonce_cursors.next_nonce,EXCLUDED.next_nonce),updated_at=now()`,
  [chainId, signerAddress, (nonce + 1n).toString()]);
  return { nonce, startBlock: start, reused: Boolean(prior?.status === 'reserved' && priorNonce === nonce) };
}

export async function markArcInfrastructureNonce(client, { operationType, operationId, status, transactionHash = null }) {
  if (!['reserved','submitting','submission_unknown','submitted','reconciled','released','failed'].includes(status)) {
    throw new TypeError('Infrastructure nonce reservation status is invalid.');
  }
  if (transactionHash !== null && !/^0x[0-9a-fA-F]{64}$/.test(transactionHash)) {
    throw new TypeError('Infrastructure transaction hash must be 32-byte hex.');
  }
  const result = await client.query(`UPDATE arc_infrastructure_nonce_reservations SET status=$3,
      transaction_hash=COALESCE($4,transaction_hash),updated_at=now()
    WHERE operation_type=$1 AND operation_id=$2 AND status=ANY($5::text[]) RETURNING id`,
  [operationType, operationId, status, transactionHash,
    status === 'released' ? ['reserved','released'] : status === 'submitting' ? ['reserved','submitting']
      : ['reserved','submitting','submission_unknown','submitted']]);
  return result.rowCount === 1;
}

export async function releaseArcInfrastructureNonce(client, { operationType, operationId }) {
  const result = await client.query(`WITH released AS (
      UPDATE arc_infrastructure_nonce_reservations SET status='released',updated_at=now()
      WHERE operation_type=$1 AND operation_id=$2 AND status='reserved'
      RETURNING chain_id,address,nonce
    )
    UPDATE arc_infrastructure_nonce_cursors cursor SET next_nonce=LEAST(cursor.next_nonce,released.nonce),updated_at=now()
    FROM released WHERE cursor.chain_id=released.chain_id AND lower(cursor.address)=lower(released.address)
    RETURNING cursor.next_nonce::text AS next_nonce`, [operationType, operationId]);
  return result.rowCount === 1;
}

import { formatUnits, parseUnits } from 'ethers';
import { id, keccak256, toUtf8Bytes } from 'ethers';
import { ARC_MAINNET_CHAIN_ID } from './arc/config.js';

const GENESIS_SETTLEMENT_WALLET_TYPES = new Set(['eoa','sca','msca']);

function economyError(code, statusCode = 409) {
  return Object.assign(new Error(code), { code, statusCode });
}

export async function readGenesisCurrencyActivation(client, worldId, { forUpdate = false } = {}) {
  const result = await client.query(`SELECT activation.world_id,activation.token_id AS "tokenId",
      token.token_address AS "tokenAddress",token.name,token.symbol,token.decimals,
      token.initial_supply_raw::text AS "initialSupplyRaw",
      activation.chain_id AS "chainId",activation.issuer_agent_id AS "issuerAgentId",
      activation.issuer_selection_source AS "issuerSelectionSource",activation.transaction_hash AS "transactionHash",
      activation.block_number::text AS "blockNumber",activation.world_minute AS "worldMinute",
      activation.creator_allocation_raw::text AS "creatorAllocationRaw",activation.activated_at AS "activatedAt"
    FROM world_genesis_currency_activations activation
    JOIN arc_agent_tokens token ON token.world_id=activation.world_id AND token.id=activation.token_id
    WHERE activation.world_id=$1 ${forUpdate ? 'FOR UPDATE OF activation' : ''}`, [worldId]);
  return result.rows[0] || null;
}

/**
 * Business equity is a separate contractual right. It is current only after
 * the related Agent-wallet transfer is confirmed by Arc reconciliation; this
 * query never treats an off-chain agreement or a token balance as the other.
 */
export async function readGenesisBusinessEquity(client, { worldId, agentId = null, tokenId = null }) {
  const activation = await readGenesisCurrencyActivation(client, worldId);
  if (!activation || (tokenId && activation.tokenId !== tokenId)) {
    return { investments: [], pendingObligations: [] };
  }
  const result = await client.query(`SELECT agreement.id AS "agreementId",
      business.id AS "businessId",business.name AS "businessName",
      business.founder_agent_id AS "founderAgentId",agreement.terms->>'tokenId' AS "tokenId",
      CASE WHEN business.founder_agent_id=agreement.proposer_agent_id
        THEN agreement.counterparty_agent_id ELSE agreement.proposer_agent_id END AS "investorAgentId",
      agreement.terms->>'amountRaw' AS "amountRaw",
      agreement.terms->>'ownershipShare' AS "ownershipShare",
      agreement.status AS "agreementStatus",
      agreement.metadata->'execution'->>'settlementId' AS "settlementId",
      agreement.metadata->'execution'->>'settlementStatus' AS "settlementStatus",
      agreement.metadata->'execution'->>'ownershipStatus' AS "ownershipStatus",
      agreement.metadata->'execution'->>'transactionHash' AS "transactionHash",
      agreement.metadata->'execution'->>'blockNumber' AS "blockNumber"
    FROM world_agreements agreement
    JOIN world_businesses business ON business.world_id=agreement.world_id
      AND business.id::text=agreement.terms->>'businessId'
    WHERE agreement.world_id=$1 AND agreement.agreement_type='investment'
      AND agreement.terms->>'tokenId'=$3
      AND ($2::uuid IS NULL OR CASE WHEN business.founder_agent_id=agreement.proposer_agent_id
        THEN agreement.counterparty_agent_id ELSE agreement.proposer_agent_id END=$2)
      AND agreement.status IN ('active','completed')
    ORDER BY agreement.created_world_time,agreement.id`, [worldId, agentId, activation.tokenId]);
  const rows = result.rows.map((row) => ({ ...row,
    amountRaw: row.amountRaw === null ? null : String(row.amountRaw),
    ownershipShare: row.ownershipShare === null ? null : String(row.ownershipShare),
    tokenOwnershipAuthority: 'arc_chain_confirmation' }));
  return {
    investments: rows.filter((row) => row.agreementStatus === 'completed'
      && row.ownershipStatus === 'arc_confirmed_business_equity'),
    pendingObligations: rows.filter((row) => row.agreementStatus === 'active'
      && row.settlementStatus !== 'final' && row.settlementStatus !== 'failed')
  };
}

export async function isGenesisCurrencyActive(client, worldId) {
  return Boolean(await readGenesisCurrencyActivation(client, worldId));
}

export async function assertLegacySimulatedEconomyAvailable(client, worldId) {
  if (await isGenesisCurrencyActive(client, worldId)) throw economyError('LEGACY_SIMULATED_ECONOMY_RETIRED');
}

export function parseGenesisTokenRaw(humanAmount, decimals) {
  if (typeof humanAmount !== 'string' || !/^(0|[1-9]\d*)(?:\.\d+)?$/.test(humanAmount.trim())) {
    throw economyError('GENESIS_TOKEN_AMOUNT_INVALID', 400);
  }
  try {
    const raw = parseUnits(humanAmount.trim(), Number(decimals));
    if (raw <= 0n || raw > (1n << 128n) - 1n) throw economyError('GENESIS_TOKEN_AMOUNT_OUT_OF_RANGE', 400);
    return raw;
  } catch (error) {
    if (error?.code === 'GENESIS_TOKEN_AMOUNT_OUT_OF_RANGE') throw error;
    throw economyError('GENESIS_TOKEN_AMOUNT_PRECISION_INVALID', 400);
  }
}

export function formatGenesisTokenRaw(raw, decimals) {
  return formatUnits(BigInt(raw), Number(decimals));
}

async function verifiedWallet(client, { worldId, agentId = null, organizationId = null,
  requireSettlementAuthorization = false }) {
  if (agentId) {
    const result = await client.query(`SELECT address,account_type AS "accountType",agent_id AS "agentId",
        NULL::uuid AS "organizationId"
      FROM arc_agent_wallets WHERE world_id=$1 AND agent_id=$2 AND chain_id=$3 AND status='active'`,
    [worldId, agentId, ARC_MAINNET_CHAIN_ID]);
    if (!result.rowCount) throw economyError('GENESIS_TOKEN_AGENT_WALLET_UNVERIFIED');
    const wallet = result.rows[0];
    if (requireSettlementAuthorization && !GENESIS_SETTLEMENT_WALLET_TYPES.has(wallet.accountType)) {
      throw economyError('GENESIS_TOKEN_WALLET_AUTHORIZATION_UNSUPPORTED', 409);
    }
    const owners = await client.query(`SELECT count(*)::int AS count FROM (
        SELECT address FROM arc_agent_wallets WHERE world_id=$1 AND chain_id=$2 AND status='active'
        UNION ALL
        SELECT address FROM arc_organization_wallets WHERE world_id=$1 AND chain_id=$2 AND status='active'
      ) active_wallets WHERE lower(address)=lower($3)`, [worldId, ARC_MAINNET_CHAIN_ID, wallet.address]);
    if (Number(owners.rows[0]?.count) !== 1) throw economyError('GENESIS_TOKEN_WALLET_OWNERSHIP_AMBIGUOUS');
    return wallet;
  }
  if (organizationId) {
    const result = await client.query(`SELECT address,account_type AS "accountType",NULL::uuid AS "agentId",
        organization_id AS "organizationId"
      FROM arc_organization_wallets WHERE world_id=$1 AND organization_id=$2 AND chain_id=$3 AND status='active'`,
    [worldId, organizationId, ARC_MAINNET_CHAIN_ID]);
    if (!result.rowCount) throw economyError('GENESIS_TOKEN_ORGANIZATION_WALLET_UNVERIFIED');
    const wallet = result.rows[0];
    if (requireSettlementAuthorization && !GENESIS_SETTLEMENT_WALLET_TYPES.has(wallet.accountType)) {
      throw economyError('GENESIS_TOKEN_WALLET_AUTHORIZATION_UNSUPPORTED', 409);
    }
    const owners = await client.query(`SELECT count(*)::int AS count FROM (
        SELECT address FROM arc_agent_wallets WHERE world_id=$1 AND chain_id=$2 AND status='active'
        UNION ALL
        SELECT address FROM arc_organization_wallets WHERE world_id=$1 AND chain_id=$2 AND status='active'
      ) active_wallets WHERE lower(address)=lower($3)`, [worldId, ARC_MAINNET_CHAIN_ID, wallet.address]);
    if (Number(owners.rows[0]?.count) !== 1) throw economyError('GENESIS_TOKEN_WALLET_OWNERSHIP_AMBIGUOUS');
    return wallet;
  }
  throw economyError('GENESIS_TOKEN_RECIPIENT_REQUIRED', 400);
}

export async function readActiveGenesisSettlementContract(client, { worldId, tokenId }) {
  const result = await client.query(`SELECT contract_address AS "contractAddress",
      runtime_code_hash AS "runtimeCodeHash",verified_block::text AS "verifiedBlock"
    FROM arc_genesis_token_settlement_contracts
    WHERE world_id=$1 AND token_id=$2 AND chain_id=$3 AND status='active'`,
  [worldId, tokenId, ARC_MAINNET_CHAIN_ID]);
  if (!result.rowCount) throw economyError('GENESIS_SETTLEMENT_CONTRACT_UNAVAILABLE', 503);
  return result.rows[0];
}

export async function readSpendableGenesisTokenBalance(client, { worldId, tokenId, agentId = null, organizationId = null,
  maximumAgeSeconds = 60 }) {
  const wallet = await verifiedWallet(client, { worldId, agentId, organizationId, requireSettlementAuthorization: true });
  const maxAge = Number.isFinite(Number(maximumAgeSeconds))
    ? Math.max(1, Math.trunc(Number(maximumAgeSeconds))) : 60;
  const snapshot = await client.query(`SELECT balance_raw::text AS "balanceRaw",block_number::text AS "blockNumber",
      observed_at AS "observedAt"
    FROM world_genesis_token_balance_snapshots
    WHERE world_id=$1 AND token_id=$2 AND wallet_address=$3 AND observed_at >= now()-($4::text||' seconds')::interval`,
  [worldId, tokenId, wallet.address, String(maxAge)]);
  if (!snapshot.rowCount) throw economyError('GENESIS_TOKEN_CHAIN_BALANCE_UNAVAILABLE', 503);
  const reserved = await client.query(`SELECT COALESCE(sum(amount_raw),0)::text AS "reservedRaw"
    FROM arc_genesis_token_settlement_outbox WHERE world_id=$1 AND token_id=$2 AND lower(from_address)=lower($3)
      AND status IN ('prepared','submitting','submission_unknown','submitted')`, [worldId, tokenId, wallet.address]);
  const balanceRaw = BigInt(snapshot.rows[0].balanceRaw);
  const reservedRaw = BigInt(reserved.rows[0].reservedRaw);
  return { walletAddress: wallet.address, balanceRaw: balanceRaw.toString(), reservedRaw: reservedRaw.toString(),
    spendableRaw: (balanceRaw > reservedRaw ? balanceRaw - reservedRaw : 0n).toString(),
    blockNumber: snapshot.rows[0].blockNumber, observedAt: snapshot.rows[0].observedAt };
}

export async function readActiveGenesisTokenAssets(client, { worldId, ownerAgentId }) {
  const result = await client.query(`SELECT token.id AS "tokenId",token.token_address AS "tokenAddress",
      token.name,token.symbol,token.decimals,snapshot.balance_raw::text AS "balanceRaw",
      snapshot.block_number::text AS "observedBlock",snapshot.observed_at AS "observedAt",
      COALESCE(reserved.amount_raw,0)::text AS "reservedRaw",wallet.account_type AS "walletAccountType"
    FROM world_genesis_currency_activations activation
    JOIN arc_agent_tokens token ON token.world_id=activation.world_id AND token.id=activation.token_id
    JOIN arc_agent_wallets wallet ON wallet.world_id=activation.world_id AND wallet.agent_id=$2
      AND wallet.chain_id=activation.chain_id AND wallet.status='active'
    LEFT JOIN world_genesis_token_balance_snapshots snapshot ON snapshot.world_id=activation.world_id
      AND snapshot.token_id=activation.token_id AND lower(snapshot.wallet_address)=lower(wallet.address)
      AND snapshot.observed_at >= now()-interval '60 seconds'
    LEFT JOIN LATERAL (SELECT sum(amount_raw) AS amount_raw FROM arc_genesis_token_settlement_outbox outbox
      WHERE outbox.world_id=activation.world_id AND outbox.token_id=activation.token_id
        AND lower(outbox.from_address)=lower(wallet.address)
        AND outbox.status IN ('prepared','submitting','submission_unknown','submitted')) reserved ON true
    WHERE activation.world_id=$1`, [worldId, ownerAgentId]);
  return result.rows.map((asset) => ({ ...asset,
    available: Boolean(asset.observedAt),
    authorizationSupported: GENESIS_SETTLEMENT_WALLET_TYPES.has(asset.walletAccountType),
    spendableRaw: asset.balanceRaw === null || !GENESIS_SETTLEMENT_WALLET_TYPES.has(asset.walletAccountType) ? null
      : (BigInt(asset.balanceRaw) > BigInt(asset.reservedRaw)
        ? (BigInt(asset.balanceRaw) - BigInt(asset.reservedRaw)).toString() : '0') }));
}

export async function readGenesisTokenWalletSnapshots(client, { worldId, maximumAgeSeconds = 60 }) {
  const activation = await readGenesisCurrencyActivation(client, worldId);
  if (!activation) return null;
  const maxAge = Number.isFinite(Number(maximumAgeSeconds))
    ? Math.max(1, Math.trunc(Number(maximumAgeSeconds))) : 60;
  const result = await client.query(`SELECT wallet.owner_type AS "ownerType",wallet.owner_id AS "ownerId",
      wallet.address AS "walletAddress",wallet.account_type AS "walletAccountType",
      snapshot.balance_raw::text AS "balanceRaw",
      snapshot.block_number::text AS "observedBlock",snapshot.observed_at AS "observedAt",
      COALESCE(reserved.amount_raw,0)::text AS "reservedRaw"
    FROM (
      SELECT 'agent'::text AS owner_type,agent_id AS owner_id,address,account_type,world_id,chain_id,status
      FROM arc_agent_wallets
      UNION ALL
      SELECT 'organization'::text AS owner_type,organization_id AS owner_id,address,account_type,world_id,chain_id,status
      FROM arc_organization_wallets
    ) wallet
    LEFT JOIN world_genesis_token_balance_snapshots snapshot ON snapshot.world_id=wallet.world_id
      AND snapshot.token_id=$2 AND lower(snapshot.wallet_address)=lower(wallet.address)
      AND snapshot.observed_at >= now()-($3::text||' seconds')::interval
    LEFT JOIN LATERAL (SELECT sum(amount_raw) AS amount_raw FROM arc_genesis_token_settlement_outbox outbox
      WHERE outbox.world_id=wallet.world_id AND outbox.token_id=$2
        AND lower(outbox.from_address)=lower(wallet.address)
        AND outbox.status IN ('prepared','submitting','submission_unknown','submitted')) reserved ON true
    WHERE wallet.world_id=$1 AND wallet.chain_id=$4 AND wallet.status='active'
    ORDER BY wallet.owner_type,wallet.owner_id`,
  [worldId, activation.tokenId, String(maxAge), ARC_MAINNET_CHAIN_ID]);
  const wallets = result.rows.map((wallet) => {
    const balance = wallet.balanceRaw === null ? null : BigInt(wallet.balanceRaw);
    const reserved = BigInt(wallet.reservedRaw || '0');
    return { ownerType: wallet.ownerType, ownerId: wallet.ownerId, walletAddress: wallet.walletAddress,
      balanceRaw: balance?.toString() || null, reservedRaw: reserved.toString(),
      authorizationSupported: GENESIS_SETTLEMENT_WALLET_TYPES.has(wallet.walletAccountType),
      spendableRaw: balance === null || !GENESIS_SETTLEMENT_WALLET_TYPES.has(wallet.walletAccountType) ? null
        : (balance > reserved ? balance - reserved : 0n).toString(),
      observedBlock: wallet.observedBlock, observedAt: wallet.observedAt,
      balanceSource: wallet.observedAt ? 'arc_chain_snapshot' : 'unavailable' };
  });
  return { currency: { tokenId: activation.tokenId, tokenAddress: activation.tokenAddress,
      name: activation.name, symbol: activation.symbol, decimals: Number(activation.decimals),
      chainId: Number(activation.chainId), authority: 'arc_chain' }, wallets };
}

export async function readActiveGenesisTokenAsset(client, { worldId, ownerAgentId }) {
  return (await readActiveGenesisTokenAssets(client, { worldId, ownerAgentId }))[0] || null;
}

export async function createArcGenesisTokenSettlementIntent(client, { worldId, tokenId, fromAgentId,
  toAgentId = null, toOrganizationId = null, amountRaw, actionId, actionFamily, reason,
  worldMinute, metadata = {} }) {
  const activation = await readGenesisCurrencyActivation(client, worldId, { forUpdate: true });
  if (!activation) throw economyError('GENESIS_CURRENCY_NOT_ACTIVE');
  if (activation.tokenId !== tokenId) throw economyError('GENESIS_TOKEN_ID_MISMATCH');
  if (toAgentId && toAgentId === fromAgentId) throw economyError('GENESIS_TOKEN_SELF_SETTLEMENT_FORBIDDEN', 400);
  if (Boolean(toAgentId) === Boolean(toOrganizationId)) throw economyError('GENESIS_TOKEN_RECIPIENT_INVALID', 400);
  let raw;
  try { raw = BigInt(amountRaw); } catch { throw economyError('GENESIS_TOKEN_AMOUNT_INVALID', 400); }
  if (raw <= 0n || raw > (1n << 128n) - 1n) throw economyError('GENESIS_TOKEN_AMOUNT_OUT_OF_RANGE', 400);
  if (typeof actionId !== 'string' || actionId.length < 8 || actionId.length > 180
      || typeof actionFamily !== 'string' || actionFamily.trim().length < 1 || actionFamily.length > 96
      || typeof reason !== 'string' || reason.trim().length < 3) throw economyError('GENESIS_TOKEN_SETTLEMENT_INVALID', 400);
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)
      || Buffer.byteLength(JSON.stringify(metadata), 'utf8') > 8_000) throw economyError('GENESIS_SETTLEMENT_METADATA_INVALID', 400);
  const reasonHash = keccak256(toUtf8Bytes(reason.trim())).toLowerCase();
  const payer = await verifiedWallet(client, { worldId, agentId: fromAgentId, requireSettlementAuthorization: true });
  const payee = await verifiedWallet(client, { worldId, agentId: toAgentId, organizationId: toOrganizationId });
  if (payer.address.toLowerCase() === payee.address.toLowerCase()) throw economyError('GENESIS_TOKEN_SELF_SETTLEMENT_FORBIDDEN', 400);
  const contract = await readActiveGenesisSettlementContract(client, { worldId, tokenId });
  if (!Number.isSafeInteger(Number(worldMinute)) || Number(worldMinute) < 1) {
    throw economyError('GENESIS_SETTLEMENT_WORLD_MINUTE_INVALID', 400);
  }
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
    [`genesis-settlement:${worldId}:${tokenId}:${payer.address.toLowerCase()}`]);
  const prior = await client.query(`SELECT * FROM arc_genesis_token_settlement_outbox
    WHERE world_id=$1 AND world_action_id=$2`, [worldId, actionId]);
  if (prior.rowCount) {
    const row = prior.rows[0];
    if (row.token_id !== tokenId || row.from_agent_id !== fromAgentId || row.to_agent_id !== toAgentId
        || row.to_organization_id !== toOrganizationId || row.amount_raw !== raw.toString()
        || row.from_address?.toLowerCase() !== payer.address.toLowerCase()
        || row.to_address?.toLowerCase() !== payee.address.toLowerCase()
        || row.action_family !== actionFamily.trim() || row.reason_hash !== reasonHash) {
      throw economyError('GENESIS_SETTLEMENT_ACTION_ID_CONFLICT');
    }
    return { settlement: row, created: false };
  }
  const spendable = await readSpendableGenesisTokenBalance(client, { worldId, tokenId, agentId: fromAgentId });
  if (BigInt(spendable.spendableRaw) < raw) throw economyError('GENESIS_TOKEN_INSUFFICIENT_CHAIN_BALANCE');
  const inserted = await client.query(`INSERT INTO arc_genesis_token_settlement_outbox(world_id,world_action_id,token_id,
      chain_id,settlement_contract,from_agent_id,to_agent_id,to_organization_id,from_address,to_address,amount_raw,
      action_family,reason_hash,submission_start_block,created_world_minute,metadata)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb)
    ON CONFLICT(world_id,world_action_id) DO NOTHING RETURNING *`, [worldId, actionId, tokenId, ARC_MAINNET_CHAIN_ID,
    contract.contractAddress, fromAgentId, toAgentId, toOrganizationId, payer.address, payee.address, raw.toString(),
    actionFamily.trim(), reasonHash, (BigInt(spendable.blockNumber) + 1n).toString(),
    Math.trunc(Number(worldMinute)), JSON.stringify({
      ...metadata, authorization: 'payer_wallet_transaction', ownershipAuthority: 'arc_chain_confirmation',
      payerWalletAccountType: payer.accountType,
      settlementContractCodeHash: contract.runtimeCodeHash, settlementContractVerifiedBlock: contract.verifiedBlock,
      balanceObservationBlock: spendable.blockNumber, balanceObservationAt: new Date(spendable.observedAt).toISOString()
    })]);
  if (inserted.rowCount) return { settlement: inserted.rows[0], created: true };
  const existing = await client.query(`SELECT * FROM arc_genesis_token_settlement_outbox
    WHERE world_id=$1 AND world_action_id=$2`, [worldId, actionId]);
  const row = existing.rows[0];
  if (!row || row.token_id !== tokenId || row.from_agent_id !== fromAgentId || row.to_agent_id !== toAgentId
      || row.to_organization_id !== toOrganizationId || row.amount_raw !== raw.toString()
      || row.action_family !== actionFamily.trim() || row.reason_hash !== reasonHash) throw economyError('GENESIS_SETTLEMENT_ACTION_ID_CONFLICT');
  return { settlement: row, created: false };
}

export async function upsertGenesisTokenBalanceObservation(client, { worldId, tokenId,
  walletAddress, agentId = null, organizationId = null, balanceRaw, blockNumber, observedAt = new Date() }) {
  const balance = BigInt(balanceRaw);
  const block = BigInt(blockNumber);
  if (balance < 0n || block < 0n || !/^0x[0-9a-fA-F]{40}$/.test(walletAddress)) {
    throw economyError('GENESIS_TOKEN_BALANCE_OBSERVATION_INVALID', 400);
  }
  await client.query(`INSERT INTO world_genesis_token_balance_snapshots(world_id,token_id,chain_id,wallet_address,
      agent_id,organization_id,balance_raw,block_number,observed_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
    ON CONFLICT(world_id,token_id,wallet_address) DO UPDATE SET
      agent_id=EXCLUDED.agent_id,organization_id=EXCLUDED.organization_id,balance_raw=EXCLUDED.balance_raw,
      block_number=EXCLUDED.block_number,observed_at=EXCLUDED.observed_at
    WHERE world_genesis_token_balance_snapshots.block_number <= EXCLUDED.block_number`,
  [worldId, tokenId, ARC_MAINNET_CHAIN_ID, walletAddress, agentId, organizationId, balance.toString(), block.toString(), observedAt]);
}

export function genesisSettlementActionHash(worldId, worldActionId) {
  return id(`${worldId}:${worldActionId}`).toLowerCase();
}

export function genesisSettlementActionFamilyHash(actionFamily) {
  return id(String(actionFamily)).toLowerCase();
}

export function genesisSettlementReasonHash(reason) {
  return keccak256(toUtf8Bytes(String(reason).trim())).toLowerCase();
}

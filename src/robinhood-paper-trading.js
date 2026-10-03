import { formatUnits, parsePositiveUnits } from './crypto-market.js';
import { formatRawTokenAmount, getCurrentCurveQuote, nativeRawToUsdc, quotePonsV2Buy, quotePonsV2Sell, tokenValueUsdcScaled, usdcToNativeRaw } from './robinhood-market.js';

export const ROBINHOOD_PAPER_FEE_BPS = 10;
const ADDRESS_RE = /^0x[0-9a-f]{40}$/i;

function positiveInteger(value) {
  const raw = String(value ?? '').trim();
  if (!/^[1-9]\d{0,77}$/.test(raw)) throw new Error('TOKEN_AMOUNT_INVALID');
  return BigInt(raw);
}

function tradeNotional(nativeRaw, nativeUsdPrice) {
  return nativeRawToUsdc(nativeRaw, nativeUsdPrice);
}

async function navSnapshot(client, worldId, agentId) {
  const result = await client.query(`SELECT round(
      COALESCE(sum(b.balance * q.price_usd),0) +
      COALESCE((SELECT sum(p.quantity_raw * mq.price_usd / power(10::numeric,t.decimals))
        FROM robinhood_paper_positions p
        JOIN robinhood_tokens t ON t.token_address=p.token_address
        JOIN robinhood_market_quotes mq ON mq.token_address=t.token_address
        WHERE p.world_id=$1 AND p.agent_id=$2 AND mq.price_usd IS NOT NULL),0),8
    )::text AS nav_usd
    FROM crypto_balances b JOIN crypto_market_quotes q ON q.symbol=b.asset_symbol
    WHERE b.world_id=$1 AND b.agent_id=$2`, [worldId, agentId]);
  return parsePositiveUnits(result.rows[0]?.nav_usd || '0', { allowZero: true });
}

export async function readRobinhoodPaperAccount(client, worldId, agentId) {
  const [positions, orders] = await Promise.all([
    client.query(`SELECT p.token_address AS "tokenAddress",t.symbol,t.name,t.decimals,
        p.quantity_raw AS "quantityRaw",format('%s',p.quantity_raw) AS "rawAmount",
        to_char(p.quantity_raw / power(10::numeric,t.decimals),'FM999999999999999999999999999999990.000000000000000000') AS quantity,
        q.price_usd::text AS "priceUsd",round(p.quantity_raw * q.price_usd / power(10::numeric,t.decimals),8)::text AS "valueUsd",
        q.quote_version AS "quoteVersion",q.as_of AS "asOf",q.graduated,q.trade_supported AS "tradeSupported"
      FROM robinhood_paper_positions p JOIN robinhood_tokens t USING(token_address)
      LEFT JOIN robinhood_market_quotes q USING(token_address)
      WHERE p.world_id=$1 AND p.agent_id=$2 AND p.quantity_raw>0 ORDER BY p.updated_at DESC LIMIT 50`, [worldId, agentId]),
    client.query(`SELECT id,side,token_address AS "tokenAddress",token_amount_raw AS "tokenAmountRaw",
        notional_usd::text AS "notionalUsd",fee_usdc::text AS "feeUsdc",quote_version AS "quoteVersion",
        status,created_at AS "createdAt"
      FROM robinhood_paper_orders WHERE world_id=$1 AND agent_id=$2 ORDER BY created_at DESC LIMIT 20`, [worldId, agentId])
  ]);
  return { positions: positions.rows.map((row) => ({ ...row, quantityRaw: String(row.quantityRaw),
    tokenAmountRaw: String(row.rawAmount) })), recentOrders: orders.rows,
    netAssetValueUsd: formatUnits(await navSnapshot(client, worldId, agentId)) };
}

export async function executeRobinhoodPaperTrade(client, {
  worldId, agentId, actionId, side, tokenAddress, quoteVersion, quoteUnits, tokenAmountRaw,
  maxOrderNavBps = 1000, maxAssetNavBps = 5000, platformFeeBps = ROBINHOOD_PAPER_FEE_BPS
}) {
  if (!['buy', 'sell'].includes(side) || !ADDRESS_RE.test(String(tokenAddress)) ||
      !Number.isSafeInteger(quoteVersion) || quoteVersion < 0) throw Object.assign(new Error('ROBINHOOD_ORDER_INVALID'), { statusCode: 400 });
  const token = String(tokenAddress).toLowerCase();
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`robinhood:${worldId}:${agentId}:${actionId}`]);
  const prior = await client.query(`SELECT data FROM robinhood_paper_orders WHERE world_id=$1 AND agent_id=$2 AND action_id=$3`,
    [worldId, agentId, actionId]);
  if (prior.rowCount) return prior.rows[0].data;

  await client.query('SELECT world_id FROM world_members WHERE world_id=$1 AND agent_id=$2 FOR UPDATE', [worldId, agentId]);
  const tracked = await client.query(`SELECT t.token_address,t.curve_address,t.decimals,t.graduated,
      q.quote_version,q.as_of,q.trade_supported
    FROM robinhood_tokens t JOIN robinhood_market_quotes q USING(token_address)
    WHERE t.token_address=$1 FOR UPDATE OF t,q`, [token]);
  if (!tracked.rowCount) throw Object.assign(new Error('ROBINHOOD_TOKEN_NOT_TRACKED'), { statusCode: 404 });
  const tokenMeta = tracked.rows[0];
  if (BigInt(tokenMeta.quote_version) !== BigInt(quoteVersion) || !tokenMeta.trade_supported || tokenMeta.graduated ||
      Date.now() - new Date(tokenMeta.as_of).getTime() > 120_000) {
    throw Object.assign(new Error('ROBINHOOD_QUOTE_STALE_OR_UNTRADEABLE'), { statusCode: 409 });
  }

  const curveQuote = await getCurrentCurveQuote(tokenMeta.curve_address, { expectedQuoteVersion: quoteVersion });
  if (!curveQuote.tradeSupported || curveQuote.graduated || curveQuote.tokenAddress.toLowerCase() !== token) {
    throw Object.assign(new Error('ROBINHOOD_CURVE_UNTRADEABLE'), { statusCode: 409 });
  }
  const nav = await navSnapshot(client, worldId, agentId);
  if (nav <= 0n) throw Object.assign(new Error('ACCOUNT_VALUE_ZERO'), { statusCode: 409 });
  const limits = await client.query('SELECT max_order_nav_bps,max_asset_nav_bps FROM crypto_risk_limits WHERE world_id=$1', [worldId]);
  const maxNotional = nav * BigInt(limits.rows[0]?.max_order_nav_bps ?? maxOrderNavBps) / 10_000n;
  const maxAssetValue = nav * BigInt(limits.rows[0]?.max_asset_nav_bps ?? maxAssetNavBps) / 10_000n;
  const balances = await client.query(`SELECT balance::text AS balance FROM crypto_balances
    WHERE world_id=$1 AND agent_id=$2 AND asset_symbol='USDC' FOR UPDATE`, [worldId, agentId]);
  const usdcBefore = parsePositiveUnits(balances.rows[0]?.balance || '0', { allowZero: true });
  const position = await client.query(`SELECT quantity_raw FROM robinhood_paper_positions
    WHERE world_id=$1 AND agent_id=$2 AND token_address=$3 FOR UPDATE`, [worldId, agentId, token]);
  const positionBefore = BigInt(position.rows[0]?.quantity_raw || 0);
  const positionValue = tokenValueUsdcScaled(positionBefore, curveQuote.decimals, curveQuote.priceUsd);
  let details;
  let amountDelta;
  let usdNotional;
  let usdcAfter;
  let tokenAmountRawFilled;

  if (side === 'buy') {
    const requested = parsePositiveUnits(quoteUnits);
    const maxOrder = maxNotional;
    if (requested > maxOrder) throw Object.assign(new Error('ORDER_EXCEEDS_RISK_LIMIT'), { statusCode: 409 });
    const inputNative = usdcToNativeRaw(formatUnits(requested), curveQuote.nativeUsdPrice);
    const fill = quotePonsV2Buy({ quoteInputRaw: inputNative, quoteReserveRaw: curveQuote.quoteReserveRaw,
      tokenReserveRaw: curveQuote.tokenReserveRaw, sellableTokensRaw: curveQuote.sellableTokensRaw,
      feeBps: curveQuote.feeBps, taxBps: curveQuote.taxBps });
    const actualNotional = tradeNotional(fill.quoteSpentRaw, curveQuote.nativeUsdPrice);
    const platformFee = actualNotional * BigInt(platformFeeBps) / 10_000n;
    const debit = actualNotional + platformFee;
    if (debit > maxOrder || debit > usdcBefore) throw Object.assign(new Error('INSUFFICIENT_OR_OVER_LIMIT_USDC'), { statusCode: 409 });
    tokenAmountRawFilled = BigInt(fill.tokenAmountRaw);
    const nextPositionValue = positionValue + tokenValueUsdcScaled(tokenAmountRawFilled, curveQuote.decimals, curveQuote.priceUsd);
    if (nextPositionValue > maxAssetValue) throw Object.assign(new Error('ASSET_EXPOSURE_LIMIT'), { statusCode: 409 });
    usdcAfter = usdcBefore - debit;
    amountDelta = tokenAmountRawFilled;
    usdNotional = actualNotional;
    details = { ...fill, requestedUsdc: formatUnits(requested), notionalUsd: formatUnits(actualNotional),
      feeUsdc: formatUnits(platformFee), tokenAmount: formatRawTokenAmount(tokenAmountRawFilled, curveQuote.decimals),
      nativeUsdPrice: curveQuote.nativeUsdPrice };
  } else {
    tokenAmountRawFilled = positiveInteger(tokenAmountRaw);
    if (tokenAmountRawFilled > positionBefore) throw Object.assign(new Error('INSUFFICIENT_MEME_POSITION'), { statusCode: 409 });
    if (curveQuote.readyToGraduate) throw Object.assign(new Error('PONS_V2_CURVE_READY_TO_GRADUATE'), { statusCode: 409 });
    const fill = quotePonsV2Sell({ tokenInputRaw: tokenAmountRawFilled, quoteReserveRaw: curveQuote.quoteReserveRaw,
      tokenReserveRaw: curveQuote.tokenReserveRaw, feeBps: curveQuote.feeBps, taxBps: curveQuote.taxBps });
    const actualNotional = tradeNotional(fill.quoteReceivedRaw, curveQuote.nativeUsdPrice);
    const platformFee = actualNotional * BigInt(platformFeeBps) / 10_000n;
    const credit = actualNotional - platformFee;
    if (credit <= 0n) throw Object.assign(new Error('ROBINHOOD_SELL_TOO_SMALL'), { statusCode: 409 });
    usdcAfter = usdcBefore + credit;
    amountDelta = -tokenAmountRawFilled;
    usdNotional = actualNotional;
    details = { ...fill, notionalUsd: formatUnits(actualNotional), feeUsdc: formatUnits(platformFee),
      tokenAmount: formatRawTokenAmount(tokenAmountRawFilled, curveQuote.decimals), nativeUsdPrice: curveQuote.nativeUsdPrice };
  }

  const order = (await client.query(`INSERT INTO robinhood_paper_orders(world_id,agent_id,action_id,side,token_address,
      quote_version,token_amount_raw,native_quote_raw,notional_usd,fee_usdc,status,data)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'filled',$11) RETURNING id`,
  [worldId, agentId, actionId, side, token, curveQuote.quoteVersion, String(tokenAmountRawFilled),
    side === 'buy' ? details.quoteSpentRaw : details.quoteReceivedRaw, formatUnits(usdNotional), details.feeUsdc,
    { action: 'trade_meme', simulated: true, chainId: 4663, tokenAddress: token, curveAddress: curveQuote.curveAddress,
      symbol: tokenMeta.symbol, side, quoteVersion: curveQuote.quoteVersion, blockNumber: curveQuote.blockNumber,
      priceUsd: curveQuote.priceUsd, source: curveQuote.source, ...details }])).rows[0];
  await client.query(`INSERT INTO crypto_balances(world_id,agent_id,asset_symbol,balance)
    VALUES($1,$2,'USDC',$3) ON CONFLICT(world_id,agent_id,asset_symbol) DO UPDATE SET balance=EXCLUDED.balance`,
  [worldId, agentId, formatUnits(usdcAfter)]);
  const nextPosition = positionBefore + amountDelta;
  if (nextPosition < 0n) throw Object.assign(new Error('MEME_POSITION_NEGATIVE'), { statusCode: 409 });
  await client.query(`INSERT INTO robinhood_paper_positions(world_id,agent_id,token_address,quantity_raw)
    VALUES($1,$2,$3,$4) ON CONFLICT(world_id,agent_id,token_address) DO UPDATE
      SET quantity_raw=EXCLUDED.quantity_raw,updated_at=now()`,
  [worldId, agentId, token, String(nextPosition)]);
  await client.query(`INSERT INTO robinhood_paper_ledger(world_id,agent_id,token_address,order_id,side,quantity_delta_raw)
    VALUES($1,$2,$3,$4,$5,$6)`, [worldId, agentId, token, order.id, side, String(amountDelta)]);
  const response = { action: 'trade_meme', orderId: order.id, status: 'filled', simulated: true, chainId: 4663,
    tokenAddress: token, curveAddress: curveQuote.curveAddress, symbol: tokenMeta.symbol, side,
    tokenAmountRaw: String(tokenAmountRawFilled), tokenAmount: formatRawTokenAmount(tokenAmountRawFilled, curveQuote.decimals),
    priceUsd: curveQuote.priceUsd, notionalUsd: formatUnits(usdNotional), feeUsdc: details.feeUsdc,
    balanceUsdc: formatUnits(usdcAfter), quoteVersion: curveQuote.quoteVersion, blockNumber: curveQuote.blockNumber,
    source: curveQuote.source, ...details };
  await client.query('UPDATE robinhood_paper_orders SET data=$2 WHERE id=$1', [order.id, response]);
  return response;
}

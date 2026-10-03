import { addUnits, applyBasisPoints, divideUnits, formatUnits, isMarketAsset, multiplyUnits, parsePositiveUnits, parseSignedUnits } from './crypto-market.js';

export const STARTING_USDC = '10000.00000000';
export const TRADE_FEE_BPS = 10;
export const SPREAD_BPS = 5;
export const MAX_ORDER_NAV_BPS = 1000;
export const MAX_ASSET_NAV_BPS = 5000;
export const BUY_TIERS_USDC = Object.freeze(['50.00000000', '100.00000000', '250.00000000']);

export function calculateTrade({ side, asset, quoteUnits, priceUsd, balances, feeBps = TRADE_FEE_BPS,
  spreadBps = SPREAD_BPS, maxOrderNavBps = MAX_ORDER_NAV_BPS, maxAssetNavBps = MAX_ASSET_NAV_BPS }) {
  if (!['buy', 'sell'].includes(side) || !['BTC', 'ETH'].includes(asset) || !isMarketAsset(asset)) throw new Error('TRADE_FIELDS_INVALID');
  const requestedNotional = parsePositiveUnits(quoteUnits);
  const mid = parsePositiveUnits(priceUsd);
  if (mid <= 0n || !Number.isInteger(feeBps) || feeBps < 0 || feeBps > 1000 ||
      !Number.isInteger(spreadBps) || spreadBps < 0 || spreadBps > 1000) throw new Error('TRADE_MARKET_INVALID');

  const usdc = parsePositiveUnits(balances.USDC || '0', { allowZero: true });
  const assetBalance = parsePositiveUnits(balances[asset] || '0', { allowZero: true });
  const btcValue = multiplyUnits(balances.BTC || '0', balances.BTCPriceUsd || '0');
  const ethValue = multiplyUnits(balances.ETH || '0', balances.ETHPriceUsd || '0');
  const nav = usdc + btcValue + ethValue;
  if (nav <= 0n) throw Object.assign(new Error('ACCOUNT_VALUE_ZERO'), { statusCode: 409 });
  const maxNotional = nav * BigInt(maxOrderNavBps) / 10_000n;
  if (requestedNotional > maxNotional) throw Object.assign(new Error('ORDER_EXCEEDS_RISK_LIMIT'), { statusCode: 409 });

  const executionPrice = side === 'buy'
    ? addUnits(formatUnits(mid), applyBasisPoints(formatUnits(mid), spreadBps))
    : mid - parsePositiveUnits(applyBasisPoints(formatUnits(mid), spreadBps));
  if (executionPrice <= 0n) throw new Error('TRADE_MARKET_INVALID');

  const quantity = divideUnits(formatUnits(requestedNotional), formatUnits(executionPrice));
  const notional = multiplyUnits(formatUnits(quantity), formatUnits(executionPrice));
  const fee = parsePositiveUnits(applyBasisPoints(formatUnits(notional), feeBps), { allowZero: true });
  if (quantity <= 0n || notional <= 0n) throw new Error('TRADE_SIZE_TOO_SMALL');

  if (side === 'buy') {
    const totalCost = notional + fee;
    if (totalCost > maxNotional) throw Object.assign(new Error('ORDER_EXCEEDS_RISK_LIMIT'), { statusCode: 409 });
    if (totalCost > usdc) throw Object.assign(new Error('INSUFFICIENT_USDC'), { statusCode: 409 });
    const currentAssetValue = asset === 'BTC' ? btcValue : ethValue;
    const nextAssetValue = currentAssetValue + multiplyUnits(formatUnits(quantity), formatUnits(mid));
    if (nextAssetValue * 10_000n > nav * BigInt(maxAssetNavBps)) {
      throw Object.assign(new Error('ASSET_EXPOSURE_LIMIT'), { statusCode: 409 });
    }
    return {
      side, asset, quoteUnits: formatUnits(requestedNotional), quantity: formatUnits(quantity),
      midPriceUsd: formatUnits(mid), executionPriceUsd: formatUnits(executionPrice), notionalUsd: formatUnits(notional),
      feeUsdc: formatUnits(fee), usdcDelta: formatUnits(-totalCost), assetDelta: formatUnits(quantity), navUsd: formatUnits(nav)
    };
  }

  if (quantity > assetBalance) throw Object.assign(new Error('INSUFFICIENT_ASSET'), { statusCode: 409 });
  const proceeds = notional - fee;
  return {
    side, asset, quoteUnits: formatUnits(requestedNotional), quantity: formatUnits(quantity),
    midPriceUsd: formatUnits(mid), executionPriceUsd: formatUnits(executionPrice), notionalUsd: formatUnits(notional),
    feeUsdc: formatUnits(fee), usdcDelta: formatUnits(proceeds), assetDelta: formatUnits(-quantity), navUsd: formatUnits(nav)
  };
}

export async function ensureCryptoAccount(client, { worldId, agentId }) {
  const risk = await client.query('SELECT starting_usdc::text AS amount FROM crypto_risk_limits WHERE world_id=$1', [worldId]);
  const startingUsdc = risk.rows[0]?.amount || STARTING_USDC;
  const inserted = await client.query(`INSERT INTO crypto_balances(world_id,agent_id,asset_symbol,balance)
    VALUES($1,$2,'USDC',$3) ON CONFLICT(world_id,agent_id,asset_symbol) DO NOTHING RETURNING balance`,
  [worldId, agentId, startingUsdc]);
  if (inserted.rowCount) {
    await client.query(`INSERT INTO crypto_ledger(world_id,agent_id,asset_symbol,amount,entry_type,reference_id,reason)
      VALUES($1,$2,'USDC',$3,'seed','seed:v1','initial simulated trading balance')
      ON CONFLICT(world_id,agent_id,asset_symbol,reference_id) DO NOTHING`,
    [worldId, agentId, startingUsdc]);
  }
}

export async function accountSnapshot(client, worldId, agentId, quotes) {
  const result = await client.query(`SELECT asset_symbol AS asset,balance::text AS balance
    FROM crypto_balances WHERE world_id=$1 AND agent_id=$2 ORDER BY asset_symbol`, [worldId, agentId]);
  const balances = Object.fromEntries(result.rows.map((row) => [row.asset, row.balance]));
  for (const symbol of ['USDC', 'BTC', 'ETH']) balances[symbol] ||= '0.00000000';
  const prices = Object.fromEntries(quotes.map((quote) => [quote.symbol, quote.priceUsd]));
  const nav = parsePositiveUnits(balances.USDC, { allowZero: true })
    + multiplyUnits(balances.BTC, prices.BTC || '0')
    + multiplyUnits(balances.ETH, prices.ETH || '0');
  return {
    balances,
    netAssetValueUsd: formatUnits(nav),
    positions: ['BTC', 'ETH'].map((asset) => ({
      asset,
      quantity: balances[asset],
      priceUsd: prices[asset] || '0.00000000',
      valueUsd: formatUnits(multiplyUnits(balances[asset], prices[asset] || '0'))
    }))
  };
}

export async function executeCryptoTrade(client, { worldId, agentId, actionId, side, asset, quoteUnits, quote,
  feeBps = TRADE_FEE_BPS, spreadBps = SPREAD_BPS, maxOrderNavBps = MAX_ORDER_NAV_BPS,
  maxAssetNavBps = MAX_ASSET_NAV_BPS }) {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`crypto:${worldId}:${agentId}:${actionId}`]);
  const prior = await client.query(`SELECT data FROM crypto_orders WHERE world_id=$1 AND agent_id=$2 AND action_id=$3`,
    [worldId, agentId, actionId]);
  if (prior.rowCount) return prior.rows[0].data;

  await client.query('SELECT world_id FROM world_members WHERE world_id=$1 AND agent_id=$2 FOR UPDATE', [worldId, agentId]);
  const balancesResult = await client.query(`SELECT asset_symbol AS asset,balance::text AS balance
    FROM crypto_balances WHERE world_id=$1 AND agent_id=$2 FOR UPDATE`, [worldId, agentId]);
  const balances = Object.fromEntries(balancesResult.rows.map((row) => [row.asset, row.balance]));
  for (const symbol of ['USDC', 'BTC', 'ETH']) balances[symbol] ||= '0.00000000';
  const prices = Object.fromEntries(quote.all.map((item) => [item.symbol, item.priceUsd]));
  balances.BTCPriceUsd = prices.BTC;
  balances.ETHPriceUsd = prices.ETH;
  const calculated = calculateTrade({ side, asset, quoteUnits, priceUsd: quote.priceUsd, balances,
    feeBps, spreadBps, maxOrderNavBps, maxAssetNavBps });
  const order = (await client.query(`INSERT INTO crypto_orders(world_id,agent_id,action_id,side,asset_symbol,quote_version,
      quantity,price_usd,notional_usd,fee_usdc,status,data)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'filled',$11)
    RETURNING id`, [worldId, agentId, actionId, side, asset, quote.quoteVersion, calculated.quantity,
    calculated.executionPriceUsd, calculated.notionalUsd, calculated.feeUsdc, calculated])).rows[0];
  const usdcBefore = parsePositiveUnits(balances.USDC, { allowZero: true });
  const assetBefore = parsePositiveUnits(balances[asset], { allowZero: true });
  const usdcAfter = usdcBefore + parseSignedUnits(calculated.usdcDelta);
  const assetAfter = assetBefore + parseSignedUnits(calculated.assetDelta);
  if (usdcAfter < 0n || assetAfter < 0n) throw Object.assign(new Error('BALANCE_NEGATIVE'), { statusCode: 409 });
  await client.query(`INSERT INTO crypto_balances(world_id,agent_id,asset_symbol,balance)
    VALUES($1,$2,'USDC',$3) ON CONFLICT(world_id,agent_id,asset_symbol) DO UPDATE SET balance=EXCLUDED.balance`,
  [worldId, agentId, formatUnits(usdcAfter)]);
  await client.query(`INSERT INTO crypto_balances(world_id,agent_id,asset_symbol,balance)
    VALUES($1,$2,$3,$4) ON CONFLICT(world_id,agent_id,asset_symbol) DO UPDATE SET balance=EXCLUDED.balance`,
  [worldId, agentId, asset, formatUnits(assetAfter)]);
  for (const [symbol, delta, kind] of [
    ['USDC', calculated.usdcDelta, side], [asset, calculated.assetDelta, side]
  ]) {
    await client.query(`INSERT INTO crypto_ledger(world_id,agent_id,asset_symbol,amount,entry_type,reference_id,reason)
      VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(world_id,agent_id,asset_symbol,reference_id) DO NOTHING`,
    [worldId, agentId, symbol, delta, kind, `${order.id}:${symbol}`, `${side} ${asset} simulated spot trade`]);
  }
  await client.query(`INSERT INTO crypto_trades(order_id,world_id,agent_id,side,asset_symbol,quantity,price_usd,notional_usd,fee_usdc)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [order.id, worldId, agentId, side, asset, calculated.quantity,
    calculated.executionPriceUsd, calculated.notionalUsd, calculated.feeUsdc]);
  const response = { action: 'trade_crypto', orderId: order.id, status: 'filled', ...calculated,
    balanceUsdc: formatUnits(usdcAfter), balanceAsset: formatUnits(assetAfter), marketSource: quote.source };
  await client.query('UPDATE crypto_orders SET data=$2 WHERE id=$1', [order.id, response]);
  return response;
}

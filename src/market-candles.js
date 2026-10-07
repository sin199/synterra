// Read-only market history for the 3D plaza's K-line screens (/local/map-data -> world.market).
//
// The simulated BTC/ETH feed is deterministic per minute: crypto_market_quotes only ever holds the
// latest row, written from simulatedQuotes(). The price history of that table is therefore exactly
// simulatedQuotes() evaluated at each past minute, so the candles are rebuilt from that function
// (no extra table, no writes) and enriched with per-bucket volume read from crypto_trades.
// Nothing here touches trading logic, balances, the ledger, Arc or Fruitfly.
import { simulatedQuotes } from './crypto-market.js';

export const MARKET_SYMBOLS = Object.freeze(['BTC', 'ETH']);
export const CANDLE_BUCKET_MINUTES = 15;
export const CANDLE_COUNT = 48; // 12 hours of 15-minute candles
export const MARKET_RECENT_TRADES = 20;
const MINUTE = 60_000;

const round = (value, digits = 8) => {
  const scale = 10 ** digits;
  return Math.round(Number(value) * scale) / scale;
};

let memo = { key: '', value: null };

// Pure: OHLC candles from a per-minute quote function, plus optional trade buckets
// ({ asset, bucket (bucket index = floor(epochMinutes / bucketMinutes)), trades, volume, notionalUsd,
//   buyNotionalUsd, sellNotionalUsd, minPriceUsd, maxPriceUsd }).
export function buildMarketCandles({ now = Date.now(), bucketMinutes = CANDLE_BUCKET_MINUTES, count = CANDLE_COUNT,
  symbols = MARKET_SYMBOLS, quoteAt = simulatedQuotes, tradeBuckets = [] } = {}) {
  const size = Math.max(1, Math.min(240, Math.floor(bucketMinutes)));
  const total = Math.max(1, Math.min(200, Math.floor(count)));
  const nowMinute = Math.floor(now / MINUTE);
  const lastBucket = Math.floor(nowMinute / size);
  const firstBucket = lastBucket - total + 1;
  const priceCache = new Map();
  const priceAt = (minute, symbol) => {
    if (!priceCache.has(minute)) {
      const quotes = quoteAt(minute * MINUTE) || [];
      priceCache.set(minute, new Map(quotes.map((quote) => [quote.symbol, Number(quote.priceUsd)])));
    }
    const price = priceCache.get(minute).get(symbol);
    return Number.isFinite(price) && price > 0 ? price : null;
  };
  const tradesBy = new Map();
  for (const row of tradeBuckets || []) tradesBy.set(`${row.asset}|${Number(row.bucket)}`, row);
  const out = {};
  for (const symbol of symbols) {
    const candles = [];
    for (let bucket = firstBucket; bucket <= lastBucket; bucket += 1) {
      const start = bucket * size, end = Math.min(start + size - 1, nowMinute);
      let open = null, high = -Infinity, low = Infinity, close = null;
      for (let minute = start; minute <= end; minute += 1) {
        const price = priceAt(minute, symbol);
        if (price === null) continue;
        if (open === null) open = price;
        high = Math.max(high, price); low = Math.min(low, price); close = price;
      }
      if (open === null) continue;
      const trade = tradesBy.get(`${symbol}|${bucket}`);
      if (trade) {
        const tradeMin = Number(trade.minPriceUsd), tradeMax = Number(trade.maxPriceUsd);
        if (Number.isFinite(tradeMin) && tradeMin > 0) low = Math.min(low, tradeMin);
        if (Number.isFinite(tradeMax) && tradeMax > 0) high = Math.max(high, tradeMax);
      }
      candles.push({ t: new Date(start * MINUTE).toISOString(), o: round(open), h: round(high), l: round(low), c: round(close),
        v: round(trade?.volume || 0), n: Number(trade?.trades || 0), buyUsd: round(trade?.buyNotionalUsd || 0, 2),
        sellUsd: round(trade?.sellNotionalUsd || 0, 2) });
    }
    const last = candles.at(-1)?.c ?? null;
    const dayAgo = priceAt(nowMinute - 1_440, symbol);
    const first = candles[0]?.o ?? null;
    out[symbol] = {
      symbol, interval: `${size}m`, candles, priceUsd: last,
      open24hUsd: dayAgo, change24hPct: last !== null && dayAgo ? round(((last - dayAgo) / dayAgo) * 100, 4) : null,
      windowChangePct: last !== null && first ? round(((last - first) / first) * 100, 4) : null,
      high24hUsd: null, low24hUsd: null
    };
    // 24h range from the hourly samples (cheap) plus the window candles
    let hi = -Infinity, lo = Infinity;
    for (let minute = nowMinute - 1_440; minute <= nowMinute; minute += 30) {
      const price = priceAt(minute, symbol); if (price === null) continue; hi = Math.max(hi, price); lo = Math.min(lo, price);
    }
    for (const candle of candles) { hi = Math.max(hi, candle.h); lo = Math.min(lo, candle.l); }
    if (Number.isFinite(hi)) { out[symbol].high24hUsd = round(hi); out[symbol].low24hUsd = round(lo); }
  }
  return out;
}

export function marketRecentTrades(trades = [], limit = MARKET_RECENT_TRADES) {
  return (trades || []).slice(0, limit).map((trade) => ({
    side: trade.side === 'sell' ? 'sell' : 'buy', asset: trade.asset, size: trade.quantity ?? null,
    priceUsd: trade.priceUsd ?? null, notionalUsd: trade.notionalUsd ?? null,
    resident: trade.agentName ?? null, residentId: trade.agentId ?? null, createdAt: trade.createdAt,
    ...(trade.simulatedMeme ? { simulatedMeme: true } : {})
  }));
}

// One bounded aggregate over the indexed (world_id, created_at) range of crypto_trades.
export async function readMarketTradeBuckets(client, { worldId, now = Date.now(), bucketMinutes = CANDLE_BUCKET_MINUTES,
  count = CANDLE_COUNT, symbols = MARKET_SYMBOLS }) {
  const nowMinute = Math.floor(now / MINUTE);
  const since = new Date((Math.floor(nowMinute / bucketMinutes) - count + 1) * bucketMinutes * MINUTE);
  const result = await client.query(`SELECT asset_symbol AS asset,
      floor(extract(epoch FROM created_at) / ($3::int * 60))::bigint::text AS bucket,
      count(*)::int AS trades, sum(quantity)::text AS volume, sum(notional_usd)::text AS "notionalUsd",
      coalesce(sum(notional_usd) FILTER (WHERE side='buy'),0)::text AS "buyNotionalUsd",
      coalesce(sum(notional_usd) FILTER (WHERE side='sell'),0)::text AS "sellNotionalUsd",
      min(price_usd)::text AS "minPriceUsd", max(price_usd)::text AS "maxPriceUsd"
    FROM crypto_trades WHERE world_id=$1 AND created_at >= $2 AND asset_symbol = ANY($4::text[])
    GROUP BY 1,2`, [worldId, since, bucketMinutes, [...symbols]]);
  return result.rows;
}

// world.market payload. Candles are memoised per minute (the feed only changes once a minute);
// the trade aggregate is re-read on every call so new fills show up on the next 2 s refresh.
export async function readWorldMarket(client, { worldId, recentTrades = [], now = Date.now() }) {
  let tradeBuckets = [];
  try { tradeBuckets = await readMarketTradeBuckets(client, { worldId, now }); } catch { tradeBuckets = []; }
  const key = `${worldId}|${Math.floor(now / MINUTE)}|${JSON.stringify(tradeBuckets)}`;
  if (memo.key !== key) memo = { key, value: buildMarketCandles({ now, tradeBuckets }) };
  return {
    simulated: true, source: 'synterra_simulated_market', bucketMinutes: CANDLE_BUCKET_MINUTES,
    candleCount: CANDLE_COUNT, asOf: new Date(Math.floor(now / MINUTE) * MINUTE).toISOString(),
    symbols: memo.value, recentTrades: marketRecentTrades(recentTrades)
  };
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { simulatedQuotes } from '../src/crypto-market.js';
import { buildMarketCandles, marketRecentTrades, readMarketTradeBuckets, readWorldMarket } from '../src/market-candles.js';

const NOW = Date.parse('2026-10-07T12:07:30.000Z');

test('candles are rebuilt from the deterministic per-minute quote feed', () => {
  const market = buildMarketCandles({ now: NOW, bucketMinutes: 15, count: 4 });
  assert.deepEqual(Object.keys(market), ['BTC', 'ETH']);
  const btc = market.BTC;
  assert.equal(btc.interval, '15m');
  assert.equal(btc.candles.length, 4);
  assert.equal(btc.candles.at(-1).t, '2026-10-07T12:00:00.000Z');
  assert.equal(btc.candles[0].t, '2026-10-07T11:15:00.000Z');
  const quote = (iso, symbol) => Number(simulatedQuotes(Date.parse(iso)).find((q) => q.symbol === symbol).priceUsd);
  // open = first minute of the bucket, close = latest minute (the bucket is still open)
  assert.equal(btc.candles[0].o, quote('2026-10-07T11:15:00Z', 'BTC'));
  assert.equal(btc.candles[0].c, quote('2026-10-07T11:29:00Z', 'BTC'));
  assert.equal(btc.candles.at(-1).c, quote('2026-10-07T12:07:00Z', 'BTC'));
  assert.equal(btc.priceUsd, btc.candles.at(-1).c);
  for (const candle of [...btc.candles, ...market.ETH.candles]) {
    assert.ok(candle.h >= Math.max(candle.o, candle.c) && candle.l <= Math.min(candle.o, candle.c));
    assert.equal(candle.v, 0); assert.equal(candle.n, 0);
  }
  const dayAgo = quote('2026-10-06T12:07:00Z', 'ETH');
  assert.equal(market.ETH.open24hUsd, dayAgo);
  assert.ok(Math.abs(market.ETH.change24hPct - ((market.ETH.priceUsd - dayAgo) / dayAgo) * 100) < 1e-3);
  assert.ok(market.ETH.high24hUsd >= market.ETH.low24hUsd);
});

test('trade buckets add volume and widen the range; missing quotes are skipped', () => {
  const bucket = Math.floor(Date.parse('2026-10-07T12:00:00Z') / 60_000 / 15);
  const flat = () => [{ symbol: 'BTC', priceUsd: '100' }, { symbol: 'ETH', priceUsd: '10' }];
  const market = buildMarketCandles({ now: NOW, count: 2, quoteAt: flat, tradeBuckets: [
    { asset: 'BTC', bucket: String(bucket), trades: 3, volume: '0.5', notionalUsd: '50', buyNotionalUsd: '40', sellNotionalUsd: '10', minPriceUsd: '99', maxPriceUsd: '101' }
  ] });
  const last = market.BTC.candles.at(-1);
  assert.deepEqual([last.o, last.h, last.l, last.c, last.v, last.n, last.buyUsd, last.sellUsd], [100, 101, 99, 100, 0.5, 3, 40, 10]);
  assert.equal(market.ETH.candles.at(-1).n, 0);
  const empty = buildMarketCandles({ now: NOW, count: 3, quoteAt: () => [] });
  assert.deepEqual(empty.BTC.candles, []);
  assert.equal(empty.BTC.priceUsd, null);
  assert.equal(empty.BTC.change24hPct, null);
});

test('recent trades are normalised and bounded', () => {
  const rows = Array.from({ length: 30 }, (_, i) => ({ agentName: `agent-${i}`, agentId: `id-${i}`, side: i % 2 ? 'sell' : 'buy',
    asset: 'ETH', quantity: '0.1', priceUsd: '3000', notionalUsd: '300', createdAt: '2026-10-07T12:00:00Z' }));
  const trades = marketRecentTrades(rows);
  assert.equal(trades.length, 20);
  assert.deepEqual(trades[1], { side: 'sell', asset: 'ETH', size: '0.1', priceUsd: '3000', notionalUsd: '300',
    resident: 'agent-1', residentId: 'id-1', createdAt: '2026-10-07T12:00:00Z' });
});

test('world.market reads one bounded aggregate from crypto_trades', async () => {
  const calls = [];
  const client = { query: async (sql, params) => { calls.push({ sql, params }); return { rows: [] }; } };
  const rows = await readMarketTradeBuckets(client, { worldId: 'w1', now: NOW });
  assert.deepEqual(rows, []);
  assert.match(calls[0].sql, /FROM crypto_trades WHERE world_id=\$1 AND created_at >= \$2/);
  assert.equal(calls[0].params[0], 'w1');
  assert.equal(calls[0].params[1].toISOString(), '2026-10-07T00:15:00.000Z');
  assert.deepEqual(calls[0].params.slice(2), [15, ['BTC', 'ETH']]);
  const market = await readWorldMarket(client, { worldId: 'w1', now: NOW, recentTrades: [{ side: 'buy', asset: 'BTC', agentName: 'a', agentId: 'x' }] });
  assert.equal(market.simulated, true);
  assert.equal(market.symbols.BTC.candles.length, 48);
  assert.equal(market.recentTrades[0].residentId, 'x');
  // a failing aggregate degrades to candles without volume instead of breaking map-data
  const broken = await readWorldMarket({ query: async () => { throw new Error('boom'); } }, { worldId: 'w2', now: NOW });
  assert.equal(broken.symbols.ETH.candles.length, 48);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { detectReaction, formatPrice, normalizeMarket } from '../site/crypto-plaza.js';

const candles = (base, n = 10, step = 0.001) => Array.from({ length: n }, (_, i) => {
  const o = base * (1 + i * step), c = base * (1 + (i + 1) * step);
  return { t: `2026-10-07T${String(i).padStart(2, '0')}:00:00Z`, o, h: c, l: o, c, v: 0, n: 0, buyUsd: 0, sellUsd: 0 };
});
const payload = (btc, eth, trades = []) => ({ world: { market: { simulated: true, symbols: {
  BTC: { interval: '15m', candles: candles(btc / 1.01), priceUsd: btc, change24hPct: 1.2 },
  ETH: { interval: '15m', candles: candles(eth / 1.01), priceUsd: eth, change24hPct: -0.4 } }, recentTrades: trades } } });

test('older payloads without world.market never get invented chart data', () => {
  const empty = normalizeMarket({});
  assert.equal(empty.charted, false); assert.equal(empty.priced, false);
  assert.equal(empty.symbols.BTC.price, null); assert.deepEqual(empty.symbols.ETH.candles, []);
  // legacy payload: only the latest quotes are real, so prices show but charts stay "MARKET LOADING"
  const legacy = normalizeMarket({ trading: { quotes: [{ symbol: 'ETH', priceUsd: '3412.55' }],
    recentTrades: [{ side: 'buy', asset: 'ETH', quantity: '0.1', agentName: 'agent-a', agentId: 'a', createdAt: 'x' }, { side: 'buy', asset: '0xabc', agentName: 'b' }] } });
  assert.equal(legacy.charted, false); assert.equal(legacy.priced, true);
  assert.equal(legacy.symbols.ETH.price, 3412.55); assert.equal(legacy.symbols.BTC.price, null);
  assert.equal(legacy.trades.length, 1); assert.equal(legacy.trades[0].residentId, 'a');
  const full = normalizeMarket(payload(63000, 3400));
  assert.equal(full.charted, true); assert.equal(full.symbols.BTC.candles.length, 10); assert.equal(full.symbols.ETH.change24h, -0.4);
});

test('crowd reactions follow real ticks relative to the typical move', () => {
  const before = normalizeMarket(payload(63000, 3400));
  assert.equal(detectReaction(before, normalizeMarket(payload(63000, 3400))), null);
  const pump = detectReaction(before, normalizeMarket(payload(63000 * 1.03, 3400)));
  assert.equal(pump.kind, 'pump'); assert.equal(pump.big, true); assert.equal(pump.symbol, 'BTC');
  const dump = detectReaction(before, normalizeMarket(payload(63000, 3400 * 0.99)));
  assert.equal(dump.kind, 'dump'); assert.equal(dump.symbol, 'ETH');
  const small = detectReaction(before, normalizeMarket(payload(63000 * 1.00026, 3400)));
  assert.equal(small.kind, 'pump'); assert.equal(small.big, false);
  // no market yet -> nothing to react to
  assert.equal(detectReaction(normalizeMarket({}), before), null);
  // a whale fill with a flat price still moves the crowd
  const whale = detectReaction(before, normalizeMarket(payload(63000, 3400, [{ side: 'sell', asset: 'BTC', notionalUsd: '9000', resident: 'w', createdAt: 't1' }])));
  assert.equal(whale.kind, 'dump'); assert.equal(whale.whale, true);
});

test('prices are formatted for the boards', () => {
  assert.equal(formatPrice('63288.4617'), '63,288.46');
  assert.equal(formatPrice(null), '—');
});

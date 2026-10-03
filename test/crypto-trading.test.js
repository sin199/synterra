import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateTrade, MAX_ORDER_NAV_BPS } from '../src/crypto-trading.js';
import { simulatedQuotes } from '../src/crypto-market.js';

const marketBalances = {
  USDC: '10000.00000000', BTC: '0.00000000', ETH: '0.00000000',
  BTCPriceUsd: '65000.00000000', ETHPriceUsd: '3200.00000000'
};

test('market quotes are reproducible per minute and explicitly simulated', () => {
  const first = simulatedQuotes(1_800_000_000_000);
  const sameMinute = simulatedQuotes(1_800_000_030_000);
  assert.deepEqual(first, sameMinute);
  assert.deepEqual(first.map((quote) => quote.symbol), ['BTC', 'ETH', 'USDC']);
  assert.ok(first.every((quote) => quote.source === 'synterra_simulated_market'));
  assert.equal(first.find((quote) => quote.symbol === 'USDC').priceUsd, '1.00000000');
});

test('buy settles exact decimal balances with simulated spread and fee', () => {
  const trade = calculateTrade({ side: 'buy', asset: 'BTC', quoteUnits: '100', priceUsd: '65000', balances: marketBalances });
  assert.equal(trade.side, 'buy');
  assert.equal(trade.asset, 'BTC');
  assert.ok(Math.abs(Number(trade.feeUsdc) - 0.1) < 0.000001);
  assert.ok(Math.abs(Number(trade.usdcDelta) + 100.1) < 0.001);
  assert.ok(Number(trade.quantity) > 0);
  assert.equal(trade.executionPriceUsd, '65032.50000000');
});

test('sell requires held asset and credits net proceeds after fee', () => {
  const trade = calculateTrade({ side: 'sell', asset: 'ETH', quoteUnits: '100', priceUsd: '3200', balances: {
    ...marketBalances, ETH: '1.00000000'
  } });
  assert.equal(trade.executionPriceUsd, '3198.40000000');
  assert.ok(Math.abs(Number(trade.feeUsdc) - 0.1) < 0.000001);
  assert.ok(Number(trade.usdcDelta) > 99);
  assert.ok(Number(trade.assetDelta) < 0);
});

test('trade engine rejects leverage, oversize orders, over-concentration, and invalid assets', () => {
  assert.throws(() => calculateTrade({ side: 'buy', asset: 'BTC', quoteUnits: '1001', priceUsd: '65000', balances: marketBalances }),
    (error) => error.message === 'ORDER_EXCEEDS_RISK_LIMIT' && error.statusCode === 409);
  assert.throws(() => calculateTrade({ side: 'sell', asset: 'BTC', quoteUnits: '100', priceUsd: '65000', balances: marketBalances }),
    (error) => error.message === 'INSUFFICIENT_ASSET' && error.statusCode === 409);
  assert.throws(() => calculateTrade({ side: 'buy', asset: 'DOGE', quoteUnits: '100', priceUsd: '0.1', balances: marketBalances }),
    (error) => error.message === 'TRADE_FIELDS_INVALID');
  assert.equal(MAX_ORDER_NAV_BPS, 1000);
});

test('per-asset exposure cap is enforced after pricing and fees', () => {
  const balances = {
    USDC: '5100.00000000', BTC: '0.00000000', ETH: '1.53125000',
    BTCPriceUsd: '65000.00000000', ETHPriceUsd: '3200.00000000'
  };
  assert.throws(() => calculateTrade({ side: 'buy', asset: 'ETH', quoteUnits: '101', priceUsd: '3200', balances }),
    (error) => error.message === 'ASSET_EXPOSURE_LIMIT' && error.statusCode === 409);
});

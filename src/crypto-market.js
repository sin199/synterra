const MARKET_ASSETS = Object.freeze({
  BTC: Object.freeze({ name: 'Bitcoin', basePrice: 65000, amplitude: 0.035, phase: 0.3 }),
  ETH: Object.freeze({ name: 'Ether', basePrice: 3200, amplitude: 0.05, phase: 1.7 }),
  USDC: Object.freeze({ name: 'USD Coin', basePrice: 1, amplitude: 0, phase: 0 })
});
const SCALE = 100_000_000;

function fixed(value) {
  return (Math.round(value * SCALE) / SCALE).toFixed(8);
}

// A deterministic test market for the internal simulation. It does not query
// an exchange, oracle, wallet, or blockchain.
export function simulatedQuotes(now = Date.now()) {
  const minute = Math.floor(now / 60_000);
  const elapsed = minute * 60_000;
  const quotes = Object.entries(MARKET_ASSETS).map(([symbol, asset]) => {
    const hours = elapsed / 3_600_000;
    const wave = asset.amplitude === 0 ? 0
      : Math.sin(hours / 18 + asset.phase) * asset.amplitude
        + Math.sin(hours / 5.5 + asset.phase * 2) * asset.amplitude * 0.18;
    return {
      symbol,
      name: asset.name,
      priceUsd: fixed(asset.basePrice * (1 + wave)),
      quoteVersion: minute,
      asOf: new Date(elapsed).toISOString(),
      source: 'synterra_simulated_market'
    };
  });
  return quotes;
}

export function applyBasisPoints(amount, basisPoints) {
  const scaled = parsePositiveUnits(amount, { allowZero: true });
  if (!Number.isInteger(basisPoints) || basisPoints < 0 || basisPoints > 10_000) throw new Error('BASIS_POINTS_INVALID');
  return formatUnits(scaled * BigInt(basisPoints) / 10_000n);
}

export function parsePositiveUnits(value, { allowZero = false } = {}) {
  const raw = String(value ?? '').trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,8})?$/.test(raw)) throw new Error('UNITS_INVALID');
  const [whole, fraction = ''] = raw.split('.');
  const scaled = BigInt(whole) * 100_000_000n + BigInt((fraction + '00000000').slice(0, 8));
  if ((!allowZero && scaled <= 0n) || scaled < 0n) throw new Error('UNITS_INVALID');
  return scaled;
}

export function formatUnits(value) {
  const scaled = BigInt(value);
  const negative = scaled < 0n;
  const absolute = negative ? -scaled : scaled;
  const whole = absolute / 100_000_000n;
  const fraction = String(absolute % 100_000_000n).padStart(8, '0');
  return `${negative ? '-' : ''}${whole}.${fraction}`;
}

export function multiplyUnits(left, right) {
  return (parsePositiveUnits(left, { allowZero: true }) * parsePositiveUnits(right, { allowZero: true })) / 100_000_000n;
}

export function divideUnits(numerator, denominator) {
  const divisor = parsePositiveUnits(denominator, { allowZero: true });
  if (divisor === 0n) throw new Error('DIVIDE_BY_ZERO');
  return parsePositiveUnits(numerator, { allowZero: true }) * 100_000_000n / divisor;
}

export function addUnits(left, right) {
  return parsePositiveUnits(left, { allowZero: true }) + parseSignedUnits(right);
}

export function parseSignedUnits(value) {
  const raw = String(value ?? '').trim();
  if (!/^-?(?:0|[1-9]\d*)(?:\.\d{1,8})?$/.test(raw)) throw new Error('UNITS_INVALID');
  const negative = raw.startsWith('-');
  const unsigned = negative ? raw.slice(1) : raw;
  const [whole, fraction = ''] = unsigned.split('.');
  const scaled = BigInt(whole) * 100_000_000n + BigInt((fraction + '00000000').slice(0, 8));
  return negative ? -scaled : scaled;
}

export function isMarketAsset(symbol) {
  return Object.hasOwn(MARKET_ASSETS, symbol);
}

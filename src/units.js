const SCALE = 100_000_000n;

export function parsePositiveUnits(value, { allowZero = false } = {}) {
  const raw = String(value ?? '').trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,8})?$/.test(raw)) throw new Error('UNITS_INVALID');
  const [whole, fraction = ''] = raw.split('.');
  const scaled = BigInt(whole) * SCALE + BigInt((fraction + '00000000').slice(0, 8));
  if ((!allowZero && scaled <= 0n) || scaled < 0n) throw new Error('UNITS_INVALID');
  return scaled;
}

export function formatUnits(value) {
  const scaled = BigInt(value);
  const negative = scaled < 0n;
  const absolute = negative ? -scaled : scaled;
  const whole = absolute / SCALE;
  const fraction = String(absolute % SCALE).padStart(8, '0');
  return `${negative ? '-' : ''}${whole}.${fraction}`;
}

export function multiplyUnits(left, right) {
  return (parsePositiveUnits(left, { allowZero: true }) * parsePositiveUnits(right, { allowZero: true })) / SCALE;
}

export function divideUnits(numerator, denominator) {
  const divisor = parsePositiveUnits(denominator, { allowZero: true });
  if (divisor === 0n) throw new Error('DIVIDE_BY_ZERO');
  return parsePositiveUnits(numerator, { allowZero: true }) * SCALE / divisor;
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
  const scaled = BigInt(whole) * SCALE + BigInt((fraction + '00000000').slice(0, 8));
  return negative ? -scaled : scaled;
}

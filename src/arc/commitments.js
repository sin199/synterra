import { keccak256, toUtf8Bytes } from 'ethers';

function canonicalValue(value) {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
  }
  if (typeof value === 'number' && !Number.isFinite(value)) throw new TypeError('Commitment data cannot contain non-finite numbers.');
  if (value === undefined) return null;
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

export function hashCommitmentRecord(record) {
  return keccak256(toUtf8Bytes(canonicalJson(record)));
}

function hashPair(left, right) {
  const [first, second] = left.toLowerCase() < right.toLowerCase() ? [left, right] : [right, left];
  return keccak256(`0x${first.slice(2)}${second.slice(2)}`);
}

export function merkleRoot(records) {
  if (!Array.isArray(records)) throw new TypeError('Merkle input must be an array.');
  if (!records.length) return keccak256('0x');
  let layer = records.map(hashCommitmentRecord).sort((a, b) => a.localeCompare(b));
  while (layer.length > 1) {
    const next = [];
    for (let index = 0; index < layer.length; index += 2) {
      next.push(hashPair(layer[index], layer[index + 1] || layer[index]));
    }
    layer = next;
  }
  return layer[0];
}

export function buildWorldCheckpointRoots({ history = [], simulationLedger = [], capabilities = [] }) {
  return Object.freeze({
    historyRoot: merkleRoot(history),
    simulationLedgerRoot: merkleRoot(simulationLedger),
    capabilityRoot: merkleRoot(capabilities),
    leafCounts: Object.freeze({ history: history.length, simulationLedger: simulationLedger.length,
      capabilities: capabilities.length })
  });
}

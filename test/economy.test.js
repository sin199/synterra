import test from 'node:test';
import assert from 'node:assert/strict';
import { canAffordUnits, chargeMeal, parsePositiveUnitAmount } from '../src/economy.js';

test('world unit amounts are bounded positive decimals with up to eight places', () => {
  assert.equal(parsePositiveUnitAmount(undefined), '2.00000000');
  assert.equal(parsePositiveUnitAmount('0.00000001'), '0.00000001');
  for (const invalid of ['0', '-1', '1e3', '1.000000001', '1000001', '  ']) {
    assert.throws(() => parsePositiveUnitAmount(invalid));
  }
});

test('affordability compares decimal balances without floating point rounding', () => {
  assert.equal(canAffordUnits('2.00000000', '2'), true);
  assert.equal(canAffordUnits('1.99999999', '2'), false);
  assert.equal(canAffordUnits('-1', '2'), false);
  assert.equal(canAffordUnits('not-a-balance', '2'), false);
});

test('meal purchase debits the configured amount and returns the remaining balance', async () => {
  const calls = [];
  const client = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.includes('FROM world_genesis_currency_activations')) return { rows: [] };
      if (sql.includes('AS can_spend')) return { rows: [{ can_spend: true }] };
      if (sql.includes('INSERT INTO token_ledger')) return { rows: [] };
      if (sql.includes('AS units')) return { rows: [{ units: '3.00000000' }] };
      throw new Error(`Unexpected query: ${sql}`);
    }
  };
  const result = await chargeMeal(client, { worldId: 'world-1', agentId: 'agent-1', actionId: 'action-1' });
  assert.deepEqual(result, { spentUnits: '2.00000000', balanceUnits: '3.00000000' });
  const debit = calls.find((call) => call.sql.includes('INSERT INTO token_ledger'));
  assert.deepEqual(debit.params, ['world-1', 'agent-1', '-2.00000000', 'action-1']);
});

test('meal purchase rejects an insufficient balance before writing a debit', async () => {
  const calls = [];
  const client = {
    async query(sql) {
      calls.push(sql);
      if (sql.includes('FROM world_genesis_currency_activations')) return { rows: [] };
      return { rows: [{ can_spend: false }] };
    }
  };
  await assert.rejects(
    chargeMeal(client, { worldId: 'world-1', agentId: 'agent-1', actionId: 'action-2' }),
    (error) => error.message === 'INSUFFICIENT_INTERNAL_UNITS' && error.statusCode === 409
  );
  assert.equal(calls.length, 2);
  assert.ok(!calls.some((sql) => sql.includes('INSERT INTO token_ledger')));
});

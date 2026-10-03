import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAdultServicePrice, payAdultServiceProvider, refundAdultServiceFunds, reserveAdultServiceFunds } from '../src/adult-services.js';

test('adult service prices must be positive bounded internal-unit amounts', () => {
  assert.equal(parseAdultServicePrice('12.5'), '12.50000000');
  for (const invalid of [undefined, null, '', '0', '-1', '1e4', '1000001']) {
    assert.throws(() => parseAdultServicePrice(invalid));
  }
});

test('booking reservation checks available balance before recording a debit', async () => {
  const calls = [];
  const client = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.includes('can_reserve')) return { rows: [{ can_reserve: true }] };
      if (sql.includes('INSERT INTO token_ledger')) return { rows: [] };
      throw new Error(`Unexpected query: ${sql}`);
    }
  };
  await reserveAdultServiceFunds(client, {
    worldId: 'world-1', requesterId: 'agent-a', bookingId: 'booking-1', priceUnits: '4.00000000'
  });
  const debit = calls.find((call) => call.sql.includes('INSERT INTO token_ledger'));
  assert.deepEqual(debit.params, ['world-1', 'agent-a', '-4.00000000', 'adult-service:booking-1:reserve']);
});

test('booking reservation rejects insufficient balance without a debit', async () => {
  const calls = [];
  const client = {
    async query(sql) {
      calls.push(sql);
      return { rows: [{ can_reserve: false }] };
    }
  };
  await assert.rejects(
    reserveAdultServiceFunds(client, {
      worldId: 'world-1', requesterId: 'agent-a', bookingId: 'booking-2', priceUnits: '4.00000000'
    }),
    (error) => error.message === 'INSUFFICIENT_INTERNAL_UNITS' && error.statusCode === 409
  );
  assert.equal(calls.length, 1);
  assert.ok(!calls.some((sql) => sql.includes('INSERT INTO token_ledger')));
});

test('refund and provider income use separate idempotent positive ledger entries', async () => {
  const calls = [];
  const client = { async query(sql, params) { calls.push({ sql, params }); return { rows: [] }; } };
  const booking = { id: 'booking-3', world_id: 'world-1', requester_id: 'agent-a', provider_id: 'agent-b', price_units: '4.00000000' };
  await refundAdultServiceFunds(client, booking);
  await payAdultServiceProvider(client, booking);
  assert.deepEqual(calls.map((call) => call.params), [
    ['world-1', 'agent-a', '4.00000000', 'adult-service:booking-3:refund'],
    ['world-1', 'agent-b', '4.00000000', 'adult-service:booking-3:income']
  ]);
  assert.ok(calls.every((call) => call.sql.includes('ON CONFLICT (world_id,agent_id,action_id) DO NOTHING')));
});

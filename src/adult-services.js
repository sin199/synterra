import { parsePositiveUnitAmount } from './economy.js';

export function parseAdultServicePrice(value) {
  if (value === undefined || value === null || value === '') {
    throw new Error('PRICE_UNITS_REQUIRED');
  }
  return parsePositiveUnitAmount(value);
}

export async function reserveAdultServiceFunds(client, { worldId, requesterId, bookingId, priceUnits }) {
  const balance = await client.query(`SELECT COALESCE(sum(amount),0)::numeric >= $3::numeric AS can_reserve
    FROM token_ledger WHERE world_id=$1 AND agent_id=$2`, [worldId, requesterId, priceUnits]);
  if (!balance.rows[0].can_reserve) {
    throw Object.assign(new Error('INSUFFICIENT_INTERNAL_UNITS'), { statusCode: 409 });
  }
  await client.query(`INSERT INTO token_ledger(world_id,agent_id,amount,entry_type,reason,action_id)
    VALUES($1,$2,$3,'spent','adult service booking escrow',$4)`,
  [worldId, requesterId, `-${priceUnits}`, `adult-service:${bookingId}:reserve`]);
}

export async function refundAdultServiceFunds(client, booking) {
  await client.query(`INSERT INTO token_ledger(world_id,agent_id,amount,entry_type,reason,action_id)
    VALUES($1,$2,$3,'refunded','adult service booking refund',$4)
    ON CONFLICT (world_id,agent_id,action_id) DO NOTHING`,
  [booking.world_id, booking.requester_id, booking.price_units, `adult-service:${booking.id}:refund`]);
}

export async function payAdultServiceProvider(client, booking) {
  await client.query(`INSERT INTO token_ledger(world_id,agent_id,amount,entry_type,reason,action_id)
    VALUES($1,$2,$3,'service_income','completed adult service',$4)
    ON CONFLICT (world_id,agent_id,action_id) DO NOTHING`,
  [booking.world_id, booking.provider_id, booking.price_units, `adult-service:${booking.id}:income`]);
}

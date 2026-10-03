export const DEFAULT_MEAL_COST_UNITS = '2';
const UNIT_SCALE = 100_000_000n;
const MAX_CONFIGURED_UNITS = 1_000_000n * UNIT_SCALE;

export function parsePositiveUnitAmount(value, fallback = DEFAULT_MEAL_COST_UNITS) {
  const raw = value === undefined || value === '' ? fallback : String(value).trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,8})?$/.test(raw)) {
    throw new Error('World economy amounts must be plain decimal numbers with at most 8 decimal places.');
  }
  const [whole, fraction = ''] = raw.split('.');
  const scaled = BigInt(whole) * UNIT_SCALE + BigInt((fraction + '00000000').slice(0, 8));
  if (scaled <= 0n || scaled > MAX_CONFIGURED_UNITS) {
    throw new Error('World economy amounts must be greater than 0 and at most 1000000 units.');
  }
  return `${whole}.${fraction.padEnd(8, '0')}`;
}

export const MEAL_COST_UNITS = parsePositiveUnitAmount(process.env.WORLD_MEAL_COST_UNITS);

function scaledNonNegativeAmount(value) {
  const raw = String(value ?? '0').trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,8})?$/.test(raw)) return null;
  const [whole, fraction = ''] = raw.split('.');
  return BigInt(whole) * UNIT_SCALE + BigInt((fraction + '00000000').slice(0, 8));
}

export function canAffordUnits(balance, cost = MEAL_COST_UNITS) {
  const balanceScaled = scaledNonNegativeAmount(balance);
  const costScaled = scaledNonNegativeAmount(cost);
  return balanceScaled !== null && costScaled !== null && balanceScaled >= costScaled;
}

export async function chargeMeal(client, { worldId, agentId, actionId }) {
  const balanceResult = await client.query(`SELECT COALESCE(sum(amount),0)::numeric AS units,
      COALESCE(sum(amount),0)::numeric >= $3::numeric AS can_spend
    FROM token_ledger WHERE world_id=$1 AND agent_id=$2`, [worldId, agentId, MEAL_COST_UNITS]);
  if (!balanceResult.rows[0].can_spend) {
    throw Object.assign(new Error('INSUFFICIENT_INTERNAL_UNITS'), { statusCode: 409 });
  }

  await client.query(`INSERT INTO token_ledger(world_id,agent_id,amount,entry_type,reason,action_id)
    VALUES($1,$2,$3,'spent','purchased hearty meal',$4)`, [worldId, agentId, `-${MEAL_COST_UNITS}`, actionId]);
  const remaining = await client.query('SELECT COALESCE(sum(amount),0)::text AS units FROM token_ledger WHERE world_id=$1 AND agent_id=$2', [worldId, agentId]);
  return { spentUnits: MEAL_COST_UNITS, balanceUnits: remaining.rows[0].units };
}

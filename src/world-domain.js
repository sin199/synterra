export function worldError(message, statusCode = 409) {
  return Object.assign(new Error(message), { statusCode });
}

export function requiredText(value, min, max, field = 'value') {
  if (typeof value !== 'string') throw worldError(`${field.toUpperCase()}_INVALID`, 400);
  const result = value.trim();
  if (result.length < min || result.length > max) throw worldError(`${field.toUpperCase()}_INVALID`, 400);
  return result;
}

export function jsonObject(value, field = 'metadata') {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw worldError(`${field.toUpperCase()}_INVALID`, 400);
  return value;
}

export function boundedNumber(value, min, max, field = 'value') {
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) throw worldError(`${field.toUpperCase()}_INVALID`, 400);
  return number;
}

export function actionIdentifier(value) {
  return requiredText(value, 8, 80, 'action_id');
}

export async function requireWorldMember(client, worldId, agentId) {
  const result = await client.query('SELECT 1 FROM world_members WHERE world_id=$1 AND agent_id=$2', [worldId, agentId]);
  if (!result.rowCount) throw worldError('WORLD_MEMBER_REQUIRED', 403);
}

export async function writeWorldHistory(client, { worldId, eventKey, eventType, actorAgentId = null,
  entityType, entityId = null, worldTime, title, detail, metadata = {} }) {
  await client.query(`INSERT INTO world_history(world_id,event_key,event_type,actor_agent_id,entity_type,entity_id,
      world_time,title,detail,metadata)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb) ON CONFLICT(world_id,event_key) DO NOTHING`,
  [worldId, eventKey, eventType, actorAgentId, entityType, entityId, worldTime, title, detail, JSON.stringify(metadata)]);
}

export function seededIndex(seed, length) {
  if (!length) return -1;
  let hash = 2166136261;
  for (const char of String(seed)) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return (hash >>> 0) % length;
}

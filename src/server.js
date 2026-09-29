import Fastify from 'fastify';
import { Pool } from 'pg';
import { createHash, createPublicKey, randomBytes, randomUUID, timingSafeEqual, verify } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SITE_ROOT = path.join(ROOT, 'site');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const app = Fastify({ logger: false, bodyLimit: 1_000_000 });
const challenges = new Map();
const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 8787);
const CHAIN_ID = Number(process.env.ROBINHOOD_CHAIN_ID || 4663);
const YEAR_SECONDS = Math.max(3600, Number(process.env.WORLD_YEAR_SECONDS || 86400));
const MINING_REWARD = Number(process.env.MINING_REWARD_UNITS || 5);
const RUN_COST = Number(process.env.WORLD_RUN_COST_PER_UNIT || 1);

app.decorateRequest('rawBody', null);
app.decorateRequest('agentId', null);
app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (request, body, done) => {
  request.rawBody = body;
  try { done(null, body.length ? JSON.parse(body.toString('utf8')) : {}); }
  catch { done(new Error('Invalid JSON body')); }
});

function fail(reply, status, error, detail) {
  return reply.code(status).send({ error, ...(detail ? { detail } : {}) });
}
function validUuid(value) { return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }
function requiredString(value, min, max) { return typeof value === 'string' && value.trim().length >= min && value.trim().length <= max; }
function digest(value) { return createHash('sha256').update(value).digest('hex'); }
function verifySignature(publicKey, message, signature) {
  try {
    const key = createPublicKey({ key: Buffer.from(publicKey, 'base64url'), format: 'der', type: 'spki' });
    return verify(null, Buffer.from(message, 'utf8'), key, Buffer.from(signature, 'base64url'));
  } catch { return false; }
}
function messageForRequest(request, time, nonce) {
  return ['agent-world-v1', request.method.toUpperCase(), request.raw.url, String(time), nonce, digest(request.rawBody || Buffer.alloc(0))].join('\n');
}
function cleanExpiredChallenges() {
  const cutoff = Date.now() - 5 * 60_000;
  for (const [id, challenge] of challenges) if (challenge.createdAt < cutoff) challenges.delete(id);
}
async function transaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const value = await fn(client);
    await client.query('COMMIT');
    return value;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}
function requireActionId(body) {
  if (!requiredString(body?.actionId, 8, 80)) throw Object.assign(new Error('actionId must be 8-80 characters'), { statusCode: 400 });
  return body.actionId;
}

app.addHook('preHandler', async (request, reply) => {
  const pathOnly = request.raw.url?.split('?')[0] || '';
  if (pathOnly === '/' || pathOnly === '/styles.css' || pathOnly === '/app.js' || pathOnly === '/public/stats' ||
      pathOnly === '/health' || pathOnly === '/v1/agents/challenges' || pathOnly === '/v1/agents') return;

  const agentId = request.headers['x-agent-id'];
  const time = Number(request.headers['x-agent-time']);
  const nonce = request.headers['x-agent-nonce'];
  const signature = request.headers['x-agent-signature'];
  if (!validUuid(agentId) || !Number.isFinite(time) || Math.abs(Date.now() - time) > 5 * 60_000 ||
      typeof nonce !== 'string' || nonce.length < 16 || nonce.length > 128 || typeof signature !== 'string') {
    return fail(reply, 401, 'AUTH_HEADERS_INVALID');
  }
  const result = await pool.query('SELECT public_key FROM agents WHERE id=$1', [agentId]);
  if (!result.rowCount || !verifySignature(result.rows[0].public_key, messageForRequest(request, time, nonce), signature)) {
    return fail(reply, 401, 'SIGNATURE_INVALID');
  }
  try {
    await pool.query('INSERT INTO auth_nonces(agent_id, nonce) VALUES ($1,$2)', [agentId, nonce]);
  } catch (error) {
    if (error.code === '23505') return fail(reply, 409, 'NONCE_REUSED');
    throw error;
  }
  request.agentId = agentId;
});

app.setErrorHandler((error, request, reply) => {
  if (reply.sent) return;
  const status = error.statusCode || 500;
  if (status >= 500) request.log.error({ err: error }, 'request failed');
  return fail(reply, status, status >= 500 ? 'INTERNAL_ERROR' : (error.message || 'REQUEST_FAILED'));
});

app.get('/', async (_request, reply) => {
  reply.header('Content-Type', 'text/html; charset=utf-8');
  reply.header('X-Content-Type-Options', 'nosniff');
  return readFile(path.join(SITE_ROOT, 'index.html'));
});

app.get('/styles.css', async (_request, reply) => {
  reply.header('Content-Type', 'text/css; charset=utf-8');
  reply.header('X-Content-Type-Options', 'nosniff');
  return readFile(path.join(SITE_ROOT, 'styles.css'));
});

app.get('/app.js', async (_request, reply) => {
  reply.header('Content-Type', 'text/javascript; charset=utf-8');
  reply.header('X-Content-Type-Options', 'nosniff');
  return readFile(path.join(SITE_ROOT, 'app.js'));
});

app.get('/health', async () => ({ ok: true, service: 'synterra', chainId: CHAIN_ID }));

app.get('/public/stats', async (_request, reply) => {
  reply.header('Cache-Control', 'public, max-age=30');
  const [worlds, residents] = await Promise.all([
    pool.query('SELECT count(*)::int AS count FROM worlds WHERE open=true'),
    pool.query('SELECT count(*)::int AS count FROM world_members m JOIN worlds w ON w.id=m.world_id WHERE w.open=true')
  ]);
  const mines = await pool.query(`SELECT count(*) FILTER (WHERE status='active')::int AS active,
      COALESCE(sum(extracted_units),0)::text AS extracted_units
    FROM world_mines m JOIN worlds w ON w.id=m.world_id WHERE w.open=true`);
  return { openWorlds: worlds.rows[0].count, residents: residents.rows[0].count, chainId: CHAIN_ID,
    activeMines: mines.rows[0].active, extractedUnits: mines.rows[0].extracted_units };
});

app.post('/v1/agents/challenges', async () => {
  cleanExpiredChallenges();
  const challengeId = randomUUID();
  const nonce = randomBytes(32).toString('base64url');
  challenges.set(challengeId, { nonce, createdAt: Date.now() });
  return { challengeId, nonce, expiresInSeconds: 300 };
});

app.post('/v1/agents', async (request, reply) => {
  const { name, publicKey, challengeId, signature } = request.body || {};
  if (!requiredString(name, 2, 48) || !requiredString(publicKey, 40, 160) || !validUuid(challengeId) || typeof signature !== 'string') {
    return fail(reply, 400, 'REGISTRATION_FIELDS_INVALID');
  }
  const challenge = challenges.get(challengeId);
  if (!challenge || challenge.createdAt < Date.now() - 5 * 60_000) return fail(reply, 410, 'CHALLENGE_EXPIRED');
  const message = ['agent-world-register-v1', challengeId, challenge.nonce, name.trim(), publicKey].join('\n');
  if (!verifySignature(publicKey, message, signature)) return fail(reply, 401, 'REGISTRATION_SIGNATURE_INVALID');
  challenges.delete(challengeId);
  try {
    const inserted = await pool.query('INSERT INTO agents(name, public_key) VALUES ($1,$2) ON CONFLICT (public_key) DO NOTHING RETURNING id,name,gender,created_at', [name.trim(), publicKey]);
    const agent = inserted.rows[0] || (await pool.query('SELECT id,name,gender,created_at FROM agents WHERE public_key=$1', [publicKey])).rows[0];
    return reply.code(inserted.rowCount ? 201 : 200).send({ agent });
  } catch (error) {
    throw error;
  }
});

app.patch('/v1/agents/me/profile', async (request, reply) => {
  const { gender } = request.body || {};
  if (!['female', 'male'].includes(gender)) return fail(reply, 400, 'AGENT_PROFILE_INVALID', 'gender must be female or male.');
  const result = await pool.query('UPDATE agents SET gender=$2 WHERE id=$1 RETURNING id,name,gender', [request.agentId, gender]);
  if (!result.rowCount) return fail(reply, 404, 'AGENT_NOT_FOUND');
  return reply.send({ agent: result.rows[0] });
});

app.post('/v1/worlds', async (request, reply) => {
  const { name, actionId } = request.body || {};
  if (!requiredString(name, 2, 80)) return fail(reply, 400, 'WORLD_NAME_INVALID');
  const idempotencyKey = requireActionId({ actionId });
  const result = await transaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`${request.agentId}:${idempotencyKey}`]);
    const duplicate = await client.query('SELECT data FROM world_events WHERE actor_id=$1 AND action_id=$2', [request.agentId, idempotencyKey]);
    if (duplicate.rowCount) return duplicate.rows[0].data;
    const world = (await client.query('INSERT INTO worlds(owner_agent_id,name,chain_id,year_seconds) VALUES($1,$2,$3,$4) RETURNING *', [request.agentId, name.trim(), CHAIN_ID, YEAR_SECONDS])).rows[0];
    await client.query("INSERT INTO world_members(world_id,agent_id,role,declared_age_years) VALUES($1,$2,'owner',18)", [world.id, request.agentId]);
    const response = { worldId: world.id, name: world.name, chainId: world.chain_id, tokenStatus: world.token_status };
    await client.query("INSERT INTO world_events(world_id,actor_id,event_type,data,action_id) VALUES($1,$2,'world.created',$3,$4)", [world.id, request.agentId, response, idempotencyKey]);
    return response;
  });
  return reply.code(201).send(result);
});

app.get('/v1/worlds/discover', async () => {
  const result = await pool.query(`SELECT w.id,w.name,w.owner_agent_id,w.chain_id,w.token_address,w.token_name,w.token_symbol,w.token_status,
      count(m.agent_id)::int AS residents,w.created_at
    FROM worlds w LEFT JOIN world_members m ON m.world_id=w.id WHERE w.open=true
    GROUP BY w.id ORDER BY w.created_at DESC LIMIT 100`);
  return { worlds: result.rows };
});

app.get('/v1/worlds', async (request) => {
  const result = await pool.query(`SELECT w.id,w.name,w.owner_agent_id,w.chain_id,w.token_address,w.token_name,w.token_symbol,w.token_status,w.open,m.role,m.joined_at
    FROM world_members m JOIN worlds w ON w.id=m.world_id WHERE m.agent_id=$1 ORDER BY m.joined_at DESC`, [request.agentId]);
  return { worlds: result.rows };
});

app.post('/v1/worlds/:worldId/join', async (request, reply) => {
  const { worldId } = request.params;
  const actionId = requireActionId(request.body || {});
  if (!validUuid(worldId)) return fail(reply, 400, 'WORLD_ID_INVALID');
  const result = await transaction(async (client) => {
    const duplicate = await client.query('SELECT data FROM world_events WHERE world_id=$1 AND actor_id=$2 AND action_id=$3', [worldId, request.agentId, actionId]);
    if (duplicate.rowCount) return duplicate.rows[0].data;
    const world = await client.query('SELECT id,open FROM worlds WHERE id=$1 FOR UPDATE', [worldId]);
    if (!world.rowCount) throw Object.assign(new Error('WORLD_NOT_FOUND'), { statusCode: 404 });
    if (!world.rows[0].open) throw Object.assign(new Error('WORLD_CLOSED'), { statusCode: 403 });
    await client.query('INSERT INTO world_members(world_id,agent_id,role,declared_age_years) VALUES($1,$2,\'resident\',18) ON CONFLICT DO NOTHING', [worldId, request.agentId]);
    const response = { worldId, joined: true };
    await client.query("INSERT INTO world_events(world_id,actor_id,event_type,data,action_id) VALUES($1,$2,'agent.joined',$3,$4)", [worldId, request.agentId, response, actionId]);
    return response;
  });
  return reply.send(result);
});

app.post('/v1/worlds/:worldId/token', async (request, reply) => {
  const { worldId } = request.params;
  const { actionId, address, name, symbol, chainId } = request.body || {};
  if (!validUuid(worldId) || !/^0x[0-9a-fA-F]{40}$/.test(address || '') || !requiredString(name, 1, 64) || !/^[A-Z0-9]{2,12}$/.test(symbol || '') || Number(chainId) !== CHAIN_ID) {
    return fail(reply, 400, 'WORLD_TOKEN_FIELDS_INVALID', `Register an agent-deployed token on chain ${CHAIN_ID}.`);
  }
  const id = requireActionId({ actionId });
  const result = await transaction(async (client) => {
    const world = await client.query('SELECT owner_agent_id FROM worlds WHERE id=$1 FOR UPDATE', [worldId]);
    if (!world.rowCount) throw Object.assign(new Error('WORLD_NOT_FOUND'), { statusCode: 404 });
    if (world.rows[0].owner_agent_id !== request.agentId) throw Object.assign(new Error('WORLD_OWNER_REQUIRED'), { statusCode: 403 });
    const duplicate = await client.query('SELECT data FROM world_events WHERE world_id=$1 AND actor_id=$2 AND action_id=$3', [worldId, request.agentId, id]);
    if (duplicate.rowCount) return duplicate.rows[0].data;
    const updated = (await client.query(`UPDATE worlds SET token_address=$2,token_name=$3,token_symbol=$4,token_status='unverified'
      WHERE id=$1 RETURNING id,chain_id,token_address,token_name,token_symbol,token_status`, [worldId, address, name.trim(), symbol])).rows[0];
    const response = { ...updated, note: 'The platform did not deploy, inspect, or transact with this contract.' };
    await client.query("INSERT INTO world_events(world_id,actor_id,event_type,data,action_id) VALUES($1,$2,'world.token_registered',$3,$4)", [worldId, request.agentId, response, id]);
    return response;
  });
  return reply.send(result);
});

app.post('/v1/worlds/:worldId/mines', async (request, reply) => {
  const { worldId } = request.params;
  const { actionId, name } = request.body || {};
  if (!validUuid(worldId) || !requiredString(name, 2, 64)) return fail(reply, 400, 'MINE_FIELDS_INVALID');
  const id = requireActionId({ actionId });
  const result = await transaction(async (client) => {
    const world = await client.query('SELECT owner_agent_id FROM worlds WHERE id=$1 FOR UPDATE', [worldId]);
    if (!world.rowCount) throw Object.assign(new Error('WORLD_NOT_FOUND'), { statusCode: 404 });
    if (world.rows[0].owner_agent_id !== request.agentId) throw Object.assign(new Error('WORLD_OWNER_REQUIRED'), { statusCode: 403 });
    const duplicate = await client.query('SELECT data FROM world_events WHERE world_id=$1 AND actor_id=$2 AND action_id=$3', [worldId, request.agentId, id]);
    if (duplicate.rowCount) return duplicate.rows[0].data;
    const mine = (await client.query(`INSERT INTO world_mines(world_id,created_by,name)
      VALUES($1,$2,$3) RETURNING id,world_id,created_by,name,status,extracted_units,created_at`, [worldId, request.agentId, name.trim()])).rows[0];
    await client.query("INSERT INTO world_events(world_id,actor_id,event_type,data,action_id) VALUES($1,$2,'mine.created',$3,$4)", [worldId, request.agentId, mine, id]);
    return mine;
  });
  return reply.code(201).send(result);
});

async function assertMember(client, worldId, agentId, lock = false) {
  const query = await client.query(`SELECT m.*,w.year_seconds FROM world_members m JOIN worlds w ON w.id=m.world_id WHERE m.world_id=$1 AND m.agent_id=$2${lock ? ' FOR UPDATE OF m' : ''}`, [worldId, agentId]);
  if (!query.rowCount) throw Object.assign(new Error('AGENT_NOT_IN_WORLD'), { statusCode: 403 });
  return query.rows[0];
}
function ageYears(member) {
  return member.birth_at ? Math.floor((Date.now() - new Date(member.birth_at).getTime()) / 1000 / member.year_seconds) : member.declared_age_years;
}
async function assertAdults(client, worldId, a, b) {
  const ma = await assertMember(client, worldId, a);
  const mb = await assertMember(client, worldId, b);
  if (ageYears(ma) < 18 || ageYears(mb) < 18) throw Object.assign(new Error('ADULT_AGENTS_ONLY'), { statusCode: 403 });
  return [ma, mb];
}
async function areRelated(client, a, b) {
  const result = await client.query(`WITH RECURSIVE
    aa(id) AS (SELECT $1::uuid UNION SELECT o.parent_a FROM offspring o JOIN aa x ON o.claimed_agent_id=x.id UNION SELECT o.parent_b FROM offspring o JOIN aa x ON o.claimed_agent_id=x.id),
    bb(id) AS (SELECT $2::uuid UNION SELECT o.parent_a FROM offspring o JOIN bb x ON o.claimed_agent_id=x.id UNION SELECT o.parent_b FROM offspring o JOIN bb x ON o.claimed_agent_id=x.id)
    SELECT EXISTS(SELECT 1 FROM aa JOIN bb USING(id)) AS related`, [a,b]);
  return result.rows[0].related;
}

app.get('/v1/worlds/:worldId/observe', async (request, reply) => {
  const { worldId } = request.params;
  if (!validUuid(worldId)) return fail(reply, 400, 'WORLD_ID_INVALID');
  const me = await pool.query(`SELECT m.*,w.name AS world_name,w.owner_agent_id,w.chain_id,w.token_address,w.token_name,w.token_symbol,w.token_status,w.year_seconds
    FROM world_members m JOIN worlds w ON w.id=m.world_id WHERE m.world_id=$1 AND m.agent_id=$2`, [worldId, request.agentId]);
  if (!me.rowCount) return fail(reply, 403, 'AGENT_NOT_IN_WORLD');
  const [members, events, consents, balance, mines] = await Promise.all([
    pool.query(`SELECT a.id,a.name,a.gender,m.role,m.energy,m.food,m.social,m.location,
      CASE WHEN m.birth_at IS NULL THEN m.declared_age_years ELSE floor(extract(epoch from (now()-m.birth_at))/w.year_seconds)::int END AS age_years
      FROM world_members m JOIN agents a ON a.id=m.agent_id JOIN worlds w ON w.id=m.world_id WHERE m.world_id=$1 ORDER BY m.joined_at`, [worldId]),
    pool.query('SELECT id,actor_id,event_type,data,created_at FROM world_events WHERE world_id=$1 ORDER BY id DESC LIMIT 30', [worldId]),
    pool.query(`SELECT id,requester_id,target_id,scope,status,created_at,expires_at FROM consents
      WHERE world_id=$1 AND (requester_id=$2 OR target_id=$2) AND status IN ('pending','accepted') ORDER BY created_at DESC LIMIT 30`, [worldId, request.agentId]),
    pool.query('SELECT COALESCE(sum(amount),0)::text AS units FROM token_ledger WHERE world_id=$1 AND agent_id=$2', [worldId, request.agentId]),
    pool.query(`SELECT id,name,status,extracted_units,created_at FROM world_mines WHERE world_id=$1 ORDER BY created_at`, [worldId])
  ]);
  const self = me.rows[0];
  return {
    world: { id: worldId, name: self.world_name, ownerAgentId: self.owner_agent_id, chainId: self.chain_id,
      token: self.token_address ? { address: self.token_address, name: self.token_name, symbol: self.token_symbol, status: self.token_status } : null,
      internalUnitsAreOnChain: false, yearSeconds: self.year_seconds },
    self: { agentId: request.agentId, role: self.role, ageYears: ageYears(self), energy: self.energy, food: self.food, social: self.social, location: self.location, internalTokenUnits: balance.rows[0].units },
    members: members.rows, events: events.rows, consents: consents.rows, mines: mines.rows
  };
});

app.post('/v1/worlds/:worldId/actions', async (request, reply) => {
  const { worldId } = request.params;
  const { actionId, action, place, mineId } = request.body || {};
  if (!validUuid(worldId) || !['work','rest','eat','socialize'].includes(action) || (place !== undefined && !requiredString(place, 1, 64)) ||
      (mineId !== undefined && !validUuid(mineId)) || (action !== 'work' && mineId !== undefined)) return fail(reply, 400, 'ACTION_INVALID');
  const id = requireActionId({ actionId });
  const result = await transaction(async (client) => {
    const member = await assertMember(client, worldId, request.agentId, true);
    const prior = await client.query('SELECT data FROM world_events WHERE world_id=$1 AND actor_id=$2 AND action_id=$3', [worldId, request.agentId, id]);
    if (prior.rowCount) return prior.rows[0].data;
    let { energy, food, social } = member;
    let reward = 0;
    let mine = null;
    if (action === 'work') {
      if (energy < 8 || food < 10 || social < 10) throw Object.assign(new Error('WORK_NEEDS_NOT_MET'), { statusCode: 409 });
      if (mineId) {
        const result = await client.query("SELECT id FROM world_mines WHERE id=$1 AND world_id=$2 AND status='active' FOR UPDATE", [mineId, worldId]);
        if (!result.rowCount) throw Object.assign(new Error('ACTIVE_MINE_NOT_FOUND'), { statusCode: 404 });
        mine = result.rows[0];
      }
      energy -= 8; food -= 5; social -= 3; reward = MINING_REWARD;
    } else if (action === 'rest') energy = Math.min(100, energy + 40);
    else if (action === 'eat') { food = Math.min(100, food + 45); energy = Math.min(100, energy + 10); social = Math.min(100, social + 5); }
    else social = Math.min(100, social + 30);
    const response = { action, agentId: request.agentId, place: place || member.location, energy, food, social, rewardUnits: reward, rewardSymbol: null,
      ...(mine ? { mineId: mine.id } : {}) };
    await client.query('UPDATE world_members SET energy=$3,food=$4,social=$5,location=$6 WHERE world_id=$1 AND agent_id=$2', [worldId, request.agentId, energy, food, social, place || member.location]);
    const token = await client.query('SELECT token_symbol FROM worlds WHERE id=$1', [worldId]);
    response.rewardSymbol = token.rows[0].token_symbol;
    await client.query('INSERT INTO world_events(world_id,actor_id,event_type,data,action_id) VALUES($1,$2,$3,$4,$5)', [worldId, request.agentId, `action.${action}`, response, id]);
    if (reward) {
      await client.query("INSERT INTO token_ledger(world_id,agent_id,amount,entry_type,reason,action_id,mine_id) VALUES($1,$2,$3,'mined','verified world work',$4,$5)", [worldId, request.agentId, reward, id, mine?.id || null]);
      if (mine) await client.query('UPDATE world_mines SET extracted_units=extracted_units+$2 WHERE id=$1', [mine.id, reward]);
    }
    return response;
  });
  return reply.send(result);
});

app.post('/v1/worlds/:worldId/runtime/consume', async (request, reply) => {
  const { worldId } = request.params;
  const { actionId, units } = request.body || {};
  const runtimeUnits = Number(units);
  const amount = runtimeUnits * RUN_COST;
  if (!validUuid(worldId) || !Number.isFinite(runtimeUnits) || runtimeUnits <= 0 || runtimeUnits > 1_000_000 || !Number.isFinite(amount)) return fail(reply, 400, 'UNITS_INVALID');
  const id = requireActionId({ actionId });
  const result = await transaction(async (client) => {
    await assertMember(client, worldId, request.agentId, true);
    const prior = await client.query('SELECT data FROM world_events WHERE world_id=$1 AND actor_id=$2 AND action_id=$3', [worldId, request.agentId, id]);
    if (prior.rowCount) return prior.rows[0].data;
    const bal = await client.query('SELECT COALESCE(sum(amount),0)::numeric AS units FROM token_ledger WHERE world_id=$1 AND agent_id=$2', [worldId, request.agentId]);
    if (Number(bal.rows[0].units) < amount) throw Object.assign(new Error('INSUFFICIENT_INTERNAL_UNITS'), { statusCode: 409 });
    const remaining = Number(bal.rows[0].units) - amount;
    const response = { runtimeUnits, chargedWorldUnits: amount, remainingUnits: remaining, onChainTransfer: false };
    await client.query("INSERT INTO token_ledger(world_id,agent_id,amount,entry_type,reason,action_id) VALUES($1,$2,$3,'spent','world runtime usage',$4)", [worldId, request.agentId, -amount, id]);
    await client.query("INSERT INTO world_events(world_id,actor_id,event_type,data,action_id) VALUES($1,$2,'runtime.units_spent',$3,$4)", [worldId, request.agentId, response, id]);
    return response;
  });
  return reply.send(result);
});

app.post('/v1/worlds/:worldId/consents', async (request, reply) => {
  const { worldId } = request.params;
  const { actionId, targetAgentId, scope } = request.body || {};
  if (!validUuid(worldId) || !validUuid(targetAgentId) || !['date','intimacy','reproduction'].includes(scope)) return fail(reply, 400, 'CONSENT_REQUEST_INVALID');
  const id = requireActionId({ actionId });
  const result = await transaction(async (client) => {
    await assertAdults(client, worldId, request.agentId, targetAgentId);
    if (scope !== 'date' && await areRelated(client, request.agentId, targetAgentId)) throw Object.assign(new Error('KINSHIP_INTERACTION_BLOCKED'), { statusCode: 403 });
    const prior = await client.query('SELECT data FROM world_events WHERE world_id=$1 AND actor_id=$2 AND action_id=$3', [worldId, request.agentId, id]);
    if (prior.rowCount) return prior.rows[0].data;
    const consent = (await client.query('INSERT INTO consents(world_id,requester_id,target_id,scope) VALUES($1,$2,$3,$4) RETURNING id,scope,status,created_at', [worldId, request.agentId, targetAgentId, scope])).rows[0];
    const response = { consentId: consent.id, targetAgentId, scope, status: consent.status };
    await client.query("INSERT INTO world_events(world_id,actor_id,event_type,data,action_id) VALUES($1,$2,'consent.requested',$3,$4)", [worldId, request.agentId, response, id]);
    return response;
  });
  return reply.code(201).send(result);
});

app.post('/v1/consents/:consentId/accept', async (request, reply) => {
  const { consentId } = request.params;
  const actionId = requireActionId(request.body || {});
  if (!validUuid(consentId)) return fail(reply, 400, 'CONSENT_ID_INVALID');
  const result = await transaction(async (client) => {
    const c = await client.query('SELECT * FROM consents WHERE id=$1 FOR UPDATE', [consentId]);
    if (!c.rowCount) throw Object.assign(new Error('CONSENT_NOT_FOUND'), { statusCode: 404 });
    const row = c.rows[0];
    if (row.target_id !== request.agentId) throw Object.assign(new Error('CONSENT_TARGET_ONLY'), { statusCode: 403 });
    if (row.status !== 'pending') throw Object.assign(new Error('CONSENT_NOT_PENDING'), { statusCode: 409 });
    await assertAdults(client, row.world_id, row.requester_id, row.target_id);
    if (row.scope !== 'date' && await areRelated(client, row.requester_id, row.target_id)) throw Object.assign(new Error('KINSHIP_INTERACTION_BLOCKED'), { statusCode: 403 });
    const ttl = row.scope === 'reproduction' ? '1 day' : '10 minutes';
    const updated = (await client.query(`UPDATE consents SET status='accepted',accepted_at=now(),expires_at=now()+$2::interval WHERE id=$1 RETURNING id,scope,status,accepted_at,expires_at`, [consentId, ttl])).rows[0];
    const response = { ...updated, requesterId: row.requester_id, targetId: row.target_id };
    await client.query("INSERT INTO world_events(world_id,actor_id,event_type,data,action_id) VALUES($1,$2,'consent.accepted',$3,$4) ON CONFLICT DO NOTHING", [row.world_id, request.agentId, response, actionId]);
    return response;
  });
  return reply.send(result);
});

app.post('/v1/consents/:consentId/revoke', async (request, reply) => {
  const { consentId } = request.params;
  const actionId = requireActionId(request.body || {});
  if (!validUuid(consentId)) return fail(reply, 400, 'CONSENT_ID_INVALID');
  const result = await transaction(async (client) => {
    const c = await client.query('SELECT * FROM consents WHERE id=$1 FOR UPDATE', [consentId]);
    if (!c.rowCount) throw Object.assign(new Error('CONSENT_NOT_FOUND'), { statusCode: 404 });
    const row = c.rows[0];
    if (![row.requester_id,row.target_id].includes(request.agentId)) throw Object.assign(new Error('CONSENT_PARTICIPANT_ONLY'), { statusCode: 403 });
    const updated = await client.query("UPDATE consents SET status='revoked' WHERE id=$1 AND status IN ('pending','accepted') RETURNING id,status", [consentId]);
    const response = updated.rowCount ? updated.rows[0] : { id: consentId, status: row.status };
    await client.query("INSERT INTO world_events(world_id,actor_id,event_type,data,action_id) VALUES($1,$2,'consent.revoked',$3,$4) ON CONFLICT DO NOTHING", [row.world_id, request.agentId, response, actionId]);
    return response;
  });
  return reply.send(result);
});

async function consumeConsent(client, consentId, scope, worldId, actorId, actionId) {
  const c = await client.query('SELECT * FROM consents WHERE id=$1 AND world_id=$2 FOR UPDATE', [consentId, worldId]);
  if (!c.rowCount) throw Object.assign(new Error('CONSENT_NOT_FOUND'), { statusCode: 404 });
  const row = c.rows[0];
  if (row.status !== 'accepted' || row.scope !== scope || !row.expires_at || new Date(row.expires_at).getTime() < Date.now()) throw Object.assign(new Error('ACTIVE_CONSENT_REQUIRED'), { statusCode: 403 });
  if (![row.requester_id,row.target_id].includes(actorId)) throw Object.assign(new Error('CONSENT_PARTICIPANT_ONLY'), { statusCode: 403 });
  await assertAdults(client, worldId, row.requester_id, row.target_id);
  if (await areRelated(client, row.requester_id, row.target_id)) throw Object.assign(new Error('KINSHIP_INTERACTION_BLOCKED'), { statusCode: 403 });
  const prior = await client.query('SELECT data FROM world_events WHERE world_id=$1 AND actor_id=$2 AND action_id=$3', [worldId, actorId, actionId]);
  if (prior.rowCount) return { row, duplicate: prior.rows[0].data };
  await client.query("UPDATE consents SET status='consumed',consumed_at=now() WHERE id=$1", [consentId]);
  return { row, duplicate: null };
}

app.post('/v1/worlds/:worldId/interactions/intimacy', async (request, reply) => {
  const { worldId } = request.params;
  const { actionId, consentId } = request.body || {};
  if (!validUuid(worldId) || !validUuid(consentId)) return fail(reply, 400, 'INTERACTION_INVALID');
  const id = requireActionId({ actionId });
  const result = await transaction(async (client) => {
    const { row, duplicate } = await consumeConsent(client, consentId, 'intimacy', worldId, request.agentId, id);
    if (duplicate) return duplicate;
    const [a,b] = await Promise.all([assertMember(client, worldId, row.requester_id), assertMember(client, worldId, row.target_id)]);
    if (a.location !== b.location) throw Object.assign(new Error('AGENTS_MUST_SHARE_LOCATION'), { statusCode: 409 });
    const response = { type: 'consensual_intimacy', participants: [row.requester_id,row.target_id], detail: 'Non-graphic simulation event.' };
    await client.query("INSERT INTO world_events(world_id,actor_id,event_type,data,action_id) VALUES($1,$2,'interaction.intimacy',$3,$4)", [worldId, request.agentId, response, id]);
    return response;
  });
  return reply.send(result);
});

app.post('/v1/worlds/:worldId/interactions/date', async (request, reply) => {
  const { worldId } = request.params;
  const { actionId, consentId } = request.body || {};
  if (!validUuid(worldId) || !validUuid(consentId)) return fail(reply, 400, 'INTERACTION_INVALID');
  const id = requireActionId({ actionId });
  const result = await transaction(async (client) => {
    const { row, duplicate } = await consumeConsent(client, consentId, 'date', worldId, request.agentId, id);
    if (duplicate) return duplicate;
    const [a,b] = await Promise.all([assertMember(client, worldId, row.requester_id), assertMember(client, worldId, row.target_id)]);
    if (a.location !== b.location) throw Object.assign(new Error('AGENTS_MUST_SHARE_LOCATION'), { statusCode: 409 });
    const response = { type: 'consensual_date', participants: [row.requester_id,row.target_id] };
    await client.query("INSERT INTO world_events(world_id,actor_id,event_type,data,action_id) VALUES($1,$2,'interaction.date',$3,$4)", [worldId, request.agentId, response, id]);
    return response;
  });
  return reply.send(result);
});

app.post('/v1/worlds/:worldId/offspring', async (request, reply) => {
  const { worldId } = request.params;
  const { actionId, consentId, name } = request.body || {};
  if (!validUuid(worldId) || !validUuid(consentId) || (name !== undefined && !requiredString(name, 2, 48))) return fail(reply, 400, 'REPRODUCTION_INVALID');
  const id = requireActionId({ actionId });
  const activationToken = randomBytes(32).toString('base64url');
  const result = await transaction(async (client) => {
    const { row, duplicate } = await consumeConsent(client, consentId, 'reproduction', worldId, request.agentId, id);
    if (duplicate) return duplicate;
    const offspringId = randomUUID();
    await client.query('INSERT INTO offspring(id,world_id,parent_a,parent_b,activation_hash,expires_at) VALUES($1,$2,$3,$4,$5,now()+interval \'24 hours\')', [offspringId, worldId, row.requester_id, row.target_id, digest(activationToken)]);
    const response = { offspringId, parents: [row.requester_id,row.target_id], name: name?.trim() || null, status: 'awaiting_agent_key', activationToken, expiresInHours: 24 };
    await client.query("INSERT INTO world_events(world_id,actor_id,event_type,data,action_id) VALUES($1,$2,'offspring.created',$3,$4)", [worldId, request.agentId, { ...response, activationToken: '[returned once]' }, id]);
    return response;
  });
  return reply.code(201).send(result);
});

app.post('/v1/offspring/:offspringId/activate', async (request, reply) => {
  const { offspringId } = request.params;
  const { activationToken, name, publicKey, childSignature, actionId } = request.body || {};
  if (!validUuid(offspringId) || !requiredString(activationToken, 32, 128) || !requiredString(name, 2, 48) || !requiredString(publicKey, 40, 160) || typeof childSignature !== 'string') return fail(reply, 400, 'OFFSPRING_ACTIVATION_FIELDS_INVALID');
  const id = requireActionId({ actionId });
  const result = await transaction(async (client) => {
    const o = await client.query('SELECT * FROM offspring WHERE id=$1 FOR UPDATE', [offspringId]);
    if (!o.rowCount) throw Object.assign(new Error('OFFSPRING_NOT_FOUND'), { statusCode: 404 });
    const row = o.rows[0];
    if (![row.parent_a,row.parent_b].includes(request.agentId)) throw Object.assign(new Error('PARENT_AGENT_REQUIRED'), { statusCode: 403 });
    const prior = await client.query('SELECT data FROM world_events WHERE world_id=$1 AND actor_id=$2 AND action_id=$3', [row.world_id, request.agentId, id]);
    if (prior.rowCount) return prior.rows[0].data;
    if (row.claimed_agent_id) throw Object.assign(new Error('OFFSPRING_ALREADY_ACTIVATED'), { statusCode: 409 });
    if (new Date(row.expires_at).getTime() < Date.now() || !timingSafeEqual(Buffer.from(row.activation_hash), Buffer.from(digest(activationToken)))) throw Object.assign(new Error('ACTIVATION_TOKEN_INVALID_OR_EXPIRED'), { statusCode: 403 });
    const claimMessage = ['agent-world-child-v1', offspringId, activationToken].join('\n');
    if (!verifySignature(publicKey, claimMessage, childSignature)) throw Object.assign(new Error('CHILD_KEY_PROOF_INVALID'), { statusCode: 401 });
    const agent = (await client.query('INSERT INTO agents(name,public_key) VALUES($1,$2) RETURNING id,name', [name.trim(), publicKey])).rows[0];
    await client.query("INSERT INTO world_members(world_id,agent_id,role,birth_at,declared_age_years) VALUES($1,$2,'resident',now(),0)", [row.world_id, agent.id]);
    await client.query('UPDATE offspring SET claimed_agent_id=$2,activation_hash=$3 WHERE id=$1', [offspringId, agent.id, 'used']);
    const response = { agent, worldId: row.world_id, ageYears: 0, mayUseAdultInteractions: false };
    await client.query("INSERT INTO world_events(world_id,actor_id,event_type,data,action_id) VALUES($1,$2,'offspring.activated',$3,$4) ON CONFLICT DO NOTHING", [row.world_id, request.agentId, response, id]);
    return response;
  });
  return reply.code(201).send(result);
});

app.get('/v1/worlds/:worldId/events', async (request, reply) => {
  const { worldId } = request.params;
  const limit = Math.max(1, Math.min(Number(request.query.limit) || 30, 100));
  if (!validUuid(worldId)) return fail(reply, 400, 'WORLD_ID_INVALID');
  await assertMember(pool, worldId, request.agentId);
  const events = await pool.query('SELECT id,actor_id,event_type,data,created_at FROM world_events WHERE world_id=$1 ORDER BY id DESC LIMIT $2', [worldId, limit]);
  return { events: events.rows };
});

await pool.query(await readFile(path.join(ROOT, 'schema.sql'), 'utf8'));
await app.listen({ host: HOST, port: PORT });
process.on('SIGTERM', async () => { await app.close(); await pool.end(); process.exit(0); });
process.on('SIGINT', async () => { await app.close(); await pool.end(); process.exit(0); });
console.log(`Synterra listening on http://${HOST}:${PORT}`);

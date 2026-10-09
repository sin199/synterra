import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createResidentDetailHandler } from '../src/resident-detail-route.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const worldId = 'ce434421-8bcd-4aac-b9ba-183383c713de';
const residentId = 'b5d7a746-3701-4d77-a7d9-11f17f622afe';
const unknownResidentId = 'a1b2c3d4-e5f6-4a7b-8c9d-0123456789ab';

function createHarness({ resident = null } = {}) {
  const queries = [];
  const pool = {
    async query(sql, values) {
      queries.push({ sql, values });
      if (sql.includes('SELECT id FROM worlds WHERE open=true')) {
        return { rows: [{ id: worldId }], rowCount: 1 };
      }
      if (sql.includes('FROM world_members m JOIN agents a') && sql.includes('AS "primaryGoal"')) {
        return { rows: resident ? [resident] : [], rowCount: resident ? 1 : 0 };
      }
      if (sql.includes('AS agreements') && sql.includes('AS "recentNegotiations"')) {
        return { rows: [{ agreements: [], commitments: [], reputation: null,
          organizationRoles: [], recentNegotiations: [] }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }
  };
  const app = Fastify();
  const fail = (reply, status, error) => reply.code(status).send({ error });
  app.get('/local/map-data/residents/:agentId', createResidentDetailHandler({
    pool,
    host: '127.0.0.1',
    validUuid: (value) => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value),
    fail
  }));
  return { app, queries };
}

test('valid UUID returns the existing resident detail response', async (t) => {
  const resident = { id: residentId, name: 'A resident', primaryGoal: 'learn' };
  const { app, queries } = createHarness({ resident });
  t.after(() => app.close());

  const response = await app.inject({ method: 'GET', url: `/local/map-data/residents/${residentId}` });

  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.deepEqual(body.resident, resident);
  assert.deepEqual(body.skills, []);
  assert.equal(body.economy.netWorthUsd, '0.00000000');
  assert.ok(queries.some(({ sql, values }) => sql.includes('FROM world_members m JOIN agents a') && values[1] === residentId));
});

test('unknown valid UUID returns 404', async (t) => {
  const { app } = createHarness();
  t.after(() => app.close());

  const response = await app.inject({ method: 'GET', url: `/local/map-data/residents/${unknownResidentId}` });

  assert.equal(response.statusCode, 404);
  assert.deepEqual(response.json(), { error: 'RESIDENT_NOT_FOUND' });
});

test('malformed UUID returns 400 before querying the database', async (t) => {
  const { app, queries } = createHarness();
  t.after(() => app.close());

  const response = await app.inject({ method: 'GET', url: '/local/map-data/residents/not-a-uuid' });

  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.json(), { error: 'AGENT_ID_INVALID' });
  assert.equal(queries.length, 0);
});

test('resident participation SQL types the parameter instead of casting UUID columns to text', async () => {
  const sql = await readFile(path.join(root, 'src/resident-detail-route.js'), 'utf8');
  const participationSql = sql.slice(sql.indexOf('SELECT entity.id'), sql.indexOf('ORDER BY entity.created_world_minute'));

  assert.match(participationSql, /participant\.participant_id=\(\$2::uuid\)::text/);
  assert.match(participationSql, /entity\.creator_agent_id=\$2::uuid/);
  assert.doesNotMatch(participationSql, /(?:participant_id|creator_agent_id)::text/);
  assert.doesNotMatch(participationSql, /(?:participant\.participant_id|entity\.creator_agent_id)=\$2(?:\s|\)|$)/);
  assert.doesNotMatch(participationSql, /uuid\s*=\s*text/i);
});

test('the existing map-data route remains registered ahead of the resident detail route', async () => {
  const server = await readFile(path.join(root, 'src/server.js'), 'utf8');
  const mapRoute = server.indexOf("app.get('/local/map-data',");
  const detailRoute = server.indexOf("app.get('/local/map-data/residents/:agentId',");

  assert.notEqual(mapRoute, -1);
  assert.notEqual(detailRoute, -1);
  assert.ok(mapRoute < detailRoute);
});

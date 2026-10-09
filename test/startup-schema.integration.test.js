import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { Pool } from 'pg';
import { prepareStartupSchema } from '../src/startup-schema.js';
import { applyWorldSchemaAndMigrations } from '../src/database-migrations.js';
import { startWorldEngine } from '../src/world-engine.js';
import { arcNetworkConfig } from '../src/arc/config.js';

const databaseUrl = process.env.SYNTERRA_SCHEMA_TEST_DATABASE_URL;
const enabled = process.env.SYNTERRA_SCHEMA_TEST_ISOLATED === '1' && Boolean(databaseUrl);
const rootDirectory = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const quote = (name) => '"' + name.replaceAll('"', '""') + '"';
const oldEquivalentHistoryConstraint = `CHECK (entity_type ~ '^[a-z][a-z0-9_.-]{1,79}$'::text OR
  (entity_type = ANY (ARRAY['opportunity'::text, 'project'::text, 'organization'::text, 'place'::text,
    'cooperation'::text, 'world'::text, 'business'::text, 'job'::text, 'order'::text,
    'agreement'::text, 'norm'::text, 'capability'::text, 'capability_proposal'::text, 'agent_goal'::text])))`;

async function snapshot(client) {
  const tables = (await client.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows;
  const data = {};
  for (const { tablename } of tables) {
    const rows = (await client.query(`SELECT xmin::text AS version,to_jsonb(t) AS data FROM public.${quote(tablename)} t`)).rows;
    data[tablename] = createHash('sha256').update(rows.map(row => JSON.stringify(row)).sort().join('\n')).digest('hex');
  }
  const triggers = (await client.query(`SELECT t.oid,t.xmin::text,pg_get_triggerdef(t.oid) AS definition
    FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' ORDER BY t.oid`)).rows;
  const columns = (await client.query(`SELECT c.relname,a.attname,a.atttypid,a.atttypmod,a.attnotnull,
      pg_get_expr(d.adbin,d.adrelid) AS default_expression
    FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
    WHERE n.nspname='public' AND a.attnum>0 AND NOT a.attisdropped ORDER BY c.relname,a.attnum`)).rows;
  return { data, triggers, columns };
}

function serverFailure(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['src/server.js'], { cwd: rootDirectory, env, stdio: ['ignore','pipe','pipe'] });
    let output = '';
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { output += data; });
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('invalid schema server did not exit')); }, 10_000);
    child.on('error', reject);
    child.on('exit', code => { clearTimeout(timer); resolve({ code, output }); });
  });
}

test('startup schema apply/validate and fail-closed checks on isolated PostgreSQL', { skip: !enabled, timeout: 120_000 }, async (t) => {
  const url = new URL(databaseUrl);
  assert.ok(['localhost','127.0.0.1','::1'].includes(url.hostname));
  assert.ok(url.port && url.port !== '5432');
  assert.ok(url.pathname.endsWith('_test'));
  assert.ok(process.env.SYNTERRA_STATE_DIR, 'requires independent runtime directory');
  const pool = new Pool({ connectionString: databaseUrl });
  let engine;
  try {
    const hadLedger = (await pool.query("SELECT to_regclass('public.synterra_schema_migrations') AS name")).rows[0].name;
    await t.test('apply retains baseline bootstrap and does not apply numbered migrations', async () => {
      const applied = await prepareStartupSchema(pool, { rootDirectory, mode: 'apply' });
      assert.equal(applied.mode, 'apply');
      if (!hadLedger) assert.equal((await pool.query("SELECT to_regclass('public.synterra_schema_migrations') AS name")).rows[0].name, null);
      assert.ok((await pool.query("SELECT to_regclass('public.world_agent_states') AS table_name")).rows[0].table_name);
    });
    await applyWorldSchemaAndMigrations(pool, { rootDirectory });
    // Fixture-only read grants; production validation never grants anything.
    await pool.query('GRANT SELECT ON ALL TABLES IN SCHEMA public TO synterra_app');
    await pool.query(`GRANT INSERT,UPDATE ON world_runtime_state,world_agent_states,world_social_profiles,
      world_agent_goals,world_agent_self_models,world_agent_decision_policies,world_epochs,agent_memories TO synterra_app`);
    await pool.query(`GRANT INSERT ON world_events,world_history,world_decision_traces,world_v7_events,
      world_capability_events,world_agent_self_model_history TO synterra_app`);
    await pool.query('GRANT DELETE ON agent_memories,world_decision_traces TO synterra_app');
    await pool.query('GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO synterra_app');
    const worldId = randomUUID();
    const ownerId = randomUUID();
    await pool.query('INSERT INTO agents(id,name,public_key) VALUES($1,$2,$3)', [ownerId,'Schema Fixture',ownerId]);
    await pool.query('INSERT INTO worlds(id,owner_agent_id,name) VALUES($1,$2,$3)', [worldId,ownerId,'Schema Fixture']);
    await pool.query(`INSERT INTO world_economic_accounts(world_id,account_type,account_key,asset_symbol,balance)
      VALUES($1,'system','system:schema-test','USDC',123)`, [worldId]);
    const account = (await pool.query("SELECT id FROM world_economic_accounts WHERE world_id=$1", [worldId])).rows[0];
    // Deliberately retain a balance different from postings: bootstrap normalization would change it.
    const peer = (await pool.query(`INSERT INTO world_economic_accounts(world_id,account_type,account_key,asset_symbol,balance)
      VALUES($1,'system','system:schema-peer','USDC',0) RETURNING id`, [worldId])).rows[0];
    const fixture = await pool.connect();
    try {
      await fixture.query('BEGIN');
      const tx = (await fixture.query(`INSERT INTO world_economic_transactions(world_id,action_id,transaction_type,
        source_account_id,destination_account_id,asset_symbol,amount,reason,world_time)
        VALUES($1,'schema-fixture','opening_balance',$2,$3,'USDC',1,'fixture',0) RETURNING id`, [worldId,account.id,peer.id])).rows[0];
      await fixture.query('INSERT INTO world_economic_postings(transaction_id,account_id,amount) VALUES($1,$2,-1),($1,$3,1)',[tx.id,account.id,peer.id]);
      await fixture.query('COMMIT');
    } finally { fixture.release(); }

    await t.test('validate accepts legacy equivalent history constraint and preserves every business row and trigger', async () => {
      await pool.query('ALTER TABLE world_history DROP CONSTRAINT world_history_entity_type_check');
      await pool.query(`ALTER TABLE world_history ADD CONSTRAINT world_history_entity_type_check ${oldEquivalentHistoryConstraint}`);
      const appPool = new Pool({ connectionString: databaseUrl });
      const before = await snapshot(pool);
      const sql = [];
      const guardedPool = { async connect() {
        const client = await appPool.connect();
        await client.query('SET ROLE synterra_app');
        return { release: () => client.release(), query: async (text, values) => {
          sql.push(text);
          assert.match(text.trim(), /^(SELECT|BEGIN .*READ ONLY|SET LOCAL statement_timeout|COMMIT|ROLLBACK)/);
          return client.query(text, values);
        } };
      } };
      try {
        const log = console.log;
        const messages = [];
        console.log = message => messages.push(String(message));
        try { assert.equal((await prepareStartupSchema(guardedPool, { rootDirectory, mode: 'validate' })).validated, true); }
        finally { console.log = log; }
        assert.equal(JSON.parse(messages[0]).migrationValidation, 'passed');
        assert.equal(JSON.parse(messages[0]).checksumValidation, 'passed');
        assert.equal(JSON.parse(messages[0]).requiredObjects, 'passed');
        assert.equal(JSON.parse(messages[0]).runtimeGrants, 'passed');
        assert.equal(JSON.parse(messages[0]).schemaSql, 'not_executed');
        assert.ok(sql[0].includes('READ ONLY'));
        assert.deepEqual(await snapshot(pool), before);
        assert.equal((await pool.query('SELECT balance::text FROM world_economic_accounts WHERE id=$1',[account.id])).rows[0].balance, '123.00000000');
      } finally { await appPool.end(); }
    });

    await t.test('validate rejects a non-equivalent history constraint without altering it', async () => {
      await pool.query('ALTER TABLE world_history DROP CONSTRAINT world_history_entity_type_check');
      await pool.query(`ALTER TABLE world_history ADD CONSTRAINT world_history_entity_type_check CHECK (char_length(entity_type) > 1)`);
      const before = (await pool.query(`SELECT pg_get_constraintdef(oid,true) AS definition FROM pg_constraint
        WHERE conrelid='public.world_history'::regclass AND conname='world_history_entity_type_check'`)).rows[0].definition;
      await assert.rejects(prepareStartupSchema(pool,{rootDirectory,mode:'validate'}), /constraint world_history\.world_history_entity_type_check/);
      const after = (await pool.query(`SELECT pg_get_constraintdef(oid,true) AS definition FROM pg_constraint
        WHERE conrelid='public.world_history'::regclass AND conname='world_history_entity_type_check'`)).rows[0].definition;
      assert.equal(after, before);
      await pool.query('ALTER TABLE world_history DROP CONSTRAINT world_history_entity_type_check');
      await pool.query(`ALTER TABLE world_history ADD CONSTRAINT world_history_entity_type_check ${oldEquivalentHistoryConstraint}`);
    });

    async function rejectMutation(name, sql, reason) {
      await t.test(name, async () => {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          await client.query(sql);
          await client.query('COMMIT');
          await assert.rejects(prepareStartupSchema(pool,{rootDirectory,mode:'validate'}), reason);
        } finally {
          client.release();
          // Test cases are restored by their explicit inverse below, never by validator.
        }
      });
    }
    const ledger = (await pool.query("SELECT * FROM synterra_schema_migrations WHERE version='0003_arc_agent_token_issuance_runtime_privileges.sql'")).rows[0];
    await rejectMutation('missing migration rejects startup', "DELETE FROM synterra_schema_migrations WHERE version='0003_arc_agent_token_issuance_runtime_privileges.sql'", /missing migration/);
    await pool.query('INSERT INTO synterra_schema_migrations(version,checksum,applied_at) VALUES($1,$2,$3)',[ledger.version,ledger.checksum,ledger.applied_at]);
    await rejectMutation('checksum mismatch rejects startup', "UPDATE synterra_schema_migrations SET checksum=repeat('0',64) WHERE version='0003_arc_agent_token_issuance_runtime_privileges.sql'", /checksum mismatch/);
    await pool.query('UPDATE synterra_schema_migrations SET checksum=$1 WHERE version=$2',[ledger.checksum,ledger.version]);
    await rejectMutation('missing environment column rejects startup', 'ALTER TABLE world_agent_states RENAME COLUMN hygiene TO missing_hygiene', /column world_agent_states.hygiene/);
    await pool.query('ALTER TABLE world_agent_states RENAME COLUMN missing_hygiene TO hygiene');
    await rejectMutation('missing constraint rejects startup', 'ALTER TABLE arc_currency_genesis_requirements RENAME CONSTRAINT arc_currency_genesis_requirements_pkey TO missing_requirement_pkey', /constraint arc_currency_genesis_requirements/);
    await pool.query('ALTER TABLE arc_currency_genesis_requirements RENAME CONSTRAINT missing_requirement_pkey TO arc_currency_genesis_requirements_pkey');
    await rejectMutation('missing table rejects startup', 'ALTER TABLE arc_agent_token_uses RENAME TO missing_token_uses', /missing table arc_agent_token_uses/);
    await pool.query('ALTER TABLE missing_token_uses RENAME TO arc_agent_token_uses');
    await rejectMutation('missing runtime UPDATE privilege rejects startup even when SELECT is granted', 'REVOKE UPDATE ON arc_token_issuance_intents FROM synterra_app', /synterra_app UPDATE missing/);
    await pool.query('GRANT UPDATE ON arc_token_issuance_intents TO synterra_app');
    await t.test('invalid mode fails before touching database', async () => {
      await assert.rejects(prepareStartupSchema({}, { rootDirectory, mode: 'skip' }), /must be apply or validate/);
    });
    await t.test('server rejects bad migration before listener or World Engine writes', async () => {
      await pool.query('UPDATE synterra_schema_migrations SET checksum=$1 WHERE version=$2',['0'.repeat(64),ledger.version]);
      const before = await snapshot(pool);
      const env = { PATH: process.env.PATH, PGUSER: (await pool.query('SELECT current_user AS name')).rows[0].name, DATABASE_URL: databaseUrl, PORT: '0', HOST: '127.0.0.1',
        SYNTERRA_SCHEMA_MODE: 'validate', SYNTERRA_STATE_DIR: process.env.SYNTERRA_STATE_DIR };
      const failed = await serverFailure(env);
      assert.notEqual(failed.code, 0);
      assert.match(failed.output, /checksum mismatch/);
      assert.doesNotMatch(failed.output, /Synterra listening/);
      assert.deepEqual(await snapshot(pool), before);
      await pool.query('UPDATE synterra_schema_migrations SET checksum=$1 WHERE version=$2',[ledger.checksum,ledger.version]);
    });
    await t.test('validated schema permits World Engine startup and closed gate remains unchanged', async () => {
      assert.equal((await prepareStartupSchema(pool,{rootDirectory,mode:'validate'})).validated,true);
      await pool.query(`INSERT INTO world_members(world_id,agent_id,role,location) VALUES($1,$2,'owner','home')`,[worldId,ownerId]);
      engine = await startWorldEngine(pool,{worldId,schedule:false,currencyGenesisEnabled:true,emergencySink:{write(){}}});
      assert.equal(engine.running,true);
      assert.equal(engine.worldLockOwned,true);
      assert.equal(arcNetworkConfig({}).writesEnabled,false);
      assert.equal((await pool.query('SELECT count(*)::int AS count FROM arc_token_issuance_intents WHERE world_id=$1',[worldId])).rows[0].count,0);
      await engine.stop(); engine=null;
    });
  } finally { await engine?.stop(); await pool.end(); }
});

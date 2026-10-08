import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Pool } from 'pg';
import { applyWorldSchemaAndMigrations, readWorldMigrationPlan } from '../src/database-migrations.js';

const databaseUrl = process.env.SYNTERRA_PRIVILEGE_TEST_DATABASE_URL;
const enabled = process.env.SYNTERRA_PRIVILEGE_TEST_ISOLATED === '1' && Boolean(databaseUrl);
const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FORMAL_WORLD_ID = 'ce434421-8bcd-4aac-b9ba-183383c713de';
const ARC_ISSUANCE_TABLES = [
  'arc_currency_genesis_requirements',
  'arc_token_pilot_capabilities',
  'arc_token_issuance_intents',
  'arc_token_issuance_responses',
  'arc_token_issuance_decisions',
  'arc_token_issuance_issuer_candidates',
  'arc_agent_tokens',
  'arc_agent_token_responses',
  'arc_agent_token_uses',
  'arc_mainnet_pilot_budget',
  'arc_mainnet_pilot_cost_reservations',
  'arc_infrastructure_nonce_cursors',
  'arc_infrastructure_nonce_reservations'
];

function assertIsolatedDatabase(connectionString) {
  const parsed = new URL(connectionString);
  assert.ok(['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname),
    'runtime privilege test requires loopback PostgreSQL');
  assert.notEqual(parsed.port, '5432', 'runtime privilege test must not use the formal/default PostgreSQL port');
  assert.ok(decodeURIComponent(parsed.pathname.slice(1)).endsWith('_test'),
    'runtime privilege test requires a *_test database');
}

test('0003 grants synterra_app only runtime Arc issuance table privileges on an isolated restore', {
  skip: !enabled,
  timeout: 120_000
}, async () => {
  assertIsolatedDatabase(databaseUrl);
  const pool = new Pool({ connectionString: databaseUrl, max: 2 });
  const client = await pool.connect();
  const worldId = randomUUID();
  const proposerId = randomUUID();
  const issuerId = randomUUID();
  const actionId = `privilege-test-${randomUUID()}`;
  try {
    const roleExists = await client.query("SELECT 1 FROM pg_roles WHERE rolname='synterra_app'");
    if (!roleExists.rowCount) await client.query('CREATE ROLE synterra_app NOLOGIN');
    const v6ProposalsBefore = await client.query(`SELECT count(*)::int AS count
      FROM world_capability_proposals WHERE world_id=$1`, [FORMAL_WORLD_ID]);
    await applyWorldSchemaAndMigrations(pool, { rootDirectory: repoRoot });

    const plan = await readWorldMigrationPlan(repoRoot);
    const expectedMigration = plan.find((migration) => migration.name === '0003_arc_agent_token_issuance_runtime_privileges.sql');
    assert.ok(expectedMigration, 'the incremental privilege migration is present');
    const ledger = await client.query(`SELECT checksum FROM synterra_schema_migrations
      WHERE version=$1`, [expectedMigration.name]);
    assert.equal(ledger.rows[0]?.checksum, expectedMigration.checksum,
      '0003 was applied and ledgered with its source checksum');

    const role = await client.query(`SELECT rolsuper,rolcreaterole,rolcreatedb FROM pg_roles WHERE rolname='synterra_app'`);
    assert.equal(role.rows[0].rolsuper, false, 'the runtime role is not a superuser');
    assert.equal(role.rows[0].rolcreaterole, false, 'the runtime role cannot create roles');
    assert.equal(role.rows[0].rolcreatedb, false, 'the runtime role cannot create databases');

    const formalState = await client.query(`SELECT requirement.world_id::text AS world_id,
        requirement.status,requirement.current_proposal_id::text AS current_proposal_id,
        requirement.first_required_world_minute,
        (SELECT count(*)::int FROM arc_currency_genesis_requirements row WHERE row.world_id=requirement.world_id) AS requirements,
        (SELECT count(*)::int FROM world_members member WHERE member.world_id=requirement.world_id) AS members,
        (SELECT count(*)::int FROM world_members member WHERE member.world_id=requirement.world_id AND member.role='resident') AS residents,
        (SELECT count(*)::int FROM world_members member WHERE member.world_id=requirement.world_id AND member.role='owner') AS owners,
        runtime.world_minutes
      FROM arc_currency_genesis_requirements requirement
      JOIN world_runtime_state runtime ON runtime.world_id=requirement.world_id
      WHERE requirement.world_id=$1`, [FORMAL_WORLD_ID]);
    assert.equal(formalState.rowCount, 1);
    assert.equal(formalState.rows[0].world_id, FORMAL_WORLD_ID);
    assert.equal(formalState.rows[0].status, 'UNRESOLVED');
    assert.equal(Number(formalState.rows[0].first_required_world_minute), 316_531);
    assert.equal(Number(formalState.rows[0].world_minutes), 316_531);
    assert.equal(Number(formalState.rows[0].requirements), 1);
    assert.equal(Number(formalState.rows[0].members), 10);
    assert.equal(Number(formalState.rows[0].residents), 9);
    assert.equal(Number(formalState.rows[0].owners), 1);
    const formalCounts = await client.query(`SELECT
      (SELECT count(*)::int FROM arc_token_issuance_intents WHERE world_id=$1) AS intents,
      (SELECT count(*)::int FROM arc_agent_tokens WHERE world_id=$1) AS tokens`, [FORMAL_WORLD_ID]);
    assert.deepEqual(formalCounts.rows[0], { intents: 0, tokens: 0 });
    assert.equal(formalState.rows[0].current_proposal_id, null,
      'the persistent currency requirement has no generated proposal pointer');
    const v6ProposalsAfter = await client.query(`SELECT count(*)::int AS count
      FROM world_capability_proposals WHERE world_id=$1`, [FORMAL_WORLD_ID]);
    assert.equal(v6ProposalsAfter.rows[0].count, v6ProposalsBefore.rows[0].count,
      'existing V6 capability proposals are preserved; they are separate from currency issuance intents');

    const permissions = await client.query(`SELECT table_name,
        has_table_privilege('synterra_app',table_name,'SELECT') AS can_select,
        has_table_privilege('synterra_app',table_name,'INSERT') AS can_insert,
        has_table_privilege('synterra_app',table_name,'UPDATE') AS can_update,
        has_table_privilege('synterra_app',table_name,'DELETE') AS can_delete
      FROM unnest($1::text[]) AS table_name ORDER BY table_name`, [ARC_ISSUANCE_TABLES]);
    assert.equal(permissions.rowCount, ARC_ISSUANCE_TABLES.length);
    for (const privilege of permissions.rows) {
      assert.equal(privilege.can_select, true, `${privilege.table_name} is readable`);
      assert.equal(privilege.can_insert, privilege.table_name !== 'arc_mainnet_pilot_budget',
        `${privilege.table_name} has INSERT only when the runtime creates rows there`);
      assert.equal(privilege.can_update,
        !['arc_token_issuance_decisions','arc_agent_token_uses'].includes(privilege.table_name),
        `${privilege.table_name} has UPDATE only when runtime upserts, transitions, or takes row locks`);
      assert.equal(privilege.can_delete, false, `${privilege.table_name} does not grant DELETE`);
    }
    const arcSequences = await client.query(`SELECT sequence_name FROM information_schema.sequences
      WHERE sequence_schema=current_schema() AND sequence_name LIKE 'arc_%'`);
    assert.equal(arcSequences.rowCount, 0, 'the issuance tables need UUIDs and no sequence grants');

    await client.query('BEGIN');
    const unrelatedTable = `privilege_guard_${randomUUID().replaceAll('-', '')}`;
    await client.query(`CREATE TABLE public."${unrelatedTable}" (id integer PRIMARY KEY, value text)`);
    await client.query(`INSERT INTO agents(id,name,public_key) VALUES
      ($1,'Privilege Fixture Proposer',$3),($2,'Privilege Fixture Issuer',$4)`,
    [proposerId, issuerId, `privilege-${proposerId}`, `privilege-${issuerId}`]);
    await client.query(`INSERT INTO worlds(id,owner_agent_id,name,chain_id)
      VALUES($1,$2,'Runtime privilege fixture',5042)`, [worldId, proposerId]);
    await client.query(`INSERT INTO world_members(world_id,agent_id,role,location)
      VALUES($1,$2,'owner','fixture'),($1,$3,'resident','fixture')`, [worldId, proposerId, issuerId]);
    await client.query('SET LOCAL ROLE synterra_app');

    await client.query(`INSERT INTO arc_currency_genesis_requirements(world_id,capability_generation,status,
      first_required_world_minute,last_transition_world_minute) VALUES($1,1,'UNRESOLVED',0,0)`, [worldId]);
    await client.query(`UPDATE arc_currency_genesis_requirements SET status='DELIBERATING'
      WHERE world_id=$1`, [worldId]);
    await client.query(`INSERT INTO arc_token_pilot_capabilities(world_id,capability_generation,max_token_creations,
      status,source) VALUES($1,1,1,'active','runtime_privilege_test')`, [worldId]);
    await client.query(`SELECT capability_generation FROM arc_token_pilot_capabilities
      WHERE world_id=$1 AND capability_generation=1 FOR UPDATE`, [worldId]);

    const intent = await client.query(`INSERT INTO arc_token_issuance_intents(world_id,proposer_agent_id,
      capability_generation,status,created_world_minute,updated_world_minute,action_id)
      VALUES($1,$2,1,'incomplete',0,0,$3) RETURNING id`, [worldId, proposerId, actionId]);
    const intentId = intent.rows[0].id;
    await client.query(`UPDATE arc_token_issuance_intents SET status='proposed',updated_world_minute=1
      WHERE world_id=$1 AND id=$2`, [worldId, intentId]);
    await client.query(`INSERT INTO arc_token_issuance_responses(world_id,intent_id,agent_id,decision,world_minute,action_id)
      VALUES($1,$2,$3,'support',1,$4) ON CONFLICT(world_id,intent_id,agent_id) DO UPDATE SET
        decision=EXCLUDED.decision,world_minute=EXCLUDED.world_minute,action_id=EXCLUDED.action_id,updated_at=now()`,
    [worldId, intentId, issuerId, `${actionId}-response`]);
    await client.query(`INSERT INTO arc_token_issuance_decisions(world_id,intent_id,agent_id,decision,world_minute,action_id)
      VALUES($1,$2,$3,'issuer_nomination',1,$4)`, [worldId, intentId, proposerId, `${actionId}-decision`]);
    await client.query(`INSERT INTO arc_token_issuance_issuer_candidates(world_id,intent_id,candidate_agent_id,
      nominated_by_agent_id,nominated_world_minute,action_id) VALUES($1,$2,$3,$4,1,$5)`,
    [worldId, intentId, issuerId, proposerId, `${actionId}-candidate`]);
    await client.query(`UPDATE arc_token_issuance_issuer_candidates SET status='accepted',
      decided_world_minute=2,updated_at=now() WHERE world_id=$1 AND intent_id=$2 AND candidate_agent_id=$3`,
    [worldId, intentId, issuerId]);

    const token = await client.query(`INSERT INTO arc_agent_tokens(world_id,intent_id,capability_generation,
      creation_sequence,chain_id,token_address,factory_address,name,symbol,decimals,unallocated_supply_handling,
      ownership_model,authority_model,initial_supply_raw,reserve_supply_raw,issuer_agent_id,issuer_identity_id,
      issuer_wallet,transaction_sender,specification_hash,transaction_hash,block_number,log_index,created_world_minute)
      VALUES($1,$2,1,1,5042,'0x0000000000000000000000000000000000000001',
        '0x0000000000000000000000000000000000000002','Fixture Token','FIX',6,'fully_distributed',
        'erc20_holder_owned','no_mint_no_burn',100,0,$3,1,'0x0000000000000000000000000000000000000003',
        '0x0000000000000000000000000000000000000003',$4,$5,1,0,1) RETURNING id`,
    [worldId, intentId, issuerId, `0x${'ab'.repeat(32)}`, `0x${'cd'.repeat(32)}`]);
    const tokenId = token.rows[0].id;
    await client.query(`INSERT INTO arc_agent_token_responses(world_id,token_id,agent_id,decision,world_minute,action_id)
      VALUES($1,$2,$3,'accept',1,$4)`, [worldId, tokenId, proposerId, `${actionId}-token-response`]);
    await client.query(`INSERT INTO arc_agent_token_uses(world_id,token_id,agent_id,usage_context,world_minute,action_id)
      VALUES($1,$2,$3,'isolated runtime privilege fixture',1,$4)`,
    [worldId, tokenId, issuerId, `${actionId}-use`]);

    await client.query(`UPDATE arc_mainnet_pilot_budget SET reserved_usdc_base_units=reserved_usdc_base_units+1
      WHERE id=1`);
    const cost = await client.query(`INSERT INTO arc_mainnet_pilot_cost_reservations(operation_type,operation_id,
      world_id,chain_id,gas_limit,max_fee_per_gas,reserved_cost_usdc_base_units)
      VALUES('settlement',$1,$2,5042,1,1,1) RETURNING id`, [`${actionId}-cost`, worldId]);
    await client.query(`UPDATE arc_mainnet_pilot_cost_reservations SET status='submitting' WHERE id=$1`, [cost.rows[0].id]);
    await client.query(`INSERT INTO arc_infrastructure_nonce_cursors(chain_id,address,next_nonce)
      VALUES(5042,'0x0000000000000000000000000000000000000004',0)`);
    await client.query(`UPDATE arc_infrastructure_nonce_cursors SET next_nonce=1
      WHERE chain_id=5042 AND address='0x0000000000000000000000000000000000000004'`);
    await client.query(`INSERT INTO arc_infrastructure_nonce_reservations(chain_id,address,operation_type,
      operation_id,nonce,start_block) VALUES(5042,'0x0000000000000000000000000000000000000004',
      'deployment',$1,0,1) RETURNING id`, [`${actionId}-nonce`]);
    await client.query(`UPDATE arc_infrastructure_nonce_reservations SET status='submitting'
      WHERE operation_type='deployment' AND operation_id=$1`, [`${actionId}-nonce`]);

    await client.query(`SELECT id FROM arc_agent_tokens WHERE world_id=$1 AND intent_id=$2 FOR UPDATE`, [worldId, intentId]);
    await client.query(`INSERT INTO arc_agent_token_responses(world_id,token_id,agent_id,decision,world_minute,action_id)
      VALUES($1,$2,$3,'accept',2,$4) ON CONFLICT(world_id,token_id,agent_id) DO UPDATE SET
        decision=EXCLUDED.decision,world_minute=EXCLUDED.world_minute,action_id=EXCLUDED.action_id,updated_at=now()`,
    [worldId, tokenId, proposerId, `${actionId}-token-response-update`]);

    const runtimeRead = await client.query(`SELECT requirement.status,
        (SELECT count(*)::int FROM arc_token_issuance_intents WHERE world_id=$1) AS intents,
        (SELECT count(*)::int FROM arc_agent_tokens WHERE world_id=$1) AS tokens,
        (SELECT count(*)::int FROM arc_agent_token_uses WHERE world_id=$1) AS uses
      FROM arc_currency_genesis_requirements requirement WHERE requirement.world_id=$1`, [worldId]);
    assert.deepEqual(runtimeRead.rows[0], { status: 'DELIBERATING', intents: 1, tokens: 1, uses: 1 });

    await client.query('SAVEPOINT unrelated_privilege_check');
    await assert.rejects(client.query(`UPDATE public."${unrelatedTable}" SET value=value WHERE false`),
      (error) => error.code === '42501');
    await client.query('ROLLBACK TO SAVEPOINT unrelated_privilege_check');
    await client.query('ROLLBACK');
  } finally {
    client.release();
    await pool.end();
  }
});

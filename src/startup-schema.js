import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { readWorldMigrationPlan } from './database-migrations.js';

function incompatible(detail) {
  const error = new Error(`Startup schema validation failed: ${detail}`);
  error.code = 'STARTUP_SCHEMA_INCOMPATIBLE';
  return error;
}

// Object-level requirements mirror the numbered migrations; these checks never grant privileges.
const issuanceWrites = {
  'INSERT,UPDATE': ['arc_currency_genesis_requirements', 'arc_token_pilot_capabilities',
    'arc_token_issuance_intents', 'arc_token_issuance_responses', 'arc_token_issuance_issuer_candidates',
    'arc_agent_tokens', 'arc_agent_token_responses', 'arc_mainnet_pilot_cost_reservations',
    'arc_infrastructure_nonce_cursors', 'arc_infrastructure_nonce_reservations'],
  INSERT: ['arc_token_issuance_decisions', 'arc_agent_token_uses', 'world_infrastructure_usage_events'],
  UPDATE: ['arc_mainnet_pilot_budget']
};

const coreWrites = {
  'INSERT,UPDATE': ['world_runtime_state', 'world_agent_states', 'world_social_profiles',
    'world_agent_goals', 'world_agent_self_models', 'world_agent_decision_policies', 'world_epochs', 'agent_memories',
    'world_genesis_token_balance_snapshots', 'world_business_service_token_terms', 'world_business_job_token_terms',
    'arc_genesis_token_settlement_outbox', 'world_genesis_token_business_orders'],
  INSERT: ['world_events', 'world_history', 'world_decision_traces', 'world_v7_events',
    'world_capability_events', 'world_agent_self_model_history', 'world_genesis_currency_activations',
    'world_infrastructure_usage_events'],
  DELETE: ['agent_memories', 'world_decision_traces']
};

export async function prepareStartupSchema(pool, { rootDirectory, mode = 'apply' }) {
  if (!['apply', 'validate'].includes(mode)) throw incompatible('SYNTERRA_SCHEMA_MODE must be apply or validate');
  if (mode === 'apply') {
    // Preserve legacy bootstrap semantics; numbered migrations remain an explicit operator action.
    await pool.query(await readFile(path.join(rootDirectory, 'schema.sql'), 'utf8'));
    return { mode, validated: false };
  }

  const migrations = await readWorldMigrationPlan(rootDirectory);
  const requiredMigrations = ['0001_arc_mainnet.sql', '0002_world_environment.sql',
    '0002_arc_agent_token_issuance.sql', '0003_arc_agent_token_issuance_runtime_privileges.sql',
    '0004_genesis_token_economy.sql', '0005_rea_research_jobs.sql', '0006_research_artifact_relations.sql'];
  for (const name of requiredMigrations) {
    if (!migrations.some((migration) => migration.name === name)) throw incompatible(`missing migration source ${name}`);
  }
  const contract = JSON.parse(await readFile(path.join(rootDirectory, 'src/runtime-schema-contract.json'), 'utf8'));
  for (const [table, expected] of Object.entries(contract)) {
    if (!expected || !expected.columns || !expected.constraints
        || !Array.isArray(expected.notNullColumns) || !expected.uniqueIndexes) {
      throw incompatible(`invalid runtime schema contract for ${table}`);
    }
  }
  // Read source names only. No SQL from schema.sql or a migration is executed in validate mode.
  const schema = await readFile(path.join(rootDirectory, 'schema.sql'), 'utf8');
  const tables = [...new Set([...schema.matchAll(/CREATE TABLE IF NOT EXISTS ([a-z_][a-z0-9_]*)/g)]
    .map((match) => match[1]).concat(Object.keys(contract), 'synterra_schema_migrations'))].sort();
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SET LOCAL statement_timeout = '10s'");
    const relations = await client.query(`SELECT name,to_regclass('public.' || name) IS NOT NULL AS present
      FROM unnest($1::text[]) AS name`, [tables]);
    for (const row of relations.rows) if (!row.present) throw incompatible(`missing table ${row.name}`);
    const ledger = await client.query('SELECT version,checksum FROM public.synterra_schema_migrations');
    for (const migration of migrations) {
      const entry = ledger.rows.find((row) => row.version === migration.name);
      if (!entry) throw incompatible(`missing migration ${migration.name}`);
      if (entry.checksum !== migration.checksum) throw incompatible(`checksum mismatch ${migration.name}`);
    }
    const columns = await client.query(`SELECT c.relname AS table_name,a.attname AS name,
        format_type(a.atttypid,a.atttypmod) AS type,a.attnotnull AS not_null
      FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relname=ANY($1::text[]) AND a.attnum>0 AND NOT a.attisdropped`, [Object.keys(contract)]);
    const constraints = await client.query(`SELECT c.relname AS table_name,k.conname AS name,
        pg_get_constraintdef(k.oid,true) AS definition,k.convalidated AS validated
      FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relname=ANY($1::text[])`, [Object.keys(contract)]);
    const indexes = await client.query(`SELECT c.relname AS table_name,idx.relname AS name,
        pg_get_indexdef(i.indexrelid) AS definition,i.indisvalid AS valid,i.indisready AS ready
      FROM pg_index i JOIN pg_class c ON c.oid=i.indrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      JOIN pg_class idx ON idx.oid=i.indexrelid
      WHERE n.nspname='public' AND c.relname=ANY($1::text[])`, [Object.keys(contract)]);
    for (const [table, expected] of Object.entries(contract)) {
      for (const [name, type] of Object.entries(expected.columns)) {
        if (!columns.rows.some((row) => row.table_name === table && row.name === name && row.type === type)) {
          throw incompatible(`missing or incompatible column ${table}.${name}`);
        }
      }
      for (const [name, definition] of Object.entries(expected.constraints)) {
        const compatible = expected.compatibleConstraintDefinitions?.[name] || [];
        const acceptedDefinitions = [definition, ...compatible];
        if (!constraints.rows.some((row) => row.table_name === table && row.name === name
            && acceptedDefinitions.includes(row.definition) && row.validated)) {
          throw incompatible(`missing or incompatible constraint ${table}.${name}`);
        }
      }
      for (const name of expected.notNullColumns) {
        if (!columns.rows.some((row) => row.table_name === table && row.name === name && row.not_null)) {
          throw incompatible(`missing NOT NULL ${table}.${name}`);
        }
      }
      for (const [name, definition] of Object.entries(expected.uniqueIndexes)) {
        if (!indexes.rows.some((row) => row.table_name === table && row.name === name
            && row.definition === definition && row.valid && row.ready)) throw incompatible(`missing or incompatible index ${table}.${name}`);
      }
    }
    const roles = await client.query("SELECT current_user AS runtime_role,EXISTS(SELECT 1 FROM pg_roles WHERE rolname='synterra_app') AS app_exists");
    if (!roles.rows[0].app_exists) throw incompatible('missing role synterra_app');
    const currentRole = roles.rows[0].runtime_role;
    const reads = await client.query(`SELECT name,has_table_privilege(current_user,'public.' || name,'SELECT') AS allowed
      FROM unnest($1::text[]) AS name`, [tables]);
    for (const row of reads.rows) if (!row.allowed) throw incompatible(`runtime SELECT missing on ${row.name}`);
    for (const role of new Set([currentRole, 'synterra_app'])) {
      for (const [privileges, names] of Object.entries(issuanceWrites)) {
        // PostgreSQL comma-separated privilege strings mean ANY, so check every privilege separately.
        const grants = await client.query(`SELECT name,privilege,
            has_table_privilege($1,'public.' || name,privilege) AS allowed
          FROM unnest($2::text[]) AS name CROSS JOIN unnest($3::text[]) AS privilege`,
        [role, names, ['SELECT', ...privileges.split(',')]]);
        for (const row of grants.rows) if (!row.allowed) throw incompatible(`${role} ${row.privilege} missing on ${row.name}`);
      }
    }
    const researchTableGrants = [
      ['world_research_artifacts', ['SELECT','INSERT']],
      ['world_research_artifact_grants', ['SELECT','INSERT']],
      ['world_research_artifact_relations', ['SELECT','INSERT']],
      ['world_research_jobs', ['SELECT','INSERT']],
      ['world_research_runtime_status', ['SELECT','INSERT','UPDATE']],
      ['world_capability_uses', ['SELECT','INSERT']],
      ['world_capabilities', ['SELECT']]
    ];
    const researchColumnUpdates = {
      world_research_jobs: ['status','worker_id','started_at','lease_expires_at','attempt_count','external_call_started_at',
        'completed_at','completed_world_minute','evidence_reference','evidence_sha256','evidence_bytes','normalized_findings',
        'selected_providers','tool_sequence','tool_calls','infrastructure_usage_event_id','failure_code','failure_diagnostic','updated_at'],
      world_capability_uses: ['status','success','costs','effects','side_effects','result'],
      world_capabilities: ['usage_count','success_count','failure_count','updated_at']
    };
    for (const role of new Set([currentRole, 'synterra_app'])) {
      for (const [table, privileges] of researchTableGrants) {
        const grants = await client.query(`SELECT privilege,has_table_privilege($1,'public.' || $2,privilege) AS allowed
          FROM unnest($3::text[]) AS privilege`, [role, table, privileges]);
        for (const row of grants.rows) if (!row.allowed) throw incompatible(`${role} ${row.privilege} missing on ${table}`);
      }
      for (const [table, columnsForUpdate] of Object.entries(researchColumnUpdates)) {
        const grants = await client.query(`SELECT column_name,has_column_privilege($1,'public.' || $2,column_name,'UPDATE') AS allowed
          FROM unnest($3::text[]) AS column_name`, [role, table, columnsForUpdate]);
        for (const row of grants.rows) if (!row.allowed) throw incompatible(`${role} UPDATE missing on ${table}.${row.column_name}`);
      }
      const sequence = await client.query(`SELECT has_sequence_privilege($1,'public.world_capability_uses_id_seq','USAGE') AS allowed`, [role]);
      if (!sequence.rows[0]?.allowed) throw incompatible(`${role} USAGE missing on world_capability_uses_id_seq`);
    }
    for (const [privileges, names] of Object.entries(coreWrites)) {
      const grants = await client.query(`SELECT name,privilege,
          has_table_privilege(current_user,'public.' || name,privilege) AS allowed
        FROM unnest($1::text[]) AS name CROSS JOIN unnest($2::text[]) AS privilege`, [names, privileges.split(',')]);
      for (const row of grants.rows) if (!row.allowed) throw incompatible(`runtime ${row.privilege} missing on ${row.name}`);
    }
    const sequences = await client.query(`SELECT seq.relname AS name,has_sequence_privilege(current_user,seq.oid,'USAGE') AS allowed
      FROM pg_class seq JOIN pg_depend d ON d.objid=seq.oid AND d.classid='pg_class'::regclass
      JOIN pg_class tbl ON tbl.oid=d.refobjid JOIN pg_namespace n ON n.oid=tbl.relnamespace
      WHERE seq.relkind='S' AND d.deptype IN ('a','i') AND n.nspname='public' AND tbl.relname=ANY($1::text[])`,
    [Object.entries(coreWrites).filter(([privileges]) => privileges.includes('INSERT')).flatMap(([, names]) => names)]);
    for (const row of sequences.rows) if (!row.allowed) throw incompatible(`runtime sequence USAGE missing on ${row.name}`);
    await client.query('COMMIT');
    console.log(JSON.stringify({ event: 'startup_schema_validation', mode: 'validate',
      migrationValidation: 'passed', checksumValidation: 'passed', requiredObjects: 'passed',
      runtimeGrants: 'passed', schemaSql: 'not_executed' }));
    return { mode, validated: true, migrations: migrations.map(({ name }) => name), tables: tables.length };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

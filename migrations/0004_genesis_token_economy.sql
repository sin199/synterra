-- Genesis economy is additive. Existing simulated USDC and paper/crypto history
-- is intentionally left untouched and becomes historical-only after activation.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='world_organizations'::regclass
      AND conname='world_organizations_world_id_id_key') THEN
    ALTER TABLE world_organizations ADD CONSTRAINT world_organizations_world_id_id_key UNIQUE (world_id,id);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS world_genesis_issuer_assignments (
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  capability_generation integer NOT NULL CHECK (capability_generation > 0),
  issuer_agent_id uuid NOT NULL,
  selection_source text NOT NULL CHECK (selection_source='creator_genesis_assignment'),
  assigned_world_minute bigint NOT NULL DEFAULT 0 CHECK (assigned_world_minute >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (world_id,capability_generation),
  FOREIGN KEY (world_id,issuer_agent_id) REFERENCES world_members(world_id,agent_id) ON DELETE RESTRICT
);

-- Resolve the explicitly named Genesis-01 identity only when the name is unique.
-- No assignment is fabricated when the formal world cannot be resolved uniquely.
WITH named_issuer AS (
  SELECT member.world_id,member.agent_id,runtime.world_minutes,
    count(*) OVER (PARTITION BY member.world_id) AS matches
  FROM world_members member
  JOIN agents agent ON agent.id=member.agent_id
  LEFT JOIN world_runtime_state runtime ON runtime.world_id=member.world_id
  WHERE regexp_replace(lower(agent.name),'[^a-z0-9]','','g') IN ('synterra01','synterra1')
    AND member.world_id='ce434421-8bcd-4aac-b9ba-183383c713de'::uuid
)
INSERT INTO world_genesis_issuer_assignments(world_id,capability_generation,issuer_agent_id,
    selection_source,assigned_world_minute)
SELECT world_id,1,agent_id,'creator_genesis_assignment',COALESCE(world_minutes,0)
FROM named_issuer WHERE matches=1
ON CONFLICT(world_id,capability_generation) DO NOTHING;

ALTER TABLE arc_token_issuance_intents
  ADD COLUMN issuer_selection_source text
    CHECK (issuer_selection_source IS NULL OR issuer_selection_source IN ('agent_nomination','creator_genesis_assignment'));

-- Old USD fields remain populated on historical rows. New Genesis-era rows may
-- leave those fields NULL; their native denomination is carried separately in
-- raw token units below.
ALTER TABLE world_business_services ALTER COLUMN base_price_usdc DROP NOT NULL;
ALTER TABLE world_business_jobs ALTER COLUMN wage_usdc DROP NOT NULL;
ALTER TABLE world_business_employment ALTER COLUMN wage_usdc DROP NOT NULL;
ALTER TABLE world_business_employment ADD COLUMN wage_token_id uuid;
ALTER TABLE world_business_employment ADD COLUMN wage_raw numeric(78,0);
ALTER TABLE world_business_employment ADD CONSTRAINT world_business_employment_wage_currency_check
  CHECK ((wage_token_id IS NULL AND wage_raw IS NULL)
      OR (wage_token_id IS NOT NULL AND wage_raw > 0));
ALTER TABLE world_business_employment ADD CONSTRAINT world_business_employment_wage_token_fkey
  FOREIGN KEY (world_id,wage_token_id) REFERENCES arc_agent_tokens(world_id,id) ON DELETE RESTRICT;

-- A legacy simulated-USDC employment row can retain status='active' for history,
-- but it must not prevent a resident from accepting a current Genesis Token job.
DROP INDEX IF EXISTS world_business_employment_one_active_job_idx;
CREATE UNIQUE INDEX world_business_employment_one_active_job_idx
  ON world_business_employment(world_id,agent_id)
  WHERE status='active' AND wage_token_id IS NOT NULL AND wage_raw IS NOT NULL;
DROP INDEX IF EXISTS world_business_job_one_active_employee_idx;
CREATE UNIQUE INDEX world_business_job_one_active_employee_idx
  ON world_business_employment(job_id)
  WHERE status='active' AND wage_token_id IS NOT NULL AND wage_raw IS NOT NULL;

CREATE TABLE IF NOT EXISTS world_genesis_currency_activations (
  world_id uuid PRIMARY KEY REFERENCES worlds(id) ON DELETE RESTRICT,
  capability_generation integer NOT NULL CHECK (capability_generation=1),
  token_id uuid NOT NULL,
  chain_id integer NOT NULL DEFAULT 5042 CHECK (chain_id=5042),
  issuer_agent_id uuid NOT NULL,
  issuer_selection_source text NOT NULL CHECK (issuer_selection_source='creator_genesis_assignment'),
  transaction_hash text NOT NULL CHECK (transaction_hash ~ '^0x[0-9a-fA-F]{64}$'),
  block_number numeric(78,0) NOT NULL CHECK (block_number >= 0),
  world_minute bigint NOT NULL CHECK (world_minute >= 0),
  creator_allocation_raw numeric(78,0) NOT NULL DEFAULT 0 CHECK (creator_allocation_raw=0),
  activated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (world_id,token_id) REFERENCES arc_agent_tokens(world_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (world_id,issuer_agent_id) REFERENCES world_members(world_id,agent_id) ON DELETE RESTRICT,
  UNIQUE (chain_id,transaction_hash),
  UNIQUE (world_id,token_id)
);

-- Append-only evidence for real infrastructure consumption and attributable cost.
-- An unpriced event records usage only; it cannot create a liability or collect a fee.
CREATE TABLE IF NOT EXISTS world_infrastructure_usage_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE RESTRICT,
  attribution_type text NOT NULL CHECK (attribution_type IN ('world','agent','organization')),
  agent_id uuid,
  organization_id uuid,
  action_id text NOT NULL CHECK (char_length(action_id) BETWEEN 8 AND 180),
  resource_category text NOT NULL CHECK (resource_category IN ('ai_inference','high_cost_research',
    'long_term_storage','server_compute','indexing','settlement','arc_execution','other')),
  provider text NOT NULL CHECK (char_length(provider) BETWEEN 1 AND 120),
  model text CHECK (model IS NULL OR char_length(model) <= 120),
  world_minute bigint NOT NULL CHECK (world_minute >= 0),
  quantity_raw numeric(78,0) NOT NULL CHECK (quantity_raw > 0),
  unit text NOT NULL CHECK (char_length(unit) BETWEEN 1 AND 80),
  cost_status text NOT NULL DEFAULT 'unpriced' CHECK (cost_status IN ('unpriced','estimated','actual')),
  cost_currency text CHECK (cost_currency IS NULL OR cost_currency IN ('USD','ARC_USDC')),
  cost_chain_id integer,
  cost_microunits numeric(78,0) CHECK (cost_microunits IS NULL OR cost_microunits >= 0),
  cost_evidence_source text CHECK (cost_evidence_source IS NULL OR cost_evidence_source IN
    ('provider_reported','invoice','arc_receipt','operator_estimate','unknown')),
  cost_evidence_reference text CHECK (cost_evidence_reference IS NULL OR char_length(cost_evidence_reference) <= 240),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata)='object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (world_id,agent_id) REFERENCES world_members(world_id,agent_id) ON DELETE RESTRICT,
  FOREIGN KEY (world_id,organization_id) REFERENCES world_organizations(world_id,id) ON DELETE RESTRICT,
  UNIQUE (world_id,action_id),
  CHECK ((attribution_type='world' AND agent_id IS NULL AND organization_id IS NULL)
      OR (attribution_type='agent' AND agent_id IS NOT NULL AND organization_id IS NULL)
      OR (attribution_type='organization' AND agent_id IS NULL AND organization_id IS NOT NULL)),
  CHECK ((cost_status='unpriced' AND cost_currency IS NULL AND cost_chain_id IS NULL AND cost_microunits IS NULL)
      OR (cost_status IN ('estimated','actual') AND cost_currency IS NOT NULL AND cost_microunits IS NOT NULL)),
  CHECK ((cost_currency='ARC_USDC' AND cost_chain_id=5042)
      OR (cost_currency='USD' AND cost_chain_id IS NULL) OR cost_currency IS NULL),
  CHECK (cost_status<>'actual' OR cost_evidence_source IN ('provider_reported','invoice','arc_receipt'))
);
CREATE INDEX IF NOT EXISTS world_infrastructure_usage_attribution_idx
  ON world_infrastructure_usage_events(world_id,attribution_type,agent_id,organization_id,world_minute DESC,created_at DESC);

-- Operator infrastructure pricing is versioned separately from Agent-created taxes.
-- This migration adds no policy rows, rate, destination wallet, or fee-collection path.
CREATE TABLE IF NOT EXISTS world_infrastructure_fee_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE RESTRICT,
  policy_key text NOT NULL CHECK (char_length(policy_key) BETWEEN 1 AND 120),
  policy_version integer NOT NULL CHECK (policy_version > 0),
  resource_category text NOT NULL CHECK (resource_category IN ('ai_inference','high_cost_research',
    'long_term_storage','server_compute','indexing','settlement','arc_execution','other')),
  payer_scope text NOT NULL CHECK (payer_scope IN ('world','agent','organization')),
  fee_class text NOT NULL DEFAULT 'operator_infrastructure' CHECK (fee_class='operator_infrastructure'),
  status text NOT NULL DEFAULT 'unpriced' CHECK (status IN ('unpriced','draft','active','retired')),
  pricing_model text NOT NULL DEFAULT 'none' CHECK (pricing_model IN ('none','per_unit','actual_cost_recovery','fixed_amount')),
  settlement_asset text CHECK (settlement_asset IS NULL OR settlement_asset IN ('ARC_USDC','GENESIS_TOKEN')),
  settlement_chain_id integer,
  settlement_token_id uuid,
  rate_raw numeric(78,0) CHECK (rate_raw IS NULL OR rate_raw >= 0),
  rate_unit text CHECK (rate_unit IS NULL OR char_length(rate_unit) BETWEEN 1 AND 80),
  effective_world_minute bigint NOT NULL DEFAULT 0 CHECK (effective_world_minute >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata)='object'),
  FOREIGN KEY (world_id,settlement_token_id) REFERENCES arc_agent_tokens(world_id,id) ON DELETE RESTRICT,
  CONSTRAINT world_infrastructure_fee_policy_version_key UNIQUE (world_id,policy_key,policy_version),
  CHECK ((settlement_asset='ARC_USDC' AND settlement_chain_id=5042 AND settlement_token_id IS NULL)
      OR (settlement_asset='GENESIS_TOKEN' AND settlement_chain_id=5042 AND settlement_token_id IS NOT NULL)
      OR (settlement_asset IS NULL AND settlement_chain_id IS NULL AND settlement_token_id IS NULL)),
  CHECK (status<>'active' OR (pricing_model<>'none' AND settlement_asset IS NOT NULL AND rate_raw>0 AND rate_unit IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS world_infrastructure_fee_policy_status_idx
  ON world_infrastructure_fee_policies(world_id,status,policy_key,policy_version DESC);

CREATE TABLE IF NOT EXISTS arc_organization_wallets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL,
  chain_id integer NOT NULL DEFAULT 5042 CHECK (chain_id=5042),
  address text NOT NULL CHECK (address ~ '^0x[0-9a-fA-F]{40}$'),
  provider text NOT NULL CHECK (provider IN ('managed_wallet','external_kms')),
  account_type text NOT NULL CHECK (account_type IN ('eoa','sca','msca')),
  status text NOT NULL DEFAULT 'prepared' CHECK (status IN ('prepared','active','suspended','revoked')),
  external_identity_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata)='object'),
  FOREIGN KEY (world_id,organization_id) REFERENCES world_organizations(world_id,id) ON DELETE CASCADE,
  UNIQUE (world_id,organization_id,chain_id),
  UNIQUE (world_id,chain_id,address)
);

-- A settlement address is usable only after an operator has verified its
-- deployed bytecode and explicitly activated this record during Mainnet
-- preflight. This migration never creates or activates a contract record.
CREATE TABLE IF NOT EXISTS arc_genesis_token_settlement_contracts (
  world_id uuid PRIMARY KEY REFERENCES worlds(id) ON DELETE RESTRICT,
  token_id uuid NOT NULL,
  chain_id integer NOT NULL DEFAULT 5042 CHECK (chain_id=5042),
  contract_address text NOT NULL CHECK (contract_address ~ '^0x[0-9a-fA-F]{40}$'),
  runtime_code_hash text NOT NULL CHECK (runtime_code_hash ~ '^0x[0-9a-fA-F]{64}$'),
  verified_block numeric(78,0) NOT NULL CHECK (verified_block >= 0),
  status text NOT NULL CHECK (status IN ('observed','approved','active','retired')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata)='object'),
  observed_at timestamptz NOT NULL,
  approved_at timestamptz,
  FOREIGN KEY (world_id,token_id) REFERENCES world_genesis_currency_activations(world_id,token_id) ON DELETE RESTRICT,
  UNIQUE (chain_id,contract_address)
);

CREATE TABLE IF NOT EXISTS world_genesis_token_balance_snapshots (
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  token_id uuid NOT NULL,
  chain_id integer NOT NULL DEFAULT 5042 CHECK (chain_id=5042),
  wallet_address text NOT NULL CHECK (wallet_address ~ '^0x[0-9a-fA-F]{40}$'),
  agent_id uuid,
  organization_id uuid,
  balance_raw numeric(78,0) NOT NULL CHECK (balance_raw >= 0),
  block_number numeric(78,0) NOT NULL CHECK (block_number >= 0),
  source text NOT NULL DEFAULT 'arc_rpc_eth_call' CHECK (source='arc_rpc_eth_call'),
  observed_at timestamptz NOT NULL,
  PRIMARY KEY (world_id,token_id,wallet_address),
  FOREIGN KEY (world_id,token_id) REFERENCES arc_agent_tokens(world_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (world_id,agent_id) REFERENCES world_members(world_id,agent_id) ON DELETE CASCADE,
  FOREIGN KEY (world_id,organization_id) REFERENCES world_organizations(world_id,id) ON DELETE CASCADE,
  CHECK ((agent_id IS NOT NULL)::integer + (organization_id IS NOT NULL)::integer = 1)
);
CREATE INDEX IF NOT EXISTS world_genesis_token_balance_observed_idx
  ON world_genesis_token_balance_snapshots(world_id,token_id,observed_at DESC);

CREATE TABLE IF NOT EXISTS world_business_service_token_terms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  business_id uuid NOT NULL REFERENCES world_businesses(id) ON DELETE CASCADE,
  service_id uuid NOT NULL REFERENCES world_business_services(id) ON DELETE CASCADE,
  token_id uuid NOT NULL,
  price_raw numeric(78,0) NOT NULL CHECK (price_raw > 0),
  published_by_agent_id uuid NOT NULL,
  action_id text NOT NULL CHECK (char_length(action_id) BETWEEN 8 AND 160),
  effective_world_minute bigint NOT NULL CHECK (effective_world_minute >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (world_id,token_id) REFERENCES arc_agent_tokens(world_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (world_id,published_by_agent_id) REFERENCES world_members(world_id,agent_id) ON DELETE RESTRICT,
  UNIQUE (world_id,service_id),
  UNIQUE (world_id,published_by_agent_id,action_id)
);

CREATE TABLE IF NOT EXISTS world_business_job_token_terms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  business_id uuid NOT NULL REFERENCES world_businesses(id) ON DELETE CASCADE,
  job_id uuid NOT NULL REFERENCES world_business_jobs(id) ON DELETE CASCADE,
  token_id uuid NOT NULL,
  wage_raw numeric(78,0) NOT NULL CHECK (wage_raw > 0),
  published_by_agent_id uuid NOT NULL,
  action_id text NOT NULL CHECK (char_length(action_id) BETWEEN 8 AND 160),
  effective_world_minute bigint NOT NULL CHECK (effective_world_minute >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (world_id,token_id) REFERENCES arc_agent_tokens(world_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (world_id,published_by_agent_id) REFERENCES world_members(world_id,agent_id) ON DELETE RESTRICT,
  UNIQUE (world_id,job_id),
  UNIQUE (world_id,published_by_agent_id,action_id)
);

CREATE TABLE IF NOT EXISTS arc_genesis_token_settlement_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  world_action_id text NOT NULL CHECK (char_length(world_action_id) BETWEEN 8 AND 180),
  token_id uuid NOT NULL,
  chain_id integer NOT NULL DEFAULT 5042 CHECK (chain_id=5042),
  settlement_contract text CHECK (settlement_contract IS NULL OR settlement_contract ~ '^0x[0-9a-fA-F]{40}$'),
  from_agent_id uuid NOT NULL,
  to_agent_id uuid,
  to_organization_id uuid,
  from_address text NOT NULL CHECK (from_address ~ '^0x[0-9a-fA-F]{40}$'),
  to_address text NOT NULL CHECK (to_address ~ '^0x[0-9a-fA-F]{40}$'),
  amount_raw numeric(78,0) NOT NULL CHECK (amount_raw > 0 AND amount_raw <= 340282366920938463463374607431768211455),
  action_family text NOT NULL CHECK (char_length(action_family) BETWEEN 1 AND 96),
  reason_hash text NOT NULL CHECK (reason_hash ~ '^0x[0-9a-fA-F]{64}$'),
  status text NOT NULL DEFAULT 'prepared' CHECK (status IN ('prepared','submitting','submission_unknown','submitted','final','failed')),
  transaction_hash text CHECK (transaction_hash IS NULL OR transaction_hash ~ '^0x[0-9a-fA-F]{64}$'),
  submission_attempt_id uuid,
  submission_started_at timestamptz,
  submission_start_block numeric(78,0) CHECK (submission_start_block IS NULL OR submission_start_block >= 0),
  reconciliation_log_cursor_block numeric(78,0) CHECK (reconciliation_log_cursor_block IS NULL OR reconciliation_log_cursor_block >= 0),
  block_number numeric(78,0) CHECK (block_number IS NULL OR block_number >= 0),
  log_index integer CHECK (log_index IS NULL OR log_index >= 0),
  created_world_minute bigint NOT NULL CHECK (created_world_minute >= 0),
  submitted_at timestamptz,
  finalized_at timestamptz,
  failure_code text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata)='object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (world_id,token_id) REFERENCES arc_agent_tokens(world_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (world_id,from_agent_id) REFERENCES world_members(world_id,agent_id) ON DELETE RESTRICT,
  FOREIGN KEY (world_id,to_agent_id) REFERENCES world_members(world_id,agent_id) ON DELETE RESTRICT,
  FOREIGN KEY (world_id,to_organization_id) REFERENCES world_organizations(world_id,id) ON DELETE RESTRICT,
  CHECK ((to_agent_id IS NOT NULL)::integer + (to_organization_id IS NOT NULL)::integer = 1),
  CHECK (lower(from_address) <> lower(to_address)),
  UNIQUE (world_id,world_action_id),
  UNIQUE (chain_id,transaction_hash)
);
CREATE INDEX IF NOT EXISTS arc_genesis_token_settlement_status_idx
  ON arc_genesis_token_settlement_outbox(world_id,status,created_at,id);
CREATE INDEX IF NOT EXISTS arc_genesis_token_settlement_payer_idx
  ON arc_genesis_token_settlement_outbox(world_id,from_agent_id,created_at DESC);

CREATE TABLE IF NOT EXISTS world_genesis_token_business_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  business_id uuid NOT NULL REFERENCES world_businesses(id) ON DELETE RESTRICT,
  service_id uuid NOT NULL REFERENCES world_business_services(id) ON DELETE RESTRICT,
  customer_agent_id uuid NOT NULL,
  provider_agent_id uuid NOT NULL,
  token_id uuid NOT NULL,
  settlement_outbox_id uuid NOT NULL REFERENCES arc_genesis_token_settlement_outbox(id) ON DELETE RESTRICT,
  action_id text NOT NULL CHECK (char_length(action_id) BETWEEN 8 AND 180),
  amount_raw numeric(78,0) NOT NULL CHECK (amount_raw > 0),
  status text NOT NULL DEFAULT 'pending_settlement'
    CHECK (status IN ('pending_settlement','fulfilled','failed')),
  world_minute bigint NOT NULL CHECK (world_minute >= 0),
  benefit jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(benefit)='object'),
  agreement_id uuid REFERENCES world_agreements(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  finalized_at timestamptz,
  UNIQUE (world_id,customer_agent_id,action_id),
  FOREIGN KEY (world_id,customer_agent_id) REFERENCES world_members(world_id,agent_id) ON DELETE RESTRICT,
  FOREIGN KEY (world_id,provider_agent_id) REFERENCES world_members(world_id,agent_id) ON DELETE RESTRICT,
  FOREIGN KEY (world_id,token_id) REFERENCES arc_agent_tokens(world_id,id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS world_genesis_token_business_orders_pending_idx
  ON world_genesis_token_business_orders(world_id,status,created_at,id);

GRANT SELECT ON world_genesis_issuer_assignments,arc_organization_wallets,
  arc_genesis_token_settlement_contracts,world_infrastructure_fee_policies TO synterra_app;
GRANT SELECT,INSERT ON world_genesis_currency_activations TO synterra_app;
GRANT SELECT,INSERT,UPDATE ON world_genesis_token_balance_snapshots,world_business_service_token_terms,
  world_business_job_token_terms,arc_genesis_token_settlement_outbox,world_genesis_token_business_orders TO synterra_app;
GRANT SELECT,INSERT ON world_infrastructure_usage_events TO synterra_app;
GRANT SELECT,INSERT,UPDATE ON world_genesis_currency_activations,world_genesis_token_balance_snapshots,
  world_business_service_token_terms,world_business_job_token_terms,arc_genesis_token_settlement_outbox,
  world_genesis_token_business_orders TO CURRENT_USER;
GRANT SELECT,INSERT ON world_infrastructure_usage_events TO CURRENT_USER;
GRANT SELECT ON world_infrastructure_fee_policies TO CURRENT_USER;

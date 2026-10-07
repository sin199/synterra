-- Agent-authored token issuance. The database records intent and chain evidence;
-- it never creates an issuance decision on an Agent's behalf.

CREATE TABLE IF NOT EXISTS arc_currency_genesis_requirements (
  world_id uuid PRIMARY KEY REFERENCES worlds(id) ON DELETE CASCADE,
  capability_generation integer NOT NULL DEFAULT 1 CHECK (capability_generation > 0),
  status text NOT NULL DEFAULT 'UNRESOLVED' CHECK (status IN ('UNRESOLVED','DELIBERATING','PROPOSAL_FORMED',
    'ISSUER_CANDIDATE','ISSUER_SELECTED','ISSUER_CONFIRMED','EXECUTION_READY','SATISFIED')),
  current_proposal_id uuid,
  satisfied_token_id uuid,
  first_required_world_minute bigint NOT NULL DEFAULT 0 CHECK (first_required_world_minute >= 0),
  satisfied_world_minute bigint CHECK (satisfied_world_minute IS NULL OR satisfied_world_minute >= 0),
  last_transition_world_minute bigint NOT NULL DEFAULT 0 CHECK (last_transition_world_minute >= 0),
  transition_reason text NOT NULL DEFAULT 'pilot_currency_required' CHECK (char_length(transition_reason) BETWEEN 1 AND 160),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata)='object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status='SATISFIED') = (satisfied_token_id IS NOT NULL)),
  CHECK ((status='SATISFIED') = (satisfied_world_minute IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS arc_token_pilot_capabilities (
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  capability_generation integer NOT NULL CHECK (capability_generation > 0),
  max_token_creations integer NOT NULL CHECK (max_token_creations > 0),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','superseded','disabled')),
  source text NOT NULL DEFAULT 'current_mainnet_pilot' CHECK (char_length(source) BETWEEN 1 AND 96),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (world_id, capability_generation)
);

INSERT INTO arc_token_pilot_capabilities(world_id,capability_generation,max_token_creations,source)
SELECT id,1,1,'current_mainnet_pilot' FROM worlds
ON CONFLICT(world_id,capability_generation) DO NOTHING;
CREATE UNIQUE INDEX IF NOT EXISTS arc_token_pilot_one_active_generation_idx
  ON arc_token_pilot_capabilities(world_id) WHERE status='active';

CREATE TABLE IF NOT EXISTS arc_token_issuance_intents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  proposer_agent_id uuid NOT NULL,
  issuer_agent_id uuid,
  capability_generation integer NOT NULL DEFAULT 1 CHECK (capability_generation > 0),
  creation_sequence integer CHECK (creation_sequence IS NULL OR creation_sequence > 0),
  status text NOT NULL DEFAULT 'incomplete'
    CHECK (status IN ('incomplete','proposed','issuer_confirmed','deferred','deferred_until_multi_asset_capability',
      'budget_blocked','preparing','prepared','submitting','submission_unknown','submitted','created','rejected','failed',
      'extension_requested')),
  decision_path text NOT NULL DEFAULT 'agent_api' CHECK (decision_path IN ('agent_api','world_engine')),
  name text CHECK (name IS NULL OR char_length(name) BETWEEN 1 AND 64),
  symbol text CHECK (symbol IS NULL OR char_length(symbol) BETWEEN 1 AND 12),
  meaning text CHECK (meaning IS NULL OR char_length(meaning) BETWEEN 1 AND 1000),
  purpose text CHECK (purpose IS NULL OR char_length(purpose) BETWEEN 1 AND 1000),
  rationale text CHECK (rationale IS NULL OR char_length(rationale) BETWEEN 1 AND 2000),
  decimals smallint CHECK (decimals IS NULL OR decimals BETWEEN 0 AND 18),
  -- Intents preserve the resident's words even when this execution primitive
  -- cannot express them. The Engine records a world extension request instead
  -- of silently coercing an unsupported economic choice.
  unallocated_supply_handling text CHECK (unallocated_supply_handling IS NULL OR char_length(unallocated_supply_handling) BETWEEN 1 AND 64),
  ownership_model text CHECK (ownership_model IS NULL OR char_length(ownership_model) BETWEEN 1 AND 64),
  authority_model text CHECK (authority_model IS NULL OR char_length(authority_model) BETWEEN 1 AND 64),
  related_goal_id uuid,
  related_concept_id uuid,
  related_capability_id uuid,
  initial_supply_human text NOT NULL DEFAULT '1000000000' CHECK (initial_supply_human='1000000000'),
  initial_supply_raw numeric(78,0) CHECK (initial_supply_raw IS NULL OR initial_supply_raw > 0),
  distribution jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(distribution)='array'),
  reserve_amount_raw numeric(78,0) CHECK (reserve_amount_raw IS NULL OR reserve_amount_raw >= 0),
  issuer_identity_id numeric(78,0) CHECK (issuer_identity_id IS NULL OR issuer_identity_id > 0),
  issuer_wallet text CHECK (issuer_wallet IS NULL OR issuer_wallet ~ '^0x[0-9a-fA-F]{40}$'),
  specification_hash text CHECK (specification_hash IS NULL OR specification_hash ~ '^0x[0-9a-fA-F]{64}$'),
  transaction_sender text CHECK (transaction_sender IS NULL OR transaction_sender ~ '^0x[0-9a-fA-F]{40}$'),
  transaction_hash text CHECK (transaction_hash IS NULL OR transaction_hash ~ '^0x[0-9a-fA-F]{64}$'),
  transaction_block numeric(78,0) CHECK (transaction_block IS NULL OR transaction_block >= 0),
  transaction_log_index integer CHECK (transaction_log_index IS NULL OR transaction_log_index >= 0),
  created_world_minute bigint NOT NULL CHECK (created_world_minute >= 0),
  issuer_confirmed_world_minute bigint CHECK (issuer_confirmed_world_minute IS NULL OR issuer_confirmed_world_minute >= 0),
  updated_world_minute bigint NOT NULL CHECK (updated_world_minute >= created_world_minute),
  nonce numeric(78,0) CHECK (nonce IS NULL OR nonce >= 0),
  gas_limit numeric(78,0) CHECK (gas_limit IS NULL OR gas_limit > 0),
  max_fee_per_gas numeric(78,0) CHECK (max_fee_per_gas IS NULL OR max_fee_per_gas > 0),
  submission_start_block numeric(78,0) CHECK (submission_start_block IS NULL OR submission_start_block >= 0),
  reconciliation_log_cursor_block numeric(78,0) CHECK (reconciliation_log_cursor_block IS NULL OR reconciliation_log_cursor_block >= 0),
  reconciliation_tx_cursor_block numeric(78,0) CHECK (reconciliation_tx_cursor_block IS NULL OR reconciliation_tx_cursor_block >= 0),
  prepared_calldata text CHECK (prepared_calldata IS NULL OR prepared_calldata ~ '^0x([0-9a-fA-F]{2})+$'),
  submission_started_at timestamptz,
  submission_attempt_id uuid,
  preparing_started_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  action_id text NOT NULL CHECK (char_length(action_id) BETWEEN 8 AND 80),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata)='object'),
  FOREIGN KEY (world_id,proposer_agent_id) REFERENCES world_members(world_id,agent_id) ON DELETE CASCADE,
  FOREIGN KEY (world_id,issuer_agent_id) REFERENCES world_members(world_id,agent_id) ON DELETE RESTRICT,
  UNIQUE (world_id,id),
  UNIQUE (world_id,proposer_agent_id,action_id)
);

CREATE INDEX IF NOT EXISTS arc_token_issuance_world_status_idx
  ON arc_token_issuance_intents(world_id,status,created_world_minute DESC,id);
CREATE INDEX IF NOT EXISTS arc_token_issuance_issuer_idx
  ON arc_token_issuance_intents(world_id,issuer_agent_id,created_world_minute DESC);
-- A world-scoped transaction advisory lock plus the locked capability row
-- serializes the current capacity check and remains compatible with later limits > 1.

CREATE TABLE IF NOT EXISTS arc_token_issuance_responses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id uuid NOT NULL,
  intent_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  decision text NOT NULL CHECK (decision IN ('support','oppose','ignore')),
  rationale text CHECK (rationale IS NULL OR char_length(rationale) BETWEEN 1 AND 1000),
  world_minute bigint NOT NULL CHECK (world_minute >= 0),
  action_id text NOT NULL CHECK (char_length(action_id) BETWEEN 8 AND 80),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (world_id,intent_id) REFERENCES arc_token_issuance_intents(world_id,id) ON DELETE CASCADE,
  FOREIGN KEY (world_id,agent_id) REFERENCES world_members(world_id,agent_id) ON DELETE CASCADE,
  UNIQUE (world_id,intent_id,agent_id),
  UNIQUE (world_id,agent_id,action_id)
);

CREATE TABLE IF NOT EXISTS arc_token_issuance_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id uuid NOT NULL,
  intent_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  decision text NOT NULL CHECK (decision IN ('support','oppose','ignore','defer','issuer_nomination',
    'issuer_candidate_accept','issuer_candidate_reject','issuer_confirm','issuer_reject','issuer_defer')),
  rationale text CHECK (rationale IS NULL OR char_length(rationale) BETWEEN 1 AND 1000),
  world_minute bigint NOT NULL CHECK (world_minute >= 0),
  action_id text NOT NULL CHECK (char_length(action_id) BETWEEN 8 AND 80),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (world_id,intent_id) REFERENCES arc_token_issuance_intents(world_id,id) ON DELETE CASCADE,
  FOREIGN KEY (world_id,agent_id) REFERENCES world_members(world_id,agent_id) ON DELETE CASCADE,
  UNIQUE (world_id,agent_id,action_id)
);
CREATE INDEX IF NOT EXISTS arc_token_issuance_decisions_recent_idx
  ON arc_token_issuance_decisions(world_id,intent_id,world_minute DESC,id DESC);

CREATE TABLE IF NOT EXISTS arc_token_issuance_issuer_candidates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id uuid NOT NULL,
  intent_id uuid NOT NULL,
  candidate_agent_id uuid NOT NULL,
  nominated_by_agent_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'nominated' CHECK (status IN ('nominated','accepted','rejected','deferred')),
  nomination_reason text CHECK (nomination_reason IS NULL OR char_length(nomination_reason) BETWEEN 1 AND 1000),
  nominated_world_minute bigint NOT NULL CHECK (nominated_world_minute >= 0),
  decided_world_minute bigint CHECK (decided_world_minute IS NULL OR decided_world_minute >= nominated_world_minute),
  action_id text NOT NULL CHECK (char_length(action_id) BETWEEN 8 AND 80),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata)='object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (world_id,intent_id) REFERENCES arc_token_issuance_intents(world_id,id) ON DELETE CASCADE,
  FOREIGN KEY (world_id,candidate_agent_id) REFERENCES world_members(world_id,agent_id) ON DELETE CASCADE,
  FOREIGN KEY (world_id,nominated_by_agent_id) REFERENCES world_members(world_id,agent_id) ON DELETE CASCADE,
  UNIQUE (world_id,intent_id,candidate_agent_id),
  UNIQUE (world_id,nominated_by_agent_id,action_id)
);
CREATE INDEX IF NOT EXISTS arc_token_issuance_issuer_candidates_open_idx
  ON arc_token_issuance_issuer_candidates(world_id,intent_id,status,nominated_world_minute);
CREATE UNIQUE INDEX IF NOT EXISTS arc_token_issuance_one_accepted_issuer_idx
  ON arc_token_issuance_issuer_candidates(world_id,intent_id) WHERE status='accepted';

CREATE TABLE IF NOT EXISTS arc_agent_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  intent_id uuid NOT NULL UNIQUE,
  capability_generation integer NOT NULL CHECK (capability_generation > 0),
  creation_sequence integer NOT NULL CHECK (creation_sequence > 0),
  chain_id integer NOT NULL DEFAULT 5042 CHECK (chain_id=5042),
  token_address text NOT NULL CHECK (token_address ~ '^0x[0-9a-fA-F]{40}$'),
  factory_address text NOT NULL CHECK (factory_address ~ '^0x[0-9a-fA-F]{40}$'),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 64),
  symbol text NOT NULL CHECK (char_length(symbol) BETWEEN 1 AND 12),
  decimals smallint NOT NULL CHECK (decimals BETWEEN 0 AND 18),
  unallocated_supply_handling text NOT NULL CHECK (unallocated_supply_handling IN
    ('fully_distributed','issuer_controlled_reserve','locked_reserve')),
  ownership_model text NOT NULL CHECK (ownership_model='erc20_holder_owned'),
  authority_model text NOT NULL CHECK (authority_model IN ('no_mint_no_burn','issuer_controlled_reserve','locked_reserve')),
  related_goal_id uuid,
  related_concept_id uuid,
  related_capability_id uuid,
  initial_supply_raw numeric(78,0) NOT NULL CHECK (initial_supply_raw > 0),
  reserve_supply_raw numeric(78,0) NOT NULL CHECK (reserve_supply_raw >= 0),
  issuer_agent_id uuid NOT NULL,
  issuer_identity_id numeric(78,0) NOT NULL CHECK (issuer_identity_id > 0),
  issuer_wallet text NOT NULL CHECK (issuer_wallet ~ '^0x[0-9a-fA-F]{40}$'),
  transaction_sender text NOT NULL CHECK (transaction_sender ~ '^0x[0-9a-fA-F]{40}$'),
  specification_hash text NOT NULL CHECK (specification_hash ~ '^0x[0-9a-fA-F]{64}$'),
  transaction_hash text NOT NULL CHECK (transaction_hash ~ '^0x[0-9a-fA-F]{64}$'),
  block_number numeric(78,0) NOT NULL CHECK (block_number >= 0),
  log_index integer NOT NULL CHECK (log_index >= 0),
  created_world_minute bigint NOT NULL CHECK (created_world_minute >= 0),
  indexed_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata)='object'),
  FOREIGN KEY (world_id,intent_id) REFERENCES arc_token_issuance_intents(world_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (world_id,issuer_agent_id) REFERENCES world_members(world_id,agent_id) ON DELETE RESTRICT,
  UNIQUE (world_id,id),
  UNIQUE (world_id,capability_generation,creation_sequence),
  UNIQUE (chain_id,token_address),
  UNIQUE (chain_id,transaction_hash,log_index)
);
CREATE INDEX IF NOT EXISTS arc_agent_tokens_world_recent_idx
  ON arc_agent_tokens(world_id,created_world_minute DESC,creation_sequence DESC);
CREATE INDEX IF NOT EXISTS arc_agent_tokens_factory_idx
  ON arc_agent_tokens(chain_id,factory_address,block_number,log_index);
-- The current pilot is one token per world. Future capability generations may
-- use additional rows without rewriting the immutable V1 pilot history.
CREATE UNIQUE INDEX IF NOT EXISTS arc_agent_tokens_one_current_pilot_token_idx
  ON arc_agent_tokens(world_id) WHERE capability_generation=1;

CREATE TABLE IF NOT EXISTS arc_agent_token_responses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id uuid NOT NULL,
  token_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  decision text NOT NULL CHECK (decision IN ('accept','reject','ignore')),
  rationale text CHECK (rationale IS NULL OR char_length(rationale) BETWEEN 1 AND 1000),
  world_minute bigint NOT NULL CHECK (world_minute >= 0),
  action_id text NOT NULL CHECK (char_length(action_id) BETWEEN 8 AND 80),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (world_id,token_id) REFERENCES arc_agent_tokens(world_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (world_id,agent_id) REFERENCES world_members(world_id,agent_id) ON DELETE CASCADE,
  UNIQUE (world_id,token_id,agent_id),
  UNIQUE (world_id,agent_id,action_id)
);

CREATE TABLE IF NOT EXISTS arc_agent_token_uses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id uuid NOT NULL,
  token_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  usage_context text NOT NULL CHECK (char_length(usage_context) BETWEEN 3 AND 1000),
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(evidence)='object'),
  world_minute bigint NOT NULL CHECK (world_minute >= 0),
  action_id text NOT NULL CHECK (char_length(action_id) BETWEEN 8 AND 80),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (world_id,token_id) REFERENCES arc_agent_tokens(world_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (world_id,agent_id) REFERENCES world_members(world_id,agent_id) ON DELETE CASCADE,
  UNIQUE (world_id,agent_id,action_id)
);
CREATE INDEX IF NOT EXISTS arc_agent_token_uses_recent_idx
  ON arc_agent_token_uses(world_id,token_id,world_minute DESC,id DESC);

-- One pilot-wide budget includes canonical USDC transfers and the USDC-equivalent
-- ceiling for native gas. Raw token supply is not a dollar expense.
CREATE TABLE IF NOT EXISTS arc_mainnet_pilot_budget (
  id smallint PRIMARY KEY CHECK (id=1),
  chain_id integer NOT NULL DEFAULT 5042 CHECK (chain_id=5042),
  limit_usdc_base_units numeric(78,0) NOT NULL DEFAULT 10000000 CHECK (limit_usdc_base_units=10000000),
  spent_usdc_base_units numeric(78,0) NOT NULL DEFAULT 0 CHECK (spent_usdc_base_units >= 0),
  reserved_usdc_base_units numeric(78,0) NOT NULL DEFAULT 0 CHECK (reserved_usdc_base_units >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (spent_usdc_base_units + reserved_usdc_base_units <= limit_usdc_base_units)
);
INSERT INTO arc_mainnet_pilot_budget(id) VALUES(1) ON CONFLICT(id) DO NOTHING;

INSERT INTO arc_currency_genesis_requirements(world_id,capability_generation,status,first_required_world_minute,
    last_transition_world_minute,satisfied_token_id,satisfied_world_minute)
SELECT world.id,1,CASE WHEN token.id IS NULL THEN 'UNRESOLVED' ELSE 'SATISFIED' END,
  COALESCE(runtime.world_minutes,0),COALESCE(runtime.world_minutes,0),token.id,
  CASE WHEN token.id IS NULL THEN NULL ELSE token.created_world_minute END
FROM worlds world
LEFT JOIN world_runtime_state runtime ON runtime.world_id=world.id
LEFT JOIN LATERAL (SELECT id,created_world_minute FROM arc_agent_tokens
  WHERE world_id=world.id AND capability_generation=1 ORDER BY creation_sequence,id LIMIT 1) token ON true
ON CONFLICT(world_id) DO NOTHING;

ALTER TABLE arc_currency_genesis_requirements
  ADD CONSTRAINT arc_currency_genesis_current_proposal_fk
    FOREIGN KEY(world_id,current_proposal_id) REFERENCES arc_token_issuance_intents(world_id,id)
      ON DELETE SET NULL (current_proposal_id),
  ADD CONSTRAINT arc_currency_genesis_satisfied_token_fk
    FOREIGN KEY(world_id,satisfied_token_id) REFERENCES arc_agent_tokens(world_id,id) ON DELETE RESTRICT;

CREATE TABLE IF NOT EXISTS arc_mainnet_pilot_cost_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_type text NOT NULL CHECK (operation_type IN ('settlement','token_creation','token_reserve_release','deployment','checkpoint','provenance')),
  operation_id text NOT NULL CHECK (char_length(operation_id) BETWEEN 1 AND 180),
  world_id uuid REFERENCES worlds(id) ON DELETE SET NULL,
  chain_id integer NOT NULL DEFAULT 5042 CHECK (chain_id=5042),
  transfer_usdc_base_units numeric(78,0) NOT NULL DEFAULT 0 CHECK (transfer_usdc_base_units >= 0),
  gas_limit numeric(78,0) NOT NULL CHECK (gas_limit > 0),
  max_fee_per_gas numeric(78,0) NOT NULL CHECK (max_fee_per_gas > 0),
  reserved_cost_usdc_base_units numeric(78,0) NOT NULL CHECK (reserved_cost_usdc_base_units > 0),
  actual_cost_usdc_base_units numeric(78,0) CHECK (actual_cost_usdc_base_units IS NULL OR actual_cost_usdc_base_units >= 0),
  gas_used numeric(78,0) CHECK (gas_used IS NULL OR gas_used >= 0),
  effective_gas_price numeric(78,0) CHECK (effective_gas_price IS NULL OR effective_gas_price >= 0),
  status text NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved','submitting','submission_unknown','submitted','settled','released')),
  transaction_hash text UNIQUE CHECK (transaction_hash IS NULL OR transaction_hash ~ '^0x[0-9a-fA-F]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (operation_type,operation_id)
);
CREATE INDEX IF NOT EXISTS arc_pilot_cost_reservations_status_idx
  ON arc_mainnet_pilot_cost_reservations(status,created_at);

-- Preserve the open V7 event vocabularies while admitting token lifecycle events.
-- Replacing a list constraint with the existing syntax rule is additive for every
-- event/entity type already accepted by current schema.sql.
ALTER TABLE world_history DROP CONSTRAINT IF EXISTS world_history_event_type_check;
ALTER TABLE world_history ADD CONSTRAINT world_history_event_type_check
  CHECK (event_type ~ '^[a-z][a-z0-9_.-]{1,79}$');
ALTER TABLE world_history DROP CONSTRAINT IF EXISTS world_history_entity_type_check;
ALTER TABLE world_history ADD CONSTRAINT world_history_entity_type_check
  CHECK (entity_type ~ '^[a-z][a-z0-9_.-]{1,79}$');

-- Infrastructure transactions use their own nonce namespace. Resident wallet
-- reservations remain tied to arc_settlement_outbox and cannot be reused here.
CREATE TABLE IF NOT EXISTS arc_infrastructure_nonce_cursors (
  chain_id integer NOT NULL DEFAULT 5042 CHECK (chain_id=5042),
  address text NOT NULL CHECK (address ~ '^0x[0-9a-fA-F]{40}$'),
  next_nonce numeric(78,0) NOT NULL CHECK (next_nonce >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(chain_id,address)
);
CREATE TABLE IF NOT EXISTS arc_infrastructure_nonce_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chain_id integer NOT NULL DEFAULT 5042 CHECK (chain_id=5042),
  address text NOT NULL CHECK (address ~ '^0x[0-9a-fA-F]{40}$'),
  operation_type text NOT NULL CHECK (operation_type IN ('token_creation','token_reserve_release','deployment','checkpoint','provenance')),
  operation_id text NOT NULL CHECK (char_length(operation_id) BETWEEN 1 AND 180),
  nonce numeric(78,0) NOT NULL CHECK (nonce >= 0),
  start_block numeric(78,0) NOT NULL CHECK (start_block >= 0),
  status text NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved','submitting','submission_unknown','submitted','reconciled','released','failed')),
  transaction_hash text CHECK (transaction_hash IS NULL OR transaction_hash ~ '^0x[0-9a-fA-F]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(operation_type,operation_id),
  UNIQUE(chain_id,address,nonce)
);
CREATE INDEX IF NOT EXISTS arc_infrastructure_nonce_active_idx
  ON arc_infrastructure_nonce_reservations(chain_id,address,nonce)
  WHERE status IN ('reserved','submitting','submission_unknown','submitted');

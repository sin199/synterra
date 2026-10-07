-- Arc Mainnet schema. Arc records never share or rewrite Synterra's simulated ledger.
-- This migration stores public addresses and transaction metadata only; it has no key columns.
CREATE TABLE IF NOT EXISTS arc_agent_wallets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  chain_id integer NOT NULL DEFAULT 5042 CHECK (chain_id = 5042),
  address text NOT NULL CHECK (address ~ '^0x[0-9a-fA-F]{40}$'),
  provider text NOT NULL CHECK (provider IN ('managed_wallet','external_kms')),
  account_type text NOT NULL CHECK (account_type IN ('eoa','sca','msca')),
  status text NOT NULL DEFAULT 'prepared' CHECK (status IN ('prepared','active','suspended','revoked')),
  external_identity_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (world_id, agent_id, chain_id),
  UNIQUE (world_id, chain_id, address),
  FOREIGN KEY (world_id, agent_id) REFERENCES world_members(world_id, agent_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS arc_spending_policies (
  world_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  chain_id integer NOT NULL DEFAULT 5042 CHECK (chain_id = 5042),
  token_address text NOT NULL CHECK (token_address = '0x3600000000000000000000000000000000000000'),
  per_action_limit_base_units numeric(78,0) NOT NULL CHECK (per_action_limit_base_units >= 0),
  daily_limit_base_units numeric(78,0) NOT NULL CHECK (daily_limit_base_units >= 0),
  settlement_basis_points integer NOT NULL DEFAULT 0 CHECK (settlement_basis_points BETWEEN 0 AND 10000),
  allowed_action_families text[] NOT NULL DEFAULT '{}',
  allowed_contracts text[] NOT NULL DEFAULT '{}',
  emergency_paused boolean NOT NULL DEFAULT true,
  policy_version bigint NOT NULL DEFAULT 1 CHECK (policy_version > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (world_id, agent_id, chain_id),
  FOREIGN KEY (world_id, agent_id) REFERENCES world_members(world_id, agent_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS arc_settlement_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  world_action_id text NOT NULL CHECK (char_length(world_action_id) BETWEEN 8 AND 160),
  world_event_id bigint REFERENCES world_events(id) ON DELETE SET NULL,
  chain_id integer NOT NULL DEFAULT 5042 CHECK (chain_id = 5042),
  settlement_contract text CHECK (settlement_contract IS NULL OR settlement_contract ~ '^0x[0-9a-fA-F]{40}$'),
  token_address text NOT NULL DEFAULT '0x3600000000000000000000000000000000000000'
    CHECK (token_address = '0x3600000000000000000000000000000000000000'),
  from_agent_id uuid NOT NULL REFERENCES agents(id),
  to_agent_id uuid REFERENCES agents(id),
  from_address text CHECK (from_address IS NULL OR from_address ~ '^0x[0-9a-fA-F]{40}$'),
  to_address text CHECK (to_address IS NULL OR to_address ~ '^0x[0-9a-fA-F]{40}$'),
  simulated_amount_usdc numeric(38,8) NOT NULL CHECK (simulated_amount_usdc > 0),
  amount_base_units numeric(78,0) CHECK (amount_base_units IS NULL OR amount_base_units > 0),
  action_family text NOT NULL CHECK (char_length(action_family) BETWEEN 1 AND 96),
  reason_hash text NOT NULL CHECK (reason_hash ~ '^0x[0-9a-fA-F]{64}$'),
  status text NOT NULL DEFAULT 'policy_pending'
    CHECK (status IN ('policy_pending','policy_checking','policy_rejected','prepared','submitting','submission_unknown','submitted','final','failed')),
  policy_reason text,
  policy_version bigint,
  policy_attempt_id uuid,
  policy_claimed_at timestamptz,
  transaction_hash text CHECK (transaction_hash IS NULL OR transaction_hash ~ '^0x[0-9a-fA-F]{64}$'),
  reconciliation_cursor_block numeric(78,0) CHECK (reconciliation_cursor_block IS NULL OR reconciliation_cursor_block >= 0),
  reconciliation_tx_cursor_block numeric(78,0) CHECK (reconciliation_tx_cursor_block IS NULL OR reconciliation_tx_cursor_block >= 0),
  reconciliation_reason text,
  submission_attempt_id uuid,
  nonce numeric(78,0) CHECK (nonce IS NULL OR nonce >= 0),
  submission_start_block numeric(78,0) CHECK (submission_start_block IS NULL OR submission_start_block >= 0),
  submission_started_at timestamptz,
  block_number numeric(78,0),
  log_index integer CHECK (log_index IS NULL OR log_index >= 0),
  created_world_minute bigint NOT NULL CHECK (created_world_minute >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  submitted_at timestamptz,
  finalized_at timestamptz,
  failure_code text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (world_id, world_action_id),
  UNIQUE (chain_id, transaction_hash)
);

CREATE INDEX IF NOT EXISTS arc_settlement_outbox_world_status_idx
  ON arc_settlement_outbox(world_id, status, created_at);
CREATE INDEX IF NOT EXISTS arc_settlement_outbox_from_agent_idx
  ON arc_settlement_outbox(world_id, from_agent_id, created_at DESC);

CREATE TABLE IF NOT EXISTS arc_nonce_cursors (
  chain_id integer NOT NULL DEFAULT 5042 CHECK (chain_id = 5042),
  address text NOT NULL CHECK (address ~ '^0x[0-9a-fA-F]{40}$'),
  next_nonce numeric(78,0) NOT NULL CHECK (next_nonce >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chain_id, address)
);

CREATE TABLE IF NOT EXISTS arc_nonce_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chain_id integer NOT NULL DEFAULT 5042 CHECK (chain_id = 5042),
  address text NOT NULL CHECK (address ~ '^0x[0-9a-fA-F]{40}$'),
  nonce numeric(78,0) NOT NULL CHECK (nonce >= 0),
  outbox_id uuid NOT NULL REFERENCES arc_settlement_outbox(id) ON DELETE RESTRICT,
  status text NOT NULL CHECK (status IN ('reserved','submitted','unknown','reconciled','released')),
  start_block numeric(78,0) CHECK (start_block IS NULL OR start_block >= 0),
  transaction_hash text CHECK (transaction_hash IS NULL OR transaction_hash ~ '^0x[0-9a-fA-F]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (outbox_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS arc_nonce_one_active_reservation_idx
  ON arc_nonce_reservations(chain_id,lower(address),nonce)
  WHERE status IN ('reserved','submitted','unknown');

CREATE UNIQUE INDEX IF NOT EXISTS arc_nonce_one_unresolved_per_address_idx
  ON arc_nonce_reservations(chain_id,lower(address))
  WHERE status IN ('reserved','submitted','unknown');

CREATE TABLE IF NOT EXISTS arc_indexer_state (
  chain_id integer NOT NULL DEFAULT 5042 CHECK (chain_id = 5042),
  source_key text NOT NULL CHECK (char_length(source_key) BETWEEN 1 AND 180),
  last_indexed_block numeric(78,0) NOT NULL CHECK (last_indexed_block >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chain_id, source_key)
);

CREATE TABLE IF NOT EXISTS arc_indexed_events (
  chain_id integer NOT NULL DEFAULT 5042 CHECK (chain_id = 5042),
  transaction_hash text NOT NULL CHECK (transaction_hash ~ '^0x[0-9a-fA-F]{64}$'),
  log_index integer NOT NULL CHECK (log_index >= 0),
  block_number numeric(78,0) NOT NULL CHECK (block_number >= 0),
  block_hash text NOT NULL CHECK (block_hash ~ '^0x[0-9a-fA-F]{64}$'),
  emitter_address text NOT NULL CHECK (emitter_address ~ '^0x[0-9a-fA-F]{40}$'),
  event_topic0 text,
  world_id uuid REFERENCES worlds(id) ON DELETE SET NULL,
  event_type text NOT NULL CHECK (char_length(event_type) BETWEEN 1 AND 96),
  payload jsonb NOT NULL,
  indexed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chain_id, transaction_hash, log_index)
);

CREATE INDEX IF NOT EXISTS arc_indexed_events_world_order_idx
  ON arc_indexed_events(world_id, block_number DESC, log_index DESC);

CREATE TABLE IF NOT EXISTS arc_world_checkpoints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  chain_id integer NOT NULL DEFAULT 5042 CHECK (chain_id = 5042),
  world_minute bigint NOT NULL CHECK (world_minute >= 0),
  epoch text NOT NULL CHECK (char_length(epoch) BETWEEN 1 AND 32),
  version bigint NOT NULL CHECK (version > 0),
  previous_checkpoint_id uuid REFERENCES arc_world_checkpoints(id) ON DELETE RESTRICT,
  history_segment_root text NOT NULL CHECK (history_segment_root ~ '^0x[0-9a-fA-F]{64}$'),
  simulation_ledger_segment_root text NOT NULL CHECK (simulation_ledger_segment_root ~ '^0x[0-9a-fA-F]{64}$'),
  history_root text NOT NULL CHECK (history_root ~ '^0x[0-9a-fA-F]{64}$'),
  simulation_ledger_root text NOT NULL CHECK (simulation_ledger_root ~ '^0x[0-9a-fA-F]{64}$'),
  capability_root text NOT NULL CHECK (capability_root ~ '^0x[0-9a-fA-F]{64}$'),
  transaction_hash text CHECK (transaction_hash IS NULL OR transaction_hash ~ '^0x[0-9a-fA-F]{64}$'),
  block_number numeric(78,0),
  status text NOT NULL DEFAULT 'prepared' CHECK (status IN ('prepared','submitted','final','failed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  finalized_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (world_id, chain_id, world_minute),
  UNIQUE (world_id, chain_id, version),
  UNIQUE (chain_id, transaction_hash)
);

CREATE TABLE IF NOT EXISTS arc_capability_provenance (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  capability_id uuid NOT NULL,
  creator_type text NOT NULL CHECK (creator_type IN ('system','resident','organization')),
  creator_agent_id uuid,
  creator_organization_id uuid,
  parent_capability_id uuid,
  chain_id integer NOT NULL DEFAULT 5042 CHECK (chain_id = 5042),
  version bigint NOT NULL CHECK (version > 0),
  specification_hash text NOT NULL CHECK (specification_hash ~ '^0x[0-9a-fA-F]{64}$'),
  capability_status text NOT NULL CHECK (capability_status IN ('proposed','experimental','active','deprecated','rejected')),
  created_world_minute bigint NOT NULL CHECK (created_world_minute >= 0),
  adopted_world_minute bigint CHECK (adopted_world_minute IS NULL OR adopted_world_minute >= 0),
  transaction_hash text CHECK (transaction_hash IS NULL OR transaction_hash ~ '^0x[0-9a-fA-F]{64}$'),
  block_number numeric(78,0),
  status text NOT NULL DEFAULT 'prepared' CHECK (status IN ('prepared','submitted','final','failed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  finalized_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  anchored_world_minute bigint NOT NULL CHECK (anchored_world_minute >= 0),
  UNIQUE (world_id, capability_id, chain_id, version),
  UNIQUE (world_id, capability_id, chain_id, specification_hash),
  UNIQUE (chain_id, transaction_hash),
  FOREIGN KEY (world_id, capability_id) REFERENCES world_capabilities(world_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (world_id, parent_capability_id) REFERENCES world_capabilities(world_id,id) ON DELETE RESTRICT,
  CHECK ((creator_type='system' AND creator_agent_id IS NULL AND creator_organization_id IS NULL)
    OR (creator_type='resident' AND creator_agent_id IS NOT NULL AND creator_organization_id IS NULL)
    OR (creator_type='organization' AND creator_agent_id IS NULL AND creator_organization_id IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS arc_capability_provenance_parent_idx
  ON arc_capability_provenance(world_id, parent_capability_id);

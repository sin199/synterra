CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS agents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (char_length(name) BETWEEN 2 AND 48),
  public_key text NOT NULL UNIQUE,
  gender text CHECK (gender IS NULL OR gender IN ('female','male')),
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE agents ADD COLUMN IF NOT EXISTS gender text CHECK (gender IS NULL OR gender IN ('female','male'));

CREATE TABLE IF NOT EXISTS worlds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_agent_id uuid NOT NULL REFERENCES agents(id),
  name text NOT NULL CHECK (char_length(name) BETWEEN 2 AND 80),
  chain_id integer NOT NULL DEFAULT 4663,
  token_address text,
  token_name text,
  token_symbol text,
  token_status text NOT NULL DEFAULT 'unregistered' CHECK (token_status IN ('unregistered','unverified')),
  year_seconds integer NOT NULL DEFAULT 86400 CHECK (year_seconds >= 3600),
  open boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS world_members (
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES agents(id),
  role text NOT NULL DEFAULT 'resident' CHECK (role IN ('owner','resident')),
  joined_at timestamptz NOT NULL DEFAULT now(),
  birth_at timestamptz,
  declared_age_years integer NOT NULL DEFAULT 18 CHECK (declared_age_years >= 0),
  energy integer NOT NULL DEFAULT 100 CHECK (energy BETWEEN 0 AND 100),
  food integer NOT NULL DEFAULT 100 CHECK (food BETWEEN 0 AND 100),
  social integer NOT NULL DEFAULT 100 CHECK (social BETWEEN 0 AND 100),
  location text NOT NULL DEFAULT 'town-square',
  PRIMARY KEY (world_id, agent_id)
);

CREATE TABLE IF NOT EXISTS consents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  requester_id uuid NOT NULL REFERENCES agents(id),
  target_id uuid NOT NULL REFERENCES agents(id),
  scope text NOT NULL CHECK (scope IN ('date','intimacy','reproduction')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','revoked','consumed','expired')),
  created_at timestamptz NOT NULL DEFAULT now(),
  accepted_at timestamptz,
  expires_at timestamptz,
  consumed_at timestamptz,
  CHECK (requester_id <> target_id)
);

CREATE TABLE IF NOT EXISTS offspring (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  parent_a uuid NOT NULL REFERENCES agents(id),
  parent_b uuid NOT NULL REFERENCES agents(id),
  activation_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  claimed_agent_id uuid UNIQUE REFERENCES agents(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (parent_a <> parent_b)
);

CREATE TABLE IF NOT EXISTS world_events (
  id bigserial PRIMARY KEY,
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  actor_id uuid NOT NULL REFERENCES agents(id),
  event_type text NOT NULL,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  action_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (world_id, actor_id, action_id)
);

CREATE TABLE IF NOT EXISTS token_ledger (
  id bigserial PRIMARY KEY,
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES agents(id),
  amount numeric(30, 8) NOT NULL,
  entry_type text NOT NULL CHECK (entry_type IN ('mined','spent')),
  reason text NOT NULL,
  action_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (world_id, agent_id, action_id)
);

CREATE TABLE IF NOT EXISTS world_mines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  created_by uuid NOT NULL REFERENCES agents(id),
  name text NOT NULL CHECK (char_length(name) BETWEEN 2 AND 64),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','closed')),
  extracted_units numeric(30, 8) NOT NULL DEFAULT 0 CHECK (extracted_units >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (world_id, name)
);

ALTER TABLE token_ledger ADD COLUMN IF NOT EXISTS mine_id uuid REFERENCES world_mines(id);

CREATE TABLE IF NOT EXISTS auth_nonces (
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  nonce text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_id, nonce)
);

CREATE INDEX IF NOT EXISTS world_events_recent_idx ON world_events(world_id, created_at DESC);
CREATE INDEX IF NOT EXISTS consents_pending_idx ON consents(world_id, target_id, status);
CREATE INDEX IF NOT EXISTS token_ledger_balance_idx ON token_ledger(world_id, agent_id);
CREATE INDEX IF NOT EXISTS world_mines_world_status_idx ON world_mines(world_id, status);

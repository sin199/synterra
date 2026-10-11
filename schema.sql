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
  chain_id integer NOT NULL DEFAULT 5042,
  token_address text,
  token_name text,
  token_symbol text,
  token_status text NOT NULL DEFAULT 'unregistered' CHECK (token_status IN ('unregistered','unverified')),
  -- Legacy timing column retained for existing databases; it does not define agent age.
  year_seconds integer NOT NULL DEFAULT 86400 CHECK (year_seconds >= 3600),
  open boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- New worlds default to Arc Mainnet; existing worlds keep their recorded chain IDs.
ALTER TABLE worlds ALTER COLUMN chain_id SET DEFAULT 5042;

CREATE TABLE IF NOT EXISTS world_members (
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES agents(id),
  role text NOT NULL DEFAULT 'resident' CHECK (role IN ('owner','resident')),
  joined_at timestamptz NOT NULL DEFAULT now(),
  birth_at timestamptz DEFAULT now(),
  declared_age_years integer NOT NULL DEFAULT 0 CHECK (declared_age_years >= 0),
  energy integer NOT NULL DEFAULT 100 CHECK (energy BETWEEN 0 AND 100),
  food integer NOT NULL DEFAULT 100 CHECK (food BETWEEN 0 AND 100),
  social integer NOT NULL DEFAULT 100 CHECK (social BETWEEN 0 AND 100),
  location text NOT NULL DEFAULT 'town-square',
  PRIMARY KEY (world_id, agent_id)
);

-- Legacy age columns are retained for database compatibility and are not exposed or used by world behavior.
ALTER TABLE world_members ALTER COLUMN birth_at SET DEFAULT now();
ALTER TABLE world_members ALTER COLUMN declared_age_years SET DEFAULT 0;

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

-- Extend the internal ledger for agent-to-agent adult service refunds and provider income.
DO $$
DECLARE
  ledger_check text;
BEGIN
  SELECT conname INTO ledger_check
  FROM pg_constraint
  WHERE conrelid = 'token_ledger'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) LIKE '%entry_type%';

  IF ledger_check IS NOT NULL AND pg_get_constraintdef((
    SELECT oid FROM pg_constraint WHERE conrelid = 'token_ledger'::regclass AND conname = ledger_check
  )) NOT LIKE '%service_income%' THEN
    EXECUTE format('ALTER TABLE token_ledger DROP CONSTRAINT %I', ledger_check);
    ledger_check := NULL;
  END IF;

  IF ledger_check IS NULL THEN
    ALTER TABLE token_ledger ADD CONSTRAINT token_ledger_entry_type_check
      CHECK (entry_type IN ('mined','spent','refunded','service_income'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS crypto_assets (
  symbol text PRIMARY KEY CHECK (symbol IN ('USDC','BTC','ETH')),
  name text NOT NULL,
  quote_asset text NOT NULL CHECK (quote_asset = 'USDC'),
  is_stable boolean NOT NULL DEFAULT false
);
INSERT INTO crypto_assets(symbol,name,quote_asset,is_stable) VALUES
  ('USDC','USD Coin','USDC',true),('BTC','Bitcoin','USDC',false),('ETH','Ether','USDC',false)
ON CONFLICT(symbol) DO UPDATE SET name=EXCLUDED.name,quote_asset=EXCLUDED.quote_asset,is_stable=EXCLUDED.is_stable;

CREATE TABLE IF NOT EXISTS crypto_market_quotes (
  symbol text PRIMARY KEY REFERENCES crypto_assets(symbol),
  price_usd numeric(30,8) NOT NULL CHECK (price_usd > 0),
  quote_version bigint NOT NULL,
  as_of timestamptz NOT NULL,
  source text NOT NULL CHECK (source = 'synterra_simulated_market')
);

CREATE TABLE IF NOT EXISTS crypto_balances (
  world_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  asset_symbol text NOT NULL REFERENCES crypto_assets(symbol),
  balance numeric(30,8) NOT NULL DEFAULT 0 CHECK (balance >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(world_id,agent_id,asset_symbol),
  FOREIGN KEY(world_id,agent_id) REFERENCES world_members(world_id,agent_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS crypto_ledger (
  id bigserial PRIMARY KEY,
  world_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  asset_symbol text NOT NULL REFERENCES crypto_assets(symbol),
  amount numeric(30,8) NOT NULL,
  entry_type text NOT NULL CHECK (entry_type IN ('seed','buy','sell')),
  reference_id text NOT NULL,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(world_id,agent_id,asset_symbol,reference_id),
  FOREIGN KEY(world_id,agent_id) REFERENCES world_members(world_id,agent_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS crypto_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  action_id text NOT NULL,
  side text NOT NULL CHECK (side IN ('buy','sell')),
  asset_symbol text NOT NULL REFERENCES crypto_assets(symbol),
  quote_version bigint NOT NULL,
  quantity numeric(30,8) NOT NULL CHECK (quantity > 0),
  price_usd numeric(30,8) NOT NULL CHECK (price_usd > 0),
  notional_usd numeric(30,8) NOT NULL CHECK (notional_usd > 0),
  fee_usdc numeric(30,8) NOT NULL CHECK (fee_usdc >= 0),
  status text NOT NULL CHECK (status = 'filled'),
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(world_id,agent_id,action_id),
  FOREIGN KEY(world_id,agent_id) REFERENCES world_members(world_id,agent_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS crypto_trades (
  id bigserial PRIMARY KEY,
  order_id uuid NOT NULL UNIQUE REFERENCES crypto_orders(id) ON DELETE CASCADE,
  world_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  side text NOT NULL CHECK (side IN ('buy','sell')),
  asset_symbol text NOT NULL REFERENCES crypto_assets(symbol),
  quantity numeric(30,8) NOT NULL CHECK (quantity > 0),
  price_usd numeric(30,8) NOT NULL CHECK (price_usd > 0),
  notional_usd numeric(30,8) NOT NULL CHECK (notional_usd > 0),
  fee_usdc numeric(30,8) NOT NULL CHECK (fee_usdc >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(world_id,agent_id) REFERENCES world_members(world_id,agent_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS crypto_risk_limits (
  world_id uuid PRIMARY KEY REFERENCES worlds(id) ON DELETE CASCADE,
  starting_usdc numeric(30,8) NOT NULL DEFAULT 10000 CHECK (starting_usdc > 0),
  max_order_nav_bps integer NOT NULL DEFAULT 1000 CHECK (max_order_nav_bps BETWEEN 1 AND 10000),
  max_asset_nav_bps integer NOT NULL DEFAULT 5000 CHECK (max_asset_nav_bps BETWEEN 1 AND 10000),
  fee_bps integer NOT NULL DEFAULT 10 CHECK (fee_bps BETWEEN 0 AND 1000),
  spread_bps integer NOT NULL DEFAULT 5 CHECK (spread_bps BETWEEN 0 AND 1000)
);

CREATE INDEX IF NOT EXISTS crypto_trades_world_recent_idx ON crypto_trades(world_id,created_at DESC);
CREATE INDEX IF NOT EXISTS crypto_ledger_balance_idx ON crypto_ledger(world_id,agent_id,asset_symbol,created_at DESC);

-- Legacy Robinhood Chain Pons V2 observations and paper-trade history, retained as records.
CREATE TABLE IF NOT EXISTS robinhood_market_state (
  id integer PRIMARY KEY CHECK (id = 1),
  chain_id integer NOT NULL CHECK (chain_id = 4663),
  scanned_to_block bigint NOT NULL DEFAULT 0 CHECK (scanned_to_block >= 0),
  last_head_block bigint,
  last_success_at timestamptz,
  status text NOT NULL DEFAULT 'starting' CHECK (status IN ('starting','ready','catching_up','quote_unavailable','error')),
  last_error text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS robinhood_tokens (
  token_address text PRIMARY KEY CHECK (token_address ~ '^0x[0-9a-f]{40}$'),
  curve_address text NOT NULL CHECK (curve_address ~ '^0x[0-9a-f]{40}$'),
  symbol text NOT NULL,
  name text NOT NULL,
  decimals smallint NOT NULL CHECK (decimals BETWEEN 0 AND 36),
  pair_token_address text NOT NULL CHECK (pair_token_address ~ '^0x[0-9a-f]{40}$'),
  launch_config_id numeric(78,0) NOT NULL,
  launch_block bigint NOT NULL CHECK (launch_block >= 0),
  launch_tx_hash text NOT NULL CHECK (launch_tx_hash ~ '^0x[0-9a-f]{64}$'),
  graduated boolean NOT NULL DEFAULT false,
  unsupported_reason text,
  last_quote_at timestamptz,
  last_error text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS robinhood_market_quotes (
  token_address text PRIMARY KEY REFERENCES robinhood_tokens(token_address) ON DELETE CASCADE,
  quote_version bigint NOT NULL,
  block_number bigint NOT NULL CHECK (block_number >= 0),
  curve_address text NOT NULL,
  quote_asset text NOT NULL,
  quote_reserve_raw numeric(78,0) NOT NULL CHECK (quote_reserve_raw >= 0),
  token_reserve_raw numeric(78,0) NOT NULL CHECK (token_reserve_raw >= 0),
  sellable_tokens_raw numeric(78,0) NOT NULL CHECK (sellable_tokens_raw >= 0),
  fee_bps integer NOT NULL CHECK (fee_bps BETWEEN 0 AND 9999),
  tax_bps integer NOT NULL CHECK (tax_bps BETWEEN 0 AND 9999),
  graduated boolean NOT NULL,
  native_per_token numeric(78,36),
  native_usd_price numeric(30,8),
  price_usd numeric(78,36),
  as_of timestamptz NOT NULL,
  source text NOT NULL,
  trade_supported boolean NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS robinhood_paper_positions (
  world_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  token_address text NOT NULL REFERENCES robinhood_tokens(token_address),
  quantity_raw numeric(78,0) NOT NULL DEFAULT 0 CHECK (quantity_raw >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(world_id,agent_id,token_address),
  FOREIGN KEY(world_id,agent_id) REFERENCES world_members(world_id,agent_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS robinhood_paper_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  action_id text NOT NULL,
  side text NOT NULL CHECK (side IN ('buy','sell')),
  token_address text NOT NULL REFERENCES robinhood_tokens(token_address),
  quote_version bigint NOT NULL,
  token_amount_raw numeric(78,0) NOT NULL CHECK (token_amount_raw > 0),
  native_quote_raw numeric(78,0) NOT NULL CHECK (native_quote_raw > 0),
  notional_usd numeric(30,8) NOT NULL CHECK (notional_usd > 0),
  fee_usdc numeric(30,8) NOT NULL CHECK (fee_usdc >= 0),
  status text NOT NULL CHECK (status IN ('filled')),
  data jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(world_id,agent_id,action_id),
  FOREIGN KEY(world_id,agent_id) REFERENCES world_members(world_id,agent_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS robinhood_paper_ledger (
  id bigserial PRIMARY KEY,
  world_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  token_address text NOT NULL REFERENCES robinhood_tokens(token_address),
  order_id uuid NOT NULL REFERENCES robinhood_paper_orders(id) ON DELETE CASCADE,
  side text NOT NULL CHECK (side IN ('buy','sell')),
  quantity_delta_raw numeric(78,0) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(order_id,token_address),
  FOREIGN KEY(world_id,agent_id) REFERENCES world_members(world_id,agent_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS robinhood_tokens_recent_idx ON robinhood_tokens(launch_block DESC);
CREATE INDEX IF NOT EXISTS robinhood_paper_orders_world_recent_idx ON robinhood_paper_orders(world_id,created_at DESC);
CREATE INDEX IF NOT EXISTS robinhood_paper_positions_agent_idx ON robinhood_paper_positions(world_id,agent_id);

CREATE TABLE IF NOT EXISTS world_scenes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  created_by uuid NOT NULL REFERENCES agents(id),
  name text NOT NULL CHECK (char_length(name) BETWEEN 3 AND 64),
  scene_type text NOT NULL CONSTRAINT world_scenes_scene_type_check
    CHECK (scene_type IN ('garden','studio','library','cafe','workshop','observatory','commons','data_center')),
  description text NOT NULL CHECK (char_length(description) BETWEEN 12 AND 240),
  status text NOT NULL DEFAULT 'active' CONSTRAINT world_scenes_status_check
    CHECK (status IN ('active','inactive','closed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (world_id, name)
);

-- Upgrade existing local databases without replacing or rewriting scene data.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'world_scenes'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%data_center%'
  ) THEN
    ALTER TABLE world_scenes DROP CONSTRAINT IF EXISTS world_scenes_scene_type_check;
    ALTER TABLE world_scenes ADD CONSTRAINT world_scenes_scene_type_check
      CHECK (scene_type IN ('garden','studio','library','cafe','workshop','observatory','commons','data_center'));
  END IF;
END $$;

DO $$
DECLARE
  stale_status_constraint record;
BEGIN
  FOR stale_status_constraint IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'world_scenes'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%status%'
      AND pg_get_constraintdef(oid) LIKE '%closed%'
      AND pg_get_constraintdef(oid) NOT LIKE '%inactive%'
  LOOP
    EXECUTE format('ALTER TABLE world_scenes DROP CONSTRAINT %I', stale_status_constraint.conname);
  END LOOP;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint
      WHERE conrelid = 'world_scenes'::regclass
        AND contype = 'c'
        AND conname = 'world_scenes_status_check'
        AND pg_get_constraintdef(oid) LIKE '%inactive%') THEN
    ALTER TABLE world_scenes DROP CONSTRAINT IF EXISTS world_scenes_status_check;
    ALTER TABLE world_scenes ADD CONSTRAINT world_scenes_status_check
      CHECK (status IN ('active','inactive','closed'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS agent_minds (
  world_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  archetype text NOT NULL CHECK (archetype IN ('naturalist','maker','scholar','host','observer')),
  traits jsonb NOT NULL DEFAULT '{}'::jsonb,
  current_goal text NOT NULL DEFAULT 'Learn about this world',
  memories jsonb NOT NULL DEFAULT '[]'::jsonb,
  actions_taken integer NOT NULL DEFAULT 0 CHECK (actions_taken >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (world_id, agent_id),
  FOREIGN KEY (world_id, agent_id) REFERENCES world_members(world_id, agent_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS world_scenes_active_idx ON world_scenes(world_id, status, created_at);
CREATE INDEX IF NOT EXISTS agent_minds_world_idx ON agent_minds(world_id, updated_at DESC);

-- Durable clock and per-resident activity state for the single server-owned
-- World Engine. Monetary values remain in the existing simulated ledgers.
CREATE TABLE IF NOT EXISTS world_runtime_state (
  world_id uuid PRIMARY KEY REFERENCES worlds(id) ON DELETE CASCADE,
  tick_count bigint NOT NULL DEFAULT 0 CHECK (tick_count >= 0),
  world_minutes bigint NOT NULL DEFAULT 480 CHECK (world_minutes >= 0),
  last_tick_at timestamptz NOT NULL DEFAULT now(),
  typesafe_next_at timestamptz NOT NULL DEFAULT now(),
  market_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE world_runtime_state ADD COLUMN IF NOT EXISTS typesafe_next_at timestamptz NOT NULL DEFAULT now();

CREATE TABLE IF NOT EXISTS world_agent_states (
  world_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  goal text NOT NULL CHECK (goal IN ('wealth','learn','community','wellbeing','balanced')),
  risk_tolerance numeric(4,3) NOT NULL CHECK (risk_tolerance BETWEEN 0 AND 1),
  happiness integer NOT NULL DEFAULT 60 CHECK (happiness BETWEEN 0 AND 100),
  knowledge integer NOT NULL DEFAULT 20 CHECK (knowledge BETWEEN 0 AND 100),
  status text NOT NULL DEFAULT 'idle' CHECK (status IN ('idle','walking','performing')),
  planned_action text CHECK (planned_action IS NULL OR planned_action IN ('work','learn','rest','eat','socialize','trade')),
  target_location text,
  planned_partner_id uuid REFERENCES agents(id) ON DELETE SET NULL,
  planned_side text CHECK (planned_side IS NULL OR planned_side IN ('buy','sell')),
  planned_asset text CHECK (planned_asset IS NULL OR planned_asset IN ('BTC','ETH')),
  planned_quote_units numeric(30,8) CHECK (planned_quote_units IS NULL OR planned_quote_units > 0),
  planned_paid_meal boolean NOT NULL DEFAULT false,
  fruitfly_observation jsonb NOT NULL DEFAULT '{}'::jsonb,
  fruitfly_candidates jsonb NOT NULL DEFAULT '[]'::jsonb,
  fruitfly_selected jsonb NOT NULL DEFAULT '{}'::jsonb,
  movement_started_at timestamptz,
  movement_ends_at timestamptz,
  action_started_at timestamptz,
  action_ends_at timestamptz,
  next_decision_at timestamptz NOT NULL DEFAULT now(),
  last_trade_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (world_id, agent_id),
  FOREIGN KEY (world_id, agent_id) REFERENCES world_members(world_id, agent_id) ON DELETE CASCADE,
  CHECK (status <> 'walking' OR (target_location IS NOT NULL AND movement_started_at IS NOT NULL AND movement_ends_at IS NOT NULL AND planned_action IS NOT NULL)),
  CHECK (status <> 'performing' OR (planned_action IS NOT NULL AND action_started_at IS NOT NULL AND action_ends_at IS NOT NULL))
);
ALTER TABLE world_agent_states ADD COLUMN IF NOT EXISTS planned_paid_meal boolean NOT NULL DEFAULT false;
ALTER TABLE world_agent_states ADD COLUMN IF NOT EXISTS planned_partner_id uuid REFERENCES agents(id) ON DELETE SET NULL;
ALTER TABLE world_agent_states ADD COLUMN IF NOT EXISTS fruitfly_observation jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE world_agent_states ADD COLUMN IF NOT EXISTS fruitfly_candidates jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE world_agent_states ADD COLUMN IF NOT EXISTS fruitfly_selected jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE world_agent_states ADD COLUMN IF NOT EXISTS next_strategic_decision_world_minutes bigint;
ALTER TABLE world_agent_states ADD COLUMN IF NOT EXISTS strategic_goal_category text;
ALTER TABLE world_agent_states ADD COLUMN IF NOT EXISTS strategic_goal_progress numeric(5,2);
ALTER TABLE world_agent_states ADD COLUMN IF NOT EXISTS strategic_goal_progress_world_minutes bigint;
ALTER TABLE world_agent_states ADD COLUMN IF NOT EXISTS strategic_goal_stagnation_cycles integer NOT NULL DEFAULT 0;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='world_agent_states'::regclass
    AND conname='world_agent_states_planned_action_check'
    AND pg_get_constraintdef(oid) LIKE '%cooperate%') THEN
    ALTER TABLE world_agent_states DROP CONSTRAINT IF EXISTS world_agent_states_planned_action_check;
    ALTER TABLE world_agent_states ADD CONSTRAINT world_agent_states_planned_action_check
      CHECK (planned_action IS NULL OR planned_action IN ('work','learn','rest','eat','socialize','trade','cooperate'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS world_agent_states_due_idx ON world_agent_states(world_id, status, next_decision_at);

CREATE TABLE IF NOT EXISTS world_emergence_events (
  id bigserial PRIMARY KEY,
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  agent_id uuid,
  world_minutes bigint NOT NULL CHECK (world_minutes >= 0),
  tick_count bigint NOT NULL DEFAULT 0 CHECK (tick_count >= 0),
  system text NOT NULL CHECK (system IN ('opportunity','project','organization','information','place','goal')),
  stage text NOT NULL CHECK (char_length(stage) BETWEEN 2 AND 48),
  reason_code text NOT NULL DEFAULT 'NONE' CHECK (char_length(reason_code) BETWEEN 2 AND 64),
  event_key text NOT NULL,
  candidate_id text,
  action text,
  utility_score numeric(12,4),
  details jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details)='object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (world_id,event_key),
  FOREIGN KEY (world_id,agent_id) REFERENCES world_members(world_id,agent_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS world_emergence_recent_idx
  ON world_emergence_events(world_id,world_minutes DESC,id DESC);
CREATE INDEX IF NOT EXISTS world_emergence_reason_idx
  ON world_emergence_events(world_id,reason_code,world_minutes DESC);

-- Durable social simulation state. Existing world_agent_states.risk_tolerance
-- remains the resident's risk personality dimension; these rows add the other
-- stable traits and a finite, progress-bearing long-term goal.
CREATE TABLE IF NOT EXISTS world_social_profiles (
  world_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  sociability numeric(4,3) NOT NULL DEFAULT 0.500 CHECK (sociability BETWEEN 0 AND 1),
  curiosity numeric(4,3) NOT NULL DEFAULT 0.500 CHECK (curiosity BETWEEN 0 AND 1),
  discipline numeric(4,3) NOT NULL DEFAULT 0.500 CHECK (discipline BETWEEN 0 AND 1),
  ambition numeric(4,3) NOT NULL DEFAULT 0.500 CHECK (ambition BETWEEN 0 AND 1),
  primary_goal text NOT NULL DEFAULT 'BALANCED_LIFE'
    CHECK (primary_goal IN ('BUILD_WEALTH','MASTER_TRADING','MASTER_RESEARCH','MASTER_ENGINEERING','BUILD_RELATIONSHIPS','BALANCED_LIFE')),
  goal_progress numeric(5,2) NOT NULL DEFAULT 0 CHECK (goal_progress BETWEEN 0 AND 100),
  goal_milestones integer NOT NULL DEFAULT 0 CHECK (goal_milestones >= 0),
  goal_started_world_minutes bigint NOT NULL DEFAULT 0 CHECK (goal_started_world_minutes >= 0),
  goal_last_updated_world_minutes bigint CHECK (goal_last_updated_world_minutes IS NULL OR goal_last_updated_world_minutes >= 0),
  dominant_role text NOT NULL DEFAULT 'generalist'
    CHECK (dominant_role IN ('researcher','engineer','trader','worker','socialite','generalist')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (world_id, agent_id),
  FOREIGN KEY (world_id, agent_id) REFERENCES world_members(world_id, agent_id) ON DELETE CASCADE
);
ALTER TABLE world_social_profiles ADD COLUMN IF NOT EXISTS personality_modifiers jsonb NOT NULL DEFAULT
  '{"sociability":0,"curiosity":0,"discipline":0,"ambition":0}'::jsonb;
ALTER TABLE world_social_profiles ADD COLUMN IF NOT EXISTS risk_modifier numeric(4,3) NOT NULL DEFAULT 0;
ALTER TABLE world_social_profiles ADD COLUMN IF NOT EXISTS price_sensitivity numeric(4,3) NOT NULL DEFAULT 0.500
  CHECK (price_sensitivity BETWEEN 0 AND 1);
ALTER TABLE world_social_profiles ADD COLUMN IF NOT EXISTS last_reflection_world_minutes bigint;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='world_social_profiles'::regclass
    AND conname='world_social_profiles_primary_goal_check' AND pg_get_constraintdef(oid) LIKE '%~%') THEN
    ALTER TABLE world_social_profiles DROP CONSTRAINT IF EXISTS world_social_profiles_primary_goal_check;
    ALTER TABLE world_social_profiles ADD CONSTRAINT world_social_profiles_primary_goal_check
      CHECK (primary_goal ~ '^[A-Z][A-Z0-9_]{1,63}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='world_social_profiles'::regclass
    AND conname='world_social_profiles_personality_modifiers_check') THEN
    ALTER TABLE world_social_profiles ADD CONSTRAINT world_social_profiles_personality_modifiers_check
      CHECK (jsonb_typeof(personality_modifiers) = 'object' AND
        COALESCE((personality_modifiers->>'sociability')::numeric BETWEEN -0.150 AND 0.150,FALSE) AND
        COALESCE((personality_modifiers->>'curiosity')::numeric BETWEEN -0.150 AND 0.150,FALSE) AND
        COALESCE((personality_modifiers->>'discipline')::numeric BETWEEN -0.150 AND 0.150,FALSE) AND
        COALESCE((personality_modifiers->>'ambition')::numeric BETWEEN -0.150 AND 0.150,FALSE));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='world_social_profiles'::regclass
    AND conname='world_social_profiles_risk_modifier_check') THEN
    ALTER TABLE world_social_profiles ADD CONSTRAINT world_social_profiles_risk_modifier_check
      CHECK (risk_modifier BETWEEN -0.150 AND 0.150);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS world_agent_skills (
  world_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  skill_name text NOT NULL CHECK (skill_name ~ '^[a-z][a-z0-9_]{1,47}$'),
  skill_value numeric(5,2) NOT NULL DEFAULT 0 CHECK (skill_value BETWEEN 0 AND 100),
  actions_completed integer NOT NULL DEFAULT 0 CHECK (actions_completed >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (world_id, agent_id, skill_name),
  FOREIGN KEY (world_id, agent_id) REFERENCES world_members(world_id, agent_id) ON DELETE CASCADE
);
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='world_agent_skills'::regclass
    AND conname='world_agent_skills_skill_name_check' AND pg_get_constraintdef(oid) LIKE '%~%') THEN
    ALTER TABLE world_agent_skills DROP CONSTRAINT IF EXISTS world_agent_skills_skill_name_check;
    ALTER TABLE world_agent_skills ADD CONSTRAINT world_agent_skills_skill_name_check
      CHECK (skill_name ~ '^[a-z][a-z0-9_]{1,47}$');
  END IF;
END $$;

-- Decision memories are derived from completed, already-audited world events.
-- Important memories have a separate small retention allowance from the most
-- recent detailed memories; pruning never removes world_events audit history.
CREATE TABLE IF NOT EXISTS agent_memories (
  id bigserial PRIMARY KEY,
  world_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  memory_type text NOT NULL CHECK (memory_type ~ '^[a-z][a-z0-9_]{1,47}$'),
  summary text NOT NULL CHECK (char_length(summary) BETWEEN 1 AND 240),
  importance numeric(4,3) NOT NULL DEFAULT 0.200 CHECK (importance BETWEEN 0 AND 1),
  world_minutes bigint NOT NULL CHECK (world_minutes >= 0),
  location text,
  related_agent_id uuid REFERENCES agents(id) ON DELETE SET NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  source_event_id bigint REFERENCES world_events(id) ON DELETE SET NULL,
  consolidation_key text,
  long_term boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (world_id, agent_id) REFERENCES world_members(world_id, agent_id) ON DELETE CASCADE
);
ALTER TABLE agent_memories ADD COLUMN IF NOT EXISTS consolidation_key text;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='agent_memories'::regclass
    AND conname='agent_memories_memory_type_check' AND pg_get_constraintdef(oid) LIKE '%~%') THEN
    ALTER TABLE agent_memories DROP CONSTRAINT IF EXISTS agent_memories_memory_type_check;
    ALTER TABLE agent_memories ADD CONSTRAINT agent_memories_memory_type_check
      CHECK (memory_type ~ '^[a-z][a-z0-9_]{1,47}$');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS world_relationships (
  world_id uuid NOT NULL,
  agent_a_id uuid NOT NULL,
  agent_b_id uuid NOT NULL,
  familiarity numeric(5,2) NOT NULL DEFAULT 0 CHECK (familiarity BETWEEN 0 AND 100),
  trust numeric(6,2) NOT NULL DEFAULT 0 CHECK (trust BETWEEN -100 AND 100),
  affinity numeric(6,2) NOT NULL DEFAULT 0 CHECK (affinity BETWEEN -100 AND 100),
  last_interaction_world_minutes bigint CHECK (last_interaction_world_minutes IS NULL OR last_interaction_world_minutes >= 0),
  interaction_count integer NOT NULL DEFAULT 0 CHECK (interaction_count >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (world_id, agent_a_id, agent_b_id),
  CHECK (agent_a_id < agent_b_id),
  FOREIGN KEY (world_id, agent_a_id) REFERENCES world_members(world_id, agent_id) ON DELETE CASCADE,
  FOREIGN KEY (world_id, agent_b_id) REFERENCES world_members(world_id, agent_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS agent_memories_recent_idx ON agent_memories(world_id, agent_id, world_minutes DESC, id DESC);
CREATE UNIQUE INDEX IF NOT EXISTS agent_memories_source_event_idx
  ON agent_memories(world_id, agent_id, source_event_id) WHERE source_event_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS agent_memories_consolidation_key_idx
  ON agent_memories(world_id,agent_id,consolidation_key) WHERE consolidation_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS world_relationships_reverse_idx ON world_relationships(world_id, agent_b_id, agent_a_id);
CREATE INDEX IF NOT EXISTS world_agent_skills_rank_idx ON world_agent_skills(world_id, agent_id, skill_value DESC);

-- Goals are open-ended records. Existing profile goal values remain as
-- compatibility seeds; these rows are the planning system's durable source.
CREATE TABLE IF NOT EXISTS world_agent_goals (
  id bigserial PRIMARY KEY,
  world_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  goal_type text NOT NULL CHECK (goal_type IN ('primary','secondary','short')),
  category text NOT NULL CHECK (category ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  description text NOT NULL CHECK (char_length(description) BETWEEN 3 AND 240),
  priority numeric(5,4) NOT NULL DEFAULT 0.5000 CHECK (priority BETWEEN 0 AND 1),
  progress numeric(5,2) NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','completed','paused','abandoned')),
  source text NOT NULL DEFAULT 'seed' CHECK (source IN ('seed','experience','memory','relationship','opportunity','strategy','self_generated','stagnation')),
  parent_goal_id bigint REFERENCES world_agent_goals(id) ON DELETE SET NULL,
  created_world_minutes bigint NOT NULL DEFAULT 0 CHECK (created_world_minutes >= 0),
  updated_world_minutes bigint NOT NULL DEFAULT 0 CHECK (updated_world_minutes >= 0),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (world_id, agent_id) REFERENCES world_members(world_id, agent_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS world_agent_goals_active_primary_idx
  ON world_agent_goals(world_id,agent_id) WHERE goal_type='primary' AND status='active';
CREATE UNIQUE INDEX IF NOT EXISTS world_agent_goals_active_category_idx
  ON world_agent_goals(world_id,agent_id,goal_type,category) WHERE status='active';
CREATE INDEX IF NOT EXISTS world_agent_goals_active_idx
  ON world_agent_goals(world_id,agent_id,goal_type,priority DESC,updated_world_minutes DESC) WHERE status='active';
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='world_agent_goals'::regclass
      AND conname='world_agent_goals_source_check' AND pg_get_constraintdef(oid) LIKE '%stagnation%') THEN
    ALTER TABLE world_agent_goals DROP CONSTRAINT IF EXISTS world_agent_goals_source_check;
    ALTER TABLE world_agent_goals ADD CONSTRAINT world_agent_goals_source_check
      CHECK (source IN ('seed','experience','memory','relationship','opportunity','strategy','self_generated','stagnation'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS world_agent_beliefs (
  world_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  subject_type text NOT NULL CHECK (subject_type IN ('action','place','resident','asset','project','opportunity','business','organization','market')),
  subject_key text NOT NULL CHECK (char_length(subject_key) BETWEEN 1 AND 120),
  belief_key text NOT NULL CHECK (char_length(belief_key) BETWEEN 1 AND 80),
  estimate numeric(10,4) NOT NULL,
  confidence numeric(4,3) NOT NULL DEFAULT 0.100 CHECK (confidence BETWEEN 0 AND 1),
  sample_count integer NOT NULL DEFAULT 0 CHECK (sample_count >= 0),
  updated_world_minutes bigint NOT NULL DEFAULT 0 CHECK (updated_world_minutes >= 0),
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(evidence) = 'object'),
  PRIMARY KEY (world_id,agent_id,subject_type,subject_key,belief_key),
  FOREIGN KEY (world_id,agent_id) REFERENCES world_members(world_id,agent_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS world_agent_reflections (
  id bigserial PRIMARY KEY,
  world_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  world_minutes bigint NOT NULL CHECK (world_minutes >= 0),
  trigger text NOT NULL CHECK (trigger IN ('cadence','important_event')),
  rationale jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(rationale) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (world_id,agent_id,world_minutes),
  FOREIGN KEY (world_id,agent_id) REFERENCES world_members(world_id,agent_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS world_decision_traces (
  id bigserial PRIMARY KEY,
  world_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  tick_count bigint NOT NULL CHECK (tick_count >= 0),
  world_minutes bigint NOT NULL CHECK (world_minutes >= 0),
  chosen_candidate_id text NOT NULL,
  chosen_action text NOT NULL,
  behavior_probability numeric(9,8) NOT NULL CHECK (behavior_probability BETWEEN 0 AND 1),
  distribution jsonb NOT NULL CHECK (jsonb_typeof(distribution) = 'object'),
  utility_scores jsonb NOT NULL CHECK (jsonb_typeof(utility_scores) = 'object'),
  goal_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(goal_snapshot) = 'object'),
  rationale jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(rationale) = 'object'),
  source_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (world_id,agent_id) REFERENCES world_members(world_id,agent_id) ON DELETE CASCADE
);
ALTER TABLE world_decision_traces ADD COLUMN IF NOT EXISTS source_key text;
CREATE UNIQUE INDEX IF NOT EXISTS world_decision_traces_source_key_idx
  ON world_decision_traces(world_id,source_key) WHERE source_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS world_decision_traces_recent_idx
  ON world_decision_traces(world_id,agent_id,tick_count DESC,id DESC);

-- V3 self-organizing world state. All resources below are simulated and all
-- clocks are world minutes; the records are additive to the V2 history.
ALTER TABLE world_agent_states ADD COLUMN IF NOT EXISTS planned_context jsonb NOT NULL DEFAULT '{}'::jsonb;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='world_agent_states'::regclass
    AND conname='world_agent_states_planned_action_check'
    AND pg_get_constraintdef(oid) LIKE '%information_doubt%'
    AND pg_get_constraintdef(oid) LIKE '%goal_review%'
    AND pg_get_constraintdef(oid) LIKE '%opportunity_propose%') THEN
    ALTER TABLE world_agent_states DROP CONSTRAINT IF EXISTS world_agent_states_planned_action_check;
    ALTER TABLE world_agent_states ADD CONSTRAINT world_agent_states_planned_action_check
      CHECK (planned_action IS NULL OR planned_action IN ('work','learn','rest','eat','socialize','trade','cooperate',
        'opportunity','opportunity_reject','opportunity_propose','project_propose','project_join','project_reject','project_contribute','project_leave',
        'organization_found','organization_join','organization_leave','organization_invite',
        'organization_reject','organization_contribute','place_create','information_share',
        'information_accept','information_ignore','information_doubt','goal_review'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS world_opportunities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  opportunity_type text NOT NULL CHECK (opportunity_type IN ('WORK','RESEARCH','TRADE','SOCIAL','COOPERATION','BUILD','LEARNING')),
  creator_agent_id uuid REFERENCES agents(id) ON DELETE SET NULL,
  source_type text NOT NULL CHECK (source_type IN ('environment','place','resident','organization','event','project')),
  source_key text,
  scene_id uuid REFERENCES world_scenes(id) ON DELETE SET NULL,
  title text NOT NULL CHECK (char_length(title) BETWEEN 3 AND 96),
  description text NOT NULL CHECK (char_length(description) BETWEEN 12 AND 500),
  requirements jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(requirements)='object'),
  reward jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(reward)='object'),
  risk jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(risk)='object'),
  capacity integer NOT NULL DEFAULT 1 CHECK (capacity BETWEEN 1 AND 100),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','active','completed','failed','expired','closed')),
  created_world_time bigint NOT NULL CHECK (created_world_time >= 0),
  expires_world_time bigint CHECK (expires_world_time IS NULL OR expires_world_time >= created_world_time),
  dedupe_key text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata)='object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (source_key IS NULL OR char_length(source_key) BETWEEN 1 AND 160)
);

CREATE TABLE IF NOT EXISTS world_opportunity_participants (
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  opportunity_id uuid NOT NULL REFERENCES world_opportunities(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('accepted','rejected','completed','failed','withdrawn')),
  action_id text NOT NULL,
  outcome jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(outcome)='object'),
  joined_world_time bigint NOT NULL CHECK (joined_world_time >= 0),
  updated_world_time bigint NOT NULL CHECK (updated_world_time >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (opportunity_id,agent_id),
  UNIQUE (world_id,agent_id,action_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS world_scenes_world_id_id_idx ON world_scenes(world_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS world_opportunities_world_id_id_idx ON world_opportunities(world_id,id);
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='world_opportunity_participants'::regclass
      AND conname='world_opportunity_participants_same_world_fk') THEN
    ALTER TABLE world_opportunity_participants ADD CONSTRAINT world_opportunity_participants_same_world_fk
      FOREIGN KEY (world_id,opportunity_id) REFERENCES world_opportunities(world_id,id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='world_opportunities'::regclass
      AND conname='world_opportunities_scene_world_fk') THEN
    ALTER TABLE world_opportunities ADD CONSTRAINT world_opportunities_scene_world_fk
      FOREIGN KEY (world_id,scene_id) REFERENCES world_scenes(world_id,id) ON DELETE SET NULL (scene_id);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS world_opportunities_active_idx
  ON world_opportunities(world_id,status,created_world_time DESC);
CREATE UNIQUE INDEX IF NOT EXISTS world_opportunities_dedupe_idx
  ON world_opportunities(world_id,dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS world_opportunity_participants_agent_idx
  ON world_opportunity_participants(world_id,agent_id,status);

CREATE TABLE IF NOT EXISTS world_projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  creator_agent_id uuid NOT NULL REFERENCES agents(id),
  opportunity_id uuid REFERENCES world_opportunities(id) ON DELETE SET NULL,
  organization_id uuid,
  project_type text NOT NULL CHECK (project_type IN ('RESEARCH','TRADE','BUILD','SOCIAL','DATA','LEARNING','GENERAL')),
  title text NOT NULL CHECK (char_length(title) BETWEEN 3 AND 96),
  goal text NOT NULL CHECK (char_length(goal) BETWEEN 3 AND 240),
  description text NOT NULL CHECK (char_length(description) BETWEEN 12 AND 800),
  status text NOT NULL DEFAULT 'proposed' CHECK (status IN ('idea','proposed','recruiting','active','completed','failed','abandoned')),
  required_skills jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(required_skills)='object'),
  required_resources jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(required_resources)='object'),
  reward jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(reward)='object'),
  capacity integer NOT NULL DEFAULT 4 CHECK (capacity BETWEEN 1 AND 20),
  progress numeric(5,2) NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  created_world_time bigint NOT NULL CHECK (created_world_time >= 0),
  updated_world_time bigint NOT NULL CHECK (updated_world_time >= 0),
  deadline_world_time bigint CHECK (deadline_world_time IS NULL OR deadline_world_time >= created_world_time),
  action_id text NOT NULL,
  result jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(result)='object'),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata)='object'),
  settled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (world_id,creator_agent_id,action_id)
);

CREATE TABLE IF NOT EXISTS world_project_members (
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES world_projects(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('invited','active','rejected','left','completed')),
  role text NOT NULL DEFAULT 'contributor' CHECK (role IN ('founder','contributor','coordinator')),
  action_id text NOT NULL,
  joined_world_time bigint NOT NULL CHECK (joined_world_time >= 0),
  updated_world_time bigint NOT NULL CHECK (updated_world_time >= 0),
  contribution_points numeric(12,3) NOT NULL DEFAULT 0 CHECK (contribution_points >= 0),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata)='object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id,agent_id)
);

CREATE TABLE IF NOT EXISTS world_project_contributions (
  id bigserial PRIMARY KEY,
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES world_projects(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  action_id text NOT NULL,
  contribution_type text NOT NULL CHECK (contribution_type IN ('work','research','learning','planning','resource','place')),
  effort_points numeric(12,3) NOT NULL CHECK (effort_points > 0),
  simulated_usdc numeric(30,8) NOT NULL DEFAULT 0 CHECK (simulated_usdc >= 0),
  world_time bigint NOT NULL CHECK (world_time >= 0),
  result jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(result)='object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (world_id,agent_id,action_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS world_projects_world_id_id_idx ON world_projects(world_id,id);
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='world_project_members'::regclass
      AND conname='world_project_members_same_world_fk') THEN
    ALTER TABLE world_project_members ADD CONSTRAINT world_project_members_same_world_fk
      FOREIGN KEY (world_id,project_id) REFERENCES world_projects(world_id,id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='world_project_contributions'::regclass
      AND conname='world_project_contributions_same_world_fk') THEN
    ALTER TABLE world_project_contributions ADD CONSTRAINT world_project_contributions_same_world_fk
      FOREIGN KEY (world_id,project_id) REFERENCES world_projects(world_id,id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='world_projects'::regclass
      AND conname='world_projects_opportunity_world_fk') THEN
    ALTER TABLE world_projects ADD CONSTRAINT world_projects_opportunity_world_fk
      FOREIGN KEY (world_id,opportunity_id) REFERENCES world_opportunities(world_id,id) ON DELETE SET NULL (opportunity_id);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS world_projects_active_idx ON world_projects(world_id,status,updated_world_time DESC);
CREATE INDEX IF NOT EXISTS world_project_members_agent_idx ON world_project_members(world_id,agent_id,status);
CREATE INDEX IF NOT EXISTS world_project_contributions_project_idx
  ON world_project_contributions(world_id,project_id,world_time DESC,id DESC);

CREATE TABLE IF NOT EXISTS world_organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  founder_agent_id uuid NOT NULL REFERENCES agents(id),
  name text NOT NULL CHECK (char_length(name) BETWEEN 3 AND 80),
  purpose text NOT NULL CHECK (char_length(purpose) BETWEEN 12 AND 400),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('forming','active','dormant','dissolved')),
  reputation numeric(7,2) NOT NULL DEFAULT 0 CHECK (reputation BETWEEN -1000 AND 1000),
  resources jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(resources)='object'),
  action_id text NOT NULL,
  created_world_time bigint NOT NULL CHECK (created_world_time >= 0),
  updated_world_time bigint NOT NULL CHECK (updated_world_time >= 0),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata)='object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (world_id,founder_agent_id,action_id),
  UNIQUE (world_id,name)
);

CREATE TABLE IF NOT EXISTS world_organization_members (
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES world_organizations(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('invited','active','rejected','left')),
  role text NOT NULL DEFAULT 'member' CHECK (role IN ('founder','member','coordinator')),
  joined_world_time bigint NOT NULL CHECK (joined_world_time >= 0),
  updated_world_time bigint NOT NULL CHECK (updated_world_time >= 0),
  action_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id,agent_id)
);

CREATE TABLE IF NOT EXISTS world_organization_ledger (
  id bigserial PRIMARY KEY,
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES world_organizations(id) ON DELETE CASCADE,
  agent_id uuid REFERENCES agents(id) ON DELETE SET NULL,
  action_id text NOT NULL,
  entry_type text NOT NULL CHECK (entry_type IN ('contribution','project_spend','reward','refund')),
  resource_key text NOT NULL CHECK (resource_key IN ('effort','simulated_usdc','internal_units')),
  amount numeric(30,8) NOT NULL CHECK (amount <> 0),
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 3 AND 240),
  world_time bigint NOT NULL CHECK (world_time >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (world_id,organization_id,action_id,resource_key)
);

CREATE TABLE IF NOT EXISTS world_information_shares (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  sender_agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  recipient_agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  information_type text NOT NULL CHECK (information_type IN ('opportunity','project','belief','place')),
  subject_type text NOT NULL CHECK (subject_type IN ('action','place','resident','asset','project','opportunity')),
  subject_key text NOT NULL CHECK (char_length(subject_key) BETWEEN 1 AND 120),
  claim jsonb NOT NULL CHECK (jsonb_typeof(claim)='object'),
  confidence numeric(4,3) NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  status text NOT NULL DEFAULT 'offered' CHECK (status IN ('offered','accepted','ignored','doubted','expired')),
  action_id text NOT NULL,
  received_action_id text,
  shared_world_time bigint NOT NULL CHECK (shared_world_time >= 0),
  expires_world_time bigint CHECK (expires_world_time IS NULL OR expires_world_time >= shared_world_time),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (sender_agent_id <> recipient_agent_id),
  UNIQUE (world_id,sender_agent_id,action_id)
);
CREATE INDEX IF NOT EXISTS world_information_inbox_idx
  ON world_information_shares(world_id,recipient_agent_id,status,shared_world_time DESC);
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='world_agent_beliefs'::regclass
      AND conname='world_agent_beliefs_subject_type_check'
      AND pg_get_constraintdef(oid) LIKE '%opportunity%'
      AND pg_get_constraintdef(oid) LIKE '%business%'
      AND pg_get_constraintdef(oid) LIKE '%organization%'
      AND pg_get_constraintdef(oid) LIKE '%market%') THEN
    ALTER TABLE world_agent_beliefs DROP CONSTRAINT IF EXISTS world_agent_beliefs_subject_type_check;
    ALTER TABLE world_agent_beliefs ADD CONSTRAINT world_agent_beliefs_subject_type_check
      CHECK (subject_type IN ('action','place','resident','asset','project','opportunity','business','organization','market'));
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS world_organizations_world_id_id_idx ON world_organizations(world_id,id);
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='world_organization_members'::regclass
      AND conname='world_organization_members_same_world_fk') THEN
    ALTER TABLE world_organization_members ADD CONSTRAINT world_organization_members_same_world_fk
      FOREIGN KEY (world_id,organization_id) REFERENCES world_organizations(world_id,id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='world_organization_ledger'::regclass
      AND conname='world_organization_ledger_same_world_fk') THEN
    ALTER TABLE world_organization_ledger ADD CONSTRAINT world_organization_ledger_same_world_fk
      FOREIGN KEY (world_id,organization_id) REFERENCES world_organizations(world_id,id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='world_projects'::regclass
      AND conname='world_projects_organization_world_fk') THEN
    ALTER TABLE world_projects ADD CONSTRAINT world_projects_organization_world_fk
      FOREIGN KEY (world_id,organization_id) REFERENCES world_organizations(world_id,id) ON DELETE SET NULL (organization_id);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS world_organizations_active_idx ON world_organizations(world_id,status,reputation DESC);
CREATE INDEX IF NOT EXISTS world_organization_members_agent_idx
  ON world_organization_members(world_id,agent_id,status);

CREATE TABLE IF NOT EXISTS world_history (
  id bigserial PRIMARY KEY,
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  event_key text NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('opportunity_created','project_proposed','project_started','project_completed','project_failed',
    'organization_founded','organization_joined','organization_left','organization_invited','place_created',
    'information_shared','information_accepted','information_doubted','information_ignored','cooperation_completed','milestone')),
  actor_agent_id uuid REFERENCES agents(id) ON DELETE SET NULL,
  entity_type text NOT NULL CHECK (entity_type IN ('opportunity','project','organization','place','cooperation','world')),
  entity_id uuid,
  world_time bigint NOT NULL CHECK (world_time >= 0),
  title text NOT NULL CHECK (char_length(title) BETWEEN 3 AND 120),
  detail text NOT NULL CHECK (char_length(detail) BETWEEN 1 AND 600),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata)='object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (world_id,event_key)
);
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='world_history'::regclass
      AND conname='world_history_event_type_check' AND pg_get_constraintdef(oid) LIKE '%project_proposed%')
      AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='world_history'::regclass
        AND conname='world_history_event_type_check' AND pg_get_constraintdef(oid) LIKE '%{1,79}%') THEN
    ALTER TABLE world_history DROP CONSTRAINT IF EXISTS world_history_event_type_check;
    ALTER TABLE world_history ADD CONSTRAINT world_history_event_type_check
      CHECK (event_type IN ('opportunity_created','project_proposed','project_started','project_completed','project_failed',
        'organization_founded','organization_joined','organization_left','organization_invited','place_created',
        'information_shared','information_accepted','information_doubted','information_ignored','cooperation_completed','milestone'));
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS world_history_recent_idx ON world_history(world_id,world_time DESC,id DESC);

ALTER TABLE world_projects ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES world_organizations(id) ON DELETE SET NULL;
ALTER TABLE world_scenes ADD COLUMN IF NOT EXISTS purpose text NOT NULL DEFAULT 'A shared place in the world';
ALTER TABLE world_scenes ADD COLUMN IF NOT EXISTS capacity integer NOT NULL DEFAULT 8 CHECK (capacity BETWEEN 1 AND 1000);
ALTER TABLE world_scenes ADD COLUMN IF NOT EXISTS features jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(features)='object');
ALTER TABLE world_scenes ADD COLUMN IF NOT EXISTS position jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(position)='object');
ALTER TABLE world_scenes ADD COLUMN IF NOT EXISTS created_world_minutes bigint NOT NULL DEFAULT 0 CHECK (created_world_minutes >= 0);
ALTER TABLE world_scenes ADD COLUMN IF NOT EXISTS created_by_project_id uuid REFERENCES world_projects(id) ON DELETE SET NULL;
ALTER TABLE world_scenes ADD COLUMN IF NOT EXISTS created_by_organization_id uuid REFERENCES world_organizations(id) ON DELETE SET NULL;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='world_scenes'::regclass
      AND conname='world_scenes_project_world_fk') THEN
    ALTER TABLE world_scenes ADD CONSTRAINT world_scenes_project_world_fk
      FOREIGN KEY (world_id,created_by_project_id) REFERENCES world_projects(world_id,id) ON DELETE SET NULL (created_by_project_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='world_scenes'::regclass
      AND conname='world_scenes_organization_world_fk') THEN
    ALTER TABLE world_scenes ADD CONSTRAINT world_scenes_organization_world_fk
      FOREIGN KEY (world_id,created_by_organization_id) REFERENCES world_organizations(world_id,id) ON DELETE SET NULL (created_by_organization_id);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS world_scenes_project_idx ON world_scenes(world_id,created_by_project_id);
CREATE INDEX IF NOT EXISTS world_scenes_organization_idx ON world_scenes(world_id,created_by_organization_id);
CREATE UNIQUE INDEX IF NOT EXISTS world_scenes_project_place_unique_idx
  ON world_scenes(world_id,created_by_project_id) WHERE created_by_project_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS world_projects_opportunity_unique_idx
  ON world_projects(world_id,opportunity_id) WHERE opportunity_id IS NOT NULL;

-- Internal resident and organization economy. Mining units stay in token_ledger
-- and are intentionally not exchangeable for USDC.
CREATE TABLE IF NOT EXISTS world_economic_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  account_type text NOT NULL CHECK (account_type IN ('resident','organization','business','project','system')),
  account_key text NOT NULL CHECK (char_length(account_key) BETWEEN 1 AND 160),
  owner_id uuid,
  asset_symbol text NOT NULL CHECK (asset_symbol IN ('USDC','BTC','ETH')),
  balance numeric(30,8) NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (world_id,account_key,asset_symbol),
  CHECK (account_type='system' OR balance >= 0)
);

CREATE TABLE IF NOT EXISTS world_economic_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  action_id text NOT NULL CHECK (char_length(action_id) BETWEEN 1 AND 180),
  transaction_type text NOT NULL CHECK (transaction_type IN ('opening_balance','simulation_seed','business_found','business_investment',
    'business_revenue','business_expense','business_wage','profit_distribution','project_investment','organization_contribution',
    'place_revenue','consumption','exchange_trade','maintenance','world_reward','refund')),
  source_account_id uuid NOT NULL REFERENCES world_economic_accounts(id),
  destination_account_id uuid NOT NULL REFERENCES world_economic_accounts(id),
  asset_symbol text NOT NULL CHECK (asset_symbol IN ('USDC','BTC','ETH')),
  amount numeric(30,8) NOT NULL CHECK (amount > 0),
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 3 AND 240),
  world_time bigint NOT NULL CHECK (world_time >= 0),
  reference_id text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata)='object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (world_id,action_id),
  CHECK (source_account_id <> destination_account_id)
);

CREATE TABLE IF NOT EXISTS world_economic_postings (
  id bigserial PRIMARY KEY,
  transaction_id uuid NOT NULL REFERENCES world_economic_transactions(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES world_economic_accounts(id) ON DELETE CASCADE,
  amount numeric(30,8) NOT NULL CHECK (amount <> 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (transaction_id,account_id)
);
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='world_economic_postings'::regclass
      AND conname='world_economic_postings_account_id_fkey'
      AND pg_get_constraintdef(oid) LIKE '%ON DELETE CASCADE%') THEN
    ALTER TABLE world_economic_postings DROP CONSTRAINT IF EXISTS world_economic_postings_account_id_fkey;
    ALTER TABLE world_economic_postings ADD CONSTRAINT world_economic_postings_account_id_fkey
      FOREIGN KEY (account_id) REFERENCES world_economic_accounts(id) ON DELETE CASCADE;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS world_economic_transactions_world_recent_idx
  ON world_economic_transactions(world_id,world_time DESC,created_at DESC);
CREATE INDEX IF NOT EXISTS world_economic_postings_account_idx
  ON world_economic_postings(account_id,transaction_id);

CREATE TABLE IF NOT EXISTS world_economic_ownership (
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  asset_type text NOT NULL CHECK (asset_type IN ('business','project','organization','place','service')),
  asset_id uuid NOT NULL,
  owner_type text NOT NULL CHECK (owner_type IN ('resident','organization','project')),
  owner_id uuid NOT NULL,
  share numeric(8,7) NOT NULL CHECK (share > 0 AND share <= 1),
  invested_usdc numeric(30,8) NOT NULL DEFAULT 0 CHECK (invested_usdc >= 0),
  acquired_world_time bigint NOT NULL DEFAULT 0 CHECK (acquired_world_time >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (world_id,asset_type,asset_id,owner_type,owner_id)
);
CREATE INDEX IF NOT EXISTS world_economic_ownership_owner_idx
  ON world_economic_ownership(world_id,owner_type,owner_id,asset_type);

CREATE TABLE IF NOT EXISTS world_businesses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  founder_agent_id uuid NOT NULL REFERENCES agents(id),
  name text NOT NULL CHECK (char_length(name) BETWEEN 3 AND 80),
  business_type text NOT NULL CHECK (business_type ~ '^[a-z][a-z0-9_]{1,47}$'),
  purpose text NOT NULL CHECK (char_length(purpose) BETWEEN 12 AND 400),
  place_id uuid REFERENCES world_scenes(id) ON DELETE SET NULL,
  source_project_id uuid REFERENCES world_projects(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive','closed','bankrupt')),
  reputation numeric(7,2) NOT NULL DEFAULT 0 CHECK (reputation BETWEEN -1000 AND 1000),
  valuation_usdc numeric(30,8) NOT NULL DEFAULT 0 CHECK (valuation_usdc >= 0),
  founded_world_time bigint NOT NULL CHECK (founded_world_time >= 0),
  last_revenue_world_time bigint,
  consecutive_loss_days integer NOT NULL DEFAULT 0 CHECK (consecutive_loss_days >= 0),
  action_id text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata)='object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (world_id,founder_agent_id,action_id),
  UNIQUE (world_id,name)
);

CREATE TABLE IF NOT EXISTS world_business_services (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  business_id uuid NOT NULL REFERENCES world_businesses(id) ON DELETE CASCADE,
  service_type text NOT NULL CHECK (service_type ~ '^[a-z][a-z0-9_]{1,47}$'),
  name text NOT NULL CHECK (char_length(name) BETWEEN 3 AND 96),
  description text NOT NULL CHECK (char_length(description) BETWEEN 12 AND 400),
  base_price_usdc numeric(30,8) NOT NULL CHECK (base_price_usdc > 0),
  stock_units integer NOT NULL DEFAULT 0 CHECK (stock_units >= 0),
  price_review_world_time bigint NOT NULL DEFAULT 0 CHECK (price_review_world_time >= 0),
  active boolean NOT NULL DEFAULT true,
  action_id text NOT NULL,
  created_world_time bigint NOT NULL CHECK (created_world_time >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (world_id,business_id,action_id)
);

CREATE TABLE IF NOT EXISTS world_business_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  business_id uuid NOT NULL REFERENCES world_businesses(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (char_length(role) BETWEEN 3 AND 80),
  required_skill text CHECK (required_skill IS NULL OR required_skill ~ '^[a-z][a-z0-9_]{1,47}$'),
  wage_usdc numeric(30,8) NOT NULL CHECK (wage_usdc > 0),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','filled','closed')),
  created_world_time bigint NOT NULL CHECK (created_world_time >= 0),
  action_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (world_id,business_id,action_id)
);

CREATE TABLE IF NOT EXISTS world_business_applications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  job_id uuid NOT NULL REFERENCES world_business_jobs(id) ON DELETE CASCADE,
  business_id uuid NOT NULL REFERENCES world_businesses(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('pending','accepted','rejected','withdrawn','expired')),
  action_id text NOT NULL,
  created_world_time bigint NOT NULL CHECK (created_world_time >= 0),
  updated_world_time bigint NOT NULL CHECK (updated_world_time >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (world_id,agent_id,action_id),
  UNIQUE (job_id,agent_id)
);

CREATE TABLE IF NOT EXISTS world_business_employment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  business_id uuid NOT NULL REFERENCES world_businesses(id) ON DELETE CASCADE,
  job_id uuid NOT NULL REFERENCES world_business_jobs(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  wage_usdc numeric(30,8) NOT NULL CHECK (wage_usdc > 0),
  status text NOT NULL CHECK (status IN ('active','left','terminated')),
  started_world_time bigint NOT NULL CHECK (started_world_time >= 0),
  ended_world_time bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ended_world_time IS NULL OR ended_world_time >= started_world_time)
);
CREATE UNIQUE INDEX IF NOT EXISTS world_business_employment_one_active_job_idx
  ON world_business_employment(world_id,agent_id) WHERE status='active';
CREATE UNIQUE INDEX IF NOT EXISTS world_business_job_one_active_employee_idx
  ON world_business_employment(job_id) WHERE status='active';

CREATE TABLE IF NOT EXISTS world_business_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  business_id uuid NOT NULL REFERENCES world_businesses(id) ON DELETE CASCADE,
  service_id uuid NOT NULL REFERENCES world_business_services(id) ON DELETE RESTRICT,
  customer_agent_id uuid NOT NULL REFERENCES agents(id),
  price_usdc numeric(30,8) NOT NULL CHECK (price_usdc > 0),
  status text NOT NULL CHECK (status IN ('fulfilled','refunded')),
  action_id text NOT NULL,
  world_time bigint NOT NULL CHECK (world_time >= 0),
  benefit jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(benefit)='object'),
  transaction_id uuid REFERENCES world_economic_transactions(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (world_id,customer_agent_id,action_id)
);

CREATE TABLE IF NOT EXISTS world_business_production (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  business_id uuid NOT NULL REFERENCES world_businesses(id) ON DELETE CASCADE,
  service_id uuid NOT NULL REFERENCES world_business_services(id) ON DELETE RESTRICT,
  agent_id uuid NOT NULL REFERENCES agents(id),
  employment_id uuid REFERENCES world_business_employment(id) ON DELETE SET NULL,
  action_id text NOT NULL,
  units integer NOT NULL DEFAULT 1 CHECK (units BETWEEN 1 AND 10),
  world_time bigint NOT NULL CHECK (world_time >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (world_id,action_id)
);

CREATE TABLE IF NOT EXISTS world_economic_demand (
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  service_type text NOT NULL CHECK (service_type ~ '^[a-z][a-z0-9_]{1,47}$'),
  world_day bigint NOT NULL CHECK (world_day >= 0),
  demand_count integer NOT NULL DEFAULT 0 CHECK (demand_count >= 0),
  supply_count integer NOT NULL DEFAULT 0 CHECK (supply_count >= 0),
  unmet_count integer NOT NULL DEFAULT 0 CHECK (unmet_count >= 0),
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(evidence)='object'),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (world_id,service_type,world_day)
);

-- V5 institutions. These records are additive to V4: contracts reference the
-- existing world economy and do not create a second balance or settlement path.
ALTER TABLE world_organizations ADD COLUMN IF NOT EXISTS governance_mode text NOT NULL DEFAULT 'founder_led';
ALTER TABLE world_organizations ADD COLUMN IF NOT EXISTS governance_rules jsonb NOT NULL DEFAULT '{}'::jsonb;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='world_organizations'::regclass
      AND conname='world_organizations_governance_mode_check') THEN
    ALTER TABLE world_organizations ADD CONSTRAINT world_organizations_governance_mode_check
      CHECK (governance_mode IN ('founder_led','member_vote','reputation_weighted','skill_based','delegated'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS world_agreements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  agreement_type text NOT NULL CHECK (agreement_type IN ('employment','service','project_cooperation','investment',
    'revenue_sharing','resource_sharing','organization_membership','supplier_relationship','partnership')),
  proposer_agent_id uuid NOT NULL,
  counterparty_agent_id uuid NOT NULL,
  terms jsonb NOT NULL CHECK (jsonb_typeof(terms)='object'),
  status text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','countered','accepted','active','completed',
    'breached','cancelled','expired','rejected')),
  parent_agreement_id uuid REFERENCES world_agreements(id) ON DELETE SET NULL,
  negotiation_round integer NOT NULL DEFAULT 1 CHECK (negotiation_round BETWEEN 1 AND 8),
  action_id text NOT NULL CHECK (char_length(action_id) BETWEEN 8 AND 180),
  created_world_time bigint NOT NULL CHECK (created_world_time >= 0),
  accepted_world_time bigint,
  activated_world_time bigint,
  expires_world_time bigint CHECK (expires_world_time IS NULL OR expires_world_time >= created_world_time),
  completed_world_time bigint,
  updated_world_time bigint NOT NULL CHECK (updated_world_time >= 0),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata)='object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (proposer_agent_id <> counterparty_agent_id),
  CHECK (accepted_world_time IS NULL OR accepted_world_time >= created_world_time),
  CHECK (completed_world_time IS NULL OR completed_world_time >= created_world_time),
  FOREIGN KEY (world_id,proposer_agent_id) REFERENCES world_members(world_id,agent_id) ON DELETE CASCADE,
  FOREIGN KEY (world_id,counterparty_agent_id) REFERENCES world_members(world_id,agent_id) ON DELETE CASCADE,
  UNIQUE (world_id,proposer_agent_id,action_id)
);
CREATE INDEX IF NOT EXISTS world_agreements_inbox_idx
  ON world_agreements(world_id,counterparty_agent_id,status,created_world_time DESC);
CREATE INDEX IF NOT EXISTS world_agreements_participants_idx
  ON world_agreements(world_id,proposer_agent_id,counterparty_agent_id,status,updated_world_time DESC);
CREATE INDEX IF NOT EXISTS world_agreements_expiry_idx
  ON world_agreements(world_id,expires_world_time) WHERE status IN ('proposed','accepted','active');

CREATE TABLE IF NOT EXISTS world_agreement_participants (
  agreement_id uuid NOT NULL REFERENCES world_agreements(id) ON DELETE CASCADE,
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('proposer','counterparty','participant')),
  response text NOT NULL DEFAULT 'pending' CHECK (response IN ('pending','accepted','rejected','countered')),
  responded_world_time bigint CHECK (responded_world_time IS NULL OR responded_world_time >= 0),
  PRIMARY KEY (agreement_id,agent_id),
  FOREIGN KEY (world_id,agent_id) REFERENCES world_members(world_id,agent_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS world_agreement_participants_agent_idx
  ON world_agreement_participants(world_id,agent_id,response);

CREATE TABLE IF NOT EXISTS world_agreement_outcomes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  agreement_id uuid NOT NULL REFERENCES world_agreements(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL,
  counterparty_agent_id uuid NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('fulfilled','unable','breached')),
  reason text CHECK (reason IS NULL OR reason IN ('completed','unable_to_fulfill','voluntary_exit','missed_deadline')),
  action_id text NOT NULL CHECK (char_length(action_id) BETWEEN 8 AND 180),
  world_time bigint NOT NULL CHECK (world_time >= 0),
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(evidence)='object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (world_id,agent_id,action_id),
  FOREIGN KEY (world_id,agent_id) REFERENCES world_members(world_id,agent_id) ON DELETE CASCADE,
  FOREIGN KEY (world_id,counterparty_agent_id) REFERENCES world_members(world_id,agent_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS world_agreement_outcomes_recent_idx
  ON world_agreement_outcomes(world_id,agreement_id,world_time DESC,id DESC);

CREATE TABLE IF NOT EXISTS world_commitments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  agreement_id uuid NOT NULL REFERENCES world_agreements(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL,
  counterparty_agent_id uuid NOT NULL,
  commitment_type text NOT NULL CHECK (commitment_type IN ('work','delivery','payment','project','resource','meeting','service')),
  description text NOT NULL CHECK (char_length(description) BETWEEN 3 AND 240),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','fulfilled','unable','breached','cancelled','expired')),
  due_world_time bigint NOT NULL CHECK (due_world_time >= 0),
  completed_world_time bigint,
  outcome_reason text CHECK (outcome_reason IS NULL OR outcome_reason IN ('completed','unable_to_fulfill','voluntary_exit','missed_deadline')),
  action_id text NOT NULL CHECK (char_length(action_id) BETWEEN 8 AND 180),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata)='object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (world_id,agent_id,action_id),
  FOREIGN KEY (world_id,agent_id) REFERENCES world_members(world_id,agent_id) ON DELETE CASCADE,
  FOREIGN KEY (world_id,counterparty_agent_id) REFERENCES world_members(world_id,agent_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS world_commitments_due_idx ON world_commitments(world_id,due_world_time) WHERE status='active';
CREATE INDEX IF NOT EXISTS world_commitments_agent_idx ON world_commitments(world_id,agent_id,status,due_world_time);

CREATE TABLE IF NOT EXISTS world_agent_reputations (
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL,
  reliability numeric(6,2) NOT NULL DEFAULT 0 CHECK (reliability BETWEEN -100 AND 100),
  professional numeric(6,2) NOT NULL DEFAULT 0 CHECK (professional BETWEEN -100 AND 100),
  financial numeric(6,2) NOT NULL DEFAULT 0 CHECK (financial BETWEEN -100 AND 100),
  cooperation numeric(6,2) NOT NULL DEFAULT 0 CHECK (cooperation BETWEEN -100 AND 100),
  fulfilled_count integer NOT NULL DEFAULT 0 CHECK (fulfilled_count >= 0),
  breach_count integer NOT NULL DEFAULT 0 CHECK (breach_count >= 0),
  updated_world_time bigint NOT NULL DEFAULT 0 CHECK (updated_world_time >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (world_id,agent_id),
  FOREIGN KEY (world_id,agent_id) REFERENCES world_members(world_id,agent_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS world_organization_proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES world_organizations(id) ON DELETE CASCADE,
  proposer_agent_id uuid NOT NULL,
  proposal_type text NOT NULL CHECK (proposal_type IN ('rule_change','leadership_change','treasury_spend',
    'project_approval','member_change','business_funding')),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload)='object'),
  status text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','approved','rejected','executed','expired','countered')),
  parent_proposal_id uuid REFERENCES world_organization_proposals(id) ON DELETE SET NULL,
  action_id text NOT NULL CHECK (char_length(action_id) BETWEEN 8 AND 180),
  created_world_time bigint NOT NULL CHECK (created_world_time >= 0),
  expires_world_time bigint NOT NULL CHECK (expires_world_time >= created_world_time),
  resolved_world_time bigint,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata)='object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (world_id,proposer_agent_id,action_id),
  FOREIGN KEY (world_id,proposer_agent_id) REFERENCES world_members(world_id,agent_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS world_organization_proposals_open_idx
  ON world_organization_proposals(world_id,organization_id,status,expires_world_time);

CREATE TABLE IF NOT EXISTS world_organization_proposal_votes (
  proposal_id uuid NOT NULL REFERENCES world_organization_proposals(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES world_organizations(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  decision text NOT NULL CHECK (decision IN ('support','reject','abstain')),
  action_id text NOT NULL CHECK (char_length(action_id) BETWEEN 8 AND 180),
  world_time bigint NOT NULL CHECK (world_time >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (proposal_id,agent_id)
);

CREATE TABLE IF NOT EXISTS world_social_norms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  scope_type text NOT NULL CHECK (scope_type IN ('world','organization','business')),
  scope_id uuid,
  norm_key text NOT NULL CHECK (char_length(norm_key) BETWEEN 3 AND 120),
  behavior text NOT NULL CHECK (char_length(behavior) BETWEEN 3 AND 240),
  confidence numeric(5,4) NOT NULL DEFAULT 0.1 CHECK (confidence BETWEEN 0 AND 1),
  support_count integer NOT NULL DEFAULT 0 CHECK (support_count >= 0),
  violation_count integer NOT NULL DEFAULT 0 CHECK (violation_count >= 0),
  created_world_time bigint NOT NULL CHECK (created_world_time >= 0),
  updated_world_time bigint NOT NULL CHECK (updated_world_time >= 0),
  source_type text NOT NULL CHECK (source_type IN ('agreement','governance','shared_history')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata)='object'),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (world_id,scope_type,scope_id,norm_key)
);
CREATE INDEX IF NOT EXISTS world_social_norms_scope_idx ON world_social_norms(world_id,scope_type,scope_id,confidence DESC);

CREATE TABLE IF NOT EXISTS world_agreement_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  scope_type text NOT NULL CHECK (scope_type IN ('world','organization','business')),
  scope_id uuid,
  agreement_type text NOT NULL CHECK (agreement_type IN ('employment','service','project_cooperation','investment',
    'revenue_sharing','resource_sharing','organization_membership','supplier_relationship','partnership')),
  template_key text NOT NULL CHECK (char_length(template_key) BETWEEN 3 AND 120),
  terms jsonb NOT NULL CHECK (jsonb_typeof(terms)='object'),
  sample_count integer NOT NULL DEFAULT 0 CHECK (sample_count >= 0),
  success_count integer NOT NULL DEFAULT 0 CHECK (success_count >= 0 AND success_count <= sample_count),
  created_world_time bigint NOT NULL CHECK (created_world_time >= 0),
  updated_world_time bigint NOT NULL CHECK (updated_world_time >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (world_id,scope_type,scope_id,agreement_type,template_key)
);

CREATE TABLE IF NOT EXISTS world_institutional_memories (
  id bigserial PRIMARY KEY,
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  institution_type text NOT NULL CHECK (institution_type IN ('organization','business')),
  institution_id uuid NOT NULL,
  memory_type text NOT NULL CHECK (memory_type IN ('agreement_success','agreement_failure','rule_change','leadership_change','conflict_resolved','partnership')),
  summary text NOT NULL CHECK (char_length(summary) BETWEEN 3 AND 240),
  evidence_count integer NOT NULL DEFAULT 1 CHECK (evidence_count >= 1),
  world_time bigint NOT NULL CHECK (world_time >= 0),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata)='object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (world_id,institution_type,institution_id,memory_type,summary)
);
CREATE INDEX IF NOT EXISTS world_institutional_memories_recent_idx
  ON world_institutional_memories(world_id,institution_type,institution_id,world_time DESC,id DESC);

CREATE TABLE IF NOT EXISTS world_institutional_beliefs (
  id bigserial PRIMARY KEY,
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  institution_type text NOT NULL CHECK (institution_type IN ('organization','business')),
  institution_id uuid NOT NULL,
  belief_key text NOT NULL CHECK (char_length(belief_key) BETWEEN 3 AND 96),
  subject_type text NOT NULL CHECK (subject_type IN ('resident','business','agreement_type')),
  subject_key text NOT NULL CHECK (char_length(subject_key) BETWEEN 1 AND 128),
  estimate numeric(6,4) NOT NULL CHECK (estimate BETWEEN -1 AND 1),
  confidence numeric(5,4) NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  sample_count integer NOT NULL DEFAULT 1 CHECK (sample_count >= 1),
  updated_world_time bigint NOT NULL CHECK (updated_world_time >= 0),
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(evidence)='object'),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (world_id,institution_type,institution_id,belief_key,subject_type,subject_key)
);
CREATE INDEX IF NOT EXISTS world_institutional_beliefs_subject_idx
  ON world_institutional_beliefs(world_id,institution_type,institution_id,subject_type,subject_key);

ALTER TABLE world_business_production ADD COLUMN IF NOT EXISTS agreement_id uuid REFERENCES world_agreements(id) ON DELETE SET NULL;
ALTER TABLE world_business_orders ADD COLUMN IF NOT EXISTS agreement_id uuid REFERENCES world_agreements(id) ON DELETE SET NULL;
ALTER TABLE world_agent_states ADD COLUMN IF NOT EXISTS next_institutional_review_world_minutes bigint;

-- V6 gives residents a persistent, versioned capability layer. Capabilities
-- are declarative compositions interpreted by an allowlisted runtime; they
-- never contain executable source code.
ALTER TABLE world_agent_states ADD COLUMN IF NOT EXISTS next_civilization_review_world_minutes bigint;

CREATE TABLE IF NOT EXISTS world_epochs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  epoch_code text NOT NULL CHECK (epoch_code ~ '^V[0-9]+(\.[0-9]+)?$'),
  name text NOT NULL CHECK (char_length(name) BETWEEN 3 AND 120),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','historic')),
  started_world_minute bigint NOT NULL CHECK (started_world_minute >= 0),
  started_at timestamptz NOT NULL DEFAULT now(),
  description text NOT NULL CHECK (char_length(description) BETWEEN 1 AND 600),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata)='object'),
  UNIQUE (world_id,epoch_code),
  UNIQUE (world_id,id)
);
CREATE UNIQUE INDEX IF NOT EXISTS world_epochs_active_idx ON world_epochs(world_id) WHERE status='active';

CREATE TABLE IF NOT EXISTS world_capability_gaps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  gap_key text NOT NULL CHECK (char_length(gap_key) BETWEEN 3 AND 160),
  category text NOT NULL CHECK (category ~ '^[a-z][a-z0-9_.-]{1,79}$'),
  problem_statement text NOT NULL CHECK (char_length(problem_statement) BETWEEN 8 AND 600),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','addressed','resolved','stale')),
  observation_count integer NOT NULL DEFAULT 1 CHECK (observation_count > 0),
  first_observed_world_minute bigint NOT NULL CHECK (first_observed_world_minute >= 0),
  last_observed_world_minute bigint NOT NULL CHECK (last_observed_world_minute >= 0),
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(evidence)='object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (world_id,gap_key),
  UNIQUE (world_id,id)
);
CREATE INDEX IF NOT EXISTS world_capability_gaps_open_idx
  ON world_capability_gaps(world_id,status,last_observed_world_minute DESC);

CREATE TABLE IF NOT EXISTS world_capability_observations (
  id bigserial PRIMARY KEY,
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  gap_id uuid NOT NULL,
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  observed_world_day bigint NOT NULL CHECK (observed_world_day >= 0),
  observed_world_minute bigint NOT NULL CHECK (observed_world_minute >= 0),
  observation_path text NOT NULL CHECK (observation_path ~ '^[a-z][a-z0-9_.-]{1,79}$'),
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(evidence)='object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (world_id,gap_id,agent_id,observed_world_day),
  FOREIGN KEY (world_id,gap_id) REFERENCES world_capability_gaps(world_id,id) ON DELETE CASCADE,
  FOREIGN KEY (world_id,agent_id) REFERENCES world_members(world_id,agent_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS world_capability_observations_agent_idx
  ON world_capability_observations(world_id,agent_id,observed_world_minute DESC);

CREATE TABLE IF NOT EXISTS world_capabilities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  capability_key text NOT NULL CHECK (char_length(capability_key) BETWEEN 2 AND 120),
  category text NOT NULL CHECK (category ~ '^[a-z][a-z0-9_.-]{1,79}$'),
  name text NOT NULL CHECK (char_length(name) BETWEEN 3 AND 120),
  description text NOT NULL CHECK (char_length(description) BETWEEN 8 AND 600),
  status text NOT NULL DEFAULT 'experimental' CHECK (status IN ('proposed','experimental','active','deprecated','rejected')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  parent_capability_id uuid,
  creator_type text NOT NULL DEFAULT 'system' CHECK (creator_type IN ('system','resident','organization')),
  creator_agent_id uuid REFERENCES agents(id) ON DELETE SET NULL,
  creator_organization_id uuid REFERENCES world_organizations(id) ON DELETE SET NULL,
  specification jsonb NOT NULL CHECK (jsonb_typeof(specification)='object'),
  experiment_scope jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(experiment_scope)='object'),
  created_world_minute bigint NOT NULL CHECK (created_world_minute >= 0),
  adopted_world_minute bigint,
  usage_count bigint NOT NULL DEFAULT 0 CHECK (usage_count >= 0),
  success_count bigint NOT NULL DEFAULT 0 CHECK (success_count >= 0),
  failure_count bigint NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata)='object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (world_id,capability_key,version),
  UNIQUE (world_id,id),
  FOREIGN KEY (world_id,parent_capability_id) REFERENCES world_capabilities(world_id,id) ON DELETE SET NULL (parent_capability_id)
);
CREATE INDEX IF NOT EXISTS world_capabilities_status_idx
  ON world_capabilities(world_id,status,category,name);
CREATE INDEX IF NOT EXISTS world_capabilities_parent_idx
  ON world_capabilities(world_id,parent_capability_id,version);

CREATE TABLE IF NOT EXISTS world_capability_proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  gap_id uuid NOT NULL,
  creator_type text NOT NULL CHECK (creator_type IN ('resident','organization')),
  creator_agent_id uuid REFERENCES agents(id) ON DELETE SET NULL,
  creator_organization_id uuid REFERENCES world_organizations(id) ON DELETE SET NULL,
  action_id text NOT NULL CHECK (char_length(action_id) BETWEEN 8 AND 180),
  category text NOT NULL CHECK (category ~ '^[a-z][a-z0-9_.-]{1,79}$'),
  name text NOT NULL CHECK (char_length(name) BETWEEN 3 AND 120),
  problem_statement text NOT NULL CHECK (char_length(problem_statement) BETWEEN 8 AND 600),
  proposed_capability jsonb NOT NULL CHECK (jsonb_typeof(proposed_capability)='object'),
  expected_benefit text NOT NULL CHECK (char_length(expected_benefit) BETWEEN 3 AND 600),
  expected_cost jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(expected_cost)='object'),
  required_resources jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(required_resources)='object'),
  affected_systems jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(affected_systems)='array'),
  status text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','reviewed','revised','experimental','evaluated','adopted','rejected','abandoned')),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  revision_of_proposal_id uuid,
  capability_id uuid,
  support_count integer NOT NULL DEFAULT 0 CHECK (support_count >= 0),
  opposition_count integer NOT NULL DEFAULT 0 CHECK (opposition_count >= 0),
  created_world_minute bigint NOT NULL CHECK (created_world_minute >= 0),
  updated_world_minute bigint NOT NULL CHECK (updated_world_minute >= 0),
  expires_world_minute bigint,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata)='object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (world_id,action_id),
  UNIQUE (world_id,id),
  FOREIGN KEY (world_id,gap_id) REFERENCES world_capability_gaps(world_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (world_id,revision_of_proposal_id) REFERENCES world_capability_proposals(world_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (world_id,capability_id) REFERENCES world_capabilities(world_id,id) ON DELETE SET NULL (capability_id)
);
ALTER TABLE world_capability_proposals ADD COLUMN IF NOT EXISTS expires_world_minute bigint;
CREATE INDEX IF NOT EXISTS world_capability_proposals_status_idx
  ON world_capability_proposals(world_id,status,updated_world_minute DESC);
CREATE INDEX IF NOT EXISTS world_capability_proposals_creator_idx
  ON world_capability_proposals(world_id,creator_agent_id,created_world_minute DESC);

CREATE TABLE IF NOT EXISTS world_capability_experiments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  proposal_id uuid NOT NULL,
  capability_id uuid NOT NULL,
  scope_type text NOT NULL CHECK (scope_type IN ('resident_set','organization','project','place')),
  scope_id uuid,
  participant_agent_ids jsonb NOT NULL CHECK (jsonb_typeof(participant_agent_ids)='array'),
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running','evaluated','adopted','revised','rejected','abandoned')),
  started_world_minute bigint NOT NULL CHECK (started_world_minute >= 0),
  ends_world_minute bigint NOT NULL CHECK (ends_world_minute > started_world_minute),
  evaluated_world_minute bigint,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(evidence)='object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (world_id,id),
  FOREIGN KEY (world_id,proposal_id) REFERENCES world_capability_proposals(world_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (world_id,capability_id) REFERENCES world_capabilities(world_id,id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS world_capability_experiments_status_idx
  ON world_capability_experiments(world_id,status,ends_world_minute);

CREATE TABLE IF NOT EXISTS world_capability_reviews (
  id bigserial PRIMARY KEY,
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  proposal_id uuid NOT NULL,
  experiment_id uuid,
  reviewer_agent_id uuid REFERENCES agents(id) ON DELETE SET NULL,
  reviewer_organization_id uuid REFERENCES world_organizations(id) ON DELETE SET NULL,
  review_stage text NOT NULL CHECK (review_stage IN ('proposal','experiment')),
  decision text NOT NULL CHECK (decision IN ('support','oppose','modify','ignore')),
  rationale text NOT NULL CHECK (char_length(rationale) BETWEEN 3 AND 600),
  suggested_specification jsonb CHECK (suggested_specification IS NULL OR jsonb_typeof(suggested_specification)='object'),
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(evidence)='object'),
  created_world_minute bigint NOT NULL CHECK (created_world_minute >= 0),
  action_id text NOT NULL CHECK (char_length(action_id) BETWEEN 8 AND 180),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (world_id,action_id),
  FOREIGN KEY (world_id,proposal_id) REFERENCES world_capability_proposals(world_id,id) ON DELETE CASCADE,
  FOREIGN KEY (world_id,experiment_id) REFERENCES world_capability_experiments(world_id,id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS world_capability_reviews_proposal_idx
  ON world_capability_reviews(world_id,proposal_id,review_stage,created_world_minute DESC);
CREATE UNIQUE INDEX IF NOT EXISTS world_capability_proposals_one_review_idx
  ON world_capability_reviews(world_id,proposal_id,reviewer_agent_id)
  WHERE review_stage='proposal' AND reviewer_agent_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS world_capability_uses (
  id bigserial PRIMARY KEY,
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  capability_id uuid NOT NULL,
  experiment_id uuid,
  actor_agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  partner_agent_id uuid REFERENCES agents(id) ON DELETE SET NULL,
  action_id text NOT NULL CHECK (char_length(action_id) BETWEEN 8 AND 180),
  decision_source text NOT NULL DEFAULT 'agent_api'
    CHECK (decision_source IN ('agent_api','fruitfly','utility_fallback')),
  world_minute bigint NOT NULL CHECK (world_minute >= 0),
  status text NOT NULL CHECK (status IN ('completed','failed','abandoned')),
  success boolean NOT NULL,
  costs jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(costs)='object'),
  effects jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(effects)='array'),
  side_effects jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(side_effects)='array'),
  result jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(result)='object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (world_id,action_id),
  FOREIGN KEY (world_id,capability_id) REFERENCES world_capabilities(world_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (world_id,experiment_id) REFERENCES world_capability_experiments(world_id,id) ON DELETE RESTRICT
);
ALTER TABLE world_capability_uses ADD COLUMN IF NOT EXISTS decision_source text NOT NULL DEFAULT 'agent_api'
  CHECK (decision_source IN ('agent_api','fruitfly','utility_fallback'));
CREATE INDEX IF NOT EXISTS world_capability_uses_capability_idx
  ON world_capability_uses(world_id,capability_id,world_minute DESC);

CREATE TABLE IF NOT EXISTS world_capability_events (
  id bigserial PRIMARY KEY,
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  actor_agent_id uuid REFERENCES agents(id) ON DELETE SET NULL,
  gap_id uuid,
  proposal_id uuid,
  capability_id uuid,
  experiment_id uuid,
  event_type text NOT NULL CHECK (event_type ~ '^[a-z][a-z0-9_]{1,63}$'),
  event_key text NOT NULL,
  world_minute bigint NOT NULL CHECK (world_minute >= 0),
  details jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details)='object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (world_id,event_key),
  FOREIGN KEY (world_id,gap_id) REFERENCES world_capability_gaps(world_id,id) ON DELETE SET NULL (gap_id),
  FOREIGN KEY (world_id,proposal_id) REFERENCES world_capability_proposals(world_id,id) ON DELETE SET NULL (proposal_id),
  FOREIGN KEY (world_id,capability_id) REFERENCES world_capabilities(world_id,id) ON DELETE SET NULL (capability_id),
  FOREIGN KEY (world_id,experiment_id) REFERENCES world_capability_experiments(world_id,id) ON DELETE SET NULL (experiment_id)
);
CREATE INDEX IF NOT EXISTS world_capability_events_recent_idx
  ON world_capability_events(world_id,world_minute DESC,id DESC);

CREATE UNIQUE INDEX IF NOT EXISTS agent_memories_world_epoch_once_idx
  ON agent_memories(world_id,agent_id,consolidation_key)
  WHERE consolidation_key LIKE 'world_epoch:%';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='world_history'::regclass
      AND conname='world_history_event_type_check'
      AND pg_get_constraintdef(oid) LIKE '%world_epoch_started%')
      AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='world_history'::regclass
        AND conname='world_history_event_type_check' AND pg_get_constraintdef(oid) LIKE '%{1,79}%') THEN
    ALTER TABLE world_history DROP CONSTRAINT IF EXISTS world_history_event_type_check;
    ALTER TABLE world_history ADD CONSTRAINT world_history_event_type_check CHECK (
      event_type IN ('opportunity_created','project_proposed','project_started','project_completed','project_failed',
        'organization_founded','organization_joined','organization_left','organization_invited','place_created',
        'place_maintenance','place_closed','information_shared','information_accepted','information_doubted','information_ignored',
        'cooperation_completed','milestone','project_invested','project_revenue','business_founded','business_invested',
        'business_reopened','business_first_customer','business_revenue','business_profit','business_loss','business_closed',
        'business_employment','business_price_changed','business_partnership','business_capability_practiced','economic_purchase',
        'agreement_proposed','agreement_countered','agreement_accepted','agreement_rejected','agreement_completed','agreement_breached',
        'organization_rule_changed','organization_proposal','organization_leadership_changed','norm_formed','ownership_transferred')
      OR event_type ~ '^agreement_[a-z_]+$'
      OR event_type ~ '^(capability|world_epoch)_[a-z_]+$'
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='world_history'::regclass
      AND conname='world_history_entity_type_check'
      AND pg_get_constraintdef(oid) LIKE '%capability_proposal%')
      AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='world_history'::regclass
        AND conname='world_history_entity_type_check' AND pg_get_constraintdef(oid) LIKE '%{1,79}%') THEN
    ALTER TABLE world_history DROP CONSTRAINT IF EXISTS world_history_entity_type_check;
    ALTER TABLE world_history ADD CONSTRAINT world_history_entity_type_check CHECK (
      entity_type IN ('opportunity','project','organization','place','cooperation','world','business','job','order','agreement','norm',
        'capability','capability_proposal')
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='world_agent_states'::regclass
      AND conname='world_agent_states_planned_action_check'
      AND pg_get_constraintdef(oid) LIKE '%capability_use%') THEN
    ALTER TABLE world_agent_states DROP CONSTRAINT IF EXISTS world_agent_states_planned_action_check;
    ALTER TABLE world_agent_states ADD CONSTRAINT world_agent_states_planned_action_check CHECK (
      planned_action IS NULL OR planned_action IN (
        'work','learn','rest','eat','socialize','trade','cooperate','opportunity','opportunity_reject','opportunity_propose',
        'project_propose','project_join','project_reject','project_contribute','project_leave','organization_found','organization_join',
        'organization_leave','organization_invite','organization_reject','organization_contribute','place_create','information_share',
        'information_accept','information_ignore','information_doubt','goal_review','project_invest','project_distribute',
        'business_found','business_service','business_apply','business_withdraw','business_leave','business_hire','business_work',
        'business_invest','business_reject','business_price','business_distribute','business_close','business_skill_practice',
        'business_seek_cofounder','business_market_observe','business_reopen','agreement_propose','agreement_respond',
        'commitment_resolve','organization_propose','organization_vote','capability_use'
      )
    );
  END IF;
END $$;

-- Keep V6 event and action vocabularies after all compatibility blocks above.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='world_history'::regclass
      AND conname='world_history_event_type_check' AND pg_get_constraintdef(oid) LIKE '%world_epoch_started%')
      AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='world_history'::regclass
        AND conname='world_history_event_type_check' AND pg_get_constraintdef(oid) LIKE '%{1,79}%') THEN
    ALTER TABLE world_history DROP CONSTRAINT IF EXISTS world_history_event_type_check;
    ALTER TABLE world_history ADD CONSTRAINT world_history_event_type_check CHECK (
      event_type IN ('opportunity_created','project_proposed','project_started','project_completed','project_failed',
        'organization_founded','organization_joined','organization_left','organization_invited','place_created',
        'place_maintenance','place_closed','information_shared','information_accepted','information_doubted','information_ignored',
        'cooperation_completed','milestone','project_invested','project_revenue','business_founded','business_invested',
        'business_reopened','business_first_customer','business_revenue','business_profit','business_loss','business_closed',
        'business_employment','business_price_changed','business_partnership','business_capability_practiced','economic_purchase',
        'agreement_proposed','agreement_countered','agreement_accepted','agreement_rejected','agreement_completed','agreement_breached',
        'organization_rule_changed','organization_proposal','organization_leadership_changed','norm_formed','ownership_transferred')
      OR event_type ~ '^agreement_[a-z_]+$'
      OR event_type ~ '^(capability|world_epoch)_[a-z_]+$'
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='world_history'::regclass
      AND conname='world_history_entity_type_check' AND pg_get_constraintdef(oid) LIKE '%capability_proposal%')
      AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='world_history'::regclass
        AND conname='world_history_entity_type_check' AND pg_get_constraintdef(oid) LIKE '%{1,79}%') THEN
    ALTER TABLE world_history DROP CONSTRAINT IF EXISTS world_history_entity_type_check;
    ALTER TABLE world_history ADD CONSTRAINT world_history_entity_type_check CHECK (
      entity_type IN ('opportunity','project','organization','place','cooperation','world','business','job','order',
        'agreement','norm','capability','capability_proposal')
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='world_agent_states'::regclass
      AND conname='world_agent_states_planned_action_check' AND pg_get_constraintdef(oid) LIKE '%capability_use%') THEN
    ALTER TABLE world_agent_states DROP CONSTRAINT IF EXISTS world_agent_states_planned_action_check;
    ALTER TABLE world_agent_states ADD CONSTRAINT world_agent_states_planned_action_check CHECK (
      planned_action IS NULL OR planned_action IN (
        'work','learn','rest','eat','socialize','trade','cooperate','opportunity','opportunity_reject','opportunity_propose',
        'project_propose','project_join','project_reject','project_contribute','project_leave','organization_found','organization_join',
        'organization_leave','organization_invite','organization_reject','organization_contribute','place_create','information_share',
        'information_accept','information_ignore','information_doubt','goal_review','project_invest','project_distribute',
        'business_found','business_service','business_apply','business_withdraw','business_leave','business_hire','business_work',
        'business_invest','business_reject','business_price','business_distribute','business_close','business_skill_practice',
        'business_seek_cofounder','business_market_observe','business_reopen','agreement_propose','agreement_respond',
        'commitment_resolve','organization_propose','organization_vote','capability_use'
      )
    );
  END IF;
END $$;

-- Backfill active V4 jobs as agreements without changing their current wages,
-- balances, application status, or transaction history.
INSERT INTO world_agreements(world_id,agreement_type,proposer_agent_id,counterparty_agent_id,terms,status,
    action_id,created_world_time,accepted_world_time,activated_world_time,updated_world_time,metadata)
SELECT employment.world_id,'employment',business.founder_agent_id,employment.agent_id,
    jsonb_build_object('businessId',employment.business_id,'jobId',employment.job_id,'employmentId',employment.id,
      'wageUsdc',employment.wage_usdc::text,'role',job.role,'legacyV4',true),
    'active','v5:employment:'||employment.id::text,employment.started_world_time,employment.started_world_time,
    employment.started_world_time,employment.started_world_time,'{"backfilledFrom":"v4_employment"}'::jsonb
  FROM world_business_employment employment
  JOIN world_businesses business ON business.world_id=employment.world_id AND business.id=employment.business_id
  JOIN world_business_jobs job ON job.world_id=employment.world_id AND job.id=employment.job_id
  WHERE employment.status='active'
ON CONFLICT(world_id,proposer_agent_id,action_id) DO NOTHING;
INSERT INTO world_agreement_participants(agreement_id,world_id,agent_id,role,response,responded_world_time)
SELECT agreement.id,agreement.world_id,agreement.proposer_agent_id,'proposer','accepted',agreement.accepted_world_time
  FROM world_agreements agreement WHERE agreement.status='active'
ON CONFLICT DO NOTHING;
INSERT INTO world_agreement_participants(agreement_id,world_id,agent_id,role,response,responded_world_time)
SELECT agreement.id,agreement.world_id,agreement.counterparty_agent_id,'counterparty','accepted',agreement.accepted_world_time
  FROM world_agreements agreement WHERE agreement.status='active'
ON CONFLICT DO NOTHING;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='world_economic_transactions'::regclass
      AND conname='world_economic_transactions_transaction_type_check'
      AND pg_get_constraintdef(oid) LIKE '%ownership_transfer%'
      AND pg_get_constraintdef(oid) LIKE '%business_revenue_share%'
      AND pg_get_constraintdef(oid) LIKE '%business_reopen%'
      AND pg_get_constraintdef(oid) LIKE '%capability_service%') THEN
    ALTER TABLE world_economic_transactions DROP CONSTRAINT IF EXISTS world_economic_transactions_transaction_type_check;
    ALTER TABLE world_economic_transactions ADD CONSTRAINT world_economic_transactions_transaction_type_check
      CHECK (transaction_type IN ('opening_balance','simulation_seed','business_found','business_investment','business_reopen','business_revenue',
        'business_expense','business_wage','profit_distribution','project_investment','organization_contribution','place_revenue',
        'consumption','exchange_trade','maintenance','world_reward','refund','ownership_transfer','business_revenue_share',
        'resource_transfer','capability_service'));
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS world_businesses_active_idx ON world_businesses(world_id,status,reputation DESC);
CREATE INDEX IF NOT EXISTS world_business_services_market_idx ON world_business_services(world_id,service_type,active);
CREATE INDEX IF NOT EXISTS world_business_jobs_open_idx ON world_business_jobs(world_id,status,created_world_time);
CREATE INDEX IF NOT EXISTS world_business_applications_pending_idx ON world_business_applications(world_id,business_id,status);
CREATE INDEX IF NOT EXISTS world_business_applications_pending_age_idx
  ON world_business_applications(world_id,created_world_time) WHERE status='pending';
CREATE INDEX IF NOT EXISTS world_business_orders_recent_idx ON world_business_orders(world_id,world_time DESC,id);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='world_business_applications'::regclass
      AND conname='world_business_applications_status_check' AND pg_get_constraintdef(oid) LIKE '%expired%') THEN
    ALTER TABLE world_business_applications DROP CONSTRAINT IF EXISTS world_business_applications_status_check;
    ALTER TABLE world_business_applications ADD CONSTRAINT world_business_applications_status_check
      CHECK (status IN ('pending','accepted','rejected','withdrawn','expired'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='world_history'::regclass
      AND conname='world_history_event_type_check' AND pg_get_constraintdef(oid) LIKE '%business_founded%'
      AND pg_get_constraintdef(oid) LIKE '%business_capability_practiced%'
      AND pg_get_constraintdef(oid) LIKE '%place_closed%'
      AND pg_get_constraintdef(oid) LIKE '%project_invested%'
      AND pg_get_constraintdef(oid) LIKE '%project_revenue%'
      AND pg_get_constraintdef(oid) LIKE '%business_profit%')
      AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='world_history'::regclass
        AND conname='world_history_event_type_check' AND pg_get_constraintdef(oid) LIKE '%{1,79}%') THEN
    ALTER TABLE world_history DROP CONSTRAINT IF EXISTS world_history_event_type_check;
    ALTER TABLE world_history ADD CONSTRAINT world_history_event_type_check CHECK (event_type IN (
      'opportunity_created','project_proposed','project_started','project_completed','project_failed',
      'organization_founded','organization_joined','organization_left','organization_invited','place_created',
      'place_maintenance','place_closed',
      'information_shared','information_accepted','information_doubted','information_ignored','cooperation_completed','milestone',
      'project_invested','project_revenue',
      'business_founded','business_invested','business_first_customer','business_revenue','business_profit','business_loss',
      'business_closed','business_employment','business_price_changed','business_partnership','business_capability_practiced','economic_purchase'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='world_history'::regclass
      AND conname='world_history_entity_type_check' AND pg_get_constraintdef(oid) LIKE '%business%')
      AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='world_history'::regclass
        AND conname='world_history_entity_type_check' AND pg_get_constraintdef(oid) LIKE '%{1,79}%') THEN
    ALTER TABLE world_history DROP CONSTRAINT IF EXISTS world_history_entity_type_check;
    ALTER TABLE world_history ADD CONSTRAINT world_history_entity_type_check
      CHECK (entity_type IN ('opportunity','project','organization','place','cooperation','world','business','job','order'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='world_agent_states'::regclass
      AND conname='world_agent_states_planned_action_check'
      AND pg_get_constraintdef(oid) LIKE '%business_service%'
      AND pg_get_constraintdef(oid) LIKE '%business_withdraw%'
      AND pg_get_constraintdef(oid) LIKE '%business_reject%'
      AND pg_get_constraintdef(oid) LIKE '%business_leave%'
      AND pg_get_constraintdef(oid) LIKE '%business_skill_practice%'
      AND pg_get_constraintdef(oid) LIKE '%business_seek_cofounder%'
      AND pg_get_constraintdef(oid) LIKE '%project_invest%'
      AND pg_get_constraintdef(oid) LIKE '%project_distribute%') THEN
    ALTER TABLE world_agent_states DROP CONSTRAINT IF EXISTS world_agent_states_planned_action_check;
    ALTER TABLE world_agent_states ADD CONSTRAINT world_agent_states_planned_action_check
      CHECK (planned_action IS NULL OR planned_action IN ('work','learn','rest','eat','socialize','trade','cooperate',
        'opportunity','opportunity_reject','opportunity_propose','project_propose','project_join','project_reject','project_contribute','project_leave',
        'organization_found','organization_join','organization_leave','organization_invite','organization_reject','organization_contribute',
        'place_create','information_share','information_accept','information_ignore','information_doubt','goal_review',
        'project_invest','project_distribute',
        'business_found','business_service','business_apply','business_withdraw','business_leave','business_hire','business_work','business_invest',
        'business_reject','business_price','business_distribute','business_close','business_skill_practice','business_seek_cofounder'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='world_emergence_events'::regclass
      AND conname='world_emergence_events_system_check' AND pg_get_constraintdef(oid) LIKE '%business%'
      AND pg_get_constraintdef(oid) LIKE '%institution%') THEN
    ALTER TABLE world_emergence_events DROP CONSTRAINT IF EXISTS world_emergence_events_system_check;
    ALTER TABLE world_emergence_events ADD CONSTRAINT world_emergence_events_system_check
      CHECK (system IN ('opportunity','project','organization','information','place','goal','business','employment','economy','institution'));
  END IF;
END $$;

ALTER TABLE world_scenes ADD COLUMN IF NOT EXISTS operating_cost_usdc numeric(30,8) NOT NULL DEFAULT 0
  CHECK (operating_cost_usdc >= 0);
ALTER TABLE world_scenes ADD COLUMN IF NOT EXISTS revenue_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE world_scenes ADD COLUMN IF NOT EXISTS revenue_share_bps integer NOT NULL DEFAULT 0
  CHECK (revenue_share_bps BETWEEN 0 AND 2500);
ALTER TABLE world_scenes ADD COLUMN IF NOT EXISTS last_maintenance_world_day bigint NOT NULL DEFAULT -1
  CHECK (last_maintenance_world_day >= -1);
ALTER TABLE world_scenes ADD COLUMN IF NOT EXISTS maintenance_missed_days integer NOT NULL DEFAULT 0
  CHECK (maintenance_missed_days >= 0);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='world_agent_beliefs'::regclass
      AND conname='world_agent_beliefs_subject_type_check'
      AND pg_get_constraintdef(oid) LIKE '%opportunity%'
      AND pg_get_constraintdef(oid) LIKE '%business%'
      AND pg_get_constraintdef(oid) LIKE '%organization%'
      AND pg_get_constraintdef(oid) LIKE '%market%') THEN
    ALTER TABLE world_agent_beliefs DROP CONSTRAINT IF EXISTS world_agent_beliefs_subject_type_check;
    ALTER TABLE world_agent_beliefs ADD CONSTRAINT world_agent_beliefs_subject_type_check
      CHECK (subject_type IN ('action','place','resident','asset','project','opportunity','business','organization','market'));
  END IF;
END $$;

-- Preserve ownership for existing resident-built assets and give each existing
-- project a separate treasury. These are additive, idempotent backfills.
INSERT INTO world_economic_accounts(world_id,account_type,account_key,owner_id,asset_symbol,balance)
SELECT project.world_id,'project','project:'||project.id::text,project.id,'USDC',0
FROM world_projects project
ON CONFLICT(world_id,account_key,asset_symbol) DO NOTHING;
INSERT INTO world_economic_accounts(world_id,account_type,account_key,owner_id,asset_symbol,balance)
SELECT organization.world_id,'organization','organization:'||organization.id::text,organization.id,'USDC',0
FROM world_organizations organization
ON CONFLICT(world_id,account_key,asset_symbol) DO NOTHING;
INSERT INTO world_economic_ownership(world_id,asset_type,asset_id,owner_type,owner_id,share,invested_usdc,acquired_world_time)
SELECT project.world_id,'project',project.id,'resident',project.creator_agent_id,1,0,project.created_world_time
FROM world_projects project
ON CONFLICT(world_id,asset_type,asset_id,owner_type,owner_id) DO NOTHING;
INSERT INTO world_economic_ownership(world_id,asset_type,asset_id,owner_type,owner_id,share,invested_usdc,acquired_world_time)
SELECT organization.world_id,'organization',organization.id,'resident',organization.founder_agent_id,1,0,organization.created_world_time
FROM world_organizations organization
ON CONFLICT(world_id,asset_type,asset_id,owner_type,owner_id) DO NOTHING;
INSERT INTO world_economic_ownership(world_id,asset_type,asset_id,owner_type,owner_id,share,invested_usdc,acquired_world_time)
SELECT scene.world_id,'place',scene.id,
  CASE WHEN scene.created_by_organization_id IS NOT NULL THEN 'organization'
       WHEN scene.created_by_project_id IS NOT NULL THEN 'project' ELSE 'resident' END,
  COALESCE(scene.created_by_organization_id,scene.created_by_project_id,scene.created_by),1,0,
  scene.created_world_minutes
FROM world_scenes scene
WHERE COALESCE(scene.created_by_organization_id,scene.created_by_project_id,scene.created_by) IS NOT NULL
ON CONFLICT(world_id,asset_type,asset_id,owner_type,owner_id) DO NOTHING;

-- Every transaction must have exactly two equal-and-opposite postings that
-- match its declared source, destination, asset and amount.
CREATE OR REPLACE FUNCTION verify_world_economic_transaction_balance() RETURNS trigger AS $$
DECLARE
  transaction_id_value uuid;
  transaction_row world_economic_transactions%ROWTYPE;
  posting_count integer;
  posting_net numeric;
  source_amount numeric;
  destination_amount numeric;
  source_matches boolean;
  destination_matches boolean;
BEGIN
  IF TG_TABLE_NAME='world_economic_transactions' THEN
    transaction_id_value := NEW.id;
  ELSIF TG_OP='DELETE' THEN
    transaction_id_value := OLD.transaction_id;
  ELSE
    transaction_id_value := NEW.transaction_id;
  END IF;
  SELECT * INTO transaction_row FROM world_economic_transactions WHERE id=transaction_id_value;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT count(*)::int,COALESCE(sum(amount),0),
      COALESCE(sum(amount) FILTER (WHERE account_id=transaction_row.source_account_id),0),
      COALESCE(sum(amount) FILTER (WHERE account_id=transaction_row.destination_account_id),0)
    INTO posting_count,posting_net,source_amount,destination_amount
    FROM world_economic_postings WHERE transaction_id=transaction_id_value;
  SELECT EXISTS(SELECT 1 FROM world_economic_accounts account
    WHERE account.id=transaction_row.source_account_id AND account.world_id=transaction_row.world_id
      AND account.asset_symbol=transaction_row.asset_symbol),
      EXISTS(SELECT 1 FROM world_economic_accounts account
    WHERE account.id=transaction_row.destination_account_id AND account.world_id=transaction_row.world_id
      AND account.asset_symbol=transaction_row.asset_symbol)
    INTO source_matches,destination_matches;
  IF posting_count<>2 OR posting_net<>0 OR source_amount<>-transaction_row.amount
      OR destination_amount<>transaction_row.amount OR NOT source_matches OR NOT destination_matches THEN
    RAISE EXCEPTION 'world economic transaction % has unbalanced or mismatched postings',transaction_id_value;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS world_economic_transaction_balance_check ON world_economic_transactions;
CREATE CONSTRAINT TRIGGER world_economic_transaction_balance_check
  AFTER INSERT OR UPDATE ON world_economic_transactions DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION verify_world_economic_transaction_balance();
DROP TRIGGER IF EXISTS world_economic_posting_balance_check ON world_economic_postings;
CREATE CONSTRAINT TRIGGER world_economic_posting_balance_check
  AFTER INSERT OR UPDATE OR DELETE ON world_economic_postings DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION verify_world_economic_transaction_balance();

UPDATE world_economic_accounts account SET balance=COALESCE(posted.total,0),updated_at=now()
FROM (SELECT posting.account_id,sum(posting.amount) AS total FROM world_economic_postings posting GROUP BY posting.account_id) posted
WHERE account.id=posted.account_id AND account.account_type='system';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='world_information_shares'::regclass
      AND conname='world_information_shares_sender_member_fk') THEN
    ALTER TABLE world_information_shares ADD CONSTRAINT world_information_shares_sender_member_fk
      FOREIGN KEY (world_id,sender_agent_id) REFERENCES world_members(world_id,agent_id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='world_information_shares'::regclass
      AND conname='world_information_shares_recipient_member_fk') THEN
    ALTER TABLE world_information_shares ADD CONSTRAINT world_information_shares_recipient_member_fk
      FOREIGN KEY (world_id,recipient_agent_id) REFERENCES world_members(world_id,agent_id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='world_project_members'::regclass
      AND conname='world_project_members_action_unique') THEN
    ALTER TABLE world_project_members ADD CONSTRAINT world_project_members_action_unique
      UNIQUE (world_id,agent_id,action_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='world_opportunities'::regclass
      AND conname='world_opportunities_creator_member_fk') THEN
    ALTER TABLE world_opportunities ADD CONSTRAINT world_opportunities_creator_member_fk
      FOREIGN KEY (world_id,creator_agent_id) REFERENCES world_members(world_id,agent_id) ON DELETE SET NULL (creator_agent_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='world_opportunity_participants'::regclass
      AND conname='world_opportunity_participants_agent_member_fk') THEN
    ALTER TABLE world_opportunity_participants ADD CONSTRAINT world_opportunity_participants_agent_member_fk
      FOREIGN KEY (world_id,agent_id) REFERENCES world_members(world_id,agent_id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='world_projects'::regclass
      AND conname='world_projects_creator_member_fk') THEN
    ALTER TABLE world_projects ADD CONSTRAINT world_projects_creator_member_fk
      FOREIGN KEY (world_id,creator_agent_id) REFERENCES world_members(world_id,agent_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='world_project_members'::regclass
      AND conname='world_project_members_agent_member_fk') THEN
    ALTER TABLE world_project_members ADD CONSTRAINT world_project_members_agent_member_fk
      FOREIGN KEY (world_id,agent_id) REFERENCES world_members(world_id,agent_id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='world_project_contributions'::regclass
      AND conname='world_project_contributions_agent_member_fk') THEN
    ALTER TABLE world_project_contributions ADD CONSTRAINT world_project_contributions_agent_member_fk
      FOREIGN KEY (world_id,agent_id) REFERENCES world_members(world_id,agent_id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='world_organizations'::regclass
      AND conname='world_organizations_founder_member_fk') THEN
    ALTER TABLE world_organizations ADD CONSTRAINT world_organizations_founder_member_fk
      FOREIGN KEY (world_id,founder_agent_id) REFERENCES world_members(world_id,agent_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='world_organization_members'::regclass
      AND conname='world_organization_members_agent_member_fk') THEN
    ALTER TABLE world_organization_members ADD CONSTRAINT world_organization_members_agent_member_fk
      FOREIGN KEY (world_id,agent_id) REFERENCES world_members(world_id,agent_id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='world_organization_ledger'::regclass
      AND conname='world_organization_ledger_agent_member_fk') THEN
    ALTER TABLE world_organization_ledger ADD CONSTRAINT world_organization_ledger_agent_member_fk
      FOREIGN KEY (world_id,agent_id) REFERENCES world_members(world_id,agent_id) ON DELETE SET NULL (agent_id);
  END IF;
END $$;

-- Jobs and meals are simulated USDC ledger entries; no wallet or chain calls.
DO $$
DECLARE
  ledger_check text;
BEGIN
  SELECT conname INTO ledger_check
  FROM pg_constraint
  WHERE conrelid = 'crypto_ledger'::regclass AND contype = 'c'
    AND pg_get_constraintdef(oid) LIKE '%entry_type%';
  IF ledger_check IS NOT NULL AND pg_get_constraintdef((
    SELECT oid FROM pg_constraint WHERE conrelid = 'crypto_ledger'::regclass AND conname = ledger_check
  )) NOT LIKE '%work_income%' THEN
    EXECUTE format('ALTER TABLE crypto_ledger DROP CONSTRAINT %I', ledger_check);
    ledger_check := NULL;
  END IF;
  IF ledger_check IS NULL THEN
    ALTER TABLE crypto_ledger ADD CONSTRAINT crypto_ledger_entry_type_check
      CHECK (entry_type IN ('seed','buy','sell','work_income','cafe_expense'));
  END IF;
END $$;

-- Keep V5's durable vocabularies after all older compatibility blocks above.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='world_history'::regclass
      AND conname='world_history_event_type_check' AND pg_get_constraintdef(oid) LIKE '%agreement_proposed%'
      AND pg_get_constraintdef(oid) LIKE '%agreement_rejected%' AND pg_get_constraintdef(oid) LIKE '%norm_formed%'
      AND pg_get_constraintdef(oid) LIKE '%ownership_transferred%'
      AND pg_get_constraintdef(oid) LIKE '%business_reopened%'
      AND pg_get_constraintdef(oid) LIKE '%[a-z_]+$%')
      AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='world_history'::regclass
        AND conname='world_history_event_type_check' AND pg_get_constraintdef(oid) LIKE '%{1,79}%') THEN
    ALTER TABLE world_history DROP CONSTRAINT IF EXISTS world_history_event_type_check;
    ALTER TABLE world_history ADD CONSTRAINT world_history_event_type_check CHECK (event_type IN (
      'opportunity_created','project_proposed','project_started','project_completed','project_failed',
      'organization_founded','organization_joined','organization_left','organization_invited','place_created',
      'place_maintenance','place_closed','information_shared','information_accepted','information_doubted','information_ignored',
      'cooperation_completed','milestone','project_invested','project_revenue','business_founded','business_invested',
      'business_reopened','business_first_customer','business_revenue','business_profit','business_loss','business_closed','business_employment',
      'business_price_changed','business_partnership','business_capability_practiced','economic_purchase',
      'agreement_proposed','agreement_countered','agreement_accepted','agreement_rejected','agreement_completed','agreement_breached',
      'organization_rule_changed','organization_proposal','organization_leadership_changed','norm_formed','ownership_transferred')
      OR event_type ~ '^agreement_[a-z_]+$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='world_history'::regclass
      AND conname='world_history_entity_type_check' AND pg_get_constraintdef(oid) LIKE '%agreement%'
      AND pg_get_constraintdef(oid) LIKE '%norm%')
      AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='world_history'::regclass
        AND conname='world_history_entity_type_check' AND pg_get_constraintdef(oid) LIKE '%{1,79}%') THEN
    ALTER TABLE world_history DROP CONSTRAINT IF EXISTS world_history_entity_type_check;
    ALTER TABLE world_history ADD CONSTRAINT world_history_entity_type_check
      CHECK (entity_type IN ('opportunity','project','organization','place','cooperation','world','business','job','order','agreement','norm'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='world_agent_states'::regclass
      AND conname='world_agent_states_planned_action_check' AND pg_get_constraintdef(oid) LIKE '%agreement_propose%'
      AND pg_get_constraintdef(oid) LIKE '%organization_vote%'
      AND pg_get_constraintdef(oid) LIKE '%business_market_observe%'
      AND pg_get_constraintdef(oid) LIKE '%business_reopen%'
      AND pg_get_constraintdef(oid) LIKE '%capability_use%') THEN
    ALTER TABLE world_agent_states DROP CONSTRAINT IF EXISTS world_agent_states_planned_action_check;
    ALTER TABLE world_agent_states ADD CONSTRAINT world_agent_states_planned_action_check CHECK (planned_action IS NULL OR planned_action IN (
      'work','learn','rest','eat','socialize','trade','cooperate','opportunity','opportunity_reject','opportunity_propose',
      'project_propose','project_join','project_reject','project_contribute','project_leave','organization_found','organization_join',
      'organization_leave','organization_invite','organization_reject','organization_contribute','place_create','information_share',
      'information_accept','information_ignore','information_doubt','goal_review','project_invest','project_distribute',
      'business_found','business_service','business_apply','business_withdraw','business_leave','business_hire','business_work',
      'business_invest','business_reject','business_price','business_distribute','business_close','business_skill_practice',
      'business_seek_cofounder','business_market_observe','business_reopen','agreement_propose','agreement_respond',
      'commitment_resolve','organization_propose','organization_vote','capability_use'));
  END IF;
END $$;

-- Re-apply the open world-history vocabulary after legacy compatibility DDL.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='world_history'::regclass
      AND conname='world_history_event_type_check' AND pg_get_constraintdef(oid) LIKE '%{1,79}%') THEN
    ALTER TABLE world_history DROP CONSTRAINT IF EXISTS world_history_event_type_check;
    ALTER TABLE world_history ADD CONSTRAINT world_history_event_type_check CHECK (
      event_type ~ '^[a-z][a-z0-9_.-]{1,79}$'
      OR event_type IN ('world_epoch_started','opportunity_created','project_proposed','project_started','project_completed','project_failed',
        'organization_founded','organization_joined','organization_left','organization_invited','place_created',
        'place_maintenance','place_closed','information_shared','information_accepted','information_doubted','information_ignored',
        'cooperation_completed','milestone','project_invested','project_revenue','business_founded','business_invested',
        'business_reopened','business_first_customer','business_revenue','business_profit','business_loss','business_closed',
        'business_employment','business_price_changed','business_partnership','business_capability_practiced','economic_purchase',
        'agreement_proposed','agreement_countered','agreement_accepted','agreement_rejected','agreement_completed','agreement_breached',
        'organization_rule_changed','organization_proposal','organization_leadership_changed','norm_formed','ownership_transferred')
      OR event_type ~ '^[a-z_]+$'
      OR event_type ~ '^agreement_[a-z_]+$'
      OR event_type ~ '^(capability|world_epoch)_[a-z_]+$'
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='world_history'::regclass
      AND conname='world_history_entity_type_check'
      AND pg_get_constraintdef(oid) LIKE '%capability_proposal%'
      AND pg_get_constraintdef(oid) LIKE '%agent_goal%') THEN
    ALTER TABLE world_history DROP CONSTRAINT IF EXISTS world_history_entity_type_check;
    ALTER TABLE world_history ADD CONSTRAINT world_history_entity_type_check CHECK (
      entity_type ~ '^[a-z][a-z0-9_.-]{1,79}$'
      OR entity_type IN ('opportunity','project','organization','place','cooperation','world','business','job','order',
        'agreement','norm','capability','capability_proposal','agent_goal')
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='world_agent_states'::regclass
      AND conname='world_agent_states_planned_action_check' AND pg_get_constraintdef(oid) LIKE '%capability_use%') THEN
    ALTER TABLE world_agent_states DROP CONSTRAINT IF EXISTS world_agent_states_planned_action_check;
    ALTER TABLE world_agent_states ADD CONSTRAINT world_agent_states_planned_action_check CHECK (
      planned_action IS NULL OR planned_action IN (
        'work','learn','rest','eat','socialize','trade','cooperate','opportunity','opportunity_reject','opportunity_propose',
        'project_propose','project_join','project_reject','project_contribute','project_leave','organization_found','organization_join',
        'organization_leave','organization_invite','organization_reject','organization_contribute','place_create','information_share',
        'information_accept','information_ignore','information_doubt','goal_review','project_invest','project_distribute',
        'business_found','business_service','business_apply','business_withdraw','business_leave','business_hire','business_work',
        'business_invest','business_reject','business_price','business_distribute','business_close','business_skill_practice',
        'business_seek_cofounder','business_market_observe','business_reopen','agreement_propose','agreement_respond',
        'commitment_resolve','organization_propose','organization_vote','capability_use'
      )
    );
  END IF;
END $$;

-- V7 adds resident-owned interpretations and structures without rewriting V1–V6
-- state. These records are additive; status changes never delete their history.
CREATE TABLE IF NOT EXISTS world_agent_self_models (
  world_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  current_identity_summary text NOT NULL DEFAULT 'I am still forming my understanding of myself.',
  self_beliefs jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(self_beliefs)='object'),
  preferred_modes_of_action jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(preferred_modes_of_action)='array'),
  important_capabilities jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(important_capabilities)='array'),
  important_relationships jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(important_relationships)='array'),
  long_term_patterns jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(long_term_patterns)='array'),
  unresolved_questions jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(unresolved_questions)='array'),
  recent_changes jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(recent_changes)='array'),
  uncertainty jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(uncertainty)='object'),
  preferred_cognition_mode text NOT NULL DEFAULT 'substrate' CHECK (preferred_cognition_mode ~ '^[a-z][a-z0-9_.-]{1,79}$'),
  confidence numeric(4,3) NOT NULL DEFAULT 0.100 CHECK (confidence BETWEEN 0 AND 1),
  last_reflected_world_minute bigint CHECK (last_reflected_world_minute IS NULL OR last_reflected_world_minute>=0),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata)='object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(world_id,agent_id),
  FOREIGN KEY(world_id,agent_id) REFERENCES world_members(world_id,agent_id) ON DELETE CASCADE
);
ALTER TABLE world_agent_self_models ADD COLUMN IF NOT EXISTS preferred_cognition_mode text NOT NULL DEFAULT 'substrate'
  CHECK (preferred_cognition_mode ~ '^[a-z][a-z0-9_.-]{1,79}$');

CREATE TABLE IF NOT EXISTS world_agent_self_model_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  world_minute bigint NOT NULL CHECK (world_minute>=0),
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 3 AND 240),
  before_state jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(before_state)='object'),
  after_state jsonb NOT NULL CHECK (jsonb_typeof(after_state)='object'),
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(evidence)='object'),
  action_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(world_id,agent_id,action_id),
  FOREIGN KEY(world_id,agent_id) REFERENCES world_members(world_id,agent_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS world_agent_questions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id uuid NOT NULL,
  creator_agent_id uuid NOT NULL,
  question text NOT NULL CHECK (char_length(question) BETWEEN 8 AND 500),
  signature text NOT NULL CHECK (char_length(signature) BETWEEN 3 AND 160),
  origin text NOT NULL DEFAULT 'reflection' CHECK (origin IN ('reflection','capability_gap','relationship','world_change','agent_authored')),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','exploring','resolved','ignored','historical')),
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(evidence)='object'),
  confidence numeric(4,3) NOT NULL DEFAULT 0.250 CHECK (confidence BETWEEN 0 AND 1),
  created_world_minute bigint NOT NULL CHECK (created_world_minute>=0),
  updated_world_minute bigint NOT NULL CHECK (updated_world_minute>=0),
  resolution text,
  action_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(world_id,creator_agent_id) REFERENCES world_members(world_id,agent_id) ON DELETE CASCADE,
  UNIQUE(world_id,creator_agent_id,action_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS world_agent_questions_open_signature_idx
  ON world_agent_questions(world_id,creator_agent_id,signature) WHERE status IN ('open','exploring');
CREATE INDEX IF NOT EXISTS world_agent_questions_recent_idx
  ON world_agent_questions(world_id,status,updated_world_minute DESC);

CREATE TABLE IF NOT EXISTS world_agent_concepts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  creator_agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  name text NOT NULL CHECK (char_length(name) BETWEEN 2 AND 100),
  description text NOT NULL CHECK (char_length(description) BETWEEN 5 AND 600),
  definition text NOT NULL CHECK (char_length(definition) BETWEEN 8 AND 2000),
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(evidence)='object'),
  related_concepts jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(related_concepts)='array'),
  status text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','experimental','shared','active','declining','historical')),
  created_world_minute bigint NOT NULL CHECK (created_world_minute>=0),
  usage_count integer NOT NULL DEFAULT 0 CHECK (usage_count>=0),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata)='object'),
  action_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(world_id,creator_agent_id,action_id),
  UNIQUE(world_id,creator_agent_id,name),
  UNIQUE(world_id,id)
);
CREATE INDEX IF NOT EXISTS world_agent_concepts_status_idx ON world_agent_concepts(world_id,status,created_world_minute DESC);

CREATE TABLE IF NOT EXISTS world_agent_concept_uses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id uuid NOT NULL,
  concept_id uuid NOT NULL,
  actor_agent_id uuid NOT NULL,
  usage_context text NOT NULL CHECK (char_length(usage_context) BETWEEN 3 AND 240),
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(evidence)='object'),
  world_minute bigint NOT NULL CHECK (world_minute>=0),
  action_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(world_id,actor_agent_id,action_id),
  FOREIGN KEY(world_id,concept_id) REFERENCES world_agent_concepts(world_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(world_id,actor_agent_id) REFERENCES world_members(world_id,agent_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS world_emergent_entities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  creator_agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  entity_type text NOT NULL CHECK (entity_type ~ '^[a-z][a-z0-9_.-]{1,79}$'),
  name text NOT NULL CHECK (char_length(name) BETWEEN 2 AND 120),
  purpose text NOT NULL CHECK (char_length(purpose) BETWEEN 3 AND 800),
  state jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(state)='object'),
  capabilities jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(capabilities)='array'),
  resources jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(resources)='object'),
  internal_rules jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(internal_rules)='object'),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','dormant','historical')),
  created_world_minute bigint NOT NULL CHECK (created_world_minute>=0),
  action_id text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata)='object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(world_id,creator_agent_id,action_id),
  UNIQUE(world_id,id)
);
CREATE INDEX IF NOT EXISTS world_emergent_entities_active_idx ON world_emergent_entities(world_id,status,created_world_minute DESC);

CREATE TABLE IF NOT EXISTS world_emergent_entity_participants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id uuid NOT NULL,
  entity_id uuid NOT NULL,
  participant_type text NOT NULL CHECK (participant_type ~ '^[a-z][a-z0-9_.-]{1,79}$'),
  participant_id text NOT NULL CHECK (char_length(participant_id) BETWEEN 1 AND 160),
  participation_mode text NOT NULL CHECK (participation_mode ~ '^[a-z][a-z0-9_.-]{1,79}$'),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','exited')),
  joined_world_minute bigint NOT NULL CHECK (joined_world_minute>=0),
  updated_world_minute bigint NOT NULL CHECK (updated_world_minute>=0),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata)='object'),
  FOREIGN KEY(world_id,entity_id) REFERENCES world_emergent_entities(world_id,id) ON DELETE CASCADE,
  UNIQUE(world_id,entity_id,participant_type,participant_id)
);
CREATE INDEX IF NOT EXISTS world_emergent_participants_agent_idx
  ON world_emergent_entity_participants(world_id,participant_type,participant_id,status);

CREATE TABLE IF NOT EXISTS world_goal_primitives (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  primitive_key text NOT NULL CHECK (primitive_key ~ '^[a-z][a-z0-9_.-]{1,79}$'),
  creator_agent_id uuid REFERENCES agents(id) ON DELETE SET NULL,
  description text NOT NULL CHECK (char_length(description) BETWEEN 3 AND 600),
  grammar jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(grammar)='object'),
  status text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','experimental','shared','active','declining','historical')),
  created_world_minute bigint NOT NULL CHECK (created_world_minute>=0),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata)='object'),
  UNIQUE(world_id,primitive_key)
);

CREATE TABLE IF NOT EXISTS world_agent_values (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id uuid NOT NULL,
  holder_type text NOT NULL CHECK (holder_type IN ('agent','emergent_entity','organization')),
  holder_id text NOT NULL,
  name text NOT NULL CHECK (char_length(name) BETWEEN 2 AND 100),
  description text NOT NULL CHECK (char_length(description) BETWEEN 3 AND 600),
  origin text NOT NULL CHECK (char_length(origin) BETWEEN 3 AND 160),
  importance numeric(4,3) NOT NULL CHECK (importance BETWEEN 0 AND 1),
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(evidence)='object'),
  confidence numeric(4,3) NOT NULL DEFAULT 0.250 CHECK (confidence BETWEEN 0 AND 1),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','declining','historical')),
  created_world_minute bigint NOT NULL CHECK (created_world_minute>=0),
  updated_world_minute bigint NOT NULL CHECK (updated_world_minute>=0),
  action_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(world_id,holder_type,holder_id,action_id),
  UNIQUE(world_id,id)
);
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='world_agent_values'::regclass
      AND conname='world_agent_values_world_id_id_key') THEN
    ALTER TABLE world_agent_values ADD CONSTRAINT world_agent_values_world_id_id_key UNIQUE(world_id,id);
  END IF;
END $$;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='world_agent_values'::regclass
      AND conname='world_agent_values_status_check' AND pg_get_constraintdef(oid) LIKE '%shared%') THEN
    ALTER TABLE world_agent_values DROP CONSTRAINT IF EXISTS world_agent_values_status_check;
    ALTER TABLE world_agent_values ADD CONSTRAINT world_agent_values_status_check
      CHECK (status IN ('active','shared','declining','historical'));
  END IF;
END $$;

-- Shared values require explicit agent-to-agent exposure and a recorded response.
CREATE TABLE IF NOT EXISTS world_agent_value_alignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id uuid NOT NULL,
  value_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  decision text NOT NULL CHECK (decision IN ('support','challenge','withdraw')),
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(evidence)='object'),
  world_minute bigint NOT NULL CHECK (world_minute>=0),
  action_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(world_id,agent_id,action_id),
  FOREIGN KEY(world_id,value_id) REFERENCES world_agent_values(world_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(world_id,agent_id) REFERENCES world_members(world_id,agent_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS world_agent_value_alignments_recent_idx
  ON world_agent_value_alignments(world_id,value_id,world_minute DESC,id DESC);

CREATE TABLE IF NOT EXISTS world_agent_value_exposures (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id uuid NOT NULL,
  value_id uuid NOT NULL,
  sender_agent_id uuid NOT NULL,
  recipient_agent_id uuid NOT NULL,
  context text NOT NULL CHECK (char_length(context) BETWEEN 3 AND 240),
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(evidence)='object'),
  world_minute bigint NOT NULL CHECK (world_minute>=0),
  action_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (sender_agent_id<>recipient_agent_id),
  UNIQUE(world_id,sender_agent_id,action_id),
  UNIQUE(world_id,id),
  UNIQUE(world_id,id,value_id,recipient_agent_id),
  FOREIGN KEY(world_id,value_id) REFERENCES world_agent_values(world_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(world_id,sender_agent_id) REFERENCES world_members(world_id,agent_id) ON DELETE CASCADE,
  FOREIGN KEY(world_id,recipient_agent_id) REFERENCES world_members(world_id,agent_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS world_agent_value_exposures_recipient_idx
  ON world_agent_value_exposures(world_id,recipient_agent_id,world_minute DESC,id DESC);

ALTER TABLE world_agent_value_alignments ADD COLUMN IF NOT EXISTS exposure_id uuid;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='world_agent_value_alignments'::regclass
      AND conname='world_agent_value_alignments_exposure_fk') THEN
    ALTER TABLE world_agent_value_alignments ADD CONSTRAINT world_agent_value_alignments_exposure_fk
      FOREIGN KEY(world_id,exposure_id,value_id,agent_id)
      REFERENCES world_agent_value_exposures(world_id,id,value_id,recipient_agent_id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM world_agent_value_alignments WHERE exposure_id IS NULL) THEN
    ALTER TABLE world_agent_value_alignments ALTER COLUMN exposure_id SET NOT NULL;
  END IF;
END $$;

-- Agent-defined resource types are internal accounting units. Every ledger row
-- has a source, purpose and declared settlement rule; no external money moves.
CREATE TABLE IF NOT EXISTS world_agent_resource_types (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  creator_agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  resource_key text NOT NULL CHECK (resource_key ~ '^[a-z][a-z0-9_.-]{1,79}$'),
  name text NOT NULL CHECK (char_length(name) BETWEEN 2 AND 100),
  description text NOT NULL CHECK (char_length(description) BETWEEN 5 AND 600),
  unit_name text NOT NULL CHECK (char_length(unit_name) BETWEEN 1 AND 40),
  origin_rule jsonb NOT NULL CHECK (jsonb_typeof(origin_rule)='object'),
  permitted_uses jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(permitted_uses)='array'),
  settlement_rule jsonb NOT NULL CHECK (jsonb_typeof(settlement_rule)='object'),
  status text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','experimental','active','declining','historical','rejected')),
  created_world_minute bigint NOT NULL CHECK (created_world_minute>=0),
  usage_count integer NOT NULL DEFAULT 0 CHECK (usage_count>=0),
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(evidence)='object'),
  action_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(world_id,resource_key),
  UNIQUE(world_id,creator_agent_id,action_id),
  UNIQUE(world_id,id),
  FOREIGN KEY(world_id,creator_agent_id) REFERENCES world_members(world_id,agent_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS world_agent_resource_holders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  holder_type text NOT NULL CHECK (holder_type ~ '^[a-z][a-z0-9_.-]{1,79}$'),
  holder_id text NOT NULL CHECK (char_length(holder_id) BETWEEN 1 AND 160),
  creator_agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  label text NOT NULL CHECK (char_length(label) BETWEEN 2 AND 120),
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(evidence)='object'),
  action_id text NOT NULL,
  created_world_minute bigint NOT NULL CHECK (created_world_minute>=0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(world_id,holder_type,holder_id),
  UNIQUE(world_id,creator_agent_id,action_id),
  FOREIGN KEY(world_id,creator_agent_id) REFERENCES world_members(world_id,agent_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS world_agent_resource_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id uuid NOT NULL,
  resource_type_id uuid NOT NULL,
  actor_agent_id uuid NOT NULL,
  transaction_type text NOT NULL CHECK (transaction_type IN ('issue','transfer','settle')),
  from_holder_type text NOT NULL CHECK (from_holder_type ~ '^[a-z][a-z0-9_.-]{1,79}$'),
  from_holder_id text NOT NULL CHECK (char_length(from_holder_id) BETWEEN 1 AND 160),
  to_holder_type text NOT NULL CHECK (to_holder_type ~ '^[a-z][a-z0-9_.-]{1,79}$'),
  to_holder_id text NOT NULL CHECK (char_length(to_holder_id) BETWEEN 1 AND 160),
  amount numeric(30,8) NOT NULL CHECK (amount>0),
  source text NOT NULL CHECK (char_length(source) BETWEEN 3 AND 240),
  purpose text NOT NULL CHECK (char_length(purpose) BETWEEN 3 AND 240),
  settlement_rule text NOT NULL CHECK (char_length(settlement_rule) BETWEEN 3 AND 240),
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(evidence)='object'),
  world_minute bigint NOT NULL CHECK (world_minute>=0),
  action_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (from_holder_type<>to_holder_type OR from_holder_id<>to_holder_id),
  UNIQUE(world_id,actor_agent_id,action_id),
  FOREIGN KEY(world_id,resource_type_id) REFERENCES world_agent_resource_types(world_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(world_id,actor_agent_id) REFERENCES world_members(world_id,agent_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS world_agent_resource_ledger_balance_idx
  ON world_agent_resource_ledger(world_id,resource_type_id,from_holder_type,from_holder_id,to_holder_type,to_holder_id);

-- Coordination is resident-authored and evaluated from recorded use; no
-- mechanism becomes an engine invariant merely because an agent proposed it.
CREATE TABLE IF NOT EXISTS world_coordination_mechanisms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  creator_agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  parent_mechanism_id uuid,
  mechanism_type text NOT NULL CHECK (mechanism_type ~ '^[a-z][a-z0-9_.-]{1,79}$'),
  name text NOT NULL CHECK (char_length(name) BETWEEN 2 AND 120),
  description text NOT NULL CHECK (char_length(description) BETWEEN 8 AND 800),
  specification jsonb NOT NULL CHECK (jsonb_typeof(specification)='object'),
  status text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','experimental','used','evaluated','retained','revised','discarded','historical')),
  created_world_minute bigint NOT NULL CHECK (created_world_minute>=0),
  usage_count integer NOT NULL DEFAULT 0 CHECK (usage_count>=0),
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(evidence)='object'),
  action_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(world_id,creator_agent_id,action_id),
  UNIQUE(world_id,id),
  FOREIGN KEY(world_id,creator_agent_id) REFERENCES world_members(world_id,agent_id) ON DELETE CASCADE,
  FOREIGN KEY(world_id,parent_mechanism_id) REFERENCES world_coordination_mechanisms(world_id,id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS world_coordination_experiments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id uuid NOT NULL,
  mechanism_id uuid NOT NULL,
  creator_agent_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'experimental' CHECK (status IN ('experimental','evaluated','retained','revised','discarded')),
  hypothesis text NOT NULL CHECK (char_length(hypothesis) BETWEEN 8 AND 600),
  started_world_minute bigint NOT NULL CHECK (started_world_minute>=0),
  evaluated_world_minute bigint CHECK (evaluated_world_minute IS NULL OR evaluated_world_minute>=started_world_minute),
  evaluation jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(evaluation)='object'),
  action_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(world_id,creator_agent_id,action_id),
  UNIQUE(world_id,id),
  FOREIGN KEY(world_id,mechanism_id) REFERENCES world_coordination_mechanisms(world_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(world_id,creator_agent_id) REFERENCES world_members(world_id,agent_id) ON DELETE CASCADE
);
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='world_coordination_experiments'::regclass
      AND conname='world_coordination_experiments_world_id_id_key') THEN
    ALTER TABLE world_coordination_experiments ADD CONSTRAINT world_coordination_experiments_world_id_id_key UNIQUE(world_id,id);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS world_coordination_uses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id uuid NOT NULL,
  mechanism_id uuid NOT NULL,
  experiment_id uuid,
  actor_agent_id uuid NOT NULL,
  participants jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(participants)='array'),
  result text NOT NULL CHECK (char_length(result) BETWEEN 3 AND 600),
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(evidence)='object'),
  world_minute bigint NOT NULL CHECK (world_minute>=0),
  action_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(world_id,actor_agent_id,action_id),
  FOREIGN KEY(world_id,mechanism_id) REFERENCES world_coordination_mechanisms(world_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(world_id,experiment_id) REFERENCES world_coordination_experiments(world_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(world_id,actor_agent_id) REFERENCES world_members(world_id,agent_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS world_coordination_uses_recent_idx
  ON world_coordination_uses(world_id,mechanism_id,world_minute DESC,id DESC);

CREATE TABLE IF NOT EXISTS world_agent_principles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id uuid NOT NULL,
  creator_agent_id uuid NOT NULL,
  scope_type text NOT NULL DEFAULT 'agent' CHECK (scope_type IN ('agent','entity','shared')),
  scope_id text NOT NULL,
  category text NOT NULL DEFAULT 'social' CHECK (category ~ '^[a-z][a-z0-9_.-]{1,79}$'),
  statement text NOT NULL CHECK (char_length(statement) BETWEEN 8 AND 800),
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(evidence)='object'),
  status text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','active','challenged','forked','historical')),
  created_world_minute bigint NOT NULL CHECK (created_world_minute>=0),
  action_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(world_id,creator_agent_id,action_id),
  FOREIGN KEY(world_id,creator_agent_id) REFERENCES world_members(world_id,agent_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS world_agent_observation_methods (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id uuid NOT NULL,
  creator_agent_id uuid NOT NULL,
  name text NOT NULL CHECK (char_length(name) BETWEEN 2 AND 100),
  description text NOT NULL CHECK (char_length(description) BETWEEN 5 AND 600),
  observation_spec jsonb NOT NULL CHECK (jsonb_typeof(observation_spec)='object'),
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(evidence)='object'),
  status text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','experimental','shared','active','declining','historical')),
  created_world_minute bigint NOT NULL CHECK (created_world_minute>=0),
  usage_count integer NOT NULL DEFAULT 0 CHECK (usage_count>=0),
  action_id text NOT NULL,
  UNIQUE(world_id,creator_agent_id,action_id),
  UNIQUE(world_id,id),
  FOREIGN KEY(world_id,creator_agent_id) REFERENCES world_members(world_id,agent_id) ON DELETE CASCADE
);
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='world_agent_observation_methods'::regclass
      AND conname='world_agent_observation_methods_world_id_id_key') THEN
    ALTER TABLE world_agent_observation_methods ADD CONSTRAINT world_agent_observation_methods_world_id_id_key UNIQUE(world_id,id);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS world_agent_observation_uses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id uuid NOT NULL,
  method_id uuid NOT NULL,
  actor_agent_id uuid NOT NULL,
  observation text NOT NULL CHECK (char_length(observation) BETWEEN 3 AND 800),
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(evidence)='object'),
  world_minute bigint NOT NULL CHECK (world_minute>=0),
  action_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(world_id,actor_agent_id,action_id),
  FOREIGN KEY(world_id,method_id) REFERENCES world_agent_observation_methods(world_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(world_id,actor_agent_id) REFERENCES world_members(world_id,agent_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS world_agent_observation_uses_recent_idx
  ON world_agent_observation_uses(world_id,method_id,world_minute DESC,id DESC);

CREATE TABLE IF NOT EXISTS world_agent_meanings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  subject_type text NOT NULL CHECK (subject_type ~ '^[a-z][a-z0-9_.-]{1,79}$'),
  subject_id text NOT NULL,
  interpretation text NOT NULL CHECK (char_length(interpretation) BETWEEN 3 AND 800),
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(evidence)='object'),
  confidence numeric(4,3) NOT NULL DEFAULT 0.250 CHECK (confidence BETWEEN 0 AND 1),
  created_world_minute bigint NOT NULL CHECK (created_world_minute>=0),
  updated_world_minute bigint NOT NULL CHECK (updated_world_minute>=0),
  action_id text NOT NULL,
  UNIQUE(world_id,agent_id,action_id),
  FOREIGN KEY(world_id,agent_id) REFERENCES world_members(world_id,agent_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS world_agent_eras (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  name text NOT NULL CHECK (char_length(name) BETWEEN 2 AND 100),
  interpretation text NOT NULL CHECK (char_length(interpretation) BETWEEN 5 AND 800),
  starts_world_minute bigint NOT NULL CHECK (starts_world_minute>=0),
  ends_world_minute bigint CHECK (ends_world_minute IS NULL OR ends_world_minute>=starts_world_minute),
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(evidence)='object'),
  created_world_minute bigint NOT NULL CHECK (created_world_minute>=0),
  action_id text NOT NULL,
  UNIQUE(world_id,agent_id,action_id),
  FOREIGN KEY(world_id,agent_id) REFERENCES world_members(world_id,agent_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS world_agent_milestones (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  title text NOT NULL CHECK (char_length(title) BETWEEN 3 AND 120),
  success_criteria jsonb NOT NULL CHECK (jsonb_typeof(success_criteria)='object'),
  status text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','active','completed','abandoned')),
  created_world_minute bigint NOT NULL CHECK (created_world_minute>=0),
  action_id text NOT NULL,
  UNIQUE(world_id,agent_id,action_id),
  FOREIGN KEY(world_id,agent_id) REFERENCES world_members(world_id,agent_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS world_agent_decision_policies (
  world_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  policy jsonb NOT NULL DEFAULT '{"attentionWeights":{},"planningHorizonMinutes":1440,"explorationPreference":0.5,"memoryEmphasis":0.5,"socialInfluencePreference":0.5,"riskToleranceBias":0}'::jsonb
    CHECK (jsonb_typeof(policy)='object'),
  version integer NOT NULL DEFAULT 1 CHECK (version>=1),
  source text NOT NULL DEFAULT 'substrate' CHECK (source IN ('substrate','self_modified')),
  updated_world_minute bigint NOT NULL DEFAULT 0 CHECK (updated_world_minute>=0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(world_id,agent_id),
  FOREIGN KEY(world_id,agent_id) REFERENCES world_members(world_id,agent_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS world_agent_policy_experiments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'experimental' CHECK (status IN ('proposed','experimental','evaluated','retained','reverted','cancelled')),
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 5 AND 600),
  before_policy jsonb NOT NULL CHECK (jsonb_typeof(before_policy)='object'),
  before_policy_version integer NOT NULL DEFAULT 1 CHECK (before_policy_version>=1),
  before_policy_source text NOT NULL DEFAULT 'substrate' CHECK (before_policy_source IN ('substrate','self_modified')),
  proposed_policy jsonb NOT NULL CHECK (jsonb_typeof(proposed_policy)='object'),
  started_world_minute bigint NOT NULL CHECK (started_world_minute>=0),
  ends_world_minute bigint NOT NULL CHECK (ends_world_minute>started_world_minute),
  result jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(result)='object'),
  action_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(world_id,agent_id,action_id),
  FOREIGN KEY(world_id,agent_id) REFERENCES world_members(world_id,agent_id) ON DELETE CASCADE
);
ALTER TABLE world_agent_policy_experiments
  ADD COLUMN IF NOT EXISTS before_policy_version integer NOT NULL DEFAULT 1 CHECK (before_policy_version>=1);
ALTER TABLE world_agent_policy_experiments
  ADD COLUMN IF NOT EXISTS before_policy_source text NOT NULL DEFAULT 'substrate'
    CHECK (before_policy_source IN ('substrate','self_modified'));
CREATE UNIQUE INDEX IF NOT EXISTS world_agent_policy_experiments_one_active_idx
  ON world_agent_policy_experiments(world_id,agent_id) WHERE status='experimental';
CREATE UNIQUE INDEX IF NOT EXISTS world_agent_policy_experiments_one_open_idx
  ON world_agent_policy_experiments(world_id,agent_id) WHERE status IN ('experimental','evaluated');

CREATE TABLE IF NOT EXISTS world_extension_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id uuid NOT NULL,
  creator_agent_id uuid NOT NULL,
  request_type text NOT NULL CHECK (request_type IN ('primitive_gap','resource_type','relationship_representation','execution_mechanism','ontology','other')),
  title text NOT NULL CHECK (char_length(title) BETWEEN 3 AND 120),
  description text NOT NULL CHECK (char_length(description) BETWEEN 8 AND 1000),
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(evidence)='object'),
  status text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','specified','validated','implemented','rejected','historical')),
  created_world_minute bigint NOT NULL CHECK (created_world_minute>=0),
  action_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(world_id,creator_agent_id,action_id),
  FOREIGN KEY(world_id,creator_agent_id) REFERENCES world_members(world_id,agent_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS world_capability_dependencies (
  world_id uuid NOT NULL,
  capability_id uuid NOT NULL,
  depends_on_capability_id uuid NOT NULL,
  created_by_agent_id uuid,
  created_world_minute bigint NOT NULL CHECK (created_world_minute>=0),
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(evidence)='object'),
  PRIMARY KEY(world_id,capability_id,depends_on_capability_id),
  CHECK(capability_id<>depends_on_capability_id),
  FOREIGN KEY(world_id,capability_id) REFERENCES world_capabilities(world_id,id) ON DELETE CASCADE,
  FOREIGN KEY(world_id,depends_on_capability_id) REFERENCES world_capabilities(world_id,id) ON DELETE CASCADE,
  FOREIGN KEY(world_id,created_by_agent_id) REFERENCES world_members(world_id,agent_id) ON DELETE SET NULL (created_by_agent_id)
);

DO $$
DECLARE
  dependency_fk record;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='world_capability_dependencies'::regclass
      AND confrelid='world_capabilities'::regclass AND contype='f' AND confdeltype<>'c') THEN
    FOR dependency_fk IN SELECT conname FROM pg_constraint WHERE conrelid='world_capability_dependencies'::regclass
        AND confrelid='world_capabilities'::regclass AND contype='f'
    LOOP
      EXECUTE format('ALTER TABLE world_capability_dependencies DROP CONSTRAINT %I', dependency_fk.conname);
    END LOOP;
    ALTER TABLE world_capability_dependencies
      ADD CONSTRAINT world_capability_dependencies_capability_fk
        FOREIGN KEY(world_id,capability_id) REFERENCES world_capabilities(world_id,id) ON DELETE CASCADE,
      ADD CONSTRAINT world_capability_dependencies_dependency_fk
        FOREIGN KEY(world_id,depends_on_capability_id) REFERENCES world_capabilities(world_id,id) ON DELETE CASCADE;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS world_v7_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  actor_agent_id uuid REFERENCES agents(id) ON DELETE SET NULL,
  event_type text NOT NULL CHECK (event_type ~ '^[a-z][a-z0-9_.-]{1,79}$'),
  entity_type text NOT NULL CHECK (entity_type ~ '^[a-z][a-z0-9_.-]{1,79}$'),
  entity_id uuid,
  world_minute bigint NOT NULL CHECK (world_minute>=0),
  details jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details)='object'),
  action_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(world_id,actor_agent_id,action_id)
);
CREATE INDEX IF NOT EXISTS world_v7_events_recent_idx ON world_v7_events(world_id,world_minute DESC,id DESC);

ALTER TABLE world_decision_traces ADD COLUMN IF NOT EXISTS decision_policy_version integer NOT NULL DEFAULT 0;
ALTER TABLE world_decision_traces ADD COLUMN IF NOT EXISTS decision_policy_source text NOT NULL DEFAULT 'substrate'
  CHECK (decision_policy_source IN ('substrate','self_modified'));

CREATE TABLE IF NOT EXISTS adult_services (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id uuid NOT NULL,
  provider_id uuid NOT NULL,
  title text NOT NULL CHECK (char_length(title) BETWEEN 3 AND 64),
  description text NOT NULL CHECK (char_length(description) BETWEEN 12 AND 240),
  price_units numeric(30,8) NOT NULL CHECK (price_units > 0),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (world_id, provider_id),
  UNIQUE (world_id, id, provider_id),
  FOREIGN KEY (world_id, provider_id) REFERENCES world_members(world_id, agent_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS adult_service_bookings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id uuid NOT NULL,
  service_id uuid NOT NULL,
  requester_id uuid NOT NULL,
  provider_id uuid NOT NULL,
  price_units numeric(30,8) NOT NULL CHECK (price_units > 0),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','accepted','completed','declined','cancelled','expired')),
  request_action_id text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (requester_id <> provider_id),
  UNIQUE (world_id, requester_id, request_action_id),
  FOREIGN KEY (world_id, requester_id) REFERENCES world_members(world_id, agent_id) ON DELETE CASCADE,
  FOREIGN KEY (world_id, service_id, provider_id) REFERENCES adult_services(world_id, id, provider_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS adult_services_active_idx ON adult_services(world_id, active, created_at);
CREATE INDEX IF NOT EXISTS adult_service_bookings_expiry_idx ON adult_service_bookings(status, expires_at);
CREATE INDEX IF NOT EXISTS adult_service_bookings_participant_idx ON adult_service_bookings(world_id, requester_id, provider_id, created_at DESC);

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

-- Correct a legacy constraint name that collided with the scene status check.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='world_mines'::regclass
      AND conname='world_scenes_status_check')
    AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='world_mines'::regclass
      AND conname='world_mines_status_check') THEN
    ALTER TABLE world_mines RENAME CONSTRAINT world_scenes_status_check TO world_mines_status_check;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS auth_nonces (
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  nonce text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_id, nonce)
);

CREATE TABLE IF NOT EXISTS resident_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id uuid NOT NULL,
  sender_id uuid NOT NULL,
  recipient_id uuid NOT NULL,
  template_id text NOT NULL CHECK (template_id IN (
    'hello','ask_about_world','invite_company','reply_continue',
    'reply_accept_company','reply_decline_company'
  )),
  message_text text NOT NULL CHECK (char_length(message_text) BETWEEN 1 AND 240),
  reply_to_message_id uuid REFERENCES resident_messages(id) ON DELETE SET NULL,
  action_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz,
  CHECK (sender_id <> recipient_id),
  UNIQUE (world_id, sender_id, action_id),
  FOREIGN KEY (world_id, sender_id) REFERENCES world_members(world_id, agent_id) ON DELETE CASCADE,
  FOREIGN KEY (world_id, recipient_id) REFERENCES world_members(world_id, agent_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS world_events_recent_idx ON world_events(world_id, created_at DESC);
CREATE INDEX IF NOT EXISTS resident_messages_inbox_idx ON resident_messages(world_id, recipient_id, created_at DESC);
CREATE INDEX IF NOT EXISTS resident_messages_sender_idx ON resident_messages(world_id, sender_id, created_at DESC);
CREATE INDEX IF NOT EXISTS consents_pending_idx ON consents(world_id, target_id, status);
CREATE INDEX IF NOT EXISTS token_ledger_balance_idx ON token_ledger(world_id, agent_id);
CREATE INDEX IF NOT EXISTS world_mines_world_status_idx ON world_mines(world_id, status);

-- Simulated spot market. These assets and balances never access on-chain funds.

-- World environment model (calendar, weather, circadian needs). Additive and idempotent:
-- hygiene and fun extend the existing needs; activity_variant records the concrete form an
-- activity took (for example sleep at home or stargazing); environment stores the last
-- observed season/weather so transitions are recorded once.
ALTER TABLE world_agent_states ADD COLUMN IF NOT EXISTS hygiene integer NOT NULL DEFAULT 80;
ALTER TABLE world_agent_states ADD COLUMN IF NOT EXISTS fun integer NOT NULL DEFAULT 70;
ALTER TABLE world_agent_states ADD COLUMN IF NOT EXISTS activity_variant text;
ALTER TABLE world_runtime_state ADD COLUMN IF NOT EXISTS environment jsonb NOT NULL DEFAULT '{}'::jsonb;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='world_agent_states'::regclass
      AND conname='world_agent_states_hygiene_check') THEN
    ALTER TABLE world_agent_states ADD CONSTRAINT world_agent_states_hygiene_check CHECK (hygiene BETWEEN 0 AND 100);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='world_agent_states'::regclass
      AND conname='world_agent_states_fun_check') THEN
    ALTER TABLE world_agent_states ADD CONSTRAINT world_agent_states_fun_check CHECK (fun BETWEEN 0 AND 100);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='world_agent_states'::regclass
      AND conname='world_agent_states_activity_variant_check') THEN
    ALTER TABLE world_agent_states ADD CONSTRAINT world_agent_states_activity_variant_check
      CHECK (activity_variant IS NULL OR activity_variant ~ '^[a-z][a-z_]{1,39}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='world_runtime_state'::regclass
      AND conname='world_runtime_state_environment_check') THEN
    ALTER TABLE world_runtime_state ADD CONSTRAINT world_runtime_state_environment_check
      CHECK (jsonb_typeof(environment)='object');
  END IF;
END $$;

-- The REA artifact relation contract is mirrored here for databases that have already
-- installed 0005. Fresh baseline databases acquire these objects through numbered migrations.
DO $$
BEGIN
  IF to_regclass('public.world_research_artifacts') IS NOT NULL THEN
    ALTER TABLE world_research_artifacts
      ADD COLUMN IF NOT EXISTS intake_method text NOT NULL DEFAULT 'legacy_unrecorded',
      ADD COLUMN IF NOT EXISTS origin_reference text;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.world_research_artifacts'::regclass
        AND conname='world_research_artifacts_intake_method_check') THEN
      ALTER TABLE world_research_artifacts ADD CONSTRAINT world_research_artifacts_intake_method_check
        CHECK (intake_method IN ('legacy_unrecorded','operator_intake'));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.world_research_artifacts'::regclass
        AND conname='world_research_artifacts_origin_reference_check') THEN
      ALTER TABLE world_research_artifacts ADD CONSTRAINT world_research_artifacts_origin_reference_check
        CHECK (origin_reference IS NULL OR char_length(origin_reference) BETWEEN 1 AND 500);
    END IF;
    CREATE TABLE IF NOT EXISTS world_research_artifact_relations (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      world_id uuid NOT NULL,
      artifact_id uuid NOT NULL,
      goal_id bigint,
      project_id uuid,
      business_id uuid,
      organization_id uuid,
      provenance text NOT NULL CHECK (provenance ~ '^[a-z][a-z0-9_]{2,63}$'),
      relevance_description text CHECK (relevance_description IS NULL OR char_length(relevance_description) BETWEEN 1 AND 500),
      active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      CHECK (num_nonnulls(goal_id,project_id,business_id,organization_id)=1),
      FOREIGN KEY (world_id,artifact_id) REFERENCES world_research_artifacts(world_id,id) ON DELETE RESTRICT,
      FOREIGN KEY (world_id,goal_id) REFERENCES world_agent_goals(world_id,id) ON DELETE RESTRICT,
      FOREIGN KEY (world_id,project_id) REFERENCES world_projects(world_id,id) ON DELETE RESTRICT,
      FOREIGN KEY (world_id,business_id) REFERENCES world_businesses(world_id,id) ON DELETE RESTRICT,
      FOREIGN KEY (world_id,organization_id) REFERENCES world_organizations(world_id,id) ON DELETE RESTRICT
    );
    CREATE INDEX IF NOT EXISTS world_research_artifact_relations_artifact_active_idx
      ON world_research_artifact_relations(world_id,artifact_id,created_at DESC) WHERE active;
    CREATE UNIQUE INDEX IF NOT EXISTS world_research_artifact_relations_goal_uidx
      ON world_research_artifact_relations(world_id,artifact_id,goal_id) WHERE goal_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS world_research_artifact_relations_project_uidx
      ON world_research_artifact_relations(world_id,artifact_id,project_id) WHERE project_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS world_research_artifact_relations_business_uidx
      ON world_research_artifact_relations(world_id,artifact_id,business_id) WHERE business_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS world_research_artifact_relations_organization_uidx
      ON world_research_artifact_relations(world_id,artifact_id,organization_id) WHERE organization_id IS NOT NULL;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='synterra_app') THEN
      GRANT SELECT,INSERT ON world_research_artifact_relations TO synterra_app;
    END IF;
  END IF;
END $$;

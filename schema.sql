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

INSERT INTO crypto_risk_limits(world_id)
SELECT id FROM worlds ON CONFLICT(world_id) DO NOTHING;
INSERT INTO crypto_balances(world_id,agent_id,asset_symbol,balance)
SELECT world_id,agent_id,'USDC',10000 FROM world_members
ON CONFLICT(world_id,agent_id,asset_symbol) DO NOTHING;
INSERT INTO crypto_ledger(world_id,agent_id,asset_symbol,amount,entry_type,reference_id,reason)
SELECT world_id,agent_id,'USDC',10000,'seed','seed:v1','initial simulated trading balance'
FROM crypto_balances WHERE asset_symbol='USDC'
ON CONFLICT(world_id,agent_id,asset_symbol,reference_id) DO NOTHING;

CREATE INDEX IF NOT EXISTS crypto_trades_world_recent_idx ON crypto_trades(world_id,created_at DESC);
CREATE INDEX IF NOT EXISTS crypto_ledger_balance_idx ON crypto_ledger(world_id,agent_id,asset_symbol,created_at DESC);

-- Read-only Robinhood Chain Pons V2 market observations and internal paper trades.
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
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','closed')),
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
  source text NOT NULL DEFAULT 'seed' CHECK (source IN ('seed','experience','memory','relationship','opportunity','strategy','self_generated')),
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

CREATE TABLE IF NOT EXISTS world_agent_beliefs (
  world_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  subject_type text NOT NULL CHECK (subject_type IN ('action','place','resident','asset')),
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
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (world_id,agent_id) REFERENCES world_members(world_id,agent_id) ON DELETE CASCADE
);
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
    AND pg_get_constraintdef(oid) LIKE '%opportunity_propose%') THEN
    ALTER TABLE world_agent_states DROP CONSTRAINT IF EXISTS world_agent_states_planned_action_check;
    ALTER TABLE world_agent_states ADD CONSTRAINT world_agent_states_planned_action_check
      CHECK (planned_action IS NULL OR planned_action IN ('work','learn','rest','eat','socialize','trade','cooperate',
        'opportunity','opportunity_reject','opportunity_propose','project_propose','project_join','project_reject','project_contribute','project_leave',
        'organization_found','organization_join','organization_leave','organization_invite',
        'organization_reject','organization_contribute','place_create','information_share',
        'information_accept','information_ignore','information_doubt'));
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
      AND conname='world_agent_beliefs_subject_type_check' AND pg_get_constraintdef(oid) LIKE '%opportunity%') THEN
    ALTER TABLE world_agent_beliefs DROP CONSTRAINT IF EXISTS world_agent_beliefs_subject_type_check;
    ALTER TABLE world_agent_beliefs ADD CONSTRAINT world_agent_beliefs_subject_type_check
      CHECK (subject_type IN ('action','place','resident','asset','project','opportunity'));
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
      AND conname='world_history_event_type_check' AND pg_get_constraintdef(oid) LIKE '%project_proposed%') THEN
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

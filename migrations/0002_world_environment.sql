-- World environment model. Mirrors the idempotent block at the end of schema.sql so databases
-- upgraded only through migrations receive the same additive columns.
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

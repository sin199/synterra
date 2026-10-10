BEGIN;

ALTER TABLE world_capability_uses
  DROP CONSTRAINT IF EXISTS world_capability_uses_status_check;
ALTER TABLE world_capability_uses
  ADD CONSTRAINT world_capability_uses_status_check
  CHECK (status = ANY (ARRAY['pending'::text,'running'::text,'completed'::text,'failed'::text,'abandoned'::text]));
CREATE UNIQUE INDEX world_capability_uses_world_id_id_uidx ON world_capability_uses(world_id, id);
CREATE UNIQUE INDEX world_agent_goals_world_id_id_uidx ON world_agent_goals(world_id, id);
CREATE UNIQUE INDEX world_projects_world_id_id_uidx ON world_projects(world_id, id);
CREATE UNIQUE INDEX world_businesses_world_id_id_uidx ON world_businesses(world_id, id);
CREATE UNIQUE INDEX world_organizations_world_id_id_uidx ON world_organizations(world_id, id);

CREATE TABLE world_research_artifacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  artifact_key text NOT NULL CHECK (char_length(artifact_key) BETWEEN 8 AND 120),
  display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 180),
  target_type text NOT NULL CHECK (target_type ~ '^[a-z][a-z0-9_.-]{1,63}$'),
  storage_key text NOT NULL CHECK (storage_key ~ '^[0-9a-f]{64}$'),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  byte_size bigint NOT NULL CHECK (byte_size > 0 AND byte_size <= 33554432),
  media_type text NOT NULL CHECK (char_length(media_type) BETWEEN 1 AND 120),
  created_by_agent_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  active boolean NOT NULL DEFAULT true,
  UNIQUE (world_id, artifact_key),
  UNIQUE (world_id, id),
  FOREIGN KEY (world_id, created_by_agent_id) REFERENCES world_members(world_id, agent_id) ON DELETE RESTRICT
);

CREATE TABLE world_research_artifact_grants (
  world_id uuid NOT NULL,
  artifact_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (world_id, artifact_id, agent_id),
  FOREIGN KEY (world_id, artifact_id) REFERENCES world_research_artifacts(world_id, id) ON DELETE CASCADE,
  FOREIGN KEY (world_id, agent_id) REFERENCES world_members(world_id, agent_id) ON DELETE CASCADE
);
CREATE INDEX world_research_artifact_grants_agent_idx
  ON world_research_artifact_grants(world_id, agent_id, created_at DESC);

CREATE TABLE world_research_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  actor_agent_id uuid NOT NULL,
  capability_id uuid NOT NULL,
  capability_use_id bigint NOT NULL UNIQUE,
  action_id text NOT NULL CHECK (char_length(action_id) BETWEEN 8 AND 180),
  goal_id bigint,
  project_id uuid,
  business_id uuid,
  organization_id uuid,
  research_question text NOT NULL CHECK (char_length(research_question) BETWEEN 8 AND 1200),
  objective text NOT NULL CHECK (char_length(objective) BETWEEN 8 AND 1600),
  target_artifact_id uuid NOT NULL,
  target_type text NOT NULL CHECK (target_type ~ '^[a-z][a-z0-9_.-]{1,63}$'),
  desired_investigation text NOT NULL CHECK (char_length(desired_investigation) BETWEEN 1 AND 1200),
  expected_result text NOT NULL CHECK (char_length(expected_result) BETWEEN 1 AND 800),
  status text NOT NULL DEFAULT 'queued'
    CHECK (status = ANY (ARRAY['queued'::text,'running'::text,'completed'::text,'failed'::text,'cancelled'::text,'timed_out'::text])),
  selected_providers jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(selected_providers)='array'),
  tool_sequence jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(tool_sequence)='array'),
  tool_calls jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(tool_calls)='array'),
  created_world_minute bigint NOT NULL CHECK (created_world_minute >= 0),
  started_world_minute bigint CHECK (started_world_minute IS NULL OR started_world_minute >= 0),
  completed_world_minute bigint CHECK (completed_world_minute IS NULL OR completed_world_minute >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  worker_id text CHECK (worker_id IS NULL OR char_length(worker_id) BETWEEN 1 AND 120),
  lease_expires_at timestamptz,
  external_call_started_at timestamptz,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  evidence_reference text CHECK (evidence_reference IS NULL OR char_length(evidence_reference) <= 240),
  evidence_sha256 text CHECK (evidence_sha256 IS NULL OR evidence_sha256 ~ '^[0-9a-f]{64}$'),
  evidence_bytes bigint CHECK (evidence_bytes IS NULL OR evidence_bytes >= 0),
  normalized_findings jsonb CHECK (normalized_findings IS NULL OR jsonb_typeof(normalized_findings)='object'),
  failure_code text CHECK (failure_code IS NULL OR failure_code ~ '^[A-Z0-9_]{3,96}$'),
  failure_diagnostic text CHECK (failure_diagnostic IS NULL OR char_length(failure_diagnostic) <= 2000),
  infrastructure_usage_event_id uuid REFERENCES world_infrastructure_usage_events(id) ON DELETE SET NULL,
  UNIQUE (world_id, action_id),
  CHECK (num_nonnulls(goal_id, project_id, business_id, organization_id) <= 1),
  FOREIGN KEY (world_id, actor_agent_id) REFERENCES world_members(world_id, agent_id) ON DELETE RESTRICT,
  FOREIGN KEY (world_id, capability_use_id) REFERENCES world_capability_uses(world_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (world_id, capability_id) REFERENCES world_capabilities(world_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (world_id, goal_id) REFERENCES world_agent_goals(world_id, id) ON DELETE SET NULL (goal_id),
  FOREIGN KEY (world_id, project_id) REFERENCES world_projects(world_id, id) ON DELETE SET NULL (project_id),
  FOREIGN KEY (world_id, business_id) REFERENCES world_businesses(world_id, id) ON DELETE SET NULL (business_id),
  FOREIGN KEY (world_id, organization_id) REFERENCES world_organizations(world_id, id) ON DELETE SET NULL (organization_id),
  FOREIGN KEY (world_id, target_artifact_id) REFERENCES world_research_artifacts(world_id, id) ON DELETE RESTRICT
);
CREATE INDEX world_research_jobs_queue_idx
  ON world_research_jobs(status, created_at, id) WHERE status IN ('queued','running');
CREATE INDEX world_research_jobs_agent_recent_idx
  ON world_research_jobs(world_id, actor_agent_id, created_at DESC, id DESC);

CREATE TABLE world_research_runtime_status (
  world_id uuid PRIMARY KEY REFERENCES worlds(id) ON DELETE CASCADE,
  worker_status text NOT NULL DEFAULT 'starting'
    CHECK (worker_status = ANY (ARRAY['stopped'::text,'starting'::text,'ready'::text,'degraded'::text,'unavailable'::text,'error'::text])),
  worker_id text CHECK (worker_id IS NULL OR char_length(worker_id) BETWEEN 1 AND 120),
  node_version text CHECK (node_version IS NULL OR char_length(node_version) <= 40),
  rea_package_version text CHECK (rea_package_version IS NULL OR char_length(rea_package_version) <= 40),
  rea_server_name text CHECK (rea_server_name IS NULL OR char_length(rea_server_name) <= 120),
  providers jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(providers)='array'),
  tool_catalog jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(tool_catalog)='array'),
  ghidra_available boolean NOT NULL DEFAULT false,
  checked_at timestamptz,
  last_error_code text CHECK (last_error_code IS NULL OR last_error_code ~ '^[A-Z0-9_]{3,96}$'),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT,INSERT ON world_research_artifacts,world_research_artifact_grants TO synterra_app;
GRANT SELECT,INSERT ON world_research_jobs TO synterra_app;
GRANT SELECT,INSERT,UPDATE ON world_research_runtime_status TO synterra_app;
GRANT UPDATE (status,worker_id,started_at,lease_expires_at,attempt_count,external_call_started_at,
  completed_at,completed_world_minute,evidence_reference,evidence_sha256,evidence_bytes,normalized_findings,
  selected_providers,tool_sequence,tool_calls,infrastructure_usage_event_id,failure_code,failure_diagnostic,updated_at)
  ON world_research_jobs TO synterra_app;
GRANT SELECT,INSERT ON world_capability_uses TO synterra_app;
GRANT UPDATE (status,success,costs,effects,side_effects,result) ON world_capability_uses TO synterra_app;
GRANT SELECT ON world_capabilities TO synterra_app;
GRANT UPDATE (usage_count,success_count,failure_count,updated_at) ON world_capabilities TO synterra_app;
GRANT USAGE ON SEQUENCE world_capability_uses_id_seq TO synterra_app;

COMMIT;

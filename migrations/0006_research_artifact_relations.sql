ALTER TABLE world_research_artifacts
  ADD COLUMN IF NOT EXISTS intake_method text NOT NULL DEFAULT 'legacy_unrecorded'
    CHECK (intake_method IN ('legacy_unrecorded','operator_intake')),
  ADD COLUMN IF NOT EXISTS origin_reference text
    CHECK (origin_reference IS NULL OR char_length(origin_reference) BETWEEN 1 AND 500);

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
  FOREIGN KEY (world_id,artifact_id)
    REFERENCES world_research_artifacts(world_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (world_id,goal_id)
    REFERENCES world_agent_goals(world_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (world_id,project_id)
    REFERENCES world_projects(world_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (world_id,business_id)
    REFERENCES world_businesses(world_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (world_id,organization_id)
    REFERENCES world_organizations(world_id,id) ON DELETE RESTRICT
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

GRANT SELECT,INSERT ON world_research_artifact_relations TO synterra_app;

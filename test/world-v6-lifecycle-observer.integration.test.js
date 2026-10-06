import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { Pool } from 'pg';
import { captureV6LifecycleSnapshot, readWorldV6Lifecycle } from '../src/world-v6-lifecycle-observer.js';

const databaseUrl = process.env.SYNTERRA_TEST_DATABASE_URL;
const enabled = process.env.SYNTERRA_TEST_ISOLATED === '1' && Boolean(databaseUrl);
const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function assertIsolatedDatabase(connectionString) {
  const parsed = new URL(connectionString);
  assert.ok(['127.0.0.1','localhost','::1'].includes(parsed.hostname), 'observer integration requires loopback PostgreSQL');
  assert.ok(decodeURIComponent(parsed.pathname.slice(1)).endsWith('_test'), 'observer integration requires a *_test database');
  assert.notEqual(parsed.port, '5432', 'observer integration must not use the default PostgreSQL port');
}

test('V6 lifecycle observer reports natural no-action, funnel state, usage, and V7 genealogy without mutating source tables', {
  skip: !enabled,
  timeout: 120_000
}, async () => {
  assertIsolatedDatabase(databaseUrl);
  const pool = new Pool({ connectionString: databaseUrl, max: 5 });
  const worldId = randomUUID();
  const agents = [randomUUID(), randomUUID(), randomUUID()];
  const [gapId, unreviewedGapId, organizationId] = [randomUUID(), randomUUID(), randomUUID()];
  const capabilityIds = [randomUUID(), randomUUID(), randomUUID()];
  const proposalId = randomUUID();
  const experimentId = randomUUID();
  const snapshotDirectory = await mkdtemp(path.join(os.tmpdir(), 'synterra-v6-lifecycle-snapshot-'));
  try {
    await pool.query(await readFile(path.join(repoRoot, 'schema.sql'), 'utf8'));
    await pool.query(`INSERT INTO agents(id,name,public_key,gender) VALUES
      ($1,'Observer A',$2,'female'),($3,'Observer B',$4,'male'),($5,'Observer C',$6,'female')`,
    [agents[0], `observer-key-${agents[0]}`, agents[1], `observer-key-${agents[1]}`, agents[2], `observer-key-${agents[2]}`]);
    await pool.query(`INSERT INTO worlds(id,owner_agent_id,name,chain_id,open) VALUES($1,$2,'Observer integration world',5042,true)`,
      [worldId, agents[0]]);
    await pool.query(`INSERT INTO world_members(world_id,agent_id,role,energy,food,social,location) VALUES
      ($1,$2,'owner',100,100,80,'Library'),($1,$3,'resident',100,100,80,'Library'),($1,$4,'resident',100,100,80,'Library')`,
    [worldId, ...agents]);
    await pool.query(`INSERT INTO world_runtime_state(world_id,tick_count,world_minutes,last_tick_at,typesafe_next_at)
      VALUES($1,3000,3000,now(),now()+interval '1 day')`, [worldId]);
    await pool.query(`INSERT INTO world_epochs(world_id,epoch_code,name,status,started_world_minute,description)
      VALUES($1,'V6','Agent-Built Civilization','historic',0,'Observer fixture'),
        ($1,'V7','Self-Authored Agent Civilization','active',2_100,'Observer fixture')`, [worldId]);
    await pool.query(`INSERT INTO world_capability_gaps(id,world_id,gap_key,category,problem_statement,status,
        observation_count,first_observed_world_minute,last_observed_world_minute,evidence)
      VALUES($1,$2,'observer-gap-ignore','collaboration.execution_gap','A repeated simulated capability gap remains visible.','open',2,0,2_880,'{"source":"test"}'::jsonb),
        ($3,$2,'observer-gap-unseen','economy.execution_gap','A mature gap has no resident awareness or decision record.','open',2,100,2_000,'{"source":"test"}'::jsonb)`,
    [gapId, worldId, unreviewedGapId]);
    await pool.query(`INSERT INTO world_capability_observations(world_id,gap_id,agent_id,observed_world_day,
        observed_world_minute,observation_path,evidence) VALUES
      ($1,$2,$3,1,1,'memory_goal_and_social_context','{}'::jsonb),
      ($1,$2,$4,2,2,'public_market_and_prior_experience','{}'::jsonb)`, [worldId, gapId, agents[0], agents[1]]);
    await pool.query(`INSERT INTO world_organizations(id,world_id,founder_agent_id,name,purpose,status,action_id,
        created_world_time,updated_world_time) VALUES($1,$2,$3,'Observer Commons','Observe a shared simulation gap.',
        'active','observer-organization-created',100,100)`, [organizationId, worldId, agents[0]]);
    await pool.query(`INSERT INTO world_organization_members(world_id,organization_id,agent_id,status,role,
        joined_world_time,updated_world_time,action_id) VALUES
      ($1,$2,$3,'active','founder',100,100,'observer-founder'),($1,$2,$4,'active','member',100,100,'observer-member')`,
    [worldId, organizationId, agents[0], agents[1]]);
    await pool.query(`INSERT INTO world_decision_traces(world_id,agent_id,tick_count,world_minutes,chosen_candidate_id,
        chosen_action,behavior_probability,distribution,utility_scores,goal_snapshot,rationale,source_key) VALUES
      ($1,$2,3000,2900,'ignore','civilization_proposal',1,
        '{"layer":"civilizational","source":"resident_action","optionCount":2,"choiceType":"proposal"}'::jsonb,
        '{"ignore":0,"draft:observer":0}'::jsonb,'{}'::jsonb,
        jsonb_build_object('selectedOption','ignore','gapId',$3::text),'observer-resident-choice'),
      ($1,$2,3000,2901,'ignore','civilization_organization_proposal',1,
        '{"layer":"civilizational","source":"resident_action","optionCount":2,"choiceType":"organization_proposal"}'::jsonb,
        '{"ignore":0,"draft:observer":0}'::jsonb,'{}'::jsonb,
        jsonb_build_object('selectedOption','ignore','gapId',$3::text),'observer-organization-choice')`,
    [worldId, agents[0], gapId]);
    await pool.query(`INSERT INTO world_capability_events(world_id,actor_agent_id,gap_id,event_type,event_key,world_minute,details)
      VALUES($1,$2,$3,'capability_innovation_considered','observer-resident-ignore',2900,
          '{"selectedOption":"ignore","optionCount":2}'::jsonb),
        ($1,$2,$3,'organization_capability_innovation_considered','observer-organization-retain',2901,
          jsonb_build_object('organizationId',$4::text,'decision','retain_current_approach','selectedOption','ignore'))`,
    [worldId, agents[0], gapId, organizationId]);

    await pool.query(`INSERT INTO world_capabilities(id,world_id,capability_key,category,name,description,status,version,
        creator_type,creator_agent_id,specification,created_world_minute,adopted_world_minute)
      VALUES($1,$4,'observer:root','test.seed','Observer Root','A stable substrate capability for genealogy tests.',
          'active',1,'system',NULL,'{"schemaVersion":1,"kind":"native_system"}'::jsonb,0,NULL),
        ($2,$4,'observer:a','test.agent','Resident Capability A','A resident capability with verified post-adoption use.',
          'active',1,'resident',$5,'{"schemaVersion":1,"kind":"composition","composition":[],"steps":[],"requirements":{"minEnergy":20,"minFood":8,"skills":{}},"costs":[],"participants":{"minimum":1,"maximum":1},"scope":{"type":"resident_set"}}'::jsonb,1900,2100),
        ($3,$4,'observer:b','test.agent','Resident Capability B','A second-order resident capability.',
          'experimental',1,'resident',$6,'{"schemaVersion":1,"kind":"composition","composition":[],"steps":[],"requirements":{"minEnergy":20,"minFood":8,"skills":{}},"costs":[],"participants":{"minimum":1,"maximum":1},"scope":{"type":"resident_set"}}'::jsonb,2200,NULL)`,
    [capabilityIds[0], capabilityIds[1], capabilityIds[2], worldId, agents[0], agents[1]]);
    await pool.query(`INSERT INTO world_capability_dependencies(world_id,capability_id,depends_on_capability_id,
        created_by_agent_id,created_world_minute,evidence) VALUES
      ($1,$2,$3,$4,1900,'{"source":"test"}'::jsonb),($1,$5,$2,$6,2200,'{"source":"test"}'::jsonb)`,
    [worldId, capabilityIds[1], capabilityIds[0], agents[0], capabilityIds[2], agents[1]]);
    await pool.query(`INSERT INTO world_capability_proposals(id,world_id,gap_id,creator_type,creator_agent_id,action_id,
        category,name,problem_statement,proposed_capability,expected_benefit,expected_cost,required_resources,
        affected_systems,status,capability_id,created_world_minute,updated_world_minute,expires_world_minute)
      VALUES($1,$2,$3,'resident',$4,'observer-proposal-action','test.agent','Observer proposal',
        'A proposal in the source lifecycle fixture.','{"schemaVersion":1}'::jsonb,'Test the recorded lifecycle.',
        '{}'::jsonb,'{}'::jsonb,'[]'::jsonb,'adopted',$5,1800,2200,45000)`,
    [proposalId, worldId, gapId, agents[0], capabilityIds[1]]);
    await pool.query(`INSERT INTO world_capability_reviews(world_id,proposal_id,reviewer_agent_id,reviewer_organization_id,
        review_stage,decision,rationale,evidence,created_world_minute,action_id) VALUES
      ($1,$2,$3,NULL,'proposal','support','The observed evidence is relevant.','{}'::jsonb,1850,'observer-review-support'),
      ($1,$2,$4,$5,'experiment','support','The organization recognizes the measured use.','{"reviewWeight":0.8}'::jsonb,2300,'observer-review-org')`,
    [worldId, proposalId, agents[1], agents[0], organizationId]);
    await pool.query(`INSERT INTO world_capability_experiments(id,world_id,proposal_id,capability_id,scope_type,
        participant_agent_ids,status,started_world_minute,ends_world_minute,evaluated_world_minute,evidence)
      VALUES($1,$2,$3,$4,'resident_set',$5::jsonb,'adopted',1900,2000,2100,'{"adoptionScore":0.84}'::jsonb)`,
    [experimentId, worldId, proposalId, capabilityIds[1], JSON.stringify([agents[0]])]);
    await pool.query(`INSERT INTO world_capability_uses(world_id,capability_id,experiment_id,actor_agent_id,action_id,
        world_minute,status,success,result) VALUES
      ($1,$2,$3,$4,'observer-use-during-experiment',2200,'completed',true,'{}'::jsonb),
      ($1,$2,NULL,$5,'observer-use-after-adoption',2300,'completed',true,'{}'::jsonb)`,
    [worldId, capabilityIds[1], experimentId, agents[1], agents[0]]);
    await pool.query(`INSERT INTO world_v7_events(world_id,actor_agent_id,event_type,entity_type,world_minute,details,action_id)
      VALUES($1,$2,'capability.created','capability',2200,'{}'::jsonb,'observer-v7-capability-event')`, [worldId, agents[1]]);
    const before = await pool.query(`SELECT (SELECT world_minutes FROM world_runtime_state WHERE world_id=$1) AS minute,
        (SELECT count(*)::int FROM world_capability_gaps WHERE world_id=$1) AS gaps,
        (SELECT count(*)::int FROM world_capability_observations WHERE world_id=$1) AS observations,
        (SELECT count(*)::int FROM world_capability_proposals WHERE world_id=$1) AS proposals,
        (SELECT count(*)::int FROM world_capability_reviews WHERE world_id=$1) AS reviews,
        (SELECT count(*)::int FROM world_capability_experiments WHERE world_id=$1) AS experiments,
        (SELECT count(*)::int FROM world_capability_uses WHERE world_id=$1) AS uses,
        (SELECT count(*)::int FROM world_capability_events WHERE world_id=$1) AS events,
        (SELECT count(*)::int FROM world_capabilities WHERE world_id=$1) AS capabilities,
        (SELECT count(*)::int FROM world_capability_dependencies WHERE world_id=$1) AS dependencies,
        (SELECT count(*)::int FROM world_v7_events WHERE world_id=$1) AS v7_events,
        (SELECT count(*)::int FROM world_history WHERE world_id=$1) AS history`, [worldId]);

    // The engine prunes decision traces; lifecycle events remain authoritative.
    await pool.query('DELETE FROM world_decision_traces WHERE world_id=$1', [worldId]);
    const result = await readWorldV6Lifecycle(pool, { worldId });
    assert.equal(result.worldMinute, 3_000);
    assert.equal(result.schema.v7TablesPresent, true);
    assert.equal(result.counts.gaps, 2);
    assert.equal(result.counts.matureGaps, 2);
    assert.equal(result.gaps.find((gap) => gap.id === gapId).awareResidentCount, 2);
    assert.equal(result.gaps.find((gap) => gap.id === gapId).awareOrganizationCount, 1);
    assert.deepEqual(new Set(result.gaps.find((gap) => gap.id === gapId).awarenessSources),
      new Set(['memory_goal_and_social_context','public_market_and_prior_experience']));
    const funnel = result.proposalFunnel.find((item) => item.gapId === gapId);
    assert.equal(funnel.candidateCycles, 2);
    assert.equal(funnel.validNoAction, 2);
    assert.equal(funnel.residentIgnoreEvents, 1);
    assert.equal(funnel.organizationRetainEvents, 1);
    assert.ok(result.proposalFunnel.find((item) => item.gapId === unreviewedGapId).blockers.includes('no_decision_event_recorded'));
    assert.equal(result.reviews.proposal.support, 1);
    assert.equal(result.reviews.experiment.organizationResponses, 1);
    assert.equal(result.experiments.counts.adopted, 1);
    assert.deepEqual(result.experiments.lifecycleCounts, {
      proposed: 0, running: 0, completed: 1, failed: 0, evaluated: 1, failedUses: 0,
      semantics: { proposed: 'reviewed_or_revised_proposals_without_experiment',
        failed: 'rejected_or_abandoned_experiment_outcomes', evaluated: 'evaluated_world_minute_is_set' }
    });
    assert.equal(result.adoption.evidence[0].score, 0.84);
    assert.equal(result.usage.experimentNonParticipantUses, 1);
    assert.equal(result.usage.postAdoptionUses, 2);
    assert.equal(result.genealogy.maximumDepth, 2);
    assert.equal(result.genealogy.secondOrderCapabilities, 1);
    assert.equal(result.genealogy.v7SecondOrderCapabilities, 1);
    assert.equal(result.genealogy.v7.capabilityEvents, 1);
    assert.ok(result.integrity.findings.some((finding) => finding.code === 'NO_DECISION_EVENT_RECORDED'
      && finding.entityId === unreviewedGapId));

    const state = await captureV6LifecycleSnapshot(pool, { worldId, directory: snapshotDirectory,
      now: new Date('2026-10-06T10:00:00.000Z') });
    assert.equal(state.latestWorldMinute, 3_000);
    assert.equal(state.latestFindingCount, result.integrity.findings.length);
    const persisted = JSON.parse(await readFile(path.join(snapshotDirectory, 'v6-lifecycle-observer.json'), 'utf8'));
    assert.equal(persisted.snapshots.length, 1);
    const after = await pool.query(`SELECT (SELECT world_minutes FROM world_runtime_state WHERE world_id=$1) AS minute,
        (SELECT count(*)::int FROM world_capability_gaps WHERE world_id=$1) AS gaps,
        (SELECT count(*)::int FROM world_capability_observations WHERE world_id=$1) AS observations,
        (SELECT count(*)::int FROM world_capability_proposals WHERE world_id=$1) AS proposals,
        (SELECT count(*)::int FROM world_capability_reviews WHERE world_id=$1) AS reviews,
        (SELECT count(*)::int FROM world_capability_experiments WHERE world_id=$1) AS experiments,
        (SELECT count(*)::int FROM world_capability_uses WHERE world_id=$1) AS uses,
        (SELECT count(*)::int FROM world_capability_events WHERE world_id=$1) AS events,
        (SELECT count(*)::int FROM world_capabilities WHERE world_id=$1) AS capabilities,
        (SELECT count(*)::int FROM world_capability_dependencies WHERE world_id=$1) AS dependencies,
        (SELECT count(*)::int FROM world_v7_events WHERE world_id=$1) AS v7_events,
        (SELECT count(*)::int FROM world_history WHERE world_id=$1) AS history`, [worldId]);
    assert.deepEqual(after.rows[0], before.rows[0], 'observer queries and file snapshots do not mutate lifecycle source tables or world time');
  } finally {
    await pool.query('DELETE FROM worlds WHERE id=$1', [worldId]).catch(() => {});
    await pool.query('DELETE FROM agents WHERE id=ANY($1::uuid[])', [agents]).catch(() => {});
    await pool.end();
    await rm(snapshotDirectory, { recursive: true, force: true });
  }
});

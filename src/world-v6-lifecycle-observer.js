import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CAPABILITY_GAP_MIN_AGE_MINUTES, CAPABILITY_GAP_MIN_OBSERVATIONS } from './world-capabilities.js';
import { capabilityGraphDepth } from './world-v7.js';

export const V6_LIFECYCLE_OBSERVER_INTERVAL_MS = 15 * 60_000;
export const V6_LIFECYCLE_OBSERVER_SNAPSHOT_LIMIT = 96;

let activeV6LifecycleObserver = null;

function maturityForGap(gap, worldMinute) {
  const blockers = [];
  const observations = Number(gap.observationCount) || 0;
  const age = Math.max(0, Number(worldMinute) - Number(gap.firstObservedWorldMinute));
  if (gap.status === 'stale') blockers.push('gap_status_stale');
  if (observations < CAPABILITY_GAP_MIN_OBSERVATIONS) blockers.push('needs_repeated_observation');
  if (age < CAPABILITY_GAP_MIN_AGE_MINUTES) blockers.push('minimum_world_age_not_reached');
  return { mature: blockers.length === 0, ageWorldMinutes: age, blockers };
}

function jsonValue(value, fallback = {}) {
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch { return fallback; }
  }
  return value && typeof value === 'object' ? value : fallback;
}

function serializedQuery(client) {
  if (typeof client.connect === 'function' && typeof client.release !== 'function') return client.query.bind(client);
  let pending = Promise.resolve();
  return (text, values) => {
    const current = pending.then(() => client.query(text, values));
    pending = current.then(() => undefined, () => undefined);
    return current;
  };
}

function eventEntityId(row) {
  return row.experimentId || row.proposalId || row.capabilityId || row.gapId || null;
}

function compactSnapshot(summary, cursor, observedAt) {
  return {
    worldId: summary.worldId,
    observedAt,
    worldMinute: summary.worldMinute,
    cursor,
    counts: {
      gaps: summary.counts.gaps,
      matureGaps: summary.counts.matureGaps,
      immatureGaps: summary.counts.immatureGaps,
      proposals: summary.counts.proposals,
      candidateCycles: summary.counts.candidateCycles,
      validNoAction: summary.counts.validNoAction,
      experiments: summary.counts.experiments,
      completedExperiments: summary.experiments?.lifecycleCounts?.completed ?? 0,
      failedExperiments: summary.experiments?.lifecycleCounts?.failed ?? 0,
      evaluatedExperiments: summary.experiments?.lifecycleCounts?.evaluated ?? 0,
      adoptedCapabilities: summary.counts.adoptedCapabilities,
      capabilityUses: summary.counts.capabilityUses,
      integrityFindings: summary.integrity?.findings?.length ?? 0,
      dependencyDepth: summary.genealogy.maximumDepth,
      secondOrderCapabilities: summary.genealogy.secondOrderCapabilities
    }
  };
}

function numericDelta(current, previous) {
  const result = {};
  for (const [key, value] of Object.entries(current || {})) {
    if (typeof value === 'number' && typeof previous?.[key] === 'number') result[key] = value - previous[key];
  }
  return result;
}

export function classifyV6GapMaturity(gap, worldMinute) {
  return maturityForGap(gap, worldMinute);
}

/** Read V6 lifecycle source tables and V7 genealogy links. This function issues SELECTs only. */
export async function readWorldV6Lifecycle(client, { worldId, worldMinute: requestedWorldMinute = null }) {
  const query = serializedQuery(client);
  const schemaResult = await query(`SELECT to_regclass('world_capability_dependencies') IS NOT NULL AS dependencies,
      to_regclass('world_agent_concepts') IS NOT NULL AS v7`);
  const schema = schemaResult.rows[0] || { dependencies: false, v7: false };
  const [clock, gapResult, decisionEvents, decisionTraces, proposalResult, reviewResult,
    experimentResult, capabilityResult, dependencyResult, v7Result, integrityResult] = await Promise.all([
    query(`SELECT runtime.world_minutes AS "worldMinute",
        (SELECT jsonb_agg(jsonb_build_object('code',epoch_code,'name',name,'status',status,
          'startedWorldMinute',started_world_minute) ORDER BY started_world_minute,id)
         FROM world_epochs WHERE world_id=$1 AND epoch_code IN ('V6','V7')) AS epochs
      FROM world_runtime_state runtime WHERE runtime.world_id=$1`, [worldId]),
    query(`SELECT gap.id,gap.gap_key AS "gapKey",gap.category,gap.problem_statement AS "problemStatement",
        gap.status,gap.observation_count AS "observationCount",
        gap.first_observed_world_minute AS "firstObservedWorldMinute",
        gap.last_observed_world_minute AS "latestObservedWorldMinute",gap.evidence,
        count(DISTINCT observation.agent_id)::int AS "awareResidentCount",
        count(DISTINCT organization.id)::int AS "awareOrganizationCount",
        COALESCE(array_agg(DISTINCT observation.observation_path)
          FILTER (WHERE observation.observation_path IS NOT NULL),ARRAY[]::text[]) AS "awarenessSources",
        COALESCE(jsonb_agg(DISTINCT jsonb_build_object('agentId',resident.id,'name',resident.name))
          FILTER (WHERE resident.id IS NOT NULL),'[]'::jsonb) AS "awareResidents",
        COALESCE(jsonb_agg(DISTINCT jsonb_build_object('id',organization.id,'name',organization.name))
          FILTER (WHERE organization.id IS NOT NULL),'[]'::jsonb) AS "awareOrganizations"
      FROM world_capability_gaps gap
      LEFT JOIN world_capability_observations observation ON observation.world_id=gap.world_id AND observation.gap_id=gap.id
      LEFT JOIN agents resident ON resident.id=observation.agent_id
      LEFT JOIN world_organization_members membership ON membership.world_id=observation.world_id
        AND membership.agent_id=observation.agent_id AND membership.status='active'
      LEFT JOIN world_organizations organization ON organization.world_id=membership.world_id
        AND organization.id=membership.organization_id AND organization.status='active'
      WHERE gap.world_id=$1
      GROUP BY gap.id ORDER BY gap.first_observed_world_minute,gap.id`, [worldId]),
    query(`SELECT id::text AS id,gap_id AS "gapId",event_type AS "eventType",world_minute AS "worldMinute",
        details,actor_agent_id AS "actorAgentId"
      FROM world_capability_events WHERE world_id=$1 AND gap_id IS NOT NULL
        AND event_type IN ('capability_innovation_considered','organization_capability_innovation_considered')
      ORDER BY world_minute,id`, [worldId]),
    query(`SELECT trace.id,trace.agent_id AS "agentId",trace.chosen_action AS action,
        trace.chosen_candidate_id AS "selectedOption",trace.world_minutes AS "worldMinute",
        trace.distribution->>'choiceType' AS "choiceType",trace.distribution->>'optionCount' AS "optionCount",
        trace.distribution->>'source' AS source,trace.rationale->>'gapId' AS "gapId"
      FROM world_decision_traces trace JOIN world_capability_gaps gap
        ON gap.world_id=trace.world_id AND gap.id::text=trace.rationale->>'gapId'
      WHERE trace.world_id=$1 AND trace.chosen_action IN
        ('civilization_proposal','civilization_organization_proposal')
      ORDER BY trace.world_minutes,trace.id`, [worldId]),
    query(`SELECT proposal.id,proposal.gap_id AS "gapId",proposal.creator_type AS "creatorType",
        proposal.creator_agent_id AS "creatorAgentId",creator.name AS "creatorName",
        proposal.creator_organization_id AS "creatorOrganizationId",organization.name AS "organizationName",
        proposal.name,proposal.category,proposal.status,proposal.revision,
        proposal.created_world_minute AS "createdWorldMinute",proposal.updated_world_minute AS "updatedWorldMinute",
        proposal.expires_world_minute AS "expiresWorldMinute",proposal.capability_id AS "capabilityId",
        proposal.support_count AS "supportCount",proposal.opposition_count AS "oppositionCount",
        count(DISTINCT review.id)::int AS "reviewCount",
        count(DISTINCT review.id) FILTER (WHERE review.reviewer_organization_id IS NOT NULL)::int AS "organizationReviewCount",
        max(review.created_world_minute) AS "latestReviewWorldMinute"
      FROM world_capability_proposals proposal
      LEFT JOIN agents creator ON creator.id=proposal.creator_agent_id
      LEFT JOIN world_organizations organization ON organization.world_id=proposal.world_id
        AND organization.id=proposal.creator_organization_id
      LEFT JOIN world_capability_reviews review ON review.world_id=proposal.world_id AND review.proposal_id=proposal.id
      WHERE proposal.world_id=$1 GROUP BY proposal.id,creator.name,organization.name
      ORDER BY proposal.created_world_minute,proposal.id`, [worldId]),
    query(`SELECT review.review_stage AS stage,review.decision,
        (review.reviewer_organization_id IS NOT NULL)::boolean AS "organizationResponse",
        count(*)::int AS count
      FROM world_capability_reviews review WHERE review.world_id=$1
      GROUP BY review.review_stage,review.decision,(review.reviewer_organization_id IS NOT NULL)
      ORDER BY review.review_stage,review.decision`, [worldId]),
    query(`SELECT experiment.id,experiment.proposal_id AS "proposalId",experiment.capability_id AS "capabilityId",
        proposal.gap_id AS "gapId",proposal.name AS "proposalName",experiment.status,
        experiment.started_world_minute AS "startedWorldMinute",experiment.ends_world_minute AS "endsWorldMinute",
        experiment.evaluated_world_minute AS "evaluatedWorldMinute",experiment.participant_agent_ids AS "participantAgentIds",
        experiment.evidence
      FROM world_capability_experiments experiment JOIN world_capability_proposals proposal
        ON proposal.world_id=experiment.world_id AND proposal.id=experiment.proposal_id
      WHERE experiment.world_id=$1 ORDER BY experiment.started_world_minute,experiment.id`, [worldId]),
    query(`SELECT capability.id,capability.name,capability.category,capability.status,
        capability.creator_type AS "creatorType",capability.creator_agent_id AS "creatorAgentId",
        capability.creator_organization_id AS "creatorOrganizationId",
        capability.parent_capability_id AS "parentCapabilityId",capability.created_world_minute AS "createdWorldMinute",
        capability.adopted_world_minute AS "adoptedWorldMinute",capability.usage_count AS "usageCount",
        capability.success_count AS "successCount",capability.failure_count AS "failureCount",
        count(usage.id)::int AS "totalUses",
        count(usage.id) FILTER (WHERE usage.success)::int AS "successfulUses",
        count(usage.id) FILTER (WHERE NOT usage.success)::int AS "failedUses",
        count(usage.id) FILTER (WHERE usage.experiment_id IS NOT NULL)::int AS "experimentUses",
        count(usage.id) FILTER (WHERE usage.experiment_id IS NOT NULL AND usage.success)::int AS "experimentSuccesses",
        count(usage.id) FILTER (WHERE usage.experiment_id IS NOT NULL AND NOT usage.success)::int AS "experimentFailures",
        count(usage.id) FILTER (WHERE usage.experiment_id IS NOT NULL AND EXISTS (
          SELECT 1 FROM world_capability_experiments experiment,
            LATERAL jsonb_array_elements_text(experiment.participant_agent_ids) participant
          WHERE experiment.world_id=usage.world_id AND experiment.id=usage.experiment_id
            AND participant.value=usage.actor_agent_id::text))::int AS "experimentParticipantUses",
        count(usage.id) FILTER (WHERE usage.experiment_id IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM world_capability_experiments experiment,
            LATERAL jsonb_array_elements_text(experiment.participant_agent_ids) participant
          WHERE experiment.world_id=usage.world_id AND experiment.id=usage.experiment_id
            AND participant.value=usage.actor_agent_id::text))::int AS "experimentNonParticipantUses",
        count(usage.id) FILTER (WHERE capability.adopted_world_minute IS NOT NULL
          AND usage.world_minute>=capability.adopted_world_minute)::int AS "postAdoptionUses",
        count(usage.id) FILTER (WHERE capability.adopted_world_minute IS NOT NULL
          AND usage.world_minute>=capability.adopted_world_minute AND usage.success)::int AS "postAdoptionSuccesses",
        count(usage.id) FILTER (WHERE capability.adopted_world_minute IS NOT NULL
          AND usage.world_minute>=capability.adopted_world_minute AND NOT usage.success)::int AS "postAdoptionFailures"
      FROM world_capabilities capability LEFT JOIN world_capability_uses usage
        ON usage.world_id=capability.world_id AND usage.capability_id=capability.id
      WHERE capability.world_id=$1 GROUP BY capability.id ORDER BY capability.created_world_minute,capability.id`, [worldId]),
    schema.dependencies ? query(`SELECT dependency.capability_id AS "capabilityId",
        dependency.depends_on_capability_id AS "dependsOnCapabilityId",
        child.name AS "capabilityName",parent.name AS "dependencyName"
      FROM world_capability_dependencies dependency
      LEFT JOIN world_capabilities child ON child.world_id=dependency.world_id AND child.id=dependency.capability_id
      LEFT JOIN world_capabilities parent ON parent.world_id=dependency.world_id AND parent.id=dependency.depends_on_capability_id
      WHERE dependency.world_id=$1 ORDER BY dependency.created_world_minute,dependency.capability_id`, [worldId])
      : Promise.resolve({ rows: [] }),
    schema.v7 ? query(`SELECT
        (SELECT count(*)::int FROM world_agent_concepts WHERE world_id=$1) AS concepts,
        (SELECT count(*)::int FROM world_agent_goals WHERE world_id=$1 AND source='self_generated'
          AND metadata ? 'goalGrammar') AS "selfGeneratedGoals",
        (SELECT count(*)::int FROM world_agent_policy_experiments WHERE world_id=$1) AS "policyExperiments",
        (SELECT count(*)::int FROM world_extension_requests WHERE world_id=$1) AS "extensionRequests",
        (SELECT count(*)::int FROM world_v7_events WHERE world_id=$1 AND entity_type='capability') AS "v7CapabilityEvents"`, [worldId])
      : Promise.resolve({ rows: [{ concepts: 0, selfGeneratedGoals: 0, policyExperiments: 0,
        extensionRequests: 0, v7CapabilityEvents: 0 }] }),
    query(`SELECT event_type AS "eventType",proposal_id AS "proposalId",experiment_id AS "experimentId",
        capability_id AS "capabilityId",gap_id AS "gapId",count(*)::int AS count
      FROM world_capability_events WHERE world_id=$1
        AND event_type IN ('capability_adopted','capability_rejected','capability_abandoned')
      GROUP BY event_type,proposal_id,experiment_id,capability_id,gap_id HAVING count(*)>1
      ORDER BY event_type,proposal_id,experiment_id,capability_id,gap_id`, [worldId])
  ]);

  const worldMinute = Math.max(0, Math.trunc(Number(requestedWorldMinute ?? clock.rows[0]?.worldMinute) || 0));
  const gaps = gapResult.rows.map((row) => {
    const maturity = maturityForGap(row, worldMinute);
    return { ...row, observationCount: Number(row.observationCount),
      firstObservedWorldMinute: Number(row.firstObservedWorldMinute),
      latestObservedWorldMinute: Number(row.latestObservedWorldMinute),
      awareResidentCount: Number(row.awareResidentCount), awareOrganizationCount: Number(row.awareOrganizationCount),
      evidence: jsonValue(row.evidence), maturityBlockers: maturity.blockers, ...maturity };
  });
  const proposals = proposalResult.rows.map((row) => ({ ...row,
    createdWorldMinute: Number(row.createdWorldMinute), updatedWorldMinute: Number(row.updatedWorldMinute),
    expiresWorldMinute: Number(row.expiresWorldMinute), reviewCount: Number(row.reviewCount),
    organizationReviewCount: Number(row.organizationReviewCount) }));
  const decisionsByGap = new Map();
  for (const event of decisionEvents.rows) {
    const records = decisionsByGap.get(event.gapId) || [];
    records.push({ ...event, worldMinute: Number(event.worldMinute), details: jsonValue(event.details) });
    decisionsByGap.set(event.gapId, records);
  }
  const tracesByGap = new Map();
  for (const trace of decisionTraces.rows) {
    const records = tracesByGap.get(trace.gapId) || [];
    records.push({ ...trace, id: String(trace.id), worldMinute: Number(trace.worldMinute),
      optionCount: Number(trace.optionCount) || 0 });
    tracesByGap.set(trace.gapId, records);
  }
  const proposalsByGap = new Map();
  for (const proposal of proposals) {
    const records = proposalsByGap.get(proposal.gapId) || [];
    records.push(proposal);
    proposalsByGap.set(proposal.gapId, records);
  }

  const funnel = gaps.map((gap) => {
    const decisions = decisionsByGap.get(gap.id) || [];
    const traces = tracesByGap.get(gap.id) || [];
    const associatedProposals = proposalsByGap.get(gap.id) || [];
    // Decision traces are intentionally pruned to a small per-resident window.
    // The append-only capability events remain the source of truth for the
    // historical funnel: resident details retain optionCount, and an
    // organization decision event is written only after its draft options
    // were generated.
    const candidateCycles = decisions.filter((event) =>
      event.eventType === 'capability_innovation_considered'
        ? Number(event.details.optionCount) > 1
        : event.eventType === 'organization_capability_innovation_considered');
    const residentNoAction = decisions.filter((event) => event.eventType === 'capability_innovation_considered'
      && event.details.selectedOption === 'ignore').length;
    const organizationNoAction = decisions.filter((event) => event.eventType === 'organization_capability_innovation_considered'
      && event.details.decision === 'retain_current_approach').length;
    const blockers = [...gap.blockers];
    if (gap.mature && gap.awareResidentCount === 0) blockers.push('no_resident_awareness_recorded');
    if (gap.mature && decisions.length === 0) blockers.push('no_decision_event_recorded');
    if (decisions.some((event) => event.details.selectedOption && event.details.selectedOption !== 'ignore')
        && associatedProposals.length === 0) blockers.push('selected_candidate_without_proposal');
    return { gapId: gap.id, mature: gap.mature, candidateCycles: candidateCycles.length,
      decisionEvents: decisions, proposals: associatedProposals, validNoAction: residentNoAction + organizationNoAction,
      residentIgnoreEvents: residentNoAction, organizationRetainEvents: organizationNoAction,
      blockers: [...new Set(blockers)] };
  });

  const reviewSummary = { proposal: { support: 0, oppose: 0, ignore: 0, revision: 0, organizationResponses: 0 },
    experiment: { support: 0, oppose: 0, ignore: 0, revision: 0, organizationResponses: 0 } };
  for (const row of reviewResult.rows) {
    const stage = reviewSummary[row.stage];
    if (!stage) continue;
    const key = row.decision === 'modify' ? 'revision' : row.decision;
    stage[key] += Number(row.count);
    if (row.organizationResponse) stage.organizationResponses += Number(row.count);
  }

  const experiments = experimentResult.rows.map((row) => ({ ...row,
    startedWorldMinute: Number(row.startedWorldMinute), endsWorldMinute: Number(row.endsWorldMinute),
    evaluatedWorldMinute: row.evaluatedWorldMinute === null ? null : Number(row.evaluatedWorldMinute),
    participantAgentIds: jsonValue(row.participantAgentIds, []), evidence: jsonValue(row.evidence) }));
  const experimentStates = Object.fromEntries(['running','evaluated','adopted','revised','rejected','abandoned']
    .map((status) => [status, experiments.filter((row) => row.status === status).length]));
  const capabilities = capabilityResult.rows.map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) =>
    [key, ['createdWorldMinute','adoptedWorldMinute'].includes(key) ? (value === null ? null : Number(value))
      : ['usageCount','successCount','failureCount','totalUses','successfulUses','failedUses','experimentUses',
        'experimentSuccesses','experimentFailures',
        'experimentParticipantUses','experimentNonParticipantUses','postAdoptionUses','postAdoptionSuccesses',
        'postAdoptionFailures'].includes(key) ? Number(value) : value])));
  const graphEdges = dependencyResult.rows.filter((row) => row.capabilityName && row.dependencyName)
    .map((row) => ({ capabilityId: row.capabilityId, dependsOnCapabilityId: row.dependsOnCapabilityId }));
  const edgesWithParents = [...graphEdges];
  for (const capability of capabilities) {
    if (capability.parentCapabilityId && !edgesWithParents.some((edge) => edge.capabilityId === capability.id
        && edge.dependsOnCapabilityId === capability.parentCapabilityId)) {
      edgesWithParents.push({ capabilityId: capability.id, dependsOnCapabilityId: capability.parentCapabilityId });
    }
  }
  const genealogy = capabilityGraphDepth(capabilities, edgesWithParents);
  const depthById = new Map(genealogy.map((item) => [item.id, item]));
  const childrenByParent = new Map();
  for (const edge of edgesWithParents) childrenByParent.set(edge.dependsOnCapabilityId,
    (childrenByParent.get(edge.dependsOnCapabilityId) || 0) + 1);
  const findings = [];
  for (const item of funnel) for (const blocker of item.blockers) {
    if (blocker === 'needs_repeated_observation' || blocker === 'minimum_world_age_not_reached' || blocker === 'gap_status_stale') continue;
    findings.push({ code: blocker.toUpperCase(), entityType: 'capability_gap', entityId: item.gapId, severity: 'observe' });
  }
  for (const proposal of proposals) {
    if (['proposed','reviewed'].includes(proposal.status) && proposal.expiresWorldMinute !== null
        && worldMinute >= proposal.expiresWorldMinute) {
      findings.push({ code: 'PROPOSAL_PAST_EXPIRY_WITHOUT_NEXT_STATE', entityType: 'proposal',
        entityId: proposal.id, severity: 'observe' });
    }
  }
  for (const experiment of experiments) {
    if (experiment.status === 'running' && worldMinute >= experiment.endsWorldMinute) {
      findings.push({ code: 'EXPERIMENT_PAST_WINDOW_UNEVALUATED', entityType: 'experiment',
        entityId: experiment.id, severity: 'observe' });
    }
  }
  for (const capability of capabilities) {
    const graphItem = depthById.get(capability.id);
    if (graphItem?.cyclic) findings.push({ code: 'CAPABILITY_DEPENDENCY_CYCLE', entityType: 'capability',
      entityId: capability.id, severity: 'observe' });
    if (capability.status === 'active' && capability.adoptedWorldMinute !== null && capability.postAdoptionUses === 0) {
      findings.push({ code: 'ADOPTED_CAPABILITY_WITHOUT_POST_ADOPTION_USE', entityType: 'capability',
        entityId: capability.id, severity: 'observe' });
    }
  }
  for (const edge of dependencyResult.rows) {
    if (!edge.capabilityName || !edge.dependencyName) findings.push({ code: 'INVALID_CAPABILITY_DEPENDENCY_REFERENCE',
      entityType: 'capability_dependency', entityId: edge.capabilityId, severity: 'observe' });
  }
  for (const row of integrityResult.rows) findings.push({ code: 'DUPLICATE_TERMINAL_LIFECYCLE_TRANSITION',
    entityType: 'capability_lifecycle', entityId: eventEntityId(row), eventType: row.eventType,
    duplicateCount: Number(row.count), severity: 'observe' });

  const counts = {
    gaps: gaps.length,
    immatureGaps: gaps.filter((gap) => !gap.mature && gap.status !== 'stale').length,
    matureGaps: gaps.filter((gap) => gap.mature).length,
    staleGaps: gaps.filter((gap) => gap.status === 'stale').length,
    observationCount: gaps.reduce((sum, gap) => sum + gap.observationCount, 0),
    proposals: proposals.length,
    candidateCycles: funnel.reduce((sum, item) => sum + item.candidateCycles, 0),
    validNoAction: funnel.reduce((sum, item) => sum + item.validNoAction, 0),
    experiments: experiments.length,
    adoptedCapabilities: capabilities.filter((capability) => capability.status === 'active'
      && capability.adoptedWorldMinute !== null).length,
    capabilityUses: capabilities.reduce((sum, capability) => sum + capability.totalUses, 0),
    capabilityUseSuccesses: capabilities.reduce((sum, capability) => sum + capability.successfulUses, 0),
    capabilityUseFailures: capabilities.reduce((sum, capability) => sum + capability.failedUses, 0)
  };
  const proposalsAwaitingExperiment = proposals.filter((proposal) => ['reviewed','revised'].includes(proposal.status)
    && !experiments.some((experiment) => experiment.proposalId === proposal.id)).length;
  const completedStatuses = ['evaluated','adopted','revised','rejected','abandoned'];
  const completedExperiments = experiments.filter((experiment) => completedStatuses.includes(experiment.status)).length;
  const failedExperiments = experiments.filter((experiment) => ['rejected','abandoned'].includes(experiment.status)).length;
  const evaluatedExperiments = experiments.filter((experiment) => experiment.evaluatedWorldMinute !== null).length;
  const failedExperimentUses = capabilities.reduce((sum, item) => sum + item.experimentFailures, 0);
  const observationCountBySource = {};
  for (const gap of gaps) for (const source of gap.awarenessSources || []) {
    observationCountBySource[source] = (observationCountBySource[source] || 0) + 1;
  }
  const v7 = v7Result.rows[0] || {};
  return {
    worldId, worldMinute, schema: { v7TablesPresent: Boolean(schema.v7), dependencyTablePresent: Boolean(schema.dependencies) },
    epochs: jsonValue(clock.rows[0]?.epochs, []),
    counts, gaps, proposalFunnel: funnel, proposals, reviews: reviewSummary,
    experiments: { counts: experimentStates,
      lifecycleCounts: { proposed: proposalsAwaitingExperiment, running: experimentStates.running,
        completed: completedExperiments, failed: failedExperiments, evaluated: evaluatedExperiments,
        failedUses: failedExperimentUses,
        semantics: { proposed: 'reviewed_or_revised_proposals_without_experiment',
          failed: 'rejected_or_abandoned_experiment_outcomes', evaluated: 'evaluated_world_minute_is_set' } },
      proposedAwaitingExperiment: proposalsAwaitingExperiment, records: experiments },
    adoption: { adopted: counts.adoptedCapabilities,
      rejected: proposals.filter((proposal) => proposal.status === 'rejected').length,
      revised: proposals.filter((proposal) => proposal.status === 'revised').length,
      evidence: capabilities.filter((capability) => capability.adoptedWorldMinute !== null)
        .map((capability) => ({ capabilityId: capability.id, name: capability.name,
          adoptedWorldMinute: capability.adoptedWorldMinute,
          score: experiments.find((experiment) => experiment.capabilityId === capability.id)?.evidence?.adoptionScore ?? null,
          evidence: experiments.find((experiment) => experiment.capabilityId === capability.id)?.evidence ?? null })) },
    usage: { total: counts.capabilityUses, successes: counts.capabilityUseSuccesses,
      failures: counts.capabilityUseFailures,
      experimentUses: capabilities.reduce((sum, item) => sum + item.experimentUses, 0),
      experimentParticipantUses: capabilities.reduce((sum, item) => sum + item.experimentParticipantUses, 0),
      experimentNonParticipantUses: capabilities.reduce((sum, item) => sum + item.experimentNonParticipantUses, 0),
      postAdoptionUses: capabilities.reduce((sum, item) => sum + item.postAdoptionUses, 0),
      postAdoptionSuccesses: capabilities.reduce((sum, item) => sum + item.postAdoptionSuccesses, 0),
      postAdoptionFailures: capabilities.reduce((sum, item) => sum + item.postAdoptionFailures, 0) },
    genealogy: { maximumDepth: Math.max(0, ...genealogy.map((item) => item.depth)),
      secondOrderCapabilities: genealogy.filter((item) => item.depth >= 2 && item.creatorType !== 'system').length,
      v7SecondOrderCapabilities: genealogy.filter((item) => {
        const capability = capabilities.find((candidate) => candidate.id === item.id);
        const v7Start = jsonValue(clock.rows[0]?.epochs, []).find((epoch) => epoch.code === 'V7')?.startedWorldMinute;
        return item.depth >= 2 && item.creatorType !== 'system' && v7Start !== undefined
          && capability?.createdWorldMinute !== null && capability?.createdWorldMinute >= Number(v7Start);
      }).length,
      forks: [...childrenByParent.values()].filter((children) => children > 1).length,
      invalidReferences: dependencyResult.rows.filter((row) => !row.capabilityName || !row.dependencyName).length,
      capabilities: genealogy.map((item) => ({ ...item,
        capability: capabilities.find((capability) => capability.id === item.id) || null })),
      v7: { concepts: Number(v7.concepts) || 0, selfGeneratedGoals: Number(v7.selfGeneratedGoals) || 0,
        policyExperiments: Number(v7.policyExperiments) || 0, extensionRequests: Number(v7.extensionRequests) || 0,
        capabilityEvents: Number(v7.v7CapabilityEvents) || 0 } },
    awareness: { observationSources: observationCountBySource,
      residents: gaps.reduce((sum, gap) => sum + gap.awareResidentCount, 0),
      organizations: gaps.reduce((sum, gap) => sum + gap.awareOrganizationCount, 0) },
    integrity: { findings, duplicateTransitions: integrityResult.rows.map((row) => ({ ...row, count: Number(row.count) })) }
  };
}

export async function persistV6LifecycleSnapshot(directory, snapshot) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const statePath = path.join(directory, 'v6-lifecycle-observer.json');
  let state = { schemaVersion: 1, worldId: snapshot.worldId, snapshots: [] };
  try {
    const prior = JSON.parse(await readFile(statePath, 'utf8'));
    if (prior.schemaVersion !== 1 || !Array.isArray(prior.snapshots)) throw new Error('V6_OBSERVER_STATE_INVALID');
    state = prior;
    if (state.worldId !== snapshot.worldId) throw new Error('V6_OBSERVER_WORLD_ID_CHANGED');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const previous = state.snapshots.at(-1) || null;
  const sameWorldMinute = previous?.worldMinute === snapshot.worldMinute;
  if (!sameWorldMinute) {
    const compact = compactSnapshot(snapshot.summary, snapshot.cursor, snapshot.observedAt);
    compact.deltaFromPrevious = numericDelta(compact.counts, previous?.counts);
    state.snapshots.push(compact);
    state.snapshots = state.snapshots.slice(-V6_LIFECYCLE_OBSERVER_SNAPSHOT_LIMIT);
  } else if (previous) {
    const priorDistinct = state.snapshots.at(-2) || null;
    const compact = compactSnapshot(snapshot.summary, snapshot.cursor, snapshot.observedAt);
    compact.deltaFromPrevious = numericDelta(compact.counts, priorDistinct?.counts);
    state.snapshots[state.snapshots.length - 1] = compact;
  }
  state.latestSnapshotAt = snapshot.observedAt;
  state.latestWorldMinute = snapshot.worldMinute;
  state.latestFindingCount = snapshot.summary.integrity?.findings?.length ?? 0;
  state.lastPollAt = snapshot.observedAt;
  state.lastObservationCursor = snapshot.cursor;
  const temporaryPath = `${statePath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await chmod(temporaryPath, 0o600);
  await rename(temporaryPath, statePath);
  await chmod(statePath, 0o600);
  return { lastPollAt: state.lastPollAt, latestSnapshotAt: state.latestSnapshotAt || null,
    latestWorldMinute: state.latestWorldMinute ?? null, latestFindingCount: state.latestFindingCount ?? null,
    snapshotCount: state.snapshots.length,
    cursor: state.lastObservationCursor };
}

export async function readV6LifecycleObserverState(directory, worldId) {
  try {
    const state = JSON.parse(await readFile(path.join(directory, 'v6-lifecycle-observer.json'), 'utf8'));
    if (state.schemaVersion !== 1 || state.worldId !== worldId || !Array.isArray(state.snapshots)) return null;
    return { lastPollAt: state.lastPollAt || null, latestSnapshotAt: state.latestSnapshotAt || null,
      latestWorldMinute: state.latestWorldMinute ?? null, snapshotCount: state.snapshots.length,
      latestFindingCount: state.latestFindingCount ?? state.snapshots.at(-1)?.counts?.integrityFindings ?? null,
      lastObservationCursor: state.lastObservationCursor || null };
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export function unavailableV6LifecycleObserverStatus({ intervalMs = V6_LIFECYCLE_OBSERVER_INTERVAL_MS,
  worldId = null, snapshot = null, reason = 'observer_not_registered', lastError = null } = {}) {
  return {
    available: false,
    running: false,
    worldId,
    mode: 'read_only',
    sourceOfTruth: 'database',
    samplingIntervalMinutes: Math.max(60_000, intervalMs) / 60_000,
    lastSampleAt: snapshot?.lastPollAt || snapshot?.latestSnapshotAt || null,
    lastSampleWorldMinute: snapshot?.latestWorldMinute ?? null,
    lastFindingCount: snapshot?.latestFindingCount ?? null,
    lastError,
    reason
  };
}

export async function captureV6LifecycleSnapshot(pool, { worldId, directory, now = new Date() }) {
  const client = await pool.connect();
  const observedAt = now.toISOString();
  let summary;
  let cursor;
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    summary = await readWorldV6Lifecycle(client, { worldId });
    const capabilityCursor = await client.query(`SELECT COALESCE(max(id),0)::text AS cursor
      FROM world_capability_events WHERE world_id=$1`, [worldId]);
    const v7Cursor = summary.schema.v7TablesPresent
      ? await client.query(`SELECT max(created_at) AS cursor FROM world_v7_events WHERE world_id=$1`, [worldId])
      : { rows: [{ cursor: null }] };
    cursor = { capabilityEventId: capabilityCursor.rows[0]?.cursor || '0',
      v7EventCreatedAt: v7Cursor.rows[0]?.cursor?.toISOString?.() || null };
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
  return persistV6LifecycleSnapshot(directory, { worldId, worldMinute: summary.worldMinute, summary, cursor, observedAt });
}

export function safeV6LifecycleObserverError(error) {
  const code = String(error?.code || '').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 64);
  let message = String(error?.message || error || 'unknown_error').replace(/[\r\n\t]/g, ' ');
  for (const secret of [process.env.DATABASE_URL, process.env.TYPESAFE_API_KEY].filter(Boolean)) {
    message = message.replaceAll(secret, '[redacted]');
  }
  message = message.replace(/postgres(?:ql)?:\/\/[^\s"'<>]+/gi, '[redacted database URL]')
    .replace(/([?&](?:password|token|api_key)=)[^&\s]+/gi, '$1[redacted]').slice(0, 160);
  return code ? `${code}: ${message}` : message;
}

export function startV6LifecycleObserver({ pool, worldId, directory, intervalMs = V6_LIFECYCLE_OBSERVER_INTERVAL_MS,
  onError = () => {}, captureSnapshot = captureV6LifecycleSnapshot, readState = readV6LifecycleObserverState,
  schedule = setInterval, unschedule = clearInterval, isOwner = () => true }) {
  if (activeV6LifecycleObserver) {
    if (activeV6LifecycleObserver.worldId === worldId && activeV6LifecycleObserver.directory === directory) {
      return activeV6LifecycleObserver;
    }
    throw new Error('V6_OBSERVER_ALREADY_REGISTERED');
  }

  let stopped = false;
  let inFlight = null;
  let timer = null;
  let stateLoaded = false;
  const status = {
    available: true,
    running: true,
    worldId,
    mode: 'read_only',
    sourceOfTruth: 'database',
    samplingIntervalMinutes: Math.max(60_000, intervalMs) / 60_000,
    lastSampleAt: null,
    lastSampleWorldMinute: null,
    lastFindingCount: null,
    lastError: null,
    reason: null
  };

  const controller = {
    worldId,
    directory,
    getStatus() {
      verifyOwnership();
      return { ...status, available: !stopped && status.available, running: !stopped && timer !== null };
    },
    async stop() {
      if (!stopped) {
        stopped = true;
        status.reason ||= 'stopped';
        if (timer !== null) unschedule(timer);
        timer = null;
      }
      if (inFlight) await inFlight;
      if (activeV6LifecycleObserver === controller) activeV6LifecycleObserver = null;
    }
  };
  activeV6LifecycleObserver = controller;

  function stopForUnavailableOwner(reason) {
    stopped = true;
    status.available = false;
    status.running = false;
    status.reason = reason;
    if (timer !== null) unschedule(timer);
    timer = null;
    if (!inFlight && activeV6LifecycleObserver === controller) activeV6LifecycleObserver = null;
  }

  function verifyOwnership() {
    if (stopped) return false;
    try {
      if (isOwner()) return true;
      stopForUnavailableOwner('world_lock_not_owned');
    } catch (error) {
      status.lastError = safeV6LifecycleObserverError(error);
      stopForUnavailableOwner('world_ownership_check_failed');
    }
    return false;
  }

  const run = async () => {
    if (!verifyOwnership() || inFlight) return inFlight;
    inFlight = (async () => {
      if (!stateLoaded) {
        const savedState = await readState(directory, worldId);
        stateLoaded = true;
        if (savedState) {
          status.lastSampleAt = savedState.lastPollAt || savedState.latestSnapshotAt || null;
          status.lastSampleWorldMinute = savedState.latestWorldMinute ?? null;
          status.lastFindingCount = savedState.latestFindingCount ?? null;
        }
      }
      const sample = await captureSnapshot(pool, { worldId, directory });
      status.lastSampleAt = sample.lastPollAt || sample.latestSnapshotAt || null;
      status.lastSampleWorldMinute = sample.latestWorldMinute ?? null;
      status.lastFindingCount = sample.latestFindingCount ?? null;
      if (!verifyOwnership()) return sample;
      status.lastError = null;
      status.reason = null;
      return sample;
    })()
      .catch((error) => {
        status.lastError = safeV6LifecycleObserverError(error);
        status.reason = 'last_sample_failed';
        try { onError(error); } catch {}
        return null;
      })
      .finally(() => {
        inFlight = null;
        if (stopped && activeV6LifecycleObserver === controller) activeV6LifecycleObserver = null;
      });
    return inFlight;
  };
  try {
    timer = schedule(() => { void run(); }, Math.max(60_000, Number(intervalMs) || V6_LIFECYCLE_OBSERVER_INTERVAL_MS));
    if (timer === null || timer === undefined) throw new Error('V6_OBSERVER_SCHEDULER_NOT_REGISTERED');
    timer?.unref?.();
    void run();
  } catch (error) {
    if (timer !== null && timer !== undefined) unschedule(timer);
    timer = null;
    status.available = false;
    status.running = false;
    status.lastError = safeV6LifecycleObserverError(error);
    status.reason = 'scheduler_registration_failed';
    try { onError(error); } catch {}
  }
  return controller;
}

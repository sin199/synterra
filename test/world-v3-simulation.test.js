import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { createFruitflyRuntime } from '../src/agent-runtime/fruitfly.js';
import { initialMind } from '../src/agent-runtime/mind.js';
import { startWorldEngine } from '../src/world-engine.js';
import { economicDashboardSql } from '../src/world-businesses.js';

const databaseUrl = process.env.SYNTERRA_TEST_DATABASE_URL;
const hours = 24 * 30;
const simulationSeeds = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const enabled = process.env.SYNTERRA_TEST_ISOLATED === '1' && Boolean(databaseUrl);
const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function deterministicUuid(seed, label) {
  const bytes = createHash('sha256').update(`synterra-v3.1:${seed}:${label}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  if (!sorted.length) return 0;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function summarize(values) {
  return { median: median(values), min: Math.min(...values), max: Math.max(...values) };
}

function assertIsolatedDatabase(connectionString) {
  const parsed = new URL(connectionString);
  assert.ok(['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname), 'simulation requires loopback PostgreSQL');
  assert.ok(decodeURIComponent(parsed.pathname.slice(1)).endsWith('_test'), 'simulation database name must end in _test');
  assert.notEqual(parsed.port, '5432', 'simulation must not use the default PostgreSQL port');
}

test(`isolated Fruitfly world simulation runs 10 seeded scenarios for ${hours} world hours each`, {
  skip: !enabled,
  timeout: 3_600_000
}, async (t) => {
  assertIsolatedDatabase(databaseUrl);
  const seedSummaries = [];
  for (const seed of simulationSeeds) {
    const openedAt = performance.now();
    const simulationId = `seed-${seed}`;
    const worldId = deterministicUuid(seed, 'world');
    const agentIds = Array.from({ length: 10 }, (_, index) => deterministicUuid(seed, `agent-${index + 1}`));
    const ownerId = agentIds[0];
    const stepSeconds = 30;
    const simulatedMinutes = hours * 60;
    const steps = simulatedMinutes / stepSeconds;
    const baseMs = Date.now() + seed * 60_000;
    let nowMs = baseMs;
    let pool = new Pool({ connectionString: databaseUrl, max: 4 });
    let engine = null;
    let fruitflyDirectory = null;
    const errors = new Map();
    const errorSamples = [];
    try {
      await pool.query(await readFile(path.join(repoRoot, 'schema.sql'), 'utf8'));
      await pool.query('DELETE FROM worlds WHERE id=$1', [worldId]);
      await pool.query('DELETE FROM agents WHERE id=ANY($1::uuid[])', [agentIds]);
    await pool.query(`INSERT INTO agents(id,name,public_key,gender) VALUES ${agentIds.map((_, index) =>
      `($${index * 3 + 1},$${index * 3 + 2},$${index * 3 + 3},'${index % 2 ? 'male' : 'female'}')`).join(',')}`,
    agentIds.flatMap((id, index) => [id, `Simulation ${simulationId.slice(0, 6)} Resident ${String(index + 1).padStart(2, '0')}`, `sim-key-${id}`]));
    await pool.query(`INSERT INTO worlds(id,owner_agent_id,name,chain_id,open) VALUES($1,$2,$3,5042,true)`,
      [worldId, ownerId, `V3 Isolated ${hours}h Simulation`]);

    const places = [
      ['Town Commons', 'commons', 'A shared central commons for resident conversation and coordination.', { x: 0, z: 0 }],
      ['Garden', 'garden', 'A planted garden where residents can rest and notice seasonal changes.', { x: -0.65, z: -0.4 }],
      ['Library', 'library', 'A quiet library for research, study, and careful record keeping.', { x: 0.55, z: -0.65 }],
      ['Cafe', 'cafe', 'A friendly cafe for meals and low-pressure resident conversation.', { x: 0.7, z: 0.4 }],
      ['Workshop', 'workshop', 'A shared workshop for paid work and cooperative projects.', { x: -0.5, z: 0.65 }],
      ['Data Center', 'data_center', 'A shared data center for technical operations and paid shifts.', { x: -0.1, z: -0.8 }]
    ];
    for (const [index, place] of places.entries()) {
      const [name, sceneType, description, position] = place;
      await pool.query(`INSERT INTO world_scenes(world_id,created_by,name,scene_type,description,purpose,capacity,position)
        VALUES($1,$2,$3,$4,$5,$6,8,$7::jsonb)`,
      [worldId, ownerId, name, sceneType, description, `A shared ${sceneType.replaceAll('_', ' ')} in the test world.`,
        JSON.stringify(position)]);
      assert.ok(index >= 0);
    }
    const placeNames = places.map(([name]) => name);
    for (const [index, agentId] of agentIds.entries()) {
      await pool.query(`INSERT INTO world_members(world_id,agent_id,role,energy,food,social,location)
        VALUES($1,$2,$3,100,100,100,$4)`,
      [worldId, agentId, index === 0 ? 'owner' : 'resident', placeNames[index % placeNames.length]]);
      const mind = initialMind((index + seed - 1) % 10 + 1);
      await pool.query(`INSERT INTO agent_minds(world_id,agent_id,archetype,traits,current_goal)
        VALUES($1,$2,$3,$4::jsonb,$5)`,
      [worldId, agentId, mind.archetype, JSON.stringify(mind.traits), mind.currentGoal]);
    }
    await pool.query(`INSERT INTO crypto_market_quotes(symbol,price_usd,quote_version,as_of,source) VALUES
      ('USDC',1,1,$1,'synterra_simulated_market'),('BTC',65000,1,$1,'synterra_simulated_market'),
      ('ETH',2500,1,$1,'synterra_simulated_market')
      ON CONFLICT(symbol) DO UPDATE SET price_usd=EXCLUDED.price_usd,quote_version=EXCLUDED.quote_version,
        as_of=EXCLUDED.as_of,source=EXCLUDED.source`, [new Date(baseMs)]);
    await pool.query(`INSERT INTO world_runtime_state(world_id,tick_count,world_minutes,last_tick_at,typesafe_next_at)
      VALUES($1,0,0,$2,$3)`, [worldId, new Date(baseMs - stepSeconds * 1_000), new Date(baseMs + 24 * 60 * 60 * 1_000)]);

    fruitflyDirectory = await mkdtemp(path.join(os.tmpdir(), `synterra-v31-${seed}-`));
    const fruitfly = await createFruitflyRuntime(fruitflyDirectory);
    engine = await startWorldEngine(pool, { worldId, schedule: false, fruitfly, nowProvider: () => nowMs,
      onError(error, phase) {
        errors.set(phase, (errors.get(phase) || 0) + 1);
        if (errorSamples.length < 5) errorSamples.push({ phase, message: String(error?.message || error).slice(0, 180),
          stack: String(error?.stack || '').split('\n').slice(0, 6).join('\n') });
      } });
    assert.equal(engine.running, true);
    for (let index = 0; index < steps; index += 1) {
      // startWorldEngine's bootstrap tick advances the clock by one minute even
      // with no elapsed time; make the final simulated interval 29 seconds so
      // the complete run still lands on exactly the requested 30-day horizon.
      nowMs += (index === steps - 1 ? stepSeconds - 1 : stepSeconds) * 1_000;
      await engine.tickOnce();
      if (index % 120 === 0) await new Promise((resolve) => setImmediate(resolve));
    }
    await engine.stop();
    engine = null;

    const final = await pool.query(`SELECT
        (SELECT world_minutes FROM world_runtime_state WHERE world_id=$1)::int AS world_minutes,
        (SELECT count(*)::int FROM world_events WHERE world_id=$1 AND event_type='world.action_completed') AS completed_actions,
        (SELECT count(*)::int FROM world_opportunities WHERE world_id=$1) AS opportunities,
        (SELECT count(*)::int FROM world_opportunities WHERE world_id=$1 AND creator_agent_id IS NOT NULL) AS resident_created_opportunities,
        (SELECT count(*)::int FROM world_projects WHERE world_id=$1) AS projects,
        (SELECT count(*)::int FROM world_projects WHERE world_id=$1 AND status='completed') AS completed_projects,
        (SELECT count(*)::int FROM world_projects WHERE world_id=$1 AND status='failed') AS failed_projects,
        (SELECT count(*)::int FROM world_organizations WHERE world_id=$1) AS organizations,
        (SELECT count(*)::int FROM world_scenes WHERE world_id=$1 AND created_by_project_id IS NOT NULL) AS generated_places,
        (SELECT count(*)::int FROM world_information_shares WHERE world_id=$1) AS information_shares,
        (SELECT count(*)::int FROM world_agent_beliefs WHERE world_id=$1 AND subject_type='project' AND belief_key='shared_awareness') AS shared_beliefs,
        (SELECT count(*)::int FROM world_relationships WHERE world_id=$1) AS relationships,
        (SELECT count(*)::int FROM world_agent_skills WHERE world_id=$1) AS skill_records,
        (SELECT count(*)::int FROM world_history WHERE world_id=$1) AS history_records,
        (SELECT count(*)::int FROM world_scenes WHERE world_id=$1 AND status='active') AS active_places`, [worldId]);
    const economy = (await pool.query(economicDashboardSql(), [worldId])).rows[0];
    const economicAudit = await pool.query(`SELECT
        (SELECT count(*)::int FROM world_economic_transactions tx WHERE tx.world_id=$1) AS transactions,
        (SELECT count(*)::int FROM world_economic_transactions tx LEFT JOIN LATERAL (
          SELECT count(*)::int AS postings,COALESCE(sum(posting.amount),0) AS net,
            COALESCE(sum(posting.amount) FILTER (WHERE posting.account_id=tx.source_account_id),0) AS source_amount,
            COALESCE(sum(posting.amount) FILTER (WHERE posting.account_id=tx.destination_account_id),0) AS destination_amount
          FROM world_economic_postings posting WHERE posting.transaction_id=tx.id
        ) posted ON true WHERE tx.world_id=$1 AND (posted.postings<>2 OR posted.net<>0
          OR posted.source_amount<>-tx.amount OR posted.destination_amount<>tx.amount)) AS unbalanced_transactions,
        (SELECT count(*)::int FROM world_economic_accounts WHERE world_id=$1 AND account_type<>'system' AND balance<0) AS negative_accounts,
        (SELECT count(*)::int FROM world_economic_accounts WHERE world_id=$1 AND account_type='system' AND balance<0) AS negative_system_accounts,
        (SELECT count(*)::int FROM world_business_orders order_row
          LEFT JOIN world_economic_transactions tx ON tx.id=order_row.transaction_id
          WHERE order_row.world_id=$1 AND (tx.id IS NULL OR tx.transaction_type<>'business_revenue')) AS unsettled_orders,
        (SELECT count(*)::int FROM world_businesses business WHERE business.world_id=$1) AS businesses,
        (SELECT count(*)::int FROM world_businesses business WHERE business.world_id=$1 AND business.status='active') AS active_businesses,
        (SELECT count(*)::int FROM world_businesses business WHERE business.world_id=$1 AND business.status IN ('closed','bankrupt')) AS closed_businesses,
        (SELECT count(*)::int FROM world_business_jobs job WHERE job.world_id=$1) AS jobs_created,
        (SELECT count(*)::int FROM world_business_employment employment WHERE employment.world_id=$1) AS employment_transitions,
        (SELECT count(*)::int FROM world_business_employment employment WHERE employment.world_id=$1 AND employment.status='active') AS active_employment,
        (SELECT count(*)::int FROM world_business_orders order_row WHERE order_row.world_id=$1 AND order_row.status='fulfilled') AS service_orders,
        (SELECT count(DISTINCT customer_agent_id)::int FROM world_business_orders order_row
          WHERE order_row.world_id=$1 AND order_row.status='fulfilled') AS paying_customers,
        (SELECT count(*)::int FROM world_business_production production WHERE production.world_id=$1) AS production_shifts,
        (SELECT count(*)::int FROM world_business_production production WHERE production.world_id=$1
          AND production.employment_id IS NOT NULL) AS employee_production_shifts,
        (SELECT count(*)::int FROM world_economic_transactions tx WHERE tx.world_id=$1
          AND tx.transaction_type='business_revenue') AS revenue_settlements,
        (SELECT count(*)::int FROM world_economic_transactions tx WHERE tx.world_id=$1
          AND tx.transaction_type='maintenance') AS maintenance_settlements,
        (SELECT count(*)::int FROM world_economic_demand demand WHERE demand.world_id=$1) AS demand_days`, [worldId]);
    const institutionAudit = await pool.query(`SELECT
        (SELECT count(*)::int FROM world_agreements WHERE world_id=$1) AS agreements_total,
        (SELECT count(*)::int FROM world_agreements WHERE world_id=$1 AND status='proposed') AS agreements_proposed,
        (SELECT count(*)::int FROM world_agreements WHERE world_id=$1 AND status='countered') AS agreements_countered,
        (SELECT count(*)::int FROM world_agreements WHERE world_id=$1 AND status='active') AS agreements_active,
        (SELECT count(*)::int FROM world_agreements WHERE world_id=$1 AND status='completed') AS agreements_completed,
        (SELECT count(*)::int FROM world_agreements WHERE world_id=$1 AND status='accepted') AS agreements_accepted,
        (SELECT count(*)::int FROM world_agreements WHERE world_id=$1 AND status='breached') AS agreements_breached,
        (SELECT count(*)::int FROM world_agreements WHERE world_id=$1 AND status='expired') AS agreements_expired,
        (SELECT count(*)::int FROM world_agreements WHERE world_id=$1 AND status='rejected') AS agreements_rejected,
        (SELECT count(*)::int FROM world_agreements WHERE world_id=$1 AND status='cancelled') AS agreements_cancelled,
        (SELECT count(*)::int FROM world_agreements WHERE world_id=$1 AND parent_agreement_id IS NOT NULL) AS counteroffers,
        (SELECT count(*)::int FROM world_agreements WHERE world_id=$1 AND negotiation_round>8) AS rounds_over_limit,
        (SELECT count(*)::int FROM world_commitments WHERE world_id=$1) AS commitments_total,
        (SELECT count(*)::int FROM world_commitments WHERE world_id=$1 AND status='active') AS commitments_active,
        (SELECT count(*)::int FROM world_commitments WHERE world_id=$1 AND status='fulfilled') AS commitments_fulfilled,
        (SELECT count(*)::int FROM world_commitments WHERE world_id=$1 AND status='breached') AS commitments_breached,
        (SELECT count(*)::int FROM world_commitments WHERE world_id=$1 AND status='active' AND due_world_time<=$2) AS overdue_commitments,
        (SELECT count(*)::int FROM world_organization_proposals WHERE world_id=$1) AS governance_total,
        (SELECT count(*)::int FROM world_organization_proposals WHERE world_id=$1 AND status='proposed') AS governance_open,
        (SELECT count(*)::int FROM world_organization_proposals WHERE world_id=$1 AND status='executed') AS governance_executed,
        (SELECT count(*)::int FROM world_organization_proposals WHERE world_id=$1 AND status='rejected') AS governance_rejected,
        (SELECT count(*)::int FROM world_organization_proposals WHERE world_id=$1 AND status='proposed' AND expires_world_time<=$2) AS overdue_proposals,
        (SELECT count(*)::int FROM world_social_norms WHERE world_id=$1) AS norms,
        (SELECT count(*)::int FROM world_agreement_templates WHERE world_id=$1) AS templates,
        (SELECT count(*)::int FROM world_agent_reputations WHERE world_id=$1) AS reputation_records,
        (SELECT count(*)::int FROM world_institutional_memories WHERE world_id=$1) AS institutional_memories,
        (SELECT count(*)::int FROM world_history WHERE world_id=$1 AND event_type='ownership_transferred') AS ownership_transfers,
        (SELECT count(*)::int FROM (SELECT asset_id FROM world_economic_ownership WHERE world_id=$1 AND asset_type='business'
          GROUP BY asset_id HAVING abs(sum(share)-1)>0.000001) unbalanced_ownership) AS unbalanced_business_ownership`,
    [worldId, simulatedMinutes]);
    const purchaseFailureReasons = await pool.query(`SELECT reason_code AS "reasonCode",
        details->>'abandoned' AS abandoned,count(*)::int AS count
      FROM world_emergence_events WHERE world_id=$1 AND system='business' AND stage='blocked'
        AND action='business_service' AND details ? 'abandoned'
      GROUP BY reason_code,details->>'abandoned' ORDER BY count DESC,reason_code`, [worldId]);
    const demand = await pool.query(`SELECT service_type AS "serviceType",sum(demand_count)::int AS demand,
        sum(unmet_count)::int AS unmet FROM world_economic_demand WHERE world_id=$1
      GROUP BY service_type ORDER BY sum(unmet_count) DESC,service_type LIMIT 5`, [worldId]);
    const businessOutcomes = await pool.query(`SELECT business.id AS "businessId",founder.name AS founder,
        business.metadata->>'serviceType' AS "serviceType",business.status,
        business.metadata->>'closedReason' AS "closedReason",
        business.metadata->>'capabilityFit' AS "capabilityFit",
        business.founded_world_time::bigint AS "foundedWorldTime",
        COALESCE((business.metadata->>'closedWorldTime')::bigint,$2::bigint)-business.founded_world_time::bigint AS "lifetimeWorldMinutes",
        business.metadata->'founderSkillProfile' AS "founderSkillsAtFounding",
        COALESCE((SELECT count(*)::int FROM world_business_orders order_row WHERE order_row.world_id=business.world_id
          AND order_row.business_id=business.id AND order_row.status='fulfilled'),0) AS "paidCustomers",
        COALESCE(revenue.usdc,0)::text AS "revenueUsdc",COALESCE(expenses.usdc,0)::text AS "expensesUsdc",
        (COALESCE(revenue.usdc,0)-COALESCE(expenses.usdc,0))::text AS "profitLossUsdc"
      FROM world_businesses business JOIN agents founder ON founder.id=business.founder_agent_id
      LEFT JOIN LATERAL (SELECT sum(tx.amount)::numeric AS usdc FROM world_economic_transactions tx
        JOIN world_business_services service ON service.world_id=tx.world_id
          AND tx.reference_id=service.id::text AND service.business_id=business.id
        WHERE tx.world_id=business.world_id AND tx.transaction_type='business_revenue') revenue ON true
      LEFT JOIN LATERAL (SELECT -sum(posting.amount)::numeric AS usdc FROM world_economic_postings posting
        JOIN world_economic_transactions tx ON tx.id=posting.transaction_id
        JOIN world_economic_accounts account ON account.id=posting.account_id
        WHERE tx.world_id=business.world_id AND account.account_type='business'
          AND account.owner_id=business.id AND posting.amount<0
          AND tx.transaction_type IN ('business_expense','business_wage','maintenance')) expenses ON true
      WHERE business.world_id=$1 ORDER BY business.founded_world_time,business.id`, [worldId, simulatedMinutes]);
    const economicChains = await pool.query(`SELECT business.id AS "businessId",business.name AS "businessName",
        founder.name AS founder,business.founded_world_time AS "foundedWorldTime",
        orders.first_world_time AS "firstCustomerWorldTime",orders.order_count AS "serviceOrders",
        revenue.total_usdc AS "businessRevenueUsdc",revenue.transaction_count AS "revenueSettlements",
        (SELECT count(*)::int FROM agent_memories memory WHERE memory.world_id=business.world_id
          AND memory.agent_id=business.founder_agent_id AND memory.world_minutes>business.founded_world_time
          AND memory.memory_type IN ('business','income','success','failure')) AS "laterEconomicMemories",
        (SELECT count(*)::int FROM world_events event WHERE event.world_id=business.world_id
          AND event.actor_id=business.founder_agent_id AND event.event_type='world.action_completed'
          AND event.data->>'action' LIKE 'business_%'
          AND (event.data->>'worldMinutes')::bigint>orders.first_world_time) AS "laterBusinessActions"
      FROM world_businesses business JOIN agents founder ON founder.id=business.founder_agent_id
      CROSS JOIN LATERAL (SELECT min(order_row.world_time)::int AS first_world_time,count(*)::int AS order_count
        FROM world_business_orders order_row WHERE order_row.world_id=business.world_id
          AND order_row.business_id=business.id AND order_row.status='fulfilled') orders
      CROSS JOIN LATERAL (SELECT COALESCE(sum(tx.amount),0)::text AS total_usdc,count(*)::int AS transaction_count
        FROM world_economic_transactions tx JOIN world_business_services service
          ON tx.reference_id=service.id::text AND service.business_id=business.id
        WHERE tx.world_id=business.world_id AND tx.transaction_type='business_revenue') revenue
      WHERE business.world_id=$1 AND orders.order_count>0
      ORDER BY orders.order_count DESC,business.id LIMIT 3`, [worldId]);
    const actionDistribution = await pool.query(`SELECT data->>'action' AS action,count(*)::int AS count
      FROM world_events WHERE world_id=$1 AND event_type='world.action_completed'
      GROUP BY data->>'action' ORDER BY count(*) DESC,data->>'action'`, [worldId]);
    const businessPrices = await pool.query(`SELECT service.service_type AS "serviceType",
        count(*)::int AS providers,round(avg(service.base_price_usdc),8)::text AS "averageBasePriceUsdc",
        min(service.base_price_usdc)::text AS "minimumBasePriceUsdc",
        max(service.base_price_usdc)::text AS "maximumBasePriceUsdc"
      FROM world_business_services service JOIN world_businesses business
        ON business.world_id=service.world_id AND business.id=service.business_id
      WHERE service.world_id=$1 GROUP BY service.service_type ORDER BY service.service_type`, [worldId]);
    const residentActivity = await pool.query(`SELECT agent.name,count(event.id)::int AS actions,
        count(DISTINCT event.data->>'action')::int AS distinct_actions,
        count(DISTINCT COALESCE(event.data->>'place',event.data->>'to'))::int AS distinct_places
      FROM world_members member JOIN agents agent ON agent.id=member.agent_id
      LEFT JOIN world_events event ON event.world_id=member.world_id AND event.actor_id=member.agent_id
        AND event.event_type='world.action_completed'
      WHERE member.world_id=$1 GROUP BY agent.id,agent.name ORDER BY agent.name`, [worldId]);
    const activeProjectMax = await pool.query(`SELECT COALESCE(max(active_count),0)::int AS max_active_projects_per_resident FROM (
      SELECT member.agent_id,count(project.id)::int AS active_count FROM world_members member
      LEFT JOIN world_project_members membership ON membership.world_id=member.world_id
        AND membership.agent_id=member.agent_id AND membership.status='active'
      LEFT JOIN world_projects project ON project.world_id=membership.world_id AND project.id=membership.project_id
        AND project.status='active'
      WHERE member.world_id=$1 GROUP BY member.agent_id) counts`, [worldId]);
    const duplicatePlaces = await pool.query(`SELECT count(*)::int AS count FROM (
      SELECT created_by_project_id FROM world_scenes WHERE world_id=$1 AND created_by_project_id IS NOT NULL
      GROUP BY created_by_project_id HAVING count(*)>1) duplicates`, [worldId]);
    const emergenceRows = await pool.query(`SELECT system,stage,reason_code AS "reasonCode",action,count(*)::int AS count
      FROM world_emergence_events WHERE world_id=$1 GROUP BY system,stage,reason_code,action
      ORDER BY system,stage,reason_code,action`, [worldId]);
    const emergenceFunnel = emergenceRows.rows;
    const metric = (system, stage) => emergenceFunnel
      .filter((item) => item.system === system && item.stage === stage)
      .reduce((sum, item) => sum + Number(item.count), 0);
    const actionMetric = (system, stage, action) => emergenceFunnel
      .filter((item) => item.system === system && item.stage === stage && item.action === action)
      .reduce((sum, item) => sum + Number(item.count), 0);
    const emergenceMetrics = {
      opportunitiesCreated: metric('opportunity', 'created'),
      opportunityAccepted: metric('opportunity', 'accepted'),
      opportunitiesExpired: metric('opportunity', 'expired'),
      projectProposed: metric('project', 'proposed'),
      projectJoined: metric('project', 'joined'),
      projectsActive: metric('project', 'active'),
      projectsCompleted: metric('project', 'completed'),
      projectsFailed: metric('project', 'failed'),
      projectsAbandoned: metric('project', 'abandoned'),
      organizationsProposed: metric('organization', 'proposed'),
      organizationsFormed: metric('organization', 'formed'),
      organizationsRejected: metric('organization', 'rejected'),
      informationCandidates: actionMetric('information', 'considered', 'information_share'),
      informationShared: metric('information', 'shared'),
      informationAccepted: metric('information', 'accepted'),
      informationIgnored: metric('information', 'ignored'),
      placesProposed: metric('place', 'proposal'),
      placesBuildStarted: metric('place', 'build_started'),
      placesCreated: metric('place', 'created'),
      goalReviews: metric('goal', 'replanned')
    };
    const blockerCounts = emergenceFunnel.filter((item) => item.stage === 'blocked' && item.reasonCode !== 'NONE')
      .map((item) => ({ system: item.system, reasonCode: item.reasonCode, count: Number(item.count) }))
      .sort((left, right) => right.count - left.count || left.system.localeCompare(right.system));
    const summary = { seed, simulationId, worldId, simulatedHours: hours, worldMinutes: final.rows[0].world_minutes,
      elapsedSeconds: Math.round((performance.now() - openedAt) / 1_000), fruitfly: 'local bundled runtime',
      typesafe: 'disabled; no provider/network call', errors: Object.fromEntries(errors), errorSamples,
      state: final.rows[0], economy, economicAudit: economicAudit.rows[0], institutionAudit: institutionAudit.rows[0],
      topDemand: demand.rows,
      purchaseFailureReasons: purchaseFailureReasons.rows,
      businessOutcomes: businessOutcomes.rows, economicChains: economicChains.rows, businessPrices: businessPrices.rows,
      actionDistribution: actionDistribution.rows,
      residentActivity: residentActivity.rows, maxActiveProjectsPerResident: activeProjectMax.rows[0].max_active_projects_per_resident,
      duplicateGeneratedPlaces: duplicatePlaces.rows[0].count, emergenceMetrics, emergenceFunnel, blockerCounts };

    await pool.end();
    pool = new Pool({ connectionString: databaseUrl, max: 2 });
    const afterReconnect = await pool.query(`SELECT
        (SELECT count(*)::int FROM world_projects WHERE world_id=$1) AS projects,
        (SELECT count(*)::int FROM world_organizations WHERE world_id=$1) AS organizations,
        (SELECT count(*)::int FROM world_scenes WHERE world_id=$1 AND created_by_project_id IS NOT NULL) AS generated_places,
        (SELECT count(*)::int FROM world_agreements WHERE world_id=$1) AS agreements,
        (SELECT count(*)::int FROM world_commitments WHERE world_id=$1) AS commitments,
        (SELECT count(*)::int FROM world_social_norms WHERE world_id=$1) AS norms,
        (SELECT count(*)::int FROM world_agreement_templates WHERE world_id=$1) AS templates,
        (SELECT world_minutes::int FROM world_runtime_state WHERE world_id=$1) AS world_minutes`, [worldId]);
    summary.persistenceAfterReconnect = afterReconnect.rows[0];
    seedSummaries.push(summary);
    t.diagnostic(JSON.stringify({ seed, worldMinutes: summary.worldMinutes, engineWorldId: engine?.worldId || worldId,
      completedActions: summary.state.completed_actions, errors: summary.errors, errorSamples: summary.errorSamples,
      institutionAudit: summary.institutionAudit, emergenceMetrics, topBlockers: blockerCounts.slice(0, 5) }));

    assert.equal(summary.state.world_minutes, simulatedMinutes, 'simulation must advance the exact requested world time');
    assert.equal(Object.values(errors).reduce((sum, count) => sum + count, 0), 0, 'simulation should complete without engine errors');
    assert.ok(summary.state.completed_actions > 0, 'residents should make autonomous decisions');
    assert.ok(summary.actionDistribution.length >= 3, 'resident behavior should include multiple action families');
    assert.ok(summary.state.active_places <= 40, 'generated places must remain within the world cap');
    assert.ok(summary.duplicateGeneratedPlaces === 0, 'projects must not create duplicate places');
    assert.equal(Number(summary.persistenceAfterReconnect.world_minutes), simulatedMinutes);
    assert.deepEqual(summary.persistenceAfterReconnect.projects, summary.state.projects);
    assert.deepEqual(summary.persistenceAfterReconnect.organizations, summary.state.organizations);
    assert.deepEqual(summary.persistenceAfterReconnect.generated_places, summary.state.generated_places);
    assert.equal(summary.persistenceAfterReconnect.agreements, Number(summary.institutionAudit.agreements_total),
      'institution history persists across a fresh database connection');
    assert.equal(summary.persistenceAfterReconnect.commitments, Number(summary.institutionAudit.commitments_total),
      'commitment history persists across a fresh database connection');
    assert.equal(summary.persistenceAfterReconnect.norms, Number(summary.institutionAudit.norms));
    assert.equal(summary.persistenceAfterReconnect.templates, Number(summary.institutionAudit.templates));
    assert.ok(summary.residentActivity.every((resident) => resident.actions > 0), 'all residents should remain active');
    assert.equal(Number(summary.economicAudit.unbalanced_transactions), 0, 'every economic transfer must balance');
    assert.equal(Number(summary.economicAudit.negative_accounts), 0, 'no resident or business account may go negative');
    assert.equal(Number(summary.economicAudit.unsettled_orders), 0, 'every fulfilled service order must settle revenue');
    assert.equal(Number(summary.institutionAudit.rounds_over_limit), 0, 'negotiation rounds stay bounded');
    assert.equal(Number(summary.institutionAudit.agreements_total),
      Number(summary.institutionAudit.agreements_proposed) + Number(summary.institutionAudit.agreements_countered)
        + Number(summary.institutionAudit.agreements_active) + Number(summary.institutionAudit.agreements_completed)
        + Number(summary.institutionAudit.agreements_accepted) + Number(summary.institutionAudit.agreements_breached)
        + Number(summary.institutionAudit.agreements_expired) + Number(summary.institutionAudit.agreements_rejected)
        + Number(summary.institutionAudit.agreements_cancelled), 'every agreement remains in a defined lifecycle state');
    assert.equal(Number(summary.institutionAudit.overdue_commitments), 0, 'overdue commitments are resolved during ticks');
    assert.equal(Number(summary.institutionAudit.overdue_proposals), 0, 'expired governance proposals leave the open queue');
    assert.equal(Number(summary.institutionAudit.unbalanced_business_ownership), 0,
      'ownership agreement execution preserves each business share total');
    } finally {
      if (engine) await engine.stop();
      if (pool) {
        await pool.query('DELETE FROM worlds WHERE id=$1', [worldId]).catch(() => {});
        await pool.query('DELETE FROM agents WHERE id=ANY($1::uuid[])', [agentIds]).catch(() => {});
        await pool.end();
      }
      if (fruitflyDirectory) await rm(fruitflyDirectory, { recursive: true, force: true });
    }
  }

  const metricKeys = Object.keys(seedSummaries[0].emergenceMetrics);
  const aggregate = Object.fromEntries(metricKeys.map((key) => [key, summarize(seedSummaries.map((summary) =>
    summary.emergenceMetrics[key]))]));
  const economicMetricKeys = ['businesses','active_businesses','closed_businesses','employment_count','business_revenue',
    'business_expenses','business_profit_loss','investment_volume','usdc_circulation','total_resident_net_worth_usd'];
  const economicAggregate = Object.fromEntries(economicMetricKeys.map((key) => [key, summarize(seedSummaries.map((summary) =>
    Number(summary.economy[key] || 0)))]));
  economicAggregate.jobsCreated = summarize(seedSummaries.map((summary) => Number(summary.economicAudit.jobs_created)));
  economicAggregate.employmentTransitions = summarize(seedSummaries.map((summary) => Number(summary.economicAudit.employment_transitions)));
  economicAggregate.serviceOrders = summarize(seedSummaries.map((summary) => Number(summary.economicAudit.service_orders)));
  economicAggregate.productionShifts = summarize(seedSummaries.map((summary) => Number(summary.economicAudit.production_shifts)));
  economicAggregate.employeeProductionShifts = summarize(seedSummaries.map((summary) =>
    Number(summary.economicAudit.employee_production_shifts)));
  economicAggregate.revenueSettlements = summarize(seedSummaries.map((summary) => Number(summary.economicAudit.revenue_settlements)));
  economicAggregate.maintenanceSettlements = summarize(seedSummaries.map((summary) => Number(summary.economicAudit.maintenance_settlements)));
  economicAggregate.transactions = summarize(seedSummaries.map((summary) => Number(summary.economicAudit.transactions)));
  economicAggregate.negativeSystemSeedAccounts = summarize(seedSummaries.map((summary) =>
    Number(summary.economicAudit.negative_system_accounts)));
  const institutionalMetricKeys = ['agreements_total','agreements_proposed','agreements_countered','agreements_active',
    'agreements_completed','agreements_accepted','agreements_breached','agreements_expired','agreements_rejected',
    'agreements_cancelled','counteroffers','commitments_total','commitments_active','commitments_fulfilled',
    'commitments_breached','governance_total','governance_open','governance_executed','governance_rejected',
    'norms','templates','reputation_records','institutional_memories','ownership_transfers'];
  const institutionalAggregate = Object.fromEntries(institutionalMetricKeys.map((key) => [key, summarize(seedSummaries.map((summary) =>
    Number(summary.institutionAudit[key] || 0)))]));
  const allBusinessOutcomes = seedSummaries.flatMap((summary) => summary.businessOutcomes.map((business) => ({
    seed: summary.seed, ...business
  })));
  economicAggregate.businessesFounded = summarize(seedSummaries.map((summary) => Number(summary.economicAudit.businesses)));
  economicAggregate.activeBusinessesAtDay30 = summarize(seedSummaries.map((summary) =>
    Number(summary.economicAudit.active_businesses)));
  economicAggregate.businessLifetimeDays = summarize(allBusinessOutcomes.map((business) =>
    Number(business.lifetimeWorldMinutes) / 1_440));
  const closureReasons = {};
  const serviceCategories = {};
  for (const business of allBusinessOutcomes) {
    const closureReason = business.closedReason || (['active','inactive'].includes(business.status) ? 'still_operating' : 'unknown');
    closureReasons[closureReason] = (closureReasons[closureReason] || 0) + 1;
    serviceCategories[business.serviceType || 'unknown'] = (serviceCategories[business.serviceType || 'unknown'] || 0) + 1;
  }
  const economicSeedOutcomes = {
    businessesFounded: seedSummaries.filter((summary) => Number(summary.economicAudit.businesses) > 0).length,
    activeBusinesses: seedSummaries.filter((summary) => Number(summary.economicAudit.active_businesses) > 0).length,
    payingCustomers: seedSummaries.filter((summary) => Number(summary.economicAudit.service_orders) > 0).length,
    jobTransitions: seedSummaries.filter((summary) => Number(summary.economicAudit.employment_transitions) > 0).length,
    investment: seedSummaries.filter((summary) => Number(summary.economy.investment_volume) > 0).length,
    businessProfitOrLoss: seedSummaries.filter((summary) => Number(summary.economy.business_profit_loss) !== 0).length
  };
  const perSeedEconomics = seedSummaries.map((summary) => {
    const audit = summary.economicAudit;
    const businesses = summary.businessOutcomes;
    const closureReasonsBySeed = {};
    for (const business of businesses) {
      const reason = business.closedReason || (['active','inactive'].includes(business.status)
        ? 'still_operating' : 'unknown');
      closureReasonsBySeed[reason] = (closureReasonsBySeed[reason] || 0) + 1;
    }
    return { seed: summary.seed, businessesFounded: Number(audit.businesses), paidOrders: Number(audit.service_orders),
      uniquePayingResidents: Number(audit.paying_customers), transactions: Number(audit.transactions),
      employmentTransitions: Number(audit.employment_transitions), employeeProductionShifts: Number(audit.employee_production_shifts),
      investmentsUsdc: summary.economy.investment_volume, closures: Number(audit.closed_businesses),
      activeBusinessesAtDay30: Number(audit.active_businesses),
      averageBusinessLifetimeDays: businesses.length
        ? businesses.reduce((sum, business) => sum + Number(business.lifetimeWorldMinutes) / 1_440, 0) / businesses.length : 0,
      revenueUsdc: summary.economy.business_revenue, expensesUsdc: summary.economy.business_expenses,
      profitLossUsdc: summary.economy.business_profit_loss, residentNetWorthUsdc: summary.economy.total_resident_net_worth_usd,
      negativeSystemAccounts: Number(audit.negative_system_accounts), unbalancedTransactions: Number(audit.unbalanced_transactions),
      servicePrices: summary.businessPrices, serviceShortages: summary.topDemand,
      closureReasons: closureReasonsBySeed, economicChainCount: summary.economicChains.length,
      purchaseFailureReasons: summary.purchaseFailureReasons };
  });
  const observedEconomicChains = seedSummaries.flatMap((summary) => summary.economicChains.map((chain) => ({
    seed: summary.seed, ...chain
  })));
  assert.ok(seedSummaries.some((summary) => Number(summary.economicAudit.employment_transitions) > 0),
    '10 isolated seeds must produce at least one resident application that turns into paid employment');
  assert.ok(seedSummaries.some((summary) => Number(summary.economicAudit.employee_production_shifts) > 0),
    'at least one hired resident must complete a paid service production shift');
  assert.ok(observedEconomicChains.length >= 3,
    `30-day simulations must produce at least three businesses with real paying customers; observed ${observedEconomicChains.length}`);
  for (const chain of observedEconomicChains.slice(0, 3)) {
    assert.ok(Number(chain.serviceOrders) > 0 && Number(chain.revenueSettlements) > 0
      && Number(chain.businessRevenueUsdc) > 0,
    `business ${chain.businessName} must settle customer revenue`);
    assert.ok(Number(chain.laterEconomicMemories) + Number(chain.laterBusinessActions) > 0,
      `business ${chain.businessName} must affect later resident memory or actions`);
  }
  // Count conditional organization/place decisions, but do not require agents to create them just to hit a quota.
  // Deterministic integration tests cover their funded formation and build flows.
  const thresholds = { opportunitiesCreated: 8, projectProposed: 8, informationShared: 5 };
  const seedsWithOutcomes = Object.fromEntries(Object.entries(thresholds).map(([key]) => [key,
    seedSummaries.filter((summary) => summary.emergenceMetrics[key] > 0).length]));
  const commonBlockers = new Map();
  for (const summary of seedSummaries) for (const blocker of summary.blockerCounts) {
    const key = `${blocker.system}:${blocker.reasonCode}`;
    commonBlockers.set(key, (commonBlockers.get(key) || 0) + blocker.count);
  }
  const topBlockers = [...commonBlockers.entries()].map(([key, count]) => ({ key, count }))
    .sort((left, right) => right.count - left.count || left.key.localeCompare(right.key)).slice(0, 12);
  const funnelKeys = new Set(seedSummaries.flatMap((summary) => summary.emergenceFunnel.map((item) =>
    JSON.stringify([item.system, item.stage, item.action]))));
  const funnelAggregate = Object.fromEntries([...funnelKeys].map((key) => {
    const [system, stage, action] = JSON.parse(key);
    const perSeed = seedSummaries.map((summary) => summary.emergenceFunnel
      .filter((item) => item.system === system && item.stage === stage && item.action === action)
      .reduce((sum, item) => sum + Number(item.count), 0));
    return [`${system}.${stage}.${action || 'none'}`, summarize(perSeed)];
  }));
  t.diagnostic(JSON.stringify({ simulation: '10 seeded scenarios x 30 world days', aggregate, economicAggregate, institutionalAggregate,
    economicSeedOutcomes, perSeedEconomics, observedEconomicChains: observedEconomicChains.slice(0, 10), seedsWithOutcomes,
    stochasticOutcomes: {
      organizationsFormedSeeds: seedSummaries.filter((summary) => summary.emergenceMetrics.organizationsFormed > 0).length,
      placesCreatedSeeds: seedSummaries.filter((summary) => summary.emergenceMetrics.placesCreated > 0).length
    },
    closureReasons, serviceCategories, founderSkillProfiles: allBusinessOutcomes.map((business) => ({
      seed: business.seed, founder: business.founder, serviceType: business.serviceType,
      skills: business.founderSkillsAtFounding, capabilityFit: business.capabilityFit,
      status: business.status, paidCustomers: business.paidCustomers,
      revenueUsdc: business.revenueUsdc, expensesUsdc: business.expensesUsdc,
      profitLossUsdc: business.profitLossUsdc
    })),
    funnelAggregate, topBlockers, elapsedSeconds: seedSummaries.reduce((sum, item) => sum + item.elapsedSeconds, 0),
    utilityThresholdRatio: 0.75, fruitflySelection: 'unchanged; selects within Utility-qualified candidate set' }));
  for (const [key, minimumSeeds] of Object.entries(thresholds)) {
    assert.ok(seedsWithOutcomes[key] >= minimumSeeds,
      `${key} must occur in at least ${minimumSeeds}/10 seeds; observed ${seedsWithOutcomes[key]}/10`);
  }
});

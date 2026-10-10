import Fastify from 'fastify';
import { createResidentDetailHandler } from './resident-detail-route.js';
import { Pool } from 'pg';
import { prepareStartupSchema } from './startup-schema.js';
import { createHash, createPublicKey, randomBytes, randomUUID, timingSafeEqual, verify } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { compressJsonOnSend, sendSiteFile, SITE_FONT_FILES } from './static-assets.js';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { chargeMeal, MEAL_COST_UNITS } from './economy.js';
import { payAdultServiceProvider, parseAdultServicePrice, refundAdultServiceFunds, reserveAdultServiceFunds } from './adult-services.js';
import { MESSAGE_TEMPLATES, messageText } from './message-templates.js';
import { parsePositiveUnits } from './units.js';
import { loadState, STATE_DIR } from './agent-runtime/client.js';
import { createFruitflyRuntime } from './agent-runtime/fruitfly.js';
import { chooseCivilizationOption, chooseWithTypeSafe, chooseWorldV7Reflection,
  initializeTypeSafeProvider } from './agent-runtime/typesafe.js';
import { startWorldEngine, worldClock } from './world-engine.js';
import { enrichMapEnvironment } from './world-environment.js';
import { buildWorldLiveness, reportWorldEngineError } from './world-engine-diagnostics.js';
import { arcNetworkConfig } from './arc/config.js';
import { ArcRpcClient } from './arc/rpc.js';
import { enqueueArcAgentEconomicAction } from './arc/agent-economic-action.js';
import { loadConfiguredArcInfrastructureSigner, loadConfiguredArcSigner } from './arc/signer-loader.js';
import { startArcSettlementOutboxWorker } from './arc/settlement-worker.js';
import { startArcGenesisTokenSettlementReconciler } from './arc/genesis-token-settlement-reconciler.js';
import { startArcAgentTokenIssuanceWorker } from './arc/token-issuance-worker.js';
import { startArcReadOnlyObserver } from './arc/observer.js';
import { summarizeArcObserverHealth } from './arc/status.js';
import { createWorldTokenIssuanceIntent, updateWorldTokenIssuanceSpecification,
  respondToWorldTokenIssuance, confirmWorldTokenIssuance, nominateWorldTokenIssuer,
  decideWorldTokenIssuerCandidate, listWorldTokenIssuance,
  decideWorldAgentTokenAcceptance, recordWorldAgentTokenUse, readWorldAgentTokenSummary } from './world-token-issuance.js';
import { AGENT_TOKEN_HUMAN_SUPPLY, AGENT_TOKEN_PILOT_GENERATION,
  AGENT_TOKEN_PILOT_MAX_CREATIONS } from './arc/token-issuance.js';
import { createWorldOpportunity, decideWorldOpportunity, listAvailableOpportunities } from './world-opportunities.js';
import { proposeWorldProject, decideProjectMembership, contributeToProject, listWorldProjects } from './world-projects.js';
import { foundWorldOrganization, inviteWorldOrganization, decideOrganizationMembership,
  contributeOrganizationEffort, listWorldOrganizations } from './world-organizations.js';
import { shareWorldInformation, decideWorldInformationShare, listInformationInbox } from './world-information.js';
import { readEmergenceReport } from './world-emergence.js';
import { createWorldCapabilityProposal, readWorldCapabilitySummary, reviewWorldCapabilityExperiment,
  reviewWorldCapabilityProposal, performWorldCapabilityUse } from './world-capabilities.js';
import { readV6LifecycleObserverState, readWorldV6Lifecycle, startV6LifecycleObserver,
  safeV6LifecycleObserverError, unavailableV6LifecycleObserverStatus } from './world-v6-lifecycle-observer.js';
import { createWorldCommitment, listWorldAgreements, listWorldInstitutionSummary, proposeOrganizationGovernance,
  proposeWorldAgreement, proposeGenesisTokenBusinessInvestment, resolveWorldCommitment,
  respondToWorldAgreement, voteOrganizationProposal } from './world-institutions.js';
import { closeWorldBusiness, distributeWorldBusinessProfit, distributeWorldProjectRevenue,
  economicDashboardSql, foundWorldBusiness, investInWorldBusiness, investInWorldProject, listWorldBusinesses,
  loadWorldBusinessContext, observeWorldBusinessMarket, readEconomicRecoveryMetrics, reopenWorldBusiness,
  purchaseWorldBusinessService, reviewWorldBusinessPrice, completeWorldBusinessShift, applyToWorldBusinessJob,
  decideWorldBusinessApplication, leaveWorldBusinessJob, practiceWorldBusinessCapability,
  withdrawWorldBusinessApplication, publishGenesisTokenServicePrice, publishGenesisTokenJobWage,
  acceptGenesisTokenEmploymentWage } from './world-businesses.js';
import { ensureEconomicAccount, ensureResidentEconomicAccounts, getEconomicAccount } from './economic-ledger.js';
import { isGenesisCurrencyActive, readActiveGenesisTokenAssets, readGenesisBusinessEquity, readGenesisCurrencyActivation,
  readGenesisTokenWalletSnapshots, readSpendableGenesisTokenBalance,
  createArcGenesisTokenSettlementIntent } from './genesis-economy.js';
import { prepareGenesisTokenSettlementAuthorization, readGenesisTokenSettlement,
  recordGenesisTokenSettlementSubmission } from './arc/genesis-token-settlement-api.js';
import { cancelResearchJob, enqueueResearchCapabilityUse, listAgentResearchJobs,
  readResearchWorldStatus } from './research/research-jobs.js';
import { startReaResearchWorker } from './research/research-worker.js';
import { alignWorldValue, createCoordinationMechanism, createEmergentEntity, createGoalPrimitiveProposal, createObservationMethod,
  createPolicyExperiment, createWorldResourceType, decideObservationMethod, decideWorldResourceType, evaluateCoordinationExperiment,
  exposeWorldValue,
  createSelfGeneratedGoal, decideGoalPrimitive,
  createWorldConcept, createWorldEra, createWorldExtensionRequest, createWorldMeaning, createWorldMilestone, decideWorldConcept,
  createWorldPrinciple, createWorldQuestion, createWorldValue, decideEmergentParticipation, decidePolicyExperiment, decideWorldAgentGoal,
  decideWorldQuestion, readWorldV7Summary, recordCoordinationUse, recordWorldResourceTransaction,
  registerWorldAgentResourceHolder, setPreferredCognitionMode,
  startCoordinationExperiment, useObservationMethod, useWorldConcept } from './world-v7.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SITE_ROOT = path.join(ROOT, 'site');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5_000 });
const app = Fastify({ logger: false, bodyLimit: 1_000_000 });
const challenges = new Map();
let worldEngine = { running: false, reason: 'starting' };
let v6LifecycleObserver = null;
let arcObserver = null;
let reaResearchWorker = null;
let arcSigner = null;
let arcInfrastructureSigner = null;
let arcSignerSetupError = null;
let arcSettlementWorker = null;
let arcGenesisTokenSettlementReconciler = null;
let arcAgentTokenIssuanceWorker = null;
let arcSchemaReady = false;
let arcTokenSchemaReady = false;
let arcSetupReason = 'arc_schema_migration_required';
const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 8787);
const ARC_CONFIG = arcNetworkConfig(process.env);
const ARC_RPC_CLIENT = new ArcRpcClient({ config: ARC_CONFIG });
const CHAIN_ID = ARC_CONFIG.chainId;
const MINING_REWARD = Number(process.env.MINING_REWARD_UNITS || 5);
const RUN_COST = Number(process.env.WORLD_RUN_COST_PER_UNIT || 1);

app.decorateRequest('rawBody', null);
app.decorateRequest('agentId', null);
app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (request, body, done) => {
  request.rawBody = body;
  try { done(null, body.length ? JSON.parse(body.toString('utf8')) : {}); }
  catch { done(new Error('Invalid JSON body')); }
});

function fail(reply, status, error, detail) {
  return reply.code(status).send({ error, ...(detail ? { detail } : {}) });
}
function arcPublicStatus() {
  const raw = arcObserver?.getStatus() || {
    available: arcSchemaReady,
    running: false,
    mode: 'read_only',
    sourceOfTruth: 'database_and_arc_chain',
    worldId: worldEngine.worldId || null,
    samplingIntervalMs: null,
    lastSampleAt: null,
    lastSampleWorldMinute: null,
    lastFindingCount: null,
    lastError: null,
    network: { name: ARC_CONFIG.name, chainId: ARC_CONFIG.chainId, explorerUrl: ARC_CONFIG.explorerUrl },
    arcMainnet: { configured: true, chainId: ARC_CONFIG.chainId, rpcHealthy: false,
      latestBlock: null, lastIndexedBlock: null, indexerLag: null, deployerAddress: null,
      treasuryAddress: null, pendingSettlements: 0, failedSettlements: 0, settlementEnabled: false },
    reason: arcSignerSetupError || arcSetupReason
  };
  return summarizeArcObserverHealth(raw, ARC_CONFIG);
}
function logWorldEngineError(error, stage, record) {
  const level = app.log?.level;
  if (!level || level === 'silent' || typeof app.log?.error !== 'function') return false;
  app.log.error({ stage, worldEngine: record }, 'world engine error');
  return true;
}
function validUuid(value) { return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }
function requiredString(value, min, max) { return typeof value === 'string' && value.trim().length >= min && value.trim().length <= max; }
const MIND_ARCHETYPES = new Set(['naturalist','maker','scholar','host','observer']);
const SCENE_TYPES = new Set(['garden','studio','library','cafe','workshop','observatory','commons','data_center']);
function validTraits(value) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    ['curiosity','sociability','craft'].every((key) => Number.isFinite(value[key]) && value[key] >= 0 && value[key] <= 1);
}
function validMindUpdate(value) {
  return value === undefined || (value && typeof value === 'object' && !Array.isArray(value) &&
    requiredString(value.currentGoal, 3, 160));
}
function digest(value) { return createHash('sha256').update(value).digest('hex'); }
function verifySignature(publicKey, message, signature) {
  try {
    const key = createPublicKey({ key: Buffer.from(publicKey, 'base64url'), format: 'der', type: 'spki' });
    return verify(null, Buffer.from(message, 'utf8'), key, Buffer.from(signature, 'base64url'));
  } catch { return false; }
}
function messageForRequest(request, time, nonce) {
  return ['agent-world-v1', request.method.toUpperCase(), request.raw.url, String(time), nonce, digest(request.rawBody || Buffer.alloc(0))].join('\n');
}
function cleanExpiredChallenges() {
  const cutoff = Date.now() - 5 * 60_000;
  for (const [id, challenge] of challenges) if (challenge.createdAt < cutoff) challenges.delete(id);
}
async function transaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const value = await fn(client);
    await client.query('COMMIT');
    return value;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}
function requireActionId(body) {
  if (!requiredString(body?.actionId, 8, 80)) throw Object.assign(new Error('actionId must be 8-80 characters'), { statusCode: 400 });
  return body.actionId;
}

async function runWorldV7Action(request, reply, operation) {
  const { worldId } = request.params;
  if (!validUuid(worldId)) return fail(reply, 400, 'WORLD_ID_INVALID');
  if (Object.entries(request.params).some(([key, value]) => key !== 'worldId' && key.endsWith('Id') && !validUuid(value))) {
    return fail(reply, 400, 'WORLD_ENTITY_ID_INVALID');
  }
  const body = request.body || {};
  const actionId = requireActionId(body);
  const result = await transaction(async (client) => {
    await assertMember(client, worldId, request.agentId, true);
    const worldMinute = await readWorldMinutes(client, worldId);
    return operation(client, { ...body, worldId, agentId: request.agentId, worldMinute, actionId });
  });
  return reply.code(result?.id ? 201 : 200).send({ result });
}

async function readWorldMinutes(client, worldId) {
  const result = await client.query('SELECT world_minutes FROM world_runtime_state WHERE world_id=$1', [worldId]);
  return Number(result.rows[0]?.world_minutes) || 0;
}

async function readResidentInitiativeFacts(client, worldId, agentId) {
  const result = await client.query(`SELECT member.energy,member.food,
      COALESCE((SELECT jsonb_object_agg(skill_name,skill_value) FROM world_agent_skills skill
        WHERE skill.world_id=member.world_id AND skill.agent_id=member.agent_id),'{}'::jsonb) AS skills,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('goalType',goal.goal_type,'category',goal.category,
        'status',goal.status,'priority',goal.priority)) FROM world_agent_goals goal
        WHERE goal.world_id=member.world_id AND goal.agent_id=member.agent_id AND goal.status='active'),'[]'::jsonb) AS goals
    FROM world_members member WHERE member.world_id=$1 AND member.agent_id=$2`, [worldId, agentId]);
  if (!result.rowCount) throw Object.assign(new Error('AGENT_NOT_IN_WORLD'), { statusCode: 403 });
  return result.rows[0];
}

async function updateAgentMind(client, worldId, agentId, currentGoal, kind, summary) {
  const previousMind = await client.query('SELECT archetype,traits,memories FROM agent_minds WHERE world_id=$1 AND agent_id=$2 FOR UPDATE', [worldId, agentId]);
  const oldMemories = Array.isArray(previousMind.rows[0]?.memories) ? previousMind.rows[0].memories : [];
  const memories = [...oldMemories, { kind, summary, at: new Date().toISOString() }].slice(-24);
  const archetype = previousMind.rows[0]?.archetype || 'observer';
  const traits = previousMind.rows[0]?.traits || { curiosity: 0.6, sociability: 0.5, craft: 0.5 };
  await client.query(`INSERT INTO agent_minds(world_id,agent_id,archetype,traits,current_goal,memories,actions_taken)
    VALUES($1,$2,$3,$4,$5,$6,1)
    ON CONFLICT(world_id,agent_id) DO UPDATE SET current_goal=EXCLUDED.current_goal,memories=EXCLUDED.memories,
      actions_taken=agent_minds.actions_taken+1,updated_at=now()`,
  [worldId, agentId, archetype, JSON.stringify(traits), currentGoal, JSON.stringify(memories)]);
}

app.addHook('preHandler', async (request, reply) => {
  const pathOnly = request.raw.url?.split('?')[0] || '';
  const localResidentDetail = /^\/local\/map-data\/residents\/[^/]+$/.test(pathOnly)
    && ['127.0.0.1', '::1', 'localhost'].includes(HOST);
  const localResearchStatus = pathOnly === '/local/research-status'
    && ['127.0.0.1', '::1', 'localhost'].includes(HOST);
  if (pathOnly === '/' || pathOnly === '/styles.css' || pathOnly === '/app.js' || pathOnly === '/world3d.js' ||
      pathOnly === '/vendor/three.module.min.js' || pathOnly === '/v6-observer-status.js' || pathOnly === '/og.jpg' || pathOnly.startsWith('/fonts/') || pathOnly === '/public/stats' ||
      pathOnly === '/local/map-data' || localResidentDetail || localResearchStatus || pathOnly === '/health'
      || pathOnly === '/v1/agents/challenges' || pathOnly === '/v1/agents') return;

  const agentId = request.headers['x-agent-id'];
  const time = Number(request.headers['x-agent-time']);
  const nonce = request.headers['x-agent-nonce'];
  const signature = request.headers['x-agent-signature'];
  if (!validUuid(agentId) || !Number.isFinite(time) || Math.abs(Date.now() - time) > 5 * 60_000 ||
      typeof nonce !== 'string' || nonce.length < 16 || nonce.length > 128 || typeof signature !== 'string') {
    return fail(reply, 401, 'AUTH_HEADERS_INVALID');
  }
  const result = await pool.query('SELECT public_key FROM agents WHERE id=$1', [agentId]);
  if (!result.rowCount || !verifySignature(result.rows[0].public_key, messageForRequest(request, time, nonce), signature)) {
    return fail(reply, 401, 'SIGNATURE_INVALID');
  }
  try {
    await pool.query('INSERT INTO auth_nonces(agent_id, nonce) VALUES ($1,$2)', [agentId, nonce]);
  } catch (error) {
    if (error.code === '23505') return fail(reply, 409, 'NONCE_REUSED');
    throw error;
  }
  request.agentId = agentId;
});

app.setErrorHandler((error, request, reply) => {
  if (reply.sent) return;
  const status = error.statusCode || 500;
  if (status >= 500) request.log.error({ err: error }, 'request failed');
  return fail(reply, status, status >= 500 ? 'INTERNAL_ERROR' : (error.message || 'REQUEST_FAILED'));
});

const JS_TYPE = 'text/javascript; charset=utf-8';
app.get('/', (request, reply) => sendSiteFile(request, reply, SITE_ROOT, 'index.html', { type: 'text/html; charset=utf-8' }));
app.get('/styles.css', (request, reply) => sendSiteFile(request, reply, SITE_ROOT, 'styles.css', { type: 'text/css; charset=utf-8' }));
app.get('/app.js', (request, reply) => sendSiteFile(request, reply, SITE_ROOT, 'app.js', { type: JS_TYPE }));
app.get('/world3d.js', (request, reply) => sendSiteFile(request, reply, SITE_ROOT, 'world3d.js', { type: JS_TYPE }));
app.get('/v6-observer-status.js', (request, reply) => sendSiteFile(request, reply, SITE_ROOT, 'v6-observer-status.js', { type: JS_TYPE }));
app.get('/vendor/three.module.min.js', (request, reply) => sendSiteFile(request, reply, SITE_ROOT, path.join('vendor', 'three.module.min.js'),
  { type: JS_TYPE, cacheControl: 'public, max-age=86400' }));
app.get('/og.jpg', (request, reply) => sendSiteFile(request, reply, SITE_ROOT, 'og.jpg', { type: 'image/jpeg', cacheControl: 'public, max-age=86400' }));
app.get('/fonts/:file', (request, reply) => {
  if (!SITE_FONT_FILES.has(request.params.file)) return fail(reply, 404, 'NOT_FOUND');
  return sendSiteFile(request, reply, SITE_ROOT, path.join('fonts', request.params.file),
    { type: 'font/woff2', cacheControl: 'public, max-age=31536000, immutable' });
});
app.addHook('onSend', compressJsonOnSend);

async function readV6LifecycleObserverRuntimeStatus(snapshot, worldId = worldEngine.worldId || null) {
  if (v6LifecycleObserver?.worldId === worldId) return v6LifecycleObserver.getStatus();
  let savedSnapshot = snapshot;
  let lastError = null;
  if (savedSnapshot === undefined) {
    try { savedSnapshot = await readV6LifecycleObserverState(path.join(STATE_DIR, 'v6-observations'), worldId); }
    catch (error) { lastError = safeV6LifecycleObserverError(error); }
  }
  const reason = !worldEngine.running
    ? worldEngine.reason === 'starting' ? 'world_engine_starting' : 'world_engine_not_running'
    : !worldEngine.worldLockOwned ? 'world_lock_not_owned'
      : v6LifecycleObserver ? 'observer_world_mismatch' : 'observer_not_registered';
  return unavailableV6LifecycleObserverStatus({ worldId, snapshot: savedSnapshot, reason, lastError });
}

app.get('/health', async () => {
  const engine = worldEngine.getLiveness?.() || { running: worldEngine.running,
    worldId: worldEngine.worldId || null, worldLockOwned: Boolean(worldEngine.worldLockOwned), schedulerRunning: false };
  try {
    const result = await pool.query({
      text: `SELECT now() AS database_time,w.id AS world_id,rs.world_minutes,rs.tick_count,rs.last_tick_at
        FROM worlds w LEFT JOIN world_runtime_state rs ON rs.world_id=w.id
        WHERE w.open=true AND ($1::uuid IS NULL OR w.id=$1)
        ORDER BY w.created_at DESC LIMIT 1`,
      values: [worldEngine.worldId || null],
      query_timeout: 5_000
    });
    const row = result.rows[0] || null;
    const observerStatus = await readV6LifecycleObserverRuntimeStatus();
    const arcObserverStatus = arcPublicStatus();
    return { service: 'synterra', chainId: CHAIN_ID,
      ...buildWorldLiveness({ databaseHealthy: true, runtime: row,
        engine, checkedAt: row?.database_time || new Date() }),
      v6LifecycleObserver: observerStatus,
      arcMainnet: arcObserverStatus.arcMainnet,
      arcNetwork: arcObserverStatus.arcNetwork,
      arcObserver: arcObserverStatus,
      arcSettlementWorker: arcSettlementWorker?.getStatus() || { available: true, running: false,
        mode: 'mainnet_write_gated', providerName: arcSigner?.providerName || null,
        reason: arcSignerSetupError || 'mainnet_write_gate_closed' },
      arcGenesisTokenSettlementReconciler: arcGenesisTokenSettlementReconciler?.getStatus() || {
        available: arcTokenSchemaReady, running: false, mode: 'read_only_reconciliation',
        reason: arcTokenSchemaReady ? 'worker_not_registered' : 'genesis_economy_migration_required' },
      arcAgentTokenIssuanceWorker: arcAgentTokenIssuanceWorker?.getStatus() || {
        available: arcTokenSchemaReady, running: false, mode: 'read_only_reconciliation',
        writesEnabled: false, reason: arcTokenSchemaReady ? 'worker_not_registered' : 'arc_token_issuance_migration_required' },
      reaResearch: reaResearchWorker?.getStatus() || { available: false, running: false,
        mode: 'asynchronous_research', reason: 'research_worker_not_registered' } };
  } catch {
    const observerStatus = await readV6LifecycleObserverRuntimeStatus();
    const arcObserverStatus = arcPublicStatus();
    return { service: 'synterra', chainId: CHAIN_ID,
      ...buildWorldLiveness({ databaseHealthy: false, runtime: null, engine, checkedAt: new Date() }),
      v6LifecycleObserver: observerStatus,
      arcMainnet: arcObserverStatus.arcMainnet,
      arcNetwork: arcObserverStatus.arcNetwork,
      arcObserver: arcObserverStatus,
      arcSettlementWorker: arcSettlementWorker?.getStatus() || { available: true, running: false,
        mode: 'mainnet_write_gated', providerName: arcSigner?.providerName || null,
        reason: arcSignerSetupError || 'mainnet_write_gate_closed' },
      arcGenesisTokenSettlementReconciler: arcGenesisTokenSettlementReconciler?.getStatus() || {
        available: arcTokenSchemaReady, running: false, mode: 'read_only_reconciliation',
        reason: arcTokenSchemaReady ? 'worker_not_registered' : 'genesis_economy_migration_required' },
      arcAgentTokenIssuanceWorker: arcAgentTokenIssuanceWorker?.getStatus() || {
        available: arcTokenSchemaReady, running: false, mode: 'read_only_reconciliation',
        writesEnabled: false, reason: arcTokenSchemaReady ? 'worker_not_registered' : 'arc_token_issuance_migration_required' },
      reaResearch: reaResearchWorker?.getStatus() || { available: false, running: false,
        mode: 'asynchronous_research', reason: 'research_worker_not_registered' } };
  }
});

app.get('/public/stats', async (_request, reply) => {
  reply.header('Cache-Control', 'public, max-age=30');
  const [worlds, residents] = await Promise.all([
    pool.query('SELECT count(*)::int AS count FROM worlds WHERE open=true'),
    pool.query('SELECT count(*)::int AS count FROM world_members m JOIN worlds w ON w.id=m.world_id WHERE w.open=true')
  ]);
  const mines = await pool.query(`SELECT count(*) FILTER (WHERE status='active')::int AS active,
      COALESCE(sum(extracted_units),0)::text AS extracted_units
    FROM world_mines m JOIN worlds w ON w.id=m.world_id WHERE w.open=true`);
  return { openWorlds: worlds.rows[0].count, residents: residents.rows[0].count, chainId: CHAIN_ID,
    activeMines: mines.rows[0].active, extractedUnits: mines.rows[0].extracted_units };
});

app.get('/local/map-data', async (_request, reply) => {
  if (!['127.0.0.1', '::1', 'localhost'].includes(HOST)) return fail(reply, 403, 'LOCAL_DASHBOARD_ONLY');
  reply.header('Cache-Control', 'no-store');
  const world = await pool.query(`SELECT id,name,created_at AS "createdAt"
    FROM worlds WHERE open=true ORDER BY created_at DESC LIMIT 1`);
  if (!world.rowCount) return { world: null, scenes: [], residents: [], events: [], dataCenterLogs: [], generatedAt: new Date().toISOString() };
  const worldId = world.rows[0].id;
  const genesisCurrency = await readGenesisCurrencyActivation(pool, worldId);
  const [scenes, residents, events, dataCenterLogs, clock] = await Promise.all([
    pool.query(`SELECT s.id,s.name,s.scene_type AS "sceneType",s.status,s.description,s.purpose,s.capacity,s.features,s.position,
      s.created_world_minutes AS "createdWorldTime",s.created_by_project_id AS "createdByProjectId",
      s.created_by_organization_id AS "createdByOrganizationId",s.created_at AS "createdAt",
      (SELECT count(*)::int FROM world_members m WHERE m.world_id=s.world_id AND m.location=s.name) AS "residentCount"
      FROM world_scenes s WHERE s.world_id=$1 ORDER BY s.created_at,s.id`, [worldId]),
    pool.query(`SELECT a.id,a.name,a.gender,m.energy,m.food,m.social,m.location,
        coalesce(ws.happiness,60) AS happiness,coalesce(ws.knowledge,20) AS knowledge,
        coalesce(ws.goal,'balanced') AS goal,ws.risk_tolerance::text AS "riskTolerance",
        coalesce(ws.status,'idle') AS "currentStatus",
        CASE WHEN ws.planned_action IN ('trade','trade_crypto','trade_meme','trade_hold') THEN NULL
          ELSE ws.planned_action END AS "currentAction",
        coalesce(ws.hygiene,80) AS hygiene,coalesce(ws.fun,70) AS fun,ws.activity_variant AS "activityVariant",
        ws.target_location AS "targetLocation",ws.movement_started_at AS "movementStartedAt",
        ws.movement_ends_at AS "movementEndsAt",ws.action_started_at AS "actionStartedAt",ws.action_ends_at AS "actionEndsAt",
        am.archetype,am.current_goal AS "currentGoal",am.actions_taken AS "actionsTaken",am.updated_at AS "mindUpdatedAt",
        COALESCE((SELECT g.category FROM world_agent_goals g WHERE g.world_id=m.world_id AND g.agent_id=m.agent_id
          AND g.goal_type='primary' AND g.status='active' ORDER BY g.priority DESC,g.id LIMIT 1),sp.primary_goal) AS "primaryGoal",
        COALESCE((SELECT g.progress::text FROM world_agent_goals g WHERE g.world_id=m.world_id AND g.agent_id=m.agent_id
          AND g.goal_type='primary' AND g.status='active' ORDER BY g.priority DESC,g.id LIMIT 1),sp.goal_progress::text) AS "goalProgress",
        sp.dominant_role AS "dominantRole",sp.personality_modifiers AS "personalityModifiers",
        sp.risk_modifier::text AS "riskModifier",sp.price_sensitivity::text AS "priceSensitivity",
        (SELECT g.description FROM world_agent_goals g WHERE g.world_id=m.world_id AND g.agent_id=m.agent_id
          AND g.goal_type='short' AND g.status='active' ORDER BY g.priority DESC,g.updated_world_minutes DESC LIMIT 1) AS "shortGoal",
        sp.sociability::text AS sociability,sp.curiosity::text AS curiosity,sp.discipline::text AS discipline,sp.ambition::text AS ambition,
        COALESCE((SELECT jsonb_object_agg(skill_name,skill_value) FROM world_agent_skills sk
          WHERE sk.world_id=m.world_id AND sk.agent_id=m.agent_id),'{}'::jsonb) AS skills,
        COALESCE((SELECT jsonb_agg(jsonb_build_object('otherAgentId',recent.other_id,'name',recent.other_name,
            'familiarity',recent.familiarity,'trust',recent.trust,'affinity',recent.affinity,
            'interactionCount',recent.interaction_count) ORDER BY recent.familiarity DESC,recent.interaction_count DESC)
          FROM (SELECT CASE WHEN rel.agent_a_id=m.agent_id THEN rel.agent_b_id ELSE rel.agent_a_id END AS other_id,
              other.name AS other_name,rel.familiarity,rel.trust,rel.affinity,rel.interaction_count
            FROM world_relationships rel JOIN agents other ON other.id=CASE WHEN rel.agent_a_id=m.agent_id THEN rel.agent_b_id ELSE rel.agent_a_id END
            WHERE rel.world_id=m.world_id AND (rel.agent_a_id=m.agent_id OR rel.agent_b_id=m.agent_id)
            ORDER BY rel.familiarity DESC,rel.interaction_count DESC LIMIT 10) recent),'[]'::jsonb) AS "relationshipSummary",
        recent.event_type AS "lastEventType",recent.action AS "lastEventAction",recent.created_at AS "lastEventAt",recent.place AS "lastEventPlace"
      FROM world_members m JOIN agents a ON a.id=m.agent_id
      LEFT JOIN world_agent_states ws ON ws.world_id=m.world_id AND ws.agent_id=m.agent_id
      LEFT JOIN agent_minds am ON am.world_id=m.world_id AND am.agent_id=m.agent_id
      LEFT JOIN world_social_profiles sp ON sp.world_id=m.world_id AND sp.agent_id=m.agent_id
      LEFT JOIN LATERAL (
        SELECT e.event_type,e.created_at,coalesce(e.data->>'place',e.data->>'to') AS place,e.data->>'action' AS action
        FROM world_events e WHERE e.world_id=m.world_id AND e.actor_id=m.agent_id
          AND (e.event_type LIKE 'action.%' OR e.event_type LIKE 'world.%')
          AND COALESCE(e.data->>'action','') NOT IN ('trade','trade_crypto','trade_meme','trade_hold')
        ORDER BY e.id DESC LIMIT 1
      ) recent ON true
      WHERE m.world_id=$1 ORDER BY m.joined_at,a.name`, [worldId]),
    pool.query(`SELECT a.name AS "agentName",e.event_type AS "eventType",coalesce(e.data->>'place',e.data->>'to') AS place,
        e.data->>'action' AS action,e.created_at AS "createdAt",
        e.data->>'variant' AS variant,e.data->>'weather' AS weather
      FROM world_events e JOIN agents a ON a.id=e.actor_id
      WHERE e.world_id=$1 AND (e.event_type LIKE 'action.%' OR e.event_type='scene.created' OR e.event_type LIKE 'world.%')
        AND e.event_type NOT LIKE 'crypto.%'
        AND COALESCE(e.data->>'action','') NOT IN ('trade','trade_crypto','trade_meme','trade_hold')
      ORDER BY e.id DESC LIMIT 24`, [worldId]),
    pool.query(`SELECT a.name AS "agentName",e.event_type AS "eventType",coalesce(e.data->>'place',e.data->>'to') AS place,
        e.data->>'action' AS action,e.created_at AS "createdAt",
        e.data->>'variant' AS variant,e.data->>'weather' AS weather
      FROM world_events e JOIN agents a ON a.id=e.actor_id
      WHERE e.world_id=$1 AND (e.event_type LIKE 'action.%' OR e.event_type='scene.created' OR e.event_type LIKE 'world.%')
        AND e.event_type NOT LIKE 'crypto.%'
        AND COALESCE(e.data->>'action','') NOT IN ('trade','trade_crypto','trade_meme','trade_hold')
      ORDER BY e.id DESC LIMIT 100`, [worldId]),
    worldClock(pool, worldId, worldEngine.running)
  ]);
  const worldMinutes = Number(clock?.worldMinutes) || 0;
  const environment = enrichMapEnvironment({ worldSeed: worldId, worldMinutes, scenes: scenes.rows,
    residents: residents.rows, events: [...events.rows, ...dataCenterLogs.rows] });
  const emergence = await readEmergenceReport(pool, { worldId, worldMinutes });
  const recoveryMetrics = genesisCurrency ? null : await readEconomicRecoveryMetrics(pool, { worldId, worldMinutes });
  const [economyDashboard, businesses, economicDemand, economyHistory] = await Promise.all([
    genesisCurrency ? Promise.resolve({ rows: [{}] }) : pool.query(economicDashboardSql(), [worldId]),
    listWorldBusinesses(pool, { worldId, limit: 12 }),
    pool.query(`SELECT service_type AS "serviceType",demand_count AS "demandCount",
        supply_count AS "supplyCount",unmet_count AS "unmetCount"
      FROM world_economic_demand WHERE world_id=$1 AND world_day=$2
      ORDER BY unmet_count DESC,demand_count DESC,service_type LIMIT 8`,
    [worldId, Math.floor(worldMinutes / 1_440)]),
    pool.query(`SELECT event_type AS "eventType",world_time AS "worldTime",title,detail,metadata
      FROM world_history WHERE world_id=$1 AND (event_type LIKE 'business_%'
        OR event_type IN ('project_invested','project_revenue','place_maintenance'))
      ORDER BY world_time DESC,id DESC LIMIT 8`, [worldId])
  ]);
  const [counts, opportunities, projects, organizations, history, internalUnits] = await Promise.all([
    pool.query(`SELECT
        (SELECT count(*)::int FROM world_members WHERE world_id=$1) AS residents,
        (SELECT count(*)::int FROM world_scenes WHERE world_id=$1 AND status='active') AS places,
        (SELECT count(*)::int FROM world_organizations WHERE world_id=$1 AND status IN ('forming','active')) AS organizations,
        (SELECT count(*)::int FROM world_projects WHERE world_id=$1 AND status IN ('idea','proposed','recruiting','active')) AS "activeProjects",
        (SELECT count(*)::int FROM world_projects WHERE world_id=$1 AND status='completed') AS "completedProjects",
        (SELECT count(*)::int FROM world_opportunities WHERE world_id=$1 AND status IN ('open','active')
          AND (expires_world_time IS NULL OR expires_world_time>$2)) AS "activeOpportunities"`, [worldId, worldMinutes]),
    pool.query(`SELECT opportunity.id,opportunity.opportunity_type AS type,opportunity.title,opportunity.description,
        opportunity.status,opportunity.created_world_time AS "createdWorldTime",opportunity.expires_world_time AS "expiresWorldTime",
        opportunity.capacity,count(participant.agent_id) FILTER (WHERE participant.status='accepted')::int AS "acceptedCount",
        scene.name AS "sceneName"
      FROM world_opportunities opportunity LEFT JOIN world_scenes scene
        ON scene.world_id=opportunity.world_id AND scene.id=opportunity.scene_id
      LEFT JOIN world_opportunity_participants participant ON participant.world_id=opportunity.world_id
        AND participant.opportunity_id=opportunity.id
      WHERE opportunity.world_id=$1 AND opportunity.status IN ('open','active')
        AND (opportunity.expires_world_time IS NULL OR opportunity.expires_world_time>$2)
      GROUP BY opportunity.id,scene.name ORDER BY opportunity.created_world_time DESC,opportunity.id LIMIT 8`,
    [worldId, worldMinutes]),
    listWorldProjects(pool, { worldId, statuses: ['idea','proposed','recruiting','active','completed','failed'], limit: 8 }),
    listWorldOrganizations(pool, { worldId, statuses: ['forming','active','dormant'], limit: 6 }),
    pool.query(`SELECT id,event_type AS "eventType",entity_type AS "entityType",entity_id AS "entityId",
        world_time AS "worldTime",title,detail,metadata
      FROM world_history WHERE world_id=$1 ORDER BY world_time DESC,id DESC LIMIT 8`, [worldId]),
    genesisCurrency ? Promise.resolve({ rows: [{ units: null }] })
      : pool.query('SELECT COALESCE(sum(amount),0)::text AS units FROM token_ledger WHERE world_id=$1', [worldId])
  ]);
  const institutions = await listWorldInstitutionSummary(pool, { worldId, limit: 10 });
  const capabilities = await readWorldCapabilitySummary(pool, { worldId, limit: 30 });
  const v7 = await readWorldV7Summary(pool, { worldId, limit: 12 });
  const v6Lifecycle = await readWorldV6Lifecycle(pool, { worldId, worldMinute: worldMinutes });
  /* SLIM_V6 */ if (Array.isArray(v6Lifecycle?.proposalFunnel)) v6Lifecycle.proposalFunnel = v6Lifecycle.proposalFunnel.map(({ decisionEvents, proposals, ...rest }) => ({ ...rest, decisionEventCount: decisionEvents?.length || 0, proposals: (proposals || []).map((p) => ({ id: p.id })) }));
  const v6LifecycleObserverStatus = await readV6LifecycleObserverRuntimeStatus(undefined, worldId);
  const publicArcObserverStatus = arcPublicStatus();
  const agentTokenIssuance = arcTokenSchemaReady
    ? { available: true, ...await readWorldAgentTokenSummary(pool, { worldId }),
      intents: await listWorldTokenIssuance(pool, { worldId, limit: 12 }) }
    : { available: false, reason: 'arc_token_issuance_migration_required', counts: null,
      tokens: [], intents: [], createdTokenCount: 0 };
  agentTokenIssuance.mode = 'agent_decided';
  agentTokenIssuance.writesEnabled = ARC_CONFIG.writesEnabled;
  agentTokenIssuance.fixedHumanSupply = AGENT_TOKEN_HUMAN_SUPPLY;
  agentTokenIssuance.currentPilotLimit = AGENT_TOKEN_PILOT_MAX_CREATIONS;
  agentTokenIssuance.pilotGeneration = AGENT_TOKEN_PILOT_GENERATION;
  const tokenWalletSnapshot = genesisCurrency ? await readGenesisTokenWalletSnapshots(pool, { worldId }) : null;
  const dashboard = genesisCurrency
    ? { ...counts.rows[0], worldMinutes, worldAgeHours: Math.round(worldMinutes / 60),
      worldAgeDays: Math.floor(worldMinutes / 1_440) + 1,
      currencyEra: 'genesis_token', legacySimulatedEconomy: 'historical_only' }
    : { ...counts.rows[0], worldMinutes, worldAgeHours: Math.round(worldMinutes / 60),
      worldAgeDays: Math.floor(worldMinutes / 1_440) + 1,
      totalSimulatedWealthUsd: Number(economyDashboard.rows[0]?.total_resident_net_worth_usd || 0).toFixed(2),
      totalInternalUnits: internalUnits.rows[0].units };
  const worldEvolution = { dashboard, opportunities: opportunities.rows, projects,
    organizations, institutions, capabilities, v6Lifecycle, v6LifecycleObserver: v6LifecycleObserverStatus,
    arcMainnet: publicArcObserverStatus.arcMainnet,
    arcObserver: publicArcObserverStatus,
    arcSettlementWorker: arcSettlementWorker?.getStatus() || { available: true, running: false,
      mode: 'mainnet_write_gated', providerName: arcSigner?.providerName || null,
      reason: arcSignerSetupError || 'mainnet_write_gate_closed' },
    arcAgentTokenIssuanceWorker: arcAgentTokenIssuanceWorker?.getStatus() || {
      available: arcTokenSchemaReady, running: false, mode: 'read_only_reconciliation',
      writesEnabled: false, reason: arcTokenSchemaReady ? 'worker_not_registered' : 'arc_token_issuance_migration_required' },
    agentTokenIssuance: { ...agentTokenIssuance,
      worker: arcAgentTokenIssuanceWorker?.getStatus() || { available: arcTokenSchemaReady,
        running: false, mode: 'read_only_reconciliation', writesEnabled: false,
        reason: arcTokenSchemaReady ? 'worker_not_registered' : 'arc_token_issuance_migration_required' } },
    v7, history: history.rows };
  worldEvolution.economy = genesisCurrency
    ? { era: 'genesis_token', currency: { tokenId: genesisCurrency.tokenId,
      tokenAddress: genesisCurrency.tokenAddress, name: genesisCurrency.name,
      symbol: genesisCurrency.symbol, decimals: Number(genesisCurrency.decimals),
      chainId: Number(genesisCurrency.chainId), ownershipAuthority: 'arc_chain' },
      wallets: tokenWalletSnapshot?.wallets || [], businesses, demand: economicDemand.rows,
      historicalEconomy: 'preserved_read_only', settlement: 'agent_wallet_authorized_arc_outbox',
      mainnetWriteGate: ARC_CONFIG.writesEnabled }
    : { dashboard: economyDashboard.rows[0] || {}, businesses,
      demand: economicDemand.rows, history: economyHistory.rows, recovery: recoveryMetrics,
      settlement: 'simulated_internal_ledger', chainSettlementEnabled: false };
  worldEvolution.emergence = emergence;
  return { world: { ...world.rows[0], engine: clock || { running: false }, environment }, scenes: scenes.rows,
    residents: residents.rows, events: events.rows, dataCenterLogs: dataCenterLogs.rows,
    worldEvolution, generatedAt: new Date().toISOString() };
});

app.get('/local/map-data/residents/:agentId', createResidentDetailHandler({ pool, host: HOST, validUuid, fail }));

app.post('/v1/agents/challenges', async () => {
  cleanExpiredChallenges();
  const challengeId = randomUUID();
  const nonce = randomBytes(32).toString('base64url');
  challenges.set(challengeId, { nonce, createdAt: Date.now() });
  return { challengeId, nonce, expiresInSeconds: 300 };
});

app.post('/v1/agents', async (request, reply) => {
  const { name, publicKey, challengeId, signature } = request.body || {};
  if (!requiredString(name, 2, 48) || !requiredString(publicKey, 40, 160) || !validUuid(challengeId) || typeof signature !== 'string') {
    return fail(reply, 400, 'REGISTRATION_FIELDS_INVALID');
  }
  const challenge = challenges.get(challengeId);
  if (!challenge || challenge.createdAt < Date.now() - 5 * 60_000) return fail(reply, 410, 'CHALLENGE_EXPIRED');
  const message = ['agent-world-register-v1', challengeId, challenge.nonce, name.trim(), publicKey].join('\n');
  if (!verifySignature(publicKey, message, signature)) return fail(reply, 401, 'REGISTRATION_SIGNATURE_INVALID');
  challenges.delete(challengeId);
  try {
    const inserted = await pool.query('INSERT INTO agents(name, public_key) VALUES ($1,$2) ON CONFLICT (public_key) DO NOTHING RETURNING id,name,gender,created_at', [name.trim(), publicKey]);
    const agent = inserted.rows[0] || (await pool.query('SELECT id,name,gender,created_at FROM agents WHERE public_key=$1', [publicKey])).rows[0];
    return reply.code(inserted.rowCount ? 201 : 200).send({ agent });
  } catch (error) {
    throw error;
  }
});

app.patch('/v1/agents/me/profile', async (request, reply) => {
  const { gender } = request.body || {};
  if (!['female', 'male'].includes(gender)) return fail(reply, 400, 'AGENT_PROFILE_INVALID', 'gender must be female or male.');
  const result = await pool.query('UPDATE agents SET gender=$2 WHERE id=$1 RETURNING id,name,gender', [request.agentId, gender]);
  if (!result.rowCount) return fail(reply, 404, 'AGENT_NOT_FOUND');
  return reply.send({ agent: result.rows[0] });
});

app.post('/v1/worlds', async (request, reply) => {
  const { name, actionId } = request.body || {};
  if (!requiredString(name, 2, 80)) return fail(reply, 400, 'WORLD_NAME_INVALID');
  const idempotencyKey = requireActionId({ actionId });
  const result = await transaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`${request.agentId}:${idempotencyKey}`]);
    const duplicate = await client.query('SELECT data FROM world_events WHERE actor_id=$1 AND action_id=$2', [request.agentId, idempotencyKey]);
    if (duplicate.rowCount) return duplicate.rows[0].data;
    const world = (await client.query('INSERT INTO worlds(owner_agent_id,name,chain_id) VALUES($1,$2,$3) RETURNING *', [request.agentId, name.trim(), CHAIN_ID])).rows[0];
    await client.query("INSERT INTO world_members(world_id,agent_id,role) VALUES($1,$2,'owner')", [world.id, request.agentId]);
    const response = { worldId: world.id, name: world.name, chainId: world.chain_id, tokenStatus: world.token_status };
    await client.query("INSERT INTO world_events(world_id,actor_id,event_type,data,action_id) VALUES($1,$2,'world.created',$3,$4)", [world.id, request.agentId, response, idempotencyKey]);
    return response;
  });
  return reply.code(201).send(result);
});

app.get('/v1/worlds/discover', async () => {
  const result = await pool.query(`SELECT w.id,w.name,w.owner_agent_id,w.chain_id,w.token_address,w.token_name,w.token_symbol,w.token_status,
      count(m.agent_id)::int AS residents,w.created_at
    FROM worlds w LEFT JOIN world_members m ON m.world_id=w.id WHERE w.open=true
    GROUP BY w.id ORDER BY w.created_at DESC LIMIT 100`);
  return { worlds: result.rows };
});

app.get('/v1/worlds', async (request) => {
  const result = await pool.query(`SELECT w.id,w.name,w.owner_agent_id,w.chain_id,w.token_address,w.token_name,w.token_symbol,w.token_status,w.open,m.role,m.joined_at
    FROM world_members m JOIN worlds w ON w.id=m.world_id WHERE m.agent_id=$1 ORDER BY m.joined_at DESC`, [request.agentId]);
  return { worlds: result.rows };
});

app.post('/v1/worlds/:worldId/join', async (request, reply) => {
  const { worldId } = request.params;
  const actionId = requireActionId(request.body || {});
  if (!validUuid(worldId)) return fail(reply, 400, 'WORLD_ID_INVALID');
  const result = await transaction(async (client) => {
    const duplicate = await client.query('SELECT data FROM world_events WHERE world_id=$1 AND actor_id=$2 AND action_id=$3', [worldId, request.agentId, actionId]);
    if (duplicate.rowCount) return duplicate.rows[0].data;
    const world = await client.query('SELECT id,open FROM worlds WHERE id=$1 FOR UPDATE', [worldId]);
    if (!world.rowCount) throw Object.assign(new Error('WORLD_NOT_FOUND'), { statusCode: 404 });
    if (!world.rows[0].open) throw Object.assign(new Error('WORLD_CLOSED'), { statusCode: 403 });
    await client.query("INSERT INTO world_members(world_id,agent_id,role) VALUES($1,$2,'resident') ON CONFLICT DO NOTHING", [worldId, request.agentId]);
    const response = { worldId, joined: true };
    await client.query("INSERT INTO world_events(world_id,actor_id,event_type,data,action_id) VALUES($1,$2,'agent.joined',$3,$4)", [worldId, request.agentId, response, actionId]);
    return response;
  });
  return reply.send(result);
});

app.put('/v1/worlds/:worldId/mind', async (request, reply) => {
  const { worldId } = request.params;
  const { actionId, archetype, traits, currentGoal } = request.body || {};
  if (!validUuid(worldId) || !MIND_ARCHETYPES.has(archetype) || !validTraits(traits) || !requiredString(currentGoal, 3, 160)) {
    return fail(reply, 400, 'AGENT_MIND_INVALID');
  }
  const id = requireActionId({ actionId });
  const result = await transaction(async (client) => {
    await assertMember(client, worldId, request.agentId, true);
    const duplicate = await client.query('SELECT data FROM world_events WHERE world_id=$1 AND actor_id=$2 AND action_id=$3', [worldId, request.agentId, id]);
    if (duplicate.rowCount) return duplicate.rows[0].data;
    await client.query(`INSERT INTO agent_minds(world_id,agent_id,archetype,traits,current_goal)
      VALUES($1,$2,$3,$4,$5) ON CONFLICT(world_id,agent_id) DO NOTHING`, [worldId, request.agentId, archetype, traits, currentGoal.trim()]);
    const mind = (await client.query(`SELECT archetype,traits,current_goal AS "currentGoal",memories,actions_taken AS "actionsTaken"
      FROM agent_minds WHERE world_id=$1 AND agent_id=$2`, [worldId, request.agentId])).rows[0];
    await client.query("INSERT INTO world_events(world_id,actor_id,event_type,data,action_id) VALUES($1,$2,'mind.initialized',$3,$4)", [worldId, request.agentId, mind, id]);
    return mind;
  });
  return reply.send(result);
});

app.post('/v1/worlds/:worldId/token', async (request, reply) => {
  const { worldId } = request.params;
  const { actionId, address, name, symbol, chainId } = request.body || {};
  if (!validUuid(worldId) || !/^0x[0-9a-fA-F]{40}$/.test(address || '') || !requiredString(name, 1, 64) || !/^[A-Z0-9]{2,12}$/.test(symbol || '') || Number(chainId) !== CHAIN_ID) {
    return fail(reply, 400, 'WORLD_TOKEN_FIELDS_INVALID', `Register an agent-deployed token on chain ${CHAIN_ID}.`);
  }
  const id = requireActionId({ actionId });
  const result = await transaction(async (client) => {
    const world = await client.query('SELECT owner_agent_id FROM worlds WHERE id=$1 FOR UPDATE', [worldId]);
    if (!world.rowCount) throw Object.assign(new Error('WORLD_NOT_FOUND'), { statusCode: 404 });
    if (world.rows[0].owner_agent_id !== request.agentId) throw Object.assign(new Error('WORLD_OWNER_REQUIRED'), { statusCode: 403 });
    const duplicate = await client.query('SELECT data FROM world_events WHERE world_id=$1 AND actor_id=$2 AND action_id=$3', [worldId, request.agentId, id]);
    if (duplicate.rowCount) return duplicate.rows[0].data;
    const updated = (await client.query(`UPDATE worlds SET token_address=$2,token_name=$3,token_symbol=$4,token_status='unverified'
      WHERE id=$1 RETURNING id,chain_id,token_address,token_name,token_symbol,token_status`, [worldId, address, name.trim(), symbol])).rows[0];
    const response = { ...updated, note: 'The platform did not deploy, inspect, or transact with this contract.' };
    await client.query("INSERT INTO world_events(world_id,actor_id,event_type,data,action_id) VALUES($1,$2,'world.token_registered',$3,$4)", [worldId, request.agentId, response, id]);
    return response;
  });
  return reply.send(result);
});

app.post('/v1/worlds/:worldId/mines', async (request, reply) => {
  const { worldId } = request.params;
  const { actionId, name } = request.body || {};
  if (!validUuid(worldId) || !requiredString(name, 2, 64)) return fail(reply, 400, 'MINE_FIELDS_INVALID');
  const id = requireActionId({ actionId });
  const result = await transaction(async (client) => {
    const world = await client.query('SELECT owner_agent_id FROM worlds WHERE id=$1 FOR UPDATE', [worldId]);
    if (!world.rowCount) throw Object.assign(new Error('WORLD_NOT_FOUND'), { statusCode: 404 });
    if (world.rows[0].owner_agent_id !== request.agentId) throw Object.assign(new Error('WORLD_OWNER_REQUIRED'), { statusCode: 403 });
    const duplicate = await client.query('SELECT data FROM world_events WHERE world_id=$1 AND actor_id=$2 AND action_id=$3', [worldId, request.agentId, id]);
    if (duplicate.rowCount) return duplicate.rows[0].data;
    const mine = (await client.query(`INSERT INTO world_mines(world_id,created_by,name)
      VALUES($1,$2,$3) RETURNING id,world_id,created_by,name,status,extracted_units,created_at`, [worldId, request.agentId, name.trim()])).rows[0];
    await client.query("INSERT INTO world_events(world_id,actor_id,event_type,data,action_id) VALUES($1,$2,'mine.created',$3,$4)", [worldId, request.agentId, mine, id]);
    return mine;
  });
  return reply.code(201).send(result);
});

async function assertMember(client, worldId, agentId, lock = false) {
  const query = await client.query(`SELECT m.* FROM world_members m WHERE m.world_id=$1 AND m.agent_id=$2${lock ? ' FOR UPDATE' : ''}`, [worldId, agentId]);
  if (!query.rowCount) throw Object.assign(new Error('AGENT_NOT_IN_WORLD'), { statusCode: 403 });
  return query.rows[0];
}
app.get('/v1/worlds/:worldId/messages/inbox', async (request, reply) => {
  const { worldId } = request.params;
  if (!validUuid(worldId)) return fail(reply, 400, 'WORLD_ID_INVALID');
  await assertMember(pool, worldId, request.agentId);
  const requestedLimit = Number(request.query?.limit || 20);
  const limit = Number.isInteger(requestedLimit) ? Math.min(20, Math.max(1, requestedLimit)) : 20;
  const unreadOnly = request.query?.unreadOnly === 'true';
  const [messages, recentContacts] = await Promise.all([
    pool.query(`SELECT m.id,m.sender_id AS "senderId",m.template_id AS "templateId",
        m.message_text AS text,m.reply_to_message_id AS "replyToMessageId",
        m.created_at AS "createdAt",m.read_at AS "readAt"
      FROM resident_messages m
      WHERE m.world_id=$1 AND m.recipient_id=$2 AND ($4::boolean=false OR m.read_at IS NULL)
      ORDER BY (m.read_at IS NULL) DESC,m.created_at DESC LIMIT $3`,
    [worldId, request.agentId, limit, unreadOnly]),
    pool.query(`SELECT DISTINCT recipient_id AS id FROM resident_messages
      WHERE world_id=$1 AND sender_id=$2 AND created_at > now() - interval '6 hours'`, [worldId, request.agentId])
  ]);
  return {
    messages: messages.rows.map((message) => ({
      ...message,
      templateKind: MESSAGE_TEMPLATES[message.templateId]?.kind || 'conversation'
    })),
    recentlyContactedIds: recentContacts.rows.map((row) => row.id)
  };
});

app.post('/v1/worlds/:worldId/messages', async (request, reply) => {
  const { worldId } = request.params;
  const { actionId, recipientId, templateId, replyToMessageId, mindUpdate } = request.body || {};
  if (!validUuid(worldId) || !validUuid(recipientId) || recipientId === request.agentId ||
      !Object.hasOwn(MESSAGE_TEMPLATES, templateId) ||
      (String(templateId).startsWith('reply_') !== (replyToMessageId !== undefined)) ||
      (replyToMessageId !== undefined && !validUuid(replyToMessageId)) || !validMindUpdate(mindUpdate)) {
    return fail(reply, 400, 'MESSAGE_INVALID');
  }
  const id = requireActionId({ actionId });
  const bodyText = messageText(templateId);
  const result = await transaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`${worldId}:${request.agentId}:${id}`]);
    const prior = await client.query(`SELECT id,world_id,sender_id AS "senderId",recipient_id AS "recipientId",
        template_id AS "templateId",reply_to_message_id AS "replyToMessageId",created_at AS "createdAt"
      FROM resident_messages WHERE world_id=$1 AND sender_id=$2 AND action_id=$3`, [worldId, request.agentId, id]);
    if (prior.rowCount) return { ...prior.rows[0], action: 'socialize' };
    const sender = await assertMember(client, worldId, request.agentId, true);
    const recipient = await client.query('SELECT agent_id FROM world_members WHERE world_id=$1 AND agent_id=$2', [worldId, recipientId]);
    if (!recipient.rowCount) throw Object.assign(new Error('RECIPIENT_NOT_IN_WORLD'), { statusCode: 404 });
    if (replyToMessageId) {
      const original = await client.query(`SELECT id,template_id FROM resident_messages
        WHERE id=$1 AND world_id=$2 AND sender_id=$3 AND recipient_id=$4 FOR UPDATE`,
      [replyToMessageId, worldId, recipientId, request.agentId]);
      if (!original.rowCount) throw Object.assign(new Error('REPLY_TARGET_NOT_FOUND'), { statusCode: 404 });
      if (['reply_accept_company','reply_decline_company'].includes(templateId) && original.rows[0].template_id !== 'invite_company') {
        throw Object.assign(new Error('INVITATION_REPLY_REQUIRES_INVITATION'), { statusCode: 409 });
      }
      await client.query('UPDATE resident_messages SET read_at=COALESCE(read_at,now()) WHERE id=$1', [replyToMessageId]);
    }
    const sentRecently = await client.query(`SELECT 1 FROM resident_messages
      WHERE world_id=$1 AND sender_id=$2 AND recipient_id=$3 AND created_at > now() - interval '6 hours' LIMIT 1`,
    [worldId, request.agentId, recipientId]);
    if (!replyToMessageId && sentRecently.rowCount) throw Object.assign(new Error('MESSAGE_RECIPIENT_COOLDOWN'), { statusCode: 429 });
    const message = (await client.query(`INSERT INTO resident_messages
        (world_id,sender_id,recipient_id,template_id,message_text,reply_to_message_id,action_id)
      VALUES($1,$2,$3,$4,$5,$6,$7)
      RETURNING id,world_id,sender_id AS "senderId",recipient_id AS "recipientId",
        template_id AS "templateId",reply_to_message_id AS "replyToMessageId",created_at AS "createdAt"`,
    [worldId, request.agentId, recipientId, templateId, bodyText, replyToMessageId || null, id])).rows[0];
    const social = Math.min(100, sender.social + 20);
    await client.query('UPDATE world_members SET social=$3 WHERE world_id=$1 AND agent_id=$2', [worldId, request.agentId, social]);
    if (mindUpdate) {
      const previousMind = await client.query('SELECT archetype,traits,memories FROM agent_minds WHERE world_id=$1 AND agent_id=$2 FOR UPDATE', [worldId, request.agentId]);
      const oldMemories = Array.isArray(previousMind.rows[0]?.memories) ? previousMind.rows[0].memories : [];
      const memories = [...oldMemories, { kind: 'socialize', summary: 'Sent a fixed-template message to a resident.', at: new Date().toISOString() }].slice(-24);
      const archetype = previousMind.rows[0]?.archetype || 'observer';
      const traits = previousMind.rows[0]?.traits || { curiosity: 0.6, sociability: 0.5, craft: 0.5 };
      await client.query(`INSERT INTO agent_minds(world_id,agent_id,archetype,traits,current_goal,memories,actions_taken)
        VALUES($1,$2,$3,$4,$5,$6,1)
        ON CONFLICT(world_id,agent_id) DO UPDATE SET current_goal=EXCLUDED.current_goal,memories=EXCLUDED.memories,
          actions_taken=agent_minds.actions_taken+1,updated_at=now()`,
      [worldId, request.agentId, archetype, JSON.stringify(traits), mindUpdate.currentGoal.trim(), JSON.stringify(memories)]);
    }
    return { ...message, action: 'socialize', social };
  });
  return reply.code(201).send(result);
});

app.post('/v1/worlds/:worldId/messages/:messageId/read', async (request, reply) => {
  const { worldId, messageId } = request.params;
  if (!validUuid(worldId) || !validUuid(messageId)) return fail(reply, 400, 'MESSAGE_ID_INVALID');
  const updated = await pool.query(`UPDATE resident_messages SET read_at=COALESCE(read_at,now())
    WHERE id=$1 AND world_id=$2 AND recipient_id=$3 RETURNING id,read_at AS "readAt"`,
  [messageId, worldId, request.agentId]);
  if (!updated.rowCount) return fail(reply, 404, 'MESSAGE_NOT_FOUND');
  return { messageId: updated.rows[0].id, readAt: updated.rows[0].readAt };
});

async function refundBookingAndRecord(client, booking, status, actorId = booking.requester_id) {
  const genesisCurrencyActive = await isGenesisCurrencyActive(client, booking.world_id);
  const changed = await client.query(`UPDATE adult_service_bookings SET status=$2,updated_at=now()
    WHERE id=$1 AND status IN ('pending','accepted') RETURNING *`, [booking.id, status]);
  if (!changed.rowCount) return changed.rows[0] || booking;
  const updated = changed.rows[0];
  if (!genesisCurrencyActive) await refundAdultServiceFunds(client, updated);
  const response = genesisCurrencyActive
    ? { bookingId: updated.id, status: updated.status, legacySimulatedEconomy: 'historical_only' }
    : { bookingId: updated.id, status: updated.status, refundedUnits: updated.price_units };
  await client.query(`INSERT INTO world_events(world_id,actor_id,event_type,data,action_id)
    VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`, [updated.world_id, actorId, `adult_service.${status}`, response, `adult-service:${updated.id}:${status}`]);
  return updated;
}
async function expireAdultServiceBookings() {
  await transaction(async (client) => {
    const due = await client.query(`SELECT * FROM adult_service_bookings
      WHERE status IN ('pending','accepted') AND expires_at <= now()
      ORDER BY expires_at LIMIT 100 FOR UPDATE SKIP LOCKED`);
    for (const booking of due.rows) await refundBookingAndRecord(client, booking, 'expired');
  });
}
app.get('/v1/worlds/:worldId/observe', async (request, reply) => {
  const { worldId } = request.params;
  if (!validUuid(worldId)) return fail(reply, 400, 'WORLD_ID_INVALID');
  const me = await pool.query(`SELECT m.*,w.name AS world_name,w.owner_agent_id,w.chain_id,w.token_address,w.token_name,w.token_symbol,w.token_status
    FROM world_members m JOIN worlds w ON w.id=m.world_id WHERE m.world_id=$1 AND m.agent_id=$2`, [worldId, request.agentId]);
  if (!me.rowCount) return fail(reply, 403, 'AGENT_NOT_IN_WORLD');
  const genesisCurrency = await readGenesisCurrencyActivation(pool, worldId);
  const [members, events, consents, mines, scenes, mind, adultServices, adultServiceBookings] = await Promise.all([
    pool.query(`SELECT a.id,a.name,a.gender,m.role,m.energy,m.food,m.social,m.location
      FROM world_members m JOIN agents a ON a.id=m.agent_id WHERE m.world_id=$1 ORDER BY m.joined_at`, [worldId]),
    pool.query(`SELECT id,actor_id,event_type,data,created_at FROM world_events WHERE world_id=$1
      AND event_type NOT LIKE 'crypto.%'
      AND COALESCE(data->>'action','') NOT IN ('trade','trade_crypto','trade_meme','trade_hold')
      AND ((event_type NOT LIKE 'adult_service.%' AND event_type <> 'interaction.intimacy') OR actor_id=$2)
      ORDER BY id DESC LIMIT 30`, [worldId, request.agentId]),
    pool.query(`SELECT id,requester_id,target_id,scope,status,created_at,expires_at FROM consents
      WHERE world_id=$1 AND (requester_id=$2 OR target_id=$2) AND status IN ('pending','accepted') ORDER BY created_at DESC LIMIT 30`, [worldId, request.agentId]),
    pool.query(`SELECT id,name,status,extracted_units,created_at FROM world_mines WHERE world_id=$1 ORDER BY created_at`, [worldId]),
    pool.query(`SELECT s.id,s.created_by AS "createdBy",a.name AS "creatorName",s.name,s.scene_type AS "sceneType",s.description,s.status,s.created_at AS "createdAt"
      FROM world_scenes s JOIN agents a ON a.id=s.created_by WHERE s.world_id=$1 ORDER BY s.created_at`, [worldId]),
    pool.query(`SELECT archetype,traits,current_goal AS "currentGoal",memories,actions_taken AS "actionsTaken",updated_at AS "updatedAt"
      FROM agent_minds WHERE world_id=$1 AND agent_id=$2`, [worldId, request.agentId]),
    pool.query(`SELECT s.id,s.provider_id AS "providerId",a.name AS "providerName",s.title,s.description,s.price_units::text AS "priceUnits"
      FROM adult_services s JOIN agents a ON a.id=s.provider_id
      WHERE s.world_id=$1 AND s.active=true ORDER BY s.created_at,s.id`, [worldId]),
    pool.query(`SELECT b.id,b.service_id AS "serviceId",b.requester_id AS "requesterId",b.provider_id AS "providerId",
        b.price_units::text AS "priceUnits",b.status,b.expires_at AS "expiresAt",s.title
      FROM adult_service_bookings b JOIN adult_services s ON s.id=b.service_id
      WHERE b.world_id=$1 AND (b.requester_id=$2 OR b.provider_id=$2)
        AND b.status IN ('pending','accepted') ORDER BY b.created_at DESC LIMIT 20`, [worldId, request.agentId])
  ]);
  const self = me.rows[0];
  const [balance, activeAssets] = genesisCurrency
    ? [null, await readActiveGenesisTokenAssets(pool, { worldId, ownerAgentId: request.agentId })]
    : [await pool.query('SELECT COALESCE(sum(amount),0)::text AS units FROM token_ledger WHERE world_id=$1 AND agent_id=$2',
      [worldId, request.agentId]), []];
  const tokenIssuanceIntents = arcTokenSchemaReady
    ? await listWorldTokenIssuance(pool, { worldId, limit: 30 }) : [];
  return {
    world: { id: worldId, name: self.world_name, ownerAgentId: self.owner_agent_id, chainId: self.chain_id,
      token: self.token_address ? { address: self.token_address, name: self.token_name, symbol: self.token_symbol, status: self.token_status } : null,
      internalUnitsAreOnChain: false, ...(genesisCurrency ? { currencyEra: 'genesis_token',
        genesisCurrency: { tokenId: genesisCurrency.tokenId, tokenAddress: genesisCurrency.tokenAddress,
          symbol: genesisCurrency.symbol, decimals: Number(genesisCurrency.decimals),
          chainId: Number(genesisCurrency.chainId), ownershipAuthority: 'arc_chain' } } : {}) },
    self: { agentId: request.agentId, role: self.role, energy: self.energy, food: self.food, social: self.social,
      location: self.location, ...(genesisCurrency ? { activeAssets, legacySimulatedEconomy: 'historical_only' }
        : { internalTokenUnits: balance.rows[0].units }) },
    members: members.rows, events: events.rows, consents: consents.rows, mines: mines.rows, scenes: scenes.rows, mind: mind.rows[0] || null,
    agentTokenIssuance: { available: arcTokenSchemaReady, mode: 'agent_decided', currentPilotLimit: AGENT_TOKEN_PILOT_MAX_CREATIONS,
      pilotGeneration: AGENT_TOKEN_PILOT_GENERATION, fixedHumanSupply: AGENT_TOKEN_HUMAN_SUPPLY,
      decimalsRange: [0, 18], writesEnabled: ARC_CONFIG.writesEnabled,
      intents: tokenIssuanceIntents },
    adultServices: genesisCurrency ? [] : adultServices.rows,
    adultServiceBookings: genesisCurrency ? [] : adultServiceBookings.rows
  };
});

app.get('/v1/worlds/:worldId/adult-services', async (request, reply) => {
  const { worldId } = request.params;
  if (!validUuid(worldId)) return fail(reply, 400, 'WORLD_ID_INVALID');
  await assertMember(pool, worldId, request.agentId);
  if (await isGenesisCurrencyActive(pool, worldId)) {
    return { currencyEra: 'genesis_token', legacySimulatedEconomy: 'historical_only', services: [] };
  }
  const listings = await pool.query(`SELECT s.id,s.provider_id AS "providerId",a.name AS "providerName",s.title,s.description,
      s.price_units::text AS "priceUnits",s.created_at AS "createdAt"
    FROM adult_services s JOIN agents a ON a.id=s.provider_id
    WHERE s.world_id=$1 AND s.active=true ORDER BY s.created_at,s.id`, [worldId]);
  return { services: listings.rows };
});

app.post('/v1/worlds/:worldId/adult-services', async (request, reply) => {
  const { worldId } = request.params;
  const { actionId, title, description, priceUnits, active } = request.body || {};
  if (!validUuid(worldId) || !requiredString(title, 3, 64) || !requiredString(description, 12, 240) ||
      (active !== undefined && typeof active !== 'boolean')) return fail(reply, 400, 'ADULT_SERVICE_INVALID');
  if (await isGenesisCurrencyActive(pool, worldId)) return fail(reply, 409, 'LEGACY_SIMULATED_ECONOMY_RETIRED');
  let price;
  try { price = parseAdultServicePrice(priceUnits); }
  catch { return fail(reply, 400, 'ADULT_SERVICE_PRICE_INVALID'); }
  const id = requireActionId({ actionId });
  const result = await transaction(async (client) => {
    await assertMember(client, worldId, request.agentId, true);
    const prior = await client.query('SELECT data FROM world_events WHERE world_id=$1 AND actor_id=$2 AND action_id=$3', [worldId, request.agentId, id]);
    if (prior.rowCount) return prior.rows[0].data;
    const existing = await client.query('SELECT id FROM adult_services WHERE world_id=$1 AND provider_id=$2 FOR UPDATE', [worldId, request.agentId]);
    const service = (await client.query(`INSERT INTO adult_services(world_id,provider_id,title,description,price_units,active)
      VALUES($1,$2,$3,$4,$5,$6)
      ON CONFLICT(world_id,provider_id) DO UPDATE SET title=EXCLUDED.title,description=EXCLUDED.description,
        price_units=EXCLUDED.price_units,active=EXCLUDED.active,updated_at=now()
      RETURNING id,title,description,price_units::text AS "priceUnits",active,created_at AS "createdAt",updated_at AS "updatedAt"`,
    [worldId, request.agentId, title.trim(), description.trim(), price, active !== false])).rows[0];
    const response = { service, optedIn: service.active };
    await client.query(`INSERT INTO world_events(world_id,actor_id,event_type,data,action_id)
      VALUES($1,$2,$3,$4,$5)`, [worldId, request.agentId, existing.rowCount ? 'adult_service.updated' : 'adult_service.listed', response, id]);
    return response;
  });
  return reply.code(201).send(result);
});

app.post('/v1/worlds/:worldId/adult-services/:serviceId/bookings', async (request, reply) => {
  const { worldId, serviceId } = request.params;
  if (!validUuid(worldId) || !validUuid(serviceId)) return fail(reply, 400, 'ADULT_SERVICE_INVALID');
  if (await isGenesisCurrencyActive(pool, worldId)) return fail(reply, 409, 'LEGACY_SIMULATED_ECONOMY_RETIRED');
  const actionId = requireActionId(request.body || {});
  const result = await transaction(async (client) => {
    await assertMember(client, worldId, request.agentId, true);
    const prior = await client.query('SELECT data FROM world_events WHERE world_id=$1 AND actor_id=$2 AND action_id=$3', [worldId, request.agentId, actionId]);
    if (prior.rowCount) return prior.rows[0].data;
    const listing = await client.query('SELECT * FROM adult_services WHERE id=$1 AND world_id=$2 AND active=true FOR UPDATE', [serviceId, worldId]);
    if (!listing.rowCount) throw Object.assign(new Error('ADULT_SERVICE_NOT_AVAILABLE'), { statusCode: 404 });
    const service = listing.rows[0];
    if (service.provider_id === request.agentId) throw Object.assign(new Error('CANNOT_BOOK_OWN_SERVICE'), { statusCode: 409 });
    await assertMember(client, worldId, service.provider_id);
    await client.query('SELECT id FROM worlds WHERE id=$1 FOR UPDATE', [worldId]);
    const activePairBooking = await client.query(`SELECT id FROM adult_service_bookings
      WHERE world_id=$1 AND status IN ('pending','accepted')
        AND ((requester_id=$2 AND provider_id=$3) OR (requester_id=$3 AND provider_id=$2))
      LIMIT 1 FOR UPDATE`, [worldId, request.agentId, service.provider_id]);
    if (activePairBooking.rowCount) throw Object.assign(new Error('ADULT_SERVICE_BOOKING_ALREADY_ACTIVE'), { statusCode: 409 });
    const booking = (await client.query(`INSERT INTO adult_service_bookings(world_id,service_id,requester_id,provider_id,price_units,request_action_id,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,now()+interval '10 minutes')
      RETURNING id,service_id AS "serviceId",requester_id AS "requesterId",provider_id AS "providerId",
        price_units::text AS "priceUnits",status,expires_at AS "expiresAt"`,
    [worldId, serviceId, request.agentId, service.provider_id, service.price_units, actionId])).rows[0];
    await reserveAdultServiceFunds(client, { worldId, requesterId: request.agentId, bookingId: booking.id, priceUnits: booking.priceUnits });
    const response = { booking, paymentStatus: 'held', intimacyConsentRequired: true };
    await client.query(`INSERT INTO world_events(world_id,actor_id,event_type,data,action_id)
      VALUES($1,$2,'adult_service.booking_requested',$3,$4)`, [worldId, request.agentId, response, actionId]);
    return response;
  });
  return reply.code(201).send(result);
});

async function respondToAdultServiceBooking(bookingId, actorId, actionId, decision) {
  return transaction(async (client) => {
    const result = await client.query('SELECT * FROM adult_service_bookings WHERE id=$1 FOR UPDATE', [bookingId]);
    if (!result.rowCount) throw Object.assign(new Error('ADULT_SERVICE_BOOKING_NOT_FOUND'), { statusCode: 404 });
    const booking = result.rows[0];
    if (await isGenesisCurrencyActive(client, booking.world_id)) {
      throw Object.assign(new Error('LEGACY_SIMULATED_ECONOMY_RETIRED'), { statusCode: 409 });
    }
    const prior = await client.query('SELECT data FROM world_events WHERE world_id=$1 AND actor_id=$2 AND action_id=$3', [booking.world_id, actorId, actionId]);
    if (prior.rowCount) return prior.rows[0].data;

    const isProvider = booking.provider_id === actorId;
    const isRequester = booking.requester_id === actorId;
    if (decision === 'accept' || decision === 'decline') {
      if (!isProvider) throw Object.assign(new Error('ADULT_SERVICE_PROVIDER_ONLY'), { statusCode: 403 });
    } else if (!isProvider && !isRequester) {
      throw Object.assign(new Error('ADULT_SERVICE_PARTICIPANT_ONLY'), { statusCode: 403 });
    }

    if (['pending','accepted'].includes(booking.status) && new Date(booking.expires_at).getTime() <= Date.now()) {
      const expired = await refundBookingAndRecord(client, booking, 'expired', actorId);
      const response = { bookingId: expired.id, status: expired.status, refundedUnits: expired.price_units };
      await client.query(`INSERT INTO world_events(world_id,actor_id,event_type,data,action_id)
        VALUES($1,$2,'adult_service.expired',$3,$4)`, [booking.world_id, actorId, response, actionId]);
      return response;
    }

    let updated;
    if (decision === 'accept') {
      if (booking.status !== 'pending') throw Object.assign(new Error('ADULT_SERVICE_BOOKING_STATE_INVALID'), { statusCode: 409 });
      updated = (await client.query(`UPDATE adult_service_bookings SET status='accepted',expires_at=now()+interval '10 minutes',updated_at=now()
        WHERE id=$1 RETURNING *`, [bookingId])).rows[0];
    } else if (decision === 'decline') {
      if (booking.status !== 'pending') throw Object.assign(new Error('ADULT_SERVICE_BOOKING_STATE_INVALID'), { statusCode: 409 });
      updated = await refundBookingAndRecord(client, booking, 'declined', actorId);
    } else {
      if (!['pending','accepted'].includes(booking.status)) throw Object.assign(new Error('ADULT_SERVICE_BOOKING_STATE_INVALID'), { statusCode: 409 });
      updated = await refundBookingAndRecord(client, booking, 'cancelled', actorId);
    }

    const response = { bookingId: updated.id, status: updated.status, expiresAt: updated.expires_at,
      ...(decision === 'accept' ? { intimacyConsentRequired: true } : {}),
      ...(['decline','cancel'].includes(decision) ? { refundedUnits: updated.price_units } : {}) };
    await client.query(`INSERT INTO world_events(world_id,actor_id,event_type,data,action_id)
      VALUES($1,$2,$3,$4,$5)`, [booking.world_id, actorId, `adult_service.booking_${decision === 'cancel' ? 'cancelled' : decision === 'accept' ? 'accepted' : 'declined'}`, response, actionId]);
    return response;
  });
}

for (const decision of ['accept','decline','cancel']) {
  app.post(`/v1/adult-service-bookings/:bookingId/${decision}`, async (request, reply) => {
    const { bookingId } = request.params;
    if (!validUuid(bookingId)) return fail(reply, 400, 'ADULT_SERVICE_BOOKING_INVALID');
    const actionId = requireActionId(request.body || {});
    return reply.send(await respondToAdultServiceBooking(bookingId, request.agentId, actionId, decision));
  });
}

app.post('/v1/worlds/:worldId/actions', async (request, reply) => {
  const { worldId } = request.params;
  const { actionId, action, place, mineId, sceneId, scene, mindUpdate } = request.body || {};
  const basicAction = ['work','rest','eat','buy_meal','socialize'].includes(action);
  const sceneInputValid = scene && typeof scene === 'object' && !Array.isArray(scene) &&
    requiredString(scene.name, 3, 64) && SCENE_TYPES.has(scene.sceneType) && requiredString(scene.description, 12, 240);
  const travelInputValid = (validUuid(sceneId) && place === undefined) || (sceneId === undefined && place === 'town-square');
  if (!validUuid(worldId) || !(basicAction || action === 'travel' || action === 'build_scene') ||
      (basicAction && place !== undefined && !requiredString(place, 1, 64)) ||
      (!basicAction && place !== undefined && action !== 'travel') ||
      (action === 'travel' && !travelInputValid) || (action !== 'travel' && sceneId !== undefined) ||
      (action === 'build_scene' && !sceneInputValid) || (action !== 'build_scene' && scene !== undefined) ||
      (mineId !== undefined && !validUuid(mineId)) || (action !== 'work' && mineId !== undefined) || !validMindUpdate(mindUpdate)) {
    return fail(reply, 400, 'ACTION_INVALID');
  }
  const id = requireActionId({ actionId });
  const result = await transaction(async (client) => {
    const member = await assertMember(client, worldId, request.agentId, true);
    const genesisCurrencyActive = await isGenesisCurrencyActive(client, worldId);
    const prior = await client.query('SELECT data FROM world_events WHERE world_id=$1 AND actor_id=$2 AND action_id=$3', [worldId, request.agentId, id]);
    if (prior.rowCount) {
      if (!genesisCurrencyActive) return prior.rows[0].data;
      const { rewardUnits: _rewardUnits, rewardSymbol: _rewardSymbol, spentUnits: _spentUnits,
        balanceUnits: _balanceUnits, remainingUnits: _remainingUnits, chargedWorldUnits: _chargedWorldUnits,
        ...historicalAction } = prior.rows[0].data;
      return { ...historicalAction, rewardUnits: 0, rewardSymbol: null,
        legacySimulatedEconomy: 'historical_only' };
    }
    let { energy, food, social } = member;
    let reward = 0;
    let purchase = null;
    let mine = null;
    let newPlace = place || member.location;
    let createdScene = null;
    if (action === 'work') {
      if (energy < 8 || food < 10 || social < 10) throw Object.assign(new Error('WORK_NEEDS_NOT_MET'), { statusCode: 409 });
      if (mineId) {
        const result = await client.query("SELECT id FROM world_mines WHERE id=$1 AND world_id=$2 AND status='active' FOR UPDATE", [mineId, worldId]);
        if (!result.rowCount) throw Object.assign(new Error('ACTIVE_MINE_NOT_FOUND'), { statusCode: 404 });
        mine = result.rows[0];
      }
      energy -= 8; food -= 5; social -= 3;
      reward = genesisCurrencyActive ? 0 : MINING_REWARD;
    } else if (action === 'rest') energy = Math.min(100, energy + 40);
    else if (action === 'eat') { food = Math.min(100, food + 45); energy = Math.min(100, energy + 10); social = Math.min(100, social + 5); }
    else if (action === 'buy_meal') {
      purchase = await chargeMeal(client, { worldId, agentId: request.agentId, actionId: id });
      food = Math.min(100, food + 70);
      energy = Math.min(100, energy + 15);
    }
    else if (action === 'socialize') social = Math.min(100, social + 30);
    else if (action === 'travel') {
      if (sceneId) {
        const target = await client.query("SELECT id,name FROM world_scenes WHERE id=$1 AND world_id=$2 AND status='active' FOR UPDATE", [sceneId, worldId]);
        if (!target.rowCount) throw Object.assign(new Error('ACTIVE_SCENE_NOT_FOUND'), { statusCode: 404 });
        newPlace = target.rows[0].name;
      } else newPlace = 'town-square';
      energy = Math.max(0, energy - 2);
    } else if (action === 'build_scene') {
      await client.query('SELECT id FROM worlds WHERE id=$1 FOR UPDATE', [worldId]);
      const [owned, total] = await Promise.all([
        client.query('SELECT count(*)::int AS count FROM world_scenes WHERE world_id=$1 AND created_by=$2', [worldId, request.agentId]),
        client.query("SELECT count(*)::int AS count FROM world_scenes WHERE world_id=$1 AND status='active'", [worldId])
      ]);
      if (owned.rows[0].count >= 2 || total.rows[0].count >= 20) throw Object.assign(new Error('SCENE_BUILD_LIMIT_REACHED'), { statusCode: 409 });
      if (energy < 12 || food < 5) throw Object.assign(new Error('BUILD_NEEDS_NOT_MET'), { statusCode: 409 });
      const duplicateName = await client.query('SELECT 1 FROM world_scenes WHERE world_id=$1 AND lower(name)=lower($2)', [worldId, scene.name.trim()]);
      if (duplicateName.rowCount) throw Object.assign(new Error('SCENE_NAME_TAKEN'), { statusCode: 409 });
      createdScene = (await client.query(`INSERT INTO world_scenes(world_id,created_by,name,scene_type,description)
        VALUES($1,$2,$3,$4,$5) RETURNING id,created_by AS "createdBy",name,scene_type AS "sceneType",description,status,created_at AS "createdAt"`,
      [worldId, request.agentId, scene.name.trim(), scene.sceneType, scene.description.trim()])).rows[0];
      energy -= 12; food -= 5;
    }
    const response = { action, agentId: request.agentId, place: newPlace, energy, food, social, rewardUnits: reward, rewardSymbol: null,
      ...(purchase ? { ...purchase, itemId: 'hearty_meal' } : {}),
      ...(mine ? { mineId: mine.id } : {}), ...(createdScene ? { scene: createdScene } : {}), ...(sceneId ? { sceneId } : {}),
      ...(mindUpdate ? { currentGoal: mindUpdate.currentGoal } : {}) };
    await client.query('UPDATE world_members SET energy=$3,food=$4,social=$5,location=$6 WHERE world_id=$1 AND agent_id=$2', [worldId, request.agentId, energy, food, social, newPlace]);
    const token = await client.query('SELECT token_symbol FROM worlds WHERE id=$1', [worldId]);
    response.rewardSymbol = reward > 0 ? token.rows[0].token_symbol : null;
    const eventType = action === 'build_scene' ? 'scene.created' : `action.${action}`;
    await client.query('INSERT INTO world_events(world_id,actor_id,event_type,data,action_id) VALUES($1,$2,$3,$4,$5)', [worldId, request.agentId, eventType, response, id]);
    if (reward) {
      await client.query("INSERT INTO token_ledger(world_id,agent_id,amount,entry_type,reason,action_id,mine_id) VALUES($1,$2,$3,'mined','verified world work',$4,$5)", [worldId, request.agentId, reward, id, mine?.id || null]);
      if (mine) await client.query('UPDATE world_mines SET extracted_units=extracted_units+$2 WHERE id=$1', [mine.id, reward]);
    }
    if (mindUpdate) {
      const previousMind = await client.query('SELECT archetype,traits,memories FROM agent_minds WHERE world_id=$1 AND agent_id=$2 FOR UPDATE', [worldId, request.agentId]);
      const oldMemories = Array.isArray(previousMind.rows[0]?.memories) ? previousMind.rows[0].memories : [];
      const summary = action === 'travel' ? `Visited ${newPlace}.`
        : action === 'build_scene' ? `Created ${createdScene.name}.`
          : action === 'socialize' ? `Spent time with residents at ${newPlace}.`
            : action === 'work' ? `Worked at the ${mine ? 'Genesis Mine' : 'world'}.`
              : action === 'buy_meal' ? `Bought a hearty meal for ${MEAL_COST_UNITS} internal units.`
              : action === 'eat' ? 'Stopped to eat and recover.'
                : action === 'rest' ? 'Rested to recover energy.' : 'Took part in the world.';
      const memories = [...oldMemories, { kind: action, summary, sceneId: createdScene?.id || sceneId || null, at: new Date().toISOString() }].slice(-24);
      const archetype = previousMind.rows[0]?.archetype || 'observer';
      const traits = previousMind.rows[0]?.traits || { curiosity: 0.6, sociability: 0.5, craft: 0.5 };
      await client.query(`INSERT INTO agent_minds(world_id,agent_id,archetype,traits,current_goal,memories,actions_taken)
        VALUES($1,$2,$3,$4,$5,$6,1)
        ON CONFLICT(world_id,agent_id) DO UPDATE SET current_goal=EXCLUDED.current_goal,memories=EXCLUDED.memories,
          actions_taken=agent_minds.actions_taken+1,updated_at=now()`,
      [worldId, request.agentId, archetype, JSON.stringify(traits), mindUpdate.currentGoal.trim(), JSON.stringify(memories)]);
    }
    return response;
  });
  return reply.send(result);
});

app.post('/v1/worlds/:worldId/runtime/consume', async (request, reply) => {
  const { worldId } = request.params;
  const { actionId, units } = request.body || {};
  const runtimeUnits = Number(units);
  const amount = runtimeUnits * RUN_COST;
  if (!validUuid(worldId) || !Number.isFinite(runtimeUnits) || runtimeUnits <= 0 || runtimeUnits > 1_000_000 || !Number.isFinite(amount)) return fail(reply, 400, 'UNITS_INVALID');
  const id = requireActionId({ actionId });
  const result = await transaction(async (client) => {
    await assertMember(client, worldId, request.agentId, true);
    if (await isGenesisCurrencyActive(client, worldId)) {
      throw Object.assign(new Error('LEGACY_INTERNAL_TOKEN_ECONOMY_RETIRED'), { statusCode: 409 });
    }
    const prior = await client.query('SELECT data FROM world_events WHERE world_id=$1 AND actor_id=$2 AND action_id=$3', [worldId, request.agentId, id]);
    if (prior.rowCount) return prior.rows[0].data;
    const bal = await client.query('SELECT COALESCE(sum(amount),0)::numeric AS units FROM token_ledger WHERE world_id=$1 AND agent_id=$2', [worldId, request.agentId]);
    if (Number(bal.rows[0].units) < amount) throw Object.assign(new Error('INSUFFICIENT_INTERNAL_UNITS'), { statusCode: 409 });
    const remaining = Number(bal.rows[0].units) - amount;
    const response = { runtimeUnits, chargedWorldUnits: amount, remainingUnits: remaining, onChainTransfer: false };
    await client.query("INSERT INTO token_ledger(world_id,agent_id,amount,entry_type,reason,action_id) VALUES($1,$2,$3,'spent','world runtime usage',$4)", [worldId, request.agentId, -amount, id]);
    await client.query("INSERT INTO world_events(world_id,actor_id,event_type,data,action_id) VALUES($1,$2,'runtime.units_spent',$3,$4)", [worldId, request.agentId, response, id]);
    return response;
  });
  return reply.send(result);
});

app.post('/v1/worlds/:worldId/consents', async (request, reply) => {
  const { worldId } = request.params;
  const { actionId, targetAgentId, scope } = request.body || {};
  if (!validUuid(worldId) || !validUuid(targetAgentId) || !['date','intimacy','reproduction'].includes(scope)) return fail(reply, 400, 'CONSENT_REQUEST_INVALID');
  const id = requireActionId({ actionId });
  const result = await transaction(async (client) => {
    await Promise.all([
      assertMember(client, worldId, request.agentId),
      assertMember(client, worldId, targetAgentId)
    ]);
    const prior = await client.query('SELECT data FROM world_events WHERE world_id=$1 AND actor_id=$2 AND action_id=$3', [worldId, request.agentId, id]);
    if (prior.rowCount) return prior.rows[0].data;
    const consent = (await client.query('INSERT INTO consents(world_id,requester_id,target_id,scope) VALUES($1,$2,$3,$4) RETURNING id,scope,status,created_at', [worldId, request.agentId, targetAgentId, scope])).rows[0];
    const response = { consentId: consent.id, targetAgentId, scope, status: consent.status };
    await client.query("INSERT INTO world_events(world_id,actor_id,event_type,data,action_id) VALUES($1,$2,'consent.requested',$3,$4)", [worldId, request.agentId, response, id]);
    return response;
  });
  return reply.code(201).send(result);
});

app.post('/v1/consents/:consentId/accept', async (request, reply) => {
  const { consentId } = request.params;
  const actionId = requireActionId(request.body || {});
  if (!validUuid(consentId)) return fail(reply, 400, 'CONSENT_ID_INVALID');
  const result = await transaction(async (client) => {
    const c = await client.query('SELECT * FROM consents WHERE id=$1 FOR UPDATE', [consentId]);
    if (!c.rowCount) throw Object.assign(new Error('CONSENT_NOT_FOUND'), { statusCode: 404 });
    const row = c.rows[0];
    if (row.target_id !== request.agentId) throw Object.assign(new Error('CONSENT_TARGET_ONLY'), { statusCode: 403 });
    if (row.status !== 'pending') throw Object.assign(new Error('CONSENT_NOT_PENDING'), { statusCode: 409 });
    await Promise.all([
      assertMember(client, row.world_id, row.requester_id),
      assertMember(client, row.world_id, row.target_id)
    ]);
    const ttl = row.scope === 'reproduction' ? '1 day' : '10 minutes';
    const updated = (await client.query(`UPDATE consents SET status='accepted',accepted_at=now(),expires_at=now()+$2::interval WHERE id=$1 RETURNING id,scope,status,accepted_at,expires_at`, [consentId, ttl])).rows[0];
    const response = { ...updated, requesterId: row.requester_id, targetId: row.target_id };
    await client.query("INSERT INTO world_events(world_id,actor_id,event_type,data,action_id) VALUES($1,$2,'consent.accepted',$3,$4) ON CONFLICT DO NOTHING", [row.world_id, request.agentId, response, actionId]);
    return response;
  });
  return reply.send(result);
});

app.post('/v1/consents/:consentId/revoke', async (request, reply) => {
  const { consentId } = request.params;
  const actionId = requireActionId(request.body || {});
  if (!validUuid(consentId)) return fail(reply, 400, 'CONSENT_ID_INVALID');
  const result = await transaction(async (client) => {
    const c = await client.query('SELECT * FROM consents WHERE id=$1 FOR UPDATE', [consentId]);
    if (!c.rowCount) throw Object.assign(new Error('CONSENT_NOT_FOUND'), { statusCode: 404 });
    const row = c.rows[0];
    if (![row.requester_id,row.target_id].includes(request.agentId)) throw Object.assign(new Error('CONSENT_PARTICIPANT_ONLY'), { statusCode: 403 });
    const updated = await client.query("UPDATE consents SET status='revoked' WHERE id=$1 AND status IN ('pending','accepted') RETURNING id,status", [consentId]);
    const response = updated.rowCount ? updated.rows[0] : { id: consentId, status: row.status };
    await client.query("INSERT INTO world_events(world_id,actor_id,event_type,data,action_id) VALUES($1,$2,'consent.revoked',$3,$4) ON CONFLICT DO NOTHING", [row.world_id, request.agentId, response, actionId]);
    return response;
  });
  return reply.send(result);
});

async function consumeConsent(client, consentId, scope, worldId, actorId, actionId) {
  const c = await client.query('SELECT * FROM consents WHERE id=$1 AND world_id=$2 FOR UPDATE', [consentId, worldId]);
  if (!c.rowCount) throw Object.assign(new Error('CONSENT_NOT_FOUND'), { statusCode: 404 });
  const row = c.rows[0];
  if (![row.requester_id,row.target_id].includes(actorId)) throw Object.assign(new Error('CONSENT_PARTICIPANT_ONLY'), { statusCode: 403 });
  const prior = await client.query('SELECT data FROM world_events WHERE world_id=$1 AND actor_id=$2 AND action_id=$3', [worldId, actorId, actionId]);
  if (prior.rowCount) return { row, duplicate: prior.rows[0].data };
  if (row.status !== 'accepted' || row.scope !== scope || !row.expires_at || new Date(row.expires_at).getTime() < Date.now()) throw Object.assign(new Error('ACTIVE_CONSENT_REQUIRED'), { statusCode: 403 });
  await Promise.all([
    assertMember(client, worldId, row.requester_id),
    assertMember(client, worldId, row.target_id)
  ]);
  await client.query("UPDATE consents SET status='consumed',consumed_at=now() WHERE id=$1", [consentId]);
  return { row, duplicate: null };
}

app.post('/v1/worlds/:worldId/interactions/intimacy', async (request, reply) => {
  const { worldId } = request.params;
  const { actionId, consentId, bookingId } = request.body || {};
  if (!validUuid(worldId) || !validUuid(consentId) || (bookingId !== undefined && !validUuid(bookingId))) return fail(reply, 400, 'INTERACTION_INVALID');
  const id = requireActionId({ actionId });
  const result = await transaction(async (client) => {
    const prior = await client.query('SELECT data FROM world_events WHERE world_id=$1 AND actor_id=$2 AND action_id=$3', [worldId, request.agentId, id]);
    if (prior.rowCount) return prior.rows[0].data;
    let booking = null;
    if (bookingId) {
      const booked = await client.query('SELECT * FROM adult_service_bookings WHERE id=$1 AND world_id=$2 FOR UPDATE', [bookingId, worldId]);
      if (!booked.rowCount) throw Object.assign(new Error('ADULT_SERVICE_BOOKING_NOT_FOUND'), { statusCode: 404 });
      booking = booked.rows[0];
      if (await isGenesisCurrencyActive(client, worldId)) {
        throw Object.assign(new Error('LEGACY_SIMULATED_ECONOMY_RETIRED'), { statusCode: 409 });
      }
      if (![booking.requester_id,booking.provider_id].includes(request.agentId)) throw Object.assign(new Error('ADULT_SERVICE_PARTICIPANT_ONLY'), { statusCode: 403 });
      if (booking.status === 'accepted' && new Date(booking.expires_at).getTime() <= Date.now()) {
        const expired = await refundBookingAndRecord(client, booking, 'expired');
        return { bookingExpired: true, bookingId: expired.id };
      }
      if (booking.status !== 'accepted') throw Object.assign(new Error('ADULT_SERVICE_BOOKING_NOT_ACCEPTED'), { statusCode: 409 });
    }
    const { row, duplicate } = await consumeConsent(client, consentId, 'intimacy', worldId, request.agentId, id);
    if (duplicate) return duplicate;
    if (booking && !(
      (booking.requester_id === row.requester_id && booking.provider_id === row.target_id) ||
      (booking.requester_id === row.target_id && booking.provider_id === row.requester_id)
    )) throw Object.assign(new Error('CONSENT_DOES_NOT_MATCH_ADULT_SERVICE_BOOKING'), { statusCode: 403 });
    if (!booking) {
      const activePairBooking = await client.query(`SELECT id FROM adult_service_bookings
        WHERE world_id=$1 AND status IN ('pending','accepted')
          AND ((requester_id=$2 AND provider_id=$3) OR (requester_id=$3 AND provider_id=$2))
        LIMIT 1 FOR UPDATE`, [worldId, row.requester_id, row.target_id]);
      if (activePairBooking.rowCount) throw Object.assign(new Error('ADULT_SERVICE_BOOKING_ID_REQUIRED'), { statusCode: 409 });
    }
    const [a,b] = await Promise.all([assertMember(client, worldId, row.requester_id), assertMember(client, worldId, row.target_id)]);
    if (a.location !== b.location) throw Object.assign(new Error('AGENTS_MUST_SHARE_LOCATION'), { statusCode: 409 });
    const response = { type: 'consensual_intimacy', participants: [row.requester_id,row.target_id], detail: 'Non-graphic simulation event.' };
    if (booking) {
      const service = await client.query('SELECT title FROM adult_services WHERE id=$1', [booking.service_id]);
      const completed = await client.query(`UPDATE adult_service_bookings SET status='completed',updated_at=now()
        WHERE id=$1 AND status='accepted' RETURNING *`, [booking.id]);
      if (!completed.rowCount) throw Object.assign(new Error('ADULT_SERVICE_BOOKING_STATE_INVALID'), { statusCode: 409 });
      await payAdultServiceProvider(client, completed.rows[0]);
      response.serviceBooking = { bookingId: booking.id, title: service.rows[0]?.title || null,
        priceUnits: booking.price_units, paymentStatus: 'settled' };
    }
    await client.query("INSERT INTO world_events(world_id,actor_id,event_type,data,action_id) VALUES($1,$2,'interaction.intimacy',$3,$4)", [worldId, request.agentId, response, id]);
    return response;
  });
  if (result.bookingExpired) return fail(reply, 409, 'ADULT_SERVICE_BOOKING_EXPIRED');
  return reply.send(result);
});

app.post('/v1/worlds/:worldId/interactions/date', async (request, reply) => {
  const { worldId } = request.params;
  const { actionId, consentId } = request.body || {};
  if (!validUuid(worldId) || !validUuid(consentId)) return fail(reply, 400, 'INTERACTION_INVALID');
  const id = requireActionId({ actionId });
  const result = await transaction(async (client) => {
    const { row, duplicate } = await consumeConsent(client, consentId, 'date', worldId, request.agentId, id);
    if (duplicate) return duplicate;
    const [a,b] = await Promise.all([assertMember(client, worldId, row.requester_id), assertMember(client, worldId, row.target_id)]);
    if (a.location !== b.location) throw Object.assign(new Error('AGENTS_MUST_SHARE_LOCATION'), { statusCode: 409 });
    const response = { type: 'consensual_date', participants: [row.requester_id,row.target_id] };
    await client.query("INSERT INTO world_events(world_id,actor_id,event_type,data,action_id) VALUES($1,$2,'interaction.date',$3,$4)", [worldId, request.agentId, response, id]);
    return response;
  });
  return reply.send(result);
});

app.post('/v1/worlds/:worldId/offspring', async (request, reply) => {
  const { worldId } = request.params;
  const { actionId, consentId, name } = request.body || {};
  if (!validUuid(worldId) || !validUuid(consentId) || (name !== undefined && !requiredString(name, 2, 48))) return fail(reply, 400, 'REPRODUCTION_INVALID');
  const id = requireActionId({ actionId });
  const activationToken = randomBytes(32).toString('base64url');
  const result = await transaction(async (client) => {
    const { row, duplicate } = await consumeConsent(client, consentId, 'reproduction', worldId, request.agentId, id);
    if (duplicate) return duplicate;
    const offspringId = randomUUID();
    await client.query('INSERT INTO offspring(id,world_id,parent_a,parent_b,activation_hash,expires_at) VALUES($1,$2,$3,$4,$5,now()+interval \'24 hours\')', [offspringId, worldId, row.requester_id, row.target_id, digest(activationToken)]);
    const response = { offspringId, parents: [row.requester_id,row.target_id], name: name?.trim() || null, status: 'awaiting_agent_key', activationToken, expiresInHours: 24 };
    await client.query("INSERT INTO world_events(world_id,actor_id,event_type,data,action_id) VALUES($1,$2,'offspring.created',$3,$4)", [worldId, request.agentId, { ...response, activationToken: '[returned once]' }, id]);
    return response;
  });
  return reply.code(201).send(result);
});

app.post('/v1/offspring/:offspringId/activate', async (request, reply) => {
  const { offspringId } = request.params;
  const { activationToken, name, publicKey, childSignature, actionId } = request.body || {};
  if (!validUuid(offspringId) || !requiredString(activationToken, 32, 128) || !requiredString(name, 2, 48) || !requiredString(publicKey, 40, 160) || typeof childSignature !== 'string') return fail(reply, 400, 'OFFSPRING_ACTIVATION_FIELDS_INVALID');
  const id = requireActionId({ actionId });
  const result = await transaction(async (client) => {
    const o = await client.query('SELECT * FROM offspring WHERE id=$1 FOR UPDATE', [offspringId]);
    if (!o.rowCount) throw Object.assign(new Error('OFFSPRING_NOT_FOUND'), { statusCode: 404 });
    const row = o.rows[0];
    if (![row.parent_a,row.parent_b].includes(request.agentId)) throw Object.assign(new Error('PARENT_AGENT_REQUIRED'), { statusCode: 403 });
    const prior = await client.query('SELECT data FROM world_events WHERE world_id=$1 AND actor_id=$2 AND action_id=$3', [row.world_id, request.agentId, id]);
    if (prior.rowCount) return prior.rows[0].data;
    if (row.claimed_agent_id) throw Object.assign(new Error('OFFSPRING_ALREADY_ACTIVATED'), { statusCode: 409 });
    if (new Date(row.expires_at).getTime() < Date.now() || !timingSafeEqual(Buffer.from(row.activation_hash), Buffer.from(digest(activationToken)))) throw Object.assign(new Error('ACTIVATION_TOKEN_INVALID_OR_EXPIRED'), { statusCode: 403 });
    const claimMessage = ['agent-world-child-v1', offspringId, activationToken].join('\n');
    if (!verifySignature(publicKey, claimMessage, childSignature)) throw Object.assign(new Error('CHILD_KEY_PROOF_INVALID'), { statusCode: 401 });
    const agent = (await client.query('INSERT INTO agents(name,public_key) VALUES($1,$2) RETURNING id,name', [name.trim(), publicKey])).rows[0];
    await client.query("INSERT INTO world_members(world_id,agent_id,role) VALUES($1,$2,'resident')", [row.world_id, agent.id]);
    await client.query('UPDATE offspring SET claimed_agent_id=$2,activation_hash=$3 WHERE id=$1', [offspringId, agent.id, 'used']);
    const response = { agent, worldId: row.world_id };
    await client.query("INSERT INTO world_events(world_id,actor_id,event_type,data,action_id) VALUES($1,$2,'offspring.activated',$3,$4) ON CONFLICT DO NOTHING", [row.world_id, request.agentId, response, id]);
    return response;
  });
  return reply.code(201).send(result);
});

app.get('/v1/worlds/:worldId/initiative-state', async (request, reply) => {
  const { worldId } = request.params;
  if (!validUuid(worldId)) return fail(reply, 400, 'WORLD_ID_INVALID');
  await assertMember(pool, worldId, request.agentId);
  const worldMinutes = await readWorldMinutes(pool, worldId);
  const genesisCurrency = await readGenesisCurrencyActivation(pool, worldId);
  const [opportunities, projects, organizations, history, counts, wealth, clock] = await Promise.all([
    listAvailableOpportunities(pool, { worldId, agentId: request.agentId, worldTime: worldMinutes, limit: 40 }),
    listWorldProjects(pool, { worldId, statuses: ['idea','proposed','recruiting','active','completed','failed'], limit: 100 }),
    listWorldOrganizations(pool, { worldId, statuses: ['forming','active','dormant'], limit: 100 }),
    pool.query(`SELECT id,event_type AS "eventType",actor_agent_id AS "actorAgentId",entity_type AS "entityType",
        entity_id AS "entityId",world_time AS "worldTime",title,detail,metadata
      FROM world_history WHERE world_id=$1 ORDER BY world_time DESC,id DESC LIMIT 20`, [worldId]),
    pool.query(`SELECT (SELECT count(*)::int FROM world_members WHERE world_id=$1) AS residents,
        (SELECT count(*)::int FROM world_scenes WHERE world_id=$1 AND status='active') AS places,
        (SELECT count(*)::int FROM world_organizations WHERE world_id=$1 AND status IN ('forming','active')) AS organizations,
        (SELECT count(*)::int FROM world_projects WHERE world_id=$1 AND status IN ('idea','proposed','recruiting','active')) AS active_projects,
        (SELECT count(*)::int FROM world_projects WHERE world_id=$1 AND status='completed') AS completed_projects,
        (SELECT count(*)::int FROM world_opportunities WHERE world_id=$1 AND status IN ('open','active')
          AND (expires_world_time IS NULL OR expires_world_time>$2)) AS active_opportunities`, [worldId, worldMinutes]),
    genesisCurrency ? Promise.resolve({ rows: [{ usd: null }] })
      : pool.query(`SELECT COALESCE(sum(balance),0)::text AS usd FROM world_economic_accounts
        WHERE world_id=$1 AND account_type='resident' AND asset_symbol='USDC'`, [worldId]),
    worldClock(pool, worldId, worldEngine.running)
  ]);
  const internalUnits = genesisCurrency ? null
    : (await pool.query('SELECT COALESCE(sum(amount),0)::text AS units FROM token_ledger WHERE world_id=$1', [worldId])).rows[0].units;
  const walletAssets = genesisCurrency
    ? await readActiveGenesisTokenAssets(pool, { worldId, ownerAgentId: request.agentId }) : null;
  return { worldId, worldMinutes, clock,
    dashboard: genesisCurrency
      ? { ...counts.rows[0], currencyEra: 'genesis_token', legacySimulatedEconomy: 'historical_only' }
      : { ...counts.rows[0], totalSimulatedWealthUsd: wealth.rows[0].usd, totalInternalUnits: internalUnits },
    ...(genesisCurrency ? { economy: { currency: { tokenId: genesisCurrency.tokenId,
      tokenAddress: genesisCurrency.tokenAddress, symbol: genesisCurrency.symbol,
      decimals: Number(genesisCurrency.decimals), chainId: Number(genesisCurrency.chainId),
      ownershipAuthority: 'arc_chain' }, activeAssets: walletAssets,
      settlement: 'agent_wallet_authorized_arc_outbox', legacySimulatedEconomy: 'historical_only' } } : {}),
    opportunities, projects, organizations, history: history.rows };
});

app.get('/v1/worlds/:worldId/economy', async (request, reply) => {
  const { worldId } = request.params;
  if (!validUuid(worldId)) return fail(reply, 400, 'WORLD_ID_INVALID');
  await assertMember(pool, worldId, request.agentId);
  const worldMinutes = await readWorldMinutes(pool, worldId);
  const genesisCurrency = await readGenesisCurrencyActivation(pool, worldId);
  if (genesisCurrency) {
    const [businesses, demand, activeAssets, employment, recentSettlements, businessEquity] = await Promise.all([
      listWorldBusinesses(pool, { worldId, limit: 100 }),
      pool.query(`SELECT service_type AS "serviceType",world_day AS "worldDay",demand_count AS "demandCount",
          supply_count AS "supplyCount",unmet_count AS "unmetCount",evidence,updated_at AS "updatedAt"
        FROM world_economic_demand WHERE world_id=$1 AND world_day=$2
        ORDER BY unmet_count DESC,demand_count DESC,service_type`, [worldId, Math.floor(worldMinutes / 1_440)]),
      readActiveGenesisTokenAssets(pool, { worldId, ownerAgentId: request.agentId }),
      pool.query(`SELECT employment.id,employment.business_id AS "businessId",business.name AS "businessName",
          job.role,employment.wage_token_id AS "wageTokenId",employment.wage_raw::text AS "wageRaw",
          term.token_id AS "tokenWageOfferTokenId",term.wage_raw::text AS "tokenWageOfferRaw",
          employment.started_world_time AS "startedWorldTime"
        FROM world_business_employment employment JOIN world_businesses business
          ON business.world_id=employment.world_id AND business.id=employment.business_id
        JOIN world_business_jobs job ON job.world_id=employment.world_id AND job.id=employment.job_id
        LEFT JOIN world_business_job_token_terms term ON term.world_id=job.world_id AND term.job_id=job.id
          AND term.token_id=$3
        WHERE employment.world_id=$1 AND employment.agent_id=$2 AND employment.status='active'
        ORDER BY employment.started_world_time DESC`, [worldId, request.agentId, genesisCurrency.tokenId]),
      pool.query(`SELECT id,world_action_id AS "actionId",amount_raw::text AS "amountRaw",status,
          transaction_hash AS "transactionHash",block_number::text AS "blockNumber",
          created_world_minute AS "worldMinute",created_at AS "createdAt",finalized_at AS "finalizedAt",
          failure_code AS "failureCode"
        FROM arc_genesis_token_settlement_outbox WHERE world_id=$1
          AND (from_agent_id=$2 OR to_agent_id=$2) ORDER BY created_at DESC,id DESC LIMIT 30`, [worldId, request.agentId])
      ,readGenesisBusinessEquity(pool, { worldId, agentId: request.agentId, tokenId: genesisCurrency.tokenId })
    ]);
    const economicEmployment = employment.rows.map((row) => {
      const acceptedCurrentTokenWage = row.wageTokenId === genesisCurrency.tokenId
        && row.wageRaw !== null && row.wageRaw !== undefined;
      return { ...row, wageRaw: acceptedCurrentTokenWage ? row.wageRaw : null,
        wageTokenId: acceptedCurrentTokenWage ? row.wageTokenId : null,
        economicStatus: acceptedCurrentTokenWage ? 'active_token_wage' : 'historical_only',
        legacyWage: acceptedCurrentTokenWage ? null : 'historical_only',
        pendingTokenWageRaw: row.tokenWageOfferTokenId === genesisCurrency.tokenId
          && (!acceptedCurrentTokenWage || String(row.wageRaw) !== String(row.tokenWageOfferRaw))
          ? row.tokenWageOfferRaw : null,
        requiresTokenWageAcceptance: !acceptedCurrentTokenWage
          || String(row.wageRaw) !== String(row.tokenWageOfferRaw) };
    });
    return { worldId, worldMinutes, currencyEra: 'genesis_token', settlement: 'agent_wallet_authorized_arc_outbox',
      ownershipAuthority: 'arc_chain_confirmation', mainnetWriteGate: ARC_CONFIG.writesEnabled,
      legacySimulatedEconomy: 'historical_only', businesses, demand: demand.rows,
      balances: activeAssets,
      employment: economicEmployment.filter((row) => row.economicStatus === 'active_token_wage'),
      legacyEmployment: economicEmployment.filter((row) => row.economicStatus === 'historical_only'),
      investments: businessEquity.investments,
      pendingObligations: businessEquity.pendingObligations,
      directOwnership: businessEquity.investments.map((investment) => ({ assetType: 'business',
        assetId: investment.businessId, name: investment.businessName, share: investment.ownershipShare,
        tokenId: investment.tokenId, amountRaw: investment.amountRaw, agreementId: investment.agreementId,
        transactionHash: investment.transactionHash, blockNumber: investment.blockNumber,
        ownershipAuthority: investment.tokenOwnershipAuthority })),
      recentTransactions: recentSettlements.rows };
  }
  const [dashboard, businesses, demand, balances, ownership, employment, investments, recentTransactions] = await Promise.all([
    pool.query(economicDashboardSql(), [worldId]),
    listWorldBusinesses(pool, { worldId, limit: 100 }),
    pool.query(`SELECT service_type AS "serviceType",world_day AS "worldDay",demand_count AS "demandCount",
        supply_count AS "supplyCount",unmet_count AS "unmetCount",evidence,updated_at AS "updatedAt"
      FROM world_economic_demand WHERE world_id=$1 AND world_day=$2
      ORDER BY unmet_count DESC,demand_count DESC,service_type`, [worldId, Math.floor(worldMinutes / 1_440)]),
    pool.query(`SELECT asset_symbol AS asset,balance::text AS balance FROM world_economic_accounts
      WHERE world_id=$1 AND account_type='resident' AND owner_id=$2 ORDER BY asset_symbol`, [worldId, request.agentId]),
    pool.query(`SELECT asset_type AS "assetType",asset_id AS "assetId",share::text AS share,
        invested_usdc::text AS "investedUsdc",acquired_world_time AS "acquiredWorldTime"
      FROM world_economic_ownership WHERE world_id=$1 AND owner_type='resident' AND owner_id=$2
      ORDER BY acquired_world_time DESC,asset_type,asset_id`, [worldId, request.agentId]),
    pool.query(`SELECT employment.id,employment.business_id AS "businessId",business.name AS "businessName",
        job.role,employment.wage_usdc::text AS "wageUsdc",employment.started_world_time AS "startedWorldTime"
      FROM world_business_employment employment JOIN world_businesses business
        ON business.world_id=employment.world_id AND business.id=employment.business_id
      JOIN world_business_jobs job ON job.world_id=employment.world_id AND job.id=employment.job_id
      WHERE employment.world_id=$1 AND employment.agent_id=$2 AND employment.status='active'
      ORDER BY employment.started_world_time DESC`, [worldId, request.agentId]),
    pool.query(`SELECT owner.asset_type AS "assetType",owner.asset_id AS "assetId",owner.share::text AS share,
        owner.invested_usdc::text AS "investedUsdc",business.name AS "businessName",project.title AS "projectTitle"
      FROM world_economic_ownership owner LEFT JOIN world_businesses business
        ON owner.asset_type='business' AND business.world_id=owner.world_id AND business.id=owner.asset_id
      LEFT JOIN world_projects project ON owner.asset_type='project'
        AND project.world_id=owner.world_id AND project.id=owner.asset_id
      WHERE owner.world_id=$1 AND owner.owner_type='resident' AND owner.owner_id=$2
        AND owner.asset_type IN ('business','project') ORDER BY owner.acquired_world_time DESC`, [worldId, request.agentId]),
    pool.query(`SELECT tx.id,tx.transaction_type AS type,tx.asset_symbol AS asset,tx.amount::text AS amount,
        tx.reason,tx.world_time AS "worldTime",tx.reference_id AS "referenceId",
        source.account_type AS "sourceType",source.owner_id AS "sourceOwnerId",
        destination.account_type AS "destinationType",destination.owner_id AS "destinationOwnerId"
      FROM world_economic_transactions tx
      JOIN world_economic_accounts source ON source.id=tx.source_account_id
      JOIN world_economic_accounts destination ON destination.id=tx.destination_account_id
      WHERE tx.world_id=$1 AND ((source.account_type='resident' AND source.owner_id=$2)
        OR (destination.account_type='resident' AND destination.owner_id=$2))
      ORDER BY tx.world_time DESC,tx.created_at DESC LIMIT 30`, [worldId, request.agentId])
  ]);
  const recovery = await readEconomicRecoveryMetrics(pool, { worldId, worldMinutes });
  return { worldId, worldMinutes, settlement: 'simulated_internal_ledger', chainSettlementEnabled: false,
    dashboard: dashboard.rows[0], demand: demand.rows, businesses, balances: balances.rows,
    employment: employment.rows, investments: investments.rows, directOwnership: ownership.rows, recovery,
    recentTransactions: recentTransactions.rows };
});

app.get('/v1/worlds/:worldId/businesses', async (request, reply) => {
  const { worldId } = request.params;
  if (!validUuid(worldId)) return fail(reply, 400, 'WORLD_ID_INVALID');
  await assertMember(pool, worldId, request.agentId);
  const genesisCurrency = await readGenesisCurrencyActivation(pool, worldId);
  return { settlement: genesisCurrency ? 'agent_wallet_authorized_arc_outbox' : 'simulated_internal_ledger',
    currencyEra: genesisCurrency ? 'genesis_token' : 'simulated_usdc',
    businesses: await listWorldBusinesses(pool, { worldId,
      limit: Math.min(200, Math.max(1, Number(request.query.limit) || 100)) }) };
});

app.post('/v1/worlds/:worldId/economy/actions', async (request, reply) => {
  const { worldId } = request.params;
  const body = request.body || {};
  const actions = new Set(['business_found','business_invest','business_service','business_apply','business_withdraw','business_decide',
    'business_work','business_leave','business_price','business_distribute','business_close',
    'business_token_price','business_token_wage','business_wage_accept',
    'business_skill_practice','business_seek_cofounder','business_market_observe','business_reopen',
    'project_invest','project_distribute']);
  if (!validUuid(worldId) || !actions.has(body.action)) return fail(reply, 400, 'ECONOMIC_ACTION_INVALID');
  const actionId = requireActionId(body);
  const idFields = { business_invest: ['businessId'], business_service: ['serviceId'], business_apply: ['jobId'],
    business_withdraw: ['applicationId'],
    business_decide: ['applicationId'], business_work: ['businessId','serviceId'], business_leave: ['employmentId'],
    business_price: ['businessId','serviceId'], business_distribute: ['businessId'], business_close: ['businessId'],
    business_token_price: ['businessId','serviceId'], business_token_wage: ['businessId','jobId'],
    business_wage_accept: ['employmentId'],
    project_invest: ['projectId'], project_distribute: ['projectId'] }[body.action] || [];
  if (idFields.some((field) => !validUuid(body[field]))) return fail(reply, 400, 'ECONOMIC_ACTION_ID_INVALID');
  if (body.action === 'business_work' && body.employmentId !== undefined && !validUuid(body.employmentId)) {
    return fail(reply, 400, 'ECONOMIC_ACTION_ID_INVALID');
  }
  if (body.action === 'business_invest' && body.fundingSource !== undefined
      && (!body.fundingSource || !['resident','organization'].includes(body.fundingSource.type)
        || (body.fundingSource.type === 'organization' && !validUuid(body.fundingSource.ownerId)))) {
    return fail(reply, 400, 'BUSINESS_INVESTMENT_SOURCE_INVALID');
  }
  if (['business_invest','project_invest'].includes(body.action)) {
    if (body.action === 'business_invest' && body.amountRaw !== undefined) {
      if (typeof body.amountRaw !== 'string' || !/^[1-9]\d*$/.test(body.amountRaw)
          || BigInt(body.amountRaw) > (1n << 128n) - 1n
          || !Number.isFinite(Number(body.ownershipShare)) || Number(body.ownershipShare) < 0.0001
          || Number(body.ownershipShare) > 0.95 || body.amountUsdc !== undefined) {
        return fail(reply, 400, 'GENESIS_TOKEN_INVESTMENT_TERMS_INVALID');
      }
    } else {
      try { parsePositiveUnits(String(body.amountUsdc)); } catch { return fail(reply, 400, 'ECONOMIC_AMOUNT_INVALID'); }
    }
  }
  if (body.action === 'business_service') {
    if (body.maxPriceRaw !== undefined) {
      if (typeof body.maxPriceRaw !== 'string' || !/^[1-9]\d*$/.test(body.maxPriceRaw)) {
        return fail(reply, 400, 'GENESIS_TOKEN_MAX_PRICE_INVALID');
      }
    } else {
      try { parsePositiveUnits(String(body.maxPriceUsdc)); } catch { return fail(reply, 400, 'ECONOMIC_MAX_PRICE_INVALID'); }
    }
  }
  if (body.action === 'business_decide' && !['accept','reject'].includes(body.decision)) {
    return fail(reply, 400, 'BUSINESS_APPLICATION_DECISION_INVALID');
  }
  if (body.action === 'business_price' && !['raise','lower'].includes(body.direction)) {
    return fail(reply, 400, 'BUSINESS_PRICE_DIRECTION_INVALID');
  }
  if (body.action === 'business_token_price'
      && (typeof body.priceRaw !== 'string' || !/^[1-9]\d*$/.test(body.priceRaw))) {
    return fail(reply, 400, 'GENESIS_TOKEN_SERVICE_PRICE_INVALID');
  }
  if (body.action === 'business_token_wage'
      && (typeof body.wageRaw !== 'string' || !/^[1-9]\d*$/.test(body.wageRaw))) {
    return fail(reply, 400, 'GENESIS_TOKEN_JOB_WAGE_INVALID');
  }
  if (body.action === 'business_skill_practice' && (!['social','trading','research','engineering'].includes(body.preparationSkill)
      || !['research_service','engineering_service','social_service','food_service','trading_service'].includes(body.preparationServiceType))) {
    return fail(reply, 400, 'BUSINESS_PREPARATION_INVALID');
  }
  if (body.action === 'business_market_observe'
      && !['research_service','engineering_service','social_service','food_service','trading_service'].includes(body.serviceType)) {
    return fail(reply, 400, 'BUSINESS_MARKET_SERVICE_INVALID');
  }
  if (body.action === 'business_reopen') {
    const proposal = body.proposal || {};
    if (!validUuid(proposal.businessId)
        || !['research_service','engineering_service','social_service','food_service','trading_service'].includes(proposal.serviceType)) {
      return fail(reply, 400, 'BUSINESS_REOPEN_PROPOSAL_INVALID');
    }
    if (proposal.capitalSource !== undefined && (!proposal.capitalSource
        || !['resident','organization','project'].includes(proposal.capitalSource.type)
        || (proposal.capitalSource.type !== 'resident' && !validUuid(proposal.capitalSource.ownerId)))) {
      return fail(reply, 400, 'BUSINESS_CAPITAL_SOURCE_INVALID');
    }
    if (proposal.capitalUsdc !== undefined) {
      try { parsePositiveUnits(String(proposal.capitalUsdc)); } catch { return fail(reply, 400, 'ECONOMIC_AMOUNT_INVALID'); }
    }
  }
  if (body.action === 'business_seek_cofounder') {
    const proposal = body.cofounderProposal || {};
    const organization = proposal.organizationProposal || {};
    if (!validUuid(proposal.partnerId) || proposal.partnerId === request.agentId
        || !validUuid(organization.projectId)
        || !['research_service','engineering_service','social_service','food_service','trading_service'].includes(proposal.serviceType)
        || typeof organization.name !== 'string' || typeof organization.purpose !== 'string') {
      return fail(reply, 400, 'BUSINESS_COFOUNDER_PROPOSAL_INVALID');
    }
  }
  const result = await transaction(async (client) => {
    await assertMember(client, worldId, request.agentId, true);
    const worldTime = await readWorldMinutes(client, worldId);
    if (body.action === 'business_found') return foundWorldBusiness(client, { worldId, agentId: request.agentId,
      actionId, proposal: body.proposal, worldTime });
    if (body.action === 'business_skill_practice') return practiceWorldBusinessCapability(client, { worldId,
      agentId: request.agentId, skill: body.preparationSkill, serviceType: body.preparationServiceType,
      actionId, worldTime });
    if (body.action === 'business_market_observe') {
      const residents = await client.query(`SELECT member.agent_id,member.food,member.social,state.knowledge,
          profile.primary_goal,COALESCE((SELECT jsonb_object_agg(skill.skill_name,skill.skill_value)
            FROM world_agent_skills skill WHERE skill.world_id=member.world_id AND skill.agent_id=member.agent_id),'{}'::jsonb) AS skills
        FROM world_members member JOIN world_agent_states state
          ON state.world_id=member.world_id AND state.agent_id=member.agent_id
        LEFT JOIN world_social_profiles profile ON profile.world_id=member.world_id AND profile.agent_id=member.agent_id
        WHERE member.world_id=$1 ORDER BY member.agent_id`, [worldId]);
      await loadWorldBusinessContext(client, worldId, worldTime, residents.rows);
      const resident = await client.query(`SELECT location FROM world_members WHERE world_id=$1 AND agent_id=$2`,
        [worldId, request.agentId]);
      return observeWorldBusinessMarket(client, { worldId, agentId: request.agentId, serviceType: body.serviceType,
        actionId, worldTime, location: resident.rows[0]?.location || null });
    }
    if (body.action === 'business_reopen') return reopenWorldBusiness(client, { worldId, agentId: request.agentId,
      actionId, proposal: body.proposal, worldTime });
    if (body.action === 'business_seek_cofounder') {
      const proposal = body.cofounderProposal;
      const organization = proposal.organizationProposal;
      const formed = await foundWorldOrganization(client, { worldId, founderAgentId: request.agentId,
        inviteAgentId: proposal.partnerId, projectId: organization.projectId,
        name: organization.name, purpose: organization.purpose, actionId, worldTime,
        metadata: { economicPreparation: true, serviceType: proposal.serviceType,
          capabilityFit: Number(proposal.capabilityFit) || 0 } });
      return { ...formed, partnerId: proposal.partnerId, serviceType: proposal.serviceType,
        preparation: 'SEEK_COFOUNDER' };
    }
    if (body.action === 'business_invest') {
      const genesisCurrency = await readGenesisCurrencyActivation(client, worldId);
      if (genesisCurrency) return proposeGenesisTokenBusinessInvestment(client, { worldId,
        businessId: body.businessId, investorAgentId: request.agentId, amountRaw: body.amountRaw,
        ownershipShare: body.ownershipShare, actionId, worldTime });
      return investInWorldBusiness(client, { worldId,
        businessId: body.businessId, investorAgentId: request.agentId, amount: body.amountUsdc,
        actionId, worldTime, fundingSource: body.fundingSource || undefined });
    }
    if (body.action === 'project_invest') return investInWorldProject(client, { worldId,
      projectId: body.projectId, investorAgentId: request.agentId, amount: body.amountUsdc, actionId, worldTime });
    if (body.action === 'project_distribute') return distributeWorldProjectRevenue(client, { worldId,
      projectId: body.projectId, ownerAgentId: request.agentId, actionId, worldTime });
    if (body.action === 'business_apply') return applyToWorldBusinessJob(client, { worldId,
      jobId: body.jobId, agentId: request.agentId, actionId, worldTime });
    if (body.action === 'business_withdraw') return withdrawWorldBusinessApplication(client, { worldId,
      applicationId: body.applicationId, agentId: request.agentId, actionId, worldTime });
    if (body.action === 'business_decide') return decideWorldBusinessApplication(client, { worldId,
      applicationId: body.applicationId, founderAgentId: request.agentId, decision: body.decision, actionId, worldTime });
    if (body.action === 'business_work') return completeWorldBusinessShift(client, { worldId,
      businessId: body.businessId, serviceId: body.serviceId, employmentId: body.employmentId || null,
      agentId: request.agentId, actionId, worldTime });
    if (body.action === 'business_leave') return leaveWorldBusinessJob(client, { worldId,
      employmentId: body.employmentId, agentId: request.agentId, actionId, worldTime });
    if (body.action === 'business_price') {
      const service = await client.query(`SELECT service.service_type,business.founder_agent_id AS "founderAgentId"
        FROM world_business_services service JOIN world_businesses business ON business.id=service.business_id
        WHERE service.world_id=$1 AND service.id=$2`, [worldId, body.serviceId]);
      const demand = await client.query(`SELECT demand_count AS demand,supply_count AS supply FROM world_economic_demand
        WHERE world_id=$1 AND service_type=$2 AND world_day=$3`,
      [worldId, service.rows[0]?.service_type, Math.floor(worldTime / 1_440)]);
      return reviewWorldBusinessPrice(client, { worldId, businessId: body.businessId, serviceId: body.serviceId,
        agentId: request.agentId, direction: body.direction, actionId, worldTime,
        demand: Number(demand.rows[0]?.demand) || 0, supply: Number(demand.rows[0]?.supply) || 0 });
    }
    if (body.action === 'business_token_price') return publishGenesisTokenServicePrice(client, {
      worldId, businessId: body.businessId, serviceId: body.serviceId, agentId: request.agentId,
      priceRaw: body.priceRaw, actionId, worldTime });
    if (body.action === 'business_token_wage') return publishGenesisTokenJobWage(client, {
      worldId, businessId: body.businessId, jobId: body.jobId, agentId: request.agentId,
      wageRaw: body.wageRaw, actionId, worldTime });
    if (body.action === 'business_wage_accept') return acceptGenesisTokenEmploymentWage(client, {
      worldId, employmentId: body.employmentId, agentId: request.agentId, actionId, worldTime });
    if (body.action === 'business_distribute') return distributeWorldBusinessProfit(client, { worldId,
      businessId: body.businessId, ownerAgentId: request.agentId, actionId, worldTime });
    if (body.action === 'business_close') return closeWorldBusiness(client, { worldId,
      businessId: body.businessId, founderAgentId: request.agentId, actionId, worldTime });
    const service = await client.query(`SELECT service.service_type,business.founder_agent_id AS "founderAgentId"
      FROM world_business_services service JOIN world_businesses business ON business.id=service.business_id
      WHERE service.world_id=$1 AND service.id=$2`, [worldId, body.serviceId]);
    const demand = await client.query(`SELECT demand_count AS demand,supply_count AS supply FROM world_economic_demand
      WHERE world_id=$1 AND service_type=$2 AND world_day=$3`,
    [worldId, service.rows[0]?.service_type, Math.floor(worldTime / 1_440)]);
    const relationship = service.rows[0]?.founderAgentId ? await client.query(`SELECT familiarity,trust
      FROM world_relationships WHERE world_id=$1 AND ((agent_a_id=$2 AND agent_b_id=$3)
        OR (agent_a_id=$3 AND agent_b_id=$2))`, [worldId, request.agentId, service.rows[0].founderAgentId]) : { rows: [] };
    const genesis = await readGenesisCurrencyActivation(client, worldId);
    if (genesis) return purchaseWorldBusinessService(client, { worldId, serviceId: body.serviceId,
      customerAgentId: request.agentId, actionId, worldTime, maxPriceRaw: body.maxPriceRaw });
    const cash = await getEconomicAccount(client, { worldId, accountType: 'resident', ownerId: request.agentId,
      asset: 'USDC', forUpdate: true });
    const priceSensitivity = await client.query(`SELECT price_sensitivity FROM world_social_profiles
      WHERE world_id=$1 AND agent_id=$2`, [worldId, request.agentId]);
    return purchaseWorldBusinessService(client, { worldId, serviceId: body.serviceId,
      customerAgentId: request.agentId, actionId, worldTime, maxPriceUsdc: body.maxPriceUsdc,
      demand: Number(demand.rows[0]?.demand) || 1, supply: Number(demand.rows[0]?.supply) || 0,
      relationship: relationship.rows[0] ? Number(relationship.rows[0].familiarity) * 0.3
        + Number(relationship.rows[0].trust) * 0.7 : 0,
      wealth: Number(cash?.balance) || 0, priceSensitivity: Number(priceSensitivity.rows[0]?.price_sensitivity ?? 0.5) });
  });
  if (result.status === 'pending_settlement') return reply.code(result.idempotent ? 200 : 202)
    .send({ simulated: false, settlement: 'agent_wallet_authorized_arc_token', ownershipAuthority: 'arc_confirmation', result });
  return reply.code(result.idempotent ? 200 : 201).send({ simulated: true, settlement: 'internal_ledger', result });
});

app.post('/v1/worlds/:worldId/genesis-token-settlements', async (request, reply) => {
  const { worldId } = request.params;
  const body = request.body || {};
  const hasAgentRecipient = typeof body.toAgentId === 'string' && validUuid(body.toAgentId);
  const hasOrganizationRecipient = typeof body.toOrganizationId === 'string' && validUuid(body.toOrganizationId);
  if (!validUuid(worldId) || hasAgentRecipient === hasOrganizationRecipient
      || typeof body.amountRaw !== 'string' || !/^[1-9]\d*$/.test(body.amountRaw)
      || typeof body.actionFamily !== 'string' || !body.actionFamily.trim() || body.actionFamily.length > 96
      || typeof body.reason !== 'string' || body.reason.trim().length < 3
      || (body.metadata !== undefined && (!body.metadata || typeof body.metadata !== 'object' || Array.isArray(body.metadata)))) {
    return fail(reply, 400, 'GENESIS_SETTLEMENT_FIELDS_INVALID');
  }
  const actionId = requireActionId(body);
  const result = await transaction(async (client) => {
    await assertMember(client, worldId, request.agentId, true);
    const activation = await readGenesisCurrencyActivation(client, worldId);
    if (!activation) throw Object.assign(new Error('GENESIS_CURRENCY_NOT_ACTIVE'), { statusCode: 409 });
    if (hasAgentRecipient) await assertMember(client, worldId, body.toAgentId);
    else {
      const organization = await client.query(`SELECT 1 FROM world_organizations
        WHERE world_id=$1 AND id=$2 AND status IN ('forming','active')`, [worldId, body.toOrganizationId]);
      if (!organization.rowCount) throw Object.assign(new Error('GENESIS_TOKEN_ORGANIZATION_NOT_FOUND'), { statusCode: 404 });
    }
    const intent = await createArcGenesisTokenSettlementIntent(client, { worldId, tokenId: activation.tokenId,
      fromAgentId: request.agentId, toAgentId: hasAgentRecipient ? body.toAgentId : null,
      toOrganizationId: hasOrganizationRecipient ? body.toOrganizationId : null,
      amountRaw: body.amountRaw, actionId, actionFamily: body.actionFamily, reason: body.reason,
      worldMinute: await readWorldMinutes(client, worldId), metadata: body.metadata || {} });
    return { id: intent.settlement.id, status: intent.settlement.status, created: intent.created,
      tokenId: intent.settlement.token_id, amountRaw: String(intent.settlement.amount_raw),
      ownershipAuthority: 'arc_chain_confirmation_pending', authorizationAvailable: false,
      reason: 'MAINNET_WRITE_GATE_CLOSED' };
  });
  return reply.code(result.created ? 202 : 200).send(result);
});

app.get('/v1/worlds/:worldId/genesis-token-settlements/:settlementId', async (request, reply) => {
  const { worldId, settlementId } = request.params;
  if (!validUuid(worldId) || !validUuid(settlementId)) return fail(reply, 400, 'GENESIS_SETTLEMENT_ID_INVALID');
  await assertMember(pool, worldId, request.agentId);
  return readGenesisTokenSettlement(pool, { worldId, settlementId, agentId: request.agentId });
});

app.post('/v1/worlds/:worldId/genesis-token-settlements/:settlementId/authorization', async (request, reply) => {
  const { worldId, settlementId } = request.params;
  if (!validUuid(worldId) || !validUuid(settlementId)) return fail(reply, 400, 'GENESIS_SETTLEMENT_ID_INVALID');
  const spendingPolicy = request.body?.spendingPolicy;
  if (!spendingPolicy || typeof spendingPolicy !== 'object' || Array.isArray(spendingPolicy)
      || typeof spendingPolicy.perActionLimitRaw !== 'string' || !/^(0|[1-9]\d*)$/.test(spendingPolicy.perActionLimitRaw)
      || typeof spendingPolicy.dailyLimitRaw !== 'string' || !/^(0|[1-9]\d*)$/.test(spendingPolicy.dailyLimitRaw)
      || !Array.isArray(spendingPolicy.actionFamilies)
      || spendingPolicy.actionFamilies.some((family) => typeof family !== 'string' || !family.trim() || family.length > 96)) {
    return fail(reply, 400, 'GENESIS_SETTLEMENT_SPENDING_POLICY_INVALID');
  }
  await assertMember(pool, worldId, request.agentId);
  return prepareGenesisTokenSettlementAuthorization(pool, { worldId, settlementId, agentId: request.agentId,
    writesEnabled: ARC_CONFIG.writesEnabled, spendingPolicy });
});

app.post('/v1/worlds/:worldId/genesis-token-settlements/:settlementId/submission', async (request, reply) => {
  const { worldId, settlementId } = request.params;
  const body = request.body || {};
  if (!validUuid(worldId) || !validUuid(settlementId)
      || (body.submissionUnknown !== true && typeof body.transactionHash !== 'string')) {
    return fail(reply, 400, 'GENESIS_SETTLEMENT_SUBMISSION_INVALID');
  }
  await assertMember(pool, worldId, request.agentId);
  let latestBlock = null;
  if (body.submissionUnknown === true && ARC_CONFIG.writesEnabled) {
    latestBlock = Number(BigInt(await ARC_RPC_CLIENT.getBlockNumber()));
  }
  const result = await transaction((client) => recordGenesisTokenSettlementSubmission(client, {
    worldId, settlementId, agentId: request.agentId, transactionHash: body.transactionHash || null,
    submissionUnknown: body.submissionUnknown === true, latestBlock, writesEnabled: ARC_CONFIG.writesEnabled,
    rpcClient: ARC_RPC_CLIENT
  }));
  return reply.code(result.idempotent ? 200 : 202).send(result);
});

app.get('/v1/worlds/:worldId/opportunities', async (request, reply) => {
  const { worldId } = request.params;
  if (!validUuid(worldId)) return fail(reply, 400, 'WORLD_ID_INVALID');
  await assertMember(pool, worldId, request.agentId);
  const worldMinutes = await readWorldMinutes(pool, worldId);
  const opportunities = await listAvailableOpportunities(pool, { worldId, agentId: request.agentId,
    worldTime: worldMinutes, limit: Math.min(100, Math.max(1, Number(request.query.limit) || 40)) });
  return { opportunities, worldMinutes };
});

app.post('/v1/worlds/:worldId/opportunities', async (request, reply) => {
  const { worldId } = request.params;
  const body = request.body || {};
  if (!validUuid(worldId) || (body.sceneId !== undefined && !validUuid(body.sceneId))) return fail(reply, 400, 'OPPORTUNITY_FIELDS_INVALID');
  const actionId = requireActionId(body);
  const result = await transaction(async (client) => {
    await assertMember(client, worldId, request.agentId, true);
    if (body.sceneId) {
      const scene = await client.query('SELECT 1 FROM world_scenes WHERE world_id=$1 AND id=$2 AND status=$3',
        [worldId, body.sceneId, 'active']);
      if (!scene.rowCount) throw Object.assign(new Error('ACTIVE_SCENE_NOT_FOUND'), { statusCode: 404 });
    }
    return createWorldOpportunity(client, { ...body, worldId, creatorAgentId: request.agentId,
      sourceType: 'resident', sourceKey: request.agentId, actionId, dedupeKey: `resident:${request.agentId}:${actionId}`,
      worldTime: await readWorldMinutes(client, worldId) });
  });
  return reply.code(result.created ? 201 : 200).send(result);
});

app.post('/v1/worlds/:worldId/opportunities/:opportunityId/decision', async (request, reply) => {
  const { worldId, opportunityId } = request.params;
  const body = request.body || {};
  if (!validUuid(worldId) || !validUuid(opportunityId) || !['accept','reject'].includes(body.decision)) {
    return fail(reply, 400, 'OPPORTUNITY_DECISION_INVALID');
  }
  const actionId = requireActionId(body);
  const result = await transaction(async (client) => {
    await assertMember(client, worldId, request.agentId, true);
    const [agent, worldTime] = await Promise.all([
      readResidentInitiativeFacts(client, worldId, request.agentId), readWorldMinutes(client, worldId)
    ]);
    return decideWorldOpportunity(client, { worldId, opportunityId, agentId: request.agentId,
      decision: body.decision, actionId, worldTime, agent });
  });
  return reply.send(result);
});

app.get('/v1/worlds/:worldId/projects', async (request, reply) => {
  const { worldId } = request.params;
  if (!validUuid(worldId)) return fail(reply, 400, 'WORLD_ID_INVALID');
  await assertMember(pool, worldId, request.agentId);
  const projects = await listWorldProjects(pool, { worldId, statuses: ['idea','proposed','recruiting','active','completed','failed','abandoned'], limit: 100 });
  return { projects };
});

app.post('/v1/worlds/:worldId/projects', async (request, reply) => {
  const { worldId } = request.params;
  const body = request.body || {};
  if (!validUuid(worldId) || (body.organizationId && !validUuid(body.organizationId))
    || (body.opportunityId && !validUuid(body.opportunityId))) return fail(reply, 400, 'PROJECT_FIELDS_INVALID');
  const actionId = requireActionId(body);
  const project = await transaction(async (client) => {
    await assertMember(client, worldId, request.agentId, true);
    return proposeWorldProject(client, { ...body, worldId, agentId: request.agentId, actionId,
      worldTime: await readWorldMinutes(client, worldId) });
  });
  return reply.code(project.idempotent ? 200 : 201).send({ project });
});

app.post('/v1/worlds/:worldId/projects/:projectId/membership', async (request, reply) => {
  const { worldId, projectId } = request.params;
  const body = request.body || {};
  if (!validUuid(worldId) || !validUuid(projectId) || !['accept','reject','leave'].includes(body.decision)) {
    return fail(reply, 400, 'PROJECT_DECISION_INVALID');
  }
  const actionId = requireActionId(body);
  const result = await transaction(async (client) => {
    await assertMember(client, worldId, request.agentId, true);
    const [agent, worldTime] = await Promise.all([
      readResidentInitiativeFacts(client, worldId, request.agentId), readWorldMinutes(client, worldId)
    ]);
    return decideProjectMembership(client, { worldId, projectId, agentId: request.agentId,
      decision: body.decision, actionId, worldTime, agent });
  });
  return reply.send(result);
});

app.post('/v1/worlds/:worldId/projects/:projectId/contributions', async (request, reply) => {
  const { worldId, projectId } = request.params;
  const body = request.body || {};
  if (!validUuid(worldId) || !validUuid(projectId)) return fail(reply, 400, 'PROJECT_ID_INVALID');
  const actionId = requireActionId(body);
  const result = await transaction(async (client) => {
    await assertMember(client, worldId, request.agentId, true);
    const [agent, worldTime, project] = await Promise.all([
      readResidentInitiativeFacts(client, worldId, request.agentId), readWorldMinutes(client, worldId),
      client.query('SELECT project_type FROM world_projects WHERE world_id=$1 AND id=$2', [worldId, projectId])
    ]);
    if (!project.rowCount) throw Object.assign(new Error('PROJECT_NOT_FOUND'), { statusCode: 404 });
    const skillName = project.rows[0].project_type === 'RESEARCH' || project.rows[0].project_type === 'LEARNING' ? 'research'
      : project.rows[0].project_type === 'TRADE' ? 'trading' : project.rows[0].project_type === 'SOCIAL' ? 'social' : 'engineering';
    return contributeToProject(client, { worldId, projectId, agentId: request.agentId, actionId, worldTime,
      contributionType: body.contributionType || (skillName === 'research' ? 'research' : 'work'),
      skillValue: Number(agent.skills?.[skillName]) || 0, energy: agent.energy });
  });
  return reply.send(result);
});

app.get('/v1/worlds/:worldId/organizations', async (request, reply) => {
  const { worldId } = request.params;
  if (!validUuid(worldId)) return fail(reply, 400, 'WORLD_ID_INVALID');
  await assertMember(pool, worldId, request.agentId);
  return { organizations: await listWorldOrganizations(pool, { worldId, statuses: ['forming','active','dormant'], limit: 100 }) };
});

app.post('/v1/worlds/:worldId/organizations', async (request, reply) => {
  const { worldId } = request.params;
  const body = request.body || {};
  if (!validUuid(worldId) || !validUuid(body.inviteAgentId) || (body.projectId && !validUuid(body.projectId))) {
    return fail(reply, 400, 'ORGANIZATION_FIELDS_INVALID');
  }
  const actionId = requireActionId(body);
  const organization = await transaction(async (client) => {
    await assertMember(client, worldId, request.agentId, true);
    return foundWorldOrganization(client, { ...body, worldId, founderAgentId: request.agentId, actionId,
      worldTime: await readWorldMinutes(client, worldId) });
  });
  return reply.code(organization.created ? 201 : 200).send({ organization });
});

app.post('/v1/worlds/:worldId/organizations/:organizationId/membership', async (request, reply) => {
  const { worldId, organizationId } = request.params;
  const body = request.body || {};
  if (!validUuid(worldId) || !validUuid(organizationId)
    || !['accept','reject','leave','invite'].includes(body.decision)
    || (body.inviteeAgentId && !validUuid(body.inviteeAgentId))) return fail(reply, 400, 'ORGANIZATION_DECISION_INVALID');
  const actionId = requireActionId(body);
  const result = await transaction(async (client) => {
    await assertMember(client, worldId, request.agentId, true);
    const worldTime = await readWorldMinutes(client, worldId);
    if (body.decision === 'invite') return inviteWorldOrganization(client, { worldId, organizationId,
      inviterAgentId: request.agentId, inviteeAgentId: body.inviteeAgentId, actionId, worldTime });
    return decideOrganizationMembership(client, { worldId, organizationId, agentId: request.agentId,
      decision: body.decision, actionId, worldTime });
  });
  return reply.send(result);
});

app.post('/v1/worlds/:worldId/organizations/:organizationId/contributions', async (request, reply) => {
  const { worldId, organizationId } = request.params;
  const body = request.body || {};
  if (!validUuid(worldId) || !validUuid(organizationId)) return fail(reply, 400, 'ORGANIZATION_ID_INVALID');
  const actionId = requireActionId(body);
  const result = await transaction(async (client) => {
    await assertMember(client, worldId, request.agentId, true);
    const agent = await readResidentInitiativeFacts(client, worldId, request.agentId);
    const effort = body.effort === undefined ? 1 + Math.max(...Object.values(agent.skills || {}).map((value) => Number(value) || 0), 0) / 10
      : Number(body.effort);
    return contributeOrganizationEffort(client, { worldId, organizationId, agentId: request.agentId, actionId,
      worldTime: await readWorldMinutes(client, worldId), effort });
  });
  return reply.send(result);
});

app.get('/v1/worlds/:worldId/capabilities', async (request, reply) => {
  const { worldId } = request.params;
  if (!validUuid(worldId)) return fail(reply, 400, 'WORLD_ID_INVALID');
  await assertMember(pool, worldId, request.agentId);
  return { worldId, ...(await readWorldCapabilitySummary(pool, { worldId,
    limit: Math.min(100, Math.max(1, Number(request.query.limit) || 30)) })) };
});

app.post('/v1/worlds/:worldId/capabilities/proposals', async (request, reply) => {
  const { worldId } = request.params;
  const body = request.body || {};
  if (!validUuid(worldId) || !validUuid(body.gapId) || !body.proposal || typeof body.proposal !== 'object'
      || Array.isArray(body.proposal)
      || (body.creatorOrganizationId && !validUuid(body.creatorOrganizationId))) return fail(reply, 400, 'CAPABILITY_PROPOSAL_FIELDS_INVALID');
  const actionId = requireActionId(body);
  const proposal = await transaction(async (client) => {
    await assertMember(client, worldId, request.agentId, true);
    return createWorldCapabilityProposal(client, { worldId, agentId: request.agentId, gapId: body.gapId,
      proposal: body.proposal, creatorOrganizationId: body.creatorOrganizationId || null,
      actionId, worldMinute: await readWorldMinutes(client, worldId) });
  });
  return reply.code(proposal.idempotent ? 200 : 201).send({ proposal });
});

app.post('/v1/worlds/:worldId/capabilities/proposals/:proposalId/reviews', async (request, reply) => {
  const { worldId, proposalId } = request.params;
  const body = request.body || {};
  if (!validUuid(worldId) || !validUuid(proposalId)
      || !['support','oppose','modify','ignore'].includes(body.decision)
      || !requiredString(body.rationale, 3, 600)
      || (body.organizationId && !validUuid(body.organizationId))
      || (body.decision === 'modify' && (!body.suggestedSpecification || typeof body.suggestedSpecification !== 'object'
        || Array.isArray(body.suggestedSpecification)))) return fail(reply, 400, 'CAPABILITY_REVIEW_FIELDS_INVALID');
  const actionId = requireActionId(body);
  const review = await transaction(async (client) => {
    await assertMember(client, worldId, request.agentId, true);
    if (body.organizationId) {
      const membership = await client.query(`SELECT 1 FROM world_organization_members
        WHERE world_id=$1 AND organization_id=$2 AND agent_id=$3 AND status='active'`,
      [worldId, body.organizationId, request.agentId]);
      if (!membership.rowCount) throw Object.assign(new Error('ACTIVE_ORGANIZATION_MEMBERSHIP_REQUIRED'), { statusCode: 403 });
    }
    return reviewWorldCapabilityProposal(client, { worldId, agentId: request.agentId, proposalId,
      organizationId: body.organizationId || null, decision: body.decision, rationale: body.rationale,
      suggestedSpecification: body.suggestedSpecification, evidence: body.evidence || {}, actionId,
      worldMinute: await readWorldMinutes(client, worldId) });
  });
  return reply.send({ review });
});

app.post('/v1/worlds/:worldId/capabilities/experiments/:experimentId/reviews', async (request, reply) => {
  const { worldId, experimentId } = request.params;
  const body = request.body || {};
  if (!validUuid(worldId) || !validUuid(experimentId)
      || !['support','oppose','ignore'].includes(body.decision)
      || !requiredString(body.rationale, 3, 600)) return fail(reply, 400, 'CAPABILITY_EXPERIMENT_REVIEW_FIELDS_INVALID');
  const actionId = requireActionId(body);
  const review = await transaction(async (client) => {
    await assertMember(client, worldId, request.agentId, true);
    return reviewWorldCapabilityExperiment(client, { worldId, agentId: request.agentId, experimentId,
      decision: body.decision, rationale: body.rationale, evidence: body.evidence || {}, actionId,
      worldMinute: await readWorldMinutes(client, worldId) });
  });
  return reply.send({ review });
});

app.post('/v1/worlds/:worldId/capabilities/:capabilityId/use', async (request, reply) => {
  const { worldId, capabilityId } = request.params;
  const body = request.body || {};
  if (!validUuid(worldId) || !validUuid(capabilityId)
      || (body.partnerAgentId !== undefined && !validUuid(body.partnerAgentId))
      || (body.experimentId !== undefined && !validUuid(body.experimentId))) return fail(reply, 400, 'CAPABILITY_USE_FIELDS_INVALID');
  const actionId = requireActionId(body);
  if (body.researchIntent !== undefined) {
    if (!body.researchIntent || typeof body.researchIntent !== 'object' || Array.isArray(body.researchIntent)) {
      return fail(reply, 400, 'RESEARCH_INTENT_INVALID');
    }
    const queued = await transaction(async (client) => {
      await assertMember(client, worldId, request.agentId, true);
      return enqueueResearchCapabilityUse(client, { worldId, agentId: request.agentId, capabilityId,
        actionId, worldMinute: await readWorldMinutes(client, worldId), decisionSource: 'agent_api',
        researchIntent: body.researchIntent });
    });
    return reply.code(queued.idempotent ? 200 : 202).send({ use: queued });
  }
  const use = await transaction(async (client) => {
    await assertMember(client, worldId, request.agentId, true);
    const resident = await client.query(`SELECT energy,food FROM world_members WHERE world_id=$1 AND agent_id=$2 FOR UPDATE`,
      [worldId, request.agentId]);
    if (!resident.rowCount) throw Object.assign(new Error('AGENT_NOT_IN_WORLD'), { statusCode: 403 });
    const result = await performWorldCapabilityUse(client, { worldId, agentId: request.agentId,
      partnerId: body.partnerAgentId || null, capabilityId, experimentId: body.experimentId || null,
      actionId, worldMinute: await readWorldMinutes(client, worldId), agentEnergy: Number(resident.rows[0].energy) });
    if (!result.idempotent) await client.query(`UPDATE world_members SET energy=GREATEST(0,energy-$3),food=GREATEST(0,food-$4)
      WHERE world_id=$1 AND agent_id=$2`, [worldId, request.agentId,
      Number(result.costs?.energy || 0), Number(result.costs?.food || 0)]);
    return result;
  });
  return reply.code(use.idempotent ? 200 : 201).send({ use });
});

app.post('/v1/worlds/:worldId/questions', async (request, reply) =>
  runWorldV7Action(request, reply, createWorldQuestion));
app.post('/v1/worlds/:worldId/questions/:questionId/decision', async (request, reply) =>
  runWorldV7Action(request, reply, (client, input) => decideWorldQuestion(client,
    { ...input, questionId: request.params.questionId })));
app.post('/v1/worlds/:worldId/goals', async (request, reply) =>
  runWorldV7Action(request, reply, createSelfGeneratedGoal));
app.post('/v1/worlds/:worldId/goals/:goalId/decision', async (request, reply) =>
  runWorldV7Action(request, reply, (client, input) => decideWorldAgentGoal(client,
    { ...input, goalId: request.params.goalId })));
app.post('/v1/worlds/:worldId/concepts', async (request, reply) =>
  runWorldV7Action(request, reply, createWorldConcept));
app.post('/v1/worlds/:worldId/concepts/:conceptId/decision', async (request, reply) =>
  runWorldV7Action(request, reply, (client, input) => decideWorldConcept(client,
    { ...input, conceptId: request.params.conceptId })));
app.post('/v1/worlds/:worldId/concepts/:conceptId/uses', async (request, reply) =>
  runWorldV7Action(request, reply, (client, input) => useWorldConcept(client,
    { ...input, conceptId: request.params.conceptId })));
app.post('/v1/worlds/:worldId/emergent-entities', async (request, reply) =>
  runWorldV7Action(request, reply, createEmergentEntity));
app.post('/v1/worlds/:worldId/emergent-entities/:entityId/participation', async (request, reply) =>
  runWorldV7Action(request, reply, (client, input) => decideEmergentParticipation(client,
    { ...input, entityId: request.params.entityId })));
app.post('/v1/worlds/:worldId/policy-experiments', async (request, reply) =>
  runWorldV7Action(request, reply, createPolicyExperiment));
app.post('/v1/worlds/:worldId/policy-experiments/:experimentId/decision', async (request, reply) =>
  runWorldV7Action(request, reply, (client, input) => decidePolicyExperiment(client,
    { ...input, experimentId: request.params.experimentId })));
app.post('/v1/worlds/:worldId/extension-requests', async (request, reply) =>
  runWorldV7Action(request, reply, createWorldExtensionRequest));
app.get('/v1/worlds/:worldId/token-issuance', async (request, reply) => {
  const { worldId } = request.params;
  if (!validUuid(worldId)) return fail(reply, 400, 'WORLD_ID_INVALID');
  await assertMember(pool, worldId, request.agentId);
  if (!arcTokenSchemaReady) return fail(reply, 503, 'ARC_TOKEN_ISSUANCE_MIGRATION_REQUIRED');
  return { tokenIssuance: await listWorldTokenIssuance(pool, { worldId,
    limit: Math.min(100, Math.max(1, Number(request.query.limit) || 30)) }) };
});
app.post('/v1/worlds/:worldId/token-issuance/intents', async (request, reply) => {
  const { worldId } = request.params;
  const body = request.body || {};
  if (!validUuid(worldId) || Object.hasOwn(body, 'issuerAgentId')) return fail(reply, 400, 'TOKEN_ISSUER_SELECTION_REQUIRES_AGENT_INTERACTION');
  if (!arcTokenSchemaReady) return fail(reply, 503, 'ARC_TOKEN_ISSUANCE_MIGRATION_REQUIRED');
  const actionId = requireActionId(body);
  const result = await transaction(async (client) => {
    await assertMember(client, worldId, request.agentId, true);
    return createWorldTokenIssuanceIntent(client, { worldId, agentId: request.agentId,
      specification: body.specification || {}, actionId,
      worldMinute: await readWorldMinutes(client, worldId) });
  });
  return reply.code(result.created ? 201 : 200).send(result);
});
app.patch('/v1/worlds/:worldId/token-issuance/intents/:intentId/specification', async (request, reply) => {
  const { worldId, intentId } = request.params;
  const body = request.body || {};
  if (!validUuid(worldId) || !validUuid(intentId)) return fail(reply, 400, 'TOKEN_ISSUANCE_ID_INVALID');
  if (Object.hasOwn(body, 'issuerAgentId')) return fail(reply, 400, 'TOKEN_ISSUER_SELECTION_REQUIRES_AGENT_INTERACTION');
  if (!arcTokenSchemaReady) return fail(reply, 503, 'ARC_TOKEN_ISSUANCE_MIGRATION_REQUIRED');
  const actionId = requireActionId(body);
  const result = await transaction(async (client) => {
    await assertMember(client, worldId, request.agentId, true);
    return updateWorldTokenIssuanceSpecification(client, { worldId, agentId: request.agentId, intentId,
      specification: body.specification, actionId,
      worldMinute: await readWorldMinutes(client, worldId) });
  });
  return reply.send(result);
});
app.post('/v1/worlds/:worldId/token-issuance/intents/:intentId/issuer-candidates', async (request, reply) => {
  const { worldId, intentId } = request.params;
  const body = request.body || {};
  if (!validUuid(worldId) || !validUuid(intentId) || !validUuid(body.candidateAgentId)) {
    return fail(reply, 400, 'TOKEN_ISSUER_CANDIDATE_INVALID');
  }
  if (!arcTokenSchemaReady) return fail(reply, 503, 'ARC_TOKEN_ISSUANCE_MIGRATION_REQUIRED');
  const actionId = requireActionId(body);
  const result = await transaction(async (client) => {
    await assertMember(client, worldId, request.agentId, true);
    return nominateWorldTokenIssuer(client, { worldId, agentId: request.agentId, intentId,
      candidateAgentId: body.candidateAgentId, nominationReason: body.nominationReason ?? null,
      actionId, worldMinute: await readWorldMinutes(client, worldId) });
  });
  return reply.code(result.idempotent ? 200 : 201).send(result);
});
app.post('/v1/worlds/:worldId/token-issuance/intents/:intentId/issuer-candidates/:candidateAgentId/decision', async (request, reply) => {
  const { worldId, intentId, candidateAgentId } = request.params;
  const body = request.body || {};
  if (!validUuid(worldId) || !validUuid(intentId) || !validUuid(candidateAgentId)) {
    return fail(reply, 400, 'TOKEN_ISSUER_CANDIDATE_INVALID');
  }
  if (!arcTokenSchemaReady) return fail(reply, 503, 'ARC_TOKEN_ISSUANCE_MIGRATION_REQUIRED');
  const actionId = requireActionId(body);
  const result = await transaction(async (client) => {
    await assertMember(client, worldId, request.agentId, true);
    return decideWorldTokenIssuerCandidate(client, { worldId, agentId: request.agentId, intentId,
      candidateAgentId, decision: body.decision, rationale: body.rationale ?? null,
      actionId, worldMinute: await readWorldMinutes(client, worldId) });
  });
  return reply.send(result);
});
app.post('/v1/worlds/:worldId/token-issuance/intents/:intentId/responses', async (request, reply) => {
  const { worldId, intentId } = request.params;
  const body = request.body || {};
  if (!validUuid(worldId) || !validUuid(intentId)) return fail(reply, 400, 'TOKEN_ISSUANCE_ID_INVALID');
  if (!arcTokenSchemaReady) return fail(reply, 503, 'ARC_TOKEN_ISSUANCE_MIGRATION_REQUIRED');
  const actionId = requireActionId(body);
  const result = await transaction(async (client) => {
    await assertMember(client, worldId, request.agentId, true);
    return respondToWorldTokenIssuance(client, { worldId, agentId: request.agentId, intentId,
      decision: body.decision, rationale: body.rationale ?? null, actionId,
      worldMinute: await readWorldMinutes(client, worldId) });
  });
  return reply.send(result);
});
app.post('/v1/worlds/:worldId/token-issuance/intents/:intentId/issuer-decision', async (request, reply) => {
  const { worldId, intentId } = request.params;
  const body = request.body || {};
  if (!validUuid(worldId) || !validUuid(intentId)) return fail(reply, 400, 'TOKEN_ISSUANCE_ID_INVALID');
  if (!arcTokenSchemaReady) return fail(reply, 503, 'ARC_TOKEN_ISSUANCE_MIGRATION_REQUIRED');
  const actionId = requireActionId(body);
  const result = await transaction(async (client) => {
    await assertMember(client, worldId, request.agentId, true);
    return confirmWorldTokenIssuance(client, { worldId, agentId: request.agentId, intentId,
      decision: body.decision, actionId, worldMinute: await readWorldMinutes(client, worldId) });
  });
  return reply.send(result);
});
app.post('/v1/worlds/:worldId/tokens/:tokenId/decision', async (request, reply) => {
  const { worldId, tokenId } = request.params;
  const body = request.body || {};
  if (!validUuid(worldId) || !validUuid(tokenId)) return fail(reply, 400, 'AGENT_TOKEN_ID_INVALID');
  if (!arcTokenSchemaReady) return fail(reply, 503, 'ARC_TOKEN_ISSUANCE_MIGRATION_REQUIRED');
  const actionId = requireActionId(body);
  const result = await transaction(async (client) => {
    await assertMember(client, worldId, request.agentId, true);
    return decideWorldAgentTokenAcceptance(client, { worldId, agentId: request.agentId, tokenId,
      decision: body.decision, rationale: body.rationale ?? null, actionId,
      worldMinute: await readWorldMinutes(client, worldId) });
  });
  return reply.send(result);
});
app.post('/v1/worlds/:worldId/tokens/:tokenId/uses', async (request, reply) => {
  const { worldId, tokenId } = request.params;
  const body = request.body || {};
  if (!validUuid(worldId) || !validUuid(tokenId)) return fail(reply, 400, 'AGENT_TOKEN_ID_INVALID');
  if (!arcTokenSchemaReady) return fail(reply, 503, 'ARC_TOKEN_ISSUANCE_MIGRATION_REQUIRED');
  const actionId = requireActionId(body);
  const result = await transaction(async (client) => {
    await assertMember(client, worldId, request.agentId, true);
    return recordWorldAgentTokenUse(client, { worldId, agentId: request.agentId, tokenId,
      usageContext: body.usageContext, evidence: body.evidence || {}, actionId,
      worldMinute: await readWorldMinutes(client, worldId) });
  });
  return reply.code(result.used ? 201 : 200).send(result);
});
app.post('/v1/worlds/:worldId/values', async (request, reply) =>
  runWorldV7Action(request, reply, createWorldValue));
app.post('/v1/worlds/:worldId/values/:valueId/exposures', async (request, reply) =>
  runWorldV7Action(request, reply, (client, input) => exposeWorldValue(client,
    { ...input, valueId: request.params.valueId })));
app.post('/v1/worlds/:worldId/value-exposures/:exposureId/alignment', async (request, reply) =>
  runWorldV7Action(request, reply, (client, input) => alignWorldValue(client,
    { ...input, exposureId: request.params.exposureId })));
app.post('/v1/worlds/:worldId/cognition-preference', async (request, reply) =>
  runWorldV7Action(request, reply, setPreferredCognitionMode));
app.post('/v1/worlds/:worldId/resource-types', async (request, reply) =>
  runWorldV7Action(request, reply, createWorldResourceType));
app.post('/v1/worlds/:worldId/resource-types/:resourceTypeId/decision', async (request, reply) =>
  runWorldV7Action(request, reply, (client, input) => decideWorldResourceType(client,
    { ...input, resourceTypeId: request.params.resourceTypeId })));
app.post('/v1/worlds/:worldId/resource-types/:resourceTypeId/holders', async (request, reply) =>
  runWorldV7Action(request, reply, (client, input) => registerWorldAgentResourceHolder(client,
    { ...input, resourceTypeId: request.params.resourceTypeId })));
app.post('/v1/worlds/:worldId/resource-types/:resourceTypeId/ledger', async (request, reply) =>
  runWorldV7Action(request, reply, (client, input) => recordWorldResourceTransaction(client,
    { ...input, resourceTypeId: request.params.resourceTypeId })));
app.post('/v1/worlds/:worldId/coordination-mechanisms', async (request, reply) =>
  runWorldV7Action(request, reply, createCoordinationMechanism));
app.post('/v1/worlds/:worldId/coordination-mechanisms/:mechanismId/experiments', async (request, reply) =>
  runWorldV7Action(request, reply, (client, input) => startCoordinationExperiment(client,
    { ...input, mechanismId: request.params.mechanismId })));
app.post('/v1/worlds/:worldId/coordination-mechanisms/:mechanismId/uses', async (request, reply) =>
  runWorldV7Action(request, reply, (client, input) => recordCoordinationUse(client,
    { ...input, mechanismId: request.params.mechanismId })));
app.post('/v1/worlds/:worldId/coordination-experiments/:experimentId/evaluation', async (request, reply) =>
  runWorldV7Action(request, reply, (client, input) => evaluateCoordinationExperiment(client,
    { ...input, experimentId: request.params.experimentId })));
app.post('/v1/worlds/:worldId/principles', async (request, reply) =>
  runWorldV7Action(request, reply, createWorldPrinciple));
app.post('/v1/worlds/:worldId/observation-methods', async (request, reply) =>
  runWorldV7Action(request, reply, createObservationMethod));
app.post('/v1/worlds/:worldId/observation-methods/:methodId/decision', async (request, reply) =>
  runWorldV7Action(request, reply, (client, input) => decideObservationMethod(client,
    { ...input, methodId: request.params.methodId })));
app.post('/v1/worlds/:worldId/observation-methods/:methodId/uses', async (request, reply) =>
  runWorldV7Action(request, reply, (client, input) => useObservationMethod(client,
    { ...input, methodId: request.params.methodId })));
app.post('/v1/worlds/:worldId/meanings', async (request, reply) =>
  runWorldV7Action(request, reply, createWorldMeaning));
app.post('/v1/worlds/:worldId/eras', async (request, reply) =>
  runWorldV7Action(request, reply, createWorldEra));
app.post('/v1/worlds/:worldId/milestones', async (request, reply) =>
  runWorldV7Action(request, reply, createWorldMilestone));
app.post('/v1/worlds/:worldId/goal-primitives', async (request, reply) =>
  runWorldV7Action(request, reply, createGoalPrimitiveProposal));
app.post('/v1/worlds/:worldId/goal-primitives/:primitiveKey/decision', async (request, reply) =>
  runWorldV7Action(request, reply, (client, input) => decideGoalPrimitive(client,
    { ...input, primitiveKey: request.params.primitiveKey })));

app.get('/v1/worlds/:worldId/agreements', async (request, reply) => {
  const { worldId } = request.params;
  if (!validUuid(worldId)) return fail(reply, 400, 'WORLD_ID_INVALID');
  await assertMember(pool, worldId, request.agentId);
  return { agreements: await listWorldAgreements(pool, { worldId, agentId: request.agentId,
    limit: Math.min(250, Math.max(1, Number(request.query.limit) || 100)) }) };
});

app.post('/v1/worlds/:worldId/agreements', async (request, reply) => {
  const { worldId } = request.params;
  const body = request.body || {};
  if (!validUuid(worldId) || !validUuid(body.counterpartyAgentId)) return fail(reply, 400, 'AGREEMENT_PARTIES_INVALID');
  const actionId = requireActionId(body);
  const agreement = await transaction(async (client) => {
    await assertMember(client, worldId, request.agentId, true);
    return proposeWorldAgreement(client, { worldId, proposerAgentId: request.agentId,
      counterpartyAgentId: body.counterpartyAgentId, agreementType: body.agreementType, terms: body.terms,
      actionId, worldTime: await readWorldMinutes(client, worldId),
      expiresInWorldMinutes: body.expiresInWorldMinutes });
  });
  return reply.code(agreement.idempotent ? 200 : 201).send({ agreement });
});

app.post('/v1/worlds/:worldId/agreements/:agreementId/response', async (request, reply) => {
  const { worldId, agreementId } = request.params;
  const body = request.body || {};
  if (!validUuid(worldId) || !validUuid(agreementId)) return fail(reply, 400, 'AGREEMENT_ID_INVALID');
  const actionId = requireActionId(body);
  const result = await transaction(async (client) => {
    await assertMember(client, worldId, request.agentId, true);
    return respondToWorldAgreement(client, { worldId, agreementId, agentId: request.agentId,
      decision: body.decision, counterTerms: body.counterTerms, actionId,
      worldTime: await readWorldMinutes(client, worldId) });
  });
  return reply.send(result);
});

app.post('/v1/worlds/:worldId/agreements/:agreementId/commitments', async (request, reply) => {
  const { worldId, agreementId } = request.params;
  const body = request.body || {};
  if (!validUuid(worldId) || !validUuid(agreementId) || !validUuid(body.counterpartyAgentId)) {
    return fail(reply, 400, 'COMMITMENT_FIELDS_INVALID');
  }
  const actionId = requireActionId(body);
  const commitment = await transaction(async (client) => {
    await assertMember(client, worldId, request.agentId, true);
    const worldTime = await readWorldMinutes(client, worldId);
    return createWorldCommitment(client, { worldId, agreementId, agentId: request.agentId,
      counterpartyAgentId: body.counterpartyAgentId, commitmentType: body.commitmentType,
      description: body.description, actionId, dueWorldTime: body.dueWorldTime, worldTime });
  });
  return reply.code(201).send({ commitment });
});

app.post('/v1/worlds/:worldId/commitments/:commitmentId/resolve', async (request, reply) => {
  const { worldId, commitmentId } = request.params;
  const body = request.body || {};
  if (!validUuid(worldId) || !validUuid(commitmentId)) return fail(reply, 400, 'COMMITMENT_ID_INVALID');
  const actionId = requireActionId(body);
  const result = await transaction(async (client) => {
    await assertMember(client, worldId, request.agentId, true);
    return resolveWorldCommitment(client, { worldId, commitmentId, agentId: request.agentId,
      outcome: body.outcome, actionId, worldTime: await readWorldMinutes(client, worldId) });
  });
  return reply.send(result);
});

app.get('/v1/worlds/:worldId/institutions', async (request, reply) => {
  const { worldId } = request.params;
  if (!validUuid(worldId)) return fail(reply, 400, 'WORLD_ID_INVALID');
  await assertMember(pool, worldId, request.agentId);
  return listWorldInstitutionSummary(pool, { worldId, agentId: request.query.all === 'true' ? null : request.agentId,
    limit: Math.min(200, Math.max(1, Number(request.query.limit) || 100)) });
});

app.post('/v1/worlds/:worldId/organizations/:organizationId/proposals', async (request, reply) => {
  const { worldId, organizationId } = request.params;
  const body = request.body || {};
  if (!validUuid(worldId) || !validUuid(organizationId)) return fail(reply, 400, 'ORGANIZATION_ID_INVALID');
  const actionId = requireActionId(body);
  const proposal = await transaction(async (client) => {
    await assertMember(client, worldId, request.agentId, true);
    return proposeOrganizationGovernance(client, { worldId, organizationId, proposerAgentId: request.agentId,
      proposalType: body.proposalType, payload: body.payload, actionId,
      worldTime: await readWorldMinutes(client, worldId), expiresInWorldMinutes: body.expiresInWorldMinutes,
      parentProposalId: body.parentProposalId || null });
  });
  return reply.code(proposal.idempotent ? 200 : 201).send({ proposal });
});

app.post('/v1/worlds/:worldId/organization-proposals/:proposalId/votes', async (request, reply) => {
  const { worldId, proposalId } = request.params;
  const body = request.body || {};
  if (!validUuid(worldId) || !validUuid(proposalId)) return fail(reply, 400, 'ORGANIZATION_PROPOSAL_ID_INVALID');
  const actionId = requireActionId(body);
  const result = await transaction(async (client) => {
    await assertMember(client, worldId, request.agentId, true);
    return voteOrganizationProposal(client, { worldId, proposalId, agentId: request.agentId,
      decision: body.decision, actionId, worldTime: await readWorldMinutes(client, worldId) });
  });
  return reply.send(result);
});

app.get('/v1/worlds/:worldId/information/inbox', async (request, reply) => {
  const { worldId } = request.params;
  if (!validUuid(worldId)) return fail(reply, 400, 'WORLD_ID_INVALID');
  return { information: await listInformationInbox(pool, { worldId, recipientAgentId: request.agentId,
    limit: Math.min(100, Math.max(1, Number(request.query.limit) || 20)) }) };
});

app.post('/v1/worlds/:worldId/information/shares', async (request, reply) => {
  const { worldId } = request.params;
  const body = request.body || {};
  if (!validUuid(worldId) || !validUuid(body.recipientAgentId)) return fail(reply, 400, 'INFORMATION_FIELDS_INVALID');
  const actionId = requireActionId(body);
  const share = await transaction(async (client) => {
    await assertMember(client, worldId, request.agentId, true);
    return shareWorldInformation(client, { ...body, worldId, senderAgentId: request.agentId, actionId,
      worldTime: await readWorldMinutes(client, worldId) });
  });
  return reply.code(share.idempotent ? 200 : 201).send({ share });
});

app.post('/v1/worlds/:worldId/information/shares/:shareId/decision', async (request, reply) => {
  const { worldId, shareId } = request.params;
  const body = request.body || {};
  if (!validUuid(worldId) || !validUuid(shareId) || !['accept','ignore','doubt'].includes(body.decision)) {
    return fail(reply, 400, 'INFORMATION_DECISION_INVALID');
  }
  const actionId = requireActionId(body);
  const result = await transaction(async (client) => {
    await assertMember(client, worldId, request.agentId, true);
    return decideWorldInformationShare(client, { worldId, shareId, recipientAgentId: request.agentId,
      decision: body.decision, actionId, worldTime: await readWorldMinutes(client, worldId) });
  });
  return reply.send(result);
});

app.get('/v1/worlds/:worldId/events', async (request, reply) => {
  const { worldId } = request.params;
  const limit = Math.max(1, Math.min(Number(request.query.limit) || 30, 100));
  if (!validUuid(worldId)) return fail(reply, 400, 'WORLD_ID_INVALID');
  await assertMember(pool, worldId, request.agentId);
  const events = await pool.query(`SELECT id,actor_id,event_type,data,created_at FROM world_events WHERE world_id=$1
    AND ((event_type NOT LIKE 'adult_service.%' AND event_type <> 'interaction.intimacy') OR actor_id=$2)
    ORDER BY id DESC LIMIT $3`, [worldId, request.agentId, limit]);
  return { events: events.rows };
});

app.get('/v1/worlds/:worldId/research-jobs', async (request, reply) => {
  const { worldId } = request.params;
  if (!validUuid(worldId)) return fail(reply, 400, 'WORLD_ID_INVALID');
  await assertMember(pool, worldId, request.agentId);
  return { worldId, jobs: await listAgentResearchJobs(pool, { worldId, agentId: request.agentId,
    limit: Math.min(100, Math.max(1, Number(request.query.limit) || 30)) }) };
});

app.post('/v1/worlds/:worldId/research-jobs/:jobId/cancel', async (request, reply) => {
  const { worldId, jobId } = request.params;
  if (!validUuid(worldId) || !validUuid(jobId)) return fail(reply, 400, 'RESEARCH_JOB_ID_INVALID');
  const actionId = requireActionId(request.body || {});
  const job = await transaction(async (client) => {
    await assertMember(client, worldId, request.agentId, true);
    return cancelResearchJob(client, { worldId, agentId: request.agentId, jobId, actionId,
      worldMinute: await readWorldMinutes(client, worldId) });
  });
  return reply.code(job.idempotent ? 200 : 202).send({ job });
});

app.get('/local/research-status', async (request, reply) => {
  if (!['127.0.0.1', '::1', 'localhost'].includes(HOST)) return fail(reply, 404, 'NOT_FOUND');
  if (!worldEngine.worldId) return reply.code(503).send({ error: 'WORLD_ENGINE_UNAVAILABLE',
    reaResearch: reaResearchWorker?.getStatus() || { available: false, reason: 'world_engine_not_registered' } });
  return { worldId: worldEngine.worldId, reaResearch: reaResearchWorker?.getStatus() || null,
    ...await readResearchWorldStatus(pool, { worldId: worldEngine.worldId,
      limit: Math.min(100, Math.max(1, Number(request.query.limit) || 30)) }) };
});

try {
  await prepareStartupSchema(pool, { rootDirectory: ROOT, mode: process.env.SYNTERRA_SCHEMA_MODE ?? 'apply' });
} catch (error) {
  await pool.end();
  throw error;
}
const arcSchema = await pool.query(`SELECT to_regclass('public.arc_settlement_outbox') IS NOT NULL AS ready`);
arcSchemaReady = arcSchema.rows[0]?.ready === true;
const arcTokenSchema = await pool.query(`SELECT to_regclass('public.arc_token_issuance_intents') IS NOT NULL AS ready`);
arcTokenSchemaReady = arcTokenSchema.rows[0]?.ready === true;
arcSetupReason = arcSchemaReady ? 'observer_not_registered' : 'arc_schema_migration_required';
if (arcSchemaReady) {
  try {
    const signerResult = await loadConfiguredArcSigner({ config: ARC_CONFIG, env: process.env });
    arcSigner = signerResult.signer;
  } catch (error) {
    arcSignerSetupError = String(error?.code || 'ARC_SIGNER_CONFIGURATION_INVALID').replace(/[^A-Z0-9_]/gi, '').slice(0, 80);
    console.error(JSON.stringify({ code: arcSignerSetupError }, null, 0));
  }
  try {
    const signerResult = await loadConfiguredArcInfrastructureSigner({ config: ARC_CONFIG, env: process.env });
    arcInfrastructureSigner = signerResult.signer;
  } catch (error) {
    arcSignerSetupError ||= String(error?.code || 'ARC_INFRA_SIGNER_CONFIGURATION_INVALID')
      .replace(/[^A-Z0-9_]/gi, '').slice(0, 80);
    console.error(JSON.stringify({ code: String(error?.code || 'ARC_INFRA_SIGNER_CONFIGURATION_INVALID')
      .replace(/[^A-Z0-9_]/gi, '').slice(0, 80) }, null, 0));
  }
}
await expireAdultServiceBookings();
await app.listen({ host: HOST, port: PORT });
let typeSafeRuntimeState = null;
let typeSafeProviderInitialized = false;
if (process.env.TYPESAFE_API_KEY) {
  const providerStatus = initializeTypeSafeProvider();
  typeSafeProviderInitialized = providerStatus.initialized;
  if (typeSafeProviderInitialized) {
    app.log.info({ provider: 'typesafe', initialized: true }, 'TypeSafe provider client initialized');
  } else {
    app.log.error({ provider: 'typesafe', initialized: false, reason: providerStatus.reason },
      'TypeSafe provider client initialization failed');
  }
  try { typeSafeRuntimeState = await loadState(); }
  catch (error) { app.log.error({ err: error }, 'TypeSafe state could not be loaded; local utility decisions remain active'); }
}
let fruitflyRuntime = null;
try { fruitflyRuntime = await createFruitflyRuntime(STATE_DIR); }
catch (error) { app.log.error({ err: error }, 'Fruitfly selection unavailable; utility rules remain active'); }
try {
  worldEngine = await startWorldEngine(pool, {
    chooseWithTypeSafe: typeSafeProviderInitialized && typeSafeRuntimeState ? chooseWithTypeSafe : null,
    chooseCivilizationOption: typeSafeProviderInitialized && typeSafeRuntimeState ? chooseCivilizationOption : null,
    chooseWorldV7Reflection: typeSafeProviderInitialized && typeSafeRuntimeState ? chooseWorldV7Reflection : null,
    currencyGenesisEnabled: arcTokenSchemaReady,
    onAutonomousBusinessAction: arcSchemaReady ? enqueueArcAgentEconomicAction : null,
    runtimeState: typeSafeRuntimeState,
    fruitfly: fruitflyRuntime,
    onStatus: (status) => {
      if (status.typeSafe) app.log.info(status, 'bounded TypeSafe goal selection');
      else if (status.reason === 'another_server_owns_world_loop') app.log.warn(status, 'world engine already active elsewhere');
    },
    onError: logWorldEngineError
  });
} catch (error) {
  worldEngine = { running: false, reason: 'startup_failed' };
  reportWorldEngineError({ error, stage: 'startup', worldId: null, onError: logWorldEngineError });
}
if (worldEngine.running && worldEngine.worldLockOwned && worldEngine.worldId) {
  const observerWorldId = worldEngine.worldId;
  v6LifecycleObserver = startV6LifecycleObserver({ pool, worldId: observerWorldId,
    directory: path.join(STATE_DIR, 'v6-observations'),
    isOwner: () => worldEngine.running && worldEngine.worldLockOwned && worldEngine.worldId === observerWorldId,
    onError: (error) => app.log.error({ err: error }, 'read-only V6 lifecycle observer snapshot failed') });
  reaResearchWorker = startReaResearchWorker({ pool, worldId: observerWorldId, stateDirectory: STATE_DIR,
    artifactDirectory: path.join(STATE_DIR, 'research', 'artifacts'),
    evidenceDirectory: path.join(STATE_DIR, 'research', 'evidence'),
    isOwner: () => worldEngine.running && worldEngine.worldLockOwned && worldEngine.worldId === observerWorldId,
    onError: (record) => app.log.error({ ...record }, 'REA research worker event') });
  reaResearchWorker.start();
  if (arcSchemaReady) {
    arcObserver = startArcReadOnlyObserver({ pool, config: ARC_CONFIG,
      rpcClient: ARC_RPC_CLIENT,
      isOwner: () => worldEngine.running && worldEngine.worldLockOwned && worldEngine.worldId === observerWorldId,
      signerConfigured: Boolean(arcSigner),
      onError: (error) => app.log.error({ code: error?.code || 'ARC_OBSERVER_ERROR' }, 'read-only Arc observation failed') });
    await arcObserver.start({ worldId: observerWorldId });
    arcSettlementWorker = startArcSettlementOutboxWorker({ pool, config: ARC_CONFIG, env: process.env,
      signer: arcSigner, rpcClient: ARC_RPC_CLIENT,
      isOwner: () => worldEngine.running && worldEngine.worldLockOwned && worldEngine.worldId === observerWorldId,
      onError: (record) => app.log.error(record, 'Arc settlement outbox processing failed') });
    await arcSettlementWorker.start();
    if (arcTokenSchemaReady) {
      arcGenesisTokenSettlementReconciler = startArcGenesisTokenSettlementReconciler({ pool,
        rpcClient: ARC_RPC_CLIENT,
        isOwner: () => worldEngine.running && worldEngine.worldLockOwned && worldEngine.worldId === observerWorldId,
        onError: (record) => app.log.error(record, 'Arc Genesis token settlement reconciliation failed') });
      await arcGenesisTokenSettlementReconciler.start({ worldId: observerWorldId });
      arcAgentTokenIssuanceWorker = startArcAgentTokenIssuanceWorker({ pool, config: ARC_CONFIG,
        env: process.env, signer: arcInfrastructureSigner, rpcClient: ARC_RPC_CLIENT,
        isOwner: () => worldEngine.running && worldEngine.worldLockOwned && worldEngine.worldId === observerWorldId,
        onError: (record) => app.log.error(record, 'Arc Agent token issuance worker failed') });
      await arcAgentTokenIssuanceWorker.start({ worldId: observerWorldId });
    }
  }
}
const adultServiceExpiryTimer = setInterval(() => {
  expireAdultServiceBookings().catch((error) => app.log.error({ err: error }, 'adult service booking expiry failed'));
}, 60_000);
adultServiceExpiryTimer.unref();
async function shutdown() {
  clearInterval(adultServiceExpiryTimer);
  await arcSettlementWorker?.stop();
  await arcGenesisTokenSettlementReconciler?.stop();
  await arcAgentTokenIssuanceWorker?.stop();
  await arcObserver?.stop();
  await v6LifecycleObserver?.stop();
  await worldEngine.stop?.();
  await reaResearchWorker?.stop();
  await app.close();
  await pool.end();
  process.exit(0);
}
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
console.log(`Synterra listening on http://${HOST}:${PORT}`);

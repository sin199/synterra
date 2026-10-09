import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Interface, keccak256 } from 'ethers';
import { Pool } from 'pg';
import { foundWorldBusiness } from '../src/world-businesses.js';
import { startWorldEngine } from '../src/world-engine.js';
import { applyWorldSchemaAndMigrations } from '../src/database-migrations.js';
import { prepareArcCapabilityProvenance } from '../src/arc/provenance.js';
import { prepareArcWorldCheckpoint } from '../src/arc/checkpoints.js';
import { indexTrackedUsdcTransfers } from '../src/arc/indexer.js';
import { ARC_MAINNET_CHAIN_ID, ARC_MAINNET_USDC_ADDRESS } from '../src/arc/config.js';
import { ARC_SETTLEMENT_POLICY_INTERFACE, enqueueArcAgentEconomicAction } from '../src/arc/agent-economic-action.js';
import { ArcReadOnlyObserver } from '../src/arc/observer.js';
import { ArcSettlementOutboxWorker } from '../src/arc/settlement-worker.js';
import { ArcAgentTokenIssuanceWorker } from '../src/arc/token-issuance-worker.js';
import { currencyGenesisInfrastructureFacts } from '../src/arc/currency-genesis-context.js';
import { advanceWorldCurrencyGenesis, confirmWorldTokenIssuance } from '../src/world-token-issuance.js';
import { chooseCivilizationOption } from '../src/agent-runtime/typesafe.js';
import { reserveArcMainnetPilotCost, releaseArcMainnetPilotCost,
  setArcMainnetPilotCostStatus } from '../src/arc/pilot-budget.js';
import { DeterministicFakeArcSigner, createIsolatedArcMainnetConfig } from './helpers/arc-mainnet-fakes.js';
import { fundTestResidents } from './helpers/economic-fixtures.js';
import { ARC_SETTLEMENT_INTERFACE, toArcBytes16Uuid } from '../src/arc/settlement.js';

const databaseUrl = process.env.SYNTERRA_TEST_DATABASE_URL;
const enabled = process.env.SYNTERRA_TEST_ISOLATED === '1' && Boolean(databaseUrl);
const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CONTRACT = '0x1111111111111111111111111111111111111111';
const PAYER = '0x2222222222222222222222222222222222222222';
const RECIPIENT = '0x3333333333333333333333333333333333333333';
// The isolated database intentionally keeps generated test rows between runs.
// Use a fresh chain hash so a prior fake submission cannot collide with the
// production-shaped unique (chain_id, transaction_hash) constraint.
const HASH = `0x${randomBytes(32).toString('hex')}`;
const SYSTEM_EMITTER = '0xffffFFFfFFffffffffffffffFfFFFfffFFFfFFfE';
const RUNTIME_CODE = '0x6001600055';
const RUNTIME_CODE_HASH = keccak256(RUNTIME_CODE);
const IDENTITY_INTERFACE = new Interface([
  'function worldId() view returns (bytes16)',
  'function usdc() view returns (address)'
]);
const TOKEN_INTERFACE = new Interface([
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function decimals() view returns (uint8)'
]);

function assertIsolatedDatabase(connectionString) {
  const parsed = new URL(connectionString);
  assert.ok(['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname), 'Arc integration requires loopback PostgreSQL');
  assert.notEqual(parsed.port, '5432', 'Arc integration must not use the formal/default PostgreSQL port');
  assert.ok(decodeURIComponent(parsed.pathname.slice(1)).endsWith('_test'), 'Arc integration requires a *_test database');
}

async function inTransaction(pool, operation) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

function fakeMainnetRpc({ worldId, config }) {
  const calls = [];
  const rpc = {
    config,
    calls,
    async getChainId() { return ARC_MAINNET_CHAIN_ID; },
    async getBlockNumber() { return '0x1234'; },
    async getBlock() { return { number: '0x1234', baseFeePerGas: '0x4a817c800', transactions: [] }; },
    async getCode(address) { return address.toLowerCase() === CONTRACT.toLowerCase() ? RUNTIME_CODE : '0x6001'; },
    async getBalance() { return '0x3635c9adc5dea00000'; },
    async getTransactionCount() { return '0x0'; },
    async estimateGas() { return '0x5208'; },
    async maxPriorityFeePerGas() { return '0x0'; },
    async getTransactionReceipt() { return null; },
    async getLogs() { return []; },
    async health() { return { configured: true, chainId: ARC_MAINNET_CHAIN_ID,
      expectedChainId: ARC_MAINNET_CHAIN_ID, rpcHealthy: true, latestBlock: 0x1234,
      provider: 'isolated-deterministic-mainnet-fixture', latencyMs: 1, error: null }; },
    async call(transaction) {
      const selector = String(transaction.data || '').slice(0, 10).toLowerCase();
      calls.push(selector);
      if (transaction.to.toLowerCase() === ARC_MAINNET_USDC_ADDRESS.toLowerCase()) {
        if (selector === TOKEN_INTERFACE.getFunction('decimals').selector.toLowerCase()) {
          return TOKEN_INTERFACE.encodeFunctionResult('decimals', [6]);
        }
        if (selector === TOKEN_INTERFACE.getFunction('balanceOf').selector.toLowerCase()) {
          return TOKEN_INTERFACE.encodeFunctionResult('balanceOf', [1_000_000_000n]);
        }
        if (selector === TOKEN_INTERFACE.getFunction('allowance').selector.toLowerCase()) {
          return TOKEN_INTERFACE.encodeFunctionResult('allowance', [1_000_000_000n]);
        }
      }
      if (selector === IDENTITY_INTERFACE.getFunction('worldId').selector.toLowerCase()) {
        return IDENTITY_INTERFACE.encodeFunctionResult('worldId', [toArcBytes16Uuid(worldId)]);
      }
      if (selector === IDENTITY_INTERFACE.getFunction('usdc').selector.toLowerCase()) {
        return IDENTITY_INTERFACE.encodeFunctionResult('usdc', [ARC_MAINNET_USDC_ADDRESS]);
      }
      if (selector === ARC_SETTLEMENT_POLICY_INTERFACE.getFunction('spendingPolicies').selector.toLowerCase()) {
        return ARC_SETTLEMENT_POLICY_INTERFACE.encodeFunctionResult('spendingPolicies',
          [100_000_000n, 500_000_000n, 0n, 0, true, false]);
      }
      if (selector === ARC_SETTLEMENT_POLICY_INTERFACE.getFunction('allowedActionFamilies').selector.toLowerCase()) {
        return ARC_SETTLEMENT_POLICY_INTERFACE.encodeFunctionResult('allowedActionFamilies', [true]);
      }
      if (selector === ARC_SETTLEMENT_POLICY_INTERFACE.getFunction('completedActions').selector.toLowerCase()) {
        return ARC_SETTLEMENT_POLICY_INTERFACE.encodeFunctionResult('completedActions', [false]);
      }
      throw new Error(`Unexpected isolated Arc eth_call selector: ${selector}`);
    }
  };
  return rpc;
}

test('Arc Mainnet Agent action reaches persistent outbox, policy evaluation, and fake signer on isolated PostgreSQL', {
  skip: !enabled,
  timeout: 120_000
}, async () => {
  assertIsolatedDatabase(databaseUrl);
  const pool = new Pool({ connectionString: databaseUrl, max: 4 });
  const worldId = randomUUID();
  const payerId = randomUUID();
  const recipientId = randomUUID();
  const rootCapabilityId = randomUUID();
  const childCapabilityId = randomUUID();
  const txHash = HASH;
  const nowMs = Date.now();
  let engineNowMs = nowMs;
  let engine = null;
  let worker = null;
  let tokenWorker = null;
  try {
    await applyWorldSchemaAndMigrations(pool, { rootDirectory: repoRoot });
    await pool.query('DELETE FROM arc_mainnet_pilot_cost_reservations');
    await pool.query(`UPDATE arc_mainnet_pilot_budget SET spent_usdc_base_units=0,
      reserved_usdc_base_units=0 WHERE id=1`);
    await pool.query('DELETE FROM arc_nonce_reservations');
    await pool.query('DELETE FROM arc_nonce_cursors');
    await pool.query('DELETE FROM arc_infrastructure_nonce_reservations');
    await pool.query('DELETE FROM arc_infrastructure_nonce_cursors');
    await pool.query(`INSERT INTO agents(id,name,public_key) VALUES
      ($1,'Synterra-01',$2),($3,'Arc Mainnet Test Resident B',$4)`,
    [payerId, `arc-mainnet-test-${payerId}`, recipientId, `arc-mainnet-test-${recipientId}`]);
    await pool.query(`INSERT INTO worlds(id,owner_agent_id,name,chain_id)
      VALUES($1,$2,'Arc Mainnet isolated integration world',$3)`, [worldId, payerId, ARC_MAINNET_CHAIN_ID]);
    await pool.query(`INSERT INTO world_members(world_id,agent_id,role,location)
      VALUES($1,$2,'owner','town-square'),($1,$3,'resident','town-square')`, [worldId, payerId, recipientId]);
    await pool.query(`INSERT INTO world_genesis_issuer_assignments(world_id,capability_generation,issuer_agent_id,
        selection_source,assigned_world_minute)
      VALUES($1,1,$2,'creator_genesis_assignment',1000)`, [worldId, payerId]);
    await pool.query(`INSERT INTO world_runtime_state(world_id,tick_count,world_minutes,last_tick_at,typesafe_next_at)
      VALUES($1,0,3000,$2,$2)`, [worldId, new Date(nowMs - 2_000)]);
    await pool.query(`INSERT INTO world_epochs(world_id,epoch_code,name,status,started_world_minute,description)
      VALUES($1,'V7','V7 isolated Arc integration epoch','active',1000,'Mainnet-only fake-provider integration')`, [worldId]);
    await pool.query(`INSERT INTO world_capabilities(id,world_id,capability_key,category,name,description,status,
        version,parent_capability_id,creator_type,creator_agent_id,specification,created_world_minute,adopted_world_minute)
      VALUES($1,$3,'arc-mainnet-test-root','coordination','Arc root capability','Developer seeded test capability','active',1,NULL,
        'system',NULL,'{"steps":["observe"]}'::jsonb,100,100),
        ($2,$3,'arc-mainnet-test-child','coordination','Arc child capability','Resident created test capability','active',1,$1,
        'resident',$4,'{"steps":["observe","share"]}'::jsonb,200,250)`,
    [rootCapabilityId, childCapabilityId, worldId, payerId]);
    await pool.query(`INSERT INTO world_agent_states(world_id,agent_id,goal,risk_tolerance,next_decision_at)
      VALUES($1,$2,'balanced',0.5,$3),($1,$4,'balanced',0.5,$3)`, [worldId, payerId, new Date(nowMs + 86_400_000), recipientId]);

    await pool.query(`INSERT INTO agent_minds(world_id,agent_id,archetype,current_goal)
      VALUES($1,$2,'scholar','coordinate a research exchange with peers'),
        ($1,$3,'maker','support useful research services')`, [worldId, payerId, recipientId]);
    await pool.query(`INSERT INTO agent_memories(world_id,agent_id,memory_type,summary,importance,world_minutes,
        consolidation_key,long_term)
      VALUES($1,$2,'economy','A peer could not record the value of shared research.',0.8,2990,'test-currency-memory',true)`,
    [worldId, payerId]);
    await pool.query(`INSERT INTO arc_agent_wallets(world_id,agent_id,chain_id,address,provider,account_type,status,
        external_identity_id)
      VALUES($1,$2,$3,$4,'external_kms','eoa','active',818),($1,$5,$3,$6,'external_kms','eoa','active',819)`,
    [worldId, payerId, ARC_MAINNET_CHAIN_ID, PAYER, recipientId, RECIPIENT]);

    const config = createIsolatedArcMainnetConfig({ ARC_SETTLEMENT_RUNTIME_CODE_HASH: RUNTIME_CODE_HASH });
    const rpcClient = fakeMainnetRpc({ worldId, config });

    let allowProposal = false;
    let allowIssuerDecision = false;
    let responseRecorded = false;
    let authoringContextObserved = null;
    let reviewOutcomeOverride = null;
    const cognitionChoices = [];
    const cognitionFacts = new Map();
    engine = await startWorldEngine(pool, { worldId, nowProvider: () => engineNowMs, schedule: false,
      currencyGenesisEnabled: true,
      onError: () => true,
      chooseCivilizationOption: async (request) => {
        if (request.choiceType !== 'currency_genesis') return null;
        if (reviewOutcomeOverride) {
          if (reviewOutcomeOverride.type === 'throw') throw reviewOutcomeOverride.error;
          return reviewOutcomeOverride.value;
        }
        cognitionFacts.set(request.agentId, request.state.worldFacts);
        for (const [key, value] of Object.entries(currencyGenesisInfrastructureFacts({
          requirement: { status: request.state.requirementStatus } }))) {
          assert.equal(request.state.worldFacts[key], value);
        }
        const options = request.options || [];
        const choose = options.find((option) => option.id === 'no_action');
        let selected = choose;
        if (allowProposal && request.agentId === payerId
            && options.some((option) => option.id === 'propose_currency')
            && !request.state.currentProposal) {
          selected = options.find((option) => option.id === 'propose_currency');
        } else if (allowProposal && request.agentId === recipientId
            && options.some((option) => option.id.startsWith('response:') && option.id.endsWith(':support'))) {
          selected = options.find((option) => option.id.startsWith('response:') && option.id.endsWith(':support'));
          responseRecorded = true;
        } else if (allowProposal && allowIssuerDecision && responseRecorded && request.agentId === payerId) {
          selected = options.find((option) => option.id === `issuer:${request.state.currentProposal?.id}:issue`)
            || options.find((option) => option.id.startsWith('issuer:') && option.id.endsWith(':issue'))
            || choose;
        }
        if (selected) cognitionChoices.push({ agentId: request.agentId, choice: selected.id });
        return selected ? { choice: { id: selected.id }, confidence: 0.99,
          provider: 'isolated-resident-cognition', model: 'isolated-resident-cognition' } : null;
      },
      authorCurrencyProposal: async (input) => {
        assert.strictEqual(input.worldFacts, cognitionFacts.get(input.resident.agentId),
          'cognition and authoring receive the very same world facts object');
        authoringContextObserved = { agentId: input.resident.agentId, currentGoal: input.resident.currentGoal,
          goalCount: input.resident.goals.length, memories: input.resident.recentMemories.map((memory) => memory.summary),
          requirementStatus: input.worldFacts.requirementStatus,
          recipientCount: input.availableRecipients.length };
        assert.equal(input.resident.agentId, payerId);
        assert.equal(input.resident.currentGoal, 'coordinate a research exchange with peers');
        assert.ok(input.resident.goals.length > 0, 'authoring receives this resident\'s active goals');
        assert.ok(input.resident.recentMemories.some((memory) =>
          memory.summary === 'A peer could not record the value of shared research.'),
        'authoring receives this resident\'s own memory');
        assert.equal(input.worldFacts.requirementStatus, 'UNRESOLVED');
        const proposer = input.availableRecipients.find((recipient) => recipient.id === payerId);
        const peer = input.availableRecipients.find((recipient) => recipient.id === recipientId);
        assert.ok(proposer && peer, 'the resident receives real recipient options from the isolated world');
        return { model: 'isolated-resident-authoring', reason: null, specification: {
          name: 'Research Exchange', symbol: 'REX',
          meaning: `A value record for ${input.resident.currentGoal}.`,
          purpose: input.resident.currentGoal,
          rationale: input.resident.recentMemories[0].summary,
          decimals: 0,
          distribution: [
            { recipientType: 'agent', recipientId: proposer.id, recipientAddress: proposer.address, amount: '600000000' },
            { recipientType: 'agent', recipientId: peer.id, recipientAddress: peer.address, amount: '400000000' }
          ],
          reserveAmount: '0', unallocatedSupplyHandling: 'fully_distributed',
          ownershipModel: 'erc20_holder_owned', authorityModel: 'no_mint_no_burn'
        } };
      },
      onAutonomousBusinessAction: enqueueArcAgentEconomicAction, emergencySink: { write() {} } });
    assert.equal(engine.running, true);
    await inTransaction(pool, (client) => fundTestResidents(client, { worldId, agentIds: [payerId, recipientId] }));
    await pool.query(`UPDATE world_agent_states SET next_decision_at=$3 WHERE world_id=$1 AND agent_id=ANY($2::uuid[])`,
      [worldId, [payerId, recipientId], new Date(nowMs + 86_400_000)]);

    const runCurrencyReview = async () => {
      await pool.query(`UPDATE world_agent_states SET next_civilization_review_world_minutes=0
        WHERE world_id=$1`, [worldId]);
      const before = await pool.query(`SELECT world_minutes FROM world_runtime_state WHERE world_id=$1`, [worldId]);
      engineNowMs += 60_000;
      await engine.tickOnce();
      const after = await pool.query(`SELECT world_minutes FROM world_runtime_state WHERE world_id=$1`, [worldId]);
      assert.ok(Number(after.rows[0].world_minutes) > Number(before.rows[0].world_minutes),
        `isolated engine tick did not advance: ${JSON.stringify(engine.getLiveness())}`);
    };
    await runCurrencyReview();
    let requirement = await pool.query(`SELECT status FROM arc_currency_genesis_requirements WHERE world_id=$1`, [worldId]);
    assert.equal(requirement.rows[0].status, 'UNRESOLVED', 'a no-action cognition choice keeps the persistent requirement alive');
    assert.equal(Number((await pool.query(`SELECT count(*)::int AS count FROM arc_token_issuance_intents WHERE world_id=$1`,
      [worldId])).rows[0].count), 0, 'no proposal is created before a resident chooses one');
    let outcomeEvents = await pool.query(`SELECT actor_agent_id,world_minute,action_id,details FROM world_v7_events
      WHERE world_id=$1 AND event_type='currency_genesis.review_outcome' AND details->>'outcome'='explicit_no_action'`, [worldId]);
    assert.equal(outcomeEvents.rowCount, 2, 'each resident review gets an explicit no-action outcome');
    assert.ok(outcomeEvents.rows.every((row) => row.details.reasonCode === 'offered_choice_selected'
      && row.details.provider === 'isolated-resident-cognition' && row.details.confidence === 0.99));
    const attributedInference = await pool.query(`SELECT attribution_type,agent_id,resource_category,provider,model,
        quantity_raw::text AS quantity_raw,unit,cost_status,cost_currency,cost_microunits::text AS cost_microunits,metadata
      FROM world_infrastructure_usage_events WHERE world_id=$1 ORDER BY agent_id`, [worldId]);
    assert.equal(attributedInference.rowCount, 2, 'each actual review provider request emits one attributable usage record');
    assert.ok(attributedInference.rows.every((row) => row.attribution_type === 'agent'
      && row.agent_id && row.resource_category === 'ai_inference'
      && row.provider === 'isolated-resident-cognition' && row.model === 'isolated-resident-cognition'
      && row.quantity_raw === '1' && row.unit === 'provider_request_attempt'
      && row.cost_status === 'unpriced' && row.cost_currency === null && row.cost_microunits === null
      && row.metadata.outcome === 'explicit_no_action'));
    assert.equal(Number((await pool.query(`SELECT count(*)::int AS count FROM world_infrastructure_fee_policies
      WHERE world_id=$1`, [worldId])).rows[0].count), 0,
    'the infrastructure metering path does not configure an operator fee or Agent tax');

    const assertLatestReviewOutcome = async (expected) => {
      const latest = await pool.query(`SELECT world_minute FROM world_v7_events WHERE world_id=$1
        AND event_type='currency_genesis.review_outcome' ORDER BY world_minute DESC,created_at DESC LIMIT 1`, [worldId]);
      const events = await pool.query(`SELECT details->>'outcome' AS outcome FROM world_v7_events
        WHERE world_id=$1 AND event_type='currency_genesis.review_outcome' AND world_minute=$2`,
      [worldId, latest.rows[0].world_minute]);
      assert.equal(events.rowCount, 2);
      assert.ok(events.rows.every((row) => row.outcome === expected),
        `expected ${expected} outcomes, got ${JSON.stringify(events.rows)}`);
    };
    const runReviewFailure = async (override, expectedOutcome) => {
      reviewOutcomeOverride = override;
      await runCurrencyReview();
      await assertLatestReviewOutcome(expectedOutcome);
      const currentRequirement = await pool.query(`SELECT status FROM arc_currency_genesis_requirements WHERE world_id=$1`, [worldId]);
      assert.equal(currentRequirement.rows[0].status, 'UNRESOLVED', 'outcome diagnostics do not advance requirement state');
      assert.equal(Number((await pool.query(`SELECT count(*)::int AS count FROM arc_token_issuance_intents WHERE world_id=$1`,
        [worldId])).rows[0].count), 0, 'outcome diagnostics do not create a proposal');
    };
    await runReviewFailure({ type: 'throw', error: Object.assign(new Error('timed out'), { name: 'APITimeoutError' }) },
      'provider_timeout');
    await runReviewFailure({ type: 'return', value: {} }, 'malformed_output');
    await runReviewFailure({ type: 'return', value: { choice: { id: 'no_action' }, confidence: 0.1,
      model: 'isolated-resident-cognition', provider: 'isolated-resident-cognition' } }, 'low_confidence');
    await runReviewFailure({ type: 'throw', error: new Error('simulated provider error') }, 'provider_error');
    await runReviewFailure({ type: 'return', value: { choice: { id: 'not-an-offered-option' }, confidence: 0.99,
      model: 'isolated-resident-cognition', provider: 'isolated-resident-cognition' } }, 'invalid_choice');
    await runReviewFailure({ type: 'return', value: null }, 'no_valid_decision');

    const savedApiKey = process.env.TYPESAFE_API_KEY;
    delete process.env.TYPESAFE_API_KEY;
    let unavailableResult;
    try {
      unavailableResult = await chooseCivilizationOption({ choiceType: 'currency_genesis', options: [
        { id: 'no_action', label: 'No action', description: 'none' },
        { id: 'propose_currency', label: 'Propose', description: 'proposal' }
      ] }, {});
    } finally {
      if (savedApiKey === undefined) delete process.env.TYPESAFE_API_KEY;
      else process.env.TYPESAFE_API_KEY = savedApiKey;
    }
    assert.equal(unavailableResult.currencyReviewDiagnostic.outcome, 'provider_unavailable');
    await runReviewFailure({ type: 'return', value: unavailableResult }, 'provider_unavailable');

    assert.ok(cognitionChoices.some((entry) => entry.choice === 'no_action'));
    assert.equal(authoringContextObserved, null, 'network facts alone do not invoke authoring');
    for (const table of ['arc_token_issuance_issuer_candidates', 'arc_token_issuance_decisions', 'arc_agent_tokens']) {
      assert.equal((await pool.query(`SELECT count(*)::int AS count FROM ${table} WHERE world_id=$1`, [worldId])).rows[0].count, 0);
    }
    assert.equal(cognitionFacts.get(payerId).mainnetWriteGate, false);

    reviewOutcomeOverride = null;
    allowProposal = true;
    await runCurrencyReview();
    let proposal = await pool.query(`SELECT id,status,decision_path,issuer_agent_id,issuer_selection_source,name,specification_hash
      FROM arc_token_issuance_intents WHERE world_id=$1 ORDER BY created_world_minute,id LIMIT 1`, [worldId]);
    for (let attempt = 0; attempt < 4 && (!proposal.rowCount || !responseRecorded); attempt += 1) {
      await runCurrencyReview();
      proposal = await pool.query(`SELECT id,status,decision_path,issuer_agent_id,issuer_selection_source,name,specification_hash
        FROM arc_token_issuance_intents WHERE world_id=$1 ORDER BY created_world_minute,id LIMIT 1`, [worldId]);
    }
    assert.equal(proposal.rowCount, 1, 'a resident created a proposal through the persistent World Engine review');
    assert.equal(proposal.rows[0].decision_path, 'world_engine');
    outcomeEvents = await pool.query(`SELECT details FROM world_v7_events WHERE world_id=$1
      AND actor_agent_id=$2 AND event_type='currency_genesis.review_outcome'
      AND details->>'outcome'='explicit_propose'`, [worldId, payerId]);
    assert.ok(outcomeEvents.rowCount >= 1 && outcomeEvents.rows.some((row) =>
      row.details.actionId === 'propose_currency' && row.details.confidence === 0.99));
    assert.ok(authoringContextObserved, 'a resident who chose the proposal action invoked local authoring');
    assert.equal(proposal.rows[0].name, 'Research Exchange', JSON.stringify(authoringContextObserved));
    assert.equal(proposal.rows[0].status, 'proposed', 'a complete Agent-authored specification remains unconfirmed');
    assert.equal(proposal.rows[0].specification_hash, null,
      'proposal authoring is not itself execution confirmation');
    const preConfirmationDecisions = await pool.query(`SELECT decision,agent_id,action_id FROM arc_token_issuance_decisions
      WHERE world_id=$1 AND intent_id=$2 AND agent_id=$3
        AND decision IN ('issuer_confirm','issuer_reject','issuer_defer')`, [worldId, proposal.rows[0].id, payerId]);
    assert.equal(preConfirmationDecisions.rowCount, 0,
      `proposal authoring and resident response do not create an issuer decision: ${JSON.stringify(preConfirmationDecisions.rows)}`);
    const proposalId = proposal.rows[0].id;
    const response = await pool.query(`SELECT decision,agent_id FROM arc_token_issuance_responses
      WHERE world_id=$1 AND intent_id=$2`, [worldId, proposalId]);
    assert.equal(response.rowCount, 1);
    assert.equal(response.rows[0].agent_id, recipientId);
    assert.equal(response.rows[0].decision, 'support');
    outcomeEvents = await pool.query(`SELECT details FROM world_v7_events WHERE world_id=$1
      AND actor_agent_id=$2 AND event_type='currency_genesis.review_outcome'
      AND details->>'outcome'='explicit_response'`, [worldId, recipientId]);
    assert.ok(outcomeEvents.rowCount >= 1 && outcomeEvents.rows.some((row) =>
      String(row.details.actionId).startsWith('response:') && row.details.confidence === 0.99));
    allowIssuerDecision = true;
    await assert.rejects(() => inTransaction(pool, (client) => confirmWorldTokenIssuance(client, {
      worldId, agentId: recipientId, intentId: proposalId, decision: null,
      actionId: 'missing-decision-confirmation', worldMinute: 3000
    })), (error) => error.message === 'TOKEN_ISSUER_DECISION_INVALID');
    for (let attempt = 0; attempt < 5; attempt += 1) {
      proposal = await pool.query(`SELECT id,status FROM arc_token_issuance_intents WHERE world_id=$1 AND id=$2`,
        [worldId, proposalId]);
      if (proposal.rows[0]?.status === 'issuer_confirmed') break;
      await runCurrencyReview();
    }
    proposal = await pool.query(`SELECT id,status,decision_path,issuer_agent_id,issuer_selection_source,name,symbol,specification_hash,
        transaction_hash,initial_supply_human,distribution,unallocated_supply_handling,ownership_model,authority_model
      FROM arc_token_issuance_intents WHERE world_id=$1 AND id=$2`, [worldId, proposalId]);
    assert.equal(proposal.rows[0].issuer_agent_id, payerId, 'Generation 1 uses the explicitly assigned Synterra-01 issuer');
    assert.equal(proposal.rows[0].issuer_selection_source, 'creator_genesis_assignment');
    assert.equal(proposal.rows[0].status, 'issuer_confirmed', 'Synterra-01 explicitly confirmed its complete Agent-authored specification');
    assert.equal(proposal.rows[0].name, 'Research Exchange');
    assert.equal(proposal.rows[0].symbol, 'REX');
    assert.equal(proposal.rows[0].initial_supply_human, '1000000000');
    assert.equal(proposal.rows[0].unallocated_supply_handling, 'fully_distributed');
    assert.equal(proposal.rows[0].ownership_model, 'erc20_holder_owned');
    assert.equal(proposal.rows[0].authority_model, 'no_mint_no_burn');
    assert.ok(cognitionChoices.some((entry) => entry.choice === 'propose_currency'));
    assert.ok(cognitionChoices.some((entry) => entry.choice.startsWith('response:') && entry.choice.endsWith(':support')));
    assert.ok(!cognitionChoices.some((entry) => entry.choice.startsWith(`nominate:${proposalId}:`)));
    assert.ok(!cognitionChoices.some((entry) => entry.choice.startsWith(`candidate:${recipientId}:`)));
    assert.ok(cognitionChoices.some((entry) => entry.agentId === payerId
      && entry.choice === `issuer:${proposalId}:issue`));
    outcomeEvents = await pool.query(`SELECT details FROM world_v7_events WHERE world_id=$1
      AND actor_agent_id=$2 AND event_type='currency_genesis.review_outcome'
      AND details->>'outcome'='other'`, [worldId, payerId]);
    assert.ok(outcomeEvents.rows.some((row) => row.details.actionId === `issuer:${proposalId}:issue`),
      'the explicit issuer decision is distinguishable from a provider non-decision');
    assert.match(proposal.rows[0].specification_hash, /^0x[0-9a-f]{64}$/i,
      'the Agent-authored specification has a canonical hash before broadcast');
    assert.equal(proposal.rows[0].transaction_hash, null, 'no chain submission is claimed by off-chain confirmation');
    requirement = await pool.query(`SELECT status FROM arc_currency_genesis_requirements WHERE world_id=$1`, [worldId]);
    assert.notEqual(requirement.rows[0].status, 'SATISFIED');
    assert.equal(Number((await pool.query(`SELECT count(*)::int AS count FROM arc_agent_tokens WHERE world_id=$1`,
      [worldId])).rows[0].count), 0, 'no token is created in this isolated acceptance path');

    let tokenBroadcasts = 0;
    const readOnlyConfig = Object.freeze({ ...config, writesEnabled: false });
    tokenWorker = new ArcAgentTokenIssuanceWorker({ pool, config: readOnlyConfig,
      env: {}, signer: { async getAddress() { return PAYER; }, async sendTransaction() { tokenBroadcasts += 1; } },
      rpcClient: { async getChainId() { return ARC_MAINNET_CHAIN_ID; }, async getBlockNumber() { return '0x1234'; } },
      isOwner: () => true, intervalMs: 60_000 });
    await tokenWorker.start({ worldId });
    assert.equal(tokenWorker.getStatus().mode, 'read_only_reconciliation');
    assert.equal(tokenWorker.getStatus().writesEnabled, false);
    assert.equal(tokenBroadcasts, 0, 'closed Mainnet gate prevents token issuance broadcast');
    await tokenWorker.stop();
    tokenWorker = null;

    const latestRuntime = await pool.query(`SELECT world_minutes FROM world_runtime_state WHERE world_id=$1`, [worldId]);
    await inTransaction(pool, (client) => advanceWorldCurrencyGenesis(client, { worldId,
      agent: { agentId: payerId }, worldMinute: Number(latestRuntime.rows[0].world_minutes) + 1,
      reviewDue: false }));
    outcomeEvents = await pool.query(`SELECT details FROM world_v7_events WHERE world_id=$1
      AND event_type='currency_genesis.review_outcome' AND details->>'outcome'='skipped_not_due'`, [worldId]);
    assert.equal(outcomeEvents.rowCount, 1, 'an explicit non-due review attempt is recorded once');
    assert.equal(outcomeEvents.rows[0].details.reasonCode, 'review_not_due');

    const revalidatedSchema = await applyWorldSchemaAndMigrations(pool, { rootDirectory: repoRoot });
    assert.deepEqual(revalidatedSchema.applied, [], 'a restart reapplies no migration and preserves open currency history');
    assert.ok(revalidatedSchema.alreadyApplied.includes('0002_arc_agent_token_issuance.sql'));

    const fkClient = await pool.connect();
    try {
      await fkClient.query('BEGIN');
      await fkClient.query(`DELETE FROM arc_token_issuance_intents WHERE world_id=$1 AND id=$2`, [worldId, proposalId]);
      const preservedRequirement = await fkClient.query(`SELECT world_id,capability_generation,status,current_proposal_id
        FROM arc_currency_genesis_requirements WHERE world_id=$1`, [worldId]);
      assert.equal(preservedRequirement.rows[0].world_id, worldId);
      assert.equal(preservedRequirement.rows[0].capability_generation, 1);
      assert.equal(preservedRequirement.rows[0].current_proposal_id, null,
        'deleting an intent clears only the nullable proposal pointer');
      assert.notEqual(preservedRequirement.rows[0].status, 'SATISFIED');
      await fkClient.query('ROLLBACK');
    } catch (error) {
      await fkClient.query('ROLLBACK');
      throw error;
    } finally { fkClient.release(); }

    const business = await inTransaction(pool, (client) => foundWorldBusiness(client, { worldId, agentId: recipientId,
      actionId: 'arc-mainnet-business-seed', worldTime: 3000,
      proposal: { name: 'Arc Research Studio', businessType: 'research', purpose: 'Offer a research service in the isolated integration world.',
        serviceType: 'research_service', serviceName: 'Research Notes',
        serviceDescription: 'A deterministic research service for the isolated Arc integration world.', capitalUsdc: '250.00000000',
        basePriceUsdc: '5.00000000' } }));

    await pool.query(`UPDATE world_agent_states SET status='performing',planned_action='business_work',
        planned_context=$3::jsonb,action_started_at=$4,action_ends_at=$5,next_decision_at=$6
      WHERE world_id=$1 AND agent_id=$2`, [worldId, recipientId,
      JSON.stringify({ businessId: business.id, serviceId: business.serviceId }),
      new Date(nowMs - 30_000), new Date(nowMs - 1), new Date(nowMs + 86_400_000)]);
    await engine.tickOnce();
    const production = await pool.query(`SELECT data FROM world_events
      WHERE world_id=$1 AND actor_id=$2 AND event_type='world.action_completed'
        AND data->>'initiativeAction'='business_work' ORDER BY id DESC LIMIT 1`, [worldId, recipientId]);
    assert.equal(production.rowCount, 1, 'the business founder autonomously produced service stock through the World Engine');
    assert.equal(production.rows[0].data.abandoned, undefined);

    await pool.query(`UPDATE world_agent_states SET status='performing',planned_action='business_service',
        planned_context=$3::jsonb,action_started_at=$4,action_ends_at=$5,next_decision_at=$6
      WHERE world_id=$1 AND agent_id=$2`, [worldId, payerId,
      JSON.stringify({ serviceId: business.serviceId, maxPriceUsdc: '500.00000000' }),
      new Date(nowMs - 30_000), new Date(nowMs - 1), new Date(nowMs + 86_400_000)]);
    await engine.tickOnce();

    const actionResult = await pool.query(`SELECT id,data FROM world_events
      WHERE world_id=$1 AND actor_id=$2 AND event_type='world.action_completed'
        AND data->>'initiativeAction'='business_service' ORDER BY id DESC LIMIT 1`, [worldId, payerId]);
    assert.equal(actionResult.rowCount, 1, 'the World Engine completed the resident-selected service action');
    const outboxBeforePolicy = await pool.query(`SELECT world_action_id,world_event_id,chain_id,status,
        from_agent_id,to_agent_id,action_family,simulated_amount_usdc,created_world_minute,metadata
      FROM arc_settlement_outbox WHERE world_id=$1`, [worldId]);
    assert.equal(outboxBeforePolicy.rowCount, 1,
      `the autonomous action wrote a persistent outbox row; event=${JSON.stringify(actionResult.rows[0]?.data)} ` +
      `outbox=${JSON.stringify(outboxBeforePolicy.rows)}`);
    assert.equal(Number(outboxBeforePolicy.rows[0].chain_id), ARC_MAINNET_CHAIN_ID);
    assert.equal(outboxBeforePolicy.rows[0].status, 'policy_pending');
    assert.equal(outboxBeforePolicy.rows[0].from_agent_id, payerId);
    assert.equal(outboxBeforePolicy.rows[0].to_agent_id, recipientId);
    assert.equal(outboxBeforePolicy.rows[0].action_family, 'resident_service_purchase');
    assert.ok(Number(outboxBeforePolicy.rows[0].simulated_amount_usdc) < 10,
      'the real Agent action path stays within the shared 10 USDC pilot budget');
    assert.equal(String(outboxBeforePolicy.rows[0].world_event_id), String(actionResult.rows[0].id));
    const replayedOutbox = await inTransaction(pool, (client) => enqueueArcAgentEconomicAction(client, {
      worldId, worldActionId: outboxBeforePolicy.rows[0].world_action_id,
      worldEventId: actionResult.rows[0].id, fromAgentId: payerId, toAgentId: recipientId,
      simulatedAmountUsdc: String(outboxBeforePolicy.rows[0].simulated_amount_usdc),
      worldMinute: Number(outboxBeforePolicy.rows[0].created_world_minute),
      orderId: outboxBeforePolicy.rows[0].metadata.orderId,
      businessId: outboxBeforePolicy.rows[0].metadata.businessId
    }));
    assert.equal(replayedOutbox.created, false, 'replaying the same completed Agent action does not duplicate its settlement intent');
    assert.equal(String((await pool.query(`SELECT count(*)::int AS count FROM arc_settlement_outbox WHERE world_id=$1`,
      [worldId])).rows[0].count), '1');

    await pool.query(`INSERT INTO arc_spending_policies(world_id,agent_id,chain_id,token_address,
        per_action_limit_base_units,daily_limit_base_units,settlement_basis_points,allowed_action_families,
        allowed_contracts,emergency_paused,policy_version)
      VALUES($1,$2,$3,$4,100000000,500000000,10000,ARRAY['resident_service_purchase'],ARRAY[$5],false,1)`,
    [worldId, payerId, ARC_MAINNET_CHAIN_ID, ARC_MAINNET_USDC_ADDRESS, CONTRACT]);

    const submitted = [];
    const signer = new DeterministicFakeArcSigner({ config,
      addresses: { [payerId]: PAYER, [recipientId]: RECIPIENT }, transactionHash: txHash,
      submitted });
    worker = new ArcSettlementOutboxWorker({ pool, config,
      env: { ARC_SETTLEMENT_CONTRACT_ADDRESS: CONTRACT }, signer, rpcClient,
      isOwner: () => true, intervalMs: 60_000 });
    await worker.start();
    const workerStatus = worker.getStatus();
    assert.equal(workerStatus.running, true);
    assert.ok(workerStatus.lastResult, `the outbox worker completed its startup pass: ${JSON.stringify(workerStatus)}`);
    assert.equal(workerStatus.lastResult.policyProcessed, true);
    assert.equal(workerStatus.lastResult.status, 'submitted');
    assert.equal(submitted.length, 1, 'only the deterministic fake signer receives the production-built transaction');
    assert.equal(submitted[0].chainId, ARC_MAINNET_CHAIN_ID);
    assert.equal(submitted[0].to, CONTRACT);
    assert.ok(rpcClient.calls.includes(ARC_SETTLEMENT_POLICY_INTERFACE.getFunction('spendingPolicies').selector.toLowerCase()),
      'the worker read and evaluated the on-chain spending policy');
    const outboxAfterPolicy = await pool.query(`SELECT status,transaction_hash,amount_base_units,policy_reason
      FROM arc_settlement_outbox WHERE world_id=$1`, [worldId]);
    assert.equal(outboxAfterPolicy.rows[0].status, 'submitted');
    assert.equal(outboxAfterPolicy.rows[0].transaction_hash, txHash);
    assert.ok(BigInt(outboxAfterPolicy.rows[0].amount_base_units) > 0n);
    assert.equal(outboxAfterPolicy.rows[0].policy_reason, 'ONCHAIN_POLICY_APPROVED');

    const checkpointClient = await pool.connect();
    try {
      const checkpoint = await prepareArcWorldCheckpoint(checkpointClient, { worldId, chainId: ARC_MAINNET_CHAIN_ID });
      const replay = await prepareArcWorldCheckpoint(checkpointClient, { worldId, chainId: ARC_MAINNET_CHAIN_ID });
      assert.equal(checkpoint.due, true);
      assert.equal(checkpoint.checkpoint.version, '1');
      assert.equal(replay.due, false, 'a world minute with an existing checkpoint is not checkpointed twice');
      assert.equal(replay.reason, 'world_minute_not_advanced');
      assert.equal(Number((await pool.query(`SELECT count(*)::int AS count FROM arc_world_checkpoints
        WHERE world_id=$1 AND chain_id=$2`, [worldId, ARC_MAINNET_CHAIN_ID])).rows[0].count), 1);
      const capability = await prepareArcCapabilityProvenance(checkpointClient, {
        worldId, capabilityId: childCapabilityId, chainId: ARC_MAINNET_CHAIN_ID
      });
      const capabilityReplay = await prepareArcCapabilityProvenance(checkpointClient, {
        worldId, capabilityId: childCapabilityId, chainId: ARC_MAINNET_CHAIN_ID
      });
      assert.equal(capability.created, true);
      assert.equal(capabilityReplay.created, false);
      assert.equal(capability.provenance.creator_type, 'resident');
      assert.equal(capability.provenance.parent_capability_id, rootCapabilityId);
      assert.equal(capability.provenance.adopted_world_minute, '250');
    } finally { checkpointClient.release(); }

    const indexed = await indexTrackedUsdcTransfers({ client: pool, rpc: { async getLogs() {
      return [{ transactionHash: txHash, blockNumber: '0x123', logIndex: '0x0', blockHash: HASH,
        address: SYSTEM_EMITTER, topics: [HASH], data: '0x' }];
    } }, chainId: ARC_MAINNET_CHAIN_ID, sourceKey: `arc-mainnet-isolated:${worldId}`, worldId,
    trackedWallets: [PAYER], startBlock: 1n, latestBlock: 300n, maxBlockCount: 500n, maxPages: 1 });
    assert.equal(indexed.indexedLogs, 1);

    const observer = new ArcReadOnlyObserver({ pool, config,
      env: { ARC_SETTLEMENT_CONTRACT_ADDRESS: CONTRACT,
        ARC_WORLD_REGISTRY_ADDRESS: '0x4444444444444444444444444444444444444444',
        ARC_CAPABILITY_PROVENANCE_ADDRESS: '0x5555555555555555555555555555555555555555' },
      rpcClient, isOwner: () => true, intervalMs: 60_000 });
    try {
      await observer.start({ worldId });
      const status = observer.getStatus();
      assert.equal(status.running, true);
      assert.equal(status.mode, 'read_only');
      assert.equal(status.worldId, worldId);
      assert.equal(status.usdc.verified, true);
      assert.equal(status.arcMainnet.pendingSettlements, 1);
      assert.equal(status.arcMainnet.settlementEnabled, false);
      assert.equal(status.database.capabilityProvenance.total, 1);
      assert.equal(status.database.recentSettlements[0].transactionHash, txHash);
    } finally { await observer.stop(); }

    await pool.query('DELETE FROM arc_mainnet_pilot_cost_reservations');
    await pool.query(`UPDATE arc_mainnet_pilot_budget SET spent_usdc_base_units=0,
      reserved_usdc_base_units=0 WHERE id=1`);
    const reserveConcurrent = async (operationId) => {
      try {
        return await inTransaction(pool, (client) => reserveArcMainnetPilotCost(client, {
          operationType: 'token_creation', operationId, worldId,
          transferUsdcBaseUnits: 6_000_000n, gasLimit: 1n, maxFeePerGas: 1n
        }));
      } catch (error) {
        if (error.code === 'ARC_MAINNET_PILOT_COST_CAP_EXCEEDED') return null;
        throw error;
      }
    };
    const concurrentBudgetResults = await Promise.all([
      reserveConcurrent(`budget-a-${worldId}`), reserveConcurrent(`budget-b-${worldId}`)
    ]);
    assert.equal(concurrentBudgetResults.filter(Boolean).length, 1,
      'two concurrent operations cannot each reserve the same remaining 10 USDC pilot budget');
    const reservedOperation = concurrentBudgetResults[0] ? `budget-a-${worldId}` : `budget-b-${worldId}`;
    await inTransaction(pool, (client) => setArcMainnetPilotCostStatus(client, {
      operationType: 'token_creation', operationId: reservedOperation, status: 'submission_unknown'
    }));
    await assert.rejects(() => inTransaction(pool, (client) => releaseArcMainnetPilotCost(client, {
      operationType: 'token_creation', operationId: reservedOperation
    })), { code: 'ARC_PILOT_COST_RESERVATION_CANNOT_BE_RELEASED' });
    const budgetAfterUnknown = await pool.query(`SELECT reserved_usdc_base_units::text AS reserved
      FROM arc_mainnet_pilot_budget WHERE id=1`);
    assert.equal(budgetAfterUnknown.rows[0].reserved, '6000001',
      'unknown submission keeps its global pilot budget reservation');
    await pool.query('DELETE FROM arc_mainnet_pilot_cost_reservations');
    await pool.query(`UPDATE arc_mainnet_pilot_budget SET spent_usdc_base_units=0,
      reserved_usdc_base_units=0 WHERE id=1`);
  } finally {
    if (tokenWorker) await tokenWorker.stop();
    if (worker) await worker.stop();
    if (engine) await engine.stop();
    await pool.end();
  }
});

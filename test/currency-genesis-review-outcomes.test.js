import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { TypeSafeClient } from '@typesafe-ai/sdk';
import { chooseCivilizationOption, initializeTypeSafeProvider } from '../src/agent-runtime/typesafe.js';
import { classifyCurrencyReviewResult, currencyReviewErrorOutcome,
  recordCurrencyReviewOutcome } from '../src/world-token-issuance.js';
import { recordInfrastructureUsageEvent } from '../src/infrastructure-metering.js';
import { currencyGenesisInfrastructureFacts } from '../src/arc/currency-genesis-context.js';
import { arcNetworkConfig } from '../src/arc/config.js';

const options = [
  { id: 'no_action', label: 'No action' },
  { id: 'propose_currency', label: 'Propose currency' },
  { id: 'response:00000000-0000-4000-8000-000000000000:support', label: 'Support proposal' },
  { id: 'issuer:00000000-0000-4000-8000-000000000000:reject', label: 'Reject issuer role' }
];

test('currency review result classifier preserves explicit choices and separates non-decisions', () => {
  const noAction = classifyCurrencyReviewResult({ choice: { id: 'no_action' }, confidence: 0.91,
    provider: 'typesafe', model: 'jev-1.13.0' }, options);
  assert.equal(noAction.diagnostic.outcome, 'explicit_no_action');
  assert.equal(noAction.diagnostic.confidence, 0.91);

  const proposal = classifyCurrencyReviewResult({ choice: { id: 'propose_currency' }, confidence: 0.8 }, options);
  assert.equal(proposal.diagnostic.outcome, 'explicit_propose');
  assert.equal(proposal.diagnostic.selectedActionId, 'propose_currency');

  const response = classifyCurrencyReviewResult({ choice: options[2].id, confidence: 0.8 }, options);
  assert.equal(response.diagnostic.outcome, 'explicit_response');

  const other = classifyCurrencyReviewResult({ choice: options[3].id, confidence: 0.8 }, options);
  assert.equal(other.diagnostic.outcome, 'other');
  assert.equal(other.diagnostic.selectedActionId, options[3].id);

  assert.equal(classifyCurrencyReviewResult(null, options).diagnostic.outcome, 'no_valid_decision');
  assert.equal(classifyCurrencyReviewResult({}, options).diagnostic.outcome, 'malformed_output');
  assert.equal(classifyCurrencyReviewResult({ choice: 'not-offered', confidence: 0.8 }, options).diagnostic.outcome,
    'invalid_choice');
  assert.equal(classifyCurrencyReviewResult({ choice: 'no_action', confidence: 0.29 }, options).diagnostic.outcome,
    'low_confidence');
  assert.equal(classifyCurrencyReviewResult({ currencyReviewDiagnostic: { outcome: 'provider_unavailable',
    reasonCode: 'missing_api_key', provider: 'typesafe', model: 'jev-1.13.0' } }, options).diagnostic.outcome,
  'provider_unavailable');
});

test('currency review provider failures keep distinct reason codes', () => {
  const timeout = Object.assign(new Error('request timed out'), { name: 'APITimeoutError' });
  assert.deepEqual(currencyReviewErrorOutcome(timeout), {
    outcome: 'provider_timeout', reasonCode: 'provider_request_timeout'
  });
  assert.deepEqual(currencyReviewErrorOutcome(Object.assign(new Error('offline'), { code: 'ECONNREFUSED' })), {
    outcome: 'provider_unavailable', reasonCode: 'provider_connection_unavailable'
  });
  assert.deepEqual(currencyReviewErrorOutcome(new Error('unexpected provider failure')), {
    outcome: 'provider_error', reasonCode: 'provider_request_error'
  });
});

test('Currency Genesis reports an unavailable TypeSafe provider without invoking it', async () => {
  const savedApiKey = process.env.TYPESAFE_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
  try {
    assert.deepEqual(initializeTypeSafeProvider(), { initialized: false, reason: 'missing_api_key' });
    const result = await chooseCivilizationOption({ choiceType: 'currency_genesis', options }, {});
    assert.deepEqual(result.currencyReviewDiagnostic, { outcome: 'provider_unavailable',
      reasonCode: 'missing_api_key', provider: 'typesafe', model: 'jev-1.13.0', confidence: null,
      providerAttempted: false, inputTokens: null, estimatedCostUsd: null });
  } finally {
    if (savedApiKey === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = savedApiKey;
  }
});

test('initialized TypeSafe client attempts the offered currency review with authoritative Genesis facts', async (t) => {
  const savedApiKey = process.env.TYPESAFE_API_KEY;
  process.env.TYPESAFE_API_KEY = 'test-only-typesafe-key';
  const attempts = [];
  t.mock.method(TypeSafeClient.prototype, 'systemOne', async (request, options) => {
    attempts.push({ request, options });
    return { answers: { civilization_choice: { choice: 'no_action', confidence: 0.91 } },
      usage: { input_tokens: 48 }, model: 'jev-1.13.0' };
  });
  try {
    assert.deepEqual(initializeTypeSafeProvider(), { initialized: true });
    const issuerAssignment = { issuerName: 'Synterra-01', capabilityGeneration: 1,
      selectionSource: 'creator_genesis_assignment' };
    const worldFacts = currencyGenesisInfrastructureFacts({ requirement: { status: 'UNRESOLVED' },
      issuerAssignment, config: arcNetworkConfig({}) });
    const result = await chooseCivilizationOption({ choiceType: 'currency_genesis', worldId: randomUUID(),
      worldMinute: 460_496, agent: { agentId: randomUUID() }, state: { worldFacts }, options },
    { typesafeUsage: { month: new Date().toISOString().slice(0, 7), spentUsd: 0, pending: null } },
    { persistState: async () => {} });

    assert.equal(attempts.length, 1, 'the TypeSafe callback was actually attempted');
    assert.equal(result.choice.id, 'no_action');
    assert.equal(result.providerAttempted, true);
    assert.equal(result.provider, 'typesafe');
    assert.equal(result.model, 'jev-1.13.0');
    const observedFacts = attempts[0].request.state.observedState.worldFacts;
    for (const [key, value] of Object.entries(worldFacts)) assert.equal(observedFacts[key], value);
    assert.deepEqual({ requirement: observedFacts.currencyRequirement,
      status: observedFacts.requirementStatus, issuer: observedFacts.genesisIssuer,
      generation: observedFacts.generation, provenance: observedFacts.issuerSelectionSource,
      network: observedFacts.executionNetwork, chainId: observedFacts.chainId,
      supply: observedFacts.totalHumanReadableSupply, gate: observedFacts.mainnetWriteGate }, {
      requirement: 'CURRENCY_GENESIS_REQUIRED', status: 'UNRESOLVED', issuer: 'Synterra-01', generation: 1,
      provenance: 'creator_genesis_assignment', network: 'Arc Mainnet', chainId: 5042,
      supply: '1000000000', gate: false
    });
  } finally {
    if (savedApiKey === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = savedApiKey;
  }
});

test('currency review outcome persistence writes only an idempotent diagnostic event', async () => {
  const calls = [];
  const client = { async query(sql, parameters) { calls.push({ sql, parameters }); return { rowCount: 1 }; } };
  const worldId = randomUUID();
  const agentId = randomUUID();
  await recordCurrencyReviewOutcome(client, { worldId, agent: { agentId }, worldMinute: 42,
    requirement: { status: 'UNRESOLVED' }, outcome: 'provider_timeout',
    reasonCode: 'provider_request_timeout', provider: 'typesafe', model: 'jev-1.13.0', confidence: null });

  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /INSERT INTO world_v7_events/);
  assert.match(calls[0].sql, /ON CONFLICT\(world_id,actor_agent_id,action_id\) DO NOTHING/);
  assert.doesNotMatch(calls[0].sql, /INSERT INTO (?:arc_token_issuance_intents|arc_currency_genesis_requirements)/);
  const [savedWorldId, savedAgentId, entityId, worldMinute, rawDetails, actionId] = calls[0].parameters;
  const details = JSON.parse(rawDetails);
  assert.equal(savedWorldId, worldId);
  assert.equal(savedAgentId, agentId);
  assert.equal(entityId, worldId);
  assert.equal(worldMinute, 42);
  assert.equal(details.reviewId, actionId);
  assert.equal(details.provider, 'typesafe');
  assert.equal(details.model, 'jev-1.13.0');
  assert.equal(details.outcome, 'provider_timeout');
  assert.equal(details.reasonCode, 'provider_request_timeout');
  assert.equal(details.confidence, null);
  assert.equal(details.requirementStatus, 'UNRESOLVED');
  assert.equal(calls.some((call) => /MAINNET|sendTransaction|broadcast/i.test(call.sql)), false);
});

test('infrastructure metering records attributable unpriced usage without creating a fee or payment', async () => {
  const calls = [];
  const client = { async query(sql, parameters) {
    calls.push({ sql, parameters });
    return { rowCount: 1, rows: [{ id: 'meter-event-id' }] };
  } };
  const worldId = randomUUID();
  const agentId = randomUUID();
  const recorded = await recordInfrastructureUsageEvent(client, { worldId, attributionType: 'agent', agentId,
    actionId: 'currency-review-inference-01', resourceCategory: 'ai_inference', provider: 'typesafe',
    model: 'jev-1.13.0', worldMinute: 42, quantityRaw: '128', unit: 'provider_input_token',
    costStatus: 'unpriced', metadata: { reviewId: 'review-01', outcome: 'explicit_no_action' } });
  assert.deepEqual(recorded, { id: 'meter-event-id', created: true });
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /INSERT INTO world_infrastructure_usage_events/);
  assert.doesNotMatch(calls[0].sql, /INSERT INTO (?:world_economic_accounts|world_economic_transactions|arc_genesis_token_settlement_outbox|world_infrastructure_fee_policies)/);
  assert.equal(calls[0].parameters[0], worldId);
  assert.equal(calls[0].parameters[1], 'agent');
  assert.equal(calls[0].parameters[2], agentId);
  assert.equal(calls[0].parameters[8], 42);
  assert.equal(calls[0].parameters[9], '128');
  assert.equal(calls[0].parameters[10], 'provider_input_token');
  assert.equal(calls[0].parameters[11], 'unpriced');
  assert.equal(calls[0].parameters[12], null);
  assert.equal(calls[0].parameters[13], null);
  assert.equal(calls[0].parameters[14], null);
  await assert.rejects(() => recordInfrastructureUsageEvent(client, { worldId, attributionType: 'agent', agentId,
    actionId: 'currency-review-inference-02', resourceCategory: 'ai_inference', provider: 'typesafe',
    worldMinute: 43, quantityRaw: '1', unit: 'provider_request_attempt', costStatus: 'actual',
    costCurrency: 'ARC_USDC', costChainId: 5042, costMicrounits: '1000000', metadata: {} }),
  (error) => error.code === 'INFRASTRUCTURE_ACTUAL_COST_EVIDENCE_REQUIRED');
  assert.equal(calls.length, 1, 'an unsupported actual charge is rejected before it reaches persistence');
});

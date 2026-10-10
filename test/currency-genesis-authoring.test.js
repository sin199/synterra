import test from 'node:test';
import assert from 'node:assert/strict';
import { currencyGenesisInfrastructureFacts } from '../src/arc/currency-genesis-context.js';
import { arcNetworkConfig } from '../src/arc/config.js';
import { authorAgentCurrencyProposal } from '../src/agent-runtime/currency-genesis-authoring.js';

const SPECIFICATION = { name: 'Exchange', symbol: 'EX', meaning: 'A resident expression.', purpose: 'A resident purpose.' };

test('local authoring receives resident-specific state and only expresses a prior cognition choice', async () => {
  const residentInput = {
    resident: {
      agentId: 'resident-a', currentGoal: 'coordinate research exchange',
      goals: [{ category: 'cooperation', description: 'Share research notes', priority: 0.8, status: 'active' }],
      recentMemories: [{ memoryType: 'economy', summary: 'A peer lacked a way to record exchange.', worldMinutes: 40 }],
      energy: 0.7, food: 0.8, social: 0.6, knowledge: 0.9,
      traits: { curiosity: 0.8 }, skills: { research: 0.9 }
    },
    worldFacts: { ...currencyGenesisInfrastructureFacts({ requirement: { status: 'UNRESOLVED' } }), currencyRequirement: 'CURRENCY_GENESIS_REQUIRED', requirementStatus: 'UNRESOLVED',
      currentWorldMinute: 55, currentEconomicEvidence: ['Two unmet research exchanges.'] },
    publicCurrencyHistory: [{ type: 'proposal', agent: 'resident-b', decision: 'support',
      summary: 'A peer supported keeping exchange records.', worldMinute: 50 }],
    currentProposal: { status: 'proposed', proposer: 'resident-b', name: 'Exchange',
      existingSpecification: { name: 'Exchange', purpose: 'Resident authored purpose.' } },
    currentDesignDraft: { specification: { purpose: 'A resident draft purpose.', decimals: 4 },
      incompleteFields: ['name','symbol'] },
    availableRecipients: [{ type: 'agent', id: 'resident-a', name: 'Resident A', address: '0x1111111111111111111111111111111111111111' }]
  };
  let body;
  const result = await authorAgentCurrencyProposal(residentInput, { fetchImpl: async (_url, options) => {
    body = JSON.parse(options.body);
    return { ok: true, text: async () => JSON.stringify({ message: { content: JSON.stringify(SPECIFICATION) } }) };
  } });

  assert.equal(body.model, 'qwen2.5:7b');
  assert.equal(body.messages[0].role, 'system');
  assert.match(body.messages[0].content, /already chosen whether to continue design or submit a proposal/);
  assert.match(body.messages[0].content, /mandatory world requirement/);
  assert.match(body.messages[0].content, /may continue design without submitting a proposal/);
  const context = JSON.parse(body.messages[1].content);
  assert.equal(context.resident.id, 'resident-a');
  assert.equal(context.resident.currentGoal, 'coordinate research exchange');
  assert.equal(context.resident.goals[0].description, 'Share research notes');
  assert.equal(context.resident.recentMemories[0].summary, 'A peer lacked a way to record exchange.');
  const sharedFacts = currencyGenesisInfrastructureFacts({ requirement: { status: 'UNRESOLVED' } });
  for (const key of ['executionNetwork','chainId','tokenCreationTarget','networkRole','mainnetWriteGate',
    'onchainStatus','currencyRequirement','requirementStatus','currencyRequirementMandatory','genesisIssuer',
    'generation','issuerSelectionSource','totalHumanReadableSupply']) {
    const expected = ['genesisIssuer','issuerSelectionSource'].includes(key) && sharedFacts[key] === null
      ? '' : sharedFacts[key];
    assert.equal(context.worldFacts[key], expected);
  }
  assert.equal(context.worldFacts.currentEconomicEvidence[0], 'Two unmet research exchanges.');
  assert.equal(context.publicCurrencyHistory[0].decision, 'support');
  assert.equal(context.currentProposal.existingSpecification.purpose, 'Resident authored purpose.');
  assert.equal(context.currentDesignDraft.specification.purpose, 'A resident draft purpose.');
  assert.equal(context.currentDesignDraft.specification.decimals, 4);
  assert.deepEqual(context.currentDesignDraft.incompleteFields, ['name','symbol']);
  assert.equal(context.availableRecipients[0].id, 'resident-a');
  assert.deepEqual(result, { specification: SPECIFICATION, reason: null, model: 'qwen2.5:7b' });
});

test('unavailable local authoring stays incomplete and does not invent specification fields', async () => {
  const result = await authorAgentCurrencyProposal({ resident: { agentId: 'resident-a', currentGoal: 'trade fairly' } }, {
    fetchImpl: async () => { throw new Error('Ollama unavailable'); }
  });
  assert.deepEqual(result, { specification: null, reason: 'local_authoring_unavailable' });
});

test('missing resident context remains unresolved without calling the local model', async () => {
  let called = false;
  const result = await authorAgentCurrencyProposal({ worldFacts: { currencyRequirement: 'CURRENCY_GENESIS_REQUIRED' } }, {
    fetchImpl: async () => { called = true; throw new Error('must not run'); }
  });
  assert.equal(called, false);
  assert.deepEqual(result, { specification: null, reason: 'resident_context_missing' });
});


test('infrastructure facts follow Arc config and reconciled requirement, not execution preparation', () => {
  const config = arcNetworkConfig({});
  const issuerAssignment = { issuerName: 'Synterra-01', capabilityGeneration: 1,
    selectionSource: 'creator_genesis_assignment' };
  const facts = currencyGenesisInfrastructureFacts({ config, requirement: { status: 'UNRESOLVED' }, issuerAssignment });
  assert.deepEqual(facts, { currencyRequirement: 'CURRENCY_GENESIS_REQUIRED', requirementStatus: 'UNRESOLVED',
    currencyRequirementMandatory: true,
    genesisIssuer: 'Synterra-01', generation: 1, issuerSelectionSource: 'creator_genesis_assignment',
    totalHumanReadableSupply: '1000000000', executionNetwork: 'Arc Mainnet', chainId: 5042,
    tokenCreationTarget: 'Arc Mainnet', networkRole: 'the blockchain execution environment for this pilot',
    mainnetWriteGate: false, onchainStatus: 'not yet created' });
  for (const status of ['UNRESOLVED', 'PROPOSAL_FORMED', 'EXECUTION_READY', 'SATISFIED']) {
    const statusFacts = currencyGenesisInfrastructureFacts({ config, requirement: { status } });
    assert.equal(statusFacts.onchainStatus, 'not yet created');
    assert.equal(statusFacts.currencyRequirementMandatory, status !== 'SATISFIED');
  }
  assert.equal(currencyGenesisInfrastructureFacts({ config, requirement: {
    status: 'SATISFIED', satisfied_token_id: 'reconciled-token-id' } }).onchainStatus, 'created');
  assert.equal(currencyGenesisInfrastructureFacts({ config, requirement: {
    status: 'EXECUTION_READY', satisfied_token_id: 'not-reconciled' } }).onchainStatus, 'not yet created');
});

test('network context preserves undecided fields and makes no call beyond local authoring', async () => {
  const undecided = Object.fromEntries(['name','symbol','meaning','purpose','rationale','decimals',
    'distribution','reserveAmount','unallocatedSupplyHandling','ownershipModel','authorityModel'].map(key => [key, null]));
  const facts = currencyGenesisInfrastructureFacts({ requirement: { status: 'UNRESOLVED' } });
  const calls = [];
  const result = await authorAgentCurrencyProposal({ resident: { agentId: 'resident-a' }, worldFacts: facts }, {
    fetchImpl: async (url, options) => {
      calls.push(url);
      const body = JSON.parse(options.body);
      const context = JSON.parse(body.messages[1].content);
      for (const key of ['executionNetwork','chainId','tokenCreationTarget','networkRole','mainnetWriteGate',
        'onchainStatus','currencyRequirement','requirementStatus','currencyRequirementMandatory','genesisIssuer',
        'generation','issuerSelectionSource','totalHumanReadableSupply']) {
        const expected = ['genesisIssuer','issuerSelectionSource'].includes(key) && facts[key] === null ? '' : facts[key];
        assert.equal(context.worldFacts[key], expected);
      }
      assert.equal(context.currentProposal, null);
      assert.equal(context.currentDesignDraft, null);
      assert.deepEqual(context.availableRecipients, []);
      assert.match(body.messages[0].content, /infrastructure constraints, not token attributes/);
      assert.match(body.messages[0].content, /does not mean a token will never be deployed/);
      assert.match(body.messages[0].content, /may continue design without submitting a proposal/);
      assert.match(body.messages[0].content, /Do not invent a default name/);
      return { ok: true, text: async () => JSON.stringify({ message: { content: JSON.stringify(undecided) } }) };
    }
  });
  assert.deepEqual(result.specification, undecided);
  assert.deepEqual(calls, ['http://127.0.0.1:11434/api/chat']);
});

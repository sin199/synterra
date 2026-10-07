import test from 'node:test';
import assert from 'node:assert/strict';
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
    worldFacts: { currencyRequirement: 'CURRENCY_GENESIS_REQUIRED', requirementStatus: 'UNRESOLVED',
      currentWorldMinute: 55, currentEconomicEvidence: ['Two unmet research exchanges.'] },
    publicCurrencyHistory: [{ type: 'proposal', agent: 'resident-b', decision: 'support',
      summary: 'A peer supported keeping exchange records.', worldMinute: 50 }],
    currentProposal: { status: 'proposed', proposer: 'resident-b', name: 'Exchange',
      existingSpecification: { name: 'Exchange', purpose: 'Resident authored purpose.' } },
    availableRecipients: [{ type: 'agent', id: 'resident-a', name: 'Resident A', address: '0x1111111111111111111111111111111111111111' }]
  };
  let body;
  const result = await authorAgentCurrencyProposal(residentInput, { fetchImpl: async (_url, options) => {
    body = JSON.parse(options.body);
    return { ok: true, text: async () => JSON.stringify({ message: { content: JSON.stringify(SPECIFICATION) } }) };
  } });

  assert.equal(body.model, 'qwen2.5:7b');
  assert.equal(body.messages[0].role, 'system');
  assert.match(body.messages[0].content, /already chosen whether to express/);
  assert.match(body.messages[0].content, /not a command/);
  const context = JSON.parse(body.messages[1].content);
  assert.equal(context.resident.id, 'resident-a');
  assert.equal(context.resident.currentGoal, 'coordinate research exchange');
  assert.equal(context.resident.goals[0].description, 'Share research notes');
  assert.equal(context.resident.recentMemories[0].summary, 'A peer lacked a way to record exchange.');
  assert.equal(context.worldFacts.currentEconomicEvidence[0], 'Two unmet research exchanges.');
  assert.equal(context.publicCurrencyHistory[0].decision, 'support');
  assert.equal(context.currentProposal.existingSpecification.purpose, 'Resident authored purpose.');
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

import { ensureEconomicAccount, ensureResidentEconomicAccounts, getEconomicAccount, postEconomicTransfer } from '../../src/economic-ledger.js';

export async function fundTestResidents(client, { worldId, agentIds, amount = '10000.00000000' }) {
  const total = (BigInt(amount.replace('.', '')) * BigInt(agentIds.length)).toString();
  const formattedTotal = `${total.slice(0, -8) || '0'}.${total.slice(-8).padStart(8, '0')}`;
  const source = await ensureEconomicAccount(client, { worldId, accountType: 'system', key: `test-endowment:${worldId}`,
    asset: 'USDC', initialBalance: formattedTotal });
  for (const agentId of agentIds) {
    await ensureResidentEconomicAccounts(client, { worldId, agentId });
    const destination = await getEconomicAccount(client, { worldId, accountType: 'resident', ownerId: agentId });
    await postEconomicTransfer(client, { worldId, sourceAccountId: source.id, destinationAccountId: destination.id,
      asset: 'USDC', amount, transactionType: 'opening_balance', reason: 'Isolated test economy funding.',
      worldTime: 0, actionId: `test-endowment:${agentId}` });
  }
}

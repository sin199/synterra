import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test('resident paper-trading routes, market scanners, and map UI are absent while legacy tables remain archival', async () => {
  const [server, engine, schema, html, app] = await Promise.all([
    readFile(path.join(root, 'src/server.js'), 'utf8'),
    readFile(path.join(root, 'src/world-engine.js'), 'utf8'),
    readFile(path.join(root, 'schema.sql'), 'utf8'),
    readFile(path.join(root, 'site/index.html'), 'utf8'),
    readFile(path.join(root, 'site/app.js'), 'utf8')
  ]);

  for (const route of [
    '/v1/worlds/:worldId/market',
    '/v1/worlds/:worldId/trading/account',
    '/v1/worlds/:worldId/trading/orders',
    '/v1/worlds/:worldId/trading/hold',
    '/v1/worlds/:worldId/trading/robinhood-orders'
  ]) assert.ok(!server.includes(route), `removed API route must stay unavailable: ${route}`);
  for (const scanner of ['scanRobinhoodMarket', 'readRobinhoodMarket', 'refreshCryptoQuotes', 'simulatedQuotes']) {
    assert.ok(!server.includes(scanner), `server must not start or call ${scanner}`);
  }
  assert.ok(!server.includes('./robinhood-market.js') && !server.includes('./crypto-market.js'));
  assert.ok(!html.includes('crypto-plaza.js') && !app.includes('crypto-plaza.js'));
  assert.ok(!app.includes('/trading/account') && !app.includes('/trading/orders'));
  assert.ok(!engine.includes('crypto_market_quotes') && !engine.includes('crypto_balances'));

  for (const table of ['crypto_balances', 'crypto_orders', 'crypto_trades', 'robinhood_market_state',
    'robinhood_tokens', 'robinhood_market_quotes', 'robinhood_paper_positions', 'robinhood_paper_orders',
    'robinhood_paper_ledger']) {
    assert.match(schema, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`), `${table} remains available as history`);
  }
  assert.doesNotMatch(schema, /INSERT\s+INTO\s+world_economic_accounts[\s\S]{0,200}FROM\s+crypto_balances/i,
    'schema bootstrap must not import paper-trading balances into active resident accounts');
});

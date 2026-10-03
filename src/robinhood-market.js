import { Contract, Interface, JsonRpcProvider, ZeroAddress, getAddress } from 'ethers';
import { simulatedQuotes } from './crypto-market.js';

export const ROBINHOOD_CHAIN_ID = 4663;
export const PONS_V2_FACTORY = getAddress('0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e');
export const NATIVE_QUOTE = ZeroAddress;
export const CURVE_ABI = Object.freeze([
  'function token() view returns (address)',
  'function pairToken() view returns (address)',
  'function getReserves() view returns (uint256 quoteReserve,uint256 tokenReserve)',
  'function feeBps() view returns (uint256)',
  'function creatorTaxBps() view returns (uint256)',
  'function graduated() view returns (bool)',
  'function sellableTokens() view returns (uint256)',
  'function readyToGraduate() view returns (bool)'
]);
const TOKEN_ABI = Object.freeze([
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)'
]);
const FACTORY_ABI = Object.freeze([
  'event TokenLaunched(address indexed token,address indexed curve,address indexed deployer,address pairToken,uint256 launchConfigId,uint256 graduationThreshold)'
]);
const FACTORY_INTERFACE = new Interface(FACTORY_ABI);
const EVENT_TOPIC = FACTORY_INTERFACE.getEvent('TokenLaunched').topicHash;
const RPC_URL = process.env.ROBINHOOD_RPC_URL || 'https://rpc.mainnet.chain.robinhood.com';
const CHUNK_BLOCKS = Math.max(25, Math.min(500, Number(process.env.ROBINHOOD_SCAN_CHUNK_BLOCKS) || 100));
const MAX_CHUNKS_PER_TICK = Math.max(1, Math.min(20, Number(process.env.ROBINHOOD_SCAN_MAX_CHUNKS) || 8));
const LOOKBACK_BLOCKS = Math.max(100, Math.min(100_000, Number(process.env.ROBINHOOD_SCAN_LOOKBACK_BLOCKS) || 5_000));
const MAX_TOKENS = Math.max(10, Math.min(500, Number(process.env.ROBINHOOD_MAX_TRACKED_TOKENS) || 150));
const QUOTES_PER_TICK = Math.max(1, Math.min(50, Number(process.env.ROBINHOOD_QUOTES_PER_TICK) || 20));
const CONFIRMATIONS = 8;
const QUOTE_MAX_AGE_MS = 120_000;
const DBL = 10n ** 18n;
let provider;
let nativeUsdPrice = null;
let nativeUsdAsOf = 0;
let scanning = false;

function getProvider() {
  provider ||= new JsonRpcProvider(RPC_URL, { name: 'robinhood', chainId: ROBINHOOD_CHAIN_ID },
    { staticNetwork: true, batchMaxCount: 1 });
  return provider;
}

function validAddress(value) {
  try { return getAddress(value); } catch { return null; }
}

function cleanText(value, limit) {
  return String(value || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, limit) || null;
}

function decimalFromRatio(numerator, denominator, places = 36) {
  const divisor = BigInt(denominator);
  if (divisor <= 0n) return null;
  const scale = 10n ** BigInt(places);
  const scaled = BigInt(numerator) * scale / divisor;
  const whole = scaled / scale;
  const fraction = String(scaled % scale).padStart(places, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : String(whole);
}

function scaledUsd(value) {
  const raw = String(value ?? '').trim();
  if (!/^\d+(?:\.\d{1,8})?$/.test(raw)) throw new Error('ROBINHOOD_NATIVE_USD_INVALID');
  const [whole, fraction = ''] = raw.split('.');
  return BigInt(whole) * 100_000_000n + BigInt((fraction + '00000000').slice(0, 8));
}

function decimalScaled(value, places = 36) {
  const raw = String(value ?? '').trim();
  if (!/^\d+(?:\.\d+)?$/.test(raw)) throw new Error('DECIMAL_INVALID');
  const [whole, fraction = ''] = raw.split('.');
  if (fraction.length > places) throw new Error('DECIMAL_PRECISION_INVALID');
  return BigInt(whole) * 10n ** BigInt(places) + BigInt((fraction + '0'.repeat(places)).slice(0, places));
}

export function rawTokenAmountToNumber(raw, decimals) {
  return Number(BigInt(raw)) / (10 ** Number(decimals));
}

export function tokenValueUsdcScaled(raw, decimals, priceUsd) {
  const precision = 10n ** 28n;
  return BigInt(raw) * decimalScaled(priceUsd, 36) / (10n ** BigInt(Number(decimals)) * precision);
}

export function formatRawTokenAmount(raw, decimals) {
  const value = BigInt(raw);
  const places = Number(decimals);
  if (!Number.isInteger(places) || places < 0 || places > 36) throw new Error('TOKEN_DECIMALS_INVALID');
  if (places === 0) return String(value);
  const whole = value / (10n ** BigInt(places));
  const fraction = String(value % (10n ** BigInt(places))).padStart(places, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : String(whole);
}

export async function readNativeUsdPrice(now = Date.now()) {
  if (nativeUsdPrice && now - nativeUsdAsOf < 60_000) return nativeUsdPrice;
  const response = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd', {
    headers: { accept: 'application/json' }, signal: AbortSignal.timeout(5_000)
  });
  if (!response.ok) throw new Error(`ROBINHOOD_NATIVE_USD_HTTP_${response.status}`);
  const data = await response.json();
  if (!Number.isFinite(data?.ethereum?.usd) || data.ethereum.usd <= 0) throw new Error('ROBINHOOD_NATIVE_USD_UNAVAILABLE');
  nativeUsdPrice = data.ethereum.usd.toFixed(8);
  nativeUsdAsOf = now;
  return nativeUsdPrice;
}

async function assertRobinhoodChain(rpc) {
  const actual = await rpc.send('eth_chainId', []);
  if (BigInt(actual) !== BigInt(ROBINHOOD_CHAIN_ID)) throw new Error(`ROBINHOOD_CHAIN_MISMATCH:${actual}`);
  const code = await rpc.send('eth_getCode', [PONS_V2_FACTORY, 'latest']);
  if (typeof code !== 'string' || code === '0x') throw new Error('PONS_V2_FACTORY_HAS_NO_CODE');
}

async function getTokenMetadata(rpc, tokenAddress) {
  const token = new Contract(tokenAddress, TOKEN_ABI, rpc);
  const [name, symbol, decimals] = await Promise.all([token.name(), token.symbol(), token.decimals()]);
  const places = Number(decimals);
  if (!Number.isInteger(places) || places < 0 || places > 36) throw new Error('TOKEN_DECIMALS_INVALID');
  return { name: cleanText(name, 80) || tokenAddress.slice(0, 10), symbol: cleanText(symbol, 24) || tokenAddress.slice(0, 10), decimals: places };
}

export async function readPonsV2Curve(rpc, curveAddress, { blockTag = 'latest', nativeUsd = null } = {}) {
  const curveAt = validAddress(curveAddress);
  if (!curveAt) throw new Error('CURVE_ADDRESS_INVALID');
  const curve = new Contract(curveAt, CURVE_ABI, rpc);
  const [tokenRaw, pairTokenRaw, reserves, feeBps, taxBps, graduated, sellableTokens, readyToGraduate] = await Promise.all([
    curve.token({ blockTag }), curve.pairToken({ blockTag }), curve.getReserves({ blockTag }), curve.feeBps({ blockTag }),
    curve.creatorTaxBps({ blockTag }), curve.graduated({ blockTag }), curve.sellableTokens({ blockTag }), curve.readyToGraduate({ blockTag })
  ]);
  const tokenAddress = validAddress(tokenRaw);
  const pairToken = validAddress(pairTokenRaw);
  if (!tokenAddress || !pairToken || pairToken !== NATIVE_QUOTE) {
    return { tokenAddress, curveAddress: curveAt, pairToken, tradeSupported: false, unsupportedReason: 'quote_asset_not_native_eth' };
  }
  const metadata = await getTokenMetadata(rpc, tokenAddress);
  const quoteReserveRaw = BigInt(reserves.quoteReserve ?? reserves[0]);
  const tokenReserveRaw = BigInt(reserves.tokenReserve ?? reserves[1]);
  const nativePerToken = decimalFromRatio(quoteReserveRaw * 10n ** BigInt(metadata.decimals), tokenReserveRaw * DBL);
  const ethUsd = nativeUsd === null ? null : scaledUsd(nativeUsd);
  const priceUsd = nativePerToken && ethUsd !== null
    ? decimalFromRatio(decimalScaled(nativePerToken) * ethUsd, 10n ** 44n)
    : null;
  return {
    tokenAddress, curveAddress: curveAt, pairToken, ...metadata,
    quoteReserveRaw: String(quoteReserveRaw), tokenReserveRaw: String(tokenReserveRaw),
    feeBps: Number(feeBps), taxBps: Number(taxBps), graduated: Boolean(graduated),
    readyToGraduate: Boolean(readyToGraduate), sellableTokensRaw: String(sellableTokens),
    nativePerToken, nativeUsdPrice: nativeUsd, priceUsd,
    tradeSupported: Boolean(priceUsd) && decimalScaled(priceUsd) > 0n && !graduated && !readyToGraduate && quoteReserveRaw > 0n && tokenReserveRaw > 0n
  };
}

async function recordLaunch(client, rpc, log) {
  const parsed = FACTORY_INTERFACE.parseLog(log);
  const tokenAddress = validAddress(parsed.args.token);
  const curveAddress = validAddress(parsed.args.curve);
  const pairToken = validAddress(parsed.args.pairToken);
  if (!tokenAddress || !curveAddress || !pairToken) return;
  let metadata;
  try { metadata = await getTokenMetadata(rpc, tokenAddress); }
  catch { metadata = { name: tokenAddress.slice(0, 10), symbol: tokenAddress.slice(0, 10), decimals: 18 }; }
  await client.query(`INSERT INTO robinhood_tokens(token_address,curve_address,symbol,name,decimals,pair_token_address,
      launch_config_id,launch_block,launch_tx_hash,updated_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,now())
    ON CONFLICT(token_address) DO UPDATE SET curve_address=EXCLUDED.curve_address,
      pair_token_address=EXCLUDED.pair_token_address,launch_block=LEAST(robinhood_tokens.launch_block,EXCLUDED.launch_block),
      launch_tx_hash=COALESCE(robinhood_tokens.launch_tx_hash,EXCLUDED.launch_tx_hash),updated_at=now()`,
  [tokenAddress.toLowerCase(), curveAddress.toLowerCase(), metadata.symbol, metadata.name, metadata.decimals,
    pairToken.toLowerCase(), String(parsed.args.launchConfigId), Number(log.blockNumber), log.transactionHash]);
}

async function refreshTokenQuotes(client, rpc, nativeUsd, blockNumber) {
  const tokens = await client.query(`SELECT token_address,curve_address FROM robinhood_tokens
    ORDER BY last_quote_at NULLS FIRST,launch_block DESC LIMIT $1`, [QUOTES_PER_TICK]);
  const block = await rpc.getBlock(blockNumber);
  const asOf = block?.timestamp ? new Date(Number(block.timestamp) * 1000).toISOString() : new Date().toISOString();
  for (const row of tokens.rows) {
    try {
      const state = await readPonsV2Curve(rpc, row.curve_address, { blockTag: blockNumber, nativeUsd });
      await client.query(`UPDATE robinhood_tokens SET symbol=$2,name=$3,decimals=$4,pair_token_address=$5,
          graduated=$6,unsupported_reason=$7,last_quote_at=$8,updated_at=now() WHERE token_address=$1`,
      [row.token_address, state.symbol || row.token_address.slice(0, 10), state.name || row.token_address.slice(0, 10),
        state.decimals ?? 18, state.pairToken?.toLowerCase() || null, state.graduated ?? false,
        state.unsupportedReason || null, asOf]);
      if (!state.quoteReserveRaw || !state.tokenReserveRaw) continue;
      const version = BigInt(blockNumber);
      await client.query(`INSERT INTO robinhood_market_quotes(token_address,quote_version,block_number,curve_address,
          quote_asset,quote_reserve_raw,token_reserve_raw,sellable_tokens_raw,fee_bps,tax_bps,graduated,
          native_per_token,native_usd_price,price_usd,as_of,source,trade_supported)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
        ON CONFLICT(token_address) DO UPDATE SET quote_version=EXCLUDED.quote_version,block_number=EXCLUDED.block_number,
          curve_address=EXCLUDED.curve_address,quote_asset=EXCLUDED.quote_asset,quote_reserve_raw=EXCLUDED.quote_reserve_raw,
          token_reserve_raw=EXCLUDED.token_reserve_raw,sellable_tokens_raw=EXCLUDED.sellable_tokens_raw,
          fee_bps=EXCLUDED.fee_bps,tax_bps=EXCLUDED.tax_bps,graduated=EXCLUDED.graduated,
          native_per_token=EXCLUDED.native_per_token,native_usd_price=EXCLUDED.native_usd_price,
          price_usd=EXCLUDED.price_usd,as_of=EXCLUDED.as_of,source=EXCLUDED.source,trade_supported=EXCLUDED.trade_supported`,
      [row.token_address, String(version), Number(blockNumber), row.curve_address, state.pairToken,
        state.quoteReserveRaw, state.tokenReserveRaw, state.sellableTokensRaw, state.feeBps, state.taxBps, state.graduated,
        state.nativePerToken, state.nativeUsdPrice, state.priceUsd, asOf,
        'robinhood_pons_v2_curve+coingecko_eth_usd', state.tradeSupported]);
    } catch (error) {
      await client.query('UPDATE robinhood_tokens SET last_error=$2,updated_at=now() WHERE token_address=$1',
        [row.token_address, String(error?.message || error).replace(/[\r\n\t]/g, ' ').slice(0, 180)]);
    }
  }
}

export async function scanRobinhoodMarket(pool) {
  if (scanning) return { ok: false, skipped: 'scan_already_running' };
  scanning = true;
  const rpc = getProvider();
  const client = await pool.connect();
  try {
    await assertRobinhoodChain(rpc);
    const head = await rpc.getBlockNumber();
    const target = Math.max(0, head - CONFIRMATIONS);
    const initialCursor = Math.max(0, head - LOOKBACK_BLOCKS);
    const initialized = await client.query(`INSERT INTO robinhood_market_state(id,chain_id,scanned_to_block,status)
      VALUES(1,$1,GREATEST(0,$2::bigint-$3::bigint),'ready')
      ON CONFLICT(id) DO UPDATE SET scanned_to_block=CASE
        WHEN robinhood_market_state.last_success_at IS NULL AND robinhood_market_state.scanned_to_block=0
          THEN GREATEST(0,$2::bigint-$3::bigint)
        ELSE robinhood_market_state.scanned_to_block END,
        status=CASE WHEN robinhood_market_state.last_success_at IS NULL AND robinhood_market_state.scanned_to_block=0
          THEN 'ready' ELSE robinhood_market_state.status END,
        updated_at=now()
      RETURNING scanned_to_block`, [ROBINHOOD_CHAIN_ID, head, LOOKBACK_BLOCKS]);
    let cursorRow = initialized.rows[0] || (await client.query('SELECT scanned_to_block FROM robinhood_market_state WHERE id=1')).rows[0];
    let cursor = Number(cursorRow.scanned_to_block);
    let chunks = 0;
    while (cursor < target && chunks < MAX_CHUNKS_PER_TICK) {
      const end = Math.min(target, cursor + CHUNK_BLOCKS);
      const logs = await rpc.getLogs({ address: PONS_V2_FACTORY, topics: [EVENT_TOPIC], fromBlock: cursor + 1, toBlock: end });
      await client.query('BEGIN');
      try {
        for (const log of logs) await recordLaunch(client, rpc, log);
        await client.query(`UPDATE robinhood_market_state SET scanned_to_block=$1,last_head_block=$2,
          last_success_at=now(),status='ready',last_error=NULL,updated_at=now() WHERE id=1`, [end, head]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
      cursor = end;
      chunks += 1;
    }
    const [tokenCount, limit] = await Promise.all([
      client.query('SELECT count(*)::int AS count FROM robinhood_tokens'),
      client.query('SELECT token_address FROM robinhood_tokens ORDER BY launch_block DESC LIMIT $1', [MAX_TOKENS])
    ]);
    if (tokenCount.rows[0].count > MAX_TOKENS) {
      const retained = limit.rows.map((row) => row.token_address);
      await client.query(`DELETE FROM robinhood_tokens t WHERE NOT (t.token_address = ANY($1::text[]))
        AND NOT EXISTS (SELECT 1 FROM robinhood_paper_positions p WHERE p.token_address=t.token_address)`, [retained]);
    }
    let nativeUsd = null;
    try { nativeUsd = await readNativeUsdPrice(); }
    catch (error) { console.warn(JSON.stringify({ robinhoodNativeUsdUnavailable: String(error?.message || error).slice(0, 120) })); }
    await refreshTokenQuotes(client, rpc, nativeUsd, target);
    await client.query(`UPDATE robinhood_market_state SET last_head_block=$1,last_success_at=now(),
      status=$2,last_error=$3,updated_at=now() WHERE id=1`, [head,
      cursor < target ? 'catching_up' : nativeUsd ? 'ready' : 'quote_unavailable', nativeUsd ? null : 'native_usd_unavailable']);
    return { ok: Boolean(nativeUsd), chainId: ROBINHOOD_CHAIN_ID, headBlock: head, scannedToBlock: cursor, tokenCount: tokenCount.rows[0].count };
  } catch (error) {
    await client.query(`INSERT INTO robinhood_market_state(id,chain_id,scanned_to_block,status,last_error,updated_at)
      VALUES(1,$1,0,'error',$2,now()) ON CONFLICT(id) DO UPDATE SET status='error',last_error=EXCLUDED.last_error,updated_at=now()`,
    [ROBINHOOD_CHAIN_ID, String(error?.message || error).replace(/[\r\n\t]/g, ' ').slice(0, 180)]);
    throw error;
  } finally {
    client.release();
    scanning = false;
  }
}

export async function readRobinhoodMarket(client, { now = Date.now(), limit = 30 } = {}) {
  const [state, tokens] = await Promise.all([
    client.query(`SELECT chain_id AS "chainId",scanned_to_block AS "scannedToBlock",last_head_block AS "lastHeadBlock",
      last_success_at AS "lastSuccessAt",status,last_error AS "lastError" FROM robinhood_market_state WHERE id=1`),
    client.query(`SELECT t.token_address AS "tokenAddress",t.curve_address AS "curveAddress",t.symbol,t.name,
        t.decimals,t.graduated,q.quote_version AS "quoteVersion",q.block_number AS "blockNumber",
        q.quote_reserve_raw AS "quoteReserveRaw",q.token_reserve_raw AS "tokenReserveRaw",
        q.sellable_tokens_raw AS "sellableTokensRaw",q.fee_bps AS "feeBps",q.tax_bps AS "taxBps",
        q.native_per_token AS "nativePerToken",q.native_usd_price AS "nativeUsdPrice",
        q.price_usd AS "priceUsd",q.as_of AS "asOf",q.source,q.trade_supported AS "tradeSupported",
        CASE WHEN q.as_of > now() - interval '2 minutes' THEN true ELSE false END AS fresh
      FROM robinhood_tokens t LEFT JOIN robinhood_market_quotes q USING(token_address)
      ORDER BY q.as_of DESC NULLS LAST,t.launch_block DESC LIMIT $1`, [Math.max(1, Math.min(100, limit))])
  ]);
  const snapshot = state.rows[0] || { chainId: ROBINHOOD_CHAIN_ID, scannedToBlock: null, lastHeadBlock: null, status: 'starting' };
  const freshState = snapshot.lastSuccessAt && now - new Date(snapshot.lastSuccessAt).getTime() <= QUOTE_MAX_AGE_MS;
  return {
    chainId: ROBINHOOD_CHAIN_ID,
    dex: 'Pons V2',
    scanner: { ...snapshot, healthy: snapshot.status === 'ready' || snapshot.status === 'catching_up', fresh: Boolean(freshState) },
    tokens: tokens.rows.map((row) => ({
      ...row,
      quoteVersion: row.quoteVersion === null ? null : Number(row.quoteVersion),
      blockNumber: row.blockNumber === null ? null : Number(row.blockNumber),
      tradable: Boolean(row.tradeSupported && row.fresh && freshState && !row.graduated)
    }))
  };
}

export async function getCurrentCurveQuote(tokenAddress, { expectedQuoteVersion, now = Date.now() } = {}) {
  const rpc = getProvider();
  await assertRobinhoodChain(rpc);
  const head = await rpc.getBlockNumber();
  const blockNumber = Math.max(0, head - CONFIRMATIONS);
  const nativeUsd = await readNativeUsdPrice(now);
  return { ...(await readPonsV2Curve(rpc, (await tokenAddress), { blockTag: blockNumber, nativeUsd })),
    blockNumber, quoteVersion: blockNumber, nativeUsdAsOf: new Date(nativeUsdAsOf).toISOString(),
    expectedQuoteVersion: expectedQuoteVersion ?? null, source: 'robinhood_pons_v2_curve+coingecko_eth_usd' };
}

export function quotePonsV2Buy({ quoteInputRaw, quoteReserveRaw, tokenReserveRaw, sellableTokensRaw, feeBps, taxBps }) {
  const input = BigInt(quoteInputRaw);
  const quoteReserve = BigInt(quoteReserveRaw);
  const tokenReserve = BigInt(tokenReserveRaw);
  const sellable = BigInt(sellableTokensRaw);
  const fee = Number(feeBps);
  const tax = Number(taxBps);
  if (input <= 0n || quoteReserve <= 0n || tokenReserve <= 0n || !Number.isInteger(fee) || !Number.isInteger(tax) ||
      fee < 0 || tax < 0 || fee + tax >= 10_000) throw new Error('PONS_V2_QUOTE_INVALID');
  let spent = input;
  let feeRaw = spent * BigInt(fee) / 10_000n;
  let taxRaw = spent * BigInt(tax) / 10_000n;
  let net = spent - feeRaw - taxRaw;
  let amountOut = net * tokenReserve / (quoteReserve + net);
  if (amountOut <= 0n || sellable <= 0n) throw new Error('PONS_V2_CURVE_UNTRADEABLE');
  if (amountOut > sellable) {
    amountOut = sellable;
    const netRequired = amountOut * quoteReserve / (tokenReserve - amountOut) + 1n;
    const grossRequired = (netRequired * 10_000n + BigInt(10_000 - fee - tax) - 1n) / BigInt(10_000 - fee - tax);
    spent = grossRequired < input ? grossRequired : input;
    feeRaw = spent * BigInt(fee) / 10_000n;
    taxRaw = spent * BigInt(tax) / 10_000n;
  }
  if (spent <= 0n) throw new Error('PONS_V2_QUOTE_INVALID');
  return { quoteSpentRaw: String(spent), quoteRefundRaw: String(input - spent), feeRaw: String(feeRaw),
    taxRaw: String(taxRaw), tokenAmountRaw: String(amountOut) };
}

export function quotePonsV2Sell({ tokenInputRaw, quoteReserveRaw, tokenReserveRaw, feeBps, taxBps }) {
  const input = BigInt(tokenInputRaw);
  const quoteReserve = BigInt(quoteReserveRaw);
  const tokenReserve = BigInt(tokenReserveRaw);
  const fee = Number(feeBps);
  const tax = Number(taxBps);
  if (input <= 0n || quoteReserve <= 0n || tokenReserve <= 0n || !Number.isInteger(fee) || !Number.isInteger(tax) ||
      fee < 0 || tax < 0 || fee + tax >= 10_000) throw new Error('PONS_V2_QUOTE_INVALID');
  const gross = input * quoteReserve / (tokenReserve + input);
  const feeRaw = gross * BigInt(fee) / 10_000n;
  const taxRaw = gross * BigInt(tax) / 10_000n;
  const net = gross - feeRaw - taxRaw;
  if (net <= 0n) throw new Error('PONS_V2_QUOTE_TOO_SMALL');
  return { tokenAmountRaw: String(input), quoteGrossRaw: String(gross), quoteReceivedRaw: String(net),
    feeRaw: String(feeRaw), taxRaw: String(taxRaw) };
}

export function usdcToNativeRaw(usdc, nativeUsd) {
  const dollars = scaledUsd(usdc);
  const price = scaledUsd(nativeUsd);
  if (price <= 0n) throw new Error('ROBINHOOD_NATIVE_USD_INVALID');
  return dollars * DBL / price;
}

export function nativeRawToUsdc(nativeRaw, nativeUsd) {
  return BigInt(nativeRaw) * scaledUsd(nativeUsd) / DBL;
}

export function nativeUsdPriceFromSimulatedQuote() {
  return simulatedQuotes().find((quote) => quote.symbol === 'ETH')?.priceUsd || null;
}

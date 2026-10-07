// Synterra plaza "coin bar" (코인 BAR): a Korean crypto-pub trading scene around the central Exchange.
// - a rotating LED halo (giant video wall) over the dome with BTC / ETH K-line charts, a recent-fills
//   feed and a brand / mood panel, two free-standing double-sided K-line pylons, a scrolling ticker
//   tape on the cornice and a quote board over the door, all drawn on CanvasTextures that are only
//   redrawn when the market data changes (plus a short tween / flash afterwards);
// - an island bar (counter ring, glowing back-bar bottles, stools) and high tables where plaza
//   residents sit or stand; neon signs, neon tubes and additive glow sprites (fake bloom);
// - crowd reactions (cheer / slump), confetti and a TO THE MOON / LIQUIDATED flash, driven only by
//   real ticks of the (simulated) market feed and by residents' own fills. No data -> MARKET LOADING.
// Colours follow the Korean (Upbit) convention: up / buy = red, down / sell = blue.

const UP = '#ff3b5c', DOWN = '#2f8bff', FLAT = '#c8cbe0';
const NEON = { pink: '#ff3fb4', cyan: '#2ef2ff', purple: '#a35bff', yellow: '#ffe14d', red: '#ff4466' };
const SYMBOLS = ['BTC', 'ETH'];
const PANEL_W = 512, SCREEN_H = 360;
const TAU = Math.PI * 2;
const FONT = '"Noto Sans KR","Noto Sans CJK KR","Apple SD Gothic Neo","Malgun Gothic","Noto Sans CJK SC","Segoe UI",system-ui,sans-serif';
const MONO = '"JetBrains Mono","SFMono-Regular",Menlo,Consolas,"DejaVu Sans Mono",monospace';

export const BAR = Object.freeze({ counterIn: 2.0, counterOut: 2.3, counterTop: 0.62, stoolR: 2.6, stoolTop: 0.66,
  tableR: 3.08, gapCenter: Math.PI / 2, gapHalf: 0.42, haloR: 2.3, haloY: 4.3, haloH: 1.3 });

const clamp = (value, min = 0, max = 1) => Math.max(min, Math.min(max, value));
const num = (value) => { if (value === null || value === undefined || value === '') return null; const n = Number(value); return Number.isFinite(n) ? n : null; };
const sideColor = (change) => change === null || Math.abs(change) < 1e-9 ? FLAT : change > 0 ? UP : DOWN;
const arrow = (change) => change === null || Math.abs(change) < 1e-9 ? '−' : change > 0 ? '▲' : '▼';
export function formatPrice(value) {
  const n = num(value); if (n === null) return '—';
  const digits = n >= 1000 ? 2 : n >= 1 ? 2 : 6;
  return n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}
const formatPct = (value) => value === null ? '—' : `${arrow(value)} ${Math.abs(value).toFixed(2)}%`;
const angleIn = (angle, center, half) => Math.abs(((angle - center + Math.PI * 3) % TAU) - Math.PI) < half;

// --- market normalisation ----------------------------------------------------------------------------
export function normalizeMarket(data) {
  const market = data?.world?.market;
  const quotes = new Map((data?.trading?.quotes || []).map((quote) => [quote.symbol, num(quote.priceUsd)]));
  const symbols = {};
  let charted = 0;
  for (const symbol of SYMBOLS) {
    const raw = market?.symbols?.[symbol];
    const candles = Array.isArray(raw?.candles) ? raw.candles.map((c) => ({ t: c.t, o: num(c.o), h: num(c.h), l: num(c.l), c: num(c.c),
      v: num(c.v) || 0, n: num(c.n) || 0, buyUsd: num(c.buyUsd) || 0, sellUsd: num(c.sellUsd) || 0 }))
      .filter((c) => c.o !== null && c.h !== null && c.l !== null && c.c !== null) : [];
    if (candles.length) charted += 1;
    const price = num(raw?.priceUsd) ?? candles.at(-1)?.c ?? quotes.get(symbol) ?? null;
    symbols[symbol] = { symbol, interval: raw?.interval || null, candles, price, change24h: num(raw?.change24hPct),
      high24h: num(raw?.high24hUsd), low24h: num(raw?.low24hUsd) };
  }
  const trades = (Array.isArray(market?.recentTrades) ? market.recentTrades : (data?.trading?.recentTrades || [])
    .filter((trade) => SYMBOLS.includes(trade.asset)).map((trade) => ({ side: trade.side, asset: trade.asset, size: trade.quantity,
      priceUsd: trade.priceUsd, notionalUsd: trade.notionalUsd, resident: trade.agentName, residentId: trade.agentId, createdAt: trade.createdAt })))
    .slice(0, 20);
  const priced = SYMBOLS.some((symbol) => symbols[symbol].price !== null);
  return { charted: charted > 0, priced, symbols, trades, asOf: market?.asOf || null, simulated: market ? market.simulated !== false : true };
}

// Classify one refresh against the previous one. Ticks are compared with the asset's own typical
// per-minute move in the candle window, so a "pump" means unusually fast for this market.
export function detectReaction(previous, next) {
  if (!previous?.priced || !next?.priced) return null;
  let best = null;
  for (const symbol of SYMBOLS) {
    const before = previous.symbols[symbol]?.price, after = next.symbols[symbol]?.price;
    if (!before || !after || before === after) continue;
    const candles = next.symbols[symbol].candles;
    const bodies = candles.map((c) => Math.abs(c.c - c.o) / (c.o || 1)).filter((x) => x > 0);
    const bucket = Number.parseInt(next.symbols[symbol].interval, 10) || 15;
    const typical = bodies.length ? bodies.reduce((a, b) => a + b, 0) / bodies.length / Math.sqrt(bucket) : 0.0005;
    const move = (after - before) / before;
    const ratio = Math.abs(move) / Math.max(typical, 1e-7);
    if (!best || ratio > best.ratio) best = { symbol, move, ratio };
  }
  const seen = new Set((previous.trades || []).map((t) => `${t.residentId || t.resident}|${t.createdAt}|${t.side}`));
  const fresh = (next.trades || []).filter((t) => !seen.has(`${t.residentId || t.resident}|${t.createdAt}|${t.side}`));
  const notionals = (previous.trades || []).map((t) => num(t.notionalUsd) || 0).sort((a, b) => a - b);
  const median = notionals.length ? notionals[Math.floor(notionals.length / 2)] : 0;
  const whale = fresh.find((t) => (num(t.notionalUsd) || 0) >= Math.max(2_000, median * 5));
  if (best && best.ratio >= 0.6) {
    const big = best.ratio >= 2.4;
    return { kind: best.move > 0 ? 'pump' : 'dump', strength: clamp(best.ratio / 3, 0.25, 1), big, symbol: best.symbol, move: best.move };
  }
  if (whale) return { kind: whale.side === 'sell' ? 'dump' : 'pump', strength: 0.7, big: false, symbol: whale.asset, whale: true };
  if (fresh.length) {
    const buys = fresh.filter((t) => t.side !== 'sell').length;
    return { kind: buys >= fresh.length - buys ? 'pump' : 'dump', strength: 0.3, big: false, symbol: fresh[0].asset };
  }
  return null;
}

// --- canvas helpers ----------------------------------------------------------------------------------
function makeCanvas(width, height) { const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height; return canvas; }
function neonText(ctx, text, x, y, color, size, { align = 'center', weight = 900, blur = 22, font = FONT, core = '#ffffff' } = {}) {
  ctx.save();
  ctx.font = `${weight} ${size}px ${font}`; ctx.textAlign = align; ctx.textBaseline = 'middle';
  ctx.shadowColor = color; ctx.shadowBlur = blur; ctx.lineJoin = 'round';
  ctx.strokeStyle = color; ctx.lineWidth = Math.max(2, size * 0.12); ctx.strokeText(text, x, y);
  ctx.shadowBlur = blur * 0.5; ctx.strokeText(text, x, y);
  ctx.shadowBlur = 0; ctx.fillStyle = core; ctx.globalAlpha = 0.92; ctx.fillText(text, x, y);
  ctx.restore();
}
function text(ctx, value, x, y, color, size, { align = 'left', weight = 700, font = MONO, baseline = 'alphabetic' } = {}) {
  ctx.font = `${weight} ${size}px ${font}`; ctx.textAlign = align; ctx.textBaseline = baseline; ctx.fillStyle = color; ctx.fillText(value, x, y);
}
function roundRect(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.roundRect ? ctx.roundRect(x, y, w, h, r) : ctx.rect(x, y, w, h); }
function panelBackground(ctx, x, w, h, top = '#0b1024', bottom = '#05060f') {
  const g = ctx.createLinearGradient(0, 0, 0, h); g.addColorStop(0, top); g.addColorStop(1, bottom);
  ctx.fillStyle = g; ctx.fillRect(x, 0, w, h);
  ctx.strokeStyle = 'rgba(46,242,255,0.35)'; ctx.lineWidth = 3; ctx.strokeRect(x + 3, 3, w - 6, h - 6);
}
function movingAverage(values, period) {
  return values.map((_, i) => { if (i < period - 1) return null; let s = 0; for (let k = i - period + 1; k <= i; k += 1) s += values[k]; return s / period; });
}
function loadingPanel(ctx, x, label, t) {
  panelBackground(ctx, x, PANEL_W, SCREEN_H);
  text(ctx, label, x + 24, 48, '#7f88b8', 26, { weight: 800 });
  neonText(ctx, 'MARKET LOADING', x + PANEL_W / 2, SCREEN_H / 2 - 6, NEON.cyan, 40);
  const dots = '•'.repeat(1 + (Math.floor(t * 2) % 3));
  text(ctx, dots, x + PANEL_W / 2, SCREEN_H / 2 + 52, '#7f88b8', 30, { align: 'center' });
}

// one K-line (candlestick) chart panel, Upbit style
function drawChartPanel(ctx, x, info, tween, t) {
  if (!info || !info.candles.length) { loadingPanel(ctx, x, info ? `${info.symbol}/USD` : '', t); if (info?.price) text(ctx, `$${formatPrice(info.price)}`, x + PANEL_W - 24, 48, '#e9ecff', 30, { align: 'right', weight: 800 }); return; }
  panelBackground(ctx, x, PANEL_W, SCREEN_H);
  const candles = info.candles.map((c) => ({ ...c }));
  const last = candles.at(-1);
  if (tween && tween.k < 1 && tween.from !== null) {
    const shown = tween.from + (last.c - tween.from) * tween.k;
    last.c = shown; last.h = Math.max(last.h, shown, last.o); last.l = Math.min(last.l, shown, last.o);
  }
  const price = last.c, change = info.change24h, color = sideColor(change);
  // header
  text(ctx, `${info.symbol}`, x + 22, 46, '#ffffff', 36, { weight: 900, font: FONT });
  text(ctx, '/USD', x + 22 + ctx.measureText(info.symbol).width + 4, 46, '#8c93c4', 20, { weight: 700 });
  roundRect(ctx, x + 22, 58, 118, 26, 6); ctx.fillStyle = 'rgba(163,91,255,0.25)'; ctx.fill();
  text(ctx, `${info.interval || '—'} · ${candles.length}봉`, x + 30, 77, '#d8c2ff', 16, { weight: 700, font: FONT });
  text(ctx, formatPrice(price), x + PANEL_W - 22, 46, color, 38, { align: 'right', weight: 800 });
  text(ctx, `${formatPct(change)} 24H`, x + PANEL_W - 22, 78, color, 20, { align: 'right', weight: 700 });
  // plot area
  const left = x + 18, right = x + PANEL_W - 86, top = 98, bottom = SCREEN_H - 70, volTop = SCREEN_H - 62, volBottom = SCREEN_H - 16;
  let hi = -Infinity, lo = Infinity, vmax = 0;
  for (const c of candles) { hi = Math.max(hi, c.h); lo = Math.min(lo, c.l); vmax = Math.max(vmax, c.v); }
  const minSpan = price * 0.0004;
  if (hi - lo < minSpan) { const mid = (hi + lo) / 2; hi = mid + minSpan / 2; lo = mid - minSpan / 2; }
  const pad = (hi - lo) * 0.08; hi += pad; lo -= pad;
  const y = (value) => bottom - ((value - lo) / (hi - lo)) * (bottom - top);
  ctx.strokeStyle = 'rgba(120,130,200,0.14)'; ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i += 1) {
    const gy = top + ((bottom - top) / 4) * i;
    ctx.beginPath(); ctx.moveTo(left, gy); ctx.lineTo(right, gy); ctx.stroke();
    text(ctx, formatPrice(hi - ((hi - lo) / 4) * i), right + 8, gy + 5, '#7c84b4', 13, { weight: 600 });
  }
  const step = (right - left) / candles.length, body = Math.max(2, step * 0.64);
  candles.forEach((c, i) => {
    const cx = left + step * (i + 0.5);
    const col = c.c > c.o ? UP : c.c < c.o ? DOWN : FLAT;
    ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineWidth = Math.max(1, step * 0.12);
    ctx.beginPath(); ctx.moveTo(cx, y(c.h)); ctx.lineTo(cx, y(c.l)); ctx.stroke();
    const y0 = y(Math.max(c.o, c.c)), y1 = y(Math.min(c.o, c.c));
    ctx.fillRect(cx - body / 2, y0, body, Math.max(2, y1 - y0));
    if (vmax > 0 && c.v > 0) {
      ctx.globalAlpha = 0.75; ctx.fillStyle = c.buyUsd >= c.sellUsd ? UP : DOWN;
      const vh = (c.v / vmax) * (volBottom - volTop); ctx.fillRect(cx - body / 2, volBottom - vh, body, vh); ctx.globalAlpha = 1;
    }
  });
  if (vmax <= 0) text(ctx, '체결 없음 · NO FILLS IN WINDOW', left + 4, volBottom - 14, '#545b86', 14, { weight: 600, font: FONT });
  else text(ctx, 'VOL', left + 4, volTop + 14, '#7c84b4', 12);
  // moving averages
  const closes = candles.map((c) => c.c);
  for (const [period, col] of [[7, '#ffd84d'], [25, '#c58cff']]) {
    const ma = movingAverage(closes, period);
    ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.beginPath(); let started = false;
    ma.forEach((value, i) => { if (value === null) return; const px = left + step * (i + 0.5); if (started) ctx.lineTo(px, y(value)); else { ctx.moveTo(px, y(value)); started = true; } });
    ctx.stroke();
  }
  text(ctx, 'MA7', left + 4, top + 14, '#ffd84d', 12); text(ctx, 'MA25', left + 44, top + 14, '#c58cff', 12);
  // last price line + tag
  const py = y(price);
  ctx.setLineDash([6, 5]); ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(left, py); ctx.lineTo(right, py); ctx.stroke(); ctx.setLineDash([]);
  ctx.fillStyle = color; roundRect(ctx, right + 2, py - 12, 82, 24, 4); ctx.fill();
  text(ctx, formatPrice(price), right + 43, py + 5, '#08080f', 13, { align: 'center', weight: 800 });
  // glowing head on the live candle
  const hx = left + step * (candles.length - 0.5);
  ctx.save(); ctx.shadowColor = color; ctx.shadowBlur = 18; ctx.fillStyle = '#ffffff';
  ctx.beginPath(); ctx.arc(hx, py, 4 + Math.sin(t * 6) * 1.2, 0, TAU); ctx.fill(); ctx.restore();
}

function drawTradesPanel(ctx, x, market, t) {
  panelBackground(ctx, x, PANEL_W, SCREEN_H, '#120a24', '#06040f');
  text(ctx, '실시간 체결', x + 22, 44, '#ffffff', 30, { weight: 900, font: FONT });
  text(ctx, 'RECENT FILLS', x + 196, 44, NEON.cyan, 18, { weight: 800 });
  if (!market?.priced && !market?.trades?.length) { neonText(ctx, 'MARKET LOADING', x + PANEL_W / 2, SCREEN_H / 2, NEON.cyan, 38); return; }
  const trades = market.trades.slice(0, 7);
  if (!trades.length) {
    neonText(ctx, '체결 대기 중', x + PANEL_W / 2, 160, NEON.purple, 40);
    text(ctx, 'NO FILLS YET', x + PANEL_W / 2, 206, '#8c93c4', 20, { align: 'center' });
  }
  trades.forEach((trade, i) => {
    const rowY = 84 + i * 33, buy = trade.side !== 'sell', col = buy ? UP : DOWN;
    if (i % 2 === 0) { ctx.fillStyle = 'rgba(255,255,255,0.035)'; ctx.fillRect(x + 12, rowY - 4, PANEL_W - 24, 31); }
    const when = Date.parse(trade.createdAt);
    const clock = Number.isFinite(when) ? new Date(when).toTimeString().slice(0, 5) : '--:--';
    text(ctx, clock, x + 22, rowY + 19, '#7c84b4', 15);
    const who = String(trade.resident || '?').replace(/^agent-/, '').slice(0, 9);
    text(ctx, who, x + 82, rowY + 19, '#e7e9ff', 16, { weight: 700, font: FONT });
    roundRect(ctx, x + 178, rowY + 1, 74, 24, 5); ctx.fillStyle = col; ctx.globalAlpha = 0.22; ctx.fill(); ctx.globalAlpha = 1;
    text(ctx, buy ? '매수 BUY' : '매도 SELL', x + 215, rowY + 19, col, 13, { align: 'center', weight: 800, font: FONT });
    const size = num(trade.size);
    text(ctx, `${size === null ? '?' : size.toFixed(size >= 1 ? 3 : 4)} ${trade.asset}`, x + 262, rowY + 19, '#e7e9ff', 15);
    text(ctx, `@${formatPrice(trade.priceUsd)}`, x + PANEL_W - 22, rowY + 19, col, 15, { align: 'right' });
  });
  // buy / sell pressure from the candle window (real fills only)
  let buyUsd = 0, sellUsd = 0;
  for (const symbol of SYMBOLS) for (const c of market.symbols[symbol]?.candles || []) { buyUsd += c.buyUsd; sellUsd += c.sellUsd; }
  const total = buyUsd + sellUsd, barY = SCREEN_H - 46;
  if (total > 0) {
    const share = buyUsd / total, w = PANEL_W - 44;
    ctx.fillStyle = UP; ctx.fillRect(x + 22, barY, w * share, 18);
    ctx.fillStyle = DOWN; ctx.fillRect(x + 22 + w * share, barY, w * (1 - share), 18);
    text(ctx, `매수 ${(share * 100).toFixed(0)}%`, x + 22, barY - 8, UP, 15, { weight: 800, font: FONT });
    text(ctx, `매도 ${((1 - share) * 100).toFixed(0)}%`, x + PANEL_W - 22, barY - 8, DOWN, 15, { align: 'right', weight: 800, font: FONT });
  } else text(ctx, 'BUY / SELL PRESSURE · NO VOLUME', x + 22, barY + 14, '#545b86', 14);
}

function drawBrandPanel(ctx, x, market, flash, t) {
  const g = ctx.createLinearGradient(x, 0, x + PANEL_W, SCREEN_H);
  g.addColorStop(0, '#1d0630'); g.addColorStop(1, '#050217');
  ctx.fillStyle = g; ctx.fillRect(x, 0, PANEL_W, SCREEN_H);
  ctx.strokeStyle = 'rgba(255,63,180,0.5)'; ctx.lineWidth = 3; ctx.strokeRect(x + 3, 3, PANEL_W - 6, SCREEN_H - 6);
  if (flash) {
    const on = Math.floor(t * 6) % 2 === 0, col = flash.kind === 'dump' ? DOWN : UP;
    ctx.fillStyle = on ? col : '#05020f'; ctx.globalAlpha = on ? 0.55 : 1; ctx.fillRect(x, 0, PANEL_W, SCREEN_H); ctx.globalAlpha = 1;
    neonText(ctx, flash.kind === 'dump' ? 'LIQUIDATED' : 'TO THE MOON', x + PANEL_W / 2, 130, on ? '#ffffff' : col, 62);
    neonText(ctx, flash.kind === 'dump' ? '떡락 · 청산' : '떡상 가즈아!', x + PANEL_W / 2, 220, col, 54);
    const info = market?.symbols?.[flash.symbol];
    if (info?.price) text(ctx, `${flash.symbol} ${formatPrice(info.price)}`, x + PANEL_W / 2, 300, '#ffffff', 30, { align: 'center', weight: 800 });
    return;
  }
  neonText(ctx, '코인 BAR', x + PANEL_W / 2, 74, NEON.pink, 74);
  text(ctx, 'SYNTERRA COIN PUB · 24/7', x + PANEL_W / 2, 134, NEON.cyan, 18, { align: 'center', weight: 800 });
  if (!market?.priced) { neonText(ctx, 'MARKET LOADING', x + PANEL_W / 2, 220, NEON.cyan, 36); return; }
  SYMBOLS.forEach((symbol, i) => {
    const info = market.symbols[symbol], col = sideColor(info.change24h), rowY = 184 + i * 50;
    text(ctx, symbol, x + 40, rowY, '#ffffff', 30, { weight: 900, font: FONT });
    text(ctx, formatPrice(info.price), x + 300, rowY, col, 30, { align: 'right', weight: 800 });
    text(ctx, formatPct(info.change24h), x + PANEL_W - 36, rowY, col, 24, { align: 'right', weight: 800 });
  });
  const change = market.symbols.BTC.change24h;
  const mood = change === null ? ['', NEON.purple] : change > 0.05 ? ['떡상 중 · TO THE MOON', UP] : change < -0.05 ? ['떡락 · HODL', DOWN] : ['횡보 · SIDEWAYS', NEON.purple];
  if (mood[0]) neonText(ctx, mood[0], x + PANEL_W / 2, 296, mood[1], 32, { blur: 16 });
  text(ctx, market.simulated ? 'SIMULATED MARKET · NOT REAL FUNDS' : '', x + PANEL_W / 2, SCREEN_H - 16, '#7a6c9a', 13, { align: 'center' });
}

// -----------------------------------------------------------------------------------------------------
export function createCryptoPlaza(THREE, { lampAngles = [], lampRadius = 3.85 } = {}) {
  const group = new THREE.Group(); group.name = 'crypto-plaza';
  const disposables = [];
  const keep = (thing) => { disposables.push(thing); return thing; };
  const tex = (canvas, srgb = true) => { const texture = keep(new THREE.CanvasTexture(canvas)); if (srgb) texture.colorSpace = THREE.SRGBColorSpace; texture.anisotropy = 4; return texture; };
  // textures
  const screenCanvas = makeCanvas(PANEL_W * 4, SCREEN_H), screenTex = tex(screenCanvas);
  screenTex.wrapS = THREE.RepeatWrapping; screenTex.repeat.set(2, 1);
  const tickerCanvas = makeCanvas(2048, 64), tickerTex = tex(tickerCanvas);
  tickerTex.wrapS = THREE.RepeatWrapping; tickerTex.repeat.set(3, 1);
  const boardCanvas = makeCanvas(512, 188), boardTex = tex(boardCanvas);
  const signCanvas = makeCanvas(1024, 512), signTex = tex(signCanvas);
  const flashCanvas = makeCanvas(1024, 256), flashTex = tex(flashCanvas);
  const roofCanvas = makeCanvas(512, 512), roofTex = tex(roofCanvas);
  const glowCanvas = makeCanvas(64, 64); {
    const c = glowCanvas.getContext('2d'), g = c.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.3, 'rgba(255,255,255,0.35)'); g.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = g; c.fillRect(0, 0, 64, 64);
  }
  const glowTex = tex(glowCanvas);
  const basic = (options) => keep(new THREE.MeshBasicMaterial({ toneMapped: false, ...options }));
  const std = (color, options = {}) => keep(new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.1, flatShading: true, ...options }));
  const add = (geometry, material, x = 0, y = 0, z = 0, parent = group) => {
    keep(geometry); const mesh = new THREE.Mesh(geometry, material); mesh.position.set(x, y, z); parent.add(mesh); return mesh;
  };
  // static parts sharing a material are batched into one geometry (one draw call)
  const batches = new Map();
  const batch = (material, geometry, matrix) => {
    const g = geometry.index ? geometry.toNonIndexed() : geometry; g.applyMatrix4(matrix);
    if (!batches.has(material)) batches.set(material, []); batches.get(material).push(g);
    if (g !== geometry) geometry.dispose();
  };
  function merged(parts) {
    let count = 0; for (const part of parts) count += part.attributes.position.count;
    const out = new THREE.BufferGeometry();
    for (const [name, size] of [['position', 3], ['normal', 3], ['uv', 2]]) {
      const array = new Float32Array(count * size); let offset = 0;
      for (const part of parts) { const attribute = part.attributes[name]; if (attribute) array.set(attribute.array, offset); offset += part.attributes.position.count * size; }
      out.setAttribute(name, new THREE.BufferAttribute(array, size));
    }
    for (const part of parts) part.dispose();
    out.computeBoundingSphere(); return out;
  }
  function flushBatches(parent = group) {
    for (const [material, parts] of batches) add(merged(parts), material, 0, 0, 0, parent);
    batches.clear();
  }
  const matrixAt = (x, y, z, ry = 0, rx = 0) => new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, 0, 'YXZ')), new THREE.Vector3(1, 1, 1));

  // --- neon sign atlas (static) -------------------------------------------------------------------
  const SIGNS = {
    bar: { cell: [0, 0, 512, 170], text: '코인 BAR', color: NEON.pink, size: 108 },
    pub: { cell: [512, 0, 512, 170], text: 'COIN PUB 24/7', color: NEON.cyan, size: 74 },
    moon: { cell: [0, 170, 512, 110], text: 'TO THE MOON', color: NEON.cyan, size: 70 },
    up: { cell: [512, 170, 256, 110], text: '떡상', color: NEON.red, size: 78 },
    gazua: { cell: [768, 170, 256, 110], text: '가즈아!', color: NEON.yellow, size: 66 },
    hodl: { cell: [0, 280, 256, 110], text: 'HODL', color: NEON.purple, size: 74 },
    pair: { cell: [256, 280, 512, 110], text: 'BTC · ETH', color: NEON.purple, size: 70 },
    bull: { cell: [768, 280, 256, 110], text: '불장', color: NEON.pink, size: 78 }
  };
  {
    const ctx = signCanvas.getContext('2d');
    for (const sign of Object.values(SIGNS)) {
      const [sx, sy, sw, sh] = sign.cell;
      ctx.save(); ctx.beginPath(); ctx.rect(sx, sy, sw, sh); ctx.clip();
      let size = sign.size; ctx.font = `900 ${size}px ${FONT}`;
      while (ctx.measureText(sign.text).width > sw - 40 && size > 20) { size -= 4; ctx.font = `900 ${size}px ${FONT}`; }
      neonText(ctx, sign.text, sx + sw / 2, sy + sh / 2 + 2, sign.color, size, { blur: 18 });
      ctx.restore();
    }
    signTex.needsUpdate = true;
  }
  const signMaterial = basic({ map: signTex, transparent: true, depthWrite: false, side: THREE.FrontSide });
  const backingMaterial = std('#120a1c', { roughness: 0.8 });
  const glowSprites = [];
  const glow = (color, x, y, z, sx, sy = sx, base = 0.55) => {
    const sprite = new THREE.Sprite(keep(new THREE.SpriteMaterial({ map: glowTex, color, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0, toneMapped: false })));
    sprite.position.set(x, y, z); sprite.scale.set(sx, sy, 1); sprite.userData.base = base; group.add(sprite); glowSprites.push(sprite); return sprite;
  };
  // a sign plane facing `angle` (direction of its normal in the xz plane, atan2(z, x))
  function sign(key, width, x, y, z, normalAngle, { backing = true, glowScale = 1.5 } = {}) {
    const s = SIGNS[key], [sx, sy, sw, sh] = s.cell, height = width * (sh / sw);
    const geometry = new THREE.PlaneGeometry(width, height);
    const uv = geometry.attributes.uv;
    for (let i = 0; i < uv.count; i += 1) uv.setXY(i, (sx + uv.getX(i) * sw) / 1024, 1 - (sy + (1 - uv.getY(i)) * sh) / 512);
    const ry = Math.PI / 2 - normalAngle, nx = Math.cos(normalAngle), nz = Math.sin(normalAngle);
    batch(signMaterial, geometry, matrixAt(x + nx * 0.012, y, z + nz * 0.012, ry));
    if (backing) batch(backingMaterial, new THREE.BoxGeometry(width * 1.04, height * 1.08, 0.03), matrixAt(x - nx * 0.005, y, z - nz * 0.005, ry));
    if (glowScale > 0) glow(s.color, x + nx * 0.12, y, z + nz * 0.12, width * glowScale, height * glowScale * 1.6, 0.5);
  }

  // --- island bar: counter ring, back-bar, stools ------------------------------------------------------
  // annulus sector extruded upward; the gap is centred on world angle gapCenter (atan2(z, x))
  function annulus(rIn, rOut, height, gapHalf = BAR.gapHalf) {
    const a0 = BAR.gapCenter + gapHalf, a1 = BAR.gapCenter - gapHalf + TAU;
    const shape = new THREE.Shape();
    // shape-space angle = -world angle (rotateX(-PI/2) maps shape y to world -z)
    shape.absarc(0, 0, rOut, -a0, -a1, true);
    shape.lineTo(Math.cos(-a1) * rIn, Math.sin(-a1) * rIn);
    shape.absarc(0, 0, rIn, -a1, -a0, false);
    shape.closePath();
    const geometry = new THREE.ExtrudeGeometry(shape, { depth: height, bevelEnabled: false, curveSegments: 48 });
    geometry.rotateX(-Math.PI / 2);
    return geometry;
  }
  const counterBody = add(annulus(BAR.counterIn, BAR.counterOut, BAR.counterTop - 0.05), std('#2a1a36', { emissive: '#1a0624', emissiveIntensity: 0.6 }), 0, 0.2, 0);
  counterBody.position.y = 0; counterBody.castShadow = true; counterBody.receiveShadow = true;
  const counterTop = add(annulus(BAR.counterIn - 0.05, BAR.counterOut + 0.06, 0.05, BAR.gapHalf - 0.02), std('#4b3a5c', { roughness: 0.25, metalness: 0.35 }), 0, BAR.counterTop - 0.05, 0);
  counterTop.receiveShadow = true;
  // LED strips (neon tubes) along the counter
  const tubeMats = { pink: basic({ color: NEON.pink }), cyan: basic({ color: NEON.cyan }), purple: basic({ color: NEON.purple }) };
  const neonArc = (radius, y, material, tube = 0.022, gap = true) => {
    const arc = gap ? TAU - BAR.gapHalf * 2 : TAU;
    const geometry = new THREE.TorusGeometry(radius, tube, 5, 72, arc);
    geometry.rotateX(Math.PI / 2);
    // torus starts at +x and runs toward +z after rotateX(+PI/2); rotate so the arc skips the gap
    const mesh = add(geometry, material, 0, y, 0);
    mesh.rotation.y = gap ? -(BAR.gapCenter + BAR.gapHalf) : 0;
    return mesh;
  };
  neonArc(BAR.counterOut + 0.012, 0.47, tubeMats.pink);
  neonArc(BAR.counterOut + 0.065, BAR.counterTop + 0.005, tubeMats.cyan, 0.012);
  neonArc(1.9, 0.205, tubeMats.purple, 0.025, false); // plinth
  neonArc(1.865, 1.49, tubeMats.cyan, 0.024, false); // under the cornice ticker
  neonArc(1.28, 1.67, tubeMats.pink, 0.026, false); // dome base
  // back-bar: glowing shelves + bottles around the drum
  const shelfYs = [0.52, 0.84, 1.16];
  const shelves = new THREE.InstancedMesh(keep(new THREE.TorusGeometry(1.5, 0.014, 4, 64).rotateX(Math.PI / 2)), tubeMats.cyan, shelfYs.length);
  const dummy = new THREE.Object3D();
  shelfYs.forEach((y, i) => { dummy.position.set(0, y, 0); dummy.updateMatrix(); shelves.setMatrixAt(i, dummy.matrix); });
  group.add(shelves);
  const bottlePoints = [[0, 0], [0.034, 0], [0.036, 0.1], [0.03, 0.13], [0.012, 0.16], [0.012, 0.21], [0, 0.21]].map(([r, y]) => new THREE.Vector2(r, y));
  const bottleGeo = keep(new THREE.LatheGeometry(bottlePoints, 6));
  const bottleColors = ['#ffb347', '#3dffa8', '#ff5ec4', '#43e8ff', '#b07cff', '#ffe066', '#ff6b6b'];
  const perShelf = 44, bottles = new THREE.InstancedMesh(bottleGeo, basic({ color: '#ffffff' }), perShelf * shelfYs.length);
  const tint = new THREE.Color();
  let bottleIndex = 0;
  shelfYs.forEach((y, s) => {
    for (let i = 0; i < perShelf; i += 1) {
      const a = (i / perShelf) * TAU + s * 0.07;
      dummy.position.set(Math.cos(a) * 1.5, y + 0.01, Math.sin(a) * 1.5); dummy.scale.setScalar(0.85 + ((i * 7 + s) % 5) * 0.08); dummy.updateMatrix();
      bottles.setMatrixAt(bottleIndex, dummy.matrix);
      bottles.setColorAt(bottleIndex, tint.set(bottleColors[(i * 3 + s * 5) % bottleColors.length]));
      bottleIndex += 1;
    }
  });
  group.add(bottles);
  // stools
  const stools = [];
  for (let i = 0; i < 18; i += 1) {
    const a = (i / 18) * TAU + BAR.gapCenter + Math.PI / 18;
    if (angleIn(a, BAR.gapCenter, BAR.gapHalf + 0.12)) continue;
    stools.push({ angle: a, x: Math.cos(a) * BAR.stoolR, z: Math.sin(a) * BAR.stoolR });
  }
  const seatMesh = new THREE.InstancedMesh(keep(new THREE.CylinderGeometry(0.15, 0.13, 0.07, 12)), std('#d81b60', { roughness: 0.4 }), stools.length);
  const poleMesh = new THREE.InstancedMesh(keep(new THREE.CylinderGeometry(0.025, 0.09, BAR.stoolTop - 0.07, 8)), std('#c8ccd8', { metalness: 0.8, roughness: 0.25 }), stools.length);
  stools.forEach((stool, i) => {
    dummy.scale.setScalar(1);
    dummy.position.set(stool.x, BAR.stoolTop - 0.035, stool.z); dummy.updateMatrix(); seatMesh.setMatrixAt(i, dummy.matrix);
    dummy.position.set(stool.x, (BAR.stoolTop - 0.07) / 2, stool.z); dummy.updateMatrix(); poleMesh.setMatrixAt(i, dummy.matrix);
  });
  seatMesh.castShadow = poleMesh.castShadow = true; group.add(seatMesh, poleMesh);
  // high tables with glowing drinks
  const tables = [];
  for (let i = 0; i < 7; i += 1) { const a = BAR.gapCenter + (i / 7) * TAU; tables.push({ angle: a, x: Math.cos(a) * BAR.tableR, z: Math.sin(a) * BAR.tableR }); }
  const tableTop = new THREE.InstancedMesh(keep(new THREE.CylinderGeometry(0.26, 0.26, 0.04, 16)), std('#2b2238', { roughness: 0.3, metalness: 0.4 }), tables.length);
  const tablePole = new THREE.InstancedMesh(keep(new THREE.CylinderGeometry(0.03, 0.16, 0.96, 8)), std('#c8ccd8', { metalness: 0.8, roughness: 0.25 }), tables.length);
  const tableRing = new THREE.InstancedMesh(keep(new THREE.TorusGeometry(0.265, 0.012, 4, 32).rotateX(Math.PI / 2)), tubeMats.pink, tables.length);
  const drinks = new THREE.InstancedMesh(keep(new THREE.CylinderGeometry(0.035, 0.03, 0.11, 8)), basic({ color: '#ffffff' }), tables.length * 3);
  tables.forEach((table, i) => {
    dummy.scale.setScalar(1);
    dummy.position.set(table.x, 0.98, table.z); dummy.updateMatrix(); tableTop.setMatrixAt(i, dummy.matrix);
    dummy.position.set(table.x, 0.48, table.z); dummy.updateMatrix(); tablePole.setMatrixAt(i, dummy.matrix);
    dummy.position.set(table.x, 0.975, table.z); dummy.updateMatrix(); tableRing.setMatrixAt(i, dummy.matrix);
    for (let k = 0; k < 3; k += 1) {
      const a = table.angle + k * 2.1 + i;
      dummy.position.set(table.x + Math.cos(a) * 0.13, 1.055, table.z + Math.sin(a) * 0.13); dummy.updateMatrix();
      drinks.setMatrixAt(i * 3 + k, dummy.matrix); drinks.setColorAt(i * 3 + k, tint.set(['#ffb347', '#ff5ec4', '#43e8ff'][(i + k) % 3]));
    }
  });
  tableTop.castShadow = tablePole.castShadow = true;
  group.add(tableTop, tablePole, tableRing, drinks);

  // --- LED halo (giant video wall) -------------------------------------------------------------------
  const halo = new THREE.Group(); halo.position.y = BAR.haloY; group.add(halo);
  const screenMaterial = basic({ map: screenTex });
  add(new THREE.CylinderGeometry(BAR.haloR, BAR.haloR, BAR.haloH, 96, 1, true), screenMaterial, 0, 0, 0, halo);
  add(new THREE.CylinderGeometry(BAR.haloR - 0.04, BAR.haloR - 0.04, BAR.haloH, 48, 1, true), std('#0b0912', { side: THREE.BackSide }), 0, 0, 0, halo);
  const capMaterial = std('#0d0a16', { roughness: 0.35, metalness: 0.5 });
  { const cap = add(new THREE.CircleGeometry(BAR.haloR - 0.02, 48), capMaterial, 0, -BAR.haloH / 2, 0, halo); cap.rotation.x = Math.PI / 2; }
  // the roof of the halo is an LED disc too (what the default top-down camera sees); it does not spin,
  // and its text is turned toward the default camera
  const roofHolder = new THREE.Group(); roofHolder.position.y = BAR.haloY + BAR.haloH / 2 + 0.005; roofHolder.rotation.y = -(2.1 - Math.PI / 2); group.add(roofHolder);
  const roof = add(new THREE.CircleGeometry(BAR.haloR - 0.01, 64), basic({ map: roofTex }), 0, 0, 0, roofHolder); roof.rotation.x = -Math.PI / 2;
  for (const [y, material] of [[BAR.haloH / 2, tubeMats.cyan], [-BAR.haloH / 2, tubeMats.pink]]) {
    add(new THREE.TorusGeometry(BAR.haloR + 0.02, 0.03, 5, 72).rotateX(Math.PI / 2), material, 0, y, 0, halo);
  }
  // struts from the cornice to the halo
  const strutMat = std('#20202a', { metalness: 0.6, roughness: 0.4 });
  for (let i = 0; i < 4; i += 1) {
    const a = (i / 4) * TAU + Math.PI / 4, r0 = 1.55, r1 = BAR.haloR - 0.06, y0 = 1.64, y1 = BAR.haloY - BAR.haloH / 2;
    const length = Math.hypot(r1 - r0, y1 - y0);
    batch(strutMat, new THREE.CylinderGeometry(0.03, 0.04, length, 6), matrixAt(Math.cos(a) * (r0 + r1) / 2, (y0 + y1) / 2, Math.sin(a) * (r0 + r1) / 2, -a + Math.PI / 2, Math.atan2(r1 - r0, y1 - y0)));
  }
  glow(NEON.cyan, 0, BAR.haloY, 0, 7.5, 3.2, 0.32);

  // --- ticker tape around the cornice ------------------------------------------------------------------
  const ticker = add(new THREE.CylinderGeometry(1.86, 1.86, 0.16, 64, 1, true), basic({ map: tickerTex }), 0, 1.57, 0);
  // quote board over the door (replaces the old ETH board texture on the exchange front)
  // big neon signs over the entrance (front) and on the back of the cornice
  sign('bar', 1.55, 0, 2.02, 1.72, Math.PI / 2, { glowScale: 1.7 });
  sign('pub', 1.5, 0, 2.0, 1.69, -Math.PI / 2, { backing: false, glowScale: 0 });
  sign('pub', 1.5, 0, 2.0, -1.72, -Math.PI / 2);
  sign('bar', 1.55, 0, 2.02, -1.69, Math.PI / 2, { backing: false, glowScale: 0 });
  sign('pair', 1.3, 1.72, 2.0, 0, 0);
  sign('bull', 0.72, 1.69, 2.0, 0, Math.PI, { backing: false, glowScale: 0 });
  sign('bull', 0.72, -1.72, 2.02, 0, Math.PI);
  sign('pair', 1.3, -1.69, 2.0, 0, 0, { backing: false, glowScale: 0 });
  // blade signs on the plaza lamps: one face outward, one inward
  const bladePairs = [['moon', 'up'], ['gazua', 'hodl'], ['up', 'moon'], ['hodl', 'gazua']];
  lampAngles.forEach((angle, i) => {
    const [outer, inner] = bladePairs[i % bladePairs.length];
    const x = Math.cos(angle) * lampRadius, z = Math.sin(angle) * lampRadius;
    const widthOf = (key) => SIGNS[key].cell[2] === 512 ? 0.95 : 0.52;
    sign(outer, widthOf(outer), x, 1.72, z, angle, { glowScale: 1.4 });
    sign(inner, widthOf(inner), x, 1.72, z, angle + Math.PI, { glowScale: 1.4, backing: false });
  });
  flushBatches();
  for (const mesh of group.children) if (mesh.material === signMaterial) mesh.renderOrder = 3;

  // --- free-standing double-sided K-line pylons -----------------------------------------------------------
  const pylonGroup = new THREE.Group(); group.add(pylonGroup);
  const pylons = [];
  const pylonUv = (geometry, panel) => {
    const uv = geometry.attributes.uv; const u0 = panel * 0.125;
    // PlaneGeometry(1x1 segments) vertex order: top-left, top-right, bottom-left, bottom-right
    for (let i = 0; i < uv.count; i += 1) uv.setX(i, u0 + (i % 2 ? 0.125 : 0));
    uv.needsUpdate = true;
  };
  for (let i = 0; i < 2; i += 1) {
    const holder = new THREE.Group(); pylonGroup.add(holder);
    const width = 2.1, height = width * (SCREEN_H / PANEL_W);
    const front = add(new THREE.PlaneGeometry(width, height), screenMaterial, 0, 2.05, 0.06, holder);
    const back = add(new THREE.PlaneGeometry(width, height), screenMaterial, 0, 2.05, -0.06, holder); back.rotation.y = Math.PI;
    pylonUv(front.geometry, i); pylonUv(back.geometry, 1 - i);
    const frame = add(new THREE.BoxGeometry(width + 0.14, height + 0.14, 0.1), std('#15121f', { metalness: 0.5, roughness: 0.4 }), 0, 2.05, 0, holder); frame.castShadow = true;
    for (const side of [-1, 1]) { const leg = add(new THREE.BoxGeometry(0.08, 2.05 - height / 2, 0.08), strutMat, side * width * 0.36, (2.05 - height / 2) / 2, 0, holder); leg.castShadow = true; }
    for (const z of [0.065, -0.065]) {
      batch(tubeMats.purple, new THREE.BoxGeometry(width + 0.2, 0.025, 0.02), matrixAt(0, 2.05 + height / 2 + 0.085, z));
      batch(tubeMats.purple, new THREE.BoxGeometry(width + 0.2, 0.025, 0.02), matrixAt(0, 2.05 - height / 2 - 0.085, z));
      for (const side of [-1, 1]) batch(tubeMats.purple, new THREE.BoxGeometry(0.025, height + 0.2, 0.02), matrixAt(side * (width / 2 + 0.085), 2.05, z));
    }
    flushBatches(holder);
    pylons.push({ holder, front, back, panel: i, glow: glow(i ? NEON.pink : NEON.cyan, 0, 2.05, 0, 3.2, 2.3, 0.35) });
  }
  // Two pylons flank the plaza either side of the default camera's line of sight (world angle ~2.1),
  // on the plaza rim clear of the spoke roads, turned to face that camera side.
  const VIEW_ANGLE = 2.1;
  function placePylons(spokeAngles = []) {
    const clearance = (a) => spokeAngles.length ? Math.min(...spokeAngles.map((s) => Math.abs(((a - s + Math.PI * 3) % TAU) - Math.PI))) : 1;
    [VIEW_ANGLE + 1.35, VIEW_ANGLE - 1.35].forEach((ideal, i) => {
      let best = null;
      for (let k = -10; k <= 10; k += 1) {
        const a = ideal + k * 0.05, score = Math.min(clearance(a), 0.45) - Math.abs(k) * 0.004;
        if (!best || score > best.score) best = { a, score };
      }
      const r = 4.9, x = Math.cos(best.a) * r, z = Math.sin(best.a) * r;
      const fx = Math.cos(VIEW_ANGLE) * 30 - x, fz = Math.sin(VIEW_ANGLE) * 30 - z;
      const toward = Math.atan2(fz, fx), normal = best.a + (((toward - best.a + Math.PI * 3) % TAU) - Math.PI) * 0.8;
      const pylon = pylons[i];
      pylon.holder.position.set(x, 0, z); pylon.holder.rotation.y = Math.PI / 2 - normal;
      pylon.glow.position.set(x + Math.cos(normal) * 0.35, 2.05, z + Math.sin(normal) * 0.35);
    });
  }
  placePylons();

  // --- searchlight beams sweeping the night sky from the plaza rim ------------------------------------
  const beamCanvas = makeCanvas(4, 128); {
    const c = beamCanvas.getContext('2d'), g = c.createLinearGradient(0, 0, 0, 128);
    g.addColorStop(0, 'rgba(255,255,255,0)'); g.addColorStop(0.6, 'rgba(255,255,255,0.25)'); g.addColorStop(1, 'rgba(255,255,255,0.9)');
    c.fillStyle = g; c.fillRect(0, 0, 4, 128);
  }
  const beamTex = tex(beamCanvas);
  const beams = [NEON.pink, NEON.cyan, NEON.purple, NEON.cyan].map((color, i) => {
    const geometry = new THREE.CylinderGeometry(0.9, 0.06, 26, 16, 1, true).translate(0, 13, 0);
    const material = basic({ map: beamTex, color, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, opacity: 0 });
    const a = (i / 4) * TAU + Math.PI / 4 + 0.35;
    const beam = add(geometry, material, Math.cos(a) * 4.3, 0.1, Math.sin(a) * 4.3);
    beam.userData.phase = i * 1.7; beam.renderOrder = 4; beam.frustumCulled = false;
    return beam;
  });

  // --- colored lights, confetti, flash billboard -------------------------------------------------------
  const lights = [new THREE.PointLight(NEON.pink, 0, 9, 1.4), new THREE.PointLight(NEON.cyan, 0, 9, 1.4)];
  lights[0].position.set(-2.4, 2.2, 1.6); lights[1].position.set(2.4, 2.2, -1.2);
  group.add(...lights);
  const CONFETTI = 420;
  const confettiGeo = keep(new THREE.BufferGeometry());
  const confettiPos = new Float32Array(CONFETTI * 3), confettiCol = new Float32Array(CONFETTI * 3), confettiVel = new Float32Array(CONFETTI * 3);
  confettiGeo.setAttribute('position', new THREE.BufferAttribute(confettiPos, 3));
  confettiGeo.setAttribute('color', new THREE.BufferAttribute(confettiCol, 3));
  const confettiMat = keep(new THREE.PointsMaterial({ size: 0.11, vertexColors: true, transparent: true, depthWrite: false, toneMapped: false }));
  const confetti = new THREE.Points(confettiGeo, confettiMat); confetti.visible = false; confetti.frustumCulled = false; group.add(confetti);
  let confettiAge = Infinity;
  const flashSprite = new THREE.Sprite(keep(new THREE.SpriteMaterial({ map: flashTex, transparent: true, depthWrite: false, opacity: 0, toneMapped: false })));
  flashSprite.scale.set(6.4, 1.6, 1); flashSprite.position.set(0, 6.05, 0); flashSprite.renderOrder = 5; group.add(flashSprite);
  function burst(kind) {
    const palette = kind === 'dump' ? ['#2f8bff', '#9cc9ff', '#ffffff', '#1d5fd1'] : ['#ff3b5c', '#ffe14d', '#2ef2ff', '#ff3fb4', '#a35bff', '#ffffff'];
    for (let i = 0; i < CONFETTI; i += 1) {
      const a = Math.random() * TAU, r = BAR.haloR * (0.6 + Math.random() * 0.5);
      confettiPos.set([Math.cos(a) * r, BAR.haloY + (Math.random() - 0.3) * 1.2, Math.sin(a) * r], i * 3);
      const speed = kind === 'dump' ? 0.4 : 1.6 + Math.random() * 2.4;
      confettiVel.set([Math.cos(a) * speed, kind === 'dump' ? -0.3 - Math.random() * 0.6 : 2 + Math.random() * 3, Math.sin(a) * speed], i * 3);
      tint.set(palette[i % palette.length]); confettiCol.set([tint.r, tint.g, tint.b], i * 3);
    }
    confettiGeo.attributes.color.needsUpdate = true;
    confettiAge = 0; confetti.visible = true;
  }
  function drawFlash(kind) {
    const ctx = flashCanvas.getContext('2d'); ctx.clearRect(0, 0, 1024, 256);
    const col = kind === 'dump' ? DOWN : UP;
    neonText(ctx, kind === 'dump' ? 'LIQUIDATED' : 'TO THE MOON ▲', 512, 96, col, 112, { blur: 30 });
    neonText(ctx, kind === 'dump' ? '떡락 · 청산 · REKT' : '떡상 · 가즈아!', 512, 202, kind === 'dump' ? '#9cc9ff' : NEON.yellow, 64, { blur: 20 });
    flashTex.needsUpdate = true;
  }

  // --- data -> textures -----------------------------------------------------------------------------
  let market = normalizeMarket(null);
  let previousMarket = null;
  const tweens = {}; // symbol -> { from, start }
  let reaction = null; // { kind, strength, big, symbol, start }
  let screenDirty = true, lastScreenDraw = -Infinity, volatility = 0.3;
  function drawScreens(t, now) {
    const ctx = screenCanvas.getContext('2d');
    SYMBOLS.forEach((symbol, i) => {
      const tween = tweens[symbol] ? { from: tweens[symbol].from, k: clamp((now - tweens[symbol].start) / 900) } : null;
      const eased = tween ? { ...tween, k: 1 - (1 - tween.k) ** 3 } : null;
      drawChartPanel(ctx, i * PANEL_W, market.charted ? market.symbols[symbol] : { ...market.symbols[symbol], candles: [] }, eased, t);
    });
    drawTradesPanel(ctx, PANEL_W * 2, market, t);
    const flash = reaction?.big && now - reaction.start < 4_000 ? reaction : null;
    drawBrandPanel(ctx, PANEL_W * 3, market, flash, t);
    screenTex.needsUpdate = true;
  }
  function drawTicker() {
    const ctx = tickerCanvas.getContext('2d');
    ctx.fillStyle = '#05040c'; ctx.fillRect(0, 0, 2048, 64);
    ctx.font = `800 36px ${FONT}`; ctx.textBaseline = 'middle';
    const items = [];
    if (market.priced) for (const symbol of SYMBOLS) {
      const info = market.symbols[symbol]; if (info.price === null) continue;
      items.push([`${symbol} ${formatPrice(info.price)}`, '#ffffff'], [formatPct(info.change24h), sideColor(info.change24h)]);
      items.push(['·', '#6b5a8f']);
    } else items.push(['MARKET LOADING', NEON.cyan], ['·', '#6b5a8f']);
    items.push(['코인 BAR', NEON.pink], ['·', '#6b5a8f'], ['TO THE MOON', NEON.cyan], ['·', '#6b5a8f']);
    const last = market.trades[0];
    if (last) items.push([`${last.side === 'sell' ? '매도' : '매수'} ${String(last.resident || '').replace(/^agent-/, '')} ${last.size ? Number(last.size).toFixed(4) : ''} ${last.asset}`, last.side === 'sell' ? DOWN : UP], ['·', '#6b5a8f']);
    items.push(['SIMULATED', '#8c80aa'], ['·', '#6b5a8f']);
    let x = 20;
    ctx.save(); ctx.shadowBlur = 10;
    while (x < 2048) for (const [value, color] of items) { if (x >= 2048) break; ctx.fillStyle = color; ctx.shadowColor = color; ctx.fillText(value, x, 34); x += ctx.measureText(value).width + 22; }
    ctx.restore();
    tickerTex.needsUpdate = true;
  }
  function drawBoard() {
    const ctx = boardCanvas.getContext('2d');
    const g = ctx.createLinearGradient(0, 0, 0, 188); g.addColorStop(0, '#0d0820'); g.addColorStop(1, '#04030b');
    ctx.fillStyle = g; ctx.fillRect(0, 0, 512, 188);
    ctx.strokeStyle = NEON.pink; ctx.lineWidth = 4; ctx.strokeRect(4, 4, 504, 180);
    text(ctx, 'SYNTERRA EXCHANGE · 코인 BAR', 20, 36, NEON.cyan, 22, { weight: 800, font: FONT });
    if (!market.priced) { neonText(ctx, 'MARKET LOADING', 256, 116, NEON.cyan, 40); boardTex.needsUpdate = true; return; }
    SYMBOLS.forEach((symbol, i) => {
      const info = market.symbols[symbol], col = sideColor(info.change24h), y = 92 + i * 56;
      text(ctx, symbol, 20, y, '#ffffff', 34, { weight: 900, font: FONT });
      text(ctx, formatPrice(info.price), 300, y, col, 34, { align: 'right', weight: 800 });
      text(ctx, formatPct(info.change24h), 492, y, col, 26, { align: 'right', weight: 800 });
    });
    boardTex.needsUpdate = true;
  }
  function drawRoof() {
    const ctx = roofCanvas.getContext('2d');
    const g = ctx.createRadialGradient(256, 256, 20, 256, 256, 256);
    g.addColorStop(0, '#1c0a33'); g.addColorStop(0.8, '#07051a'); g.addColorStop(1, '#020208');
    ctx.fillStyle = g; ctx.fillRect(0, 0, 512, 512);
    ctx.save(); ctx.translate(256, 256);
    for (let i = 0; i < 72; i += 1) {
      ctx.rotate(TAU / 72); ctx.fillStyle = i % 6 === 0 ? NEON.cyan : 'rgba(163,91,255,0.55)';
      ctx.fillRect(-2, -246, 4, i % 6 === 0 ? 22 : 12);
    }
    ctx.restore();
    ctx.strokeStyle = NEON.pink; ctx.lineWidth = 5; ctx.shadowColor = NEON.pink; ctx.shadowBlur = 16;
    ctx.beginPath(); ctx.arc(256, 256, 206, 0, TAU); ctx.stroke(); ctx.shadowBlur = 0;
    neonText(ctx, '코인 BAR', 256, 168, NEON.pink, 82);
    if (!market.priced) { neonText(ctx, 'MARKET LOADING', 256, 290, NEON.cyan, 38); }
    else SYMBOLS.forEach((symbol, i) => {
      const info = market.symbols[symbol], col = sideColor(info.change24h), y = 268 + i * 66;
      text(ctx, `${symbol} ${formatPrice(info.price)}`, 256, y, '#ffffff', 40, { align: 'center', weight: 900 });
      text(ctx, `${formatPct(info.change24h)}`, 256, y + 30, col, 26, { align: 'center', weight: 800 });
    });
    roofTex.needsUpdate = true;
  }
  drawScreens(0, performance.now()); drawTicker(); drawBoard(); drawRoof();

  function update(data) {
    const next = normalizeMarket(data);
    const now = performance.now();
    const changed = JSON.stringify([next.symbols.BTC.price, next.symbols.ETH.price, next.symbols.BTC.candles.length, next.symbols.ETH.candles.length,
      next.symbols.BTC.candles.at(-1)?.t, next.symbols.ETH.candles.at(-1)?.v, next.trades.map((trade) => trade.createdAt), next.charted, next.priced])
      !== JSON.stringify([market.symbols.BTC.price, market.symbols.ETH.price, market.symbols.BTC.candles.length, market.symbols.ETH.candles.length,
        market.symbols.BTC.candles.at(-1)?.t, market.symbols.ETH.candles.at(-1)?.v, market.trades.map((trade) => trade.createdAt), market.charted, market.priced]);
    if (!changed) return null;
    previousMarket = market.priced ? market : previousMarket;
    for (const symbol of SYMBOLS) {
      const before = market.symbols[symbol]?.price, after = next.symbols[symbol]?.price;
      tweens[symbol] = before && after && before !== after ? { from: before, start: now } : null;
    }
    const detected = market.priced ? detectReaction(market, next) : null;
    market = next;
    // volatility drives the light pulse: last tick vs typical move, smoothed
    if (detected) {
      reaction = { ...detected, start: now };
      volatility = clamp(volatility * 0.5 + detected.strength * 0.7, 0.15, 1);
      if (detected.big) { burst(detected.kind); drawFlash(detected.kind); }
    }
    screenDirty = true; drawTicker(); drawBoard(); drawRoof();
    return detected;
  }

  // --- spots for plaza residents ----------------------------------------------------------------------
  const stoolSpots = stools.map((stool) => ({ kind: 'stool', pos: [stool.x, stool.z], face: Math.atan2(-stool.x, -stool.z), y: BAR.stoolTop - 0.4, angle: stool.angle }));
  const tableSpots = [];
  for (const table of tables) for (const side of [-1, 1]) {
    const tx = -Math.sin(table.angle), tz = Math.cos(table.angle); // tangent
    const x = table.x + tx * side * 0.46 + Math.cos(table.angle) * 0.06, z = table.z + tz * side * 0.46 + Math.sin(table.angle) * 0.06;
    tableSpots.push({ kind: 'table', pos: [x, z], face: Math.atan2(table.x - x, table.z - z), y: 0, angle: table.angle });
  }
  // nearest-to-the-default-camera first so a small crowd still reads well
  const frontFirst = (a, b) => Math.abs(((a.angle - 2.1 + Math.PI * 3) % TAU) - Math.PI) - Math.abs(((b.angle - 2.1 + Math.PI * 3) % TAU) - Math.PI);
  stoolSpots.sort(frontFirst); tableSpots.sort(frontFirst);
  function spotsFor(members) {
    // members: [{ id, trading }] in stable order; traders stand at the tables, drinkers take stools
    const assigned = new Map(), freeStools = [...stoolSpots], freeTables = [...tableSpots];
    for (const member of members) {
      const list = member.trading ? (freeTables.length ? freeTables : freeStools) : (freeStools.length ? freeStools : freeTables);
      const spot = list.shift();
      if (spot) { assigned.set(member.id, spot); continue; }
      const overflow = assigned.size, a = overflow * 0.61 + 0.3, r = 3.4;
      assigned.set(member.id, { kind: 'stand', pos: [Math.cos(a) * r, Math.sin(a) * r], face: Math.atan2(-Math.cos(a), -Math.sin(a)), y: 0, angle: a });
    }
    return assigned;
  }

  // --- per frame ---------------------------------------------------------------------------------------
  const neonBase = { pink: new THREE.Color(NEON.pink), cyan: new THREE.Color(NEON.cyan), purple: new THREE.Color(NEON.purple) };
  const flicker = { value: 1, until: 0 };
  function animate(time, dt, { night = 0, gloom = 0, motion = true } = {}) {
    const t = time / 1000, now = performance.now();
    const age = reaction ? (now - reaction.start) / 1000 : Infinity;
    const tweening = SYMBOLS.some((symbol) => tweens[symbol] && now - tweens[symbol].start < 950);
    const flashing = reaction?.big && age < 4.2;
    if (screenDirty || ((tweening || flashing) && now - lastScreenDraw > 70) || (!market.charted && now - lastScreenDraw > 500)) {
      drawScreens(t, now); lastScreenDraw = now; screenDirty = tweening || flashing;
    }
    if (motion) {
      halo.rotation.y += dt * 0.07;
      tickerTex.offset.x = (tickerTex.offset.x + dt * 0.018) % 1;
    }
    // swap the pylon faces between BTC and ETH every 12 s
    const swap = Math.floor(t / 12) % 2;
    pylons.forEach((pylon) => {
      const frontPanel = (pylon.panel + swap) % 2;
      if (pylon.shown !== frontPanel) { pylonUv(pylon.front.geometry, frontPanel); pylonUv(pylon.back.geometry, 1 - frontPanel); pylon.shown = frontPanel; }
    });
    // neon pulse: faster and deeper with volatility; occasional flicker; a hit when the crowd reacts
    volatility = Math.max(0.15, volatility - dt * 0.01);
    if (motion && now > flicker.until && Math.random() < dt * 0.25) flicker.until = now + 140 + Math.random() * 160;
    const flick = motion && now < flicker.until ? 0.45 + Math.random() * 0.4 : 1;
    const hit = age < 1.2 ? (1 - age / 1.2) * (reaction.strength || 0.4) : 0;
    const pulse = motion ? 1 + Math.sin(t * (1.6 + volatility * 7)) * (0.08 + volatility * 0.16) + hit * 0.5 : 1;
    const level = (0.55 + gloom * 0.45) * pulse;
    tubeMats.pink.color.copy(neonBase.pink).multiplyScalar(Math.min(1.4, level * flick));
    tubeMats.cyan.color.copy(neonBase.cyan).multiplyScalar(Math.min(1.4, level));
    tubeMats.purple.color.copy(neonBase.purple).multiplyScalar(Math.min(1.4, level));
    signMaterial.color.setScalar(Math.min(1.25, (0.8 + gloom * 0.35) * (motion ? 1 + Math.sin(t * 2.3) * 0.05 : 1)));
    screenMaterial.color.setScalar(0.82 + gloom * 0.18);
    for (const sprite of glowSprites) sprite.material.opacity = (0.08 + gloom * 0.92) * sprite.userData.base * pulse;
    const reactTint = hit > 0 ? (reaction.kind === 'dump' ? DOWN : UP) : null;
    lights[0].intensity = gloom * 7 * pulse; lights[1].intensity = gloom * 6 * pulse;
    if (reactTint) { lights[0].color.set(reactTint); lights[0].intensity += hit * 10 * Math.max(0.3, gloom); } else lights[0].color.set(NEON.pink);
    // confetti / sad rain
    if (!motion) confetti.visible = false;
    if (confetti.visible) {
      confettiAge += dt;
      const step = motion ? dt : 0, gravity = reaction?.kind === 'dump' ? -0.8 : -3.2;
      for (let i = 0; i < CONFETTI; i += 1) {
        confettiVel[i * 3 + 1] += gravity * step;
        confettiVel[i * 3] *= 1 - step * 0.6; confettiVel[i * 3 + 2] *= 1 - step * 0.6;
        confettiPos[i * 3] += (confettiVel[i * 3] + Math.sin(t * 3 + i) * 0.3) * step;
        confettiPos[i * 3 + 1] = Math.max(0.05, confettiPos[i * 3 + 1] + confettiVel[i * 3 + 1] * step);
        confettiPos[i * 3 + 2] += (confettiVel[i * 3 + 2] + Math.cos(t * 2.6 + i) * 0.3) * step;
      }
      confettiGeo.attributes.position.needsUpdate = true;
      confettiMat.opacity = clamp(1 - (confettiAge - 3.2) / 1.2);
      if (confettiAge > 4.4) confetti.visible = false;
    }
    beams.forEach((beam) => {
      const sweep = motion ? t * (0.35 + volatility * 0.6) + beam.userData.phase : beam.userData.phase;
      beam.rotation.set(0.35 + Math.sin(sweep * 0.7) * 0.18, 0, 0); beam.rotation.y = sweep; beam.rotation.order = 'YXZ';
      beam.material.opacity = Math.max(0, night - 0.35) * (0.16 + hit * 0.25);
      beam.visible = beam.material.opacity > 0.005;
    });
    flashSprite.material.opacity = flashing ? (motion ? (Math.floor(t * 5) % 2 ? 1 : 0.55) : 0.9) * clamp((4.2 - age) / 0.6) : 0;
    flashSprite.position.y = 6.05 + (flashing ? Math.sin(t * 3) * 0.12 : 0);
  }

  function crowd(now = performance.now()) {
    if (!reaction) return null;
    const age = (now - reaction.start) / 1000, duration = reaction.big ? 6 : 3.2 + reaction.strength * 2;
    if (age > duration) return null;
    return { kind: reaction.kind, big: reaction.big, age, k: clamp(Math.min(age / 0.25, (duration - age) / 0.8)) * (0.45 + reaction.strength * 0.55) };
  }

  function dispose() {
    for (const thing of disposables) thing.dispose?.();
    group.removeFromParent();
  }

  return { group, boardTexture: boardTex, update, animate, crowd, spotsFor, placePylons, dispose,
    get market() { return market; }, get reaction() { return reaction; }, get previous() { return previousMarket; } };
}

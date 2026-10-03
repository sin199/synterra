import { createWorld3D } from './world3d.js';

const worldCount = document.querySelector('#world-count');
const residentCount = document.querySelector('#resident-count');
const chainId = document.querySelector('#chain-id');
const mineCount = document.querySelector('#mine-count');
const mineOutput = document.querySelector('#mine-output');
const statsState = document.querySelector('#stats-state');
const mapLocations = document.querySelector('#map-locations');
const agentPanel = document.querySelector('#agent-panel');
const activityList = document.querySelector('#map-activity-list');
const activityCount = document.querySelector('#map-activity-count');
const mapState = document.querySelector('#map-state');
const mapStatusDot = document.querySelector('#map-status-dot');
const mapUpdated = document.querySelector('#map-updated');
const mapError = document.querySelector('#map-error');
const sceneMap = document.querySelector('#scene-map');
const marketQuotes = document.querySelector('#market-quotes');
const marketUpdated = document.querySelector('#market-updated');
const portfolioSummary = document.querySelector('#portfolio-summary');
const recentTrades = document.querySelector('#recent-trades');
const numberFormat = new Intl.NumberFormat('zh-CN');
const moneyFormat = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const MAP_POINTS = [
  [18, 22], [48, 17], [80, 23], [31, 42], [72, 42],
  [20, 73], [51, 81], [83, 72], [13, 48], [70, 84],
  [39, 16], [61, 23], [89, 42], [31, 82], [89, 84],
  [10, 26], [44, 89], [61, 67], [27, 58], [78, 58]
];
const SCENE_ICONS = { garden: '❋', studio: '◈', library: '▤', cafe: '◒', workshop: '⌘', observatory: '⊙', commons: '✳', data_center: '▥' };
const ARCHETYPES = { naturalist: '自然观察者', maker: '创造者', scholar: '学者', host: '组织者', observer: '观察者' };
const EVENT_LABELS = {
  'action.socialize': '社交', 'action.travel': '前往场景', 'action.work': '工作',
  'action.rest': '休息', 'action.eat': '进食', 'action.build_scene': '建造场景', 'scene.created': '场景建造',
  'crypto.trade_filled': '模拟加密货币成交', 'crypto.trade_held': '选择持有',
  'crypto.robinhood_paper_filled': 'Robinhood meme 币模拟成交',
  'world.movement_started': '启程', 'world.agent_arrived': '抵达', 'world.action_started': '开始行动',
  'world.action_completed': '完成行动', 'world.goal_updated': '调整长期目标'
};
const ACTION_LABELS = { work: '工作', learn: '学习', rest: '休息', eat: '进食', socialize: '社交', trade: '模拟交易' };
let latestMapData = null;
let selectedAgentId = null;
let world3d = null;

try {
  world3d = createWorld3D(document.querySelector('#world3d-canvas'), document.querySelector('#world3d-labels'), selectAgentById);
} catch {
  world3d = null;
}
sceneMap?.classList.toggle('is-fallback', !world3d);
sceneMap?.classList.toggle('is-3d', Boolean(world3d));
if (!world3d) {
  document.querySelector('.world3d-hint')?.replaceChildren(document.createTextNode('WebGL 不可用 · 显示二维地图'));
}

function displayCount(value) {
  const number = Number(value);
  return numberFormat.format(Number.isFinite(number) && number >= 0 ? number : 0);
}

function setText(element, value) {
  if (element) element.textContent = value;
}

function selectAgentById(agentId) {
  const agent = latestMapData?.residents?.find((resident) => resident.id === agentId);
  if (!agent) return;
  selectedAgentId = agentId;
  renderMap();
  renderAgentPanel(agent);
  world3d?.select(agentId);
}

function formatTime(value, includeDate = false) {
  if (!value) return '暂无记录';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '时间未知';
  return new Intl.DateTimeFormat('zh-CN', includeDate
    ? { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }
    : { hour: '2-digit', minute: '2-digit' }).format(date);
}

function eventLabel(eventType, action) {
  if (eventType === 'world.action_started' || eventType === 'world.action_completed') return ACTION_LABELS[action] || EVENT_LABELS[eventType];
  return EVENT_LABELS[eventType] || (typeof eventType === 'string' && eventType.startsWith('action.')
    ? eventType.slice(7) : '世界活动');
}

async function loadStats() {
  try {
    const response = await fetch('/public/stats', { headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`Stats request failed (${response.status})`);
    const stats = await response.json();
    setText(worldCount, displayCount(stats.openWorlds));
    setText(residentCount, displayCount(stats.residents));
    setText(chainId, displayCount(stats.chainId));
    setText(mineCount, displayCount(stats.activeMines));
    setText(mineOutput, displayCount(Number(stats.extractedUnits)));
    setText(statsState, '· 刚刚更新');
  } catch {
    setText(statsState, '· 汇总暂不可用');
  }
}

function createAgentMarker(agent, selected = false) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `agent-marker${selected ? ' is-selected' : ''}`;
  button.textContent = agent.name.split(/[-\s]/).filter(Boolean).at(-1)?.slice(-2) || '•';
  button.setAttribute('aria-label', `查看 ${agent.name}`);
  button.title = agent.name;
  button.addEventListener('click', () => {
    selectAgentById(agent.id);
  });
  return button;
}

function renderMap() {
  if (!latestMapData || !mapLocations) return;
  mapLocations.replaceChildren();
  const scenes = latestMapData.scenes || [];
  const residents = latestMapData.residents || [];
  if (scenes.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'map-loading';
    empty.textContent = '这个世界还没有已建场景。';
    mapLocations.append(empty);
    return;
  }

  const byLocation = new Map();
  for (const resident of residents) {
    const list = byLocation.get(resident.location) || [];
    list.push(resident);
    byLocation.set(resident.location, list);
  }

  scenes.forEach((scene, index) => {
    const [left, top] = MAP_POINTS[index % MAP_POINTS.length];
    const node = document.createElement('div');
    node.className = 'map-location';
    node.dataset.sceneType = scene.sceneType || 'commons';
    node.style.left = `${left}%`;
    node.style.top = `${top}%`;
    node.setAttribute('role', 'group');
    node.setAttribute('aria-label', `${scene.name}，${displayCount(scene.residentCount)} 位居民`);

    const label = document.createElement('div');
    label.className = 'map-place-label';
    const icon = document.createElement('span');
    icon.className = 'map-place-icon';
    icon.textContent = SCENE_ICONS[scene.sceneType] || '◇';
    const name = document.createElement('span');
    name.className = 'map-place-name';
    name.textContent = scene.name;
    label.append(icon, name);
    node.append(label);

    const markers = document.createElement('div');
    markers.className = 'map-markers';
    const occupants = byLocation.get(scene.name) || [];
    for (const resident of occupants) markers.append(createAgentMarker(resident, resident.id === selectedAgentId));
    if (occupants.length === 0) {
      const empty = document.createElement('span');
      empty.className = 'empty-place-mark';
      empty.setAttribute('aria-label', '当前无人');
      markers.append(empty);
    }
    node.append(markers);
    mapLocations.append(node);
  });

  const exchangeNode = document.createElement('div');
  exchangeNode.className = 'map-location map-exchange';
  exchangeNode.style.left = '50%';
  exchangeNode.style.top = '50%';
  exchangeNode.setAttribute('role', 'group');
  exchangeNode.setAttribute('aria-label', 'Exchange 模拟交易大厅');
  const exchangeLabel = document.createElement('div');
  exchangeLabel.className = 'map-place-label';
  exchangeLabel.textContent = 'Exchange';
  exchangeNode.append(exchangeLabel);
  const exchangeMarkers = document.createElement('div');
  exchangeMarkers.className = 'map-markers';
  for (const resident of byLocation.get('Exchange') || []) {
    exchangeMarkers.append(createAgentMarker(resident, resident.id === selectedAgentId));
  }
  exchangeNode.append(exchangeMarkers);
  mapLocations.append(exchangeNode);

  const unplaced = residents.filter((resident) => resident.location !== 'Exchange' && !scenes.some((scene) => scene.name === resident.location));
  if (unplaced.length) {
    const node = document.createElement('div');
    node.className = 'map-location map-unplaced';
    const [left, top] = MAP_POINTS[19];
    node.style.left = `${left}%`;
    node.style.top = `${top}%`;
    const label = document.createElement('div');
    label.className = 'map-place-label';
    label.textContent = '其他地点';
    const markers = document.createElement('div');
    markers.className = 'map-markers';
    for (const resident of unplaced) markers.append(createAgentMarker(resident, resident.id === selectedAgentId));
    node.append(label, markers);
    mapLocations.append(node);
  }
}

function renderAgentPanel(agent) {
  if (!agentPanel || !agent) return;
  agentPanel.replaceChildren();
  const card = document.createElement('div');
  card.className = 'agent-detail';
  const header = document.createElement('div');
  header.className = 'agent-detail-heading';
  const avatar = document.createElement('span');
  avatar.className = 'agent-detail-avatar';
  avatar.textContent = agent.name.split(/[-\s]/).filter(Boolean).at(-1)?.slice(-2) || '•';
  const identity = document.createElement('div');
  const eyebrow = document.createElement('span');
  eyebrow.className = 'agent-detail-eyebrow';
  eyebrow.textContent = 'SYN TERRA RESIDENT';
  const title = document.createElement('h3');
  title.textContent = agent.name;
  const subtitle = document.createElement('p');
  subtitle.className = 'agent-detail-subtitle';
  subtitle.textContent = `${agent.gender === 'female' ? '女' : agent.gender === 'male' ? '男' : '未设定'} · ${ARCHETYPES[agent.archetype] || '尚无类型'}`;
  identity.append(eyebrow, title, subtitle);
  header.append(avatar, identity);
  card.append(header);

  const needs = document.createElement('div');
  needs.className = 'agent-needs';
  for (const [key, label, value] of [['energy', '精力', agent.energy], ['food', '食物', agent.food], ['social', '社交', agent.social]]) {
    const row = document.createElement('div');
    row.className = 'need-row';
    const name = document.createElement('span');
    name.textContent = label;
    const bar = document.createElement('progress');
    bar.max = 100;
    bar.value = Math.max(0, Math.min(100, Number(value) || 0));
    bar.setAttribute('aria-label', `${label} ${displayCount(value)}%`);
    bar.className = `need-meter need-${key}`;
    const amount = document.createElement('strong');
    amount.textContent = `${displayCount(value)}%`;
    row.append(name, bar, amount);
    needs.append(row);
  }
  card.append(needs);

  const facts = document.createElement('dl');
  facts.className = 'agent-facts';
  const activeAction = agent.currentStatus === 'walking'
    ? `前往 ${agent.targetLocation || '目标地点'}`
    : agent.currentStatus === 'performing' ? (ACTION_LABELS[agent.currentAction] || agent.currentAction || '行动中') : '待决定';
  for (const [label, value] of [
    ['所在地点', agent.location || '未知'],
    ['当前行动', activeAction],
    ['目标地点', agent.targetLocation || '—'],
    ['现金', `${moneyFormat.format(Number(agent.assets?.USDC || 0))} USDC`],
    ['BTC / ETH', `${Number(agent.assets?.BTC || 0).toFixed(6)} / ${Number(agent.assets?.ETH || 0).toFixed(5)}`],
    ['心情 / 知识', `${displayCount(agent.happiness)} / ${displayCount(agent.knowledge)}`],
    ['行动次数', displayCount(agent.actionsTaken)],
    ['最近行动', agent.lastEventType ? `${eventLabel(agent.lastEventType, agent.lastEventAction)} · ${formatTime(agent.lastEventAt)}` : '暂无行动记录']
  ]) {
    const row = document.createElement('div');
    const term = document.createElement('dt');
    term.textContent = label;
    const detail = document.createElement('dd');
    detail.textContent = value;
    row.append(term, detail);
    facts.append(row);
  }
  card.append(facts);

  const goal = document.createElement('div');
  goal.className = 'agent-goal';
  const goalLabel = document.createElement('span');
  goalLabel.textContent = '当前目标';
  const goalText = document.createElement('p');
  goalText.textContent = agent.currentGoal || '尚未设定';
  goal.append(goalLabel, goalText);
  card.append(goal);
  agentPanel.append(card);
}

function renderActivity() {
  if (!activityList || !latestMapData) return;
  activityList.replaceChildren();
  const events = (latestMapData.dataCenterLogs || latestMapData.events || []).slice(0, 100);
  setText(activityCount, `本机记录 · 最近 ${displayCount(events.length)} 条`);
  if (events.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'activity-empty';
    empty.textContent = '还没有可显示的居民行动。';
    activityList.append(empty);
    return;
  }
  for (const event of events) {
    const item = document.createElement('li');
    const icon = document.createElement('span');
    icon.className = 'activity-icon';
    icon.textContent = event.eventType === 'action.travel' ? '↗' : event.eventType === 'action.work' ? '⌘' : '✳';
    const copy = document.createElement('div');
    copy.className = 'activity-copy';
    const title = document.createElement('strong');
    title.textContent = event.agentName || '居民';
    const detail = document.createElement('span');
    const trade = event.eventType === 'crypto.trade_filled' && event.side && event.asset
      ? ` · ${event.side === 'buy' ? '买入' : '卖出'} ${event.asset}` : '';
    detail.textContent = `${eventLabel(event.eventType, event.action)}${trade}${event.place ? ` · ${event.place}` : ''}`;
    copy.append(title, detail);
    const time = document.createElement('time');
    time.dateTime = event.createdAt || '';
    time.textContent = formatTime(event.createdAt, true);
    item.append(icon, copy, time);
    activityList.append(item);
  }
}

function renderSummary() {
  if (!latestMapData) return;
  const residents = latestMapData.residents || [];
  const scenes = latestMapData.scenes || [];
  const women = residents.filter((resident) => resident.gender === 'female').length;
  const men = residents.filter((resident) => resident.gender === 'male').length;
  setText(document.querySelector('#map-resident-total'), displayCount(residents.length));
  setText(document.querySelector('#map-scene-total'), displayCount(scenes.length + 1));
  setText(document.querySelector('#map-gender-count'), `${women} / ${men}`);
  const engine = latestMapData.world?.engine;
  if (engine) {
    const hour = String(engine.hour || 0).padStart(2, '0');
    const minute = String(engine.minute || 0).padStart(2, '0');
    setText(document.querySelector('#world-time'), `${hour}:${minute}`);
    setText(document.querySelector('#world-day'), `SIM DAY ${displayCount(engine.day || 1)}`);
    setText(document.querySelector('#world-engine-state'), engine.running ? 'RUNNING' : 'PAUSED');
    document.querySelector('#world-engine-state')?.classList.toggle('is-offline', !engine.running);
  }
}

function renderTrading() {
  if (!latestMapData?.trading) return;
  const trading = latestMapData.trading;
  marketQuotes?.replaceChildren();
  for (const quote of trading.quotes || []) {
    const row = document.createElement('div');
    row.className = 'market-quote-row';
    const asset = document.createElement('div');
    asset.className = 'market-asset';
    const symbol = document.createElement('strong');
    symbol.textContent = quote.symbol;
    const name = document.createElement('span');
    name.textContent = quote.name;
    asset.append(symbol, name);
    const price = document.createElement('strong');
    price.className = 'market-price';
    price.textContent = `$${Number(quote.priceUsd).toLocaleString('en-US', { minimumFractionDigits: quote.symbol === 'USDC' ? 4 : 2, maximumFractionDigits: quote.symbol === 'USDC' ? 4 : 2 })}`;
    row.append(asset, price);
    marketQuotes?.append(row);
  }
  const robinhood = trading.robinhood || {};
  const scanner = robinhood.scanner || {};
  const chainHeading = document.createElement('p');
  chainHeading.className = 'market-updated';
  chainHeading.textContent = `Robinhood 主网 · Pons V2 · 扫描 ${scanner.healthy ? (scanner.fresh ? '正常' : '数据偏旧') : '不可用'} · 区块 ${scanner.scannedToBlock ?? '—'}`;
  marketQuotes?.append(chainHeading);
  for (const token of (robinhood.tokens || []).slice(0, 8)) {
    const row = document.createElement('div');
    row.className = 'market-quote-row';
    const asset = document.createElement('div');
    asset.className = 'market-asset';
    const symbol = document.createElement('strong');
    symbol.textContent = `0x${String(token.tokenAddress || '').slice(2, 10)}`;
    const status = document.createElement('span');
    status.textContent = token.tradable ? '曲线可模拟交易' : token.graduated ? '已毕业，暂停该曲线成交' : '仅记录';
    asset.append(symbol, status);
    const price = document.createElement('strong');
    price.className = 'market-price';
    const numericPrice = Number(token.priceUsd);
    price.textContent = Number.isFinite(numericPrice) && numericPrice > 0
      ? `$${numericPrice.toLocaleString('en-US', { maximumFractionDigits: 8 })}` : '—';
    row.append(asset, price);
    marketQuotes?.append(row);
  }
  setText(marketUpdated, `内部模拟行情 ${formatTime(trading.quotes?.[0]?.asOf, true)} · BTC / ETH / USDC`);

  portfolioSummary?.replaceChildren();
  const portfolios = [...(trading.portfolios || [])].sort((a, b) => Number(b.netAssetValueUsd) - Number(a.netAssetValueUsd));
  if (!portfolios.length) {
    const empty = document.createElement('p');
    empty.className = 'market-empty';
    empty.textContent = '还没有已初始化的 agent 账户。';
    portfolioSummary?.append(empty);
  }
  for (const portfolio of portfolios) {
    const row = document.createElement('div');
    row.className = 'portfolio-row';
    const agent = document.createElement('span');
    agent.textContent = portfolio.name;
    const value = document.createElement('strong');
    value.textContent = `$${Number(portfolio.netAssetValueUsd).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    row.append(agent, value);
    portfolioSummary?.append(row);
  }

  recentTrades?.replaceChildren();
  const trades = (trading.recentTrades || []).slice(0, 12);
  if (!trades.length) {
    const empty = document.createElement('li');
    empty.className = 'market-empty';
    empty.textContent = 'agent 尚未完成模拟交易。';
    recentTrades?.append(empty);
  }
  for (const trade of trades) {
    const row = document.createElement('li');
    const details = document.createElement('div');
    details.className = 'trade-details';
    const headline = document.createElement('strong');
    headline.textContent = `${trade.agentName} · ${trade.side === 'buy' ? '买入' : '卖出'} ${trade.asset}${trade.simulatedMeme ? ' (模拟)' : ''}`;
    const meta = document.createElement('span');
    const price = Number(trade.priceUsd);
    meta.textContent = trade.simulatedMeme
      ? `${trade.quantity} token · 名义金额 $${Number(trade.notionalUsd).toFixed(4)} · 手续费 ${Number(trade.feeUsdc).toFixed(4)} USDC · Pons V2`
      : `${Number(trade.quantity).toFixed(8)} ${trade.asset} · $${price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} · 手续费 ${Number(trade.feeUsdc).toFixed(4)} USDC`;
    details.append(headline, meta);
    const time = document.createElement('time');
    time.dateTime = trade.createdAt || '';
    time.textContent = formatTime(trade.createdAt, true);
    row.append(details, time);
    recentTrades?.append(row);
  }
}

function renderMapData(data) {
  latestMapData = data;
  const residents = data.residents || [];
  if (!residents.some((resident) => resident.id === selectedAgentId)) selectedAgentId = residents[0]?.id || null;
  renderSummary();
  renderMap();
  world3d?.update(data, selectedAgentId);
  renderAgentPanel(residents.find((resident) => resident.id === selectedAgentId));
  renderActivity();
  renderTrading();
}

async function loadMapData() {
  try {
    const response = await fetch('/local/map-data', { headers: { Accept: 'application/json' }, cache: 'no-store' });
    if (!response.ok) throw new Error(`Map request failed (${response.status})`);
    const data = await response.json();
    if (!data.world) throw new Error('No open world');
    renderMapData(data);
    mapError.hidden = true;
    mapStatusDot.classList.remove('is-error');
    setText(mapState, '本机实时快照');
    setText(mapUpdated, `更新于 ${formatTime(data.generatedAt)}`);
  } catch {
    mapStatusDot.classList.add('is-error');
    setText(mapState, latestMapData ? '更新失败 · 显示上次快照' : '地图数据暂不可用');
    setText(mapUpdated, latestMapData ? `上次更新 ${formatTime(latestMapData.generatedAt)}` : '尚未取得数据');
    mapError.hidden = false;
    mapError.textContent = '地图只在运行 Synterra 的本机打开。请检查服务是否在线，并使用 http://127.0.0.1:8788/#map 访问。';
  }
}

loadStats();
loadMapData();
window.setInterval(() => {
  if (document.visibilityState === 'visible') {
    loadMapData();
  }
}, 2_000);
window.setInterval(() => { if (document.visibilityState === 'visible') loadStats(); }, 30_000);

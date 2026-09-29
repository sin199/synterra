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
const numberFormat = new Intl.NumberFormat('zh-CN');
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
  'action.rest': '休息', 'action.eat': '进食', 'action.build_scene': '建造场景', 'scene.created': '场景建造'
};
let latestMapData = null;
let selectedAgentId = null;

function displayCount(value) {
  const number = Number(value);
  return numberFormat.format(Number.isFinite(number) && number >= 0 ? number : 0);
}

function setText(element, value) {
  if (element) element.textContent = value;
}

function formatTime(value, includeDate = false) {
  if (!value) return '暂无记录';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '时间未知';
  return new Intl.DateTimeFormat('zh-CN', includeDate
    ? { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }
    : { hour: '2-digit', minute: '2-digit' }).format(date);
}

function eventLabel(eventType) {
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
    selectedAgentId = agent.id;
    renderMap();
    renderAgentPanel(agent);
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

  const unplaced = residents.filter((resident) => !scenes.some((scene) => scene.name === resident.location));
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
  for (const [label, value] of [
    ['所在地点', agent.location || '未知'],
    ['行动次数', displayCount(agent.actionsTaken)],
    ['最近行动', agent.lastEventType ? `${eventLabel(agent.lastEventType)} · ${formatTime(agent.lastEventAt)}` : '暂无行动记录']
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
    detail.textContent = `${eventLabel(event.eventType)}${event.place ? ` · ${event.place}` : ''}`;
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
  setText(document.querySelector('#map-scene-total'), displayCount(scenes.length));
  setText(document.querySelector('#map-gender-count'), `${women} / ${men}`);
}

function renderMapData(data) {
  latestMapData = data;
  const residents = data.residents || [];
  if (!residents.some((resident) => resident.id === selectedAgentId)) selectedAgentId = residents[0]?.id || null;
  renderSummary();
  renderMap();
  renderAgentPanel(residents.find((resident) => resident.id === selectedAgentId));
  renderActivity();
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
    loadStats();
    loadMapData();
  }
}, 30_000);

import { createWorld3D } from './world3d.js';
import { formatV6LifecycleObserverStatus } from './v6-observer-status.js';

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
const evolutionStats = document.querySelector('#world-evolution-stats');
const opportunityList = document.querySelector('#world-opportunity-list');
const projectList = document.querySelector('#world-project-list');
const organizationList = document.querySelector('#world-organization-list');
const institutionsList = document.querySelector('#world-institutions-list');
const worldV6LifecycleSummary = document.querySelector('#world-v6-lifecycle-summary');
const worldV6LifecycleObserverStatus = document.querySelector('#world-v6-lifecycle-observer-status');
const worldV6LifecycleStats = document.querySelector('#world-v6-lifecycle-stats');
const worldV6LifecycleGapsList = document.querySelector('#world-v6-lifecycle-gaps-list');
const worldV6LifecycleIntegrityList = document.querySelector('#world-v6-lifecycle-integrity-list');
const worldEpochSummary = document.querySelector('#world-epoch-summary');
const worldV7Summary = document.querySelector('#world-v7-summary');
const worldV7Stats = document.querySelector('#world-v7-stats');
const worldV7QuestionsList = document.querySelector('#world-v7-questions-list');
const worldV7ConceptsList = document.querySelector('#world-v7-concepts-list');
const worldV7EntitiesList = document.querySelector('#world-v7-entities-list');
const worldV7PolicyList = document.querySelector('#world-v7-policy-list');
const worldV7ExtensionsList = document.querySelector('#world-v7-extensions-list');
const worldV7GenealogyList = document.querySelector('#world-v7-genealogy-list');
const worldV7InterpretationsList = document.querySelector('#world-v7-interpretations-list');
const worldV7ResourcesList = document.querySelector('#world-v7-resources-list');
const worldV7ResourceLedgerList = document.querySelector('#world-v7-resource-ledger-list');
const worldV7CoordinationList = document.querySelector('#world-v7-coordination-list');
const worldV7CoordinationUsesList = document.querySelector('#world-v7-coordination-uses-list');
const worldV7ObservationUsesList = document.querySelector('#world-v7-observation-uses-list');
const worldCapabilityCounts = document.querySelector('#world-capability-counts');
const capabilityActiveList = document.querySelector('#world-capability-active-list');
const capabilityExperimentalList = document.querySelector('#world-capability-experimental-list');
const capabilityProposalList = document.querySelector('#world-capability-proposal-list');
const capabilityAdoptedList = document.querySelector('#world-capability-adopted-list');
const capabilityRejectedList = document.querySelector('#world-capability-rejected-list');
const capabilityDeprecatedList = document.querySelector('#world-capability-deprecated-list');
const capabilityEventList = document.querySelector('#world-capability-event-list');
const businessList = document.querySelector('#world-business-list');
const economicDemandList = document.querySelector('#world-economic-demand-list');
const historyList = document.querySelector('#world-history-list');
const emergenceCountsList = document.querySelector('#world-emergence-counts');
const emergenceBlockersList = document.querySelector('#world-emergence-blockers');
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
const ROLE_LABELS = { researcher: '研究者', engineer: '工程师', trader: '交易者', worker: '建设者', socialite: '社交者', generalist: '通才' };
const GOAL_LABELS = { BUILD_WEALTH: '积累财富', MASTER_TRADING: '精通交易', MASTER_RESEARCH: '精通研究',
  MASTER_ENGINEERING: '精通工程', BUILD_RELATIONSHIPS: '建立关系', BALANCED_LIFE: '平衡生活' };
const SKILL_LABELS = { trading: '交易', research: '研究', engineering: '工程', social: '社交' };
const EVENT_LABELS = {
  'action.socialize': '社交', 'action.travel': '前往场景', 'action.work': '工作',
  'action.rest': '休息', 'action.eat': '进食', 'action.build_scene': '建造场景', 'scene.created': '场景建造',
  'crypto.trade_filled': '模拟加密货币成交', 'crypto.trade_held': '选择持有',
  'crypto.robinhood_paper_filled': 'Robinhood meme 币模拟成交',
  'world.movement_started': '启程', 'world.agent_arrived': '抵达', 'world.action_started': '开始行动',
  'world.action_completed': '完成行动', 'world.goal_updated': '调整长期目标',
  'world.project_proposed': '发起项目', 'world.project_contribution': '项目贡献',
  'world.project_completed': '项目完成', 'world.project_failed': '项目失败',
  'world.organization_founded': '成立组织', 'world.organization_invited': '组织邀请',
  'world.organization_membership_decided': '组织成员变更', 'world.information_shared': '分享信息',
  'world.information_accepted': '采纳信息', 'world.information_doubted': '质疑信息',
  'world.information_ignored': '忽略信息'
};
const ACTION_LABELS = { work: '工作', cooperate: '合作工作', learn: '学习', rest: '休息', eat: '进食', socialize: '社交', trade: '模拟交易',
  opportunity: '参与机会', opportunity_reject: '拒绝机会', opportunity_propose: '发起机会', project_propose: '发起项目', project_join: '加入项目',
  project_reject: '拒绝项目', project_contribute: '项目贡献', project_leave: '退出项目', organization_found: '成立组织',
  organization_join: '加入组织', organization_reject: '拒绝组织邀请', organization_leave: '退出组织',
  organization_invite: '邀请成员', organization_contribute: '组织贡献', information_share: '分享信息',
  information_accept: '采纳信息', information_ignore: '忽略信息', information_doubt: '质疑信息' };
let latestMapData = null;
let selectedAgentId = null;
let selectedResidentDetail = null;
let detailRequestToken = 0;
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
  selectedResidentDetail = null;
  renderMap();
  renderAgentPanel(agent, null);
  loadResidentDetail(agentId);
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

function sceneMapPoint(scene, index) {
  const x = Number(scene.position?.x), z = Number(scene.position?.z);
  if (Number.isFinite(x) && Number.isFinite(z) && Math.hypot(x, z) >= 0.2) {
    return [Math.max(7, Math.min(93, 50 + x * 45)), Math.max(7, Math.min(93, 50 + z * 43))];
  }
  return MAP_POINTS[index % MAP_POINTS.length];
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
    const [left, top] = sceneMapPoint(scene, index);
    const node = document.createElement('div');
    node.className = 'map-location';
    node.dataset.sceneType = scene.sceneType || 'commons';
    node.style.left = `${left}%`;
    node.style.top = `${top}%`;
    node.setAttribute('role', 'group');
    node.setAttribute('aria-label', `${scene.name}，${displayCount(scene.residentCount)} 位居民`);
    node.title = scene.purpose || scene.description || scene.name;

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

function renderAgentPanel(agent, detail = selectedResidentDetail) {
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
  subtitle.textContent = `${agent.gender === 'female' ? '女' : agent.gender === 'male' ? '男' : '未设定'} · ${ROLE_LABELS[agent.dominantRole] || ARCHETYPES[agent.archetype] || '尚无类型'}`;
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

  const economy = detail?.economy;
  const economicSection = document.createElement('section');
  economicSection.className = 'agent-social-section';
  const economicHeading = document.createElement('h4');
  economicHeading.textContent = '模拟经济与所有权';
  const economicList = document.createElement('ul');
  economicList.className = 'agent-memory-list';
  if (!economy) {
    const item = document.createElement('li');
    item.className = 'agent-social-empty';
    item.textContent = '正在读取经济账本…';
    economicList.append(item);
  } else {
    const entries = [
      `模拟净值 $${Number(economy.netWorthUsd || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
      `余额 ${(economy.balances || []).map((row) => `${row.asset} ${row.balance}`).join(' · ') || '尚无经济账户'}`,
      ...(economy.employment || []).map((job) => `就业 ${job.businessName} · ${job.role} · ${job.wageUsdc} USDC/班`),
      ...(economy.ownership || []).map((holding) => `持有 ${holding.name} · ${Math.round(Number(holding.share) * 10000) / 100}% · ${holding.assetType}`),
      ...(economy.recentTransactions || []).slice(0, 5).map((tx) => `${tx.flow === 'income' ? '收入' : '支出'} ${tx.amount} ${tx.asset} · ${tx.type} · 第 ${Math.floor(Number(tx.worldTime) / 1440) + 1} 天`),
      ...(economy.recentPurchases || []).slice(0, 3).map((purchase) => `购买 ${purchase.serviceName} · ${purchase.businessName} · ${purchase.priceUsdc} USDC`)
    ];
    for (const text of entries.length ? entries : ['尚无收入、就业、投资或购买记录']) {
      const item = document.createElement('li');
      item.textContent = text;
      economicList.append(item);
    }
  }
  economicSection.append(economicHeading, economicList);
  card.append(economicSection);

  const institutionSection = document.createElement('section');
  institutionSection.className = 'agent-social-section';
  const institutionHeading = document.createElement('h4');
  institutionHeading.textContent = '协商、承诺与信誉';
  const institutionList = document.createElement('ul');
  institutionList.className = 'agent-memory-list';
  const institutionState = detail?.institutions;
  const reputation = institutionState?.reputation;
  const institutionRows = [
    ...(reputation ? [`信誉 · 履约 ${Number(reputation.reliability).toFixed(1)} · 专业 ${Number(reputation.professional).toFixed(1)} · 财务 ${Number(reputation.financial).toFixed(1)} · 合作 ${Number(reputation.cooperation).toFixed(1)} · 完成 ${displayCount(reputation.fulfilledCount)} / 违约 ${displayCount(reputation.breachCount)}`] : []),
    ...(institutionState?.organizationRoles || []).map((role) => `组织 · ${role.name} · ${role.role} · ${role.governanceMode}`),
    ...(institutionState?.agreements || []).slice(0, 6).map((agreement) =>
      `协议 · ${agreement.type} · ${agreement.status} · 与 ${agreement.otherName} · 第 ${agreement.round} 轮`),
    ...(institutionState?.commitments || []).filter((commitment) => commitment.status === 'active').slice(0, 4).map((commitment) =>
      `承诺 · ${commitment.type} · ${commitment.description} · ${commitment.status}`),
    ...(institutionState?.recentNegotiations || []).slice(0, 3).map((item) =>
      `历史 · ${item.title} · 第 ${displayCount(item.worldTime)} 世界分钟`)
  ];
  for (const text of institutionRows.length ? institutionRows : [detail ? '还没有协议、承诺或信誉记录' : '正在读取制度状态…']) {
    const item = document.createElement('li');
    item.textContent = text;
    institutionList.append(item);
  }
  institutionSection.append(institutionHeading, institutionList);
  card.append(institutionSection);

  const goal = document.createElement('div');
  goal.className = 'agent-goal';
  const goalLabel = document.createElement('span');
  goalLabel.textContent = '长期目标';
  const goalText = document.createElement('p');
  const goalProgress = Math.max(0, Math.min(100, Number(agent.goalProgress) || 0));
  goalText.textContent = `${GOAL_LABELS[agent.primaryGoal] || detail?.resident?.primaryGoalDescription || agent.primaryGoal || '平衡生活'} · ${Math.round(goalProgress)}%`;
  goal.append(goalLabel, goalText);
  const goalDescription = document.createElement('small');
  goalDescription.textContent = detail?.resident?.currentIntent || agent.currentGoal || '持续依据居民经历推进';
  goal.append(goalDescription);
  card.append(goal);

  const planning = document.createElement('section');
  planning.className = 'agent-social-section';
  const planningHeading = document.createElement('h4');
  planningHeading.textContent = '长期与短期规划';
  const planningList = document.createElement('ul');
  planningList.className = 'agent-memory-list';
  for (const item of (detail?.goals || []).filter((goalItem) => goalItem.goalType !== 'primary')) {
    const row = document.createElement('li');
    row.textContent = `${item.goalType === 'short' ? '短期' : '次级'} · ${item.description} · ${Math.round(Number(item.progress) || 0)}%`;
    planningList.append(row);
  }
  if (!planningList.children.length) {
    const item = document.createElement('li');
    item.className = 'agent-social-empty';
    item.textContent = detail ? '暂无子目标' : '正在读取目标…';
    planningList.append(item);
  }
  planning.append(planningHeading, planningList);
  card.append(planning);

  const v7 = detail?.v7;
  const selfSection = document.createElement('section');
  selfSection.className = 'agent-social-section';
  const selfHeading = document.createElement('h4');
  selfHeading.textContent = 'V7 · 自我模型与开放问题';
  const selfList = document.createElement('ul');
  selfList.className = 'agent-memory-list';
  if (v7?.selfModel) {
    const identity = document.createElement('li');
    identity.textContent = `${v7.selfModel.identitySummary} · 信心 ${Math.round(Number(v7.selfModel.confidence || 0) * 100)}% · 认知偏好 ${v7.selfModel.preferredCognitionMode || 'substrate'}`;
    selfList.append(identity);
    for (const question of (v7.questions || []).slice(0, 4)) {
      const item = document.createElement('li');
      item.textContent = `问题 · ${question.status} · ${question.question}`;
      selfList.append(item);
    }
    for (const concept of (v7.concepts || []).slice(0, 3)) {
      const item = document.createElement('li');
      item.textContent = `概念 · ${concept.name} · ${concept.status} · 使用 ${displayCount(concept.usageCount)} 次`;
      selfList.append(item);
    }
    for (const experiment of (v7.policyExperiments || []).slice(0, 3)) {
      const item = document.createElement('li');
      item.textContent = `策略实验 · ${experiment.status} · ${experiment.reason} · ${experiment.result?.decision || '等待评估'}`;
      selfList.append(item);
    }
    for (const value of (v7.values || []).slice(0, 3)) {
      const item = document.createElement('li');
      item.textContent = `价值 · ${value.name} · 重要性 ${Math.round(Number(value.importance || 0) * 100)}% · ${value.description}`;
      selfList.append(item);
    }
    for (const request of (v7.extensionRequests || []).slice(0, 2)) {
      const item = document.createElement('li');
      item.textContent = `扩展请求 · ${request.status} · ${request.title}`;
      selfList.append(item);
    }
    for (const method of (v7.observationMethods || []).slice(0, 2)) {
      const item = document.createElement('li');
      item.textContent = `观察方式 · ${method.status} · ${method.name}`;
      selfList.append(item);
    }
    for (const observation of (v7.observationUses || []).slice(0, 2)) {
      const item = document.createElement('li');
      item.textContent = `观察记录 · ${observation.methodName} · ${observation.observation}`;
      selfList.append(item);
    }
    for (const entity of (v7.emergentEntities || []).slice(0, 3)) {
      const item = document.createElement('li');
      item.textContent = `涌现实体 · ${entity.entityType} · ${entity.name} · ${entity.participationMode || '发起者'} (${entity.participationStatus || entity.status})`;
      selfList.append(item);
    }
    for (const mechanism of (v7.coordination || []).slice(0, 2)) {
      const item = document.createElement('li');
      item.textContent = `协调机制 · ${mechanism.mechanismType} · ${mechanism.status} · 使用 ${displayCount(mechanism.usageCount)} 次`;
      selfList.append(item);
    }
    for (const resource of (v7.resources || []).slice(0, 2)) {
      const item = document.createElement('li');
      item.textContent = `自创资源 · ${resource.resourceKey} · ${resource.status} · 使用 ${displayCount(resource.usageCount)} 次`;
      selfList.append(item);
    }
    for (const capability of [...(v7.capabilitiesCreated || []).slice(0, 3), ...(v7.capabilitiesUsed || []).slice(0, 3)]) {
      const item = document.createElement('li');
      item.textContent = `${v7.capabilitiesCreated?.some((created) => created.id === capability.id) ? '我创建' : '我使用'}的能力 · ${capability.name} · ${capability.creatorType || capability.status}`;
      selfList.append(item);
    }
  }
  if (!selfList.children.length) {
    const item = document.createElement('li');
    item.className = 'agent-social-empty';
    item.textContent = detail ? '尚无 V7 自我反思记录；稳定或暂不改变也是有效状态' : '正在读取居民的自我模型…';
    selfList.append(item);
  }
  selfSection.append(selfHeading, selfList);
  card.append(selfSection);

  const personality = document.createElement('section');
  personality.className = 'agent-social-section';
  const personalityHeading = document.createElement('h4');
  personalityHeading.textContent = '人格与适应';
  const personalityList = document.createElement('ul');
  personalityList.className = 'agent-memory-list';
  const modifiers = detail?.resident?.personalityModifiers || {};
  const effectiveTraits = [
    ['社交', 'sociability'], ['好奇', 'curiosity'], ['自律', 'discipline'], ['进取', 'ambition']
  ].map(([label, key]) => `${label} ${Math.round(Math.max(0, Math.min(1, Number(agent[key] || detail?.resident?.[key] || 0.5) + Number(modifiers[key] || 0))) * 100)}`);
  const traitItem = document.createElement('li');
  traitItem.textContent = `${effectiveTraits.join(' · ')} · 价格敏感 ${Math.round(Number(detail?.resident?.priceSensitivity ?? agent.priceSensitivity ?? 0.5) * 100)}% · 风险适应 ${Math.round(Number(agent.riskTolerance || 0) * 100)}%`;
  personalityList.append(traitItem);
  const reflectionItem = document.createElement('li');
  reflectionItem.textContent = detail?.reflections?.[0]
    ? `最近反思：世界时间 ${displayCount(detail.reflections[0].worldMinutes)} · ${detail.reflections[0].trigger === 'important_event' ? '重要经历触发' : '周期复盘'}`
    : detail ? '尚无反思记录' : '正在读取反思…';
  personalityList.append(reflectionItem);
  personality.append(personalityHeading, personalityList);
  card.append(personality);

  const detailSkills = detail?.skills?.length
    ? detail.skills : Object.entries(agent.skills || {}).map(([skill, value]) => ({ skill, value }));
  const skillsSection = document.createElement('section');
  skillsSection.className = 'agent-social-section';
  const skillsHeading = document.createElement('h4');
  skillsHeading.textContent = '技能';
  const skillsList = document.createElement('div');
  skillsList.className = 'agent-skill-list';
  for (const skill of detailSkills) {
    const row = document.createElement('div');
    row.className = 'agent-skill-row';
    const name = document.createElement('span');
    name.textContent = SKILL_LABELS[skill.skill] || skill.skill;
    const meter = document.createElement('progress');
    meter.max = 100;
    meter.value = Math.max(0, Math.min(100, Number(skill.value) || 0));
    meter.setAttribute('aria-label', `${name.textContent} ${Math.round(meter.value)}`);
    const value = document.createElement('strong');
    value.textContent = String(Math.round(meter.value));
    row.append(name, meter, value);
    skillsList.append(row);
  }
  if (!detailSkills.length) {
    const placeholder = document.createElement('p');
    placeholder.className = 'agent-social-empty';
    placeholder.textContent = '正在读取技能记录…';
    skillsList.append(placeholder);
  }
  skillsSection.append(skillsHeading, skillsList);
  card.append(skillsSection);

  const relationshipsSection = document.createElement('section');
  relationshipsSection.className = 'agent-social-section';
  const relationshipsHeading = document.createElement('h4');
  relationshipsHeading.textContent = '关系';
  const relationshipsList = document.createElement('ul');
  relationshipsList.className = 'agent-memory-list';
  for (const relation of detail?.relationships || []) {
    const item = document.createElement('li');
    item.textContent = `${relation.name} · 熟悉 ${Math.round(Number(relation.familiarity) || 0)} · 信任 ${Math.round(Number(relation.trust) || 0)}`;
    relationshipsList.append(item);
  }
  if (!relationshipsList.children.length) {
    const item = document.createElement('li');
    item.className = 'agent-social-empty';
    item.textContent = detail ? '还没有形成关系' : '正在读取关系记录…';
    relationshipsList.append(item);
  }
  relationshipsSection.append(relationshipsHeading, relationshipsList);
  card.append(relationshipsSection);

  const beliefsSection = document.createElement('section');
  beliefsSection.className = 'agent-social-section';
  const beliefsHeading = document.createElement('h4');
  beliefsHeading.textContent = '个人经验与创新判断';
  const beliefsList = document.createElement('ul');
  beliefsList.className = 'agent-memory-list';
  for (const belief of (detail?.beliefs || []).slice(0, 6)) {
    const item = document.createElement('li');
    const estimate = Number(belief.estimate) || 0;
    item.textContent = `${belief.subjectKey} · ${estimate >= 0 ? '偏正向' : '偏负向'} ${Math.round(Math.abs(estimate) * 100)}% · 置信 ${Math.round(Number(belief.confidence) * 100)}% · ${displayCount(belief.sampleCount)} 次经历`;
    beliefsList.append(item);
  }
  if (!beliefsList.children.length) {
    const item = document.createElement('li');
    item.className = 'agent-social-empty';
    item.textContent = detail ? '还在积累个人判断' : '正在读取经验判断…';
    beliefsList.append(item);
  }
  beliefsSection.append(beliefsHeading, beliefsList);
  card.append(beliefsSection);

  const decisionsSection = document.createElement('section');
  decisionsSection.className = 'agent-social-section';
  const decisionsHeading = document.createElement('h4');
  decisionsHeading.textContent = '最近决策';
  const decisionsList = document.createElement('ul');
  decisionsList.className = 'agent-memory-list';
  for (const decision of (detail?.decisions || []).slice(0, 4)) {
    const item = document.createElement('li');
    const probability = Math.round(Number(decision.probability || 0) * 100);
    item.textContent = `${ACTION_LABELS[decision.action] || decision.action} · 行为概率 ${probability}% · ${decision.rationale?.selectedGoal || decision.candidateId}`;
    decisionsList.append(item);
  }
  if (!decisionsList.children.length) {
    const item = document.createElement('li');
    item.className = 'agent-social-empty';
    item.textContent = detail ? '还没有决策记录' : '正在读取决策记录…';
    decisionsList.append(item);
  }
  decisionsSection.append(decisionsHeading, decisionsList);
  card.append(decisionsSection);

  const capabilitySection = document.createElement('section');
  capabilitySection.className = 'agent-social-section';
  const capabilityHeading = document.createElement('h4');
  capabilityHeading.textContent = '能力提案、评议与使用';
  const capabilityList = document.createElement('ul');
  capabilityList.className = 'agent-memory-list';
  const capabilityHistoryLabels = { proposal: '我提出', review: '我评议', use: '我参与使用' };
  for (const entry of (detail?.capabilityHistory || []).slice(0, 8)) {
    const item = document.createElement('li');
    const status = ({ proposed: '待评议', reviewed: '已评议', revised: '已修订', adopted: '已采纳',
      rejected: '已拒绝', abandoned: '已放弃', support: '支持', oppose: '反对', modify: '建议修改',
      ignore: '未表态', completed: '完成', failed: '失败' })[entry.status] || entry.status;
    item.textContent = `${capabilityHistoryLabels[entry.kind] || entry.kind} · ${entry.title} · ${status} · 第 ${displayCount(entry.worldMinute)} 世界分钟 · ${String(entry.detail || '').slice(0, 140)}`;
    capabilityList.append(item);
  }
  if (!capabilityList.children.length) {
    const item = document.createElement('li');
    item.className = 'agent-social-empty';
    item.textContent = detail ? '还没有能力提案、评议或使用记录' : '正在读取能力历史…';
    capabilityList.append(item);
  }
  capabilitySection.append(capabilityHeading, capabilityList);
  card.append(capabilitySection);

  const memoriesSection = document.createElement('section');
  memoriesSection.className = 'agent-social-section';
  const memoriesHeading = document.createElement('h4');
  memoriesHeading.textContent = '近期记忆';
  const memoriesList = document.createElement('ul');
  memoriesList.className = 'agent-memory-list';
  for (const memory of detail?.recentMemories || []) {
    const item = document.createElement('li');
    item.textContent = `${memory.summary}${memory.longTerm ? ' · 重要' : ''}`;
    memoriesList.append(item);
  }
  if (!memoriesList.children.length) {
    const item = document.createElement('li');
    item.className = 'agent-social-empty';
    item.textContent = detail ? '还没有近期记忆' : '正在读取记忆记录…';
    memoriesList.append(item);
  }
  memoriesSection.append(memoriesHeading, memoriesList);
  card.append(memoriesSection);
  agentPanel.append(card);
}

async function loadResidentDetail(agentId = selectedAgentId) {
  if (!agentId) return;
  const token = ++detailRequestToken;
  try {
    const response = await fetch(`/local/map-data/residents/${encodeURIComponent(agentId)}`, {
      headers: { Accept: 'application/json' }, cache: 'no-store'
    });
    if (!response.ok) throw new Error(`Resident detail request failed (${response.status})`);
    const detail = await response.json();
    if (token !== detailRequestToken || selectedAgentId !== agentId) return;
    selectedResidentDetail = detail;
    const agent = latestMapData?.residents?.find((resident) => resident.id === agentId);
    if (agent) renderAgentPanel(agent, detail);
  } catch {
    if (token !== detailRequestToken || selectedAgentId !== agentId) return;
    const agent = latestMapData?.residents?.find((resident) => resident.id === agentId);
    if (agent) renderAgentPanel(agent, null);
  }
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

function renderEvolutionList(container, entries, emptyText, describe) {
  if (!container) return;
  container.replaceChildren();
  if (!entries?.length) {
    const empty = document.createElement('li');
    empty.className = 'world-evolution-empty';
    empty.textContent = emptyText;
    container.append(empty);
    return;
  }
  for (const entry of entries) {
    const row = document.createElement('li');
    const heading = document.createElement('strong');
    heading.textContent = entry.title || entry.name || entry.eventType || '世界记录';
    const detail = document.createElement('span');
    detail.textContent = describe(entry);
    row.append(heading, detail);
    container.append(row);
  }
}

function renderWorldEvolution() {
  const evolution = latestMapData?.worldEvolution;
  if (!evolution) return;
  const dashboard = evolution.dashboard || {};
  const recovery = evolution.economy?.recovery || {};
  const v6Lifecycle = evolution.v6Lifecycle || {};
  evolutionStats?.replaceChildren();
  for (const [label, value] of [
    ['居民', displayCount(dashboard.residents)], ['地点', displayCount(dashboard.places)],
    ['活跃项目', displayCount(dashboard.activeProjects)], ['组织', displayCount(dashboard.organizations)],
    ['开放机会', displayCount(dashboard.activeOpportunities)], ['已完成项目', displayCount(dashboard.completedProjects)],
    ['世界年龄', `${displayCount(dashboard.worldAgeDays)} 天`],
    ['模拟资产', `$${Number(dashboard.totalSimulatedWealthUsd || 0).toLocaleString('en-US', { maximumFractionDigits: 2 })}`],
    ['内部单位净额', Number(dashboard.totalInternalUnits || 0).toLocaleString('zh-CN', { maximumFractionDigits: 2 })],
    ['居民 USDC 流通', `${Number(evolution.economy?.dashboard?.usdc_circulation || 0).toLocaleString('en-US', { maximumFractionDigits: 2 })} USDC`],
    ['在营企业', displayCount(evolution.economy?.dashboard?.active_businesses)],
    ['就业关系', displayCount(evolution.economy?.dashboard?.employment_count)],
    ['企业累计收入', `${Number(evolution.economy?.dashboard?.business_revenue || 0).toLocaleString('en-US', { maximumFractionDigits: 2 })} USDC`],
    ['企业盈亏', `${Number(evolution.economy?.dashboard?.business_profit_loss || 0).toLocaleString('en-US', { maximumFractionDigits: 2 })} USDC`],
    ['模拟投资额', `${Number(evolution.economy?.dashboard?.investment_volume || 0).toLocaleString('en-US', { maximumFractionDigits: 2 })} USDC`],
    ['在营供给（库存单位）', displayCount(recovery.activeSupply)],
    ['持续未满足需求', displayCount(recovery.persistentUnmetDemand)],
    ['恢复候选（7日）', displayCount(recovery.recoveryCandidates)],
    ['符合资格（7日）', displayCount(recovery.recoveryEligible)],
    ['Fruitfly 入选（7日）', displayCount(recovery.recoverySelected)],
    ['候选入选率（7日）', `${Math.round((Number(recovery.economicResponseRate) || 0) * 100)}%`],
    ['恢复行动（7日）', displayCount(recovery.recoveryActions)],
    ['缺货观察（7日）', displayCount(recovery.shortageObservations)],
    ['新生企业（7日）', displayCount(recovery.businessBirths)],
    ['重开企业（7日）', displayCount(recovery.businessReopens)],
    ['新增就业（7日）', displayCount(recovery.employmentEntries)],
    ['违约供应替代（7日）', displayCount(recovery.failedContractReplacements)]
  ]) {
    const item = document.createElement('div');
    item.className = 'world-evolution-stat';
    const amount = document.createElement('strong');
    amount.textContent = value;
    const name = document.createElement('span');
    name.textContent = label;
    item.append(amount, name);
    evolutionStats?.append(item);
  }
  renderEvolutionList(opportunityList, evolution.opportunities, '目前没有开放机会。', (item) => {
    const type = item.type || '任务';
    const place = item.sceneName ? ` · ${item.sceneName}` : '';
    return `${type} · ${item.acceptedCount || 0}/${item.capacity} 人参与${place}`;
  });
  renderEvolutionList(projectList, evolution.projects, '居民还没有发起项目。', (item) => {
    const status = ({ idea: '构想', proposed: '提案', recruiting: '招募中', active: '进行中',
      completed: '已完成', failed: '失败', abandoned: '已放弃' })[item.status] || item.status;
    const participants = Array.isArray(item.participants) ? item.participants.filter((member) =>
      ['active', 'completed'].includes(member.status)).length : 0;
    return `${status} · ${Math.round(Number(item.progressValue ?? item.progress) || 0)}% · ${participants} 位参与者`;
  });
  renderEvolutionList(organizationList, evolution.organizations, '还没有形成组织。', (item) => {
    const members = (item.members || []).filter((member) => member.status === 'active').length;
    const projects = (item.projects || []).length;
    return `${item.status === 'active' ? '运作中' : item.status === 'dormant' ? '休眠' : '组建中'} · ${members} 位成员 · ${projects} 个项目 · ${item.governance_mode || 'founder_led'}`;
  });
  const institutional = evolution.institutions || {};
  const agreementCounts = institutional.agreements || {};
  const commitmentCounts = institutional.commitments || {};
  const governanceCounts = institutional.governanceProposals || {};
  const institutionRows = [
    { title: '协议与谈判', detail: `提案 ${displayCount(agreementCounts.proposed)} · 反提案 ${displayCount(agreementCounts.countered)} · 履行中 ${displayCount(agreementCounts.active)} · 完成 ${displayCount(agreementCounts.completed)} · 违约 ${displayCount(agreementCounts.breached)}` },
    { title: '未来承诺', detail: `履行中 ${displayCount(commitmentCounts.active)} · 已履行 ${displayCount(commitmentCounts.fulfilled)} · 违约 ${displayCount(commitmentCounts.breached)}` },
    { title: '组织治理', detail: `开放 ${displayCount(governanceCounts.open)} · 执行 ${displayCount(governanceCounts.executed)} · 否决 ${displayCount(governanceCounts.rejected)}` },
    ...(institutional.institutionalBeliefs || []).slice(0, 4).map((belief) => ({
      title: `${belief.institutionType === 'business' ? '企业' : '组织'}对${belief.subjectName || '居民'}的履约判断`,
      detail: `${belief.estimate >= 0 ? '正向' : '负向'} ${Math.round(Math.abs(Number(belief.estimate)) * 100)}% · 信心 ${Math.round(Number(belief.confidence) * 100)}% · ${belief.sampleCount} 次记录`
    })),
    ...(institutional.norms || []).slice(0, 5).map((norm) => ({
      title: `规范 · ${norm.normKey}`,
      detail: `${norm.scopeType} · 信心 ${Math.round(Number(norm.confidence) * 100)}% · 支持 ${norm.supportCount} / 违反 ${norm.violationCount}`
    })),
    ...(institutional.templates || []).slice(0, 3).map((template) => ({
      title: `历史模板 · ${template.templateKey}`,
      detail: `${template.agreementType} · 成功 ${template.successCount} / 样本 ${template.sampleCount}`
    }))
  ];
  const capabilityWorld = evolution.capabilities || {};
  const statusLabels = { active: '有效', experimental: '实验中', proposed: '提案', reviewed: '已评议', revised: '已修订',
    adopted: '已采纳', rejected: '已拒绝', deprecated: '已弃用', abandoned: '已放弃', evaluated: '已评估' };
  const organizationCapabilityExperiments = (capabilityWorld.experiments || []).filter((item) => item.creatorOrganizationName)
    .map((item) => ({ title: `组织实验 · ${item.creatorOrganizationName} · ${item.proposalName}`,
      detail: `${statusLabels[item.status] || item.status} · 范围 ${item.scopeType} · 世界分钟 ${displayCount(item.startedWorldMinute)}` }));
  renderEvolutionList(institutionsList, [...institutionRows, ...organizationCapabilityExperiments],
    '还没有形成制度互动。', (item) => item.detail);
  const v6Counts = v6Lifecycle.counts || {};
  const proposalReviews = v6Lifecycle.reviews?.proposal || {};
  const experimentReviews = v6Lifecycle.reviews?.experiment || {};
  const v6Usage = v6Lifecycle.usage || {};
  const observerStatus = evolution.v6LifecycleObserver;
  if (worldV6LifecycleSummary) worldV6LifecycleSummary.textContent =
    `第 ${displayCount(v6Lifecycle.worldMinute)} 世界分钟 · V6/V7 记录并列读取；ignore / retain_current_approach 按有效自主 no-action 记录。`;
  if (worldV6LifecycleObserverStatus) {
    worldV6LifecycleObserverStatus.textContent = formatV6LifecycleObserverStatus(observerStatus);
    worldV6LifecycleObserverStatus.dataset.state = !observerStatus ? 'unreported'
      : observerStatus.available && observerStatus.running ? observerStatus.lastError ? 'degraded' : 'running' : 'unavailable';
  }
  worldV6LifecycleStats?.replaceChildren();
  for (const [label, value] of [
    ['能力缺口 · 成熟 / 未成熟', `${displayCount(v6Counts.matureGaps)} / ${displayCount(v6Counts.immatureGaps)}`],
    ['累计观察', displayCount(v6Counts.observationCount)],
    ['候选决策周期 / 提案', `${displayCount(v6Counts.candidateCycles)} / ${displayCount(v6Counts.proposals)}`],
    ['有效 no-action', displayCount(v6Counts.validNoAction)],
    ['评议 · 支持 / 反对 / 忽略 / 修订', `${displayCount(proposalReviews.support + experimentReviews.support)} / ${displayCount(proposalReviews.oppose + experimentReviews.oppose)} / ${displayCount(proposalReviews.ignore + experimentReviews.ignore)} / ${displayCount(proposalReviews.revision + experimentReviews.revision)}`],
    ['实验 · 待实验 / 运行 / 完成 / 失败 / 已评估', `${displayCount(v6Lifecycle.experiments?.lifecycleCounts?.proposed)} / ${displayCount(v6Lifecycle.experiments?.lifecycleCounts?.running)} / ${displayCount(v6Lifecycle.experiments?.lifecycleCounts?.completed)} / ${displayCount(v6Lifecycle.experiments?.lifecycleCounts?.failed)} / ${displayCount(v6Lifecycle.experiments?.lifecycleCounts?.evaluated)}`],
    ['采纳能力 / 后续使用', `${displayCount(v6Counts.adoptedCapabilities)} / ${displayCount(v6Usage.postAdoptionUses)}`],
    ['实验使用 · 参与者 / 其他居民', `${displayCount(v6Usage.experimentParticipantUses)} / ${displayCount(v6Usage.experimentNonParticipantUses)}`],
    ['能力依赖深度 / 二阶能力 (V6 / V7)', `${displayCount(v6Lifecycle.genealogy?.maximumDepth)} / ${displayCount(v6Lifecycle.genealogy?.secondOrderCapabilities)} / ${displayCount(v6Lifecycle.genealogy?.v7SecondOrderCapabilities)}`],
    ['Observer 发现', displayCount(v6Lifecycle.integrity?.findings?.length)]
  ]) {
    const item = document.createElement('div');
    item.className = 'world-evolution-stat';
    const amount = document.createElement('strong');
    amount.textContent = value;
    const name = document.createElement('span');
    name.textContent = label;
    item.append(amount, name);
    worldV6LifecycleStats?.append(item);
  }
  const v6FunnelByGap = new Map((v6Lifecycle.proposalFunnel || []).map((item) => [item.gapId, item]));
  const blockerLabels = { needs_repeated_observation: '等待重复观察', minimum_world_age_not_reached: '未到年龄门槛',
    gap_status_stale: '缺口已过期', no_resident_awareness_recorded: '没有居民知情记录',
    no_decision_event_recorded: '没有决策事件', selected_candidate_without_proposal: '选择候选后未生成提案' };
  const v6GapRows = (v6Lifecycle.gaps || []).slice(0, 12).map((gap) => {
    const funnel = v6FunnelByGap.get(gap.id) || {};
    const status = gap.status === 'stale' ? '历史缺口' : gap.mature ? '成熟' : '未成熟';
    const blockers = (funnel.blockers || []).map((blocker) => blockerLabels[blocker] || blocker);
    return { title: `${status} · ${gap.gapKey || gap.id}`,
      detail: `${gap.problemStatement} · 观察 ${displayCount(gap.observationCount)} 次 · 居民知情 ${displayCount(gap.awareResidentCount)} / 组织 ${displayCount(gap.awareOrganizationCount)} · 候选周期 ${displayCount(funnel.candidateCycles)} · 提案 ${displayCount(funnel.proposals?.length)} · 有效 no-action ${displayCount(funnel.validNoAction)}${blockers.length ? ` · 观察到的阻塞：${blockers.join('、')}` : ''}` };
  });
  renderEvolutionList(worldV6LifecycleGapsList, v6GapRows, '当前没有 V6 能力缺口记录。', (item) => item.detail);
  const integrityLabels = { NO_RESIDENT_AWARENESS_RECORDED: '成熟缺口没有居民知情记录',
    NO_DECISION_EVENT_RECORDED: '成熟缺口没有决策事件',
    SELECTED_CANDIDATE_WITHOUT_PROPOSAL: '选择候选后没有对应提案',
    PROPOSAL_PAST_EXPIRY_WITHOUT_NEXT_STATE: '提案过期后仍停在原状态',
    EXPERIMENT_PAST_WINDOW_UNEVALUATED: '实验超过评估窗口仍未评估',
    ADOPTED_CAPABILITY_WITHOUT_POST_ADOPTION_USE: '已采纳能力尚无采纳后的使用记录',
    INVALID_CAPABILITY_DEPENDENCY_REFERENCE: '能力依赖引用缺失',
    CAPABILITY_DEPENDENCY_CYCLE: '能力依赖图存在循环',
    DUPLICATE_TERMINAL_LIFECYCLE_TRANSITION: '检测到重复终态事件' };
  const v6IntegrityRows = (v6Lifecycle.integrity?.findings || []).slice(0, 20).map((finding) => ({
    title: integrityLabels[finding.code] || finding.code,
    detail: `${finding.entityType} ${finding.entityId || ''} · 只读发现；不会自动修复或推进生命周期。`
  }));
  renderEvolutionList(worldV6LifecycleIntegrityList, v6IntegrityRows,
    '目前没有生命周期完整性发现。', (item) => item.detail);
  const epoch = capabilityWorld.epoch;
  if (worldEpochSummary) worldEpochSummary.textContent = epoch
    ? `${epoch.code} · ${epoch.name} · 第 ${Math.max(1, Math.floor(Number(epoch.startedWorldMinute || 0) / 1_440) + 1)} 世界日开始`
    : '尚未记录世界时代';
  const capabilityCounts = capabilityWorld.counts || {};
  if (worldCapabilityCounts) worldCapabilityCounts.textContent = `有效 ${displayCount(capabilityCounts.active)} · 实验 ${displayCount(capabilityCounts.experimental)} · 提案 ${displayCount(capabilityCounts.proposals)} · 弃用 ${displayCount(capabilityCounts.deprecated)} · 缺口 ${displayCount(capabilityCounts.open_gaps)}`;
  const v7 = evolution.v7 || {};
  const v7Counts = v7.counts || {};
  const autonomy = v7.metrics || {};
  if (worldV7Summary) worldV7Summary.textContent = `居民自述与自创结构独立保存；自创能力使用 ${Math.round((Number(autonomy.agentCreatedActionUsageRatio) || 0) * 100)}% · 依赖深度 ${displayCount(autonomy.capabilityDependencyDepth)} · 二阶能力 ${displayCount(autonomy.secondOrderCapabilities)}`;
  worldV7Stats?.replaceChildren();
  for (const [label, value] of [
    ['Self model', displayCount(v7Counts.selfModels)], ['开放问题', displayCount(v7Counts.openQuestions)],
    ['自创目标', displayCount(v7Counts.selfGeneratedGoals)], ['概念', displayCount(v7Counts.concepts)],
    ['涌现实体', displayCount(v7Counts.emergentEntities)], ['策略实验', displayCount(v7Counts.policyExperiments)],
    ['扩展请求', displayCount(v7Counts.extensionRequests)],
    ['自创能力占比', `${Math.round((Number(autonomy.agentCreatedCapabilityRatio) || 0) * 100)}%`],
    ['自创行动使用占比', `${Math.round((Number(autonomy.agentCreatedActionUsageRatio) || 0) * 100)}%`],
    ['自生成目标占比', `${Math.round((Number(autonomy.agentGeneratedGoalRatio) || 0) * 100)}%`],
    ['自修改策略使用占比', `${Math.round((Number(autonomy.selfModifiedPolicyUsage) || 0) * 100)}%`],
    ['协调机制实验', displayCount(v7Counts.coordinationExperiments)],
    ['协调机制使用', displayCount(v7Counts.coordinationUses)],
    ['资源账本记录', displayCount(v7Counts.resourceLedgerEntries)],
    ['实际观察记录', displayCount(v7Counts.observationMethodUses)],
    ['共享价值', displayCount(v7Counts.sharedValues)],
    ['Agent 自创资源占比', `${Math.round((Number(autonomy.agentCreatedResourceTypeRatio) || 0) * 100)}%`],
    ['开发者种子依赖占比', `${Math.round((Number(autonomy.developerSeededDependencyRatio) || 0) * 100)}%`]
  ]) {
    const item = document.createElement('div');
    item.className = 'world-evolution-stat';
    const amount = document.createElement('strong');
    amount.textContent = value;
    const name = document.createElement('span');
    name.textContent = label;
    item.append(amount, name);
    worldV7Stats?.append(item);
  }
  renderEvolutionList(worldV7QuestionsList, v7.questions, '居民目前没有记录开放问题。', (item) =>
    `${item.creatorName || '居民'} · ${item.status} · 信心 ${Math.round(Number(item.confidence || 0) * 100)}% · ${item.question}`);
  renderEvolutionList(worldV7ConceptsList, v7.concepts, '居民目前没有提出新概念。', (item) =>
    `${item.status} · ${item.creatorName || '居民'} · 使用 ${displayCount(item.usageCount)} 次 · ${item.definition}`);
  renderEvolutionList(worldV7EntitiesList, v7.entities, '居民目前没有创建涌现实体。', (item) => {
    const active = (item.participants || []).filter((participant) => participant.status === 'active').length;
    const modes = (item.participants || []).map((participant) => participant.mode).filter(Boolean).join('、');
    return `${item.entityType} · ${item.status} · ${active} 个参与者 · ${modes || '尚无参与方式'} · ${item.purpose}`;
  });
  renderEvolutionList(worldV7PolicyList, v7.policyExperiments, '居民目前没有策略实验。', (item) =>
    `${item.status} · ${item.reason} · ${item.result?.decision || '等待证据'}`);
  renderEvolutionList(worldV7ResourcesList, v7.resourceTypes, '居民目前没有提出新的内部资源。', (item) =>
    `${item.resourceKey} · ${item.status} · ${item.usageCount} 次账本使用 · 用途 ${Array.isArray(item.permittedUses) ? item.permittedUses.join('、') : '未列出'}`);
  renderEvolutionList(worldV7ResourceLedgerList, v7.resourceLedger, '内部资源尚无来源、用途和结算记录。', (item) =>
    `${item.transactionType} ${item.amount} · ${item.source} · ${item.purpose} · ${item.fromHolderType} → ${item.toHolderType}`);
  renderEvolutionList(worldV7CoordinationList, v7.coordinationMechanisms, '居民尚未提出新的协调机制。', (item) => {
    const experiment = (item.experiments || []).at(-1);
    return `${item.mechanismType} · ${item.status} · 使用 ${displayCount(item.usageCount)} 次 · ${experiment?.status || '未实验'}${experiment?.evaluation?.decision ? ` · ${experiment.evaluation.decision}` : ''} · ${item.description}`;
  });
  renderEvolutionList(worldV7CoordinationUsesList, v7.coordinationUses, '新协调机制尚无实际使用记录。', (item) =>
    `${item.mechanismName} · ${item.result} · ${Array.isArray(item.participants) ? item.participants.length : 0} 个参与者`);
  renderEvolutionList(worldV7ObservationUsesList, v7.observationUses, '居民自创观察方式尚无使用记录。', (item) =>
    `${item.methodName} · ${item.observation}`);
  renderEvolutionList(worldV7ExtensionsList, v7.extensionRequests, '居民目前没有请求扩展世界表达能力。', (item) =>
    `${item.requestType} · ${item.status} · ${item.description}`);
  renderEvolutionList(worldV7GenealogyList, v7.genealogy, '能力依赖图等待居民创建组合能力。', (item) =>
    `深度 ${displayCount(item.depth)} · ${item.creatorType === 'system' ? '基础层' : 'Agent 创建'} · 依赖 ${displayCount(item.dependencies?.length)} 项`);
  const v7Interpretations = [
    ...(v7.values || []).map((item) => ({ title: `价值 · ${item.name}`, detail: `${item.holderType} · 重要性 ${Math.round(Number(item.importance || 0) * 100)}% · ${item.description}` })),
    ...(v7.principles || []).map((item) => ({ title: `原则 · ${item.category}`, detail: `${item.scopeType} · ${item.status} · ${item.statement}` })),
    ...(v7.observationMethods || []).map((item) => ({ title: `观察方式 · ${item.name}`, detail: `${item.status} · ${item.description}` })),
    ...(v7.meanings || []).map((item) => ({ title: `意义 · ${item.subjectType}`, detail: item.interpretation })),
    ...(v7.eras || []).map((item) => ({ title: `居民时代 · ${item.name}`, detail: item.interpretation }))
  ];
  renderEvolutionList(worldV7InterpretationsList, v7Interpretations, '还没有形成居民自述的价值、原则或观察方式。', (item) => item.detail);
  renderEvolutionList(capabilityActiveList, (capabilityWorld.capabilities || []).filter((item) => item.status === 'active').slice(0, 8),
    '当前没有登记有效能力。', (item) => `v${item.version} · ${item.category} · 使用 ${displayCount(item.usageCount)} 次${item.creatorType === 'system' ? ' · 基础能力' : ' · 居民创建'}`);
  renderEvolutionList(capabilityExperimentalList, (capabilityWorld.capabilities || []).filter((item) => item.status === 'experimental').slice(0, 6),
    '当前没有进行中的能力实验。', (item) => `v${item.version} · ${item.category} · ${item.experimentScope?.scopeType || '限定范围'} · ${item.creatorOrganizationName || '居民提案'} · 已使用 ${displayCount(item.usageCount)} 次`);
  const capabilityProposals = capabilityWorld.proposals || [];
  renderEvolutionList(capabilityProposalList, capabilityProposals, '居民还没有提出能力提案。', (item) =>
    `${statusLabels[item.status] || item.status} · ${item.category} · ${item.creatorOrganizationName || item.creatorName || '居民提案'} · 支持 ${displayCount(item.supportCount)} / 反对 ${displayCount(item.oppositionCount)} · ${item.problemStatement}`);
  renderEvolutionList(capabilityAdoptedList, capabilityProposals.filter((item) => item.status === 'adopted').slice(0, 5),
    '还没有能力通过实验评估并采纳。', (item) => `${item.category} · ${item.creatorOrganizationName || item.creatorName || '居民'} · 第 ${displayCount(item.updatedWorldMinute)} 世界分钟`);
  renderEvolutionList(capabilityRejectedList, capabilityProposals.filter((item) => item.status === 'rejected').slice(0, 5),
    '还没有因实验结果而拒绝的能力。', (item) => `${item.category} · ${item.creatorOrganizationName || item.creatorName || '居民'} · 第 ${displayCount(item.updatedWorldMinute)} 世界分钟`);
  renderEvolutionList(capabilityDeprecatedList, (capabilityWorld.capabilities || []).filter((item) => item.status === 'deprecated').slice(0, 5),
    '目前没有已弃用能力。', (item) => `v${item.version} · ${item.category} · 使用 ${displayCount(item.usageCount)} 次`);
  const capabilityEventLabels = { capability_gap_observed: '发现能力缺口', capability_innovation_considered: '评估创新机会',
    capability_proposed: '提出能力', capability_supported: '支持提案', capability_opposed: '反对提案',
    capability_revision_suggested: '建议修订', capability_experiment_started: '启动实验', capability_used: '实际使用能力',
    capability_use_failed: '能力使用失败', capability_proposal_expired: '提案等待超时',
    capability_adopted: '采纳能力', capability_rejected: '拒绝能力', capability_abandoned: '放弃能力',
    capability_deprecated: '弃用能力', capability_revision_created: '形成修订版' };
  renderEvolutionList(capabilityEventList, capabilityWorld.recentEvents || [], '还没有创新事件。', (item) =>
    `${capabilityEventLabels[item.eventType] || item.eventType} · 世界分钟 ${displayCount(item.worldMinute)}${item.details?.name ? ` · ${item.details.name}` : ''}`);
  renderEvolutionList(businessList, evolution.economy?.businesses, '居民还没有创建企业。', (item) => {
    const services = (item.services || []).map((service) => `${service.name} · ${service.stockUnits} 件库存`).join('；');
    const workers = (item.workers || []).length;
    const activeAgreements = (item.agreements || []).filter((agreement) => agreement.status === 'active').length;
    return `${item.status} · 现金 ${item.cashBalance} USDC · 收入 ${item.revenue} · 盈亏 ${item.profitLoss} · ${workers} 名员工 · ${activeAgreements} 份有效协议${services ? ` · ${services}` : ''}`;
  });
  const serviceLabels = { research_service: '研究服务', engineering_service: '工程服务', social_service: '社交服务',
    food_service: '餐饮服务', trading_service: '市场研究' };
  const demandRows = (evolution.economy?.demand || []).filter((item) => Number(item.demandCount) > 0)
    .map((item) => ({ ...item, title: serviceLabels[item.serviceType] || item.serviceType }));
  renderEvolutionList(economicDemandList, demandRows, '今天还没有形成可观察的服务需求。', (item) =>
    `需求 ${item.demandCount} · 供给 ${item.supplyCount} · 未满足 ${item.unmetCount}`);
  renderEvolutionList(historyList, evolution.history, '世界还没有留下重要历史。', (item) =>
    `${item.detail || item.eventType || ''} · 第 ${Math.max(1, Math.floor(Number(item.worldTime || 0) / 1_440) + 1)} 天`);
  const systemLabels = { opportunity: '机会', project: '项目', organization: '组织', information: '信息分享',
    place: '新地点', goal: '目标', business: '经济恢复' };
  const stageLabels = { considered: '已考虑', eligible: '符合资格', blocked: '被阻塞', not_selected: 'Fruitfly 未选',
    fruitfly_selected: 'Fruitfly 已选', created: '已创建', accepted: '已接受', expired: '已过期', proposed: '已提案',
    joined: '已加入', rejected: '已拒绝', active: '进行中', completed: '已完成', failed: '失败', abandoned: '已放弃',
    formed: '已成立', shared: '已分享', ignored: '已忽略', proposal: '建造提案', build_started: '开始建造',
    progress_check: '停滞检查', replanned: '已重规划', progressed: '有进展', doubted: '已质疑' };
  const actionLabels = { opportunity_propose: '发起机会', opportunity: '参与机会', project_propose: '发起项目',
    project_join: '加入项目', project_contribute: '项目投入', organization_found: '发起组织',
    organization_join: '加入组织', information_share: '分享信息', information_accept: '采纳信息',
    goal_review: '目标复盘', business_market_observe: '观察市场缺口', business_found: '创办企业',
    business_reopen: '重开企业', business_seek_cofounder: '寻找合伙人', business_skill_practice: '练习经营技能',
    business_apply: '申请工作', business_work: '企业生产', business_invest: '投资企业', agreement_propose: '提出供应协议' };
  const reasonLabels = { NONE: '无阻塞', UTILITY_BELOW_THRESHOLD: 'Utility 低于门槛', FRUITFLY_NOT_SELECTED: 'Fruitfly 选择了其他候选',
    NO_COMPATIBLE_GOAL: '没有兼容目标', INSUFFICIENT_TRUST: '信任不足', INSUFFICIENT_SHARED_WORK: '共同工作不足',
    NO_PARTNER: '没有合适伙伴', NO_INFORMATION_ASYMMETRY: '没有信息差', NO_SCARCITY: '没有真实短缺',
    SCENE_CONGESTION: '场景拥挤', GOAL_STAGNANT: '目标长期停滞', GOAL_PROGRESSING: '目标仍在推进',
    ENERGY_LOW: '精力不足', FOOD_LOW: '食物不足', CAPACITY: '容量已满', COOLDOWN: '冷却中',
    NO_CAPABILITY: '能力不足', NO_CAPITAL: '资本不足', NO_MARKET_KNOWLEDGE: '尚未观察市场',
    RISK_TOO_HIGH: '风险过高', NO_STRATEGIC_SLOT: '战略候选位已占满', OTHER: '其他阻塞',
    NEEDS_HARD_GATE: '需求硬约束阻止', INCOMPATIBLE_GOALS: '目标不兼容', DEADLINE_PASSED: '项目逾期' };
  const emergence = evolution.emergence || {};
  const counts = (emergence.counts || []).map((item) => ({ ...item,
    title: `${systemLabels[item.system] || item.system} · ${stageLabels[item.stage] || item.stage}`
      + `${item.action ? ` · ${actionLabels[item.action] || item.action}` : ''} · ${item.count}` }));
  const latestDecision = (emergence.recent || []).find((item) => item.stage === 'fruitfly_selected');
  if (latestDecision) counts.unshift({ title: `最近战略选择 · ${latestDecision.action || '—'}`,
    system: latestDecision.system, worldMinutes: latestDecision.worldMinutes });
  renderEvolutionList(emergenceCountsList, counts, '最近 7 个世界日内尚无战略周期记录。', (item) =>
    `${systemLabels[item.system] || item.system}${item.worldMinutes ? ` · 世界分钟 ${item.worldMinutes}` : ''}`);
  const blockers = (emergence.blockedReasons || []).map((item) => ({ ...item,
    title: reasonLabels[item.reasonCode] || item.reasonCode }));
  renderEvolutionList(emergenceBlockersList, blockers, '最近 7 个世界日没有记录到阻塞原因。', (item) =>
    `${systemLabels[item.system] || item.system} · ${item.count} 次`);
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
  renderWorldEvolution();
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
window.setInterval(() => {
  if (document.visibilityState === 'visible' && selectedAgentId) loadResidentDetail(selectedAgentId);
}, 30_000);
window.setInterval(() => { if (document.visibilityState === 'visible') loadStats(); }, 30_000);

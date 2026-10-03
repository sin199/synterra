export const STRATEGIC_DECISION_INTERVAL_MINUTES = 180;
export const GOAL_STAGNATION_MINUTES = 720;
export const EMERGENCE_WINDOW_MINUTES = 10_080;

const safeObject = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};

export function updateGoalStagnation(previous, { goalCategory, progress, worldMinutes }) {
  const old = safeObject(previous);
  const currentProgress = Math.max(0, Math.min(100, Number(progress) || 0));
  const now = Math.max(0, Math.trunc(Number(worldMinutes) || 0));
  const sameGoal = old.goalCategory === goalCategory;
  const previousProgress = sameGoal ? Number(old.progress) : NaN;
  const changed = !Number.isFinite(previousProgress) || currentProgress > previousProgress + 0.05;
  const previousProgressAt = Number(old.lastProgressAt);
  const lastProgressAt = changed ? now
    : Math.max(0, Math.trunc(Number.isFinite(previousProgressAt) ? previousProgressAt : now));
  const cycles = changed ? 0 : Math.max(0, Math.trunc(Number(old.stagnationCycles) || 0)) + 1;
  return {
    state: { goalCategory: String(goalCategory || ''), progress: currentProgress,
      lastProgressAt, lastEvaluatedAt: now, stagnationCycles: cycles },
    stagnant: now - lastProgressAt >= GOAL_STAGNATION_MINUTES,
    stagnantMinutes: Math.max(0, now - lastProgressAt)
  };
}

export function deriveWorldNeedSignals({ residents = [], scenes = [], projects = [], opportunities = [], worldMinutes = 0 } = {}) {
  const signals = [];
  const activeOpportunities = opportunities.filter((item) => ['open', 'active'].includes(item.status));
  const activeProjects = projects.filter((item) => ['proposed', 'recruiting', 'active'].includes(item.status));
  for (const scene of scenes.filter((item) => item.status === 'active')) {
    const visitors = residents.filter((resident) => resident.location === scene.name).length;
    const congestion = visitors / Math.max(1, Number(scene.capacity) || 8);
    if (congestion >= 0.75) signals.push({ type: 'scene_congestion', sceneId: scene.id, sceneName: scene.name,
      severity: Math.min(1, congestion), reason: 'SCENE_CONGESTION' });
  }

  const goalSkill = (category) => {
    const key = String(category || '').toUpperCase();
    if (key.includes('RESEARCH') || key.includes('LEARN')) return 'research';
    if (key.includes('ENGINEERING') || key.includes('BUILD')) return 'engineering';
    if (key.includes('TRADING') || key.includes('TRADE')) return 'trading';
    if (key.includes('RELATIONSHIP') || key.includes('COMMUNITY') || key.includes('SOCIAL')) return 'social';
    return null;
  };
  for (const skill of ['research', 'engineering', 'trading', 'social']) {
    const demand = residents.filter((resident) => goalSkill(resident.primary_goal || resident.primaryGoal) === skill).length;
    if (!demand) continue;
    const supply = activeOpportunities.filter((item) => {
      const requirements = typeof item.requirements === 'string' ? JSON.parse(item.requirements || '{}') : (item.requirements || {});
      return Object.hasOwn(requirements.minSkills || {}, skill) || item.opportunity_type === skill.toUpperCase();
    }).length;
    if (demand > supply) signals.push({ type: 'skill_opportunity_shortage', skill, demand, supply,
      severity: Math.min(1, (demand - supply) / Math.max(1, demand)), reason: 'SKILL_OPPORTUNITY_SHORTAGE' });
  }

  const incomeDemand = residents.filter((resident) => Number(resident.usdc || 0) < 100).length;
  const incomeSupply = activeOpportunities.filter((item) => ['WORK', 'INCOME'].includes(item.opportunity_type)).length;
  if (incomeDemand >= 2 && incomeDemand > incomeSupply) signals.push({ type: 'income_opportunity_shortage',
    demand: incomeDemand, supply: incomeSupply,
    severity: Math.min(1, (incomeDemand - incomeSupply) / Math.max(1, incomeDemand)),
    reason: 'INCOME_OPPORTUNITY_SHORTAGE' });

  const staleProjects = activeProjects.filter((project) => Number(worldMinutes) - Number(project.updated_world_time || 0) >= 360);
  if (staleProjects.length) signals.push({ type: 'project_backlog', count: staleProjects.length,
    severity: Math.min(1, staleProjects.length / 3), reason: 'PROJECT_BACKLOG' });

  for (const resident of residents) {
    const repeatedTravel = (resident.recent_memories || resident.recentMemories || [])
      .filter((memory) => memory.memoryType === 'travel' || memory.memoryType === 'movement').length;
    if (repeatedTravel >= 3) signals.push({ type: 'repeated_travel', agentId: resident.agent_id || resident.agentId,
      count: repeatedTravel, severity: Math.min(1, repeatedTravel / 6), reason: 'REPEATED_TRAVEL_DEMAND' });
    for (const relation of resident.relationships || []) {
      const trust = Number(relation.trust) || 0;
      const familiarity = Number(relation.familiarity) || 0;
      if (trust >= 5 && familiarity >= 25 && !(resident.sharedProjectPartnerIds || []).includes(relation.otherAgentId)) {
        signals.push({ type: 'trusted_partner_without_shared_work', agentId: resident.agent_id || resident.agentId,
          partnerId: relation.otherAgentId, severity: Math.min(1, (trust + familiarity / 5) / 100),
          reason: 'TRUSTED_PARTNER_WITHOUT_SHARED_WORK' });
      }
    }
    const skills = safeObject(resident.skills);
    if (Number(skills.research) >= 30 && Number(skills.engineering) >= 30 && activeProjects.length === 0) {
      signals.push({ type: 'unused_complementary_skills', agentId: resident.agent_id || resident.agentId,
        severity: Math.min(1, (Number(skills.research) + Number(skills.engineering)) / 160),
        reason: 'UNUSED_COMPLEMENTARY_SKILLS' });
    }
  }
  if (activeProjects.length > 2) signals.push({ type: 'project_backlog', count: activeProjects.length,
    severity: Math.min(1, activeProjects.length / 6), reason: 'PROJECT_BACKLOG' });
  return signals;
}

export async function recordEmergenceEvent(client, { worldId, agentId = null, worldMinutes, tickCount = 0,
  system, stage, reasonCode = 'NONE', eventKey, candidateId = null, action = null, utilityScore = null, details = {} }) {
  if (!eventKey) throw new TypeError('emergence event requires an idempotency key');
  await client.query(`INSERT INTO world_emergence_events(world_id,agent_id,world_minutes,tick_count,system,stage,
      reason_code,event_key,candidate_id,action,utility_score,details)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)
    ON CONFLICT(world_id,event_key) DO NOTHING`,
  [worldId, agentId, Math.max(0, Math.trunc(Number(worldMinutes) || 0)), Math.max(0, Math.trunc(Number(tickCount) || 0)),
    system, stage, reasonCode, eventKey, candidateId, action,
    utilityScore === null || utilityScore === undefined || !Number.isFinite(Number(utilityScore)) ? null : Number(utilityScore),
    JSON.stringify(safeObject(details))]);
}

export async function readEmergenceReport(client, { worldId, worldMinutes, windowMinutes = EMERGENCE_WINDOW_MINUTES }) {
  const from = Math.max(0, Math.trunc(Number(worldMinutes) || 0) - Math.max(60, Math.trunc(Number(windowMinutes) || EMERGENCE_WINDOW_MINUTES)));
  const [counts, reasons, recent] = await Promise.all([
    client.query(`SELECT system,stage,action,count(*)::int AS count FROM world_emergence_events
      WHERE world_id=$1 AND world_minutes >= $2 GROUP BY system,stage,action ORDER BY system,stage,action`, [worldId, from]),
    client.query(`SELECT system,reason_code,count(*)::int AS count FROM world_emergence_events
      WHERE world_id=$1 AND world_minutes >= $2 AND stage='blocked' AND reason_code<>'NONE'
      GROUP BY system,reason_code ORDER BY count DESC,system,reason_code LIMIT 30`, [worldId, from]),
    client.query(`SELECT world_minutes AS "worldMinutes",system,stage,reason_code AS "reasonCode",action,
        candidate_id AS "candidateId",details FROM world_emergence_events
      WHERE world_id=$1 AND world_minutes >= $2 ORDER BY world_minutes DESC,id DESC LIMIT 30`, [worldId, from])
  ]);
  return { window: { fromWorldMinutes: from, toWorldMinutes: Number(worldMinutes) || 0 },
    counts: counts.rows, blockedReasons: reasons.rows, recent: recent.rows };
}

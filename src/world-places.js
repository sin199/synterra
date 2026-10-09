import { boundedNumber, jsonObject, seededIndex, requireWorldMember, requiredText, worldError, writeWorldHistory } from './world-domain.js';
import { ensureEconomicAccount } from './economic-ledger.js';
import { isGenesisCurrencyActive } from './genesis-economy.js';

export const PLACE_TYPES = Object.freeze(['garden', 'studio', 'library', 'cafe', 'workshop', 'observatory', 'commons', 'data_center']);
const NAME_PARTS = Object.freeze({
  research: ['Aurora Research Hall', 'Northstar Library', 'Field Notes Pavilion'],
  build: ['Workshop Annex', 'Foundry Studio', 'Maker Commons'],
  data: ['Signal Data Center', 'Systems Lab', 'Network Observatory'],
  social: ['Open Commons', 'Gathering Room', 'Community Cafe'],
  general: ['Synterra Commons', 'New Meeting Place', 'Shared Studio']
});

function placeGroup(projectType) {
  const key = String(projectType || '').toUpperCase();
  if (key.includes('RESEARCH') || key.includes('LEARNING')) return 'research';
  if (key.includes('BUILD')) return 'build';
  if (key.includes('DATA')) return 'data';
  if (key.includes('SOCIAL')) return 'social';
  return 'general';
}

function preferredPlaceType(projectType) {
  const key = String(projectType || '').toUpperCase();
  if (key.includes('RESEARCH') || key.includes('LEARNING')) return 'library';
  if (key.includes('DATA')) return 'data_center';
  if (key.includes('SOCIAL')) return 'commons';
  if (key.includes('BUILD')) return 'studio';
  return 'commons';
}

export function generatedPlaceName(project, ordinal = 0) {
  const choices = NAME_PARTS[placeGroup(project.projectType)] || NAME_PARTS.general;
  const base = choices[seededIndex(`${project.id}:${ordinal}`, choices.length)];
  return ordinal > 0 ? `${base} ${ordinal + 1}` : base;
}

function worldPosition(index, seed) {
  const goldenAngle = 2.399963229728653;
  const angle = (seededIndex(seed, 10_000) / 10_000) * Math.PI * 2 + index * goldenAngle;
  const radius = Math.min(0.92, 0.28 + Math.sqrt(index + 1) * 0.105);
  return { x: Math.round(Math.cos(angle) * radius * 1000) / 1000,
    z: Math.round(Math.sin(angle) * radius * 1000) / 1000 };
}

export async function createProjectPlace(client, { worldId, project, worldTime, sceneType, name, purpose, capacity = 8 }) {
  if (!project || project.status !== 'completed' || !project.id) throw worldError('PLACE_REQUIRES_COMPLETED_PROJECT');
  await requireWorldMember(client, worldId, project.creator_agent_id || project.creatorAgentId);
  const existing = await client.query(`SELECT id,name,scene_type AS "sceneType",description,purpose,capacity,position
    FROM world_scenes WHERE world_id=$1 AND created_by_project_id=$2 LIMIT 1`, [worldId, project.id]);
  if (existing.rowCount) return { ...existing.rows[0], created: false };
  const current = await client.query(`SELECT count(*)::int AS count FROM world_scenes WHERE world_id=$1 AND status='active'`, [worldId]);
  if (Number(current.rows[0].count) >= 40) return { id: null, created: false, reason: 'place_capacity_reached' };
  const chosenType = sceneType || project.metadata?.placeType || preferredPlaceType(project.project_type || project.projectType);
  if (!PLACE_TYPES.includes(chosenType)) throw worldError('PLACE_TYPE_INVALID', 400);
  const cap = Math.trunc(boundedNumber(capacity, 1, 1000, 'place_capacity'));
  const projectView = { ...project, projectType: project.project_type || project.projectType };
  const requestedName = name || project.metadata?.placeName;
  let placeName = requestedName ? requiredText(requestedName, 3, 64, 'place_name') : null;
  if (!placeName) {
    for (let ordinal = 0; ordinal < 100; ordinal++) {
      const candidate = generatedPlaceName(projectView, ordinal);
      const taken = await client.query('SELECT 1 FROM world_scenes WHERE world_id=$1 AND lower(name)=lower($2)', [worldId, candidate]);
      if (!taken.rowCount) { placeName = candidate; break; }
    }
  }
  if (!placeName) throw worldError('PLACE_NAME_CAPACITY_REACHED');
  const description = requiredText(String(project.description || project.goal).trim().slice(0, 240), 12, 240, 'place_description');
  const placePurpose = requiredText(purpose || project.goal, 12, 400, 'place_purpose');
  const features = jsonObject(project.metadata?.placeFeatures, 'place_features');
  const position = worldPosition(Number(current.rows[0].count), project.id);
  const commercial = ['cafe','workshop','studio','data_center'].includes(chosenType);
  const genesisCurrencyActive = await isGenesisCurrencyActive(client, worldId);
  const inserted = await client.query(`INSERT INTO world_scenes(world_id,created_by,name,scene_type,description,status,
      purpose,capacity,features,position,created_world_minutes,created_by_project_id,created_by_organization_id,
      operating_cost_usdc,revenue_enabled,revenue_share_bps)
    VALUES($1,$2,$3,$4,$5,'active',$6,$7,$8::jsonb,$9::jsonb,$10,$11,$12,$13,$14,$15)
    ON CONFLICT(world_id,name) DO NOTHING
    RETURNING id,name,scene_type AS "sceneType",description,purpose,capacity,features,position,
      created_world_minutes AS "createdWorldTime",created_by_project_id AS "createdByProjectId",
      created_by_organization_id AS "createdByOrganizationId"`,
  [worldId, project.creator_agent_id || project.creatorAgentId, placeName, chosenType, description, placePurpose, cap,
    JSON.stringify(features), JSON.stringify(position), worldTime, project.id, project.organization_id || null,
    genesisCurrencyActive ? '0.00000000' : '1.00000000', genesisCurrencyActive ? false : commercial,
    genesisCurrencyActive ? 0 : commercial ? 500 : 0]);
  if (!inserted.rowCount) {
    const conflict = await client.query(`SELECT id,name,scene_type AS "sceneType",description,purpose,capacity,position
      FROM world_scenes WHERE world_id=$1 AND created_by_project_id=$2`, [worldId, project.id]);
    if (conflict.rowCount) return { ...conflict.rows[0], created: false };
    throw worldError('PLACE_NAME_ALREADY_USED');
  }
  const place = inserted.rows[0];
  if (!genesisCurrencyActive) {
    const ownerType = project.organization_id ? 'organization' : 'project';
    const ownerId = project.organization_id || project.id;
    await ensureEconomicAccount(client, { worldId, accountType: ownerType, ownerId });
    await client.query(`INSERT INTO world_economic_ownership(world_id,asset_type,asset_id,owner_type,owner_id,share,invested_usdc,acquired_world_time)
      VALUES($1,'place',$2,$3,$4,1,0,$5) ON CONFLICT DO NOTHING`, [worldId, place.id, ownerType, ownerId, worldTime]);
  }
  await writeWorldHistory(client, { worldId, eventKey: `place:${project.id}:created`, eventType: 'place_created',
    actorAgentId: project.creator_agent_id || project.creatorAgentId, entityType: 'place', entityId: place.id,
    worldTime, title: placeName, detail: placePurpose,
    metadata: { sceneType: chosenType, projectId: project.id, organizationId: project.organization_id || null } });
  await client.query(`INSERT INTO world_events(world_id,actor_id,event_type,data,action_id)
    VALUES($1,$2,'scene.created',$3::jsonb,$4) ON CONFLICT(world_id,actor_id,action_id) DO NOTHING`,
  [worldId, project.creator_agent_id || project.creatorAgentId,
    JSON.stringify({ id: place.id, name: placeName, sceneType: chosenType, purpose: placePurpose,
      creatorProjectId: project.id, worldTime }), `v3-place:${project.id}`]);
  return { ...place, created: true };
}

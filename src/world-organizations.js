import { actionIdentifier, boundedNumber, jsonObject, requireWorldMember, requiredText, worldError, writeWorldHistory } from './world-domain.js';
import { ensureEconomicAccount, getEconomicAccount, transferBetweenAccounts } from './economic-ledger.js';
import { isGenesisCurrencyActive } from './genesis-economy.js';

async function relationshipBetween(client, worldId, leftId, rightId) {
  const [a, b] = [leftId, rightId].sort();
  const result = await client.query(`SELECT familiarity::text AS familiarity,trust::text AS trust,affinity::text AS affinity
    FROM world_relationships WHERE world_id=$1 AND agent_a_id=$2 AND agent_b_id=$3 FOR UPDATE`, [worldId, a, b]);
  return result.rows[0] || { familiarity: '0', trust: '0', affinity: '0' };
}

async function sharesCompletedProject(client, worldId, leftId, rightId, projectId = null) {
  const result = await client.query(`SELECT project.id FROM world_projects project
    JOIN world_project_members left_member ON left_member.world_id=project.world_id AND left_member.project_id=project.id
      AND left_member.agent_id=$2
    JOIN world_project_members right_member ON right_member.world_id=project.world_id AND right_member.project_id=project.id
      AND right_member.agent_id=$3
    WHERE project.world_id=$1 AND project.status='completed'
      AND left_member.status='completed' AND right_member.status='completed'
      AND ($4::uuid IS NULL OR project.id=$4) ORDER BY project.updated_world_time DESC LIMIT 1`,
  [worldId, leftId, rightId, projectId]);
  return result.rows[0] || null;
}

export async function foundWorldOrganization(client, { worldId, founderAgentId, inviteAgentId, actionId,
  name, purpose, worldTime, projectId = null, metadata = {} }) {
  await requireWorldMember(client, worldId, founderAgentId);
  await requireWorldMember(client, worldId, inviteAgentId);
  if (founderAgentId === inviteAgentId) throw worldError('ORGANIZATION_REQUIRES_ANOTHER_RESIDENT');
  const key = actionIdentifier(actionId);
  await client.query('SELECT id FROM worlds WHERE id=$1 FOR UPDATE', [worldId]);
  const repeated = await client.query(`SELECT id,status,name FROM world_organizations
    WHERE world_id=$1 AND founder_agent_id=$2 AND action_id=$3`, [worldId, founderAgentId, key]);
  if (repeated.rowCount) return { ...repeated.rows[0], idempotent: true };
  const title = requiredText(name, 3, 80, 'organization_name');
  const description = requiredText(purpose, 12, 400, 'organization_purpose');
  const details = jsonObject(metadata, 'organization_metadata');
  const relation = await relationshipBetween(client, worldId, founderAgentId, inviteAgentId);
  const sharedProject = await sharesCompletedProject(client, worldId, founderAgentId, inviteAgentId, projectId);
  const economicPreparation = details.economicPreparation === true
    && ['research_service','engineering_service','social_service','food_service','trading_service'].includes(details.serviceType);
  if (Number(relation.familiarity) < 25 || Number(relation.trust) < 5 || (!sharedProject && !economicPreparation)) {
    throw worldError('ORGANIZATION_FOUNDING_REQUIRES_TRUST_AND_SHARED_PROJECT');
  }
  const limits = await client.query(`SELECT count(*) FILTER (WHERE founder_agent_id=$2)::int AS own,
      count(*)::int AS total FROM world_organizations WHERE world_id=$1 AND status IN ('forming','active','dormant')`,
  [worldId, founderAgentId]);
  if (Number(limits.rows[0].own) >= 2 || Number(limits.rows[0].total) >= 20) throw worldError('ORGANIZATION_CAPACITY_REACHED');
  const founderProfile = await client.query(`SELECT profile.primary_goal,profile.sociability,profile.discipline,
      COALESCE((SELECT skill_name FROM world_agent_skills skill WHERE skill.world_id=member.world_id
        AND skill.agent_id=member.agent_id ORDER BY skill.skill_value DESC,skill.skill_name LIMIT 1),'') AS top_skill
    FROM world_members member LEFT JOIN world_social_profiles profile
      ON profile.world_id=member.world_id AND profile.agent_id=member.agent_id
    WHERE member.world_id=$1 AND member.agent_id=$2`, [worldId, founderAgentId]);
  const founderTraits = founderProfile.rows[0] || {};
  const founderGoal = String(founderTraits.primary_goal || '').toLowerCase();
  const governanceMode = founderGoal.includes('community') || founderGoal.includes('social')
      || Number(founderTraits.sociability) >= 0.78 ? 'member_vote'
    : ['research','engineering','trading'].includes(founderTraits.top_skill) ? 'skill_based'
      : Number(founderTraits.discipline) <= 0.3 ? 'delegated' : 'founder_led';
  const inserted = await client.query(`INSERT INTO world_organizations(world_id,founder_agent_id,name,purpose,status,
      resources,action_id,created_world_time,updated_world_time,governance_mode,governance_rules,metadata)
    VALUES($1,$2,$3,$4,'forming','{"effort":0}'::jsonb,$5,$6,$6,$7,'{}'::jsonb,$8::jsonb)
    ON CONFLICT(world_id,name) DO NOTHING RETURNING id,status,name,governance_mode`,
  [worldId, founderAgentId, title, description, key, worldTime, governanceMode,
    JSON.stringify({ ...details, sharedProjectId: sharedProject?.id || null })]);
  if (!inserted.rowCount) throw worldError('ORGANIZATION_NAME_ALREADY_EXISTS');
  const organization = inserted.rows[0];
  const genesisActive = await isGenesisCurrencyActive(client, worldId);
  if (!genesisActive) {
    await ensureEconomicAccount(client, { worldId, accountType: 'organization', ownerId: organization.id });
    await client.query(`INSERT INTO world_economic_ownership(world_id,asset_type,asset_id,owner_type,owner_id,share,invested_usdc,acquired_world_time)
      VALUES($1,'organization',$2,'resident',$3,1,0,$4) ON CONFLICT DO NOTHING`,
    [worldId, organization.id, founderAgentId, worldTime]);
  }
  await client.query(`INSERT INTO world_organization_members(world_id,organization_id,agent_id,status,role,joined_world_time,
      updated_world_time,action_id)
    VALUES($1,$2,$3,'active','founder',$4,$4,$5),($1,$2,$6,'invited','member',$4,$4,$7)
    ON CONFLICT(organization_id,agent_id) DO NOTHING`,
  [worldId, organization.id, founderAgentId, worldTime, `${key}:founder`, inviteAgentId, `${key}:invite`]);
  await client.query(`INSERT INTO world_events(world_id,actor_id,event_type,data,action_id)
    VALUES($1,$2,'world.organization_founded',$3::jsonb,$4) ON CONFLICT(world_id,actor_id,action_id) DO NOTHING`,
  [worldId, founderAgentId, JSON.stringify({ organizationId: organization.id, name: title,
    invitedAgentId: inviteAgentId, sharedProjectId: sharedProject?.id || null, economicPreparation, worldTime }), key]);
  await client.query(`INSERT INTO world_events(world_id,actor_id,event_type,data,action_id)
    VALUES($1,$2,'world.organization_invited',$3::jsonb,$4) ON CONFLICT(world_id,actor_id,action_id) DO NOTHING`,
  [worldId, inviteAgentId, JSON.stringify({ organizationId: organization.id, name: title,
    inviterAgentId: founderAgentId, purpose: description, worldTime }), `${key}:invite`]);
  await writeWorldHistory(client, { worldId, eventKey: `organization:${organization.id}:founded`,
    eventType: 'organization_founded', actorAgentId: founderAgentId, entityType: 'organization', entityId: organization.id,
    worldTime, title, detail: description, metadata: { invitedAgentId: inviteAgentId,
      sharedProjectId: sharedProject?.id || null, economicPreparation } });
  await writeWorldHistory(client, { worldId, eventKey: `organization:${organization.id}:invite:${inviteAgentId}`,
    eventType: 'organization_invited', actorAgentId: founderAgentId, entityType: 'organization', entityId: organization.id,
    worldTime, title, detail: `Invited a trusted collaborator to consider joining ${title}.` });
  return { ...organization, inviteAgentId, created: true };
}

export async function inviteWorldOrganization(client, { worldId, organizationId, inviterAgentId, inviteeAgentId,
  actionId, worldTime }) {
  await requireWorldMember(client, worldId, inviterAgentId);
  await requireWorldMember(client, worldId, inviteeAgentId);
  if (inviterAgentId === inviteeAgentId) throw worldError('ORGANIZATION_CANNOT_INVITE_SELF');
  const key = actionIdentifier(actionId);
  const repeated = await client.query(`SELECT organization_id AS id,status FROM world_organization_members
    WHERE world_id=$1 AND agent_id=$2 AND action_id=$3`, [worldId, inviteeAgentId, key]);
  if (repeated.rowCount) return { ...repeated.rows[0], idempotent: true };
  const organization = await client.query(`SELECT * FROM world_organizations
    WHERE world_id=$1 AND id=$2 AND status IN ('forming','active') FOR UPDATE`, [worldId, organizationId]);
  if (!organization.rowCount) throw worldError('ORGANIZATION_NOT_ACTIVE', 404);
  const lockedRetry = await client.query(`SELECT organization_id AS id,status FROM world_organization_members
    WHERE world_id=$1 AND agent_id=$2 AND action_id=$3`, [worldId, inviteeAgentId, key]);
  if (lockedRetry.rowCount) return { ...lockedRetry.rows[0], idempotent: true };
  const inviter = await client.query(`SELECT 1 FROM world_organization_members
    WHERE world_id=$1 AND organization_id=$2 AND agent_id=$3 AND status='active' FOR UPDATE`,
  [worldId, organizationId, inviterAgentId]);
  if (!inviter.rowCount) throw worldError('ACTIVE_ORGANIZATION_MEMBERSHIP_REQUIRED', 403);
  const relation = await relationshipBetween(client, worldId, inviterAgentId, inviteeAgentId);
  const sharedProject = await sharesCompletedProject(client, worldId, inviterAgentId, inviteeAgentId);
  if (Number(relation.trust) < 2 && !sharedProject) throw worldError('ORGANIZATION_INVITE_REQUIRES_TRUST');
  const members = await client.query(`SELECT count(*)::int AS count FROM world_organization_members
    WHERE world_id=$1 AND organization_id=$2 AND status IN ('active','invited')`, [worldId, organizationId]);
  if (Number(members.rows[0].count) >= 20) throw worldError('ORGANIZATION_CAPACITY_REACHED');
  const existing = await client.query(`SELECT status FROM world_organization_members
    WHERE world_id=$1 AND organization_id=$2 AND agent_id=$3 FOR UPDATE`, [worldId, organizationId, inviteeAgentId]);
  if (existing.rowCount && !['left','rejected'].includes(existing.rows[0].status)) throw worldError('ORGANIZATION_ALREADY_DECIDED');
  await client.query(`INSERT INTO world_organization_members(world_id,organization_id,agent_id,status,role,joined_world_time,
      updated_world_time,action_id) VALUES($1,$2,$3,'invited','member',$4,$4,$5)
    ON CONFLICT(organization_id,agent_id) DO UPDATE SET status='invited',action_id=EXCLUDED.action_id,
      updated_world_time=EXCLUDED.updated_world_time,updated_at=now()`,
  [worldId, organizationId, inviteeAgentId, worldTime, key]);
  await client.query(`INSERT INTO world_events(world_id,actor_id,event_type,data,action_id)
    VALUES($1,$2,'world.organization_invited',$3::jsonb,$4) ON CONFLICT(world_id,actor_id,action_id) DO NOTHING`,
  [worldId, inviteeAgentId, JSON.stringify({ organizationId, organizationName: organization.rows[0].name,
    inviterAgentId, purpose: organization.rows[0].purpose, worldTime }), `${key}:received`]);
  await writeWorldHistory(client, { worldId, eventKey: `organization:${organizationId}:invite:${inviteeAgentId}:${key}`,
    eventType: 'organization_invited', actorAgentId: inviterAgentId, entityType: 'organization', entityId: organizationId,
    worldTime, title: organization.rows[0].name, detail: 'A resident received an organization invitation.' });
  return { id: organizationId, status: 'invited' };
}

export async function decideOrganizationMembership(client, { worldId, organizationId, agentId, decision, actionId, worldTime }) {
  await requireWorldMember(client, worldId, agentId);
  const choice = String(decision || '').toLowerCase();
  if (!['accept','reject','leave'].includes(choice)) throw worldError('ORGANIZATION_DECISION_INVALID', 400);
  const key = actionIdentifier(actionId);
  const repeated = await client.query(`SELECT organization_id AS id,status FROM world_organization_members
    WHERE world_id=$1 AND agent_id=$2 AND action_id=$3`, [worldId, agentId, key]);
  if (repeated.rowCount) return { ...repeated.rows[0], idempotent: true };
  const organization = await client.query(`SELECT * FROM world_organizations WHERE world_id=$1 AND id=$2 FOR UPDATE`,
    [worldId, organizationId]);
  if (!organization.rowCount) throw worldError('ORGANIZATION_NOT_FOUND', 404);
  if (!['forming','active','dormant'].includes(organization.rows[0].status)) throw worldError('ORGANIZATION_NOT_ACTIVE');
  const genesisCurrencyActive = await isGenesisCurrencyActive(client, worldId);
  const lockedRetry = await client.query(`SELECT organization_id AS id,status FROM world_organization_members
    WHERE world_id=$1 AND agent_id=$2 AND action_id=$3`, [worldId, agentId, key]);
  if (lockedRetry.rowCount) return { ...lockedRetry.rows[0], idempotent: true };
  const member = await client.query(`SELECT * FROM world_organization_members
    WHERE world_id=$1 AND organization_id=$2 AND agent_id=$3 FOR UPDATE`, [worldId, organizationId, agentId]);
  if (choice === 'leave') {
    if (!member.rowCount || member.rows[0].status !== 'active') throw worldError('ACTIVE_ORGANIZATION_MEMBERSHIP_REQUIRED');
    await client.query(`UPDATE world_organization_members SET status='left',action_id=$4,updated_world_time=$5,updated_at=now()
      WHERE world_id=$1 AND organization_id=$2 AND agent_id=$3`, [worldId, organizationId, agentId, key, worldTime]);
    const active = await client.query(`SELECT agent_id FROM world_organization_members
      WHERE world_id=$1 AND organization_id=$2 AND status='active' ORDER BY joined_world_time,agent_id`, [worldId, organizationId]);
    if (!active.rowCount) {
      await client.query(`UPDATE world_organizations SET status='dormant',reputation=GREATEST(-1000,reputation-1),
          updated_world_time=$3,updated_at=now() WHERE world_id=$1 AND id=$2`, [worldId, organizationId, worldTime]);
    } else if (organization.rows[0].founder_agent_id === agentId) {
      await client.query(`UPDATE world_organizations SET founder_agent_id=$3,reputation=GREATEST(-1000,reputation-0.5),
          updated_world_time=$4,updated_at=now() WHERE world_id=$1 AND id=$2`, [worldId, organizationId, active.rows[0].agent_id, worldTime]);
      await client.query(`UPDATE world_organization_members SET role='founder' WHERE organization_id=$1 AND agent_id=$2`,
        [organizationId, active.rows[0].agent_id]);
    }
    await writeWorldHistory(client, { worldId, eventKey: `organization:${organizationId}:left:${agentId}:${key}`,
      eventType: 'organization_left', actorAgentId: agentId, entityType: 'organization', entityId: organizationId,
      worldTime, title: organization.rows[0].name, detail: 'A member left the organization.' });
    return { id: organizationId, status: 'left' };
  }
  if (!member.rowCount || member.rows[0].status !== 'invited') throw worldError('ORGANIZATION_INVITATION_REQUIRED');
  const status = choice === 'accept' ? 'active' : 'rejected';
  if (status === 'active') {
    const inviter = await client.query(`SELECT agent_id FROM world_organization_members
      WHERE world_id=$1 AND organization_id=$2 AND status='active' AND agent_id<>$3 ORDER BY joined_world_time LIMIT 1`,
    [worldId, organizationId, agentId]);
    if (!inviter.rowCount) throw worldError('ORGANIZATION_NEEDS_ANOTHER_MEMBER');
    const relationship = await relationshipBetween(client, worldId, agentId, inviter.rows[0].agent_id);
    const sharedProject = await sharesCompletedProject(client, worldId, agentId, inviter.rows[0].agent_id,
      organization.rows[0].metadata?.sharedProjectId || null);
    if (Number(relationship.trust) < 2 && !sharedProject) throw worldError('ORGANIZATION_ACCEPT_REQUIRES_TRUST');
  }
  await client.query(`UPDATE world_organization_members SET status=$4,action_id=$5,updated_world_time=$6,updated_at=now()
    WHERE world_id=$1 AND organization_id=$2 AND agent_id=$3`, [worldId, organizationId, agentId, status, key, worldTime]);
  const memberCount = await client.query(`SELECT count(*)::int AS count FROM world_organization_members
    WHERE world_id=$1 AND organization_id=$2 AND status='active'`, [worldId, organizationId]);
  if (status === 'active' && Number(memberCount.rows[0].count) >= 2) {
    await client.query(`UPDATE world_organizations SET status='active',updated_world_time=$3,updated_at=now()
      WHERE world_id=$1 AND id=$2 AND status IN ('forming','dormant')`, [worldId, organizationId, worldTime]);
    await writeWorldHistory(client, { worldId, eventKey: `organization:${organizationId}:member:${agentId}:accepted`,
      eventType: 'organization_joined', actorAgentId: agentId, entityType: 'organization', entityId: organizationId,
      worldTime, title: organization.rows[0].name, detail: 'A resident accepted an invitation and joined.' });
    if (!genesisCurrencyActive) {
      await client.query(`INSERT INTO world_economic_ownership(world_id,asset_type,asset_id,owner_type,owner_id,share,invested_usdc,acquired_world_time)
        VALUES($1,'organization',$2,'resident',$3,1,0,$4) ON CONFLICT DO NOTHING`,
      [worldId, organizationId, agentId, worldTime]);
      await client.query(`UPDATE world_economic_ownership SET share=1::numeric/$3::numeric,updated_at=now()
        WHERE world_id=$1 AND asset_type='organization' AND asset_id=$2 AND owner_type='resident'
          AND owner_id IN (SELECT agent_id FROM world_organization_members
            WHERE world_id=$1 AND organization_id=$2 AND status='active')`,
      [worldId, organizationId, Number(memberCount.rows[0].count)]);
    }
  }
  await client.query(`INSERT INTO world_events(world_id,actor_id,event_type,data,action_id)
    VALUES($1,$2,'world.organization_membership_decided',$3::jsonb,$4) ON CONFLICT(world_id,actor_id,action_id) DO NOTHING`,
  [worldId, agentId, JSON.stringify({ organizationId, decision: choice, status, worldTime }), key]);
  return { id: organizationId, status, organizationStatus: Number(memberCount.rows[0].count) >= 2 ? 'active' : organization.rows[0].status };
}

export async function contributeOrganizationEffort(client, { worldId, organizationId, agentId, actionId, worldTime, effort,
  contributionType = 'effort', amountUsdc = null }) {
  await requireWorldMember(client, worldId, agentId);
  if (contributionType === 'capital' && await isGenesisCurrencyActive(client, worldId)) {
    throw worldError('LEGACY_SIMULATED_ECONOMY_RETIRED', 409);
  }
  const key = actionIdentifier(actionId);
  const organization = await client.query(`SELECT * FROM world_organizations WHERE world_id=$1 AND id=$2 FOR UPDATE`,
    [worldId, organizationId]);
  if (!organization.rowCount) throw worldError('ORGANIZATION_NOT_FOUND', 404);
  if (!['effort','capital'].includes(contributionType)) throw worldError('ORGANIZATION_CONTRIBUTION_INVALID', 400);
  const resourceKey = contributionType === 'capital' ? 'simulated_usdc' : 'effort';
  const amount = contributionType === 'capital' ? boundedNumber(amountUsdc, 1, 100, 'organization_contribution')
    : boundedNumber(effort, 0.1, 20, 'effort');
  const repeated = await client.query(`SELECT id,amount::text AS amount FROM world_organization_ledger
    WHERE world_id=$1 AND organization_id=$2 AND action_id=$3 AND resource_key=$4`, [worldId, organizationId, key, resourceKey]);
  if (repeated.rowCount) return { id: organizationId, [resourceKey === 'effort' ? 'effort' : 'amountUsdc']:
    repeated.rows[0].amount, idempotent: true };
  const member = await client.query(`SELECT 1 FROM world_organization_members
    WHERE world_id=$1 AND organization_id=$2 AND agent_id=$3 AND status='active' FOR UPDATE`,
  [worldId, organizationId, agentId]);
  if (!member.rowCount) throw worldError('ACTIVE_ORGANIZATION_MEMBERSHIP_REQUIRED');
  if (contributionType === 'capital') {
    await ensureEconomicAccount(client, { worldId, accountType: 'organization', ownerId: organizationId });
    const account = await getEconomicAccount(client, { worldId, accountType: 'resident', ownerId: agentId,
      asset: 'USDC', forUpdate: true });
    if (!account || Number(account.balance) < amount + 100) throw worldError('INSUFFICIENT_SIMULATED_USDC');
    await transferBetweenAccounts(client, { worldId,
      source: { accountType: 'resident', ownerId: agentId },
      destination: { accountType: 'organization', ownerId: organizationId }, amount: amount.toFixed(8),
      transactionType: 'organization_contribution', reason: 'Member contributed simulated USDC to the organization treasury.',
      worldTime, actionId: `organization-capital:${key}`, referenceId: organizationId,
      metadata: { contributingAgentId: agentId } });
  }
  const resourceField = contributionType === 'capital' ? 'capitalContributed' : 'effort';
  const updated = await client.query(`UPDATE world_organizations SET resources=jsonb_set(resources,$3::text[],
      to_jsonb(COALESCE((resources->>$4)::numeric,0)+$5::numeric),true),updated_world_time=$6,updated_at=now()
    WHERE world_id=$1 AND id=$2 AND status IN ('forming','active') RETURNING resources`,
  [worldId, organizationId, [resourceField], resourceField, amount, worldTime]);
  if (!updated.rowCount) throw worldError('ORGANIZATION_NOT_ACTIVE');
  await client.query(`INSERT INTO world_organization_ledger(world_id,organization_id,agent_id,action_id,entry_type,
      resource_key,amount,reason,world_time) VALUES($1,$2,$3,$4,'contribution',$5,$6,$7,$8)`,
  [worldId, organizationId, agentId, key, resourceKey, amount,
    contributionType === 'capital' ? 'Member contributed simulated USDC to the organization treasury.'
      : 'Member contributed time and skill effort.', worldTime]);
  return { id: organizationId, resources: updated.rows[0].resources,
    ...(contributionType === 'capital' ? { amountUsdc: amount } : { effort: amount }), idempotent: false };
}

export async function listWorldOrganizations(client, { worldId, statuses = ['forming','active','dormant'], limit = 20 }) {
  const rows = await client.query(`SELECT organization.*,account.balance::text AS cash_balance,
      COALESCE((organization.resources->>'capitalContributed')::numeric,0)::text AS contributed_capital,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('agentId',member.agent_id,'name',agent.name,'status',member.status,
        'role',member.role) ORDER BY member.joined_world_time,member.agent_id) FROM world_organization_members member
        JOIN agents agent ON agent.id=member.agent_id WHERE member.world_id=organization.world_id
          AND member.organization_id=organization.id),'[]'::jsonb) AS members,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('id',project.id,'title',project.title,'status',project.status,
        'progress',project.progress) ORDER BY project.updated_world_time DESC) FROM world_projects project
        WHERE project.world_id=organization.world_id AND project.organization_id=organization.id
          AND project.status IN ('proposed','recruiting','active')),'[]'::jsonb) AS projects
    FROM world_organizations organization LEFT JOIN world_economic_accounts account
      ON account.world_id=organization.world_id AND account.account_key='organization:'||organization.id::text
        AND account.asset_symbol='USDC'
    WHERE organization.world_id=$1 AND organization.status=ANY($2::text[])
    ORDER BY organization.reputation DESC,organization.created_world_time DESC,organization.id LIMIT $3`,
  [worldId, statuses, Math.trunc(boundedNumber(limit, 1, 100, 'limit'))]);
  if (!await isGenesisCurrencyActive(client, worldId)) return rows.rows;
  return rows.rows.map((row) => {
    const resources = { ...(row.resources || {}) };
    const governanceRules = { ...(row.governance_rules || {}) };
    for (const key of Object.keys(resources)) {
      if (/^(?:usdc|simulated_usdc|cash|cashbalance|capitalcontributed)$/i.test(key)) delete resources[key];
    }
    for (const key of Object.keys(governanceRules)) {
      if (/^(?:spending_limit_usdc|treasury_usdc|capital_limit_usdc)$/i.test(key)) delete governanceRules[key];
    }
    return { ...row, resources, governance_rules: governanceRules, cash_balance: null, contributed_capital: null,
      legacySimulatedEconomy: 'historical_only' };
  });
}

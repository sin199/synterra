export function createResidentDetailHandler({ pool, host, validUuid, fail }) {
  return async (request, reply) => {
    if (!['127.0.0.1', '::1', 'localhost'].includes(host)) return fail(reply, 403, 'LOCAL_DASHBOARD_ONLY');
    const { agentId } = request.params;
    if (!validUuid(agentId)) return fail(reply, 400, 'AGENT_ID_INVALID');
    reply.header('Cache-Control', 'no-store');
    const world = await pool.query(`SELECT id FROM worlds WHERE open=true ORDER BY created_at DESC LIMIT 1`);
    if (!world.rowCount) return fail(reply, 404, 'WORLD_NOT_FOUND');
    const worldId = world.rows[0].id;
    const [profile, skills, relationships, memories, goals, beliefs, decisions, reflections,
      balances, employment, ownership, recentTransactions, recentPurchases, residentNetWorth, capabilityHistory] = await Promise.all([
      pool.query(`SELECT a.id,a.name,COALESCE((SELECT g.category FROM world_agent_goals g
            WHERE g.world_id=m.world_id AND g.agent_id=m.agent_id AND g.goal_type='primary' AND g.status='active'
            ORDER BY g.priority DESC,g.id LIMIT 1),p.primary_goal) AS "primaryGoal",
          COALESCE((SELECT g.description FROM world_agent_goals g WHERE g.world_id=m.world_id AND g.agent_id=m.agent_id
            AND g.goal_type='primary' AND g.status='active' ORDER BY g.priority DESC,g.id LIMIT 1),p.primary_goal) AS "primaryGoalDescription",
          p.goal_progress::text AS "goalProgress",
          p.goal_milestones AS "goalMilestones",p.dominant_role AS "dominantRole",
          p.sociability::text AS sociability,p.curiosity::text AS curiosity,p.discipline::text AS discipline,
          p.ambition::text AS ambition,p.personality_modifiers AS "personalityModifiers",
          p.risk_modifier::text AS "riskModifier",p.price_sensitivity::text AS "priceSensitivity",
          s.risk_tolerance::text AS "riskTolerance",
          m.location,COALESCE(s.status,'idle') AS "currentStatus",
          CASE WHEN s.planned_action IN ('trade','trade_crypto','trade_meme','trade_hold') THEN NULL
            ELSE s.planned_action END AS "currentAction",
          am.current_goal AS "currentIntent",p.last_reflection_world_minutes AS "lastReflectionWorldMinutes"
        FROM world_members m JOIN agents a ON a.id=m.agent_id
        LEFT JOIN world_social_profiles p ON p.world_id=m.world_id AND p.agent_id=m.agent_id
        LEFT JOIN world_agent_states s ON s.world_id=m.world_id AND s.agent_id=m.agent_id
        LEFT JOIN agent_minds am ON am.world_id=m.world_id AND am.agent_id=m.agent_id
        WHERE m.world_id=$1 AND m.agent_id=$2`, [worldId, agentId]),
      pool.query(`SELECT skill_name AS skill,skill_value::text AS value,actions_completed AS "actionsCompleted"
        FROM world_agent_skills WHERE world_id=$1 AND agent_id=$2 ORDER BY skill_value DESC,skill_name`, [worldId, agentId]),
      pool.query(`SELECT other.id AS "agentId",other.name,r.familiarity::text AS familiarity,r.trust::text AS trust,
          r.affinity::text AS affinity,r.interaction_count AS "interactionCount",
          r.last_interaction_world_minutes AS "lastInteractionWorldMinutes"
        FROM world_relationships r
        JOIN agents other ON other.id=CASE WHEN r.agent_a_id=$2 THEN r.agent_b_id ELSE r.agent_a_id END
        WHERE r.world_id=$1 AND (r.agent_a_id=$2 OR r.agent_b_id=$2)
        ORDER BY r.familiarity DESC,r.trust DESC,r.interaction_count DESC LIMIT 10`, [worldId, agentId]),
      pool.query(`SELECT memory.id,memory.memory_type AS type,memory.summary,memory.importance::text AS importance,
          memory.world_minutes AS "worldMinutes",memory.location,memory.related_agent_id AS "relatedAgentId",
          related.name AS "relatedAgentName",memory.metadata,memory.created_at AS "createdAt",memory.long_term AS "longTerm"
        FROM agent_memories memory LEFT JOIN agents related ON related.id=memory.related_agent_id
        WHERE memory.world_id=$1 AND memory.agent_id=$2
          AND COALESCE(memory.metadata->>'action','') NOT IN ('trade','trade_crypto','trade_meme','trade_hold')
          AND memory.memory_type NOT IN ('trade','trading')
          AND (memory.consolidation_key LIKE 'world_epoch:%' OR memory.id IN (
            SELECT recent.id FROM agent_memories recent WHERE recent.world_id=$1 AND recent.agent_id=$2
            ORDER BY recent.world_minutes DESC,recent.id DESC LIMIT 12))
        ORDER BY memory.world_minutes DESC,memory.id DESC`, [worldId, agentId]),
      pool.query(`SELECT id,goal_type AS "goalType",category,description,priority::text AS priority,
          progress::text AS progress,status,source,parent_goal_id AS "parentGoalId",
          created_world_minutes AS "createdWorldMinutes",updated_world_minutes AS "updatedWorldMinutes",metadata
        FROM world_agent_goals WHERE world_id=$1 AND agent_id=$2 AND status='active'
        ORDER BY CASE goal_type WHEN 'primary' THEN 0 WHEN 'secondary' THEN 1 ELSE 2 END,priority DESC,updated_world_minutes DESC LIMIT 7`, [worldId, agentId]),
      pool.query(`SELECT subject_type AS "subjectType",subject_key AS "subjectKey",belief_key AS "beliefKey",
          estimate::text AS estimate,confidence::text AS confidence,sample_count AS "sampleCount",
          updated_world_minutes AS "updatedWorldMinutes",evidence FROM world_agent_beliefs
        WHERE world_id=$1 AND agent_id=$2 ORDER BY sample_count DESC,confidence DESC LIMIT 12`, [worldId, agentId]),
      pool.query(`SELECT tick_count AS "tickCount",world_minutes AS "worldMinutes",chosen_candidate_id AS "candidateId",
          chosen_action AS action,behavior_probability::text AS probability,distribution,utility_scores AS "utilityScores",
          goal_snapshot AS goals,rationale,created_at AS "createdAt"
        FROM world_decision_traces WHERE world_id=$1 AND agent_id=$2
          AND chosen_action NOT IN ('trade','trade_crypto','trade_meme','trade_hold')
        ORDER BY tick_count DESC,id DESC LIMIT 8`, [worldId, agentId]),
      pool.query(`SELECT world_minutes AS "worldMinutes",trigger,rationale,created_at AS "createdAt"
        FROM world_agent_reflections WHERE world_id=$1 AND agent_id=$2 ORDER BY world_minutes DESC,id DESC LIMIT 5`, [worldId, agentId])
      ,pool.query(`SELECT asset_symbol AS asset,balance::text AS balance FROM world_economic_accounts
        WHERE world_id=$1 AND account_type='resident' AND owner_id=$2 ORDER BY asset_symbol`, [worldId, agentId])
      ,pool.query(`SELECT employment.id,employment.business_id AS "businessId",business.name AS "businessName",
          job.role,employment.wage_usdc::text AS "wageUsdc",employment.started_world_time AS "startedWorldTime"
        FROM world_business_employment employment JOIN world_businesses business
          ON business.world_id=employment.world_id AND business.id=employment.business_id
        JOIN world_business_jobs job ON job.world_id=employment.world_id AND job.id=employment.job_id
        WHERE employment.world_id=$1 AND employment.agent_id=$2 AND employment.status='active'
        ORDER BY employment.started_world_time DESC`, [worldId, agentId])
      ,pool.query(`WITH RECURSIVE holdings(asset_type,asset_id,share,path) AS (
          SELECT owner.asset_type,owner.asset_id,owner.share::numeric,ARRAY[owner.asset_type||':'||owner.asset_id::text]
          FROM world_economic_ownership owner WHERE owner.world_id=$1 AND owner.owner_type='resident' AND owner.owner_id=$2
          UNION ALL
          SELECT child.asset_type,child.asset_id,holdings.share*child.share,
            holdings.path||(child.asset_type||':'||child.asset_id::text)
          FROM holdings JOIN world_economic_ownership child ON child.world_id=$1
            AND child.owner_type=holdings.asset_type AND child.owner_id=holdings.asset_id
          WHERE holdings.asset_type IN ('organization','project')
            AND NOT (child.asset_type||':'||child.asset_id::text)=ANY(holdings.path)
        )
        SELECT holdings.asset_type AS "assetType",holdings.asset_id AS "assetId",sum(holdings.share)::text AS share,
          COALESCE(business.name,project.title,organization.name,place.name,'Economic asset') AS name,
          COALESCE(account.balance::text,'0.00000000') AS "cashBalance"
        FROM holdings LEFT JOIN world_businesses business ON holdings.asset_type='business'
          AND business.world_id=$1 AND business.id=holdings.asset_id
        LEFT JOIN world_projects project ON holdings.asset_type='project' AND project.world_id=$1 AND project.id=holdings.asset_id
        LEFT JOIN world_organizations organization ON holdings.asset_type='organization'
          AND organization.world_id=$1 AND organization.id=holdings.asset_id
        LEFT JOIN world_scenes place ON holdings.asset_type='place' AND place.world_id=$1 AND place.id=holdings.asset_id
        LEFT JOIN world_economic_accounts account ON account.world_id=$1 AND account.account_type=holdings.asset_type
          AND account.owner_id=holdings.asset_id AND account.asset_symbol='USDC'
        GROUP BY holdings.asset_type,holdings.asset_id,business.name,project.title,organization.name,place.name,account.balance
        ORDER BY holdings.asset_type,name`, [worldId, agentId])
      ,pool.query(`SELECT tx.transaction_type AS type,tx.asset_symbol AS asset,tx.amount::text AS amount,
          tx.reason,tx.world_time AS "worldTime",
          CASE WHEN destination.account_type='resident' AND destination.owner_id=$2 THEN 'income' ELSE 'expense' END AS flow
        FROM world_economic_transactions tx
        JOIN world_economic_accounts source ON source.id=tx.source_account_id
        JOIN world_economic_accounts destination ON destination.id=tx.destination_account_id
        WHERE tx.world_id=$1 AND ((source.account_type='resident' AND source.owner_id=$2)
          OR (destination.account_type='resident' AND destination.owner_id=$2))
        ORDER BY tx.world_time DESC,tx.created_at DESC LIMIT 12`, [worldId, agentId])
      ,pool.query(`SELECT service.name AS "serviceName",business.name AS "businessName",orders.price_usdc::text AS "priceUsdc",
          orders.world_time AS "worldTime",orders.status
        FROM world_business_orders orders JOIN world_businesses business ON business.world_id=orders.world_id
          AND business.id=orders.business_id JOIN world_business_services service ON service.world_id=orders.world_id
          AND service.id=orders.service_id
        WHERE orders.world_id=$1 AND orders.customer_agent_id=$2 ORDER BY orders.world_time DESC,orders.created_at DESC LIMIT 8`,
      [worldId, agentId]),
      pool.query(`SELECT 'proposal' AS kind,proposal.name AS title,proposal.category,proposal.status,
          proposal.created_world_minute AS "worldMinute",proposal.problem_statement AS detail
        FROM world_capability_proposals proposal WHERE proposal.world_id=$1 AND proposal.creator_agent_id=$2
        UNION ALL
        SELECT 'review' AS kind,proposal.name AS title,proposal.category,review.decision AS status,
          review.created_world_minute AS "worldMinute",review.rationale AS detail
        FROM world_capability_reviews review JOIN world_capability_proposals proposal
          ON proposal.world_id=review.world_id AND proposal.id=review.proposal_id
        WHERE review.world_id=$1 AND review.reviewer_agent_id=$2
        UNION ALL
        SELECT 'use' AS kind,capability.name AS title,capability.category,use.status,
          use.world_minute AS "worldMinute",CASE WHEN use.success THEN '声明式效果已执行并记录'
            ELSE COALESCE(use.result->>'failureCode','能力执行未完成') END AS detail
        FROM world_capability_uses use JOIN world_capabilities capability
          ON capability.world_id=use.world_id AND capability.id=use.capability_id
        WHERE use.world_id=$1 AND (use.actor_agent_id=$2 OR use.partner_agent_id=$2)
        ORDER BY "worldMinute" DESC,kind LIMIT 12`, [worldId, agentId])
      ,pool.query(`WITH RECURSIVE holdings(asset_type,asset_id,share,path) AS (
          SELECT owner.asset_type,owner.asset_id,owner.share::numeric,ARRAY[owner.asset_type||':'||owner.asset_id::text]
          FROM world_economic_ownership owner WHERE owner.world_id=$1 AND owner.owner_type='resident' AND owner.owner_id=$2
          UNION ALL
          SELECT child.asset_type,child.asset_id,holdings.share*child.share,
            holdings.path||(child.asset_type||':'||child.asset_id::text)
          FROM holdings JOIN world_economic_ownership child ON child.world_id=$1
            AND child.owner_type=holdings.asset_type AND child.owner_id=holdings.asset_id
          WHERE holdings.asset_type IN ('organization','project')
            AND NOT (child.asset_type||':'||child.asset_id::text)=ANY(holdings.path)
        ), assets AS (
          SELECT account.account_type AS asset_type,account.owner_id AS asset_id,
            sum(account.balance) AS value_usd
          FROM world_economic_accounts account
          WHERE account.world_id=$1 AND account.account_type IN ('business','organization','project')
          GROUP BY account.account_type,account.owner_id
        )
        SELECT (SELECT COALESCE(sum(account.balance),0)
            FROM world_economic_accounts account
            WHERE account.world_id=$1 AND account.account_type='resident' AND account.owner_id=$2)
          +(SELECT COALESCE(sum(holdings.share*assets.value_usd),0) FROM holdings JOIN assets USING(asset_type,asset_id)) AS "netWorthUsd"`,
      [worldId, agentId])
    ]);
    if (!profile.rowCount) return fail(reply, 404, 'RESIDENT_NOT_FOUND');
    const [selfModel, questions, concepts, policyExperiments, extensionRequests, values, observationMethods, createdCapabilities,
      usedCapabilities, coordination, resources, observationUses, entityParticipation] = await Promise.all([
      pool.query(`SELECT current_identity_summary AS "identitySummary",self_beliefs AS "selfBeliefs",
          preferred_modes_of_action AS "preferredModesOfAction",important_capabilities AS "importantCapabilities",
          important_relationships AS "importantRelationships",long_term_patterns AS "longTermPatterns",
          unresolved_questions AS "unresolvedQuestions",recent_changes AS "recentChanges",uncertainty,
          preferred_cognition_mode AS "preferredCognitionMode",
          confidence::text AS confidence,last_reflected_world_minute AS "lastReflectedWorldMinute"
        FROM world_agent_self_models WHERE world_id=$1 AND agent_id=$2`, [worldId, agentId]),
      pool.query(`SELECT id,question,origin,status,confidence::text AS confidence,evidence,created_world_minute AS "createdWorldMinute"
        FROM world_agent_questions WHERE world_id=$1 AND creator_agent_id=$2 ORDER BY updated_world_minute DESC LIMIT 8`, [worldId, agentId]),
      pool.query(`SELECT id,name,description,definition,status,usage_count AS "usageCount",evidence,created_world_minute AS "createdWorldMinute"
        FROM world_agent_concepts WHERE world_id=$1 AND creator_agent_id=$2 ORDER BY created_world_minute DESC LIMIT 8`, [worldId, agentId]),
      pool.query(`SELECT id,status,reason,before_policy AS "beforePolicy",proposed_policy AS "proposedPolicy",result,
          started_world_minute AS "startedWorldMinute",ends_world_minute AS "endsWorldMinute"
        FROM world_agent_policy_experiments WHERE world_id=$1 AND agent_id=$2 ORDER BY started_world_minute DESC LIMIT 8`, [worldId, agentId]),
      pool.query(`SELECT id,request_type AS "requestType",title,description,status,evidence,created_world_minute AS "createdWorldMinute"
        FROM world_extension_requests WHERE world_id=$1 AND creator_agent_id=$2 ORDER BY created_world_minute DESC LIMIT 8`, [worldId, agentId]),
      pool.query(`SELECT name,description,origin,importance::text AS importance,confidence::text AS confidence,evidence,status,
          created_world_minute AS "createdWorldMinute" FROM world_agent_values WHERE world_id=$1 AND holder_type='agent' AND holder_id=$2
        ORDER BY importance DESC,updated_world_minute DESC LIMIT 8`, [worldId, agentId]),
      pool.query(`SELECT id,name,description,observation_spec AS "observationSpec",evidence,status,usage_count AS "usageCount"
        FROM world_agent_observation_methods WHERE world_id=$1 AND creator_agent_id=$2 ORDER BY created_world_minute DESC LIMIT 8`, [worldId, agentId]),
      pool.query(`SELECT id,name,category,status,created_world_minute AS "createdWorldMinute",usage_count AS "usageCount"
        FROM world_capabilities WHERE world_id=$1 AND creator_agent_id=$2 ORDER BY created_world_minute DESC LIMIT 12`, [worldId, agentId]),
      pool.query(`SELECT capability.id,capability.name,capability.category,capability.creator_type AS "creatorType",
          use.success,use.world_minute AS "worldMinute" FROM world_capability_uses use
        JOIN world_capabilities capability ON capability.world_id=use.world_id AND capability.id=use.capability_id
        WHERE use.world_id=$1 AND use.actor_agent_id=$2 ORDER BY use.world_minute DESC,use.id DESC LIMIT 12`, [worldId, agentId]),
      pool.query(`SELECT id,name,mechanism_type AS "mechanismType",status,usage_count AS "usageCount",
          created_world_minute AS "createdWorldMinute" FROM world_coordination_mechanisms
        WHERE world_id=$1 AND creator_agent_id=$2 ORDER BY created_world_minute DESC,id DESC LIMIT 8`, [worldId, agentId]),
      pool.query(`SELECT id,name,resource_key AS "resourceKey",status,usage_count AS "usageCount",permitted_uses AS "permittedUses"
        FROM world_agent_resource_types WHERE world_id=$1 AND creator_agent_id=$2 ORDER BY created_world_minute DESC,id DESC LIMIT 8`,
      [worldId, agentId]),
      pool.query(`SELECT use.id,method.name AS "methodName",use.observation,use.world_minute AS "worldMinute"
        FROM world_agent_observation_uses use JOIN world_agent_observation_methods method
          ON method.world_id=use.world_id AND method.id=use.method_id
        WHERE use.world_id=$1 AND use.actor_agent_id=$2 ORDER BY use.world_minute DESC,use.id DESC LIMIT 8`, [worldId, agentId]),
      pool.query(`SELECT entity.id,entity.entity_type AS "entityType",entity.name,entity.purpose,entity.status,
          participant.participation_mode AS "participationMode",participant.status AS "participationStatus"
        FROM world_emergent_entities entity LEFT JOIN world_emergent_entity_participants participant
          ON participant.world_id=entity.world_id AND participant.entity_id=entity.id AND participant.participant_type='agent'
          AND participant.participant_id=($2::uuid)::text
        WHERE entity.world_id=$1 AND (entity.creator_agent_id=$2::uuid OR participant.participant_id=($2::uuid)::text)
        ORDER BY entity.created_world_minute DESC,entity.id DESC LIMIT 8`, [worldId, agentId])
    ]);
    const institutions = (await pool.query(`SELECT
        COALESCE((SELECT jsonb_agg(jsonb_build_object('id',recent.id,'type',recent.agreement_type,
            'status',recent.status,'terms',recent.terms,'round',recent.negotiation_round,'worldTime',recent.updated_world_time,
            'otherAgentId',CASE WHEN recent.proposer_agent_id=$2 THEN recent.counterparty_agent_id ELSE recent.proposer_agent_id END,
            'otherName',CASE WHEN recent.proposer_agent_id=$2 THEN counterparty.name ELSE proposer.name END)
          ORDER BY recent.updated_world_time DESC,recent.created_at DESC)
          FROM (SELECT * FROM world_agreements WHERE world_id=$1 AND $2 IN (proposer_agent_id,counterparty_agent_id)
            ORDER BY updated_world_time DESC,created_at DESC LIMIT 12) recent
          JOIN agents proposer ON proposer.id=recent.proposer_agent_id
          JOIN agents counterparty ON counterparty.id=recent.counterparty_agent_id),'[]'::jsonb) AS agreements,
        COALESCE((SELECT jsonb_agg(jsonb_build_object('id',recent.id,'type',recent.commitment_type,
            'description',recent.description,'status',recent.status,'dueWorldTime',recent.due_world_time,
            'outcomeReason',recent.outcome_reason)
          ORDER BY recent.due_world_time,recent.created_at)
          FROM (SELECT * FROM world_commitments WHERE world_id=$1 AND agent_id=$2
            ORDER BY due_world_time DESC,created_at DESC LIMIT 12) recent),'[]'::jsonb) AS commitments,
        (SELECT jsonb_build_object('reliability',reliability,'professional',professional,'financial',financial,
            'cooperation',cooperation,'fulfilledCount',fulfilled_count,'breachCount',breach_count)
          FROM world_agent_reputations WHERE world_id=$1 AND agent_id=$2) AS reputation,
        COALESCE((SELECT jsonb_agg(jsonb_build_object('organizationId',organization.id,'name',organization.name,
            'role',member.role,'status',member.status,'governanceMode',organization.governance_mode)
          ORDER BY member.joined_world_time DESC)
          FROM world_organization_members member JOIN world_organizations organization
            ON organization.world_id=member.world_id AND organization.id=member.organization_id
          WHERE member.world_id=$1 AND member.agent_id=$2 AND member.status IN ('active','invited')),'[]'::jsonb) AS "organizationRoles",
        COALESCE((SELECT jsonb_agg(jsonb_build_object('eventType',recent.event_type,'title',recent.title,
            'detail',recent.detail,'worldTime',recent.world_time,'agreementId',recent.entity_id)
          ORDER BY recent.world_time DESC,recent.id DESC)
          FROM (SELECT history.* FROM world_history history JOIN world_agreements agreement
            ON agreement.world_id=history.world_id AND agreement.id=history.entity_id
            WHERE history.world_id=$1 AND history.entity_type='agreement'
              AND $2 IN (agreement.proposer_agent_id,agreement.counterparty_agent_id)
            ORDER BY history.world_time DESC,history.id DESC LIMIT 8) recent),'[]'::jsonb) AS "recentNegotiations"
      `, [worldId, agentId])).rows[0];
    return { resident: profile.rows[0], skills: skills.rows, relationships: relationships.rows, recentMemories: memories.rows,
      goals: goals.rows, beliefs: beliefs.rows, decisions: decisions.rows, reflections: reflections.rows,
      v7: { selfModel: selfModel.rows[0] || null, questions: questions.rows, concepts: concepts.rows,
        policyExperiments: policyExperiments.rows, extensionRequests: extensionRequests.rows, values: values.rows,
        observationMethods: observationMethods.rows, capabilitiesCreated: createdCapabilities.rows, capabilitiesUsed: usedCapabilities.rows,
        coordination: coordination.rows, resources: resources.rows, observationUses: observationUses.rows,
        emergentEntities: entityParticipation.rows },
      capabilityHistory: capabilityHistory.rows,
      institutions,
      economy: { netWorthUsd: residentNetWorth.rows[0]?.netWorthUsd || '0.00000000', balances: balances.rows,
        employment: employment.rows, ownership: ownership.rows, recentTransactions: recentTransactions.rows,
        recentPurchases: recentPurchases.rows } };
  };
}

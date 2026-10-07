#!/usr/bin/env bash
set -euo pipefail
set +x

: "${SYNTERRA_CUTOVER_SOURCE_PGSERVICE:?Set the stopped source database pg_service name}"
: "${SYNTERRA_CUTOVER_TARGET_PGSERVICE:?Set the restored target database pg_service name}"
: "${SYNTERRA_CUTOVER_EXPECTED_WORLD_ID:?Set the verified existing world ID}"

if [[ ! "$SYNTERRA_CUTOVER_EXPECTED_WORLD_ID" =~ ^[0-9a-fA-F-]{36}$ ]]; then
  echo "Expected world ID must be a UUID." >&2
  exit 2
fi

probe_world_lock() {
  local service="$1" acquired
  acquired="$(psql -X -Atq "service=$service" -c \
    "SELECT pg_try_advisory_lock(hashtextextended('synterra-world-engine',0))")"
  if [[ "$acquired" != t ]]; then
    echo "World Engine advisory lock is still owned on service '$service'; stop its runtime before cutover." >&2
    return 1
  fi
  # The psql session exits immediately and releases this temporary probe lock.
}

read_snapshot() {
  psql -X -F '|' -Atq "service=$1" -c "
    SELECT w.id::text,w.chain_id::text,r.world_minutes::text,
      (SELECT count(*)::text FROM world_members x WHERE x.world_id=w.id),
      (SELECT count(*)::text FROM world_events x WHERE x.world_id=w.id),
      (SELECT count(*)::text FROM world_history x WHERE x.world_id=w.id),
      (SELECT count(*)::text FROM world_epochs x WHERE x.world_id=w.id),
      (SELECT count(*)::text FROM world_capabilities x WHERE x.world_id=w.id),
      (SELECT count(*)::text FROM world_capability_gaps x WHERE x.world_id=w.id),
      (SELECT count(*)::text FROM world_capability_proposals x WHERE x.world_id=w.id),
      (SELECT count(*)::text FROM world_capability_observations x WHERE x.world_id=w.id),
      (SELECT count(*)::text FROM world_capability_reviews x WHERE x.world_id=w.id),
      (SELECT count(*)::text FROM world_capability_experiments x WHERE x.world_id=w.id),
      (SELECT count(*)::text FROM world_capability_uses x WHERE x.world_id=w.id),
      (SELECT count(*)::text FROM world_capability_events x WHERE x.world_id=w.id),
      (SELECT count(*)::text FROM world_economic_accounts x WHERE x.world_id=w.id),
      (SELECT count(*)::text FROM world_economic_transactions x WHERE x.world_id=w.id),
      (SELECT count(*)::text FROM world_economic_postings x JOIN world_economic_transactions tx
        ON tx.id=x.transaction_id WHERE tx.world_id=w.id),
      (SELECT count(*)::text FROM world_economic_ownership x WHERE x.world_id=w.id),
      (SELECT count(*)::text FROM crypto_balances x WHERE x.world_id=w.id),
      (SELECT count(*)::text FROM crypto_ledger x WHERE x.world_id=w.id),
      (SELECT count(*)::text FROM world_agent_goals x WHERE x.world_id=w.id),
      (SELECT count(*)::text FROM world_agent_self_models x WHERE x.world_id=w.id),
      (SELECT count(*)::text FROM world_agent_self_model_history x WHERE x.world_id=w.id),
      (SELECT count(*)::text FROM world_agent_questions x WHERE x.world_id=w.id),
      (SELECT count(*)::text FROM world_agent_concepts x WHERE x.world_id=w.id),
      (SELECT count(*)::text FROM world_agent_concept_uses x WHERE x.world_id=w.id),
      (SELECT count(*)::text FROM world_emergent_entities x WHERE x.world_id=w.id),
      (SELECT count(*)::text FROM world_emergent_entity_participants x WHERE x.world_id=w.id),
      (SELECT count(*)::text FROM world_agent_policy_experiments x WHERE x.world_id=w.id),
      (SELECT count(*)::text FROM world_extension_requests x WHERE x.world_id=w.id),
      (SELECT count(*)::text FROM world_capability_dependencies x WHERE x.world_id=w.id),
      (SELECT count(*)::text FROM arc_agent_wallets x WHERE x.world_id=w.id),
      (SELECT count(*)::text FROM arc_spending_policies x WHERE x.world_id=w.id),
      (SELECT count(*)::text FROM arc_settlement_outbox x WHERE x.world_id=w.id),
      (SELECT count(*)::text FROM arc_nonce_reservations x JOIN arc_settlement_outbox outbox
        ON outbox.id=x.outbox_id WHERE outbox.world_id=w.id),
      (SELECT count(*)::text FROM arc_indexed_events x WHERE x.world_id=w.id),
      (SELECT count(*)::text FROM arc_world_checkpoints x WHERE x.world_id=w.id),
      (SELECT count(*)::text FROM arc_capability_provenance x WHERE x.world_id=w.id)
    FROM worlds w JOIN world_runtime_state r ON r.world_id=w.id
    WHERE w.open=true ORDER BY w.created_at DESC,w.id LIMIT 1"
}

probe_world_lock "$SYNTERRA_CUTOVER_SOURCE_PGSERVICE"
probe_world_lock "$SYNTERRA_CUTOVER_TARGET_PGSERVICE"
source_snapshot="$(read_snapshot "$SYNTERRA_CUTOVER_SOURCE_PGSERVICE")"
target_snapshot="$(read_snapshot "$SYNTERRA_CUTOVER_TARGET_PGSERVICE")"
if [[ -z "$source_snapshot" || -z "$target_snapshot" ]]; then
  echo "Source or target has no open world with a persisted runtime clock." >&2
  exit 1
fi
if [[ "$source_snapshot" != "$target_snapshot" ]]; then
  echo "Source and target continuity snapshots differ; cutover is blocked." >&2
  echo "source=$source_snapshot" >&2
  echo "target=$target_snapshot" >&2
  exit 1
fi
IFS='|' read -r world_id chain_id world_minute residents events history epochs capabilities gaps proposals observations reviews experiments uses capability_events economy_accounts economy_transactions economy_postings economy_ownership crypto_balances crypto_ledger goals self_models self_model_history questions concepts concept_uses entities entity_participants policy_experiments extension_requests dependencies arc_wallets arc_policies arc_settlements arc_nonce_reservations arc_indexed_events arc_checkpoints arc_provenance <<< "$source_snapshot"
if [[ "$world_id" != "$SYNTERRA_CUTOVER_EXPECTED_WORLD_ID" || "$chain_id" != 5042 ]]; then
  echo "World identity or Arc Mainnet chain ID does not match the explicitly verified baseline." >&2
  exit 1
fi
printf 'preflight=passed\nworld_id=%s\nworld_minute=%s\nresidents=%s\nevents=%s\nhistory=%s\nepochs=%s\ncapabilities=%s\nv6_gaps=%s\nv6_proposals=%s\nv6_observations=%s\nv6_reviews=%s\nv6_experiments=%s\nv6_uses=%s\nv6_events=%s\neconomic_accounts=%s\neconomic_transactions=%s\neconomic_postings=%s\neconomic_ownership=%s\ncrypto_balances=%s\ncrypto_ledger=%s\nv7_goals=%s\nv7_self_models=%s\nv7_self_model_history=%s\nv7_questions=%s\nv7_concepts=%s\nv7_concept_uses=%s\nv7_entities=%s\nv7_entity_participants=%s\nv7_policy_experiments=%s\nv7_extension_requests=%s\ncapability_dependencies=%s\narc_wallets=%s\narc_policies=%s\narc_settlements=%s\narc_nonce_reservations=%s\narc_indexed_events=%s\narc_checkpoints=%s\narc_capability_provenance=%s\n' \
  "$world_id" "$world_minute" "$residents" "$events" "$history" "$epochs" "$capabilities" \
  "$gaps" "$proposals" "$observations" "$reviews" "$experiments" "$uses" "$capability_events" \
  "$economy_accounts" "$economy_transactions" "$economy_postings" "$economy_ownership" "$crypto_balances" "$crypto_ledger" \
  "$goals" "$self_models" "$self_model_history" "$questions" "$concepts" "$concept_uses" "$entities" "$entity_participants" \
  "$policy_experiments" "$extension_requests" "$dependencies" "$arc_wallets" "$arc_policies" "$arc_settlements" \
  "$arc_nonce_reservations" "$arc_indexed_events" "$arc_checkpoints" "$arc_provenance"

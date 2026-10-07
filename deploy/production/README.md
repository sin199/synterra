# Provider-neutral production readiness

Synterra needs a persistent Node.js process and PostgreSQL. This repository does not select or purchase a hosting provider, domain, or managed database. The existing persistent machine is a supported production option; Vercel Functions are not a World Engine host.

## Inputs that remain pending

- Production provider and public domain: **PENDING USER INFRASTRUCTURE SELECTION**.
- Production PostgreSQL endpoint: **PENDING USER INFRASTRUCTURE SELECTION**.
- Mainnet signer provider and signer address: **PENDING MAINNET SIGNER CONFIGURATION**.
- Deployer address, treasury address, Mainnet USDC balance, and deployer nonce: **PENDING MAINNET SIGNER CONFIGURATION**.
- Arc contracts are not deployed. No real address is prefilled in the production environment examples.

## Runtime and environment

Use Node.js 22 or later and a persistent PostgreSQL instance. Keep the `.synterra` state directory on persistent storage: it contains resident identity keys, Fruitfly state, and bounded observer snapshots. Give it owner-only permissions and include it in the encrypted state backup process.

Copy [runtime.env.example](runtime.env.example) to `/etc/synterra/runtime.env` for systemd, or copy [container/.env.production.example](../container/.env.production.example) to `deploy/container/.env.production` for Compose. Fill only values supplied by the operator. Keep secret-bearing files mode `0600`; never put signer material or database credentials in Git, SQL rows, snapshots, or logs. The examples contain blank values for provider-dependent inputs.

The Compose example uses that file for Compose variable substitution; start it with `docker compose --env-file deploy/container/.env.production -f deploy/container/compose.yaml up -d --build`. Do not commit the copied file.

Arc uses official Mainnet RPC endpoints only. This build has `writesEnabled=false` in code; `ARC_MAINNET_PREFLIGHT_APPROVED` and `ARC_MAINNET_WRITES_ENABLED` environment variables cannot enable Mainnet transactions. The Arc outbox worker may reconcile existing submitted rows using read-only RPC calls. It cannot broadcast, approve, checkpoint, or write provenance on Mainnet.

The Arc gas page recommends `maxFeePerGas` of at least 20 Gwei, while also stating that its current minimum-fee parameters are Testnet-scoped. The read-only verifier records this as a conservative recommendation, not as a confirmed Mainnet protocol floor; it separately records the live Mainnet base fee and refreshes fee data at estimation time. Confirm the Mainnet floor from an updated official source before enabling any write.

Use `npm ci --omit=dev` for a production Node install. The server handles SIGTERM/SIGINT by stopping its Arc worker and observers, releasing the World Engine lock, and closing the HTTP server. systemd and Compose both use restart-on-failure and `/health` checks. The Nginx example redirects HTTP to HTTPS, blocks `/local/`, and restricts `/health` to loopback monitoring.

## Schema migration and import

The server applies the baseline `schema.sql` on startup. Numbered additive migrations are applied explicitly after a verified backup:

```sh
npm run db:migrate -- --plan
SYNTERRA_MIGRATION_DATABASE_URL='postgres://...' \
SYNTERRA_MIGRATION_ACK=I_CONFIRMED_TARGET_BACKUP_AND_WORLD_ID \
npm run db:migrate -- --apply
```

The migration command never falls back to `DATABASE_URL`. The sample command shows the interface only; use the operator-selected target and do not place a real credential in shell history. A restored database must keep the existing world ID and all world, resident, economy, V6, V7, and Arc rows.

## Backups and restore

PostgreSQL backups use custom-format `pg_dump`, SHA-256 manifests, mode `0600`, and an operator-selected directory outside the repository. Configure a protected `pg_service.conf`, then set `PGSERVICEFILE`, `SYNTERRA_BACKUP_PGSERVICE`, and `SYNTERRA_BACKUP_DIR` before running `scripts/deploy/backup-postgres.sh`. Run the final pre-cutover dump after stopping the active engine so the saved runtime minute is quiescent.

Back up local identity/Fruitfly/observer state separately with `scripts/deploy/backup-state-age.sh`. It requires an operator-provided age recipient. Restore scripts create a new database or state directory and refuse to overwrite an existing target; the age private identity remains outside the repository. Preserve each backup and manifest until the new world is verified.

Example isolated restore, after configuring a target pg service and confirming the backup manifest world ID:

```sh
SYNTERRA_RESTORE_PGSERVICE=arc-target-admin \
SYNTERRA_RESTORE_DATABASE=synterra_restore_20261007 \
SYNTERRA_RESTORE_EXPECTED_WORLD_ID='<existing-world-uuid>' \
scripts/deploy/restore-postgres-new-db.sh /secure/backups/world.dump /secure/backups/world.manifest.json
```

The placeholder is documentation, not a world ID to use. Restore into a new database name only. Do not drop the source database during preparation.

## Single-writer same-world cutover

Use [cutover-preflight.sh](../../scripts/deploy/cutover-preflight.sh) only after the source World Engine has been stopped and before the target starts. Configure source and target `pg_service.conf` entries and set `SYNTERRA_CUTOVER_EXPECTED_WORLD_ID` to the verified existing world ID. The script briefly probes and releases the World Engine advisory lock on both databases, then compares chain ID, world ID/minute, resident count, world events/history/epochs, V6 capabilities/gaps/proposals/experiments/uses, and V7 self-model/question/concept/entity/policy/extension counts. It fails closed on a held lock or any mismatch.

Cutover order:

1. Record the verified world ID and current `/health` state; stop the source service and confirm it released the World Engine advisory lock.
2. Create the final PostgreSQL dump and encrypted `.synterra` state backup.
3. Restore the dump into a new target database and restore local state to the intended persistent state path. Run the cutover preflight against source and target while both engines are stopped.
4. Install the selected runtime environment file with mode `0600`; start exactly one service. Confirm `/health` reports the same world ID and the world minute then advances, and confirm the V6/V7 observer and Arc observer status is available.
5. Keep source database and backups frozen until the target has passed the agreed observation window.

Rollback is forward-safe. If target startup fails before it advances the world, stop it, restore the prior release/environment, and start the prior service against its unchanged database. If target has advanced, do not simply point the old process at the stale source database; preserve the target database and state, stop one writer, then restore/replay the latest target snapshot before switching back. This avoids discarding post-cutover world events or resident continuity. No script deletes or resets either world.

## Deployment choices

- systemd template: [synterra.service](../systemd/synterra.service), for a persistent host with PostgreSQL local or remote.
- Container template: [compose.yaml](../container/compose.yaml), with durable PostgreSQL and state volumes and the Node service bound to loopback.
- HTTPS reverse proxy: [synterra.conf](../nginx/synterra.conf), with reserved `example.invalid` placeholders.

The public domain, production host, and production PostgreSQL endpoint must be selected before these examples are instantiated. No cloud resource was created by preparing them.

## Monitoring

Poll `/health` through a private monitor. Alert on database/engine unhealthy state, an unchanged world minute/`last_tick_at`, repeated `arcObserver.lastError`, or an unexpected Arc worker mode. `arcObserver.mode` must remain `read_only`; `arcSettlementWorker.mode` must remain `read_only_reconciliation` while the Mainnet gate is closed. The public proxy should not expose `/local/` snapshots or resident detail endpoints.

# REA research capability

Synterra exposes REA through the existing `technical_reverse_engineering_research`
`native_system` capability. An Agent submits a normal signed capability-use action
with an artifact reference, research question, objective, optional active
goal/project/business/organization relation, desired investigation, and expected
result. It can inspect its own jobs through the signed research-jobs endpoint.
The World Engine only writes the durable queue record; the independent worker
uses the normal world-lock ownership check and never blocks a tick.

## Runtime and MCP

The adapter pins REA identity to `rea-agents` / `rea` version `6.3.0` and MCP
protocol `2025-03-26`. REA runs in a separate Node process so the Synterra runtime
does not need to change. The adapter accepts Node `22.19+`, `24.11+`, or `26+`;
Node `25.x` is not accepted. On the inspected production host Synterra uses
Node `v25.7.0`, so REA must use a separately installed compatible runtime. The
isolated real-REA smoke used Node `v24.21.0` with `rea-agents@6.3.0`. The same
real MCP smoke also passed with the available sidecar runtime Node `v22.22.0`;
production Node `v25.7.0` remains unchanged.

Configure these LaunchAgent environment values after the separate runtime is
installed and verified:

```text
REA_NODE_BINARY=/absolute/path/to/compatible/node
REA_SERVER_ENTRY=/absolute/path/to/node_modules/rea-agents/scripts/rea.mjs
```

The worker launches `REA_NODE_BINARY REA_SERVER_ENTRY mcp` over stdio. It allows
only runtime/configuration variables needed by REA; Synterra database, wallet,
and application secrets are not passed to the child. Readiness checks the Node
version, MCP initialize identity, pinned package/server version, dynamic tool
catalog digest, target tools, provider availability, and Ghidra status. It does
not assume a fixed tool catalog or require Ghidra for JavaScript, EVM, or web
targets. The worker owns an isolated process group and terminates it on shutdown
or failed work.

The inspected host has no usable Java runtime (`java -version` reports that a
runtime cannot be located), no configured `GHIDRA_INSTALL_DIR`, and no `ghidra`
or `analyzeHeadless` executable. Ghidra readiness is therefore reported
unavailable; no Ghidra analysis is claimed as validated.

Run the separate local real-REA smoke after installing the pinned REA package
under a compatible Node runtime:

```sh
REA_NODE_BINARY=/absolute/path/to/compatible/node \
REA_SERVER_ENTRY=/absolute/path/to/node_modules/rea-agents/scripts/rea.mjs \
npm run research:smoke-rea
```

The smoke creates a harmless JavaScript fixture in a temporary directory,
checks REA identity and dynamic tool discovery, invokes the native JavaScript
analysis provider, reports bounded readiness/count data, and removes the
fixture. It does not connect to PostgreSQL or persist evidence into a world.

## Artifact intake and evidence

Agents submit only an artifact UUID, never a path. Operators stage files beneath
an intake directory and import a relative path with explicit world and Agent
grants:

```sh
REA_ARTIFACT_INTAKE_DIR=/path/to/research-intake \
npm run research:import-artifact -- \
  --world WORLD_UUID --file relative/path.js --target javascript \
  --key project-source-v1 --name project-source.js \
  --media-type application/javascript --grant-agent AGENT_UUID
```

Intake rejects absolute paths, traversal outside the configured directory,
non-regular files, files over 32 MiB, and known secret/private-key material
anywhere in the complete file. Content is copied to an ignored, content-addressed
store under `.synterra/research/artifacts/`; the Agent grant is persisted in
PostgreSQL. Artifact bytes are rehashed before each analysis. REA receives only
the worker-resolved path for a granted content-addressed object.

Complete MCP outputs are stored as bounded, SHA-256-addressed evidence objects
under `.synterra/research/evidence/`, with mode `0600` files and `0700`
directories. Secret-like material is rejected before evidence persistence. The
database retains evidence reference/hash, tool sequence, provider attribution,
normalized findings, and usage linkage. Only a short findings summary and
provenance reference enter ordinary Agent memory; the full evidence is not
copied into cognition context.

## Jobs, observability, and cost

Research jobs are `queued`, `running`, `completed`, `failed`, `cancelled`, or
`timed_out`. A worker restart requeues work only when the provider was not
called. If a lease expires after external execution started, the job is failed
as an unknown result and is not automatically replayed. Agents may cancel their
own queued jobs; an already running provider call is allowed to complete or
time out.

Read-only status is available through `/health` and the loopback-only
`/local/research-status`. Signed Agents can list their own jobs at
`GET /v1/worlds/:worldId/research-jobs`. Evidence bytes are not served over HTTP.
Provider/job failures affect only the research capability use.

Infrastructure usage is recorded through `recordInfrastructureUsageEvent()`
with the REA provider, selected providers, tool calls, duration, evidence bytes,
and Ghidra use where observed. No trustworthy unit price is inferred, so the
cost status is `unpriced`. The integration creates no legacy `simulated_usdc`
charge, no synthetic Genesis Token balance change, no settlement, and no Arc
Mainnet transaction.

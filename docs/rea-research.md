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

The production host's validated pairing is REA Node `v22.22.0`,
`rea-agents@6.3.0`, Eclipse Temurin JDK `21.0.12.1+1`, and Ghidra `12.1.4`
on macOS `arm64`. Ghidra came from the official
[`Ghidra_12.1.4_build` release](https://github.com/NationalSecurityAgency/ghidra/releases/tag/Ghidra_12.1.4_build)
archive (SHA-256
`ddac49f903da9d5bac833e5cc79395098b9c33cfd3279be5f31bd00387d2d4db`). The
official archive did not include REA's required `mac_arm_64/decompile`
executable, so that helper was built with Apple Clang from the same upstream
tag, commit `8b6bbb857accdfa20dc5b2f5dea471178c2e9fbc`; its installed SHA-256 is
`e31bc93586b13c7c4d3b705cce1d5ae761ca62e5bdd506ee3cdecbf9ee06fb54`.
Toolchain files stay outside the Synterra repository. The LaunchAgent supplies
`JAVA_HOME`, `GHIDRA_INSTALL_DIR`, and the bounded
`REA_GHIDRA_STARTUP_TIMEOUT_MS=330000` setting; no host-specific path is
embedded in Synterra code.

Configure these LaunchAgent environment values for the separate runtime and
native provider:

```text
REA_NODE_BINARY=/absolute/path/to/compatible/node
REA_SERVER_ENTRY=/absolute/path/to/node_modules/rea-agents/scripts/rea.mjs
JAVA_HOME=/absolute/path/to/compatible/jdk
GHIDRA_INSTALL_DIR=/absolute/path/to/extracted/ghidra
REA_GHIDRA_STARTUP_TIMEOUT_MS=330000
```

The worker launches `REA_NODE_BINARY REA_SERVER_ENTRY mcp` over stdio. It allows
only runtime/configuration variables needed by REA; Synterra database, wallet,
and application secrets are not passed to the child. Readiness checks the Node
version, MCP initialize identity, pinned package/server version, dynamic tool
catalog digest, target tools, provider availability, and Ghidra status. It does
not assume a fixed tool catalog or require Ghidra for JavaScript, EVM, or web
targets. The worker owns an isolated process group and terminates it on shutdown
or failed work.

The dynamic readiness check reports the Ghidra provider available while keeping
the JavaScript analysis tool available. A real MCP native smoke explicitly
selected `provider_id=ghidra`, decompiled a harmless fixture function, returned
Evidence, and closed the session without changing fixture bytes. A Synterra
isolated worker smoke also completed a binary job with Ghidra attribution while
the World Engine tick continued. Ghidra remains optional for JavaScript, EVM,
and web targets.

Run the separate local REA JavaScript smoke under a compatible Node runtime:

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

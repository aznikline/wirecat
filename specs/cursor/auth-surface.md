# Cursor client-visible auth & transport surface (3.24.12)

Static evidence only — no execution, no network to Cursor backends.
Confidence labels: **confirmed** = literal in shipped bundle with
attribution; **inferred** = presence-level or contextual reasoning;
**unknown** = not statically recoverable.

## Transport

- **Connect-RPC** — confirmed. `@connectrpc/connect` content-type tables
  (`application/connect+proto`, `application/connect+json`,
  `application/proto`, `application/json`, `text/event-stream`) and
  stream/unary/binary parsers live in `cursor-always-local/dist/main.js`;
  `connect-protocol-version` header appears in `out/main.js`.
  `aiserver.v1.*` services are Connect services: unary + server-streaming
  over HTTP POST and SSE.
- **SSE** — confirmed (`HealthService.StreamSSE`,
  `InferenceService.RunInferenceSSE`; `text/event-stream` parsing).
- **Custom HTTP RPC** — remote agent host: literal paths
  `/cursor.remote-agent-host/{CancelRequest,Heartbeat,
  ControllerChallengesChanged,TunnelSettings,WindowUpdate}`
  (daemon.cjs). Host is the tunneled agent host, not a fixed domain.
- **WebSocket / gRPC-web / Twirp** — no markers found (unknown, not
  exhaustively verified).

## Auth headers (confirmed in shipped bundles)

| Header | Where | Role |
|---|---|---|
| `authorization: Bearer …` | cursor-always-local | aiserver bearer token |
| `x-ghost-mode` | out/main.js | privacy/ghost-mode flag |
| `x-client-key` | out/main.js | client key |
| `x-cursor-checksum` | out/main.js | request integrity checksum |
| `x-cursor-client-version` | out/main.js | client version |
| `x-session-id` | out/main.js | session correlation |
| `x-request-id` | all process bundles | universal request id |
| `x-cursor-auth` | daemon.cjs (`REST_MCP_CURSOR_AUTH_HEADER`) | REST MCP gateway auth |
| `x-cursor-agent-transport-mode`, `x-cursor-agent-exclude-tools`, `x-cursor-agent-allowed-tools`, `x-cursor-agent-ws-socket-reuse` | daemon.cjs | agent transport/tool gates |
| `x-cursor-agent-host-tunnel-revisions` | daemon.cjs | remote-host tunneling |
| `x-cursor-rpc-callsite` | daemon.cjs | RPC caller attribution |
| `x-worker-*` family (id, claimed-bc-id, cli-version, host-power-state, …) | daemon.cjs | cloud-agent worker identity |
| `x-sand-box-park`, `x-cursor-mcp-oauth-relayed-loopback` | daemon.cjs | sandbox / OAuth relay |

**Absent in 3.24.12** (do not report as confirmed): `x-cursor-timezone`,
`x-amos`, `x-device-id`, `x-cursor-token`, `x-new-client-key`,
`x-cursor-config-version`, `x-cursor-privacy`.

## Credential storage & acquisition

- `cursorAuth/accessToken`, `cursorAuth/refreshToken` — Electron
  main-process storage keys (out/main.js); likely `storage.json`-backed
  (VS Code globalStorage). No keychain/keytar usage found (**unknown**
  whether OS keychain is involved).
- `CURSOR_AUTH_TOKEN` env — cloud-agent CLI session token (daemon.cjs).
- OIDC-style identity endpoints for cloud-agent workers:
  `/v1/tokens/oidc`, `/v1/meta-data` prefix,
  `/cloud-agent/identity-token/{worker,sand-box}` (daemon.cjs).
- `CURSOR_LOCAL_AGENT_HEADERS` env — user-injected extra headers for
  local-agent calls (`Name: value` lines; supports `{gitOrgRepo}` /
  `{gitBranch}` templating).
- Login flow: `cursor://` deeplink extension (`cursor-deeplink`,
  `onUri` activation); MCP OAuth portal callbacks
  `www.cursor.com/agents/mcp/oauth/callback`,
  `www.cursor.com/bot/mcp/oauth/callback`, `grokbot://mcp/oauth/callback`.
  Readable login/poll routine not recovered — **unknown**.

## Host → role mapping

| Host | Role | Confidence |
|---|---|---|
| `api2.cursor.sh` | app/extension updates (`/updates`, `/extensions-control`), Grok-bot download initiation | confirmed (product.json `updateUrl`; daemon constants) |
| `api3.cursor.sh` | Statsig telemetry proxy (`/tev1/v1`) | confirmed (product.json) |
| `api4.cursor.sh` | aiserver inference fleet | inferred (shared-constants presence in aiserver client bundles) |
| `api5.cursor.sh`, `agent.api5`, `agentn.api5`, `*-gcpp-{uswest,eucentral,apsoutheast}.api5.cursor.sh` | hosted/private-model regional fleet — names constructed dynamically | inferred (fragments in always-local/agent-host constants) |
| `repo42.cursor.sh` | repository/indexing backend | inferred (retrieval + shared constants) |
| `api.cursor.com` | REST MCP gateway (`/rest-mcp/<provider>/mcp`), prompt-quality OIDC audience | confirmed (daemon constants) |
| `api.origin.cursor.com` | Origin MCP (`/mcp`, `/mcp/readonly`) | confirmed (daemon constants) |
| `marketplace.cursorapi.com` | extension gallery (`/_apis/public/gallery`) | confirmed (product.json) |
| `cursor.blob.core.windows.net` | remote server (REH) tarballs | confirmed (product.json template) |
| `downloads.cursor.com` | release artifacts | confirmed |
| `metrics.cursor.sh`, `*.ingest.*.sentry.io` | Sentry telemetry (not RPC) | confirmed |
| `prod.authentication.cursor.sh` | auth service host | confirmed literal (workbench bundles 3.20.21+) |
| `gtm-api.corp.anysphere.co` | internal corp MCP (3.24.12) | confirmed |
| `review.cursor.com`, `review.stg.cursor.com` | legacy review hosts | confirmed (daemon constants) |
| `staging.cursor.sh`, `dev-staging.cursor.sh`, `api.origin-staging.cursor.com`, `staging-marketplace.cursor.sh` | staging fleet — compiled-in per build/track | confirmed literals (out/main.js) |
| `api.playground.cursor.sh` | playground | confirmed literal (agent-host bundle) |

## Service → endpoint mapping

Only these joins are statically determinable:

| Service/flow | Endpoint | Evidence |
|---|---|---|
| update / extension-control | `api2.cursor.sh` | product.json |
| Statsig | `api3.cursor.sh/tev1/v1` | product.json |
| extension gallery | `marketplace.cursorapi.com` | product.json |
| REST MCP providers | `api.cursor.com/rest-mcp/<provider>/mcp` | daemon constants |
| Origin MCP | `api.origin.cursor.com/mcp` | daemon constants |
| `agent.v1.AgentService/UploadLocalAgentRunToPromptQuality` | `api.cursor.com` OIDC audience | daemon constants |
| `aiserver.v1.*` (all others) | **unknown** — candidates `api4`/`repo42`/`api5` | no literal service→host join recovered |
| `agent.v1.*`, `origin.v1.*` | **unknown** — cloud-agent/origin fleet | — |

Feature → RPC map (daemon.cjs feature gates, usable as annotations):
tab→`AiService/StreamCpp`+`FileSyncService`, cmdk→`CmdKService`,
indexing→`RepositoryService/*V2`, share→`DashboardService/ShareConversation`,
scm→`SCMService`/`BackgroundComposerService`,
github-context→`BackgroundComposerService/MakeGithubRequest`,
metrics→`OnlineMetricsService`.

## Caveats

- **Shared constants**: Cursor extension bundles embed the same monorepo
  constants modules (byte-identical webpack modules across bundles).
  A host literal inside a bundle is presence evidence, not proof that
  bundle selects it. Per-host `files` attribution in the catalog marks
  presence only.
- **Endpoint overrides**: no `CURSOR_BACKEND`/`CURSOR_API_URL`-family env
  overrides found; staging/prod selection is compiled-in per build.
- Auth token lifecycle (login/poll/refresh exchange) is **unknown** —
  no `authPoll`/`/api/auth` literals; likely cursor:// deeplink + web flow.

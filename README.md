<div align="center">

**English** · [简体中文](README_zh.md)

# Wirecat

### Statically recover the internal API schema embedded in an app's client code.

**Wirecat extracts the protobuf descriptors and IPC definitions compiled into an installed app's JavaScript — no traffic capture, no execution — and publishes the result as versioned `.proto` files + release diffs. It also audits the Electron attack surface it finds: which privileged IPC handlers are reachable from untrusted content, with evidence.**

[![CI: track-cursor](https://img.shields.io/github/actions/workflow/status/aznikline/wirecat/track-cursor.yml?style=flat-square&label=track-cursor)](https://github.com/aznikline/wirecat/actions/workflows/track-cursor.yml)
[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A518-339933?style=flat-square&logo=nodedotjs&logoColor=white)](#quick-start)
[![Zero dependencies](https://img.shields.io/badge/dependencies-0-5c4ee5?style=flat-square)](#tools)
[![MIT license](https://img.shields.io/badge/license-MIT-f4c430?style=flat-square)](LICENSE)

[Quick start](#quick-start) · [What gets extracted](#what-gets-extracted) · [Catalogs](#catalogs) · [Automation](#automation) · [Legal scope](#scope-and-legal-posture) · [Roadmap](#roadmap)

<code>node tools/extract-bundle-protos.mjs app/out/**/*.js --out catalog.json</code>

</div>

---

When an app is built from protobuf sources, the compiler embeds complete
service descriptors into the shipped JavaScript — every RPC service,
message field, and enum the client knows about survives minification.
That means the client's full server-facing API is recoverable *from the
artifact itself*: no packet capture, no running the app, no guessing at
wire format. Want to build a client for one of these apps, or just know
what its agent protocol looks like? Today that means days of grepping
bundled code by hand — and your notes go stale on the next release.

**Wirecat is a tool that does this extraction mechanically.** It reads the JS
bundles installed with the app (no execution) and produces a *typed catalog* of everything the app
exposes — then a CI job re-runs it on every new release, so the spec stays
current. This repo is both the tool (`tools/`) and the published catalogs it
produces (`catalogs/`, `protos/`, `diffs/`, `specs/`).

```
Cursor.app/out/*.js  ──►  catalogs/cursor/3.26.16.json   (87 services, 17k methods)
                       ──►  protos/cursor/3.26.16/*.proto (usable codegen input)
                       ──►  diffs/cursor-3.24.12-to-3.26.16.md
                       ──►  endpoint host + IPC channel inventory
```

## What it looks like

```proto
// protos/cursor/3.26.16/agent.v1.proto — generated, not hand-written
service AgentHostService {
  rpc CreateSession(SessionCreateRequest) returns (SessionCreateResponse);
  rpc SendMessage(SendMessageRequest) returns (SendMessageResponse);
  rpc WatchSessions(SessionWatchRequest) returns (stream SessionWatchResponse);
  rpc RespondToInteraction(InteractionResponse) returns (InteractionResponseResponse);
  // … 27 more methods, all request/response types fully resolved
}
```

```diff
# diffs/cursor-3.24.12-to-3.26.16.md — what changed between releases
+ aiserver.v1.McpToolService.AddMcpServer          # MCP management went RPC
+ cursor_files.v1.CursorFilesService             # new package
+ scmapi.v0.ScmService                           # new package
~ aiserver.v1.AiService (11 methods changed)
+ endpoint host: api.origin-staging.cursor.com
```

## Quick start

Requires **Node.js 18+** and nothing else — the toolchain is zero-dependency ESM.

```bash
# 1. Point the extractor at any unpacked Electron app's JS bundles
grep -rlE "makeMessageType|typeName:|ipcRenderer|ipcMain|exposeInMainWorld" \
  --include="*.js" /path/to/App.app/Contents/Resources/app > files.txt

# 2. Extract the full surface
node tools/extract-bundle-protos.mjs --files files.txt --out catalog.json

# 3. Diff against a previous version
node tools/diff-catalogs.mjs old.json catalog.json --md

# 4. Emit usable .proto3 files
node tools/emit-proto.mjs catalog.json --out protos/

# 5. Render a readable spec
node tools/render-spec.mjs catalog.json [--packages aiserver.v1,agent.v1]

# 6. Audit the Electron attack surface
node tools/audit-electron.mjs app/out/main.js app/out/**/preload*.js ... --out audit.json --md audit.md

# 7. Diff the attack surface between two releases
node tools/audit-electron.mjs --diff audits/app/old.json audits/app/new.json
```

Static analysis only — target bundles are parsed, never executed.

## What gets extracted

| Surface | Markers recognized | Output |
|---|---|---|
| **protobuf-es** | `makeMessageType`, `makeEnum`, `{typeName, methods}` service literals | services, methods (unary/streaming), messages, enums, fields (numbers, kinds, scalar/message/enum types, presence flags) |
| **protobuf-ts** | `X.typeName="pkg.Msg"`, `X.fields=…newFieldList`, webpack `t.X=I` exports | same shape; namespace-member refs resolved positionally, ambiguity reported as `unresolved:` |
| **protobufjs** | `setJSON`/`addJSON`/`fromJSON` descriptor literals | full descriptor walk — nested types, oneofs, `keyType` maps, streaming methods |
| **Electron IPC** | `ipcRenderer`/`ipcMain`/`webContents`/`webFrame` literal calls, `exposeInMainWorld` | channels with send/invoke/listener/handler counts + call sites; exposed globals; namespace-filtered channel vocabulary |
| **Endpoints** | literal `https://` URLs | URL inventory grouped by host, per-host source-file attribution, credential material auto-redacted |

Honesty guarantees: unresolved or ambiguous references are emitted as
`unresolved:<ident>` — never guessed. Emitted `.proto` files keep gaps visible
as `Unresolved_*` placeholders.

## Attack-surface audit

`tools/audit-electron.mjs` answers the question bounty hunters currently
answer by hand: *is a privileged `ipcMain` handler reachable from untrusted
content, and does attacker input reach a dangerous sink?*

It is **not** whole-program taint analysis (infeasible on 50 MB minified
bundles) — it is boundary-protocol reachability: the trust-boundary edges
that survive minification, joined with a confidence tier on every finding
(`observed` / `derived` / `inferred` / `unknown`). Unknowns stay unknown.

What it detects, with real output from Cursor 3.26.16:

- **contextBridge exposure shape** — distinguishes a raw `ipcRenderer`
  passthrough (critical, the Discord-2020-RCE class) from Cursor's actual
  posture: a *gated* wildcard that forwards caller-controlled channel names
  but enforces a `vscode:` prefix allowlist
- **the synthesized reachability verdict** — connects the bridge to what it
  gates: `bridgeable-privileged-surface` — a compromised renderer can reach
  **52 registered `registerChannel` service channels + transport channels**
- **`webPreferences` flags** — `contextIsolation`, `nodeIntegration`,
  `sandbox`, `webSecurity`, `webviewTag`, including literals that appear
  outside parsed option blocks
- **handler-level checks** — sender-validation presence
  (`senderFrame`/`getURL`/origin checks) × dangerous-sink classes
  (code exec, navigation, file write, session/network, host bridge)
- **TLS posture** — certificate bypass vs. *correctly classified* custom
  pinning (naive patterns false-positive on every VS Code-family app;
  verified on Devin.app)
- **attack-surface diff** — `audit-electron.mjs --diff` reports
  findings + new/removed privileged service channels between releases

Validation: the Discord-2020-RCE shape (unisolated window + raw
`ipcRenderer` bridge + unvalidated `child_process` handler) replays as
`critical` + `high` findings; sender-validated handlers are correctly
exempted. Audits for all tracked apps live in `audits/`.

## Catalogs

| App | Surface | Notes |
|---|---|---|
| **Cursor** `3.14.7` → `3.26.16` | 87 services / 50k+ messages / 17k+ methods + IPC + endpoints | `aiserver.v1`, `agent.v1`, `origin.v1`, `cursor_files.v1`, `scmapi.v0` — tracked continuously by CI |
| **Devin.app** `3.10.67` | 29 services / 6.9k protobuf-ts messages | validated the protobuf-ts pass on a different codegen |
| **VS Code** `1.141.0` | 186 IPC channels | correct negative — VS Code ships no protobuf services |
| **Signal Desktop** `8.32.0` | 360 IPC channels (preload bridge *is* its client API) | protos live in a native Rust lib — honest IPC-only catalog |
| **Slack** `4.52.182` | bridge IPC + endpoint vocabulary | thin shell — real surface is web-delivered, see [target assessment](docs/target-assessment.md) |
| **Discord** `0.0.418` | updater/splash IPC | thin shell — same acquisition caveat |

`specs/cursor/auth-surface.md` documents the auth layer: Connect-RPC transport
evidence, the full header inventory (`x-cursor-checksum`, `x-ghost-mode`,
`x-client-key`, …), credential storage keys, and a confidence-labeled
host → role / service → endpoint map.

## Layout

```
catalogs/<app>/<version>.json   machine catalog (services/messages/enums/ipc/endpoints)
protos/<app>/<version>/         emitted .proto3 files — usable codegen input
specs/<app>/<version>-*.md      rendered spec docs + auth surface
diffs/<app>-<a>-to-<b>.md       release-over-release protocol evolution
audits/<app>/<version>.{json,md} attack-surface findings + per-release surface diff
docs/target-assessment.md       which apps fit the pipeline (fat vs thin bundles)
tools/                          extractor · differ · renderer · proto emitter · auditor · release tracker
```

## Automation

`.github/workflows/track-cursor.yml` polls the official stable feed
(`api2.cursor.sh/updates/api/download/stable/darwin-arm64/cursor`) every 6 h —
no scraping, no Vercel-protected website APIs. On a new `version`+`commitSha`
it downloads the release zip, extracts the app, regenerates
catalog + spec + diff + protos, and commits. `catalogs/cursor/LATEST`
holds the newest tracked version. The same flow runs standalone via
`tools/track-cursor-release.sh`.

## Scope and legal posture

- **Interop for paying users.** These artifacts document protocols your own
  licensed client already speaks. No paywall, trial, quota, or machine-ID
  bypass — that content is out of scope by design.
- **Client-visible surface only.** Server-side logic cannot be recovered from
  client bundles and is never claimed.
- **Verbatim extraction.** Field numbers, names, and shapes come from shipped
  code; ambiguity is reported (`unresolved:`, notes), not smoothed over.
- **Static analysis only.** Bundles are parsed, never executed.
- **Credential hygiene.** Sentry DSN keys and URL userinfo are redacted in
  published catalogs.

## Roadmap

- Deeper audit reachability: cross-module DI/service-token resolution for
  `registerChannel` bodies (currently surface inventory + in-file resolution;
  full method-level sink analysis needs module-table recovery)
- Renderer-side exposure scoping: which remote-loading *window* can reach
  which bridge (needs window↔preload↔webPreferences joins)
- Auth-flow association: bind headers/credential keys to specific services
- Live validation of the protobufjs pass (Discord web bundles are auth-gated)
- Dynamic IPC channel expansion (runtime-built names like `DISCORD_${event}`,
  `redux-action` multiplexing — currently literal-capture only, documented)
- New fat-bundle targets (Windsurf feed verified; more Electron apps welcome — open an issue)

## Documentation

- [Target assessment](docs/target-assessment.md) — which apps fit the pipeline and why
- [Cursor auth surface](specs/cursor/auth-surface.md) — transport, headers, hosts, confidence labels
- [Service spec example](specs/cursor/3.26.16-services.md) — 87 services × 2,285+ methods rendered

## FAQ

**Can I build a Cursor client from this?**
The catalogs give you the protocol surface — services, message shapes,
transport hints. Auth token acquisition for *your own account* and the
runtime behavior are yours to implement; the legal line above applies.

**Does it work on non-Electron apps?**
Any shipped JS bundle works for the protobuf passes. IPC extraction needs
Electron (`ipcRenderer`/`ipcMain`/`contextBridge` markers).

**What about Slack/Discord protocols?**
Their `.app` bundles are thin shells — the real client is web-delivered
behind auth. Wirecat catalogs what the shipped artifact honestly contains
(bridge IPC + endpoints) and documents the gap rather than pretending.

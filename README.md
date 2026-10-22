<div align="center">

**English** · [简体中文](README_zh.md)

# Wirecat

### Versioned internal-protocol catalogs for desktop applications — "SteamTracking for app protocols."

**Every shipped app carries its own RPC contract. Wirecat reads it, versions it, diffs it.**

[![CI: track-cursor](https://img.shields.io/github/actions/workflow/status/aznikline/wirecat/track-cursor.yml?style=flat-square&label=track-cursor)](https://github.com/aznikline/wirecat/actions/workflows/track-cursor.yml)
[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A518-339933?style=flat-square&logo=nodedotjs&logoColor=white)](#quick-start)
[![Zero dependencies](https://img.shields.io/badge/dependencies-0-5c4ee5?style=flat-square)](#tools)
[![MIT license](https://img.shields.io/badge/license-MIT-f4c430?style=flat-square)](LICENSE)

[Quick start](#quick-start) · [What gets extracted](#what-gets-extracted) · [Catalogs](#catalogs) · [Automation](#automation) · [Legal scope](#scope-and-legal-posture) · [Roadmap](#roadmap)

<code>node tools/extract-bundle-protos.mjs app/out/**/*.js --out catalog.json</code>

</div>

---

Every commercial desktop app — IDEs, chat clients, AI tools, design apps — ships its own
internal RPC surface inside its JavaScript/Electron bundles: protobuf service
registrations, message and enum definitions, Electron IPC contracts, backend
endpoints, auth headers. Today, every project that wants to interoperate re-derives
that same `.proto` surface by hand — and it rots on every release.

Wirecat automates the extraction: **bundle in → typed catalog out**, diffed
release-over-release, and emitted back as usable `.proto` files. It is a spec
pipeline, not a one-shot reverse engineering exercise — the catalog is the product.

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
docs/target-assessment.md       which apps fit the pipeline (fat vs thin bundles)
tools/                          extractor · differ · renderer · proto emitter · release tracker
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

# Wirecat

**Versioned internal-protocol catalogs for desktop applications — "SteamTracking for app protocols."**

Every commercial desktop app (IDEs, chat, AI tools, design apps) ships its own
internal RPC surface inside its JavaScript/Electron bundles: protobuf service
registrations, message/enum definitions, IPC contracts, auth flows. Today every
project that wants to interoperate re-derives the same `.proto` surface by hand
and rots on every release.

Wirecat automates the extraction: bundle in → typed catalog out (services,
methods, request/response types, enums, fields, Electron IPC channels),
diffed release-over-release.

## Status

- **Cursor** is the first catalog: `aiserver.v1` (76 services), `agent.v1` (9),
  `origin.v1` (2) — 2,285+ methods — extracted from macOS arm64 releases
  3.14.7 → **3.26.16** (tracked continuously, see Automation).
- See `specs/cursor/` for rendered service specs and `diffs/` for
  version-over-version protocol evolution.
- **Second-app validation**: the extractor is not Cursor-specific —
  `catalogs/devin-app/3.10.67.json` recovers 29 services / 6,926 protobuf-ts
  messages / 2,092 methods plus its IPC surface; `catalogs/vscode/1.141.0.json`
  confirms the IPC extractor on upstream VS Code (protobuf-es absence is a
  correct negative: VS Code proper ships no protobuf services).

## Layout

```
catalogs/<app>/<version>.json   machine catalog (services/messages/enums/ipc)
specs/<app>/<version>-*.md      rendered spec docs
diffs/<app>-<a>-to-<b>.md       protocol evolution reports
tools/                          extractor + differ + renderer + release tracker
```

## Tools

```bash
# Extract proto surface + IPC surface from one or more JS bundles
node tools/extract-bundle-protos.mjs app-bundle.js [more.js ...] --out catalog.json
node tools/extract-bundle-protos.mjs --files bundle-list.txt --out catalog.json

# Diff two catalogs (services, messages, enums, IPC channels)
node tools/diff-catalogs.mjs catalogs/cursor/3.24.12.json catalogs/cursor/3.26.16.json --md

# Render spec markdown
node tools/render-spec.mjs catalogs/cursor/3.26.16.json [--packages aiserver.v1,agent.v1] [--full]

# Track a new Cursor stable release end-to-end (also usable standalone)
tools/track-cursor-release.sh
```

## What gets extracted

**Protocol surface** — supported generated-code shapes:

- protobuf-es `makeMessageType` / `makeEnum` field lists (verbatim field
  numbers, kinds, scalar/message/enum types, presence flags)
- protobuf-ts class statics (`X.typeName="pkg.Msg"` + `X.fields=...newFieldList`
  message shapes) and webpack namespace exports (`t.FooRequest=Class` member
  resolution, ambiguity reported as `unresolved:`)
- `{typeName, methods}` GenService literals with `I:`/`O:` type refs and
  `MethodKind` streaming kinds

**Electron IPC surface** — literal call sites for `ipcRenderer`/`ipcMain`/
`webContents`/`webFrame` (`send`/`invoke`/`on`/`handle`/`postMessage`) with
send/invoke/listener/handler counts per channel, `contextBridge
exposeInMainWorld` globals, and namespace-qualified channel vocabulary
(`vscode:*`, `cursor:*`, …) filtered against real call sites to control
false positives.

Unresolved or ambiguous references are reported as `unresolved:<ident>`
rather than guessed.

## Automation

`.github/workflows/track-cursor.yml` polls the official stable feed
(`api2.cursor.sh/updates/api/download/stable/darwin-arm64/cursor`) every 6h.
On a new `version`+`commitSha` it downloads the release zip, extracts the
app, regenerates catalog + spec + diff, and commits — no Vercel-protected
website APIs involved. `catalogs/cursor/LATEST` holds the newest tracked
version.

## Scope and legal posture

- **Interop for paying users**: artifacts document protocols your own licensed
  client speaks. No bypass of paywalls, trials, quotas, or machine-ID gates —
  that content is out of scope by design.
- Catalogs describe the *client-visible* surface. Server-side logic cannot be
  recovered from client bundles and is never claimed.
- Field numbers, names, and shapes are extracted verbatim from shipped code;
  where the bundle is ambiguous, the catalog says so (`unresolved:`, notes).
- Static analysis only — target bundles are parsed, never executed.

## Roadmap

- Endpoint + auth-flow correlation layer (bind services to URLs/credentials)
- More apps: Slack, Discord, Figma desktop, Linear, Notion, AI tooling
- Dynamic IPC patterns: channel names built at runtime (template concat,
  computed args) are documented gaps — only literal channels are cataloged
- `.proto` file emission from catalogs (interoperable codegen input)

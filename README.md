# Wirecat

**Versioned internal-protocol catalogs for desktop applications — "SteamTracking for app protocols."**

Every commercial desktop app (IDEs, chat, AI tools, design apps) ships its own
internal RPC surface inside its JavaScript/Electron bundles: protobuf-es service
registrations, message/enum definitions, IPC contracts, auth flows. Today every
project that wants to interoperate re-derives the same `.proto` surface by hand
and rots on every release.

Wirecat automates the extraction: bundle in → typed catalog out (services,
methods, request/response types, enums, fields), diffed release-over-release.

## Status

- **Cursor** is the first catalog: `aiserver.v1` (76 services), `agent.v1` (9),
  `origin.v1` (2) — 2,285+ methods — extracted from macOS arm64 releases
  3.14.7 → 3.24.12.
- See `specs/cursor/` for rendered service specs and `diffs/` for
  version-over-version protocol evolution.

## Layout

```
catalogs/<app>/<version>.json   machine catalog (services/messages/enums)
specs/<app>/<version>-*.md      rendered spec docs
diffs/<app>-<a>-to-<b>.md       protocol evolution reports
tools/                          extractor + differ + renderer
```

## Tools

```bash
# Extract proto surface from one or more JS bundles
node tools/extract-bundle-protos.mjs app-bundle.js [more.js ...] --out catalog.json

# Diff two catalogs
node tools/diff-catalogs.mjs catalogs/cursor/3.23.23.json catalogs/cursor/3.24.12.json --md

# Render spec markdown
node tools/render-spec.mjs catalogs/cursor/3.24.12.json [--packages aiserver.v1,agent.v1] [--full]
```

Supported generated-code shapes: protobuf-es `makeMessageType`/`makeEnum`,
class-bound GenMessage statics (`X.typeName=` aliases + WKT classes), and
`{typeName, methods}` GenService literals. Unresolved cross-file references
are reported as `unresolved:<ident>` rather than guessed.

## Scope and legal posture

- **Interop for paying users**: artifacts document protocols your own licensed
  client speaks. No bypass of paywalls, trials, quotas, or machine-ID gates —
  that content is out of scope by design.
- Catalogs describe the *client-visible* surface. Server-side logic cannot be
  recovered from client bundles and is never claimed.
- Field numbers, names, and shapes are extracted verbatim from shipped code;
  where the bundle is ambiguous, the catalog says so (`unresolved:`, notes).

## Roadmap

- IPC/contextBridge surface extraction (Electron apps)
- Endpoint + auth-flow correlation layer
- More apps: Slack, Discord, Figma desktop, Linear, Notion, AI tooling
- CI pipeline: new release detected → catalog + diff published

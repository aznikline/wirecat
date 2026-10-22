# Target assessment — which apps fit the wirecat pipeline

The release-feed pipeline works when the **shipped artifact contains the
full client surface**. Two acquisition models exist in the wild:

## Fat-bundle apps (pipeline works today)

| App | Surface in shipped bundle | Feed |
|---|---|---|
| Cursor | protobuf-es services + IPC + endpoints | `api2.cursor.sh` JSON (tracked) |
| VS Code | IPC (correct negative for protobuf) | GitHub releases |
| Devin.app | protobuf-ts services + IPC + endpoints | — |
| Windsurf/Codeium family | protobuf-ts (same lineage as Devin) | `windsurf-stable.codeium.com` JSON |
| Obsidian | IPC only (no protobuf — local-first) | GitHub releases, raw `.asar.gz` published |

## Thin-shell apps (ship a launcher; real code is web-delivered)

| App | Shipped bundle contains | Real client code lives at |
|---|---|---|
| Slack (4.52.182) | 9.4MB asar: bootstrapper + IPC shell (`slackPlatform`/`desktop` globals, `redux-action` bridge channel) | `app.slack.com` web bundles — behind auth |
| Discord (0.0.418) | 519-line bundle.js: splash/updater IPC (`DISCORD_SPLASH_*`, `DISCORD_${event}` templates) | `~/Library/Application Support/discord` runtime modules + web app |

For thin-shell apps the shipped-artifact catalog is honest but shallow
(IPC bridge + endpoint vocabulary only). Cataloging the real protocol
surface requires a different acquisition stage — web-bundle or
runtime-module fetching, typically behind authentication, which is a
separate legal/technical posture (documented gap, not planned work).

## protobuf codegen shapes seen so far

| Shape | Marker | Seen in |
|---|---|---|
| protobuf-es | `makeMessageType`/`makeEnum` + `{typeName,methods}` literals | Cursor |
| protobuf-ts | `X.typeName=` + `X.fields=...newFieldList`, webpack `t.X=I` exports | Devin/Exafunction |
| protobufjs | `Root.fromJSON`/`setJSON`/`addJSON` descriptor literals | implemented; validated on synthetic descriptors (no live target yet — Discord web bundles carry it but are auth-gated) |
| native-bundled proto | descriptors in Rust/native lib, not JS | Signal Desktop 8.32.0 — its `.asar` yields IPC-only (360 channels, preload `Signal`/`SignalContext` globals); protos live in `@signalapp/libsignal-client` native code |
| none | correct negative | VS Code, Obsidian, Slack/Discord shells |

## Extractor gaps documented

- **Dynamic IPC channels**: Slack and Discord both build channel names at
  runtime (`redux-action` multiplexing, `DISCORD_${event}` templates,
  `${U.I0.WindowIdRequest}-${e}`). Literal pass captures the template
  literals; the channel-space expansion is not recovered — honest unknown.
- **protobufjs descriptors**: pass implemented (`setJSON`/`addJSON`/
  `fromJSON` literals → nested descriptor walk with scope-relative ref
  resolution, oneofs, maps, streaming methods). Awaiting a live target —
  Discord web bundles are the natural first validation once an acquisition
  path exists.

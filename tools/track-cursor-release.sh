#!/usr/bin/env bash
# Track a new Cursor stable release into the wirecat catalog.
# Usage: tools/track-cursor-release.sh [--app-dir <extracted-app>] [--dry-run]
# Env: CURSOR_PLATFORM (default darwin-arm64), TRACKER_DIR (default repo root)
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
PLATFORM="${CURSOR_PLATFORM:-darwin-arm64}"
APP_DIR=""
DRY=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY=1 ;;
    --app-dir=*) APP_DIR="${arg#*=}" ;;
  esac
done

FEED="https://api2.cursor.sh/updates/api/download/stable/${PLATFORM}/cursor"
META=$(curl -fsS --max-time 30 "$FEED")
VERSION=$(printf '%s' "$META" | python3 -c 'import json,sys; print(json.load(sys.stdin)["version"])')
DOWNLOAD=$(printf '%s' "$META" | python3 -c 'import json,sys; print(json.load(sys.stdin)["downloadUrl"])')
COMMIT=$(printf '%s' "$META" | python3 -c 'import json,sys; print(json.load(sys.stdin)["commitSha"])')
ZIP_URL="${DOWNLOAD%.dmg}.zip"

echo "[track] latest stable: $VERSION ($COMMIT)"

CAT="$REPO/catalogs/cursor/$VERSION.json"
if [ -f "$CAT" ]; then
  echo "[track] catalog already exists for $VERSION; nothing to do"
  exit 0
fi
[ "$DRY" = 1 ] && { echo "[dry-run] would download+extract $ZIP_URL"; exit 0; }

if [ -z "$APP_DIR" ]; then
  WORK=$(mktemp -d)
  trap 'rm -rf "$WORK"' EXIT
  echo "[track] downloading $ZIP_URL"
  curl -fSL --retry 3 -o "$WORK/cursor.zip" "$ZIP_URL"
  unzip -q "$WORK/cursor.zip" -d "$WORK/x"
  APP_DIR=$(find "$WORK/x" -type d -path "*/Contents/Resources/app" | head -1)
fi
[ -d "$APP_DIR" ] || { echo "[track] ERROR: app dir not found"; exit 1; }

echo "[track] scanning JS bundles in $APP_DIR"
LIST=$(mktemp)
(cd "$APP_DIR" && grep -rlE 'makeMessageType|typeName:|ipcRenderer|ipcMain|exposeInMainWorld' --include='*.js' . | sed "s|^\./|$APP_DIR/|" > "$LIST")

mkdir -p "$REPO/catalogs/cursor" "$REPO/diffs" "$REPO/specs/cursor"
node "$REPO/tools/extract-bundle-protos.mjs" --files "$LIST" --out "$CAT"
rm -f "$LIST"

PREV=$(ls "$REPO"/catalogs/cursor/*.json | grep -v "/$VERSION.json" | sort -V | tail -1)
if [ -n "$PREV" ]; then
  PV=$(basename "$PREV" .json)
  node "$REPO/tools/diff-catalogs.mjs" "$PREV" "$CAT" --md > "$REPO/diffs/cursor-${PV}-to-${VERSION}.md"
  echo "[track] diff written: diffs/cursor-${PV}-to-${VERSION}.md"
fi
node "$REPO/tools/render-spec.mjs" "$CAT" > "$REPO/specs/cursor/${VERSION}-services.md"
node "$REPO/tools/emit-proto.mjs" "$CAT" --out "$REPO/protos/cursor/${VERSION}" --packages aiserver.v1,agent.v1,origin.v1,cursor_files.v1,scmapi.v0
echo "$VERSION" > "$REPO/catalogs/cursor/LATEST"
echo "[track] done: $VERSION"

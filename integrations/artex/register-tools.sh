#!/usr/bin/env bash
# Register wirecat tools into a running ARTEX instance.
# Env: ARTEX_URL (default http://localhost:8787), ARTEX_USER, ARTEX_PASSWORD,
#      WIRECAT_DIR (path inside the agent container, default /work/wirecat)
set -euo pipefail
ARTEX_URL="${ARTEX_URL:-http://localhost:8787}"
ARTEX_USER="${ARTEX_USER:-ARTEX}"
ARTEX_PASSWORD="${ARTEX_PASSWORD:?set ARTEX_PASSWORD}"
WIRECAT_DIR="${WIRECAT_DIR:-/work/wirecat}"
HERE="$(cd "$(dirname "$0")" && pwd)"

TOKEN=$(curl -sf -X POST "$ARTEX_URL/api/auth/login" \
  -H 'content-type: application/json' \
  -d "{\"username\":\"$ARTEX_USER\",\"password\":\"$ARTEX_PASSWORD\"}" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["token"])')

# Substitute the wirecat path into the tool spec.
SPEC=$(sed "s|{wirecat_dir}|$WIRECAT_DIR|g" "$HERE/wirecat_audit.tool.json")

KEY=$(echo "$SPEC" | python3 -c 'import json,sys;print(json.load(sys.stdin)["key"])')
if curl -sf -X PUT "$ARTEX_URL/api/tools/custom/$KEY" \
     -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
     -d "$SPEC" >/dev/null 2>&1; then
  echo "[wirecat] updated tool: $KEY"
else
  curl -sf -X POST "$ARTEX_URL/api/tools/custom" \
    -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
    -d "$SPEC" >/dev/null && echo "[wirecat] created tool: $KEY"
fi

# Dry-run the registered spec to prove the mount works end-to-end.
echo "$SPEC" | python3 -c '
import json,sys
t=json.load(sys.stdin)
print(json.dumps({"kind":t["kind"],"exec":t["exec"],"params":{"target":"/work","app":"smoke","version":"0"}}))' \
| curl -sf -X POST "$ARTEX_URL/api/tools/custom/test" \
    -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' -d @- \
| python3 -c 'import json,sys; r=json.load(sys.stdin); print("[wirecat] dry-run:", "FAIL" if r.get("is_error") else "OK")'

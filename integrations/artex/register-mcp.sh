#!/usr/bin/env bash
# Register the wirecat MCP stdio server into a running ARTEX instance and make
# it visible to the given agents.
# Env: ARTEX_URL (default http://localhost:8787), ARTEX_USER, ARTEX_PASSWORD,
#      WIRECAT_DIR (path inside the agent container, default /work/wirecat)
#      AGENTS (comma-separated agent keys, default "worker,mainagent,pentest")
set -euo pipefail
ARTEX_URL="${ARTEX_URL:-http://localhost:8787}"
ARTEX_USER="${ARTEX_USER:-ARTEX}"
ARTEX_PASSWORD="${ARTEX_PASSWORD:?set ARTEX_PASSWORD}"
WIRECAT_DIR="${WIRECAT_DIR:-/work/wirecat}"
AGENTS="${AGENTS:-worker,mainagent,pentest}"

TOKEN=$(curl -sf -X POST "$ARTEX_URL/api/auth/login" \
  -H 'content-type: application/json' \
  -d "{\"username\":\"$ARTEX_USER\",\"password\":\"$ARTEX_PASSWORD\"}" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["token"])')

# args MUST be a real JSON array — a string value makes ARTEX spawn `node`
# with no script arg (REPL on stdin, never answers → discovery timeout).
MCP_ID=$(curl -sf -X POST "$ARTEX_URL/api/mcp" \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d "{\"name\":\"wirecat\",\"transport\":\"stdio\",\"command\":\"node\",\"args\":[\"$WIRECAT_DIR/tools/mcp-server.mjs\"],\"env\":{},\"enabled\":true}" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
echo "[wirecat] registered MCP server id=$MCP_ID (discovery runs server-side)"

TOOLS=$(curl -sf "$ARTEX_URL/api/mcp/$MCP_ID/tools" -H "Authorization: Bearer $TOKEN")
echo "[wirecat] discovered tools: $(echo "$TOOLS" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)["tools"]))')"

# MCP tools only reach an agent if the server is made visible to it.
IFS=',' read -ra KEYS <<< "$AGENTS"
for AG in "${KEYS[@]}"; do
  SKILLS=$(curl -sf "$ARTEX_URL/api/agents/$AG/visibility" \
    -H "Authorization: Bearer $TOKEN" \
    | python3 -c 'import json,sys; print(json.dumps(json.load(sys.stdin).get("skill") or []))')
  curl -sf -X PUT "$ARTEX_URL/api/agents/$AG/visibility" \
    -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
    -d "{\"mcp\":[$MCP_ID],\"skill\":$SKILLS}" >/dev/null
  echo "[wirecat] MCP visible to agent: $AG"
done

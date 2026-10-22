# Integrations

Wirecat is the capability core: static extraction + audit of shipped app
bundles. Anything that can run shell commands (agent harnesses, CI, MCP
clients) can consume it. This directory holds per-harness adapters —
thin recipes, not code forks.

| Adapter | Harness | Files |
|---|---|---|
| `artex/` | ARTEX agentic pentest framework | custom-tool spec + task prompt template + registration script |

Planned: an MCP stdio server wrapping audit/diff/extract for any
MCP-capable agent (Claude Code, Devin, ARTEX's mcphttp).

## The pattern an adapter should encode

```
harness agent ──task prompt──▶ wirecat_audit (1 call = full surface)
                                    │
                                    ▼
                          findings w/ confidence labels
                                    │
                                    ▼
              agent verifies each finding by reading flagged files
              (the step that must stay slow — it burns false positives)
                                    │
                                    ▼
                          report_finding / CVE-grade writeup
```

Measured on ARTEX + glm-5.3 (Oct 2026): manual enumeration ≈318 Bash
calls / ~30min before first finding → with wirecat_audit first call:
attack surface in <3min, first verified finding at ~24min, 1 critical.

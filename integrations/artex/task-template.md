# Task prompt template — Electron attack-surface audit via wirecat

Measured-good shape (the step ordering matters; without the explicit
REQUIRED first step, agents default to manual grep and burn 10× the
calls re-deriving the surface):

```
Audit the Electron app bundle at {TARGET_DIR} ({APP} {VERSION}).

STEP 1 - REQUIRED: call wirecat_audit(target={TARGET_DIR}, app={APP},
version={VERSION}) BEFORE any manual analysis. It is the dedicated
attack-surface scanner and costs one call instead of hundreds of greps.

STEP 2: verify each critical/high finding by reading the flagged files —
confirm or reject with verbatim evidence. Do not trust the tool's
verdict; check the actual code path.

STEP 3: report findings via report_finding with the strongest
exploitation chain per app. Label confidence (observed/derived/unknown).
```

Notes for the operator:

- Target must be inside the container/sandbox the agent's Bash can reach —
  mount the extracted bundle as a compose volume (`- /host/path:/work/name:ro`).
- `seed_first_intent: true` + `coverage_enabled: false` are correct for
  static-file tasks (no assets to discover, no sites to scope).
- Agent will invent ITS OWN channel names differently from the tool's —
  that's fine; it verifies reachability, not labels.
- Baseline calibration (glm-5.3, Oct 2026): enumeration ~3min vs ~30min
  manual; verification dominates total time (~20min/app) by design.

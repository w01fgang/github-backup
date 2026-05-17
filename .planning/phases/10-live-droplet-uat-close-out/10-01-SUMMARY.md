---
phase: 10-live-droplet-uat-close-out
plan: 01
status: complete
completed: 2026-05-17
commits:
  - 39299e4
requirements:
  - VALID-01
  - VALID-02
  - VALID-03
key_files:
  created:
    - scripts/uat-runner.ts
    - .planning/phases/10-live-droplet-uat-close-out/10-VERIFICATION.md
  modified:
    - package.json
---

# Plan 10-01 Summary — UAT runner + verification skeleton

## What shipped

- **`scripts/uat-runner.ts`** (729 lines) — single entry point for the 21
  outstanding human UAT scenarios across v1.0 Phases 01 (8), 03 (6),
  04 (4) plus 3 Phase 8 deferred live-validation items.
  - Inline `const SCENARIOS: Scenario[]` manifest covering all 21 IDs:
    `p01-01..p01-08`, `p03-01..p03-06`, `p04-01..p04-04`, `p8d-09..p8d-11`.
  - Strict-floor classification per D-02: 7 entries `mode: "manual"` (any
    infrastructure mutation — DNS create, real push, re-bootstrap, destroy,
    firewall drift/extras, ref-mismatch inject); 14 entries `mode: "scripted"`
    (read-only assertions and pure-script checks).
  - Placeholder substitution: `{{cfg.X}}` (dotted path through Config) and
    `{{droplet.Y}}` (id|ip|name|region from DropletInfo). Bails loudly on
    unresolved placeholders.
  - Step executor uses `spawnSync("bash", ["-lc", cmd])` with per-step
    `timeoutSec` (default 60). Captures stdout/stderr, classifies failure
    reason (spawn error / signal / exit mismatch / stdout regex miss).
  - Survey mode (D-01): iterates ALL filtered scenarios — does NOT bail
    fast. Records each result, prints markdown summary at end.
  - Exit codes per D-01: `0` = every scripted passed AND every manual line
    emitted; `1` = any scripted failed; `2` = runner crashed (uncaught).
  - CLI: `--phase 01|03|04|8-deferred|all` (default `all`), `--scenario <id>`,
    `--no-color`, `--help`.
  - Reuses existing libs only — `loadConfig` + `loadDropletInfo` + `bail`
    from `scripts/lib/config.ts`. Zero new runtime deps.
- **`package.json`** — `"uat": "tsx scripts/uat-runner.ts"` alias inserted
  between `"status"` and `"verify:phase-1"` so live-droplet commands stay
  grouped.
- **`.planning/phases/10-live-droplet-uat-close-out/10-VERIFICATION.md`** —
  skeleton with all 9 D-03 sections: Summary, Phase 01/03/04/8-deferred
  Results, STATE.md Gap Resolution, Failure Triage Table, Inline Fixes,
  Spawned Bug-Fix Phases. All counts at `0`, all result tables template-
  only. `runtime_commit` placeholder unset — 10-02 fills it.

## Verification (offline, no live droplet)

- `test -f scripts/uat-runner.ts` → 0
- `npx tsc --noEmit` → 0
- `npx tsx scripts/uat-runner.ts --help` → 0; stdout contains all 21
  scenario IDs.
- Without `.droplet.json`: `npx tsx scripts/uat-runner.ts --phase all`
  emits exactly 21 outcome lines (`✓`/`✗`/`…`); exits 1; never crashes (2).
- Without `.droplet.json`: `npx tsx scripts/uat-runner.ts --phase 01`
  shows `✗  p01-02 failed: droplet unreachable`; exits 1.
- Without `.droplet.json`: `npx tsx scripts/uat-runner.ts --scenario p01-08`
  (manual-only) → 0.
- `grep -c '"uat":' package.json` → 1
- `grep -c '## Failure Triage Table' 10-VERIFICATION.md` → 1
- `grep -c '## Spawned Bug-Fix Phases' 10-VERIFICATION.md` → 1
- Pre-commit hook (Phase 8 README/manifest sync) → pass without
  `--no-verify`.

## Deviations from plan

One small correctness fix not in the plan: `loadDropletInfo()` calls
`bail()` (which `process.exit(1)`s) when `.droplet.json` is absent, so a
naive `try { loadDropletInfo() } catch { droplet = null }` fails the
"runner survives missing droplet" acceptance. Runner now does an
`fs.existsSync(dropletPath)` pre-check before calling `loadDropletInfo()`,
matching the intent ("droplet best-effort") rather than the literal
sketch in the plan.

## Self-Check: PASSED

All acceptance criteria from 10-01-PLAN.md tasks 01-01 / 01-02 / 01-03
pass against `master @ 39299e4`.

## What this unblocks

10-02 (live-droplet execution) and 10-03 (failure triage). Both are
`autonomous: false` — wave 2 requires a live DigitalOcean droplet plus
operator action on 7 manual scenarios; wave 3 triages failures into
inline fixes or new phases. Execute-phase pipeline must STOP here and
hand off to an operator session.

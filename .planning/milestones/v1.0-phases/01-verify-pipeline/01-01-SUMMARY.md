---
phase: 01-verify-pipeline
plan: 01
subsystem: foundation
tags: [refactor, scaffolding, scripts, doctl, ssh]
requires: []
provides:
  - "scripts/lib/{ssh,doctl,config}.ts shared helpers"
  - "scripts/destroy-droplet.ts (D-09 scope)"
  - "npm scripts: smoke-test, verify:phase-1, destroy-droplet"
affects:
  - scripts/create-droplet.ts
  - scripts/bootstrap-droplet.ts
  - package.json
tech-stack:
  added: []
  patterns:
    - "Verbatim helper extraction (no signature change)"
    - "id-only droplet lookup at destroy (T-01-01-01)"
    - "--yes flag bypass for non-interactive smoke runner"
key-files:
  created:
    - scripts/lib/config.ts
    - scripts/lib/ssh.ts
    - scripts/lib/doctl.ts
    - scripts/destroy-droplet.ts
  modified:
    - scripts/create-droplet.ts
    - scripts/bootstrap-droplet.ts
    - package.json
decisions:
  - "Kept existing scpFile signature (ip,user,keyPath,localFile,remotePath) over plan's frontmatter signature — plan body says 'use EXACT current implementations'"
  - "Reused existing tsconfig.json (commonjs/ES2022, strict) — plan said 'create only if absent'"
  - "loadConfig validates the full superset of required fields, not the historical bootstrap subset — single config file, single contract"
metrics:
  duration_min: 5
  tasks_completed: 3
  completed: 2026-05-01
---

# Phase 01 Plan 01: Foundation Summary

Extracted shared SSH/doctl/config helpers into `scripts/lib/`, added the `destroy-droplet` script (D-09 scope), and pre-wired all three new npm scripts so plans 02 + 03 land in non-overlapping files.

## What Was Built

### Task 1 — Shared lib extraction (commit `5c7d3d8`)

Moved helpers verbatim out of the two existing TS scripts into `scripts/lib/`:

| File | Exports |
|------|---------|
| `scripts/lib/config.ts` | `loadConfig`, `loadDropletInfo`, `bail`, `Config`, `DropletInfo` |
| `scripts/lib/ssh.ts`    | `sshFlags`, `sshRun`, `scpFile`, `waitForSsh`, `runVisible`, `runCapture`, `expandHome`, `sleep` |
| `scripts/lib/doctl.ts`  | `doctlJson`, `first`, `publicIp` |

`scripts/create-droplet.ts` and `scripts/bootstrap-droplet.ts` now import from `./lib/*` — local helper bodies removed. No behavior change. `npx tsc --noEmit` clean.

The `Config` interface is the union of both prior local Configs (the create-droplet superset). `loadConfig` validates all 12 required fields up front, so any downstream script (bootstrap, destroy, smoke, verify) gets a fully-populated config or `bail`s.

### Task 2 — `scripts/destroy-droplet.ts` (commit `260fa50`)

145-line script implementing D-09 scope only (droplet + firewall + .droplet.json — explicitly NOT TEARDOWN-01 re-bootstrap).

Behavior:
1. **Refuses without `.droplet.json`** — exits 1 with `Refusing to destroy: .droplet.json not found.` (T-01-01-01: never look up the droplet by name).
2. Looks up firewall by name, deletes with `--force` if present, logs "already absent" otherwise.
3. Looks up droplet **by id** (from `.droplet.json`), deletes with `--force` if present.
4. Unlinks `.droplet.json` (swallows `ENOENT`).
5. `--yes` / `-y` flag skips the y/N prompt — used by the smoke runner's `--fresh` path; interactive operators get the prompt (T-01-01-02).

Verified: `npx tsx scripts/destroy-droplet.ts` (no `.droplet.json`) exits 1 with the expected refusal message.

### Task 3 — npm scripts wired (commit `d7a137d`)

Added to `package.json`:

```json
"destroy-droplet":   "tsx scripts/destroy-droplet.ts",
"smoke-test":        "tsx scripts/smoke-test.ts",
"verify:phase-1":    "tsx scripts/verify/phase-1.ts"
```

`smoke-test` and `verify:phase-1` will fail-fast until plans 02/03 land their files — that is the intended sequencing (avoids package.json edit conflict in later parallel waves).

`tsconfig.json` already exists at the repo root (commonjs/ES2022/strict) — kept as-is per the plan's "if absent" instruction.

## Verification

| Check | Result |
|-------|--------|
| `npx tsc --noEmit -p tsconfig.json` | exits 0 across `scripts/**/*.ts` |
| `node -e "require('./package.json').scripts['destroy-droplet']"` | resolves |
| `npx tsx scripts/destroy-droplet.ts` (no `.droplet.json`) | exits 1 with `Refusing to destroy: .droplet.json not found.` |
| `grep -rn 'from "./lib/' scripts/` | create, bootstrap, destroy all import from lib (no duplicated bodies) |

## Deviations from Plan

None. Plan executed as written.

Two minor clarifications worth flagging (not deviations — both spelled out by the plan body):

1. **`scpFile` signature kept as-is** (`ip,user,keyPath,localFile,remotePath`). The plan's frontmatter `<interfaces>` listed a different argument order, but the action body explicitly said "Use the EXACT current implementations — do not redesign." Existing call sites in `bootstrap-droplet.ts` already match the kept signature.
2. **`tsconfig.json` not recreated** — already present in the worktree (commonjs target). Plan instructed to create only if absent.

## Threat Mitigations Applied

| Threat | Mitigation |
|--------|------------|
| T-01-01-01 (wrong droplet destroyed) | Droplet lookup is by id from `.droplet.json` only; refuses if file is missing |
| T-01-01-02 (accidental destroy on re-run) | y/N prompt by default; only `--yes` skips |
| T-01-01-03 (helpers logging secrets) | `runVisible`/`runCapture` extracted verbatim — no env-var interpolation into log lines |

## Self-Check: PASSED

- `scripts/lib/config.ts` — FOUND
- `scripts/lib/ssh.ts` — FOUND
- `scripts/lib/doctl.ts` — FOUND
- `scripts/destroy-droplet.ts` — FOUND
- commit `5c7d3d8` — FOUND
- commit `260fa50` — FOUND
- commit `d7a137d` — FOUND

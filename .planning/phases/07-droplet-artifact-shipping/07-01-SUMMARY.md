---
phase: 07-droplet-artifact-shipping
plan: 01
subsystem: verify
tags: [droplet, verify, ssh, phase-7]
requires:
  - scripts/lib/ssh.ts (sshFlags, runCapture)
  - scripts/lib/config.ts (loadConfig, loadDropletInfo, bail, Config, DropletInfo, NormalizedSource)
  - droplet/sync-one-repo.sh (asserted at runtime)
  - droplet/lib/detect-account-type.sh (asserted at runtime)
  - droplet/lib/filter-repos.sh (asserted at runtime)
  - droplet/github-backup.sh (asserted at runtime)
provides:
  - scripts/verify/phase-7.ts (executable verifier for DROPLET-01/02/03)
  - npm run verify:phase-7 (npm script entry)
affects:
  - package.json (1 line added)
tech_stack:
  added: []
  patterns:
    - "Standalone-per-phase verify runner (D-09): no shared verify-helpers module"
    - "Defence-in-depth slug regex (SLUG_RE) re-validates target slugs at the verify boundary before ssh interpolation (T-07-01 mitigation)"
    - "Single-quoted ssh payloads on the command line (phase-6 convention)"
key_files:
  created:
    - scripts/verify/phase-7.ts
  modified:
    - package.json
decisions:
  - "D-01: phase-7 verifier is a NEW standalone file, does not extend phase-6.ts and is not deferred to Phase 10 UAT"
  - "D-04: ssh primitives reused from scripts/lib/ssh.ts — no new SSH wrapper introduced"
  - "D-09: no new shared verify-helpers module; helpers (assert/info/sshCapture/sshExitsZero) inlined per phase-6.ts convention"
  - "REMOTE_ENV(cfg) helper returns the constant /opt/github-backups/backup.env — Config does not expose backup.env path (v1.0 fixed)"
metrics:
  duration_minutes: ~7
  completed_at: 2026-05-16
  tasks_total: 2
  tasks_completed: 2
  files_created: 1
  files_modified: 1
---

# Phase 07 Plan 01: Verify-phase-7 implementation Summary

Adds `scripts/verify/phase-7.ts` — a four-group executable verifier asserting DROPLET-01/02/03 contracts (sync-one-repo.sh, detect-account-type.sh, filter-repos.sh) plus an end-to-end github-backup.sh run — and wires `npm run verify:phase-7` after `verify:phase-6` in package.json.

## What got built

`scripts/verify/phase-7.ts` (452 lines, TypeScript-strict-clean) mirrors `scripts/verify/phase-6.ts` structure exactly:

| Group | Function | Asserts (req → SC → decision) |
|-------|----------|-------------------------------|
| 1 | `group1SyncOneRepoContract` | DROPLET-01 → SC#1 → D-05: `/opt/github-backups/sync-one-repo.sh` is executable, invokable on target slug, produces namespaced mirror dir `${REMOTE_DIR}/<source>/<owner>_<repo>.git`, emits `BACKUP_REPO_RESULT source=… owner=… repo=… action=clone\|update` log line |
| 2 | `group2DetectAccountType` | DROPLET-02 → SC#2 → D-06: `detect-account-type.sh` source-loads under `set -e`; `detect_account_type definitely-not-a-real-slug-xxx` returns `User` (default-on-non-200) |
| 3 | `group3FilterRepos` | DROPLET-03 → SC#3 → D-07: `filter-repos.sh` source-loads under `set -e`; 3 golden cases — empty allow passes all, deny `*-test` wins over allow `*`, allow `tools/*` passes `tools/x` blocks `other/y` |
| 4 | `group4EndToEnd` | DROPLET-01/02/03 (integration) → SC#4 → D-08: `github-backup.sh` exits 0; target namespaced mirror exists; ≥1 `BACKUP_REPO_RESULT` line for target with `action=clone\|update`; zero `unbound variable` / `command not found` in new log tail |

**Target selection (`chooseTarget`):** resolves the SC#4 target via `cfg.webhookTestRepo` → `cfg.restoreTestRepo` → `gh api` auto-discovery. Every slug (config-pinned and auto-discovered) is double-validated against `SLUG_RE = /^[A-Za-z0-9._-]+$/` at the verify boundary before ssh interpolation. Bails operator-actionably if nothing resolves.

**Helpers inlined (no shared module — D-09):** `assert`, `info`, `softSkip`, `sshCapture`, `sshExitsZero`, `parseRepoSlug`, `globMatch`, `passesFilter`, `REMOTE_ENV`. Mirror phase-6.ts ssh-payload conventions (single quotes on the command line; double quotes inside the payload).

`package.json` `scripts` block gains exactly one entry, immediately after `verify:phase-6`:
```json
"verify:phase-7": "tsx scripts/verify/phase-7.ts"
```

## Commits

| Task | Hash | Subject |
|------|------|---------|
| 1 | `b802415` | feat(07-01): add scripts/verify/phase-7.ts (DROPLET-01/02/03) |
| 2 | `1cbd06b` | chore(07-01): wire verify:phase-7 in package.json |

## Verification

**Local (automated, ran in this plan):**
- `npx tsc --noEmit scripts/verify/phase-7.ts` exits 0 (TypeScript strict)
- `node -e 'JSON.parse(require("fs").readFileSync("package.json","utf8"))'` exits 0
- `node -e 'const p=require("./package.json"); process.exit(p.scripts["verify:phase-7"]==="tsx scripts/verify/phase-7.ts"?0:1)'` exits 0
- `node -e 'const p=require("./package.json"); const k=Object.keys(p.scripts); process.exit(k.indexOf("verify:phase-7")>k.indexOf("verify:phase-6")?0:1)'` exits 0
- All Task 1 grep acceptance gates pass:

| Gate | Expected | Got |
|------|----------|-----|
| `grep -c 'from "../lib/ssh"'` | ≥1 | 1 |
| `grep -c 'from "../lib/config"'` | ≥1 | 1 |
| `grep -cE 'function (group1\|group2\|group3\|group4)'` | 4 | 4 |
| `grep -c "BACKUP_REPO_RESULT"` | ≥2 | 3 |
| `grep -c "test -x /opt/github-backups/sync-one-repo.sh\|REMOTE_SYNC_ONE_REPO"` | ≥1 | 4 |
| `grep -c "detect_account_type definitely-not-a-real-slug-xxx"` | ≥1 | 1 |
| `grep -c "unbound variable"` | ≥1 | 3 |
| `grep -c "command not found"` | ≥1 | 3 |
| `grep -cE "set -e; source.*detect-account-type"` | ≥1 | 1 |
| `grep -cE "set -e; source.*filter-repos"` | ≥1 | 1 |
| `grep -cE "^export function ssh"` | 0 | 0 |
| `grep -c 'from "../lib/verify'` | 0 | 0 |

**Local smoke (no `.droplet.json` and no `config.json` locally):** `npm run verify:phase-7` prints the banner and bails with `config.json not found` (precondition gate reached, operator-actionable message). The plan's acceptance criterion notes this scenario is "operator-skippable if `.droplet.json` was never created locally — same effect; the grep still matches" — equivalent precondition gate reached.

**Remote (operator-gated, requires live bootstrapped droplet):**
- `npm run verify:phase-7` against a freshly-bootstrapped droplet exits 0 and prints `✓ verify:phase-7 PASSED` — this is the SC#4 gate (DROPLET-01/02/03 integration) reserved for the operator on the live droplet.

## Deviations from Plan

**None of substance. Two minor cleanups documented for traceability:**

1. **[Rule 3 — fix typo in plan snippet] `chooseTarget` ternary missing colon.** The plan's `chooseTarget` example (line 439-441) has:
   ```ts
   const ep = t === "Organization"
     ? `/orgs/${src.name}/repos?...`
       `/users/${src.name}/repos?...`;
   ```
   Missing `:` between the two branches — would not compile. Fixed in the written file to use the correct ternary form (`? a : b`). No behaviour change vs the plan's intent.

2. **[Rule 2 — extra defence-in-depth] `chooseTarget` re-validates `src.name` and `parsed.owner/repo` against `SLUG_RE` at the auto-discovery path too.** The plan describes SLUG_RE re-validation generally; the file applies it consistently to both config-pinned and auto-discovered slugs and to `src.name` itself before interpolating into the `gh api` payload. This is a stricter read of the T-07-01 mitigation in the plan's threat model and adds no surface beyond what loadConfig already validates.

Neither change required architectural deviation (Rule 4), neither introduced new abstractions.

## Self-Check: PASSED

- `scripts/verify/phase-7.ts` exists (452 lines, compiles strict-clean).
- `package.json` contains `"verify:phase-7": "tsx scripts/verify/phase-7.ts"`, ordered after `verify:phase-6`.
- Commits `b802415` and `1cbd06b` present in `git log` on `master`.
- No file under `droplet/` modified. No file under `scripts/lib/` modified. No new SSH wrapper, no shared verify-helpers module.
- All Task 1 + Task 2 grep / Node acceptance gates pass.

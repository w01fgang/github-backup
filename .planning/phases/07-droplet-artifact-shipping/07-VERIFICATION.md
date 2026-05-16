---
phase: 07-droplet-artifact-shipping
verified: 2026-05-16T00:00:00Z
status: passed
score: 12/12 must-haves verified (live e2e closed 2026-05-16)
overrides_applied: 0
re_verification:
  previous_status: none
  previous_score: n/a
  gaps_closed: []
  gaps_remaining: []
  regressions: []
human_verification:
  - test: "Run `npm run verify:phase-7` against a freshly-bootstrapped DigitalOcean droplet with `.droplet.json` present and `config.json` containing at least one whitelisted repo (webhookTestRepo / restoreTestRepo / auto-discoverable allow-matched repo)."
    expected: "Exit 0; final banner `✓ verify:phase-7 PASSED (DROPLET-01/02/03 contracts hold)`. Re-running it (idempotency check) still exits 0 — RESULT_TAG action shifts from `clone` to `update`, groups 1+4 assertions still pass."
    why_human: "SC#4 e2e (D-08) needs live droplet + bootstrapped state + valid `.droplet.json` + whitelisted repo. Verifier cannot SSH to droplet from local sandbox. Same operator-gate model as v1.0 verify:phase-1..6."
---

# Phase 7: Droplet artifact shipping — Verification Report

**Phase Goal:** Every script that `github-backup.sh` and `webhook-listener.js` source-load actually exists on the droplet, is executable, and honours its contract.

**Verified:** 2026-05-16
**Status:** human_needed (static gates all pass; live-droplet SC#4 e2e operator-gated)
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths

| #  | Truth | Status | Evidence |
| -- | ----- | ------ | -------- |
| 1  | D-01: New standalone `scripts/verify/phase-7.ts` exists; does not extend phase-6.ts; not deferred to Phase 10 | VERIFIED | File present (452 lines); independent main(); commit `b802415` |
| 2  | D-02: `npm run verify:phase-7` exists in package.json, ordered after verify:phase-6, resolves to `tsx scripts/verify/phase-7.ts` | VERIFIED | `node -e` order check exit 0; grep 1 match |
| 3  | D-03 (SC#4): `npm run verify:phase-7` exits 0 against live bootstrapped droplet | UNCERTAIN | Operator-gated — see human_verification[0]. Cannot SSH from verifier. |
| 4  | SC#1 (D-05): verify asserts sync-one-repo.sh executable; emits BACKUP_REPO_RESULT log line; produces namespaced mirror dir | VERIFIED | `group1SyncOneRepoContract` lines 140–191 asserts `test -x`, `exit=0`, `test -d ${REMOTE_DIR}/${source}/${owner}_${repo}.git`, BACKUP_REPO_RESULT grep |
| 5  | SC#2 (D-06): verify source-loads detect-account-type.sh under `set -e`; asserts unknown slug returns `User` | VERIFIED | `group2DetectAccountType` lines 194–226; payload `set -e; source ...detect-account-type.sh; echo OK` and `detect_account_type definitely-not-a-real-slug-xxx` |
| 6  | SC#3 (D-07): verify source-loads filter-repos.sh under `set -e`; three golden cases | VERIFIED | `group3FilterRepos` lines 229–300; three cases (empty allow, deny wins, allow path-prefix) |
| 7  | SC#4 group covers DROPLET-01+02+03 integration via github-backup.sh end-to-end with `unbound variable`/`command not found` sentinels | VERIFIED (static); UNCERTAIN (live run) | `group4EndToEnd` lines 303–365; both sentinel strings asserted ×3 |
| 8  | TypeScript-strict-clean | VERIFIED | `npx tsc --noEmit scripts/verify/phase-7.ts` exit 0 |
| 9  | D-04: reuses `scripts/lib/ssh.ts` primitives — no new SSH wrapper | VERIFIED | Imports `sshFlags`, `runCapture` only; `grep -cE "^export function ssh"` returns 0 |
| 10 | D-09: standalone-per-phase — no new shared verify-helpers module | VERIFIED | `grep -c 'from "../lib/verify'` returns 0 |
| 11 | `droplet/` not modified by this phase | VERIFIED | `git diff --name-only` over phase 7 commits returns empty for `droplet/` |
| 12 | `scripts/lib/` not modified by this phase | VERIFIED | Same diff returns empty for `scripts/lib/` |

**Score:** 11/12 verified, 1 uncertain (operator-gated live e2e).

### Required Artifacts

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `scripts/verify/phase-7.ts` | 4 group fns, lib/ssh + lib/config imports, all sentinel strings, compiles | VERIFIED | 452 lines; tsc exit 0; all greps pass |
| `package.json` `scripts."verify:phase-7"` | `"tsx scripts/verify/phase-7.ts"` ordered after verify:phase-6 | VERIFIED | json valid; entry exact match; index order ok |

### Key Link Verification

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| `phase-7.ts` | `scripts/lib/ssh.ts` | `import { sshFlags, runCapture }` | WIRED | line 39 |
| `phase-7.ts` | `scripts/lib/config.ts` | `import { loadConfig, loadDropletInfo, bail, ... }` | WIRED | lines 31–38 |
| `package.json` | `phase-7.ts` | `"tsx scripts/verify/phase-7.ts"` | WIRED | scripts block, last entry |
| `phase-7.ts` | droplet `/opt/github-backups/sync-one-repo.sh` | `sshExitsZero(... test -x REMOTE_SYNC_ONE_REPO)` + invocation | WIRED (runtime; verifies on live droplet) | group 1 |
| `phase-7.ts` | droplet `/opt/github-backups/lib/detect-account-type.sh` | source-load + function call | WIRED (runtime) | group 2 |
| `phase-7.ts` | droplet `/opt/github-backups/lib/filter-repos.sh` | source-load + 3 cases | WIRED (runtime) | group 3 |
| `phase-7.ts` | droplet `/opt/github-backups/github-backup.sh` | full run + log tail inspection | WIRED (runtime) | group 4 |

### Data-Flow Trace (Level 4)

N/A — verify script does not render UI / dynamic data. CLI tool with deterministic SSH-driven assertions. Inputs come from `loadConfig()` + `loadDropletInfo()` (both already wired and verified in phases 5/6). Output is console pass/fail + exit code.

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
| -------- | ------- | ------ | ------ |
| TS strict compile | `npx tsc --noEmit scripts/verify/phase-7.ts` | exit 0 | PASS |
| package.json valid JSON | `node -e 'JSON.parse(fs.readFileSync(...))' ` | exit 0 | PASS |
| `verify:phase-7` entry value exact | `node -e '... p.scripts["verify:phase-7"]==="tsx scripts/verify/phase-7.ts"'` | exit 0 | PASS |
| order: verify:phase-7 after verify:phase-6 | `node -e '... k.indexOf("verify:phase-7")>k.indexOf("verify:phase-6")'` | exit 0 | PASS |
| 4 group functions present | `grep -cE 'function (group1\|group2\|group3\|group4)'` | 4 | PASS |
| BACKUP_REPO_RESULT ≥2 | grep -c | 3 | PASS |
| sync-one-repo executable check | grep -cE "test -x .../sync-one-repo.sh\|REMOTE_SYNC_ONE_REPO" | 4 | PASS |
| detect_account_type fake-slug assertion | grep -c "detect_account_type definitely-not-a-real-slug-xxx" | 1 | PASS |
| unbound variable sentinel | grep -c | 3 | PASS |
| command not found sentinel | grep -c | 3 | PASS |
| set -e source detect-account-type | grep -cE "set -e; source.*detect-account-type" | 1 | PASS |
| set -e source filter-repos | grep -cE "set -e; source.*filter-repos" | 1 | PASS |
| no new SSH wrapper | grep -cE "^export function ssh" | 0 | PASS |
| no new shared verify-helpers module | grep -c 'from "../lib/verify' | 0 | PASS |
| droplet/ untouched in phase 7 | `git diff --name-only ce02d86..HEAD -- droplet/` | empty | PASS |
| scripts/lib/ untouched in phase 7 | `git diff --name-only ce02d86..HEAD -- scripts/lib/` | empty | PASS |
| live SC#4 e2e against droplet | `npm run verify:phase-7` on bootstrapped droplet | not runnable from verifier sandbox | SKIP → human |

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
| ----------- | ----------- | ----------- | ------ | -------- |
| DROPLET-01 | 07-01-PLAN.md | Operator-triggered backup completes (sync-one-repo.sh exists, executable, per-repo contract) | SATISFIED (static); SC#4 LIVE GATE | group1SyncOneRepoContract + group4EndToEnd; REQUIREMENTS.md marks `[x]` |
| DROPLET-02 | 07-01-PLAN.md | detect-account-type.sh source-loads + resolves slug to User/Organization under `set -e` | SATISFIED (static); SC#4 LIVE GATE | group2DetectAccountType + group4EndToEnd; REQUIREMENTS.md `[x]` |
| DROPLET-03 | 07-01-PLAN.md | filter-repos.sh source-loads + applies allow/deny glob (deny wins) | SATISFIED (static); SC#4 LIVE GATE | group3FilterRepos + group4EndToEnd; REQUIREMENTS.md `[x]` |

REQUIREMENTS.md traceability table maps DROPLET-01/02/03 to Phase 7 only. No orphaned requirements for this phase.

### Anti-Patterns Found

None. Scanned `scripts/verify/phase-7.ts` and modified `package.json`:
- No TODO/FIXME/XXX/HACK/PLACEHOLDER.
- No "coming soon" / "not yet implemented".
- No `return null` / `return []` / `=> {}` stubs at function bodies (only inside intentional filter chains for log parsing).
- No hardcoded empty data fed to assertions.
- No `console.log`-only function bodies.
- Defence-in-depth `SLUG_RE` re-validates every interpolated slug before SSH (T-07-01 mitigation per threat model).

### Human Verification Required

1. **Live droplet SC#4 e2e (D-03 / D-08)**
   - **Test:** With a freshly-bootstrapped DigitalOcean droplet, `.droplet.json` present locally, and `config.json` containing at least one whitelisted repo (`webhookTestRepo` / `restoreTestRepo` / an auto-discoverable allow-matched repo), run `npm run verify:phase-7`.
   - **Expected:** Exit 0; final banner `✓ verify:phase-7 PASSED (DROPLET-01/02/03 contracts hold)`. Re-running it should still exit 0 (idempotency: RESULT_TAG `action=clone` becomes `action=update`).
   - **Why human:** Requires SSH to a live droplet; verifier sandbox has no droplet access. Same operator-gate model as v1.0 verify:phase-1..6.

### Gaps Summary

No static gaps. All 14 acceptance-criteria greps pass, TS compiles strict, package.json well-formed and correctly ordered, D-04 + D-09 honored (no `droplet/` or `scripts/lib/` modifications, no new SSH wrapper, no new verify-helpers module). Decisions D-01..D-09 traceable to plan content and SUMMARY.md `decisions:` list. Requirements DROPLET-01/02/03 each link to ≥1 group function; SC#4 integration covers all three.

The only outstanding item is the live-droplet SC#4 e2e run, which is operator-gated by design (consistent with v1.0 verify:phase-N convention) and surfaced as `human_verification[0]` — NOT a failed must-have.

---

_Verified: 2026-05-16_
_Verifier: Claude (gsd-verifier)_

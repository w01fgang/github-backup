# Phase 7: Droplet artifact shipping - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-05-16
**Phase:** 7-Droplet artifact shipping
**Areas discussed:** Verification surface, E2E mirror proof target, Contract depth, Bootstrap fail-loud

---

## Verification surface

| Option | Description | Selected |
|--------|-------------|----------|
| New `scripts/verify/phase-7.ts` | Mirrors per-phase pattern (phase-1..6 each have own). Easy to grep `verify:phase-7` in CI. Asserts artifact exists + exec + source-loads + contract goldens. | ✓ |
| Extend `scripts/verify/phase-6.ts` | Phase 6 already source-loads both libs on droplet. Adding sync-one-repo.sh assertions + e2e mirror there keeps related logic together but bloats phase-6 scope. | |
| Defer to Phase 10 UAT | No new verify script. Phase 7 ships nothing automated; defer all proof to Phase 10 human UAT. | |

**User's choice:** New `scripts/verify/phase-7.ts` (Recommended).
**Notes:** Locked → D-01, D-02 in CONTEXT.md.

---

## E2E mirror proof target

| Option | Description | Selected |
|--------|-------------|----------|
| Live DO droplet via `.droplet.json` | `verify:phase-7` ssh's to existing droplet, runs `github-backup.sh` over one small whitelisted repo, asserts RESULT_TAG line + mirror dir exists. Real, slow (~30s), costs droplet uptime. | ✓ |
| Local docker ubuntu-22.04 sandbox | Spin up local docker ubuntu-22.04 + bash + git + gh, bootstrap onto it, run mirror. Fast, deterministic, no DO cost. Diverges from real droplet env (no systemd, no Caddy). | |
| Manual operator step in Phase 10 | verify:phase-7 only does static + source-load asserts. SC#4 e2e folded into Phase 10 UAT scenarios. | |

**User's choice:** Live DO droplet via `.droplet.json` (Recommended).
**Notes:** Locked → D-03, D-04 in CONTEXT.md.

---

## Contract depth (multi-select)

| Option | Description | Selected |
|--------|-------------|----------|
| Artifact presence + exec bit | `test -x` on /opt/github-backups/{sync-one-repo.sh,lib/detect-account-type.sh,lib/filter-repos.sh}. Bare minimum. | (derived) |
| Source-load smoke under `set -e` | `bash -c 'set -e; source <path>; echo OK'` — proves no syntax/abort on `set -e`. | (derived) |
| Functional unit tests of helpers (golden inputs) | detect_account_type default-User; filter_repos golden cases (deny wins, empty-allow=all, glob match with/without slash). | (derived) |
| Full e2e: mirror one real repo | Pre-populate config with 1 whitelisted repo, run `github-backup.sh` once, assert namespaced mirror dir + RESULT_TAG line + no abort errors in log. SC#4. | (derived) |

**User's choice:** Free-text — "I have no idea :shrug: Try to read the original task and figure out".
**Notes:** Claude derived depth from ROADMAP.md Phase 7 SC#1-4 directly. Each SC forces one or more depth tiers; mapping documented as D-05..D-08 in CONTEXT.md. All four tiers locked (none optional). See "Claude's Discretion" in CONTEXT.md.

---

## Bootstrap fail-loud

| Option | Description | Selected |
|--------|-------------|----------|
| Yes — drop `-d lib` guard, hard-fail | Drop the `if [[ -d lib ]]` guard at bootstrap.sh:157-159 and replace with explicit check that fails non-zero if either lib helper missing. | |
| No — leave bootstrap.sh; Phase 8 covers it | Keep Phase 7 to artifact contract proof + verify:phase-7. Droplet-side fail-loud is Phase 8 MANIFEST-01 scope. | ✓ |
| Yes + reusable `assert_artifact()` helper | Drop guard AND add reusable bash helper that checks all 3 droplet artifacts present+executable. | |

**User's choice:** No — leave droplet-side bootstrap.sh alone; Phase 8 covers it.
**Notes:** Locked → D-09 in CONTEXT.md. Explicit no-double-up.

---

## Claude's Discretion

- **Contract depth (D-05..D-08)** — User delegated with "I have no idea, read the original task and figure out". Claude mapped each ROADMAP SC#1-4 to the minimum sufficient depth tier per criterion and locked all four. Mapping is auditable line-by-line in CONTEXT.md `<decisions>`.
- **Test-repo selection for SC#4 e2e** — Either an operator-supplied tiny scratch repo or the smallest already-whitelisted source repo works. Left to planning.

## Deferred Ideas

- Droplet-side fail-loud on missing lib helpers → Phase 8 (MANIFEST-01 owns it; user's choice not to double-up).
- Local docker ubuntu-22.04 emulation harness → rejected (would diverge from real droplet env: no systemd, no Caddy).
- Shared verify-helpers module → rejected, keep per-phase standalone pattern.

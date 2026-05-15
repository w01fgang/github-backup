---
phase: 05-teardown
plan: 02
status: complete
date: 2026-05-15
---

# 05-02 Summary — verify:phase-5 + Lifecycle README

## Files changed (lines added)

- `scripts/verify/phase-5.ts` — new file, 379 lines (well above plan `min_lines: 150`)
- `package.json` — +1 line (`"verify:phase-5": "tsx scripts/verify/phase-5.ts"`)
- `README.md` — +43 lines (one new H2 `## Lifecycle` with three subsections)

## Group structure

Five groups implemented per D-12 + plan task 1:

1. Group 1 — Pre-conditions: droplet active, backup.env mode 600, exactly 1 cron marker
2. Group 2 — backup.env preservation across no-rotate re-run (sha256 + mtime + mode); also captures listener pre-state for Group 5 in same pass per "two-pass structure"
3. Group 3 — Cron-marker invariant (count == 1 after re-run, integer equality)
4. Group 4 — `--rotate-env` round-trip, env-gated on `GITHUB_TOKEN`; `gh auth status` proves end-to-end
5. Group 5 — Listener survival, probe-gated on `/etc/systemd/system/github-backup-webhook.service` (or `/lib/systemd/system/...`)

## Defenses present

- `GITHUB_TOKEN: ""` override on Group 2's `spawnSync({ env: ... })` — defends against an env-set token surprise-rotating mid-check (T-05-05). Confirmed at line 196.
- `grep -v "^#"` on both crontab counts (Groups 1 + 3) — grep-gate hygiene per CONTEXT D-Discretion. Confirmed at lines 139, 252.
- `sshExitsZero` mirrors phase-1.ts NR-04 handling: signal-killed and null-status are transport-class failures.
- No try/catch wrapping that would convert thrown transport errors into assertion failures — fail-loud per Rule 12.

## Deviations from plan

- **README placement.** Plan task 2 said "insert between `## Operation` (ends line 263) and `## Recovery` (line 265)". Since the plan was written, Phase 3 added a `## Webhook setup` section between them. Inserted `## Lifecycle` immediately before `## Recovery` (the closest legitimate boundary), preserving the plan's narrative intent (lifecycle = the operator-lifecycle commands group). README content is verbatim per the plan markdown block; no paraphrasing.
- **package.json ordering.** Plan said "place immediately after `verify:phase-1` so the order matches roadmap order." Existing `scripts` block was already non-roadmap-ordered (1, 2, 4, 3). Followed the literal "after verify:phase-1" instruction; the surrounding scripts remain in their pre-existing order. Net order is now: 1, 5, 2, 4, 3 — not roadmap, but matches plan literal.
- **Group 5 two-pass structure.** Plan paragraph offered both single-pass and two-pass variants and recommended two-pass to honor SC#3. Implemented two-pass: capture `listenerActiveBefore` *inside* Group 2 (before the no-rotate re-run), assert + re-check inside Group 5 after Groups 2+4 have both executed. This means a listener killed during either re-run trips Group 5.

## Verifications

- `npx tsc --noEmit scripts/verify/phase-5.ts` — exit 0
- `npx tsc --noEmit` (whole project) — exit 0
- `node -e "...verify:phase-5 lookup..."` — exit 0
- `grep -c '^## Lifecycle$' README.md` → 1
- 5 group headers present in source (`grep -c '— Group [0-9]'` → 5)

## Live-droplet status

Not yet run end-to-end against a live droplet — Phase 5 ships the verify script and bootstrap idempotency contract; live verification is the operator's next step (smoke-test or direct `npm run verify:phase-5` against an existing droplet). Per plan `<verification>`: requires Phase 1 to have shipped first (already complete per STATE.md: 4 phases shipped to master).

## Group 5 activation

Phase 3 (webhook unit) shipped before Phase 5, so on a freshly bootstrapped droplet `/etc/systemd/system/github-backup-webhook.service` exists and Group 5 will activate. On a droplet that predates Phase 3 the probe correctly returns false and Group 5 emits `⚠ skipping listener-survival (Phase 3 webhook unit not installed)` — no-op, no failure.

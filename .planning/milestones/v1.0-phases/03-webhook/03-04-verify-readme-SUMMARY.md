---
phase: 03-webhook
plan: 04
subsystem: verify-docs
tags: [feature, typescript, verification, docs]
requires:
  - droplet/webhook-listener.js  # plan 03-02 — verify targets the live listener
  - scripts/register-webhooks.ts # plan 03-03 — README documents it
  - "Config.webhookHostname / Config.webhookTestRepo"  # plan 03-03
provides:
  - scripts/verify/phase-3.ts
  - "npm run verify:phase-3"
  - "README §Webhook setup"
affects:
  - package.json
  - README.md
tech-stack:
  added: []
  patterns:
    - Phase 1 verify shape (assert + fail-fast + exit 0 only on all-pass)
    - Synthetic-but-deterministic push payload for end-to-end test
    - Probe-gated env-conditional group (group 4 skips when cfg.webhookTestRepo unset)
key-files:
  created:
    - scripts/verify/phase-3.ts
  modified:
    - package.json
    - README.md
key-decisions:
  - "D-26 group 4: synthetic payload over real-GitHub-delivery — deterministic, no dependency on a recent push"
  - "D-26 group 5: ping-twice over duplicate-push — stateless, instant, equivalent signal"
  - "Helper duplication accepted (assert / sshCapture copied from verify/phase-1.ts) — Phase 4 D-Discretion notes the lib extraction is deferred"
  - "README Webhook setup section placed between Operation and Recovery"
requirements-completed:
  - TEST-02
  - TEST-03
  - WEBHOOK-01
  - WEBHOOK-02
duration: 28 min
completed: 2026-05-13
---

# Phase 3 Plan 04: verify-readme Summary

Operator-visible verification surface for Phase 3: a six-group
`verify:phase-3` TypeScript runner, the README `## Webhook setup` section
covering DNS prereq through rotation through troubleshooting, and the
package.json wiring. After this plan, an operator runs `npm run
verify:phase-3` against a live droplet and gets a green/red proof of the
webhook plane.

## Outputs

| File | Status | Lines |
|------|--------|-------|
| `scripts/verify/phase-3.ts` | new | 359 |
| `package.json` | +verify:phase-3 entry | +1 |
| `README.md` | +Webhook setup section (between Operation and Recovery) | +83 |

## Verifier groups (recap)

| # | Name | Asserts |
|---|------|---------|
| 1 | Pre-conditions | DNS A matches droplet IP; GET → 405; LE cert valid via openssl notAfter; systemd `is-active` for github-backup-webhook + caddy |
| 2 | Source resolution | Unknown owner with valid HMAC → 404 |
| 3 | Bad signature | Wrong secret on otherwise-valid payload → 401 |
| 4 | End-to-end push (env-gated) | Signed synthetic push → 202; BACKUP_REPO_RESULT line appears in /var/log/github-backup.log within 30s with action != fail; last-webhook-event.json names the right repo + action=dispatched |
| 5 | Idempotency | Same ping twice → 200 twice (listener has no dedupe) |
| 6 | Listener-restart survival | systemctl restart + 3s wait + ping → 200; service still active |

Group 4 is env-gated on `cfg.webhookTestRepo`; logs a clear `[skip]` and
continues without failing when unset (matches D-26 group 4 contract).

## Commits

| Hash | Task | Message |
|------|------|---------|
| `4d9930b` | 1 | feat(03-04): add scripts/verify/phase-3.ts (six-group webhook verifier) |
| `c5953b5` | 2+3 | feat(03-04): wire verify:phase-3 script + add README Webhook setup section |

## Verification

| Check | Expected | Got |
|---|---|---|
| `npx tsc --noEmit` | 0 | 0 |
| `package.json scripts["verify:phase-3"]` | `tsx scripts/verify/phase-3.ts` | matches |
| `grep -c "^## Webhook setup$" README.md` | 1 | 1 |
| `grep -c verify:phase-3 README.md` | ≥1 | 3 |
| `grep -c register-webhooks README.md` | ≥2 | 4 |
| `grep -c "journalctl -u github-backup-webhook" README.md` | ≥1 | 2 |
| `grep -c X-Hub-Signature-256 scripts/verify/phase-3.ts` | ≥1 | 5 |
| `grep -c Group scripts/verify/phase-3.ts` | ≥6 | 12 |
| `grep -c BACKUP_REPO_RESULT scripts/verify/phase-3.ts` | (must_haves contains) | 3 |

End-to-end runtime test is not in this plan — that requires a live droplet
and is the smoke run. Plan-time verification is artifact-shape only.

## Deviations from Plan

None — plan executed exactly as written.

**Total deviations:** 0.
**Impact:** None.

## Next

Phase 3 complete. Next: phase-level verification + STATE update. Phase 5
(bootstrap idempotency) is the immediate downstream consumer — its
`scripts/verify/phase-5.ts` Group 5 probe-gates on the
`github-backup-webhook.service` unit installed in plan 03-02, and that
unit is in place at the exact path Phase 5 expects.

## Self-Check: PASSED

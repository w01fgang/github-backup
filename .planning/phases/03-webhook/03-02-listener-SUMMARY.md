---
phase: 03-webhook
plan: 02
subsystem: droplet-webhook
tags: [feature, node, systemd, caddy]
requires:
  - droplet/sync-one-repo.sh  # plan 03-01
provides:
  - droplet/webhook-listener.js
  - droplet/Caddyfile.template
  - droplet/github-backup-webhook.service
affects:
  - droplet/bootstrap.sh
tech-stack:
  added:
    - caddy (apt, official repo)
    - nodejs (apt, default repo — only built-in modules used)
    - systemd unit (github-backup-webhook.service)
  patterns:
    - HMAC-SHA256 verification over raw buffer BEFORE JSON.parse (D-10)
    - Asynchronous dispatch via systemd-run --collect --no-block (D-03)
    - Source-resolution check after HMAC, returns 404 on owner mismatch (D-11)
    - Atomic state-file write (temp + rename) for last-webhook-event.json (D-17)
key-files:
  created:
    - droplet/webhook-listener.js
    - droplet/Caddyfile.template
    - droplet/github-backup-webhook.service
  modified:
    - droplet/bootstrap.sh
key-decisions:
  - "D-01: vanilla Node + http/crypto/fs/path/child_process — zero npm deps"
  - "D-03: systemd-run dispatch keeps the HTTPS handler sub-second; GitHub never times out"
  - "D-05: Caddyfile is a one-block reverse_proxy; auto-LE handles cert lifecycle"
  - "D-18: EnvironmentFile=/opt/github-backups/backup.env keeps WEBHOOK_SECRET co-located with GITHUB_TOKEN"
  - "D-19/D-20: bootstrap.sh idempotently overwrites Caddyfile + listener + unit; daemon-reload + enable --now no-ops cleanly on re-run (Phase 5 TEARDOWN-01 hook fulfilled)"
requirements-completed:
  - WEBHOOK-01
  - WEBHOOK-02
  - PROV-02
  - BACKUP-03
duration: 22 min
completed: 2026-05-13
---

# Phase 3 Plan 02: webhook listener Summary

Droplet-side webhook plane: a vanilla-Node HTTP listener (~220 LOC, zero npm
deps), a Caddyfile template, a systemd unit, and the bootstrap.sh install
wiring. Signed POSTs to `https://<webhookHostname>/webhook/github` now flow
through Caddy → listener → `systemd-run` → `sync-one-repo.sh` (plan 03-01).

## Outputs

| File | Status | Lines |
|------|--------|-------|
| `droplet/webhook-listener.js` | new | 223 |
| `droplet/Caddyfile.template` | new | 7 |
| `droplet/github-backup-webhook.service` | new | 17 |
| `droplet/bootstrap.sh` | edited (+caddy install, +node install, +listener install block) | +67 |

## Listener contract (recap)

| Event / Condition | Response |
|---|---|
| ping (valid HMAC) | 200 `pong` |
| push (valid HMAC, owner = `GITHUB_USER_OR_ORG`) | 202 + dispatch via systemd-run |
| push (owner mismatch) | 404 `unknown source` |
| any (missing or invalid HMAC) | 401 |
| body fails JSON.parse | 400 |
| owner/repo not LDH-shape | 400 |
| systemd-run dispatch exit ≠ 0 | 500 |
| event != push and event != ping | 204 |
| method ≠ POST on `/webhook/github` | 405 |
| any other path | 404 |

State write: `/var/lib/github-backup/last-webhook-event.json` written
atomically (temp + rename) after every push dispatch attempt, success or
fail. Phase 2's status command will read it (plan 03-04 / Phase 2 follow-up).

## Commits

| Hash | Task | Message |
|------|------|---------|
| `87c3989` | 1 | feat(03-02): add droplet/webhook-listener.js (vanilla Node, zero deps) |
| `fdad424` | 2 | feat(03-02): add droplet/Caddyfile.template |
| `3216708` | 3 | feat(03-02): add droplet/github-backup-webhook.service systemd unit |
| `5ae6f05` | 4 | feat(03-02): install caddy + node + webhook listener in bootstrap.sh |

## Verification

| Check | Expected | Got |
|---|---|---|
| `node --check droplet/webhook-listener.js` | 0 | 0 |
| `bash -n droplet/bootstrap.sh` | 0 | 0 |
| `grep -c timingSafeEqual droplet/webhook-listener.js` | ≥1 | 1 |
| `grep -c systemd-run droplet/webhook-listener.js` | ≥1 | 2 |
| `grep -c last-webhook-event.json droplet/webhook-listener.js` | ≥1 | 2 |
| Third-party `require(...)` calls | 0 | 0 |
| `grep -c reverse_proxy droplet/Caddyfile.template` | 1 | 1 |
| `grep -c __WEBHOOK_HOSTNAME__ droplet/Caddyfile.template` | 1 | 1 |
| `grep -c "EnvironmentFile=/opt/github-backups/backup.env" droplet/github-backup-webhook.service` | 1 | 1 |
| `grep -c github-backup-webhook droplet/bootstrap.sh` | ≥2 | 5 |
| `grep -c WEBHOOK_HOSTNAME droplet/bootstrap.sh` | ≥2 | 6 |

## Deviations from Plan

None — plan executed exactly as written.

**Total deviations:** 0.
**Impact:** None.

## Service-Name Cross-Phase Alignment

Phase 5 (`05-02-verify-script-PLAN.md`) probes for
`github-backup-webhook.service` to gate its Group 5 (listener-survival)
assertion. This plan installs the unit at exactly that path
(`/etc/systemd/system/github-backup-webhook.service`), so Phase 5's
probe-gated check activates automatically once a droplet is re-bootstrapped
on this code.

## Next

Plan 03-03 (operator-scaffolding) — runs in the same wave — adds the
config-side surface: `webhookHostname` validation, firewall +80 +443,
secret generation in `bootstrap-droplet`, `register-webhooks` CLI.

## Self-Check: PASSED

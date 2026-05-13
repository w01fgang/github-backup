---
phase: 03-webhook
plan: 03
subsystem: operator-tools
tags: [feature, typescript, firewall, secret-mgmt]
requires:
  - droplet/webhook-listener.js  # plan 03-02 — uses WEBHOOK_SECRET from backup.env
provides:
  - scripts/register-webhooks.ts
  - "Config.webhookHostname (required)"
  - "Config.webhookTestRepo (optional)"
affects:
  - scripts/lib/config.ts
  - scripts/create-droplet.ts
  - scripts/bootstrap-droplet.ts
  - package.json
  - config.example.json
tech-stack:
  added: []
  patterns:
    - Idempotent firewall rule reconciliation (D-23/D-24)
    - Preserve-by-default secret with opt-in --rotate-webhook-secret (D-09)
    - SSH-read-only secret lookup (no local cache) for register-webhooks (D-21)
    - Suffix-allow-list uploader filter (replaces .sh-only restriction)
key-files:
  created:
    - scripts/register-webhooks.ts
  modified:
    - scripts/lib/config.ts
    - scripts/create-droplet.ts
    - scripts/bootstrap-droplet.ts
    - package.json
    - config.example.json
key-decisions:
  - "D-04: webhookHostname required at loadConfig; FQDN-shape regex blocks malformed input before Caddy ever sees it"
  - "D-23: create-droplet opens TCP/80 + TCP/443 from 0.0.0.0/0,::/0 alongside SSH/22; firewall reconcile loop adds only the missing rules"
  - "D-07/D-09: WEBHOOK_SECRET preserved on re-bootstrap by default; --rotate-webhook-secret regenerates + echoes + prints re-register reminder"
  - "D-19: file-uploader filter is now {sh,js,template,service} so non-.sh droplet/ files (webhook-listener.js, Caddyfile.template, github-backup-webhook.service) ship to the droplet"
  - "D-21: register-webhooks reads secret over SSH each invocation — no local state-file drift after rotation"
requirements-completed:
  - WEBHOOK-01
  - PROV-01
  - PROV-02
  - BACKUP-03
duration: 32 min
completed: 2026-05-13
---

# Phase 3 Plan 03: operator-scaffolding Summary

Operator-facing TypeScript surface for the webhook plane: required
`webhookHostname` config field, idempotent firewall rule reconciliation
for TCP/80+443, bootstrap secret generation/preservation with
`--rotate-webhook-secret`, and a new `npm run register-webhooks` CLI that
idempotently creates or updates GitHub webhooks for every repo of
`cfg.githubUserOrOrg`.

## Outputs

| File | Status |
|------|--------|
| `scripts/lib/config.ts` | +Config.webhookHostname (req), +Config.webhookTestRepo (opt), +FQDN regex, +SLUG regex |
| `scripts/create-droplet.ts` | EXISTING firewall branch now reconciles rules; CREATE branch installs 22+80+443 |
| `scripts/bootstrap-droplet.ts` | +`--rotate-webhook-secret`, +`resolveWebhookSecret`, +WEBHOOK_SECRET/WEBHOOK_HOSTNAME in backup.env, uploader filter widened |
| `scripts/register-webhooks.ts` | new (208 lines) — gh-api wrapper with --update / --dry-run flags |
| `package.json` | +`register-webhooks` script |
| `config.example.json` | +`webhookHostname`, +`webhookTestRepo`, _readme updated |

## Commits

| Hash | Task | Message |
|------|------|---------|
| `564e6b8` | 1 | feat(03-03): extend Config with webhookHostname (required) + webhookTestRepo (optional) |
| `1719118` | 2 | feat(03-03): firewall reconciles +TCP/80 +TCP/443 idempotently |
| `f835ea0` | 3 | feat(03-03): generate/preserve WEBHOOK_SECRET, upload non-.sh files |
| `782ea1b` | 4 | feat(03-03): add scripts/register-webhooks.ts |
| `e5c9725` | 5 | feat(03-03): wire register-webhooks script + document webhook config fields |

## Verification

| Check | Expected | Got |
|---|---|---|
| `npx tsc --noEmit` (whole project) | 0 | 0 |
| `JSON.parse(config.example.json)` | OK | OK |
| `package.json scripts['register-webhooks']` | `tsx scripts/register-webhooks.ts` | matches |
| `grep -c webhookHostname scripts/lib/config.ts` | ≥2 | 7 |
| `grep -c 443 scripts/create-droplet.ts` | ≥2 | 4 |
| `grep -c WEBHOOK_SECRET scripts/bootstrap-droplet.ts` | ≥2 | 13 |
| `grep -c /webhook/github scripts/register-webhooks.ts` | ≥1 | 1 |
| `grep -c rotate-webhook-secret scripts/bootstrap-droplet.ts` | ≥1 | 4 |
| `grep -c endsWith scripts/bootstrap-droplet.ts` | 0 (rewritten to regex) | 0 |

## Behavioral checks (mental trace)

- **PROV-01 idempotency:** second `npm run create-droplet` against a firewall
  carrying TCP/22/80/443: reconcile loop hits `Rule already present` three
  times, never calls `doctl ... add-rules`. Zero side effects.
- **Webhook secret preservation:** second `npm run bootstrap-droplet`
  (no flag) reads `WEBHOOK_SECRET=<hex>` from remote backup.env over SSH,
  validates 64-hex shape, preserves verbatim. No new secret echoed.
- **Rotation path:** `npm run bootstrap-droplet -- --rotate-webhook-secret`
  generates a fresh `crypto.randomBytes(32).toString("hex")`, echoes
  exactly once, prints reminder to run `register-webhooks -- --update`.
- **register-webhooks dry-run:** prints `<would_register> would register,
  <would_update> would update, 0 failed`; makes zero POST/PATCH calls.

## Deviations from Plan

**[Rule 1 — bug fix] resolveWebhookSecret is synchronous, not Promise-returning.**
Found during: Task 3.
Plan's skeleton (`<task name="Task 3">` step 4) declared
`async function resolveWebhookSecret(): Promise<string>` and called it via
`await`. The function performs no async work — `runCapture` is a synchronous
`execSync` wrapper. Marking it `async` adds a one-tick promise hop and would
require the call site to `await` correctly.
Fix: dropped `async` from the declaration and `await` from the call site.
Files modified: `scripts/bootstrap-droplet.ts`.
Verification: `npx tsc --noEmit` exits 0.
Commit: `f835ea0`.

**Total deviations:** 1 auto-fixed (Rule 1 — bug).
**Impact:** None. Equivalent runtime behavior; type-correct without await.

## Next

Plan 03-04 (verify-readme) — Wave 3 — adds `scripts/verify/phase-3.ts`,
README `## Webhook setup` section, and the `verify:phase-3` npm script.

## Self-Check: PASSED

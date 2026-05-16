# Requirements — github-backup v1.1 Production hardening

Goal: close runtime-critical droplet bugs, webhook multi-source gaps, and outstanding human UAT/verification so v1.0 actually works end-to-end on a live droplet.

## v1.1 Requirements

### Droplet scripts (missing artifacts)

- [ ] **DROPLET-01**: Operator-triggered backup completes because `droplet/sync-one-repo.sh` exists on the droplet, is executable, and implements the per-repo clone/update contract (D-07 namespaced layout, `git clone --mirror` for new repos, `git remote update` for existing, per-repo `flock` on fd 8).
- [ ] **DROPLET-02**: `github-backup.sh` source-loads `droplet/lib/detect-account-type.sh` successfully and the helper resolves a source slug to `User` or `Organization` (default `User`) without aborting under `set -e`.
- [ ] **DROPLET-03**: `github-backup.sh` source-loads `droplet/lib/filter-repos.sh` successfully and the helper applies REPOS-01 allow/deny glob semantics (deny wins) for every iterated repo.

### Bootstrap manifest hardening

- [ ] **MANIFEST-01**: `scripts/bootstrap-droplet.ts` enforces a declared required-file manifest and exits non-zero **before any SSH** when any required droplet artifact is missing locally.
- [ ] **MANIFEST-02**: The webhook trio (`webhook-listener.js`, `Caddyfile.template`, `github-backup-webhook.service`) is treated as mandatory by the uploader so it cannot silently skip files that `droplet/bootstrap.sh:202-208` then hard-fails on.
- [ ] **MANIFEST-03**: README documents the complete `droplet/` file manifest so operators know exactly which files must ship for each phase.

### Webhook multi-source

- [ ] **WEBHOOK-03**: `webhook-listener.js` accepts and routes GitHub push events for any owner listed in `GITHUB_SOURCES` (no longer 404s on source #2+).
- [ ] **WEBHOOK-04**: `webhook-listener.js` sources `droplet/lib/filter-repos.sh` and applies the per-source allow/deny filter before dispatching `sync-one-repo.sh`, so a push to a denied repo does not trigger a sync (deny-wins parity with cron path).

### Live-droplet validation

- [ ] **VALID-01**: Phase 01 outstanding human UAT scenarios (8) completed against a live DigitalOcean droplet, results recorded, blocking items resolved.
- [ ] **VALID-02**: Phase 03 outstanding human UAT scenarios (6) **and** `phases/03-webhook/VERIFICATION.md` human-needed items closed against a live droplet.
- [ ] **VALID-03**: Phase 04 outstanding human UAT scenarios (4) **and** `phases/04-restore/VERIFICATION.md` human-needed items closed against a live droplet.
- [ ] **VALID-04**: `npm run verify:phase-3` is extended so it fails when WEBHOOK-03 or WEBHOOK-04 regress (multi-source routing + filter applied on webhook path).

## Future Requirements

*(Deferred — not in v1.1 scope.)*

- Disk-full auto-pruning / alerting beyond MON-03 usage report (still v2)
- Non-root SSH user (still v2)
- GitHub Enterprise / on-prem (out of scope)

## Out of Scope (v1.1)

- Refactoring `github-backup.sh` orchestration (only the missing-source breakage is in scope)
- New monitoring features beyond MON-01/02/03
- Adding new restore workflows beyond RESTORE-01/02
- Rewriting `webhook-listener.js` beyond multi-source routing + filter sourcing
- Automated droplet teardown (single-operator manual removal remains the documented path)
- Webhook secret rotation tooling (`--rotate-env` already shipped in v1.0 / Phase 5 covers rotation; no new lifecycle work this milestone)

## Traceability

| REQ-ID | Phase |
|--------|-------|
| DROPLET-01 | 7 — Droplet artifact shipping |
| DROPLET-02 | 7 — Droplet artifact shipping |
| DROPLET-03 | 7 — Droplet artifact shipping |
| MANIFEST-01 | 8 — Bootstrap uploader hardening |
| MANIFEST-02 | 8 — Bootstrap uploader hardening |
| MANIFEST-03 | 8 — Bootstrap uploader hardening |
| WEBHOOK-03 | 9 — Webhook multi-source + filter parity |
| WEBHOOK-04 | 9 — Webhook multi-source + filter parity |
| VALID-01 | 10 — Live-droplet UAT close-out |
| VALID-02 | 10 — Live-droplet UAT close-out |
| VALID-03 | 10 — Live-droplet UAT close-out |
| VALID-04 | 9 — Webhook multi-source + filter parity |

Coverage: 12/12 requirements mapped, no orphans, no duplicates.

---
*Last updated: 2026-05-16 — v1.1 roadmap drafted (Phases 7-10)*

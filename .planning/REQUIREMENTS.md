# Requirements — github-backup v1.1 Production hardening

Goal: close runtime-critical droplet bugs, webhook multi-source gaps, and outstanding human UAT/verification so v1.0 actually works end-to-end on a live droplet.

## v1.1 Requirements

### Droplet scripts (missing artifacts)

- [x] **DROPLET-01**: Operator-triggered backup completes because `droplet/sync-one-repo.sh` exists on the droplet, is executable, and implements the per-repo clone/update contract (D-07 namespaced layout, `git clone --mirror` for new repos, `git remote update` for existing, per-repo `flock` on fd 8).
- [x] **DROPLET-02**: `github-backup.sh` source-loads `droplet/lib/detect-account-type.sh` successfully and the helper resolves a source slug to `User` or `Organization` (default `User`) without aborting under `set -e`.
- [x] **DROPLET-03**: `github-backup.sh` source-loads `droplet/lib/filter-repos.sh` successfully and the helper applies REPOS-01 allow/deny glob semantics (deny wins) for every iterated repo.

### Bootstrap manifest hardening

- [x] **MANIFEST-01**: `scripts/bootstrap-droplet.ts` enforces a declared required-file manifest and exits non-zero **before any SSH** when any required droplet artifact is missing locally.
- [x] **MANIFEST-02**: The webhook trio (`webhook-listener.js`, `Caddyfile.template`, `github-backup-webhook.service`) is treated as mandatory by the uploader so it cannot silently skip files that `droplet/bootstrap.sh:202-208` then hard-fails on.
- [x] **MANIFEST-03**: README documents the complete `droplet/` file manifest so operators know exactly which files must ship for each phase.
- [x] **FIREWALL-01**: `scripts/create-droplet.ts` reconciles **outbound** firewall rules with the same drift-detection it already applies to inbound — restoring the canonical `TCP/all + UDP/all + ICMP/all` outbound set when an operator (or another tool) edits them away. Today only the inbound reconcile loop exists, so deleting outbound rules in the DO console silently breaks `git clone` / `gh api` / DNS until the next full firewall recreate.
- [x] **FIREWALL-02**: README documents the complete firewall ruleset (inbound TCP 22 from `allowedSSHCidr`, TCP 80 + TCP 443 from world; outbound TCP/UDP/ICMP unrestricted) and instructs operators to re-run `npm run create-droplet` to repair drift.

### Webhook multi-source

- [x] **WEBHOOK-03**: `webhook-listener.js` accepts and routes GitHub push events for any owner listed in `GITHUB_SOURCES` (no longer 404s on source #2+).
- [x] **WEBHOOK-04**: `webhook-listener.js` applies the source's `repos.allow` / `repos.deny` globs before dispatching a push (403 on a denied repo), and `register-webhooks.ts` never registers a hook on a denied repo. Both delegate to `droplet/lib/filter-repos.sh` — the helper the cron path sources — so all three mirror paths share one glob implementation. Dropped 2026-05-17 during Phase 9 discuss on the rationale that a per-repo webhook is explicit consent; reinstated after cross-AI review showed `register-webhooks.ts` auto-registers hooks on *every* admin-capable repo, so no per-repo consent is ever expressed (`.planning/REVIEWS.md`).

### Live-droplet validation

- [ ] **VALID-01**: Phase 01 outstanding human UAT scenarios (8) completed against a live DigitalOcean droplet, results recorded, blocking items resolved.
- [ ] **VALID-02**: Phase 03 outstanding human UAT scenarios (6) **and** `phases/03-webhook/VERIFICATION.md` human-needed items closed against a live droplet.
- [ ] **VALID-03**: Phase 04 outstanding human UAT scenarios (4) **and** `phases/04-restore/VERIFICATION.md` human-needed items closed against a live droplet.
- [x] **VALID-04**: `npm run verify:phase-3` is extended so it fails when WEBHOOK-03 regresses (multi-source routing accepts events for any GITHUB_SOURCES owner; assertion covers at least 2 distinct source owners).

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
| FIREWALL-01 | 8 — Bootstrap uploader hardening |
| FIREWALL-02 | 8 — Bootstrap uploader hardening |
| WEBHOOK-03 | 9 — Webhook multi-source + filter parity |
| WEBHOOK-04 | 9 (dropped) → reinstated post-review (see WEBHOOK-04 entry above) |
| VALID-01 | 10 — Live-droplet UAT close-out |
| VALID-02 | 10 — Live-droplet UAT close-out |
| VALID-03 | 10 — Live-droplet UAT close-out |
| VALID-04 | 9 — Webhook multi-source + filter parity |

Coverage: 14/14 active requirements mapped (WEBHOOK-04 reinstated after cross-AI review — see entry above), no orphans, no duplicates.

---
*Last updated: 2026-05-16 — v1.1 roadmap drafted (Phases 7-10)*

# github-backup

## What This Is

Fire-and-forget system that mirrors every repo from a GitHub user/org onto a DigitalOcean droplet, refreshed via GitHub push webhooks (primary) with a periodic cron sweep as safety net, and exposes them for `git clone` over SSH. All mirrors are bare repos at `/opt/github-backups/<owner>_<repo>.git`.

## Core Value

**One owner gets a self-hosted, always-fresh, restore-ready mirror of every repo they own.** If GitHub disappears tomorrow, you still have everything.

## Context

- Greenfield code already drafted (TypeScript provisioning + bash droplet scripts) but **never verified end-to-end**.
- Tech: Node ≥18 + tsx, `doctl`, `gh` CLI, bash on Ubuntu 22.04, cron, systemd, SSH.
- Single-droplet design — small ops surface, low cost (s-1vcpu-1gb).
- Sync triggers: GitHub push webhooks (primary, low-latency) + nightly cron sweep (safety net for missed deliveries, deletes, and idle repos).
- Secrets: `GITHUB_TOKEN` runtime-only, stored on droplet at `/opt/github-backups/backup.env` mode 600. Webhook shared secret stored alongside.
- Single user (operator). Not multi-tenant.

## Requirements

### Validated

(None — code drafted but unverified, treat all existing code as Active until first end-to-end run passes.)

### Active

- [ ] **PROV-01**: `npm run create-droplet` provisions DO droplet + firewall idempotently
- [ ] **PROV-02**: `npm run bootstrap-droplet` installs apt deps, gh CLI, cron job, webhook listener
- [ ] **BACKUP-01**: Cron sweep mirrors all repos from configured sources on schedule (safety net)
- [ ] **BACKUP-02**: New repos cloned with `git clone --mirror`, known repos refreshed with `git remote update`
- [ ] **WEBHOOK-01**: Public HTTPS endpoint on droplet authenticates GitHub push events via shared-secret HMAC
- [ ] **WEBHOOK-02**: Authenticated push event triggers per-repo mirror update within seconds
- [ ] **ACCESS-01**: Any standard `git clone` over SSH works against bare mirrors
- [ ] **MON-01**: Operator can verify last cron sweep + last webhook event status, repo update status, disk usage
- [ ] **RESTORE-01**: Documented + tested workflow to clone any backed-up repo back to local machine
- [ ] **TEARDOWN-01**: Idempotent re-bootstrap (cron, env, listener untouched on re-run)
- [ ] **MULTI-01**: Single droplet backs up multiple users/orgs from one config
- [ ] **TEST-01**: End-to-end smoke test (provision → bootstrap → backup → restore) runnable on demand

### Out of Scope

- Multi-tenant SaaS / multi-operator — single owner only
- GitHub Enterprise / on-prem — github.com only
- Pull request, issue, wiki backup — git refs only
- Backup encryption at rest beyond filesystem perms — single-tenant droplet
- Automated droplet teardown — manual DO-dashboard removal is the documented teardown path

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Bare mirrors via `git clone --mirror` | Refs + objects only, smallest disk, restorable to any client | — Pending |
| `gh api --paginate` for repo list | Auth + pagination already solved by gh CLI | — Pending |
| DO cloud firewall, SSH only from operator IP; HTTPS open to GitHub webhook source IPs | Minimal attack surface; webhook needs public ingress | — Pending |
| Single droplet, no clustering | Operator-scale, not org-scale | — Pending |
| `GITHUB_TOKEN` env-only, never in config.json | Avoid accidental commit | — Pending |
| Webhook + cron hybrid (webhook primary, cron safety net) | Low-latency on push, periodic sweep catches deletes / missed deliveries / idle repos | — Pending (added 2026-05-11) |
| No automated droplet teardown | Manual DO-dashboard removal is rare enough; scripted destroy is overhead | — Pending (added 2026-05-11) |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd-transition`):
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd-complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-05-11 — webhook hybrid added, automated teardown removed.*

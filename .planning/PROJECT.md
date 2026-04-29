# github-backup

## What This Is

Fire-and-forget system that mirrors every repo from a GitHub user/org onto a DigitalOcean droplet, refreshes them on a cron schedule, and exposes them for `git clone` over SSH. All mirrors are bare repos at `/opt/github-backups/<owner>_<repo>.git`.

## Core Value

**One owner gets a self-hosted, always-fresh, restore-ready mirror of every repo they own.** If GitHub disappears tomorrow, you still have everything.

## Context

- Greenfield code already drafted (TypeScript provisioning + bash droplet scripts) but **never verified end-to-end**.
- Tech: Node ≥18 + tsx, `doctl`, `gh` CLI, bash on Ubuntu 22.04, cron, SSH.
- Single-droplet design — small ops surface, low cost (s-1vcpu-1gb).
- Secrets: `GITHUB_TOKEN` runtime-only, stored on droplet at `/opt/github-backups/backup.env` mode 600.
- Single user (operator). Not multi-tenant.

## Requirements

### Validated

(None — code drafted but unverified, treat all existing code as Active until first end-to-end run passes.)

### Active

- [ ] **PROV-01**: `npm run create-droplet` provisions DO droplet + firewall idempotently
- [ ] **PROV-02**: `npm run bootstrap-droplet` installs apt deps, gh CLI, cron job
- [ ] **BACKUP-01**: Cron job mirrors all repos from configured user/org nightly
- [ ] **BACKUP-02**: New repos cloned with `git clone --mirror`, known repos refreshed with `git remote update`
- [ ] **ACCESS-01**: Any standard `git clone` over SSH works against bare mirrors
- [ ] **MON-01**: Operator can verify cron last-run status, repo update status, disk usage
- [ ] **RESTORE-01**: Documented + tested workflow to clone any backed-up repo back to local machine
- [ ] **TEARDOWN-01**: Idempotent re-bootstrap; teardown script removes droplet + firewall cleanly
- [ ] **MULTI-01**: Single droplet backs up multiple users/orgs from one config
- [ ] **TEST-01**: End-to-end smoke test (provision → bootstrap → backup → restore → teardown) runnable on demand

### Out of Scope

- Multi-tenant SaaS / multi-operator — single owner only
- GitHub Enterprise / on-prem — github.com only
- Real-time / webhook-driven backup — cron is enough
- Pull request, issue, wiki backup — git refs only
- Backup encryption at rest beyond filesystem perms — single-tenant droplet

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Bare mirrors via `git clone --mirror` | Refs + objects only, smallest disk, restorable to any client | — Pending |
| `gh api --paginate` for repo list | Auth + pagination already solved by gh CLI | — Pending |
| DO cloud firewall, SSH only from operator IP | Minimal attack surface | — Pending |
| Single droplet, no clustering | Operator-scale, not org-scale | — Pending |
| `GITHUB_TOKEN` env-only, never in config.json | Avoid accidental commit | — Pending |

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
*Last updated: 2026-04-29 after initialization*

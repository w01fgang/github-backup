# github-backup

## What This Is

Fire-and-forget system that mirrors every repo from one or more GitHub users/orgs onto a DigitalOcean droplet, refreshed via GitHub push webhooks (primary) with a periodic cron sweep as safety net, and exposes them for `git clone` over SSH. Bare mirrors stored at `/opt/github-backups/<owner>/<owner>_<repo>.git` (namespaced per-source).

## Core Value

**One operator gets a self-hosted, always-fresh, restore-ready mirror of every repo they own.** If GitHub disappears tomorrow, you still have everything.

## Context

Shipped v1.0 (2026-05-16). 6 phases, 19 plans across pipeline verification, monitoring, webhook listener, restore, bootstrap idempotency, and multi-source support.

- Tech: Node ≥18 + tsx, `doctl`, `gh` CLI, bash on Ubuntu 22.04, cron, Caddy, systemd, SSH.
- Single-droplet design — small ops surface, low cost (s-1vcpu-1gb).
- Sync triggers: GitHub push webhooks (primary, low-latency) + nightly cron sweep (safety net).
- Secrets: `GITHUB_TOKEN` runtime-only, stored at `/opt/github-backups/backup.env` mode 600. Webhook shared secret stored alongside.
- Single operator. Not multi-tenant.

**Known deferred at v1.0 close (8 items):**
- 3 runtime-critical: `sync-one-repo.sh` missing from droplet upload; `lib/detect-account-type.sh` + `lib/filter-repos.sh` missing; webhook file upload/validation mismatch.
- UAT: Phases 01, 03, 04 have partial human UAT outstanding.
- Verification: Phases 03, 04 need live-droplet human verification.

## Requirements

### Validated

- ✓ **PROV-01**: `npm run create-droplet` provisions DO droplet + firewall idempotently — v1.0
- ✓ **PROV-02**: `npm run bootstrap-droplet` installs apt deps, gh CLI, cron job, webhook listener — v1.0
- ✓ **BACKUP-01**: Cron sweep mirrors all repos from configured sources on schedule (safety net) — v1.0
- ✓ **BACKUP-02**: New repos cloned with `git clone --mirror`, known repos refreshed with `git remote update` — v1.0
- ✓ **BACKUP-03**: Atomic write of last-run.json after each backup run — v1.0
- ✓ **REPOS-01**: Config supports per-source repo allow-list and deny-list (glob patterns); deny wins — v1.0
- ✓ **WEBHOOK-01**: Public HTTPS endpoint on droplet authenticates GitHub push events via HMAC — v1.0
- ✓ **WEBHOOK-02**: Authenticated push event triggers per-repo mirror update within seconds — v1.0
- ✓ **ACCESS-01**: Any standard `git clone` over SSH works against bare mirrors — v1.0
- ✓ **MON-01**: Operator can verify last cron sweep status, repo update status, disk usage — v1.0
- ✓ **MON-02**: `npm run status` from laptop produces same output as droplet-side status binary — v1.0
- ✓ **MON-03**: `npm run verify:phase-2` end-to-end harness exercises monitoring contract — v1.0
- ✓ **RESTORE-01**: Documented + tested workflow to clone any backed-up repo back to local machine — v1.0
- ✓ **RESTORE-02**: Restored repo has identical branches + tags as the mirror — v1.0
- ✓ **TEARDOWN-01**: Idempotent re-bootstrap (cron, env, listener untouched on re-run) — v1.0
- ✓ **MULTI-01**: Single droplet backs up multiple users/orgs from one config — v1.0
- ✓ **TEST-01**: End-to-end smoke test (provision → bootstrap → backup → restore) runnable on demand — v1.0

### Active

*(Next milestone requirements to be defined via `/gsd-new-milestone`)*

- [ ] Fix 3 runtime-critical deferred items before v1.1 (missing droplet scripts)
- [ ] Complete live-droplet human UAT for Phases 01, 03, 04
- [ ] Multi-source webhook routing (events for source #2 currently 404)
- [ ] Webhook path REPOS-01 filtering (`filter-repos.sh` not sourced in webhook handler)

### Out of Scope

- Multi-tenant SaaS / multi-operator — single owner only
- GitHub Enterprise / on-prem — github.com only
- Pull request, issue, wiki backup — git refs only
- Backup encryption at rest beyond filesystem perms — single-tenant droplet
- Automated droplet teardown — manual DO-dashboard removal is the documented teardown path
- Non-root SSH user — root SSH accepted at single-operator scale; non-root deferred to v2
- Disk-full auto-pruning / alerting — beyond MON-03 usage report, deferred to v2

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Bare mirrors via `git clone --mirror` | Refs + objects only, smallest disk, restorable to any client | ✓ Good |
| `gh api --paginate` for repo list | Auth + pagination already solved by gh CLI | ✓ Good |
| DO cloud firewall, SSH only from operator IP; HTTPS open to GitHub webhook IPs | Minimal attack surface | ✓ Good |
| Single droplet, no clustering | Operator-scale, not org-scale | ✓ Good |
| `GITHUB_TOKEN` env-only, never in config.json | Avoid accidental commit | ✓ Good |
| Webhook + cron hybrid (webhook primary, cron safety net) | Low-latency on push, periodic sweep catches deletes/missed | ✓ Good |
| No automated droplet teardown | Manual DO-dashboard removal is rare enough | ✓ Good |
| Webhook TLS via Caddy + Let's Encrypt | Free, auto-renew, GitHub-compatible cert; operator burden = one DNS A record | ✓ Good |
| Per-repo allow/deny via glob lists | Operators often want a subset of an org's repos | ✓ Good |
| Webhook listener ships before multi-source | Core value is "push → near-instant sync"; demoable MVP earlier | ✓ Good |
| Root SSH for bootstrap and ops | Single-operator scale; non-root user deferred to v2 | ✓ Good |
| Namespaced mirror paths `/opt/github-backups/<owner>/<owner>_<repo>.git` | Required for multi-source isolation | ✓ Good |

---
*Last updated: 2026-05-16 after v1.0 milestone*

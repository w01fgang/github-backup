---
created: 2026-05-16T02:53:26.145Z
title: Webhook listener files optional in uploader but required at runtime
area: tooling
resolves_phase: 8
files:
  - scripts/bootstrap-droplet.ts:292
  - droplet/bootstrap.sh:202
---

## Problem

`bootstrap.sh:202-208` hard-fails if any of `webhook-listener.js`, `Caddyfile.template`, or `github-backup-webhook.service` are missing:
```bash
for f in webhook-listener.js Caddyfile.template github-backup-webhook.service; do
  if [[ ! -f "${BACKUP_DIR}/${f}" ]]; then ... exit 1; fi
done
```
However `bootstrap-droplet.ts:289-294` uses a permissive glob `/\.(sh|js|template|service)$/` and silently skips any that do not exist locally.

Result: bootstrap "succeeds" on a Phase-3 droplet, then crashes inside `bootstrap.sh` when it tries to validate the webhook files.

## Solution

1. Make the three webhook files mandatory in the upload manifest (fail fast in TS before any SSH).
2. Or gate the webhook installation block in `bootstrap.sh` behind a config flag / presence of `WEBHOOK_HOSTNAME`.
3. Document the complete `droplet/` file manifest in README so operators know exactly what must be present for each phase.

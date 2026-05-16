---
status: partial
phase: 03-webhook
source: [03-VERIFICATION.md]
started: 2026-05-13
updated: 2026-05-13
---

## Current Test

[awaiting human testing on a live droplet]

## Tests

### 1. DNS A record points at droplet
expected: operator creates an A record for `cfg.webhookHostname` → droplet.ip BEFORE `npm run bootstrap-droplet`. `dig A <webhookHostname>` from anywhere shows the droplet IP.
result: pending

### 2. Caddy auto-issues Let's Encrypt cert
expected: after bootstrap + first incoming HTTPS request, `journalctl -u caddy --since 5m` shows successful ACME challenge; `openssl s_client -servername <hostname> -connect <hostname>:443 | openssl x509 -noout -enddate` returns a notAfter in the future.
result: pending

### 3. systemctl is-active github-backup-webhook
expected: after bootstrap, `ssh root@<ip> systemctl is-active github-backup-webhook` returns `active`.
result: pending

### 4. Signed push triggers mirror within 30s
expected: `npm run register-webhooks` (after secret echoed during bootstrap); push a commit to cfg.webhookTestRepo; `BACKUP_REPO_RESULT … action=clone|update …` appears in `/var/log/github-backup.log` within 30s.
result: pending

### 5. Bad signature returns 401
expected: `curl -X POST -H 'X-Hub-Signature-256: sha256=deadbeef' …` to `https://<hostname>/webhook/github` returns 401 in <2s.
result: pending

### 6. Re-bootstrap preserves secret + restarts listener
expected: second `npm run bootstrap-droplet` (no flag) does NOT echo a new secret; logs `🔐  Preserving existing WEBHOOK_SECRET`; `systemctl is-active github-backup-webhook` still `active` after the run.
result: pending

## Summary

total: 6
passed: 0
issues: 0
pending: 6
skipped: 0
blocked: 0

## Gaps

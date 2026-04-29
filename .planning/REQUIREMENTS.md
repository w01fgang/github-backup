# Requirements — github-backup v1

## v1 Requirements

### Provisioning

- [ ] **PROV-01**: `npm run create-droplet` provisions DO droplet + cloud firewall idempotently (re-run is safe)
- [ ] **PROV-02**: `npm run bootstrap-droplet` installs apt deps, gh CLI, deploys backup scripts, installs cron job

### Backup Pipeline

- [ ] **BACKUP-01**: Cron job mirrors all repos from configured user/org on schedule
- [ ] **BACKUP-02**: New repos cloned with `git clone --mirror`; known repos refreshed with `git remote update`
- [ ] **BACKUP-03**: `GITHUB_TOKEN` stored on droplet at `/opt/github-backups/backup.env`, mode 600

### Access

- [ ] **ACCESS-01**: Operator can `git clone <user>@<droplet>:/opt/github-backups/<owner>_<repo>.git` over SSH

### Monitoring

- [ ] **MON-01**: Operator can check last cron run timestamp + exit status
- [ ] **MON-02**: Operator can see per-repo update status from last run
- [ ] **MON-03**: Operator can check disk usage on backup volume

### Restore

- [ ] **RESTORE-01**: Documented + tested workflow to clone any backed-up repo back to local machine
- [ ] **RESTORE-02**: Restore preserves all branches, tags, and refs

### Lifecycle

- [ ] **TEARDOWN-01**: Re-running bootstrap on a live droplet is idempotent (no duplicate cron, no clobbered config)
- [ ] **TEARDOWN-02**: `npm run destroy-droplet` removes droplet + firewall cleanly

### Multi-Source

- [ ] **MULTI-01**: Single droplet backs up multiple users/orgs from one config (array of sources)

### Testing

- [ ] **TEST-01**: End-to-end smoke test (provision → bootstrap → backup → restore → teardown) runnable on demand
- [ ] **TEST-02**: Each phase has an executable verification step beyond visual inspection

## v2 (deferred)

- Backup metrics → Prometheus / pushgateway
- Email/Slack alert on backup failure
- Automatic disk-grow when filling
- Multi-droplet sharding for very large orgs

## Out of Scope

- Multi-tenant SaaS — single operator only
- GitHub Enterprise / on-prem — github.com only
- Real-time webhook-driven backup — cron sufficient
- Issues, PRs, wikis — git refs only
- Encryption at rest beyond filesystem perms — single-tenant droplet

## Traceability

(Filled by roadmap.)

| REQ-ID | Phase |
|--------|-------|
| PROV-01, PROV-02 | Phase 1 |
| BACKUP-01, BACKUP-02, BACKUP-03 | Phase 1 |
| ACCESS-01 | Phase 1 |
| TEST-01 (initial), TEST-02 | Phase 1 |
| MON-01, MON-02, MON-03 | Phase 2 |
| RESTORE-01, RESTORE-02 | Phase 3 |
| TEARDOWN-01, TEARDOWN-02 | Phase 4 |
| MULTI-01 | Phase 5 |

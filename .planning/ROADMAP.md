# Roadmap — github-backup v1

6 phases | 15 requirements | All v1 requirements covered

| # | Phase | Goal | Requirements | UI hint |
|---|-------|------|--------------|---------|
| 1 | Verify pipeline | Existing code runs end-to-end on real droplet, smoke-tested | PROV-01, PROV-02, BACKUP-01, BACKUP-02, BACKUP-03, ACCESS-01, TEST-01, TEST-02 | no |
| 2 | Monitoring | Operator can answer "did backup run, did it work, am I out of disk" | MON-01, MON-02, MON-03 | no |
| 3 | Restore | Documented + tested clone-back path; refs preserved | RESTORE-01, RESTORE-02 | no |
| 4 | Bootstrap idempotency | `bootstrap-droplet` re-run is safe (no duplicate cron, no clobbered env) | TEARDOWN-01 | no |
| 5 | Multi-source | Single droplet backs up N users/orgs from one config | MULTI-01 | no |
| 6 | Webhook listener | GitHub push events trigger per-repo sync within seconds | WEBHOOK-01, WEBHOOK-02 | no |

---

## Phase Details

### Phase 1: Verify pipeline

**Goal**: Run existing TypeScript provisioning + bash droplet scripts end-to-end against a real DO droplet, confirm a real GitHub user/org is mirrored, and `git clone` over SSH works. Fix bugs uncovered.

**Requirements**: PROV-01, PROV-02, BACKUP-01, BACKUP-02, BACKUP-03, ACCESS-01, TEST-01, TEST-02

**Success criteria**:
1. `npm run create-droplet` succeeds; second run is no-op
2. `GITHUB_TOKEN=… npm run bootstrap-droplet` succeeds; cron job appears in `crontab -l` on droplet
3. Manual cron-trigger run mirrors at least 1 real repo to `/opt/github-backups/<owner>_<repo>.git`
4. `git clone root@<droplet-ip>:/opt/github-backups/<owner>_<repo>.git` from local machine succeeds
5. `backup.env` exists on droplet with mode 600

**Depends on**: nothing

**Plans:** 3 plans
- [ ] 01-01-foundation-PLAN.md — Extract scripts/lib helpers, add scripts/destroy-droplet.ts, wire all three new npm scripts
- [ ] 01-02-verify-script-PLAN.md — Implement scripts/verify/phase-1.ts (D-07 four assertion groups)
- [ ] 01-03-smoke-test-PLAN.md — Implement scripts/smoke-test.ts and run end-to-end against real DO + real GitHub user

---

### Phase 2: Monitoring

**Goal**: Operator can answer in <30 seconds: did last backup run, what changed, how full is the disk?

**Requirements**: MON-01, MON-02, MON-03

**Success criteria**:
1. `npm run status` (or droplet-side `github-backup-status`) shows last run timestamp + exit code
2. Per-repo log shows fetched/skipped/failed for last run
3. Disk usage of `/opt/github-backups` reported

**Depends on**: Phase 1

---

### Phase 3: Restore

**Goal**: Operator can recover any single repo back to a working clone with all branches/tags intact.

**Requirements**: RESTORE-01, RESTORE-02

**Success criteria**:
1. README has a Restore section with copy-pasteable commands
2. Restore test: clone-back, push a new commit locally, compare ref counts vs original mirror
3. Restored repo has identical branches + tags as the mirror

**Depends on**: Phase 1

---

### Phase 4: Bootstrap idempotency

**Goal**: `bootstrap-droplet` is safe to re-run on a live droplet — no duplicate cron entries, no clobbered `backup.env`, no orphaned listener processes.

**Requirements**: TEARDOWN-01

**Success criteria**:
1. Re-running `bootstrap-droplet` on a live droplet does not duplicate cron entries
2. Re-running preserves existing `backup.env` (token, webhook secret) by default; `--rotate-env` flag forces fresh upload
3. Re-running restarts the webhook listener cleanly (after Phase 6)

**Depends on**: Phase 1 (and Phase 6 once webhook listener exists)

**Note**: Automated droplet teardown (`destroy-droplet`) is OUT OF SCOPE per PROJECT.md (2026-05-11). Manual DO-dashboard removal is the documented teardown path.

---

### Phase 5: Multi-source

**Goal**: One droplet backs up N users/orgs declared in config, isolated under namespaced paths.

**Requirements**: MULTI-01

**Success criteria**:
1. `config.json` accepts `githubSources: ["userA", "orgB"]` (back-compat with single `githubUserOrOrg`)
2. Backup script iterates all sources, mirrors each into `/opt/github-backups/<source>/<owner>_<repo>.git`
3. Smoke test with 2 sources passes
4. Per-source status visible in monitoring (Phase 2)

**Depends on**: Phases 1, 2

---

### Phase 6: Webhook listener

**Goal**: GitHub push events trigger per-repo mirror update within seconds; cron sweep (Phase 1) becomes safety net rather than primary trigger.

**Requirements**: WEBHOOK-01, WEBHOOK-02

**Success criteria**:
1. Public HTTPS endpoint on droplet (e.g. `https://<droplet>/webhook/github`) accepts GitHub `push` event payloads
2. Requests with valid `X-Hub-Signature-256` HMAC trigger sync of the named repo; invalid signatures return 401 and are logged
3. End-to-end test: register webhook on a real test repo, push a commit, observe mirror updated within 30 seconds
4. Listener survives reboot (systemd unit) and bootstrap re-run (Phase 4)
5. Multi-source aware (Phase 5): incoming event resolves to correct `<source>/<owner>_<repo>.git` mirror path

**Depends on**: Phases 1, 4, 5

---

## Coverage

All 15 v1 requirements mapped. No requirement appears in more than one phase.

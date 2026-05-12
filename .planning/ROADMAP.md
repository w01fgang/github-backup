# Roadmap — github-backup v1

6 phases | 16 requirements | All v1 requirements covered

| # | Phase | Goal | Requirements | UI hint |
|---|-------|------|--------------|---------|
| 1 | Verify pipeline | Existing code runs end-to-end on real droplet, cron-path smoke-tested | PROV-01, PROV-02, BACKUP-01, BACKUP-02, BACKUP-03, ACCESS-01, TEST-01, TEST-02 | no |
| 2 | Monitoring | Operator can answer "did backup run, did it work, am I out of disk" | MON-01, MON-02, MON-03 | no |
| 3 | Webhook listener | GitHub push events trigger per-repo sync within seconds; TLS via Caddy + Let's Encrypt | WEBHOOK-01, WEBHOOK-02, TEST-03 | no |
| 4 | Restore | Documented + tested clone-back path; refs preserved | RESTORE-01, RESTORE-02 | no |
| 5 | Bootstrap idempotency | `bootstrap-droplet` re-run is safe (no duplicate cron, no clobbered env, listener restarts cleanly) | TEARDOWN-01 | no |
| 6 | Multi-source + per-repo filtering | Single droplet backs up N users/orgs from one config with per-repo allow/deny globs | MULTI-01, REPOS-01 | no |

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

### Phase 3: Webhook listener

**Goal**: GitHub push events trigger per-repo mirror update within seconds; cron sweep (Phase 1) becomes safety net rather than primary trigger.

**Requirements**: WEBHOOK-01, WEBHOOK-02, TEST-03

**Success criteria**:
1. Operator points a DNS A record (e.g. `backup.example.com`) at droplet IP before bootstrap
2. Caddy reverse proxy on droplet auto-issues + renews Let's Encrypt cert for the configured hostname
3. Public HTTPS endpoint (`https://<hostname>/webhook/github`) accepts GitHub `push` event payloads
4. Requests with valid `X-Hub-Signature-256` HMAC trigger sync of the named repo; invalid signatures return 401 and are logged
5. End-to-end test (TEST-03): register webhook on a real test repo, push a commit, observe mirror updated within 30 seconds
6. Listener survives reboot (systemd unit)
7. Single-source for now: incoming event resolves to `/opt/github-backups/<owner>_<repo>.git` (multi-source routing added in Phase 6)

**Depends on**: Phase 1

**Config additions**:
- `hostname`: FQDN that operator pointed at droplet IP (required for TLS)
- `letsEncryptEmail`: contact email for ACME registration

**Decision**: Caddy + Let's Encrypt over nginx/manual or plain-HTTP-HMAC. Caddy auto-handles cert lifecycle; LE is free; GitHub requires/prefers valid TLS. Operator burden: one DNS record.

---

### Phase 4: Restore

**Goal**: Operator can recover any single repo back to a working clone with all branches/tags intact.

**Requirements**: RESTORE-01, RESTORE-02

**Success criteria**:
1. README has a Restore section with copy-pasteable commands
2. Restore test: clone-back, push a new commit locally, compare ref counts vs original mirror
3. Restored repo has identical branches + tags as the mirror

**Depends on**: Phase 1

**Note**: Mostly documentation + verification. Standard `git clone` over SSH already works (ACCESS-01).

**Plans:** 3 plans
- [ ] 04-01-restore-helper-PLAN.md — Add `scripts/restore.ts` (`npm run restore -- <owner>/<repo> <target>`), `restoreTestRepo` field on Config, package.json wiring
- [ ] 04-02-verify-script-PLAN.md — Implement `scripts/verify/phase-4.ts` (D-02 ref-equivalence via sorted `for-each-ref` bare-vs-bare diff; D-03 drops self-push)
- [ ] 04-03-readme-docs-PLAN.md — Rewrite README §Recovery with two scenarios (D-07); cross-link with §Clone-a-mirrored-repo

> Plan files live in `.planning/phases/04-restore/`. CONTEXT.md inside that dir is the canonical Phase 4 context — its "Phase 3" header text predates the 2026-05-11 ROADMAP reorder; decisions remain valid.

---

### Phase 5: Bootstrap idempotency

**Goal**: `bootstrap-droplet` is safe to re-run on a live droplet — no duplicate cron entries, no clobbered `backup.env`, no orphaned listener processes.

**Requirements**: TEARDOWN-01

**Success criteria**:
1. Re-running `bootstrap-droplet` on a live droplet does not duplicate cron entries
2. Re-running preserves existing `backup.env` (token, webhook secret) by default; `--rotate-env` flag forces fresh upload
3. Re-running restarts the webhook listener cleanly (Phase 3 systemd unit reloaded, not duplicated)
4. Re-running preserves Caddy site config + LE certs (no re-issue storm)

**Depends on**: Phases 1, 3

**Note**: Automated droplet teardown (`destroy-droplet`) is OUT OF SCOPE per PROJECT.md (2026-05-11). Manual DO-dashboard removal is the documented teardown path.

---

### Phase 6: Multi-source + per-repo filtering

**Goal**: One droplet backs up N users/orgs declared in config with optional per-repo allow/deny filtering, isolated under namespaced paths. Webhook listener routes per-source events.

**Requirements**: MULTI-01, REPOS-01

**Success criteria**:
1. `config.json` accepts `githubSources: [{owner, repos: {allow: [...], deny: [...]}}]` (back-compat with single `githubUserOrOrg`)
2. Backup script iterates all sources, applies allow/deny globs, mirrors each into `/opt/github-backups/<owner>/<owner>_<repo>.git`
3. Webhook listener resolves incoming event to correct `<owner>/<owner>_<repo>.git` mirror path
4. Deny wins on allow/deny conflict
5. Empty allow-list = all repos of source
6. Smoke test with 2 sources + allow-list + deny-list passes
7. Per-source status visible in monitoring (Phase 2)

**Depends on**: Phases 1, 2, 3

---

## Coverage

All 16 v1 requirements mapped. No requirement appears in more than one phase.

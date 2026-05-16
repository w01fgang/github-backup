# Roadmap — github-backup

## Milestones

- ✅ **v1.0 MVP** — Phases 1-6 (shipped 2026-05-16)
- 🚧 **v1.1 Production hardening** — Phases 7-10

## Phases

<details>
<summary>✅ v1.0 MVP (Phases 1-6) — SHIPPED 2026-05-16</summary>

See `.planning/milestones/v1.0-ROADMAP.md` for full phase details.

- [x] Phase 1: Verify pipeline (3/3 plans) — completed 2026-05-16
- [x] Phase 2: Monitoring (4/4 plans) — completed 2026-05-13
- [x] Phase 3: Webhook listener (4/4 plans) — completed 2026-05-13
- [x] Phase 4: Restore (3/3 plans) — completed 2026-05-13
- [x] Phase 5: Bootstrap idempotency (2/2 plans) — completed 2026-05-15
- [x] Phase 6: Multi-source + per-repo filtering (3/3 plans) — completed 2026-05-15

</details>

### v1.1 Production hardening

- [ ] **Phase 7: Droplet artifact shipping** — Ship the three missing droplet scripts (`sync-one-repo.sh`, `lib/detect-account-type.sh`, `lib/filter-repos.sh`) so `github-backup.sh` runs end-to-end on the droplet
- [ ] **Phase 8: Bootstrap uploader hardening** — `scripts/bootstrap-droplet.ts` enforces a required-file manifest and fails before SSH on missing artifacts; webhook trio mandatory; README documents the manifest
- [ ] **Phase 9: Webhook multi-source + filter parity** — `webhook-listener.js` routes events for any `GITHUB_SOURCES` owner and applies `filter-repos.sh` deny-wins before dispatch; `verify:phase-3` asserts both
- [ ] **Phase 10: Live-droplet UAT close-out** — Outstanding Phase 01/03/04 human UAT scenarios and Phase 03/04 VERIFICATION.md human-needed items closed against a live droplet

---

## Phase Details

### Phase 7: Droplet artifact shipping

**Goal**: Every script that `github-backup.sh` and `webhook-listener.js` source-load actually exists on the droplet, is executable, and honours its contract.

**Depends on**: v1.0 closed (Phases 1-6)

**Requirements**: DROPLET-01, DROPLET-02, DROPLET-03

**Success Criteria** (what must be TRUE):
  1. After `npm run bootstrap-droplet`, `/opt/github-backups/sync-one-repo.sh` exists, is executable, implements the D-07 namespaced layout (`/opt/github-backups/<owner>/<owner>_<repo>.git`), clones new repos with `git clone --mirror`, refreshes known repos with `git remote update`, and holds a per-repo `flock` on fd 8.
  2. `github-backup.sh` source-loads `droplet/lib/detect-account-type.sh` under `set -e` without aborting; the helper resolves an arbitrary source slug to exactly `User` or `Organization`, defaulting to `User` when `gh api` cannot classify.
  3. `github-backup.sh` source-loads `droplet/lib/filter-repos.sh` under `set -e` without aborting; for every iterated repo the helper applies REPOS-01 allow/deny glob semantics with deny winning on conflict and empty allow meaning "all".
  4. Running the cron path manually on a freshly-bootstrapped droplet mirrors at least one real repo end-to-end without an unbound-variable / command-not-found error.

**Plans**: TBD

---

### Phase 8: Bootstrap uploader hardening

**Goal**: `scripts/bootstrap-droplet.ts` cannot silently skip a droplet artifact that `droplet/bootstrap.sh` later hard-fails on; operators see the missing-file error locally before any SSH connection.

**Depends on**: Phase 7 (manifest must enumerate the artifacts Phase 7 ships)

**Requirements**: MANIFEST-01, MANIFEST-02, MANIFEST-03

**Success Criteria** (what must be TRUE):
  1. `scripts/bootstrap-droplet.ts` declares an explicit required-file manifest covering every artifact in `droplet/` and `droplet/lib/` that the droplet-side scripts source or exec.
  2. Running `npm run bootstrap-droplet` with any required file deleted exits non-zero with a clear "missing required artifact: <path>" message **before** opening an SSH session.
  3. The webhook trio (`webhook-listener.js`, `Caddyfile.template`, `github-backup-webhook.service`) is treated as mandatory by the uploader — removing any of the three triggers the same pre-flight failure rather than silently skipping the upload (which `droplet/bootstrap.sh:202-208` would then hard-fail on).
  4. README has a "Droplet file manifest" section that lists every required file, its purpose, and the phase that owns it.

**Plans**: TBD

---

### Phase 9: Webhook multi-source + filter parity

**Goal**: The webhook path matches the cron path — events for any `GITHUB_SOURCES` owner are accepted, and a push to a denied repo never triggers a sync.

**Depends on**: Phase 7 (`droplet/lib/filter-repos.sh` must exist on droplet for WEBHOOK-04 to source it)

**Requirements**: WEBHOOK-03, WEBHOOK-04, VALID-04

**Success Criteria** (what must be TRUE):
  1. `webhook-listener.js` reads the `GITHUB_SOURCES` env list and returns 2xx for an authenticated push event whose `repository.owner.login` matches **any** configured source (no longer 404s on source #2+).
  2. `webhook-listener.js` source-loads `droplet/lib/filter-repos.sh` and applies the per-source allow/deny filter before dispatching `sync-one-repo.sh`; a valid HMAC push event for a denied repo returns a non-sync response (e.g. 202 ignored) and does **not** spawn a sync.
  3. `npm run verify:phase-3` fails when either WEBHOOK-03 (multi-source routing) or WEBHOOK-04 (deny-wins on webhook path) regresses — assertions cover both behaviours.
  4. Existing WEBHOOK-01 / WEBHOOK-02 success criteria still pass against the modified listener (HMAC auth, per-repo sync within seconds).

**Plans**: TBD

---

### Phase 10: Live-droplet UAT close-out

**Goal**: Every outstanding human UAT scenario and VERIFICATION human-needed item from v1.0 Phases 01, 03, 04 is exercised against a live DigitalOcean droplet, results recorded, blocking items resolved.

**Depends on**: Phases 7, 8, 9 (bug-fix phases must ship before UAT can pass)

**Requirements**: VALID-01, VALID-02, VALID-03

**Success Criteria** (what must be TRUE):
  1. All 8 Phase 01 human UAT scenarios have a recorded pass/fail outcome against a live droplet; any failure has an issue raised and resolved before this phase closes.
  2. All 6 Phase 03 human UAT scenarios **and** every human-needed item in `phases/03-webhook/VERIFICATION.md` is closed with a recorded outcome against a live droplet.
  3. All 4 Phase 04 human UAT scenarios **and** every human-needed item in `phases/04-restore/VERIFICATION.md` is closed with a recorded outcome against a live droplet.
  4. The v1.0 deferred-items table in STATE.md has every `uat_gap` and `verification_gap` row marked resolved with the date and verifying commit/SUMMARY reference.

**Plans**: TBD

---

## Progress

| Phase | Milestone | Plans Complete | Status   | Completed  |
|-------|-----------|----------------|----------|------------|
| 1. Verify pipeline | v1.0 | 3/3 | Complete | 2026-05-16 |
| 2. Monitoring | v1.0 | 4/4 | Complete | 2026-05-13 |
| 3. Webhook listener | v1.0 | 4/4 | Complete | 2026-05-13 |
| 4. Restore | v1.0 | 3/3 | Complete | 2026-05-13 |
| 5. Bootstrap idempotency | v1.0 | 2/2 | Complete | 2026-05-15 |
| 6. Multi-source + per-repo filtering | v1.0 | 3/3 | Complete | 2026-05-15 |
| 7. Droplet artifact shipping | v1.1 | 0/? | Not started | — |
| 8. Bootstrap uploader hardening | v1.1 | 0/? | Not started | — |
| 9. Webhook multi-source + filter parity | v1.1 | 0/? | Not started | — |
| 10. Live-droplet UAT close-out | v1.1 | 0/? | Not started | — |

## Coverage

All 12 v1.1 requirements mapped to exactly one phase. No orphans.

| REQ-ID | Phase |
|--------|-------|
| DROPLET-01 | 7 |
| DROPLET-02 | 7 |
| DROPLET-03 | 7 |
| MANIFEST-01 | 8 |
| MANIFEST-02 | 8 |
| MANIFEST-03 | 8 |
| WEBHOOK-03 | 9 |
| WEBHOOK-04 | 9 |
| VALID-04 | 9 |
| VALID-01 | 10 |
| VALID-02 | 10 |
| VALID-03 | 10 |

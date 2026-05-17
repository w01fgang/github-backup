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

- [x] **Phase 7: Droplet artifact shipping** — Ship the three missing droplet scripts (`sync-one-repo.sh`, `lib/detect-account-type.sh`, `lib/filter-repos.sh`) so `github-backup.sh` runs end-to-end on the droplet (completed 2026-05-16)
- [x] **Phase 8: Bootstrap uploader hardening** — `scripts/bootstrap-droplet.ts` enforces a required-file manifest and fails before SSH on missing artifacts; webhook trio mandatory; README documents the manifest; `scripts/create-droplet.ts` reconciles outbound firewall rules (parity with inbound) so operator-edited drift is repaired on next run (completed 2026-05-17)
- [x] **Phase 9: Webhook multi-source + filter parity** — `webhook-listener.js` routes events for any `GITHUB_SOURCES` owner via per-request re-read of `backup.env`; `verify:phase-3` Group 7 asserts multi-source routing for every configured source (WEBHOOK-04 dropped 2026-05-17 — per-repo webhook = explicit operator consent)
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

**Plans**: 1 plan
- [x] 07-01-PLAN.md — Verify DROPLET-01/02/03 contracts via new scripts/verify/phase-7.ts on live droplet

---

### Phase 8: Bootstrap uploader hardening

**Goal**: `scripts/bootstrap-droplet.ts` cannot silently skip a droplet artifact that `droplet/bootstrap.sh` later hard-fails on; operators see the missing-file error locally before any SSH connection. Additionally, `scripts/create-droplet.ts` reconciles outbound firewall rules so operator-edited drift (e.g. accidentally deleting outbound `TCP/all` + `UDP/all` in the DO console) is detected and repaired on the next run — preventing the silent-`git clone`-failure mode discovered in Phase 7 validation.

**Depends on**: Phase 7 (manifest must enumerate the artifacts Phase 7 ships)

**Requirements**: MANIFEST-01, MANIFEST-02, MANIFEST-03, FIREWALL-01, FIREWALL-02

**Success Criteria** (what must be TRUE):
  1. `scripts/bootstrap-droplet.ts` declares an explicit required-file manifest covering every artifact in `droplet/` and `droplet/lib/` that the droplet-side scripts source or exec.
  2. Running `npm run bootstrap-droplet` with any required file deleted exits non-zero with a clear "missing required artifact: <path>" message **before** opening an SSH session.
  3. The webhook trio (`webhook-listener.js`, `Caddyfile.template`, `github-backup-webhook.service`) is treated as mandatory by the uploader — removing any of the three triggers the same pre-flight failure rather than silently skipping the upload (which `droplet/bootstrap.sh:202-208` would then hard-fail on).
  4. README has a "Droplet file manifest" section that lists every required file, its purpose, and the phase that owns it.
  5. `scripts/create-droplet.ts` reconciles **outbound** rules with the same drift-detection it already applies to inbound (lines 153-200): on `npm run create-droplet` against an existing firewall whose outbound rules have been edited away, the script restores the canonical `TCP/all + UDP/all + ICMP/all` outbound set and logs `+ Adding outbound rule: …` for each restored entry. Re-running with the canonical set already present logs `✓ Rule already present: …` and makes zero `doctl add-rules` calls.
  6. README documents the complete firewall ruleset (inbound TCP 22 from `allowedSSHCidr`, TCP 80 + TCP 443 from world; outbound TCP/UDP/ICMP unrestricted to world) and instructs operators to re-run `npm run create-droplet` to repair drift.

**Plans**: 4 plans
- [x] 08-01-PLAN.md — Manifest module + uploader pre-flight rewrite (MANIFEST-01, MANIFEST-02)
- [x] 08-02-PLAN.md — Direction-aware reconcileRules helper + outbound reconcile (FIREWALL-01)
- [x] 08-03-PLAN.md — sync-readme-manifest.ts + README managed/hand-maintained sections (MANIFEST-03, FIREWALL-02)
- [x] 08-04-PLAN.md — Pre-commit hook (D-08) + sync-check CI workflow (D-09)

---

### Phase 9: Webhook multi-source + filter parity

**Goal**: The webhook path matches the cron path — events for any `GITHUB_SOURCES` owner are accepted, and a push to a denied repo never triggers a sync.

**Depends on**: Phase 7 (`droplet/lib/filter-repos.sh` shipped by Phase 7; webhook path no longer sources it after WEBHOOK-04 was dropped 2026-05-17, but Phase 7 closure remains the cleanest dependency boundary)

**Requirements**: WEBHOOK-03, VALID-04 (WEBHOOK-04 dropped 2026-05-17 — see REQUIREMENTS.md)

**Success Criteria** (what must be TRUE):
  1. `webhook-listener.js` reads the `GITHUB_SOURCES` env list and returns 2xx for an authenticated push event whose `repository.owner.login` matches **any** configured source (no longer 404s on source #2+).
  2. `npm run verify:phase-3` fails when WEBHOOK-03 regresses — assertion covers multi-source routing for at least 2 distinct source owners.
  3. Existing WEBHOOK-01 / WEBHOOK-02 success criteria still pass against the modified listener (HMAC auth, per-repo sync within seconds).
  4. *(Dropped 2026-05-17.)* The earlier SC#2 / SC#3 assertions about filter-on-webhook-path were retired with WEBHOOK-04 — per-repo webhook configuration is treated as explicit operator consent. See `.planning/phases/09-webhook-multi-source-filter-parity/09-CONTEXT.md` §"Deferred Ideas".

**Plans**: 2 plans
- [x] 09-01-PLAN.md — Multi-source webhook listener with per-request env re-read (WEBHOOK-03)
- [x] 09-02-PLAN.md — verify:phase-3 Group 7 multi-source routing regression (VALID-04)

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
| 7. Droplet artifact shipping | v1.1 | 1/1 | Complete    | 2026-05-16 |
| 8. Bootstrap uploader hardening | v1.1 | 4/4 | Complete    | 2026-05-17 |
| 9. Webhook multi-source + filter parity | v1.1 | 2/2 | Complete    | 2026-05-17 |
| 10. Live-droplet UAT close-out | v1.1 | 0/? | Not started | — |

## Coverage

All 11 active v1.1 requirements mapped to exactly one phase. No orphans. (WEBHOOK-04 dropped 2026-05-17 — see REQUIREMENTS.md.)

| REQ-ID | Phase |
|--------|-------|
| DROPLET-01 | 7 |
| DROPLET-02 | 7 |
| DROPLET-03 | 7 |
| MANIFEST-01 | 8 |
| MANIFEST-02 | 8 |
| MANIFEST-03 | 8 |
| WEBHOOK-03 | 9 |
| WEBHOOK-04 | 9 — dropped 2026-05-17 |
| VALID-04 | 9 |
| VALID-01 | 10 |
| VALID-02 | 10 |
| VALID-03 | 10 |

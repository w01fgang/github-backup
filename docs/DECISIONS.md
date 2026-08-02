# Decisions glossary

## 1. What this is

Source comments across `scripts/` and `droplet/` cite short identifiers — `D-07`, `SC#4`, `REPOS-01`, `NR-08`, and the like. This file is the definition of record for every one of them: what each means, stated in the present tense, and where it is enforced in code today. It is self-contained by design, so the planning tree those definitions were extracted from can be removed without stranding a single comment.

`D-xx` and (mostly) `SC#N` identifiers are **phase-scoped** — phase 03's `D-16` and phase 06's `D-16` are unrelated decisions that happen to share a number. Entries below are grouped by the phase that defined them. `NR-xx` and `REQ-ID`-style identifiers (`REPOS-01`, `WEBHOOK-03`, …) are global — one definition, no phase suffix needed.

## 2. Requirements

| ID | Phase | Statement | Enforced in code |
|---|---|---|---|
| `REPOS-01` | v1.0 Phase 6 | Config supports a per-source repo allow-list and deny-list (glob patterns); an empty allow-list means all repos of the source; deny wins on conflict. | `droplet/lib/filter-repos.sh:filter_repos`, `scripts/lib/filter-repos.ts:filterRepos`, sourced by `droplet/github-backup.sh`, `droplet/webhook-listener.js:passesRepoFilter`, `scripts/register-webhooks.ts` |
| `WEBHOOK-03` | v1.1 Phase 9 | `webhook-listener.js` accepts and routes a `push` event for any owner listed in `GITHUB_SOURCES`, not just source #1. | `droplet/webhook-listener.js` (per-request `backup.env` re-read + `Set.has(owner)`), regression-tested by `scripts/verify/phase-3.ts` Group 7 |
| `WEBHOOK-04` | v1.1 Phase 9 | `webhook-listener.js` applies the source's `repos.allow`/`repos.deny` globs before dispatching a push; `register-webhooks.ts` never registers a hook on a denied repo. | `droplet/webhook-listener.js:passesRepoFilter`, `scripts/register-webhooks.ts` (filters via `scripts/lib/filter-repos.ts`) |
| `MANIFEST-01` | v1.1 Phase 8 | `bootstrap-droplet.ts` enforces a declared required-file manifest and exits non-zero **before any SSH** when a required droplet artifact is missing locally. | `scripts/lib/droplet-manifest.ts` (manifest source of truth), `scripts/bootstrap-droplet.ts` (pre-flight loop over `manifestRequired`) |
| `MANIFEST-03` | v1.1 Phase 8 | README documents the complete `droplet/` file manifest. | `scripts/sync-readme-manifest.ts` (renders the manifest table into README.md's managed section) |
| `FIREWALL-01` | v1.1 Phase 8 | `create-droplet.ts` reconciles **outbound** firewall rules with the same drift-detection already applied to inbound. | `scripts/create-droplet.ts:reconcileRules` (direction-aware), called for `"outbound"` inside `findOrCreateFirewall` |
| `VALID-01` | v1.1 Phase 10 | The 8 outstanding Phase 01 human UAT scenarios are run against a live droplet and recorded. | `scripts/uat-runner.ts` (scenarios `phase: "01"`) |
| `RESTORE-01` | v1.0 Phase 4 | Documented + tested workflow clones any backed-up repo back to a local machine. | `scripts/restore.ts`, `scripts/verify/phase-4.ts` Group 1 |
| `RESTORE-02` | v1.0 Phase 4 | Restore preserves all branches, tags, and refs. | `scripts/verify/phase-4.ts` Groups 2–3 (sorted `for-each-ref` diff + branch/tag presence) |
| `TEST-01` | v1.0 Phase 1 | A cron-path smoke test (provision → bootstrap → trigger → probe → clone) is runnable on demand. | `scripts/smoke-test.ts` (`npm run smoke-test`) |
| `TEST-02` | v1.0 Phase 1 | Each phase has an executable verification step beyond visual inspection. | `scripts/verify/phase-1.ts` … `phase-7.ts` (`npm run verify:phase-N`) |
| `TEST-03` | v1.0 Phase 3 | A webhook-path smoke test registers a webhook, pushes a commit, and observes the mirror update within 30s. | `scripts/verify/phase-3.ts` Groups 4–5 |

**Conflict flag:** `WEBHOOK-04` was dropped mid-Phase-9 (rationale: a per-repo webhook is explicit operator consent — see phase 09's `D-03` below) and then **reinstated** after cross-AI review found `register-webhooks.ts` auto-registers hooks on every admin-capable repo, so consent was never actually expressed. Current code (`passesRepoFilter` in `webhook-listener.js`, plus the deny-tracking in `register-webhooks.ts`) implements the reinstated, filtered behavior — phase 09's `D-03` ("NO-FILTER") below describes the intermediate, no-longer-current state and is kept only for historical grounding of that decision's citations.

## 3. Decisions (`D-xx`, phase-scoped)

### Phase 01 — Verify pipeline (v1.0)

| ID | Decision | Cited by |
|---|---|---|
| `D-01` | Smoke test targets the operator's real personal GitHub account — no throwaway org, no repo-count cap. | `scripts/smoke-test.ts` |
| `D-02` | Pass bar is 100%: every returned repo must mirror successfully, or the run fails. | `droplet/github-backup.sh`, `scripts/smoke-test.ts`, `scripts/verify/phase-1.ts` |
| `D-03` | The end-to-end smoke runner is `scripts/smoke-test.ts`, TypeScript via `tsx`, wired as `npm run smoke-test`. | `scripts/smoke-test.ts` |
| `D-04` | Smoke scope is provision → bootstrap → trigger one backup → SSH-probe a mirror → clone it locally; stops at the clone-probe. | `scripts/smoke-test.ts` |
| `D-05` | Smoke reuses the real `config.json` + `GITHUB_TOKEN` contract — no separate test config. | `scripts/smoke-test.ts` |
| `D-06` | Per-phase verification ships as `npm run verify:phase-N` TypeScript scripts, one per phase. | `scripts/verify/phase-1.ts` |
| `D-07` | `verify:phase-1` asserts four groups, in order: provision, bootstrap-over-SSH, backup-ran, clone-probe. | `scripts/verify/phase-1.ts` |
| `D-08` | Droplet is persistent by default across smoke/verify runs. (The original opt-in `--fresh` reset flag was reversed and the destroy script deleted 2026-05-11 — see that phase's CONTEXT amendment.) | `scripts/smoke-test.ts` |

### Phase 02 — Monitoring (v1.0)

| ID | Decision | Cited by |
|---|---|---|
| `D-01` | Both surfaces ship: a local `npm run status` TS wrapper that SSHes and invokes the droplet-side `github-backup-status` binary. | `droplet/github-backup-status.sh`, `scripts/status.ts`, `scripts/verify/phase-2.ts` |
| `D-02` | The local wrapper forwards flags (`--json`, `--verbose`) straight through, so behavior is identical on either surface. | `scripts/status.ts`, `scripts/verify/phase-2.ts` |
| `D-03` | `droplet/github-backup.sh` writes a structured run summary to `/var/lib/github-backup/last-run.json`, atomically (temp+rename), at the end of every run. | `droplet/github-backup.sh`, `scripts/verify/phase-2.ts` |
| `D-04` | The status binary falls back to tailing `/var/log/github-backup.log`'s summary line when `last-run.json` is missing. | `droplet/github-backup-status.sh` |
| `D-05` | `/var/lib/github-backup/` is created mode 700 by `droplet/bootstrap.sh`. | `droplet/github-backup.sh`, `scripts/verify/phase-2.ts` |
| `D-06` | Default status output is a counts header plus failed-repo names; the full per-repo list needs `--verbose`. | `droplet/github-backup-status.sh` |
| `D-07` | Verbose per-repo lines are formatted `<glyph> <action> <owner>/<repo>`. | `droplet/github-backup-status.sh` |
| `D-08` | Status always shows `df -h` capacity/used and `du -sh` mirror footprint; per-repo size needs `--verbose`. | `droplet/github-backup-status.sh`, `scripts/verify/phase-2.ts` |
| `D-09` | `--json` emits one JSON object — a superset of `last-run.json` plus `disk` and `staleness` blocks. | `droplet/github-backup-status.sh` |
| `D-10` | Staleness = `now - finished_at > 2× expected interval`, expected interval parsed from `CRON_SCHEDULE`. | `droplet/github-backup-status.sh` |
| `D-11` | Status reports `NEVER RAN` (non-zero exit) when `last-run.json` is missing and the log has no summary. | `droplet/github-backup-status.sh` |
| `D-12` | "Skipped" is dropped from the vocabulary; per-repo action is always `clone \| update \| fail`. | `droplet/github-backup.sh` |
| `D-13` | Status exit codes: `0` fresh success, `1` failures present, `2` stale, `3` never-ran/unreadable. | `droplet/github-backup-status.sh` |

### Phase 03 — Webhook listener (v1.0)

| ID | Decision | Cited by |
|---|---|---|
| `D-01` | Listener runtime is Caddy (reverse proxy + auto Let's Encrypt) in front of a small, zero-dependency Node.js listener on `127.0.0.1:9100`. | `droplet/webhook-listener.js` |
| `D-04` | Operator must set `config.json` `webhookHostname` to a real FQDN; bootstrap fails loud if absent — no HTTP or self-signed fallback. | `scripts/lib/config.ts` |
| `D-07` | Per-source webhook secrets (`WEBHOOK_SECRET_<SOURCE_UPPER>`) are generated on the droplet at bootstrap and preserved across re-bootstraps by default. | `scripts/bootstrap-droplet.ts` |
| `D-08` | Source names are already shell-safe (Phase 6 `SHELL_SAFE_RE`), which is what makes the derived `WEBHOOK_SECRET_<SOURCE_UPPER>` env-var name valid; no extra validation needed here. | `scripts/lib/config.ts` |
| `D-09` | `--rotate-webhook-secrets` on bootstrap regenerates and reprints all webhook secrets; operator must then re-register. | `scripts/bootstrap-droplet.ts` |
| `D-15` | Per-repo mirror logic lives in `droplet/sync-one-repo.sh <source> <owner> <repo>`, shared by cron and webhook; it emits `BACKUP_REPO_RESULT … action=<clone\|update\|fail>`. | `droplet/github-backup.sh`, `droplet/sync-one-repo.sh` |
| `D-16` | Cron holds the global lock; webhook handlers skip it and take only the per-repo lock `sync-one-repo.sh` acquires on fd 8 — same repo serializes, different repos run in parallel. | `droplet/github-backup.sh` |
| `D-17` | `/var/lib/github-backup/last-webhook-event.json` is written atomically after every webhook-triggered sync, for the status command. | `droplet/webhook-listener.js` |
| `D-19` | `droplet/bootstrap.sh` installs Caddy + Node.js and writes the Caddyfile / listener.js / systemd-unit templates (always overwritten), then reloads/enables them idempotently. | `scripts/bootstrap-droplet.ts` |
| `D-21` | `npm run register-webhooks` idempotently creates a GitHub webhook per repo per configured source, reading the secret from the droplet over SSH. | `scripts/register-webhooks.ts` |
| `D-22` | `--update` on `register-webhooks` PATCHes existing hooks with a rotated secret; without it, existing hooks are left alone. | `scripts/register-webhooks.ts` |
| `D-23` | `scripts/create-droplet.ts` adds inbound TCP/80 + TCP/443 from `0.0.0.0/0` alongside the existing SSH rule, for Caddy + Let's Encrypt. | `scripts/create-droplet.ts` |
| `D-24` | Existing droplets pick up the new firewall rules by re-running `npm run create-droplet`; no separate migration command. | `scripts/create-droplet.ts` |
| `D-25` | `scripts/verify/phase-3.ts` follows the Phase 1 verify template (TS/`tsx`, fail-fast `assert`); `config.json` `webhookTestRepo` is consumed only by this script. | `scripts/lib/config.ts` |
| `D-26` | `verify:phase-3` runs six ordered assertion groups: pre-conditions, source-resolution 404, bad-signature 401, end-to-end push, idempotent re-send, listener-restart survival. | `scripts/verify/phase-3.ts` |

### Phase 04 — Restore (v1.0)

| ID | Decision | Cited by |
|---|---|---|
| `D-01` | `config.json` `restoreTestRepo` (optional `<owner>/<repo>`) pins the repo `verify:phase-4` and `restore.ts` operate on; unset means a loud bail naming the field. | `scripts/verify/phase-4.ts` |
| `D-02` | Ref-equivalence is proven by sorted `git for-each-ref` byte-equality between the droplet bare mirror and an intermediate local bare mirror — not the working clone, not github.com. | `scripts/verify/phase-4.ts` |
| `D-03` | No self-push assertion: sorted `for-each-ref` equality already proves byte-equivalent refs, so a throwaway-bare push round-trip would add zero signal. | `scripts/verify/phase-4.ts` |
| `D-04` | `scripts/restore.ts` is a TypeScript helper, not README copy-paste, invoked by both the operator and `verify:phase-4` — one code path for the restore dance. | `scripts/restore.ts` |
| `D-06` | On failure, `verify:phase-4` leaves the temp restore directory on disk and prints its path for operator inspection. | `scripts/verify/phase-4.ts` |
| `D-07` | `verify:phase-4 -- --inject-ref-mismatch` is Group 2's negative test: it writes `refs/heads/__verify_mismatch__` into the restored bare mirror after the clone and before the comparison, so exit 1 proves the detector fires. It never writes to the droplet, and exit 2 means the injected divergence went unnoticed. | `scripts/verify/phase-4.ts`, `scripts/uat-runner.ts` |

### Phase 05 — Bootstrap idempotency (v1.0, `05-teardown/`)

| ID | Decision | Cited by |
|---|---|---|
| `D-01` | `backup.env` upload is skip-if-exists by default; the droplet's live `GITHUB_TOKEN` is never silently clobbered by a re-bootstrap. | `scripts/bootstrap-droplet.ts` |
| `D-03` | First-run detection is a remote-file probe (`test -f backup.env` over SSH), not local state; probe/transport failure bails loud rather than assuming "absent". | `scripts/bootstrap-droplet.ts` |
| `D-04` | When `backup.env` is preserved, bootstrap logs the skip explicitly so the operator never wonders whether the token survived. | `scripts/bootstrap-droplet.ts` |
| `D-11` | `scripts/verify/phase-5.ts` follows the Phase 1/Phase 3 verify template; assumes `verify:phase-1` has already passed. | `scripts/verify/phase-5.ts` |
| `D-12` | `verify:phase-5` asserts, in order: pre-conditions, `backup.env` hash/mtime/mode unchanged across a re-run, cron-marker count stays exactly 1, and an env-gated `--rotate-env` round-trip. | `scripts/verify/phase-5.ts` |
| `D-14` | `verify:phase-5` assumes a freshly-bootstrapped droplet; it never provisions or bootstraps from scratch itself. | `scripts/verify/phase-5.ts` |

### Phase 06 — Multi-source + per-repo filtering (v1.0, `06-multi-source/`)

| ID | Decision | Cited by |
|---|---|---|
| `D-02` | `loadConfig()` normalizes both the legacy `githubUserOrOrg` string and the new `githubSources` array into `cfg.sources: NormalizedSource[]`. | `scripts/lib/config.ts` |
| `D-03` | Each source name is validated against `SHELL_SAFE_RE` independently; duplicate names within `githubSources` are a hard bail. | `scripts/lib/config.ts` |
| `D-04` | `bootstrap-droplet.ts` writes both the authoritative `GITHUB_SOURCES` (space-separated) and a legacy `GITHUB_USER_OR_ORG` (= first source) line into `backup.env`, so an un-upgraded droplet script still runs against source #1. | `droplet/bootstrap.sh`, `droplet/github-backup.sh`, `scripts/bootstrap-droplet.ts` |
| `D-05` | The user-vs-org probe is a shared helper — `droplet/lib/detect-account-type.sh`'s `detect_account_type <slug>` — sourced by `github-backup.sh` instead of being inlined. | `droplet/github-backup.sh`, `droplet/lib/detect-account-type.sh` |
| `D-07` | Mirrors live at `${BACKUP_DIR}/<source>/<owner>_<repo>.git` — one namespaced subdirectory per configured source. | `droplet/github-backup.sh`, `scripts/verify/phase-6.ts` |
| `D-08` | On a run, top-level legacy `*.git` dirs auto-migrate into `<source>/` only when exactly one source is configured and it matches the previously-written legacy `GITHUB_USER_OR_ORG`; any other case aborts, pointing at `migrate-mirrors`. | `droplet/github-backup.sh` |
| `D-09` | `scripts/migrate-mirrors.ts` (`npm run migrate-mirrors -- --from <legacy-source>`) is the operator-driven migration path for the ambiguous multi-source case. | `scripts/migrate-mirrors.ts` |
| `D-16` | `github-backup.sh` emits one `BACKUP_SOURCE_SUMMARY source=<n> upstream=N mirrored=M failed=F` line per source, alongside the unchanged aggregate `BACKUP_SUMMARY`. | `droplet/github-backup.sh`, `scripts/smoke-test.ts`, `scripts/verify/phase-6.ts` |
| `D-20` | `scripts/verify/phase-6.ts` asserts five groups: config/env contract, namespaced layout, SUMMARY contract, `REPOS-01` deny enforcement, and bash `slot()` ↔ TS `envSlot()` agreement. | `scripts/verify/phase-6.ts` |

### Phase 07 — Droplet artifact shipping (v1.1)

| ID | Decision | Cited by |
|---|---|---|
| `D-05` | `verify:phase-7` asserts `sync-one-repo.sh` ships executable, that a one-repo invocation produces the namespaced mirror dir, and that it emits the `BACKUP_REPO_RESULT` line (owns `SC#1`). | `scripts/verify/phase-7.ts` |
| `D-06` | `verify:phase-7` source-loads `detect-account-type.sh` under `set -e` and asserts an unknown slug returns `User` (owns `SC#2`). | `scripts/verify/phase-7.ts` |
| `D-07` | `verify:phase-7` source-loads `filter-repos.sh` under `set -e` and runs three golden allow/deny cases (owns `SC#3`). | `scripts/verify/phase-7.ts` |
| `D-08` | `verify:phase-7` runs `github-backup.sh` once against a whitelisted target and asserts the mirror exists, a `RESULT_TAG` line appears, and the new log tail has no `unbound variable`/`command not found` (owns `SC#4`). | `scripts/verify/phase-7.ts` |
| `D-09` | `verify:phase-7` is standalone — no shared verify-helpers module, reuses only `scripts/lib/ssh.ts` + `scripts/lib/config.ts`. | `scripts/verify/phase-7.ts` |
| `D-10` | Repo listing goes through `droplet/lib/resolve-repo-endpoint.sh` (TS callers via `scripts/lib/repo-endpoint.ts`): an organisation source uses `/orgs/<org>/repos?type=all`, the token owner's own user source uses `/user/repos?affiliation=owner`, any other user source keeps `/users/<login>/repos?type=all`. `/users/<login>/repos` returns public repositories only — even for the token owner — so the previous unconditional use of it silently excluded every private repo of a user source from the mirror set, the webhook registration, and the `p01-05` disk-count gate. | `droplet/lib/resolve-repo-endpoint.sh`, `droplet/github-backup.sh`, `scripts/register-webhooks.ts`, `scripts/verify/phase-6.ts`, `scripts/verify/phase-7.ts`, `scripts/uat-runner.ts` |

### Phase 08 — Bootstrap uploader hardening (v1.1)

| ID | Decision | Cited by |
|---|---|---|
| `D-03` | Upload is manifest-driven, three steps: pre-flight existence check over `manifest.required` (no SSH yet), upload required, then upload optional-with-warn. | `scripts/bootstrap-droplet.ts` |
| `D-05` | `scripts/sync-readme-manifest.ts` renders the manifest as a Markdown table into README.md between `<!-- BEGIN/END: droplet-manifest -->` markers. | `scripts/sync-readme-manifest.ts` |
| `D-10` | Outbound firewall reconcile is strict-canonical-only: add any missing canonical rule, never remove operator-added extras. | `scripts/create-droplet.ts` |

### Phase 09 — Webhook multi-source + filter parity (v1.1)

| ID | Decision | Cited by |
|---|---|---|
| `D-01` | The listener re-reads `/opt/github-backups/backup.env` on every request (not boot-only) to check `GITHUB_SOURCES` membership, so a config change needs no service restart. | `droplet/webhook-listener.js` |
| `D-03` | **Superseded — see the `WEBHOOK-04` conflict flag above.** Originally: the listener does not apply the allow/deny filter on the webhook path at all (retired 2026-05-17, then reinstated post cross-AI-review). | *(not implemented in current code)* |
| `D-05` | When fewer than 2 sources are configured, the `verify:phase-3` multi-source group logs a loud skip and the overall run still reports pass. | `droplet/webhook-listener.js` (header pointer) |

### Phase 10 — Live-droplet UAT close-out (v1.1)

| ID | Decision | Cited by |
|---|---|---|
| `D-01` | `scripts/uat-runner.ts` drives all human UAT scenarios from an inline manifest, printing pass/fail/`MANUAL` per item; it is a survey runner, not fail-fast. | `scripts/uat-runner.ts` |
| `D-02` | Automation is conservative: the runner only executes pure-script/read-only checks; anything that mutates infrastructure (firewall edits, destroy, DNS, real pushes) stays in the `MANUAL:` list. | `scripts/uat-runner.ts` |

## Notable regressions (`NR-xx`) — Phase 01 (v1.0)

Found and fixed during Phase 1's review-fix cycles; not requirements or design decisions, but load-bearing enough that later phases cite them as established behavior.

| ID | What it names | Fix |
|---|---|---|
| `NR-01` | `flock -n` silent-exits when cron is mid-run, so verify/smoke could assert against a stale `BACKUP_SUMMARY`. | `REQUIRE_LOCK=1` makes verify/smoke *block* on the lock instead; cron itself keeps `flock -n` + exit 0. |
| `NR-02` | The empty-mapfile-entry trim only stripped one trailing blank line. | Full filter loop drops every empty entry, `set -u`-safe. |
| `NR-03` | `cronSchedule` was omitted from `SHELL_SAFE_FIELDS`, but cron syntax needs chars that regex forbids. | Separate `CRON_SAFE_RE` validation pass for `cronSchedule`. |
| `NR-04` | `sshExitsZero` misclassified a signal-killed/null-status ssh as "remote command failed". | Signal and null-status exits are thrown as transport-class failures instead. |
| `NR-05` | The `GITHUB_TOKEN` shape regex rejected valid tokens with trailing CR/whitespace. | Trim before every presence/shape check. |
| `NR-06` | Blocking `flock 9` (no timeout) could hang verify/smoke forever on a wedged prior run. | `flock -w ${LOCK_WAIT_SECONDS}` bounds the wait; exits 75 (`EX_TEMPFAIL`) on timeout. |
| `NR-07` | `CRON_SAFE_RE` rejected valid cron extensions (`@daily`, named months/days, `L`/`W`/`#`). | Allow-list extended to cover standard cron grammar. |
| `NR-08` | A cron run firing *after* the trigger (but before the tail-read) could be mis-parsed as the triggered run's summary. | Capture `tStart` before triggering; filter `BACKUP_SUMMARY` matches to `timestamp >= tStart`, take the earliest match. |
| `NR-09` | `findFirewallId` swallowed every doctl error as "firewall absent". | Only a real empty-list/no-firewalls message is treated as absence; anything else re-throws. |

## 4. Success criteria (`SC#N`, ROADMAP-scoped)

`SC#N` numbering restarts per ROADMAP phase; the same bare number means different things in v1.0 Phase 6, v1.0 Phase 5, and v1.1 Phases 7–8.

### v1.0 ROADMAP Phase 6 — Multi-source + per-repo filtering

| ID | Statement | Cited by |
|---|---|---|
| `SC#4` | Deny wins on allow/deny conflict. | `droplet/github-backup.sh`, `droplet/lib/filter-repos.sh`, `droplet/webhook-listener.js`, `scripts/lib/config.ts`, `scripts/lib/filter-repos.ts`, `scripts/verify/phase-6.ts` |
| `SC#5` | Empty allow-list means all repos of the source. | `droplet/github-backup.sh`, `droplet/lib/filter-repos.sh`, `droplet/webhook-listener.js`, `scripts/lib/filter-repos.ts`, `scripts/verify/phase-6.ts` |

### v1.0 ROADMAP Phase 5 — Bootstrap idempotency

| ID | Statement | Cited by |
|---|---|---|
| `SC#3` | Re-running `bootstrap-droplet` restarts the webhook listener cleanly (systemd unit reloaded, not duplicated). | `scripts/verify/phase-5.ts` |

### v1.1 ROADMAP Phase 7 — Droplet artifact shipping

| ID | Statement | Cited by |
|---|---|---|
| `SC#1` | `sync-one-repo.sh` ships executable, implements the namespaced mirror layout, clones/updates correctly, and holds a per-repo `flock` on fd 8. | `scripts/verify/phase-7.ts` |
| `SC#2` | `github-backup.sh` source-loads `detect-account-type.sh` under `set -e`; resolves an arbitrary slug to `User` or `Organization`, defaulting to `User`. | `scripts/verify/phase-7.ts` |
| `SC#3` | `github-backup.sh` source-loads `filter-repos.sh` under `set -e`; `REPOS-01` semantics hold (deny wins, empty allow = all). | `scripts/verify/phase-7.ts` |
| `SC#4` | The cron path mirrors ≥1 real repo end-to-end on a freshly-bootstrapped droplet, with no `unbound variable`/`command not found` error. | `scripts/verify/phase-7.ts` |
| `SC#4a` | (code-level sub-assertion) The namespaced mirror dir exists after the cron run. | `scripts/verify/phase-7.ts` |
| `SC#4b` | (code-level sub-assertion) Target mirror freshness advanced during *this* cron run — proves the cron run, not an earlier manual call, touched it. | `scripts/verify/phase-7.ts` |
| `SC#4c` | (code-level sub-assertion) ≥1 `BACKUP_REPO_RESULT action=clone\|update` line appears in the new log tail. | `scripts/verify/phase-7.ts` |
| `SC#4d` | (code-level sub-assertion) Zero `unbound variable`/`command not found` lines appear in the new log tail. | `scripts/verify/phase-7.ts` |

### v1.1 ROADMAP Phase 8 — Bootstrap uploader hardening

| ID | Statement | Cited by |
|---|---|---|
| `SC#2` | Running `bootstrap-droplet` with a required file deleted exits non-zero with `missing required artifact: <path>` before opening an SSH session. | `scripts/bootstrap-droplet.ts` |

## Unresolved citations

None. Every identifier the grep in the assignment surfaces (55, re-derived — the pattern also matches `SC#4d`, which the originally-quoted count of 54 missed) resolves to a definition above.

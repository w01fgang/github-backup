---
scope: entire-project (v1.1 Phases 7-10)
reviewers: [codex, claude]
reviewers_failed: [grok, gemini, cursor, opencode]
reviewed_at: 2026-07-18T10:47:19Z
plans_reviewed:
  - 07-droplet-artifact-shipping/07-01-PLAN.md
  - 08-bootstrap-uploader-hardening/08-01-PLAN.md
  - 08-bootstrap-uploader-hardening/08-02-PLAN.md
  - 08-bootstrap-uploader-hardening/08-03-PLAN.md
  - 08-bootstrap-uploader-hardening/08-04-PLAN.md
  - 09-webhook-multi-source-filter-parity/09-01-PLAN.md
  - 09-webhook-multi-source-filter-parity/09-02-PLAN.md
  - 10-live-droplet-uat-close-out/10-01-PLAN.md
  - 10-live-droplet-uat-close-out/10-02-PLAN.md
  - 10-live-droplet-uat-close-out/10-03-PLAN.md
note: >
  Invoked as `/gsd-review --codex --grok entire project`. gsd-review is natively
  single-phase and has no `--grok` flag; adapted to a source-grounded whole-project
  review across all v1.1 phases. Two reviewers completed (Codex = gpt-5.5, Claude CLI);
  reviews reproduced verbatim as returned. Grok/Gemini/Cursor could not run (see failure
  table). Reviews traced plan claims into the shipped code with file:line evidence.
---

# Cross-AI Whole-Project Review — v1.1 (Phases 7-10)

Source-grounded review: reviewers opened the referenced files and traced each plan
claim into the actual code, citing `path:line` evidence. Read-only; no files modified.

**Reviewer outcomes**

| Reviewer | Model | Status | Overall risk |
|----------|-------|--------|--------------|
| Codex | gpt-5.5 (`codex exec -s read-only`) | ✅ completed | HIGH |
| Claude CLI | claude (headless `-p`) | ✅ completed | LOW-MEDIUM |
| Grok | grok CLI | ❌ headless self-cancels; auto-approve modes classifier-blocked (5 attempts) |
| Gemini | gemini CLI | ❌ `IneligibleTierError` — individual tier no longer supported |
| Cursor | cursor-agent | ❌ not authenticated (`agent login` / `CURSOR_API_KEY` required) |
| OpenCode | grok-4.3 | ❌ killed before flush on both runs — agentic run exceeds background wall-clock, 0 bytes |

---

## Codex Review

*(gpt-5.5 via `codex exec -s read-only`; verified against working tree — `tsc`, Node/Bash syntax, dependency-tree checks passed; live DigitalOcean behavior not exercised.)*

# Summary

The v1.1 implementation has a solid operational core: required droplet artifacts are explicitly manifested, bootstrap preflight happens before SSH, firewall reconciliation is carefully normalized, shell scripts use strict mode and locking, and webhook HMAC verification is correctly ordered. However, the milestone is not ready to close. The most serious issues are that denied repositories can still be mirrored through automatically registered webhooks, the public webhook buffers unbounded unauthenticated request bodies, and Phase 10’s evidence model can mark manual and `human_needed` verification work resolved without actually executing or updating it. Local `tsc`, Node syntax, Bash syntax, and dependency-tree checks passed; live DigitalOcean behavior was not exercised in this read-only review.

# Strengths

- **Phase 7 — robust single-repository sync mechanics.** `sync-one-repo.sh` uses `set -euo pipefail`, validates all three arguments, locks each repository on fd 8, quotes filesystem paths, uses `git clone --mirror`/`remote update --prune`, and emits a structured terminal result line (`droplet/sync-one-repo.sh:31-47`, `droplet/sync-one-repo.sh:60-73`, `droplet/sync-one-repo.sh:83-118`).

- **Phase 7 — cron filtering is correctly implemented.** The cron path loads both helpers, resolves per-source allow/deny values, filters before dispatch, and handles each repository failure without aborting the remaining loop (`droplet/github-backup.sh:97-111`, `droplet/github-backup.sh:192-225`, `droplet/github-backup.sh:242-285`). The helper applies deny first and treats an empty allow list as pass-through (`droplet/lib/filter-repos.sh:40-62`).

- **Phase 8 — manifest preflight achieves the local fail-fast goal.** All ten runtime artifacts, including the webhook trio and both libraries, are required (`scripts/lib/droplet-manifest.ts:27-40`). Bootstrap checks every entry before `waitForSsh`, SSH, or SCP (`scripts/bootstrap-droplet.ts:205-225`) and then uploads exclusively from that manifest (`scripts/bootstrap-droplet.ts:295-328`).

- **Phase 8 — firewall reconciliation is more robust than the original plan snippet.** It normalizes IPv6 and API port representations, checks each CIDR independently to accommodate DigitalOcean’s split-rule representation, and adds only missing addresses without removing extras (`scripts/create-droplet.ts:76-93`, `scripts/create-droplet.ts:106-159`). Both inbound and outbound canonical sets use the same fetched firewall detail (`scripts/create-droplet.ts:272-290`).

- **Phase 9 — authentication and command dispatch boundaries are sound.** The listener computes the HMAC over the raw body, compares equal-length buffers using `timingSafeEqual`, and performs JSON parsing only after authentication (`droplet/webhook-listener.js:119-127`, `droplet/webhook-listener.js:143-181`). Owner/repository arguments are shape-checked and passed to `spawnSync` as an argv array rather than through a shell (`droplet/webhook-listener.js:208-224`).

- **Phase 9 — multi-source configuration is refreshed without listener restart.** `backup.env` is reread per authenticated push, an empty or unreadable source list returns a logged 500, and membership is enforced before dispatch (`droplet/webhook-listener.js:194-218`).

- **Secret-file handling is generally careful.** Generated `backup.env` is created mode 0600 and deleted in a `finally` block after upload (`scripts/bootstrap-droplet.ts:110-113`, `scripts/bootstrap-droplet.ts:269-279`). The droplet reapplies mode 600 after sourcing it (`droplet/bootstrap.sh:29-48`).

# Concerns

- **HIGH — Phase 9’s dropped filter contradicts both the milestone and the actual registration workflow.** The project still identifies webhook deny-wins filtering as a target and active item (`.planning/PROJECT.md:19-25`, `.planning/PROJECT.md:61-68`), while the listener authorizes only by owner and dispatches every repository (`droplet/webhook-listener.js:194-224`). More importantly, the claimed rationale—“configuring a per-repo webhook is explicit consent”—does not match the shipped operator tool: `register-webhooks.ts` automatically registers hooks on every admin-capable repository and explicitly documents that a denied repository will be mirrored (`scripts/register-webhooks.ts:5-21`, `scripts/register-webhooks.ts:108-170`). This can back up repositories the operator explicitly excluded through REPOS-01.

- **HIGH — the public webhook endpoint has an unauthenticated memory-exhaustion path.** Ports 80 and 443 are world-accessible (`README.md:652-667`), but the Node listener appends every incoming chunk without a body-size limit and authenticates only after `Buffer.concat` (`droplet/webhook-listener.js:129-160`). On the stated 1 GB droplet, a large or slow request can consume substantial memory before an invalid HMAC is rejected.

- **HIGH — Phase 10 can falsely close unexecuted manual UAT.** The runner merely prints manual instructions, records `kind: "manual"`, and still exits zero when all scripted checks pass (`scripts/uat-runner.ts:581-615`). Plan 10-02 allows these entries to remain `manual`, forces `pending: 0`, and counts unexecuted manual checks as skipped rather than pending (`.planning/phases/10-live-droplet-uat-close-out/10-02-PLAN.md:156-169`). This conflicts with Phase 10’s required pass/fail outcomes (`.planning/ROADMAP.md:98-110`).

- **HIGH — VALID-02/03 can be marked resolved while their canonical verification files remain `human_needed`.** Phase 3 still contains six pending human results (`.planning/milestones/v1.0-phases/03-webhook/03-VERIFICATION.md:117-149`), while Phase 4 frontmatter and requirements remain pending live smoke (`.planning/milestones/v1.0-phases/04-restore/04-VERIFICATION.md:1-27`, `.planning/milestones/v1.0-phases/04-restore/04-VERIFICATION.md:38-49`). Plan 10-02 explicitly forbids changing either file but allows the corresponding STATE rows to become resolved (`.planning/phases/10-live-droplet-uat-close-out/10-02-PLAN.md:176-178`, `.planning/phases/10-live-droplet-uat-close-out/10-02-PLAN.md:220-230`). That leaves contradictory canonical evidence after closure.

- **MEDIUM — the live deployment gate does not prove Phase 9 is deployed.** Plan 10-02 checks the ROADMAP checkbox, optionally checks a verification file, and confirms only SSH reachability (`.planning/phases/10-live-droplet-uat-close-out/10-02-PLAN.md:89-96`). There is currently no Phase 9 `09-VERIFICATION.md`, and bootstrap writes no `.deployed-commit`; the plan therefore falls back to local `git rev-parse HEAD`, which is not evidence of the droplet’s contents (`.planning/phases/10-live-droplet-uat-close-out/10-02-PLAN.md:71-75`, `scripts/bootstrap-droplet.ts:302-337`). Current verification correctly notes that redeployment is still pending (`.planning/phases/10-live-droplet-uat-close-out/10-VERIFICATION.md:44-53`).

- **MEDIUM — several Phase 10 checks are materially weaker than the archived UAT contracts.**

  - The repository-count check compares the first source’s unfiltered upstream count with all mirrors from all sources, so additional sources can hide missing repositories and deny filters can cause false failures (`scripts/uat-runner.ts:143-160`).
  - The certificate check only matches `notAfter=` and never verifies the date is in the future (`scripts/uat-runner.ts:219-229`), unlike `verify:phase-3`, which does validate expiry (`scripts/verify/phase-3.ts:194-205`).
  - The restore helper claims its handshake is the first stdout line, but prints clone commands and child output before it (`scripts/restore.ts:132-152`). The UAT runner merely searches for the handshake anywhere (`scripts/uat-runner.ts:303-307`).
  - The “cold start” scenario simply invokes the idempotent smoke test and therefore does not require removal of the existing droplet or `.droplet.json` (`scripts/uat-runner.ts:89-99`, `scripts/smoke-test.ts:17-21`).

- **MEDIUM — Phase 7’s integration verifier can pass without proving the cron path updated its selected repository.** Group 1 first directly creates or refreshes the target mirror (`scripts/verify/phase-7.ts:174-198`). Group 4 then accepts cron exit 1, checks the already-created target directory, and accepts a success result for any repository rather than the target (`scripts/verify/phase-7.ts:335-370`). This is weaker than the plan summary’s stated exit-0/target-specific proof. The verification artifact is also internally contradictory: frontmatter says `passed`, while the body says `human_needed` and calls the live run uncertain (`.planning/phases/07-droplet-artifact-shipping/07-VERIFICATION.md:1-16`, `.planning/phases/07-droplet-artifact-shipping/07-VERIFICATION.md:23-46`).

- **MEDIUM — documented multi-source upgrades do not update the preserved environment.** README tells operators to rerun plain `bootstrap-droplet` to push new `GITHUB_SOURCES` (`README.md:347-353`), but bootstrap preserves an existing `backup.env` unless `--rotate-env` is supplied (`scripts/bootstrap-droplet.ts:242-285`). The correct flag is documented later only for legacy single-source and schedule changes (`README.md:481-497`).

- **LOW — the pre-commit invariant checks the working tree, not the staged commit.** The hook invokes the normal `--check` reader (`scripts/git-hooks/pre-commit:15-24`), which reads `README.md` and the imported manifest from the working tree (`scripts/sync-readme-manifest.ts:17-25`, `scripts/sync-readme-manifest.ts:46-74`). If the manifest and generated README are synchronized in the working tree but only the manifest is staged, the hook passes while the commit itself contains a stale README. CI should catch this later, but the stated local rejection guarantee is not true.

- **LOW — webhook secrets are unnecessarily printed.** Fresh and rotated secrets are written to stdout (`scripts/bootstrap-droplet.ts:141-149`, `scripts/bootstrap-droplet.ts:174-177`), even though `register-webhooks.ts` automatically retrieves the secret over SSH (`scripts/register-webhooks.ts:77-98`). This creates avoidable terminal/CI log exposure.

# Suggestions

- Reinstate deny-wins enforcement either in `webhook-listener.js` or, preferably, filter `register-webhooks.ts` using the same normalized allow/deny semantics as cron. If operators need an override, model it explicitly per repository rather than inferring consent from an automatically installed hook.

- Add a small webhook body cap—such as 1 MiB—using both `Content-Length` validation and streamed byte counting. Return 413 and destroy the request once the limit is crossed; also configure explicit header/request timeouts.

- Change Phase 10’s result model to distinguish `manual-pending` from `manual-passed`/`manual-failed`. Phase closure should require operator attestation and evidence for all seven manual scenarios.

- Update the Phase 3 and Phase 4 `VERIFICATION.md` files as part of 10-02, including frontmatter status and each human result, or formally declare `10-VERIFICATION.md` the canonical replacement and link both archived files to it.

- Have bootstrap upload a generated `.deployed-commit`, then require 10-02 to compare it with the intended local commit before UAT. Do not substitute local HEAD as deployment evidence.

- Tighten UAT assertions: filtered counts per source, genuine cold-start provisioning on a sacrificial droplet, future certificate expiry, exact restore handshake placement, exact ref equality, and log-offset/timestamp scoping for webhook results.

- Strengthen Phase 7 Group 4 by using `REQUIRE_LOCK=1`, requiring cron exit 0, snapshotting target state/log offsets, and asserting a new target-specific result.

- Fix the upgrade command to include `-- --rotate-env`, and mention `githubSources` and filter changes alongside the other environment-changing fields.

- Make the pre-commit hook validate staged blobs, or generate the expected README in a temporary index/worktree and compare it to `git show :README.md`.

- Add isolated tests for firewall normalization/reconciliation, environment parsing, manifest rendering, and UAT aggregation. The current CI workflow only checks README synchronization (`.github/workflows/sync-check.yml:9-27`); add TypeScript, Node syntax, and Bash syntax checks.

# Risk Assessment

**Overall risk: HIGH.** Phases 7 and 8 are largely well implemented, and the local build/syntax checks pass. The rating is driven by three production-significant issues: REPOS-01 exclusions are bypassed through automatically registered webhooks, the public webhook has an unbounded pre-authentication memory path, and Phase 10’s planned evidence model can close required human validation without executing it or updating the canonical verification artifacts. Until those are corrected and the live droplet is tied to a verifiable deployed commit, v1.1 should remain open.

---

## Claude Review

*(claude headless `-p`; independent session, traced claims to source. Reproduced verbatim — includes one stray non-ASCII token from the model's raw output.)*

Verification complete. All Phase 7-9 artifacts shipped and match plans; Phase 10 partial (runner shipped, live execution blocked). Review below.

# Cross-AI Whole-Project Review — github-backup v1.1 (Phases 7-10)

## 1. Summary

Plans are unusually rigorous — heavy `must_haves`/`truths` blocks, per-task grep acceptance gates, threat models. Phases 7-9 shipped and the code matches the plans' intent; I traced each core claim to source and it holds. The most important finding is **plan-vs-code drift in Phase 8's firewall reconcile (08-02)**: the plan's specified match logic would have shipped a *broken* idempotency contract; the executor silently diverged and fixed it, but the plan text is unsafe to follow verbatim and its acceptance greps don't catch the divergence. Phase 10 plans are sound but blocked on a live-droplet bootstrap bug recorded in STATE.md. Overall risk LOW-MEDIUM.

## 2. Strengths

- **Webhook check order correct (WEBHOOK-03).** `webhook-listener.js:194-206` (env re-read + `Set.has`) lands *before* `ARG_RE` shape guard at `:214`, which lands before `spawnSync` at `:220`. `owner` (untrusted) reaches only `Set.has(owner)` and `logLine` prior to shape validation → no injection into dispatch. Matches plan 09-01 D-01 exactly.
- **Manifest-driven uploader (MANIFEST-01/02).** `readdirSync` glob loops gone; pre-flight bail (`bootstrap-droplet.ts:215-220`) runs before `waitForSsh` at `:222` → fails locally before any SSH. Webhook trio in `required[]` (`droplet-manifest.ts:33-35`). Optional-tier warn-and-continue present (`:314-328`).
- **Group 7 shipped as specced.** `phase-3.ts:353-391` iterates all `cfg.sources`, dual-asserts 2xx *and* `last-webhook-event.json` source+owner routing (the 2xx alone is weak — see C2 — the routing read is what actually proves WEBHOOK-03). Skip wording byte-matches D-05.
- **uat-runner well-built.** Survey mode (no bail-fast), exit codes 0/1/2 (`uat-runner.ts:614-615,687-690`), `requiresDroplet` gate degrades missing-droplet to a clean `✗ ... droplet unreachable` not a crash (`:599-602`). Manual floor = 7 (p01-08, p03-01/04/06, p04-04, p8d-09/10), scripted = 14. Matches plan 10-01.
- **Injection surfaces closed at config load.** `config.ts:123` `SHELL_SAFE_RE` on source names + `allowedSSHCidr`; `:150` slug regex on test repos. The plans' threat models cite these and they exist.

## 3. Concerns

- **[MEDIUM] Plan 08-02 reconcile logic is wrong; shipped code silently diverged.** Plan specifies match-by-set-equality (`if (normalised.length !== expectedSet.size) return false` and exact `p.ports !== r.ports`). doctl persists `ports:all` as `ports:"0"`, so that exact compare *never matches* → re-adds all 3 outbound rules every run → SC#5 idempotency violation + duplicate firewall rules. Shipped `create-droplet.ts:91-93` (`normalizePorts`) + per-CIDR missing-detection (`:128-136`) fixes it, but the plan text (08-02 task 02-01 action block) is unsafe to follow verbatim, and its acceptance grep `grep -c "normalizeCidr" >=2` (08-02 AC) passes against both correct and broken code → the gate can't detect the defect it should guard. Plan defect, not code defect.

- **[MEDIUM] verify:phase-3 Group 7 dispatch side-effect + misleading "dispatched".** `phase-3.ts:362-364` POSTs a push per source with sentinel repo `verify-phase-3-multi-source-probe`. Listener dispatches `sync-one-repo.sh` via `systemd-run --no-block` (`webhook-listener.js:220`) → clone of a nonexistent repo, failed-clone noise in `/var/log/github-backup.log` + a stray `/var/lock/github-backup-<owner>_probe.lock` per source per verify run. Worse, listener writes `last-webhook-event.json` with `action:"dispatched"` *before* the async clone runs (`:238` before the clone even starts), so the Group 7 assertion passes even though the real sync always fails — routing is proven, dispatch success is not. Acknowledged in plan T-09-07 but the log pollution is real and recurring.

- **[LOW-MEDIUM] Group 7 `last-webhook-event.json` read race.** Assertion reads the file over SSH after each POST (`phase-3.ts:377-389`); a concurrent real GitHub push (or a Group 4 leftover) overwrites it between POST-return and ssh-read → false failure. Operator-run controlled window mitigates; not guarded in code.

- **[LOW] p01-05 weak multi-source coverage.** Counts upstream of `githubSources[0]` only (`uat-runner.ts:152`) but disk-counts *all* sources' mirrors (`:156`) → for a 2-source config, source #2 can be entirely unmirrored and the scenario still passes. Title claims "Real GitHub User/Org Mirrored." Loose bar for the multi-source milestone.

- **[LOW] p04-01→p04-02 couple via fixed `/tmp/uat-p04-01.log`** (`uat-runner.ts:304,327`). Stale file from a prior/concurrent run → misleading pass or cross-run contamination. Fine for single serial operator run; no PID/run scoping.

- **[LOW] Phase 10 plans blocked, not just pending.** 10-02/10-03 assume a bootstrappable droplet, but STATE.md:27 records a *blocking* gh-auth bootstrap bug found during wave-2 prep (patch `6dfb3ef`, redeploy pending operator). 10-02's task 02-01 gate checks Phase 9 closure + SSH reachability but does **not** verify the patched bootstrap actually redeployed → 02-02 could run `npm run uat` against a stale/half-bootstrapped droplet and record false failures. Plan gate gap.

## 4. Suggestions

- 08-02: correct the plan's reconcile pseudocode to the shipped per-CIDR + `normalizePorts` form, and add an acceptance gate that actually asserts idempotency (e.g. second `create-droplet` run emits zero `+ [outbound]` lines) rather than a `grep -c normalizeCidr`.
- Phase 9: teach `sync-one-repo.sh` (or the webhook path) to no-op on the `verify-phase-3-multi-source-probe` sentinel, eliminating recurring failed-clone log noise — the plan itself flagged this as an optional follow-up; worth doing.
- 10-02 task 02-01: add a gate asserting the *deployed* bootstrap carries `6dfb3ef` (e.g. `gh auth status` on droplet returns authenticated) before running the runner, so a stale droplet can't produce false UAT failures.
- p01-05: count upstream per-source and compare per-source disk dirs (`/opt/github-backups/<source>/*.git`) to actually exercise MULTI-01 at UAT.

## 5. Risk Assessment

**LOW-MEDIUM.** Phases 7-9 are shipped, traced-correct, and defensively coded; the injection/HMAC/ordering surfaces the plans claim to close are genuinely closed. The residual risk is concentrated in (a) plan-text drift where the plan is wrong and only the executor's judgment saved it (08-02 firewall) — a hazard for any future re-execution or audit that trusts the plan over the code, and (b) Phase 10 being both incomplete and gated behind an un-redeployed blocking bug, with a plan gate that wouldn't catch a stale droplet. No security regressions found. Recommend: patch the 08-02 plan text + acceptance gate, and harden the 10-02 readiness gate, before closing v1.1.

---

## Consensus Summary

Two independent source-grounded reviewers (Codex/gpt-5.5 and Claude CLI). Both traced plan claims into the shipped code; both agree Phases 7-9 are shipped and the code matches the plans' *intent*. They diverge sharply on overall risk (HIGH vs LOW-MEDIUM) — see Divergent Views.

### Agreed Strengths (both reviewers)
- **Manifest preflight fails locally before any SSH** — `bootstrap-droplet.ts:205-225` / `droplet-manifest.ts` (webhook trio + libs required).
- **Webhook auth/dispatch ordering is sound** — HMAC over raw body before JSON parse; owner/repo shape-checked and dispatched as argv (not shell). `webhook-listener.js:194-224`.
- **Multi-source env re-read per authenticated push** — no listener restart needed.
- **Injection surfaces closed at config load** — `config.ts` `SHELL_SAFE_RE` on source names + `allowedSSHCidr`; secret files 0600 + deleted after upload.

### Agreed Concerns (both reviewers — highest priority)
1. **Phase 10 readiness/evidence gating is unsafe.** Codex (HIGH): runner records manual scenarios as skipped, forces `pending:0`, can close unexecuted manual UAT and mark VALID-02/03 resolved while `03/04-VERIFICATION.md` stay `human_needed`. Claude (LOW): 10-02's gate checks only SSH reachability, not that the patched bootstrap (`6dfb3ef`) actually redeployed → UAT can run against a stale/half-bootstrapped droplet and record false failures. Two independent angles on the same gap → **fix the Phase 10 closure/readiness gates before closing v1.1.**
2. **`uat-runner` repo-count check is too loose for multi-source.** Codex MEDIUM (`uat-runner.ts:143-160`) and Claude LOW p01-05 (`:152` vs `:156`) independently: it compares the *first* source's upstream count against *all* sources' mirrors, so an entirely unmirrored source #2 still passes. → count/compare per-source.
3. **`uat-runner` assertions weaker than the archived UAT contracts** — both cite loose scenarios (cert-expiry not future-checked, restore-handshake placement, `/tmp` file coupling, cold-start not truly cold).

### Divergent Views (worth investigating)
- **Overall risk: Codex HIGH vs Claude LOW-MEDIUM.** The gap is two production-facing security findings Codex raised that Claude did **not examine** (not refuted — out of the scope Claude traced):
  - **Unauthenticated pre-auth webhook memory-exhaustion** — no body-size cap before HMAC on world-facing ports 80/443, 1 GB droplet (`webhook-listener.js:129-160`). *Only Codex.*
  - **REPOS-01 deny-list bypassed via auto-registration** — `register-webhooks.ts` installs hooks on every admin-capable repo and documents that denied repos get mirrored (`scripts/register-webhooks.ts:5-21,108-170`); the listener filters only by owner. *Only Codex.*
  These two are concrete and single-sourced → **operator should verify them directly** before trusting either risk rating. If they hold, Codex's HIGH is the right call.
- **Phase 8 firewall 08-02 — same observation, opposite framing.** Both saw that the shipped `create-droplet.ts` reconcile diverges from the 08-02 plan pseudocode. Codex framed it as a **strength** ("more robust than the original plan snippet"). Claude framed it as a **MEDIUM risk**: the plan text would ship a broken idempotency contract (`ports:all` persists as `"0"`, exact compare never matches → re-adds rules every run), the executor silently fixed it, and the acceptance grep (`grep -c normalizeCidr`) can't detect the defect. → Code is agreed-correct; the *plan* is a re-execution/audit hazard. Worth patching the plan text + acceptance gate.

### Recommended action queue (synthesized, highest-value first)
1. Verify + fix the two Codex-only HIGH security items (webhook body cap; deny-list on the registration/webhook path).
2. Harden Phase 10 gates: distinguish `manual-pending` from pass/fail; assert deployed-commit (`6dfb3ef`) before UAT; reconcile canonical `VERIFICATION.md` status.
3. Fix `uat-runner` per-source counting + tighten loose assertions.
4. Correct the 08-02 plan pseudocode + add a real idempotency acceptance gate.
5. LOW cleanups: pre-commit checks staged blobs; stop printing webhook secrets; `--rotate-env` in the documented upgrade command.

---

## Resolution — agreed concerns addressed (2026-07-20)

The both-reviewer **agreed concerns** were independently re-verified against current source, then fixed (typecheck + `bash -n` green; no commit yet):

- **Phase 10 can falsely close unexecuted manual UAT** → fixed in code + plan.
  - `scripts/uat-runner.ts`: manual scenarios now print `PENDING (unattested manual)`, the summary column is `Manual PENDING (unattested)`, and a closing `⚠ … UAT is INCOMPLETE` warning prints when any manual scenario is unattested. Exit-code contract (0/1/2) unchanged.
  - `10-02-PLAN.md` task 02-03: removed the "`pending` drops to 0 … count un-upgraded manuals in `skipped`" loophole (it fed 02-04's STATE resolution); `pending` now reaches 0 only once every manual scenario carries an attested outcome.
  - `10-02-PLAN.md` task 02-01: added a **patched-bootstrap redeploy gate** — `ssh root@<ip> 'gh auth status'` must exit 0 before UAT runs (proves patch `6dfb3ef` actually redeployed, so UAT can't run against a stale droplet). `.deployed-commit` marker deferred as a separate infra follow-up.
- **`uat-runner` repo-count too loose for multi-source** → `scripts/uat-runner.ts` p01-05 now loops every source and compares each source's own upstream count to its own mirror dir (`/opt/github-backups/<owner>/*.git`); an unmirrored source #2 now fails loudly. Caveat commented: for allow/deny-filtered sources it compares raw upstream vs disk (pre-existing limitation; loud-fail is the safe direction).
- **`uat-runner` cert assertion** → cert step now uses `openssl x509 -checkend 0` so an already-expired cert fails, matching `verify:phase-3`.

**Note on accuracy:** the manual-UAT finding's cited internals (a `pending:0`-forcing aggregation at `uat-runner.ts:581-615`) did **not** exist in current code — the runner is simpler (`ResultKind = passed|failed|manual`, exit 0 if none failed). The real risk (unexecuted manual reads as complete) was genuine and is what the relabel + attestation-gate fixes.

**Out of scope (not "agreed"):** the two Codex-only HIGH security items (unauthenticated webhook memory-exhaustion; REPOS-01 deny-list bypass via `register-webhooks.ts`) were single-sourced and are left for direct operator verification, not addressed here.

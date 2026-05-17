# Phase 9: Webhook multi-source + filter parity - Context

**Gathered:** 2026-05-17
**Status:** Ready for planning

<domain>
## Phase Boundary

Bring `droplet/webhook-listener.js` to multi-source feature-parity with the cron path. Today the listener treats `GITHUB_USER_OR_ORG` (single string) as the sole authorized source and 404s on owners #2+. After Phase 9: every owner listed in `GITHUB_SOURCES` is accepted; `verify:phase-3` regression-tests the routing for ≥2 distinct source owners.

**Scope changed during discuss (2026-05-17):** WEBHOOK-04 (apply allow/deny filter on webhook path) was **dropped**. The argument: a webhook configured on a repo is an explicit operator signal that the repo should sync; applying the cron-path filter overrides that intent. Org-wide webhook drift is now an operator concern (remove the webhook from repos that shouldn't sync). REQUIREMENTS.md + ROADMAP.md edited and committed at `f25f463`. Active Phase 9 requirements are now **WEBHOOK-03 + VALID-04 only**.

**In scope:**
- Replace `const ALLOWED_SOURCE = process.env.GITHUB_USER_OR_ORG` (line 46) and the single-source check (line 154-158) with multi-source membership against `GITHUB_SOURCES`.
- Per-request re-read of `/opt/github-backups/backup.env` (no service restart needed when operator regenerates env).
- Extend `scripts/verify/phase-3.ts` with a new group that POSTs synthetic HMAC-signed pushes for every configured source and asserts dispatch.

**Out of scope:**
- Applying `filter_repos` (or any allow/deny filter) on the webhook dispatch path — see "Deferred Ideas" for the rationale that retired WEBHOOK-04.
- Changes to `droplet/lib/filter-repos.sh` (still used by the cron path; webhook path no longer touches it).
- Changes to `droplet/sync-one-repo.sh` signature — its `<source> <owner> <repo>` contract holds; webhook calls it with `owner, owner, repo` (source == owner login by Phase 6 design).
- Multi-repo live e2e testing (cfg.webhookTestRepos[]) — Phase 9 ships synthetic-POST coverage only.
- Any change to `droplet/github-backup.sh` cron path.

</domain>

<decisions>
## Implementation Decisions

### Multi-source authorization shape

- **D-01 (SOURCE-LOAD):** Per-request re-read of `/opt/github-backups/backup.env`. Inside the request handler (after HMAC verification, before the owner check), parse the env file with a tiny in-process parser (handle `K=V` and `K="V V"` lines, skip blank + `#`-prefixed lines), pull `GITHUB_SOURCES`, build `new Set(GITHUB_SOURCES.split(/\s+/).filter(Boolean))`, check `if (!set.has(owner)) 404`. No service restart needed when an operator runs `npm run bootstrap-droplet` and the env changes. **This deliberately diverges from how `WEBHOOK_SECRET` / `GITHUB_USER_OR_ORG` are loaded today** (boot-only); the divergence is acknowledged and documented in code comments. Rejected alternatives:
  - Boot-load `Set<string>` (matches today's style) — required `systemctl restart github-backup-webhook` after every source-list change; rejected to reduce operator friction.
  - Boot-load + `fs.watch` hot-reload — too much glue (debounce, parent-dir watch, atomic-rename edge cases on Linux) for marginal value over per-request re-read at GitHub webhook rates.
- **D-02 (PARSE-FAIL):** On read or parse error of `backup.env` (file missing during the bootstrap-droplet write window, permission glitch, malformed line), log a structured error line via `logLine` with `reason: backup_env_unreadable` and return **HTTP 500**. GitHub retries on 5xx with backoff so transient failures self-recover. Do **not** cache last-known-good values; do **not** return 503. The fail-open posture (HTTP 500, no cached fallback) is chosen for simplicity — backup.env unreadability is a real operational problem the operator should see, not paper over.

### Filter on webhook path — RESCOPED OUT

- **D-03 (NO-FILTER):** WEBHOOK-04 dropped 2026-05-17 during this discuss. Webhook listener does **not** source `filter-repos.sh`, does **not** apply per-source allow/deny, does **not** return a "denied" status. After multi-source authorization (D-01) accepts the request, dispatch proceeds unchanged from today's code:
  ```js
  spawnSync("/usr/bin/systemd-run",
    ["--collect", "--no-block", SYNC_SCRIPT, owner, owner, repo]);
  ```
  (source == owner login by Phase 6 design; the existing 3-arg call is correct for every source in `GITHUB_SOURCES`.) See `<deferred>` for the full rationale and the spec-edit commit `f25f463`.

### Verify extension (WEBHOOK-03 regression coverage)

- **D-04 (VERIFY-STYLE):** Add a new group (`group5MultiSourceRouting` or similar — pick the next free number in `scripts/verify/phase-3.ts`) that iterates `cfg.sources`, POSTs a synthetic HMAC-signed push payload for each source via the existing `postWebhook` + `syntheticPushPayload` helpers, asserts each response is 2xx, then reads `/var/lib/github-backup/last-webhook-event.json` via ssh and asserts the `source`/`owner` field matches the last source POSTed. **Pure synthetic** — no live GitHub round-trip, no dependency on `cfg.webhookTestRepo`. Runs in any environment where the droplet is reachable and DNS resolves.
- **D-05 (SINGLE-SOURCE):** When `cfg.sources.length < 2`, the group exits with a loud skip line:
  ```
  [skip] WEBHOOK-03 multi-source assertion needs ≥2 sources in
         config.json; only N configured. Regression cannot be exercised
         in this environment.
  ```
  Overall verify run **continues and reports overall pass**. No hard-fail, no degenerate-coverage-still-passes warning. `verify:phase-3` is test-only by design (operator runs it manually; production webhook delivery never touches this code path), so honest partial coverage > false-green warnings or operator-blocking failures.

### Claude's Discretion

- Exact name of the tiny env-parser helper (e.g. `parseEnvFile`, `readBackupEnv`). Keep it inline in webhook-listener.js — don't extract to a separate file unless reuse appears later.
- Exact wording of the parse-fail log line beyond `reason: backup_env_unreadable`.
- Numbering of the new verify group (whatever's next after the current Group 4 in `scripts/verify/phase-3.ts`).
- Whether to reuse `syntheticPushPayload` as-is or add a `syntheticPushPayloadForOwner(owner, repo)` thin wrapper for readability.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase definition + requirements (post-rescope)

- `.planning/ROADMAP.md` §"Phase 9: Webhook multi-source + filter parity" (lines 74-90, edited 2026-05-17) — current scope is WEBHOOK-03 + VALID-04 only. Success Criteria #1 (multi-source routing) and #2 (verify regression) are the only acceptance gates.
- `.planning/REQUIREMENTS.md` lines 23-24 (WEBHOOK-03 active, WEBHOOK-04 dropped marker) and line 31 (VALID-04 narrowed to WEBHOOK-03 only).
- **Spec-edit commit:** `f25f463 docs(spec): drop WEBHOOK-04 per Phase 9 discuss — per-repo webhook is explicit operator consent`.

### Prior-phase code that establishes the contracts being parity'd to

- `droplet/github-backup.sh` lines 99-247 — cron path's authoritative use of `GITHUB_SOURCES`, `GITHUB_SOURCE_ALLOW_${SLOT}`, `GITHUB_SOURCE_DENY_${SLOT}`. The cron path keeps applying `filter_repos`; only the webhook path is freed from that contract.
- `scripts/bootstrap-droplet.ts` lines 80-107 — `writeBackupEnv()` is the canonical source-of-truth for how the env file is generated. `envSlot = n.toUpperCase().replace(/[^A-Z0-9]/g, "_")` is referenced by `github-backup.sh:105-107` as a comment but the rule itself lives in TS.
- `scripts/lib/config.ts` lines 200-280 — `NormalizedSource` type + `SHELL_SAFE_RE` source-name validation. Source names that pass validation are safe to embed in shell + env-var slot computations.

### Files Phase 9 modifies

- `droplet/webhook-listener.js`
  - lines 45-55 — top-of-file env loading. Remove `ALLOWED_SOURCE = process.env.GITHUB_USER_OR_ORG`; keep `SECRET`, `PORT`, `BACKUP_DIR`, `STATE_DIR`. Add the env-parser helper.
  - lines 143-158 — current single-source 404 check at `owner !== ALLOWED_SOURCE`. Replace with per-request re-read + `Set.has(owner)`.
  - lines 166-170 — `systemd-run --collect --no-block ${SYNC_SCRIPT} owner owner repo` dispatch. Unchanged (source == owner by Phase 6 design).
- `scripts/verify/phase-3.ts` (359 lines) — add a new group (likely Group 5) after the existing Group 4 e2e block; reuse `syntheticPushPayload` + `postWebhook` + `sshCapture` helpers.

### Files Phase 9 must NOT modify

- `droplet/lib/filter-repos.sh` — still used by cron path; out of scope.
- `droplet/sync-one-repo.sh` — signature unchanged.
- `droplet/github-backup.sh` — cron path unchanged.

No external specs or ADRs — entire phase is self-contained inside this repo.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets

- **`bail(msg)`** at `droplet/webhook-listener.js:40-43` — only used at boot for missing required env. Not used per-request; per-request errors use `res.writeHead(N).end()` + `logLine`.
- **`verifyHmac(buf, headerValue)`** at `webhook-listener.js:79-87` — timingSafeEqual, untouched.
- **`logLine(req, status, extra)`** at `webhook-listener.js:69-77` — structured stdout logging. New `reason: backup_env_unreadable` extra fits the existing schema.
- **`writeLastEvent(obj)`** at `webhook-listener.js:63-67` — atomic write to `/var/lib/github-backup/last-webhook-event.json`. Verify Group 5 reads this same file to assert routing.
- **`postWebhook(host, body, headers)`** and **`syntheticPushPayload(owner, repo)`** in `scripts/verify/phase-3.ts` — already used by Groups 3 and 4; reused for Group 5.
- **`sshCapture(cfg, droplet, cmd)`** in `scripts/verify/phase-3.ts` — already used at line 296 to cat `last-webhook-event.json`; reused for Group 5's assertion.

### Established Patterns

- **Fail-loud at boot, structured log + HTTP status per-request** (`webhook-listener.js` convention). D-02 fits this — parse errors per-request → HTTP 500 + structured log line.
- **`ARG_RE = /^[A-Za-z0-9._-]+$/`** shape guard at line 61 — applies after the owner check. Stays as-is; the new Set membership check happens *before* `ARG_RE`.
- **Standalone-per-phase verify runner** (Phase 7 D-09 carryover) — `scripts/verify/phase-3.ts` already follows this; new group lands inside the same file.
- **Order of checks in the handler** (HMAC → event-type → JSON parse → owner/repo extraction → owner authorization → arg-shape → dispatch). Per-request env re-read for the source list slots in between "owner/repo extraction" and the current "owner authorization" — same logical position, just a different data source.

### Integration Points

- `webhook-listener.js` reads `/opt/github-backups/backup.env` on every request after D-01 lands. `bootstrap-droplet.ts` writes this file (currently via `scp`; lands atomically via tmp + rename). Atomicity must be preserved on the writer side or D-02's 500-on-parse-error semantics kick in during the write window. The bootstrap path already writes via tmp + rename (`fs.writeFileSync` in a tmpdir, then `scp`) — confirm `scp` is atomic on the droplet side; if not, add a tmp + `mv` step in bootstrap-droplet.ts. (Note for planner: this is a behaviour-confirmation, not a guaranteed change.)
- `scripts/verify/phase-3.ts` extension depends only on existing helpers; no new TS modules.
- No changes to `package.json` (no new `npm run verify:phase-9` — VALID-04 explicitly extends `verify:phase-3`, not a new verify script).

</code_context>

<specifics>
## Specific Ideas

- The env-parser must NOT pull in any new npm dep. Hand-roll a ~20-line `parseEnvFile(path)` that handles `K=V`, `K="V V"`, blank + `#`-comment lines. Bash heredoc quoting in `writeBackupEnv` already produces clean output — no exotic cases.
- Verify Group 5 skip message wording is locked: `[skip] WEBHOOK-03 multi-source assertion needs ≥2 sources in config.json; only N configured. Regression cannot be exercised in this environment.`
- Verify Group 5 must POST against **at least 2 distinct source owners** when sources are configured — iterate all of `cfg.sources` so adding a 3rd source automatically gets coverage.
- For each POSTed source, the assertion reads `last-webhook-event.json` after the POST and confirms `source` and `owner` fields match the just-POSTed values. (`last-webhook-event.json` is overwritten per-event, so the order matters: POST → read → assert → next POST.)

</specifics>

<deferred>
## Deferred Ideas

### WEBHOOK-04 (filter on webhook path) — dropped 2026-05-17

The original requirement was: "webhook-listener.js sources droplet/lib/filter-repos.sh and applies the per-source allow/deny filter before dispatching sync-one-repo.sh." This was retired during Phase 9 discuss for the following reason:

> *A webhook can be set per-repo. If a user sets it, the user has expressed explicit intent for that repo to sync. Applying the cron-path allow/deny filter overrides operator intent for the per-repo case. For the org-wide webhook case, drift is operator-managed: if a repo shouldn't sync, remove the webhook from it (or remove the org-wide webhook and switch to per-repo).*

Spec edits committed at `f25f463`. Counter-argument worth recording for any future revisit: an org-wide webhook with a heavy allow/deny config means the operator may want the filter to suppress noise for repos they don't care about — without having to manage per-repo webhook installation. If that pain point shows up in real operation, the right answer is probably a NEW requirement (e.g. WEBHOOK-05: "respect a 'webhook_filter: strict' flag in config.json that re-enables filtering") rather than reviving WEBHOOK-04 verbatim.

### backup.env hot-reload via fs.watch (Area 1 Option 3)

Per-request re-read (D-01) costs ~1 fs read per webhook event — negligible at GitHub's per-push rates. If we ever start fielding high-volume bursts (org-wide webhook on a 1000-repo org during a force-push storm), revisit Option 3 (boot-load + fs.watch + parse-error safety) instead of per-request reads.

### Live e2e multi-repo testing (cfg.webhookTestRepos[])

Discussed in Area 4 as Option B/C — extending `cfg.webhookTestRepo` into a list and running real GitHub round-trips per source. Rejected for Phase 9 in favour of synthetic POSTs (D-04) because VALID-04 wording is satisfied by either, and synthetic POSTs work in any environment without per-source test repos. Could be added as a Phase 10 UAT scenario or a future opt-in verify group.

</deferred>

---

*Phase: 9-webhook-multi-source-filter-parity*
*Context gathered: 2026-05-17*

---
phase: 03-webhook
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - droplet/sync-one-repo.sh
  - droplet/github-backup.sh
autonomous: true
requirements:
  - BACKUP-02

must_haves:
  truths:
    - "droplet/sync-one-repo.sh <owner> <repo> is the single code path that mirrors one repo — both cron (Phase 1) and webhook (this phase, plan 02) invoke it."
    - "sync-one-repo.sh acquires a per-repo flock at /var/lock/github-backup-<owner>_<repo>.lock (D-16) so concurrent cron + webhook runs on the SAME repo serialize, but cron and webhook on DIFFERENT repos do not block each other."
    - "github-backup.sh keeps its global lock at /var/lock/github-backup.lock (Phase 1 NR-06 unchanged) AND, for each repo, delegates to sync-one-repo.sh; per-repo locks stack underneath the global lock — webhook handlers skip the global lock entirely (D-16)."
    - "Both scripts emit BACKUP_REPO_RESULT source=<src> owner=<o> repo=<r> action=<clone|update|fail> duration_ms=<n> (D-15 step 4) for status-command consumption."
    - "github-backup.sh continues to emit the existing BACKUP_SUMMARY line verbatim (Phase 1 contract preserved); refactor is internal."
    - "sync-one-repo.sh exits 0 on success, non-zero on fail (D-15 step 5) so the systemd-run worker (plan 02) can report status."
  artifacts:
    - path: "droplet/sync-one-repo.sh"
      provides: "Per-repo mirror handler invoked by both cron and webhook. Args: <source> <owner> <repo>. Reads GITHUB_TOKEN, BACKUP_DIR from /opt/github-backups/backup.env."
      min_lines: 80
      contains: "BACKUP_REPO_RESULT"
    - path: "droplet/github-backup.sh"
      provides: "Cron entry; outer loop enumerating repos, inner per-repo work delegated to sync-one-repo.sh. Still emits BACKUP_SUMMARY."
      contains: "sync-one-repo.sh"
  key_links:
    - from: "droplet/github-backup.sh"
      to: "droplet/sync-one-repo.sh"
      via: "bash invocation with arguments"
      pattern: "sync-one-repo\\.sh"
---

<objective>
Extract per-repo mirror logic from `droplet/github-backup.sh` into a standalone `droplet/sync-one-repo.sh <source> <owner> <repo>` script (D-15), introduce per-repo locking under the existing global cron lock (D-16), and emit a new per-repo log line `BACKUP_REPO_RESULT` for downstream status-command consumption. After this plan, the cron path uses the new handler internally; the webhook path (plans 02 + 03) will use the same handler. No behavior change visible to Phase 1's `verify:phase-1` — `BACKUP_SUMMARY` line is unchanged.

Phase 1 invariant kept intact: `mirrored == upstream && failed == 0` is still computed by `github-backup.sh` and still gated by the global flock.

Output: new `droplet/sync-one-repo.sh`; refactored `droplet/github-backup.sh`.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/PROJECT.md
@.planning/ROADMAP.md
@.planning/phases/03-webhook/03-CONTEXT.md
@droplet/github-backup.sh
@droplet/bootstrap.sh
@droplet/install-cron.sh
@scripts/verify/phase-1.ts

<interfaces>
<!-- sync-one-repo.sh contract:
       Usage: sync-one-repo.sh <source> <owner> <repo>
         <source>  — at v1 always equals <owner>; multi-source phase 6 will diverge.
         <owner>   — GitHub user/org login (alphanumeric + dashes + underscores).
         <repo>    — GitHub repo name.
       Env (sourced from /opt/github-backups/backup.env or pre-exported):
         GITHUB_TOKEN          required, used by `gh` and `git clone`/`git remote update`
         BACKUP_DIR            default /opt/github-backups
         LOG_FILE              default /var/log/github-backup.log
       Mirror path resolution (UNCHANGED from existing convention):
         ${BACKUP_DIR}/<owner>_<repo>.git
         (Phase 6 will namespace under a per-source dir; out of scope here.)
       Lock:
         /var/lock/github-backup-<owner>_<repo>.lock acquired via flock fd 8 (NON-blocking by default; envvar LOCK_WAIT_SECONDS_REPO=N enables blocking wait).
       Output (stdout+log file):
         Standard log lines as today, PLUS one terminating line:
           BACKUP_REPO_RESULT source=<s> owner=<o> repo=<r> action=clone duration_ms=<N>
           BACKUP_REPO_RESULT source=<s> owner=<o> repo=<r> action=update duration_ms=<N>
           BACKUP_REPO_RESULT source=<s> owner=<o> repo=<r> action=fail   duration_ms=<N>
       Exit:
         0 on action=clone|update success; non-zero on action=fail (or arg errors). -->
</interfaces>
</context>

<rationale>
**Why extract now (D-15):** The webhook listener (plan 02) needs to invoke per-repo logic without re-implementing it in Node and without forking a partial copy of the cron script. A standalone shell script — same language, same env — is the smallest possible duplication. Calling `bash sync-one-repo.sh …` from `systemd-run` (plan 02, D-03) is one line; re-implementing `git remote update --prune` semantics + log conventions in Node is much more.

**Why per-repo lock under global cron lock (D-16):** Webhook handlers MUST NOT block on the global cron lock — a 30-min sweep would freeze every push event for half an hour. Per-repo lock under the global lock means:
- Cron run: takes `/var/lock/github-backup.lock` (global, exclusive, Phase 1 NR-06 unchanged) — runs the loop — each iteration takes `/var/lock/github-backup-<o>_<r>.lock` (per-repo) — releases per-repo — moves on.
- Webhook handler (plan 02): skips global lock entirely — takes only per-repo lock.
- Same repo, cron+webhook racing: per-repo lock serializes them. Worst case: the webhook waits for the cron iteration on that one repo (seconds, not minutes).
- Different repos, cron+webhook in parallel: both proceed. No lock contention.

**Why the BACKUP_REPO_RESULT line (D-15 step 4):** Phase 2's status command will read `last-webhook-event.json` (plan 04) and the cron-emitted `BACKUP_SUMMARY`. The webhook flow needs per-repo timing/result data; the cron path also benefits because the existing summary line is aggregate-only. Adding a single grep-friendly per-repo line is the smallest additive change to the log contract.

**Why `<source>` arg exists at v1 even though it always equals `<owner>` today:** Phase 6 (multi-source) will introduce `cfg.sources[]`. Having the arg in place now means Phase 6 only changes call-sites, not the script's interface. The script ignores `<source>` for path resolution at v1 — keeps mirror at `${BACKUP_DIR}/<owner>_<repo>.git`, same path Phase 1 ships. Phase 6 will add `<source>/` namespacing.

**Why no change to `BACKUP_SUMMARY` (Phase 1 invariant):** `verify:phase-1.ts` parses `^... BACKUP_SUMMARY upstream=(\d+) mirrored=(\d+) failed=(\d+)$`. Changing this would break Phase 1's verification. The new `BACKUP_REPO_RESULT` is purely additive — Phase 1's regex won't match it, won't fail on it.

**Why `<source>` defaults to `<owner>` everywhere at v1:** No `cfg.sources` exists yet (PROJECT.md "Webhook listener ships before multi-source" decision). The cron loop has one source = `GITHUB_USER_OR_ORG`. The webhook resolves `payload.repository.owner.login` to the configured single source. Wire `<source>` arg now so Phase 6 doesn't need to rewrite the script's contract — but every call-site at v1 passes `<source>=<owner>`.
</rationale>

<tasks>

<task type="auto">
  <name>Task 1: Create droplet/sync-one-repo.sh</name>
  <files>droplet/sync-one-repo.sh</files>
  <read_first>
    - droplet/github-backup.sh (so executor extracts the existing per-repo loop body verbatim — same git commands, same env, same log function shape)
    - droplet/bootstrap.sh (to confirm `BACKUP_DIR` default and `backup.env` source convention)
    - .planning/phases/03-webhook/03-CONTEXT.md (D-15, D-16 sections — exact lock-file naming, exact log-line shape)
  </read_first>
  <acceptance_criteria>
    - File exists at droplet/sync-one-repo.sh, mode 0755 (chmod +x in task 3).
    - First line is `#!/usr/bin/env bash`.
    - Contains `set -euo pipefail`.
    - Contains exactly one `flock` invocation against fd 8 with lock file `/var/lock/github-backup-${OWNER}_${REPO}.lock` (use exec 8> redirect pattern same as github-backup.sh fd 9).
    - Lock acquisition is `flock -n 8` by default; if env `LOCK_WAIT_SECONDS_REPO` is set, switch to `flock -w "${LOCK_WAIT_SECONDS_REPO}" 8`.
    - Reads `BACKUP_DIR` env, defaults to `/opt/github-backups`.
    - Reads `LOG_FILE` env, defaults to `/var/log/github-backup.log`.
    - Sources `${BACKUP_DIR}/backup.env` if `GITHUB_TOKEN` is not pre-exported, with the same `set -a; source; set +a` pattern as github-backup.sh.
    - Validates required env `GITHUB_TOKEN` with the same `${VAR:?…}` style as github-backup.sh.
    - Accepts exactly three positional args: `SOURCE`, `OWNER`, `REPO`. Bails with non-zero exit and a `usage:` line on a different argc.
    - Validates each arg against regex `^[A-Za-z0-9._-]+$` (same shape constraint as Phase 5 SHELL_SAFE_FIELDS); bails on mismatch (so injection-shaped repo names can't reach `git`).
    - Mirror path computed as `${BACKUP_DIR}/${OWNER}_${REPO}.git` — verbatim same path scheme as github-backup.sh line ~140 (preserves Phase 1 mirror discoverability).
    - On existing mirror: runs `git -C "${MIRROR_PATH}" remote update --prune` exactly as in github-backup.sh today.
    - On missing mirror: runs `git clone --mirror "https://github.com/${OWNER}/${REPO}.git" "${MIRROR_PATH}"` exactly as today.
    - Captures `start_ms=$(date +%s%3N)` and `end_ms=$(date +%s%3N)`; computes `duration_ms=$(( end_ms - start_ms ))`.
    - Emits exactly one line of the form `[<timestamp>] BACKUP_REPO_RESULT source=<S> owner=<O> repo=<R> action=<clone|update|fail> duration_ms=<N>` via the same `log()` helper shape used by github-backup.sh (define a local `log()` if simpler — mirror github-backup.sh `log()` signature exactly).
    - Exit code: 0 on `action=clone|update`; non-zero on `action=fail` or arg/env validation failure.
    - Does NOT acquire `/var/lock/github-backup.lock` (the global lock) — that's the cron caller's responsibility.
    - Does NOT touch `BACKUP_SUMMARY` line semantics.
    - `bash -n droplet/sync-one-repo.sh` exits 0 (syntax OK).
  </acceptance_criteria>
  <action>
1. Create `droplet/sync-one-repo.sh` with header comment block (purpose, args, env, exit-code contract) matching the comment style of `droplet/github-backup.sh`.

2. Implement the script following the acceptance criteria literally. Concrete skeleton (executor adapts to match github-backup.sh style):

```bash
#!/usr/bin/env bash
# droplet/sync-one-repo.sh
# Mirror a single repo. Invoked by github-backup.sh (cron) and webhook-listener.js (push).
#
# Args:   <source> <owner> <repo>
# Env:    GITHUB_TOKEN (required), BACKUP_DIR (default /opt/github-backups),
#         LOG_FILE (default /var/log/github-backup.log),
#         LOCK_WAIT_SECONDS_REPO (default unset = non-blocking flock -n).
# Lock:   /var/lock/github-backup-<owner>_<repo>.lock on fd 8.
# Output: One terminating BACKUP_REPO_RESULT log line.
# Exit:   0 on success, non-zero on failure.
set -euo pipefail

export HOME="/root"
export PATH="/usr/local/bin:/usr/bin:/bin"
export GIT_TERMINAL_PROMPT=0

# ── Arg parse ────────────────────────────────────────────────────────────────
if [[ $# -ne 3 ]]; then
  echo "usage: $0 <source> <owner> <repo>" >&2
  exit 2
fi
SOURCE="$1"; OWNER="$2"; REPO="$3"

ARG_RE='^[A-Za-z0-9._-]+$'
for v in "$SOURCE" "$OWNER" "$REPO"; do
  [[ "$v" =~ $ARG_RE ]] || { echo "ERROR: invalid arg shape: ${v}" >&2; exit 2; }
done

# ── Env ──────────────────────────────────────────────────────────────────────
BACKUP_DIR="${BACKUP_DIR:-/opt/github-backups}"
LOG_FILE="${LOG_FILE:-/var/log/github-backup.log}"
ENV_FILE="${BACKUP_DIR}/backup.env"

if [[ -z "${GITHUB_TOKEN:-}" && -f "${ENV_FILE}" ]]; then
  set -a; source "${ENV_FILE}"; set +a
fi
: "${GITHUB_TOKEN:?GITHUB_TOKEN must be set (env or ${ENV_FILE})}"
export GITHUB_TOKEN

# ── Per-repo lock ────────────────────────────────────────────────────────────
LOCK_FILE="/var/lock/github-backup-${OWNER}_${REPO}.lock"
exec 8>"${LOCK_FILE}"
if [[ -n "${LOCK_WAIT_SECONDS_REPO:-}" ]]; then
  flock -w "${LOCK_WAIT_SECONDS_REPO}" 8 || {
    echo "ERROR: timed out waiting for ${LOCK_FILE}" >&2; exit 75; }
else
  flock -n 8 || {
    echo "ERROR: another sync holds ${LOCK_FILE}; skipping ${OWNER}/${REPO}" >&2
    exit 0  # not a failure — just deferred
  }
fi

# ── Log helper ───────────────────────────────────────────────────────────────
log() {
  local ts; ts=$(date '+%Y-%m-%d %H:%M:%S')
  printf '[%s] %s\n' "${ts}" "$*" | tee -a "${LOG_FILE}"
}

# ── Mirror dance ─────────────────────────────────────────────────────────────
MIRROR_PATH="${BACKUP_DIR}/${OWNER}_${REPO}.git"
CLONE_URL="https://github.com/${OWNER}/${REPO}.git"

start_ms=$(date +%s%3N)
ACTION="fail"
EXIT_CODE=1
if [[ -d "${MIRROR_PATH}" ]]; then
  log "  [UPDATE] ${OWNER}/${REPO}  →  ${MIRROR_PATH}"
  if git -C "${MIRROR_PATH}" remote update --prune >>"${LOG_FILE}" 2>&1; then
    log "           ✓ Updated"
    ACTION="update"; EXIT_CODE=0
  else
    log "           ✗ Update FAILED"
  fi
else
  log "  [CLONE]  ${OWNER}/${REPO}  →  ${MIRROR_PATH}"
  if git clone --mirror "${CLONE_URL}" "${MIRROR_PATH}" >>"${LOG_FILE}" 2>&1; then
    log "           ✓ Cloned"
    ACTION="clone"; EXIT_CODE=0
  else
    log "           ✗ Clone FAILED"
  fi
fi
end_ms=$(date +%s%3N)
duration_ms=$(( end_ms - start_ms ))

log "BACKUP_REPO_RESULT source=${SOURCE} owner=${OWNER} repo=${REPO} action=${ACTION} duration_ms=${duration_ms}"
exit "${EXIT_CODE}"
```

3. Verify: `bash -n droplet/sync-one-repo.sh` returns 0.
  </action>
</task>

<task type="auto">
  <name>Task 2: Refactor droplet/github-backup.sh to delegate per-repo work to sync-one-repo.sh</name>
  <files>droplet/github-backup.sh</files>
  <read_first>
    - droplet/github-backup.sh (current full body)
    - droplet/sync-one-repo.sh (the new helper from task 1 — to know its arg shape + exit contract)
    - scripts/verify/phase-1.ts (lines ~30-50 — BACKUP_SUMMARY regex; do NOT break it)
  </read_first>
  <acceptance_criteria>
    - `droplet/github-backup.sh` still emits exactly one `BACKUP_SUMMARY upstream=<N> mirrored=<N> failed=<N>` line per run, matching regex `/^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\] BACKUP_SUMMARY upstream=(\d+) mirrored=(\d+) failed=(\d+)$/` from scripts/verify/phase-1.ts.
    - Per-repo work is delegated by calling `"${BACKUP_DIR}/sync-one-repo.sh" "${GITHUB_USER_OR_ORG}" "${OWNER}" "${NAME}"` inside the existing `for REPO_FULL in "${REPOS[@]}"; do … done` loop.
    - The wrapper still increments `SUCCESS` / `FAIL` based on the exit code of `sync-one-repo.sh` (0 → SUCCESS++, non-zero → FAIL++).
    - The global flock at `/var/lock/github-backup.lock` is RETAINED on the outer loop (Phase 1 NR-06 unchanged).
    - The per-repo log lines inside `sync-one-repo.sh` replace the inline `[UPDATE]`/`[CLONE]` blocks from the current github-backup.sh — those inline blocks are DELETED from github-backup.sh to avoid duplicate log lines.
    - Account-type detection (User vs Organisation) and `gh api --paginate` repo enumeration remain in github-backup.sh — `sync-one-repo.sh` only handles ONE repo, not enumeration.
    - `bash -n droplet/github-backup.sh` exits 0.
  </acceptance_criteria>
  <action>
1. Inside the existing `for REPO_FULL in "${REPOS[@]}"; do` loop, replace the entire `if [[ -d "${MIRROR_PATH}" ]] … else … fi` block (the `[UPDATE]`/`[CLONE]` inline dance, lines roughly 159-183 in current file) with:

```bash
  if "${BACKUP_DIR}/sync-one-repo.sh" "${GITHUB_USER_OR_ORG}" "${OWNER}" "${NAME}"; then
    (( SUCCESS++ ))
  else
    (( FAIL++ ))
  fi
```

2. DELETE the now-unused `MIRROR_PATH=…` and `CLONE_URL=…` lines from inside the loop (`sync-one-repo.sh` computes them internally). Keep the `OWNER=…` and `NAME=…` extraction from `REPO_FULL` — they're needed for the args.

3. Leave the global flock setup (lines 35-55), env sourcing (62-71), required-env checks (73-75), account-type detection (96-111), repo-list fetch (115-142), and final `BACKUP_SUMMARY` emission (187-195) UNCHANGED. This is a surgical extract — only the per-repo work moves.

4. Verify: `bash -n droplet/github-backup.sh` returns 0.

5. Run a manual end-to-end sanity simulation in the executor's head (do NOT execute on a live droplet — that's the smoke-test's job): step through the loop, confirm SUCCESS/FAIL still tally correctly, confirm BACKUP_SUMMARY still fires.
  </action>
</task>

<task type="auto">
  <name>Task 3: Make sync-one-repo.sh executable + ensure bootstrap.sh installs it</name>
  <files>droplet/sync-one-repo.sh, droplet/bootstrap.sh</files>
  <read_first>
    - droplet/bootstrap.sh (lines 100-104 — the existing `chmod +x` block)
    - scripts/bootstrap-droplet.ts (lines 108-123 — confirms uploader already scp's every `*.sh` in droplet/)
  </read_first>
  <acceptance_criteria>
    - `droplet/sync-one-repo.sh` has executable bit set in repo (`git ls-files --stage droplet/sync-one-repo.sh` shows mode 100755).
    - `droplet/bootstrap.sh` includes a `chmod +x "${BACKUP_DIR}/sync-one-repo.sh"` line in its "Setting script permissions…" block (mirror the existing `github-backup.sh` and `install-cron.sh` chmod lines).
    - `scripts/bootstrap-droplet.ts` does NOT need editing — it already uploads `*.sh` from `droplet/` (line 116 filter). Confirm by reading lines 108-123 and leaving them alone.
  </acceptance_criteria>
  <action>
1. `chmod +x droplet/sync-one-repo.sh` locally so git records mode 100755.

2. In `droplet/bootstrap.sh`, find the existing block:
```bash
chmod +x "${BACKUP_DIR}/github-backup.sh"
chmod +x "${BACKUP_DIR}/install-cron.sh"
```
Add one more line directly below those two:
```bash
chmod +x "${BACKUP_DIR}/sync-one-repo.sh"
```

3. `bash -n droplet/bootstrap.sh` returns 0.
  </action>
</task>

</tasks>

<verification>
After all three tasks:

1. `bash -n droplet/sync-one-repo.sh && bash -n droplet/github-backup.sh && bash -n droplet/bootstrap.sh` exits 0.
2. `grep -c "BACKUP_REPO_RESULT" droplet/sync-one-repo.sh` returns 1 (exactly one emit line).
3. `grep -c "BACKUP_SUMMARY" droplet/github-backup.sh` returns 1 (unchanged contract — exactly one emit line).
4. `grep -c "sync-one-repo.sh" droplet/github-backup.sh` returns ≥ 1 (delegation wired).
5. `grep -c "sync-one-repo.sh" droplet/bootstrap.sh` returns ≥ 1 (chmod added).
6. `git diff --stat droplet/` shows: new `sync-one-repo.sh`, modified `github-backup.sh`, modified `bootstrap.sh`. No other files touched.
7. Mental walk-through: a cron run with N repos still emits exactly one `BACKUP_SUMMARY` line at the end + N `BACKUP_REPO_RESULT` lines interleaved; `verify:phase-1.ts` regex still matches the summary line.

If any check fails, fix and rerun before marking the plan complete.
</verification>

<deferred>
- Migrating Phase 1's `BACKUP_SUMMARY` regex to also assert N matching `BACKUP_REPO_RESULT` lines — kept additive at v1 to avoid touching verify:phase-1.ts. Phase 6 may revisit.
- Per-source mirror namespacing (`${BACKUP_DIR}/<source>/<owner>_<repo>.git`) — deferred to Phase 6 (multi-source) per ROADMAP. `<source>` arg is already in place so Phase 6 only changes path resolution, not the script contract.
- Self-rate-limit / GH API quota backoff inside sync-one-repo.sh — out of scope (single-operator, GitHub's per-token limit is ample).
</deferred>

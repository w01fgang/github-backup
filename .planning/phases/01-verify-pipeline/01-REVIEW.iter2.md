---
phase: 01-verify-pipeline
reviewed: 2026-05-02T06:51:42Z
depth: standard
files_reviewed: 10
files_reviewed_list:
  - droplet/github-backup.sh
  - package.json
  - scripts/bootstrap-droplet.ts
  - scripts/create-droplet.ts
  - scripts/destroy-droplet.ts
  - scripts/lib/config.ts
  - scripts/lib/doctl.ts
  - scripts/lib/ssh.ts
  - scripts/smoke-test.ts
  - scripts/verify/phase-1.ts
findings:
  blocker: 4
  warning: 13
  total: 17
status: issues_found
---

# Phase 1: Code Review Report

**Reviewed:** 2026-05-02T06:51:42Z
**Depth:** standard
**Files Reviewed:** 10
**Status:** issues_found

## Summary

Phase 1 ships a live-infra smoke + verify pipeline (provision → bootstrap → backup → assert) plus a refactor that splits shared lib code (`scripts/lib/{config,doctl,ssh}.ts`). Code is generally well-structured and idempotent. Adversarial review surfaced four BLOCKER-class defects: silent failure modes that can mask a broken backup as a green smoke (false-positive 100%-pass), and ordering bugs that waste money or destroy infra on misleading state. Thirteen WARNING-class robustness/quality issues, mostly around error surfacing and unsanitized interpolation into shells.

## Blockers

### BL-01: `gh api` failure produces silent zero-exit "success"

**File:** `droplet/github-backup.sh:92-103`
**Issue:** Repo list is built via process substitution:

```bash
mapfile -t REPOS < <(
  gh api --paginate "${API_ENDPOINT}" --jq '.[].full_name' 2>>"${LOG_FILE}"
)
TOTAL="${#REPOS[@]}"
...
if [[ "${TOTAL}" -eq 0 ]]; then
  log "Nothing to back up. Exiting."
  exit 0
fi
```

`gh api` exit status from `<(...)` is **discarded** — `set -o pipefail` does not propagate from process substitution. If the PAT is expired, GH is rate-limited, or the network drops mid-paginate, `REPOS` is empty (or truncated), the script exits **0** with the message "Nothing to back up", and the cron + smoke pipeline reports green. This breaks D-02 (100%-pass bar) — `BACKUP_SUMMARY upstream=0 mirrored=0 failed=0` satisfies `mirrored == upstream && failed == 0`.

**Fix:** Capture gh exit code explicitly. E.g.:

```bash
REPO_LIST=$(gh api --paginate "${API_ENDPOINT}" --jq '.[].full_name' 2>>"${LOG_FILE}") \
  || { log "ERROR: gh api failed (exit $?). Aborting."; exit 2; }
mapfile -t REPOS <<< "${REPO_LIST}"
# Filter possible trailing empty line:
[[ -z "${REPOS[-1]:-}" ]] && unset 'REPOS[-1]'
```

Smoke must also distinguish "0 repos" from "gh failed" — consider failing the smoke if `upstream==0` for an account known to host repos.

---

### BL-02: Truncated mirror count is reported as 100% success

**File:** `droplet/github-backup.sh:92-103, 152` (related to BL-01)
**Issue:** Even with BL-01 fixed for total failure, partial pagination failures leave a *truncated* `REPOS`. The marker reports `upstream=N mirrored=N failed=0` where N is the truncated count — both verifier and smoke accept it as 100%-pass. There is no independent cross-check that `upstream` equals the real GitHub repo count.

**Fix:** Either (a) make `gh api --paginate` failures fatal as in BL-01 — `--paginate` does set non-zero on partial failure, so capturing exit status closes both holes — or (b) record a separate trusted `upstream_count` via `gh api /user --jq .public_repos + .total_private_repos` (or org equivalent) and assert equal in the verifier.

---

### BL-03: `verify:phase-1` re-asserts `matches.length === 1` — fails on second run

**File:** `scripts/verify/phase-1.ts:165-208`
**Issue:** Group 3 triggers `github-backup.sh` then reads `tail -n 50 /var/log/github-backup.log` and asserts:

```ts
assert(
  matches.length === 1,
  `tail of ${REMOTE_LOG} contains exactly one BACKUP_SUMMARY line (got ${matches.length})`
);
```

The droplet log is **append-only** (no rotation configured). On any second invocation of `npm run verify:phase-1` while the previous run's `BACKUP_SUMMARY` line is still in the last 50 entries (likely on a small-account droplet — backup finishes in seconds, only ~10 log lines per repo), this assertion **fails**. Verify becomes non-idempotent — contradicts the idempotency premise of the rest of phase 1 (D-08).

**Fix:** Anchor on the most recent line, not on uniqueness. E.g.:

```ts
const last = matches[matches.length - 1];
assert(matches.length >= 1, "tail contains at least one BACKUP_SUMMARY line");
const m = last;
```

Optionally rotate or `> ${REMOTE_LOG}` before the trigger if a single-line invariant is desired — but truncation has its own audit-trail downside.

---

### BL-04: Smoke provisions droplet *before* validating GITHUB_TOKEN

**File:** `scripts/smoke-test.ts:251-271`
**Issue:** Order in `main`:

```ts
maybeFreshReset();         // optional destroy
provision();               // creates droplet → costs money
const droplet = loadDropletInfo();
const cfg = loadConfig();
...
bootstrap();               // first checks process.env["GITHUB_TOKEN"]
```

If the operator forgets `GITHUB_TOKEN`, the smoke creates and pays for a droplet, then aborts in `bootstrap()` with the `GITHUB_TOKEN not set` bail. Combined with default `--fresh` semantics (D-04 says droplet *preserved*), the surviving droplet is unbootstrapped and useless — but billable.

**Fix:** Hoist the env-var check to the top of `main()` (before `provision()` and even before `maybeFreshReset()`):

```ts
async function main(): Promise<void> {
  if (!process.env["GITHUB_TOKEN"]) {
    bail("GITHUB_TOKEN environment variable is not set.\n    Usage: GITHUB_TOKEN=<your_pat> npm run smoke-test");
  }
  ...
}
```

---

## Warnings

### WR-01: `dropletExists` swallows all errors as "doesn't exist"

**File:** `scripts/destroy-droplet.ts:74-83`
**Issue:**

```ts
function dropletExists(dropletId: number): boolean {
  try { doctlJson<DropletRecord>(`doctl ... get ${dropletId} ...`); return true; }
  catch { return false; }
}
```

Returns `false` on **any** error: 404, network, auth-expired, doctl-not-installed. A doctl-auth glitch silently skips droplet deletion → `.droplet.json` is removed (line 137) → operator believes destroy succeeded → orphaned billable droplet.

**Fix:** Distinguish 404 from other errors. Either parse stderr for a not-found marker, or catch and only return `false` on a "404" / "not found" string match; rethrow otherwise.

---

### WR-02: Concurrent backups can corrupt mirrors (no lock)

**File:** `droplet/github-backup.sh:23, 109-145`
**Issue:** Cron-installed schedule plus the explicit `runVisible(.../github-backup.sh)` from `verify:phase-1` (line 178-180) and `triggerBackup` (smoke line 119) can execute concurrently. `git -C <mirror> remote update --prune` on the same `*.git` from two processes can leave a half-written packed-refs / locked refs.

**Fix:** Wrap script body in `flock`:

```bash
exec 9>/var/lock/github-backup.lock
flock -n 9 || { log "another instance running, exiting"; exit 0; }
```

---

### WR-03: `first<T>(cmd)` returns `undefined` on empty array

**File:** `scripts/lib/doctl.ts:21-24`
**Issue:**

```ts
export function first<T>(cmd: string): T {
  const result = doctlJson<T | T[]>(cmd);
  return Array.isArray(result) ? (result as T[])[0] : (result as T);
}
```

If doctl returns `[]` (e.g., create succeeded with empty payload — does not happen today, but contract is unchecked), the function returns `undefined` typed as `T`, and the caller dereferences `.id` for an NPE with a useless stack trace. Ditto for `null` JSON.

**Fix:**

```ts
const item = Array.isArray(result) ? result[0] : result;
if (item == null) throw new Error(`doctl returned no record for: ${cmd}`);
return item as T;
```

---

### WR-04: Token written to `backup.env` without escaping

**File:** `scripts/bootstrap-droplet.ts:38-53`
**Issue:** `writeBackupEnv` emits `GITHUB_TOKEN=${githubToken}` raw. The droplet sources the file with `set -a; source backup.env`. GitHub PATs today are alnum+underscore so safe in practice, but there is **no validation** that the token matches that shape. A user pasting `ghp_xxx\n` (trailing newline), or a future PAT format using `$`/`"`/`\``, will produce a corrupt or injecting env file.

**Fix:** Validate token shape (`/^[A-Za-z0-9_]+$/`) and bail loudly on mismatch, or single-quote-escape and emit `GITHUB_TOKEN='...'\''...'`.

---

### WR-05: Unsanitized config interpolation into remote shell command

**File:** `scripts/lib/ssh.ts:80-87`, callers in `scripts/bootstrap-droplet.ts:82, 109`, `scripts/verify/phase-1.ts:135, 146, 178-180`, `scripts/smoke-test.ts:135, 208, 236`
**Issue:** `sshRun` builds `ssh ... '${remoteCmd}'`. Comment says callers must not pass single-quotes — but every caller interpolates `${REMOTE_DIR}`, `${cfg.backupDir}`, `${cfg.sshUser}`, etc. Config is operator-owned, so not an external attack vector — but a `'` or unbalanced `"` in `backupDir` or `firewallName` produces an opaque ssh parse error.

**Fix:** Either validate config strings against a strict allow-list (`/^[A-Za-z0-9._/-]+$/`) in `loadConfig`, or use a proper escape (e.g., `shell-quote` package, or `'\''` substitution) inside `sshRun`/`scpFile`.

---

### WR-06: `bootstrap-droplet` uploads every entry in `droplet/`

**File:** `scripts/bootstrap-droplet.ts:93-101`
**Issue:**

```ts
const scriptFiles = fs.readdirSync(dropletDir).map((f) => path.join(dropletDir, f));
for (const file of scriptFiles) { ... scpFile(...); }
```

Picks up `.DS_Store` on macOS, editor swap files (`.bootstrap.sh.swp`), backups, *and* any subdirectory (which `scpFile` will try to upload as a regular file → fails). Also no extension filter despite the variable name `scriptFiles`.

**Fix:** Filter to regular files with `.sh` extension:

```ts
const scriptFiles = fs.readdirSync(dropletDir, { withFileTypes: true })
  .filter((d) => d.isFile() && d.name.endsWith(".sh"))
  .map((d) => path.join(dropletDir, d.name));
```

---

### WR-07: Inconsistent `|| true` on arithmetic increments

**File:** `droplet/github-backup.sh:127, 130, 139, 142`
**Issue:** `(( FAIL++ )) || true` is used; `(( SUCCESS++ ))` is not. The author's comment "`|| true` keeps set -e from firing on arithmetic" suggests awareness of the quirk. In practice modern bash exempts `((expr))` in this position from `set -e`, but the inconsistency is a code-smell that suggests one of the two understandings is wrong.

**Fix:** Use the same form for both. Cheapest: drop `|| true` from FAIL (matches SUCCESS empirically) or add it to both for defense-in-depth.

---

### WR-08: `cloneProbe` cleanup runs inside `try` — rmSync errors masquerade as probe failure

**File:** `scripts/smoke-test.ts:163-195`
**Issue:**

```ts
try {
  runVisible(`...git clone...`);
  // ... assertions ...
  fs.rmSync(tmpDir, { recursive: true, force: true });   // INSIDE try
} catch (err) {
  console.error(`   Clone-probe failed; tmpdir preserved at ${tmpDir} for inspection.`);
  bail(`clone-probe: ${msg}`);
}
```

A spurious `rmSync` failure (rare with `force:true`, but possible on some FSes / readonly mounts) would print "Clone-probe failed" and preserve the tmpdir even though the probe itself succeeded. Compare with the cleaner `cleanupOnSuccess` flag pattern in `verify/phase-1.ts:265-273`.

**Fix:** Mirror the phase-1 pattern — use a `finally` with a cleanup flag, or move `rmSync` to a `finally` and key tmpdir-preservation off success.

---

### WR-09: `phase-1.ts` triggers backup synchronously without locking

**File:** `scripts/verify/phase-1.ts:175-180`
**Issue:** Same race as WR-02 from a different vector: cron may fire while verify is mid-run. With no lock in `github-backup.sh`, two concurrent updates on the same mirror can corrupt it. WR-02 fixes this end-to-end.

**Fix:** WR-02. (No fix needed in `phase-1.ts` once the script is locked.)

---

### WR-10: `loadConfig` does not handle malformed JSON

**File:** `scripts/lib/config.ts:69`
**Issue:** `JSON.parse(fs.readFileSync(p, "utf8"))` throws raw `SyntaxError` for malformed `config.json`. Bubbles up to the script's outer catch as `Unexpected token ...` — confusing for users who copied `config.example.json` and forgot a comma.

**Fix:**

```ts
let cfg: Config;
try { cfg = JSON.parse(fs.readFileSync(p, "utf8")) as Config; }
catch (e) { bail(`config.json is not valid JSON: ${(e as Error).message}`); }
```

---

### WR-11: `sshExitsZero` cannot distinguish ssh transport failure from remote non-zero

**File:** `scripts/verify/phase-1.ts:78-90`
**Issue:**

```ts
function sshExitsZero(...): boolean {
  try { runCapture(`ssh ... '${remoteCmd}'`); return true; }
  catch { return false; }
}
```

A genuine ssh-layer failure (network blip, key auth lost) is reported as the remote command failing — verifier message becomes "`/opt/.../bootstrap.sh present and executable` failed" when the truth is "ssh died". Same hazard as WR-01, different surface.

**Fix:** Inspect the captured stderr / exit code; only return `false` when the remote process actually returned non-zero. Bubble transport errors as exceptions.

---

### WR-12: Comment block above logging helper contains corrupt UTF-8

**File:** `droplet/github-backup.sh:54` (around the `# ── Logging helper ──` comment)
**Issue:** The box-drawing characters in the comment band before `log() {` show up as invalid UTF-8 sequences when run through `cat -v`. Cosmetic but reproducible — likely a copy-paste artifact from a non-UTF-8 source. Comment is harmless to bash, but breaks `less`/editors with strict encoding.

**Fix:** Replace the comment band with plain ASCII (`# --- Logging helper ---`) or re-emit with proper UTF-8.

---

### WR-13: `scripts/verify/phase-1.ts` references `expandHome` only via `void`

**File:** `scripts/verify/phase-1.ts:286`
**Issue:**

```ts
// Touch expandHome so the import is referenced even though sshFlags()
// already calls it transitively — keeps the module-level dependency
// explicit for future grep-ability.
void expandHome;
```

Comment justifies an unused import. The honest fix is to drop the import — `sshFlags` calls it transitively, that's the contract. The `void expandHome;` line will trip future linters and mislead readers into thinking there is a runtime dependency.

**Fix:** Delete `expandHome` from the import list and delete the `void` line.

---

_Reviewed: 2026-05-02T06:51:42Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_

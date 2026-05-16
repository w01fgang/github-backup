---
phase: 01-verify-pipeline
reviewed: 2026-05-04T00:00:00Z
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
  blocker: 0
  warning: 4
  total: 4
status: issues_found
---

# Phase 1: Code Review Report (Re-Review #2)

**Reviewed:** 2026-05-04T00:00:00Z
**Depth:** standard
**Files Reviewed:** 10
**Status:** issues_found

## Summary

Re-review of all 22 prior findings (4 BL + 13 WR + 5 NR) after iter2 fix wave (5 atomic commits cd71477..baf4763). All five iter2 regressions (NR-01..NR-05) are correctly fixed in code:

- **NR-01** (cd71477): `REQUIRE_LOCK=1` env-gate added to `github-backup.sh`; `triggerBackup` and `group3BackupRan` set the env so they block on the lock instead of silent-exiting. Cron path retains `flock -n` + `exit 0`. Verified.
- **NR-02** (4c60e13): full empty-entry filter via guarded TMP loop; `set -u`-safe under both empty and non-empty inputs.
- **NR-03** (6ea53d6): separate `CRON_SAFE_RE = /^[0-9*,/ \t-]+$/` validation pass at the bottom of `loadConfig`. (See NR-07 below — regex too tight.)
- **NR-04** (e366771): `r.signal` and `r.status === null` branches inserted before the `r.status === 255` check; signal-killed ssh now throws as a transport-class failure.
- **NR-05** (baf4763): all three GITHUB_TOKEN-presence sites trim before checking; the writeBackupEnv shape error reports trimmed length only (no value leak). Consolidation deferred per the iter2 fix report.

`tsc --noEmit` is silent. `bash -n droplet/github-backup.sh` accepts the new script.

The original 17 BL/WR findings remain correctly fixed (no regressions reintroduced). The iter2 patch wave introduces no new BLOCKER. It does leave or introduce **four WARNING-class edges**:

1. **NR-06**: `flock 9` (blocking) has no timeout — verify/smoke hang indefinitely if a cron run wedges.
2. **NR-07**: `CRON_SAFE_RE` rejects valid cron extensions (`@daily`, `@hourly`, named months/days, `L`/`W`/`#`); behavior regression for operators using those forms.
3. **NR-08**: NR-01 closes the *cron-before-trigger* race only. *Trigger-before-cron-fires-during-tail-window* still produces a "last BACKUP_SUMMARY" mismatch.
4. **NR-09** (pre-existing but unflagged in iter1): `findFirewallId` swallows all doctl errors as "absent" — same auth-glitch-hides-orphan hazard as the old WR-01 in the firewall path.

## Warnings

### NR-06: `flock 9` blocking has no timeout — verify/smoke can hang forever

**File:** `droplet/github-backup.sh:41-46`, `scripts/smoke-test.ts:126`, `scripts/verify/phase-1.ts:205-207`
**Issue:** The NR-01 fix gates lock semantics on `REQUIRE_LOCK`:

```bash
if [[ "${REQUIRE_LOCK:-0}" = "1" ]]; then
  flock 9          # blocks indefinitely
elif ! flock -n 9; then
  echo "..." >&2
  exit 0
fi
```

`flock 9` (no `-w N`) waits forever. If a cron-launched backup wedges (long-running mid-clone of a 5 GB repo, hung TLS handshake to GitHub, kernel NFS lock weirdness), the verify-side `runVisible(...REQUIRE_LOCK=1 .../github-backup.sh...)` and the smoke-side `triggerBackup` both block silently with no progress output. The operator sees `verify:phase-1` "running" indefinitely; CI builds consume their wall-clock budget; the only signal is the kernel SIGTERM at job-timeout.

This is the canonical "fix the false-pass; introduce a hang" trade. The NR-01 review flagged it implicitly (option 1: "exit 75 / retry with backoff") but the smallest-diff option 2 was applied without a wall-clock cap.

**Fix:** Bound the wait with `flock -w N`:

```bash
LOCK_WAIT_SECONDS="${LOCK_WAIT_SECONDS:-600}"   # 10 min cap; tune per-install
if [[ "${REQUIRE_LOCK:-0}" = "1" ]]; then
  flock -w "${LOCK_WAIT_SECONDS}" 9 || {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] timed out (${LOCK_WAIT_SECONDS}s) waiting for ${LOCK_FILE}" >&2
    exit 75
  }
elif ! flock -n 9; then
  echo "..." >&2
  exit 0
fi
```

`exit 75` (EX_TEMPFAIL) lets verify/smoke surface the timeout distinctly from a real backup failure. Caller logs become actionable: "the previous run wedged; investigate ${LOCK_FILE}".

---

### NR-07: `CRON_SAFE_RE` rejects valid cron extensions — `@daily`, named months/days, `L`/`W`/`#`

**File:** `scripts/lib/config.ts:86`
**Issue:**

```ts
const CRON_SAFE_RE = /^[0-9*,/ \t-]+$/;
```

This rejects every cron form that contains letters or `@`/`#`/`L`/`W`:

| Form                | Example                  | Accepted? |
|---------------------|--------------------------|-----------|
| Standard 5-field    | `30 3 * * *`             | yes       |
| Nicknames           | `@daily`, `@hourly`, `@reboot` | **no**    |
| Named months        | `30 3 * JAN *`           | **no**    |
| Named days          | `30 3 * * MON`           | **no**    |
| Last-day-of-month   | `30 3 L * *`             | **no**    |
| Nearest-weekday     | `30 3 15W * *`           | **no**    |
| Nth-weekday         | `30 3 * * 2#3`           | **no**    |

`droplet/install-cron.sh` writes the value verbatim into a crontab line (`${CRON_SCHEDULE} HOME=/root PATH=... ${BACKUP_SCRIPT} ...`) and Linux cron / Vixie cron / cronie all accept the named-form variants. WR-05's intent was injection prevention, not restricting the cron grammar. The current regex is over-broad in its rejections.

**Fix:** Extend the allow-list to include the alphabetic / extension chars used by valid cron grammar; injection-relevant chars (`"`, `$`, `` ` ``, `\`, `;`, `&`, `|`, `<`, `>`, `(`, `)`, `{`, `}`, newline) remain blocked:

```ts
const CRON_SAFE_RE = /^[A-Za-z0-9@*,/#? \t-]+$/;
```

(`@` enables nicknames; `A-Z`/`a-z` enables `JAN`-`DEC`/`MON`-`SUN`/`L`/`W`; `#` enables nth-weekday; `?` for the no-specific-value extension some daemons accept.)

Add a unit test fixture covering at least: `30 3 * * *` (default), `@daily`, `0 3 * * MON`, `0 3 L * *`, `0 3 15W * *`, `0 3 * * 2#3` (all should pass), and `0 3 * * * ; rm -rf /` (should bail).

---

### NR-08: NR-01 closes only one race direction — cron firing *after* trigger still mis-parses BACKUP_SUMMARY

**File:** `scripts/verify/phase-1.ts:205-226`, `scripts/smoke-test.ts:223-247`
**Issue:** NR-01 covers the case "cron is mid-run when verify triggers" by making verify *block* on the lock. After the lock releases and the verify-triggered run finishes, both `enforcePassBar` (smoke) and `group3BackupRan` (verify) parse the **last** `BACKUP_SUMMARY` line in `tail -n 50 ${REMOTE_LOG}`:

```ts
const m = matches[matches.length - 1];
```

This is correct **only if** no further BACKUP_SUMMARY is emitted between the trigger's return and the tail-read. If cron fires in that window — likely on `* * * * *` schedules, possible on `*/5 * * * *`, vanishingly rare on `30 3 * * *` — the tail's "last match" is the cron run's summary, not the trigger's.

Concrete failure path:

1. Verify runs at 03:29:55 with `*/1 * * * *` cron schedule (operator overrides default for testing).
2. Verify acquires lock, runs backup. Completes 03:30:02. BACKUP_SUMMARY #1 emitted at 03:30:02.
3. ssh returns to verify.
4. Cron fires at 03:30:00, but waited for verify's lock; acquires at 03:30:02; starts backup.
5. Verify reaches `tail -n 50 ${REMOTE_LOG}` at 03:30:08. Cron run finishes 03:30:09 → BACKUP_SUMMARY #2 emitted.
6. *If verify reads tail at 03:30:10*, `matches[length-1]` is BACKUP_SUMMARY #2 — the cron run, not the verify-triggered one.

If the cron run mirrored a different repo state (e.g., a freshly added repo upstream that the verify-triggered run already mirrored), `mirrored === upstream` may differ between the two summaries by ±1 → spurious assertion failure that the operator cannot reproduce by re-running verify.

This is a less-likely cousin of NR-01 (the cron-before-trigger inverse), but lives in the same code path. NR-01 closed half the door.

**Fix options:**

1. **Anchor on a per-run nonce.** github-backup.sh emits `BACKUP_SUMMARY run_id=<random>` and the trigger-side captures the random in advance, then the tail-parse asserts on the matching nonce.
2. **Anchor on monotonic timestamp.** Trigger records `T_start` (`date +%s` on the droplet) before invoking; tail-parse extracts the `[YYYY-MM-DD HH:MM:SS]` prefix and asserts `>= T_start`.
3. **Truncate-then-trigger.** Right before triggering (with REQUIRE_LOCK=1 already serialising), `: > ${REMOTE_LOG}` so the tail can only contain the new run's lines. Loses audit-trail; explicit operator opt-in only.

Option 2 is the smallest diff and self-documenting:

```ts
const tStartIso = sshCapture(ip, user, key, `date -u +%Y-%m-%dT%H:%M:%SZ`);
runVisible(`ssh ... 'REQUIRE_LOCK=1 ${REMOTE_DIR}/github-backup.sh'`);
// then in tail-parse, filter matches whose timestamp prefix postdates tStartIso
```

---

### NR-09: `findFirewallId` swallows all doctl errors as "absent" — same hazard as WR-01 in the firewall path

**File:** `scripts/destroy-droplet.ts:58-68`
**Issue:** WR-01 (iter1, commit 556df9d) hardened `dropletExists` to distinguish a true 404 from a generic doctl failure (auth glitch, network blip, doctl missing) so a transient error cannot trick the operator into deleting `.droplet.json` while the droplet stays billable. The parallel function `findFirewallId` was not patched in the same wave and still has the original bare-catch shape:

```ts
function findFirewallId(firewallName: string): string | null {
  let all: FirewallRecord[] = [];
  try {
    all = doctlJson<FirewallRecord[]>(
      "doctl compute firewall list --output json"
    );
  } catch {
    return null;
  }
  return all.find((fw) => fw.name === firewallName)?.id ?? null;
}
```

If `doctl compute firewall list` returns non-zero from auth expiration, an API throttle, or a transient doctl/DO outage, `findFirewallId` returns `null`. `main()` then logs `"Firewall ${cfg.firewallName} already absent."` and proceeds to delete the droplet + remove `.droplet.json`. Result: **orphaned billable firewall**, with `.droplet.json` gone so destroy-droplet cannot find it again. Same false-positive class as the original WR-01.

This was likely missed in iter1 because the review enumerated the hazard only on the droplet path. The threat model is identical for any doctl-fronted resource.

**Fix:** Mirror the WR-01 fix shape:

```ts
function findFirewallId(firewallName: string): string | null {
  let all: FirewallRecord[];
  try {
    all = doctlJson<FirewallRecord[]>(
      "doctl compute firewall list --output json"
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    // Empty firewall list errors on some doctl versions — tolerate that.
    // Anything else (auth, network, doctl missing) must surface so we
    // do not delete .droplet.json while a firewall remains.
    if (/empty list|no firewalls/i.test(msg)) {
      return null;
    }
    throw new Error(
      `doctl firewall list failed (refusing to assume absence): ${msg}`
    );
  }
  return all.find((fw) => fw.name === firewallName)?.id ?? null;
}
```

(The `create-droplet.ts:findOrCreateFirewall` sibling function at line 122-130 has the same swallow pattern — comment there says "An empty firewall list may error on some doctl versions — safe to ignore." That's the create-side, where misclassifying a real failure causes a benign duplicate-create attempt rather than a silent orphan; lower severity but worth the same hardening for consistency.)

---

## Verification of Prior Fixes

Iter1 (BL-01..BL-04, WR-01..WR-13) and iter2 (NR-01..NR-05) findings — all 22 — re-checked against the current source.

| ID    | Iter | Commit  | Code anchor                                       | Status                       |
|-------|------|---------|---------------------------------------------------|------------------------------|
| BL-01 | 1    | 5ec1c35 | `droplet/github-backup.sh:109-111`                | Fixed                        |
| BL-02 | 1    | (BL-01) | (closed by capturing `gh api --paginate` exit)    | Fixed (transitively)         |
| BL-03 | 1    | 01babd7 | `scripts/verify/phase-1.ts:216-223`               | Fixed                        |
| BL-04 | 1    | a0c65df | `scripts/smoke-test.ts:270-279`                   | Fixed                        |
| WR-01 | 1    | 556df9d | `scripts/destroy-droplet.ts:79-96`                | Fixed (NR-09 in sibling fn)  |
| WR-02 | 1    | 736a2c7 | `droplet/github-backup.sh:31-46`                  | Fixed (NR-06 timeout)        |
| WR-03 | 1    | 4b9c000 | `scripts/lib/doctl.ts:21-28`                      | Fixed                        |
| WR-04 | 1    | 6a09a1c | `scripts/bootstrap-droplet.ts:44-52`              | Fixed                        |
| WR-05 | 1    | b1edac9 | `scripts/lib/config.ts:67-114`                    | Fixed (NR-07 cron grammar)   |
| WR-06 | 1    | 71ec418 | `scripts/bootstrap-droplet.ts:114-117`            | Fixed                        |
| WR-07 | 1    | 2cfdcdb | `droplet/github-backup.sh:157,160,169,172`        | Fixed                        |
| WR-08 | 1    | af3d3b7 | `scripts/smoke-test.ts:170-212`                   | Fixed                        |
| WR-09 | 1    | 736a2c7 | (same as WR-02)                                   | Fixed (NR-06 timeout)        |
| WR-10 | 1    | b1edac9 | `scripts/lib/config.ts:96-101`                    | Fixed                        |
| WR-11 | 1    | 18fdb8f | `scripts/verify/phase-1.ts:83-113`                | Fixed                        |
| WR-12 | 1    | 73a8642 | `droplet/github-backup.sh:71`                     | Fixed                        |
| WR-13 | 1    | e45a7ef | `scripts/verify/phase-1.ts:29`                    | Fixed                        |
| NR-01 | 2    | cd71477 | `droplet/github-backup.sh:41-46`, `smoke-test.ts:126`, `verify/phase-1.ts:205-207` | Fixed (NR-06, NR-08)         |
| NR-02 | 2    | 4c60e13 | `droplet/github-backup.sh:113-125`                | Fixed                        |
| NR-03 | 2    | 6ea53d6 | `scripts/lib/config.ts:86,121-128`                | Fixed (NR-07 over-tight)     |
| NR-04 | 2    | e366771 | `scripts/verify/phase-1.ts:91-112`                | Fixed                        |
| NR-05 | 2    | baf4763 | `bootstrap-droplet.ts:81`, `smoke-test.ts:107,274`| Fixed                        |

`tsc --noEmit` passes silently. `bash -n droplet/github-backup.sh` accepts the script. The 22 prior findings are all closed; the four warnings above are the remaining adversarial surface after two fix waves.

---

_Reviewed: 2026-05-04T00:00:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_

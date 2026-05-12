---
phase: 04-restore
plan: 02
type: execute
wave: 2
depends_on: ["04-01"]
files_modified:
  - scripts/verify/phase-4.ts
  - package.json
autonomous: true
requirements:
  - RESTORE-01
  - RESTORE-02

must_haves:
  truths:
    - "Operator runs `npm run verify:phase-4` and gets exit 0 if and only if all assertion groups pass against the configured restoreTestRepo"
    - "Verify script invokes the helper from plan 04-01 — does NOT duplicate the restore dance (single source of truth, D-04)"
    - "Ref-equivalence assertion (D-02): sorted `git ls-remote` output of the restored clone matches sorted output queried against the droplet mirror — exact byte-equal comparison of names + SHAs"
    - "Comparison baseline is droplet mirror, NOT github.com (per D-02 constraint: mirror freshness is Phase 1's concern)"
    - "Bails with named assertion message on the first failure; on failure, leaves the temp restore dir on disk and prints its path (D-06)"
    - "Push-back assertion is explicitly NOT included (D-03 decision: ls-remote already proves byte-equivalent refs; self-push to a throwaway bare adds zero signal beyond ls-remote)"
  artifacts:
    - path: "scripts/verify/phase-4.ts"
      provides: "Per-phase executable verification for ROADMAP Phase 4 (Restore). Asserts: (1) config.restoreTestRepo set, (2) helper succeeds, (3) restored clone refs match droplet mirror refs via git ls-remote sorted diff, (4) restored clone has both at least one branch and at least one tag (sanity check that ls-remote was non-empty), (5) cleanup on success."
      min_lines: 100
    - path: "package.json"
      provides: "Adds `verify:phase-4` npm script wired to tsx scripts/verify/phase-4.ts"
  key_links:
    - from: "scripts/verify/phase-4.ts"
      to: "scripts/restore.ts"
      via: "child_process spawn of `npm run restore --`"
      pattern: "(npm run restore|tsx scripts/restore)"
    - from: "scripts/verify/phase-4.ts"
      to: "scripts/lib/{ssh,config}.ts"
      via: "import statements"
      pattern: "from \"\\.\\./lib/(ssh|config)\""
    - from: "scripts/verify/phase-4.ts"
      to: "git CLI (ls-remote)"
      via: "execSync via runCapture"
      pattern: "git ls-remote"
---

<objective>
Implement `scripts/verify/phase-4.ts` (D-05) — the per-phase executable lock for ROADMAP Phase 4 (Restore). One-shot, fail-fast, exit 0 only on full pass. Uses the helper from plan 04-01 internally — does not duplicate the restore dance.

Asserts both RESTORE-01 (workflow runs end-to-end) and RESTORE-02 (refs preserved, via D-02 sorted-ls-remote byte-equality check).

Output: `scripts/verify/phase-4.ts` + `verify:phase-4` npm script.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/phases/04-restore/04-CONTEXT.md
@.planning/phases/04-restore/04-01-restore-helper-PLAN.md
@scripts/verify/phase-1.ts
@scripts/lib/ssh.ts
@scripts/lib/config.ts
@scripts/restore.ts

<interfaces>
<!-- From scripts/lib/config.ts (after plan 04-01): -->
import { loadConfig, loadDropletInfo, bail, type Config, type DropletInfo } from "../lib/config";
// Config now has: restoreTestRepo?: string

<!-- From scripts/lib/ssh.ts (already shipped): -->
import { sshFlags, runVisible, runCapture, expandHome } from "../lib/ssh";

<!-- Helper from plan 04-01: invoked as a child process so we exercise the
     same code path the operator uses. Do NOT import its module-level code. -->
//   spawnSync("npm", ["run", "restore", "--", `${owner}/${repo}`, tempTargetDir], { stdio: "inherit" })

<!-- Mirror path convention: ${cfg.backupDir}/${owner}_${repo}.git -->
</interfaces>
</context>

<rationale>
**Why ls-remote sorted diff (D-02 resolution):** D-02 left the choice to the planner between `git ls-remote` SHA diff and `git rev-list --objects --all | sort | sha256sum` (full object-graph hash). We pick ls-remote because:
  1. Standard git, no temp objects on disk besides the restored clone itself.
  2. Wall-time is one network round-trip to the droplet plus one local ls-remote on the restored clone — bounded, fast.
  3. RESTORE-02 says "branches, tags, and refs" — ls-remote returns exactly those (name + SHA), in one shot.
  4. Full object-graph hash would also catch packfile-internal corruption, but git clone --mirror's transfer is already verified by git's pack-objects checksum, and any corruption would surface as a clone failure in the helper, not as a silent ref mismatch.

The diff is `sorted-droplet-ls-remote === sorted-restored-ls-remote` (byte-equal after sort). Any extra ref, missing ref, or SHA mismatch fails the assertion with a message naming the count delta and the first 3 differing lines.

**Why no self-push assertion (D-03 resolution):** D-03 offered two interpretations of RM SC#2's "push a new commit locally": (a) restored clone pushes to a throwaway local bare → proves clone integrity, or (b) drop the push assertion entirely. We pick (b). Reasoning:
  - The ls-remote sorted-equality assertion above proves the restored clone has EXACTLY the same refs as the droplet mirror. If refs match by SHA, the underlying objects match by content (git is content-addressable). A push to a throwaway bare would only verify that the restored repo's pack format is loadable — which `git clone` already does as part of producing the working clone.
  - A self-push assertion has a non-zero false-positive risk (e.g. local disk space, file permissions on the throwaway bare) for zero added signal over ls-remote.
  - Document the choice in the verify script's top-of-file comment so a future reader does not "fix" it by adding a self-push round-trip.

**Why invoke helper as child process, not via direct import:** The operator runs `npm run restore -- …` from a shell. If the verify script imports and calls the helper's main function directly, we test a different code path (no argv parsing, no npm-script env). Spawning matches what the operator does and surfaces any package.json wiring bug as a verify failure rather than a silent helper-only success.

**Wall-clock cap (Claude's discretion per CONTEXT):** Total verify wall-clock budget = clone time of the configured restoreTestRepo + one local ls-remote + one ssh ls-remote against droplet. For a small repo (CONTEXT suggests dotfiles-sized) this is sub-minute. We do NOT enforce a hard timeout — if the operator picked a 5-GB monorepo as their test repo, that is a config choice, not a verify-script defect. Document in the script header that "test repo too big" looks like a multi-minute verify, and the operator should pick a smaller restoreTestRepo if that bothers them.

**Why no lock acquire on droplet:** Restore READS mirrors via git clone, which uses pack-objects read-side. The droplet's backup script (`/var/lock/github-backup.lock`) protects against concurrent WRITES, not reads. Git's own packfile semantics handle concurrent read-vs-write on the bare. Document this in the script header (CONTEXT.md "Established Patterns" notes the same).
</rationale>

<tasks>

<task type="auto">
  <name>Task 1: Implement scripts/verify/phase-4.ts</name>
  <files>scripts/verify/phase-4.ts</files>
  <action>
Create `scripts/verify/phase-4.ts`. Read `scripts/verify/phase-1.ts` top 50 lines first to mirror import style + `assert(cond, msg)` helper + fail-fast contract.

Top-level flow:

1. File header (top comment block, before imports):
   ```
   /**
    * scripts/verify/phase-4.ts
    *
    * Per-phase executable verification for ROADMAP Phase 4 (Restore).
    * Asserts RESTORE-01 (workflow runs) and RESTORE-02 (refs preserved).
    *
    * Decisions captured in .planning/phases/04-restore/04-CONTEXT.md:
    *  - D-01: test repo selection via config.restoreTestRepo (optional;
    *    bails loud if unset)
    *  - D-02: ref-equivalence via sorted `git ls-remote` byte-equality
    *    between droplet mirror and restored clone (NOT vs github.com)
    *  - D-03: no self-push assertion — ls-remote already proves
    *    byte-equivalent refs; self-push adds no signal
    *  - D-04: invokes `npm run restore` (plan 04-01) — does not
    *    duplicate the restore dance
    *  - D-06: on failure, leaves temp restore dir intact and prints path
    *
    * No droplet lock acquired — restore is read-only; git pack-objects
    * is read-safe vs `remote update --prune` (CONTEXT.md "Established
    * Patterns"). Do not "fix" this by adding a lock-acquire step.
    *
    * Usage:
    *   npm run verify:phase-4
    */
   ```

2. Imports:
   ```ts
   import * as fs from "fs";
   import * as os from "os";
   import * as path from "path";
   import { spawnSync } from "child_process";
   import { loadConfig, loadDropletInfo, bail } from "../lib/config";
   import { sshFlags, runCapture, expandHome } from "../lib/ssh";
   ```

3. `assert(cond, msg)` helper — copy-paste verbatim from `scripts/verify/phase-1.ts` lines 41–47. CONTEXT.md "Reusable Assets" says inline duplication is fine for Phase 4 (matches Phase 1 surgical-changes posture). Do NOT introduce a shared `scripts/lib/assert.ts` — defer until a third verify script needs it.

4. Load config + droplet info:
   ```ts
   const cfg = loadConfig();
   const info = loadDropletInfo();
   ```

5. **Pre-flight (Group 0):** Assert `cfg.restoreTestRepo` is set (D-01).
   - If unset, `bail("config.restoreTestRepo is not set. Set it to a \"<owner>/<repo>\" you have a mirror of on the droplet.")`. Use `bail`, not `assert`, so the message is the loud red box rather than a `✗` line.
   - If set, log `✓ config.restoreTestRepo === "${cfg.restoreTestRepo}"`.
   - Parse `[owner, repo] = cfg.restoreTestRepo.split("/")`. Re-validate the slug regex one more time (defence in depth: config.json could have been hand-edited after loadConfig's check, e.g. if loadConfig is bypassed in a future entry point).

6. **Group 1 — Restore runs (RESTORE-01):**
   - Create a fresh tempdir for the restored working clone: `const restoreRoot = fs.mkdtempSync(path.join(os.tmpdir(), "github-backup-verify-phase-4-"));`
   - Target dir = `path.join(restoreRoot, "working")` (do NOT pre-create; restore.ts will create it via git clone).
   - Print: `   Restoring ${cfg.restoreTestRepo} into ${target}…`
   - Spawn: `const r = spawnSync("npm", ["run", "restore", "--", cfg.restoreTestRepo!, target], { stdio: "inherit", env: process.env });`
   - On non-zero `r.status`: leave restoreRoot on disk per D-06, print its path, `process.exit(1)`. Use `assert(r.status === 0, …)` so the error format matches Phase 1.

7. **Group 2 — Refs match (RESTORE-02 via D-02):**

   **Why bare-to-bare and not bare-to-working-clone:** `git clone <bare-mirror>` produces a *working clone* whose refs live under `refs/heads/<checked-out-branch>` plus `refs/remotes/origin/*` for the rest. The droplet mirror is a *bare mirror* whose refs all live under `refs/heads/*`. Comparing the two namespaces directly would always diff on prefix, even with byte-identical SHAs. Instead, compare the droplet bare mirror against the intermediate local bare mirror that the helper from plan 04-01 leaves in the OS tempdir — both are bare, same namespace shape, direct sorted-line equality works.

   The helper's local bare mirror path is `<os-tempdir>/github-backup-restore-XXXXXX/<owner>_<repo>.git` (from plan 04-01 task 2 step 5). To locate it deterministically inside verify: the helper currently chooses its own tempdir name. To avoid making verify scrape stdout of the spawned helper for that path, change the helper-invocation contract slightly:

   - **Inter-plan contract addendum:** Have the helper print its local-bare-mirror absolute path on stdout as a single line `RESTORE_LOCAL_MIRROR=<abs-path>` on success (before its final summary), and have verify:phase-4 spawn the helper with `stdio: ["inherit", "pipe", "inherit"]`, capture stdout, and parse out the `RESTORE_LOCAL_MIRROR=` line via a regex.
   - The print line goes BEFORE the existing `✓ Restored …` summary so the regex anchors are predictable. Add this requirement to plan 04-01's task 2 step 8 if it is not already there (the planner reviewing this gap should bounce back to 04-01 with the addendum). If executing 04-01 BEFORE 04-02 happens to land the helper without the marker line, 04-02 task 1 will need to add it as a one-line patch to scripts/restore.ts as part of this task — flag it then. The contract is mandatory; the question is only which plan's execution adds the print statement.

   With the local-mirror path resolved:

   ```ts
   const mirrorPath = `${cfg.backupDir}/${owner}_${repo}.git`;
   const remoteLs = runCapture(
     `ssh ${sshFlags(cfg.sshKeyPath)} ${cfg.sshUser}@${info.ip} 'git -C "${mirrorPath}" for-each-ref --format="%(objectname) %(refname)" | sort'`
   );
   const localLs = runCapture(
     `git -C "${localBareMirrorPath}" for-each-ref --format="%(objectname) %(refname)" | sort`
   );
   ```

   - Sanity: assert both outputs are non-empty.
   - Diff via two Sets as before:
     ```ts
     const remoteSet = new Set(remoteLs.split("\n").filter((l) => l.length));
     const localSet = new Set(localLs.split("\n").filter((l) => l.length));
     const remoteOnly = [...remoteSet].filter((l) => !localSet.has(l));
     const localOnly = [...localSet].filter((l) => !remoteSet.has(l));
     ```
   - Assert `remoteOnly.length === 0 && localOnly.length === 0`. Failure message names counts + first 3 diffs as in the original plan body.

8. **Group 3 — Both kinds of refs present (sanity belt-and-braces for RESTORE-02):**
   - This is a CHEAP additional check: assert the restored clone has at least one entry matching `refs/heads/` AND at least one matching `refs/tags/`. If a repo has zero tags upstream, the tag check is vacuous — but configure that out by docs ("pick a restoreTestRepo with at least one tag for full coverage"; bail with a clear hint if zero tags, asking operator to pick a different test repo or accept partial coverage).
   - Concrete: parse localSet for branch + tag presence. If `[...localSet].some((l) => l.includes("refs/heads/"))` is false, bail. If no `refs/tags/`, print a yellow warning ("⚠ restoreTestRepo has no tags — tag-preservation coverage is vacuous; pick a tagged repo for full RESTORE-02 coverage") but DO NOT fail. Document this in the script header.

9. **Cleanup on success:**
   - `fs.rmSync(restoreRoot, { recursive: true, force: true });`
   - Final: `console.log("\n✅ verify:phase-4 PASS");`
   - `process.exit(0);` (explicit).

10. Make the file directly runnable: `#!/usr/bin/env node` shebang.

**Read first:** Read scripts/verify/phase-1.ts in full to learn the existing fail-loud + assert helper + sshFlags wiring style. Match it exactly.

  </action>
</task>

<task type="auto">
  <name>Task 2: Wire npm run verify:phase-4</name>
  <files>package.json</files>
  <action>
Edit `package.json`:
1. Inside `"scripts"`, add `"verify:phase-4": "tsx scripts/verify/phase-4.ts"` after the existing `"verify:phase-1"` entry. Place it after the `restore` script that plan 04-01 added.
2. Verify by running `npm run verify:phase-4` with no `restoreTestRepo` set in config.json — expected: bail with the loud "config.restoreTestRepo is not set" message from task 1 step 5.
  </action>
</task>

</tasks>

<verification>
1. `npx tsc --noEmit` exits 0 with the new file in tree.
2. `npm run verify:phase-4` with `restoreTestRepo` unset (or removed) in config.json exits non-zero with the loud "config.restoreTestRepo is not set" bail.
3. `npm run verify:phase-4` with `restoreTestRepo` set to a real mirrored repo on the configured droplet AND a live droplet up exits 0 and prints `✅ verify:phase-4 PASS`. Cleanup leaves no temp dir on success.
4. Force a ref mismatch (e.g. point `restoreTestRepo` at a repo whose mirror was deleted manually on the droplet): `npm run verify:phase-4` exits non-zero with the "ref mismatch" message naming counts + first 3 diffs.
5. Force a clone failure (e.g. point `restoreTestRepo` at `owner/repo-that-does-not-exist`): `npm run verify:phase-4` exits non-zero, leaves the temp dir on disk, and prints its path.
6. Live-droplet verify is the ROADMAP §Phase 4 success-criteria gate; passing all 5 checks above closes the Phase 4 lock.

Pass = all 6 checks pass.
</verification>

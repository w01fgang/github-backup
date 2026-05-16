---
phase: 04-restore
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - scripts/lib/config.ts
  - scripts/restore.ts
  - package.json
  - config.example.json
autonomous: true
requirements:
  - RESTORE-01
  - RESTORE-02

must_haves:
  truths:
    - "Operator runs `npm run restore -- <owner>/<repo> <target-dir>` and gets a working clone with all branches and tags preserved"
    - "Helper derives droplet mirror path as `${backupDir}/${owner}_${repo}.git` — same convention as droplet/github-backup.sh, never a separate scheme"
    - "Helper fails loud with a named error if config.json is missing, droplet info is missing, target dir already exists, or the SSH clone fails"
    - "Config type carries optional `restoreTestRepo` field that verify:phase-4 reads; bail message points operator at the field when unset"
    - "Restore is read-only against the droplet — no lock acquire, no write attempt back to mirror (one-way data flow constraint from CONTEXT.md domain block)"
  artifacts:
    - path: "scripts/restore.ts"
      provides: "Operator-facing `npm run restore -- <owner>/<repo> <target>` entry that produces a working clone (not bare mirror) at <target> with all refs preserved"
      min_lines: 60
    - path: "scripts/lib/config.ts"
      provides: "Adds `restoreTestRepo?: string` field to Config interface (optional, no required-field check)"
    - path: "package.json"
      provides: "Adds `restore` npm script wired to tsx scripts/restore.ts"
    - path: "config.example.json"
      provides: "Documents the new `restoreTestRepo` field with a placeholder value"
  key_links:
    - from: "scripts/restore.ts"
      to: "scripts/lib/{ssh,config}.ts"
      via: "import statements"
      pattern: "from \"\\./lib/(ssh|config)\""
    - from: "scripts/restore.ts"
      to: "git CLI"
      via: "execSync via runVisible (clone --mirror) then runVisible (clone from local mirror)"
      pattern: "git clone"
---

<objective>
Add an operator-facing restore helper (D-04) plus the `restoreTestRepo` config plumbing (D-01) that the verify:phase-4 script in plan 03-02 will consume. Helper is the single source of truth for the restore dance — manual copy-paste from README and the verify script both invoke it.

Helper produces a working clone at `<target-dir>` with all branches + tags + refs intact (RESTORE-02). The two-step `git clone --mirror` then `git clone <local-mirror>` flow from the current README §Recovery is the proven path; we wrap it in TypeScript so the operator does not assemble it by hand and so verify:phase-4 has a deterministic shell-out surface.

Output: `scripts/restore.ts` + Config.restoreTestRepo + `npm run restore` + config.example.json doc.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/phases/03-restore/03-CONTEXT.md
@scripts/lib/config.ts
@scripts/lib/ssh.ts
@scripts/verify/phase-1.ts
@droplet/github-backup.sh
@README.md
@package.json

<interfaces>
<!-- From scripts/lib/config.ts (after this plan): -->
export interface Config {
  // existing fields …
  restoreTestRepo?: string; // e.g. "sumin/dotfiles" — consumed by scripts/verify/phase-4.ts
}

<!-- From scripts/lib/ssh.ts (already shipped, no change): -->
import { sshFlags, runVisible, runCapture, expandHome } from "./lib/ssh";

<!-- Mirror path convention from droplet/github-backup.sh line ~140:
       BACKUP_DIR="/opt/github-backups"
       <BACKUP_DIR>/<owner>_<repo>.git
     Derive in TypeScript exactly the same way. -->
</interfaces>
</context>

<rationale>
**Why a TypeScript helper instead of README-only copy-paste (D-04):** The manual sequence is three commands (`git clone --mirror`, `git clone <local-mirror>`, optional `remote set-url`), each with a path the operator has to assemble (`<owner>_<repo>.git`, droplet IP, target dir). Single mistake = silent wrong-repo restore. The helper centralises the path derivation, fails loud on every error, and gives verify:phase-4 a single function-shaped target instead of duplicating the dance. Phase 1 D-04 precedent: every operator-facing command is a `tsx` script under `scripts/` wired through `npm run`.

**Why `restoreTestRepo` is optional (D-01):** Operator's real droplet may be unconfigured for the restore-test repo at this moment — but the helper itself must work standalone (operator restoring a real repo does not need restoreTestRepo set). Only verify:phase-4 requires the field; the field's bail lives in plan 03-02.

**Why no push-back from local to anything (D-domain / D-03):** Backups are one-way `github.com → droplet`. The restored working clone has no `origin` we keep pointing at the droplet — that would create an illusion of bidirectional sync. The helper leaves `origin` pointing at the local bare mirror (output of `git clone <local-mirror>`); operator can `git remote set-url` to github.com manually for everyday work (README will document this). Helper itself does NOT auto-rewrite origin to github.com because we do not know whether the operator's intent is "work locally against my mirror" or "rehydrate github.com" — those have different right-answers, and choosing one silently mis-serves the other.

**Why two-step (mirror clone + working clone) instead of one-step `git clone <user>@<ip>:<path>`:** A direct `git clone <ssh-url>` from the droplet produces a working clone whose origin points at the droplet — which the operator will hit if they ever `git pull`, surfacing failures (droplet is read-only, no fetch hook). The two-step path produces (a) a portable local bare mirror that survives droplet teardown, and (b) a working clone whose origin is the LOCAL bare mirror — failures in `git pull` then surface at "I should rerun restore" rather than "the droplet is broken". This matches the existing README §Recovery sequence (lines 268–278); we are wrapping it, not re-inventing it.

**Why `verify:phase-4` and not `verify:phase-3`:** CONTEXT.md was written 2026-05-10 referring to "Phase 3" because that was the roadmap position pre-reorder. STATE.md (2026-05-11) records the reorder: Restore is now ROADMAP phase 4. The verify-script name follows the ROADMAP number (Phase 1 precedent: `scripts/verify/phase-1.ts`), so the script is `scripts/verify/phase-4.ts` and the npm script is `verify:phase-4`. Plan filenames keep the `03-` directory-prefix to match dir name `03-restore` (Phase 1 precedent: dir prefix matches plan filename prefix).
</rationale>

<tasks>

<task type="auto">
  <name>Task 1: Add restoreTestRepo to Config type</name>
  <files>scripts/lib/config.ts, config.example.json</files>
  <action>
1. Edit `scripts/lib/config.ts`:
   - Add `restoreTestRepo?: string;` to the `Config` interface after `tags?: string[];` (keep alphabetical-by-grouping is not used elsewhere, just append cleanly).
   - Do NOT add it to `REQUIRED_FIELDS` — it is optional. Verify:phase-4 (plan 03-02) handles the missing-field bail with its own message.
   - Do NOT add it to `SHELL_SAFE_FIELDS` — the field value is interpolated as part of a path inside scripts/restore.ts via `git clone` argument, which uses double-quote wrapping. But: ADD a single inline validation inside `loadConfig` AFTER the SHELL_SAFE loop, gated on `cfg.restoreTestRepo !== undefined`: assert the value matches `/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/` (`<owner>/<repo>` shape). Bail with the same loud message style if it does not match. Rationale: protects against a malformed config.json passing the field through to a shell-interpolated git clone in restore.ts.

2. Edit `config.example.json`:
   - Read the current `config.example.json` first to learn its style.
   - Add a `restoreTestRepo` field at the bottom of the JSON object (above the closing `}`) with a placeholder value like `"your-owner/your-test-repo"` and a sibling comment-style key explaining it is OPTIONAL and only consumed by `npm run verify:phase-4`. If the file is strict JSON (no comments), inline the explanation in the README §Restore section in plan 03-03 instead and just add the field with a clearly-fake placeholder.

3. Run `tsx --check scripts/lib/config.ts` (or `npx tsc --noEmit` if --check unsupported) to verify no type errors.
  </action>
</task>

<task type="auto">
  <name>Task 2: Implement scripts/restore.ts</name>
  <files>scripts/restore.ts</files>
  <action>
Create `scripts/restore.ts`. Top-level flow:

1. Imports:
   ```ts
   import * as fs from "fs";
   import * as path from "path";
   import { loadConfig, loadDropletInfo, bail } from "./lib/config";
   import { sshFlags, runVisible, expandHome } from "./lib/ssh";
   ```

2. CLI argument parsing (no library — keep it dependency-zero, matches Phase 1 convention):
   - Expect exactly two positional args after the script name: `<owner>/<repo>` and `<target-dir>`.
   - If missing or extra, bail with usage: `Usage: npm run restore -- <owner>/<repo> <target-dir>`.
   - Validate `<owner>/<repo>` matches `/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/`. Bail with named error if not.
   - Split into `owner`, `repo`.

3. Load config + droplet info:
   - `const cfg = loadConfig();` and `const info = loadDropletInfo();`.

4. Validate target:
   - If `path.resolve(targetDir)` already exists (`fs.existsSync`), bail loudly: `Target directory already exists: <abs-path>. Refusing to overwrite — pick a fresh path.`

5. Derive paths:
   - Remote mirror path: `${cfg.backupDir}/${owner}_${repo}.git` (matches droplet/github-backup.sh).
   - Local bare-mirror staging path: use `fs.mkdtempSync(path.join(os.tmpdir(), "github-backup-restore-"))` and put the mirror at `<tmpdir>/<owner>_<repo>.git`. Import `os` at the top. The mirror is intermediate — verify:phase-4 will optionally retain it; for the operator helper, we keep it inside tmpdir and DO leave it there on success (small, harmless, lets operator re-clone offline without re-hitting droplet).
   - Working clone path: `path.resolve(targetDir)`.

6. Step A — clone --mirror from droplet over SSH:
   - Build command: `git clone --mirror "${cfg.sshUser}@${info.ip}:${remoteMirrorPath}" "${localMirrorPath}"` where the SSH options come via `GIT_SSH_COMMAND="ssh ${sshFlags(cfg.sshKeyPath)}"` env-prefix (set as `${env} git clone …`). Reuse the exact sshFlags helper — do NOT re-derive flags.
   - Run via `runVisible(envPrefix + " " + cmd)`. runVisible throws on non-zero, which surfaces SSH or git failure with the full stderr.

7. Step B — clone working copy from local bare mirror:
   - `git clone "${localMirrorPath}" "${workingClonePath}"` via runVisible. No GIT_SSH_COMMAND needed (local clone). All tags + branches come along automatically because the source is a bare mirror.

8. Print success summary. **First stdout line on success MUST be the machine-readable mirror-path handshake** — plan 04-02's verify:phase-4 parses this line to locate the intermediate bare mirror for its bare-vs-bare ref-equivalence diff. Do not move or rename the prefix string; verify regex anchors on `^RESTORE_LOCAL_MIRROR=(.+)$`.

   ```
   RESTORE_LOCAL_MIRROR=${localMirrorPath}
   ✓ Restored ${owner}/${repo}
       working clone: ${workingClonePath}
       local mirror : ${localMirrorPath}  (intermediate, safe to delete)

       Inspect refs: git -C ${workingClonePath} branch -a && git -C ${workingClonePath} tag
       Re-point to github.com if desired: git -C ${workingClonePath} remote set-url origin https://github.com/${owner}/${repo}.git
   ```

9. Make the file directly runnable: `#!/usr/bin/env node` shebang at top, even though `tsx` is invoked via npm script — matches scripts/verify/phase-1.ts header.

**Do not implement:** `--force` flag, `--no-mirror-keep` flag, anything past the success path. Single-shot, fail-loud, single-purpose.

**Read first:** Read scripts/verify/phase-1.ts top 50 lines to learn the existing fail-loud style + import style + how it wires sshFlags + runVisible. Mirror that style exactly.

  </action>
</task>

<task type="auto">
  <name>Task 3: Wire npm run restore</name>
  <files>package.json</files>
  <action>
Edit `package.json`:
1. Inside `"scripts"`, add `"restore": "tsx scripts/restore.ts"` after the existing `"verify:phase-1"` entry, before the closing `}`.
2. Keep alphabetical-ish grouping consistent with what is there — currently it is roughly logical order (create → bootstrap → smoke → verify). Add `restore` AFTER `verify:phase-1` since it is a Phase 4 deliverable, but BEFORE the placeholder `verify:phase-4` which plan 04-02 will add later.

Verify by running `npm run restore -- bad/args/here 2>&1 | head -5` — expected: bail with the usage message from task 2 step 2. (No live droplet needed for this smoke; argument validation runs before loadConfig.)
  </action>
</task>

</tasks>

<verification>
1. `npx tsc --noEmit` exits 0 (types compile cleanly, including the new Config field).
2. `npm run restore` (no args) exits non-zero and prints `Usage: npm run restore -- <owner>/<repo> <target-dir>`.
3. `npm run restore -- foo/bar /tmp/somewhere-that-exists` (pre-create `/tmp/somewhere-that-exists`) exits non-zero with the named "Target directory already exists" message.
4. `npm run restore -- not-a-slug /tmp/restore-test` exits non-zero with the `<owner>/<repo>` regex bail.
5. `cat package.json | jq '.scripts.restore'` returns `"tsx scripts/restore.ts"`.
6. `grep restoreTestRepo scripts/lib/config.ts` shows the new field on the Config interface.
7. End-to-end restore against the live droplet is **deferred to plan 03-02**'s verify:phase-4 — this plan does not require the droplet to be up.

Pass = all 6 local checks pass; live-droplet path validated in 03-02.
</verification>
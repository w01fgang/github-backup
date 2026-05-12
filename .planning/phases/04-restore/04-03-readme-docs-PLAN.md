---
phase: 04-restore
plan: 03
type: execute
wave: 2
depends_on: ["04-01"]
files_modified:
  - README.md
autonomous: true
requirements:
  - RESTORE-01

must_haves:
  truths:
    - "README has a Restore section (replacing the existing §Recovery snippet) with two distinct, clearly-labelled flows per D-07"
    - "Flow 1: single-repo recovery using `npm run restore -- <owner>/<repo> <target>` (the everyday case)"
    - "Flow 2: GitHub-gone disaster path — explicit manual steps to push restored mirrors back to a fresh github.com repo + caveat that there is no v1 automation for this"
    - "README does not contradict the one-way mirror model — restore is droplet → local, never local → droplet"
    - "§Recovery is reconciled with §\"Clone a mirrored repo for local development\" (lines ~245–260): no duplicate restore-shaped instructions; cross-link or merge so the dev-clone path and the recovery path are clearly distinguished"
    - "Anchor URL `#recovery` is preserved (do not rename the section header) so any external links still resolve"
  artifacts:
    - path: "README.md"
      provides: "Updated §Recovery section with two-scenario structure (single-repo + github-gone) referencing `npm run restore` from plan 04-01; reconciled with §Clone-a-mirrored-repo-for-local-development"
  key_links: []
---

<objective>
Replace and extend the current README §Recovery section (lines ~264–278) to document the two restore scenarios required by D-07 (single-repo recovery + github-gone disaster recovery), pointing at the `npm run restore` helper that plan 04-01 ships. Reconcile with the overlapping §"Clone a mirrored repo for local development" (lines ~245–260) so the dev-clone path and the recovery path are not duplicated.

Output: README.md diff. No code, no scripts.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/phases/04-restore/04-CONTEXT.md
@.planning/phases/04-restore/04-01-restore-helper-PLAN.md
@README.md
@scripts/restore.ts

<interfaces>
<!-- The helper from plan 04-01:
       npm run restore -- <owner>/<repo> <target-dir>
     Produces: working clone at <target-dir>, intermediate bare mirror left in OS tempdir.
     Origin of working clone points at the local bare mirror, NOT at github.com.
-->

<!-- The dev-clone path (§"Clone a mirrored repo for local development", lines ~245–260):
       Direct `git clone <user>@<ip>:<path>` — origin points at droplet — for everyday
       offline work, not for disaster recovery. -->
</interfaces>
</context>

<rationale>
**Why two scenarios (D-07):** The "I lost my laptop, give me my repo back" case and the "github.com vanished, rehydrate my account" case have different shapes:
  - Single-repo recovery: one repo, working clone, done. Operator iterates if they need more.
  - GitHub gone: many repos, each needs a fresh github.com repo created, each needs a manual push from the restored mirror. There is no automation for this in v1 (CONTEXT.md deferred → "Automated rehydrate-to-github after restore"). README must spell out the manual path explicitly so an operator under DR pressure does not invent a wrong one.

Documenting both separately also drives the mental model: restore is droplet → local. Re-hydrating github.com is local → github.com. Two arrows, two scenarios.

**Why reconcile with §Clone-a-mirrored-repo-for-local-development:** That section (lines 245–260) shows `git clone <user>@<ip>:<path>` directly — a working clone whose origin points at the droplet. Useful for everyday offline work; misleading for DR (operator might assume `git pull` works after droplet goes away). Without explicit cross-linking, an operator skimming for "how do I restore" will land on §Clone-a-mirrored-repo and think they have done it. Fix: add a one-line note in §Clone-a-mirrored-repo pointing at §Recovery for the "I actually lost it" case, and a one-line note in §Recovery noting that for everyday-not-DR work the dev-clone path is simpler.

**Why keep the `#recovery` anchor:** STATE.md / PROJECT.md may eventually have external links into the README; the existing snippet has been there since project inception. Renaming the section breaks anchors. Keep the heading text exactly as `## Recovery` to preserve `#recovery`.

**What we explicitly do NOT document:**
  - Re-pushing restored content to the droplet (CONTEXT.md domain block: not a supported flow).
  - Bulk restore (`restore-all`) — CONTEXT.md deferred, Phase 5 territory.
  - Restore-from-DO-snapshot — CONTEXT.md deferred, future "off-droplet redundancy" phase.
  - Restore-time `git fsck` — CONTEXT.md deferred unless ref-equivalence (D-02) catches a bug class.

If a reader looks for any of those, they should land on a clear "not in v1; here is the manual workaround" line, not silence. The github-gone scenario covers the manual rehydrate workaround; the other three are silent-by-design (out of scope, no manual workaround needed for v1 single-operator + single-droplet posture).
</rationale>

<tasks>

<task type="auto">
  <name>Task 1: Rewrite README §Recovery section</name>
  <files>README.md</files>
  <action>
1. Read the current README.md in full (it is ~280 lines; full read is cheap and avoids surprises).

2. Locate the existing §Recovery section. Currently lines ~264–279:
   ```
   ## Recovery

   ### Restore a single repo from a mirror

   ```bash
   # 1. Pull the bare mirror from the droplet
   git clone --mirror root@DROPLET_IP:/opt/github-backups/myorg_myrepo.git ~/myrepo.git

   # 2. Clone a working copy from the local mirror
   git clone ~/myrepo.git ~/myrepo-recovered

   # 3. Point to the original upstream (optional)
   cd ~/myrepo-recovered
   git remote set-url origin https://github.com/myorg/myrepo.git
   git fetch origin
   ```
   ```

3. Replace the entire §Recovery section (from `## Recovery` heading down to the line BEFORE the next `##` heading, if any — otherwise to EOF) with the following structure:

   ```markdown
   ## Recovery

   The droplet mirrors are a read-only sink. Recovery flows are one-way:
   `droplet → local`. There is no automated path to push local changes back
   to the droplet, and no automated path to re-hydrate github.com after a
   loss — both are manual operator actions, scoped to v1 by design.

   ### Scenario 1: Single-repo recovery (everyday case)

   You lost your laptop, want to work offline, or just want a fresh working
   clone of a backed-up repo on a new machine. Use the `restore` helper:

   ```bash
   npm run restore -- myorg/myrepo ~/myrepo-recovered
   ```

   The helper:

   1. Clones the bare mirror from the droplet (via SSH, using
      `config.json` `sshKeyPath`) into an OS temp directory.
   2. Clones a working copy from that local bare mirror into the target
      directory you passed.
   3. Leaves the temp bare mirror in place (small, safe to delete, lets
      you re-clone offline without hitting the droplet again).

   The restored working clone's `origin` points at the local bare mirror,
   not at github.com or the droplet. To repoint at github.com for everyday
   work:

   ```bash
   cd ~/myrepo-recovered
   git remote set-url origin https://github.com/myorg/myrepo.git
   git fetch origin
   ```

   ### Scenario 2: GitHub is gone / account compromised

   The github.com side of your data is unrecoverable (account locked, org
   deleted, a security incident forces a fresh start). You want to push
   your restored mirrors back up to a NEW account or git host. This is a
   manual operator-driven flow — there is no `restore-and-rehydrate`
   automation in v1, by design. For each repo:

   1. Restore the bare mirror locally (re-use Scenario 1's helper, or pull
      `~/myrepo.git` from the OS tempdir the helper already wrote it to).
   2. Create a brand-new empty repo on the destination (github.com under a
      new account, GitLab, Codeberg, self-hosted, etc.). Do NOT enable any
      auto-init template — the new repo must be empty.
   3. Push the bare mirror, including all branches and tags:
      ```bash
      cd ~/myrepo.git  # the bare mirror, NOT the working clone
      git push --mirror https://github.com/new-owner/myrepo.git
      ```
   4. Repeat per repo. If you have many repos, scripting this loop is on
      you — v1 single-operator scope does not ship a bulk command. Iterate
      over `ls /opt/github-backups/*.git` on the droplet to enumerate.

   **Caveat:** `--mirror` push rewrites every ref on the destination. Only
   use this against a NEW empty repo. Do not run it against a repo someone
   else is also pushing to.

   ### Verifying restore correctness

   `npm run verify:phase-4` runs the helper against the repo named in
   `config.json` `restoreTestRepo` and asserts the restored clone's refs
   match the droplet mirror byte-for-byte (sorted `git for-each-ref`
   diff). Use it as a smoke test after any change to the restore path or
   the droplet mirror layout.

   See also: [Clone a mirrored repo for local development](#clone-a-mirrored-repo-for-local-development)
   for the lighter-weight "I just want offline access, not full recovery"
   case (single direct `git clone`, origin pointed at the droplet).
   ```

4. Locate the existing §"Clone a mirrored repo for local development" subsection (currently lines ~245–254 under whatever parent heading it lives under — likely a §Connect or §Use section above §Recovery). Add a one-line note at the TOP of that subsection, immediately after its heading:

   ```markdown
   > For full disaster recovery (or to produce a portable bare mirror that survives droplet teardown), use the helper described in [Recovery → Scenario 1](#scenario-1-single-repo-recovery-everyday-case) instead.
   ```

   This is the cross-link. The dev-clone block below it stays as-is — it serves the offline-work case which is genuinely simpler than going through the helper.

5. Sanity-check the §"Clone a bare mirror (re-mirror to another machine)" subsection (lines ~256–260). That snippet is `git clone --mirror …`, which overlaps with what Scenario 1's helper does internally. Decision: leave it as-is — it documents the manual path for someone who does not want the helper (e.g. one-off forensic look at a mirror). No cross-link needed; the helper section above already says it does this internally.

6. **Do not** touch any other section of the README. Surgical-changes posture (CLAUDE.md Rule 3).

7. Verify the final file renders cleanly (anchors work, code fences are balanced). Spot-check by previewing with `grip README.md` or any markdown previewer the operator has. If `grip` is not available, just `grep -n "^##" README.md` to confirm heading structure is intact.

  </action>
</task>

</tasks>

<verification>
1. `grep -n "## Recovery" README.md` returns exactly one match.
2. `grep -n "npm run restore" README.md` returns at least two matches (Scenario 1 + Scenario 2 reference) — confirms the helper is documented.
3. `grep -n "git push --mirror" README.md` returns one match inside Scenario 2 — confirms the github-gone path is documented.
4. `grep -n "Scenario 1\|Scenario 2" README.md` returns the two scenario subheadings.
5. `grep -n "verify:phase-4" README.md` returns one match — confirms the verify script is mentioned.
6. `grep -n "Clone a mirrored repo for local development" README.md` returns one match — confirms the existing subsection still exists and was not accidentally removed.
7. `grep -n "#recovery" README.md` (or `## Recovery` heading at column 0) confirms the anchor target is preserved.
8. Manual visual check: scenarios read in a natural order, code fences balance, no orphaned subheadings left from the old section.

Pass = all 7 grep checks + manual visual check pass.
</verification>

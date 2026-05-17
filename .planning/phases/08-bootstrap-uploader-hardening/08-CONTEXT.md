# Phase 8: Bootstrap uploader hardening - Context

**Gathered:** 2026-05-17
**Status:** Ready for planning

<domain>
## Phase Boundary

Make `scripts/bootstrap-droplet.ts` fail loudly *before any SSH* when a required droplet artifact is missing locally, and make `scripts/create-droplet.ts` reconcile **outbound** firewall rules with the same drift-detection it already applies to inbound. README documents both the droplet file manifest (MANIFEST-03) and the complete firewall ruleset (FIREWALL-02). 5 requirements: MANIFEST-01, MANIFEST-02, MANIFEST-03, FIREWALL-01, FIREWALL-02.

**In scope:**
- A required-file manifest shared by the uploader and a README-generator.
- Replacing the two glob-based upload loops in `scripts/bootstrap-droplet.ts:289-322` with manifest-driven enumeration + pre-flight existence checks.
- Extending `scripts/create-droplet.ts` so the existing reconcile pattern (lines 153-200) also covers outbound rules.
- Two managed README sections (manifest + firewall ruleset) and the tooling to keep one of them in sync.
- A native git pre-commit hook + a new `.github/workflows/sync-check.yml` CI workflow — deliberate scope expansion to enforce manifest/README parity.

**Out of scope:**
- Droplet-side fail-loud beyond the existing webhook trio check at `droplet/bootstrap.sh:200-215` (Phase 7 D-09 already routed bootstrap-side defence to *uploader-side* pre-flight; do not duplicate).
- Removing or rewriting Phase 7's verify:phase-7 script.
- Changing inbound firewall reconcile semantics (only refactored to share a helper).
- Webhook-listener changes (those belong to Phase 9).
- Adding a JSON manifest consumable from bash (rejected — see Deferred).

</domain>

<decisions>
## Implementation Decisions

### Manifest source of truth

- **D-01 (MANIFEST-LOC):** The required-file manifest lives in a new file `scripts/lib/droplet-manifest.ts` exporting a typed array. Convention matches existing `scripts/lib/` modules (`ssh.ts`, `config.ts`). Consumers: `scripts/bootstrap-droplet.ts` (now), a future `scripts/verify/phase-8.ts`, and a new `scripts/sync-readme-manifest.ts`. Rejected alternatives: inline const in `bootstrap-droplet.ts` (no reuse); `droplet/MANIFEST.json` parsed by bash (would require `jq` dep on bootstrap path and a JSON-schema validation surface — see Deferred).
- **D-02 (MANIFEST-SHAPE):** Tiered schema with two top-level arrays: `required` and `optional`. Required-miss → uploader bails pre-flight. Optional-miss → uploader logs a warning and continues. Each entry shape:
  ```ts
  type ManifestEntry = {
    path: string;        // project-root relative, e.g. "droplet/sync-one-repo.sh"
    purpose: string;     // one-line human description for the README table
    phase: string;       // owning phase short code, e.g. "phase-6", "phase-7"
    destSubdir: string;  // relative to backupDir, e.g. "" (root) or "lib/"
    chmodExec: boolean;  // whether the file needs +x on the droplet
  };
  ```
  Explicit `destSubdir` removes the implicit "droplet/lib/ goes to lib/" rule that the current loops bake in; future phases can drop artifacts in arbitrary sub-paths without editing the uploader.

### Upload strategy

- **D-03 (UPLOAD-ENUM):** Drop both `readdirSync` glob loops at `scripts/bootstrap-droplet.ts:289-322`. The new flow has three steps, in order:
  1. **Pre-flight (no SSH yet):** iterate `manifest.required`; for each entry, `fs.existsSync(entry.path)` — first miss → `bail("missing required artifact: <path>")`. This satisfies MANIFEST-01's "exits non-zero **before** opening an SSH session" requirement directly.
  2. **Upload required:** inside the existing SSH session, iterate `manifest.required` again and `scpFile` to `${backupDir}/${entry.destSubdir}${basename(entry.path)}`. `mkdir -p` any destSubdir before scp'ing into it (current code already does this for `lib/`).
  3. **Upload optional:** iterate `manifest.optional`; for each entry, `fs.existsSync` check → if missing, `console.warn("⚠ optional artifact not shipped: <path>")`; otherwise scp.
- **D-04 (UPLOAD-BAIL):** Fail-fast on the **first** missing required entry, not aggregate. Matches the existing `bail()` pattern from `scripts/lib/config.ts` (used throughout `bootstrap-droplet.ts` already). Bail message format: `missing required artifact: <path>` — exactly as worded in ROADMAP Phase 8 success criterion #2.

### README sync

- **D-05 (README-GEN):** A new TypeScript script `scripts/sync-readme-manifest.ts` reads `scripts/lib/droplet-manifest.ts`, renders a Markdown table (columns: Path | Purpose | Phase | Tier), and replaces the content between two HTML-comment markers in `README.md`:
  ```
  <!-- BEGIN: droplet-manifest -->
  ...generated table...
  <!-- END: droplet-manifest -->
  ```
  Single source of truth = `droplet-manifest.ts`. The script is intentionally idempotent: re-running with no manifest change produces a no-op `git diff`.
- **D-06 (README-FIREWALL):** The Firewall ruleset section (FIREWALL-02) is **hand-maintained**, not auto-generated. The canonical ruleset is short, static, and already encoded as literal `expected` arrays in `create-droplet.ts`; auto-generating it is overkill. README documents it in prose + a small table; if the canonical set ever changes, both the TS code and the README rev together in one PR.
- **D-07 (README-TRIGGER):** Sync runs in two places.
  - **Pre-commit:** runs `npm run sync:readme` then `git diff --exit-code README.md`. Non-empty diff → reject commit with `error: README.md droplet-manifest section is stale; run 'npm run sync:readme' and re-stage`.
  - **CI:** `.github/workflows/sync-check.yml` does the same diff-check on every push/PR. Pre-commit catches local edits; CI catches `--no-verify` bypasses.
- **D-08 (HOOK-TOOL):** Native bash hook, no new npm deps. The hook script is committed to `scripts/git-hooks/pre-commit`. A `prepare` npm script (runs on `npm install`) copies it to `.git/hooks/pre-commit` and `chmod +x`s it. Rejected: husky (extra dep + auto-install magic in `prepare`); simple-git-hooks (extra dep for negligible benefit over a 30-line bash script).
- **D-09 (CI-INTRO):** Introducing `.github/workflows/` as part of Phase 8 is a deliberate, surfaced scope expansion. Phase 8 ships exactly one workflow file: `sync-check.yml` running `npm ci && npm run sync:readme && git diff --exit-code README.md`. Future phases may extend this (e.g. lint/typecheck workflow), but Phase 8 does not pre-build a generic CI scaffold.

### Firewall outbound reconcile

- **D-10 (OUTBOUND-STRICT):** Outbound reconcile is **strict canonical-only**: ensure the canonical 3 outbound rules (tcp/all → 0.0.0.0/0,::/0; udp/all → 0.0.0.0/0,::/0; icmp → 0.0.0.0/0,::/0) are present; add missing ones via `doctl compute firewall add-rules --outbound-rules …`; leave any operator-added extras untouched. Matches the literal spec wording ("restore canonical") and avoids destructive removal of rules an operator may have added intentionally. Idempotency contract (success criterion #5): when all 3 canonical rules are already present, the reconcile path emits zero `doctl add-rules` calls.
- **D-11 (FW-REFACTOR):** Extract a shared reconcile helper from the existing inbound block (`scripts/create-droplet.ts:153-200`) before adding outbound. The helper takes a direction (`"inbound" | "outbound"`), the expected rule list, and the detail object (`detail.inbound_rules` vs `detail.outbound_rules` chosen by the helper). One match function, one diff-and-add loop, two call sites. Refactor lands first as a behaviour-preserving change (verifiable by re-running create-droplet against an existing firewall and getting only `✓ Rule already present` lines), then the outbound call site lands as a separate task to keep diffs reviewable.
- **D-12 (FW-LOG-FORMAT):** Reconcile log lines include a `[inbound]` / `[outbound]` prefix so operators reading the create-droplet output can distinguish which direction is being touched. Existing inbound messages (`✓ Rule already present: …` / `+ Adding rule: …`) gain the prefix as part of the refactor; this is a deliberate, minor UX break documented in the plan summary.

### Claude's Discretion

- Exact rendering of the README table (column order, alignment, whether to add a footer note pointing to `scripts/lib/droplet-manifest.ts`).
- Whether to add a `--check` flag to `scripts/sync-readme-manifest.ts` so the CI workflow can run `… --check` instead of `… && git diff` (cosmetic).
- Helper function name and signature for D-11 (e.g. `reconcileRules(direction, fw, expected)` vs `ensureRulesPresent(...)`).

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase definition + requirements

- `.planning/ROADMAP.md` §"Phase 8: Bootstrap uploader hardening" (lines 54-72) — goal, success criteria (6 items), depends-on, requirement IDs.
- `.planning/REQUIREMENTS.md` lines 15-19 — full text of MANIFEST-01/02/03, FIREWALL-01/02.

### Phase 7 carry-over (must read before touching droplet artifacts)

- `.planning/phases/07-droplet-artifact-shipping/07-CONTEXT.md` §"Deferred Ideas" + §"Decisions" — D-09 routes droplet-side fail-loud to Phase 8 uploader-side pre-flight. The note `2026-05-16-webhook-listener-files-optional-in-uploader-but-required-at-runtime` (frontmatter `resolves_phase: 8`) was deliberately folded into Phase 7 context for visibility only; implementation is here.
- `.planning/phases/07-droplet-artifact-shipping/07-01-SUMMARY.md` — what Phase 7 shipped (sync-one-repo.sh + lib helpers + verify:phase-7). Phase 8 must not break verify:phase-7.

### Code to be modified

- `scripts/bootstrap-droplet.ts` lines 289-322 — the two readdirSync glob loops being replaced by manifest-driven enumeration. Surrounding helpers (`scpFile`, `sshRun`, `bail`) stay as-is.
- `scripts/create-droplet.ts` lines 140-200 — inbound reconcile loop to be refactored into a shared helper.
- `scripts/create-droplet.ts` lines 210-215 — outbound rules currently only set at CREATE-time; the new reconcile call site lives in the existing-firewall branch (~line 200).
- `scripts/lib/config.ts` — `bail()` is the existing fail-loud primitive; reuse it, do not add a new one.
- `droplet/bootstrap.sh` lines 200-215 — existing server-side webhook trio check. Do **not** modify; Phase 8 makes its check redundant in the happy path but it stays as defence-in-depth.
- `README.md` — target file for both managed sections (droplet manifest + firewall ruleset). Inspect current structure before deciding where to insert the markers.

### Files to be created

- `scripts/lib/droplet-manifest.ts` (new) — manifest source of truth.
- `scripts/sync-readme-manifest.ts` (new) — README section renderer.
- `scripts/git-hooks/pre-commit` (new) — committed hook script.
- `.github/workflows/sync-check.yml` (new) — CI re-check.

### Build / packaging

- `package.json` — add `prepare` (copies hook), `sync:readme`, and (likely) `check:readme` scripts. Existing convention: `tsx scripts/<file>.ts`.

No additional external specs or ADRs — this phase is self-contained inside the github-backup repo.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets

- **`bail(msg)`** from `scripts/lib/config.ts` — the canonical fail-loud primitive. The pre-flight loop in `bootstrap-droplet.ts` must use this verbatim for MANIFEST-01 wording.
- **`scpFile(ip, user, key, src, dst)`** and **`sshRun(ip, user, key, cmd)`** — already defined in `bootstrap-droplet.ts`; the new manifest-driven loops reuse them. No new SSH wrapper needed.
- **`first<T>(jsonCmd)`** and **`runCapture(cmd)`** in `create-droplet.ts` — already used by the inbound reconcile. The extracted helper keeps using them.
- **`FirewallRecord` / `FirewallDetail` / `InboundRule` interfaces** in `create-droplet.ts:160-175` — need a parallel `OutboundRule` interface (or extend `FirewallDetail` with `outbound_rules?: OutboundRule[]`).

### Established Patterns

- **Standalone-per-phase verify runner** (Phase 7 D-09): if a verify:phase-8 script is added, it mirrors `scripts/verify/phase-7.ts` structure exactly — no shared verify-helpers module.
- **Fail-loud at boundaries via `bail()`** — already used throughout `bootstrap-droplet.ts` and `config.ts`. Pre-flight manifest check fits this idiom.
- **Idempotent reconcile** — inbound reconcile already follows the contract "zero `doctl add-rules` calls when expected set is fully present". The shared helper must preserve this for both directions.
- **Single-quoted SSH payloads on the command line** (phase-6/7 convention). N/A for Phase 8's pre-flight (no SSH), but still applies if any new SSH-touching code is added.

### Integration Points

- The uploader (`bootstrap-droplet.ts`) imports the manifest module; the README-sync script imports the same module; both are TypeScript with strict mode. Type changes to `ManifestEntry` propagate to both call sites at compile time.
- `package.json#prepare` runs on `npm install`. The hook-install logic must be idempotent (overwrite `.git/hooks/pre-commit` only if content differs, or just always overwrite — both acceptable; pick whichever is simpler).
- `droplet/bootstrap.sh` continues to run on the droplet after upload completes; it expects the same set of files at the same paths it does today. The manifest's `destSubdir` values MUST produce a layout identical to the current glob loops' output for backward compatibility (i.e. root files at `${backupDir}/`, `lib/*.sh` at `${backupDir}/lib/`).

</code_context>

<specifics>
## Specific Ideas

- README section markers must be HTML comments (so they render invisibly): `<!-- BEGIN: droplet-manifest -->` / `<!-- END: droplet-manifest -->`. Same convention if any future managed section is added.
- Pre-flight bail message format is locked: `missing required artifact: <path>` — required by ROADMAP success criterion #2.
- Outbound reconcile log lines use a `[outbound]` prefix; existing inbound lines gain `[inbound]` for symmetry (D-12).
- The hook-install `prepare` script must NOT fail when running in a non-git checkout (e.g. tarball install) — guard with `[ -d .git ]` or equivalent.

</specifics>

<deferred>
## Deferred Ideas

- **JSON manifest consumable from bash** (`droplet/MANIFEST.json` + `jq` in `droplet/bootstrap.sh`) — rejected for Phase 8 (extra runtime dep on droplet, JSON schema surface). If droplet-side defence beyond the existing webhook trio check is ever wanted, revisit this.
- **Full canonicalization of outbound rules** (remove operator-added extras) — discussed and rejected in D-10 for blast-radius reasons. If outbound drift in production becomes a recurring incident, revisit with a `--prune` flag opt-in.
- **Verify:phase-8 script** — not required by any success criterion. Could be added if Phase 10 UAT needs an automated assertion that the uploader bails pre-flight; otherwise the pre-commit + CI workflow plus a manual test (delete a manifest file, run bootstrap-droplet, observe non-zero exit) is sufficient.
- **Generic CI scaffold beyond `sync-check.yml`** — Phase 8 ships exactly one workflow file. Lint/typecheck/test workflows belong to their own infra phase.

</deferred>

---

*Phase: 8-bootstrap-uploader-hardening*
*Context gathered: 2026-05-17*

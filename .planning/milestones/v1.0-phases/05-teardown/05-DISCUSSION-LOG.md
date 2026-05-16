# Phase 4: Teardown / redeploy - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-05-10
**Phase:** 04-teardown
**Mode:** Autonomous (operator delegated /gsd-discuss-phase to Claude — no interactive Q&A)
**Areas discussed:** backup.env idempotency strategy, cron / scripts idempotency, destroy-script scope vs Phase 1 baseline, post-destroy assertion location, verify:phase-4 assertion design, destructive-verify safety gate, redeploy macro, README change scope

---

## Area 1 — `backup.env` re-bootstrap behavior

| Option | Description | Selected |
|--------|-------------|----------|
| Always overwrite (status quo) | `bootstrap-droplet.ts` keeps using `scpFile` unconditionally; re-run silently rotates `GITHUB_TOKEN` to whatever's in operator's current shell, even if shell var is empty | |
| Always preserve | Once `backup.env` exists on droplet, it is never overwritten by bootstrap; operator must SSH in to mutate | |
| Skip-if-exists with explicit `--rotate-env` opt-in | Default skip (preserve) when remote file exists; flag forces a fresh upload | ✓ |
| Three-way merge / diff prompt | Compare local-generated env vs remote, prompt operator on diffs | |

**Decision:** Skip-if-exists by default; `--rotate-env` flag forces overwrite. Captured as D-01 / D-02 / D-04 in CONTEXT.

**Notes:** The "always overwrite" status quo violates SC#1 ("does not clobber `backup.env`") on its face — the file IS clobbered, even when content is identical. "Always preserve" is too rigid for the legitimate token-rotation use case. Three-way diff is over-engineered for a single-operator system where the operator already knows what they want. Skip + opt-in matches how other config-management tooling handles "managed file with operator-overridable runtime state" and gives the operator a clear, single-flag mental model.

---

## Area 2 — Detection of "first-run vs re-run"

| Option | Description | Selected |
|--------|-------------|----------|
| Local-state probe | Check `.droplet.json` exists locally + add a `bootstrapped: true` field after first success | |
| Remote-file probe over SSH | `ssh ... 'test -f ${BACKUP_DIR}/backup.env'` and branch on exit | ✓ |
| Per-operator marker file in checkout | Write `.bootstrap-done` locally, branch on it | |

**Decision:** Remote-file probe over SSH. Captured as D-03.

**Notes:** Local-state probes are unreliable for this question — the source of truth for "is the droplet bootstrapped" is the droplet itself, not the local checkout. A teammate (theoretical, given current single-operator scope) or a re-cloned project tree would not have the local marker but the droplet would still be bootstrapped. SSH transport failures (exit 255) MUST bail loudly per Rule 12 — silently assuming "absent" would silently overwrite.

---

## Area 3 — Cron + droplet scripts idempotency

| Option | Description | Selected |
|--------|-------------|----------|
| Add new logic to bootstrap-droplet.ts | Compare hashes, conditional re-upload of each `*.sh` | |
| Lean on existing `# github-backup-managed` marker pattern | `install-cron.sh` already strips and re-appends; scripts always overwrite (intended) | ✓ |

**Decision:** Lean on existing pattern. Captured as D-05 / D-06 / D-07.

**Notes:** `droplet/install-cron.sh` lines 48–54 already implement strip-then-append against the `# github-backup-managed` marker — this means cron-line idempotency is already correct, and Phase 4's job is to ASSERT it (not modify it). The droplet `*.sh` scripts SHOULD be overwritten on every re-run because that is the operator's mechanism for shipping code changes; preserving them would defeat the bootstrap workflow. No code changes needed here for SC#1.

---

## Area 4 — Destroy-script scope vs Phase 1 baseline

| Option | Description | Selected |
|--------|-------------|----------|
| Rewrite from scratch in Phase 4 | Treat Phase 4 as the canonical destroy-script phase | |
| No changes; only verify | Phase 1 D-08 already pulled it forward; Phase 4 just asserts SC#2 + SC#3 | partial |
| Verify + minimal refinement (one optional addition) | Defer to verify:phase-4 to surface real gaps; permit adding ONE inline post-destroy assertion if planner judges warranted | ✓ |

**Decision:** Verify + minimal refinement. Captured as D-08, with an explicit Claude's-Discretion sub-decision on the inline post-destroy assertion.

**Notes:** `scripts/destroy-droplet.ts` already exists, has been hardened through NR-09 (firewall empty-list distinction), implements T-01-01-01 (refuse without `.droplet.json`), and implements T-01-01-02 (`--yes` for non-interactive). Rule 3 (surgical changes) says don't rewrite what isn't broken. The optional inline post-destroy assertion is a defensible add (immediate operator confidence even when verify isn't run) but also a defensible skip (verify covers it once). Planner's call.

---

## Area 5 — Safety gates on destroy

| Option | Description | Selected |
|--------|-------------|----------|
| `--force` mode bypassing the missing-`.droplet.json` refusal | Operator can destroy even if local state is gone | |
| Mirror-freshness gate (refuse if backup >N hours old) | Defends against accidental destroy of un-mirrored github.com state | |
| No new gates beyond Phase 1's | Existing `[y/N]` + `--yes` + refuse-without-`.droplet.json` is sufficient | ✓ |

**Decision:** No new gates. Captured as D-09 (no `--force`) and D-10 (no freshness gate).

**Notes:** `--force` would defeat the load-bearing safety check (T-01-01-01: never delete by name, only by id from `.droplet.json`). Mirror-freshness gate conflicts with the "I want a clean slate" use case (smoke runner's `--fresh` flag) and is justified only if backups were the source of truth — but PROJECT.md is explicit that github.com is the source of truth and the droplet is a one-way sink. Both gates captured in Deferred for revisit if a real loss scenario emerges.

---

## Area 6 — `verify:phase-4` assertion structure

| Option | Description | Selected |
|--------|-------------|----------|
| Single end-to-end smoke replay | Re-call smoke-test.ts with extra invariant checks woven in | |
| 3 groups: re-bootstrap, destroy, post-destroy | Minimum for SC#1 + SC#2 + SC#3 | |
| 6 groups: pre-conditions, env-preservation, cron-invariant, --rotate-env round-trip, destroy + post-destroy, refusal-without-`.droplet.json` | Full coverage of both positive and negative paths of all three SCs | ✓ |
| Property-based fuzz (re-run bootstrap N times, assert invariants every time) | Stronger but adds wall-clock and complexity | |

**Decision:** 6 assertion groups in fixed order. Captured as D-12.

**Notes:** Re-using smoke-test would re-implement provisioning each time and conflate Phase 1 coverage with Phase 4 — bad scoping. 3 groups would skip the negative-path tests (SC#2 requires "refuses if `.droplet.json` missing" to be proven, not assumed). Fuzz/property-based is overkill for this surface. The 6-group structure mirrors Phase 1's group-headers shape and gives one assertion group per success-criterion clause plus negative paths. Group 4 (`--rotate-env` round-trip) is env-gated to keep the script runnable without re-exporting `GITHUB_TOKEN`.

---

## Area 7 — `verify:phase-4` destructive-action safety

| Option | Description | Selected |
|--------|-------------|----------|
| No gate — verify runs immediately | Aligned with phase-1.ts (also sort-of-destructive: triggers a backup) | |
| Interactive `[y/N]` prompt | Forces human ack | |
| Required `--yes` flag (no interactive default) | CI-friendly, single-key escape for humans | ✓ |

**Decision:** Required `--yes` flag. Captured as D-13.

**Notes:** `verify:phase-4` is the only verify in v1 that destroys infrastructure (Phase 1 verify only triggers a backup; Phase 3 verify uses a temp dir). The cost of a misfire is hours of operator time. Interactive prompt is annoying in CI / batch contexts; required `--yes` is one keystroke for humans and one extra arg for automation, with zero ambiguity. Matches `destroy-droplet.ts`'s flag for consistency.

---

## Area 8 — Redeploy macro

| Option | Description | Selected |
|--------|-------------|----------|
| Ship `npm run redeploy` (destroy + create + bootstrap) | One-command operator UX | |
| Document the three-command sequence; no macro | Matches what smoke-test --fresh already does internally | ✓ (defer) |

**Decision:** Defer. Captured in Deferred Ideas.

**Notes:** The smoke runner already encapsulates this sequence via `--fresh`. A standalone `npm run redeploy` would be sugar — useful if real friction emerges, premature otherwise (Rule 2: simplicity first, no features beyond ask).

---

## Area 9 — README change scope

| Option | Description | Selected |
|--------|-------------|----------|
| New "Lifecycle" section with full prose | Detailed sub-sections per command | |
| Short paragraph in existing operator-commands area | Two paragraphs: bootstrap re-run safety + destroy finality | ✓ |
| No README change | Defer to next docs pass | |

**Decision:** Short paragraph. Captured as D-15.

**Notes:** The operator-facing commands are already documented; Phase 4's net-new is "bootstrap is safe to re-run" and "destroy is final and refuses without `.droplet.json`" — both are short observations that don't need a section heading. Phase 3 docs will be more substantial (restore is a new workflow); Phase 4 docs are command-reference shape.

---

## Claude's Discretion

The following sub-decisions were left to the planner per CONTEXT.md `### Claude's Discretion` block:

- D-08 sub: whether to add an inline post-destroy assertion to `destroy-droplet.ts` itself (in addition to `verify:phase-4`'s coverage)
- D-13 sub: exact flag name for verify's destructive-confirm gate (`--yes` recommended for parity)
- D-12 group 4 sub: whether `verify:phase-4` should also assert post-`--rotate-env` `gh auth status` is still 0
- D-02 naming: `--rotate-env` vs `--overwrite-env` / `--force-env` / `--reset-token`
- Whether to extract `sshCapture(...)` / `sshExitsZero(...)` from `phase-1.ts` to `scripts/lib/ssh.ts` before the third copy lands in `phase-4.ts`

All bounded by: Rule 3 (surgical changes), the locked `backup.env` skip-default direction, and the existing Phase 1 verify-script style.

## Deferred Ideas

- `npm run redeploy` macro (Area 8)
- Mirror-freshness gate on destroy (Area 5)
- `--force` destroy without `.droplet.json` (Area 5)
- DigitalOcean snapshot before destroy
- Re-derive `.droplet.json` from `doctl` discovery
- Multi-droplet teardown (Phase 5 territory)
- Rotation alerting on `--rotate-env`
- `BOOTSTRAP_RESULT` structured-log line for future status command

(Full list with rationale in CONTEXT.md `<deferred>`.)

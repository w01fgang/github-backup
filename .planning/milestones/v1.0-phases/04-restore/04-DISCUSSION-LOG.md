# Phase 3: Restore - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-05-10
**Phase:** 03-restore
**Areas discussed:** Test repo selection, Ref-equivalence assertion, Push-back semantics, Restore surface

---

## Test repo selection

| Option | Description | Selected |
|--------|-------------|----------|
| First mirror (alphabetical) | First mirror returned by `ls /opt/github-backups/*.git \| head -1`. Deterministic per-droplet, simple, no config. Could be huge. | |
| Smallest mirror by size | Find smallest *.git via `du -s` on droplet. Fast verify, predictable wall time. Adds one SSH probe. | |
| Operator-named via config | New `restoreTestRepo` field in config.json. Predictable, reproducible across droplets. Adds config surface. | ✓ |
| All mirrors (full sweep) | Loop every *.git, restore each, compare. Matches Phase 1 D-02 100% pass bar. Slow on large mirror sets. | |

**User's choice:** Operator-named via config
**Notes:** Captured as D-01. Field is optional; verify:phase-3 fails loud with a clear message if unset rather than silently picking a fallback.

---

## Ref-equivalence assertion

| Option | Description | Selected |
|--------|-------------|----------|
| Ref count match | `git for-each-ref \| wc -l` on both sides. Fastest. Misses SHA divergence. | |
| ls-remote SHA diff | `git ls-remote` on droplet vs restored, sort, diff. Names + SHAs. Standard tool. | |
| Full object-graph checksum | ls-remote diff + `git rev-list --objects --all \| sort \| sha256sum`. Catches every object. Slower. | |
| Droplet-only baseline | Compare against droplet mirror, not github.com. Restore correctness ≠ mirror freshness. | |

**User's choice:** "ask agents" — delegate to research/planner.
**Notes:** Captured as D-02 with droplet-only baseline locked as constraint (github.com comparison would test mirror freshness, not restore correctness — different concern). Planner picks the assertion form. ls-remote SHA diff flagged as the likely default.

---

## Push-back semantics

| Option | Description | Selected |
|--------|-------------|----------|
| Self-push (clone integrity) | Commit + push to throwaway local bare. Proves clone is functional. Minimal blast radius, weakest signal. | |
| Push to droplet mirror (round-trip) | Restore → commit → push to droplet → re-fetch. Proves backup→restore→re-mirror round-trip. Mutates droplet mirror. | |
| Push to github.com (full loop) | Push back to actual github.com repo. Tests "GitHub is gone" loop. Mutates operator's real repo. | |
| Drop the push assertion | Skip. Ref-equivalence (Area 2) already proves restore correctness. Document manual push in README. | |

**User's choice:** "ask relevant agents" — delegate to planner with a hard constraint clarification:
> "We're building a service that will sync-copy GitHub repositories, we don't assume that all local changes will be immediately synced to the backup."

**Notes:** Captured as D-03 + locked into the domain section. The constraint kills options 2 and 3 (push-to-droplet is not a supported flow; push-to-github.com is a separate manual recovery, not an automated assertion). Planner chooses between option 1 (self-push for clone integrity) and option 4 (drop push assertion entirely). Decision should be based on whether D-02's ref-equivalence already provides full coverage.

---

## Restore surface

| Option | Description | Selected |
|--------|-------------|----------|
| Docs + verify only | README Restore section + verify:phase-3. No new operator commands. Copy-paste model. | |
| Docs + verify + single-repo helper | Add `npm run restore -- <owner>/<repo> <target-dir>`. Wraps the manual dance. Verify uses helper internally. | |
| Three-tier (single + bulk) | Above plus `npm run restore-all -- <target>` for bulk DR. | |
| Docs + verify + on-demand restore-test | `npm run restore-test -- <owner>/<repo>` separate from verify:phase-3. | |

**User's choice:** "Ask relevant agents to reply to all your questions. Everything should be already clear enough. Do whatever makes sense. Remember that we are building a service that will copy-sync GitHub repositories."
**Notes:** Captured as D-04. Locked: docs + verify are mandatory. Planner decides whether to add the `npm run restore` helper based on whether the manual sequence is too brittle for copy-paste. `restore-all` deferred to v2 / Phase 5. Operator offered to provide user stories on demand if planner is blocked.

---

## Claude's Discretion

- D-02 (ref-equivalence assertion form, with droplet-only baseline locked)
- D-03 (push-back assertion: self-push vs drop, with no-push-to-droplet and no-push-to-github locked)
- D-04 (whether to ship a `restore` helper command, with docs + verify mandatory and restore-all deferred)
- Wall-clock budget for `verify:phase-3` and "test repo too big" handling
- Exact wording / structure of README Restore section beyond the two scenarios required by D-07

## Deferred Ideas

- `npm run restore-all` bulk-restore — v2 / Phase 5 territory
- Automated rehydrate-to-github after restore — manual operator path documented in README only
- Restore-time integrity scan (`git fsck`) — defer unless ref-equivalence catches a class of bugs that motivates adding it
- Restore-from-snapshot / cold-storage (DO snapshot, S3) — out of v1 single-droplet posture
- Pruning-aware restore (skip mirrors for repos no longer on github.com) — inherits Phase 2's deferral

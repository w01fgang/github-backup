# Phase 8: Bootstrap uploader hardening - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-05-17
**Phase:** 8-bootstrap-uploader-hardening
**Areas discussed:** Manifest source of truth, Upload strategy, README sync mechanism, Firewall outbound reconcile policy

---

## Manifest source of truth

### Q1: Where should the required-file manifest live?

| Option | Description | Selected |
|--------|-------------|----------|
| TS const in bootstrap-droplet.ts | Simplest — one file, no cross-file imports. README sync would need to import the TS module. | |
| scripts/lib/droplet-manifest.ts | Reused by uploader, future verify:phase-8, README-sync tool. Matches existing scripts/lib/ convention. | ✓ |
| droplet/MANIFEST.json | Language-neutral; droplet/bootstrap.sh could `jq` it. Adds JSON parse + schema validation surface; needs jq. | |

**User's choice:** `scripts/lib/droplet-manifest.ts`
**Notes:** Convention alignment with `scripts/lib/ssh.ts` and `scripts/lib/config.ts` was the deciding factor.

### Q2: What schema for each manifest entry?

| Option | Description | Selected |
|--------|-------------|----------|
| Minimal: path + purpose + phase | Just enough to drive README rows. | |
| Rich: + dest layout + flags | Optional destSubdir, chmodExec, category. Lets uploader stop hard-coding lib/ vs root layout. | |
| Tiered: required vs optional | required[] hard-fail, optional[] warn-only. Lets future phases ship not-yet-mandatory artifacts. | ✓ |

**User's choice:** Tiered required vs optional.

### Q3: On top of tiered required/optional, which entry fields?

| Option | Description | Selected |
|--------|-------------|----------|
| Minimal fields per entry | { path, purpose, phase }. Uploader infers dest from path prefix. | |
| + dest + chmod flags | Add destSubdir + chmodExec. Each entry explicitly declares where it lands. | ✓ |

**User's choice:** Rich fields per entry (`path, purpose, phase, destSubdir, chmodExec`).
**Notes:** Combined with tiered structure → manifest has `required[]` and `optional[]`, each holding rich-field entries.

---

## Upload strategy

### Q1 (first attempt): How should the uploader iterate files?

| Option | Description | Selected |
|--------|-------------|----------|
| Pure enumeration (drop globs) | Iterate manifest entries, scp each; pre-flight existsSync before first ssh. | |
| Glob + post-glob assert | Keep globs but cross-check every required manifest entry was found. | |
| Manifest-driven + glob warn for extras | Iterate manifest for required; glob for unmanaged-file warning. | |

**User's choice:** "Other" — requested more context about what the uploader does.
**Notes:** Re-presented the question after providing a paragraph on `scripts/bootstrap-droplet.ts`'s current behaviour (the two glob loops at 289-322 and the silent-skip bug they enable).

### Q1 (re-asked with context): How should the uploader iterate files?

| Option | Description | Selected |
|--------|-------------|----------|
| Pure enumeration (drop globs) | Replace both readdirSync loops with manifest iteration; pre-flight existsSync before first ssh. | ✓ |
| Glob + post-glob assert | Keep globs but cross-check every required manifest entry was found; treat extras as errors. | |
| Manifest-driven + glob warn for extras | Iterate manifest for required; glob for unmanaged-file warning (non-failing). | |

**User's choice:** Pure enumeration.
**Notes:** Aligns with the chosen tiered manifest — no need for a secondary glob source of truth.

### Q2: Pre-flight bail mode

| Option | Description | Selected |
|--------|-------------|----------|
| Fail-fast (first miss) | Bail on first missing required entry. Matches existing bail() pattern. | ✓ |
| Fail-aggregate (all misses) | Walk all required, collect missing, bail once with full list. | |

**User's choice:** Fail-fast.

---

## README sync mechanism

### Q1: How should README's 'Droplet file manifest' section stay in sync?

| Option | Description | Selected |
|--------|-------------|----------|
| Auto-generate (script rewrites section) | Single source of truth = manifest.ts. Script replaces content between HTML-comment markers. | ✓ |
| Hand-maintain + verify-only diff | Hand-write the table; verify script checks parity in CI. | |
| Hand-maintain, no enforcement | No automated check. Discipline only. | |

**User's choice:** Auto-generate.

### Q2: When does the auto-generator run?

| Option | Description | Selected |
|--------|-------------|----------|
| Pre-commit + CI re-check | Pre-commit runs sync + diff-exit-code; CI re-runs same check. | ✓ |
| Pre-commit auto-stage | Hook silently regenerates and `git add`s README.md. | |
| CI verify only (no pre-commit) | Opt-in `npm run sync:readme`; CI fails PR on drift. | |

**User's choice:** Pre-commit + CI re-check.
**Notes:** Claude surfaced a conflict before locking in — the repo currently has no pre-commit framework (no husky/lint-staged) and no CI (no `.github/workflows/`). This is a scope expansion. Followed up with re-confirmation.

### Q3 (follow-up): Given no pre-commit/CI exists today, what to do?

| Option | Description | Selected |
|--------|-------------|----------|
| Yes — introduce both as part of Phase 8 | Adds 2 tasks; sets up CI foundation for future phases. | ✓ |
| Pre-commit only, no CI | Lower lift; matches current "no CI" posture. | |
| Just the npm scripts (no hook, no CI) | Manual discipline; matches existing repo style. | |

**User's choice:** Introduce both as part of Phase 8.

### Q4: Which hook tool?

| Option | Description | Selected |
|--------|-------------|----------|
| husky | Standard, well-supported, +1 devDep. | |
| Native bash hook (no deps) | Bash script committed to scripts/git-hooks/pre-commit, copied via `prepare` npm script. | ✓ |
| simple-git-hooks | Smaller alternative to husky, +1 devDep. | |

**User's choice:** Native bash hook, no deps.

---

## Firewall outbound reconcile policy

### Q1: How aggressive should outbound reconcile be?

| Option | Description | Selected |
|--------|-------------|----------|
| Strict canonical-only (add missing, leave extras) | Mirror inbound logic; never remove operator-added rules. | ✓ |
| Full canonicalization (remove extras too) | Always converge to exactly the canonical set. Higher destructive blast radius. | |
| Add missing + warn-only on extras | Compromise: log a warning but never remove. | |

**User's choice:** Strict canonical-only.

### Q2: Reconcile code structure

| Option | Description | Selected |
|--------|-------------|----------|
| Extract shared reconcile helper, then add outbound | One match function used by inbound + outbound. ~20-line refactor first. | ✓ |
| Copy-paste inbound → outbound, no refactor | Zero risk to existing inbound; some duplication. | |

**User's choice:** Extract shared helper, then add outbound.
**Notes:** Helper refactor lands as a behaviour-preserving change first (verifiable by re-running create-droplet and getting only `✓ Rule already present` lines), then the outbound call site lands as a separate task. Log format gains `[inbound]` / `[outbound]` prefix.

---

## Claude's Discretion

- README table column order/alignment.
- Whether `scripts/sync-readme-manifest.ts` exposes a `--check` flag (cosmetic CI plumbing).
- Helper function name/signature for D-11 (`reconcileRules` vs `ensureRulesPresent`).

## Deferred Ideas

- **JSON manifest consumable from bash** — rejected for Phase 8 (jq dep + JSON schema surface). Revisit if droplet-side defence beyond the existing webhook trio check is wanted.
- **Full outbound canonicalization** (remove extras) — rejected for blast-radius reasons. Revisit with an opt-in `--prune` flag if drift becomes a recurring incident.
- **scripts/verify/phase-8.ts** — not required by any success criterion. Manual test (delete a manifest file, run bootstrap-droplet, observe pre-flight bail) is sufficient; pre-commit + CI cover the README parity contract.
- **Generic CI scaffold beyond `sync-check.yml`** — lint/typecheck/test workflows belong to a future infra phase.

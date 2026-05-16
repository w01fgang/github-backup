# Phase 2: Monitoring - Context

**Gathered:** 2026-04-30
**Status:** Ready for planning

<domain>
## Phase Boundary

Operator can answer in <30 seconds: did the last backup run, what changed, how full is the disk? Delivered as a status command (local + droplet-side) that reports the latest cron-run timestamp + exit code, per-repo update outcomes from the last run, and disk usage of `/opt/github-backups`.

Scope is read-only reporting. No alerting, no metrics export, no historical retention beyond "last run". The backup script (`droplet/github-backup.sh`) is touched only to emit a structured run-summary file the status command can read; behavior of the backup itself does not change.

</domain>

<decisions>
## Implementation Decisions

### Status invocation surface
- **D-01:** Both surfaces ship — local `npm run status` (TypeScript via `tsx`, SSHes to droplet using `.droplet.json` + `config.json` like Phase 1 scripts) wraps a droplet-side `github-backup-status` script installed under `/opt/github-backups/`. Operator picks: zero-friction local one-liner, or direct droplet shell access.
- **D-02:** Local wrapper passes flags through to the droplet binary (e.g. `npm run status -- --json --verbose`) so behavior is identical regardless of surface.

### Run-state source
- **D-03:** Instrument `droplet/github-backup.sh` to write a structured run summary to `/var/lib/github-backup/last-run.json` at end of every run, atomic write via temp+rename. Schema: `{ started_at, finished_at, exit_code, total, success, fail, repos: [{ name, action: "clone"|"update"|"fail", duration_ms? }] }`.
- **D-04:** Status command reads `last-run.json` first; falls back to tailing `/var/log/github-backup.log` and parsing the `Backup finished — success: N, failed: M` summary line if the JSON is missing (covers the window before the new script lands and after a corrupted write).
- **D-05:** `/var/lib/github-backup/` is created with mode 700, owned by root, by `droplet/bootstrap.sh` (additive change to bootstrap, idempotent).

### Per-repo display
- **D-06:** Default output: counts header (`✓ 12  ✗ 1  total 13`) plus the names of any failed repos always shown. Full per-repo list hidden behind `--verbose` (or `-v`) flag to keep default scan well under 30s.
- **D-07:** Per-repo line format in verbose mode: `<status-glyph> <action> <owner>/<repo>` (e.g. `✓ update sumin/dotfiles`).

### Disk reporting
- **D-08:** Always show two lines: `df -h` of the filesystem holding `BACKUP_DIR` (capacity + percent used) and `du -sh ${BACKUP_DIR}` (actual mirror footprint). Per-repo size only with `--verbose`.

### Output format
- **D-09:** Default = human-readable text (table-ish, no ANSI colors required). `--json` flag emits a single JSON object suitable for piping to `jq` / future alerting; schema is a strict superset of `last-run.json` plus a `disk` block and a `staleness` block.

### Staleness signal
- **D-10:** Compute expected interval from `CRON_SCHEDULE` in `backup.env` (parsed on the droplet). Flag run as `STALE` if `now - finished_at > 2 × expected interval`. Plain banner at top of text output (e.g. `⚠ STALE — last run 2d 4h ago, expected every 24h`); boolean in JSON output.
- **D-11:** If `last-run.json` is missing AND log has no recognizable summary, status reports `NEVER RAN` with non-zero exit code.

### "Skipped" semantics (MON-02 wording reconciliation)
- **D-12:** `MON-02` says "fetched/skipped/failed", but `github-backup.sh` only ever clones (new) or updates (existing) — there is no skip path. Treat MON-02 as `clone | update | fail`. Drop "skipped" from the vocabulary. Note in REQUIREMENTS clarification.

### Exit codes
- **D-13:** Status command exit codes — `0` = last run succeeded and is fresh; `1` = last run had failures; `2` = stale; `3` = never ran / state file unreadable. Lets operator wire `npm run status` into shell prompts or future alerting without parsing output.

### Claude's Discretion
- All four surface gray areas (status surface, run-state source, per-repo detail, bundled disk/format/stale/skipped) were explicitly delegated by operator. Recommendations above are Claude's pick within phase scope; planner may refine specific paths/flag names but should not reopen the locked direction without operator sign-off.
- Exact text/JSON layout, color/glyph choices, flag short-names.
- Whether to use `cron-parser` npm package vs hand-rolled cron-interval parser for staleness math.

</decisions>

<specifics>
## Specific Ideas

- "Operator answers 3 questions in <30s" is the design constraint. Optimize default output for fast scan, not completeness. Verbose flag is the escape hatch for "I want to see everything".
- Reuse the Phase 1 SSH helper pattern (`sshFlags`, `sshRun`, `runCapture` from `scripts/bootstrap-droplet.ts`) — extract to a shared module if not already done in Phase 1, otherwise duplicate sparingly.
- The droplet-side binary should be a small bash script (`droplet/github-backup-status.sh`), consistent with `github-backup.sh` / `install-cron.sh` / `bootstrap.sh` already shipping there. Avoid introducing Node on the droplet.

</specifics>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Project requirements
- `.planning/PROJECT.md` — Single-operator scope, runtime-only token policy, minimal-surface posture. Status command must not re-expose `GITHUB_TOKEN` or persist secrets.
- `.planning/REQUIREMENTS.md` §Monitoring — MON-01 (last run timestamp + exit), MON-02 (per-repo update status; treat "skipped" per D-12), MON-03 (disk usage).
- `.planning/ROADMAP.md` §Phase 2 — Success criteria 1–3.

### Phase 1 baseline (depended-on, do not regress)
- `.planning/phases/01-verify-pipeline/01-CONTEXT.md` — TypeScript/`tsx` + `npm run` convention (D-03), config+env split (D-05), real-user smoke target, 100% pass bar carries forward.
- `scripts/bootstrap-droplet.ts` — SSH helper pattern to reuse (`sshFlags`, `sshRun`, `runCapture`, `expandHome`, `loadConfig`, `loadDropletInfo`).
- `droplet/github-backup.sh` — File to instrument with `last-run.json` writer; do not change clone/update/fail loop semantics.
- `droplet/bootstrap.sh` — Add `mkdir -p /var/lib/github-backup && chmod 700` step (idempotent).
- `droplet/install-cron.sh` — `CRON_SCHEDULE` source of truth; staleness parser reads same value from `backup.env`.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `scripts/bootstrap-droplet.ts` SSH helpers — directly reusable for `scripts/status.ts`. Same `Config` + `DropletInfo` loaders, same `sshFlags` / `sshRun` / `runCapture` shape.
- `config.json` (`sshKeyPath`, `sshUser`, `backupDir`) and `.droplet.json` (`ip`) — already the contract for any local→droplet command.
- `/var/log/github-backup.log` — existing free-form log is the fallback parse target (D-04). Summary line `Backup finished — success: N, failed: M` is greppable.

### Established Patterns
- **TypeScript + tsx + npm script** — every operator-facing command (`create-droplet`, `bootstrap-droplet`, `smoke-test`, `verify:phase-N`) is one of these. `status` follows suit.
- **Config + env split** — config.json for non-secret operator settings; env vars / `backup.env` for secrets. Status reads config.json locally; never reads `backup.env` over SSH (no need — only needs `CRON_SCHEDULE`, which can be reread on droplet).
- **Idempotency by lookup** — `last-run.json` write must be atomic (temp + rename) so a partial write never leaves a half-parseable file.

### Integration Points
- `github-backup.sh` end-of-run: append a writer step that emits `last-run.json` from accumulated `SUCCESS` / `FAIL` counters + a per-repo array built inline in the loop. Single file change, no flow change.
- `bootstrap.sh`: add `/var/lib/github-backup` directory creation alongside existing `mkdir -p ${BACKUP_DIR}` step.
- New files: `droplet/github-backup-status.sh` (bash, reads JSON + computes disk + staleness), `scripts/status.ts` (local SSH wrapper), `package.json` script entry `"status": "tsx scripts/status.ts"`.
- Phase 1 verify (`npm run verify:phase-1`) is unaffected. Phase 2 should add `npm run verify:phase-2` asserting `last-run.json` exists with valid schema and status command exits cleanly.

</code_context>

<deferred>
## Deferred Ideas

- **Pruning deleted-from-GitHub repos** — would introduce a real "skipped" semantic (mirror exists locally but no longer in API list). Out of Phase 2 scope; capture for backlog.
- **Per-repo size in default output** — would push output past the 30s scan budget. Available behind `--verbose` only.
- **Historical run retention / trend reporting** — out of v1 scope per PROJECT.md; would require log rotation policy + storage decisions.
- **Email/Slack alerting on STALE or fail** — explicitly v2 per PROJECT.md (deferred features). JSON output + exit codes are designed to make this trivial later.
- **Metrics export (Prometheus, etc.)** — v2 deferred feature.

</deferred>

---

## Post-phase amendment — 2026-05-11

**Trigger:** PROJECT.md added webhook + cron hybrid as the sync model. New Phase 6 (Webhook listener) ships an HTTPS endpoint that triggers per-repo sync on push events. REQUIREMENTS.md MON-01 was rewritten to "verify last cron sweep + last webhook event status, repo update status, disk usage".

**Implications for Phase 2 (no rewrite — additive amendment for the planner):**

- **Status command must report TWO timelines, not one.** In addition to the cron `last-run.json` (D-03), the status command will read a new `/var/lib/github-backup/last-webhook-event.json` (Phase 6 owns the schema and the writer). Default text output gains a second "Last webhook event:" line under the existing "Last run:" line. JSON output gains a sibling `webhook` block alongside the existing `disk` and `staleness` blocks.
- **Staleness signal (D-10) re-interprets.** With webhook driving most syncs, "last cron run >2× expected interval" is no longer the right "is this thing healthy" check. The right check becomes EITHER cron-sweep is fresh OR webhook-events are flowing for repos that have had pushes. Phase 2 D-10 stays correct for the cron-sweep half; Phase 6 owns whatever staleness signal applies to the webhook half. Status command surfaces both signals; operator sees both.
- **`MON-02` per-repo wording (D-12) is unaffected.** Per-repo `clone | update | fail` still applies regardless of which trigger (cron or webhook) caused the action. Both writers populate the same per-repo schema in their respective state files.
- **Exit codes (D-13) unchanged for the cron path.** Phase 6 may extend the contract with webhook-flavored exit codes (e.g., `4 = webhook listener down`); reconciliation owned by Phase 6.

**No code changes needed in Phase 2 yet.** When Phase 6 lands, the status-command implementation done in Phase 2 will need a small additive read of `last-webhook-event.json` and one extra display line. That work should be tracked under Phase 6's plan, not retroactively against Phase 2.

---

*Phase: 02-monitoring*
*Context gathered: 2026-04-30 (amended 2026-05-11)*

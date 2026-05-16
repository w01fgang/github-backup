# Phase 2: Monitoring - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-04-30
**Phase:** 02-monitoring
**Areas discussed:** Status surface, Run-state source, Per-repo detail, Bundled (disk + format + staleness + skipped semantics)

---

## Status surface

| Option | Description | Selected |
|--------|-------------|----------|
| `npm run status` (local SSH-in) | From local: tunnels SSH+doctl, no droplet login. Matches Phase 1 npm pattern. | |
| Droplet-side script only | Operator ssh-es first, then runs binary. Simpler, no local TS needed. | |
| Both (npm wraps droplet script) | Local npm wraps remote script. Both surfaces work. | ✓ (Claude pick) |

**User's choice:** Deferred to Claude.
**Notes:** Operator pattern across all four areas was "ask agents to decide." Claude picked Both for parity with Phase 1 npm convention while keeping a no-Node droplet path.

---

## Run-state source

| Option | Description | Selected |
|--------|-------------|----------|
| Parse log tail | Tail `/var/log/github-backup.log`, regex parse summary line. No script change. | |
| Structured `last-run.json` | Modify `github-backup.sh` to write JSON. Cleaner status, touches Phase 1 script. | |
| Both (JSON primary, log fallback) | JSON for status; log stays canonical. Belt-and-suspenders. | ✓ (Claude pick) |

**User's choice:** Deferred to Claude.
**Notes:** JSON is the primary source; log-tail fallback covers the deployment window before the new backup.sh ships and any future write corruption.

---

## Per-repo detail

| Option | Description | Selected |
|--------|-------------|----------|
| Full list always | Default = full list (12 repos × 1 line). Quick scan, no flag needed. | |
| Counts default, `--verbose` for detail | Default = counts (✓12 ✗1 ∅0). Verbose for full list. | |
| Counts + failed-only by default | Default counts + always show failed-repo names; full list behind flag. | ✓ (Claude pick) |

**User's choice:** Deferred to Claude.
**Notes:** Failed-repo names shown by default because that is the actionable subset for the <30s answer. Full list still reachable via `--verbose`.

---

## Bundled (disk + format + staleness + skipped semantics)

| Option | Description | Selected |
|--------|-------------|----------|
| All Claude's discretion | Claude picks: df+du, text+--json, stale flag at 2× cron interval, drop "skipped" from MON-02. | ✓ |
| Let me pick one to discuss | Want to lock at least one of: disk, format, staleness, skipped semantics. | |

**User's choice:** All Claude's discretion.
**Notes:** Picks recorded in CONTEXT.md D-08 through D-13. "Skipped" dropped from MON-02 vocabulary; flagged for REQUIREMENTS clarification.

---

## Claude's Discretion

- Status surface (D-01, D-02)
- Run-state source (D-03 through D-05)
- Per-repo display (D-06, D-07)
- Disk reporting (D-08)
- Output format (D-09)
- Staleness signal (D-10, D-11)
- Skipped semantics (D-12)
- Exit codes (D-13)
- Exact text/JSON layout, glyph and color choices, flag short-names
- Cron interval parser choice (npm `cron-parser` vs hand-rolled)

## Deferred Ideas

- Pruning of repos deleted on GitHub (would introduce a real "skipped" path)
- Per-repo size in default output
- Historical run retention / trend reporting
- Email/Slack alerting on STALE or fail (v2)
- Metrics export, e.g. Prometheus (v2)

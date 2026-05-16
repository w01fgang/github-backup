# Milestones

## v1.0 MVP (Shipped: 2026-05-16)

**Phases completed:** 6 phases, 19 plans, 15 tasks

**Key accomplishments:**

- TypeScript assertion harness wiring four D-07 invariant groups against a live droplet, with the standalone D-02 100% pass-bar lock parsing the BACKUP_SUMMARY marker.
- TS end-to-end orchestrator wired (Task 1) plus the bash-side BACKUP_SUMMARY marker. Live-cloud verification (Task 2) intentionally deferred — operator will run `npm run smoke-test` + `npm run verify:phase-1` against real DigitalOcean infrastructure manually. Phase 1 close-out reflects the deferred live run.
- `droplet/github-backup.sh` now writes `/var/lib/github-backup/last-run.json` after every run (atomic, schema-locked); `droplet/bootstrap.sh` provisions the state directory at mode 700.
- Droplet-side status binary wires D-01/D-04/D-06–D-11/D-13 — reads last-run.json (or log fallback), measures disk via df+du, parses CRON_SCHEDULE for staleness, emits text-by-default or `--json`.
- `npm run status` from the operator's laptop produces the same output as running `github-backup-status.sh` directly on the droplet; flags after `--` forward verbatim; remote exit code propagates unchanged.
- `npm run verify:phase-2` exercises Plans 02-01 + 02-02 + 02-03 end-to-end against a live droplet — pre-flights a manual backup if needed, asserts state-file schema, status-binary contract, disk-math agreement, and local-vs-remote `--json` equality.
- [Note — not a deviation] grep token count for `BACKUP_SUMMARY` in github-backup.sh
- [Rule 1 — bug fix] resolveWebhookSecret is synchronous, not Promise-returning.

---

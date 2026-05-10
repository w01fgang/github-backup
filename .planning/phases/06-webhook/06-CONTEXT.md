# Phase 6: Webhook listener - Context

**Gathered:** 2026-05-11
**Status:** Ready for planning

<domain>
## Phase Boundary

Public HTTPS endpoint on the droplet receives GitHub `push` events, verifies their HMAC-SHA256 signature against a per-source shared secret, and triggers a per-repo mirror update within seconds. Cron sweep (Phase 1) becomes a safety net for missed deliveries, deletes, and idle repos that never push.

**In scope:**
- Public HTTPS endpoint at `https://<webhookHostname>/webhook/github` on the droplet (Caddy reverse proxy + Let's Encrypt + small Node.js listener process behind it)
- Per-source webhook shared secret (`WEBHOOK_SECRET_<SOURCE>` in `backup.env`, generated at bootstrap if absent)
- HMAC-SHA256 signature verification of `X-Hub-Signature-256`, constant-time compare
- Per-repo sync handler extracted from `droplet/github-backup.sh` into `droplet/sync-one-repo.sh <source> <owner> <repo>` so cron and webhook share one code path
- systemd unit `github-backup-webhook.service` (auto-restart, runs as `root` for now — same posture as cron)
- Per-repo lock (`/var/lock/github-backup-<source>__<owner>_<repo>.lock`) for webhook handlers; cron keeps the global lock; they never block each other except on the same repo
- `npm run register-webhooks` (operator-side TS command) — iterates `cfg.sources`, lists repos via `gh api`, idempotently creates a webhook per repo pointing at the listener
- `WEBHOOK_EVENT_SUMMARY` droplet-side log line + `/var/lib/github-backup/last-webhook-event.json` (sibling to Phase 2's `last-run.json`) for the future status command
- Firewall: open TCP/443 inbound to `0.0.0.0/0` (HMAC is the real security layer; not worth maintaining a GitHub source-IP allowlist at single-operator scale)
- `webhookHostname` field in `config.json` (operator brings a domain — required for HTTPS)
- `scripts/verify/phase-6.ts` + `npm run verify:phase-6` end-to-end proof (signed POST → mirror updated within 30s)
- README operator section: how to register a domain, what records to point at the droplet, how to register webhooks, how to check listener status

**Out of scope:**
- Replacing cron entirely — cron stays as safety net per PROJECT.md
- GitHub App (vs per-repo webhooks) — per-repo with shared secret is enough at single-operator scale
- Webhook event types beyond `push` — `repository.created`/`deleted`/`renamed` deferred (cron picks up eventually)
- HTTP-only fallback — HTTPS required, period (operator must bring a domain)
- Multi-droplet load balancing — v2 deferred per PROJECT.md
- Per-repo webhook secrets (vs per-source) — overkill at this scale
- Webhook delivery monitoring dashboard — Phase 2 status command surfaces last-event; richer monitoring is v2 alerting territory

</domain>

<decisions>
## Implementation Decisions

### Listener runtime

- **D-01:** **Caddy reverse proxy + small Node.js listener behind it.** Caddy auto-provisions a Let's Encrypt cert for `webhookHostname` and reverse-proxies `/webhook/github` to `127.0.0.1:9100`. Listener is ~150 LOC of vanilla Node using built-in `http` + `crypto` modules — zero npm deps. Rationale: Caddy handles the hard parts (HTTPS, cert renewal, ACME challenges) with one config file; Node gives us proper HMAC + JSON parsing without bash gymnastics; no `node_modules` so `apt install nodejs` is enough. Bun was tempting but adds a less-stable runtime dependency for negligible gain.

- **D-02:** **Listener does NOT run any git commands directly.** It validates the request, writes the event metadata to a queue file (`/var/lib/github-backup/queue/<timestamp>-<source>-<owner>-<repo>.json`), and immediately responds 200. A separate `droplet/sync-one-repo.sh` worker (invoked via `systemd-run` or a long-lived dispatcher process — planner picks) consumes the queue. Rationale: HTTPS request handlers must finish in seconds; `git remote update` on a big repo can take minutes. GitHub retries on timeout, which would create thundering-herd dupes.

- **D-03:** **Worker dispatch model: `systemd-run --collect --no-block` per event.** Listener invokes `systemd-run --collect --no-block /opt/github-backups/sync-one-repo.sh <source> <owner> <repo>` as soon as it accepts the event. systemd handles concurrency + cleanup; no long-lived dispatcher process. Per-repo flock inside `sync-one-repo.sh` serialises same-repo concurrent events. Acceptable failure mode: if systemd-run fails (rare), listener returns 500 and GitHub will retry.

### HTTPS + DNS

- **D-04:** **Operator brings a domain.** New required field `webhookHostname` in `config.json` (e.g. `"backup.example.com"`). If absent, `bootstrap-droplet` fails loud at the listener-install step with `set config.webhookHostname to a domain you control and pointed at the droplet IP`. No fallback to self-signed or HTTP — GitHub rejects insecure webhook URLs.

- **D-05:** **Caddy config is one file: `/etc/caddy/Caddyfile`** with literally:
  ```
  {webhookHostname} {
    reverse_proxy /webhook/github 127.0.0.1:9100
  }
  ```
  Templated at bootstrap time from `cfg.webhookHostname`. Caddy daemon installed via `apt install caddy` in `droplet/bootstrap.sh`. Auto-Let's-Encrypt happens on first request. Caddy's defaults handle HTTP→HTTPS redirect and HSTS.

- **D-06:** **DNS is the operator's problem.** README documents: "Create an A record pointing `<webhookHostname>` at `<droplet-ip>` BEFORE running bootstrap. Caddy needs the DNS record to be live for the ACME challenge to succeed." Bootstrap does not validate DNS (would add a flaky probe); first webhook attempt fails loudly if the cert was never provisioned.

### Secret management

- **D-07:** **Per-source webhook secrets, generated on the droplet.** During bootstrap, for each `<source>` in `cfg.sources`, check whether `WEBHOOK_SECRET_<SOURCE_UPPER>` is already set in `backup.env`. If not, generate via `openssl rand -hex 32` and append to `backup.env`. Print the generated secret(s) to operator stdout so they can register webhooks (one-time visibility). Subsequent bootstraps preserve existing secrets (Phase 4 D-01 `backup.env` skip-if-exists rule keeps them stable).

- **D-08:** **Source-name shape constraint** (already enforced by Phase 5 D-03 `SHELL_SAFE_RE`): source names must match `[A-Za-z0-9_.-]+` so the env-var name `WEBHOOK_SECRET_<SOURCE_UPPER>` is shell-safe. No additional validation here.

- **D-09:** **`--rotate-webhook-secrets` flag on bootstrap** (mirrors Phase 4 D-02 `--rotate-env`) regenerates all webhook secrets and prints them. Operator must then re-register webhooks (or update the existing webhook secret in GitHub Settings). Documented as a deliberate operation, not a side effect.

### HMAC verification

- **D-10:** **`X-Hub-Signature-256` HMAC-SHA256 over the raw request body.** Algorithm is non-negotiable per GitHub's spec. Constant-time compare via `crypto.timingSafeEqual` (Node built-in). Reject (401 + log) on:
  - Missing `X-Hub-Signature-256` header
  - Signature length mismatch (would crash `timingSafeEqual` if not pre-checked)
  - Computed HMAC mismatch
  - Source-not-in-config (computed before signature check would leak nothing — order: source-resolution first, then HMAC)
  Body must be read raw (Buffer), not parsed-then-restringified — JSON.stringify normalisation will break the signature.

- **D-11:** **Source resolution** (per Phase 5 amendment): `<source>` = `payload.repository.owner.login`. If not in `cfg.sources`, return 404 + log "unknown source"; do NOT reveal the configured source list. Once resolved, look up `WEBHOOK_SECRET_<SOURCE_UPPER>` and verify HMAC against that secret.

### Event handling

- **D-12:** **Only `push` events trigger sync.** Listener checks `X-GitHub-Event: push`; all other event types return 204 + log (acknowledged but no-op). This includes `ping` (GitHub sends one when a webhook is created — must return 2xx or GitHub marks the webhook unhealthy).

- **D-13:** **`ping` event:** return 200 with body `pong` (GitHub displays this in the webhook delivery log; helps operator confirm registration). Logged but doesn't trigger sync.

- **D-14:** **Repo-deleted, repo-renamed, repo-created:** out of scope. Cron sweep catches new repos within `CRON_SCHEDULE`. Renames create stale mirror dirs; documented as a known limitation. Deletes leave orphan mirrors; deferred to a future "pruning-aware sync" item (Phase 2's deferred "skipped" semantic territory).

### Per-repo sync handler (DRY refactor)

- **D-15:** **Extract per-repo mirror logic from `droplet/github-backup.sh` into `droplet/sync-one-repo.sh <source> <owner> <repo>`.** Both cron (loop body) and webhook (single call) invoke it. The script:
  1. Acquires `/var/lock/github-backup-<source>__<owner>_<repo>.lock` (per-repo, NOT the global lock — webhook handlers must not block on cron sweeps for OTHER repos)
  2. Resolves mirror path `${BACKUP_DIR}/<source>/<owner>_<repo>.git`
  3. Runs `git clone --mirror` (new) or `git remote update --prune` (existing)
  4. Emits a `BACKUP_REPO_RESULT source=<s> owner=<o> repo=<r> action=<clone|update|fail> duration_ms=<n>` log line for status parsing
  5. Exit 0 on success, non-zero on fail
- The cron-driven `github-backup.sh` becomes a thin loop: enumerate sources → enumerate repos → invoke `sync-one-repo.sh` per repo → aggregate into `BACKUP_SUMMARY` + `last-run.json`.
- `BACKUP_SUMMARY` contract from Phase 1 unchanged. `BACKUP_REPO_RESULT` is new and additive.

- **D-16:** **Cron uses the global lock; webhook uses per-repo locks.** Concretely: `github-backup.sh` (cron entry) takes `/var/lock/github-backup.lock` as today (Phase 1 NR-06 lock semantics), then internally calls `sync-one-repo.sh` for each repo — `sync-one-repo.sh` ALSO takes the per-repo lock. Webhook handlers skip the global lock, take only the per-repo lock. Result: cron and webhook coexist; concurrent webhook + cron on the same repo serialises on the per-repo lock; concurrent webhook on different repos runs in parallel. Phase 1's "wedged previous cron run" guard (NR-06 `LOCK_WAIT_SECONDS`) still applies to the global lock.

### Run-state recording (Phase 2 integration)

- **D-17:** **New file: `/var/lib/github-backup/last-webhook-event.json`** written atomically (temp + rename) at the end of every successful sync triggered by a webhook. Schema:
  ```json
  {
    "received_at": "<ISO>",
    "source": "<s>",
    "owner": "<o>",
    "repo": "<r>",
    "delivery_id": "<X-GitHub-Delivery header value>",
    "action": "clone|update|fail",
    "duration_ms": 1234,
    "exit_code": 0
  }
  ```
- Status command (Phase 2) reads BOTH `last-run.json` (cron) and `last-webhook-event.json` (webhook), displays the more recent of the two prominently and the other as a secondary line.

- **D-18:** **Listener stdout/stderr go to systemd journal** (`journalctl -u github-backup-webhook`). Operator-facing convenience: README documents `journalctl -u github-backup-webhook -f` as the live tail command. No separate log file — the journal is the source of truth, no rotation problem.

### Bootstrap + Phase 4 idempotency integration

- **D-19:** **`droplet/bootstrap.sh` additions** (idempotent, owned by Phase 6):
  1. `apt install -y caddy nodejs` (apt-get is idempotent at OS level)
  2. Write `/etc/caddy/Caddyfile` from template (always overwrite — this is droplet-managed code, same posture as Phase 4 D-06)
  3. Write `/opt/github-backups/webhook-listener.js` (always overwrite, same reason)
  4. Write `/etc/systemd/system/github-backup-webhook.service` from template
  5. `systemctl daemon-reload && systemctl enable --now github-backup-webhook && systemctl reload caddy`
- **D-20:** **Phase 4 D-07 hook fulfilled here:** the `daemon-reload` + `restart` step makes bootstrap re-run safe for the listener. Existing in-flight webhook deliveries get retried by GitHub on listener restart (typically <2s downtime for systemd restart). `verify:phase-4`'s "listener restart cleanly" assertion (per Phase 4 D-12 amendment) is implementable once Phase 6 lands.

### Operator workflow — webhook registration

- **D-21:** **`npm run register-webhooks` (TS, runs locally).** For each `<source>` in `cfg.sources`:
  1. Read `WEBHOOK_SECRET_<SOURCE_UPPER>` from droplet's `backup.env` over SSH (one read; do NOT cache locally)
  2. List repos via `gh api` (reuse `detect-account-type.sh` pattern from Phase 5 D-05)
  3. For each repo, `gh api repos/<owner>/<repo>/hooks` to check if a webhook with `config.url = https://<webhookHostname>/webhook/github` already exists
  4. If absent, `gh api -X POST repos/<owner>/<repo>/hooks` with `events: ["push"]`, `config: { url, secret, content_type: "json", insecure_ssl: "0" }`
  5. If present, no-op (idempotent — repeat runs are safe)
- Print summary: `<N> registered, <M> already present, <K> failed` per source.

- **D-22:** **`--update` flag on `register-webhooks` rotates secrets on existing hooks** (after operator runs `bootstrap-droplet --rotate-webhook-secrets`). PATCHes existing webhooks with the new secret. Without `--update`, existing webhooks are left alone.

### Firewall (Phase 1 cross-impact)

- **D-23:** **`scripts/create-droplet.ts` adds inbound TCP/443 from `0.0.0.0/0`** alongside the existing TCP/22 rule. `0.0.0.0/0` rather than GitHub's source IP allowlist (`gh api meta`) because: (a) HMAC is the real security gate, (b) GitHub's IP ranges drift and re-running create-droplet to refresh would defeat the idempotency assertion, (c) Caddy auto-Let's-Encrypt needs port 80 from anywhere too. So: add 80 + 443 from `0.0.0.0/0`. PROV-01 idempotency assertion (Phase 1) must continue to pass — second `create-droplet` run still no-ops if the new rules are present.

- **D-24:** **Existing droplets are migrated by re-running `npm run create-droplet`** — its existing idempotency logic adds the new firewall rules without churning the droplet. No special migration command needed. Documented in the README's "upgrading" section.

### verify:phase-6

- **D-25:** **`scripts/verify/phase-6.ts` + `npm run verify:phase-6`** follows the Phase 1/3/4 template: TS + tsx, fail-fast `assert(cond, msg)`, exit 0 all-pass.
- **D-26:** **Assertion groups (in order):**
  1. **Pre-conditions:** Droplet alive, `cfg.webhookHostname` resolves to droplet IP (DNS check), `https://<webhookHostname>/webhook/github` returns 200 to a `ping` event signed with the right secret, `systemctl is-active github-backup-webhook` returns `active`, Caddy is serving HTTPS with a valid LE cert.
  2. **Source resolution:** Send a signed event with a source NOT in `cfg.sources` → assert 404.
  3. **Bad signature:** Send a `push` event with a deliberately wrong HMAC → assert 401.
  4. **End-to-end push (env-gated):** Requires `cfg.webhookTestRepo = "<source>/<owner>/<repo>"` (new field, mirrors Phase 3's `restoreTestRepo`). Send a synthetic `push` event for that repo, poll the mirror's HEAD SHA over SSH, assert it matches what we claimed in the event payload within 30s. If `webhookTestRepo` unset, log skip (matches Phase 4 D-12 group 4 env-gated pattern).
  5. **Idempotency:** Re-send the same event → assert it processes again (GitHub retry-safety; we don't dedupe by `X-GitHub-Delivery`).
  6. **Listener-restart survival:** `systemctl restart github-backup-webhook`, wait 3s, send another `ping`, assert 200.

### Claude's Discretion

- **D-03 sub:** `systemd-run` per event vs a long-lived dispatcher process reading from the queue dir. Both work. systemd-run is simpler (no extra service to manage); long-lived dispatcher is friendlier to per-source rate limits if those ever matter. Planner picks; no constraint forces either.
- **D-05 sub:** whether to support a wildcard cert (one Caddyfile entry covering a future `webhook2.example.com` etc.). Out of v1 — single hostname is enough.
- **D-19 sub:** whether to install Caddy from the official Caddy apt repo (Cloudsmith-hosted, latest version) vs the Ubuntu-bundled package (older, simpler). Latest is safer for ACME bug fixes; planner picks.
- **D-21 sub:** whether `register-webhooks` should add a `--dry-run` flag (list what it WOULD register without making API calls). Defensible, not load-bearing.
- **D-23 sub:** whether to also open inbound 80 + 443 only from `meta.hooks` IPs from `gh api meta` plus Let's Encrypt's known IPs. Tighter, more brittle. Decision above is `0.0.0.0/0` for simplicity; planner may revisit if any real attack surface shows up.
- **D-26 group 4 sub:** the synthetic `push` payload — fully construct from a real `git rev-parse HEAD` of the test repo's mirror, OR pull a real recent push event from GitHub's webhook delivery log via `gh api`? Real payload is more faithful but adds an `gh api` dependency in verify; constructed payload is fully deterministic. Planner picks.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Project requirements
- `.planning/PROJECT.md` — Webhook + cron hybrid (Key Decision 2026-05-11), single-operator, runtime-only token policy. Webhook secret stored alongside `GITHUB_TOKEN` in `backup.env`. Webhook needs public ingress (firewall change required).
- `.planning/REQUIREMENTS.md` — WEBHOOK-01 (HTTPS + HMAC), WEBHOOK-02 (push event triggers sync; 401 on bad sig). PROV-02 expanded to include "webhook listener" install. BACKUP-03 expanded to include webhook secret in `backup.env`. MON-01 expanded to include last webhook event.
- `.planning/ROADMAP.md` §Phase 6 — Goal + 5 success criteria. Depends on Phases 1, 4, 5.

### Phase 1 baseline (depended-on, do not regress)
- `.planning/phases/01-verify-pipeline/01-CONTEXT.md` — TS+tsx+npm convention, `verify:phase-N` shape, BACKUP_SUMMARY contract on the droplet, NR-06 global flock semantics. Read the "Post-phase amendment 2026-05-11" at the bottom (destroy-droplet removed; smoke `--fresh` removed).
- `scripts/create-droplet.ts` — Firewall config site (D-23). Must remain idempotent (PROV-01).
- `droplet/github-backup.sh` — Per-repo logic to extract into `sync-one-repo.sh` (D-15). Keep `BACKUP_SUMMARY` emitter contract intact.
- `scripts/lib/{config,ssh,doctl}.ts` — Reusable for `register-webhooks.ts` and `verify/phase-6.ts`. Add `webhookHostname?: string` and `webhookTestRepo?: string` to the `Config` type.

### Phase 2 / Phase 4 / Phase 5 baselines
- `.planning/phases/02-monitoring/02-CONTEXT.md` — Status command schema. Read the "Post-phase amendment 2026-05-11" — Phase 6 ships `last-webhook-event.json`, Phase 2's status reader gains a small additive change (tracked under THIS phase's plan, not Phase 2).
- `.planning/phases/04-teardown/04-CONTEXT.md` (rewritten 2026-05-11) — D-07 + D-Discretion notes Phase 4 verify must assert listener survives bootstrap re-run once Phase 6 lands. Phase 6 ships the systemd unit + `daemon-reload`/`restart` hook in `droplet/bootstrap.sh` (D-19/D-20).
- `.planning/phases/05-multi-source/05-CONTEXT.md` — D-03 (`SHELL_SAFE_RE` source-name shape) flows to D-08 here. D-04 (`GITHUB_SOURCES` env var) is the source-of-truth for "what sources do we accept webhooks for". D-05 (`detect-account-type.sh`) reusable in `register-webhooks` (D-21).

### Phase 3 baseline (no direct interaction)
- `.planning/phases/03-restore/03-CONTEXT.md` — `restoreTestRepo` field shape is the template for `webhookTestRepo` (D-25 group 4).

### External docs (do NOT inline; planner Reads as needed)
- GitHub webhooks: https://docs.github.com/en/webhooks/webhook-events-and-payloads#push (push event payload schema)
- GitHub webhook security: https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries (HMAC verification)
- Caddyfile reference: https://caddyserver.com/docs/caddyfile (Let's Encrypt is automatic, no extra config)
- systemd unit reference: https://www.freedesktop.org/software/systemd/man/systemd.service.html (for the `Restart=on-failure` etc. semantics)

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `scripts/lib/config.ts` — Add `webhookHostname?: string` and `webhookTestRepo?: string` to the `Config` interface; `loadConfig` validation should require `webhookHostname` if `cfg.sources` is non-empty (i.e. always at v1, since multi-source ships before this).
- `scripts/lib/ssh.ts` — `sshFlags`, `sshRun`, `runCapture`, `runVisible` directly reusable for `register-webhooks.ts` (reads webhook secret over SSH) and `verify/phase-6.ts`.
- `scripts/lib/doctl.ts` — Reusable for the firewall-rule modification in `create-droplet.ts` (D-23).
- `scripts/verify/phase-1.ts` — `assert`, `sshCapture`, `sshExitsZero` patterns; copy-paste shape for `verify/phase-6.ts`. (Phase 4 D-Discretion already raised the question of extracting these into `lib/ssh.ts` — Phase 6 adding a 4th copy makes the case stronger.)
- `droplet/github-backup.sh` — Existing per-repo loop body. Extract verbatim into `sync-one-repo.sh`; the loop in `github-backup.sh` becomes ~10 lines that calls the new script. Preserves all existing single-instance flock + log + summary semantics.
- Phase 5's `droplet/lib/detect-account-type.sh` (per Phase 5 D-05) — used by `register-webhooks` to decide between `gh api users/<src>/repos` and `gh api orgs/<src>/repos`.

### Established Patterns
- **TypeScript + tsx + npm script** for every operator-facing command. `register-webhooks` and `verify:phase-6` follow.
- **Skip-if-exists with explicit log + opt-in overwrite** (Phase 4 D-01/D-02). D-07/D-09 here mirror that posture for webhook secrets.
- **Marker-line idempotency on the droplet** (Phase 4 D-05 cron marker, Phase 6 systemd unit name). Caddy config and listener.js are always overwritten; systemd unit name `github-backup-webhook` is the implicit marker.
- **Per-source shell-safe naming** (Phase 5 D-03 `SHELL_SAFE_RE`). `WEBHOOK_SECRET_<SOURCE_UPPER>` env var name relies on this.
- **Atomic temp + rename** for state files (Phase 2 D-03 `last-run.json`). `last-webhook-event.json` follows.
- **Sibling state files, not merged schema** — Phase 5 D-11 keeps `last-run.json` per-source; Phase 6 D-17 ships a separate `last-webhook-event.json` rather than expanding the existing file. Status command (Phase 2) reads both.

### Integration Points
- **New file:** `droplet/sync-one-repo.sh` — Per-repo handler, called by both cron and webhook.
- **Edit:** `droplet/github-backup.sh` — Loop body delegates to `sync-one-repo.sh`. Aggregate logic stays.
- **New file:** `droplet/webhook-listener.js` — vanilla Node, zero deps, ~150 LOC.
- **New file:** `droplet/Caddyfile.template` — One reverse-proxy block, hostname placeholder.
- **New file:** `droplet/github-backup-webhook.service` — systemd unit template.
- **Edit:** `droplet/bootstrap.sh` — Install Caddy + nodejs, write Caddyfile + listener.js + systemd unit, `daemon-reload`, `enable --now`, `caddy reload` (D-19).
- **New file:** `scripts/register-webhooks.ts` — Operator-side TS command (D-21/D-22).
- **New file:** `scripts/verify/phase-6.ts` — Six assertion groups (D-26).
- **Edit:** `scripts/create-droplet.ts` — Add 80 + 443 to firewall inbound rules; preserve idempotency (D-23).
- **Edit:** `scripts/bootstrap-droplet.ts` — Ensure `--rotate-webhook-secrets` flag plumbing; ensure on first bootstrap the generated webhook secrets are echoed to stdout for the operator (D-07).
- **Edit:** `scripts/lib/config.ts` — Add `webhookHostname` and `webhookTestRepo` to `Config`; tighten `loadConfig` to require `webhookHostname`.
- **Edit:** `package.json` — Add `register-webhooks`, `verify:phase-6` script entries.
- **Edit:** `README.md` — New section: webhook setup (DNS, register, troubleshoot). Update Lifecycle paragraph to mention `journalctl -u github-backup-webhook -f`.
- **No change:** `droplet/install-cron.sh` (cron entry unchanged — still calls `github-backup.sh`), `scripts/lib/{ssh,doctl}.ts`.

</code_context>

<specifics>
## Specific Ideas

- The "listener writes to a queue + systemd-run worker" split (D-02/D-03) is the single most important architectural choice. Without it, a slow `git remote update` blocks the HTTPS handler, GitHub times out and retries, and we end up doing 3-5 syncs of the same push. With it, the handler is sub-second and GitHub stays happy.
- Caddy was chosen over nginx specifically because its zero-config Let's Encrypt is bulletproof. nginx + certbot needs a renewal cron, a reload hook, and an explicit ACME challenge config. Caddy does all three by default. Operator gains zero ops surface.
- Per-repo locks (D-16) seem fussy but the alternative — webhook handler waits on the global cron lock — means a 30-minute nightly cron sweep blocks every push event for half an hour. The per-repo lock is the only way both triggers genuinely coexist.
- Source resolution by `payload.repository.owner.login` (D-11) works only because PROJECT.md is single-operator. A multi-tenant version would need explicit per-source webhook secrets keyed by URL path (`/webhook/<source>`). Keeping the contract `payload-derived` makes the URL stable and avoids a per-source DNS / path explosion.
- `register-webhooks` (D-21) is operator-side TS, not droplet-side bash, because it needs the operator's `gh auth` (which has the right scopes to create webhooks; the droplet's `GITHUB_TOKEN` may or may not have `admin:repo_hook` and we don't want to require expanding it).
- `webhookTestRepo` (D-25 group 4) is intentionally a separate field from `restoreTestRepo` (Phase 3 D-01) — same shape, different purpose. The operator may want to test webhook against a fresh sandbox repo without polluting the restore test.

</specifics>

<deferred>
## Deferred Ideas

- **GitHub App (vs per-repo webhooks)** — single install hook for an entire org, no per-repo registration. Worth it at >50 repos per source; v1 single-operator scale doesn't justify the App-creation overhead. Capture for v2.
- **Repository event types beyond `push`** (`repository.created`/`deleted`/`renamed`, `release.published`) — cron sweep catches new repos within `CRON_SCHEDULE`, deletes leave orphans (Phase 2 deferred), renames create stale dirs. Document as known limitations; defer richer handling.
- **Webhook delivery retries from our side** (queue with exponential backoff if `sync-one-repo.sh` fails) — GitHub already retries on non-2xx, and cron is the safety net. Adding our own retry layer is duplicative.
- **Per-repo webhook secrets** — overkill at single-operator scale. Per-source is the right granularity.
- **Listener metrics / Prometheus exporter** — v2 alerting territory per PROJECT.md / Phase 2 deferred.
- **Webhook delivery dashboard** — Phase 2 status command surfaces last event; richer dashboard is v2.
- **Wildcard cert / multi-hostname** — single hostname covers the v1 use case.
- **Strict GitHub source-IP allowlist** (vs `0.0.0.0/0` + HMAC) — adds maintenance pain (IP ranges drift), HMAC is the real gate. Revisit if a real attack surface shows up.
- **HTTP-only fallback** for operators without a domain — GitHub rejects insecure URLs, no fallback possible. Buy a domain (or use a free one — `nip.io` doesn't help because it doesn't have a real cert).
- **Per-event audit log** (every webhook delivery written to durable storage for compliance) — not a v1 requirement at single-operator scale.
- **Listener auto-update from the droplet** (e.g. self-update on push to a "deploy" repo) — chicken-and-egg, security smell. Operator runs `npm run bootstrap-droplet` to push code changes, same as today.

</deferred>

---

*Phase: 06-webhook*
*Context gathered: 2026-05-11*

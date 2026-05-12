# Phase 6: Webhook listener - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-05-11
**Phase:** 06-webhook
**Areas discussed:** Listener runtime, HTTPS termination, DNS, secret management, HMAC verification, source resolution, event handling, per-repo sync DRY, lock contention, run-state recording, bootstrap integration, webhook registration, firewall, verify scope.

> Operator delegated full design to Claude after the cron→webhook+cron pivot was confirmed. Decisions below are Claude's, with operator-locked constraints honoured.

---

## Listener runtime (D-01, D-02, D-03)

| Option | Description | Selected |
|--------|-------------|----------|
| Bash + socat / netcat | Pure bash on droplet, no new runtime. Brittle for HMAC + JSON parsing; HTTPS termination requires sidecar anyway. | |
| Node.js (vanilla, zero deps) + Caddy reverse proxy | `apt install nodejs caddy`. ~150 LOC listener. Crypto + JSON + http built in. | ✓ |
| Bun single-binary + Caddy | Smaller startup, single binary. Adds less-stable runtime dependency. | |
| Python + Flask/FastAPI + Caddy | Heavier dep tree (`pip install`), but mature ecosystem. | |
| Caddy with built-in `exec` directive (no separate listener) | Caddy's `exec` plugin runs a shell command per request. Simplest possible. Doesn't easily support the queue+worker split. | |

**Choice:** Node.js + Caddy reverse proxy.
**Notes:** D-02/D-03: listener writes to a queue file + dispatches via `systemd-run --collect --no-block` per event. Keeps HTTPS handler sub-second so GitHub doesn't time out and retry.

---

## HTTPS termination (D-05)

| Option | Description | Selected |
|--------|-------------|----------|
| Caddy + automatic Let's Encrypt | One-line Caddyfile, ACME built in, HTTP→HTTPS redirect free. | ✓ |
| nginx + certbot | Mature but needs renewal cron, reload hook, explicit ACME config. | |
| Listener handles TLS directly | Node `https.createServer`. Cert renewal becomes our problem. | |
| DigitalOcean Load Balancer | $12/mo extra, overkill at single-droplet scale. | |

**Choice:** Caddy.
**Notes:** Zero ops surface for cert renewal is the deciding factor.

---

## DNS / hostname (D-04, D-06)

| Option | Description | Selected |
|--------|-------------|----------|
| Operator brings a domain (`webhookHostname` in config) | Required for LE. Operator creates A record → droplet IP. | ✓ |
| Use droplet's auto-IP rDNS / `nip.io` style | No real cert possible; LE rejects. | |
| Self-signed cert | GitHub rejects insecure webhook URLs. | |
| Skip HTTPS entirely | GitHub rejects HTTP webhooks (well, supports them but they're discouraged and lose payload integrity). | |

**Choice:** Operator brings a domain.
**Notes:** Bootstrap fails loud if `webhookHostname` unset. README documents the A-record requirement.

---

## Secret management (D-07, D-08, D-09)

| Option | Description | Selected |
|--------|-------------|----------|
| Single shared secret across all sources | One secret in `WEBHOOK_SECRET`. Simplest. Compromised secret → all sources affected. | |
| Per-source secret, generated on droplet | One per `<source>` in `cfg.sources`, generated via `openssl rand -hex 32` at bootstrap if absent. Per-source isolation matches Phase 5 boundary. | ✓ |
| Per-repo secret | Maximum isolation, maximum overhead. Re-registering hundreds of webhooks per rotation. | |
| Operator-supplied secret in config | Forces the operator to manage rotation manually; secret in config.json risks accidental commit. | |

**Choice:** Per-source, droplet-generated.
**Notes:** Secrets stored in `backup.env` as `WEBHOOK_SECRET_<SOURCE_UPPER>`. Echoed to operator stdout on first generation. `--rotate-webhook-secrets` flag for deliberate rotation.

---

## HMAC verification (D-10)

| Option | Description | Selected |
|--------|-------------|----------|
| `X-Hub-Signature-256` HMAC-SHA256, constant-time compare | GitHub's spec. Non-negotiable. `crypto.timingSafeEqual`. | ✓ |
| Skip verification (firewall allowlist instead) | GitHub's IP ranges drift. Insecure if anyone else accesses 443. | |
| `X-Hub-Signature` (SHA-1, legacy) | Deprecated. SHA-256 is required for new webhooks. | |

**Choice:** SHA-256 only.
**Notes:** Body must be read raw (Buffer); `JSON.stringify` normalisation breaks the signature.

---

## Source resolution (D-11)

| Option | Description | Selected |
|--------|-------------|----------|
| `<source>` from `payload.repository.owner.login` | Single endpoint URL; payload-derived. Works for user + org sources. | ✓ |
| Per-source URL path (`/webhook/<source>`) | More explicit. More moving parts. Doesn't add security beyond HMAC. | |
| Source from header (operator-set custom header) | Custom config in GitHub UI; brittle, easy to mis-set. | |

**Choice:** Payload-derived `<source>`.
**Notes:** Reject (404, no leak) if source not in `cfg.sources`.

---

## Event handling (D-12, D-13, D-14)

| Option | Description | Selected |
|--------|-------------|----------|
| Only `push` events trigger sync; `ping` returns 200 with `pong`; everything else 204 | Narrow scope, predictable. Cron sweep handles new repos / deletes / renames within `CRON_SCHEDULE`. | ✓ |
| Handle `push` + `repository.created` (auto-mirror new repos before next cron) | Reduces "new repo not backed up" window. Adds an `gh api` call inline to determine where to put it. | |
| Handle full event taxonomy (push, repo, release, ...) | Surface area for v1 — no compelling use case. | |

**Choice:** `push` only (+ `ping` ack).
**Notes:** Repo-renamed creates stale dirs; documented as known limitation.

---

## Per-repo sync handler (D-15, D-16)

| Option | Description | Selected |
|--------|-------------|----------|
| Extract per-repo logic into `droplet/sync-one-repo.sh`; both cron and webhook call it | DRY. Single code path. Per-repo lock inside, global lock only in cron loop. | ✓ |
| Inline git commands in listener; cron stays as-is | Two code paths to maintain. Bug fixes don't propagate. | |
| Move all sync logic into the listener; cron calls listener over HTTP | Adds a network hop for cron. Listener becomes a SPOF for cron too. | |

**Choice:** Extract into `sync-one-repo.sh`.
**Notes:** Per-repo lock (`/var/lock/github-backup-<source>__<owner>_<repo>.lock`) lets cron and webhook coexist on different repos in parallel.

---

## Run-state recording (D-17, D-18)

| Option | Description | Selected |
|--------|-------------|----------|
| Sibling file `last-webhook-event.json` (atomic write) + `WEBHOOK_EVENT_SUMMARY` log line | Mirror Phase 2 D-03/D-04 pattern. Status command (Phase 2) reads both. | ✓ |
| Merge into `last-run.json` | Conflates two distinct trigger paths. Schema drift risk. | |
| systemd journal only (no JSON file) | Status command would need to grep journal — slower, less structured. | |
| Database (sqlite) | Heavyweight. JSON file works for v1. | |

**Choice:** Sibling JSON file + journal logs.
**Notes:** Status command (Phase 2) gains a small additive read; tracked under THIS phase's plan.

---

## Bootstrap integration (D-19, D-20)

| Option | Description | Selected |
|--------|-------------|----------|
| Bootstrap installs Caddy + nodejs + writes Caddyfile + listener.js + systemd unit; `daemon-reload && enable --now && caddy reload` | Idempotent at OS level. Fulfils Phase 4 D-07 listener-restart hook. | ✓ |
| Separate `npm run install-webhook-listener` command | Adds a step. Operator might forget. Bootstrap is the single install entry point per PROV-02. | |
| Docker container for the listener | Heavier dependency. Doesn't fit single-droplet ethos. | |

**Choice:** Inline in `droplet/bootstrap.sh`.
**Notes:** Phase 4's verify must additionally assert listener survives bootstrap re-run once Phase 6 lands.

---

## Webhook registration (D-21, D-22)

| Option | Description | Selected |
|--------|-------------|----------|
| `npm run register-webhooks` (TS, runs locally) — iterates sources, idempotently creates missing webhooks via `gh api` | Operator-side because operator's `gh auth` has the right scopes. Idempotent. | ✓ |
| Auto-register on first webhook event | Chicken-and-egg: no event arrives until webhook is registered. | |
| Manual operator step (GitHub UI per repo) | Tedious at any non-trivial repo count. Error-prone. | |
| Droplet-side script that uses `GITHUB_TOKEN` | `GITHUB_TOKEN` may not have `admin:repo_hook` scope; expanding it adds risk. | |

**Choice:** Operator-side `register-webhooks` TS command.
**Notes:** `--update` flag for secret rotation. `--dry-run` is Claude's discretion (D-21 sub).

---

## Firewall (D-23, D-24)

| Option | Description | Selected |
|--------|-------------|----------|
| Open 80 + 443 from `0.0.0.0/0`; HMAC is the real security gate | Stable. Caddy needs 80 for ACME. HMAC stops abuse. | ✓ |
| GitHub source IP allowlist from `gh api meta` | Tighter, but IP ranges drift. Re-running create-droplet to refresh defeats idempotency. | |
| Skip firewall change; require operator to do it manually | Defeats the "fire-and-forget" project ethos. | |
| Cloudflare in front (filters by source) | Adds a third-party dependency. Out of single-droplet posture. | |

**Choice:** `0.0.0.0/0` on 80 + 443.
**Notes:** PROV-01 idempotency must continue to pass after `create-droplet` re-runs.

---

## verify:phase-6 (D-25, D-26)

| Option | Description | Selected |
|--------|-------------|----------|
| 6 assertion groups: pre-conds → bad source → bad sig → end-to-end push (env-gated) → idempotency → restart survival | Mirrors Phase 1/3/4 fail-fast template. Covers all SCs. | ✓ |
| Smoke-only (skip per-assertion structure) | Less diagnostic when something breaks. | |
| Pure unit tests of listener.js (no live droplet) | Doesn't test the integration (Caddy, systemd, DNS, LE cert). | |

**Choice:** 6-group verify against live droplet.
**Notes:** End-to-end requires `cfg.webhookTestRepo` (new field, mirrors Phase 3's `restoreTestRepo`).

---

## Claude's Discretion

- **D-03 sub:** `systemd-run` per event vs long-lived dispatcher process — both viable.
- **D-05 sub:** Wildcard cert / multi-hostname Caddy config — out of v1.
- **D-19 sub:** Caddy from official apt repo (latest) vs Ubuntu-bundled (older).
- **D-21 sub:** `--dry-run` flag for `register-webhooks`.
- **D-23 sub:** Tighter firewall (GH source IPs + LE) vs `0.0.0.0/0`.
- **D-26 group 4 sub:** Synthetic push payload constructed locally vs pulled from real GH webhook delivery log via `gh api`.

## Deferred Ideas

- GitHub App vs per-repo webhooks (v2)
- Event types beyond `push` (`repository.*`, `release.published`)
- Our own retry queue (GitHub already retries; cron is the safety net)
- Per-repo webhook secrets (overkill at this scale)
- Listener metrics / Prometheus exporter (v2 alerting)
- Webhook delivery dashboard (v2)
- Wildcard / multi-hostname cert
- Strict GitHub source-IP allowlist on firewall
- HTTP-only fallback (GitHub rejects)
- Per-event durable audit log
- Listener self-update on push (chicken-and-egg, security smell)

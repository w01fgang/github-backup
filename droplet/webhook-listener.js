#!/usr/bin/env node
// droplet/webhook-listener.js
//
// Tiny HTTPS-handler (behind Caddy) for GitHub push webhooks.
// Multi-source (Phase 9): owner must be in GITHUB_SOURCES from
// /opt/github-backups/backup.env (re-read per request). See
// .planning/phases/03-webhook/03-CONTEXT.md for the v1 design (D-01 ─ D-13, D-17)
// and .planning/phases/09-webhook-multi-source-filter-parity/09-CONTEXT.md for the
// multi-source rescope (D-01 ─ D-05).
//
// REPOS-01 parity (WEBHOOK-04): a push is dispatched only when the repo also
// survives that source's allow/deny globs. The globs are applied by the same
// ${BACKUP_DIR}/lib/filter-repos.sh the cron path sources, so the two mirror
// paths cannot drift. The filter fails CLOSED — an unreadable helper rejects
// the push rather than mirroring a denied repo.
//
// HTTP contract:
//   POST /webhook/github
//     Headers:  X-GitHub-Event, X-Hub-Signature-256, X-GitHub-Delivery, Content-Type
//     Body:     raw JSON (Buffer)
//     200 + "pong"        — ping event
//     202 + JSON          — push accepted and dispatched to sync-one-repo.sh
//     204                 — non-push, non-ping event acknowledged
//     400                 — missing signature, bad JSON, missing owner/repo
//     401                 — HMAC mismatch
//     403                 — repo excluded by that source's allow/deny globs
//     404                 — owner not in GITHUB_SOURCES OR unknown path
//     405                 — method other than POST on /webhook/github
//     413                 — body exceeds WEBHOOK_MAX_BODY_BYTES (checked pre-auth)
//     500                 — backup.env unreadable, filter helper unusable, OR
//                           systemd-run dispatch failure
//
// Env (from systemd EnvironmentFile=/opt/github-backups/backup.env):
//   WEBHOOK_SECRET        required (HMAC verification)
//   BACKUP_DIR            default /opt/github-backups
//   WEBHOOK_LISTEN_PORT   default 9100
//   WEBHOOK_STATE_DIR     default /var/lib/github-backup
//   WEBHOOK_MAX_BODY_BYTES  default 2097152 (2 MiB) — pre-auth request-body cap
//
// Per-request read from /opt/github-backups/backup.env:
//   GITHUB_SOURCES        whitespace-separated set of allowed owner logins.
//   GITHUB_SOURCE_ALLOW_<SLOT> / GITHUB_SOURCE_DENY_<SLOT>
//                         per-source globs; SLOT = owner uppercased with every
//                         non-alphanumeric byte replaced by `_`.
//
// Output:
//   stdout/stderr → systemd journal (journalctl -u github-backup-webhook).
//   /var/lib/github-backup/last-webhook-event.json written atomically after dispatch.
//
"use strict";

const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

function bail(msg) {
  process.stderr.write(`FATAL: ${msg}\n`);
  process.exit(1);
}

/**
 * Per-request env reader. Parses /opt/github-backups/backup.env (or any
 * file in the same format produced by scripts/bootstrap-droplet.ts:80-107).
 *
 * NOTE: Deliberately diverges from the boot-only loading style used for
 * WEBHOOK_SECRET / PORT below — D-01 calls for per-request re-read of
 * GITHUB_SOURCES so an operator regenerating backup.env via
 * `npm run bootstrap-droplet` does not need to restart this service.
 *
 * Handles: K=V (bare), K="V V" (strips exactly one leading + one trailing
 * double-quote), blank lines, # comments. No escape sequences. No single
 * quotes. No `export` prefix. Throws on read/parse error.
 */
function parseEnvFile(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  const out = {};
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue; // skip malformed lines silently — bootstrap output won't produce them
    const key = line.slice(0, eq);
    let val = line.slice(eq + 1);
    if (
      val.length >= 2 &&
      val.charCodeAt(0) === 34 && // "
      val.charCodeAt(val.length - 1) === 34
    ) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

const BACKUP_ENV_PATH = "/opt/github-backups/backup.env";

const SECRET = (process.env.WEBHOOK_SECRET || "").trim();
const PORT = parseInt(process.env.WEBHOOK_LISTEN_PORT || "9100", 10);
const BACKUP_DIR = process.env.BACKUP_DIR || "/opt/github-backups";
const STATE_DIR = process.env.WEBHOOK_STATE_DIR || "/var/lib/github-backup";

// Pre-auth request-body cap. Ports 80/443 are world-reachable, so every byte
// buffered before the HMAC check is memory an unauthenticated caller controls
// on a 1 GB droplet. GitHub caps webhook payloads at 25 MB; real push payloads
// run in the tens of KB, so 2 MiB leaves ample headroom while bounding the
// pre-auth footprint.
const MAX_BODY_BYTES = (() => {
  const raw = process.env.WEBHOOK_MAX_BODY_BYTES;
  if (!raw) return 2 * 1024 * 1024;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    bail(`WEBHOOK_MAX_BODY_BYTES not a positive integer: ${raw}`);
  }
  return n;
})();

if (!SECRET) bail("WEBHOOK_SECRET not set (load /opt/github-backups/backup.env)");
if (!Number.isFinite(PORT)) {
  bail(`WEBHOOK_LISTEN_PORT not a number: ${process.env.WEBHOOK_LISTEN_PORT}`);
}

fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });

const LAST_EVENT_PATH = path.join(STATE_DIR, "last-webhook-event.json");
const SYNC_SCRIPT = path.join(BACKUP_DIR, "sync-one-repo.sh");
const ARG_RE = /^[A-Za-z0-9._-]+$/;
const FILTER_LIB = path.join(BACKUP_DIR, "lib", "filter-repos.sh");

/**
 * Env-var slot for a source name. MUST match github-backup.sh's bash `slot()`
 * and bootstrap-droplet.ts's `envSlot()` byte-for-byte: uppercase, then every
 * non-alphanumeric char becomes `_`.
 */
function envSlot(name) {
  return name.toUpperCase().replace(/[^A-Z0-9]/g, "_");
}

/**
 * REPOS-01 (WEBHOOK-04): does <owner>/<repo> survive that source's globs?
 *
 * Delegates to the same `filter_repos` the cron path sources rather than
 * reimplementing bash `case` glob semantics in JS — one implementation, no
 * drift. Empty allow AND empty deny means no filter is configured for the
 * source, which is pass-through (ROADMAP SC#5) and skips the subprocess.
 *
 * Throws when the helper cannot be run, so the caller fails CLOSED.
 */
function passesRepoFilter(owner, repo, env) {
  const slot = envSlot(owner);
  const allow = (env[`GITHUB_SOURCE_ALLOW_${slot}`] || "").trim();
  const deny = (env[`GITHUB_SOURCE_DENY_${slot}`] || "").trim();
  if (!allow && !deny) return true;

  const full = `${owner}/${repo}`;
  const r = spawnSync(
    "/bin/bash",
    [
      "-c",
      'source "$0"; printf \'%s\\n\' "$1" | filter_repos "$2" "$3" "$4"',
      FILTER_LIB,
      full,
      owner,
      allow,
      deny,
    ],
    { encoding: "utf8" }
  );
  if (r.error || r.status !== 0) {
    throw new Error(
      `filter_repos unusable (${FILTER_LIB}): ${
        r.error ? r.error.message : `exit ${r.status}`
      }`
    );
  }
  return r.stdout.trim() === full;
}

function writeLastEvent(obj) {
  const tmp = `${LAST_EVENT_PATH}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, LAST_EVENT_PATH);
}

function logLine(req, status, extra) {
  const ts = new Date().toISOString();
  const parts = Object.entries(extra || {})
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
  process.stdout.write(
    `[${ts}] ${req.method} ${req.url} ${status}${parts ? " " + parts : ""}\n`
  );
}

function verifyHmac(buf, headerValue) {
  if (!headerValue || typeof headerValue !== "string") return false;
  const expected =
    "sha256=" + crypto.createHmac("sha256", SECRET).update(buf).digest("hex");
  const expBuf = Buffer.from(expected, "utf8");
  const gotBuf = Buffer.from(headerValue, "utf8");
  if (expBuf.length !== gotBuf.length) return false;
  return crypto.timingSafeEqual(expBuf, gotBuf);
}

const server = http.createServer((req, res) => {
  const t0 = Date.now();

  if (req.url !== "/webhook/github") {
    res.writeHead(404).end();
    logLine(req, 404, { reason: "unknown_path" });
    return;
  }
  if (req.method !== "POST") {
    res.writeHead(405).end();
    logLine(req, 405, { reason: "method_not_allowed" });
    return;
  }

  // Body cap runs BEFORE any buffering decision, so an unauthenticated caller
  // cannot make the process hold more than MAX_BODY_BYTES.
  const chunks = [];
  let received = 0;
  let stopped = false;

  const rejectTooLarge = (reason, bytes) => {
    if (stopped) return;
    stopped = true;
    res.writeHead(413, { Connection: "close" }).end();
    logLine(req, 413, { reason, bytes, limit: MAX_BODY_BYTES });
    req.destroy();
  };

  // Trust the declared length only to reject early; a lying/absent header is
  // still caught by the streaming guard below.
  const declared = Number.parseInt(req.headers["content-length"] || "", 10);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    rejectTooLarge("content_length_too_large", declared);
    return;
  }

  // A destroyed/aborted request surfaces here; swallow so the process-level
  // uncaughtException handler stays for real faults.
  req.on("error", () => {
    stopped = true;
  });

  req.on("data", (c) => {
    if (stopped) return;
    received += c.length;
    if (received > MAX_BODY_BYTES) {
      rejectTooLarge("body_too_large", received);
      return;
    }
    chunks.push(c);
  });

  req.on("end", () => {
    if (stopped) return;
    const buf = Buffer.concat(chunks);
    const event = req.headers["x-github-event"];
    const delivery = req.headers["x-github-delivery"] || "unknown";
    const sig = req.headers["x-hub-signature-256"];

    if (!sig) {
      res.writeHead(401).end();
      logLine(req, 401, { delivery, event, reason: "missing_signature" });
      return;
    }
    if (!verifyHmac(buf, sig)) {
      res.writeHead(401).end();
      logLine(req, 401, { delivery, event, reason: "hmac_fail" });
      return;
    }

    if (event === "ping") {
      res.writeHead(200, { "Content-Type": "text/plain" }).end("pong");
      logLine(req, 200, { delivery, event: "ping" });
      return;
    }

    if (event !== "push") {
      res.writeHead(204).end();
      logLine(req, 204, { delivery, event });
      return;
    }

    let payload;
    try {
      payload = JSON.parse(buf.toString("utf8"));
    } catch (e) {
      res.writeHead(400).end();
      logLine(req, 400, { delivery, reason: "json_parse" });
      return;
    }

    const owner = payload && payload.repository && payload.repository.owner
      ? payload.repository.owner.login
      : undefined;
    const repo = payload && payload.repository ? payload.repository.name : undefined;

    if (!owner || !repo) {
      res.writeHead(400).end();
      logLine(req, 400, { delivery, reason: "missing_owner_or_repo" });
      return;
    }

    let backupEnv;
    let allowedSources;
    try {
      backupEnv = parseEnvFile(BACKUP_ENV_PATH);
      const raw = backupEnv.GITHUB_SOURCES || "";
      allowedSources = new Set(raw.split(/\s+/).filter(Boolean));
      if (allowedSources.size === 0) {
        throw new Error("GITHUB_SOURCES empty or missing in backup.env");
      }
    } catch (e) {
      res.writeHead(500).end();
      logLine(req, 500, { delivery, reason: "backup_env_unreadable" });
      return;
    }

    if (!allowedSources.has(owner)) {
      res.writeHead(404).end();
      logLine(req, 404, { delivery, owner, reason: "unknown_source" });
      return;
    }

    if (!ARG_RE.test(owner) || !ARG_RE.test(repo)) {
      res.writeHead(400).end();
      logLine(req, 400, { delivery, reason: "arg_shape" });
      return;
    }

    // REPOS-01 parity (WEBHOOK-04). Shape-checked above, so the values handed
    // to the helper are already constrained to [A-Za-z0-9._-].
    let kept;
    try {
      kept = passesRepoFilter(owner, repo, backupEnv);
    } catch (e) {
      res.writeHead(500).end();
      logLine(req, 500, { delivery, owner, repo, reason: "filter_unavailable" });
      process.stderr.write(`WARN: ${e.message}\n`);
      return;
    }
    if (!kept) {
      res.writeHead(403).end();
      logLine(req, 403, { delivery, owner, repo, reason: "repo_denied" });
      return;
    }

    const r = spawnSync(
      "/usr/bin/systemd-run",
      ["--collect", "--no-block", SYNC_SCRIPT, owner, owner, repo],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
    const dispatchOk = r.status === 0;
    const elapsed = Date.now() - t0;
    const evt = {
      received_at: new Date().toISOString(),
      source: owner,
      owner,
      repo,
      delivery_id: delivery,
      action: dispatchOk ? "dispatched" : "dispatch_fail",
      exit_code: r.status === null ? -1 : r.status,
      duration_ms: elapsed,
    };
    try {
      writeLastEvent(evt);
    } catch (e) {
      process.stderr.write(`WARN: writeLastEvent failed: ${e.message}\n`);
    }

    if (dispatchOk) {
      res
        .writeHead(202, { "Content-Type": "application/json" })
        .end(JSON.stringify({ ok: true, delivery_id: delivery, owner, repo }));
      logLine(req, 202, { delivery, owner, repo, ms: elapsed });
    } else {
      const stderrSnippet = (r.stderr ? r.stderr.toString() : "").slice(0, 200);
      res
        .writeHead(500, { "Content-Type": "application/json" })
        .end(JSON.stringify({ ok: false, error: "dispatch_failed" }));
      logLine(req, 500, {
        delivery,
        owner,
        repo,
        ms: elapsed,
        stderr: JSON.stringify(stderrSnippet),
      });
    }
  });
});

process.on("uncaughtException", (e) => {
  process.stderr.write(`uncaught: ${e && e.stack ? e.stack : e}\n`);
  process.exit(1);
});
process.on("unhandledRejection", (e) => {
  process.stderr.write(`unhandled: ${e}\n`);
  process.exit(1);
});

server.listen(PORT, "127.0.0.1", () => {
  process.stdout.write(
    `[${new Date().toISOString()}] webhook-listener up on 127.0.0.1:${PORT} (env=${BACKUP_ENV_PATH})\n`
  );
});

#!/usr/bin/env node
// droplet/webhook-listener.js
//
// Tiny HTTPS-handler (behind Caddy) for GitHub push webhooks.
// Multi-source (Phase 9): owner must be in GITHUB_SOURCES from
// /opt/github-backups/backup.env (re-read per request). See
// .planning/phases/03-webhook/03-CONTEXT.md for the v1 design (D-01 ─ D-13, D-17)
// and .planning/phases/09-webhook-multi-source-filter-parity/09-CONTEXT.md for the
// multi-source rescope (D-01 ─ D-05, WEBHOOK-04 dropped 2026-05-17).
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
//     404                 — owner not in GITHUB_SOURCES OR unknown path
//     405                 — method other than POST on /webhook/github
//     500                 — backup.env unreadable OR systemd-run dispatch failure
//
// Env (from systemd EnvironmentFile=/opt/github-backups/backup.env):
//   WEBHOOK_SECRET        required (HMAC verification)
//   BACKUP_DIR            default /opt/github-backups
//   WEBHOOK_LISTEN_PORT   default 9100
//   WEBHOOK_STATE_DIR     default /var/lib/github-backup
//
// Per-request read from /opt/github-backups/backup.env:
//   GITHUB_SOURCES        whitespace-separated set of allowed owner logins.
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

if (!SECRET) bail("WEBHOOK_SECRET not set (load /opt/github-backups/backup.env)");
if (!Number.isFinite(PORT)) {
  bail(`WEBHOOK_LISTEN_PORT not a number: ${process.env.WEBHOOK_LISTEN_PORT}`);
}

fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });

const LAST_EVENT_PATH = path.join(STATE_DIR, "last-webhook-event.json");
const SYNC_SCRIPT = path.join(BACKUP_DIR, "sync-one-repo.sh");
const ARG_RE = /^[A-Za-z0-9._-]+$/;

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

  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
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

    let allowedSources;
    try {
      const env = parseEnvFile(BACKUP_ENV_PATH);
      const raw = env.GITHUB_SOURCES || "";
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

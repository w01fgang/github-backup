#!/usr/bin/env node
// droplet/webhook-listener.js
//
// Tiny HTTPS-handler (behind Caddy) for GitHub push webhooks.
// Single-operator, single-source at v1. See
// .planning/phases/03-webhook/03-CONTEXT.md for the full design (D-01 ─ D-13, D-17).
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
//     404                 — source not in cfg (owner mismatch) OR unknown path
//     405                 — method other than POST on /webhook/github
//     500                 — systemd-run dispatch failure
//
// Env (from systemd EnvironmentFile=/opt/github-backups/backup.env):
//   WEBHOOK_SECRET        required (single source at v1)
//   GITHUB_USER_OR_ORG    required (the allowed source for v1)
//   BACKUP_DIR            default /opt/github-backups
//   WEBHOOK_LISTEN_PORT   default 9100
//   WEBHOOK_STATE_DIR     default /var/lib/github-backup
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

const SECRET = (process.env.WEBHOOK_SECRET || "").trim();
const ALLOWED_SOURCE = (process.env.GITHUB_USER_OR_ORG || "").trim();
const PORT = parseInt(process.env.WEBHOOK_LISTEN_PORT || "9100", 10);
const BACKUP_DIR = process.env.BACKUP_DIR || "/opt/github-backups";
const STATE_DIR = process.env.WEBHOOK_STATE_DIR || "/var/lib/github-backup";

if (!SECRET) bail("WEBHOOK_SECRET not set (load /opt/github-backups/backup.env)");
if (!ALLOWED_SOURCE) bail("GITHUB_USER_OR_ORG not set");
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

    if (owner !== ALLOWED_SOURCE) {
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
    `[${new Date().toISOString()}] webhook-listener up on 127.0.0.1:${PORT} (source=${ALLOWED_SOURCE})\n`
  );
});

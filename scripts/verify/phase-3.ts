#!/usr/bin/env node
/**
 * scripts/verify/phase-3.ts
 *
 * Per-phase executable verification for Phase 3 (TEST-02 / TEST-03 / D-26).
 *
 * Six fail-fast assertion groups against a live droplet:
 *   1. Pre-conditions  (DNS, HTTPS reach, LE cert validity, systemd units)
 *   2. Source resolution (unknown owner → 404)
 *   3. Bad signature (wrong HMAC → 401)
 *   4. End-to-end push (env-gated on cfg.webhookTestRepo)
 *   5. Idempotency (ping twice → 200 twice)
 *   6. Listener-restart survival
 *
 * Usage:
 *   npm run verify:phase-3
 *
 * Exits 0 only when every assertion passes. No external test framework —
 * matches the verify:phase-1 / verify:phase-4 shape exactly.
 */

import * as crypto from "crypto";
import * as https from "https";
import * as dns from "dns/promises";
import {
  loadConfig,
  loadDropletInfo,
  type Config,
  type DropletInfo,
} from "../lib/config";
import { sshFlags, runCapture } from "../lib/ssh";

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`✗ ${msg}`);
    process.exit(1);
  }
  console.log(`✓ ${msg}`);
}

function sshCapture(
  cfg: Config,
  droplet: DropletInfo,
  remote: string
): string {
  // JSON.stringify quotes the remote command for the local shell. Safe for
  // any string the verify groups build; the listener never sees this — only
  // the local ssh client + bash do.
  const cmd =
    `ssh ${sshFlags(cfg.sshKeyPath)} ${cfg.sshUser}@${droplet.ip} ` +
    JSON.stringify(remote);
  return runCapture(cmd);
}

function signPayload(body: Buffer, secret: string): string {
  return (
    "sha256=" + crypto.createHmac("sha256", secret).update(body).digest("hex")
  );
}

interface PostResult {
  status: number;
  body: string;
  headers: Record<string, string>;
}

function postWebhook(
  hostname: string,
  body: Buffer,
  headers: Record<string, string>
): Promise<PostResult> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        method: "POST",
        host: hostname,
        path: "/webhook/github",
        port: 443,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": body.length,
          ...headers,
        },
        timeout: 10_000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const headerEntries = Object.entries(res.headers).map(
            ([k, v]): [string, string] => [
              k,
              Array.isArray(v) ? v.join(",") : String(v ?? ""),
            ]
          );
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
            headers: Object.fromEntries(headerEntries),
          });
        });
      }
    );
    req.on("timeout", () => {
      req.destroy(new Error("request timeout"));
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function makeDelivery(): string {
  return crypto.randomBytes(16).toString("hex");
}

function syntheticPushPayload(owner: string, repo: string): Buffer {
  // Minimal GitHub push event shape; only fields the listener inspects.
  // `after` is a deterministic-but-novel sha — listener doesn't validate it.
  const obj = {
    ref: "refs/heads/main",
    after: crypto
      .createHash("sha1")
      .update(new Date().toISOString())
      .digest("hex"),
    before: "0".repeat(40),
    repository: { name: repo, owner: { login: owner } },
  };
  return Buffer.from(JSON.stringify(obj));
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const droplet = loadDropletInfo();

  // ── Read WEBHOOK_SECRET from droplet (single SSH read) ──────────────────
  let secret = "";
  try {
    const line = sshCapture(
      cfg,
      droplet,
      "grep ^WEBHOOK_SECRET= /opt/github-backups/backup.env"
    ).trim();
    if (line.startsWith("WEBHOOK_SECRET=")) {
      secret = line.slice("WEBHOOK_SECRET=".length).trim();
    }
  } catch (e) {
    console.error(
      `✗ Could not read WEBHOOK_SECRET from droplet: ${e instanceof Error ? e.message : e}`
    );
    process.exit(1);
  }
  assert(
    /^[a-f0-9]{64}$/.test(secret),
    "WEBHOOK_SECRET on droplet is 64 hex chars"
  );

  // ── Group 1: Pre-conditions ────────────────────────────────────────────
  console.log("\n── Group 1: Pre-conditions");

  const resolved = await dns
    .resolve4(cfg.webhookHostname)
    .catch(() => [] as string[]);
  assert(
    resolved.includes(droplet.ip),
    `DNS A record for ${cfg.webhookHostname} resolves to ${droplet.ip} (got: [${resolved.join(",")}])`
  );

  const probe = await new Promise<{ status: number }>((resolve, reject) => {
    const r = https.request(
      {
        method: "GET",
        host: cfg.webhookHostname,
        path: "/webhook/github",
        port: 443,
        timeout: 10_000,
      },
      (res) => {
        res.resume();
        resolve({ status: res.statusCode ?? 0 });
      }
    );
    r.on("error", reject);
    r.on("timeout", () => {
      r.destroy(new Error("timeout"));
    });
    r.end();
  });
  assert(
    probe.status === 405,
    `GET https://${cfg.webhookHostname}/webhook/github returns 405 (got ${probe.status})`
  );

  const certEndDate = sshCapture(
    cfg,
    droplet,
    `echo | openssl s_client -servername ${cfg.webhookHostname} -connect ${cfg.webhookHostname}:443 2>/dev/null | openssl x509 -noout -enddate`
  ).trim();
  const m = certEndDate.match(/notAfter=(.+)/);
  assert(!!m, `openssl returned a notAfter line (got: ${certEndDate})`);
  const expiryMs = m ? Date.parse(m[1]) : NaN;
  assert(
    Number.isFinite(expiryMs) && expiryMs > Date.now(),
    `Let's Encrypt cert valid until ${m ? m[1] : "?"}`
  );

  assert(
    sshCapture(cfg, droplet, "systemctl is-active github-backup-webhook").trim() ===
      "active",
    "github-backup-webhook.service is active"
  );
  assert(
    sshCapture(cfg, droplet, "systemctl is-active caddy").trim() === "active",
    "caddy.service is active"
  );

  // ── Group 2: Source resolution (unknown owner → 404) ───────────────────
  console.log("\n── Group 2: Source resolution");
  {
    const body = syntheticPushPayload(
      "definitely-not-a-real-owner-abc123",
      "anything"
    );
    const sig = signPayload(body, secret);
    const r = await postWebhook(cfg.webhookHostname, body, {
      "X-GitHub-Event": "push",
      "X-GitHub-Delivery": makeDelivery(),
      "X-Hub-Signature-256": sig,
      "User-Agent": "GitHub-Hookshot/test",
    });
    assert(r.status === 404, `Unknown owner returns 404 (got ${r.status})`);
  }

  // ── Group 3: Bad signature → 401 ───────────────────────────────────────
  console.log("\n── Group 3: Bad signature");
  {
    const body = syntheticPushPayload(cfg.sources[0].name, "repo-doesnt-matter");
    const badSig = signPayload(body, "nope".repeat(16));
    const r = await postWebhook(cfg.webhookHostname, body, {
      "X-GitHub-Event": "push",
      "X-GitHub-Delivery": makeDelivery(),
      "X-Hub-Signature-256": badSig,
      "User-Agent": "GitHub-Hookshot/test",
    });
    assert(r.status === 401, `Bad signature returns 401 (got ${r.status})`);
  }

  // ── Group 4: End-to-end push (gated on cfg.webhookTestRepo) ────────────
  console.log("\n── Group 4: End-to-end push");
  if (!cfg.webhookTestRepo) {
    console.log("[skip] cfg.webhookTestRepo not set — group 4 not run");
  } else {
    const [owner, repo] = cfg.webhookTestRepo.split("/");
    assert(
      cfg.sources.some((s) => s.name === owner),
      `cfg.webhookTestRepo owner "${owner}" matches a configured source name (Phase 6 multi-source: webhookTestRepo owner must be one of ${JSON.stringify(cfg.sources.map((s) => s.name))})`
    );
    const body = syntheticPushPayload(owner, repo);
    const delivery = makeDelivery();
    const sig = signPayload(body, secret);
    const r = await postWebhook(cfg.webhookHostname, body, {
      "X-GitHub-Event": "push",
      "X-GitHub-Delivery": delivery,
      "X-Hub-Signature-256": sig,
      "User-Agent": "GitHub-Hookshot/test",
    });
    assert(r.status === 202, `Signed push returns 202 (got ${r.status})`);

    // Poll the log for a matching BACKUP_REPO_RESULT line.
    const grepCmd =
      `grep -E '^\\[.*\\] BACKUP_REPO_RESULT source=${owner} owner=${owner} repo=${repo} action=(clone|update|fail)' ` +
      `/var/log/github-backup.log | tail -1`;
    let line = "";
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      try {
        line = sshCapture(cfg, droplet, grepCmd).trim();
      } catch {
        line = "";
      }
      if (line) break;
      await new Promise((res) => setTimeout(res, 1_000));
    }
    assert(
      !!line,
      `BACKUP_REPO_RESULT line for ${owner}/${repo} appeared in /var/log/github-backup.log within 30s`
    );
    assert(
      !/action=fail/.test(line),
      `Sync action for ${owner}/${repo} is clone|update, not fail (line: ${line})`
    );

    const eventJson = sshCapture(
      cfg,
      droplet,
      "cat /var/lib/github-backup/last-webhook-event.json"
    ).trim();
    const ev = JSON.parse(eventJson) as {
      owner?: string;
      repo?: string;
      action?: string;
    };
    assert(
      ev.owner === owner && ev.repo === repo,
      `last-webhook-event.json names ${owner}/${repo}`
    );
    assert(
      ev.action === "dispatched",
      `last-webhook-event.json action=dispatched`
    );
  }

  // ── Group 5: Idempotency (ping twice) ──────────────────────────────────
  console.log("\n── Group 5: Idempotency");
  for (let i = 0; i < 2; i++) {
    const body = Buffer.from(
      JSON.stringify({ zen: "Anything added dilutes everything else." })
    );
    const sig = signPayload(body, secret);
    const r = await postWebhook(cfg.webhookHostname, body, {
      "X-GitHub-Event": "ping",
      "X-GitHub-Delivery": makeDelivery(),
      "X-Hub-Signature-256": sig,
      "User-Agent": "GitHub-Hookshot/test",
    });
    assert(
      r.status === 200 && r.body.startsWith("pong"),
      `ping ${i + 1}/2 returns 200 + pong`
    );
  }

  // ── Group 6: Listener-restart survival ─────────────────────────────────
  console.log("\n── Group 6: Listener-restart survival");
  sshCapture(cfg, droplet, "systemctl restart github-backup-webhook");
  await new Promise((res) => setTimeout(res, 3_000));
  assert(
    sshCapture(cfg, droplet, "systemctl is-active github-backup-webhook").trim() ===
      "active",
    "github-backup-webhook is active after restart"
  );
  {
    const body = Buffer.from(JSON.stringify({ zen: "post-restart" }));
    const sig = signPayload(body, secret);
    const r = await postWebhook(cfg.webhookHostname, body, {
      "X-GitHub-Event": "ping",
      "X-GitHub-Delivery": makeDelivery(),
      "X-Hub-Signature-256": sig,
      "User-Agent": "GitHub-Hookshot/test",
    });
    assert(r.status === 200, "ping after restart returns 200");
  }

  // ── Group 7: Multi-source routing (WEBHOOK-03 regression) ─────────────
  console.log("\n── Group 7: Multi-source routing");
  if (cfg.sources.length < 2) {
    console.log(
      `[skip] WEBHOOK-03 multi-source assertion needs ≥2 sources in ` +
        `config.json; only ${cfg.sources.length} configured. Regression ` +
        `cannot be exercised in this environment.`
    );
  } else {
    const probeRepo = "verify-phase-3-multi-source-probe";
    for (const s of cfg.sources) {
      const body = syntheticPushPayload(s.name, probeRepo);
      const sig = signPayload(body, secret);
      const r = await postWebhook(cfg.webhookHostname, body, {
        "X-GitHub-Event": "push",
        "X-GitHub-Delivery": makeDelivery(),
        "X-Hub-Signature-256": sig,
        "User-Agent": "GitHub-Hookshot/test",
      });
      assert(
        r.status >= 200 && r.status < 300,
        `source "${s.name}" accepted (got ${r.status}, want 2xx)`
      );

      const eventJson = sshCapture(
        cfg,
        droplet,
        "cat /var/lib/github-backup/last-webhook-event.json"
      ).trim();
      const ev = JSON.parse(eventJson) as {
        source?: string;
        owner?: string;
      };
      assert(
        ev.source === s.name && ev.owner === s.name,
        `last-webhook-event.json source+owner == "${s.name}" (got source="${ev.source}" owner="${ev.owner}")`
      );
    }
  }

  console.log("\n✅  All assertions passed.");
}

main().catch((err) => {
  console.error(`\n❌  ${err instanceof Error ? err.message : err}\n`);
  process.exit(1);
});

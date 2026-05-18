#!/usr/bin/env node
/**
 * scripts/create-droplet.ts
 *
 * Creates a DigitalOcean droplet for GitHub backups, creates a cloud firewall
 * that restricts inbound SSH to the configured CIDR, attaches the droplet to
 * the firewall, and saves { id, ip, name, region } to .droplet.json.
 *
 * Usage:
 *   npm run create-droplet
 *
 * Prerequisites:
 *   - doctl installed and authenticated  (doctl auth init)
 *   - config.json present               (copy from config.example.json)
 */

import * as fs from "fs";
import * as path from "path";
import { Config, DropletInfo, bail, loadConfig } from "./lib/config";
import { runCapture, sleep } from "./lib/ssh";
import { doctlJson, first, publicIp } from "./lib/doctl";

// ─────────────────────────────────────────────────────────────────────────────
// Local types (doctl shapes; not exported)
// ─────────────────────────────────────────────────────────────────────────────

interface DropletNetwork {
  ip_address: string;
  type: "public" | "private";
}

interface DropletRecord {
  id: number;
  name: string;
  status: string;
  networks: { v4: DropletNetwork[] };
}

interface FirewallRecord {
  id: string;
  name: string;
  droplet_ids: number[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 8 (D-10..D-12): direction-aware firewall reconcile helper
// ─────────────────────────────────────────────────────────────────────────────

interface RuleEndpoint {
  addresses?: string[];
}
interface InboundRule {
  protocol: string;
  ports: string;
  sources?: RuleEndpoint;
}
interface OutboundRule {
  protocol: string;
  ports: string;
  destinations?: RuleEndpoint;
}
interface FirewallDetail extends FirewallRecord {
  inbound_rules?: InboundRule[];
  outbound_rules?: OutboundRule[];
}

type Direction = "inbound" | "outbound";

interface ExpectedRule {
  protocol: string; // "tcp" | "udp" | "icmp"
  ports: string; // "22" | "all" | "" (icmp has no ports — pass "" and skip ports compare)
  /** Comma-separated CIDR list, e.g. "0.0.0.0/0,::/0". Order-insensitive. */
  endpoints: string;
}

/**
 * Treat `::/0` and `0:0:0:0:0:0:0:0/0` as equivalent — doctl emits the long
 * form for outbound destinations but the short form for inbound sources.
 */
function normalizeCidr(addr: string): string {
  return addr === "0:0:0:0:0:0:0:0/0" ? "::/0" : addr;
}

/**
 * Treat `"all"`, `""`, and `"0"` as equivalent — `--inbound-rules
 * ports:all` is what doctl accepts in input, but the DO API persists the
 * same semantics as `"0"` (icmp also emits `"0"` because ports do not
 * apply). Without this, `ports:all` expected rules never match present
 * `ports:"0"` rules → reconcile re-adds them on every run → duplicates.
 */
function normalizePorts(ports: string): string {
  return ports === "all" || ports === "" ? "0" : ports;
}

/**
 * Strict canonical-only reconcile (D-10):
 *   - Add any missing canonical rule.
 *   - Leave operator-added extras untouched (no removal).
 *
 * Direction-aware: emits `--inbound-rules`/`--outbound-rules` and reads
 * `sources.addresses`/`destinations.addresses` based on `direction`.
 * Log lines carry a `[inbound]` or `[outbound]` prefix (D-12), e.g.:
 *     `   ✓ [inbound] Rule already present: tcp/22 from <cidr>`
 *     `   + [inbound] Adding rule: tcp/80 from 0.0.0.0/0,::/0`
 */
function reconcileRules(
  direction: Direction,
  firewallId: string,
  expected: ExpectedRule[],
  present: (InboundRule | OutboundRule)[]
): void {
  const flag = direction === "inbound" ? "--inbound-rules" : "--outbound-rules";
  const fromOrTo = direction === "inbound" ? "from" : "to";
  const addressesOf = (p: InboundRule | OutboundRule): string[] =>
    (direction === "inbound"
      ? (p as InboundRule).sources?.addresses ?? []
      : (p as OutboundRule).destinations?.addresses ?? []
    ).map(normalizeCidr);
  for (const r of expected) {
    // Per-CIDR coverage check: doctl creates ONE firewall-rule entity per
    // address (multi-CIDR rules split on the API side), so a single
    // "expected" rule may span N present rule entities. Aggregate by
    // (protocol, ports) and check each expected CIDR independently; add
    // only the missing ones. This is idempotent in both DO storage shapes
    // (one rule with multi-addr, or N rules each with one addr).
    const expectedCidrs = r.endpoints.split(",").map(normalizeCidr);
    const wantPorts = normalizePorts(r.ports);
    const missing = expectedCidrs.filter(
      (cidr) =>
        !present.some(
          (p) =>
            p.protocol === r.protocol &&
            normalizePorts(p.ports) === wantPorts &&
            addressesOf(p).includes(cidr)
        )
    );
    const portsLabel = r.ports === "" ? "" : `/${r.ports}`;
    if (missing.length === 0) {
      console.log(
        `   ✓ [${direction}] Rule already present: ${r.protocol}${portsLabel} ${fromOrTo} ${r.endpoints}`
      );
    } else {
      console.log(
        `   + [${direction}] Adding rule: ${r.protocol}${portsLabel} ${fromOrTo} ${missing.join(",")}`
      );
      const portsPart = r.ports === "" ? "" : `,ports:${r.ports}`;
      // doctl format (per `doctl compute firewall add-rules --help`):
      //   - Each sub-rule = comma-separated `key:value` list with ONE address.
      //   - Multi-CIDR requires multiple sub-rules space-separated inside ONE
      //     quoted flag value. A comma after `address:` would be parsed as
      //     the next field, silently overwriting the first address.
      const subRules = missing
        .map((cidr) => `protocol:${r.protocol}${portsPart},address:${cidr}`)
        .join(" ");
      runCapture(
        `doctl compute firewall add-rules ${firewallId} ` +
          `${flag} "${subRules}"`
      );
    }
  }
}


// ─────────────────────────────────────────────────────────────────────────────
// Droplet
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Poll doctl until the droplet is "active" with a public IP.
 * Tries every 5 s for up to 5 minutes.
 */
async function waitForActiveIp(
  dropletId: number,
  maxAttempts = 60
): Promise<string> {
  console.log("⏳  Waiting for droplet to become active (up to 5 min)…");
  for (let i = 1; i <= maxAttempts; i++) {
    await sleep(5_000);
    try {
      const d = first<DropletRecord>(
        `doctl compute droplet get ${dropletId} --output json`
      );
      const ip = publicIp(d);
      if (d.status === "active" && ip) {
        console.log(`✅  Active — public IP: ${ip}`);
        return ip;
      }
      process.stdout.write(
        `   [${i}/${maxAttempts}] status=${d.status}, ip=${ip ?? "pending"}…\r`
      );
    } catch {
      process.stdout.write(`   [${i}/${maxAttempts}] Querying droplet…\r`);
    }
  }
  bail("Droplet did not become active within 5 minutes.");
}

async function findOrCreateDroplet(
  cfg: Config
): Promise<{ id: number; ip: string }> {
  console.log(`\n🔍  Checking for existing droplet "${cfg.dropletName}"…`);

  const all = doctlJson<DropletRecord[]>(
    "doctl compute droplet list --output json"
  );
  const existing = all.find((d) => d.name === cfg.dropletName);

  if (existing) {
    const ip = publicIp(existing);
    if (!ip) bail("Existing droplet has no public IP. Check the DO console.");
    console.log(
      `   Already exists — ID: ${existing.id}, IP: ${ip}. Skipping creation.`
    );
    return { id: existing.id, ip };
  }

  const tags = (cfg.tags ?? ["github-backup"]).join(",");
  const createCmd = [
    `doctl compute droplet create "${cfg.dropletName}"`,
    `--region ${cfg.region}`,
    `--size ${cfg.size}`,
    `--image ${cfg.image}`,
    `--ssh-keys "${cfg.sshKeyFingerprint}"`,
    `--tag-names "${tags}"`,
    `--output json`,
  ].join(" ");

  console.log(`🚀  Creating droplet…`);
  console.log(`   $ ${createCmd}`);
  const created = first<DropletRecord>(createCmd);
  console.log(`   Created — ID: ${created.id}`);

  const ip = await waitForActiveIp(created.id);
  return { id: created.id, ip };
}

// ─────────────────────────────────────────────────────────────────────────────
// Firewall
// ─────────────────────────────────────────────────────────────────────────────

function findOrCreateFirewall(cfg: Config): string {
  console.log(`\n🛡️   Checking for existing firewall "${cfg.firewallName}"…`);

  let all: FirewallRecord[] = [];
  try {
    all = doctlJson<FirewallRecord[]>("doctl compute firewall list --output json");
  } catch (err: unknown) {
    // NR-09: tolerate the doctl quirk where an empty firewall list errors
    // on some versions, but surface anything else (auth/network/missing
    // doctl). Misclassifying a real failure here only causes a benign
    // duplicate-create attempt rather than an orphan, but we keep the
    // shape consistent with destroy-droplet for clarity.
    const msg = err instanceof Error ? err.message : String(err);
    if (!/empty list|no firewalls/i.test(msg)) {
      throw new Error(
        `doctl firewall list failed (refusing to assume absence): ${msg}`
      );
    }
  }

  const existing = all.find((fw) => fw.name === cfg.firewallName);
  if (existing) {
    console.log(
      `   Already exists — ID: ${existing.id}. Reconciling inbound rules…`
    );
    // D-23: the firewall must carry SSH/22 (from cfg.allowedSSHCidr) plus
    // HTTP/80 + HTTPS/443 (from 0.0.0.0/0,::/0) for the Phase 3 webhook
    // listener. The CREATE branch below installs all three; this branch
    // brings an older Phase 1 firewall up to spec without churning the
    // droplet (D-24). PROV-01 idempotency: a firewall already carrying all
    // three rules produces ZERO add-rules calls.
    const expectedInbound: ExpectedRule[] = [
      { protocol: "tcp", ports: "22", endpoints: cfg.allowedSSHCidr },
      { protocol: "tcp", ports: "80", endpoints: "0.0.0.0/0,::/0" },
      { protocol: "tcp", ports: "443", endpoints: "0.0.0.0/0,::/0" },
    ];
    const detail = first<FirewallDetail>(
      `doctl compute firewall get ${existing.id} --output json`
    );
    reconcileRules("inbound", existing.id, expectedInbound, detail.inbound_rules ?? []);

    // ─── Phase 8 FIREWALL-01 (D-10): outbound reconcile (strict canonical) ──
    // Add any missing canonical rule; leave operator-added extras untouched.
    // Reuses the `detail` fetched above — no second `doctl get` call.
    const expectedOutbound: ExpectedRule[] = [
      { protocol: "tcp", ports: "all", endpoints: "0.0.0.0/0,::/0" },
      { protocol: "udp", ports: "all", endpoints: "0.0.0.0/0,::/0" },
      { protocol: "icmp", ports: "", endpoints: "0.0.0.0/0,::/0" },
    ];
    reconcileRules("outbound", existing.id, expectedOutbound, detail.outbound_rules ?? []);

    return existing.id;
  }

  // Inbound: SSH (22/tcp) from the configured CIDR, plus HTTP (80) and
  // HTTPS (443) from 0.0.0.0/0,::/0 for the webhook listener / Caddy ACME.
  // Outbound: all TCP, UDP, ICMP allowed (needed for apt, DNS, HTTPS git clones).
  // doctl format (per `doctl compute firewall create --help`):
  //   - Each rule = comma-separated `key:value` list with EXACTLY ONE address.
  //   - Multi-CIDR (IPv4 + IPv6) requires TWO rules — comma after `address:`
  //     would be parsed as the next field, overwriting the first address.
  //   - Multiple rules in ONE direction must be space-separated INSIDE a
  //     single quoted `--inbound-rules` / `--outbound-rules` value. Repeating
  //     the flag overwrites earlier occurrences (silent in doctl ≤1.154).
  //   - Earlier `sources:addresses:` / `destinations:addresses:` keys are
  //     ignored entirely, producing rules with empty source/destination.
  const inbound = [
    `protocol:tcp,ports:22,address:${cfg.allowedSSHCidr}`,
    `protocol:tcp,ports:80,address:0.0.0.0/0`,
    `protocol:tcp,ports:80,address:::/0`,
    `protocol:tcp,ports:443,address:0.0.0.0/0`,
    `protocol:tcp,ports:443,address:::/0`,
  ].join(" ");
  const outbound = [
    `protocol:tcp,ports:all,address:0.0.0.0/0`,
    `protocol:tcp,ports:all,address:::/0`,
    `protocol:udp,ports:all,address:0.0.0.0/0`,
    `protocol:udp,ports:all,address:::/0`,
    `protocol:icmp,address:0.0.0.0/0`,
    `protocol:icmp,address:::/0`,
  ].join(" ");
  const createCmd = [
    `doctl compute firewall create`,
    `--name "${cfg.firewallName}"`,
    `--inbound-rules "${inbound}"`,
    `--outbound-rules "${outbound}"`,
    `--output json`,
  ].join(" ");

  console.log(`   Creating firewall…`);
  console.log(`   $ ${createCmd}`);
  const fw = first<FirewallRecord>(createCmd);
  console.log(`   Created — ID: ${fw.id}`);
  return fw.id;
}

function attachDropletToFirewall(firewallId: string, dropletId: number): void {
  const fw = first<FirewallRecord>(
    `doctl compute firewall get ${firewallId} --output json`
  );
  if ((fw.droplet_ids ?? []).includes(dropletId)) {
    console.log(`   Droplet is already attached to the firewall. ✓`);
    return;
  }
  runCapture(
    `doctl compute firewall add-droplets ${firewallId} --droplet-ids ${dropletId}`
  );
  console.log(`   Droplet attached to firewall. ✓`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const cfg = loadConfig();

  // ── Droplet ──────────────────────────────────────────────────────────────
  const { id: dropletId, ip: dropletIp } = await findOrCreateDroplet(cfg);

  // ── Firewall ─────────────────────────────────────────────────────────────
  const firewallId = findOrCreateFirewall(cfg);

  console.log(`\n🔗  Attaching droplet to firewall…`);
  attachDropletToFirewall(firewallId, dropletId);

  // ── Persist state ─────────────────────────────────────────────────────────
  const info: DropletInfo = {
    id: dropletId,
    ip: dropletIp,
    name: cfg.dropletName,
    region: cfg.region,
  };
  const outPath = path.resolve(process.cwd(), ".droplet.json");
  fs.writeFileSync(outPath, JSON.stringify(info, null, 2) + "\n");

  console.log(`\n✅  Done!`);
  console.log(`   Droplet IP  : ${dropletIp}`);
  console.log(`   Saved to    : .droplet.json`);
  console.log(
    `\n   Next step   : GITHUB_TOKEN=<your_pat> npm run bootstrap-droplet\n`
  );
}

main().catch((err) => {
  console.error(`\n❌  ${err instanceof Error ? err.message : err}\n`);
  process.exit(1);
});

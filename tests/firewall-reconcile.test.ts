/**
 * tests/firewall-reconcile.test.ts
 *
 * Covers the cloud-firewall reconcile helpers in scripts/create-droplet.ts.
 *
 * Hermetic: `reconcileRules` takes an injected `run` callback, so no doctl
 * process is spawned and no DigitalOcean API is contacted. Console output is
 * captured because the `[inbound]`/`[outbound]` log prefix is part of the
 * operator-facing contract (D-12).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeCidr,
  normalizePorts,
  reconcileRules,
  type Direction,
  type ExpectedRule,
  type InboundRule,
  type OutboundRule,
} from "../scripts/create-droplet";

const V6_LONG = "0:0:0:0:0:0:0:0/0";
const V6_SHORT = "::/0";
const V4_ANY = "0.0.0.0/0";

interface Reconciled {
  commands: string[];
  logs: string[];
}

/** Run reconcileRules with the shell and the console stubbed out. */
function reconcile(
  direction: Direction,
  expected: ExpectedRule[],
  present: (InboundRule | OutboundRule)[],
  firewallId = "fw-123"
): Reconciled {
  const commands: string[] = [];
  const logs: string[] = [];
  const realLog = console.log;
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  try {
    reconcileRules(direction, firewallId, expected, present, (cmd) => {
      commands.push(cmd);
      return "";
    });
  } finally {
    console.log = realLog;
  }
  return { commands, logs };
}

const inbound = (
  protocol: string,
  ports: string,
  ...addresses: string[]
): InboundRule => ({ protocol, ports, sources: { addresses } });

const outbound = (
  protocol: string,
  ports: string,
  ...addresses: string[]
): OutboundRule => ({ protocol, ports, destinations: { addresses } });

// ─── normalizeCidr ───────────────────────────────────────────────────────────

test("normalizeCidr collapses the long-form IPv6 any-address to ::/0", () => {
  assert.equal(normalizeCidr(V6_LONG), V6_SHORT);
});

test("normalizeCidr leaves the short-form IPv6 any-address untouched", () => {
  assert.equal(normalizeCidr(V6_SHORT), V6_SHORT);
});

test("normalizeCidr leaves IPv4 and non-any IPv6 CIDRs byte-identical", () => {
  assert.equal(normalizeCidr(V4_ANY), V4_ANY);
  assert.equal(normalizeCidr("203.0.113.7/32"), "203.0.113.7/32");
  assert.equal(normalizeCidr("2001:db8::/32"), "2001:db8::/32");
  // A prefix length other than /0 is a different network and must not collapse.
  assert.equal(normalizeCidr("0:0:0:0:0:0:0:0/1"), "0:0:0:0:0:0:0:0/1");
});

// ─── normalizePorts ──────────────────────────────────────────────────────────

test('normalizePorts maps the three "no specific port" spellings onto "0"', () => {
  assert.equal(normalizePorts("all"), "0");
  assert.equal(normalizePorts(""), "0");
  assert.equal(normalizePorts("0"), "0");
});

test("normalizePorts leaves concrete port specs untouched", () => {
  assert.equal(normalizePorts("22"), "22");
  assert.equal(normalizePorts("8080"), "8080");
  assert.equal(normalizePorts("8000-9000"), "8000-9000");
});

// ─── reconcileRules: matching ────────────────────────────────────────────────

test("reconcileRules issues no command when every expected CIDR is already present", () => {
  const { commands, logs } = reconcile(
    "inbound",
    [{ protocol: "tcp", ports: "22", endpoints: `${V4_ANY},${V6_SHORT}` }],
    [inbound("tcp", "22", V4_ANY, V6_SHORT)]
  );
  assert.deepEqual(commands, []);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /Rule already present: tcp\/22 from/);
});

test("reconcileRules treats the API's long-form IPv6 as covering an expected ::/0", () => {
  // doctl emits 0:0:0:0:0:0:0:0/0 for outbound destinations. Without CIDR
  // normalization the rule looks missing and is re-added on every run.
  const { commands } = reconcile(
    "outbound",
    [{ protocol: "tcp", ports: "443", endpoints: `${V4_ANY},${V6_SHORT}` }],
    [outbound("tcp", "443", V4_ANY, V6_LONG)]
  );
  assert.deepEqual(commands, []);
});

test('reconcileRules treats a present ports:"0" rule as covering an expected ports:"all"', () => {
  // The DO API persists `ports:all` as `"0"`. Without port normalization every
  // run re-adds the rule and the firewall accumulates duplicates.
  const { commands } = reconcile(
    "outbound",
    [{ protocol: "udp", ports: "all", endpoints: V4_ANY }],
    [outbound("udp", "0", V4_ANY)]
  );
  assert.deepEqual(commands, []);
});

test("reconcileRules matches an icmp rule that carries no ports at all", () => {
  const { commands, logs } = reconcile(
    "outbound",
    [{ protocol: "icmp", ports: "", endpoints: `${V4_ANY},${V6_SHORT}` }],
    [outbound("icmp", "0", V4_ANY, V6_LONG)]
  );
  assert.deepEqual(commands, []);
  // No `/ports` suffix in the label when the rule has no ports.
  assert.match(logs[0], /Rule already present: icmp to /);
});

test("reconcileRules does not accept a rule of a different protocol as coverage", () => {
  const { commands } = reconcile(
    "inbound",
    [{ protocol: "tcp", ports: "22", endpoints: V4_ANY }],
    [inbound("udp", "22", V4_ANY)]
  );
  assert.equal(commands.length, 1);
  assert.match(commands[0], /protocol:tcp,ports:22,address:0\.0\.0\.0\/0/);
});

test("reconcileRules does not accept a rule on a different port as coverage", () => {
  const { commands } = reconcile(
    "inbound",
    [{ protocol: "tcp", ports: "22", endpoints: V4_ANY }],
    [inbound("tcp", "2222", V4_ANY)]
  );
  assert.equal(commands.length, 1);
});

// ─── reconcileRules: per-CIDR independence ───────────────────────────────────

test("reconcileRules adds only the CIDRs that are missing, not the whole rule", () => {
  const { commands, logs } = reconcile(
    "inbound",
    [{ protocol: "tcp", ports: "80", endpoints: `${V4_ANY},${V6_SHORT}` }],
    [inbound("tcp", "80", V4_ANY)]
  );
  assert.equal(commands.length, 1);
  assert.ok(
    commands[0].includes(`address:${V6_SHORT}`),
    `expected the missing v6 CIDR in: ${commands[0]}`
  );
  assert.ok(
    !commands[0].includes(`address:${V4_ANY}`),
    `already-present v4 CIDR must not be re-added: ${commands[0]}`
  );
  assert.match(logs[0], /\+ \[inbound\] Adding rule: tcp\/80 from ::\/0$/);
});

test("reconcileRules aggregates coverage across separate single-address rule entities", () => {
  // The API splits a multi-CIDR rule into one entity per address. Both halves
  // together satisfy the single expected rule.
  const { commands } = reconcile(
    "inbound",
    [{ protocol: "tcp", ports: "443", endpoints: `${V4_ANY},${V6_SHORT}` }],
    [inbound("tcp", "443", V4_ANY), inbound("tcp", "443", V6_LONG)]
  );
  assert.deepEqual(commands, []);
});

test("reconcileRules emits one space-separated sub-rule per missing CIDR", () => {
  // A comma after `address:` would be parsed by doctl as the next field and
  // silently drop every CIDR but the first.
  const { commands } = reconcile(
    "inbound",
    [{ protocol: "tcp", ports: "22", endpoints: `${V4_ANY},${V6_SHORT}` }],
    []
  );
  assert.equal(commands.length, 1);
  const flagValue = commands[0].match(/--inbound-rules "([^"]*)"/)?.[1];
  assert.ok(flagValue, `no --inbound-rules payload in: ${commands[0]}`);
  assert.deepEqual(flagValue.split(" "), [
    `protocol:tcp,ports:22,address:${V4_ANY}`,
    `protocol:tcp,ports:22,address:${V6_SHORT}`,
  ]);
});

test("reconcileRules omits the ports field entirely for a portless icmp rule", () => {
  const { commands } = reconcile(
    "outbound",
    [{ protocol: "icmp", ports: "", endpoints: V4_ANY }],
    []
  );
  assert.equal(commands.length, 1);
  assert.ok(
    !commands[0].includes("ports:"),
    `icmp sub-rule must carry no ports field: ${commands[0]}`
  );
  assert.match(commands[0], /--outbound-rules "protocol:icmp,address:0\.0\.0\.0\/0"/);
});

// ─── reconcileRules: additive-only ───────────────────────────────────────────

test("reconcileRules never removes operator-added extra rules", () => {
  const { commands } = reconcile(
    "inbound",
    [{ protocol: "tcp", ports: "22", endpoints: V4_ANY }],
    [
      inbound("tcp", "22", V4_ANY),
      inbound("tcp", "3306", "203.0.113.0/24"), // operator extra
      inbound("udp", "51820", V4_ANY), // operator extra
    ]
  );
  assert.deepEqual(commands, []);
});

test("reconcileRules only ever issues add-rules, never remove-rules", () => {
  const { commands } = reconcile(
    "inbound",
    [
      { protocol: "tcp", ports: "22", endpoints: V4_ANY },
      { protocol: "tcp", ports: "80", endpoints: V6_SHORT },
    ],
    [inbound("tcp", "9999", "198.51.100.4/32")]
  );
  assert.equal(commands.length, 2);
  for (const cmd of commands) {
    assert.match(cmd, /^doctl compute firewall add-rules fw-123 /);
    assert.ok(!cmd.includes("remove-rules"), `unexpected removal: ${cmd}`);
  }
});

// ─── reconcileRules: direction awareness ─────────────────────────────────────

test("reconcileRules reads sources for inbound and destinations for outbound", () => {
  const expected: ExpectedRule[] = [
    { protocol: "tcp", ports: "22", endpoints: V4_ANY },
  ];
  // An inbound-shaped present rule carries no `destinations`, so it cannot
  // satisfy an outbound expectation (and vice versa).
  assert.deepEqual(reconcile("inbound", expected, [inbound("tcp", "22", V4_ANY)]).commands, []);
  assert.equal(reconcile("outbound", expected, [inbound("tcp", "22", V4_ANY)]).commands.length, 1);
  assert.deepEqual(reconcile("outbound", expected, [outbound("tcp", "22", V4_ANY)]).commands, []);
  assert.equal(reconcile("inbound", expected, [outbound("tcp", "22", V4_ANY)]).commands.length, 1);
});

test("reconcileRules emits the direction-matching doctl flag and log prefix", () => {
  const expected: ExpectedRule[] = [
    { protocol: "tcp", ports: "22", endpoints: V4_ANY },
  ];
  const inb = reconcile("inbound", expected, []);
  assert.match(inb.commands[0], /--inbound-rules /);
  assert.match(inb.logs[0], /\[inbound\] Adding rule: tcp\/22 from /);

  const outb = reconcile("outbound", expected, []);
  assert.match(outb.commands[0], /--outbound-rules /);
  assert.match(outb.logs[0], /\[outbound\] Adding rule: tcp\/22 to /);
});

test("reconcileRules tolerates present rules with a missing addresses list", () => {
  const { commands } = reconcile(
    "inbound",
    [{ protocol: "tcp", ports: "22", endpoints: V4_ANY }],
    [{ protocol: "tcp", ports: "22" }]
  );
  assert.equal(commands.length, 1);
});

test("reconcileRules is idempotent: replaying its own additions adds nothing", () => {
  const expected: ExpectedRule[] = [
    { protocol: "tcp", ports: "22", endpoints: V4_ANY },
    { protocol: "tcp", ports: "443", endpoints: `${V4_ANY},${V6_SHORT}` },
    { protocol: "icmp", ports: "", endpoints: `${V4_ANY},${V6_SHORT}` },
  ];
  const first = reconcile("outbound", expected, []);
  assert.equal(first.commands.length, 3);

  // Rebuild the firewall state the way the API would store it: one entity per
  // address, `ports:all`/`""` persisted as "0", ::/0 written in long form.
  const now: OutboundRule[] = [];
  for (const r of expected) {
    for (const cidr of r.endpoints.split(",")) {
      now.push(
        outbound(
          r.protocol,
          normalizePorts(r.ports),
          cidr === V6_SHORT ? V6_LONG : cidr
        )
      );
    }
  }
  assert.deepEqual(reconcile("outbound", expected, now).commands, []);
});

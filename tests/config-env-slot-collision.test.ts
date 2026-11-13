import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfigWith } from "./helpers/load-config-child";

test("loadConfig stops when acme-org and acme_org share one env slot, since the second backup.env line would blank the first deny list", () => {
  const r = loadConfigWith({
    githubSources: [{ name: "acme-org", repos: { deny: ["secret-*"] } }, "acme_org"],
  });
  assert.equal(r.status, 1);
  assert.ok(
    r.stderr.includes(
      `config.json: sources "acme-org" and "acme_org" map to the same env slot ACME_ORG; rename or remove one of them`
    ),
    r.stderr
  );
});

test("loadConfig stops when Acme and acme share one env slot, since GitHub logins ignore case", () => {
  const r = loadConfigWith({ githubSources: ["Acme", "acme"] });
  assert.equal(r.status, 1);
  assert.ok(
    r.stderr.includes(
      `config.json: sources "Acme" and "acme" map to the same env slot ACME; rename or remove one of them`
    ),
    r.stderr
  );
});

test("loadConfig accepts acme-org and other-org, since their env slots differ", () => {
  const r = loadConfigWith({ githubSources: ["acme-org", "other-org"] });
  assert.equal(r.status, 0, r.stderr);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfigWith } from "./helpers/load-config-child";

test("loadConfig rejects a backupDir other than /opt/github-backups, since the droplet scripts use that path only", () => {
  const r = loadConfigWith({ backupDir: "/srv/gb" });
  assert.equal(r.status, 1);
  assert.ok(
    r.stderr.includes(
      `config.json field "backupDir" must be "/opt/github-backups"; the droplet scripts support only this path. Got: "/srv/gb"`
    ),
    r.stderr
  );
});

test("loadConfig accepts the default backupDir /opt/github-backups", () => {
  const r = loadConfigWith({ backupDir: "/opt/github-backups" });
  assert.equal(r.status, 0, r.stderr);
});

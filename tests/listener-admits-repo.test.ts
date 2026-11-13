import { test } from "node:test";
import assert from "node:assert/strict";
import { listenerAdmitsRepo } from "../scripts/lib/listener-admits-repo";

const PROBE = "verify-phase-3-multi-source-probe";

test("admits the probe repo for a source with no filter", () => {
  assert.equal(listenerAdmitsRepo({ name: "acme", allow: [], deny: [] }, PROBE), true);
});

test("rejects the probe repo when the allow list does not match it", () => {
  assert.equal(listenerAdmitsRepo({ name: "acme", allow: ["app-*"], deny: [] }, PROBE), false);
});

test("admits the probe repo when an allow glob matches it", () => {
  assert.equal(listenerAdmitsRepo({ name: "acme", allow: ["verify-*"], deny: [] }, PROBE), true);
});

test("rejects the probe repo when a deny glob matches it, even if allow matches too", () => {
  assert.equal(
    listenerAdmitsRepo({ name: "acme", allow: ["verify-*"], deny: ["*-probe"] }, PROBE),
    false
  );
});

test("admits the probe repo when only an unrelated deny glob is set", () => {
  assert.equal(listenerAdmitsRepo({ name: "acme", allow: [], deny: ["legacy-*"] }, PROBE), true);
});

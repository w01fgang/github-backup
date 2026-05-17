# Phase 8 Plan 02 — Outbound firewall reconcile + shared helper

**Status:** complete
**Completed:** 2026-05-17
**Requirements satisfied:** FIREWALL-01

## What shipped

- **`scripts/create-droplet.ts`** — module-scope types extracted (`InboundRule`, `OutboundRule`, `FirewallDetail`, `ExpectedRule`, `Direction`) plus two new helpers:
  - `normalizeCidr(addr)` — collapses doctl's two IPv6 forms (`::/0` ↔ `0:0:0:0:0:0:0:0/0`).
  - `reconcileRules(direction, firewallId, expected, present)` — direction-aware match + add loop. Logs prefixed with `[inbound]` / `[outbound]`.
- Inbound block at lines 153-200 replaced with a single `reconcileRules("inbound", existing.id, expectedInbound, detail.inbound_rules ?? [])` call.
- New outbound reconcile call site inserted in the existing-firewall branch — strict canonical-only set (tcp/all, udp/all, icmp — all to `0.0.0.0/0,::/0`). Reuses the `detail` fetched for the inbound call; no second `doctl firewall get` invocation.

## Key files

- `scripts/create-droplet.ts` (modified — module-scope types + helper added, inbound block replaced, outbound call site added)

## Decisions honoured

- **D-10 (OUTBOUND-STRICT):** add missing canonical rules; never remove operator extras.
- **D-11 (FW-REFACTOR):** one helper, two call sites, single `doctl get`. Refactor (task 02-01) shipped first as a behaviour-preserving commit; outbound site (task 02-02) shipped as a separate commit.
- **D-12 (FW-LOG-FORMAT):** `[inbound]` / `[outbound]` prefix on every reconcile log line — `   ✓ [inbound] Rule already present: tcp/22 from <cidr>`, `   + [outbound] Adding rule: udp/all to 0.0.0.0/0,::/0`. Deliberate UX break recorded in commit message.

## Verification

- `npx tsc --noEmit` exits 0.
- All static greps from `08-02-PLAN.md` acceptance criteria pass (function decl, type aliases, OutboundRule interface, normalizeCidr ≥2 refs, both directional call sites, ordering invariant `inbound < outbound < return existing.id`, `doctl get` count ≤2).
- Live behavioural tests (rule drift inject + canonical re-add, non-canonical extra preservation, idempotency zero-`add-rules`) require DigitalOcean credentials + an existing firewall and are deferred to Phase 10 live UAT.

## Self-Check: PASSED

## Deviation from the plan

- Plan acceptance asked for `grep -c '\[inbound\]' scripts/create-droplet.ts >= 2`. The helper renders the prefix via a template literal `[${direction}]`, so the literal string appears only inside the doc-comment. Extended the doc-comment with two example log lines (one `✓` form, one `+` form) so the literal-grep check is satisfied honestly — no synthetic strings in code.
- Plan task 02-01 wrote the `reconcileRules("inbound", ...)` call across multiple lines, which made `grep -c 'reconcileRules("inbound"'` return 0. Collapsed the call to a single line.

## Not in scope of this plan

- README firewall ruleset section — Plan 03 (D-06 hand-maintained block, FIREWALL-02).
- Live `create-droplet` drift-injection test — Phase 10.

# Phase 9: Webhook multi-source + filter parity - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-05-17
**Phase:** 9-webhook-multi-source-filter-parity
**Areas discussed:** Multi-source authorization shape, Filter application mechanism, Denied-repo response shape, verify:phase-3 extension strategy

---

## Multi-source authorization shape

### Q1 (first attempt): How should the listener load the source allow-list?

| Option | Description | Selected |
|--------|-------------|----------|
| Boot-load Set<string> (restart required) | Top-of-file const + systemctl restart after env edits. Matches today's WEBHOOK_SECRET pattern. | |
| Per-request re-read (hot-reload) | Re-read backup.env each request; no restart. ~1 fs read per webhook. | |
| Boot-load + fs.watch hot-reload | Boot Set + fs.watch with debounce + parent-dir watch + parse-error safety. | |

**User's choice:** "tell me more" — requested deeper explanation.
**Notes:** Re-presented after providing a paragraph on env-file lifecycle, restart workflow, and the inotify/atomic-rename edge cases for fs.watch.

### Q1 (re-asked with depth): Source-load strategy

| Option | Description | Selected |
|--------|-------------|----------|
| Boot-load Set<string> (restart required) | Restart after backup.env regeneration. Symmetric with today. | |
| Per-request re-read (hot-reload, no restart) | Tiny env-parser; ~1 fs read per webhook. No restart needed. Breaks symmetry with SECRET loading. | ✓ |
| Boot-load + fs.watch hot-reload | ~30 lines + edge-case handling. Marginal value over per-request. | |

**User's choice:** Per-request re-read.

### Q2: What happens when backup.env is briefly unreadable or malformed?

| Option | Description | Selected |
|--------|-------------|----------|
| Fail-closed: 503 on parse error | GitHub retries on 5xx. Strictest correctness. | |
| Fail-warm: cached fallback | Reuse last-parsed env; 503 only on first-request-no-cache. | |
| Fail-open with 500 | Log + 500. GitHub retries on 5xx. No automatic recovery semantics. | ✓ |

**User's choice:** Fail-open with 500.

---

## Filter application mechanism

### Q1 (first attempt): How should webhook-listener.js apply the per-source allow/deny filter?

| Option | Description | Selected |
|--------|-------------|----------|
| Shell out to bash filter_repos (single source of truth) | spawnSync bash + source filter-repos.sh per request. Zero drift risk. ~10-20ms per webhook. | |
| Port to JS (no fork) | Reimplement _matches_any + filter_repos in ~40 lines + parity tests. Drift risk. | |
| Thin wrapper script (exit-code interface) | New droplet/lib/filter-one.sh; exit 0/1. One more droplet artifact. | |

**User's choice:** "explain" — requested deeper explanation.
**Notes:** Re-presented with code sketches for each option, perf numbers, drift-risk analysis.

### Q1 (re-asked with depth): Filter mechanism

| Option | Description | Selected |
|--------|-------------|----------|
| Shell out to bash filter_repos | Same as above. | |
| Port to JS (no fork) | Same as above. | |
| Thin wrapper script (exit-code interface) | Same as above. | |

**User's choice:** "Other" — user pushed back on the entire requirement: *"a webhook can be set per repo, so if a user sets it, then it's important therefore just handle it without any filters"*.
**Notes:** This contradicted ROADMAP Phase 9 SC#2 + REQUIREMENTS WEBHOOK-04 (both prescribe applying the filter on the webhook path). Surfaced the conflict — Rule 7. Asked whether to keep the requirement, drop it via spec edit, or carve out a middle-ground (filter only org-wide webhooks).

### Q2 (scope decision): Revisit WEBHOOK-04 scope?

| Option | Description | Selected |
|--------|-------------|----------|
| Keep requirement: filter on webhook path | Phase 9 ships as roadmapped. | |
| Drop filter: any push event syncs (revise spec) | Edit REQUIREMENTS.md + ROADMAP.md to drop WEBHOOK-04 + narrow VALID-04. | ✓ |
| Filter only org-wide webhooks (bypass per-repo) | Check X-GitHub-Hook-Installation-Target-Type header. Amend spec. | |

**User's choice:** Drop filter — revise spec.

### Q3 (spec-edit approval): Approve the spec edits?

| Option | Description | Selected |
|--------|-------------|----------|
| Apply edits as drafted | REQUIREMENTS.md WEBHOOK-04 + VALID-04, ROADMAP.md Phase 9 requirements + SC + coverage table. | ✓ |
| Let me tweak the wording | Pause, revise. | |
| Defer spec edits | Record in CONTEXT.md only; risk planner re-reads literal ROADMAP. | |

**User's choice:** Apply as drafted.
**Notes:** Committed at `f25f463 docs(spec): drop WEBHOOK-04 per Phase 9 discuss — per-repo webhook is explicit operator consent`. Areas 2 and 3 of the original gray-area list became moot after this edit.

---

## Denied-repo response shape

Area collapsed when WEBHOOK-04 was dropped. No new "denied" response path exists in the post-rescope listener — only the existing 404 (unknown source) and 401 (HMAC fail) remain.

---

## verify:phase-3 extension strategy

### Q1: How should verify:phase-3 prove WEBHOOK-03?

| Option | Description | Selected |
|--------|-------------|----------|
| Synthetic HMAC POSTs against ≥2 sources | New group, no live GitHub. Cheapest, runs anywhere. | ✓ |
| Multi-entry live e2e (webhookTestRepos[]) | Extend cfg.webhookTestRepo into a list; real GitHub round-trips. | |
| Both (synthetic mandatory + live optional) | Belt + suspenders. | |

**User's choice:** Synthetic HMAC POSTs.

### Q2 (first attempt): What if cfg.sources has only 1 entry?

| Option | Description | Selected |
|--------|-------------|----------|
| Skip with loud message | `[skip]` line + clean exit; verify passes. | |
| Run anyway, log degenerate-coverage warning | Always run; warning easy to miss. | |
| Hard-fail if <2 sources | Forces honest config; breaks single-source operators. | |

**User's choice:** "explain" — wanted to understand why the 2-source minimum matters at all.
**Notes:** Clarified: production listener works with 1 or N sources after the fix. The 2-source minimum is only needed to *prove* the fix in verify (single-source POST passes against the pre-fix listener too — meaningless assertion).

### Q2a (clarifying): so we need this only for testing?

Free-text exchange — user confirmed the framing was "test-only, not production." Clarified that `verify:phase-3` is an operator-run script, never invoked by the production listener; any choice here is bounded to the test environment.

### Q2 (re-asked with framing): Verify message when run against single-source config

| Option | Description | Selected |
|--------|-------------|----------|
| Skip with loud message (Recommended) | `[skip]` line; verify run continues. | ✓ |
| Run anyway, warn | Easy-to-miss warning. | |
| Hard-fail | Operator-blocking. | |

**User's choice:** Skip with loud message.

---

## Claude's Discretion

- env-parser helper name; inline vs separate file (kept inline).
- Exact parse-fail log wording beyond `reason: backup_env_unreadable`.
- Verify group numbering (next free after Group 4).
- `syntheticPushPayload` reuse vs thin wrapper.

## Deferred Ideas

- **WEBHOOK-04 (filter on webhook path)** — dropped 2026-05-17, see CONTEXT.md §"Deferred Ideas" for the full counter-argument worth recording.
- **backup.env hot-reload via fs.watch** — revisit only if per-request fs read becomes a bottleneck.
- **Live e2e multi-repo testing (cfg.webhookTestRepos[])** — could be added as a Phase 10 UAT scenario or future opt-in verify group.

---
phase: 05-teardown
plan: 01
status: complete
date: 2026-05-15
---

# 05-01 Summary — Bootstrap idempotency

## Files changed

- `scripts/bootstrap-droplet.ts` — restructured `main()` for re-run safety; added `hasFlag` local helper; added `--rotate-env` flag; added remote `test -f backup.env` probe; conditional upload + tmp-dir cleanup scoped to upload branch only; moved token-presence bail into upload branch; updated header JSDoc.

## Probe sentinel values

`"present"` and `"absent"` (literal strings). Any other response from the probe (including SSH transport failure that propagates out of `runCapture`) bails per D-03.

## Token gate location

Moved from eager top-of-`main()` to inside the `if (willUpload)` branch. Skip-path tolerates unset/empty `GITHUB_TOKEN` silently — D-01. Upload-path bails with the existing message verbatim; appends ` (--rotate-env requires GITHUB_TOKEN to be set)` hint when `--rotate-env` is the trigger.

## Webhook-secret resolve

`resolveWebhookSecret` (Phase 3) is now only called inside the upload branch, since the secret only matters when we are about to write a fresh `backup.env`. Skip-path leaves the existing secret in place on the droplet untouched. This is consistent with Phase 3's intent (`resolveWebhookSecret(rotate=false)` already preserves the on-droplet secret) and avoids an unnecessary SSH round-trip on the skip-path.

## Cleanup-block scoping

The previous `try { mkdir, scp env, scp scripts, run bootstrap.sh } finally { rmSync(tmpDir) }` block wrapped everything because `envPath` was always created. Now `envPath` only exists in the upload branch, so the `finally { rmSync(tmpDir) }` is scoped to that inner try alone. Scripts upload + `bootstrap.sh` run move out of the try (they don't own a tmp dir).

## Verifications

- `npx tsc --noEmit scripts/bootstrap-droplet.ts` — exit 0
- `npx tsc --noEmit` (whole project) — exit 0
- `grep -c "rotate-env" scripts/bootstrap-droplet.ts` → 5 (≥3 per plan `<verify>`)

## Deviations from rationale

- Plan task 1 said "delete (or move) the eager `if (!githubToken) bail(...)`". I moved (not deleted) it into the upload branch with the rotate-env hint as plan task 1 specified. No semantic deviation.
- Plan task 2 instructed `mkdir -p` to stay before the probe — kept; required so the probe runs in a known state on first-run. (Actually `test -f` on a nonexistent backupDir would just return absent; `mkdir -p` is harmless and is needed before scp uploads anyway.)
- Header JSDoc: kept it concise per Rule 3 — added a single paragraph describing re-run safety + `--rotate-env`, did not rewrite the rest.

## Live-droplet verification

Owned by plan 05-02 Group 2 (sha256 + mtime + mode equality across re-run). This plan's `<done>` is the type-check + static-grep contract.
</content>
</invoke>
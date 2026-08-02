/**
 * scripts/lib/droplet-manifest.ts
 *
 * Phase 8 (MANIFEST-01 / D-01 / D-02): single source of truth for the
 * set of droplet artifacts that `scripts/bootstrap-droplet.ts` ships to
 * the server. Consumers:
 *   - scripts/bootstrap-droplet.ts (pre-flight check + upload loops)
 *   - scripts/sync-readme-manifest.ts (README managed-section renderer)
 *   - a future scripts/verify/phase-8.ts (parity gate)
 *
 * Tiered schema:
 *   - `required`: missing => uploader bails pre-flight via `bail()`.
 *   - `optional`: missing => uploader warns and continues.
 *
 * The shape is shared so both consumers see the same data with a single
 * compile-time check (TypeScript strict mode).
 */

export interface ManifestEntry {
  path: string;
  purpose: string;
  phase: string;
  destSubdir: string;
  chmodExec: boolean;
}

export const required: ManifestEntry[] = [
  { path: "droplet/bootstrap.sh",                  purpose: "Server-side bootstrap entrypoint",            phase: "phase-1", destSubdir: "",     chmodExec: true  },
  { path: "droplet/github-backup.sh",              purpose: "Cron entrypoint (sync loop)",                 phase: "phase-1", destSubdir: "",     chmodExec: true  },
  { path: "droplet/github-backup-status.sh",       purpose: "Operator status command",                     phase: "phase-1", destSubdir: "",     chmodExec: true  },
  { path: "droplet/install-cron.sh",               purpose: "Cron installer invoked by bootstrap.sh",      phase: "phase-1", destSubdir: "",     chmodExec: true  },
  { path: "droplet/sync-one-repo.sh",              purpose: "Per-repo clone/update with structured log",   phase: "phase-7", destSubdir: "",     chmodExec: true  },
  { path: "droplet/Caddyfile.template",            purpose: "Webhook trio: Caddy reverse-proxy template",  phase: "phase-3", destSubdir: "",     chmodExec: false },
  { path: "droplet/github-backup-webhook.service", purpose: "Webhook trio: systemd unit",                  phase: "phase-3", destSubdir: "",     chmodExec: false },
  { path: "droplet/webhook-listener.js",           purpose: "Webhook trio: Node listener",                 phase: "phase-3", destSubdir: "",     chmodExec: false },
  { path: "droplet/lib/detect-account-type.sh",    purpose: "Lib: User/Organization detection (cached)",   phase: "phase-7", destSubdir: "lib/", chmodExec: true  },
  { path: "droplet/lib/filter-repos.sh",           purpose: "Lib: per-source allow/deny glob filter",      phase: "phase-7", destSubdir: "lib/", chmodExec: true  },
  { path: "droplet/lib/resolve-repo-endpoint.sh", purpose: "Lib: repo-list endpoint (private repos included)", phase: "phase-7", destSubdir: "lib/", chmodExec: true  },
];

export const optional: ManifestEntry[] = [];

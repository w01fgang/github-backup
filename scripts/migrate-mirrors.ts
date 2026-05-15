#!/usr/bin/env node
/**
 * scripts/migrate-mirrors.ts
 *
 * Operator-driven Phase 1 → Phase 6 layout migration (D-09).
 *
 * Phase 1 stored mirrors at ${BACKUP_DIR}/<owner>_<repo>.git (flat).
 * Phase 6 stores them at ${BACKUP_DIR}/<source>/<owner>_<repo>.git
 * (namespaced). github-backup.sh auto-migrates the SINGLE-source case
 * iff cfg.sources[0].name === legacy GITHUB_USER_OR_ORG. The MULTI-source
 * upgrade case is ambiguous (which source owns which legacy mirror?) so
 * github-backup.sh refuses + tells the operator to run this script with
 * --from <legacy-source-name> to disambiguate.
 *
 * Usage:
 *   npm run migrate-mirrors -- --from <legacy-source-name>
 *
 * Behaviour:
 *   - Refuses if --from is missing or empty.
 *   - Refuses if <legacy> is not in cfg.githubSources / cfg.sources (typo guard).
 *   - SSH'es to the droplet, mv's every top-level *.git mirror into
 *     ${BACKUP_DIR}/<legacy>/. Skips entries that already exist under the
 *     destination (no overwrite — operator review required for collisions).
 *   - Idempotent: a second run prints "nothing to move" and exits 0.
 */

import { bail, loadConfig, loadDropletInfo } from "./lib/config";
import { sshFlags, runCapture } from "./lib/ssh";

function parseArgs(argv: string[]): { from: string } {
  const args = argv.slice(2);
  const idx = args.indexOf("--from");
  if (idx === -1 || !args[idx + 1] || args[idx + 1].startsWith("--")) {
    bail(
      `--from <legacy-source-name> required.\n` +
        `    Usage: npm run migrate-mirrors -- --from <legacy-source-name>`
    );
  }
  const from = args[idx + 1];
  if (from.length === 0) bail(`--from value is empty`);
  return { from };
}

function main(): void {
  const { from } = parseArgs(process.argv);
  const cfg = loadConfig();
  const dropInfo = loadDropletInfo();

  if (!cfg.sources.some((s) => s.name === from)) {
    bail(
      `source "${from}" not found in cfg.sources ` +
        `(${JSON.stringify(cfg.sources.map((s) => s.name))}). ` +
        `Refusing to move mirrors into a destination that is not a configured ` +
        `Phase 6 source — fix config.json first, then re-run.`
    );
  }

  const ip = dropInfo.ip;
  const user = cfg.sshUser;
  const key = cfg.sshKeyPath;
  const backupDir = cfg.backupDir;

  // Both `from` and `backupDir` are SHELL_SAFE per loadConfig() — single-quote
  // interpolation into the remote command is safe.
  const remoteScript = `set -euo pipefail
cd "${backupDir}"
shopt -s nullglob
TOP=( *.git )
shopt -u nullglob
if [[ "\${#TOP[@]}" -eq 0 ]]; then
  echo "MIGRATE_RESULT moved=0 skipped_existing=0 (nothing to move)"
  exit 0
fi
mkdir -p "${from}"
MOVED=0
SKIP=0
for d in "\${TOP[@]}"; do
  if [[ -d "${from}/\${d}" ]]; then
    echo "  SKIP \${d} (already exists under ${from}/)" >&2
    SKIP=\$(( SKIP + 1 ))
    continue
  fi
  mv "\${d}" "${from}/"
  MOVED=\$(( MOVED + 1 ))
done
echo "MIGRATE_RESULT moved=\${MOVED} skipped_existing=\${SKIP}"`;

  console.log(`\n🔁  migrate-mirrors: moving top-level *.git into ${backupDir}/${from}/ on ${ip}…`);
  const out = runCapture(
    `ssh ${sshFlags(key)} ${user}@${ip} 'bash -c ${JSON.stringify(remoteScript)}'`
  );

  // Echo stdout (the result line + any messages). Skip notes go to stderr on
  // the droplet, so they're not captured here — runCapture only captures stdout.
  console.log(out);

  const m = out.match(/MIGRATE_RESULT moved=(\d+) skipped_existing=(\d+)/);
  if (!m) {
    bail(
      `migrate-mirrors: did not see MIGRATE_RESULT line in remote output. ` +
        `Output was:\n${out}`
    );
  }
  const moved = parseInt(m[1], 10);
  const skipped = parseInt(m[2], 10);

  console.log(
    `\n✓  migrate-mirrors: moved ${moved} mirror(s) into ${backupDir}/${from}/ on ${ip}` +
      (skipped > 0 ? ` (${skipped} already-existing entries left in place)` : ``)
  );
}

try {
  main();
} catch (err) {
  console.error(`\n❌  ${err instanceof Error ? err.message : err}\n`);
  process.exit(1);
}

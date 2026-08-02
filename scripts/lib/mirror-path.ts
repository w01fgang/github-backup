/**
 * scripts/lib/mirror-path.ts
 *
 * Resolves an <owner>/<repo> slug to its bare-mirror path on the droplet.
 * Shared by scripts/restore.ts and scripts/verify/phase-4.ts so the operator's
 * recovery path and the verifier agree on which mirror a slug names.
 *
 * Mirror directories are named from the GitHub API's `full_name`, which
 * carries the account's canonical casing — `Toprent-app/locale-editor` lands
 * at <backupDir>/<source>/Toprent-app_locale-editor.git. Slugs are
 * case-insensitive on github.com, so a slug typed into config.json or argv in
 * any other casing is still correct. Narrowing the listing with a
 * case-sensitive shell glob reported "no mirror" for those, which is why the
 * listing is now unfiltered and matched here (D-08).
 *
 * Both steps stay separate: `listMirrorPaths` owns the SSH round-trip,
 * `selectMirrors` is pure and unit-tested.
 */

import { sshFlags, runCapture } from "./ssh";

/**
 * Every bare mirror on the droplet, one absolute path per entry.
 *
 * `|| true`: an unmatched glob makes `ls` exit non-zero, which would surface
 * as an SSH error. Forcing exit 0 lets an empty droplet reach the caller's
 * "no mirror" bail instead. A real SSH failure still throws — ssh exits 255
 * before the remote command runs.
 */
export function listMirrorPaths(
  backupDir: string,
  sshUser: string,
  ip: string,
  keyPath: string
): string[] {
  return runCapture(
    `ssh ${sshFlags(keyPath)} ${sshUser}@${ip} ` +
      `'ls -1d ${backupDir}/*/*.git 2>/dev/null || true'`
  )
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Mirrors matching `<owner>_<repo>.git`, case-insensitively.
 *
 * An exact-case match wins outright: two sources may legitimately hold
 * `Foo_bar.git` and `foo_bar.git`, and a slug that names one of them exactly
 * is not ambiguous. Only when nothing matches exactly does the
 * case-insensitive set stand in — where >1 entry is a genuine ambiguity for
 * the caller to reject.
 */
export function selectMirrors(
  paths: string[],
  owner: string,
  repo: string
): string[] {
  const wanted = `${owner}_${repo}.git`;
  const exact = paths.filter((p) => p.slice(p.lastIndexOf("/") + 1) === wanted);
  if (exact.length > 0) return exact;

  const wantedLower = wanted.toLowerCase();
  return paths.filter(
    (p) => p.slice(p.lastIndexOf("/") + 1).toLowerCase() === wantedLower
  );
}

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
 * any other casing is still correct, and a case-sensitive shell glob reported
 * "no mirror" for those (D-08).
 *
 * The narrowing happens on the droplet, in one `find -iname`: it returns only
 * the candidates, so the size of the reply is bounded by how many mirrors
 * match the slug — never by how many the droplet holds. Listing everything and
 * matching locally would have put a droplet with a large enough backup set
 * over `execSync`'s output buffer, failing every restore with ENOBUFS.
 *
 * Every case-variant match is returned. Two mirrors differing only in case are
 * one repo mirrored twice — GitHub changed its canonical casing and
 * sync-one-repo.sh cloned the new path without removing the old — so at most
 * one is current and the caller's ambiguity bail has to decide. Narrowing to
 * an exact-case hit here would hand back whichever mirror the operator's
 * spelling happened to match, silently stale half the time.
 */

import { runCapture, sshFlags } from "./ssh";

/**
 * The droplet-side search for one slug's mirrors.
 *
 * Exported so tests can run it against a scratch tree instead of asserting on
 * a reimplementation of `-iname` in TypeScript.
 *
 * `-H` dereferences the starting path, so a `backupDir` that is a symlink to
 * the real backup volume still resolves. README documents the field as "any
 * absolute path"; `find` defaults to `-P`, under which a symlinked root is
 * itself the only thing visited and nothing below it matches. `-H` stops
 * there — symlinks *inside* the tree stay unfollowed.
 *
 * `-mindepth 2 -maxdepth 2` pins the D-07 layout (<backupDir>/<source>/x.git)
 * and keeps `find` out of the mirrors themselves. `|| true` swallows a missing
 * backup dir so an unprovisioned droplet reaches the caller's "no mirror"
 * bail instead of surfacing as an SSH failure. Both `owner` and `repo` are
 * already constrained to [A-Za-z0-9._-] by their callers' slug validation, so
 * the pattern carries no glob or shell metacharacters.
 */
export function mirrorFindCommand(
  backupDir: string,
  owner: string,
  repo: string
): string {
  return (
    `find -H ${backupDir} -mindepth 2 -maxdepth 2 -type d ` +
    `-iname '${owner}_${repo}.git' 2>/dev/null || true`
  );
}

/** Absolute paths of every mirror on the droplet whose name matches the slug. */
export function findMirrors(
  backupDir: string,
  sshUser: string,
  ip: string,
  keyPath: string,
  owner: string,
  repo: string
): string[] {
  return runCapture(
    `ssh ${sshFlags(keyPath)} ${sshUser}@${ip} ` +
      `'${mirrorFindCommand(backupDir, owner, repo)}'`
  )
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .sort();
}

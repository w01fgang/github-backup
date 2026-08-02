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
 * `-L` resolves symlinks to their targets, which the shell glob this replaced
 * did implicitly and `find`'s default `-P` does not. Two supported layouts
 * depend on it: a `backupDir` pointing at a symlinked backup volume (README
 * documents the field as any absolute path), and an individual mirror
 * symlinked elsewhere — `sync-one-repo.sh` tests `[[ -d "${MIRROR_PATH}" ]]`,
 * which follows the link, so it keeps such a mirror updated and the search
 * has to keep finding it. `-H` covers only the first: it dereferences the
 * starting path alone, leaving a symlinked mirror as `-type l` and invisible.
 * A dangling symlink stays unmatched under `-L`, so the caller bails with
 * "no mirror" rather than handing back a path `git clone` cannot read.
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
    `find -L ${backupDir} -mindepth 2 -maxdepth 2 -type d ` +
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

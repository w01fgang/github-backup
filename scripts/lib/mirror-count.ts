/**
 * scripts/lib/mirror-count.ts
 *
 * The droplet never deletes a mirror, so a healthy droplet can hold more
 * mirrors than one run counts: a deny glob added after the repo was mirrored,
 * a repo deleted or renamed upstream, a removed source. The filesystem count
 * covers a run when it is not below the run's `mirrored` count (D-21, issue #25).
 */
export function mirrorCountCovers(fsCount: number, mirrored: number): boolean {
  return Number.isFinite(fsCount) && fsCount >= mirrored;
}

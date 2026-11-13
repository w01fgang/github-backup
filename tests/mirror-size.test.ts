/**
 * tests/mirror-size.test.ts
 *
 * `backupDir` may be a symlink to a backup volume. Plain `du -sb` measures
 * the link and reports a few bytes, so phase-2 compares a tiny live size to
 * the status script's real size and fails on a healthy droplet. `-D` makes
 * `du` follow the starting path.
 *
 * Hermetic: the command runs against a scratch symlink. It needs GNU du
 * (`-b`), found as `du` on Linux or `gdu` with Homebrew coreutils; otherwise
 * the test skips.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { mirrorSizeCommand } from "../scripts/lib/mirror-size";

function gnuDu(): string | null {
  for (const bin of ["du", "gdu"]) {
    const r = spawnSync(bin, ["--version"], { encoding: "utf8" });
    if (r.status === 0 && /GNU/.test(r.stdout)) {
      const which = spawnSync("sh", ["-c", `command -v ${bin}`], { encoding: "utf8" });
      return which.stdout.trim();
    }
  }
  return null;
}

const GNU_DU = gnuDu();
const FILE_BYTES = 1024 * 1024;

test(
  "the mirror size follows a backup directory that is a symlink",
  { skip: GNU_DU ? false : "needs GNU du (Linux, or gdu from coreutils)" },
  () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mirror-size-"));
    const bin = path.join(dir, "bin");
    const volume = path.join(dir, "volume");
    const link = path.join(dir, "github-backups");
    fs.mkdirSync(bin);
    fs.mkdirSync(volume);
    fs.symlinkSync(GNU_DU as string, path.join(bin, "du"));
    fs.writeFileSync(path.join(volume, "mirror.pack"), Buffer.alloc(FILE_BYTES));
    fs.symlinkSync(volume, link);

    const r = spawnSync("bash", ["-c", mirrorSizeCommand(link)], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    });
    fs.rmSync(dir, { recursive: true, force: true });

    assert.equal(r.status, 0, r.stderr);
    assert.ok(
      parseInt(r.stdout.trim(), 10) >= FILE_BYTES,
      `size ${r.stdout.trim()} is below the ${FILE_BYTES} bytes behind the link`
    );
  }
);

import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const root = path.resolve(__dirname, "..", "..");
const tsxLoader = path.join(root, "node_modules", "tsx", "dist", "loader.mjs");
const configModule = path.join(root, "scripts", "lib", "config.ts");

export function loadConfigWith(overrides: Record<string, unknown>) {
  const example = JSON.parse(
    fs.readFileSync(path.join(root, "config.example.json"), "utf8")
  ) as Record<string, unknown>;
  for (const key of Object.keys(example)) {
    if (key.startsWith("_")) delete example[key];
  }
  delete example.githubUserOrOrg;
  const cfg = { ...example, allowedSSHCidr: "203.0.113.5/32", ...overrides };

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "load-config-"));
  try {
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(cfg));
    return spawnSync(
      process.execPath,
      [
        "--import",
        tsxLoader,
        "-e",
        `require(${JSON.stringify(configModule)}).loadConfig()`,
      ],
      { encoding: "utf8", cwd: dir }
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

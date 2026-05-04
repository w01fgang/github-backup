/**
 * scripts/lib/doctl.ts
 *
 * Thin wrappers around the `doctl` CLI. Extracted verbatim from
 * scripts/create-droplet.ts so behavior is unchanged.
 */

import { runCapture } from "./ssh";

/** Run a doctl command and parse its JSON output. */
export function doctlJson<T>(cmd: string): T {
  const raw = runCapture(cmd);
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(`Failed to parse JSON from:\n  ${cmd}\n  Output: ${raw}`);
  }
}

/** Parse a doctl JSON response that may return either an array or a single object. */
export function first<T>(cmd: string): T {
  const result = doctlJson<T | T[]>(cmd);
  const item = Array.isArray(result) ? result[0] : result;
  if (item == null) {
    throw new Error(`doctl returned no record for: ${cmd}`);
  }
  return item as T;
}

/** Pull the public-network v4 IP off a droplet record. */
export function publicIp(d: {
  networks: { v4: { ip_address: string; type: string }[] };
}): string | undefined {
  return d.networks?.v4?.find((n) => n.type === "public")?.ip_address;
}

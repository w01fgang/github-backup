# github-backup

A fire-and-forget system that mirrors every repository from a GitHub user
or organisation onto a DigitalOcean droplet, keeps them up to date on a
cron schedule, and lets you clone any of them at any time over SSH.

## How it works

```
Local machine                     DigitalOcean
─────────────────────────────     ──────────────────────────────────────
npm run create-droplet      ──▶   Ubuntu droplet  +  cloud firewall
npm run bootstrap-droplet   ──▶   apt packages, gh CLI, cron job
                            (cron) github-backup.sh runs nightly
                                    gh api --paginate  → repo list
                                    git clone --mirror (new repos)
                                    git remote update  (known repos)
```

All mirrors are stored as bare repos at `/opt/github-backups/<owner>_<repo>.git`.
Any standard `git clone` command that accepts a path works against them over SSH.

---

## Project layout

```
github-backup/
├── README.md
├── docs/DECISIONS.md          ← what the D-xx / SC# / REQ ids in code comments mean
├── tests/                     ← hermetic unit tests (`npm test`, no droplet needed)
├── config.example.json        ← copy this to config.json and fill in values
├── package.json
├── tsconfig.json
├── .gitignore
├── scripts/
│   ├── create-droplet.ts      ← provisions the droplet + firewall
│   └── bootstrap-droplet.ts   ← uploads scripts + installs cron
└── droplet/
    ├── bootstrap.sh           ← runs on the droplet: installs packages, auth
    ├── github-backup.sh       ← the backup script (also run by cron)
    └── install-cron.sh        ← idempotent cron installer
```

---

## Prerequisites

| Requirement | Notes |
|---|---|
| **Node.js ≥ 24** (Active LTS) | `node --version` |
| **npm** | comes with Node |
| **doctl** | [install guide](https://docs.digitalocean.com/reference/doctl/how-to/install/) |
| **doctl authenticated** | run `doctl auth init` once |
| **SSH key in DigitalOcean** | add at <https://cloud.digitalocean.com/account/security> |
| **GitHub PAT** | scopes depend on features — see [Token scopes](#token-scopes) below |

### Token scopes

Create a token at <https://github.com/settings/personal-access-tokens/new>
(fine-grained) or <https://github.com/settings/tokens/new> (classic).

**Classic PAT:**

| Scope | When |
|---|---|
| `repo` | always (read private + public repos; `public_repo` alone misses private repos) |

`repo` already includes repo-level webhook management, so no extra scope is
needed for `register-webhooks`.

**Fine-grained PAT** — Repository permissions:

| Permission | Access | When |
|---|---|---|
| Contents | Read | always (`git clone --mirror`) |
| Metadata | Read | always (auto-required; repo listing) |
| Webhooks | Read and write | only if using `register-webhooks` |

For org-owned repos, set **Resource owner** to the org and grant it access to
the target repositories.

### Find your SSH key fingerprint

```bash
doctl compute ssh-key list
```

Copy the `FingerPrint` column value into `config.json` as `sshKeyFingerprint`.

### Find your public IP (for the firewall allowlist)

```bash
curl -s https://ipinfo.io/ip
```

---

## Setup

### 1. Copy and edit the config file

```bash
cp config.example.json config.json
```

Edit `config.json`:

```jsonc
{
  "region": "nyc3",              // doctl compute region list
  "size": "s-1vcpu-1gb",         // doctl compute size list
  "image": "ubuntu-22-04-x64",   // doctl compute image list --type distribution
  "dropletName": "github-backup",
  "firewallName": "github-backup-fw",
  "sshKeyFingerprint": "aa:bb:...", // from: doctl compute ssh-key list
  "sshKeyPath": "~/.ssh/id_rsa",
  "sshUser": "root",
  "githubUserOrOrg": "myusername",  // the user/org to back up
  "backupDir": "/opt/github-backups",
  "cronSchedule": "30 3 * * *",    // 03:30 UTC daily
  "allowedSSHCidr": "1.2.3.4/32",  // your public IP + /32
  "tags": ["github-backup"]
}
```

> **`GITHUB_TOKEN` is never stored in `config.json`.**
> It is passed as an environment variable at runtime.
> The bootstrap script stores it on the droplet in
> `/opt/github-backups/backup.env` (mode 600, readable by root only).

### 2. Install dependencies

```bash
npm install
```

---

## Provisioning

### Step 1 — Create the droplet and firewall

```bash
npm run create-droplet
```

This will:
- Check whether a droplet named `dropletName` already exists (idempotent).
- Create a new Ubuntu droplet if not.
- Poll until the droplet is active and has a public IP.
- Create a DigitalOcean **cloud firewall** named `firewallName` that allows:
  - **Inbound**: SSH (TCP 22) from `allowedSSHCidr` only.
  - **Outbound**: all TCP, UDP, ICMP (needed for apt, DNS, HTTPS git).
- Attach the droplet to the firewall.
- Save `{ id, ip, name, region }` to `.droplet.json`.

### Step 2 — Bootstrap the droplet

```bash
GITHUB_TOKEN=ghp_yourtoken npm run bootstrap-droplet
```

This will:
- Wait until SSH is accepting connections on the droplet.
- Upload `droplet/*.sh` and a generated `backup.env` to the droplet.
- Run `bootstrap.sh` remotely, which:
  - Runs `apt-get update && upgrade`.
  - Installs `git`, `gh`, `jq`, `cron`, `curl`, `gpg`.
  - Authenticates `gh` CLI with your token.
  - Runs `gh auth setup-git` so `git clone https://github.com/...` works.
  - Installs the cron job.

Both scripts are **idempotent** — running them again is safe.

---

## GitHub authentication on the droplet

Authentication is set up automatically during bootstrap.
The flow at backup time is:

1. `github-backup.sh` sources `backup.env`, exporting `GITHUB_TOKEN`.
2. `gh api` uses `GITHUB_TOKEN` to list repositories.
3. `git clone --mirror https://github.com/...` asks for credentials.
4. The credential helper (`gh auth git-credential`) returns the token.

**Token rotation**: if you issue a new PAT, re-run bootstrap with
`--rotate-env` (see [Re-running bootstrap is safe](#re-running-bootstrap-is-safe)
— without it the existing `backup.env` is preserved and the new token
never lands):

```bash
GITHUB_TOKEN=ghp_newtoken npm run bootstrap-droplet -- --rotate-env
```

### Alternative: SSH key authentication (advanced)

If you prefer SSH over HTTPS for git operations:

1. SSH into the droplet: `ssh -i ~/.ssh/id_rsa root@DROPLET_IP`
2. Generate a new key: `ssh-keygen -t ed25519 -C "github-backup-droplet"`
3. Print the public key: `cat ~/.ssh/id_ed25519.pub`
4. Add it to GitHub at <https://github.com/settings/keys>
5. Edit `github-backup.sh` and change the `CLONE_URL` to use SSH:
   ```bash
   CLONE_URL="git@github.com:${REPO_FULL}.git"
   ```

---

## Security notes

- **Cloud firewall** — the DigitalOcean firewall is enforced at the
  hypervisor level, before traffic reaches the VM. Only SSH from your
  configured CIDR is allowed inbound. This is the primary network protection.
- **Root user** — the droplet runs backups as `root`. This is an acceptable
  trade-off for a single-purpose, locked-down backup server. A dedicated
  `backup` user would add complexity with minimal gain given the firewall.
- **backup.env** — stored at `/opt/github-backups/backup.env` with mode `600`
  (root read/write only). It contains the GitHub PAT.
- **Local token handling** — `bootstrap-droplet.ts` writes the PAT to a
  temporary file (mode `0600`) in the OS temp dir and deletes it in a
  `finally` block immediately after upload.
- **SSH host keys** — `StrictHostKeyChecking=accept-new` is used for the
  initial connection. On subsequent runs it will refuse a changed host key
  (protecting against MITM), unlike `StrictHostKeyChecking=no`.

---

## Operation

### Confirm the cron job is installed

SSH into the droplet:

```bash
ssh -i ~/.ssh/id_rsa root@DROPLET_IP
crontab -l
```

You should see a line ending in `# github-backup-managed`.

### Check whether the cron daemon is running

```bash
ssh -i ~/.ssh/id_rsa root@DROPLET_IP systemctl status cron
```

### Manually trigger a backup

```bash
ssh -i ~/.ssh/id_rsa root@DROPLET_IP /opt/github-backups/github-backup.sh
```

Both the cron entry and the scripts append to `/var/log/github-backup.log`
on their own, so a manual run is already logged. To watch it live from a
second shell:

```bash
ssh -i ~/.ssh/id_rsa root@DROPLET_IP tail -f /var/log/github-backup.log
```

### Read the backup log

```bash
ssh -i ~/.ssh/id_rsa root@DROPLET_IP tail -100 /var/log/github-backup.log
```

### List all mirrored repositories

```bash
ssh -i ~/.ssh/id_rsa root@DROPLET_IP ls /opt/github-backups/*.git
```

### Clone a mirrored repo for local development

> For full disaster recovery (or to produce a portable bare mirror that survives droplet teardown), use the helper described in [Recovery → Scenario 1](#scenario-1-single-repo-recovery-everyday-case) instead.

```bash
# Clone as a normal working copy (checked-out branch):
git clone root@DROPLET_IP:/opt/github-backups/myorg_myrepo.git ~/my-project

# Restore the original upstream remote afterwards:
cd ~/my-project
git remote set-url origin https://github.com/myorg/myrepo.git
```

### Clone a bare mirror (re-mirror to another machine)

```bash
git clone --mirror root@DROPLET_IP:/opt/github-backups/myorg/myorg_myrepo.git myrepo.git
```

(Phase 6 namespaced layout — see "Multi-source + per-repo filtering" below.
The pre-Phase-6 path was `/opt/github-backups/myorg_myrepo.git`; auto-migrated
on the next backup run for single-source configs.)

---

## Multi-source + per-repo filtering

A single droplet can back up multiple users/orgs and apply per-source
allow/deny globs. Set `githubSources` in `config.json`:

```json
{
  "githubSources": [
    "myusername",
    {
      "name": "acme-org",
      "repos": {
        "allow": ["acme-org/api-*", "acme-org/web-*"],
        "deny":  ["*-archive", "acme-org/internal-secrets"]
      }
    }
  ]
}
```

Each entry is either:
- a bare string (just the github user/org name, no per-repo filter), or
- an object with `name` and an optional `repos: { allow?, deny? }`.

See `config.example.json` for the full shape.

### Allow/deny semantics

- **Empty `allow` ⇒ all repos of the source pass the allow stage** (ROADMAP SC#5).
- **Non-empty `allow` ⇒ a repo must match at least one allow glob to pass.**
- **`deny` always wins on conflict** — if any deny glob matches, the repo is
  dropped, even if an allow glob also matched (ROADMAP SC#4).
- Globs use bash `case` syntax: `*`, `?`, `[..]`. A bare pattern like `foo-*`
  matches the repo basename (after the `owner/`); an `owner/name` pattern like
  `acme/foo-*` matches the full name verbatim.
- Filters apply on **every** mirror path: the nightly cron sweep, the webhook
  listener (a denied repo's push is rejected with `403`), and
  `npm run register-webhooks` (a denied repo never gets a hook). All three
  source the same `droplet/lib/filter-repos.sh`, so there is one glob
  implementation and no drift between paths.

### Mirror layout

Phase 6 stores each mirror under a per-source subdirectory:

```
${BACKUP_DIR}/<source>/<owner>_<repo>.git
```

For example: `/opt/github-backups/acme-org/acme-org_api-orders.git`.

Phase 1 stored mirrors flat at `${BACKUP_DIR}/<owner>_<repo>.git`. The Phase 6
backup script auto-migrates this layout on the next run **when exactly one
source is configured AND it equals the legacy `githubUserOrOrg` field**. The
multi-source upgrade case is ambiguous (which source owns each legacy mirror?)
so the script refuses and tells you to run the migration tool explicitly:

### Upgrading from a Phase-1 single-source droplet

1. Set `githubSources` in `config.json` to your source name(s).
2. Re-run `GITHUB_TOKEN=… npm run bootstrap-droplet -- --rotate-env` to
   push the new `backup.env` (with `GITHUB_SOURCES` and per-source
   allow/deny lines) and create the per-source mirror subdirs. Existing
   mirrors are left in place at this stage. **`--rotate-env` is required**
   — without it the droplet's existing `backup.env` is preserved untouched
   (see [Re-running bootstrap is safe](#re-running-bootstrap-is-safe)) and
   the new source list never lands.
3. **Single-source upgrade:** trigger any backup run — `github-backup.sh`
   detects the legacy layout, moves every top-level `*.git` under
   `${BACKUP_DIR}/<legacy>/`, then proceeds normally. No manual command.
4. **Multi-source upgrade:** run
   ```bash
   npm run migrate-mirrors -- --from <legacy-source-name>
   ```
   This SSH'es to the droplet, `mv`'s each top-level `*.git` into
   `${BACKUP_DIR}/<legacy-source-name>/`, and exits. Idempotent: a second
   run prints "nothing to move".
5. Subsequent cron sweeps and webhook events run against the new layout.

### Verify

```bash
GITHUB_TOKEN=… npm run verify:phase-6
```

Five assertion groups against a live droplet:

1. `cfg.sources` matches the `GITHUB_SOURCES` line in `backup.env`,
   plus per-source allow/deny env lines.
2. `${BACKUP_DIR}/<source>/` exists per source; no top-level `*.git`
   remains (legacy fully migrated).
3. Per-source `BACKUP_SOURCE_SUMMARY` log line per source; aggregate
   `BACKUP_SUMMARY` upstream/mirrored equal the sum of per-source lines.
4. `repos.deny` enforcement — denied repos have no on-disk mirror.
5. The TS `envSlot()` and bash `slot()` functions agree on every
   configured source name (cross-language contract).

Soft-skips groups 1+2+5 with a clear message when only one source is
configured (the multi-source path is the one being verified).

### Back-compat with Phase 1

`githubUserOrOrg` is still accepted as a legacy single-source field. If both
`githubUserOrOrg` and `githubSources` are set, `githubSources` wins with a
printed deprecation warning. The legacy `GITHUB_USER_OR_ORG=…` line is also
written to `backup.env` so a not-yet-upgraded `github-backup.sh` keeps working
against source #1. Removing `githubUserOrOrg` is a v2 breaking change, deferred.

---

## Webhook setup

The webhook listener delivers near-instant `git remote update` per pushed
repo. The nightly cron sweep stays as a safety net for missed deliveries,
deleted repos, and idle repos that never push.

### Prerequisites

- Operator owns a domain (e.g. `backup.example.com`).
- BEFORE `npm run bootstrap-droplet`: point an A record at the droplet's
  public IP. Caddy needs the DNS record live for the Let's Encrypt ACME
  HTTP-01 challenge to succeed. Bootstrap does not validate DNS — the first
  webhook attempt fails loud if the cert was never issued.

### Config additions

In `config.json`:

```json
{
  "webhookHostname": "backup.example.com",
  "webhookTestRepo": "your-owner/your-test-repo"
}
```

- `webhookHostname` (REQUIRED): the FQDN you pointed at the droplet IP.
- `webhookTestRepo` (OPTIONAL, `<owner>/<repo>`): consumed only by
  `npm run verify:phase-3` group 4 (end-to-end push). Unset = group 4
  skipped without failing the run.

### First-time setup

```bash
# 1. Provision droplet + firewall (opens TCP/22, 80, 443).
npm run create-droplet

# 2. Bootstrap the droplet — installs Caddy, Node, cron, systemd unit;
#    generates WEBHOOK_SECRET and writes it only to backup.env (mode 0600)
#    on the droplet. It is never printed — step 3 reads it over SSH.
GITHUB_TOKEN=ghp_… npm run bootstrap-droplet

# 3. Register webhooks on every repo of cfg.githubUserOrOrg.
#    Reads WEBHOOK_SECRET from the droplet over SSH each time — no local
#    secret cache that can drift after rotation.
npm run register-webhooks

# 4. Verify the full plane end-to-end.
npm run verify:phase-3
```

### Secret rotation

```bash
GITHUB_TOKEN=ghp_… npm run bootstrap-droplet -- --rotate-webhook-secret
npm run register-webhooks -- --update
```

`--rotate-webhook-secret` rewrites `backup.env` on its own — it does not
need `--rotate-env` — but it still requires `GITHUB_TOKEN` to be set,
since any `backup.env` rewrite regenerates the whole file. The first
command regenerates `WEBHOOK_SECRET` on the droplet, writing it only to
`backup.env`; the second PATCHes every existing GitHub webhook with the new
secret. Skipping step 2 means GitHub keeps signing with the OLD secret
and the listener rejects every event with 401.

### Live tail

```bash
ssh root@<droplet-ip> journalctl -u github-backup-webhook -f
```

The listener logs to the systemd journal — no separate log file. The
cron-driven backup still writes to `/var/log/github-backup.log`.

### Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `verify:phase-3` Group 1 LE-cert assertion fails | DNS not pointed at droplet OR port 80 blocked OR Caddy never tried (no incoming request triggered ACME) | `dig A <webhookHostname>` must show droplet IP. `curl -v http://<webhookHostname>/` from anywhere triggers Caddy's first ACME attempt. `journalctl -u caddy --since 5m` shows the ACME error. |
| Webhook deliveries show 401 in GitHub Settings → Webhooks → Recent Deliveries | Secret mismatch between GitHub and droplet | Run `npm run register-webhooks -- --update` after any `--rotate-webhook-secret`. |
| Webhook fires but mirror does not update | `sync-one-repo.sh` exited non-zero (network, git error) | `grep BACKUP_REPO_RESULT /var/log/github-backup.log \| tail` — look for `action=fail`. Then `journalctl -u github-backup-webhook -n 50`. |
| Some repos sync via cron only, never via webhook | Webhook not registered on those repos | `gh api repos/<owner>/<repo>/hooks` should show one entry with `config.url` matching `webhookHostname`. Re-run `npm run register-webhooks`. |

---

## Lifecycle

### Re-running bootstrap is safe

`npm run bootstrap-droplet` is idempotent. On a droplet that has already
been bootstrapped, the on-droplet `backup.env` (which holds your
`GITHUB_TOKEN`) is **preserved by default** — re-running after editing
`droplet/*.sh` will ship the script changes without touching your token.
A line like `▸ /opt/github-backups/backup.env exists on droplet —
preserving` confirms the skip.

To deliberately overwrite `backup.env` — rotating your PAT, changing
`githubSources` (including per-source `repos.allow` / `repos.deny`
filters), or changing `cronSchedule` / `githubUserOrOrg` in
`config.json` — pass `--rotate-env`:

```bash
GITHUB_TOKEN=<new_pat> npm run bootstrap-droplet -- --rotate-env
```

`--rotate-env` requires `GITHUB_TOKEN` to be set.

### Teardown

Manual: delete the droplet from the
[DigitalOcean control panel](https://cloud.digitalocean.com/droplets),
then remove the local `.droplet.json`. There is no `npm run destroy-droplet`
command — single-operator scale, single command at the DO dashboard.

### Verify idempotency

```bash
npm run verify:phase-5
```

Asserts `backup.env` is preserved across a re-run, exactly one
`# github-backup-managed` cron line exists before and after, and (if
`GITHUB_TOKEN` is set) the `--rotate-env` round-trip leaves the file
parseable. Non-destructive by default.

---

## Recovery

The droplet mirrors are a read-only sink. Recovery flows are one-way:
`droplet → local`. There is no automated path to push local changes back
to the droplet, and no automated path to re-hydrate github.com after a
loss — both are manual operator actions, scoped to v1 by design.

### Scenario 1: Single-repo recovery (everyday case)

You lost your laptop, want to work offline, or just want a fresh working
clone of a backed-up repo on a new machine. Use the `restore` helper:

```bash
npm run restore -- myorg/myrepo ~/myrepo-recovered
```

The helper:

1. Clones the bare mirror from the droplet (via SSH, using `config.json`
   `sshKeyPath`) into an OS temp directory.
2. Clones a working copy from that local bare mirror into the target
   directory you passed.
3. Leaves the temp bare mirror in place (small, safe to delete, lets you
   re-clone offline without hitting the droplet again).

The restored working clone's `origin` points at the local bare mirror,
not at github.com or the droplet. To repoint at github.com for everyday
work:

```bash
cd ~/myrepo-recovered
git remote set-url origin https://github.com/myorg/myrepo.git
git fetch origin
```

### Scenario 2: GitHub is gone / account compromised

The github.com side of your data is unrecoverable (account locked, org
deleted, a security incident forces a fresh start). You want to push
your restored mirrors back up to a NEW account or git host. This is a
manual operator-driven flow — there is no `restore-and-rehydrate`
automation in v1, by design. For each repo:

1. Restore the bare mirror locally — `npm run restore -- <owner>/<repo>
   <target>` writes the intermediate bare mirror to `$TMPDIR/github-backup-
   restore-XXXX/<owner>_<repo>.git`. Pull that path out for the push in
   step 3 (you do not need the working clone for this scenario).
2. Create a brand-new empty repo on the destination (github.com under a
   new account, GitLab, Codeberg, self-hosted, etc.). Do NOT enable any
   auto-init template — the new repo must be empty.
3. Push the bare mirror, including all branches and tags:
   ```bash
   cd "$TMPDIR/github-backup-restore-XXXX/myorg_myrepo.git"  # the bare mirror, NOT the working clone
   git push --mirror https://github.com/new-owner/myrepo.git
   ```
4. Repeat per repo. If you have many repos, scripting this loop is on
   you — v1 single-operator scope does not ship a bulk command. Iterate
   over `ls /opt/github-backups/*.git` on the droplet to enumerate.

**Caveat:** `--mirror` push rewrites every ref on the destination. Only
use this against a NEW empty repo. Do not run it against a repo someone
else is also pushing to.

### Verifying restore correctness

`npm run verify:phase-4` runs the helper against the repo named in
`config.json` `restoreTestRepo` and asserts the restored clone's refs
match the droplet mirror byte-for-byte (sorted `git for-each-ref` diff).
Use it as a smoke test after any change to the restore path or the
droplet mirror layout.

To check that the comparison itself still has teeth, run it with the
negative-test flag:

```bash
npm run verify:phase-4 -- --inject-ref-mismatch
```

It writes a throwaway ref into the restored bare mirror after the clone
and before the comparison, so exit 1 plus `local-only count : 1` is the
pass. The droplet is never written to; exit 2 means the injected
divergence went unnoticed.

See also: [Clone a mirrored repo for local development](#clone-a-mirrored-repo-for-local-development)
for the lighter-weight "I just want offline access, not full recovery"
case (single direct `git clone`, origin pointed at the droplet).

### Update the cron schedule without re-running full bootstrap

SSH in and edit/reinstall the crontab directly:

```bash
ssh -i ~/.ssh/id_rsa root@DROPLET_IP
# Edit CRON_SCHEDULE in the env file:
nano /opt/github-backups/backup.env
# Re-install the cron job:
/opt/github-backups/install-cron.sh
crontab -l   # verify
```

---

## Overriding defaults

All values in `config.json` can be overridden. Key fields:

| Field | Default | Override |
|---|---|---|
| `region` | `nyc3` | any `doctl compute region list` slug |
| `size` | `s-1vcpu-1gb` | any size slug |
| `image` | `ubuntu-22-04-x64` | any Ubuntu image slug |
| `cronSchedule` | `30 3 * * *` | any valid cron expression |
| `backupDir` | `/opt/github-backups` | any absolute path on the droplet |
| `allowedSSHCidr` | — | `0.0.0.0/0` to allow all (not recommended) |

`GITHUB_TOKEN` is always an environment variable — never in `config.json`.

---

## Droplet file manifest

The table below lists every file that `npm run bootstrap-droplet` ships to the
droplet, alongside its purpose and the owning phase. The list is generated from
`scripts/lib/droplet-manifest.ts` — run `npm run sync:readme` to regenerate
after editing the manifest. Pre-commit hook + CI reject any commit that leaves
this section stale.

<!-- BEGIN: droplet-manifest -->
<!-- AUTO-GENERATED by `npm run sync:readme` from scripts/lib/droplet-manifest.ts — DO NOT EDIT BY HAND -->

| Path | Purpose | Phase | Tier |
|------|---------|-------|------|
| `droplet/bootstrap.sh` | Server-side bootstrap entrypoint | phase-1 | required |
| `droplet/github-backup.sh` | Cron entrypoint (sync loop) | phase-1 | required |
| `droplet/github-backup-status.sh` | Operator status command | phase-1 | required |
| `droplet/install-cron.sh` | Cron installer invoked by bootstrap.sh | phase-1 | required |
| `droplet/sync-one-repo.sh` | Per-repo clone/update with structured log | phase-7 | required |
| `droplet/Caddyfile.template` | Webhook trio: Caddy reverse-proxy template | phase-3 | required |
| `droplet/github-backup-webhook.service` | Webhook trio: systemd unit | phase-3 | required |
| `droplet/webhook-listener.js` | Webhook trio: Node listener | phase-3 | required |
| `droplet/lib/detect-account-type.sh` | Lib: User/Organization detection (cached) | phase-7 | required |
| `droplet/lib/filter-repos.sh` | Lib: per-source allow/deny glob filter | phase-7 | required |
| `droplet/lib/resolve-repo-endpoint.sh` | Lib: repo-list endpoint (private repos included) | phase-7 | required |

<!-- END: droplet-manifest -->

## Firewall ruleset

The DigitalOcean firewall attached to the droplet enforces the following rules.
The canonical set is encoded in `scripts/create-droplet.ts`; if an operator (or
another tool) edits these rules in the DO console, re-run `npm run create-droplet`
to detect and repair the drift — the script logs `+ [inbound] Adding rule:` /
`+ [outbound] Adding rule:` for each restored entry and
`✓ [inbound|outbound] Rule already present:` for entries that match.

**Inbound:**

| Protocol | Port | Sources |
|----------|------|---------|
| TCP | 22 | `cfg.allowedSSHCidr` (from `config.json`) |
| TCP | 80 | `0.0.0.0/0`, `::/0` |
| TCP | 443 | `0.0.0.0/0`, `::/0` |

**Outbound:**

| Protocol | Port | Destinations |
|----------|------|--------------|
| TCP | all | `0.0.0.0/0`, `::/0` |
| UDP | all | `0.0.0.0/0`, `::/0` |
| ICMP | — | `0.0.0.0/0`, `::/0` |

**Drift policy:** outbound reconcile is strict canonical-only — `create-droplet`
adds any missing canonical rule but never removes operator-added extras (e.g. a
TCP egress restriction to a private network). Inbound reconcile follows the same
shape.

---

## Troubleshooting

**`doctl` returns a firewall error about outbound rules format**
Try removing the IPv6 address `0:0:0:0:0:0:0:0/0` from the `--outbound-rules`
arguments in `scripts/create-droplet.ts` if your doctl version doesn't support it.

**SSH connection refused after `create-droplet`**
The droplet needs ~30–60 s after becoming "active" for sshd to start. The
`waitForSsh` function in `bootstrap-droplet.ts` handles this automatically.

**git clone fails with "authentication required"**
The PAT in `backup.env` may have expired. Update it (`--rotate-env` is
required — see [Re-running bootstrap is safe](#re-running-bootstrap-is-safe)):
```bash
GITHUB_TOKEN=ghp_newtoken npm run bootstrap-droplet -- --rotate-env
```

**Backup script fails for private repos**
Ensure your PAT has the `repo` scope (not just `public_repo`).

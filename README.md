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
| **Node.js ≥ 18** | `node --version` |
| **npm** | comes with Node |
| **doctl** | [install guide](https://docs.digitalocean.com/reference/doctl/how-to/install/) |
| **doctl authenticated** | run `doctl auth init` once |
| **SSH key in DigitalOcean** | add at <https://cloud.digitalocean.com/account/security> |
| **GitHub PAT** | needs `repo` scope (read) — [create one here](https://github.com/settings/tokens/new) |

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

**Token rotation**: if you issue a new PAT, re-run bootstrap:

```bash
GITHUB_TOKEN=ghp_newtoken npm run bootstrap-droplet
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

Or watch it live:

```bash
ssh -i ~/.ssh/id_rsa root@DROPLET_IP \
  '/opt/github-backups/github-backup.sh 2>&1 | tee -a /var/log/github-backup.log'
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

```bash
# Clone as a normal working copy (checked-out branch):
git clone root@DROPLET_IP:/opt/github-backups/myorg_myrepo.git ~/my-project

# Restore the original upstream remote afterwards:
cd ~/my-project
git remote set-url origin https://github.com/myorg/myrepo.git
```

### Clone a bare mirror (re-mirror to another machine)

```bash
git clone --mirror root@DROPLET_IP:/opt/github-backups/myorg_myrepo.git myrepo.git
```

---

## Recovery

### Restore a single repo from a mirror

```bash
# 1. Pull the bare mirror from the droplet
git clone --mirror root@DROPLET_IP:/opt/github-backups/myorg_myrepo.git ~/myrepo.git

# 2. Clone a working copy from the local mirror
git clone ~/myrepo.git ~/myrepo-recovered

# 3. Point to the original upstream (optional)
cd ~/myrepo-recovered
git remote set-url origin https://github.com/myorg/myrepo.git
git fetch origin
```

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

## Troubleshooting

**`doctl` returns a firewall error about outbound rules format**
Try removing the IPv6 address `0:0:0:0:0:0:0:0/0` from the `--outbound-rules`
arguments in `scripts/create-droplet.ts` if your doctl version doesn't support it.

**SSH connection refused after `create-droplet`**
The droplet needs ~30–60 s after becoming "active" for sshd to start. The
`waitForSsh` function in `bootstrap-droplet.ts` handles this automatically.

**git clone fails with "authentication required"**
The PAT in `backup.env` may have expired. Update it:
```bash
GITHUB_TOKEN=ghp_newtoken npm run bootstrap-droplet
```

**Backup script fails for private repos**
Ensure your PAT has the `repo` scope (not just `public_repo`).

# github-backup

github-backup mirrors every repository of a GitHub user or organization onto a DigitalOcean droplet. The owner of the backups runs it from a local machine.

Read first: `README.md`, then `docs/DECISIONS.md`.
Decisions: `docs/DECISIONS.md` defines each decision ID that the code cites, such as `D-07` or `REPOS-01`. When the human decides how something is done here, add an entry there.

## Commands

- Run it: there is no local server. `npm run status` connects to the live droplet over SSH and shows the backup state. It needs `config.json` (copy `config.example.json`) and `.droplet.json`.
- Test: `npm test`
- Typecheck: `npx tsc -p tsconfig.json --noEmit`
- Syntax check: `find droplet -name '*.js' -print0 | xargs -0 -n1 node --check` and `find droplet -name '*.sh' -print0 | xargs -0 -n1 bash -n` and `bash -n scripts/git-hooks/pre-commit`
- README sync check: `npm run check:readme`

CI (`.github/workflows/sync-check.yml`) runs all of these commands except `npm run status`.

## How work moves here

1. **Plan.** A piece of work starts as a plan: `plan.md` at the root, one at a time. A plan moves to `docs/plans/done/` when all of its issues are closed. A new `plan.md` starts only after that move, so `Source: plan.md § <n>` points at the plan of each open issue. The `.planning/` folder holds the GSD record of the earlier phases. Do not add new plans there.
2. **Split.** The plan is split into issues with the `split-plan` skill (`.agents/skills/split-plan/`). Every issue carries `Source: plan.md § <n>` and `Done when:`.
3. **Human review.** A human reviews the split before any issue is published. No issue is published without their yes.
4. **Workers.** One worker per issue, each on its own branch or worktree. Pick the model and the effort per issue: the strongest for logic, a cheaper one for views, copy and tests.
5. **Closing comment.** A worker closes its issue with a comment in exactly this shape:

   ```
   done: <what changed, one line>
   worker: <harness> · <model> · <effort>
   commit: <sha or "none">
   ```

   `<harness>` is the harness's own name (claude-code, codex, cursor, omp, pi), `<model>` the model id the harness reports, `<effort>` the reasoning effort it ran at.
6. **Closing.** An issue is closed only when its `Done when` holds. If it can't hold yet, it stays open and says what it waits on.

## Issues

Issues live in files in `docs/issues/<NNN>-<slug>.md`. One place per plan, never a mix.

Every issue carries `Source:` and `Done when:`, plus the lines, the front matter and the sections that `split-plan` writes for an issue file. Nothing else is required.

## Skills

Shared skills live in `.agents/skills/`, one folder each, with a `SKILL.md` inside. That folder is the one source for every harness on this repo. A harness that loads skills from somewhere else points there, with a link or a config entry. Never copy a skill: copies drift.

## Rules

- Never commit `.env`, tokens or keys. `config.json`, `.droplet.json` and `backup.env` stay out of git.
- The `npm run` scripts other than `test`, `check:readme` and `sync:readme` connect to the live droplet, DigitalOcean or GitHub. Some of them change the droplet, its firewall or the GitHub webhooks. Run one only when the issue asks for it.
- After a change to `scripts/lib/droplet-manifest.ts`, run `npm run sync:readme`. The pre-commit hook and CI reject a README that is out of sync.
- Do not add a script that destroys the droplet. The owner removes it from the DigitalOcean dashboard.
- When the droplet or its firewall behaves in an unexpected way, compare the applied state (`doctl compute firewall get`) with the intended state first. `doctl` ignores an incorrect parameter without an error, so read its docs before a call.

## Primitives map

The file `docs/contributing/architecture/primitives.yaml` names the primitives of this repo. A primitive is a unit that a contributor must know by name. Each primitive owns code roots. The file also lists the invariants: rules that hold across primitives.

Before you change code:

1. Read the map. Find the primitives that own the files that you change.
2. Read the invariants. Do not break an invariant. When a change must break one, tell the user before you make the change.

Before you open a PR:

1. Commit all your changes. `classify` reads committed history only, and it does not see staged, unstaged or untracked files.
2. Run `node scripts/primitives.mjs classify --markdown`. Use `--base <branch>` when the PR does not target `master`.
3. Put the table in the PR body.
4. Put one risk label in the PR body:
   - `composes`: the diff connects existing primitives and changes none of them.
   - `extends`: the diff changes the behavior, the shape or the contract of a primitive.
   - `adds`: the diff adds a primitive.
5. A diff that touches no primitive gets no label. Write that in the PR body.

When a diff adds, removes, renames or moves a primitive, or changes what a summary says:

1. Update the map in the same PR. Edit only the entries that the diff changes.
2. Run `node scripts/primitives.mjs check`. Its output must start with `primitives map ok`.
3. Commit the map, then run `classify` again.

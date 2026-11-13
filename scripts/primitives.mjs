#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const MAP_FILE = 'docs/contributing/architecture/primitives.yaml';
const USAGE = 'Usage: primitives.mjs check | classify [--base <ref>] [--head <ref>] [--markdown]';

const SECTIONS = ['groups', 'primitives', 'invariants'];
const FOLDED = new Set(['', '>-', '>']);
const BAD_ROOT = /^(\.{1,2}\/|\/)|\/\/|(^|\/)\.\.(\/|$)/;

const newEntry = (id, line) => ({ id, line, group: '', name: '', summary: '', code: [], docs: [] });

function parseMap(text) {
  const map = { versions: [], groups: [], primitives: [], invariants: [], unparsed: [] };
  let section = null;
  let entry = null;
  let list = null;
  const seenKeys = new Set();

  text.split(/\r?\n/).forEach((line, index) => {
    const lineNumber = index + 1;
    const unparsed = () => map.unparsed.push(lineNumber);
    if (!line.trim() || line.trimStart().startsWith('#')) return;
    if (/^version:\s*1\s*$/.test(line)) return map.versions.push(lineNumber);

    const sectionMatch = line.match(/^(\w+):\s*$/);
    if (sectionMatch) {
      section = SECTIONS.includes(sectionMatch[1]) ? sectionMatch[1] : null;
      entry = null;
      list = null;
      if (!section) unparsed();
      return;
    }

    const itemMatch = line.match(/^ {2}- id:\s+(\S+)\s*$/);
    if (itemMatch && section) {
      entry = newEntry(itemMatch[1], lineNumber);
      map[section].push(entry);
      seenKeys.clear();
      list = null;
      return;
    }

    const fieldMatch = entry && line.match(/^ {4}(group|name|summary|code|docs):\s*(.*?)\s*$/);
    if (fieldMatch) {
      const [, key, value] = fieldMatch;
      list = null;
      if (seenKeys.has(key) || /^["']/.test(value) || / #/.test(value)) return unparsed();
      seenKeys.add(key);
      if (key === 'code' || key === 'docs') {
        if (value && value !== '[]') return unparsed();
        if (!value) list = key;
      } else if (key === 'summary' && FOLDED.has(value)) list = 'summary';
      else if (/^[|>]/.test(value)) unparsed();
      else entry[key] = value;
      return;
    }

    const listItem = line.match(/^ {6}- (\S+)\s*$/);
    if (listItem && (list === 'code' || list === 'docs')) {
      entry[list].push(listItem[1]);
      return;
    }

    const folded = line.match(/^ {6}(\S.*?)\s*$/);
    if (folded && list === 'summary') {
      entry.summary = `${entry.summary} ${folded[1]}`.trim();
      return;
    }

    unparsed();
  });

  return map;
}

function rootOwns(root, file) {
  if (root.endsWith('/')) return file.startsWith(root);
  return file === root || file.replace(/\.test(\.[^./]+)$/, '$1') === root;
}

function classify(files, maps) {
  const rootsPerMap = maps.map((map) =>
    map.primitives
      .flatMap((primitive) => primitive.code.map((root) => ({ id: primitive.id, root })))
      .sort((a, b) => b.root.length - a.root.length),
  );
  const touched = new Map();
  const unowned = [];

  for (const file of files) {
    const owners = new Set(
      rootsPerMap.flatMap((roots) => roots.find(({ root }) => rootOwns(root, file))?.id ?? []),
    );
    if (!owners.size) unowned.push(file);
    for (const id of owners) touched.set(id, [...(touched.get(id) ?? []), file]);
  }
  return { touched, unowned };
}

function checkMap(map, repoRoot) {
  const errors = map.unparsed.map((line) => `line ${line}: cannot parse this line`);
  if (!map.versions.length) errors.push('missing version: 1');
  for (const line of map.versions.slice(1)) errors.push(`line ${line}: duplicate version`);
  const groupIds = new Set();
  for (const group of map.groups) {
    const where = `group ${group.id} (line ${group.line})`;
    if (groupIds.has(group.id)) errors.push(`${where}: duplicate id`);
    groupIds.add(group.id);
    if (!group.name) errors.push(`${where}: missing name`);
  }

  const seenIds = new Set();
  const seenRoots = new Map();
  for (const [kind, entries] of [['primitive', map.primitives], ['invariant', map.invariants]]) {
    for (const entry of entries) {
      const where = `${kind} ${entry.id} (line ${entry.line})`;
      if (seenIds.has(entry.id)) errors.push(`${where}: duplicate id`);
      seenIds.add(entry.id);
      if (!entry.summary) errors.push(`${where}: missing summary`);
      if (kind === 'primitive' && !entry.name) errors.push(`${where}: missing name`);
      if (kind === 'primitive' && !groupIds.has(entry.group)) errors.push(`${where}: unknown group "${entry.group}"`);
      if (kind === 'primitive' && !entry.code.length) errors.push(`${where}: no code roots`);
      for (const root of entry.code) {
        if (BAD_ROOT.test(root)) {
          errors.push(`${where}: code root ${root} is not a plain repo-relative path`);
          continue;
        }
        if (kind === 'primitive') {
          const owner = seenRoots.get(root);
          if (owner) errors.push(`${where}: code root ${root} is also owned by ${owner}`);
          seenRoots.set(root, entry.id);
        }
        const full = path.join(repoRoot, root);
        if (!existsSync(full)) errors.push(`${where}: code root ${root} does not exist`);
        else if (!root.endsWith('/') && !statSync(full).isFile()) errors.push(`${where}: code root ${root} is a directory; end it with /`);
      }
      for (const doc of entry.docs) {
        if (BAD_ROOT.test(doc)) errors.push(`${where}: doc ${doc} is not a plain repo-relative path`);
        else if (!existsSync(path.join(repoRoot, doc))) errors.push(`${where}: doc ${doc} does not exist`);
      }
    }
  }
  return errors;
}

const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: Infinity, stdio: ['ignore', 'pipe', 'pipe'] });

function defaultBase(cwd) {
  const head = spawnSync('git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], { cwd, encoding: 'utf8' });
  if (head.status === 0 && head.stdout.trim()) return head.stdout.trim();
  for (const candidate of ['origin/main', 'origin/master']) {
    if (spawnSync('git', ['rev-parse', '--verify', '--quiet', candidate], { cwd }).status === 0) return candidate;
  }
  throw new Error('cannot find the default branch; pass --base <ref>');
}

function mapAt(ref, cwd) {
  const shown = spawnSync('git', ['show', `${ref}:${MAP_FILE}`], { cwd, encoding: 'utf8', maxBuffer: Infinity });
  return shown.status === 0 ? parseMap(shown.stdout) : null;
}

function verifyRef(ref, cwd) {
  if (ref.startsWith('-') || spawnSync('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd }).status !== 0) {
    throw new Error(`not a commit: ${ref}`);
  }
  return ref;
}

function runCheck(repoRoot) {
  const mapPath = path.join(repoRoot, MAP_FILE);
  if (!existsSync(mapPath)) throw new Error(`no primitives map at ${MAP_FILE}`);
  const map = parseMap(readFileSync(mapPath, 'utf8'));
  const errors = checkMap(map, repoRoot);
  if (errors.length) {
    console.error(errors.join('\n'));
    return 1;
  }
  console.log(`primitives map ok: ${map.primitives.length} primitives, ${map.invariants.length} invariants`);
  return 0;
}

function runClassify(repoRoot, options) {
  const base = verifyRef(options.base ?? defaultBase(repoRoot), repoRoot);
  const head = verifyRef(options.head ?? 'HEAD', repoRoot);
  const range = `${base}...${head}`;
  const headMap = mapAt(head, repoRoot);
  const baseMap = mapAt(base, repoRoot);
  const maps = [headMap, baseMap].filter(Boolean);
  if (!maps.length) throw new Error(`no primitives map at ${MAP_FILE} in ${head} or ${base}`);
  if (maps.some((map) => map.unparsed.length)) console.error('warning: the map has lines that cannot be parsed; run check');
  const files = git(['diff', '-z', '--name-only', '--no-renames', range], repoRoot).split('\0').filter(Boolean);
  const addsMap = git(['diff', '--name-only', '--no-renames', '--diff-filter=A', range, '--', MAP_FILE], repoRoot).trim() !== '';
  const { touched, unowned } = classify(files, maps);
  const groupOf = new Map([...maps].reverse().flatMap((each) => each.primitives).map((primitive) => [primitive.id, primitive.group]));
  const rows = [...touched].sort(([a], [b]) => a.localeCompare(b));

  if (options.markdown) {
    console.log('### Primitives touched\n');
    if (rows.length) {
      console.log('| Primitive | Group | Files |\n| --- | --- | --- |');
      for (const [id, owned] of rows) console.log(`| \`${id}\` | ${groupOf.get(id)} | ${owned.length} |`);
    } else if (!addsMap) console.log('This diff touches no primitive. It gets no label.');
    console.log(`\nFiles outside every primitive: ${unowned.length}.`);
    if (addsMap) console.log(`This diff adds \`${MAP_FILE}\`. Label the PR \`adds\`.`);
    else if (rows.length) console.log(`Label the PR \`composes\`, \`extends\`, or \`adds\`. See \`${MAP_FILE}\`.`);
  } else {
    console.log(`${files.length} files changed in ${range}`);
    for (const [id, owned] of rows) console.log(`${id} (${groupOf.get(id)})\n  ${owned.join('\n  ')}`);
    if (unowned.length) console.log(`unowned\n  ${unowned.join('\n  ')}`);
  }
  return 0;
}

function parseOptions(command, args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (command !== 'classify') return null;
    if (arg === '--markdown') options.markdown = true;
    else if ((arg === '--base' || arg === '--head') && index + 1 < args.length) options[arg.slice(2)] = args[++index];
    else return null;
  }
  return options;
}

function main([command, ...args]) {
  const options = (command === 'check' || command === 'classify') && parseOptions(command, args);
  if (!options) {
    console.error(USAGE);
    return 2;
  }
  const repoRoot = git(['rev-parse', '--show-toplevel'], process.cwd()).trim();
  return command === 'check' ? runCheck(repoRoot) : runClassify(repoRoot, options);
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  console.error(error.stderr?.toString().trim() || error.message);
  process.exitCode = 1;
}

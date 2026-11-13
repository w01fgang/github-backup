/**
 * scripts/lib/uat-source-rows.ts
 *
 * Shell fragments of UAT scenario p01-05 that turn config.json into one row
 * per source: <name>US<allow globs>US<deny globs>, US = 0x1f. US is not
 * whitespace, so `read` keeps an empty allow field as an empty field, and the
 * deny globs stay in the deny field. The deprecated single-source key
 * githubUserOrOrg is read only when githubSources is absent or empty.
 */

export const SOURCE_ROWS_ASSIGN =
  "ROWS=$(node -e \"const c=require('./config.json'); let s=(c.githubSources||[]); if(!s.length && c.githubUserOrOrg) s=[c.githubUserOrOrg]; for (const e of s) { const n = typeof e==='string' ? e : (e && e.name); if(!n) continue; const f=(e && e.repos) || {}; console.log([n, (f.allow||[]).join(' '), (f.deny||[]).join(' ')].join('\\x1f')); }\"); ";

export const SOURCE_ROWS_READ_HEAD =
  "while IFS=$'\\x1f' read -r SLUG ALLOW DENY; do ";

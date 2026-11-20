// Builds the README's GitHub-activity tiles (light + dark SVG) from the GraphQL API.
// No dependencies: Node 20+.  Usage: GH_TOKEN=... node .github/scripts/activity.mjs [outDir]
// Runs daily in .github/workflows/profile-activity.yml with the workflow's GITHUB_TOKEN.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const LOGIN = process.env.GH_USER || 'Tiyouw';
const TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
const OUT = process.argv[2] || 'dist';
if (!TOKEN) { console.error('GH_TOKEN or GITHUB_TOKEN is required'); process.exit(1); }

async function gql(query, variables = {}) {
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: { Authorization: `bearer ${TOKEN}`, 'Content-Type': 'application/json', 'User-Agent': 'tiyouw-profile-activity' },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data;
}

// ---------- data ----------
const now = new Date();
const year = now.getUTCFullYear();
const { user: base } = await gql(`query($login:String!){user(login:$login){createdAt
  repositories(ownerAffiliations:OWNER, isFork:false, privacy:PUBLIC, first:100){nodes{
    languages(first:10, orderBy:{field:SIZE, direction:DESC}){edges{size node{name}}}}}}}`, { login: LOGIN });

const days = [];
let thisYear = null;
for (let y = new Date(base.createdAt).getUTCFullYear(); y <= year; y++) {
  const from = `${y}-01-01T00:00:00Z`;
  const to = y === year ? now.toISOString() : `${y}-12-31T23:59:59Z`;
  const { user } = await gql(`query($login:String!,$from:DateTime!,$to:DateTime!){user(login:$login){contributionsCollection(from:$from,to:$to){
    contributionCalendar{totalContributions weeks{contributionDays{date contributionCount}}}
    commitContributionsByRepository(maxRepositories:100){repository{isPrivate} contributions{totalCount}}
    pullRequestContributionsByRepository(maxRepositories:100){repository{isPrivate} contributions{totalCount}}
    issueContributionsByRepository(maxRepositories:100){repository{isPrivate} contributions{totalCount}}
    pullRequestReviewContributionsByRepository(maxRepositories:100){repository{isPrivate} contributions{totalCount}}
    restrictedContributionsCount}}}`,
    { login: LOGIN, from, to });
  const c = user.contributionsCollection;
  for (const w of c.contributionCalendar.weeks) for (const d of w.contributionDays) days.push(d);
  if (y === year) {
    const pub = (list) => list.filter((r) => !r.repository.isPrivate).reduce((s, r) => s + r.contributions.totalCount, 0);
    const priv = (list) => list.filter((r) => r.repository.isPrivate).reduce((s, r) => s + r.contributions.totalCount, 0);
    // Private work: with the workflow's GITHUB_TOKEN it arrives only as restrictedContributionsCount
    // (when "Include private contributions" is on); with the owner's own token it shows per repository.
    const privateCount = c.restrictedContributionsCount + priv(c.commitContributionsByRepository) +
      priv(c.pullRequestContributionsByRepository) + priv(c.issueContributionsByRepository) + priv(c.pullRequestReviewContributionsByRepository);
    thisYear = {
      total: c.contributionCalendar.totalContributions,
      commits: pub(c.commitContributionsByRepository),
      prs: pub(c.pullRequestContributionsByRepository),
      issues: pub(c.issueContributionsByRepository),
      reviews: pub(c.pullRequestReviewContributionsByRepository),
      private: privateCount,
      weeks: c.contributionCalendar.weeks,
    };
  }
}

// streaks (days are in the calendar's own dates; today may still be empty)
const byDate = new Map(days.map((d) => [d.date, d.contributionCount]));
const sorted = [...byDate.keys()].sort();
let longest = 0, run = 0;
for (const d of sorted) { run = byDate.get(d) > 0 ? run + 1 : 0; longest = Math.max(longest, run); }
let current = 0;
let i = sorted.length - 1;
if (i >= 0 && byDate.get(sorted[i]) === 0) i--; // a quiet today doesn't break the streak yet
for (; i >= 0 && byDate.get(sorted[i]) > 0; i--) current++;
const allTime = [...byDate.values()].reduce((a, b) => a + b, 0);

// languages across public, non-fork repos, by bytes
const langs = new Map();
for (const r of base.repositories.nodes) for (const e of r.languages.edges) langs.set(e.node.name, (langs.get(e.node.name) || 0) + e.size);
const langTotal = [...langs.values()].reduce((a, b) => a + b, 0) || 1;
const topLangs = [...langs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name, size]) => ({ name, pct: (size / langTotal) * 100 }));

// ---------- render ----------
const THEMES = {
  dark: { bg: '#0c0c0d', fg: '#efece6', muted: '#9b978f', line: '#27272a', accent: '#ff8a3d', accentText: '#ff8a3d', empty: '#1c1c1e' },
  light: { bg: '#f3f2ee', fg: '#0c0c0d', muted: '#5c5852', line: '#dedbd3', accent: '#ff8a3d', accentText: '#b4531a', empty: '#e4e1da' },
};
const b64 = (f) => readFileSync(join(ROOT, 'assets', 'readme', 'fonts', f)).toString('base64');
const FONTS = `@font-face{font-family:'Geist';src:url(data:font/woff2;base64,${b64('geist-sub.woff2')}) format('woff2');font-weight:100 900}
@font-face{font-family:'GeistMono';src:url(data:font/woff2;base64,${b64('geistmono-sub.woff2')}) format('woff2');font-weight:100 900}
.s{font-family:'Geist',ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif}
.m{font-family:'GeistMono',ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.06em}`;
const fmt = (n) => n.toLocaleString('en-US');
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
const svg = (w, h, title, body, css = '') =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img"><title>${esc(title)}</title><style>${FONTS}${css}</style>${body}</svg>`;
const frame = (T, w, h) => `<rect x="6.5" y="6.5" width="${w - 13}" height="${h - 13}" rx="22" fill="${T.bg}" stroke="${T.line}"/>`;
const label = (T, x, y, t) => `<text class="m" x="${x}" y="${y}" font-size="15" fill="${T.accentText}">${esc(t)}</text>`;
const updated = now.toISOString().slice(0, 10);

function graph(T) {
  const W = 840, H = 420, cell = 11, gap = 3, x0 = 46, y0 = 292; // big type: this tile shrinks to ~0.39x on a phone
  const levels = [T.empty, 'a', 'b', 'c', 'd'];
  const max = Math.max(1, ...thisYear.weeks.flatMap((w) => w.contributionDays.map((d) => d.contributionCount)));
  const fill = (n) => {
    if (n === 0) return `fill="${T.empty}"`;
    const q = n / max; const o = q > .66 ? 1 : q > .33 ? .75 : q > .1 ? .5 : .3;
    return `fill="${T.accent}" fill-opacity="${o}"`;
  };
  let cells = '';
  thisYear.weeks.forEach((w, wi) => w.contributionDays.forEach((d) => {
    const dow = new Date(d.date + 'T00:00:00Z').getUTCDay();
    cells += `<rect x="${x0 + wi * (cell + gap)}" y="${y0 + dow * (cell + gap)}" width="${cell}" height="${cell}" rx="2.5" ${fill(d.contributionCount)}/>`;
  }));
  // the rest of the year, still to come
  const last = thisYear.weeks[thisYear.weeks.length - 1].contributionDays.at(-1).date;
  let d = new Date(last + 'T00:00:00Z'); let wi = thisYear.weeks.length - 1;
  for (d.setUTCDate(d.getUTCDate() + 1); d.getUTCFullYear() === year; d.setUTCDate(d.getUTCDate() + 1)) {
    if (d.getUTCDay() === 0) wi++;
    cells += `<rect x="${x0 + wi * (cell + gap) + .5}" y="${y0 + d.getUTCDay() * (cell + gap) + .5}" width="${cell - 1}" height="${cell - 1}" rx="2.5" fill="none" stroke="${T.empty}"/>`;
  }
  const body = frame(T, W, H) +
    `<text class="m" x="44" y="76" font-size="28" fill="${T.accentText}">CONTRIBUTIONS · ${year}</text>` +
    `<text class="m" x="${W - 44}" y="76" font-size="22" text-anchor="end" fill="${T.muted}">UPDATED ${updated}</text>` +
    `<text class="s" x="38" y="192" font-size="116" font-weight="600" letter-spacing="-4" fill="${T.fg}">${fmt(thisYear.total)}</text>` +
    `<text class="s" x="44" y="244" font-size="34" fill="${T.muted}">contributions this year, private included</text>` +
    `<g class="hm">${cells}</g>`;
  const css = '.hm{animation:hmfade .9s cubic-bezier(.22,1,.36,1) both}@keyframes hmfade{from{opacity:0}to{opacity:1}}@media (prefers-reduced-motion:reduce){.hm{animation:none}}';
  return svg(W, H, `${fmt(thisYear.total)} contributions in ${year}`, body, css);
}
function streaks(T) {
  const W = 420, H = 340;
  const stat = (x, y, n, unit, sub, big) =>
    `<text class="s" x="${x}" y="${y}" font-size="${big ? 64 : 36}" font-weight="600" letter-spacing="${big ? -2 : -1}" fill="${T.fg}">${fmt(n)}<tspan font-size="${big ? 24 : 18}" font-weight="400" letter-spacing="0" fill="${T.muted}"> ${unit}</tspan></text>` +
    `<text class="s" x="${x + 2}" y="${y + (big ? 32 : 28)}" font-size="18" fill="${T.muted}">${sub}</text>`;
  const body = frame(T, W, H) + label(T, 40, 62, 'STREAKS') +
    stat(38, 140, current, current === 1 ? 'day' : 'days', 'current streak', true) +
    `<line x1="40" y1="198" x2="380" y2="198" stroke="${T.line}"/>` +
    stat(38, 258, longest, 'days', 'longest', false) + stat(220, 258, allTime, '', `total since ${new Date(base.createdAt).getUTCFullYear()}`, false);
  return svg(W, H, `Current streak ${current} days, longest ${longest} days, ${allTime} contributions in total`, body);
}
function counts(T) {
  const W = 420, H = 340;
  const cells = [['Commits', thisYear.commits], ['Pull requests', thisYear.prs], ['Issues', thisYear.issues], ['Reviews', thisYear.reviews]];
  let body = frame(T, W, H) + label(T, 40, 62, `IN ${year} · PUBLIC REPOS`);
  cells.forEach(([k, n], i) => {
    const x = 38 + (i % 2) * 180, y = 140 + Math.floor(i / 2) * 104;
    body += `<text class="s" x="${x}" y="${y}" font-size="48" font-weight="600" letter-spacing="-1.6" fill="${T.fg}">${fmt(n)}</text>` +
      `<text class="s" x="${x + 2}" y="${y + 28}" font-size="18" fill="${T.muted}">${k}</text>`;
  });
  if (thisYear.private > 0)
    body += `<text class="s" x="40" y="${H - 34}" font-size="17" fill="${T.muted}">+ ${fmt(thisYear.private)} more in private repos</text>`;
  return svg(W, H, cells.map(([k, n]) => `${n} ${k.toLowerCase()}`).join(', ') + ` in ${year}` + (thisYear.private ? `, plus ${thisYear.private} in private repos` : ''), body);
}
function languages(T) {
  const W = 420, H = 420;
  let body = frame(T, W, H) + label(T, 40, 62, 'TOP LANGUAGES');
  topLangs.forEach((l, i) => {
    const y = 116 + i * 58;
    body += `<text class="s" x="40" y="${y}" font-size="21" fill="${T.fg}">${esc(l.name)}</text>` +
      `<text class="m" x="380" y="${y}" font-size="15" text-anchor="end" fill="${T.muted}">${l.pct.toFixed(1)}%</text>` +
      `<rect x="40" y="${y + 12}" width="340" height="6" rx="3" fill="${T.empty}"/>` +
      `<rect x="40" y="${y + 12}" width="${Math.max(6, 340 * l.pct / topLangs[0].pct).toFixed(1)}" height="6" rx="3" fill="${T.accent}" fill-opacity="${(1 - i * .15).toFixed(2)}"/>`;
  });
  body += `<text class="s" x="40" y="${H - 34}" font-size="16" fill="${T.muted}">by code size, public repos I own</text>`;
  return svg(W, H, 'Top languages: ' + topLangs.map((l) => `${l.name} ${l.pct.toFixed(1)}%`).join(', '), body);
}

mkdirSync(OUT, { recursive: true });
for (const [name, T] of Object.entries(THEMES)) {
  writeFileSync(join(OUT, `activity-graph-${name}.svg`), graph(T));
  writeFileSync(join(OUT, `activity-streaks-${name}.svg`), streaks(T));
  writeFileSync(join(OUT, `activity-counts-${name}.svg`), counts(T));
  writeFileSync(join(OUT, `activity-languages-${name}.svg`), languages(T));
}
const summary = { updated, year, total: thisYear.total, commits: thisYear.commits, prs: thisYear.prs, issues: thisYear.issues, reviews: thisYear.reviews, private: thisYear.private, current, longest, allTime, topLangs };
writeFileSync(join(OUT, 'activity.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary));

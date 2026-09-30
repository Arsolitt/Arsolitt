#!/usr/bin/env node
/**
 * Generates the self-hosted profile cards used by README.md:
 *   assets/activity-graph.svg  - contributions for the last 31 days
 *   assets/top-langs.svg       - languages by bytes across owned, non-fork repos
 *   assets/stats.svg           - stars / commits / PRs / issues / reviews / followers
 *   assets/streak.svg          - current/longest streak and all-time contributions
 *
 * No dependencies (Node 22, global fetch). Any non-2xx HTTP response or GraphQL
 * `errors` payload throws, so the workflow fails loudly instead of committing
 * empty cards.
 *
 * Keepalive: GitHub disables `schedule` triggers in public repositories when
 * "no repository activity has occurred in 60 days". The docs never define what
 * activity means; from observation it is pushes to the repository (issue/PR
 * comments do not count). To keep the cron trigger alive, the stats card
 * renders an `updated <YYYY-MM-DD>` marker holding the UTC day of generation,
 * so every scheduled run (daily) has a real content change to commit even if
 * the underlying data did not move, and because the marker
 * only carries the date, the output stays deterministic: same UTC day + same
 * API data => identical bytes.
 *
 * If the trigger is ever disabled anyway (GitHub emails "will be disabled
 * soon"), re-enable it from Actions -> "Update profile assets" -> "Enable
 * workflow", or `gh workflow enable update-profile-assets.yml --repo
 * Arsolitt/Arsolitt`. Any later commit to the default branch also resets the
 * inactivity clock.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ASSETS_DIR = join(ROOT, 'assets');

const TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
const USERNAME = process.env.PROFILE_USERNAME || 'Arsolitt';
const API = 'https://api.github.com';

const TOKEN_MISSING =
  'Missing GH_TOKEN/GITHUB_TOKEN environment variable; refusing to render profile assets without API access.';

// ---------------------------------------------------------------- palette ---

const COLOR = {
  bg: '#0F0F1A',
  primary: '#818CF8',
  text: '#C084FC',
  accent: '#EC4899',
  secondary: '#A78BFA',
};

const FONT = "'Segoe UI', Ubuntu, Sans-Serif";

/** Shared style block for every card. */
const STYLE = `
    .bg { fill: ${COLOR.bg}; }
    .primary { fill: ${COLOR.primary}; font-family: ${FONT}; }
    .text { fill: ${COLOR.text}; font-family: ${FONT}; }
    .secondary { fill: ${COLOR.secondary}; font-family: ${FONT}; }
    .accent { fill: ${COLOR.accent}; font-family: ${FONT}; }
    .grid { stroke: ${COLOR.primary}; stroke-width: 1; }
    .axis-label { fill: ${COLOR.primary}; font-family: ${FONT}; font-size: 10px; }
    .line { fill: none; stroke: ${COLOR.accent}; stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
    .point { fill: ${COLOR.accent}; }
    .track { fill: ${COLOR.secondary}; fill-opacity: 0.14; }
  `;

// -------------------------------------------------------------- utilities ---

const escapeXml = (value) =>
  String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');

const parseList = (raw, fallback) => {
  const source = raw === undefined ? fallback : raw;
  const entries = Array.isArray(source) ? source : String(source).split(',');
  return entries.map((entry) => entry.trim()).filter((entry) => entry.length > 0);
};

const EXCLUDE_REPOS = new Set(parseList(process.env.EXCLUDE_REPOS, ['Redventures-Movie-Quotes']));
const HIDE_LANGS = new Set(
  parseList(process.env.HIDE_LANGS, ['html', 'php', 'blade', 'smarty', 'mustache']).map((lang) =>
    lang.toLowerCase(),
  ),
);

const formatNumber = (value) => value.toLocaleString('en-US');

const formatDay = (isoDate) => {
  const [, month, day] = isoDate.split('-');
  const name = new Date(`${isoDate}T00:00:00Z`).toLocaleDateString('en-US', {
    month: 'short',
    timeZone: 'UTC',
  });
  return `${name} ${Number(day)}`;
};

/** Round a maximum up to a readable axis top (1, 2, 5, 10 ... steps). */
const niceMax = (value) => {
  if (value <= 0) return 1;
  const steps = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000];
  const step = steps.find((candidate) => value / candidate <= 3) ?? 10000;
  return Math.ceil(value / step) * step;
};

// ------------------------------------------------------------------- HTTP ---

const request = async (url, init) => {
  const response = await fetch(url, {
    ...init,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `bearer ${TOKEN}`,
      'x-github-api-version': '2022-11-28',
      ...init?.headers,
    },
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`${init?.method ?? 'GET'} ${url} failed: HTTP ${response.status} ${body.slice(0, 300)}`);
  }
  return body.length === 0 ? {} : JSON.parse(body);
};

const graphql = async (query, variables) => {
  const payload = await request(`${API}/graphql`, {
    method: 'POST',
    body: JSON.stringify({ query, variables }),
  });
  if (Array.isArray(payload.errors) && payload.errors.length > 0) {
    throw new Error(`GraphQL request failed: ${JSON.stringify(payload.errors).slice(0, 500)}`);
  }
  return payload.data;
};

/** Run `worker` over `items`, keeping at most `limit` requests in flight. */
const mapLimited = async (items, limit, worker) => {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
};

// ------------------------------------------------------------------ APIs ----

const contributionsQuery = `
  query ProfileContributions($login: String!, $from: DateTime!, $to: DateTime!) {
    user(login: $login) {
      contributionsCollection(from: $from, to: $to) {
        totalCommitContributions
        totalPullRequestContributions
        totalIssueContributions
        totalPullRequestReviewContributions
        contributionCalendar {
          totalContributions
          weeks {
            contributionDays {
              date
              contributionCount
            }
          }
        }
      }
    }
  }
`;

const repositoriesQuery = `
  query ProfileRepositories($login: String!, $cursor: String) {
    user(login: $login) {
      repositories(
        ownerAffiliations: OWNER
        isFork: false
        first: 100
        after: $cursor
        orderBy: { field: NAME, direction: ASC }
      ) {
        totalCount
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          name
          stargazerCount
        }
      }
    }
  }
`;

const fetchContributionWindow = async (from, to) => {
  const data = await graphql(contributionsQuery, {
    login: USERNAME,
    from: from.toISOString(),
    to: to.toISOString(),
  });
  const collection = data?.user?.contributionsCollection;
  if (!collection) throw new Error(`No contributionsCollection returned for user ${USERNAME}`);
  const days = (collection.contributionCalendar?.weeks ?? []).flatMap((week) => week.contributionDays ?? []);
  return { collection, days };
};

const fetchOwnedRepos = async () => {
  const repos = [];
  let cursor = null;
  for (;;) {
    const data = await graphql(repositoriesQuery, { login: USERNAME, cursor });
    const connection = data?.user?.repositories;
    if (!connection) throw new Error(`No repositories returned for user ${USERNAME}`);
    repos.push(...(connection.nodes ?? []));
    if (!connection.pageInfo?.hasNextPage) break;
    cursor = connection.pageInfo.endCursor;
  }
  return repos;
};

const fetchFollowers = async () => {
  const data = await graphql(
    `query ProfileFollowers($login: String!) { user(login: $login) { followers { totalCount } } }`,
    { login: USERNAME },
  );
  const total = data?.user?.followers?.totalCount;
  if (typeof total !== 'number') throw new Error(`No follower count returned for user ${USERNAME}`);
  return total;
};

const fetchAccountCreatedAt = async () => {
  const data = await graphql(
    `query ProfileAccount($login: String!) { user(login: $login) { createdAt } }`,
    { login: USERNAME },
  );
  const createdAt = data?.user?.createdAt;
  if (typeof createdAt !== 'string') throw new Error(`No account creation date returned for user ${USERNAME}`);
  return createdAt;
};

/**
 * Walks the whole account history, one window at a time, because
 * `contributionsCollection` never spans more than a year. Windows tile the
 * timeline day by day (each starts at 00:00:00 UTC of the day after the
 * previous one ended), so the days they return concatenate into one unbroken
 * series; the per-window totals are kept for the run log. Every window is a
 * plain `fetchContributionWindow` call, so an API failure still throws.
 */
const fetchContributionHistory = async (from, to) => {
  const windows = [];
  const byDate = new Map();
  let cursor = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));

  for (;;) {
    const end = new Date(cursor);
    end.setUTCFullYear(end.getUTCFullYear() + 1);
    end.setUTCDate(end.getUTCDate() - 1);
    end.setUTCHours(23, 59, 59, 0);
    const windowTo = end < to ? end : to;

    const { collection, days } = await fetchContributionWindow(cursor, windowTo);
    for (const day of days) byDate.set(day.date, day.contributionCount);
    windows.push({
      from: cursor.toISOString(),
      to: windowTo.toISOString(),
      days: days.length,
      total: collection.contributionCalendar.totalContributions,
    });

    if (windowTo.getTime() >= to.getTime()) break;
    cursor = new Date(windowTo);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    cursor.setUTCHours(0, 0, 0, 0);
  }

  const days = [...byDate.entries()]
    .sort(([left], [right]) => (left < right ? -1 : 1))
    .map(([date, contributionCount]) => ({ date, contributionCount }));
  return { days, windows };
};

// --------------------------------------------------------------- rendering --

// One corner radius shared by every card in the set, so the four cards read as
// a single visual family on the profile; 4.5 is the value chosen for that look.
const CARD_RADIUS = 4.5;

const svgDocument = ({
  width,
  height,
  title,
  description = 'Self-hosted card rendered by scripts/generate-profile-assets.mjs',
  defs,
  body,
}) => `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeXml(title)}">
  <title>${escapeXml(title)}</title>
  <desc>${escapeXml(description)}</desc>
  <defs>
    <style>${STYLE}</style>
${defs}
  </defs>
  <rect class="bg" x="0" y="0" width="${width}" height="${height}" rx="${CARD_RADIUS}"/>
${body}
</svg>
`;

const renderActivityGraph = (days) => {
  // 876 is the shared right edge of the card set: the pair row is 436 + 436 plus
  // the space between two inline images (~4px). Keeping the full-width cards at
  // the same 876 makes every right edge on the profile line up.
  const W = 876;
  const H = 230;
  const pad = { left: 56, right: 20, top: 38, bottom: 30 };
  const plot = { x: pad.left, y: pad.top, w: W - pad.left - pad.right, h: H - pad.top - pad.bottom };
  const baseline = plot.y + plot.h;

  const counts = days.map((day) => day.contributionCount);
  const total = counts.reduce((sum, count) => sum + count, 0);
  const peak = days.reduce((best, day) => (day.contributionCount > best.contributionCount ? day : best), days[0]);
  const max = niceMax(Math.max(...counts, 0));
  const xFor = (index) => plot.x + (days.length === 1 ? plot.w / 2 : (index * plot.w) / (days.length - 1));
  const yFor = (count) => baseline - (count / max) * plot.h;

  const gridValues = [max, max / 2, 0].filter(
    (value, index, all) => Number.isInteger(value) && all.indexOf(value) === index,
  );
  const grid = gridValues
    .map(
      (value) => `  <line class="grid" x1="${plot.x}" y1="${yFor(value).toFixed(2)}" x2="${(
        plot.x + plot.w
      ).toFixed(2)}" y2="${yFor(value).toFixed(2)}" stroke-opacity="${value === 0 ? 0.45 : 0.18}"/>
  <text class="axis-label" x="${plot.x - 12}" y="${(yFor(value) + 3.5).toFixed(2)}" text-anchor="end" fill-opacity="0.85">${escapeXml(
    formatNumber(value),
  )}</text>`,
    )
    .join('\n');

  const points = days.map((day, index) => `${xFor(index).toFixed(2)},${yFor(day.contributionCount).toFixed(2)}`);
  const area = `M ${xFor(0).toFixed(2)},${baseline.toFixed(2)} L ${points.join(' L ')} L ${xFor(
    days.length - 1,
  ).toFixed(2)},${baseline.toFixed(2)} Z`;

  const markers = days
    .map(
      (day, index) =>
        `  <circle class="point" cx="${xFor(index).toFixed(2)}" cy="${yFor(day.contributionCount).toFixed(2)}" r="${
          day.contributionCount > 0 ? 2.6 : 1.6
        }" fill-opacity="${day.contributionCount > 0 ? 1 : 0.4}"/>`,
    )
    .join('\n');

  const step = 5;
  const xLabels = days
    .map((day, index) => ({ day, index }))
    .filter(({ index }) => index % step === 0 || index === days.length - 1)
    .map(({ day, index }) => {
      const anchor = index === 0 ? 'start' : index === days.length - 1 ? 'end' : 'middle';
      return `  <text class="text" x="${xFor(index).toFixed(2)}" y="${baseline + 20}" font-size="10" text-anchor="${anchor}" fill-opacity="0.85">${escapeXml(
        formatDay(day.date),
      )}</text>`;
    })
    .join('\n');

  const first = days[0];
  const last = days[days.length - 1];
  const heading = `${formatNumber(total)} contributions \u00b7 ${escapeXml(formatDay(first.date))} \u2013 ${escapeXml(
    formatDay(last.date),
  )}`;
  const peakLabel = `peak ${formatNumber(peak.contributionCount)} on ${escapeXml(formatDay(peak.date))}`;

  return svgDocument({
    width: W,
    height: H,
    title: `Contribution activity for the last ${days.length} days`,
    defs: `    <linearGradient id="activity-area" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${COLOR.secondary}" stop-opacity="0.55"/>
      <stop offset="100%" stop-color="${COLOR.secondary}" stop-opacity="0.04"/>
    </linearGradient>`,
    body: [
      `  <text class="primary" x="${pad.left - 36}" y="24" font-size="15" font-weight="600">${heading}</text>`,
      `  <text class="text" x="${W - pad.right + 8}" y="24" font-size="11" text-anchor="end" fill-opacity="0.9">${peakLabel}</text>`,
      grid,
      `  <path d="${area}" fill="url(#activity-area)"/>`,
      `  <polyline class="line" points="${points.join(' ')}"/>`,
      markers,
      xLabels,
    ].join('\n'),
  });
};

const renderTopLanguages = (languages) => {
  // 436 wide so that, next to the 436px stats card and the ~4px space between
  // two inline images in a README paragraph, the pair totals 876 and lines up
  // with the full-width cards, which use the same 876; the 8 rows stay readable
  // and the height/row count are unchanged.
  const W = 436;
  const pad = { left: 22, right: 22, top: 12, bottom: 12 };
  const pitch = 22;
  const bar = { height: 6, offset: 13 };
  const H = pad.top + languages.length * pitch + pad.bottom;
  const trackWidth = W - pad.left - pad.right;
  const barWidth = (percentage) => Math.max(6, Math.min(trackWidth, (percentage / 100) * trackWidth));
  const rampEnd = pad.left + barWidth(languages[0].percentage);

  const rows = languages
    .map((language, index) => {
      const top = pad.top + index * pitch;
      const width = barWidth(language.percentage);
      return [
        `  <text class="text" x="${pad.left}" y="${(top + 9).toFixed(2)}" font-size="12">${escapeXml(language.name)}</text>`,
        `  <text class="primary" x="${W - pad.right}" y="${(top + 9).toFixed(2)}" font-size="11" text-anchor="end" fill-opacity="0.9">${escapeXml(
          `${language.percentage.toFixed(1)}%`,
        )}</text>`,
        `  <rect class="track" x="${pad.left}" y="${(top + bar.offset).toFixed(2)}" width="${trackWidth}" height="${bar.height}" rx="${(
          bar.height / 2
        ).toFixed(2)}"/>`,
        `  <rect x="${pad.left}" y="${(top + bar.offset).toFixed(2)}" width="${width.toFixed(2)}" height="${bar.height}" rx="${(
          bar.height / 2
        ).toFixed(2)}" fill="url(#language-bar)"/>`,
      ].join('\n');
    })
    .join('\n');

  return svgDocument({
    width: W,
    height: H,
    title: 'Most used languages by bytes across owned repositories',
    description:
      'Shares of the top 8 languages by bytes across owned, non-fork repositories; languages below the top 8 are omitted.',
    defs: `    <linearGradient id="language-bar" gradientUnits="userSpaceOnUse" x1="${pad.left}" y1="0" x2="${rampEnd.toFixed(
      2,
    )}" y2="0">
      <stop offset="0%" stop-color="${COLOR.primary}"/>
      <stop offset="100%" stop-color="${COLOR.accent}"/>
    </linearGradient>`,
    body: rows,
  });
};

const renderStats = (stats, asOf) => {
  // 436 wide, the same as the top-langs card it sits next to: together with the
  // ~4px inline-image gap the pair totals 876 and shares one right edge with the
  // full-width cards below.
  const W = 436;
  const H = 200;
  const pad = { left: 26, right: 26, top: 26 };
  const pitch = 25;
  const rows = stats
    .map((stat, index) => {
      const top = pad.top + index * pitch;
      const baseline = top + 16;
      const separator =
        index === stats.length - 1
          ? ''
          : `\n  <line class="grid" x1="${pad.left}" y1="${(top + pitch - 4).toFixed(2)}" x2="${W - pad.right}" y2="${(
              top +
              pitch -
              4
            ).toFixed(2)}" stroke-opacity="0.12"/>`;
      return [
        `  <text class="text" x="${pad.left}" y="${baseline.toFixed(2)}" font-size="13">${escapeXml(stat.label)}</text>`,
        `  <text class="primary" x="${W - pad.right}" y="${baseline.toFixed(2)}" font-size="14" font-weight="600" text-anchor="end">${escapeXml(
          formatNumber(stat.value),
        )}</text>${separator}`,
      ].join('\n');
    })
    .join('\n');

  // The `updated <date>` marker is the keepalive hook described in the file
  // header: it makes every scheduled run produce a real content change while
  // staying deterministic for a given UTC day.
  const updated = `  <text class="text" x="${W - pad.right}" y="189" font-size="10" text-anchor="end" fill-opacity="0.6">updated ${escapeXml(
    asOf,
  )}</text>`;

  return svgDocument({
    width: W,
    height: H,
    title: 'GitHub statistics summary',
    description: `Stars, commits, pull requests, issues, reviews and followers as of ${asOf} (UTC).`,
    defs: '',
    body: `${rows}\n${updated}`,
  });
};

// ---------------------------------------------------------------- streaks ---

/**
 * Streaks are unbroken runs of consecutive UTC calendar days with at least one
 * contribution. The current streak is the run that ends on the most recent
 * contributing day (the series is walked newest-last, so that is the trailing
 * run) and it is live only while it includes today or yesterday. If the latest
 * contribution is older than yesterday the run is stale: the current streak is
 * 0 and the card renders `no active streak` instead of a date range. The
 * longest streak is the longest run anywhere in the series, earliest one on a
 * tie; `total` is the sum of the whole series.
 */
const computeStreaks = (days) => {
  const runs = [];
  let start = -1;
  const close = (end) => {
    runs.push({ from: days[start].date, to: days[end].date, days: end - start + 1, endIndex: end });
    start = -1;
  };
  days.forEach((day, index) => {
    if (day.contributionCount > 0) {
      if (start === -1) start = index;
    } else if (start !== -1) {
      close(index - 1);
    }
  });
  if (start !== -1) close(days.length - 1);

  const latest = runs.at(-1);
  return {
    current: latest && days.length - 1 - latest.endIndex <= 1 ? latest : null,
    longest: runs.reduce((best, run) => (best === null || run.days > best.days ? run : best), null),
    total: days.reduce((sum, day) => sum + day.contributionCount, 0),
  };
};

const formatRun = (run) => (run ? `${run.days} days (${run.from} to ${run.to})` : '0 days (no live run)');

const renderStreak = (days, streaks) => {
  // Same 876 as the rest of the card set so every right edge lines up.
  const W = 876;
  const H = 160;
  const pad = { left: 24, right: 24 };
  const { current, longest, total } = streaks;
  const first = days[0];
  const last = days[days.length - 1];
  const column = (W - pad.left - pad.right) / 3;
  const center = (index) => pad.left + column * (index + 0.5);
  const dayWithYear = (isoDate) => `${formatDay(isoDate)}, ${isoDate.slice(0, 4)}`;

  const panels = [
    {
      label: 'Current streak',
      value: current ? String(current.days) : '0',
      unit: 'days',
      note: current ? `${formatDay(current.from)} \u2013 ${formatDay(current.to)}` : 'no active streak',
      className: 'accent',
    },
    {
      label: 'Longest streak',
      value: longest ? String(longest.days) : '0',
      unit: 'days',
      note: longest ? `${formatDay(longest.from)} \u2013 ${formatDay(longest.to)}` : 'no contributions',
      className: 'text',
    },
    {
      label: 'Total contributions',
      value: formatNumber(total),
      unit: '',
      note: `${dayWithYear(first.date)} \u2013 ${dayWithYear(last.date)}`,
      className: 'text',
    },
  ];

  const separators = [1, 2]
    .map((index) => {
      const x = (pad.left + column * index).toFixed(2);
      return `  <line class="grid" x1="${x}" y1="34" x2="${x}" y2="${H - 34}" stroke-opacity="0.12"/>`;
    })
    .join('\n');

  const rows = panels
    .map((panel, index) => {
      const cx = center(index).toFixed(2);
      const unit = panel.unit
        ? `<tspan class="secondary" font-size="14" fill-opacity="0.8"> ${escapeXml(panel.unit)}</tspan>`
        : '';
      return [
        `  <text class="secondary" x="${cx}" y="46" font-size="12" text-anchor="middle" fill-opacity="0.85">${escapeXml(
          panel.label,
        )}</text>`,
        `  <text class="${panel.className}" x="${cx}" y="94" font-size="34" font-weight="600" text-anchor="middle">${escapeXml(
          panel.value,
        )}${unit}</text>`,
        `  <text class="text" x="${cx}" y="120" font-size="11" text-anchor="middle" fill-opacity="0.65">${escapeXml(
          panel.note,
        )}</text>`,
      ].join('\n');
    })
    .join('\n');

  return svgDocument({
    width: W,
    height: H,
    title: 'Contribution streak over the account history',
    description: `Current and longest contribution streak plus all-time contributions from account creation to ${last.date} (UTC); a streak is an unbroken run of consecutive UTC days with at least one contribution, and the current streak is 0 once the latest contribution is older than yesterday.`,
    defs: '',
    body: `${separators}\n${rows}`,
  });
};

// ------------------------------------------------------------------ main ----

const main = async () => {
  if (!TOKEN) throw new Error(TOKEN_MISSING);

  const now = new Date();
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 23, 59, 59));
  // UTC day of generation; backs the `updated <date>` keepalive marker, so a
  // rerun on the same UTC day with the same API data renders identical bytes.
  const asOf = to.toISOString().slice(0, 10);
  const from = new Date(to);
  from.setUTCDate(from.getUTCDate() - 30);
  from.setUTCHours(0, 0, 0, 0);

  const yearFrom = new Date(to);
  yearFrom.setUTCFullYear(yearFrom.getUTCFullYear() - 1);
  yearFrom.setUTCHours(0, 0, 0, 0);

  const [window, year, repos, followers, createdAt] = await Promise.all([
    fetchContributionWindow(from, to),
    fetchContributionWindow(yearFrom, to),
    fetchOwnedRepos(),
    fetchFollowers(),
    fetchAccountCreatedAt(),
  ]);

  const days = window.days;
  if (days.length === 0) throw new Error('Contribution calendar returned no days');
  if (year.days.length === 0) throw new Error('Contribution calendar returned no days for the trailing year');

  // The streak card covers the account's whole history, not just the trailing
  // year: contributionsCollection caps at one year per query, so this walks the
  // history window by window from the account creation date.
  const history = await fetchContributionHistory(new Date(createdAt), to);
  if (history.days.length === 0) throw new Error('Contribution calendar returned no days for the account history');
  const streaks = computeStreaks(history.days);

  const included = repos.filter((repo) => !EXCLUDE_REPOS.has(repo.name));
  const languageResponses = await mapLimited(included, 8, async (repo) => ({
    repo: repo.name,
    languages: await request(`${API}/repos/${USERNAME}/${encodeURIComponent(repo.name)}/languages`),
  }));

  const bytesByLanguage = new Map();
  for (const { languages } of languageResponses) {
    for (const [name, bytes] of Object.entries(languages)) {
      if (HIDE_LANGS.has(name.toLowerCase())) continue;
      bytesByLanguage.set(name, (bytesByLanguage.get(name) ?? 0) + bytes);
    }
  }

  const totalBytes = [...bytesByLanguage.values()].reduce((sum, bytes) => sum + bytes, 0);
  if (totalBytes === 0) throw new Error('No language bytes found across owned repositories');

  const ranked = [...bytesByLanguage.entries()]
    .map(([name, bytes]) => ({ name, bytes }))
    .sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name))
    .slice(0, 8);
  const shownBytes = ranked.reduce((sum, language) => sum + language.bytes, 0);
  // Shares are computed against the languages shown so the card reads as a
  // complete distribution summing to 100.0; the languages ranked below the cut
  // account for the remaining `totalBytes - shownBytes` bytes.
  const languages = ranked.map((language) => ({
    ...language,
    percentage: (language.bytes / shownBytes) * 100,
  }));

  const stars = included.reduce((sum, repo) => sum + repo.stargazerCount, 0);
  const stats = [
    { label: 'Total stars', value: stars },
    { label: 'Commits (last year)', value: year.collection.totalCommitContributions },
    { label: 'Pull requests', value: year.collection.totalPullRequestContributions },
    { label: 'Issues', value: year.collection.totalIssueContributions },
    { label: 'Code reviews', value: year.collection.totalPullRequestReviewContributions },
    { label: 'Followers', value: followers },
  ];

  const cards = [
    ['activity-graph.svg', renderActivityGraph(days)],
    ['top-langs.svg', renderTopLanguages(languages)],
    ['stats.svg', renderStats(stats, asOf)],
    ['streak.svg', renderStreak(history.days, streaks)],
  ];

  await mkdir(ASSETS_DIR, { recursive: true });
  for (const [file, content] of cards) {
    const target = join(ASSETS_DIR, file);
    await writeFile(target, content.endsWith('\n') ? content : `${content}\n`, 'utf8');
    process.stdout.write(`wrote ${target} (${Buffer.byteLength(content, 'utf8')} bytes)\n`);
  }

  process.stdout.write(
    `activity: ${window.collection.contributionCalendar.totalContributions} contributions over ${days.length} days; ` +
      `repos: ${included.length}/${repos.length}; languages: ${languages
        .map((language) => `${language.name} ${language.percentage.toFixed(1)}%`)
        .join(', ')} (top ${languages.length} cover ${((shownBytes / totalBytes) * 100).toFixed(2)}% of ${formatNumber(
        totalBytes,
      )} analysed bytes); history: ${history.days.length} days over ${history.windows.length} windows ` +
      `(${history.windows.map((w) => `${w.from.slice(0, 10)}..${w.to.slice(0, 10)}=${w.total}`).join(' ')}); ` +
      `streak: current ${formatRun(streaks.current)}, longest ${formatRun(
        streaks.longest,
      )}, all-time total ${streaks.total}; updated ${asOf}\n`,
  );
};

main().catch((error) => {
  process.stderr.write(`generate-profile-assets: ${error.message}\n`);
  process.exitCode = 1;
});

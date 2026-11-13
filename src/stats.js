// History and activity: what the Action records every day, and the numbers
// derived from it (calendar, streaks, milestones). No DOM, no network.

import { linesJson } from './json.js';
import { aggregate, groupByProject, parseTranslationUrl } from './core.js';

const DAY = 86400000;

/** UTC calendar day of a timestamp, "2026-11-12". */
export const dayKey = (time) => new Date(time).toISOString().slice(0, 10);
const addDays = (key, n) => dayKey(new Date(`${key}T00:00:00Z`).getTime() + n * DAY);

/* ---------- activity: what the configured users did, per day ---------- */

export const emptyActivity = () => ({
  version: 1,
  updatedAt: null,
  sources: {}, // instance id -> fingerprint the numbers were collected for
  days: {}, // day -> { "<instance>:<project>": changes }
  users: {}, // instance id -> username -> day -> changes
  recent: [], // newest first
});

const RECENT = 60;

/** Add one user's changes (as returned by Weblate's /api/changes/) to the record. */
export function recordChanges(activity, instanceId, username, changes) {
  const byUser = ((activity.users[instanceId] ||= {})[username] ||= {});
  for (const change of changes) {
    const parsed = parseTranslationUrl(change.translation);
    if (!parsed || !change.timestamp) continue;
    const day = dayKey(change.timestamp);
    const project = `${instanceId}:${parsed.project}`;
    const bucket = (activity.days[day] ||= {});
    bucket[project] = (bucket[project] || 0) + 1;
    byUser[day] = (byUser[day] || 0) + 1;
    activity.recent.push({
      at: new Date(change.timestamp).toISOString(),
      user: username,
      project,
      component: parsed.component,
      action: change.action_name || '',
    });
  }
  activity.recent.sort((a, b) => b.at.localeCompare(a.at));
  activity.recent.length = Math.min(activity.recent.length, RECENT);
  return activity;
}

/** Forget what was collected for an instance, e.g. after its usernames changed. */
export function dropInstance(activity, instanceId) {
  const prefix = `${instanceId}:`;
  for (const [day, bucket] of Object.entries(activity.days)) {
    for (const key of Object.keys(bucket)) if (key.startsWith(prefix)) delete bucket[key];
    if (!Object.keys(bucket).length) delete activity.days[day];
  }
  delete activity.users[instanceId];
  delete activity.sources[instanceId];
  activity.recent = activity.recent.filter((r) => !r.project.startsWith(prefix));
}

/** day -> number of changes, optionally for one project key. */
export function dailyCounts(activity, project) {
  const out = {};
  for (const [day, bucket] of Object.entries(activity?.days || {})) {
    const n = project ? bucket[project] || 0 : Object.values(bucket).reduce((sum, v) => sum + v, 0);
    if (n) out[day] = n;
  }
  return out;
}

export const totalChanges = (counts) => Object.values(counts).reduce((sum, n) => sum + n, 0);

/** Changes per username, across instances, optionally since a day. */
export function leaderboard(activity, { since } = {}) {
  const totals = new Map();
  for (const users of Object.values(activity?.users || {})) {
    for (const [name, days] of Object.entries(users)) {
      const row = totals.get(name) || { name, changes: 0, days: 0, last: null };
      for (const [day, n] of Object.entries(days)) {
        if (since && day < since) continue;
        row.changes += n;
        row.days += 1;
        if (!row.last || day > row.last) row.last = day;
      }
      totals.set(name, row);
    }
  }
  return [...totals.values()]
    .filter((r) => r.changes > 0)
    .sort((a, b) => b.changes - a.changes || a.name.localeCompare(b.name));
}

/**
 * Current and longest run of consecutive active days. The current streak
 * still counts when today has no activity yet but yesterday had.
 */
export function streaks(counts, today = dayKey(Date.now())) {
  const days = Object.keys(counts)
    .filter((d) => counts[d] > 0)
    .sort();
  let longest = 0;
  let longestEnd = null;
  let run = 0;
  let prev = null;
  for (const day of days) {
    run = prev && addDays(prev, 1) === day ? run + 1 : 1;
    if (run > longest) {
      longest = run;
      longestEnd = day;
    }
    prev = day;
  }
  let current = 0;
  let cursor = counts[today] > 0 ? today : addDays(today, -1);
  while (counts[cursor] > 0) {
    current += 1;
    cursor = addDays(cursor, -1);
  }
  return {
    current,
    longest,
    longestStart: longestEnd ? addDays(longestEnd, -(longest - 1)) : null,
    longestEnd,
    activeDays: days.length,
  };
}

/**
 * Calendar for a heatmap: columns of weeks (Monday first), each cell
 * { day, count, level 0-4 } or null outside the range.
 */
export function calendar(counts, { end = dayKey(Date.now()), weeks = 53 } = {}) {
  const endDate = new Date(`${end}T00:00:00Z`);
  const weekday = (endDate.getUTCDay() + 6) % 7; // Monday = 0
  const start = addDays(end, -(weekday + (weeks - 1) * 7));
  const values = [];
  for (let d = start; d <= end; d = addDays(d, 1)) values.push(counts[d] || 0);
  const max = Math.max(0, ...values);
  // Quartiles of the busiest day; a single change is always visible.
  const level = (n = 0) => (n <= 0 ? 0 : Math.max(1, Math.min(4, Math.ceil((n / max) * 4))));
  const columns = [];
  let day = start;
  for (let w = 0; w < weeks; w += 1) {
    const column = [];
    for (let i = 0; i < 7; i += 1) {
      column.push(day <= end ? { day, count: counts[day] || 0, level: level(counts[day]) } : null);
      day = addDays(day, 1);
    }
    columns.push(column);
  }
  return { columns, start, end, max, total: values.reduce((a, b) => a + b, 0) };
}

/** "2026-11" -> changes, for the busiest-month statistic. */
export function monthlyCounts(counts) {
  const out = {};
  for (const [day, n] of Object.entries(counts)) {
    out[day.slice(0, 7)] = (out[day.slice(0, 7)] || 0) + n;
  }
  return out;
}

/* ---------- history: one point per day of where every project stood ---------- */

/** Today's point: overall numbers plus [total, translated] per project. */
export function historyPoint(entries) {
  const s = aggregate(entries);
  const projects = {};
  for (const g of groupByProject(entries)) projects[g.key] = [g.stats.total, g.stats.translated];
  return { o: [s.total, s.translated, s.fuzzy, s.components, s.complete], p: projects };
}

/** A history file as JSON with one day per line: small, and easy to diff. */
export const stringifyHistory = (history) => linesJson(history, 'days');

/** Merge yearly history files into one sorted list of { day, o, p }. */
export function historyDays(years) {
  const days = {};
  for (const year of years) Object.assign(days, year?.days || {});
  return Object.keys(days)
    .sort()
    .map((day) => ({ day, ...days[day] }));
}

const percentOf = ([total, translated]) =>
  total > 0 ? Math.floor((translated / total) * 1000) / 10 : 100;

/** Completion over time, overall or for one project key. */
export function series(points, project) {
  return points
    .map((pt) => {
      const pair = project ? pt.p?.[project] : pt.o;
      return pair
        ? { day: pt.day, percent: percentOf(pair), translated: pair[1], total: pair[0] }
        : null;
    })
    .filter(Boolean);
}

/**
 * Notable events, newest first:
 *  - a project reaching 100% (from history)
 *  - "hit 100% on N projects this month" (from history)
 *  - round numbers of contributions, and streaks (from activity)
 */
export function milestones(points, activity, { today = dayKey(Date.now()), names = {} } = {}) {
  const out = [];
  const done = (pair) => pair && pair[0] > 0 && pair[1] >= pair[0];
  const completedIn = {};
  for (let i = 1; i < points.length; i += 1) {
    for (const [key, pair] of Object.entries(points[i].p || {})) {
      const before = points[i - 1].p?.[key];
      if (done(pair) && before && !done(before)) {
        out.push({ kind: 'complete', day: points[i].day, project: key, name: names[key] || key });
        (completedIn[points[i].day.slice(0, 7)] ||= new Set()).add(key);
      }
    }
  }
  for (const [month, keys] of Object.entries(completedIn)) {
    if (keys.size >= 2) {
      const last = out
        .filter((m) => m.kind === 'complete' && m.day.startsWith(month))
        .map((m) => m.day)
        .sort()
        .pop();
      out.push({ kind: 'monthComplete', day: last, month, count: keys.size });
    }
  }
  const counts = dailyCounts(activity);
  let sum = 0;
  const steps = [100, 500, 1000, 2500, 5000, 10000, 25000, 50000, 100000];
  for (const day of Object.keys(counts).sort()) {
    const before = sum;
    sum += counts[day];
    for (const step of steps) {
      if (before < step && sum >= step) out.push({ kind: 'changes', day, count: step });
    }
  }
  const s = streaks(counts, today);
  for (const length of [7, 30, 100, 365]) {
    if (s.longest >= length) {
      // The day the longest streak passed this length.
      out.push({ kind: 'streak', day: addDays(s.longestStart, length - 1), count: length });
    }
  }
  return out.sort((a, b) => b.day.localeCompare(a.day) || a.kind.localeCompare(b.kind));
}

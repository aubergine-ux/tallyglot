// Achievements: a short list of milestones, each either earned or in progress.
// Computed from the same data as everything else; nothing is stored.

import { groupByProject, isComplete } from './core.js';
import { PLATFORM_META } from './presets.js';
import { dailyCounts, streaks, totalChanges } from './stats.js';

/**
 * @returns {{id: string, mark: string, kind: string, goal: number, value: number,
 *            earned: boolean, platform?: string}[]}
 * `mark` is the two or three characters shown on the medal; `kind` selects the
 * wording (achievements.<kind> in the locale files).
 */
export function achievements({ entries, activity, today }) {
  const counts = dailyCounts(activity);
  const changes = totalChanges(counts);
  const { longest } = streaks(counts, today);
  const groups = groupByProject(entries);
  const complete = groups.filter((g) => g.entries.length && g.entries.every(isComplete));
  const list = [];
  const add = (id, mark, kind, value, goal, extra = {}) =>
    list.push({
      id,
      mark,
      kind,
      goal,
      value: Math.min(value, goal),
      earned: value >= goal,
      ...extra,
    });

  add('changes-1k', '1K', 'changes', changes, 1000);
  add('changes-10k', '10K', 'changes', changes, 10000);
  add('complete-1', '100', 'complete', complete.length, 1);
  add('complete-10', '×10', 'complete', complete.length, 10);
  add('streak-7', '7d', 'streak', longest, 7);
  add('streak-30', '30d', 'streak', longest, 30);
  add('streak-100', '100d', 'streak', longest, 100);
  // The first fully translated project on each platform in use.
  const platforms = [...new Set(entries.map((e) => e.platform || 'weblate'))];
  for (const platform of platforms) {
    const done = complete.some((g) => (g.entries[0].platform || 'weblate') === platform);
    add(`platform-${platform}`, PLATFORM_META[platform].name[0], 'platform', done ? 1 : 0, 1, {
      platform: PLATFORM_META[platform].name,
    });
  }
  return list;
}

/** Earned achievements, the hardest of each kind first: what the card shows. */
export function earnedMarks(list, max = 5) {
  const best = new Map();
  for (const a of list.filter((x) => x.earned)) {
    const key = a.kind === 'platform' ? a.id : a.kind;
    if (!best.has(key) || a.goal >= best.get(key).goal) best.set(key, a);
  }
  return [...best.values()].slice(0, max);
}

// Demo mode only: the sample files in demo/ carry fixed dates. Move them
// forward so the newest day is today, as the dashboard does for the snapshot.

const DAY = 86400000;
const DEMO_TODAY = Date.parse('2026-01-15T00:00:00Z');

const offsetDays = () => Math.floor((Date.now() - DEMO_TODAY) / DAY);
const moveDay = (day, n) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const moveStamp = (stamp, n) =>
  stamp ? new Date(Date.parse(stamp) + n * DAY).toISOString() : stamp;
const moveKeys = (obj, n) =>
  Object.fromEntries(Object.entries(obj || {}).map(([day, v]) => [moveDay(day, n), v]));

export function shiftDemo(name, json) {
  const n = offsetDays();
  if (name === 'activity') {
    return {
      ...json,
      updatedAt: moveStamp(json.updatedAt, n),
      days: moveKeys(json.days, n),
      users: Object.fromEntries(
        Object.entries(json.users || {}).map(([inst, users]) => [
          inst,
          Object.fromEntries(Object.entries(users).map(([u, days]) => [u, moveKeys(days, n)])),
        ]),
      ),
      recent: (json.recent || []).map((r) => ({ ...r, at: moveStamp(r.at, n) })),
    };
  }
  if (name.startsWith('history/') && json.days) return { ...json, days: moveKeys(json.days, n) };
  if (name === 'alerts') {
    return { ...json, events: (json.events || []).map((e) => ({ ...e, at: moveStamp(e.at, n) })) };
  }
  if (name === 'findwork' || name === 'glossary') {
    return { ...json, updatedAt: moveStamp(json.updatedAt, n) };
  }
  return json;
}

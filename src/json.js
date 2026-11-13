// JSON for files that are committed every day: the entries of one large map
// go one per line, so the file stays small and its diffs stay readable.

export function linesJson(object, key) {
  const { [key]: map = {}, ...head } = object;
  const lines = Object.keys(map)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${JSON.stringify(map[k])}`);
  const start = JSON.stringify(head).slice(0, -1);
  return `${start}${start.length > 1 ? ',' : ''}${JSON.stringify(key)}:{\n${lines.join(',\n')}\n}}\n`;
}

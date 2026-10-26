// Which destination column each source column goes to, as TablePlus matches
// them: by name (ignoring case), by position, or by name and then by position
// for the columns no name matched.
export type MatchStrategy = "nameOrder" | "name" | "order";

export function matchColumns(sources: string[], targets: string[], strategy: MatchStrategy): (string | null)[] {
  const result: (string | null)[] = sources.map(() => null);
  const taken = new Set<string>();
  if (strategy !== "order") {
    const byName = new Map<string, string>();
    for (const target of targets) {
      const key = target.toLowerCase();
      if (!byName.has(key)) {
        byName.set(key, target);
      }
    }
    sources.forEach((source, index) => {
      const target = byName.get(source.toLowerCase());
      if (target !== undefined && !taken.has(target)) {
        result[index] = target;
        taken.add(target);
      }
    });
  }
  if (strategy !== "name") {
    sources.forEach((_, index) => {
      const target = targets[index];
      if (result[index] === null && target !== undefined && !taken.has(target)) {
        result[index] = target;
        taken.add(target);
      }
    });
  }
  return result;
}

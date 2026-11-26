// What changed between two crawls of the same site: issues that are new,
// fixed, worse or better. Computed on read from the stored issue counts.

export type ChangeKind = "new" | "fixed" | "worse" | "better" | "same";

export interface IssueCount { key: string; count: number }

export interface IssueChange {
  key: string;
  kind: ChangeKind;
  count: number;
  previous: number | null;
}

/** A count change counts as worse/better when it moves by at least 10% or at least 5 pages. */
export function changed(prev: number, cur: number): boolean {
  const d = Math.abs(cur - prev);
  if (d === 0) return false;
  return d >= 5 || d >= prev * 0.1;
}

/** Compares current issue counts with the previous completed crawl (null = first crawl: nothing is "new"). */
export function diffIssues(current: IssueCount[], previous: IssueCount[] | null): IssueChange[] {
  if (!previous) return current.filter((c) => c.count > 0).map((c) => ({ key: c.key, kind: "same" as const, count: c.count, previous: null }));
  const prev = new Map(previous.filter((p) => p.count > 0).map((p) => [p.key, p.count]));
  const out: IssueChange[] = [];
  for (const c of current) {
    if (c.count <= 0) continue;
    const p = prev.get(c.key);
    if (p === undefined) out.push({ key: c.key, kind: "new", count: c.count, previous: 0 });
    else out.push({ key: c.key, kind: !changed(p, c.count) ? "same" : c.count > p ? "worse" : "better", count: c.count, previous: p });
    prev.delete(c.key);
  }
  for (const [key, p] of prev) out.push({ key, kind: "fixed", count: 0, previous: p });
  return out;
}

export function summarizeDiff(changes: IssueChange[]): Record<ChangeKind, number> {
  const s: Record<ChangeKind, number> = { new: 0, fixed: 0, worse: 0, better: 0, same: 0 };
  for (const c of changes) s[c.kind]++;
  return s;
}

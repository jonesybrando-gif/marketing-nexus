import { formatNumber } from "./money";

const n0 = (n: number | null | undefined) => (n == null ? "—" : formatNumber(n, 0));

/** "Calls rose 18% (120 → 142), 61 from first-time callers; 9 were missed." Built from the figures only. */
export function callLead(now: Record<string, number | null>, before: Record<string, number | null> | null): string {
  const calls = now["callrail.calls"];
  if (calls == null) return "No CallRail calls for this period yet.";
  const prev = before?.["callrail.calls"] ?? null;
  const first = now["callrail.firstTimeCallers"];
  const missed = now["callrail.missed"];
  const parts: string[] = [];
  if (prev) {
    const pct = ((calls - prev) / prev) * 100;
    parts.push(Math.abs(pct) < 5 ? `Calls held steady at ${n0(calls)}` : `Calls ${pct < 0 ? "fell" : "rose"} ${Math.round(Math.abs(pct))}% (${n0(prev)} → ${n0(calls)})`);
  } else parts.push(`${n0(calls)} tracked call${calls === 1 ? "" : "s"}`);
  if (first != null && calls > 0) parts[0] += `, ${n0(first)} from first-time callers`;
  let s = `${parts[0]}.`;
  if (missed != null && calls > 0 && missed > 0) s += ` ${n0(missed)} ${missed === 1 ? "was" : "were"} missed (${Math.round((missed / calls) * 100)}%).`;
  return s;
}


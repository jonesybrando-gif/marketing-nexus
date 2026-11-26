"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { ArrowDown, ArrowUp } from "lucide-react";
import type { AgencyAuditRow } from "@/server/site-audit/queries";
import { scoreBand } from "@/lib/site-audit/score";
import { formatDate } from "@/lib/time";
import { Badge } from "@/components/ui/badge";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";

type Key = "clientName" | "score" | "change" | "errors" | "pages" | "lastCrawl";
const day = (iso: string | null) => (iso ? formatDate(iso.slice(0, 10), { month: "short", day: "numeric" }) : "—");
const STATUS_TEXT: Record<string, string> = { queued: "Starting", crawling: "Crawling", processing: "Analysing", failed: "Last crawl failed", skipped: "Last crawl skipped" };

/** Sortable list of clients' site health (default: worst score first). */
export function AuditList({ rows }: { rows: AgencyAuditRow[] }) {
  const [sort, setSort] = useState<{ key: Key; dir: 1 | -1 }>({ key: "score", dir: 1 });
  const sorted = useMemo(() => [...rows].sort((a, b) => {
    const x = a[sort.key], y = b[sort.key];
    if (x === null && y === null) return 0;
    if (x === null) return 1;
    if (y === null) return -1;
    return (typeof x === "string" ? x.localeCompare(String(y)) : (x as number) - (y as number)) * sort.dir;
  }), [rows, sort]);
  const head = (k: Key, label: string, right = true) => (
    <TH className={right ? "text-right" : "pl-4"} aria-sort={sort.key === k ? (sort.dir === 1 ? "ascending" : "descending") : "none"}>
      <button type="button" className="inline-flex cursor-pointer items-center gap-1 hover:text-text" onClick={() => setSort((s) => ({ key: k, dir: s.key === k ? ((-s.dir) as 1 | -1) : k === "errors" ? -1 : 1 }))}>
        {label}{sort.key === k && (sort.dir === 1 ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />)}
      </button>
    </TH>
  );
  return (
    <div className="overflow-x-auto rounded-xl border border-border bg-surface">
      <Table>
        <THead>
          <tr>
            {head("clientName", "Client", false)}
            {head("score", "Health score")}
            {head("change", "Change")}
            {head("errors", "Errors")}
            {head("pages", "Pages")}
            {head("lastCrawl", "Last crawl")}
            <TH className="pr-4">Next crawl</TH>
          </tr>
        </THead>
        <TBody>
          {sorted.map((r) => {
            const band = scoreBand(r.score);
            return (
              <TR key={r.clientId}>
                <TD className="pl-4">
                  <Link href={`/clients/${r.clientId}?tab=audit`} className="font-medium hover:underline">{r.clientName}</Link>
                  <span className="block text-xs text-text-3">{r.targetUrl?.replace(/^https?:\/\//, "") ?? "—"}</span>
                </TD>
                <TD className="text-right">
                  {r.score === null ? <span className="text-text-3">—</span> : <span className="inline-flex items-center gap-2"><span className="text-lg font-semibold tabular">{r.score}</span><Badge variant={band.tone === "neutral" ? "neutral" : band.tone}>{band.label}</Badge></span>}
                </TD>
                <TD className="text-right tabular">{r.change === null ? <span className="text-text-3">—</span> : r.change === 0 ? <span className="text-text-3">0</span> : <span className={r.change > 0 ? "text-good-ink" : "text-critical-ink"}>{r.change > 0 ? "▲" : "▼"} {Math.abs(r.change)}</span>}</TD>
                <TD className="text-right tabular">{r.score === null ? "—" : <span className={r.errors > 0 ? "font-semibold text-critical-ink" : ""}>{r.errors}</span>}</TD>
                <TD className="text-right tabular">{r.pages ?? "—"}</TD>
                <TD className="text-right">
                  {day(r.lastCrawl)}
                  {r.status && STATUS_TEXT[r.status] && <span className={`block text-xs ${r.status === "failed" || r.status === "skipped" ? "text-warning-ink" : "text-info-ink"}`}>{STATUS_TEXT[r.status]}</span>}
                </TD>
                <TD className="pr-4 text-sm text-text-2">{r.schedule === "manual" ? "By hand" : day(r.nextRunAt)}</TD>
              </TR>
            );
          })}
        </TBody>
      </Table>
    </div>
  );
}

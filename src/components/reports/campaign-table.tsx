"use client";

import { displayCampaignName } from "@/lib/campaign-name";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Columns3 } from "lucide-react";
import { PLATFORM_LABEL, type PlatformKey } from "@/lib/platforms";
import { formatKpi, KPI_BY_KEY, type KpiKey } from "@/lib/kpis";
import { emptyTotals, type MetricTotals } from "@/lib/metrics";
import type { ReportParams } from "@/server/client-report";
import { Input, Select } from "@/components/ui/input";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { PlatformLabel } from "@/components/platform-badge";
import { InfoTip } from "@/components/ui/info-tip";
import { cn } from "@/components/ui/cn";
import { CampaignDetailPanel } from "./campaign-detail";

export interface CampaignRow {
  id: string;
  name: string;
  platform: PlatformKey;
  status: string;
  costMinor: number;
  clicks: number;
  conversions: number;
  conversionValueMinor: number;
  impressions?: number;
  leads?: number;
  accountId?: string;
  accountName?: string;
}

// --- Columns: a few by default, more on request (remembered per browser) ---

type MetricCol = { key: string; kpi: KpiKey };
const METRIC_COLS: MetricCol[] = [
  { key: "spend", kpi: "spend" },
  { key: "impressions", kpi: "impressions" },
  { key: "clicks", kpi: "clicks" },
  { key: "ctr", kpi: "ctr" },
  { key: "cpc", kpi: "cpc" },
  { key: "conversions", kpi: "conversions" },
  { key: "convRate", kpi: "conversionRate" },
  { key: "cpa", kpi: "costPerConversion" },
  { key: "convValue", kpi: "conversionValue" },
  { key: "roas", kpi: "roas" },
];
type ColKey = "platform" | "account" | "status" | (typeof METRIC_COLS)[number]["key"];
const DEFAULT_COLS: ColKey[] = ["platform", "status", "spend", "conversions", "cpa"];
const ALL_COLS: ColKey[] = ["platform", "account", "status", ...METRIC_COLS.map((c) => c.key)];
const COL_LABEL = (c: ColKey) => (c === "platform" ? "Platform" : c === "account" ? "Account" : c === "status" ? "Status" : KPI_BY_KEY[METRIC_COLS.find((m) => m.key === c)!.kpi].label);
const STORAGE = "mn:campaign-columns";

const totalsOf = (r: CampaignRow): MetricTotals => ({
  ...emptyTotals(),
  costMinor: r.costMinor,
  impressions: r.impressions ?? 0,
  clicks: r.clicks,
  conversions: r.conversions,
  conversionValueMinor: r.conversionValueMinor,
  leads: r.leads ?? 0,
});
const metricValue = (t: MetricTotals, kpi: KpiKey) => KPI_BY_KEY[kpi].value(t);
const statusText = (s: string) => s.charAt(0) + s.slice(1).toLowerCase();
const active = (r: CampaignRow) => r.costMinor !== 0 || r.clicks !== 0 || r.conversions !== 0;

/**
 * Campaigns for the selected range and accounts: Campaign, Platform, Status,
 * Spend, Conversions and Cost per conversion by default; more columns from
 * "Columns" (remembered). Sortable, searchable, filterable by platform,
 * account and status, with totals worked out from the summed figures. With
 * `detail`, clicking a campaign opens its detail view.
 */
export function CampaignTable({ rows, currency, detail }: { rows: CampaignRow[]; currency: string; detail?: { clientId: string; params: ReportParams } }) {
  const [q, setQ] = useState("");
  const [platform, setPlatform] = useState("");
  const [account, setAccount] = useState("");
  const [status, setStatus] = useState("");
  const [showInactive, setShowInactive] = useState(false);
  const [sort, setSort] = useState<{ key: ColKey | "name"; dir: 1 | -1 }>({ key: "spend", dir: -1 });
  const [cols, setCols] = useState<ColKey[]>(DEFAULT_COLS);
  const [openId, setOpenId] = useState<string | null>(null);

  useEffect(() => {
    try {
      const saved = JSON.parse(window.localStorage.getItem(STORAGE) ?? "null");
      if (Array.isArray(saved) && saved.every((c) => ALL_COLS.includes(c))) setCols(saved);
    } catch {
      // Defaults.
    }
  }, []);
  const toggleCol = (c: ColKey) =>
    setCols((cur) => {
      const next = cur.includes(c) ? cur.filter((x) => x !== c) : ALL_COLS.filter((x) => cur.includes(x) || x === c);
      try {
        window.localStorage.setItem(STORAGE, JSON.stringify(next));
      } catch {
        // Not remembered.
      }
      return next;
    });

  const platforms = [...new Set(rows.map((r) => r.platform))];
  const accounts = [...new Map(rows.filter((r) => r.accountId).map((r) => [r.accountId!, r.accountName ?? r.accountId!])).entries()];
  const statuses = [...new Set(rows.map((r) => r.status))];
  const inactive = rows.filter((r) => !active(r)).length;
  const filtering = !!(q || platform || account || status);

  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const val = (r: CampaignRow, k: ColKey | "name"): number | string | null => {
      if (k === "name") return displayCampaignName(r.name).toLowerCase();
      if (k === "platform") return PLATFORM_LABEL[r.platform];
      if (k === "account") return r.accountName ?? "";
      if (k === "status") return r.status;
      return metricValue(totalsOf(r), METRIC_COLS.find((m) => m.key === k)!.kpi);
    };
    return rows
      .filter((r) => (showInactive || filtering || active(r)) && (!needle || r.name.toLowerCase().includes(needle)) && (!platform || r.platform === platform) && (!account || r.accountId === account) && (!status || r.status === status))
      .sort((a, b) => {
        const x = val(a, sort.key);
        const y = val(b, sort.key);
        if (x === y) return b.costMinor - a.costMinor || a.name.localeCompare(b.name);
        if (x === null) return 1; // unknown values last, either direction
        if (y === null) return -1;
        return (typeof x === "string" ? x.localeCompare(y as string) : x - (y as number)) * sort.dir;
      });
  }, [rows, q, platform, account, status, showInactive, filtering, sort]);

  // Totals from summed figures (rates worked out from the sums, never averaged).
  const total = visible.reduce((t, r) => {
    const x = totalsOf(r);
    return { ...t, costMinor: t.costMinor + x.costMinor, impressions: t.impressions + x.impressions, clicks: t.clicks + x.clicks, conversions: t.conversions + x.conversions, conversionValueMinor: t.conversionValueMinor + x.conversionValueMinor, leads: t.leads + x.leads };
  }, emptyTotals());

  const metricCols = METRIC_COLS.filter((m) => cols.includes(m.key));
  const cell = (t: MetricTotals, m: MetricCol) => formatKpi(m.kpi, metricValue(t, m.kpi), currency, { whole: m.kpi === "spend" || m.kpi === "conversionValue" });

  const head = (key: ColKey | "name", text: string, className = "text-right", info?: string) => (
    <TH className={className} aria-sort={sort.key === key ? (sort.dir === 1 ? "ascending" : "descending") : "none"}>
      <span className="inline-flex items-center gap-1 whitespace-nowrap">
        <button
          type="button"
          className="inline-flex cursor-pointer items-center gap-1 hover:text-text"
          onClick={() => setSort((s) => ({ key, dir: s.key === key ? ((-s.dir) as 1 | -1) : key === "name" || key === "cpa" || key === "cpc" || typeof key === "string" && ["platform", "account", "status"].includes(key) ? 1 : -1 }))}
        >
          {text}
          {sort.key === key && (sort.dir === 1 ? <ArrowUp className="h-3 w-3" aria-hidden /> : <ArrowDown className="h-3 w-3" aria-hidden />)}
        </button>
        {info && <InfoTip label={text} text={info} align="end" />}
      </span>
    </TH>
  );

  if (rows.length === 0) return <p className="px-5 pb-5 text-sm text-text-3">No campaigns for this client yet. They appear after the first sync of a linked ad account.</p>;

  const open = openId ? rows.find((r) => r.id === openId) : null;
  const nameCell = (r: CampaignRow) =>
    detail ? (
      <button type="button" onClick={() => setOpenId(r.id)} className="cursor-pointer text-left font-medium text-text hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring">
        {displayCampaignName(r.name)}
      </button>
    ) : (
      displayCampaignName(r.name)
    );

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 px-5 pb-3">
        <Input placeholder="Search campaigns…" value={q} onChange={(e) => setQ(e.target.value)} className="w-full sm:w-56" aria-label="Search campaigns" />
        {platforms.length > 1 && (
          <Select aria-label="Platform" value={platform} onChange={(e) => setPlatform(e.target.value)} className="w-auto">
            <option value="">All platforms</option>
            {platforms.map((p) => <option key={p} value={p}>{PLATFORM_LABEL[p]}</option>)}
          </Select>
        )}
        {accounts.length > 1 && (
          <Select aria-label="Account" value={account} onChange={(e) => setAccount(e.target.value)} className="w-auto max-w-56">
            <option value="">All accounts</option>
            {accounts.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </Select>
        )}
        {statuses.length > 1 && (
          <Select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)} className="w-auto">
            <option value="">Any status</option>
            {statuses.map((s) => <option key={s} value={s}>{statusText(s)}</option>)}
          </Select>
        )}
        <ColumnPicker cols={cols} onToggle={toggleCol} />
        <span className="ml-auto text-xs text-text-3">
          {visible.length} of {rows.length} campaigns
          {inactive > 0 && !filtering && (
            <>
              {" · "}
              <button type="button" className="cursor-pointer underline hover:text-text" onClick={() => setShowInactive((v) => !v)} aria-expanded={showInactive}>
                {showInactive ? "Hide" : "Show"} {inactive} inactive
              </button>
            </>
          )}
        </span>
      </div>

      {/* Phones: compact cards with the default figures. */}
      <ul className="flex flex-col gap-2 px-3 pb-3 md:hidden" aria-label="Campaigns">
        {visible.map((r) => {
          const t = totalsOf(r);
          return (
            <li key={r.id} className="rounded-lg border border-border p-3">
              <p className="font-medium">{nameCell(r)}</p>
              <p className="text-xs text-text-3"><PlatformLabel platform={r.platform} /> · {statusText(r.status)}</p>
              <dl className="mt-2 grid grid-cols-3 gap-2 text-xs">
                <div><dt className="text-text-3">Ad spend</dt><dd className="font-medium tabular">{formatKpi("spend", t.costMinor, currency, { whole: true })}</dd></div>
                <div><dt className="text-text-3">Conversions</dt><dd className="font-medium tabular">{formatKpi("conversions", t.conversions, currency)}</dd></div>
                <div><dt className="text-text-3">Cost per conversion</dt><dd className="font-medium tabular">{formatKpi("costPerConversion", metricValue(t, "costPerConversion"), currency)}</dd></div>
              </dl>
            </li>
          );
        })}
      </ul>

      <div className="hidden md:block">
        <Table>
          <THead>
            <tr>
              {head("name", "Campaign", "pl-5 text-left")}
              {cols.includes("platform") && head("platform", "Platform", "text-left")}
              {cols.includes("account") && head("account", "Account", "text-left")}
              {cols.includes("status") && head("status", "Status", "text-left")}
              {metricCols.map((m, i) => <Fragment key={m.key}>{head(m.key, KPI_BY_KEY[m.kpi].label, cn("text-right", i === metricCols.length - 1 && "pr-5"), KPI_BY_KEY[m.kpi].plain)}</Fragment>)}
            </tr>
          </THead>
          <TBody>
            {visible.map((r) => {
              const t = totalsOf(r);
              return (
                <TR key={r.id}>
                  <TD className="min-w-56 pl-5 font-medium whitespace-normal">{nameCell(r)}</TD>
                  {cols.includes("platform") && <TD className="text-xs"><PlatformLabel platform={r.platform} /></TD>}
                  {cols.includes("account") && <TD className="max-w-48 truncate text-xs text-text-2" title={r.accountName}>{r.accountName ?? "—"}</TD>}
                  {cols.includes("status") && <TD className="text-xs text-text-2">{statusText(r.status)}</TD>}
                  {metricCols.map((m, i) => <TD key={m.key} className={cn("text-right", i === metricCols.length - 1 && "pr-5")}>{cell(t, m)}</TD>)}
                </TR>
              );
            })}
            {visible.length === 0 && (
              <tr><td colSpan={1 + cols.length} className="px-5 py-8 text-center text-sm text-text-3">{filtering ? "No campaigns match these filters." : "No campaign spent anything in this period."}</td></tr>
            )}
          </TBody>
          {visible.length > 1 && (
            <tfoot className="border-t-2 border-border font-medium">
              <tr>
                <td className="px-3 py-2.5 pl-5" colSpan={1 + cols.filter((c) => c === "platform" || c === "account" || c === "status").length}>Total ({visible.length} shown)</td>
                {metricCols.map((m, i) => <td key={m.key} className={cn("px-3 py-2.5 text-right", i === metricCols.length - 1 && "pr-5")}>{cell(total, m)}</td>)}
              </tr>
            </tfoot>
          )}
        </Table>
      </div>

      {detail && open && <CampaignDetailPanel clientId={detail.clientId} params={detail.params} campaign={{ id: open.id, name: displayCampaignName(open.name) }} onClose={() => setOpenId(null)} />}
    </div>
  );
}

/** "Columns": tick which figures the table shows (Campaign is always there). */
function ColumnPicker({ cols, onToggle }: { cols: ColKey[]; onToggle: (c: ColKey) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);
  return (
    <div ref={ref} className="relative hidden md:block">
      <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)} className="inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-md border border-border bg-surface px-3 text-sm text-text-2 hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring">
        <Columns3 className="h-4 w-4" aria-hidden /> Columns
      </button>
      {open && (
        <fieldset className="absolute left-0 z-30 mt-1 flex w-56 flex-col gap-0.5 rounded-lg border border-border bg-surface p-2 shadow-lg">
          <legend className="sr-only">Columns to show</legend>
          {ALL_COLS.map((c) => (
            <label key={c} className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-sm hover:bg-surface-2">
              <input type="checkbox" checked={cols.includes(c)} onChange={() => onToggle(c)} />
              {COL_LABEL(c)}
            </label>
          ))}
        </fieldset>
      )}
    </div>
  );
}

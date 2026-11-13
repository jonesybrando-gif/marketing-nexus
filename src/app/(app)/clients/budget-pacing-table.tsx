"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useId, useMemo, useRef, useState, useTransition, type ReactNode } from "react";
import { AlertTriangle, ArrowDown, ArrowUp, Download } from "lucide-react";
import { loadOnHover } from "@/lib/link-hover";
import { formatMoney, parseMoneyToMinor } from "@/lib/money";
import { formatDate } from "@/lib/time";
import { toCsv, minorToDecimal } from "@/lib/csv";
import { PLATFORMS, PLATFORM_LABEL, type PlatformKey } from "@/lib/platforms";
import { budgetLeft, classifySimplePacing, formatSignedMoney, platformSortLabel, prioritySort, type SimpleRow, type SimpleTone } from "@/lib/pacing/simple";
import { Input, Select } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { saveMonthlyBudget } from "./budget-pacing-actions";

const FILTER_LABEL: Record<PlatformKey, string> = { ...PLATFORM_LABEL, GOOGLE_LSA: "Google Local Services Ads" };
const DOT: Record<SimpleTone, string> = { red: "bg-critical", amber: "bg-dot-watch", green: "bg-good", gray: "bg-transparent ring-1 ring-inset ring-text-3/60" };

type SortKey = "client" | "platform" | "budget" | "used" | "left";
type Sort = { key: SortKey; dir: 1 | -1 } | null;

const money = (r: SimpleRow) => (m: number) => formatMoney(m, r.currency, { whole: true });
const platformText = (r: SimpleRow) => platformSortLabel(r.platforms, PLATFORM_LABEL) || "—";
const info = (r: SimpleRow) => classifySimplePacing(r, money(r));

/** Numbers sort with unknown values last in either direction. */
function byNumber(a: number | null, b: number | null, dir: 1 | -1) {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return (b - a) * dir;
}

export interface MonthOption { key: string; label: string }

export function BudgetPacingTable({ rows: initialRows, month, months, editable }: { rows: SimpleRow[]; month: MonthOption; months: MonthOption[]; editable: Record<string, boolean> }) {
  const router = useRouter();
  const [navigating, startNav] = useTransition();
  const [rows, setRows] = useState(initialRows);
  useEffect(() => setRows(initialRows), [initialRows]);
  const [q, setQ] = useState("");
  const [platform, setPlatform] = useState<PlatformKey | "">("");
  const [sort, setSort] = useState<Sort>(null);

  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const out = rows.filter((r) => (!needle || r.clientName.toLowerCase().includes(needle)) && (!platform || r.platforms.includes(platform)));
    if (!sort) return prioritySort(out, info, platformText);
    const tie = (a: SimpleRow, b: SimpleRow) => a.clientName.localeCompare(b.clientName) || platformText(a).localeCompare(platformText(b));
    const cmp: Record<SortKey, (a: SimpleRow, b: SimpleRow) => number> = {
      client: (a, b) => a.clientName.localeCompare(b.clientName) * sort.dir || platformText(a).localeCompare(platformText(b)),
      platform: (a, b) => platformText(a).localeCompare(platformText(b)) * sort.dir || a.clientName.localeCompare(b.clientName),
      budget: (a, b) => byNumber(a.budgetMinor, b.budgetMinor, sort.dir) || tie(a, b),
      used: (a, b) => byNumber(a.spendMinor, b.spendMinor, sort.dir) || tie(a, b),
      left: (a, b) => byNumber(budgetLeft(a), budgetLeft(b), sort.dir) || tie(a, b),
    };
    return [...out].sort(cmp[sort.key]);
  }, [rows, q, platform, sort]);

  // Click: sort (A–Z for text, highest first for amounts); again: reverse; third time: back to most urgent first.
  const header = (key: SortKey, label: string, numeric = false, short?: string) => {
    const active = sort?.key === key;
    const ascending = active && (numeric ? sort.dir === -1 : sort.dir === 1);
    return (
      <th scope="col" aria-sort={active ? (ascending ? "ascending" : "descending") : "none"} className={cn("px-3 py-2.5 text-xs font-medium text-text-3 whitespace-nowrap", numeric ? "text-right" : "text-left", key === "client" && "pl-3 sm:pl-5", key === "platform" && "hidden sm:table-cell", key === "left" && "pr-3 sm:pr-5", "max-sm:px-1.5")}>
        <button
          type="button"
          className={cn("inline-flex cursor-pointer items-center gap-1 hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring rounded-sm", active && "text-text")}
          onClick={() => setSort((s) => (s?.key !== key ? { key, dir: 1 } : s.dir === 1 ? { key, dir: -1 } : null))}
        >
          {short ? <><span className="sm:hidden">{short}</span><span className="hidden sm:inline">{label}</span></> : label}
          {active && (ascending ? <ArrowUp className="h-3 w-3" aria-hidden /> : <ArrowDown className="h-3 w-3" aria-hidden />)}
        </button>
      </th>
    );
  };

  const exportCsv = () => {
    const body = visible.map((r) => [r.clientName, platformText(r), minorToDecimal(r.budgetMinor), minorToDecimal(r.spendMinor), minorToDecimal(budgetLeft(r))]);
    const blob = new Blob([toCsv(["Client", "Platform", "Monthly Budget", "Budget Used", "Budget Left"], body)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `budget-pacing-${month.key}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const onSaved = (key: string, amountMinor: number, created: boolean) => {
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, budgetMinor: amountMinor, ...(created ? { edit: null, editNote: "Saving…" } : {}) } : r)));
    router.refresh();
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Input type="search" placeholder="Search clients" value={q} onChange={(e) => setQ(e.target.value)} className="w-full sm:w-56" aria-label="Search clients" />
        <Select value={platform} onChange={(e) => setPlatform(e.target.value as PlatformKey | "")} className="w-full sm:w-56" aria-label="Platform">
          <option value="">All Platforms</option>
          {PLATFORMS.map((p) => <option key={p} value={p}>{FILTER_LABEL[p]}</option>)}
        </Select>
        <Select
          value={month.key}
          onChange={(e) => startNav(() => router.push(`/clients?view=budgets&month=${e.target.value}`))}
          className="w-full sm:w-44"
          aria-label="Month"
          disabled={navigating}
        >
          {months.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
        </Select>
        <Button type="button" variant="outline" size="sm" onClick={exportCsv} className="ml-auto h-9 max-sm:w-full">
          <Download className="h-4 w-4" aria-hidden /> Export CSV
        </Button>
      </div>

      <div className={cn("overflow-x-auto rounded-xl border border-border bg-surface transition-opacity", navigating && "opacity-60")}>
        <table className="w-full table-fixed text-[13px] tabular sm:min-w-[640px] sm:text-sm">
          <colgroup>
            <col />
            <col className="hidden w-[22%] sm:table-column" />
            <col className="w-[23%] sm:w-[16%]" />
            <col className="w-[20%] sm:w-[15%]" />
            <col className="w-[20%] sm:w-[15%]" />
          </colgroup>
          <thead className="border-b border-border">
            <tr>
              {header("client", "Client")}
              {header("platform", "Platform")}
              {header("budget", "Monthly Budget", true, "Budget")}
              {header("used", "Budget Used", true, "Used")}
              {header("left", "Budget Left", true, "Left")}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {visible.map((r) => {
              const s = info(r);
              const left = budgetLeft(r);
              return (
                <tr key={r.key} className="hover:bg-surface-2/60">
                  <td className="py-2.5 pl-3 pr-1.5 sm:pl-5 sm:pr-3">
                    <div className="flex min-w-0 items-center gap-2 sm:gap-2.5">
                      <Tip text={s.message}>
                        <span role="img" aria-label={s.message} tabIndex={0} className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring">
                          <span aria-hidden className={cn("h-2 w-2 rounded-full", DOT[s.tone])} />
                        </span>
                      </Tip>
                      <div className="min-w-0">
                        <Link {...loadOnHover} href={`/clients/${r.clientId}?tab=budgets`} className="block truncate font-medium text-text hover:underline" title={r.clientName}>{r.clientName}</Link>
                        <span className="block truncate text-xs text-text-3 sm:hidden">{platformText(r)}</span>
                      </div>
                    </div>
                  </td>
                  <td className="hidden truncate px-3 py-2.5 whitespace-nowrap text-text-2 sm:table-cell" title={platformText(r)}>{platformText(r)}</td>
                  <td className="px-1.5 py-2.5 text-right whitespace-nowrap sm:px-3">
                    <BudgetCell row={r} month={month.key} canEdit={!!editable[r.clientId]} onSaved={onSaved} />
                  </td>
                  <td className="px-1.5 py-2.5 text-right whitespace-nowrap sm:px-3">
                    <span className="inline-flex items-center justify-end gap-1.5">
                      {r.warning && (
                        <Tip text={r.warning} align="end">
                          <span role="img" tabIndex={0} aria-label={r.warning} className="inline-flex rounded-sm text-warning-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring">
                            <AlertTriangle className="h-3.5 w-3.5" aria-hidden />
                          </span>
                        </Tip>
                      )}
                      {r.spendMinor === null ? <span className="text-text-3" title="No spend data">—</span> : <span title={r.asOf ? `Through ${formatDate(r.asOf)}` : undefined}>{money(r)(r.spendMinor)}</span>}
                    </span>
                  </td>
                  <td className={cn("py-2.5 pl-1.5 pr-3 text-right font-semibold whitespace-nowrap sm:pl-3 sm:pr-5", left !== null && left < 0 ? "text-critical-ink" : "text-text")}>
                    {left === null ? <span className="font-normal text-text-3">—</span> : formatSignedMoney(left, money(r))}
                  </td>
                </tr>
              );
            })}
            {visible.length === 0 && (
              <tr>
                <td colSpan={5} className="px-5 py-10 text-center text-sm text-text-3">
                  {rows.length === 0 ? `No budgets or ad spend for ${month.label}.` : "No clients match these filters."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** Hover or keyboard-focus tooltip: short text, never shown permanently. */
function Tip({ text, children, align = "start" }: { text: string; children: ReactNode; align?: "start" | "end" }) {
  return (
    <span className="group/tip relative inline-flex">
      {children}
      <span
        aria-hidden
        className={cn(
          "pointer-events-none absolute top-full z-20 mt-1.5 w-max max-w-64 rounded-md bg-text px-2.5 py-1.5 text-left text-xs font-normal whitespace-normal text-surface opacity-0 shadow-md transition-opacity",
          "group-hover/tip:opacity-100 group-focus-within/tip:opacity-100",
          align === "end" ? "right-0" : "-left-1",
        )}
      >
        {text}
      </span>
    </span>
  );
}

function BudgetCell({ row, month, canEdit, onSaved }: { row: SimpleRow; month: string; canEdit: boolean; onSaved: (key: string, amountMinor: number, created: boolean) => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, startSave] = useTransition();
  const input = useRef<HTMLInputElement>(null);
  const errId = useId();
  const shown = row.budgetMinor === null ? null : formatMoney(row.budgetMinor, row.currency, { whole: true });

  useEffect(() => {
    if (editing) input.current?.select();
  }, [editing]);

  if (!canEdit || !row.edit) {
    const note = canEdit ? row.editNote : null;
    return (
      <span title={note ?? undefined} className={cn(row.budgetMinor === null && "text-text-3")}>
        {shown ?? "—"}
        {note && <span className="sr-only"> ({note})</span>}
      </span>
    );
  }

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => {
          setValue(row.budgetMinor === null ? "" : (row.budgetMinor / 100).toFixed(row.budgetMinor % 100 ? 2 : 0));
          setError(null);
          setEditing(true);
        }}
        className={cn("cursor-text rounded-sm border-b border-dashed border-transparent hover:border-text-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring", row.budgetMinor === null && "text-text-3")}
        aria-label={`Edit ${month} budget for ${row.clientName}, ${platformText(row)}${shown ? `, currently ${shown}` : ""}`}
      >
        {shown ?? "Set budget"}
      </button>
    );
  }

  const save = () => {
    const raw = value.trim();
    if (!raw) return setError("Enter an amount.");
    if (raw.startsWith("-")) return setError("Budgets can't be negative.");
    let amountMinor: number;
    try {
      amountMinor = parseMoneyToMinor(raw);
    } catch {
      return setError("Enter a number like 4000 or 4000.50.");
    }
    setError(null);
    startSave(async () => {
      try {
        const res = await saveMonthlyBudget({ clientId: row.clientId, month, amount: raw, target: row.edit });
        if (!res.ok) return setError(res.error);
        setEditing(false);
        onSaved(row.key, amountMinor, row.edit!.kind === "create");
      } catch {
        setError("Couldn't save. Try again.");
      }
    });
  };

  return (
    <form
      className="inline-flex flex-col items-end gap-1"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <span className="inline-flex items-center gap-1">
        <span className="relative">
          <span aria-hidden className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-text-3">$</span>
          <input
            ref={input}
            inputMode="decimal"
            value={value}
            disabled={saving}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                setEditing(false);
                setError(null);
              }
            }}
            aria-label={`Monthly budget for ${row.clientName}, ${platformText(row)}`}
            aria-invalid={!!error}
            aria-describedby={error ? errId : undefined}
            className="h-8 w-24 rounded-md border border-border bg-surface pr-2 pl-5 text-right text-sm tabular text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
          />
        </span>
        <button type="submit" disabled={saving} className="h-8 cursor-pointer rounded-md px-2 text-xs font-semibold text-brand-text hover:bg-surface-2 disabled:opacity-60">
          {saving ? "Saving" : "Save"}
        </button>
      </span>
      {error && <span id={errId} role="alert" className="text-xs text-critical-ink">{error}</span>}
    </form>
  );
}

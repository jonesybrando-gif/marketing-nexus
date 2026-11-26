"use client";

import { useActionState, useMemo, useState } from "react";
import type { KeywordRankRow } from "@/server/metrics/rankings-rows";
import { bulkKeywordAction } from "./actions";
import { useFormSubmit } from "@/components/use-form-submit";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label, Select } from "@/components/ui/input";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { Sparkline } from "@/components/kpi/sparkline";
import { LocationPicker, type PickedLocation } from "@/components/rankings/location-picker";
import { DEVICE_OPTIONS } from "@/lib/rankings";

const FEATURE_LABEL: Record<string, string> = {
  local_pack: "Local pack", map: "Map", people_also_ask: "People also ask", featured_snippet: "Featured snippet", ai_overview: "AI overview",
  images: "Images", video: "Videos", top_stories: "Top stories", knowledge_graph: "Knowledge panel", paid: "Ads", shopping: "Shopping",
  related_searches: "Related searches", twitter: "X posts", discussions_and_forums: "Forums", perspectives: "Perspectives", answer_box: "Answer box",
};
const SKIP_FEATURES = new Set(["organic", "related_searches", "people_also_search"]);

function Change({ v }: { v: number | null }) {
  if (v === null) return <span className="text-text-3">—</span>;
  if (v === 0) return <span className="text-text-3">0</span>;
  const up = v < 0; // lower position = better
  return <span className={up ? "text-good-ink" : "text-critical-ink"}>{up ? "▲" : "▼"} {Math.abs(v)}</span>;
}

function shortUrl(u: string) {
  try {
    const x = new URL(u);
    return (x.pathname + x.search).replace(/\/$/, "") || "/";
  } catch {
    return u;
  }
}

export interface ArchivedItem { id: string; keyword: string; locationName: string; device: string; archivedAt: string }

/** Bulk actions for the selected items, posted as one form (ids + op + optional location/device). */
function BulkBar({ clientId, ids, defaultLocation, onDone }: { clientId: string; ids: string[]; defaultLocation: PickedLocation; onDone: (message: string) => void }) {
  // On success the selection clears and this bar unmounts, so the message is shown by the table.
  const [state, action, pending] = useActionState(async (prev: Awaited<ReturnType<typeof bulkKeywordAction>>, fd: FormData) => {
    const r = await bulkKeywordAction(clientId, prev, fd);
    if (r?.ok) onDone(r.ok);
    return r;
  }, undefined);
  const form = useFormSubmit(action);
  const [mode, setMode] = useState<"" | "move">("");
  const [changeLoc, setChangeLoc] = useState(true);
  const submit = (op: string, confirmText?: string) => (e: React.MouseEvent<HTMLButtonElement>) => {
    if (confirmText && !window.confirm(confirmText)) { e.preventDefault(); return; }
    const f = e.currentTarget.form;
    if (f) (f.elements.namedItem("op") as HTMLInputElement).value = op;
  };
  return (
    <form {...form} className="flex flex-col gap-2 rounded-md border border-brand/40 bg-brand/5 px-3 py-2" aria-label="Bulk actions">
      {ids.map((id) => <input key={id} type="hidden" name="ids" value={id} />)}
      <input type="hidden" name="op" defaultValue="" />
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium">{ids.length} selected</span>
        <Button type="button" size="sm" variant="outline" onClick={() => setMode(mode === "move" ? "" : "move")} aria-expanded={mode === "move"}>Change location or device…</Button>
        <Button type="submit" size="sm" variant="outline" disabled={pending} onClick={submit("pause")}>Pause</Button>
        <Button type="submit" size="sm" variant="outline" disabled={pending} onClick={submit("resume")}>Resume</Button>
        <Button type="submit" size="sm" variant="outline" disabled={pending} onClick={submit("archive")}>Archive</Button>
        <Button type="submit" size="sm" variant="ghost" disabled={pending} onClick={submit("delete", `Delete ${ids.length} item${ids.length === 1 ? "" : "s"} and their rank history? This can't be undone. Archive keeps the history.`)}>Delete</Button>
        {state?.errors?.map((e) => <span key={e} className="text-xs text-critical-ink" role="alert">{e}</span>)}
      </div>
      {mode === "move" && (
        <div className="grid items-end gap-3 md:grid-cols-[auto_1.3fr_200px_auto]">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="changeLocation" value="1" checked={changeLoc} onChange={(e) => setChangeLoc(e.target.checked)} /> New location
          </label>
          <div className={changeLoc ? "" : "pointer-events-none opacity-40"} aria-disabled={!changeLoc}>
            <LocationPicker defaultValue={defaultLocation} />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="bulk-device">Device</Label>
            <Select id="bulk-device" name="device" defaultValue="keep">
              <option value="keep">Keep each item&apos;s device</option>
              {DEVICE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </Select>
          </div>
          <Button type="submit" size="sm" disabled={pending} onClick={submit("move")}>Apply to {ids.length}</Button>
          <p className="text-xs text-text-3 md:col-span-4">Creates new tracked items at the new location/device and archives the old ones; their history is kept.</p>
        </div>
      )}
    </form>
  );
}

function Rows({ rows, selected, toggle }: { rows: KeywordRankRow[]; selected: Set<string>; toggle: (id: string) => void }) {
  return (
    <>
      {rows.map((r) => {
        const features = r.serpFeatures.filter((f) => !SKIP_FEATURES.has(f));
        return (
          <TR key={r.keywordId} className={r.paused ? "opacity-60" : undefined}>
            <TD className="w-8"><input type="checkbox" aria-label={`Select ${r.keyword} in ${r.locationName} on ${r.device}`} checked={selected.has(r.keywordId)} onChange={() => toggle(r.keywordId)} /></TD>
            <TD className="max-w-[240px] whitespace-normal">
              <span className="font-medium">{r.keyword}</span>
              {r.paused && <Badge variant="warning" className="ml-2">paused</Badge>}
              {!r.checkedOn && !r.paused && <span className="ml-2 text-xs text-text-3">waiting for first check</span>}
            </TD>
            <TD className="max-w-[180px] truncate text-sm" title={r.locationName}>{r.locationName}</TD>
            <TD className="text-sm capitalize">{r.device}</TD>
            <TD className="text-right font-semibold">{r.position ?? (r.checkedOn ? <span className="font-normal text-text-3">&gt;100</span> : "—")}{r.newlyRanked && <Badge variant="good" className="ml-1">new</Badge>}</TD>
            <TD className="text-right"><Change v={r.change7} /></TD>
            <TD className="text-right"><Change v={r.change30} /></TD>
            <TD className="text-right">{r.best ?? "—"}</TD>
            <TD className="max-w-[200px] truncate">
              {r.url ? <a href={r.url} target="_blank" rel="noreferrer noopener" className="text-brand-text hover:underline" title={r.url}>{shortUrl(r.url)}</a> : <span className="text-text-3">—</span>}
            </TD>
            <TD><Sparkline values={r.history.map((h) => (h.position === null ? null : -h.position))} width={80} height={24} /></TD>
            <TD className="max-w-[220px] whitespace-normal">
              <div className="flex flex-wrap gap-1">
                {features.slice(0, 3).map((f) => <Badge key={f} variant="neutral">{FEATURE_LABEL[f] ?? f.replace(/_/g, " ")}</Badge>)}
                {features.length > 3 && <span className="text-xs text-text-3" title={features.join(", ")}>+{features.length - 3}</span>}
              </div>
            </TD>
          </TR>
        );
      })}
    </>
  );
}

/**
 * Positions per tracked item (keyword × location × device) with a location
 * filter, a group-by-location view (one block per market) and bulk actions.
 */
export function RankTable({ clientId, rows, archived, defaultLocation }: { clientId: string; rows: KeywordRankRow[]; archived: ArchivedItem[]; defaultLocation: PickedLocation }) {
  const [location, setLocation] = useState<string>("");
  const [group, setGroup] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [notice, setNotice] = useState<string | null>(null);
  const locations = useMemo(() => {
    const m = new Map<number, { name: string; n: number }>();
    for (const r of rows) m.set(r.locationCode, { name: r.locationName, n: (m.get(r.locationCode)?.n ?? 0) + 1 });
    return [...m.entries()].sort((a, b) => a[1].name.localeCompare(b[1].name));
  }, [rows]);
  const visible = location ? rows.filter((r) => String(r.locationCode) === location) : rows;
  const toggle = (id: string) => {
    setNotice(null);
    setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  };
  const allOn = visible.length > 0 && visible.every((r) => selected.has(r.keywordId));
  const toggleAll = () => setSelected((s) => { const n = new Set(s); for (const r of visible) if (allOn) n.delete(r.keywordId); else n.add(r.keywordId); return n; });
  const groups = group ? locations.filter(([code]) => !location || String(code) === location).map(([code, l]) => ({ code, name: l.name, rows: visible.filter((r) => r.locationCode === code) })) : [{ code: 0, name: "", rows: visible }];
  const avg = (rs: KeywordRankRow[]) => {
    const p = rs.map((r) => r.position).filter((x): x is number => x !== null);
    return p.length ? (p.reduce((a, b) => a + b, 0) / p.length).toFixed(1) : "—";
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1">
          <Label htmlFor="rank-filter-location">Location</Label>
          <Select id="rank-filter-location" value={location} onChange={(e) => setLocation(e.target.value)} className="min-w-[220px]">
            <option value="">All locations ({rows.length})</option>
            {locations.map(([code, l]) => <option key={code} value={code}>{l.name} ({l.n})</option>)}
          </Select>
        </div>
        <label className="flex h-9 items-center gap-2 text-sm">
          <input type="checkbox" checked={group} onChange={(e) => setGroup(e.target.checked)} /> Group by location
        </label>
      </div>
      {notice && <p className="text-xs text-good-ink" role="status">{notice}</p>}
      {selected.size > 0 && <BulkBar clientId={clientId} ids={[...selected]} defaultLocation={defaultLocation} onDone={(m) => { setSelected(new Set()); setNotice(m); }} />}
      <div className="overflow-x-auto">
        <Table>
          <THead>
            <TR>
              <TH className="w-8"><input type="checkbox" aria-label="Select all shown" checked={allOn} onChange={toggleAll} /></TH>
              <TH>Keyword</TH>
              <TH>Location</TH>
              <TH>Device</TH>
              <TH className="text-right">Position</TH>
              <TH className="text-right">7 days</TH>
              <TH className="text-right">30 days</TH>
              <TH className="text-right">Best</TH>
              <TH>Ranking URL</TH>
              <TH>Last 30 days</TH>
              <TH>SERP features</TH>
            </TR>
          </THead>
          <TBody>
            {groups.map((g) => (
              group ? (
                <GroupRows key={g.code} name={g.name} summary={`${g.rows.length} item${g.rows.length === 1 ? "" : "s"} · avg position ${avg(g.rows)} · top 10: ${g.rows.filter((r) => r.position !== null && r.position <= 10).length}`}>
                  <Rows rows={g.rows} selected={selected} toggle={toggle} />
                </GroupRows>
              ) : <Rows key="all" rows={g.rows} selected={selected} toggle={toggle} />
            ))}
          </TBody>
        </Table>
      </div>
      {archived.length > 0 && (
        <details className="text-sm">
          <summary className="cursor-pointer text-text-2">Archived ({archived.length}): replaced or put away, history kept</summary>
          <ArchivedList clientId={clientId} items={archived} />
        </details>
      )}
    </div>
  );
}

function GroupRows({ name, summary, children }: { name: string; summary: string; children: React.ReactNode }) {
  return (
    <>
      <TR className="bg-surface-2">
        <TD colSpan={11} className="py-1.5"><span className="font-semibold">{name}</span> <span className="ml-2 text-xs text-text-2">{summary}</span></TD>
      </TR>
      {children}
    </>
  );
}

function ArchivedList({ clientId, items }: { clientId: string; items: ArchivedItem[] }) {
  const [state, action, pending] = useActionState(bulkKeywordAction.bind(null, clientId), undefined);
  const form = useFormSubmit(action);
  return (
    <form {...form} className="mt-2 flex flex-col gap-2">
      <input type="hidden" name="op" defaultValue="restore" />
      <ul className="max-h-64 divide-y divide-border overflow-y-auto rounded-md border border-border">
        {items.map((a) => (
          <li key={a.id} className="flex items-center gap-2 px-3 py-1.5">
            <input type="checkbox" name="ids" value={a.id} aria-label={`Select archived ${a.keyword} in ${a.locationName}`} />
            <span className="font-medium">{a.keyword}</span>
            <span className="text-text-2">{a.locationName} · {a.device}</span>
            <span className="ml-auto text-xs text-text-3">archived {a.archivedAt.slice(0, 10)}</span>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" size="sm" variant="outline" disabled={pending}>Restore selected</Button>
        {state?.ok && <span className="text-xs text-good-ink" role="status">{state.ok}</span>}
        {state?.errors?.map((e) => <span key={e} className="text-xs text-critical-ink" role="alert">{e}</span>)}
      </div>
    </form>
  );
}

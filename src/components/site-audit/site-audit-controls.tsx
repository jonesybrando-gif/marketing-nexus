"use client";

import { useActionState, useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Play, RefreshCw, Settings2, Square, X } from "lucide-react";
import { reanalyzeSiteAuditNow, runSiteAuditNow, saveSiteAuditConfig, stopSiteAuditNow, type SiteAuditFormState } from "@/app/(app)/clients/[id]/site-audit-actions";
import { useFormSubmit } from "@/components/use-form-submit";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { estimateAuditCost, lighthouseUrlCount, type OnPageRates } from "@/lib/site-audit/cost";
import { AUDIT_SCHEDULES, LIGHTHOUSE_MODES, MAX_PAGES_LIMIT } from "@/lib/site-audit/schedule";
import { CATEGORIES, CATEGORY_LABEL, SEVERITIES, SEVERITY_LABEL, type Category } from "@/lib/site-audit/issues";
import { WEEKDAYS } from "@/lib/report-schedule";
import type { AuditIssueLite } from "@/lib/dashboards/widget-data";
import { AuditIssueList, type AuditTarget } from "./audit-widgets";

const usd = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: n < 1 ? 3 : 2, maximumFractionDigits: n < 1 ? 3 : 2 });

function Status({ state }: { state: SiteAuditFormState }) {
  return (
    <>
      {state?.ok && <p className="text-xs text-good-ink" role="status">{state.ok}</p>}
      {state?.errors?.map((e) => <p key={e} className="text-xs text-critical-ink" role="alert">{e}</p>)}
    </>
  );
}

export interface AuditSettingsValue {
  targetUrl: string;
  schedule: string;
  dayOfWeek: number;
  dayOfMonth: number;
  maxPages: number;
  enableJs: boolean;
  lighthouse: string;
  active: boolean;
  ignorePatterns: string[];
}

/** The settings form: target URL, schedule, max pages, JavaScript rendering, Lighthouse; with a live cost estimate. */
export function AuditSettingsForm({ clientId, value, rates, onSaved }: { clientId: string; value: AuditSettingsValue; rates: OnPageRates; onSaved?: () => void }) {
  const [state, action, pending] = useActionState(saveSiteAuditConfig.bind(null, clientId), undefined);
  const form = useFormSubmit(action);
  const [schedule, setSchedule] = useState(value.schedule);
  const [maxPages, setMaxPages] = useState(value.maxPages);
  const [enableJs, setEnableJs] = useState(value.enableJs);
  const [lighthouse, setLighthouse] = useState(value.lighthouse);
  const estimate = estimateAuditCost({ maxPages: Number.isFinite(maxPages) ? maxPages : 0, enableJs, lighthouseUrls: lighthouseUrlCount(lighthouse) }, rates);
  const perMonth = schedule === "weekly" ? estimate * 4.35 : schedule === "monthly" ? estimate : 0;
  useEffect(() => { if (state?.ok) onSaved?.(); }, [state, onSaved]);
  return (
    <form {...form} className="flex flex-col gap-4" aria-label="Site audit settings">
      <div className="flex flex-col gap-1">
        <Label htmlFor="audit-url">Website</Label>
        <Input id="audit-url" name="targetUrl" defaultValue={value.targetUrl} placeholder="example.com" required />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1">
          <Label htmlFor="audit-schedule">How often</Label>
          <Select id="audit-schedule" name="schedule" value={schedule} onChange={(e) => setSchedule(e.target.value)}>
            {AUDIT_SCHEDULES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </Select>
        </div>
        {schedule === "weekly" && (
          <div className="flex flex-col gap-1">
            <Label htmlFor="audit-dow">On</Label>
            <Select id="audit-dow" name="dayOfWeek" defaultValue={value.dayOfWeek}>
              {WEEKDAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}
            </Select>
          </div>
        )}
        {schedule === "monthly" && (
          <div className="flex flex-col gap-1">
            <Label htmlFor="audit-dom">Day of the month</Label>
            <Select id="audit-dom" name="dayOfMonth" defaultValue={value.dayOfMonth}>
              {Array.from({ length: 28 }, (_, i) => <option key={i + 1} value={i + 1}>{i + 1}</option>)}
            </Select>
          </div>
        )}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1">
          <Label htmlFor="audit-pages">Pages per crawl (most)</Label>
          <Input id="audit-pages" name="maxPages" type="number" min={10} max={MAX_PAGES_LIMIT} step={10} value={Number.isFinite(maxPages) ? maxPages : ""} onChange={(e) => setMaxPages(e.target.valueAsNumber)} required />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="audit-lh">Page speed (Lighthouse)</Label>
          <Select id="audit-lh" name="lighthouse" value={lighthouse} onChange={(e) => setLighthouse(e.target.value)}>
            {LIGHTHOUSE_MODES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
          </Select>
        </div>
      </div>
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" name="enableJs" className="mt-0.5" checked={enableJs} onChange={(e) => setEnableJs(e.target.checked)} />
        <span>Render JavaScript <span className="block text-xs text-text-3">Only for sites built with JavaScript frameworks. Costs about {rates.javascriptFactor}× as much per page.</span></span>
      </label>
      <div className="flex flex-col gap-1">
        <Label htmlFor="audit-ignore">Ignore URLs (one pattern per line)</Label>
        <textarea
          id="audit-ignore"
          name="ignorePatterns"
          rows={3}
          defaultValue={value.ignorePatterns.join("\n")}
          placeholder={"/book?*\n/cart*"}
          className="w-full rounded-md border border-border bg-surface px-3 py-2 font-mono text-xs text-text placeholder:text-text-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
          aria-describedby="audit-ignore-help"
        />
        <span id="audit-ignore-help" className="text-xs text-text-3">Left out of the issues and score, e.g. pages noindexed on purpose. <code>*</code> matches anything: <code>/book?*</code> is every booking link. CDN and system paths such as Cloudflare&apos;s /cdn-cgi/ are always left out.</span>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" name="active" value="on" defaultChecked={value.active} /> Scheduled crawls on
      </label>
      <p className="rounded-md bg-surface-2 px-3 py-2 text-sm" aria-live="polite">
        Up to <span className="font-semibold tabular">{usd(estimate)}</span> per crawl{perMonth > 0 && <> · about <span className="tabular">{usd(perMonth)}</span>/month on this schedule</>}. Billed by DataForSEO; the agency&apos;s monthly cap applies.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" size="sm" disabled={pending}>{pending ? "Saving…" : "Save settings"}</Button>
        <Status state={state} />
      </div>
    </form>
  );
}

/** "Settings" button that opens the settings form in a side drawer. */
export function AuditSettingsDrawer(props: { clientId: string; value: AuditSettingsValue; rates: OnPageRates }) {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);
  return (
    <>
      <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)} aria-expanded={open}><Settings2 className="h-4 w-4" aria-hidden /> Settings</Button>
      {open && (
        <div className="fixed inset-0 z-40 flex justify-end bg-black/30" onClick={() => setOpen(false)}>
          <aside role="dialog" aria-modal="true" aria-label="Site audit settings" className="flex h-full w-full max-w-md flex-col gap-4 overflow-y-auto border-l border-border bg-surface p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold">Site audit settings</h2>
              <Button type="button" variant="ghost" size="icon" onClick={() => setOpen(false)} aria-label="Close settings"><X className="h-4 w-4" aria-hidden /></Button>
            </div>
            <AuditSettingsForm {...props} onSaved={() => router.refresh()} />
          </aside>
        </div>
      )}
    </>
  );
}

/** Admin: "Run audit now" with an inline confirmation that shows the estimate and what's left under the cap. */
export function RunAuditButton({ clientId, estimate, capLeft, disabled, disabledReason }: { clientId: string; estimate: number; capLeft: number; disabled?: boolean; disabledReason?: string }) {
  const [confirming, setConfirming] = useState(false);
  const [state, setState] = useState<SiteAuditFormState>(undefined);
  const [pending, start] = useTransition();
  const router = useRouter();
  // Keep the last message: after a start the page refreshes and the button turns disabled (a crawl is running).
  if (disabled) {
    return (
      <div className="flex flex-col items-end gap-1">
        <Button type="button" size="sm" disabled title={disabledReason}><Play className="h-4 w-4" aria-hidden /> Run audit now</Button>
        <Status state={state} />
      </div>
    );
  }
  return (
    <div className="flex flex-col items-end gap-1">
      {!confirming ? (
        <Button type="button" size="sm" onClick={() => { setConfirming(true); setState(undefined); }}><Play className="h-4 w-4" aria-hidden /> Run audit now</Button>
      ) : (
        <div className="flex max-w-sm flex-col gap-2 rounded-md border border-border bg-surface-2 p-3 text-sm" role="group" aria-label="Confirm crawl">
          <p>Crawl now for up to <span className="font-semibold">{usd(estimate)}</span>? {capLeft >= estimate ? <>That leaves about {usd(capLeft - estimate)} of this month&apos;s cap.</> : <span className="text-critical-ink">That&apos;s more than the {usd(Math.max(0, capLeft))} left in this month&apos;s cap, so it will be skipped.</span>}</p>
          <div className="flex gap-2">
            <Button type="button" size="sm" disabled={pending} onClick={() => start(async () => { const r = await runSiteAuditNow(clientId); setState(r); setConfirming(false); router.refresh(); })}>{pending ? "Starting…" : "Start crawl"}</Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setConfirming(false)}>Cancel</Button>
          </div>
        </div>
      )}
      <Status state={state} />
    </div>
  );
}

/** While a crawl runs, refreshes the page every 20 seconds so progress and results appear. */
export function AuditAutoRefresh({ active }: { active: boolean }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => router.refresh(), 20_000);
    return () => clearInterval(t);
  }, [active, router]);
  return null;
}

/** Issues grouped by severity with category and change filters; expand a row for how to fix it and example pages. */
export function AuditIssueTable({ rows, sampleUrls, targets, hasPrevious }: { rows: AuditIssueLite[]; sampleUrls: Record<string, string[]>; targets?: Record<string, AuditTarget[]>; hasPrevious: boolean }) {
  const [category, setCategory] = useState<"" | Category>("");
  const [change, setChange] = useState<"" | "new" | "fixed" | "worse">("");
  const visible = useMemo(() => rows.filter((r) => (!category || r.category === category) && (!change || r.change === change)), [rows, category, change]);
  const counts = (kind: string) => rows.filter((r) => r.change === kind).length;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1">
          <Label htmlFor="issue-cat">Category</Label>
          <Select id="issue-cat" value={category} onChange={(e) => setCategory(e.target.value as Category | "")} className="min-w-[180px]">
            <option value="">All categories</option>
            {CATEGORIES.map((c) => <option key={c} value={c}>{CATEGORY_LABEL[c]} ({rows.filter((r) => r.category === c && r.change !== "fixed").length})</option>)}
          </Select>
        </div>
        {hasPrevious && (
          <div className="flex flex-wrap gap-1" role="group" aria-label="Show">
            {([["", "All"], ["new", `New (${counts("new")})`], ["worse", `Worse (${counts("worse")})`], ["fixed", `Fixed (${counts("fixed")})`]] as const).map(([k, label]) => (
              <button key={k} type="button" aria-pressed={change === k} onClick={() => setChange(k)} className={`rounded-full border px-2.5 py-1 text-xs ${change === k ? "border-brand bg-brand/10 text-text" : "border-border text-text-2 hover:bg-surface-2"}`}>{label}</button>
            ))}
          </div>
        )}
      </div>
      {SEVERITIES.map((sev) => {
        const group = visible.filter((r) => r.severity === sev);
        if (!group.length) return null;
        return (
          <section key={sev} aria-label={SEVERITY_LABEL[sev]}>
            <h3 className="mb-1 text-sm font-semibold">{SEVERITY_LABEL[sev]} <span className="font-normal text-text-3">({group.filter((r) => r.change !== "fixed").length})</span></h3>
            <div className="rounded-md border border-border"><AuditIssueList rows={group} sampleUrls={sampleUrls} targets={targets} compact /></div>
          </section>
        );
      })}
      {!visible.length && <p className="text-sm text-text-3">No issues match.</p>}
    </div>
  );
}

/** Admin, while a crawl runs: stop it. The pages crawled so far are still analysed. */
export function StopCrawlButton({ clientId, stopping }: { clientId: string; stopping: boolean }) {
  const [state, setState] = useState<SiteAuditFormState>(undefined);
  const [pending, start] = useTransition();
  const router = useRouter();
  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={pending || stopping}
        onClick={() => {
          if (!window.confirm("Stop this crawl? The pages crawled so far are still analysed, and DataForSEO refunds the rest.")) return;
          start(async () => { setState(await stopSiteAuditNow(clientId)); router.refresh(); });
        }}
      >
        <Square className="h-3.5 w-3.5" aria-hidden /> {stopping ? "Stopping…" : pending ? "Stopping…" : "Stop crawl"}
      </Button>
      <Status state={state} />
    </div>
  );
}

/** Admin: re-check the latest crawl with the current rules and ignore patterns (free, no new crawl). */
export function ReanalyzeButton({ clientId, outdated }: { clientId: string; outdated: boolean }) {
  const [state, setState] = useState<SiteAuditFormState>(undefined);
  const [pending, start] = useTransition();
  const router = useRouter();
  return (
    <div className="flex flex-col items-start gap-1">
      <Button type="button" size="sm" variant={outdated ? "default" : "outline"} disabled={pending} onClick={() => start(async () => { setState(await reanalyzeSiteAuditNow(clientId)); router.refresh(); })}>
        <RefreshCw className={`h-3.5 w-3.5 ${pending ? "animate-spin" : ""}`} aria-hidden /> {pending ? "Re-checking…" : "Re-check with current settings"}
      </Button>
      <Status state={state} />
    </div>
  );
}

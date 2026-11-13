// Pure mapping from CallRail calls / form submissions to daily MetricDaily rows.
import { eachDay, type IsoDate } from "@/lib/pacing/dates";
import type { MetricRow } from "../types";

export interface CallRailCall {
  id?: string;
  start_time: string; // ISO 8601 with offset, e.g. "2026-10-01T23:30:00.000-07:00"
  answered?: boolean | null;
  voicemail?: boolean | null;
  duration?: number | null;
  first_call?: boolean | null;
  lead_status?: string | null;
  source?: string | null;
  source_name?: string | null;
  campaign?: string | null;
  keywords?: string | null;
  tracking_phone_number?: string | null;
  company_time_zone?: string | null;
  medium?: string | null;
  landing_page_url?: string | null;
  tags?: ({ name?: string | null } | string)[] | null;
  /** Lead value set in CallRail, e.g. "250.00" or "$250.00". */
  value?: string | number | null;
  customer_name?: string | null;
  customer_phone_number?: string | null;
  customer_city?: string | null;
  customer_state?: string | null;
  recording_player?: string | null;
}

export interface CallRailFormSubmission {
  id?: string;
  submitted_at: string;
  source?: string | null;
  form_url?: string | null;
  referrer?: string | null;
  referring_url?: string | null;
  first_form?: boolean | null;
  customer_name?: string | null;
  formatted_customer_name?: string | null;
  lead_status?: string | null;
  value?: string | number | null;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}/;

function validTimeZone(tz: string | null | undefined): tz is string {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Local calendar date of an ISO timestamp in `timeZone`. Without a usable time
 * zone, falls back to the date as written (CallRail writes times in the
 * company's own time zone).
 */
export function localDate(iso: string, timeZone?: string | null): IsoDate | null {
  if (typeof iso !== "string") return null;
  const t = Date.parse(iso);
  if (validTimeZone(timeZone) && Number.isFinite(t)) {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(t));
    const get = (k: string) => parts.find((p) => p.type === k)?.value ?? "";
    return `${get("year")}-${get("month")}-${get("day")}`;
  }
  return ISO_DATE.test(iso) ? iso.slice(0, 10) : null;
}

/** Missed = not answered, or went to voicemail. Answered is the complement, so answered + missed = calls. */
export function isAnswered(c: Pick<CallRailCall, "answered" | "voicemail">): boolean {
  return c.answered === true && c.voicemail !== true;
}

const clean = (s: string | null | undefined) => (typeof s === "string" ? s.trim() : "");

/** Campaign label: CallRail campaign, else the tracker (tracking number) name, else the tracking number. */
export function campaignOf(c: CallRailCall): string {
  return clean(c.campaign) || clean(c.source_name) || clean(c.tracking_phone_number) || "(none)";
}

class Acc {
  private m = new Map<string, MetricRow>();
  add(date: IsoDate, metric: string, value: number, dimension = "", dimensionValue = "") {
    const k = `${date}|${metric}|${dimension}|${dimensionValue}`;
    const row = this.m.get(k);
    if (row) row.value += value;
    else this.m.set(k, { date, metric, value, dimension, dimensionValue });
  }
  rows(): MetricRow[] {
    return [...this.m.values()];
  }
}

const CALL_TOTALS = ["callrail.calls", "callrail.answered", "callrail.missed", "callrail.voicemails", "callrail.firstTimeCallers", "callrail.leads", "callrail.durationSeconds", "callrail.value"];

const WEEKDAYS = ["1 Mon", "2 Tue", "3 Wed", "4 Thu", "5 Fri", "6 Sat", "7 Sun"];

/** Local weekday ("1 Mon"…"7 Sun", sortable) and hour ("09:00") of a call in `timeZone`. */
export function localWeekdayHour(iso: string, timeZone?: string | null): { weekday: string; hour: string } | null {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const tz = validTimeZone(timeZone) ? timeZone : undefined;
  if (!tz) {
    // No zone: read the wall-clock time as written in the timestamp.
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})/.exec(iso);
    if (!m) return null;
    const day = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).getUTCDay();
    return { weekday: WEEKDAYS[(day + 6) % 7], hour: `${m[4]}:00` };
  }
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", hour: "2-digit", hourCycle: "h23" }).formatToParts(new Date(t));
  const wd = parts.find((p) => p.type === "weekday")?.value ?? "";
  const hr = parts.find((p) => p.type === "hour")?.value ?? "";
  const idx = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(wd);
  return idx < 0 ? null : { weekday: WEEKDAYS[idx], hour: `${hr.padStart(2, "0")}:00` };
}

/** Lead value in cents ("$1,250.00" → 125000); 0 when missing or unreadable. */
export function valueCents(v: CallRailCall["value"]): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v.replace(/[^0-9.-]/g, "")) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : 0;
}

/** Landing page without scheme, query or trailing slash, e.g. "example.com/implants". */
export function landingPageOf(url: string | null | undefined): string {
  const u = clean(url);
  if (!u) return "";
  return u.replace(/^https?:\/\/(www\.)?/i, "").replace(/[?#].*$/, "").replace(/\/$/, "").slice(0, 300);
}

export function tagNames(tags: CallRailCall["tags"]): string[] {
  if (!Array.isArray(tags)) return [];
  return tags.map((t) => (typeof t === "string" ? t : t?.name ?? "")).map((t) => t.trim()).filter(Boolean).slice(0, 20);
}

/**
 * Bucket calls by local date in `timeZone` (dates outside [from, to] are
 * dropped). Every day in the window gets total rows, so a quiet day reads 0
 * rather than "no data".
 */
export function callsToRows(calls: CallRailCall[], opts: { timeZone?: string | null; from: IsoDate; to: IsoDate }): MetricRow[] {
  const acc = new Acc();
  for (const d of eachDay(opts.from, opts.to)) for (const m of CALL_TOTALS) acc.add(d, m, 0);
  const seen = new Set<string>();
  for (const c of calls) {
    if (c.id) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
    }
    const date = localDate(c.start_time, opts.timeZone);
    if (!date || date < opts.from || date > opts.to) continue;
    const answered = isAnswered(c);
    const first = c.first_call === true;
    const lead = c.lead_status === "good_lead";
    const duration = answered && typeof c.duration === "number" && c.duration > 0 ? c.duration : 0;

    const voicemail = c.voicemail === true;
    const value = valueCents(c.value);
    acc.add(date, "callrail.calls", 1);
    acc.add(date, "callrail.answered", answered ? 1 : 0);
    acc.add(date, "callrail.missed", answered ? 0 : 1);
    acc.add(date, "callrail.voicemails", voicemail ? 1 : 0);
    acc.add(date, "callrail.firstTimeCallers", first ? 1 : 0);
    acc.add(date, "callrail.leads", lead ? 1 : 0);
    acc.add(date, "callrail.durationSeconds", duration);
    acc.add(date, "callrail.value", value);

    const when = localWeekdayHour(c.start_time, opts.timeZone);
    const dims: [string, string][] = [
      ["source", clean(c.source) || "(unknown)"],
      ["campaign", campaignOf(c)],
      ["medium", clean(c.medium) || "(none)"],
    ];
    const keyword = clean(c.keywords);
    if (keyword) dims.push(["keyword", keyword]);
    const page = landingPageOf(c.landing_page_url);
    if (page) dims.push(["landingPage", page]);
    const city = [clean(c.customer_city), clean(c.customer_state)].filter(Boolean).join(", ");
    if (city) dims.push(["city", city]);
    if (when) dims.push(["weekday", when.weekday], ["hour", when.hour]);
    const tracking = clean(c.tracking_phone_number);
    if (tracking) dims.push(["trackingNumber", tracking]);
    for (const tag of tagNames(c.tags)) dims.push(["tag", tag]);
    dims.push(["status", answered ? "Answered" : "Missed"]);
    for (const [dim, val] of dims) {
      acc.add(date, "callrail.calls", 1, dim, val);
      acc.add(date, "callrail.answered", answered ? 1 : 0, dim, val);
      acc.add(date, "callrail.missed", answered ? 0 : 1, dim, val);
      acc.add(date, "callrail.firstTimeCallers", first ? 1 : 0, dim, val);
      acc.add(date, "callrail.leads", lead ? 1 : 0, dim, val);
      acc.add(date, "callrail.durationSeconds", duration, dim, val);
      if (value) acc.add(date, "callrail.value", value, dim, val);
    }
  }
  return acc.rows();
}

export function formsToRows(forms: CallRailFormSubmission[], opts: { timeZone?: string | null; from: IsoDate; to: IsoDate }): MetricRow[] {
  const acc = new Acc();
  for (const d of eachDay(opts.from, opts.to)) for (const m of ["callrail.forms", "callrail.firstForms", "callrail.formLeads", "callrail.formValue"]) acc.add(d, m, 0);
  const seen = new Set<string>();
  for (const f of forms) {
    if (f.id) {
      if (seen.has(f.id)) continue;
      seen.add(f.id);
    }
    const date = localDate(f.submitted_at, opts.timeZone);
    if (!date || date < opts.from || date > opts.to) continue;
    const source = clean(f.source) || "(unknown)";
    const first = f.first_form === true;
    const lead = f.lead_status === "good_lead";
    const value = valueCents(f.value);
    acc.add(date, "callrail.forms", 1);
    acc.add(date, "callrail.firstForms", first ? 1 : 0);
    acc.add(date, "callrail.formLeads", lead ? 1 : 0);
    acc.add(date, "callrail.formValue", value);
    acc.add(date, "callrail.forms", 1, "source", source);
    acc.add(date, "callrail.firstForms", first ? 1 : 0, "source", source);
    acc.add(date, "callrail.formLeads", lead ? 1 : 0, "source", source);
  }
  return acc.rows();
}

/** One call as stored for call logs. */
export interface CallRecordRow {
  externalId: string;
  startedAt: Date;
  date: IsoDate;
  callerName: string | null;
  callerNumber: string | null;
  city: string | null;
  state: string | null;
  source: string | null;
  medium: string | null;
  campaign: string | null;
  keyword: string | null;
  landingPage: string | null;
  trackingNumber: string | null;
  durationSec: number;
  answered: boolean;
  voicemail: boolean;
  firstCall: boolean;
  leadStatus: string | null;
  tags: string[];
  recordingUrl: string | null;
}

const opt = (s: string | null | undefined, max = 200) => clean(s).slice(0, max) || null;

/** Calls in [from, to] (local dates) as call-log records; calls without an id are skipped. */
export function callsToRecords(calls: CallRailCall[], opts: { timeZone?: string | null; from: IsoDate; to: IsoDate }): CallRecordRow[] {
  const out = new Map<string, CallRecordRow>();
  for (const c of calls) {
    const id = c.id == null ? "" : String(c.id);
    if (!id || out.has(id)) continue;
    const date = localDate(c.start_time, opts.timeZone);
    const t = Date.parse(c.start_time);
    if (!date || date < opts.from || date > opts.to || !Number.isFinite(t)) continue;
    const rec = clean(c.recording_player);
    out.set(id, {
      externalId: id,
      startedAt: new Date(t),
      date,
      callerName: opt(c.customer_name),
      callerNumber: opt(c.customer_phone_number, 40),
      city: opt(c.customer_city, 100),
      state: opt(c.customer_state, 50),
      source: opt(c.source),
      medium: opt(c.medium),
      campaign: campaignOf(c) === "(none)" ? null : campaignOf(c).slice(0, 200),
      keyword: opt(c.keywords, 300),
      landingPage: landingPageOf(c.landing_page_url) || null,
      trackingNumber: opt(c.tracking_phone_number, 40),
      durationSec: typeof c.duration === "number" && c.duration > 0 ? Math.round(c.duration) : 0,
      answered: isAnswered(c),
      voicemail: c.voicemail === true,
      firstCall: c.first_call === true,
      leadStatus: opt(c.lead_status, 40),
      tags: tagNames(c.tags),
      recordingUrl: /^https:\/\/[a-z0-9.-]*callrail\.com\//i.test(rec) ? rec.slice(0, 500) : null,
    });
  }
  return [...out.values()];
}

/** One form submission as stored for form logs. */
export interface FormRecordRow {
  externalId: string;
  submittedAt: Date;
  date: IsoDate;
  name: string | null;
  formUrl: string | null;
  referrer: string | null;
  referringUrl: string | null;
  firstForm: boolean;
  leadStatus: string | null;
}

/** Form submissions in [from, to] (local dates) as form-log records; ones without an id are skipped. */
export function formsToRecords(forms: CallRailFormSubmission[], opts: { timeZone?: string | null; from: IsoDate; to: IsoDate }): FormRecordRow[] {
  const out = new Map<string, FormRecordRow>();
  for (const f of forms) {
    const id = f.id == null ? "" : String(f.id);
    if (!id || out.has(id)) continue;
    const date = localDate(f.submitted_at, opts.timeZone);
    const t = Date.parse(f.submitted_at);
    if (!date || date < opts.from || date > opts.to || !Number.isFinite(t)) continue;
    out.set(id, {
      externalId: id,
      submittedAt: new Date(t),
      date,
      name: opt(f.formatted_customer_name) ?? opt(f.customer_name),
      formUrl: landingPageOf(f.form_url) || null,
      referrer: opt(f.source) ?? opt(f.referrer),
      referringUrl: opt(f.referring_url, 500),
      firstForm: f.first_form === true,
      leadStatus: opt(f.lead_status, 40),
    });
  }
  return [...out.values()];
}

// Render-ready data for one dashboard widget, produced on the server by
// src/server/dashboards/data.ts and passed to client components. Plain JSON.

import type { Verdict } from "@/lib/change";
import type { MetricSource } from "@/lib/metrics-registry";
import type { MetricInfo, Tone } from "./metrics";

export interface KeywordRankRow {
  keyword: string;
  /** Latest position in the range (null = not ranking in the tracked depth). */
  position: number | null;
  /** Position at the end of the comparison period. */
  previous: number | null;
  url?: string | null;
  searchVolume?: number | null;
  location?: string | null;
}

/** One call in a call log widget (CallRail). */
export interface CallLogRow {
  id: string;
  /** ISO timestamp. */
  startedAt: string;
  callerName: string | null;
  callerNumber: string | null;
  location: string | null;
  source: string | null;
  campaign: string | null;
  keyword: string | null;
  durationSec: number;
  status: "answered" | "missed" | "voicemail";
  firstCall: boolean;
  lead: boolean;
  tags: string[];
  /** Staff only. */
  recordingUrl: string | null;
}

/** One form submission in a form log widget (CallRail form tracking). */
export interface FormLogRow {
  id: string;
  submittedAt: string;
  name: string | null;
  formUrl: string | null;
  referrer: string | null;
  referringUrl: string | null;
  firstForm: boolean;
  lead: boolean;
}

export type WidgetData =
  | { kind: "kpi"; metric: MetricInfo; value: number | null; previous: number | null; changePct: number | null; tone: Tone | null; verdict?: Verdict | null; spark: (number | null)[]; hasComparison: boolean; /** "previous period", "previous month"… */ vsLabel?: string }
  | { kind: "series"; metrics: MetricInfo[]; dates: string[]; current: Record<string, (number | null)[]>; previous: Record<string, (number | null)[]> | null; previousDates: string[] | null }
  | { kind: "breakdown"; metrics: MetricInfo[]; dimensionLabel: string; rows: { label: string; values: Record<string, number | null> }[] }
  | { kind: "rankings"; rows: KeywordRankRow[]; hasComparison: boolean }
  | { kind: "calllog"; rows: CallLogRow[]; total: number; timeZone: string | null }
  | { kind: "formlog"; rows: FormLogRow[]; total: number; timeZone: string | null }
  | { kind: "text" }
  | { kind: "pacing" }
  | { kind: "campaigns" }
  | { kind: "empty"; reason: "not_connected" | "no_data" | "unknown_metric"; source: MetricSource | null; message: string };

export type DashboardData = Record<string, WidgetData>;

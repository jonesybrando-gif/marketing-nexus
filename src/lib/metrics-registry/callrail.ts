// CallRail call-tracking metrics. Stored daily per CallRail company, bucketed
// by the company's time zone (src/server/data-sources/callrail/metrics.ts).
// Covers what agency reporting tools (e.g. AgencyAnalytics) show for CallRail:
// calls, answered/missed, voicemails, first-time callers, durations, leads,
// value, forms, and calls by source, medium, campaign, keyword, landing page,
// caller city, tag, weekday and hour. Individual calls (the call log) live in
// CallRecord.
import type { DimensionDef, MetricDef } from "./types";

const ALL_DIMS = ["source", "medium", "campaign", "trackingNumber", "keyword", "landingPage", "city", "tag", "weekday", "hour", "status"];

export const metrics: MetricDef[] = [
  { key: "callrail.calls", source: "callrail", label: "Calls", format: "count", aggregation: "sum", better: "up", description: "Tracked phone calls (CallRail).", dimensions: ALL_DIMS },
  { key: "callrail.answered", source: "callrail", label: "Answered calls", short: "Answered", format: "count", aggregation: "sum", better: "up", description: "Calls that were answered (not missed and not sent to voicemail).", dimensions: ALL_DIMS },
  { key: "callrail.missed", source: "callrail", label: "Missed calls", short: "Missed", format: "count", aggregation: "sum", better: "down", description: "Calls that weren't answered or went to voicemail.", dimensions: ALL_DIMS },
  { key: "callrail.voicemails", source: "callrail", label: "Voicemails", format: "count", aggregation: "sum", better: "down", description: "Calls that went to voicemail." },
  { key: "callrail.answerRate", source: "callrail", label: "Answer rate", format: "pct", aggregation: "weighted", ratioOf: { numerator: "callrail.answered", denominator: "callrail.calls" }, better: "up", description: "Answered calls as a share of all calls.", dimensions: ALL_DIMS },
  { key: "callrail.missRate", source: "callrail", label: "Miss rate", format: "pct", aggregation: "weighted", ratioOf: { numerator: "callrail.missed", denominator: "callrail.calls" }, better: "down", description: "Missed calls (unanswered or voicemail) as a share of all calls.", dimensions: ALL_DIMS },
  { key: "callrail.firstTimeCallers", source: "callrail", label: "First-time callers", short: "First-time", format: "count", aggregation: "sum", better: "up", description: "Calls from numbers calling the company for the first time.", dimensions: ALL_DIMS },
  { key: "callrail.newCallerRate", source: "callrail", label: "New caller rate", short: "New rate", format: "pct", aggregation: "weighted", ratioOf: { numerator: "callrail.firstTimeCallers", denominator: "callrail.calls" }, better: "up", description: "First-time callers as a share of all calls.", dimensions: ALL_DIMS },
  { key: "callrail.leads", source: "callrail", label: "Qualified calls", short: "Qualified", format: "count", aggregation: "sum", better: "up", description: "Calls marked as a good lead in CallRail (lead status). Other calls aren't counted as leads.", dimensions: ALL_DIMS },
  { key: "callrail.callsPerLead", source: "callrail", label: "Calls per qualified call", format: "ratio", aggregation: "weighted", ratioOf: { numerator: "callrail.calls", denominator: "callrail.leads" }, better: "down", description: "Calls for every call marked as a good lead.", dimensions: ALL_DIMS },
  { key: "callrail.durationSeconds", source: "callrail", label: "Total talk time", short: "Talk time", format: "duration", aggregation: "sum", better: "neutral", description: "Total duration of answered calls.", dimensions: ALL_DIMS },
  { key: "callrail.avgDuration", source: "callrail", label: "Avg call duration", short: "Avg duration", format: "duration", aggregation: "weighted", ratioOf: { numerator: "callrail.durationSeconds", denominator: "callrail.answered" }, better: "neutral", description: "Average duration of answered calls.", dimensions: ALL_DIMS },
  { key: "callrail.value", source: "callrail", label: "Lead value", short: "Value", format: "money", aggregation: "sum", better: "up", description: "Value assigned to calls in CallRail.", dimensions: ALL_DIMS },
  { key: "callrail.forms", source: "callrail", label: "Form submissions", short: "Submissions", format: "count", aggregation: "sum", better: "up", description: "Form submissions tracked by CallRail form tracking (when enabled).", dimensions: ["source"] },
  { key: "callrail.firstForms", source: "callrail", label: "First-time submissions", short: "First-time", format: "count", aggregation: "sum", better: "up", description: "Form submissions from people submitting for the first time.", dimensions: ["source"] },
  { key: "callrail.formLeads", source: "callrail", label: "Form leads", short: "Leads", format: "count", aggregation: "sum", better: "up", description: "Form submissions marked as a good lead in CallRail.", dimensions: ["source"] },
  { key: "callrail.formValue", source: "callrail", label: "Quoted total (forms)", short: "Quoted", format: "money", aggregation: "sum", better: "up", description: "Value assigned to form submissions in CallRail." },
];

export const dimensions: DimensionDef[] = [
  { key: "callrail.source", source: "callrail", dimension: "source", label: "Call source" },
  { key: "callrail.medium", source: "callrail", dimension: "medium", label: "Medium" },
  { key: "callrail.campaign", source: "callrail", dimension: "campaign", label: "Campaign / tracking number" },
  { key: "callrail.trackingNumber", source: "callrail", dimension: "trackingNumber", label: "Tracking number" },
  { key: "callrail.keyword", source: "callrail", dimension: "keyword", label: "Keyword" },
  { key: "callrail.landingPage", source: "callrail", dimension: "landingPage", label: "Landing page" },
  { key: "callrail.city", source: "callrail", dimension: "city", label: "Caller city" },
  { key: "callrail.tag", source: "callrail", dimension: "tag", label: "Tag" },
  { key: "callrail.weekday", source: "callrail", dimension: "weekday", label: "Day of week", ordered: true },
  { key: "callrail.hour", source: "callrail", dimension: "hour", label: "Hour of day", ordered: true },
  { key: "callrail.status", source: "callrail", dimension: "status", label: "Answered vs missed" },
];

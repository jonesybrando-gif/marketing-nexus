import type { DashboardTemplateDef } from "./index";

/**
 * Call tracking report laid out like AgencyAnalytics' CallRail pages:
 * answered vs missed, top sources and the call trend; the six call tiles; the
 * call table (date, name, source, phone, answered, first call, keywords,
 * campaign, recording). Then deeper breakdowns, and the Forms section
 * (top referrers, submissions trend, form tiles and the submissions table).
 */
export const callrailTemplate: DashboardTemplateDef = {
  key: "callrail-calls",
  name: "Calls (CallRail)",
  description: "Answered vs missed, top sources, call trend and tiles, the call log with recordings, breakdowns by campaign, keyword, page, city, day and hour, and form submissions.",
  sources: ["callrail"],
  widgets: [
    { id: "cr-status-pie", kind: "pie", title: "Answered vs missed calls", dimension: "status", metrics: ["callrail.calls"], x: 0, y: 0, w: 4, h: 5 },
    { id: "cr-top-sources", kind: "bar", title: "Top sources", dimension: "source", metrics: ["callrail.calls"], x: 4, y: 0, w: 4, h: 5 },
    { id: "cr-calls-trend", kind: "line", title: "Calls", metrics: ["callrail.calls"], x: 8, y: 0, w: 4, h: 5 },
    { id: "cr-calls", kind: "kpi", metrics: ["callrail.calls"], x: 0, y: 5, w: 2, h: 2 },
    { id: "cr-answered", kind: "kpi", metrics: ["callrail.answered"], x: 2, y: 5, w: 2, h: 2 },
    { id: "cr-missed", kind: "kpi", metrics: ["callrail.missed"], x: 4, y: 5, w: 2, h: 2 },
    { id: "cr-first-time", kind: "kpi", title: "First time calls", metrics: ["callrail.firstTimeCallers"], x: 6, y: 5, w: 2, h: 2 },
    { id: "cr-leads", kind: "kpi", title: "Qualified calls", metrics: ["callrail.leads"], x: 8, y: 5, w: 2, h: 2 },
    { id: "cr-avg-duration", kind: "kpi", title: "Avg duration", metrics: ["callrail.avgDuration"], x: 10, y: 5, w: 2, h: 2 },
    { id: "cr-call-log", kind: "calllog", title: "Calls", x: 0, y: 7, w: 12, h: 8 },

    { id: "cr-more-heading", kind: "text", text: "## Call details", x: 0, y: 15, w: 12, h: 1 },
    { id: "cr-answer-rate", kind: "kpi", metrics: ["callrail.answerRate"], x: 0, y: 16, w: 2, h: 2 },
    { id: "cr-miss-rate", kind: "kpi", metrics: ["callrail.missRate"], x: 2, y: 16, w: 2, h: 2 },
    { id: "cr-voicemails", kind: "kpi", metrics: ["callrail.voicemails"], x: 4, y: 16, w: 2, h: 2 },
    { id: "cr-new-rate", kind: "kpi", metrics: ["callrail.newCallerRate"], x: 6, y: 16, w: 2, h: 2 },
    { id: "cr-talk-time", kind: "kpi", metrics: ["callrail.durationSeconds"], x: 8, y: 16, w: 2, h: 2 },
    { id: "cr-value", kind: "kpi", metrics: ["callrail.value"], x: 10, y: 16, w: 2, h: 2 },
    { id: "cr-answered-missed-line", kind: "line", title: "Answered vs missed over time", metrics: ["callrail.answered", "callrail.missed"], x: 0, y: 18, w: 12, h: 4 },
    { id: "cr-source-table", kind: "table", title: "Calls by source", dimension: "source", metrics: ["callrail.calls", "callrail.answered", "callrail.missed", "callrail.answerRate", "callrail.firstTimeCallers", "callrail.avgDuration"], x: 0, y: 22, w: 8, h: 5 },
    { id: "cr-medium-pie", kind: "pie", title: "Calls by medium", dimension: "medium", metrics: ["callrail.calls"], x: 8, y: 22, w: 4, h: 5 },
    { id: "cr-campaign-table", kind: "table", title: "Calls by campaign / tracking number", dimension: "campaign", metrics: ["callrail.calls", "callrail.answered", "callrail.missed", "callrail.answerRate", "callrail.firstTimeCallers", "callrail.leads"], x: 0, y: 27, w: 12, h: 5 },
    { id: "cr-keyword-table", kind: "table", title: "Calls by keyword", dimension: "keyword", metrics: ["callrail.calls", "callrail.answered", "callrail.firstTimeCallers"], x: 0, y: 32, w: 6, h: 5 },
    { id: "cr-landing-table", kind: "table", title: "Calls by landing page", dimension: "landingPage", metrics: ["callrail.calls", "callrail.answered", "callrail.firstTimeCallers"], x: 6, y: 32, w: 6, h: 5 },
    { id: "cr-city-table", kind: "table", title: "Calls by caller city", dimension: "city", metrics: ["callrail.calls", "callrail.firstTimeCallers"], x: 0, y: 37, w: 4, h: 5 },
    { id: "cr-weekday-bar", kind: "bar", title: "Calls by day of week", dimension: "weekday", metrics: ["callrail.calls"], x: 4, y: 37, w: 4, h: 5 },
    { id: "cr-hour-bar", kind: "bar", title: "Calls by hour of day", dimension: "hour", metrics: ["callrail.calls"], x: 8, y: 37, w: 4, h: 5 },

    { id: "cr-tracking-table", kind: "table", title: "Calls by tracking number", dimension: "trackingNumber", metrics: ["callrail.calls", "callrail.answered", "callrail.missed", "callrail.firstTimeCallers", "callrail.leads"], x: 0, y: 42, w: 12, h: 5 },

    { id: "cr-forms-heading", kind: "text", text: "## Forms", x: 0, y: 47, w: 12, h: 1 },
    { id: "cr-top-referrers", kind: "bar", title: "Top referrers", dimension: "source", metrics: ["callrail.forms"], x: 0, y: 48, w: 4, h: 5 },
    { id: "cr-submissions-trend", kind: "line", title: "Submissions", metrics: ["callrail.forms"], x: 4, y: 48, w: 8, h: 5 },
    { id: "cr-first-forms", kind: "kpi", title: "First time submissions", metrics: ["callrail.firstForms"], x: 0, y: 53, w: 3, h: 2 },
    { id: "cr-forms", kind: "kpi", title: "Submissions", metrics: ["callrail.forms"], x: 3, y: 53, w: 3, h: 2 },
    { id: "cr-form-leads", kind: "kpi", title: "Leads", metrics: ["callrail.formLeads"], x: 6, y: 53, w: 3, h: 2 },
    { id: "cr-quoted", kind: "kpi", title: "Quoted total", metrics: ["callrail.formValue"], x: 9, y: 53, w: 3, h: 2 },
    { id: "cr-form-log", kind: "formlog", title: "Form submissions", x: 0, y: 55, w: 12, h: 6 },
  ],
};

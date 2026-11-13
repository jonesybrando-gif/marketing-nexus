import type { DashboardWidget, WidgetKind } from "./types";
import { dimensionLabel, metricInfo, sourceOf } from "./metrics";

export const KIND_LABEL: Record<WidgetKind, string> = {
  kpi: "Number",
  line: "Line chart",
  area: "Area chart",
  bar: "Bar chart",
  table: "Table",
  pie: "Donut chart",
  rankings: "Keyword rankings",
  calllog: "Call log",
  formlog: "Form log",
  text: "Text",
  pacing: "Budget pacing",
  campaigns: "Campaigns table",
};

/** The widget's title, or a sensible one from its metrics and breakdown. */
export function widgetTitle(w: Pick<DashboardWidget, "kind" | "title" | "metrics" | "dimension">): string {
  if (w.title) return w.title;
  const labels = (w.metrics ?? []).map((k) => metricInfo(k)?.label ?? k);
  switch (w.kind) {
    case "kpi":
      return labels[0] ?? "KPI";
    case "line":
    case "area":
    case "bar":
      if (w.dimension) return `${labels[0] ?? "Metric"} by ${dimensionLabel(sourceOf(w.metrics?.[0] ?? ""), w.dimension).toLowerCase()}`;
      return labels.join(", ") || KIND_LABEL[w.kind];
    case "table":
    case "pie":
      return w.dimension ? `${labels[0] ?? "Metric"} by ${dimensionLabel(sourceOf(w.metrics?.[0] ?? ""), w.dimension).toLowerCase()}` : labels[0] ?? KIND_LABEL[w.kind];
    case "rankings":
      return "Keyword rankings";
    case "calllog":
      return "Call log";
    case "formlog":
      return "Form submissions";
    case "text":
      return "";
    case "pacing":
      return "Budget pacing";
    case "campaigns":
      return "Campaigns";
  }
}

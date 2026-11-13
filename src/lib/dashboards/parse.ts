// Validation for Dashboard.widgets. Pure (no DB), so it is unit-tested and
// shared by the save action, template application and the editor.

import type { RangePreset } from "@/lib/date-ranges";
import type { DashboardWidget, WidgetKind } from "./types";
import { isKnownMetric, sourceOf } from "./metrics";

export const GRID_COLS = 12;
export const MAX_WIDGETS = 100;
export const MAX_ROWS = 400;
export const MAX_H = 16;
export const MAX_TEXT = 5000;
export const MAX_TITLE = 120;

export const WIDGET_KINDS: WidgetKind[] = ["kpi", "line", "area", "bar", "table", "pie", "rankings", "calllog", "formlog", "text", "pacing", "campaigns"];

/** Kinds that chart or tabulate metrics, and how many metrics each takes. */
export const METRIC_LIMITS: Partial<Record<WidgetKind, { min: number; max: number }>> = {
  kpi: { min: 1, max: 1 },
  line: { min: 1, max: 3 },
  area: { min: 1, max: 3 },
  bar: { min: 1, max: 3 },
  table: { min: 1, max: 6 },
  pie: { min: 1, max: 1 },
};

/** Smallest sensible size per kind (w columns × h rows). */
export const MIN_SIZE: Record<WidgetKind, { w: number; h: number }> = {
  kpi: { w: 2, h: 2 },
  line: { w: 3, h: 3 },
  area: { w: 3, h: 3 },
  bar: { w: 3, h: 3 },
  table: { w: 3, h: 3 },
  pie: { w: 3, h: 3 },
  rankings: { w: 4, h: 3 },
  calllog: { w: 6, h: 4 },
  formlog: { w: 6, h: 4 },
  text: { w: 2, h: 1 },
  pacing: { w: 6, h: 4 },
  campaigns: { w: 6, h: 4 },
};

/** Size a new widget starts at. */
export const DEFAULT_SIZE: Record<WidgetKind, { w: number; h: number }> = {
  kpi: { w: 2, h: 2 },
  line: { w: 6, h: 4 },
  area: { w: 6, h: 4 },
  bar: { w: 6, h: 4 },
  table: { w: 6, h: 5 },
  pie: { w: 4, h: 4 },
  rankings: { w: 6, h: 5 },
  calllog: { w: 12, h: 8 },
  formlog: { w: 12, h: 6 },
  text: { w: 4, h: 2 },
  pacing: { w: 12, h: 6 },
  campaigns: { w: 12, h: 7 },
};

const RANGE_PRESETS: RangePreset[] = ["mtd", "last_month", "last_7", "last_30", "last_90"];
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const DIM_RE = /^[A-Za-z0-9_.:-]{1,64}$/;

export type ParseResult = { ok: true; widgets: DashboardWidget[] } | { ok: false; error: string };

export interface ParseOptions {
  /** Whether a metric key exists. Defaults to the ad KPI catalogue plus the metric registry. */
  isKnownMetric?: (key: string) => boolean;
}

const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);

/**
 * Strictly validates widgets for saving: at most 100, unique ids, known kinds
 * and metrics, and every widget inside the 12-column grid. Returns clean
 * copies (unknown fields dropped).
 */
export function parseWidgets(input: unknown, opts: ParseOptions = {}): ParseResult {
  const known = opts.isKnownMetric ?? isKnownMetric;
  if (!Array.isArray(input)) return { ok: false, error: "Widgets must be a list." };
  if (input.length > MAX_WIDGETS) return { ok: false, error: `A dashboard can have at most ${MAX_WIDGETS} widgets.` };
  const out: DashboardWidget[] = [];
  const ids = new Set<string>();
  for (let i = 0; i < input.length; i++) {
    const raw = input[i] as Record<string, unknown> | null;
    const where = `Widget ${i + 1}`;
    if (!raw || typeof raw !== "object") return { ok: false, error: `${where} is not valid.` };
    const { id, kind, title, metrics, dimension, text, range, hideChange, x, y, w, h } = raw;
    if (typeof id !== "string" || !ID_RE.test(id)) return { ok: false, error: `${where} has an invalid id.` };
    if (ids.has(id)) return { ok: false, error: `${where} repeats another widget's id.` };
    ids.add(id);
    if (typeof kind !== "string" || !WIDGET_KINDS.includes(kind as WidgetKind)) return { ok: false, error: `${where} has an unknown type.` };
    const k = kind as WidgetKind;
    const name = typeof title === "string" && title.trim() ? `“${title.trim().slice(0, 40)}”` : where;

    if (![x, y, w, h].every(isInt)) return { ok: false, error: `${name} needs whole-number grid positions.` };
    const [xi, yi, wi, hi] = [x, y, w, h] as number[];
    if (xi < 0 || yi < 0 || wi < 1 || hi < 1) return { ok: false, error: `${name} is outside the grid.` };
    if (xi + wi > GRID_COLS) return { ok: false, error: `${name} is wider than the ${GRID_COLS}-column grid.` };
    if (wi < MIN_SIZE[k].w || hi < MIN_SIZE[k].h) return { ok: false, error: `${name} is too small.` };
    if (hi > MAX_H || yi + hi > MAX_ROWS) return { ok: false, error: `${name} is too tall.` };

    const widget: DashboardWidget = { id, kind: k, x: xi, y: yi, w: wi, h: hi };

    if (title !== undefined && title !== null) {
      if (typeof title !== "string") return { ok: false, error: `${where} has an invalid title.` };
      if (title.length > MAX_TITLE) return { ok: false, error: `${name}: the title is longer than ${MAX_TITLE} characters.` };
      if (title.trim()) widget.title = title.trim();
    }

    const limits = METRIC_LIMITS[k];
    if (limits) {
      if (!Array.isArray(metrics) || !metrics.every((m) => typeof m === "string")) return { ok: false, error: `${name} needs at least one metric.` };
      const ms = [...new Set(metrics as string[])];
      if (ms.length < limits.min) return { ok: false, error: `${name} needs at least ${limits.min} metric${limits.min === 1 ? "" : "s"}.` };
      if (ms.length > limits.max) return { ok: false, error: `${name} can show at most ${limits.max} metric${limits.max === 1 ? "" : "s"}.` };
      const unknown = ms.find((m) => !known(m));
      if (unknown) return { ok: false, error: `${name} uses an unknown metric (${unknown.slice(0, 60)}).` };
      widget.metrics = ms;
    }

    const needsDim = k === "table" || k === "pie";
    const allowsDim = needsDim || k === "bar";
    if (allowsDim && typeof dimension === "string" && dimension) {
      if (!DIM_RE.test(dimension)) return { ok: false, error: `${name} has an invalid breakdown.` };
      widget.dimension = dimension;
    } else if (needsDim) {
      return { ok: false, error: `${name} needs a breakdown (for example by channel or query).` };
    }
    // A breakdown reads one source's stored dimension, so its metrics must share that source.
    if (widget.dimension && widget.metrics) {
      const srcs = new Set(widget.metrics.map((m) => sourceOf(m) ?? m.split(".")[0]));
      if (srcs.size > 1) return { ok: false, error: `${name}: a breakdown can only use metrics from one source.` };
    }

    if (k === "text") {
      if (typeof text !== "string") return { ok: false, error: `${name} needs some text.` };
      if (text.length > MAX_TEXT) return { ok: false, error: `${name}: text is longer than ${MAX_TEXT} characters.` };
      widget.text = text;
    }

    if (range !== undefined && range !== null && range !== "") {
      if (typeof range !== "string" || !RANGE_PRESETS.includes(range as RangePreset)) return { ok: false, error: `${name} has an unknown date range.` };
      widget.range = range;
    }
    if (k === "kpi" && hideChange === true) widget.hideChange = true;
    out.push(widget);
  }
  return { ok: true, widgets: out };
}

/**
 * Lenient read of stored widgets (Dashboard.widgets JSON): keeps every widget
 * that is valid on its own and drops the rest, so one bad widget never breaks
 * a dashboard. Metrics from a source that is not installed are kept; the
 * widget then shows an empty state.
 */
export function readWidgets(json: unknown): DashboardWidget[] {
  if (!Array.isArray(json)) return [];
  const out: DashboardWidget[] = [];
  const ids = new Set<string>();
  for (const raw of json.slice(0, MAX_WIDGETS)) {
    const r = parseWidgets([raw], { isKnownMetric: (k) => /^[a-z0-9]+\.[A-Za-z0-9_]+$/.test(k) });
    if (r.ok && !ids.has(r.widgets[0].id)) {
      ids.add(r.widgets[0].id);
      out.push(r.widgets[0]);
    }
  }
  return out;
}

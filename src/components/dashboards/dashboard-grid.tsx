import type { CSSProperties } from "react";
import { sortByPosition } from "@/lib/dashboards/layout";
import type { DashboardWidget, WidgetKind } from "@/lib/dashboards/types";
import type { DashboardData } from "@/lib/dashboards/widget-data";
import { WidgetView, type AdSlots } from "./widget-view";

/** Height of one grid row in px (and the gap between rows/columns). Shared with the editor. */
export const ROW_PX = 64;
export const GAP_PX = 12;

/** Full-width widgets whose content varies in length: shown at their natural height (capped at their grid height). */
const FLOW_KINDS: WidgetKind[] = ["pacing", "campaigns", "calllog", "formlog", "table", "rankings", "audit_issues", "audit_fixed", "audit_summary"];
const isFlow = (w: DashboardWidget) => w.x === 0 && w.w === 12 && FLOW_KINDS.includes(w.kind);

type Segment = { flow: DashboardWidget } | { grid: DashboardWidget[] };

/**
 * Splits the layout at full-width flow widgets, so a short table (say one
 * campaign) doesn't leave its whole grid height empty. Each run of other
 * widgets keeps its grid layout, rebased to start at row 0.
 */
export function segmentLayout(widgets: DashboardWidget[]): Segment[] {
  const out: Segment[] = [];
  let run: DashboardWidget[] = [];
  const flush = () => {
    if (!run.length) return;
    const top = Math.min(...run.map((w) => w.y));
    out.push({ grid: run.map((w) => ({ ...w, y: w.y - top })) });
    run = [];
  };
  for (const w of sortByPosition(widgets)) {
    if (isFlow(w)) {
      flush();
      out.push({ flow: w });
    } else run.push(w);
  }
  flush();
  return out;
}

/**
 * A dashboard in view mode: a 12-column grid on tablets and up, widgets
 * stacked in reading order on phones.
 */
export function DashboardGrid({ widgets, data, currency, slots, staff = false }: { widgets: DashboardWidget[]; data: DashboardData; currency: string; slots?: AdSlots; staff?: boolean }) {
  if (widgets.length === 0) return null;
  const view = (w: DashboardWidget) => <WidgetView widget={w} data={data[w.id]} currency={currency} slots={slots} staff={staff} />;
  return (
    <div className="flex flex-col gap-3">
      {segmentLayout(widgets).map((seg) =>
        "flow" in seg ? (
          <div key={seg.flow.id} className={`flex min-w-0 flex-col md:max-h-[var(--gmax)] [&>*]:min-h-0 ${seg.flow.kind === "pacing" || seg.flow.kind === "campaigns" ? "" : "max-h-[36rem]"}`} style={{ "--gmax": `${seg.flow.h * ROW_PX + (seg.flow.h - 1) * GAP_PX}px` } as CSSProperties}>
            {view(seg.flow)}
          </div>
        ) : (
          <div key={seg.grid[0].id} className="flex flex-col gap-3 md:grid md:grid-cols-12 md:gap-3 md:[grid-auto-rows:64px]">
            {sortByPosition(seg.grid).map((w) => (
              <div
                key={w.id}
                className="min-w-0 md:[grid-column:var(--gx)/span_var(--gw)] md:[grid-row:var(--gy)/span_var(--gh)]"
                style={{ "--gx": w.x + 1, "--gw": w.w, "--gy": w.y + 1, "--gh": w.h } as CSSProperties}
              >
                {view(w)}
              </div>
            ))}
          </div>
        ),
      )}
    </div>
  );
}

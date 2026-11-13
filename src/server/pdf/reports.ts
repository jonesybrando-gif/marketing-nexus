import "server-only";
import type { PacingResult, PacingSeriesPoint } from "@/lib/pacing/engine";
import { reportResults, type ClientReport } from "../client-report";
import { contextInput } from "../ai/context";
import { analyzePerformance } from "@/lib/insights";
import { attentionLines, headlineSentence, pacingHeadline } from "@/lib/at-a-glance";
import { displayPacingStatus } from "@/lib/pacing/display-status";
import { summaryOutline } from "@/lib/exec-summary";
import { rangeLabel } from "@/lib/date-ranges";
import type { AgencySummary, ClientPacing } from "../pacing-service";
import { derive } from "@/lib/metrics";
import { dailyKpiValue, formatKpi, KPI_BY_KEY, kpiChangeWords, kpiValues, untrackedKpis, type KpiKey } from "@/lib/kpis";
import type { DailyMetrics } from "../reporting";
import type { ExecSummary } from "../exec-summary";
import { formatMoney, formatMoneyCompact, formatNumber, formatPct } from "@/lib/money";
import { formatDate } from "@/lib/time";
import { PLATFORM_LABEL } from "@/lib/platforms";
import { PRESET_LABEL } from "@/lib/date-ranges";
import { STATUS_LABEL, type PacingStatus } from "@/lib/pacing/status";
import { drawBand, drawBudgetCard, drawCampaignTable, drawClientHeader, drawDailyChart, drawKpiTiles, drawSpendRing } from "./client-dashboard";
import { C, fetchLogo, contentWidth, decoratePages, ensureSpace, newDoc, paragraph, pdfText, sectionTitle, table, tiles, toBuffer, type Brand, type Column, type Doc } from "./primitives";

const STATUS_COLOR: Record<PacingStatus, string> = {
  OVERSPENDING: C.critical,
  UNDERSPENDING: C.warning,
  SLIGHTLY_OVER: C.serious,
  SLIGHTLY_UNDER: C.warning,
  ON_TARGET: C.good,
  NOT_STARTED: C.text3,
  NO_BUDGET: C.text3,
};

const money = (m: number | null | undefined, c: string) => (m === null || m === undefined ? "—" : formatMoney(m, c, { whole: true }));
const signed = (m: number, c: string) => `${m > 0 ? "+" : m < 0 ? "-" : ""}${formatMoney(Math.abs(m), c, { whole: true })}`;
/** Cumulative planned vs actual vs projected spend, with the budget line. */
export function drawPacingChart(doc: Doc, series: PacingSeriesPoint[], budgetMinor: number, currency: string, height = 170) {
  ensureSpace(doc, height + 40);
  const left = doc.page.margins.left;
  const w = contentWidth(doc);
  const axisW = 46;
  const x0 = left + axisW;
  const plotW = w - axisW - 40;
  const top = doc.y + 18;
  const bottom = top + height;

  // Legend
  const legend: [string, string, boolean][] = [["Actual spend", C.actual, false], ["Planned", C.planned, true], ["Projected", C.projected, true]];
  let lx = left;
  for (const [label, color, dashed] of legend) {
    doc.save().moveTo(lx, doc.y + 5).lineTo(lx + 16, doc.y + 5).lineWidth(1.6).strokeColor(color);
    if (dashed) doc.dash(3, { space: 2 });
    doc.stroke().restore();
    doc.font("Helvetica").fontSize(7.5).fillColor(C.text2).text(label, lx + 20, doc.y + 1, { lineBreak: false });
    lx += 20 + doc.widthOfString(label) + 14;
  }
  doc.text(pdfText(`Budget ${money(budgetMinor, currency)}`), lx, doc.y, { lineBreak: false });

  const maxY = Math.max(budgetMinor, ...series.map((p) => Math.max(p.plannedCumulative, p.actualCumulative ?? 0, p.projectedCumulative ?? 0))) * 1.08 || 1;
  const xAt = (i: number) => x0 + (series.length <= 1 ? 0 : (i / (series.length - 1)) * plotW);
  const yAt = (v: number) => bottom - (v / maxY) * height;

  // Grid and y labels
  doc.font("Helvetica").fontSize(7).fillColor(C.text3);
  for (let g = 0; g <= 4; g++) {
    const v = (maxY / 4) * g;
    const y = yAt(v);
    doc.moveTo(x0, y).lineTo(x0 + plotW, y).lineWidth(0.4).strokeColor(C.border).stroke();
    doc.text(formatMoneyCompact(v, currency), left, y - 4, { width: axisW - 6, align: "right", lineBreak: false });
  }
  // Budget line
  doc.moveTo(x0, yAt(budgetMinor)).lineTo(x0 + plotW, yAt(budgetMinor)).lineWidth(0.8).strokeColor(C.text3).stroke();
  doc.fontSize(7).fillColor(C.text2).text("Budget", x0 + plotW + 4, yAt(budgetMinor) - 4, { lineBreak: false });
  // x labels: first, weekly, last
  series.forEach((p, i) => {
    if (i === 0 || i === series.length - 1 || (i + 1) % 7 === 0) {
      doc.fontSize(7).fillColor(C.text3).text(formatDate(p.date), xAt(i) - 20, bottom + 4, { width: 40, align: "center", lineBreak: false });
    }
  });

  const line = (values: (number | null)[], color: string, dashed: boolean) => {
    let started = false;
    doc.save().lineWidth(1.6).strokeColor(color);
    if (dashed) doc.dash(3, { space: 2 });
    values.forEach((v, i) => {
      if (v === null) return;
      if (!started) {
        doc.moveTo(xAt(i), yAt(v));
        started = true;
      } else doc.lineTo(xAt(i), yAt(v));
    });
    if (started) doc.stroke();
    doc.restore();
  };
  line(series.map((p) => p.plannedCumulative), C.planned, true);
  line(series.map((p) => p.projectedCumulative), C.projected, true);
  line(series.map((p) => p.actualCumulative), C.actual, false);

  doc.x = left;
  doc.y = bottom + 20;
}

/** Daily values of one KPI, with the comparison period (dashed) aligned day by day. */
export function drawTrendChart(doc: Doc, key: KpiKey, current: DailyMetrics[], comparison: DailyMetrics[] | null, currency: string, height = 95) {
  const def = KPI_BY_KEY[key];
  ensureSpace(doc, height + 46);
  const left = doc.page.margins.left;
  const w = contentWidth(doc);
  const axisW = 46;
  const x0 = left + axisW;
  const plotW = w - axisW - 8;
  doc.font("Helvetica-Bold").fontSize(9).fillColor(C.text).text(pdfText(def.label), left, doc.y, { lineBreak: false });
  if (comparison) {
    const lx = left + doc.widthOfString(pdfText(def.label)) + 14;
    const y = doc.y + 5;
    doc.save().moveTo(lx, y).lineTo(lx + 14, y).lineWidth(1.4).strokeColor(C.actual).stroke().restore();
    doc.font("Helvetica").fontSize(7).fillColor(C.text2).text("Selected period", lx + 18, doc.y + 1, { lineBreak: false });
    const lx2 = lx + 18 + doc.widthOfString("Selected period") + 12;
    doc.save().moveTo(lx2, y).lineTo(lx2 + 14, y).lineWidth(1.4).strokeColor(C.planned).dash(3, { space: 2 }).stroke().restore();
    doc.text("Comparison period", lx2 + 18, doc.y, { lineBreak: false });
  }
  const top = doc.y + 16;
  const bottom = top + height;
  const cur = current.map((d) => dailyKpiValue(d, key));
  const prev = comparison ? current.map((_, i) => (comparison[i] ? dailyKpiValue(comparison[i], key) : null)) : [];
  const nums = [...cur, ...prev].filter((v): v is number => v !== null && Number.isFinite(v));
  // Round the axis up to three "nice" steps (1, 2, 2.5 or 5 × a power of ten).
  const rawStep = (nums.length ? Math.max(...nums) : 0) / 3 || 1;
  const mag = 10 ** Math.floor(Math.log10(rawStep));
  const n = rawStep / mag;
  const maxY = (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * mag * 3;
  const xAt = (i: number) => x0 + (cur.length <= 1 ? 0 : (i / (cur.length - 1)) * plotW);
  const yAt = (v: number) => bottom - (v / maxY) * height;
  const axis = (v: number) => (def.kind === "money" ? (maxY < 100000 ? formatMoney(v, currency, { whole: true }) : formatMoneyCompact(v, currency)) : def.kind === "pct" ? formatPct(v, maxY < 3 ? 1 : 0) : def.kind === "ratio" ? `${v.toFixed(1)}x` : formatNumber(v, maxY < 3 ? 1 : 0));

  doc.font("Helvetica").fontSize(7).fillColor(C.text3);
  for (let g = 0; g <= 3; g++) {
    const v = (maxY / 3) * g;
    const y = yAt(v);
    doc.moveTo(x0, y).lineTo(x0 + plotW, y).lineWidth(0.4).strokeColor(C.border).stroke();
    doc.text(pdfText(axis(v)), left, y - 4, { width: axisW - 6, align: "right", lineBreak: false });
  }
  const step = Math.max(1, Math.ceil(current.length / 8));
  current.forEach((p, i) => {
    if (i === 0 || i === current.length - 1 || (i % step === 0 && current.length - 1 - i >= step / 2)) {
      doc.fontSize(7).fillColor(C.text3).text(formatDate(p.date), xAt(i) - 20, bottom + 4, { width: 40, align: "center", lineBreak: false });
    }
  });
  const line = (values: (number | null)[], color: string, dashed: boolean) => {
    let started = false;
    doc.save().lineWidth(1.4).strokeColor(color);
    if (dashed) doc.dash(3, { space: 2 });
    values.forEach((v, i) => {
      if (v === null || !Number.isFinite(v)) return;
      if (!started) {
        doc.moveTo(xAt(i), yAt(v));
        started = true;
      } else doc.lineTo(xAt(i), yAt(v));
    });
    if (started) doc.stroke();
    doc.restore();
  };
  if (comparison) line(prev, C.planned, true);
  line(cur, C.actual, false);
  doc.x = left;
  doc.y = bottom + 22;
}

/** Pacing figures: four plain ones for the client; every figure, in plain words, for the internal PDF. */
function pacingFacts(r: PacingResult, currency: string, internal: boolean): string[][] {
  if (!internal) {
    return [
      ["Spent", money(r.actualToDateMinor, currency), "Budget", money(r.budgetMinor, currency)],
      ["Left", money(r.remainingBudgetMinor, currency), "Estimated period-end", money(r.projectedMinor, currency)],
    ];
  }
  return [
    ["Spent so far", money(r.actualToDateMinor, currency), "Planned by now", money(r.expectedToDateMinor, currency)],
    ["Spending pace", r.pacingPct === null ? "—" : `${formatPct(r.pacingPct, 0)} of plan`, "Budget used vs period elapsed", `${formatPct(r.pctBudgetConsumed, 0)} vs ${formatPct(r.pctPeriodElapsed, 0)}`],
    ["Estimated period-end", `${money(r.projectedMinor, currency)} (${signed(r.projectedVarianceMinor, currency)})`, "Left to spend", money(r.remainingBudgetMinor, currency)],
    ["Daily spend needed", r.requiredDailyMinor === null ? "—" : `${money(r.requiredDailyMinor, currency)} a day for ${r.remainingActiveDays} days`, "Daily spend lately (7-day)", money(r.currentDailyRateMinor, currency)],
  ];
}

const TONE_COLOR = { good: C.good, bad: C.critical, neutral: C.text2 } as const;

/** PDF tiles fit about 30 characters: "Down 21% from $218.18 · still counting" becomes "Down 21% · still counting". */
const compact = (text: string) => (text.length > 30 ? text.replace(/ from [^·]+?(?= ·|$)/, "") : text);

/** "In plain words": the headline sentence, supporting notes and what needs attention (the figures themselves are the tiles above). */
function drawPlainWords(doc: Doc, rep: ClientReport) {
  const c = rep.client.currency;
  const { current: r, previous: pr, stillCounting } = reportResults(rep);
  const insights = analyzePerformance(contextInput(rep), { skipBudget: true });
  const total = rep.pacing.total;
  const { start, end } = rep.pacing.period;
  const monthly = start.endsWith("-01") && start.slice(0, 7) === end.slice(0, 7);
  const periodName = monthly ? formatDate(start, { month: "long" }) : "this budget period";
  const label = r.goal === "AWARENESS" ? "Clicks" : r.label;

  paragraph(doc, headlineSentence({ range: rep.range, comparison: rep.cmpRange, today: rep.today, currency: c, results: r, previous: pr, stillCounting, driver: insights.driver }), { size: 11, color: C.text });
  if (stillCounting) paragraph(doc, "The last few days may still rise as ad platforms finish counting results.", { size: 7.5 });
  doc.moveDown(0.5);
  const calls = rep.callsFromAds;
  if (calls) paragraph(doc, `Calls from ads (CallRail): ${formatNumber(calls.current)}. Shown alongside, not added to ${label.toLowerCase()}, because the ad platforms often count the same calls.`, { size: 8.5 });
  if (r.valueMinor) paragraph(doc, `${label} worth ${money(r.valueMinor, c)} by the ad platforms' count.`, { size: 8.5 });
  paragraph(doc, "Results are counted by each ad platform and may not match your own records.", { size: 7.5 });
  doc.moveDown(0.5);
  const attention = attentionLines(total, insights.notWorking, c, periodName);
  doc.font("Helvetica-Bold").fontSize(10).fillColor(C.text).text("Needs your attention", doc.page.margins.left, doc.y);
  doc.moveDown(0.2);
  if (!attention.length) paragraph(doc, "Nothing needs attention right now.", { size: 9.5, color: C.text });
  for (const x of attention) {
    paragraph(doc, `•  ${x}`, { size: 9.5, color: C.text });
    doc.moveDown(0.2);
  }
  doc.moveDown(0.8);
}

export async function renderClientReportPdf(
  rep: ClientReport,
  brand: Brand,
  opts: {
    internal: boolean;
    compress?: boolean;
    generatedAt?: Date;
    executiveSummary?: ExecSummary;
    /** Client copies: the agency-approved next steps (clientNextStepLines). AI-drafted steps are never shown. */
    clientNextSteps?: string[];
  },
) {
  const { client, pacing, perf, cmpPerf, range, cmpRange, preset, history, template } = rep;
  const on = template.sections;
  const c = client.currency;
  const doc = newDoc({ title: `${client.name} · ${template.title}`, author: brand.name, compress: opts.compress });
  const isDemo = client.accounts.some((a) => a.isDemo);
  const total = pacing.total;
  const t = perf.totals;

  // The same layout as the client's report page: their logo and name, the summary
  // and budget, the headline tiles, then banded sections.
  drawClientHeader(doc, {
    name: client.name,
    logo: await fetchLogo(client.logoUrl),
    kicker: template.title,
    period: `${rangeLabel(preset, range)}: ${formatDate(range.from, { month: "short", day: "numeric", year: "numeric" })} - ${formatDate(range.to, { month: "short", day: "numeric", year: "numeric" })}` + (cmpRange ? ` · compared with ${formatDate(cmpRange.from)} - ${formatDate(cmpRange.to)}` : ""),
    demo: isDemo,
  });

  if (on.executive && opts.executiveSummary) {
    sectionTitle(doc, "This period in brief");
    // The client's copy lists only next steps a person approved, never the AI's drafts.
    const es = opts.internal ? opts.executiveSummary : { ...opts.executiveSummary, nextSteps: opts.clientNextSteps ?? [] };
    for (const para of es.overview.split(/\n{2,}/)) {
      paragraph(doc, para, { size: 10, color: C.text });
      doc.moveDown(0.5);
    }
    const list = (title: string, items: string[], numbered = false) => {
      if (!items.length) return;
      doc.moveDown(0.3);
      ensureSpace(doc, 40);
      doc.font("Helvetica-Bold").fontSize(10).fillColor(C.text).text(pdfText(title), doc.page.margins.left, doc.y);
      doc.moveDown(0.2);
      items.forEach((x, n) => {
        paragraph(doc, `${numbered ? `${n + 1}.` : "•"}  ${x}`, { size: 9.5, color: C.text });
        doc.moveDown(0.25);
      });
    };
    // The client's copy shows "What we're doing next" (agency voice) instead of the agency's recommendations, or nothing when empty.
    for (const sec of summaryOutline(es, !opts.internal)) list(sec.title, sec.items, sec.numbered);
    doc.moveDown(0.3);
    paragraph(doc, `${es.source === "ai" ? "Written by AI" : "Worked out automatically"} from the figures in this report.${opts.internal ? " Recommendations are suggestions; nothing has been changed in the ad accounts." : ""}`, { size: 7.5 });
    doc.moveDown(1);
  }

  if (on.summary && template.summary.trim()) {
    sectionTitle(doc, "Note");
    paragraph(doc, template.summary.trim());
    doc.moveDown(0.8);
  }

  if (on.pacing) drawBudgetCard(doc, rep);
  if (on.kpis) drawKpiTiles(doc, rep);

  if (on.trends || on.kpis) {
    drawBand(doc, "Spend and results", "Day by day, and where the budget went");
    drawDailyChart(doc, rep);
    drawSpendRing(doc, rep);
  }

  if (on.campaigns) {
    drawBand(doc, "Campaigns", cmpRange ? "Change shown against the previous period" : undefined);
    drawCampaignTable(doc, rep);
  }

  drawBand(doc, "In plain words", "What came in, and what needs attention");
  drawPlainWords(doc, rep);

  drawBand(doc, "More detail", "All figures, trends, budget and history");

  // The full KPI tiles, without the ones the client doesn't track (no leads, no real sales values).
  const hidden = untrackedKpis(t, cmpPerf?.totals ?? null);
  const shownKpis = template.kpis.filter((k) => !hidden.has(k));
  if (on.kpis && shownKpis.length) {
    sectionTitle(doc, "All figures");
    tiles(
      doc,
      kpiValues(shownKpis, t, cmpPerf?.totals ?? null, { stillCounting: reportResults(rep).stillCounting }).map((kv) => {
        const parts = [
          kv.key === "spend" && t.hasEstimatedCost ? "estimated" : null,
          kv.changePct === null || kv.verdict === null ? (kv.value === null ? "not reported" : cmpPerf ? "no comparison data" : null) : compact(kpiChangeWords(kv, c).text),
        ];
        return { label: KPI_BY_KEY[kv.key].label, value: formatKpi(kv.key, kv.value, c), sub: parts.filter(Boolean).join(" · ") || undefined, subColor: kv.tone ? TONE_COLOR[kv.tone] : undefined };
      }),
      4,
    );
  }

  if (on.trends && template.trendKpis.length) {
    sectionTitle(doc, "Trends", `Daily values${cmpRange ? "; the dashed line is the comparison period, aligned day by day" : ""}.`);
    for (const k of template.trendKpis) drawTrendChart(doc, k, perf.byDate, cmpPerf?.byDate ?? null, c);
  }

  // Pacing
  if (!on.pacing) {
    // left out by the report template
  } else if (total) {
    ensureSpace(doc, 260); // keep the heading with its chart
    const shownStatus = displayPacingStatus(total);
    sectionTitle(
      doc,
      `Budget pacing · ${formatDate(pacing.period.start, { month: "long", year: "numeric" })}`,
      total.asOf ? `Complete data through ${formatDate(total.asOf)}. Status: ${shownStatus.label}${shownStatus.forecastNote ? ` (${shownStatus.forecastNote})` : ""}.` : "No complete days of data in this period yet.",
    );
    paragraph(doc, pacingHeadline(total, c, formatDate(pacing.period.start, { month: "long" })), { size: 9.5, color: C.text });
    doc.moveDown(0.3);
    drawPacingChart(doc, total.series, total.budgetMinor, c);
    table(doc, [{ header: "", width: 0.25 }, { header: "", width: 0.25, align: "right" }, { header: "", width: 0.27 }, { header: "", width: 0.23, align: "right" }], pacingFacts(total, c, opts.internal), { noHeader: true });
    // The client-facing version drops internal terms, unbudgeted accounts and lines with no data.
    const lines = opts.internal ? [...pacing.rows, ...pacing.subRows] : [...pacing.rows, ...pacing.subRows].filter((r) => r.level !== "UNBUDGETED" && !r.notConnected);
    if (lines.length > 1 || opts.internal) {
      if (opts.internal) sectionTitle(doc, "Budget lines", "Sub-allocations are paced individually but already included in a parent budget.");
      else sectionTitle(doc, "Budget", "Each budget and how it is tracking this period.");
      const sub = new Set(pacing.subRows);
      const lineCols: Column[] = opts.internal
        ? [
            { header: "Line", width: 0.24 },
            { header: "Status", width: 0.12 },
            { header: "Budget", width: 0.1, align: "right" },
            { header: "Spent", width: 0.1, align: "right" },
            { header: "Pace (of plan)", width: 0.08, align: "right" },
            { header: "Estimated end", width: 0.11, align: "right" },
            { header: "Avg. needed/day", width: 0.09, align: "right" },
            { header: "Recommendation", width: 0.16 },
          ]
        : [
            { header: "Budget", width: 0.34 },
            { header: "Status", width: 0.14 },
            { header: "Amount", width: 0.13, align: "right" },
            { header: "Spent", width: 0.13, align: "right" },
            { header: "Left", width: 0.12, align: "right" },
            { header: "Estimated end", width: 0.14, align: "right" },
          ];
      // First column absorbs any rounding so widths sum to 100%.
      lineCols[0].width += 1 - lineCols.reduce((sum, x) => sum + x.width, 0);
      table(
        doc,
        lineCols,
        lines.map((r) => {
          const name = `${r.level === "CLIENT" ? (opts.internal ? "Combined client budget" : "Total budget") : r.label}${opts.internal && sub.has(r) ? " (sub-allocation)" : ""}\n${r.platforms.map((p) => PLATFORM_LABEL[p]).join(" + ")}`;
          const status = r.notConnected ? "Not connected" : r.result ? displayPacingStatus(r.result).label : "No budget";
          const head = [name, status, money(r.result?.budgetMinor, c), money(r.result?.actualToDateMinor ?? r.unbudgetedSpendMinor, c)];
          return opts.internal
            ? [...head, r.result && r.result.pacingPct !== null ? formatPct(r.result.pacingPct, 0) : "—", money(r.result?.projectedMinor, c), money(r.result?.requiredDailyMinor, c), `${r.action.headline}. ${r.action.detail}`]
            : [...head, money(r.result?.remainingBudgetMinor, c), money(r.result?.projectedMinor, c)];
        }),
        { colors: lines.map((r) => [undefined, r.result ? STATUS_COLOR[displayPacingStatus(r.result).status] : C.text3]) },
      );
    }
  } else {
    sectionTitle(doc, "Budget pacing");
    paragraph(doc, "No budget is set for this period.");
  }

  // Platforms
  if (on.platforms) {
    sectionTitle(doc, "Platform breakdown", `${PRESET_LABEL[preset]} · each ad platform counts conversions in its own way.`);
    if (!opts.internal) {
      // The client's copy: fewer columns, full names.
      table(
        doc,
        [
          { header: "Account", width: 0.27 },
          { header: "Ad spend", width: 0.12, align: "right" },
          { header: "Clicks", width: 0.1, align: "right" },
          { header: "Conversions", width: 0.12, align: "right" },
          { header: "Cost per conversion", width: 0.14, align: "right" },
          { header: "Leads", width: 0.1, align: "right" },
          { header: "Return on ad spend", width: 0.15, align: "right" },
        ],
        client.accounts.map((a) => {
          const m = perf.byAccount[a.id];
          const x = m ? derive(m) : null;
          const lsa = a.platform === "GOOGLE_LSA";
          return [
            `${PLATFORM_LABEL[a.platform]}\n${a.name}`,
            m ? `${money(m.costMinor, c)}${a.spendIsVerified ? "" : "*"}` : "—",
            lsa ? "n/a" : m ? formatNumber(m.clicks) : "—",
            m ? formatNumber(m.conversions, 1) : "—",
            x?.costPerConversionMinor == null ? "—" : formatMoney(x.costPerConversionMinor, c),
            m && (m.leads || m.leadsReported) ? formatNumber(m.leads) : "—",
            x?.roas == null || lsa ? "—" : `${x.roas.toFixed(2)}x`,
          ];
        }),
      );
    } else table(
      doc,
      [
        { header: "Account", width: 0.26 },
        { header: "Spend", width: 0.11, align: "right" },
        { header: "Impr.", width: 0.1, align: "right" },
        { header: "Clicks", width: 0.08, align: "right" },
        { header: "CTR", width: 0.07, align: "right" },
        { header: "CPC", width: 0.08, align: "right" },
        { header: "Conv.", width: 0.07, align: "right" },
        { header: "Cost/conv.", width: 0.09, align: "right" },
        { header: "Leads", width: 0.07, align: "right" },
        { header: "ROAS", width: 0.07, align: "right" },
      ],
      client.accounts.map((a) => {
        const m = perf.byAccount[a.id];
        const x = m ? derive(m) : null;
        const lsa = a.platform === "GOOGLE_LSA";
        return [
          `${PLATFORM_LABEL[a.platform]}\n${a.name}`,
          m ? `${money(m.costMinor, c)}${a.spendIsVerified ? "" : "*"}` : "—",
          lsa ? "n/a" : m ? formatNumber(m.impressions) : "—",
          lsa ? "n/a" : m ? formatNumber(m.clicks) : "—",
          lsa ? "n/a" : formatPct(x?.ctr ?? null, 2),
          lsa || x?.cpcMinor == null ? (lsa ? "n/a" : "—") : formatMoney(x.cpcMinor, c),
          m ? formatNumber(m.conversions, 1) : "—",
          x?.costPerConversionMinor == null ? "—" : formatMoney(x.costPerConversionMinor, c),
          m && (m.leads || m.leadsReported) ? formatNumber(m.leads) : "—",
          x?.roas == null || lsa ? "—" : `${x.roas.toFixed(2)}x`,
        ];
      }),
    );
    if (client.accounts.some((a) => !a.spendIsVerified)) paragraph(doc, `* Spend is estimated or incomplete for this account${opts.internal ? " (see data notes)" : ""}.`, { size: 7.5 });
  }

  // History (the client-facing PDF leaves out months that had no budget)
  const historyRows = opts.internal ? history : history.filter((h) => h.total);
  if (on.history && historyRows.length) {
    sectionTitle(doc, "Historical budget performance");
    table(
      doc,
      [
        { header: "Period", width: 0.28 },
        { header: "Budget", width: 0.16, align: "right" },
        { header: "Spent", width: 0.16, align: "right" },
        { header: "Variance", width: 0.14, align: "right" },
        { header: "Used", width: 0.1, align: "right" },
        { header: "Result", width: 0.16 },
      ],
      historyRows.map((h) => {
        const r = h.total;
        return [
          formatDate(h.period.start, { month: "long", year: "numeric" }),
          money(r?.budgetMinor, c),
          money(r?.actualToDateMinor, c),
          r ? signed(r.actualToDateMinor - r.budgetMinor, c) : "—",
          r ? formatPct(r.pctBudgetConsumed) : "—",
          r ? STATUS_LABEL[r.status] : "No budget",
        ];
      }),
      { colors: historyRows.map((h) => [undefined, undefined, undefined, undefined, undefined, h.total ? STATUS_COLOR[h.total.status] : C.text3]) },
    );
  }

  // Notes
  if (on.notes) {
    const notes = [...new Set([...pacing.rows, ...pacing.subRows].flatMap((r) => r.warnings))];
    // The same plain definitions as the ⓘ on the page. Data notes (time zones, estimates) only in the internal copy.
    const defs = shownKpis.map((k) => `${KPI_BY_KEY[k].label}: ${KPI_BY_KEY[k].plain}`);
    sectionTitle(doc, "Notes");
    paragraph(
      doc,
      [
        "Spending pace compares what has been spent so far with what was planned by now. Today's partial spend is left out, and month-end figures are estimates.",
        "Results, conversions and sales values are counted by each ad platform in its own way and may not match your own records.",
        ...defs,
        ...(opts.internal ? notes : []),
      ].map((n) => `- ${n}`).join("\n"),
    );
  }

  const generated = (opts.generatedAt ?? new Date()).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: client.timezone });
  decoratePages(doc, brand, `${client.name} · generated ${generated}${isDemo ? " · demo data" : ""}`, { firstPageHeader: false });
  return toBuffer(doc);
}

export async function renderAgencyReportPdf(clients: ClientPacing[], s: AgencySummary, brand: Brand, opts: { compress?: boolean; generatedAt?: Date; timezone: string }) {
  const doc = newDoc({ title: "Budget pacing report", author: brand.name, compress: opts.compress, landscape: true });
  const rows = clients.flatMap((c) => c.rows);
  const c = s.currency;
  const isDemo = rows.some((r) => r.isDemo);
  doc.font("Helvetica-Bold").fontSize(20).fillColor(C.text).text("Budget pacing report", doc.page.margins.left, doc.page.margins.top);
  doc.font("Helvetica").fontSize(10).fillColor(C.text2).text(
    pdfText(`${s.combined ? formatDate(s.combined.periodStart, { month: "long", year: "numeric" }) : ""} · ${clients.length} clients · ${rows.length} budget lines${s.typicalAsOf ? ` · data through ${formatDate(s.typicalAsOf)}` : ""}`),
  );
  if (isDemo) doc.moveDown(0.3).font("Helvetica-Bold").fontSize(8.5).fillColor("#1c5cab").text("Includes illustrative demo data.");
  doc.moveDown(0.8);
  const variance = s.projectedMinor - s.totalBudgetMinor;
  tiles(
    doc,
    [
      { label: "Total monthly budget", value: money(s.totalBudgetMinor, c) },
      { label: "Month-to-date spend", value: money(s.actualToDateMinor, c), sub: `${formatPct(s.totalBudgetMinor ? (s.actualToDateMinor / s.totalBudgetMinor) * 100 : null, 0)} of budget used` },
      { label: "Expected to date", value: money(s.expectedToDateMinor, c), sub: `Agency pacing ${formatPct(s.expectedToDateMinor ? (s.actualToDateMinor / s.expectedToDateMinor) * 100 : null)}` },
      { label: "Projected month-end", value: money(s.projectedMinor, c), sub: `${signed(variance, c)} vs budget`, subColor: variance > 0 ? C.critical : C.text2 },
      { label: "Lines requiring attention", value: `${s.rowsNeedingAttention} of ${s.rowsTotal}`, subColor: C.critical, sub: s.staleRows ? `${s.staleRows} with stale data` : "all data current" },
    ],
    5,
  );
  if (s.combined) {
    sectionTitle(doc, "Agency pacing — cumulative spend");
    drawPacingChart(doc, s.combined.series, s.combined.budgetMinor, c, 150);
  }
  const order: Record<string, number> = { critical: 0, warning: 1, info: 2, ok: 3 };
  const sorted = [...rows].sort((a, b) => order[a.action.severity] - order[b.action.severity] || Math.abs(b.result?.projectedVarianceMinor ?? 0) - Math.abs(a.result?.projectedVarianceMinor ?? 0));
  sectionTitle(doc, "Client budget pacing", "Sorted by urgency. Pacing = actual spend / expected spend to date.");
  table(
    doc,
    [
      { header: "Client / line", width: 0.19 },
      { header: "Platform", width: 0.1 },
      { header: "Status", width: 0.1 },
      { header: "Budget", width: 0.07, align: "right" },
      { header: "Spent", width: 0.07, align: "right" },
      { header: "Pacing", width: 0.06, align: "right" },
      { header: "Projected", width: 0.08, align: "right" },
      { header: "Variance", width: 0.07, align: "right" },
      { header: "Recommendation", width: 0.26 },
    ],
    sorted.map((r) => [
      `${r.clientName}\n${r.level === "CLIENT" ? "Combined budget" : r.label}`,
      r.platforms.map((p) => PLATFORM_LABEL[p]).join(" + "),
      `${r.result ? STATUS_LABEL[r.result.status] : "No budget"}${r.disconnected ? "\nDisconnected" : r.stale ? "\nStale data" : ""}`,
      money(r.result?.budgetMinor, r.currency),
      money(r.result?.actualToDateMinor ?? r.unbudgetedSpendMinor, r.currency),
      r.result ? formatPct(r.result.pacingPct) : "—",
      money(r.result?.projectedMinor, r.currency),
      r.result ? signed(r.result.projectedVarianceMinor, r.currency) : "—",
      `${r.action.headline}. ${r.action.detail}`,
    ]),
    { fontSize: 7.5, colors: sorted.map((r) => [undefined, undefined, r.result ? STATUS_COLOR[r.result.status] : C.text3]) },
  );
  const generated = (opts.generatedAt ?? new Date()).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: opts.timezone });
  decoratePages(doc, brand, `Internal report · generated ${generated}${isDemo ? " · includes demo data" : ""}`);
  return toBuffer(doc);
}

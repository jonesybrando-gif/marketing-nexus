// When a client's next scheduled crawl starts: weekly on a weekday or monthly
// on a day (1–28), at CRAWL_HOUR in the client's time zone, so results are
// ready before the 8:00 scheduled report emails.

import { addDays, todayInTimeZone } from "../pacing/dates";
import { matchesRule, WEEKDAYS, zonedTime } from "../report-schedule";

export const CRAWL_HOUR = 4;
export type AuditSchedule = "weekly" | "monthly" | "manual";
export const AUDIT_SCHEDULES: { value: AuditSchedule; label: string }[] = [
  { value: "weekly", label: "Weekly" },
  { value: "monthly", label: "Monthly" },
  { value: "manual", label: "Only when I run it" },
];
export const LIGHTHOUSE_MODES: { value: "off" | "homepage" | "top_pages"; label: string }[] = [
  { value: "off", label: "Off" },
  { value: "homepage", label: "Homepage" },
  { value: "top_pages", label: "Homepage + 5 top landing pages" },
];
export const MAX_PAGES_LIMIT = 10_000;

export function nextAuditRun(cfg: { schedule: string; dayOfWeek: number | null; dayOfMonth: number | null }, timeZone: string, after: Date): Date | null {
  if (cfg.schedule !== "weekly" && cfg.schedule !== "monthly") return null;
  const rule = { frequency: cfg.schedule, dayOfWeek: cfg.dayOfWeek ?? 1, dayOfMonth: Math.min(Math.max(cfg.dayOfMonth ?? 1, 1), 28) } as const;
  let d = addDays(todayInTimeZone(timeZone, after), -1);
  for (let i = 0; i < 70; i++, d = addDays(d, 1)) {
    if (!matchesRule(rule, d)) continue;
    const at = zonedTime(d, CRAWL_HOUR, timeZone);
    if (at > after) return at;
  }
  return null;
}

export function describeAuditSchedule(cfg: { schedule: string; dayOfWeek: number | null; dayOfMonth: number | null }): string {
  if (cfg.schedule === "weekly") return `Weekly on ${WEEKDAYS[cfg.dayOfWeek ?? 1]}s`;
  if (cfg.schedule === "monthly") return `Monthly on day ${cfg.dayOfMonth ?? 1}`;
  return "Only when run by hand";
}

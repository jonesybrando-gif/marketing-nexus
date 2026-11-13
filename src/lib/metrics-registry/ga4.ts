// Google Analytics 4 metrics (Data API runReport). Stored daily per property:
// totals (dimension "") plus breakdowns by channel, source, page and device.
import type { DimensionDef, MetricDef } from "./types";

const DIMS = ["channel", "source", "page", "device"];

export const metrics: MetricDef[] = [
  { key: "ga4.sessions", source: "ga4", label: "Website visits", short: "Visits", format: "count", aggregation: "sum", better: "up", description: "Sessions that started on the site or app.", dimensions: DIMS },
  { key: "ga4.totalUsers", source: "ga4", label: "Website visitors", short: "Visitors", format: "count", aggregation: "sum", better: "up", description: "Users with at least one event. Daily counts are added up over a range, so a returning user is counted once per day.", dimensions: DIMS },
  { key: "ga4.newUsers", source: "ga4", label: "New website visitors", short: "New visitors", format: "count", aggregation: "sum", better: "up", description: "Users who visited for the first time.", dimensions: DIMS },
  { key: "ga4.engagedSessions", source: "ga4", label: "Engaged visits", format: "count", aggregation: "sum", better: "up", description: "Sessions that lasted 10+ seconds, had a key event, or had 2+ page views.", dimensions: DIMS },
  { key: "ga4.engagementRate", source: "ga4", label: "Engaged visit rate", short: "Engaged rate", format: "pct", aggregation: "weighted", ratioOf: { numerator: "ga4.engagedSessions", denominator: "ga4.sessions" }, better: "up", description: "Engaged sessions as a share of all sessions.", dimensions: DIMS },
  { key: "ga4.bouncedSessions", source: "ga4", label: "Quick exits (bounced visits)", short: "Bounced visits", format: "count", aggregation: "sum", better: "down", description: "Sessions that were not engaged (sessions minus engaged sessions).", dimensions: DIMS },
  { key: "ga4.bounceRate", source: "ga4", label: "Quick exit rate (bounce rate)", short: "Bounce rate", format: "pct", aggregation: "weighted", ratioOf: { numerator: "ga4.bouncedSessions", denominator: "ga4.sessions" }, better: "down", description: "Share of sessions that were not engaged (the inverse of engagement rate).", dimensions: DIMS },
  { key: "ga4.userEngagementDuration", source: "ga4", label: "Total engagement time", format: "duration", aggregation: "sum", better: "up", description: "Total seconds the site or app was in the foreground.", dimensions: DIMS },
  { key: "ga4.averageSessionDuration", source: "ga4", label: "Average time per visit", short: "Avg. time", format: "duration", aggregation: "weighted", ratioOf: { numerator: "ga4.userEngagementDuration", denominator: "ga4.sessions" }, better: "up", description: "Total engagement time divided by sessions, in seconds.", dimensions: DIMS },
  { key: "ga4.avgEngagementTime", source: "ga4", label: "Average engagement time", short: "Avg. engagement", format: "duration", aggregation: "weighted", ratioOf: { numerator: "ga4.userEngagementDuration", denominator: "ga4.totalUsers" }, better: "up", description: "Total engagement time divided by visitors (daily visitors added up), in seconds.", dimensions: DIMS },
  { key: "ga4.screenPageViews", source: "ga4", label: "Page views", format: "count", aggregation: "sum", better: "up", description: "Page and screen views.", dimensions: DIMS },
  { key: "ga4.keyEvents", source: "ga4", label: "Website goals", short: "Goals", format: "count", aggregation: "sum", better: "up", description: "Key events (formerly conversions), as marked in the Google Analytics property.", dimensions: DIMS },
  { key: "ga4.keyEventRate", source: "ga4", label: "Goals per visit", short: "Goal rate", format: "pct", aggregation: "weighted", ratioOf: { numerator: "ga4.keyEvents", denominator: "ga4.sessions" }, better: "up", description: "Website goals divided by visits. A visit with two goals counts twice, so this can differ from GA4's session key event rate.", dimensions: DIMS },
  { key: "ga4.totalRevenue", source: "ga4", label: "Website revenue", short: "Revenue", format: "money", aggregation: "sum", better: "up", description: "Purchase, subscription and ad revenue, in the property's currency.", dimensions: DIMS },
];

export const dimensions: DimensionDef[] = [
  { key: "ga4.channel", source: "ga4", dimension: "channel", label: "Channel" },
  { key: "ga4.source", source: "ga4", dimension: "source", label: "Source / medium" },
  { key: "ga4.page", source: "ga4", dimension: "page", label: "Landing page" },
  { key: "ga4.device", source: "ga4", dimension: "device", label: "Device" },
];

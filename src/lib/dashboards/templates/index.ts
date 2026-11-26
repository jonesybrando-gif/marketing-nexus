// Ready-made dashboard templates offered when creating a dashboard. Each source
// adds ONE import and ONE entry (alphabetical). See ../types.ts for widgets.
import type { DashboardWidget } from "../types";
import { adsOverviewTemplate } from "./ads";
import { callrailTemplate } from "./callrail";
import { facebookTemplate } from "./facebook";
import { ga4Template } from "./ga4";
import { gbpTemplate } from "./gbp";
import { instagramTemplate } from "./instagram";
import { rankingsTemplate } from "./rankings";
import { seoTemplate } from "./seo";
import { siteAuditTemplate } from "./site-audit";

export interface DashboardTemplateDef {
  key: string;
  name: string;
  description: string;
  /** Sources the template needs (shown as "needs GA4"). "ads" = ad platforms. */
  sources: string[];
  widgets: DashboardWidget[];
}

export const DASHBOARD_TEMPLATES: DashboardTemplateDef[] = [
  adsOverviewTemplate,
  callrailTemplate,
  facebookTemplate,
  ga4Template,
  gbpTemplate,
  instagramTemplate,
  rankingsTemplate,
  seoTemplate,
  siteAuditTemplate,
];

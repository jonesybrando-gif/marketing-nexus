// "Site audit" dashboard template (Site Auditor, DataForSEO On-Page crawls).
import type { DashboardTemplateDef } from "./index";

export const siteAuditTemplate: DashboardTemplateDef = {
  key: "site_audit",
  name: "Site audit",
  description: "Website health score and trend, the top technical SEO issues with how to fix them, and what was fixed since the last audit.",
  sources: ["audit"],
  widgets: [
    { id: "audit-score", kind: "audit_score", title: "Site health score", x: 0, y: 0, w: 6, h: 4 },
    { id: "audit-fixed", kind: "audit_fixed", title: "Issues fixed since last audit", x: 6, y: 0, w: 6, h: 4 },
    { id: "audit-issues", kind: "audit_issues", title: "Top site issues", x: 0, y: 4, w: 12, h: 7 },
  ],
};

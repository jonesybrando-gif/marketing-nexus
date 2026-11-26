# Site Auditor

Scheduled technical SEO crawls of each client's website through the DataForSEO
On-Page API, using the agency's DataForSEO login from Settings › Connections
(the same one rank tracking uses; one API client: `../data-sources/dataforseo/api.ts`).

## Flow
1. **Settings** (client › Site Audit › Settings): `SiteAuditConfig` with target URL,
   schedule (weekly / monthly / manual), max pages (default 500), JavaScript
   rendering (off by default, about 10× the cost) and Lighthouse (off / homepage /
   homepage + 5 top landing pages from GA4, else Search Console).
2. **Start** (`jobs.ts › startAudit`): refuses a second crawl while one is running,
   estimates the cost (`@/lib/site-audit/cost.ts`, rates from `../data-sources/dataforseo/pricing.ts`),
   checks the agency's monthly cap (`Agency.siteAuditMonthlyCapUsd`, default $25;
   over the cap → `skipped` with the reason), then `POST /v3/on_page/task_post`.
3. **Poll** (`pollActiveAudits`): `GET /v3/on_page/summary/{id}` until
   `crawl_progress` is `finished`; then pages (paginated), non-indexable pages,
   redirect chains and broken internal links are fetched and analysed
   (`@/lib/site-audit/issues.ts`), Lighthouse runs, and the score, issues, pages
   and actual cost are stored. Crawls older than 24 h fail with `timeout`.
4. **AI summary** (`summarizeAudit`): what changed, the 3–5 top fixes and any
   regressions, via the app's AI pipeline (`../ai/assistant.ts`). Failures are
   stored in `aiSummaryError` and never fail the audit.

Scheduling uses the existing hourly job (`../scheduler.ts` and `/api/cron/sync`
both call `runSiteAuditJobs`); while a crawl is running the in-process scheduler
also polls every 2 minutes, and "Run audit now" polls for 20 minutes after the
click. No inbound webhooks (`pingback_url`) are used.

## Exclusions (false positives)
`@/lib/site-audit/urls.ts`: URLs on CDN and platform system paths (Cloudflare's
`/cdn-cgi/` email protection, `/.well-known/`, `/wp-admin/`, `/wp-json/` …) and
the client's own **ignore patterns** (Settings drawer, e.g. `/book?*`) are left
out everywhere: as crawled pages, as broken link or resource targets, and as
blocked pages. Broken links are judged per page from DataForSEO's full list of
broken links (so a page whose only "broken" link is `/cdn-cgi/l/email-protection`
isn't counted), and broken resources from the resources list plus the pages
using each one; when a list is too long to read, DataForSEO's own per-page flag
is used instead. "Linked pages blocked from Google" is a warning: many sites
noindex bookings, carts or filters on purpose.

## Stop, re-check, page speed
- **Stop crawl** (admin, while crawling): `on_page/force_stop`; DataForSEO keeps
  the pages crawled so far and refunds the rest, and the audit is completed
  from those pages with a note.
- **Re-check with current settings** (admin, free): `reanalyzeAudit` reads a
  finished crawl back from DataForSEO (summary, pages and lists cost $0) and
  re-analyses it with the current rules and ignore patterns. No new crawl or
  Lighthouse test. If DataForSEO no longer holds the crawl, the stored issue
  counts are re-scored with the current formula and severities instead
  (exclusions then apply from the next crawl). `SiteAudit.analysisVersion` and
  `SiteAudit.ignorePatterns` show when results predate the current rules.
- **Lighthouse**: a failed test is retried once; the reason is stored and shown
  (e.g. a 403 from a site behind Cloudflare: its bot protection blocked the
  tester). DataForSEO doesn't charge for failed tests.

## Errors
`engine.ts › classifyError` maps DataForSEO errors to `bad_credentials`,
`insufficient_balance`, `invalid_target`, `rate_limit` or `provider_error`.
Bad credentials and low balance are never retried automatically: scheduled runs
record a `skipped` audit until a person fixes the login (reconnect) or runs the
audit by hand. Rate limits and provider errors are retried on the next poll
until the 24 h timeout.

## Score and changes
- Health score (`@/lib/site-audit/score.ts`, one function): each distinct kind
  of issue costs `weight × (0.25 + 0.75 × share of pages affected)` with weights
  error 10, warning 4, notice 1; score = 100 − total, clamped 0–100. One issue on
  every page costs at most 10 points, so a single sitewide problem can't zero
  the score. Yes/no site checks (no sitemap) count as every page; lists of
  non-page URLs (redirect loops, blocked pages) use count ÷ pages. DataForSEO's
  `onpage_score` is stored too.
- Changes (`@/lib/site-audit/diff.ts`): new / fixed / worse / better against the
  previous completed crawl (or, in report widgets, the last crawl before the
  period), where worse/better means a change of at least 10% or 5 pages.

## Retention
Score, page counts and issue counts are kept for every audit (the trend). Sample
URLs and `SiteAuditPage` rows are kept for the client's last 6 completed audits.

## Where it shows
- Client › Site Audit tab (`@/components/site-audit/site-audit-tab.tsx`).
- Site Audits page (agency list, worst first): `src/app/(app)/site-audits`.
- Dashboards and reports: source `audit` with widgets `audit_score`,
  `audit_issues`, `audit_fixed` and `audit_summary`, the "Site audit" dashboard
  template and the "Site Audit" report section.

## Tests
`__tests__/site-audit.test.ts`: every issue mapping against sandbox pages, score,
diff, cost and cap, schedule, the engine on recorded sandbox responses and the
database flow. With `DATAFORSEO_SANDBOX=1` (and the DataForSEO login available to
the request, e.g. through a proxy) it also runs a full crawl against
`https://sandbox.dataforseo.com`.

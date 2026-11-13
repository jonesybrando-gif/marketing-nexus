import Link from "next/link";
import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/server/auth";
import { appLink, site } from "@/lib/site";
import { AiDemo } from "./ai-demo";
import { EarlyAccessForm } from "./early-access-form";
import { PacingBoard } from "./pacing-board";
import { ProductTour } from "./product-tour";
import { CTA_COOKIE, isCtaVariant, type CtaVariant } from "./signup-copy";

export const dynamic = "force-dynamic";

const DESCRIPTION =
  "Go beyond traditional reporting. Marketing Nexus analyzes your advertising, SEO and analytics data to uncover opportunities, find what's holding you back and recommend the next steps to generate more leads, customers and revenue.";

export const metadata: Metadata = {
  title: { absolute: `${site.appName}: AI marketing intelligence that shows agencies how to grow results` },
  description: DESCRIPTION,
  alternates: { canonical: "https://www.marketingnexus.us/" },
  openGraph: {
    title: "Don’t just see your results. Know how to grow them.",
    description: DESCRIPTION,
    url: "https://www.marketingnexus.us/",
    siteName: site.appName,
    type: "website",
  },
};

const SOURCES = ["Google Ads", "Local Services Ads", "Meta Ads", "Google Analytics 4", "Search Console", "Keyword rankings", "CallRail"];

const FAQ: { q: string; a: React.ReactNode }[] = [
  {
    q: "What does the AI actually do?",
    a: "It reads one client's figures across every connected source for the period you're looking at: ad results, website visits and goals, organic search and keyword rankings. It writes what the data shows, what may explain it, and what to do next, citing the numbers it used. It works only from that client's data, and nothing reaches a client until you've reviewed it.",
  },
  {
    q: "Which data sources can I connect?",
    a: "Google Ads, Google Local Services Ads, Meta Ads, Google Analytics 4, Google Search Console, keyword rank tracking (with your DataForSEO account) and CallRail. Some Google and Meta connections are still completing those platforms' app reviews, so we set them up with you during early access. Microsoft Advertising is next.",
  },
  {
    q: "How fresh is the data?",
    a: "Marketing Nexus checks every connected source every hour, and keyword positions update daily. Google and Meta can take a day or two to finish counting recent conversions, so the most recent days are marked as still counting.",
  },
  {
    q: "Does it change anything in my accounts?",
    a: "No. Marketing Nexus only reads reporting data. It never creates, changes or pauses campaigns, ads, budgets or website settings, and you can disconnect any source at any time.",
  },
  {
    q: "How does budget pacing work?",
    a: "Set each client's monthly budget once; it repeats every month. Marketing Nexus compares spend with budget every hour, forecasts where the month will land, shows the daily spend that lands on budget, and alerts you when a client drifts over or under.",
  },
  {
    q: "Can my clients see their results?",
    a: "Yes. Send branded reports weekly or monthly by private link or PDF, or give each client a login to their own dashboard.",
  },
  {
    q: "What happens after I enter my email?",
    a: "We email you an invitation to book a setup call. On the call we connect your first client's ad accounts, Google Analytics, Search Console and rankings together, so you start with your own data. There's nothing to install and no card to enter.",
  },
  {
    q: "What does it cost?",
    a: "Marketing Nexus is in early access while we onboard agencies one at a time. We'll walk you through pricing on your setup call, before you commit to anything.",
  },
];

export default async function HomePage() {
  const user = await getCurrentUser();
  if (user) redirect(user.role === "CLIENT_USER" && user.clientId ? `/clients/${user.clientId}` : "/clients");
  // CTA label test: a returning visitor keeps their variant; new visitors are split 50/50.
  const saved = (await cookies()).get(CTA_COOKIE)?.value;
  const variant: CtaVariant = isCtaVariant(saved) ? saved : Math.random() < 0.5 ? "benefit" : "plain";

  return (
    <>
      <section className="mn-hero mn-wrap" aria-labelledby="hero-title">
        <p className="mn-eyebrow mn-eyebrow-caps">AI-Powered Marketing Intelligence for Agencies</p>
        <h1 id="hero-title">
          <span className="mn-h1-line">Don&rsquo;t just see your results.</span>{" "}
          <span className="mn-h1-line mn-h1-accent">Know how to grow them.</span>
        </h1>
        <p className="mn-lede">
          Go beyond traditional reporting. {site.appName} analyzes your advertising, SEO, and analytics data to uncover opportunities, identify what&rsquo;s
          holding you back, and recommend the next steps to generate more leads, win more customers, and drive more revenue.
        </p>
        <EarlyAccessForm position="hero" variant={variant} />
      </section>

      <section className="mn-wrap mn-demo-wrap" aria-label="Try it: ask about a sample client">
        <AiDemo />
      </section>

      <section className="mn-wrap mn-sources" aria-label="Data sources">
        <p>Answers from every source a client is judged on</p>
        <ul>
          {SOURCES.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ul>
      </section>

      <section className="mn-dark" aria-labelledby="problem-title">
        <div className="mn-wrap mn-dark-inner">
          <h2 id="problem-title">Your data lives in five places. The answers live in none of them.</h2>
          <ul className="mn-pains">
            <li>
              <strong>Every channel tells half the story.</strong>
              <span>Ads look fine, organic is down, and nothing shows how the two connect.</span>
            </li>
            <li>
              <strong>Dashboards show what. Clients ask why.</strong>
              <span>Every &ldquo;why did leads drop?&rdquo; starts an hour of digging.</span>
            </li>
            <li>
              <strong>Budget problems surface on the 31st.</strong>
              <span>By then the money is spent and the call is awkward.</span>
            </li>
            <li>
              <strong>Reports eat the week.</strong>
              <span>Time spent assembling numbers is time not spent improving them.</span>
            </li>
          </ul>
        </div>
      </section>

      <section id="product" className="mn-wrap mn-feature" aria-labelledby="f1">
        <div className="mn-feature-copy">
          <p className="mn-kicker">Cross-channel intelligence</p>
          <h2 id="f1" className="mn-h2">See how paid, organic and your website affect each other.</h2>
          <p className="mn-body">
            When leads drop, {site.appName} checks every channel at once: whether paid traffic changed, whether organic clicks fell, which rankings moved and whether
            the website still converts. You get one answer instead of five dashboards.
          </p>
          <ul className="mn-checks">
            <li>See every channel&apos;s change side by side, so you know where to look first</li>
            <li>Find where paid search can cover an organic gap, and where it&apos;s wasted</li>
            <li>Never double-count: ad conversions and website goals are kept apart</li>
          </ul>
        </div>
        <figure className="mn-shot mn-channels" aria-label="One client's channels side by side. Sample data.">
          <div className="mn-shot-head">
            <span>Harbor Dental, October so far</span>
            <span className="mn-sample">Sample data</span>
          </div>
          <div className="mn-channel-grid">
            <div className="mn-channel"><span className="mn-src src-ads">Paid</span><strong>118</strong><span>leads</span><em className="tone-down">-10%</em></div>
            <div className="mn-channel"><span className="mn-src src-sc">Organic</span><strong>1,702</strong><span>search clicks</span><em className="tone-down">-26%</em></div>
            <div className="mn-channel"><span className="mn-src src-rank">Rankings</span><strong>11 of 24</strong><span>in the top 10</span><em className="tone-down">-3</em></div>
            <div className="mn-channel"><span className="mn-src src-ga">Website</span><strong>152</strong><span>goals completed</span><em className="tone-down">-19%</em></div>
          </div>
          <div className="mn-connect">
            <span className="mn-insight-kind">What lines up</span>
            <p>Website goals from organic search fell by 19 in the same weeks two rankings slipped; goals from paid search fell by 17. The rankings are the first thing to check.</p>
          </div>
        </figure>
      </section>

      <section className="mn-wrap mn-feature mn-feature-flip" aria-labelledby="f2">
        <div className="mn-feature-copy">
          <p className="mn-kicker">SEO and keyword rankings</p>
          <h2 id="f2" className="mn-h2">Know when rankings move, and what moved with them.</h2>
          <p className="mn-body">
            Daily keyword positions sit beside Search Console clicks and Google Analytics goals from organic search, so you can see whether a ranking change
            lines up with a change in traffic and leads, and decide what to look into first.
          </p>
          <ul className="mn-checks">
            <li>Daily rank tracking for the keywords that matter to each client</li>
            <li>Search Console queries and pages, with clicks, impressions and position</li>
            <li>Organic visits and goals from Google Analytics 4, by channel and page</li>
          </ul>
        </div>
        <figure className="mn-shot" aria-label="Keyword rankings for one client. Sample data.">
          <div className="mn-shot-head">
            <span>Keyword rankings, last 30 days</span>
            <span className="mn-sample">Sample data</span>
          </div>
          <table className="mn-rank">
            <thead>
              <tr>
                <th scope="col">Keyword</th>
                <th scope="col">Position</th>
                <th scope="col">Change</th>
                <th scope="col">Clicks</th>
              </tr>
            </thead>
            <tbody>
              <tr><td>emergency dentist</td><td>6</td><td className="tone-down">▼ 4</td><td>212</td></tr>
              <tr><td>dentist near me</td><td>9</td><td className="tone-down">▼ 6</td><td>148</td></tr>
              <tr><td>teeth whitening harbor city</td><td>2</td><td className="tone-up">▲ 3</td><td>96</td></tr>
              <tr><td>dental implants cost</td><td>4</td><td className="tone-up">▲ 1</td><td>74</td></tr>
              <tr><td>invisalign harbor city</td><td>11</td><td className="tone-flat">—</td><td>31</td></tr>
            </tbody>
          </table>
        </figure>
      </section>

      <section className="mn-wrap mn-feature" aria-labelledby="f3">
        <div className="mn-feature-copy">
          <p className="mn-kicker">Budget pacing</p>
          <h2 id="f3" className="mn-h2">Fix the budget on the 9th, not the 31st.</h2>
          <p className="mn-body">
            Spend is checked against every client&apos;s budget every hour. You see where the month will land, the daily spend that lands on budget, and an alert
            when a client drifts.
          </p>
          <ul className="mn-checks">
            <li>Month-end forecast for every client and campaign budget</li>
            <li>The exact daily spend that lands on budget</li>
            <li>Alerts for overspend, underspend, spend spikes and stalled campaigns</li>
          </ul>
        </div>
        <PacingBoard />
      </section>

      <section id="how" className="mn-wrap mn-section" aria-labelledby="tour-title">
        <h2 id="tour-title" className="mn-h2 mn-center">From data to decisions in four steps.</h2>
        <ProductTour />
      </section>

      <section id="why" className="mn-wrap mn-section" aria-labelledby="why-title">
        <h2 id="why-title" className="mn-h2">Why agencies choose {site.appName}</h2>
        <div className="mn-why">
          <div>
            <h3>Answers, not more dashboards</h3>
            <p>Every insight says what happened, what may explain it and what to do, with the figures behind it.</p>
          </div>
          <div>
            <h3>Paid and organic in one view</h3>
            <p>See how ads, rankings, search and the website move together for each client.</p>
          </div>
          <div>
            <h3>No more budget surprises</h3>
            <p>Hourly pacing, month-end forecasts and alerts keep every client on plan.</p>
          </div>
          <div>
            <h3>Reports clients understand</h3>
            <p>Branded, plain-English reports and client logins, sent on your schedule.</p>
          </div>
          <div>
            <h3>Hands off your accounts</h3>
            <p>{site.appName} only reads data. It never changes a campaign, budget or website setting, and data from Google Analytics and Search Console is used only to build your reports. <Link href="/privacy#google">How we handle Google data</Link>.</p>
          </div>
          <div>
            <h3>Built by agency operators</h3>
            <p>Designed by people who have run paid media and SEO for many clients, around the work agencies do every week.</p>
          </div>
        </div>
      </section>

      <section id="start" className="mn-wrap mn-section" aria-labelledby="start-title">
        <div className="mn-start">
          <div>
            <h2 id="start-title">See your own clients&apos; answers this week.</h2>
            <ol className="mn-start-steps">
              <li><strong>Enter your work email.</strong> That&apos;s the whole form.</li>
              <li><strong>Get an invitation by email.</strong> Pick a time for your setup call.</li>
              <li><strong>Connect your first client together.</strong> Ads, Analytics, Search Console and rankings.</li>
              <li><strong>Start with your own data.</strong> Insights, a pacing forecast and a first report.</li>
            </ol>
          </div>
          <div className="mn-start-form">
            <p className="mn-start-label">Early access</p>
            <p className="mn-start-sub">We&apos;re onboarding agencies one at a time.</p>
            <EarlyAccessForm position="start" variant={variant} tone="dark" />
            <p className="mn-start-signin">
              Already have an account? <a href={appLink("/login")}>Sign in</a>
            </p>
          </div>
        </div>
      </section>

      <section id="faq" className="mn-wrap mn-section mn-faq" aria-labelledby="faq-title">
        <h2 id="faq-title" className="mn-h2">Questions</h2>
        <div>
          {FAQ.map((f, i) => (
            <details key={f.q} open={i === 0}>
              <summary>{f.q}</summary>
              <p>{f.a}</p>
            </details>
          ))}
        </div>
      </section>

      <section className="mn-wrap mn-final" aria-labelledby="final-title">
        <h2 id="final-title">Stop reading reports. Start acting on them.</h2>
        <p>All your marketing data in one place, with answers you can act on.</p>
        <EarlyAccessForm position="final" variant={variant} />
      </section>
    </>
  );
}

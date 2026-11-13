import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod/v4";
import type { BetaRunnableTool } from "@anthropic-ai/sdk/lib/tools/BetaRunnableTool";

// The AI assistant drafts text from report data. It never acts on ad
// platforms; everything it writes is shown to a person to review first.

export const AI_MODEL = process.env.ANTHROPIC_MODEL || "claude-opus-5-5";

export function aiConfigured(): boolean {
  return !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

let client: Anthropic | null = null;
export function setAiClientForTests(c: Anthropic | null) {
  client = c;
}
function getClient(): Anthropic {
  return (client ??= new Anthropic());
}

/** An error whose message is safe and useful to show in the UI. */
export class AiError extends Error {}

const BASE_RULES = `You are an analyst at a digital marketing agency, working from the agency's reporting data: paid advertising and, when connected, the client's website analytics, organic search and keyword rankings.

Rules:
- Use only the figures in the DATA block. Never invent numbers, benchmarks, industry averages, or causes. If something can't be judged from the data, say what's missing instead of guessing.
- Quote figures exactly as written in the data; don't recompute them.
- Conversions are platform-reported; don't present them as verified sales.
- "not reported" means the platforms didn't report it, not that it was zero.
- If the data is marked as demo data, say so plainly wherever results are described.
- Nobody has changed anything in the ad platforms. Never claim that a change was made; recommend changes for a person to make.
- The reader may be a business owner with no advertising knowledge. Write plain English: no acronyms (write "cost per click", not CPC; "return on ad spend", not ROAS) and no jargon; when you mention a metric, explain it in a few words the first time (the DATA block has plain definitions under "What the metrics mean").
- Lead with results (the "Results" section of the DATA block: leads, calls, sales, bookings or clicks, and what each cost), then spend, then everything else.
- Don't claim causes you can't see in the data. Use "may" for possible causes ("this may point to the landing page"), and never state a cause as fact.
- Never invent figures, comparisons or explanations. Say "too few to compare" when the data marks a change that way, and don't call a change good or bad when the data says it is normal variation or still being counted.
- Return on ad spend is the sales value the ad platforms credited to the ads for every 1 spent; it is not profit. Say so when you mention it.
- When website, organic search or ranking data is present, connect it to the ad results where the figures support it (for example, more paid clicks but fewer website goals, or organic clicks falling while rankings drop). Say which data each point comes from. Never add ad conversions to website goals; they overlap.
- Keep three things distinct: what the data shows (an observation, with its figures), what may explain it (always "may", never stated as fact), and what to do next.
- Write plain text without Markdown headings, tables or bold.
- Write dates like "Oct 19" (add the year only when it isn't obvious), never as 2026-10-19. Write counts of conversions as whole numbers unless there are fewer than 10.`;

/** Maps SDK errors to messages that are safe to show in the UI. */
function toAiError(e: unknown): unknown {
  if (e instanceof Anthropic.AuthenticationError) return new AiError("The Anthropic API key was rejected. Check ANTHROPIC_API_KEY.");
  if (e instanceof Anthropic.PermissionDeniedError) return new AiError("The Anthropic API key doesn't have access to this model.");
  if (e instanceof Anthropic.RateLimitError) return new AiError("The AI service is busy or the usage limit was reached. Try again in a minute.");
  if (e instanceof Anthropic.APIConnectionError) return new AiError("Couldn't reach the AI service. Check the server's network access.");
  if (e instanceof Anthropic.APIError) return new AiError(`The AI service returned an error (${e.status ?? "unknown"}). Try again.`);
  // The SDK throws while parsing when the JSON is incomplete (e.g. the reply hit max_tokens).
  if (e instanceof Anthropic.AnthropicError) return new AiError("The AI response was cut off or couldn't be read. Try again.");
  return e;
}

async function generate<T extends z.ZodType>(schema: T, task: string, data: string, effort: "low" | "medium" | "high" = "medium"): Promise<z.infer<T>> {
  if (!aiConfigured() && !client) throw new AiError("The AI assistant isn't set up. Add ANTHROPIC_API_KEY to the server environment.");
  let res;
  try {
    res = await getClient().beta.messages.parse({
      model: AI_MODEL,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: BASE_RULES,
      output_config: { effort, format: betaZodOutputFormat(schema) },
      messages: [{ role: "user", content: `<DATA>\n${data}\n</DATA>\n\n${task}` }],
    });
  } catch (e) {
    throw toAiError(e);
  }
  if (res.stop_reason === "refusal") throw new AiError("The AI declined this request. Try rewording your notes.");
  if (res.stop_reason === "max_tokens") throw new AiError("The AI response was cut off. Try again with shorter notes.");
  if (!res.parsed_output) throw new AiError("The AI response couldn't be read. Try again.");
  return res.parsed_output;
}

// --- Suggestions ------------------------------------------------------------

export const SuggestionsSchema = z.object({
  suggestions: z.array(
    z.object({
      title: z.string().describe("Short imperative, e.g. 'Shift budget from X to Y'"),
      priority: z.enum(["high", "medium", "low"]),
      category: z.enum(["budget", "performance", "tracking", "data"]),
      detail: z.string().describe("Two to four sentences: what to do and why"),
      evidence: z.string().describe("The specific figures from the data that support this"),
      impact: z
        .string()
        .nullable()
        .describe("Expected impact only when the data supports a reasonable estimate, as a range with its assumption (e.g. 'about 4–5 more leads this month if spent at the current cost per lead'); null when it can't be estimated. Never a promise."),
    }),
  ),
});
export type Suggestions = z.infer<typeof SuggestionsSchema>;

/** Reads stored suggestions, including ones saved before `impact` existed. */
export const StoredSuggestionsSchema = z.object({
  suggestions: z.array(SuggestionsSchema.shape.suggestions.element.extend({ impact: z.string().nullable().optional() })),
});

export async function generateSuggestions(data: string): Promise<Suggestions> {
  const out = await generate(
    SuggestionsSchema,
    `Review this client's advertising data and give the account manager up to 6 proactive, specific recommendations, most important first.
Look for: budget pacing risks and how much to change daily spend; campaigns or platforms whose cost per result is clearly worse or better than the rest; meaningful changes against the comparison period; tracking gaps (spend with no conversions or leads); stale or estimated data that limits conclusions.
When website, organic search or keyword ranking data is present, also look across channels: organic clicks or rankings falling where paid search could cover the gap (or the reverse), paid traffic rising while website goals fall (a possible landing page or tracking issue), and keywords that moved in or out of the top 10.
In "detail", give the action and, separately, what may explain the finding, using "may". Never state a cause the data doesn't show, and never say anything has already been done.
In "impact", estimate the effect only when the figures support it (for example unspent budget at the current cost per result), as a range with the assumption; otherwise null.
Each recommendation must cite the figures it rests on in "evidence". Skip anything the data doesn't support. If nothing needs attention, return one low-priority suggestion saying so.`,
    data,
    "high",
  );
  return { suggestions: out.suggestions.slice(0, 6) };
}

// --- Report summary ---------------------------------------------------------

const SummarySchema = z.object({ summary: z.string() });

export async function draftReportSummary(data: string, opts: { agencyName: string }): Promise<string> {
  const out = await generate(
    SummarySchema,
    `Write the written summary that opens this client's performance report, from ${opts.agencyName} to the client.
80 to 150 words, two short paragraphs, friendly and plain-spoken. Lead with the results (leads, calls, sales, bookings or clicks, and what each cost) versus the comparison period, then budget pacing, then one or two things the agency will do next ("We'll…"). Never say anything has already been done. No jargon or abbreviations.`,
    data,
  );
  return out.summary.trim();
}

// --- Executive summary ------------------------------------------------------

const ExecSummarySchema = z.object({
  takeaway: z.string().describe("One or two sentences: the single most important takeaway, shown while the summary is collapsed"),
  happened: z.string().describe("What happened? 2 to 4 sentences, 40 to 70 words, overall"),
  channels: z.array(z.object({ channel: z.string(), update: z.string() })).optional().describe("By channel: one short update per listed traffic source, in the listed order, named exactly as listed"),
  meaning: z.string().describe("What does this mean? 2 to 4 sentences, 40 to 70 words, plain English"),
  recommendations: z.array(z.string()).describe("What should we do next? At most three specific actions, most important first, each with why it matters"),
  nextSteps: z.array(z.string()).describe("The same actions rewritten as what the agency will do next, in the agency's voice, e.g. \"We'll move…\""),
});
export type ExecSummaryDraft = z.infer<typeof ExecSummarySchema>;

/**
 * The report's AI Executive Summary: three questions (What happened? What
 * does this mean? What should we do next?) plus a one-line takeaway for the
 * collapsed view, written for a business owner rather than a marketer.
 */
export async function draftExecutiveSummary(data: string, opts: { agencyName: string; days: number; channels?: string[] }): Promise<ExecSummaryDraft> {
  const channels = opts.channels ?? [];
  const out = await generate(
    ExecSummarySchema,
    `Write the executive summary at the top of this client's report, from ${opts.agencyName} to the business owner, for exactly the reporting period in the data. Write like a knowledgeable marketing advisor explaining results to a client in a meeting: conversational, plain English, focused on what it means for the business. The whole summary (happened + meaning + steps) should be about 150 to 250 words, aiming for around 180, and readable in a minute${channels.length ? ", plus about 25 to 40 words for each channel update" : ""}.

takeaway: one or two sentences with the single most important point (for example "You got 42 leads this month, 8 more than last month, and each one cost less."). It is shown on its own while the summary is collapsed, so the sections below must NOT repeat it word for word.

happened ("What happened?"): 2 to 4 sentences, 40 to 70 words. The most important results and what was spent, compared with the previous period, and whether things improved, declined or held steady. Only the most meaningful numbers, in this order of importance: sales, bookings or appointments when tracked; qualified leads and enquiries; phone calls and form submissions; cost per lead or customer; ad spend and budget; website visits; other ad and search figures only when they explain an outcome.

meaning ("What does this mean?"): 2 to 4 sentences, 40 to 70 words. Interpret the results: is marketing becoming more or less effective, are leads getting more or less expensive, what is producing the best results, and any real concern or opportunity. Translate metrics into consequences (not "CTR fell 17% and CPC rose 12%" but "Fewer people are clicking your ads and each visit costs more, which can make leads more expensive").

channels ("By channel"): ${
      channels.length
        ? `exactly one entry for each of these traffic sources, in this order, with "channel" set to the name exactly as written: ${channels.map((c) => `"${c}"`).join(", ")}. Each "update" is one or two plain sentences (25 to 40 words) on what happened in that channel this period and what it means, using that channel's own figures from the data (for ad platforms: spend, results and what each cost, against the previous period; for phone calls: calls, first-time callers and missed calls; for organic search and rankings: search clicks and how positions moved; for website traffic: visits and website goals). If a channel has no figures or too little data, say so plainly in its update. Don't repeat the overall figures from "happened"; this is where the channel detail goes.`
        : "return an empty list."
    }

recommendations ("What should we do next?"): at most three, most important first, each one or two short sentences saying what to do and why it matters, backed by the data (for example "Move more of the budget to the Emergency Repairs campaign, which brings in leads for about half the cost of the others."). Never generic advice like "continue optimizing campaigns". If nothing needs to change, give a single item saying so and why, rather than inventing actions.

nextSteps: the same items, in the same order, as what ${opts.agencyName} will do next ("We'll move…", "We'll check…"), one sentence each, with no internal detail.

Combine every source in the data (each ad platform, phone calls, website, organic search, budget) into one explanation of overall marketing performance; don't summarize each platform separately. For example, if ad clicks rose but tracked calls fell, say that more people visited without more of them calling.

Plain language: avoid jargon. Say "people who clicked" or "click rate" rather than CTR, "cost per click" rather than CPC, "cost per lead" or "cost per result" rather than CPA, "sales credited to the ads for each dollar spent (not profit)" rather than ROAS, "times the ads were shown" rather than impressions, and avoid "attribution", "impression share", "optimization". Call results by what is actually tracked (leads, calls, bookings, sales, or "results" when the data doesn't say); never call every conversion a lead or a sale.

Accuracy: use only figures in the data. State confirmed findings plainly and mark possible explanations with "may" or "possibly"; the agency's dated notes can be a possible cause when dates line up. Missing or "not reported" figures are unknown, never zero; when something important is missing (call tracking not connected, revenue not tracked, results still being counted, too little data for a trend) say so simply, for example "We can see how many enquiries the ads produced, but not yet how many became paying customers." Never add calls, ad conversions and website goals together; they can count the same customer. Never say or imply the agency already changed anything. No greetings or sign-off; list items are plain text with no leading bullet or number.`,
    data,
    "medium",
  );
  const clean = (xs: string[]) => xs.map((x) => x.replace(/^\s*(?:[-•*]|\d+[.)])\s*/, "").trim()).filter(Boolean).slice(0, 3);
  // Keep only the listed channels, in the listed order.
  const byName = new Map((out.channels ?? []).map((c) => [c.channel.trim().toLowerCase(), c.update.trim()]));
  const channelUpdates = channels.map((c) => ({ channel: c, update: byName.get(c.toLowerCase()) ?? "" })).filter((c) => c.update);
  return { takeaway: out.takeaway.trim(), happened: out.happened.trim(), channels: channelUpdates, meaning: out.meaning.trim(), recommendations: clean(out.recommendations), nextSteps: clean(out.nextSteps ?? []) };
}

// --- Client email -----------------------------------------------------------

export const EMAIL_PURPOSES = {
  monthly_update: "Monthly performance update",
  pacing_update: "Budget pacing update",
  results_highlight: "Highlight a strong result",
  custom: "Something else (describe in notes)",
} as const;
export type EmailPurpose = keyof typeof EMAIL_PURPOSES;

const EmailSchema = z.object({ subject: z.string(), body: z.string() });
export type EmailDraft = z.infer<typeof EmailSchema>;

export async function draftClientEmail(
  data: string,
  opts: { purpose: EmailPurpose; notes: string; senderName: string; agencyName: string; recipientName: string | null },
): Promise<EmailDraft> {
  const out = await generate(
    EmailSchema,
    `Draft an email from ${opts.senderName} at ${opts.agencyName} to the client${opts.recipientName ? ` (${opts.recipientName})` : ""}.
Purpose: ${EMAIL_PURPOSES[opts.purpose]}.
${opts.notes.trim() ? `Notes from ${opts.senderName} (follow them; they take priority over your own emphasis, but don't state figures that aren't in the data):\n<NOTES>\n${opts.notes.trim()}\n</NOTES>\n` : ""}
Keep it under 200 words, warm and professional, with short paragraphs and at most one short list. Use only figures from the data. End with a clear next step and sign off as ${opts.senderName}. Return a subject line and a plain-text body.`,
    data,
  );
  return { subject: out.subject.trim().slice(0, 200), body: out.body.trim() };
}

// --- Questions --------------------------------------------------------------

export interface QaTurn {
  question: string;
  answer: string;
}

/**
 * Answers a specific question about one client's advertising. Claude gets the
 * report data up front and can call `tools` (read-only lookups such as ads,
 * headlines, keywords and search terms) when the question needs more detail.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tools of any input shape
export async function answerQuestion(data: string, question: string, history: QaTurn[], tools: BetaRunnableTool<any>[], opts: { periodLabel: string }): Promise<string> {
  if (!aiConfigured() && !client) throw new AiError("The AI assistant isn't set up. Add ANTHROPIC_API_KEY to the server environment.");
  const messages: Anthropic.Beta.BetaMessageParam[] = [];
  // Earlier questions in this session, so follow-ups ("and for Meta?") make sense.
  for (const t of history.slice(-4)) {
    messages.push({ role: "user", content: t.question }, { role: "assistant", content: t.answer });
  }
  messages.push({ role: "user", content: question });
  let final;
  try {
    final = await getClient().beta.messages.toolRunner({
      model: AI_MODEL,
      max_tokens: 16000,
      max_iterations: 8,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: [
        { type: "text", text: BASE_RULES },
        {
          type: "text",
          text: `You answer an account manager's specific questions about one client's advertising for ${opts.periodLabel}.
The report data is below. When a question needs detail below campaign level (ads, headlines and descriptions, keywords, search terms), call get_detail; it reads live, read-only data from the ad platforms for the same dates. Call it only for the kinds you need.
Answer the question directly first, then give the supporting figures, then 1 to 4 specific, actionable recommendations when they follow from the data (for example which headlines to keep, test or replace, which keywords to pause or bid up, which search terms to add as negatives or as keywords).
Rank "top performing" by results (conversions or leads) and cost per result, not by clicks alone, and say what you ranked by. Flag small samples (few impressions or clicks) instead of drawing conclusions from them.
Keep it under 300 words unless the question asks for a full list. Use short paragraphs and simple "- " bullet lists; no tables, headings or bold.

<DATA>
${data}
</DATA>`,
          cache_control: { type: "ephemeral" },
        },
      ],
      output_config: { effort: "medium" },
      tools,
      messages,
    });
  } catch (e) {
    throw toAiError(e);
  }
  if (final.stop_reason === "refusal") throw new AiError("The AI declined this question. Try rewording it.");
  if (final.stop_reason === "max_tokens") throw new AiError("The answer was cut off. Try a narrower question.");
  const text = final.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n").trim();
  if (!text) throw new AiError("The AI didn't produce an answer. Try rewording the question.");
  return text;
}

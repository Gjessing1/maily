/**
 * `summary` — the first LLM enricher (ROADMAP Phase 5: "Summarization + categorization
 * of incoming mail"). Produces a short natural-language summary and a single coarse
 * category for a message via the local Ollama runtime (`llm/`).
 *
 * Classification: `analytical` (summaries/scoring) → runs on ALL tiers, so the historical
 * mailbox is summarised too, and emits NO proposals (it never nags — it feeds triage /
 * the future search index, ARCHITECTURE §14 + the ROADMAP anti-chore guardrail).
 *
 * Cost: `llm` → the runner trickles these in small bounded batches (the Intel N150 guard);
 * a single Ollama generation is serialised single-flight and can take seconds, so we never
 * let the historical backlog starve the cheap deterministic pipeline or block mail sync.
 *
 * Provider is LOCKED to local Ollama (no cloud path): a single-user mailbox's raw mail
 * never leaves the box. The enricher is registered ONLY when `llmEnabled()` (registry.ts),
 * so when Ollama isn't deployed no `summary` rows are ever created and the pipeline runs
 * exactly as in Phase 4.
 *
 * Failure handling is the framework's: an unreachable/timed-out Ollama throws `LlmError`,
 * the row is recorded `failed` and retried with backoff, and a persistently-wedged model
 * eventually dead-letters — it never silently writes a wrong summary.
 */
import { generateJson, llmEnabled, type OllamaOptions } from '../../llm/index.js';
import type { Enricher, EnricherContext, EnricherResult } from '../types.js';

/**
 * Controlled category vocabulary — a small, stable set so the value is usable as a
 * triage / search dimension rather than free-text drift. Tuned for a personal mailbox
 * (EN + NO mail). The model MUST pick exactly one; anything unrecognised is normalised
 * to `other`.
 */
export const SUMMARY_CATEGORIES = [
  'personal', // a real person writing (family, friends, individual correspondence)
  'finance', // invoices, receipts, banking, payments, tax, salary
  'shopping', // orders, shipping/delivery, purchase confirmations
  'travel', // flights, hotels, bookings, itineraries, tickets
  'work', // job / professional / business
  'notification', // automated service alerts, account & security, system messages
  'newsletter', // marketing, promotions, digests, subscriptions
  'social', // social-media and community notifications
  'other', // none of the above
] as const;

export type SummaryCategory = (typeof SUMMARY_CATEGORIES)[number];

/** The analytical facts `summary` persists for one message. */
export interface SummaryFacts {
  /** 1–2 sentence gist, in the email's own language (EN/NO). */
  summary: string;
  /** Exactly one {@link SUMMARY_CATEGORIES} value. */
  category: SummaryCategory;
}

/** Raw model output shape before validation/normalisation. */
interface RawSummary {
  summary?: unknown;
  category?: unknown;
}

// N150 latency budget (see docs/enricher_report.md): on the target CPU a 7B model spends
// most of a generation on prompt-eval, and runs straddle the 120 s timeout. A 1–2 sentence
// gist + category needs only the head of the email, so we keep the prompt small: ~800 body
// chars and a tight num_ctx bound prompt-eval, while num_predict caps the output. This pulls
// the median run well under the timeout without measurably hurting summary quality.
const MAX_BODY_CHARS = 800; // head of the email is enough for a gist; smaller = faster prompt-eval
const NUM_PREDICT = 160; // cap output so a runaway model can't blow the timeout budget
const NUM_CTX = 1024; // bound the context window: prompt (~400 tok) + output (160) fits comfortably

const OPTIONS: OllamaOptions = { temperature: 0, num_predict: NUM_PREDICT, num_ctx: NUM_CTX };

const SYSTEM_PROMPT = [
  'You are an email triage assistant. Given one email, return STRICT JSON with exactly',
  'two fields and nothing else:',
  '  "summary": a 1-2 sentence plain-text gist of what the email is about and any action',
  '            it implies. Write it in the SAME language as the email (Norwegian or English).',
  '            No greeting, no preamble, no markdown.',
  `  "category": EXACTLY one of: ${SUMMARY_CATEGORIES.join(', ')}.`,
  'Choose the single best category. Do not invent new categories. Output JSON only.',
].join('\n');

/** Very light HTML→text strip for the prompt (markup-free, common entities decoded). */
function stripHtml(html: string): string {
  return html
    .replace(/<\s*(script|style)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Best-effort plain-text body for the prompt, truncated. Empty string when none. */
function bodyForPrompt(bodyText: string | null, bodyHtml: string | null): string {
  const text = bodyText?.trim() || (bodyHtml ? stripHtml(bodyHtml) : '');
  return text.length > MAX_BODY_CHARS ? `${text.slice(0, MAX_BODY_CHARS)}…` : text;
}

/** Compose the user prompt from the message's parsed fields. */
function buildPrompt(ctx: EnricherContext['message'], body: string): string {
  const from = [ctx.fromName, ctx.fromAddress].filter(Boolean).join(' ') || '(unknown sender)';
  return [
    `From: ${from}`,
    `Subject: ${ctx.subject ?? '(no subject)'}`,
    '',
    body || '(no body text)',
  ].join('\n');
}

/** Coerce raw model output into validated {@link SummaryFacts}, or null when unusable. */
function normalise(raw: RawSummary): SummaryFacts | null {
  const summary = typeof raw.summary === 'string' ? raw.summary.trim() : '';
  if (!summary) return null;
  const candidate = typeof raw.category === 'string' ? raw.category.trim().toLowerCase() : '';
  const category = (SUMMARY_CATEGORIES as readonly string[]).includes(candidate)
    ? (candidate as SummaryCategory)
    : 'other';
  return { summary, category };
}

export const summaryEnricher: Enricher = {
  name: 'summary',
  // v2: smaller prompt budget for N150 throughput (docs/enricher_report.md). Note a version
  // bump alone does NOT re-run existing rows — backfill only fills missing (message,enricher)
  // pairs; force a re-run of old summaries with reindex({ kind: 'enricher', enricher: 'summary' }).
  version: 2,
  kind: 'analytical',
  cost: 'llm',
  // Skip mail with no usable body to summarise (and stay inert if LLM was disabled after
  // registration — defensive; the registry only registers this when llmEnabled()).
  applies(message) {
    if (!llmEnabled()) return false;
    return Boolean(message.bodyText?.trim() || message.bodyHtml?.trim());
  },
  async run(ctx: EnricherContext): Promise<EnricherResult> {
    const body = bodyForPrompt(ctx.message.bodyText, ctx.message.bodyHtml);
    const raw = await generateJson<RawSummary>({
      system: SYSTEM_PROMPT,
      prompt: buildPrompt(ctx.message, body),
      options: OPTIONS,
      // Keep the model resident across the backlog drain: a cold load on the N150 is huge
      // (~130 s, alone past the timeout), so re-loading per email guarantees timeouts. With
      // this only the first item in a drain pays the load; the rest reuse the warm model.
      keepAlive: '30m',
    });
    return { result: { summary: normalise(raw) } };
  },
};

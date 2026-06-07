/**
 * `summary` LLM enricher coverage (ROADMAP Phase 5). Pure unit tests: we mock global
 * `fetch` so the real `llm/client` runs end-to-end (prompt → /api/generate → JSON-mode
 * parse) against a stubbed Ollama, with no real model and no DB. We pin:
 *  - the analytical/llm classification (so the runner schedules it as bounded LLM work),
 *  - request construction: JSON mode, the controlled category list reaches the system
 *    prompt, and the From/Subject/body are carried in the user prompt,
 *  - body handling: HTML is stripped and long bodies truncated before the model sees them,
 *  - category normalisation: an out-of-vocabulary category collapses to `other`,
 *  - the `applies` gate: bodyless mail and a disabled LLM are skipped.
 *
 * `OLLAMA_URL` is set before the dynamic imports so `llmEnabled()` reports configured —
 * the same "point env, then import" bootstrap the client tests use.
 */
import assert from 'node:assert/strict';
import test, { afterEach, before, mock } from 'node:test';
import type * as SummaryNS from './summary.js';
import type { PipelineMessage } from '../types.js';

process.env.OLLAMA_URL = 'http://ollama.test:11434';
process.env.OLLAMA_MODEL = 'qwen2.5';

let summaryEnricher: (typeof SummaryNS)['summaryEnricher'];
let SUMMARY_CATEGORIES: (typeof SummaryNS)['SUMMARY_CATEGORIES'];
const realFetch = globalThis.fetch;

before(async () => {
  ({ summaryEnricher, SUMMARY_CATEGORIES } = await import('./summary.js'));
});

afterEach(() => {
  globalThis.fetch = realFetch;
  mock.reset();
});

/** A minimal parsed-stage message with overridable fields. */
function msg(overrides: Partial<PipelineMessage> = {}): PipelineMessage {
  return {
    id: 'm1',
    accountId: 'a1',
    threadId: null,
    subject: 'Faktura fra Strømselskap',
    fromName: 'Strøm AS',
    fromAddress: 'noreply@strom.no',
    to: [],
    cc: [],
    snippet: null,
    bodyText: 'Din faktura på 499 kr forfaller 15. juni.',
    bodyHtml: null,
    bodyCalendar: null,
    inReplyTo: null,
    references: null,
    sentAt: null,
    receivedAt: new Date(),
    sourcePath: null,
    ...overrides,
  };
}

/** Stub an Ollama /api/generate response carrying `response` as a JSON string. */
function ollamaJson(payload: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({ response: JSON.stringify(payload) }),
    text: async () => '',
  } as unknown as Response;
}

test('is registered as analytical/llm so the runner schedules it as bounded LLM work', () => {
  assert.equal(summaryEnricher.kind, 'analytical');
  assert.equal(summaryEnricher.cost, 'llm');
});

test('run posts JSON-mode generate and returns the normalised summary + category', async () => {
  const fetchMock = mock.fn(async () =>
    ollamaJson({ summary: 'Faktura på 499 kr forfaller 15. juni.', category: 'finance' }),
  );
  globalThis.fetch = fetchMock as unknown as typeof fetch;

  const out = await summaryEnricher.run({ message: msg(), tier: 0 });
  assert.deepEqual(out, {
    result: { summary: { summary: 'Faktura på 499 kr forfaller 15. juni.', category: 'finance' } },
  });

  assert.equal(fetchMock.mock.calls.length, 1);
  const [url, init] = fetchMock.mock.calls[0]!.arguments as unknown as [string, RequestInit];
  assert.equal(url, 'http://ollama.test:11434/api/generate');
  const body = JSON.parse(init.body as string);
  assert.equal(body.format, 'json');
  // The controlled vocabulary is pinned in the system prompt …
  for (const cat of SUMMARY_CATEGORIES) assert.match(body.system, new RegExp(cat));
  // … and the message fields are carried in the user prompt.
  assert.match(body.prompt, /Strøm AS/);
  assert.match(body.prompt, /Faktura fra Strømselskap/);
  assert.match(body.prompt, /forfaller 15\. juni/);
});

test('falls back to the HTML body (stripped) when there is no text part', async () => {
  const fetchMock = mock.fn(async () => ollamaJson({ summary: 's', category: 'shopping' }));
  globalThis.fetch = fetchMock as unknown as typeof fetch;

  await summaryEnricher.run({
    message: msg({ bodyText: null, bodyHtml: '<p>Your <b>order</b> shipped</p>' }),
    tier: 0,
  });
  const body = JSON.parse(
    (fetchMock.mock.calls[0]!.arguments as unknown as [string, RequestInit])[1].body as string,
  );
  assert.match(body.prompt, /Your order shipped/); // tags stripped
  assert.doesNotMatch(body.prompt, /<p>|<b>/);
});

test('truncates a very long body before sending it to the model', async () => {
  const fetchMock = mock.fn(async () => ollamaJson({ summary: 's', category: 'other' }));
  globalThis.fetch = fetchMock as unknown as typeof fetch;

  const huge = 'a'.repeat(5000);
  await summaryEnricher.run({ message: msg({ bodyText: huge }), tier: 0 });
  const body = JSON.parse(
    (fetchMock.mock.calls[0]!.arguments as unknown as [string, RequestInit])[1].body as string,
  );
  assert.ok(body.prompt.length < 2500, 'prompt is bounded'); // headers + ~1500 body + ellipsis
  assert.match(body.prompt, /…$/);
});

test('an out-of-vocabulary category is normalised to "other"', async () => {
  globalThis.fetch = mock.fn(async () =>
    ollamaJson({ summary: 'gist', category: 'spaceship' }),
  ) as never;

  const out = await summaryEnricher.run({ message: msg(), tier: 0 });
  assert.deepEqual(out, { result: { summary: { summary: 'gist', category: 'other' } } });
});

test('a model reply with no usable summary yields a null result (no fabrication)', async () => {
  globalThis.fetch = mock.fn(async () => ollamaJson({ category: 'finance' })) as never;
  const out = await summaryEnricher.run({ message: msg(), tier: 0 });
  assert.deepEqual(out, { result: { summary: null } });
});

test('applies() skips mail with no body to summarise', () => {
  assert.equal(summaryEnricher.applies!(msg({ bodyText: null, bodyHtml: null })), false);
  assert.equal(summaryEnricher.applies!(msg({ bodyText: '  ', bodyHtml: null })), false);
  assert.equal(summaryEnricher.applies!(msg()), true);
});

test('applies() skips when the LLM is not configured (defensive)', () => {
  const saved = process.env.OLLAMA_URL;
  delete process.env.OLLAMA_URL;
  try {
    assert.equal(summaryEnricher.applies!(msg()), false);
  } finally {
    process.env.OLLAMA_URL = saved;
  }
});

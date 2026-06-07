/**
 * Lean hand-rolled Ollama HTTP client (ROADMAP Phase 5). Zero new deps — talks to Ollama's
 * REST API over global `fetch` (Node 20+). Provider is LOCKED to local Ollama; there is no
 * cloud path (privacy: a single-user mailbox's raw mail never leaves the box).
 *
 * Forward-looking surface: the next phase adds enrichers (summarization, categorization,
 * VIP scoring, purchase gap-fill) that all call {@link generate} / {@link chat}. Those
 * enrichers MUST gate on `llmEnabled()` (config.ts) before constructing a client.
 *
 * Two non-negotiable runtime properties for the target Intel N150 box:
 *  1. SINGLE-FLIGHT — at most ONE generation runs at a time (see {@link runExclusive}). The
 *     N150 is a low-power shared host; a second concurrent generation would pin every core
 *     and throttle the mail sync / web server sitting next to it. Single-user mail volume is
 *     low, so serialising costs us nothing in practice and keeps us a good neighbour.
 *  2. BOUNDED — every call is wrapped in an AbortController timeout (config `timeoutMs`), so a
 *     wedged model can never hold the single-flight lock forever.
 */
import { createLogger } from '../logger.js';
import { getLlmConfig, requireLlmConfig, type LlmConfig } from './config.js';

const log = createLogger('llm');

/** Typed error so callers can branch on LLM failure without string-matching messages. */
export class LlmError extends Error {
  constructor(
    message: string,
    /** 'unreachable' = Ollama down/refused; 'timeout' = exceeded timeoutMs; 'http' = non-2xx; 'parse' = bad JSON. */
    readonly kind: 'unreachable' | 'timeout' | 'http' | 'parse' | 'disabled',
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'LlmError';
  }
}

/** Ollama generation options (subset; passed through verbatim under `options`). */
export interface OllamaOptions {
  /** Sampling temperature (0 = deterministic). Extraction enrichers will want this low. */
  temperature?: number;
  /** Cap output length so a runaway model can't blow the timeout budget. */
  num_predict?: number;
  /** Context window; left to Ollama's model default when unset. */
  num_ctx?: number;
  [key: string]: unknown;
}

export interface GenerateParams {
  /** Override the configured default model for this call. */
  model?: string;
  prompt: string;
  /** System prompt — the place to pin behaviour/guardrails for an enricher. */
  system?: string;
  /** `'json'` puts Ollama in JSON mode; the completion is then valid JSON text. */
  format?: 'json';
  options?: OllamaOptions;
  /** Override the per-call timeout (ms) for this request only. */
  timeoutMs?: number;
  /** Caller-supplied cancellation; combined with the internal timeout signal. */
  signal?: AbortSignal;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatParams {
  model?: string;
  messages: ChatMessage[];
  format?: 'json';
  options?: OllamaOptions;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/* ----------------------------------------------------------------------------------------
 * Single-flight serialisation (the N150 CPU guard).
 *
 * A simple promise-chain mutex: each task appends itself to a tail promise, so tasks run
 * strictly one-at-a-time in submission order regardless of how many callers fire at once.
 * Errors are swallowed on the *chain* (caught) so one failed generation doesn't poison the
 * queue for the next; the real result/rejection is still delivered to that task's caller.
 * -------------------------------------------------------------------------------------- */
let queueTail: Promise<unknown> = Promise.resolve();

function runExclusive<T>(task: () => Promise<T>): Promise<T> {
  const run = queueTail.then(task, task);
  // Keep the chain alive but un-rejected for the next waiter.
  queueTail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * Wrap a fetch in an AbortController bounded by `timeoutMs`, optionally chained to a
 * caller-supplied `signal`. Translates the various network/abort failure shapes into a
 * typed {@link LlmError} so callers (and tests) get a stable contract.
 */
async function fetchJson(
  cfg: LlmConfig,
  path: string,
  body: unknown,
  timeoutMs: number,
  external?: AbortSignal,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
  const onExternalAbort = () => controller.abort(external?.reason);
  if (external) {
    if (external.aborted) controller.abort(external.reason);
    else external.addEventListener('abort', onExternalAbort, { once: true });
  }

  try {
    const res = await fetch(`${cfg.url}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new LlmError(`Ollama HTTP ${res.status} on ${path}: ${detail.slice(0, 200)}`, 'http');
    }
    try {
      return await res.json();
    } catch (cause) {
      throw new LlmError(`Ollama returned non-JSON on ${path}`, 'parse', { cause });
    }
  } catch (err) {
    if (err instanceof LlmError) throw err;
    // AbortController.abort fires an AbortError on the fetch; distinguish our timeout.
    if (controller.signal.aborted) {
      const reason = controller.signal.reason;
      if (reason instanceof Error && reason.message === 'timeout') {
        throw new LlmError(`Ollama call timed out after ${timeoutMs}ms`, 'timeout', { cause: err });
      }
      // External cancellation — re-surface as-is shape but typed.
      throw new LlmError('Ollama call aborted', 'timeout', { cause: err });
    }
    // fetch rejects (ECONNREFUSED / DNS / network) → Ollama is optional infra; be graceful.
    throw new LlmError(`Ollama unreachable at ${cfg.url}`, 'unreachable', { cause: err });
  } finally {
    clearTimeout(timer);
    if (external) external.removeEventListener('abort', onExternalAbort);
  }
}

/**
 * Single completion via Ollama `/api/generate`. Returns the raw `response` text (for
 * `format: 'json'` this is a JSON string the caller parses). Serialised single-flight.
 */
export function generate(params: GenerateParams): Promise<string> {
  const cfg = requireLlmConfig();
  const body = {
    model: params.model ?? cfg.model,
    prompt: params.prompt,
    ...(params.system !== undefined ? { system: params.system } : {}),
    ...(params.format ? { format: params.format } : {}),
    ...(params.options ? { options: params.options } : {}),
    stream: false,
  };
  const timeoutMs = params.timeoutMs ?? cfg.timeoutMs;
  return runExclusive(async () => {
    const json = (await fetchJson(cfg, '/api/generate', body, timeoutMs, params.signal)) as {
      response?: unknown;
    };
    if (typeof json.response !== 'string') {
      throw new LlmError('Ollama /api/generate missing string "response"', 'parse');
    }
    return json.response;
  });
}

/**
 * Multi-turn completion via Ollama `/api/chat`. Returns the assistant message content.
 * Serialised single-flight, same as {@link generate}.
 */
export function chat(params: ChatParams): Promise<string> {
  const cfg = requireLlmConfig();
  const body = {
    model: params.model ?? cfg.model,
    messages: params.messages,
    ...(params.format ? { format: params.format } : {}),
    ...(params.options ? { options: params.options } : {}),
    stream: false,
  };
  const timeoutMs = params.timeoutMs ?? cfg.timeoutMs;
  return runExclusive(async () => {
    const json = (await fetchJson(cfg, '/api/chat', body, timeoutMs, params.signal)) as {
      message?: { content?: unknown };
    };
    const content = json.message?.content;
    if (typeof content !== 'string') {
      throw new LlmError('Ollama /api/chat missing message.content', 'parse');
    }
    return content;
  });
}

/**
 * Convenience over {@link generate} with `format: 'json'`: returns the parsed object, or
 * throws an {@link LlmError} with kind `'parse'` if the model emits invalid JSON. The
 * extraction enrichers (categorization, purchase gap-fill) are the intended callers.
 */
export async function generateJson<T = unknown>(
  params: Omit<GenerateParams, 'format'>,
): Promise<T> {
  const raw = await generate({ ...params, format: 'json' });
  try {
    return JSON.parse(raw) as T;
  } catch (cause) {
    throw new LlmError('Ollama JSON-mode output was not valid JSON', 'parse', { cause });
  }
}

/**
 * Lightweight reachability probe (`GET /api/tags`), bounded by `timeoutMs`. Useful for a
 * startup/health check before registering an enricher. Returns false (never throws) when
 * unconfigured or unreachable, so it's safe to call unconditionally.
 */
export async function ping(timeoutMs = 3000): Promise<boolean> {
  const cfg = getLlmConfig();
  if (!cfg) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${cfg.url}/api/tags`, { signal: controller.signal });
    return res.ok;
  } catch (err) {
    log.debug('ping failed', err);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

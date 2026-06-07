/**
 * LLM runtime configuration (ROADMAP Phase 5). Thin wrapper over `env.ollama` that gives
 * the rest of the LLM module a single, typed read of "are we configured, and with what".
 *
 * Provider is LOCKED to local Ollama (ARCHITECTURE / ROADMAP §5): a single-user mailbox's
 * raw mail (invoices, password resets, contacts) must never leave the box, so there is no
 * Claude/OpenAI/cloud path and no external cost/cache controls to model here.
 *
 * LLM features are OFF unless `OLLAMA_URL` is explicitly set — every future enricher must
 * gate on `llmEnabled()` so the pipeline runs unchanged when Ollama isn't deployed.
 */
import { env } from '../env.js';

export interface LlmConfig {
  /** Ollama REST base URL, trailing slash stripped (e.g. http://localhost:11434). */
  url: string;
  /** Default model id used when a call doesn't override it (multilingual EN/NO). */
  model: string;
  /** Per-call timeout in ms; bounds every generation so the queue can't wedge. */
  timeoutMs: number;
}

/** True when Ollama is configured (i.e. `OLLAMA_URL` is set) and LLM features may run. */
export function llmEnabled(): boolean {
  return env.ollama() !== null;
}

/**
 * Resolve the LLM config, or `null` when not configured. Callers that have already checked
 * {@link llmEnabled} can use {@link requireLlmConfig} for a non-null result instead.
 */
export function getLlmConfig(): LlmConfig | null {
  return env.ollama();
}

/**
 * Like {@link getLlmConfig} but throws when unconfigured — for code paths that should only
 * run after an `llmEnabled()` gate (keeps the happy path free of null checks).
 */
export function requireLlmConfig(): LlmConfig {
  const cfg = env.ollama();
  if (!cfg) {
    throw new Error('LLM not configured: set OLLAMA_URL to enable Ollama enrichment.');
  }
  return cfg;
}

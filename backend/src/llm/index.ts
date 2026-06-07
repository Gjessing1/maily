/**
 * Public surface of the local-LLM runtime (ROADMAP Phase 5 foundation). Phase-5 enrichers
 * import from here. Provider is LOCKED to local Ollama — no cloud path.
 *
 * Typical enricher usage:
 *   import { llmEnabled, generateJson } from '../llm/index.js';
 *   if (!llmEnabled()) return;                  // pipeline runs unchanged without Ollama
 *   const out = await generateJson<MyShape>({ system, prompt, options: { temperature: 0 } });
 */
export { llmEnabled, getLlmConfig, requireLlmConfig, type LlmConfig } from './config.js';
export {
  generate,
  chat,
  generateJson,
  ping,
  LlmError,
  type GenerateParams,
  type ChatParams,
  type ChatMessage,
  type OllamaOptions,
} from './client.js';

/**
 * Enrichment-pipeline status (Settings → Enrichment, shown alongside Sync stats).
 * Read-only: row counts derived from the SQLite `enrichments` ledger (restart-safe,
 * source of truth) plus the worker's ephemeral "currently working on" signal held on
 * the main thread (`worker/host`). LLM counts are surfaced separately because the
 * Ollama backlog is the slow part the user watches catch up (ROADMAP Phase 5).
 */
import type { FastifyInstance } from 'fastify';
import type { EnrichmentStatusDto } from '@maily/shared';
import { enrichmentProgress } from '../../pipeline/index.js';
import { getLlmConfig, llmEnabled } from '../../llm/index.js';
import { getCurrentEnrichment } from '../../worker/host.js';

export async function pipelineRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/enrichment/status', async (): Promise<EnrichmentStatusDto> => {
    const { overall, llm } = enrichmentProgress();
    return {
      llmEnabled: llmEnabled(),
      model: getLlmConfig()?.model ?? null,
      overall,
      llm,
      current: getCurrentEnrichment(),
    };
  });
}

/**
 * Age-tiering (ARCHITECTURE §14). The pipeline processes old mail too — search +
 * analytical enrichment of history is valuable (it powers tags/entities/future
 * semantic search) — but **operational** side effects are time-boxed by age so a
 * deep backfill can never fire a years-old calendar event or "your package shipped"
 * push.
 *
 *  - Tier 0: age ≤ `MAILY_PIPELINE_HORIZON_DAYS` — ALL enrichers, incl. operational.
 *  - Tier 1: older — search + analytical only (operational suppressed).
 *  - Tier 2: deep archive — indexed lazily / via reindex, not auto-enqueued. Modelled
 *    as the absence of enrichment rows until a reindex (or the self-heal backfill)
 *    reaches the message; `tierForMessage` itself only ever returns 0 or 1 for mail
 *    that is being actively enqueued.
 *
 * Undated mail (no `receivedAt`) is treated as Tier 1 — the conservative choice that
 * suppresses operational side effects on mail we can't age-check.
 */
import { env } from '../env.js';
import type { Tier } from './types.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Tier a message falls into by age. Only returns 0 (recent) or 1 (older). */
export function tierForMessage(receivedAt: Date | null, now: Date = new Date()): Tier {
  if (!receivedAt) return 1;
  const ageDays = (now.getTime() - receivedAt.getTime()) / DAY_MS;
  return ageDays <= env.pipelineHorizonDays ? 0 : 1;
}

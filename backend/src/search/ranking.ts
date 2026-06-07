/**
 * Search ranking strategy (ROADMAP §3.7.D / Phase 4 Query Contract Layer — the
 * "ranking strategy" half of the contract). The canonical query IR (`query.ts`)
 * decides *what* matches; the ranker decides *what order* matches come back in.
 *
 * The seam is deliberately **retrieve-then-rerank**: the FTS5 index returns a
 * cheap over-fetched candidate set ordered by raw bm25, and a pluggable `Ranker`
 * scores each candidate to produce the final order. Today's default ranker is
 * `bm25 + recency + importance`; a future vector reranker (Phase 6, VISION §5)
 * slots in here as another `Ranker` over the same `RankCandidate` shape — no
 * change to retrieval, the IR, or callers.
 *
 * Scores are "higher is better". FTS5's own `rank`/`bm25()` is the opposite
 * (more-negative = more relevant), so we flip it into a positive relevance term
 * before blending in the boosts.
 */

/** A retrieval candidate: the relevance signal plus the fields the boosts read. */
export interface RankCandidate {
  id: string;
  /** Raw FTS5 bm25 score for this row (more-negative = more relevant). */
  bm25: number;
  /** `received_at` in epoch ms, or null if the date is unknown. */
  receivedAtMs: number | null;
  /** Starred/`\Flagged` — our standing importance proxy until LLM VIP scoring (Phase 5). */
  flagged: boolean;
}

/** A pluggable ordering over candidates. Higher `score` sorts first. */
export interface Ranker {
  readonly name: string;
  /** Score one candidate; `now` is injected so ranking is deterministic/testable. */
  score(c: RankCandidate, now: number): number;
}

/**
 * Tunable weights for the default blend. Kept modest so relevance stays dominant
 * and the boosts act as tie-breakers between comparably-relevant hits rather than
 * dragging an off-topic-but-recent message above a strong match.
 */
export interface BlendWeights {
  /** Max additive boost for a brand-new message (decays toward 0 with age). */
  recency: number;
  /** Additive boost applied once to a flagged/important message. */
  importance: number;
  /** Age at which the recency boost has decayed to half, in days. */
  recencyHalfLifeDays: number;
}

export const DEFAULT_WEIGHTS: BlendWeights = {
  recency: 2,
  importance: 1.5,
  recencyHalfLifeDays: 180,
};

const DAY_MS = 86_400_000;

/**
 * Rational decay in [0,1]: 1 for "just now", 0.5 at one half-life, →0 for ancient
 * mail. Cheaper and gentler-tailed than an exponential, and never negative so old
 * mail is only ever *not boosted*, never penalised below its bm25 relevance.
 */
function recencyScore(receivedAtMs: number | null, now: number, halfLifeDays: number): number {
  if (receivedAtMs === null) return 0;
  const ageDays = Math.max(0, (now - receivedAtMs) / DAY_MS);
  return 1 / (1 + ageDays / halfLifeDays);
}

/** The default `bm25 + recency + importance` ranker. */
export function blendRanker(weights: BlendWeights = DEFAULT_WEIGHTS): Ranker {
  return {
    name: 'blend.v1',
    score(c, now) {
      const relevance = -c.bm25; // flip so higher = more relevant
      const recency =
        weights.recency * recencyScore(c.receivedAtMs, now, weights.recencyHalfLifeDays);
      const importance = c.flagged ? weights.importance : 0;
      return relevance + recency + importance;
    },
  };
}

/** The active ranker. A single seam to swap in alternatives (e.g. a vector reranker). */
export const defaultRanker: Ranker = blendRanker();

/**
 * Rerank candidates with `ranker` and return the top `limit` ids, best first.
 * Sort is stable on ties via the candidates' incoming (bm25) order.
 */
export function rankCandidates(
  candidates: RankCandidate[],
  limit: number,
  ranker: Ranker = defaultRanker,
  now: number = Date.now(),
): string[] {
  const scored = candidates.map((c, i) => ({ id: c.id, i, s: ranker.score(c, now) }));
  scored.sort((a, b) => b.s - a.s || a.i - b.i);
  return scored.slice(0, limit).map((x) => x.id);
}

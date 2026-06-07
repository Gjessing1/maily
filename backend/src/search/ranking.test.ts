/**
 * Search ranking coverage (ROADMAP §3.7.D / Phase 4 Query Contract Layer).
 *
 * Pins the blend ranker's load-bearing behaviour: relevance stays dominant, the
 * recency boost only ever breaks ties between comparable hits (never drags an
 * off-topic-but-recent message over a strong match), importance lifts flagged
 * mail, ties are stable, and `limit` truncates. Pure module — no DB/env, so no
 * fixture setup; `now` is injected for determinism.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { blendRanker, rankCandidates, type RankCandidate } from './ranking.js';

const NOW = Date.UTC(2026, 5, 7);
const DAY = 86_400_000;

function cand(p: Partial<RankCandidate> & { id: string }): RankCandidate {
  return { bm25: -1, receivedAtMs: NOW, flagged: false, ...p };
}

test('higher bm25 relevance wins by default', () => {
  const strong = cand({ id: 'strong', bm25: -8, receivedAtMs: NOW - 365 * DAY });
  const weak = cand({ id: 'weak', bm25: -1, receivedAtMs: NOW });
  assert.deepEqual(rankCandidates([weak, strong], 10, blendRanker(), NOW), ['strong', 'weak']);
});

test('recency breaks ties between comparably-relevant hits', () => {
  const recent = cand({ id: 'recent', bm25: -2, receivedAtMs: NOW });
  const old = cand({ id: 'old', bm25: -2, receivedAtMs: NOW - 5 * 365 * DAY });
  assert.deepEqual(rankCandidates([old, recent], 10, blendRanker(), NOW), ['recent', 'old']);
});

test('a small relevance edge is not overturned by recency', () => {
  // weights: recency max +2; a +2 bm25 gap exceeds the largest possible recency swing.
  const relevantOld = cand({ id: 'relevant', bm25: -5, receivedAtMs: NOW - 3 * 365 * DAY });
  const weakNew = cand({ id: 'weak', bm25: -1, receivedAtMs: NOW });
  assert.deepEqual(rankCandidates([weakNew, relevantOld], 10, blendRanker(), NOW), [
    'relevant',
    'weak',
  ]);
});

test('flagged mail gets the importance boost over an equal unflagged hit', () => {
  const flagged = cand({ id: 'flagged', bm25: -2, flagged: true });
  const plain = cand({ id: 'plain', bm25: -2, flagged: false });
  assert.deepEqual(rankCandidates([plain, flagged], 10, blendRanker(), NOW), ['flagged', 'plain']);
});

test('null receivedAt gets no recency boost (not a crash, not a max boost)', () => {
  const dated = cand({ id: 'dated', bm25: -2, receivedAtMs: NOW });
  const undatedSame = cand({ id: 'undated', bm25: -2, receivedAtMs: null });
  assert.deepEqual(rankCandidates([undatedSame, dated], 10, blendRanker(), NOW), [
    'dated',
    'undated',
  ]);
});

test('ties preserve incoming (bm25) order; limit truncates', () => {
  const a = cand({ id: 'a' });
  const b = cand({ id: 'b' });
  const c = cand({ id: 'c' });
  assert.deepEqual(rankCandidates([a, b, c], 2, blendRanker(), NOW), ['a', 'b']);
});

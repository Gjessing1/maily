/**
 * Per-day IMAP download byte budget (ROADMAP §3.7.E) — the single throttle authority
 * shared by the live full-source capture and the historical sweep. Gmail caps IMAP
 * downloads at ~2.5 GB/day; breaching it gets the account throttled, so every byte we
 * pull off the wire for *source* is accounted here.
 *
 * The window is the UTC calendar day. State is in-memory: a process restart resets
 * the running total, which can in the worst case allow up to one extra budget's worth
 * of download across a restart boundary. That is acceptable for the live path (low
 * volume) and is hardened into a persisted watermark by the sweep controller (E3),
 * which is the heavy consumer.
 */
import { env } from '../env.js';

function utcDay(): number {
  return Math.floor(Date.now() / 86_400_000);
}

let day = utcDay();
let spent = 0;

function roll(): void {
  const today = utcDay();
  if (today !== day) {
    day = today;
    spent = 0;
  }
}

/** Bytes still available to download in the current UTC day (never negative). */
export function budgetRemaining(): number {
  roll();
  return Math.max(0, env.dailyDownloadBudgetBytes - spent);
}

/** Whether there is any budget left to start another source download today. */
export function canDownloadSource(): boolean {
  return budgetRemaining() > 0;
}

/** Record bytes pulled off the wire against today's budget. */
export function recordDownloadedBytes(bytes: number): void {
  roll();
  spent += Math.max(0, bytes);
}

/** Bytes spent so far today — for observability / logging. */
export function budgetSpent(): number {
  roll();
  return spent;
}

/**
 * Per-day IMAP download byte budget (ROADMAP §3.7.E) — the single throttle authority
 * shared by the live full-source capture and the historical sweep. Gmail caps IMAP
 * downloads at ~2.5 GB/day; breaching it gets the account throttled, so every byte we
 * pull off the wire for *source* is accounted here.
 *
 * The window is the UTC calendar day. State is persisted in the `app_settings` KV table
 * (one `download_budget` row) rather than in process memory, for two reasons:
 *   - it is **process-global by construction** — the sync worker thread (which owns the
 *     heavy sweep) and the main thread (live capture) each hold their own better-sqlite3
 *     connection, so a shared in-memory counter could not span them; SQLite is the shared
 *     medium (WAL permits multi-connection concurrency, ARCHITECTURE §1/§12);
 *   - it **survives restarts**, so a process bounce no longer resets the day's spend and
 *     can no longer allow up to one extra budget's worth of download across the boundary.
 * The read-modify-write in `recordDownloadedBytes` runs in a transaction so the two
 * connections' increments serialise (busy_timeout, `db/client.ts`).
 */
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { appSettings } from '../db/schema.js';
import { env } from '../env.js';

/** Well-known KV key for the daily download-budget counter. */
const BUDGET_KEY = 'download_budget';

interface BudgetState {
  /** UTC day index (days since epoch) the `spent` total belongs to. */
  day: number;
  /** Source bytes pulled off the wire so far during `day`. */
  spent: number;
}

function utcDay(): number {
  return Math.floor(Date.now() / 86_400_000);
}

/** Read the stored counter, rolling it to a fresh zero total when the UTC day advanced. */
function readState(): BudgetState {
  const today = utcDay();
  const row = db
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(eq(appSettings.key, BUDGET_KEY))
    .get();
  if (row) {
    try {
      const parsed = JSON.parse(row.value) as Partial<BudgetState>;
      if (parsed.day === today && typeof parsed.spent === 'number') {
        return { day: today, spent: Math.max(0, parsed.spent) };
      }
    } catch {
      // fall through to a fresh state
    }
  }
  return { day: today, spent: 0 };
}

function writeState(state: BudgetState): void {
  const json = JSON.stringify(state);
  db.insert(appSettings)
    .values({ key: BUDGET_KEY, value: json, updatedAt: new Date() })
    .onConflictDoUpdate({ target: appSettings.key, set: { value: json, updatedAt: new Date() } })
    .run();
}

/** Bytes still available to download in the current UTC day (never negative). */
export function budgetRemaining(): number {
  return Math.max(0, env.dailyDownloadBudgetBytes - readState().spent);
}

/** Whether there is any budget left to start another source download today. */
export function canDownloadSource(): boolean {
  return budgetRemaining() > 0;
}

/** Record bytes pulled off the wire against today's budget (atomic read-modify-write). */
export function recordDownloadedBytes(bytes: number): void {
  if (bytes <= 0) return;
  db.transaction(() => {
    const state = readState();
    writeState({ day: state.day, spent: state.spent + bytes });
  });
}

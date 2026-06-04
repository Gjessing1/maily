/**
 * Shared sync worker — runs inside a Node `worker_threads` Worker (ROADMAP §3.7.E).
 *
 * Why a worker: `better-sqlite3` is synchronous, so the full-source sweep's upserts and
 * its `.eml` parsing block the event loop when run on the main thread — stalling INBOX
 * IDLE handling and HTTP responses. Isolating the IMAP *socket* on a transient connection
 * (as the old main-thread sweep did) does not isolate the *CPU*; a worker thread does.
 *
 * This worker owns its **own** `better-sqlite3` connection — simply importing `db/client.js`
 * in this fresh isolate opens a separate handle to the same WAL database (multi-connection
 * concurrency, ARCHITECTURE §1/§12) — and its **own** transient `ImapFlow` connections, so
 * nothing here touches the main thread's persistent INBOX IDLE connection (ARCHITECTURE §2/§9).
 *
 * Jobs are processed **serially** (one heavy op at a time across the whole process): simplest,
 * and it keeps a single consumer drawing on the shared per-day byte budget (`budget.ts`, now
 * persisted in `app_settings` so it spans both threads).
 */
import { parentPort } from 'node:worker_threads';
import type { AccountConfig } from '../config/accounts.js';
import { loadAccountConfigs } from '../config/accounts.js';
import { createLogger } from '../logger.js';
import { createClient } from '../imap/connection.js';
import { budgetRemaining, canDownloadSource } from '../imap/budget.js';
import { getFolderById, syncFolders } from '../imap/folders.js';
import { sweepFolderSource, syncContext } from '../imap/sync.js';
import type { MainToWorker, SweepJob, WorkerToMain } from './protocol.js';

const log = createLogger('worker');

if (!parentPort) {
  throw new Error('worker/index.ts must be run as a worker_threads Worker');
}
const port = parentPort;

function post(msg: WorkerToMain): void {
  port.postMessage(msg);
}

/** Resolve an account's connection config (with credentials) from the inherited env. */
function configForEmail(email: string): AccountConfig | undefined {
  return loadAccountConfigs().find((c) => c.email === email);
}

/**
 * One full-source sweep pass for an account, over a transient connection. Lifted from the
 * old `engine.ts:runSourceSweep`; the per-folder work (`sweepFolderSource`) is unchanged.
 * The shared daily byte budget gates the work — a pass stops as soon as the budget is spent.
 */
async function runSweep(job: SweepJob): Promise<void> {
  const config = configForEmail(job.email);
  if (!config) {
    post({ type: 'error', accountId: job.accountId, message: `no config for ${job.email}` });
    return;
  }
  if (!canDownloadSource()) return; // budget spent for today — main retries on a later tick

  const accountLog = createLogger(`worker:${job.email}`);
  const client = createClient(config);
  try {
    await client.connect();
    const ctx = syncContext(client, job.accountId, accountLog);
    const folders = await syncFolders(client, job.accountId);
    for (const folder of folders) {
      if (!canDownloadSource()) break;
      const fresh = getFolderById(folder.id);
      if (!fresh) continue;
      const r = await sweepFolderSource(ctx, fresh);
      if (r.archived || r.inserted) {
        const leftMb = Math.round(budgetRemaining() / 1e6);
        accountLog.info(
          `${folder.path} sweep: ↑${r.archived} +${r.inserted}` +
            `${r.done ? ' (folder complete)' : ''} — ${leftMb}MB budget left`,
        );
      }
    }
  } catch (err) {
    post({ type: 'error', accountId: job.accountId, message: (err as Error).message });
  } finally {
    try {
      await client.logout();
    } catch {
      client.close();
    }
    post({ type: 'sweep:done', accountId: job.accountId });
  }
}

// --- Serial job queue -------------------------------------------------------------------
// A queue with per-account dedup: if a sweep for an account is already queued or running,
// drop the new one (mirrors the old `sweepBusy` guard — no point stacking sweeps).
const queue: SweepJob[] = [];
let running = false;
let activeAccountId: string | null = null;

async function drain(): Promise<void> {
  if (running) return;
  running = true;
  try {
    let job: SweepJob | undefined;
    while ((job = queue.shift())) {
      activeAccountId = job.accountId;
      await runSweep(job);
      activeAccountId = null;
    }
  } finally {
    running = false;
  }
}

port.on('message', (msg: MainToWorker) => {
  if (msg.type === 'shutdown') {
    // Let the in-flight job finish naturally; stop accepting more and exit when idle.
    queue.length = 0;
    const exitWhenIdle = (): void => {
      if (running) setTimeout(exitWhenIdle, 100);
      else process.exit(0);
    };
    exitWhenIdle();
    return;
  }
  if (msg.type === 'sweep') {
    const dup =
      activeAccountId === msg.accountId || queue.some((j) => j.accountId === msg.accountId);
    if (!dup) queue.push(msg);
    void drain();
  }
});

log.info('sync worker started');

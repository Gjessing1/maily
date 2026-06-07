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
import { drainPipeline } from '../pipeline/index.js';
import { llmEnabled } from '../llm/index.js';
import { env } from '../env.js';
import type { EnrichJob, MainToWorker, SweepJob, WorkerToMain } from './protocol.js';

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

/**
 * Drain due enrichment work in two cost-scoped phases (Phase 4 framework + Phase 5 guard):
 *
 *  1. CHEAP — loop `drainPipeline({ costs: ['cheap'] })` so a single nudge clears the
 *     currently-due deterministic backlog (sub-ms each). Self-heal runs only on the first
 *     pass (later passes would re-scan needlessly).
 *  2. LLM — one bounded batch of `drainPipeline({ costs: ['llm'] })` (size
 *     `pipelineLlmBatch`). Ollama generations are seconds-long and serialised
 *     single-flight, so they trickle a few per nudge: the slow historical backlog catches
 *     up over many nudges (the periodic enrich timer keeps nudging when idle) without
 *     starving cheap mail or monopolising the worker against sync sweeps (the N150 guard).
 *
 * Proposals from either phase are relayed to the main thread.
 */
async function runEnrich(): Promise<void> {
  const relay = (proposals: { messageId: string; label: string }[]): void => {
    for (const p of proposals) {
      post({ type: 'proposal:ready', messageId: p.messageId, label: p.label });
    }
  };

  const MAX_PASSES = 20;
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    let result;
    try {
      result = await drainPipeline({ selfHeal: pass === 0, costs: ['cheap'] });
    } catch (err) {
      post({ type: 'error', message: `enrich drain (cheap): ${(err as Error).message}` });
      break;
    }
    relay(result.proposals);
    if (result.claimed === 0) break;
  }

  if (llmEnabled()) {
    try {
      const result = await drainPipeline({
        costs: ['llm'],
        max: env.pipelineLlmBatch,
        selfHeal: false,
        // Relay each multi-second Ollama row so Settings can show "currently working on".
        onRowStart: (info) =>
          post({
            type: 'enrich:active',
            enricher: info.enricher,
            messageId: info.messageId,
            subject: info.subject,
          }),
      });
      relay(result.proposals);
    } catch (err) {
      post({ type: 'error', message: `enrich drain (llm): ${(err as Error).message}` });
    }
  }

  post({ type: 'enrich:done' });
}

// --- Serial job queue -------------------------------------------------------------------
// One heavy op at a time across the whole process. Sweeps dedup per-account; enrich jobs
// coalesce (the queue lives in SQLite, so one pending nudge is enough — stacking adds
// nothing). A sweep already queued/running for an account, or an enrich already
// queued/running, is dropped.
const queue: (SweepJob | EnrichJob)[] = [];
let running = false;
let active: SweepJob | EnrichJob | null = null;

async function drain(): Promise<void> {
  if (running) return;
  running = true;
  try {
    let job: SweepJob | EnrichJob | undefined;
    while ((job = queue.shift())) {
      active = job;
      if (job.type === 'sweep') await runSweep(job);
      else await runEnrich();
      active = null;
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
      (active?.type === 'sweep' && active.accountId === msg.accountId) ||
      queue.some((j) => j.type === 'sweep' && j.accountId === msg.accountId);
    if (!dup) queue.push(msg);
    void drain();
    return;
  }
  if (msg.type === 'enrich') {
    const dup = active?.type === 'enrich' || queue.some((j) => j.type === 'enrich');
    if (!dup) queue.push(msg);
    void drain();
  }
});

log.info('sync worker started');

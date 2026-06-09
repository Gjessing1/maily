/**
 * Main-thread host for the shared sync worker (ROADMAP §3.7.E).
 *
 * Owns the single, process-global `Worker` instance: spawns it lazily on first use,
 * forwards jobs, surfaces worker logs/errors, and tears it down on shutdown. Engines
 * call `enqueueSweep` from their sweep timer; the worker serialises and dedups.
 */
import { Worker } from 'node:worker_threads';
import type { CurrentEnrichmentDto } from '@maily/shared';
import { createLogger } from '../logger.js';
import type { MainToWorker, WorkerToMain } from './protocol.js';

const log = createLogger('worker:host');

let worker: Worker | null = null;

/**
 * The LLM enrichment row generating right now, relayed from the worker (Settings →
 * Enrichment "currently working on"). Ephemeral: set on `enrich:active`, cleared on
 * `enrich:done` and on any worker death — a live signal, never persisted.
 */
let currentEnrichment: CurrentEnrichmentDto | null = null;

/** The item the worker is enriching right now, or null when idle. */
export function getCurrentEnrichment(): CurrentEnrichmentDto | null {
  return currentEnrichment;
}

/**
 * Spawn the worker, matching the current runtime:
 *   - prod (`node dist/index.js`) → load the compiled `./index.js` directly; plain ESM,
 *     no loader needed.
 *   - dev  (`tsx`)                → Node 24 strips types off a `.ts` entry natively but
 *     does NOT do tsx's `.js`→`.ts` specifier rewriting, and tsx's loader does not reach
 *     a worker on its own. So we boot the worker from a tiny inline `eval` string that
 *     registers tsx's ESM hooks (`tsx/esm/api`) and then imports the real `./index.ts`,
 *     after which the body's `.js` imports resolve. The `tsx` reference lives only in
 *     this runtime string in the dev branch — it never appears in a compiled file, so
 *     `tsc` and the prod image (where tsx is pruned) never see it.
 */
function spawn(): Worker {
  const isTs = import.meta.url.endsWith('.ts');
  let w: Worker;
  if (isTs) {
    const bodyUrl = new URL('./index.ts', import.meta.url).href;
    // The `.catch` is load-bearing: an unhandled rejection here would crash the worker
    // with a bare exit-1 (Node's default), hiding the real load error.
    const boot =
      `import('tsx/esm/api')` +
      `.then((m) => { m.register(); return import(${JSON.stringify(bodyUrl)}); })` +
      `.catch((e) => { console.error('[worker] failed to load:', e); process.exit(1); })`;
    w = new Worker(boot, { eval: true });
  } else {
    w = new Worker(new URL('./index.js', import.meta.url));
  }

  w.on('message', (msg: WorkerToMain) => {
    if (msg.type === 'error') {
      log.warn(`worker error${msg.accountId ? ` (${msg.accountId})` : ''}: ${msg.message}`);
    } else if (msg.type === 'enrich:active') {
      currentEnrichment = { enricher: msg.enricher, subject: msg.subject, since: Date.now() };
    } else if (msg.type === 'enrich:done') {
      currentEnrichment = null; // drain pass over → back to idle
    }
    // 'sweep:done' needs no main-side action today.
  });
  w.on('error', (err) => {
    log.error('worker crashed:', err.message);
    currentEnrichment = null;
    worker = null; // respawn lazily on next enqueue
  });
  w.on('exit', (code) => {
    if (code !== 0) log.warn(`worker exited with code ${code}`);
    currentEnrichment = null;
    worker = null;
  });

  // Don't let the worker keep the process alive on its own.
  w.unref();
  return w;
}

function ensureWorker(): Worker {
  if (!worker) worker = spawn();
  return worker;
}

function postJob(job: MainToWorker): void {
  ensureWorker().postMessage(job);
}

/** Queue a full-source sweep pass for an account on the worker. */
export function enqueueSweep(accountId: string, email: string): void {
  postJob({ type: 'sweep', accountId, email });
}

/**
 * Nudge the worker to drain due enrichment work (Phase 4). The queue lives in SQLite,
 * so this is only a wake-up — the worker coalesces repeated nudges and claims whatever
 * is due. Losing a nudge only delays work (the runner's self-heal backfill is the backstop).
 */
export function enqueueEnrichPass(): void {
  postJob({ type: 'enrich' });
}

/**
 * Ask the worker to finish its current job and exit, then resolve (with a hard-terminate
 * fallback so shutdown can't hang). No-op when the worker was never spawned.
 */
export async function shutdownWorker(): Promise<void> {
  const w = worker;
  if (!w) return;
  worker = null;
  await new Promise<void>((resolve) => {
    const done = (): void => resolve();
    w.once('exit', done);
    w.postMessage({ type: 'shutdown' } satisfies MainToWorker);
    setTimeout(() => void w.terminate().finally(done), 5_000);
  });
}

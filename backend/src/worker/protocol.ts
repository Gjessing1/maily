/**
 * Message protocol for the shared sync worker (ROADMAP §3.7.E).
 *
 * The worker is the single, process-global heavy-work thread: it owns the synchronous,
 * CPU-bound paths (`better-sqlite3` writes + `.eml` parsing) that must not run on the
 * main event loop. Stage 1 moves the full-source sweep here; the bulk `fullSyncFolder`
 * and the future Phase-4 enrichment pipeline are meant to land on this *same* worker
 * (the roadmap's "build one worker, not three").
 *
 * IMPORTANT — no secrets cross the channel. Jobs carry only the non-secret account
 * `email`; the worker resolves the full `AccountConfig` (with IMAP/SMTP credentials)
 * itself via `loadAccountConfigs()`, which reads the same inherited `process.env`
 * (ARCHITECTURE §5). The channel is intra-process anyway, but keeping creds out of it
 * matches the rule that credentials live in env only.
 */

/** Run the throttled, budgeted full-source sweep for one account (all its folders). */
export interface SweepJob {
  type: 'sweep';
  accountId: string;
  email: string;
}

/**
 * Drain a bounded snapshot of due enrichment work (Phase 4). Carries no payload — the
 * queue lives in SQLite (`enrichments` ledger), so a single coalesced job tells the
 * worker "there may be work" and it claims whatever is due across all accounts.
 */
export interface EnrichJob {
  type: 'enrich';
}

/** Ask the worker to wind down before the process exits. */
export interface ShutdownJob {
  type: 'shutdown';
}

export type MainToWorker = SweepJob | EnrichJob | ShutdownJob;

/** A sweep pass for an account finished (budget-exhausted or all folders done). */
export interface SweepDoneMsg {
  type: 'sweep:done';
  accountId: string;
}

/** An enrichment drain pass finished. */
export interface EnrichDoneMsg {
  type: 'enrich:done';
}

/**
 * An enricher surfaced a proposal (Phase 4). Relayed so the MAIN thread can emit the
 * `action:ready` socket signal + Web Push — the worker has no socket/bus of its own.
 */
export interface ProposalReadyMsg {
  type: 'proposal:ready';
  messageId: string;
  label: string;
}

/** A handled failure inside the worker (logged on the main side too). */
export interface WorkerErrorMsg {
  type: 'error';
  accountId?: string;
  message: string;
}

export type WorkerToMain = SweepDoneMsg | EnrichDoneMsg | ProposalReadyMsg | WorkerErrorMsg;

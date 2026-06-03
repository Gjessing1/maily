/**
 * Per-account sync engine: one persistent IMAP IDLE connection on INBOX with
 * robust auto-reconnect (ARCHITECTURE §2), plus a periodic cron that reconciles
 * the non-INBOX folders over a transient connection so INBOX IDLE is never
 * interrupted (ARCHITECTURE §9 — "IDLE is INBOX-only").
 *
 * On every (re)connect we resync rather than trust the cache: a server restart or
 * dropped connection can hide events, so we reconcile UIDs/flags/expunges first
 * and only then resume live IDLE (KEY GOTCHA: never trust live IDLE alone).
 */
import type { ImapFlow } from 'imapflow';
import type { AccountConfig } from '../config/accounts.js';
import { createLogger, type Logger } from '../logger.js';
import { emitSignal } from '../events.js';
import { env } from '../env.js';
import { ensureAccount, type AccountRow } from '../db/accounts.js';
import { createClient, detectCapabilities, type Capabilities } from './connection.js';
import { backfillRecipients } from './backfill.js';
import { budgetRemaining, canDownloadSource } from './budget.js';
import { getFolderById, syncFolders } from './folders.js';
import { registerEngine } from './registry.js';
import { resyncFolder } from './resync.js';
import { sweepFolderSource, type SyncContext } from './sync.js';

const INITIAL_BACKOFF_MS = 2_000;
const MAX_BACKOFF_MS = 5 * 60_000;
const CRON_INTERVAL_MS = Number(process.env.MAILY_FOLDER_CRON_MS ?? String(15 * 60_000));

export class AccountEngine {
  private readonly log: Logger;
  private account: AccountRow | null = null;
  private client: ImapFlow | null = null;
  private inboxId: string | null = null;
  private caps: Capabilities = { qresync: false, condstore: false, gmail: false };
  private backoff = INITIAL_BACKOFF_MS;
  private stopped = false;
  private reconnecting = false;
  private idleBusy = false;
  private cronBusy = false;
  private sweepBusy = false;
  private connected = false;
  private lastSyncAt: number | null = null;
  private cronTimer: NodeJS.Timeout | null = null;
  private sweepTimer: NodeJS.Timeout | null = null;
  private recipientsBackfilled = false;

  constructor(private readonly config: AccountConfig) {
    this.log = createLogger(`imap:${config.email}`);
  }

  /** DB account id (assigned after `start()`). */
  get id(): string {
    if (!this.account) throw new Error('engine not started');
    return this.account.id;
  }

  /** The account's connection config (credentials + provider). Backend-only. */
  get accountConfig(): AccountConfig {
    return this.config;
  }

  /** Live status for the Settings → Sync view. */
  get status(): { connected: boolean; lastSyncAt: number | null } {
    return { connected: this.connected, lastSyncAt: this.lastSyncAt };
  }

  /** Register the account and bring up the connection (retrying in the background). */
  start(): void {
    this.account = ensureAccount(this.config);
    registerEngine(this);
    void this.connect();
    this.cronTimer = setInterval(() => void this.runFolderCron(), CRON_INTERVAL_MS);
    if (typeof this.cronTimer.unref === 'function') this.cronTimer.unref();
    // Full-source historical backfill (ROADMAP §3.7.E), throttled by its own timer and
    // the shared daily byte budget. On by default; MAILY_SOURCE_SWEEP=false pauses it.
    if (env.sourceSweepEnabled) {
      this.sweepTimer = setInterval(() => void this.runSourceSweep(), env.sourceSweepIntervalMs);
      if (typeof this.sweepTimer.unref === 'function') this.sweepTimer.unref();
    }
  }

  /** Tear the engine down cleanly. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.cronTimer) clearInterval(this.cronTimer);
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    const client = this.client;
    this.client = null;
    if (client) {
      try {
        await client.logout();
      } catch {
        client.close();
      }
    }
  }

  private ctx(client: ImapFlow): SyncContext {
    return { client, accountId: this.account!.id, caps: this.caps, log: this.log };
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    const client = createClient(this.config);
    this.client = client;

    client.on('error', (err) => {
      this.log.warn('connection error:', err.message);
    });
    client.on('close', () => {
      this.connected = false;
      if (!this.stopped) this.scheduleReconnect();
    });

    try {
      await client.connect();
      this.caps = detectCapabilities(client);
      this.log.info(
        `connected — caps: qresync=${this.caps.qresync} condstore=${this.caps.condstore} gmail=${this.caps.gmail}`,
      );
      this.backoff = INITIAL_BACKOFF_MS;
      await this.onConnected(client);
    } catch (err) {
      this.log.warn('connect failed:', (err as Error).message);
      this.scheduleReconnect();
    }
  }

  private async onConnected(client: ImapFlow): Promise<void> {
    const ctx = this.ctx(client);
    const folders = await syncFolders(client, this.account!.id);
    const inbox =
      folders.find((f) => f.role === 'inbox') ?? folders.find((f) => f.path === 'INBOX');
    if (!inbox) {
      this.log.error('no INBOX folder found; aborting connection');
      return;
    }
    this.inboxId = inbox.id;

    // Resync INBOX before going live so missed events are reconciled. We do NOT
    // emit per-message signals for this catch-up pass — it can be thousands on a
    // first sync; the client loads the inbox via HTTP instead.
    const result = await resyncFolder(ctx, inbox);
    this.connected = true;
    this.lastSyncAt = Date.now();
    this.log.info(
      `INBOX resync (${result.mode}): +${result.insertedIds.length} ~${result.updated} -${result.expunged}`,
    );

    // Live INBOX updates: imapflow auto-IDLEs on the open mailbox; we react to events.
    client.on('exists', () => void this.onInboxEvent());
    client.on('flags', () => void this.onInboxEvent());
    client.on('expunge', () => void this.onInboxEvent());

    // Kick the non-INBOX folders once on connect rather than waiting a full cron cycle.
    void this.runFolderCron();

    // One-time heal of pre-migration-0004 rows with NULL To/Cc (e.g. Sent mail showing
    // no recipient). Envelope-only refetch over a transient connection; no-op once done.
    if (!this.recipientsBackfilled) {
      this.recipientsBackfilled = true;
      void backfillRecipients(this.config, this.id);
    }
  }

  /** Coalesced INBOX reconcile triggered by live IDLE events. */
  private async onInboxEvent(): Promise<void> {
    if (this.idleBusy || this.stopped || !this.client || !this.inboxId) return;
    this.idleBusy = true;
    try {
      const inbox = getFolderById(this.inboxId);
      if (!inbox) return;
      const result = await resyncFolder(this.ctx(this.client), inbox);
      this.lastSyncAt = Date.now();

      // Live new mail → precise per-message signal (drives Socket.io + Web Push).
      for (const messageId of result.insertedIds) {
        emitSignal({ type: 'mail:new', accountId: this.id, messageId });
      }
      // Flag/expunge changes have no per-message id here; nudge clients to refresh.
      if (result.updated || result.expunged) {
        const changed = result.updated + result.expunged;
        emitSignal({ type: 'sync:progress', accountId: this.id, done: changed, total: changed });
      }
      if (result.insertedIds.length || result.updated || result.expunged) {
        this.log.info(
          `INBOX live: +${result.insertedIds.length} ~${result.updated} -${result.expunged}`,
        );
      }
    } catch (err) {
      this.log.warn('INBOX live reconcile failed:', (err as Error).message);
    } finally {
      this.idleBusy = false;
    }
  }

  /**
   * Reconcile non-INBOX folders now, off the IDLE connection. Used after an
   * interactive flag change (e.g. starring) so flag-derived folders like Gmail's
   * `[Gmail]/Starred` pick up the new membership immediately instead of waiting up
   * to a full cron interval. Fire-and-forget; coalesced with the periodic cron.
   */
  reconcileFoldersNow(): void {
    void this.runFolderCron();
  }

  /** Reconcile non-INBOX folders over a transient connection (keeps INBOX IDLE alive). */
  private async runFolderCron(): Promise<void> {
    if (this.stopped || !this.account || this.cronBusy) return;
    this.cronBusy = true;
    const client = createClient(this.config);
    try {
      await client.connect();
      const caps = detectCapabilities(client);
      const ctx: SyncContext = { client, accountId: this.account.id, caps, log: this.log };
      const folders = await syncFolders(client, this.account.id);
      for (const folder of folders) {
        if (folder.role === 'inbox') continue;
        const fresh = getFolderById(folder.id);
        if (!fresh) continue;
        const result = await resyncFolder(ctx, fresh);
        if (result.insertedIds.length || result.updated || result.expunged) {
          this.log.info(
            `${folder.path} cron (${result.mode}): +${result.insertedIds.length} ~${result.updated} -${result.expunged}`,
          );
        }
      }
      this.lastSyncAt = Date.now();
    } catch (err) {
      this.log.warn('folder cron failed:', (err as Error).message);
    } finally {
      try {
        await client.logout();
      } catch {
        client.close();
      }
      this.cronBusy = false;
    }
  }

  /**
   * Full-source sweep pass (ROADMAP §3.7.E): archive raw `.eml` for the backlog, one
   * folder at a time, over a transient connection so the INBOX IDLE connection is never
   * disturbed (ARCHITECTURE §2/§9). The shared daily byte budget gates the work — a pass
   * stops as soon as the budget is spent and the next tick no-ops cheaply until the UTC
   * day rolls. `sweepBusy` prevents overlap when a pass outlives the timer interval.
   */
  private async runSourceSweep(): Promise<void> {
    if (this.stopped || !this.account || this.sweepBusy) return;
    if (!canDownloadSource()) return; // budget spent for today — retry on a later tick
    this.sweepBusy = true;
    const client = createClient(this.config);
    try {
      await client.connect();
      const caps = detectCapabilities(client);
      const ctx: SyncContext = { client, accountId: this.account.id, caps, log: this.log };
      const folders = await syncFolders(client, this.account.id);
      for (const folder of folders) {
        if (this.stopped || !canDownloadSource()) break;
        const fresh = getFolderById(folder.id);
        if (!fresh) continue;
        const r = await sweepFolderSource(ctx, fresh);
        if (r.archived || r.inserted) {
          const leftMb = Math.round(budgetRemaining() / 1e6);
          this.log.info(
            `${folder.path} sweep: ↑${r.archived} +${r.inserted}` +
              `${r.done ? ' (folder complete)' : ''} — ${leftMb}MB budget left`,
          );
        }
      }
    } catch (err) {
      this.log.warn('source sweep failed:', (err as Error).message);
    } finally {
      try {
        await client.logout();
      } catch {
        client.close();
      }
      this.sweepBusy = false;
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnecting) return;
    this.reconnecting = true;
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
    this.log.info(`reconnecting in ${Math.round(delay / 1000)}s`);
    const timer = setTimeout(() => {
      this.reconnecting = false;
      void this.connect();
    }, delay);
    if (typeof timer.unref === 'function') timer.unref();
  }
}

/** Build engines for all configured accounts and start them. */
export function startSyncEngines(configs: AccountConfig[]): AccountEngine[] {
  const engines = configs.map((config) => new AccountEngine(config));
  for (const engine of engines) engine.start();
  return engines;
}

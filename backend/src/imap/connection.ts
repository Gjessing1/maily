/**
 * ImapFlow client factory + capability detection (ARCHITECTURE §2).
 *
 * We never assume QRESYNC exists: we inspect the server's advertised CAPABILITY
 * at runtime and branch. mailbox.org advertises QRESYNC/CONDSTORE (fast resync);
 * Gmail advertises X-GM-EXT-1 (X-GM-THRID / X-GM-MSGID / labels) instead.
 */
import { ImapFlow, type ImapFlowOptions } from 'imapflow';
import type { AccountConfig } from '../config/accounts.js';

export interface Capabilities {
  /** QRESYNC advertised — UID-based VANISHED responses on resync (mailbox.org). */
  qresync: boolean;
  /** CONDSTORE advertised — per-message MODSEQ + `changedSince` FETCH for flag resync. */
  condstore: boolean;
  /** Gmail X-GM-EXT-1 — exposes X-GM-THRID, X-GM-MSGID and X-GM-LABELS. */
  gmail: boolean;
}

/** Inspect the live connection's CAPABILITY set. Call only after `connect()`. */
export function detectCapabilities(client: ImapFlow): Capabilities {
  const has = (name: string): boolean => client.capabilities.has(name) || client.enabled.has(name);
  const qresync = has('QRESYNC');
  return {
    qresync,
    // QRESYNC implies CONDSTORE; either gives us the `changedSince` fast path.
    condstore: qresync || has('CONDSTORE'),
    gmail: has('X-GM-EXT-1'),
  };
}

/**
 * Build (but do not connect) an ImapFlow client for an account. `qresync: true`
 * is harmless when the server lacks the extension and upgrades EXPUNGE to UID
 * VANISHED where it is supported. Logging is routed off the imapflow internals.
 */
export function createClient(config: AccountConfig): ImapFlow {
  const options: ImapFlowOptions = {
    host: config.imap.host,
    port: config.imap.port,
    secure: config.imap.secure,
    auth: { user: config.imap.user, pass: config.imap.pass },
    qresync: true,
    logger: false,
    clientInfo: { name: 'maily', vendor: 'maily' },
  };
  return new ImapFlow(options);
}

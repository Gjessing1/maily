/**
 * Account engine registry. HTTP routes (attachment fetch, send) look up the
 * engine for an account id to borrow its config/provider and run transient IMAP
 * operations. Type-only import of AccountEngine avoids a runtime import cycle.
 */
import type { AccountEngine } from './engine.js';

const engines = new Map<string, AccountEngine>();

export function registerEngine(engine: AccountEngine): void {
  engines.set(engine.id, engine);
}

export function getEngine(accountId: string): AccountEngine | undefined {
  return engines.get(accountId);
}

export function allEngines(): AccountEngine[] {
  return [...engines.values()];
}

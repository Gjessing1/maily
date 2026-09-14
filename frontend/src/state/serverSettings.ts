/**
 * Settings the server acts on: the cleanup keyword lists and the undo-send window. The server
 * owns and validates them, so a change counts only once it's accepted — the screen updates right
 * away and reverts, with a notice, if the save fails. `localStorage` keeps the last-known copy so
 * screens render instantly and offline.
 */
import { useSyncExternalStore } from 'react';
import type { ServerSettings } from '@maily/shared';
import { api } from '../api/client';
import { showNotice } from './undo';

/** The server settings that are cleanup keyword lists. */
export type KeywordListKey = {
  [K in keyof ServerSettings]: ServerSettings[K] extends string[] ? K : never;
}[keyof ServerSettings];

/** Shown until the first read from the server; the same as the server's defaults. */
const DEFAULTS: ServerSettings = {
  cleanupProtectedKeywords: [],
  cleanupNewsletterKeywords: [],
  cleanupColdKeepKeywords: [],
  undoSendSeconds: 10,
};

const KEY = 'maily.serverSettings';

function load(): ServerSettings {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? { ...DEFAULTS, ...(JSON.parse(raw) as Partial<ServerSettings>) } : DEFAULTS;
  } catch {
    return DEFAULTS;
  }
}

let current = load();
// Saves started. A read that began before a save may predate it, so it's discarded.
let saves = 0;
const listeners = new Set<() => void>();

function adopt(next: ServerSettings): void {
  current = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Best-effort: storage may be full or disabled — the offline copy just won't persist.
  }
  for (const l of listeners) l();
}

export function getServerSettings(): ServerSettings {
  return current;
}

/** Re-read from the server (login, foreground, a change on another device). Best-effort. */
export async function hydrateServerSettings(): Promise<void> {
  const seen = saves;
  try {
    const server = await api.serverSettings();
    if (saves === seen) adopt(server);
  } catch {
    // Offline / unauthorized — keep the cached copy.
  }
}

/**
 * Save a partial change. Resolves true once the server accepted it and false if it didn't, in
 * which case each changed key gets its previous value back and the user is told.
 */
export async function updateServerSettings(patch: Partial<ServerSettings>): Promise<boolean> {
  const mine = ++saves;
  const previous = current;
  adopt({ ...current, ...patch });
  try {
    const saved = await api.patchServerSettings(patch);
    // A later save's own response is the fresher copy.
    if (saves === mine) adopt(saved);
    return true;
  } catch {
    const keys = Object.keys(patch) as (keyof ServerSettings)[];
    // Leave alone any key a later save has changed again since.
    const revert = Object.fromEntries(
      keys.filter((k) => current[k] === patch[k]).map((k) => [k, previous[k]]),
    ) as Partial<ServerSettings>;
    adopt({ ...current, ...revert });
    showNotice('Couldn’t save the setting');
    return false;
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Reactive read of the server settings. */
export function useServerSettings(): ServerSettings {
  return useSyncExternalStore(subscribe, getServerSettings, getServerSettings);
}

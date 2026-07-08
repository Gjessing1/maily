/**
 * Typed HTTP client for the maily backend. Heavy payloads (bodies, attachment
 * bytes) come over HTTP per ARCHITECTURE §3. The JWT is attached to every
 * request; a 401 clears it and notifies listeners so the UI can bounce to login.
 */
import type {
  AccountDto,
  AccountSyncStatusDto,
  AddressbookSettingsDto,
  CalendarEventInput,
  CalendarSettingsDto,
  CleanupDashboardDto,
  CleanupExecuteRequest,
  CleanupExecuteResultDto,
  CleanupKeepResultDto,
  CleanupKeptDto,
  CleanupMessagesDto,
  CleanupQueueStatusDto,
  CleanupSliceDto,
  CleanupSummaryDto,
  ContactCardDto,
  ContactCardInput,
  ContactDto,
  ContactImportResult,
  DetachPreviewDto,
  DetachRequest,
  DetachStatusDto,
  EnrichmentStatusDto,
  EventDraftDto,
  FolderDto,
  MessageDetailDto,
  MessageDto,
  OutboxEntry,
  PushSubscriptionDto,
  QueuedSendResult,
  SaveDraftRequest,
  SaveDraftResult,
  SendMessageRequest,
  ServerConfigDto,
  UploadDto,
} from '@maily/shared';

const API_BASE = import.meta.env.VITE_API_BASE ?? '';
const TOKEN_KEY = 'maily.token';

let token: string | null = localStorage.getItem(TOKEN_KEY);
const unauthorizedListeners = new Set<() => void>();

// True once the auth-config probe reports that maily's own login is disabled, i.e.
// the deployment is fronted by an external auth gateway (tinyauth). In that mode a
// 401 can only mean the gateway expired the session, so we re-auth through it rather
// than showing maily's (unusable) login screen.
//
// Persisted: when the gateway expires/reconfigures the session, its redirect to a
// cross-origin login page makes the config probe's fetch throw a CORS error — at
// which point we can no longer read the backend's authRequired flag. Remembering
// that this deployment IS gateway-fronted lets us bounce back through the gateway on
// that failure instead of dropping to maily's (disabled, unusable) login screen.
const EXTERNAL_AUTH_KEY = 'maily.externalAuth';
let externalAuthGateway = localStorage.getItem(EXTERNAL_AUTH_KEY) === 'true';

function setExternalAuthGateway(on: boolean): void {
  externalAuthGateway = on;
  if (on) localStorage.setItem(EXTERNAL_AUTH_KEY, 'true');
  else localStorage.removeItem(EXTERNAL_AUTH_KEY);
}

// Loop guard: a hard-navigate through the gateway lands back on the app shell (served
// from the SW cache) and re-runs the probe. If the gateway keeps failing the probe we
// must not machine-gun reloads, so suppress a fresh bounce within this window and let
// the caller fall through instead.
const RELOGIN_AT_KEY = 'maily.reloginAt';
const RELOGIN_MIN_INTERVAL_MS = 15_000;

/**
 * Hard-navigate the document through the external auth gateway so it can show its
 * login and bounce us back to a freshly-authed app shell. Going via an /api path is
 * deliberate: the service worker serves the app shell from cache (so a plain reload
 * never reaches the gateway), but passes /api straight to the network, where the
 * gateway intercepts the expired session. See backend GET /api/auth/relogin.
 * Returns false (without navigating) when guarded against a too-recent bounce.
 */
function gatewayRelogin(): boolean {
  const last = Number(sessionStorage.getItem(RELOGIN_AT_KEY) ?? 0);
  if (Date.now() - last < RELOGIN_MIN_INTERVAL_MS) return false;
  sessionStorage.setItem(RELOGIN_AT_KEY, String(Date.now()));
  window.location.assign(`${API_BASE}/api/auth/relogin`);
  return true;
}

export function getToken(): string | null {
  return token;
}

export function setToken(value: string | null): void {
  token = value;
  if (value) localStorage.setItem(TOKEN_KEY, value);
  else localStorage.removeItem(TOKEN_KEY);
}

/** Subscribe to forced-logout events (fired when the server rejects the token). */
export function onUnauthorized(listener: () => void): () => void {
  unauthorizedListeners.add(listener);
  return () => unauthorizedListeners.delete(listener);
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * How long a request may sit without an answer before we abort it. Mobile radios
 * love half-open connections (backgrounded PWA, dead Wi-Fi, tunnel): without a
 * deadline a fetch can hang for minutes, wedging the refresh spinner and the
 * in-flight guards that coalesce refreshes.
 */
const REQUEST_TIMEOUT_MS = 25_000;
const RETRY_DELAY_MS = 750;

function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  return fetch(url, { ...init, signal: ctrl.signal }).finally(() => clearTimeout(timer));
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (init.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  // GETs are idempotent, so a network failure/timeout gets one quick retry —
  // enough to ride out a Wi-Fi↔cellular handover or a dropped radio wake-up
  // without turning every list refresh into a user-visible error. Mutations
  // (POST/PATCH/DELETE) never retry: a timed-out send may still have committed.
  const method = (init.method ?? 'GET').toUpperCase();
  let res: Response;
  try {
    res = await fetchWithTimeout(`${API_BASE}${path}`, { ...init, headers });
  } catch (err) {
    if (method !== 'GET') {
      throw new ApiError(0, err instanceof DOMException ? 'request timed out' : 'network error');
    }
    await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    try {
      res = await fetchWithTimeout(`${API_BASE}${path}`, { ...init, headers });
    } catch (err2) {
      throw new ApiError(0, err2 instanceof DOMException ? 'request timed out' : 'network error');
    }
  }

  if (res.status === 401) {
    // Gateway-fronted deployment: the 401 is the external gateway, not maily.
    // Bounce through it to re-auth instead of dropping to maily's login screen.
    if (externalAuthGateway) {
      gatewayRelogin();
      throw new ApiError(401, 'reauthenticating');
    }
    setToken(null);
    unauthorizedListeners.forEach((l) => l());
    throw new ApiError(401, 'unauthorized');
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new ApiError(res.status, detail || res.statusText);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** How the "Review by sender" group list is ordered. */
export type GroupSort = 'bytes' | 'count' | 'name';

/** Cleanup group-list paging/search: a domain substring (`q`), a page `offset`, thresholds. */
interface GroupPage {
  q?: string;
  offset?: number;
  years?: number;
  minMb?: number;
  /** Sort order for the sender list (default 'bytes'). */
  sort?: GroupSort;
  /** Hide senders with fewer than this many messages. */
  minMsgs?: number;
  /** Hide senders smaller than this many MB (estimated). */
  minSizeMb?: number;
}

/** Build the `?q=…&offset=…&years=…` query for a slice request (omitting empty parts). */
function groupQuery(opts: GroupPage): string {
  const p = new URLSearchParams();
  if (opts.q?.trim()) p.set('q', opts.q.trim());
  if (opts.offset) p.set('offset', String(opts.offset));
  if (opts.years) p.set('years', String(opts.years));
  if (opts.minMb) p.set('minMb', String(opts.minMb));
  if (opts.sort && opts.sort !== 'bytes') p.set('sort', opts.sort);
  if (opts.minMsgs) p.set('minMsgs', String(opts.minMsgs));
  if (opts.minSizeMb) p.set('minSizeMb', String(opts.minSizeMb));
  const s = p.toString();
  return s ? `?${s}` : '';
}

/** Shared options for the paged list endpoints; `unread` asks for only-unseen rows. */
interface ListOpts {
  limit?: number;
  before?: number;
  unread?: boolean;
}

function listQs(opts: ListOpts): string {
  const qs = new URLSearchParams();
  if (opts.limit) qs.set('limit', String(opts.limit));
  if (opts.before) qs.set('before', String(opts.before));
  if (opts.unread) qs.set('unread', '1');
  return qs.toString() ? `?${qs}` : '';
}

export const api = {
  /**
   * Public probe (no token): whether the backend requires in-app login. Returns
   * `{ authRequired: false }` when the deployment is fronted by external SSO
   * (backend MAILY_DISABLE_AUTH), letting the UI skip the login screen.
   */
  async authConfig(): Promise<{ authRequired: boolean }> {
    try {
      const res = await fetch(`${API_BASE}/api/auth/config`);
      if (res.ok) {
        const cfg = (await res.json()) as { authRequired: boolean };
        setExternalAuthGateway(!cfg.authRequired);
        return cfg;
      }
      // A 401/403 (or a redirect to a login page) on this PUBLIC endpoint can only
      // come from an external auth gateway — maily's own auth never gates it. So the
      // session expired at the gateway: bounce through it rather than show maily's
      // login. Other failures (5xx) fall through to the maily-login fallback, which
      // also avoids a redirect loop when the backend itself is down.
      if (res.status === 401 || res.status === 403 || res.redirected) {
        setExternalAuthGateway(true);
        gatewayRelogin();
        return { authRequired: false }; // navigating away; the value is moot
      }
    } catch {
      // Network/CORS error. The most common cause on a gateway-fronted deployment is
      // exactly the logged-out case: the gateway answers the probe with a redirect to
      // its own cross-origin login page, which the browser blocks (no CORS), throwing
      // here. If we already know this deployment sits behind a gateway, treat that as
      // an expired session and bounce back through it — never fall through to maily's
      // disabled login screen. The relogin loop guard keeps a persistently-failing
      // gateway (or a genuine offline) from machine-gunning reloads.
      if (externalAuthGateway && gatewayRelogin()) {
        return { authRequired: false }; // navigating away; the value is moot
      }
    }
    // Only reached on a true ambiguity (no prior gateway knowledge, or the loop guard
    // suppressed a bounce): when we DO know a gateway fronts us, stay out of the login
    // screen and let the cached shell ride until the gateway recovers.
    return { authRequired: !externalAuthGateway };
  },

  /** Exchange the master password for a JWT. Does not auto-attach a token. */
  async login(password: string): Promise<string> {
    const res = await fetch(`${API_BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    if (!res.ok) throw new ApiError(res.status, 'invalid password');
    const { token: t } = (await res.json()) as { token: string };
    setToken(t);
    return t;
  },

  accounts: () => request<AccountDto[]>('/api/accounts'),

  folders: (accountId: string) => request<FolderDto[]>(`/api/accounts/${accountId}/folders`),

  syncStatus: () => request<AccountSyncStatusDto[]>('/api/sync/status'),

  enrichmentStatus: () => request<EnrichmentStatusDto>('/api/enrichment/status'),

  config: () => request<ServerConfigDto>('/api/config'),

  /** Server-persisted UI preferences (synced across devices). */
  getSettings: () => request<Record<string, unknown>>('/api/settings'),
  putSettings: (prefs: Record<string, unknown>) =>
    request<{ ok: boolean }>('/api/settings', {
      method: 'PUT',
      body: JSON.stringify(prefs),
    }),

  messages: (folderId: string, opts: ListOpts = {}) =>
    request<MessageDto[]>(`/api/folders/${folderId}/messages${listQs(opts)}`),

  /** Virtual "Unified Inbox": every account's inbox merged newest-first. */
  unifiedInbox: (opts: ListOpts = {}) => request<MessageDto[]>(`/api/inbox${listQs(opts)}`),

  /** Virtual unified view for any mergeable role ("All sent", "All drafts", …). */
  unified: (role: string, opts: ListOpts = {}) =>
    request<MessageDto[]>(`/api/unified/${role}${listQs(opts)}`),

  /** Virtual "Archived" view for an account (archive folder minus inbox/sent/…). */
  archived: (accountId: string, opts: ListOpts = {}) =>
    request<MessageDto[]>(`/api/accounts/${accountId}/archived${listQs(opts)}`),

  /** Virtual "Starred" view for an account (every \Flagged message, provider-agnostic). */
  starred: (accountId: string, opts: ListOpts = {}) =>
    request<MessageDto[]>(`/api/accounts/${accountId}/starred${listQs(opts)}`),

  message: (id: string) => request<MessageDetailDto>(`/api/messages/${id}`),

  /** Whole conversation (thread) for a message — light rows, oldest-first. */
  thread: (id: string) => request<MessageDto[]>(`/api/messages/${id}/thread`),

  setFlags: (id: string, flags: { seen?: boolean; flagged?: boolean }) =>
    request<{ ok: boolean; seen: boolean; flagged: boolean }>(`/api/messages/${id}/flags`, {
      method: 'PATCH',
      body: JSON.stringify(flags),
    }),

  /** Soft-delete → move to Trash (server tombstones + moves on IMAP out-of-band). */
  deleteMessage: (id: string) =>
    request<{ ok: boolean; outboxId?: string; dueAt?: number }>(`/api/messages/${id}`, {
      method: 'DELETE',
    }),

  /**
   * Archive → queue a deferred MOVE to the Archive folder (no tombstone). Returns the outbox id
   * + dueAt so the undo window can mirror the server's, and Undo can cancel it (see state/undo).
   */
  archiveMessage: (id: string) =>
    request<{ ok: boolean; outboxId?: string; dueAt?: number }>(`/api/messages/${id}/archive`, {
      method: 'POST',
    }),

  /** Restore a trashed message → MOVE back to the Inbox and clear the tombstone (awaited). */
  restoreMessage: (id: string) =>
    request<{ ok: boolean }>(`/api/messages/${id}/restore`, { method: 'POST' }),

  /** Delete forever (Trash only): EXPUNGE the provider's copy, then purge the local one. */
  deleteMessageForever: (id: string) =>
    request<{ ok: boolean }>(`/api/messages/${id}/forever`, { method: 'DELETE' }),

  /**
   * Queue a send into the server-owned outbox. Returns the outbox id + `dueAt` (when it will
   * actually fire). The send commits server-side at `dueAt` even if the app closes; cancel
   * within the window via `cancelOutbox` (undo-send) — see state/undo.ts.
   */
  send: (accountId: string, msg: SendMessageRequest) =>
    request<QueuedSendResult>(`/api/accounts/${accountId}/send`, {
      method: 'POST',
      body: JSON.stringify(msg),
    }),

  /** Pending/scheduled sends still in the outbox (Scheduled/Outbox view). */
  listOutbox: () => request<{ entries: OutboxEntry[] }>(`/api/outbox`),

  /** Cancel a queued outbox action (undo-send / undo delete-archive). 409 ⇒ already committed. */
  cancelOutbox: (id: string) =>
    request<{ canceled: boolean }>(`/api/outbox/${id}`, { method: 'DELETE' }),

  /** Save a draft → APPEND to the account's \Drafts mailbox (syncs across devices). */
  saveDraft: (accountId: string, msg: SaveDraftRequest) =>
    request<SaveDraftResult>(`/api/accounts/${accountId}/draft`, {
      method: 'POST',
      body: JSON.stringify(msg),
    }),

  /** Stream a composer attachment to the backend's staging dir; returns a send handle. */
  async uploadAttachment(file: File): Promise<UploadDto> {
    const qs = new URLSearchParams({ filename: file.name });
    if (file.type) qs.set('type', file.type);
    const headers = new Headers({ 'Content-Type': 'application/octet-stream' });
    if (token) headers.set('Authorization', `Bearer ${token}`);
    const res = await fetch(`${API_BASE}/api/uploads?${qs}`, {
      method: 'POST',
      headers,
      body: file,
    });
    if (!res.ok)
      throw new ApiError(res.status, (await res.text().catch(() => '')) || 'upload failed');
    return (await res.json()) as UploadDto;
  },

  /** Discard a staged upload (chip removed before send). */
  deleteUpload: (uploadId: string) =>
    request<{ ok: boolean }>(`/api/uploads/${uploadId}`, { method: 'DELETE' }),

  search: (q: string, opts: { accountId?: string; limit?: number } = {}) => {
    const qs = new URLSearchParams({ q });
    if (opts.accountId) qs.set('accountId', opts.accountId);
    if (opts.limit) qs.set('limit', String(opts.limit));
    return request<MessageDto[]>(`/api/search?${qs}`);
  },

  /** Contact autocomplete from the cached CardDAV addressbook. */
  contacts: (q: string, limit = 8) => {
    const qs = new URLSearchParams({ q });
    qs.set('limit', String(limit));
    return request<ContactDto[]>(`/api/contacts?${qs}`);
  },

  /** Discovered address books + active/default selection. */
  addressbooks: () => request<AddressbookSettingsDto>('/api/contacts/addressbooks'),

  /** Set which books are active + the default create target; returns the new state. */
  setAddressbooks: (active: string[] | null, def: string | null) =>
    request<AddressbookSettingsDto>('/api/contacts/addressbooks', {
      method: 'PUT',
      body: JSON.stringify({ active, default: def }),
    }),

  /** Whole-card management (CardDAV write-back) for the Contacts manager. */
  contactCards: () => request<ContactCardDto[]>('/api/contacts/cards'),

  /** One card's rich detail by key (UID, or href for UID-less cards). */
  contactCard: (key: string) =>
    request<ContactCardDto>(`/api/contacts/cards/${encodeURIComponent(key)}`),

  createContactCard: (input: ContactCardInput) =>
    request<ContactCardDto>('/api/contacts/cards', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  updateContactCard: (key: string, input: ContactCardInput) =>
    request<ContactCardDto>(`/api/contacts/cards/${encodeURIComponent(key)}`, {
      method: 'PUT',
      body: JSON.stringify(input),
    }),

  deleteContactCard: (key: string) =>
    request<{ ok: boolean }>(`/api/contacts/cards/${encodeURIComponent(key)}`, {
      method: 'DELETE',
    }),

  /** Discovered CalDAV calendars + the default event target. */
  calendars: () => request<CalendarSettingsDto>('/api/calendar/calendars'),

  /** Set the default calendar for new events; returns the new state. */
  setDefaultCalendar: (def: string | null) =>
    request<CalendarSettingsDto>('/api/calendar/calendars', {
      method: 'PUT',
      body: JSON.stringify({ default: def }),
    }),

  /** Pre-fill suggestions for "Add to calendar" (invite/reservation drafts, best first). */
  eventDrafts: (messageId: string) =>
    request<EventDraftDto[]>(`/api/messages/${messageId}/event-drafts`),

  /** Write one confirmed event to the chosen calendar (server default when omitted). */
  addToCalendar: (messageId: string, input: CalendarEventInput) =>
    request<{ ok: boolean; calendar: string }>(`/api/messages/${messageId}/calendar-event`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  /** Import a `.vcf` file (one or many cards) into a book (default when omitted). */
  importContacts: (vcard: string, addressbook?: string | null) =>
    request<ContactImportResult>('/api/contacts/cards/import', {
      method: 'POST',
      body: JSON.stringify({ vcard, addressbook: addressbook ?? null }),
    }),

  // ── Cleanup Dashboard (Phase 6 — analytics + Phase 6b execution) ─────────────
  cleanup: {
    summary: () => request<CleanupSummaryDto>('/api/cleanup/summary'),
    /** The whole dashboard in one round-trip, served from the backend's precomputed cache. */
    dashboard: (opts: { years?: number; minMb?: number } = {}) =>
      request<CleanupDashboardDto>(`/api/cleanup/dashboard${groupQuery(opts)}`),
    storage: (opts: GroupPage = {}) =>
      request<CleanupSliceDto>(`/api/cleanup/storage${groupQuery(opts)}`),
    coldStorage: (years?: number, opts: GroupPage = {}) =>
      request<CleanupSliceDto>(`/api/cleanup/cold-storage${groupQuery({ ...opts, years })}`),
    large: (minMb?: number, opts: GroupPage = {}) =>
      request<CleanupSliceDto>(`/api/cleanup/large${groupQuery({ ...opts, minMb })}`),
    newsletters: (opts: GroupPage = {}) =>
      request<CleanupSliceDto>(`/api/cleanup/newsletters${groupQuery(opts)}`),
    /** Drill a delete-eligible slice down to messages, optionally sender-scoped/searched. */
    messages: (opts: {
      slice: string;
      domain?: string;
      q?: string;
      years?: number;
      minMb?: number;
      limit?: number;
      offset?: number;
    }) => {
      const q = new URLSearchParams({ slice: opts.slice });
      if (opts.domain) q.set('domain', opts.domain);
      if (opts.q) q.set('q', opts.q);
      if (opts.years) q.set('years', String(opts.years));
      if (opts.minMb) q.set('minMb', String(opts.minMb));
      if (opts.limit) q.set('limit', String(opts.limit));
      if (opts.offset) q.set('offset', String(opts.offset));
      return request<CleanupMessagesDto>(`/api/cleanup/messages?${q.toString()}`);
    },
    /** Queue a delete-eligible slice for trashing (server re-validates the safety gate). */
    execute: (body: CleanupExecuteRequest) =>
      request<CleanupExecuteResultDto>('/api/cleanup/execute', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    /** Preserve (keep=true) or release (keep=false) messages from every cleanup slice. */
    keep: (messageIds: string[], keep: boolean) =>
      request<CleanupKeepResultDto>('/api/cleanup/keep', {
        method: 'POST',
        body: JSON.stringify({ messageIds, keep }),
      }),
    /** The manually-guarded messages (cleanup_keep) — the "Guarded mail" section. */
    kept: (opts: { limit?: number; offset?: number } = {}) => {
      const q = new URLSearchParams();
      if (opts.limit) q.set('limit', String(opts.limit));
      if (opts.offset) q.set('offset', String(opts.offset));
      const qs = q.toString();
      return request<CleanupKeptDto>(`/api/cleanup/kept${qs ? `?${qs}` : ''}`);
    },
    /** Trash-queue progress for the "Moving N to Trash…" readout. */
    queueStatus: () => request<CleanupQueueStatusDto>('/api/cleanup/queue'),
    /** Empty a trash folder LOCALLY — reclaim disk, keep a no-resync tombstone (provider untouched). */
    purgeTrash: (folderId: string) =>
      request<{ purged: number }>('/api/cleanup/purge-trash', {
        method: 'POST',
        body: JSON.stringify({ folderId }),
      }),
  },

  /** Detach-to-local (delete from the provider, keep the full copy on this server). */
  detach: {
    status: () => request<DetachStatusDto>('/api/detach/status'),
    dryRun: (req: DetachRequest) =>
      request<DetachPreviewDto>('/api/detach/dry-run', {
        method: 'POST',
        body: JSON.stringify(req),
      }),
    run: (req: DetachRequest) =>
      request<DetachStatusDto>('/api/detach/run', {
        method: 'POST',
        body: JSON.stringify(req),
      }),
  },

  pushKey: () => request<{ publicKey: string | null }>('/api/push/key'),

  pushSubscribe: (sub: PushSubscriptionDto) =>
    request<{ ok: boolean }>('/api/push/subscribe', {
      method: 'POST',
      body: JSON.stringify(sub),
    }),

  pushUnsubscribe: (endpoint: string) =>
    request<{ ok: boolean }>('/api/push/unsubscribe', {
      method: 'POST',
      body: JSON.stringify({ endpoint }),
    }),
};

/**
 * Backend URL for an attachment's bytes. The backend authenticates via the JWT
 * header, so this URL can't be used directly in <img>/<a> (no header there) —
 * fetch it via fetchAttachmentObjectUrl and use the resulting object URL.
 */
export function attachmentUrl(messageId: string, attId: string): string {
  return `${API_BASE}/api/messages/${messageId}/attachments/${attId}`;
}

/** Fetch attachment bytes as a Blob (sets the auth header via fetch). The caller owns
 * it — build an object URL for display, a File for the Web Share API, or a download. */
export async function fetchAttachmentBlob(messageId: string, attId: string): Promise<Blob> {
  const headers = new Headers();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  const res = await fetch(attachmentUrl(messageId, attId), { headers });
  if (!res.ok) throw new ApiError(res.status, 'attachment fetch failed');
  return res.blob();
}

/** Fetch attachment bytes as an object URL (sets the auth header via fetch). */
export async function fetchAttachmentObjectUrl(messageId: string, attId: string): Promise<string> {
  return URL.createObjectURL(await fetchAttachmentBlob(messageId, attId));
}

/**
 * Download the cached contacts as a `.vcf` file (auth header → can't be a plain
 * link). Fetches the export, then triggers a browser download via a temp anchor.
 */
export async function downloadContactsVcf(addressbook?: string | null): Promise<void> {
  const headers = new Headers();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  const qs = addressbook ? `?addressbook=${encodeURIComponent(addressbook)}` : '';
  const res = await fetch(`${API_BASE}/api/contacts/cards/export${qs}`, { headers });
  if (!res.ok) throw new ApiError(res.status, 'contacts export failed');
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `contacts-${new Date().toISOString().slice(0, 10)}.vcf`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

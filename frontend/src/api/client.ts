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
  CleanupMessagesDto,
  CleanupQueueStatusDto,
  CleanupSliceDto,
  CleanupSummaryDto,
  ContactCardDto,
  ContactCardInput,
  ContactDto,
  ContactImportResult,
  EnrichmentStatusDto,
  EventDraftDto,
  FolderDto,
  MessageDetailDto,
  MessageDto,
  PushSubscriptionDto,
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
let externalAuthGateway = false;

/**
 * Hard-navigate the document through the external auth gateway so it can show its
 * login and bounce us back to a freshly-authed app shell. Going via an /api path is
 * deliberate: the service worker serves the app shell from cache (so a plain reload
 * never reaches the gateway), but passes /api straight to the network, where the
 * gateway intercepts the expired session. See backend GET /api/auth/relogin.
 */
function gatewayRelogin(): void {
  window.location.assign(`${API_BASE}/api/auth/relogin`);
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

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (init.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const res = await fetch(`${API_BASE}${path}`, { ...init, headers });

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

/** Cleanup group-list paging/search: a domain substring (`q`), a page `offset`, thresholds. */
interface GroupPage {
  q?: string;
  offset?: number;
  years?: number;
  minMb?: number;
  months?: number;
}

/** Build the `?q=…&offset=…&years=…` query for a slice request (omitting empty parts). */
function groupQuery(opts: GroupPage): string {
  const p = new URLSearchParams();
  if (opts.q?.trim()) p.set('q', opts.q.trim());
  if (opts.offset) p.set('offset', String(opts.offset));
  if (opts.years) p.set('years', String(opts.years));
  if (opts.minMb) p.set('minMb', String(opts.minMb));
  if (opts.months) p.set('months', String(opts.months));
  const s = p.toString();
  return s ? `?${s}` : '';
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
        externalAuthGateway = !cfg.authRequired;
        return cfg;
      }
      // A 401/403 (or a redirect to a login page) on this PUBLIC endpoint can only
      // come from an external auth gateway — maily's own auth never gates it. So the
      // session expired at the gateway: bounce through it rather than show maily's
      // login. Other failures (5xx) fall through to the maily-login fallback, which
      // also avoids a redirect loop when the backend itself is down.
      if (res.status === 401 || res.status === 403 || res.redirected) {
        externalAuthGateway = true;
        gatewayRelogin();
        return { authRequired: false }; // navigating away; the value is moot
      }
    } catch {
      // Network/CORS error (incl. a blocked cross-origin gateway redirect). Can't tell
      // a logged-out gateway from a dead backend here, so fall through rather than risk
      // a reload loop.
    }
    return { authRequired: true };
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

  messages: (folderId: string, opts: { limit?: number; before?: number } = {}) => {
    const qs = new URLSearchParams();
    if (opts.limit) qs.set('limit', String(opts.limit));
    if (opts.before) qs.set('before', String(opts.before));
    const suffix = qs.toString() ? `?${qs}` : '';
    return request<MessageDto[]>(`/api/folders/${folderId}/messages${suffix}`);
  },

  /** Virtual "Unified Inbox": every account's inbox merged newest-first. */
  unifiedInbox: (opts: { limit?: number; before?: number } = {}) => {
    const qs = new URLSearchParams();
    if (opts.limit) qs.set('limit', String(opts.limit));
    if (opts.before) qs.set('before', String(opts.before));
    const suffix = qs.toString() ? `?${qs}` : '';
    return request<MessageDto[]>(`/api/inbox${suffix}`);
  },

  /** Virtual unified view for any mergeable role ("All sent", "All drafts", …). */
  unified: (role: string, opts: { limit?: number; before?: number } = {}) => {
    const qs = new URLSearchParams();
    if (opts.limit) qs.set('limit', String(opts.limit));
    if (opts.before) qs.set('before', String(opts.before));
    const suffix = qs.toString() ? `?${qs}` : '';
    return request<MessageDto[]>(`/api/unified/${role}${suffix}`);
  },

  /** Virtual "Archived" view for an account (archive folder minus inbox/sent/…). */
  archived: (accountId: string, opts: { limit?: number; before?: number } = {}) => {
    const qs = new URLSearchParams();
    if (opts.limit) qs.set('limit', String(opts.limit));
    if (opts.before) qs.set('before', String(opts.before));
    const suffix = qs.toString() ? `?${qs}` : '';
    return request<MessageDto[]>(`/api/accounts/${accountId}/archived${suffix}`);
  },

  message: (id: string) => request<MessageDetailDto>(`/api/messages/${id}`),

  setFlags: (id: string, flags: { seen?: boolean; flagged?: boolean }) =>
    request<{ ok: boolean; seen: boolean; flagged: boolean }>(`/api/messages/${id}/flags`, {
      method: 'PATCH',
      body: JSON.stringify(flags),
    }),

  /** Soft-delete → move to Trash (server tombstones + moves on IMAP out-of-band). */
  deleteMessage: (id: string) =>
    request<{ ok: boolean }>(`/api/messages/${id}`, { method: 'DELETE' }),

  /** Archive → move the inbox copy to the Archive folder (no tombstone). */
  archiveMessage: (id: string) =>
    request<{ ok: boolean }>(`/api/messages/${id}/archive`, { method: 'POST' }),

  send: (accountId: string, msg: SendMessageRequest) =>
    request<{ messageId?: string; appended?: boolean }>(`/api/accounts/${accountId}/send`, {
      method: 'POST',
      body: JSON.stringify(msg),
    }),

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
    dashboard: (opts: { years?: number; minMb?: number; months?: number } = {}) =>
      request<CleanupDashboardDto>(`/api/cleanup/dashboard${groupQuery(opts)}`),
    storage: (opts: GroupPage = {}) =>
      request<CleanupSliceDto>(`/api/cleanup/storage${groupQuery(opts)}`),
    neverReplied: (opts: GroupPage = {}) =>
      request<CleanupSliceDto>(`/api/cleanup/never-replied${groupQuery(opts)}`),
    coldStorage: (years?: number, opts: GroupPage = {}) =>
      request<CleanupSliceDto>(`/api/cleanup/cold-storage${groupQuery({ ...opts, years })}`),
    large: (minMb?: number, opts: GroupPage = {}) =>
      request<CleanupSliceDto>(`/api/cleanup/large${groupQuery({ ...opts, minMb })}`),
    unread: (months?: number, opts: GroupPage = {}) =>
      request<CleanupSliceDto>(`/api/cleanup/unread${groupQuery({ ...opts, months })}`),
    newsletters: (opts: GroupPage = {}) =>
      request<CleanupSliceDto>(`/api/cleanup/newsletters${groupQuery(opts)}`),
    /** Drill a delete-eligible slice down to messages, optionally sender-scoped/searched. */
    messages: (opts: {
      slice: string;
      domain?: string;
      q?: string;
      years?: number;
      minMb?: number;
      months?: number;
      limit?: number;
      offset?: number;
    }) => {
      const q = new URLSearchParams({ slice: opts.slice });
      if (opts.domain) q.set('domain', opts.domain);
      if (opts.q) q.set('q', opts.q);
      if (opts.years) q.set('years', String(opts.years));
      if (opts.minMb) q.set('minMb', String(opts.minMb));
      if (opts.months) q.set('months', String(opts.months));
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
    /** Trash-queue progress for the "Moving N to Trash…" readout. */
    queueStatus: () => request<CleanupQueueStatusDto>('/api/cleanup/queue'),
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

/** Fetch attachment bytes as an object URL (sets the auth header via fetch). */
export async function fetchAttachmentObjectUrl(messageId: string, attId: string): Promise<string> {
  const headers = new Headers();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  const res = await fetch(attachmentUrl(messageId, attId), { headers });
  if (!res.ok) throw new ApiError(res.status, 'attachment fetch failed');
  return URL.createObjectURL(await res.blob());
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

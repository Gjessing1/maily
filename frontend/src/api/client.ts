/**
 * Typed HTTP client for the maily backend. Heavy payloads (bodies, attachment
 * bytes) come over HTTP per ARCHITECTURE §3. The JWT is attached to every
 * request; a 401 clears it and notifies listeners so the UI can bounce to login.
 */
import type {
  AccountDto,
  AccountSyncStatusDto,
  AddressbookSettingsDto,
  ContactCardDto,
  ContactCardInput,
  ContactDto,
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

export const api = {
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

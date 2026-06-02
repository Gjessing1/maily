/**
 * Typed HTTP client for the maily backend. Heavy payloads (bodies, attachment
 * bytes) come over HTTP per ARCHITECTURE §3. The JWT is attached to every
 * request; a 401 clears it and notifies listeners so the UI can bounce to login.
 */
import type {
  AccountDto,
  AccountSyncStatusDto,
  FolderDto,
  MessageDetailDto,
  MessageDto,
  PushSubscriptionDto,
  SendMessageRequest,
  ServerConfigDto,
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

  messages: (folderId: string, opts: { limit?: number; before?: number } = {}) => {
    const qs = new URLSearchParams();
    if (opts.limit) qs.set('limit', String(opts.limit));
    if (opts.before) qs.set('before', String(opts.before));
    const suffix = qs.toString() ? `?${qs}` : '';
    return request<MessageDto[]>(`/api/folders/${folderId}/messages${suffix}`);
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

  search: (q: string, opts: { accountId?: string; limit?: number } = {}) => {
    const qs = new URLSearchParams({ q });
    if (opts.accountId) qs.set('accountId', opts.accountId);
    if (opts.limit) qs.set('limit', String(opts.limit));
    return request<MessageDto[]>(`/api/search?${qs}`);
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

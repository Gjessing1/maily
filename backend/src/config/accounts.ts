/**
 * Mail-account configuration, read from `ACCOUNT_<n>_*` env vars.
 *
 * Credentials are backend-only and never persisted to the DB or exposed to the
 * frontend (ARCHITECTURE §5). The DB `accounts` row holds only non-secret
 * connection metadata; the password lives here, in process memory, only.
 */
import type { Provider } from '@maily/shared';

export interface AccountConfig {
  /** 1-based index from the env var name (`ACCOUNT_1_*`). Stable per deployment. */
  index: number;
  provider: Provider;
  email: string;
  displayName?: string;
  imap: {
    host: string;
    port: number;
    secure: boolean;
    user: string;
    pass: string;
  };
  smtp: {
    host: string;
    port: number;
    secure: boolean;
    user: string;
    pass: string;
  };
}

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return value === '1' || value.toLowerCase() === 'true';
}

/** Discover configured account indices by scanning for `ACCOUNT_<n>_EMAIL`. */
function discoverIndices(): number[] {
  const indices = new Set<number>();
  for (const key of Object.keys(process.env)) {
    const match = /^ACCOUNT_(\d+)_EMAIL$/.exec(key);
    if (match) indices.add(Number(match[1]));
  }
  return [...indices].sort((a, b) => a - b);
}

function readAccount(index: number): AccountConfig {
  const prefix = `ACCOUNT_${index}_`;
  const get = (name: string): string | undefined => process.env[`${prefix}${name}`];
  const need = (name: string): string => {
    const value = get(name);
    if (!value) throw new Error(`Missing required env var: ${prefix}${name}`);
    return value;
  };

  const provider = (get('PROVIDER') ?? 'imap') as Provider;
  if (provider !== 'gmail' && provider !== 'imap') {
    throw new Error(`${prefix}PROVIDER must be 'gmail' or 'imap', got '${provider}'`);
  }

  const email = need('EMAIL');
  // User/password default to the account email + a single PASSWORD var for the common case.
  const imapUser = get('USER') ?? email;
  const password = need('PASSWORD');
  const imapPort = Number(get('IMAP_PORT') ?? '993');
  const smtpPort = Number(get('SMTP_PORT') ?? '465');

  return {
    index,
    provider,
    email,
    displayName: get('DISPLAY_NAME'),
    imap: {
      host: need('IMAP_HOST'),
      port: imapPort,
      // Implicit TLS on 993; STARTTLS handled by imapflow when secure=false.
      secure: bool(get('IMAP_SECURE'), imapPort === 993),
      user: imapUser,
      pass: password,
    },
    smtp: {
      host: need('SMTP_HOST'),
      port: smtpPort,
      secure: bool(get('SMTP_SECURE'), smtpPort === 465),
      user: get('SMTP_USER') ?? imapUser,
      pass: get('SMTP_PASSWORD') ?? password,
    },
  };
}

/** Parse all configured accounts. Returns [] when none are set (Phase 0 boot). */
export function loadAccountConfigs(): AccountConfig[] {
  return discoverIndices().map(readAccount);
}

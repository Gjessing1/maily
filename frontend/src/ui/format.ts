/** Small presentation helpers shared across list and reader views. */
import { getPrefs, type DateFormat } from '../state/prefs';

const pad = (n: number): string => String(n).padStart(2, '0');

/** Render a full calendar date per the user's chosen format ('system' = locale). */
function numericDate(d: Date, fmt: DateFormat, opts?: { shortYear?: boolean }): string {
  const dd = pad(d.getDate());
  const mm = pad(d.getMonth() + 1);
  const yyyy = d.getFullYear();
  const yy = pad(yyyy % 100);
  switch (fmt) {
    case 'dmy':
      return opts?.shortYear ? `${dd}.${mm}.${yy}` : `${dd}.${mm}.${yyyy}`;
    case 'mdy':
      return opts?.shortYear ? `${mm}/${dd}/${yy}` : `${mm}/${dd}/${yyyy}`;
    case 'ymd':
      return `${yyyy}-${mm}-${dd}`;
    default:
      return d.toLocaleDateString(undefined, {
        year: opts?.shortYear ? '2-digit' : 'numeric',
        month: 'numeric',
        day: 'numeric',
      });
  }
}

/** Compact, relative-ish timestamp for list rows (Apple Mail style). */
export function shortDate(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) {
    return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
  }
  const diffDays = (now.getTime() - d.getTime()) / 86_400_000;
  if (diffDays < 7) return d.toLocaleDateString(undefined, { weekday: 'short' });
  const fmt = getPrefs().dateFormat;
  if (fmt === 'system' && d.getFullYear() === now.getFullYear()) {
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }
  return numericDate(d, fmt, { shortYear: true });
}

/** Full timestamp for the reader header. */
export function fullDate(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const fmt = getPrefs().dateFormat;
  const time = d.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  if (fmt === 'system') {
    return d.toLocaleString(undefined, {
      weekday: 'short',
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  }
  return `${numericDate(d, fmt)} ${time}`;
}

/** Best display name for a sender. */
export function senderName(name: string | null, address: string | null): string {
  return name?.trim() || address || '(unknown sender)';
}

/** Two-letter avatar initials. */
export function initials(name: string | null, address: string | null): string {
  const src = (name?.trim() || address || '?').replace(/[<>"]/g, '');
  const parts = src.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
  return src.slice(0, 2).toUpperCase();
}

/** Deterministic accent for an avatar from a string. */
export function avatarHue(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i += 1) h = (h * 31 + seed.charCodeAt(i)) % 360;
  return h;
}

/**
 * Canonical query IR + parser (ROADMAP §3.7.D, Query Contract Layer seam for
 * Phase 4). Advanced search is the IR's first consumer: the UI search string is
 * parsed into this structured, backend-agnostic shape *here*, and compiled to
 * FTS5 MATCH + SQL predicates separately (see `search/local.ts` `searchLocalIR`).
 * Keeping parse and compile apart is what lets later consumers (NL→query, vector
 * retrieval) target the same IR without it being rewritten.
 *
 * Supported operators:
 *   from:  to:  subject:/subj:   — substring match on the respective field(s)
 *   since:/after:  before:/until: — date bounds (YYYY-MM-DD or relative 7d/2w/3m/1y)
 *   has:attachment                — only messages with a non-inline attachment
 *   larger:/smaller:  (or size:>/<) — attachment-size bounds (e.g. 500k, 2M)
 *   is:unread/read  is:flagged/starred  is:answered — message-state filters
 *   filename:                     — substring match on an attachment filename
 * Anything else is a free-text term, AND-joined into the FTS MATCH.
 */

/** The structured, compile-target-agnostic representation of a search query. */
export interface QueryIR {
  /** Free-text terms (AND-joined) for the FTS5 index. */
  terms: string[];
  from?: string;
  to?: string;
  subject?: string;
  /** Inclusive lower bound on receivedAt (epoch ms). */
  sinceMs?: number;
  /** Exclusive upper bound on receivedAt (epoch ms). */
  beforeMs?: number;
  hasAttachment?: boolean;
  /** Lower/upper bounds on a (non-inline) attachment's size, in bytes. */
  minAttachmentSize?: number;
  maxAttachmentSize?: number;
  /** Read-state filter: true ⇒ unread only, false ⇒ read only. */
  unread?: boolean;
  /** Only flagged/starred messages. */
  flagged?: boolean;
  /** Only messages the user has replied to. */
  answered?: boolean;
  /** Substring match on a (non-inline) attachment's filename. */
  filename?: string;
}

const SIZE_UNITS: Record<string, number> = {
  k: 1024,
  m: 1024 * 1024,
  g: 1024 * 1024 * 1024,
};

/** Parse a human size like `500k`, `2M`, `1.5g`, or a bare byte count. */
export function parseSize(raw: string): number | undefined {
  const m = /^(\d+(?:\.\d+)?)\s*([kmg])?b?$/i.exec(raw.trim());
  if (!m) return undefined;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return undefined;
  const unit = m[2] ? SIZE_UNITS[m[2].toLowerCase()]! : 1;
  return Math.round(n * unit);
}

const RELATIVE_UNITS: Record<string, number> = {
  d: 86_400_000,
  w: 7 * 86_400_000,
  m: 30 * 86_400_000,
  y: 365 * 86_400_000,
};

/** Parse a date bound: `YYYY-MM-DD`, `today`, or relative `7d`/`2w`/`3m`/`1y`. */
export function parseDate(raw: string, now = Date.now()): number | undefined {
  const v = raw.trim().toLowerCase();
  if (v === 'today') {
    const d = new Date(now);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  }
  const rel = /^(\d+)([dwmy])$/.exec(v);
  if (rel) return now - Number(rel[1]) * RELATIVE_UNITS[rel[2]!]!;
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    const ms = Date.parse(`${v}T00:00:00Z`);
    return Number.isNaN(ms) ? undefined : ms;
  }
  return undefined;
}

/** Split a query string into tokens, keeping `"quoted phrases"` (incl. `key:"…"`) intact. */
function tokenize(raw: string): string[] {
  return raw.match(/(?:[^\s"]+|"[^"]*")+/g) ?? [];
}

/** Strip surrounding double quotes from a value. */
function unquote(v: string): string {
  return v.replace(/^"(.*)"$/s, '$1');
}

/** Parse a user search string into the canonical query IR. */
export function parseQuery(raw: string, now = Date.now()): QueryIR {
  const ir: QueryIR = { terms: [] };

  for (const token of tokenize(raw)) {
    const colon = token.indexOf(':');
    // No operator → free-text term (quotes stripped).
    if (colon <= 0) {
      const term = unquote(token).trim();
      if (term) ir.terms.push(term);
      continue;
    }

    const key = token.slice(0, colon).toLowerCase();
    const value = unquote(token.slice(colon + 1)).trim();

    switch (key) {
      case 'from':
        if (value) ir.from = value;
        break;
      case 'to':
        if (value) ir.to = value;
        break;
      case 'subject':
      case 'subj':
        if (value) ir.subject = value;
        break;
      case 'since':
      case 'after': {
        const ms = parseDate(value, now);
        if (ms !== undefined) ir.sinceMs = ms;
        break;
      }
      case 'before':
      case 'until': {
        const ms = parseDate(value, now);
        if (ms !== undefined) ir.beforeMs = ms;
        break;
      }
      case 'has':
        if (/^attachments?$/i.test(value)) ir.hasAttachment = true;
        break;
      case 'is':
        switch (value.toLowerCase()) {
          case 'unread':
            ir.unread = true;
            break;
          case 'read':
            ir.unread = false;
            break;
          case 'flagged':
          case 'starred':
            ir.flagged = true;
            break;
          case 'answered':
          case 'replied':
            ir.answered = true;
            break;
          default:
            // Unknown state → keep the whole token as a free-text term.
            ir.terms.push(token);
        }
        break;
      case 'filename':
      case 'file':
        if (value) ir.filename = value;
        break;
      case 'larger':
      case 'bigger': {
        const n = parseSize(value);
        if (n !== undefined) ir.minAttachmentSize = n;
        break;
      }
      case 'smaller': {
        const n = parseSize(value);
        if (n !== undefined) ir.maxAttachmentSize = n;
        break;
      }
      case 'size': {
        // size:>1M / size:<1M / size:1M (bare ⇒ lower bound)
        const op = value[0];
        const n = parseSize(op === '>' || op === '<' ? value.slice(1) : value);
        if (n !== undefined) {
          if (op === '<') ir.maxAttachmentSize = n;
          else ir.minAttachmentSize = n;
        }
        break;
      }
      default:
        // Unknown operator → keep the whole token as a free-text term.
        ir.terms.push(token);
    }
  }

  return ir;
}

/** True when the IR has any constraint at all (else there's nothing to search for). */
export function isEmptyQuery(ir: QueryIR): boolean {
  return (
    ir.terms.length === 0 &&
    ir.from === undefined &&
    ir.to === undefined &&
    ir.subject === undefined &&
    ir.sinceMs === undefined &&
    ir.beforeMs === undefined &&
    ir.hasAttachment === undefined &&
    ir.minAttachmentSize === undefined &&
    ir.maxAttachmentSize === undefined &&
    ir.unread === undefined &&
    ir.flagged === undefined &&
    ir.answered === undefined &&
    ir.filename === undefined
  );
}

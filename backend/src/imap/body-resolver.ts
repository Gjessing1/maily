/**
 * MIME-tree-aware display-body selection shared by BODYSTRUCTURE and raw `.eml`
 * parsing. The resolver is deliberately independent of either parser: callers
 * project their tree onto MimeBodyNode and attach the value needed to fetch/read a
 * leaf (an IMAP part id or a source-walk ordinal).
 */

export type DisplayBodyKind = 'plain' | 'html';

export interface MimeBodyNode<T> {
  type: string;
  disposition?: string;
  hasFilename?: boolean;
  contentId?: string | null;
  /** Content-ID named by multipart/related's `start` parameter. */
  relatedStart?: string | null;
  value?: T;
  children?: MimeBodyNode<T>[];
}

export interface DisplayBodyPart<T> {
  kind: DisplayBodyKind;
  value: T;
}

export interface ResolvedMimeBody<T> {
  /** Parts rendered in document order. Usually one; multipart/mixed may have several. */
  display: DisplayBodyPart<T>[];
  /** Clean text/plain alternative retained as a snippet/accessibility fallback. */
  plainFallback: T | null;
  calendar: T | null;
}

const empty = <T>(): ResolvedMimeBody<T> => ({
  display: [],
  plainFallback: null,
  calendar: null,
});

function firstPlain<T>(result: ResolvedMimeBody<T>): T | null {
  return result.display.find((part) => part.kind === 'plain')?.value ?? result.plainFallback;
}

function resolveNode<T>(node: MimeBodyNode<T>): ResolvedMimeBody<T> {
  const type = node.type.toLowerCase();
  // A forwarded message is separate content, not another body alternative of the
  // enclosing message. Exclude it whether it is inline or attached.
  if (type === 'message/rfc822') return empty();

  const children = node.children ?? [];
  if (children.length > 0) {
    const childResults = children.map((child) => resolveNode(child));
    const subtype = type.startsWith('multipart/') ? type.slice('multipart/'.length) : '';

    if (subtype === 'alternative') {
      // RFC 2046: alternatives increase in faithfulness, so the last supported
      // child wins. Do not compare leaves across sibling mixed branches.
      let winner: ResolvedMimeBody<T> | null = null;
      for (const result of childResults) if (result.display.length > 0) winner = result;
      if (!winner) {
        return {
          display: [],
          plainFallback: childResults.map(firstPlain).findLast((v) => v != null) ?? null,
          calendar: childResults.map((r) => r.calendar).find((v) => v != null) ?? null,
        };
      }
      return {
        display: winner.display,
        plainFallback:
          firstPlain(winner) ?? childResults.map(firstPlain).findLast((v) => v != null) ?? null,
        calendar:
          winner.calendar ?? childResults.map((r) => r.calendar).find((v) => v != null) ?? null,
      };
    }

    if (subtype === 'related') {
      const wanted = node.relatedStart?.replace(/^<|>$/g, '').toLowerCase();
      const rootIndex = wanted
        ? children.findIndex(
            (child) => child.contentId?.replace(/^<|>$/g, '').toLowerCase() === wanted,
          )
        : 0;
      return childResults[rootIndex >= 0 ? rootIndex : 0] ?? empty();
    }

    // multipart/mixed (and unknown multipart subtypes) contains independent body
    // branches. Preserve every selected branch in document order instead of making
    // them compete as though they were alternatives.
    return {
      display: childResults.flatMap((result) => result.display),
      plainFallback: childResults.map(firstPlain).find((v) => v != null) ?? null,
      calendar: childResults.map((result) => result.calendar).find((v) => v != null) ?? null,
    };
  }

  const disposition = (node.disposition ?? '').toLowerCase();
  if (disposition === 'attachment' || node.hasFilename || node.value === undefined) return empty();
  if (type === 'text/plain') {
    return {
      display: [{ kind: 'plain', value: node.value }],
      plainFallback: node.value,
      calendar: null,
    };
  }
  if (type === 'text/html') {
    return { display: [{ kind: 'html', value: node.value }], plainFallback: null, calendar: null };
  }
  if (type === 'text/calendar') {
    return { display: [], plainFallback: null, calendar: node.value };
  }
  return empty();
}

export function resolveMimeBody<T>(root: MimeBodyNode<T> | undefined): ResolvedMimeBody<T> {
  return root ? resolveNode(root) : empty();
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Materialise fetched/decoded leaves into the two persisted body columns. */
export function materializeMimeBody(selected: ResolvedMimeBody<string>): {
  bodyText: string | null;
  bodyHtml: string | null;
  bodyCalendar: string | null;
} {
  const usable = selected.display.filter((part) => part.value.trim());
  const htmlParts = usable.filter((part) => part.kind === 'html');
  const plainParts = usable.filter((part) => part.kind === 'plain');
  let bodyHtml: string | null = null;
  let bodyText: string | null = selected.plainFallback?.trim() ? selected.plainFallback : null;

  if (htmlParts.length > 0 && plainParts.length === 0) {
    bodyHtml = htmlParts.map((part) => part.value).join('\n');
  } else if (htmlParts.length > 0) {
    // A mixed message can legitimately carry independent plain and HTML bodies.
    // Preserve their order in one renderable document instead of silently dropping
    // one representation. Alternative plaintext never enters `display` here.
    bodyHtml = usable
      .map((part) =>
        part.kind === 'html'
          ? `<section data-maily-mime-part="html">${part.value}</section>`
          : `<pre data-maily-mime-part="plain">${escapeHtml(part.value)}</pre>`,
      )
      .join('\n');
  } else if (plainParts.length > 0) {
    bodyText = plainParts.map((part) => part.value).join('\n\n');
  }

  const calendar = selected.calendar?.trim() ? selected.calendar : null;
  return { bodyText, bodyHtml, bodyCalendar: calendar };
}

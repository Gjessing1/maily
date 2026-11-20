import { htmlToVisibleText } from '../imap/parse.js';

/** Extract the reader's HTML text and skip a duplicate plain-text alternative. */
export function htmlSearchText(html: string | null, plain: string | null): string {
  if (!html) return '';
  const visible = htmlToVisibleText(html);
  return visible.replace(/\s+/g, ' ') === plain?.trim().replace(/\s+/g, ' ') ? '' : visible;
}

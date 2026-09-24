/**
 * Content columns shared by every route, so a wide or ultrawide window centres each
 * view at a width that suits what it shows instead of stretching rows edge to edge.
 *
 * The pattern (Contacts started it): the sticky header and the scrolling `<main>` stay
 * full-bleed — the header's border and blur span the window, and a wheel over the side
 * gutters still scrolls the page — while an inner element carrying one of these classes
 * holds the content. Every class is a no-op below its max width, so phones are
 * unaffected.
 */

/** Message lists: Home without the split pane, Search results, the Outbox. */
export const LIST_COLUMN = 'mx-auto w-full max-w-5xl';

/** One message or one draft: the full-screen reader and the composer. */
export const READING_COLUMN = 'mx-auto w-full max-w-4xl';

/** Forms and dashboards: Contacts, Cleanup, a Settings section. */
export const NARROW_COLUMN = 'mx-auto w-full max-w-2xl';

/** Settings' section menu plus the open section, kept together as one group. */
export const SETTINGS_COLUMN = 'mx-auto w-full max-w-6xl';

/** List and reading pane side by side: wide, but not the whole of an ultrawide. */
export const SPLIT_FRAME = 'mx-auto w-full max-w-[120rem]';

/**
 * `right` for a button pinned to the bottom-right of a centred column: the column's own
 * right edge on a window wider than it, the usual 1.25rem inset on anything narrower.
 * `columnRem` must match the column's max width.
 */
export function pinnedRight(columnRem: number): string {
  return `max(1.25rem, calc((100vw - ${columnRem}rem) / 2 + 1.25rem))`;
}

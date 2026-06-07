/**
 * Lightweight rich-text composer (ROADMAP §3.7.B). A `contentEditable` surface —
 * no editor dependency, in keeping with the project's hand-rolled UI. Emits HTML
 * via `onChange`; the caller derives the plain-text alternative (see htmlText.ts).
 *
 * Formatting comes from three sources, all converging on the same DOM:
 *  - a toolbar (bold / italic / lists / link),
 *  - keyboard shortcuts (Ctrl/⌘+B, +I, +K),
 *  - Markdown auto-format: block markers (`#`, `##`, `###`, `-`, `*`, `1.`, `>`)
 *    fire on Space at line start; inline `**bold**`, `*italic*`/`_italic_` and
 *    `` `code` `` convert as you type the closing delimiter.
 *
 * The element is uncontrolled: `initialHtml` seeds it once on mount so the caret
 * never jumps. `resetKey` forces a reseed (e.g. when a draft is restored).
 */
import { useEffect, useRef, useState } from 'react';
import { BoldIcon, ItalicIcon, LinkIcon, ListIcon, ListOrderedIcon } from '../ui/icons';

interface Props {
  initialHtml?: string;
  onChange: (html: string) => void;
  placeholder?: string;
  className?: string;
  /** Change this to force the editor to reseed from `initialHtml`. */
  resetKey?: string | number;
}

// execCommand is deprecated but remains the only cross-browser primitive for rich
// editing in contentEditable; the modern replacement (a custom transform layer)
// is far heavier than this composer warrants.
function exec(command: string, value?: string): void {
  document.execCommand(command, false, value);
}

/** Escape a string for safe interpolation into an HTML attribute or text node. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Add a default scheme to a bare URL so `example.com` becomes a real link. */
function normalizeUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) return '';
  // Leave explicit schemes (http, https, mailto, tel, …) untouched.
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

/** Remove `count` characters immediately before the collapsed caret. */
function deleteBeforeCaret(node: Node, offset: number, count: number): void {
  const range = document.createRange();
  range.setStart(node, offset - count);
  range.setEnd(node, offset);
  range.deleteContents();
  // Collapse the live selection to the deletion point. deleteContents only mutates
  // the throwaway range, leaving the document selection stale — a following
  // execCommand (insertText / formatBlock) would then target the wrong place.
  range.collapse(true);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
}

/** Wrap [start,end) of a text node in `tag`, placing the caret just after it. */
function wrapRange(node: Text, start: number, end: number, tag: string, inner: string): void {
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, end);
  range.deleteContents();

  const el = document.createElement(tag);
  el.textContent = inner;
  range.insertNode(el);

  // A zero-width text node after the element gives the caret somewhere outside the
  // formatted run to land, so continued typing isn't swallowed into the bold/italic.
  // ZWSP is stripped on serialize (htmlText.ts) so it never reaches the wire.
  const tail = document.createTextNode('\u200b');
  el.after(tail);
  const after = document.createRange();
  after.setStart(tail, 1);
  after.collapse(true);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(after);
}

const INLINE_RULES: { re: RegExp; tag: string }[] = [
  { re: /\*\*([^*\n]+?)\*\*$/, tag: 'strong' },
  { re: /__([^_\n]+?)__$/, tag: 'strong' },
  { re: /(?<![*\w])\*([^*\n]+?)\*$/, tag: 'em' },
  { re: /(?<![_\w])_([^_\n]+?)_$/, tag: 'em' },
  { re: /`([^`\n]+?)`$/, tag: 'code' },
];

/** Convert a just-completed inline Markdown run at the caret. Returns true if it did. */
function tryInlineMarkdown(): boolean {
  const sel = window.getSelection();
  if (!sel || !sel.isCollapsed || !sel.anchorNode) return false;
  const node = sel.anchorNode;
  if (node.nodeType !== Node.TEXT_NODE) return false;
  const offset = sel.anchorOffset;
  const before = (node.textContent ?? '').slice(0, offset);

  for (const { re, tag } of INLINE_RULES) {
    const m = re.exec(before);
    if (m?.[1]) {
      wrapRange(node as Text, offset - m[0].length, offset, tag, m[1]);
      return true;
    }
  }
  return false;
}

/** Block-level Markdown markers, keyed by the text typed before the triggering Space. */
function applyBlockMarkdown(marker: string): boolean {
  // formatBlock's tag arg must be angle-bracketed to work in every engine (Firefox
  // ignores the bare 'H1' form Chrome tolerates) — pass '<h1>' so #/##/### all apply.
  //
  // It also silently no-ops on a truly empty line, which is exactly the state we're
  // in: the marker text ("#", ">"…) was just removed by deleteBeforeCaret. So seed a
  // zero-width space first to give formatBlock a non-empty line to wrap; the caret
  // lands after it inside the new block, and cleanEditorHtml strips ZWSP off the wire.
  // (List commands wrap an empty line fine, so they don't need the seed.)
  const formatBlock = (tag: string): void => {
    exec('insertText', '\u200b');
    exec('formatBlock', tag);
  };
  switch (marker) {
    case '#':
      formatBlock('<h1>');
      return true;
    case '##':
      formatBlock('<h2>');
      return true;
    case '###':
      formatBlock('<h3>');
      return true;
    case '-':
    case '*':
      exec('insertUnorderedList');
      return true;
    case '>':
      formatBlock('<blockquote>');
      return true;
    default:
      if (/^\d+\.$/.test(marker)) {
        exec('insertOrderedList');
        return true;
      }
      return false;
  }
}

export function RichTextEditor({ initialHtml, onChange, placeholder, className, resetKey }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  // The caret/selection at the moment the link dialog opened. A dialog input steals
  // focus and collapses the editor selection, so we stash the range and restore it
  // before inserting the anchor.
  const savedRange = useRef<Range | null>(null);
  const [linkDraft, setLinkDraft] = useState<{ url: string; text: string } | null>(null);

  // Seed once on mount, and again whenever resetKey changes (draft restore).
  useEffect(() => {
    if (ref.current) ref.current.innerHTML = initialHtml ?? '';
  }, [resetKey, initialHtml]);

  const emit = (): void => {
    if (ref.current) onChange(ref.current.innerHTML);
  };

  /** Open the link dialog, seeding the display text from the current selection. */
  function openLinkDialog(): void {
    const sel = window.getSelection();
    const range = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
    // Only keep a selection that lives inside this editor.
    savedRange.current =
      range && ref.current?.contains(range.commonAncestorContainer) ? range.cloneRange() : null;
    setLinkDraft({ url: '', text: savedRange.current?.toString() ?? '' });
  }

  /** Insert the composed link at the saved selection and close the dialog. */
  function applyLink(): void {
    const draft = linkDraft;
    setLinkDraft(null);
    if (!draft) return;
    const href = normalizeUrl(draft.url);
    if (!href) return;
    const text = draft.text.trim() || href;

    ref.current?.focus();
    const sel = window.getSelection();
    if (savedRange.current && sel) {
      sel.removeAllRanges();
      sel.addRange(savedRange.current);
    }
    savedRange.current = null;
    // insertHTML replaces the selection (if any) with the anchor, so a selection's
    // text is swapped for the chosen display text rather than left orphaned.
    exec('insertHTML', `<a href="${escapeHtml(href)}">${escapeHtml(text)}</a>`);
    emit();
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>): void {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && !e.altKey) {
      const key = e.key.toLowerCase();
      if (key === 'b') {
        e.preventDefault();
        exec('bold');
        emit();
        return;
      }
      if (key === 'i') {
        e.preventDefault();
        exec('italic');
        emit();
        return;
      }
      if (key === 'k') {
        e.preventDefault();
        openLinkDialog();
        return;
      }
    }

    // Block markdown fires on Space when the line so far is just a marker.
    if (e.key === ' ') {
      const sel = window.getSelection();
      if (sel?.isCollapsed && sel.anchorNode?.nodeType === Node.TEXT_NODE) {
        const node = sel.anchorNode;
        const offset = sel.anchorOffset;
        const before = (node.textContent ?? '').slice(0, offset).replace(/\u00a0/g, ' ');
        const m = /^(#{1,3}|[-*>]|\d+\.)$/.exec(before.trimStart());
        if (m?.[1]) {
          e.preventDefault();
          deleteBeforeCaret(node, offset, before.length);
          applyBlockMarkdown(m[1]);
          emit();
        }
      }
    }
  }

  function onInput(): void {
    // Inline markdown may rewrite the DOM in place; either way report the new HTML.
    tryInlineMarkdown();
    emit();
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-1 border-b border-border px-2 py-1.5">
        <ToolbarButton
          label="Bold"
          onClick={() => exec('bold')}
          icon={<BoldIcon className="size-4" />}
          after={emit}
        />
        <ToolbarButton
          label="Italic"
          onClick={() => exec('italic')}
          icon={<ItalicIcon className="size-4" />}
          after={emit}
        />
        <ToolbarButton
          label="Bulleted list"
          onClick={() => exec('insertUnorderedList')}
          icon={<ListIcon className="size-4" />}
          after={emit}
        />
        <ToolbarButton
          label="Numbered list"
          onClick={() => exec('insertOrderedList')}
          icon={<ListOrderedIcon className="size-4" />}
          after={emit}
        />
        <ToolbarButton
          label="Link"
          onClick={openLinkDialog}
          icon={<LinkIcon className="size-4" />}
          after={() => undefined}
        />
      </div>
      <div
        ref={ref}
        contentEditable
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="true"
        data-placeholder={placeholder}
        onKeyDown={onKeyDown}
        onInput={onInput}
        className={`rich-editor flex-1 overflow-y-auto bg-transparent text-[15px] leading-relaxed outline-none ${className ?? ''}`}
      />
      {linkDraft && (
        <LinkDialog
          draft={linkDraft}
          onChange={setLinkDraft}
          onCancel={() => {
            savedRange.current = null;
            setLinkDraft(null);
          }}
          onConfirm={applyLink}
        />
      )}
    </div>
  );
}

/** Modal for composing a link: separate URL and display-text fields. */
function LinkDialog({
  draft,
  onChange,
  onCancel,
  onConfirm,
}: {
  draft: { url: string; text: string };
  onChange: (d: { url: string; text: string }) => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/50 p-4"
      onMouseDown={onCancel}
    >
      <div
        className="w-full max-w-sm rounded-2xl border border-border bg-surface p-4 shadow-xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h2 className="mb-3 text-base font-semibold">Insert link</h2>
        <label className="mb-1 block text-xs text-faint">URL</label>
        <input
          autoFocus
          value={draft.url}
          onChange={(e) => onChange({ ...draft, url: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              onConfirm();
            }
          }}
          placeholder="https://example.com"
          className="mb-3 w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm outline-none placeholder:text-faint"
        />
        <label className="mb-1 block text-xs text-faint">Display text</label>
        <input
          value={draft.text}
          onChange={(e) => onChange({ ...draft, text: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              onConfirm();
            }
          }}
          placeholder="Link text (defaults to the URL)"
          className="mb-4 w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm outline-none placeholder:text-faint"
        />
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-full px-4 py-2 text-sm text-faint active:bg-surface-2"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={!draft.url.trim()}
            className="rounded-full bg-accent px-4 py-2 text-sm font-medium text-white active:scale-95 disabled:opacity-40"
          >
            Insert
          </button>
        </div>
      </div>
    </div>
  );
}

function ToolbarButton({
  label,
  icon,
  onClick,
  after,
}: {
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
  after: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      // Keep focus in the editable surface so execCommand targets the selection.
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => {
        onClick();
        after();
      }}
      className="rounded-md p-2 text-faint active:bg-surface-2"
    >
      {icon}
    </button>
  );
}

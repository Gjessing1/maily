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
import { useEffect, useRef } from 'react';
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

/** Remove `count` characters immediately before the collapsed caret. */
function deleteBeforeCaret(node: Node, offset: number, count: number): void {
  const range = document.createRange();
  range.setStart(node, offset - count);
  range.setEnd(node, offset);
  range.deleteContents();
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
  switch (marker) {
    case '#':
      exec('formatBlock', 'H1');
      return true;
    case '##':
      exec('formatBlock', 'H2');
      return true;
    case '###':
      exec('formatBlock', 'H3');
      return true;
    case '-':
    case '*':
      exec('insertUnorderedList');
      return true;
    case '>':
      exec('formatBlock', 'BLOCKQUOTE');
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

  // Seed once on mount, and again whenever resetKey changes (draft restore).
  useEffect(() => {
    if (ref.current) ref.current.innerHTML = initialHtml ?? '';
  }, [resetKey, initialHtml]);

  const emit = (): void => {
    if (ref.current) onChange(ref.current.innerHTML);
  };

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
        const url = window.prompt('Link URL');
        if (url) exec('createLink', url);
        emit();
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
          onClick={() => {
            const url = window.prompt('Link URL');
            if (url) exec('createLink', url);
          }}
          icon={<LinkIcon className="size-4" />}
          after={emit}
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

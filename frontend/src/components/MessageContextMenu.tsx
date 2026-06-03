import { useLayoutEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { AccountDto, MessageDto } from '@maily/shared';
import { api } from '../api/client';
import { buildForward, buildReply, buildReplyAll } from '../state/replyPrefill';
import {
  ArchiveIcon,
  CheckIcon,
  ForwardIcon,
  MailIcon,
  MailOpenIcon,
  ReplyAllIcon,
  ReplyIcon,
  TrashIcon,
} from '../ui/icons';

/** Estimated menu box; used to flip the anchor when near the viewport edge. */
const MENU_W = 220;
const MENU_H = 340;

interface Item {
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
  danger?: boolean;
  divider?: boolean;
}

/**
 * Right-click action menu for a single inbox row. Reply/Reply-all/Forward need the
 * full message (body for quoting), so they lazy-fetch the detail then navigate to
 * compose via the shared `replyPrefill` builders — identical to the reader's bar.
 * Mark/Archive/Delete/Select only need the id and run through the caller's handlers.
 */
export function MessageContextMenu({
  message,
  accounts,
  x,
  y,
  onClose,
  onToggleRead,
  onArchive,
  onDelete,
  onSelect,
}: {
  message: MessageDto;
  accounts: AccountDto[];
  x: number;
  y: number;
  onClose: () => void;
  onToggleRead: (id: string, seen: boolean) => void;
  onArchive: (id: string) => void;
  onDelete: (id: string) => void;
  onSelect: (id: string) => void;
}) {
  const navigate = useNavigate();
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  // Flip the menu back inside the viewport when opened near the right/bottom edge.
  useLayoutEffect(() => {
    const w = menuRef.current?.offsetWidth ?? MENU_W;
    const h = menuRef.current?.offsetHeight ?? MENU_H;
    const left = Math.min(x, window.innerWidth - w - 8);
    const top = Math.min(y, window.innerHeight - h - 8);
    setPos({ left: Math.max(8, left), top: Math.max(8, top) });
  }, [x, y]);

  // Fetch the full message, build a compose prefill, navigate. Closes either way.
  async function compose(build: (d: Awaited<ReturnType<typeof api.message>>) => unknown) {
    onClose();
    try {
      const detail = await api.message(message.id);
      navigate('/compose', { state: { ...(build(detail) as object), fresh: true } });
    } catch {
      /* transient fetch failure — drop silently, user can reopen the message */
    }
  }

  const run = (fn: () => void) => () => {
    fn();
    onClose();
  };

  const items: Item[] = [
    {
      label: 'Reply',
      icon: <ReplyIcon className="size-4" />,
      onClick: () => void compose(buildReply),
    },
    {
      label: 'Reply all',
      icon: <ReplyAllIcon className="size-4" />,
      onClick: () => void compose((d) => buildReplyAll(d, accounts)),
    },
    {
      label: 'Forward',
      icon: <ForwardIcon className="size-4" />,
      onClick: () => void compose(buildForward),
    },
    {
      label: message.seen ? 'Mark as unread' : 'Mark as read',
      // Icon depicts the resulting state (matches the row toggle + bulk bar):
      // open envelope = mark as read, closed envelope = mark as unread.
      icon: message.seen ? <MailIcon className="size-4" /> : <MailOpenIcon className="size-4" />,
      onClick: run(() => onToggleRead(message.id, !message.seen)),
      divider: true,
    },
    {
      label: 'Select',
      icon: <CheckIcon className="size-4" />,
      onClick: run(() => onSelect(message.id)),
    },
    {
      label: 'Archive',
      icon: <ArchiveIcon className="size-4" />,
      onClick: run(() => onArchive(message.id)),
    },
    {
      label: 'Delete',
      icon: <TrashIcon className="size-4" />,
      onClick: run(() => onDelete(message.id)),
      danger: true,
      divider: true,
    },
  ];

  return (
    <div
      className="fixed inset-0 z-50"
      onClick={onClose}
      onContextMenu={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <div
        ref={menuRef}
        role="menu"
        style={{ left: pos.left, top: pos.top, width: MENU_W }}
        className="fixed overflow-hidden rounded-xl border border-border bg-bg py-1 shadow-xl shadow-black/20"
        onClick={(e) => e.stopPropagation()}
      >
        {items.map((it) => (
          <div key={it.label}>
            {it.divider && <div className="my-1 border-t border-border/70" />}
            <button
              type="button"
              role="menuitem"
              onClick={it.onClick}
              className={`flex w-full items-center gap-3 px-4 py-2 text-left text-sm transition-colors active:bg-surface-2 hover:bg-surface-2 ${
                it.danger ? 'text-danger' : 'text-fg'
              }`}
            >
              <span className={it.danger ? 'text-danger' : 'text-faint'}>{it.icon}</span>
              {it.label}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

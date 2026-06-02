import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { MessageDto } from '@maily/shared';
import { avatarHue, initials, senderName, shortDate } from '../ui/format';
import { PaperclipIcon, StarIcon, TrashIcon } from '../ui/icons';

/** Left-swipe past this many px (on release) commits the delete. */
const SWIPE_COMMIT = 96;
const SWIPE_MAX = 120;

export function MessageRow({
  message,
  onDelete,
}: {
  message: MessageDto;
  onDelete?: (id: string) => void;
}) {
  const name = senderName(message.fromName, message.fromAddress);
  const hue = avatarHue(message.fromAddress ?? name);
  const hasAttachment = message.attachments.some((a) => !a.isInline);

  const [dx, setDx] = useState(0);
  const startX = useRef<number | null>(null);
  const swiping = useRef(false);

  function onTouchStart(e: React.TouchEvent) {
    if (!onDelete) return;
    startX.current = e.touches[0]!.clientX;
    swiping.current = false;
  }

  function onTouchMove(e: React.TouchEvent) {
    if (startX.current === null) return;
    const delta = e.touches[0]!.clientX - startX.current;
    // Only reveal on a left swipe; clamp the travel.
    if (delta < -6) swiping.current = true;
    setDx(delta < 0 ? Math.max(delta, -SWIPE_MAX) : 0);
  }

  function onTouchEnd() {
    if (dx <= -SWIPE_COMMIT && onDelete) onDelete(message.id);
    setDx(0);
    startX.current = null;
  }

  // Swallow the click that follows a swipe so we don't navigate into the message.
  function onClick(e: React.MouseEvent) {
    if (swiping.current) {
      e.preventDefault();
      swiping.current = false;
    }
  }

  return (
    <div className="relative overflow-hidden">
      {onDelete && (
        <div className="absolute inset-y-0 right-0 flex items-center gap-1.5 bg-danger px-5 text-white">
          <TrashIcon className="size-5" />
        </div>
      )}
      <Link
        to={`/m/${message.id}`}
        onClick={onClick}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        style={{
          transform: `translateX(${dx}px)`,
          transition: dx === 0 ? 'transform 0.2s' : 'none',
        }}
        className="flex items-start gap-3 border-b border-border/60 bg-bg px-4 py-3 transition-colors active:bg-surface-2"
      >
        <div
          className="mt-0.5 flex size-10 shrink-0 items-center justify-center rounded-full text-sm font-semibold text-white"
          style={{ backgroundColor: `hsl(${hue} 45% 42%)` }}
        >
          {initials(message.fromName, message.fromAddress)}
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            {!message.seen && <span className="size-2 shrink-0 rounded-full bg-unread" />}
            <span
              className={`truncate text-[15px] ${message.seen ? 'text-fg' : 'font-semibold text-fg'}`}
            >
              {name}
            </span>
            <span className="ml-auto shrink-0 text-xs text-faint">
              {shortDate(message.receivedAt ?? message.sentAt)}
            </span>
          </div>

          <div className="flex items-center gap-1.5">
            <span
              className={`truncate text-sm ${message.seen ? 'text-muted' : 'font-medium text-fg'}`}
            >
              {message.subject || '(no subject)'}
            </span>
            {message.flagged && <StarIcon className="size-3.5 shrink-0 text-accent" />}
            {hasAttachment && <PaperclipIcon className="size-3.5 shrink-0 text-faint" />}
          </div>

          {message.snippet && (
            <p className="mt-0.5 line-clamp-1 text-sm text-faint">{message.snippet}</p>
          )}
        </div>
      </Link>
    </div>
  );
}

import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { MessageDto } from '@maily/shared';
import { avatarHue, initials, senderName, shortDate } from '../ui/format';
import { MailIcon, MailOpenIcon, PaperclipIcon, StarIcon, TrashIcon } from '../ui/icons';

/** Swipe past this many px (on release) commits the action; travel is clamped. */
const SWIPE_COMMIT = 96;
const SWIPE_MAX = 120;

export function MessageRow({
  message,
  onDelete,
  onToggleRead,
}: {
  message: MessageDto;
  onDelete?: (id: string) => void;
  /** Toggle read/unread from the list (right-swipe). Receives the desired `seen`. */
  onToggleRead?: (id: string, seen: boolean) => void;
}) {
  const name = senderName(message.fromName, message.fromAddress);
  const hue = avatarHue(message.fromAddress ?? name);
  const hasAttachment = message.attachments.some((a) => !a.isInline);

  const [dx, setDx] = useState(0);
  const startX = useRef<number | null>(null);
  const swiping = useRef(false);

  function onTouchStart(e: React.TouchEvent) {
    if (!onDelete && !onToggleRead) return;
    startX.current = e.touches[0]!.clientX;
    swiping.current = false;
  }

  function onTouchMove(e: React.TouchEvent) {
    if (startX.current === null) return;
    let delta = e.touches[0]!.clientX - startX.current;
    // Left swipe reveals delete; right swipe reveals read-toggle. Suppress a
    // direction when its handler isn't wired so the row doesn't slide into a no-op.
    if (delta < 0 && !onDelete) delta = 0;
    if (delta > 0 && !onToggleRead) delta = 0;
    if (Math.abs(delta) > 6) swiping.current = true;
    setDx(Math.max(Math.min(delta, SWIPE_MAX), -SWIPE_MAX));
  }

  function onTouchEnd() {
    if (dx <= -SWIPE_COMMIT && onDelete) onDelete(message.id);
    else if (dx >= SWIPE_COMMIT && onToggleRead) onToggleRead(message.id, !message.seen);
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
      {onToggleRead && (
        <div className="absolute inset-y-0 left-0 flex items-center gap-1.5 bg-accent px-5 text-white">
          {message.seen ? <MailIcon className="size-5" /> : <MailOpenIcon className="size-5" />}
        </div>
      )}
      {onDelete && (
        <div className="absolute inset-y-0 right-0 flex items-center gap-1.5 bg-danger px-5 text-white">
          <TrashIcon className="size-5" />
        </div>
      )}
      <div
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        style={{
          transform: `translateX(${dx}px)`,
          transition: dx === 0 ? 'transform 0.2s' : 'none',
        }}
        className="flex items-stretch bg-bg"
      >
        <Link
          to={`/m/${message.id}`}
          onClick={onClick}
          className="flex min-w-0 flex-1 items-start gap-3 border-b border-border/60 px-4 py-3 transition-colors active:bg-surface-2"
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

        {onToggleRead && (
          <button
            type="button"
            onClick={() => onToggleRead(message.id, !message.seen)}
            className="flex shrink-0 items-center border-b border-border/60 px-4 text-faint transition-colors active:bg-surface-2"
            aria-label={message.seen ? 'Mark as unread' : 'Mark as read'}
          >
            {message.seen ? (
              <MailIcon className="size-5" />
            ) : (
              <MailOpenIcon className="size-5 text-accent" />
            )}
          </button>
        )}
      </div>
    </div>
  );
}

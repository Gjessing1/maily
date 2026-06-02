import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { MessageDto } from '@maily/shared';
import type { SwipeAction } from '../state/prefs';
import { avatarHue, initials, senderName, shortDate } from '../ui/format';
import { CheckIcon, MailIcon, MailOpenIcon, PaperclipIcon, StarIcon, TrashIcon } from '../ui/icons';

/** Swipe past this many px (on release) commits the action; travel is clamped. */
const SWIPE_COMMIT = 96;
const SWIPE_MAX = 120;
/** Press-and-hold this long (without moving) enters multi-select mode. */
const LONG_PRESS_MS = 450;

/** Background colour + icon shown behind the row while swiping in a given direction. */
function swipeReveal(action: SwipeAction, seen: boolean) {
  if (action === 'delete') return { bg: 'bg-danger', icon: <TrashIcon className="size-5" /> };
  if (action === 'read')
    return {
      bg: 'bg-accent',
      icon: seen ? <MailIcon className="size-5" /> : <MailOpenIcon className="size-5" />,
    };
  return null;
}

export function MessageRow({
  message,
  onDelete,
  onToggleRead,
  swipeRight = 'read',
  swipeLeft = 'delete',
  to,
  selected = false,
  selectionMode = false,
  checked = false,
  onEnterSelect,
  onToggleSelect,
}: {
  message: MessageDto;
  onDelete?: (id: string) => void;
  /** Toggle read/unread from the list. Receives the desired `seen`. */
  onToggleRead?: (id: string, seen: boolean) => void;
  /** Action committed on a right (left→right) swipe. */
  swipeRight?: SwipeAction;
  /** Action committed on a left (right→left) swipe. */
  swipeLeft?: SwipeAction;
  /** Link target; defaults to the full-screen reader. Split mode points at a query param. */
  to?: string;
  /** Highlight as the currently open message (split reading pane). */
  selected?: boolean;
  /** Whether the list is in multi-select mode (tap toggles instead of opening). */
  selectionMode?: boolean;
  /** Whether this row is currently selected (multi-select). */
  checked?: boolean;
  /** Long-press / right-click handler to enter multi-select mode. */
  onEnterSelect?: (id: string) => void;
  /** Toggle this row's selection (multi-select mode). */
  onToggleSelect?: (id: string) => void;
}) {
  const name = senderName(message.fromName, message.fromAddress);
  const hue = avatarHue(message.fromAddress ?? name);
  const hasAttachment = message.attachments.some((a) => !a.isInline);

  // Resolve each configured direction down to "is it actually firable here".
  // A 'read'/'delete' action only counts when its handler is wired. Swipe is
  // suppressed entirely in selection mode (taps toggle selection instead).
  const canFire = (action: SwipeAction) =>
    (action === 'read' && !!onToggleRead) || (action === 'delete' && !!onDelete);
  const rightLive = !selectionMode && canFire(swipeRight);
  const leftLive = !selectionMode && canFire(swipeLeft);

  const [dx, setDx] = useState(0);
  const startX = useRef<number | null>(null);
  const swiping = useRef(false);
  const longPress = useRef<ReturnType<typeof setTimeout> | null>(null);

  function fire(action: SwipeAction) {
    if (action === 'read') onToggleRead?.(message.id, !message.seen);
    else if (action === 'delete') onDelete?.(message.id);
  }

  function cancelLongPress() {
    if (longPress.current) {
      clearTimeout(longPress.current);
      longPress.current = null;
    }
  }

  function onTouchStart(e: React.TouchEvent) {
    startX.current = e.touches[0]!.clientX;
    swiping.current = false;
    // Arm long-press only outside selection mode; movement/lift cancels it.
    if (onEnterSelect && !selectionMode) {
      cancelLongPress();
      longPress.current = setTimeout(() => {
        longPress.current = null;
        swiping.current = true; // suppress the trailing click/navigation
        onEnterSelect(message.id);
      }, LONG_PRESS_MS);
    }
  }

  function onTouchMove(e: React.TouchEvent) {
    if (startX.current === null) return;
    let delta = e.touches[0]!.clientX - startX.current;
    // Suppress a direction whose action is disabled/unwired so the row doesn't
    // slide into a no-op. Right swipe → swipeRight; left swipe → swipeLeft.
    if (delta > 0 && !rightLive) delta = 0;
    if (delta < 0 && !leftLive) delta = 0;
    if (Math.abs(delta) > 6) {
      swiping.current = true;
      cancelLongPress(); // a drag is a swipe, not a hold
    }
    setDx(Math.max(Math.min(delta, SWIPE_MAX), -SWIPE_MAX));
  }

  function onTouchEnd() {
    cancelLongPress();
    if (dx >= SWIPE_COMMIT && rightLive) fire(swipeRight);
    else if (dx <= -SWIPE_COMMIT && leftLive) fire(swipeLeft);
    setDx(0);
    startX.current = null;
  }

  // Tap behaviour: swallow the click that trails a swipe or the long-press that
  // just entered selection mode (else it would immediately toggle the row back
  // off); otherwise, in selection mode a tap toggles this row (no navigation).
  function onClick(e: React.MouseEvent) {
    if (swiping.current) {
      e.preventDefault();
      swiping.current = false;
      return;
    }
    if (selectionMode) {
      e.preventDefault();
      onToggleSelect?.(message.id);
    }
  }

  // Desktop: right-click enters selection mode.
  function onContextMenu(e: React.MouseEvent) {
    if (onEnterSelect && !selectionMode) {
      e.preventDefault();
      onEnterSelect(message.id);
    }
  }

  // Right swipe reveals from the left edge; left swipe reveals from the right edge.
  const rightReveal = rightLive ? swipeReveal(swipeRight, message.seen) : null;
  const leftReveal = leftLive ? swipeReveal(swipeLeft, message.seen) : null;

  return (
    <div className="relative overflow-hidden">
      {rightReveal && (
        <div
          className={`absolute inset-y-0 left-0 flex items-center gap-1.5 px-5 text-white ${rightReveal.bg}`}
        >
          {rightReveal.icon}
        </div>
      )}
      {leftReveal && (
        <div
          className={`absolute inset-y-0 right-0 flex items-center gap-1.5 px-5 text-white ${leftReveal.bg}`}
        >
          {leftReveal.icon}
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
          to={to ?? `/m/${message.id}`}
          onClick={onClick}
          onContextMenu={onContextMenu}
          className={`flex min-w-0 flex-1 items-start gap-3 border-b border-border/60 px-4 py-3 transition-colors active:bg-surface-2 ${
            checked ? 'bg-accent-soft' : selected ? 'bg-surface-2' : ''
          }`}
        >
          {selectionMode ? (
            <div
              className={`mt-0.5 flex size-10 shrink-0 items-center justify-center rounded-full border-2 transition-colors ${
                checked ? 'border-accent bg-accent text-white' : 'border-border text-transparent'
              }`}
            >
              <CheckIcon className="size-5" />
            </div>
          ) : (
            <div
              className="mt-0.5 flex size-10 shrink-0 items-center justify-center rounded-full text-sm font-semibold text-white"
              style={{ backgroundColor: `hsl(${hue} 45% 42%)` }}
            >
              {initials(message.fromName, message.fromAddress)}
            </div>
          )}

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

        {onToggleRead && !selectionMode && (
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

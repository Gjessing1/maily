import { Link } from 'react-router-dom';
import type { MessageDto } from '@maily/shared';
import { avatarHue, initials, senderName, shortDate } from '../ui/format';
import { PaperclipIcon, StarIcon } from '../ui/icons';

export function MessageRow({ message }: { message: MessageDto }) {
  const name = senderName(message.fromName, message.fromAddress);
  const hue = avatarHue(message.fromAddress ?? name);
  const hasAttachment = message.attachments.some((a) => !a.isInline);

  return (
    <Link
      to={`/m/${message.id}`}
      className="flex items-start gap-3 border-b border-border/60 px-4 py-3 transition active:bg-surface-2"
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
  );
}

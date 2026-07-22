/**
 * Shared message-header pieces used by both readers: the single-message view
 * (`Reader`) and each card of the stacked conversation view (`ConversationThread`).
 * Keeping them here means a threaded message exposes exactly the same From/To/Cc
 * disclosure and tappable sender avatar as a standalone one.
 */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { EmailAddress, MessageDetailDto } from '@maily/shared';
import { api } from '../api/client';
import { ContactEditor } from './ContactEditor';
import { avatarHue, fullDate, initials } from '../ui/format';

/** `Name <addr>` when we have a display name, else the bare address. */
export const fmtAddr = (a: EmailAddress): string =>
  a.name?.trim() ? `${a.name.trim()} <${a.address}>` : a.address;

export const joinAddrs = (list: EmailAddress[]): string => list.map(fmtAddr).join(', ');

/** One label/value row in the expanded message-header block. */
function HeaderField({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2">
      <dt className="w-12 shrink-0 text-faint">{label}</dt>
      <dd className="min-w-0 flex-1 break-words text-fg">{value}</dd>
    </div>
  );
}

/** The From/To/Cc/Date/Subject block revealed by the header disclosure. */
export function MessageHeaderDetails({ detail }: { detail: MessageDetailDto }) {
  return (
    <dl className="space-y-1.5 rounded-lg bg-surface px-3 py-2.5 text-xs">
      <HeaderField
        label="From"
        value={fmtAddr({ name: detail.fromName, address: detail.fromAddress ?? '' })}
      />
      {detail.to.length > 0 && <HeaderField label="To" value={joinAddrs(detail.to)} />}
      {detail.cc.length > 0 && <HeaderField label="Cc" value={joinAddrs(detail.cc)} />}
      <HeaderField label="Date" value={fullDate(detail.sentAt ?? detail.receivedAt)} />
      {detail.subject && <HeaderField label="Subject" value={detail.subject} />}
    </dl>
  );
}

/**
 * Sender avatar as a tap target (Gmail-style): opens the sender's existing contact
 * card if the book has one, else quick-creates a contact seeded with their name +
 * address. Self-contained — it renders its own editor sheet.
 */
export function SenderAvatar({
  name,
  address,
  seed,
  className,
}: {
  name: string | null;
  address: string | null;
  /** Fallback hue seed when the message has no From address (e.g. drafts). */
  seed: string;
  className: string;
}) {
  const navigate = useNavigate();
  const [addSender, setAddSender] = useState<{ name: string | null; email: string } | null>(null);

  async function openSender(e: React.MouseEvent) {
    // Cards live inside a collapse/expand toggle — don't fold the message shut.
    e.stopPropagation();
    if (!address) return;
    try {
      const cards = await api.contactCards();
      const existing = cards.find((c) =>
        c.emails.some((em) => em.toLowerCase() === address.toLowerCase()),
      );
      if (existing) {
        navigate(`/contacts/${encodeURIComponent(existing.uid)}`);
        return;
      }
    } catch {
      // Couldn't load the book — fall through to the create form.
    }
    setAddSender({ name, email: address });
  }

  return (
    <>
      <button
        onClick={openSender}
        className={`flex shrink-0 items-center justify-center rounded-full font-semibold text-white transition active:scale-95 ${className}`}
        style={{ backgroundColor: `hsl(${avatarHue(address ?? seed)} 45% 42%)` }}
        aria-label="View or add sender as contact"
      >
        {initials(name, address)}
      </button>

      {addSender && (
        <ContactEditor
          card={null}
          initialEmail={addSender.email}
          initialName={addSender.name ?? undefined}
          onClose={() => setAddSender(null)}
          onSaved={(uid) => {
            setAddSender(null);
            if (uid) navigate(`/contacts/${encodeURIComponent(uid)}`);
          }}
        />
      )}
    </>
  );
}

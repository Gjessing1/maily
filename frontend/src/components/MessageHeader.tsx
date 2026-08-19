/**
 * Shared message-header pieces used by both readers: the single-message view
 * (`Reader`) and each card of the stacked conversation view (`ConversationThread`).
 * Keeping them here means a threaded message exposes exactly the same From/To/Cc
 * disclosure and tappable sender avatar as a standalone one.
 */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { EmailAddress, MessageDetailDto } from '@maily/shared';
import { invalidateContactLookup, lookupContact, useContactLookup } from '../state/contactLookup';
import { setPref, usePrefs } from '../state/prefs';
import { ContactEditor } from './ContactEditor';
import { avatarHue, fullDate, initials } from '../ui/format';
import { isPromptableSender } from '../ui/senderPrompt';
import { CloseIcon } from '../ui/icons';

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
      const [existing] = await lookupContact(address);
      if (existing) {
        navigate(`/contacts/${encodeURIComponent(existing.uid)}`);
        return;
      }
    } catch {
      // Couldn't reach the book — fall through to the create form.
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
            invalidateContactLookup();
            if (uid) navigate(`/contacts/${encodeURIComponent(uid)}`);
          }}
        />
      )}
    </>
  );
}

/**
 * One-click "file this sender" (ROADMAP §A2), shown inline under the header when the
 * sender has no card. Deliberately *not* a suggestion queue: it appears on the message
 * the user already opened, adds the contact in one tap, and a dismissal is remembered
 * for that address forever — so an unknown sender is an offer, never an item of work.
 *
 * Silent unless it is certain there is something to offer: no prompt while the lookup
 * is unanswered (offline included), none for machine addresses, none once dismissed.
 */
export function AddSenderPrompt({
  name,
  address,
}: {
  name: string | null;
  address: string | null;
}) {
  const navigate = useNavigate();
  const dismissed = usePrefs().dismissedContactPrompts;
  const [editing, setEditing] = useState(false);
  const promptable = isPromptableSender(address);
  // Ask only for an address worth offering — a machine sender never reaches the server.
  const cards = useContactLookup(promptable ? address : null);

  const key = address?.trim().toLowerCase() ?? '';
  if (!promptable || !cards || cards.length > 0 || dismissed.includes(key)) return null;

  return (
    <div className="mt-3 flex items-center gap-3 rounded-lg bg-surface px-3 py-2 text-xs">
      <span className="min-w-0 flex-1 truncate text-muted">Not in your contacts</span>
      <button
        onClick={() => setEditing(true)}
        className="shrink-0 font-medium text-accent active:opacity-70"
      >
        Add contact
      </button>
      <button
        onClick={() => setPref('dismissedContactPrompts', [...dismissed, key])}
        className="-mr-1 shrink-0 rounded-full p-1 text-faint active:bg-surface-2"
        aria-label="Don’t ask about this sender again"
        title="Don’t ask about this sender again"
      >
        <CloseIcon className="size-3.5" />
      </button>

      {editing && (
        <ContactEditor
          card={null}
          initialEmail={address ?? ''}
          initialName={name ?? undefined}
          onClose={() => setEditing(false)}
          onSaved={(uid) => {
            setEditing(false);
            // The prompt's own answer is memoised — drop it so the card it just created
            // is what the next render sees.
            invalidateContactLookup();
            if (uid) navigate(`/contacts/${encodeURIComponent(uid)}`);
          }}
        />
      )}
    </div>
  );
}

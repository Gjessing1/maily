/**
 * Contact detail page (contacts Phase 2). A read view of one CardDAV card — photo,
 * name, company/role, and every rich field with the addresses/links made actionable
 * (tap an email to compose, a phone to dial, a website to open). Edit/delete reuse the
 * shared ContactEditor, which writes back to Radicale.
 */
import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type {
  ContactCardDto,
  ContactDuplicateGroupDto,
  ContactEmailIntelligenceDto,
} from '@maily/shared';
import { api } from '../api/client';
import { invalidateContactLookup } from '../state/contactLookup';
import { setPref, usePrefs } from '../state/prefs';
import { avatarHue, fullDate, initials } from '../ui/format';
import { ContactEditor } from '../components/ContactEditor';
import { MergeContactsDialog } from '../components/MergeContactsDialog';
import { AttachmentChip } from '../components/AttachmentChip';
import { Spinner } from '../ui/Spinner';
import {
  BackIcon,
  CheckIcon,
  CopyIcon,
  LinkIcon,
  MailIcon,
  PaperclipIcon,
  PencilIcon,
  SearchIcon,
  SendIcon,
  StarIcon,
} from '../ui/icons';

/** Width cap for the detail column — see the same constant in `Contacts` (ROADMAP §A1). */
const column = 'mx-auto w-full max-w-2xl';

/** A line of the address, skipping empty components. */
function addressLines(a: ContactCardDto['addresses'][number]): string[] {
  return [a.street, [a.postalCode, a.locality].filter(Boolean).join(' '), a.region, a.country]
    .map((l) => l.trim())
    .filter(Boolean);
}

export function ContactDetail() {
  const { uid = '' } = useParams();
  const navigate = useNavigate();
  const [card, setCard] = useState<ContactCardDto | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [intelligence, setIntelligence] = useState<ContactEmailIntelligenceDto | null | undefined>(
    undefined,
  );

  // Starring is a maily-local view choice (a prefs list of UIDs), not a vCard edit —
  // it never writes back to Radicale. See `favoriteContacts` in state/prefs.
  const favorites = usePrefs().favoriteContacts;
  const favorite = favorites.includes(uid);
  const toggleFavorite = () =>
    setPref(
      'favoriteContacts',
      favorite ? favorites.filter((f) => f !== uid) : [...favorites, uid],
    );

  // The duplicate cluster this card belongs to, if any (§A2). A flag, not a wizard:
  // it names the other cards and offers a merge, and does nothing at all otherwise.
  const [duplicate, setDuplicate] = useState<ContactDuplicateGroupDto | null>(null);
  const [merging, setMerging] = useState(false);

  const load = useCallback(() => {
    setError(null);
    setIntelligence(undefined);
    api
      .contactCard(uid)
      .then(setCard)
      .catch((e) => {
        setCard(null);
        setError((e as Error).message);
      });
    api
      .contactDuplicates()
      .then((groups) =>
        setDuplicate(groups.find((g) => g.cards.some((c) => c.uid === uid)) ?? null),
      )
      .catch(() => setDuplicate(null)); // advisory — a failed check just shows no flag
    api
      .contactEmailIntelligence(uid)
      .then(setIntelligence)
      // Mail activity is a derived convenience; a failure must not hide the contact.
      .catch(() => setIntelligence(null));
  }, [uid]);

  useEffect(load, [load]);

  const compose = (email: string) => navigate('/compose', { state: { fresh: true, to: [email] } });

  return (
    <div className="flex h-full flex-col">
      <header className="safe-top sticky top-0 z-10 border-b border-border bg-bg/85 px-2 py-2 backdrop-blur">
        <div className={`${column} flex items-center gap-1`}>
          <button
            onClick={() => navigate(-1)}
            className="rounded-full p-2 active:bg-surface-2"
            aria-label="Back"
          >
            <BackIcon />
          </button>
          <h1 className="flex-1 truncate px-2 text-lg font-semibold">Contact</h1>
          {card && (
            <>
              <button
                onClick={toggleFavorite}
                aria-pressed={favorite}
                className="rounded-full p-2 active:bg-surface-2"
                aria-label={favorite ? 'Remove from favourites' : 'Add to favourites'}
              >
                <StarIcon className={favorite ? 'fill-accent text-accent' : 'text-fg'} />
              </button>
              <button
                onClick={() => setEditing(true)}
                className="rounded-full p-2 text-accent active:bg-surface-2"
                aria-label="Edit contact"
              >
                <PencilIcon />
              </button>
            </>
          )}
        </div>
      </header>

      <main className={`flex-1 overflow-y-auto no-scrollbar ${column}`}>
        {card === undefined ? (
          <div className="flex justify-center py-16">
            <Spinner />
          </div>
        ) : card === null ? (
          <p className="px-4 py-6 text-center text-sm text-danger">
            {error ? `Couldn’t load contact: ${error}` : 'Contact not found.'}
          </p>
        ) : (
          <>
            <section className="flex flex-col items-center gap-3 px-4 py-6 text-center">
              {card.photo ? (
                <img src={card.photo} alt="" className="size-24 rounded-full object-cover" />
              ) : (
                <span
                  className="flex size-24 items-center justify-center rounded-full text-2xl font-semibold text-white"
                  style={{
                    backgroundColor: `hsl(${avatarHue(card.emails[0] ?? card.name ?? '')} 45% 42%)`,
                  }}
                >
                  {initials(card.name, card.emails[0] ?? null)}
                </span>
              )}
              <div>
                <h2 className="text-xl font-semibold text-fg">
                  {card.name || card.emails[0] || '(no name)'}
                </h2>
                {card.nickname && <p className="text-sm text-faint">“{card.nickname}”</p>}
                {(card.title || card.org) && (
                  <p className="mt-0.5 text-sm text-muted">
                    {[card.title, card.org].filter(Boolean).join(' · ')}
                  </p>
                )}
              </div>
            </section>

            {duplicate && (
              <div className="mx-4 mb-2 flex items-center gap-3 rounded-lg bg-surface px-3 py-2 text-xs">
                <span className="min-w-0 flex-1 text-muted">
                  Also filed as{' '}
                  {duplicate.cards
                    .filter((c) => c.uid !== uid)
                    .map(
                      (c) =>
                        `${c.name || c.emails[0] || 'a card'} in ${c.addressbookName ?? 'another book'}`,
                    )
                    .join(', ')}
                  .
                </span>
                <button
                  onClick={() => setMerging(true)}
                  className="shrink-0 font-medium text-accent active:opacity-70"
                >
                  Merge…
                </button>
              </div>
            )}

            <div className="px-2 pb-10">
              {card.emails.map((e) => (
                <ActionRow
                  key={`e-${e}`}
                  label="email"
                  value={e}
                  onClick={() => compose(e)}
                  trailing={<CopyButton value={e} label="email address" />}
                >
                  <MailIcon className="size-5 text-faint" />
                </ActionRow>
              ))}

              {card.phones.map((p, i) => (
                <ActionRow
                  key={`p-${i}`}
                  label={p.type ?? 'phone'}
                  value={p.value}
                  href={`tel:${p.value.replace(/\s+/g, '')}`}
                >
                  <PhoneGlyph />
                </ActionRow>
              ))}

              {card.urls.map((u, i) => (
                <ActionRow
                  key={`u-${i}`}
                  label={u.type ?? 'website'}
                  value={u.value}
                  href={/^https?:\/\//i.test(u.value) ? u.value : `https://${u.value}`}
                  external
                >
                  <LinkIcon className="size-5 text-faint" />
                </ActionRow>
              ))}

              {card.addresses.map((a, i) => {
                const lines = addressLines(a);
                const q = encodeURIComponent(lines.join(', '));
                return (
                  <ActionRow
                    key={`a-${i}`}
                    label={a.type ?? 'address'}
                    value={lines.join('\n')}
                    href={`https://maps.google.com/?q=${q}`}
                    external
                    multiline
                  >
                    <PinGlyph />
                  </ActionRow>
                );
              })}

              {card.birthday && (
                <InfoRow label="birthday" value={formatBirthday(card.birthday)}>
                  <CakeGlyph />
                </InfoRow>
              )}

              {card.note && (
                <InfoRow label="notes" value={card.note} multiline>
                  <NoteGlyph />
                </InfoRow>
              )}

              {card.categories.length > 0 && (
                <div className="flex flex-wrap gap-1.5 px-2 pt-3">
                  {card.categories.map((c) => (
                    <span
                      key={c}
                      className="rounded-full bg-surface-2 px-2.5 py-1 text-xs text-faint"
                    >
                      {c}
                    </span>
                  ))}
                </div>
              )}

              <EmailIntelligence
                value={intelligence}
                emails={card.emails}
                onCompose={() => card.emails[0] && compose(card.emails[0])}
                onOpenAll={() => {
                  const query = `contact:${card.emails.join(',')}`;
                  navigate(`/search?q=${encodeURIComponent(query)}`);
                }}
                onOpenMessage={(messageId) => navigate(`/m/${messageId}`)}
              />
            </div>
          </>
        )}
      </main>

      {merging && duplicate && (
        <MergeContactsDialog
          group={duplicate}
          onClose={() => setMerging(false)}
          onMerged={(survivor) => {
            setMerging(false);
            // The card we were viewing may be one of the deleted ones — land on the survivor.
            if (survivor !== uid)
              navigate(`/contacts/${encodeURIComponent(survivor)}`, { replace: true });
            else load();
          }}
        />
      )}

      {editing && card && (
        <ContactEditor
          card={card}
          onClose={() => setEditing(false)}
          onSaved={(savedUid) => {
            setEditing(false);
            invalidateContactLookup();
            if (savedUid === null) {
              // Deleted — drop the star too, or the UID lingers in prefs forever.
              if (favorite)
                setPref(
                  'favoriteContacts',
                  favorites.filter((f) => f !== uid),
                );
              navigate('/contacts', { replace: true });
            } else load();
          }}
        />
      )}
    </div>
  );
}

/** Passive mail-derived activity. It never writes anything back to the contact. */
function EmailIntelligence({
  value,
  emails,
  onCompose,
  onOpenAll,
  onOpenMessage,
}: {
  value: ContactEmailIntelligenceDto | null | undefined;
  emails: string[];
  onCompose: () => void;
  onOpenAll: () => void;
  onOpenMessage: (messageId: string) => void;
}) {
  if (emails.length === 0) return null;

  return (
    <section className="mt-6 border-t border-border px-2 pt-5" aria-labelledby="email-activity">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 id="email-activity" className="font-semibold text-fg">
            Email activity
          </h3>
          <p className="text-xs text-faint">Derived from your local mail history</p>
        </div>
        <div className="flex gap-1">
          <button
            type="button"
            onClick={onCompose}
            className="rounded-full p-2 text-accent active:bg-surface-2"
            aria-label="Compose email to contact"
          >
            <SendIcon className="size-5" />
          </button>
          <button
            type="button"
            onClick={onOpenAll}
            className="rounded-full p-2 text-accent active:bg-surface-2"
            aria-label="Open all conversations with contact"
          >
            <SearchIcon className="size-5" />
          </button>
        </div>
      </div>

      {value === undefined ? (
        <div className="flex justify-center py-8">
          <Spinner className="size-5" />
        </div>
      ) : value === null ? (
        <p className="py-5 text-sm text-faint">Email activity couldn’t be loaded.</p>
      ) : value.messageCount === 0 ? (
        <p className="py-5 text-sm text-faint">No shared mail in the local cache yet.</p>
      ) : (
        <>
          <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3">
            <ActivityStat label="Messages" value={String(value.messageCount)} />
            <ActivityStat label="Conversations" value={String(value.conversationCount)} />
            <ActivityStat label="First contact" value={activityDate(value.firstCommunicationAt)} />
            <ActivityStat label="Last received" value={activityDate(value.lastReceivedAt)} />
            <ActivityStat label="Last sent" value={activityDate(value.lastSentAt)} />
          </div>

          {value.recentAttachments.length > 0 && (
            <div className="mt-6">
              <h4 className="mb-2 flex items-center gap-2 text-sm font-medium text-muted">
                <PaperclipIcon className="size-4" /> Recent attachments
              </h4>
              <div className="flex flex-wrap gap-2">
                {value.recentAttachments.map((item) => (
                  <div key={`${item.messageId}:${item.attachment.id}`} className="max-w-full">
                    <AttachmentChip messageId={item.messageId} attachment={item.attachment} />
                    <button
                      type="button"
                      onClick={() => onOpenMessage(item.messageId)}
                      className="mt-1 block max-w-52 truncate px-1 text-left text-[11px] text-faint active:text-accent"
                    >
                      {item.subject || '(no subject)'} · {activityDate(item.occurredAt)}
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {value.timeline.length > 0 && (
            <div className="mt-6">
              <h4 className="mb-2 text-sm font-medium text-muted">Communication timeline</h4>
              <ol className="border-l border-border pl-3">
                {value.timeline.map((item) => (
                  <li key={item.messageId} className="relative pb-1">
                    <span className="absolute -left-[17px] top-4 size-2 rounded-full bg-accent" />
                    <button
                      type="button"
                      onClick={() => onOpenMessage(item.messageId)}
                      className="flex w-full items-start gap-2 rounded-lg px-2 py-2 text-left active:bg-surface-2"
                    >
                      <DirectionGlyph direction={item.direction} />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-baseline justify-between gap-2">
                          <span className="truncate text-sm font-medium text-fg">
                            {item.subject || '(no subject)'}
                          </span>
                          <span className="shrink-0 text-[11px] text-faint">
                            {activityDate(item.occurredAt)}
                          </span>
                        </span>
                        {item.snippet && (
                          <span className="mt-0.5 block truncate text-xs text-faint">
                            {item.snippet}
                          </span>
                        )}
                        <span className="mt-0.5 block text-[11px] capitalize text-muted">
                          {item.direction}
                          {item.attachmentCount > 0
                            ? ` · ${item.attachmentCount} attachment${item.attachmentCount === 1 ? '' : 's'}`
                            : ''}
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ol>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function ActivityStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-surface px-3 py-2.5">
      <span className="block text-xs text-faint">{label}</span>
      <span className="mt-0.5 block truncate text-sm font-medium text-fg" title={value}>
        {value}
      </span>
    </div>
  );
}

function activityDate(iso: string | null): string {
  return iso ? fullDate(iso) : '—';
}

function DirectionGlyph({ direction }: { direction: 'received' | 'sent' }) {
  const outgoing = direction === 'sent';
  return (
    <span
      className={`mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full ${outgoing ? 'bg-accent-soft text-accent' : 'bg-surface-2 text-muted'}`}
      aria-hidden="true"
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="size-4">
        <path d={outgoing ? 'M5 19 19 5M9 5h10v10' : 'M19 5 5 19M15 19H5V9'} />
      </svg>
    </span>
  );
}

/** A tappable row (compose / dial / open) with an icon, label, and value. */
function ActionRow({
  label,
  value,
  href,
  onClick,
  external,
  multiline,
  trailing,
  children,
}: {
  label: string;
  value: string;
  href?: string;
  onClick?: () => void;
  external?: boolean;
  multiline?: boolean;
  /** Optional secondary action (e.g. copy) rendered beside the row, not nested in it. */
  trailing?: React.ReactNode;
  children: React.ReactNode;
}) {
  const inner = (
    <>
      <span className="flex size-9 shrink-0 items-center justify-center">{children}</span>
      <span className="min-w-0 flex-1">
        <span className="block text-xs capitalize text-faint">{label}</span>
        <span
          className={`block text-[15px] text-accent ${multiline ? 'whitespace-pre-line' : 'truncate'}`}
        >
          {value}
        </span>
      </span>
    </>
  );
  // The main row fills the width; a trailing action (copy) sits beside it as a
  // sibling so its tap never triggers the row's compose/dial/open.
  const cls =
    'flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-2.5 text-left active:bg-surface-2';
  const main = href ? (
    <a href={href} {...(external ? { target: '_blank', rel: 'noreferrer' } : {})} className={cls}>
      {inner}
    </a>
  ) : (
    <button onClick={onClick} className={cls}>
      {inner}
    </button>
  );
  if (!trailing) return main;
  return (
    <div className="flex items-center">
      {main}
      {trailing}
    </div>
  );
}

/** Copy `value` to the clipboard, flashing a check for confirmation. */
function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard?.writeText(value).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
      className="flex size-9 shrink-0 items-center justify-center rounded-full text-faint active:bg-surface-2"
      aria-label={copied ? 'Copied' : `Copy ${label}`}
    >
      {copied ? <CheckIcon className="size-5 text-accent" /> : <CopyIcon className="size-5" />}
    </button>
  );
}

/** A non-actionable info row (birthday, notes). */
function InfoRow({
  label,
  value,
  multiline,
  children,
}: {
  label: string;
  value: string;
  multiline?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-2 px-2 py-2.5">
      <span className="flex size-9 shrink-0 items-center justify-center">{children}</span>
      <span className="min-w-0 flex-1">
        <span className="block text-xs capitalize text-faint">{label}</span>
        <span className={`block text-[15px] text-fg ${multiline ? 'whitespace-pre-line' : ''}`}>
          {value}
        </span>
      </span>
    </div>
  );
}

/** Format a vCard birthday (ISO date) into a friendly string; pass through otherwise. */
function formatBirthday(bday: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(bday);
  if (!m) return bday;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
}

// Inline glyphs for fields without a shared icon (kept local to avoid bloating icons.tsx).
const glyph = 'size-5 text-faint';
const PhoneGlyph = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={glyph}>
    <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z" />
  </svg>
);
const PinGlyph = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={glyph}>
    <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" />
    <circle cx="12" cy="10" r="3" />
  </svg>
);
const CakeGlyph = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={glyph}>
    <path d="M20 21v-8a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8" />
    <path d="M4 16s.5-1 2-1 2.5 2 4 2 2.5-2 4-2 2.5 2 4 2 2-1 2-1" />
    <path d="M2 21h20M7 8v3M12 8v3M17 8v3M7 4h.01M12 3h.01M17 4h.01" />
  </svg>
);
const NoteGlyph = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={glyph}>
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <path d="M14 2v6h6M8 13h8M8 17h8M8 9h2" />
  </svg>
);

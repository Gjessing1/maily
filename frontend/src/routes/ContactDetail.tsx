/**
 * Contact detail page (contacts Phase 2). A read view of one CardDAV card — photo,
 * name, company/role, and every rich field with the addresses/links made actionable
 * (tap an email to compose, a phone to dial, a website to open). Edit/delete reuse the
 * shared ContactEditor, which writes back to Radicale.
 */
import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { ContactCardDto } from '@maily/shared';
import { api } from '../api/client';
import { avatarHue, initials } from '../ui/format';
import { ContactEditor } from '../components/ContactEditor';
import { Spinner } from '../ui/Spinner';
import { BackIcon, CheckIcon, CopyIcon, LinkIcon, MailIcon, PencilIcon } from '../ui/icons';

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

  const load = useCallback(() => {
    api
      .contactCard(uid)
      .then(setCard)
      .catch((e) => {
        setCard(null);
        setError((e as Error).message);
      });
  }, [uid]);

  useEffect(load, [load]);

  const compose = (email: string) => navigate('/compose', { state: { fresh: true, to: [email] } });

  return (
    <div className="flex h-full flex-col">
      <header className="safe-top sticky top-0 z-10 flex items-center gap-1 border-b border-border bg-bg/85 px-2 py-2 backdrop-blur">
        <button
          onClick={() => navigate(-1)}
          className="rounded-full p-2 active:bg-surface-2"
          aria-label="Back"
        >
          <BackIcon />
        </button>
        <h1 className="flex-1 truncate px-2 text-lg font-semibold">Contact</h1>
        {card && (
          <button
            onClick={() => setEditing(true)}
            className="rounded-full p-2 text-accent active:bg-surface-2"
            aria-label="Edit contact"
          >
            <PencilIcon />
          </button>
        )}
      </header>

      <main className="flex-1 overflow-y-auto no-scrollbar">
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
            </div>
          </>
        )}
      </main>

      {editing && card && (
        <ContactEditor
          card={card}
          onClose={() => setEditing(false)}
          onSaved={(savedUid) => {
            setEditing(false);
            if (savedUid === null) navigate('/contacts', { replace: true });
            else load();
          }}
        />
      )}
    </div>
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

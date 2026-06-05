/**
 * Create/edit form for a single CardDAV card (contacts Phase 2). Covers the rich
 * fields maily models — name, nickname, company/title, multiple emails/phones/
 * websites, postal addresses, birthday, notes, categories. Writes go through the
 * backend, which PUTs the vCard (preserving unmodelled properties like PHOTO) and
 * re-syncs the cache, so Radicale stays the source of truth.
 */
import { useState } from 'react';
import type {
  ContactAddressDto,
  ContactCardDto,
  ContactCardInput,
  TypedValueDto,
} from '@maily/shared';
import { api } from '../api/client';
import { ConfirmDialog } from './ConfirmDialog';
import { CloseIcon, PlusIcon, TrashIcon } from '../ui/icons';

/** Suggested labels for typed values; the user can still type a custom one. */
const PHONE_LABELS = ['Mobile', 'Home', 'Work', 'Other'];
const URL_LABELS = ['Home', 'Work', 'Other'];
const ADDR_LABELS = ['Home', 'Work', 'Other'];

interface Props {
  /** Existing card to edit, or null to create a new one. */
  card: ContactCardDto | null;
  /** Target address book for a new card (ignored when editing). */
  addressbook?: string | null;
  onClose: () => void;
  /** Called after a successful save or delete (the list/detail should refresh). */
  onSaved: (uid: string | null) => void;
}

const emptyAddress = (): ContactAddressDto => ({
  type: 'Home',
  street: '',
  locality: '',
  region: '',
  postalCode: '',
  country: '',
});

export function ContactEditor({ card, addressbook, onClose, onSaved }: Props) {
  const editing = card !== null;
  const [name, setName] = useState(card?.name ?? '');
  const [nickname, setNickname] = useState(card?.nickname ?? '');
  const [org, setOrg] = useState(card?.org ?? '');
  const [title, setTitle] = useState(card?.title ?? '');
  const [emails, setEmails] = useState<string[]>(
    card && card.emails.length ? [...card.emails] : [''],
  );
  const [phones, setPhones] = useState<TypedValueDto[]>(card?.phones ?? []);
  const [urls, setUrls] = useState<TypedValueDto[]>(card?.urls ?? []);
  const [addresses, setAddresses] = useState<ContactAddressDto[]>(card?.addresses ?? []);
  const [birthday, setBirthday] = useState(card?.birthday ?? '');
  const [note, setNote] = useState(card?.note ?? '');
  const [categories, setCategories] = useState((card?.categories ?? []).join(', '));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // ── Email list (always at least one field) ──────────────────────────────────
  const setEmail = (i: number, v: string) =>
    setEmails((prev) => prev.map((e, idx) => (idx === i ? v : e)));
  const removeEmail = (i: number) =>
    setEmails((prev) => (prev.length > 1 ? prev.filter((_, idx) => idx !== i) : prev));

  async function save() {
    const cleanedEmails = emails.map((e) => e.trim()).filter(Boolean);
    if (cleanedEmails.length === 0) {
      setError('Add at least one email address.');
      return;
    }
    setBusy(true);
    setError(null);
    const input: ContactCardInput = {
      name: name.trim() || null,
      emails: cleanedEmails,
      nickname: nickname.trim() || null,
      org: org.trim() || null,
      title: title.trim() || null,
      phones: phones.filter((p) => p.value.trim()),
      urls: urls.filter((u) => u.value.trim()),
      addresses,
      birthday: birthday.trim() || null,
      note: note.trim() || null,
      categories: categories
        .split(',')
        .map((c) => c.trim())
        .filter(Boolean),
    };
    try {
      if (card) {
        await api.updateContactCard(card.uid, input);
        onSaved(card.uid);
      } else {
        const created = await api.createContactCard({ ...input, addressbook });
        onSaved(created.uid);
      }
    } catch (e) {
      setError((e as Error).message || 'Save failed.');
      setBusy(false);
    }
  }

  async function remove() {
    if (!card) return;
    setBusy(true);
    setError(null);
    try {
      await api.deleteContactCard(card.uid);
      onSaved(null);
    } catch (e) {
      setError((e as Error).message || 'Delete failed.');
      setBusy(false);
      setConfirmDelete(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center sm:items-center"
      role="dialog"
      aria-modal="true"
    >
      <button
        type="button"
        aria-label="Cancel"
        onClick={onClose}
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
      />
      <div className="safe-bottom relative flex max-h-[92vh] w-full max-w-md flex-col rounded-t-2xl border border-border bg-bg shadow-xl sm:rounded-2xl">
        <h2 className="border-b border-border px-5 py-4 text-base font-semibold text-fg">
          {editing ? 'Edit contact' : 'New contact'}
        </h2>

        <div className="flex-1 overflow-y-auto px-5 py-4 no-scrollbar">
          <Field label="Name">
            <Text value={name} onChange={setName} placeholder="Full name" />
          </Field>
          <Field label="Nickname">
            <Text value={nickname} onChange={setNickname} placeholder="Nickname" />
          </Field>
          <div className="flex gap-2">
            <Field label="Company" className="flex-1">
              <Text value={org} onChange={setOrg} placeholder="Company" />
            </Field>
            <Field label="Job title" className="flex-1">
              <Text value={title} onChange={setTitle} placeholder="Role" />
            </Field>
          </div>

          <ListLabel>Email</ListLabel>
          <div className="flex flex-col gap-2">
            {emails.map((e, i) => (
              <Row key={i} onRemove={emails.length > 1 ? () => removeEmail(i) : undefined}>
                <input
                  value={e}
                  onChange={(ev) => setEmail(i, ev.target.value)}
                  placeholder="name@example.com"
                  type="email"
                  inputMode="email"
                  className={inputCls}
                />
              </Row>
            ))}
          </div>
          <AddButton label="Add email" onClick={() => setEmails((p) => [...p, ''])} />

          <ListLabel>Phone</ListLabel>
          <TypedList
            items={phones}
            onChange={setPhones}
            labels={PHONE_LABELS}
            placeholder="+47 123 45 678"
            inputMode="tel"
            addLabel="Add phone"
          />

          <ListLabel>Website</ListLabel>
          <TypedList
            items={urls}
            onChange={setUrls}
            labels={URL_LABELS}
            placeholder="https://example.com"
            inputMode="url"
            addLabel="Add website"
          />

          <ListLabel>Address</ListLabel>
          <div className="flex flex-col gap-3">
            {addresses.map((a, i) => (
              <AddressFields
                key={i}
                value={a}
                onChange={(next) =>
                  setAddresses((prev) => prev.map((x, idx) => (idx === i ? next : x)))
                }
                onRemove={() => setAddresses((prev) => prev.filter((_, idx) => idx !== i))}
                labels={ADDR_LABELS}
              />
            ))}
          </div>
          <AddButton
            label="Add address"
            onClick={() => setAddresses((p) => [...p, emptyAddress()])}
          />

          <div className="mt-4 flex gap-2">
            <Field label="Birthday" className="flex-1">
              <input
                value={birthday}
                onChange={(e) => setBirthday(e.target.value)}
                type="date"
                className={inputCls}
              />
            </Field>
            <Field label="Categories" className="flex-1">
              <Text value={categories} onChange={setCategories} placeholder="Family, VIP" />
            </Field>
          </div>

          <Field label="Notes">
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={3}
              placeholder="Notes"
              className={`${inputCls} resize-y`}
            />
          </Field>

          {error && <p className="mt-3 text-sm text-danger">{error}</p>}
        </div>

        <div className="flex items-center gap-2 border-t border-border px-5 py-3">
          {editing && (
            <button
              onClick={() => setConfirmDelete(true)}
              disabled={busy}
              className="rounded-full p-2 text-danger active:bg-surface-2 disabled:opacity-50"
              aria-label="Delete contact"
            >
              <TrashIcon className="size-5" />
            </button>
          )}
          <div className="ml-auto flex gap-2">
            <button
              onClick={onClose}
              disabled={busy}
              className="rounded-full px-4 py-2 text-sm text-fg active:bg-surface-2 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              onClick={save}
              disabled={busy}
              className="rounded-full bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            >
              {busy ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      </div>

      <ConfirmDialog
        open={confirmDelete}
        title="Delete contact?"
        message="This removes the card from your addressbook on the server."
        confirmLabel="Delete"
        danger
        onConfirm={remove}
        onCancel={() => setConfirmDelete(false)}
      />
    </div>
  );
}

const inputCls =
  'min-w-0 flex-1 w-full rounded-lg border border-border bg-surface px-3 py-2 text-[15px] text-fg outline-none focus:border-accent';

function Field({
  label,
  className = '',
  children,
}: {
  label: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <label className={`mt-4 block first:mt-0 ${className}`}>
      <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-faint">
        {label}
      </span>
      {children}
    </label>
  );
}

function ListLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="mb-1 mt-4 text-xs font-medium uppercase tracking-wide text-faint">{children}</p>
  );
}

function Text({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className={inputCls}
    />
  );
}

/** A list row with a trailing remove button (shown when `onRemove` is provided). */
function Row({ children, onRemove }: { children: React.ReactNode; onRemove?: () => void }) {
  return (
    <div className="flex items-center gap-2">
      {children}
      {onRemove && (
        <button
          onClick={onRemove}
          type="button"
          className="shrink-0 rounded-full p-2 text-faint active:bg-surface-2"
          aria-label="Remove"
        >
          <CloseIcon className="size-4" />
        </button>
      )}
    </div>
  );
}

function AddButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      type="button"
      className="mt-2 flex items-center gap-1.5 text-sm text-accent active:opacity-70"
    >
      <PlusIcon className="size-4" /> {label}
    </button>
  );
}

/** A small label <select> with the suggested labels (plus the current custom value). */
function LabelSelect({
  value,
  onChange,
  labels,
}: {
  value: string | null;
  onChange: (v: string) => void;
  labels: string[];
}) {
  const options = value && !labels.includes(value) ? [value, ...labels] : labels;
  return (
    <select
      value={value ?? labels[0]}
      onChange={(e) => onChange(e.target.value)}
      className="shrink-0 rounded-lg border border-border bg-surface px-2 py-2 text-sm text-faint outline-none focus:border-accent"
    >
      {options.map((l) => (
        <option key={l} value={l} className="bg-surface">
          {l}
        </option>
      ))}
    </select>
  );
}

/** An editable list of labelled values (phones, websites). */
function TypedList({
  items,
  onChange,
  labels,
  placeholder,
  inputMode,
  addLabel,
}: {
  items: TypedValueDto[];
  onChange: (next: TypedValueDto[]) => void;
  labels: string[];
  placeholder: string;
  inputMode: 'tel' | 'url';
  addLabel: string;
}) {
  const set = (i: number, patch: Partial<TypedValueDto>) =>
    onChange(items.map((it, idx) => (idx === i ? { ...it, ...patch } : it)));
  return (
    <>
      <div className="flex flex-col gap-2">
        {items.map((it, i) => (
          <Row key={i} onRemove={() => onChange(items.filter((_, idx) => idx !== i))}>
            <LabelSelect value={it.type} onChange={(type) => set(i, { type })} labels={labels} />
            <input
              value={it.value}
              onChange={(e) => set(i, { value: e.target.value })}
              placeholder={placeholder}
              inputMode={inputMode}
              className={inputCls}
            />
          </Row>
        ))}
      </div>
      <AddButton
        label={addLabel}
        onClick={() => onChange([...items, { type: labels[0]!, value: '' }])}
      />
    </>
  );
}

/** One postal-address block (label + street/city/region/postal/country). */
function AddressFields({
  value,
  onChange,
  onRemove,
  labels,
}: {
  value: ContactAddressDto;
  onChange: (next: ContactAddressDto) => void;
  onRemove: () => void;
  labels: string[];
}) {
  const set = (patch: Partial<ContactAddressDto>) => onChange({ ...value, ...patch });
  return (
    <div className="rounded-lg border border-border p-3">
      <div className="mb-2 flex items-center gap-2">
        <LabelSelect value={value.type} onChange={(type) => set({ type })} labels={labels} />
        <span className="flex-1" />
        <button
          onClick={onRemove}
          type="button"
          className="shrink-0 rounded-full p-1.5 text-faint active:bg-surface-2"
          aria-label="Remove address"
        >
          <CloseIcon className="size-4" />
        </button>
      </div>
      <div className="flex flex-col gap-2">
        <input
          value={value.street}
          onChange={(e) => set({ street: e.target.value })}
          placeholder="Street"
          className={inputCls}
        />
        <div className="flex gap-2">
          <input
            value={value.postalCode}
            onChange={(e) => set({ postalCode: e.target.value })}
            placeholder="Postal code"
            className={`${inputCls} w-28`}
          />
          <input
            value={value.locality}
            onChange={(e) => set({ locality: e.target.value })}
            placeholder="City"
            className={inputCls}
          />
        </div>
        <div className="flex gap-2">
          <input
            value={value.region}
            onChange={(e) => set({ region: e.target.value })}
            placeholder="Region"
            className={inputCls}
          />
          <input
            value={value.country}
            onChange={(e) => set({ country: e.target.value })}
            placeholder="Country"
            className={inputCls}
          />
        </div>
      </div>
    </div>
  );
}

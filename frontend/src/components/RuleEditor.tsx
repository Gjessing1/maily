/**
 * Add/edit sheet for one mail rule, shared by Settings → Rules and the reader's
 * "Rule for this sender…". Saving acts only on mail that arrives afterwards; the inbox mail the
 * rule already matches is shown as a live preview and changed only when the user ticks
 * "Also apply now" — never as a side effect of saving. "Protect from cleanup" is the exception
 * by nature: it is a gate, not an action, so it covers the sender's existing mail at once.
 */
import { useEffect, useState } from 'react';
import type { MailRule, MailRuleInput, RuleMatchKind, RuleMove, RulePreview } from '@maily/shared';
import { api } from '../api/client';
import { useAccounts } from '../state/data';
import { useBackHandler } from '../state/backButton';
import { applyRuleToExisting, ruleErrorMessage } from '../state/rules';
import { showNotice } from '../state/undo';
import { ConfirmDialog } from './ConfirmDialog';

/** What a new rule starts as (e.g. the reader's sender). */
export interface RuleSeed {
  matchKind: RuleMatchKind;
  matchValue: string;
}

const PREVIEW_DELAY_MS = 350;

const MOVE_OPTIONS: { value: RuleMove | null; label: string }[] = [
  { value: null, label: 'Keep in inbox' },
  { value: 'spam', label: 'Spam' },
  { value: 'archive', label: 'Archive' },
  { value: 'trash', label: 'Trash' },
];

export function RuleEditor({
  rule,
  seed,
  onClose,
  onSaved,
  onDeleted,
}: {
  /** The rule being edited; null creates a new one. */
  rule: MailRule | null;
  seed?: RuleSeed;
  onClose: () => void;
  onSaved?: (rule: MailRule) => void;
  onDeleted?: (id: string) => void;
}) {
  const accounts = useAccounts();
  const [matchKind, setMatchKind] = useState<RuleMatchKind>(
    rule?.matchKind ?? seed?.matchKind ?? 'sender',
  );
  const [matchValue, setMatchValue] = useState(rule?.matchValue ?? seed?.matchValue ?? '');
  const [accountId, setAccountId] = useState<string | null>(rule?.accountId ?? null);
  const [move, setMove] = useState<RuleMove | null>(rule?.move ?? null);
  const [markRead, setMarkRead] = useState(rule?.markRead ?? false);
  const [star, setStar] = useState(rule?.star ?? false);
  const [protect, setProtect] = useState(rule?.protect ?? false);
  const [preview, setPreview] = useState<RulePreview | null>(null);
  const [applyNow, setApplyNow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Mounted only while open, so Back always means "dismiss the sheet".
  useBackHandler(true, onClose);

  const hasAction = move !== null || markRead || star || protect;
  // Protecting mail from cleanup while trashing it on arrival contradicts itself (the server
  // refuses it), so picking one clears the other.
  const chooseMove = (next: RuleMove | null) => {
    setMove(next);
    if (next === 'trash') setProtect(false);
  };
  const chooseProtect = (on: boolean) => {
    setProtect(on);
    if (on && move === 'trash') setMove(null);
  };
  const value = matchValue.trim();
  const input: MailRuleInput = {
    accountId,
    matchKind,
    matchValue: value,
    move,
    markRead,
    star,
    protect,
    enabled: rule?.enabled ?? true,
  };
  // A disabled rule can't be applied; turn it on in the list first.
  const canApplyNow = rule?.enabled ?? true;

  // Live preview of the inbox mail this match would change. A value the server rejects just
  // means "not a full address/domain yet" while typing — no count, no error.
  const previewKey = JSON.stringify([accountId, matchKind, value, move, markRead, star, protect]);
  useEffect(() => {
    setPreview(null);
    if (!value || !hasAction) return;
    let alive = true;
    const timer = setTimeout(() => {
      api.rules
        .preview(input)
        .then((p) => alive && setPreview(p))
        .catch(() => undefined);
    }, PREVIEW_DELAY_MS);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
    // Keyed on previewKey (the serialized `input`), so a re-render alone never re-fetches.
  }, [previewKey]);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const saved = rule ? await api.rules.update(rule.id, input) : await api.rules.create(input);
      if (applyNow && canApplyNow && (preview?.count ?? 0) > 0) {
        const n = await applyRuleToExisting(saved.id);
        showNotice(`Rule saved · applied to ${n.toLocaleString()} message${n === 1 ? '' : 's'}`);
      } else {
        showNotice(rule ? 'Rule updated' : 'Rule saved');
      }
      onSaved?.(saved);
      onClose();
    } catch (e) {
      setError(ruleErrorMessage(e) || 'Couldn’t save the rule.');
      setBusy(false);
    }
  }

  async function remove() {
    if (!rule) return;
    setConfirmDelete(false);
    setBusy(true);
    setError(null);
    try {
      await api.rules.remove(rule.id);
      showNotice('Rule deleted');
      onDeleted?.(rule.id);
      onClose();
    } catch (e) {
      setError(ruleErrorMessage(e) || 'Couldn’t delete the rule.');
      setBusy(false);
    }
  }

  const count = preview?.count ?? 0;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center sm:items-center"
      role="dialog"
      aria-modal="true"
      aria-labelledby="rule-editor-title"
    >
      <button
        type="button"
        aria-label="Cancel"
        onClick={onClose}
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
      />
      <div className="safe-bottom relative flex max-h-[92vh] w-full max-w-md flex-col rounded-t-2xl border border-border bg-bg shadow-xl sm:rounded-2xl">
        <h2
          id="rule-editor-title"
          className="border-b border-border px-5 py-4 text-base font-semibold text-fg"
        >
          {rule ? 'Edit rule' : 'New rule'}
        </h2>

        <div className="flex-1 overflow-y-auto px-5 py-4 no-scrollbar">
          <Field label="When mail is from">
            <Chips
              value={matchKind}
              options={[
                { value: 'sender', label: 'This address' },
                { value: 'domain', label: 'This domain' },
              ]}
              onSelect={setMatchKind}
            />
            <input
              value={matchValue}
              onChange={(e) => setMatchValue(e.target.value)}
              type={matchKind === 'sender' ? 'email' : 'text'}
              inputMode={matchKind === 'sender' ? 'email' : 'url'}
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              placeholder={matchKind === 'sender' ? 'name@example.com' : 'example.com'}
              aria-label={matchKind === 'sender' ? 'Sender address' : 'Sender domain'}
              className="mt-2 w-full rounded-lg border border-border bg-surface px-3 py-2 text-[15px] text-fg outline-none focus:border-accent"
            />
            {matchKind === 'domain' && (
              <p className="mt-1 text-xs text-faint">Also matches its subdomains.</p>
            )}
          </Field>

          {(accounts?.length ?? 0) > 1 && (
            <Field label="On">
              <Chips
                value={accountId}
                options={[
                  { value: null, label: 'Every account' },
                  ...(accounts ?? []).map((a) => ({
                    value: a.id as string | null,
                    label: a.displayName || a.email,
                  })),
                ]}
                onSelect={setAccountId}
              />
            </Field>
          )}

          <Field label="Move it">
            <Chips value={move} options={MOVE_OPTIONS} onSelect={chooseMove} />
          </Field>

          <Field label="Also">
            <Toggle label="Mark as read" on={markRead} onChange={setMarkRead} />
            <Toggle label="Star" on={star} onChange={setStar} />
          </Field>

          <Field label="Cleanup">
            <Toggle label="Protect from cleanup" on={protect} onChange={chooseProtect} />
            <p className="text-xs text-faint">
              {protect && (preview?.protectedCount ?? 0) > 0
                ? `Shields ${preview!.protectedCount.toLocaleString()} message${preview!.protectedCount === 1 ? '' : 's'} you already have, and everything that arrives later.`
                : 'Never offer this mail for deletion in Cleanup — old mail included.'}
            </p>
          </Field>

          {!hasAction && (
            <p className="mt-3 text-sm text-faint">Pick at least one thing for the rule to do.</p>
          )}

          <p className="mt-4 text-xs text-faint">
            {rule
              ? 'Changes apply to mail that arrives from now on.'
              : 'Applies to mail that arrives from now on.'}
          </p>

          {canApplyNow && count > 0 && (
            <div className="mt-3 rounded-lg border border-border bg-surface px-3 py-2.5">
              <label className="flex items-start gap-3">
                <input
                  type="checkbox"
                  checked={applyNow}
                  onChange={(e) => setApplyNow(e.target.checked)}
                  className="mt-0.5 size-5 shrink-0 accent-accent"
                />
                <span className="min-w-0 text-sm">
                  Also apply to the {count.toLocaleString()} matching message
                  {count === 1 ? '' : 's'} in your inbox now
                </span>
              </label>
              <ul className="mt-2 space-y-0.5 pl-8">
                {preview?.sample.map((m) => (
                  <li key={m.id} className="truncate text-xs text-faint">
                    {m.subject || '(no subject)'}
                    <span className="text-faint/70"> · {m.fromAddress}</span>
                  </li>
                ))}
                {count > (preview?.sample.length ?? 0) && (
                  <li className="text-xs text-faint">
                    and {(count - (preview?.sample.length ?? 0)).toLocaleString()} more
                  </li>
                )}
              </ul>
            </div>
          )}

          {error && <p className="mt-3 text-sm text-danger">{error}</p>}
        </div>

        <div className="flex items-center gap-2 border-t border-border px-5 py-3">
          {rule && (
            <button
              onClick={() => setConfirmDelete(true)}
              disabled={busy}
              className="rounded-full px-3 py-2 text-sm text-danger active:bg-surface-2 disabled:opacity-50"
            >
              Delete
            </button>
          )}
          <span className="flex-1" />
          <button
            onClick={onClose}
            disabled={busy}
            className="rounded-full px-4 py-2 text-sm text-fg active:bg-surface-2 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={() => void save()}
            disabled={busy || !value || !hasAction}
            className="rounded-full bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>

      <ConfirmDialog
        open={confirmDelete}
        title="Delete this rule?"
        message={`Mail from ${rule?.matchValue ?? 'this sender'} will reach your inbox as usual again. Mail the rule already moved stays where it is.`}
        confirmLabel="Delete"
        danger
        onConfirm={() => void remove()}
        onCancel={() => setConfirmDelete(false)}
      />
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mt-5 first:mt-0">
      <p className="mb-2 text-xs font-medium uppercase tracking-wide text-faint">{label}</p>
      {children}
    </div>
  );
}

function Chips<V>({
  value,
  options,
  onSelect,
}: {
  value: V;
  options: { value: V; label: string }[];
  onSelect: (value: V) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          onClick={() => onSelect(o.value)}
          aria-pressed={value === o.value}
          className={`rounded-full px-3 py-1.5 text-sm transition-colors ${
            value === o.value
              ? 'bg-accent text-white'
              : 'bg-surface-2 text-faint active:bg-surface-3'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Toggle({
  label,
  on,
  onChange,
}: {
  label: string;
  on: boolean;
  onChange: (on: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={() => onChange(!on)}
      className="flex w-full items-center justify-between gap-4 py-2 text-left"
    >
      <span className="text-[15px]">{label}</span>
      <span
        className={`relative h-6 w-10 shrink-0 rounded-full transition-colors ${on ? 'bg-accent' : 'bg-surface-2'}`}
      >
        <span
          className={`absolute top-0.5 size-5 rounded-full bg-white transition-transform ${on ? 'translate-x-4' : 'translate-x-0.5'}`}
        />
      </span>
    </button>
  );
}

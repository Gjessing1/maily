/**
 * Reusable confirmation modal for destructive actions (delete / reset) — see the
 * "audit destructive actions" backlog item. Declarative + controlled: render it
 * with `open` and wire `onConfirm`/`onCancel`. Dismisses on Escape or backdrop tap.
 */
import { useEffect } from 'react';

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  neutralLabel,
  danger = false,
  onConfirm,
  onCancel,
  onNeutral,
}: {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Optional third, non-destructive action (e.g. "Save draft") shown between cancel and confirm. */
  neutralLabel?: string;
  /** Style the confirm button as destructive (red). */
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  onNeutral?: () => void;
}) {
  // Escape cancels while the dialog is open.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-dialog-title"
    >
      <button
        type="button"
        aria-label={cancelLabel}
        onClick={onCancel}
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
      />
      <div className="relative w-full max-w-sm rounded-2xl border border-border bg-bg p-5 shadow-xl">
        <h2 id="confirm-dialog-title" className="text-base font-semibold text-fg">
          {title}
        </h2>
        <p className="mt-2 text-sm text-faint">{message}</p>
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-full px-4 py-2 text-sm text-fg active:bg-surface-2"
          >
            {cancelLabel}
          </button>
          {neutralLabel && onNeutral && (
            <button
              type="button"
              onClick={onNeutral}
              className="rounded-full bg-surface-2 px-4 py-2 text-sm font-medium text-fg active:opacity-80"
            >
              {neutralLabel}
            </button>
          )}
          <button
            type="button"
            onClick={onConfirm}
            className={`rounded-full px-4 py-2 text-sm font-medium text-white ${
              danger ? 'bg-danger' : 'bg-accent'
            }`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

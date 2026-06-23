/**
 * App-level snackbar for the post-action undo window (delete/archive) and transient
 * error notices. Mounted above the routes so it persists when the Reader navigates
 * back to the list after an action. A pending action takes precedence over a notice.
 */
import { undoAction, useNotice, usePendingAction } from '../state/undo';

export function UndoSnackbar() {
  const pending = usePendingAction();
  const notice = useNotice();

  if (pending) {
    return (
      <div className="safe-bottom pointer-events-none fixed inset-x-0 bottom-4 z-50 flex justify-center px-4">
        <div className="pointer-events-auto flex items-center gap-4 rounded-full border border-border bg-surface-2 py-2.5 pl-4 pr-2.5 text-sm shadow-lg">
          <span className="text-fg">{pending.label}</span>
          <button
            type="button"
            onClick={() => void undoAction()}
            className="rounded-full px-3 py-1 font-medium text-accent active:bg-surface-3"
          >
            Undo
          </button>
        </div>
      </div>
    );
  }

  if (notice) {
    return (
      <div className="safe-bottom pointer-events-none fixed inset-x-0 bottom-4 z-50 flex justify-center px-4">
        <div className="pointer-events-auto flex items-center gap-4 rounded-full border border-border bg-surface-2 py-2.5 px-4 text-sm shadow-lg">
          <span className="text-fg">{notice}</span>
        </div>
      </div>
    );
  }

  return null;
}

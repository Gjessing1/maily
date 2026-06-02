/**
 * App-level snackbar for the post-delete undo window. Mounted above the routes so
 * it persists when the Reader navigates back to the list after a delete.
 */
import { undoDelete, usePendingDelete } from '../state/undo';

export function UndoSnackbar() {
  const pending = usePendingDelete();
  if (!pending) return null;

  return (
    <div className="safe-bottom pointer-events-none fixed inset-x-0 bottom-4 z-50 flex justify-center px-4">
      <div className="pointer-events-auto flex items-center gap-4 rounded-full border border-border bg-surface-2 py-2.5 pl-4 pr-2.5 text-sm shadow-lg">
        <span className="text-fg">{pending.label}</span>
        <button
          type="button"
          onClick={() => void undoDelete()}
          className="rounded-full px-3 py-1 font-medium text-accent active:bg-surface-3"
        >
          Undo
        </button>
      </div>
    </div>
  );
}

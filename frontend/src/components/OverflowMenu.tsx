import { useState } from 'react';
import { useBackHandler } from '../state/backButton';
import { MoreIcon } from '../ui/icons';

export interface OverflowItem {
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
  danger?: boolean;
}

/**
 * A "⋯" toolbar button with a dropdown of less-used actions — keeps the reader's icon row from
 * growing every time an action is added. Closes on pick, outside tap, or Android Back.
 */
export function OverflowMenu({
  items,
  disabled = false,
}: {
  items: OverflowItem[];
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  useBackHandler(open, close);

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        disabled={disabled}
        className="rounded-full p-2 active:bg-surface-2 disabled:opacity-35"
        aria-label="More actions"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <MoreIcon className="text-fg" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={close} />
          <div
            role="menu"
            className="absolute right-0 top-full z-50 mt-1 w-56 overflow-hidden rounded-xl border border-border bg-bg py-1 shadow-xl shadow-black/20"
          >
            {items.map((it) => (
              <button
                key={it.label}
                type="button"
                role="menuitem"
                onClick={() => {
                  close();
                  it.onClick();
                }}
                className={`flex w-full items-center gap-3 px-4 py-2 text-left text-sm transition-colors active:bg-surface-2 hover:bg-surface-2 ${
                  it.danger ? 'text-danger' : 'text-fg'
                }`}
              >
                <span className={it.danger ? 'text-danger' : 'text-faint'}>{it.icon}</span>
                {it.label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

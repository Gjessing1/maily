import { Link } from 'react-router-dom';
import type { AccountDto, FolderDto } from '@maily/shared';
import { useFolders } from '../state/data';
import { useAuth } from '../state/auth';
import { InboxIcon, SettingsIcon } from '../ui/icons';

const ROLE_ORDER: Record<string, number> = {
  inbox: 0,
  flagged: 1,
  drafts: 2,
  sent: 3,
  archive: 4,
  junk: 5,
  trash: 6,
  custom: 7,
};

function AccountFolders({
  account,
  selectedFolderId,
  onSelect,
}: {
  account: AccountDto;
  selectedFolderId: string | undefined;
  onSelect: (f: FolderDto) => void;
}) {
  const folders = useFolders(account.id);
  const sorted = (folders ?? [])
    .slice()
    .sort(
      (a, b) =>
        (ROLE_ORDER[a.role] ?? 9) - (ROLE_ORDER[b.role] ?? 9) || a.name.localeCompare(b.name),
    );

  return (
    <div className="mb-4">
      <p className="px-4 py-1 text-xs font-medium uppercase tracking-wide text-faint">
        {account.displayName || account.email}
      </p>
      <ul>
        {sorted.map((f) => {
          const active = f.id === selectedFolderId;
          return (
            <li key={f.id}>
              <button
                onClick={() => onSelect(f)}
                className={`flex w-full items-center gap-3 px-4 py-2.5 text-left text-[15px] transition ${
                  active ? 'bg-accent-soft text-accent' : 'text-fg active:bg-surface-2'
                }`}
              >
                <InboxIcon className="size-5 shrink-0 opacity-70" />
                <span className="truncate capitalize">{f.name}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function FolderDrawer({
  open,
  onClose,
  accounts,
  selectedFolderId,
  onSelect,
}: {
  open: boolean;
  onClose: () => void;
  accounts: AccountDto[];
  selectedFolderId: string | undefined;
  onSelect: (f: FolderDto) => void;
}) {
  const { logout } = useAuth();

  return (
    <>
      <div
        onClick={onClose}
        className={`fixed inset-0 z-20 bg-black/50 transition-opacity ${
          open ? 'opacity-100' : 'pointer-events-none opacity-0'
        }`}
      />
      <aside
        className={`safe-top safe-bottom fixed inset-y-0 left-0 z-30 flex w-72 max-w-[80%] flex-col overflow-y-auto border-r border-border bg-surface no-scrollbar transition-transform duration-200 ${
          open ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="px-4 py-4">
          <h2 className="text-lg font-semibold tracking-tight">maily</h2>
        </div>
        <div className="flex-1">
          {accounts.map((a) => (
            <AccountFolders
              key={a.id}
              account={a}
              selectedFolderId={selectedFolderId}
              onSelect={(f) => {
                onSelect(f);
                onClose();
              }}
            />
          ))}
        </div>
        <div className="border-t border-border">
          <Link
            to="/settings"
            onClick={onClose}
            className="flex items-center gap-3 px-4 py-3 text-[15px] text-fg active:bg-surface-2"
          >
            <SettingsIcon className="size-5 opacity-70" />
            Settings
          </Link>
          <button
            onClick={logout}
            className="w-full px-4 py-3 text-left text-[15px] text-danger active:bg-surface-2"
          >
            Lock
          </button>
        </div>
      </aside>
    </>
  );
}

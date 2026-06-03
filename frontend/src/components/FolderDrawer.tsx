import type { ComponentType, SVGProps } from 'react';
import { Link } from 'react-router-dom';
import type { AccountDto, FolderDto, FolderRole } from '@maily/shared';
import { useFolders } from '../state/data';
import { archivedFolder } from '../state/archived';
import { useAuth } from '../state/auth';
import { setPref, usePrefs, type Theme } from '../state/prefs';
import {
  ArchiveIcon,
  DraftIcon,
  FolderIcon,
  InboxIcon,
  MonitorIcon,
  MoonIcon,
  SendIcon,
  SettingsIcon,
  SpamIcon,
  SunIcon,
  TrashIcon,
} from '../ui/icons';

const ROLE_ORDER: Record<FolderRole, number> = {
  inbox: 0,
  drafts: 2,
  sent: 3,
  archive: 4,
  junk: 5,
  trash: 6,
  custom: 7,
};

/** Role → icon. Roles are normalised per provider on the backend, so mapping by
 * role (not folder name) is inherently provider-aware (Gmail labels vs mailbox.org). */
const ROLE_ICON: Record<FolderRole, ComponentType<SVGProps<SVGSVGElement>>> = {
  inbox: InboxIcon,
  drafts: DraftIcon,
  sent: SendIcon,
  archive: ArchiveIcon,
  junk: SpamIcon,
  trash: TrashIcon,
  custom: FolderIcon,
};

/** One-tap theme cycle: System → Light → Dark → System. */
const THEME_CYCLE: Record<Theme, Theme> = { system: 'light', light: 'dark', dark: 'system' };
const THEME_META: Record<Theme, { label: string; Icon: ComponentType<SVGProps<SVGSVGElement>> }> = {
  system: { label: 'System theme', Icon: MonitorIcon },
  light: { label: 'Light theme', Icon: SunIcon },
  dark: { label: 'Dark theme', Icon: MoonIcon },
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
    )
    // The raw archive folder (Gmail "All Mail") holds everything; swap it for the
    // virtual "Archived" smart view so the entry actually means archived mail.
    .map((f) => (f.role === 'archive' ? archivedFolder(account.id) : f));

  const Icon = (role: FolderRole) => ROLE_ICON[role] ?? FolderIcon;

  return (
    <div className="mb-4">
      <p className="px-4 py-1 text-xs font-medium uppercase tracking-wide text-faint">
        {account.displayName || account.email}
      </p>
      <ul>
        {sorted.map((f) => {
          const active = f.id === selectedFolderId;
          const FolderRoleIcon = Icon(f.role);
          return (
            <li key={f.id}>
              <button
                onClick={() => onSelect(f)}
                className={`flex w-full items-center gap-3 px-4 py-2.5 text-left text-[15px] transition ${
                  active ? 'bg-accent-soft text-accent' : 'text-fg active:bg-surface-2'
                }`}
              >
                <FolderRoleIcon className="size-5 shrink-0 opacity-70" />
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
  const theme = usePrefs().theme;
  const { label: themeLabel, Icon: ThemeIcon } = THEME_META[theme];

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
          <button
            onClick={() => setPref('theme', THEME_CYCLE[theme])}
            className="flex w-full items-center gap-3 px-4 py-3 text-left text-[15px] text-fg active:bg-surface-2"
          >
            <ThemeIcon className="size-5 opacity-70" />
            {themeLabel}
          </button>
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

import { useState, type ComponentType, type SVGProps } from 'react';
import { Link } from 'react-router-dom';
import type { AccountDto, FolderDto, FolderRole } from '@maily/shared';
import { useFolders } from '../state/data';
import { archivedFolder } from '../state/archived';
import { useAuth } from '../state/auth';
import { setPref, usePrefs, type Theme } from '../state/prefs';
import {
  ArchiveIcon,
  ChevronDownIcon,
  DraftIcon,
  FolderIcon,
  InboxIcon,
  MonitorIcon,
  MoonIcon,
  SendIcon,
  SettingsIcon,
  SpamIcon,
  StarIcon,
  SunIcon,
  TrashIcon,
  UsersIcon,
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

/** Custom folders/labels whose name matches a well-known flag-derived view get a
 * meaningful icon instead of the generic folder. Gmail surfaces `[Gmail]/Starred`
 * as a plain `custom` label (it has no SPECIAL-USE flag), so match on name. */
function iconForFolder(f: FolderDto): ComponentType<SVGProps<SVGSVGElement>> {
  if (f.role === 'custom' && /^(starred|flagged)$/i.test(f.name.trim())) return StarIcon;
  return ROLE_ICON[f.role] ?? FolderIcon;
}

/** One-tap theme cycle: System → Light → Dark → System. */
const THEME_CYCLE: Record<Theme, Theme> = { system: 'light', light: 'dark', dark: 'system' };
const THEME_META: Record<Theme, { label: string; Icon: ComponentType<SVGProps<SVGSVGElement>> }> = {
  system: { label: 'System theme', Icon: MonitorIcon },
  light: { label: 'Light theme', Icon: SunIcon },
  dark: { label: 'Dark theme', Icon: MoonIcon },
};

/** A single folder/label row. INBOX renders flush-left; everything below it is
 * indented one step so the inbox reads as the account's primary view. */
function FolderRow({
  folder,
  selectedFolderId,
  onSelect,
}: {
  folder: FolderDto;
  selectedFolderId: string | undefined;
  onSelect: (f: FolderDto) => void;
}) {
  const active = folder.id === selectedFolderId;
  const Icon = iconForFolder(folder);
  const indent = folder.role === 'inbox' ? 'pl-4' : 'pl-9';
  return (
    <li>
      <button
        onClick={() => onSelect(folder)}
        className={`flex w-full items-center gap-3 ${indent} py-2.5 pr-4 text-left text-[15px] transition ${
          active ? 'bg-accent-soft text-accent' : 'text-fg active:bg-surface-2'
        }`}
      >
        <Icon className="size-5 shrink-0 opacity-70" />
        <span className="truncate capitalize">{folder.name}</span>
      </button>
    </li>
  );
}

function AccountFolders({
  account,
  collapsed,
  onToggleCollapse,
  selectedFolderId,
  onSelect,
}: {
  account: AccountDto;
  collapsed: boolean;
  onToggleCollapse: () => void;
  selectedFolderId: string | undefined;
  onSelect: (f: FolderDto) => void;
}) {
  const folders = useFolders(account.id);
  const hidden = usePrefs().hiddenFolderIds;
  const sorted = (folders ?? [])
    .slice()
    .sort(
      (a, b) =>
        (ROLE_ORDER[a.role] ?? 9) - (ROLE_ORDER[b.role] ?? 9) || a.name.localeCompare(b.name),
    )
    // The raw archive folder (Gmail "All Mail") holds everything; swap it for the
    // virtual "Archived" smart view so the entry actually means archived mail.
    .map((f) => (f.role === 'archive' ? archivedFolder(account.id) : f))
    // Labels the user chose to hide (Settings → Labels) drop out of the drawer.
    .filter((f) => !hidden.includes(f.id));

  // INBOX stays pinned and always visible; collapsing tucks away the rest so a
  // multi-provider sidebar isn't a wall of icons.
  const inbox = sorted.filter((f) => f.role === 'inbox');
  const rest = sorted.filter((f) => f.role !== 'inbox');

  return (
    <div className="mb-4">
      <button
        onClick={onToggleCollapse}
        aria-expanded={!collapsed}
        className="flex w-full items-center gap-1.5 px-4 py-1 text-left text-xs font-medium uppercase tracking-wide text-faint active:bg-surface-2"
      >
        <ChevronDownIcon
          className={`size-3.5 shrink-0 transition-transform ${collapsed ? '-rotate-90' : ''}`}
        />
        <span className="truncate">{account.displayName || account.email}</span>
      </button>
      <ul>
        {inbox.map((f) => (
          <FolderRow
            key={f.id}
            folder={f}
            selectedFolderId={selectedFolderId}
            onSelect={onSelect}
          />
        ))}
        {!collapsed &&
          rest.map((f) => (
            <FolderRow
              key={f.id}
              folder={f}
              selectedFolderId={selectedFolderId}
              onSelect={onSelect}
            />
          ))}
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
  // Which account sections are collapsed. Kept in component state (the drawer stays
  // mounted, so it persists across open/close within a session) — a transient view
  // preference, not worth syncing to the server.
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const toggleCollapse = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

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
              collapsed={collapsed.has(a.id)}
              onToggleCollapse={() => toggleCollapse(a.id)}
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
            to="/contacts"
            onClick={onClose}
            className="flex items-center gap-3 px-4 py-3 text-[15px] text-fg active:bg-surface-2"
          >
            <UsersIcon className="size-5 opacity-70" />
            Contacts
          </Link>
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

import { useRef, useState, type ComponentType, type SVGProps } from 'react';
import { Link } from 'react-router-dom';
import type { AccountDto, FolderDto, FolderRole } from '@maily/shared';
import { useFolders } from '../state/data';
import { archivedFolder } from '../state/archived';
import { unifiedFolderFor } from '../state/unified';
import { useAuth } from '../state/auth';
import { setPref, usePrefs, type Theme } from '../state/prefs';
import {
  ArchiveIcon,
  ChevronDownIcon,
  DraftIcon,
  FolderIcon,
  InboxIcon,
  MapPinIcon,
  MonitorIcon,
  MoonIcon,
  SendIcon,
  SettingsIcon,
  SparklesIcon,
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

/**
 * Cross-account "All accounts" group: the unified inbox (pinned, always visible)
 * plus the unified Drafts/Sent views tucked under a collapse — since the inbox is
 * what's used day-to-day, the rest stays collapsed by default (ROADMAP §top).
 */
function UnifiedFolders({
  collapsed,
  onToggleCollapse,
  selectedFolderId,
  onSelect,
}: {
  collapsed: boolean;
  onToggleCollapse: () => void;
  selectedFolderId: string | undefined;
  onSelect: (f: FolderDto) => void;
}) {
  const inbox = unifiedFolderFor('inbox');
  const rest = [unifiedFolderFor('drafts'), unifiedFolderFor('sent')];
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
        <span className="truncate">All accounts</span>
      </button>
      <ul>
        <FolderRow folder={inbox} selectedFolderId={selectedFolderId} onSelect={onSelect} />
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

/** Past this fraction of the drawer width (on release) the open/close gesture commits. */
const SWIPE_COMMIT_FRACTION = 0.3;

export function FolderDrawer({
  open,
  onOpen,
  onClose,
  accounts,
  selectedFolderId,
  onSelect,
  swipeToOpen = false,
}: {
  open: boolean;
  /** Request opening the drawer (edge-swipe gesture). */
  onOpen?: () => void;
  onClose: () => void;
  accounts: AccountDto[];
  selectedFolderId: string | undefined;
  onSelect: (f: FolderDto) => void;
  /** Enable the left-edge swipe-to-open affordance (mobile only). */
  swipeToOpen?: boolean;
}) {
  const { logout } = useAuth();
  const { theme, collapseAccountsByDefault } = usePrefs();
  const { label: themeLabel, Icon: ThemeIcon } = THEME_META[theme];
  // Per-section collapse overrides. Accounts default to the persisted
  // `collapseAccountsByDefault` pref; the unified "All accounts" group defaults
  // collapsed (only its inbox is used day-to-day). This map records only the sections
  // the user has explicitly flipped this session (the drawer stays mounted, so it
  // persists across open/close) — a transient view preference, not synced.
  const UNIFIED_KEY = '__unified__';
  const [overrides, setOverrides] = useState<Map<string, boolean>>(() => new Map());
  const isCollapsed = (id: string, fallback: boolean) => overrides.get(id) ?? fallback;
  const toggleCollapse = (id: string, current: boolean) =>
    setOverrides((prev) => new Map(prev).set(id, !current));

  // ── Swipe gestures (mobile) ─────────────────────────────────────────────────
  // `drag` is the live finger offset in px while a gesture is in flight (null =
  // settled, so the CSS class transition drives the snap). We follow the finger
  // and commit on release past SWIPE_COMMIT_FRACTION of the measured width.
  const asideRef = useRef<HTMLElement>(null);
  const startX = useRef(0);
  const startY = useRef(0);
  // Axis lock so a vertical scroll inside the drawer isn't mistaken for a close-swipe.
  const axis = useRef<'none' | 'h' | 'v'>('none');
  const dragRef = useRef(0); // mirrors `drag` for the touchend decision (avoids stale state)
  const [drag, setDrag] = useState<number | null>(null);
  const width = () => asideRef.current?.offsetWidth ?? 288;

  const setDragBoth = (px: number) => {
    dragRef.current = px;
    setDrag(px);
  };

  function gestureStart(e: React.TouchEvent) {
    startX.current = e.touches[0]!.clientX;
    startY.current = e.touches[0]!.clientY;
    axis.current = 'none';
    setDragBoth(0);
  }

  /** Resolve the gesture axis once movement is unambiguous; returns the horizontal delta. */
  function resolveAxis(e: React.TouchEvent): number {
    const dx = e.touches[0]!.clientX - startX.current;
    const dy = e.touches[0]!.clientY - startY.current;
    if (axis.current === 'none' && Math.abs(dx) + Math.abs(dy) > 8) {
      axis.current = Math.abs(dx) > Math.abs(dy) ? 'h' : 'v';
    }
    return dx;
  }

  // Opening drag: starts in the left-edge catcher, travels right (0…width).
  function onEdgeMove(e: React.TouchEvent) {
    const dx = resolveAxis(e);
    if (axis.current !== 'h') return;
    setDragBoth(Math.max(0, Math.min(dx, width())));
  }
  function onEdgeEnd() {
    if (dragRef.current > width() * SWIPE_COMMIT_FRACTION) onOpen?.();
    setDrag(null);
  }

  // Closing drag: starts on the open drawer, travels left (-width…0).
  function onDrawerMove(e: React.TouchEvent) {
    const dx = resolveAxis(e);
    if (axis.current !== 'h') return;
    setDragBoth(Math.max(-width(), Math.min(dx, 0)));
  }
  function onDrawerEnd() {
    if (dragRef.current < -width() * SWIPE_COMMIT_FRACTION) onClose();
    setDrag(null);
  }

  // While dragging, follow the finger with an inline transform (no transition);
  // otherwise let the translate class + transition snap to the open/closed rest state.
  const dragging = drag !== null;
  const dragStyle = dragging
    ? {
        transform: open ? `translateX(${drag}px)` : `translateX(calc(-100% + ${drag}px))`,
        transition: 'none' as const,
      }
    : undefined;

  return (
    <>
      {/* Left-edge catcher: invisible strip that starts the open gesture. Sits clear
          of the bottom nav bar, and only while the drawer is closed. */}
      {swipeToOpen && !open && (
        <div
          onTouchStart={gestureStart}
          onTouchMove={onEdgeMove}
          onTouchEnd={onEdgeEnd}
          className="fixed bottom-24 left-0 top-0 z-20 w-5"
          aria-hidden
        />
      )}
      <div
        onClick={onClose}
        className={`fixed inset-0 z-20 bg-black/50 transition-opacity ${
          open || dragging ? 'opacity-100' : 'pointer-events-none opacity-0'
        }`}
      />
      <aside
        ref={asideRef}
        onTouchStart={open ? gestureStart : undefined}
        onTouchMove={open ? onDrawerMove : undefined}
        onTouchEnd={open ? onDrawerEnd : undefined}
        style={dragStyle}
        className={`safe-top safe-bottom fixed inset-y-0 left-0 z-30 flex w-72 max-w-[80%] flex-col overflow-y-auto border-r border-border bg-surface no-scrollbar transition-transform duration-200 ${
          open ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="px-4 py-4">
          <h2 className="text-lg font-semibold tracking-tight">maily</h2>
        </div>
        <div className="flex-1">
          {/* Cross-account merged views; only meaningful with more than one account. */}
          {accounts.length > 1 && (
            <UnifiedFolders
              collapsed={isCollapsed(UNIFIED_KEY, true)}
              onToggleCollapse={() => toggleCollapse(UNIFIED_KEY, isCollapsed(UNIFIED_KEY, true))}
              selectedFolderId={selectedFolderId}
              onSelect={(f) => {
                onSelect(f);
                onClose();
              }}
            />
          )}
          {accounts.map((a) => (
            <AccountFolders
              key={a.id}
              account={a}
              collapsed={isCollapsed(a.id, collapseAccountsByDefault)}
              onToggleCollapse={() =>
                toggleCollapse(a.id, isCollapsed(a.id, collapseAccountsByDefault))
              }
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
            to="/trips"
            onClick={onClose}
            className="flex items-center gap-3 px-4 py-3 text-[15px] text-fg active:bg-surface-2"
          >
            <MapPinIcon className="size-5 opacity-70" />
            Trips
          </Link>
          <Link
            to="/cleanup"
            onClick={onClose}
            className="flex items-center gap-3 px-4 py-3 text-[15px] text-fg active:bg-surface-2"
          >
            <SparklesIcon className="size-5 opacity-70" />
            Cleanup
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

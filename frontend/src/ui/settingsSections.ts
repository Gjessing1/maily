/**
 * What Settings is divided into, and what each part is called.
 *
 * Settings had grown into one long scroll of sixteen sibling sections: everything was
 * mounted at once, related controls sat screens apart (swipe actions under "Gestures",
 * page size under "Display"), and finding a preference meant remembering roughly how
 * far down it lived. The list below groups them by task instead.
 *
 * It is *data*, not JSX ordering, on purpose — the phone renders it as a drill-down
 * menu and a wide window as a sidebar, but the sections, their names and their order
 * come from here, so the two presentations cannot drift apart. Adopted from atlas
 * (`packages/core/src/settings.ts`), which solved the same split across its web and
 * Android clients.
 */

export type SettingsSectionId =
  | 'accounts'
  | 'appearance'
  | 'list'
  | 'reading'
  | 'composing'
  | 'contacts'
  | 'notifications'
  | 'sync'
  | 'storage'
  | 'system';

export interface SettingsSection {
  readonly id: SettingsSectionId;
  /** Menu row label, and the header title once the section is open. */
  readonly label: string;
  /** One line saying what is inside — the menu row's subtitle. */
  readonly hint: string;
}

/** Every settings section, in the order Settings presents them. */
export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  {
    id: 'accounts',
    label: 'Accounts & folders',
    hint: 'Mailboxes, label visibility and locking the app',
  },
  { id: 'appearance', label: 'Appearance', hint: 'Theme, reading pane and date format' },
  { id: 'list', label: 'Message list', hint: 'Ordering, page size and swipe actions' },
  { id: 'reading', label: 'Reading', hint: 'Remote images, conversations and mark-as-read' },
  { id: 'composing', label: 'Composing', hint: 'Undo send, default account and signature' },
  {
    id: 'contacts',
    label: 'Contacts & calendars',
    hint: 'Address books and where events are saved',
  },
  { id: 'notifications', label: 'Notifications', hint: 'Background alerts when new mail arrives' },
  { id: 'sync', label: 'Sync & enrichment', hint: 'Per-account status and the enrichment queue' },
  { id: 'storage', label: 'Storage', hint: 'Offline cache, server window and the local archive' },
  { id: 'system', label: 'System', hint: 'Build, updates and the Android app' },
];

/** The section with this id, or null — used to resolve the currently open one. */
export function settingsSection(id: SettingsSectionId | null): SettingsSection | null {
  return SETTINGS_SECTIONS.find((s) => s.id === id) ?? null;
}

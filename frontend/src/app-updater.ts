// In-app Android updates, the way Termnook does them: check the server's release manifest, and on
// "Update" let the shell download the APK, verify its size and SHA-256 and hand it to Android's
// installer. This file has no framework or app imports, so every shell app can carry the same copy.

export interface AppRelease {
  versionCode: number;
  versionName: string;
  sha256: string;
  bytes: number;
  /** Absolute URL of the APK on the app's own server. */
  apkUrl: string;
}

export type UpdateFailure = 'download' | 'verification' | 'installer' | 'cancelled';

export type UpdateState =
  | { phase: 'idle' }
  | { phase: 'checking' }
  | { phase: 'upToDate' }
  | { phase: 'checkFailed' }
  | { phase: 'available'; release: AppRelease }
  | { phase: 'needsPermission'; release: AppRelease }
  | { phase: 'downloading'; release: AppRelease; percent: number }
  | { phase: 'installing'; release: AppRelease }
  | { phase: 'failed'; release: AppRelease; reason: UpdateFailure }
  /** An older shell without the installer: Android's download notification takes over. */
  | { phase: 'handedOff'; release: AppRelease };

export interface UpdateStatus {
  copied: number;
  total: number;
  /** The system installer's answer, once it has one. */
  result: 'success' | 'cancelled' | 'failed' | null;
}

/**
 * The shell methods this needs; they are missing on APKs that predate them. Everything is a
 * resolved method call, never a Capacitor event, because listener registration doesn't reliably
 * take hold on a page served from a remote origin.
 */
export interface UpdaterShell {
  installUpdate?(options: { url: string; sha256: string; bytes: number }): Promise<void>;
  updateStatus?(): Promise<UpdateStatus>;
  updatePermission?(): Promise<{ canInstall: boolean }>;
  openInstallSettings?(): Promise<void>;
}

export interface UpdaterOptions {
  shell: UpdaterShell;
  /** The installed APK's versionCode. */
  installedVersionCode(): Promise<number>;
  /** The published release, or null when the server publishes none. Throws when unreachable. */
  fetchRelease(): Promise<AppRelease | null>;
  /** The pre-installer path for an APK without installUpdate. */
  legacyDownload?(release: AppRelease): Promise<void>;
  /** How often to ask the shell how the download and the installer are doing. */
  pollMillis?: number;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

/** Reads the /api/app/version answer; anything malformed counts as no release. */
export function parseRelease(value: unknown, origin: string): AppRelease | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const { versionCode, versionName, sha256, bytes, apkUrl } = value as Record<string, unknown>;
  if (typeof versionCode !== 'number' || !Number.isSafeInteger(versionCode) || versionCode < 1) {
    return null;
  }
  if (typeof versionName !== 'string' || typeof apkUrl !== 'string') {
    return null;
  }
  if (typeof sha256 !== 'string' || !SHA256_HEX.test(sha256)) {
    return null;
  }
  if (typeof bytes !== 'number' || !Number.isSafeInteger(bytes) || bytes <= 0) {
    return null;
  }
  return { versionCode, versionName, sha256, bytes, apkUrl: new URL(apkUrl, origin).href };
}

/** The status line under "Check for updates", worded like Termnook's. */
export function describeUpdate(state: UpdateState, appName: string): string {
  switch (state.phase) {
    case 'idle':
      return '';
    case 'checking':
      return 'Checking for updates…';
    case 'upToDate':
      return `${appName} is up to date.`;
    case 'checkFailed':
      return "Couldn't reach the update server. Try again later.";
    case 'available':
      return `${appName} ${state.release.versionName} is available.`;
    case 'needsPermission':
      return `To update itself, ${appName} needs permission to install apps. Allow it, then come back.`;
    case 'downloading':
      return `Downloading ${appName} ${state.release.versionName}… ${state.percent}%`;
    case 'installing':
      return 'Installing… Confirm in the system dialog.';
    case 'handedOff':
      return 'Downloading. Open the finished download to install it.';
    case 'failed':
      return describeFailure(state.reason);
  }
}

function describeFailure(reason: UpdateFailure): string {
  switch (reason) {
    case 'download':
      return 'The download failed. Try again.';
    case 'verification':
      return "The download didn't match the release, so it wasn't installed. Try again.";
    case 'installer':
      return "Android couldn't install the update.";
    case 'cancelled':
      return 'The update was cancelled.';
  }
}

/** True while a check or an install runs, so a second one doesn't start beside it. */
export function isBusy(state: UpdateState): boolean {
  return (
    state.phase === 'checking' || state.phase === 'downloading' || state.phase === 'installing'
  );
}

/** The release the state is about, if any. */
export function releaseOf(state: UpdateState): AppRelease | null {
  return 'release' in state ? state.release : null;
}

function failureFromCode(code: unknown): UpdateFailure {
  if (code === 'verification' || code === 'installer' || code === 'download') {
    return code;
  }
  return 'installer';
}

export class AppUpdater {
  private state: UpdateState = { phase: 'idle' };
  private readonly subscribers = new Set<(state: UpdateState) => void>();
  private poller: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly options: UpdaterOptions) {
    // Coming back from Android's "install unknown apps" screen is how the user grants it.
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden) {
          void this.refreshPermission();
        }
      });
    }
  }

  /** Whether this APK installs updates itself, rather than handing them to Downloads. */
  get installsInApp(): boolean {
    return typeof this.options.shell.installUpdate === 'function';
  }

  getState(): UpdateState {
    return this.state;
  }

  subscribe(subscriber: (state: UpdateState) => void): () => void {
    this.subscribers.add(subscriber);
    return () => {
      this.subscribers.delete(subscriber);
    };
  }

  /**
   * A manual check reports every outcome. An automatic one (on open) is silent unless it finds an
   * update, and never replaces an update the user is already looking at.
   */
  async check(manual: boolean): Promise<void> {
    if (isBusy(this.state)) {
      return;
    }
    if (!manual && this.state.phase !== 'idle') {
      return;
    }
    const before = this.state;
    if (manual) {
      this.set({ phase: 'checking' });
    }
    try {
      const [installed, release] = await Promise.all([
        this.options.installedVersionCode(),
        this.options.fetchRelease(),
      ]);
      if (release !== null && release.versionCode > installed) {
        this.set({ phase: 'available', release });
      } else if (manual) {
        this.set({ phase: 'upToDate' });
      }
    } catch {
      this.set(manual ? { phase: 'checkFailed' } : before);
    }
  }

  async install(): Promise<void> {
    const release = releaseOf(this.state);
    if (release === null || isBusy(this.state)) {
      return;
    }
    const { shell, legacyDownload } = this.options;
    if (typeof shell.installUpdate !== 'function') {
      if (legacyDownload) {
        try {
          await legacyDownload(release);
          this.set({ phase: 'handedOff', release });
        } catch {
          this.set({ phase: 'failed', release, reason: 'download' });
        }
      }
      return;
    }
    if (typeof shell.updatePermission === 'function') {
      const { canInstall } = await shell.updatePermission();
      if (!canInstall) {
        this.set({ phase: 'needsPermission', release });
        return;
      }
    }
    this.set({ phase: 'downloading', release, percent: 0 });
    this.startPolling();
    try {
      await shell.installUpdate({
        url: release.apkUrl,
        sha256: release.sha256,
        bytes: release.bytes,
      });
      // The installer has the APK; polling picks up its answer to the system's confirmation.
      if (this.state.phase === 'downloading') {
        this.set({ phase: 'installing', release });
      }
    } catch (error) {
      this.stopPolling();
      const code = (error as { code?: unknown }).code;
      if (code === 'permission') {
        this.set({ phase: 'needsPermission', release });
      } else if (code !== 'busy') {
        this.set({ phase: 'failed', release, reason: failureFromCode(code) });
      }
    }
  }

  async openInstallSettings(): Promise<void> {
    await this.options.shell.openInstallSettings?.();
  }

  async refreshPermission(): Promise<void> {
    const { shell } = this.options;
    if (this.state.phase !== 'needsPermission' || typeof shell.updatePermission !== 'function') {
      return;
    }
    const release = this.state.release;
    const { canInstall } = await shell.updatePermission();
    if (canInstall && this.state.phase === 'needsPermission') {
      this.set({ phase: 'available', release });
    }
  }

  /** One round of asking the shell how the update is doing. Public so tests can drive it. */
  async poll(): Promise<void> {
    const { shell } = this.options;
    if (typeof shell.updateStatus !== 'function') {
      return;
    }
    const status = await shell.updateStatus();
    const current = this.state;
    if (current.phase === 'downloading' && status.total > 0) {
      const percent = Math.min(100, Math.floor((status.copied * 100) / status.total));
      if (percent !== current.percent) {
        this.set({ ...current, percent });
      }
    }
    if (current.phase !== 'downloading' && current.phase !== 'installing') {
      this.stopPolling();
      return;
    }
    if (status.result === 'cancelled') {
      this.stopPolling();
      this.set({ phase: 'failed', release: current.release, reason: 'cancelled' });
    } else if (status.result === 'failed') {
      this.stopPolling();
      this.set({ phase: 'failed', release: current.release, reason: 'installer' });
    }
    // "success" ends this process; nothing to show.
  }

  private startPolling(): void {
    this.stopPolling();
    const every = this.options.pollMillis ?? 500;
    if (every <= 0) {
      return;
    }
    this.poller = setInterval(() => {
      this.poll().catch(() => {});
    }, every);
  }

  private stopPolling(): void {
    if (this.poller !== null) {
      clearInterval(this.poller);
      this.poller = null;
    }
  }

  private set(state: UpdateState): void {
    this.state = state;
    for (const subscriber of this.subscribers) {
      subscriber(state);
    }
  }
}

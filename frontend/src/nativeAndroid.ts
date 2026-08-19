interface NativeAppInfo {
  serverUrl: string;
  versionName: string;
  versionCode: number;
}

export interface NativeAppRelease {
  versionCode: number;
  versionName: string;
  apkUrl: string;
  bytes: number;
  sha256: string;
}

/**
 * What the shell reports about background notifications on this device.
 *
 * - `enabled` — the shell holds a push credential, i.e. its foreground service is meant
 *   to be running. This, not a web-side flag, is the truth: app data can be cleared, and
 *   an APK reinstall starts with nothing.
 * - `granted` — Android's POST_NOTIFICATIONS answer. Revocable from system settings at
 *   any time, without telling the app.
 * - `unrestricted` — the app is exempt from battery optimisation. Without it Doze can
 *   suspend the service's socket for hours, which looks exactly like "notifications
 *   stopped working" — so it is surfaced rather than silently hoped for.
 */
export interface NativePushStatus {
  enabled: boolean;
  granted: boolean;
  unrestricted: boolean;
}

interface MailyNativePlugin {
  getInfo(): Promise<NativeAppInfo>;
  configureServer(options: { serverUrl: string }): Promise<void>;
  openExternal(options: { url: string }): Promise<void>;
  setSystemBarsColor(options: { color: string }): Promise<void>;
  enablePush(options: { token: string }): Promise<NativePushStatus>;
  disablePush(): Promise<{ token: string | null }>;
  pushStatus(): Promise<NativePushStatus>;
  requestUnrestrictedBattery(): Promise<void>;
}

/**
 * Capacitor 8's built-in system-bars plugin (part of `@capacitor/core`, always
 * registered by the bridge). Its style names the *background* the bars sit on, so
 * the system paints the inverse onto it: 'LIGHT' asks for dark clock/wifi/battery
 * icons, 'DARK' for white ones.
 */
interface SystemBarsPlugin {
  setStyle(options: { style: 'LIGHT' | 'DARK' }): Promise<void>;
}

interface CapacitorPlugins {
  MailyNative?: MailyNativePlugin;
  SystemBars?: SystemBarsPlugin;
}

function capacitorPlugins(): CapacitorPlugins | null {
  const host = globalThis as typeof globalThis & {
    Capacitor?: { Plugins?: CapacitorPlugins };
  };
  return host.Capacitor?.Plugins ?? null;
}

function nativePlugin(): MailyNativePlugin | null {
  return capacitorPlugins()?.MailyNative ?? null;
}

export function isNativeAndroid(): boolean {
  return nativePlugin() !== null;
}

export async function getNativeAppInfo(): Promise<NativeAppInfo | null> {
  return nativePlugin()?.getInfo() ?? null;
}

export async function configureNativeServer(serverUrl: string): Promise<void> {
  const plugin = nativePlugin();
  if (!plugin) throw new Error('Android bridge is unavailable');
  await plugin.configureServer({ serverUrl });
}

export async function openNativeExternal(url: string): Promise<void> {
  const plugin = nativePlugin();
  if (!plugin) {
    window.open(url, '_blank', 'noopener');
    return;
  }
  await plugin.openExternal({ url });
}

/**
 * Hand the shell a push credential and start its notification service.
 *
 * All of these are *method calls*, deliberately — never Capacitor listeners. Maily is
 * served from a remote origin, where plugin listener registration never takes hold (the
 * same trap that broke Android Back), so anything delivered as an event would never
 * arrive. Asking and answering in one promise depends on nothing but the bridge call
 * that is already working.
 *
 * The secret is stored on the native side and nowhere else: the foreground service
 * connects to `/api/push/stream` long after this WebView is gone, so it must own it, and
 * one copy is one place to revoke. Returns null off Android, or on an APK too old to
 * have the method — the web app can be newer than the installed shell.
 */
export async function enableNativePush(token: string): Promise<NativePushStatus | null> {
  const plugin = nativePlugin();
  if (!plugin?.enablePush) return null;
  try {
    return await plugin.enablePush({ token });
  } catch {
    // Permission dialog dismissed, or the shell could not start its service.
    return null;
  }
}

/**
 * Stop the notification service and forget the credential, resolving with the secret it
 * dropped so the caller can revoke the matching server row. Null when there was nothing
 * stored, or on an APK that predates the method.
 */
export async function disableNativePush(): Promise<string | null> {
  const plugin = nativePlugin();
  if (!plugin?.disablePush) return null;
  try {
    return (await plugin.disablePush()).token;
  } catch {
    return null;
  }
}

/** What the shell currently believes about notifications here. Null when it can't say. */
export async function nativePushStatus(): Promise<NativePushStatus | null> {
  const plugin = nativePlugin();
  if (!plugin?.pushStatus) return null;
  try {
    return await plugin.pushStatus();
  } catch {
    return null;
  }
}

/**
 * Open Android's "allow background activity" prompt for Maily. Doze otherwise suspends
 * the push service's socket while the phone is idle, which is precisely when a
 * notification matters most.
 */
export async function requestUnrestrictedBattery(): Promise<void> {
  const plugin = nativePlugin();
  if (!plugin?.requestUnrestrictedBattery) return;
  try {
    await plugin.requestUnrestrictedBattery();
  } catch {
    // Dialog dismissed, or an APK older than the web app.
  }
}

/** The app background the bars sit against, as the `#rrggbb` the native side parses. */
function themeBackground(): string | null {
  const value = getComputedStyle(document.documentElement).getPropertyValue('--color-bg').trim();
  return /^#[0-9a-f]{6}$/i.test(value) ? value : null;
}

/**
 * Match Android's status and navigation bars to the resolved app theme, so the
 * system-painted clock, wifi and battery icons stay legible. Two halves:
 *
 * - **Icons** — only the app can tell the system whether what sits behind them is
 *   light or dark. Capacitor's own default follows the *OS* night mode, which is
 *   wrong whenever the in-app theme pref overrides it (dark app on a light phone
 *   paints dark icons onto a near-black bar, and vice versa).
 * - **Bar background** — whatever shows behind the bars when the WebView does not
 *   reach under them: the opaque bars below Android 15, and the window decor that
 *   Capacitor exposes when it insets the WebView instead (an older WebView, or a
 *   page without `viewport-fit=cover`). Set second, because `setStyle` repaints
 *   the decor from the Android theme on its way through.
 *
 * Failures are swallowed: the web app is served from the server and can be newer
 * than the installed APK, where `setSystemBarsColor` does not exist yet.
 */
export async function applyNativeSystemBars(theme: 'dark' | 'light'): Promise<void> {
  const plugins = capacitorPlugins();
  if (!plugins) return;
  const background = themeBackground();
  try {
    await plugins.SystemBars?.setStyle({ style: theme === 'light' ? 'LIGHT' : 'DARK' });
    if (background) await plugins.MailyNative?.setSystemBarsColor({ color: background });
  } catch {
    // An APK older than the web app, or a platform without the bridge.
  }
}

/**
 * Claim the Android system Back press by answering the native shell's question.
 *
 * The shell asks the page directly — it evaluates `window.mailyBack()` in the WebView
 * on every press — rather than delivering the press through a Capacitor listener.
 * Maily is served from a remote origin, so a plain global is the one channel that does
 * not depend on the bridge's plugin JS having been injected into this document and on
 * an asynchronous listener registration having completed before the press arrives.
 *
 * `handler` must answer **synchronously**: true when it consumed the press, false when
 * the app is at its root and the shell should leave Maily. A page that installs nothing
 * (the SSO detour, the connection-error page, a WebView whose JS has not booted) leaves
 * the global undefined, and the shell falls back to its own WebView history.
 *
 * Returns the uninstall. Harmless on the web, where nothing calls the global.
 */
export function setNativeBackHandler(handler: () => boolean): () => void {
  const host = globalThis as typeof globalThis & { mailyBack?: () => boolean };
  host.mailyBack = handler;
  return () => {
    if (host.mailyBack === handler) delete host.mailyBack;
  };
}

/**
 * Let the Android shell route a tapped new-mail notification into the running app.
 *
 * Same remote-origin-safe channel as Back: the shell evaluates
 * `window.mailyOpenMessage(id)` in the WebView rather than delivering an event through
 * a Capacitor listener, which would never have registered on this origin. `handler`
 * answers **synchronously** — true when it took the navigation, so the shell leaves the
 * document alone; anything else and the shell falls back to loading `/m/:id`, throwing
 * away app state. A page that installs nothing (the SSO detour, the error page) gets
 * that fallback, which is the right outcome there.
 *
 * Returns the uninstall. Harmless on the web, where nothing calls the global.
 */
export function setNativeMessageOpener(handler: (messageId: string) => boolean): () => void {
  const host = globalThis as typeof globalThis & {
    mailyOpenMessage?: (messageId: string) => boolean;
  };
  host.mailyOpenMessage = handler;
  return () => {
    if (host.mailyOpenMessage === handler) delete host.mailyOpenMessage;
  };
}

/** Return a newer APK published by this Maily server, or null. */
export async function findNativeAppUpdate(
  installed: NativeAppInfo | null,
): Promise<NativeAppRelease | null> {
  if (!installed) return null;
  try {
    const response = await fetch('/api/app/version', { cache: 'no-store' });
    if (!response.ok) return null;
    const release = (await response.json()) as Partial<NativeAppRelease>;
    if (
      !Number.isSafeInteger(release.versionCode) ||
      (release.versionCode as number) <= installed.versionCode ||
      typeof release.versionName !== 'string' ||
      typeof release.apkUrl !== 'string' ||
      typeof release.bytes !== 'number' ||
      typeof release.sha256 !== 'string'
    ) {
      return null;
    }
    return release as NativeAppRelease;
  } catch {
    return null;
  }
}

export function nativeDownloadUrl(release: NativeAppRelease): string {
  return new URL(release.apkUrl, window.location.origin).href;
}

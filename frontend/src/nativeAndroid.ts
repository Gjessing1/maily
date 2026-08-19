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
 * Result of asking the shell for an FCM registration token. `granted` is Android's
 * POST_NOTIFICATIONS answer; `token` is null when permission was refused or when the
 * APK was built without Firebase credentials (no `google-services.json`).
 */
export interface NativePushToken {
  granted: boolean;
  token: string | null;
}

interface MailyNativePlugin {
  getInfo(): Promise<NativeAppInfo>;
  configureServer(options: { serverUrl: string }): Promise<void>;
  openExternal(options: { url: string }): Promise<void>;
  setSystemBarsColor(options: { color: string }): Promise<void>;
  getPushToken(): Promise<NativePushToken>;
  clearPushToken(): Promise<void>;
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
 * Ask the Android shell to register with FCM and hand back the device token.
 *
 * A *method call*, deliberately — not a Capacitor listener. Maily is served from a
 * remote origin, where plugin listener registration never takes hold (the same trap
 * that broke Android Back), so the token cannot be delivered by the `registration`
 * event `@capacitor/push-notifications` normally uses. The shell resolves the token
 * synchronously-enough into a promise instead, and the web layer posts it to the
 * backend over its own authenticated session.
 *
 * Returns null off Android, or on an APK too old to have the method.
 */
export async function getNativePushToken(): Promise<NativePushToken | null> {
  const plugin = nativePlugin();
  if (!plugin?.getPushToken) return null;
  try {
    return await plugin.getPushToken();
  } catch {
    // Permission dialog dismissed, Google Play services missing, or no Firebase config.
    return null;
  }
}

/** Drop the device's FCM registration (turning notifications off in the APK). */
export async function clearNativePushToken(): Promise<void> {
  const plugin = nativePlugin();
  if (!plugin?.clearPushToken) return;
  try {
    await plugin.clearPushToken();
  } catch {
    // An APK older than the web app; the server-side token is deleted regardless.
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

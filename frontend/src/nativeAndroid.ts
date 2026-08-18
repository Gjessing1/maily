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

/** Handle returned by Capacitor's generated `addListener` shim (synchronous on Android). */
interface NativeListener {
  remove(): void;
}

interface MailyNativePlugin {
  getInfo(): Promise<NativeAppInfo>;
  configureServer(options: { serverUrl: string }): Promise<void>;
  openExternal(options: { url: string }): Promise<void>;
  exitApp(): Promise<void>;
  setSystemBarsColor(options: { color: string }): Promise<void>;
  addListener(eventName: 'backButton', callback: () => void): NativeListener;
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
 * Subscribe to the Android system Back press. The native side only forwards the press
 * while a listener is registered here, and falls back to WebView history otherwise —
 * so the returned unsubscribe must run when the app stops handling Back itself.
 * Returns a no-op unsubscribe on the web, where there is no Back button to claim.
 */
export function onNativeBack(handler: () => void): () => void {
  const plugin = nativePlugin();
  if (typeof plugin?.addListener !== 'function') return () => {};
  const listener = plugin.addListener('backButton', handler);
  return () => listener.remove();
}

/** Leave the Android app (Back at the root of the navigation stack). No-op on the web. */
export async function exitNativeApp(): Promise<void> {
  await nativePlugin()?.exitApp();
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

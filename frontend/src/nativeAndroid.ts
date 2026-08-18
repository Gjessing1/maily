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
  addListener(eventName: 'backButton', callback: () => void): NativeListener;
}

function nativePlugin(): MailyNativePlugin | null {
  const host = globalThis as typeof globalThis & {
    Capacitor?: { Plugins?: { MailyNative?: MailyNativePlugin } };
  };
  return host.Capacitor?.Plugins?.MailyNative ?? null;
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

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

interface MailyNativePlugin {
  getInfo(): Promise<NativeAppInfo>;
  configureServer(options: { serverUrl: string }): Promise<void>;
  openExternal(options: { url: string }): Promise<void>;
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

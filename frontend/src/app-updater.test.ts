import { describe, expect, it } from 'vitest';
import {
  AppUpdater,
  describeUpdate,
  parseRelease,
  type AppRelease,
  type UpdaterShell,
  type UpdateStatus,
} from './app-updater';

const release: AppRelease = {
  versionCode: 3,
  versionName: '0.3.0',
  sha256: 'a'.repeat(64),
  bytes: 1000,
  apkUrl: 'https://app.example/api/app/download',
};

function fakeShell(overrides: Partial<UpdaterShell> = {}) {
  const calls: unknown[] = [];
  const status: UpdateStatus = { copied: 0, total: 0, result: null };
  let canInstall = true;
  const shell: UpdaterShell = {
    installUpdate: async (options) => {
      calls.push(options);
    },
    updateStatus: async () => ({ ...status }),
    updatePermission: async () => ({ canInstall }),
    openInstallSettings: async () => {},
    ...overrides,
  };
  const grant = (value: boolean) => {
    canInstall = value;
  };
  return { shell, calls, status, grant };
}

function updater(shell: UpdaterShell, published: AppRelease | null = release, installed = 2) {
  return new AppUpdater({
    shell,
    installedVersionCode: async () => installed,
    fetchRelease: async () => published,
    pollMillis: 0,
  });
}

describe('parseRelease', () => {
  it('resolves the APK URL against the server', () => {
    const parsed = parseRelease({ ...release, apkUrl: '/api/app/download' }, 'https://app.example');
    expect(parsed).toEqual(release);
  });

  it('ignores a malformed manifest', () => {
    expect(parseRelease({ ...release, sha256: 'ABC' }, 'https://app.example')).toBeNull();
    expect(parseRelease({ ...release, bytes: 0 }, 'https://app.example')).toBeNull();
    expect(parseRelease(null, 'https://app.example')).toBeNull();
  });
});

describe('AppUpdater', () => {
  it('offers a newer versionCode and stays quiet about the same one on open', async () => {
    const { shell } = fakeShell();
    const newer = updater(shell);
    await newer.check(false);
    expect(newer.getState()).toEqual({ phase: 'available', release });

    const same = updater(shell, release, 3);
    await same.check(false);
    expect(same.getState()).toEqual({ phase: 'idle' });
    await same.check(true);
    expect(same.getState()).toEqual({ phase: 'upToDate' });
  });

  it('reports an unreachable server only on a manual check', async () => {
    const { shell } = fakeShell();
    const failing = new AppUpdater({
      shell,
      installedVersionCode: async () => 2,
      fetchRelease: async () => {
        throw new Error('offline');
      },
    });
    await failing.check(false);
    expect(failing.getState()).toEqual({ phase: 'idle' });
    await failing.check(true);
    expect(failing.getState()).toEqual({ phase: 'checkFailed' });
  });

  it('downloads with progress, then waits for the system installer', async () => {
    const { shell, calls, status } = fakeShell();
    let finishDownload = () => {};
    shell.installUpdate = (options) => {
      calls.push(options);
      return new Promise<void>((resolve) => {
        finishDownload = resolve;
      });
    };
    const subject = updater(shell);
    await subject.check(true);
    const installing = subject.install();
    await Promise.resolve();
    await Promise.resolve();
    Object.assign(status, { copied: 420, total: 1000 });
    await subject.poll();
    expect(subject.getState()).toEqual({ phase: 'downloading', release, percent: 42 });
    finishDownload();
    await installing;
    expect(subject.getState()).toEqual({ phase: 'installing', release });
    expect(calls).toEqual([{ url: release.apkUrl, sha256: release.sha256, bytes: release.bytes }]);

    status.result = 'cancelled';
    await subject.poll();
    expect(subject.getState()).toEqual({ phase: 'failed', release, reason: 'cancelled' });
  });

  it('asks for the install permission and offers the update again once granted', async () => {
    const { shell, grant } = fakeShell();
    grant(false);
    const subject = updater(shell);
    await subject.check(true);
    await subject.install();
    expect(subject.getState()).toEqual({ phase: 'needsPermission', release });
    await subject.refreshPermission();
    expect(subject.getState()).toEqual({ phase: 'needsPermission', release });
    grant(true);
    await subject.refreshPermission();
    expect(subject.getState()).toEqual({ phase: 'available', release });
  });

  it('names a failed verification', async () => {
    const { shell } = fakeShell({
      installUpdate: async () => {
        throw Object.assign(new Error('mismatch'), { code: 'verification' });
      },
    });
    const subject = updater(shell);
    await subject.check(true);
    await subject.install();
    expect(subject.getState()).toEqual({ phase: 'failed', release, reason: 'verification' });
    expect(describeUpdate(subject.getState(), 'AppName')).toMatch(/didn't match/);
  });

  it('falls back to the download handoff on an APK without the installer', async () => {
    const downloads: AppRelease[] = [];
    const subject = new AppUpdater({
      shell: {},
      installedVersionCode: async () => 2,
      fetchRelease: async () => release,
      legacyDownload: async (published) => {
        downloads.push(published);
      },
    });
    expect(subject.installsInApp).toBe(false);
    await subject.check(true);
    await subject.install();
    expect(downloads).toEqual([release]);
    expect(subject.getState()).toEqual({ phase: 'handedOff', release });
  });
});

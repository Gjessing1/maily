import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyNativeSystemBars } from './nativeAndroid';

const setStyle = vi.fn().mockResolvedValue(undefined);
const setSystemBarsColor = vi.fn().mockResolvedValue(undefined);

type Host = typeof globalThis & { Capacitor?: unknown };

function installBridge() {
  (globalThis as Host).Capacitor = {
    Plugins: { SystemBars: { setStyle }, MailyNative: { setSystemBarsColor } },
  };
}

beforeEach(() => {
  setStyle.mockClear().mockResolvedValue(undefined);
  setSystemBarsColor.mockClear().mockResolvedValue(undefined);
  document.documentElement.style.setProperty('--color-bg', '#0b0b0f');
  installBridge();
});

afterEach(() => {
  delete (globalThis as Host).Capacitor;
  document.documentElement.style.removeProperty('--color-bg');
});

describe('applyNativeSystemBars', () => {
  it('asks for dark icons under a light theme and light icons under a dark one', async () => {
    document.documentElement.style.setProperty('--color-bg', '#ffffff');
    await applyNativeSystemBars('light');
    // Capacitor's style names the background, so LIGHT is what darkens the icons.
    expect(setStyle).toHaveBeenCalledWith({ style: 'LIGHT' });
    expect(setSystemBarsColor).toHaveBeenCalledWith({ color: '#ffffff' });

    await applyNativeSystemBars('dark');
    expect(setStyle).toHaveBeenLastCalledWith({ style: 'DARK' });
  });

  it('sends the theme background as the bar colour', async () => {
    await applyNativeSystemBars('dark');
    expect(setSystemBarsColor).toHaveBeenCalledWith({ color: '#0b0b0f' });
  });

  it('skips the colour when the token is not a plain hex value', async () => {
    document.documentElement.style.setProperty('--color-bg', 'oklch(0.2 0 0)');
    await applyNativeSystemBars('dark');
    expect(setStyle).toHaveBeenCalledOnce();
    expect(setSystemBarsColor).not.toHaveBeenCalled();
  });

  it('does nothing off the Android bridge', async () => {
    delete (globalThis as Host).Capacitor;
    await expect(applyNativeSystemBars('dark')).resolves.toBeUndefined();
    expect(setStyle).not.toHaveBeenCalled();
  });

  it('survives an APK that predates setSystemBarsColor', async () => {
    setSystemBarsColor.mockRejectedValue(new Error('not implemented'));
    await expect(applyNativeSystemBars('light')).resolves.toBeUndefined();
    expect(setStyle).toHaveBeenCalledOnce();
  });
});

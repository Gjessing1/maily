import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import {
  grantOfflineAccess,
  hasOfflineAccess,
  revokeOfflineAccess,
  useOnlineStatus,
} from './connectivity';

function setOnline(value: boolean): void {
  Object.defineProperty(navigator, 'onLine', { configurable: true, value });
}

function Status() {
  return <span>{useOnlineStatus() ? 'online' : 'offline'}</span>;
}

afterEach(() => {
  revokeOfflineAccess();
  setOnline(true);
});

describe('offline access', () => {
  test('persists and revokes eligibility for cached startup', () => {
    expect(hasOfflineAccess()).toBe(false);
    grantOfflineAccess();
    expect(hasOfflineAccess()).toBe(true);
    revokeOfflineAccess();
    expect(hasOfflineAccess()).toBe(false);
  });

  test('reacts to browser online and offline events', () => {
    setOnline(true);
    render(<Status />);
    expect(screen.getByText('online')).toBeInTheDocument();

    act(() => {
      setOnline(false);
      window.dispatchEvent(new Event('offline'));
    });
    expect(screen.getByText('offline')).toBeInTheDocument();
  });
});

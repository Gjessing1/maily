import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  authConfig: vi.fn<() => Promise<{ authRequired: boolean }>>(),
  connectSocket: vi.fn(),
  disconnectSocket: vi.fn(),
}));

vi.mock('../api/client', () => ({
  api: {
    authConfig: mocks.authConfig,
    login: vi.fn(),
  },
  getToken: () => null,
  onUnauthorized: () => () => {},
  setToken: vi.fn(),
}));

vi.mock('../api/socket', () => ({
  connectSocket: mocks.connectSocket,
  disconnectSocket: mocks.disconnectSocket,
}));

import { AuthProvider, useAuth } from './auth';
import { grantOfflineAccess, revokeOfflineAccess } from './connectivity';

function setOnline(value: boolean): void {
  Object.defineProperty(navigator, 'onLine', { configurable: true, value });
}

function State() {
  const { authed, ready } = useAuth();
  return <span>{`${ready ? 'ready' : 'waiting'}:${authed ? 'authed' : 'locked'}`}</span>;
}

afterEach(() => {
  revokeOfflineAccess();
  setOnline(true);
  mocks.authConfig.mockReset();
  mocks.connectSocket.mockReset();
  mocks.disconnectSocket.mockReset();
});

describe('offline auth bootstrap', () => {
  test('opens a previously authenticated browser without probing the network', () => {
    setOnline(false);
    grantOfflineAccess();

    render(
      <AuthProvider>
        <State />
      </AuthProvider>,
    );

    expect(screen.getByText('ready:authed')).toBeInTheDocument();
    expect(mocks.authConfig).not.toHaveBeenCalled();
    expect(mocks.connectSocket).not.toHaveBeenCalled();
  });

  test('keeps an unknown browser locked while offline', () => {
    setOnline(false);

    render(
      <AuthProvider>
        <State />
      </AuthProvider>,
    );

    expect(screen.getByText('ready:locked')).toBeInTheDocument();
    expect(mocks.authConfig).not.toHaveBeenCalled();
  });

  test('verifies the server session after connectivity returns', async () => {
    setOnline(false);
    grantOfflineAccess();
    mocks.authConfig.mockResolvedValue({ authRequired: false });
    render(
      <AuthProvider>
        <State />
      </AuthProvider>,
    );

    await act(async () => {
      setOnline(true);
      window.dispatchEvent(new Event('online'));
    });

    await waitFor(() => expect(mocks.authConfig).toHaveBeenCalledOnce());
    expect(screen.getByText('ready:authed')).toBeInTheDocument();
  });
});

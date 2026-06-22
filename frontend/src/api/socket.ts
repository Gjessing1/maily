/**
 * Socket.io live signals (foreground only, ARCHITECTURE §3). The server emits a
 * single `signal` event carrying a lightweight SocketSignal — never payloads.
 * Consumers subscribe to a typed signal stream; payloads are fetched over HTTP.
 */
import { io, type Socket } from 'socket.io-client';
import type { SocketSignal } from '@maily/shared';
import { getToken } from './client';

const API_BASE = import.meta.env.VITE_API_BASE ?? '';

let socket: Socket | null = null;
const listeners = new Set<(signal: SocketSignal) => void>();
const reconnectListeners = new Set<() => void>();

export function connectSocket(): Socket {
  if (socket) return socket;
  socket = io(API_BASE || '/', {
    auth: { token: getToken() ?? '' },
    transports: ['websocket'],
  });
  socket.on('signal', (signal: SocketSignal) => {
    listeners.forEach((l) => l(signal));
  });
  // While disconnected a client misses live signals (e.g. read/unread changes); fire
  // reconnect listeners on every RE-connection (not the initial connect) so consumers
  // can refetch and catch up. socket.io emits `connect` on first connect and each reconnect.
  let hasConnected = false;
  socket.on('connect', () => {
    if (hasConnected) reconnectListeners.forEach((l) => l());
    hasConnected = true;
  });
  return socket;
}

export function disconnectSocket(): void {
  socket?.disconnect();
  socket = null;
}

/** Subscribe to live signals. Returns an unsubscribe fn. */
export function onSignal(listener: (signal: SocketSignal) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Subscribe to socket RE-connections (missed-signal catch-up). Returns an unsubscribe fn. */
export function onSocketReconnect(listener: () => void): () => void {
  reconnectListeners.add(listener);
  return () => reconnectListeners.delete(listener);
}

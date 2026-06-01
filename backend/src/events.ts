/**
 * Process-internal event bus. The sync engine publishes lightweight signals here;
 * the Socket.io layer and the Web Push layer subscribe. Payloads are signals only,
 * never heavy email bodies (ARCHITECTURE §3).
 */
import { EventEmitter } from 'node:events';
import type { SocketSignal } from '@maily/shared';

const bus = new EventEmitter();
bus.setMaxListeners(0);

const CHANNEL = 'signal';

export function emitSignal(signal: SocketSignal): void {
  bus.emit(CHANNEL, signal);
}

export function onSignal(listener: (signal: SocketSignal) => void): () => void {
  bus.on(CHANNEL, listener);
  return () => bus.off(CHANNEL, listener);
}

/**
 * Socket.io live signals. Foreground-only push of lightweight signals
 * (ARCHITECTURE §3) — never email/attachment payloads. The handshake is gated by
 * the same JWT as the HTTP API (ARCHITECTURE §5).
 */
import type { FastifyInstance } from 'fastify';
import { Server } from 'socket.io';
import { onSignal } from '../events.js';
import { createLogger } from '../logger.js';

const log = createLogger('socket');

function tokenFrom(socket: { handshake: { auth?: Record<string, unknown>; headers: Record<string, unknown> } }): string | null {
  const fromAuth = socket.handshake.auth?.token;
  if (typeof fromAuth === 'string') return fromAuth;
  const header = socket.handshake.headers.authorization;
  if (typeof header === 'string' && header.startsWith('Bearer ')) return header.slice(7);
  return null;
}

export function attachSockets(app: FastifyInstance): Server {
  const io = new Server(app.server, { cors: { origin: true } });

  io.use((socket, next) => {
    const token = tokenFrom(socket);
    if (!token) return next(new Error('unauthorized'));
    try {
      app.jwt.verify(token);
      next();
    } catch {
      next(new Error('unauthorized'));
    }
  });

  io.on('connection', (socket) => {
    log.debug(`client connected: ${socket.id}`);
  });

  // Fan every engine signal out to all authenticated clients.
  onSignal((signal) => io.emit('signal', signal));

  return io;
}

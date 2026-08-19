/**
 * Self-hosted device push: a Server-Sent Events hub the Android APK keeps open from a
 * foreground service (ARCHITECTURE §3).
 *
 * Why this and not FCM. The APK is a Capacitor WebView shell, and Android System WebView
 * exposes no Push API, so it cannot hold the VAPID subscription the installed PWA does.
 * The obvious substitute is Firebase, but that routes every notification about this
 * mailbox through Google, needs a Firebase project plus a service-account key on the
 * host, and only works on phones with Play Services. Maily already runs an always-on
 * server the phone can reach; the device connecting to *it* removes the third party
 * entirely, at the cost of the phone holding the socket itself.
 *
 * SSE rather than a WebSocket (or a second Socket.io namespace): the traffic is strictly
 * one-way signals, and SSE is a plain chunked GET — no upgrade handshake to survive a
 * reverse proxy, and a line-oriented format a small Kotlin reader can parse without a
 * library. Socket.io stays what it is: the *foreground* channel for the web app.
 *
 * The trade FCM made for us and we now make ourselves: nothing queues for a device that
 * is offline. Hence the catch-up replay on connect — a reconnecting device is told about
 * the INBOX arrivals it missed, bounded so a week-long absence cannot dump a hundred
 * notifications into the shade at once.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import { createLogger } from '../logger.js';
import {
  advancePushDeviceCursor,
  listUnifiedByRole,
  touchPushDevice,
  type PushDeviceRow,
} from '../db/queries.js';
import { notificationFor, type MailNotification } from './payload.js';

const log = createLogger('push-stream');

/**
 * Well under any proxy or carrier idle timeout (Caddy's default write timeout is
 * generous, but a mobile NAT will drop an idle flow far sooner). This is also how the
 * device notices a half-open socket: no ping within its own read timeout means dead.
 */
const HEARTBEAT_MS = 25_000;

/** Ceiling on a reconnect replay, so a long offline stretch is a summary, not a flood. */
const CATCHUP_LIMIT = 10;
/** Nothing older than this is worth waking someone for on reconnect. */
const CATCHUP_MAX_AGE_MS = 24 * 60 * 60 * 1000;

interface Connection {
  deviceId: string;
  raw: FastifyReply['raw'];
}

const connections = new Set<Connection>();
let heartbeat: NodeJS.Timeout | null = null;

/** One SSE frame. Every field of the payload rides in a single JSON `data:` line. */
function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** True when the frame reached the socket. A full write buffer is not a failure — the
 *  payload is a few hundred bytes and Node queues it — but a dead socket is. */
function send(connection: Connection, event: string, data: unknown): boolean {
  if (connection.raw.writableEnded || connection.raw.destroyed) return false;
  try {
    connection.raw.write(frame(event, data));
    return true;
  } catch {
    // Socket died between the check and the write; the 'close' handler cleans up.
    return false;
  }
}

function startHeartbeat(): void {
  if (heartbeat) return;
  heartbeat = setInterval(() => {
    for (const connection of connections) {
      // An SSE comment: ignored by any parser, but it is bytes on the wire, which is
      // all a keep-alive has to be.
      if (connection.raw.writableEnded || connection.raw.destroyed) continue;
      try {
        connection.raw.write(': ping\n\n');
      } catch {
        // Cleanup happens on 'close'.
      }
    }
  }, HEARTBEAT_MS);
  // Never hold the process open for a heartbeat.
  heartbeat.unref();
}

function stopHeartbeatIfIdle(): void {
  if (connections.size > 0 || !heartbeat) return;
  clearInterval(heartbeat);
  heartbeat = null;
}

/**
 * Arrivals this device missed while it was disconnected: unseen INBOX mail newer than
 * its cursor. Oldest first, so the shade ends up in the same order a live stream would
 * have produced. Already-read mail is skipped — reading it on another client is the
 * clearest possible signal that a notification for it is now noise.
 */
function catchUp(device: PushDeviceRow): MailNotification[] {
  const since = Math.max(device.lastEventAt ?? 0, Date.now() - CATCHUP_MAX_AGE_MS);
  return listUnifiedByRole('inbox', CATCHUP_LIMIT, undefined, true)
    .map(notificationFor)
    .filter((n) => n.receivedAt > since)
    .reverse();
}

/**
 * Hand a validated device its stream. Hijacks the reply: SSE is an open-ended chunked
 * response, which is exactly what Fastify's normal serialise-and-finish path is not.
 */
export function attachDeviceStream(
  device: PushDeviceRow,
  req: FastifyRequest,
  reply: FastifyReply,
): void {
  reply.hijack();
  reply.raw.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    // `no-transform` matters as much as `no-cache`: a proxy that gzips this would
    // buffer it, and a buffered SSE stream delivers nothing until it is full.
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  // Some intermediaries hold a response until the first bytes arrive; open with a comment.
  reply.raw.write(': connected\n\n');

  const connection: Connection = { deviceId: device.id, raw: reply.raw };
  connections.add(connection);
  startHeartbeat();
  touchPushDevice(device.id);
  log.info(`device connected (${connections.size} open)`);

  for (const missed of catchUp(device)) {
    send(connection, 'mail', missed);
    advancePushDeviceCursor(device.id, missed.receivedAt);
  }

  const drop = (): void => {
    connections.delete(connection);
    stopHeartbeatIfIdle();
    log.info(`device disconnected (${connections.size} open)`);
  };
  req.raw.on('close', drop);
  req.raw.on('error', drop);
}

/** Fan a new-mail notification out to every connected device. Never throws. */
export function broadcastStream(payload: MailNotification): void {
  for (const connection of connections) {
    if (send(connection, 'mail', payload)) {
      advancePushDeviceCursor(connection.deviceId, payload.receivedAt);
    }
  }
}

/** Connected device count — the honest answer to "are notifications working here?". */
export function connectedDeviceCount(): number {
  return connections.size;
}

/** Close every stream on shutdown so devices reconnect immediately rather than timing out. */
export function stopStreamHub(): void {
  for (const connection of connections) {
    try {
      connection.raw.end();
    } catch {
      // Already gone.
    }
  }
  connections.clear();
  stopHeartbeatIfIdle();
}

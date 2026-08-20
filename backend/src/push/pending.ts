/**
 * What the Android APK has not been told about yet (ARCHITECTURE §3).
 *
 * The APK does not hold a connection to Maily. Android only lets an app keep a socket
 * open indefinitely from a foreground service, and a foreground service must post a
 * permanent notification — an "app is running" notice in the shade forever, which is a
 * poor trade for a phone that can simply ask. So the device wakes on its own alarm every
 * few minutes and asks this: *what have I missed?*
 *
 * That inverts where the state lives, and this is the state. A device row carries a
 * cursor (`lastEventAt`); everything unread that arrived in the INBOX after it is what
 * the phone still owes the user a notification for. Reading the mail on another client
 * removes it from the answer, which is the clearest possible signal that a notification
 * for it would now be noise.
 *
 * The cursor advances as the answer is written, not on a later acknowledgement from the
 * phone. A response lost in flight therefore means those arrivals are not offered again —
 * deliberately: the alternative re-notifies mail the user has already seen a notification
 * for on every subsequent poll, and a duplicate alert is worse than a missed one for mail
 * that is still sitting in the inbox.
 */
import {
  advancePushDeviceCursor,
  listUnifiedByRole,
  touchPushDevice,
  type PushDeviceRow,
} from '../db/queries.js';
import { notificationFor, type MailNotification } from './payload.js';

/** Ceiling on one answer, so a long offline stretch is a summary, not a flood. */
const PENDING_LIMIT = 10;
/** Nothing older than this is worth a notification by the time the phone asks. */
const PENDING_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * The notifications this device still owes, oldest first — the order a live stream would
 * have produced, so the shade stacks the way the mail arrived. Advances the device's
 * cursor past everything returned.
 */
export function pendingForDevice(device: PushDeviceRow): MailNotification[] {
  touchPushDevice(device.id);

  const since = Math.max(device.lastEventAt ?? 0, Date.now() - PENDING_MAX_AGE_MS);
  const pending = listUnifiedByRole('inbox', PENDING_LIMIT, undefined, true)
    .map(notificationFor)
    .filter((n) => n.receivedAt > since)
    .reverse();

  for (const notification of pending) {
    advancePushDeviceCursor(device.id, notification.receivedAt);
  }
  return pending;
}

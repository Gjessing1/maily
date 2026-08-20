package io.gjessing.maily;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;

/**
 * Posts Maily's Android notifications.
 *
 * With FCM, Firebase's own service drew these from a `notification` payload and the app
 * never saw them until they were tapped. Holding the connection ourselves means posting
 * them ourselves, which is strictly more control: the presentation lives here, in one
 * place, rather than being split between a server-side payload shape and a manifest full
 * of `default_notification_*` meta-data.
 *
 * Two channels, deliberately separated so the user can silence one without the other:
 *
 * - **Mail** — the actual notifications, default importance, one per message.
 * - **Connection** — the foreground service's own persistent notice. Android requires a
 *   visible notification for a service that runs indefinitely, so it cannot be dropped,
 *   only pushed as far out of the way as the platform still permits: silent, badge-less,
 *   secret on the lock screen, and collapsed to a single line under the shade's "Silent"
 *   heading.
 *
 * Two limits are worth knowing before trying to hide the connection notice further, both
 * confirmed against API 36 rather than assumed:
 *
 * - **MIN does not survive.** The channel asks for IMPORTANCE_MIN and the platform keeps
 *   that as the channel's original importance, but the moment a foreground service posts
 *   on it the channel is flagged as showing a user-visible task and its effective
 *   importance is raised to LOW. LOW still means silent and no peek, but it does put the
 *   small icon in the status bar. No app-side setting overrides this; the user-facing
 *   escape hatch is the system's own "hide silent notification icons" toggle, which does
 *   drop the icon while leaving the service running.
 * - **The lock screen is a per-notification call, not a channel one.** Android resets an
 *   app-created channel's lockscreen visibility to VISIBILITY_NO_OVERRIDE, so only
 *   NotificationCompat.Builder#setVisibility has any effect — see serviceNotification.
 */
final class MailyPushNotifier {
    /** Fixed id: the ongoing service notice is a singleton, replaced rather than stacked. */
    static final int SERVICE_NOTIFICATION_ID = 1;

    private MailyPushNotifier() {}

    static String mailChannelId(Context context) {
        return context.getString(R.string.mail_notification_channel_id);
    }

    static String serviceChannelId(Context context) {
        return context.getString(R.string.service_notification_channel_id);
    }

    /**
     * Register both channels. Android 8+ silently drops a notification whose channel was
     * never created, and creating an existing channel is a no-op, so this is safe (and
     * necessary) on every entry point that might post.
     */
    static void ensureChannels(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager == null) return;

        NotificationChannel mail = new NotificationChannel(
            mailChannelId(context),
            context.getString(R.string.mail_notification_channel_name),
            NotificationManager.IMPORTANCE_DEFAULT
        );
        mail.setDescription(context.getString(R.string.mail_notification_channel_description));
        manager.createNotificationChannel(mail);

        // Nobody asked to be told that a socket is open, so every knob this channel still
        // owns is turned down. MIN is the floor the platform accepts (it raises the
        // *effective* importance to LOW for a foreground service — see the class notes),
        // no badge keeps it off the launcher icon, and clearing sound, vibration and
        // lights makes the silence a property of the channel rather than of each post:
        // if a future Android raises the foreground-service floor again, as it already
        // did once, this channel has nothing left to play.
        NotificationChannel service = new NotificationChannel(
            serviceChannelId(context),
            context.getString(R.string.service_notification_channel_name),
            NotificationManager.IMPORTANCE_MIN
        );
        service.setDescription(context.getString(R.string.service_notification_channel_description));
        service.setShowBadge(false);
        service.setSound(null, null);
        service.enableVibration(false);
        service.setVibrationPattern(null);
        service.enableLights(false);
        manager.createNotificationChannel(service);

        // A channel is frozen at creation — re-registering an existing id only refreshes
        // its name and description, and everything above is silently discarded. Devices
        // that installed an earlier build would therefore keep the old channel, sound URI
        // and all, which is why the id above is versioned; deleting the superseded ids is
        // what stops a dead duplicate from sitting in the system notification settings.
        for (String legacyId : context.getResources()
                .getStringArray(R.array.service_notification_channel_legacy_ids)) {
            manager.deleteNotificationChannel(legacyId);
        }
    }

    /**
     * The ongoing notice the foreground service runs under. `connected` only changes its
     * text — the notification must never disappear while the service lives, or Android
     * kills the service with it.
     */
    static Notification serviceNotification(Context context, boolean connected) {
        return new NotificationCompat.Builder(context, serviceChannelId(context))
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(context.getString(
                connected ? R.string.push_service_connected : R.string.push_service_connecting
            ))
            // PRIORITY_MIN is what pre-Oreo devices read instead of the channel, and what
            // ranks the notice last within the channel on newer ones.
            .setPriority(NotificationCompat.PRIORITY_MIN)
            // The one knob that actually keeps this off a secure lock screen: the channel's
            // own lockscreen visibility is reset by the platform for app-created channels,
            // so it has to be set per post. New mail deliberately does not do this — only
            // the notice about the transport is hidden, never the mail itself.
            .setVisibility(NotificationCompat.VISIBILITY_SECRET)
            .setOngoing(true)
            .setShowWhen(false)
            .setSilent(true)
            // Nothing here is worth mirroring to a watch or a paired device.
            .setLocalOnly(true)
            .setContentIntent(launchIntent(context, null))
            .build();
    }

    /**
     * Post one new-mail notification. The tag is the message id, matching the service
     * worker's per-message tag on the Web Push path: a shared tag would make each arrival
     * replace the last one in the shade.
     */
    static void postMail(Context context, String messageId, String title, String body) {
        Notification notification = new NotificationCompat.Builder(context, mailChannelId(context))
            .setSmallIcon(R.drawable.ic_notification)
            .setColor(ContextCompat.getColor(context, R.color.maily_accent))
            .setContentTitle(title)
            .setContentText(body)
            // Subjects run long on a phone; let the shade expand to the whole line.
            .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .setCategory(NotificationCompat.CATEGORY_EMAIL)
            .setAutoCancel(true)
            .setContentIntent(launchIntent(context, messageId))
            .build();
        try {
            NotificationManagerCompat.from(context).notify(messageId, 0, notification);
        } catch (SecurityException ignored) {
            // POST_NOTIFICATIONS revoked between the permission check and the post.
        }
    }

    /**
     * Launch MainActivity, carrying the message id in the same extra the FCM path used —
     * MailyNotificationLink still reads it, and still decides between a cold-start URL
     * and asking a running WebView to route itself.
     *
     * `FLAG_UPDATE_CURRENT` with a per-message request code: without a distinct code,
     * Android would reuse one PendingIntent across every mail notification and every tap
     * would open whichever message was newest.
     */
    private static PendingIntent launchIntent(Context context, String messageId) {
        Intent intent = new Intent(context, MainActivity.class)
            .setAction(Intent.ACTION_MAIN)
            .addCategory(Intent.CATEGORY_LAUNCHER)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        if (messageId != null) intent.putExtra(MailyNotificationLink.MESSAGE_ID_EXTRA, messageId);
        return PendingIntent.getActivity(
            context,
            messageId == null ? 0 : messageId.hashCode(),
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
    }
}

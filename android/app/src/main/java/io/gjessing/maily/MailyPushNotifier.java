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
 *   visible notification for a service that runs indefinitely; MIN importance is the
 *   quietest form it is allowed to take, which collapses it into the shade's silent
 *   section with no sound, no peek and no status-bar icon.
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

        NotificationChannel service = new NotificationChannel(
            serviceChannelId(context),
            context.getString(R.string.service_notification_channel_name),
            NotificationManager.IMPORTANCE_MIN
        );
        service.setDescription(context.getString(R.string.service_notification_channel_description));
        service.setShowBadge(false);
        manager.createNotificationChannel(service);
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
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .setOngoing(true)
            .setShowWhen(false)
            .setSilent(true)
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

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
 * Posts Maily's Android notifications — now only ever about mail.
 *
 * Maily used to hold a socket open from a foreground service, and Android's price for a
 * service that runs indefinitely is a permanent notification: a "Watching for new mail"
 * notice that sat in the shade forever. Every trick the platform allows was applied to
 * it and it was still there, because it is not decoration — it is the licence the service
 * runs under. The alarm-driven poll (MailyPushAlarm) needs no service, so the notice is
 * gone rather than hidden, and its channel is deleted from the system settings below.
 *
 * One channel remains: **Mail**, default importance, one notification per message.
 */
final class MailyPushNotifier {
    private MailyPushNotifier() {}

    static String mailChannelId(Context context) {
        return context.getString(R.string.mail_notification_channel_id);
    }

    /**
     * Register the mail channel and clear out the retired ones. Android 8+ silently drops
     * a notification whose channel was never created, and creating an existing channel is
     * a no-op, so this is safe (and necessary) on every entry point that might post.
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

        // A channel outlives the code that created it: an upgrade that stops using one
        // leaves it sitting in the system notification settings, switchable, attached to
        // nothing. Deleting the retired connection channels is what actually removes the
        // old foreground-service notice from the user's settings after this update.
        for (String retiredId : context.getResources()
                .getStringArray(R.array.retired_notification_channel_ids)) {
            manager.deleteNotificationChannel(retiredId);
        }
    }

    /**
     * Post one new-mail notification. The tag is the message id, matching the service
     * worker's per-message tag on the Web Push path: a shared tag would make each arrival
     * replace the last one in the shade. It also makes a repost idempotent — the same
     * message notified twice replaces its own entry instead of stacking a duplicate.
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

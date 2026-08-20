package io.gjessing.maily;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

/**
 * Every reason to ask the server about new mail arrives here: the poll alarm firing, or
 * an event that clears the armed alarm out from under it.
 *
 * A reboot cancels every alarm the app had set, and an in-place APK update does the same
 * without a boot broadcast following it. Without re-arming on both, notifications would
 * stay silently off until the user next opened Maily — for an app whose whole job is
 * telling you about mail you have not opened, indistinguishable from being broken.
 *
 * A no-op on a device where notifications were never enabled: {@link MailyPushAlarm#enable}
 * checks for a stored credential first.
 */
public class MailyPushReceiver extends BroadcastReceiver {
    private static final String TAG = "MailyPush";

    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent == null ? null : intent.getAction();
        if (action == null) return;
        Context appContext = context.getApplicationContext();

        switch (action) {
            case MailyPushAlarm.ACTION_POLL:
                // The alarm is one-shot, so the next one is armed here whatever the poll
                // finds — including when it fails. A missed check must not end the series.
                inBackground(appContext, () -> {
                    poll(appContext);
                    MailyPushAlarm.armNext(appContext);
                });
                return;

            case Intent.ACTION_BOOT_COMPLETED:
            case Intent.ACTION_MY_PACKAGE_REPLACED:
                MailyPushAlarm.enable(appContext);
                return;

            default:
                Log.w(TAG, "ignoring unexpected action " + action);
        }
    }

    /**
     * Ask, and post whatever came back.
     *
     * The server answers with what this device has not been told about yet and advances
     * its cursor as it does, so an empty answer — the common case — is one small request
     * and nothing else.
     */
    private static void poll(Context context) {
        String serverUrl = MailyPreferences.getServerUrl(context);
        String token = MailyPreferences.getPushToken(context);
        if (serverUrl == null || token == null) return;

        MailyPushPoll.Result result = MailyPushPoll.fetch(serverUrl, token);
        if (result.status == MailyPushPoll.Status.UNAUTHORIZED) {
            // The server no longer knows this credential — revoked from another client, or
            // the mailbox was reset. Asking again can only fail; drop it and let the web
            // app re-register the next time Maily is opened.
            MailyPreferences.setPushToken(context, null);
            MailyPushAlarm.disable(context);
            return;
        }
        if (result.mail.isEmpty()) return;

        MailyPushNotifier.ensureChannels(context);
        for (MailyPushPoll.Mail mail : result.mail) {
            MailyPushNotifier.postMail(context, mail.messageId, mail.title, mail.body);
        }
    }

    /**
     * Keep the process alive past onReceive for the network call inside. Android gives a
     * broadcast receiver roughly ten seconds this way, which is what the poll's own
     * timeouts are sized against.
     */
    private void inBackground(Context context, Runnable work) {
        PendingResult result = goAsync();
        new Thread(() -> {
            try {
                work.run();
            } catch (Exception error) {
                Log.w(TAG, "mail check failed", error);
                MailyPushAlarm.armNext(context);
            } finally {
                result.finish();
            }
        }).start();
    }
}

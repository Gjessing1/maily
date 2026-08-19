package io.gjessing.maily;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * Brings the push connection back after a reboot.
 *
 * Without this, notifications would stay off until the user next opened Maily — which,
 * for an app whose whole point is telling you about mail you have not opened yet, means
 * they would appear to have stopped working. FCM never needed a receiver because Play
 * Services holds its socket across boots; holding our own means restoring it ourselves.
 *
 * A no-op when notifications are off here: {@link MailyPushService#startIfEnabled} checks
 * for a stored credential first, so a device that never enabled them starts nothing.
 */
public class MailyBootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent == null ? null : intent.getAction();
        if (!Intent.ACTION_BOOT_COMPLETED.equals(action)
            && !Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)) {
            return;
        }
        // ACTION_MY_PACKAGE_REPLACED matters as much as boot: installing a new APK stops
        // the service, and no boot broadcast follows an in-place update.
        MailyPushService.startIfEnabled(context);
    }
}

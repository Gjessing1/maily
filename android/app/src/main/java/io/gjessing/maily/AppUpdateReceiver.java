package io.gjessing.maily;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInstaller;
import androidx.core.content.IntentCompat;

/**
 * The package installer's answer to an update session from {@link AppUpdater}. Not exported: only
 * that explicit PendingIntent reaches it.
 */
public class AppUpdateReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        int status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE);
        switch (status) {
            case PackageInstaller.STATUS_PENDING_USER_ACTION:
                Intent confirm = IntentCompat.getParcelableExtra(intent, Intent.EXTRA_INTENT, Intent.class);
                if (confirm == null) {
                    AppUpdater.recordInstallResult("failed");
                    return;
                }
                // The user just tapped Update and is watching the progress, so the app is in the
                // foreground and may start the system's confirmation screen.
                confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                context.startActivity(confirm);
                break;
            case PackageInstaller.STATUS_SUCCESS:
                // Usually never seen: Android replaces the app and ends this process first.
                AppUpdater.recordInstallResult("success");
                break;
            case PackageInstaller.STATUS_FAILURE_ABORTED:
                AppUpdater.recordInstallResult("cancelled");
                break;
            default:
                AppUpdater.recordInstallResult("failed");
                break;
        }
    }
}

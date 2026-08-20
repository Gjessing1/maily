package io.gjessing.maily;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.PowerManager;
import android.os.SystemClock;
import android.util.Log;

/**
 * When Maily next asks the server whether anything has arrived.
 *
 * This is the whole reason the APK no longer shows a permanent "Watching for new mail"
 * notice. Android only lets an app hold a socket open indefinitely from a foreground
 * service, and a foreground service must post an ongoing notification — that notice was
 * the price of the connection, not something the feature needed. Waking on an alarm
 * instead costs nothing in the shade. (Apps that manage instant notifications *and* no
 * notice, Gmail included, get there because Play Services holds one socket for the whole
 * phone and hands each app its messages. Maily deliberately does not route this mailbox
 * through Google — see docs/ANDROID_APP.md §3.)
 *
 * `setAndAllowWhileIdle` is the alarm type that matters here: an ordinary alarm is simply
 * deferred to the next maintenance window once the phone enters Doze, which on an idle
 * night means no mail notification until morning. This one fires through Doze, at the
 * cost of being rate-limited to roughly one wake per nine minutes while idle — which is
 * why the idle interval below sits comfortably past that rather than pretending to be
 * faster than the platform allows.
 *
 * Not an *exact* alarm. Exact alarms are for things the user scheduled — an appointment,
 * a timer — and Android increasingly treats them as a permission-worthy claim. Mail has
 * no appointed time; a few minutes of slack is invisible, so the inexact form is both the
 * honest declaration and the one that lets the system batch this wake with others.
 */
final class MailyPushAlarm {
    private static final String TAG = "MailyPush";
    static final String ACTION_POLL = "io.gjessing.maily.PUSH_POLL";
    private static final int REQUEST_CODE = 1408;

    /**
     * With the screen on, the user is present and a delayed mail notification is
     * noticeable, so the phone asks more often. Nothing is holding a socket, so the cost
     * of the shorter interval is one small HTTPS request.
     */
    private static final long INTERVAL_AWAKE_MS = 5 * 60_000L;
    /** Screen off: past Doze's own rate limit, where a shorter interval would be fiction. */
    private static final long INTERVAL_ASLEEP_MS = 15 * 60_000L;

    private MailyPushAlarm() {}

    /** Arm the next poll if this device holds a push credential. Safe to call repeatedly. */
    static void enable(Context context) {
        Context appContext = context.getApplicationContext();
        if (MailyPreferences.getPushToken(appContext) == null) return;
        if (MailyPreferences.getServerUrl(appContext) == null) return;
        armNext(appContext);
    }

    /** Stop asking. Nothing else has to be torn down — there is no service and no socket. */
    static void disable(Context context) {
        Context appContext = context.getApplicationContext();
        AlarmManager alarmManager = appContext.getSystemService(AlarmManager.class);
        PendingIntent pending = pollIntent(appContext, PendingIntent.FLAG_NO_CREATE);
        if (pending == null) return;
        if (alarmManager != null) alarmManager.cancel(pending);
        pending.cancel();
    }

    /**
     * Schedule the poll after this one. Called on every fire rather than as a repeating
     * alarm: `setAndAllowWhileIdle` has no repeating form, and re-arming each time is what
     * lets the interval follow the screen.
     */
    static void armNext(Context context) {
        Context appContext = context.getApplicationContext();
        AlarmManager alarmManager = appContext.getSystemService(AlarmManager.class);
        if (alarmManager == null) return;
        long interval = isAwake(appContext) ? INTERVAL_AWAKE_MS : INTERVAL_ASLEEP_MS;
        try {
            // ELAPSED_REALTIME, not RTC: this is "in five minutes", and a clock correction
            // or a timezone change must not move it.
            alarmManager.setAndAllowWhileIdle(
                AlarmManager.ELAPSED_REALTIME_WAKEUP,
                SystemClock.elapsedRealtime() + interval,
                pollIntent(appContext, PendingIntent.FLAG_UPDATE_CURRENT)
            );
        } catch (Exception error) {
            Log.w(TAG, "could not schedule the next mail check", error);
        }
    }

    private static boolean isAwake(Context context) {
        PowerManager power = context.getSystemService(PowerManager.class);
        return power != null && power.isInteractive();
    }

    private static PendingIntent pollIntent(Context context, int flags) {
        Intent intent = new Intent(context, MailyPushReceiver.class).setAction(ACTION_POLL);
        return PendingIntent.getBroadcast(
            context,
            REQUEST_CODE,
            intent,
            flags | PendingIntent.FLAG_IMMUTABLE
        );
    }
}

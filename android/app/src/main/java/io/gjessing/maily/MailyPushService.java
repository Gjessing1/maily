package io.gjessing.maily;

import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.NetworkRequest;
import android.os.Build;
import android.os.IBinder;
import android.util.Log;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.app.ServiceCompat;
import java.util.Random;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Holds Maily's push connection open — the APK's replacement for Firebase Cloud
 * Messaging.
 *
 * Why a foreground service at all. Android freezes and eventually kills a backgrounded
 * app, so something must hold an always-on socket for a notification to arrive while
 * Maily is closed. FCM works by having Google Play Services hold one socket for the whole
 * phone; the price is that every notification about this mailbox routes through Google,
 * needs a Firebase project and a service-account key on the server, and only works on
 * phones that ship Play Services. Maily already runs a server this phone can reach, so
 * the device holds the socket itself and no third party is involved. A foreground service
 * is the only way Android permits that, and its persistent notice is the honest cost —
 * kept at MIN importance so it sits silently in the shade (MailyPushNotifier).
 *
 * `specialUse` is the service type: `dataSync` is capped at six hours per day on Android
 * 15+, which would silently stop notifications every evening, and no other declared type
 * describes "keep a connection to the user's own mail server" (`remoteMessaging` is for
 * handing a conversation between devices). The type has no runtime cap; it only needs
 * justification for Play distribution, and this APK is installed directly.
 *
 * The loop is deliberately simple: connect, read until the connection dies, back off,
 * reconnect, forever. A dropped connection is the normal case on a phone, not an error.
 */
public class MailyPushService extends Service {
    private static final String TAG = "MailyPush";
    static final String ACTION_STOP = "io.gjessing.maily.PUSH_STOP";

    /** First retry delay. Short, because the common cause is a momentary network blip. */
    private static final long BACKOFF_MIN_MS = 3_000L;
    /** Retry ceiling. Long enough not to drain the battery against a server that is down. */
    private static final long BACKOFF_MAX_MS = 5 * 60_000L;

    private final AtomicBoolean running = new AtomicBoolean(false);
    private final Object wakeLock = new Object();
    private final Random jitter = new Random();
    private Thread worker;
    private ConnectivityManager.NetworkCallback networkCallback;
    private volatile boolean connected;
    /** Whether the attempt now finishing ever got a 200 — i.e. the drop was not a connect failure. */
    private volatile boolean reachedServer;

    /** Start the service if this device holds a push credential. Safe to call repeatedly. */
    static void startIfEnabled(Context context) {
        if (MailyPreferences.getPushToken(context) == null) return;
        if (MailyPreferences.getServerUrl(context) == null) return;
        Intent intent = new Intent(context, MailyPushService.class);
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent);
            } else {
                context.startService(intent);
            }
        } catch (Exception error) {
            // Android 12+ refuses a foreground-service start from the background outside a
            // handful of exemptions. Nothing is lost: opening Maily starts it, and that is
            // the next thing the user does anyway.
            Log.w(TAG, "could not start the push service from here", error);
        }
    }

    static void stop(Context context) {
        try {
            context.startService(new Intent(context, MailyPushService.class).setAction(ACTION_STOP));
        } catch (Exception ignored) {
            // Not running, or not startable from here — either way it is not running after.
        }
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            shutdown();
            return START_NOT_STICKY;
        }
        MailyPushNotifier.ensureChannels(this);
        promote();
        if (running.compareAndSet(false, true)) {
            watchNetwork();
            worker = new Thread(this::loop, "maily-push");
            worker.setDaemon(true);
            worker.start();
        }
        // The process can be killed under memory pressure; STICKY brings the service back
        // with a null intent, which is exactly the "just start reading again" case above.
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        shutdown();
        super.onDestroy();
    }

    /**
     * Put the service in the foreground. Called again on every state change because the
     * notification is the service's licence to run — replacing it is how its text is
     * updated, and dropping it would end the service.
     */
    private void promote() {
        try {
            ServiceCompat.startForeground(
                this,
                MailyPushNotifier.SERVICE_NOTIFICATION_ID,
                MailyPushNotifier.serviceNotification(this, connected),
                Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE
                    ? ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
                    : 0
            );
        } catch (Exception error) {
            Log.w(TAG, "could not enter the foreground", error);
        }
    }

    /** Reflect connected/reconnecting in the ongoing notice, without recreating it. */
    private void setConnected(boolean value) {
        if (connected == value) return;
        connected = value;
        try {
            NotificationManagerCompat.from(this).notify(
                MailyPushNotifier.SERVICE_NOTIFICATION_ID,
                MailyPushNotifier.serviceNotification(this, value)
            );
        } catch (SecurityException ignored) {
            // POST_NOTIFICATIONS revoked; the service keeps running with a stale notice.
        }
    }

    /**
     * The connect/read/backoff loop. Each pass blocks inside the reader for as long as
     * the connection lives, so the steady state is one thread parked on a socket read.
     */
    private void loop() {
        long backoff = BACKOFF_MIN_MS;
        while (running.get()) {
            String serverUrl = MailyPreferences.getServerUrl(this);
            String token = MailyPreferences.getPushToken(this);
            if (serverUrl == null || token == null) {
                // Notifications were turned off, or the server was reconfigured, while a
                // read was in flight.
                stopSelf();
                return;
            }

            reachedServer = false;
            MailyPushStream.Outcome outcome = MailyPushStream.read(
                serverUrl,
                token,
                running,
                new MailyPushStream.Listener() {
                    @Override
                    public void onConnected() {
                        reachedServer = true;
                        setConnected(true);
                    }

                    @Override
                    public void onMail(String messageId, String title, String body) {
                        MailyPushNotifier.postMail(MailyPushService.this, messageId, title, body);
                    }
                }
            );
            setConnected(false);

            if (outcome == MailyPushStream.Outcome.UNAUTHORIZED) {
                // The server no longer knows this credential — revoked from another
                // client, or the mailbox was reset. Retrying can only fail; drop it and
                // let the web app re-register the next time Maily is opened.
                MailyPreferences.setPushToken(this, null);
                stopSelf();
                return;
            }

            // Reset the backoff whenever the attempt actually reached the server, so a
            // stream that lived for hours and then dropped reconnects at once rather than
            // inheriting a ceiling-length delay from some earlier outage.
            backoff = reachedServer ? BACKOFF_MIN_MS : Math.min(backoff * 2, BACKOFF_MAX_MS);
            sleep(backoff);
        }
    }

    /**
     * Wait out a backoff, interruptible by a network becoming available — the difference
     * between reconnecting the instant Wi-Fi returns and sitting out the rest of a
     * five-minute delay. Jittered so a server restart does not meet every device at once.
     */
    private void sleep(long millis) {
        long delay = millis + jitter.nextInt((int) Math.max(1, millis / 5));
        synchronized (wakeLock) {
            try {
                wakeLock.wait(delay);
            } catch (InterruptedException ignored) {
                Thread.currentThread().interrupt();
            }
        }
    }

    /** Cut a pending backoff short. */
    private void wake() {
        synchronized (wakeLock) {
            wakeLock.notifyAll();
        }
    }

    /**
     * Reconnect as soon as the phone has a usable network again. Without this the loop
     * would keep failing on its own schedule while the connection has been back for
     * minutes — the single most visible symptom of a hand-rolled push transport.
     */
    private void watchNetwork() {
        ConnectivityManager manager = getSystemService(ConnectivityManager.class);
        if (manager == null) return;
        networkCallback = new ConnectivityManager.NetworkCallback() {
            @Override
            public void onAvailable(Network network) {
                wake();
            }
        };
        try {
            manager.registerNetworkCallback(
                new NetworkRequest.Builder()
                    .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                    .build(),
                networkCallback
            );
        } catch (Exception error) {
            Log.w(TAG, "could not watch for network changes", error);
            networkCallback = null;
        }
    }

    private void shutdown() {
        if (!running.compareAndSet(true, false)) return;
        wake();
        if (worker != null) worker.interrupt();
        ConnectivityManager manager = getSystemService(ConnectivityManager.class);
        if (manager != null && networkCallback != null) {
            try {
                manager.unregisterNetworkCallback(networkCallback);
            } catch (Exception ignored) {
                // Already unregistered.
            }
        }
        networkCallback = null;
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE);
        stopSelf();
    }
}

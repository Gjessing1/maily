package io.gjessing.maily;

import android.Manifest;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.res.Configuration;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.util.Log;
import android.view.Window;
import androidx.core.content.pm.PackageInfoCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.PermissionState;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import com.google.firebase.messaging.FirebaseMessaging;

@CapacitorPlugin(
    name = "MailyNative",
    permissions = {
        @Permission(alias = MailyNativePlugin.NOTIFICATIONS, strings = { Manifest.permission.POST_NOTIFICATIONS })
    }
)
public class MailyNativePlugin extends Plugin {
    static final String NOTIFICATIONS = "notifications";
    private static final String PLUGIN_TAG = "MailyNative";
    private MailyNavigation navigation;
    private Integer systemBarsColor;

    @Override
    public void load() {
        String serverUrl = MailyPreferences.getServerUrl(getContext());
        if (serverUrl != null) navigation = new MailyNavigation(serverUrl);
    }

    @Override
    public Boolean shouldOverrideLoad(Uri url) {
        return navigation != null && navigation.shouldAllow(url) ? false : null;
    }

    @PluginMethod
    public void getInfo(PluginCall call) {
        try {
            PackageInfo info = getContext().getPackageManager().getPackageInfo(getContext().getPackageName(), 0);
            JSObject result = new JSObject();
            result.put("serverUrl", MailyPreferences.getServerUrl(getContext()));
            result.put("versionName", info.versionName == null ? "" : info.versionName);
            result.put("versionCode", PackageInfoCompat.getLongVersionCode(info));
            call.resolve(result);
        } catch (Exception error) {
            call.reject("Could not read app information", error);
        }
    }

    @PluginMethod
    public void configureServer(PluginCall call) {
        String normalized = MailyPreferences.normalizeServerUrl(call.getString("serverUrl"));
        if (normalized == null) {
            call.reject("Enter a root HTTPS URL, for example https://mail.gjessing.io");
            return;
        }
        MailyPreferences.setServerUrl(getContext(), normalized);
        call.resolve();
        getActivity().runOnUiThread(() -> getActivity().recreate());
    }

    /**
     * Paint whatever sits behind the system bars in the web app's own background
     * colour, so the status bar reads as part of Maily rather than a leftover strip
     * of the launch theme. What that "whatever" is depends on the release:
     *
     * - Android 15+ with WebView 140 or newer: the WebView itself draws under the
     *   bars, so nothing here is visible — but the call still costs nothing.
     * - Android 15+ with an older WebView, or any page without `viewport-fit=cover`
     *   (the SSO detour): Capacitor insets the WebView instead, and the strip that
     *   leaves behind shows the *decor* background.
     * - Below Android 15: the bars are opaque and keep the launch theme's colour.
     *
     * The icon appearance — what actually keeps the clock, wifi and battery visible —
     * is set by the web app through Capacitor's SystemBars plugin just before this.
     * That plugin repaints the decor background from the theme on every style change,
     * so this must run after it, and again whenever it re-applies itself.
     */
    @PluginMethod
    public void setSystemBarsColor(PluginCall call) {
        String raw = call.getString("color");
        final int color;
        try {
            color = Color.parseColor(raw == null ? "" : raw.trim());
        } catch (IllegalArgumentException error) {
            call.reject("Expected an #rrggbb colour, got: " + raw);
            return;
        }
        systemBarsColor = color;
        getActivity().runOnUiThread(this::paintSystemBars);
        call.resolve();
    }

    @Override
    protected void handleOnConfigurationChanged(Configuration newConfig) {
        super.handleOnConfigurationChanged(newConfig);
        // SystemBars re-applies its style here, which resets the decor background to
        // the theme's. Restore the colour the web app asked for — a device night-mode
        // flip does not change an explicitly chosen in-app theme, so nothing else would.
        paintSystemBars();
    }

    @SuppressWarnings("deprecation")
    private void paintSystemBars() {
        if (systemBarsColor == null || getActivity() == null) return;
        int color = systemBarsColor;
        Window window = getActivity().getWindow();
        window.getDecorView().setBackgroundColor(color);
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.VANILLA_ICE_CREAM) {
            window.setStatusBarColor(color);
            // Before Android 8.1 the gesture/button icons are always white, so a light
            // navigation bar would swallow them; leave it at the system dark.
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
                window.setNavigationBarColor(color);
            }
        }
    }

    /**
     * Register this device with FCM and hand the token back to the web app, which posts
     * it to the Maily server over its own authenticated session.
     *
     * A resolved *method call*, deliberately — not a Capacitor event. Maily is served
     * from a remote origin, where plugin listener registration never takes hold (the
     * same trap that once broke Android Back), so the `registration` event the standard
     * push plugin delivers its token through would never arrive. Asking and answering in
     * one promise depends on nothing but the bridge call that is already working.
     *
     * Resolves {granted, token}: granted=false when the user declined the Android 13+
     * runtime permission, token=null when the APK carries no google-services.json (the
     * Firebase SDK has no project to register against). Never rejects for either — those
     * are states the web app explains, not errors.
     */
    @PluginMethod
    public void getPushToken(PluginCall call) {
        if (getPermissionState(NOTIFICATIONS) == PermissionState.GRANTED) {
            resolvePushToken(call);
            return;
        }
        // Below Android 13 notifications need no runtime grant, so the state above is
        // already GRANTED there and this only runs on 13+.
        requestPermissionForAlias(NOTIFICATIONS, call, "pushPermissionCallback");
    }

    @PermissionCallback
    private void pushPermissionCallback(PluginCall call) {
        if (getPermissionState(NOTIFICATIONS) != PermissionState.GRANTED) {
            JSObject result = new JSObject();
            result.put("granted", false);
            result.put("token", (String) null);
            call.resolve(result);
            return;
        }
        resolvePushToken(call);
    }

    /**
     * Fetch the FCM registration token. The channel is created first: Android 8+ drops a
     * notification whose channel id was never registered, and the id here is the one the
     * manifest hands Firebase as `default_notification_channel_id`.
     */
    private void resolvePushToken(PluginCall call) {
        ensureMailNotificationChannel();
        try {
            FirebaseMessaging.getInstance()
                .getToken()
                .addOnCompleteListener(task -> {
                    JSObject result = new JSObject();
                    result.put("granted", true);
                    if (task.isSuccessful()) {
                        result.put("token", task.getResult());
                    } else {
                        Log.w(PLUGIN_TAG, "FCM token request failed", task.getException());
                        result.put("token", (String) null);
                    }
                    call.resolve(result);
                });
        } catch (Exception error) {
            // No google-services.json in this build: FirebaseApp was never initialized.
            Log.w(PLUGIN_TAG, "Firebase is not configured in this build", error);
            JSObject result = new JSObject();
            result.put("granted", true);
            result.put("token", (String) null);
            call.resolve(result);
        }
    }

    /** Drop this device's FCM registration — the app-side half of turning notifications off. */
    @PluginMethod
    public void clearPushToken(PluginCall call) {
        try {
            FirebaseMessaging.getInstance()
                .deleteToken()
                .addOnCompleteListener(task -> call.resolve());
        } catch (Exception error) {
            // Never configured, so there is nothing to delete — the goal state is reached.
            Log.w(PLUGIN_TAG, "Firebase is not configured in this build", error);
            call.resolve();
        }
    }

    private void ensureMailNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = getContext().getSystemService(NotificationManager.class);
        if (manager == null) return;
        NotificationChannel channel = new NotificationChannel(
            getContext().getString(R.string.mail_notification_channel_id),
            getContext().getString(R.string.mail_notification_channel_name),
            NotificationManager.IMPORTANCE_DEFAULT
        );
        channel.setDescription(getContext().getString(R.string.mail_notification_channel_description));
        // Creating an existing channel is a no-op, so this is safe on every call.
        manager.createNotificationChannel(channel);
    }

    @PluginMethod
    public void openExternal(PluginCall call) {
        String raw = call.getString("url");
        Uri uri = raw == null ? null : Uri.parse(raw);
        if (uri == null || (!"https".equals(uri.getScheme()) && !"http".equals(uri.getScheme()))) {
            call.reject("Only HTTP(S) links can be opened");
            return;
        }
        try {
            getContext().startActivity(new Intent(Intent.ACTION_VIEW, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            call.resolve();
        } catch (Exception error) {
            call.reject("No app can open this link", error);
        }
    }
}

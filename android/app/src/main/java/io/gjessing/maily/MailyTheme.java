package io.gjessing.maily;

import android.content.res.Configuration;
import com.getcapacitor.Bridge;

/**
 * Tells the running page which light/dark mode the device is in.
 *
 * The web app resolves "follow the system" from `prefers-color-scheme` (state/theme.ts),
 * and inside the APK that query is not something to rely on. MainActivity declares
 * {@code uiMode} in {@code android:configChanges}, so Android never recreates it when the
 * device flips — deliberately, because a recreate reloads the WebView, discarding the
 * app's state and re-running the SSO handshake. What the WebView then does with the media
 * query for an already-loaded page is the WebView's business: it went unreported on the
 * device this was raised from, where the app kept the theme it launched in until it was
 * force-closed, while WebView 133 on an emulator fires the change event on the spot.
 * Reporting the mode ourselves removes the difference.
 *
 * The ask is an evaluation of {@code window.mailySystemTheme(…)} — the same
 * remote-origin-safe global channel Back and notification opens use, and for the same
 * reason: Maily is served from a remote origin, where a Capacitor listener would never
 * have registered. A page that installs nothing (the SSO detour, the connection-error
 * page, a WebView whose JS has not booted) simply ignores it.
 */
final class MailyTheme {
    private MailyTheme() {}

    /** The theme name for a configuration's {@code uiMode}, as the web app names it. */
    static String themeName(int uiMode) {
        return (uiMode & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES
            ? "dark"
            : "light";
    }

    /** The ask, written so a page without the global is a no-op rather than an error. */
    static String script(String theme) {
        return "window.mailySystemTheme && window.mailySystemTheme('" + theme + "')";
    }

    /** Tell the running page which mode the device is in now. */
    static void tell(Bridge bridge, int uiMode) {
        if (bridge == null) return;
        bridge.eval(script(themeName(uiMode)), null);
    }
}

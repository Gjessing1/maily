package io.gjessing.maily;

import android.content.Intent;
import android.text.TextUtils;
import com.getcapacitor.Bridge;

/**
 * Opens the message a tapped FCM notification refers to.
 *
 * Firebase's own service posts the notification while Maily is backgrounded or killed,
 * and Android launches MainActivity with the message's `data` payload copied into the
 * intent extras. Two arrival shapes, handled differently:
 *
 * - **Cold start** — the WebView has not loaded anything yet, so the deep link simply
 *   becomes the URL it starts on. Nothing to coordinate with.
 * - **Warm start** — a document is already showing, and reloading it would throw away
 *   the app's state (and re-run the SSO handshake). The page is asked to route itself
 *   instead, by evaluating {@code window.mailyOpenMessage(id)} — the same
 *   remote-origin-safe global channel Back uses, for the same reason: a Capacitor
 *   listener would never have registered. A page that does not answer true (the SSO
 *   detour, the error page, JS not booted) falls back to a plain load.
 */
final class MailyNotificationLink {
    /** FCM data key carrying Maily's internal message UUID (backend push/fcm.ts). */
    private static final String MESSAGE_ID_EXTRA = "messageId";

    private MailyNotificationLink() {}

    /** The message id a launch intent points at, or null when it is an ordinary launch. */
    static String messageIdFrom(Intent intent) {
        if (intent == null || intent.getExtras() == null) return null;
        Object raw = intent.getExtras().get(MESSAGE_ID_EXTRA);
        if (!(raw instanceof String)) return null;
        String id = ((String) raw).trim();
        // Only ever a UUID from our own backend; refuse anything that could steer the
        // WebView somewhere else if the extra were ever attacker-supplied.
        return id.matches("[0-9a-fA-F-]{36}") ? id : null;
    }

    /** The in-app URL for a message, on the server this install is configured against. */
    static String urlFor(String serverUrl, String messageId) {
        if (TextUtils.isEmpty(serverUrl)) return null;
        return serverUrl.replaceAll("/+$", "") + "/m/" + messageId;
    }

    /** Route an already-running WebView to the message, falling back to a load. */
    static void openInRunningApp(Bridge bridge, String serverUrl, String messageId) {
        String url = urlFor(serverUrl, messageId);
        if (bridge == null || url == null) return;
        String ask = "window.mailyOpenMessage ? window.mailyOpenMessage('" + messageId + "') : null";
        bridge.eval(ask, value -> {
            if (!"true".equals(value)) bridge.getWebView().loadUrl(url);
        });
    }
}

package io.gjessing.maily;

import android.content.Intent;
import com.getcapacitor.Bridge;
import java.io.UnsupportedEncodingException;
import java.net.URLEncoder;
import org.json.JSONObject;

/**
 * Starts a message from outside the app: a {@code mailto:} link tapped anywhere on the
 * device, or text shared to Maily. These intent filters (see the manifest) are what let
 * Android offer Maily as the mail app and remember it under "Always".
 *
 * Every shape is reduced to one {@code mailto:} URL, because that is what the web
 * composer already parses ({@code /compose?mailto=…}):
 *
 * - {@code ACTION_VIEW} / {@code ACTION_SENDTO} on a {@code mailto:} URI — the link
 *   itself, plus the subject/text/recipient extras apps commonly send beside a bare
 *   {@code mailto:}.
 * - {@code ACTION_SEND} of {@code text/plain} — the extras alone.
 *
 * Arrival mirrors {@link MailyNotificationLink}: a cold start loads the composer URL, a
 * running app is asked to route itself ({@code window.mailyOpenCompose}) and only
 * reloaded if it does not answer. Nothing here sends mail; it fills a draft the user
 * reviews. Shared files are not handled — only text.
 */
final class MailyComposeLink {
    /** Shared text can be arbitrarily long; the composer URL should not be. */
    static final int MAX_BODY_CHARS = 20000;

    private MailyComposeLink() {}

    /** The {@code mailto:} URL a launch intent asks for, or null when it asks for none. */
    static String mailtoFrom(Intent intent) {
        if (intent == null) return null;
        // Reopened from Recents: Android redelivers the original intent, and the
        // message it asked for was started (or abandoned) long ago.
        if ((intent.getFlags() & Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) != 0) return null;
        CharSequence text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT);
        return mailtoFor(
            intent.getAction(),
            intent.getDataString(),
            intent.getStringArrayExtra(Intent.EXTRA_EMAIL),
            intent.getStringArrayExtra(Intent.EXTRA_CC),
            intent.getStringExtra(Intent.EXTRA_SUBJECT),
            text == null ? null : text.toString()
        );
    }

    /** {@link #mailtoFrom} on plain values, so it can be tested off-device. */
    static String mailtoFor(String action, String data, String[] to, String[] cc, String subject, String text) {
        String base;
        if (Intent.ACTION_VIEW.equals(action) || Intent.ACTION_SENDTO.equals(action)) {
            if (data == null || !data.regionMatches(true, 0, "mailto:", 0, 7)) return null;
            base = data;
        } else if (Intent.ACTION_SEND.equals(action)) {
            base = "mailto:";
        } else {
            return null;
        }

        StringBuilder mailto = new StringBuilder(base);
        boolean hasQuery = base.indexOf('?') >= 0;
        String query = hasQuery ? base.substring(base.indexOf('?') + 1).toLowerCase() : "";
        hasQuery = append(mailto, hasQuery, "to", join(to));
        hasQuery = append(mailto, hasQuery, "cc", join(cc));
        // The link's own subject/body win over extras: they are what the user tapped.
        if (!hasParameter(query, "subject")) hasQuery = append(mailto, hasQuery, "subject", subject);
        if (!hasParameter(query, "body")) {
            String body = text != null && text.length() > MAX_BODY_CHARS ? text.substring(0, MAX_BODY_CHARS) : text;
            append(mailto, hasQuery, "body", body);
        }
        // A share that carried nothing usable is not worth opening a blank composer for.
        return mailto.length() == "mailto:".length() && Intent.ACTION_SEND.equals(action) ? null : mailto.toString();
    }

    /** The composer URL for a {@code mailto:}, on the server this install is configured against. */
    static String urlFor(String serverUrl, String mailto) {
        if (serverUrl == null || serverUrl.isEmpty() || mailto == null) return null;
        return serverUrl.replaceAll("/+$", "") + "/compose?mailto=" + encode(mailto);
    }

    /** Route an already-running WebView to the composer, falling back to a load. */
    static void openInRunningApp(Bridge bridge, String serverUrl, String mailto) {
        String url = urlFor(serverUrl, mailto);
        if (bridge == null || url == null) return;
        // The mailto is attacker-influenced text going into a script: quote it as a JSON
        // string literal, never by concatenating between quotes.
        String ask = "window.mailyOpenCompose ? window.mailyOpenCompose(" + JSONObject.quote(mailto) + ") : null";
        bridge.eval(ask, value -> {
            if (!"true".equals(value)) bridge.getWebView().loadUrl(url);
        });
    }

    private static boolean hasParameter(String lowerCaseQuery, String name) {
        return lowerCaseQuery.startsWith(name + "=") || lowerCaseQuery.contains("&" + name + "=");
    }

    private static boolean append(StringBuilder mailto, boolean hasQuery, String name, String value) {
        if (value == null || value.trim().isEmpty()) return hasQuery;
        mailto.append(hasQuery ? '&' : '?').append(name).append('=').append(encode(value));
        return true;
    }

    private static String join(String[] addresses) {
        if (addresses == null) return null;
        StringBuilder joined = new StringBuilder();
        for (String address : addresses) {
            if (address == null || address.trim().isEmpty()) continue;
            if (joined.length() > 0) joined.append(',');
            joined.append(address.trim());
        }
        return joined.toString();
    }

    /** Percent-encode one query value ({@code %20}, not {@code +}, for a space). */
    private static String encode(String value) {
        try {
            return URLEncoder.encode(value, "UTF-8").replace("+", "%20");
        } catch (UnsupportedEncodingException impossible) {
            throw new IllegalStateException(impossible);
        }
    }
}

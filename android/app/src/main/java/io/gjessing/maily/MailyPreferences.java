package io.gjessing.maily;

import android.content.Context;
import android.content.SharedPreferences;
import java.net.URI;

final class MailyPreferences {
    private static final String PREFS = "maily_native";
    private static final String SERVER_URL = "server_url";
    private static final String PUSH_TOKEN = "push_token";

    private MailyPreferences() {}

    /**
     * The push credential this device presents on Maily's notification stream, or null
     * when notifications are off here.
     *
     * App-private SharedPreferences rather than EncryptedSharedPreferences: on a
     * non-rooted device the app sandbox already keeps this out of every other app's
     * reach, the secret grants nothing beyond a feed of incoming subject lines, and it
     * is revocable from Maily Settings the moment the phone is lost. Encrypting it here
     * would mostly move the problem to the Keystore-backed key protecting it.
     */
    static String getPushToken(Context context) {
        String value = prefs(context).getString(PUSH_TOKEN, null);
        return value == null || value.isBlank() ? null : value;
    }

    /** Store (or, with null, forget) the push credential. */
    static void setPushToken(Context context, String token) {
        SharedPreferences.Editor editor = prefs(context).edit();
        if (token == null || token.isBlank()) editor.remove(PUSH_TOKEN);
        else editor.putString(PUSH_TOKEN, token.trim());
        editor.apply();
    }

    static String getServerUrl(Context context) {
        String value = prefs(context).getString(SERVER_URL, null);
        return normalizeServerUrl(value);
    }

    static void setServerUrl(Context context, String serverUrl) {
        String normalized = normalizeServerUrl(serverUrl);
        if (normalized == null) throw new IllegalArgumentException("Invalid Maily server URL");
        prefs(context).edit().putString(SERVER_URL, normalized).apply();
    }

    static String normalizeServerUrl(String raw) {
        if (raw == null || raw.isBlank()) return null;
        try {
            URI uri = new URI(raw.trim());
            String path = uri.getRawPath();
            if (!"https".equalsIgnoreCase(uri.getScheme()) ||
                uri.getHost() == null ||
                uri.getUserInfo() != null ||
                uri.getRawQuery() != null ||
                uri.getRawFragment() != null ||
                (path != null && !path.isEmpty() && !"/".equals(path))) {
                return null;
            }
            return new URI("https", null, uri.getHost(), uri.getPort(), null, null, null).toASCIIString();
        } catch (Exception ignored) {
            return null;
        }
    }

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }
}

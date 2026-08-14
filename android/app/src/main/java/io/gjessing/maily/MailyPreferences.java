package io.gjessing.maily;

import android.content.Context;
import android.content.SharedPreferences;
import java.net.URI;

final class MailyPreferences {
    private static final String PREFS = "maily_native";
    private static final String SERVER_URL = "server_url";

    private MailyPreferences() {}

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

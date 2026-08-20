package io.gjessing.maily;

import android.util.Log;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import javax.net.ssl.HttpsURLConnection;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Asks Maily what this device has missed: one short authenticated GET, parsed, closed.
 *
 * Written against {@link HttpURLConnection} rather than a client library — a single JSON
 * GET needs no dependency, and the same reasoning kept the backend's notification sender
 * off vendor SDKs.
 *
 * The request runs inside a broadcast receiver's `goAsync` window, so both timeouts are
 * deliberately short: a server that is unreachable must fail fast and leave the retry to
 * the next alarm rather than hold the process awake waiting for it.
 */
final class MailyPushPoll {
    private static final String TAG = "MailyPush";
    private static final int CONNECT_TIMEOUT_MS = 15_000;
    private static final int READ_TIMEOUT_MS = 15_000;

    /** What the poll saw, which decides whether the device keeps its credential. */
    enum Status {
        /** The answer was read — {@link Result#mail} holds it, possibly empty. */
        OK,
        /** Offline, server down, or a transient error. The next alarm retries. */
        UNAVAILABLE,
        /** The server does not know this credential. Retrying cannot help. */
        UNAUTHORIZED,
    }

    static final class Mail {
        final String messageId;
        final String title;
        final String body;

        Mail(String messageId, String title, String body) {
            this.messageId = messageId;
            this.title = title;
            this.body = body;
        }
    }

    static final class Result {
        final Status status;
        final List<Mail> mail;

        Result(Status status, List<Mail> mail) {
            this.status = status;
            this.mail = mail;
        }
    }

    private MailyPushPoll() {}

    /** Blocking. The caller owns the thread. */
    static Result fetch(String serverUrl, String token) {
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(serverUrl + "/api/push/pending").openConnection();
            if (!(connection instanceof HttpsURLConnection)) {
                // MailyPreferences only ever stores https URLs; this is belt-and-braces
                // against a credential ever being sent in the clear.
                Log.w(TAG, "refusing to send the push credential over a non-HTTPS connection");
                return new Result(Status.UNAUTHORIZED, List.of());
            }
            connection.setRequestMethod("GET");
            connection.setRequestProperty("Authorization", "Bearer " + token);
            connection.setRequestProperty("Accept", "application/json");
            connection.setConnectTimeout(CONNECT_TIMEOUT_MS);
            connection.setReadTimeout(READ_TIMEOUT_MS);
            connection.setUseCaches(false);
            // A 302 here is the SSO gateway offering a login page, which is a failure to
            // report rather than an HTML body to chase.
            connection.setInstanceFollowRedirects(false);

            int status = connection.getResponseCode();
            if (status == HttpURLConnection.HTTP_UNAUTHORIZED
                || status == HttpURLConnection.HTTP_FORBIDDEN) {
                Log.w(TAG, "the server rejected this device's credential (" + status + ")");
                return new Result(Status.UNAUTHORIZED, List.of());
            }
            if (status != HttpURLConnection.HTTP_OK) {
                Log.d(TAG, "push poll returned " + status);
                return new Result(Status.UNAVAILABLE, List.of());
            }

            StringBuilder body = new StringBuilder();
            try (BufferedReader reader = new BufferedReader(
                new InputStreamReader(connection.getInputStream(), StandardCharsets.UTF_8))) {
                String line;
                while ((line = reader.readLine()) != null) body.append(line);
            }
            return new Result(Status.OK, parse(body.toString()));
        } catch (Exception error) {
            // Offline, DNS failure, timeout: all ordinary on a phone, none exceptional.
            Log.d(TAG, "push poll failed: " + error);
            return new Result(Status.UNAVAILABLE, List.of());
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    /**
     * Read the `mail` array out of the response.
     *
     * Package-private so it can be exercised off-device: the parse is where a silent
     * break costs a missed notification rather than a crash.
     */
    static List<Mail> parse(String json) {
        List<Mail> mail = new ArrayList<>();
        try {
            JSONArray items = new JSONObject(json).optJSONArray("mail");
            if (items == null) return mail;
            for (int i = 0; i < items.length(); i++) {
                JSONObject item = items.optJSONObject(i);
                if (item == null) continue;
                String messageId = item.optString("messageId", "");
                if (messageId.isEmpty()) continue;
                mail.add(new Mail(
                    messageId,
                    item.optString("title", "New mail"),
                    item.optString("body", "")
                ));
            }
        } catch (Exception error) {
            Log.w(TAG, "unreadable push response", error);
        }
        return mail;
    }
}

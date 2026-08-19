package io.gjessing.maily;

import android.util.Log;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.atomic.AtomicBoolean;
import javax.net.ssl.HttpsURLConnection;
import org.json.JSONObject;

/**
 * Reads Maily's Server-Sent Events push stream: one blocking connection, held open for
 * as long as the phone will allow, reconnected forever.
 *
 * Written against {@link HttpURLConnection} rather than a client library. SSE is a plain
 * chunked GET whose body is line-oriented text, the reconnect policy is ours regardless,
 * and the whole read loop is a hundred lines — the same reasoning that kept the backend's
 * old FCM sender off the Firebase Admin SDK. Nothing here needs a dependency.
 *
 * The two timeouts do different jobs and both matter:
 *
 * - **connect** bounds a server that is down or a captive portal that black-holes us.
 * - **read** is the dead-socket detector. The server sends a heartbeat comment every 25s,
 *   so silence past this timeout means the connection died in a way TCP has not noticed
 *   — the usual outcome of a phone moving between networks, where the socket is simply
 *   gone and no FIN ever arrives.
 */
final class MailyPushStream {
    private static final String TAG = "MailyPush";
    private static final int CONNECT_TIMEOUT_MS = 20_000;
    /** Comfortably past the server's 25s heartbeat, without waiting minutes on a dead link. */
    private static final int READ_TIMEOUT_MS = 70_000;

    /** What the reader saw, which decides whether (and how soon) to reconnect. */
    enum Outcome {
        /** The connection ended normally or died — retry after a backoff. */
        DISCONNECTED,
        /** The server rejected the credential. Retrying cannot help; the app must re-register. */
        UNAUTHORIZED,
    }

    interface Listener {
        void onMail(String messageId, String title, String body);

        void onConnected();
    }

    private MailyPushStream() {}

    /**
     * Connect and read until the stream ends, the socket dies, or {@code running} clears.
     * Blocking: the caller owns the thread and the retry loop.
     */
    static Outcome read(String serverUrl, String token, AtomicBoolean running, Listener listener) {
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(serverUrl + "/api/push/stream").openConnection();
            if (!(connection instanceof HttpsURLConnection)) {
                // MailyPreferences only ever stores https URLs; this is belt-and-braces
                // against a credential ever being sent in the clear.
                Log.w(TAG, "refusing to send the push credential over a non-HTTPS connection");
                return Outcome.UNAUTHORIZED;
            }
            connection.setRequestMethod("GET");
            connection.setRequestProperty("Authorization", "Bearer " + token);
            connection.setRequestProperty("Accept", "text/event-stream");
            // An intermediary that gzips the stream would buffer it, and a buffered SSE
            // stream delivers nothing until the buffer fills.
            connection.setRequestProperty("Accept-Encoding", "identity");
            connection.setConnectTimeout(CONNECT_TIMEOUT_MS);
            connection.setReadTimeout(READ_TIMEOUT_MS);
            connection.setUseCaches(false);

            int status = connection.getResponseCode();
            if (status == HttpURLConnection.HTTP_UNAUTHORIZED
                || status == HttpURLConnection.HTTP_FORBIDDEN) {
                Log.w(TAG, "push stream rejected the device credential (" + status + ")");
                return Outcome.UNAUTHORIZED;
            }
            if (status != HttpURLConnection.HTTP_OK) {
                Log.w(TAG, "push stream returned " + status);
                return Outcome.DISCONNECTED;
            }

            listener.onConnected();
            try (BufferedReader reader = new BufferedReader(
                new InputStreamReader(connection.getInputStream(), StandardCharsets.UTF_8))) {
                consume(reader, running, listener);
            }
            return Outcome.DISCONNECTED;
        } catch (Exception error) {
            // Every disconnect arrives here: read timeout, network loss, server restart.
            // None of them are exceptional enough to log above debug.
            Log.d(TAG, "push stream ended: " + error);
            return Outcome.DISCONNECTED;
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    /**
     * The SSE frame reader. Only what Maily sends is understood: a `data:` line carrying
     * one JSON object per event, terminated by a blank line. Comments (`:` lines) are the
     * heartbeat and are skipped — reading them is the point, not what they contain.
     *
     * Package-private so it can be exercised over a plain reader in unit tests; the
     * parse is where a silent break would cost a missed notification rather than a crash.
     */
    static void consume(BufferedReader reader, AtomicBoolean running, Listener listener)
        throws Exception {
        String line;
        StringBuilder data = new StringBuilder();
        while (running.get() && (line = reader.readLine()) != null) {
            if (line.isEmpty()) {
                if (data.length() > 0) {
                    dispatch(data.toString(), listener);
                    data.setLength(0);
                }
                continue;
            }
            if (line.startsWith(":")) continue;
            if (line.startsWith("data:")) data.append(line.substring(5).trim());
        }
    }

    private static void dispatch(String json, Listener listener) {
        try {
            JSONObject payload = new JSONObject(json);
            String messageId = payload.optString("messageId", "");
            if (messageId.isEmpty()) return;
            listener.onMail(
                messageId,
                payload.optString("title", "New mail"),
                payload.optString("body", "")
            );
        } catch (Exception error) {
            Log.w(TAG, "unreadable push event", error);
        }
    }
}

package io.gjessing.maily;

import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInstaller;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.regex.Pattern;

/**
 * In-app APK updates: download the published APK, refuse it unless its size and SHA-256 match
 * the release manifest, and hand it to Android's package installer. Android itself refuses an APK
 * for another package or signed with another key, so a bad download can only fail the update,
 * never install something else. The installer's answer arrives at {@link AppUpdateReceiver}.
 */
final class AppUpdater {
    /** Far above any plausible APK of this app, so a broken manifest can't fill the disk. */
    static final long MAX_APK_BYTES = 300L * 1024 * 1024;

    private static final Pattern SHA256_HEX = Pattern.compile("^[0-9a-f]{64}$");
    private static final int TIMEOUT_MILLIS = 15_000;
    private static final String APK_NAME = "update.apk";

    /** A failed update, with the code the web layer shows a message for. */
    static final class UpdateException extends Exception {
        final String code;

        UpdateException(String code, String message) {
            super(message);
            this.code = code;
        }
    }

    // What the page polls through updateStatus. Polled rather than pushed as Capacitor events,
    // because listener registration doesn't reliably take hold on a remote-origin page, while a
    // resolved method call always does.
    private static volatile long copiedBytes;
    private static volatile long totalBytes;
    private static volatile String installResult;

    private final Context context;

    AppUpdater(Context context) {
        this.context = context.getApplicationContext();
    }

    /** status is "success", "cancelled" or "failed". From {@link AppUpdateReceiver}. */
    static void recordInstallResult(String status) {
        installResult = status;
    }

    static long copiedBytes() {
        return copiedBytes;
    }

    static long totalBytes() {
        return totalBytes;
    }

    /** Null until the installer has answered the current update. */
    static String installResult() {
        return installResult;
    }

    static boolean isValidSha256(String value) {
        return value != null && SHA256_HEX.matcher(value).matches();
    }

    /** Android 8+ asks the user once to let an app install other apps (or update itself). */
    boolean canInstall() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return true;
        return context.getPackageManager().canRequestPackageInstalls();
    }

    Intent installPermissionSettings() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return new Intent(Settings.ACTION_SECURITY_SETTINGS);
        return new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + context.getPackageName()));
    }

    /**
     * Downloads {@code url} straight into an installer session and commits it only if it verifies.
     * Blocking: call it off the main thread. Returns once the system has the APK; its "do you want
     * to update?" prompt follows.
     */
    void downloadAndInstall(String url, String sha256, long bytes, String cookie) throws UpdateException {
        copiedBytes = 0;
        totalBytes = bytes;
        installResult = null;
        PackageInstaller installer = context.getPackageManager().getPackageInstaller();
        PackageInstaller.SessionParams params = new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
        // The session refuses an APK for any other package.
        params.setAppPackageName(context.getPackageName());
        params.setSize(bytes);
        int sessionId;
        try {
            sessionId = installer.createSession(params);
        } catch (IOException | SecurityException error) {
            throw new UpdateException("installer", "Android refused to start the install: " + error.getMessage());
        }
        boolean committed = false;
        try (PackageInstaller.Session session = installer.openSession(sessionId)) {
            HttpURLConnection connection = open(url, cookie);
            try (InputStream input = connection.getInputStream(); OutputStream output = session.openWrite(APK_NAME, 0, bytes)) {
                copyVerified(input, output, bytes, sha256);
                session.fsync(output);
            } finally {
                connection.disconnect();
            }
            session.commit(resultCallback(sessionId).getIntentSender());
            committed = true;
        } catch (IOException error) {
            throw new UpdateException("download", "The download failed: " + error.getMessage());
        } catch (SecurityException error) {
            throw new UpdateException("installer", "Android refused the install: " + error.getMessage());
        } finally {
            if (!committed) abandon(installer, sessionId);
        }
    }

    private static void abandon(PackageInstaller installer, int sessionId) {
        try {
            installer.abandonSession(sessionId);
        } catch (SecurityException ignored) {
            // Already gone.
        }
    }

    private static HttpURLConnection open(String url, String cookie) throws IOException {
        HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
        connection.setConnectTimeout(TIMEOUT_MILLIS);
        connection.setReadTimeout(TIMEOUT_MILLIS);
        connection.setUseCaches(false);
        // A redirect is an SSO login page or a moved file; either way it isn't the release, and
        // following it could leave the app's own server.
        connection.setInstanceFollowRedirects(false);
        if (cookie != null) connection.setRequestProperty("Cookie", cookie);
        int code = connection.getResponseCode();
        if (code != HttpURLConnection.HTTP_OK) {
            connection.disconnect();
            throw new IOException("HTTP " + code);
        }
        return connection;
    }

    /**
     * Copies while hashing, and fails unless the copy is exactly {@code expectedBytes} long with
     * the expected SHA-256. It stops reading past {@code expectedBytes}, so a wrong response can't
     * grow without bound.
     */
    private static void copyVerified(InputStream input, OutputStream output, long expectedBytes, String expectedSha256)
        throws IOException, UpdateException {
        MessageDigest digest;
        try {
            digest = MessageDigest.getInstance("SHA-256");
        } catch (NoSuchAlgorithmException error) {
            throw new IllegalStateException(error);
        }
        byte[] buffer = new byte[64 * 1024];
        long copied = 0;
        while (true) {
            int read = input.read(buffer);
            if (read < 0) break;
            copied += read;
            if (copied > expectedBytes) {
                throw new UpdateException("verification", "The download is larger than the release");
            }
            digest.update(buffer, 0, read);
            output.write(buffer, 0, read);
            copiedBytes = copied;
        }
        if (copied != expectedBytes) {
            throw new UpdateException("verification", "The download is shorter than the release");
        }
        if (!toHex(digest.digest()).equals(expectedSha256)) {
            throw new UpdateException("verification", "The download doesn't match the release");
        }
    }

    private static String toHex(byte[] bytes) {
        StringBuilder hex = new StringBuilder(bytes.length * 2);
        for (byte b : bytes) {
            hex.append(Character.forDigit((b >> 4) & 0xf, 16));
            hex.append(Character.forDigit(b & 0xf, 16));
        }
        return hex.toString();
    }

    private PendingIntent resultCallback(int sessionId) {
        Intent intent = new Intent(context, AppUpdateReceiver.class);
        // The installer adds the status extras, so the intent has to be mutable on Android 12+.
        // It's explicit (our own non-exported receiver), so nobody else can fill it in.
        int mutability = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S ? PendingIntent.FLAG_MUTABLE : 0;
        return PendingIntent.getBroadcast(context, sessionId, intent, PendingIntent.FLAG_UPDATE_CURRENT | mutability);
    }
}

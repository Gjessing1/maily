package io.gjessing.maily;

import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.util.Log;
import android.webkit.CookieManager;
import android.webkit.MimeTypeMap;
import androidx.core.content.FileProvider;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import javax.net.ssl.HttpsURLConnection;

/**
 * Downloading one attachment and handing it to an app that can open it.
 *
 * The shell has to do this, because the WebView cannot. `window.open` opens no popup
 * (Capacitor leaves `setSupportMultipleWindows` off, the same trap that once broke links
 * inside a message), and a WebView's download hook never fires for a `blob:` URL — so
 * every browser-side route ends in a tap that silently does nothing.
 *
 * The bytes are fetched here rather than carried across the bridge: attachments run to
 * tens of megabytes, and base64 through a bridge call at that size is a stall at best.
 * Written against {@link HttpURLConnection} for the same reason as the push poll — one
 * authenticated GET needs no dependency.
 *
 * Authentication is the WebView's own cookie jar, which is what an SSO-fronted
 * deployment (tinyauth here) actually checks, plus maily's bearer token when the web app
 * has one. Redirects are deliberately not followed: a 302 is the gateway offering a login
 * page, and saving that HTML as "invoice.pdf" is worse than reporting the failure.
 */
final class MailyAttachments {
    private static final String TAG = "MailyAttachments";
    private static final int CONNECT_TIMEOUT_MS = 15_000;
    private static final int READ_TIMEOUT_MS = 60_000;
    /** Subdirectory of the app cache the downloaded copies live in. */
    private static final String CACHE_DIR = "attachments";
    /** Copies older than this are swept on the next open — the viewer has long since
     * read the file, and nothing here is storage the user is meant to keep. */
    private static final long CACHE_TTL_MS = 24L * 60 * 60 * 1000;
    private static final String FALLBACK_FILENAME = "attachment";
    private static final String FALLBACK_MIME = "application/octet-stream";

    private MailyAttachments() {}

    /**
     * Fetch the attachment and open it. Blocking — the caller owns the thread.
     *
     * @throws IOException with a message worth showing the user.
     */
    static void open(Context context, String url, String filename, String mimeType, String authorization)
        throws IOException {
        String name = safeFilename(filename);
        String type = resolveMimeType(mimeType, name);
        File file = download(context, url, name, authorization);
        view(context, file, type);
    }

    /** Stream the response to a private cache file, never into memory. */
    private static File download(Context context, String url, String filename, String authorization)
        throws IOException {
        File dir = new File(context.getCacheDir(), CACHE_DIR);
        if (!dir.isDirectory() && !dir.mkdirs()) {
            throw new IOException("Could not prepare the download folder");
        }
        sweep(dir);

        File file = new File(dir, filename);
        HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
        try {
            if (!(connection instanceof HttpsURLConnection)) {
                // MailyPreferences only ever stores https origins, and the manifest
                // forbids cleartext outright; this is belt-and-braces against ever
                // putting the session cookie on the wire in the clear.
                throw new IOException("Refusing to fetch an attachment over an insecure connection");
            }
            connection.setRequestMethod("GET");
            connection.setConnectTimeout(CONNECT_TIMEOUT_MS);
            connection.setReadTimeout(READ_TIMEOUT_MS);
            connection.setUseCaches(false);
            connection.setInstanceFollowRedirects(false);
            // The cookie jar is the WebView's, so this GET presents exactly what the page
            // itself would behind the SSO gateway.
            String cookies = CookieManager.getInstance().getCookie(url);
            if (cookies != null && !cookies.isEmpty()) connection.setRequestProperty("Cookie", cookies);
            if (authorization != null && !authorization.isBlank()) {
                connection.setRequestProperty("Authorization", "Bearer " + authorization);
            }

            int status = connection.getResponseCode();
            if (status == HttpURLConnection.HTTP_UNAUTHORIZED
                || status == HttpURLConnection.HTTP_FORBIDDEN
                || (status >= 300 && status < 400)) {
                throw new IOException("Your session has expired — reopen Maily and try again");
            }
            if (status != HttpURLConnection.HTTP_OK) {
                throw new IOException("Maily could not send this attachment (" + status + ")");
            }

            try (InputStream in = connection.getInputStream();
                 OutputStream out = new FileOutputStream(file)) {
                byte[] buffer = new byte[16 * 1024];
                for (int read = in.read(buffer); read >= 0; read = in.read(buffer)) {
                    out.write(buffer, 0, read);
                }
            }
        } catch (IOException error) {
            // A half-written file would open as a corrupt document.
            if (file.exists() && !file.delete()) Log.w(TAG, "could not remove a partial download");
            throw error;
        } finally {
            connection.disconnect();
        }
        return file;
    }

    /** Offer the file to whatever app handles the type, falling back to the share sheet. */
    private static void view(Context context, File file, String mimeType) throws IOException {
        Uri uri = FileProvider.getUriForFile(context, context.getPackageName() + ".fileprovider", file);
        Intent view = new Intent(Intent.ACTION_VIEW)
            .setDataAndType(uri, mimeType)
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            context.startActivity(view);
            return;
        } catch (ActivityNotFoundException noViewer) {
            Log.d(TAG, "no app views " + mimeType + "; offering the share sheet instead");
        }

        // Nothing opens the type: let the user send it somewhere that can (Files, Drive,
        // a chat), which is still a file in their hands rather than a dead tap.
        Intent send = new Intent(Intent.ACTION_SEND)
            .setType(mimeType)
            .putExtra(Intent.EXTRA_STREAM, uri)
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        Intent chooser = Intent.createChooser(send, file.getName())
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            context.startActivity(chooser);
        } catch (ActivityNotFoundException nothing) {
            throw new IOException("No app on this phone can open this file");
        }
    }

    /** Drop copies from earlier sessions so the cache does not grow without bound. */
    private static void sweep(File dir) {
        File[] files = dir.listFiles();
        if (files == null) return;
        long cutoff = System.currentTimeMillis() - CACHE_TTL_MS;
        for (File file : files) {
            if (file.isFile() && file.lastModified() < cutoff && !file.delete()) {
                Log.d(TAG, "could not sweep " + file.getName());
            }
        }
    }

    /**
     * A sender's filename is untrusted text that becomes a path here, so reduce it to a
     * plain name: no directory traversal, no separators, nothing hidden by a leading dot,
     * and short enough for any filesystem. Letters are left alone — an ASCII allowlist
     * would turn every Norwegian invoice into `faktura__rs.pdf`, and nothing about `å` is
     * dangerous once the separators are gone. Package-private so the rules can be tested.
     */
    static String safeFilename(String filename) {
        String name = filename == null ? "" : filename.trim();
        int separator = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'));
        if (separator >= 0) name = name.substring(separator + 1);
        name = name.replaceAll("[\\p{Cntrl}/\\\\:*?\"<>|]", "_");
        while (name.startsWith(".")) name = name.substring(1);
        name = name.trim();
        if (name.isEmpty()) return FALLBACK_FILENAME;
        if (name.length() > 100) {
            // Keep the extension: it is what decides which app opens the file.
            int dot = name.lastIndexOf('.');
            String extension = dot > 0 && name.length() - dot <= 10 ? name.substring(dot) : "";
            name = name.substring(0, 100 - extension.length()) + extension;
        }
        return name;
    }

    /**
     * The type to open the file as. The server's own value wins; a sender who sent an
     * invoice as `application/octet-stream` gets the extension consulted instead, because
     * an unresolvable type is a share sheet where a PDF viewer belongs.
     */
    static String resolveMimeType(String mimeType, String filename) {
        String declared = mimeType == null ? "" : mimeType.trim().toLowerCase();
        if (!declared.isEmpty() && !declared.equals(FALLBACK_MIME)) return declared;
        int dot = filename.lastIndexOf('.');
        if (dot >= 0 && dot < filename.length() - 1) {
            String guessed = MimeTypeMap.getSingleton()
                .getMimeTypeFromExtension(filename.substring(dot + 1).toLowerCase());
            if (guessed != null) return guessed;
        }
        return declared.isEmpty() ? FALLBACK_MIME : declared;
    }
}

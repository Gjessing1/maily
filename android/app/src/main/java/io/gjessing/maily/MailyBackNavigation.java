package io.gjessing.maily;

import android.webkit.WebView;
import androidx.activity.OnBackPressedCallback;
import com.getcapacitor.Bridge;

/**
 * Routes the system Back press through the web app before the activity exits.
 *
 * The page is asked directly, by evaluating {@code window.mailyBack()} in the WebView:
 * Maily is served from a remote origin, so a global the app installs itself is the one
 * channel that does not depend on Capacitor's plugin JS being injected into this
 * document and on an asynchronous listener registration having completed first — the
 * reason routing the press through a plugin event left Back exiting the app.
 *
 * The page answers true when it closed an overlay or returned to an earlier view, false
 * when it is already at its root, and null when the WebView shows something else — the
 * SSO detour, the connection-error page, a document whose JS has not booted — that
 * carries no Maily handler. Only then does the WebView's own history get a say: its
 * back/forward list holds the pages that preceded Maily, and popping into those looks
 * like the app hanging.
 */
final class MailyBackNavigation extends OnBackPressedCallback {
    private static final String ASK_WEB_APP = "window.mailyBack ? window.mailyBack() : null";

    private final MainActivity activity;
    private boolean awaitingWebApp;

    MailyBackNavigation(MainActivity activity) {
        super(true);
        this.activity = activity;
    }

    @Override
    public void handleOnBackPressed() {
        Bridge bridge = activity.getBridge();
        if (bridge == null) {
            activity.finish();
            return;
        }
        // Asking the page is asynchronous; ignore presses that arrive meanwhile.
        if (awaitingWebApp) return;
        awaitingWebApp = true;

        WebView webView = bridge.getWebView();
        bridge.eval(ASK_WEB_APP, value -> {
            awaitingWebApp = false;
            if ("true".equals(value)) return;
            // Finish directly rather than re-dispatching through the dispatcher:
            // predictive back (default from targetSdk 36) does not support re-entering
            // onBackPressed() from inside a callback.
            if (!"false".equals(value) && webView.canGoBack()) webView.goBack();
            else activity.finish();
        });
    }
}

package io.gjessing.maily;

import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.os.Bundle;
import android.text.InputType;
import android.util.Log;
import android.view.ViewGroup;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;
import androidx.appcompat.app.AlertDialog;
import androidx.webkit.WebSettingsCompat;
import androidx.webkit.WebViewFeature;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.CapConfig;

public class MainActivity extends BridgeActivity {
    private static final String TAG = "Maily";
    private boolean connectionDialogVisible;
    private boolean setupDialogVisible;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        String serverUrl = MailyPreferences.getServerUrl(this);
        boolean debug = (getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
        CapConfig.Builder configBuilder = new CapConfig.Builder(this)
            .setAppendedUserAgentString("MailyAndroid/1")
            .setLoggingEnabled(debug)
            .setWebContentsDebuggingEnabled(debug)
            .setResolveServiceWorkerRequests(false)
            .setInitialFocus(true);
        if (serverUrl != null) configBuilder.setServerUrl(serverUrl);
        config = configBuilder.create();
        registerPlugin(MailyNativePlugin.class);
        super.onCreate(savedInstanceState);
        enableWebAuthentication();
        if (bridge != null && serverUrl != null) {
            bridge.setWebViewClient(new MailyWebViewClient(bridge, this));
        } else if (bridge != null) {
            bridge.getWebView().post(() -> showServerSetup(false));
        }
        // BridgeActivity does not consume Android's system Back action, so without a
        // callback Back finishes the activity from anywhere in the app. The web app
        // decides first — see MailyBackNavigation.
        getOnBackPressedDispatcher().addCallback(this, new MailyBackNavigation(this));

        // Launched by tapping a new-mail notification: the WebView has loaded nothing
        // yet, so the deep link is simply the URL it starts on.
        String messageId = MailyNotificationLink.messageIdFrom(getIntent());
        if (messageId != null && serverUrl != null && bridge != null) {
            String url = MailyNotificationLink.urlFor(serverUrl, messageId);
            if (url != null) bridge.getWebView().post(() -> bridge.getWebView().loadUrl(url));
        }
    }

    /**
     * A notification tapped while Maily is already running. `launchMode="singleTask"`
     * routes it here instead of recreating the activity, so the running app is asked to
     * navigate rather than being reloaded — a reload would discard its state and, behind
     * SSO, re-run the whole handshake.
     */
    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        String messageId = MailyNotificationLink.messageIdFrom(intent);
        if (messageId == null) return;
        MailyNotificationLink.openInRunningApp(bridge, MailyPreferences.getServerUrl(this), messageId);
    }

    /**
     * Android WebView keeps WebAuthn disabled until the host explicitly enables it.
     * App mode lets a credential provider verify Maily through Digital Asset Links
     * on the Pocket ID relying-party domain.
     */
    private void enableWebAuthentication() {
        if (bridge == null) return;
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_AUTHENTICATION)) {
            Log.w(TAG, "Android System WebView does not support WebAuthn");
            return;
        }
        WebSettingsCompat.setWebAuthenticationSupport(
            bridge.getWebView().getSettings(),
            WebSettingsCompat.WEB_AUTHENTICATION_SUPPORT_FOR_APP
        );
        Log.i(
            TAG,
            "WebAuthn support level: " +
            WebSettingsCompat.getWebAuthenticationSupport(bridge.getWebView().getSettings())
        );
    }

    void showConnectionError() {
        if (connectionDialogVisible || isFinishing()) return;
        connectionDialogVisible = true;
        runOnUiThread(() -> new AlertDialog.Builder(this)
            .setTitle(R.string.server_unavailable_title)
            .setMessage(getString(R.string.server_unavailable_message, MailyPreferences.getServerUrl(this)))
            .setPositiveButton(R.string.retry, (dialog, which) -> {
                connectionDialogVisible = false;
                bridge.getWebView().reload();
            })
            .setNegativeButton(R.string.change_server, (dialog, which) -> {
                connectionDialogVisible = false;
                showServerSetup(true);
            })
            .setOnCancelListener(dialog -> connectionDialogVisible = false)
            .show());
    }

    private void showServerSetup(boolean cancelable) {
        if (setupDialogVisible || isFinishing()) return;
        setupDialogVisible = true;

        int padding = dp(8);
        LinearLayout fields = new LinearLayout(this);
        fields.setOrientation(LinearLayout.VERTICAL);
        fields.setPadding(padding, 0, padding, 0);

        EditText input = new EditText(this);
        input.setHint("https://mail.gjessing.io");
        input.setSingleLine(true);
        input.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        String current = MailyPreferences.getServerUrl(this);
        input.setText(current == null ? "https://mail.gjessing.io" : current);
        input.setSelection(input.length());
        fields.addView(input, new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        ));

        TextView error = new TextView(this);
        error.setTextColor(0xffb91c1c);
        fields.addView(error, new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        ));

        AlertDialog dialog = new AlertDialog.Builder(this)
            .setTitle(R.string.server_setup_title)
            .setMessage(R.string.server_setup_help)
            .setView(fields)
            .setPositiveButton(R.string.connect, null)
            .setCancelable(cancelable)
            .create();
        dialog.setOnCancelListener(value -> setupDialogVisible = false);
        dialog.setOnDismissListener(value -> setupDialogVisible = false);
        dialog.setOnShowListener(value -> dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(button -> {
            String normalized = MailyPreferences.normalizeServerUrl(input.getText().toString());
            if (normalized == null) {
                error.setText(R.string.server_url_error);
                return;
            }
            MailyPreferences.setServerUrl(this, normalized);
            dialog.dismiss();
            recreate();
        }));
        dialog.show();
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }
}

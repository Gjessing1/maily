package io.gjessing.maily;

import android.content.Intent;
import android.content.pm.PackageInfo;
import android.net.Uri;
import androidx.core.content.pm.PackageInfoCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "MailyNative")
public class MailyNativePlugin extends Plugin {
    private MailyNavigation navigation;

    @Override
    public void load() {
        String serverUrl = MailyPreferences.getServerUrl(getContext());
        if (serverUrl != null) navigation = new MailyNavigation(serverUrl);
    }

    @Override
    public Boolean shouldOverrideLoad(Uri url) {
        return navigation != null && navigation.shouldAllow(url) ? false : null;
    }

    @PluginMethod
    public void getInfo(PluginCall call) {
        try {
            PackageInfo info = getContext().getPackageManager().getPackageInfo(getContext().getPackageName(), 0);
            JSObject result = new JSObject();
            result.put("serverUrl", MailyPreferences.getServerUrl(getContext()));
            result.put("versionName", info.versionName == null ? "" : info.versionName);
            result.put("versionCode", PackageInfoCompat.getLongVersionCode(info));
            call.resolve(result);
        } catch (Exception error) {
            call.reject("Could not read app information", error);
        }
    }

    @PluginMethod
    public void configureServer(PluginCall call) {
        String normalized = MailyPreferences.normalizeServerUrl(call.getString("serverUrl"));
        if (normalized == null) {
            call.reject("Enter a root HTTPS URL, for example https://mail.gjessing.io");
            return;
        }
        MailyPreferences.setServerUrl(getContext(), normalized);
        call.resolve();
        getActivity().runOnUiThread(() -> getActivity().recreate());
    }

    /**
     * Offer the system Back press to the web app. Only the web layer knows about
     * transient UI that owns no history entry (folder drawer, dialogs, multi-select)
     * and about React Router's own stack, so it decides first. Returns false when no
     * listener is registered — an error page, the SSO detour, or a WebView whose JS
     * has not booted — so the caller can fall back to native history.
     */
    boolean dispatchBackButton(boolean webViewCanGoBack) {
        if (!hasListeners("backButton")) return false;
        JSObject event = new JSObject();
        event.put("canGoBack", webViewCanGoBack);
        notifyListeners("backButton", event);
        return true;
    }

    /** Leave Maily, for a Back press the web app resolved to "nothing left to pop". */
    @PluginMethod
    public void exitApp(PluginCall call) {
        call.resolve();
        getActivity().runOnUiThread(() -> getActivity().finish());
    }

    @PluginMethod
    public void openExternal(PluginCall call) {
        String raw = call.getString("url");
        Uri uri = raw == null ? null : Uri.parse(raw);
        if (uri == null || (!"https".equals(uri.getScheme()) && !"http".equals(uri.getScheme()))) {
            call.reject("Only HTTP(S) links can be opened");
            return;
        }
        try {
            getContext().startActivity(new Intent(Intent.ACTION_VIEW, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            call.resolve();
        } catch (Exception error) {
            call.reject("No app can open this link", error);
        }
    }
}

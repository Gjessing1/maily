# Maily

Maily is a self-hosted, mobile-first mail client. It runs as a browser PWA and as a private Capacitor Android app that connects to a selected Maily server.

## Initial Android download

Open this address on the Android device to download the current APK:

```text
https://mail.gjessing.io/api/app/download
```

Android may ask you to allow the browser to install apps from this source. After installation, open Maily and confirm the server address `https://mail.gjessing.io`. The address is stored on the device and can later be changed under **Settings → Android app**.

The download returns `404 Not Found` until the first signed APK has been published. The web app remains available at [mail.gjessing.io](https://mail.gjessing.io).

### TinyAuth, Pocket ID, and passkeys

The Android WebView keeps TinyAuth and its chained Pocket ID redirects inside the app. WebAuthn is enabled through Android Credential Manager so Pocket ID passkey login can work. Bitwarden passkeys require Android 14 or later; in Bitwarden select it under **Settings → Autofill → Passkey management**, and keep Android System WebView current.

Pocket ID's relying-party domain must serve `/.well-known/assetlinks.json` with Maily's package and the SHA-256 fingerprint of the release signing certificate:

```json
[
  {
    "relation": [
      "delegate_permission/common.handle_all_urls",
      "delegate_permission/common.get_login_creds"
    ],
    "target": {
      "namespace": "android_app",
      "package_name": "io.gjessing.maily",
      "sha256_cert_fingerprints": ["RELEASE_CERTIFICATE_SHA256"]
    }
  }
]
```

The asset-links URL must return `200 OK` directly, without a redirect, as `application/json`. Add the debug certificate as a separate entry when testing a debug APK. Get a certificate fingerprint with `keytool -list -v -keystore /path/to/maily-release.jks -alias maily` and use the `SHA256` value.

## Android releases

The APK hosts the current UI from the selected HTTPS Maily server, so ordinary UI/server deployments arrive without an APK update. Rebuild the APK when native code, permissions, signing, or icons change. The app checks `/api/app/version` and offers a newer published APK under **Settings → Android app**.

Create `~/.config/maily/keystore.env` outside the repository:

```bash
export MAILY_KEYSTORE_FILE=/absolute/path/to/maily-release.jks
export MAILY_KEYSTORE_PASSWORD='...'
export MAILY_KEY_ALIAS='maily'
export MAILY_KEY_PASSWORD='...'
```

For each native release, increment `versionCode` and update `versionName` in `android/app/build.gradle`, then build and publish:

```bash
npm ci
./android/build-apk.sh
./scripts/publish-android.sh android/app/build/outputs/apk/release/app-release.apk 1 0.1.0
```

The publish script writes to `/home/gjessing/data/maily/app` by default — the host directory this deployment bind-mounts into the container as `/data`. The standard Docker volume exposes this as `/data/app`, which the backend serves at `/api/app/version` and `/api/app/download`. Set `MAILY_ANDROID_PUBLISH_DIR` to change the host publication path; set backend `MAILY_ANDROID_APP_DIR` if the APK directory is elsewhere inside its container.

For local development, `npm run android:build:debug` writes `android/app/build/outputs/apk/debug/app-debug.apk`. Never publish a debug-signed build: Android cannot install it over a release-signed app.

The frontend uses Capacitor's Android safe-area values, with browser `env()` fallbacks, so headers and bottom controls remain clear of the status and navigation bars.

## Development

```bash
npm install
npm run build
npm run typecheck
npm test
```

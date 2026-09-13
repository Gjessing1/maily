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

The Android WebView keeps TinyAuth and its chained Pocket ID redirects inside the app. Passkey requests run in WebView's WebAuthn browser mode (APK 0.4.3 and later): the WebView builds the request for the Pocket ID page it is showing, so the passkey is asserted for `https://pocketid.gjessing.io` exactly as it would be in a browser. Bitwarden passkeys require Android 14 or later; in Bitwarden, open **Settings → Autofill → Passkey management** and select Bitwarden as the preferred passkey provider. Also keep Android System WebView current.

The first passkey login from the app stops with Bitwarden reporting that the browser (Maily) is not recognized. Tap **Trust**, then choose the passkey: Bitwarden adds the package and its signing certificate to its locally trusted privileged apps, and later logins go straight through. Trust belongs to the signing certificate, so an APK signed with a different key (a debug build, say) has to be trusted separately.

No `/.well-known/assetlinks.json` is involved. WebAuthn's app mode, which Digital Asset Links would authorise, asserts the passkey for the app's `android:apk-key-hash:` origin instead of the website's, and Pocket ID only accepts its own HTTPS origin — Bitwarden refuses app mode with "Passkeys not supported for this app" when the asset links are missing, and Pocket ID rejects the login when they are present.

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

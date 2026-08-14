# @maily/frontend

The React + Vite + Tailwind PWA, with Dexie/IndexedDB caching, a service worker and Web Push.

## Rendering fixture suite

The Gmail rendering regression suite parses the local `.eml` corpus, renders the real `MailHtml`
iframe in Android Chromium, checks geometry, and compares phone/desktop screenshots. Start an Android
emulator with Chrome installed, then run:

```sh
npm run test:rendering -w @maily/frontend
```

The Playwright config discovers the Android SDK from `ANDROID_HOME`, `ANDROID_SDK_ROOT`,
`~/android-sdk`, or `~/Android/Sdk`. Update intentional visual changes with `-- --update-snapshots`.

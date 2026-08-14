#!/usr/bin/env bash
# Build a release-signed APK suitable for publication and in-place updates.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
config_root="${XDG_CONFIG_HOME:-$HOME/.config}"
signing_env="${MAILY_KEYSTORE_ENV:-$config_root/maily/keystore.env}"

if [[ -f /home/gjessing/android-sdk/env.sh && -z "${ANDROID_HOME:-}" ]]; then
  # Host-local convenience; other machines can export ANDROID_HOME/JAVA_HOME.
  . /home/gjessing/android-sdk/env.sh
fi
if [[ -f "$signing_env" ]]; then
  # shellcheck source=/dev/null
  . "$signing_env"
fi

required=(
  MAILY_KEYSTORE_FILE
  MAILY_KEYSTORE_PASSWORD
  MAILY_KEY_ALIAS
  MAILY_KEY_PASSWORD
)
for name in "${required[@]}"; do
  if [[ -z "${!name:-}" ]]; then
    echo "Missing $name. Configure release signing in $signing_env." >&2
    exit 1
  fi
  export "$name"
done

cd "$root"
npm run android:sync
(cd android && ./gradlew clean assembleRelease)

apk="$root/android/app/build/outputs/apk/release/app-release.apk"
if [[ ! -f "$apk" ]]; then
  echo "Release APK was not produced at $apk" >&2
  exit 1
fi

if [[ -n "${ANDROID_HOME:-}" ]]; then
  apksigner="$(find "$ANDROID_HOME/build-tools" -mindepth 2 -maxdepth 2 -type f -name apksigner | sort -V | tail -1)"
  if [[ -n "$apksigner" ]]; then
    "$apksigner" verify --print-certs "$apk"
  fi
fi

echo "$apk"

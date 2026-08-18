#!/usr/bin/env bash
# Publish a signed Maily APK for direct download and in-app update checks.
# Usage: ./scripts/publish-android.sh <apk> <versionCode> <versionName>
set -euo pipefail

apk="${1:?path to the signed APK}"
version_code="${2:?Android versionCode (integer)}"
version_name="${3:?version name, for example 0.1.0}"
# Default to the host dir the running container actually bind-mounts as /data, where the
# backend resolves androidAppDir to /data/app. Publishing anywhere else succeeds silently
# and the phone never sees the update. Override for a host that mounts data elsewhere.
app_dir="${MAILY_ANDROID_PUBLISH_DIR:-/home/gjessing/data/maily/app}"

if [[ ! -f "$apk" ]]; then
  echo "APK not found: $apk" >&2
  exit 1
fi
if [[ ! "$version_code" =~ ^[1-9][0-9]*$ ]]; then
  echo "versionCode must be a positive integer" >&2
  exit 1
fi
if [[ ! "$version_name" =~ ^[0-9A-Za-z][0-9A-Za-z._-]*$ ]]; then
  echo "versionName may contain only letters, numbers, dots, underscores, and dashes" >&2
  exit 1
fi

file="maily-$version_name.apk"
mkdir -p "$app_dir"
install -m 0644 "$apk" "$app_dir/$file"
bytes="$(stat -c '%s' "$app_dir/$file")"
sha256="$(sha256sum "$app_dir/$file" | cut -d ' ' -f 1)"
metadata_tmp="$app_dir/.version.json.$$"
printf '{"versionCode":%s,"versionName":"%s","file":"%s","bytes":%s,"sha256":"%s"}\n' \
  "$version_code" "$version_name" "$file" "$bytes" "$sha256" > "$metadata_tmp"
chmod 0644 "$metadata_tmp"
mv "$metadata_tmp" "$app_dir/version.json"

echo "Published $file (versionCode $version_code) to $app_dir"

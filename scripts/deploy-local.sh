#!/bin/bash
# Build Nightyard from this checkout and install it as /Applications/Nightyard.app
# (macOS, Apple Silicon).
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd -P)"
SRC="$REPO/dist/mac-arm64/Nightyard.app"
DST="/Applications/Nightyard.app"

echo "==> Quit running Nightyard"
osascript -e 'tell application "Nightyard" to quit' 2>/dev/null || true
for _ in 1 2 3 4 5; do pgrep -x Nightyard >/dev/null || break; sleep 1; done
if pgrep -x Nightyard >/dev/null; then
  echo "error: Nightyard refused to quit; aborting" >&2
  exit 1
fi

echo "==> Build (unsigned app bundle)"
cd "$REPO"
npm run build
CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --mac dir --arm64 \
  -c.mac.notarize=false -c.mac.identity=null --publish never

if [ ! -d "$SRC" ]; then
  echo "error: build did not produce $SRC" >&2
  exit 1
fi

echo "==> Install → $DST"
rm -rf "$DST"
cp -R "$SRC" "$DST"
xattr -rd com.apple.quarantine "$DST" 2>/dev/null || true

echo "==> Re-sign with ad-hoc identity (fixes Team ID mismatch on first launch)"
codesign --force --deep --sign - "$DST"

echo
echo "Nightyard installed to $DST"
echo "Launch via Dock, Spotlight, or: open -a Nightyard"

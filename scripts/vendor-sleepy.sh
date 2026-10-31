#!/bin/bash
# Refresh vendor/sleepy/ from a Sleepy checkout at a given ref.
#   scripts/vendor-sleepy.sh ~/sleepy v0.4.0
# Only what the bundled CLI needs is copied (no tests, no pnpm files);
# Sleepy's own test suite runs in its own repo.
set -euo pipefail

SRC="${1:?usage: scripts/vendor-sleepy.sh <sleepy checkout> <git ref>}"
REF="${2:?usage: scripts/vendor-sleepy.sh <sleepy checkout> <git ref>}"
REPO="$(cd "$(dirname "$0")/.." && pwd -P)"
DEST="$REPO/vendor/sleepy"

SHA="$(git -C "$SRC" rev-parse --verify "$REF^{commit}")"
VERSION="$(git -C "$SRC" show "$SHA:cli/package.json" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).version))')"

rm -rf "$DEST"
mkdir -p "$DEST"
git -C "$SRC" archive "$SHA" \
  cli/bin cli/src cli/package.json cli/tsconfig.json plugin tsconfig.base.json LICENSE README.md CHANGELOG.md \
  | tar -x -C "$DEST"
printf 'Sleepy v%s, vendored from https://github.com/STEIN64-BIT/sleepy at %s.\nUpdate with: scripts/vendor-sleepy.sh <path to a sleepy checkout> <git ref>\n' \
  "$VERSION" "$SHA" > "$DEST/SOURCE"

echo "vendored Sleepy v$VERSION ($SHA) into vendor/sleepy/"
echo "If its dependencies changed, update the sleepy-* devDependencies in package.json to match cli/package.json."

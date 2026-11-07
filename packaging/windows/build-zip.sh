#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# Builds tvsm-agent_<version>_windows-x64.zip: node.exe + agent.mjs + WinSW service wrapper + studio node files.
# Usage: packaging/windows/build-zip.sh <version> [outdir]
set -euo pipefail
VERSION="${1:?version}"
OUT="${2:-build}"
NODE_VERSION="${NODE_VERSION:-24.11.0}"
WINSW_VERSION="${WINSW_VERSION:-2.12.0}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DIST="$ROOT/apps/agent/dist/agent.mjs"
[[ -f "$DIST" ]] || { echo "Build apps/agent first" >&2; exit 1; }

CACHE="$ROOT/build/.cache"; mkdir -p "$CACHE"
NODE_ZIP="$CACHE/node-v$NODE_VERSION-win-x64.zip"
if [[ ! -f "$NODE_ZIP" ]]; then
  curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-win-x64.zip" -o "$NODE_ZIP.tmp"
  curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt" | grep " node-v$NODE_VERSION-win-x64.zip\$" | sed "s#node-v.*#$NODE_ZIP.tmp#" | sha256sum -c -
  mv "$NODE_ZIP.tmp" "$NODE_ZIP"
fi
WINSW="$CACHE/WinSW-x64-$WINSW_VERSION.exe"
[[ -f "$WINSW" ]] || curl -fsSL "https://github.com/winsw/winsw/releases/download/v$WINSW_VERSION/WinSW-x64.exe" -o "$WINSW"

STAGE="$(mktemp -d)"; trap 'rm -rf "$STAGE"' EXIT
unzip -q -j "$NODE_ZIP" "node-v$NODE_VERSION-win-x64/node.exe" -d "$STAGE"
cp "$DIST" "$STAGE/agent.mjs"
cp "$WINSW" "$STAGE/tvsm-agent-service.exe"
cp "$ROOT/packaging/windows/tvsm-agent-service.xml" "$ROOT/packaging/windows/tvsm-agent.cmd" "$ROOT/packaging/windows/update-agent.ps1" "$STAGE/"
# Provisioning from the orchestrator (Change role): the job script, the studio installer it runs and the inventory.
cp "$ROOT/packaging/windows/provision.ps1" "$ROOT/packaging/windows/install-studio.ps1" "$ROOT/packaging/windows/inventory.ps1" "$STAGE/"
# Studio node files (used by install-studio.ps1; CasparCG loads the templates straight from here, so agent
# updates also update the overlay).
mkdir -p "$STAGE/studio/templates"
cp "$ROOT/studio/windows/start-casparcg.ps1" "$STAGE/studio/"
cp -r "$ROOT/studio/casparcg-templates/." "$STAGE/studio/templates/"
# Desktop background with the node's role and status (desktop-info.ps1 -Install), with the active brand's white logo.
BRAND="${TVSM_BRAND:-$(tr -d '[:space:]' < "$ROOT/branding/active-brand" 2>/dev/null || echo tvsm)}"
cp "$ROOT/packaging/windows/desktop-info.ps1" "$STAGE/studio/"
for f in "$ROOT/branding/$BRAND/tv/logo-white-pink.png" "$ROOT/branding/$BRAND/tv/logo-white.png"; do
  [[ -f "$f" ]] && { cp "$f" "$STAGE/studio/logo.png"; break; }
done
cp "$ROOT/LICENSE" "$STAGE/LICENSE.txt"
echo "$VERSION" > "$STAGE/VERSION"
mkdir -p "$OUT"
FILE="$(cd "$OUT" && pwd)/tvsm-agent_${VERSION//[-~]/.}_windows-x64.zip"
rm -f "$FILE"
(cd "$STAGE" && zip -q -r "$FILE" .)
echo "$FILE"

#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# Builds tvsm-<app>_<version>_<arch>.deb from apps/<app>/dist.
# Usage: packaging/debian/build-deb.sh <app> <version> [outdir]
# The package bundles its own Node.js runtime so it only depends on base Debian 13 packages.
set -euo pipefail

APP="${1:?app id, e.g. orchestrator}"
VERSION="${2:?version, e.g. 0.1.0 or 0.2.0-test.5}"
OUT="${3:-build}"
NODE_VERSION="${NODE_VERSION:-24.11.0}"
ARCH="${ARCH:-amd64}"

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DIST="$ROOT/apps/$APP/dist"
if [[ "$APP" == agent ]]; then ENTRY=agent.mjs; else ENTRY=server.mjs; fi
[[ -f "$DIST/$ENTRY" ]] || { echo "Build apps/$APP first (pnpm --filter @tvsm/$APP build)" >&2; exit 1; }

case "$ARCH" in amd64) NODE_ARCH=x64 ;; arm64) NODE_ARCH=arm64 ;; *) echo "unsupported arch $ARCH" >&2; exit 1 ;; esac
DEB_VERSION="${VERSION/-/\~}"   # 0.2.0-test.5 -> 0.2.0~test.5 (sorts before 0.2.0)
PKG="tvsm-$APP"
STAGE="$(mktemp -d)"
chmod 0755 "$STAGE"
trap 'rm -rf "$STAGE"' EXIT

# Node.js runtime (cached).
CACHE="$ROOT/build/.cache"
mkdir -p "$CACHE"
NODE_TGZ="$CACHE/node-v$NODE_VERSION-linux-$NODE_ARCH.tar.xz"
if [[ ! -f "$NODE_TGZ" ]]; then
  curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-$NODE_ARCH.tar.xz" -o "$NODE_TGZ.tmp"
  curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt" | grep " node-v$NODE_VERSION-linux-$NODE_ARCH.tar.xz\$" | sed "s#node-v.*#$NODE_TGZ.tmp#" | sha256sum -c -
  mv "$NODE_TGZ.tmp" "$NODE_TGZ"
fi

LIB="$STAGE/usr/lib/tvsm/$APP"
mkdir -p "$LIB" "$STAGE/DEBIAN" "$STAGE/lib/systemd/system" "$STAGE/usr/share/doc/$PKG"
tar -xJf "$NODE_TGZ" -C "$STAGE" --strip-components=2 "node-v$NODE_VERSION-linux-$NODE_ARCH/bin/node"
mv "$STAGE/node" "$LIB/node"
chmod 0755 "$LIB/node"
cp "$DIST/$ENTRY" "$LIB/$ENTRY"
# Extra bundles loaded at runtime (e.g. the ATEM socket for the management node).
for extra in "$DIST"/*.cjs; do [[ -f "$extra" ]] && cp "$extra" "$LIB/"; done
echo "$VERSION" > "$LIB/VERSION"
cp "$ROOT/branding/$(cat "$ROOT/branding/active-brand" | tr -d "[:space:]")/BRAND.md" "$STAGE/usr/share/doc/$PKG/BRAND.md"
# Machine-readable copyright file (DEP-5); the full licence text ships next to it.
cat > "$STAGE/usr/share/doc/$PKG/copyright" <<COPYRIGHT
Format: https://www.debian.org/doc/packaging-manuals/copyright-format/1.0/
Upstream-Name: TV Station Manager
Source: https://github.com/rhisijmuiden/tv-station-manager

Files: *
Copyright: 2026 TV Station Manager contributors
License: AGPL-3.0-only
 This program is free software: you can redistribute it and/or modify it under the terms of the
 GNU Affero General Public License as published by the Free Software Foundation, version 3.
 .
 This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without
 even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the full
 text in /usr/share/doc/$PKG/LICENSE.

Files: usr/lib/tvsm/$APP/node
Copyright: Node.js contributors
License: MIT
 See https://github.com/nodejs/node/blob/main/LICENSE
COPYRIGHT
cp "$ROOT/LICENSE" "$STAGE/usr/share/doc/$PKG/LICENSE"

if [[ "$APP" == agent ]]; then
  # Node agent: root service, CLI wrapper, no web UI and no sudoers rule.
  SRC="$ROOT/packaging/debian/agent"
  mkdir -p "$STAGE/usr/bin"
  install -m 0755 "$SRC/tvsm-agent" "$STAGE/usr/bin/tvsm-agent"
  cp "$SRC/tvsm-agent.service" "$STAGE/lib/systemd/system/$PKG.service"
  for s in postinst prerm postrm; do install -m 0755 "$SRC/$s" "$STAGE/DEBIAN/$s"; done
  DEPENDS="systemd, ca-certificates"
  DESCRIPTION="Node agent: connects this machine to the orchestrator
 (enroll with: sudo tvsm-agent enroll https://<orchestrator>)."
else
  cp -r "$DIST/web" "$LIB/web"
  mkdir -p "$STAGE/etc/sudoers.d"
  sed "s/@APP@/$APP/g" "$ROOT/packaging/debian/apply-update" > "$LIB/apply-update"
  chmod 0755 "$LIB/apply-update"
  sed "s/@APP@/$APP/g" "$ROOT/packaging/debian/tvsm-app.service" > "$STAGE/lib/systemd/system/$PKG.service"
  cat > "$STAGE/etc/sudoers.d/$PKG" <<SUDO
# Allows the $PKG service to install a downloaded update package (validated by apply-update).
tvsm ALL=(root) NOPASSWD: /usr/lib/tvsm/$APP/apply-update /var/lib/tvsm/$APP/updates/*.deb
SUDO
  chmod 0440 "$STAGE/etc/sudoers.d/$PKG"
  for s in postinst prerm postrm; do
    sed "s/@APP@/$APP/g" "$ROOT/packaging/debian/$s" > "$STAGE/DEBIAN/$s"
    chmod 0755 "$STAGE/DEBIAN/$s"
  done
  echo "/etc/sudoers.d/$PKG" > "$STAGE/DEBIAN/conffiles"
  DEPENDS="adduser, sudo, systemd, ca-certificates, openssh-client"
  # Management node: smbclient reads the UNAS share, ffprobe measures clip durations.
  [[ "$APP" == management ]] && DEPENDS="$DEPENDS, smbclient, ffmpeg"
  DESCRIPTION="Web interface on port 8080 by default
 (change TVSM_PORT in /etc/tvsm/$APP/env)."
fi

SIZE_KB=$(du -sk "$STAGE" | cut -f1)
cat > "$STAGE/DEBIAN/control" <<CONTROL
Package: $PKG
Version: $DEB_VERSION
Architecture: $ARCH
Maintainer: TV Station Manager <noreply@users.noreply.github.com>
Installed-Size: $SIZE_KB
Depends: $DEPENDS
Section: video
Priority: optional
Homepage: https://github.com/rhisijmuiden/tv-station-manager
Description: TV Station Manager - $APP
 Part of TV Station Manager. $DESCRIPTION
CONTROL

mkdir -p "$OUT"
# GitHub release assets cannot contain "~", so the file name uses "." (the package version inside keeps "~").
FILE="$OUT/${PKG}_${VERSION//[-~]/.}_${ARCH}.deb"
dpkg-deb --root-owner-group -Zxz --build "$STAGE" "$FILE" >/dev/null
echo "$FILE"

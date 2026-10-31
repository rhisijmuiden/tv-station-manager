#!/usr/bin/env bash
# TV Station Manager installer for Debian 13.
#   curl -fsSL https://raw.githubusercontent.com/rhisijmuiden/tv-station-manager/production/packaging/install.sh | sudo bash -s -- orchestrator
#   ... | sudo bash -s -- agent --orchestrator https://orchestrator.example.com
#   ... | sudo bash -s -- management --orchestrator http://10.40.6.201:8080   (also installs the agent and registers it)
# Options: <app> [--channel production|test] [--repo owner/name] [--orchestrator URL (agent, or management to register it)]
set -euo pipefail
APP="${1:-}"; shift || true
CHANNEL=production
REPO=rhisijmuiden/tv-station-manager
ORCHESTRATOR=
while [[ $# -gt 0 ]]; do
  case "$1" in
    --channel) CHANNEL="$2"; shift 2 ;;
    --repo) REPO="$2"; shift 2 ;;
    --orchestrator) ORCHESTRATOR="$2"; shift 2 ;;
    *) echo "unknown option $1" >&2; exit 1 ;;
  esac
done
case "$APP" in orchestrator|management|agent) ;; *) echo "usage: install.sh <orchestrator|management|agent> [--channel production|test] [--orchestrator URL]" >&2; exit 1 ;; esac
[[ $EUID -eq 0 ]] || { echo "run as root" >&2; exit 1; }
. /etc/os-release
[[ "${VERSION_ID:-}" == "13" ]] || echo "warning: tested on Debian 13, this is $PRETTY_NAME" >&2
ARCH=$(dpkg --print-architecture)

apt-get update -qq
apt-get install -y -qq curl ca-certificates jq >/dev/null

API="https://api.github.com/repos/$REPO/releases?per_page=50"
FILTER='.[] | select(.draft == false)'
[[ "$CHANNEL" == production ]] && FILTER="$FILTER | select(.prerelease == false)"
URL=$(curl -fsSL "$API" | jq -r "[$FILTER | .assets[] | select(.name | test(\"^tvsm-${APP}_.*_$ARCH\\\\.deb$\"))][0].browser_download_url")
SUMS=$(curl -fsSL "$API" | jq -r "[$FILTER | select(any(.assets[]; .name | test(\"^tvsm-${APP}_.*_$ARCH\\\\.deb$\"))) | .assets[] | select(.name == \"SHA256SUMS\")][0].browser_download_url")
[[ -n "$URL" && "$URL" != null ]] || { echo "no $CHANNEL release found for $APP ($ARCH)" >&2; exit 1; }

TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
NAME=$(basename "$URL")
echo "Downloading $NAME"
curl -fsSL "$URL" -o "$TMP/$NAME"
curl -fsSL "$SUMS" -o "$TMP/SHA256SUMS"
(cd "$TMP" && grep " $NAME\$" SHA256SUMS | sha256sum -c -)
apt-get install -y "$TMP/$NAME"

# A management node registers with the orchestrator through the agent.
if [[ "$APP" == management && -n "$ORCHESTRATOR" ]]; then
  echo "Installing the agent to register this management node with $ORCHESTRATOR"
  if [[ -f "$0" && "$0" == *install.sh ]]; then
    bash "$0" agent --channel "$CHANNEL" --repo "$REPO" --orchestrator "$ORCHESTRATOR"
  else
    # Piped through bash: fetch the installer again.
    BRANCH=production; [[ "$CHANNEL" == test ]] && BRANCH=test
    curl -fsSL "https://raw.githubusercontent.com/$REPO/$BRANCH/packaging/install.sh" | bash -s -- agent --channel "$CHANNEL" --repo "$REPO" --orchestrator "$ORCHESTRATOR"
  fi
  echo "Approve the node in the orchestrator (Nodes) and give it the role 'management'."
fi

if [[ "$APP" == agent && -n "$ORCHESTRATOR" ]]; then
  if [[ -f /etc/tvsm/agent/agent.json ]]; then
    echo "Agent is already enrolled (/etc/tvsm/agent/agent.json). To re-enroll: tvsm-agent enroll $ORCHESTRATOR"
  else
    tvsm-agent enroll "$ORCHESTRATOR"
    systemctl restart tvsm-agent.service
  fi
fi

#!/bin/sh
# Install the latest opengate release for Linux or macOS into ~/.local/bin (or $OPENGATE_BIN).
#   curl -fsSL https://raw.githubusercontent.com/Emmanuek5/opengate/main/install.sh | sh
# Forks: set OPENGATE_REPO=you/opengate.
set -eu
REPO="${OPENGATE_REPO:-Emmanuek5/opengate}"
BIN_DIR="${OPENGATE_BIN:-$HOME/.local/bin}"

case "$(uname -s)" in
  Linux) os=linux ;;
  Darwin) os=darwin ;;
  *) echo "opengate: unsupported OS $(uname -s); on Windows use install.ps1" >&2; exit 1 ;;
esac
case "$(uname -m)" in
  x86_64 | amd64) arch=x64 ;;
  arm64 | aarch64) arch=arm64 ;;
  *) echo "opengate: unsupported CPU $(uname -m)" >&2; exit 1 ;;
esac

asset="opengate-$os-$arch"
url="https://github.com/$REPO/releases/latest/download/$asset"
sums="https://github.com/$REPO/releases/latest/download/SHA256SUMS"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

echo "Downloading $asset from $REPO…"
curl -fsSL "$url" -o "$tmp/$asset"
if curl -fsSL "$sums" -o "$tmp/SHA256SUMS" 2>/dev/null; then
  expected="$(grep " $asset\$" "$tmp/SHA256SUMS" | cut -d' ' -f1)"
  if command -v sha256sum >/dev/null 2>&1; then actual="$(sha256sum "$tmp/$asset" | cut -d' ' -f1)"; else actual="$(shasum -a 256 "$tmp/$asset" | cut -d' ' -f1)"; fi
  if [ -n "$expected" ] && [ "$expected" != "$actual" ]; then echo "opengate: checksum mismatch, not installing" >&2; exit 1; fi
fi
mkdir -p "$BIN_DIR"
install -m 755 "$tmp/$asset" "$BIN_DIR/opengate"
echo "Installed $BIN_DIR/opengate ($("$BIN_DIR/opengate" --version))"
case ":$PATH:" in *":$BIN_DIR:"*) ;; *) echo "Add $BIN_DIR to your PATH to run 'opengate' from anywhere." ;; esac
echo "Next: opengate login"

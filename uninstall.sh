#!/usr/bin/env bash
# Baa-ton uninstaller — macOS, Linux, WSL.
# Removes only the Baa-ton checkout, its Pi extension link, and its Herdr
# controller registration. Workflow data and shared Herdr configuration remain.
set -euo pipefail

BAA_TON_DIR="${BAA_TON_DIR:-$HOME/.baa-ton}"
PI_EXT_DIR="${PI_EXTENSIONS_DIR:-$HOME/.pi/agent/extensions}"
CONTROLLER_PLUGIN_ID="herdr-orchestrator-controller"
PI_LINK="$PI_EXT_DIR/herdr-orchestrator"

say() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'USAGE'
Usage: uninstall.sh [--yes]

Removes the Baa-ton checkout, its Pi extension link, and its Herdr controller
registration. It preserves Herdr shared configuration, project workflow
manifests, and harness MCP configuration.

Use --yes for a non-interactive uninstall.
USAGE
}

assume_yes=0
for arg in "$@"; do
  case "$arg" in
    --yes|-y) assume_yes=1 ;;
    --help|-h) usage; exit 0 ;;
    *) die "unknown option: $arg" ;;
  esac
done

case "$BAA_TON_DIR" in
  ""|"/"|"$HOME") die "refusing to remove an unsafe BAA_TON_DIR: $BAA_TON_DIR" ;;
esac

if [ "$assume_yes" -eq 0 ]; then
  printf 'Remove Baa-ton from %s and unlink its Herdr controller? [y/N] ' "$BAA_TON_DIR" >&2
  if [ -r /dev/tty ]; then
    IFS= read -r answer </dev/tty || answer=""
  else
    IFS= read -r answer || answer=""
  fi
  case "$answer" in
    y|Y|yes|YES|Yes) ;;
    *) say "Uninstall cancelled."; exit 0 ;;
  esac
fi

baa_ton_real=""
if [ -d "$BAA_TON_DIR" ] && [ ! -L "$BAA_TON_DIR" ]; then
  baa_ton_real="$(cd "$BAA_TON_DIR" && pwd -P)"
fi
controller_path="${baa_ton_real:-$BAA_TON_DIR}/packages/controller"

if command -v herdr >/dev/null 2>&1; then
  plugin_listing="$(herdr plugin list --plugin "$CONTROLLER_PLUGIN_ID" --json 2>/dev/null || true)"
  if [ -n "$baa_ton_real" ] && printf '%s' "$plugin_listing" | grep -F -- "$controller_path" >/dev/null 2>&1; then
    say "Unlinking the Herdr controller plugin"
    herdr plugin unlink "$CONTROLLER_PLUGIN_ID"
  elif printf '%s' "$plugin_listing" | grep -F -- "$CONTROLLER_PLUGIN_ID" >/dev/null 2>&1; then
    say "A Herdr controller with the same ID is linked elsewhere; leaving it alone."
  else
    say "Herdr controller plugin is not registered from this checkout."
  fi
else
  say "Herdr CLI not found; skipping controller unlink."
fi

if [ -L "$PI_LINK" ]; then
  link_target="$(readlink "$PI_LINK")"
  expected_target="$BAA_TON_DIR/packages/herdr-tools"
  expected_real_target="${baa_ton_real:-$BAA_TON_DIR}/packages/herdr-tools"
  if [ "$link_target" = "$expected_target" ] || [ "$link_target" = "$expected_real_target" ]; then
    say "Removing the Pi extension link"
    rm -f -- "$PI_LINK"
  else
    say "Pi extension link points elsewhere; leaving it alone: $PI_LINK"
  fi
elif [ -e "$PI_LINK" ]; then
  say "Pi extension path is not a symbolic link; leaving it alone: $PI_LINK"
else
  say "Pi extension link is not installed."
fi

if [ -d "$BAA_TON_DIR" ] && [ ! -L "$BAA_TON_DIR" ] && [ -d "$BAA_TON_DIR/.git" ] && [ -f "$BAA_TON_DIR/package.json" ]; then
  say "Removing the Baa-ton checkout: $BAA_TON_DIR"
  rm -rf -- "$BAA_TON_DIR"
elif [ -e "$BAA_TON_DIR" ]; then
  say "Checkout does not match an installed Baa-ton tree; leaving it alone: $BAA_TON_DIR"
else
  say "Baa-ton checkout is not installed."
fi

say "Baa-ton uninstall complete. Shared Herdr and project state was preserved."

#!/usr/bin/env bash
# Baa-ton installer — macOS, Linux, WSL.
# Clones the repo, installs dependencies, links the Pi extension and the
# Herdr controller plugin. Idempotent: safe to re-run to update.
set -euo pipefail

BAA_TON_DIR="${BAA_TON_DIR:-$HOME/.baa-ton}"
PI_EXT_DIR="${PI_EXTENSIONS_DIR:-$HOME/.pi/agent/extensions}"
REPO="https://github.com/zachristmas/baa-ton"

say() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

command -v git >/dev/null 2>&1 || die "git is required (https://git-scm.com)"
command -v node >/dev/null 2>&1 || die "Node.js 20+ is required (https://nodejs.org)"
node_major="$(node -p 'process.versions.node.split(".")[0]')"
[ "$node_major" -ge 20 ] || die "Node.js 20+ required, found $(node --version)"

if [ ! -d "$BAA_TON_DIR/.git" ]; then
  say "Cloning Baa-ton to $BAA_TON_DIR"
  git clone --depth 1 "$REPO" "$BAA_TON_DIR"
else
  say "Updating existing checkout at $BAA_TON_DIR"
  git -C "$BAA_TON_DIR" pull --ff-only
fi

say "Installing dependencies"
npm --prefix "$BAA_TON_DIR" install --no-audit --no-fund

mkdir -p "$PI_EXT_DIR"
target="$PI_EXT_DIR/herdr-orchestrator"
if [ -L "$target" ] || [ -e "$target" ]; then
  say "Replacing existing extension link"
  rm -rf "$target"
fi
ln -s "$BAA_TON_DIR/packages/herdr-tools" "$target"
say "Pi extension linked: $target"

if command -v herdr >/dev/null 2>&1; then
  say "Linking the Herdr event controller plugin"
  herdr plugin link "$BAA_TON_DIR/packages/controller"
else
  say "Herdr CLI not found. Install Herdr 0.9+ (https://github.com/herdrdev/herdr), then run:"
  printf '      herdr plugin link "%s/packages/controller"\n' "$BAA_TON_DIR"
fi

say "Done. Next: run pi inside a Herdr pane, call herdr_bootstrap_root once,"
say "then herdr_plan -> herdr_dispatch."

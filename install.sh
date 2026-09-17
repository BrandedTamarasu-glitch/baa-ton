#!/usr/bin/env bash
# Baa-ton installer — macOS, Linux, WSL.
# Clones the repo, installs dependencies, links the Pi extension and the
# Herdr controller plugin. Any qualified harness can host the root; non-Pi
# harnesses use root-setup.mjs for MCP configuration.
set -euo pipefail

BAA_TON_DIR="${BAA_TON_DIR:-$HOME/.baa-ton}"
PI_EXT_DIR="${PI_EXTENSIONS_DIR:-$HOME/.pi/agent/extensions}"
REPO="https://github.com/zachristmas/baa-ton"

say() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

welcome() {
  printf '\n🐕  🐑 🐑 🐑 🐑 🐑 🐑\n\n'
  cat <<'EOF'
,-----.    ,---.    ,---.         ,--------. ,-----. ,--.  ,--.
|  |) /_  /  O  \  /  O  \ ,-----.'--.  .--''  .-.  '|  ,'.|  |
|  .-.  \|  .-.  ||  .-.  |'-----'   |  |   |  | |  ||  |' '  |
|  '--' /|  | |  ||  | |  |          |  |   '  '-'  '|  | `   |
`------' `--' `--'`--' `--'          `--'    `-----' `--'  `--'

                 your agent herd is ready
EOF
}

copy_to_clipboard() {
  local value="$1"
  if command -v pbcopy >/dev/null 2>&1; then
    printf '%s' "$value" | pbcopy && return 0
  fi
  if command -v wl-copy >/dev/null 2>&1; then
    printf '%s' "$value" | wl-copy && return 0
  fi
  if command -v xclip >/dev/null 2>&1; then
    printf '%s' "$value" | xclip -selection clipboard && return 0
  fi
  if command -v xsel >/dev/null 2>&1; then
    printf '%s' "$value" | xsel --clipboard --input && return 0
  fi
  if command -v clip.exe >/dev/null 2>&1; then
    printf '%s' "$value" | clip.exe && return 0
  fi
  return 1
}

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
  baa_ton_real="$(cd "$BAA_TON_DIR" && pwd -P)"
  existing="$(herdr plugin list 2>/dev/null | grep -F 'herdr-orchestrator-controller' || true)"
  if [ -n "$existing" ] && ! printf '%s' "$existing" | grep -qF "$baa_ton_real/packages/controller"; then
    say "Controller plugin already linked elsewhere; leaving it alone:"
    printf '      %s\n' "$existing"
    say "To re-point it here instead, run: herdr plugin link \"$BAA_TON_DIR/packages/controller\""
  else
    say "Linking the Herdr event controller plugin"
    herdr plugin link "$BAA_TON_DIR/packages/controller"
  fi
else
  say "Herdr CLI not found. Install Herdr 0.9+ (https://github.com/herdrdev/herdr), then run:"
  printf '      herdr plugin link "%s/packages/controller"\n' "$BAA_TON_DIR"
fi

say "Running the Baa-ton project wizard in $PWD"
if [ -r /dev/tty ] && [ -t 1 ]; then
  node "$BAA_TON_DIR/packages/herdr-tools/setup.mjs" --project-root "$PWD" --prompt-project --quiet < /dev/tty
else
  node "$BAA_TON_DIR/packages/herdr-tools/setup.mjs" --project-root "$PWD" --non-interactive --quiet
fi

root_prompt=$(cat <<EOF
Finish Baa-ton root setup in this Herdr pane.

The installer already configured the selected project and installed the
project-local baa-ton-setup skill for the selected harnesses. Invoke that skill
now. It must read BAA.md, complete the harness-specific connection, restart in
this same Herdr pane only if required, call herdr_bootstrap_root, verify the root
identity, and wait for my task.

Do not ask me to run setup.mjs, initialize a goal, or provide an objective during
setup. If the skill is unavailable, use the installed root-setup helper as the
fallback. Never reset an existing root unless the pane and checkout are
intentionally being replaced.
EOF
)

if copy_to_clipboard "$root_prompt"; then
  :
else
  say "The setup skill was installed, but the optional fallback prompt could not be copied."
fi
welcome
say "Install complete at $PWD"
say "To get started, start your harness in that project and invoke the Baa-ton skill: baa-ton-setup."

#!/bin/sh
# Herdr invokes plugin commands without a shell. Resolve Volta to its concrete
# Node executable, then exec it so a Volta shim cannot remain as a second
# `node controller.mjs supervisor` process after startup.
set -eu

if [ -n "${VOLTA_HOME:-}" ] && [ -x "${VOLTA_HOME}/bin/volta" ]; then
  node_bin="$("${VOLTA_HOME}/bin/volta" which node)"
  if [ -n "${node_bin}" ] && [ -x "${node_bin}" ]; then
    exec "${node_bin}" controller.mjs supervisor
  fi
fi

exec node controller.mjs supervisor

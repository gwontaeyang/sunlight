#!/usr/bin/env bash
# Sunlight — set up and run with a single command (Linux, macOS, WSL).
#
#   ./start.sh
#
# It checks Node, installs dependencies and builds on the first run, then starts
# the app. Open the http://127.0.0.1:… address it prints, and press Ctrl+C to stop.
set -euo pipefail
cd "$(dirname "$0")"

say() { printf '\033[33m%s\033[0m\n' "$*"; }

if ! command -v node >/dev/null 2>&1; then
  say "Node.js is not installed. Install Node 22 (easiest with nvm):"
  echo "  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash"
  echo "  then restart the terminal and run:  nvm install 22 && nvm use 22"
  exit 1
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 22 ]; then
  say "Sunlight needs Node 22 or newer — you have $(node -v)."
  say "With nvm:  nvm install 22 && nvm use 22"
  exit 1
fi

# A broken distro 'npm' (e.g. apt's npm package) is a common trap.
if ! npm --version >/dev/null 2>&1; then
  say "Your 'npm' looks broken — this usually means the Linux distribution's 'npm' package."
  say "Install Node through nvm or from nodejs.org so a matching npm comes with it, then run ./start.sh again."
  exit 1
fi

if [ ! -d node_modules ]; then
  say "Installing dependencies — first run only, this can take a minute…"
  npm ci
fi

if [ ! -d apps/web/dist ]; then
  say "Building the app — first run only…"
  npm run build
fi

say "Starting Sunlight. Open the http://127.0.0.1:… address printed below. Press Ctrl+C to stop."
exec npm run start:user -- --user-data

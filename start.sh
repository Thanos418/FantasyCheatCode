#!/usr/bin/env sh
# Start the week planner (macOS / Linux). Extra arguments are passed through, e.g. ./start.sh --port 9000
cd "$(dirname "$0")" || exit 1
if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 was not found. Install Python 3.8 or newer from https://www.python.org/downloads/"
  exit 1
fi
exec python3 server.py "$@"

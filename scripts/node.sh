#!/bin/sh
set -eu
project_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
if [ -x "$project_root/.runtime/node/bin/node" ]; then
  exec "$project_root/.runtime/node/bin/node" "$@"
fi
if ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 26 ? 0 : 1)'; then
  echo 'Node 26 or newer is required. Run npm run setup:node to install it for this project.' >&2
  exit 1
fi
exec node "$@"

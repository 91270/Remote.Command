#!/bin/bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
exec env NODE_USE_ENV_PROXY="${NODE_USE_ENV_PROXY:-1}" node "$ROOT_DIR/scripts/dev-local.mjs" "$@"

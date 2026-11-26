#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

mkdir -p "${PKG_DIR}/src/wasm"

docker build \
  --file "${SCRIPT_DIR}/Dockerfile.wasm" \
  --output "type=local,dest=${PKG_DIR}/src/wasm" \
  "${PKG_DIR}"

echo "Built tex-fmt WASM artifacts into ${PKG_DIR}/src/wasm:"
ls -lh "${PKG_DIR}/src/wasm"

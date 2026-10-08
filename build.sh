#!/usr/bin/env bash
# build.sh — Emscripten build script for the voxel kernel (src/voxelizer.cpp)
#
# Prerequisites:
#   • Emscripten SDK activated in the current shell:
#       source /path/to/emsdk/emsdk_env.sh
#   • emcc >= 3.1.x
#
# Usage:
#   chmod +x build.sh
#   ./build.sh              # release build → web/voxelizer.js + .wasm
#   ./build.sh --debug      # keep symbols, enable SAFE_HEAP / ASSERTIONS

set -euo pipefail

SRC="src/voxelizer.cpp"
OUT="web/voxelizer"          # emcc appends .js / .wasm automatically

# ─── common flags ────────────────────────────────────────────────────────────
COMMON=(
    # ── C++ standard / optimisation ──────────────────────────────────────────
    -std=c++17
    -O3

    # ── Module / binding settings ─────────────────────────────────────────────
    # MODULARIZE wraps the module in a factory function (importable from Workers)
    # EXPORT_NAME   is the global name / import default
    # lembind       enables Embind (C++ → JS type bridge)
    -s MODULARIZE=1
    -s EXPORT_NAME=VoxelizerModule
    -lembind

    # ── Memory ───────────────────────────────────────────────────────────────
    # Grows on demand; a 512³ grid plus its working buffers needs ~0.5 GB.
    -s INITIAL_MEMORY=64MB
    -s MAXIMUM_MEMORY=2GB
    -s ALLOW_MEMORY_GROWTH=1

    # ── Output format ─────────────────────────────────────────────────────────
    # ES6 module output lets the Worker do:
    #   import VoxelizerModule from './voxelizer.js';
    -s ENVIRONMENT=worker
    -s EXPORT_ES6=1

    # ── Misc ──────────────────────────────────────────────────────────────────
    -s INCOMING_MODULE_JS_API=[]   # VoxelizerModule() takes no options
)

# ─── debug flags (passed with ./build.sh --debug) ────────────────────────────
DEBUG=(
    -O0
    -g
    -s ASSERTIONS=2
    -s SAFE_HEAP=1
    -s STACK_OVERFLOW_CHECK=2
)

# ─── build ───────────────────────────────────────────────────────────────────
EXTRA_FLAGS=()
if [[ "${1:-}" == "--debug" ]]; then
    echo ">>> Debug build"
    EXTRA_FLAGS=("${DEBUG[@]}")   # its -O0 comes last, so it overrides -O3
else
    echo ">>> Release build"
fi

# em++ (not emcc) so the C++ standard library is linked.
em++ "${COMMON[@]}" ${EXTRA_FLAGS[@]+"${EXTRA_FLAGS[@]}"} \
     -o "${OUT}.js" \
     "${SRC}"

echo ""
echo "✓ Build complete:"
echo "    ${OUT}.js"
echo "    ${OUT}.wasm"

#!/usr/bin/env bash
# build.sh — Emscripten build script for the GLB/GLTF → VOX converter
#
# Prerequisites:
#   • Emscripten SDK activated in the current shell:
#       source /path/to/emsdk/emsdk_env.sh
#   • emcc >= 3.1.x
#   • tiny_gltf.h placed at src/tiny_gltf.h
#       https://github.com/syoyo/tinygltf/blob/master/tiny_gltf.h
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

    # ── Include paths ─────────────────────────────────────────────────────────
    # Allows voxelizer.cpp to resolve:
    #   #include "tiny_gltf.h"   →  src/tiny_gltf.h
    -I src

    # ── Module / binding settings ─────────────────────────────────────────────
    # MODULARIZE wraps the module in a factory function (importable from Workers)
    # EXPORT_NAME   is the global name / import default
    # lembind       enables Embind (C++ → JS type bridge)
    -s MODULARIZE=1
    -s EXPORT_NAME=VoxelizerModule
    -lembind
    

    # ── Memory ───────────────────────────────────────────────────────────────
    # 256 MB initial to avoid frequent reallocs on large GLB files.
    -s INITIAL_MEMORY=256MB
    -s MAXIMUM_MEMORY=1GB
    -s ALLOW_MEMORY_GROWTH=1

    # ── Output format ─────────────────────────────────────────────────────────
    # ES6 module output lets the Worker do:
    #   import VoxelizerModule from './voxelizer.js';
    -s ENVIRONMENT=worker
    -s EXPORT_ES6=1

    # ── Misc ──────────────────────────────────────────────────────────────────
    -s FORCE_FILESYSTEM=0          # no virtual FS needed (GLB loaded from JS)
    -s INCOMING_MODULE_JS_API=[]   # silence unused-import warnings

    # Expose malloc/free and HEAPU8 so worker.js can copy ArrayBuffers into
    # Wasm memory without relying on Embind's typed_memory_view write path.
    -s EXPORTED_FUNCTIONS=_malloc,_free
    -s EXPORTED_RUNTIME_METHODS=HEAPU8
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
    # Override -O3 with -O0 and add checks
    COMMON[1]="-O0"   # slot 1 = -O3
    EXTRA_FLAGS=("${DEBUG[@]}")
else
    echo ">>> Release build"
fi

emcc "${COMMON[@]}" ${EXTRA_FLAGS[@]+"${EXTRA_FLAGS[@]}"} \
     -o "${OUT}.js" \
     "${SRC}"

echo ""
echo "✓ Build complete:"
echo "    ${OUT}.js"
echo "    ${OUT}.wasm"
echo ""
echo "─────────────────────────────────────────────────────────────────────────"
echo " IMPORTANT — Cross-Origin Isolation headers required"
echo "─────────────────────────────────────────────────────────────────────────"
echo " SharedArrayBuffer (needed by pthreads/OpenMP) is only available when"
echo " the page is cross-origin isolated. Your server MUST send:"
echo ""
echo "   Cross-Origin-Opener-Policy:   same-origin"
echo "   Cross-Origin-Embedder-Policy: credentialless"
echo ""
echo " NOTE: 'credentialless' (not 'require-corp') is used so that the"
echo " Lospec palette API can be fetched cross-origin without CORP headers."
echo " It still satisfies SharedArrayBuffer requirements in Chrome, Firefox,"
echo " and Safari 15.2+."
echo ""
echo " The included Node.js dev server (server/server.js) sets these headers."
echo " For Nginx add to the location block:"
echo "   add_header Cross-Origin-Opener-Policy   'same-origin';"
echo "   add_header Cross-Origin-Embedder-Policy 'credentialless';"
echo ""
echo " For Apache add to .htaccess or VirtualHost:"
echo "   Header always set Cross-Origin-Opener-Policy   'same-origin'"
echo "   Header always set Cross-Origin-Embedder-Policy 'credentialless'"
echo "─────────────────────────────────────────────────────────────────────────"

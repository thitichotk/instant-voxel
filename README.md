# VOXY 🧊

![C++](https://img.shields.io/badge/C++-00599C?style=flat-square&logo=c%2B%2B&logoColor=white)
![WebAssembly](https://img.shields.io/badge/WebAssembly-654FF0?style=flat-square&logo=webassembly&logoColor=white)
![Build: Passing](https://img.shields.io/badge/build-passing-brightgreen?style=flat-square)

Turn 3D models, images and AI-generated objects into voxel art, right in the browser. A C++ kernel compiled to WebAssembly does the voxelizing; three.js handles file formats, preview and mesh export.

## 🚀 Features

- **Any 3D model in:** GLB, glTF (+ .bin / textures), OBJ + MTL, FBX, STL, PLY, 3MF and DAE. Voxel colours are sampled per voxel from textures, vertex colours and materials.
- **Images in:** pixel art extruded voxel-for-voxel, or grayscale heightmaps as terrain.
- **AI generation:**
  - *In-browser:* a photo becomes a voxel relief, using Depth Anything V2 on your GPU. There's no server, and the model is cached after its first download.
  - *Model server:* a photo or a text prompt becomes a full 3D object via Stable Fast 3D, running on your machine (see [`server/`](server/README.md)). The same API can later run on a hosted GPU.
- **Voxelize your way:** up to 512 voxels per side, solid fill, hollow shells, removal of floating islands, and a ghost overlay of the source.
- **Colour control:** automatic palettes (Oklab median cut), Minecraft blocks, a default cube or any `.hex` palette, with optional dithering.
- **Touch-up editor:** paint, erase, add, fill, eyedropper and box tools. Brush sizes, X/Z mirroring, and undo/redo.
- **Export:** MagicaVoxel `.vox` (including multi-model scenes over 256), `.glb` for game engines, `.obj` for Blender, `.stl` for 3D printing, and `.schem` for Minecraft (WorldEdit / Litematica).

## 🛠 Getting Started

> **Note:** The C++ core source code is not included in this repository. This project relies entirely on the pre-compiled WebAssembly binaries provided in the `web/` directory.

### Prerequisites

- Python 3, or any static file server (the app needs no special headers)
- Optional: the [model server](server/README.md) for photo/text → 3D

### Quick Start

1. **Start the local server:**
   ```bash
   python3 -m http.server -b 127.0.0.1 -d web 3000
   ```
   It doesn't send `Cache-Control: no-store`, so while editing keep DevTools open with **Network → Disable cache** ticked, or the browser may keep serving stale JS/CSS.

2. **Open the app:**
   Visit `http://127.0.0.1:3000`.

## 📁 Structure

- `web/` — the app: HTML, CSS, JS modules, and the pre-compiled Wasm kernel.
- `server/` — optional Python model server for AI generation.
- `tests/run.mjs` — self-checks for the kernel and the pure modules. Run `node tests/run.mjs`; CI runs it before deploying.

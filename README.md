# VOXY 🧊

![C++](https://img.shields.io/badge/C++-00599C?style=flat-square&logo=c%2B%2B&logoColor=white)
![WebAssembly](https://img.shields.io/badge/WebAssembly-654FF0?style=flat-square&logo=webassembly&logoColor=white)
![Build: Passing](https://img.shields.io/badge/build-passing-brightgreen?style=flat-square)

A highly performant, web-based 3D voxelizer. VOXY uses a C++ core for fast processing to convert 3D models into voxel grids, accessible entirely through a web browser interface.

## 🚀 Features

- **Blazing Fast:** Core parsing and voxelization powered by C++.
- **Interactive Web UI:** Real-time 3D preview of voxelized models right in your browser.
- **Client-Side Processing:** Leverages WebAssembly (Wasm) and Web Workers for a smooth, non-blocking experience.

## 🛠 Getting Started

> **Note:** The C++ core source code is not included in this repository. This project relies entirely on the pre-compiled WebAssembly binaries provided in the `web/` directory.

### Prerequisites

- Python 3, or any static file server (the app needs no special headers)

### Quick Start

1. **Start the local server:**
   ```bash
   python3 -m http.server -b 127.0.0.1 -d web 3000
   ```
   It doesn't send `Cache-Control: no-store`, so while editing keep DevTools open with **Network → Disable cache** ticked, or the browser may keep serving stale JS/CSS.

2. **Open the app:**
   Visit `http://127.0.0.1:3000`.

## 📁 Structure

- `web/` - Frontend assets (HTML, CSS, JS, pre-compiled Wasm core, Workers).

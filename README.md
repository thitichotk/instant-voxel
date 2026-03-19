# VOXY 🧊

![C++](https://img.shields.io/badge/C++-00599C?style=flat-square&logo=c%2B%2B&logoColor=white)
![WebAssembly](https://img.shields.io/badge/WebAssembly-654FF0?style=flat-square&logo=webassembly&logoColor=white)
![Node.js](https://img.shields.io/badge/Node.js-43853D?style=flat-square&logo=node.js&logoColor=white)
![Build: Passing](https://img.shields.io/badge/build-passing-brightgreen?style=flat-square)

A highly performant, web-based 3D voxelizer. VOXY uses a C++ core for fast processing to convert 3D models into voxel grids, accessible entirely through a web browser interface.

## 🚀 Features

- **Blazing Fast:** Core parsing and voxelization powered by C++.
- **Interactive Web UI:** Real-time 3D preview of voxelized models right in your browser.
- **Client-Side Processing:** Leverages WebAssembly (Wasm) and Web Workers for a smooth, non-blocking experience.

## 🛠 Getting Started

> **Note:** The C++ core source code is not included in this repository. This project relies entirely on the pre-compiled WebAssembly binaries provided in the `web/` directory.

### Prerequisites

- [Node.js](https://nodejs.org/) (for the local dev server)

### Quick Start

1. **Start the local server:**
   ```bash
   cd server
   npm install
   npm start
   ```

2. **Open the app:**
   Visit `http://localhost:3000` (or whichever port the server listens on).

## 📁 Structure

- `web/` - Frontend assets (HTML, CSS, JS, pre-compiled Wasm core, Workers).
- `server/` - Node.js backend.

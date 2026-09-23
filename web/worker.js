/**
 * worker.js — Web Worker: owns the Wasm module lifecycle.
 *
 * Protocol (main thread → worker):
 *   { type: 'init' }
 *     Eagerly initialise the Wasm module (warm-up). Safe to post multiple times.
 *
 *   { type: 'convert', id: number, glbBuffer: ArrayBuffer,
 *     palBuffer: ArrayBuffer, gridSize: number, rotX: number, rotY: number }
 *     Run voxelisation. glbBuffer is a transferred ArrayBuffer of the raw
 *     .glb bytes.  palBuffer holds flat RGBA bytes (256×4, built by main.js
 *     from the uploaded .hex palette), or is zero-length for the default
 *     palette.
 *
 * Protocol (worker → main thread):
 *   { type: 'ready' }
 *   { type: 'result', id: number, voxBuffer: ArrayBuffer }  (transferred)
 *   { type: 'error',  id: number|null, message: string }
 */

import VoxelizerModule from './voxelizer.js';

// ── Module singleton ──────────────────────────────────────────────────────────
//
//  A shared Promise so concurrent 'init' / 'convert' messages race-freely:
//  every caller awaits the same Promise rather than starting a second load.

let Module      = null;
let initPromise = null;

function initModule() {
    if (initPromise) return initPromise;

    initPromise = VoxelizerModule().then((mod) => {
        Module = mod;
        self.postMessage({ type: 'ready' });
    }).catch((err) => {
        self.postMessage({ type: 'error', id: null, message: String(err) });
        // Reset so a future 'init' can retry.
        initPromise = null;
        throw err;
    });

    return initPromise;
}

// ── Conversion handler ────────────────────────────────────────────────────────

async function runConvert({ id, glbBuffer, palBuffer, gridSize, rotX, rotY }) {
    try {
        await initModule();

        // Embind copies both buffers into Wasm memory (std::string params).
        // The return value is a live view into g_result (a module-level static
        // vector), so .slice() it before making another call.
        const voxBytes = Module.convertGLBToVox(glbBuffer, palBuffer, gridSize, rotX, rotY).slice();

        // Zero-copy transfer back to the main thread.
        self.postMessage(
            { type: 'result', id, voxBuffer: voxBytes.buffer },
            [voxBytes.buffer]
        );

    } catch (err) {
        self.postMessage({ type: 'error', id, message: String(err) });
    }
}

// ── Message dispatcher ────────────────────────────────────────────────────────

self.addEventListener('message', (e) => {
    const msg = e.data;
    switch (msg.type) {
        case 'init':
            initModule();
            break;
        case 'convert':
            runConvert(msg);
            break;
        default:
            console.warn('[worker] unknown message type:', msg.type);
    }
});

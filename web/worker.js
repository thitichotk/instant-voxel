/**
 * worker.js — Web Worker: owns the Wasm module lifecycle.
 *
 * Protocol (main thread → worker), one message kind:
 *   { glbBuffer: ArrayBuffer, palBuffer: Uint8Array, gridSize: number,
 *     rotX: number, rotY: number }
 *     Run voxelisation. glbBuffer is a transferred ArrayBuffer of the raw
 *     .glb bytes.  palBuffer holds flat RGBA bytes (256×4, built by main.js
 *     from the uploaded .hex palette), or is zero-length for the default
 *     palette.
 *
 * Protocol (worker → main thread):
 *   { type: 'ready' }                             (once the Wasm has loaded)
 *   { type: 'result', voxBuffer: ArrayBuffer }    (transferred)
 *   { type: 'error',  message: string }
 */

import VoxelizerModule from './voxelizer.js';

// ── Module singleton ──────────────────────────────────────────────────────────
//
//  Loading starts as soon as the worker does. Every conversion awaits the same
//  Promise; a failed load clears it so the next conversion retries.

let initPromise = null;

function initModule() {
    initPromise ??= VoxelizerModule().then((mod) => {
        self.postMessage({ type: 'ready' });
        return mod;
    }).catch((err) => {
        self.postMessage({ type: 'error', message: String(err) });
        initPromise = null;
        throw err;
    });
    return initPromise;
}

initModule();

// ── Conversion handler ────────────────────────────────────────────────────────

self.onmessage = async ({ data: { glbBuffer, palBuffer, gridSize, rotX, rotY } }) => {
    try {
        const Module = await initModule();

        // Embind copies both buffers into Wasm memory (std::string params).
        // The return value is a live view into g_result (a module-level static
        // vector), so .slice() it before making another call.
        const voxBytes = Module.convertGLBToVox(glbBuffer, palBuffer, gridSize, rotX, rotY).slice();

        // Zero-copy transfer back to the main thread.
        self.postMessage({ type: 'result', voxBuffer: voxBytes.buffer }, [voxBytes.buffer]);

    } catch (err) {
        self.postMessage({ type: 'error', message: String(err) });
    }
};

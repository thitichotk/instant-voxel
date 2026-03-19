/**
 * worker.js — Web Worker: owns the Wasm module lifecycle.
 *
 * Protocol (main thread → worker):
 *   { type: 'init' }
 *     Eagerly initialise the Wasm module (warm-up). Safe to post multiple times.
 *
 *   { type: 'convert', id: number, glbBuffer: ArrayBuffer,
 *     palBuffer: ArrayBuffer, gridSize: number }
 *     Run voxelisation. glbBuffer is a transferred ArrayBuffer of the raw
 *     .glb/.gltf bytes.  palBuffer is a transferred ArrayBuffer of flat RGBA
 *     bytes (n×4, built by main.js from the Lospec API result). Either may be
 *     zero-length.
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

    initPromise = VoxelizerModule({
        locateFile: (path) => new URL(path, import.meta.url).href,
        print:    (...args) => console.log('[wasm]',  ...args),
        printErr: (...args) => console.warn('[wasm]', ...args),
    }).then((mod) => {
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

async function runConvert({ id, glbBuffer, palBuffer, gridSize, rotX, rotY, exportFormat }) {
    try {
        await initModule();

        const glbBytes = new Uint8Array(glbBuffer);
        const palBytes = new Uint8Array(palBuffer);

        console.log('[worker] glbBytes.byteLength:', glbBytes.byteLength,
                    '| _malloc:', typeof Module._malloc,
                    '| HEAPU8:', Module.HEAPU8 ? 'ok len='+Module.HEAPU8.length : 'MISSING');

        // Copy both buffers into Wasm memory via Module._malloc + HEAPU8.set.
        // This is the canonical Emscripten pattern and avoids any val/TypedArray
        // write-back issues in Emscripten 5.x.
        const glbPtr = Module._malloc(glbBytes.byteLength || 1);
        if (glbBytes.byteLength) Module.HEAPU8.set(glbBytes, glbPtr);

        const palPtr = Module._malloc(palBytes.byteLength || 1);
        if (palBytes.byteLength) Module.HEAPU8.set(palBytes, palPtr);

        // convertGLBToVox(glbPtr, glbLen, palPtr, palLen, gridSize, rotX, rotY, exportFormat) → typed_memory_view
        //
        // The return value is a live view into g_result (a module-level static
        // vector). We must .slice() before freeing or making another call.
        const memView  = Module.convertGLBToVox(
            glbPtr, glbBytes.byteLength,
            palPtr, palBytes.byteLength,
            gridSize,
            rotX || 0,
            rotY || 0,
            exportFormat || 0
        );
        const voxBytes = memView.slice();

        Module._free(glbPtr);
        Module._free(palPtr);

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

/**
 * main.js — Main-thread controller.
 *
 * Responsibilities:
 *  • Manage the single Web Worker instance (GLB → VOX).
 *  • Fetch Lospec palette slugs and convert hex colours → RGBA Uint8Array.
 *  • Build and transfer ArrayBuffers to the Worker (zero-copy hand-off).
 *  • Receive VOX ArrayBuffers and pass them to the Three.js preview module.
 *  • Wire all DOM controls to application state.
 */

import { initPreview, updatePreview, setPaintMode, setPaintColor, setBlockLines } from './preview.js';

// ── Application state ─────────────────────────────────────────────────────────

const state = {
    glbFile:     null,   // File  — current GLB/GLTF handle
    palBuffer:   null,   // Uint8Array | null — flat RGBA bytes from Lospec (n×4)
    gridSize:    32,
    lastVoxBuf:  null,   // ArrayBuffer | null — last successful output (for download)
    converting:  false,
    rotX:        0,      // Custom X rotation in degrees
    rotY:        0,      // Custom Y rotation in degrees
};

let pendingConvertId = 0;

// ── Web Worker ────────────────────────────────────────────────────────────────

const worker = new Worker(
    new URL('./worker.js', import.meta.url),
    { type: 'module' }
);

const pendingResolvers = new Map();   // id → { resolve, reject }

worker.addEventListener('message', (e) => {
    const msg = e.data;
    switch (msg.type) {
        case 'ready':
            setStatus('Wasm ready.', 'ok');
            enableConvertIfReady();
            break;

        case 'result': {
            const h = pendingResolvers.get(msg.id);
            if (h) { pendingResolvers.delete(msg.id); h.resolve(msg.voxBuffer); }
            break;
        }
        case 'error': {
            const h = pendingResolvers.get(msg.id);
            if (h) { pendingResolvers.delete(msg.id); h.reject(new Error(msg.message)); }
            else    setStatus(`Worker: ${msg.message}`, 'error');
            break;
        }
    }
});

worker.addEventListener('error', (e) =>
    setStatus(`Uncaught worker error: ${e.message}`, 'error')
);

// Warm up the Wasm module immediately on page load.
worker.postMessage({ type: 'init' });

/**
 * Post a GLB buffer + RGBA palette buffer to the Worker, return Promise<ArrayBuffer>.
 * Both buffers are TRANSFERRED — caller must not use them after this call.
 */
function workerConvert(glbBuffer, palBuffer, gridSize) {
    return new Promise((resolve, reject) => {
        const id = ++pendingConvertId;
        pendingResolvers.set(id, { resolve, reject });

        const emptyPal = new ArrayBuffer(0);
        const palBuf   = (palBuffer && palBuffer.byteLength) ? palBuffer : emptyPal;

        const transferList = [glbBuffer];
        if (palBuf.byteLength) transferList.push(palBuf);

        worker.postMessage(
            { 
                type: 'convert', 
                id, 
                glbBuffer, 
                palBuffer: palBuf, 
                gridSize,
                rotX: state.rotX,
                rotY: state.rotY
            },
            transferList
        );
    });
}

// ── HEX palette parser ────────────────────────────────────────────────────────

/**
 * Parse a standard .hex file (newline-delimited hex color codes)
 * Returns { rgba: Uint8Array, colors: string[], name: string }
 */
async function parseHexFile(file) {
    const text = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload  = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error);
        reader.readAsText(file);
    });

    const lines = text.split('\n');
    const colors = [];
    
    for (let line of lines) {
        let hex = line.trim();
        if (hex.startsWith('#')) hex = hex.slice(1);
        // Basic validation for 6-char hex
        if (hex.length === 6 && /^[0-9a-fA-F]{6}$/.test(hex)) {
            colors.push(hex.toLowerCase());
        }
    }

    if (colors.length === 0) {
        throw new Error('No valid hex colors found in file.');
    }

    // Limit to 255 colors because MagicaVoxel format reserves index 0
    if (colors.length > 255) {
        colors.length = 255;
    }

    return {
        rgba:   buildPaletteBuffer(colors),
        colors: colors,
        name:   file.name.replace(/\.[^/.]+$/, "") // remove extension
    };
}

/**
 * Convert an array of hex strings (without '#') to a 256-entry RGBA Uint8Array
 * by tiling the source palette to fill all 256 slots.
 * Palette entry 0 is reserved (MagicaVoxel convention) and set to transparent.
 */
function buildPaletteBuffer(colors) {
    const buf = new Uint8Array(256 * 4);
    // Entry 0: reserved (transparent black)
    buf[0] = buf[1] = buf[2] = buf[3] = 0;

    const n = colors.length;
    for (let i = 1; i < 256; i++) {
        const hex = colors[(i - 1) % n];
        buf[i*4+0] = parseInt(hex.slice(0, 2), 16);
        buf[i*4+1] = parseInt(hex.slice(2, 4), 16);
        buf[i*4+2] = parseInt(hex.slice(4, 6), 16);
        buf[i*4+3] = 255;
    }
    return buf;
}

// ── DOM helpers ───────────────────────────────────────────────────────────────

const $  = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

function setStatus(msg, level = 'info') {
    const dot  = $('#status-dot');
    const text = $('#status-text');
    if (!dot || !text) return;

    text.textContent  = msg;
    text.className    = level;
    dot.className     = `status-dot ${level}`;

    // Pulse the dot while converting.
    if (level === 'info') dot.classList.add('pulse');
}

function setProgress(pct) {
    const bar = $('#progress-fill');
    if (bar) bar.style.width = `${pct}%`;
}

function enableConvertIfReady() {
    const btn = $('#btn-convert');
    if (btn) btn.disabled = !state.glbFile;
}

function readFile(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload  = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error);
        reader.readAsArrayBuffer(file);
    });
}

function debounce(fn, ms) {
    let t;
    return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

// ── Swatch renderer ───────────────────────────────────────────────────────────

function renderSwatches(colors, name) {
    const container = $('#palette-swatches');
    const nameEl    = $('#palette-name');
    if (!container) return;

    container.innerHTML = colors.map((hex, i) =>
        `<div class="swatch ${i === 0 ? 'active' : ''}" style="background:#${hex}" title="#${hex}" data-index="${i + 1}"></div>`
    ).join('');
    container.classList.toggle('has-colors', colors.length > 0);

    // Default select first color
    if (colors.length > 0) {
        setPaintColor(1);
    }

    // Attach click events
    const swatches = container.querySelectorAll('.swatch');
    swatches.forEach(swatch => {
        swatch.addEventListener('click', (e) => {
            swatches.forEach(s => s.classList.remove('active'));
            e.target.classList.add('active');
            const idx = parseInt(e.target.getAttribute('data-index'), 10);
            setPaintColor(idx);
        });
    });

    if (nameEl) nameEl.textContent = name || '';
}

// ── Slider fill-track updater ─────────────────────────────────────────────────

function updateSliderFill(slider) {
    const min = parseFloat(slider.min);
    const max = parseFloat(slider.max);
    const val = parseFloat(slider.value);
    const pct = ((val - min) / (max - min) * 100).toFixed(2);
    slider.style.setProperty('--pct', `${pct}%`);
}

// ── Main conversion pipeline ──────────────────────────────────────────────────

async function runConversion() {
    if (state.converting || !state.glbFile) return;

    state.converting = true;
    setStatus('Reading model…', 'info');
    setProgress(10);
    $('#btn-convert').disabled = true;

    try {
        // Re-read each time so the ArrayBuffer can be transferred (detached).
        const glbBuf = await readFile(state.glbFile);

        setProgress(25);
        setStatus('Voxelising…', 'info');

        // palBuffer: copy from state so the state reference survives for future runs.
        const palBuf = state.palBuffer
            ? state.palBuffer.buffer.slice(0)   // detachable copy
            : new ArrayBuffer(0);

        setProgress(35);

        const voxBuffer = await workerConvert(glbBuf, palBuf, state.gridSize);

        setProgress(90);
        state.lastVoxBuf = voxBuffer;

        const stats = await updatePreview(voxBuffer);

        document.dispatchEvent(new CustomEvent('vox-updated', {
            detail: {
                voxCount: stats?.voxCount ?? 0,
                sizeX:    stats?.sizeX    ?? 0,
                sizeY:    stats?.sizeY    ?? 0,
                sizeZ:    stats?.sizeZ    ?? 0,
                byteLen:  voxBuffer.byteLength,
            },
        }));

        setProgress(100);
        setStatus(`Done — ${(voxBuffer.byteLength / 1024).toFixed(1)} KB`, 'ok');
        $('#btn-download').disabled = false;

    } catch (err) {
        setStatus(err.message, 'error');
        console.error('[main] conversion error:', err);

    } finally {
        state.converting = false;
        enableConvertIfReady();
        setTimeout(() => setProgress(0), 900);
    }
}

const debouncedConvert = debounce(runConversion, 150);

// ── HEX palette upload handler ──────────────────────────────────────────────────

async function handlePaletteUpload(file) {
    if (!file) return;
    try {
        setStatus(`Parsing palette "${file.name}"…`, 'info');
        const { rgba, colors, name } = await parseHexFile(file);

        state.palBuffer = rgba;
        renderSwatches(colors, name);

        setStatus(`Palette "${name}" loaded (${colors.length} colours).`, 'ok');

        const dropName = $('#drop-name-pal');
        if (dropName) dropName.textContent = file.name;
        const dropZone = $('#drop-zone-pal');
        if (dropZone) dropZone.classList.add('loaded');

        // Trigger a new conversion immediately if a model is already loaded.
        if (state.glbFile) {
            // Need to voxelise again so the backend uses the new palette mapping
            debouncedConvert();
        }

    } catch (err) {
        renderSwatches([], '');
        state.palBuffer = null;
        setStatus(err.message, 'error');
        const dropZone = $('#drop-zone-pal');
        if (dropZone) dropZone.classList.remove('loaded');
    }
}

// ── DOM event wiring ──────────────────────────────────────────────────────────

function wireDom() {
    // ── GLB file input ─────────────────────────────────────────────
    const inputGlb  = $('#input-glb');
    const dropZone  = $('#drop-zone');
    const dropName  = $('#drop-name');

    function applyGlbFile(file) {
        if (!file) return;
        if (!/\.glb$/i.test(file.name)) {
            setStatus('Only .glb files are supported', 'error');
            return;
        }
        state.glbFile = file;
        dropName.textContent = file.name;
        dropZone.classList.add('loaded');
        enableConvertIfReady();
        debouncedConvert();
    }

    inputGlb.addEventListener('change', (e) =>
        applyGlbFile(e.target.files[0] ?? null)
    );

    // Native drag-and-drop directly onto the drop zone.
    dropZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropZone.classList.add('dragging');
    });
    dropZone.addEventListener('dragleave', () =>
        dropZone.classList.remove('dragging')
    );
    dropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropZone.classList.remove('dragging');
        const file = e.dataTransfer?.files[0];
        if (file && /\.glb$/i.test(file.name)) applyGlbFile(file);
    });

    // ── Palette file input ────────────────────────────────────────────────
    const inputPal = $('#input-pal');
    const dropZonePal = $('#drop-zone-pal');

    if (inputPal && dropZonePal) {
        inputPal.addEventListener('change', (e) => handlePaletteUpload(e.target.files[0]));
        dropZonePal.addEventListener('click', () => {
            // Prevent interference if clicking inside but not on input, optional
        });
        dropZonePal.addEventListener('dragover', (e) => { e.preventDefault(); dropZonePal.classList.add('dragging'); });
        dropZonePal.addEventListener('dragleave', () => dropZonePal.classList.remove('dragging'));
        dropZonePal.addEventListener('drop', (e) => {
            e.preventDefault();
            dropZonePal.classList.remove('dragging');
            if (e.dataTransfer.files.length) handlePaletteUpload(e.dataTransfer.files[0]);
        });
    }

    // ── Paint toggle ──────────────────────────────────────────────────────
    const togglePaint = $('#toggle-paint');
    if (togglePaint) {
        togglePaint.addEventListener('change', (e) => {
            setPaintMode(e.target.checked);
        });
    }

    // ── Lines toggle ──────────────────────────────────────────────────────
    const toggleLines = $('#toggle-lines');
    if (toggleLines) {
        toggleLines.addEventListener('change', (e) => {
            setBlockLines(e.target.checked);
        });
    }

    // ── Resolution slider ─────────────────────────────────────────────────
    const slider    = $('#slider-grid');
    const sliderVal = $('#slider-value');

    slider.addEventListener('input', () => {
        state.gridSize = parseInt(slider.value, 10);
        if (sliderVal) sliderVal.textContent = state.gridSize;
        updateSliderFill(slider);
        if (state.glbFile) debouncedConvert();
    });

    // Initialise slider fill on load.
    updateSliderFill(slider);

    // ── Convert & download ────────────────────────────────────────────────
    $('#btn-convert').addEventListener('click', runConversion);

    $('#btn-download').addEventListener('click', () => {
        if (!state.lastVoxBuf) return;
        const baseName = state.glbFile
            ? state.glbFile.name.replace(/\.[^.]+$/, '')
            : 'model';
        const blob = new Blob([state.lastVoxBuf], { type: 'application/octet-stream' });
        const a = Object.assign(document.createElement('a'), {
            href:     URL.createObjectURL(blob),
            download: `${baseName}_${state.gridSize}.vox`,
        });
        a.click();
        URL.revokeObjectURL(a.href);
    });

    // ── Rotate Gizmos ─────────────────────────────────────────────────────
    const btnRotX = $('#btn-rotate-x');
    const btnRotY = $('#btn-rotate-y');

    if (btnRotX) {
        btnRotX.addEventListener('click', () => {
            state.rotX = (state.rotX + 90) % 360;
            if (state.glbFile) debouncedConvert();
        });
    }

    if (btnRotY) {
        btnRotY.addEventListener('click', () => {
            state.rotY = (state.rotY + 90) % 360;
            if (state.glbFile) debouncedConvert();
        });
    }
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
    await initPreview(document.getElementById('canvas-container'));
    wireDom();
    setStatus('Initialising Wasm module…', 'info');
});

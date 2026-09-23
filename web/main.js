/**
 * main.js — Main-thread controller.
 *
 * Responsibilities:
 *  • Manage the single Web Worker instance (GLB → VOX).
 *  • Parse uploaded .hex palettes into 256×4 RGBA bytes.
 *  • Hand buffers to the Worker (the GLB is transferred, zero-copy).
 *  • Receive VOX ArrayBuffers and pass them to the Three.js preview module.
 *  • Wire all DOM controls to application state.
 */

import { initPreview, updatePreview, setPaintMode, setPaintColor, setBlockLines } from './preview.js';

// ── Application state ─────────────────────────────────────────────────────────

const state = {
    glbFile:     null,   // File  — current GLB handle
    palBuffer:   null,   // Uint8Array | null — 256×4 RGBA bytes from the .hex palette
    gridSize:    32,
    lastVoxBuf:  null,   // ArrayBuffer | null — last successful output (for download)
    converting:  false,
    rotX:        0,      // Custom X rotation in degrees
    rotY:        0,      // Custom Y rotation in degrees
};

// ── Web Worker ────────────────────────────────────────────────────────────────

const worker = new Worker(
    new URL('./worker.js', import.meta.url),
    { type: 'module' }
);

// state.converting allows one conversion in flight, so one slot is enough.
let pending = null;   // { resolve, reject } | null

worker.addEventListener('message', (e) => {
    const msg = e.data;
    switch (msg.type) {
        case 'ready':
            setStatus('Wasm ready.', 'ok');
            enableConvertIfReady();
            break;

        case 'result':
            pending?.resolve(msg.voxBuffer);
            pending = null;
            break;

        case 'error':
            if (pending) pending.reject(new Error(msg.message));
            else         setStatus(`Worker: ${msg.message}`, 'error');
            pending = null;
            break;
    }
});

worker.addEventListener('error', (e) =>
    setStatus(`Uncaught worker error: ${e.message}`, 'error')
);

/**
 * Post a GLB buffer to the Worker, return Promise<ArrayBuffer>.
 * glbBuffer is TRANSFERRED — caller must not use it after this call. The
 * 1 KB palette is simply copied.
 */
function workerConvert(glbBuffer) {
    return new Promise((resolve, reject) => {
        pending = { resolve, reject };
        worker.postMessage({
            glbBuffer,
            palBuffer: state.palBuffer ?? new Uint8Array(0),
            gridSize:  state.gridSize,
            rotX:      state.rotX,
            rotY:      state.rotY,
        }, [glbBuffer]);
    });
}

// ── HEX palette parser ────────────────────────────────────────────────────────

/**
 * Parse a standard .hex file (newline-delimited hex color codes)
 * Returns { rgba: Uint8Array, colors: string[], name: string }
 */
async function parseHexFile(file) {
    const colors = (await file.text()).split('\n')
        .map((line) => line.trim().replace(/^#/, '').toLowerCase())
        .filter((hex) => /^[0-9a-f]{6}$/.test(hex))
        .slice(0, 255);   // MagicaVoxel reserves index 0, so 255 colours max

    if (colors.length === 0) {
        throw new Error('No valid hex colors found in file.');
    }

    return {
        rgba:   buildPaletteBuffer(colors),
        colors,
        name:   file.name.replace(/\.[^/.]+$/, ""), // remove extension
    };
}

/**
 * Convert an array of hex strings (without '#') to a 256-entry RGBA Uint8Array
 * by tiling the source palette to fill all 256 slots.
 * Palette entry 0 is reserved (MagicaVoxel convention) and set to transparent.
 */
function buildPaletteBuffer(colors) {
    const buf = new Uint8Array(256 * 4);   // zero-filled: entry 0 stays transparent black

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

const $ = (sel) => document.querySelector(sel);

function setStatus(msg, level = 'info') {
    const dot  = $('#status-dot');
    const text = $('#status-text');

    text.textContent  = msg;
    text.className    = level;
    dot.className     = `status-dot ${level}`;

    // Pulse the dot while converting.
    if (level === 'info') dot.classList.add('pulse');
}

function setProgress(pct) {
    $('#progress-fill').style.width = `${pct}%`;
}

function enableConvertIfReady() {
    $('#btn-convert').disabled = !state.glbFile;
}

function debounce(fn, ms) {
    let t;
    return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

// ── Swatch renderer ───────────────────────────────────────────────────────────

function renderSwatches(colors, name) {
    const container = $('#palette-swatches');

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

    $('#palette-name').textContent = name || '';
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
        const glbBuf = await state.glbFile.arrayBuffer();

        setStatus('Voxelising…', 'info');
        setProgress(35);

        const voxBuffer = await workerConvert(glbBuf);

        setProgress(90);
        state.lastVoxBuf = voxBuffer;

        const stats = await updatePreview(voxBuffer) ?? { voxCount: 0, sizeX: 0, sizeY: 0, sizeZ: 0 };
        const bytes = voxBuffer.byteLength;

        $('#hint-overlay').classList.add('hidden');
        $('#stat-count').textContent = stats.voxCount.toLocaleString();
        $('#stat-size').textContent  = `${stats.sizeX} × ${stats.sizeY} × ${stats.sizeZ}`;
        $('#stat-bytes').textContent = bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${bytes} B`;

        setProgress(100);
        setStatus(`Done — ${(bytes / 1024).toFixed(1)} KB`, 'ok');
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

        $('#drop-name-pal').textContent = file.name;
        $('#drop-zone-pal').classList.add('loaded');

        // Trigger a new conversion immediately if a model is already loaded.
        if (state.glbFile) {
            // Need to voxelise again so the backend uses the new palette mapping
            debouncedConvert();
        }

    } catch (err) {
        renderSwatches([], '');
        state.palBuffer = null;
        setStatus(err.message, 'error');
        $('#drop-zone-pal').classList.remove('loaded');
    }
}

// ── DOM event wiring ──────────────────────────────────────────────────────────

function wireDom() {
    // ── GLB file input ─────────────────────────────────────────────
    $('#input-glb').addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;
        if (!/\.glb$/i.test(file.name)) {
            setStatus('Only .glb files are supported', 'error');
            return;
        }
        state.glbFile = file;
        $('#drop-name').textContent = file.name;
        $('#drop-zone').classList.add('loaded');
        enableConvertIfReady();
        debouncedConvert();
    });

    // ── Palette file input ────────────────────────────────────────────────
    $('#input-pal').addEventListener('change', (e) => handlePaletteUpload(e.target.files[0]));

    // The transparent <input type=file> covering each drop zone takes clicks
    // and dropped files natively; these listeners only drive the highlight.
    // (Chrome sets a dropped file without firing 'drop', hence 'change'.)
    for (const zone of document.querySelectorAll('.drop-zone')) {
        zone.addEventListener('dragenter', () => zone.classList.add('dragging'));
        for (const type of ['dragleave', 'drop', 'change'])
            zone.addEventListener(type, () => zone.classList.remove('dragging'));
    }

    // ── Paint & lines toggles ─────────────────────────────────────────────
    $('#toggle-paint').addEventListener('change', (e) => setPaintMode(e.target.checked));
    $('#toggle-lines').addEventListener('change', (e) => setBlockLines(e.target.checked));

    // ── Resolution slider ─────────────────────────────────────────────────
    const slider = $('#slider-grid');

    slider.addEventListener('input', () => {
        state.gridSize = parseInt(slider.value, 10);
        $('#slider-value').textContent = state.gridSize;
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
    $('#btn-rotate-x').addEventListener('click', () => {
        state.rotX = (state.rotX + 90) % 360;
        if (state.glbFile) debouncedConvert();
    });

    $('#btn-rotate-y').addEventListener('click', () => {
        state.rotY = (state.rotY + 90) % 360;
        if (state.glbFile) debouncedConvert();
    });
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
    await initPreview(document.getElementById('canvas-container'));
    wireDom();
    setStatus('Initialising Wasm module…', 'info');
});

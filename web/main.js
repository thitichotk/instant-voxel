/**
 * main.js — app controller.
 *
 * Source (model files | image | .vox) → worker (voxel kernel, image → voxels,
 * in-browser AI, mesher) → Grid → preview, paint and export. Settings persist
 * in localStorage.
 */

import * as THREE from 'three';
import { initPreview, setGrid, remesh, setGhost, setView, pick, canvas, setToolMode, showBox } from './preview.js';
import { loadModel, flatten, meshTransfer, MODEL_EXTS, ext } from './loaders.js';
import { writeVox, readVox } from './vox.js';
import { defaultCube, minecraftPalette, parseHex, usedColors } from './palettes.js';
import { toGLB, toOBJ, toSTL } from './export.js';
import { writeSchem } from './schem.js';
import { serverGenerate, serverHealth } from './ai.js';
import { summarize, index } from './grid.js';
import { History, brush, box, floodFill } from './editor.js';

const $ = (sel) => document.querySelector(sel);

// ── Settings (persisted) ──────────────────────────────────────────────────────

const DEFAULTS = {
    size: 64, axis: -1, fill: 'surface', hollow: 0, islands: 0,
    paletteMode: 'auto', colors: 255, dither: false,
    rotX: 0, rotY: 0, lines: false, ghost: false,
    exportFormat: 'vox', voxelMM: 10,
    imageMode: 'pixel', depth: 8, background: 'depth', mirror: false,
    aiProvider: 'browser', aiUrl: 'http://127.0.0.1:8000', aiKey: '',
    brush: 1, boxOp: 'fill', mirrorX: false, mirrorZ: false,
};

const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'];
const settings = { ...DEFAULTS, ...readSettings() };

function readSettings() {
    try { return JSON.parse(localStorage.getItem('voxy.settings')) ?? {}; } catch { return {}; }
}
function saveSettings() {
    try { localStorage.setItem('voxy.settings', JSON.stringify(settings)); } catch { /* private mode */ }
}

// ── Application state ─────────────────────────────────────────────────────────

const state = {
    source: null,     // { kind: 'model', name, pivot } | { kind: 'image', name, bitmap } | { kind: 'grid', name, grid }
    grid: null,       // current Grid (see grid.js)
    hex: null,        // { name, palette } from a .hex file
    busy: false,
    queued: false,    // settings changed during a run: run again with the latest
    paintIndex: 1,
    aiPhoto: null,    // File picked in the Generate card
    abort: null,      // AbortController of a running model-server request
    tool: 'orbit',
    history: new History(),
    edited: false,    // the grid has edits not yet exported
    boxStart: null,   // first corner while the box tool is placing
};
const textureCache = new Map();

// ── Web Worker ────────────────────────────────────────────────────────────────

let worker = null;
let job = null;   // { resolve, reject } — one job at a time

function startWorker() {
    worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    worker.addEventListener('message', ({ data: msg }) => {
        if (msg.type === 'ready') {
            if (!state.source) setStatus('Wasm ready.', 'ok');   // not after a cancel respawn
        } else if (msg.type === 'progress') {
            setProgress(5 + 90 * msg.p);
            if (msg.msg) setStatus(msg.msg, 'info');
        } else if (msg.type === 'result') {
            job?.resolve(msg.result);
            job = null;
        } else if (msg.type === 'error') {
            if (job) job.reject(new Error(msg.message));
            else     setStatus(`Worker: ${msg.message}`, 'error');
            job = null;
        }
    });
    worker.addEventListener('error', (e) => setStatus(`Uncaught worker error: ${e.message}`, 'error'));
}

function runJob(op, args, transfer = []) {
    return new Promise((resolve, reject) => {
        job = { resolve, reject };
        worker.postMessage({ op, ...args }, transfer);
    });
}

function cancelJob() {
    if (!job) return;
    worker.terminate();
    job.reject(new Error('Cancelled.'));
    job = null;
    state.queued = false;
    startWorker();
}

startWorker();

// ── DOM helpers ───────────────────────────────────────────────────────────────

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

function debounce(fn, ms) {
    let t;
    return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

function updateSliderFill(slider) {
    const min = parseFloat(slider.min);
    const max = parseFloat(slider.max);
    const val = parseFloat(slider.value);
    const pct = ((val - min) / (max - min) * 100).toFixed(2);
    slider.style.setProperty('--pct', `${pct}%`);
}

function download(bytes, name, type = 'application/octet-stream') {
    const a = Object.assign(document.createElement('a'), {
        href:     URL.createObjectURL(new Blob([bytes], { type })),
        download: name,
    });
    a.click();
    URL.revokeObjectURL(a.href);
}

// ── Palette swatches & stats ──────────────────────────────────────────────────

function renderSwatches(colors) {
    const container = $('#palette-swatches');
    if (!colors.some((c) => c.index === state.paintIndex)) state.paintIndex = colors[0]?.index ?? 1;

    container.innerHTML = colors.map(({ index, hex }) =>
        `<div class="swatch ${index === state.paintIndex ? 'active' : ''}" style="background:${hex}" title="${hex}" data-index="${index}"></div>`
    ).join('');
    container.classList.toggle('has-colors', colors.length > 0);
}

// Stats bar and swatches for the current grid (one pass over the voxels).
function updateStats() {
    const g = state.grid;
    const { count, used } = summarize(g);
    const colors = usedColors(g, used);
    $('#stat-count').textContent  = count.toLocaleString();
    $('#stat-size').textContent   = `${g.sx} × ${g.sy} × ${g.sz}`;
    $('#stat-colors').textContent = colors.length;
    renderSwatches(colors);
}

function showGrid(grid, chunks) {
    const reframe = !state.grid || ['sx', 'sy', 'sz'].some((k) => state.grid[k] !== grid[k]);
    state.grid = grid;
    state.history = new History();
    state.edited = false;
    updateUndoButtons();
    setGrid(grid, chunks, { reframe });
    $('#hint-overlay').classList.add('hidden');
    $('#btn-download').disabled = false;
    updateStats();
}

// ── Main pipeline ─────────────────────────────────────────────────────────────

// The fixed palette the settings ask for, or undefined for an automatic one.
const fixedPalette = () =>
    ({ cube: defaultCube, minecraft: minecraftPalette, hex: () => state.hex?.palette })[settings.paletteMode]?.();

function kernelOpts() {
    return {
        size: settings.size, axis: settings.axis,
        solid: settings.fill === 'solid', hollow: settings.hollow, minIsland: settings.islands,
        colors: settings.colors, dither: settings.dither, palette: fixedPalette(),
    };
}

// Image → RGBA pixels with the longest side at most `size` (never upscaled);
// pixel art keeps hard edges.
function pixelsOf(bitmap, size, crisp) {
    const s = Math.min(1, size / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * s)), h = Math.max(1, Math.round(bitmap.height * s));
    const ctx = new OffscreenCanvas(w, h).getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingEnabled = !crisp;
    ctx.drawImage(bitmap, 0, 0, w, h);
    return { rgba: new Uint8Array(ctx.getImageData(0, 0, w, h).data.buffer), width: w, height: h };
}

async function convert() {
    if (!state.source) return;
    if (state.busy) { state.queued = true; return; }

    state.busy = true;
    state.queued = false;
    $('#btn-convert').disabled = true;
    $('#btn-cancel').hidden = false;
    setStatus('Voxelising…', 'info');
    setProgress(5);
    const t0 = performance.now();

    try {
        const src = state.source;
        if (src.kind === 'model') {
            src.pivot.rotation.set(settings.rotX * Math.PI / 180, settings.rotY * Math.PI / 180, 0);
            const mesh = flatten(src.pivot, textureCache);
            const { grid, chunks } = await runJob('voxelize', { mesh, opts: kernelOpts() }, meshTransfer(mesh));
            showGrid(grid, chunks);
            setGhost(src.pivot.clone(), grid.origin, grid.cell);
        } else if (src.kind === 'image') {
            const px = pixelsOf(src.bitmap, settings.size, settings.imageMode === 'pixel');
            const opts = {
                mode: settings.imageMode, depth: settings.depth, background: settings.background,
                mirror: settings.mirror, colors: settings.colors, palette: fixedPalette(),
            };
            const op = settings.imageMode === 'photo' ? 'relief' : 'image';
            const { grid, chunks } = await runJob(op, { ...px, opts }, [px.rgba.buffer]);
            showGrid(grid, chunks);
            setGhost(null);
        } else {
            const copy = { ...src.grid, data: src.grid.data.slice() };
            const { grid, chunks } = await runJob('mesh', { grid: copy }, [copy.data.buffer]);
            showGrid(grid, chunks);
            setGhost(null);
        }
        setProgress(100);
        setStatus(`Done in ${((performance.now() - t0) / 1000).toFixed(1)} s`, 'ok');
    } catch (err) {
        const cancelled = err.message === 'Cancelled.';
        setStatus(err.message, cancelled ? 'ok' : 'error');
        if (!cancelled) console.error('[main] conversion error:', err);
    } finally {
        state.busy = false;
        $('#btn-convert').disabled = !state.source;
        $('#btn-cancel').hidden = true;
        setTimeout(() => setProgress(0), 900);
        if (state.queued) convert();
    }
}

const debouncedConvert = debounce(convert, 150);

// A new source replaces whatever is running.
function setSource(source) {
    state.source = source;
    cancelJob();
    $('#btn-convert').disabled = false;
    syncControls();
    convert();
}

// ── Opening files ─────────────────────────────────────────────────────────────

async function openFiles(fileList) {
    const files = [...fileList];
    try {
        const hex = files.find((f) => ext(f.name) === 'hex');
        if (hex) await loadHex(hex);
        const vox = files.find((f) => ext(f.name) === 'vox');
        const image = files.find((f) => IMAGE_EXTS.includes(ext(f.name)));
        const models = files.filter((f) => ext(f.name) !== 'hex');
        const isModel = models.some((f) => MODEL_EXTS.includes(ext(f.name)));
        if (vox) {
            setSource({ kind: 'grid', name: vox.name.replace(/\.[^.]+$/, ''), grid: readVox(await vox.arrayBuffer()) });
            showSourceName(vox.name);
        } else if (image && !isModel) {
            showSourceName(image.name);
            setSource({ kind: 'image', name: image.name.replace(/\.[^.]+$/, ''), bitmap: await createImageBitmap(image) });
        } else if (isModel) {
            setStatus('Loading model…', 'info');
            const object = await loadModel(models);
            const pivot = new THREE.Group();
            pivot.add(object);
            textureCache.clear();
            const main = models.find((f) => MODEL_EXTS.includes(ext(f.name)));
            showSourceName(models.length > 1 ? `${main.name} +${models.length - 1}` : main.name);
            setSource({ kind: 'model', name: main.name.replace(/\.[^.]+$/, ''), pivot });
        } else if (!hex) {
            throw new Error(`Unsupported file: ${files.map((f) => f.name).join(', ')}`);
        }
    } catch (err) {
        setStatus(err.message, 'error');
        console.error('[main] open error:', err);
    }
}

function showSourceName(name) {
    $('#drop-name-model').textContent = name;
    $('#drop-zone-model').classList.add('loaded');
}

async function loadHex(file) {
    const { palette } = parseHex(await file.text());
    state.hex = { name: file.name, palette };
    settings.paletteMode = 'hex';
    saveSettings();
    syncControls();
    $('#drop-name-pal').textContent = file.name;
    $('#drop-zone-pal').classList.add('loaded');
    setStatus(`Palette "${file.name}" loaded.`, 'ok');
    if (state.source?.kind === 'model') debouncedConvert();
}

// ── Controls ──────────────────────────────────────────────────────────────────

// Reflect settings in the controls (on load, and after code changes a setting).
function syncControls() {
    for (const id of ['size', 'axis', 'hollow', 'islands', 'colors', 'depth', 'brush']) $(`#${id}`).value = settings[id];
    $('#brush-value').textContent = settings.brush;
    $('#mirror-x').checked = settings.mirrorX;
    $('#mirror-z').checked = settings.mirrorZ;
    for (const r of document.querySelectorAll('input[name="box-op"]')) r.checked = r.value === settings.boxOp;
    $('#image-mode').value = settings.imageMode;
    $('#background').value = settings.background;
    $('#mirror').checked = settings.mirror;
    const image = state.source?.kind === 'image';
    $('#model-fields').hidden = image;
    $('#image-fields').hidden = !image;
    $('#field-background').hidden = $('#field-mirror').hidden = settings.imageMode !== 'photo';
    const server = settings.aiProvider === 'server';
    $('#ai-provider').value = settings.aiProvider;
    $('#ai-url').value = settings.aiUrl;
    $('#ai-key').value = settings.aiKey;
    $('#ai-server-fields').hidden = $('#ai-note').hidden = !server;
    $('#drop-hint-ai').textContent = server ? 'Optional with a prompt' : 'Becomes a voxel relief';
    $('#export-format').value = settings.exportFormat;
    $('#voxel-mm').value = settings.voxelMM;
    $('#field-voxel-mm').hidden = !['glb', 'obj', 'stl'].includes(settings.exportFormat);
    $('#download-label').textContent = `Download .${settings.exportFormat}`;
    $('#palette-mode').value = settings.paletteMode;
    $('#dither').checked = settings.dither;
    $('#toggle-lines').checked = settings.lines;
    $('#toggle-ghost').checked = settings.ghost;
    for (const r of document.querySelectorAll('input[name="fill"]')) r.checked = r.value === settings.fill;
    $('#size-value').textContent = settings.size;
    $('#colors-value').textContent = settings.colors;
    $('#field-hollow').hidden = settings.fill !== 'solid';
    $('#field-colors').hidden = settings.paletteMode !== 'auto';
    $('#drop-zone-pal').hidden = settings.paletteMode !== 'hex';
    document.querySelectorAll('input[type="range"]').forEach(updateSliderFill);
    setView({ lines: settings.lines, ghost: settings.ghost });
}

function wireDom() {
    // Sources: pickers and drop-anywhere.
    $('#input-model').addEventListener('change', (e) => openFiles(e.target.files));
    $('#input-pal').addEventListener('change', (e) => e.target.files[0] && openFiles(e.target.files));

    let dragDepth = 0;
    const dragging = (on) => document.body.classList.toggle('dragging', on);
    window.addEventListener('dragenter', (e) => {
        if (e.dataTransfer?.types.includes('Files')) { dragDepth++; dragging(true); }
    });
    window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; dragging(false); } });
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => {
        e.preventDefault();
        dragDepth = 0;
        dragging(false);
        if (e.dataTransfer.files.length) openFiles(e.dataTransfer.files);
    });

    // Settings that re-voxelise.
    const setting = (key, el, parse, { live = false } = {}) => () => {
        if (keepEdits()) return syncControls();
        settings[key] = parse(el.value);
        saveSettings();
        syncControls();
        if (state.source && state.source.kind !== 'grid') live ? debouncedConvert() : convert();
    };
    const count = (v) => Math.max(0, Math.round(Number(v) || 0));
    $('#size').addEventListener('input', setting('size', $('#size'), Number, { live: true }));
    $('#colors').addEventListener('input', setting('colors', $('#colors'), Number, { live: true }));
    $('#axis').addEventListener('change', setting('axis', $('#axis'), Number));
    $('#hollow').addEventListener('change', setting('hollow', $('#hollow'), count));
    $('#islands').addEventListener('change', setting('islands', $('#islands'), count));
    $('#palette-mode').addEventListener('change', setting('paletteMode', $('#palette-mode'), String));
    $('#image-mode').addEventListener('change', setting('imageMode', $('#image-mode'), String));
    $('#depth').addEventListener('change', setting('depth', $('#depth'), (v) => Math.min(256, Math.max(1, Math.round(Number(v) || 1)))));
    $('#background').addEventListener('change', setting('background', $('#background'), String));
    $('#mirror').addEventListener('change', (e) => {
        if (keepEdits()) return syncControls();
        settings.mirror = e.target.checked;
        saveSettings();
        if (state.source?.kind === 'image') convert();
    });
    for (const r of document.querySelectorAll('input[name="fill"]'))
        r.addEventListener('change', setting('fill', r, String));
    $('#dither').addEventListener('change', (e) => {
        if (keepEdits()) return syncControls();
        settings.dither = e.target.checked;
        saveSettings();
        if (state.source?.kind === 'model') convert();
    });

    // View.
    for (const [id, key] of [['#toggle-lines', 'lines'], ['#toggle-ghost', 'ghost']])
        $(id).addEventListener('change', (e) => { settings[key] = e.target.checked; saveSettings(); setView({ [key]: e.target.checked }); });
    $('#clip').addEventListener('input', (e) => {
        $('#clip-value').textContent = `${e.target.value}%`;
        updateSliderFill(e.target);
        setView({ clip: e.target.value / 100 });
    });

    // Rotation gizmos.
    for (const [id, key] of [['#btn-rotate-x', 'rotX'], ['#btn-rotate-y', 'rotY']])
        $(id).addEventListener('click', () => {
            if (state.source?.kind === 'model' && keepEdits()) return;
            settings[key] = (settings[key] + 90) % 360;
            saveSettings();
            if (state.source?.kind === 'model') debouncedConvert();
        });

    // Run & export.
    $('#btn-convert').addEventListener('click', () => keepEdits() || convert());
    $('#btn-cancel').addEventListener('click', () => { state.abort?.abort(); cancelJob(); });
    $('#export-format').addEventListener('change', (e) => { settings.exportFormat = e.target.value; saveSettings(); syncControls(); });
    $('#voxel-mm').addEventListener('change', (e) => {
        settings.voxelMM = Math.max(0.01, Number(e.target.value) || DEFAULTS.voxelMM);
        saveSettings();
        syncControls();
    });
    $('#btn-download').addEventListener('click', exportGrid);

    // Generate (AI).
    $('#ai-provider').addEventListener('change', (e) => { settings.aiProvider = e.target.value; saveSettings(); syncControls(); });
    for (const [id, key] of [['#ai-url', 'aiUrl'], ['#ai-key', 'aiKey']])
        $(id).addEventListener('change', (e) => { settings[key] = e.target.value.trim(); saveSettings(); checkServer(); });
    $('#input-ai').addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;
        state.aiPhoto = file;
        $('#drop-name-ai').textContent = file.name;
        $('#drop-zone-ai').classList.add('loaded');
    });
    $('#btn-generate').addEventListener('click', generate);

    // Edit tools; swatches pick their colour.
    $('#palette-swatches').addEventListener('click', (e) => {
        const index = Number(e.target.dataset.index);
        if (index) selectColor(index);
    });
    for (const r of document.querySelectorAll('input[name="tool"]'))
        r.addEventListener('change', () => setTool(r.value));
    for (const r of document.querySelectorAll('input[name="box-op"]'))
        r.addEventListener('change', () => { settings.boxOp = r.value; saveSettings(); });
    $('#brush').addEventListener('input', (e) => { settings.brush = Number(e.target.value); saveSettings(); syncControls(); });
    for (const [id, key] of [['#mirror-x', 'mirrorX'], ['#mirror-z', 'mirrorZ']])
        $(id).addEventListener('change', (e) => { settings[key] = e.target.checked; saveSettings(); });
    $('#btn-undo').addEventListener('click', () => undoRedo('undo'));
    $('#btn-redo').addEventListener('click', () => undoRedo('redo'));
    wireEditing();
    window.addEventListener('keydown', onKey);
    setTool('orbit');

    syncControls();
}

// ── Editing ───────────────────────────────────────────────────────────────────

const TOOL_KEYS = { o: 'orbit', b: 'paint', e: 'erase', a: 'add', f: 'fill', i: 'pick', x: 'box' };

// Re-voxelising replaces the grid: true (keep them) when the user declines to drop unexported edits.
function keepEdits() {
    if (!state.edited) return false;
    if (!confirm('Re-voxelising discards your voxel edits. Continue?')) return true;
    state.edited = false;
    return false;
}

function setTool(tool) {
    state.tool = tool;
    state.boxStart = null;
    showBox(null);
    setToolMode(tool !== 'orbit');
    for (const r of document.querySelectorAll('input[name="tool"]')) r.checked = r.value === tool;
    $('#field-brush').hidden = !['paint', 'erase', 'add'].includes(tool);
    $('#field-box-op').hidden = tool !== 'box';
}

function selectColor(index) {
    if (!index) return;
    state.paintIndex = index;
    for (const s of $('#palette-swatches').children) s.classList.toggle('active', Number(s.dataset.index) === index);
}

function updateUndoButtons() {
    $('#btn-undo').disabled = !state.history.done.length;
    $('#btn-redo').disabled = !state.history.undone.length;
}

function applyEdit(dirty) {
    if (!dirty.size) return;
    remesh(dirty);
    state.edited = true;
}

function endStroke() {
    if (state.history.commit()) updateStats();
    updateUndoButtons();
}

function undoRedo(which) {
    if (!state.grid) return;
    applyEdit(state.history[which](state.grid));
    updateStats();
    updateUndoButtons();
}

function wireEditing() {
    const el = canvas();
    let painting = false, last = null;
    const opts = () => ({ history: state.history, mirror: { x: settings.mirrorX, z: settings.mirrorZ } });
    const brushAt = (hit) => {
        const center = state.tool === 'add' ? hit.voxel.map((v, i) => v + hit.normal[i]) : hit.voxel;
        if (center.join() === last) return;
        last = center.join();
        applyEdit(brush(state.grid, center, settings.brush, state.tool, state.paintIndex, opts()));
    };

    el.addEventListener('pointerdown', (e) => {
        if (e.button !== 0 || state.tool === 'orbit' || !state.grid) return;
        const hit = pick(e.clientX, e.clientY);
        if (!hit) return;
        const g = state.grid;
        if (state.tool === 'pick') return selectColor(g.data[index(g, ...hit.voxel)]);
        if (state.tool === 'box' && !state.boxStart) {
            state.boxStart = hit.voxel;
            return showBox(hit.voxel, hit.voxel);
        }
        state.history.begin();
        if (state.tool === 'fill') {
            applyEdit(floodFill(g, ...hit.voxel, state.paintIndex, opts()));
            return endStroke();
        }
        if (state.tool === 'box') {
            applyEdit(box(g, state.boxStart, hit.voxel, settings.boxOp, state.paintIndex, opts()));
            state.boxStart = null;
            showBox(null);
            return endStroke();
        }
        painting = true;
        last = null;
        brushAt(hit);
    });
    el.addEventListener('pointermove', (e) => {
        if (state.tool === 'box' && state.boxStart) {
            const hit = pick(e.clientX, e.clientY);
            if (hit) showBox(state.boxStart, hit.voxel);
        }
        // Add works per click: dragging would stack voxels toward the camera.
        if (!painting || state.tool === 'add') return;
        const hit = pick(e.clientX, e.clientY);
        if (hit) brushAt(hit);
    });
    const stop = () => {
        if (!painting) return;
        painting = false;
        endStroke();
    };
    el.addEventListener('pointerup', stop);
    el.addEventListener('pointercancel', stop);
}

function onKey(e) {
    if (e.target.closest?.('input, textarea, select')) return;
    const key = e.key.toLowerCase(), mod = e.metaKey || e.ctrlKey;
    if (mod && (key === 'z' || key === 'y')) {
        e.preventDefault();
        return undoRedo(key === 'y' || e.shiftKey ? 'redo' : 'undo');
    }
    if (mod || e.altKey) return;
    if (key === 'escape') {
        state.boxStart = null;
        showBox(null);
    } else if (TOOL_KEYS[key] && state.grid) setTool(TOOL_KEYS[key]);
}

// ── Generate (AI) ─────────────────────────────────────────────────────────────

// Not run on page load: from the Pages site, reaching a local server makes
// Chrome ask for local-network permission.
async function checkServer() {
    const el = $('#ai-health');
    el.className = 'ai-health';
    el.textContent = 'Checking…';
    try {
        const h = await serverHealth({ url: settings.aiUrl, key: settings.aiKey, signal: AbortSignal.timeout(4000) });
        el.className = 'ai-health ok';
        el.textContent = `Connected · ${h.device}`;
        return true;
    } catch (err) {
        el.className = 'ai-health error';
        el.textContent = err.message.startsWith('Model server') ? err.message : `Can't reach ${settings.aiUrl}`;
        return false;
    }
}

async function generate() {
    const photo = state.aiPhoto, prompt = $('#ai-prompt').value.trim();
    if (settings.aiProvider === 'browser') {
        if (!photo) return setStatus('Choose a photo to turn into a relief.', 'error');
        settings.imageMode = 'photo';
        saveSettings();
        showSourceName(photo.name);
        setSource({ kind: 'image', name: photo.name.replace(/\.[^.]+$/, ''), bitmap: await createImageBitmap(photo) });
        return;
    }
    if (!photo && !prompt) return setStatus('Type a prompt or choose a photo.', 'error');
    if (!(await checkServer())) return setStatus(`Model server not reachable at ${settings.aiUrl}.`, 'error');

    state.abort?.abort();
    cancelJob();
    const abort = state.abort = new AbortController();
    $('#btn-generate').disabled = true;
    $('#btn-cancel').hidden = false;
    setStatus('Sending to the model server…', 'info');
    setProgress(5);
    try {
        const glb = await serverGenerate({
            url: settings.aiUrl, key: settings.aiKey, image: photo, prompt, signal: abort.signal,
            onStage: (stage) => stage !== 'done' && setStatus(`Model server: ${stage}…`, 'info'),
        });
        const name = (prompt || photo.name.replace(/\.[^.]+$/, '')).slice(0, 40).replace(/[^\w-]+/g, '_').replace(/^_+|_+$/g, '') || 'generated';
        const pivot = new THREE.Group();
        pivot.add(await loadModel([new File([glb], `${name}.glb`)]));
        textureCache.clear();
        showSourceName(`${name}.glb · generated`);
        setSource({ kind: 'model', name, pivot });
    } catch (err) {
        const cancelled = err.name === 'AbortError' || err.message === 'Cancelled.';
        setStatus(cancelled ? 'Cancelled.' : err.message, cancelled ? 'ok' : 'error');
        if (!cancelled) console.error('[main] generate error:', err);
        $('#btn-cancel').hidden = !state.busy;
    } finally {
        if (state.abort === abort) state.abort = null;
        $('#btn-generate').disabled = false;
    }
}

// ── Export ────────────────────────────────────────────────────────────────────

const EXPORTERS = {
    vox:   { mime: 'application/octet-stream', run: (g) => writeVox(g) },
    glb:   { mime: 'model/gltf-binary',        run: (g, o) => toGLB(g, o) },
    obj:   { mime: 'text/plain',               run: (g, o) => toOBJ(g, o) },
    stl:   { mime: 'model/stl',                run: (g, o) => toSTL(g, o) },
    schem: { mime: 'application/octet-stream', run: (g) => writeSchem(g) },
};

async function exportGrid() {
    if (!state.grid) return;
    const format = settings.exportFormat;
    const suffix = state.source.kind === 'model' ? `_${settings.size}` : '';
    const name = `${state.source.name}${suffix}.${format}`;
    try {
        setStatus(`Exporting ${name}…`, 'info');
        const bytes = await EXPORTERS[format].run(state.grid, { voxelMM: settings.voxelMM, name: state.source.name });
        download(bytes, name, EXPORTERS[format].mime);
        state.edited = false;
        const size = bytes.length ?? bytes.byteLength;
        setStatus(`Exported ${name} (${size >= 1048576 ? `${(size / 1048576).toFixed(1)} MB` : `${(size / 1024).toFixed(1)} KB`})`, 'ok');
    } catch (err) {
        setStatus(`Export failed: ${err.message}`, 'error');
        console.error('[main] export error:', err);
    }
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
    initPreview(document.getElementById('canvas-container'));
    wireDom();
});

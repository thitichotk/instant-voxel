/**
 * main.js — app controller.
 *
 * Source (model files | image | .vox) → worker (voxel kernel, image → voxels,
 * in-browser AI, mesher) → Grid → preview, paint and export. Settings persist
 * in localStorage. The page opens on a built-in sample (sample.vox).
 */

import * as THREE from 'three';
import { initPreview, setGrid, remesh, setGhost, setView, pick, canvas, setToolMode, showBox, resetView } from './preview.js';
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
    rotX: 0, rotY: 0, lines: false, ghost: false, grid: true, spin: false,
    exportFormat: 'vox', voxelMM: 10,
    imageMode: 'pixel', depth: 8, background: 'depth', mirror: false,
    aiProvider: 'browser', aiUrl: 'http://127.0.0.1:8000', aiKey: '',
    brush: 1, boxOp: 'fill', mirrorX: false, mirrorZ: false,
};

const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'];
const SETTINGS_KEY = 'instant-voxel.settings';
const settings = { ...DEFAULTS, ...readSettings() };
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

function readSettings() {
    try { return JSON.parse(localStorage.getItem(SETTINGS_KEY)) ?? {}; } catch { return {}; }
}
function saveSettings() {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* private mode */ }
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
            if (!state.source) setStatus('Ready', 'ok');   // not after a cancel respawn
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

/** level: 'info' (working, the dot pulses), 'ok' or 'error'. */
function setStatus(msg, level = 'info') {
    $('#status-text').textContent = msg;
    $('#status').classList.toggle('error', level === 'error');
    $('#status-dot').classList.toggle('busy', level === 'info');
}

function setProgress(pct) {
    $('#progress-fill').style.width = `${pct}%`;
}

function debounce(fn, ms) {
    let t;
    return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

const fmtTime = (ms) => (ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`);
const fmtBytes = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const baseName = (name) => name.replace(/\.[^.]+$/, '');

// Groups of aria-pressed buttons act as one choice; each button's data-v is its value.
function press(group, value) {
    for (const b of group.querySelectorAll('button[data-v]')) b.setAttribute('aria-pressed', String(b.dataset.v === value));
}
function onPress(group, fn) {
    group.addEventListener('click', (e) => {
        const b = e.target.closest('button[data-v]');
        if (b && !b.disabled) fn(b.dataset.v);
    });
}

function download(bytes, name, type = 'application/octet-stream') {
    const url = URL.createObjectURL(new Blob([bytes], { type }));
    Object.assign(document.createElement('a'), { href: url, download: name }).click();
    // Revoking straight after click() can cancel the download in Safari and Firefox.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

// ── Palette swatches & stats ──────────────────────────────────────────────────

function renderSwatches(colors) {
    if (!colors.some((c) => c.index === state.paintIndex)) state.paintIndex = colors[0]?.index ?? 1;
    $('#palette-swatches').innerHTML = colors.map(({ index, hex }) =>
        `<button type="button" style="--c:${hex}" aria-label="${hex}" title="${hex}" data-index="${index}" aria-pressed="${index === state.paintIndex}"></button>`
    ).join('');
}

// Dimensions, counts and swatches for the current grid (one pass over the voxels).
function updateStats() {
    const g = state.grid;
    const { count, used } = summarize(g);
    const colors = usedColors(g, used);
    $('#dims').textContent = `${g.sx} × ${g.sy} × ${g.sz} · ${count.toLocaleString('en')} voxels`;
    $('#stat-colors').textContent = `${colors.length} in use`;
    renderSwatches(colors);
    return count;
}

function showGrid(grid, chunks) {
    const reframe = !state.grid || ['sx', 'sy', 'sz'].some((k) => state.grid[k] !== grid[k]);
    state.grid = grid;
    state.history = new History();
    state.edited = false;
    updateUndoButtons();
    setGrid(grid, chunks, { reframe });
    $('#btn-download').disabled = false;
    for (const b of $('#tools').querySelectorAll('button')) b.disabled = false;
    return updateStats();
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
        let count;
        if (src.kind === 'model') {
            src.pivot.rotation.set(settings.rotX * Math.PI / 180, settings.rotY * Math.PI / 180, 0);
            const mesh = flatten(src.pivot, textureCache);
            const { grid, chunks } = await runJob('voxelize', { mesh, opts: kernelOpts() }, meshTransfer(mesh));
            count = showGrid(grid, chunks);
            setGhost(src.pivot.clone(), grid.origin, grid.cell);
        } else if (src.kind === 'image') {
            const px = pixelsOf(src.bitmap, settings.size, settings.imageMode === 'pixel');
            const opts = {
                mode: settings.imageMode, depth: settings.depth, background: settings.background,
                mirror: settings.mirror, colors: settings.colors, palette: fixedPalette(),
            };
            const op = settings.imageMode === 'photo' ? 'relief' : 'image';
            const { grid, chunks } = await runJob(op, { ...px, opts }, [px.rgba.buffer]);
            count = showGrid(grid, chunks);
            setGhost(null);
        } else {
            const copy = { ...src.grid, data: src.grid.data.slice() };
            const { grid, chunks } = await runJob('mesh', { grid: copy }, [copy.data.buffer]);
            count = showGrid(grid, chunks);
            setGhost(null);
        }
        setProgress(100);
        setStatus(`Ready · ${count.toLocaleString('en')} voxels in ${fmtTime(performance.now() - t0)}`, 'ok');
    } catch (err) {
        const cancelled = err.message === 'Cancelled.';
        setStatus(err.message, cancelled ? 'ok' : 'error');
        if (!cancelled) console.error('[main] conversion error:', err);
    } finally {
        state.busy = false;
        $('#btn-convert').disabled = !state.source || state.source.kind === 'grid';
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
    syncControls();
    convert();
}

// ── Opening files ─────────────────────────────────────────────────────────────

function showSource(name, meta, icon = 'view_in_ar') {
    $('#source-name').textContent = name;
    $('#source-meta').textContent = meta;
    $('#source-icon').textContent = icon;
    $('#source-file').hidden = false;
}

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
            setSource({ kind: 'grid', name: baseName(vox.name), grid: readVox(await vox.arrayBuffer()) });
            showSource(vox.name, fmtBytes(vox.size));
        } else if (image && !isModel) {
            showSource(image.name, fmtBytes(image.size), 'image');
            setSource({ kind: 'image', name: baseName(image.name), bitmap: await createImageBitmap(image) });
        } else if (isModel) {
            setStatus('Loading model…', 'info');
            const object = await loadModel(models);
            const pivot = new THREE.Group();
            pivot.add(object);
            textureCache.clear();
            const main = models.find((f) => MODEL_EXTS.includes(ext(f.name)));
            showSource(models.length > 1 ? `${main.name} +${models.length - 1}` : main.name, fmtBytes(main.size));
            setSource({ kind: 'model', name: baseName(main.name), pivot });
        } else if (!hex) {
            throw new Error(`Unsupported file: ${files.map((f) => f.name).join(', ')}`);
        }
    } catch (err) {
        setStatus(err.message, 'error');
        console.error('[main] open error:', err);
    }
}

async function loadHex(file) {
    const { palette } = parseHex(await file.text());
    state.hex = { name: file.name, palette };
    $('#drop-name-pal').textContent = file.name;
    change('paletteMode', 'hex', { kinds: ['model', 'image'] });
    setStatus(`Palette "${file.name}" loaded.`, 'ok');
}

async function openSample() {
    try {
        const res = await fetch('sample.vox');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        setSource({ kind: 'grid', name: 'sample-island', grid: readVox(await res.arrayBuffer()) });
        showSource('sample-island.vox', 'built in');
    } catch (err) {
        console.warn('[main] sample not loaded:', err);
        setStatus('Ready. Drop a model or image to start.', 'ok');
    }
}

// ── Controls ──────────────────────────────────────────────────────────────────

// Reflect settings and state in the controls (on load, and after code changes a setting).
function syncControls() {
    for (const [id, key] of [['#size', 'size'], ['#axis', 'axis'], ['#hollow', 'hollow'], ['#islands', 'islands'],
        ['#colors', 'colors'], ['#depth', 'depth'], ['#brush', 'brush'], ['#image-mode', 'imageMode'],
        ['#background', 'background'], ['#export-format', 'exportFormat'], ['#voxel-mm', 'voxelMM']])
        $(id).value = settings[key];
    for (const [id, key] of [['#size-value', 'size'], ['#colors-value', 'colors'], ['#brush-value', 'brush']])
        $(id).textContent = settings[key];
    for (const [id, key] of [['#mirror', 'mirror'], ['#dither', 'dither'], ['#mirror-x', 'mirrorX'], ['#mirror-z', 'mirrorZ'],
        ['#toggle-lines', 'lines'], ['#toggle-ghost', 'ghost'], ['#toggle-grid', 'grid'], ['#toggle-spin', 'spin']])
        $(id).checked = settings[key];
    press($('#fill'), settings.fill);
    press($('#box-op'), settings.boxOp);
    press($('#palette-mode'), settings.paletteMode);
    press($('#ai-provider'), settings.aiProvider);

    const kind = state.source?.kind;
    $('#model-fields').hidden = kind === 'image';
    $('#image-fields').hidden = kind !== 'image';
    $('#field-background').hidden = $('#field-mirror').hidden = settings.imageMode !== 'photo';
    $('#field-hollow').hidden = settings.fill !== 'solid';
    $('#field-colors').hidden = settings.paletteMode !== 'auto';
    $('#drop-pal').hidden = settings.paletteMode !== 'hex';
    $('#field-dither').hidden = kind === 'image';
    $('#btn-convert').disabled = state.busy || !state.source || kind === 'grid';
    $('#btn-rotate-x').disabled = $('#btn-rotate-y').disabled = kind !== 'model';

    const server = settings.aiProvider === 'server';
    $('#ai-url').value = settings.aiUrl;
    $('#ai-key').value = settings.aiKey;
    $('#ai-server-fields').hidden = $('#ai-note').hidden = !server;
    $('#drop-hint-ai').textContent = server ? 'Optional with a prompt' : 'Becomes a voxel relief, made on your GPU';

    $('#field-voxel-mm').hidden = !['glb', 'obj', 'stl'].includes(settings.exportFormat);
    $('#download-label').textContent = `Download .${settings.exportFormat}`;
    $('#toggle-spin').disabled = reducedMotion;
    setView({ lines: settings.lines, ghost: settings.ghost, grid: settings.grid, spin: settings.spin && !reducedMotion });
}

/**
 * Apply a setting. When it changes how the current source voxelises (`kinds`),
 * confirm before dropping edits, then re-run: at once, or debounced while a
 * slider is dragged (`live`).
 */
function change(key, value, { kinds = [], live = false } = {}) {
    const rerun = kinds.includes(state.source?.kind);
    if (rerun && keepEdits()) return syncControls();
    settings[key] = value;
    saveSettings();
    syncControls();
    if (rerun) live ? debouncedConvert() : convert();
}

const MODEL = ['model'], IMAGE = ['image'], BOTH = ['model', 'image'];

function wireDom() {
    // Sources: pickers and drop-anywhere.
    $('#input-model').addEventListener('change', (e) => e.target.files.length && openFiles(e.target.files));
    $('#input-pal').addEventListener('change', (e) => e.target.files.length && openFiles(e.target.files));

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
    const count = (v) => Math.max(0, Math.round(Number(v) || 0));
    const on = (id, type, key, parse, opts) => $(id).addEventListener(type, (e) => change(key, parse(e.target), opts));
    const num = (el) => Number(el.value), str = (el) => el.value, checked = (el) => el.checked;
    on('#size', 'input', 'size', num, { kinds: BOTH, live: true });
    on('#colors', 'input', 'colors', num, { kinds: BOTH, live: true });
    on('#axis', 'change', 'axis', num, { kinds: MODEL });
    on('#hollow', 'change', 'hollow', (el) => count(el.value), { kinds: MODEL });
    on('#islands', 'change', 'islands', (el) => count(el.value), { kinds: MODEL });
    on('#dither', 'change', 'dither', checked, { kinds: MODEL });
    on('#image-mode', 'change', 'imageMode', str, { kinds: IMAGE });
    on('#depth', 'change', 'depth', (el) => Math.min(256, Math.max(1, Math.round(Number(el.value) || 1))), { kinds: IMAGE });
    on('#background', 'change', 'background', str, { kinds: IMAGE });
    on('#mirror', 'change', 'mirror', checked, { kinds: IMAGE });
    onPress($('#fill'), (v) => change('fill', v, { kinds: MODEL }));
    onPress($('#palette-mode'), (v) => change('paletteMode', v, { kinds: BOTH }));

    // View.
    for (const [id, key] of [['#toggle-lines', 'lines'], ['#toggle-ghost', 'ghost'], ['#toggle-grid', 'grid'], ['#toggle-spin', 'spin']])
        on(id, 'change', key, checked);
    $('#clip').addEventListener('input', (e) => {
        $('#clip-value').textContent = `${e.target.value}%`;
        setView({ clip: e.target.value / 100 });
    });

    // Rotation gizmos and the camera.
    for (const [id, key] of [['#btn-rotate-x', 'rotX'], ['#btn-rotate-y', 'rotY']])
        $(id).addEventListener('click', () => change(key, (settings[key] + 90) % 360, { kinds: MODEL }));
    $('#btn-reset').addEventListener('click', resetView);
    $('#btn-help').addEventListener('click', () => $('#shortcuts').showModal());

    // Run & export.
    $('#btn-convert').addEventListener('click', () => keepEdits() || convert());
    $('#btn-cancel').addEventListener('click', () => { state.abort?.abort(); cancelJob(); });
    on('#export-format', 'change', 'exportFormat', str);
    on('#voxel-mm', 'change', 'voxelMM', (el) => Math.max(0.01, Number(el.value) || DEFAULTS.voxelMM));
    $('#btn-download').addEventListener('click', exportGrid);

    // Generate (AI).
    onPress($('#ai-provider'), (v) => change('aiProvider', v));
    for (const [id, key] of [['#ai-url', 'aiUrl'], ['#ai-key', 'aiKey']])
        $(id).addEventListener('change', (e) => { settings[key] = e.target.value.trim(); saveSettings(); checkServer(); });
    $('#input-ai').addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;
        state.aiPhoto = file;
        $('#drop-name-ai').textContent = file.name;
    });
    $('#btn-generate').addEventListener('click', generate);

    // Edit tools; swatches pick their colour.
    $('#palette-swatches').addEventListener('click', (e) => {
        const b = e.target.closest('button[data-index]');
        if (b) selectColor(Number(b.dataset.index));
    });
    onPress($('#tools'), setTool);
    onPress($('#box-op'), (v) => change('boxOp', v));
    on('#brush', 'input', 'brush', num);
    on('#mirror-x', 'change', 'mirrorX', checked);
    on('#mirror-z', 'change', 'mirrorZ', checked);
    $('#btn-undo').addEventListener('click', () => undoRedo('undo'));
    $('#btn-redo').addEventListener('click', () => undoRedo('redo'));
    wireEditing();
    window.addEventListener('keydown', onKey);
    setTool('orbit');
    for (const b of $('#tools').querySelectorAll('button')) b.disabled = true;   // until there are voxels

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
    press($('#tools'), tool);
    $('#field-brush').hidden = !['paint', 'erase', 'add'].includes(tool);
    $('#field-box-op').hidden = tool !== 'box';
    $('#hint').textContent = tool === 'orbit' ? 'Drag to orbit · scroll to zoom'
        : tool === 'box' ? 'Click two corners · right-drag to orbit' : 'Left-drag to edit · right-drag to orbit';
}

function selectColor(index) {
    if (!index) return;
    state.paintIndex = index;
    for (const s of $('#palette-swatches').children) s.setAttribute('aria-pressed', String(Number(s.dataset.index) === index));
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
    // Letters belong to text fields and selects; switches and sliders keep the shortcuts.
    if (e.target.closest?.('textarea, select, dialog, input:not([type="checkbox"], [type="range"])')) return;
    const key = e.key.toLowerCase(), mod = e.metaKey || e.ctrlKey;
    if (mod && (key === 'z' || key === 'y')) {
        e.preventDefault();
        return undoRedo(key === 'y' || e.shiftKey ? 'redo' : 'undo');
    }
    if (mod || e.altKey) return;
    if (e.key === '?') $('#shortcuts').showModal();
    else if (key === 'escape') {
        state.boxStart = null;
        showBox(null);
    } else if (key === 'r') resetView();
    else if (TOOL_KEYS[key] && state.grid) setTool(TOOL_KEYS[key]);
}

// ── Generate (AI) ─────────────────────────────────────────────────────────────

// Not run on page load: from the live site, reaching a local server makes
// Chrome ask for local-network permission.
async function checkServer() {
    const el = $('#ai-health');
    el.className = 'help';
    el.textContent = 'Checking…';
    try {
        const h = await serverHealth({ url: settings.aiUrl, key: settings.aiKey, signal: AbortSignal.timeout(4000) });
        el.className = 'help ok';
        el.textContent = `Connected · ${h.device}`;
        return true;
    } catch (err) {
        el.className = 'help error';
        el.textContent = err.message.startsWith('Model server') ? err.message : `Can't reach ${settings.aiUrl}`;
        return false;
    }
}

async function generate() {
    const photo = state.aiPhoto, prompt = $('#ai-prompt').value.trim();
    if (settings.aiProvider === 'browser') {
        if (!photo) return setStatus('Choose a photo to turn into a relief.', 'error');
        if (keepEdits()) return;
        settings.imageMode = 'photo';
        saveSettings();
        showSource(photo.name, fmtBytes(photo.size), 'image');
        setSource({ kind: 'image', name: baseName(photo.name), bitmap: await createImageBitmap(photo) });
        return;
    }
    if (!photo && !prompt) return setStatus('Type a prompt or choose a photo.', 'error');
    if (keepEdits()) return;
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
        const name = (prompt || baseName(photo.name)).slice(0, 40).replace(/[^\w-]+/g, '_').replace(/^_+|_+$/g, '') || 'generated';
        const pivot = new THREE.Group();
        pivot.add(await loadModel([new File([glb], `${name}.glb`)]));
        textureCache.clear();
        showSource(`${name}.glb`, 'generated');
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
        setStatus(`Exported ${name} (${fmtBytes(bytes.length ?? bytes.byteLength)})`, 'ok');
    } catch (err) {
        setStatus(`Export failed: ${err.message}`, 'error');
        console.error('[main] export error:', err);
    }
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

initPreview($('#viewport'));
wireDom();
openSample();

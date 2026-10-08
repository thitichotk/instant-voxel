/**
 * worker.js — runs the voxel kernel (voxelizer.wasm) and the mesher off the
 * main thread.
 *
 * main → worker:  { op: 'voxelize', mesh, opts }                TriMesh → Grid + chunk meshes
 *                 { op: 'image', rgba, width, height, opts }    pixel art / heightmap → Grid + meshes
 *                 { op: 'relief', rgba, width, height, opts }   photo → AI depth relief → Grid + meshes
 *                 { op: 'mesh', grid }                          Grid → chunk meshes
 * worker → main:  { type: 'ready' }                (once the Wasm has loaded)
 *                 { type: 'progress', p, msg? }    0–1, with an optional status line
 *                 { type: 'result', result }       (buffers transferred)
 *                 { type: 'error', message }
 * One job at a time; main.js cancels by terminating the worker.
 */

import VoxelizerModule from './voxelizer.js';
import { meshGrid } from './mesher.js';
import { exactPalette, extrude, relief, otsu, keepLargestRegion } from './image.js';
import { photoDepth } from './ai.js';

let kernelPromise = null;

function kernel() {
    kernelPromise ??= VoxelizerModule().then((mod) => {
        self.postMessage({ type: 'ready' });
        return mod;
    }).catch((err) => {
        self.postMessage({ type: 'error', message: String(err) });
        kernelPromise = null;
        throw err;
    });
    return kernelPromise;
}

kernel();

const withMeshes = (grid) => ({ grid, chunks: meshGrid(grid) });
const progress = (p, msg) => self.postMessage({ type: 'progress', p, msg });

// Pixel colours → { indices, palette }: the image's own colours when it has ≤ 255
// and no fixed palette is asked for, else the kernel's quantizer.
async function colorsOf(rgba, { palette, colors }) {
    if (!palette) {
        const exact = exactPalette(rgba);
        if (exact) return exact;
    }
    const q = (await kernel()).quantize(rgba, { palette, colors });
    return { indices: q.indices.slice(), palette: q.palette.slice() };
}

const ops = {
    async voxelize({ mesh, opts }) {
        const r = (await kernel()).voxelize(mesh, opts, (p) => self.postMessage({ type: 'progress', p: 0.9 * p }));
        // The kernel returns views into Wasm memory; copy before the next call.
        return withMeshes({ sx: r.sx, sy: r.sy, sz: r.sz, data: r.data.slice(), palette: r.palette.slice(), origin: r.origin, cell: r.cell });
    },
    async mesh({ grid }) {
        return withMeshes(grid);
    },
    async image({ rgba, width, height, opts }) {
        const { indices, palette } = await colorsOf(rgba, opts);
        if (opts.mode === 'pixel') return withMeshes(extrude(indices, palette, width, height, { thickness: opts.depth }));
        // Heightmap: brightness is height.
        const heights = new Float32Array(width * height);
        for (let i = 0; i < heights.length; i++)
            heights[i] = (0.2126 * rgba[4 * i] + 0.7152 * rgba[4 * i + 1] + 0.0722 * rgba[4 * i + 2]) / 255;
        return withMeshes(relief(indices, palette, heights, width, height, { depth: opts.depth, view: 'top' }));
    },
    async relief({ rgba, width, height, opts }) {
        const r = await photoDepth(rgba, width, height, { mask: opts.background === 'mask', onProgress: progress });
        const opaque = [];
        for (let i = 0; i < width * height; i++) if (r.rgba[4 * i + 3] >= 128) opaque.push(i);
        if (opts.background === 'depth') {
            // Cut the far side of the depth histogram (the background).
            const t = otsu(opaque.map((i) => r.depth[i]));
            for (const i of opaque) if (r.depth[i] < t) r.rgba[4 * i + 3] = 0;
            keepLargestRegion(r.rgba, width, height);
        }
        // Stretch the kept pixels' depth over the full relief depth.
        let lo = 1, hi = 0;
        for (let i = 0; i < width * height; i++)
            if (r.rgba[4 * i + 3] >= 128) { lo = Math.min(lo, r.depth[i]); hi = Math.max(hi, r.depth[i]); }
        const heights = r.depth.map((v) => (hi > lo ? (v - lo) / (hi - lo) : 1));
        const { indices, palette } = await colorsOf(r.rgba, opts);
        progress(1, 'Building voxels…');
        return withMeshes(relief(indices, palette, heights, width, height, { depth: opts.depth, view: 'front', mirror: opts.mirror }));
    },
};

function buffersOf(value, out = new Set()) {
    if (ArrayBuffer.isView(value)) out.add(value.buffer);
    else if (value instanceof Map) for (const v of value.values()) buffersOf(v, out);
    else if (value && typeof value === 'object') for (const v of Object.values(value)) buffersOf(v, out);
    return [...out];
}

self.onmessage = async ({ data: { op, ...args } }) => {
    try {
        const result = await ops[op](args);
        self.postMessage({ type: 'result', result }, buffersOf(result));
    } catch (err) {
        self.postMessage({ type: 'error', message: String(err?.message ?? err) });
    }
};

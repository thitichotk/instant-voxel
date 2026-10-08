/**
 * editor.js — voxel edit operations on a Grid (see grid.js), with undo/redo.
 *
 * Every operation records its changes into a History stroke and returns the
 * chunk keys to remesh. Painting changes colours only (the voxel's own chunk
 * remeshes); adding or erasing changes faces, so face neighbours remesh too.
 */

import { index, inside } from './grid.js';
import { CHUNK, chunkKey, chunksTouching } from './mesher.js';

const DIRS = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

/** Undo/redo of strokes: each stroke is the list of cells it changed, with old and new values. */
export class History {
    constructor(limit = 100) {
        this.limit = limit;
        this.done = [];
        this.undone = [];
        this.stroke = null;
    }
    begin() { this.stroke = new Map(); }
    record(i, before, after) {
        const s = this.stroke;
        if (!s) return;
        s.set(i, [s.has(i) ? s.get(i)[0] : before, after]);
    }
    commit() {
        const s = this.stroke;
        this.stroke = null;
        if (!s?.size) return false;
        const cells = new Uint32Array(s.size), before = new Uint8Array(s.size), after = new Uint8Array(s.size);
        let k = 0;
        for (const [i, [b, a]] of s) { cells[k] = i; before[k] = b; after[k++] = a; }
        this.done.push({ cells, before, after });
        if (this.done.length > this.limit) this.done.shift();
        this.undone = [];
        return true;
    }
    undo(grid) { return this.#apply(grid, this.done, this.undone, 'before'); }
    redo(grid) { return this.#apply(grid, this.undone, this.done, 'after'); }
    #apply(grid, from, to, side) {
        const step = from.pop();
        const dirty = new Set();
        if (!step) return dirty;
        for (let k = 0; k < step.cells.length; k++) {
            grid.data[step.cells[k]] = step[side][k];
            addTouching(grid, step.cells[k], dirty);
        }
        to.push(step);
        return dirty;
    }
}

const coords = (g, i) => [i % g.sx, Math.floor(i / g.sx) % g.sy, Math.floor(i / (g.sx * g.sy))];

function addTouching(grid, i, dirty) {
    for (const key of chunksTouching(...coords(grid, i))) dirty.add(key);
}

// Set one cell, record it, and note the chunks to remesh.
function setCell(grid, i, value, history, dirty) {
    const before = grid.data[i];
    if (before === value) return;
    grid.data[i] = value;
    history?.record(i, before, value);
    if (before && value) {
        const [x, y, z] = coords(grid, i);
        dirty.add(chunkKey(Math.floor(x / CHUNK), Math.floor(y / CHUNK), Math.floor(z / CHUNK)));
    } else addTouching(grid, i, dirty);
}

/** Centres a mirrored edit also applies to: [x, y, z] plus reflections across the grid's X and/or Z centre. */
export function mirrored(grid, [x, y, z], { x: mx = false, z: mz = false } = {}) {
    const out = [[x, y, z]];
    if (mx) out.push([grid.sx - 1 - x, y, z]);
    if (mz) for (const [px] of [...out]) out.push([px, y, grid.sz - 1 - z]);
    return out;
}

/**
 * Brush over a sphere of `radius` (1 = one voxel) around `center`:
 *   paint — recolour voxels   erase — remove voxels   add — fill empty cells
 */
export function brush(grid, center, radius, op, color, { history, mirror } = {}) {
    const dirty = new Set();
    const r = radius - 1;
    for (const [cx, cy, cz] of mirrored(grid, center, mirror))
        for (let z = cz - r; z <= cz + r; z++)
            for (let y = cy - r; y <= cy + r; y++)
                for (let x = cx - r; x <= cx + r; x++) {
                    if (!inside(grid, x, y, z) || (x - cx) ** 2 + (y - cy) ** 2 + (z - cz) ** 2 > r * r + r) continue;
                    const i = index(grid, x, y, z), c = grid.data[i];
                    if (op === 'paint' && c) setCell(grid, i, color, history, dirty);
                    else if (op === 'erase' && c) setCell(grid, i, 0, history, dirty);
                    else if (op === 'add' && !c) setCell(grid, i, color, history, dirty);
                }
    return dirty;
}

/** Box between two corners (inclusive): fill (every cell), erase, or paint (existing voxels). */
export function box(grid, a, b, op, color, { history } = {}) {
    const dirty = new Set();
    const [x0, x1] = [Math.min(a[0], b[0]), Math.max(a[0], b[0])];
    const [y0, y1] = [Math.min(a[1], b[1]), Math.max(a[1], b[1])];
    const [z0, z1] = [Math.min(a[2], b[2]), Math.max(a[2], b[2])];
    for (let z = z0; z <= z1; z++)
        for (let y = y0; y <= y1; y++)
            for (let x = x0; x <= x1; x++) {
                if (!inside(grid, x, y, z)) continue;
                const i = index(grid, x, y, z);
                if (op === 'fill') setCell(grid, i, color, history, dirty);
                else if (op === 'erase') setCell(grid, i, 0, history, dirty);
                else if (grid.data[i]) setCell(grid, i, color, history, dirty);
            }
    return dirty;
}

/** Recolour the 6-connected region of voxels that share (x, y, z)'s colour. */
export function floodFill(grid, x, y, z, color, { history } = {}) {
    const { data } = grid;
    const dirty = new Set();
    if (!inside(grid, x, y, z)) return dirty;
    const start = index(grid, x, y, z), target = data[start];
    if (!target || target === color) return dirty;

    const queue = [start];
    setCell(grid, start, color, history, dirty);
    for (let q = 0; q < queue.length; q++) {
        const [cx, cy, cz] = coords(grid, queue[q]);
        for (const [dx, dy, dz] of DIRS) {
            const nx = cx + dx, ny = cy + dy, nz = cz + dz;
            if (!inside(grid, nx, ny, nz)) continue;
            const j = index(grid, nx, ny, nz);
            if (data[j] === target) { setCell(grid, j, color, history, dirty); queue.push(j); }
        }
    }
    return dirty;
}

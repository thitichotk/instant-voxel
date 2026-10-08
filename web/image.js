/**
 * image.js — images → Grid, built directly (no mesh step).
 *
 * Pixels arrive as palette indices (0 = transparent) plus a palette, from
 * exactPalette() or the kernel's quantize(). Image row 0 is the top, so pixel
 * (px, py) lands at grid y = height − 1 − py.
 */

import { makeGrid } from './grid.js';

/** { indices, palette } using the image's own colours, or null when it has more than 255. */
export function exactPalette(rgba) {
    const n = rgba.length / 4, indices = new Uint8Array(n), palette = new Uint8Array(256 * 4);
    const seen = new Map();
    for (let i = 0; i < n; i++) {
        if (rgba[4 * i + 3] < 128) continue;
        const key = (rgba[4 * i] << 16) | (rgba[4 * i + 1] << 8) | rgba[4 * i + 2];
        let c = seen.get(key);
        if (c === undefined) {
            if (seen.size === 255) return null;
            c = seen.size + 1;
            seen.set(key, c);
            palette.set([rgba[4 * i], rgba[4 * i + 1], rgba[4 * i + 2], 255], 4 * c);
        }
        indices[i] = c;
    }
    return { indices, palette };
}

/** Pixel art: each opaque pixel becomes a column `thickness` voxels deep (image faces +Z). */
export function extrude(indices, palette, w, h, { thickness = 1 } = {}) {
    const g = makeGrid(w, h, thickness, palette);
    for (let py = 0; py < h; py++)
        for (let px = 0; px < w; px++) {
            const c = indices[px + w * py];
            if (!c) continue;
            for (let z = 0; z < thickness; z++) g.data[px + w * (h - 1 - py + h * z)] = c;
        }
    return g;
}

/**
 * Relief from per-pixel heights in [0, 1] (1 = highest / nearest the viewer).
 *   view 'top'   heightmap terrain: image on the XZ plane, columns rise along +Y.
 *   view 'front' photo depth: image on the XY plane, columns come toward +Z;
 *                `mirror` grows them both ways from the back plane (a full-bodied shape).
 * Every opaque pixel keeps at least one voxel.
 */
export function relief(indices, palette, heights, w, h, { depth = 16, view = 'front', mirror = false } = {}) {
    const top = view === 'top';
    const g = top ? makeGrid(w, depth, h, palette) : makeGrid(w, h, mirror ? 2 * depth : depth, palette);
    for (let py = 0; py < h; py++)
        for (let px = 0; px < w; px++) {
            const i = px + w * py, c = indices[i];
            if (!c) continue;
            const t = Math.max(1, Math.min(depth, Math.round(heights[i] * depth)));
            if (top) {
                for (let y = 0; y < t; y++) g.data[px + w * (y + depth * py)] = c;
            } else {
                const y = h - 1 - py, z0 = mirror ? depth - t : 0, z1 = mirror ? depth + t : t;
                for (let z = z0; z < z1; z++) g.data[px + w * (y + h * z)] = c;
            }
        }
    return g;
}

/** Clears every opaque pixel outside the largest 4-connected opaque region (stray specks after a cut). */
export function keepLargestRegion(rgba, w, h) {
    const label = new Int32Array(w * h).fill(-1);
    let best = -1, bestSize = 0;
    for (let s = 0, id = 0; s < w * h; s++) {
        if (rgba[4 * s + 3] < 128 || label[s] >= 0) continue;
        const stack = [s];
        label[s] = id;
        let size = 0;
        while (stack.length) {
            const i = stack.pop(), x = i % w;
            size++;
            for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w])
                if (j >= 0 && j < w * h && label[j] < 0 && rgba[4 * j + 3] >= 128) { label[j] = id; stack.push(j); }
        }
        if (size > bestSize) { bestSize = size; best = id; }
        id++;
    }
    for (let i = 0; i < w * h; i++) if (label[i] >= 0 && label[i] !== best) rgba[4 * i + 3] = 0;
}

/** Otsu's threshold for values in [0, 1] — splits a depth map into near (subject) and far (background). */
export function otsu(values) {
    const hist = new Float64Array(256);
    for (const v of values) hist[Math.min(255, Math.max(0, Math.round(v * 255)))]++;
    const total = values.length;
    let sum = 0;
    for (let i = 0; i < 256; i++) sum += i * hist[i];
    let sumB = 0, wB = 0, best = 0, threshold = 0;
    for (let i = 0; i < 256; i++) {
        wB += hist[i];
        if (!wB || wB === total) continue;
        sumB += i * hist[i];
        const mB = sumB / wB, mF = (sum - sumB) / (total - wB);
        const between = wB * (total - wB) * (mB - mF) ** 2;
        if (between > best) { best = between; threshold = i; }
    }
    return (threshold + 0.5) / 255;
}

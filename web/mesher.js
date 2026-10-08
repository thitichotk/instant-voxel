/**
 * mesher.js — turns Grid chunks into quads (see grid.js for the Grid layout).
 *
 * Only faces between a voxel and empty space are emitted. `greedy` merges
 * same-coloured neighbouring faces into larger quads; culled mode (greedy off)
 * keeps one quad per face, which avoids T-junctions (used for STL).
 *
 * Output per chunk (positions in voxel units, grid space):
 *   { positions: Float32Array(xyz), normals: Float32Array(xyz),
 *     colors: Float32Array(linear rgb), uvs: Float32Array (voxel units along
 *     the quad, for the repeating "lines" texture), indices: Uint32Array,
 *     quads, faceColors: Uint8Array (palette index per quad) }
 */

export const CHUNK = 32;

const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

/** Linear RGB floats for all 256 palette entries. */
export function linearPalette(palette) {
    const out = new Float32Array(256 * 3);
    for (let i = 0; i < 256; i++)
        for (let c = 0; c < 3; c++) out[3 * i + c] = toLinear(palette[4 * i + c] / 255);
    return out;
}

export const chunkKey = (cx, cy, cz) => `${cx},${cy},${cz}`;

// Scratch buffers shared by every meshChunk call (grown on demand, sliced on output).
let cap = 0, P, N, C, T, F;
function reserve(quads) {
    if (quads <= cap) return;
    const grow = (Type, old, per) => { const a = new Type(cap * per); if (old) a.set(old); return a; };
    cap = Math.max(quads, 2 * cap, 4096);
    [P, N, C, T, F] = [grow(Float32Array, P, 12), grow(Float32Array, N, 12), grow(Float32Array, C, 12), grow(Float32Array, T, 8), grow(Uint16Array, F, 1)];
}
const masks = { pos: new Uint8Array(CHUNK * CHUNK), neg: new Uint8Array(CHUNK * CHUNK) };

export function meshChunk(grid, cx, cy, cz, { greedy = true, linear = linearPalette(grid.palette) } = {}) {
    const { sx, sy, sz, data } = grid;
    const size = [sx, sy, sz];
    const stride = [1, sx, sx * sy];
    const lo = [cx * CHUNK, cy * CHUNK, cz * CHUNK];
    const n = lo.map((l, a) => Math.min(CHUNK, size[a] - l));
    if (n.some((v) => v <= 0)) return null;

    let q = 0;
    // (u, v, d) is right-handed, so corners (A,B) (A+w,B) (A+w,B+h) (A,B+h) run CCW seen from +d.
    const quad = (d, u, v, s, plane, A, B, w, h, c) => {
        reserve(q + 1);
        for (let k = 0; k < 4; k++) {
            const du = k === 1 || k === 2 ? w : 0, dv = k >= 2 ? h : 0;
            const o = 12 * q + 3 * k;
            P[o + d] = plane; P[o + u] = A + du; P[o + v] = B + dv;
            N[o + d] = s; N[o + u] = 0; N[o + v] = 0;
            C[o] = linear[3 * c]; C[o + 1] = linear[3 * c + 1]; C[o + 2] = linear[3 * c + 2];
            T[8 * q + 2 * k] = du; T[8 * q + 2 * k + 1] = dv;
        }
        F[q++] = s > 0 ? c : c | 0x100;   // remember the winding with the colour
    };

    const greedyMerge = (mask, W, H, emit) => {
        for (let b = 0; b < H; b++)
            for (let a = 0; a < W;) {
                const c = mask[a + b * W];
                if (!c) { a++; continue; }
                let w = 1, h = 1;
                if (greedy) {
                    while (a + w < W && mask[a + w + b * W] === c) w++;
                    grow: while (b + h < H) {
                        for (let k = 0; k < w; k++) if (mask[a + k + (b + h) * W] !== c) break grow;
                        h++;
                    }
                }
                emit(a, b, w, h, c);
                for (let hh = 0; hh < h; hh++) mask.fill(0, a + (b + hh) * W, a + w + (b + hh) * W);
                a += w;
            }
    };

    for (let d = 0; d < 3; d++) {
        const u = (d + 1) % 3, v = (d + 2) % 3;
        const W = n[u], H = n[v], su = stride[u], sd = stride[d];
        for (let i = 0; i < n[d]; i++) {
            const cd = lo[d] + i;
            const topOpen = cd + 1 >= size[d], bottomOpen = cd - 1 < 0;
            // Faces toward +d and −d for this slice, built in one pass.
            for (let b = 0, m = 0; b < H; b++) {
                let gi = cd * sd + lo[u] * su + (lo[v] + b) * stride[v];
                for (let a = 0; a < W; a++, m++, gi += su) {
                    const c = data[gi];
                    masks.pos[m] = c && (topOpen || !data[gi + sd]) ? c : 0;
                    masks.neg[m] = c && (bottomOpen || !data[gi - sd]) ? c : 0;
                }
            }
            greedyMerge(masks.pos, W, H, (a, b, w, h, c) => quad(d, u, v, 1, cd + 1, lo[u] + a, lo[v] + b, w, h, c));
            greedyMerge(masks.neg, W, H, (a, b, w, h, c) => quad(d, u, v, -1, cd, lo[u] + a, lo[v] + b, w, h, c));
        }
    }
    if (!q) return null;

    const indices = new Uint32Array(6 * q), faceColors = new Uint8Array(q);
    for (let k = 0; k < q; k++) {
        const b = 4 * k, o = 6 * k, flip = F[k] & 0x100 ? 1 : 0;
        indices[o] = b; indices[o + 1] = b + 1 + flip; indices[o + 2] = b + 2 - flip;
        indices[o + 3] = b; indices[o + 4] = b + 2 + flip; indices[o + 5] = b + 3 - flip;
        faceColors[k] = F[k] & 0xff;
    }
    return {
        positions: P.slice(0, 12 * q), normals: N.slice(0, 12 * q), colors: C.slice(0, 12 * q),
        uvs: T.slice(0, 8 * q), indices, quads: q, faceColors,
    };
}

/**
 * Meshes every chunk that can have faces: Map(chunkKey → chunk mesh).
 * One pass counts voxels per chunk; empty chunks, and full chunks whose six
 * neighbours are full too (a solid model's interior), are skipped.
 */
export function meshGrid(grid, opts = {}) {
    const linear = linearPalette(grid.palette);
    const { sx, sy, sz, data } = grid;
    const [nx, ny, nz] = [sx, sy, sz].map((s) => Math.ceil(s / CHUNK));
    const counts = new Uint32Array(nx * ny * nz);
    for (let z = 0, i = 0; z < sz; z++)
        for (let y = 0; y < sy; y++) {
            const row = nx * (Math.floor(y / CHUNK) + ny * Math.floor(z / CHUNK));
            for (let x = 0; x < sx; x++, i++) if (data[i]) counts[row + Math.floor(x / CHUNK)]++;
        }
    const volume = (cx, cy, cz) =>
        [[cx, sx], [cy, sy], [cz, sz]].reduce((v, [c, s]) => v * Math.min(CHUNK, s - c * CHUNK), 1);
    const full = (cx, cy, cz) =>
        cx >= 0 && cy >= 0 && cz >= 0 && cx < nx && cy < ny && cz < nz &&
        counts[cx + nx * (cy + ny * cz)] === volume(cx, cy, cz);

    const out = new Map();
    for (let cz = 0; cz < nz; cz++)
        for (let cy = 0; cy < ny; cy++)
            for (let cx = 0; cx < nx; cx++) {
                if (!counts[cx + nx * (cy + ny * cz)]) continue;
                if (full(cx, cy, cz) && full(cx - 1, cy, cz) && full(cx + 1, cy, cz) && full(cx, cy - 1, cz) &&
                    full(cx, cy + 1, cz) && full(cx, cy, cz - 1) && full(cx, cy, cz + 1)) continue;
                const m = meshChunk(grid, cx, cy, cz, { ...opts, linear });
                if (m) out.set(chunkKey(cx, cy, cz), m);
            }
    return out;
}

/** Keys of the chunks a voxel edit at (x, y, z) can change (its own and face neighbours'). */
export function chunksTouching(x, y, z) {
    const keys = new Set();
    for (const [dx, dy, dz] of [[0, 0, 0], [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
        const [px, py, pz] = [x + dx, y + dy, z + dz];
        if (px >= 0 && py >= 0 && pz >= 0) keys.add(chunkKey(Math.floor(px / CHUNK), Math.floor(py / CHUNK), Math.floor(pz / CHUNK)));
    }
    return keys;
}

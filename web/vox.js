/**
 * vox.js — MagicaVoxel .vox read/write for the Y-up Grid (see grid.js).
 *
 * MagicaVoxel is right-handed Z-up (x right, y away from the viewer, z up), so
 * a grid voxel (x, y, z) is stored at vox (x, sz − 1 − z, y). This is a
 * rotation, not a mirror: models stay upright and unflipped in both.
 *
 * Grids up to 256 on every vox axis are written as one model. Larger grids
 * become a scene: ≤256³ models placed by an nTRN → nGRP → (nTRN → nSHP)*
 * graph. A model's translation `_t` is its centre; writer and reader both use
 * voxel = _t − size/2 + v, and written models have even sizes so size/2 is exact.
 */

import { makeGrid, MAX_DIM } from './grid.js';

const enc = new TextEncoder();
const dec = new TextDecoder();

// ── Writing ──────────────────────────────────────────────────────────────────

const concat = (parts) => {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
};

function i32s(...vals) {
    const b = new Uint8Array(4 * vals.length);
    const dv = new DataView(b.buffer);
    vals.forEach((v, i) => dv.setInt32(4 * i, v, true));
    return b;
}

function dict(obj) {
    const parts = [i32s(Object.keys(obj).length)];
    for (const [k, v] of Object.entries(obj))
        for (const s of [k, String(v)]) {
            const b = enc.encode(s);
            parts.push(i32s(b.length), b);
        }
    return concat(parts);
}

function chunk(id, content, children = new Uint8Array(0)) {
    return concat([enc.encode(id), i32s(content.length, children.length), content, children]);
}

/** Grid → .vox bytes (Uint8Array). */
export function writeVox(grid) {
    const { sx, sy, sz, data, palette } = grid;
    const dims = [sx, sz, sy];                                  // vox x, y, z extents
    const tiles = dims.map((n) => Math.ceil(n / 256));
    const multi = tiles.some((t) => t > 1);

    // Pass 1: voxels per model (tile); pass 2: fill each model's XYZI.
    const tileOf = (vx, vy, vz) => (vx >> 8) + tiles[0] * ((vy >> 8) + tiles[1] * (vz >> 8));
    const counts = new Uint32Array(tiles[0] * tiles[1] * tiles[2]);
    const each = (fn) => {
        for (let z = 0, i = 0; z < sz; z++)
            for (let y = 0; y < sy; y++)
                for (let x = 0; x < sx; x++, i++)
                    if (data[i]) fn(x, sz - 1 - z, y, data[i]);
    };
    each((vx, vy, vz) => counts[tileOf(vx, vy, vz)]++);
    const xyzi = [...counts].map((n) => new Uint8Array(4 * n));
    const fill = new Uint32Array(counts.length);
    each((vx, vy, vz, c) => {
        const t = tileOf(vx, vy, vz);
        xyzi[t].set([vx & 255, vy & 255, vz & 255, c], 4 * fill[t]++);
    });

    const models = [];   // { size: [w, d, h], origin: [ox, oy, oz], xyzi }
    for (let tz = 0; tz < tiles[2]; tz++)
        for (let ty = 0; ty < tiles[1]; ty++)
            for (let tx = 0; tx < tiles[0]; tx++) {
                const t = tx + tiles[0] * (ty + tiles[1] * tz);
                if (multi && !counts[t]) continue;
                const origin = [tx * 256, ty * 256, tz * 256];
                // Even sizes keep the scene pivot (size/2) exact; empty space is fine.
                const size = origin.map((o, a) => {
                    const n = Math.min(256, dims[a] - o);
                    return multi ? n + (n & 1) : n;
                });
                models.push({ size, origin, xyzi: xyzi[t] });
            }

    const children = [];
    for (const m of models) {
        children.push(chunk('SIZE', i32s(...m.size)));
        children.push(chunk('XYZI', concat([i32s(m.xyzi.length / 4), m.xyzi])));
    }
    if (multi) {
        children.push(chunk('nTRN', concat([i32s(0), dict({}), i32s(1, -1, -1, 1), dict({})])));
        children.push(chunk('nGRP', concat([i32s(1), dict({}), i32s(models.length, ...models.map((_, i) => 2 + 2 * i))])));
        models.forEach((m, i) => {
            const t = m.origin.map((o, a) => o + m.size[a] / 2).join(' ');
            children.push(chunk('nTRN', concat([i32s(2 + 2 * i), dict({}), i32s(3 + 2 * i, -1, 0, 1), dict({ _t: t })])));
            children.push(chunk('nSHP', concat([i32s(3 + 2 * i), dict({}), i32s(1, i), dict({})])));
        });
    }
    // RGBA entry i holds colour index i + 1.
    const rgba = new Uint8Array(1024);
    for (let i = 0; i < 256; i++) rgba.set(palette.subarray(4 * ((i + 1) & 255), 4 * ((i + 1) & 255) + 4), 4 * i);
    children.push(chunk('RGBA', rgba));

    return concat([enc.encode('VOX '), i32s(150), chunk('MAIN', new Uint8Array(0), concat(children))]);
}

// ── Reading ──────────────────────────────────────────────────────────────────

/** MagicaVoxel's built-in palette, for files without an RGBA chunk. */
function defaultVoxPalette() {
    const p = new Uint8Array(1024);
    const lv = [255, 204, 153, 102, 51, 0];
    let i = 1;
    for (const r of lv) for (const g of lv) for (const b of lv) if (i <= 215) p.set([r, g, b, 255], 4 * i++);
    for (let ch = 0; ch < 4; ch++)
        for (const v of [0xee, 0xdd, 0xbb, 0xaa, 0x88, 0x77, 0x55, 0x44, 0x22, 0x11])
            p.set(ch === 3 ? [v, v, v, 255] : [0, 1, 2].map((c) => (c === ch ? v : 0)).concat(255), 4 * i++);
    return p;
}

/** .vox bytes (ArrayBuffer | Uint8Array) → Grid. Scene rotations (_r) are ignored. */
export function readVox(buf) {
    const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (dec.decode(bytes.subarray(0, 4)) !== 'VOX ') throw new Error('Not a .vox file.');

    let o = 0;
    const i32 = () => { const v = dv.getInt32(o, true); o += 4; return v; };
    const str = () => { const n = i32(); const s = dec.decode(bytes.subarray(o, o + n)); o += n; return s; };
    const readDict = () => { const d = {}; for (let n = i32(); n > 0; n--) { const k = str(); d[k] = str(); } return d; };

    const models = [];
    const nodes = new Map();
    let palette = null, size = null;

    const walk = (start, end) => {
        for (let at = start; at + 12 <= end;) {
            const id = dec.decode(bytes.subarray(at, at + 4));
            const content = dv.getInt32(at + 4, true), childBytes = dv.getInt32(at + 8, true);
            o = at + 12;
            if (id === 'MAIN') walk(o + content, o + content + childBytes);
            else if (id === 'SIZE') size = [i32(), i32(), i32()];
            else if (id === 'XYZI') { const n = i32(); models.push({ size, xyzi: bytes.subarray(o, o + 4 * n) }); }
            else if (id === 'RGBA') {
                palette = new Uint8Array(1024);
                for (let i = 0; i < 255; i++) palette.set(bytes.subarray(o + 4 * i, o + 4 * i + 4), 4 * (i + 1));
            } else if (id === 'nTRN') {
                const nid = i32(); readDict();
                const child = i32(); i32(); i32();
                const frame = i32() > 0 ? readDict() : {};
                nodes.set(nid, { child, t: (frame._t ?? '0 0 0').split(' ').map(Number) });
            } else if (id === 'nGRP') {
                const nid = i32(); readDict();
                const kids = []; for (let n = i32(); n > 0; n--) kids.push(i32());
                nodes.set(nid, { kids });
            } else if (id === 'nSHP') {
                const nid = i32(); readDict();
                i32();
                nodes.set(nid, { model: i32() });
            }
            at += 12 + content + childBytes;
        }
    };
    walk(8, bytes.length);

    // Place each model: through the scene graph if there is one, else at 0.
    const placed = [];   // { model, offset: [x, y, z] } in vox coordinates
    if (nodes.size) {
        const visit = (id, t) => {
            const n = nodes.get(id);
            if (!n) return;
            if (n.child !== undefined) visit(n.child, t.map((v, a) => v + n.t[a]));
            else if (n.kids) n.kids.forEach((k) => visit(k, t));
            else if (models[n.model]) {
                const m = models[n.model];
                placed.push({ model: m, offset: t.map((v, a) => v - Math.floor(m.size[a] / 2)) });
            }
        };
        visit(0, [0, 0, 0]);
    } else models.forEach((m) => placed.push({ model: m, offset: [0, 0, 0] }));

    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const { model, offset } of placed)
        for (let i = 0; i < model.xyzi.length; i += 4)
            for (let a = 0; a < 3; a++) {
                const v = offset[a] + model.xyzi[i + a];
                lo[a] = Math.min(lo[a], v);
                hi[a] = Math.max(hi[a], v);
            }
    if (lo[0] === Infinity) return makeGrid(1, 1, 1, palette ?? defaultVoxPalette());

    const [w, d, h] = hi.map((v, a) => v - lo[a] + 1);
    if (Math.max(w, d, h) > MAX_DIM) throw new Error(`Model is ${w}×${h}×${d}; the limit is ${MAX_DIM} per axis.`);
    const grid = makeGrid(w, h, d, palette ?? defaultVoxPalette());
    for (const { model, offset } of placed)
        for (let i = 0; i < model.xyzi.length; i += 4) {
            const vx = offset[0] + model.xyzi[i] - lo[0];
            const vy = offset[1] + model.xyzi[i + 1] - lo[1];
            const vz = offset[2] + model.xyzi[i + 2] - lo[2];
            grid.data[vx + w * (vz + h * (d - 1 - vy))] = model.xyzi[i + 3];
        }
    return grid;
}

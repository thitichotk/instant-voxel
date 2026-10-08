/**
 * schem.js — Grid → Sponge Schematic v2 (.schem): gzip-compressed,
 * big-endian NBT, loaded by WorldEdit / FAWE / Litematica.
 *
 * Root compound "Schematic": Version 2, DataVersion, Width / Height / Length
 * (x / y / z), PaletteMax, Palette (block id → index, air = 0), BlockData
 * (one varint per block, ordered x + z·Width + y·Width·Length), Offset.
 * Both are Y-up, so grid axes map straight across.
 */

import { MC_BLOCKS } from './mc-blocks.js';
import { oklab } from './palettes.js';

const DATA_VERSION = 3955;   // Minecraft 1.21.1
const enc = new TextEncoder();

/** Nearest block (Oklab distance) for each palette entry in use: Map(entry → block id). */
export function nearestBlocks(palette, used) {
    const blocks = MC_BLOCKS.map((b) => ({ id: b.id, lab: oklab(...b.rgb) }));
    const out = new Map();
    for (let i = 1; i < 256; i++) {
        if (!used[i]) continue;
        const c = oklab(palette[4 * i], palette[4 * i + 1], palette[4 * i + 2]);
        let best = null, bestD = Infinity;
        for (const b of blocks) {
            const d = (b.lab[0] - c[0]) ** 2 + (b.lab[1] - c[1]) ** 2 + (b.lab[2] - c[2]) ** 2;
            if (d < bestD) { bestD = d; best = b.id; }
        }
        out.set(i, best);
    }
    return out;
}

function nbtWriter() {
    let buf = new Uint8Array(1 << 16), n = 0;
    const need = (k) => {
        if (n + k <= buf.length) return;
        const b = new Uint8Array(Math.max(2 * buf.length, n + k));
        b.set(buf);
        buf = b;
    };
    const u8 = (v) => { need(1); buf[n++] = v; };
    const i16 = (v) => { need(2); buf[n++] = (v >> 8) & 255; buf[n++] = v & 255; };
    const i32 = (v) => { need(4); for (let s = 24; s >= 0; s -= 8) buf[n++] = (v >> s) & 255; };
    const str = (s) => { const b = enc.encode(s); i16(b.length); need(b.length); buf.set(b, n); n += b.length; };
    const tag = (type, name) => { u8(type); str(name); };
    return {
        short: (name, v) => { tag(2, name); i16(v); },
        int: (name, v) => { tag(3, name); i32(v); },
        bytes: (name, a) => { tag(7, name); i32(a.length); need(a.length); buf.set(a, n); n += a.length; },
        ints: (name, a) => { tag(11, name); i32(a.length); a.forEach(i32); },
        compound: (name, body) => { tag(10, name); body(); u8(0); },
        done: () => buf.slice(0, n),
    };
}

/** Grid → gzip-compressed .schem bytes. */
export async function writeSchem(grid) {
    const { sx, sy, sz, data, palette } = grid;
    const used = new Uint8Array(256);
    for (let i = 0; i < data.length; i++) used[data[i]] = 1;
    const blockOf = nearestBlocks(palette, used);

    // Schematic palette: air = 0, then each block once, in order of first use.
    const ids = new Map([['minecraft:air', 0]]);
    const index = new Uint8Array(256);   // grid palette entry → schematic index (< 128: one varint byte)
    for (const [entry, id] of blockOf) {
        if (!ids.has(id)) ids.set(id, ids.size);
        index[entry] = ids.get(id);
    }
    if (ids.size > 128) throw new Error('Too many block types for one-byte BlockData.');

    const blockData = new Uint8Array(sx * sy * sz);
    for (let y = 0, o = 0; y < sy; y++)
        for (let z = 0; z < sz; z++)
            for (let x = 0; x < sx; x++) blockData[o++] = index[data[x + sx * (y + sy * z)]];

    const w = nbtWriter();
    w.compound('Schematic', () => {
        w.int('Version', 2);
        w.int('DataVersion', DATA_VERSION);
        w.short('Width', sx);
        w.short('Height', sy);
        w.short('Length', sz);
        w.int('PaletteMax', ids.size);
        w.compound('Palette', () => { for (const [id, i] of ids) w.int(id, i); });
        w.bytes('BlockData', blockData);
        w.ints('Offset', [0, 0, 0]);
    });
    const gz = new Blob([w.done()]).stream().pipeThrough(new CompressionStream('gzip'));
    return new Uint8Array(await new Response(gz).arrayBuffer());
}

// Self-checks for the voxel kernel (web/voxelizer.wasm) and the pure web modules.
// Run: node tests/run.mjs   (exits non-zero on the first failure)
import fs from 'node:fs';
import zlib from 'node:zlib';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

// The Emscripten glue fetches voxelizer.wasm next to itself via a file:// URL.
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => String(url).startsWith('file:')
    ? new Response(fs.readFileSync(fileURLToPath(String(url))), { headers: { 'content-type': 'application/wasm' } })
    : realFetch(url, opts);

const { default: VoxelizerModule } = await import('../web/voxelizer.js');
const { makeGrid, index, countVoxels } = await import('../web/grid.js');
const { writeVox, readVox } = await import('../web/vox.js');
const { meshChunk, meshGrid } = await import('../web/mesher.js');
const { parseHex, defaultCube, minecraftPalette } = await import('../web/palettes.js');
const { floodFill, brush, box: boxEdit, History } = await import('../web/editor.js');
const { writeSchem } = await import('../web/schem.js');
const { toOBJ } = await import('../web/export.js');
const { exactPalette, extrude, relief, otsu, keepLargestRegion } = await import('../web/image.js');

const K = await VoxelizerModule();
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// ── meshes ───────────────────────────────────────────────────────────────────

function box([x0, y0, z0], [x1, y1, z1], material = 0) {
    const p = [];
    for (const z of [z0, z1]) for (const y of [y0, y1]) for (const x of [x0, x1]) p.push(x, y, z);
    const q = [[0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5]];
    return { p, t: q.flatMap(([a, b, c, d]) => [a, b, c, a, c, d]), material };
}

function mesh(parts, extra = {}) {
    const positions = [], indices = [], triMaterial = [];
    for (const { p, t, material } of parts) {
        const base = positions.length / 3;
        positions.push(...p);
        indices.push(...t.map((i) => i + base));
        triMaterial.push(...Array(t.length / 3).fill(material));
    }
    return {
        positions: new Float32Array(positions), indices: new Uint32Array(indices),
        triMaterial: new Uint16Array(triMaterial), ...extra,
    };
}

const red = new Float32Array([1, 0, 0, 1, 0, -1, 0, 0, 1, 1, 0, -1]);   // materials: red, blue
const vox = (m, opts) => {
    const r = K.voxelize(m, { size: 16, colors: 255, ...opts });
    return { ...r, data: r.data.slice(), palette: r.palette.slice() };
};

// ── kernel ───────────────────────────────────────────────────────────────────

test('closed cube: surface shell, solid fill, hollow', () => {
    const cube = mesh([box([0, 0, 0], [1, 1, 1])], { materials: red });
    const s = vox(cube, {});
    assert.deepEqual([s.sx, s.sy, s.sz], [16, 16, 16]);
    assert.equal(s.count, 16 ** 3 - 14 ** 3);
    assert.equal(vox(cube, { solid: true }).count, 16 ** 3);
    assert.equal(vox(cube, { solid: true, hollow: 2 }).count, 16 ** 3 - 12 ** 3);
    assert.deepEqual([...s.palette.subarray(4, 8)], [255, 0, 0, 255]);   // linear red → sRGB red
});

test('fit axis and the 512 cap', () => {
    const bar = mesh([box([0, 0, 0], [2, 1, 1])]);
    const r = vox(bar, { size: 10, axis: 1 });
    assert.deepEqual([r.sx, r.sy, r.sz], [20, 10, 10]);
    const long = vox(mesh([box([0, 0, 0], [10, 1, 1])]), { size: 100, axis: 1 });
    assert.equal(long.sx, 512);
});

test('two materials keep their colours; islands below minIsland go', () => {
    const m = mesh([box([0, 0, 0], [1, 1, 1], 0), box([1.9, 0, 0], [2, 0.1, 0.1], 1)], { materials: red });
    const r = vox(m, { size: 20 });
    const colors = new Set([...r.data].filter(Boolean).map((c) => [...r.palette.subarray(4 * c, 4 * c + 3)].join()));
    assert.deepEqual([...colors].sort(), ['0,0,255', '255,0,0']);
    const cut = vox(m, { size: 20, minIsland: 10 });
    const blue = (g) => [...g.data].filter((c) => c && g.palette[4 * c + 2] === 255).length;
    assert.ok(blue(r) > 0 && blue(cut) === 0 && cut.count === r.count - blue(r));
});

test('texture sampling per voxel, alpha cutoff, vertex colours', () => {
    // A unit quad in the XY plane; a 2×1 texture: left red, right transparent blue.
    const quad = { p: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0], t: [0, 1, 2, 0, 2, 3], material: 0 };
    const uvs = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]);
    const textures = [{ width: 2, height: 1, data: new Uint8Array([255, 0, 0, 255, 0, 0, 255, 0]) }];
    const opaque = vox(mesh([quad], { uvs, textures, materials: new Float32Array([1, 1, 1, 1, 0, 0]) }), { size: 8 });
    const at = (r, x, y) => [...r.palette.subarray(4 * r.data[x + r.sx * y], 4 * r.data[x + r.sx * y] + 3)].join();
    assert.equal(at(opaque, 1, 4), '255,0,0');
    assert.equal(at(opaque, 6, 4), '0,0,255');
    const cut = vox(mesh([quad], { uvs, textures, materials: new Float32Array([1, 1, 1, 1, 0.5, 0]) }), { size: 8 });
    assert.equal(cut.count, opaque.count / 2);
    // Vertex colours: red at x = 0, green at x = 1.
    const colors = new Float32Array([1, 0, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 1, 0, 0, 1]);
    const vc = vox(mesh([quad], { colors }), { size: 8 });
    assert.ok(at(vc, 0, 4).startsWith('2') && at(vc, 7, 4).split(',')[1] > 200);
});

test('auto palette size, fixed palettes, dither is deterministic', () => {
    const cube = mesh([box([0, 0, 0], [1, 1, 1])], {
        colors: new Float32Array(Array.from({ length: 8 }, (_, i) => [i & 1, (i >> 1) & 1, (i >> 2) & 1, 1]).flat()),
    });
    const four = vox(cube, { size: 24, colors: 4 });
    assert.ok(new Set(four.data).size - 1 <= 4);
    const fixed = vox(cube, { size: 24, palette: defaultCube() });
    assert.deepEqual([...fixed.palette], [...defaultCube()]);
    const d1 = vox(cube, { size: 24, colors: 8, dither: true }), d2 = vox(cube, { size: 24, colors: 8, dither: true });
    assert.deepEqual(d1.data, d2.data);
});

test('quantize: exact when few colours, transparent pixels stay empty', () => {
    const rgba = new Uint8Array([10, 20, 30, 255, 200, 100, 50, 255, 0, 0, 0, 0]);
    const q = K.quantize(rgba, { colors: 255 });
    const idx = q.indices.slice(), pal = q.palette.slice();
    assert.equal(idx[2], 0);
    assert.deepEqual([...pal.subarray(4 * idx[0], 4 * idx[0] + 3)], [10, 20, 30]);
    assert.deepEqual([...pal.subarray(4 * idx[1], 4 * idx[1] + 3)], [200, 100, 50]);
});

test('fixed palettes skip empty (alpha 0) entries', () => {
    const cube = mesh([box([0, 0, 0], [1, 1, 1])], { materials: new Float32Array([0.05, 0.001, 0.001, 1, 0, -1]) });
    const r = vox(cube, { size: 8, palette: minecraftPalette() });
    const c = r.data.find(Boolean);
    assert.equal(r.palette[4 * c + 3], 255);                 // a real block colour, not an empty slot
    assert.ok(r.palette[4 * c] > r.palette[4 * c + 2]);      // and a red one
});

test('empty mesh gives a 1×1×1 empty grid', () => {
    const r = vox({ positions: new Float32Array(0), indices: new Uint32Array(0) }, {});
    assert.deepEqual([r.sx, r.sy, r.sz, r.count], [1, 1, 1, 0]);
});

// ── pure modules ─────────────────────────────────────────────────────────────

function randomGrid(sx, sy, sz, seed = 1) {
    const g = makeGrid(sx, sy, sz);
    let s = seed;
    const rnd = () => (s = (s * 1103515245 + 12345) >>> 0) / 2 ** 32;
    for (let i = 0; i < g.data.length; i++) g.data[i] = rnd() < 0.3 ? 1 + Math.floor(rnd() * 255) : 0;
    for (let i = 4; i < 1024; i++) g.palette[i] = Math.floor(rnd() * 256);
    return g;
}

test('.vox round-trip: one model, and a multi-model scene past 256', () => {
    for (const [sx, sy, sz] of [[64, 64, 64], [300, 40, 20], [20, 270, 300]]) {
        const g = randomGrid(sx, sy, sz, sx);
        // Keep a voxel on every bound so the read-back grid has the same extent.
        for (const [x, y, z] of [[0, 0, 0], [sx - 1, sy - 1, sz - 1]]) g.data[index(g, x, y, z)] = 7;
        const back = readVox(writeVox(g));
        assert.deepEqual([back.sx, back.sy, back.sz], [sx, sy, sz]);
        assert.deepEqual(back.data, g.data);
        assert.deepEqual(back.palette.subarray(4), g.palette.subarray(4));
    }
});

test('.vox axes: grid +y (up) is MagicaVoxel +z', () => {
    const g = makeGrid(1, 3, 1);
    g.data[index(g, 0, 2, 0)] = 5;    // top voxel
    const bytes = writeVox(g);
    const dv = new DataView(bytes.buffer);
    // MAIN(12+8) → SIZE chunk (12 + 12) → XYZI chunk header (12) + count (4) → first voxel
    const size = [0, 1, 2].map((a) => dv.getInt32(20 + 12 + 4 * a, true));
    assert.deepEqual(size, [1, 1, 3]);
    assert.deepEqual([...bytes.subarray(20 + 24 + 16, 20 + 24 + 20)], [0, 0, 2, 5]);
});

test('mesher: quad counts, greedy merging, chunk borders', () => {
    const one = makeGrid(1, 1, 1); one.data[0] = 1;
    assert.equal(meshChunk(one, 0, 0, 0).quads, 6);
    const tall = makeGrid(1, 2, 1); tall.data.fill(1);
    assert.equal(meshChunk(tall, 0, 0, 0).quads, 6);
    assert.equal(meshChunk(tall, 0, 0, 0, { greedy: false }).quads, 10);
    tall.data[1] = 2;
    assert.equal(meshChunk(tall, 0, 0, 0).quads, 10);
    const bar = makeGrid(33, 1, 1); bar.data.fill(1);   // spans two chunks
    const chunks = meshGrid(bar);
    assert.equal(chunks.size, 2);
    assert.equal([...chunks.values()].reduce((n, c) => n + c.quads, 0), 10);
});

// Minimal big-endian NBT reader, enough for the .schem check.
function readNBT(buf) {
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    let o = 0;
    const str = () => { const n = dv.getUint16(o); o += 2; const s = new TextDecoder().decode(buf.subarray(o, o + n)); o += n; return s; };
    const payload = (t) => {
        if (t === 2) { o += 2; return dv.getInt16(o - 2); }
        if (t === 3) { o += 4; return dv.getInt32(o - 4); }
        if (t === 7) { const n = dv.getInt32(o); o += 4 + n; return buf.subarray(o - n, o); }
        if (t === 11) { const n = dv.getInt32(o); o += 4; return Array.from({ length: n }, () => payload(3)); }
        if (t === 10) { const obj = {}; for (let tt; (tt = buf[o++]);) { const k = str(); obj[k] = payload(tt); } return obj; }
        throw new Error(`unexpected NBT tag ${t}`);
    };
    const t = buf[o++];
    return { name: str(), value: payload(t) };
}

test('.schem: gzip NBT, Sponge v2 fields, x + z·W + y·W·L order, nearest blocks', async () => {
    const g = makeGrid(2, 3, 4);
    g.palette.set([240, 240, 240, 255, 150, 30, 30, 255], 4);   // entry 1 white, entry 2 red
    g.data.fill(1);
    g.data[index(g, 1, 2, 3)] = 2;
    g.data[index(g, 0, 0, 0)] = 0;
    const { name, value: s } = readNBT(zlib.gunzipSync(await writeSchem(g)));
    assert.equal(name, 'Schematic');
    assert.deepEqual([s.Version, s.Width, s.Height, s.Length], [2, 2, 3, 4]);
    assert.equal(s.Palette['minecraft:air'], 0);
    const blockAt = (x, y, z) => Object.keys(s.Palette).find((k) => s.Palette[k] === s.BlockData[x + z * 2 + y * 2 * 4]);
    assert.equal(blockAt(0, 0, 0), 'minecraft:air');
    assert.match(blockAt(1, 2, 3), /red/);
    assert.match(blockAt(1, 1, 1), /white/);
    assert.equal(s.PaletteMax, Object.keys(s.Palette).length);
});

test('.obj: coloured vertices and triangle faces', () => {
    const g = makeGrid(1, 1, 1);
    g.data[0] = 1;
    g.palette.set([255, 0, 0, 255], 4);
    const lines = toOBJ(g).split('\n');
    assert.equal(lines.filter((l) => l.startsWith('v ')).length, 24);
    assert.equal(lines.filter((l) => l.startsWith('f ')).length, 12);
    assert.ok(lines.find((l) => l.startsWith('v ')).endsWith(' 1 0 0'));
});

test('images: exact palettes, extrude, relief, Otsu, largest region', () => {
    // 2×2 image, top row red + transparent, bottom row two blues.
    const rgba = new Uint8Array([255, 0, 0, 255, 0, 0, 0, 0, 0, 0, 255, 255, 0, 0, 255, 255]);
    const { indices, palette } = exactPalette(rgba);
    assert.deepEqual([...indices], [1, 0, 2, 2]);
    assert.deepEqual([...palette.subarray(4, 12)], [255, 0, 0, 255, 0, 0, 255, 255]);
    const e = extrude(indices, palette, 2, 2, { thickness: 3 });
    assert.deepEqual([e.sx, e.sy, e.sz, countVoxels(e)], [2, 2, 3, 9]);
    assert.equal(e.data[index(e, 0, 1, 2)], 1);                    // image top row → grid top (y = 1)
    const heights = new Float32Array([1, 0, 0.5, 0]);
    const front = relief(indices, palette, heights, 2, 2, { depth: 4 });
    assert.equal(countVoxels(front), 4 + 2 + 1);                    // 1 → 4 deep, 0.5 → 2, 0 → at least 1
    assert.equal(countVoxels(relief(indices, palette, heights, 2, 2, { depth: 4, mirror: true })), 2 * 7);
    assert.deepEqual([...[relief(indices, palette, heights, 2, 2, { depth: 4, view: 'top' })].map((g) => [g.sx, g.sy, g.sz])[0]], [2, 4, 2]);
    const many = new Uint8Array(256 * 4).map((_, i) => (i % 4 === 0 ? i / 4 : i % 4 === 3 ? 255 : 0));
    assert.equal(exactPalette(many), null);                        // 256 distinct colours → quantize instead
    const t = otsu([0.1, 0.12, 0.15, 0.8, 0.85, 0.9]);
    assert.ok(t > 0.15 && t < 0.8);
    const specks = new Uint8Array(4 * 5).fill(255);                // 5×1 row: opaque, opaque, gap, opaque, opaque, …
    specks[4 * 2 + 3] = 0;
    specks[4 * 4 + 3] = 0;
    keepLargestRegion(specks, 5, 1);
    assert.deepEqual([0, 1, 2, 3, 4].map((i) => specks[4 * i + 3]), [255, 255, 0, 0, 0]);
});

test('palettes: .hex parsing and tiling', () => {
    const { colors, palette } = parseHex('#1a1c2c\n5D275D\nnope\n  b13e53  \n');
    assert.deepEqual(colors, ['1a1c2c', '5d275d', 'b13e53']);
    assert.deepEqual([...palette.subarray(4, 8)], [0x1a, 0x1c, 0x2c, 255]);
    assert.deepEqual([...palette.subarray(16, 20)], [0x1a, 0x1c, 0x2c, 255]);   // entry 4 wraps to colour 1
});

test('editor: brush, mirror, box, undo/redo restore exact bytes', () => {
    const g = makeGrid(8, 8, 8);
    const h = new History();
    const snapshot = () => g.data.slice();
    const empty = snapshot();

    h.begin();
    brush(g, [1, 1, 1], 1, 'add', 3, { history: h, mirror: { x: true, z: true } });
    h.commit();
    assert.equal(countVoxels(g), 4);                                   // the voxel and its X, Z, XZ mirrors
    assert.equal(g.data[index(g, 6, 1, 6)], 3);
    const afterAdd = snapshot();

    h.begin();
    brush(g, [1, 1, 1], 2, 'paint', 5, { history: h });                // paints existing voxels only
    h.commit();
    assert.equal(g.data[index(g, 1, 1, 1)], 5);
    assert.equal(countVoxels(g), 4);

    h.begin();
    boxEdit(g, [0, 0, 0], [7, 0, 7], 'fill', 2, { history: h });           // a floor slab
    h.commit();
    assert.equal(countVoxels(g), 64 + 4);
    h.begin();
    boxEdit(g, [0, 0, 0], [3, 7, 7], 'erase', 0, { history: h });
    h.commit();
    const afterErase = snapshot();

    h.undo(g); h.undo(g);
    assert.equal(countVoxels(g), 4);
    h.undo(g); h.undo(g);
    assert.deepEqual(g.data, empty);
    h.redo(g);
    assert.deepEqual(g.data, afterAdd);
    h.redo(g); h.redo(g); h.redo(g);
    assert.deepEqual(g.data, afterErase);
    assert.equal(h.redo(g).size, 0);                                   // nothing left to redo
});

test('flood fill recolours one connected same-colour region', () => {
    const g = makeGrid(3, 1, 1);
    g.data.set([1, 1, 2]);
    floodFill(g, 0, 0, 0, 3);
    assert.deepEqual([...g.data], [3, 3, 2]);
    assert.equal(countVoxels(g), 3);
});

for (const [name, fn] of tests) {
    await fn();
    console.log(`ok  ${name}`);
}
console.log(`\n${tests.length} passed`);

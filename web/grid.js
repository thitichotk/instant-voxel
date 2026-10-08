/**
 * grid.js — the voxel grid every stage shares.
 *
 * Grid = { sx, sy, sz, data: Uint8Array(sx*sy*sz), palette: Uint8Array(256*4) }
 *   Y-up, like glTF, three.js and Minecraft. Voxel (x, y, z) is
 *   data[x + sx * (y + sy * z)]; 0 = empty, i = palette entry i (RGBA at 4i).
 */

export const MAX_DIM = 512;

export function makeGrid(sx, sy, sz, palette = new Uint8Array(256 * 4)) {
    return { sx, sy, sz, data: new Uint8Array(sx * sy * sz), palette };
}

export const index = (g, x, y, z) => x + g.sx * (y + g.sy * z);

export const inside = (g, x, y, z) =>
    x >= 0 && y >= 0 && z >= 0 && x < g.sx && y < g.sy && z < g.sz;

export const get = (g, x, y, z) => (inside(g, x, y, z) ? g.data[index(g, x, y, z)] : 0);

/** One pass over the grid: { count, used } — used[i] = 1 when palette entry i appears. */
export function summarize(g) {
    const used = new Uint8Array(256), data = g.data;
    let count = 0;
    for (let i = 0; i < data.length; i++) {
        const c = data[i];
        if (c) { count++; used[c] = 1; }
    }
    return { count, used };
}

export const countVoxels = (g) => summarize(g).count;

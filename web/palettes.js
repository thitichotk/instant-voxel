/**
 * palettes.js — palette presets and .hex parsing.
 * A palette is 256 × RGBA bytes; entry 0 is the empty voxel and stays unused.
 */

import { summarize } from './grid.js';
import { MC_BLOCKS } from './mc-blocks.js';

const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

/** sRGB bytes → Oklab [L, a, b] (Björn Ottosson), for perceptual colour distance. */
export function oklab(r, g, b) {
    [r, g, b] = [r, g, b].map((c) => toLinear(c / 255));
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    return [
        0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
        1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
        0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
    ];
}

/** One entry per Minecraft block (mc-blocks.js); the rest stay empty (alpha 0, never chosen). */
export function minecraftPalette() {
    const p = new Uint8Array(256 * 4);
    MC_BLOCKS.forEach((b, i) => p.set([...b.rgb, 255], 4 * (i + 1)));
    return p;
}

/** 6×6×6 RGB cube (entries 1–216) plus a 39-step grey ramp (217–255). */
export function defaultCube() {
    const p = new Uint8Array(256 * 4);
    let i = 1;
    for (let r = 0; r < 6; r++)
        for (let g = 0; g < 6; g++)
            for (let b = 0; b < 6; b++) p.set([r * 51, g * 51, b * 51, 255], 4 * i++);
    for (let k = 0; i < 256; k++) {
        const v = Math.round((k * 255) / 38);
        p.set([v, v, v, 255], 4 * i++);
    }
    return p;
}

/**
 * Parse a .hex palette file (one hex colour per line, optional '#').
 * The colours are tiled across entries 1–255.
 * Returns { colors: string[] (lower-case hex), palette: Uint8Array }.
 */
export function parseHex(text) {
    const colors = text.split('\n')
        .map((line) => line.trim().replace(/^#/, '').toLowerCase())
        .filter((hex) => /^[0-9a-f]{6}$/.test(hex))
        .slice(0, 255);   // MagicaVoxel reserves index 0, so 255 colours max

    if (colors.length === 0) throw new Error('No valid hex colors found in file.');

    const palette = new Uint8Array(256 * 4);
    for (let i = 1; i < 256; i++) {
        const hex = colors[(i - 1) % colors.length];
        palette.set([0, 2, 4].map((o) => parseInt(hex.slice(o, o + 2), 16)).concat(255), 4 * i);
    }
    return { colors, palette };
}

/** The palette entries a grid uses: [{ index, hex: '#rrggbb' }]. Pass `used` from summarize() to skip the scan. */
export function usedColors(grid, used = summarize(grid).used) {
    const out = [];
    for (let i = 1; i < 256; i++) {
        if (!used[i]) continue;
        const [r, g, b] = grid.palette.subarray(4 * i, 4 * i + 3);
        out.push({ index: i, hex: '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('') });
    }
    return out;
}

/**
 * export.js — Grid → mesh files, built from mesher.js quads.
 *
 * Size: `voxelMM` millimetres per voxel. glTF and OBJ are written in metres
 * (their convention), STL in millimetres (what slicers assume). Models sit on
 * the floor, centred on the vertical axis. glTF and OBJ are Y-up; STL is
 * rotated to Z-up, the build direction slicers expect.
 *
 * three.js is imported on demand, so .obj export (pure JS) also runs in Node.
 */

import { meshGrid } from './mesher.js';

/** .obj text: one vertex per quad corner with its sRGB colour (`v x y z r g b`), triangle faces. */
export function toOBJ(grid, { voxelMM = 10 } = {}) {
    const s = voxelMM / 1000, ox = grid.sx / 2, oz = grid.sz / 2;
    const f = (v) => +v.toFixed(5);
    const lines = ['# VOXY voxel mesh', 'o voxels'];
    const faces = [];
    let base = 1;
    for (const c of meshGrid(grid).values()) {
        const p = c.positions;
        for (let k = 0; k < 4 * c.quads; k++) {
            const e = 4 * c.faceColors[k >> 2];
            const rgb = [0, 1, 2].map((i) => +(grid.palette[e + i] / 255).toFixed(4));
            lines.push(`v ${f((p[3 * k] - ox) * s)} ${f(p[3 * k + 1] * s)} ${f((p[3 * k + 2] - oz) * s)} ${rgb.join(' ')}`);
        }
        for (let t = 0; t < c.indices.length; t += 3)
            faces.push(`f ${c.indices[t] + base} ${c.indices[t + 1] + base} ${c.indices[t + 2] + base}`);
        base += 4 * c.quads;
    }
    return lines.concat(faces).join('\n') + '\n';
}

// three.js group of chunk meshes in voxel units (scale/place it afterwards).
async function chunkGroup(grid, { greedy, material }) {
    const THREE = await import('three');
    const root = new THREE.Group();
    for (const [key, c] of meshGrid(grid, { greedy })) {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(c.positions, 3));
        geo.setAttribute('normal', new THREE.BufferAttribute(c.normals, 3));
        if (material) {
            // UVs at the centre of each quad's palette texel.
            const uv = new Float32Array(8 * c.quads);
            for (let q = 0; q < c.quads; q++)
                for (let k = 0; k < 4; k++) uv.set([(c.faceColors[q] + 0.5) / 256, 0.5], 8 * q + 2 * k);
            geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
        }
        geo.setIndex(new THREE.BufferAttribute(c.indices, 1));
        const mesh = new THREE.Mesh(geo, material);
        mesh.name = `chunk ${key}`;
        root.add(mesh);
    }
    return { THREE, root };
}

/** .glb bytes: one mesh per 32³ chunk (keeps each under engine limits such as Roblox's). */
export async function toGLB(grid, { voxelMM = 10, name = 'voxels' } = {}) {
    const THREE = await import('three');
    const { GLTFExporter } = await import('three/addons/exporters/GLTFExporter.js');
    const texture = new THREE.DataTexture(grid.palette.slice(), 256, 1);   // palette as a 256×1 image
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.magFilter = texture.minFilter = THREE.NearestFilter;
    texture.needsUpdate = true;
    const material = new THREE.MeshStandardMaterial({ map: texture, roughness: 1, metalness: 0 });
    const { root } = await chunkGroup(grid, { greedy: true, material });
    const s = voxelMM / 1000;
    root.name = name;
    root.scale.setScalar(s);
    root.position.set((-grid.sx / 2) * s, 0, (-grid.sz / 2) * s);
    return new Uint8Array(await new GLTFExporter().parseAsync(root, { binary: true }));
}

/** Binary .stl bytes: one quad per exposed face (no greedy merging, so no T-junctions). */
export async function toSTL(grid, { voxelMM = 10 } = {}) {
    const { STLExporter } = await import('three/addons/exporters/STLExporter.js');
    const { root } = await chunkGroup(grid, { greedy: false });
    root.scale.setScalar(voxelMM);
    root.rotation.x = Math.PI / 2;   // Y-up → Z-up: (x, y, z) → (x, −z, y)
    root.position.set((-grid.sx / 2) * voxelMM, (grid.sz / 2) * voxelMM, 0);
    root.updateMatrixWorld(true);
    const view = new STLExporter().parse(root, { binary: true });
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
}

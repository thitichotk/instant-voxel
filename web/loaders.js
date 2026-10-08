/**
 * loaders.js — model files → three.js scene, and scene → the flat triangle
 * mesh the voxel kernel consumes (see src/voxelizer.cpp for the format).
 *
 * Format loaders come from three.js addons and are imported on first use.
 * Multi-file models (.gltf + .bin, .obj + .mtl, textures) resolve their
 * sibling files by name from the files the user picked.
 */

import * as THREE from 'three';

export const MODEL_EXTS = ['glb', 'gltf', 'obj', 'fbx', 'stl', 'ply', '3mf', 'dae'];
export const ext = (name) => name.split('.').pop().toLowerCase();

const MAX_TEXTURE = 2048;   // texture pixels handed to the kernel, per side
const addon = (path) => import(`three/addons/${path}`);

// Resolves once every resource a loader started (textures, .bin, …) has settled.
function trackLoads(manager) {
    let active = 0, idle = null;
    const start = manager.itemStart.bind(manager), end = manager.itemEnd.bind(manager);
    manager.itemStart = (url) => { active++; start(url); };
    manager.itemEnd = (url) => { end(url); if (--active === 0) idle?.(); };
    return () => new Promise((resolve) => { if (active === 0) resolve(); else idle = resolve; });
}

async function parse(kind, main, files, manager) {
    switch (kind) {
        case 'glb': case 'gltf': {
            const [{ GLTFLoader }, { DRACOLoader }, { MeshoptDecoder }] = await Promise.all([
                addon('loaders/GLTFLoader.js'), addon('loaders/DRACOLoader.js'), addon('libs/meshopt_decoder.module.js'),
            ]);
            const draco = new DRACOLoader().setDecoderPath(new URL('libs/draco/gltf/', import.meta.resolve('three/addons/')).href);
            try {
                const loader = new GLTFLoader(manager).setDRACOLoader(draco).setMeshoptDecoder(MeshoptDecoder);
                return (await loader.parseAsync(await main.arrayBuffer(), '')).scene;
            } finally { draco.dispose(); }
        }
        case 'obj': {
            const [{ OBJLoader }, { MTLLoader }] = await Promise.all([addon('loaders/OBJLoader.js'), addon('loaders/MTLLoader.js')]);
            const loader = new OBJLoader(manager);
            const mtl = files.find((f) => ext(f.name) === 'mtl');
            if (mtl) {
                const materials = new MTLLoader(manager).parse(await mtl.text(), '');
                materials.preload();
                loader.setMaterials(materials);
            }
            return loader.parse(await main.text());
        }
        case 'fbx': {
            const { FBXLoader } = await addon('loaders/FBXLoader.js');
            return new FBXLoader(manager).parse(await main.arrayBuffer(), '');
        }
        case 'stl': {
            const { STLLoader } = await addon('loaders/STLLoader.js');
            const geo = new STLLoader(manager).parse(await main.arrayBuffer());
            return new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: !!geo.hasColors }));
        }
        case 'ply': {
            const { PLYLoader } = await addon('loaders/PLYLoader.js');
            const geo = new PLYLoader(manager).parse(await main.arrayBuffer());
            return new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: !!geo.attributes.color }));
        }
        case '3mf': {
            const { ThreeMFLoader } = await addon('loaders/3MFLoader.js');
            return new ThreeMFLoader(manager).parse(await main.arrayBuffer());
        }
        case 'dae': {
            const { ColladaLoader } = await addon('loaders/ColladaLoader.js');
            return new ColladaLoader(manager).parse(await main.text(), '').scene;
        }
    }
}

/** Picked files → THREE.Object3D (textures loaded). */
export async function loadModel(files) {
    const main = files.find((f) => MODEL_EXTS.includes(ext(f.name)));
    if (!main) throw new Error(`No model file found (${MODEL_EXTS.join(', ')}).`);

    const byName = new Map(files.map((f) => [f.name.toLowerCase(), f]));
    const urls = [];
    const manager = new THREE.LoadingManager();
    manager.setURLModifier((url) => {
        const f = byName.get(decodeURIComponent(url.split(/[\\/]/).pop().split('?')[0]).toLowerCase());
        if (!f) return url;
        urls.push(URL.createObjectURL(f));
        return urls.at(-1);
    });
    const settled = trackLoads(manager);
    try {
        const root = await parse(ext(main.name), main, files, manager);
        await settled();
        return root;
    } finally {
        urls.forEach((u) => URL.revokeObjectURL(u));
    }
}

// Texture → { width, height, data: sRGB RGBA bytes }, ≤ MAX_TEXTURE per side.
function pixelsOf(texture, cache) {
    const img = texture.image;
    if (!img || !img.width || !img.height) return null;
    if (cache.has(img)) return cache.get(img);
    let out = null;
    if (img.data) {   // DataTexture
        if (img.data.BYTES_PER_ELEMENT === 1 && img.data.length === img.width * img.height * 4)
            out = { width: img.width, height: img.height, data: new Uint8Array(img.data) };
    } else {
        const s = Math.min(1, MAX_TEXTURE / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * s)), h = Math.max(1, Math.round(img.height * s));
        const ctx = new OffscreenCanvas(w, h).getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, 0, 0, w, h);
        out = { width: w, height: h, data: new Uint8Array(ctx.getImageData(0, 0, w, h).data.buffer) };
    }
    cache.set(img, out);
    return out;
}

/**
 * Scene → TriMesh in world space: { positions, indices, uvs?, colors?,
 * triMaterial, materials, textures }. Skinning and morphs are applied
 * (Mesh.getVertexPosition). Each mesh's first map transform and flipY are
 * baked into its UVs.
 * ponytail: one UV transform per mesh; per-material transforms if a model needs them.
 */
export function flatten(root, textureCache = new Map()) {
    root.updateMatrixWorld(true);
    const parts = [];
    root.traverse((o) => { if (o.isMesh && o.visible && o.geometry?.attributes?.position) parts.push(o); });

    const materials = [], textures = [], matIds = new Map(), texIds = new Map();
    const materialId = (m) => {
        if (!matIds.has(m)) {
            let tex = -1;
            if (m.map) {
                if (!texIds.has(m.map)) {
                    const px = pixelsOf(m.map, textureCache);
                    texIds.set(m.map, px ? textures.push(px) - 1 : -1);
                }
                tex = texIds.get(m.map);
            }
            const c = m.color ?? new THREE.Color(1, 1, 1);
            materials.push(c.r, c.g, c.b, m.opacity ?? 1, m.alphaTest || 0, tex);
            matIds.set(m, matIds.size);
        }
        return matIds.get(m);
    };
    const matsOf = (o) => (Array.isArray(o.material) ? o.material : [o.material]);

    let nv = 0, nt = 0, needUV = false, needColor = false;
    for (const o of parts) {
        const g = o.geometry, copies = o.isInstancedMesh ? o.count : 1;
        nv += g.attributes.position.count * copies;
        nt += Math.floor((g.index ? g.index.count : g.attributes.position.count) / 3) * copies;
        for (const m of matsOf(o)) {
            needUV ||= !!(m.map && g.attributes.uv);
            needColor ||= !!(m.vertexColors && g.attributes.color);
        }
    }

    const positions = new Float32Array(nv * 3), indices = new Uint32Array(nt * 3), triMaterial = new Uint16Array(nt);
    const uvs = needUV ? new Float32Array(nv * 2) : null;
    const colors = needColor ? new Float32Array(nv * 4).fill(1) : null;
    const v = new THREE.Vector3(), uv = new THREE.Vector2(), world = new THREE.Matrix4(), inst = new THREE.Matrix4();
    let vBase = 0, tBase = 0;

    for (const o of parts) {
        const g = o.geometry, mats = matsOf(o);
        const pos = g.attributes.position, uvAttr = g.attributes.uv, colAttr = g.attributes.color;
        const map = mats.find((m) => m.map)?.map;
        if (map?.matrixAutoUpdate) map.updateMatrix();
        const useColor = colors && colAttr && mats.some((m) => m.vertexColors);
        const triCount = Math.floor((g.index ? g.index.count : pos.count) / 3);
        const groups = Array.isArray(o.material) && g.groups.length ? g.groups : [{ start: 0, count: Infinity, materialIndex: 0 }];

        for (let k = 0, copies = o.isInstancedMesh ? o.count : 1; k < copies; k++) {
            world.copy(o.matrixWorld);
            if (o.isInstancedMesh) world.multiply((o.getMatrixAt(k, inst), inst));
            for (let i = 0, j = vBase; i < pos.count; i++, j++) {
                o.getVertexPosition(i, v).applyMatrix4(world);
                positions[3 * j] = v.x; positions[3 * j + 1] = v.y; positions[3 * j + 2] = v.z;
                if (uvs && uvAttr) {
                    uv.fromBufferAttribute(uvAttr, i);
                    if (map) { uv.applyMatrix3(map.matrix); if (map.flipY) uv.y = 1 - uv.y; }
                    uvs[2 * j] = uv.x; uvs[2 * j + 1] = uv.y;
                }
                if (useColor) {
                    colors[4 * j] = colAttr.getX(i); colors[4 * j + 1] = colAttr.getY(i); colors[4 * j + 2] = colAttr.getZ(i);
                    colors[4 * j + 3] = colAttr.itemSize > 3 ? colAttr.getW(i) : 1;
                }
            }
            for (const grp of groups) {
                const mat = materialId(mats[grp.materialIndex] ?? mats[0]);
                const first = Math.floor(grp.start / 3), last = Math.min(triCount, first + Math.floor(Math.min(grp.count, 3 * triCount) / 3));
                for (let t = first; t < last; t++) {
                    for (let c = 0; c < 3; c++)
                        indices[3 * tBase + 3 * (t - first) + c] = vBase + (g.index ? g.index.getX(3 * t + c) : 3 * t + c);
                    triMaterial[tBase + t - first] = mat;
                }
                tBase += last - first;
            }
            vBase += pos.count;
        }
    }

    return {
        positions, indices: indices.subarray(0, 3 * tBase), triMaterial: triMaterial.subarray(0, tBase),
        uvs: uvs ?? undefined, colors: colors ?? undefined, materials: new Float32Array(materials), textures,
    };
}

/** ArrayBuffers of a TriMesh that can be transferred (textures stay cached). */
export const meshTransfer = (m) => [m.positions, m.indices, m.triMaterial, m.uvs, m.colors, m.materials]
    .filter(Boolean).map((a) => a.buffer).filter((b, i, all) => all.indexOf(b) === i);

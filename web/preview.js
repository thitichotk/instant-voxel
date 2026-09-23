/**
 * preview.js — Three.js voxel renderer
 *
 * Key design decisions:
 *  1. ONE THREE.InstancedMesh per scene.  On every update only the matrix /
 *     colour buffers are patched in-place; the mesh geometry and the scene
 *     graph are never torn down.  This avoids GC pressure and GPU upload
 *     overhead between slider ticks.
 *
 *  2. The VOX binary is parsed entirely in JS (no extra dependency).
 *
 *  3. OrbitControls are loaded from the Three.js addons CDN path so the
 *     HTML only needs one <script type="importmap"> entry.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// ── VOX binary parser ─────────────────────────────────────────────────────────

/**
 * parseVox(buffer)
 *
 * Returns { size, voxels, palette } where:
 *   size    = { x, y, z }
 *   voxels  = Uint8Array interleaved as [x,y,z,colorIdx, …]  (4 bytes per voxel)
 *   palette = Uint8Array, 256 × 4 bytes (RGBA), index 0 is unused
 */
function parseVox(buffer) {
    const dv   = new DataView(buffer);
    const u32  = (n) => dv.getUint32(n, true);
    const id4  = (n) => String.fromCharCode(
        dv.getUint8(n), dv.getUint8(n+1), dv.getUint8(n+2), dv.getUint8(n+3));

    // ── magic + version
    if (id4(0) !== 'VOX ') throw new Error('Not a valid .vox file (bad magic).');
    // version = u32(4)  — accepted but not checked

    // encodeVox (voxelizer.cpp) always writes SIZE, XYZI and RGBA chunks.
    const result = {
        size:    { x: 1, y: 1, z: 1 },
        voxels:  null,
        palette: null,
    };

    // ── recursive chunk walker ──────────────────────────────────────────────
    function walkChunks(offset, end) {
        while (offset + 12 <= end) {
            const chunkId      = id4(offset);
            const contentBytes = u32(offset + 4);
            const childBytes   = u32(offset + 8);
            const dataStart    = offset + 12;
            const dataEnd      = dataStart + contentBytes;
            const chunkEnd     = dataEnd + childBytes;

            switch (chunkId) {
                case 'SIZE':
                    result.size.x = u32(dataStart);
                    result.size.y = u32(dataStart + 4);
                    result.size.z = u32(dataStart + 8);
                    break;

                case 'XYZI': {
                    const n       = u32(dataStart);
                    result.voxels = new Uint8Array(buffer, dataStart + 4, n * 4);
                    break;
                }

                case 'RGBA':
                    result.palette = new Uint8Array(buffer, dataStart, 256 * 4);
                    break;

                case 'MAIN':
                    // MAIN has no content, only children
                    walkChunks(dataEnd, dataEnd + childBytes);
                    break;

                default:
                    // Unknown chunk — skip silently
                    break;
            }
            offset = chunkEnd;
        }
    }

    walkChunks(8, buffer.byteLength);
    return result;
}

// ── Three.js scene state ──────────────────────────────────────────────────────

let renderer, scene, camera, controls;
let instMesh  = null;     // current InstancedMesh
let currentVoxels = null;
let currentPalette = null;
let paintMode = false;
let paintColorIndex = 1; // 1-based palette index

const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();

// Reusable dummy object to compute matrices
const _dummy  = new THREE.Object3D();
const _color  = new THREE.Color();
const _boxGeo = new THREE.BoxGeometry();   // 1×1×1: one voxel per world unit

let isLinesEnabled = false;

function createEdgeTexture() {
    const size = 64;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');

    // Fill white (this part takes the full instanceColor)
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, size, size);

    // Draw dark border edges
    ctx.lineWidth = 4;
    ctx.strokeStyle = '#222222';
    ctx.strokeRect(0, 0, size, size);

    const texture = new THREE.CanvasTexture(canvas);
    texture.magFilter = THREE.NearestFilter;
    texture.minFilter = THREE.NearestFilter;
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
}

const edgeTexture = createEdgeTexture();

export function setBlockLines(enabled) {
    isLinesEnabled = enabled;
    if (instMesh) {
        instMesh.material.map = isLinesEnabled ? edgeTexture : null;
        instMesh.material.needsUpdate = true;
    }
}

// ── Helper: Create text sprite ──────────────────────────────────────────────
function createTextSprite(text) {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 64;
    const ctx = canvas.getContext('2d');

    // Minimal text styling, matching the subtle grid helpers
    ctx.font = '600 28px "Plus Jakarta Sans", sans-serif';
    ctx.fillStyle = '#8a9186'; // Similar to grid lines but slightly more legible
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    
    // Optional: add a pure white slight glow/stroke behind text for readability against lines
    ctx.shadowColor = '#f9f9f9';
    ctx.shadowBlur = 4;
    ctx.lineWidth = 4;
    ctx.strokeStyle = '#f9f9f9';
    ctx.strokeText(text, canvas.width / 2, canvas.height / 2 + 2);
    
    ctx.shadowBlur = 0;
    ctx.fillText(text, canvas.width / 2, canvas.height / 2 + 2);

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    const material = new THREE.SpriteMaterial({
        map: texture, 
        depthTest: false,
        transparent: true,
        opacity: 0.8
    });
    const sprite = new THREE.Sprite(material);
    sprite.scale.set(24, 6, 1);
    
    // Make it render on top
    sprite.renderOrder = 999;
    return sprite;
}

// ── Initialise scene (called once) ───────────────────────────────────────────

export async function initPreview(container) {
    // ── renderer
    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping        = THREE.ACESFilmicToneMapping;
    container.appendChild(renderer.domElement);

    // ── scene
    scene = new THREE.Scene();
    scene.background = new THREE.Color('#f5f5f7');

    // ── camera
    camera = new THREE.PerspectiveCamera(
        45,
        container.clientWidth / container.clientHeight,
        0.1,
        10000   // large far plane — prevents clip-out on zoom-out
    );
    camera.position.set(80, 60, 80);

    // ── lighting
    // Soft Hemisphere ambient + tuned Directional light for crisp, Goxel-style shadows
    const hemiLight = new THREE.HemisphereLight(0xffffff, 0x888888, 0.4);
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.4);
    
    const sun = new THREE.DirectionalLight(0xffffff, 1.0);
    sun.position.set(100, 150, 50);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    
    // Shadow frustum tuned for voxel scales
    const d = 120;
    sun.shadow.camera.left = -d;
    sun.shadow.camera.right = d;
    sun.shadow.camera.top = d;
    sun.shadow.camera.bottom = -d;
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 400;
    sun.shadow.bias = -0.001; // Prevent shadow acne on voxel surfaces

    scene.add(hemiLight, ambientLight, sun);

    // ── orbit controls
    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;

    // ── paint interactions
    let isDragging = false;
    let hasMoved = false;

    container.addEventListener('pointerdown', (e) => {
        if (!paintMode || !instMesh) return;
        isDragging = true;
        hasMoved = false;
    });

    // Any movement while pressed is a camera drag, not a paint click.
    container.addEventListener('pointermove', () => {
        if (isDragging) hasMoved = true;
    });

    container.addEventListener('pointerup', (e) => {
        if (!paintMode || !instMesh || !isDragging) return;
        isDragging = false;
        
        // If the user was just dragging the camera, don't paint
        if (hasMoved) return;

        const rect = container.getBoundingClientRect();
        mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

        raycaster.setFromCamera(mouse, camera);
        const intersects = raycaster.intersectObject(instMesh);

        if (intersects.length > 0) {
            const startInstanceId = intersects[0].instanceId;
            if (startInstanceId !== undefined && currentVoxels) {
                const targetColorIndex = currentVoxels[startInstanceId * 4 + 3];
                // If the clicked voxel is already the active color, do nothing
                if (targetColorIndex === paintColorIndex) return;

                // 1. Build a spatial map for O(1) adjacency lookup
                const numVoxels = currentVoxels.length / 4;
                const voxelMap = new Map();
                for (let i = 0; i < numVoxels; i++) {
                    const x = currentVoxels[i * 4 + 0];
                    const y = currentVoxels[i * 4 + 1];
                    const z = currentVoxels[i * 4 + 2];
                    voxelMap.set((x << 16) | (y << 8) | z, i);
                }

                const dirs = [
                    [1,0,0], [-1,0,0],
                    [0,1,0], [0,-1,0],
                    [0,0,1], [0,0,-1]
                ];

                const pi = Math.max(0, (paintColorIndex - 1)) * 4;
                _color.setRGB(
                    currentPalette[pi]   / 255,
                    currentPalette[pi+1] / 255,
                    currentPalette[pi+2] / 255,
                    THREE.SRGBColorSpace
                );

                // 2. Flood fill (BFS) connected voxels of the target color.
                //    Voxels are painted as they are queued; the paint colour
                //    differs from the target, so the colour check alone keeps
                //    a voxel from being queued twice.
                const queue = [];
                const paint = (id) => {
                    currentVoxels[id * 4 + 3] = paintColorIndex;
                    instMesh.setColorAt(id, _color);
                    queue.push(id);
                };
                paint(startInstanceId);

                while (queue.length > 0) {
                    const currId = queue.shift();

                    const cx = currentVoxels[currId * 4 + 0];
                    const cy = currentVoxels[currId * 4 + 1];
                    const cz = currentVoxels[currId * 4 + 2];

                    for (const [dx, dy, dz] of dirs) {
                        const nx = cx + dx;
                        const ny = cy + dy;
                        const nz = cz + dz;
                        
                        // Bounds check
                        if (nx >= 0 && nx <= 255 && ny >= 0 && ny <= 255 && nz >= 0 && nz <= 255) {
                            const key = (nx << 16) | (ny << 8) | nz;
                            const neighborId = voxelMap.get(key);

                            if (neighborId !== undefined && currentVoxels[neighborId * 4 + 3] === targetColorIndex) {
                                paint(neighborId);
                            }
                        }
                    }
                }

                instMesh.instanceColor.needsUpdate = true;
            }
        }
    });

    // ── grid helper (subtle floor reference — light mode)
    const grid = new THREE.GridHelper(200, 40, 0xbbbbbb, 0xd8d8d8);
    scene.add(grid);

    // ── invisible shadow-catching floor plane
    const floorGeo = new THREE.PlaneGeometry(500, 500);
    const floorMat = new THREE.ShadowMaterial({ opacity: 0.15 });
    const floor = new THREE.Mesh(floorGeo, floorMat);
    floor.rotation.x = -Math.PI / 2;
    // slightly below the 0 level so it doesn't z-fight with grid or lowest voxels
    floor.position.y = -0.01; 
    floor.receiveShadow = true;
    scene.add(floor);

    // Add Axes Helper and Labels
    scene.add(new THREE.AxesHelper(100)); // Shows Origin

    for (const [text, x, z] of [['X', 110, 0], ['Z', 0, 110], ['-X', -110, 0], ['-Z', 0, -110]]) {
        const label = createTextSprite(text);
        label.position.set(x, 0, z);
        scene.add(label);
    }

    // ── resize observer
    const ro = new ResizeObserver(() => {
        const w = container.clientWidth, h = container.clientHeight;
        renderer.setSize(w, h);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
    });
    ro.observe(container);

    // ── render loop
    renderer.setAnimationLoop(() => {
        controls.update();
        renderer.render(scene, camera);
    });
}

// ── Update InstancedMesh with new VOX data ───────────────────────────────────

/**
 * updatePreview(voxBuffer)
 *
 * Called from main.js whenever the worker returns a new VOX ArrayBuffer.
 * Parses the binary, then:
 *   • If the voxel count grew since the last update, rebuild the mesh (and
 *     reframe the camera).
 *   • Otherwise only patch the existing InstancedMesh buffers.
 */
export async function updatePreview(voxBuffer) {
    // Parse the original buffer so that we can directly modify it when painting
    const { size, voxels, palette } = parseVox(voxBuffer);

    // Keep reference to current voxels and palette for painting
    currentVoxels = voxels;
    currentPalette = palette;

    if (!voxels || voxels.length === 0) {
        // Nothing to render — hide existing mesh
        if (instMesh) instMesh.visible = false;
        return;
    }

    const count = voxels.length / 4;   // 4 bytes per voxel entry

    // ── (Re)create InstancedMesh when the count outgrows the last update's ────
    //  (instMesh.count never exceeds the capacity, so that's the only check.)
    const needRebuild = !instMesh || count > instMesh.count;

    if (needRebuild) {
        if (instMesh) {
            scene.remove(instMesh);
            instMesh.dispose();
        }

        // Use an un-shiny standard material for solid, clay-like voxel appearance
        const mat = new THREE.MeshStandardMaterial({
            map: isLinesEnabled ? edgeTexture : null,
            color: 0xffffff,
            roughness: 0.9,
            metalness: 0.0
        });

        instMesh = new THREE.InstancedMesh(_boxGeo, mat, count);
        instMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        // Enable soft self-shadowing (acne prevented by sun bias)
        instMesh.castShadow    = true;
        instMesh.receiveShadow = true;
        scene.add(instMesh);
    }

    // ── Half-extents used to centre the mesh at world origin ─────────────────
    const cx = size.x / 2;
    const cy = size.z / 2;   // VOX Z → Three world Y
    const cz = size.y / 2;

    // ── Batch-write matrices + colours ───────────────────────────────────────
    for (let i = 0; i < count; i++) {
        const vx  = voxels[i*4 + 0];
        const vy  = voxels[i*4 + 1];
        const vz  = voxels[i*4 + 2];
        const ci  = voxels[i*4 + 3];   // 1-based palette index

        // VOX axes: X right, Y forward, Z up → Three.js Y up convention.
        // Raw positions only — the mesh.position offset centres everything.
        _dummy.position.set(vx, vz, vy);
        _dummy.updateMatrix();
        instMesh.setMatrixAt(i, _dummy.matrix);

        // Palette lookup (index 0 = unused, so shift by 1 in VOX spec)
        // convertSRGBToLinear: palette bytes are sRGB; Three.js works in
        // linear space internally, so convert to avoid crushed/black colours.
        const pi = Math.max(0, (ci - 1)) * 4;
        _color.setRGB(
            palette[pi]   / 255,
            palette[pi+1] / 255,
            palette[pi+2] / 255,
            THREE.SRGBColorSpace
        );
        instMesh.setColorAt(i, _color);
    }

    // Centre the mesh on X/Z but keep the bottom at Y = 0
    instMesh.position.set(-cx, 0, -cz);

    // ── Tell Three.js the buffers changed ─────────────────────────────────────
    //  IMPORTANT: only the first `count` entries are valid; set .count so the
    //  renderer skips drawing unset tail instances from a previous larger mesh.
    instMesh.count                    = count;
    instMesh.instanceMatrix.needsUpdate = true;
    instMesh.instanceColor.needsUpdate = true;   // setColorAt above created it
    instMesh.visible                  = true;
    instMesh.computeBoundingSphere();

    // ── Smoothly reframe the camera on first load ─────────────────────────────
    if (needRebuild) {
        const r = instMesh.boundingSphere?.radius ?? 50;
        // Model bottom is at 0, target the Y midpoint (cy)
        controls.target.set(0, cy, 0);
        const dist = r * 2.5;
        camera.position.set(dist, (dist * 0.7) + cy, dist);
        controls.update();
    }

    // Return metadata so the caller can update UI stats.
    return { voxCount: count, sizeX: size.x, sizeY: size.y, sizeZ: size.z };
}

export function setPaintMode(active) {
    paintMode = active;
    if (renderer && renderer.domElement) {
        renderer.domElement.style.cursor = active ? 'crosshair' : 'default';
    }
}

export function setPaintColor(index) {
    paintColorIndex = index;
}

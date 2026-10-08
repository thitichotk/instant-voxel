/**
 * preview.js — three.js viewport.
 *
 * Draws a Grid (see grid.js) as chunked greedy meshes from mesher.js, in grid
 * units: the model group is centred on X/Z with its bottom at Y = 0. Picks
 * voxels from ray hits, and can overlay the source model as a translucent
 * "ghost" to check the voxels line up with it. Interface colours come from the
 * design tokens (tokens.css); lighting is hemisphere + sun with no tone mapping,
 * so top faces show the palette colours that get exported.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { meshChunk, linearPalette } from './mesher.js';

let renderer, scene, camera, controls, sun, helpers;
let grid = null;
let ghost = null;
let toolActive = false;
const model = new THREE.Group();   // grid space; chunk meshes and the ghost live here
const chunks = new Map();          // chunk key → THREE.Mesh
const raycaster = new THREE.Raycaster();
const clipPlane = new THREE.Plane(new THREE.Vector3(0, -1, 0), 0);
const view = { lines: false, ghost: false, clip: 1, grid: true, spin: false };
const token = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function createEdgeTexture() {
    const size = 64;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');

    // White (takes the full vertex colour) with dark borders.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, size, size);
    ctx.lineWidth = 4;
    ctx.strokeStyle = token('--fg');
    ctx.strokeRect(0, 0, size, size);

    const texture = new THREE.CanvasTexture(canvas);
    texture.magFilter = THREE.NearestFilter;
    texture.minFilter = THREE.NearestFilter;
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;   // quad UVs are in voxel units
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
}

const voxelMaterial = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0 });
// X-ray overlay: drawn on top of the voxels so the source outline stays visible.
const ghostMaterial = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.22, depthTest: false, depthWrite: false });
let edgeTexture;

// ── Helper: Create text sprite ──────────────────────────────────────────────
function createTextSprite(text) {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 64;
    const ctx = canvas.getContext('2d');

    // Muted text with a halo in the viewport colour, so it reads over the grid lines.
    ctx.font = '600 28px "Plus Jakarta Sans", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 6;
    ctx.strokeStyle = token('--surface-low');
    ctx.strokeText(text, canvas.width / 2, canvas.height / 2 + 2);
    ctx.fillStyle = token('--muted');
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

export function initPreview(container) {
    // ── renderer (transparent: the viewport's own surface shows through)
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(container.clientWidth, container.clientHeight, false);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.prepend(renderer.domElement);

    // ── scene
    scene = new THREE.Scene();
    scene.add(model);
    edgeTexture = createEdgeTexture();
    ghostMaterial.color.set(token('--accent'));
    boxLines.material.color.set(token('--accent'));

    // ── camera
    camera = new THREE.PerspectiveCamera(
        45,
        container.clientWidth / container.clientHeight,
        0.1,
        10000   // large far plane — prevents clip-out on zoom-out
    );
    camera.position.set(80, 60, 80);

    // ── lighting: hemisphere + one sun, as in the design system's viewport
    const hemiLight = new THREE.HemisphereLight(0xffffff, token('--surface-highest'), 1.7);

    sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.bias = -0.001; // Prevent shadow acne on voxel surfaces
    fitLight(1);

    scene.add(hemiLight, sun);

    // ── orbit controls
    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.autoRotateSpeed = 0.6;

    // ── floor helpers (scaled with the model in frame())
    helpers = new THREE.Group();
    helpers.add(new THREE.GridHelper(200, 40, token('--meta'), token('--surface-highest')));
    for (const [text, x, z] of [['X', 110, 0], ['Z', 0, 110], ['-X', -110, 0], ['-Z', 0, -110]]) {
        const label = createTextSprite(text);
        label.position.set(x, 0, z);
        helpers.add(label);
    }
    scene.add(helpers);

    // ── invisible shadow-catching floor plane
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(4000, 4000), new THREE.ShadowMaterial({ opacity: 0.15 }));
    floor.rotation.x = -Math.PI / 2;
    // slightly below the 0 level so it doesn't z-fight with grid or lowest voxels
    floor.position.y = -0.01;
    floor.receiveShadow = true;
    scene.add(floor);

    // ── resize observer
    const ro = new ResizeObserver(() => {
        const w = container.clientWidth, h = container.clientHeight;
        renderer.setSize(w, h, false);
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

// Sun and shadow frustum sized for a model `s` times the default 128 voxels.
function fitLight(s) {
    sun.position.set(100 * s, 150 * s, 50 * s);
    const cam = sun.shadow.camera, d = 120 * s;
    Object.assign(cam, { left: -d, right: d, top: d, bottom: -d, near: 1, far: 400 * s });
    cam.updateProjectionMatrix();
}

/** Frame the current grid: camera back to its starting angle and distance. */
export function resetView() {
    if (grid) frame();
}

function frame() {
    const { sx, sy, sz } = grid;
    const s = Math.max(1, Math.max(sx, sy, sz) / 128);
    helpers.scale.setScalar(s);
    fitLight(s);
    const r = 0.5 * Math.hypot(sx, sy, sz);
    const dist = r * 2.5;
    controls.target.set(0, sy / 2, 0);
    camera.position.set(dist, dist * 0.7 + sy / 2, dist);
    controls.update();
}

function addChunk(key, b) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(b.positions, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(b.normals, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(b.colors, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(b.uvs, 2));
    geo.setIndex(new THREE.BufferAttribute(b.indices, 1));
    const mesh = new THREE.Mesh(geo, voxelMaterial);
    mesh.castShadow = mesh.receiveShadow = true;
    chunks.set(key, mesh);
    model.add(mesh);
}

function removeChunk(key) {
    const mesh = chunks.get(key);
    if (!mesh) return;
    model.remove(mesh);
    mesh.geometry.dispose();
    chunks.delete(key);
}

/** Show a new grid. `meshes` is Map(chunk key → mesher output) for it. */
export function setGrid(g, meshes, { reframe = false } = {}) {
    grid = g;
    for (const key of [...chunks.keys()]) removeChunk(key);
    for (const [key, b] of meshes) addChunk(key, b);
    model.position.set(-g.sx / 2, 0, -g.sz / 2);
    applyView();
    if (reframe) frame();
}

/** Re-mesh chunks after edits to the current grid. */
export function remesh(keys) {
    const linear = linearPalette(grid.palette);
    for (const key of keys) {
        removeChunk(key);
        const [cx, cy, cz] = key.split(',').map(Number);
        const b = meshChunk(grid, cx, cy, cz, { linear });
        if (b) addChunk(key, b);
    }
}

/**
 * Overlay the source model: `object` is in model space, mapped to grid space
 * by the voxelizer's `origin` and `cell` size. Pass null to clear.
 */
export function setGhost(object, origin, cell) {
    if (ghost) model.remove(ghost);
    ghost = null;
    if (!object) return;
    object.traverse((o) => {
        if (o.isMesh) { o.material = ghostMaterial; o.castShadow = o.receiveShadow = false; }
    });
    ghost = new THREE.Group();
    ghost.add(object);
    ghost.scale.setScalar(1 / cell);
    ghost.position.set(-origin[0] / cell, -origin[1] / cell, -origin[2] / cell);
    model.add(ghost);
    applyView();
}

/** { lines, ghost, clip, grid, spin }: clip is the visible fraction of the model height (1 = no clipping). */
export function setView(opts) {
    Object.assign(view, opts);
    applyView();
}

function applyView() {
    voxelMaterial.map = view.lines ? edgeTexture : null;
    voxelMaterial.needsUpdate = true;
    if (ghost) ghost.visible = view.ghost;
    helpers.visible = view.grid;
    controls.autoRotate = view.spin && !toolActive;   // the turntable pauses while editing
    clipPlane.constant = grid ? view.clip * grid.sy : 0;
    renderer.clippingPlanes = grid && view.clip < 1 ? [clipPlane] : [];
}

/** Voxel under a screen point: { voxel: [x, y, z], normal: [nx, ny, nz] } or null. */
export function pick(clientX, clientY) {
    if (!grid) return null;
    const rect = renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    // Matrices normally refresh when a frame renders; a new grid may not have rendered yet.
    model.updateMatrixWorld(true);
    raycaster.setFromCamera(ndc, camera);
    const clipY = view.clip < 1 ? view.clip * grid.sy : Infinity;
    const hit = raycaster.intersectObjects([...chunks.values()], false).find((h) => h.point.y <= clipY + 1e-3);
    if (!hit) return null;
    const n = hit.face.normal;   // chunk meshes are only translated, so this is grid space
    const p = model.worldToLocal(hit.point.clone());
    return { voxel: [p.x - n.x / 2, p.y - n.y / 2, p.z - n.z / 2].map(Math.floor), normal: [n.x, n.y, n.z] };
}

export const canvas = () => renderer.domElement;

/** While an edit tool is active, left-drag edits and right-drag orbits (instead of panning). */
export function setToolMode(active) {
    toolActive = active;
    controls.autoRotate = view.spin && !active;
    controls.mouseButtons.LEFT = active ? null : THREE.MOUSE.ROTATE;
    controls.mouseButtons.RIGHT = active ? THREE.MOUSE.ROTATE : THREE.MOUSE.PAN;
    renderer.domElement.style.cursor = active ? 'crosshair' : '';
}

const boxLines = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)),
    new THREE.LineBasicMaterial({ depthTest: false }),
);
boxLines.renderOrder = 998;

/** Outline the box between two voxel corners (inclusive), or hide it with null. */
export function showBox(a, b) {
    if (!a) { model.remove(boxLines); return; }
    const lo = a.map((v, i) => Math.min(v, b[i])), hi = a.map((v, i) => Math.max(v, b[i]) + 1);
    boxLines.scale.set(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
    boxLines.position.set((lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2);
    model.add(boxLines);
}

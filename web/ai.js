/**
 * ai.js — AI generation behind one contract. Each provider turns a photo (or,
 * on the server, a prompt) into a Source the pipeline already handles:
 *
 *   browser: photo → depth (+ optional subject mask) → relief grid     photoDepth(), runs in worker.js
 *   server:  photo | prompt → 3D mesh (GLB) from a model server        serverGenerate(), main thread
 *
 * The server speaks the job API in server/app.py; hosting it elsewhere (or a
 * SaaS speaking the same API) is just a different URL and key.
 *
 * In-browser models load from the Hugging Face Hub on first use and are then
 * cached by the browser; transformers.js is imported only when needed.
 */

const TRANSFORMERS = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.0';
const DEPTH_MODEL = 'onnx-community/depth-anything-v2-small';   // Apache-2.0, ~27 MB (q8) / 50 MB (fp16)
const MASK_MODEL = 'onnx-community/BiRefNet_lite-ONNX';          // MIT, ~115 MB (fp16), WebGPU only

let tf = null;
const pipes = new Map();

async function gpu() {
    const adapter = await navigator.gpu?.requestAdapter?.().catch(() => null);
    return adapter ? { f16: adapter.features.has('shader-f16') } : null;
}

// A cached transformers.js pipeline, reporting download progress across its files.
async function pipe(task, model, options, onProgress) {
    const key = `${task}:${model}`;
    if (!pipes.has(key)) {
        tf ??= await import(TRANSFORMERS);
        const files = new Map();
        const progress_callback = (e) => {
            if (e.status !== 'progress' || !e.total) return;
            files.set(e.file, [e.loaded, e.total]);
            let loaded = 0, total = 0;
            for (const [l, t] of files.values()) { loaded += l; total += t; }
            onProgress?.(loaded / total, `Downloading ${model.split('/')[1]}… ${Math.round(loaded / 1e6)} / ${Math.round(total / 1e6)} MB`);
        };
        pipes.set(key, tf.pipeline(task, model, { ...options, progress_callback }).catch((err) => {
            pipes.delete(key);
            throw err;
        }));
    }
    return pipes.get(key);
}

/**
 * Browser provider. Photo (RGBA) → { rgba, depth: Float32Array in [0, 1] (1 = nearest), width, height }.
 * With `mask`, the photo's alpha becomes the subject mask (needs WebGPU).
 */
export async function photoDepth(rgba, width, height, { mask = false, onProgress } = {}) {
    const device = await gpu();
    tf ??= await import(TRANSFORMERS);
    const image = new tf.RawImage(new Uint8ClampedArray(rgba), width, height, 4).rgb();

    const estimator = await pipe('depth-estimation', DEPTH_MODEL,
        device ? { device: 'webgpu', dtype: device.f16 ? 'fp16' : 'fp32' } : { dtype: 'q8' }, onProgress);
    onProgress?.(1, 'Estimating depth…');
    let { depth } = await estimator(image);   // 1-channel RawImage, bright = near
    if (depth.width !== width || depth.height !== height) depth = await depth.resize(width, height);
    const d = Float32Array.from(depth.data, (v) => v / 255);

    let out = rgba;
    if (mask) {
        if (!device) throw new Error('The AI background mask needs WebGPU; use "Cut by depth" instead.');
        const remover = await pipe('background-removal', MASK_MODEL, { device: 'webgpu', dtype: 'fp16' }, onProgress);
        onProgress?.(1, 'Masking the subject…');
        const [cut] = await remover(image);
        out = rgba.slice();
        for (let i = 0; i < width * height; i++) out[4 * i + 3] = Math.min(out[4 * i + 3], cut.data[4 * i + 3]);
    }
    return { rgba: out, depth: d, width, height };
}

// ── Server provider ──────────────────────────────────────────────────────────

async function serverCall(url, key, path, { signal, ...init } = {}) {
    const res = await fetch(url.replace(/\/+$/, '') + path, {
        ...init, signal, headers: key ? { Authorization: `Bearer ${key}` } : {},
    });
    if (!res.ok) throw new Error(`Model server: ${(await res.json().catch(() => null))?.detail ?? `HTTP ${res.status}`}`);
    return res;
}

const wait = (ms, signal) => new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(new Error('Cancelled.')); }, { once: true });
});

/** { ok, device, image, text } from the server, or throws. */
export async function serverHealth({ url, key, signal }) {
    return (await serverCall(url, key, '/v1/health', { signal })).json();
}

/** Photo (File/Blob) and/or prompt → GLB bytes. `onStage` gets the server's progress text. */
export async function serverGenerate({ url, key, image, prompt, signal, onStage }) {
    const form = new FormData();
    if (image) form.append('image', image);
    if (prompt) form.append('prompt', prompt);
    const { id } = await (await serverCall(url, key, '/v1/jobs', { method: 'POST', body: form, signal })).json();
    for (;;) {
        await wait(1000, signal);
        const job = await (await serverCall(url, key, `/v1/jobs/${id}`, { signal })).json();
        onStage?.(job.stage);
        if (job.status === 'done') break;
        if (job.status === 'error') throw new Error(`Model server: ${job.error}`);
    }
    return new Uint8Array(await (await serverCall(url, key, `/v1/jobs/${id}/result`, { signal })).arrayBuffer());
}

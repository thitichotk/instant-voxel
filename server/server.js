/**
 * server/server.js — Minimal Node.js dev server
 *
 * Serves every file under ../web/ with the two headers required for
 * Cross-Origin Isolation (needed by SharedArrayBuffer / pthreads):
 *
 *   Cross-Origin-Opener-Policy:   same-origin
 *   Cross-Origin-Embedder-Policy: credentialless
 *
 * Why 'credentialless' instead of 'require-corp'?
 *   The Lospec palette API (lospec.com) is a cross-origin fetch that does not
 *   send a Cross-Origin-Resource-Policy header. Under 'require-corp' the
 *   browser would block that fetch. 'credentialless' allows anonymous
 *   cross-origin requests while still satisfying the SharedArrayBuffer
 *   requirement in Chrome 91+, Firefox 119+, and Safari 15.2+.
 *
 * Usage:
 *   cd server && node server.js            # default port 3000
 *   PORT=8080 node server.js
 */

import http        from 'node:http';
import path        from 'node:path';
import fs          from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT  = path.resolve(__dirname, '..', 'web');
const PORT      = parseInt(process.env.PORT ?? '3000', 10);

// ── MIME types ────────────────────────────────────────────────────────────────
const MIME = {
    '.html':  'text/html; charset=utf-8',
    '.js':    'application/javascript; charset=utf-8',
    '.mjs':   'application/javascript; charset=utf-8',
    '.wasm':  'application/wasm',
    '.css':   'text/css; charset=utf-8',
    '.json':  'application/json',
    '.glb':   'model/gltf-binary',
    '.gltf':  'model/gltf+json',
    '.ico':   'image/x-icon',
    '.png':   'image/png',
    '.svg':   'image/svg+xml',
    '.txt':   'text/plain; charset=utf-8',
};

// ── Request handler ───────────────────────────────────────────────────────────

function handler(req, res) {
    // Only allow GET/HEAD
    if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { Allow: 'GET, HEAD' });
        return res.end();
    }

    // Resolve URL → filesystem path (strip query string)
    let urlPath = req.url.split('?')[0];
    if (urlPath === '/' || urlPath === '') urlPath = '/index.html';

    // Security: prevent path traversal outside WEB_ROOT
    const filePath = path.resolve(WEB_ROOT, '.' + urlPath);
    if (!filePath.startsWith(WEB_ROOT)) {
        res.writeHead(403);
        return res.end('Forbidden');
    }

    fs.stat(filePath, (statErr, stat) => {
        if (statErr || !stat.isFile()) {
            // Try index.html for directory requests
            const indexPath = path.join(filePath, 'index.html');
            fs.stat(indexPath, (e2, s2) => {
                if (e2 || !s2.isFile()) {
                    res.writeHead(404);
                    return res.end('Not found');
                }
                serveFile(indexPath, req, res);
            });
            return;
        }
        serveFile(filePath, req, res);
    });
}

function serveFile(filePath, req, res) {
    const ext      = path.extname(filePath).toLowerCase();
    const mimeType = MIME[ext] ?? 'application/octet-stream';

    // ── The two headers that enable Cross-Origin Isolation ────────────────
    // Without these, `crossOriginIsolated` is false and the browser will
    // refuse to create SharedArrayBuffers (which Emscripten pthreads need).
    //
    // 'credentialless' (not 'require-corp') allows anonymous cross-origin
    // fetches like the Lospec palette API while still enabling SAB.
    const headers = {
        'Content-Type':                  mimeType,
        'Cross-Origin-Opener-Policy':    'same-origin',
        'Cross-Origin-Embedder-Policy':  'credentialless',
        'Cross-Origin-Resource-Policy':  'same-origin',
        // Disable caching during development
        'Cache-Control':                 'no-store',
    };

    // .wasm files: add the correct streaming-compatible content-type header
    // (some clients check this before instantiating via WebAssembly.instantiateStreaming)
    if (ext === '.wasm') {
        headers['Content-Type'] = 'application/wasm';
    }

    fs.readFile(filePath, (err, data) => {
        if (err) {
            res.writeHead(500, headers);
            return res.end('Internal error');
        }
        headers['Content-Length'] = data.byteLength;
        res.writeHead(200, headers);
        if (req.method === 'HEAD') return res.end();
        res.end(data);
    });
}

// ── Start ─────────────────────────────────────────────────────────────────────

const server = http.createServer(handler);
server.listen(PORT, '127.0.0.1', () => {
    console.log(`\nVOXY dev server running at:\n`);
    console.log(`  http://localhost:${PORT}/\n`);
    console.log(`Cross-Origin Isolation headers: ✓`);
    console.log(`  Cross-Origin-Opener-Policy:   same-origin`);
    console.log(`  Cross-Origin-Embedder-Policy: credentialless\n`);
    console.log(`Serving: ${WEB_ROOT}\n`);
});

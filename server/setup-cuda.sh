#!/usr/bin/env bash
# Install TRELLIS.2 and start the model server on any Linux machine with an NVIDIA GPU (24 GB+): Colab, RunPod,
# Lambda, your own PC. Safe to run again: it skips what is done, and reprints the URL.
#
#   API_KEY=<key> server/setup-cuda.sh            # serves http://127.0.0.1:$PORT (reach it with ssh -L)
#   API_KEY=<key> server/setup-cuda.sh --public   # also opens a public https://….trycloudflare.com URL
#
# Needs git, Python 3.10+ and the CUDA toolkit (nvcc) of PyTorch's CUDA major version.
# Env: API_KEY (required with --public), PORT (default 8000), HF_TOKEN (optional: faster downloads).
# Lines starting with ::phase and ::url are progress and the public URL, for launchers that drive this script.
set -euo pipefail
PORT=${PORT:-8000}
SERVER=$(cd "$(dirname "$0")" && pwd)
VENDOR=$SERVER/vendor   # gitignored: the TRELLIS.2 clone, logs, cloudflared
PUBLIC=$([ "${1:-}" = --public ] && echo 1 || true)
if [ -n "$PUBLIC" ] && [ -z "${API_KEY:-}" ]; then
  echo "--public needs API_KEY: anyone with the URL could use your GPU." >&2; exit 1
fi
command -v nvidia-smi >/dev/null || { echo "No NVIDIA GPU here (nvidia-smi not found)." >&2; exit 1; }
export CUDA_HOME=${CUDA_HOME:-/usr/local/cuda}
export PATH=$CUDA_HOME/bin:$PATH  # Colab ships the toolkit off PATH
command -v nvcc >/dev/null || { echo "No CUDA toolkit (nvcc): install it, or set CUDA_HOME." >&2; exit 1; }
mkdir -p "$VENDOR"

echo "::phase Installing TRELLIS.2 (first time on a machine: builds CUDA extensions, ~15 min)"
[ -d "$VENDOR/TRELLIS.2" ] || git clone -q --recursive https://github.com/microsoft/TRELLIS.2.git "$VENDOR/TRELLIS.2"
# nvdiffrec is left out: only TRELLIS.2's preview-video renderer uses it, and it fails to build on CUDA 13
CHECK="import o_voxel, cumesh, flex_gemm, nvdiffrast.torch"
if ! python3 -c "$CHECK" 2>/dev/null; then
  # TRELLIS.2's own --basic list, minus its demo UI (gradio) and pillow-simd
  python3 -m pip install -q -r "$SERVER/requirements.txt" imageio imageio-ffmpeg tqdm easydict \
    opencv-python-headless ninja trimesh kornia timm zstandard pandas lpips \
    "git+https://github.com/EasternJournalist/utils3d.git@9a4eb15e4021b67b12c460c7057d642626897ec8"
  (cd "$VENDOR/TRELLIS.2" && bash setup.sh --nvdiffrast --cumesh --o-voxel --flexgemm)
  python3 -c "$CHECK"
fi
python3 -c "import flash_attn" 2>/dev/null || python3 -c "import torch.nn.attention.varlen" 2>/dev/null ||
  { echo "TRELLIS.2 needs flash-attn, or PyTorch 2.10+ (whose own varlen attention the server uses)." >&2; exit 1; }

echo "::phase Downloading TRELLIS.2 weights"
python3 -c "from huggingface_hub import snapshot_download; snapshot_download('microsoft/TRELLIS.2-4B')" >/dev/null

echo "::phase Starting the server"
# no subshell around the background starts: one would wait on the server, holding an SSH session open
if ! pgrep -f "uvicorn app:app --host 127.0.0.1 --port $PORT" >/dev/null; then
  cd "$SERVER"
  MODEL=trellis2 PYTHONPATH="$VENDOR/TRELLIS.2" PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True OPENCV_IO_ENABLE_OPENEXR=1 \
    nohup setsid python3 -m uvicorn app:app --host 127.0.0.1 --port "$PORT" </dev/null >"$VENDOR/server.log" 2>&1 &
fi
until curl -sf "localhost:$PORT/openapi.json" >/dev/null; do  # FastAPI's schema needs no API key
  pgrep -f "uvicorn app:app --host 127.0.0.1 --port $PORT" >/dev/null || { tail -n40 "$VENDOR/server.log" | cut -c1-300; exit 1; }
  sleep 2
done
echo "Server: http://127.0.0.1:$PORT (log: $VENDOR/server.log)"
[ -n "$PUBLIC" ] || { echo READY; exit 0; }

echo "::phase Opening the public URL"
CF=$VENDOR/cloudflared
if [ ! -x "$CF" ]; then
  arch=$(uname -m | sed 's/x86_64/amd64/; s/aarch64/arm64/')
  curl -fsSL -o "$CF" "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-$arch"
  chmod +x "$CF"
fi
if ! pgrep -f "cloudflared tunnel --no-autoupdate --protocol http2 --url http://127.0.0.1:$PORT" >/dev/null; then
  # http2: over cloudflared's default QUIC a Colab VM got ~0.1 MB/s (a model took 80 s to download); http2 took 2 s
  nohup setsid "$CF" tunnel --no-autoupdate --protocol http2 --url "http://127.0.0.1:$PORT" \
    </dev/null >"$VENDOR/cloudflared.log" 2>&1 &
fi
URL=
for _ in $(seq 60); do
  # word-word-….trycloudflare.com; error lines mention api.trycloudflare.com, which this skips
  URL=$(grep -oE 'https://[a-z0-9]+(-[a-z0-9]+)+\.trycloudflare\.com' "$VENDOR/cloudflared.log" 2>/dev/null | head -1 || true)
  [ -n "$URL" ] && break
  sleep 1
done
[ -n "$URL" ] || { tail -n20 "$VENDOR/cloudflared.log"; exit 1; }
echo "::url $URL"
echo READY

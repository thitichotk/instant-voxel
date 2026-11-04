#!/usr/bin/env bash
# Install TRELLIS.2 or Pixal3D and start the model server on any Linux machine with an NVIDIA GPU (24 GB+): Colab,
# RunPod, Lambda, your own PC. Safe to run again: it skips what is done, and reprints the URL. Run it again with the
# other MODEL to switch the running server.
#
#   API_KEY=<key> server/setup-cuda.sh                  # serves http://127.0.0.1:$PORT (reach it with ssh -L)
#   API_KEY=<key> server/setup-cuda.sh --public         # also opens a public https://….trycloudflare.com URL
#   MODEL=pixal3d API_KEY=<key> server/setup-cuda.sh    # Tencent's Pixal3D instead of TRELLIS.2
#
# Needs git, Python 3.10+ and the CUDA toolkit (nvcc) of PyTorch's CUDA major version.
# Env: MODEL (trellis2 or pixal3d, default trellis2), API_KEY (required with --public), PORT (default 8000),
# HF_TOKEN (optional: faster downloads).
# Lines starting with ::phase and ::url are progress and the public URL, for launchers that drive this script.
set -euo pipefail
PORT=${PORT:-8000}
MODEL=${MODEL:-trellis2}
case $MODEL in trellis2 | pixal3d) ;; *) echo "MODEL must be trellis2 or pixal3d." >&2; exit 1 ;; esac
SERVER=$(cd "$(dirname "$0")" && pwd)
VENDOR=$SERVER/vendor   # gitignored: the model repos, logs, cloudflared
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
CODE=$VENDOR/TRELLIS.2
WEIGHTS=microsoft/TRELLIS.2-4B
if [ "$MODEL" = trellis2 ]; then
  python3 -c "import flash_attn" 2>/dev/null || python3 -c "import torch.nn.attention.varlen" 2>/dev/null ||
    { echo "TRELLIS.2 needs flash-attn, or PyTorch 2.10+ (whose own varlen attention the server uses)." >&2; exit 1; }
else
  echo "::phase Installing Pixal3D (on top of TRELLIS.2, whose extensions it uses)"
  CODE=$VENDOR/Pixal3D
  WEIGHTS=TencentARC/Pixal3D
  [ -d "$CODE" ] || git clone -q https://github.com/TencentARC/Pixal3D.git "$CODE"
  git -C "$CODE" checkout -q f7cf38429b0bd264f1995f0f8743a88b1c728b94
  CHECK="import natten, moge, utils3d_moge, plyfile"
  if ! python3 -c "$CHECK" 2>/dev/null; then
    # natten's wheel is built per Python, torch and CUDA version, e.g. natten-0.21.6+torch2110cu130-cp313-…
    NATTEN=$(python3 -c 'import platform, sys, torch
py = f"cp{sys.version_info[0]}{sys.version_info[1]}"
tag = "torch" + torch.__version__.split("+")[0].replace(".", "") + "cu" + torch.version.cuda.replace(".", "")
print(f"natten-0.21.6%2B{tag}-{py}-{py}-linux_{platform.machine()}.whl")')
    python3 -m pip install -q "https://github.com/SHI-Labs/NATTEN/releases/download/v0.21.6/$NATTEN" plyfile \
      "git+https://github.com/EasternJournalist/utils3d-moge.git@62f09d58509485564e24d5d9f6aac9ee9ebc0c37"
    # MoGe's own dependency list would rebuild FlexGEMM and add gradio; its camera model needs only utils3d-moge
    python3 -m pip install -q --no-deps "git+https://github.com/microsoft/MoGe.git@74fbce054ebed49800de42d0ad0e83495065719a"
    python3 -c "$CHECK"
  fi
fi

echo "::phase Downloading $MODEL weights"
python3 -c "from huggingface_hub import snapshot_download; snapshot_download('$WEIGHTS')" >/dev/null

echo "::phase Starting the server"
UVICORN="uvicorn app:app --host 127.0.0.1 --port $PORT"
# a server running the other model is stopped; the tunnel stays, so the URL does not change
if [ "$(cat "$VENDOR/server.model" 2>/dev/null)" != "$MODEL" ] && pkill -f "$UVICORN"; then
  while pgrep -f "$UVICORN" >/dev/null; do sleep 1; done
fi
# no subshell around the background starts: one would wait on the server, holding an SSH session open
if ! pgrep -f "$UVICORN" >/dev/null; then
  cd "$SERVER"
  echo "$MODEL" >"$VENDOR/server.model"
  MODEL=$MODEL PYTHONPATH="$CODE" PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True OPENCV_IO_ENABLE_OPENEXR=1 \
    nohup setsid python3 -m uvicorn app:app --host 127.0.0.1 --port "$PORT" </dev/null >"$VENDOR/server.log" 2>&1 &
fi
until curl -sf "localhost:$PORT/openapi.json" >/dev/null; do  # FastAPI's schema needs no API key
  pgrep -f "$UVICORN" >/dev/null || { tail -n40 "$VENDOR/server.log" | cut -c1-300; exit 1; }
  sleep 2
done
echo "Server: http://127.0.0.1:$PORT, $MODEL (log: $VENDOR/server.log)"
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

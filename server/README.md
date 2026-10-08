# Instant-Voxel model server

The model server turns a photo, or a text prompt, into a 3D mesh (GLB) for the web app's **Generate → Model server**
option. The web app then voxelises the mesh like any model you open.

- **Photo → 3D:** [Stable Fast 3D](https://github.com/Stability-AI/stable-fast-3d) (SF3D)
- **Text → photo → 3D:** SDXL with [SDXL-Lightning](https://huggingface.co/ByteDance/SDXL-Lightning) (4 steps),
  then SF3D

The API is small (`app.py` documents it), so the same server can run on a hosted GPU later: point the app's
*Server* field at it and set `API_KEY`.

## Run it on a Mac (Apple Silicon)

SF3D on Apple Silicon is experimental upstream. It needs PyTorch 2.4 or later, the OpenMP runtime, and about
**32 GB of unified memory** (text prompts load SDXL too).

```bash
cd server
python3.11 -m venv .venv && source .venv/bin/activate
brew install libomp                      # OpenMP runtime for SF3D's texture baker
pip install -r requirements.txt

# Stable Fast 3D is used from its repo:
git clone https://github.com/Stability-AI/stable-fast-3d vendor/stable-fast-3d
pip install -U setuptools==69.5.1 wheel
pip install -r vendor/stable-fast-3d/requirements.txt

# SF3D is a gated model: accept its licence at
# https://huggingface.co/stabilityai/stable-fast-3d, then:
huggingface-cli login

uvicorn app:app --port 8000
```

In the app, open **Generate**, choose **Model server** and use `http://127.0.0.1:8000`. The first job downloads
the models; later jobs start at once.

- Run the web app from localhost too (`python3 -m http.server -b 127.0.0.1 -d web 3000`). From the live site,
  Chrome first asks permission to reach a server on your local network.
- To try the API without the models, run `FAKE_MODELS=1 uvicorn app:app --port 8000`. It returns a cube coloured
  like the photo, or keyed to the prompt, and needs only the four packages under `# API` in `requirements.txt`.

## Settings (environment variables)

| Variable | Default | Purpose |
|---|---|---|
| `ALLOWED_ORIGINS` | `http://127.0.0.1:3000,http://localhost:3000,https://instantvoxel.thitichotk.com` | Sites allowed to call the server (CORS) |
| `API_KEY` | unset | If set, requests must send `Authorization: Bearer <key>` |
| `SF3D_DIR` | `vendor/stable-fast-3d` | Where the SF3D repo is cloned |
| `FAKE_MODELS` | unset | `1` serves placeholder cubes |

## Licences

The server's own code is MIT, like the rest of the repo. The models it downloads keep their own licences:

- **Stable Fast 3D:** Stability AI Community License. Free for research and for commercial use under USD 1M in
  annual revenue, including hosted services. Commercial use needs registration and a visible **"Powered by
  Stability AI"** notice (the web app shows one on server results).
- **SDXL and SDXL-Lightning:** CreativeML Open RAIL++-M (commercial use allowed, with use-based restrictions).
- **rembg:** MIT.

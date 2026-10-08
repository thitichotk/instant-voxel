"""Instant-Voxel model server: photo or prompt → 3D mesh (GLB bytes).

image → mesh: Stable Fast 3D (stabilityai/stable-fast-3d, Stability AI
              Community License: free under $1M annual revenue, attribution).
text → image: SDXL + SDXL-Lightning 4-step UNet (CreativeML Open RAIL++-M),
              then image → mesh.
Models load on first use and stay in memory. Set FAKE_MODELS=1 to serve
a placeholder cube instead (for testing the API without the models).
"""

import os
import sys
from contextlib import nullcontext
from pathlib import Path

os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")  # before torch loads

# SF3D is used from a clone of its repo (see README.md); make `sf3d` importable.
SF3D_DIR = Path(os.environ.get("SF3D_DIR", Path(__file__).parent / "vendor" / "stable-fast-3d"))
sys.path.insert(0, str(SF3D_DIR))

PROMPT_SUFFIX = ", single object, centered, full view, plain white background, studio lighting"

_sf3d = _rembg = _t2i = None


def device():
    import torch

    if torch.cuda.is_available():
        return "cuda"
    return "mps" if torch.backends.mps.is_available() else "cpu"


def image_to_glb(image, stage=lambda s: None):
    """PIL image (any mode) → GLB bytes."""
    global _sf3d, _rembg
    import rembg
    import torch
    from sf3d.system import SF3D
    from sf3d.utils import remove_background, resize_foreground

    dev = device()
    if _sf3d is None:
        stage("loading Stable Fast 3D")
        _sf3d = SF3D.from_pretrained(
            "stabilityai/stable-fast-3d", config_name="config.yaml", weight_name="model.safetensors"
        ).to(dev).eval()
        _rembg = rembg.new_session()
    stage("removing background")
    image = resize_foreground(remove_background(image.convert("RGBA"), _rembg), 0.85)
    stage("generating mesh")
    autocast = torch.autocast(device_type=dev, dtype=torch.bfloat16) if dev == "cuda" else nullcontext()
    with torch.no_grad(), autocast:
        mesh, _ = _sf3d.run_image(image, bake_resolution=1024, remesh="none", vertex_count=-1)
    return mesh.export(file_type="glb", include_normals=True)


def text_to_image(prompt, seed=None, stage=lambda s: None):
    """Prompt → PIL image of a single object on a plain background."""
    global _t2i
    import torch
    from diffusers import EulerDiscreteScheduler, StableDiffusionXLPipeline, UNet2DConditionModel
    from huggingface_hub import hf_hub_download
    from safetensors.torch import load_file

    dev = device()
    if _t2i is None:
        stage("loading SDXL-Lightning")
        base = "stabilityai/stable-diffusion-xl-base-1.0"
        unet = UNet2DConditionModel.from_config(base, subfolder="unet")
        unet.load_state_dict(load_file(hf_hub_download("ByteDance/SDXL-Lightning", "sdxl_lightning_4step_unet.safetensors")))
        _t2i = StableDiffusionXLPipeline.from_pretrained(
            base, unet=unet.to(torch.float16), torch_dtype=torch.float16, variant="fp16"
        ).to(dev)
        _t2i.scheduler = EulerDiscreteScheduler.from_config(_t2i.scheduler.config, timestep_spacing="trailing")
    stage("painting the object")
    generator = torch.Generator("cpu").manual_seed(seed) if seed is not None else None
    return _t2i(prompt + PROMPT_SUFFIX, num_inference_steps=4, guidance_scale=0, generator=generator).images[0]


if os.environ.get("FAKE_MODELS") == "1":
    from fake_models import image_to_glb, text_to_image, device  # noqa: F401,F811

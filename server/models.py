"""Instant-Voxel model server: photo or prompt → 3D mesh (GLB bytes).

image → mesh: Stable Fast 3D (stabilityai/stable-fast-3d, Stability AI
              Community License: free under $1M annual revenue, attribution),
              or with MODEL=trellis2, TRELLIS.2 (microsoft/TRELLIS.2-4B, MIT;
              CUDA only, 24 GB+).
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

MODEL = os.environ.get("MODEL", "sf3d")
# TRELLIS.2's third-party models, pinned to a commit: BiRefNet runs its repo's own Python (trust_remote_code).
# BiRefNet's weights are MIT; TRELLIS.2's default cut-out model, briaai/RMBG-2.0, is CC BY-NC.
BIREFNET = ("ZhengPeng7/BiRefNet", "e2bf8e4460fc8fa32bba5ea4d94b3233d367b0e4")
# Meta's DINOv3 repo (facebook/dinov3-vitl16-pretrain-lvd1689m) is gated behind a form; this copy has the
# same files and DINOv3 License (which allows redistribution) and is not.
DINOV3 = ("camenduru/dinov3-vitl16-pretrain-lvd1689m", "3c276edd87d6f6e569ff0c4400e086807d0f3881")
CREDIT = {
    "sf3d": "3D by Stable Fast 3D. Powered by Stability AI.",
    "trellis2": "3D by TRELLIS.2 (Microsoft).",
}[MODEL]

_sf3d = _rembg = _t2i = _trellis2 = None


def device():
    import torch

    if torch.cuda.is_available():
        return "cuda"
    return "mps" if torch.backends.mps.is_available() else "cpu"


def image_to_glb(image, stage=lambda s: None):
    """PIL image (any mode) → GLB bytes."""
    if MODEL == "trellis2":
        return _trellis2_glb(image, stage)
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


def _flash_attn_shim():
    """The flash-attn varlen calls TRELLIS.2's sparse attention makes, on torch's own kernel (torch ≥ 2.10)."""
    import types

    from torch.nn.attention.varlen import varlen_attn

    def varlen(q, k, v, cu_seqlens_q, cu_seqlens_k, max_seqlen_q, max_seqlen_k):
        return varlen_attn(q, k, v, cu_seqlens_q, cu_seqlens_k, int(max_seqlen_q), int(max_seqlen_k))

    shim = types.ModuleType("flash_attn")
    shim.flash_attn_varlen_func = varlen
    shim.flash_attn_varlen_kvpacked_func = lambda q, kv, cu_seqlens_q, cu_seqlens_k, max_seqlen_q, max_seqlen_k: varlen(
        q, *kv.unbind(1), cu_seqlens_q, cu_seqlens_k, max_seqlen_q, max_seqlen_k)
    shim.flash_attn_varlen_qkvpacked_func = lambda qkv, cu_seqlens, max_seqlen: varlen(
        *qkv.unbind(1), cu_seqlens, cu_seqlens, max_seqlen, max_seqlen)
    return shim


def _trellis2_glb(image, stage):
    """TRELLIS.2, imported from its repo clone on PYTHONPATH (see README.md)."""
    global _trellis2
    import o_voxel

    if _trellis2 is None:
        stage("loading TRELLIS.2")
        try:
            import flash_attn  # noqa: F401
        except ImportError:  # e.g. Colab's torch 2.11/CUDA 13, which no flash-attn or xformers wheel supports yet
            sys.modules["flash_attn"] = _flash_attn_shim()
        os.environ.setdefault("ATTN_BACKEND", "sdpa")  # dense attention; sparse stays on flash_attn
        from huggingface_hub import snapshot_download
        from trellis2.modules import image_feature_extractor as t2_features
        from trellis2.pipelines import Trellis2ImageTo3DPipeline
        from trellis2.pipelines import rembg as t2_rembg

        # A local snapshot path loads the pinned files, code included, instead of the repo's latest.
        birefnet = t2_rembg.BiRefNet

        def birefnet_fp32(model_name):
            cut = birefnet(snapshot_download(BIREFNET[0], revision=BIREFNET[1]))
            cut.model.float()  # transformers 5 keeps the checkpoint's fp16, but TRELLIS.2 feeds it fp32
            return cut

        t2_rembg.BiRefNet = birefnet_fp32
        dinov3 = t2_features.DinoV3FeatureExtractor

        def dinov3_copy(model_name, **kw):
            encoder = dinov3(snapshot_download(DINOV3[0], revision=DINOV3[1]), **kw)
            if not hasattr(encoder.model, "layer"):  # transformers 5 moved the blocks to .model.layer
                encoder.model.layer = encoder.model.model.layer
            return encoder

        t2_features.DinoV3FeatureExtractor = dinov3_copy
        _trellis2 = Trellis2ImageTo3DPipeline.from_pretrained("microsoft/TRELLIS.2-4B")
        _trellis2.cuda()
    stage("generating mesh")
    # An opaque alpha makes the pipeline cut the background itself; a real one is used as is.
    mesh = _trellis2.run(image.convert("RGBA"))[0]
    mesh.simplify(16777216)  # nvdiffrast limit
    stage("baking texture")
    glb = o_voxel.postprocess.to_glb(
        vertices=mesh.vertices, faces=mesh.faces, attr_volume=mesh.attrs, coords=mesh.coords,
        attr_layout=mesh.layout, voxel_size=mesh.voxel_size, aabb=[[-0.5] * 3, [0.5] * 3],
        # the web app samples textures at ≤ 2048 px and voxelises at ≤ 512, so more is wasted bytes
        decimation_target=200_000, texture_size=2048, remesh=True, remesh_band=1, remesh_project=0,
    )
    return glb.export(file_type="glb", extension_webp=True)


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

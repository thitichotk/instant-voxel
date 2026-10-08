"""Stand-ins for models.py when VOXY_FAKE_MODELS=1: a coloured cube GLB, no ML
dependencies. Lets the job API and the web app be tested end to end."""

import json
import struct
import zlib

from PIL import Image, ImageStat


def device():
    return "fake"


def _cube_glb(rgb):
    positions = [c for z in (0, 1) for y in (0, 1) for x in (0, 1) for c in (x, y, z)]
    quads = [(0, 2, 3, 1), (4, 5, 7, 6), (0, 1, 5, 4), (2, 6, 7, 3), (0, 4, 6, 2), (1, 3, 7, 5)]
    indices = [i for a, b, c, d in quads for i in (a, b, c, a, c, d)]
    binary = struct.pack("<24f", *positions) + struct.pack("<36H", *indices)
    doc = {
        "asset": {"version": "2.0", "generator": "VOXY fake model"},
        "scene": 0,
        "scenes": [{"nodes": [0]}],
        "nodes": [{"mesh": 0}],
        "meshes": [{"primitives": [{"attributes": {"POSITION": 0}, "indices": 1, "material": 0}]}],
        "materials": [{"pbrMetallicRoughness": {"baseColorFactor": [*(c / 255 for c in rgb), 1]}}],
        "buffers": [{"byteLength": len(binary)}],
        "bufferViews": [
            {"buffer": 0, "byteOffset": 0, "byteLength": 96, "target": 34962},
            {"buffer": 0, "byteOffset": 96, "byteLength": 72, "target": 34963},
        ],
        "accessors": [
            {"bufferView": 0, "componentType": 5126, "count": 8, "type": "VEC3", "min": [0, 0, 0], "max": [1, 1, 1]},
            {"bufferView": 1, "componentType": 5123, "count": 36, "type": "SCALAR"},
        ],
    }
    text = json.dumps(doc).encode()
    text += b" " * (-len(text) % 4)
    binary += b"\0" * (-len(binary) % 4)
    chunks = struct.pack("<I4s", len(text), b"JSON") + text + struct.pack("<I4s", len(binary), b"BIN\0") + binary
    return struct.pack("<4sII", b"glTF", 2, 12 + len(chunks)) + chunks


def image_to_glb(image, stage=lambda s: None):
    stage("generating mesh")
    return _cube_glb(tuple(int(v) for v in ImageStat.Stat(image.convert("RGB")).mean))


def text_to_image(prompt, seed=None, stage=lambda s: None):
    stage("painting the object")
    h = zlib.crc32(prompt.encode())
    return Image.new("RGB", (64, 64), (h & 255, (h >> 8) & 255, (h >> 16) & 255))

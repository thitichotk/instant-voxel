/**
 * voxelizer.cpp
 *
 * CPU-side GLB → VOX converter exposed via Emscripten Embind.
 *
 * Dependencies:
 *   tiny_gltf.h  (header-only, place at src/tiny_gltf.h)
 *   https://github.com/syoyo/tinygltf/blob/master/tiny_gltf.h
 *
 * Public API (one JS-visible function):
 *
 *   convertGLBToVox(glbData    : ArrayBuffer | Uint8Array,  // .glb binary
 *                   paletteData: ArrayBuffer | Uint8Array,  // 256×4 RGBA or empty
 *                   gridSize   : number,                    // longest axis voxels
 *                   rotX, rotY : number)                    // degrees
 *     → Uint8Array   (MagicaVoxel .vox binary)
 *
 * Voxel colour assignment: each glTF primitive's material colour is extracted —
 * UV-sampled texture pixel modulated by baseColorFactor (per-vertex, averaged
 * across the triangle), or plain baseColorFactor when no texture is present —
 * and mapped to the nearest palette entry. The palette is the uploaded one, or
 * the built-in 6×6×6 RGB cube + grey ramp.
 */

// ── tinygltf (header-only, implementation guard)
// ──────────────────────────────
#define TINYGLTF_IMPLEMENTATION
#define TINYGLTF_NO_STB_IMAGE_WRITE // load-only: nothing here writes images
#define STB_IMAGE_IMPLEMENTATION
#include "tiny_gltf.h"

// ── Emscripten
// ────────────────────────────────────────────────────────────────
#include <emscripten/bind.h> // also brings in val.h

// ── STL
// ───────────────────────────────────────────────────────────────────────
#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <string>
#include <vector>

using namespace emscripten;

// ────────────────────────────────────────────────────────────────────────────
//  Math helpers
// ────────────────────────────────────────────────────────────────────────────

struct Vec3f {
  float x, y, z;
  Vec3f operator+(const Vec3f &b) const { return {x + b.x, y + b.y, z + b.z}; }
  Vec3f operator-(const Vec3f &b) const { return {x - b.x, y - b.y, z - b.z}; }
  Vec3f operator*(float t) const { return {x * t, y * t, z * t}; }
};

inline float dot(Vec3f a, Vec3f b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
inline Vec3f cross(Vec3f a, Vec3f b) {
  return {a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x};
}

// ────────────────────────────────────────────────────────────────────────────
//  4×4 column-major matrix (matching GLTF convention)
// ────────────────────────────────────────────────────────────────────────────

using Mat4 = std::array<float, 16>; // column-major: m[col*4 + row]

static Mat4 identity4() {
  Mat4 m{};
  m[0] = m[5] = m[10] = m[15] = 1.f;
  return m;
}

static Mat4 mul4(const Mat4 &a, const Mat4 &b) {
  Mat4 r{};
  for (int col = 0; col < 4; ++col)
    for (int row = 0; row < 4; ++row)
      for (int k = 0; k < 4; ++k)
        r[col * 4 + row] += a[k * 4 + row] * b[col * 4 + k];
  return r;
}

// glTF node transforms are affine (the spec requires TRS-decomposable
// matrices), so w is always 1 and there is no perspective divide.
static Vec3f transformPoint(const Mat4 &m, Vec3f p) {
  return {m[0] * p.x + m[4] * p.y + m[8] * p.z + m[12],
          m[1] * p.x + m[5] * p.y + m[9] * p.z + m[13],
          m[2] * p.x + m[6] * p.y + m[10] * p.z + m[14]};
}

// Build a 4×4 matrix from a tinygltf node (matrix OR TRS).
static Mat4 nodeMatrix(const tinygltf::Node &n) {
  // Explicit 4×4 matrix takes priority.
  if (n.matrix.size() == 16) {
    Mat4 m;
    for (int i = 0; i < 16; ++i)
      m[i] = (float)n.matrix[i];
    return m;
  }

  Mat4 result = identity4();

  // Scale
  if (n.scale.size() == 3) {
    Mat4 s = identity4();
    s[0] = (float)n.scale[0];
    s[5] = (float)n.scale[1];
    s[10] = (float)n.scale[2];
    result = mul4(result, s);
  }

  // Rotation (unit quaternion x,y,z,w)
  if (n.rotation.size() == 4) {
    float qx = (float)n.rotation[0], qy = (float)n.rotation[1],
          qz = (float)n.rotation[2], qw = (float)n.rotation[3];
    Mat4 r = identity4();
    r[0] = 1 - 2 * (qy * qy + qz * qz);
    r[1] = 2 * (qx * qy + qw * qz);
    r[2] = 2 * (qx * qz - qw * qy);
    r[4] = 2 * (qx * qy - qw * qz);
    r[5] = 1 - 2 * (qx * qx + qz * qz);
    r[6] = 2 * (qy * qz + qw * qx);
    r[8] = 2 * (qx * qz + qw * qy);
    r[9] = 2 * (qy * qz - qw * qx);
    r[10] = 1 - 2 * (qx * qx + qy * qy);
    result = mul4(result, r);
  }

  // Translation
  if (n.translation.size() == 3) {
    Mat4 t = identity4();
    t[12] = (float)n.translation[0];
    t[13] = (float)n.translation[1];
    t[14] = (float)n.translation[2];
    result = mul4(result, t);
  }

  return result;
}

// ────────────────────────────────────────────────────────────────────────────
//  Triangle
// ────────────────────────────────────────────────────────────────────────────

struct Triangle {
  Vec3f v[3];
  uint8_t r, g, b; // sRGB material colour extracted from glTF primitive
};

// ────────────────────────────────────────────────────────────────────────────
//  GLTF mesh extraction  (walks scene graph, applies node world transforms)
// ────────────────────────────────────────────────────────────────────────────

static void extractMeshPrims(const tinygltf::Model &model, int meshIdx,
                             const Mat4 &worldTx, std::vector<Triangle> &tris) {
  const tinygltf::Mesh &mesh = model.meshes[meshIdx];

  for (const tinygltf::Primitive &prim : mesh.primitives) {
    // Only TRIANGLES mode (strips, fans, lines and points are ignored).
    // tinygltf already defaults a missing "mode" to TRIANGLES.
    if (prim.mode != TINYGLTF_MODE_TRIANGLES)
      continue;

    // ── POSITION accessor ──────────────────────────────────────────────
    auto posIt = prim.attributes.find("POSITION");
    if (posIt == prim.attributes.end())
      continue;

    const tinygltf::Accessor &posAcc = model.accessors[posIt->second];
    const tinygltf::BufferView &posView = model.bufferViews[posAcc.bufferView];
    const tinygltf::Buffer &posBuf = model.buffers[posView.buffer];

    const size_t posStride =
        posView.byteStride ? posView.byteStride : sizeof(float) * 3;

    auto getPos = [&](size_t idx) -> Vec3f {
      const uint8_t *base = posBuf.data.data() + posView.byteOffset +
                            posAcc.byteOffset + idx * posStride;
      float px, py, pz;
      std::memcpy(&px, base, sizeof(float));
      std::memcpy(&py, base + sizeof(float), sizeof(float));
      std::memcpy(&pz, base + sizeof(float) * 2, sizeof(float));
      return transformPoint(worldTx, {px, py, pz});
    };

    // ── Material: baseColorFactor + optional base colour texture ─────────
    uint8_t bfR = 255, bfG = 255, bfB = 255;
    bool useTexture = false;
    const tinygltf::Image *baseColorImage = nullptr;
    if (prim.material >= 0 && prim.material < (int)model.materials.size()) {
      const auto &mat = model.materials[prim.material];
      const auto &pbr = mat.pbrMetallicRoughness;
      if (pbr.baseColorFactor.size() >= 3) {
        bfR = (uint8_t)(std::min(1.0, pbr.baseColorFactor[0]) * 255.0 + 0.5);
        bfG = (uint8_t)(std::min(1.0, pbr.baseColorFactor[1]) * 255.0 + 0.5);
        bfB = (uint8_t)(std::min(1.0, pbr.baseColorFactor[2]) * 255.0 + 0.5);
      }
      if (pbr.baseColorTexture.index >= 0 &&
          pbr.baseColorTexture.index < (int)model.textures.size()) {
        const auto &tex = model.textures[pbr.baseColorTexture.index];
        if (tex.source >= 0 && tex.source < (int)model.images.size()) {
          const auto &img = model.images[tex.source];
          if (!img.image.empty() && img.width > 0 && img.height > 0) {
            baseColorImage = &img;
            useTexture = true;
          }
        }
      }
    }

    // ── UV accessor (TEXCOORD_0) ──────────────────────────────────────────
    const uint8_t *uvBase = nullptr;
    size_t uvStride = sizeof(float) * 2;
    if (useTexture) {
      auto uvIt = prim.attributes.find("TEXCOORD_0");
      if (uvIt != prim.attributes.end()) {
        const tinygltf::Accessor &uvAcc = model.accessors[uvIt->second];
        const tinygltf::BufferView &uvView =
            model.bufferViews[uvAcc.bufferView];
        const tinygltf::Buffer &uvBuf = model.buffers[uvView.buffer];
        uvBase = uvBuf.data.data() + uvView.byteOffset + uvAcc.byteOffset;
        uvStride = uvView.byteStride ? uvView.byteStride : sizeof(float) * 2;
      } else {
        useTexture = false; // no UVs available — fall back to baseColorFactor
      }
    }

    // Sample per-vertex colour: texture pixel × baseColorFactor, or plain
    // factor.
    auto sampleColor = [&](size_t idx, uint8_t out[3]) {
      if (useTexture) {
        const float *uv =
            reinterpret_cast<const float *>(uvBase + idx * uvStride);
        float u = uv[0] - std::floor(uv[0]);
        float v = uv[1] - std::floor(uv[1]);
        int px = std::min(baseColorImage->width - 1,
                          (int)(u * baseColorImage->width));
        int py = std::min(baseColorImage->height - 1,
                          (int)(v * baseColorImage->height));
        int ch = baseColorImage->component;
        int pi = (py * baseColorImage->width + px) * ch;
        out[0] = (uint8_t)((baseColorImage->image[pi + 0] * bfR) / 255);
        out[1] = (uint8_t)((baseColorImage->image[pi + 1] * bfG) / 255);
        out[2] = (uint8_t)((baseColorImage->image[pi + 2] * bfB) / 255);
      } else {
        out[0] = bfR;
        out[1] = bfG;
        out[2] = bfB;
      }
    };

    auto emitTri = [&](size_t a, size_t b, size_t c) {
      Triangle t;
      t.v[0] = getPos(a);
      t.v[1] = getPos(b);
      t.v[2] = getPos(c);
      uint8_t ca[3], cb[3], cc[3];
      sampleColor(a, ca);
      sampleColor(b, cb);
      sampleColor(c, cc);
      t.r = (uint8_t)(((int)ca[0] + cb[0] + cc[0]) / 3);
      t.g = (uint8_t)(((int)ca[1] + cb[1] + cc[1]) / 3);
      t.b = (uint8_t)(((int)ca[2] + cb[2] + cc[2]) / 3);
      tris.push_back(t);
    };

    if (prim.indices >= 0) {
      // ── Indexed geometry ───────────────────────────────────────────
      const tinygltf::Accessor &idxAcc = model.accessors[prim.indices];
      const tinygltf::BufferView &idxView =
          model.bufferViews[idxAcc.bufferView];
      const tinygltf::Buffer &idxBuf = model.buffers[idxView.buffer];

      const uint8_t *rawIdx =
          idxBuf.data.data() + idxView.byteOffset + idxAcc.byteOffset;

      auto readIdx = [&](size_t i) -> size_t {
        switch (idxAcc.componentType) {
        case TINYGLTF_COMPONENT_TYPE_UNSIGNED_BYTE: {
          return rawIdx[i];
        }
        case TINYGLTF_COMPONENT_TYPE_UNSIGNED_SHORT: {
          uint16_t v;
          std::memcpy(&v, rawIdx + i * 2, 2);
          return v;
        }
        default: { // UNSIGNED_INT
          uint32_t v;
          std::memcpy(&v, rawIdx + i * 4, 4);
          return v;
        }
        }
      };

      for (size_t i = 0; i + 2 < idxAcc.count; i += 3)
        emitTri(readIdx(i), readIdx(i + 1), readIdx(i + 2));

    } else {
      // ── Non-indexed geometry ───────────────────────────────────────
      for (size_t i = 0; i + 2 < posAcc.count; i += 3)
        emitTri(i, i + 1, i + 2);
    }
  }
}

static void walkNode(const tinygltf::Model &model, int nodeIdx,
                     const Mat4 &parentTx, std::vector<Triangle> &tris) {
  if (nodeIdx < 0 || nodeIdx >= (int)model.nodes.size())
    return;
  const tinygltf::Node &node = model.nodes[nodeIdx];

  Mat4 worldTx = mul4(parentTx, nodeMatrix(node));

  if (node.mesh >= 0)
    extractMeshPrims(model, node.mesh, worldTx, tris);

  for (int child : node.children)
    walkNode(model, child, worldTx, tris);
}

static std::vector<Triangle> parseGLTF(const std::string &data, float rotX,
                                       float rotY) {
  tinygltf::TinyGLTF loader;
  tinygltf::Model model;
  std::string err, warn;

  // GLB magic: bytes 0..3 == 'g','l','T','F'
  if (data.compare(0, 4, "glTF") != 0) {
    printf("[C++] GLB load failed: Input is not a valid binary GLB format.\n");
    return {};
  }

  if (!loader.LoadBinaryFromMemory(
          &model, &err, &warn,
          reinterpret_cast<const unsigned char *>(data.data()),
          (unsigned)data.size())) {
    printf("[C++] GLTF load failed. err=%s warn=%s\n", err.c_str(),
           warn.c_str());
    return {};
  }

  std::vector<Triangle> tris;

  // Root rotation from the UI gizmos (degrees; 0,0 gives the identity)
  float rx = rotX * M_PI / 180.0f;
  float ry = rotY * M_PI / 180.0f;

  Mat4 matX = identity4();
  matX[5]  = cos(rx);
  matX[6]  = sin(rx);
  matX[9]  = -sin(rx);
  matX[10] = cos(rx);

  Mat4 matY = identity4();
  matY[0]  = cos(ry);
  matY[2]  = -sin(ry);
  matY[8]  = sin(ry);
  matY[10] = cos(ry);

  Mat4 root = mul4(matX, matY);

  // Walk every scene (typically just one)
  for (const tinygltf::Scene &scene : model.scenes)
    for (int ni : scene.nodes)
      walkNode(model, ni, root, tris);

  // Fallback: if no scenes defined, walk all nodes
  if (tris.empty() && !model.nodes.empty())
    for (int ni = 0; ni < (int)model.nodes.size(); ++ni)
      walkNode(model, ni, root, tris);

  return tris;
}

// ────────────────────────────────────────────────────────────────────────────
//  Triangle–AABB separating-axis overlap test (Akenine-Möller 2001)
// ────────────────────────────────────────────────────────────────────────────

static bool triBoxOverlap(Vec3f boxCenter, float halfSize, Vec3f v0, Vec3f v1,
                          Vec3f v2) {
  Vec3f ta = v0 - boxCenter;
  Vec3f tb = v1 - boxCenter;
  Vec3f tc = v2 - boxCenter;

  Vec3f e0 = tb - ta, e1 = tc - tb, e2 = ta - tc;

  auto axisTest = [&](Vec3f a) -> bool {
    float r = halfSize * (std::fabs(a.x) + std::fabs(a.y) + std::fabs(a.z));
    float mn = std::min({dot(a, ta), dot(a, tb), dot(a, tc)});
    float mx = std::max({dot(a, ta), dot(a, tb), dot(a, tc)});
    return (mn > r || mx < -r);
  };

  // 9 axes: each triangle edge × each box axis.
  for (Vec3f e : {e0, e1, e2})
    for (Vec3f u : {Vec3f{1, 0, 0}, Vec3f{0, 1, 0}, Vec3f{0, 0, 1}})
      if (axisTest(cross(u, e)))
        return false;

  // 3 axes: the box face normals.
  auto inRange = [&](float a, float b, float c) {
    return !(std::min({a, b, c}) > halfSize || std::max({a, b, c}) < -halfSize);
  };
  if (!inRange(ta.x, tb.x, tc.x) || !inRange(ta.y, tb.y, tc.y) ||
      !inRange(ta.z, tb.z, tc.z))
    return false;

  // 1 axis: the triangle normal.
  Vec3f n = cross(e0, e1);
  float d = dot(n, ta);
  float r2 = halfSize * (std::fabs(n.x) + std::fabs(n.y) + std::fabs(n.z));
  return std::fabs(d) <= r2;
}

// ────────────────────────────────────────────────────────────────────────────
//  Palette  (256-entry RGBA)
// ────────────────────────────────────────────────────────────────────────────

using Palette = std::array<std::array<uint8_t, 4>, 256>;

// Produces 256 entries that cover the full RGB gamut:
//   Indices   0–215  — 6×6×6 colour cube; each channel ∈ {0,51,102,153,204,255}
//   Indices 216–255  — 40-step grayscale ramp (0..255)
// Index 0 happens to be black, which is the VOX "transparent/reserved" slot —
// the voxeliser never emits colour index 0 so this is safe.
static Palette defaultPalette() {
  Palette p{};
  int idx = 0;

  // 6×6×6 colour cube — 216 entries
  for (int r = 0; r < 6; ++r)
    for (int g = 0; g < 6; ++g)
      for (int b = 0; b < 6; ++b, ++idx)
        p[idx] = {(uint8_t)(r * 51), (uint8_t)(g * 51), (uint8_t)(b * 51), 255};

  // 40-step grayscale ramp — fills remainder to exactly 256
  for (int i = 0; i < 40; ++i, ++idx) {
    uint8_t v = (uint8_t)(i * 255 / 39);
    p[idx] = {v, v, v, 255};
  }

  return p;
}

// Accept the raw 256×4 RGBA bytes main.js builds from the uploaded .hex
// palette; anything else (i.e. empty) selects the default palette.
static Palette parsePaletteRGBA(const std::string &raw) {
  static_assert(sizeof(Palette) == 256 * 4, "Palette must be tightly packed");
  if (raw.size() != sizeof(Palette))
    return defaultPalette();
  Palette p;
  std::memcpy(p.data(), raw.data(), sizeof(Palette));
  return p;
}

// Returns the 1-based palette index (1–255) whose sRGB triple is closest to
// (r,g,b) in squared Euclidean RGB space. Index 0 is always skipped because
// the VOX format reserves it as the "empty voxel" sentinel.
static uint8_t findNearestColor(const Palette &pal, uint8_t r, uint8_t g,
                                uint8_t b) {
  int best = 1;
  int bestDist = 3 * 255 * 255 + 1; // larger than any possible distance
  for (int i = 1; i < 256; ++i) {
    int dr = (int)pal[i][0] - r;
    int dg = (int)pal[i][1] - g;
    int db = (int)pal[i][2] - b;
    int d = dr * dr + dg * dg + db * db;
    if (d < bestDist) {
      bestDist = d;
      best = i;
      if (d == 0)
        break; // exact match — no need to search further
    }
  }
  return (uint8_t)best;
}

// ────────────────────────────────────────────────────────────────────────────
//  Voxel grid
// ────────────────────────────────────────────────────────────────────────────

struct VoxGrid {
  int sx, sy, sz;
  std::vector<uint8_t> data; // [z*sy*sx + y*sx + x]

  VoxGrid(int x, int y, int z)
      : sx(x), sy(y), sz(z), data((size_t)x * y * z, 0) {}

  void set(int x, int y, int z, uint8_t col) {
    if (x < 0 || y < 0 || z < 0 || x >= sx || y >= sy || z >= sz)
      return;
    data[(size_t)z * sy * sx + y * sx + x] = col;
  }
  uint8_t get(int x, int y, int z) const {
    if (x < 0 || y < 0 || z < 0 || x >= sx || y >= sy || z >= sz)
      return 0;
    return data[(size_t)z * sy * sx + y * sx + x];
  }
};

// ────────────────────────────────────────────────────────────────────────────
//  Voxelisation
//  Each voxel takes the nearest palette index to its triangle's colour.
// ────────────────────────────────────────────────────────────────────────────

static VoxGrid voxelise(const std::vector<Triangle> &tris, int gridSize,
                        const Palette &pal) {
  if (tris.empty())
    return VoxGrid(1, 1, 1);

  // ── bounding box ─────────────────────────────────────────────────────────
  Vec3f mn{1e30f, 1e30f, 1e30f};
  Vec3f mx{-1e30f, -1e30f, -1e30f};
  for (const auto &t : tris)
    for (const auto &v : t.v) {
      mn.x = std::min(mn.x, v.x);
      mn.y = std::min(mn.y, v.y);
      mn.z = std::min(mn.z, v.z);
      mx.x = std::max(mx.x, v.x);
      mx.y = std::max(mx.y, v.y);
      mx.z = std::max(mx.z, v.z);
    }

  float span = std::max({mx.x - mn.x, mx.y - mn.y, mx.z - mn.z});
  if (span < 1e-9f)
    span = 1.0f;
  float cellSize = span / (float)gridSize;
  float invCell = 1.0f / cellSize;

  // ── allocate grid (longest axis = gridSize, others proportional) ──────────
  int gx = std::max(1, std::min(256, (int)std::ceil((mx.x - mn.x) * invCell)));
  int gy = std::max(1, std::min(256, (int)std::ceil((mx.y - mn.y) * invCell)));
  int gz = std::max(1, std::min(256, (int)std::ceil((mx.z - mn.z) * invCell)));

  VoxGrid grid(gx, gy, gz);
  float half = cellSize * 0.5f;
  int nTris = (int)tris.size();

  // Pre-compute nearest-palette index for every triangle so findNearestColor
  // is called O(N_tris) times, not O(N_voxels) times.
  std::vector<uint8_t> triColor(nTris);
  for (int ti = 0; ti < nTris; ++ti)
    triColor[ti] = findNearestColor(pal, tris[ti].r, tris[ti].g, tris[ti].b);

  for (int ti = 0; ti < nTris; ++ti) {
    const Triangle &tri = tris[ti];

    float txmn = 1e30f, tymn = 1e30f, tzmn = 1e30f;
    float txmx = -1e30f, tymx = -1e30f, tzmx = -1e30f;
    for (const auto &v : tri.v) {
      float lx = (v.x - mn.x) * invCell, ly = (v.y - mn.y) * invCell,
            lz = (v.z - mn.z) * invCell;
      txmn = std::min(txmn, lx);
      txmx = std::max(txmx, lx);
      tymn = std::min(tymn, ly);
      tymx = std::max(tymx, ly);
      tzmn = std::min(tzmn, lz);
      tzmx = std::max(tzmx, lz);
    }

    int x0 = std::max(0, (int)std::floor(txmn)),
        x1 = std::min(gx - 1, (int)std::floor(txmx));
    int y0 = std::max(0, (int)std::floor(tymn)),
        y1 = std::min(gy - 1, (int)std::floor(tymx));
    int z0 = std::max(0, (int)std::floor(tzmn)),
        z1 = std::min(gz - 1, (int)std::floor(tzmx));

    for (int zi = z0; zi <= z1; ++zi)
      for (int yi = y0; yi <= y1; ++yi)
        for (int xi = x0; xi <= x1; ++xi) {
          Vec3f centre{mn.x + (xi + 0.5f) * cellSize,
                       mn.y + (yi + 0.5f) * cellSize,
                       mn.z + (zi + 0.5f) * cellSize};
          if (triBoxOverlap(centre, half, tri.v[0], tri.v[1], tri.v[2]))
            grid.set(xi, yi, zi, triColor[ti]);
        }
  }
  return grid;
}

// ────────────────────────────────────────────────────────────────────────────
//  VOX binary serialiser
// ────────────────────────────────────────────────────────────────────────────

static void pushU32(std::vector<uint8_t> &buf, uint32_t v) {
  buf.push_back((v) & 0xFF);
  buf.push_back((v >> 8) & 0xFF);
  buf.push_back((v >> 16) & 0xFF);
  buf.push_back((v >> 24) & 0xFF);
}

static std::vector<uint8_t> encodeVox(const VoxGrid &grid, const Palette &pal) {
  std::vector<uint8_t> sizeChunk;
  pushU32(sizeChunk, (uint32_t)grid.sx);
  pushU32(sizeChunk, (uint32_t)grid.sy);
  pushU32(sizeChunk, (uint32_t)grid.sz);

  // XYZI: voxel count (patched in after the scan), then x,y,z,colour each.
  std::vector<uint8_t> xyziChunk(4);
  for (int z = 0; z < grid.sz; ++z)
    for (int y = 0; y < grid.sy; ++y)
      for (int x = 0; x < grid.sx; ++x)
        if (uint8_t c = grid.get(x, y, z))
          xyziChunk.insert(xyziChunk.end(),
                           {(uint8_t)x, (uint8_t)y, (uint8_t)z, c});
  uint32_t nVoxels = (uint32_t)(xyziChunk.size() / 4 - 1);
  for (int i = 0; i < 4; ++i)
    xyziChunk[i] = (uint8_t)(nVoxels >> (8 * i)); // little-endian, as pushU32

  // RGBA: entry i holds colour index i+1 (index 0 is the empty voxel), so the
  // palette is stored rotated left by one.
  std::vector<uint8_t> rgbaChunk(1024);
  for (int i = 0; i < 256; ++i)
    std::memcpy(&rgbaChunk[i * 4], pal[(i + 1) & 255].data(), 4);

  auto writeChunk = [](std::vector<uint8_t> &dst, const char id[4],
                       const std::vector<uint8_t> &content,
                       uint32_t childBytes = 0) {
    dst.insert(dst.end(), id, id + 4);
    pushU32(dst, (uint32_t)content.size());
    pushU32(dst, childBytes);
    dst.insert(dst.end(), content.begin(), content.end());
  };

  std::vector<uint8_t> mainChildren;
  writeChunk(mainChildren, "SIZE", sizeChunk);
  writeChunk(mainChildren, "XYZI", xyziChunk);
  writeChunk(mainChildren, "RGBA", rgbaChunk);

  std::vector<uint8_t> out;
  out.reserve(12 + 12 + mainChildren.size());
  out.insert(out.end(), {'V', 'O', 'X', ' '});
  pushU32(out, 150);
  writeChunk(out, "MAIN", {}, (uint32_t)mainChildren.size());
  out.insert(out.end(), mainChildren.begin(), mainChildren.end());

  return out;
}

// ────────────────────────────────────────────────────────────────────────────
//  Public Embind entry point
// ────────────────────────────────────────────────────────────────────────────

// Persistent output buffer — keeps the typed_memory_view alive until the next
// call (JS worker.js calls .slice() on the result immediately after returning).
static std::vector<uint8_t> g_result;

/**
 * convertGLBToVox
 *
 * @param glb         Raw .glb bytes (embind copies an ArrayBuffer/Uint8Array
 *                    into the std::string)
 * @param palRGBA     Flat 256×4 RGBA bytes (empty = use default palette)
 * @param gridSize    Voxel resolution along the longest axis (1–256)
 * @param rotX, rotY  Root rotation in degrees
 * @return            MagicaVoxel .vox binary as a typed_memory_view
 * (Uint8Array)
 */
static val convertGLBToVox(const std::string &glb, const std::string &palRGBA,
                           int gridSize, float rotX, float rotY) {
  gridSize = std::max(1, std::min(256, gridSize));

  auto pal = parsePaletteRGBA(palRGBA);
  auto grid = voxelise(parseGLTF(glb, rotX, rotY), gridSize, pal);
  g_result = encodeVox(grid, pal);

  return val(typed_memory_view(g_result.size(), g_result.data()));
}

// ────────────────────────────────────────────────────────────────────────────
//  Emscripten bindings
// ────────────────────────────────────────────────────────────────────────────

EMSCRIPTEN_BINDINGS(voxelizer_module) {
  function("convertGLBToVox", &convertGLBToVox);
}

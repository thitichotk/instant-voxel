/**
 * voxelizer.cpp
 *
 * Instant-Voxel's voxel kernel, exposed to JS via Emscripten Embind. three.js parses
 * the model files and flattens them into one triangle mesh (web/loaders.js);
 * this file turns that mesh into a palette-indexed voxel grid.
 *
 * Public API:
 *
 *   voxelize(mesh, opts, onProgress) → { sx, sy, sz, data, palette, origin, cell, count }
 *     mesh: { positions: Float32Array (xyz), indices: Uint32Array,
 *             uvs?: Float32Array (uv, texture transform + flipY baked in),
 *             colors?: Float32Array (linear RGBA per vertex),
 *             triMaterial?: Uint16Array, materials?: Float32Array (6 per material:
 *             linear r, g, b, a, alpha cutoff, texture index or -1),
 *             textures?: [{ width, height, data: Uint8Array (sRGB RGBA) }] }
 *     opts: { size, axis (-1 longest, 0 x, 1 y, 2 z), solid, hollow, minIsland,
 *             colors (auto palette size), dither, palette? (Uint8Array 256×4) }
 *
 *   quantize(rgba, opts) → { indices, palette }
 *     rgba: Uint8Array (n × RGBA); alpha < 128 maps to 0 (empty).
 *     opts: { colors, palette? }
 *
 * Grid layout (Y-up, like glTF / three.js): data[x + sx * (y + sy * z)],
 * 0 = empty, i = palette entry i (palette is 256 × RGBA, entry 0 unused).
 * The returned typed arrays are views into Wasm memory, valid until the next
 * call; the caller copies them (worker.js).
 */

#include <emscripten/bind.h> // also brings in val.h

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <deque>
#include <numeric>
#include <vector>

using namespace emscripten;

static constexpr int MAX_DIM = 512;

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

// Squared distance from p to triangle abc; u, v are the barycentric weights of
// b and c at the closest point (Ericson, Real-Time Collision Detection 5.1.5).
static float closestOnTri(Vec3f p, Vec3f a, Vec3f b, Vec3f c, float &u,
                          float &v) {
  auto d2 = [&](Vec3f q) { return dot(p - q, p - q); };
  Vec3f ab = b - a, ac = c - a, ap = p - a;
  float d1 = dot(ab, ap), d2v = dot(ac, ap);
  if (d1 <= 0 && d2v <= 0) { u = 0; v = 0; return d2(a); }
  Vec3f bp = p - b;
  float d3 = dot(ab, bp), d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) { u = 1; v = 0; return d2(b); }
  float vc = d1 * d4 - d3 * d2v;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    u = d1 / (d1 - d3); v = 0;
    return d2(a + ab * u);
  }
  Vec3f cp = p - c;
  float d5 = dot(ab, cp), d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) { u = 0; v = 1; return d2(c); }
  float vb = d5 * d2v - d1 * d6;
  if (vb <= 0 && d2v >= 0 && d6 <= 0) {
    u = 0; v = d2v / (d2v - d6);
    return d2(a + ac * v);
  }
  float va = d3 * d6 - d5 * d4;
  if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) {
    v = (d4 - d3) / ((d4 - d3) + (d5 - d6)); u = 1 - v;
    return d2(b + (c - b) * v);
  }
  float denom = 1 / (va + vb + vc);
  u = vb * denom; v = vc * denom;
  return d2(a + ab * u + ac * v);
}

// ────────────────────────────────────────────────────────────────────────────
//  Colour: sRGB ↔ linear ↔ Oklab (Björn Ottosson)
// ────────────────────────────────────────────────────────────────────────────

struct Lab { float L, a, b; };

static float srgbToLinear(float c) {
  return c <= 0.04045f ? c / 12.92f : std::pow((c + 0.055f) / 1.055f, 2.4f);
}
static uint8_t linearToSrgb8(float c) {
  c = std::min(1.f, std::max(0.f, c));
  c = c <= 0.0031308f ? c * 12.92f : 1.055f * std::pow(c, 1 / 2.4f) - 0.055f;
  return (uint8_t)(c * 255 + 0.5f);
}

static const std::array<float, 256> &linLUT() {
  static std::array<float, 256> lut = [] {
    std::array<float, 256> t;
    for (int i = 0; i < 256; ++i) t[i] = srgbToLinear(i / 255.f);
    return t;
  }();
  return lut;
}

static Lab toOklab(float r, float g, float b) { // linear RGB in
  float l = std::cbrt(0.4122214708f * r + 0.5363325363f * g + 0.0514459929f * b);
  float m = std::cbrt(0.2119034982f * r + 0.6806995451f * g + 0.1073969566f * b);
  float s = std::cbrt(0.0883024619f * r + 0.2817188376f * g + 0.6299787005f * b);
  return {0.2104542553f * l + 0.7936177850f * m - 0.0040720468f * s,
          1.9779984951f * l - 2.4285922050f * m + 0.4505937099f * s,
          0.0259040371f * l + 0.7827717662f * m - 0.8086757660f * s};
}
static Lab toOklab8(uint8_t r, uint8_t g, uint8_t b) {
  const auto &lin = linLUT();
  return toOklab(lin[r], lin[g], lin[b]);
}
static void fromOklab(Lab c, float &r, float &g, float &b) { // linear RGB out
  float l = c.L + 0.3963377774f * c.a + 0.2158037573f * c.b;
  float m = c.L - 0.1055613458f * c.a - 0.0638541728f * c.b;
  float s = c.L - 0.0894841775f * c.a - 1.2914855480f * c.b;
  l = l * l * l; m = m * m * m; s = s * s * s;
  r = +4.0767416621f * l - 3.3077115913f * m + 0.2309699292f * s;
  g = -1.2684380046f * l + 2.6097574011f * m - 0.3413193965f * s;
  b = -0.0041960863f * l - 0.7034186147f * m + 1.7076147010f * s;
}

// ────────────────────────────────────────────────────────────────────────────
//  Palette  (256-entry RGBA; entry 0 unused, the empty voxel)
// ────────────────────────────────────────────────────────────────────────────

using Palette = std::array<std::array<uint8_t, 4>, 256>;
static_assert(sizeof(Palette) == 256 * 4, "Palette must be tightly packed");

// Colours are bucketed to 5 bits per channel: the histogram key and the
// nearest-colour cache key. Bucket means keep flat colours exact.
static inline int key15(uint8_t r, uint8_t g, uint8_t b) {
  return (r >> 3) << 10 | (g >> 3) << 5 | (b >> 3);
}

struct Histogram {
  std::vector<uint32_t> n, r, g, b; // count and sRGB sums per 15-bit bucket
  Histogram() : n(32768), r(32768), g(32768), b(32768) {}
  void add(uint8_t cr, uint8_t cg, uint8_t cb) {
    int k = key15(cr, cg, cb);
    n[k]++; r[k] += cr; g[k] += cg; b[k] += cb;
  }
};

// Median cut in Oklab: repeatedly split the box with the largest weighted
// squared error at the weighted median of its widest axis. Fills entries
// 1..k of pal and returns k (≤ nColors).
static int medianCut(const Histogram &h, int nColors, Palette &pal) {
  struct Entry { float c[3]; float w; };
  std::vector<Entry> e;
  for (int k = 0; k < 32768; ++k)
    if (h.n[k]) {
      float w = (float)h.n[k];
      Lab c = toOklab8(h.r[k] / h.n[k], h.g[k] / h.n[k], h.b[k] / h.n[k]);
      e.push_back({{c.L, c.a, c.b}, w});
    }
  if (e.empty()) return 0;

  struct Box { int lo, hi; float sse; int axis; float mean[3]; };
  std::vector<int> ord(e.size());
  std::iota(ord.begin(), ord.end(), 0);
  auto stats = [&](Box &bx) {
    double w = 0, s[3] = {0, 0, 0}, q[3] = {0, 0, 0};
    for (int i = bx.lo; i < bx.hi; ++i) {
      const Entry &x = e[ord[i]];
      w += x.w;
      for (int a = 0; a < 3; ++a) { s[a] += x.w * x.c[a]; q[a] += x.w * x.c[a] * x.c[a]; }
    }
    double best = -1;
    bx.sse = 0;
    for (int a = 0; a < 3; ++a) {
      double mean = s[a] / w, var = q[a] - w * mean * mean;
      bx.mean[a] = (float)mean;
      bx.sse += (float)var;
      if (var > best) { best = var; bx.axis = a; }
    }
  };

  std::vector<Box> boxes{{0, (int)e.size(), 0, 0, {0, 0, 0}}};
  stats(boxes[0]);
  while ((int)boxes.size() < nColors) {
    int pick = -1;
    for (int i = 0; i < (int)boxes.size(); ++i)
      if (boxes[i].hi - boxes[i].lo > 1 && (pick < 0 || boxes[i].sse > boxes[pick].sse))
        pick = i;
    if (pick < 0) break;
    Box bx = boxes[pick];
    int ax = bx.axis;
    std::sort(ord.begin() + bx.lo, ord.begin() + bx.hi,
              [&](int a, int b) { return e[a].c[ax] < e[b].c[ax]; });
    double total = 0, acc = 0;
    for (int i = bx.lo; i < bx.hi; ++i) total += e[ord[i]].w;
    int mid = bx.lo + 1;
    for (int i = bx.lo; i < bx.hi; ++i) {
      acc += e[ord[i]].w;
      if (acc >= total / 2) { mid = i + 1; break; }
    }
    mid = std::min(std::max(mid, bx.lo + 1), bx.hi - 1);
    Box a{bx.lo, mid, 0, 0, {0, 0, 0}}, b{mid, bx.hi, 0, 0, {0, 0, 0}};
    stats(a);
    stats(b);
    boxes[pick] = a;
    boxes.push_back(b);
  }

  for (int i = 0; i < (int)boxes.size(); ++i) {
    float r, g, b;
    fromOklab({boxes[i].mean[0], boxes[i].mean[1], boxes[i].mean[2]}, r, g, b);
    pal[i + 1] = {linearToSrgb8(r), linearToSrgb8(g), linearToSrgb8(b), 255};
  }
  return (int)boxes.size();
}

// Maps colours to the nearest of palette entries 1..n (Oklab distance),
// cached per 15-bit colour bucket. Entries with alpha 0 are never chosen
// (a sparse fixed palette, e.g. Minecraft blocks, leaves them empty).
struct ColorMapper {
  std::vector<Lab> lab;
  std::vector<bool> usable;
  int n;
  std::vector<uint8_t> cache = std::vector<uint8_t>(32768, 0);
  ColorMapper(const Palette &pal, int n) : lab(n + 1), usable(n + 1), n(n) {
    bool any = false;
    for (int i = 1; i <= n; ++i) {
      lab[i] = toOklab8(pal[i][0], pal[i][1], pal[i][2]);
      any |= usable[i] = pal[i][3] > 0;
    }
    if (!any) usable.assign(n + 1, true);
  }
  uint8_t map(uint8_t r, uint8_t g, uint8_t b) {
    int k = key15(r, g, b);
    if (!cache[k]) {
      Lab c = toOklab8((k >> 10) * 8 + 4, ((k >> 5) & 31) * 8 + 4, (k & 31) * 8 + 4);
      float best = 1e30f;
      for (int i = 1; i <= n; ++i) {
        if (!usable[i]) continue;
        float dL = lab[i].L - c.L, da = lab[i].a - c.a, db = lab[i].b - c.b;
        float d = dL * dL + da * da + db * db;
        if (d < best) { best = d; cache[k] = (uint8_t)i; }
      }
    }
    return cache[k];
  }
};

// Palette from opts: a fixed 256×4 palette (entries 1..255) or median cut
// over the histogram. Returns the number of usable entries.
static int choosePalette(val opts, const Histogram &h, Palette &pal) {
  pal = {};
  val fixed = opts["palette"];
  if (!fixed.isUndefined() && !fixed.isNull()) {
    auto bytes = convertJSArrayToNumberVector<uint8_t>(fixed);
    if (bytes.size() == sizeof(Palette)) {
      std::memcpy(pal.data(), bytes.data(), sizeof(Palette));
      return 255;
    }
  }
  val c = opts["colors"];
  int nColors = c.isUndefined() ? 255 : std::min(255, std::max(1, c.as<int>()));
  return medianCut(h, nColors, pal);
}

// ────────────────────────────────────────────────────────────────────────────
//  Mesh input
// ────────────────────────────────────────────────────────────────────────────

struct Material { float r, g, b, a, cutoff; int tex; };
struct Texture { int w, h; std::vector<uint8_t> px; };

struct Mesh {
  std::vector<float> pos, uv, col;
  std::vector<uint32_t> idx;
  std::vector<uint16_t> triMat;
  std::vector<Material> mats;
  std::vector<Texture> texs;
};

template <typename T> static std::vector<T> vecOf(val v) {
  return v.isUndefined() || v.isNull() ? std::vector<T>{}
                                       : convertJSArrayToNumberVector<T>(v);
}

static int optInt(val o, const char *k, int def) {
  val v = o[k];
  return v.isUndefined() || v.isNull() ? def : v.as<int>();
}

static Mesh readMesh(val jm) {
  Mesh m;
  m.pos = vecOf<float>(jm["positions"]);
  m.idx = vecOf<uint32_t>(jm["indices"]);
  m.uv = vecOf<float>(jm["uvs"]);
  m.col = vecOf<float>(jm["colors"]);
  m.triMat = vecOf<uint16_t>(jm["triMaterial"]);
  auto mf = vecOf<float>(jm["materials"]);
  for (size_t i = 0; i + 5 < mf.size(); i += 6)
    m.mats.push_back({mf[i], mf[i + 1], mf[i + 2], mf[i + 3], mf[i + 4], (int)mf[i + 5]});
  if (m.mats.empty()) m.mats.push_back({1, 1, 1, 1, 0, -1});
  val tx = jm["textures"];
  int nt = tx.isUndefined() ? 0 : tx["length"].as<int>();
  for (int i = 0; i < nt; ++i)
    m.texs.push_back({tx[i]["width"].as<int>(), tx[i]["height"].as<int>(),
                      vecOf<uint8_t>(tx[i]["data"])});
  return m;
}

// Colour of triangle t at barycentric (u, v): base × texture × vertex colour in
// linear light. Returns false when the alpha is under the material's cutoff.
static bool sampleColor(const Mesh &m, uint32_t t, float u, float v, uint8_t out[3]) {
  const auto &lin = linLUT();
  uint32_t i0 = m.idx[3 * t], i1 = m.idx[3 * t + 1], i2 = m.idx[3 * t + 2];
  float w0 = 1 - u - v;
  int mi = m.triMat.empty() ? 0 : m.triMat[t];
  const Material &mat = m.mats[mi < (int)m.mats.size() ? mi : 0];
  float r = mat.r, g = mat.g, b = mat.b, a = mat.a;
  if (mat.tex >= 0 && mat.tex < (int)m.texs.size() && !m.uv.empty()) {
    const Texture &tx = m.texs[mat.tex];
    float tu = w0 * m.uv[2 * i0] + u * m.uv[2 * i1] + v * m.uv[2 * i2];
    float tv = w0 * m.uv[2 * i0 + 1] + u * m.uv[2 * i1 + 1] + v * m.uv[2 * i2 + 1];
    tu -= std::floor(tu);
    tv -= std::floor(tv);
    if (!std::isfinite(tu) || !std::isfinite(tv)) tu = tv = 0;
    int px = std::min(tx.w - 1, (int)(tu * tx.w));
    int py = std::min(tx.h - 1, (int)(tv * tx.h));
    const uint8_t *p = &tx.px[4 * ((size_t)py * tx.w + px)];
    r *= lin[p[0]]; g *= lin[p[1]]; b *= lin[p[2]]; a *= p[3] / 255.f;
  }
  if (!m.col.empty()) {
    const float *c0 = &m.col[4 * i0], *c1 = &m.col[4 * i1], *c2 = &m.col[4 * i2];
    r *= w0 * c0[0] + u * c1[0] + v * c2[0];
    g *= w0 * c0[1] + u * c1[1] + v * c2[1];
    b *= w0 * c0[2] + u * c1[2] + v * c2[2];
    a *= w0 * c0[3] + u * c1[3] + v * c2[3];
  }
  if (a < mat.cutoff) return false;
  out[0] = linearToSrgb8(r);
  out[1] = linearToSrgb8(g);
  out[2] = linearToSrgb8(b);
  return true;
}

// ────────────────────────────────────────────────────────────────────────────
//  Grid post-processing
// ────────────────────────────────────────────────────────────────────────────

struct Dims {
  int sx, sy, sz;
  size_t n() const { return (size_t)sx * sy * sz; }
};

// Calls f(neighbour index) for each in-grid 6-neighbour of cell i.
template <typename F> static void forNeighbours(const Dims &d, size_t i, F f) {
  int x = i % d.sx, y = (i / d.sx) % d.sy, z = i / ((size_t)d.sx * d.sy);
  size_t sxy = (size_t)d.sx * d.sy;
  if (x > 0) f(i - 1);
  if (x < d.sx - 1) f(i + 1);
  if (y > 0) f(i - d.sx);
  if (y < d.sy - 1) f(i + d.sx);
  if (z > 0) f(i - sxy);
  if (z < d.sz - 1) f(i + sxy);
}

static bool onBorder(const Dims &d, size_t i) {
  int x = i % d.sx, y = (i / d.sx) % d.sy, z = i / ((size_t)d.sx * d.sy);
  return x == 0 || y == 0 || z == 0 || x == d.sx - 1 || y == d.sy - 1 || z == d.sz - 1;
}

// Empty cells reachable from outside the grid through empty cells.
static std::vector<bool> floodOutside(const Dims &d, const std::vector<uint8_t> &g) {
  std::vector<bool> out(d.n());
  std::deque<size_t> q;
  for (size_t i = 0; i < d.n(); ++i)
    if (!g[i] && onBorder(d, i)) { out[i] = true; q.push_back(i); }
  while (!q.empty()) {
    size_t i = q.front();
    q.pop_front();
    forNeighbours(d, i, [&](size_t j) {
      if (!g[j] && !out[j]) { out[j] = true; q.push_back(j); }
    });
  }
  return out;
}

// Solid fill: every empty cell not reachable from outside is interior and
// copies the colour of the previous voxel along its x row (always set: the
// cell before an interior cell is either a voxel or interior itself).
static void fillInterior(const Dims &d, std::vector<uint8_t> &g,
                         const std::vector<bool> &outside) {
  for (size_t row = 0; row < (size_t)d.sy * d.sz; ++row) {
    uint8_t last = 0;
    for (int x = 0; x < d.sx; ++x) {
      size_t i = row * d.sx + x;
      if (g[i]) last = g[i];
      else if (!outside[i]) g[i] = last;
    }
  }
}

// Keeps voxels within k steps of the outside (air reachable from outside, or
// the grid border); clears the rest.
static void hollow(const Dims &d, std::vector<uint8_t> &g,
                   const std::vector<bool> &outside, int k) {
  std::vector<bool> keep(d.n());
  std::vector<size_t> frontier, next;
  for (size_t i = 0; i < d.n(); ++i) {
    if (!g[i]) continue;
    bool exposed = onBorder(d, i);
    forNeighbours(d, i, [&](size_t j) { exposed |= !g[j] && outside[j]; });
    if (exposed) { keep[i] = true; frontier.push_back(i); }
  }
  for (int depth = 1; depth < k; ++depth) {
    next.clear();
    for (size_t i : frontier)
      forNeighbours(d, i, [&](size_t j) {
        if (g[j] && !keep[j]) { keep[j] = true; next.push_back(j); }
      });
    frontier.swap(next);
  }
  for (size_t i = 0; i < d.n(); ++i)
    if (!keep[i]) g[i] = 0;
}

// Clears 6-connected components with fewer than minSize voxels.
static void removeIslands(const Dims &d, std::vector<uint8_t> &g, int minSize) {
  std::vector<bool> seen(d.n());
  std::vector<size_t> comp;
  std::deque<size_t> q;
  for (size_t s = 0; s < d.n(); ++s) {
    if (!g[s] || seen[s]) continue;
    comp.clear();
    seen[s] = true;
    q.push_back(s);
    while (!q.empty()) {
      size_t i = q.front();
      q.pop_front();
      comp.push_back(i);
      forNeighbours(d, i, [&](size_t j) {
        if (g[j] && !seen[j]) { seen[j] = true; q.push_back(j); }
      });
    }
    if ((int)comp.size() < minSize)
      for (size_t i : comp) g[i] = 0;
  }
}

// ────────────────────────────────────────────────────────────────────────────
//  Public Embind entry points
// ────────────────────────────────────────────────────────────────────────────

// Persistent output buffers — the returned typed_memory_views stay valid
// until the next call (worker.js copies them immediately).
static std::vector<uint8_t> g_out;
static Palette g_pal;

static val paletteView() {
  return val(typed_memory_view(sizeof(Palette), g_pal[0].data()));
}

static val voxelize(val jsMesh, val opts, val onProgress) {
  Mesh m = readMesh(jsMesh);
  auto progress = [&](double p) {
    if (!onProgress.isUndefined()) onProgress(p);
  };

  const size_t nv = m.pos.size() / 3, nt = m.idx.size() / 3;
  Vec3f mn{1e30f, 1e30f, 1e30f}, mx{-1e30f, -1e30f, -1e30f};
  for (size_t i = 0; i < nv; ++i) {
    Vec3f p{m.pos[3 * i], m.pos[3 * i + 1], m.pos[3 * i + 2]};
    mn = {std::min(mn.x, p.x), std::min(mn.y, p.y), std::min(mn.z, p.z)};
    mx = {std::max(mx.x, p.x), std::max(mx.y, p.y), std::max(mx.z, p.z)};
  }
  if (nt == 0 || nv == 0) mn = mx = {0, 0, 0};

  // ── grid size: `size` voxels along the chosen axis, ≤ MAX_DIM on every axis
  const float ext[3] = {mx.x - mn.x, mx.y - mn.y, mx.z - mn.z};
  const float longest = std::max({ext[0], ext[1], ext[2], 1e-9f});
  const int axis = optInt(opts, "axis", -1);
  const int size = std::min(MAX_DIM, std::max(1, optInt(opts, "size", 64)));
  float span = axis >= 0 && axis < 3 && ext[axis] > 1e-9f ? ext[axis] : longest;
  float cell = std::max(span / size, longest / MAX_DIM);
  const float inv = 1 / cell;
  Dims d{std::max(1, std::min(MAX_DIM, (int)std::ceil(ext[0] * inv))),
         std::max(1, std::min(MAX_DIM, (int)std::ceil(ext[1] * inv))),
         std::max(1, std::min(MAX_DIM, (int)std::ceil(ext[2] * inv)))};

  // Vertices in grid space (one unit per voxel).
  std::vector<Vec3f> gp(nv);
  for (size_t i = 0; i < nv; ++i)
    gp[i] = Vec3f{m.pos[3 * i] - mn.x, m.pos[3 * i + 1] - mn.y, m.pos[3 * i + 2] - mn.z} * inv;
  auto cellOf = [](float c, int n) { return std::min(n - 1, std::max(0, (int)std::floor(c))); };

  // ── surface voxels, one z layer at a time: every triangle overlapping a
  //    voxel competes, the one closest to the voxel centre sets its colour.
  std::vector<std::vector<uint32_t>> layers(d.sz);
  for (uint32_t t = 0; t < nt; ++t) {
    if (std::max({m.idx[3 * t], m.idx[3 * t + 1], m.idx[3 * t + 2]}) >= nv) continue;
    const Vec3f &a = gp[m.idx[3 * t]], &b = gp[m.idx[3 * t + 1]], &c = gp[m.idx[3 * t + 2]];
    // Skip non-finite and zero-area triangles (their barycentrics are NaN).
    Vec3f n = cross(b - a, c - a);
    if (!(dot(n, n) > 1e-12f) || !std::isfinite(a.x + a.y + a.z + b.x + b.y + b.z + c.x + c.y + c.z))
      continue;
    int z0 = cellOf(std::min({a.z, b.z, c.z}), d.sz), z1 = cellOf(std::max({a.z, b.z, c.z}), d.sz);
    for (int z = z0; z <= z1; ++z) layers[z].push_back(t);
  }

  struct Surface { uint32_t i; uint8_t r, g, b; };
  std::vector<Surface> surface;
  Histogram hist;
  const size_t layerN = (size_t)d.sx * d.sy;
  std::vector<float> bestD(layerN), bestU(layerN), bestV(layerN);
  std::vector<int64_t> bestT(layerN);
  for (int z = 0; z < d.sz; ++z) {
    std::fill(bestD.begin(), bestD.end(), 1e30f);
    std::fill(bestT.begin(), bestT.end(), -1);
    for (uint32_t t : layers[z]) {
      const Vec3f &a = gp[m.idx[3 * t]], &b = gp[m.idx[3 * t + 1]], &c = gp[m.idx[3 * t + 2]];
      int x0 = cellOf(std::min({a.x, b.x, c.x}), d.sx), x1 = cellOf(std::max({a.x, b.x, c.x}), d.sx);
      int y0 = cellOf(std::min({a.y, b.y, c.y}), d.sy), y1 = cellOf(std::max({a.y, b.y, c.y}), d.sy);
      for (int y = y0; y <= y1; ++y)
        for (int x = x0; x <= x1; ++x) {
          Vec3f centre{x + 0.5f, y + 0.5f, z + 0.5f};
          if (!triBoxOverlap(centre, 0.5f, a, b, c)) continue;
          float u, v, dist = closestOnTri(centre, a, b, c, u, v);
          size_t li = (size_t)y * d.sx + x;
          if (dist < bestD[li]) { bestD[li] = dist; bestT[li] = t; bestU[li] = u; bestV[li] = v; }
        }
    }
    for (size_t li = 0; li < layerN; ++li) {
      uint8_t rgb[3];
      if (bestT[li] < 0 || !sampleColor(m, (uint32_t)bestT[li], bestU[li], bestV[li], rgb)) continue;
      surface.push_back({(uint32_t)(li + (size_t)z * layerN), rgb[0], rgb[1], rgb[2]});
      hist.add(rgb[0], rgb[1], rgb[2]);
    }
    std::vector<uint32_t>().swap(layers[z]);
    if (z % std::max(1, d.sz / 100) == 0) progress(0.8 * (z + 1) / d.sz);
  }

  // ── colour: palette, then nearest entry with optional ordered dither
  int nPal = choosePalette(opts, hist, g_pal);
  ColorMapper mapper(g_pal, std::max(1, nPal));
  const bool dither = !opts["dither"].isUndefined() && opts["dither"].as<bool>();
  static const int bayer[4][4] = {{0, 8, 2, 10}, {12, 4, 14, 6}, {3, 11, 1, 9}, {15, 7, 13, 5}};
  const float spread = std::max(8.f, 255.f / std::cbrt((float)std::max(1, nPal)));
  g_out.assign(d.n(), 0);
  for (const Surface &s : surface) {
    uint8_t r = s.r, g = s.g, b = s.b;
    if (dither) {
      int x = s.i % d.sx, y = (s.i / d.sx) % d.sy, z = s.i / layerN;
      float off = ((bayer[(x + 2 * z) & 3][(y + 3 * z) & 3] + 0.5f) / 16 - 0.5f) * spread;
      auto adj = [&](uint8_t c) { return (uint8_t)std::min(255.f, std::max(0.f, c + off)); };
      r = adj(r); g = adj(g); b = adj(b);
    }
    g_out[s.i] = nPal ? mapper.map(r, g, b) : 1;
  }
  std::vector<Surface>().swap(surface);
  progress(0.9);

  // ── post: solid fill, hollow, islands
  if (!opts["solid"].isUndefined() && opts["solid"].as<bool>()) {
    auto outside = floodOutside(d, g_out);
    fillInterior(d, g_out, outside);
    int k = optInt(opts, "hollow", 0);
    if (k > 0) hollow(d, g_out, outside, k);
  }
  int minIsland = optInt(opts, "minIsland", 0);
  if (minIsland > 1) removeIslands(d, g_out, minIsland);
  progress(1);

  size_t count = 0;
  for (uint8_t c : g_out) count += c != 0;

  val origin = val::array();
  origin.call<void>("push", mn.x, mn.y, mn.z);
  val out = val::object();
  out.set("sx", d.sx);
  out.set("sy", d.sy);
  out.set("sz", d.sz);
  out.set("data", val(typed_memory_view(g_out.size(), g_out.data())));
  out.set("palette", paletteView());
  out.set("origin", origin);
  out.set("cell", cell);
  out.set("count", (double)count);
  return out;
}

static val quantize(val jsRGBA, val opts) {
  auto px = vecOf<uint8_t>(jsRGBA);
  size_t n = px.size() / 4;
  Histogram hist;
  for (size_t i = 0; i < n; ++i)
    if (px[4 * i + 3] >= 128) hist.add(px[4 * i], px[4 * i + 1], px[4 * i + 2]);
  int nPal = choosePalette(opts, hist, g_pal);
  ColorMapper mapper(g_pal, std::max(1, nPal));
  g_out.assign(n, 0);
  for (size_t i = 0; i < n; ++i)
    if (px[4 * i + 3] >= 128)
      g_out[i] = nPal ? mapper.map(px[4 * i], px[4 * i + 1], px[4 * i + 2]) : 1;
  val out = val::object();
  out.set("indices", val(typed_memory_view(g_out.size(), g_out.data())));
  out.set("palette", paletteView());
  return out;
}

EMSCRIPTEN_BINDINGS(voxelizer_module) {
  function("voxelize", &voxelize);
  function("quantize", &quantize);
}

// Dust to Dust — texture sampling.
//
// When a dissolve starts we read the token's displayed texture once into an
// offscreen 2D canvas, then build the dissolve point cloud: every sufficiently
// opaque pixel becomes a dust candidate carrying
//   x, y     — token-local position in world pixels,
//   lum      — perceived brightness (drives particle size variance),
// and each call turns that cloud into sweep-ordered typed arrays matching the
// dissolve filter's fragment shader (same uv math, same vanish order). Points
// are relative to the token's displayed box (top-left origin), which respects
// texture scaling.
//
// Robustness: pixel extraction is best-effort across Pixi versions. If the
// texture cannot be read we fall back to a jittered elliptical disc of points
// covering the token footprint, so the effect always plays.

import { debugLog } from "./settings.js";

/** Max sample grid cells on the token's long side (density cap + perf). */
const SAMPLE_MAX_DIM = 48;
/** Alpha (0-255) above which a pixel counts as solid. */
const ALPHA_THRESHOLD = 32;
/** Hard cap on raw sampled points before thinning (huge tokens). */
const RAW_LIMIT = 6000;
/** Cache of raw samples (LRU). */
const CACHE_LIMIT = 24;

const cache = new Map(); // cacheKey -> { xs, ys, lum, count }

/** Deterministic per-index pseudo-random in [0, 1) — stable thinning. */
function pseudoRandom(i) {
  const x = Math.sin(i * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

/** Stable cache key: texture identity + displayed box size (invalidates on resize). */
function cacheKeyFor(boxW, boxH, texture) {
  try {
    const base = texture.baseTexture ?? texture.source;
    const id =
      base?.resource?.url ??
      base?.label ??
      texture?.textureCacheIds?.[0] ??
      base?.uuid ??
      texture?.label ??
      null;
    if (!id) return null;
    return `${id}|${Math.round(boxW)}x${Math.round(boxH)}`;
  } catch (err) {
    return null;
  }
}

function cacheGet(key) {
  if (!key || !cache.has(key)) return null;
  const value = cache.get(key);
  cache.delete(key);
  cache.set(key, value); // refresh LRU position
  return value;
}

function cachePut(key, value) {
  if (!key) return;
  cache.set(key, value);
  if (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
  }
}

/**
 * Get the texture's pixels as a 2D canvas.
 * Strategy 1: renderer extract (sync in Pixi 7; some versions return a promise).
 * Strategy 2: draw the base texture resource directly, honoring the frame.
 * Returns null when neither works.
 */
async function textureToCanvas(texture) {
  // Strategy 1: renderer extract. Pixi 7.4's extract.canvas only accepts
  // DisplayObjects/RenderTextures — a plain Texture throws — so wrap it in a
  // throwaway sprite (the shared texture is not destroyed with it).
  try {
    const renderer = canvas?.app?.renderer ?? canvas?.renderer;
    if (renderer?.extract && texture) {
      let out = null;
      try {
        out = renderer.extract.canvas(texture);
      } catch (err) {
        const PIXI = globalThis.PIXI;
        if (PIXI?.Sprite) {
          const sprite = new PIXI.Sprite(texture);
          out = renderer.extract.canvas(sprite);
          sprite.destroy({ texture: false, baseTexture: false, children: true });
        } else {
          throw err;
        }
      }
      if (out && typeof out.then === "function") out = await out;
      if (out && out.width > 0 && out.height > 0) return out;
    }
  } catch (err) {
    debugLog("extract.canvas unavailable:", err?.message ?? err);
  }
  // Strategy 2: draw the underlying resource.
  try {
    const base = texture.baseTexture ?? texture.source;
    const resource = base?.resource;
    const src = resource?.data ?? resource?.canvas ?? resource?.source ?? null;
    if (src) {
      const frame = texture.frame ?? texture.textureFrame;
      const w = Math.max(1, Math.round(frame?.width ?? base?.width ?? 1));
      const h = Math.max(1, Math.round(frame?.height ?? base?.height ?? 1));
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      const ctx = c.getContext("2d");
      ctx.drawImage(src, Math.max(0, frame?.x ?? 0), Math.max(0, frame?.y ?? 0), w, h, 0, 0, w, h);
      return c;
    }
  } catch (err) {
    debugLog("resource draw unavailable:", err?.message ?? err);
  }
  return null;
}

/** Downsample a source canvas and return its ImageData. */
function readPixels(srcCanvas, sw, sh) {
  const c = document.createElement("canvas");
  c.width = sw;
  c.height = sh;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(srcCanvas, 0, 0, sw, sh);
  return ctx.getImageData(0, 0, sw, sh);
}

/** Sample the texture pixels into a raw point cloud in displayed-box pixels. */
function samplePixels(boxW, boxH, srcCanvas) {
  const scale = Math.min(1, SAMPLE_MAX_DIM / Math.max(boxW, boxH));
  const sw = Math.max(2, Math.round(boxW * scale));
  const sh = Math.max(2, Math.round(boxH * scale));
  const data = readPixels(srcCanvas, sw, sh).data;

  const xs = [];
  const ys = [];
  const lum = [];
  for (let py = 0; py < sh; py++) {
    for (let px = 0; px < sw; px++) {
      const i = (py * sw + px) * 4;
      const a = data[i + 3];
      if (a <= ALPHA_THRESHOLD) continue;
      xs.push(((px + 0.5) / sw) * boxW);
      ys.push(((py + 0.5) / sh) * boxH);
      const brightness = (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255;
      lum.push(brightness * (a / 255));
    }
  }

  // Thin absurdly dense samples (giant tokens) before any further work.
  if (xs.length > RAW_LIMIT) {
    const keep = RAW_LIMIT / xs.length;
    const fx = [];
    const fy = [];
    const fl = [];
    for (let i = 0; i < xs.length; i++) {
      if (pseudoRandom(i) < keep) {
        fx.push(xs[i]);
        fy.push(ys[i]);
        fl.push(lum[i]);
      }
    }
    return { xs: Float32Array.from(fx), ys: Float32Array.from(fy), lum: Float32Array.from(fl), count: fx.length };
  }
  return { xs: Float32Array.from(xs), ys: Float32Array.from(ys), lum: Float32Array.from(lum), count: xs.length };
}

/**
 * Fallback silhouette: jittered elliptical disc covering the displayed box.
 * Used when the texture cannot be read (or is fully transparent).
 */
function discSample(boxW, boxH, targetCount) {
  const cx = boxW / 2;
  const cy = boxH / 2;
  const rx = boxW * 0.48;
  const ry = boxH * 0.48;
  const step = Math.max(2, Math.sqrt((boxW * boxH) / Math.max(1, targetCount)) * 0.94);
  const xs = [];
  const ys = [];
  const lum = [];
  for (let y = cy - ry; y <= cy + ry; y += step) {
    for (let x = cx - rx; x <= cx + rx; x += step) {
      const nx = (x - cx) / rx;
      const ny = (y - cy) / ry;
      if (nx * nx + ny * ny > 1) continue;
      xs.push(x + (pseudoRandom(xs.length) - 0.5) * step * 0.8);
      ys.push(y + (pseudoRandom(ys.length + 31) - 0.5) * step * 0.8);
      lum.push(0.5);
    }
  }
  return { xs: Float32Array.from(xs), ys: Float32Array.from(ys), lum: Float32Array.from(lum), count: xs.length };
}

/**
 * Compute each point's vanish order for a sweep direction. This mirrors the
 * dissolve filter shader exactly (same uv mapping, same aspect handling, same
 * inward inversion) so particles spawn exactly where the token just crumbled.
 */
function computeOrders(raw, boxW, boxH, sweepMode) {
  const orders = new Float32Array(raw.count);
  const aspect = boxW / Math.max(1, boxH);
  for (let i = 0; i < raw.count; i++) {
    const u = raw.xs[i] / boxW;
    const v = raw.ys[i] / boxH;
    let order;
    if (sweepMode === "down") {
      order = v; // top edge goes first
    } else if (sweepMode === "inward") {
      const cx = (u - 0.5) * aspect;
      const cy = v - 0.5;
      // Edges-first: the rim (max radial distance) gets the smallest order.
      order = 1 - Math.min(1, Math.hypot(cx, cy) * 1.41421356);
    } else {
      order = 1 - v; // "up": bottom edge goes first, front rises
    }
    orders[i] = Math.min(1, Math.max(0, order));
  }
  return orders;
}

/**
 * Thin the raw cloud to the target count (deterministic, spatially unbiased),
 * then return points sorted by vanish order so the emitter can stream them
 * with a moving pointer.
 */
function finalize(raw, boxW, boxH, sweepMode, targetCount) {
  const total = raw.count;
  if (total === 0) {
    return { xs: new Float32Array(0), ys: new Float32Array(0), orders: new Float32Array(0), sizes: new Float32Array(0), count: 0 };
  }
  const orders = computeOrders(raw, boxW, boxH, sweepMode);

  // Deterministic thinning to the particle target.
  let indices = [];
  if (total > targetCount) {
    const keep = targetCount / total;
    for (let i = 0; i < total; i++) {
      if (pseudoRandom(i * 7 + 13) < keep) indices.push(i);
    }
    // Guarantee we did not overshoot or undershoot absurdly.
    if (indices.length > targetCount * 1.3) indices = indices.slice(0, targetCount);
    if (indices.length < 8) indices = Array.from({ length: Math.min(total, targetCount) }, (_, i) => i);
  } else {
    indices = Array.from({ length: total }, (_, i) => i);
  }

  // Sort remaining points by vanish order (ascending = emitted first).
  indices.sort((a, b) => orders[a] - orders[b]);

  const count = indices.length;
  const xs = new Float32Array(count);
  const ys = new Float32Array(count);
  const sortedOrders = new Float32Array(count);
  const sizes = new Float32Array(count);
  for (let k = 0; k < count; k++) {
    const i = indices[k];
    xs[k] = raw.xs[i];
    ys[k] = raw.ys[i];
    sortedOrders[k] = orders[i];
    sizes[k] = Math.min(1.4, Math.max(0.6, 0.7 + 0.6 * raw.lum[i]));
  }
  return { xs, ys, orders: sortedOrders, sizes, count };
}

/**
 * Build the sweep-ordered sample for a token.
 * @param {TokenDocument} token  the token document
 * @param {string} sweepMode     "up" | "down" | "inward"
 * @param {number} targetCount   desired particle count before emission
 * @param {PIXI.Sprite|null} [mesh]  the placeable's mesh (token.object.mesh);
 *        its texture is sampled and its displayed width/height (which reflect
 *        texture scale) define the sampling box
 * @returns {Promise<{xs: Float32Array, ys: Float32Array, orders: Float32Array, sizes: Float32Array, count: number}>}
 */
/**
 * Resolve a token's displayed footprint in world pixels.
 * Foundry v14 TokenDocuments have no w/h pixel getters: `width`/`height` are
 * grid squares. The mesh's width/height are pixels and include texture scale,
 * so they win; document squares × grid size is the fallback.
 * @param {TokenDocument} doc
 * @param {PIXI.Sprite|null} [mesh]
 * @returns {{w: number, h: number}}
 */
export function resolveTokenBox(doc, mesh = doc?.object?.mesh ?? null) {
  const grid = canvas?.grid?.size ?? 100;
  const w = Math.max(1, Number(mesh?.width) || Number(doc?.width) * grid || grid);
  const h = Math.max(1, Number(mesh?.height) || Number(doc?.height) * grid || grid);
  return { w, h };
}

/**
 * Resolve the token's displayed box as world-pixel top-left + size.
 * v9+ TokenDocument x/y (and the mesh position) are CENTER coordinates, and
 * the mesh may be scaled by the texture's scaleX/scaleY, so the particle
 * cloud and shader must use the mesh's actual displayed box —
 * doc.object.x + local offsets would shift the cloud by half a token.
 * @param {TokenDocument} doc
 * @param {PIXI.Sprite|null} [mesh]
 * @returns {{x: number, y: number, w: number, h: number}}
 */
export function resolveDisplayBox(doc, mesh = doc?.object?.mesh ?? null) {
  const { w, h } = resolveTokenBox(doc, mesh);
  const cx = Number(mesh?.position?.x);
  const cy = Number(mesh?.position?.y);
  const centerX = Number.isFinite(cx) ? cx : Number(doc?.x) || 0;
  const centerY = Number.isFinite(cy) ? cy : Number(doc?.y) || 0;
  return { x: centerX - w / 2, y: centerY - h / 2, w, h };
}

export async function buildSample(token, sweepMode, targetCount, mesh = null) {
  const empty = { xs: new Float32Array(0), ys: new Float32Array(0), orders: new Float32Array(0), sizes: new Float32Array(0), count: 0 };
  try {
    // The mesh lives on the placeable, not the document. Resolve it defensively.
    const placeableMesh = mesh ?? token.object?.mesh ?? null;
    const box = resolveTokenBox(token, placeableMesh);
    if (!token || !Number.isFinite(box.w) || !Number.isFinite(box.h)) return empty;
    const boxW = box.w;
    const boxH = box.h;
    const texture = placeableMesh?.texture ?? null;
    const key = texture ? cacheKeyFor(boxW, boxH, texture) : null;
    let raw = cacheGet(key);
    if (!raw && texture) {
      const src = await textureToCanvas(texture);
      if (src) {
        raw = samplePixels(boxW, boxH, src);
        if (raw.count === 0) debugLog("texture fully transparent; using disc fallback");
        else cachePut(key, raw);
      }
    }
    if (!raw || raw.count === 0) raw = discSample(boxW, boxH, targetCount);
    return finalize(raw, boxW, boxH, sweepMode, Math.max(8, Math.round(targetCount)));
  } catch (err) {
    debugLog("buildSample failed; using disc fallback:", err?.message ?? err);
    try {
      const placeableMesh = mesh ?? token.object?.mesh ?? null;
      const box = resolveTokenBox(token, placeableMesh);
      return finalize(discSample(box.w, box.h, targetCount), box.w, box.h, sweepMode, Math.max(8, Math.round(targetCount)));
    } catch (err2) {
      debugLog("disc fallback failed:", err2?.message ?? err2);
      return empty;
    }
  }
}

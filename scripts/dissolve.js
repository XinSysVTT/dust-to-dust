// Dust to Dust — the dissolve FX engine.
//
// Two cooperating pieces:
//  1. A custom PIXI Filter on the token mesh: the fragment shader discards
//     fragments below an animated, direction-biased noise threshold, so the
//     token crumbles edge-to-edge with a matte, ragged front (no glow). Pixels
//     near the front darken briefly, as if losing cohesion.
//  2. A pooled particle system: dust candidates from the pre-sampled point
//     cloud (sampler.js) are emitted exactly at the crumbling front, drift
//     briefly as if falling apart, then the wind takes over with per-particle
//     variance and sin-based turbulence. ~20% are long-lived "wisps" that
//     trail behind the main cloud.
//
// Version policy: Foundry v14.368 bundles PixiJS 7.4.3 (crucible-scout board
// findings, verified against the install's node_modules), so the Pixi 7 API is
// the exercised path. The Pixi 8 variants below are kept behind feature
// detection for forward compatibility, and every PIXI call is guarded — on any
// API mismatch the engine degrades to a plain alpha fade of the mesh, so the
// game never breaks.

import { getSetting, DEFAULTS, SWEEP_DIRECTIONS, AFTER_EFFECTS, clampNumber, colorSetting, debugLog, warnLog } from "./settings.js";
import { buildSample, resolveDisplayBox } from "./sampler.js";

// ---------------------------------------------------------------------------
// Tuning constants (effect shape; settings override the user-facing knobs)
// ---------------------------------------------------------------------------

const CRUMBLE_SECONDS = 0.3; // particles drift loosely before the wind takes over
const WIND_TAKEOVER_SECONDS = 0.4; // velocity blend time from crumble to wind
const WISP_CHANCE = 0.2; // fraction of long-lived trailing particles
const EMIT_LAG = 0.02; // emit just behind the visible dissolve front
const THRESHOLD_HEADROOM = 1.03; // guarantee a full dissolve at sweep end
const BASE_PARTICLES = 950; // for a 1x1 grid token at density 1.0 (spec: ~700-1200)
const MIN_PARTICLES = 120;
const MAX_PARTICLES = 3500; // absolute cap for very large tokens
const WIND_BASE_PX_S = 120; // wind speed in px/s at strength 1.0
const CRUMBLE_VX = 10; // px/s outward jitter while crumbling
const CRUMBLE_VY_MIN = 10; // px/s downward drift while crumbling
const CRUMBLE_VY_MAX = 30;
const UPWARD_VARIANCE = 22; // px/s extra lift variance in the wind phase
const PARTICLE_TEX_PX = 32;

const SWEEP_MODE_INDEX = { up: 0, down: 1, inward: 2 };

// ---------------------------------------------------------------------------
// Shaders
// ---------------------------------------------------------------------------

/** Pixi 7 (GLSL ES 1.0). Vertex shader omitted → default filter vertex. */
const FRAG_GLSL1 = `
precision highp float;

varying vec2 vTextureCoord;

uniform sampler2D uSampler;
uniform float uThreshold;
uniform float uJitter;
uniform float uMode;
uniform vec2 uSize;

float dtdHash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

void main() {
  vec2 uv = vTextureCoord;
  float order;
  if (uMode < 0.5) {
    order = 1.0 - uv.y;                       // "up": bottom edge crumbles first
  } else if (uMode < 1.5) {
    order = uv.y;                             // "down": top edge first
  } else {
    vec2 c = uv - 0.5;                        // "inward": rim first, center last
    c.x *= uSize.x / max(uSize.y, 1.0);
    order = 1.0 - clamp(length(c) * 1.41421356, 0.0, 1.0);
  }
  float n = dtdHash(floor(uv * uSize) + 0.5); // per-pixel dither
  float f = clamp(order * (1.0 - uJitter) + n * uJitter, 0.0, 1.0);
  if (f < uThreshold) discard;
  vec4 tex = texture2D(uSampler, uv);
  float edge = smoothstep(uThreshold, uThreshold + 0.08, f);
  tex.rgb *= mix(0.35, 1.0, edge);            // matte darken at the crumble front
  gl_FragColor = tex;
}
`;

/** Pixi 8 (GLSL ES 3.0 style) — forward-compatibility path, not exercised on
 * the v14 bundled Pixi 7.4.3. */
const VERT_GLSL3 = `
in vec2 aVertexPosition;
in vec2 aTextureCoord;
in vec4 aColor;

uniform mat3 projectionMatrix;
uniform mat3 translationMatrix;
uniform mat3 textureMatrix;

out vec2 vTextureCoord;
out vec4 vColor;

void main(void) {
  gl_Position = vec4((projectionMatrix * translationMatrix * vec3(aVertexPosition, 1.0)).xy, 0.0, 1.0);
  vTextureCoord = (textureMatrix * vec3(aTextureCoord, 1.0)).xy;
  vColor = vec4(aColor.rgb * aColor.a, aColor.a);
}
`;

const FRAG_GLSL3 = `
in vec2 vTextureCoord;
in vec4 vColor;

out vec4 finalColor;

uniform sampler2D uSampler;
uniform float uThreshold;
uniform float uJitter;
uniform float uMode;
uniform vec2 uSize;

float dtdHash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

void main(void) {
  vec2 uv = vTextureCoord;
  float order;
  if (uMode < 0.5) {
    order = 1.0 - uv.y;
  } else if (uMode < 1.5) {
    order = uv.y;
  } else {
    vec2 c = uv - 0.5;
    c.x *= uSize.x / max(uSize.y, 1.0);
    order = 1.0 - clamp(length(c) * 1.41421356, 0.0, 1.0); // rim first, center last
  }
  float n = dtdHash(floor(uv * uSize) + 0.5);
  float f = clamp(order * (1.0 - uJitter) + n * uJitter, 0.0, 1.0);
  if (f < uThreshold) discard;
  vec4 tex = texture(uSampler, vTextureCoord) * vColor;
  float edge = smoothstep(uThreshold, uThreshold + 0.08, f);
  tex.rgb *= mix(0.35, 1.0, edge);
  finalColor = tex;
}
`;

// ---------------------------------------------------------------------------
// PIXI access helpers
// ---------------------------------------------------------------------------

function pixi() {
  return globalThis.PIXI ?? null;
}

/** Shared soft dust sprite texture (white radial blob, tinted per effect). */
let particleTexture = null;
function getParticleTexture() {
  if (particleTexture) return particleTexture;
  const PIXI = pixi();
  const c = document.createElement("canvas");
  c.width = c.height = PARTICLE_TEX_PX;
  const ctx = c.getContext("2d");
  const g = ctx.createRadialGradient(PARTICLE_TEX_PX / 2, PARTICLE_TEX_PX / 2, 0, PARTICLE_TEX_PX / 2, PARTICLE_TEX_PX / 2, PARTICLE_TEX_PX / 2);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.35, "rgba(255,255,255,0.95)");
  g.addColorStop(0.7, "rgba(255,255,255,0.4)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, PARTICLE_TEX_PX, PARTICLE_TEX_PX);
  particleTexture = PIXI.Texture.from(c);
  return particleTexture;
}

/**
 * Create the dissolve filter. Pixi 7 (Foundry v14's bundled 7.4.3) is the
 * exercised path; the Pixi 8 GlProgram variant is tried first only when its
 * API is present. Returns { filter, set(name, value) } or null.
 */
function createDissolveFilter(modeIndex, width, height) {
  const PIXI = pixi();
  if (!PIXI?.Filter) return null;
  const uniforms = { uThreshold: 0, uJitter: 0.34, uMode: modeIndex, uSize: [width, height] };

  // Pixi 8 path.
  if (PIXI.GlProgram) {
    try {
      const glProgram = PIXI.GlProgram.from({ vertex: VERT_GLSL3, fragment: FRAG_GLSL3, name: "dust-to-dust-dissolve" });
      const filter = new PIXI.Filter({
        glProgram,
        resources: { dissolveUniforms: new PIXI.UniformGroup(uniforms) },
      });
      return {
        filter,
        set(name, value) {
          filter.resources.dissolveUniforms.uniforms[name] = value;
        },
      };
    } catch (err) {
      warnLog("Pixi 8 filter path failed, trying Pixi 7 path:", err?.message ?? err);
    }
  }

  // Pixi 7 path.
  try {
    const filter = new PIXI.Filter(null, FRAG_GLSL1, uniforms);
    return {
      filter,
      set(name, value) {
        filter.uniforms[name] = value;
      },
    };
  } catch (err) {
    warnLog("dissolve filter unavailable:", err?.message ?? err);
    return null;
  }
}

/**
 * Create the batched particle host. Prefers the modern Pixi 8 Particle
 * container, falls back to the Pixi 7 ParticleContainer, then to plain sprites.
 * Returns { container, update?, sync(i, x, y, scale, alpha), destroy() }.
 */
function createParticleHost(maxCount, tint, texture) {
  const PIXI = pixi();
  if (!PIXI) return null;

  // Pixi 8 (>= 8.6): new Particle / ParticleContainer API.
  if (PIXI.Particle && PIXI.ParticleContainer) {
    try {
      const container = new PIXI.ParticleContainer({
        dynamicProperties: { position: true, scale: true, color: true, rotation: false, uvs: false },
      });
      const particles = [];
      for (let i = 0; i < maxCount; i++) {
        const p = new PIXI.Particle({
          texture,
          x: -100000,
          y: -100000,
          scaleX: 0,
          scaleY: 0,
          anchorX: 0.5,
          anchorY: 0.5,
          tint,
          alpha: 0,
        });
        particles.push(p);
        container.addParticle(p);
      }
      const hasAlpha = particles.length > 0 && typeof particles[0].alpha === "number";
      return {
        container,
        update() {
          if (typeof container.update === "function") container.update();
        },
        sync(i, x, y, scale, alpha) {
          const p = particles[i];
          p.x = x;
          p.y = y;
          p.scaleX = scale;
          p.scaleY = scale;
          if (hasAlpha) p.alpha = alpha;
          else p.color = (((alpha * 255) << 24) | (tint & 0xffffff)) >>> 0;
        },
        destroy() {
          container.destroy({ children: true });
        },
      };
    } catch (err) {
      debugLog("Pixi 8 particle host failed, trying Pixi 7:", err?.message ?? err);
    }
  }

  // Pixi 7: classic ParticleContainer (tint property packs child alpha).
  if (PIXI.ParticleContainer) {
    try {
      const container = new PIXI.ParticleContainer(
        maxCount,
        { position: true, scale: true, tint: true, rotation: false, uvs: false },
        maxCount,
        false
      );
      const sprites = [];
      for (let i = 0; i < maxCount; i++) {
        const sp = new PIXI.Sprite(texture);
        sp.anchor?.set(0.5);
        sp.tint = tint;
        sp.position.set(-100000, -100000);
        sp.scale.set(0);
        sp.alpha = 0;
        container.addChild(sp);
        sprites.push(sp);
      }
      return {
        container,
        sync(i, x, y, scale, alpha) {
          const sp = sprites[i];
          sp.position.set(x, y);
          sp.scale.set(scale);
          sp.alpha = alpha;
        },
        destroy() {
          container.destroy({ children: true });
        },
      };
    } catch (err) {
      debugLog("Pixi 7 particle host failed, using plain sprites:", err?.message ?? err);
    }
  }

  // Last resort: plain container of sprites (fine for a few thousand particles).
  try {
    const container = new PIXI.Container();
    const sprites = [];
    for (let i = 0; i < maxCount; i++) {
      const sp = new PIXI.Sprite(texture);
      sp.anchor.set(0.5);
      sp.tint = tint;
      sp.position.set(-100000, -100000);
      sp.scale.set(0);
      sp.alpha = 0;
      container.addChild(sp);
      sprites.push(sp);
    }
    return {
      container,
      sync(i, x, y, scale, alpha) {
        const sp = sprites[i];
        sp.position.set(x, y);
        sp.scale.set(scale);
        sp.alpha = alpha;
      },
      destroy() {
        container.destroy({ children: true });
      },
    };
  } catch (err) {
    warnLog("no usable particle host:", err?.message ?? err);
    return null;
  }
}

/**
 * The ticker to drive the effect with. Foundry v14 renders through
 * canvas.app.ticker (its own Ticker instance) and does NOT reliably tick
 * PIXI.Ticker.shared — a shared-ticker callback fires only sporadically, so
 * the effect clock must ride Foundry's application ticker.
 */
function effectTicker() {
  try {
    if (canvas?.app?.ticker) return canvas.app.ticker;
  } catch (err) {
    /* fall through */
  }
  return pixi()?.Ticker?.shared ?? null;
}

/**
 * Attach the particle container so it renders above all tokens.
 *
 * Foundry v14: token visuals are PrimarySpriteMeshes inside canvas.primary
 * (added via canvas.primary.addToken); PrimaryCanvasGroup sorts children by
 * elevation → sortLayer → sort → zIndex, with tokens at SORT_LAYERS.TOKENS
 * (700). We sit at sortLayer 800 (above tokens, below weather) and a huge
 * elevation so even elevated tokens never cover the dust. This mirrors how
 * Foundry's own ParticleGenerator places its container in the primary group.
 */
function attachContainer(container) {
  try {
    container.eventMode = "none";
  } catch (err) {
    /* older Pixi: the interactive flags below cover it */
  }
  container.interactive = false;
  container.interactiveChildren = false;

  const primary = canvas?.primary;
  if (primary?.addChild) {
    container.sortLayer = 800; // PrimaryCanvasGroup.SORT_LAYERS.TOKENS + 100
    container.elevation = 1e9; // above every token regardless of elevation
    primary.addChild(container);
    return true;
  }
  // Fallback: v12-style tokens layer (or the canvas stage as a last resort).
  const layer = canvas?.tokens ?? canvas?.stage;
  if (layer?.addChild) {
    container.zIndex = 1000000;
    layer.addChild(container);
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Effect configuration
// ---------------------------------------------------------------------------

function resolveTokenTarget(target) {
  try {
    if (target == null || !canvas?.tokens?.get) return null;
    if (typeof target === "string") return canvas.tokens.get(target)?.document ?? null;
    if (typeof target !== "object") return null;
    if (target.document) return target.document; // a Token placeable
    if (target.object || target.texture) return target; // already a TokenDocument
    if (target.id) return canvas.tokens.get(target.id)?.document ?? null;
  } catch (err) {
    debugLog("resolveTokenTarget failed:", err?.message ?? err);
  }
  return null;
}

function buildConfig(overrides = {}) {
  const sweep = String(overrides.sweepDirection ?? getSetting("sweepDirection"));
  const after = String(overrides.afterEffect ?? getSetting("afterEffect"));
  return {
    sweep: Object.values(SWEEP_DIRECTIONS).includes(sweep) ? sweep : DEFAULTS.sweepDirection,
    dissolveDuration: clampNumber(overrides.dissolveDuration ?? getSetting("dissolveDuration"), 0.3, 12, DEFAULTS.dissolveDuration),
    density: clampNumber(overrides.particleDensity ?? getSetting("particleDensity"), 0.1, 4, 1),
    windDirection: clampNumber(overrides.windDirection ?? getSetting("windDirection"), 0, 360, DEFAULTS.windDirection),
    windStrength: clampNumber(overrides.windStrength ?? getSetting("windStrength"), 0, 4, DEFAULTS.windStrength),
    turbulence: clampNumber(overrides.turbulence ?? getSetting("turbulence"), 0, 4, DEFAULTS.turbulence),
    tint: colorSetting(overrides.particleColor ?? getSetting("particleColor")),
    afterEffect: Object.values(AFTER_EFFECTS).includes(after) ? after : DEFAULTS.afterEffect,
  };
}

function targetParticleCount(doc, density) {
  // v14: TokenDocument.width/height are grid SQUARES (w/h pixel getters are gone).
  const cells = Math.max(0.25, Number(doc?.width) * Number(doc?.height) || 0.25);
  const factor = Math.sqrt(cells);
  return Math.round(clampNumber(BASE_PARTICLES * factor * density, MIN_PARTICLES, MAX_PARTICLES));
}

function rand(min, max) {
  return min + Math.random() * (max - min);
}

// ---------------------------------------------------------------------------
// The effect runner
// ---------------------------------------------------------------------------

/** token id -> DissolveEffect; enforces one animation per token at a time. */
const activeEffects = new Map();

export function isPlaying(tokenId) {
  return activeEffects.has(String(tokenId));
}

/**
 * Play the dissolve effect on a token.
 * @param {TokenDocument|Token|string} target token document, placeable, or id
 * @param {object} [overrides] setting overrides (sweepDirection, dissolveDuration,
 *        particleDensity, windDirection, windStrength, turbulence, particleColor, afterEffect)
 * @returns {Promise<boolean>} resolves true when the effect completed, false when
 *          it was skipped or cancelled. Never rejects.
 */
export async function playEffect(target, overrides = {}) {
  try {
    if (!canvas?.ready || !canvas?.tokens) {
      try {
        ui?.notifications?.warn(game.i18n.localize("DUSTTODUST.NOTIFICATIONS.NoCanvas"));
      } catch (err) {
        /* notifications unavailable */
      }
      return false;
    }
    const doc = resolveTokenTarget(target);
    if (!doc) {
      warnLog("play(): could not resolve a token from", target);
      try {
        ui?.notifications?.warn(game.i18n.localize("DUSTTODUST.NOTIFICATIONS.InvalidTarget"));
      } catch (err) {
        /* notifications unavailable */
      }
      return false;
    }
    const id = String(doc.id);
    if (activeEffects.has(id)) {
      debugLog("already dissolving token", id);
      try {
        ui?.notifications?.warn(game.i18n.localize("DUSTTODUST.NOTIFICATIONS.AlreadyPlaying"));
      } catch (err) {
        /* notifications unavailable */
      }
      return false;
    }
    if (doc.hidden) {
      debugLog("token already hidden, skipping", id);
      return false;
    }
    const effect = new DissolveEffect(doc, overrides);
    activeEffects.set(id, effect);
    try {
      return await effect.run();
    } finally {
      if (activeEffects.get(id) === effect) activeEffects.delete(id);
    }
  } catch (err) {
    warnLog("play() failed:", err);
    return false;
  }
}

/** Cancel the effect on one token (used when the token document is deleted). */
export function cancelEffect(tokenId, reason = "cancel") {
  const effect = activeEffects.get(String(tokenId));
  if (!effect) return false;
  effect.finish(false, reason);
  return true;
}

/** Cancel every running effect (used when the scene is torn down). */
export function cancelAllEffects(reason = "cancel") {
  for (const effect of [...activeEffects.values()]) effect.finish(false, reason);
}

class DissolveEffect {
  constructor(doc, overrides) {
    this.doc = doc;
    this.cfg = buildConfig(overrides);
    this.finished = false;
    this.resolve = null;
    this.t = 0;
    this.emitPtr = 0;
    this.aliveCount = 0;
    this.meshHidden = false;
    this.fadeFallback = false;
    this.mesh = null;
    this.token = null;
    this.box = null;
    this.sample = null;
    this.host = null;
    this.filterWrap = null;
    this.savedFilters = null;
    this.savedAlpha = 1;
    this._tickFn = null;
  }

  run() {
    return new Promise((resolve) => {
      this.resolve = resolve;
      this._begin();
    });
  }

  _begin() {
    try {
      const token = this.doc?.object; // the placeable
      this.token = token ?? null;
      this.mesh = token?.mesh ?? null;
      if (!token || token.destroyed || !this.doc?.parent) {
        this.finish(false, "token-not-on-canvas");
        return;
      }
      this.box = resolveDisplayBox(this.doc, this.mesh);
      this.targetCount = targetParticleCount(this.doc, this.cfg.density);
      this._beginSample();
    } catch (err) {
      warnLog("effect start failed:", err);
      this.finish(false, "error");
    }
  }

  async _beginSample() {
    try {
      this.sample = await buildSample(this.doc, this.cfg.sweep, this.targetCount, this.mesh);
    } catch (err) {
      debugLog("sampling failed:", err);
      this.sample = null;
    }
    if (this.finished) return;
    if (!this.sample || this.sample.count === 0) {
      warnLog("no usable sample (token dimensions/texture unreadable); cancelling dissolve on", this.doc?.id);
      this.finish(false, "no-sample");
      return;
    }

    // Particle host.
    try {
      this.host = createParticleHost(this.sample.count, this.cfg.tint, getParticleTexture());
    } catch (err) {
      warnLog("particle host creation failed:", err);
      this.host = null;
    }
    if (!this.host || !attachContainer(this.host.container)) {
      warnLog("particle host unavailable; cancelling dissolve on", this.doc?.id);
      this.finish(false, "no-particle-host");
      return;
    }

    // Dissolve filter on the mesh (or alpha-fade fallback).
    this.savedAlpha = this.mesh?.alpha ?? 1;
    if (this.mesh) {
      const modeIndex = SWEEP_MODE_INDEX[this.cfg.sweep] ?? 0;
      const wrap = createDissolveFilter(modeIndex, this.box.w, this.box.h);
      if (wrap) {
        try {
          this.savedFilters = this.mesh.filters ?? null;
          this.mesh.filters = this.savedFilters ? [...this.savedFilters, wrap.filter] : [wrap.filter];
          this.filterWrap = wrap;
        } catch (err) {
          warnLog("filter apply failed; using alpha fade fallback:", err?.message ?? err);
          this.fadeFallback = true;
        }
      } else {
        this.fadeFallback = true;
        debugLog("dissolve filter unavailable; using alpha fade fallback");
      }
    }

    // Particle pool (one object per sampled point, reused across runs of the
    // same effect instance; spawned exactly once each during the sweep).
    this.pool = new Array(this.sample.count).fill(null);

    // Single shared-ticker update loop, removed again in finish().
    this._tickFn = () => this.tick();
      const ticker = effectTicker();
      if (!ticker) {
        warnLog("no ticker available:", this.doc?.id);
        this.finish(false, "no-ticker");
        return;
      }
      ticker.add(this._tickFn);
  }

  tick() {
    if (this.finished) return;
    try {
      const token = this.doc?.object;
      const gone =
        !this.host?.container ||
        this.host.container.destroyed ||
        (token && token.destroyed) ||
        (this.mesh && this.mesh.destroyed);
      if (gone) {
        this.finish(false, "scene-or-token-gone");
        return;
      }

      const dt = Math.min(50, effectTicker()?.deltaMS || 16.7) / 1000;
      this.t += dt;
      const sweepT = Math.min(1, this.t / this.cfg.dissolveDuration);
      const effT = Math.min(1, sweepT * THRESHOLD_HEADROOM);

      if (this.filterWrap) {
        this.filterWrap.set("uThreshold", effT);
      } else if (this.fadeFallback && this.mesh) {
        this.mesh.alpha = this.savedAlpha * (1 - sweepT);
      }

      this._emitUpTo(effT);
      this._updateParticles(dt);

      if (this.host.update) this.host.update();

      if (sweepT >= 1 && !this.meshHidden && this.token) {
        // Hide the whole placeable — mesh, status icons, bars, everything.
        // renderable=false is the load-bearing part: Foundry recomputes
        // `visible` on every refresh (and re-shows hidden tokens to the GM),
        // but it never touches `renderable`, so the token stays unrendered
        // until we explicitly restore it.
        this.token.renderable = false;
        this.token.visible = false;
        if (this.mesh) this.mesh.visible = false;
        this.meshHidden = true;
      }
      if (sweepT >= 1 && this.emitPtr >= this.sample.count && this.aliveCount === 0) {
        this.finish(true, "complete");
      }
    } catch (err) {
      warnLog("effect tick failed; ending effect:", err);
      this.finish(false, "error");
    }
  }

  _emitUpTo(effT) {
    const s = this.sample;
    if (effT >= 1) {
      while (this.emitPtr < s.count) this._spawn(s, this.emitPtr++);
      return;
    }
    const limit = effT - EMIT_LAG;
    while (this.emitPtr < s.count && s.orders[this.emitPtr] <= limit) this._spawn(s, this.emitPtr++);
  }

  _spawn(s, i) {
    const p = this.pool[i] ?? (this.pool[i] = {});
    const angle = (this.cfg.windDirection * Math.PI) / 180;
    const speed = WIND_BASE_PX_S * this.cfg.windStrength;

    p.alive = true;
    p.x = this.box.x + s.xs[i] + rand(-1.2, 1.2);
    p.y = this.box.y + s.ys[i] + rand(-1.2, 1.2);

    // Crumble phase: brief loose drift downward/outward, as if losing cohesion.
    p.vx0 = rand(-CRUMBLE_VX, CRUMBLE_VX);
    p.vy0 = rand(CRUMBLE_VY_MIN, CRUMBLE_VY_MAX);

    // Wind phase: global wind with per-particle variance plus slight lift.
    p.wvx = Math.cos(angle) * speed * rand(0.6, 1.4);
    p.wvy =
      Math.sin(angle) * speed * rand(0.6, 1.4) -
      (rand(0, UPWARD_VARIANCE) + this.cfg.turbulence * rand(0, UPWARD_VARIANCE * 0.8));

    p.isWisp = Math.random() < WISP_CHANCE;
    p.life = p.isWisp ? rand(1.5, 2.5) : rand(0.8, 1.5);
    p.age = 0;
    const basePx = rand(2, 4) * s.sizes[i] * (p.isWisp ? 0.85 : 1);
    p.baseScale = basePx / PARTICLE_TEX_PX;
    p.alphaBase = p.isWisp ? 0.85 : 0.95;
    p.amp = rand(5, 13) * this.cfg.turbulence;
    p.freq = rand(2.6, 5.2);
    p.phase = rand(0, Math.PI * 2);
  }

  _updateParticles(dt) {
    let alive = 0;
    for (let i = 0; i < this.sample.count; i++) {
      const p = this.pool[i];
      if (!p?.alive) continue;
      p.age += dt;
      if (p.age >= p.life) {
        p.alive = false;
        this.host.sync(i, -100000, -100000, 0, 0);
        continue;
      }

      // Velocity: crumble drift blending into the wind.
      let vx = p.vx0;
      let vy = p.vy0;
      if (p.age > CRUMBLE_SECONDS) {
        const k = Math.min(1, (p.age - CRUMBLE_SECONDS) / WIND_TAKEOVER_SECONDS);
        vx += (p.wvx - vx) * k;
        vy += (p.wvy - vy) * k;
      }
      p.x += vx * dt;
      p.y += vy * dt;

      const lt = p.age / p.life;
      // Turbulence wobble fades in as the wind takes over.
      const wob = p.amp * Math.min(1, Math.max(0, (p.age - CRUMBLE_SECONDS) / 0.35));
      const rx = p.x + Math.sin(p.age * p.freq + p.phase) * wob;
      const ry = p.y + Math.cos(p.age * p.freq * 0.83 + p.phase * 1.7) * wob * 0.6;

      const scale = p.baseScale * (1 - lt * lt); // shrink to nothing
      const alpha = p.alphaBase * (1 - Math.pow(lt, 1.7)); // ease-in fade

      this.host.sync(i, rx, ry, Math.max(0, scale), Math.max(0, alpha));
      alive++;
    }
    this.aliveCount = alive;
  }

  finish(success = true, reason = "complete") {
    if (this.finished) return;
    this.finished = true;

    try {
      if (this._tickFn) effectTicker()?.remove(this._tickFn);
    } catch (err) {
      /* already removed */
    }

    // Restore the mesh (filter, alpha, visibility).
    try {
      if (this.mesh && !this.mesh.destroyed) {
        if (this.filterWrap) {
          this.mesh.filters = this.savedFilters ?? null;
          this.filterWrap = null;
        }
        if (this.fadeFallback) this.mesh.alpha = this.savedAlpha;
        // When the effect ends by hiding or deleting the token, keep it
        // invisible on THIS client until the document update lands — restoring
        // visibility here flashes the full token for a frame or two (any
        // refreshToken in the window re-shows it). This applies to every user
        // who can trigger the mutation, not just GMs; users who cannot mutate
        // get their view restored immediately.
        const wantsVanish = success
          && (this.cfg.afterEffect === AFTER_EFFECTS.HIDE || this.cfg.afterEffect === AFTER_EFFECTS.DELETE);
        const canMutate = wantsVanish && canUpdateDocument(this.doc);
        if (wantsVanish) {
          // Keep the placeable unrendered on this client until the document
          // state lands (our own update, or the broadcast from the GM's).
          // Once it lands, Foundry renders per document state: players see
          // nothing, the GM sees the ghosted corpse. The corpse document
          // itself always stays in the scene.
          if (canMutate) this._applyAfterEffect();
          else this._awaitVanishBroadcast();
        } else {
          restorePlaceable(this.token);
        }
      }
    } catch (err) {
      debugLog("mesh restore skipped:", err?.message ?? err);
    }

    if (success) this._applyAfterEffect();

    try {
      if (this.host?.container) {
        this.host.container.parent?.removeChild(this.host.container);
        this.host.destroy();
      }
    } catch (err) {
      debugLog("container teardown skipped:", err?.message ?? err);
    }
    this.host = null;

    debugLog(`effect ${success ? "finished" : "cancelled"} (${reason}) token=${this.doc?.id ?? "?"}`);
    this.resolve?.(success);
    this.resolve = null;
  }

  /**
   * Wait for the hidden/deleted state to arrive via broadcast (the user could
   * not issue the mutation themselves — e.g. a player triggering the effect
   * with a GM online). Covers the same latency window as _applyAfterEffect;
   * if nothing lands within a few seconds there is no GM to perform the
   * mutation, so the token is restored.
   */
  _awaitVanishBroadcast() {
    const id = String(this.doc?.id ?? "");
    const onTokenUpdate = (doc) => {
      if (String(doc?.id) !== id) return;
      if (doc.hidden === true || doc === null) this._endVanishWait(true);
    };
    const onTokenDelete = (doc) => {
      if (String(doc?.id) === id) this._endVanishWait(true);
    };
    Hooks.on("updateToken", onTokenUpdate);
    Hooks.on("deleteToken", onTokenDelete);
    this._vanishWaitHooks = [
      ["updateToken", onTokenUpdate],
      ["deleteToken", onTokenDelete],
    ];
    this._vanishWaitTimer = setTimeout(() => this._endVanishWait(false), 4000);
  }

  /** Release the broadcast wait: re-enable rendering; Foundry draws per doc state. */
  _endVanishWait(landed) {
    if (this._vanishWaitDone) return;
    this._vanishWaitDone = true;
    if (this._vanishWaitTimer) clearTimeout(this._vanishWaitTimer);
    for (const [name, fn] of this._vanishWaitHooks ?? []) {
      try { Hooks.off(name, fn); } catch (err) { /* already off */ }
    }
    this._vanishWaitHooks = null;
    const token = this.token ?? this.doc?.object;
    if (landed) {
      // The hidden/deleted state is authoritative and Foundry's own refresh has
      // already applied the correct visibility. Only hand renderability back —
      // re-showing the mesh here is what flashed the full token on screen.
      try {
        if (token && !token.destroyed) token.renderable = true;
      } catch (err) {
        debugLog("renderable restore skipped:", err?.message ?? err);
      }
    } else {
      // Nothing landed (update failed / no GM available): the token must come
      // back, so restore everything.
      restorePlaceable(token);
    }
  }

  /** Apply the end-of-effect token mutation. Only for users who can mutate the document; never on early cancel. */
  _applyAfterEffect() {
    const after = this.cfg.afterEffect;
    const id = String(this.doc?.id ?? "");
    if (after === AFTER_EFFECTS.SHOW) return;
    try {
      if (this.doc.hidden) {
        this._endVanishWait(true);
        return;
      }
      if (after === AFTER_EFFECTS.HIDE) {
        Promise.resolve(this.doc.update({ hidden: true }))
          .then(() => this._endVanishWait(true))
          .catch((err) => {
            warnLog(`afterEffect "hide" failed; restoring token ${id}`, err);
            this._endVanishWait(false);
          });
      } else if (after === AFTER_EFFECTS.DELETE) {
        Promise.resolve(this.doc.delete())
          .then(() => this._endVanishWait(true))
          .catch((err) => {
            warnLog(`afterEffect "delete" failed; restoring token ${id}`, err);
            this._endVanishWait(false);
          });
      }
    } catch (err) {
      warnLog(`afterEffect "${after}" failed:`, err);
      this._endVanishWait(false);
    }
  }
}

/**
 * True when the current user is allowed to update this token document — the
 * gate for hide/delete after-effects (GMs always pass; owners do too).
 */
function canUpdateDocument(doc) {
  try {
    if (game.user?.isGM) return true;
    return doc?.testUserPermission?.(game.user, "OWNER") === true;
  } catch (err) {
    return false;
  }
}

/** Return a vanished token placeable to normal rendering (Foundry draws per doc state). */
function restorePlaceable(token) {
  try {
    if (!token || token.destroyed) return;
    token.renderable = true;
    token.visible = true;
    if (token.mesh) token.mesh.visible = true;
  } catch (err) {
    debugLog("restorePlaceable failed:", err?.message ?? err);
  }
}

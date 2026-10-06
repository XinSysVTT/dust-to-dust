// Dust to Dust — settings registration and accessors.
// All game settings live in this file; labels and hints come from lang/en.json.
// House style (per local module conventions): plain ESM, no bundler, flat scripts/.

export const MODULE_ID = "dust-to-dust";

/** Values for the "triggerMode" setting. */
export const TRIGGER_MODES = {
  DEAD_STATUS: "deadStatus",
  HP_ZERO: "hpZero",
  MANUAL: "manual",
};

/** Values for the "sweepDirection" setting. */
export const SWEEP_DIRECTIONS = {
  UP: "up",
  DOWN: "down",
  INWARD: "inward",
};

/** Values for the "afterEffect" setting. */
export const AFTER_EFFECTS = {
  HIDE: "hide",
  SHOW: "show",
  DELETE: "delete",
};

/**
 * Defaults. triggerMode defaults to "deadStatus" because on Crucible every
 * death — heroes at full wounds, adversaries at 0 health — applies the core
 * "dead" status (no system death hook exists), so watching the dead status is
 * the one path that catches all Crucible deaths. See README.
 */
export const DEFAULTS = {
  triggerMode: TRIGGER_MODES.DEAD_STATUS,
  sweepDirection: SWEEP_DIRECTIONS.UP,
  dissolveDuration: 3.2,
  particleDensity: 1.0,
  windDirection: 0,
  windStrength: 1.0,
  turbulence: 1.0,
  particleColor: "#0a0a0a",
  afterEffect: AFTER_EFFECTS.HIDE,
  debug: false,
};

/**
 * i18n key builder for settings labels/hints/choices. Registry keys are
 * camelCase but the lang file's section names are PascalCase ("TriggerMode"),
 * matching the house lang style — convert here so generated keys resolve.
 */
const KEY = (key, leaf) => `DUSTTODUST.SETTINGS.${key.charAt(0).toUpperCase()}${key.slice(1)}.${leaf}`;

const WORLD = "world";
const CLIENT = "client";

/** Registration table. Order = order in the settings UI. */
const REGISTRY = [
  {
    key: "triggerMode",
    type: String,
    scope: WORLD,
    default: DEFAULTS.triggerMode,
    choices: [TRIGGER_MODES.DEAD_STATUS, TRIGGER_MODES.HP_ZERO, TRIGGER_MODES.MANUAL],
  },
  {
    key: "sweepDirection",
    type: String,
    scope: WORLD,
    default: DEFAULTS.sweepDirection,
    choices: [SWEEP_DIRECTIONS.UP, SWEEP_DIRECTIONS.DOWN, SWEEP_DIRECTIONS.INWARD],
  },
  {
    key: "dissolveDuration",
    type: Number,
    scope: WORLD,
    default: DEFAULTS.dissolveDuration,
    range: { min: 0.5, max: 8, step: 0.1 },
  },
  {
    key: "particleDensity",
    type: Number,
    scope: WORLD,
    default: DEFAULTS.particleDensity,
    range: { min: 0.2, max: 3, step: 0.05 },
  },
  {
    key: "windDirection",
    type: Number,
    scope: WORLD,
    default: DEFAULTS.windDirection,
    range: { min: 0, max: 360, step: 5 },
  },
  {
    key: "windStrength",
    type: Number,
    scope: WORLD,
    default: DEFAULTS.windStrength,
    range: { min: 0, max: 3, step: 0.05 },
  },
  {
    key: "turbulence",
    type: Number,
    scope: WORLD,
    default: DEFAULTS.turbulence,
    range: { min: 0, max: 3, step: 0.05 },
  },
  {
    key: "particleColor",
    type: String,
    scope: WORLD,
    default: DEFAULTS.particleColor,
  },
  {
    key: "afterEffect",
    type: String,
    scope: WORLD,
    default: DEFAULTS.afterEffect,
    choices: [AFTER_EFFECTS.HIDE, AFTER_EFFECTS.SHOW, AFTER_EFFECTS.DELETE],
  },
  {
    key: "debug",
    type: Boolean,
    scope: CLIENT,
    default: DEFAULTS.debug,
  },
];

/** Register every setting. Called once from the "init" hook. */
export function registerSettings() {
  if (!game?.settings) return;
  for (const def of REGISTRY) {
    const options = {
      name: KEY(def.key, "Name"),
      hint: KEY(def.key, "Hint"),
      scope: def.scope,
      config: true,
      type: def.type,
      default: def.default,
    };
    if (def.choices) {
      options.choices = Object.fromEntries(def.choices.map((value) => [value, KEY(def.key, `Choices.${value}`)]));
    }
    if (def.range) options.range = def.range;
    game.settings.register(MODULE_ID, def.key, options);
  }
}

/**
 * Every i18n path registerSettings() will generate, in registration order.
 * Exported as a seam so tests can assert all of them resolve in lang/en.json.
 */
export function settingI18nPaths() {
  const paths = [];
  for (const def of REGISTRY) {
    paths.push(KEY(def.key, "Name"), KEY(def.key, "Hint"));
    for (const value of def.choices ?? []) paths.push(KEY(def.key, `Choices.${value}`));
  }
  return paths;
}

/** Read a setting; falls back to the default if not (yet) registered. */
export function getSetting(key) {
  try {
    return game.settings.get(MODULE_ID, key);
  } catch (err) {
    return DEFAULTS[key];
  }
}

/** Clamp a number setting or override into a sane range. */
export function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * Parse a "#rrggbb" / "#rgb" color string (or 0xRRGGBB number) into an integer.
 * Returns the near-black default on any failure — the effect is matte black.
 */
export function colorSetting(value) {
  const fallback = 0x0a0a0a;
  try {
    if (typeof value === "number" && Number.isFinite(value)) {
      return Math.min(0xffffff, Math.max(0, Math.round(value)));
    }
    const s = String(value ?? "").trim().replace(/^#/, "");
    if (/^[0-9a-f]{6}$/i.test(s)) return parseInt(s, 16);
    if (/^[0-9a-f]{3}$/i.test(s)) {
      return parseInt(s[0] + s[0] + s[1] + s[1] + s[2] + s[2], 16);
    }
  } catch (err) {
    /* fall through to default */
  }
  return fallback;
}

/** Console logger honoring the debug setting. */
export function debugLog(...args) {
  if (getSetting("debug")) console.log("Dust to Dust |", ...args);
}

/** Always-on warning logger. */
export function warnLog(...args) {
  console.warn("Dust to Dust |", ...args);
}

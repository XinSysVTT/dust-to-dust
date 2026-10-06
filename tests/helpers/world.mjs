// Minimal Foundry world stub for Node tests (house style: zero-dep, node:test).
// Import and call installWorld() before exercising module code — every module
// defers global access to call time, so plain imports are always safe.

export function installWorld({ systemId = "crucible", canvas = undefined } = {}) {
  globalThis.Hooks = {
    once() {},
    on() {},
  };
  globalThis.game = {
    modules: new Map([["dust-to-dust", {}]]),
    settings: {
      register() {},
      get() {
        return undefined; // fall back to DEFAULTS inside the module
      },
    },
    system: { id: systemId },
    user: { isGM: true },
    i18n: {
      localize: (key) => key,
    },
  };
  globalThis.ui = undefined;
  globalThis.canvas = canvas;
  return globalThis.game;
}

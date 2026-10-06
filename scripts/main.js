// Dust to Dust — module entry point.
// Registers settings, exposes the macro API, and wires trigger hooks on ready.

import { MODULE_ID, registerSettings } from "./settings.js";
import { initTriggers } from "./trigger.js";
import { api } from "./api.js";
import { applyVanishedStore } from "./dissolve.js";

Hooks.once("init", () => {
  registerSettings();
  const mod = game.modules.get(MODULE_ID);
  if (mod) mod.api = api;
});

Hooks.once("ready", () => {
  initTriggers();
  const mod = game.modules.get(MODULE_ID);
  if (mod) mod.api = api;
});

// Re-apply vanish rendering to dissolved tokens when a scene canvas loads,
// so hidden corpses stay invisible across page reloads.
Hooks.on("canvasReady", () => applyVanishedStore());

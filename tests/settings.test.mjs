// Tests for scripts/settings.js — i18n parity and helper behavior.
// The i18n parity test would have caught the camelCase/PascalCase key split.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import "./helpers/world.mjs";
import {
  DEFAULTS,
  TRIGGER_MODES,
  SWEEP_DIRECTIONS,
  AFTER_EFFECTS,
  colorSetting,
  clampNumber,
  settingI18nPaths,
} from "../scripts/settings.js";

const lang = JSON.parse(readFileSync(new URL("../lang/en.json", import.meta.url), "utf8"));
function lookup(path) {
  return path.split(".").reduce((node, key) => (node == null ? undefined : node[key]), lang);
}

test("every generated settings i18n path exists in lang/en.json", () => {
  const paths = settingI18nPaths();
  assert.equal(paths.length, 29, "10 settings x (Name+Hint) + 9 choice labels = 29 paths");
  const missing = paths.filter((path) => typeof lookup(path) !== "string");
  assert.deepEqual(missing, [], `missing i18n keys: ${missing.join(", ")}`);
});

test("colorSetting parses hex strings and numbers, falling back to near-black", () => {
  assert.equal(colorSetting("#0a0a0a"), 0x0a0a0a);
  assert.equal(colorSetting("#FFF000"), 0xfff000);
  assert.equal(colorSetting("#fff"), 0xffffff);
  assert.equal(colorSetting(0x123456), 0x123456);
  assert.equal(colorSetting("not-a-color"), 0x0a0a0a);
  assert.equal(colorSetting(undefined), 0x0a0a0a);
  assert.equal(colorSetting(null), 0x0a0a0a);
});

test("clampNumber clamps into range and falls back on non-numbers", () => {
  assert.equal(clampNumber(9, 0, 3, 1), 3);
  assert.equal(clampNumber(-5, 0, 3, 1), 0);
  assert.equal(clampNumber(2, 0, 3, 1), 2);
  assert.equal(clampNumber("x", 0, 3, 1), 1);
  assert.equal(clampNumber(undefined, 0.5, 8, 2.2), 2.2);
});

test("defaults match the documented behavior", () => {
  assert.equal(DEFAULTS.triggerMode, TRIGGER_MODES.DEAD_STATUS);
  assert.equal(DEFAULTS.sweepDirection, SWEEP_DIRECTIONS.UP);
  assert.equal(DEFAULTS.afterEffect, AFTER_EFFECTS.HIDE);
  assert.equal(DEFAULTS.dissolveDuration, 2.2);
  assert.equal(DEFAULTS.particleColor, "#0a0a0a");
});

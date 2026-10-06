// Tests for the public macro API's safety contract: play() never throws and
// degrades to a resolved `false` on invalid input or missing runtime pieces.

import { test } from "node:test";
import assert from "node:assert/strict";

import { installWorld } from "./helpers/world.mjs";
import { api } from "../scripts/api.js";

test("play() with garbage input resolves false (never throws)", async () => {
  installWorld(); // no canvas at all
  assert.equal(await api.play(null), false);
  assert.equal(await api.play(undefined), false);
  assert.equal(await api.play("no-such-token"), false);
  assert.equal(await api.play(12345), false);
  assert.equal(await api.play({}), false);
  assert.equal(await api.play(), false);
});

test("isPlaying() reports nothing running for unknown tokens", () => {
  installWorld();
  assert.equal(api.isPlaying("t1"), false);
});

test("play() on a stubbed token without PIXI degrades to a clean false", async () => {
  // A plausible TokenDocument stub; no PIXI and no DOM exist in Node, so the
  // engine must bail out gracefully (no particle host) and clean up.
  const doc = {
    id: "t1",
    hidden: false,
    w: 100,
    h: 100,
    x: 450,
    y: 450,
    parent: {},
    object: { destroyed: false, mesh: null },
    update: async () => {},
    delete: async () => {},
  };
  installWorld({
    canvas: {
      ready: true,
      tokens: { get: (id) => (id === "t1" ? { document: doc } : null) },
      primary: null,
      grid: { size: 100 },
    },
  });
  assert.equal(await api.play("t1"), false, "by token id");
  assert.equal(api.isPlaying("t1"), false, "active effect registry cleaned up");
  assert.equal(await api.play(doc), false, "by token document reference");
});

test("play() skips tokens that are already hidden", async () => {
  const doc = {
    id: "corpse",
    hidden: true,
    w: 100,
    h: 100,
    x: 0,
    y: 0,
    parent: {},
    object: { destroyed: false, mesh: null },
  };
  installWorld({
    canvas: {
      ready: true,
      tokens: { get: (id) => (id === "corpse" ? { document: doc } : null) },
      primary: null,
      grid: { size: 100 },
    },
  });
  assert.equal(await api.play("corpse"), false, "hidden tokens are skipped before any work");
  assert.equal(api.isPlaying("corpse"), false);
});

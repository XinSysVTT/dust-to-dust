// Tests for the system adapters and trigger-level selection.

import { test } from "node:test";
import assert from "node:assert/strict";

import { installWorld } from "./helpers/world.mjs";
import { getAdapter } from "../scripts/trigger.js";
import crucible from "../scripts/systems/crucible.js";
import generic, { hasDeadStatus } from "../scripts/systems/generic.js";

installWorld({ systemId: "crucible" });

test("adapter selection follows game.system.id", () => {
  assert.equal(getAdapter().id, "crucible");
  globalThis.game.system.id = "dnd5e";
  assert.equal(getAdapter().id, "generic");
  globalThis.game.system.id = "crucible";
  assert.equal(getAdapter().id, "crucible");
});

test("dead-status effect detection (Set, array, flag, icon)", () => {
  assert.equal(hasDeadStatus({ statuses: new Set(["dead"]) }), true);
  assert.equal(hasDeadStatus({ statuses: ["dead"] }), true);
  assert.equal(hasDeadStatus({ flags: { core: { statusId: "dead" } } }), true);
  assert.equal(hasDeadStatus({ icon: "icons/svg/skull.svg" }), true);
  assert.equal(hasDeadStatus({ statuses: new Set(["unconscious"]) }), false);
  assert.equal(hasDeadStatus({ icon: "icons/svg/heart.svg" }), false);
  assert.equal(hasDeadStatus(null), false);
  assert.equal(hasDeadStatus(undefined), false);
  assert.equal(crucible.isDeathEffect({ statuses: new Set(["dead"]) }), true);
  assert.equal(generic.isDeathEffect({ statuses: new Set(["dead"]) }), true);
});

test("Crucible hero vs adversary death semantics", () => {
  // Heroes die at full wounds even with health left (isDead derived flag absent).
  const heroFullWounds = {
    doc: { system: { isDead: false, resources: { wounds: { value: 5, max: 5 }, health: { value: 3, max: 10 } } } },
    change: { system: { resources: { wounds: { value: 5 } } } },
  };
  assert.equal(crucible.isDeathActor(heroFullWounds), true);

  // A hero at 0 health without full wounds is NOT dead (stamina semantics).
  const heroZeroHealth = {
    doc: { system: { isDead: false, resources: { wounds: { value: 2, max: 5 }, health: { value: 0, max: 10 } } } },
    change: { system: { resources: { health: { value: 0 } } } },
  };
  assert.equal(crucible.isDeathActor(heroZeroHealth), false);

  // Adversaries (no meaningful wounds track) die at 0 health.
  const adversaryZeroHealth = {
    doc: { system: { isDead: false, resources: { health: { value: 0, max: 12 } } } },
    change: { system: { resources: { health: { value: 0 } } } },
  };
  assert.equal(crucible.isDeathActor(adversaryZeroHealth), true);

  // A derived isDead flag wins outright.
  const derivedDead = {
    doc: { system: { isDead: true, resources: { health: { value: 0 } } } },
    change: { system: { resources: { health: { value: 0 } } } },
  };
  assert.equal(crucible.isDeathActor(derivedDead), true);

  // Unrelated resource updates never trigger.
  const unrelated = {
    doc: { system: { resources: { health: { value: 4, max: 12 } } } },
    change: { system: { notes: "changed" } },
  };
  assert.equal(crucible.isDeathActor(unrelated), false);
});

test("generic hpZero fallback paths", () => {
  const dnd5eStyle = {
    doc: { system: { attributes: { hp: { value: 0, max: 20 } } } },
    change: { system: { attributes: { hp: { value: 0 } } } },
  };
  assert.equal(generic.isDeathActor(dnd5eStyle), true);

  const hurt = {
    doc: { system: { attributes: { hp: { value: 5, max: 20 } } } },
    change: { system: { attributes: { hp: { value: 5 } } } },
  };
  assert.equal(generic.isDeathActor(hurt), false);

  const flatHp = {
    doc: { system: { hp: { value: 0 } } },
    change: { system: { hp: { value: 0 } } },
  };
  assert.equal(generic.isDeathActor(flatHp), true);

  const noHpChange = {
    doc: { system: { attributes: { hp: { value: 0, max: 20 } } } },
    change: { system: { notes: "changed" } },
  };
  assert.equal(generic.isDeathActor(noHpChange), false);
});

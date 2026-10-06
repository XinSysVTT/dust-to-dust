// Dust to Dust — Crucible system adapter (first-class support).
//
// Crucible v0.10 death facts (crucible-scout board findings, verified against
// the system source at module/dev time):
// - Health data lives at actor.system.resources.health.value/.max; heroes
//   additionally track resources.wounds (dead at wounds.value === wounds.max);
//   adversaries die at health.value === 0.
// - Every death applies the CORE "dead" status: Actor._onUpdate ->
//   toggleStatusEffect("dead") -> an ActiveEffect with status id "dead"
//   (icon icons/svg/skull.svg). Crucible replaces CONFIG.statusEffects but
//   keeps the "dead" id, and it emits no system-specific death hook, so the
//   dead-status hook path is the canonical trigger for all Crucible deaths.

import { hasDeadStatus } from "./generic.js";

export default {
  id: "crucible",

  /** deadStatus mode: identical to the generic check (core "dead" status). */
  isDeathEffect(effect) {
    return hasDeadStatus(effect);
  },

  /**
   * hpZero mode: uses Crucible's own death semantics rather than a bare
   * hp===0 check — for heroes 0 health is not necessarily death, full wounds are.
   */
  isDeathActor({ doc, change }) {
    if (!change?.system?.resources) return false; // only react to resource changes
    try {
      if (doc?.system?.isDead === true) return true;
    } catch (err) {
      /* fall through to explicit resource checks */
    }
    const resources = doc?.system?.resources;
    if (!resources) return false;
    const wounds = resources.wounds;
    if (wounds && Number.isFinite(wounds.max) && wounds.max > 0) {
      return Number.isFinite(wounds.value) && wounds.value >= wounds.max;
    }
    return resources.health?.value === 0;
  },
};

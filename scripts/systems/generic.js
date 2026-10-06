// Dust to Dust — generic system adapter (fallback for any system).
//
// Death representation assumptions for non-Crucible systems:
// - deadStatus mode: any ActiveEffect whose status id (or icon) marks death.
//   Core convention: status id "dead" (CONFIG.specialStatusEffects.DEFEATED),
//   icon icons/svg/skull.svg — most systems follow it.
// - hpZero mode: common hp data paths (system.attributes.hp.value for the
//   dnd5e family, system.hp.value elsewhere); honors a derived system.isDead
//   flag when the system provides one.

/** True when an ActiveEffect carries the dead status. */
export function hasDeadStatus(effect) {
  try {
    const statuses = effect?.statuses;
    if (statuses && typeof statuses.has === "function" && statuses.has("dead")) return true;
    if (Array.isArray(statuses) && statuses.includes("dead")) return true;
    const statusId = effect?.flags?.core?.statusId ?? effect?.getFlag?.("core", "statusId");
    if (statusId === "dead") return true;
    const icon = String(effect?.icon ?? "").toLowerCase();
    return icon.includes("skull") || icon.includes("dead");
  } catch (err) {
    return false;
  }
}

export default {
  id: "generic",

  /** deadStatus mode: core "dead" status detection. */
  isDeathEffect(effect) {
    return hasDeadStatus(effect);
  },

  /** hpZero mode: common hp paths. */
  isDeathActor({ doc, change }) {
    const changed = change?.system;
    if (!changed) return false;
    const hpChanged = changed.attributes?.hp !== undefined || changed.hp !== undefined;
    if (!hpChanged) return false;
    try {
      if (doc?.system?.isDead === true) return true;
    } catch (err) {
      /* fall through to explicit path checks */
    }
    const hp = doc?.system?.attributes?.hp ?? doc?.system?.hp;
    return Number(hp?.value) === 0;
  },
};

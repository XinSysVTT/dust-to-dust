// Dust to Dust — death detection and manual trigger wiring.
//
// Detection per Crucible v0.10 + Foundry v14 platform facts (crucible-scout
// board findings, verified against the local system/core sources):
// - Crucible represents death with the CORE "dead" status: Actor._onUpdate
//   calls toggleStatusEffect("dead"), creating an ActiveEffect with status id
//   "dead" (icon icons/svg/skull.svg). Crucible emits NO system death hook.
// - Foundry v14 TokenDocuments have no overlayEffect/statuses field and status
//   toggles do NOT emit updateToken — so token-level updates are not a viable
//   signal. The robust hook is "createActiveEffect": it fires on every client
//   and its document parent is the Actor (linked tokens), the ActorDelta
//   (unlinked tokens) or the TokenDocument (status applied to a token).
// - "hpZero" mode listens to updateActor / updateActorDelta and delegates the
//   "is this a death?" question to the active system adapter.
//
// The manual path is the Token HUD button plus the macro API (api.js).

import { getSetting, TRIGGER_MODES, debugLog, warnLog } from "./settings.js";
import { playEffect, isPlaying, cancelEffect, cancelAllEffects, pendingVanish } from "./dissolve.js";
import crucibleAdapter from "./systems/crucible.js";
import genericAdapter from "./systems/generic.js";

/** The active system adapter. Crucible gets first-class treatment. */
export function getAdapter() {
  return game.system?.id === "crucible" ? crucibleAdapter : genericAdapter;
}

/** hpZero latch: token id -> last known dead-state. Triggers on false→true. */
const hpDeadLatch = new Map();

/** Register all hooks. Called once on "ready". */
export function initTriggers() {
  Hooks.on("createActiveEffect", (effect, options, userId) => {
    void onDeathStatusEffect(effect);
  });
  Hooks.on("updateActor", (doc, change, options, userId) => {
    void onActorHealthUpdate(doc, change);
  });
  Hooks.on("updateActorDelta", (doc, change, options, userId) => {
    void onActorHealthUpdate(doc, change);
  });
  Hooks.on("renderTokenHUD", onRenderTokenHUD);
  Hooks.on("deleteToken", (doc) => {
    hpDeadLatch.delete(String(doc?.id));
    void cancelEffect(doc?.id, "token-deleted");
  });
  // Not "destroyScene" — that hook does not exist in v14; this is the
  // Foundry hook fired when the scene canvas is torn down.
  Hooks.on("canvasTearDown", () => cancelAllEffects("scene-torn-down"));
  // While a dissolve's hide/delete update is in flight, every refresh re-forces
  // the mesh invisible — otherwise anything that refreshes the token (core,
  // Ember, other modules) flashes the full token back before hidden applies.
  Hooks.on("refreshToken", (token) => {
    if (pendingVanish.has(String(token?.id)) && token.mesh && !token.mesh.destroyed) {
      token.mesh.visible = false;
    }
  });
}

/** deadStatus mode: an ActiveEffect carrying the dead status was created. */
async function onDeathStatusEffect(effect) {
  try {
    if (getSetting("triggerMode") !== TRIGGER_MODES.DEAD_STATUS) return;
    const adapter = getAdapter();
    if (!adapter.isDeathEffect?.(effect)) return;
    for (const tdoc of tokenDocsFromEffectParent(effect?.parent)) {
      void triggerToken(tdoc);
    }
  } catch (err) {
    warnLog("dead-status trigger failed:", err);
  }
}

/**
 * hpZero mode: an actor's (or delta's) health data changed.
 *
 * Uses a per-token transition latch so a token that stays dead across several
 * unrelated updates does not re-animate, while revive (latch cleared on a
 * non-death update) followed by another death does re-animate.
 */
async function onActorHealthUpdate(doc, change) {
  try {
    if (getSetting("triggerMode") !== TRIGGER_MODES.HP_ZERO) return;
    const adapter = getAdapter();
    const nowDead = !!adapter.isDeathActor?.({ doc, change });
    for (const tdoc of tokenDocsFromActorLike(doc)) {
      if (!tdoc?.id) continue;
      const wasDead = hpDeadLatch.get(String(tdoc.id)) ?? false;
      hpDeadLatch.set(String(tdoc.id), nowDead); // update or clear on every health update
      if (nowDead && !wasDead) void triggerToken(tdoc);
    }
  } catch (err) {
    warnLog("hp-zero trigger failed:", err);
  }
}

/**
 * Resolve the tokens an ActiveEffect parent governs.
 * - TokenDocument (status applied directly to a token): itself.
 * - Actor (linked tokens): its active token documents in the viewed scene.
 * - ActorDelta (unlinked token actor): its owning token document.
 */
function tokenDocsFromEffectParent(parent) {
  try {
    if (parent?.documentName === "Token") return [parent];
    if (parent?.documentName === "ActorDelta") {
      const td = parent.token ?? parent.parent;
      return td?.documentName === "Token" ? [td] : [];
    }
    if (typeof parent?.getActiveTokens === "function") {
      const docs = parent.getActiveTokens(true, true);
      if (Array.isArray(docs)) return docs.filter(Boolean);
    }
  } catch (err) {
    debugLog("token resolution from effect parent failed:", err);
  }
  return [];
}

/** Resolve tokens for an updateActor / updateActorDelta document. */
function tokenDocsFromActorLike(doc) {
  try {
    if (doc?.documentName === "ActorDelta") {
      const td = doc.token ?? doc.parent;
      return td?.documentName === "Token" ? [td] : [];
    }
    if (typeof doc?.getActiveTokens === "function") {
      const docs = doc.getActiveTokens(true, true);
      if (Array.isArray(docs)) return docs.filter(Boolean);
    }
  } catch (err) {
    debugLog("token resolution from actor failed:", err);
  }
  return [];
}

/** Fire the effect for one token document, honoring the skip conditions. */
function triggerToken(tdoc) {
  if (!tdoc?.id) return;
  if (tdoc.hidden) return; // already hidden: nothing to dissolve
  if (isPlaying(tdoc.id)) return; // never animate the same token twice
  return playEffect(tdoc);
}

/** TokenHUD button — the manual path, which doubles as the testing path. */
function onRenderTokenHUD(hud, html, data) {
  try {
    const tokenId = data?._id ?? data?.tokenId;
    const token = canvas?.tokens?.get(tokenId);
    if (!token) return;
    const $ = globalThis.$;
    if (!$) return;
    const $html = $(html);
    if ($html.find(".dtd-dissolve").length) return;
    const label = game.i18n.localize("DUSTTODUST.HUD.Dissolve");
    const $btn = $(`<div class="control-icon dtd-dissolve" title="${label}" data-tooltip="${label}"><i class="fas fa-wind"></i></div>`);
    // v14: the right column is always visible; the status-effects palette is
    // collapsible, so placing the button inside it would hide it by default.
    let $host = $html.find(".col.right").first();
    if (!$host.length) $host = $html.find(".col.right .effects").first();
    if (!$host.length) $host = $html;
    $host.append($btn);
    $btn.on("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      void playEffect(token.document);
      hud?.clear?.();
    });
  } catch (err) {
    warnLog("HUD button failed:", err);
  }
}

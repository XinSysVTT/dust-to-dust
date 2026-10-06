// Dust to Dust — public API, exposed as game.modules.get("dust-to-dust").api.
//
// Usage:
//   game.modules.get("dust-to-dust").api.play(tokenOrId, {overrides});
//   await game.modules.get("dust-to-dust").api.play("abc123", { windDirection: 180 });
//
// play() never throws: invalid input resolves to false after a warning. See
// README.md for the full macro example.

import { playEffect, isPlaying, cancelEffect, cancelAllEffects } from "./dissolve.js";

export const api = {
  /** Play the dissolve effect. Resolves true when it finished, false when skipped. */
  play: playEffect,
  /** Is the effect currently running on this token id? */
  isPlaying,
  /** Cancel a running effect (token deleted, scene torn down, manual cancel). */
  cancel: cancelEffect,
  /** Cancel every running effect. */
  cancelAll: cancelAllEffects,
};

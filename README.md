# Dust to Dust

**A Frieren-style death animation for FoundryVTT tokens — the body crumbles into matte black dust that lingers a beat, then the wind scatters it away. Built Crucible-first.**

| | |
|---|---|
| Module version | 0.1.0 |
| Foundry VTT | v14 (minimum 14, verified 14.368) |
| First-class system | [Crucible](https://github.com/XinSysVTT/crucible) 0.10+ |
| Other systems | Generic adapter (core `dead` status / common HP paths) |
| License | MIT |

## What it does

When a token dies — or when you tell it to — Dust to Dust plays one effect and plays it well:

1. **Crumble** — a custom shader dissolves the token's artwork edge-to-edge (rising, sinking, or collapsing inward, your choice) with a ragged, matte front. No glow. Pixels near the front darken briefly, as if losing cohesion.
2. **Dust** — particles spawn exactly at the crumbling front, sampled from the token's actual artwork: they drift loose for a moment, then the wind takes over, wobbling with turbulence. About one particle in five is a long-lived wisp that trails behind the main cloud.
3. **Aftermath** — the token is hidden (default), kept visible as a corpse, or deleted, depending on your setting. Deleting is GM-only and only happens if you explicitly ask for it.

The total effect runs about 4.5–5 seconds on a Medium token (~950 particles at density 1.0, scaling with token size and capped for very large creatures).

## Install

Place this folder (or a copy) in your Foundry `Data/modules/` directory, or run the deploy script from *Development* below, then enable **Dust to Dust** in your world's Module Settings.

## Quick start

- **Automatic**: set *Death Trigger* to **Dead status on token** (default). On Crucible this catches every death — heroes at full wounds *and* adversaries at 0 health — because Crucible applies the core `dead` status in both cases. On other systems it catches any status with the core `dead` id or a skull icon.
- **Manual**: hover a token and click the **wind icon** button in the Token HUD, or run the macro below.

### Macro API

```js
// Simplest: dissolve a token by id (or pass a Token / TokenDocument).
await game.modules.get("dust-to-dust").api.play(token);

// From a selected token in a hotbar macro:
const token = canvas.tokens.controlled[0];
if (token) await game.modules.get("dust-to-dust").api.play(token);

// With overrides (any setting can be overridden for one play):
await game.modules.get("dust-to-dust").api.play(token, {
  sweepDirection: "inward",   // "up" | "down" | "inward"
  dissolveDuration: 3.0,      // seconds
  windDirection: 180,         // degrees, 0 = blowing right
  windStrength: 1.5,
  particleColor: "#101018",
  afterEffect: "show",        // "hide" | "show" | "delete"
});
```

`play()` resolves `true` when the effect finished and `false` when it was skipped (invalid target, token already hidden or already dissolving). It never throws.

## Settings

| Setting | Default | Notes |
|---|---|---|
| Death Trigger | Dead status on token | `deadStatus` / `hpZero` / `manual`. See the Crucible note above. |
| Sweep Direction | Up (rises away) | Where the crumbling starts and how it travels. |
| Dissolve Duration | 2.2 s | Time for the sweep to cross the token. |
| Particle Density | 1.0 | Multiplier, 0.2–3. Also scales with token size. |
| Wind Direction | 0° | 0 blows right, 90 down. |
| Wind Strength | 1.0 | How hard the wind carries the dust. |
| Turbulence | 1.0 | How much the dust wobbles. |
| Particle Color | `#0a0a0a` | Near-black; hex string. |
| After The Effect | Hide | Hide token / keep corpse / delete token (destructive, GM only). |
| Debug Logging | Off | Console diagnostics. |

## How it works

```
 death detected (createActiveEffect "dead" ─ or HUD button / macro API)
        │
        ▼
 sampler.js ── reads the token texture once into an offscreen canvas,
        │       keeps every opaque pixel as a dust candidate
        │       (typed arrays, sorted by vanish order, cached per texture)
        ▼
 dissolve.js ── two cooperating layers:
        │   • a PIXI.Filter on the token mesh discards fragments below an
        │     animated, direction-biased noise threshold (the crumble)
        │   • a pooled, batched particle container (PIXI.ParticleContainer,
        │     Pixi 7.4.3) emits candidates exactly at the moving front
        ▼
 wind: crumble drift (0.3 s) → wind + turbulence; ~20% long-lived wisps
        ▼
 afterEffect: hide (default) │ show corpse │ delete token (GM only)
```

- Every death is animated at most once per token; already-hidden tokens are skipped.
- The engine is defensive by design: if any PIXI API mismatches, the shader degrades to a plain alpha fade and the particles still play.
- Effects clean up fully if the token is deleted or the scene changes mid-animation; only one shared ticker loop exists per effect and it is always removed.
- Document mutations (hide/delete) are GM-only; other clients play the visuals.

## System support

- **Crucible** (first-class): death = the core `dead` status applied by the system (`system.resources.health` / `system.resources.wounds` semantics), detected via `createActiveEffect`. The `hpZero` mode uses Crucible's own rules (heroes die at full wounds, adversaries at 0 health).
- **Other systems**: the generic adapter watches for the core `dead` status (`createActiveEffect`) or common HP paths (`system.attributes.hp.value`, `system.hp.value`). A small adapter interface (`scripts/systems/`) makes adding dedicated systems straightforward.

## Known limitations

- The particle host attaches to `canvas.primary` (the Foundry v13+/v14 primary canvas group); very old versions that lack it fall back to the tokens layer.
- If a token is dragged mid-dissolve, the dust stays where the body fell.
- Death by token **deletion** (rather than a death status) is not detected — there is nothing left to dissolve.
- No audio, no chat cards, no per-system config UI — by design.

## Development

Plain browser ESM, no bundler, no dependencies.

```bash
npm run check     # node --check over every script (ESM via package.json)
npm run deploy    # junction this repo into the local Foundry Data/modules
```

Foundry data path defaults to `C:/Users/vilks/AppData/Local/FoundryVTT` and can be overridden with `FOUNDRY_DATA`. `npm run deploy -- --copy` copies instead of linking; `-- --remove` undeploys.

## License

[MIT](LICENSE) — Copyright (c) 2026 Dust to Dust Project.

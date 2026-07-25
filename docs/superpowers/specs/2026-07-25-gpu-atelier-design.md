# GPU Atelier — Design

**Date:** 2026-07-25
**Status:** Approved

An interactive WebGL2 gallery of real-time graphics pieces, centred on a flagship
that has not, as far as I can establish, been built before: a raymarched 3D scene
that performs live gradient descent to become a drawing you make, at 60fps, in a
browser tab.

## Goals

- One genuinely novel interactive piece, executed well.
- Three supporting pieces that are beautiful and well-known-but-hard.
- Zero build step. Clone and open; no bundler, no dependencies, no CI.
- Deployed and publicly viewable on GitHub Pages.

## Non-goals

- Framework abstraction. The shaders are the subject; three.js would hide them.
- Mobile-first. Desktop GPU with a mouse is the target. Degrade, don't optimise.
- Asset pipelines. Everything is procedural.

## Architecture

Static site, ES modules, vanilla JS, WebGL2.

```
index.html            gallery shell
css/style.css
js/gl.js              WebGL2 helper: programs, FBOs, ping-pong, fullscreen pass
js/app.js             piece registry, lifecycle, routing
pieces/<name>/index.js  one self-contained module per piece
```

Each piece exports a uniform interface so the shell can swap them on one canvas
without knowing anything about their internals:

```js
export default {
  id, title, blurb,
  init(gl, canvas, ui) -> state,   // compile, allocate
  frame(state, t, dt),             // render one frame
  resize(state, w, h),
  dispose(state),                  // free every GL object
}
```

`dispose` must release all GL resources. Swapping pieces repeatedly is the main
leak risk, and WebGL contexts are a scarce resource.

## Flagship: Gradient Descent Sculptor

### Premise

The user paints two orthographic targets — front and side. A scene of N SDF
primitives, initially random, optimises its own parameters in real time until its
rendered silhouettes match both drawings. The user watches it happen.

### Why this is hard, and the trick

Naive differentiable rendering estimates gradients by finite differences: two
renders per parameter. At 64 primitives × 8 floats = 512 parameters, that is 1024
renders per optimisation step. Not real-time.

SPSA (Simultaneous Perturbation Stochastic Approximation) perturbs *every*
parameter at once by a random Rademacher vector Δ ∈ {−1,+1}^n and forms

```
ĝᵢ = (L₊ − L₋) / (2·c·Δᵢ)
```

This is an unbiased estimator of the gradient using **two loss evaluations
regardless of dimension**. That is the entire reason this can run at 60fps.

The estimator is noisy, and that is a feature: the scene visibly hunts and
twitches toward the solution rather than gliding, which reads as thinking.

### Constraining to a real solid

A single silhouette leaves depth unconstrained — the optimiser produces a
cardboard cutout. Two orthographic views (front, side) pin the solid. Total cost
is 4 low-resolution renders per step (2 views × 2 SPSA evaluations).

### Parameterisation

Parameters live in a 64×2 `RGBA32F` texture, ping-ponged.

| Texel      | Channels        | Meaning                        |
| ---------- | --------------- | ------------------------------ |
| `(i, 0)`   | `xyz`, `w`      | centre position, radius        |
| `(i, 1)`   | `rgb`, `w`      | colour, blend/roundness weight |

Positions and radii are stored unbounded and squashed through `tanh`/`softplus`
in the shader, so the optimiser works in an unconstrained space and cannot walk
a primitive to an invalid state.

### Per-step pipeline (all GPU-side)

1. **Perturb + render.** Raymarch the smooth-min union at 192² for `θ + cΔ` and
   `θ − cΔ`, for both views. Δ is regenerated from a hash seeded by the step
   counter, so the update pass reproduces exactly the same Δ without storing it.
2. **Loss.** Per-pixel squared error against the target texture, written to a
   192² buffer, then reduced to 1×1 in four 4×4 box-reduction passes.
3. **Update.** A fragment shader covering the 64×2 parameter texture reads the
   two scalar losses, regenerates Δᵢ for its own texel, and applies

   ```
   θ ← θ − aₖ·ĝ  (with momentum β = 0.9)
   aₖ = a₀/(k+1+A)^0.602      cₖ = c₀/(k+1)^0.101
   ```

   the standard SPSA gain schedule.
4. **Beauty pass.** Independently, a full-resolution render of the *current* θ
   with soft shadows and ambient occlusion. This is what the user sees; it is
   decoupled from the optimiser resolution.

### Readback

Loss is read back for the sparkline with `readPixels` on a 1×1 target, throttled
to roughly every 10th frame. A synchronous readback every frame would stall the
pipeline.

### Interaction

- Two paint canvases (front, side) with brush size and colour.
- Preset targets, so the piece is impressive without the user drawing first.
- Live loss sparkline.
- Sliders: primitive count, learning rate, exploration temperature.
- Reset (re-randomise θ, zero the step counter).

## Supporting pieces

**Cathedral** — raymarched Apollonian gasket with volumetric light shafts and
soft shadows. Orbit on drag.

**Fluid** — stable-fluids Navier–Stokes: advect, diverge, Jacobi pressure solve,
project. Dye injection and vorticity confinement. Mouse drives velocity.

**Swarm** — ~250k particles in a GPU state texture, integrated under an
asymmetric attraction matrix between colour species. The matrix is editable live;
small changes produce qualitatively different emergent structure.

## Verification

Graphics resists unit testing, but the flagship has a genuine numeric assertion:
**loss must trend monotonically downward.** Verification drives the page in a real
browser, samples the loss value over several hundred steps, and checks the trend
numerically rather than by eye. Each piece is additionally checked for a clean
console and for correct resource release across repeated swaps.

## Risks

| Risk                                            | Mitigation                                                                     |
| ----------------------------------------------- | ------------------------------------------------------------------------------ |
| `EXT_color_buffer_float` unavailable            | Feature-detect; fall back to `RGBA16F`, and to a static message if neither.     |
| SPSA converges to mush                          | Tune gains; momentum; anneal `c`. Presets are pre-validated to converge.        |
| Optimiser cost starves the beauty pass          | Decouple: run N optimiser steps per displayed frame, N adaptive to frame time.  |
| Scope creep across four pieces                  | Flagship first. Swarm is explicitly the cuttable one, and cutting it is stated. |

## Deployment

Repo `ajwl27/shaders`, public, GitHub Pages from `main` at root. No CI required —
Pages serves the static tree directly. One commit and push per piece as it lands.

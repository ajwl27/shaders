# GPU Atelier

Real-time WebGL2 pieces. No build step, no dependencies, no framework.

**[→ Open the gallery](https://ajwl27.github.io/shaders/)**

---

## The Gradient Descent Sculptor

You draw. A 3D scene of 64 raymarched blobs then *learns to become your drawing*,
live, at 60fps — twitching, overshooting, and settling into shape while you watch.

This is real differentiable rendering, not a fake. The catch with differentiable
rendering is that finite-difference gradients cost two renders **per parameter** —
512 parameters means 1024 renders per step, which is why you normally see this in
papers rather than in browser tabs.

The way around it is [SPSA](https://www.jhuapl.edu/spsa/): perturb *every*
parameter simultaneously by a random ±1 vector `Δ`, render twice, and

```
ĝᵢ = (L₊ − L₋) / (2·c·Δᵢ)
```

is an unbiased gradient estimate for **two renders total, regardless of how many
parameters there are.** The estimate is noisy — and that noise is the best part,
because you can see the scene hunting for the answer instead of gliding to it.

Two orthographic targets (front and side) constrain the result to an actual
solid; one silhouette alone just yields a cardboard cutout.

## Also in the gallery

| Piece         | What it is                                                            |
| ------------- | --------------------------------------------------------------------- |
| **Cathedral** | Raymarched Apollonian fractal, volumetric god-rays, soft shadows.      |
| **Fluid**     | Stable-fluids Navier–Stokes with vorticity confinement. Drag to stir.  |
| **Swarm**     | ~250k GPU particles, live-editable asymmetric attraction matrix.       |

## Running locally

ES modules need a real origin, so `file://` won't work:

```bash
python tools/serve.py
```

Then open <http://localhost:8000>.

Use that rather than `python -m http.server`. On Windows the stdlib server reads
MIME types from the registry, where `.js` is often `text/plain` — and browsers
refuse to execute ES modules served with a non-JavaScript MIME type, so the page
comes up blank with no console error. `tools/serve.py` pins the types and
disables caching.

## Requirements

WebGL2 with `EXT_color_buffer_float`. Any desktop browser from the last several
years. The Sculptor falls back to `RGBA16F` where full float render targets are
unavailable.

## Layout

```
index.html          gallery shell
js/gl.js            WebGL2 helper — programs, FBOs, ping-pong, fullscreen passes
js/app.js           piece registry and lifecycle
pieces/*/index.js   one self-contained module per piece
docs/               design spec
```

Each piece exports `init` / `frame` / `resize` / `dispose` and knows nothing about
the shell.

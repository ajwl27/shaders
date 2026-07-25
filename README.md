# GPU Atelier

Four real-time WebGL2 pieces. No build step, no dependencies, no framework.

**[→ Open the gallery](https://ajwl27.github.io/shaders/)**

| | |
|---|---|
| **[Sculptor](pieces/sculptor/)** | A 3D scene that gradient-descends into your drawing, live. |
| **[Cathedral](pieces/cathedral/)** | Apollonian gasket, volumetric light shafts, soft shadows. |
| **[Fluid](pieces/fluid/)** | Stable-fluids Navier–Stokes with vorticity confinement. |
| **[Swarm](pieces/swarm/)** | 262k particles under an editable asymmetric attraction matrix. |

---

## The Gradient Descent Sculptor

You draw a front view and a side view. A cloud of 96 raymarched blobs then
*learns to become your drawing* — twitching, overshooting, and settling into
shape while you watch, at 60fps.

This is real differentiable rendering, not an animation of one. The reason you
normally see this in papers rather than in browser tabs is cost: finite-
difference gradients need two renders **per parameter**, and 96 primitives is
768 parameters, so 1536 renders per optimisation step.

[SPSA](https://www.jhuapl.edu/spsa/) gets around it. Perturb *every* parameter
at once by a random ±1 vector `Δ`, render twice, and

```
ĝᵢ = (L₊ − L₋) / (2·c·Δᵢ)
```

is an unbiased gradient estimate for **two evaluations total, regardless of
dimension**. The estimate is noisy — and that noise is the best part, because
you can watch the scene hunting for the answer instead of gliding to it.

Two orthographic targets constrain the result to an actual solid. One silhouette
alone leaves depth free and you get a cardboard cutout. The mug preset is the
clearest demonstration: the handle exists in the front view and not in the side,
and that discrepancy is the entire reason the answer has to be three-dimensional.

### What actually made it work

Textbook SPSA converged, but far too slowly to be worth watching. Four changes,
each found by measuring rather than reasoning:

**Localise the gradient.** Standard SPSA reduces the whole error image to one
scalar and steers every parameter with it — one measurement for several hundred
dimensions, mostly reflecting the perturbations of primitives that have nothing
to do with the parameter being updated. But a primitive only changes pixels it
covers. So the update pass instead reads the error *near where each primitive
projects*, out of the 16×16 partial reduction the chain already computes. One
measurement per step becomes N of them, from the same two renders. This is the
single largest change and the reason the piece is worth watching.

**Normalise globally, not per primitive.** Dividing each primitive's signal by
its own running magnitude seems obviously right and is a trap: a primitive in a
region with nothing to do has its pure noise rescaled to full size, random-walks,
and saturates its radius at zero. Half the scene quietly disappeared. One shared
scale keeps relative magnitudes intact, so a primitive with nothing to say stays
still.

**Clamp the raw parameters.** Positions and radii are stored unbounded and
squashed through `tanh`/`sigmoid` on read. Past about `|4|` those derivatives
underflow and a primitive stops responding to any gradient — permanently.
Without a clamp the whole scene drifted to the asymptotes by step 300 and froze
there with an empty silhouette.

**`c₀ = 0.015`, not the 0.4-ish that SPSA convention suggests.** At 0.42 a
perturbation displaced a primitive by more than twice its own radius, so the
finite difference was comparing two unrelated arrangements rather than measuring
a local slope. Fixing this one number improved the converged loss fivefold.

Converged loss on the mug preset is **0.0036**, against **0.175** for an empty
scene — a 48× improvement. It is most of the way there within about half a
second, and runs the whole thing at 8.4 ms/frame on an RTX 3080.

One honest limitation: only two views are constrained, so the result is a
[visual hull](https://en.wikipedia.org/wiki/Visual_hull). It matches your
drawing from the front and from the side and is free to be lumpy in between —
which is exactly what you see when it rotates.

## Swarm

Particle life is normally O(N²): every particle sums a force from every other
one, which caps you at a few thousand and is why most demos of it look sparse.

Swarm never computes a pairwise force. Particles are scattered additively into a
four-channel density grid — one channel per species — which is blurred at two
scales. Each particle reads the *gradient* of the wide blur for attraction
(weighted by its row of the matrix) and the gradient of the narrow blur for
short-range repulsion. Four texture samples per particle instead of N, so the
particle count stops mattering, and the short-range/long-range force split falls
out of the two blur radii rather than being hand-shaped into a curve.

The attraction matrix is deliberately asymmetric — that asymmetry is what
produces chasing and self-assembly instead of blobs. Drag any cell to change it.

## Running locally

ES modules need a real origin, so `file://` won't work:

```bash
python tools/serve.py
```

Then open <http://localhost:8000>.

Use that rather than `python -m http.server`. On Windows the stdlib server reads
MIME types from the registry, where `.js` is often `text/plain` — and browsers
refuse to execute ES modules served with a non-JavaScript MIME type, so the page
comes up blank with nothing in the console. `tools/serve.py` pins the types and
disables caching.

## Requirements

WebGL2 with `EXT_color_buffer_float`. Any desktop browser from the last several
years. Every piece has a resolution slider if your GPU is struggling.

Keys: `H` hides the interface, `F` goes fullscreen, `1`–`4` switch pieces.

## Layout

```
index.html          gallery shell
js/gl.js            WebGL2 helper — programs, FBOs, ping-pong, fullscreen passes
js/ui.js            declarative control panel
js/app.js           piece registry, lifecycle, shared pointer input
pieces/*/index.js   one self-contained module per piece
docs/               design spec
```

Each piece exports `init` / `frame` / `resize` / `dispose` and knows nothing
about the shell. The shell owns pointer input and teardown, so a piece cannot
leak listeners or GL objects across a swap.

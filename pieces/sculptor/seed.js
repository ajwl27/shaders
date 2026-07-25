import { PARAM_ROWS, randomParams } from './shaders.js';

/**
 * Initialise the primitives from the drawing itself.
 *
 * A primitive's x and y are drawn from painted pixels of the front target, and
 * its z from painted pixels of the side target — independently. That is
 * deliberately the *product of the two marginals*, which is the most
 * non-committal guess consistent with both silhouettes: it says where the shape
 * might be without saying anything about how the two views correlate. Carving
 * the actual solid out of that cloud is still entirely the optimiser's job.
 *
 * What it buys is scale. Starting from noise, most primitives spend hundreds of
 * steps just discovering roughly how big the subject is and where it sits.
 *
 * Screen-to-world mapping, matching project() in the shaders:
 *   front pad pixel (px, py) -> world x =  2*px/S - 1,  y = 1 - 2*py/S
 *   side  pad pixel (px, py) -> world z =  1 - 2*px/S,  y = 1 - 2*py/S
 */

const ALPHA_MIN = 40;

function paintedPixels(ctx, size) {
  const d = ctx.getImageData(0, 0, size, size).data;
  const idx = [];
  for (let p = 0; p < size * size; p++) {
    if (d[p * 4 + 3] > ALPHA_MIN) idx.push(p);
  }
  return { idx, data: d };
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const logit = (p) => Math.log(p / (1 - p));

/** Inverse of decodePos: pos = tanh(raw * 0.7) * 1.35 */
const invPos = (pos) => Math.atanh(clamp(pos / 1.35, -0.985, 0.985)) / 0.7;

/** Inverse of decodeRad: r = 0.035 + 0.24 * sigmoid(raw) */
const invRad = (r) => logit(clamp((r - 0.035) / 0.24, 0.012, 0.988));

const invCol = (c) => logit(clamp(c, 0.02, 0.98));

export function seedFromTargets(count, frontCtx, sideCtx, size, seed = 1) {
  const front = paintedPixels(frontCtx, size);
  const side = paintedPixels(sideCtx, size);
  if (front.idx.length < 8 || side.idx.length < 8) return randomParams(count, seed);

  let s = seed >>> 0;
  const rnd = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };

  // Enough discs to cover the painted area with a little overlap.
  const areaFrac = front.idx.length / (size * size);
  const radius = clamp(Math.sqrt((4 * 1.7 * areaFrac) / (Math.PI * count)), 0.05, 0.26);
  const rawRad = invRad(radius);

  const data = new Float32Array(count * PARAM_ROWS * 4);
  const row = (r, i) => (r * count + i) * 4;

  for (let i = 0; i < count; i++) {
    const fp = front.idx[(rnd() * front.idx.length) | 0];
    const sp = side.idx[(rnd() * side.idx.length) | 0];
    const fx = fp % size;
    const fy = (fp / size) | 0;
    const sx = sp % size;

    const jitter = radius * 0.7;
    const x = (2 * fx) / size - 1 + (rnd() - 0.5) * jitter;
    const y = 1 - (2 * fy) / size + (rnd() - 0.5) * jitter;
    const z = 1 - (2 * sx) / size + (rnd() - 0.5) * jitter;

    const a = row(0, i);
    data[a + 0] = invPos(x);
    data[a + 1] = invPos(y);
    data[a + 2] = invPos(z);
    data[a + 3] = rawRad + (rnd() - 0.5) * 0.5;

    // Take the colour from the pixel that placed it.
    const b = row(1, i);
    data[b + 0] = invCol(front.data[fp * 4 + 0] / 255);
    data[b + 1] = invCol(front.data[fp * 4 + 1] / 255);
    data[b + 2] = invCol(front.data[fp * 4 + 2] / 255);
    data[b + 3] = 0;
  }

  for (let i = 0; i < count; i++) data[row(4, i) + 0] = 1e-4;
  return data;
}

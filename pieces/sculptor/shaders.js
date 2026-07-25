import { COMMON } from '../../js/gl.js';

/**
 * Parameter texture layout — width = primitive count, height = 4.
 *
 *   row 0 : raw position xyz, raw radius
 *   row 1 : raw colour rgb,   (unused)
 *   row 2 : momentum for row 0
 *   row 3 : momentum for row 1
 *   row 4 : per-primitive optimiser state — x holds the running mean square of
 *           that primitive's own gradient scale
 *
 * Values are stored unconstrained and squashed on read, so the optimiser works
 * in an unbounded space and can never walk a primitive into an invalid state.
 */
const PARAMS = `
uniform sampler2D uParams;
uniform int uCount;
uniform float uFuse;

float sigmoid(float x) { return 0.5 + 0.5 * tanh(x * 0.5); }  // stable form

vec3  decodePos(vec3 raw)  { return tanh(raw * 0.7) * 1.35; }
float decodeRad(float raw) { return 0.035 + 0.24 * sigmoid(raw); }
vec3  decodeCol(vec3 raw)  { return vec3(sigmoid(raw.x), sigmoid(raw.y), sigmoid(raw.z)); }

// Orthographic view basis. View 0 looks down -Z, view 1 looks down -X.
// Returns (screen u, screen v, depth) with larger depth meaning nearer.
vec3 project(vec3 p, int view) {
  return view == 0 ? vec3(p.x, p.y, p.z) : vec3(-p.z, p.y, p.x);
}
`;

/**
 * SPSA perturbation directions.
 *
 * The two loss evaluations and the update pass must all see the *same* random
 * direction. Rather than store it, every pass regenerates it from a hash of
 * (parameter index, step). That keeps the whole optimiser stateless apart from
 * the parameters themselves.
 */
const RADEMACHER = `
uniform float uC;
uniform int uStep;

uint hashU(uint x) {
  x ^= x >> 16; x *= 0x7feb352du;
  x ^= x >> 15; x *= 0x846ca68bu;
  x ^= x >> 16;
  return x;
}

// +1 or -1, uniformly.
float rade(int idx, int step) {
  uint h = hashU(uint(idx) * 0x9e3779b9u ^ hashU(uint(step) + 0x68bc21ebu));
  return (h & 1u) == 0u ? -1.0 : 1.0;
}

vec4 radeVec(int i, int base, int step) {
  int k = i * 8 + base;
  return vec4(rade(k, step), rade(k + 1, step), rade(k + 2, step), rade(k + 3, step));
}
`;

/**
 * Loss pass.
 *
 * Output channels are (front L+, front L-, side L+, side L-). Critically the
 * two views stay in separate channels *and* keep their own spatial layout,
 * because a primitive lands in different places in the two views and the update
 * pass needs to look up the error near where each primitive actually projects.
 *
 * Silhouettes are analytic. Under orthographic projection the outline of a
 * sphere is exactly a disc, so there is no marching here at all — just a 2D
 * signed distance per primitive, smooth-min'd together.
 */
export const LOSS_FS = `#version 300 es
precision highp float;
out vec4 fragColor;

uniform sampler2D uTargetA;
uniform sampler2D uTargetB;
uniform vec2 uRes;
uniform float uEdge;
uniform float uColourWeight;

${COMMON}
${PARAMS}
${RADEMACHER}

void main() {
  vec2 fc = gl_FragCoord.xy / uRes;
  vec2 uv = fc * 2.0 - 1.0;

  vec4 tA = texture(uTargetA, fc);
  vec4 tB = texture(uTargetB, fc);

  // Combo index = view*2 + sign, matching the output channel order.
  float sd[4];
  vec3 acc[4];
  float wsum[4];
  for (int k = 0; k < 4; k++) { sd[k] = 1e9; acc[k] = vec3(0.0); wsum[k] = 0.0; }

  for (int i = 0; i < 128; i++) {
    if (i >= uCount) break;

    vec4 r0 = texelFetch(uParams, ivec2(i, 0), 0);
    vec4 r1 = texelFetch(uParams, ivec2(i, 1), 0);
    vec4 d0 = radeVec(i, 0, uStep);
    vec4 d1 = radeVec(i, 4, uStep);

    for (int sgn = 0; sgn < 2; sgn++) {
      float e = sgn == 0 ? uC : -uC;
      vec3 pos = decodePos((r0 + e * d0).xyz);
      float rad = decodeRad((r0 + e * d0).w);
      vec3 col = decodeCol((r1 + e * d1).xyz);

      for (int v = 0; v < 2; v++) {
        int k = v * 2 + sgn;
        vec3 pp = project(pos, v);
        float dd = length(uv - pp.xy) - rad;
        sd[k] = smin(sd[k], dd, uFuse);
        // Nearer primitives, and ones that actually cover the pixel, dominate
        // the colour. Without the depth term the far side bleeds through.
        float w = exp(-max(dd, 0.0) * 26.0) * exp(pp.z * 1.5);
        acc[k] += col * w;
        wsum[k] += w;
      }
    }
  }

  vec4 err;
  for (int k = 0; k < 4; k++) {
    vec4 tgt = k < 2 ? tA : tB;
    // Soft coverage. A hard silhouette gives the optimiser no signal until a
    // primitive already overlaps the target; the soft edge is what lets a
    // primitive feel a pull from outside it.
    float cov = 1.0 - smoothstep(-uEdge, uEdge, sd[k]);
    vec3 col = acc[k] / max(wsum[k], 1e-6);
    float e = cov - tgt.a;
    vec3 ce = col - tgt.rgb;
    err[k] = e * e + tgt.a * dot(ce, ce) * uColourWeight;
  }
  fragColor = err;
}`;

/** Box-average reduction. Run twice: 128 -> 16 -> 1. */
export const REDUCE_FS = `#version 300 es
precision highp float;
out vec4 fragColor;
uniform sampler2D uSrc;
uniform int uTaps;

void main() {
  ivec2 base = ivec2(gl_FragCoord.xy) * uTaps;
  vec4 sum = vec4(0.0);
  for (int y = 0; y < 64; y++) {
    if (y >= uTaps) break;
    for (int x = 0; x < 64; x++) {
      if (x >= uTaps) break;
      sum += texelFetch(uSrc, base + ivec2(x, y), 0);
    }
  }
  fragColor = sum / float(uTaps * uTaps);
}`;

/**
 * The SPSA update — localised.
 *
 * Textbook SPSA reduces the whole error image to one scalar per step and uses
 * it to move every parameter:
 *
 *   g = (L+ - L-) / (2c) * D          (D is +/-1, so 1/D == D)
 *
 * That is one measurement to steer several hundred dimensions, and in practice
 * it crawls: the estimate is dominated by the perturbations of primitives that
 * have nothing to do with the parameter being updated.
 *
 * But a primitive only changes pixels it covers. So instead of collapsing the
 * error to a single number, this reads the error image *near where the
 * primitive actually projects*, in both views, from the 16x16 partial reduction
 * that the chain already produces. Every primitive gets its own (L+ - L-), all
 * from the same two renders. One global measurement per step becomes N of them,
 * and the whole thing converges in seconds rather than minutes.
 *
 * The scale is then divided by a running estimate of the *global* gradient
 * magnitude (row 4), which makes the update scale-free — a small doodle and a
 * full-frame shape produce losses orders of magnitude apart, and without this
 * the learning rate would have to be retuned for each.
 *
 * Normalising globally rather than per-primitive is deliberate and was learned
 * the hard way. Per-primitive normalisation divides each primitive's signal by
 * its own magnitude, so a primitive sitting in a region with nothing to do has
 * its pure noise rescaled to full size and random-walks until its radius
 * saturates at zero. Half the scene quietly vanished. Dividing everything by
 * one shared scale keeps the relative magnitudes intact: a primitive with
 * nothing to say stays still.
 */
export const UPDATE_FS = `#version 300 es
precision highp float;
out vec4 fragColor;

uniform sampler2D uMid;
uniform sampler2D uLoss;
uniform float uMidRes;
uniform float uLocality;
uniform float uA;
uniform float uBeta;
uniform float uClip;
uniform float uGain;

${PARAMS}
${RADEMACHER}

/**
 * Weighted sum of the coarse error tiles around a projected primitive.
 * Returns the accumulated tiles; wOut receives the weight total so the caller
 * can normalise. Gaussian falloff sized to the primitive, so a big primitive
 * listens to a wider neighbourhood than a small one.
 */
vec4 gatherLocal(vec2 uvPos, float rad, out float wOut) {
  int res = int(uMidRes);
  float tile = 2.0 / uMidRes;
  float sigma = max(rad, tile * 0.85) * uLocality;
  float inv2s2 = 1.0 / (2.0 * sigma * sigma);

  vec2 centre = (uvPos * 0.5 + 0.5) * uMidRes;
  ivec2 base = ivec2(floor(centre));

  vec4 acc = vec4(0.0);
  float w = 0.0;
  for (int dy = -3; dy <= 3; dy++) {
    for (int dx = -3; dx <= 3; dx++) {
      ivec2 tc = base + ivec2(dx, dy);
      if (tc.x < 0 || tc.y < 0 || tc.x >= res || tc.y >= res) continue;
      vec2 tuv = ((vec2(tc) + 0.5) / uMidRes) * 2.0 - 1.0;
      vec2 d = tuv - uvPos;
      float ww = exp(-dot(d, d) * inv2s2);
      acc += texelFetch(uMid, tc, 0) * ww;
      w += ww;
    }
  }
  wOut = w;
  return acc;
}

void main() {
  int i = int(gl_FragCoord.x);
  int row = int(gl_FragCoord.y);

  // Where this primitive currently sits, unperturbed.
  vec4 r0 = texelFetch(uParams, ivec2(i, 0), 0);
  vec3 pos = decodePos(r0.xyz);
  float rad = decodeRad(r0.w);

  float wA, wB;
  vec4 gA = gatherLocal(project(pos, 0).xy, rad, wA);
  vec4 gB = gatherLocal(project(pos, 1).xy, rad, wB);

  // Channels: (front L+, front L-, side L+, side L-). Take the front pair from
  // the neighbourhood of the front projection and the side pair from the side.
  float lPlus  = gA.x / max(wA, 1e-6) + gB.z / max(wB, 1e-6);
  float lMinus = gA.y / max(wA, 1e-6) + gB.w / max(wB, 1e-6);
  float raw = (lPlus - lMinus) / (2.0 * uC);

  // Shared normaliser: the same fully reduced loss every primitive sees.
  vec4 G = texelFetch(uLoss, ivec2(0, 0), 0);
  float globalRaw = ((G.x + G.z) - (G.y + G.w)) / (2.0 * uC);

  vec4 prevState = texelFetch(uParams, ivec2(i, 4), 0);
  if (row == 4) {
    fragColor = vec4(mix(prevState.x, globalRaw * globalRaw, 0.05), 0.0, 0.0, 0.0);
    return;
  }

  float scale = uGain * raw / (sqrt(max(prevState.x, 1e-16)) + 1e-14);
  scale = clamp(scale, -uClip, uClip);    // one bad step can wreck the scene

  int slot = row - (row / 2) * 2;         // 0 or 1: which parameter row
  vec4 g = scale * radeVec(i, slot * 4, uStep);
  vec4 vPrev = texelFetch(uParams, ivec2(i, slot + 2), 0);
  vec4 vNew = clamp(uBeta * vPrev + g, vec4(-40.0), vec4(40.0));

  if (row >= 2) {
    fragColor = vNew;
    return;
  }

  vec4 theta = texelFetch(uParams, ivec2(i, slot), 0) - uA * vNew;

  // Keep the raw parameters inside the range where the squashing functions
  // still have usable slope. Beyond about |4| the tanh and sigmoid derivatives
  // underflow, the primitive stops responding to any gradient, and it is dead
  // permanently — nothing can pull it back. Without this guard the scene
  // reliably drifted off to the asymptotes and froze there with the silhouette
  // completely empty.
  fragColor = clamp(theta, vec4(-3.6), vec4(3.6));
}`;

/**
 * Beauty pass — a real 3D raymarch of the current parameters. Decoupled from
 * the optimiser resolution, so the thing you watch is full quality while the
 * thing being optimised is 128 pixels square.
 */
export const RENDER_FS = `#version 300 es
precision highp float;
out vec4 fragColor;

uniform vec2 uRes;
uniform float uTime;
uniform mat3 uCam;
uniform vec3 uRo;

${COMMON}
${PARAMS}

const float BOUND = 1.75;

float mapD(vec3 p) {
  float d = 1e9;
  for (int i = 0; i < 128; i++) {
    if (i >= uCount) break;
    vec4 r0 = texelFetch(uParams, ivec2(i, 0), 0);
    d = smin(d, length(p - decodePos(r0.xyz)) - decodeRad(r0.w), uFuse);
  }
  return d;
}

// Same field, but also blends the primitive colours by proximity.
float mapC(vec3 p, out vec3 col) {
  float d = 1e9;
  vec3 acc = vec3(0.0);
  float wsum = 0.0;
  for (int i = 0; i < 128; i++) {
    if (i >= uCount) break;
    vec4 r0 = texelFetch(uParams, ivec2(i, 0), 0);
    vec4 r1 = texelFetch(uParams, ivec2(i, 1), 0);
    float di = length(p - decodePos(r0.xyz)) - decodeRad(r0.w);
    d = smin(d, di, uFuse);
    float w = exp(-max(di, 0.0) * 14.0);
    acc += decodeCol(r1.xyz) * w;
    wsum += w;
  }
  col = acc / max(wsum, 1e-5);
  return d;
}

vec3 normal(vec3 p) {
  const vec2 e = vec2(1.0, -1.0) * 0.0015;
  return normalize(e.xyy * mapD(p + e.xyy) + e.yyx * mapD(p + e.yyx) +
                   e.yxy * mapD(p + e.yxy) + e.xxx * mapD(p + e.xxx));
}

float shadow(vec3 ro, vec3 rd) {
  float res = 1.0, t = 0.03;
  for (int i = 0; i < 20; i++) {
    float h = mapD(ro + rd * t);
    res = min(res, 10.0 * h / t);
    if (res < 0.01 || t > 3.0) break;
    t += clamp(h, 0.02, 0.25);
  }
  return clamp(res, 0.0, 1.0);
}

float occlusion(vec3 p, vec3 n) {
  float occ = 0.0, sca = 1.0;
  for (int i = 0; i < 5; i++) {
    float hr = 0.015 + 0.075 * float(i);
    occ += (hr - mapD(p + n * hr)) * sca;
    sca *= 0.78;
  }
  return clamp(1.0 - 2.2 * occ, 0.0, 1.0);
}

// Ray/sphere intersection against the bound. Most pixels miss the object
// entirely, and skipping the march for those is the single biggest saving here.
bool boundHit(vec3 ro, vec3 rd, out float t0, out float t1) {
  float b = dot(ro, rd);
  float c = dot(ro, ro) - BOUND * BOUND;
  float h = b * b - c;
  if (h < 0.0) return false;
  h = sqrt(h);
  t0 = max(-b - h, 0.0);
  t1 = -b + h;
  return t1 > 0.0;
}

void main() {
  vec2 uv = (gl_FragCoord.xy * 2.0 - uRes) / uRes.y;
  // Long lens, camera pulled back. The optimiser matches *orthographic*
  // silhouettes, and at a short focal length the perspective foreshortening is
  // enough that the shape visibly fails to be the thing that was drawn. This is
  // near enough to orthographic to keep the match honest while still giving the
  // depth cues that make it read as a solid.
  vec3 rd = uCam * normalize(vec3(uv, 4.6));
  vec3 ro = uRo;

  vec3 ld = normalize(vec3(0.62, 0.74, 0.35));
  vec3 col = vec3(0.028, 0.032, 0.040) + 0.020 * vec3(1.0, 0.95, 0.85) *
             pow(clamp(1.0 - length(uv) * 0.55, 0.0, 1.0), 2.0);

  float t0, t1;
  if (boundHit(ro, rd, t0, t1)) {
    float t = t0;
    bool hit = false;
    for (int i = 0; i < 96; i++) {
      float h = mapD(ro + rd * t);
      if (h < 0.0006) { hit = true; break; }
      t += h;
      if (t > t1) break;
    }

    if (hit) {
      vec3 p = ro + rd * t;
      vec3 albedo;
      mapC(p, albedo);
      vec3 n = normal(p);

      float ao = occlusion(p, n);
      float sh = shadow(p + n * 0.006, ld);
      float dif = clamp(dot(n, ld), 0.0, 1.0);
      float dome = clamp(0.5 + 0.5 * n.y, 0.0, 1.0);
      float fre = pow(clamp(1.0 + dot(rd, n), 0.0, 1.0), 4.0);
      vec3 h = normalize(ld - rd);
      float spe = pow(clamp(dot(n, h), 0.0, 1.0), 42.0);

      col = albedo * vec3(1.0, 0.94, 0.86) * dif * mix(0.35, 1.0, sh) * 1.9;
      col += albedo * vec3(0.16, 0.21, 0.32) * dome * ao * 1.1;
      col += albedo * vec3(0.26, 0.13, 0.07) * (1.0 - dome) * ao * 0.5;
      col += vec3(1.0, 0.96, 0.9) * spe * sh * 0.5;
      col += vec3(0.35, 0.55, 0.95) * fre * ao * 0.28;
    }
  }

  col = tonemap(col * 1.15);
  col = pow(col, vec3(0.4545));
  float r2 = dot(gl_FragCoord.xy / uRes - 0.5, gl_FragCoord.xy / uRes - 0.5);
  col *= 1.0 - 0.55 * r2;
  col += (hash12(gl_FragCoord.xy + uTime * 60.0) - 0.5) * 0.016;
  fragColor = vec4(col, 1.0);
}`;

export const PARAM_ROWS = 5;

/** Seeds the parameter texture with a random cloud. */
export function randomParams(count, seed = 1) {
  const data = new Float32Array(count * PARAM_ROWS * 4);
  let s = seed;
  const rnd = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
  const row = (r, i) => (r * count + i) * 4;
  for (let i = 0; i < count; i++) {
    let a = row(0, i);
    data[a + 0] = (rnd() - 0.5) * 1.6;
    data[a + 1] = (rnd() - 0.5) * 1.6;
    data[a + 2] = (rnd() - 0.5) * 1.6;
    data[a + 3] = -1.2 + rnd() * 0.6;      // start small; growing is easier than shrinking
    let b = row(1, i);
    data[b + 0] = (rnd() - 0.5) * 1.5;
    data[b + 1] = (rnd() - 0.5) * 1.5;
    data[b + 2] = (rnd() - 0.5) * 1.5;
    data[b + 3] = 0;
    // rows 2 and 3 (momentum) stay zero
  }
  // Seed each primitive's gradient scale estimate. Starting from zero makes the
  // first few steps divide by nothing and slam into the clip.
  for (let i = 0; i < count; i++) data[row(4, i) + 0] = 1e-4;
  return data;
}

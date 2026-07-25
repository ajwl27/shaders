import { Program, Target, COMMON, draw, bindScreen } from '../../js/gl.js';

/**
 * Cathedral — an Apollonian gasket raymarched with soft shadows, AO and
 * volumetric light shafts.
 *
 * The distance estimator is Inigo Quilez's Apollonian: repeatedly fold space
 * into the unit cell and invert through the origin. Eight folds is enough that
 * the structure reads as architecture rather than as noise.
 *
 * Volumetrics are the expensive part — each sample along the view ray needs its
 * own shadow march. It runs at a fraction of display resolution and is upscaled
 * in the composite, which is invisible because light shafts have no high
 * frequencies to lose.
 */

const SCENE_FS = `#version 300 es
precision highp float;
out vec4 fragColor;

uniform vec2 uRes;
uniform float uTime;
uniform vec3 uRo;
uniform mat3 uCam;
uniform float uScale;
uniform float uFog;
uniform float uPalette;
uniform float uChroma;
uniform float uGlow;
uniform int uVolSteps;

${COMMON}

vec4 gOrb;

// Apollonian distance estimator. gOrb captures how close the orbit came to each
// axis and to the origin — the cheapest good source of surface colour there is.
float map(vec3 p) {
  float scale = 1.0;
  vec4 orb = vec4(1000.0);
  for (int i = 0; i < 8; i++) {
    p = -1.0 + 2.0 * fract(0.5 * p + 0.5);
    float r2 = dot(p, p);
    orb = min(orb, vec4(abs(p), r2));
    float k = uScale / r2;
    p *= k;
    scale *= k;
  }
  gOrb = orb;
  return 0.25 * abs(p.y) / scale;
}

// Distance only — skips the orbit trap bookkeeping for shadow and AO taps.
float mapFast(vec3 p) {
  float scale = 1.0;
  for (int i = 0; i < 8; i++) {
    p = -1.0 + 2.0 * fract(0.5 * p + 0.5);
    float k = uScale / dot(p, p);
    p *= k;
    scale *= k;
  }
  return 0.25 * abs(p.y) / scale;
}

float trace(vec3 ro, vec3 rd, float tmax) {
  float t = 0.008;
  for (int i = 0; i < 180; i++) {
    vec3 p = ro + rd * t;
    float h = map(p);
    if (h < 0.00035 * t) return t;
    t += h * 0.85;
    if (t > tmax) break;
  }
  return -1.0;
}

vec3 normal(vec3 p) {
  const vec2 e = vec2(1.0, -1.0) * 0.0008;
  return normalize(
    e.xyy * mapFast(p + e.xyy) + e.yyx * mapFast(p + e.yyx) +
    e.yxy * mapFast(p + e.yxy) + e.xxx * mapFast(p + e.xxx));
}

// Penumbra from the closest approach of the shadow ray — Quilez's soft shadow.
float softShadow(vec3 ro, vec3 rd, float k) {
  float res = 1.0, t = 0.012;
  for (int i = 0; i < 40; i++) {
    float h = mapFast(ro + rd * t);
    res = min(res, k * h / t);
    if (res < 0.004 || t > 3.0) break;
    t += clamp(h, 0.006, 0.08);
  }
  return clamp(res, 0.0, 1.0);
}

float occlusion(vec3 p, vec3 n) {
  float occ = 0.0, sca = 1.0;
  for (int i = 0; i < 5; i++) {
    float hr = 0.008 + 0.06 * float(i);
    occ += (hr - mapFast(p + n * hr)) * sca;
    sca *= 0.82;
  }
  return clamp(1.0 - 2.6 * occ, 0.0, 1.0);
}

vec3 palette(float t) {
  return 0.5 + 0.5 * cos(6.28318 * (t + vec3(0.0, 0.33, 0.67) + uPalette));
}

const vec3 SUN = vec3(1.0, 0.84, 0.58);

// Deep, cold nave. Kept dark so the shafts and the lit stone carry the image.
vec3 sky(vec3 rd, vec3 ld) {
  vec3 base = mix(vec3(0.014, 0.017, 0.026), vec3(0.030, 0.042, 0.068),
                  clamp(rd.y * 0.5 + 0.5, 0.0, 1.0));
  float sun = pow(clamp(dot(rd, ld), 0.0, 1.0), 220.0);
  return base + SUN * sun * 1.4;
}

void main() {
  vec2 uv = (gl_FragCoord.xy * 2.0 - uRes) / uRes.y;
  vec3 rd = uCam * normalize(vec3(uv, 1.55));
  vec3 ro = uRo;

  vec3 ld = normalize(vec3(0.55, 0.72, -0.42));

  float tmax = 9.0;
  float t = trace(ro, rd, tmax);

  vec3 col = sky(rd, ld);
  float hitDist = t > 0.0 ? t : tmax;

  if (t > 0.0) {
    vec3 p = ro + rd * t;
    vec3 n = normal(p);
    vec4 orb = gOrb;

    // Orbit traps drive the material. Left as a raw cosine palette the surface
    // reads as an oil slick, so the default is a narrow mineral ramp and
    // uChroma blends toward the full spectrum for anyone who wants it.
    vec3 stone = mix(vec3(0.20, 0.18, 0.155), vec3(0.72, 0.66, 0.55),
                     clamp(orb.y * 1.3, 0.0, 1.0));
    stone *= 0.85 + 0.3 * orb.z;
    vec3 spectral = palette(orb.w * 0.9 + orb.x * 0.35 + 0.1) * (0.30 + 0.42 * orb.y);
    vec3 albedo = mix(stone, spectral, uChroma);

    float ao = occlusion(p, n);
    float sh = softShadow(p, ld, 14.0);
    float dif = clamp(dot(n, ld), 0.0, 1.0);
    float bak = clamp(dot(n, -ld), 0.0, 1.0);
    float dome = clamp(0.5 + 0.5 * n.y, 0.0, 1.0);
    float fre = pow(clamp(1.0 + dot(rd, n), 0.0, 1.0), 5.0);

    vec3 h = normalize(ld - rd);
    float spe = pow(clamp(dot(n, h), 0.0, 1.0), 64.0);

    col = albedo * SUN * dif * sh * 2.9;                       // key
    col += albedo * vec3(0.09, 0.13, 0.22) * dome * ao;        // sky bounce
    col += albedo * vec3(0.16, 0.07, 0.04) * bak * ao * 0.5;   // warm bounce
    col += SUN * spe * sh * 0.9;
    col += vec3(0.25, 0.45, 0.9) * fre * ao * 0.18;
    col += albedo * albedo * uGlow;
  }

  // Volumetric shafts: sample inscattering along the view ray, shadow-testing
  // each sample. Jittered start hides the banding a fixed step would produce.
  if (uFog > 0.0001) {
    float steps = float(uVolSteps);
    float dt = min(hitDist, tmax) / steps;
    float jit = hash12(gl_FragCoord.xy + fract(uTime) * 91.7);
    float tv = dt * jit;
    vec3 acc = vec3(0.0);
    float atten = 1.0;
    for (int i = 0; i < 40; i++) {
      if (i >= uVolSteps) break;
      vec3 p = ro + rd * tv;

      // Short shadow march. Depth matters less than count here — an unoccluded
      // sample resolves in two or three steps.
      float sh = 1.0, ts = 0.02;
      for (int j = 0; j < 12; j++) {
        float hh = mapFast(p + ld * ts);
        sh = min(sh, 9.0 * hh / ts);
        if (sh < 0.02) break;
        ts += clamp(hh, 0.01, 0.14);
      }
      sh = clamp(sh, 0.0, 1.0);

      float dens = uFog * (0.7 + 0.3 * sin(p.y * 3.0 + uTime * 0.2));
      acc += SUN * sh * dens * dt * atten * 0.55;
      atten *= exp(-dens * dt * 0.45);
      tv += dt;
    }
    col = col * atten + acc;
  }

  fragColor = vec4(col, 1.0);
}`;

const COMPOSITE_FS = `#version 300 es
precision highp float;
out vec4 fragColor;
uniform sampler2D uSrc;
uniform vec2 uRes;
uniform float uTime;
uniform float uExposure;

${COMMON}

void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  vec2 d = uv - 0.5;
  float r2 = dot(d, d);

  // Lens dispersion: sample the channels at slightly different radii. Scaled by
  // r^2 so the centre of frame stays clean.
  vec3 col;
  col.r = texture(uSrc, uv - d * r2 * 0.016).r;
  col.g = texture(uSrc, uv).g;
  col.b = texture(uSrc, uv + d * r2 * 0.016).b;

  col = tonemap(col * uExposure);
  col = pow(col, vec3(0.4545));
  col = clamp((col - 0.5) * 1.14 + 0.5, 0.0, 1.0);         // gentle S of contrast
  col *= 1.0 - 0.62 * r2;                                  // vignette
  col += (hash12(gl_FragCoord.xy + uTime * 60.0) - 0.5) * 0.02;  // grain
  fragColor = vec4(col, 1.0);
}`;

export default {
  id: 'cathedral',
  title: 'Cathedral',
  tag: 'Apollonian gasket, volumetric light',
  blurb:
    'An Apollonian sphere packing, distance-estimated and lit with soft shadows and volumetric shafts. Drag to orbit, scroll to fly in.',

  init(gl, canvas, ui, ctx) {
    const s = {
      scene: new Program(gl, SCENE_FS),
      composite: new Program(gl, COMPOSITE_FS),
      target: null,
      width: 1,
      height: 1,
      input: ctx.input,
      yaw: 0,
      pitch: 0,
      reach: 1.75,
      pathT: 4.0,
      speed: 0.32,
      scale: 1.2,
      fog: 0.055,
      glow: 0.05,
      palette: 0.12,
      chroma: 0.22,
      exposure: 1.1,
      volSteps: 26,
      quality: 0.8,
      drift: true,
    };

    ui.group('form');
    ui.slider('packing', { min: 1.02, max: 1.42, value: s.scale, step: 0.001 },
      (v) => { s.scale = v; });
    ui.slider('chroma', { min: 0, max: 1, value: s.chroma, step: 0.001 },
      (v) => { s.chroma = v; });
    ui.slider('hue', { min: 0, max: 1, value: s.palette, step: 0.001 },
      (v) => { s.palette = v; });
    ui.slider('emission', { min: 0, max: 0.4, value: s.glow, step: 0.001, format: (v) => v.toFixed(3) },
      (v) => { s.glow = v; });

    ui.group('atmosphere');
    ui.slider('fog density', { min: 0, max: 0.28, value: s.fog, step: 0.001, format: (v) => v.toFixed(3) },
      (v) => { s.fog = v; });
    ui.slider('shaft samples', { min: 8, max: 40, value: s.volSteps, step: 1, format: (v) => v.toFixed(0) },
      (v) => { s.volSteps = v | 0; });
    ui.slider('exposure', { min: 0.4, max: 2.2, value: s.exposure, step: 0.01 },
      (v) => { s.exposure = v; });

    ui.group('render');
    ui.slider('resolution', { min: 0.4, max: 1, value: s.quality, step: 0.05, format: (v) => `${(v * 100) | 0}%` },
      (v) => { s.quality = v; this.resize(s, s.reqW, s.reqH); });
    ui.slider('drift speed', { min: 0, max: 1.2, value: s.speed, step: 0.01 },
      (v) => { s.speed = v; });
    ui.toggle('drift', true, (v) => { s.drift = v; });
    ui.note('Drag to look around · scroll to widen or tighten the flight path.');

    return s;
  },

  resize(s, w, h) {
    s.reqW = w;
    s.reqH = h;
    const rw = Math.max(1, Math.round(w * s.quality));
    const rh = Math.max(1, Math.round(h * s.quality));
    if (s.target && s.target.width === rw && s.target.height === rh) return;
    if (s.target) s.target.dispose();
    const gl = s.scene.gl;
    s.target = new Target(gl, rw, rh, {
      internal: gl.RGBA16F, format: gl.RGBA, type: gl.HALF_FLOAT, filter: gl.LINEAR,
    });
    s.width = w;
    s.height = h;
  },

  frame(s, t, dt) {
    const gl = s.scene.gl;
    const inp = s.input;

    if (inp.down) {
      s.yaw -= inp.dx * 0.005;
      s.pitch = Math.max(-1.2, Math.min(1.2, s.pitch + inp.dy * 0.005));
    }
    if (inp.wheel) s.reach = Math.max(0.7, Math.min(3.4, s.reach * (1 + inp.wheel * 0.07)));
    if (s.drift) s.pathT += dt * s.speed;

    // Incommensurate frequencies, so the path never repeats and keeps finding
    // its way down the gaps between spheres rather than burying the camera in
    // one. Orbiting a fixed centre puts you inside a sphere almost immediately.
    const T = s.pathT;
    const ro = [
      s.reach * Math.cos(0.10 + 0.33 * T),
      s.reach * 0.42 + 0.34 * Math.cos(0.37 * T),
      s.reach * Math.cos(0.50 + 0.35 * T),
    ];
    const ta = [
      s.reach * 0.62 * Math.cos(1.20 + 0.41 * T),
      s.reach * 0.34 + 0.14 * Math.cos(0.27 * T),
      s.reach * 0.62 * Math.cos(2.00 + 0.31 * T),
    ];

    // Look-at basis, then drag applies yaw/pitch on top so the user can look
    // around without leaving the path.
    let fwd = norm([ta[0] - ro[0], ta[1] - ro[1], ta[2] - ro[2]]);
    let right = norm(cross(fwd, [0, 1, 0]));
    let up = cross(right, fwd);

    const cy = Math.cos(s.yaw), sy = Math.sin(s.yaw);
    fwd = [fwd[0] * cy + right[0] * sy, fwd[1] * cy + right[1] * sy, fwd[2] * cy + right[2] * sy];
    right = norm(cross(fwd, up));
    const cp2 = Math.cos(s.pitch), sp2 = Math.sin(s.pitch);
    fwd = norm([fwd[0] * cp2 + up[0] * sp2, fwd[1] * cp2 + up[1] * sp2, fwd[2] * cp2 + up[2] * sp2]);
    up = cross(right, fwd);

    const cam = new Float32Array([
      right[0], right[1], right[2],
      up[0], up[1], up[2],
      fwd[0], fwd[1], fwd[2],
    ]);

    s.target.bind();
    s.scene.use().setAll({
      uRes: [s.target.width, s.target.height],
      uTime: t,
      uRo: ro,
      uCam: cam,
      uScale: s.scale,
      uFog: s.fog,
      uPalette: s.palette,
      uChroma: s.chroma,
      uGlow: s.glow,
      uVolSteps: s.volSteps,
    });
    draw(gl);

    bindScreen(gl, s.width, s.height);
    s.composite.use().setAll({
      uSrc: s.target.texture,
      uRes: [s.width, s.height],
      uTime: t,
      uExposure: s.exposure,
    });
    draw(gl);
  },

  dispose(s) {
    s.scene.dispose();
    s.composite.dispose();
    if (s.target) s.target.dispose();
  },
};

function norm(v) {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}
function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

import { Program, Target, PingPong, draw, bindScreen, COMMON } from '../../js/gl.js';
import { createMatrix, MATRIX_PRESETS, SPECIES_COLOURS } from './matrix.js';

/**
 * Swarm — particle life at a quarter of a million particles.
 *
 * The usual formulation is O(N^2): every particle sums a force from every other
 * one. That caps you at a few thousand and it is why almost every particle-life
 * demo looks sparse.
 *
 * This one never computes a pairwise force. Each frame the particles are
 * scattered additively into a four-channel density grid — one channel per
 * species — which is then blurred at two scales. A particle reads the
 * *gradient* of the wide blur to get its attraction (weighted by its row of the
 * matrix) and the gradient of the narrow blur to get short-range repulsion.
 *
 * That is a continuum approximation of the same dynamics: four texture samples
 * per particle instead of N. Cost becomes O(N + grid), the particle count stops
 * mattering, and the short-range/long-range split falls out of the two blur
 * radii instead of being hand-shaped into a force curve.
 */

const TEX = 512;              // particle state texture is TEX x TEX
const COUNT = TEX * TEX;      // 262,144
const GRID_H = 256;

const PARTICLE_VS = `#version 300 es
uniform sampler2D uState;
uniform vec2 uDomain;
uniform int uTexW;
uniform float uPointSize;
flat out int vSpecies;
void main() {
  ivec2 tc = ivec2(gl_VertexID % uTexW, gl_VertexID / uTexW);
  vec4 st = texelFetch(uState, tc, 0);
  gl_Position = vec4((st.xy / uDomain) * 2.0 - 1.0, 0.0, 1.0);
  gl_PointSize = uPointSize;
  vSpecies = gl_VertexID & 3;
}`;

const DENSITY_FS = `#version 300 es
precision highp float;
flat in int vSpecies;
out vec4 fragColor;
void main() {
  // One species per channel, so a single RGBA texture carries all four fields
  // and one gradient fetch reads every species at once.
  fragColor = vec4(vSpecies == 0 ? 1.0 : 0.0, vSpecies == 1 ? 1.0 : 0.0,
                   vSpecies == 2 ? 1.0 : 0.0, vSpecies == 3 ? 1.0 : 0.0);
}`;

const DRAW_FS = `#version 300 es
precision highp float;
flat in int vSpecies;
out vec4 fragColor;
uniform vec3 uColours[4];
uniform float uBrightness;
void main() {
  vec2 d = gl_PointCoord - 0.5;
  float a = exp(-dot(d, d) * 11.0);
  fragColor = vec4(uColours[vSpecies] * a * uBrightness, 1.0);
}`;

const BLUR_FS = `#version 300 es
precision highp float;
out vec4 fragColor;
uniform sampler2D uSrc;
uniform vec2 uDir;
uniform vec2 uTexel;
uniform vec2 uRes;

void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  // Nine-tap Gaussian, separable. uDir carries both axis and radius.
  vec2 o = uDir * uTexel;
  vec4 sum = texture(uSrc, uv) * 0.2270270270;
  sum += (texture(uSrc, uv + o * 1.3846153846) + texture(uSrc, uv - o * 1.3846153846)) * 0.3162162162;
  sum += (texture(uSrc, uv + o * 3.2307692308) + texture(uSrc, uv - o * 3.2307692308)) * 0.0702702703;
  fragColor = sum;
}`;

const UPDATE_FS = `#version 300 es
precision highp float;
out vec4 fragColor;

uniform sampler2D uState;
uniform sampler2D uWide;
uniform sampler2D uNarrow;
uniform vec4 uRows[4];
uniform vec2 uDomain;
uniform vec2 uGridTexel;
uniform int uTexW;
uniform float uDt;
uniform float uFriction;
uniform float uAttract;
uniform float uRepel;
uniform float uMaxSpeed;
uniform vec2 uPointer;
uniform float uPointerForce;

void main() {
  ivec2 tc = ivec2(gl_FragCoord.xy);
  int idx = tc.y * uTexW + tc.x;
  int sp = idx & 3;

  vec4 st = texelFetch(uState, tc, 0);
  vec2 pos = st.xy;
  vec2 vel = st.zw;
  vec2 uv = pos / uDomain;

  // Central differences of the wide field: all four species in one fetch each.
  vec4 wl = texture(uWide, uv - vec2(uGridTexel.x, 0.0));
  vec4 wr = texture(uWide, uv + vec2(uGridTexel.x, 0.0));
  vec4 wb = texture(uWide, uv - vec2(0.0, uGridTexel.y));
  vec4 wt = texture(uWide, uv + vec2(0.0, uGridTexel.y));

  vec4 row = uRows[sp];
  vec2 attract = vec2(dot(row, (wr - wl) * 0.5), dot(row, (wt - wb) * 0.5));

  // Short-range repulsion from total density, regardless of species. Without it
  // every mutually-attracting group collapses to a single point and stops.
  vec4 nl = texture(uNarrow, uv - vec2(uGridTexel.x, 0.0));
  vec4 nr = texture(uNarrow, uv + vec2(uGridTexel.x, 0.0));
  vec4 nb = texture(uNarrow, uv - vec2(0.0, uGridTexel.y));
  vec4 nt = texture(uNarrow, uv + vec2(0.0, uGridTexel.y));
  vec2 repel = vec2(dot(nr - nl, vec4(0.5)), dot(nt - nb, vec4(0.5)));

  vec2 force = attract * uAttract - repel * uRepel;

  if (uPointerForce != 0.0) {
    vec2 d = pos - uPointer;
    float r2 = dot(d, d);
    force += normalize(d + 1e-6) * uPointerForce * exp(-r2 * 60.0);
  }

  vel += force * uDt;
  vel *= exp(-uFriction * uDt);
  float sp2 = length(vel);
  if (sp2 > uMaxSpeed) vel *= uMaxSpeed / sp2;

  pos = mod(pos + vel * uDt + uDomain, uDomain);   // torus
  fragColor = vec4(pos, vel);
}`;

const PRESENT_FS = `#version 300 es
precision highp float;
out vec4 fragColor;
uniform sampler2D uSrc;
uniform vec2 uRes;
uniform float uTime;
uniform float uExposure;

${COMMON}

void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  vec3 c = texture(uSrc, uv).rgb * uExposure;
  c = tonemap(c);
  c = pow(c, vec3(0.4545));
  vec2 d = uv - 0.5;
  c *= 1.0 - 0.55 * dot(d, d);
  c += (hash12(gl_FragCoord.xy + uTime * 60.0) - 0.5) * 0.014;
  fragColor = vec4(c, 1.0);
}`;

function drawPoints(gl, n) {
  gl.bindVertexArray(gl._emptyVAO);
  gl.drawArrays(gl.POINTS, 0, n);
}

export default {
  id: 'swarm',
  title: 'Swarm',
  tag: '262k particles, asymmetric attraction',
  blurb:
    'A quarter of a million particles under a four-species attraction matrix. Because forces come from a density field rather than pairwise sums, the particle count is nearly free. Edit the matrix and watch the structure change.',

  init(gl, canvas, ui, ctx) {
    const hf = { internal: gl.RGBA16F, format: gl.RGBA, type: gl.HALF_FLOAT, filter: gl.LINEAR };
    const ff = { internal: gl.RGBA32F, format: gl.RGBA, type: gl.FLOAT, filter: gl.NEAREST };

    const s = {
      gl,
      hf,
      ff,
      input: ctx.input,
      attract: 42,
      repel: 26,
      friction: 2.4,
      maxSpeed: 1.05,
      pointSize: 1.6,
      brightness: 0.30,
      exposure: 1.25,
      wideRadius: 1.5,
      narrowRadius: 0.45,
      timeScale: 1.0,
      width: 1,
      height: 1,
      domain: [1, 1],
    };

    s.update = new Program(gl, UPDATE_FS);
    s.density = new Program(gl, DENSITY_FS, PARTICLE_VS);
    s.drawProg = new Program(gl, DRAW_FS, PARTICLE_VS);
    s.blur = new Program(gl, BLUR_FS);
    s.present = new Program(gl, PRESENT_FS);

    s.state = new PingPong(gl, TEX, TEX, ff);

    const matrix = createMatrix({ onChange: (v) => { s.rows = v; } });
    s.matrix = matrix;
    matrix.set(MATRIX_PRESETS.cells);

    ui.group('attraction matrix');
    ui.custom(matrix.element);
    ui.buttons([['cells', () => matrix.set(MATRIX_PRESETS.cells)],
                ['chase', () => matrix.set(MATRIX_PRESETS.chase)]]);
    ui.buttons([['webs', () => matrix.set(MATRIX_PRESETS.webs)],
                ['random', () => matrix.randomise()]]);

    ui.group('physics');
    ui.slider('attraction', { min: 0, max: 120, value: s.attract, step: 0.5,
      format: (v) => v.toFixed(0) }, (v) => { s.attract = v; });
    ui.slider('repulsion', { min: 0, max: 90, value: s.repel, step: 0.5,
      format: (v) => v.toFixed(0) }, (v) => { s.repel = v; });
    ui.slider('friction', { min: 0.2, max: 8, value: s.friction, step: 0.05 },
      (v) => { s.friction = v; });
    ui.slider('interaction range', { min: 0.4, max: 3.5, value: s.wideRadius, step: 0.05 },
      (v) => { s.wideRadius = v; });
    ui.slider('time scale', { min: 0.1, max: 2.5, value: s.timeScale, step: 0.05 },
      (v) => { s.timeScale = v; });

    ui.group('look');
    ui.slider('point size', { min: 1, max: 4, value: s.pointSize, step: 0.1 },
      (v) => { s.pointSize = v; });
    ui.slider('brightness', { min: 0.05, max: 1.2, value: s.brightness, step: 0.01 },
      (v) => { s.brightness = v; });
    ui.button('scatter', () => { s.reseed = true; });
    ui.note('Drag to push the swarm around.');

    s.reseed = true;
    return s;
  },

  resize(s, w, h) {
    const gl = s.gl;
    const aspect = w / h;
    const gw = Math.max(8, Math.round(GRID_H * aspect));
    const gh = GRID_H;

    s.width = w;
    s.height = h;
    s.domain = [aspect, 1];

    if (s.grid && s.gridW === gw) {
      if (s.scene && (s.scene.width !== w || s.scene.height !== h)) {
        s.scene.dispose();
        s.scene = new Target(gl, w, h, s.hf);
      }
      return;
    }

    for (const key of ['grid', 'blurA', 'wide', 'narrow', 'scene']) {
      if (s[key]) { s[key].dispose(); s[key] = null; }
    }
    // REPEAT wrapping is what makes the domain a torus for the force field too;
    // with CLAMP the edges act like walls that particles pile up against.
    const gopts = { ...s.hf, wrap: gl.REPEAT };
    s.gridW = gw;
    s.gridH = gh;
    s.grid = new Target(gl, gw, gh, gopts);
    s.blurA = new Target(gl, gw, gh, gopts);
    s.wide = new Target(gl, gw, gh, gopts);
    s.narrow = new Target(gl, gw, gh, gopts);
    s.scene = new Target(gl, w, h, s.hf);
    s.reseed = true;
  },

  frame(s, t, dt) {
    const gl = s.gl;
    const step = Math.min(dt, 1 / 45) * s.timeScale;

    if (s.reseed) {
      const data = new Float32Array(COUNT * 4);
      for (let i = 0; i < COUNT; i++) {
        data[i * 4 + 0] = Math.random() * s.domain[0];
        data[i * 4 + 1] = Math.random() * s.domain[1];
      }
      s.state.a.upload(data);
      s.state.b.upload(data);
      s.reseed = false;
    }

    gl.disable(gl.DEPTH_TEST);

    // 1. Scatter particles into the per-species density grid, additively.
    s.grid.bind();
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    s.density.use().setAll({
      uState: s.state.read.texture, uDomain: s.domain, uTexW: TEX, uPointSize: 1.0,
    });
    drawPoints(gl, COUNT);
    gl.disable(gl.BLEND);

    // 2. Two blur scales: wide drives attraction, narrow drives repulsion.
    const texel = [1 / s.gridW, 1 / s.gridH];
    blurInto(s, s.grid.texture, s.wide, s.wideRadius, texel);
    blurInto(s, s.grid.texture, s.narrow, s.narrowRadius, texel);

    // 3. Integrate.
    const inp = s.input;
    s.state.write.bind();
    s.update.use().setAll({
      uState: s.state.read.texture,
      uWide: s.wide.texture,
      uNarrow: s.narrow.texture,
      uRows: s.rows,
      uDomain: s.domain,
      uGridTexel: texel,
      uTexW: TEX,
      uDt: step,
      uFriction: s.friction,
      uAttract: s.attract,
      uRepel: s.repel,
      uMaxSpeed: s.maxSpeed,
      uPointer: [inp.nx * s.domain[0], inp.ny * s.domain[1]],
      uPointerForce: inp.down ? 3.2 : 0,
    });
    draw(gl);
    s.state.swap();

    // 4. Draw the particles additively, then tonemap.
    s.scene.bind();
    gl.clearColor(0.012, 0.014, 0.019, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    s.drawProg.use().setAll({
      uState: s.state.read.texture, uDomain: s.domain, uTexW: TEX,
      uPointSize: s.pointSize, uBrightness: s.brightness,
      uColours: COLOUR_ARRAY,
    });
    drawPoints(gl, COUNT);
    gl.disable(gl.BLEND);

    bindScreen(gl, s.width, s.height);
    s.present.use().setAll({
      uSrc: s.scene.texture, uRes: [s.width, s.height], uTime: t, uExposure: s.exposure,
    });
    draw(gl);
  },

  dispose(s) {
    for (const p of [s.update, s.density, s.drawProg, s.blur, s.present]) p.dispose();
    s.state.dispose();
    for (const key of ['grid', 'blurA', 'wide', 'narrow', 'scene']) {
      if (s[key]) s[key].dispose();
    }
    s.matrix.dispose();
  },
};

/** Separable Gaussian from src into dst, via the scratch target. */
function blurInto(s, src, dst, radius, texel) {
  const gl = s.gl;
  s.blurA.bind();
  s.blur.use().setAll({
    uSrc: src, uDir: [radius, 0], uTexel: texel, uRes: [s.gridW, s.gridH],
  });
  draw(gl);

  dst.bind();
  s.blur.use().setAll({
    uSrc: s.blurA.texture, uDir: [0, radius], uTexel: texel, uRes: [s.gridW, s.gridH],
  });
  draw(gl);
}

const COLOUR_ARRAY = new Float32Array(SPECIES_COLOURS.flat());

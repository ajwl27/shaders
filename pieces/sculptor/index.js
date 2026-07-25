import { Program, Target, PingPong, floatFormat, draw, bindScreen } from '../../js/gl.js';
import { LOSS_FS, REDUCE_FS, UPDATE_FS, RENDER_FS, randomParams, PARAM_ROWS } from './shaders.js';
import { seedFromTargets } from './seed.js';
import { createPads } from './pads.js';
import { PRESETS, applyPreset } from './presets.js';

/**
 * Gradient Descent Sculptor.
 *
 * A scene of SDF primitives optimises its own parameters in real time until its
 * rendered silhouettes match two drawings. Everything except the loss readback
 * for the on-screen trace stays on the GPU.
 *
 * See shaders.js for why SPSA rather than finite differences, and why the loss
 * pass evaluates four variants at once.
 */

const LOSS_RES = 128;   // optimiser resolution — nothing to do with display
const MID_RES = 16;     // 128 / 8
const TARGET_RES = 256; // paint canvas resolution
const MAX_COUNT = 128;

export default {
  id: 'sculptor',
  title: 'Sculptor',
  tag: 'a 3D scene that learns your drawing',
  flag: 'new',
  blurb:
    'Draw a front and a side view. A cloud of 3D blobs then performs live gradient descent until its silhouettes match what you drew. Real optimisation, at 60fps, using SPSA.',

  init(gl, canvas, ui, ctx) {
    const fmt = floatFormat(gl);
    if (!fmt) throw new Error('float render targets unavailable (need EXT_color_buffer_float)');

    const s = {
      gl,
      fmt,
      input: ctx.input,
      count: 56,
      step: 0,
      running: true,
      stepsPerFrame: 8,

      // SPSA gains. Exponents are the standard Spall values; the coefficients
      // were swept against the presets rather than guessed.
      //
      // c0 in particular is far smaller than SPSA convention suggests, and it
      // matters enormously — at c0 = 0.42 a perturbation displaced a primitive
      // by about 0.18 in scene units, more than twice its own radius, so the
      // finite difference was measuring a wholly different arrangement rather
      // than a local slope. Dropping it to 0.015 improved the converged loss
      // fivefold on its own.
      a0: 0.0005,
      c0: 0.015,
      beta: 0.85,
      clip: 5.0,
      gain: 0.6,
      // How far around itself a primitive listens for error, as a multiple of
      // its own radius. Too tight and it goes deaf to the shape it should be
      // moving toward; too wide and it drifts back to a single global signal.
      locality: 1.6,

      fuse: 0.14,
      // Coverage softness, annealed wide -> narrow. A wide edge smooths the
      // landscape so distant primitives still feel a pull; a narrow one is
      // needed at the end to resolve the actual outline.
      edgeWide: 0.10,
      edgeFine: 0.018,
      anneal: 900,
      colourWeight: 0.55,
      coldStart: false,

      quality: 0.7,
      // Start dead on the front view. The first thing to see is the silhouette
      // matching what was drawn; the auto-rotate then turns it to reveal that
      // it is an actual solid and not a cutout.
      yaw: 0,
      pitch: 0.04,
      dist: 3.9,
      spin: 0,
      autoSpin: true,

      lastLoss: NaN,
      readCounter: 0,
      width: 1,
      height: 1,
    };

    s.loss = new Program(gl, LOSS_FS);
    s.reduce = new Program(gl, REDUCE_FS);
    s.update = new Program(gl, UPDATE_FS);
    s.render = new Program(gl, RENDER_FS);
    s.blit = new Program(gl, BLIT_FS);
    s.reseeds = 0;

    const f = { internal: fmt.internal, format: fmt.format, type: fmt.type, filter: gl.NEAREST };
    s.errTarget = new Target(gl, LOSS_RES, LOSS_RES, f);
    s.midTarget = new Target(gl, MID_RES, MID_RES, f);
    s.oneTarget = new Target(gl, 1, 1, f);
    s.params = null;
    s.beauty = null;

    /* ------------------------------------------------------------ pads --- */

    const pads = createPads({
      size: TARGET_RES,
      onPaint: () => {
        uploadTargets();
        // Let the gains recover so the optimiser can actually chase the change,
        // but don't throw away everything it has already found.
        s.step = Math.min(s.step, 250);
      },
    });
    s.pads = pads;

    s.targetTex = [makeTargetTexture(gl), makeTargetTexture(gl)];

    function uploadTargets() {
      for (let i = 0; i < 2; i++) {
        gl.bindTexture(gl.TEXTURE_2D, s.targetTex[i]);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, pads.canvases[i]);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      }
    }
    s.uploadTargets = uploadTargets;

    function allocParams() {
      if (s.params) s.params.dispose();
      s.params = new PingPong(gl, s.count, PARAM_ROWS, f);
      const rngSeed = (++s.reseeds * 7919 + s.count * 104729 + 17) | 0;
      const seed = s.coldStart
        ? randomParams(s.count, rngSeed)
        : seedFromTargets(s.count, pads.contexts[0], pads.contexts[1], TARGET_RES, rngSeed);
      s.params.a.upload(seed);
      s.params.b.upload(seed);
      s.step = 0;
      pads.clearHistory();
    }
    s.allocParams = allocParams;

    // Order matters: the seed reads the painted targets, so they have to exist
    // before the parameters are allocated or it silently falls back to noise.
    applyPreset(PRESETS[1], pads.contexts[0], pads.contexts[1], TARGET_RES);
    uploadTargets();
    allocParams();

    /* --------------------------------------------------------- controls --- */

    ui.custom(pads.element);

    ui.group('target');
    ui.buttons(PRESETS.slice(0, 2).map((p) => [p.name, () => loadPreset(s, p)]));
    ui.buttons(PRESETS.slice(2, 4).map((p) => [p.name, () => loadPreset(s, p)]));
    ui.buttons([['clear', () => { pads.clear(); }], ['reseed', () => allocParams()]]);

    ui.group('brush');
    ui.slider('size', { min: 0.02, max: 0.3, value: pads.state.brush, step: 0.005,
      format: (v) => v.toFixed(2) }, (v) => { pads.state.brush = v; });
    ui.custom(swatches(pads));
    ui.toggle('erase', false, (v) => { pads.state.erasing = v; });

    ui.group('optimiser');
    s.lossReadout = ui.readout('loss', '—');
    s.stepReadout = ui.readout('steps', '0');
    ui.slider('learning rate', { min: 0.0001, max: 0.004, value: s.a0, step: 0.0001,
      format: (v) => v.toFixed(4) }, (v) => { s.a0 = v; });
    ui.slider('exploration', { min: 0.004, max: 0.09, value: s.c0, step: 0.001,
      format: (v) => v.toFixed(3) }, (v) => { s.c0 = v; });
    ui.slider('locality', { min: 0.6, max: 6, value: s.locality, step: 0.05 },
      (v) => { s.locality = v; });
    ui.slider('steps / frame', { min: 1, max: 24, value: s.stepsPerFrame, step: 1,
      format: (v) => v.toFixed(0) }, (v) => { s.stepsPerFrame = v | 0; });
    ui.slider('primitives', { min: 8, max: MAX_COUNT, value: s.count, step: 1,
      format: (v) => v.toFixed(0) }, (v) => { s.count = v | 0; allocParams(); });
    ui.toggle('optimising', true, (v) => { s.running = v; });
    ui.toggle('cold start', false, (v) => { s.coldStart = v; });

    ui.group('form');
    ui.slider('fuse', { min: 0.001, max: 0.2, value: s.fuse, step: 0.001,
      format: (v) => v.toFixed(3) }, (v) => { s.fuse = v; });
    ui.slider('colour weight', { min: 0, max: 2, value: s.colourWeight, step: 0.01 },
      (v) => { s.colourWeight = v; });

    ui.group('render');
    ui.slider('resolution', { min: 0.35, max: 1, value: s.quality, step: 0.05,
      format: (v) => `${(v * 100) | 0}%` }, (v) => { s.quality = v; this.resize(s, s.reqW, s.reqH); });
    ui.toggle('auto rotate', true, (v) => { s.autoSpin = v; });
    ui.note('Drag the 3D view to orbit. Paint on the pads and watch it chase.');

    return s;
  },

  resize(s, w, h) {
    s.reqW = w;
    s.reqH = h;
    const gl = s.gl;
    const rw = Math.max(1, Math.round(w * s.quality));
    const rh = Math.max(1, Math.round(h * s.quality));
    if (s.beauty && s.beauty.width === rw && s.beauty.height === rh) return;
    if (s.beauty) s.beauty.dispose();
    s.beauty = new Target(gl, rw, rh, {
      internal: gl.RGBA8, format: gl.RGBA, type: gl.UNSIGNED_BYTE, filter: gl.LINEAR,
    });
    s.width = w;
    s.height = h;
  },

  frame(s, t, dt) {
    const gl = s.gl;

    if (s.running) {
      for (let i = 0; i < s.stepsPerFrame; i++) optimiseStep(s);
      readLoss(s);
    }

    s.pads.drawTrace();
    renderBeauty(s, t, dt);
  },

  dispose(s) {
    s.loss.dispose();
    s.reduce.dispose();
    s.update.dispose();
    s.render.dispose();
    s.blit.dispose();
    s.errTarget.dispose();
    s.midTarget.dispose();
    s.oneTarget.dispose();
    if (s.params) s.params.dispose();
    if (s.beauty) s.beauty.dispose();
    for (const tex of s.targetTex) s.gl.deleteTexture(tex);
    s.pads.dispose();
  },
};

/* ------------------------------------------------------------ optimiser --- */

function optimiseStep(s) {
  const gl = s.gl;
  const k = s.step;

  // Standard SPSA gain decay (Spall): the perturbation shrinks slowly so the
  // estimator keeps exploring, the step shrinks faster so it settles. The floor
  // matters here in a way it does not in offline SPSA — the target can change
  // under the optimiser at any moment, and a fully decayed step can no longer
  // respond to it.
  const c = s.c0 / Math.pow(k + 1, 0.101);
  const a = Math.max(s.a0 / Math.pow(1 + k / 900, 0.602), s.a0 * 0.3);
  const edge = s.edgeFine + (s.edgeWide - s.edgeFine) * Math.exp(-k / s.anneal);

  // 1. Four loss images at once, packed into RGBA.
  s.errTarget.bind();
  s.loss.use().setAll({
    uParams: s.params.read.texture,
    uTargetA: s.targetTex[0],
    uTargetB: s.targetTex[1],
    uRes: [LOSS_RES, LOSS_RES],
    uCount: s.count,
    uFuse: s.fuse,
    uEdge: edge,
    uColourWeight: s.colourWeight,
    uC: c,
    uStep: k,
  });
  draw(gl);

  // 2. Reduce to a single texel: 128 -> 16 -> 1.
  s.midTarget.bind();
  s.reduce.use().setAll({ uSrc: s.errTarget.texture, uTaps: 8 });
  draw(gl);

  s.oneTarget.bind();
  s.reduce.use().setAll({ uSrc: s.midTarget.texture, uTaps: MID_RES });
  draw(gl);

  // 3. Apply the update, reading the 16x16 partial reduction so each primitive
  //    can pick up the error in its own neighbourhood.
  s.params.write.bind();
  s.update.use().setAll({
    uParams: s.params.read.texture,
    uMid: s.midTarget.texture,
    uLoss: s.oneTarget.texture,
    uMidRes: MID_RES,
    uLocality: s.locality,
    uCount: s.count,
    uFuse: s.fuse,
    uA: a,
    uBeta: s.beta,
    uClip: s.clip,
    // Measured, not assumed: a primitive's local (L+ - L-) runs about 1.7x the
    // global one, because far less averaging happens over a handful of tiles
    // than over the whole image. This brings the typical scale to about 1, so
    // the learning rate means what it says and only genuine outliers clip.
    uGain: s.gain,
    uC: c,
    uStep: k,
  });
  draw(gl);
  s.params.swap();

  s.step++;
}

const readPixel = new Float32Array(4);

/**
 * Pull the loss back for the on-screen trace. Throttled — a synchronous
 * readback stalls the pipeline, and one value in ten is plenty for a graph.
 */
function readLoss(s) {
  if (++s.readCounter % 10 !== 0) return;
  const gl = s.gl;
  gl.bindFramebuffer(gl.FRAMEBUFFER, s.oneTarget.fbo);
  try {
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.FLOAT, readPixel);
  } catch {
    return;
  }
  // The four channels are the two perturbed evaluations of each view. Their
  // mean is a fine unbiased stand-in for the loss at the current parameters.
  const v = (readPixel[0] + readPixel[1] + readPixel[2] + readPixel[3]) / 4;
  if (Number.isFinite(v)) {
    s.lastLoss = v;
    s.pads.pushLoss(v);
    s.lossReadout.set(v < 0.001 ? v.toExponential(2) : v.toFixed(5));
    s.stepReadout.set(String(s.step));
  }
}

/* --------------------------------------------------------------- render --- */

function renderBeauty(s, t, dt) {
  const gl = s.gl;
  const inp = s.input;

  if (inp.down) {
    s.yaw -= inp.dx * 0.006;
    s.pitch = Math.max(-1.3, Math.min(1.3, s.pitch + inp.dy * 0.006));
  }
  if (inp.wheel) s.dist = Math.max(2.4, Math.min(9, s.dist * (1 + inp.wheel * 0.08)));
  if (s.autoSpin && !inp.down) s.spin += dt * 0.12;

  const yaw = s.yaw + s.spin;
  const cp = Math.cos(s.pitch);
  const ro = [
    Math.sin(yaw) * cp * s.dist,
    Math.sin(s.pitch) * s.dist,
    Math.cos(yaw) * cp * s.dist,
  ];
  const fwd = norm([-ro[0], -ro[1], -ro[2]]);
  const right = norm(cross(fwd, [0, 1, 0]));
  const up = cross(right, fwd);

  s.beauty.bind();
  s.render.use().setAll({
    uParams: s.params.read.texture,
    uRes: [s.beauty.width, s.beauty.height],
    uTime: t,
    uCount: s.count,
    uFuse: s.fuse,
    uRo: ro,
    uCam: new Float32Array([
      right[0], right[1], right[2],
      up[0], up[1], up[2],
      fwd[0], fwd[1], fwd[2],
    ]),
  });
  draw(gl);

  bindScreen(gl, s.width, s.height);
  s.blit.use().setAll({ uSrc: s.beauty.texture, uRes: [s.width, s.height] });
  draw(gl);
}

const BLIT_FS = `#version 300 es
precision highp float;
out vec4 fragColor;
uniform sampler2D uSrc;
uniform vec2 uRes;
void main() { fragColor = texture(uSrc, gl_FragCoord.xy / uRes); }`;

/* ---------------------------------------------------------------- misc --- */

function loadPreset(s, preset) {
  applyPreset(preset, s.pads.contexts[0], s.pads.contexts[1], TARGET_RES);
  s.uploadTargets();
  s.allocParams();
}

function makeTargetTexture(gl) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
                new Uint8Array([0, 0, 0, 0]));
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return tex;
}

const SWATCHES = ['#d9d2c4', '#3fa8a0', '#d4304a', '#a9743f', '#8f6fd4', '#e0b13c', '#2b2f36'];

function swatches(pads) {
  const wrap = document.createElement('div');
  wrap.className = 'ctl swatches';
  for (const colour of SWATCHES) {
    const b = document.createElement('button');
    b.className = 'swatch' + (colour === pads.state.colour ? ' on' : '');
    b.style.background = colour;
    b.addEventListener('click', () => {
      pads.state.colour = colour;
      wrap.querySelectorAll('.swatch').forEach((el) => el.classList.remove('on'));
      b.classList.add('on');
    });
    wrap.append(b);
  }
  return wrap;
}

function norm(v) {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}
function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

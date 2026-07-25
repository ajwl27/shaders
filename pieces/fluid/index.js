import { Program, Target, PingPong, draw, bindScreen, COMMON } from '../../js/gl.js';

/**
 * Fluid — incompressible Navier–Stokes by Stam's stable-fluids method.
 *
 * Per frame: advect velocity, apply vorticity confinement, take the divergence,
 * relax pressure with Jacobi iterations, subtract the pressure gradient to
 * project back onto the divergence-free field, then advect the dye through it.
 *
 * Everything runs at a fixed simulation grid independent of display resolution.
 * The pressure solve dominates the cost and its iteration count is exposed,
 * because it is the single knob that trades swirl quality against frame rate.
 */

const VERT_QUAD = `#version 300 es
out vec2 vUv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const HEAD = `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 vUv;
out vec4 fragColor;
uniform vec2 uTexel;
`;

const ADVECT_FS = `${HEAD}
uniform sampler2D uVelocity;
uniform sampler2D uSource;
uniform float uDt;
uniform float uDissipation;

void main() {
  // Semi-Lagrangian: trace backwards along the velocity field and read what
  // was there. Unconditionally stable at any timestep, which is the whole point
  // of the method.
  vec2 coord = vUv - uDt * texture(uVelocity, vUv).xy * uTexel;
  vec4 result = texture(uSource, coord);
  fragColor = result / (1.0 + uDissipation * uDt);
}`;

const DIVERGENCE_FS = `${HEAD}
uniform sampler2D uVelocity;

void main() {
  float L = texture(uVelocity, vUv - vec2(uTexel.x, 0.0)).x;
  float R = texture(uVelocity, vUv + vec2(uTexel.x, 0.0)).x;
  float B = texture(uVelocity, vUv - vec2(0.0, uTexel.y)).y;
  float T = texture(uVelocity, vUv + vec2(0.0, uTexel.y)).y;

  // Free-slip walls: mirror the normal component at the boundary.
  vec2 C = texture(uVelocity, vUv).xy;
  if (vUv.x - uTexel.x < 0.0) L = -C.x;
  if (vUv.x + uTexel.x > 1.0) R = -C.x;
  if (vUv.y - uTexel.y < 0.0) B = -C.y;
  if (vUv.y + uTexel.y > 1.0) T = -C.y;

  fragColor = vec4(0.5 * (R - L + T - B), 0.0, 0.0, 1.0);
}`;

const CURL_FS = `${HEAD}
uniform sampler2D uVelocity;

void main() {
  float L = texture(uVelocity, vUv - vec2(uTexel.x, 0.0)).y;
  float R = texture(uVelocity, vUv + vec2(uTexel.x, 0.0)).y;
  float B = texture(uVelocity, vUv - vec2(0.0, uTexel.y)).x;
  float T = texture(uVelocity, vUv + vec2(0.0, uTexel.y)).x;
  fragColor = vec4(0.5 * ((R - L) - (T - B)), 0.0, 0.0, 1.0);
}`;

const VORTICITY_FS = `${HEAD}
uniform sampler2D uVelocity;
uniform sampler2D uCurl;
uniform float uCurlStrength;
uniform float uDt;

void main() {
  float L = texture(uCurl, vUv - vec2(uTexel.x, 0.0)).x;
  float R = texture(uCurl, vUv + vec2(uTexel.x, 0.0)).x;
  float B = texture(uCurl, vUv - vec2(0.0, uTexel.y)).x;
  float T = texture(uCurl, vUv + vec2(0.0, uTexel.y)).x;
  float C = texture(uCurl, vUv).x;

  // Push energy back into the small vortices that the advection step numerically
  // damps out. Without this the fluid goes syrupy within a second or two.
  vec2 force = 0.5 * vec2(abs(T) - abs(B), abs(R) - abs(L));
  force /= length(force) + 1e-4;
  force *= uCurlStrength * C;
  force.y *= -1.0;

  vec2 vel = texture(uVelocity, vUv).xy + force * uDt;
  fragColor = vec4(clamp(vel, -1500.0, 1500.0), 0.0, 1.0);
}`;

const PRESSURE_FS = `${HEAD}
uniform sampler2D uPressure;
uniform sampler2D uDivergence;

void main() {
  float L = texture(uPressure, vUv - vec2(uTexel.x, 0.0)).x;
  float R = texture(uPressure, vUv + vec2(uTexel.x, 0.0)).x;
  float B = texture(uPressure, vUv - vec2(0.0, uTexel.y)).x;
  float T = texture(uPressure, vUv + vec2(0.0, uTexel.y)).x;
  float div = texture(uDivergence, vUv).x;
  fragColor = vec4((L + R + B + T - div) * 0.25, 0.0, 0.0, 1.0);
}`;

const GRADIENT_FS = `${HEAD}
uniform sampler2D uPressure;
uniform sampler2D uVelocity;

void main() {
  float L = texture(uPressure, vUv - vec2(uTexel.x, 0.0)).x;
  float R = texture(uPressure, vUv + vec2(uTexel.x, 0.0)).x;
  float B = texture(uPressure, vUv - vec2(0.0, uTexel.y)).x;
  float T = texture(uPressure, vUv + vec2(0.0, uTexel.y)).x;
  vec2 vel = texture(uVelocity, vUv).xy - vec2(R - L, T - B);
  fragColor = vec4(vel, 0.0, 1.0);
}`;

const SPLAT_FS = `${HEAD}
uniform sampler2D uSource;
uniform vec2 uPoint;
uniform vec3 uColour;
uniform float uRadius;
uniform float uAspect;

void main() {
  vec2 d = vUv - uPoint;
  d.x *= uAspect;
  vec3 splat = exp(-dot(d, d) / uRadius) * uColour;
  fragColor = vec4(texture(uSource, vUv).xyz + splat, 1.0);
}`;

const DISPLAY_FS = `${HEAD}
uniform sampler2D uDye;
uniform float uTime;
uniform float uShade;

${COMMON}

void main() {
  vec3 c = texture(uDye, vUv).rgb;

  // Treat dye density as a height field and light it. Costs one extra gradient
  // and turns a flat colour wash into something with body.
  if (uShade > 0.001) {
    float l = length(texture(uDye, vUv - vec2(uTexel.x, 0.0)).rgb);
    float r = length(texture(uDye, vUv + vec2(uTexel.x, 0.0)).rgb);
    float b = length(texture(uDye, vUv - vec2(0.0, uTexel.y)).rgb);
    float t = length(texture(uDye, vUv + vec2(0.0, uTexel.y)).rgb);
    vec3 n = normalize(vec3(r - l, t - b, 0.22));
    float diff = clamp(dot(n, normalize(vec3(-0.4, 0.6, 0.7))), 0.0, 1.0);
    float spec = pow(clamp(dot(n, normalize(vec3(-0.3, 0.45, 0.84))), 0.0, 1.0), 26.0);
    c = mix(c, c * (0.45 + 0.85 * diff) + spec * 0.35, uShade);
  }

  c = tonemap(c);
  c = pow(c, vec3(0.4545));
  vec2 d = vUv - 0.5;
  c *= 1.0 - 0.5 * dot(d, d);
  c += (hash12(gl_FragCoord.xy + uTime * 60.0) - 0.5) * 0.015;
  fragColor = vec4(c, 1.0);
}`;

const SIM_H = 200;
const DYE_H = 512;

export default {
  id: 'fluid',
  title: 'Fluid',
  tag: 'stable-fluids Navier–Stokes',
  blurb:
    'Incompressible fluid: advection, vorticity confinement, and a Jacobi pressure solve, every frame. Drag to stir it.',

  init(gl, canvas, ui, ctx) {
    const opts = {
      internal: gl.RGBA16F, format: gl.RGBA, type: gl.HALF_FLOAT, filter: gl.LINEAR,
    };

    const s = {
      gl,
      opts,
      input: ctx.input,
      pressureIters: 22,
      curl: 26,
      velDissipation: 0.16,
      dyeDissipation: 0.92,
      splatRadius: 0.00022,
      shade: 0.7,
      force: 5200,
      autoSplat: true,
      nextSplat: 0,
      hue: Math.random(),
      width: 1,
      height: 1,
    };

    s.advect = new Program(gl, ADVECT_FS, VERT_QUAD);
    s.divergence = new Program(gl, DIVERGENCE_FS, VERT_QUAD);
    s.curlProg = new Program(gl, CURL_FS, VERT_QUAD);
    s.vorticity = new Program(gl, VORTICITY_FS, VERT_QUAD);
    s.pressure = new Program(gl, PRESSURE_FS, VERT_QUAD);
    s.gradient = new Program(gl, GRADIENT_FS, VERT_QUAD);
    s.splat = new Program(gl, SPLAT_FS, VERT_QUAD);
    s.display = new Program(gl, DISPLAY_FS, VERT_QUAD);

    ui.group('dynamics');
    ui.slider('vorticity', { min: 0, max: 55, value: s.curl, step: 0.5,
      format: (v) => v.toFixed(1) }, (v) => { s.curl = v; });
    ui.slider('pressure iters', { min: 4, max: 48, value: s.pressureIters, step: 1,
      format: (v) => v.toFixed(0) }, (v) => { s.pressureIters = v | 0; });
    ui.slider('velocity decay', { min: 0, max: 2, value: s.velDissipation, step: 0.01 },
      (v) => { s.velDissipation = v; });
    ui.slider('dye decay', { min: 0, max: 3, value: s.dyeDissipation, step: 0.01 },
      (v) => { s.dyeDissipation = v; });

    ui.group('brush');
    ui.slider('splat size', { min: 0.00004, max: 0.001, value: s.splatRadius, step: 0.00001,
      format: (v) => (v * 10000).toFixed(1) }, (v) => { s.splatRadius = v; });
    ui.slider('force', { min: 500, max: 14000, value: s.force, step: 50,
      format: (v) => v.toFixed(0) }, (v) => { s.force = v; });

    ui.group('look');
    ui.slider('shading', { min: 0, max: 1, value: s.shade, step: 0.01 },
      (v) => { s.shade = v; });
    ui.toggle('idle splats', true, (v) => { s.autoSplat = v; });
    ui.buttons([['clear', () => { s.clear = true; }],
                ['burst', () => { for (let i = 0; i < 7; i++) randomSplat(s); }]]);
    ui.note('Drag to stir. Faster drags inject more momentum.');

    return s;
  },

  resize(s, w, h) {
    const gl = s.gl;
    const aspect = w / h;
    const simH = SIM_H;
    const simW = Math.round(SIM_H * aspect);
    const dyeH = DYE_H;
    const dyeW = Math.round(DYE_H * aspect);

    if (s.velocity && s.simW === simW && s.simH === simH) {
      s.width = w; s.height = h;
      return;
    }
    disposeTargets(s);

    s.simW = simW; s.simH = simH;
    s.dyeW = dyeW; s.dyeH = dyeH;
    s.velocity = new PingPong(gl, simW, simH, s.opts);
    s.pressureTex = new PingPong(gl, simW, simH, s.opts);
    s.dye = new PingPong(gl, dyeW, dyeH, s.opts);
    s.divergenceTex = new Target(gl, simW, simH, s.opts);
    s.curlTex = new Target(gl, simW, simH, s.opts);
    s.width = w; s.height = h;
    s.clear = true;
  },

  frame(s, t, dt) {
    const gl = s.gl;
    const inp = s.input;
    const step = Math.min(dt, 1 / 45);

    if (s.clear) {
      for (const tgt of [s.velocity.a, s.velocity.b, s.dye.a, s.dye.b,
                         s.pressureTex.a, s.pressureTex.b]) {
        tgt.bind();
        gl.clearColor(0, 0, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
      }
      s.clear = false;
      for (let i = 0; i < 5; i++) randomSplat(s);
    }

    // Pointer drag becomes momentum plus dye.
    if (inp.down && (inp.dx || inp.dy)) {
      s.hue = (s.hue + 0.006) % 1;
      splat(s, inp.nx, inp.ny,
            inp.dx * s.force / s.width, -inp.dy * s.force / s.height,
            hsv(s.hue, 0.75, 0.9));
    }

    if (s.autoSplat && t > s.nextSplat) {
      s.nextSplat = t + 1.6 + Math.random() * 2.4;
      randomSplat(s);
    }

    const texel = [1 / s.simW, 1 / s.simH];

    // Vorticity confinement, before projection so the added force gets made
    // divergence-free along with everything else.
    s.curlTex.bind();
    s.curlProg.use().setAll({ uVelocity: s.velocity.read.texture, uTexel: texel });
    draw(gl);

    s.velocity.write.bind();
    s.vorticity.use().setAll({
      uVelocity: s.velocity.read.texture, uCurl: s.curlTex.texture,
      uCurlStrength: s.curl, uDt: step, uTexel: texel,
    });
    draw(gl);
    s.velocity.swap();

    s.divergenceTex.bind();
    s.divergence.use().setAll({ uVelocity: s.velocity.read.texture, uTexel: texel });
    draw(gl);

    // Jacobi relaxation. Each pass propagates pressure information one cell, so
    // the iteration count is literally how far a disturbance can be felt.
    s.pressureTex.read.bind();
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    for (let i = 0; i < s.pressureIters; i++) {
      s.pressureTex.write.bind();
      s.pressure.use().setAll({
        uPressure: s.pressureTex.read.texture,
        uDivergence: s.divergenceTex.texture,
        uTexel: texel,
      });
      draw(gl);
      s.pressureTex.swap();
    }

    s.velocity.write.bind();
    s.gradient.use().setAll({
      uPressure: s.pressureTex.read.texture,
      uVelocity: s.velocity.read.texture,
      uTexel: texel,
    });
    draw(gl);
    s.velocity.swap();

    s.velocity.write.bind();
    s.advect.use().setAll({
      uVelocity: s.velocity.read.texture, uSource: s.velocity.read.texture,
      uDt: step, uDissipation: s.velDissipation, uTexel: texel,
    });
    draw(gl);
    s.velocity.swap();

    s.dye.write.bind();
    s.advect.use().setAll({
      uVelocity: s.velocity.read.texture, uSource: s.dye.read.texture,
      uDt: step, uDissipation: s.dyeDissipation,
      // Velocity texel size, not the dye's. The backtrace has to cover the same
      // distance in uv space whatever grid is being advected — using the dye's
      // finer texel here makes the dye crawl along at a fraction of the speed
      // of the field carrying it.
      uTexel: texel,
    });
    draw(gl);
    s.dye.swap();

    bindScreen(gl, s.width, s.height);
    s.display.use().setAll({
      uDye: s.dye.read.texture, uTexel: [1 / s.dyeW, 1 / s.dyeH],
      uTime: t, uShade: s.shade,
    });
    draw(gl);
  },

  dispose(s) {
    for (const p of [s.advect, s.divergence, s.curlProg, s.vorticity,
                     s.pressure, s.gradient, s.splat, s.display]) p.dispose();
    disposeTargets(s);
  },
};

function disposeTargets(s) {
  for (const key of ['velocity', 'pressureTex', 'dye', 'divergenceTex', 'curlTex']) {
    if (s[key]) { s[key].dispose(); s[key] = null; }
  }
}

/** Add momentum and dye at a point. Coordinates are normalised, y up. */
function splat(s, x, y, dx, dy, colour) {
  const gl = s.gl;
  const aspect = s.simW / s.simH;

  s.velocity.write.bind();
  s.splat.use().setAll({
    uSource: s.velocity.read.texture, uPoint: [x, y],
    uColour: [dx, dy, 0], uRadius: s.splatRadius, uAspect: aspect,
    uTexel: [1 / s.simW, 1 / s.simH],
  });
  draw(gl);
  s.velocity.swap();

  s.dye.write.bind();
  s.splat.use().setAll({
    uSource: s.dye.read.texture, uPoint: [x, y],
    uColour: colour, uRadius: s.splatRadius, uAspect: aspect,
    uTexel: [1 / s.dyeW, 1 / s.dyeH],
  });
  draw(gl);
  s.dye.swap();
}

function randomSplat(s) {
  const x = Math.random();
  const y = Math.random();
  const a = Math.random() * Math.PI * 2;
  const mag = 900 + Math.random() * 1600;
  s.hue = (s.hue + 0.13 + Math.random() * 0.1) % 1;
  splat(s, x, y, Math.cos(a) * mag, Math.sin(a) * mag, hsv(s.hue, 0.8, 1.0));
}

function hsv(h, sa, v) {
  const f = (n) => {
    const k = (n + h * 6) % 6;
    return v - v * sa * Math.max(0, Math.min(Math.min(k, 4 - k), 1));
  };
  return [f(5), f(3), f(1)];
}

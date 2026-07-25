/**
 * Minimal WebGL2 helper.
 *
 * Everything here exists because writing it inline four times would be worse.
 * No abstraction that hides what the GPU is actually doing.
 */

/** Fullscreen triangle. No attribute buffers — derived from gl_VertexID. */
export const FULLSCREEN_VS = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

/**
 * Ask for a context and capture why it failed if it did.
 *
 * Browsers report the actual reason through a `webglcontextcreationerror`
 * event, not through the null return, so a bare getContext() call throws away
 * the only useful information available. "Try a current browser" is a bad
 * message to show someone whose browser is current.
 */
function tryContext(canvas, type, attrs) {
  let reason = '';
  const onError = (e) => { reason = e.statusMessage || ''; };
  canvas.addEventListener('webglcontextcreationerror', onError);
  let ctx = null;
  try {
    ctx = canvas.getContext(type, attrs);
  } catch (e) {
    reason = String((e && e.message) || e);
  }
  canvas.removeEventListener('webglcontextcreationerror', onError);
  return { ctx, reason };
}

export function getContext(canvas) {
  let got = tryContext(canvas, 'webgl2', {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    powerPreference: 'high-performance',
  });

  // Retry bare. A driver that refuses one particular attribute combination will
  // often hand over a default context quite happily.
  if (!got.ctx) got = tryContext(canvas, 'webgl2', undefined);

  if (!got.ctx) {
    getContext.reason = got.reason;
    return null;
  }
  const gl = got.ctx;
  // Requesting these here makes float textures renderable / filterable for
  // every piece; individual pieces still feature-detect before relying on them.
  gl.getExtension('EXT_color_buffer_float');
  gl.getExtension('EXT_color_buffer_half_float');
  gl.getExtension('OES_texture_float_linear');
  gl._emptyVAO = gl.createVertexArray();
  return gl;
}

/**
 * Work out what the browser will actually give us, for the failure screen.
 * A canvas is locked to one context type once asked, so each probe needs its
 * own throwaway.
 */
export function diagnose() {
  const probe = (type) => tryContext(document.createElement('canvas'), type, undefined);

  const two = probe('webgl2');
  const one = two.ctx ? { ctx: two.ctx, reason: '' } : probe('webgl');

  let renderer = '';
  const ctx = two.ctx || one.ctx;
  if (ctx) {
    const dbg = ctx.getExtension('WEBGL_debug_renderer_info');
    renderer = (dbg && ctx.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) ||
               ctx.getParameter(ctx.RENDERER) || '';
  }

  return {
    webgl2: !!two.ctx,
    webgl1: !!one.ctx,
    reason: getContext.reason || two.reason || one.reason || '',
    renderer,
    // SwiftShader is Chrome's CPU fallback. It reports itself as a renderer, so
    // "it works" and "it is using the GPU" are different questions.
    software: /swiftshader|software|llvmpipe|microsoft basic/i.test(renderer),
  };
}

/**
 * Best available float render target format, or null if the GPU has neither.
 * RGBA32F is what the Sculptor wants; RGBA16F costs it precision but works.
 */
export function floatFormat(gl) {
  if (gl.getExtension('EXT_color_buffer_float')) {
    return { internal: gl.RGBA32F, format: gl.RGBA, type: gl.FLOAT, bits: 32 };
  }
  if (gl.getExtension('EXT_color_buffer_half_float')) {
    return { internal: gl.RGBA16F, format: gl.RGBA, type: gl.HALF_FLOAT, bits: 16 };
  }
  return null;
}

function shader(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(s) || '';
    // Prefix line numbers — GLSL errors are useless without them.
    const numbered = src
      .split('\n')
      .map((l, i) => `${String(i + 1).padStart(4)} | ${l}`)
      .join('\n');
    gl.deleteShader(s);
    throw new Error(`shader compile failed:\n${log}\n${numbered}`);
  }
  return s;
}

export class Program {
  constructor(gl, fsSource, vsSource = FULLSCREEN_VS) {
    this.gl = gl;
    const vs = shader(gl, gl.VERTEX_SHADER, vsSource);
    const fs = shader(gl, gl.FRAGMENT_SHADER, fsSource);
    const p = gl.createProgram();
    gl.attachShader(p, vs);
    gl.attachShader(p, fs);
    gl.linkProgram(p);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(p);
      gl.deleteProgram(p);
      throw new Error(`program link failed: ${log}`);
    }
    this.program = p;

    // Reflect uniforms once so set() can dispatch on the real type rather than
    // guessing from the JS value.
    this.uniforms = new Map();
    const count = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < count; i++) {
      const info = gl.getActiveUniform(p, i);
      const name = info.name.replace(/\[0\]$/, '');
      this.uniforms.set(name, {
        loc: gl.getUniformLocation(p, info.name),
        type: info.type,
        size: info.size,
      });
    }
    this._unit = 0;
  }

  use() {
    this.gl.useProgram(this.program);
    this._unit = 0;
    return this;
  }

  /** Set a uniform. Textures are bound to the next free unit automatically. */
  set(name, value) {
    const u = this.uniforms.get(name);
    if (!u) return this; // Dead uniform — optimised out. Silently ignore.
    const gl = this.gl;

    // Array uniforms need the vector forms, and the reflected location is
    // element zero, so one call fills the whole array.
    if (u.size > 1) {
      switch (u.type) {
        case gl.FLOAT: gl.uniform1fv(u.loc, value); break;
        case gl.FLOAT_VEC2: gl.uniform2fv(u.loc, value); break;
        case gl.FLOAT_VEC3: gl.uniform3fv(u.loc, value); break;
        case gl.FLOAT_VEC4: gl.uniform4fv(u.loc, value); break;
        case gl.INT: gl.uniform1iv(u.loc, value); break;
        default: throw new Error(`unhandled array uniform type for "${name}"`);
      }
      return this;
    }

    switch (u.type) {
      case gl.FLOAT: gl.uniform1f(u.loc, value); break;
      case gl.FLOAT_VEC2: gl.uniform2f(u.loc, value[0], value[1]); break;
      case gl.FLOAT_VEC3: gl.uniform3f(u.loc, value[0], value[1], value[2]); break;
      case gl.FLOAT_VEC4: gl.uniform4f(u.loc, value[0], value[1], value[2], value[3]); break;
      case gl.INT: case gl.BOOL: gl.uniform1i(u.loc, value); break;
      case gl.INT_VEC2: gl.uniform2i(u.loc, value[0], value[1]); break;
      case gl.FLOAT_MAT3: gl.uniformMatrix3fv(u.loc, false, value); break;
      case gl.FLOAT_MAT4: gl.uniformMatrix4fv(u.loc, false, value); break;
      case gl.SAMPLER_2D: {
        const unit = this._unit++;
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, value);
        gl.uniform1i(u.loc, unit);
        break;
      }
      default:
        throw new Error(`unhandled uniform type for "${name}"`);
    }
    return this;
  }

  /** Bulk set from an object. */
  setAll(obj) {
    for (const k in obj) this.set(k, obj[k]);
    return this;
  }

  dispose() {
    this.gl.deleteProgram(this.program);
  }
}

/** A texture plus the framebuffer that renders into it. */
export class Target {
  constructor(gl, w, h, opts = {}) {
    const {
      internal = gl.RGBA8,
      format = gl.RGBA,
      type = gl.UNSIGNED_BYTE,
      filter = gl.NEAREST,
      wrap = gl.CLAMP_TO_EDGE,
    } = opts;

    this.gl = gl;
    this.width = w;
    this.height = h;
    this.opts = { internal, format, type, filter, wrap };

    this.texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, type, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);

    this.fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.texture, 0);
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      throw new Error(`incomplete framebuffer (0x${status.toString(16)}) at ${w}x${h}`);
    }
  }

  bind() {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.viewport(0, 0, this.width, this.height);
    return this;
  }

  /** Upload pixel data. `data` must match the target's type. */
  upload(data) {
    const gl = this.gl;
    const { internal, format, type } = this.opts;
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, this.width, this.height, 0, format, type, data);
    return this;
  }

  dispose() {
    this.gl.deleteTexture(this.texture);
    this.gl.deleteFramebuffer(this.fbo);
  }
}

/** Two Targets you alternate between, for iterative simulation. */
export class PingPong {
  constructor(gl, w, h, opts) {
    this.a = new Target(gl, w, h, opts);
    this.b = new Target(gl, w, h, opts);
  }
  get read() { return this.a; }
  get write() { return this.b; }
  swap() { const t = this.a; this.a = this.b; this.b = t; }
  dispose() { this.a.dispose(); this.b.dispose(); }
}

/** Draw the fullscreen triangle. Assumes a program is already bound. */
export function draw(gl) {
  gl.bindVertexArray(gl._emptyVAO);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
}

/** Render to the default framebuffer at the given size. */
export function bindScreen(gl, w, h) {
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.viewport(0, 0, w, h);
}

/** GLSL fragments worth sharing across pieces. */
export const COMMON = `
// Hash without sine — Dave Hoskins, adapted.
float hash11(float p) {
  p = fract(p * 0.1031);
  p *= p + 33.33;
  return fract((p + p) * p);
}
vec3 hash31(float p) {
  vec3 p3 = fract(vec3(p) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xxy + p3.yzz) * p3.zyx);
}
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

// Polynomial smooth minimum — Inigo Quilez.
float smin(float a, float b, float k) {
  float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
  return mix(b, a, h) - k * h * (1.0 - h);
}

mat2 rot(float a) { float c = cos(a), s = sin(a); return mat2(c, -s, s, c); }

// ACES-ish filmic tonemap. Keeps highlights from turning to paste.
vec3 tonemap(vec3 x) {
  const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}
`;

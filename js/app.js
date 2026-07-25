import { getContext } from './gl.js';
import { createUI } from './ui.js';
import { PIECES } from '../pieces/registry.js';

const canvas = document.getElementById('stage');
const gl = getContext(canvas);

if (!gl) {
  document.getElementById('fatal').hidden = false;
  throw new Error('WebGL2 unavailable');
}

/* ------------------------------------------------------------- input --- */

/**
 * Shared pointer state. The shell owns the listeners so pieces never have to
 * clean them up — a piece that forgets would leak across every swap.
 */
const input = {
  x: 0, y: 0,        // CSS pixels, origin top-left
  nx: 0.5, ny: 0.5,  // normalised 0..1, y up
  dx: 0, dy: 0,      // movement since last frame, CSS pixels
  down: false,
  clicked: false,    // true for the single frame a press began
  wheel: 0,
};

function updatePointer(e) {
  const r = canvas.getBoundingClientRect();
  const x = e.clientX - r.left;
  const y = e.clientY - r.top;
  input.dx += x - input.x;
  input.dy += y - input.y;
  input.x = x;
  input.y = y;
  input.nx = x / r.width;
  input.ny = 1 - y / r.height;
}

canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  // Seed position first so the first frame's delta isn't a jump from wherever
  // the pointer last happened to be.
  const r = canvas.getBoundingClientRect();
  input.x = e.clientX - r.left;
  input.y = e.clientY - r.top;
  updatePointer(e);
  input.dx = input.dy = 0;
  input.down = true;
  input.clicked = true;
});
canvas.addEventListener('pointermove', updatePointer);
canvas.addEventListener('pointerup', (e) => {
  input.down = false;
  if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
});
canvas.addEventListener('pointercancel', () => { input.down = false; });
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  input.wheel += Math.sign(e.deltaY);
}, { passive: false });

/* --------------------------------------------------------------- ui --- */

const ui = createUI(document.getElementById('controls'));
const titleEl = document.getElementById('piece-title');
const blurbEl = document.getElementById('piece-blurb');
const fpsEl = document.getElementById('fps');
const resEl = document.getElementById('res');
const listEl = document.getElementById('pieces');

PIECES.forEach((piece, i) => {
  const li = document.createElement('li');
  if (piece.flag) li.classList.add(piece.flag);
  li.innerHTML =
    `<span class="idx">${String(i + 1).padStart(2, '0')}</span>` +
    `<span class="name">${piece.title}</span>` +
    `<span class="tag">${piece.tag}</span>`;
  li.addEventListener('click', () => select(piece.id));
  listEl.append(li);
  piece._li = li;
});

/* ----------------------------------------------------------- sizing --- */

let width = 0;
let height = 0;

function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
  const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
  if (w === width && h === height) return;
  width = canvas.width = w;
  height = canvas.height = h;
  resEl.textContent = `${w}×${h}`;
  if (current && current.piece.resize) current.piece.resize(current.state, w, h);
}
window.addEventListener('resize', resize);

/* -------------------------------------------------------- lifecycle --- */

let current = null;

function select(id) {
  const piece = PIECES.find((p) => p.id === id) || PIECES[0];
  if (current && current.piece.id === piece.id) return;

  if (current) {
    try { current.piece.dispose(current.state); }
    catch (err) { console.error('dispose failed', err); }
    current.piece._li.classList.remove('active');
    current = null;
  }
  ui.clear();

  titleEl.textContent = piece.title;
  blurbEl.textContent = piece.blurb;
  piece._li.classList.add('active');
  if (location.hash.slice(1) !== piece.id) history.replaceState(null, '', `#${piece.id}`);

  // A piece that throws during init must not take the whole gallery with it.
  try {
    const state = piece.init(gl, canvas, ui, { width, height, input });
    current = { piece, state };
  } catch (err) {
    console.error(`piece "${piece.id}" failed to initialise`, err);
    blurbEl.textContent = `Failed to initialise: ${err.message}`;
    return;
  }
  if (piece.resize) piece.resize(current.state, width, height);
}

window.addEventListener('hashchange', () => select(location.hash.slice(1)));

/* ------------------------------------------------------------- loop --- */

let last = performance.now();
let fpsAccum = 0;
let fpsFrames = 0;

function frame(now) {
  requestAnimationFrame(frame);
  resize();

  // Clamp dt: a background tab or a stall would otherwise hand a simulation a
  // multi-second step and blow it up.
  const dt = Math.min((now - last) / 1000, 1 / 20);
  last = now;

  fpsAccum += dt;
  fpsFrames++;
  if (fpsAccum > 0.4) {
    fpsEl.textContent = `${Math.round(fpsFrames / fpsAccum)} fps`;
    fpsAccum = 0;
    fpsFrames = 0;
  }

  if (current) {
    try {
      current.piece.frame(current.state, now / 1000, dt);
    } catch (err) {
      console.error('frame failed', err);
      current.piece.frame = () => {}; // Don't spam the console 60 times a second.
    }
  }

  input.dx = 0;
  input.dy = 0;
  input.wheel = 0;
  input.clicked = false;
}

/* -------------------------------------------------------- shortcuts --- */

addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement) return;
  const k = e.key.toLowerCase();
  if (k === 'h') document.body.classList.toggle('hide-ui');
  if (k === 'f') {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen?.();
  }
  const n = parseInt(e.key, 10);
  if (n >= 1 && n <= PIECES.length) select(PIECES[n - 1].id);
});

resize();
select(location.hash.slice(1));
requestAnimationFrame(frame);

// Handy when poking at it from the console, and used by the verification pass.
window.atelier = { get current() { return current; }, select, gl, input };

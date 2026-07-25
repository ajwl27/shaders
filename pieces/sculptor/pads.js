/**
 * The two paint targets and the loss trace.
 *
 * Lives in a fixed-position dock over the canvas rather than inside the control
 * panel — at panel width the pads would be too small to draw in. The element is
 * still handed to ui.custom(), so the shell's teardown removes it along with
 * everything else the piece created.
 */

const LABELS = ['front', 'side'];

export function createPads({ size, onPaint }) {
  const dock = document.createElement('div');
  dock.className = 'pad-dock';

  const row = document.createElement('div');
  row.className = 'pad-row';
  dock.append(row);

  const canvases = [];
  const contexts = [];

  for (let i = 0; i < 2; i++) {
    const cell = document.createElement('div');
    cell.className = 'pad';

    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;

    const label = document.createElement('span');
    label.className = 'pad-label';
    label.textContent = LABELS[i];

    cell.append(canvas, label);
    row.append(cell);
    canvases.push(canvas);
    contexts.push(canvas.getContext('2d', { willReadFrequently: false }));
  }

  const trace = document.createElement('canvas');
  trace.className = 'pad-trace';
  trace.width = 480;
  trace.height = 64;
  dock.append(trace);

  const traceCtx = trace.getContext('2d');

  const state = { brush: 0.09, colour: '#d9d2c4', erasing: false };

  /* ------------------------------------------------------------- paint --- */

  const strokes = new Map(); // pointerId -> {ctx, x, y}

  function local(canvas, e) {
    const r = canvas.getBoundingClientRect();
    return [
      ((e.clientX - r.left) / r.width) * size,
      ((e.clientY - r.top) / r.height) * size,
    ];
  }

  function begin(i, e) {
    const canvas = canvases[i];
    const ctx = contexts[i];
    canvas.setPointerCapture(e.pointerId);
    const [x, y] = local(canvas, e);
    ctx.save();
    ctx.globalCompositeOperation = state.erasing ? 'destination-out' : 'source-over';
    ctx.strokeStyle = state.colour;
    ctx.fillStyle = state.colour;
    ctx.lineWidth = state.brush * size;
    ctx.lineCap = ctx.lineJoin = 'round';
    // A tap with no movement should still leave a mark.
    ctx.beginPath();
    ctx.arc(x, y, (state.brush * size) / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    strokes.set(e.pointerId, { i, x, y });
    onPaint();
    e.preventDefault();
  }

  function extend(e) {
    const s = strokes.get(e.pointerId);
    if (!s) return;
    const canvas = canvases[s.i];
    const ctx = contexts[s.i];
    const [x, y] = local(canvas, e);
    ctx.save();
    ctx.globalCompositeOperation = state.erasing ? 'destination-out' : 'source-over';
    ctx.strokeStyle = state.colour;
    ctx.lineWidth = state.brush * size;
    ctx.lineCap = ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(s.x, s.y);
    ctx.lineTo(x, y);
    ctx.stroke();
    ctx.restore();
    s.x = x;
    s.y = y;
    onPaint();
    e.preventDefault();
  }

  function end(e) {
    strokes.delete(e.pointerId);
  }

  const listeners = [];
  function on(el, type, fn, opts) {
    el.addEventListener(type, fn, opts);
    listeners.push([el, type, fn, opts]);
  }

  canvases.forEach((canvas, i) => {
    on(canvas, 'pointerdown', (e) => begin(i, e));
    on(canvas, 'pointermove', extend);
    on(canvas, 'pointerup', end);
    on(canvas, 'pointercancel', end);
    // The shell listens for wheel and keys on the stage; the pads must not let
    // a stray drag over them orbit the 3D camera underneath.
    on(canvas, 'wheel', (e) => e.stopPropagation());
  });

  /* ------------------------------------------------------------- trace --- */

  const history = [];
  const MAX = 480;

  function pushLoss(v) {
    if (!Number.isFinite(v)) return;
    history.push(v);
    if (history.length > MAX) history.shift();
  }

  function drawTrace() {
    const w = trace.width;
    const h = trace.height;
    traceCtx.clearRect(0, 0, w, h);
    if (history.length < 2) return;

    // Log scale: nearly all the visible progress happens in the first decade,
    // and a linear axis flattens it into a wall followed by nothing.
    let lo = Infinity;
    let hi = -Infinity;
    for (const v of history) {
      const l = Math.log10(Math.max(v, 1e-6));
      if (l < lo) lo = l;
      if (l > hi) hi = l;
    }
    if (hi - lo < 0.35) { const m = (hi + lo) / 2; lo = m - 0.175; hi = m + 0.175; }

    traceCtx.strokeStyle = 'rgba(255,255,255,0.10)';
    traceCtx.lineWidth = 1;
    for (let i = 0; i <= 2; i++) {
      const y = (h - 8) * (i / 2) + 4;
      traceCtx.beginPath();
      traceCtx.moveTo(0, y);
      traceCtx.lineTo(w, y);
      traceCtx.stroke();
    }

    traceCtx.strokeStyle = '#c8f135';
    traceCtx.lineWidth = 1.5;
    traceCtx.beginPath();
    for (let i = 0; i < history.length; i++) {
      const x = (i / (MAX - 1)) * w;
      const l = Math.log10(Math.max(history[i], 1e-6));
      const y = h - 4 - ((l - lo) / (hi - lo)) * (h - 8);
      if (i === 0) traceCtx.moveTo(x, y);
      else traceCtx.lineTo(x, y);
    }
    traceCtx.stroke();
  }

  return {
    element: dock,
    contexts,
    canvases,
    state,
    pushLoss,
    drawTrace,
    clearHistory() { history.length = 0; },
    clear() {
      for (const ctx of contexts) ctx.clearRect(0, 0, size, size);
      onPaint();
    },
    dispose() {
      for (const [el, type, fn, opts] of listeners) el.removeEventListener(type, fn, opts);
      listeners.length = 0;
    },
  };
}

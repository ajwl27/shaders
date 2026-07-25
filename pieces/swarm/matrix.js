/**
 * The attraction matrix, as a draggable grid.
 *
 * Cell (row, col) is how strongly species `row` is attracted to species `col`.
 * It is deliberately *not* symmetric — that asymmetry is the whole reason this
 * system produces chasing, orbiting and self-assembling structure rather than
 * settling into blobs.
 */

const K = 4;

export const SPECIES_COLOURS = [
  [1.00, 0.30, 0.34],
  [0.32, 0.86, 0.55],
  [0.34, 0.62, 1.00],
  [1.00, 0.80, 0.26],
];

export function createMatrix({ onChange }) {
  const values = new Float32Array(K * K);

  const wrap = document.createElement('div');
  wrap.className = 'ctl matrix-wrap';

  const canvas = document.createElement('canvas');
  canvas.className = 'matrix';
  const CELL = 44;
  const PAD = 14;
  canvas.width = (CELL * K + PAD) * 2;
  canvas.height = (CELL * K + PAD) * 2;
  canvas.style.width = `${CELL * K + PAD}px`;
  canvas.style.height = `${CELL * K + PAD}px`;
  const ctx = canvas.getContext('2d');
  ctx.scale(2, 2);

  const hint = document.createElement('div');
  hint.className = 'matrix-hint';
  hint.textContent = 'drag a cell up or down';

  wrap.append(canvas, hint);

  function rgb(c, a = 1) {
    return `rgba(${(c[0] * 255) | 0},${(c[1] * 255) | 0},${(c[2] * 255) | 0},${a})`;
  }

  function paint() {
    const w = CELL * K + PAD;
    ctx.clearRect(0, 0, w, w);

    // Species colour keys along the top and left edges.
    for (let i = 0; i < K; i++) {
      ctx.fillStyle = rgb(SPECIES_COLOURS[i]);
      ctx.fillRect(PAD + i * CELL + CELL / 2 - 5, 2, 10, 5);
      ctx.fillRect(2, PAD + i * CELL + CELL / 2 - 5, 5, 10);
    }

    for (let r = 0; r < K; r++) {
      for (let c = 0; c < K; c++) {
        const v = values[r * K + c];
        const x = PAD + c * CELL;
        const y = PAD + r * CELL;
        // Green attracts, red repels, dark is indifferent.
        const mag = Math.min(1, Math.abs(v));
        ctx.fillStyle = v >= 0
          ? `rgba(150, 220, 70, ${0.10 + mag * 0.75})`
          : `rgba(230, 70, 80, ${0.10 + mag * 0.75})`;
        ctx.fillRect(x + 1, y + 1, CELL - 3, CELL - 3);
        ctx.strokeStyle = 'rgba(255,255,255,0.09)';
        ctx.lineWidth = 1;
        ctx.strokeRect(x + 1.5, y + 1.5, CELL - 4, CELL - 4);
        ctx.fillStyle = 'rgba(255,255,255,0.82)';
        ctx.font = '9px ui-monospace, monospace';
        ctx.textAlign = 'center';
        ctx.fillText(v.toFixed(2), x + CELL / 2 - 1, y + CELL / 2 + 3);
      }
    }
  }

  let drag = null;
  const listeners = [];
  function on(el, type, fn) {
    el.addEventListener(type, fn);
    listeners.push([el, type, fn]);
  }

  function cellAt(e) {
    const b = canvas.getBoundingClientRect();
    const x = e.clientX - b.left - PAD;
    const y = e.clientY - b.top - PAD;
    const c = Math.floor(x / CELL);
    const r = Math.floor(y / CELL);
    if (r < 0 || c < 0 || r >= K || c >= K) return -1;
    return r * K + c;
  }

  on(canvas, 'pointerdown', (e) => {
    const i = cellAt(e);
    if (i < 0) return;
    canvas.setPointerCapture(e.pointerId);
    drag = { i, y: e.clientY, start: values[i] };
    e.preventDefault();
  });
  on(canvas, 'pointermove', (e) => {
    if (!drag) return;
    values[drag.i] = Math.max(-1, Math.min(1, drag.start + (drag.y - e.clientY) / 90));
    paint();
    onChange(values);
    e.preventDefault();
  });
  on(canvas, 'pointerup', () => { drag = null; });
  on(canvas, 'pointercancel', () => { drag = null; });
  on(canvas, 'wheel', (e) => e.stopPropagation());

  function randomise() {
    for (let i = 0; i < K * K; i++) values[i] = (Math.random() * 2 - 1) * 0.85;
    // A little self-cohesion makes the result far more likely to be interesting
    // than a fully uniform draw, which usually just disperses.
    for (let i = 0; i < K; i++) values[i * K + i] = 0.15 + Math.random() * 0.6;
    paint();
    onChange(values);
  }

  function set(arr) {
    values.set(arr);
    paint();
    onChange(values);
  }

  return {
    element: wrap,
    values,
    randomise,
    set,
    paint,
    dispose() {
      for (const [el, type, fn] of listeners) el.removeEventListener(type, fn);
      listeners.length = 0;
    },
  };
}

/** Hand-found matrices that reliably produce something worth looking at. */
export const MATRIX_PRESETS = {
  cells: [
    0.55, -0.42, 0.18, -0.10,
    0.30, 0.50, -0.45, 0.16,
    -0.20, 0.34, 0.52, -0.40,
    0.22, -0.18, 0.30, 0.48,
  ],
  chase: [
    0.30, 0.85, -0.55, 0.00,
    -0.55, 0.30, 0.85, 0.00,
    0.85, -0.55, 0.30, 0.00,
    0.10, 0.10, 0.10, 0.45,
  ],
  webs: [
    0.70, -0.75, 0.55, -0.30,
    -0.75, 0.70, -0.30, 0.55,
    0.55, -0.30, 0.70, -0.75,
    -0.30, 0.55, -0.75, 0.70,
  ],
};

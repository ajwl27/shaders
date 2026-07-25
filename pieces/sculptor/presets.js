/**
 * Preset targets, so the piece is impressive before anyone picks up the brush.
 *
 * Each preset paints a front and a side silhouette. The pair matters: one view
 * alone leaves depth unconstrained and the optimiser happily returns a flat
 * cutout. The mug is the clearest case — the handle exists in the front view
 * and not in the side, which is exactly the information that makes it a mug
 * rather than a cylinder.
 *
 * All coordinates are normalised; the canvas may be any square size.
 */

function shape(ctx, S, colour, draw) {
  ctx.fillStyle = colour;
  ctx.beginPath();
  draw({
    ellipse: (cx, cy, rx, ry, rot = 0) =>
      ctx.ellipse(cx * S, cy * S, rx * S, ry * S, rot, 0, Math.PI * 2),
    rect: (x0, y0, x1, y1, r = 0.02) =>
      ctx.roundRect(x0 * S, y0 * S, (x1 - x0) * S, (y1 - y0) * S, r * S),
    move: (x, y) => ctx.moveTo(x * S, y * S),
    line: (x, y) => ctx.lineTo(x * S, y * S),
    curve: (x1, y1, x2, y2, x, y) =>
      ctx.bezierCurveTo(x1 * S, y1 * S, x2 * S, y2 * S, x * S, y * S),
  });
  ctx.fill();
}

function stroke(ctx, S, colour, width, draw) {
  ctx.strokeStyle = colour;
  ctx.lineWidth = width * S;
  ctx.lineCap = 'round';
  ctx.beginPath();
  draw({
    arc: (cx, cy, r, a0, a1) => ctx.arc(cx * S, cy * S, r * S, a0, a1),
    move: (x, y) => ctx.moveTo(x * S, y * S),
    line: (x, y) => ctx.lineTo(x * S, y * S),
  });
  ctx.stroke();
}

const FUR = '#d9d2c4';
const FUR_DARK = '#b9ae9c';
const CERAMIC = '#3fa8a0';
const CERAMIC_LIP = '#dfe9e6';
const WOOD = '#a9743f';
const WOOD_DARK = '#7d5227';
const CRIMSON = '#d4304a';

export const PRESETS = [
  {
    name: 'rabbit',
    front(ctx, S) {
      shape(ctx, S, FUR_DARK, (d) => { d.ellipse(0.385, 0.245, 0.055, 0.155, -0.12); });
      shape(ctx, S, FUR_DARK, (d) => { d.ellipse(0.615, 0.245, 0.055, 0.155, 0.12); });
      shape(ctx, S, FUR, (d) => { d.ellipse(0.5, 0.505, 0.185, 0.165); });
      shape(ctx, S, FUR, (d) => { d.ellipse(0.5, 0.785, 0.165, 0.155); });
    },
    side(ctx, S) {
      shape(ctx, S, FUR_DARK, (d) => { d.ellipse(0.545, 0.245, 0.05, 0.155, 0.05); });
      shape(ctx, S, FUR, (d) => { d.ellipse(0.5, 0.505, 0.16, 0.165); });
      shape(ctx, S, FUR, (d) => { d.ellipse(0.335, 0.565, 0.085, 0.085); });
      shape(ctx, S, FUR, (d) => { d.ellipse(0.585, 0.785, 0.215, 0.155); });
    },
  },
  {
    name: 'mug',
    front(ctx, S) {
      // The handle only exists here. The side view has to stay a plain cylinder,
      // which is what forces a genuinely three-dimensional answer.
      // The arc has to reach back far enough to overlap the body, or the
      // optimiser faithfully reproduces a handle floating in mid-air.
      stroke(ctx, S, CERAMIC, 0.05, (d) => { d.arc(0.655, 0.545, 0.10, -1.45, 1.45); });
      shape(ctx, S, CERAMIC, (d) => { d.rect(0.315, 0.335, 0.685, 0.775, 0.055); });
      shape(ctx, S, CERAMIC_LIP, (d) => { d.rect(0.305, 0.315, 0.695, 0.375, 0.028); });
    },
    side(ctx, S) {
      shape(ctx, S, CERAMIC, (d) => { d.rect(0.335, 0.335, 0.665, 0.775, 0.055); });
      shape(ctx, S, CERAMIC_LIP, (d) => { d.rect(0.325, 0.315, 0.675, 0.375, 0.028); });
    },
  },
  {
    name: 'chair',
    front(ctx, S) {
      shape(ctx, S, WOOD, (d) => { d.rect(0.335, 0.155, 0.665, 0.505, 0.03); });
      shape(ctx, S, WOOD_DARK, (d) => { d.rect(0.275, 0.505, 0.725, 0.585, 0.02); });
      shape(ctx, S, WOOD, (d) => { d.rect(0.305, 0.585, 0.365, 0.865, 0.015); });
      shape(ctx, S, WOOD, (d) => { d.rect(0.635, 0.585, 0.695, 0.865, 0.015); });
    },
    side(ctx, S) {
      shape(ctx, S, WOOD, (d) => { d.rect(0.615, 0.155, 0.695, 0.505, 0.03); });
      shape(ctx, S, WOOD_DARK, (d) => { d.rect(0.285, 0.505, 0.715, 0.585, 0.02); });
      shape(ctx, S, WOOD, (d) => { d.rect(0.305, 0.585, 0.365, 0.865, 0.015); });
      shape(ctx, S, WOOD, (d) => { d.rect(0.635, 0.585, 0.695, 0.865, 0.015); });
    },
  },
  {
    name: 'heart',
    front(ctx, S) {
      shape(ctx, S, CRIMSON, (d) => {
        d.move(0.5, 0.80);
        d.curve(0.14, 0.55, 0.20, 0.20, 0.5, 0.36);
        d.curve(0.80, 0.20, 0.86, 0.55, 0.5, 0.80);
      });
    },
    side(ctx, S) {
      shape(ctx, S, CRIMSON, (d) => { d.ellipse(0.5, 0.545, 0.135, 0.235); });
    },
  },
];

/** Paint a preset into the two target contexts. */
export function applyPreset(preset, ctxFront, ctxSide, size) {
  for (const [ctx, draw] of [[ctxFront, preset.front], [ctxSide, preset.side]]) {
    ctx.clearRect(0, 0, size, size);
    ctx.save();
    draw(ctx, size);
    ctx.restore();
  }
}

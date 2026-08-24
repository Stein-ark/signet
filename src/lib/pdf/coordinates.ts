import type { PageGeometry } from '@/lib/models/types';

/**
 * Screen to PDF coordinate mapping.
 *
 * This module is the reason the rest of the product can be trusted to put a signature where
 * the owner dropped it. The math is verified against the real pdf.js renderer by
 * `scripts/prototype-coordinates.mjs`, which asserts a round trip to within floating point
 * epsilon across four page rotations, a shifted CropBox and four zoom levels.
 *
 * The contract between browser and server:
 *
 *   The browser stores a field rectangle as fractions of the rendered page image, with the
 *   origin at the top left and y increasing downwards. That is the coordinate system a person
 *   actually sees. Because it is normalized, the zoom the owner happened to be using cancels
 *   out completely, and because the rendered image already has the page rotation applied, the
 *   rotation is implicitly accounted for on the browser side too.
 *
 *   The server rebuilds the exact affine transform pdf.js used to produce that image and
 *   inverts it. Replicating the renderer rather than inventing a parallel convention removes
 *   the entire class of bug where the two sides disagree about what "the top of the page"
 *   means.
 */

/** An affine matrix [a, b, c, d, e, f] mapping (x, y) to (ax + cy + e, bx + dy + f). */
export type Matrix = readonly [number, number, number, number, number, number];

export type Viewport = {
  transform: Matrix;
  /** Rendered image size at the given scale, after rotation. */
  width: number;
  height: number;
  rotation: number;
  scale: number;
};

/** A rectangle in normalized rendered space: fractions of the rendered image, origin top left. */
export type NormalizedRect = { nx: number; ny: number; nw: number; nh: number };

/** A rectangle ready to hand to pdf-lib: a rotated box anchored at its own bottom left. */
export type PlacedRect = {
  x: number;
  y: number;
  width: number;
  height: number;
  /** Counter clockwise rotation in degrees that makes the content upright on screen. */
  rotation: number;
};

export function applyMatrix(m: Matrix, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

export function invertMatrix(m: Matrix): Matrix {
  const [a, b, c, d, e, f] = m;
  const determinant = a * d - b * c;
  if (Math.abs(determinant) < 1e-12) {
    throw new Error('Page viewport matrix is degenerate and cannot be inverted.');
  }
  return [
    d / determinant,
    -b / determinant,
    -c / determinant,
    a / determinant,
    (c * f - d * e) / determinant,
    (b * e - a * f) / determinant,
  ];
}

/**
 * Rebuild the pdf.js PageViewport transform.
 *
 * Ported line for line from pdf.js `display/display_utils.js`. Keeping the same structure,
 * including the slightly odd branch on `rotateA`, is intentional: it makes the correspondence
 * auditable rather than requiring a reader to trust an algebraic simplification.
 */
export function buildViewport(page: {
  viewBox: readonly [number, number, number, number];
  rotation: number;
}, scale = 1): Viewport {
  const [x0, y0, x1, y1] = page.viewBox;
  const centerX = (x0 + x1) / 2;
  const centerY = (y0 + y1) / 2;

  let rotation = page.rotation % 360;
  if (rotation < 0) rotation += 360;
  if (rotation % 90 !== 0) rotation = 0;

  let rotateA: number;
  let rotateB: number;
  let rotateC: number;
  let rotateD: number;

  if (rotation === 180) {
    rotateA = -1; rotateB = 0; rotateC = 0; rotateD = 1;
  } else if (rotation === 90) {
    rotateA = 0; rotateB = 1; rotateC = 1; rotateD = 0;
  } else if (rotation === 270) {
    rotateA = 0; rotateB = -1; rotateC = -1; rotateD = 0;
  } else {
    rotateA = 1; rotateB = 0; rotateC = 0; rotateD = -1;
  }

  let offsetCanvasX: number;
  let offsetCanvasY: number;
  let width: number;
  let height: number;

  if (rotateA === 0) {
    // Quarter turns swap the rendered width and height.
    offsetCanvasX = Math.abs(centerY - y0) * scale;
    offsetCanvasY = Math.abs(centerX - x0) * scale;
    width = Math.abs(y1 - y0) * scale;
    height = Math.abs(x1 - x0) * scale;
  } else {
    offsetCanvasX = Math.abs(centerX - x0) * scale;
    offsetCanvasY = Math.abs(centerY - y0) * scale;
    width = Math.abs(x1 - x0) * scale;
    height = Math.abs(y1 - y0) * scale;
  }

  const transform: Matrix = [
    rotateA * scale,
    rotateB * scale,
    rotateC * scale,
    rotateD * scale,
    offsetCanvasX - rotateA * scale * centerX - rotateC * scale * centerY,
    offsetCanvasY - rotateB * scale * centerX - rotateD * scale * centerY,
  ];

  return { transform, width, height, rotation, scale };
}

/**
 * Convert a normalized screen rectangle into a drawable PDF rectangle.
 *
 * The returned anchor is the corner that appears at the bottom left on screen, because that is
 * where pdf-lib places content before applying its rotation. The rotation is derived from the
 * page rather than assumed, by asking where "one pixel to the right on screen" points in PDF
 * user space, which is correct for every quarter turn without a lookup table.
 */
export function placeRect(rect: NormalizedRect, page: PageGeometry): PlacedRect {
  const viewport = buildViewport(page, 1);
  const inverse = invertMatrix(viewport.transform);

  const rx = rect.nx * viewport.width;
  const ry = rect.ny * viewport.height;
  const rw = rect.nw * viewport.width;
  const rh = rect.nh * viewport.height;

  const [anchorX, anchorY] = applyMatrix(inverse, rx, ry + rh);
  const [rightX, rightY] = applyMatrix(inverse, rx + 1, ry + rh);
  const angle = (Math.atan2(rightY - anchorY, rightX - anchorX) * 180) / Math.PI;

  return {
    x: anchorX,
    y: anchorY,
    width: rw,
    height: rh,
    // Snap to the nearest quarter turn: the true value is always a multiple of 90 and this
    // removes floating point drift such as 89.99999999999999.
    rotation: ((Math.round(angle / 90) * 90) % 360 + 360) % 360,
  };
}

/**
 * Offset a point along the local axes of a placed rectangle.
 *
 * pdf-lib rotates drawn content around its anchor, so padding inside a rotated field has to be
 * expressed in the field's own frame. Using page axes here is the classic bug that makes text
 * drift outside its box on rotated pages.
 */
export function localOffset(placed: PlacedRect, alongX: number, alongY: number): [number, number] {
  const radians = (placed.rotation * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return [
    placed.x + alongX * cos - alongY * sin,
    placed.y + alongX * sin + alongY * cos,
  ];
}

/** Clamp a normalized rectangle so a field can never be stored partly off the page. */
export function clampRect(rect: NormalizedRect, minSize = 0.005): NormalizedRect {
  const nw = Math.min(Math.max(rect.nw, minSize), 1);
  const nh = Math.min(Math.max(rect.nh, minSize), 1);
  return {
    nw,
    nh,
    nx: Math.min(Math.max(rect.nx, 0), 1 - nw),
    ny: Math.min(Math.max(rect.ny, 0), 1 - nh),
  };
}

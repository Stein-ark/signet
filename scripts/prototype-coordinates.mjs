/**
 * Signet coordinate mapping prototype.
 *
 * The single hardest correctness problem in an e signing product is mapping a rectangle the
 * owner dragged onto a screen rendered page back to the true coordinate on the PDF page.
 * Three things conspire to make it wrong: the CropBox may not start at the origin, the page
 * may carry a /Rotate entry so the rendered image is not the same shape as the page, and the
 * screen render happens at an arbitrary zoom.
 *
 * The strategy proven here:
 *   1. The browser stores a rectangle normalized to the rendered image (fractions of the
 *      rendered width and height, origin at the top left). Zoom cancels out entirely.
 *   2. The server rebuilds the exact matrix pdf.js used to produce that rendered image, then
 *      inverts it. Because we replicate pdf.js rather than invent our own convention, there
 *      is no room for the two sides to disagree.
 *   3. Drawing happens in PDF user space with an explicit rotation so stamped content sits
 *      upright in the rendered image even on rotated pages.
 *
 * This script proves the mapping by cross checking against the real pdf.js viewport of the
 * document we produce, at several zoom levels, on pages with different sizes, rotations and
 * a shifted CropBox.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { PDFDocument, StandardFonts, rgb, degrees } from '@cantoo/pdf-lib';

/* ------------------------------------------------------------------ *
 * Matrix helpers. A PDF/canvas matrix is [a, b, c, d, e, f] and maps
 * (x, y) to (a*x + c*y + e, b*x + d*y + f).
 * ------------------------------------------------------------------ */

function applyMatrix(m, x, y) {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

function invertMatrix(m) {
  const [a, b, c, d, e, f] = m;
  const det = a * d - b * c;
  if (Math.abs(det) < 1e-12) throw new Error('viewport matrix is not invertible');
  return [
    d / det,
    -b / det,
    -c / det,
    a / det,
    (c * f - d * e) / det,
    (b * e - a * f) / det,
  ];
}

/**
 * Rebuild the matrix pdf.js uses in PageViewport. Ported from pdf.js display/display_utils.js
 * so that our inverse is guaranteed to be the inverse of what actually drew the pixels.
 *
 * viewBox is the page view rectangle [x0, y0, x1, y1] in PDF user space (CropBox clipped to
 * MediaBox). rotation is the total display rotation in degrees. scale is the zoom.
 */
export function buildViewport({ viewBox, rotation = 0, scale = 1 }) {
  const [x0, y0, x1, y1] = viewBox;
  const centerX = (x0 + x1) / 2;
  const centerY = (y0 + y1) / 2;

  // pdf.js normalizes the rotation into 0, 90, 180 or 270.
  let rotate = rotation % 360;
  if (rotate < 0) rotate += 360;
  if (rotate % 90 !== 0) rotate = 0;

  let rotateA, rotateB, rotateC, rotateD;
  if (rotate === 180) {
    rotateA = -1; rotateB = 0; rotateC = 0; rotateD = 1;
  } else if (rotate === 90) {
    rotateA = 0; rotateB = 1; rotateC = 1; rotateD = 0;
  } else if (rotate === 270) {
    rotateA = 0; rotateB = -1; rotateC = -1; rotateD = 0;
  } else {
    rotateA = 1; rotateB = 0; rotateC = 0; rotateD = -1;
  }

  let offsetCanvasX, offsetCanvasY, width, height;
  if (rotateA === 0) {
    // The 90 and 270 cases swap the rendered width and height.
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

  const transform = [
    rotateA * scale,
    rotateB * scale,
    rotateC * scale,
    rotateD * scale,
    offsetCanvasX - rotateA * scale * centerX - rotateC * scale * centerY,
    offsetCanvasY - rotateB * scale * centerX - rotateD * scale * centerY,
  ];

  return { transform, width, height, rotation: rotate, scale, viewBox };
}

/**
 * Convert a rectangle expressed as fractions of the rendered image (origin top left, y down)
 * into something pdf-lib can draw: a bottom left anchor in PDF user space, a width and height
 * in points, and the counter clockwise rotation that makes the stamped content sit upright in
 * the rendered image.
 */
export function normalizedRectToPdf(rect, page) {
  const vp = buildViewport({ viewBox: page.viewBox, rotation: page.rotation, scale: 1 });
  const inv = invertMatrix(vp.transform);

  // Rendered pixel rectangle at scale 1.
  const rx = rect.nx * vp.width;
  const ry = rect.ny * vp.height;
  const rw = rect.nw * vp.width;
  const rh = rect.nh * vp.height;

  // The content origin is the bottom left corner of the box as seen on screen.
  const [ax, ay] = applyMatrix(inv, rx, ry + rh);

  // Direction of "one pixel to the right on screen", expressed in PDF user space.
  const [dx, dy] = applyMatrix(inv, rx + 1, ry + rh);
  const angle = (Math.atan2(dy - ay, dx - ax) * 180) / Math.PI;

  return {
    x: ax,
    y: ay,
    width: rw,
    height: rh,
    rotation: Math.round(angle / 90) * 90,
    viewport: vp,
  };
}

/**
 * Read back the page geometry the way pdf.js does: CropBox clipped to MediaBox, normalized so
 * that x0 < x1 and y0 < y1, falling back to the MediaBox when the CropBox is unusable.
 */
export function pageGeometry(page) {
  const media = page.getMediaBox();
  const crop = page.getCropBox();

  const mediaBox = [media.x, media.y, media.x + media.width, media.y + media.height];
  const box = [crop.x, crop.y, crop.x + crop.width, crop.y + crop.height];

  const x0 = Math.max(Math.min(box[0], box[2]), Math.min(mediaBox[0], mediaBox[2]));
  const y0 = Math.max(Math.min(box[1], box[3]), Math.min(mediaBox[1], mediaBox[3]));
  const x1 = Math.min(Math.max(box[0], box[2]), Math.max(mediaBox[0], mediaBox[2]));
  const y1 = Math.min(Math.max(box[1], box[3]), Math.max(mediaBox[1], mediaBox[3]));

  const viewBox = x1 - x0 > 0 && y1 - y0 > 0
    ? [x0, y0, x1, y1]
    : [
        Math.min(mediaBox[0], mediaBox[2]),
        Math.min(mediaBox[1], mediaBox[3]),
        Math.max(mediaBox[0], mediaBox[2]),
        Math.max(mediaBox[1], mediaBox[3]),
      ];

  let rotation = page.getRotation().angle % 360;
  if (rotation < 0) rotation += 360;
  if (rotation % 90 !== 0) rotation = 0;

  return { viewBox, rotation };
}

/* ------------------------------------------------------------------ *
 * Build a torture test document.
 * ------------------------------------------------------------------ */

const PAGE_SPECS = [
  { label: 'A4 portrait, rotate 0', size: [595.28, 841.89], rotate: 0, cropInset: 0 },
  { label: 'Letter landscape, rotate 90', size: [792, 612], rotate: 90, cropInset: 0 },
  { label: 'A4 portrait, rotate 180', size: [595.28, 841.89], rotate: 180, cropInset: 0 },
  { label: 'Legal portrait, rotate 270', size: [612, 1008], rotate: 270, cropInset: 0 },
  { label: 'A4 with shifted CropBox, rotate 0', size: [595.28, 841.89], rotate: 0, cropInset: 24 },
  { label: 'A4 with shifted CropBox, rotate 90', size: [595.28, 841.89], rotate: 90, cropInset: 36 },
];

// Probe rectangles expressed exactly the way the browser will store them.
const PROBES = [
  { id: 'top-left', nx: 0.05, ny: 0.05, nw: 0.22, nh: 0.05, text: 'TOP LEFT' },
  { id: 'top-right', nx: 0.73, ny: 0.05, nw: 0.22, nh: 0.05, text: 'TOP RIGHT' },
  { id: 'center', nx: 0.39, ny: 0.475, nw: 0.22, nh: 0.05, text: 'CENTER' },
  { id: 'bottom-left', nx: 0.05, ny: 0.9, nw: 0.22, nh: 0.05, text: 'BOTTOM LEFT' },
  { id: 'bottom-right', nx: 0.73, ny: 0.9, nw: 0.22, nh: 0.05, text: 'BOTTOM RIGHT' },
];

async function buildBaseDocument() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);

  for (const spec of PAGE_SPECS) {
    const page = doc.addPage(spec.size);
    if (spec.cropInset > 0) {
      page.setCropBox(
        spec.cropInset,
        spec.cropInset,
        spec.size[0] - spec.cropInset * 2,
        spec.size[1] - spec.cropInset * 2,
      );
    }
    page.setRotation(degrees(spec.rotate));
    // Body text in unrotated user space so a human reader can see which way the page faces.
    page.drawText(spec.label, {
      x: spec.cropInset + 40,
      y: spec.size[1] - spec.cropInset - 60,
      size: 13,
      font,
      color: rgb(0.55, 0.58, 0.62),
    });
  }

  return doc;
}

/* ------------------------------------------------------------------ *
 * Stamp the probes, then verify with the real pdf.js.
 * ------------------------------------------------------------------ */

async function main() {
  mkdirSync('scripts/out', { recursive: true });

  const doc = await buildBaseDocument();
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  const pages = doc.getPages();
  const signaturePng = await makeSignaturePng(doc);

  const expected = [];

  pages.forEach((page, pageIndex) => {
    const geometry = pageGeometry(page);

    PROBES.forEach((probe) => {
      const placed = normalizedRectToPdf(probe, geometry);

      page.drawRectangle({
        x: placed.x,
        y: placed.y,
        width: placed.width,
        height: placed.height,
        rotate: degrees(placed.rotation),
        borderColor: rgb(0.11, 0.42, 0.92),
        borderWidth: 1,
        color: rgb(0.93, 0.96, 1),
      });

      const fontSize = Math.min(9, placed.height * 0.5);
      const textAnchor = localOffset(placed, 4, placed.height / 2 - fontSize / 2);
      page.drawText(probe.text, {
        x: textAnchor[0],
        y: textAnchor[1],
        size: fontSize,
        font,
        color: rgb(0.06, 0.24, 0.6),
        rotate: degrees(placed.rotation),
      });

      if (probe.id === 'center') {
        page.drawImage(signaturePng, {
          x: placed.x,
          y: placed.y,
          width: placed.width,
          height: placed.height,
          rotate: degrees(placed.rotation),
          opacity: 0.35,
        });
      }

      expected.push({ pageIndex, probe, placed, geometry });
    });
  });

  const bytes = await doc.save({ useObjectStreams: false });
  writeFileSync('scripts/out/coordinate-proof.pdf', bytes);

  const sha256 = createHash('sha256').update(bytes).digest('hex');
  console.log(`Wrote scripts/out/coordinate-proof.pdf  (${bytes.length} bytes)`);
  console.log(`SHA-256 ${sha256}\n`);

  await verifyWithPdfJs(bytes, expected);
}

async function makeSignaturePng(doc) {
  // A single pixel PNG is enough to prove image placement geometry.
  const b64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  return doc.embedPng(Buffer.from(b64, 'base64'));
}

async function verifyWithPdfJs(bytes, expected) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({
    data: new Uint8Array(bytes),
    useSystemFonts: false,
    isEvalSupported: false,
  });
  const pdf = await task.promise;

  const zooms = [0.5, 1, 1.37, 2.5];
  let checks = 0;
  let worst = 0;
  const failures = [];

  for (let i = 1; i <= pdf.numPages; i += 1) {
    const page = await pdf.getPage(i);

    // 1. Does our replica of the pdf.js viewport agree with the real one?
    for (const scale of zooms) {
      const real = page.getViewport({ scale });
      const mine = buildViewport({ viewBox: page.view, rotation: page.rotate, scale });
      for (let k = 0; k < 6; k += 1) {
        const delta = Math.abs(real.transform[k] - mine.transform[k]);
        worst = Math.max(worst, delta);
        checks += 1;
        if (delta > 1e-6) {
          failures.push(
            `page ${i} zoom ${scale}: transform[${k}] ${real.transform[k]} vs ${mine.transform[k]}`,
          );
        }
      }
      checks += 2;
      if (Math.abs(real.width - mine.width) > 1e-6 || Math.abs(real.height - mine.height) > 1e-6) {
        failures.push(
          `page ${i} zoom ${scale}: rendered size ${real.width}x${real.height} vs ${mine.width}x${mine.height}`,
        );
      }
    }

    // 2. Push the coordinates we actually drew at back through the real pdf.js viewport and
    //    confirm they land on the rectangle the owner drew on screen, at every zoom level.
    const forPage = expected.filter((e) => e.pageIndex === i - 1);
    for (const scale of zooms) {
      const real = page.getViewport({ scale });
      for (const { probe, placed } of forPage) {
        const rendered = localRectCorners(placed).map(([x, y]) =>
          applyMatrix(real.transform, x, y),
        );
        const xs = rendered.map((p) => p[0]);
        const ys = rendered.map((p) => p[1]);

        const got = {
          nx: Math.min(...xs) / real.width,
          ny: Math.min(...ys) / real.height,
          nw: (Math.max(...xs) - Math.min(...xs)) / real.width,
          nh: (Math.max(...ys) - Math.min(...ys)) / real.height,
        };

        for (const key of ['nx', 'ny', 'nw', 'nh']) {
          const delta = Math.abs(got[key] - probe[key]);
          worst = Math.max(worst, delta);
          checks += 1;
          if (delta > 1e-9) {
            failures.push(
              `page ${i} zoom ${scale} probe ${probe.id}: ${key} expected ${probe[key]} got ${got[key]}`,
            );
          }
        }
      }
    }

    // 3. Confirm stamped content is upright: the local +x axis of the drawn box must point
    //    right on screen and the local +y axis must point up the screen.
    const real = page.getViewport({ scale: 1 });
    for (const { probe, placed } of forPage) {
      const o = applyMatrix(real.transform, placed.x, placed.y);
      const ax = applyMatrix(real.transform, ...localOffset(placed, 10, 0));
      const ay = applyMatrix(real.transform, ...localOffset(placed, 0, 10));
      checks += 2;
      if (!(ax[0] - o[0] > 9.99 && Math.abs(ax[1] - o[1]) < 1e-6)) {
        failures.push(`page ${i} probe ${probe.id}: local +x is not screen right`);
      }
      if (!(o[1] - ay[1] > 9.99 && Math.abs(ay[0] - o[0]) < 1e-6)) {
        failures.push(`page ${i} probe ${probe.id}: local +y is not screen up`);
      }
    }
  }

  console.log(`pdf.js cross check: ${checks} assertions, worst deviation ${worst.toExponential(3)}`);
  if (failures.length) {
    console.error(`\nFAILED (${failures.length}):`);
    failures.slice(0, 20).forEach((f) => console.error('  ' + f));
    process.exitCode = 1;
  } else {
    console.log('PASS: every probe round trips to the exact rectangle the owner drew, at every zoom.');
  }
}

function localOffset(placed, alongX, alongY) {
  const rad = (placed.rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return [placed.x + alongX * cos - alongY * sin, placed.y + alongX * sin + alongY * cos];
}

function localRectCorners(placed) {
  return [
    localOffset(placed, 0, 0),
    localOffset(placed, placed.width, 0),
    localOffset(placed, placed.width, placed.height),
    localOffset(placed, 0, placed.height),
  ];
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

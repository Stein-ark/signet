/**
 * Independent check on the coordinate prototype.
 *
 * The prototype verifies the mapping with its own matrix math. This script takes a completely
 * different route: it asks pdf.js to extract the text it actually finds in the finished file,
 * projects each glyph run through the rendering viewport, and asserts that the run labelled
 * "TOP LEFT" really is in the top left of the picture a human sees, and so on for every
 * corner of every page. If the rotation handling were wrong, the labels would land in the
 * wrong quadrants here even though the pure math agreed with itself.
 */

import { readFileSync } from 'node:fs';

const QUADRANT_FOR_LABEL = {
  'TOP LEFT': { x: 'low', y: 'low' },
  'TOP RIGHT': { x: 'high', y: 'low' },
  CENTER: { x: 'mid', y: 'mid' },
  'BOTTOM LEFT': { x: 'low', y: 'high' },
  'BOTTOM RIGHT': { x: 'high', y: 'high' },
};

function bucket(fraction) {
  if (fraction < 0.35) return 'low';
  if (fraction > 0.65) return 'high';
  return 'mid';
}

const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
const data = new Uint8Array(readFileSync('scripts/out/coordinate-proof.pdf'));
const pdf = await pdfjs.getDocument({ data, isEvalSupported: false }).promise;

let checked = 0;
const failures = [];

for (let i = 1; i <= pdf.numPages; i += 1) {
  const page = await pdf.getPage(i);
  const viewport = page.getViewport({ scale: 1 });
  const content = await page.getTextContent();

  for (const item of content.items) {
    const label = (item.str || '').trim();
    const want = QUADRANT_FOR_LABEL[label];
    if (!want) continue;

    // item.transform is the text matrix in PDF user space; e and f are the glyph origin.
    const [a, b, , , e, f] = item.transform;
    const [cx, cy] = [
      viewport.transform[0] * e + viewport.transform[2] * f + viewport.transform[4],
      viewport.transform[1] * e + viewport.transform[3] * f + viewport.transform[5],
    ];

    const gotX = bucket(cx / viewport.width);
    const gotY = bucket(cy / viewport.height);
    checked += 1;
    if (gotX !== want.x || gotY !== want.y) {
      failures.push(
        `page ${i} (rotate ${page.rotate}) "${label}" rendered at ${gotX}/${gotY}, expected ${want.x}/${want.y}`,
      );
    }

    // The glyph baseline direction must point right on screen, meaning the text reads
    // horizontally in the rendered image rather than sideways.
    const dirX = viewport.transform[0] * a + viewport.transform[2] * b;
    const dirY = viewport.transform[1] * a + viewport.transform[3] * b;
    checked += 1;
    if (!(dirX > 0.001 && Math.abs(dirY) < 1e-6)) {
      failures.push(`page ${i} (rotate ${page.rotate}) "${label}" is not upright on screen`);
    }
  }
}

console.log(`Text extraction check: ${checked} assertions across ${pdf.numPages} pages`);
if (failures.length) {
  console.error(`FAILED (${failures.length}):`);
  failures.forEach((f) => console.error('  ' + f));
  process.exit(1);
}
console.log('PASS: every stamped label renders in the right place and reads horizontally.');

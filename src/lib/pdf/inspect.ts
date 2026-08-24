import { PDFDocument, type PDFPage } from '@cantoo/pdf-lib';
import type { PageGeometry } from '@/lib/models/types';
import { buildViewport } from '@/lib/pdf/coordinates';
import { badRequest } from '@/lib/util/errors';

/** Refuse anything absurd before it reaches the renderer or the sealing pipeline. */
const MAX_PAGES = 300;

/**
 * Read the geometry of every page in an uploaded PDF.
 *
 * This runs once, at upload time, and the result is stored on the envelope. Everything
 * afterwards (the client renderer, the field placement UI, the sealing pipeline) works from
 * the same recorded geometry, so there is no chance of the page definition shifting under a
 * field between placement and signing.
 */
export async function inspectPdf(bytes: Buffer): Promise<{ pageCount: number; pages: PageGeometry[] }> {
  if (bytes.length < 5 || bytes.subarray(0, 5).toString('latin1') !== '%PDF-') {
    throw badRequest('That file does not look like a PDF.');
  }

  let document: PDFDocument;
  try {
    // ignoreEncryption stays false on purpose. A password protected PDF cannot be reliably
    // flattened or sealed, and silently producing a document we cannot guarantee would
    // undermine the whole point of the product.
    document = await PDFDocument.load(bytes, { ignoreEncryption: false, updateMetadata: false });
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (message.toLowerCase().includes('encrypt')) {
      throw badRequest('That PDF is password protected. Remove the protection and upload it again.');
    }
    throw badRequest('That PDF could not be read. It may be corrupt.');
  }

  const pages = document.getPages();
  if (pages.length === 0) {
    throw badRequest('That PDF has no pages.');
  }
  if (pages.length > MAX_PAGES) {
    throw badRequest(`That PDF has ${pages.length} pages. The limit is ${MAX_PAGES}.`);
  }

  return { pageCount: pages.length, pages: pages.map(pageGeometry) };
}

/**
 * Derive the page view box the way pdf.js does.
 *
 * pdf.js renders the CropBox clipped to the MediaBox, normalized so the lower left corner is
 * genuinely lower and left, and falls back to the MediaBox when that intersection is empty.
 * Reproducing exactly that rule is what keeps the server's idea of the page identical to the
 * browser's.
 */
export function pageGeometry(page: PDFPage): PageGeometry {
  const media = page.getMediaBox();
  const crop = page.getCropBox();

  const mediaBox = [media.x, media.y, media.x + media.width, media.y + media.height] as const;
  const cropBox = [crop.x, crop.y, crop.x + crop.width, crop.y + crop.height] as const;

  const x0 = Math.max(Math.min(cropBox[0], cropBox[2]), Math.min(mediaBox[0], mediaBox[2]));
  const y0 = Math.max(Math.min(cropBox[1], cropBox[3]), Math.min(mediaBox[1], mediaBox[3]));
  const x1 = Math.min(Math.max(cropBox[0], cropBox[2]), Math.max(mediaBox[0], mediaBox[2]));
  const y1 = Math.min(Math.max(cropBox[1], cropBox[3]), Math.max(mediaBox[1], mediaBox[3]));

  const viewBox: [number, number, number, number] =
    x1 - x0 > 0 && y1 - y0 > 0
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

  const viewport = buildViewport({ viewBox, rotation }, 1);

  return {
    viewBox,
    rotation,
    renderedWidth: viewport.width,
    renderedHeight: viewport.height,
  };
}

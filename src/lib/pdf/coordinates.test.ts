import { describe, expect, it } from 'vitest';
import { applyMatrix, buildViewport, clampRect, placeRect } from '@/lib/pdf/coordinates';
import type { PageGeometry } from '@/lib/models/types';

function page(rotation: number, viewBox: PageGeometry['viewBox'] = [0, 0, 600, 800]): PageGeometry {
  const viewport = buildViewport({ viewBox, rotation }, 1);
  return { viewBox, rotation, renderedWidth: viewport.width, renderedHeight: viewport.height };
}

describe('screen to PDF coordinates', () => {
  it('maps a field on an upright page with the PDF origin at the bottom left', () => {
    const placed = placeRect({ nx: 0.1, ny: 0.2, nw: 0.5, nh: 0.1 }, page(0));
    expect(placed.rotation).toBe(0);
    expect(placed.x).toBeCloseTo(60);
    expect(placed.y).toBeCloseTo(800 - 0.3 * 800);
    expect(placed.width).toBeCloseTo(300);
    expect(placed.height).toBeCloseTo(80);
  });

  it('swaps the rendered size for quarter turn rotations', () => {
    expect(page(90)).toMatchObject({ renderedWidth: 800, renderedHeight: 600 });
    expect(page(180)).toMatchObject({ renderedWidth: 600, renderedHeight: 800 });
  });

  for (const rotation of [0, 90, 180, 270]) {
    it(`lands the anchor back on the on-screen bottom left corner at ${rotation} degrees`, () => {
      const geometry = page(rotation, [20, 30, 620, 830]);
      const rect = { nx: 0.25, ny: 0.4, nw: 0.3, nh: 0.08 };
      const placed = placeRect(rect, geometry);
      const viewport = buildViewport(geometry, 1);
      const [screenX, screenY] = applyMatrix(viewport.transform, placed.x, placed.y);

      expect(screenX).toBeCloseTo(rect.nx * viewport.width, 6);
      expect(screenY).toBeCloseTo((rect.ny + rect.nh) * viewport.height, 6);
      expect([0, 90, 180, 270]).toContain(placed.rotation);
      // The anchor must sit inside the page's own box, whatever the rotation.
      expect(placed.x).toBeGreaterThanOrEqual(20 - 1e-6);
      expect(placed.x).toBeLessThanOrEqual(620 + 1e-6);
      expect(placed.y).toBeGreaterThanOrEqual(30 - 1e-6);
      expect(placed.y).toBeLessThanOrEqual(830 + 1e-6);
    });
  }

  it('clamps a rectangle that hangs off the page', () => {
    expect(clampRect({ nx: 0.9, ny: -0.2, nw: 0.3, nh: 0.001 })).toEqual({
      nx: 0.7,
      ny: 0,
      nw: 0.3,
      nh: 0.005,
    });
  });
});

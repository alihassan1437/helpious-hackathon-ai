// SAM segmentation-outline shape — the display path for C1.
//
// When the real SAM step lands, the gateway will return a mask for
// the photographed problem area (e.g. the leaking tap, the cracked
// tile). The UI draws that mask as an outline over the photo. This
// module defines the shape both sides agree on, validates it, and
// holds ONE clearly-marked mock mask so the display path can be
// built and laid out before any model exists.
//
// Shape (normalised 0..1 coords, so it fits any rendered size):
//   { polygons: [ [ {x, y}, ...3+ points ], ... ], mock?: true }
// A mask is valid when every polygon has 3+ points, every coord is
// finite and inside [0, 1], and the polygon count is capped (50) so
// a bad payload cannot flood the DOM with SVG nodes. The UI renders
// NOTHING for an invalid mask (photo only, no crash, no invented
// outline) and labels mock masks as mock wherever they appear.

export interface SamPoint {
  x: number;
  y: number;
}

export interface SamMask {
  polygons: SamPoint[][];
  /** True only for the layout mock below — never for a real SAM mask. */
  mock?: boolean;
}

export const MAX_SAM_POLYGONS = 50;

export function isValidSamMask(value: unknown): value is SamMask {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const polygons = (value as { polygons?: unknown }).polygons;
  if (!Array.isArray(polygons) || polygons.length === 0 || polygons.length > MAX_SAM_POLYGONS) return false;
  return polygons.every(
    (poly) =>
      Array.isArray(poly) &&
      poly.length >= 3 &&
      poly.every(
        (pt) =>
          pt !== null &&
          typeof pt === 'object' &&
          Number.isFinite((pt as SamPoint).x) &&
          Number.isFinite((pt as SamPoint).y) &&
          (pt as SamPoint).x >= 0 &&
          (pt as SamPoint).x <= 1 &&
          (pt as SamPoint).y >= 0 &&
          (pt as SamPoint).y <= 1,
      ),
  );
}

/**
 * MOCK mask for layout only: two rough polygons in the middle of the
 * frame. Any UI showing this MUST label it as a mock outline — it is
 * not a segmentation result and must never be presented as one.
 */
export const MOCK_SAM_MASK: SamMask = {
  mock: true,
  polygons: [
    [
      { x: 0.3, y: 0.35 },
      { x: 0.7, y: 0.35 },
      { x: 0.7, y: 0.65 },
      { x: 0.3, y: 0.65 },
    ],
    [
      { x: 0.42, y: 0.2 },
      { x: 0.58, y: 0.2 },
      { x: 0.55, y: 0.32 },
      { x: 0.45, y: 0.32 },
    ],
  ],
};

/** "x,y x,y ..." for an SVG polygon's points attribute. */
export function samPolygonPoints(poly: readonly SamPoint[]): string {
  return poly.map((pt) => `${pt.x * 100},${pt.y * 100}`).join(' ');
}

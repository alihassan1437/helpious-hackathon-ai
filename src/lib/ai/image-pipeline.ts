// Browser image pipeline for the C1 Snap-to-Quote photo path.
//
// BROWSER ONLY — uses canvas/createImageBitmap at call time. Never
// import from server code. This module is deliberately stricter than
// the generic upload resizer (src/lib/image-resize.ts):
//
//   - ALWAYS re-encodes to JPEG, even for small images. A canvas
//     redraw builds a fresh bitmap, so no EXIF (including GPS) from
//     the original file survives into the output. The generic resizer
//     returns small files untouched, which would keep their EXIF.
//   - Max edge 1024px, JPEG quality 0.82, downscale only (never
//     upscale a small photo).
//   - On ANY failure it returns an error, never the original file:
//     sending the original to a model would leak the very EXIF this
//     pipeline exists to strip. The caller falls back to the manual
//     form; the user is never blocked.
//
// Privacy masking — HONEST STUB STATUS (read before wiring more):
//   - blurRegions() is a REAL implementation: it blurs exactly the
//     rectangles it is given, on a canvas, with ctx.filter.
//   - detectSensitiveRegions() is a STUB: it returns no regions and
//     reports implemented: false. Face / house-number / number-plate
//     detection is NOT built (it needs a client-side detector or the
//     SAM path, both later work). Nothing in this module, and no UI
//     built on it, may claim a photo was auto-masked: until detection
//     lands, the UI must tell the user to check the photo for faces,
//     house numbers, and plates before sending.
//   - D2 mock note: the brief call sends TEXT ONLY (see
//     SnapPhotoBrief). No photo bytes go to /api/ai or any model in
//     this slice, so the stub cannot leak anything to a model today.
//     When real vision lands, detection (or SAM masking) must land
//     with it, before any photo byte is sent.

export interface ProcessedBriefPhoto {
  /** JPEG file, max 1024px edge, EXIF-stripped by re-encode. */
  file: File;
  width: number;
  height: number;
  /** Always true for a successful result: the output is a re-encode. */
  exifStripped: true;
  /** False until detection lands: no region was auto-masked. */
  autoMasked: false;
}

export const BRIEF_PHOTO_MAX_EDGE = 1024;
export const BRIEF_PHOTO_JPEG_QUALITY = 0.82;

/** A normalised rectangle (0..1 coords) to blur, e.g. a face box. */
export interface MaskRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SensitiveRegionDetection {
  regions: MaskRegion[];
  /** False until a real detector is wired — see module header. */
  implemented: boolean;
}

/**
 * TODO (needs a client-side detector or the SAM path): detect faces,
 * house numbers, and number plates in a photo. Currently a stub that
 * honestly reports it found nothing because it cannot look.
 */
export function detectSensitiveRegions(): SensitiveRegionDetection {
  return { regions: [], implemented: false };
}

/** Blur exactly the given normalised regions on a canvas, in place. */
export function blurRegions(
  canvas: HTMLCanvasElement,
  regions: readonly MaskRegion[],
): void {
  if (regions.length === 0) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  for (const r of regions) {
    if (![r.x, r.y, r.width, r.height].every((n) => Number.isFinite(n))) continue;
    const sx = Math.max(0, Math.min(1, r.x)) * canvas.width;
    const sy = Math.max(0, Math.min(1, r.y)) * canvas.height;
    const sw = Math.max(1, Math.min(1 - r.x, r.width) * canvas.width);
    const sh = Math.max(1, Math.min(1 - r.y, r.height) * canvas.height);
    try {
      const piece = document.createElement('canvas');
      piece.width = Math.max(1, Math.round(sw));
      piece.height = Math.max(1, Math.round(sh));
      const pctx = piece.getContext('2d');
      if (!pctx) continue;
      pctx.drawImage(canvas, sx, sy, sw, sh, 0, 0, piece.width, piece.height);
      ctx.save();
      ctx.filter = 'blur(16px)';
      ctx.drawImage(piece, sx, sy, sw, sh);
      ctx.restore();
    } catch {
      // One unblurable region must not kill the whole photo.
    }
  }
}

/**
 * Resize + re-encode one photo for the AI brief path. Rejects
 * non-images and any decode/encode failure (never returns the
 * original — see module header).
 */
export async function processImageForBrief(file: File): Promise<ProcessedBriefPhoto> {
  if (!file.type.startsWith('image/')) {
    throw new Error('That file is not a photo.');
  }
  if (typeof createImageBitmap === 'undefined' || typeof document === 'undefined') {
    throw new Error('Photo processing is not available in this browser.');
  }
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  try {
    const { width, height } = bitmap;
    const scale = Math.min(1, BRIEF_PHOTO_MAX_EDGE / Math.max(width, height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Photo processing is not available in this browser.');
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    // No auto-masking yet (detection stub) — the caller shows the
    // user the self-check note. Nothing is blurred here.
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', BRIEF_PHOTO_JPEG_QUALITY),
    );
    if (!blob) throw new Error('Could not process that photo.');
    const outName = file.name.replace(/\.[^.]*$/, '') + '.jpg';
    return {
      file: new File([blob], outName, { type: 'image/jpeg' }),
      width: canvas.width,
      height: canvas.height,
      exifStripped: true,
      autoMasked: false,
    };
  } finally {
    bitmap.close();
  }
}

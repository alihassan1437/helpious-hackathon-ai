'use client';

// SAM segmentation-outline display path (C1 scaffolding).
//
// Draws a mask's polygons as an outline over a photo. The mask comes
// from the gateway's SAM step when it lands; until then callers pass
// MOCK_SAM_MASK for layout, and this component labels it as a mock
// in plain sight. An invalid mask renders the photo with no outline
// (never an invented one, never a crash).

import { isValidSamMask, samPolygonPoints, type SamMask } from '@/lib/ai/mask';

export function SamOutline({
  imageUrl,
  mask,
  alt = 'Job photo',
}: {
  imageUrl: string;
  mask: SamMask | null;
  alt?: string;
}) {
  const valid = mask !== null && isValidSamMask(mask);
  // Sizing: the preview is capped at 320px tall and the wrapper hugs
  // the displayed image (w-fit + mx-auto), so a large phone photo
  // never dominates the form — and the overlay (absolute inset-0)
  // still covers exactly the image, not a stretched container.
  return (
    <div className="relative mx-auto w-fit max-w-full overflow-hidden rounded-xl border border-line bg-mist">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={imageUrl} alt={alt} className="block max-h-[320px] w-auto max-w-full object-contain" />
      {valid && mask && (
        <svg
          className="absolute inset-0 h-full w-full"
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          {mask.polygons.map((poly, i) => (
            <polygon
              key={i}
              points={samPolygonPoints(poly)}
              fill="rgba(255, 179, 26, 0.25)"
              stroke="#FFB31A"
              strokeWidth="1.2"
              vectorEffect="non-scaling-stroke"
            />
          ))}
        </svg>
      )}
      {valid && mask?.mock && (
        <span className="absolute left-2 top-2 rounded-full bg-navy px-3 py-1 text-xs font-bold text-white">
          Sample outline (mock — real segmentation arrives with the model key)
        </span>
      )}
    </div>
  );
}

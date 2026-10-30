'use client';

// C3 safety card — renders the FIXED safety text from
// src/lib/ai/safety-patterns.ts, never model output, and never
// blocks posting the request. Show it whenever danger words are
// detected (typed description or brief text); hide it otherwise.
// The numbers in the card are verified official NT sources — see
// safety-patterns.ts. Do not edit the wording here: edit it there,
// so the server gateway and this card stay identical.

import { SAFETY_CARD } from '@/lib/ai/safety-patterns';

export function SafetyCard() {
  return (
    <div
      role="alert"
      className="rounded-xl border-2 border-amber-400 bg-amber-50 p-4 space-y-2"
    >
      <p className="text-sm font-bold text-ink">{SAFETY_CARD.title}</p>
      <p className="text-sm font-medium leading-relaxed text-ink">{SAFETY_CARD.body}</p>
      <p className="text-sm font-medium leading-relaxed text-ink">{SAFETY_CARD.utilityNumbers}</p>
      <p className="text-xs font-medium text-slate">
        This is fixed safety information, not AI advice. It does not stop you posting your request.
      </p>
    </div>
  );
}

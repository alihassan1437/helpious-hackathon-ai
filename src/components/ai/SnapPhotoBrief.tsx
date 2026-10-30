'use client';

// C1 Snap-to-Quote, key-independent groundwork (D2, MOCK ONLY).
//
// Flow: user picks a photo -> the browser pipeline resizes it to a
// 1024px EXIF-stripped JPEG -> the photo joins the job's media (the
// parent appends it, same as a manually added photo) -> "Draft
// description with AI" calls the existing /api/ai gateway's
// photo-brief feature -> on success the parent pre-fills the
// EDITABLE description from the brief; the user can rewrite anything.
//
// Honest limits, stated in the UI itself:
//   - The gateway is OFF by default (config/ai flag). While off, the
//     call returns { fallback: true } and this component says so —
//     the manual form keeps working exactly as today.
//   - D2 MOCK: no photo bytes are sent to /api/ai or any model. The
//     brief is drafted from the typed text only; the photo stays on
//     this page and in the job photos. Real vision needs the model
//     key (not yet arrived) plus finished privacy masking.
//   - Automatic face / house-number / plate masking is NOT built
//     (detection stub in image-pipeline.ts). The user is told to
//     check the photo before sending.
//   - This component never submits, never validates, never changes
//     the quote submit path — it only fills the editable fields
//     through the parent's callbacks.
//
// The segmentation outline under the preview is the SAM display
// path with the MOCK mask, labelled as mock in plain sight.

import { useRef, useState } from 'react';
import { processImageForBrief } from '@/lib/ai/image-pipeline';
import { MOCK_SAM_MASK } from '@/lib/ai/mask';
import { SamOutline } from '@/components/ai/SamOutline';

export interface PhotoBriefDraft {
  trade: string;
  issue: string;
  scope: string;
  urgency: string;
  questions: string[];
  /** True when any field carries the mock provider's marker. */
  isMock: boolean;
}

function normalizeBrief(output: unknown): PhotoBriefDraft {
  const o = (output ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  const questions = Array.isArray(o.questions)
    ? (o.questions as unknown[]).filter((q): q is string => typeof q === 'string')
    : [];
  const draft: PhotoBriefDraft = {
    trade: str(o.trade),
    issue: str(o.issue),
    scope: str(o.scope),
    urgency: str(o.urgency),
    questions,
    isMock: false,
  };
  draft.isMock = JSON.stringify(output ?? {}).includes('(mock)');
  return draft;
}

export function SnapPhotoBrief({
  description,
  getToken,
  onPhoto,
  onBrief,
  onSafetyShown,
}: {
  /** Current typed description, sent as the brief's text input. */
  description: string;
  /** Resolves the caller's Firebase ID token, or undefined when signed out. */
  getToken: () => Promise<string | undefined>;
  /** Parent appends the processed photo to the job media. */
  onPhoto: (file: File) => void;
  /** Parent pre-fills the editable form from the draft. */
  onBrief: (draft: PhotoBriefDraft) => void;
  /** Parent shows/hides the fixed safety card. */
  onSafetyShown: (shown: boolean) => void;
}) {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [status, setStatus] = useState<'idle' | 'processing' | 'briefing' | 'done' | 'error'>('idle');
  const [note, setNote] = useState('');
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  async function handlePick(e: React.ChangeEvent<HTMLInputElement>) {
    const picked = e.target.files?.[0];
    e.target.value = '';
    if (!picked) return;
    setStatus('processing');
    setNote('');
    try {
      const processed = await processImageForBrief(picked);
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      setPreviewUrl(URL.createObjectURL(processed.file));
      onPhoto(processed.file);
      setStatus('idle');
      setNote(
        'Photo attached (1024px, location data stripped). Automatic face / house-number / plate masking is not built yet — please check the photo for faces, house numbers, or number plates before sending.',
      );
    } catch (err) {
      setStatus('error');
      setNote(err instanceof Error ? err.message : 'Could not process that photo. Type the description manually.');
    }
  }

  async function handleBrief() {
    setStatus('briefing');
    setNote('');
    try {
      const token = await getToken();
      if (!token) {
        setStatus('idle');
        setNote('Sign in to use the AI brief — the gateway needs a signed-in account. Your photo is attached; just type the description instead.');
        return;
      }
      const res = await fetch('/api/ai', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          feature: 'photo-brief',
          input: { text: description, hasPhoto: previewUrl !== null },
        }),
      });
      if (!res.ok) {
        setStatus('idle');
        setNote('AI brief is unavailable right now — the manual form still works.');
        return;
      }
      const data = (await res.json()) as {
        fallback?: boolean;
        output?: unknown;
        safetyCardShown?: boolean;
      };
      onSafetyShown(data.safetyCardShown === true);
      if (data.fallback) {
        setStatus('idle');
        setNote('AI brief is switched off right now — the manual form still works.');
        return;
      }
      const draft = normalizeBrief(data.output);
      onBrief(draft);
      setStatus('done');
      setNote(
        draft.isMock
          ? 'Mock preview — this draft is placeholder text from the mock brief, not a real AI brief. Edit it freely.'
          : 'AI suggestion — check it and edit anything before continuing.',
      );
    } catch {
      setStatus('idle');
      setNote('AI brief is unavailable right now — the manual form still works.');
    }
  }

  return (
    <div className="space-y-3 rounded-xl border border-line bg-mist p-4">
      <p className="text-sm font-bold text-ink">Snap a photo of the job (optional)</p>
      <p className="text-xs font-medium leading-relaxed text-slate">
        AI drafts the description from your photo. In this preview no photo is sent to any AI model — the
        brief is drafted from text only, and the gateway is off by default, so the manual form always works.
      </p>
      {previewUrl && (
        <SamOutline imageUrl={previewUrl} mask={MOCK_SAM_MASK} alt="Your job photo with a sample outline" />
      )}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={status === 'processing' || status === 'briefing'}
          className="rounded-xl bg-white px-4 py-2 text-sm font-bold border border-line hover:border-navy disabled:opacity-50"
        >
          {previewUrl ? 'Change photo' : 'Add a photo'}
        </button>
        <button
          type="button"
          onClick={handleBrief}
          disabled={status === 'processing' || status === 'briefing'}
          className="rounded-xl bg-navy px-4 py-2 text-sm font-bold text-white disabled:opacity-50"
        >
          {status === 'briefing' ? 'Drafting…' : 'Draft description with AI'}
        </button>
        <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={handlePick} />
      </div>
      {note && <p className="text-xs font-medium leading-relaxed text-slate">{note}</p>}
    </div>
  );
}

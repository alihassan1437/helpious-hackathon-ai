'use client';

// B7 — "Build my profile from pasted text" (hackathon), My listing.
//
// The business pastes text about itself (website, Facebook page, a
// document) -> this calls the /api/ai gateway's 'paste-to-profile'
// feature -> the review screen below shows every extracted field
// with the exact snippet from the paste that supports it, an
// editable value, and a "check carefully" flag wherever the AI was
// unsure or its quote could not be verified against the paste
// (verification happens in src/lib/ai/profile-ai.ts).
//
// The business ticks what to apply; applied values are handed to the
// parent, which fills the EXISTING editor form state. This component
// never saves, never publishes, and never overwrites a field with
// existing content unless the business explicitly ticks it (fields
// with content start unticked, as do low-confidence fields). Hours
// and prices apply as merges over the form's existing records.
//
// Privacy honesty, stated in the UI itself: phone numbers, emails,
// street addresses, ABNs, and licence numbers are removed from the
// paste before anything reaches the AI, so they can never come back
// extracted — the review screen says so and points at the form
// fields where the business adds them itself.
//
// Fallback honesty: the feature is flag-gated OFF by default
// (Firestore config/ai). While off — or on any error — the panel
// shows one quiet note and the editor works exactly as it did
// before B7 existed.

import { useState } from 'react';
import { Loader2, Sparkles } from 'lucide-react';
import {
  formatPasteFieldValue,
  normalizePasteProfile,
  parsePasteFieldEdit,
  pasteFieldIsEmpty,
  REMOVED_CONTACT_LABELS,
  type NormalizedPasteProfile,
  type PasteReviewRow,
} from '@/lib/ai/profile-ai';

const MAX_PASTE_CHARS = 15_000;

type PanelState = 'idle' | 'extracting' | 'unavailable' | 'review' | 'applied';

export function PasteToProfile({
  getToken,
  currentValues,
  categoryOptions,
  onApply,
}: {
  /** Resolves the caller's Firebase ID token, or undefined when signed out. */
  getToken: () => Promise<string | undefined>;
  /** Current editor form values, keyed by BusinessFormData field name. */
  currentValues: Record<string, unknown>;
  /** Loaded Helpious category names; an extracted category applies only on an exact match. */
  categoryOptions: string[];
  /** Parent fills the editor form with the ticked values (its save flow persists). */
  onApply: (values: Record<string, unknown>) => void;
}) {
  const [paste, setPaste] = useState('');
  const [state, setState] = useState<PanelState>('idle');
  const [note, setNote] = useState('');
  const [result, setResult] = useState<NormalizedPasteProfile | null>(null);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [ticked, setTicked] = useState<Record<string, boolean>>({});
  const [appliedCount, setAppliedCount] = useState(0);

  function isApplicable(row: PasteReviewRow): boolean {
    if (row.key !== 'category') return true;
    return typeof row.value === 'string' && categoryOptions.includes(row.value);
  }

  function isAlreadyFilled(row: PasteReviewRow): boolean {
    return !pasteFieldIsEmpty(row.kind, currentValues[row.formField]);
  }

  async function handleExtract() {
    const text = paste.trim();
    if (text === '') return;
    setState('extracting');
    setNote('');
    setResult(null);
    try {
      const token = await getToken();
      if (!token) {
        setState('unavailable');
        setNote('Sign in to use the AI profile builder — the form below works as usual.');
        return;
      }
      const res = await fetch('/api/ai', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ feature: 'paste-to-profile', input: { text } }),
      });
      if (!res.ok) {
        setState('unavailable');
        setNote('AI profile builder is unavailable right now — fill the form as usual.');
        return;
      }
      const data = (await res.json()) as { fallback?: boolean; output?: unknown };
      if (data.fallback) {
        setState('unavailable');
        setNote('AI profile builder is switched off right now — fill the form as usual.');
        return;
      }
      const normalized = normalizePasteProfile(data.output, text);
      setResult(normalized);
      if (normalized.isMock) {
        setState('unavailable');
        setNote(
          'Mock preview — the AI extractor is not running, so nothing was extracted from your text. Fill the form as usual.',
        );
        return;
      }
      if (!normalized.hasExtraction) {
        setState('unavailable');
        setNote(
          'Nothing usable was found in that text — fill the form manually. Only facts the text actually states can be extracted.',
        );
        return;
      }
      const nextEdits: Record<string, string> = {};
      const nextTicked: Record<string, boolean> = {};
      for (const row of normalized.rows) {
        nextEdits[row.key] = formatPasteFieldValue(row.kind, row.value);
        nextTicked[row.key] =
          isApplicable(row) && !isAlreadyFilled(row) && !row.lowConfidence;
      }
      setEdits(nextEdits);
      setTicked(nextTicked);
      setState('review');
    } catch {
      setState('unavailable');
      setNote('AI profile builder is unavailable right now — fill the form as usual.');
    }
  }

  function handleApply() {
    if (!result) return;
    const values: Record<string, unknown> = {};
    let count = 0;
    for (const row of result.rows) {
      if (!ticked[row.key] || !isApplicable(row)) continue;
      values[row.formField] = parsePasteFieldEdit(row.kind, edits[row.key] ?? '');
      count += 1;
    }
    if (count === 0) return;
    onApply(values);
    setAppliedCount(count);
    setState('applied');
  }

  function reset() {
    setState('idle');
    setNote('');
    setResult(null);
    setEdits({});
    setTicked({});
    setAppliedCount(0);
  }

  const contactNote =
    result && result.removedContact.length > 0 ? (
      <p className="text-xs text-slate font-medium leading-relaxed">
        Your paste mentioned{' '}
        {result.removedContact.map((c) => REMOVED_CONTACT_LABELS[c] ?? c).join(', ')}. For privacy,
        contact details and ID numbers are removed before anything reaches the AI, so they were
        never sent and can&apos;t be extracted — add them in the form yourself: phone and email are
        in Basics, ABN and licence number are under the Verification tab.
      </p>
    ) : null;

  return (
    <div className="p-4 bg-mist rounded-xl border border-line space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="font-bold text-xs uppercase tracking-widest text-slate flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-navy" /> Build my profile from pasted text · Helpious
          Assist
        </h4>
        <span className="text-[11px] font-bold uppercase tracking-widest bg-amber/20 text-navy border border-amber/40 rounded-full px-2 py-0.5">
          AI suggestion
        </span>
      </div>

      {state === 'idle' || state === 'extracting' ? (
        <>
          <p className="text-sm text-slate leading-relaxed">
            Paste text from your website, Facebook page, or a document. The AI extracts only the
            facts the text actually states — services, suburbs, hours, prices it names — and shows
            each one with the quote it came from, for you to check, edit, and tick. Nothing is
            saved or published by the AI: applied fields fill this form, and you press Save as
            usual. Contact details and ID numbers are removed before the AI sees your text, so add
            those in the form yourself.
          </p>
          <textarea
            value={paste}
            onChange={(e) => setPaste(e.target.value)}
            maxLength={MAX_PASTE_CHARS}
            rows={6}
            placeholder="Paste your website or Facebook 'About' text here…"
            className="w-full rounded-xl bg-white border border-line p-3 text-sm font-medium text-ink placeholder:text-slate focus:outline-none focus:border-navy transition-all"
          />
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={handleExtract}
              disabled={state === 'extracting' || paste.trim() === ''}
              className="flex items-center gap-2 rounded-xl bg-navy px-4 py-2 text-xs font-bold text-white disabled:opacity-50"
            >
              {state === 'extracting' ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Sparkles className="w-3.5 h-3.5" />
              )}
              {state === 'extracting' ? 'Extracting…' : 'Extract with AI'}
            </button>
            <span className="text-[11px] text-slate font-medium">
              {paste.length.toLocaleString()} / {MAX_PASTE_CHARS.toLocaleString()} characters
            </span>
          </div>
        </>
      ) : null}

      {state === 'unavailable' ? (
        <>
          <p className="text-sm text-slate leading-relaxed">{note}</p>
          {contactNote}
          <button
            type="button"
            onClick={reset}
            className="rounded-xl bg-white px-4 py-2 text-xs font-bold border border-line hover:border-navy"
          >
            Try another paste
          </button>
        </>
      ) : null}

      {state === 'review' && result ? (
        <>
          <p className="text-sm text-slate leading-relaxed">
            Check each field against the quote from your text, edit anything, and tick what to
            apply. Fields you already have content in start unticked — ticking one replaces your
            text when you apply. Applying fills the form only; you still press Save.
          </p>
          {contactNote}
          {result.droppedPlaceholderFields.length > 0 ? (
            <p className="text-xs text-slate font-medium leading-relaxed">
              Dropped suggestion{result.droppedPlaceholderFields.length > 1 ? 's' : ''} (
              {result.droppedPlaceholderFields.join(', ')}) because{' '}
              {result.droppedPlaceholderFields.length > 1 ? 'they' : 'it'} contained removed
              contact details instead of a real value.
            </p>
          ) : null}
          <div className="space-y-3">
            {result.rows.map((row) => {
              const applicable = isApplicable(row);
              const alreadyFilled = isAlreadyFilled(row);
              const multiline = row.kind !== 'text';
              return (
                <div key={row.key} className="rounded-xl bg-white border border-line p-3 space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={applicable && (ticked[row.key] ?? false)}
                        disabled={!applicable}
                        onChange={(e) =>
                          setTicked((prev) => ({ ...prev, [row.key]: e.target.checked }))
                        }
                        className="h-4 w-4 accent-[#0B2545]"
                      />
                      <span className="text-sm font-bold text-primary">{row.label}</span>
                    </label>
                    <span className="text-[11px] font-bold uppercase tracking-widest text-slate">
                      {row.tab} tab
                    </span>
                    {row.generated ? (
                      <span className="text-[11px] font-bold uppercase tracking-widest bg-mist text-navy border border-line rounded-full px-2 py-0.5">
                        AI-written from your text
                      </span>
                    ) : null}
                    {row.lowConfidence ? (
                      <span className="text-[11px] font-bold uppercase tracking-widest bg-amber/20 text-navy border border-amber/40 rounded-full px-2 py-0.5">
                        Check carefully
                      </span>
                    ) : null}
                  </div>

                  {multiline ? (
                    <textarea
                      value={edits[row.key] ?? ''}
                      onChange={(e) => setEdits((prev) => ({ ...prev, [row.key]: e.target.value }))}
                      rows={row.kind === 'longText' ? 5 : 3}
                      className="w-full rounded-xl bg-mist/50 border border-line p-3 text-sm font-medium text-ink focus:outline-none focus:bg-white focus:border-navy transition-all"
                    />
                  ) : (
                    <input
                      type="text"
                      value={edits[row.key] ?? ''}
                      onChange={(e) => setEdits((prev) => ({ ...prev, [row.key]: e.target.value }))}
                      className="w-full rounded-xl bg-mist/50 border border-line px-3 py-2 text-sm font-medium text-ink focus:outline-none focus:bg-white focus:border-navy transition-all"
                    />
                  )}
                  {row.kind === 'list' ? (
                    <p className="text-[11px] text-slate font-medium">
                      Separate items with commas.
                    </p>
                  ) : null}
                  {row.kind === 'hours' || row.kind === 'prices' ? (
                    <p className="text-[11px] text-slate font-medium">
                      One per line, as &ldquo;Name: value&rdquo;. Applying merges these over your
                      existing entries — lines you remove here are kept from your current form.
                    </p>
                  ) : null}

                  {row.generated ? (
                    <p className="text-xs text-slate font-medium leading-relaxed">
                      Written by AI from the facts in your text — read it before applying.
                    </p>
                  ) : row.snippet !== '' ? (
                    <p className="text-xs text-slate font-medium leading-relaxed">
                      From your text: <span className="italic">&ldquo;{row.snippet}&rdquo;</span>
                      {row.lowConfidence && !row.snippetVerified
                        ? ' (This quote could not be found word-for-word in your text — check the value carefully.)'
                        : ''}
                    </p>
                  ) : (
                    <p className="text-xs text-slate font-medium leading-relaxed">
                      No quote was provided for this one — check it against your text before
                      applying.
                    </p>
                  )}
                  {!applicable ? (
                    <p className="text-xs text-slate font-medium leading-relaxed">
                      This doesn&apos;t match a Helpious category exactly, so it can&apos;t be
                      applied — pick the closest match in Primary Industry below instead.
                    </p>
                  ) : alreadyFilled ? (
                    <p className="text-xs text-slate font-medium leading-relaxed">
                      You already have content in this field — it is replaced only if you tick it.
                    </p>
                  ) : null}
                </div>
              );
            })}
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={handleApply}
              className="rounded-xl bg-navy px-4 py-2 text-xs font-bold text-white"
            >
              Apply ticked fields to the form
            </button>
            <button
              type="button"
              onClick={reset}
              className="rounded-xl bg-white px-4 py-2 text-xs font-bold border border-line hover:border-navy"
            >
              Start over
            </button>
          </div>
        </>
      ) : null}

      {state === 'applied' ? (
        <>
          <p className="text-sm text-slate leading-relaxed">
            Applied {appliedCount} field{appliedCount > 1 ? 's' : ''} to the form. Nothing is
            saved or published yet — check the fields (some live on the Services, Areas, and Hours
            tabs), then press Save as usual.
          </p>
          <button
            type="button"
            onClick={reset}
            className="rounded-xl bg-white px-4 py-2 text-xs font-bold border border-line hover:border-navy"
          >
            Paste more text
          </button>
        </>
      ) : null}
    </div>
  );
}

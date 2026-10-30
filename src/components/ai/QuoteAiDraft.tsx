'use client';

// B2 — "Draft with AI" for the quote builder (hackathon).
//
// Calls the /api/ai gateway's 'quote-draft' feature with the job
// text, the B1 lead brief when one exists, and THIS business's own
// servicePrices (from its listing doc) rendered verbatim. The
// returned line items are passed through applyQuoteDraft() in
// src/lib/ai/business-ai.ts, which enforces the own-prices-only rule
// a second time, deterministically: any drafted price not found in
// the business's own price strings is blanked and flagged "add your
// price" before it can reach the form.
//
// The draft APPENDS editable line items to the builder (duplicates
// by description are skipped by the parent). AI never sends
// anything: the existing Send Quote flow is untouched and remains a
// human action. On fallback (flag off by default, over cap, model
// unavailable) the box shows one quiet note and the builder works
// exactly as it did before B2.

import { useMemo, useState } from 'react';
import { Loader2, Sparkles } from 'lucide-react';
import {
  applyQuoteDraft,
  composeQuoteDraftText,
  priceEntriesFrom,
  type AppliedDraftItem,
  type LeadBrief,
} from '@/lib/ai/business-ai';

type DraftState = 'idle' | 'drafting' | 'done' | 'unavailable';

export function QuoteAiDraft({
  jobText,
  category,
  suburb,
  brief,
  servicePrices,
  canDraft,
  getToken,
  onDraft,
}: {
  /** The lead's job description text (never contact details). */
  jobText: string;
  category?: string;
  suburb?: string;
  /** The B1 brief for this lead, when one was generated. */
  brief: LeadBrief | null;
  /** Raw businesses/{id}.servicePrices field (Record<service, price>). */
  servicePrices: unknown;
  /** False while an active quote is shown read-only (not editing). */
  canDraft: boolean;
  /** Resolves the caller's Firebase ID token, or undefined when signed out. */
  getToken: () => Promise<string | undefined>;
  /** Parent appends the guarded draft items to the builder form. */
  onDraft: (items: AppliedDraftItem[]) => void;
}) {
  const entries = useMemo(() => priceEntriesFrom(servicePrices), [servicePrices]);
  const [state, setState] = useState<DraftState>('idle');
  const [note, setNote] = useState('');

  async function handleDraft() {
    setState('drafting');
    setNote('');
    try {
      const token = await getToken();
      if (!token) {
        setState('unavailable');
        setNote('Sign in to draft with AI — you can still add line items manually below.');
        return;
      }
      const priceList: Record<string, string> = {};
      for (const e of entries) priceList[e.service] = e.price;
      const res = await fetch('/api/ai', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          feature: 'quote-draft',
          input: {
            text: composeQuoteDraftText({
              jobText,
              category,
              suburb,
              brief,
              priceEntries: entries,
            }),
            priceList,
          },
        }),
      });
      if (!res.ok) {
        setState('unavailable');
        setNote('AI draft unavailable right now — add line items manually; the builder works as usual.');
        return;
      }
      const data = (await res.json()) as { fallback?: boolean; output?: unknown };
      if (data.fallback) {
        setState('unavailable');
        setNote('AI draft is switched off right now — add line items manually; the builder works as usual.');
        return;
      }
      const applied = applyQuoteDraft(data.output, entries);
      if (applied.items.length === 0) {
        setState('unavailable');
        setNote('The AI draft came back empty — add line items manually; the builder works as usual.');
        return;
      }
      onDraft(applied.items);
      const parts = [
        applied.isMock
          ? 'Mock preview — these items are placeholder text from the mock provider, not a real AI draft.'
          : `AI suggestion added below — ${applied.items.length} line item${applied.items.length > 1 ? 's' : ''}, edit anything before sending.`,
      ];
      if (applied.removedPrices > 0) {
        parts.push(
          `${applied.removedPrices} drafted price${applied.removedPrices > 1 ? 's were' : ' was'} removed because ${applied.removedPrices > 1 ? 'they were' : 'it was'} not in your price list.`,
        );
      }
      if (applied.missingPrices > 0) {
        parts.push(
          `${applied.missingPrices} item${applied.missingPrices > 1 ? 's have' : ' has'} no price — add your price before sending.`,
        );
      }
      setNote(parts.join(' '));
      setState('done');
    } catch {
      setState('unavailable');
      setNote('AI draft unavailable right now — add line items manually; the builder works as usual.');
    }
  }

  return (
    <div className="p-3 bg-mist rounded-xl border border-line space-y-2">
      <p className="text-xs text-slate leading-relaxed">
        <span className="font-bold text-primary">AI draft:</span>{' '}
        {state === 'done' || state === 'unavailable'
          ? note
          : 'Draft line items from the job brief and your own price list. Prices come only from your price list — anything without one stays blank for you to price. The draft never sends; you review, edit, and press Send Quote yourself.'}
      </p>
      {entries.length === 0 && state === 'idle' && (
        <p className="text-xs text-slate leading-relaxed">
          No prices on your listing yet, so an AI draft will leave every price blank for you to fill in.
        </p>
      )}
      {canDraft ? (
        <button
          type="button"
          onClick={handleDraft}
          disabled={state === 'drafting' || jobText.trim() === ''}
          className="flex items-center gap-2 rounded-xl bg-navy px-4 py-2 text-xs font-bold text-white disabled:opacity-50"
        >
          {state === 'drafting' ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <Sparkles className="w-3.5 h-3.5" />
          )}
          {state === 'drafting' ? 'Drafting…' : state === 'done' ? 'Draft again with AI' : 'Draft with AI'}
        </button>
      ) : (
        <p className="text-xs text-slate font-medium">Use Update Quote to draft with AI.</p>
      )}
    </div>
  );
}

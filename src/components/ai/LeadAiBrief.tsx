'use client';

// B1 — AI lead brief (hackathon), business side of the Leads detail.
//
// On mount (one lead selected) this calls the /api/ai gateway's
// 'photo-brief' feature with the job's description text + category +
// suburb ONLY — never a customer name, phone, email, or address
// (contact details live behind the Privacy Shield and are never part
// of a lead brief). The gateway generates the brief ONCE per job:
// its cache key is a hash of the input, so repeat views by any
// business are cache hits and cost nothing.
//
// Fallback honesty: the feature is flag-gated OFF by default
// (Firestore config/ai). While off — or on any error, sign-out, or
// unusable output — this renders EXACTLY the placeholder the lead
// detail showed before B1 existed ("No brief yet…"), so the lead
// renders precisely as it did without AI. A brief is a labelled
// "AI suggestion": read-only, never sent anywhere, and the fixed
// C3 safety card is shown too when the gateway flags danger words
// in the job text.

import { useEffect, useRef, useState } from 'react';
import { Loader2, Sparkles } from 'lucide-react';
import {
  composeLeadBriefText,
  normalizeLeadBrief,
  type LeadBrief,
} from '@/lib/ai/business-ai';
import { SafetyCard } from '@/components/ai/SafetyCard';

type BriefState =
  | { kind: 'loading' }
  | { kind: 'unavailable' }
  | { kind: 'ready'; brief: LeadBrief; isMock: boolean; cacheHit: boolean; safety: boolean };

export function LeadAiBrief({
  jobText,
  category,
  suburb,
  getToken,
  onBrief,
}: {
  /** The lead's job description text (never contact details). */
  jobText: string;
  category?: string;
  suburb?: string;
  /** Resolves the caller's Firebase ID token, or undefined when signed out. */
  getToken: () => Promise<string | undefined>;
  /** Reports the brief up (B2 drafts from it); null on fallback. */
  onBrief?: (brief: LeadBrief | null) => void;
}) {
  const [state, setState] = useState<BriefState>({ kind: 'loading' });
  const onBriefRef = useRef(onBrief);
  onBriefRef.current = onBrief;
  const getTokenRef = useRef(getToken);
  getTokenRef.current = getToken;

  useEffect(() => {
    let cancelled = false;
    const report = (brief: LeadBrief | null) => {
      if (!cancelled) onBriefRef.current?.(brief);
    };
    if (!jobText.trim()) {
      setState({ kind: 'unavailable' });
      report(null);
      return;
    }
    setState({ kind: 'loading' });
    (async () => {
      try {
        const token = await getTokenRef.current();
        if (!token) {
          if (!cancelled) setState({ kind: 'unavailable' });
          report(null);
          return;
        }
        const res = await fetch('/api/ai', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({
            feature: 'photo-brief',
            input: {
              text: composeLeadBriefText({ description: jobText, category, suburb }),
              suburb: suburb ?? '',
              category: category ?? '',
            },
          }),
        });
        if (!res.ok) {
          if (!cancelled) setState({ kind: 'unavailable' });
          report(null);
          return;
        }
        const data = (await res.json()) as {
          fallback?: boolean;
          cacheHit?: boolean;
          output?: unknown;
          safetyCardShown?: boolean;
        };
        const normalized = data.fallback ? null : normalizeLeadBrief(data.output);
        if (!normalized) {
          if (!cancelled) setState({ kind: 'unavailable' });
          report(null);
          return;
        }
        if (!cancelled) {
          setState({
            kind: 'ready',
            brief: normalized.brief,
            isMock: normalized.isMock,
            cacheHit: data.cacheHit === true,
            safety: data.safetyCardShown === true,
          });
        }
        report(normalized.brief);
      } catch {
        if (!cancelled) setState({ kind: 'unavailable' });
        report(null);
      }
    })();
    return () => {
      cancelled = true;
    };
    // One fetch per lead (the page keys this component by lead id);
    // token/brief callbacks are read through refs so identity churn
    // in the parent never refires the call.
  }, [jobText, category, suburb]);

  if (state.kind === 'loading') {
    return (
      <div className="p-4 bg-mist rounded-xl border border-line space-y-2">
        <h4 className="font-bold text-xs uppercase tracking-widest text-slate flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-navy" /> AI job brief · Helpious Assist
        </h4>
        <p className="text-sm text-slate leading-relaxed flex items-center gap-2">
          <Loader2 className="w-4 h-4 animate-spin shrink-0" /> Generating the AI brief for this job…
        </p>
      </div>
    );
  }

  if (state.kind === 'unavailable') {
    // Exactly the pre-B1 placeholder: flag off (or any failure) means
    // the lead renders precisely as it did before AI was wired in.
    return (
      <div className="p-4 bg-mist rounded-xl border border-line space-y-2">
        <h4 className="font-bold text-xs uppercase tracking-widest text-slate flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-navy" /> AI job brief · Helpious Assist
        </h4>
        <p className="text-sm text-slate leading-relaxed">
          No brief yet. Helpious Assist isn&apos;t connected for this business, so no AI brief or draft has been generated.
          Briefs and drafts are always drafts only — you edit and send.
        </p>
      </div>
    );
  }

  const { brief, isMock, cacheHit, safety } = state;
  return (
    <div className="space-y-3">
      <div className="p-4 bg-mist rounded-xl border border-line space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h4 className="font-bold text-xs uppercase tracking-widest text-slate flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-navy" /> AI job brief · Helpious Assist
          </h4>
          <span className="text-[11px] font-bold uppercase tracking-widest bg-amber/20 text-navy border border-amber/40 rounded-full px-2 py-0.5">
            AI suggestion
          </span>
        </div>

        <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
          {brief.trade && (
            <p className="text-slate">
              <span className="font-bold text-primary">Trade:</span> {brief.trade}
            </p>
          )}
          {brief.urgency && (
            <p className="text-slate">
              <span className="font-bold text-primary">Urgency:</span> {brief.urgency}
            </p>
          )}
        </div>

        {brief.issue && (
          <div className="space-y-1">
            <p className="text-xs font-bold uppercase tracking-widest text-slate">Summary</p>
            <p className="text-sm text-slate leading-relaxed">{brief.issue}</p>
          </div>
        )}
        {brief.scope && (
          <div className="space-y-1">
            <p className="text-xs font-bold uppercase tracking-widest text-slate">Scope</p>
            <p className="text-sm text-slate leading-relaxed">{brief.scope}</p>
          </div>
        )}
        {brief.accessNotes && (
          <div className="space-y-1">
            <p className="text-xs font-bold uppercase tracking-widest text-slate">Access notes</p>
            <p className="text-sm text-slate leading-relaxed">{brief.accessNotes}</p>
          </div>
        )}
        {brief.questions.length > 0 && (
          <div className="space-y-1">
            <p className="text-xs font-bold uppercase tracking-widest text-slate">Questions to ask</p>
            <ul className="list-disc pl-5 space-y-1">
              {brief.questions.map((q, i) => (
                <li key={i} className="text-sm text-slate leading-relaxed">{q}</li>
              ))}
            </ul>
          </div>
        )}
        {brief.missingPhotos.length > 0 && (
          <div className="space-y-1">
            <p className="text-xs font-bold uppercase tracking-widest text-slate">Photos still missing</p>
            <ul className="list-disc pl-5 space-y-1">
              {brief.missingPhotos.map((m, i) => (
                <li key={i} className="text-sm text-slate leading-relaxed">{m}</li>
              ))}
            </ul>
          </div>
        )}

        <p className="text-xs text-slate font-medium leading-relaxed border-t border-line/60 pt-2">
          {isMock
            ? 'Mock preview — this brief is placeholder text from the mock provider, not a real AI brief. '
            : ''}
          {cacheHit ? 'Generated once for this job — repeat views use the cached brief at no extra cost. ' : ''}
          AI briefs are drafts only: check the details against the job before quoting.
        </p>
      </div>
      {safety && <SafetyCard />}
    </div>
  );
}

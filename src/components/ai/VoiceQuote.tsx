'use client';

// VOICE (business) — "Draft by voice" for the quote builder
// (hackathon, MUST feature), beside B2's QuoteAiDraft.
//
// Flow: the tradie records spoken notes on the lead (MediaRecorder
// where supported, or an audio file pick) -> the recording goes to
// the /api/ai gateway's 'voice-quote' feature together with the
// same composed context B2 sends (job text + B1 brief + the
// business's OWN servicePrices verbatim) -> the provider
// transcribes, PII-strips the transcript, and drafts line items ->
// the returned items pass through applyQuoteDraft(), the SAME
// deterministic own-prices guard as B2: a spoken price that is not
// in the business's own price strings is blanked and flagged "add
// your price", never kept. The transcript comes back on the output
// and is shown in an editable box; correcting it and drafting
// again is a text-only voice-quote call (no audio second time).
//
// AI never sends anything: the existing Send Quote flow is
// untouched and remains a human action. On fallback (flag off by
// default, over cap, transcription or model unavailable) the box
// shows one quiet note and the builder works exactly as before.
//
// Honest limits: the transcription endpoint shape is UNVERIFIED
// against the live Meta API (see docs/ai-gateway.md) — until the
// smoke test passes, a real recording may fall back; manual items
// and B2's typed draft always work. We do not store the recording:
// it lives in this component only long enough to make the call.

import { useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, Mic, Square, Upload } from 'lucide-react';
import {
  applyQuoteDraft,
  composeQuoteDraftText,
  priceEntriesFrom,
  type AppliedDraftItem,
  type LeadBrief,
} from '@/lib/ai/business-ai';
import {
  MAX_RECORDING_SECONDS,
  VoiceRecorder,
  appendTranscriptToText,
  audioSizeProblem,
  blobToWavDataUri,
  recorderSupported,
  transcriptFromOutput,
} from '@/lib/ai/voice-ai';

type VoiceState = 'idle' | 'recording' | 'working' | 'done' | 'unavailable';

export function VoiceQuote({
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
  const [canRecord, setCanRecord] = useState(false);
  const [state, setState] = useState<VoiceState>('idle');
  const [note, setNote] = useState('');
  const [seconds, setSeconds] = useState(0);
  const [transcript, setTranscript] = useState('');
  const [usedTranscript, setUsedTranscript] = useState('');
  const recorderRef = useRef<VoiceRecorder | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setCanRecord(recorderSupported());
    return () => {
      recorderRef.current?.cancel();
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  const transcriptEdited = transcript.trim() !== '' && transcript.trim() !== usedTranscript.trim();
  const busy = state === 'working';
  const mmss = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;

  function stopTimer() {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }

  function baseContextText(): string {
    return composeQuoteDraftText({ jobText, category, suburb, brief, priceEntries: entries });
  }

  async function callVoiceQuote(input: Record<string, unknown>): Promise<boolean> {
    setState('working');
    setNote('');
    try {
      const token = await getToken();
      if (!token) {
        setState('unavailable');
        setNote('Sign in to draft by voice — you can still add line items manually below.');
        return false;
      }
      const priceList: Record<string, string> = {};
      for (const e of entries) priceList[e.service] = e.price;
      const res = await fetch('/api/ai', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          feature: 'voice-quote',
          input: { ...input, priceList },
        }),
      });
      if (!res.ok) {
        setState('unavailable');
        setNote('Voice draft unavailable right now — add line items manually; the builder works as usual.');
        return false;
      }
      const data = (await res.json()) as { fallback?: boolean; output?: unknown };
      if (data.fallback) {
        setState('unavailable');
        setNote('Voice draft is switched off right now — add line items manually; the builder works as usual.');
        return false;
      }
      const heard = transcriptFromOutput(data.output);
      if (heard) {
        setTranscript(heard);
        setUsedTranscript(heard);
      }
      const applied = applyQuoteDraft(data.output, entries);
      if (applied.items.length === 0) {
        setState('unavailable');
        setNote('The voice draft came back empty — add line items manually; the builder works as usual.');
        return false;
      }
      onDraft(applied.items);
      const parts = [
        applied.isMock
          ? 'Mock preview — these items are placeholder text from the mock provider, not a real AI draft.'
          : `AI suggestion added below — ${applied.items.length} line item${applied.items.length > 1 ? 's' : ''} from your spoken notes, edit anything before sending.`,
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
      return true;
    } catch {
      setState('unavailable');
      setNote('Voice draft unavailable right now — add line items manually; the builder works as usual.');
      return false;
    }
  }

  async function handleAudioBlob(blob: Blob) {
    const problem = audioSizeProblem(blob.size);
    if (problem) {
      setState('idle');
      setNote(problem);
      return;
    }
    let dataUri: string;
    try {
      dataUri = await blobToWavDataUri(blob);
    } catch (err) {
      setState('idle');
      setNote(
        err instanceof Error && err.message
          ? err.message
          : 'Could not read that recording — add line items manually instead.',
      );
      return;
    }
    await callVoiceQuote({ text: baseContextText(), audioDataUri: dataUri });
  }

  async function startRecording() {
    setNote('');
    try {
      const recorder = new VoiceRecorder();
      recorderRef.current = recorder;
      await recorder.start();
    } catch {
      setState('idle');
      setNote('Could not start recording — check the microphone permission, or upload an audio file instead.');
      return;
    }
    setState('recording');
    setSeconds(0);
    const startedAt = Date.now();
    stopTimer();
    timerRef.current = setInterval(() => {
      const elapsed = Math.floor((Date.now() - startedAt) / 1000);
      setSeconds(elapsed);
      if (elapsed >= MAX_RECORDING_SECONDS) {
        void stopRecording();
      }
    }, 500);
  }

  async function stopRecording() {
    stopTimer();
    const recorder = recorderRef.current;
    if (!recorder) {
      setState('idle');
      return;
    }
    setState('working');
    try {
      const blob = await recorder.stop();
      await handleAudioBlob(blob);
    } catch {
      setState('idle');
      setNote('Recording failed — add line items manually, or try an audio file.');
    }
  }

  function cancelRecording() {
    stopTimer();
    recorderRef.current?.cancel();
    recorderRef.current = null;
    setState('idle');
    setNote('Recording cancelled — nothing was sent.');
  }

  async function handleFilePick(e: React.ChangeEvent<HTMLInputElement>) {
    const picked = e.target.files?.[0];
    e.target.value = '';
    if (!picked) return;
    await handleAudioBlob(picked);
  }

  async function handleRedraft() {
    const corrected = transcript.trim();
    if (corrected === '') return;
    const ok = await callVoiceQuote({
      text: appendTranscriptToText(baseContextText(), corrected),
      transcript: corrected,
    });
    if (ok) setUsedTranscript(corrected);
  }

  return (
    <div className="p-3 bg-mist rounded-xl border border-line space-y-2">
      <p className="text-xs text-slate leading-relaxed">
        <span className="font-bold text-primary">Draft by voice:</span>{' '}
        {state === 'done' || state === 'unavailable'
          ? note
          : 'Say the job out loud — labour, parts, anything to note — and AI drafts the line items from your words plus your own price list. Prices come only from your price list; a spoken price that isn\'t in it stays blank for you to price. We don\'t store the recording. The draft never sends.'}
      </p>
      {!canRecord && canDraft && state !== 'recording' && (
        <p className="text-xs text-slate leading-relaxed">
          Recording in this browser isn&apos;t supported — you can upload an audio file instead.
        </p>
      )}
      {state === 'recording' && (
        <p className="text-xs font-bold text-ink">
          Recording… {mmss} — tap Stop when you&apos;re done (max about {MAX_RECORDING_SECONDS} seconds).
        </p>
      )}
      {transcript !== '' && (
        <div className="space-y-2">
          <label className="block text-xs font-bold text-primary" htmlFor="voice-quote-transcript">
            This is what we heard — fix anything
          </label>
          <textarea
            id="voice-quote-transcript"
            value={transcript}
            onChange={(e) => setTranscript(e.target.value)}
            rows={3}
            className="w-full rounded-xl border border-line bg-white p-2.5 text-xs font-medium text-ink"
          />
          {transcriptEdited && canDraft && (
            <button
              type="button"
              onClick={handleRedraft}
              disabled={busy || jobText.trim() === ''}
              className="rounded-xl bg-white px-3 py-1.5 text-xs font-bold border border-line hover:border-navy disabled:opacity-50"
            >
              {busy ? 'Drafting…' : 'Draft again from the corrected text'}
            </button>
          )}
        </div>
      )}
      {canDraft ? (
        <div className="flex flex-wrap gap-2">
          {canRecord &&
            (state === 'recording' ? (
              <>
                <button
                  type="button"
                  onClick={stopRecording}
                  className="flex items-center gap-2 rounded-xl bg-navy px-4 py-2 text-xs font-bold text-white"
                >
                  <Square className="w-3.5 h-3.5" /> Stop — {mmss}
                </button>
                <button
                  type="button"
                  onClick={cancelRecording}
                  className="rounded-xl bg-white px-3 py-2 text-xs font-bold border border-line hover:border-navy"
                >
                  Cancel
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={startRecording}
                disabled={busy || jobText.trim() === ''}
                className="flex items-center gap-2 rounded-xl bg-navy px-4 py-2 text-xs font-bold text-white disabled:opacity-50"
              >
                {busy ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Mic className="w-3.5 h-3.5" />
                )}
                {busy ? 'Working…' : state === 'done' ? 'Draft by voice again' : 'Draft by voice'}
              </button>
            ))}
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={busy || state === 'recording' || jobText.trim() === ''}
            className="flex items-center gap-2 rounded-xl bg-white px-3 py-2 text-xs font-bold border border-line hover:border-navy disabled:opacity-50"
          >
            <Upload className="w-3.5 h-3.5" /> Upload audio
          </button>
          <input ref={fileRef} type="file" accept="audio/*" className="hidden" onChange={handleFilePick} />
        </div>
      ) : (
        <p className="text-xs text-slate font-medium">Use Update Quote to draft by voice.</p>
      )}
    </div>
  );
}

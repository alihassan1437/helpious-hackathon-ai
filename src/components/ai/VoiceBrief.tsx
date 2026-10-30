'use client';

// VOICE (customer) — "Describe it by voice" on get-quote step 2,
// beside C1's SnapPhotoBrief (hackathon, MUST feature).
//
// Flow: record in the browser (MediaRecorder, where supported) or
// pick an audio file -> the recording goes to the /api/ai gateway's
// 'voice-brief' feature as an audioDataUri -> the provider
// transcribes it, PII-strips the transcript, and drafts the brief
// -> the transcript comes back on the output and is shown in an
// EDITABLE box ("This is what we heard — fix anything") -> the
// brief flows into the SAME apply-or-dismiss suggestion card C1
// uses (via the parent's onBrief). If the user corrects the
// transcript, "Draft again" re-runs voice-brief as a text-only
// transcript call — no audio involved the second time.
//
// Honest limits, stated in the UI itself:
//   - The gateway is OFF by default (config/ai flag). While off the
//     call returns { fallback: true } and this component says so —
//     the manual form keeps working exactly as today.
//   - The transcription endpoint shape is UNVERIFIED against the
//     live Meta API (see docs/ai-gateway.md). Until the smoke test
//     passes, a real recording may fall back; typed text always
//     works. Nothing here pretends otherwise.
//   - We do not store the recording: it lives in this component
//     only long enough to make the one gateway call, and the route
//     never stores raw input. The transcript shown is the stripped
//     one the gateway returns (contact details said out loud are
//     removed server-side before the brief is written) — it is the
//     user's own words, editable, and never auto-submitted.
//   - This component never submits, never validates, and never
//     changes the quote submit path.

import { useEffect, useRef, useState } from 'react';
import { Loader2, Mic, Square, Upload } from 'lucide-react';
import {
  MAX_RECORDING_SECONDS,
  VoiceRecorder,
  audioSizeProblem,
  blobToWavDataUri,
  normalizeVoiceBrief,
  recorderSupported,
  transcriptFromOutput,
} from '@/lib/ai/voice-ai';
import type { PhotoBriefDraft } from '@/components/ai/SnapPhotoBrief';

type VoiceState = 'idle' | 'recording' | 'working' | 'done' | 'unavailable';

export function VoiceBrief({
  description,
  getToken,
  onBrief,
  onSafetyShown,
}: {
  /** Current typed description, sent as context with the recording. */
  description: string;
  /** Resolves the caller's Firebase ID token, or undefined when signed out. */
  getToken: () => Promise<string | undefined>;
  /** Parent shows the brief in the shared apply-or-dismiss suggestion card. */
  onBrief: (draft: PhotoBriefDraft) => void;
  /** Parent shows/hides the fixed safety card. */
  onSafetyShown: (shown: boolean) => void;
}) {
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

  function stopTimer() {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }

  async function callVoiceBrief(input: Record<string, unknown>): Promise<boolean> {
    setState('working');
    setNote('');
    try {
      const token = await getToken();
      if (!token) {
        setState('idle');
        setNote(
          'Sign in to use voice — the gateway needs a signed-in account. You can still type the description instead.',
        );
        return false;
      }
      const res = await fetch('/api/ai', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ feature: 'voice-brief', input }),
      });
      if (!res.ok) {
        setState('unavailable');
        setNote('Voice brief is unavailable right now — type the description instead; the manual form still works.');
        return false;
      }
      const data = (await res.json()) as {
        fallback?: boolean;
        output?: unknown;
        safetyCardShown?: boolean;
      };
      onSafetyShown(data.safetyCardShown === true);
      if (data.fallback) {
        setState('unavailable');
        setNote('Voice brief is switched off right now — type the description instead; the manual form still works.');
        return false;
      }
      const heard = transcriptFromOutput(data.output);
      if (heard) {
        setTranscript(heard);
        setUsedTranscript(heard);
      }
      const draft = normalizeVoiceBrief(data.output);
      if (!draft) {
        setState('unavailable');
        setNote('The voice brief came back empty — type the description instead; the manual form still works.');
        return false;
      }
      onBrief(draft);
      setState('done');
      setNote(
        draft.isMock
          ? 'Mock preview — this draft is placeholder text from the mock brief, not a real AI brief. Edit it freely.'
          : 'AI suggestion — check it and edit anything before continuing.',
      );
      return true;
    } catch {
      setState('unavailable');
      setNote('Voice brief is unavailable right now — type the description instead; the manual form still works.');
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
          : 'Could not read that recording — type the description instead.',
      );
      return;
    }
    await callVoiceBrief({ text: description, audioDataUri: dataUri });
  }

  async function startRecording() {
    setNote('');
    try {
      const recorder = new VoiceRecorder();
      recorderRef.current = recorder;
      await recorder.start();
    } catch {
      setState('idle');
      setNote(
        'Could not start recording — check the microphone permission, or upload an audio file instead.',
      );
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
      setNote('Recording failed — type the description instead, or try an audio file.');
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
    const ok = await callVoiceBrief({ transcript: corrected, text: corrected });
    if (ok) setUsedTranscript(corrected);
  }

  const busy = state === 'working';
  const mmss = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;

  return (
    <div className="space-y-3 rounded-xl border border-line bg-mist p-4">
      <p className="text-sm font-bold text-ink">Describe it by voice (optional)</p>
      <p className="text-xs font-medium leading-relaxed text-slate">
        Talk instead of typing — up to about a minute. We turn your recording into text and draft the
        description from it. We don&apos;t store the recording: it&apos;s used once, for the transcript
        and the brief. Contact details you say out loud are removed from the text before the AI writes
        the brief, and the gateway is off by default, so the manual form always works.
      </p>
      <div className="flex flex-wrap gap-2">
        {canRecord &&
          (state === 'recording' ? (
            <>
              <button
                type="button"
                onClick={stopRecording}
                className="flex items-center gap-2 rounded-xl bg-navy px-4 py-2 text-sm font-bold text-white"
              >
                <Square className="h-3.5 w-3.5" /> Stop — {mmss}
              </button>
              <button
                type="button"
                onClick={cancelRecording}
                className="rounded-xl bg-white px-4 py-2 text-sm font-bold border border-line hover:border-navy"
              >
                Cancel
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={startRecording}
              disabled={busy}
              className="flex items-center gap-2 rounded-xl bg-navy px-4 py-2 text-sm font-bold text-white disabled:opacity-50"
            >
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Mic className="h-3.5 w-3.5" />}
              {busy ? 'Working…' : 'Record'}
            </button>
          ))}
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={busy || state === 'recording'}
          className="flex items-center gap-2 rounded-xl bg-white px-4 py-2 text-sm font-bold border border-line hover:border-navy disabled:opacity-50"
        >
          <Upload className="h-3.5 w-3.5" /> Upload audio
        </button>
        <input ref={fileRef} type="file" accept="audio/*" className="hidden" onChange={handleFilePick} />
      </div>
      {!canRecord && (
        <p className="text-xs font-medium leading-relaxed text-slate">
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
          <label className="block text-xs font-bold text-ink" htmlFor="voice-brief-transcript">
            This is what we heard — fix anything
          </label>
          <textarea
            id="voice-brief-transcript"
            value={transcript}
            onChange={(e) => setTranscript(e.target.value)}
            rows={3}
            className="w-full rounded-xl border border-line bg-white p-3 text-sm font-medium text-ink"
          />
          {transcriptEdited && (
            <button
              type="button"
              onClick={handleRedraft}
              disabled={busy}
              className="rounded-xl bg-white px-4 py-2 text-sm font-bold border border-line hover:border-navy disabled:opacity-50"
            >
              {busy ? 'Drafting…' : 'Draft again from the corrected text'}
            </button>
          )}
        </div>
      )}
      {note && <p className="text-xs font-medium leading-relaxed text-slate">{note}</p>}
    </div>
  );
}

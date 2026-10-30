// Voice helpers for the VOICE surfaces (hackathon): the customer's
// "Describe it by voice" on get-quote (voice-brief) and the tradie's
// "Draft by voice" on a lead (voice-quote).
//
// Pure, dependency-free helpers shared by src/components/ai/
// VoiceBrief.tsx + VoiceQuote.tsx and the unit tests
// (tests/ai-voice.test.mjs). Recording is a thin class over
// MediaRecorder so component state stays in the components and this
// module never touches window/document at import time (Node-safe).
//
// Honesty rules this module exists to keep:
//   - A recording is capped at 4 MB (hard check before anything is
//     sent) and guided to ~60 seconds in the UI; the recorder asks
//     for ~32 kbps so a minute of speech is ~240 KB.
//   - Nothing here persists audio: the blob lives in component
//     state only long enough to become one gateway call. We do not
//     store recordings (the route never stores raw input either).
//   - The transcript the UI shows comes back in the gateway output
//     and is ALREADY PII-stripped server-side (the provider strips
//     the transcript before the brief/quote model call and returns
//     the stripped text — see provider.ts). It is the user's own
//     words, shown back to them in an editable box.

import { normalizeLeadBrief } from './business-ai';

// ---------------------------------------------------------------------
// Caps (the provider enforces the same byte cap server-side; the
// route caps the data-URI length — see provider.ts MAX_AUDIO_BYTES
// and route.ts MAX_AUDIO_DATA_URI_CHARS)
// ---------------------------------------------------------------------

export const MAX_AUDIO_BYTES = 4 * 1024 * 1024;
export const MAX_RECORDING_SECONDS = 60;
/** ~32 kbps: small files, plenty for speech. */
export const RECORDING_BITS_PER_SECOND = 32_000;

/** Null when the size is sendable; a plain user-facing reason otherwise. */
export function audioSizeProblem(sizeBytes: number): string | null {
  if (!Number.isFinite(sizeBytes) || sizeBytes < 0) return 'That recording could not be read.';
  if (sizeBytes === 0) return 'That recording is empty — try again.';
  if (sizeBytes > MAX_AUDIO_BYTES) {
    return 'That recording is too large (max 4 MB) — try a shorter one.';
  }
  return null;
}

// ---------------------------------------------------------------------
// Data-URI handling
// ---------------------------------------------------------------------

/**
 * FileReader sometimes yields a data URL with an empty or generic
 * mime (`data:;base64,...`) when the Blob's type was not set. The
 * provider requires a `data:audio/...` URI, so splice the blob's
 * real audio mime in when the URL lacks one. A URL that already
 * carries an audio mime is returned untouched.
 */
export function ensureAudioDataUri(dataUrl: string, mimeType: string): string {
  if (dataUrl.startsWith('data:audio/')) return dataUrl;
  const mime = (mimeType ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  if (!mime.startsWith('audio/')) return dataUrl;
  const marker = ';base64,';
  const at = dataUrl.indexOf(marker);
  if (!dataUrl.startsWith('data:') || at < 0) return dataUrl;
  return `data:${mime}${dataUrl.slice(at)}`;
}

/** Reads a recorded/picked audio Blob into the data URI the gateway takes. */
export function blobToAudioDataUri(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read that recording.'));
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      if (!result.startsWith('data:') || !result.includes(';base64,')) {
        reject(new Error('Could not read that recording.'));
        return;
      }
      resolve(ensureAudioDataUri(result, blob.type ?? ''));
    };
    reader.readAsDataURL(blob);
  });
}

// ---------------------------------------------------------------------
// WAV conversion (the transcribe endpoint takes WAV only)
// ---------------------------------------------------------------------

/** The transcribe engine is native 24 kHz and resamples 16 kHz. */
export const TARGET_SAMPLE_RATE = 16_000;

/**
 * Encodes mono Float32 samples as a 16-bit PCM WAV data URI
 * (`data:audio/wav;base64,...`). Pure and synchronous, so it is
 * unit-testable without a browser.
 */
export function encodeWavDataUri(samples: Float32Array, sampleRate: number): string {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  const writeAscii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeAscii(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return `data:audio/wav;base64,${btoa(binary)}`;
}

/**
 * Converts a recorded or picked audio Blob (webm/m4a/mp3/wav —
 * whatever the browser produced) into the mono 16 kHz WAV data URI
 * the transcription endpoint accepts, via WebAudio decode + an
 * offline resample (which also downmixes to mono). Throws an Error
 * with a user-facing message when the browser cannot decode the
 * audio or the clip runs too long once converted.
 */
export async function blobToWavDataUri(blob: Blob): Promise<string> {
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) throw new Error('Voice is not supported in this browser — type it instead.');
  const ctx = new Ctor();
  try {
    const raw = await blob.arrayBuffer();
    let decoded: AudioBuffer;
    try {
      decoded = await ctx.decodeAudioData(raw);
    } catch {
      throw new Error('That audio format could not be converted — try recording instead.');
    }
    if (decoded.duration > MAX_RECORDING_SECONDS + 15) {
      throw new Error(
        `That recording is too long — keep it under about ${MAX_RECORDING_SECONDS} seconds.`,
      );
    }
    const offline = new OfflineAudioContext(
      1,
      Math.max(1, Math.ceil(decoded.duration * TARGET_SAMPLE_RATE)),
      TARGET_SAMPLE_RATE,
    );
    const source = offline.createBufferSource();
    source.buffer = decoded;
    source.connect(offline.destination);
    source.start();
    const rendered = await offline.startRendering();
    return encodeWavDataUri(rendered.getChannelData(0), TARGET_SAMPLE_RATE);
  } finally {
    void ctx.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------
// Recorder (MediaRecorder wrapper — no React, components own state)
// ---------------------------------------------------------------------

export const RECORDER_MIME_CANDIDATES: readonly string[] = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4',
  'audio/ogg;codecs=opus',
  '',
];

/**
 * True when in-browser recording can work here (secure context +
 * getUserMedia + MediaRecorder). False is a normal state — the UI
 * falls back to an audio file pick and says so.
 */
export function recorderSupported(): boolean {
  try {
    return (
      typeof window !== 'undefined' &&
      typeof navigator !== 'undefined' &&
      !!navigator.mediaDevices &&
      typeof navigator.mediaDevices.getUserMedia === 'function' &&
      typeof window.MediaRecorder === 'function'
    );
  } catch {
    return false;
  }
}

export function pickRecorderMimeType(): string {
  if (!recorderSupported()) return '';
  const mr = window.MediaRecorder as unknown as {
    isTypeSupported?: (type: string) => boolean;
  };
  for (const candidate of RECORDER_MIME_CANDIDATES) {
    if (candidate === '') return '';
    try {
      if (typeof mr.isTypeSupported === 'function' && mr.isTypeSupported(candidate)) {
        return candidate;
      }
    } catch {
      // Keep looking; '' (browser default) is the last resort.
    }
  }
  return '';
}

/**
 * One recording session. start() opens the mic and records;
 * stop() resolves with the audio Blob; cancel() throws the take
 * away. Mic tracks are always stopped on stop/cancel/error so the
 * browser's recording indicator clears.
 */
export class VoiceRecorder {
  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private onStopped: ((blob: Blob) => void) | null = null;
  private onFailed: ((err: Error) => void) | null = null;
  recording = false;

  async start(): Promise<void> {
    if (!recorderSupported()) {
      throw new Error('Recording is not supported in this browser.');
    }
    this.cancel();
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    this.stream = stream;
    const mimeType = pickRecorderMimeType();
    const recorder = new MediaRecorder(stream, {
      ...(mimeType ? { mimeType } : {}),
      audioBitsPerSecond: RECORDING_BITS_PER_SECOND,
    });
    this.chunks = [];
    recorder.ondataavailable = (event: BlobEvent) => {
      if (event.data && event.data.size > 0) this.chunks.push(event.data);
    };
    recorder.onstop = () => {
      const blob = new Blob(this.chunks, {
        type: recorder.mimeType || mimeType || 'audio/webm',
      });
      const cb = this.onStopped;
      this.onStopped = null;
      this.onFailed = null;
      this.cleanup();
      cb?.(blob);
    };
    recorder.onerror = () => {
      const cb = this.onFailed;
      this.onStopped = null;
      this.onFailed = null;
      this.cleanup();
      cb?.(new Error('Recording failed.'));
    };
    this.recorder = recorder;
    this.recording = true;
    recorder.start(250);
  }

  stop(): Promise<Blob> {
    return new Promise((resolve, reject) => {
      if (!this.recorder || !this.recording) {
        reject(new Error('Not recording.'));
        return;
      }
      this.onStopped = resolve;
      this.onFailed = reject;
      try {
        this.recorder.stop();
      } catch {
        this.cleanup();
        reject(new Error('Recording failed.'));
      }
    });
  }

  cancel(): void {
    const recorder = this.recorder;
    this.onStopped = null;
    this.onFailed = null;
    if (recorder && this.recording) {
      recorder.onstop = null;
      recorder.onerror = null;
      try {
        recorder.stop();
      } catch {
        // Already stopped; cleanup below still runs.
      }
    }
    this.cleanup();
  }

  private cleanup(): void {
    this.recording = false;
    this.recorder = null;
    if (this.stream) {
      for (const track of this.stream.getTracks()) track.stop();
      this.stream = null;
    }
  }
}

// ---------------------------------------------------------------------
// Output handling
// ---------------------------------------------------------------------

/** The (PII-stripped) transcript the gateway returns on the output, or ''. */
export function transcriptFromOutput(output: unknown): string {
  if (output !== null && typeof output === 'object' && !Array.isArray(output)) {
    const t = (output as Record<string, unknown>).transcript;
    if (typeof t === 'string') return t;
  }
  return '';
}

/**
 * The label the provider puts in front of the transcript when it
 * composes the quote model's input (see provider.ts — the two must
 * stay in step). The client uses the same label when re-drafting
 * from a user-corrected transcript, which is a text-only call where
 * no server-side composition happens.
 */
export const SPOKEN_NOTES_LABEL = 'Spoken notes (transcript):';

/** Composes a text payload from the base context + a transcript. */
export function appendTranscriptToText(baseText: string, transcript: string): string {
  const base = baseText.trim();
  const heard = transcript.trim();
  if (heard === '') return base;
  if (base === '') return heard;
  return `${base}\n\n${SPOKEN_NOTES_LABEL}\n${heard}`;
}

/**
 * The draft shape the get-quote suggestion card renders (structurally
 * the PhotoBriefDraft from SnapPhotoBrief): a voice brief IS a brief,
 * so it flows through the exact same apply-or-dismiss card as C1.
 */
export interface VoiceBriefDraft {
  trade: string;
  issue: string;
  scope: string;
  urgency: string;
  questions: string[];
  isMock: boolean;
}

/** Normalises a voice-brief gateway output; null when not a usable brief. */
export function normalizeVoiceBrief(output: unknown): VoiceBriefDraft | null {
  const normalized = normalizeLeadBrief(output);
  if (!normalized) return null;
  return {
    trade: normalized.brief.trade,
    issue: normalized.brief.issue,
    scope: normalized.brief.scope,
    urgency: normalized.brief.urgency,
    questions: normalized.brief.questions,
    isMock: normalized.isMock,
  };
}

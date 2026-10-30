// Unit tests for VOICE (hackathon): the transcription transport in
// src/lib/ai/provider.ts (callTranscribe / parseAudioDataUri), the
// gateway + provider plumbing that turns a recording into a brief /
// quote draft, and the client helpers in src/lib/ai/voice-ai.ts.
// Run: node --import ./tests/register.mjs tests/ai-voice.test.mjs
// No key, no network, NO REAL AUDIO: every Meta call goes through an
// injected stub fetch and the "recording" is a few fake bytes whose
// content is never played or sent anywhere real.
//
// The transcription endpoint shape was VERIFIED live on 2026-10-30
// (contract from Meta's official cookbook + a real call with a
// synthesized test sentence): POST /v1/asr/transcribe, multipart
// with a JSON `request` part + an `audio` part holding WAV, and a
// `transcript` string back. These tests lock that contract plus the
// fail-soft behaviour and the PII strip of the transcript.
import assert from 'node:assert';
import {
  MAX_AUDIO_BYTES,
  TRANSCRIBE_MODEL,
  callTranscribe,
  createMetaProvider,
  parseAudioDataUri,
} from '../src/lib/ai/provider.ts';
import { mockAiProvider, runAiFeature } from '../src/lib/ai/gateway.ts';
import { applyQuoteDraft, priceEntriesFrom } from '../src/lib/ai/business-ai.ts';
import {
  SPOKEN_NOTES_LABEL,
  appendTranscriptToText,
  audioSizeProblem,
  encodeWavDataUri,
  ensureAudioDataUri,
  transcriptFromOutput,
} from '../src/lib/ai/voice-ai.ts';

let passed = 0;
const tests = [];
const check = (name, fn) => {
  const out = fn();
  if (out && typeof out.then === 'function') return out.then(() => { passed++; console.log(`ok - ${name}`); });
  passed++;
  console.log(`ok - ${name}`);
};

// Stub fetch: records the RAW init (JSON bodies stay strings,
// multipart bodies stay FormData — each handler inspects what it
// cares about).
function stubFetch(handler) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return handler(url, init, calls);
  };
  fn.calls = calls;
  return fn;
}

function jsonResponse(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => 'application/json' },
    json: async () => data,
  };
}

function chatResponse(content) {
  return jsonResponse({ choices: [{ message: { content } }] });
}

const FAKE_AUDIO_BYTES = Buffer.from('fake voice note bytes — not real audio');
const FAKE_AUDIO_URI = `data:audio/wav;base64,${FAKE_AUDIO_BYTES.toString('base64')}`;

const VALID_BRIEF_JSON = JSON.stringify({
  trade: 'plumber',
  issue: 'Kitchen tap leaking steadily.',
  scope: 'Replace the tap washer and reseat.',
  urgency: 'Routine',
  accessNotes: '',
  questions: ['When did it start?'],
  missingPhotos: [],
});

// parseAudioDataUri -------------------------------------------------------
tests.push(() => check('parseAudioDataUri: wav URI parses (mime, bytes, filename)', () => {
  const parsed = parseAudioDataUri(FAKE_AUDIO_URI);
  assert.ok(parsed);
  assert.equal(parsed.mime, 'audio/wav');
  assert.equal(parsed.filename, 'recording.wav');
  assert.ok(Buffer.from(parsed.bytes).equals(FAKE_AUDIO_BYTES));
}));
tests.push(() => check('parseAudioDataUri: filename follows the mime (mp4 -> m4a, mpeg -> mp3)', () => {
  const b64 = FAKE_AUDIO_BYTES.toString('base64');
  assert.equal(parseAudioDataUri(`data:audio/mp4;base64,${b64}`).filename, 'recording.m4a');
  assert.equal(parseAudioDataUri(`data:audio/mpeg;base64,${b64}`).filename, 'recording.mp3');
  assert.equal(parseAudioDataUri(`data:audio/wav;base64,${b64}`).filename, 'recording.wav');
}));
tests.push(() => check('parseAudioDataUri: rejects non-audio, non-base64, empty, non-string', () => {
  const b64 = FAKE_AUDIO_BYTES.toString('base64');
  assert.equal(parseAudioDataUri(`data:image/png;base64,${b64}`), null);
  assert.equal(parseAudioDataUri('data:audio/webm,plainpayload'), null);
  assert.equal(parseAudioDataUri('data:audio/webm;base64,'), null);
  assert.equal(parseAudioDataUri('data:;base64,' + b64), null);
  assert.equal(parseAudioDataUri('https://example.com/note.webm'), null);
  assert.equal(parseAudioDataUri(42), null);
  assert.equal(parseAudioDataUri(null), null);
  assert.equal(parseAudioDataUri(undefined), null);
}));

// callTranscribe ----------------------------------------------------------
tests.push(() => check('callTranscribe: VERIFIED multipart shape (request JSON + audio WAV parts), no manual Content-Type, returns transcript', async () => {
  let seen = null;
  const fetchStub = stubFetch(async (url, init) => {
    seen = { url, init };
    return jsonResponse({ transcript: '  hello tradie  ' });
  });
  const text = await callTranscribe(fetchStub, 'test-key', FAKE_AUDIO_URI);
  assert.equal(text, '  hello tradie  ');
  assert.equal(seen.url, 'https://api.meta.ai/v1/asr/transcribe');
  assert.equal(seen.init.method, 'POST');
  assert.equal(seen.init.headers.Authorization, 'Bearer test-key');
  assert.ok(!('Content-Type' in seen.init.headers), 'multipart boundary must be set by the runtime');
  const form = seen.init.body;
  assert.ok(form instanceof FormData, 'body must be FormData');
  assert.equal(form.get('model'), null, 'no bare model form field in the verified shape');
  assert.equal(form.get('file'), null, 'no file field in the verified shape');
  const requestPart = form.get('request');
  assert.ok(requestPart && typeof requestPart === 'object', 'request part present');
  assert.equal(requestPart.type, 'application/json');
  const requestJson = JSON.parse(await requestPart.text());
  assert.deepEqual(requestJson, { mode: 'PUSH_TO_TALK', model: 'muse-voice-transcribe-1.0', audioEncoding: 'WAV' });
  assert.equal(TRANSCRIBE_MODEL, 'muse-voice-transcribe-1.0');
  const audio = form.get('audio');
  assert.ok(audio && typeof audio === 'object', 'audio part present');
  assert.equal(audio.name, 'recording.wav');
  assert.equal(audio.type, 'audio/wav');
  assert.equal(audio.size, FAKE_AUDIO_BYTES.length);
}));
tests.push(() => check('callTranscribe: non-200, missing text, and blank text all throw (fail soft upstream)', async () => {
  const httpFail = stubFetch(async () => jsonResponse({ error: 'nope' }, 500));
  await assert.rejects(callTranscribe(httpFail, 'test-key', FAKE_AUDIO_URI), /HTTP 500/);
  const noText = stubFetch(async () => jsonResponse({ results: [] }));
  await assert.rejects(callTranscribe(noText, 'test-key', FAKE_AUDIO_URI), /no text/);
  const blankText = stubFetch(async () => jsonResponse({ transcript: '   ' }));
  await assert.rejects(callTranscribe(blankText, 'test-key', FAKE_AUDIO_URI), /no text/);
}));
tests.push(() => check('callTranscribe: malformed + oversize recordings throw BEFORE any network call', async () => {
  const fetchStub = stubFetch(async () => { throw new Error('network must not be called'); });
  await assert.rejects(callTranscribe(fetchStub, 'test-key', 'data:audio/webm;base64,'), /could not be read/);
  const big = Buffer.alloc(MAX_AUDIO_BYTES + 1, 7);
  const bigUri = `data:audio/wav;base64,${big.toString('base64')}`;
  await assert.rejects(callTranscribe(fetchStub, 'test-key', bigUri), /too large/);
  // A non-WAV recording (the client converts to WAV before upload)
  // is rejected before any network call too.
  const webmUri = `data:audio/webm;base64,${FAKE_AUDIO_BYTES.toString('base64')}`;
  await assert.rejects(callTranscribe(fetchStub, 'test-key', webmUri), /not WAV/);
  assert.equal(fetchStub.calls.length, 0);
}));

// Gateway + provider plumbing ---------------------------------------------
tests.push(() => check('voice-brief with audio: transcribe -> PII strip -> brief; stripped transcript on output', async () => {
  const spoken = 'The kitchen tap is leaking badly, call me on 0412 345 678 when you can';
  let chatUserContent = null;
  const fetchStub = stubFetch(async (url, init) => {
    if (url.includes('/asr/transcribe')) return jsonResponse({ transcript: spoken });
    if (url.includes('/chat/completions')) {
      const body = JSON.parse(init.body);
      chatUserContent = body.messages[1].content;
      return chatResponse(VALID_BRIEF_JSON);
    }
    throw new Error(`unexpected URL ${url}`);
  });
  const provider = createMetaProvider('test-key', fetchStub);
  const r = await runAiFeature({
    feature: 'voice-brief',
    input: { text: '', audioDataUri: FAKE_AUDIO_URI },
    provider,
  });
  assert.equal(r.fallback, null);
  assert.equal(r.output.trade, 'plumber');
  // The transcript the UI shows is the STRIPPED one.
  assert.equal(r.output.transcript, 'The kitchen tap is leaking badly, call me on [phone removed] when you can');
  // The brief model never saw the phone number.
  assert.ok(chatUserContent.includes('leaking badly'), chatUserContent);
  assert.ok(chatUserContent.includes('[phone removed]'), chatUserContent);
  assert.ok(!chatUserContent.includes('0412 345 678'), chatUserContent);
  // Exactly one transcribe + one chat, transcribe first.
  assert.equal(fetchStub.calls.length, 2);
  assert.ok(fetchStub.calls[0].url.includes('/asr/transcribe'));
  assert.ok(fetchStub.calls[1].url.includes('/chat/completions'));
}));
tests.push(() => check('voice-quote with audio: context + transcript reach the model; B2 own-prices guard strips the invented price', async () => {
  const entries = priceEntriesFrom({ 'Fix a leaking tap': 'From $120', 'Call-out fee': '$80' });
  const contextText =
    "Job description: Fix a leaking tap\n\nThe business's own price list (the ONLY prices you may use):\n- Fix a leaking tap: From $120\n- Call-out fee: $80";
  const spoken = 'Two hours labour on the tap, plus a solid gold tap upgrade for nine hundred';
  let chatUserContent = null;
  const fetchStub = stubFetch(async (url, init) => {
    if (url.includes('/asr/transcribe')) return jsonResponse({ transcript: spoken });
    if (url.includes('/chat/completions')) {
      const body = JSON.parse(init.body);
      chatUserContent = body.messages[1].content;
      return chatResponse(JSON.stringify({
        lineItems: [
          { description: 'Fix a leaking tap', price: 120, priceMissing: false },
          { description: 'Solid gold tap upgrade', price: 900, priceMissing: false },
        ],
        total: 1020,
        notes: 'From spoken notes.',
      }));
    }
    throw new Error(`unexpected URL ${url}`);
  });
  const provider = createMetaProvider('test-key', fetchStub);
  const r = await runAiFeature({
    feature: 'voice-quote',
    input: { text: contextText, audioDataUri: FAKE_AUDIO_URI },
    provider,
  });
  assert.equal(r.fallback, null);
  assert.equal(r.output.transcript, spoken);
  assert.ok(chatUserContent.includes('From $120'), 'price-list context preserved');
  assert.ok(chatUserContent.includes('solid gold tap upgrade'), 'transcript included');
  assert.ok(chatUserContent.includes(SPOKEN_NOTES_LABEL), 'transcript labelled');
  // The SAME guard B2 uses, applied to the voice-quote output:
  const applied = applyQuoteDraft(r.output, entries);
  assert.equal(applied.items.length, 2);
  assert.equal(applied.items[0].unitPrice, '120');
  assert.equal(applied.items[0].priceMissing, false);
  assert.equal(applied.items[1].unitPrice, '', 'spoken $900 is not in the price list — stripped');
  assert.equal(applied.items[1].priceMissing, true);
  assert.equal(applied.removedPrices, 1);
}));
tests.push(() => check('transcription HTTP failure falls back (never throws to the caller)', async () => {
  const fetchStub = stubFetch(async (url) => {
    if (url.includes('/asr/transcribe')) return jsonResponse({ error: 'down' }, 503);
    return chatResponse(VALID_BRIEF_JSON);
  });
  const provider = createMetaProvider('test-key', fetchStub);
  const r = await runAiFeature({
    feature: 'voice-brief',
    input: { audioDataUri: FAKE_AUDIO_URI },
    provider,
  });
  assert.equal(r.output, null);
  assert.equal(r.fallback.fallback, true);
}));
tests.push(() => check('hung transcription falls back within the gateway budget', async () => {
  const fetchStub = stubFetch(() => new Promise(() => {}));
  const provider = createMetaProvider('test-key', fetchStub);
  const start = Date.now();
  const r = await runAiFeature({
    feature: 'voice-brief',
    input: { audioDataUri: FAKE_AUDIO_URI },
    provider,
    timeoutMs: 50,
  });
  assert.equal(r.fallback.fallback, true);
  assert.ok(Date.now() - start < 5000, `took ${Date.now() - start}ms`);
}));
tests.push(() => check('text-only voice-brief (transcript input) never calls transcription', async () => {
  const fetchStub = stubFetch(async (url) => {
    if (url.includes('/asr/transcribe')) throw new Error('transcription must not be called');
    return chatResponse(VALID_BRIEF_JSON);
  });
  const provider = createMetaProvider('test-key', fetchStub);
  const r = await runAiFeature({
    feature: 'voice-brief',
    input: { transcript: 'spoken words typed out', text: 'spoken words typed out' },
    provider,
  });
  assert.equal(r.fallback, null);
  assert.equal(r.output.trade, 'plumber');
  assert.ok(!('transcript' in r.output), 'no transcript is attached for a text-only call');
  assert.equal(fetchStub.calls.length, 1);
}));

// Gateway strip integrity ---------------------------------------------------
tests.push(() => check('gateway never PII-strips the base64 audio payload (digit chains survive intact)', async () => {
  // This payload contains a 10-digit run — the strip's digit-chain
  // rule would eat it if the audio were stripped as text.
  const uri = 'data:audio/webm;base64,QUJD1234567890REVG';
  const r = await runAiFeature({
    feature: 'voice-brief',
    input: { audioDataUri: uri },
    provider: mockAiProvider,
  });
  assert.equal(r.strippedInput.audioDataUri, uri);
  assert.equal(r.fallback, null);
  assert.ok(!('transcript' in r.output), 'the mock cannot transcribe — no transcript is invented');
  // Control: ordinary text is still stripped exactly as before.
  const control = await runAiFeature({
    feature: 'photo-brief',
    input: { text: 'call me on 0412 345 678' },
    provider: mockAiProvider,
  });
  assert.ok(control.strippedInput.text.includes('[phone removed]'));
}));

// voice-ai.ts helpers -------------------------------------------------------
tests.push(() => check('audioSizeProblem: empty / at-cap / over-cap boundaries', () => {
  assert.match(audioSizeProblem(0), /empty/);
  assert.equal(audioSizeProblem(1024), null);
  assert.equal(audioSizeProblem(MAX_AUDIO_BYTES), null);
  assert.match(audioSizeProblem(MAX_AUDIO_BYTES + 1), /too large/);
}));
tests.push(() => check('ensureAudioDataUri: splices the real mime in only when missing', () => {
  assert.equal(
    ensureAudioDataUri('data:;base64,QUJD', 'audio/webm'),
    'data:audio/webm;base64,QUJD',
  );
  assert.equal(
    ensureAudioDataUri('data:audio/mp4;base64,QUJD', 'audio/webm'),
    'data:audio/mp4;base64,QUJD',
  );
  assert.equal(
    ensureAudioDataUri('data:;base64,QUJD', ''),
    'data:;base64,QUJD',
  );
}));
tests.push(() => check('appendTranscriptToText + transcriptFromOutput round-trip the heard text', () => {
  assert.equal(appendTranscriptToText('context', ''), 'context');
  assert.equal(appendTranscriptToText('', 'words'), 'words');
  assert.equal(
    appendTranscriptToText('context', 'words'),
    `context\n\n${SPOKEN_NOTES_LABEL}\nwords`,
  );
  assert.equal(transcriptFromOutput({ transcript: 'heard' }), 'heard');
  assert.equal(transcriptFromOutput({ transcript: 42 }), '');
  assert.equal(transcriptFromOutput(null), '');
  assert.equal(transcriptFromOutput({}), '');
}));

// WAV encoder ---------------------------------------------------------------
tests.push(() => check('encodeWavDataUri: RIFF/WAVE header, 16-bit PCM payload, data:audio/wav URI', async () => {
  const samples = new Float32Array([0, 0.5, -0.5, 1, -1]);
  const uri = encodeWavDataUri(samples, 16000);
  assert.ok(uri.startsWith('data:audio/wav;base64,'));
  const bytes = Buffer.from(uri.slice('data:audio/wav;base64,'.length), 'base64');
  assert.equal(bytes.length, 44 + samples.length * 2);
  assert.equal(bytes.toString('ascii', 0, 4), 'RIFF');
  assert.equal(bytes.toString('ascii', 8, 12), 'WAVE');
  assert.equal(bytes.toString('ascii', 12, 16), 'fmt ');
  assert.equal(bytes.toString('ascii', 36, 40), 'data');
  assert.equal(bytes.readUInt16LE(20), 1); // PCM
  assert.equal(bytes.readUInt16LE(22), 1); // mono
  assert.equal(bytes.readUInt32LE(24), 16000);
  assert.equal(bytes.readUInt16LE(34), 16); // bits
  assert.equal(bytes.readInt16LE(44), 0);
  assert.equal(bytes.readInt16LE(46), Math.trunc(0.5 * 0x7fff));
  assert.equal(bytes.readInt16LE(48), -0x8000 / 2);
}));

for (const t of tests) await t();
console.log(`\n${passed}/${tests.length} voice tests passed`);

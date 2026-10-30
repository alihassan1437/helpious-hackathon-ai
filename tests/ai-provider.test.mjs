// Unit tests for the real Meta Model API provider (src/lib/ai/provider.ts).
// Run: node --import ./tests/register.mjs tests/ai-provider.test.mjs
// (the register hook resolves provider.ts's extensionless relative
// imports to .ts files; tsc + Next require the extensionless form).
// No key, no network: every Meta call goes through an injected stub
// fetch returning canned responses. Node's type stripping runs the
// .ts sources directly (erasable syntax only, no enums).
import assert from 'node:assert';
import {
  createMetaProvider,
  decodeBase85,
  parseSamLane,
  selectAiProvider,
  sniffImageMime,
} from '../src/lib/ai/provider.ts';
import { mockAiProvider, runAiFeature } from '../src/lib/ai/gateway.ts';
import { isValidSamMask } from '../src/lib/ai/mask.ts';

let passed = 0;
const tests = [];
const check = (name, fn) => {
  const out = fn();
  if (out && typeof out.then === 'function') return out.then(() => { passed++; console.log(`ok - ${name}`); });
  passed++;
  console.log(`ok - ${name}`);
};

// Stub fetch --------------------------------------------------------------
function stubFetch(handler) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, body: init && init.body ? JSON.parse(init.body) : null });
    return handler(url, init, calls);
  };
  fn.calls = calls;
  return fn;
}

const VALID_BRIEF = JSON.stringify({
  trade: 'plumber',
  issue: 'Kitchen tap dripping constantly.',
  scope: 'Replace tap washer.',
  urgency: 'Routine',
  accessNotes: '',
  questions: ['When did it start?'],
  missingPhotos: [],
});

function chatResponse(content) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    json: async () => ({ choices: [{ message: { content } }] }),
  };
}

function sseResponse(lane) {
  const event = lane === ''
    ? 'data: [DONE]\n'
    : `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: lane })}\n\ndata: [DONE]\n`;
  return {
    ok: true,
    status: 200,
    headers: { get: () => 'text/event-stream' },
    text: async () => event,
  };
}

// The 4x4 block lane: box 100,50 -> 300,250 on a 1000x500 frame,
// raster 4x4 with a 2x2 block at rows 1-2, cols 1-2 (b85 '24D').
const LANE_4X4 =
  '<1f>msg1<|box;x1=100;y1=50;x2=300;y2=250;confidence=0.9|><|mask;data=4,4,!24D|>';
const EXPECTED_BOX_MAPPED = [
  { x: 0.15, y: 0.2 },
  { x: 0.15, y: 0.4 },
  { x: 0.25, y: 0.4 },
  { x: 0.25, y: 0.2 },
];
const EXPECTED_RASTER_RELATIVE = [
  { x: 0.25, y: 0.25 },
  { x: 0.25, y: 0.75 },
  { x: 0.75, y: 0.75 },
  { x: 0.75, y: 0.25 },
];
const approxPoints = (actual, expected) => {
  assert.equal(actual.length, expected.length, JSON.stringify(actual));
  for (let i = 0; i < expected.length; i++) {
    assert.ok(Math.abs(actual[i].x - expected[i].x) < 1e-9, `${JSON.stringify(actual[i])} vs ${JSON.stringify(expected[i])}`);
    assert.ok(Math.abs(actual[i].y - expected[i].y) < 1e-9, `${JSON.stringify(actual[i])} vs ${JSON.stringify(expected[i])}`);
  }
};

// Base85 ------------------------------------------------------------------
tests.push(() => check('base85 decode matches Python b85 vectors', () => {
  assert.equal(Buffer.from(decodeBase85('Xk~0{Zy<MXa%^M')).toString(), 'hello world');
  assert.deepEqual(Array.from(decodeBase85('pa')), [0b10100000]);
}));

// Mime sniffing -----------------------------------------------------------
tests.push(() => check('WebP/JPEG/PNG sniffed from magic bytes, unknown returns null', () => {
  const webp = new Uint8Array([...Buffer.from('RIFF'), 0, 0, 0, 0, ...Buffer.from('WEBP'), 1, 2]);
  assert.equal(sniffImageMime(webp), 'image/webp');
  assert.equal(sniffImageMime(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg');
  assert.equal(sniffImageMime(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1])), 'image/png');
  assert.equal(sniffImageMime(new Uint8Array([1, 2, 3, 4])), null);
}));

// SAM lane parsing --------------------------------------------------------
tests.push(() => check('SAM zero-match: empty lane is valid, mask null', () => {
  for (const lane of ['', '   ']) {
    const parsed = parseSamLane(lane);
    assert.equal(parsed.status, 'zero-match');
    assert.equal(parsed.polygons, null);
  }
}));
tests.push(() => check('SAM lane parses box + mask and maps through box into frame coords', () => {
  const parsed = parseSamLane(LANE_4X4, 1000, 500);
  assert.equal(parsed.status, 'ok');
  assert.deepEqual(parsed.box, { x1: 100, y1: 50, x2: 300, y2: 250 });
  assert.equal(parsed.confidence, 0.9);
  assert.ok(parsed.polygons);
  approxPoints(parsed.polygons[0], EXPECTED_BOX_MAPPED);
  assert.ok(isValidSamMask({ polygons: parsed.polygons }), 'mask must pass mask.ts validation');
}));
tests.push(() => check('SAM lane without box/frame falls back to raster-relative coords', () => {
  const lane = '<1f>msg1<|mask;data=4,4,!24D|>';
  const parsed = parseSamLane(lane);
  assert.equal(parsed.status, 'ok');
  approxPoints(parsed.polygons[0], EXPECTED_RASTER_RELATIVE);
}));
tests.push(() => check('SAM unsupported encoding (~ lossless) yields no mask, never an error', () => {
  const parsed = parseSamLane('<1f>msg1<|mask;data=4,4,~24D|>');
  assert.equal(parsed.status, 'unsupported-encoding');
  assert.equal(parsed.polygons, null);
}));
tests.push(() => check('SAM lane with no mask segment yields no-mask, never an error', () => {
  const parsed = parseSamLane('<1f>msg1<|box;x1=1;y1=2;x2=3;y2=4|>');
  assert.equal(parsed.status, 'no-mask');
  assert.equal(parsed.polygons, null);
}));

// Provider selection / key handling ---------------------------------------
tests.push(() => check('missing key selects the mock; empty key factory throws', () => {
  assert.equal(selectAiProvider(undefined), mockAiProvider);
  assert.equal(selectAiProvider(''), mockAiProvider);
  assert.throws(() => createMetaProvider(''), /MODEL_API_KEY is not set/);
  assert.equal(typeof selectAiProvider('test-key').call, 'function');
}));
tests.push(() => check('Contributor model id never reaches the network', async () => {
  const fetchStub = stubFetch(async () => { throw new Error('network must not be called'); });
  const provider = createMetaProvider('test-key', fetchStub);
  await assert.rejects(
    provider.call({ feature: 'photo-brief', model: 'muse-spark-1.3-contributor', input: { text: 'tap' }, promptVersion: 'photo-brief-v1', repair: false }),
    /allow-list/,
  );
  assert.equal(fetchStub.calls.length, 0);
}));

// Chat JSON + repair ------------------------------------------------------
tests.push(() => check('JSON parse + repair path: garbage first, valid brief second, succeeds', async () => {
  const fetchStub = stubFetch(async (url, init, calls) =>
    chatResponse(calls.length === 1 ? 'not json at all' : VALID_BRIEF));
  const provider = createMetaProvider('test-key', fetchStub);
  const r = await runAiFeature({ feature: 'photo-brief', input: { text: 'dripping tap' }, provider });
  assert.equal(r.fallback, null);
  assert.equal(r.output.trade, 'plumber');
  assert.equal(r.repairAttempted, true);
  assert.equal(fetchStub.calls.length, 2);
  const repairSystem = fetchStub.calls[1].body.messages[0].content;
  assert.ok(repairSystem.includes('did not match'), repairSystem);
}));
tests.push(() => check('always-invalid JSON falls back (never throws to the caller)', async () => {
  const fetchStub = stubFetch(async () => chatResponse('still not json'));
  const provider = createMetaProvider('test-key', fetchStub);
  const r = await runAiFeature({ feature: 'photo-brief', input: { text: 'tap' }, provider });
  assert.equal(r.output, null);
  assert.equal(r.fallback.fallback, true);
}));
tests.push(() => check('non-200 Meta response falls back', async () => {
  const fetchStub = stubFetch(async () => ({ ok: false, status: 500 }));
  const provider = createMetaProvider('test-key', fetchStub);
  const r = await runAiFeature({ feature: 'photo-brief', input: { text: 'tap' }, provider });
  assert.equal(r.fallback.fallback, true);
}));
tests.push(() => check('timeout: a hung provider falls back within budget', async () => {
  const fetchStub = stubFetch(() => new Promise(() => {}));
  const provider = createMetaProvider('test-key', fetchStub);
  const start = Date.now();
  const r = await runAiFeature({ feature: 'photo-brief', input: { text: 'tap' }, provider, timeoutMs: 50 });
  assert.equal(r.fallback.fallback, true);
  assert.ok(Date.now() - start < 5000, `took ${Date.now() - start}ms`);
}));

// Vision + SAM integration ------------------------------------------------
tests.push(() => check('photo-brief with photo + samPrompt returns brief + mapped mask', async () => {
  const fetchStub = stubFetch(async (url) => {
    if (url.includes('/responses')) return sseResponse(LANE_4X4);
    return chatResponse(VALID_BRIEF);
  });
  const provider = createMetaProvider('test-key', fetchStub);
  const r = await runAiFeature({
    feature: 'photo-brief',
    input: {
      text: 'dripping tap',
      imageDataUri: 'data:image/jpeg;base64,xxxx',
      samPrompt: 'tap',
      frameWidth: 1000,
      frameHeight: 500,
    },
    provider,
  });
  assert.equal(r.fallback, null);
  assert.equal(r.output.trade, 'plumber');
  assert.equal(r.output.samStatus, 'ok');
  assert.equal(r.output.maskConfidence, 0.9);
  approxPoints(r.output.mask.polygons[0], EXPECTED_BOX_MAPPED);
  const visionBody = fetchStub.calls.find((c) => c.url.includes('/chat/completions')).body;
  assert.ok(Array.isArray(visionBody.messages[1].content), 'vision call sends content parts');
  assert.ok(visionBody.messages[1].content.some((p) => p.type === 'image_url'), 'vision call includes image_url');
}));
tests.push(() => check('photo-brief with zero-match SAM still returns a valid brief', async () => {
  const fetchStub = stubFetch(async (url) => {
    if (url.includes('/responses')) return sseResponse('');
    return chatResponse(VALID_BRIEF);
  });
  const provider = createMetaProvider('test-key', fetchStub);
  const r = await runAiFeature({
    feature: 'photo-brief',
    input: { text: 'tap', imageDataUri: 'data:image/jpeg;base64,xxxx', samPrompt: 'tap' },
    provider,
  });
  assert.equal(r.fallback, null);
  assert.equal(r.output.samStatus, 'zero-match');
  assert.equal(r.output.mask, null);
}));

// Image -------------------------------------------------------------------
tests.push(() => check('image-preview returns WebP mime explicitly, never assumed JPEG', async () => {
  const fakeWebp = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x10, 0, 0, 0]), Buffer.from('WEBP'), Buffer.from('xxxx')]);
  const fetchStub = stubFetch(async () => ({
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    json: async () => ({ data: [{ b64_json: fakeWebp.toString('base64') }] }),
  }));
  const provider = createMetaProvider('test-key', fetchStub);
  const r = await runAiFeature({ feature: 'image-preview', input: { text: 'tidy repaired sink' }, provider });
  assert.equal(r.fallback, null);
  assert.equal(r.output.watermark, 'Illustration only');
  assert.equal(r.output.imageMime, 'image/webp');
  assert.ok(r.output.imageDataUri.startsWith('data:image/webp;base64,'));
  assert.equal(r.output.imageBytes, fakeWebp.length);
  const imageBody = fetchStub.calls[0].body;
  assert.equal(imageBody.model, 'muse-image-1.0');
}));

for (const t of tests) await t();
console.log(`\n${passed}/${tests.length} provider tests passed`);

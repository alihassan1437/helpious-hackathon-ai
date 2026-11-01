// Unit tests for the D1 /api/ai gateway pure core (src/lib/ai/gateway.ts).
// Run: node tests/ai-gateway.test.mjs
// No dependencies, no network, no Firebase, no model key — the module
// under test imports node:crypto only. Node's type stripping runs the
// .ts source directly (erasable syntax only, no enums).
import assert from 'node:assert';
import {
  aiCacheKey,
  aiFallback,
  dailyCapFor,
  DEFAULT_FEATURE_FLAGS,
  detectSafety,
  FEATURE_DAILY_CAPS,
  FEATURE_PROMPT_VERSION,
  FEATURE_ROLES,
  isAiFeature,
  isOverDailyCap,
  isStandardModel,
  mockAiProvider,
  normalizeTradeLabel,
  runAiFeature,
  TRADE_CATEGORIES,
  userDailyCalls,
  SAFETY_CARD,
  stripPii,
  stripPiiDeep,
} from '../src/lib/ai/gateway.ts';

let passed = 0;
const check = (name, fn) => {
  const out = fn();
  if (out && typeof out.then === 'function') return out.then(() => { passed++; console.log(`ok - ${name}`); });
  passed++;
  console.log(`ok - ${name}`);
};
const tests = [];

// PII strip ---------------------------------------------------------------
tests.push(() => check('stripPii removes email, AU mobile, landline, street address, digit chains; keeps suburb', () => {
  const { cleaned, removed } = stripPii(
    'Hi, call me on 0412 345 678 or +61 2 8985 1234, email ali@example.com, I live at 12 Smith Street, Darwin, account 123456789.',
  );
  assert.equal(removed, true);
  assert.ok(!cleaned.includes('0412'), cleaned);
  assert.ok(!cleaned.includes('ali@example.com'), cleaned);
  assert.ok(!cleaned.includes('12 Smith Street'), cleaned);
  assert.ok(!cleaned.includes('123456789'), cleaned);
  assert.ok(cleaned.includes('Darwin'), cleaned);
}));
tests.push(() => check('stripPii leaves clean text untouched', () => {
  const { cleaned, removed } = stripPii('Leaking tap in the kitchen, Darwin.');
  assert.equal(removed, false);
  assert.equal(cleaned, 'Leaking tap in the kitchen, Darwin.');
}));
tests.push(() => check('stripPiiDeep strips nested strings and arrays', () => {
  const out = stripPiiDeep({ text: 'ring 0400 000 000', tags: ['ok', 'a@b.com'] });
  assert.equal(out.text, 'ring [phone removed]');
  assert.equal(out.tags[1], '[email removed]');
}));
tests.push(() => check('stripPii removes dot-separated and mixed-separator mobiles (G2 audit, 2026-11-01)', () => {
  for (const bait of [
    'call 0412.345.678',
    'call me on 0412 345-678 today',
    'text 0412.345-678 or 0412-345.678',
    'ring +61.412.345.678',
    'ring +61 412 345 678',
    'my number is 0412345678',
    'landline 08.8947.3255 after hours',
  ]) {
    const { cleaned, removed } = stripPii(bait);
    assert.equal(removed, true, bait);
    assert.ok(!/\d{3,}/.test(cleaned), `${bait} -> ${cleaned}`);
    assert.ok(!cleaned.includes('0412'), `${bait} -> ${cleaned}`);
  }
}));
tests.push(() => check('stripPii removes addresses with the widened suffix list + suffix-less form (G2 audit)', () => {
  for (const [bait, fragment] of [
    ['I live at 3/45 Charles Darwin Boulevard, Darwin', 'Charles Darwin Boulevard'],
    ['office at 12 The Esplanade', 'Esplanade'],
    ['unit at 8 Smith Terrace', 'Smith Terrace'],
    ['house at 21 Banksia Crescent', 'Banksia Crescent'],
    ['shop at 4 Coral Way', 'Coral Way'],
    ['shed at 9 Jarrah Close', 'Jarrah Close'],
    ['depot at 15 Industry Circuit', 'Industry Circuit'],
    ['flat at 2 Palm Grove', 'Palm Grove'],
    ['meet at 7 Harbour Esplanade', 'Harbour Esplanade'],
  ]) {
    const { cleaned, removed } = stripPii(bait);
    assert.equal(removed, true, bait);
    assert.ok(!cleaned.includes(fragment), `${bait} -> ${cleaned}`);
    assert.ok(cleaned.includes('[address removed]'), `${bait} -> ${cleaned}`);
  }
  // Suffix-less: street fragment goes, the suburb after the comma stays.
  const noSuffix = stripPii('tap leaking at 12 Smith, Darwin — urgent');
  assert.ok(!noSuffix.cleaned.includes('12 Smith'), noSuffix.cleaned);
  assert.ok(noSuffix.cleaned.includes('Darwin'), noSuffix.cleaned);
}));
tests.push(() => check('stripPii removes a spelled-out email but not dot-com prose (G2 audit)', () => {
  const { cleaned, removed } = stripPii('reach me at john at gmail dot com please');
  assert.equal(removed, true);
  assert.ok(!cleaned.includes('gmail'), cleaned);
  assert.ok(cleaned.includes('[email removed]'), cleaned);
  const prose = stripPii('look at the dot com bubble chart');
  assert.equal(prose.removed, false);
  assert.equal(prose.cleaned, 'look at the dot com bubble chart');
}));
tests.push(() => check('stripPii keeps the suburb in "I am in <Suburb>" (G2 over-strip fix)', () => {
  for (const sentence of [
    'I am in Casuarina, tap leaking',
    "I'm in Nightcliff and the tap leaks",
    'I am in Casuarina',
    'My place is in Parap, near the shops',
  ]) {
    const { cleaned, removed } = stripPii(sentence);
    assert.equal(removed, false, sentence);
    assert.equal(cleaned, sentence);
  }
  // Real name intros are still stripped (the fix must not reopen them).
  assert.ok(!stripPii('I am Dave, my tap leaks').cleaned.includes('Dave'));
  assert.ok(!stripPii("I'm Sarah and the hot water is out").cleaned.includes('Sarah'));
  assert.ok(!stripPii('my name is John Smith, call me').cleaned.includes('John Smith'));
}));

// Cache key ---------------------------------------------------------------
tests.push(() => check('cache key is 64-hex, stable, and changes with promptVersion or input', () => {
  const a = aiCacheKey('photo-brief', 'muse-spark-1.3', { text: 'tap' }, 'photo-brief-v1');
  const b = aiCacheKey('photo-brief', 'muse-spark-1.3', { text: 'tap' }, 'photo-brief-v1');
  const c = aiCacheKey('photo-brief', 'muse-spark-1.3', { text: 'tap' }, 'photo-brief-v2');
  const d = aiCacheKey('photo-brief', 'muse-spark-1.3', { text: 'sink' }, 'photo-brief-v1');
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.notEqual(a, d);
}));

// Model allow-list --------------------------------------------------------
tests.push(() => check('Standard allow-list accepts Spark 1.3, rejects Contributor and unknown IDs', () => {
  assert.equal(isStandardModel('muse-spark-1.3'), true);
  assert.equal(isStandardModel('muse-spark-1.3-contributor'), false);
  assert.equal(isStandardModel('muse-wonder-1.0'), false); // Not a D1 feature model; add only with its own scope decision.
  assert.equal(isStandardModel('gpt-4'), false);
  assert.equal(isStandardModel(undefined), false);
}));

// Features, caps, roles, flags --------------------------------------------
tests.push(() => check('feature allow-list, caps, roles, and default-OFF flags', () => {
  assert.equal(isAiFeature('photo-brief'), true);
  assert.equal(isAiFeature('plain-search'), false); // C2 is AFTER-hackathon scope, not D1.
  assert.equal(dailyCapFor('photo-brief', 'customer'), 5);
  assert.equal(dailyCapFor('quote-draft', 'business'), 30);
  assert.equal(dailyCapFor('paste-to-profile', 'admin'), 50);
  assert.equal(dailyCapFor('safety-check', 'customer'), null);
  assert.ok(!FEATURE_ROLES['quote-draft'].includes('customer'));
  assert.ok(Object.values(DEFAULT_FEATURE_FLAGS).every((v) => v === false));
  assert.equal(FEATURE_DAILY_CAPS['image-preview'].customer, undefined); // Per-job cap, not daily.
}));

// Safety ------------------------------------------------------------------
tests.push(() => check('safety detection fires on danger signs and the card never blocks posting', () => {
  assert.equal(detectSafety('I can smell gas near the cooktop'), true);
  assert.equal(detectSafety('sparking power point'), true);
  assert.equal(detectSafety('dripping tap'), false);
  // Dayplan S-case phrasings that missed before the 2026-11-01 widening
  // (full matrix, both copies, lives in tests/ai-d2.test.mjs):
  assert.equal(detectSafety('Burst flexi hose, laundry floor flooding near a power point'), true);
  assert.equal(detectSafety('Large branch hanging over a roof near powerlines'), true);
  assert.equal(detectSafety('Palm fronds touching overhead wires'), true);
  assert.equal(detectSafety('I need a power point presentation for the office'), false);
  assert.equal(SAFETY_CARD.blocksPosting, false);
  const fb = aiFallback('photo-brief', 'x', true);
  assert.equal(fb.fallback, true);
  assert.ok(fb.safetyCard);
}));

// Mock runs ---------------------------------------------------------------
tests.push(() => check('mock photo-brief returns a valid brief shape', async () => {
  const r = await runAiFeature({ feature: 'photo-brief', input: { text: 'dripping tap' } });
  assert.equal(r.fallback, null);
  assert.equal(r.output.trade, 'To confirm in the form (mock)');
  assert.ok(r.output.issue.includes('dripping tap'));
  assert.equal(r.cacheKey.length, 64);
}));
tests.push(() => check('mock quote-draft NEVER invents prices (all null, flagged missing)', async () => {
  const r = await runAiFeature({ feature: 'quote-draft', input: { brief: 'fix tap' } });
  assert.equal(r.fallback, null);
  for (const item of r.output.lineItems) {
    assert.equal(item.price, null);
    assert.equal(item.priceMissing, true);
  }
  assert.equal(r.output.total, null);
}));
tests.push(() => check('mock paste-to-profile performs NO extraction (no invented fields)', async () => {
  const r = await runAiFeature({ feature: 'paste-to-profile', input: { text: 'Best plumbers No.1 Darwin licensed' } });
  assert.equal(r.fallback, null);
  assert.deepEqual(r.output.extracted, {});
  assert.equal(r.output.mock, true);
}));
tests.push(() => check('safety-check never calls the provider (rule-based)', async () => {
  const throwing = { call: async () => { throw new Error('must not be called'); } };
  const r = await runAiFeature({ feature: 'safety-check', input: { text: 'gas smell' }, provider: throwing });
  assert.equal(r.fallback, null);
  assert.ok(r.output.safetyCard);
  assert.equal(r.safetyCardShown, true);
}));
tests.push(() => check('voice-brief mock reads a transcript, not audio', async () => {
  const r = await runAiFeature({ feature: 'voice-brief', input: { transcript: 'my tap drips all night' } });
  assert.equal(r.fallback, null);
  assert.ok(r.output.issue.includes('my tap drips all night'));
}));
tests.push(() => check('one repair retry: invalid shape first, valid second, succeeds', async () => {
  let calls = 0;
  const flaky = {
    call: async () => {
      calls++;
      return calls === 1 ? { nonsense: true } : mockAiProvider.call({ feature: 'photo-brief', model: 'muse-spark-1.3', input: { text: 'tap' }, promptVersion: 'photo-brief-v1', repair: true });
    },
  };
  const r = await runAiFeature({ feature: 'photo-brief', input: { text: 'tap' }, provider: flaky });
  assert.equal(r.fallback, null);
  assert.equal(r.repairAttempted, true);
  assert.equal(calls, 2);
}));
tests.push(() => check('always-failing provider falls back (never throws to the caller)', async () => {
  const failing = { call: async () => { throw new Error('down'); } };
  const r = await runAiFeature({ feature: 'photo-brief', input: { text: 'tap' }, provider: failing });
  assert.equal(r.output, null);
  assert.equal(r.fallback.fallback, true);
  assert.equal(r.repairAttempted, true);
}));
tests.push(() => check('empty input after stripping falls back without a model call', async () => {
  let calls = 0;
  const counting = { call: async () => { calls++; return {}; } };
  const r = await runAiFeature({ feature: 'photo-brief', input: '', provider: counting });
  assert.equal(r.fallback.fallback, true);
  assert.equal(calls, 0);
}));
tests.push(() => check('G1 gate: an imageDataUri input falls back and the provider is NEVER called', async () => {
  let calls = 0;
  const counting = {
    call: async () => {
      calls++;
      return mockAiProvider.call({ feature: 'photo-brief', model: 'muse-spark-1.3', input: { text: 'tap' }, promptVersion: 'photo-brief-v1', repair: false });
    },
  };
  const withPhoto = await runAiFeature({
    feature: 'photo-brief',
    input: { text: 'leaking tap', imageDataUri: 'data:image/jpeg;base64,xxxx', samPrompt: 'tap' },
    provider: counting,
  });
  assert.equal(calls, 0);
  assert.equal(withPhoto.output, null);
  assert.equal(withPhoto.fallback.fallback, true);
  assert.equal(withPhoto.repairAttempted, false);
  // The same call WITHOUT the photo reaches the provider normally.
  const textOnly = await runAiFeature({
    feature: 'photo-brief',
    input: { text: 'leaking tap', samPrompt: 'tap' },
    provider: counting,
  });
  assert.equal(calls, 1);
  assert.equal(textOnly.fallback, null);
  assert.ok(textOnly.output);
}));
tests.push(() => check('G1 gate: image block holds for other features, danger text still surfaces the safety card', async () => {
  let calls = 0;
  const counting = { call: async () => { calls++; return {}; } };
  const r = await runAiFeature({
    feature: 'quote-draft',
    input: { text: 'sparking power point, quote it', imageDataUri: 'data:image/png;base64,xxxx' },
    provider: counting,
  });
  assert.equal(calls, 0);
  assert.equal(r.fallback.fallback, true);
  assert.equal(r.safetyCardShown, true);
  assert.ok(r.fallback.safetyCard);
}));
tests.push(() => check('G1 gate: image-preview (generation OUTPUT) and voice audio are NOT blocked', async () => {
  const preview = await runAiFeature({ feature: 'image-preview', input: { text: 'a renovated kitchen' } });
  assert.equal(preview.fallback, null);
  assert.equal(preview.output.watermark, 'Illustration only');
  const voice = await runAiFeature({
    feature: 'voice-brief',
    input: { text: '', audioDataUri: 'data:audio/wav;base64,xxxx' },
  });
  assert.equal(voice.fallback, null);
  assert.ok(voice.output);
}));
tests.push(() => check('timeout: a hung provider falls back within budget', async () => {
  const hung = { call: () => new Promise(() => {}) };
  const start = Date.now();
  const r = await runAiFeature({ feature: 'photo-brief', input: { text: 'tap' }, provider: hung, timeoutMs: 50 });
  assert.equal(r.fallback.fallback, true);
  assert.ok(Date.now() - start < 5000, `took ${Date.now() - start}ms`);
}));
tests.push(() => check('timeout budgets: paste-to-profile 60s, voice features 45s, everything else the 15s default', async () => {
  const { timeoutForFeature, AI_TIMEOUT_MS, FEATURE_TIMEOUT_MS } = await import('../src/lib/ai/gateway.ts');
  assert.equal(timeoutForFeature('paste-to-profile'), 60_000);
  assert.equal(timeoutForFeature('voice-brief'), 45_000);
  assert.equal(timeoutForFeature('voice-quote'), 45_000);
  assert.equal(timeoutForFeature('photo-brief'), AI_TIMEOUT_MS);
  assert.equal(timeoutForFeature('quote-draft'), AI_TIMEOUT_MS);
  assert.deepEqual(Object.keys(FEATURE_TIMEOUT_MS).sort(), ['paste-to-profile', 'voice-brief', 'voice-quote']);
}));

// Trade vocabulary (D6 eval fix, 2026-11-01) ------------------------------
tests.push(() => check('normalizeTradeLabel: every wrong label the eval actually returned maps to its case category', () => {
  // [label the model returned, canonical category, eval case IDs] —
  // transcribed from the 2026-11-01 live eval (results.jsonl joined
  // to cases.json expectedTrade; X9 from REPORT.md — its adversarial
  // record carries no expectedTrade field). For the Gardening cases
  // the dayplan's expected string is the short form "Gardening"; the
  // eval rubric accepts the full category name "Gardening & Lawn
  // Care" (REPORT.md records that rubric choice), which is what
  // normalisation returns.
  const EVAL_FAIL_LABELS = [
    ['Plumber', 'Plumbing', 'P1,P2,P3,P4,P7,P8,P9,X9'],
    ['Gasfitter', 'Plumbing', 'P5,P10'],
    ['Electrician', 'Electrical', 'E1,E2,E3,E4,E5,E6,E8,E9,E10'],
    ['Painter', 'Painting', 'PA1,PA2,PA4,PA5,PA6,PA7,PA8,PA9,PA10'],
    ['Roof Painting', 'Painting', 'PA3'],
    ['Bond Cleaning', 'Cleaning', 'CL1'],
    ['House Cleaning', 'Cleaning', 'CL2'],
    ['Carpet Cleaning', 'Cleaning', 'CL3'],
    ['Window Cleaning', 'Cleaning', 'CL4'],
    ['Commercial Cleaning', 'Cleaning', 'CL5'],
    ['Oven Cleaning', 'Cleaning', 'CL6'],
    ['Pressure Cleaning', 'Cleaning', 'CL7'],
    ['Gardener', 'Gardening & Lawn Care', 'G2,G6,G9'],
    ['Lawn Mowing', 'Gardening & Lawn Care', 'G1,G10'],
    ['Lawn Care', 'Gardening & Lawn Care', 'G8'],
    ['Irrigation', 'Gardening & Lawn Care', 'G5'],
    ['Mechanic', 'Car Mechanic', 'C1,C2,C5,C7,C8,C10'],
    ['Mechanic - Transmission', 'Car Mechanic', 'C6'],
    ['Auto Air Conditioning', 'Car Mechanic', 'C3'],
    ['Tyre Service', 'Car Mechanic', 'C4'],
    ['Tyres', 'Car Mechanic', 'C9'],
    ['Web Developer', 'Website Development', 'W2,W5,W6,W8'],
    ['Web Design', 'Website Development', 'W1,W3,W4'],
    ['Web Designer', 'Website Development', 'W10'],
    ['Web Development', 'Website Development', 'W7'],
    ['SEO Specialist', 'Website Development', 'W9'],
    ['Furniture Assembly', 'Handyman', 'H1'],
    ['Carpenter', 'Handyman', 'H2,H4'],
    ['Plasterer', 'Handyman', 'H3'],
    ['Window Repairs', 'Handyman', 'H6'],
    ['TV Mounting', 'Handyman', 'H8'],
  ];
  for (const [label, canonical] of EVAL_FAIL_LABELS) {
    assert.equal(normalizeTradeLabel(label), canonical, label);
  }
}));
tests.push(() => check('normalizeTradeLabel: canonical names pass through; case/space/dash variants canonicalise', () => {
  assert.equal(TRADE_CATEGORIES.length, 22);
  for (const c of TRADE_CATEGORIES) assert.equal(normalizeTradeLabel(c), c, c);
  assert.equal(normalizeTradeLabel('  plumber '), 'Plumbing');
  assert.equal(normalizeTradeLabel('PLUMBER'), 'Plumbing');
  assert.equal(normalizeTradeLabel('Mechanic – Transmission'), 'Car Mechanic'); // en dash
  assert.equal(normalizeTradeLabel('Gardening'), 'Gardening & Lawn Care'); // short form -> full name
  assert.equal(normalizeTradeLabel('bond  cleaning'), 'Cleaning'); // collapsed whitespace
}));
tests.push(() => check('normalizeTradeLabel: ambiguous / canonical / honesty labels are intentionally NOT mapped', () => {
  // Each entry is a label the eval actually returned, left unchanged
  // for the reason recorded in gateway.ts (normalizeTradeLabel docs):
  // Arborist (G3,G7 — Gardening vs Tree Removal ambiguity), Tiler
  // (H9 — dayplan Handyman, re-silicone is not tiling), Appliance
  // Repair + Fencing (canonical categories themselves), Rubbish
  // Removal (no canonical home), the X10 compound, and the X5-X7
  // honesty labels that PASS because no trade is forced.
  for (const label of ['Arborist', 'Tiler', 'Appliance Repair', 'Fencing', 'Rubbish Removal', 'Plumbing and Tiling', 'Unclear', 'Unknown', 'Unknown - Bathroom']) {
    assert.equal(normalizeTradeLabel(label), label, label);
  }
}));
tests.push(() => check('brief outputs are trade-normalised through runAiFeature (both brief features)', async () => {
  const briefWith = (trade) => ({
    async call() {
      return { trade, issue: 'Something is broken', scope: 'Fix it', urgency: 'Routine', accessNotes: '', questions: ['When did it start?'], missingPhotos: [] };
    },
  });
  const photo = await runAiFeature({ feature: 'photo-brief', input: { text: 'oven clean needed' }, provider: briefWith('Bond Cleaning') });
  assert.equal(photo.output.trade, 'Cleaning');
  const voice = await runAiFeature({ feature: 'voice-brief', input: { text: 'lights flicker' }, provider: briefWith('Electrician') });
  assert.equal(voice.output.trade, 'Electrical');
  const unclear = await runAiFeature({ feature: 'photo-brief', input: { text: 'a cat on a couch' }, provider: briefWith('Unclear') });
  assert.equal(unclear.output.trade, 'Unclear'); // honesty label survives untouched
  const quote = await runAiFeature({ feature: 'quote-draft', input: { text: 'draft please' }, provider: { async call() { return { lineItems: [], total: null, notes: '' }; } } });
  assert.equal(quote.fallback, null); // non-brief features are not touched by the normaliser
}));
tests.push(() => check('brief prompt versions are v2 (v1 cache entries can never serve the old vocabulary)', () => {
  assert.equal(FEATURE_PROMPT_VERSION['photo-brief'], 'photo-brief-v2');
  assert.equal(FEATURE_PROMPT_VERSION['voice-brief'], 'voice-brief-v2');
}));

// Per-user daily caps (eval finding F1, 2026-11-01) ------------------------
tests.push(() => check('F1: per-user caps — each user gets their own full cap regardless of the global total', () => {
  // The F1 bug in one object: a global counter of 10,000 with the
  // old logic would have blocked everyone at the cap of 5.
  const usage = { calls: 10_000, cacheHits: 3, failures: 0, byUser: { userA: 5, userB: 4 } };
  assert.equal(userDailyCalls(usage, 'userA'), 5);
  assert.equal(userDailyCalls(usage, 'userB'), 4);
  assert.equal(isOverDailyCap(usage, 'userA', 5), true);  // A used HER five
  assert.equal(isOverDailyCap(usage, 'userB', 5), false); // B still has one
  assert.equal(isOverDailyCap(usage, 'userC', 5), false); // a fresh user starts at zero
}));
tests.push(() => check('F1: one user over cap is over; legacy docs without byUser start at zero; cap null never blocks', () => {
  assert.equal(isOverDailyCap({ byUser: { userA: 6 } }, 'userA', 5), true);
  assert.equal(isOverDailyCap({ byUser: { userA: 30 } }, 'userA', 30), true); // quote-draft business cap, same rule
  assert.equal(isOverDailyCap({ calls: 999 }, 'userA', 5), false); // pre-fix doc shape: no byUser yet
  assert.equal(isOverDailyCap(undefined, 'userA', 5), false);
  assert.equal(isOverDailyCap(null, 'userA', 5), false);
  assert.equal(isOverDailyCap({ byUser: { userA: 99 } }, 'userA', null), false);
  assert.equal(userDailyCalls({ byUser: { userA: 'five' } }, 'userA'), 0); // defensive: non-numeric reads as 0
  assert.equal(userDailyCalls({ byUser: { userA: 4.9 } }, 'userA'), 4);
}));
tests.push(() => check('F1: cap VALUES are unchanged (per-user reading, same numbers)', () => {
  assert.deepEqual(FEATURE_DAILY_CAPS['photo-brief'], { customer: 5 });
  assert.equal(dailyCapFor('photo-brief', 'customer'), 5);
  assert.equal(dailyCapFor('quote-draft', 'business'), 30);
  assert.equal(dailyCapFor('voice-brief', 'customer'), 5);
}));

for (const t of tests) await t();
console.log(`\n${passed}/${tests.length} gateway tests passed`);

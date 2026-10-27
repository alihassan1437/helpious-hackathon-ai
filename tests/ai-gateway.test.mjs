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
  FEATURE_ROLES,
  isAiFeature,
  isStandardModel,
  mockAiProvider,
  runAiFeature,
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
tests.push(() => check('timeout: a hung provider falls back within budget', async () => {
  const hung = { call: () => new Promise(() => {}) };
  const start = Date.now();
  const r = await runAiFeature({ feature: 'photo-brief', input: { text: 'tap' }, provider: hung, timeoutMs: 50 });
  assert.equal(r.fallback.fallback, true);
  assert.ok(Date.now() - start < 5000, `took ${Date.now() - start}ms`);
}));

for (const t of tests) await t();
console.log(`\n${passed}/${tests.length} gateway tests passed`);

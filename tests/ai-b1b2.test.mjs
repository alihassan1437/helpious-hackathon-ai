// Unit tests for the B1/B2 business-side AI helpers
// (src/lib/ai/business-ai.ts) plus an integration pass through the
// real gateway core with the mock provider, proving the UI helpers
// accept exactly what the gateway returns.
// Run: node tests/ai-b1b2.test.mjs
// No dependencies, no network, no Firebase, no model key — both
// modules under test are dependency-free apart from node:crypto.
// Node's type stripping runs the .ts sources directly.
import assert from 'node:assert';
import {
  allowedPriceNumbers,
  applyQuoteDraft,
  composeLeadBriefText,
  composeQuoteDraftText,
  normalizeLeadBrief,
  priceEntriesFrom,
} from '../src/lib/ai/business-ai.ts';
import { mockAiProvider, runAiFeature } from '../src/lib/ai/gateway.ts';

let passed = 0;
const tests = [];
const check = (name, fn) => {
  const out = fn();
  if (out && typeof out.then === 'function') return out.then(() => { passed++; console.log(`ok - ${name}`); });
  passed++;
  console.log(`ok - ${name}`);
};

// B1 input composition ----------------------------------------------------
tests.push(() => check('composeLeadBriefText: description verbatim + category/suburb lines, blanks omitted', () => {
  const full = composeLeadBriefText({ description: '  Leaking tap in kitchen  ', category: 'Plumbing', suburb: 'Darwin' });
  assert.equal(full, 'Leaking tap in kitchen\nCategory: Plumbing\nSuburb: Darwin');
  const bare = composeLeadBriefText({ description: 'Fix my fence' });
  assert.equal(bare, 'Fix my fence');
}));

// B1 brief normalisation ---------------------------------------------------
tests.push(() => check('normalizeLeadBrief: full real shape passes through, not mock', () => {
  const out = normalizeLeadBrief({
    trade: 'Plumber', issue: 'Leaking kitchen tap', scope: 'Replace washer', urgency: 'Routine',
    accessNotes: 'Side gate', questions: ['Where is the stopcock?'], missingPhotos: ['Under-sink photo'],
  });
  assert.ok(out);
  assert.equal(out.brief.trade, 'Plumber');
  assert.equal(out.brief.questions.length, 1);
  assert.equal(out.isMock, false);
}));

tests.push(() => check('normalizeLeadBrief: unusable outputs return null', () => {
  assert.equal(normalizeLeadBrief(null), null);
  assert.equal(normalizeLeadBrief('text'), null);
  assert.equal(normalizeLeadBrief([]), null);
  assert.equal(normalizeLeadBrief({ questions: [] }), null); // no trade, no issue
}));

tests.push(() => check('normalizeLeadBrief: non-string list entries are dropped, strings coerced', () => {
  const out = normalizeLeadBrief({ trade: 42, issue: 'Burst pipe', questions: ['ok?', 7, ''], missingPhotos: 'nope' });
  assert.ok(out);
  assert.equal(out.brief.trade, '');
  assert.deepEqual(out.brief.questions, ['ok?']);
  assert.deepEqual(out.brief.missingPhotos, []);
}));

// Price list handling --------------------------------------------------------
tests.push(() => check('priceEntriesFrom: trims, drops blanks, rejects non-records', () => {
  const entries = priceEntriesFrom({ ' Tap repair ': ' From $120 ', '': '$50', 'Call-out': '  ', Broken: 99 });
  assert.deepEqual(entries, [{ service: 'Tap repair', price: 'From $120' }]);
  assert.deepEqual(priceEntriesFrom(null), []);
  assert.deepEqual(priceEntriesFrom([1, 2]), []);
  assert.deepEqual(priceEntriesFrom(undefined), []);
}));

tests.push(() => check('allowedPriceNumbers: extracts every number incl. ranges, decimals, thousands', () => {
  const nums = allowedPriceNumbers([
    { service: 'A', price: 'From $120' },
    { service: 'B', price: '$80 - $100' },
    { service: 'C', price: '$45.50/hr' },
    { service: 'D', price: '$1,200' },
    { service: 'E', price: 'POA' },
  ]);
  assert.deepEqual([...nums].sort((a, b) => a - b), [45.5, 80, 100, 120, 1200]);
}));

// B2 draft application — the own-prices-only guard ---------------------------
const LIST = priceEntriesFrom({ 'Tap repair': 'From $120', 'Call-out fee': '$80' });

tests.push(() => check('applyQuoteDraft: prices from the own list are kept verbatim', () => {
  const applied = applyQuoteDraft({
    lineItems: [
      { description: 'Tap repair', price: 120, priceMissing: false },
      { description: 'Call-out fee', price: 80, priceMissing: false },
    ],
    total: 200,
    notes: 'Draft from price list.',
  }, LIST);
  assert.equal(applied.items.length, 2);
  assert.deepEqual(applied.items[0], { description: 'Tap repair', qty: '1', unitPrice: '120', priceMissing: false });
  assert.equal(applied.removedPrices, 0);
  assert.equal(applied.missingPrices, 0);
  assert.equal(applied.notes, 'Draft from price list.');
}));

tests.push(() => check('applyQuoteDraft: an invented price is stripped to blank + counted, never kept', () => {
  const applied = applyQuoteDraft({
    lineItems: [
      { description: 'Tap repair', price: 120, priceMissing: false },
      { description: 'Mystery extra', price: 999, priceMissing: false },
    ],
    total: 1119,
    notes: '',
  }, LIST);
  assert.equal(applied.items.length, 2);
  assert.equal(applied.items[1].unitPrice, '');
  assert.equal(applied.items[1].priceMissing, true);
  assert.equal(applied.removedPrices, 1);
  assert.equal(applied.missingPrices, 1);
}));

tests.push(() => check('applyQuoteDraft: with NO price list every drafted price is stripped', () => {
  const applied = applyQuoteDraft({
    lineItems: [{ description: 'Anything', price: 50, priceMissing: false }],
    total: 50,
    notes: '',
  }, []);
  assert.equal(applied.items[0].unitPrice, '');
  assert.equal(applied.items[0].priceMissing, true);
  assert.equal(applied.removedPrices, 1);
}));

tests.push(() => check('applyQuoteDraft: null prices stay blank, empty descriptions dropped, junk tolerated', () => {
  const applied = applyQuoteDraft({
    lineItems: [
      { description: 'Labour', price: null, priceMissing: true },
      { description: '   ', price: 120, priceMissing: false },
      'garbage',
      { description: 'Parts', price: '120', priceMissing: false }, // string price = not a number -> blank
    ],
    total: null,
    notes: '',
  }, LIST);
  assert.equal(applied.items.length, 2);
  assert.equal(applied.items[0].priceMissing, true);
  assert.equal(applied.items[1].description, 'Parts');
  assert.equal(applied.items[1].priceMissing, true);
  assert.equal(applied.removedPrices, 0); // string price was never a price
  assert.deepEqual(applyQuoteDraft(null, LIST).items, []);
  assert.deepEqual(applyQuoteDraft(undefined, LIST).items, []);
}));

// B2 input composition ---------------------------------------------------------
tests.push(() => check('composeQuoteDraftText: job + brief + verbatim price list reach the model', () => {
  const text = composeQuoteDraftText({
    jobText: 'Leaking tap',
    category: 'Plumbing',
    suburb: 'Darwin',
    brief: { trade: 'Plumber', issue: 'Tap leaks', scope: 'Washer', urgency: 'Routine', accessNotes: '', questions: [], missingPhotos: [] },
    priceEntries: LIST,
  });
  assert.ok(text.includes('Leaking tap'));
  assert.ok(text.includes('Issue: Tap leaks'));
  assert.ok(text.includes('- Tap repair: From $120'));
  assert.ok(text.includes('ONLY prices you may use'));
}));

tests.push(() => check('composeQuoteDraftText: no price list instructs blank prices in the input itself', () => {
  const text = composeQuoteDraftText({ jobText: 'Fix fence', priceEntries: [] });
  assert.ok(text.includes('no price list on file'));
  assert.ok(text.includes('leave every price blank'));
}));

// Integration: gateway mock output -> UI helpers --------------------------------
tests.push(() => check('integration: mock photo-brief output normalises into a brief flagged mock', async () => {
  const result = await runAiFeature({
    feature: 'photo-brief',
    input: { text: composeLeadBriefText({ description: 'Blocked drain', category: 'Plumbing', suburb: 'Darwin' }) },
    provider: mockAiProvider,
  });
  assert.equal(result.fallback, null);
  const out = normalizeLeadBrief(result.output);
  assert.ok(out);
  assert.equal(out.isMock, true);
}));

tests.push(() => check('integration: mock quote-draft output applies with all prices blank, none removed', async () => {
  const result = await runAiFeature({
    feature: 'quote-draft',
    input: { text: composeQuoteDraftText({ jobText: 'Leaking tap', priceEntries: LIST }) },
    provider: mockAiProvider,
  });
  assert.equal(result.fallback, null);
  const applied = applyQuoteDraft(result.output, LIST);
  assert.ok(applied.items.length > 0);
  assert.equal(applied.isMock, true);
  assert.equal(applied.removedPrices, 0); // mock never invents a price
  assert.equal(applied.missingPrices, applied.items.length);
}));

await Promise.all(tests.map((t) => t()));
console.log(`\n${passed}/${tests.length} B1/B2 tests passed`);
if (passed !== tests.length) process.exit(1);

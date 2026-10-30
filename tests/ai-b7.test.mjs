// Unit tests for B7 paste-to-profile (hackathon): the v2 extraction
// contract across prompts.ts + provider.ts + profile-ai.ts, plus the
// My listing review-screen normaliser.
// Run: node --import ./tests/register.mjs tests/ai-b7.test.mjs
// (the register hook resolves provider.ts's extensionless imports;
// provider.ts also needs zod from node_modules.)
// No network, no Firebase, no real key: the real provider is driven
// through an injected stub fetch with canned replies, and every
// paste below is invented sample text — no real business data.
import assert from 'node:assert';
import {
  FEATURE_PROMPT_VERSION,
  runAiFeature,
  stripPiiDeep,
} from '../src/lib/ai/gateway.ts';
import { getPrompt } from '../src/lib/ai/prompts.ts';
import { createMetaProvider } from '../src/lib/ai/provider.ts';
import {
  formatPasteFieldValue,
  normalizePasteProfile,
  parsePasteFieldEdit,
  pasteFieldIsEmpty,
} from '../src/lib/ai/profile-ai.ts';

let passed = 0;
const tests = [];
const check = (name, fn) => {
  const out = fn();
  if (out && typeof out.then === 'function') return out.then(() => { passed++; console.log(`ok - ${name}`); });
  passed++;
  console.log(`ok - ${name}`);
};

// Invented sample paste. It deliberately includes a mobile, an
// email, and an ABN so the strip interaction is exercised end to end.
const SAMPLE_PASTE = [
  'Top End Tap Repairs — Darwin plumber for leaking taps, blocked drains and hot water repairs.',
  'Call Dave on 0412 345 678 or email quotes@topendtap.example.com.au. ABN 12 345 678 901.',
  'We service Casuarina, Nightcliff, Parap and Palmerston. Open Mon–Fri 7:00am to 5:00pm, Sat 8am to 12pm.',
  'Fix a leaking tap from $120. Blocked drain clearing from $180.',
  "We take cash, card and bank transfer. Fixing Darwin's taps for over 10 years. www.topendtap.example.com.au",
].join('\n');

// What a real model returns for the STRIPPED version of the paste:
// every field the text states, each with its verbatim snippet, no
// contact values anywhere, and the placeholder kinds it saw reported.
const CANNED_V2 = {
  extracted: {
    businessName: { value: 'Top End Tap Repairs', snippet: 'Top End Tap Repairs — Darwin plumber' },
    category: { value: 'Plumbing', snippet: 'Darwin plumber for leaking taps' },
    services: {
      value: ['Leaking tap repairs', 'Blocked drains', 'Hot water repairs'],
      snippet: 'leaking taps, blocked drains and hot water repairs',
    },
    serviceAreas: {
      value: ['Casuarina', 'Nightcliff', 'Parap', 'Palmerston'],
      snippet: 'We service Casuarina, Nightcliff, Parap and Palmerston',
    },
    openingHours: {
      value: {
        Monday: '07:00 — 17:00',
        Tuesday: '07:00 — 17:00',
        Wednesday: '07:00 — 17:00',
        Thursday: '07:00 — 17:00',
        Friday: '07:00 — 17:00',
        Saturday: '08:00 — 12:00',
      },
      snippet: 'Open Mon–Fri 7:00am to 5:00pm, Sat 8am to 12pm',
    },
    yearsInBusiness: { value: '10+ Years', snippet: "Fixing Darwin's taps for over 10 years" },
    paymentMethods: {
      value: ['Cash', 'Card', 'Bank transfer'],
      snippet: 'We take cash, card and bank transfer',
    },
    website: { value: 'www.topendtap.example.com.au', snippet: 'www.topendtap.example.com.au' },
    fromPrices: {
      value: { 'Fix a leaking tap': 'From $120', 'Blocked drain clearing': 'From $180' },
      snippet: 'Fix a leaking tap from $120',
    },
  },
  seo: {
    description: 'Top End Tap Repairs is a Darwin plumber for leaking taps, blocked drains and hot water repairs across Casuarina, Nightcliff, Parap and Palmerston.',
    tagline: "Darwin's leaking tap and blocked drain repairs",
    metaTitle: 'Top End Tap Repairs | Darwin Plumber',
    metaDescription: 'Darwin plumber for leaking taps, blocked drains and hot water repairs. Servicing Casuarina, Nightcliff, Parap and Palmerston.',
  },
  lowConfidence: [],
  removedContact: ['phone', 'email', 'ABN'],
};

// Prompt + version wiring ---------------------------------------------------
tests.push(() => check('paste-to-profile prompt is v2 in both prompts.ts and the gateway version table', () => {
  assert.equal(getPrompt('paste-to-profile').version, 'paste-to-profile-v2');
  assert.equal(FEATURE_PROMPT_VERSION['paste-to-profile'], 'paste-to-profile-v2');
  const system = getPrompt('paste-to-profile').system;
  assert.ok(system.includes('removedContact'), 'prompt must define removedContact');
  assert.ok(system.includes('[phone removed]'), 'prompt must explain the strip placeholders');
  assert.ok(/NEVER output the placeholder/.test(system), 'prompt must forbid placeholder output');
  assert.ok(/leave that field out entirely/.test(system), 'prompt must prefer omission over guessing');
}));

// Strip interaction ----------------------------------------------------------
tests.push(() => check('gateway strip removes phone/email/ABN from the sample paste; the website survives', () => {
  const stripped = stripPiiDeep({ text: SAMPLE_PASTE }).text;
  assert.ok(stripped.includes('[phone removed]'), stripped);
  assert.ok(stripped.includes('[email removed]'), stripped);
  assert.ok(stripped.includes('[number removed]'), stripped);
  assert.ok(!stripped.includes('0412 345 678'), 'raw mobile must never reach the model');
  assert.ok(!stripped.includes('quotes@topendtap.example.com.au'), 'raw email must never reach the model');
  assert.ok(!stripped.includes('12 345 678 901'), 'raw ABN must never reach the model');
  assert.ok(stripped.includes('www.topendtap.example.com.au'), 'a bare website is not PII-stripped');
}));

tests.push(() => check('no extracted row can carry the pasted phone, email, or ABN', () => {
  const out = normalizePasteProfile(CANNED_V2, SAMPLE_PASTE);
  const valuesJson = JSON.stringify(out.rows.map((r) => r.value));
  assert.ok(!valuesJson.includes('0412'), valuesJson);
  assert.ok(!valuesJson.includes('quotes@'), valuesJson);
  assert.ok(!valuesJson.includes('345 678 901'), valuesJson);
  assert.deepEqual(out.removedContact, ['phone', 'email', 'ABN']);
}));

// Normaliser -----------------------------------------------------------------
tests.push(() => check('normalizePasteProfile: full canned v2 output yields all 11 rows, snippets verified', () => {
  const out = normalizePasteProfile(CANNED_V2, SAMPLE_PASTE);
  assert.equal(out.isMock, false);
  assert.equal(out.hasExtraction, true);
  assert.equal(out.rows.length, 11);
  const services = out.rows.find((r) => r.key === 'services');
  assert.ok(services);
  assert.equal(services.snippetVerified, true);
  assert.equal(services.lowConfidence, false);
  assert.deepEqual(services.value, ['Leaking tap repairs', 'Blocked drains', 'Hot water repairs']);
  const hours = out.rows.find((r) => r.key === 'openingHours');
  assert.ok(hours && typeof hours.value === 'object' && !Array.isArray(hours.value));
  assert.equal((hours.value).Saturday, '08:00 — 12:00');
  const description = out.rows.find((r) => r.key === 'description');
  assert.ok(description && description.generated === true);
}));

tests.push(() => check('normalizePasteProfile: a snippet that is not in the paste forces low confidence', () => {
  const doctored = structuredClone(CANNED_V2);
  doctored.extracted.services = {
    value: ['Licence checks', 'Insurance claims'],
    snippet: 'Fully licensed and insured, No.1 in Darwin',
  };
  const out = normalizePasteProfile(doctored, SAMPLE_PASTE);
  const services = out.rows.find((r) => r.key === 'services');
  assert.ok(services);
  assert.equal(services.snippetVerified, false);
  assert.equal(services.lowConfidence, true);
}));

tests.push(() => check('normalizePasteProfile: model-flagged low confidence is honoured even with a verified snippet', () => {
  const flagged = structuredClone(CANNED_V2);
  flagged.lowConfidence = ['category'];
  const out = normalizePasteProfile(flagged, SAMPLE_PASTE);
  const category = out.rows.find((r) => r.key === 'category');
  assert.ok(category);
  assert.equal(category.snippetVerified, true);
  assert.equal(category.lowConfidence, true);
}));

tests.push(() => check('normalizePasteProfile: a placeholder leaking into a value drops the field, never reaches the form', () => {
  const leaked = structuredClone(CANNED_V2);
  leaked.extracted.website = { value: '[phone removed]', snippet: 'Call Dave on [phone removed]' };
  const out = normalizePasteProfile(leaked, SAMPLE_PASTE);
  assert.equal(out.rows.find((r) => r.key === 'website'), undefined);
  assert.deepEqual(out.droppedPlaceholderFields, ['Website']);
}));

tests.push(() => check('normalizePasteProfile: removedContact is filtered to the vocabulary, canonical order', () => {
  const noisy = structuredClone(CANNED_V2);
  noisy.removedContact = ['fax machine', 'EMAIL', 'phone'];
  const out = normalizePasteProfile(noisy, SAMPLE_PASTE);
  assert.deepEqual(out.removedContact, ['phone', 'email']);
}));

tests.push(() => check('normalizePasteProfile: mock output is reported as mock, never as an empty extraction', async () => {
  const r = await runAiFeature({ feature: 'paste-to-profile', input: { text: SAMPLE_PASTE } });
  assert.ok(r.output, 'the D1 mock still returns its no-extraction shape');
  const out = normalizePasteProfile(r.output, SAMPLE_PASTE);
  assert.equal(out.isMock, true);
  assert.equal(out.hasExtraction, false);
  assert.equal(out.rows.length, 0);
}));

tests.push(() => check('normalizePasteProfile: empty extraction and garbage are valid empty results', () => {
  const empty = normalizePasteProfile(
    { extracted: {}, seo: { description: '', tagline: '', metaTitle: '', metaDescription: '' }, lowConfidence: [], removedContact: [] },
    SAMPLE_PASTE,
  );
  assert.equal(empty.hasExtraction, false);
  assert.equal(empty.rows.length, 0);
  assert.equal(normalizePasteProfile(null, SAMPLE_PASTE).hasExtraction, false);
  assert.equal(normalizePasteProfile('text', SAMPLE_PASTE).rows.length, 0);
  assert.equal(normalizePasteProfile([], SAMPLE_PASTE).rows.length, 0);
}));

// Edit round-trips -------------------------------------------------------------
tests.push(() => check('format/parse round-trips: list dedupes, hours stay partial, prices keep phrases', () => {
  const listText = formatPasteFieldValue('list', ['Casuarina', 'Nightcliff']);
  assert.equal(listText, 'Casuarina, Nightcliff');
  assert.deepEqual(parsePasteFieldEdit('list', 'Casuarina, Nightcliff\nCasuarina, , Parap'), [
    'Casuarina',
    'Nightcliff',
    'Parap',
  ]);

  const hours = { Monday: '07:00 — 17:00', Saturday: '08:00 — 12:00' };
  const hoursText = formatPasteFieldValue('hours', hours);
  assert.equal(hoursText, 'Monday: 07:00 — 17:00\nSaturday: 08:00 — 12:00');
  assert.deepEqual(parsePasteFieldEdit('hours', hoursText), hours);
  assert.deepEqual(parsePasteFieldEdit('hours', 'Sat: Closed'), { Saturday: 'Closed' });

  const prices = { 'Fix a leaking tap': 'From $120' };
  assert.equal(formatPasteFieldValue('prices', prices), 'Fix a leaking tap: From $120');
  assert.deepEqual(parsePasteFieldEdit('prices', 'Fix a leaking tap: From $120'), prices);

  assert.equal(parsePasteFieldEdit('text', '  Darwin plumber  '), 'Darwin plumber');
}));

tests.push(() => check('pasteFieldIsEmpty: conservative for hours, exact for the rest', () => {
  assert.equal(pasteFieldIsEmpty('text', ''), true);
  assert.equal(pasteFieldIsEmpty('text', 'Top End Tap Repairs'), false);
  assert.equal(pasteFieldIsEmpty('list', []), true);
  assert.equal(pasteFieldIsEmpty('list', ['Cash']), false);
  assert.equal(pasteFieldIsEmpty('prices', {}), true);
  assert.equal(pasteFieldIsEmpty('prices', { 'Fix a leaking tap': 'From $120' }), false);
  // The editor always holds a full week (defaults for a new listing),
  // so extracted hours count as "already set" and start unticked.
  assert.equal(pasteFieldIsEmpty('hours', { Monday: '09:00 — 17:00', Sunday: 'Closed' }), false);
  assert.equal(pasteFieldIsEmpty('hours', {}), true);
}));

// Real provider path (stub fetch) ---------------------------------------------
function stubFetch(handler) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, body: init && init.body ? JSON.parse(init.body) : null });
    return handler(url, init, calls);
  };
  fn.calls = calls;
  return fn;
}

function chatResponse(content) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    json: async () => ({ choices: [{ message: { content } }] }),
  };
}

tests.push(() => check('real provider: a v2-shaped reply passes zod + gateway validation end to end', async () => {
  const fetchStub = stubFetch(async () => chatResponse(JSON.stringify(CANNED_V2)));
  const provider = createMetaProvider('test-key', fetchStub);
  const r = await runAiFeature({ feature: 'paste-to-profile', input: { text: SAMPLE_PASTE }, provider });
  assert.equal(r.fallback, null);
  assert.ok(r.output);
  const extracted = r.output.extracted;
  assert.equal(extracted.businessName?.value, 'Top End Tap Repairs');
  // The model only ever received the stripped paste.
  const sent = JSON.stringify(fetchStub.calls[0]?.body ?? {});
  assert.ok(!sent.includes('0412 345 678'), 'the provider call must carry stripped text only');
  assert.ok(sent.includes('[phone removed]'), 'the provider call carries the placeholder, not the number');
  const out = normalizePasteProfile(r.output, SAMPLE_PASTE);
  assert.equal(out.hasExtraction, true);
}));

tests.push(() => check('real provider: a v1-shaped reply fails the v2 schema and falls back after repair', async () => {
  const v1Shaped = JSON.stringify({
    extracted: { businessName: 'Top End Tap Repairs' },
    seo: { description: 'x', tagline: 'y', metaTitle: 'z', metaDescription: 'w' },
    lowConfidence: [],
    sourceSnippets: ['Top End Tap Repairs'],
  });
  const fetchStub = stubFetch(async () => chatResponse(v1Shaped));
  const provider = createMetaProvider('test-key', fetchStub);
  const r = await runAiFeature({ feature: 'paste-to-profile', input: { text: SAMPLE_PASTE }, provider });
  assert.equal(r.output, null);
  assert.ok(r.fallback, 'loose shapes must fall back, never reach the review screen');
  assert.equal(r.repairAttempted, true);
}));

await Promise.all(tests.map((t) => t()));
console.log(`\n${passed}/${tests.length} B7 tests passed`);

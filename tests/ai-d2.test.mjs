// Unit tests for D2 C1/C3 pure modules (mask shape + safety patterns).
// Run: node tests/ai-d2.test.mjs
// No dependencies, no network, no Firebase, no model key.
import assert from 'node:assert';
import {
  isValidSamMask,
  samPolygonPoints,
  MOCK_SAM_MASK,
  MAX_SAM_POLYGONS,
} from '../src/lib/ai/mask.ts';
import { detectSafety, SAFETY_CARD } from '../src/lib/ai/safety-patterns.ts';
import {
  detectSafety as gatewayDetectSafety,
  SAFETY_CARD as gatewayCard,
} from '../src/lib/ai/gateway.ts';

let passed = 0;
const check = (name, fn) => {
  fn();
  passed++;
  console.log(`ok - ${name}`);
};

// Mask validation ---------------------------------------------------------
check('mock mask is valid', () => {
  assert.equal(isValidSamMask(MOCK_SAM_MASK), true);
  assert.equal(MOCK_SAM_MASK.mock, true);
});

check('mask validation rejects bad shapes', () => {
  assert.equal(isValidSamMask(null), false);
  assert.equal(isValidSamMask({ polygons: [] }), false);
  assert.equal(isValidSamMask({ polygons: [[{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.2 }]] }), false);
  assert.equal(isValidSamMask({ polygons: [[{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1.5, y: 1 }]] }), false);
  assert.equal(isValidSamMask({ polygons: [[{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: NaN, y: 1 }]] }), false);
  const tooMany = Array.from({ length: MAX_SAM_POLYGONS + 1 }, () => [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 0, y: 1 },
  ]);
  assert.equal(isValidSamMask({ polygons: tooMany }), false);
});

check('polygon points format is 0..100 pairs', () => {
  assert.equal(
    samPolygonPoints([
      { x: 0.3, y: 0.35 },
      { x: 0.7, y: 0.65 },
    ]),
    '30,35 70,65',
  );
});

// Safety patterns -----------------------------------------------------------
check('danger words detected, ordinary text not', () => {
  assert.equal(detectSafety('I smell gas near the stove'), true);
  assert.equal(detectSafety('sparking outlet in the kitchen'), true);
  assert.equal(detectSafety('structural crack in the wall'), true);
  assert.equal(detectSafety('water near the switchboard after the leak'), true);
  assert.equal(detectSafety('I need three rooms painted'), false);
  assert.equal(detectSafety(''), false);
});

check('safety card carries verified NT numbers, nothing invented', () => {
  assert.ok(SAFETY_CARD.title.includes('000'), SAFETY_CARD.title);
  assert.ok(SAFETY_CARD.utilityNumbers.includes('1800 245 090'), SAFETY_CARD.utilityNumbers);
  assert.ok(!SAFETY_CARD.utilityNumbers.includes('TO BE FILLED'), SAFETY_CARD.utilityNumbers);
  assert.equal(SAFETY_CARD.blocksPosting, false);
});

check('gateway and browser safety copies agree', () => {
  assert.equal(JSON.stringify(SAFETY_CARD), JSON.stringify(gatewayCard));
  const corpus = [
    'I smell gas near the stove',
    'sparking outlet in the kitchen',
    'structural crack in the wall',
    'water near the switchboard after the leak',
    'flooding near the power point',
    'I need three rooms painted',
    'branch on powerlines over the driveway',
    '',
  ];
  for (const text of corpus) {
    assert.equal(detectSafety(text), gatewayDetectSafety(text), text);
  }
});

console.log(`\n${passed}/6 D2 tests passed`);

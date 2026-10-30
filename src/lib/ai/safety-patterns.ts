// C3 safety patterns + fixed safety card — CLIENT-SAFE (no node: imports).
//
// This is the browser copy of the danger-word patterns and the fixed
// safety-card text. The server gateway (gateway.ts, which imports
// node:crypto and therefore cannot run in the browser) carries its
// own copy; tests/ai-d2.test.mjs asserts the two copies agree on a
// corpus of inputs and on the card text, so a change to one without
// the other fails loudly. Edit both, or neither.
//
// The card text is FIXED, written by us, never by a model, and it
// never blocks posting a job. Numbers below are verified from
// official sources (D2 research, 2026-10-27):
//   - 000: Australia's emergency number.
//   - Power and Water Corporation (NT), emergencies / after-hours
//     faults, 24 hours: 1800 245 090 — powerwater.com.au (multiple
//     pages: "Call 1800 245 090 any time if you notice a serious
//     problem with power or water facilities") and the NT Government
//     Gazette No. S3, 15 January 2026 ("Emergencies and afterhours
//     faults ... Phone: 1800 245 090").
//   - Gas: NO NT household gas-network emergency number was verified.
//     AGIG's own emergency page lists Australian Gas Networks'
//     1800 GAS LEAK (1800 427 532) only for its VIC/SA/NSW/QLD
//     distribution areas — the NT is not one of them — so that
//     number is deliberately NOT printed here. For a gas smell the
//     card says: leave the area and call 000. If an official NT
//     household gas emergency number is ever verified, add it here
//     with its source; never invent one.

export const DANGER_PATTERNS: readonly RegExp[] = [
  /gas\s+smell/i,
  /smell(s|ing)?\s+(of\s+)?gas/i,
  /spark(ing|ed|s)?\b/i,
  /exposed\s+wires?/i,
  /flooding\s+near\s+(the\s+)?(power|electric)/i,
  /water\s+near\s+(the\s+)?(power|electric|outlet|switchboard)/i,
  /structural\s+crack/i,
  /crack(ed)?\s+(wall|ceiling|foundation)/i,
  /branch\s+(on|over)\s+(powerlines?|power\s+lines?)/i,
  /powerlines?\s+(down|hanging)/i,
];

export function detectSafety(text: string): boolean {
  return DANGER_PATTERNS.some((re) => re.test(text));
}

export const SAFETY_CARD = {
  title: 'Safety first — if there is immediate danger, call 000.',
  body: 'Do not touch exposed wires, sparking outlets, or anything near flooding and power. Leave the area if you smell gas and do not switch lights or appliances on or off.',
  utilityNumbers:
    'Power or water fault (Power and Water, NT, 24 hours): 1800 245 090. Gas smell: leave the area and call 000 — no NT household gas emergency number has been verified from an official source.',
  blocksPosting: false,
} as const;

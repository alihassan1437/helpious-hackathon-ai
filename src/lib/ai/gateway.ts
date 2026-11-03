// /api/ai gateway — PURE core (no Next, no Firebase, no network).
//
// D1 (hackathon day 1, 2026-10-27) scope, per the approved decisions:
//   - ONE server endpoint (/api/ai, see src/app/api/ai/route.ts) is the
//     only path from the app to any model. The browser never calls a
//     model provider directly.
//   - MOCKS AND TEST DATA ONLY, unless the route selects the real
//     provider (src/lib/ai/provider.ts) because MODEL_API_KEY is
//     present. The real provider plugs into the same AiProvider
//     interface behind this same allow-list, and only after the
//     data-retention / human-review terms were read (2026-10-28).
//     No key is ever invented or written into code.
//   - Feature flag OFF for real users: DEFAULT_FEATURE_FLAGS are all
//     false, and the route reads the Firestore config/ai doc (missing
//     doc = all OFF). Nothing here can enable a feature by itself.
//   - Standard tier ONLY. The model allow-list below is the enforcement
//     point: any model ID ending in "-contributor" is rejected, and any
//     ID outside the list is rejected. Contributor pricing is never
//     reachable through this gateway, however cheap it looks.
//
// This module is deliberately dependency-free (node:crypto only) so it
// can be unit-tested without the app's Firebase / Next wiring. The
// route handler owns auth, Firestore cache/usage/flags; this module owns
// the rules that must hold regardless of transport.
//
// Design sources (prep docs, not code): api-readiness.md §2 and
// helpious-hackathon-plan.txt §4. Where the two differ, this file
// follows api-readiness.md: the cache key includes promptVersion, and
// over-cap requests return a fallback, never an error page.

import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// Features
// ---------------------------------------------------------------------------

export type AiRole = 'customer' | 'business' | 'admin';

/** Features the D1 gateway accepts. Anything else is rejected as unknown. */
export type AiFeature =
  | 'photo-brief' // C1/B1 — MUST. Snap-to-Quote brief (SAM + Spark in prod).
  | 'quote-draft' // B2 — MUST. Draft from the business's OWN prices only.
  | 'paste-to-profile' // B7 — MUST. Paste text -> listing fields (review screen).
  | 'voice-brief' // VOICE (customer) — MUST. 'Describe it by voice' on get-quote.
  | 'voice-quote' // VOICE (business) — MUST. Voice on a lead -> quote draft.
  | 'safety-check' // C3 — MUST, rule-based: fixed safety card, never AI-written.
  | 'comparison' // C4 — STRETCH. Neutral quote comparison, never a pick.
  | 'image-preview'; // C5 — STRETCH. 'After' preview, explicit tap, max 2/job.

/** Every accepted feature, in the order the route reports them. */
export const AI_FEATURES: readonly AiFeature[] = [
  'photo-brief',
  'quote-draft',
  'paste-to-profile',
  'voice-brief',
  'voice-quote',
  'safety-check',
  'comparison',
  'image-preview',
];

/**
 * Deliberately NOT accepted in D1 (rejected as unknown until their build
 * day): plain-search (C2), smart-reply (B3), review-reply (B4),
 * profile-writer (B5), moderation (A1), category-map (A2), seo-draft
 * (A3). Adding one here is a scope decision for its own day, not a
 * one-line flip — its prompts, caps, and UI must land with it.
 */
export const AI_LATER_FEATURES: readonly string[] = [
  'plain-search',
  'smart-reply',
  'review-reply',
  'profile-writer',
  'moderation',
  'category-map',
  'seo-draft',
];

export function isAiFeature(value: unknown): value is AiFeature {
  return typeof value === 'string' && (AI_FEATURES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Models — Standard tier ONLY
// ---------------------------------------------------------------------------

/**
 * Standard-tier model allow-list. Model IDs per api-readiness.md §1.2;
 * sam-3.1 and muse-image-1.0 were secondary-verified there, so the
 * D1 smoke tests (when a real key exists) must confirm them before
 * any feature that routes to them ships. Open-weight models
 * (Muse Glimmer, Muse Spark Open) are NOT API models and can never
 * appear here — they run via partner inference only.
 */
export const STANDARD_MODEL_ALLOWLIST: readonly string[] = [
  'muse-spark-1.3', // Default text/vision for every D1 feature.
  'muse-spark-1.2', // Fallback only, if 1.3 is unavailable.
  'muse-spark-1.1', // Fallback only.
  'sam-3.1', // Segmentation for photo-brief only.
  'muse-image-1.0', // Image-preview only.
  // Transcription for the voice features: the real provider's
  // callTranscribe() posts to /v1/audio/transcriptions (built to
  // the OpenAI-compatible shape — UNVERIFIED against the live API
  // until the parent smoke test; see docs/ai-gateway.md). Voice
  // features still accept a plain transcript with no audio at all.
  'muse-voice-transcribe-1.0',
];

/** The single enforcement point: allow-listed AND never a Contributor ID. */
export function isStandardModel(model: unknown): boolean {
  return (
    typeof model === 'string' &&
    !model.endsWith('-contributor') &&
    (STANDARD_MODEL_ALLOWLIST as readonly string[]).includes(model)
  );
}

/** Default model per feature (D1 mock routes everything through Spark). */
export const FEATURE_MODEL: Record<AiFeature, string> = {
  'photo-brief': 'muse-spark-1.3',
  'quote-draft': 'muse-spark-1.3',
  'paste-to-profile': 'muse-spark-1.3',
  'voice-brief': 'muse-spark-1.3',
  'voice-quote': 'muse-spark-1.3',
  'safety-check': 'muse-spark-1.3', // Unused: safety-check never calls a model.
  comparison: 'muse-spark-1.3',
  'image-preview': 'muse-image-1.0',
};

// ---------------------------------------------------------------------------
// Prompt versions — prompts live in src/lib/ai/prompts.ts
// ---------------------------------------------------------------------------

export const FEATURE_PROMPT_VERSION: Record<AiFeature, string> = {
  'photo-brief': 'photo-brief-v2',
  'quote-draft': 'quote-draft-v1',
  'paste-to-profile': 'paste-to-profile-v2',
  'voice-brief': 'voice-brief-v2',
  'voice-quote': 'voice-quote-v1',
  'safety-check': 'safety-check-v1',
  comparison: 'comparison-v1',
  'image-preview': 'image-preview-v1',
};

// ---------------------------------------------------------------------------
// Feature flags + kill switch (defaults: EVERYTHING OFF)
// ---------------------------------------------------------------------------

export type AiFeatureFlags = Record<AiFeature, boolean>;

export const DEFAULT_FEATURE_FLAGS: AiFeatureFlags = {
  'photo-brief': false,
  'quote-draft': false,
  'paste-to-profile': false,
  'voice-brief': false,
  'voice-quote': false,
  'safety-check': false,
  comparison: false,
  'image-preview': false,
};

// ---------------------------------------------------------------------------
// Daily caps (api-readiness.md §2.2; voice caps are D1 gateway decisions,
// mirroring the feature they feed: voice-brief like a photo brief,
// voice-quote like a quote draft)
// ---------------------------------------------------------------------------

export type AiDailyCaps = Partial<Record<AiRole, number>>;

export const FEATURE_DAILY_CAPS: Record<AiFeature, AiDailyCaps> = {
  'photo-brief': { customer: 5 },
  'quote-draft': { business: 30 },
  'paste-to-profile': { business: 5, admin: 50 },
  'voice-brief': { customer: 5 },
  'voice-quote': { business: 30 },
  'safety-check': {}, // Rule-based: no model call, no cap.
  comparison: { customer: 10 }, // Provisional D1 value for the stretch feature.
  'image-preview': {}, // Capped per JOB (max 2, explicit tap), not per day;
  // the route enforces that per-job cap when the feature ships. D1: OFF.
};

export function dailyCapFor(feature: AiFeature, role: AiRole): number | null {
  const cap = FEATURE_DAILY_CAPS[feature][role];
  return typeof cap === 'number' ? cap : null;
}

// ---------------------------------------------------------------------------
// Per-user daily-cap accounting (eval finding F1, 2026-11-01)
//
// FEATURE_DAILY_CAPS values are PER USER ("customers 5 photo briefs/day"
// in the dayplan means each customer). The counters live inside the
// same aiUsage/{yyyy-mm-dd} doc the route already reads and writes —
// `{feature}.byUser.{uid}` next to the global `{feature}.calls` — so a
// call still costs exactly 1 read + 1 write. The global `calls`
// counter is kept for budget totals and the kill-switch drill; it no
// longer decides anyone's cap. Usage docs written before this change
// have no byUser map: per-user counts simply start at 0 from deploy
// (nobody loses allowance they had; the caps reset at UTC midnight
// anyway). Tradeoff, recorded honestly: one shared day doc has a 1 MB
// Firestore ceiling — at ~50 bytes per (feature, user) counter that
// is tens of thousands of distinct users per day before it matters,
// far beyond current scale; if it ever approaches, the counters move
// to per-user day docs at the same 1-read/1-write cost.
// ---------------------------------------------------------------------------

/** This user's counted calls for one feature today, defensively read. */
export function userDailyCalls(featureUsage: unknown, uid: string): number {
  if (!isRecord(featureUsage)) return 0;
  const byUser = featureUsage.byUser;
  if (!isRecord(byUser)) return 0;
  const n = byUser[uid];
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** The cap decision: per-user count vs the (unchanged) cap value. */
export function isOverDailyCap(featureUsage: unknown, uid: string, cap: number | null): boolean {
  if (cap === null) return false;
  return userDailyCalls(featureUsage, uid) >= cap;
}

// ---------------------------------------------------------------------------
// Trade vocabulary (D6 eval fix, 2026-11-01)
//
// The eval scored trade by exact match to the site category name and
// got 26/100: the model understood the jobs (semantic routing was
// 89/100) but returned practitioner nouns and sub-specialty labels —
// "Plumber", "Bond Cleaning", "Web Developer" — because nothing
// constrained the vocabulary. Two layers fix it: the v2 brief prompts
// enumerate the canonical list (prompts.ts), and this deterministic
// normalisation maps known variant labels onto it after a brief
// output validates. It runs here, in runAiFeature, because BOTH
// brief features (photo-brief and voice-brief) pass through this one
// return path — and the route caches what runAiFeature returns, so
// cached briefs are canonical too.
//
// The alias table is EVIDENCE-BASED: every entry is a label the
// 2026-11-01 eval actually returned (results.jsonl) whose case
// expected the canonical name, plus the obvious practitioner nouns.
// A label with no unambiguous canonical home is left EXACTLY as the
// model returned it — a wrong-looking label is honest; a silently
// forced wrong category is not. Canonical names pass through
// unchanged, including labels that are themselves canonical (the
// normaliser never rewrites one category into another).
// ---------------------------------------------------------------------------

/** The site's category names, exactly as spelled (22). */
export const TRADE_CATEGORIES = [
  'Plumbing',
  'Electrical',
  'Painting',
  'Cleaning',
  'Gardening & Lawn Care',
  'Air Conditioning',
  'Pest Control',
  'Handyman',
  'Car Mechanic',
  'Website Development',
  'Locksmith',
  'Roofing',
  'Removalists',
  'Appliance Repair',
  'Fencing',
  'Tiling',
  'Solar Installation',
  'Pool Cleaning',
  'Tree Removal',
  'Security Systems',
  'Concreting',
  'Flooring',
] as const;

/**
 * Variant label → canonical category. Keys are matched case-
 * insensitively with whitespace collapsed and dashes normalised.
 * Each group cites its eval evidence (case IDs from the 2026-11-01
 * run); see tests/ai-gateway.test.mjs for the full per-case table
 * and the intentionally-unmapped list.
 */
const TRADE_LABEL_ALIASES: Record<string, string> = {
  // Plumbing — "Plumber" ×7 (P1–P4, P7–P9, X9), "Gasfitter" ×2
  // (P5, P10; in AU practice gasfitting is a plumbing licence class
  // and the dayplan expects Plumbing for both cases).
  plumber: 'Plumbing',
  gasfitter: 'Plumbing',
  'gas fitter': 'Plumbing',
  // Electrical — "Electrician" ×9 (E1–E6, E8–E10).
  electrician: 'Electrical',
  // Painting — "Painter" ×9 (PA1, PA2, PA4–PA10), "Roof Painting" (PA3).
  painter: 'Painting',
  'roof painting': 'Painting',
  // Cleaning — sub-specialty labels, one case each (CL1–CL7).
  cleaner: 'Cleaning',
  'bond cleaning': 'Cleaning',
  'house cleaning': 'Cleaning',
  'carpet cleaning': 'Cleaning',
  'commercial cleaning': 'Cleaning',
  'oven cleaning': 'Cleaning',
  'pressure cleaning': 'Cleaning',
  'window cleaning': 'Cleaning',
  // Gardening & Lawn Care — "Gardener" ×3 (G2, G6, G9), "Lawn Mowing"
  // ×2 (G1, G10), "Lawn Care" (G8), "Irrigation" (G5); the bare short
  // form "Gardening" canonicalises to the full category name.
  gardener: 'Gardening & Lawn Care',
  gardening: 'Gardening & Lawn Care',
  'lawn mowing': 'Gardening & Lawn Care',
  'lawn care': 'Gardening & Lawn Care',
  irrigation: 'Gardening & Lawn Care',
  // Car Mechanic — "Mechanic" ×6 (C1, C2, C5, C7, C8, C10),
  // "Mechanic - Transmission" (C6), "Tyre Service" (C4), "Tyres"
  // (C9), "Auto Air Conditioning" (C3 — car AC is Car Mechanic in
  // the dayplan, distinct from household Air Conditioning).
  mechanic: 'Car Mechanic',
  'mechanic - transmission': 'Car Mechanic',
  'tyre service': 'Car Mechanic',
  tyres: 'Car Mechanic',
  'auto air conditioning': 'Car Mechanic',
  // Website Development — "Web Developer" ×4 (W2, W5, W6, W8),
  // "Web Design" ×3 (W1, W3, W4), "Web Designer" (W10),
  // "Web Development" (W7), "SEO Specialist" (W9 — the dayplan
  // expects Website Development; there is no SEO category).
  'web developer': 'Website Development',
  'web design': 'Website Development',
  'web designer': 'Website Development',
  'web development': 'Website Development',
  'seo specialist': 'Website Development',
  // Handyman — sub-specialty labels with no category of their own;
  // the dayplan expects Handyman for each: "Carpenter" ×2 (H2 door
  // hinge, H4 decking), "Plasterer" (H3), "Furniture Assembly" (H1),
  // "TV Mounting" (H8), "Window Repairs" (H6).
  carpenter: 'Handyman',
  plasterer: 'Handyman',
  'furniture assembly': 'Handyman',
  'tv mounting': 'Handyman',
  'window repairs': 'Handyman',
};

/**
 * Labels deliberately NOT mapped — returned unchanged:
 * - "Arborist" (G3, G7): the dayplan expects Gardening, but the site
 *   taxonomy also has Tree Removal — two defensible homes, so the
 *   meaning is NOT unambiguous and no deterministic map is honest.
 *   The v2 prompt lets the model choose from the canonical list.
 * - "Tiler" (H9): the only eval occurrence is shower re-silicone,
 *   which the dayplan scores as Handyman; re-siliconing is not
 *   tiling, so neither Tiling nor Handyman is an honest blanket map.
 * - "Appliance Repair" (E7) and "Fencing" (H7): both are canonical
 *   categories in their own right. Their eval expectations
 *   (Electrical, Handyman) come from the dayplan's original
 *   10-category set; rewriting one valid category into another
 *   would corrupt genuine briefs for those trades.
 * - "Rubbish Removal" (G4): no canonical home — Removalists is
 *   household moving, not waste removal.
 * - "Plumbing and Tiling" (X10): a compound label for a genuine
 *   two-trade job; no single canonical home.
 * - "Unclear" / "Unknown" / "Unknown - Bathroom" (X5–X7): the
 *   model's honest "cannot tell" answers. Those cases PASS because
 *   no trade is forced; mapping them would break that behaviour.
 */
export function normalizeTradeLabel(label: string): string {
  const trimmed = label.trim().replace(/\s+/g, ' ');
  const key = trimmed.replace(/[–—]/g, '-').toLowerCase();
  for (const category of TRADE_CATEGORIES) {
    if (category.toLowerCase() === key) return category;
  }
  return TRADE_LABEL_ALIASES[key] ?? trimmed;
}

/** Applies normalizeTradeLabel to a validated brief output, if any. */
function normalizeBriefTrade(
  feature: AiFeature,
  output: Record<string, unknown>,
): Record<string, unknown> {
  if (feature !== 'photo-brief' && feature !== 'voice-brief') return output;
  if (typeof output.trade !== 'string') return output;
  const trade = normalizeTradeLabel(output.trade);
  return trade === output.trade ? output : { ...output, trade };
}

/** Roles allowed to call each feature. The route takes role from the token, never the body. */
export const FEATURE_ROLES: Record<AiFeature, readonly AiRole[]> = {
  'photo-brief': ['customer', 'business', 'admin'],
  'quote-draft': ['business', 'admin'],
  'paste-to-profile': ['business', 'admin'],
  'voice-brief': ['customer', 'admin'],
  'voice-quote': ['business', 'admin'],
  'safety-check': ['customer', 'business', 'admin'],
  comparison: ['customer', 'admin'],
  'image-preview': ['customer', 'admin'],
};

// ---------------------------------------------------------------------------
// PII strip — runs BEFORE cache lookup AND before any model call.
// The cache key and every stored doc use the STRIPPED input only.
// ---------------------------------------------------------------------------

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// Spelled-out email ("john at gmail dot com") — that written-out
// shape only occurs when someone is dictating an address, so it is
// safe to strip. Stopword guard keeps prose like "look at the dot
// com bubble" intact. (G2 audit miss, 2026-11-01.)
const SPOKEN_EMAIL_RE =
  /\b[A-Za-z0-9._%+-]+\s+at\s+(?!the\s+dot\b|a\s+dot\b|an\s+dot\b)[A-Za-z0-9-]+\s+dot\s+(?:com\.au|net\.au|org\.au|com|net|org|io|au)\b/gi;
// Street number + street name ("12 Smith Street", "4/12 Smith St").
// Suffix list widened 2026-11-01 (G2 audit): Boulevard, Esplanade,
// Terrace, Crescent, Close, Way, Circuit and Grove previously leaked
// verbatim (e.g. "3/45 Charles Darwin Boulevard", "12 The Esplanade").
const STREET_RE =
  /\b\d{1,5}(?:\/\d{1,5})?\s+[A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){0,2}\s+(?:Street|St|Road|Rd|Avenue|Ave|Drive|Dr|Court|Ct|Lane|Ln|Place|Pl|Parade|Pde|Highway|Hwy|Boulevard|Blvd|Esplanade|Esp|Terrace|Tce|Crescent|Cres|Close|Cl|Way|Circuit|Cct|Grove|Gr)\b/gi;
// Suffix-less address shape: "12 Smith, Darwin" — house number +
// single Capitalised word + comma + Capitalised place name. Kept
// deliberately narrow and case-sensitive (capitalisation IS the
// signal); ordinary mid-sentence prose rarely has this exact shape,
// and an address fragment is exactly what must not reach a model.
// Only the number + street-name fragment is removed — the place
// name after the comma is re-emitted, because suburb-level location
// is data the briefs are allowed to carry.
const STREET_NO_SUFFIX_RE = /\b\d{1,5}(?:\/\d{1,5})?\s+[A-Z][A-Za-z]{2,},\s+([A-Z][A-Za-z]{2,})\b/g;
// AU mobiles (+61 4xx / 04xx) and landlines (+61 2/3/7/8 / 0x).
// Separators may be spaces, hyphens or DOTS, mixed within one number
// ("0412.345.678", "0412 345-678") — dot-separated mobiles leaked
// verbatim before 2026-11-01 (G2 audit). The digit-chain pattern
// below is the backstop for shapes this one misses.
const AU_PHONE_RE = /(?:\+61[\s.-]?|0)(?:4\d{2}|[2378]\d)[\s.-]?\d{3}[\s.-]?\d{3}\b/g;
// Any remaining long digit chain (account numbers, IDs, etc.):
// 8+ digits with spaces, hyphens or dots between them. Written as
// digit (separator* digit){7,} so a separator is consumed only when
// a digit follows — trailing sentence punctuation is never eaten
// and short decimals ("1200.50") stay untouched.
const DIGIT_CHAIN_RE = /\b\d(?:[\s.-]*\d){7,}\b/g;
// Narrow, honest name pattern only ("my name is X", "I'm X"). The
// intro is matched case-insensitively via character classes, but
// the NAME must be genuinely Capitalised: a fully case-insensitive
// version also matched "I am in Casuarina" (intro + "in" + suburb)
// and deleted the suburb, which briefs are allowed to carry (G2
// audit over-strip, 2026-11-01). Arbitrary person names still
// CANNOT be detected by pattern — callers must never send names,
// and this limitation is stated, not papered over.
const NAME_INTRO_RE = /\b(?:[Mm]y name is|[Ii] am|[Ii]'m)\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?/g;

export interface StripResult {
  cleaned: string;
  removed: boolean;
}

export function stripPii(text: string): StripResult {
  let cleaned = text;
  const before = cleaned;
  cleaned = cleaned.replace(EMAIL_RE, '[email removed]');
  cleaned = cleaned.replace(SPOKEN_EMAIL_RE, '[email removed]');
  cleaned = cleaned.replace(STREET_RE, '[address removed]');
  cleaned = cleaned.replace(
    STREET_NO_SUFFIX_RE,
    (_match, place: string) => `[address removed], ${place}`,
  );
  cleaned = cleaned.replace(AU_PHONE_RE, '[phone removed]');
  cleaned = cleaned.replace(DIGIT_CHAIN_RE, '[number removed]');
  cleaned = cleaned.replace(NAME_INTRO_RE, 'the customer');
  cleaned = cleaned.replace(/\[(?:email|address|phone|number) removed\](?:\s*\[(?:email|address|phone|number) removed\])+/g, '[contact details removed]');
  return { cleaned: cleaned.trim(), removed: cleaned !== before };
}

/** Recursively strips PII from every string in a JSON-shaped payload. */
export function stripPiiDeep(value: unknown): unknown {
  if (typeof value === 'string') return stripPii(value).cleaned;
  if (Array.isArray(value)) return value.map((v) => stripPiiDeep(v));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = stripPiiDeep(v);
    return out;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Safety card (C3) — FIXED text written by us, never by a model.
// The card never blocks posting a job.
//
// NOTE ON DUPLICATION (D2): these definitions are mirrored in
// ./safety-patterns.ts for the browser, because this module imports
// node:crypto (unimportable client-side) and Node's type stripping
// cannot resolve the extensionless import tsc requires. The two
// copies are kept identical by tests/ai-d2.test.mjs ("gateway and
// browser safety copies agree") — if you change one, change the
// other, or that test fails. Numbers verified from official NT
// sources in D2; see safety-patterns.ts for the sources. Gas has no
// verified NT household number, so the card routes gas smells to 000.
// ---------------------------------------------------------------------------

const DANGER_PATTERNS: readonly RegExp[] = [
  /gas\s+smell/i,
  /gas\s+leak/i,
  /leak(ing|ed)?\s+gas\b/i,
  /smell(s|ing)?\s+(of\s+)?gas/i,
  /spark(ing|ed|s)?\b/i,
  /exposed\s+wires?/i,
  // Water/flooding near power: ordinary words may sit between the
  // water word and "near (a|the) power…" — "flooding near a power
  // point" (eval P3), "water pooling under the sink near a power
  // point". The gap is length-capped and cannot cross a sentence
  // boundary, and a target word (power/electric/outlet/switchboard)
  // is still required, so "burst pipe in the laundry" and "water
  // the garden" do NOT fire.
  /\b(?:flooding|flood|water|leak|burst)\b[^.!?]{0,60}?\bnear\s+(?:a\s+|an\s+|the\s+)?(?:power|electric|outlet|switchboard)/i,
  /structural\s+crack/i,
  /crack(ed)?\s+(wall|ceiling|foundation)/i,
  // Vegetation near powerlines/wires, intervening words allowed:
  // "branch hanging over a roof near powerlines" (eval G3), "branch
  // on the powerlines", "palm fronds touching overhead wires"
  // (eval G7), "fronds near powerlines". A powerline/wire target is
  // required, so "branch near the fence" does NOT fire.
  /\b(?:branch|branches|frond|fronds|limb|limbs|tree)\b[^.!?]{0,60}?\b(?:powerlines?|power\s+lines?)\b/i,
  /\b(?:branch|branches|frond|fronds)\b[^.!?]{0,40}?\b(?:overhead\s+)?wires?\b/i,
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

// ---------------------------------------------------------------------------
// Cache key — SHA-256 of feature + model + STRIPPED input + promptVersion.
// promptVersion is REQUIRED in the key: a prompt change must never serve
// a stale output from the old prompt.
// ---------------------------------------------------------------------------

export function aiCacheKey(
  feature: AiFeature,
  model: string,
  strippedInput: unknown,
  promptVersion: string,
): string {
  const canonical = `${feature}\n${model}\n${JSON.stringify(strippedInput)}\n${promptVersion}`;
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// Fallback — the manual form must still work. Never an error page.
// ---------------------------------------------------------------------------

export interface AiFallback {
  fallback: true;
  feature: AiFeature;
  reason: string;
  safetyCard?: typeof SAFETY_CARD;
}

export function aiFallback(feature: AiFeature, reason: string, safetyCard = false): AiFallback {
  return {
    fallback: true,
    feature,
    reason,
    ...(safetyCard ? { safetyCard: SAFETY_CARD } : {}),
  };
}

// ---------------------------------------------------------------------------
// Mock provider (D1 ONLY) — deterministic test shapes, zero network,
// zero key, zero cost. A real provider replaces this function, never
// the route's auth/cap/cache/flag logic around it.
// ---------------------------------------------------------------------------

export interface AiProvider {
  /** Returns the raw output object for the feature, or throws on failure. */
  call: (args: {
    feature: AiFeature;
    model: string;
    input: unknown;
    promptVersion: string;
    repair: boolean;
  }) => Promise<unknown>;
}

function mockBrief(input: unknown): Record<string, unknown> {
  // Voice features pass a transcript; photo briefs pass text. Both are
  // plain text here — the mock never handles audio bytes: a voice
  // call carrying an audioDataUri gets this same mock brief from its
  // text fields (the real provider transcribes first, then strips
  // the transcript — see provider.ts).
  const record =
    typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {};
  const text =
    typeof record.text === 'string' ? record.text : typeof record.transcript === 'string' ? record.transcript : '';
  return {
    trade: 'To confirm in the form (mock)',
    issue: text ? `Test input received (mock): ${text.slice(0, 200)}` : 'Test photo brief (mock)',
    scope: 'Mock scope — edit in the form.',
    urgency: 'Routine',
    accessNotes: '',
    questions: ['Mock question 1: when did this start?', 'Mock question 2: anything else affected?'],
    missingPhotos: [],
    safetyCardShown: detectSafety(text),
  };
}

function mockQuoteDraft(): Record<string, unknown> {
  return {
    // Prices are NEVER invented: a draft with no business price list
    // has null prices and a flag, never a guessed dollar figure.
    lineItems: [
      { description: 'Labour (mock — fill from your price list)', price: null, priceMissing: true },
      { description: 'Parts (mock — fill from your price list)', price: null, priceMissing: true },
      { description: 'Call-out (mock — fill from your price list)', price: null, priceMissing: true },
    ],
    total: null,
    notes: 'Mock draft — prices left blank because no business price list was supplied in D1.',
  };
}

export const mockAiProvider: AiProvider = {
  async call({ feature, input }) {
    switch (feature) {
      case 'photo-brief':
      case 'voice-brief':
        return mockBrief(input);
      case 'quote-draft':
      case 'voice-quote':
        return mockQuoteDraft();
      case 'paste-to-profile':
        // D1 mock performs NO extraction: returning invented listing
        // fields would violate the no-invention rule. The real
        // extractor (D5) fills this shape from the pasted text only.
        return {
          extracted: {},
          seo: { description: '', tagline: '', metaTitle: '', metaDescription: '' },
          lowConfidence: [],
          sourceSnippets: [],
          mock: true,
          note: 'D1 mock — no extraction performed.',
        };
      case 'safety-check':
        return { safetyCard: SAFETY_CARD };
      case 'comparison':
        return { summaries: [], missing: [], questions: [], note: 'Mock comparison (stretch).' };
      case 'image-preview':
        return {
          imageUrl: null,
          watermark: 'Illustration only',
          note: 'D1 mock — no image generated. Max 2 per job, explicit tap only, when shipped.',
        };
      default:
        throw new Error(`Mock provider has no shape for feature: ${String(feature)}`);
    }
  },
};

// ---------------------------------------------------------------------------
// Output validation — one repair retry, then fallback. The shapes below
// are the contract the real (zod) schemas must mirror when they land.
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

export function isValidAiOutput(feature: AiFeature, output: unknown): boolean {
  if (!isRecord(output)) return false;
  switch (feature) {
    case 'photo-brief':
    case 'voice-brief':
      return (
        typeof output.trade === 'string' &&
        typeof output.issue === 'string' &&
        typeof output.urgency === 'string' &&
        Array.isArray(output.questions)
      );
    case 'quote-draft':
    case 'voice-quote':
      return (
        Array.isArray(output.lineItems) &&
        (output.lineItems as unknown[]).every(
          (item) =>
            isRecord(item) &&
            typeof item.description === 'string' &&
            (item.price === null || typeof item.price === 'number'),
        )
      );
    case 'paste-to-profile':
      return isRecord(output.extracted) && isRecord(output.seo);
    case 'safety-check':
      return isRecord(output.safetyCard);
    case 'comparison':
      return Array.isArray(output.summaries) && Array.isArray(output.missing);
    case 'image-preview':
      return typeof output.watermark === 'string';
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Call discipline: per-attempt timeout, ONE repair retry, then fallback.
// Most features answer in a few seconds, so the default budget is 15s.
// paste-to-profile is the exception: a full extraction plus SEO copy
// measured 23.7s on a live call (2026-10-30 flag-on proof — the reply
// validated perfectly but arrived after the 15s budget, so both
// attempts timed out and the feature fell back). It gets 60s. Voice
// features chain TWO calls (transcribe, then the brief/quote chat),
// so they get 45s. photo-brief gets 30s: the 2026-11-03 demo capture
// caught two ~15s attempts timing out on a slow-reasoning call (the
// retry with a longer combined window succeeded) — the brief is the
// hero feature and its reasoning tail is longer than the default.
// ---------------------------------------------------------------------------

export const AI_TIMEOUT_MS = 15_000;

export const FEATURE_TIMEOUT_MS: Partial<Record<AiFeature, number>> = {
  'paste-to-profile': 60_000,
  'photo-brief': 30_000,
  'voice-brief': 45_000,
  'voice-quote': 45_000,
};

export function timeoutForFeature(feature: AiFeature): number {
  return FEATURE_TIMEOUT_MS[feature] ?? AI_TIMEOUT_MS;
}

export async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error('AI call timed out')), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface AiRunResult {
  output: Record<string, unknown> | null;
  fallback: AiFallback | null;
  cacheKey: string;
  model: string;
  promptVersion: string;
  strippedInput: unknown;
  safetyCardShown: boolean;
  repairAttempted: boolean;
  cacheHit?: boolean;
}

/**
 * Runs one feature end-to-end through the pure rules: feature check,
 * model allow-list, PII strip (before anything else), safety detect,
 * provider call with timeout, validation + one repair retry, fallback.
 * Auth, flags, caps, cache reads/writes, and usage counting live in the
 * route handler — this function never touches Firestore or the network
 * beyond the injected provider.
 */
export async function runAiFeature(args: {
  feature: AiFeature;
  input: unknown;
  promptVersion?: string;
  provider?: AiProvider;
  timeoutMs?: number;
}): Promise<AiRunResult> {
  const { feature } = args;
  const model = FEATURE_MODEL[feature];
  const promptVersion = args.promptVersion ?? FEATURE_PROMPT_VERSION[feature];
  const provider = args.provider ?? mockAiProvider;
  const timeoutMs = args.timeoutMs ?? timeoutForFeature(feature);

  if (!isStandardModel(model)) {
    // Unreachable with the current FEATURE_MODEL table, but the check
    // must stay: if the table ever changes, the gateway fails closed.
    return {
      output: null,
      fallback: aiFallback(feature, 'Model is not on the Standard-tier allow-list.'),
      cacheKey: '',
      model,
      promptVersion,
      strippedInput: null,
      safetyCardShown: false,
      repairAttempted: false,
    };
  }

  // PII strip FIRST — the cache key below is computed from stripped input.
  //
  // Voice features may carry a recording as an `audioDataUri` string.
  // Base64 is opaque payload, and the strip would corrupt it: a run
  // of 8+ digits inside base64 is indistinguishable from the "long
  // digit chain" the strip removes. So the audio is lifted out
  // before stripping and re-attached untouched, for voice features
  // only. No unstripped TEXT reaches a model or a stored doc either
  // way: the provider transcribes the audio and PII-strips the
  // TRANSCRIPT before any brief/quote model call (see provider.ts).
  let audioDataUri: string | null = null;
  let stripTarget: unknown = args.input;
  if (
    (feature === 'voice-brief' || feature === 'voice-quote') &&
    isRecord(args.input) &&
    typeof args.input.audioDataUri === 'string'
  ) {
    const { audioDataUri: lifted, ...rest } = args.input;
    audioDataUri = lifted;
    stripTarget = rest;
  }
  const strippedRest = stripPiiDeep(stripTarget);
  const strippedInput =
    audioDataUri !== null && isRecord(strippedRest)
      ? { ...strippedRest, audioDataUri }
      : strippedRest;
  const strippedText = JSON.stringify(strippedInput);
  const safetyCardShown = detectSafety(strippedText);
  const cacheKey = aiCacheKey(feature, model, strippedInput, promptVersion);

  // If stripping removed everything usable, never call with raw input.
  const hasUsableInput =
    strippedInput !== null &&
    strippedInput !== undefined &&
    (typeof strippedInput !== 'string' || strippedInput.length > 0) &&
    (typeof strippedInput !== 'object' ||
      Object.keys(strippedInput as Record<string, unknown>).length > 0);
  if (!hasUsableInput) {
    return {
      output: null,
      fallback: aiFallback(feature, 'Nothing usable left after removing contact details.', safetyCardShown),
      cacheKey,
      model,
      promptVersion,
      strippedInput,
      safetyCardShown,
      repairAttempted: false,
    };
  }

  // Safety-check is rule-based: no model call at all.
  if (feature === 'safety-check') {
    return {
      output: { safetyCard: SAFETY_CARD },
      fallback: null,
      cacheKey,
      model,
      promptVersion,
      strippedInput,
      safetyCardShown,
      repairAttempted: false,
    };
  }

  // G1 gate (2026-11-01): user photos are NOT forwarded to any
  // model. Client-side masking (resize + EXIF strip + face / plate /
  // house-number blur) is not wired end-to-end yet — the shipped C1
  // client sends text + hasPhoto only — so until masking lands, an
  // input carrying an `imageDataUri` gets the standard fallback and
  // the provider is NEVER called. This one check covers every
  // provider path that reads the field, because they are all behind
  // provider.call: the chat vision attachment AND the SAM 3.1
  // segmentation call (reached only from photo-brief inputs with an
  // image + samPrompt). The check matches the provider's own read
  // shape exactly (top-level `imageDataUri` string on a record).
  // The image-preview feature is exempt: it GENERATES an image from
  // a text prompt — its imageDataUri is output, never input.
  if (
    feature !== 'image-preview' &&
    isRecord(args.input) &&
    typeof args.input.imageDataUri === 'string'
  ) {
    return {
      output: null,
      fallback: aiFallback(
        feature,
        'Photo analysis is not switched on yet — describe the problem in words and the brief will work from your description.',
        safetyCardShown,
      ),
      cacheKey,
      model,
      promptVersion,
      strippedInput,
      safetyCardShown,
      repairAttempted: false,
    };
  }

  let repairAttempted = false;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const raw = await withTimeout(
        provider.call({ feature, model, input: strippedInput, promptVersion, repair: attempt === 1 }),
        timeoutMs,
      );
      if (isValidAiOutput(feature, raw)) {
        return {
          output: normalizeBriefTrade(feature, raw as Record<string, unknown>),
          fallback: null,
          cacheKey,
          model,
          promptVersion,
          strippedInput,
          safetyCardShown,
          repairAttempted,
        };
      }
      // Invalid shape: one repair retry, then fallback.
      repairAttempted = true;
    } catch {
      // Timeout or provider failure: one repair retry covers invalid
      // JSON only in spirit — a second attempt after a timeout is
      // still bounded (2 attempts x the per-feature budget) and then
      // falls back. The user is never blocked on AI.
      repairAttempted = true;
    }
  }
  return {
    output: null,
    fallback: aiFallback(feature, 'AI is unavailable right now — the manual form still works.', safetyCardShown),
    cacheKey,
    model,
    promptVersion,
    strippedInput,
    safetyCardShown,
    repairAttempted,
  };
}

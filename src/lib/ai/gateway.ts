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
  // Transcription transport is NOT built yet — voice features take
  // transcripts today, and transcription plugs in before this
  // gateway (see prompts.ts). Listed so the allow-list matches the
  // verified Standard-tier model set; nothing routes to it yet.
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
  'photo-brief': 'photo-brief-v1',
  'quote-draft': 'quote-draft-v1',
  'paste-to-profile': 'paste-to-profile-v1',
  'voice-brief': 'voice-brief-v1',
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
// Street number + street name ("12 Smith Street", "4/12 Smith St").
const STREET_RE =
  /\b\d{1,5}(?:\/\d{1,5})?\s+[A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){0,2}\s+(?:Street|St|Road|Rd|Avenue|Ave|Drive|Dr|Court|Ct|Lane|Ln|Place|Pl|Parade|Pde|Highway|Hwy)\b/gi;
// AU mobiles (+61 4xx / 04xx) and landlines (+61 2/3/7/8 / 0x).
const AU_PHONE_RE = /(?:\+61\s?|0)(?:4\d{2}|[2378]\d)[\s-]?\d{3}[\s-]?\d{3}\b/g;
// Any remaining long digit chain (account numbers, IDs, etc.).
const DIGIT_CHAIN_RE = /\b\d[\d\s-]{6,}\d\b/g;
// Narrow, honest name pattern only ("my name is X", "I'm X"). Arbitrary
// person names CANNOT be detected by pattern — callers must never send
// names, and this limitation is stated, not papered over.
const NAME_INTRO_RE = /\b(?:my name is|i am|i'm)\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?/gi;

export interface StripResult {
  cleaned: string;
  removed: boolean;
}

export function stripPii(text: string): StripResult {
  let cleaned = text;
  const before = cleaned;
  cleaned = cleaned.replace(EMAIL_RE, '[email removed]');
  cleaned = cleaned.replace(STREET_RE, '[address removed]');
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
  // plain text in D1 — no audio bytes are handled anywhere.
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
// Call discipline: 15s timeout per attempt, ONE repair retry, then fallback.
// ---------------------------------------------------------------------------

export const AI_TIMEOUT_MS = 15_000;

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
  const timeoutMs = args.timeoutMs ?? AI_TIMEOUT_MS;

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
  const strippedInput = stripPiiDeep(args.input);
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

  let repairAttempted = false;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const raw = await withTimeout(
        provider.call({ feature, model, input: strippedInput, promptVersion, repair: attempt === 1 }),
        timeoutMs,
      );
      if (isValidAiOutput(feature, raw)) {
        return {
          output: raw as Record<string, unknown>,
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
      // still bounded (2 attempts x 15s) and then falls back. The user
      // is never blocked on AI.
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

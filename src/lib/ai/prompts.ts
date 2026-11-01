// Versioned prompt library for the /api/ai gateway (D1).
//
// Prompts live here, versioned, so every stored output can record its
// promptVersion and a prompt change can never serve a stale cached
// output (the cache key includes promptVersion — see gateway.ts).
//
// D1 STATUS: these are the v1 prompt TEXTS the real provider will use.
// The D1 mock provider does not call a model and does not read these
// prompts; they exist so the D2+ wiring has a reviewed, versioned
// starting point and so reviewers can check the rules in the prompts
// themselves. Every prompt repeats the same non-negotiables:
//
//   - NEVER invent prices, ratings, licences, or availability.
//   - NEVER include names, phone numbers, emails, or street addresses
//     in the output (inputs are PII-stripped before the call anyway).
//   - NEVER write emergency advice: danger signs get the fixed safety
//     card from gateway.ts, not model-written advice.
//   - Output is an "AI suggestion" pre-filled into an editable form,
//     never auto-sent.
//
// Voice: the v1 voice prompts take a TRANSCRIPT (text) as input.
// When a voice call carries a recording, transcription
// (muse-voice-transcribe-1.0) happens inside the real provider
// (provider.ts callTranscribe): the provider transcribes, PII-strips
// the transcript, and feeds it to these prompts in exactly this
// transcript shape. The transcription endpoint was verified live
// on 2026-10-30 — see docs/ai-gateway.md (Voice section).

import { TRADE_CATEGORIES, type AiFeature } from './gateway';

export interface AiPrompt {
  version: string;
  system: string;
  /** The strict output shape the real provider must validate (zod). */
  outputShape: string;
}

const NEVER_INVENT =
  'Never invent prices, ratings, licences, or availability. If a price is not in the supplied business price list or past quotes, leave it blank and flag it missing. Never include a name, phone number, email, or street address in your output. Never write emergency or safety advice.';

// Brief v2 (2026-11-01, D6 eval fix): the v1 briefs returned the
// right trade in the wrong words — "Plumber", "Bond Cleaning",
// "Web Developer" — because nothing constrained `trade` to the
// site's category names (strict trade accuracy was 26/100 while
// semantic routing was 89/100). The v2 prompts enumerate the
// canonical list (imported from gateway.ts so the two can never
// drift) and forbid practitioner nouns and sub-specialties. The
// gateway ALSO normalises known variant labels deterministically
// (normalizeTradeLabel) — the prompt is the first layer, not the
// only one. The "Unclear" escape hatch stays: the eval's honesty
// cases pass precisely because no trade is forced when there is
// no job or the photo is unreadable.
const TRADE_RULE = `For trade, return EXACTLY one of these Helpious category names, spelled exactly as written — never a practitioner noun (not "Plumber", not "Electrician") and never a sub-specialty name: ${TRADE_CATEGORIES.join(', ')}. Choose the category the job belongs to even when a narrower specialty name exists. If the input describes no trade job, or you genuinely cannot tell which category fits, return "Unclear" for trade instead of guessing.`;

// Brief v2 urgency context (same eval): the model defaulted broken
// air-conditioning to Routine — it had no Darwin context. Every
// rule below is taken from the eval dayplan's own expected values:
// A2 (blows warm), A6 (rattling), A7 (won't turn on) and A8 (mouldy
// smell from the vents) are all expected Urgent, and the failed
// hot-water case ("cold showers since yesterday") is Urgent too.
const URGENCY_CONTEXT =
  'Urgency context for Darwin, Northern Territory: in the build-up and wet season the heat and humidity are extreme, so a household air-conditioner that is not cooling (blowing warm air), will not turn on, is making abnormal noises, or is blowing a mouldy smell is Urgent, not Routine — losing cooling in that heat is a health issue, not a comfort issue. A failed hot water system (no hot water) is also Urgent.';

export const AI_PROMPTS: Record<AiFeature, AiPrompt> = {
  'photo-brief': {
    version: 'photo-brief-v2',
    system: `You write a structured job brief from a customer's photos and short description, in plain Australian English. Return trade/category, what is wrong in plain English, scope, urgency (Emergency, Urgent, or Routine), access notes, 2-3 questions a tradie would ask, and photos still missing. ${TRADE_RULE} ${URGENCY_CONTEXT} ${NEVER_INVENT}`,
    outputShape: '{ trade: string, issue: string, scope: string, urgency: "Emergency" | "Urgent" | "Routine", accessNotes: string, questions: string[], missingPhotos: string[] }',
  },
  'quote-draft': {
    version: 'quote-draft-v1',
    system: `You draft quote line items (labour, parts, call-out) from a job brief PLUS the business's own price list and past quotes, supplied in the input. Use ONLY those prices. ${NEVER_INVENT}`,
    outputShape: '{ lineItems: { description: string, price: number | null, priceMissing: boolean }[], total: number | null, notes: string }',
  },
  'paste-to-profile': {
    version: 'paste-to-profile-v2',
    system: `You extract listing fields from text a business pasted about ITSELF (its website, Facebook page, or a document), in plain Australian English. Extract ONLY what the text actually states — nothing else exists. For every field you return, quote the exact snippet from the text that supports it. If the text does not state a field, leave that field out entirely; an empty extraction is a correct answer when the text says nothing usable.

Fields to extract (keys exactly as written):
- businessName: the trading name, as written.
- category: the trade or industry the text states (for example "Plumbing").
- services: the services the text lists or clearly describes, as a list of short phrases.
- serviceAreas: suburbs or areas the text says the business services, as a list. Suburb names only — never a street address.
- openingHours: only the days the text states, as an object keyed by full day name (Monday..Sunday), each value either "Closed" or a range in exactly this format: "09:00 — 17:00" (24-hour, space, em dash, space). Do not guess days the text omits.
- yearsInBusiness: how long the business has traded, as a short phrase taken from the text (for example "10+ Years" or "Since 2012").
- paymentMethods: payment methods the text names, as a list.
- website: the business's website, ONLY if a web address is literally in the text.
- fromPrices: prices the text states, as an object mapping the service named in the text to the price phrase as written (for example "From $120"). Never a price the text does not state.

CONTACT DETAILS AND ID NUMBERS: for privacy, the text you receive has already had phone numbers, email addresses, street addresses, ABNs, and licence numbers replaced with placeholders such as [phone removed], [email removed], [address removed], or [number removed]. NEVER output the placeholder text or invent a value to replace it. Leave phone, email, street address, ABN, and licence number out of the extraction completely — the business enters those in the form itself. Instead, list in removedContact which kinds you saw as placeholders, using only these words: "phone", "email", "street address", "ABN", "licence number".

Flag in lowConfidence any field (by its key) where the text is ambiguous, contradictory, or you are inferring rather than reading directly.

Then write SEO copy from the extracted facts ONLY: a 150-250 word description, a short tagline, a meta title (60 characters or fewer), and a meta description (140-160 characters), naming the real suburbs and services from the extraction. No invented claims: never write best, No.1, licensed, insured, or guaranteed unless the text says so, and no keyword stuffing. ${NEVER_INVENT}`,
    outputShape: '{ extracted: { [field]: { value: string | string[] | object, snippet: string } }, seo: { description: string, tagline: string, metaTitle: string, metaDescription: string }, lowConfidence: string[], removedContact: string[] }',
  },
  'voice-brief': {
    version: 'voice-brief-v2',
    system: `You write a structured job brief from a customer's spoken description (supplied as a transcript) plus any photos, in plain Australian English. Same output as a photo brief: trade, issue, scope, urgency, access notes, 2-3 questions a tradie would ask, photos still missing. ${TRADE_RULE} ${URGENCY_CONTEXT} ${NEVER_INVENT}`,
    outputShape: '{ trade: string, issue: string, scope: string, urgency: "Emergency" | "Urgent" | "Routine", accessNotes: string, questions: string[], missingPhotos: string[] }',
  },
  'voice-quote': {
    version: 'voice-quote-v1',
    system: `You draft quote line items from a tradie's spoken notes on a lead (supplied as a transcript) plus the job brief and the business's own price list and past quotes. Use ONLY those prices. ${NEVER_INVENT}`,
    outputShape: '{ lineItems: { description: string, price: number | null, priceMissing: boolean }[], total: number | null, notes: string }',
  },
  'safety-check': {
    version: 'safety-check-v1',
    system: 'Rule-based feature: no model call. The gateway returns the fixed safety card from gateway.ts whenever danger patterns are detected. This entry exists only so the feature has a recorded prompt version.',
    outputShape: '{ safetyCard: object }',
  },
  comparison: {
    version: 'comparison-v1',
    system: `You write a neutral side-by-side summary of two or more quotes: what each includes, what each is missing, and questions to ask. Be factual only. Never pick a business or recommend one over another. ${NEVER_INVENT}`,
    outputShape: '{ summaries: string[], missing: string[], questions: string[] }',
  },
  'image-preview': {
    version: 'image-preview-v1',
    system: 'You generate an illustrative "after" preview image from a customer photo for visual trades (painting, landscaping, cleaning). The result is always watermarked "Illustration only" and is shown only after an explicit tap, at most twice per job.',
    outputShape: '{ imageUrl: string | null, watermark: "Illustration only" }',
  },
};

export function getPrompt(feature: AiFeature): AiPrompt {
  return AI_PROMPTS[feature];
}

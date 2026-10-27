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
// Voice: D1 voice features take a TRANSCRIPT (text) as input. No audio
// bytes are sent anywhere in D1, and no voice model is called. The
// transcription step (muse-voice-transcribe-1.0 in prod) plugs in
// before this gateway, feeding the same transcript shape.

import type { AiFeature } from './gateway';

export interface AiPrompt {
  version: string;
  system: string;
  /** The strict output shape the real provider must validate (zod). */
  outputShape: string;
}

const NEVER_INVENT =
  'Never invent prices, ratings, licences, or availability. If a price is not in the supplied business price list or past quotes, leave it blank and flag it missing. Never include a name, phone number, email, or street address in your output. Never write emergency or safety advice.';

export const AI_PROMPTS: Record<AiFeature, AiPrompt> = {
  'photo-brief': {
    version: 'photo-brief-v1',
    system: `You write a structured job brief from a customer's photos and short description, in plain Australian English. Return trade/category, what is wrong in plain English, scope, urgency (Emergency, Urgent, or Routine), access notes, 2-3 questions a tradie would ask, and photos still missing. ${NEVER_INVENT}`,
    outputShape: '{ trade: string, issue: string, scope: string, urgency: "Emergency" | "Urgent" | "Routine", accessNotes: string, questions: string[], missingPhotos: string[] }',
  },
  'quote-draft': {
    version: 'quote-draft-v1',
    system: `You draft quote line items (labour, parts, call-out) from a job brief PLUS the business's own price list and past quotes, supplied in the input. Use ONLY those prices. ${NEVER_INVENT}`,
    outputShape: '{ lineItems: { description: string, price: number | null, priceMissing: boolean }[], total: number | null, notes: string }',
  },
  'paste-to-profile': {
    version: 'paste-to-profile-v1',
    system: `You extract listing fields from pasted business text: business name, category and extra categories, services list, from-prices ONLY if stated in the text, service areas/suburbs, opening hours, years in business, phone/website/email only if present, ABN if present (marked to verify), licence numbers (marked to verify), payment methods. Then write SEO copy from those facts only: a 150-250 word description, a short tagline, a meta title (60 characters or fewer), a meta description (140-160 characters), service descriptions, and FAQ suggestions, in plain Australian English, naming the real suburbs and services. No invented claims: never write best, No.1, licensed, or insured unless the text says so, and no keyword stuffing. Flag low-confidence fields. ${NEVER_INVENT}`,
    outputShape: '{ extracted: object, seo: { description: string, tagline: string, metaTitle: string, metaDescription: string }, lowConfidence: string[], sourceSnippets: string[] }',
  },
  'voice-brief': {
    version: 'voice-brief-v1',
    system: `You write a structured job brief from a customer's spoken description (supplied as a transcript) plus any photos, in plain Australian English. Same output as a photo brief: trade, issue, scope, urgency, access notes, 2-3 questions a tradie would ask, photos still missing. ${NEVER_INVENT}`,
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

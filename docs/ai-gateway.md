# /api/ai gateway — usage docs (D1, hackathon day 1)

One endpoint is the only path from the app to any model: `POST /api/ai`.
The browser never calls a model provider directly, and no model key ever
ships to the browser.

## Provider status: REAL PROVIDER WIRED, FLAG STILL OFF (2026-10-29)

- The real provider lives in `src/lib/ai/provider.ts` and is selected
  by the route via `selectAiProvider(process.env.MODEL_API_KEY)`:
  key present = real Meta provider, key absent = the D1 mock. The
  route's flag check still gates real users — provider selection
  alone enables nothing, and with no `config/ai` doc every feature
  still returns `{ fallback: true }`.
- The key is read as `MODEL_API_KEY` only (never `META_API_KEY`,
  which is a different tool's key). No client is constructed at
  module top level, so a missing key can never throw at import time
  and kill the App Hosting build. Missing key = mock, never a crash.
- Chat: `POST /v1/chat/completions`, Bearer key, temperature 0,
  per-feature timeout (15s default; paste-to-profile 60s — its live
  extraction + SEO reply measured 23.7s and timed out at 15s), one
  repair retry, then fallback. Strict zod schemas
  mirror the gateway's output shapes; a reply that fails validation
  throws so the gateway retries with a repair instruction.
- Vision: the same endpoint with `image_url` data URIs (JPEG from
  the browser pipeline, 1024px max). The caller supplies
  `imageDataUri` in the input; without it the call is text-only.
- SAM: `POST /v1/responses`, model `sam-3.1`, `stream: true`,
  metadata `mask_encoding: one_bit` + `include_confidence: true`.
  STREAMING IS MANDATORY — the non-streaming call returns an empty
  text lane. The streamed lane (`<Nf>id<|box;...|><|mask;...|>`) is
  parsed into the normalised 0..1 polygon shape from `mask.ts`
  (row-silhouette outline of the largest set-pixel component; the
  raster is a crop of the SAM box, mapped through the box into frame
  coords when the caller supplies `frameWidth`/`frameHeight`).
  A zero-match empty lane is a VALID empty result (`mask: null`,
  `samStatus: 'zero-match'`), never an error. SAM failure likewise
  never fails the brief — the brief is valid without a mask.
  The `~` lossless mask encoding is NOT decoded (its byte layout is
  not documented well enough to decode honestly) and yields
  `samStatus: 'unsupported-encoding'`, not a mask.
- Image: `POST /v1/images/generations`, model `muse-image-1.0`,
  1024x1024. The API returns JSON with `data[0].b64_json` whose
  bytes are WEBP, not JPEG — the mime is sniffed from the bytes and
  returned explicitly (`imageMime` + `imageDataUri`), never assumed.
- Models (Standard tier only, enforced in both gateway and
  provider): `muse-spark-1.3` (default), `muse-spark-1.2`,
  `muse-spark-1.1`, `sam-3.1`, `muse-image-1.0`,
  `muse-voice-transcribe-1.0` (allow-listed; transcription transport
  not yet built — voice features take transcripts today). Any
  `*-contributor` ID is rejected before any network call.
- Measured smoke-test costs (2026-10-28, Standard rates, test data
  only): vision brief ~$0.008, SAM $0.0025/image. Credit balance
  confirmed 2026-10-28: $149.95 remaining of the $150 credit.

## D1 status: MOCK ONLY, FLAG OFF (superseded — see above)

- There is no real API key yet. The gateway's provider is a deterministic
  mock (`mockAiProvider` in `src/lib/ai/gateway.ts`): no network call, no
  cost, no data sent anywhere. Never invent a key, never write one into
  code. The real provider plugs into the same interface later, after the
  data-retention / human-review terms are read and a Standard-tier key
  exists.
- Every feature flag defaults to OFF. With no Firestore `config/ai` doc,
  every call returns `{ fallback: true }` and the manual form is used.
  Real users see no AI behaviour from D1 at all.

## Request

```
POST /api/ai
Authorization: Bearer <Firebase ID token>
Content-Type: application/json

{ "feature": "photo-brief", "input": { "text": "..." }, "promptVersion": "photo-brief-v1" }
```

- `feature` — one of the D1 features below. Anything else is rejected
  (`400 Unknown AI feature`).
- `input` — the feature's payload (text and/or image references). Images
  must already be resized/compressed by the browser (max 1024px, ~150 KB).
  Voice features take a `transcript` string in D1 — no audio bytes are
  sent to this endpoint.
- `promptVersion` — optional; defaults to the feature's current version.
  It is part of the cache key, so a prompt change never serves a stale
  output.

## Response

Success:

```json
{ "fallback": false, "cacheHit": false, "output": { "...": "..." },
  "model": "muse-spark-1.3", "promptVersion": "photo-brief-v1",
  "safetyCardShown": false }
```

Fallback (AI off, over cap, timeout, invalid output after one repair
retry, or nothing usable left after PII stripping):

```json
{ "fallback": true, "feature": "photo-brief",
  "reason": "AI is switched off right now — the manual form still works.",
  "cacheHit": false }
```

A fallback is a normal 200 response, never an error page: the caller
shows the manual form. `safetyCardShown: true` adds the fixed safety
card (`SAFETY_CARD` in `gateway.ts`) — the card is written by us, never
by a model, and never blocks posting a job.

## Features (D1)

| Feature | Side | Model (prod) | Daily cap |
|---|---|---|---|
| `photo-brief` | C1/B1 Snap-to-Quote brief | Spark 1.3 (+ SAM 3.1 segmentation) | 5/day per customer |
| `quote-draft` | B2 quote draft, business's own prices only | Spark 1.3 | 30/day per business |
| `paste-to-profile` | B7 paste text → listing fields | Spark 1.3 | 5/day per business, 50/day per admin |
| `voice-brief` | Voice on get-quote → brief | Spark 1.3 | 5/day per customer |
| `voice-quote` | Voice on a lead → quote draft | Spark 1.3 | 30/day per business |
| `safety-check` | C3 fixed safety card (rule-based, no model call) | — | none |
| `comparison` | C4 neutral quote comparison (stretch) | Spark 1.3 | 10/day per customer (provisional) |
| `image-preview` | C5 "after" preview (stretch) | Image 1.0 | 2 per job, explicit tap only |

Not accepted in D1 (rejected as unknown until their build day):
`plain-search` (C2), `smart-reply` (B3), `review-reply` (B4),
`profile-writer` (B5), `moderation` (A1), `category-map` (A2),
`seo-draft` (A3).

## Auth, roles, and caps

- Caller authenticates with a Firebase ID token. Role comes from the
  caller's `users` doc (`admin` / `business` / anything else = customer),
  never from the request body.
- Role-gated features: `quote-draft`, `voice-quote` (business/admin);
  `paste-to-profile` (business/admin); `photo-brief`, `voice-brief`,
  `safety-check`, `comparison`, `image-preview` as tabled above. A
  caller outside the role gets a fallback, not an error.
- Over-cap requests return a fallback. Cache hits bypass the daily cap
  (they cost nothing) and are counted separately in usage.

## PII strip, cache, usage, kill switch

- **PII strip** runs before cache lookup and before any model call:
  emails, AU mobiles/landlines (+61), street number + street name, long
  digit chains, and narrow "my name is X" patterns are removed. Suburb
  text is kept. Arbitrary person names cannot be detected by pattern —
  callers must never send names. If stripping leaves nothing usable, the
  gateway falls back instead of calling with raw input.
- **Cache**: `aiCache/{sha256(feature + model + stripped input +
  promptVersion)}`, 30-day TTL, holding the validated output only.
  Never raw input, never stripped input — the key is a hash.
- **Usage**: `aiUsage/{yyyy-mm-dd}` per feature — calls, tokens, cache
  hits, failures, estimated cost. All 0 for the D1 mock.
- **Kill switch**: Firestore doc `config/ai`:
  `{ "enabled": true, "features": { "photo-brief": true } }`.
  Missing doc = everything off. Flip one flag to kill one feature
  instantly; it then falls back quietly.
- **Image-preview counter**: `aiImagePreview/{jobId}` holds a count only
  (no photo, no input, no PII), capped at 2 per job.
- **No rules change**: `aiCache`, `aiUsage`, `config/ai`, and
  `aiImagePreview` have no client match (default deny); all access is
  through the Admin SDK route.

## Rules the gateway enforces (not conventions)

- Standard tier only: the model allow-list in `gateway.ts` rejects any
  ID outside the list and any ID ending in `-contributor`.
- Per-feature timeout per attempt (15s default, 60s for
  paste-to-profile); one repair retry on invalid output;
  then fallback. The user is never blocked on AI.
- Strict output shapes (validated in `gateway.ts`; the real provider
  must mirror them with zod schemas): briefs, quote drafts (prices
  `null` + `priceMissing` when no business price list was supplied —
  never a guessed figure), paste-to-profile, comparison, image preview.
- Every output is an "AI suggestion" pre-filled into an editable form,
  never auto-sent. Quote drafts use only the business's own price list
  or past quotes.

## Enabling a feature (later days, not D1)

1. A real Standard-tier key exists and the retention terms are read.
   (Both done 2026-10-28: key wired as `MODEL_API_KEY`, terms read
   from Meta's primary documents, privacy policy updated.)
2. The real provider is wired behind the `AiProvider` interface, with
   the allow-list check intact. (Done 2026-10-29: `src/lib/ai/provider.ts`.)
3. The feature's prompts are reviewed in `src/lib/ai/prompts.ts` and its
  version bumped (which invalidates old cache entries by design).
4. The `config/ai` doc is written with `enabled: true` and that
   feature `true`. Verify with a test account and test data first.

## B1/B2 business wiring (2026-10-30, flag still OFF)

The first product surfaces on this gateway, both in the business
Leads page (`src/app/business/leads/page.tsx`) with pure helpers in
`src/lib/ai/business-ai.ts` (tests: `tests/ai-b1b2.test.mjs`):

- **B1 lead brief** (`src/components/ai/LeadAiBrief.tsx`): when a
  business opens a lead, it calls `photo-brief` with the job
  description + category + suburb only — never customer contact
  details. The gateway cache makes it once-per-job: repeat views
  are cache hits. On fallback the component renders the exact
  pre-B1 "No brief yet" placeholder, so the lead page is unchanged
  while the flag is off. A generated brief is a read-only, labelled
  "AI suggestion" card (trade, summary, scope, urgency, access
  notes, questions, missing photos), plus the fixed C3 safety card
  when the gateway flags danger words.
- **B2 quote draft** (`src/components/ai/QuoteAiDraft.tsx`): the
  quote panel's "Draft with AI" calls `quote-draft` with the job
  text, the B1 brief when present, and the business's OWN
  `servicePrices` verbatim. Prices are guarded twice: the prompt
  restricts the model to the list, and `applyQuoteDraft()` strips
  any returned price whose number is not in the business's own
  price strings (blanked + "add your price" state in the builder,
  with the removal counted and stated in the UI). Draft items
  append as editable line items; Send Quote is untouched and
  remains a human action. On fallback the box shows one quiet
  "AI draft unavailable" note and the builder works as before.

Prompts were NOT changed for B1/B2 (the v1 texts already encode
the rules), so promptVersions and existing cache entries are
untouched. To demo: write `config/ai` with `enabled: true` and
`photo-brief`/`quote-draft` true, sign in as a business test
account, open a lead (brief appears; second open is a cache hit),
then Draft with AI in the quote panel.

## B7 paste-to-profile (2026-10-30, flag still OFF)

"Build my profile from pasted text" in My listing
(`src/app/business/profile/page.tsx`, Basics tab) with the panel in
`src/components/ai/PasteToProfile.tsx` and pure helpers in
`src/lib/ai/profile-ai.ts` (tests: `tests/ai-b7.test.mjs`,
14 tests).

- **Provider reality check.** The transport already existed: the
  real provider routed `paste-to-profile` through chat with the v1
  prompt and a zod schema. The v1 contract was NOT review-ready:
  `extracted` was an unvalidated record, `sourceSnippets` was a
  flat list that could not be tied to a field, and the v1 prompt
  asked for phone/email/ABN/licence "if present" — values the
  gateway's PII strip makes impossible (see below) — while the
  appended never-invent text forbade outputting them.
- **v2 contract** (prompt `paste-to-profile-v2`; the gateway
  version table bumped to match, which invalidates v1 cache
  entries by design; provider zod schema tightened to mirror it):
  a FIXED field set tied to the editor — businessName, category,
  services, serviceAreas, openingHours (day → "HH:MM — HH:MM" or
  "Closed", only stated days), yearsInBusiness, paymentMethods,
  website, fromPrices (service → price phrase as written) — each
  as `{ value, snippet }` with the exact supporting quote, plus
  the seo block (description/tagline/metaTitle/metaDescription)
  written from the extracted facts only, a `lowConfidence` field
  list, and `removedContact`. A reply that does not match the v2
  shape fails zod, gets the one repair retry, then falls back —
  loose output never reaches the review screen.
- **Contact details are structurally unextractable.** The strip
  replaces phone/email/street-address with placeholders and digit
  chains (an ABN, most licence numbers) with `[number removed]`
  BEFORE the model sees the paste. The v2 prompt tells the model
  what the placeholders mean: never output them, never invent a
  replacement — instead list the kinds seen in `removedContact`
  (phone / email / street address / ABN / licence number). The
  review screen turns that into "add these in the form yourself"
  (phone/email in Basics, ABN/licence under Verification). A bare
  website is not stripped and IS extractable. Backstop in
  `profile-ai.ts`: any returned value containing a placeholder is
  dropped deterministically and reported, never applied.
- **Review screen.** Each field shows its editable value, its
  supporting quote, and a "Check carefully" flag when the model
  flagged the field OR the quote cannot be found verbatim
  (whitespace-insensitive) in the paste the user typed — an
  unverifiable quote is treated as unverified, not as evidence.
  Tagline/description are labelled "AI-written from your text"
  (generated copy, no quote). Ticking is explicit and conservative:
  fields whose form field already has content, low-confidence
  fields, and opening hours start unticked; an extracted category
  applies only on an exact match with a loaded Helpious category.
  Applying fills the EXISTING form state only (hours/prices merge
  over the current records); the business reviews and presses the
  existing Save. AI never saves or publishes.
- **Fallback.** Flag off / error / mock reply → one quiet note and
  the editor works exactly as before. The mock still performs no
  extraction, and the UI says so rather than presenting its empty
  shape as a real "nothing found". A real empty extraction is a
  valid result ("nothing usable found — fill the form manually").
- **Not offered by the review screen:** the seo metaTitle /
  metaDescription (the listing editor has no fields for them
  today) and the editor's highlights/why-choose/FAQ fields (not in
  the v2 extraction set). Both are recorded here rather than
  silently dropped from the output shape.

To demo: write `config/ai` with `enabled: true` and
`paste-to-profile` true, sign in as the Demo Business account,
open My listing → Basics, paste a sample business text (the test
file has one), review, apply, and Save as usual.

## Open items (D1, recorded honestly)

- NT gas/electricity utility emergency numbers are NOT in the safety
  card: no official NT numbers were verified in the prep docs, and
  inventing emergency numbers would be worse than leaving the slot
  explicit. Fill `SAFETY_CARD.utilityNumbers` from official NT utility
  sources before any UI ships the card.
  (Update 2026-10-27 D2: Power and Water emergency 1800 245 090 IS
  in the card, verified from official sources; gas still routes to
  000 with the gap stated explicitly.)
- SAM 3.1 and Muse Image 1.0 model IDs were secondary-verified in
  api-readiness.md — confirm them in the live-key smoke tests before
  any feature routes to them.
  (Update 2026-10-28: both confirmed live — SAM via streaming
  Responses API, Image returning WebP bytes. See provider section.)
- The route handler itself cannot be live-tested on this VM (no Firebase
  Admin credentials here — it honestly returns 401/503 without them).
  Its pure rules are covered by `tests/ai-gateway.test.mjs` (16 tests).
- Provider usage (tokens/cost) is NOT yet plumbed into `aiUsage` —
  the route still records 0 for tokens/estimatedCost. Wire the
  provider's usage fields through `runAiFeature` before relying on
  usage accounting for budget decisions.
- Before enabling `image-preview` for real users, the route must move
  image bytes to Storage instead of caching base64 in `aiCache`
  (a Firestore doc); the current output shape is transport-correct
  but storage-wasteful.
- The `~` lossless SAM mask encoding is not decoded (see provider
  section); if live SAM traffic returns it, masks come back null
  with `samStatus: 'unsupported-encoding'` rather than wrong.

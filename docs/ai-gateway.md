# /api/ai gateway — usage docs (D1, hackathon day 1)

One endpoint is the only path from the app to any model: `POST /api/ai`.
The browser never calls a model provider directly, and no model key ever
ships to the browser.

## D1 status: MOCK ONLY, FLAG OFF

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
- 15-second timeout per attempt; one repair retry on invalid output;
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
2. The real provider is wired behind the `AiProvider` interface, with
   the allow-list check intact.
3. The feature's prompts are reviewed in `src/lib/ai/prompts.ts` and its
  version bumped (which invalidates old cache entries by design).
4. The `config/ai` doc is written with `enabled: true` and that
   feature `true`. Verify with a test account and test data first.

## Open items (D1, recorded honestly)

- NT gas/electricity utility emergency numbers are NOT in the safety
  card: no official NT numbers were verified in the prep docs, and
  inventing emergency numbers would be worse than leaving the slot
  explicit. Fill `SAFETY_CARD.utilityNumbers` from official NT utility
  sources before any UI ships the card.
- SAM 3.1 and Muse Image 1.0 model IDs were secondary-verified in
  api-readiness.md — confirm them in the live-key smoke tests before
  any feature routes to them.
- The route handler itself cannot be live-tested on this VM (no Firebase
  Admin credentials here — it honestly returns 401/503 without them).
  Its pure rules are covered by `tests/ai-gateway.test.mjs` (16 tests).

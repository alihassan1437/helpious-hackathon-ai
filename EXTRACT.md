# What this extract is

This repository contains ONLY work built during the Meta Global AI
Developer Hackathon window (26 October – 4 November 2026, Darwin time)
for the Startup track, theme "Build for Your World".

It is a mirror of the AI surface as it exists in the host app today
(synced 30 October 2026; the round 2 sync later the same day added
B7 paste-to-profile and the per-feature timeout fix; the round 3
sync, also 30 October 2026, added voice — "Describe it by voice"
for customers and "Draft by voice" for tradies — including the
verified transcription contract described below). Paths are
preserved from the host app.

Contents:

- `src/app/api/ai/route.ts` — the single `/api/ai` server endpoint:
  Firebase-token auth, role from the users doc (never the request
  body), per-feature flags (default OFF; a missing `config/ai` doc
  means OFF), cache-before-cap, daily caps, per-job image cap, PII
  strip before cache and model, SHA-256 cache key including
  promptVersion, per-feature timeout budget (15s default;
  paste-to-profile 60s, voice features 45s — see the timeout note
  below), one repair retry, `{fallback: true}`. Voice calls are
  measured against their own larger audio cap, and only a SHA-256
  of the audio payload enters the route's cache key — recordings
  themselves are never stored.
- `src/lib/ai/gateway.ts` — the pure gateway core: feature allow-list,
  Standard-tier model allow-list (any `-contributor` ID rejected),
  PII strip, fixed C3 safety card, output validation, the per-feature
  timeout budgets (`FEATURE_TIMEOUT_MS` / `timeoutForFeature`), and
  the mock provider (kept for tests and for key-less environments).
- `src/lib/ai/provider.ts` — the REAL Meta Model API provider
  (added 28 October 2026): Spark chat + vision via
  `/v1/chat/completions`, SAM 3.1 segmentation via the streaming
  `/v1/responses` API (non-streaming returns an empty lane, so
  streaming is mandatory; a zero-match empty lane is a valid empty
  result, never an error), Muse Image via
  `/v1/images/generations` (the API returns WebP bytes; the mime is
  sniffed and returned explicitly, never assumed), and voice
  transcription via `/v1/asr/transcribe` (added 30 October 2026;
  see the voice note below). Its transport
  (`postJson`) takes a per-feature timeout from the gateway's
  `timeoutForFeature`, so the transport abort and the gateway
  budget can never disagree. Standard tier
  only, fail-closed: a `-contributor` model ID is rejected before
  any network call. The key is read from the `MODEL_API_KEY`
  environment variable only — never `META_API_KEY`, and no key value
  exists anywhere in this repo.
- `src/lib/ai/prompts.ts` — versioned prompt library (including the
  paste-to-profile v2 contract: a fixed field set, each field
  carrying the exact snippet from the business's own paste that
  supports it).
- Timeout note: the first live flag-on proof of paste-to-profile
  fell back even though the model's reply validated perfectly —
  a full extraction plus SEO copy measured 23.7s against the flat
  15s budget, and there were TWO independent 15s timers (the
  gateway wrapper and the provider's own transport abort). The fix
  gives paste-to-profile a 60s per-attempt budget in one place
  (`FEATURE_TIMEOUT_MS` in the gateway) and makes the provider
  transport use that same budget. The third proof then passed
  through the full production stack (real extraction, zero contact
  details leaked). Voice features chain two model calls
  (transcribe, then chat), so they get a 45s budget the same way.
- `src/lib/ai/business-ai.ts` — B1/B2 helpers shared by the Leads UI
  and the tests. Two honesty rules are enforced here: B1 input is
  the job's description text plus category and suburb ONLY (callers
  never pass a customer name, phone, email, or street address), and
  B2 prices come ONLY from the business's own price list — a drafted
  price that does not appear in the business's own price strings is
  stripped deterministically and flagged "add your price".
- `src/lib/ai/profile-ai.ts` — B7 paste-to-profile helpers:
  normalises the model's extraction, verifies every field's source
  snippet verbatim against the business's own paste (an unverifiable
  quote is flagged, never trusted), and deterministically drops any
  value containing a PII-strip placeholder — so a phone, email,
  ABN, or licence number can never reach the review screen, because
  the gateway strip removed them before the model ever saw the text.
- `src/lib/ai/image-pipeline.ts` — browser image pipeline for C1:
  resize to 1024px JPEG and ALWAYS re-encode, so EXIF/GPS data is
  stripped by construction; it errors rather than ever returning the
  original file. (Automatic face/plate masking is an honest stub —
  the UI says so.)
- `src/lib/ai/mask.ts` + `src/lib/ai/safety-patterns.ts` — the SAM
  mask shape/validation and the C3 safety-card patterns and fixed
  text (NT emergency numbers verified from official sources;
  mirrored copies are kept in agreement by a test).
- `src/components/ai/SnapPhotoBrief.tsx` — C1 Snap-to-Quote UI on
  the get-quote flow: photo → pipeline → "Draft description with
  AI" → an editable, apply-or-dismiss suggestion; typed text is
  never auto-overwritten, and the manual form works exactly as
  before when the gateway is off. This is the current live version,
  including the 28 October photo-size fix (preview capped at 320px
  tall, overlay hugging the displayed image).
- `src/components/ai/SamOutline.tsx` + `SafetyCard.tsx` — the mask
  outline renderer and the fixed safety card component.
- `src/components/ai/LeadAiBrief.tsx` — B1: shows the business an
  AI brief of a lead (generated once per job through the gateway;
  suburb + description only). On fallback (flag off or AI
  unavailable) it renders nothing intrusive — the lead looks
  exactly as it did before B1.
- `src/components/ai/QuoteAiDraft.tsx` — B2: a "Draft with AI"
  action in the quote builder, fed by the business's OWN price
  list. The draft fills editable line items; anything without an
  own price stays blank with an "add your price" state. AI never
  sends anything — the existing send flow is unchanged and a human
  presses send.
- `src/components/ai/PasteToProfile.tsx` — B7 paste-to-profile:
  the business pastes text about itself (from its website, Facebook
  page, or a document) and gets a per-field review screen — every
  extracted field shown with its exact supporting quote from the
  paste, low-confidence fields flagged, each field individually
  ticked before it is applied into the existing listing form.
  Nothing is applied without a tick, nothing overwrites a non-empty
  field silently, and the AI never saves or publishes — the
  business reviews, edits, and saves through the existing save
  flow. Contact details are structurally absent: the review screen
  explains that phone/email/ABN/licence were removed before the AI
  saw the text and must be entered in the form directly.
- `src/lib/ai/voice-ai.ts` — voice helpers (client-side): a
  `MediaRecorder` wrapper with a 4MB cap and ~60s guidance, data-URI
  handling, transcript helpers, and the WAV conversion —
  browsers record webm/m4a, but the transcription endpoint accepts
  WAV only, so recordings are decoded with WebAudio, resampled to
  mono 16 kHz, and re-encoded as 16-bit PCM WAV in the browser
  before upload (the WAV encoder is unit-tested). Recordings are
  never stored; the UI says so.
- `src/components/ai/VoiceBrief.tsx` — voice for customers:
  "Describe it by voice" on the get-quote flow. The transcript
  comes back into an editable box; the customer can correct it and
  re-draft, and nothing is ever auto-submitted — the normal form
  and submit are unchanged. A file-pick fallback covers browsers
  without `MediaRecorder`.
- `src/components/ai/VoiceQuote.tsx` — voice for tradies: "Draft by
  voice" on a lead. The spoken job notes are transcribed, then fed
  through the SAME B2 quote-draft path, including the unchanged
  own-prices-only guard (`applyQuoteDraft`) — a spoken price that
  is not in the business's own price list is stripped exactly like
  a typed one. AI never sends; the tradie reviews and sends.
- Voice transcription note (verified live 2026-10-30): the
  transcription contract was NOT assumed. The first version was
  built to the familiar OpenAI-style shape
  (`POST /v1/audio/transcriptions`) and failed — that path 404s on
  the Meta Model API. The real contract was taken from Meta's
  official model cookbook (`meta-models/meta-model-cookbook`,
  `06_muse_voice`): `POST /v1/asr/transcribe` as multipart form
  data with a `request` JSON part (`{mode: "PUSH_TO_TALK", model,
  audioEncoding: "WAV"}`) plus an `audio` WAV part, returning a
  flat `transcript` string; input must be mono 16-bit PCM WAV at
  16 or 24 kHz. It was verified three ways before this sync: a
  direct live API call, a unit-tested client WAV encoder, and a
  full-stack proof through the deployed `/api/ai` (synthesised
  speech in → transcript back → correct Plumber/Urgent brief out,
  in 11.3s). The provider rejects non-WAV payloads before any
  network call, and the transcript is PII-stripped before it
  reaches the brief/quote model — a spoken phone number arrives at
  the model only as `[phone removed]`. The cache stores only the
  stripped transcript, never the audio.
- Tests (no network, no real key; provider tests use an injected
  stub fetch) — six suites, 83 tests:
  - `tests/ai-gateway.test.mjs` — 17 tests, `node tests/ai-gateway.test.mjs`
  - `tests/ai-d2.test.mjs` — 6 tests, `node tests/ai-d2.test.mjs`
  - `tests/ai-b1b2.test.mjs` — 14 tests, `node tests/ai-b1b2.test.mjs`
  - `tests/ai-b7.test.mjs` — 14 tests,
    `node --import ./tests/register.mjs tests/ai-b7.test.mjs`
  - `tests/ai-provider.test.mjs` — 16 tests,
    `node --import ./tests/register.mjs tests/ai-provider.test.mjs`
    (`tests/register.mjs` + `tests/ts-resolve-loader.mjs` are the
    small Node loader that resolves the sources' extensionless
    `.ts` imports; the provider, B7 and voice tests also need the
    app's `zod` dependency present.)
  - `tests/ai-voice.test.mjs` — 16 tests,
    `node --import ./tests/register.mjs tests/ai-voice.test.mjs`
    (covers the verified `/v1/asr/transcribe` request shape, the
    WAV encoder, non-WAV rejection before any network call, the
    transcript PII strip, and the 45s voice budgets.)
- `docs/ai-gateway.md` — gateway + provider documentation,
  including measured smoke-test costs and the honest open items.

## How B1/B2, B7 and voice are wired in the host app (and why the wiring pages are not here)

`LeadAiBrief` and `QuoteAiDraft` are mounted by the host app's
business Leads page (`src/app/business/leads/page.tsx` in the host
repo). `PasteToProfile` is mounted by the host app's My listing
page (the business profile editor). `VoiceBrief` is mounted by the
host app's get-quote page, and `VoiceQuote` by the same Leads page
as B1/B2. All of those are pre-existing
marketplace pages full of non-AI
code (lead lists, filters, the quote builder itself), so they are NOT
copied here — the same treatment the `/api/ai` route's host helper
gets below. The components in this repo are the complete AI parts:
they call `/api/ai` with the caller's Firebase token, render the
brief/draft as editable suggestions, and degrade silently to the
pre-AI UI when the gateway returns `{fallback: true}`. The shared
logic they and the tests run on is `src/lib/ai/business-ai.ts`
(B1/B2) and `src/lib/ai/profile-ai.ts` (B7), which ARE included
above.

## What is NOT in this repo

The Helpious marketplace itself — the Australian tradie-quote
marketplace (business listings, search, get-quote, leads, messaging,
reviews, admin) — **pre-existed the hackathon and is NOT hackathon
work**. It lives in a separate private repository and is NOT
included here. Nothing in this repository claims pre-existing
Helpious features as hackathon-built.

Also deliberately not copied:

- Host-app pages that mount the AI components (the Leads page
  above; the My listing page that mounts `PasteToProfile`; the
  get-quote page that mounts `SnapPhotoBrief` and `VoiceBrief`).
  They are
  marketplace pages, not AI work.
- The host's Firebase/Admin helpers — the `/api/ai` route imports
  `@/lib/server-admin` for auth and Firestore. That module is host
  infrastructure and stays in the host repo.
- Any credentials, `.env` files, or service-account material
  (see Secrets).

## Standalone note (honest limitation)

This repo is the hackathon-window AI work only, not a runnable app.
The gateway core (`src/lib/ai/gateway.ts`), the B1/B2 helpers, the
B7 helpers, and
the D2 pure modules are dependency-free (node:crypto only) and are
fully runnable and tested on their own; the pure parts of
`voice-ai.ts` (WAV encoder, data-URI handling) are likewise tested
standalone, while its recorder parts need a browser; the provider needs `zod`;
the components need React (and `lucide-react`); the route shows
exactly how the host wires everything (auth, flags, caps, cache,
usage) but imports host modules that are not here.

## Secrets

No API key, token, password, private key, or `.env` file is in this
repo, and none ever will be. The real provider reads its credential
from the host app's `MODEL_API_KEY` environment variable (wired to
a secret store in the host deployment); the extract contains the
variable NAME only, never a value. Every file in this sync passed a
secrets audit (key values, bearer tokens, private keys,
service-account content, real email addresses, real phone numbers,
demo-account credentials) before it was pushed. The only addresses
and numbers present are `@example.com` / canonical fake test
fixtures in the PII-strip tests, and public emergency/utility
numbers (000; Power and Water NT 1800 245 090) in the safety card,
which are printed on the card itself by design.

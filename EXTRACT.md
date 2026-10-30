# What this extract is

This repository contains ONLY work built during the Meta Global AI
Developer Hackathon window (26 October – 4 November 2026, Darwin time)
for the Startup track, theme "Build for Your World".

It is a mirror of the AI surface as it exists in the host app today
(synced 30 October 2026; round 2 sync later the same day added B7
paste-to-profile and the per-feature timeout fix). Paths are
preserved from the host app.

Contents:

- `src/app/api/ai/route.ts` — the single `/api/ai` server endpoint:
  Firebase-token auth, role from the users doc (never the request
  body), per-feature flags (default OFF; a missing `config/ai` doc
  means OFF), cache-before-cap, daily caps, per-job image cap, PII
  strip before cache and model, SHA-256 cache key including
  promptVersion, per-feature timeout budget (15s default;
  paste-to-profile 60s — see the timeout note below), one repair
  retry, `{fallback: true}`.
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
  result, never an error), and Muse Image via
  `/v1/images/generations` (the API returns WebP bytes; the mime is
  sniffed and returned explicitly, never assumed). Its transport
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
  details leaked).
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
- Tests (no network, no real key; provider tests use an injected
  stub fetch):
  - `tests/ai-gateway.test.mjs` — 17 tests, `node tests/ai-gateway.test.mjs`
  - `tests/ai-d2.test.mjs` — 6 tests, `node tests/ai-d2.test.mjs`
  - `tests/ai-b1b2.test.mjs` — 14 tests, `node tests/ai-b1b2.test.mjs`
  - `tests/ai-b7.test.mjs` — 14 tests,
    `node --import ./tests/register.mjs tests/ai-b7.test.mjs`
  - `tests/ai-provider.test.mjs` — 16 tests,
    `node --import ./tests/register.mjs tests/ai-provider.test.mjs`
    (`tests/register.mjs` + `tests/ts-resolve-loader.mjs` are the
    small Node loader that resolves the sources' extensionless
    `.ts` imports; the provider and B7 tests also need the app's
    `zod` dependency present.)
- `docs/ai-gateway.md` — gateway + provider documentation,
  including measured smoke-test costs and the honest open items.

## How B1/B2 and B7 are wired in the host app (and why the wiring pages are not here)

`LeadAiBrief` and `QuoteAiDraft` are mounted by the host app's
business Leads page (`src/app/business/leads/page.tsx` in the host
repo). `PasteToProfile` is mounted by the host app's My listing
page (the business profile editor). Both are pre-existing
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
  get-quote page that mounts `SnapPhotoBrief`). They are
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
fully runnable and tested on their own; the provider needs `zod`;
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

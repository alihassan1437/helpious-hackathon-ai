# What this extract is

This repository contains ONLY work built during the Meta Global AI
Developer Hackathon window (26 October – 4 November 2026, Darwin time)
for the Startup track, theme "Build for Your World".

Contents (paths preserved from the host app):

- `src/app/api/ai/route.ts` — the single `/api/ai` server endpoint:
  Firebase-token auth, role from the users doc, per-feature flags
  (default OFF), cache-before-cap, daily caps, per-job image cap,
  PII strip before cache and model, SHA-256 cache key including
  promptVersion, 15s timeout, one repair retry, `{fallback:true}`.
- `src/lib/ai/gateway.ts` — the pure gateway core: D1 feature
  allow-list, Standard-tier model allow-list (any `-contributor` ID
  rejected), PII strip, fixed C3 safety card, mock provider (D1 only).
- `src/lib/ai/prompts.ts` — versioned prompt library (v1).
- `tests/ai-gateway.test.mjs` — 16 unit tests for the gateway core
  (run: `node tests/ai-gateway.test.mjs`; no dependencies, no network).
- `docs/ai-gateway.md` — gateway usage docs.

## What is NOT in this repo

The Helpious marketplace itself — the Australian tradie-quote
marketplace (business listings, search, get-quote, leads, messaging,
reviews, admin) — **pre-existed the hackathon and is NOT hackathon
work**. It lives in a separate private repository and is NOT included
here. Nothing in this repository claims pre-existing Helpious features
as hackathon-built.

## Standalone note (honest limitation)

The `/api/ai` route is written for its host Next.js app: it imports the
host's Admin-SDK helper (`@/lib/server-admin`) for auth and Firestore.
That host module is deliberately NOT copied here — this repo is the
hackathon-week AI work only, not a runnable app. The gateway core
(`src/lib/ai/gateway.ts`) is dependency-free (node:crypto only) and is
fully runnable and tested on its own; the route shows exactly how the
host wires it (auth, flags, caps, cache, usage).

## Secrets

No API key, token, password, private key, or `.env` file is in this
repo, and none ever will be. The D1 provider is a mock: no network
call, no key, zero cost. Real model credentials live only in the host
app's secret store and are never committed here.

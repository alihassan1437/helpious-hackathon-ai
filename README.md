# Helpious AI — Meta Global AI Developer Hackathon entry

Hackathon-built AI work only. Built during the hackathon window
(26 October – 4 November 2026, Darwin time) for the Meta Global AI
Developer Hackathon, Startup track, theme "Build for Your World".

## Pre-existing work disclosure (read this first)

The Helpious marketplace itself — the Australian tradie-quote
marketplace (business listings, search, get-quote, leads, messaging,
reviews, admin) — **pre-existed the hackathon** and is NOT hackathon
work. It lives in a separate private repository and is not included
here. Nothing in this repository claims pre-existing Helpious
features as hackathon-built.

What IS in this repository is only what was built inside the
hackathon window: the `/api/ai` gateway and the AI features built on
it — Snap-to-Quote photo briefs, the fixed safety card, lead briefs,
quote drafts from a business's own prices, paste-to-profile, voice
descriptions, quote comparison, and "after" previews — plus the
prompt library, eval set, and demo story that exercise them.

Every commit in this repository is dated inside the hackathon
window. The live demo runs against the pre-existing marketplace with
these AI features behind feature flags; the demo highlights only
hackathon-built features.

## Status

D1 (27 October 2026): gateway skeleton with a mock provider and all
feature flags OFF. No real model key is included in, or needed by,
this repository — see the gateway docs in the workdir.

Final status (2 November 2026): the gateway runs the real Meta
Model API provider (Standard tier only), and the planned features —
Snap-to-Quote, the fixed safety card, lead briefs, quote drafts
from a business's own prices, paste-to-profile, and voice for
customers and tradies — are built, unit-tested (six suites, 102
tests) and proven live behind feature flags in the host app. The
full 112-case evaluation was re-run against the fixed build on
2 November 2026 and passed its gate (trade accuracy 94/100,
safety-card recall 6/6, zero PII leaks, zero invented details);
the one internal latency target it still misses is recorded
honestly in EXTRACT.md. See EXTRACT.md for the full contents,
the sync history, and what is deliberately not in this repo.

## Secrets

This repository must never contain API keys, tokens, passwords,
private keys, or `.env` contents. See `.gitignore`.

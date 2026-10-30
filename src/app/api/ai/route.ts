// POST /api/ai — the ONLY path from the app to any model (D1 gateway).
//
//   1. Auth: Bearer <Firebase ID token>, verified via the Admin SDK.
//      The caller's uid and role come from the token + users doc,
//      NEVER from the request body.
//   2. Feature flag: the Firestore config/ai doc holds one on/off flag
//      per feature plus a global enabled switch. Missing doc, or any
//      flag off, means the feature quietly falls back to manual.
//      DEFAULT IS OFF — D1 ships with no config doc, so every feature
//      returns { fallback: true } for real users until a later day
//      deliberately enables one.
//   3. Cache: aiCache/{sha256(feature + model + stripped input +
//      promptVersion)}, 30-day TTL, holding the VALIDATED OUTPUT ONLY
//      (never raw input, never stripped input — the key is a hash).
//      A cache hit costs nothing and does NOT count against the
//      daily cap, so a hit is checked before the cap.
//   4. Daily caps (aiUsage/{yyyy-mm-dd} per feature): over cap returns
//      a fallback, never an error page — the manual form still works.
//   5. Model call: via gateway.ts runAiFeature (PII strip before cache
//      and model, 15s timeout, one repair retry, then fallback).
//      Provider selection lives in src/lib/ai/provider.ts:
//      MODEL_API_KEY present = real Meta provider (Standard tier
//      only), absent = the D1 mock. The flag check above still
//      gates real users — provider selection alone enables nothing.
//   6. Usage: one increment per call into aiUsage (calls, cache
//      hits, failures). Token/cost accounting from real provider
//      usage fields is NOT yet plumbed — estimatedCost/tokens stay 0
//      until that lands (open item in docs/ai-gateway.md).
//
// Per-feature kill switch: flip one flag in config/ai and that feature
// falls back instantly; a daily budget cap is enforced the same way
// (over-cap = fallback). No Firestore rules change: aiCache, aiUsage,
// config/ai, and aiImagePreview have no client match (default deny),
// so every read/write here goes through the Admin SDK.
//
// This route NEVER touches get-quote UI, Leads, or My listing — it is
// gateway + AI modules only. No signups, no posting, no live writes
// outside the ai* docs listed above. The real provider reads
// process.env.MODEL_API_KEY (never META_API_KEY) via
// selectAiProvider(); with no key the mock provider stays, and the
// flag check above still returns fallback for real users either way.

import { NextResponse } from 'next/server';
import { createHash } from 'node:crypto';
import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import { z } from 'zod';
import { getAdminDb, verifyUserRequest } from '@/lib/server-admin';
import { selectAiProvider } from '@/lib/ai/provider';
import {
  aiCacheKey,
  aiFallback,
  detectSafety,
  dailyCapFor,
  FEATURE_MODEL,
  FEATURE_PROMPT_VERSION,
  FEATURE_ROLES,
  isAiFeature,
  isStandardModel,
  runAiFeature,
  stripPiiDeep,
  SAFETY_CARD,
  type AiFeature,
  type AiRole,
} from '@/lib/ai/gateway';

const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days.
const MAX_INPUT_JSON_CHARS = 50_000; // Paste inputs are capped ~15k in the browser; this is a server backstop.
const MAX_AUDIO_DATA_URI_CHARS = 6_000_000; // A 4 MB recording is ~5.6M base64 chars; the UI caps recordings at 4 MB.
const IMAGE_PREVIEWS_PER_JOB = 2;

const bodySchema = z.object({
  feature: z.string().min(1).max(100),
  input: z.unknown(),
  promptVersion: z.string().min(1).max(100).optional(),
});

function userError(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

function fallbackResponse(feature: AiFeature, reason: string, safetyCardShown: boolean) {
  return NextResponse.json({
    ...aiFallback(feature, reason, safetyCardShown),
    cacheHit: false,
  });
}

type AiConfigDoc = {
  enabled?: boolean;
  features?: Record<string, boolean>;
};

async function readAiConfig(
  db: Firestore,
): Promise<AiConfigDoc | null> {
  try {
    const snap = await db.collection('config').doc('ai').get();
    return snap.exists ? (snap.data() as AiConfigDoc) : null;
  } catch {
    return null;
  }
}

async function bumpUsage(
  db: Firestore,
  dateKey: string,
  feature: AiFeature,
  delta: { calls?: number; cacheHits?: number; failures?: number },
) {
  const update: Record<string, unknown> = {};
  if (delta.calls) update[`${feature}.calls`] = FieldValue.increment(delta.calls);
  if (delta.cacheHits) update[`${feature}.cacheHits`] = FieldValue.increment(delta.cacheHits);
  if (delta.failures) update[`${feature}.failures`] = FieldValue.increment(delta.failures);
  // Token/cost accounting from real provider usage fields is NOT yet
  // plumbed (open item) — estimatedCost/tokens stay 0 for now.
  update[`${feature}.estimatedCost`] = FieldValue.increment(0);
  update[`${feature}.tokens`] = FieldValue.increment(0);
  try {
    await db.collection('aiUsage').doc(dateKey).set(update, { merge: true });
  } catch {
    // Usage accounting must never fail the user's request.
  }
}

export async function POST(req: Request) {
  // 1. Auth — token only. No token, or Admin unavailable, = 401/503, honest.
  const uid = await verifyUserRequest(req);
  if (!uid) return userError('Sign-in required.', 401);
  const db = getAdminDb();
  if (!db) return userError('AI service is unavailable right now.', 503);

  let body: z.infer<typeof bodySchema>;
  try {
    body = bodySchema.parse(await req.json());
  } catch {
    return userError('Invalid request body.');
  }
  if (!isAiFeature(body.feature)) {
    return userError('Unknown AI feature.');
  }
  const feature: AiFeature = body.feature;
  const promptVersion = body.promptVersion ?? FEATURE_PROMPT_VERSION[feature];
  const model = FEATURE_MODEL[feature];
  if (!isStandardModel(model)) {
    // Fails closed: the allow-list is enforced in the route too, not
    // only inside gateway.ts.
    return fallbackResponse(feature, 'AI is unavailable right now — the manual form still works.', false);
  }

  // Role from the users doc, never the body.
  let role: AiRole = 'customer';
  try {
    const userSnap = await db.collection('users').doc(uid).get();
    const userRole = userSnap.data()?.role;
    if (userRole === 'admin') role = 'admin';
    else if (userRole === 'business') role = 'business';
  } catch {
    // A users-doc read failure keeps the caller a customer (least
    // privilege); business-only features then fall back below.
  }

  // PII strip BEFORE cache lookup and before any model call. The raw
  // input is never stored, never cached, never sent anywhere.
  //
  // Voice features may carry a recording as an audioDataUri string.
  // Base64 of a 4 MB clip is ~5.6M chars — over the JSON cap above by
  // design — so the recording is measured against its own cap, and
  // the cache key / safety scan use a SHA-256 of it in place of the
  // payload (the payload itself is never stored; the gateway lifts
  // it past the PII strip untouched and the provider transcribes
  // it). Everything else about this block is unchanged.
  let stripSource: unknown = body.input;
  if (
    (feature === 'voice-brief' || feature === 'voice-quote') &&
    body.input !== null &&
    typeof body.input === 'object' &&
    !Array.isArray(body.input) &&
    typeof (body.input as Record<string, unknown>).audioDataUri === 'string'
  ) {
    const record = body.input as Record<string, unknown>;
    const audioDataUri = record.audioDataUri as string;
    if (audioDataUri.length > MAX_AUDIO_DATA_URI_CHARS) {
      return userError('Recording is too large.');
    }
    const rest: Record<string, unknown> = { ...record };
    delete rest.audioDataUri;
    stripSource = {
      ...rest,
      audioSha256: createHash('sha256').update(audioDataUri, 'utf8').digest('hex'),
    };
  }
  const strippedInput = stripPiiDeep(stripSource);
  if (JSON.stringify(strippedInput).length > MAX_INPUT_JSON_CHARS) {
    return userError('Input is too large.');
  }
  const safetyCardShown = detectSafety(JSON.stringify(strippedInput));

  // Role gate — FEATURE_ROLES is the allow-list (parent fix on D1
  // verification: the table existed but the route never checked it,
  // so an unlisted role would also have skipped the daily cap).
  // Must run before the flag check: a disallowed role falls back
  // even if the feature is on.
  if (!FEATURE_ROLES[feature].includes(role)) {
    return fallbackResponse(feature, 'AI is not available for your account — the manual form still works.', safetyCardShown);
  }
  const cacheKey = aiCacheKey(feature, model, strippedInput, promptVersion);

  // 2. Feature flag — missing doc or flag off = fallback (default OFF).
  const config = await readAiConfig(db);
  const enabled = config?.enabled === true && config?.features?.[feature] === true;
  if (!enabled) {
    return fallbackResponse(feature, 'AI is switched off right now — the manual form still works.', safetyCardShown);
  }

  // 3. Cache — a hit costs nothing and bypasses the daily cap.
  try {
    const cached = await db.collection('aiCache').doc(cacheKey).get();
    if (cached.exists) {
      const data = cached.data() ?? {};
      const expiresAt = typeof data.expiresAtMs === 'number' ? data.expiresAtMs : 0;
      if (expiresAt > Date.now() && data.output && typeof data.output === 'object') {
        const dateKey = new Date().toISOString().slice(0, 10);
        await bumpUsage(db, dateKey, feature, { cacheHits: 1 });
        return NextResponse.json({
          fallback: false,
          cacheHit: true,
          output: data.output,
          model,
          promptVersion,
          safetyCardShown,
          ...(safetyCardShown ? { safetyCard: SAFETY_CARD } : {}),
        });
      }
    }
  } catch {
    // A cache read failure is not a user failure: fall through to cap + model.
  }

  // Image-preview per-job cap (max 2 per job, explicit tap only in the UI).
  // The counter doc holds a count only — no photo, no input, no PII.
  let imageJobId: string | null = null;
  if (feature === 'image-preview') {
    const inputRecord =
      strippedInput !== null && typeof strippedInput === 'object' && !Array.isArray(strippedInput)
        ? (strippedInput as Record<string, unknown>)
        : {};
    imageJobId = typeof inputRecord.jobId === 'string' && inputRecord.jobId.length > 0 ? inputRecord.jobId : null;
    if (!imageJobId) return userError('Image preview requires a jobId.');
    try {
      const counter = await db.collection('aiImagePreview').doc(imageJobId).get();
      const used = typeof counter.data()?.count === 'number' ? (counter.data()?.count as number) : 0;
      if (used >= IMAGE_PREVIEWS_PER_JOB) {
        return fallbackResponse(feature, 'Image preview limit reached for this job.', safetyCardShown);
      }
    } catch {
      // Counter read failure fails closed for this capped feature.
      return fallbackResponse(feature, 'Image preview is unavailable right now.', safetyCardShown);
    }
  }

  // 4. Daily cap — over cap = fallback, never an error page.
  const dateKey = new Date().toISOString().slice(0, 10);
  const cap = dailyCapFor(feature, role);
  if (cap !== null) {
    try {
      const usageSnap = await db.collection('aiUsage').doc(dateKey).get();
      const used = usageSnap.data()?.[feature];
      const calls = used && typeof used === 'object' && typeof (used as Record<string, unknown>).calls === 'number'
        ? ((used as Record<string, unknown>).calls as number)
        : 0;
      if (calls >= cap) {
        return fallbackResponse(feature, 'Daily AI limit reached — the manual form still works.', safetyCardShown);
      }
    } catch {
      // Usage read failure fails closed: without a trustworthy count,
      // do not spend model budget blindly.
      return fallbackResponse(feature, 'AI is unavailable right now — the manual form still works.', safetyCardShown);
    }
  }

  // 5. Model call with timeout + one repair retry, then fallback.
  // Provider: real Meta provider when MODEL_API_KEY is present, the
  // D1 mock otherwise. The flag check above already gated real users.
  const result = await runAiFeature({
    feature,
    input: body.input,
    promptVersion,
    provider: selectAiProvider(process.env.MODEL_API_KEY),
  });
  if (result.fallback || !result.output) {
    await bumpUsage(db, dateKey, feature, { failures: 1 });
    return NextResponse.json({ ...result.fallback, cacheHit: false });
  }

  // 6. Store validated output only (never raw or stripped input), then count the call.
  try {
    await db
      .collection('aiCache')
      .doc(cacheKey)
      .set({
        output: result.output,
        feature,
        model,
        promptVersion,
        expiresAtMs: Date.now() + CACHE_TTL_MS,
      });
  } catch {
    // Cache write failure does not fail the response the user already has.
  }
  if (feature === 'image-preview' && imageJobId) {
    try {
      await db.collection('aiImagePreview').doc(imageJobId).set(
        { count: FieldValue.increment(1) },
        { merge: true },
      );
    } catch {
      // Counter failure does not fail the response.
    }
  }
  await bumpUsage(db, dateKey, feature, { calls: 1 });

  return NextResponse.json({
    fallback: false,
    cacheHit: false,
    output: result.output,
    model,
    promptVersion,
    safetyCardShown: result.safetyCardShown,
    ...(result.safetyCardShown ? { safetyCard: SAFETY_CARD } : {}),
  });
}

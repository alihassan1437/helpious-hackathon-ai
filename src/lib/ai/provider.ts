// Real Meta Model API provider for the /api/ai gateway.
//
// SERVER ONLY — never import from browser code. This module reads
// process.env.MODEL_API_KEY (never META_API_KEY — that is a different
// key for a different tool) and talks to https://api.meta.ai/v1.
// There is NO top-level client construction: the provider is built by
// createMetaProvider() inside the route handler, so a missing key can
// never throw at import time and kill the App Hosting build (a
// top-level SDK constructor that throws on missing env killed builds
// before — see the project lessons).
//
// The gateway (gateway.ts) still owns auth, kill-switch, cache, caps,
// and PII strip. This module only does transport + parsing:
//   - Chat (text + vision): POST /v1/chat/completions.
//   - SAM segmentation: POST /v1/responses, stream:true. STREAMING IS
//     MANDATORY — the non-streaming call returns an empty text lane,
//     so a non-streaming SAM call is a guaranteed empty result, not a
//     fallback-worthy error. A zero-match empty lane is a VALID
//     empty result (mask null), never an error.
//   - Image: POST /v1/images/generations. The API returns JSON with
//     data[0].b64_json whose bytes are WEBP, not JPEG — the mime is
//     sniffed from the bytes and returned explicitly, never assumed.
//
// Standard tier ONLY: every call checks isStandardModel() and fails
// closed on any Contributor ID (the route checks too). Missing key
// yields the mock provider via selectAiProvider(), never a crash.
//
// SAM mask format: the streamed lane is parsed into the normalised
// 0..1 polygon shape from mask.ts (polygons of 3+ points, max 50
// polygons). The raster from a one_bit mask is a crop of the SAM box,
// NOT the full frame, so raster coords are mapped through the box
// into frame coords when the caller supplies frameWidth/frameHeight;
// without them the polygon is raster-relative (whole-photo coords).
// The emitted polygon is the row-silhouette outline of the largest
// set-pixel component — an honest outline of the segmented region,
// not a pixel-perfect contour trace.

import { z } from 'zod';
import { getPrompt } from './prompts';
import {
  isStandardModel,
  mockAiProvider,
  type AiFeature,
  type AiProvider,
} from './gateway';

export const META_API_BASE = 'https://api.meta.ai/v1';
export const PROVIDER_TIMEOUT_MS = 15_000;
export const MAX_SAM_RASTER_PIXELS = 4_000_000;
export const MAX_SAM_POLYGON_POINTS = 500;

// ---------------------------------------------------------------------------
// Minimal fetch surface (lets tests inject canned responses; the real
// Next route passes the global fetch, which satisfies this shape).
// ---------------------------------------------------------------------------

export interface MetaFetchResponse {
  ok: boolean;
  status: number;
  headers?: { get: (name: string) => string | null };
  json?: () => Promise<unknown>;
  text?: () => Promise<string>;
  arrayBuffer?: () => Promise<ArrayBuffer>;
  body?: { getReader: () => { read: () => Promise<{ done: boolean; value?: Uint8Array }> } } | null;
}

export type MetaFetch = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal: AbortSignal;
  },
) => Promise<MetaFetchResponse>;

// ---------------------------------------------------------------------------
// Base85 (RFC 1924 alphabet, as used by Python's base64.b85encode —
// the alphabet Meta's SAM payloads decode with).
// ---------------------------------------------------------------------------

const B85_ALPHABET =
  '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz!#$%&()*+-;<=>?@^_`{|}~';
const B85_VALUES = new Map<string, number>(
  B85_ALPHABET.split('').map((ch, i) => [ch, i]),
);

export function decodeBase85(input: string): Uint8Array {
  // Padding rule (Python b85decode): a final short group is padded
  // with '~' (the last alphabet char) to 5 chars, decoded, and the
  // padding bytes are dropped (a group of n chars yields n-1 bytes).
  const out: number[] = [];
  for (let i = 0; i < input.length; i += 5) {
    const group = input.slice(i, i + 5);
    const padded = group.length < 5 ? group + '~'.repeat(5 - group.length) : group;
    let acc = 0;
    for (const ch of padded) {
      const v = B85_VALUES.get(ch);
      if (v === undefined) throw new Error('Invalid base85 character in SAM mask payload.');
      acc = acc * 85 + v;
    }
    const bytes = [
      (acc >>> 24) & 0xff,
      (acc >>> 16) & 0xff,
      (acc >>> 8) & 0xff,
      acc & 0xff,
    ];
    const take = group.length === 5 ? 4 : group.length - 1;
    for (let j = 0; j < take; j++) out.push(bytes[j] as number);
  }
  return new Uint8Array(out);
}

// ---------------------------------------------------------------------------
// Image mime sniffing — never assume JPEG. WebP is what the image API
// actually returns (RIFF....WEBP magic).
// ---------------------------------------------------------------------------

export function sniffImageMime(bytes: Uint8Array): string | null {
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && // R
    bytes[1] === 0x49 && // I
    bytes[2] === 0x46 && // F
    bytes[3] === 0x46 && // F
    bytes[8] === 0x57 && // W
    bytes[9] === 0x45 && // E
    bytes[10] === 0x42 && // B
    bytes[11] === 0x50 // P
  ) {
    return 'image/webp';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 && // P
    bytes[2] === 0x4e && // N
    bytes[3] === 0x47 // G
  ) {
    return 'image/png';
  }
  return null;
}

// ---------------------------------------------------------------------------
// SAM lane parsing
// ---------------------------------------------------------------------------

export interface SamBox {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface SamPoint {
  x: number;
  y: number;
}

export type SamStatus =
  | 'ok'
  | 'zero-match' // Empty lane: valid, no object matched the prompt.
  | 'no-mask' // Lane present but no mask segment.
  | 'unsupported-encoding' // '~' lossless or unknown marker: not decoded.
  | 'degenerate'; // Mask decoded but no usable polygon survived.

export interface ParsedSamLane {
  status: SamStatus;
  /** Normalised 0..1 polygons, or null when status is not 'ok'. */
  polygons: SamPoint[][] | null;
  box: SamBox | null;
  confidence: number | null;
}

function parseKeyValues(segment: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of segment.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0) out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return out;
}

function parseNumber(value: string | undefined): number | null {
  if (value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Largest 4-connected set-pixel component (flood fill, iterative). */
function largestComponent(raster: Uint8Array, width: number, height: number): Uint8Array {
  const seen = new Uint8Array(raster.length);
  const keep = new Uint8Array(raster.length);
  let best: number[] = [];
  const stack: number[] = [];
  for (let start = 0; start < raster.length; start++) {
    if (raster[start] !== 1 || seen[start] === 1) continue;
    const component: number[] = [];
    stack.push(start);
    seen[start] = 1;
    while (stack.length > 0) {
      const idx = stack.pop() as number;
      component.push(idx);
      const x = idx % width;
      const y = Math.floor(idx / width);
      const neighbours = [
        x > 0 ? idx - 1 : -1,
        x < width - 1 ? idx + 1 : -1,
        y > 0 ? idx - width : -1,
        y < height - 1 ? idx + width : -1,
      ];
      for (const n of neighbours) {
        if (n >= 0 && raster[n] === 1 && seen[n] !== 1) {
          seen[n] = 1;
          stack.push(n);
        }
      }
    }
    if (component.length > best.length) best = component;
  }
  for (const idx of best) keep[idx] = 1;
  return keep;
}

/**
 * Row-silhouette outline of the component: left edge top-to-bottom,
 * right edge bottom-to-top, in pixel-corner coords, mapped to
 * normalised frame coords (via box + frame dims when supplied, else
 * raster-relative). Collinear points are removed and the point count
 * is capped so a bad payload cannot flood the DOM.
 */
function silhouettePolygons(
  component: Uint8Array,
  rasterWidth: number,
  rasterHeight: number,
  box: SamBox | null,
  frameWidth: number | null,
  frameHeight: number | null,
): SamPoint[][] {
  const rows: { row: number; minCol: number; maxCol: number }[] = [];
  for (let r = 0; r < rasterHeight; r++) {
    let minCol = -1;
    let maxCol = -1;
    for (let c = 0; c < rasterWidth; c++) {
      if (component[r * rasterWidth + c] === 1) {
        if (minCol < 0) minCol = c;
        maxCol = c;
      }
    }
    if (minCol >= 0) rows.push({ row: r, minCol, maxCol });
  }
  if (rows.length === 0) return [];
  const corners: { px: number; py: number }[] = [];
  for (const { row, minCol } of rows) corners.push({ px: minCol, py: row });
  const lastRow = rows[rows.length - 1] as { row: number; minCol: number; maxCol: number };
  corners.push({ px: lastRow.minCol, py: lastRow.row + 1 });
  for (let i = rows.length - 1; i >= 0; i--) {
    const { row, maxCol } = rows[i] as { row: number; minCol: number; maxCol: number };
    corners.push({ px: maxCol + 1, py: row + 1 });
  }
  const firstRow = rows[0] as { row: number; minCol: number; maxCol: number };
  corners.push({ px: firstRow.maxCol + 1, py: firstRow.row });

  const mapX = (px: number): number => {
    if (box && frameWidth && frameWidth > 0) {
      return (box.x1 + (px / rasterWidth) * (box.x2 - box.x1)) / frameWidth;
    }
    return px / rasterWidth;
  };
  const mapY = (py: number): number => {
    if (box && frameHeight && frameHeight > 0) {
      return (box.y1 + (py / rasterHeight) * (box.y2 - box.y1)) / frameHeight;
    }
    return py / rasterHeight;
  };
  const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));
  let points: SamPoint[] = corners.map((c) => ({ x: clamp01(mapX(c.px)), y: clamp01(mapY(c.py)) }));
  // Collinear removal (exact on axis-aligned edges, epsilon elsewhere).
  const cleaned: SamPoint[] = [];
  for (let i = 0; i < points.length; i++) {
    const prev = points[(i - 1 + points.length) % points.length] as SamPoint;
    const cur = points[i] as SamPoint;
    const next = points[(i + 1) % points.length] as SamPoint;
    const cross = (cur.x - prev.x) * (next.y - cur.y) - (cur.y - prev.y) * (next.x - cur.x);
    if (Math.abs(cross) > 1e-9) cleaned.push(cur);
  }
  points = cleaned.length >= 3 ? cleaned : points;
  // Stride decimation if still huge (keeps first/last).
  if (points.length > MAX_SAM_POLYGON_POINTS) {
    const stride = Math.ceil(points.length / MAX_SAM_POLYGON_POINTS);
    points = points.filter((_, i) => i % stride === 0 || i === points.length - 1);
  }
  if (points.length < 3) return [];
  if (!points.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))) return [];
  return [points];
}

/**
 * Parse one SAM output-text lane into the mask.ts polygon shape.
 * Lane format (verified in smoke test 4): a frame line
 * `<Nf>id<|box;...|><|mask;...;data=H,W,payload|>` where payload is a
 * base85 bitmap prefixed '!' (one_bit) or '~' (lossless).
 * frameWidth/frameHeight are the pixel dims of the photo sent to SAM.
 */
export function parseSamLane(
  lane: string,
  frameWidth?: number | null,
  frameHeight?: number | null,
): ParsedSamLane {
  const text = lane.trim();
  if (text === '') return { status: 'zero-match', polygons: null, box: null, confidence: null };

  const boxMatch = text.match(/<\|box;([^|]*)\|>/);
  const maskMatch = text.match(/<\|mask;([^|]*)\|>/);
  let box: SamBox | null = null;
  let confidence: number | null = null;
  if (boxMatch) {
    const fields = parseKeyValues(boxMatch[1] as string);
    const x1 = parseNumber(fields['x1']);
    const y1 = parseNumber(fields['y1']);
    const x2 = parseNumber(fields['x2']);
    const y2 = parseNumber(fields['y2']);
    if (x1 !== null && y1 !== null && x2 !== null && y2 !== null) {
      box = { x1, y1, x2, y2 };
    }
    confidence = parseNumber(fields['confidence']);
  }
  if (!maskMatch) return { status: 'no-mask', polygons: null, box, confidence };

  const maskFields = parseKeyValues(maskMatch[1] as string);
  const dataValue = maskFields['data'];
  if (dataValue === undefined) return { status: 'no-mask', polygons: null, box, confidence };
  if (confidence === null) confidence = parseNumber(maskFields['confidence']);

  const parts = dataValue.split(',');
  const height = parseNumber(parts[0]);
  const width = parseNumber(parts[1]);
  const payload = parts.slice(2).join(',');
  if (height === null || width === null || height <= 0 || width <= 0 || payload === '') {
    return { status: 'no-mask', polygons: null, box, confidence };
  }
  if (height * width > MAX_SAM_RASTER_PIXELS) {
    return { status: 'degenerate', polygons: null, box, confidence };
  }
  const marker = payload[0] as string;
  if (marker !== '!') {
    // '~' lossless layout is not documented well enough to decode
    // honestly; anything else is unknown. No mask, never an error.
    return { status: 'unsupported-encoding', polygons: null, box, confidence };
  }
  let decoded: Uint8Array;
  try {
    decoded = decodeBase85(payload.slice(1));
  } catch {
    return { status: 'degenerate', polygons: null, box, confidence };
  }
  const neededBytes = Math.ceil((height * width) / 8);
  if (decoded.length < neededBytes) {
    return { status: 'degenerate', polygons: null, box, confidence };
  }
  const raster = new Uint8Array(height * width);
  for (let k = 0; k < height * width; k++) {
    const byte = decoded[Math.floor(k / 8)] as number;
    raster[k] = (byte >> (7 - (k % 8))) & 1;
  }
  const component = largestComponent(raster, width, height);
  const polygons = silhouettePolygons(
    component,
    width,
    height,
    box,
    frameWidth ?? null,
    frameHeight ?? null,
  );
  if (polygons.length === 0) return { status: 'degenerate', polygons: null, box, confidence };
  return { status: 'ok', polygons, box, confidence };
}

// ---------------------------------------------------------------------------
// Chat JSON — strict zod schemas mirroring gateway.ts isValidAiOutput.
// A parse failure throws so the gateway retries once with repair.
// ---------------------------------------------------------------------------

const briefSchema = z.object({
  trade: z.string(),
  issue: z.string(),
  scope: z.string(),
  urgency: z.enum(['Emergency', 'Urgent', 'Routine']),
  accessNotes: z.string(),
  questions: z.array(z.string()),
  missingPhotos: z.array(z.string()),
});

const quoteSchema = z.object({
  lineItems: z.array(
    z.object({
      description: z.string(),
      price: z.number().nullable(),
      priceMissing: z.boolean(),
    }),
  ),
  total: z.number().nullable(),
  notes: z.string(),
});

const pasteSchema = z.object({
  extracted: z.record(z.unknown()),
  seo: z.object({
    description: z.string(),
    tagline: z.string(),
    metaTitle: z.string(),
    metaDescription: z.string(),
  }),
  lowConfidence: z.array(z.string()),
  sourceSnippets: z.array(z.string()),
});

const comparisonSchema = z.object({
  summaries: z.array(z.string()),
  missing: z.array(z.string()),
  questions: z.array(z.string()),
});

type ChatSchema = z.ZodType<Record<string, unknown>>;

const CHAT_SCHEMAS: Partial<Record<AiFeature, ChatSchema>> = {
  'photo-brief': briefSchema,
  'voice-brief': briefSchema,
  'quote-draft': quoteSchema,
  'voice-quote': quoteSchema,
  'paste-to-profile': pasteSchema,
  comparison: comparisonSchema,
};

function extractJson(text: string): unknown {
  let t = text.trim();
  const fence = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence && fence[1] !== undefined) t = fence[1].trim();
  try {
    return JSON.parse(t);
  } catch {
    const start = t.indexOf('{');
    const end = t.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(t.slice(start, end + 1));
    throw new Error('Model reply was not JSON.');
  }
}

function inputText(input: unknown): string {
  if (typeof input === 'string') return input;
  if (input !== null && typeof input === 'object') {
    const record = input as Record<string, unknown>;
    for (const key of ['text', 'transcript', 'brief', 'description']) {
      if (typeof record[key] === 'string' && (record[key] as string).length > 0) {
        return record[key] as string;
      }
    }
    return JSON.stringify(input);
  }
  return '';
}

function inputImageDataUri(input: unknown): string | null {
  if (input !== null && typeof input === 'object') {
    const uri = (input as Record<string, unknown>)['imageDataUri'];
    if (typeof uri === 'string' && uri.startsWith('data:image/')) return uri;
  }
  return null;
}

function inputStringField(input: unknown, key: string): string | null {
  if (input !== null && typeof input === 'object') {
    const value = (input as Record<string, unknown>)[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

function inputNumberField(input: unknown, key: string): number | null {
  if (input !== null && typeof input === 'object') {
    const value = (input as Record<string, unknown>)[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

async function postJson(
  fetchImpl: MetaFetch,
  apiKey: string,
  path: string,
  body: Record<string, unknown>,
  accept = 'application/json',
): Promise<MetaFetchResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);
  try {
    const res = await fetchImpl(META_API_BASE + path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: accept,
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`Meta API ${path} failed with HTTP ${res.status}.`);
    return res;
  } finally {
    clearTimeout(timer);
  }
}

async function readSseLane(res: MetaFetchResponse): Promise<string> {
  const body = res.body;
  if (body && typeof body.getReader === 'function') {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let lane = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (value) buffer += decoder.decode(value, { stream: true });
      if (done) break;
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        lane += sseDataLine(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');
      }
    }
    if (buffer.length > 0) lane += sseDataLine(buffer);
    return lane;
  }
  if (typeof res.text === 'function') {
    const full = await res.text();
    let lane = '';
    for (const line of full.split('\n')) lane += sseDataLine(line);
    return lane;
  }
  throw new Error('SAM streaming response could not be read.');
}

function sseDataLine(line: string): string {
  const trimmed = line.trim();
  if (!trimmed.startsWith('data:')) return '';
  const payload = trimmed.slice(5).trim();
  if (payload === '[DONE]') return '';
  try {
    const event = JSON.parse(payload) as { type?: unknown; delta?: unknown; text?: unknown };
    if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') {
      return event.delta;
    }
    if (event.type === 'response.output_text.done' && typeof event.text === 'string') {
      return event.text;
    }
  } catch {
    // A non-JSON SSE line is not lane content; skip it.
  }
  return '';
}

async function callChat(
  fetchImpl: MetaFetch,
  apiKey: string,
  feature: AiFeature,
  model: string,
  input: unknown,
  repair: boolean,
): Promise<Record<string, unknown>> {
  const prompt = getPrompt(feature);
  const system =
    prompt.system +
    `\nReply with JSON only, matching this shape: ${prompt.outputShape}` +
    (repair
      ? '\nYour previous reply did not match the required JSON shape. Reply with JSON only, exactly matching the shape, no other text.'
      : '');
  const text = inputText(input);
  const imageUri = inputImageDataUri(input);
  const userContent: unknown = imageUri
    ? [
        { type: 'text', text },
        { type: 'image_url', image_url: { url: imageUri } },
      ]
    : text;
  const res = await postJson(fetchImpl, apiKey, '/chat/completions', {
    model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: userContent },
    ],
    temperature: 0,
  });
  if (typeof res.json !== 'function') throw new Error('Chat response could not be read.');
  const data = (await res.json()) as {
    choices?: { message?: { content?: unknown } }[];
  };
  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== 'string') throw new Error('Chat response had no text content.');
  const parsed = extractJson(content);
  const schema = CHAT_SCHEMAS[feature];
  if (!schema) throw new Error(`No chat schema for feature: ${feature}`);
  const validated = schema.safeParse(parsed);
  if (!validated.success) throw new Error('Model reply did not match the required shape.');
  return validated.data as Record<string, unknown>;
}

async function callImage(
  fetchImpl: MetaFetch,
  apiKey: string,
  input: unknown,
): Promise<Record<string, unknown>> {
  const prompt = inputText(input);
  if (prompt.length === 0) throw new Error('Image preview requires a prompt.');
  const res = await postJson(fetchImpl, apiKey, '/images/generations', {
    model: 'muse-image-1.0',
    prompt,
    size: '1024x1024',
  });
  const contentType = res.headers?.get('content-type') ?? '';
  // Defensive path first: raw image bytes (content-type image/*).
  if (contentType.includes('image/') && typeof res.arrayBuffer === 'function') {
    const bytes = new Uint8Array(await res.arrayBuffer());
    const mime = sniffImageMime(bytes);
    if (!mime) throw new Error('Image response was not a recognised image format.');
    let binary = '';
    for (const b of bytes) binary += String.fromCharCode(b);
    return {
      watermark: 'Illustration only',
      imageMime: mime,
      imageDataUri: `data:${mime};base64,${Buffer.from(binary, 'binary').toString('base64')}`,
      imageBytes: bytes.length,
    };
  }
  // Normal path (verified in smoke test 5): JSON with b64_json bytes.
  if (typeof res.json === 'function') {
    const data = (await res.json()) as { data?: { b64_json?: unknown; url?: unknown }[] };
    const item = data.data?.[0];
    if (item && typeof item.b64_json === 'string') {
      const bytes = Buffer.from(item.b64_json, 'base64');
      const mime = sniffImageMime(new Uint8Array(bytes));
      if (!mime) throw new Error('Image response was not a recognised image format.');
      return {
        watermark: 'Illustration only',
        imageMime: mime,
        imageDataUri: `data:${mime};base64,${item.b64_json}`,
        imageBytes: bytes.length,
      };
    }
    if (item && typeof item.url === 'string') {
      return { watermark: 'Illustration only', imageUrl: item.url, imageMime: null, imageBytes: 0 };
    }
    throw new Error('Image response had no image data.');
  }
  if (typeof res.arrayBuffer === 'function') {
    const bytes = new Uint8Array(await res.arrayBuffer());
    const mime = sniffImageMime(bytes);
    if (!mime) throw new Error('Image response was not a recognised image format.');
    let binary = '';
    for (const b of bytes) binary += String.fromCharCode(b);
    return {
      watermark: 'Illustration only',
      imageMime: mime,
      imageDataUri: `data:${mime};base64,${Buffer.from(binary, 'binary').toString('base64')}`,
      imageBytes: bytes.length,
    };
  }
  throw new Error('Image response could not be read.');
}

// ---------------------------------------------------------------------------
// Provider factory + selection
// ---------------------------------------------------------------------------

/**
 * Builds the real provider. Throws on an empty key — fail fast at the
 * call site, never at import time. The route must use
 * selectAiProvider() so a missing key degrades to the mock.
 */
export function createMetaProvider(apiKey: string, fetchImpl?: MetaFetch): AiProvider {
  if (!apiKey) throw new Error('MODEL_API_KEY is not set.');
  const fetchFn: MetaFetch =
    fetchImpl ??
    ((url, init) => fetch(url, init) as unknown as Promise<MetaFetchResponse>);
  return {
    async call({ feature, model, input, repair }) {
      if (!isStandardModel(model)) {
        // Fail closed even if the gateway check is bypassed: a
        // Contributor ID must never reach the network.
        throw new Error('Model is not on the Standard-tier allow-list.');
      }
      if (feature === 'safety-check') {
        throw new Error('safety-check never calls a model.');
      }
      if (feature === 'image-preview') {
        if (model !== 'muse-image-1.0') throw new Error('image-preview requires muse-image-1.0.');
        return callImage(fetchFn, apiKey, input);
      }
      const output = await callChat(fetchFn, apiKey, feature, model, input, repair);
      // Photo-brief SAM step: only when the caller supplies both a
      // processed photo and a segmentation prompt. SAM failure or a
      // zero-match never fails the brief — the brief is valid
      // without a mask, and samStatus says what happened.
      if (feature === 'photo-brief') {
        const imageUri = inputImageDataUri(input);
        const samPrompt = inputStringField(input, 'samPrompt');
        if (imageUri && samPrompt) {
          try {
            const samRes = await postJson(
              fetchFn,
              apiKey,
              '/responses',
              {
                model: 'sam-3.1',
                input: [
                  {
                    type: 'message',
                    role: 'user',
                    content: [
                      { type: 'input_text', text: samPrompt },
                      { type: 'input_image', image_url: imageUri },
                    ],
                  },
                ],
                stream: true,
                metadata: { mask_encoding: 'one_bit', include_confidence: 'true' },
              },
              'text/event-stream',
            );
            const lane = await readSseLane(samRes);
            const parsed = parseSamLane(
              lane,
              inputNumberField(input, 'frameWidth'),
              inputNumberField(input, 'frameHeight'),
            );
            return {
              ...output,
              mask: parsed.polygons ? { polygons: parsed.polygons } : null,
              maskConfidence: parsed.confidence,
              samStatus: parsed.status,
            };
          } catch {
            return { ...output, mask: null, maskConfidence: null, samStatus: 'failed' };
          }
        }
      }
      return output;
    },
  };
}

/**
 * Route selection: real provider when MODEL_API_KEY is present, the
 * existing mock otherwise. The flag system (route) still gates real
 * users — this choice alone enables nothing.
 */
export function selectAiProvider(apiKey: string | undefined): AiProvider {
  return apiKey ? createMetaProvider(apiKey) : mockAiProvider;
}

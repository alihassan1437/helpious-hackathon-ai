// B7 — paste-to-profile helpers (hackathon).
//
// Pure, dependency-free functions shared by the review-screen
// component (src/components/ai/PasteToProfile.tsx) and the unit
// tests (tests/ai-b7.test.mjs). Everything here runs in the browser
// or in Node's type stripping — no Firebase, no network, no keys.
//
// The honesty rules this module exists to enforce:
//
//   1. Every extracted field must carry the exact snippet from the
//      business's own pasted text that supports it. The snippet is
//      verified against the paste the user actually typed (the
//      client still has it): a snippet that cannot be found in the
//      paste forces the field to "check carefully" — a paraphrased
//      or invented quote is exactly how invented facts would sneak
//      in, so it is never presented as verified.
//   2. Contact details and ID numbers can never appear in a value.
//      The gateway strips phone/email/street-address and digit
//      chains (ABN, licence numbers) from the paste BEFORE any
//      model sees it, replacing them with "[... removed]"
//      placeholders. If a placeholder ever leaks into a returned
//      value, the field is dropped here, deterministically, and
//      reported — the review screen tells the business to add
//      contact details in the form itself, where they belong.
//   3. Empty is valid. A field the text does not state produces no
//      row; a paste with nothing usable produces no rows at all,
//      and the UI says "fill the form manually" — never a guess.

export type PasteFieldKind = 'text' | 'longText' | 'list' | 'hours' | 'prices';

export type PasteFieldValue = string | string[] | Record<string, string>;

export interface PasteProfileFieldDef {
  /** Key in the model's `extracted` object (or in `seo` when generated). */
  key: string;
  label: string;
  /** BusinessFormData field the value fills when applied. */
  formField: string;
  kind: PasteFieldKind;
  /** Editor tab the filled field lives on (shown as a hint). */
  tab: string;
  /** True for AI-written copy (tagline/description from the seo block). */
  generated: boolean;
}

/** The fixed B7 field set, in review-screen order. */
export const PASTE_PROFILE_FIELDS: readonly PasteProfileFieldDef[] = [
  { key: 'businessName', label: 'Business name', formField: 'name', kind: 'text', tab: 'Basics', generated: false },
  { key: 'category', label: 'Category', formField: 'category', kind: 'text', tab: 'Basics', generated: false },
  { key: 'tagline', label: 'Marketing tagline', formField: 'tagline', kind: 'text', tab: 'Basics', generated: true },
  { key: 'description', label: 'Description', formField: 'description', kind: 'longText', tab: 'Basics', generated: true },
  { key: 'yearsInBusiness', label: 'Industry experience', formField: 'tradingDuration', kind: 'text', tab: 'Basics', generated: false },
  { key: 'website', label: 'Website', formField: 'website', kind: 'text', tab: 'Basics', generated: false },
  { key: 'paymentMethods', label: 'Accepted payments', formField: 'paymentMethods', kind: 'list', tab: 'Basics', generated: false },
  { key: 'services', label: 'Main offerings (services)', formField: 'servicesList', kind: 'list', tab: 'Services', generated: false },
  { key: 'fromPrices', label: 'Starting prices', formField: 'servicePrices', kind: 'prices', tab: 'Services', generated: false },
  { key: 'serviceAreas', label: 'Suburbs serviced', formField: 'suburbsServiced', kind: 'list', tab: 'Areas', generated: false },
  { key: 'openingHours', label: 'Opening hours', formField: 'workingHours', kind: 'hours', tab: 'Hours', generated: false },
];

export const PASTE_DAYS: readonly string[] = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
];

/** The only words the model may use in removedContact (v2 prompt). */
export const REMOVED_CONTACT_VOCAB: readonly string[] = [
  'phone',
  'email',
  'street address',
  'ABN',
  'licence number',
];

/** Human phrasing for the review screen's contact note. */
export const REMOVED_CONTACT_LABELS: Record<string, string> = {
  phone: 'a phone number',
  email: 'an email address',
  'street address': 'a street address',
  ABN: 'an ABN',
  'licence number': 'a licence number',
};

const PLACEHOLDER_RE = /\[(?:email|address|phone|number) removed\]|\[contact details removed\]/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function collapseWs(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

function strList(value: unknown): string[] {
  return Array.isArray(value)
    ? (value as unknown[])
        .filter((v): v is string => typeof v === 'string')
        .map((v) => v.trim())
        .filter((v) => v !== '')
    : [];
}

function strRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === 'string' && v.trim() !== '' && k.trim() !== '') out[k.trim()] = v.trim();
  }
  return out;
}

/** Coerces a raw model value into the field kind's shape, or null if unusable. */
function coerceValue(kind: PasteFieldKind, raw: unknown): PasteFieldValue | null {
  switch (kind) {
    case 'text':
    case 'longText':
      return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : null;
    case 'list': {
      const list = strList(raw);
      return list.length > 0 ? list : null;
    }
    case 'hours':
    case 'prices': {
      const rec = strRecord(raw);
      return Object.keys(rec).length > 0 ? rec : null;
    }
  }
}

export interface PasteReviewRow extends PasteProfileFieldDef {
  value: PasteFieldValue;
  /** Exact supporting quote from the paste ('' for AI-written copy). */
  snippet: string;
  /** The snippet was found verbatim (whitespace-insensitive) in the paste. */
  snippetVerified: boolean;
  /** Model flagged it, or the snippet could not be verified. */
  lowConfidence: boolean;
}

export interface NormalizedPasteProfile {
  rows: PasteReviewRow[];
  /** Contact kinds the model saw as privacy placeholders (vocab only). */
  removedContact: string[];
  /** Labels of fields dropped because a placeholder leaked into the value. */
  droppedPlaceholderFields: string[];
  /** True for the D1 mock's no-extraction reply. */
  isMock: boolean;
  /** True when at least one usable field came back. */
  hasExtraction: boolean;
}

const EMPTY_RESULT: NormalizedPasteProfile = {
  rows: [],
  removedContact: [],
  droppedPlaceholderFields: [],
  isMock: false,
  hasExtraction: false,
};

function looksMock(output: unknown): boolean {
  if (isRecord(output) && output.mock === true) return true;
  return JSON.stringify(output ?? {}).includes('(mock');
}

/**
 * Validates + normalises a gateway paste-to-profile output into
 * review rows. `originalPaste` is the text the user typed (the
 * client has it; the model only ever saw the PII-stripped version,
 * which differs only in the stripped spans, so non-PII snippets
 * verify verbatim against the original).
 */
export function normalizePasteProfile(
  output: unknown,
  originalPaste: string,
): NormalizedPasteProfile {
  if (!isRecord(output)) return EMPTY_RESULT;
  if (looksMock(output)) {
    // The mock performs NO extraction by design; its empty shape is
    // not a real "nothing found" result and must not be presented
    // as one.
    return { ...EMPTY_RESULT, isMock: true };
  }
  const extracted = isRecord(output.extracted) ? output.extracted : {};
  const seo = isRecord(output.seo) ? output.seo : {};
  const lowSet = new Set(strList(output.lowConfidence));
  const pasteCollapsed = collapseWs(originalPaste ?? '');

  const removed = new Set<string>();
  for (const raw of strList(output.removedContact)) {
    const canonical = REMOVED_CONTACT_VOCAB.find((v) => v.toLowerCase() === raw.toLowerCase());
    if (canonical) removed.add(canonical);
  }

  const rows: PasteReviewRow[] = [];
  const droppedPlaceholderFields: string[] = [];
  for (const def of PASTE_PROFILE_FIELDS) {
    let rawValue: unknown;
    let snippet = '';
    if (def.generated) {
      rawValue = seo[def.key];
    } else {
      const entry = extracted[def.key];
      if (!isRecord(entry)) continue;
      rawValue = entry.value;
      snippet = typeof entry.snippet === 'string' ? entry.snippet.trim() : '';
    }
    const value = coerceValue(def.kind, rawValue);
    if (value === null) continue;
    if (PLACEHOLDER_RE.test(JSON.stringify(value))) {
      // Deterministic backstop: a placeholder is not a value. Drop
      // the field rather than let "[phone removed]" reach the form.
      droppedPlaceholderFields.push(def.label);
      continue;
    }
    const snippetVerified =
      !def.generated && snippet !== '' && pasteCollapsed.includes(collapseWs(snippet));
    const lowConfidence = lowSet.has(def.key) || (!def.generated && !snippetVerified);
    rows.push({ ...def, value, snippet, snippetVerified, lowConfidence });
  }

  return {
    rows,
    removedContact: REMOVED_CONTACT_VOCAB.filter((v) => removed.has(v)),
    droppedPlaceholderFields,
    isMock: false,
    hasExtraction: rows.length > 0,
  };
}

// ---------------------------------------------------------------------
// Review-screen edit round-trips. Rows are edited as text; these two
// functions convert between the typed value and its edit text.
// ---------------------------------------------------------------------

export function formatPasteFieldValue(kind: PasteFieldKind, value: PasteFieldValue): string {
  switch (kind) {
    case 'text':
    case 'longText':
      return typeof value === 'string' ? value : '';
    case 'list':
      return Array.isArray(value) ? value.join(', ') : '';
    case 'hours': {
      if (!isRecord(value)) return '';
      const rec = value as Record<string, string>;
      return PASTE_DAYS.filter((d) => typeof rec[d] === 'string' && rec[d] !== '')
        .map((d) => `${d}: ${rec[d]}`)
        .join('\n');
    }
    case 'prices': {
      if (!isRecord(value)) return '';
      return Object.entries(value as Record<string, string>)
        .map(([k, v]) => `${k}: ${v}`)
        .join('\n');
    }
  }
}

const DAY_ALIASES: Record<string, string> = (() => {
  const out: Record<string, string> = {};
  for (const day of PASTE_DAYS) {
    out[day.toLowerCase()] = day;
    out[day.slice(0, 3).toLowerCase()] = day;
  }
  return out;
})();

/**
 * Parses edited review text back into a field value. Hours and
 * prices return PARTIAL records (only the lines present) — the
 * caller merges them over the form's existing record so unlisted
 * days/prices are kept, never wiped.
 */
export function parsePasteFieldEdit(kind: PasteFieldKind, text: string): PasteFieldValue {
  switch (kind) {
    case 'text':
    case 'longText':
      return text.trim();
    case 'list': {
      const seen = new Set<string>();
      const out: string[] = [];
      for (const part of text.split(/[,\n]/)) {
        const item = part.trim();
        if (item !== '' && !seen.has(item)) {
          seen.add(item);
          out.push(item);
        }
      }
      return out;
    }
    case 'hours': {
      const out: Record<string, string> = {};
      for (const line of text.split('\n')) {
        const m = line.match(/^\s*([A-Za-z]+)\s*:\s*(.+)$/);
        if (!m || m[1] === undefined || m[2] === undefined) continue;
        const day = DAY_ALIASES[m[1].toLowerCase()];
        if (day && m[2].trim() !== '') out[day] = m[2].trim();
      }
      return out;
    }
    case 'prices': {
      const out: Record<string, string> = {};
      for (const line of text.split('\n')) {
        const idx = line.indexOf(':');
        if (idx <= 0) continue;
        const k = line.slice(0, idx).trim();
        const v = line.slice(idx + 1).trim();
        if (k !== '' && v !== '') out[k] = v;
      }
      return out;
    }
  }
}

/**
 * Whether the form's current value for a field counts as empty, for
 * the review screen's default tick: fields with existing content are
 * NEVER ticked by default, so nothing is overwritten unless the
 * business explicitly ticks it. Hours is deliberately conservative:
 * the editor always holds a full week (defaults for a new listing),
 * so extracted hours count as "already set" and start unticked.
 */
export function pasteFieldIsEmpty(kind: PasteFieldKind, current: unknown): boolean {
  switch (kind) {
    case 'text':
    case 'longText':
      return typeof current !== 'string' || current.trim() === '';
    case 'list':
      return strList(current).length === 0;
    case 'prices':
      return Object.keys(strRecord(current)).length === 0;
    case 'hours':
      return Object.keys(strRecord(current)).length === 0;
  }
}

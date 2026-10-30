// Business-side AI helpers for B1 (lead brief) + B2 (quote draft).
//
// Pure, dependency-free functions shared by the Leads UI components
// (src/components/ai/LeadAiBrief.tsx, QuoteAiDraft.tsx) and the unit
// tests (tests/ai-b1b2.test.mjs). Everything here runs in the browser
// or in Node's type stripping — no Firebase, no network, no keys.
//
// The two honesty rules this module exists to enforce:
//
//   1. B1 input is the job's description text plus category and
//      suburb ONLY. Callers must never pass a customer name, phone,
//      email, or street address (the gateway strips PII again
//      server-side, but the first defence is not sending it).
//   2. B2 prices come ONLY from the business's own price list
//      (businesses/{id}.servicePrices). The model is told that in
//      the prompt, and applyQuoteDraft() enforces it again here,
//      deterministically: any drafted price whose number does not
//      appear in the business's own price strings is removed and
//      flagged "add your price" — never kept, never rounded into a
//      listed price.

// ---------------------------------------------------------------------
// B1 — lead brief (gateway feature 'photo-brief')
// ---------------------------------------------------------------------

export interface LeadBrief {
  trade: string;
  issue: string;
  scope: string;
  urgency: string;
  accessNotes: string;
  questions: string[];
  missingPhotos: string[];
}

function strField(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * Mock-provider marker: the D1 mock writes "(mock)" / "(mock — …)"
 * into its text, a real model output never does. Matches the C1
 * heuristic in SnapPhotoBrief, widened to the quote draft's wording.
 */
function looksMock(output: unknown): boolean {
  return JSON.stringify(output ?? {}).includes('(mock');
}

function strList(value: unknown): string[] {
  return Array.isArray(value)
    ? (value as unknown[]).filter((v): v is string => typeof v === 'string' && v.trim() !== '')
    : [];
}

/**
 * Validates + normalises a gateway photo-brief output into the shape
 * the lead detail renders. Returns null when the output is not a
 * usable brief (not an object, or no trade and no issue), so the UI
 * can fall back to its placeholder instead of rendering fragments.
 * `isMock` mirrors the C1 heuristic: the mock provider marks its
 * text with "(mock)", a real brief never contains that marker.
 */
export function normalizeLeadBrief(
  output: unknown,
): { brief: LeadBrief; isMock: boolean } | null {
  if (output === null || typeof output !== 'object' || Array.isArray(output)) return null;
  const o = output as Record<string, unknown>;
  const brief: LeadBrief = {
    trade: strField(o.trade),
    issue: strField(o.issue),
    scope: strField(o.scope),
    urgency: strField(o.urgency),
    accessNotes: strField(o.accessNotes),
    questions: strList(o.questions),
    missingPhotos: strList(o.missingPhotos),
  };
  if (brief.trade === '' && brief.issue === '') return null;
  return { brief, isMock: looksMock(output) };
}

/**
 * The text payload for a B1 brief call: the job description verbatim,
 * plus category and suburb lines when present. Nothing else — no
 * customer identity fields exist in this shape by construction.
 */
export function composeLeadBriefText(args: {
  description: string;
  category?: string;
  suburb?: string;
}): string {
  const lines = [args.description.trim()];
  if (args.category && args.category.trim() !== '') lines.push(`Category: ${args.category.trim()}`);
  if (args.suburb && args.suburb.trim() !== '') lines.push(`Suburb: ${args.suburb.trim()}`);
  return lines.filter((l) => l !== '').join('\n');
}

// ---------------------------------------------------------------------
// B2 — quote draft (gateway feature 'quote-draft')
// ---------------------------------------------------------------------

export interface PriceEntry {
  service: string;
  /** Verbatim price string from the business's own listing, e.g. "From $120". */
  price: string;
}

/**
 * Normalises the raw servicePrices doc field (Record<service, price>)
 * the same way the public profile does: both sides trimmed, blank
 * services/prices dropped. Non-record input yields no entries.
 */
export function priceEntriesFrom(servicePrices: unknown): PriceEntry[] {
  if (servicePrices === null || typeof servicePrices !== 'object' || Array.isArray(servicePrices)) {
    return [];
  }
  return Object.entries(servicePrices as Record<string, unknown>)
    .map(([service, price]) => ({
      service: service.trim(),
      price: typeof price === 'string' ? price.trim() : '',
    }))
    .filter((e) => e.service !== '' && e.price !== '');
}

/**
 * Every number that appears in the business's own price strings
 * ("From $120" -> 120, "$80 - $100" -> 80 and 100, "$1,200" -> 1200).
 * This set is the complete universe of prices an AI draft may use.
 */
export function allowedPriceNumbers(entries: PriceEntry[]): Set<number> {
  const out = new Set<number>();
  for (const e of entries) {
    const matches = e.price.replace(/,/g, '').match(/\d+(?:\.\d{1,2})?/g);
    if (!matches) continue;
    for (const m of matches) {
      const n = Number.parseFloat(m);
      if (Number.isFinite(n)) out.add(n);
    }
  }
  return out;
}

export interface AppliedDraftItem {
  description: string;
  /** The builder's qty field is a string; drafts always start at "1". */
  qty: string;
  /** Unit price as the builder's string field; "" when the item needs a price. */
  unitPrice: string;
  /** True when the tradie must add a price before sending. */
  priceMissing: boolean;
}

export interface AppliedQuoteDraft {
  items: AppliedDraftItem[];
  /** The model's own notes, verbatim ("" when absent). */
  notes: string;
  isMock: boolean;
  /** How many drafted prices were removed for not being in the price list. */
  removedPrices: number;
  /** How many items still need a price (model blank or guard-removed). */
  missingPrices: number;
}

/**
 * Turns a validated gateway quote-draft output into builder line
 * items, enforcing the own-prices-only rule. A drafted price is kept
 * ONLY when its number appears in the business's own price strings;
 * anything else becomes blank + priceMissing (counted in
 * removedPrices so the UI can say so honestly). Items with no
 * description are dropped. The model's `total` is ignored on
 * purpose: the builder computes its own totals from the line items.
 */
export function applyQuoteDraft(output: unknown, entries: PriceEntry[]): AppliedQuoteDraft {
  const empty: AppliedQuoteDraft = {
    items: [],
    notes: '',
    isMock: false,
    removedPrices: 0,
    missingPrices: 0,
  };
  if (output === null || typeof output !== 'object' || Array.isArray(output)) return empty;
  const o = output as Record<string, unknown>;
  const allowed = allowedPriceNumbers(entries);
  const rawItems = Array.isArray(o.lineItems) ? (o.lineItems as unknown[]) : [];
  const items: AppliedDraftItem[] = [];
  let removedPrices = 0;
  for (const raw of rawItems) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const item = raw as Record<string, unknown>;
    const description = strField(item.description).trim();
    if (description === '') continue;
    const price = typeof item.price === 'number' && Number.isFinite(item.price) ? item.price : null;
    if (price !== null && allowed.has(price)) {
      items.push({ description, qty: '1', unitPrice: String(price), priceMissing: false });
    } else {
      if (price !== null) removedPrices += 1;
      items.push({ description, qty: '1', unitPrice: '', priceMissing: true });
    }
  }
  return {
    items,
    notes: strField(o.notes),
    isMock: looksMock(output),
    removedPrices,
    missingPrices: items.filter((i) => i.priceMissing).length,
  };
}

/**
 * The single text payload for a B2 draft call: job text, the B1
 * brief summary when one exists, and the business's own price list
 * rendered verbatim. With no price list the text says so plainly, so
 * the model is instructed by the input itself to leave prices blank
 * (and applyQuoteDraft enforces it regardless of what comes back).
 */
export function composeQuoteDraftText(args: {
  jobText: string;
  category?: string;
  suburb?: string;
  brief?: LeadBrief | null;
  priceEntries: PriceEntry[];
}): string {
  const lines: string[] = ['Job description:', args.jobText.trim()];
  if (args.category && args.category.trim() !== '') lines.push(`Category: ${args.category.trim()}`);
  if (args.suburb && args.suburb.trim() !== '') lines.push(`Suburb: ${args.suburb.trim()}`);
  if (args.brief) {
    lines.push('', 'AI lead brief for this job:');
    if (args.brief.issue) lines.push(`- Issue: ${args.brief.issue}`);
    if (args.brief.scope) lines.push(`- Scope: ${args.brief.scope}`);
    if (args.brief.urgency) lines.push(`- Urgency: ${args.brief.urgency}`);
    if (args.brief.accessNotes) lines.push(`- Access notes: ${args.brief.accessNotes}`);
  }
  lines.push('');
  if (args.priceEntries.length > 0) {
    lines.push("The business's own price list (the ONLY prices you may use):");
    for (const e of args.priceEntries) lines.push(`- ${e.service}: ${e.price}`);
  } else {
    lines.push(
      'The business has no price list on file: leave every price blank and flag it missing.',
    );
  }
  return lines.join('\n');
}

/** Normalisierung für fachliche Vergleiche — defensiv, nicht aggressiv fuzzy. */

export function normalizeName(value: string | undefined | null): string {
  return (value ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/gmbh|ug|ag|kg|ohg|e\.?\s*k\.?/gi, '')
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function namesLooselyMatch(a: string, b: string): boolean {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (!na || !nb) return false;
  return na === nb || na.includes(nb) || nb.includes(na);
}

export function nameContainsExpected(actual: string | undefined, needle: string): boolean {
  if (!actual) return false;
  return normalizeName(actual).includes(normalizeName(needle));
}

export function parseAmountNumber(raw: string | number | undefined | null): number | undefined {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (raw == null) return undefined;
  const cleaned = String(raw).replace(/[^\d,.-]/g, '').trim();
  if (!cleaned) return undefined;
  let normalized = cleaned;
  if (cleaned.includes(',') && cleaned.includes('.')) {
    normalized = cleaned.replace(/\./g, '').replace(',', '.');
  } else if (cleaned.includes(',')) {
    normalized = cleaned.replace(',', '.');
  }
  const value = Number(normalized);
  return Number.isFinite(value) ? value : undefined;
}

export function amountsClose(
  a: number | undefined,
  b: number | undefined,
  epsilon = 0.05,
): boolean {
  if (a == null || b == null) return false;
  return Math.abs(a - b) <= epsilon;
}

export function normalizeUnit(unit: string | undefined | null): string {
  const u = (unit ?? '').trim().toLowerCase().replace(/\s+/g, '');
  if (u === 'm²' || u === 'm2' || u === 'qm' || u === 'quadratmeter') return 'm2';
  if (u === 'lfdm' || u === 'lfm' || u === 'lfm.' || u === 'lfm') return 'lfdm';
  if (u === 'stk' || u === 'stück' || u === 'stueck' || u === 'st') return 'stk';
  return u;
}

export function unitsEquivalent(a: string | undefined, aliases: string[] | undefined): boolean {
  if (!aliases?.length) return true;
  const na = normalizeUnit(a);
  return aliases.some((alias) => normalizeUnit(alias) === na);
}

/** ISO-ähnlich oder DE-Datum → yyyy-mm-dd wenn parsebar. */
export function normalizeDateToken(raw: string | undefined | null): string | undefined {
  if (!raw) return undefined;
  const text = String(raw).trim();
  const iso = text.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const de = text.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (de) {
    return `${de[3]}-${de[2]!.padStart(2, '0')}-${de[1]!.padStart(2, '0')}`;
  }
  return undefined;
}

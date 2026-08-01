/**
 * DOCUMENT-SUMMARY-CONTENT — fact prioritization + first-screen truncation.
 * Presentation only. Does not change DocumentSummary model or pipeline sources.
 */

/** ~2 lines on typical phone / card widths. */
export const DOCUMENT_SUMMARY_FACT_MAX_CHARS = 90;

/**
 * Collapse whitespace and truncate to roughly two lines with an ellipsis.
 * Full text stays available in Details / deep workspace — not here.
 */
export function truncateSummaryFactText(
  value: string,
  maxChars: number = DOCUMENT_SUMMARY_FACT_MAX_CHARS,
): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  if (normalized.length <= maxChars) return normalized;
  const budget = Math.max(8, maxChars - 1);
  const slice = normalized.slice(0, budget);
  const cut = slice.lastIndexOf(' ');
  const base = cut >= Math.floor(budget * 0.45) ? slice.slice(0, cut) : slice;
  return `${base.trimEnd()}…`;
}

/**
 * Prefer Bauvorhaben / short project names over long Vertragsgegenstand prose.
 */
export function preferProjectFactValue(
  ...candidates: Array<string | undefined | null>
): string | undefined {
  const usable: string[] = [];
  for (const candidate of candidates) {
    const trimmed = candidate?.trim();
    if (!trimmed) continue;
    usable.push(trimmed);
    if (isLongContractProse(trimmed)) continue;
    return truncateSummaryFactText(trimmed);
  }
  if (usable[0]) return truncateSummaryFactText(usable[0]);
  return undefined;
}

function isLongContractProse(value: string): boolean {
  if (value.length > 120) return true;
  if (
    value.length > 60 &&
    /§|gemäß|nachstehend|vertragsgrundlage|leistungsbeschreibung|allgemeine\s+geschäft/i.test(
      value,
    )
  ) {
    return true;
  }
  return false;
}

/** Amount / table cells must never become a construction-site fact. */
export function isMoneyLikeSiteValue(value: string): boolean {
  const trimmed = value.replace(/\s+/g, ' ').trim();
  if (!trimmed) return true;
  if (/^\d+[.,]\d{2}\s*€?$/.test(trimmed)) return true;
  if (/^-?\d+[.,]\d{2}\b/.test(trimmed) && trimmed.length < 28) return true;
  if (/\b€\b|\bEUR\b/i.test(trimmed) && /netto|brutto|pos\.?/i.test(trimmed)) return true;
  if (/^\d+[.,]\d{2}\s*€?\s*netto/i.test(trimmed)) return true;
  return false;
}

const PLACEHOLDER_PARTY =
  /^(?:unbekannt|lieferant|kunde|absender|empfänger|empfaenger|mandant|dokument|—|-|\.{2,})$/i;

export function isPlaceholderPartyValue(value: string | undefined | null): boolean {
  const trimmed = value?.replace(/\s+/g, ' ').trim();
  if (!trimmed) return true;
  return PLACEHOLDER_PARTY.test(trimmed);
}

/**
 * Party names: drop placeholders, address/doc-type bleed, and a trailing second legal entity.
 */
export function cleanPartyFactValue(value: string): string {
  let v = value.replace(/\s+/g, ' ').trim();
  if (!v || isPlaceholderPartyValue(v)) return '';
  v = v.split(/\s*[·|]\s*/)[0]?.trim() ?? v;

  const entities = [
    ...v.matchAll(
      /\b[\p{L}][\p{L}\d .&\-\/'’]{1,55}?\s(?:GmbH(?:\s*&\s*Co\.?\s*KG)?|AG|KG|OHG|GbR|UG|e\.?\s*V\.?)\b/gu,
    ),
  ];
  if (entities.length >= 2 && entities[0]?.index != null) {
    v = v.slice(0, entities[0].index + entities[0][0].length).trim();
  }

  v = v
    .replace(
      /\s+(?:Behörden\w*|Gerichtsschreiben|Schriftverkehr|Mobilfunk|Festnetz\s*\/\s*Internet|arbeitsunfähig|seit|voraus|Rampendal|Prüfbericht|Werkstattrechnung|Bezeichnung|Bruttogeh\w*|Industriestraße|IndustrieStrasse|Parkstraße|Büchenstraße|Energieallee|Werkstraße|Werkstattweg|Bahnhofstraße|Vlothoer|Straße|Strasse|Str\.)\b.*$/iu,
      '',
    )
    .trim();
  v = v.replace(/\s+\d{5}\s+\S.*$/u, '').trim();
  // Repeated org label after legal form: "… GmbH Steuerberatung …"
  v = v.replace(/(\bGmbH)\s+(?:Steuerberatung|Kanzlei)\b.*$/iu, '$1').trim();

  if (!v || isPlaceholderPartyValue(v) || v.length < 2) return '';
  return truncateSummaryFactText(v, 70);
}

/** First non-empty party that is not a placeholder; cleaned for summary display. */
export function preferMeaningfulParty(
  ...candidates: Array<string | undefined | null>
): string | undefined {
  for (const candidate of candidates) {
    const cleaned = candidate ? cleanPartyFactValue(candidate) : '';
    if (cleaned) return cleaned;
  }
  return undefined;
}

/**
 * Prefer Betreff / case labels over inbox capture titles ("Gerade erfasst…", "Dokument").
 */
export function preferSubjectFactValue(
  ...candidates: Array<string | undefined | null>
): string | undefined {
  for (const candidate of candidates) {
    let trimmed = candidate?.replace(/\s+/g, ' ').trim();
    if (!trimmed) continue;
    trimmed = trimmed.replace(/^gerade erfasst\s*:\s*/i, '').trim();
    if (!trimmed || /^(?:dokument)$/i.test(trimmed)) continue;
    // Collapse redundant "Finanzamt – Finanzamt Detmold" → keep right-hand detail when duplicated.
    const dash = trimmed.match(/^(.+?)\s*[–—-]\s*(.+)$/);
    if (dash) {
      const left = dash[1].trim();
      const right = dash[2].trim();
      if (right.toLowerCase().startsWith(left.toLowerCase()) || left.toLowerCase() === right.toLowerCase()) {
        trimmed = right;
      }
    }
    return truncateSummaryFactText(trimmed, 90);
  }
  return undefined;
}

/** Compose "Party – Betreff" and strip duplicated party tokens from the topic. */
export function composePartySubjectFact(
  party: string | undefined,
  betreff: string | undefined,
): string | undefined {
  const topic = preferSubjectFactValue(betreff);
  let cleanParty = party ? cleanPartyFactValue(party) : '';
  if (cleanParty) {
    cleanParty = cleanParty
      .replace(/\s+Bezirksverwaltung\b.*$/iu, '')
      .replace(/\s+Gewerbeversicherung\b.*$/iu, '')
      .trim();
  }
  if (!topic) return cleanParty || undefined;
  if (!cleanParty) return topic;
  if (topic.toLowerCase().includes(cleanParty.toLowerCase().slice(0, Math.min(12, cleanParty.length)))) {
    // Topic already carries the party — prefer topic when it starts with party, else party – stripped topic.
    if (topic.toLowerCase().startsWith(cleanParty.toLowerCase())) return topic;
  }
  let stripped = topic;
  const partyEscaped = cleanParty.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  stripped = stripped.replace(new RegExp(partyEscaped, 'ig'), ' ');
  stripped = stripped.replace(/\s+/g, ' ').replace(/^[–—\-\s]+|[–—\-\s]+$/g, '').trim();
  const composed = stripped && stripped.toLowerCase() !== cleanParty.toLowerCase()
    ? `${cleanParty} – ${stripped}`
    : cleanParty;
  return preferSubjectFactValue(composed) ?? composed;
}

/** Compact Vorgang / case label — stop before LV / position tables. */
export function preferVorgangFactValue(
  ...candidates: Array<string | undefined | null>
): string | undefined {
  for (const candidate of candidates) {
    let trimmed = candidate?.replace(/\s+/g, ' ').trim();
    if (!trimmed) continue;
    if (isMoneyLikeSiteValue(trimmed)) continue;
    trimmed = trimmed
      .replace(/\s+Pos\.?\s*.*$/i, '')
      .replace(/\s+Bezeichnung\b.*$/i, '')
      .replace(/\s+Artikel\b.*$/i, '')
      .trim();
    if (!trimmed || trimmed.length < 3) continue;
    return truncateSummaryFactText(trimmed, 70);
  }
  return undefined;
}

/**
 * Site fact: street + place, or a short project-like label — never a multi-line address block.
 */
export function shortenConstructionSiteFact(value: string): string {
  let raw = value.replace(/\r/g, '\n').trim();
  if (!raw) return '';

  const labeled = raw.match(/\bbaustelle\s*[:]\s*([^\n·]+)/i);
  if (labeled?.[1]?.trim()) {
    raw = labeled[1].trim();
  }

  raw = raw
    .replace(/\s+Pos\.?\s*.*$/i, '')
    .replace(/\s+Bezeichnung\b.*$/i, '')
    .replace(/\s+Zwischen\b.*$/i, '')
    .trim();
  if (!raw || isMoneyLikeSiteValue(raw)) return '';

  const chunks = raw
    .split(/[\n,;·]+/)
    .map((part) => part.replace(/\s+/g, ' ').trim())
    .filter((part) => part && !isMoneyLikeSiteValue(part));

  const street = chunks.find(
    (part) =>
      /\d/.test(part) &&
      /[A-Za-zÄÖÜäöüß]/.test(part) &&
      !/^\d{4,5}\b/.test(part) &&
      part.length <= 80,
  );
  const plzCity = chunks.find((part) => /^\d{4,5}\s+\S/.test(part));
  const city = plzCity
    ? plzCity.replace(/^\d{4,5}\s+/, '').trim()
    : chunks.find(
        (part) =>
          part.length <= 40 &&
          !/\d/.test(part) &&
          /^[A-Za-zÄÖÜäöüß]/.test(part) &&
          part !== street,
      );

  if (street && city && !street.includes(city)) {
    return truncateSummaryFactText(`${street}, ${city}`, 70);
  }
  if (street) return truncateSummaryFactText(street, 70);
  if (plzCity) return truncateSummaryFactText(city || plzCity, 70);

  const first = chunks[0] ?? raw;
  if (isMoneyLikeSiteValue(first)) return '';
  // Project titles with en-dash are not street sites when no address chunk exists.
  if (/[–—]/.test(first) && !/\d/.test(first) && first.length > 24) return '';
  return truncateSummaryFactText(first, 70);
}

/**
 * Turn raw "Positionen" / counts into "N Positionen erkannt".
 * Long Leistungsbeschreibung is not a positions fact.
 */
export function formatPositionsFactValue(
  raw: string | undefined,
  formatCount: (count: number) => string,
): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;

  const explicit = trimmed.match(/(\d+)\s*(?:Positionen|Pos\.?|Pos\b)/i);
  if (explicit) {
    return formatCount(Number(explicit[1]));
  }
  if (/^\d{1,4}$/.test(trimmed)) {
    return formatCount(Number(trimmed));
  }
  // Long prose / Leistungsbeschreibung → not a compact positions fact
  if (trimmed.length > 48 || /[-–—]/.test(trimmed) && trimmed.length > 30) {
    return undefined;
  }
  return truncateSummaryFactText(trimmed);
}

/** Apply fact-id-aware shortening before first-screen display. */
export function formatSummaryFactValue(id: string, value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (id === 'site' || id === 'constructionSite') {
    return shortenConstructionSiteFact(trimmed);
  }
  if (id === 'project') {
    return preferProjectFactValue(trimmed) ?? '';
  }
  if (
    id === 'supplier' ||
    id === 'sender' ||
    id === 'authority' ||
    id === 'customer' ||
    id === 'station'
  ) {
    return cleanPartyFactValue(trimmed);
  }
  if (id === 'subject') {
    return preferSubjectFactValue(trimmed) ?? '';
  }
  if (id === 'vorgang') {
    return preferVorgangFactValue(trimmed) ?? '';
  }
  return truncateSummaryFactText(trimmed);
}

/** Contract fact order (Werkvertrag family) — SSOT for detail + inbox + compact. */
export const CONTRACT_SUMMARY_FACT_ORDER = [
  'customer',
  'project',
  'orderValue',
  'site',
  'positions',
  'gewerk',
] as const;

export function sortContractSummaryFacts<T extends { id: string }>(facts: T[]): T[] {
  const rank = new Map<string, number>(
    CONTRACT_SUMMARY_FACT_ORDER.map((id, index) => [id, index]),
  );
  return [...facts].sort((a, b) => {
    const ra = rank.get(a.id) ?? 100;
    const rb = rank.get(b.id) ?? 100;
    return ra - rb;
  });
}

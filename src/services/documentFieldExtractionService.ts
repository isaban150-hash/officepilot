export interface ExtractedDocumentFields {
  Absender?: string;
  Empfänger?: string;
  Datum?: string;
  Aktenzeichen?: string;
  Baustelle?: string;
  Kunde?: string;
  Vorgang?: string;
  Rechnungsnummer?: string;
  Betrag?: string;
  Frist?: string;
  Projekt?: string;
  Straße?: string;
  Ort?: string;
  Lieferant?: string;
  Betreff?: string;
}

const LABEL_VALUE =
  /^(?:absender|von|auftraggeber|lieferant|aussteller|anbieter|empfänger|empfaenger|an|kunde|mandant)\s*[:]\s*(.+)$/i;

const DATE_PATTERN = /\b(\d{1,2}[./]\d{1,2}[./]\d{2,4})\b/;
const AMOUNT_PATTERN =
  /\b(?:betrag|summe|gesamt|total)\s*[:]\s*(\d{1,3}(?:[.\s]\d{3})*,\d{2}\s*€?|\d{1,3}(?:[.\s]\d{3})*,\d{2}\s*(?:EUR|eur))|\b(\d{1,3}(?:[.\s]\d{3})*,\d{2}\s*€|\d{1,3}(?:[.\s]\d{3})*,\d{2}\s*(?:EUR|eur))\b/i;
const INVOICE_NUMBER_PATTERN =
  /\b(?:rechnungs(?:nummer|nr\.?)|invoice(?:\s*no\.?)?|beleg(?:nummer|nr\.?))\s*[:#]?\s*([A-Z0-9][\w./-]{2,})/i;
const REFERENCE_PATTERN =
  /\b(?:aktenzeichen|az\.?|vorgang(?:snummer|snr\.?)?|auftrags(?:nummer|nr\.?)|referenz)\s*[:#]?\s*([A-Z0-9][\w./-]{2,})/i;
const DEADLINE_PATTERN =
  /\b(?:frist|fällig(?:keit| am)?|zahlbar bis|bis zum|zahlungsziel)\s*[:.]?\s*(\d{1,2}[./]\d{1,2}[./]\d{2,4})/i;
const SITE_PATTERN =
  /\b(?:baustelle|bauvorhaben|bauobjekt|objekt|projekt)\s*[:]\s*(.+)$/i;
const ADDRESS_PATTERN =
  /\b(?:baustellenadresse|adresse|straße|strasse)\s*[:]\s*(.+)$/i;
const CITY_PATTERN = /\b(\d{5})\s+([A-ZÄÖÜ][\p{L}\-]+(?:\s+[A-ZÄÖÜ][\p{L}\-]+)*)/u;

function firstMatch(text: string, pattern: RegExp): string | undefined {
  const match = text.match(pattern);
  const value = match?.[1] ?? match?.[2];
  return value?.trim();
}

function pickLabeledValue(lines: string[], labels: RegExp): string | undefined {
  for (const line of lines) {
    const match = line.match(labels);
    if (match?.[1]?.trim()) return match[1].trim();
  }
  return undefined;
}

function normalizeAmount(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export function extractFieldsFromText(text: string): ExtractedDocumentFields {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const fields: ExtractedDocumentFields = {};

  for (const line of lines) {
    const generic = line.match(LABEL_VALUE);
    if (!generic) continue;

    const label = line.split(':')[0]?.trim().toLowerCase() ?? '';
    const value = generic[1].trim();
    if (!value) continue;

    if (/absender|von|auftraggeber|lieferant|aussteller|anbieter/.test(label)) {
      fields.Absender ??= value;
      if (/lieferant|anbieter/.test(label)) fields.Lieferant ??= value;
    }
    if (/empfänger|empfaenger|an|kunde|mandant/.test(label)) {
      fields.Empfänger ??= value;
      fields.Kunde ??= value;
    }
  }

  fields.Absender ??= pickLabeledValue(lines, /^(?:absender|von|auftraggeber|lieferant)\s*[:]\s*(.+)$/i);
  fields.Empfänger ??= pickLabeledValue(lines, /^(?:empfänger|empfaenger|an|kunde)\s*[:]\s*(.+)$/i);
  fields.Kunde ??= fields.Empfänger ?? pickLabeledValue(lines, /^kunde\s*[:]\s*(.+)$/i);
  fields.Lieferant ??= fields.Absender ?? pickLabeledValue(lines, /^lieferant\s*[:]\s*(.+)$/i);

  const siteLine = lines.find((line) => SITE_PATTERN.test(line));
  if (siteLine) {
    const match = siteLine.match(SITE_PATTERN);
    const value = match?.[1]?.trim();
    if (value) {
      fields.Baustelle = value;
      fields.Projekt = value;
      fields.Vorgang = value;
    }
  }

  const addressLine = lines.find((line) => ADDRESS_PATTERN.test(line));
  if (addressLine) {
    const match = addressLine.match(ADDRESS_PATTERN);
    if (match?.[1]?.trim()) {
      fields.Straße = match[1].trim();
      fields.Baustelle ??= match[1].trim();
    }
  }

  const cityMatch = text.match(CITY_PATTERN);
  if (cityMatch) {
    fields.Ort = `${cityMatch[1]} ${cityMatch[2]}`.trim();
    fields.Baustelle ??= fields.Ort;
  }

  fields.Datum ??= firstMatch(text, DATE_PATTERN);
  fields.Rechnungsnummer ??= firstMatch(text, INVOICE_NUMBER_PATTERN);
  fields.Aktenzeichen ??= firstMatch(text, REFERENCE_PATTERN);
  fields.Betrag ??= firstMatch(text, AMOUNT_PATTERN);
  if (fields.Betrag) fields.Betrag = normalizeAmount(fields.Betrag);
  fields.Frist ??= firstMatch(text, DEADLINE_PATTERN);

  const subjectLine = lines.find((line) => /^betreff\s*[:]/i.test(line));
  if (subjectLine) {
    fields.Betreff = subjectLine.replace(/^betreff\s*[:]\s*/i, '').trim();
  }

  return fields;
}

export function mergeExtractedFields(
  base: Record<string, string>,
  extracted: ExtractedDocumentFields,
): Record<string, string> {
  const merged = { ...base };

  for (const [key, value] of Object.entries(extracted)) {
    if (!value?.trim()) continue;
    const existing = merged[key];
    if (!existing || /^RE-2026|^ca\.|^Unbekannt|^Baustelle laut|^Mitarbeiter$/.test(existing)) {
      merged[key] = value.trim();
    }
  }

  return merged;
}

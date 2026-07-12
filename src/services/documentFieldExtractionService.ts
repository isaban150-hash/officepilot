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

export type FieldConfidenceLevel = 'high' | 'medium' | 'low';

export interface ConfidentField {
  value: string;
  confidence: FieldConfidenceLevel;
}

export type ExtractedDocumentFieldsWithConfidence = Partial<
  Record<keyof ExtractedDocumentFields, ConfidentField>
>;

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

function setField(
  fields: ExtractedDocumentFieldsWithConfidence,
  key: keyof ExtractedDocumentFields,
  value: string | undefined,
  confidence: FieldConfidenceLevel,
): void {
  if (!value?.trim()) return;
  const existing = fields[key];
  if (existing && rankConfidence(existing.confidence) >= rankConfidence(confidence)) {
    return;
  }
  fields[key] = { value: value.trim(), confidence };
}

function rankConfidence(level: FieldConfidenceLevel): number {
  if (level === 'high') return 3;
  if (level === 'medium') return 2;
  return 1;
}

export function isFieldConfidentEnough(level: FieldConfidenceLevel): boolean {
  return level === 'high' || level === 'medium';
}

export function extractFieldsWithConfidence(text: string): ExtractedDocumentFieldsWithConfidence {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const fields: ExtractedDocumentFieldsWithConfidence = {};

  for (const line of lines) {
    const generic = line.match(LABEL_VALUE);
    if (!generic) continue;

    const label = line.split(':')[0]?.trim().toLowerCase() ?? '';
    const value = generic[1].trim();
    if (!value) continue;

    if (/absender|von|auftraggeber|lieferant|aussteller|anbieter/.test(label)) {
      setField(fields, 'Absender', value, 'high');
      if (/lieferant|anbieter/.test(label)) {
        setField(fields, 'Lieferant', value, 'high');
      }
    }
    if (/empfänger|empfaenger|an|kunde|mandant/.test(label)) {
      setField(fields, 'Empfänger', value, 'high');
      setField(fields, 'Kunde', value, 'high');
    }
  }

  setField(
    fields,
    'Absender',
    pickLabeledValue(lines, /^(?:absender|von|auftraggeber|lieferant)\s*[:]\s*(.+)$/i),
    'high',
  );
  setField(
    fields,
    'Empfänger',
    pickLabeledValue(lines, /^(?:empfänger|empfaenger|an|kunde)\s*[:]\s*(.+)$/i),
    'high',
  );
  setField(fields, 'Kunde', fields.Empfänger?.value ?? pickLabeledValue(lines, /^kunde\s*[:]\s*(.+)$/i), 'high');
  setField(
    fields,
    'Lieferant',
    fields.Absender?.value ?? pickLabeledValue(lines, /^lieferant\s*[:]\s*(.+)$/i),
    'high',
  );

  const siteLine = lines.find((line) => SITE_PATTERN.test(line));
  if (siteLine) {
    const match = siteLine.match(SITE_PATTERN);
    const value = match?.[1]?.trim();
    if (value) {
      setField(fields, 'Baustelle', value, 'high');
      setField(fields, 'Projekt', value, 'medium');
      setField(fields, 'Vorgang', value, 'medium');
    }
  }

  const addressLine = lines.find((line) => ADDRESS_PATTERN.test(line));
  if (addressLine) {
    const match = addressLine.match(ADDRESS_PATTERN);
    if (match?.[1]?.trim()) {
      setField(fields, 'Straße', match[1].trim(), 'high');
      setField(fields, 'Baustelle', match[1].trim(), 'medium');
    }
  }

  const cityLine = lines.find((line) => CITY_PATTERN.test(line));
  if (cityLine) {
    const cityMatch = cityLine.match(CITY_PATTERN);
    if (cityMatch) {
      const cityValue = `${cityMatch[1]} ${cityMatch[2]}`.trim();
      const confidence: FieldConfidenceLevel = /adresse|straße|strasse|ort|baustelle/i.test(cityLine)
        ? 'high'
        : 'medium';
      setField(fields, 'Ort', cityValue, confidence);
      if (confidence === 'high') {
        setField(fields, 'Baustelle', cityValue, 'medium');
      }
    }
  }

  const labeledDate = pickLabeledValue(lines, /^(?:datum|vertragsdatum|belegdatum)\s*[:]\s*(.+)$/i);
  setField(fields, 'Datum', labeledDate ?? firstMatch(text, DATE_PATTERN), labeledDate ? 'high' : 'low');

  setField(fields, 'Rechnungsnummer', firstMatch(text, INVOICE_NUMBER_PATTERN), 'high');
  setField(fields, 'Aktenzeichen', firstMatch(text, REFERENCE_PATTERN), 'high');
  setField(fields, 'Betrag', firstMatch(text, AMOUNT_PATTERN), 'high');
  if (fields.Betrag?.value) {
    fields.Betrag = {
      value: normalizeAmount(fields.Betrag.value),
      confidence: fields.Betrag.confidence,
    };
  }
  setField(fields, 'Frist', firstMatch(text, DEADLINE_PATTERN), 'high');

  const subjectLine = lines.find((line) => /^betreff\s*[:]/i.test(line));
  if (subjectLine) {
    setField(fields, 'Betreff', subjectLine.replace(/^betreff\s*[:]\s*/i, '').trim(), 'high');
  }

  return fields;
}

export function toConfidentPlainFields(
  fields: ExtractedDocumentFieldsWithConfidence,
): ExtractedDocumentFields {
  const plain: ExtractedDocumentFields = {};
  for (const [key, field] of Object.entries(fields) as Array<
    [keyof ExtractedDocumentFields, ConfidentField]
  >) {
    if (!field || !isFieldConfidentEnough(field.confidence)) continue;
    plain[key] = field.value;
  }
  return plain;
}

export function listUncertainFieldKeys(
  fields: ExtractedDocumentFieldsWithConfidence,
): Array<keyof ExtractedDocumentFields> {
  return (Object.keys(fields) as Array<keyof ExtractedDocumentFields>).filter((key) => {
    const field = fields[key];
    return Boolean(field?.value?.trim()) && field?.confidence === 'low';
  });
}

export function extractFieldsFromText(text: string): ExtractedDocumentFields {
  return toConfidentPlainFields(extractFieldsWithConfidence(text));
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

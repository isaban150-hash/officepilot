import type { DocumentZone, EvidenceRef } from '../types/documentAnalysis';
import { clampAnalysisConfidence, isValidEvidenceRef } from '../types/documentAnalysis';
import type {
  DocumentFeatureCategory,
  DocumentFeatureExtractionResult,
  DocumentFeatureStrength,
} from '../types/documentFeatures';
import type { DocumentZonedText, ZonedLine } from '../types/documentZoning';
import { parseGermanMoney } from './documentAmountExtractionService';
import { findZonedLineAtOffset } from './documentZoningService';

const SENDER_LABEL_PATTERN =
  /^(?:absender|von|auftraggeber|lieferant|aussteller|anbieter)\s*[:]\s*(.+)$/i;
const RECIPIENT_LABEL_PATTERN =
  /^(?:empfänger|empfaenger|an|kunde|mandant)\s*[:]\s*(.+)$/i;
const DOCUMENT_DATE_PATTERN = /\b(\d{1,2}[./]\d{1,2}[./]\d{2,4})\b/;
const LABELED_DATE_PATTERN =
  /^(?:datum|vertragsdatum|belegdatum)\s*[:]\s*(\d{1,2}[./]\d{1,2}[./]\d{2,4})/i;
const DEADLINE_PATTERN =
  /\b(?:frist|fällig(?:keit| am)?|zahlbar bis|bis zum|zahlungsziel)\s*[:.]?\s*(\d{1,2}[./]\d{1,2}[./]\d{2,4})/i;
const INVOICE_NUMBER_PATTERN =
  /\b(?:rechnungs(?:nummer|nr\.?)|invoice(?:\s*no\.?)?|beleg(?:nummer|nr\.?))\s*[:#]?\s*([A-Z0-9][\w./-]{2,})/i;
const CASE_REFERENCE_PATTERN =
  /\b(?:aktenzeichen|az\.?|vorgang(?:snummer|snr\.?)?|auftrags(?:nummer|nr\.?)|beitrags(?:nummer|nr\.?)|referenz)\s*[:#]?\s*([A-Z0-9][\w./-]{2,})/i;
const MONETARY_VALUE_PATTERN =
  /\b(\d{1,3}(?:\.\d{3})*,\d{2})\s*(?:€|eur)?\b/i;
const LABELED_TOTAL_PATTERN =
  /\b(?:betrag|summe|gesamt|total)\s*[:]\s*(\d{1,3}(?:[.\s]\d{3})*,\d{2}\s*€?|\d{1,3}(?:[.\s]\d{3})*,\d{2}\s*(?:EUR|eur))/i;
const IBAN_PATTERN = /\b([A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){3,7}\s?[A-Z0-9]{1,4})\b/i;
const HRB_HRA_PATTERN = /\b(HR[AB]\s*\d[\dA-Z./-]{1,})\b/i;
const COURT_MARKER_PATTERN = /\b(Amtsgericht\s+[\p{L}\-]+(?:\s+[\p{L}\-]+)*)/iu;
const MANAGING_DIRECTOR_PATTERN =
  /\b(Geschäftsführer(?:in)?|Inhaber(?:in)?)\s*[:.]?\s*([\p{L}\-]+(?:\s+[\p{L}\-]+)*)/iu;
const PAYMENT_REQUEST_PATTERN =
  /\b(zahlungsaufforderung|zahlungserinnerung|zahlungsfrist|zu\s+zahlen|zahlbar\s+bis|mahnung|inkasso)\b/i;
const MAHNUNG_MARKER_PATTERN = /\b(\d+\.\s*mahnung|mahnung|inkasso|zahlungsaufforderung)\b/i;
const ZAHLUNGSERINNERUNG_MARKER_PATTERN = /\b(zahlungserinnerung)\b/i;
const CARD_PAYMENT_PATTERN =
  /\b(kartenzahlung|girocard|ec-cash|ec\s+zahlung|visa|mastercard|kreditkarte|contactless|terminal)\b/i;
const EC_MARKER_PATTERN = /\b(ec-beleg|ec beleg|girocard|ec-cash|ec\s+zahlung)\b/i;
const KREDITKARTEN_MARKER_PATTERN =
  /\b(kreditkartenbeleg|visa|mastercard|contactless|kreditkarte)\b/i;
const QUITTUNG_MARKER_PATTERN = /\b(quittung|bar erhalten|quittung über)\b/i;
const FUEL_MARKER_PATTERN =
  /\b(kraftstoff|diesel|benzin|super|e10|adblue|erdgas|cng|lpg|tankstelle)\b/i;
const AUTHORITY_MARKER_PATTERN =
  /\b(finanzamt|steueramt|steuerbescheid|bg[\s-]?bau|berufsgenossenschaft|krankenkasse|soka[\s-]?bau|zollamt|sozialversicherung|agentur\s+für\s+arbeit|jobcenter|stadtverwaltung|gemeindeverwaltung|landratsamt|ordnungsamt)\b/i;
const FINANZAMT_MARKER_PATTERN = /\b(finanzamt|steuernummer|umsatzsteuer|lohnsteuer|steueramt)\b/i;
const BG_BAU_MARKER_PATTERN =
  /\b(bg[\s-]?bau|berufsgenossenschaft\s+(der\s+)?bauwirtschaft)\b/i;
const KRANKENKASSE_MARKER_PATTERN =
  /\bkrankenkasse\b|\bgesetzliche\s+krankenversicherung\b|krankenversicherungsbeitrag/i;
const SOKA_BAU_MARKER_PATTERN =
  /\bsoka[\s-]?bau\b|urlaubs-?\s*und\s*lohnausgleichskasse|lohnausgleichskasse\s+der\s+bauwirtschaft/i;
const STEUERBESCHEID_MARKER_PATTERN = /\b(steuerbescheid|festsetzung|einkommensteuerbescheid)\b/i;
const FREISTELLUNG_MARKER_PATTERN = /\b(freistellungsbescheinigung|§48b|§48\s*b)\b/i;
const UNBEDENKLICHKEIT_MARKER_PATTERN = /\b(unbedenklichkeitsbescheinigung|unbedenklichkeit)\b/i;
const WERKVERTRAG_MARKER_PATTERN = /\b(werkvertrag|werk[\s-]?vertrag)\b/i;
const SUBUNTERNEHMER_MARKER_PATTERN =
  /\b(subunternehmervertrag|subunternehmer[\s-]?vertrag|bau-?subunternehmer)\b/i;
const NACHUNTERNEHMER_MARKER_PATTERN =
  /\b(nachunternehmervertrag|nachunternehmer[\s-]?vertrag)\b/i;
const LEISTUNGSVERZEICHNIS_MARKER_PATTERN = /\b(leistungsverzeichnis)\b/i;
const CONTRACT_PARTY_LINE_PATTERN =
  /^(?:auftraggeber(?:in)?|auftragnehmer(?:in)?|subunternehmer|nachunternehmer)\s*[:]/i;
const CONTRACT_DATE_LINE_PATTERN =
  /^vertragsdatum\s*[:]\s*(\d{1,2}[./]\d{1,2}[./]\d{2,4})/i;
const VALID_UNTIL_PATTERN =
  /\b(?:gültig bis|gueltig bis|gültigkeit|gueltigkeit|valid until)\s*[:.]?\s*(\d{1,2}[./]\d{1,2}[./]\d{2,4})/i;

type PatternFeatureSpec = {
  id: string;
  category: DocumentFeatureCategory;
  pattern: RegExp;
  labeled?: boolean;
  valueFromMatch?: (match: RegExpMatchArray) => string | number | boolean | undefined;
};

const PATTERN_FEATURES: PatternFeatureSpec[] = [
  {
    id: 'date.document_date',
    category: 'date',
    pattern: DOCUMENT_DATE_PATTERN,
    valueFromMatch: (match) => match[1],
  },
  {
    id: 'date.deadline_date',
    category: 'date',
    pattern: DEADLINE_PATTERN,
    labeled: true,
    valueFromMatch: (match) => match[1],
  },
  {
    id: 'reference.invoice_number',
    category: 'reference',
    pattern: INVOICE_NUMBER_PATTERN,
    labeled: true,
    valueFromMatch: (match) => match[1],
  },
  {
    id: 'reference.case_reference',
    category: 'reference',
    pattern: CASE_REFERENCE_PATTERN,
    labeled: true,
    valueFromMatch: (match) => match[1],
  },
  {
    id: 'amount.monetary_value',
    category: 'amount',
    pattern: MONETARY_VALUE_PATTERN,
    valueFromMatch: (match) => parseGermanMoney(match[1]),
  },
  {
    id: 'amount.labeled_total',
    category: 'amount',
    pattern: LABELED_TOTAL_PATTERN,
    labeled: true,
    valueFromMatch: (match) => parseGermanMoney(match[1]),
  },
  {
    id: 'payment.iban',
    category: 'payment',
    pattern: IBAN_PATTERN,
    labeled: true,
    valueFromMatch: (match) => match[1].replace(/\s+/g, '').toUpperCase(),
  },
  {
    id: 'register.hrb_hra_number',
    category: 'register',
    pattern: HRB_HRA_PATTERN,
    valueFromMatch: (match) => match[1].replace(/\s+/g, ' ').trim(),
  },
  {
    id: 'register.court_marker',
    category: 'register',
    pattern: COURT_MARKER_PATTERN,
    valueFromMatch: (match) => match[1].trim(),
  },
  {
    id: 'register.managing_director_marker',
    category: 'register',
    pattern: MANAGING_DIRECTOR_PATTERN,
    labeled: true,
    valueFromMatch: (match) => match[2]?.trim(),
  },
  {
    id: 'structure.payment_request',
    category: 'structure',
    pattern: PAYMENT_REQUEST_PATTERN,
    valueFromMatch: () => true,
  },
  {
    id: 'structure.mahnung_marker',
    category: 'structure',
    pattern: MAHNUNG_MARKER_PATTERN,
    valueFromMatch: (match) => match[1]?.trim() ?? match[0]?.trim(),
  },
  {
    id: 'structure.zahlungserinnerung_marker',
    category: 'structure',
    pattern: ZAHLUNGSERINNERUNG_MARKER_PATTERN,
    valueFromMatch: (match) => match[1]?.trim() ?? match[0]?.trim(),
  },
  {
    id: 'payment.card_payment',
    category: 'payment',
    pattern: CARD_PAYMENT_PATTERN,
    labeled: true,
    valueFromMatch: () => true,
  },
  {
    id: 'structure.ec_marker',
    category: 'structure',
    pattern: EC_MARKER_PATTERN,
    valueFromMatch: (match) => match[0]?.trim(),
  },
  {
    id: 'structure.kreditkarten_marker',
    category: 'structure',
    pattern: KREDITKARTEN_MARKER_PATTERN,
    valueFromMatch: (match) => match[0]?.trim(),
  },
  {
    id: 'structure.quittung_marker',
    category: 'structure',
    pattern: QUITTUNG_MARKER_PATTERN,
    valueFromMatch: (match) => match[0]?.trim(),
  },
  {
    id: 'structure.fuel_marker',
    category: 'structure',
    pattern: FUEL_MARKER_PATTERN,
    valueFromMatch: () => true,
  },
  {
    id: 'structure.finanzamt_marker',
    category: 'structure',
    pattern: FINANZAMT_MARKER_PATTERN,
    valueFromMatch: (match) => match[0]?.trim(),
  },
  {
    id: 'structure.bg_bau_marker',
    category: 'structure',
    pattern: BG_BAU_MARKER_PATTERN,
    valueFromMatch: (match) => match[0]?.trim(),
  },
  {
    id: 'structure.krankenkasse_marker',
    category: 'structure',
    pattern: KRANKENKASSE_MARKER_PATTERN,
    valueFromMatch: (match) => match[0]?.trim(),
  },
  {
    id: 'structure.soka_bau_marker',
    category: 'structure',
    pattern: SOKA_BAU_MARKER_PATTERN,
    valueFromMatch: (match) => match[0]?.trim(),
  },
  {
    id: 'structure.steuerbescheid_marker',
    category: 'structure',
    pattern: STEUERBESCHEID_MARKER_PATTERN,
    valueFromMatch: (match) => match[0]?.trim(),
  },
  {
    id: 'structure.freistellung_marker',
    category: 'structure',
    pattern: FREISTELLUNG_MARKER_PATTERN,
    valueFromMatch: (match) => match[0]?.trim(),
  },
  {
    id: 'structure.unbedenklichkeit_marker',
    category: 'structure',
    pattern: UNBEDENKLICHKEIT_MARKER_PATTERN,
    valueFromMatch: (match) => match[0]?.trim(),
  },
  {
    id: 'structure.werkvertrag_marker',
    category: 'structure',
    pattern: WERKVERTRAG_MARKER_PATTERN,
    valueFromMatch: (match) => match[0]?.trim(),
  },
  {
    id: 'structure.subunternehmer_marker',
    category: 'structure',
    pattern: SUBUNTERNEHMER_MARKER_PATTERN,
    valueFromMatch: (match) => match[0]?.trim(),
  },
  {
    id: 'structure.nachunternehmer_marker',
    category: 'structure',
    pattern: NACHUNTERNEHMER_MARKER_PATTERN,
    valueFromMatch: (match) => match[0]?.trim(),
  },
  {
    id: 'structure.leistungsverzeichnis_marker',
    category: 'structure',
    pattern: LEISTUNGSVERZEICHNIS_MARKER_PATTERN,
    valueFromMatch: (match) => match[0]?.trim(),
  },
  {
    id: 'date.valid_until',
    category: 'date',
    pattern: VALID_UNTIL_PATTERN,
    labeled: true,
    valueFromMatch: (match) => match[1],
  },
];

function deriveStrength(
  category: DocumentFeatureCategory,
  zone: DocumentZone,
  labeled: boolean,
): DocumentFeatureStrength {
  if (category === 'register' && zone === 'footer') {
    return 'weak';
  }
  if (category === 'structure') {
    return 'medium';
  }
  if (category === 'identity') {
    return zone === 'header' ? 'strong' : 'medium';
  }
  if ((category === 'amount' || category === 'reference') && zone === 'body') {
    return labeled ? 'strong' : 'medium';
  }
  if (category === 'payment') {
    return 'medium';
  }
  if (category === 'date') {
    return labeled ? 'strong' : 'medium';
  }
  return 'medium';
}

function deriveConfidence(strength: DocumentFeatureStrength, labeled: boolean): number {
  if (strength === 'strong') {
    return clampAnalysisConfidence(labeled ? 0.9 : 0.82);
  }
  if (strength === 'medium') {
    return clampAnalysisConfidence(labeled ? 0.78 : 0.72);
  }
  return clampAnalysisConfidence(0.55);
}

function buildEvidenceRef(
  evidenceId: string,
  zonedLine: ZonedLine,
  snippet: string,
  startOffset: number,
  endOffset: number,
): EvidenceRef {
  return {
    id: evidenceId,
    zone: zonedLine.zone,
    snippet: snippet.trim(),
    startOffset,
    endOffset,
    startLine: zonedLine.lineIndex + 1,
    endLine: zonedLine.lineIndex + 1,
    pageNumber: zonedLine.pageNumber,
  };
}

function addLineFeature(
  result: DocumentFeatureExtractionResult,
  counters: Record<string, number>,
  spec: {
    id: string;
    category: DocumentFeatureCategory;
    line: ZonedLine;
    rawValue: string;
    value?: string | number | boolean;
    labeled?: boolean;
    startOffset: number;
    endOffset: number;
  },
): void {
  const index = counters[spec.id] ?? 0;
  counters[spec.id] = index + 1;
  const evidenceId = `feature:${spec.id}:${index}`;
  const strength = deriveStrength(spec.category, spec.line.zone, Boolean(spec.labeled));
  const confidence = deriveConfidence(strength, Boolean(spec.labeled));

  result.evidenceIndex[evidenceId] = buildEvidenceRef(
    evidenceId,
    spec.line,
    spec.rawValue,
    spec.startOffset,
    spec.endOffset,
  );
  result.features.push({
    id: spec.id,
    category: spec.category,
    value: spec.value,
    rawValue: spec.rawValue,
    confidence,
    strength,
    zone: spec.line.zone,
    evidenceRefs: [evidenceId],
    source: 'rules',
  });
}

function extractIdentityFeatures(
  zonedText: DocumentZonedText,
  result: DocumentFeatureExtractionResult,
  counters: Record<string, number>,
): void {
  for (const line of zonedText.lines) {
    const trimmed = line.text.trim();
    if (!trimmed) {
      continue;
    }

    const senderMatch = trimmed.match(SENDER_LABEL_PATTERN);
    if (senderMatch?.[1]?.trim()) {
      const value = senderMatch[1].trim();
      const valueStart = line.startOffset + line.text.indexOf(value);
      addLineFeature(result, counters, {
        id: 'identity.sender_labeled',
        category: 'identity',
        line,
        rawValue: trimmed,
        value,
        labeled: true,
        startOffset: valueStart,
        endOffset: valueStart + value.length,
      });
    }

    const recipientMatch = trimmed.match(RECIPIENT_LABEL_PATTERN);
    if (recipientMatch?.[1]?.trim()) {
      const value = recipientMatch[1].trim();
      const valueStart = line.startOffset + line.text.indexOf(value);
      addLineFeature(result, counters, {
        id: 'identity.recipient_labeled',
        category: 'identity',
        line,
        rawValue: trimmed,
        value,
        labeled: true,
        startOffset: valueStart,
        endOffset: valueStart + value.length,
      });
    }

    const contractPartyMatch = trimmed.match(CONTRACT_PARTY_LINE_PATTERN);
    if (contractPartyMatch) {
      const marker = contractPartyMatch[0];
      const markerStart = line.startOffset + line.text.indexOf(marker);
      addLineFeature(result, counters, {
        id: 'structure.contract_party_marker',
        category: 'structure',
        line,
        rawValue: trimmed,
        value: true,
        labeled: true,
        startOffset: markerStart,
        endOffset: markerStart + marker.length,
      });
    }

    const contractDateMatch = trimmed.match(CONTRACT_DATE_LINE_PATTERN);
    if (contractDateMatch?.[1]) {
      const value = contractDateMatch[1];
      const valueStart = line.startOffset + line.text.indexOf(value);
      addLineFeature(result, counters, {
        id: 'date.contract_date',
        category: 'date',
        line,
        rawValue: trimmed,
        value,
        labeled: true,
        startOffset: valueStart,
        endOffset: valueStart + value.length,
      });
    }

    const labeledDateMatch = trimmed.match(LABELED_DATE_PATTERN);
    if (labeledDateMatch?.[1] && !/^vertragsdatum\s*[:]/i.test(trimmed)) {
      const value = labeledDateMatch[1];
      const valueStart = line.startOffset + line.text.indexOf(value);
      addLineFeature(result, counters, {
        id: 'date.document_date',
        category: 'date',
        line,
        rawValue: trimmed,
        value,
        labeled: true,
        startOffset: valueStart,
        endOffset: valueStart + value.length,
      });
    }
  }
}

function extractPatternFeatures(
  zonedText: DocumentZonedText,
  result: DocumentFeatureExtractionResult,
  counters: Record<string, number>,
): void {
  const text = zonedText.originalText;

  for (const spec of PATTERN_FEATURES) {
    const regex = new RegExp(spec.pattern.source, spec.pattern.flags.includes('g') ? spec.pattern.flags : `${spec.pattern.flags}g`);
    let match: RegExpExecArray | null;

    while ((match = regex.exec(text)) !== null) {
      const startOffset = match.index;
      const endOffset = startOffset + match[0].length;
      const zonedLine = findZonedLineAtOffset(zonedText, startOffset);
      if (!zonedLine || zonedLine.zone === 'unknown') {
        continue;
      }

      const index = counters[spec.id] ?? 0;
      counters[spec.id] = index + 1;
      const evidenceId = `feature:${spec.id}:${index}`;
      const strength = deriveStrength(spec.category, zonedLine.zone, Boolean(spec.labeled));
      const confidence = deriveConfidence(strength, Boolean(spec.labeled));

      result.evidenceIndex[evidenceId] = buildEvidenceRef(
        evidenceId,
        zonedLine,
        match[0],
        startOffset,
        endOffset,
      );
      result.features.push({
        id: spec.id,
        category: spec.category,
        value: spec.valueFromMatch?.(match),
        rawValue: match[0],
        confidence,
        strength,
        zone: zonedLine.zone,
        evidenceRefs: [evidenceId],
        source: 'rules',
      });
    }
  }
}

function extractStructureFeatures(
  zonedText: DocumentZonedText,
  result: DocumentFeatureExtractionResult,
  counters: Record<string, number>,
): void {
  const meaningfulLines = zonedText.lines.filter(
    (line) => line.zone !== 'unknown' && line.text.trim().length > 0,
  );

  const authorityLine = meaningfulLines.find((line) => AUTHORITY_MARKER_PATTERN.test(line.text));
  if (authorityLine) {
    const match = authorityLine.text.match(AUTHORITY_MARKER_PATTERN);
    if (match) {
      const marker = match[0];
      const startOffset = authorityLine.startOffset + authorityLine.text.indexOf(marker);
      addLineFeature(result, counters, {
        id: 'structure.authority_letter',
        category: 'structure',
        line: authorityLine,
        rawValue: authorityLine.text.trim(),
        value: true,
        startOffset,
        endOffset: startOffset + marker.length,
      });
    }
  }

  const amountLine =
    zonedText.bodyLines.find((line) => MONETARY_VALUE_PATTERN.test(line.text)) ??
    zonedText.headerLines.find((line) => MONETARY_VALUE_PATTERN.test(line.text));
  const hasInvoiceNumberInBody = zonedText.bodyLines.some((line) =>
    INVOICE_NUMBER_PATTERN.test(line.text),
  );
  const isReceiptLayout =
    meaningfulLines.length <= 12 &&
    Boolean(amountLine) &&
    !hasInvoiceNumberInBody;

  if (isReceiptLayout && amountLine) {
    const match = amountLine.text.match(MONETARY_VALUE_PATTERN);
    if (match) {
      const marker = match[0];
      const startOffset = amountLine.startOffset + amountLine.text.indexOf(marker);
      addLineFeature(result, counters, {
        id: 'structure.receipt_layout',
        category: 'structure',
        line: amountLine,
        rawValue: amountLine.text.trim(),
        value: true,
        startOffset,
        endOffset: startOffset + marker.length,
      });
    }
  }
}

export function extractDocumentFeatures(zonedText: DocumentZonedText): DocumentFeatureExtractionResult {
  const result: DocumentFeatureExtractionResult = {
    features: [],
    evidenceIndex: {},
    warnings: [],
  };
  const counters: Record<string, number> = {};

  if (!zonedText.originalText.trim()) {
    result.warnings.push('feature_extraction:no_text');
    return result;
  }

  extractIdentityFeatures(zonedText, result, counters);
  extractPatternFeatures(zonedText, result, counters);
  extractStructureFeatures(zonedText, result, counters);

  return result;
}

export function validateFeatureExtractionResult(result: DocumentFeatureExtractionResult): boolean {
  for (const [evidenceId, evidenceRef] of Object.entries(result.evidenceIndex)) {
    if (!isValidEvidenceRef(evidenceRef) || evidenceRef.id !== evidenceId) {
      return false;
    }
  }

  return result.features.every((feature) => {
    if (!feature.id.trim() || !feature.evidenceRefs.length) {
      return false;
    }
    if (feature.confidence < 0 || feature.confidence > 1) {
      return false;
    }
    return feature.evidenceRefs.every(
      (refId) => refId in result.evidenceIndex && isValidEvidenceRef(result.evidenceIndex[refId]),
    );
  });
}

export function mergeFeatureEvidenceIndex(
  zoneEvidenceIndex: Record<string, EvidenceRef>,
  featureResult: DocumentFeatureExtractionResult,
): Record<string, EvidenceRef> {
  return {
    ...zoneEvidenceIndex,
    ...featureResult.evidenceIndex,
  };
}

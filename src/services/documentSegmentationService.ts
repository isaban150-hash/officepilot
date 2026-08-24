import type {
  DocumentPageSection,
  DocumentPageText,
  DocumentSectionType,
  DocumentSegmentationResult,
} from '../types/documentIntelligence';

const CONTRACT_CORE_MARKERS =
  /werkvertrag|bau[\s-]?subunternehmer|subunternehmervertrag|nachunternehmervertrag|auftraggeber|auftragnehmer|vertragsgegenstand|vergütung|zahlungsbedingungen|zahlungsziel|abschlagsrechnung|schlussrechnung|bauabzugsteuer|freistellungsbescheinigung|nachweispflicht|unterschrift|vertragsdatum|gewährleistungsfrist|vertragsstrafe|allgemeine\s+vertragsbedingungen|besondere\s+vertragsbedingungen/i;

/** Headline of a contract document — the strongest single page signal there is. */
const CONTRACT_HEADING =
  /\b(?:werkvertrag|bau[\s-]?subunternehmervertrag|subunternehmervertrag|nachunternehmervertrag|dienstleistungsvertrag|wartungsvertrag)\b/i;
/** Numbered contract sections, e.g. "§ 3 Vergütung". */
const CONTRACT_SECTION_MARKER = /§\s*\d{1,3}\b/g;

const BOQ_MARKERS =
  /leistungsverzeichnis|\blv\b|pos\.?\s|menge\s+einheit|einheit\s+bezeichnung|einzelpreis|gesamtsumme\s+netto|gesamtpreis/i;

const TECHNICAL_MARKERS =
  /(?<!be)zeichnung|windlastberechnung|befestigungsplan|montagezeichnung|detailzeichnung|technische\s+berechnung|maßstab|schnitt\s+[a-z]\s*[-–]|grundriss|ansicht|statik|tragwerk|cad|dwg|planausschnitt/i;

const COMMERCIAL_ATTACHMENT_MARKERS =
  /agb|allgemeine\s+geschäftsbedingungen|versicherungsbedingungen|preisliste|konditionenblatt/i;

const BOQ_ROW_PATTERN =
  /^\d{1,3}\s+[\d.,]+\s+(?:qm|m²|m2|lfdm|lfm|m|st\.?|stk|stück|std\.?|kg|pauschal)/i;

/**
 * Column headline of a real bill of quantities, e.g.
 * "Pos. Menge Einh. Bezeichnung EP netto Gesamt netto".
 * Counted per line: three of these tokens side by side are a table, not prose.
 */
const BOQ_COLUMN_TOKENS: readonly RegExp[] = [
  /\bpos\.?(?:\s|$)/i,
  /\bmenge\b/i,
  /\beinh(?:eit)?\.?\b/i,
  /\bbezeichnung\b/i,
  /\b(?:ep|einzelpreis)\b/i,
  /\b(?:gp|gesamt(?:preis|summe)?)\b/i,
];

/** A line carrying at least three column tokens — a bill-of-quantities table head. */
function hasBoqTableHeadline(text: string): boolean {
  return text.split('\n').some((line) => {
    const trimmed = line.trim();
    if (!trimmed) return false;
    return BOQ_COLUMN_TOKENS.filter((token) => token.test(trimmed)).length >= 3;
  });
}

/**
 * Structural proof that this page IS a bill of quantities, as opposed to a
 * contract page that merely refers to one. Either several real position lines,
 * or a table headline with at least one position line below it.
 */
function hasBillOfQuantitiesStructure(text: string, boqRowCount: number): boolean {
  if (boqRowCount >= 2) return true;
  return boqRowCount >= 1 && hasBoqTableHeadline(text);
}

/**
 * Structural proof that this page IS contract text. Deliberately not "any
 * contract word": a contract page carries a document headline, a party block or
 * a run of numbered sections. This is what allows a page to keep its contract
 * nature while naming its bill of quantities as a contractual basis.
 */
function hasContractStructure(text: string): boolean {
  if (!CONTRACT_CORE_MARKERS.test(text)) return false;
  if (CONTRACT_HEADING.test(text)) return true;
  if (/auftraggeber/i.test(text) && /auftragnehmer/i.test(text)) return true;
  return (text.match(CONTRACT_SECTION_MARKER) ?? []).length >= 2;
}

export function buildPageMarker(pageNumber: number): string {
  return `\n\n---SEITE ${pageNumber}---\n\n`;
}

export function splitTextIntoPages(fullText: string): DocumentPageText[] {
  const parts = fullText.split(/---SEITE\s+(\d+)---/i);
  if (parts.length <= 1) {
    return fullText.trim() ? [{ pageNumber: 1, text: fullText.trim() }] : [];
  }

  const pages: DocumentPageText[] = [];
  if (parts[0]?.trim()) {
    pages.push({ pageNumber: 1, text: parts[0].trim() });
  }

  for (let index = 1; index < parts.length; index += 2) {
    const pageNumber = Number(parts[index]);
    const text = parts[index + 1]?.trim() ?? '';
    if (Number.isFinite(pageNumber) && text) {
      pages.push({ pageNumber, text });
    }
  }

  return pages.length > 0 ? pages : [{ pageNumber: 1, text: fullText.trim() }];
}

function classifyPageText(text: string, pageNumber: number, priorSections: DocumentSectionType[]): DocumentPageSection {
  const trimmed = text.trim();
  const preview = trimmed.slice(0, 160);
  const lower = trimmed.toLowerCase();

  if (!trimmed) {
    return { pageNumber, sectionType: 'unknown', confidence: 'low', textPreview: '' };
  }

  const boqRowCount = (trimmed.match(new RegExp(BOQ_ROW_PATTERN.source, 'gim')) ?? []).length;
  const hasBoqHeader = BOQ_MARKERS.test(trimmed);
  const hasTechnical = TECHNICAL_MARKERS.test(trimmed);
  const hasContract = CONTRACT_CORE_MARKERS.test(trimmed);

  // 1. Proven bill-of-quantities structure wins over everything — a page full of
  //    position lines stays a bill of quantities even if it quotes the contract.
  if (hasBillOfQuantitiesStructure(trimmed, boqRowCount) && !hasTechnical) {
    return { pageNumber, sectionType: 'bill_of_quantities', confidence: boqRowCount >= 2 ? 'high' : 'medium', textPreview: preview };
  }

  // 2. Proven contract structure beats a mere mention of a bill of quantities.
  //    Naming the Leistungsverzeichnis as a contractual basis or as the basis of
  //    settlement is ordinary contract wording and must not move the page.
  if (hasContractStructure(trimmed) && !hasTechnical) {
    return { pageNumber, sectionType: 'contract_core', confidence: pageNumber <= 10 ? 'high' : 'medium', textPreview: preview };
  }

  // 3. Bill-of-quantities wording without any contract structure — unchanged
  //    behaviour for continuation pages that carry no position lines of their own.
  if ((hasBoqHeader || boqRowCount >= 2) && !hasTechnical) {
    return { pageNumber, sectionType: 'bill_of_quantities', confidence: boqRowCount >= 2 ? 'high' : 'medium', textPreview: preview };
  }

  if (hasTechnical && !hasContract && boqRowCount === 0) {
    return { pageNumber, sectionType: 'technical_attachment', confidence: 'high', textPreview: preview };
  }

  if (COMMERCIAL_ATTACHMENT_MARKERS.test(trimmed) && !hasContract) {
    return { pageNumber, sectionType: 'commercial_attachment', confidence: 'medium', textPreview: preview };
  }

  if (hasContract) {
    return { pageNumber, sectionType: 'contract_core', confidence: pageNumber <= 10 ? 'high' : 'medium', textPreview: preview };
  }

  if (
    priorSections.includes('contract_core') &&
    !priorSections.includes('bill_of_quantities') &&
    !hasTechnical &&
    boqRowCount === 0 &&
    !hasBoqHeader
  ) {
    return { pageNumber, sectionType: 'contract_core', confidence: 'medium', textPreview: preview };
  }

  if (priorSections.includes('bill_of_quantities') && (hasTechnical || boqRowCount === 0)) {
    return { pageNumber, sectionType: 'technical_attachment', confidence: 'medium', textPreview: preview };
  }

  if (pageNumber <= 12 && priorSections.length === 0) {
    return { pageNumber, sectionType: 'contract_core', confidence: 'low', textPreview: preview };
  }

  if (/^\d{1,3}\s*$/.test(trimmed) || lower.length < 40) {
    return { pageNumber, sectionType: 'unknown', confidence: 'low', textPreview: preview };
  }

  return { pageNumber, sectionType: 'unknown', confidence: 'low', textPreview: preview };
}

export function segmentDocumentPages(pageTexts: DocumentPageText[]): DocumentSegmentationResult {
  const sorted = [...pageTexts].sort((a, b) => a.pageNumber - b.pageNumber);
  const priorSections: DocumentSectionType[] = [];
  const pages = sorted.map((page) => {
    const section = classifyPageText(page.text, page.pageNumber, priorSections);
    priorSections.push(section.sectionType);
    return section;
  });

  const pick = (type: DocumentSectionType) => pages.filter((p) => p.sectionType === type).map((p) => p.pageNumber);

  return {
    pages,
    contractCorePages: pick('contract_core'),
    billOfQuantitiesPages: pick('bill_of_quantities'),
    technicalAttachmentPages: pick('technical_attachment'),
    commercialAttachmentPages: pick('commercial_attachment'),
    unknownPages: pick('unknown'),
  };
}

export function joinSectionText(pageTexts: DocumentPageText[], pageNumbers: number[]): string {
  const set = new Set(pageNumbers);
  return pageTexts
    .filter((page) => set.has(page.pageNumber))
    .sort((a, b) => a.pageNumber - b.pageNumber)
    .map((page) => page.text)
    .join('\n\n')
    .trim();
}

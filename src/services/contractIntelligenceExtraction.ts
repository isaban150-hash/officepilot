import type {
  ContractFamily,
  ContractPartyRole,
  DetectedContractClause,
  DetectedContractClauseId,
  DetectedContractParty,
  DetectedContractType,
  DocumentPageText,
  ExtractedContractField,
  EnhancedDetectedOrderPosition,
  FieldConfidenceLevel,
} from '../types/documentIntelligence';

interface StructuredDocumentPageText extends DocumentPageText {
  items?: Array<string | { str?: string }>;
}
import { parseGermanMoney } from './documentAmountExtractionService';
import { joinSectionText } from './documentSegmentationService';

export const CONSTRUCTION_FAMILIES = new Set<ContractFamily>([
  'werkvertrag',
  'subunternehmervertrag',
]);

/** Type-specific field keys that must not appear for other families. */
export const TYPE_SPECIFIC_FIELD_KEYS: Record<ContractFamily, readonly string[]> = {
  werkvertrag: [
    'auftraggeber',
    'auftragnehmer',
    'bauvorhaben',
    'baustelle',
    'ausfuehrungsbeginn',
    'fertigstellung',
    'stundenlohn',
    'wartezeitregelung',
    'sicherheitseinbehalt',
    'vertragsstrafe',
    'bgBau',
    'sokaBau',
  ],
  subunternehmervertrag: [
    'auftraggeber',
    'auftragnehmer',
    'bauvorhaben',
    'baustelle',
    'ausfuehrungsbeginn',
    'fertigstellung',
    'stundenlohn',
    'wartezeitregelung',
    'sicherheitseinbehalt',
    'vertragsstrafe',
    'bgBau',
    'sokaBau',
  ],
  dienstleistungsvertrag: [
    'leistungsbeschreibung',
    'leistungsintervall',
    'reaktionszeit',
    'servicezeit',
    'pauschale',
    'stundenverrechnungssatz',
    'materialkosten',
  ],
  wartungsvertrag: [
    'leistungsbeschreibung',
    'leistungsintervall',
    'reaktionszeit',
    'servicezeit',
    'pauschale',
    'stundenverrechnungssatz',
    'materialkosten',
  ],
  mietvertrag: [
    'vermieter',
    'mieter',
    'mietobjekt',
    'mietbeginn',
    'kaltmiete',
    'nebenkosten',
    'kaution',
    'indexierung',
  ],
  leasingvertrag: [
    'leasinggeber',
    'leasingnehmer',
    'leasingobjekt',
    'leasingrate',
    'sonderzahlung',
    'kilometergrenze',
    'restwert',
    'rueckgabe',
  ],
  liefervertrag: [
    'verkaeufer',
    'kaeufer',
    'liefergegenstand',
    'liefermenge',
    'liefertermin',
    'lieferort',
    'eigentumsvorbehalt',
  ],
  kaufvertrag: [
    'verkaeufer',
    'kaeufer',
    'liefergegenstand',
    'liefermenge',
    'liefertermin',
    'lieferort',
    'eigentumsvorbehalt',
  ],
  rahmenvertrag: ['rahmenvolumen', 'abrufregelung'],
  versicherungsvertrag: [
    'versicherer',
    'versicherungsnehmer',
    'versicherungsart',
    'versicherungsschein',
    'beitrag',
    'deckung',
    'selbstbeteiligung',
  ],
  arbeitsvertrag: [
    'arbeitgeber',
    'arbeitnehmer',
    'taetigkeit',
    'eintrittsdatum',
    'arbeitsort',
    'arbeitszeit',
    'probezeit',
    'urlaub',
    'befristung',
  ],
  general_contract: [],
  unknown: [],
};

const COMMON_FIELD_KEYS = [
  'vertragsnummer',
  'vertragsdatum',
  'beginn',
  'laufzeit',
  'ende',
  'kuendigungsfrist',
  'verlaengerung',
  'vertragsgegenstand',
  'leistungsort',
  'zahlungsbedingungen',
  'gewaehrleistung',
  'haftung',
  'ansprechpartner',
] as const;

type FamilyRule = {
  family: ContractFamily;
  labelKey: string;
  heading: RegExp;
  roles: RegExp;
  topics: RegExp;
};

const FAMILY_RULES: FamilyRule[] = [
  {
    family: 'subunternehmervertrag',
    labelKey: 'documentIntelligence.label.subunternehmervertrag',
    heading: /bau[\s-]?subunternehmervertrag|subunternehmervertrag|nachunternehmervertrag/i,
    roles: /subunternehmer|nachunternehmer/i,
    topics: /baustelle|leistungsverzeichnis|behinderungsanzeige|bg[\s-]?bau/i,
  },
  {
    family: 'werkvertrag',
    labelKey: 'documentIntelligence.label.werkvertrag',
    heading: /\bwerkvertrag\b|\bbauvertrag\b/i,
    roles: /auftraggeber|auftragnehmer|subunternehmer/i,
    // "Abnahme" alone is too weak — common in non-construction contracts.
    topics: /baustelle|bauvorhaben|leistungsverzeichnis|gewerk|behinderungsanzeige/i,
  },
  {
    family: 'wartungsvertrag',
    labelKey: 'documentIntelligence.label.wartungsvertrag',
    heading: /\bwartungsvertrag\b|\bwartungsvertrages\b/i,
    roles: /dienstleister|auftraggeber|kunde/i,
    topics: /wartungsintervall|reaktionszeit|servicezeit|wartungs?pauschale/i,
  },
  {
    family: 'dienstleistungsvertrag',
    labelKey: 'documentIntelligence.label.dienstleistungsvertrag',
    heading: /\bdienstleistungsvertrag\b|\bservicevertrag\b/i,
    roles: /dienstleister|auftraggeber|kunde/i,
    topics: /leistungsbeschreibung|reaktionszeit|stundensatz|pauschale/i,
  },
  {
    family: 'mietvertrag',
    labelKey: 'documentIntelligence.label.mietvertrag',
    heading: /\bmietvertrag\b|\bmietvertrages\b/i,
    roles: /vermieter|mieter/i,
    topics: /kaltmiete|nebenkosten|kaution|mietobjekt|mietbeginn/i,
  },
  {
    family: 'leasingvertrag',
    labelKey: 'documentIntelligence.label.leasingvertrag',
    heading: /\bleasingvertrag\b|\bleasingvertrages\b/i,
    roles: /leasinggeber|leasingnehmer/i,
    topics: /leasingrate|restwert|kilometer|sonderzahlung|leasingobjekt/i,
  },
  {
    family: 'liefervertrag',
    labelKey: 'documentIntelligence.label.liefervertrag',
    heading: /\bliefervertrag\b|\bliefervertrages\b/i,
    roles: /lieferant|käufer|verkäufer|besteller/i,
    topics: /liefertermin|lieferort|eigentumsvorbehalt|waren/i,
  },
  {
    family: 'kaufvertrag',
    labelKey: 'documentIntelligence.label.kaufvertrag',
    heading: /\bkaufvertrag\b|\bkaufvertrages\b/i,
    roles: /verkäufer|käufer|verk[äa]ufer|k[äa]ufer/i,
    topics: /kaufgegenstand|eigentumsvorbehalt|kaufpreis/i,
  },
  {
    family: 'rahmenvertrag',
    labelKey: 'documentIntelligence.label.rahmenvertrag',
    heading: /\brahmenvertrag\b|\brahmenvertrages\b/i,
    roles: /auftraggeber|auftragnehmer|lieferant/i,
    topics: /abruf|rahmenvolumen|einzelauftrag/i,
  },
  {
    family: 'versicherungsvertrag',
    labelKey: 'documentIntelligence.label.versicherungsvertrag',
    heading: /\bversicherungsvertrag\b|versicherungsschein\b/i,
    roles: /versicherer|versicherungsnehmer/i,
    topics: /selbstbeteiligung|versicherungssumme|beitrag|deckung/i,
  },
  {
    family: 'arbeitsvertrag',
    labelKey: 'documentIntelligence.label.arbeitsvertrag',
    heading: /\barbeitsvertrag\b|\banstellungsvertrag\b/i,
    roles: /arbeitgeber|arbeitnehmer/i,
    topics: /probezeit|urlaub|wochenarbeitszeit|bruttogehalt|eintrittsdatum/i,
  },
];

/** Require an explicit label colon so signatures like "Unterschrift Auftragnehmer" do not capture the next line. */
const PARTY_PATTERNS: Array<{ role: ContractPartyRole; pattern: RegExp }> = [
  { role: 'auftraggeber', pattern: /auftraggeber(?:in)?\s*:\s*([^\n]+)/i },
  { role: 'auftragnehmer', pattern: /auftragnehmer(?:in)?\s*:\s*([^\n]+)/i },
  { role: 'subunternehmer', pattern: /subunternehmer(?:in)?\s*:\s*([^\n]+)/i },
  { role: 'nachunternehmer', pattern: /nachunternehmer(?:in)?\s*:\s*([^\n]+)/i },
  { role: 'vermieter', pattern: /vermieter(?:in)?\s*:\s*([^\n]+)/i },
  { role: 'mieter', pattern: /mieter(?:in)?\s*:\s*([^\n]+)/i },
  { role: 'leasinggeber', pattern: /leasinggeber(?:in)?\s*:\s*([^\n]+)/i },
  { role: 'leasingnehmer', pattern: /leasingnehmer(?:in)?\s*:\s*([^\n]+)/i },
  { role: 'verkaeufer', pattern: /verk[äa]ufer(?:in)?\s*:\s*([^\n]+)/i },
  { role: 'kaeufer', pattern: /k[äa]ufer(?:in)?\s*:\s*([^\n]+)/i },
  { role: 'versicherer', pattern: /versicherer\s*:\s*([^\n]+)/i },
  { role: 'versicherungsnehmer', pattern: /versicherungsnehmer(?:in)?\s*:\s*([^\n]+)/i },
  { role: 'arbeitgeber', pattern: /arbeitgeber(?:in)?\s*:\s*([^\n]+)/i },
  { role: 'arbeitnehmer', pattern: /arbeitnehmer(?:in)?\s*:\s*([^\n]+)/i },
  { role: 'dienstleister', pattern: /dienstleister\s*:\s*([^\n]+)/i },
  { role: 'kunde', pattern: /kunde\s*:\s*([^\n]+)/i },
];

const PARTY_LABELS: Array<{ role: ContractPartyRole; labels: string[] }> = [
  { role: 'auftraggeber', labels: ['auftraggeber'] },
  { role: 'auftragnehmer', labels: ['auftragnehmer'] },
  { role: 'subunternehmer', labels: ['subunternehmer', 'nachunternehmer'] },
  { role: 'nachunternehmer', labels: ['nachunternehmer'] },
  { role: 'vermieter', labels: ['vermieter'] },
  { role: 'mieter', labels: ['mieter'] },
  { role: 'leasinggeber', labels: ['leasinggeber'] },
  { role: 'leasingnehmer', labels: ['leasingnehmer'] },
  { role: 'verkaeufer', labels: ['verkäufer', 'verkäufer'] },
  { role: 'kaeufer', labels: ['käufer', 'käufer'] },
  { role: 'versicherer', labels: ['versicherer'] },
  { role: 'versicherungsnehmer', labels: ['versicherungsnehmer'] },
  { role: 'arbeitgeber', labels: ['arbeitgeber'] },
  { role: 'arbeitnehmer', labels: ['arbeitnehmer'] },
  { role: 'dienstleister', labels: ['dienstleister'] },
  { role: 'kunde', labels: ['kunde'] },
];

const CLAUSE_RULES: Array<{
  id: DetectedContractClauseId;
  patterns: RegExp[];
  context: RegExp;
  reject?: RegExp;
}> = [
  {
    id: 'nachtraege',
    patterns: [/nachtr[äa]ge?\b/i],
    context: /nachtr[äa]ge?.{0,40}(?:schriftform|bedürfen|beduerfen|vereinbarung)/i,
  },
  {
    id: 'behinderungsanzeige',
    patterns: [/behinderungsanzeige/i],
    context: /behinderungsanzeige.{0,60}(?:unverzüglich|schriftlich|anzeigen)/i,
  },
  {
    id: 'materialbereitstellung',
    patterns: [/materialbereitstellung/i],
    context: /materialbereitstellung.{0,80}(?:erfolgt|stellt|auftrag)/i,
  },
  {
    id: 'baustrom',
    patterns: [/baustrom/i],
    context: /baustrom.{0,60}(?:stellt|bereit|kostenfrei|auftrag)/i,
  },
  {
    id: 'bauwasser',
    patterns: [/bauwasser/i],
    context: /bauwasser.{0,60}(?:stellt|bereit|kostenfrei|auftrag)/i,
  },
  {
    id: 'geruest',
    patterns: [/gerüst|geruest/i],
    context: /(?:gerüst|geruest).{0,60}(?:stellt|gestellt|bereit|bedarf)/i,
  },
  {
    id: 'kran',
    patterns: [/\bkran\b/i],
    context: /\bkran\b.{0,60}(?:stellt|gestellt|bereit|bedarf)/i,
  },
  {
    id: 'entsorgung',
    patterns: [/entsorgung/i],
    context: /entsorgung.{0,80}(?:obliegt|erfolgt|auftrag|bauschutt)/i,
  },
  {
    id: 'stundenlohnarbeiten',
    patterns: [/stundenlohnarbeiten/i],
    context: /stundenlohnarbeiten.{0,80}(?:freigabe|nur nach|vorherig|vereinbarung)/i,
    reject: /^stundenlohn\s*:/im,
  },
  {
    id: 'wartezeit',
    patterns: [/wartezeitregelung/i],
    context: /wartezeitregelung[:\s].{5,}/i,
  },
  {
    id: 'kuendigung',
    patterns: [/kündigungsfrist|kuendigungsfrist|kündigung\s+aus\s+wichtigem/i],
    context: /(?:kündigungsfrist|kuendigungsfrist)[:\s].{2,}|kündigung\s+aus\s+wichtigem\s+grund/i,
    reject: /siehe\s+(?:§|abschnitt).*kündigung/i,
  },
  {
    id: 'abnahme',
    patterns: [/abnahme\s+(?:der\s+leistung\s+)?erfolgt|schriftliche\s+abnahme|abnahmeklausel/i],
    context: /abnahme.{0,80}(?:erfolgt|schriftlich|fertigstellung)/i,
    reject: /schlussrechnung\s+nach\s+abnahme|zahlung.*abnahme/i,
  },
];

function emptyField(): ExtractedContractField {
  return { status: 'not_found', confidence: 'low' };
}

function getStructuredPageItems(page: DocumentPageText): string[] {
  const items = (page as Partial<StructuredDocumentPageText>).items;
  if (!Array.isArray(items)) return [];
  return items
    .map((item) => (typeof item === 'string' ? item : item?.str ?? ''))
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function normalizeStructuredToken(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function looksLikeMoneyToken(value: string): boolean {
  return /\d{1,3}(?:[.\s]?\d{3})*,\d{2}|\d+,\d{2}/.test(value) || /€|eur/i.test(value);
}

function looksLikeUnitToken(value: string): boolean {
  return /^(m²|m2|qm|lfdm|lfm|m|st\.?|stk|stück|std\.?|kg|pauschal|l|h)$/i.test(value);
}

function getNextStructuredValue(items: string[], startIndex: number): string | undefined {
  for (let index = startIndex; index < items.length; index += 1) {
    const candidate = items[index]?.trim();
    if (!candidate) continue;
    if (/^(auftraggeber|auftragnehmer|vertreten durch|bauvorhaben|baustelle|vertragsart|vertragsdatum|vertragssumme netto|vertragsumme|zahlungsziel|gewährleistung|gewaehrleistung)$/i.test(candidate)) {
      return undefined;
    }
    return candidate;
  }
  return undefined;
}

function normalizeStructuredLabel(label: string): string | null {
  const normalized = label.toLowerCase().trim();
  if (normalized === 'auftraggeber') return 'auftraggeber';
  if (normalized === 'auftragnehmer') return 'auftragnehmer';
  if (normalized === 'bauvorhaben') return 'bauvorhaben';
  if (normalized === 'baustelle') return 'baustelle';
  if (normalized === 'vertragsdatum') return 'vertragsdatum';
  if (normalized === 'vertragsart') return 'vertragsart';
  if (normalized === 'zahlungsziel') return 'zahlungsbedingungen';
  if (normalized === 'gewährleistung' || normalized === 'gewaehrleistung') return 'gewaehrleistung';
  if (normalized === 'vertragssumme netto' || normalized === 'vertragsumme netto' || normalized === 'vertragssumme' || normalized === 'vertragsumme') return 'vertragsumme_netto';
  return null;
}

export function extractStructuredContractFields(
  pageTexts: DocumentPageText[],
): { fields: Record<string, ExtractedContractField>; contractTotalNet: ExtractedContractField<number> | null; positions: EnhancedDetectedOrderPosition[] } {
  const fields: Record<string, ExtractedContractField> = {};
  let contractTotalNet: ExtractedContractField<number> | null = null;
  const positions: EnhancedDetectedOrderPosition[] = [];

  for (const page of pageTexts) {
    const rawItems = getStructuredPageItems(page);
    if (rawItems.length === 0) continue;

    const items = rawItems.map(normalizeStructuredToken);
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index] ?? '';
      const fieldKey = normalizeStructuredLabel(item);
      if (!fieldKey) continue;

      const value = getNextStructuredValue(items, index + 1);
      if (!value) continue;

      if (fieldKey === 'vertragsumme_netto') {
        contractTotalNet = {
          value: parseGermanMoney(value),
          status: 'confirmed',
          confidence: 'high',
          sourcePage: page.pageNumber,
          sourceText: `${item}: ${value}`,
        };
        continue;
      }

      fields[fieldKey] = {
        value,
        status: 'confirmed',
        confidence: 'high',
        sourcePage: page.pageNumber,
        sourceText: `${item}: ${value}`,
      };
    }

    const headerIndex = items.findIndex((item) => /^pos\.?$/i.test(item));
    if (headerIndex === -1) continue;

    const rowTokens = items.slice(headerIndex + 1);
    let cursor = 0;
    while (cursor < rowTokens.length) {
      const token = rowTokens[cursor] ?? '';
      if (!/^\d+$/.test(token.trim())) {
        cursor += 1;
        continue;
      }

      const rowValues: string[] = [];
      for (let lookahead = cursor + 1; lookahead < rowTokens.length; lookahead += 1) {
        const candidate = rowTokens[lookahead] ?? '';
        if (/^\d+$/.test(candidate.trim()) && rowValues.length > 0) {
          break;
        }
        rowValues.push(candidate);
        if (rowValues.length >= 5) {
          break;
        }
      }

      if (rowValues.length < 5) {
        break;
      }

      const quantityToken = rowValues[0] ?? '';
      const unitToken = rowValues[1] ?? '';
      const unitPriceToken = rowValues[rowValues.length - 2] ?? '';
      const lineTotalToken = rowValues[rowValues.length - 1] ?? '';
      const descriptionTokens = rowValues.slice(2, rowValues.length - 2);

      if (!looksLikeMoneyToken(quantityToken) || !looksLikeUnitToken(unitToken) || !looksLikeMoneyToken(unitPriceToken) || !looksLikeMoneyToken(lineTotalToken) || descriptionTokens.length === 0) {
        cursor += 1;
        continue;
      }

      positions.push({
        positionNumber: token.trim(),
        description: descriptionTokens.join(' '),
        quantity: parseGermanMoney(quantityToken),
        unit: unitToken.replace(/\./g, '').toLowerCase(),
        unitPrice: parseGermanMoney(unitPriceToken),
        lineTotal: parseGermanMoney(lineTotalToken),
        sourcePage: page.pageNumber,
        confidence: 'high',
        reviewStatus: 'confirmed',
      });

      cursor += 1;
    }
  }

  return { fields, contractTotalNet, positions };
}

export function mergeContractFieldMaps(
  baseFields: Record<string, ExtractedContractField>,
  overlayFields: Record<string, ExtractedContractField>,
): Record<string, ExtractedContractField> {
  const merged = { ...baseFields };
  for (const [key, value] of Object.entries(overlayFields)) {
    if (!value || value.status === 'not_found') continue;
    merged[key] = value;
  }
  return merged;
}

function normalizeContractText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/([A-Za-zÄÖÜäöüß])\s*-\s*\n\s*/g, '$1')
    .replace(/([A-Za-zÄÖÜäöüß])\s*-\s*([A-Za-zÄÖÜäöüß])/g, '$1$2')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function splitNormalizedLines(text: string): string[] {
  return normalizeContractText(text)
    .split('\n')
    .map((line) => line.trim().replace(/\s+/g, ' '))
    .filter((line) => line.length > 0);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function cleanValue(value: string): string {
  return value.replace(/^[\s:;.,\-–—]+|[\s:;.,\-–—]+$/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * Page markers, attachment markers, section marks and signature lines.
 *
 * Every alternative needs its structural form — a bare "Anlage" or "Seite" is a
 * perfectly good first word of a company name ("Anlage Technik GmbH").
 */
const STRUCTURAL_LINE_PATTERN =
  /^\s*(?:§|-{2,}|seite\s+\d|anlage\s*(?:\d|:)|unterschrift\b|(?:allgemeine|besondere)\s+(?:vertrags|gesch[äa]fts)bedingungen\b)/i;

/** Start of another labelled field — ends a standalone label's lookahead. */
const LABEL_STOP_LINE_PATTERN =
  /^(?:auftraggeber|auftragnehmer|subunternehmer|nachunternehmer|vermieter|mieter|leasinggeber|leasingnehmer|verk[äa]ufer|k[äa]ufer|versicherer|versicherungsnehmer|arbeitgeber|arbeitnehmer|dienstleister|kunde|bauvorhaben|baustelle|vertragsdatum|vertragsnummer|vertragssumme|vertragsgegenstand|gesamtpreis|gesamtsumme|summe netto|leistungsverzeichnis|zahlungsbedingungen|gew[äa]hrleistung|stundenlohn|wartezeitregelung)/i;

/** Colon, hyphen or dash between label and value. */
const LABEL_SEPARATOR_PATTERN = '[:\\-–—]';

/**
 * A label owns a line only when it starts it.
 *
 * Returns the rest of the line (empty string for a standalone label line), or
 * null when the line is not a label line. With `requireSeparator`, text on the
 * same line counts as a value only behind a real separator — otherwise the line
 * is prose ("Auftragnehmer führt die Leistungen aus."), not a label.
 */
function matchLabelAtLineStart(
  line: string,
  labels: string[],
  requireSeparator = false,
): string | null {
  for (const label of labels) {
    const pattern = new RegExp(
      `^\\s*${escapeRegExp(label)}(?:in)?\\b\\s*(?:(${LABEL_SEPARATOR_PATTERN})\\s*)?(.*)$`,
      'i',
    );
    const match = pattern.exec(line);
    if (!match) continue;

    const separator = match[1];
    const rest = (match[2] ?? '').trim();
    if (!rest) return '';
    if (requireSeparator && !separator) return null;
    return rest;
  }
  return null;
}

/**
 * Next known field label inside the same line — the value ends there.
 *
 * Non-party fields keep the pre-existing behaviour: a line may carry several
 * labels ("Bauvorhaben: … Baustelle: …"), and each value stops at the next one.
 */
const INLINE_FIELD_BOUNDARY_PATTERN =
  /\b(?:auftraggeber|auftragnehmer|subunternehmer|nachunternehmer|bauvorhaben|baustelle|vertragsdatum|vertragsnummer|vertragsart|vertragssumme|gesamtpreis|gesamtsumme|summe netto|leistungsverzeichnis|anlage|seite)\b|§/i;

function cutAtNextFieldLabel(value: string): string {
  const boundary = value.search(INLINE_FIELD_BOUNDARY_PATTERN);
  return boundary === -1 ? value : value.slice(0, boundary);
}

/**
 * Non-party fields: the label may sit anywhere in the line, as before. Party
 * roles never use this path — they stay on the strict line-anchored rule.
 */
function matchLabelInLine(line: string, label: string): string | null {
  const pattern = new RegExp(
    `\\b${escapeRegExp(label)}(?:in)?\\b\\s*(?:${LABEL_SEPARATOR_PATTERN})?\\s*(.*)$`,
    'i',
  );
  const match = pattern.exec(line);
  if (!match) return null;
  return (match[1] ?? '').trim();
}

function isUsableLabelValue(value: string | undefined): value is string {
  if (!value || value.length < 2) return false;
  if (value.length > 140) return false;
  if (STRUCTURAL_LINE_PATTERN.test(value)) return false;
  if (/seite\s+\d/i.test(value)) return false;
  return true;
}

type LabelLineOptions = {
  /** Party roles: text on the label line counts only behind a separator. */
  requireSeparator?: boolean;
  maxLookahead?: number;
};

function extractValueFromLabelLines(
  lines: string[],
  labels: string[],
  options: LabelLineOptions = {},
): string | undefined {
  const { requireSeparator = false, maxLookahead = 2 } = options;

  // Labels are given in priority order — an earlier label wins over an earlier line.
  for (const label of labels) {
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? '';
      const rest = requireSeparator
        ? matchLabelAtLineStart(line, [label], true)
        : matchLabelInLine(line, label);
      if (rest === null) continue;

      if (rest) {
        // Party values are already isolated by the strict match; other fields
        // may share a line and must stop at the next label.
        const candidate = cleanValue(requireSeparator ? rest : cutAtNextFieldLabel(rest));
        if (isUsableLabelValue(candidate)) return candidate;
        continue;
      }

      // Standalone label line: take the next plausible value line, nothing beyond.
      for (let lookahead = 1; lookahead <= maxLookahead; lookahead += 1) {
        const nextLine = lines[index + lookahead];
        if (!nextLine) break;
        if (STRUCTURAL_LINE_PATTERN.test(nextLine)) break;
        if (LABEL_STOP_LINE_PATTERN.test(nextLine)) break;
        const candidate = cleanValue(nextLine);
        if (isUsableLabelValue(candidate)) return candidate;
        break;
      }
    }
  }

  return undefined;
}

function extractFieldByLabelFallback(
  text: string,
  labels: string[],
  sourcePage?: number,
  options: LabelLineOptions = {},
): ExtractedContractField {
  const partyField = Boolean(options.requireSeparator);
  const lines = splitNormalizedLines(text);
  const value = extractValueFromLabelLines(lines, labels, options);
  if (value && (!partyField || isPlausiblePartyName(value))) {
    return {
      value,
      status: 'confirmed',
      confidence: 'medium',
      sourcePage,
      sourceText: value,
    };
  }

  const normalized = normalizeContractText(text);
  for (const label of labels) {
    // Party fields keep the strict rule here too: line-anchored, separator required.
    const directRegex = partyField
      ? new RegExp(`^\\s*${escapeRegExp(label)}(?:in)?\\b\\s*${LABEL_SEPARATOR_PATTERN}\\s*(.+)$`, 'im')
      : new RegExp(`\\b${escapeRegExp(label)}\\b\\s*[:\\-]?\\s*(.+)`, 'i');
    const match = directRegex.exec(normalized);
    if (!match?.[1]?.trim()) continue;

    const candidate = cleanValue(match[1]);
    if (partyField && !isPlausiblePartyName(candidate)) continue;
    return {
      value: candidate,
      status: 'confirmed',
      confidence: 'medium',
      sourcePage,
      sourceText: match[0].trim(),
    };
  }

  return emptyField();
}

function extractAmountAfterLabel(text: string, labels: string[]): string | undefined {
  const normalized = normalizeContractText(text).replace(/\s+/g, ' ');
  const amountRegex = /(\d{1,3}(?:\.\d{3})*,\d{2})\s*(?:€|eur)?/i;

  for (const label of labels) {
    const labelRegex = new RegExp(`\\b${escapeRegExp(label)}\\b`, 'i');
    const match = labelRegex.exec(normalized);
    if (!match) continue;

    const remainder = normalized.slice(match.index + match[0].length);
    const withoutPrefix = remainder.replace(/^[\s:;.,\-–—]+/, '');
    const boundaryIndex = withoutPrefix.search(/\b(?:auftraggeber|auftragnehmer|subunternehmer|nachunternehmer|bauvorhaben|baustelle|vertragsdatum|vertragsnummer|vertragsart|leistungsverzeichnis|anlage|seite|§)\b/i);
    const segment = withoutPrefix.slice(0, boundaryIndex === -1 ? withoutPrefix.length : boundaryIndex);
    const segmentMatch = segment.match(amountRegex);
    if (segmentMatch?.[1]) return segmentMatch[1];
  }

  const explicitRegex = new RegExp(`\\b(?:${labels.map((label) => escapeRegExp(label)).join('|')})\\b[^\n]{0,40}(\\d{1,3}(?:\\.\\d{3})*,\\d{2})\\s*(?:€|eur)?`, 'i');
  const globalMatch = explicitRegex.exec(normalized);
  return globalMatch?.[1];
}

export function extractLabeledField(
  text: string,
  patterns: RegExp[],
  sourcePage?: number,
): ExtractedContractField {
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match?.[1]?.trim()) {
      return {
        value: match[1].trim().split('\n')[0].trim(),
        status: 'confirmed',
        confidence: 'high',
        sourcePage,
        sourceText: match[0].trim(),
      };
    }
  }
  return emptyField();
}

function extractPresenceWithContext(
  text: string,
  matchPattern: RegExp,
  contextPattern: RegExp,
  fallback: string,
): ExtractedContractField {
  const match = matchPattern.exec(text);
  if (!match) return emptyField();
  const window = text.slice(Math.max(0, match.index - 40), match.index + match[0].length + 100);
  if (!contextPattern.test(window) && !contextPattern.test(text)) {
    return emptyField();
  }
  const line =
    text
      .slice(Math.max(0, match.index - 20), match.index + match[0].length + 100)
      .split('\n')
      .map((entry) => entry.trim())
      .find((entry) => matchPattern.test(entry)) || match[0].trim();
  return {
    value: line || fallback,
    status: 'confirmed',
    confidence: 'medium',
    sourceText: match[0].trim(),
  };
}

export function looksLikeContractDocument(text: string, pageTexts: DocumentPageText[]): boolean {
  const intro = pageTexts
    .slice(0, 3)
    .map((page) => page.text)
    .join('\n');
  const haystack = `${intro}\n${text}`;
  if (
    /werkvertrag|subunternehmervertrag|mietvertrag|leasingvertrag|dienstleistungsvertrag|wartungsvertrag|kaufvertrag|liefervertrag|rahmenvertrag|arbeitsvertrag|versicherungsvertrag|\bvertrag\b/i.test(
      haystack,
    )
  ) {
    return true;
  }
  return PARTY_PATTERNS.some((rule) => rule.pattern.test(haystack));
}

/** Strong construction signals — roles or "Abnahme" alone are not enough. */
const STRONG_BAU_SIGNAL_PATTERNS: RegExp[] = [
  /\bbaustelle\b/i,
  /\bbauvorhaben\b|\bbaustellenbezeichnung\b/i,
  /\bleistungsverzeichnis\b/i,
  /\bgewerk\b/i,
  /\bbehinderungsanzeige\b/i,
  /\bbg[\s-]?bau\b/i,
  /\beinheitspreis\b|\b\d+\s*(?:qm|m²|m2|lfdm)\b/i,
];

function countStrongBauSignals(text: string): number {
  let count = 0;
  for (const pattern of STRONG_BAU_SIGNAL_PATTERNS) {
    if (pattern.test(text)) count += 1;
  }
  return count;
}

function isConstructionFamily(family: ContractFamily): boolean {
  return family === 'werkvertrag' || family === 'subunternehmervertrag';
}

/**
 * Construction families need a real heading or multiple strong Bau signals.
 * Auftraggeber/Auftragnehmer + Abnahme alone must not confirm Werkvertrag.
 */
function constructionFamilyEligible(text: string, hasHeading: boolean): boolean {
  if (hasHeading) return true;
  return countStrongBauSignals(text) >= 2;
}

export function detectContractType(text: string): DetectedContractType {
  const evidence: string[] = [];
  let best: {
    family: ContractFamily;
    labelKey: string;
    score: number;
    hasHeading: boolean;
  } | null = null;

  for (const rule of FAMILY_RULES) {
    const hasHeading = rule.heading.test(text);
    const hasRoles = rule.roles.test(text);
    const hasTopics = rule.topics.test(text);

    let score = 0;
    if (hasHeading) {
      score += 4;
      evidence.push(`heading:${rule.family}`);
    }
    if (hasRoles) {
      score += 2;
      evidence.push(`roles:${rule.family}`);
    }
    if (hasTopics) {
      score += 2;
      evidence.push(`topics:${rule.family}`);
    }

    if (score < 4) continue;

    if (isConstructionFamily(rule.family) && !constructionFamilyEligible(text, hasHeading)) {
      // Weak role/topic combo only — do not promote to confirmed construction family.
      continue;
    }

    if (!best || score > best.score) {
      best = { family: rule.family, labelKey: rule.labelKey, score, hasHeading };
    }
  }

  if (!best) {
    if (/\bvertrag\b/i.test(text) || PARTY_PATTERNS.some((rule) => rule.pattern.test(text))) {
      return {
        family: 'general_contract',
        labelKey: 'documentIntelligence.label.generalContract',
        confidence: 'low',
        status: 'review_required',
        evidence: ['generic_contract_signal'],
      };
    }
    return {
      family: 'unknown',
      labelKey: 'documentIntelligence.label.unknown',
      confidence: 'low',
      status: 'review_required',
      evidence: [],
    };
  }

  const confidence: FieldConfidenceLevel =
    best.score >= 6 ? 'high' : best.score >= 4 ? 'medium' : 'low';

  return {
    family: best.family,
    labelKey: best.labelKey,
    confidence,
    status: confidence === 'low' ? 'review_required' : 'confirmed',
    evidence: [...new Set(evidence)].slice(0, 8),
  };
}

/**
 * Clause headings, section titles and signature lines are no party names —
 * even when they sit right where a name would be expected.
 */
const NON_PARTY_VALUE_PATTERN =
  /^\s*(?:§|-{2,}|seite\s+\d|anlage\s*(?:\d|:)|unterschrift\b|(?:allgemeine|besondere)\s+(?:vertrags|gesch[äa]fts)bedingungen\b|behinderungs?anzeige|nachtr[äa]ge?\b|gew[äa]hrleistungsfrist|vertragsstrafe|zahlungsbedingungen|leistungsverzeichnis)/i;

function isPlausiblePartyName(value: string): boolean {
  const cleaned = value.trim();
  if (cleaned.length < 2 || cleaned.length > 90) return false;
  if (NON_PARTY_VALUE_PATTERN.test(cleaned)) return false;
  // A name is not a sentence: several words plus sentence punctuation is prose.
  if (/[.;:]/.test(cleaned) && cleaned.split(/\s+/).length > 8) return false;
  return true;
}

export function extractContractParties(text: string): DetectedContractParty[] {
  const parties: DetectedContractParty[] = [];
  const seenRoles = new Set<ContractPartyRole>();
  const lines = splitNormalizedLines(text);

  for (const rule of PARTY_LABELS) {
    const value = extractValueFromLabelLines(lines, rule.labels, { requireSeparator: true });
    if (!value || !isPlausiblePartyName(value)) continue;
    if (seenRoles.has(rule.role)) continue;
    seenRoles.add(rule.role);
    parties.push({
      role: rule.role,
      name: cleanValue(value),
      status: 'confirmed',
      confidence: 'high',
      sourceText: value,
    });
  }

  if (parties.length === 0) {
    for (const rule of PARTY_PATTERNS) {
      const match = rule.pattern.exec(text);
      if (!match?.[1]?.trim()) continue;
      if (seenRoles.has(rule.role)) continue;
      const fallbackName = cleanValue(match[1].trim().split('\n')[0].trim());
      if (!isPlausiblePartyName(fallbackName)) continue;
      seenRoles.add(rule.role);
      parties.push({
        role: rule.role,
        name: fallbackName,
        status: 'confirmed',
        confidence: 'high',
        sourceText: match[0].trim(),
      });
    }
  }

  return parties;
}

export function extractAllContractFields(
  contractText: string,
  pageTexts: DocumentPageText[],
): Record<string, ExtractedContractField> {
  const pageHint = pageTexts[0]?.pageNumber;

  return {
    ansprechpartner: extractLabeledField(contractText, [
      /ansprechpartner(?:in)?\s*:\s*([^\n]+)/i,
    ], pageHint),
    vertragsnummer: extractFieldByLabelFallback(
      contractText,
      ['vertragsnummer', 'vertrag nr', 'versicherungsschein'],
      pageHint,
    ),
    vertragsdatum: extractFieldByLabelFallback(contractText, ['vertragsdatum'], pageHint),
    beginn: extractLabeledField(contractText, [
      /(?:vertrags)?beginn\s*:\s*([^\n]+)/i,
      /mietbeginn\s*:\s*([^\n]+)/i,
      /eintrittsdatum\s*:\s*([^\n]+)/i,
    ]),
    laufzeit: extractLabeledField(contractText, [
      /laufzeit\s*:\s*([^\n]+)/i,
      /leistungszeitraum\s*:\s*([^\n]+)/i,
    ]),
    ende: extractLabeledField(contractText, [
      /(?:vertrags)?ende\s*:\s*([^\n]+)/i,
      /mietende\s*:\s*([^\n]+)/i,
    ]),
    kuendigungsfrist: extractLabeledField(contractText, [
      /kündigungsfrist\s*:\s*([^\n]+)/i,
      /kuendigungsfrist\s*:\s*([^\n]+)/i,
    ]),
    verlaengerung: extractLabeledField(contractText, [
      /(?:automatische\s+)?verlängerung\s*:\s*([^\n]+)/i,
      /(?:automatische\s+)?verlaengerung\s*:\s*([^\n]+)/i,
    ]),
    vertragsgegenstand: extractLabeledField(contractText, [
      /vertragsgegenstand\s*:\s*([^\n]+)/i,
      /leistungsbeschreibung\s*:\s*([^\n]+)/i,
    ]),
    leistungsort: extractLabeledField(contractText, [
      /leistungsort\s*:\s*([^\n]+)/i,
      /arbeitsort\s*:\s*([^\n]+)/i,
      /lieferort\s*:\s*([^\n]+)/i,
    ]),
    zahlungsbedingungen: extractLabeledField(contractText, [
      /zahlungsbedingungen\s*:\s*([^\n]+)/i,
      /zahlungsziel\s*:\s*([^\n]+)/i,
    ]),
    gewaehrleistung: extractLabeledField(contractText, [
      /gewährleistung\s*:\s*([^\n]+)/i,
      /gewaehrleistung\s*:\s*([^\n]+)/i,
      /gewährleistungsfrist\s*:\s*([^\n]+)/i,
    ]),
    haftung: extractLabeledField(contractText, [/haftung\s*:\s*([^\n]+)/i]),

    // Construction-oriented (filtered in UI by family)
    auftraggeber: extractFieldByLabelFallback(contractText, ['auftraggeber'], pageHint, {
      requireSeparator: true,
    }),
    auftragnehmer: extractFieldByLabelFallback(
      contractText,
      ['subunternehmer', 'auftragnehmer', 'nachunternehmer'],
      pageHint,
      { requireSeparator: true },
    ),
    bauvorhaben: extractFieldByLabelFallback(
      contractText,
      ['bauvorhaben', 'baustellenbezeichnung', 'bv', 'baustelle'],
      pageHint,
    ),
    baustelle: extractFieldByLabelFallback(
      contractText,
      ['baustellenadresse', 'baustelle', 'bauvorhaben', 'bv'],
      pageHint,
    ),
    stundenlohn: extractLabeledField(contractText, [
      /stundenlohn\s*:\s*([^\n]+)/i,
      /stundensatz\s*:\s*([^\n]+)/i,
    ]),
    wartezeitregelung: extractLabeledField(contractText, [
      /wartezeitregelung\s*:\s*([^\n]+)/i,
    ]),
    sicherheitseinbehalt: extractLabeledField(contractText, [
      /sicherheitseinbehalt\s*:\s*([^\n]+)/i,
    ]),
    vertragsstrafe: extractLabeledField(contractText, [/vertragsstrafe\s*:\s*([^\n]+)/i]),
    bgBau: extractPresenceWithContext(
      contractText,
      /bg[\s-]?bau/i,
      /bg[\s-]?bau.{0,80}(?:unbedenklich|nachweis|erforderlich|bescheinigung)/i,
      'BG BAU',
    ),
    sokaBau: extractPresenceWithContext(
      contractText,
      /soka[\s-]?bau/i,
      /soka[\s-]?bau.{0,80}(?:nachweis|erforderlich|bescheinigung)/i,
      'SOKA-BAU',
    ),

    // Service / maintenance
    leistungsbeschreibung: extractLabeledField(contractText, [
      /leistungsbeschreibung\s*:\s*([^\n]+)/i,
    ]),
    leistungsintervall: extractLabeledField(contractText, [
      /(?:wartungs)?intervall\s*:\s*([^\n]+)/i,
      /leistungsintervall\s*:\s*([^\n]+)/i,
    ]),
    reaktionszeit: extractLabeledField(contractText, [/reaktionszeit\s*:\s*([^\n]+)/i]),
    servicezeit: extractLabeledField(contractText, [/servicezeit\s*:\s*([^\n]+)/i]),
    pauschale: extractLabeledField(contractText, [
      /(?:wartungs)?pauschale\s*:\s*([^\n]+)/i,
      /monatspauschale\s*:\s*([^\n]+)/i,
    ]),
    stundenverrechnungssatz: extractLabeledField(contractText, [
      /stundenverrechnungssatz\s*:\s*([^\n]+)/i,
      /stundensatz\s*:\s*([^\n]+)/i,
    ]),

    // Rent / lease
    vermieter: extractLabeledField(contractText, [/vermieter\s*:\s*([^\n]+)/i]),
    mieter: extractLabeledField(contractText, [/mieter\s*:\s*([^\n]+)/i]),
    mietobjekt: extractLabeledField(contractText, [
      /mietobjekt\s*:\s*([^\n]+)/i,
      /mietsache\s*:\s*([^\n]+)/i,
    ]),
    mietbeginn: extractLabeledField(contractText, [/mietbeginn\s*:\s*([^\n]+)/i]),
    kaltmiete: extractLabeledField(contractText, [/kaltmiete\s*:\s*([^\n]+)/i]),
    nebenkosten: extractLabeledField(contractText, [/nebenkosten\s*:\s*([^\n]+)/i]),
    kaution: extractLabeledField(contractText, [/kaution\s*:\s*([^\n]+)/i]),
    leasinggeber: extractLabeledField(contractText, [/leasinggeber\s*:\s*([^\n]+)/i]),
    leasingnehmer: extractLabeledField(contractText, [/leasingnehmer\s*:\s*([^\n]+)/i]),
    leasingobjekt: extractLabeledField(contractText, [/leasingobjekt\s*:\s*([^\n]+)/i]),
    leasingrate: extractLabeledField(contractText, [
      /leasingrate\s*:\s*([^\n]+)/i,
      /monatsrate\s*:\s*([^\n]+)/i,
    ]),
    sonderzahlung: extractLabeledField(contractText, [/sonderzahlung\s*:\s*([^\n]+)/i]),
    restwert: extractLabeledField(contractText, [/restwert\s*:\s*([^\n]+)/i]),

    // Purchase / delivery
    verkaeufer: extractLabeledField(contractText, [/verk[äa]ufer\s*:\s*([^\n]+)/i]),
    kaeufer: extractLabeledField(contractText, [/k[äa]ufer\s*:\s*([^\n]+)/i]),
    liefergegenstand: extractLabeledField(contractText, [
      /liefergegenstand\s*:\s*([^\n]+)/i,
      /waren\s*:\s*([^\n]+)/i,
    ]),
    liefertermin: extractLabeledField(contractText, [/liefertermin\s*:\s*([^\n]+)/i]),
    lieferort: extractLabeledField(contractText, [/lieferort\s*:\s*([^\n]+)/i]),
    eigentumsvorbehalt: extractLabeledField(contractText, [
      /eigentumsvorbehalt\s*:\s*([^\n]+)/i,
    ]),

    // Insurance / employment
    versicherer: extractLabeledField(contractText, [/versicherer\s*:\s*([^\n]+)/i]),
    versicherungsnehmer: extractLabeledField(contractText, [
      /versicherungsnehmer\s*:\s*([^\n]+)/i,
    ]),
    versicherungsart: extractLabeledField(contractText, [/versicherungsart\s*:\s*([^\n]+)/i]),
    beitrag: extractLabeledField(contractText, [
      /beitrag\s*:\s*([^\n]+)/i,
      /versicherungsbeitrag\s*:\s*([^\n]+)/i,
    ]),
    selbstbeteiligung: extractLabeledField(contractText, [
      /selbstbeteiligung\s*:\s*([^\n]+)/i,
    ]),
    arbeitgeber: extractLabeledField(contractText, [/arbeitgeber\s*:\s*([^\n]+)/i]),
    arbeitnehmer: extractLabeledField(contractText, [/arbeitnehmer\s*:\s*([^\n]+)/i]),
    taetigkeit: extractLabeledField(contractText, [/tätigkeit\s*:\s*([^\n]+)/i, /taetigkeit\s*:\s*([^\n]+)/i]),
    eintrittsdatum: extractLabeledField(contractText, [/eintrittsdatum\s*:\s*([^\n]+)/i]),
    arbeitsort: extractLabeledField(contractText, [/arbeitsort\s*:\s*([^\n]+)/i]),
    arbeitszeit: extractLabeledField(contractText, [/arbeitszeit\s*:\s*([^\n]+)/i]),
    probezeit: extractLabeledField(contractText, [/probezeit\s*:\s*([^\n]+)/i]),
    urlaub: extractLabeledField(contractText, [/urlaub\s*:\s*([^\n]+)/i]),
  };
}

export function partitionContractFields(
  fields: Record<string, ExtractedContractField>,
  family: ContractFamily,
): {
  commonFields: Record<string, ExtractedContractField>;
  typeSpecificFields: Record<string, ExtractedContractField>;
  visibleFields: Record<string, ExtractedContractField>;
} {
  const typeKeys = new Set(TYPE_SPECIFIC_FIELD_KEYS[family] ?? []);
  const commonFields: Record<string, ExtractedContractField> = {};
  const typeSpecificFields: Record<string, ExtractedContractField> = {};

  for (const key of COMMON_FIELD_KEYS) {
    if (fields[key]) commonFields[key] = fields[key]!;
  }

  for (const key of typeKeys) {
    if (fields[key]) typeSpecificFields[key] = fields[key]!;
  }

  // Backward-compatible bag: common + allowed type-specific only (never foreign type fields).
  const visibleFields: Record<string, ExtractedContractField> = {
    ...commonFields,
    ...typeSpecificFields,
  };

  return { commonFields, typeSpecificFields, visibleFields };
}

export function detectContractClauses(
  text: string,
  pageTexts: DocumentPageText[],
): DetectedContractClause[] {
  const clauses: DetectedContractClause[] = [];
  const commercial = joinSectionText(
    pageTexts,
    pageTexts.slice(0, Math.min(4, pageTexts.length)).map((page) => page.pageNumber),
  );
  const haystack = `${commercial}\n${text}`;

  for (const rule of CLAUSE_RULES) {
    let matched: RegExpExecArray | null = null;
    for (const pattern of rule.patterns) {
      matched = pattern.exec(haystack);
      if (matched) break;
    }
    if (!matched) continue;

    const window = haystack.slice(
      Math.max(0, matched.index - 40),
      matched.index + matched[0].length + 140,
    );
    if (rule.reject?.test(window)) continue;
    if (!rule.context.test(window) && !rule.context.test(haystack)) continue;

    const sourcePage = pageTexts.find((page) =>
      rule.patterns.some((pattern) => pattern.test(page.text)),
    )?.pageNumber;

    const line =
      haystack
        .slice(Math.max(0, matched.index - 10), matched.index + matched[0].length + 120)
        .split('\n')
        .map((entry) => entry.trim())
        .find((entry) => entry.length > 8) || matched[0].trim();

    clauses.push({
      id: rule.id,
      status: 'confirmed',
      confidence: 'medium',
      sourcePage,
      sourceText: matched[0].trim(),
      summary: line,
    });
  }

  return clauses;
}

export function extractContractTotalAmountFromText(text: string): ExtractedContractField<number> | null {
  const amount = extractAmountAfterLabel(text, [
    'vertragsumme',
    'vertragssumme',
    'gesamtsumme',
    'gesamtpreis',
    'summe netto',
    'auftragssumme',
  ]);
  if (!amount) return null;
  return {
    value: parseGermanMoney(amount),
    status: 'confirmed',
    confidence: 'high',
    sourceText: amount,
  };
}

export function extractGenericBillOfQuantitiesFromText(
  text: string,
  sourcePage?: number,
): EnhancedDetectedOrderPosition[] {
  const lines = splitNormalizedLines(text);
  const positions: EnhancedDetectedOrderPosition[] = [];
  const quantityUnitPriceRegex =
    /(.+?)\s+([\d.,]+)\s*(m²|m2|qm|lfdm|lfm|m|st\.?|stk|stück|std\.?|kg|pauschal)\s*(?:x|×)\s*([\d.,]+)\s*(?:€|eur)?(?:\s+([\d.,]+)\s*(?:€|eur)?)?/i;

  for (let index = 0; index < lines.length; index += 1) {
    const joined = [lines[index] ?? '', lines[index + 1] ?? ''].join(' ').trim();
    const match = joined.match(quantityUnitPriceRegex);
    if (!match) continue;

    const description = cleanValue(match[1] ?? '').replace(/^(?:pos\.|nr\.|position)\s*/i, '');
    const quantityRaw = match[2] ?? '';
    const unitRaw = match[3] ?? '';
    const unitPriceRaw = match[4] ?? '';
    const lineTotalRaw = match[5] ?? '';

    if (!description || !quantityRaw || !unitRaw || !unitPriceRaw) continue;

    const quantity = parseGermanMoney(quantityRaw);
    const unitPrice = parseGermanMoney(unitPriceRaw);
    const lineTotal = lineTotalRaw ? parseGermanMoney(lineTotalRaw) : quantity * unitPrice;
    if (!Number.isFinite(quantity) || !Number.isFinite(unitPrice) || quantity <= 0 || unitPrice <= 0) continue;

    const unit = unitRaw.replace(/\./g, '').toLowerCase();
    positions.push({
      positionNumber: `${positions.length + 1}`,
      description,
      quantity,
      unit,
      unitPrice,
      lineTotal,
      sourcePage,
      confidence: 'medium',
      reviewStatus: 'confirmed',
    });
  }

  return positions;
}

export function mapPartiesToLegacyFields(
  parties: DetectedContractParty[],
  fields: Record<string, ExtractedContractField>,
): void {
  const byRole = (role: ContractPartyRole) => parties.find((party) => party.role === role);

  const ag = byRole('auftraggeber') ?? byRole('vermieter') ?? byRole('leasinggeber') ?? byRole('kaeufer') ?? byRole('versicherungsnehmer') ?? byRole('arbeitgeber');
  const an =
    byRole('subunternehmer') ??
    byRole('nachunternehmer') ??
    byRole('auftragnehmer') ??
    byRole('mieter') ??
    byRole('leasingnehmer') ??
    byRole('verkaeufer') ??
    byRole('versicherer') ??
    byRole('arbeitnehmer') ??
    byRole('dienstleister');

  if (ag && (!fields.auftraggeber || fields.auftraggeber.status === 'not_found')) {
    fields.auftraggeber = {
      value: ag.name,
      status: 'confirmed',
      confidence: ag.confidence,
      sourceText: ag.sourceText,
    };
  }
  if (an && (!fields.auftragnehmer || fields.auftragnehmer.status === 'not_found')) {
    fields.auftragnehmer = {
      value: an.name,
      status: 'confirmed',
      confidence: an.confidence,
      sourceText: an.sourceText,
    };
  }
}

import type { ClassifiedDocumentKind } from '../../types/models';
import type { MemoryAuthorityId } from '../../types/memory';

export interface MemoryAuthorityRule {
  id: MemoryAuthorityId;
  label: string;
  pattern: RegExp;
}

export const MEMORY_AUTHORITY_RULES: MemoryAuthorityRule[] = [
  { id: 'bg_bau', label: 'BG BAU', pattern: /bg[\s-]?bau|berufsgenossenschaft der bauwirtschaft/i },
  { id: 'finanzamt', label: 'Finanzamt', pattern: /finanzamt|steuerbescheid|umsatzsteuer|lohnsteuer/i },
  { id: 'aok', label: 'AOK', pattern: /\baok\b/i },
  { id: 'tk', label: 'Techniker Krankenkasse', pattern: /\btk\b|techniker[\s-]?krankenkasse/i },
  { id: 'barmer', label: 'Barmer', pattern: /\bbarmer\b/i },
  { id: 'ikk', label: 'IKK', pattern: /\bikk\b|innovationskasse/i },
  { id: 'soka_bau', label: 'SOKA-BAU', pattern: /soka[\s-]?bau/i },
  { id: 'handwerkskammer', label: 'Handwerkskammer', pattern: /handwerkskammer/i },
  { id: 'ihk', label: 'IHK', pattern: /\bihk\b|industrie- und handelskammer/i },
  { id: 'steuerberater', label: 'Steuerberater', pattern: /steuerberater|steuerkanzlei/i },
  { id: 'versicherung', label: 'Versicherung', pattern: /versicherung|allianz|haftpflicht|policy/i },
];

const KIND_AUTHORITY_MAP: Partial<Record<ClassifiedDocumentKind, MemoryAuthorityId[]>> = {
  bg_bau: ['bg_bau'],
  berufsgenossenschaft: ['bg_bau'],
  unbedenklichkeitsbescheinigung: ['bg_bau', 'finanzamt'],
  finanzamt: ['finanzamt'],
  steuerbescheid: ['finanzamt'],
  umsatzsteuerbescheid: ['finanzamt'],
  aok: ['aok'],
  barmer: ['barmer'],
  tk: ['tk'],
  ikk: ['ikk'],
  krankenkasse: ['aok'],
  soka_bau: ['soka_bau'],
  handwerkskammer: ['handwerkskammer'],
  ihk: ['ihk'],
  freistellungsbescheinigung: ['finanzamt', 'steuerberater'],
  betriebshaftpflicht: ['versicherung'],
  versicherung: ['versicherung'],
  versicherungsbescheid: ['versicherung'],
};

export function detectAuthoritiesFromText(text: string): MemoryAuthorityId[] {
  const found = new Set<MemoryAuthorityId>();
  for (const rule of MEMORY_AUTHORITY_RULES) {
    if (rule.pattern.test(text)) {
      found.add(rule.id);
    }
  }
  return [...found];
}

export function detectAuthoritiesFromDocument(
  haystack: string,
  classifiedKind?: ClassifiedDocumentKind,
): MemoryAuthorityId[] {
  const found = new Set<MemoryAuthorityId>(detectAuthoritiesFromText(haystack));
  if (classifiedKind && KIND_AUTHORITY_MAP[classifiedKind]) {
    for (const id of KIND_AUTHORITY_MAP[classifiedKind]!) {
      found.add(id);
    }
  }
  return [...found];
}

export function getAuthorityLabel(id: MemoryAuthorityId): string {
  return MEMORY_AUTHORITY_RULES.find((rule) => rule.id === id)?.label ?? id;
}

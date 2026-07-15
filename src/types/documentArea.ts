export type DocumentAreaId =
  | 'rechnungen'
  | 'belege'
  | 'kunden'
  | 'auftraege'
  | 'angebote'
  | 'vertraege'
  | 'baustellen'
  | 'behoerden'
  | 'mitarbeiter'
  | 'versicherungen'
  | 'allgemein';

export type DocumentAreaFilterId = 'alle' | DocumentAreaId;

export const DOCUMENT_AREA_IDS: readonly DocumentAreaId[] = [
  'rechnungen',
  'belege',
  'kunden',
  'auftraege',
  'angebote',
  'vertraege',
  'baustellen',
  'behoerden',
  'mitarbeiter',
  'versicherungen',
  'allgemein',
] as const;

export const DOCUMENT_AREA_FILTER_IDS: readonly DocumentAreaFilterId[] = [
  'alle',
  ...DOCUMENT_AREA_IDS,
] as const;

export function isDocumentAreaId(value: string): value is DocumentAreaId {
  return (DOCUMENT_AREA_IDS as readonly string[]).includes(value);
}

export function isDocumentAreaFilterId(value: string): value is DocumentAreaFilterId {
  return (DOCUMENT_AREA_FILTER_IDS as readonly string[]).includes(value);
}

/** Maps unknown / null URL values to `alle`. */
export function parseDocumentAreaFilter(value: string | null | undefined): DocumentAreaFilterId {
  if (!value) return 'alle';
  return isDocumentAreaFilterId(value) ? value : 'alle';
}

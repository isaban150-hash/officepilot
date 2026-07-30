import type { ClassifiedDocumentKind, CompanyDocument } from '../types/models';
import type { DocumentAreaFilterId, DocumentAreaId } from '../types/documentArea';
import { DOCUMENT_AREA_IDS, isDocumentAreaId } from '../types/documentArea';
import { getVorgangById } from './vorgangService';
import {
  getDocumentMemoryByDocumentId,
  getPaperRegisterEntryForDocument,
} from './officePilotMemoryService';

const RECHNUNG_KINDS = new Set<ClassifiedDocumentKind>([
  'eingangsrechnung',
  'rechnung',
  'ausgangsrechnung',
  'gutschrift',
  'reparaturrechnung',
  'mahnung',
  'zahlungserinnerung',
  'kontoauszug',
]);

const BELEG_KINDS = new Set<ClassifiedDocumentKind>([
  'quittung',
  'kassenbeleg',
  'ec_beleg',
  'kreditkartenbeleg',
  'tankbeleg',
]);

const ANGEBOT_KINDS = new Set<ClassifiedDocumentKind>(['angebot']);

const AUFTRAG_KINDS = new Set<ClassifiedDocumentKind>([
  'auftrag',
  'auftragsbestaetigung',
  'nachtrag',
  'leistungsverzeichnis',
  'lieferschein',
  'abnahmeprotokoll',
  'maengelprotokoll',
  'uebergabeprotokoll',
]);

const VERTRAG_KINDS = new Set<ClassifiedDocumentKind>([
  'werkvertrag',
  'subunternehmervertrag',
  'nachunternehmervertrag',
  'leasingvertrag',
]);

const BEHOERDE_KINDS = new Set<ClassifiedDocumentKind>([
  'zoll',
  'handwerkskammer',
  'ihk',
  'gewerbeamt',
  'bauamt',
  'ordnungsamt',
  'agentur_fuer_arbeit',
  'deutsche_rentenversicherung',
  'finanzamt',
  'bg_bau',
  'berufsgenossenschaft',
  'soka_bau',
  'aok',
  'barmer',
  'tk',
  'dak',
  'ikk',
  'knappschaft',
  'pflegekasse',
  'krankenkasse',
  'gewerbeanmeldung',
  'handelsregister',
  'handelsregisterauszug',
  'freistellungsbescheinigung',
  'unbedenklichkeitsbescheinigung',
  'betriebserlaubnis',
  'zertifikat',
  'iso_nachweis',
  'steuerbescheid',
  'umsatzsteuerbescheid',
]);

const MITARBEITER_KINDS = new Set<ClassifiedDocumentKind>([
  'arbeitsvertrag',
  'lohnabrechnung',
  'lohnunterlagen',
  'stundenzettel',
  'urlaubsantrag',
  'krankmeldung',
  'arbeitsunfaehigkeitsbescheinigung',
  'unterweisung',
  'sicherheitsbelehrung',
]);

const VERSICHERUNG_KINDS = new Set<ClassifiedDocumentKind>([
  'betriebshaftpflicht',
  'fahrzeugversicherung',
  'rechtsschutzversicherung',
  'gebaeudeversicherung',
  'versicherungsbescheid',
  'versicherung',
]);

const BAUSTELLE_KIND_SECURE = new Set<ClassifiedDocumentKind>([
  'baustellenfoto',
  'pruefprotokoll',
  'messprotokoll',
  'materialnachweis',
  'entsorgungsnachweis',
  'sicherheitsdokument',
]);

const ALLGEMEIN_KINDS = new Set<ClassifiedDocumentKind>([
  'brief',
  'schriftverkehr',
  'email_pdf',
  'pdf_anlage',
  'notiz',
  'sonstiges',
]);

const WEAK_LABELS = new Set([
  '',
  '-',
  '—',
  'unbekannt',
  'allgemein',
  'neu',
  'unknown',
  'n/a',
  'na',
  'ohne',
  'keine',
]);

function isMeaningfulLabel(value: string | null | undefined): boolean {
  const trimmed = value?.trim() ?? '';
  if (!trimmed) return false;
  return !WEAK_LABELS.has(trimmed.toLowerCase());
}

function pathSegments(path: string | undefined): string[] {
  if (!path) return [];
  return path
    .split('/')
    .map((part) => part.trim())
    .filter(Boolean);
}

function hasKundenPath(path: string | undefined): boolean {
  const parts = pathSegments(path);
  if (parts[0]?.toLowerCase() !== 'kunden') return false;
  return isMeaningfulLabel(parts[1]);
}

function hasBaustellePath(path: string | undefined): boolean {
  const parts = pathSegments(path);
  if (parts[0]?.toLowerCase() !== 'baustelle') return false;
  return isMeaningfulLabel(parts[1]);
}

function pathSuggestsArea(path: string | undefined): DocumentAreaId[] {
  if (!path) return [];
  const lower = path.toLowerCase();
  const areas: DocumentAreaId[] = [];

  if (lower.includes('/eingangsrechnungen/') || lower.includes('/ausgangsrechnungen/') || lower.includes('/kontoauszüge/') || lower.includes('/kontoauszuege/')) {
    areas.push('rechnungen');
  }
  if (lower.includes('/ausgaben/') || lower.includes('/tankbelege/')) {
    areas.push('belege');
  }
  if (lower.includes('/angebote/')) areas.push('angebote');
  if (lower.includes('/aufträge/') || lower.includes('/auftraege/') || lower.includes('/lieferscheine/') || lower.includes('/protokolle/')) {
    areas.push('auftraege');
  }
  if (lower.includes('/verträge/') || lower.includes('/vertraege/')) areas.push('vertraege');
  if (lower.includes('/behörden/') || lower.includes('/behoerden/') || lower.includes('/krankenkassen/') || lower.includes('/finanzamt/')) {
    areas.push('behoerden');
  }
  if (lower.includes('/mitarbeiter/')) areas.push('mitarbeiter');
  if (lower.includes('/versicherungen/')) areas.push('versicherungen');

  return areas;
}

function resolveLinkedVorgangContext(document: CompanyDocument): {
  hasSecureLink: boolean;
  hasCustomer: boolean;
  hasBaustelle: boolean;
} {
  const link = document.linkedVorgang;
  if (!link?.vorgangId) {
    return { hasSecureLink: false, hasCustomer: false, hasBaustelle: false };
  }
  const vorgang = getVorgangById(link.vorgangId);
  if (!vorgang) {
    // Link exists in archive metadata – treat as secure auftrag link, but not customer/site without entity
    return {
      hasSecureLink: Boolean(link.vorgangId && isMeaningfulLabel(link.vorgangTitle)),
      hasCustomer: false,
      hasBaustelle: false,
    };
  }
  return {
    hasSecureLink: true,
    hasCustomer: isMeaningfulLabel(vorgang.customer),
    hasBaustelle: isMeaningfulLabel(vorgang.baustelle),
  };
}

function uniqueOrdered(areas: DocumentAreaId[]): DocumentAreaId[] {
  const seen = new Set<DocumentAreaId>();
  const result: DocumentAreaId[] = [];
  for (const area of DOCUMENT_AREA_IDS) {
    if (areas.includes(area) && !seen.has(area)) {
      seen.add(area);
      result.push(area);
    }
  }
  return result;
}

/**
 * Returns all Fachbereiche a stored document belongs to.
 * Multiple areas may apply; projections share the same CompanyDocument / fileRefId.
 */
export function resolveDocumentAreas(document: CompanyDocument): DocumentAreaId[] {
  const kind = document.classifiedKind;
  const areas: DocumentAreaId[] = [];
  const link = resolveLinkedVorgangContext(document);
  const path = document.digitalFolder?.path;

  if (kind) {
    if (RECHNUNG_KINDS.has(kind)) areas.push('rechnungen');
    if (BELEG_KINDS.has(kind)) areas.push('belege');
    if (ANGEBOT_KINDS.has(kind)) areas.push('angebote');
    if (AUFTRAG_KINDS.has(kind)) areas.push('auftraege');
    if (VERTRAG_KINDS.has(kind)) {
      areas.push('vertraege');
    }
    if (BEHOERDE_KINDS.has(kind)) areas.push('behoerden');
    if (MITARBEITER_KINDS.has(kind)) areas.push('mitarbeiter');
    if (VERSICHERUNG_KINDS.has(kind)) areas.push('versicherungen');
    if (BAUSTELLE_KIND_SECURE.has(kind)) areas.push('baustellen');
    if (ALLGEMEIN_KINDS.has(kind)) areas.push('allgemein');

    // Unclear photos stay allgemein unless a strong site/vorgang signal exists
    if (kind === 'foto') {
      if (link.hasBaustelle || hasBaustellePath(path)) {
        areas.push('baustellen');
      } else if (!areas.includes('allgemein')) {
        areas.push('allgemein');
      }
    }
  }

  // Reliable Vorgang link also surfaces under Aufträge
  if (link.hasSecureLink) {
    areas.push('auftraege');
  }

  // Kunden only with reliable customer evidence (vorgang customer or confirmed Kunden path)
  if (link.hasCustomer || hasKundenPath(path)) {
    areas.push('kunden');
  }

  // Baustelle from Vorgang / confirmed path (beyond kind)
  if (link.hasBaustelle || hasBaustellePath(path)) {
    areas.push('baustellen');
  }

  // Path fallback for legacy docs without classifiedKind (and additive areas)
  areas.push(...pathSuggestsArea(path));

  const ordered = uniqueOrdered(areas);
  if (ordered.length === 0) {
    return ['allgemein'];
  }
  // If we only got allgemein from ALLGEMEIN_KINDS plus nothing else, fine.
  // If we have concrete areas, drop bare allgemein unless kind is explicitly allgemein-ish
  if (ordered.length > 1 && ordered.includes('allgemein') && kind && !ALLGEMEIN_KINDS.has(kind) && kind !== 'foto') {
    return ordered.filter((area) => area !== 'allgemein');
  }
  return ordered;
}

export function documentMatchesArea(
  document: CompanyDocument,
  area: DocumentAreaFilterId,
): boolean {
  if (area === 'alle') return true;
  return resolveDocumentAreas(document).includes(area);
}

export type DocumentPaperListStatus = 'filed' | 'pending';

export function resolveDocumentPaperListStatus(documentId: string): DocumentPaperListStatus {
  const memory = getDocumentMemoryByDocumentId(documentId);
  const entry = getPaperRegisterEntryForDocument(documentId);
  if (memory?.physicalFiled || entry?.physicalFiled) return 'filed';
  return 'pending';
}

export function getDocumentAreaLabelKey(area: DocumentAreaFilterId): `document.area.${DocumentAreaFilterId}` {
  return `document.area.${area}`;
}

/**
 * Suggested Fachbereich from kind + digital path only (no Vorgang entity).
 * Reuses the same kind/path signals as archive area resolution.
 */
export function resolveSuggestedDocumentAreaFromKind(
  kind: ClassifiedDocumentKind | undefined,
  path?: string,
): DocumentAreaId {
  const areas: DocumentAreaId[] = [];
  if (kind) {
    if (RECHNUNG_KINDS.has(kind)) areas.push('rechnungen');
    if (BELEG_KINDS.has(kind)) areas.push('belege');
    if (ANGEBOT_KINDS.has(kind)) areas.push('angebote');
    if (AUFTRAG_KINDS.has(kind)) areas.push('auftraege');
    if (VERTRAG_KINDS.has(kind)) areas.push('vertraege');
    if (BEHOERDE_KINDS.has(kind)) areas.push('behoerden');
    if (MITARBEITER_KINDS.has(kind)) areas.push('mitarbeiter');
    if (VERSICHERUNG_KINDS.has(kind)) areas.push('versicherungen');
    if (BAUSTELLE_KIND_SECURE.has(kind)) areas.push('baustellen');
    if (ALLGEMEIN_KINDS.has(kind)) areas.push('allgemein');
  }
  if (hasKundenPath(path)) areas.push('kunden');
  if (hasBaustellePath(path)) areas.push('baustellen');
  areas.push(...pathSuggestsArea(path));
  const ordered = uniqueOrdered(areas);
  if (ordered.length === 0) return 'allgemein';
  if (ordered.length > 1 && ordered.includes('allgemein') && kind && !ALLGEMEIN_KINDS.has(kind)) {
    return ordered.find((area) => area !== 'allgemein') ?? 'allgemein';
  }
  return ordered[0] ?? 'allgemein';
}

export { isDocumentAreaId };

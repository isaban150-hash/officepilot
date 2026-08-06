import type { ClassifiedDocumentKind, DocumentType } from '../types/models';

export type PrimaryTargetObjectType =
  | 'vorgang'
  | 'expense'
  | 'vorgangInvoice'
  | 'proofMemory'
  | 'companyDocument';

const VORGANG_KINDS = new Set<ClassifiedDocumentKind>([
  'werkvertrag',
  'subunternehmervertrag',
  'nachunternehmervertrag',
  'auftrag',
  'angebot',
  'auftragsbestaetigung',
  'leistungsverzeichnis',
  'nachtrag',
  'lieferschein',
  'abnahmeprotokoll',
  'maengelprotokoll',
  'uebergabeprotokoll',
  'stundenzettel',
  'baustellenfoto',
  'pruefprotokoll',
  'messprotokoll',
  'materialnachweis',
  'entsorgungsnachweis',
  'sicherheitsdokument',
  'foto',
]);

const EXPENSE_KINDS = new Set<ClassifiedDocumentKind>([
  'eingangsrechnung',
  'rechnung',
  'gutschrift',
  'quittung',
  'kassenbeleg',
  'ec_beleg',
  'kreditkartenbeleg',
  'tankbeleg',
  'reparaturrechnung',
  'mahnung',
  'zahlungserinnerung',
]);

const VORGANG_INVOICE_KINDS = new Set<ClassifiedDocumentKind>([
  'ausgangsrechnung',
]);

const PROOF_MEMORY_KINDS = new Set<ClassifiedDocumentKind>([
  'freistellungsbescheinigung',
  'unbedenklichkeitsbescheinigung',
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
  'betriebshaftpflicht',
  'fahrzeugversicherung',
  'rechtsschutzversicherung',
  'gebaeudeversicherung',
  'versicherungsbescheid',
  'versicherung',
  'zertifikat',
  'iso_nachweis',
]);

export function resolvePrimaryTargetObjectForKind(
  kind: ClassifiedDocumentKind,
): PrimaryTargetObjectType {
  if (VORGANG_KINDS.has(kind)) return 'vorgang';
  if (EXPENSE_KINDS.has(kind)) return 'expense';
  if (VORGANG_INVOICE_KINDS.has(kind)) return 'vorgangInvoice';
  if (PROOF_MEMORY_KINDS.has(kind)) return 'proofMemory';
  return 'companyDocument';
}

export function resolvePrimaryTargetObjectForDocumentType(
  documentType: DocumentType,
): PrimaryTargetObjectType {
  if (documentType === 'kundenauftrag') return 'vorgang';
  if (documentType === 'eingangsrechnung') return 'expense';
  if (documentType === 'ausgangsrechnung') return 'vorgangInvoice';
  return 'companyDocument';
}

import type { ClassifiedDocumentKind } from '../types/models';
import type { ExpenseCategory } from '../types/expense';

export const EXPENSE_KIND_TO_CATEGORY: Partial<Record<ClassifiedDocumentKind, ExpenseCategory>> = {
  eingangsrechnung: 'material',
  rechnung: 'material',
  lieferschein: 'material',
  mahnung: 'material',
  zahlungserinnerung: 'material',
  gutschrift: 'gutschrift',
  quittung: 'sonstiges',
  kassenbeleg: 'sonstiges',
  ec_beleg: 'sonstiges',
  kreditkartenbeleg: 'sonstiges',
  tankbeleg: 'fahrzeug',
  reparaturrechnung: 'werkzeug',
  leasingvertrag: 'leasing',
  werkvertrag: 'subunternehmer',
  subunternehmervertrag: 'subunternehmer',
  nachunternehmervertrag: 'subunternehmer',
  lohnabrechnung: 'personal',
  lohnunterlagen: 'personal',
  stundenzettel: 'personal',
  bg_bau: 'behoerde',
  berufsgenossenschaft: 'behoerde',
  soka_bau: 'behoerde',
  finanzamt: 'behoerde',
  steuerbescheid: 'behoerde',
  umsatzsteuerbescheid: 'behoerde',
  aok: 'behoerde',
  barmer: 'behoerde',
  tk: 'behoerde',
  dak: 'behoerde',
  ikk: 'behoerde',
  krankenkasse: 'behoerde',
  knappschaft: 'behoerde',
  pflegekasse: 'behoerde',
  betriebshaftpflicht: 'versicherung',
  fahrzeugversicherung: 'versicherung',
  rechtsschutzversicherung: 'versicherung',
  gebaeudeversicherung: 'versicherung',
  versicherungsbescheid: 'versicherung',
  versicherung: 'versicherung',
};

export const EXPENSE_CATEGORIES: ExpenseCategory[] = [
  'material',
  'werkzeug',
  'fahrzeug',
  'reise',
  'subunternehmer',
  'personal',
  'versicherung',
  'behoerde',
  'betrieb',
  'leasing',
  'gutschrift',
  'sonstiges',
];

export function mapClassifiedKindToExpenseCategory(
  kind?: ClassifiedDocumentKind | null,
): ExpenseCategory {
  if (!kind) return 'sonstiges';
  return EXPENSE_KIND_TO_CATEGORY[kind] ?? 'sonstiges';
}

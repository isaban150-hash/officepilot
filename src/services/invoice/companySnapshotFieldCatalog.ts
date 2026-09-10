import type { CompanyProfile } from '../../types/models';

/**
 * COMPANY-SNAPSHOT-FIELD-CATALOG-01B — die erlaubten Schlüssel des
 * `companySnapshot` einer Rechnung. Eine Quelle, zwei Validatoren.
 *
 * Der Anlass ist ein Fehler, der bereits eingetreten ist: Beim Registerblock
 * wurden `registrationAuthority` und `registrationNumber` nur in **einer** der
 * beiden Positivlisten ergänzt. Der Cloud-Payload-Validator liess die Rechnung
 * durch, der Prepared-Finalize-Request-Validator wies sie danach mit
 * `unknown_field` ab — und zwar für jeden eingetragenen Betrieb. Zwei Listen,
 * die dasselbe bedeuten sollen, laufen früher oder später auseinander; wer die
 * eine repariert, sieht die andere nicht.
 *
 * Was hier steht, ist deshalb **ausschliesslich** der Schlüsselvertrag. Keine
 * Typregeln, keine Fehlercodes, keine Pflicht-/Optionalunterscheidung, keine
 * Businesslogik: Die beiden Validatoren prüfen fachlich verschieden — der eine
 * meldet `not_text`, der andere `not_string` — und das bleibt bewusst so. Sie
 * teilen sich die Frage „welcher Schlüssel darf überhaupt vorkommen", sonst
 * nichts.
 *
 * Kein React, keine Cloud, kein PDF, kein Zustand.
 */
export const COMPANY_SNAPSHOT_KEYS = [
  'companyName',
  'legalForm',
  'logoDataUrl',
  'street',
  'zip',
  'city',
  'country',
  'contactPerson',
  'phone',
  'email',
  'website',
  'taxNumber',
  'vatId',
  'registrationAuthority',
  'registrationNumber',
  'bankName',
  'iban',
  'bic',
  'defaultPaymentDays',
  'defaultPaymentTerms',
  'defaultSkonto',
  'skontoEnabled',
  'skontoPercent',
  'skontoDays',
  'managingDirector',
  'taxFreeNotice',
  'invoiceFooterNotes',
] as const satisfies readonly (keyof CompanyProfile)[];

export type CompanySnapshotKey = (typeof COMPANY_SNAPSHOT_KEYS)[number];

/**
 * Bewusst **nicht** im Rechnungsvertrag — und das ist keine Lücke.
 *
 * `branding` ist ein geschlossener Unterblock mit eigenem Vertrag
 * (BRANDING-01E-1/01F-2): Asset-Referenzen, Speicherpfade, signierte URLs und
 * Bildbytes haben in einem Rechnungs-Snapshot nichts zu suchen, und der
 * `unknown_field`-Schutz ist genau die Stelle, die sie draussen hält. Ob und
 * wie ein Branding in einer Rechnung eingefroren wird, entscheidet
 * `brandingSnapshot` — nicht dieser Katalog.
 *
 * Die Vollständigkeit gegenüber `CompanyProfile` wird deshalb **nicht**
 * gefordert: Sie würde genau die Felder hereinzwingen, die hier
 * ausgeschlossen gehören. Umgekehrt gilt die Richtung sehr wohl — jeder
 * Eintrag oben muss ein echter Schlüssel von `CompanyProfile` sein, dafür
 * sorgt das `satisfies`.
 */
export type ExcludedFromCompanySnapshot = Exclude<keyof CompanyProfile, CompanySnapshotKey>;

/**
 * Compile-Time-Wächter: `branding` darf nie in den Katalog rutschen.
 *
 * Trüge jemand den Schlüssel oben ein, verschwände `'branding'` aus
 * `ExcludedFromCompanySnapshot`, und diese Zuweisung schlüge fehl — beim
 * Übersetzen, nicht erst beim Kunden.
 */
const _brandingStaysExcluded: Extract<ExcludedFromCompanySnapshot, 'branding'> = 'branding';
void _brandingStaysExcluded;

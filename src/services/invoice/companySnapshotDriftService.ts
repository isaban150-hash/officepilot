import type { CompanyProfile } from '../../types/models';

/**
 * COMPANY-PROFILE-DRAFT-DRIFT-01E — haben sich die rechnungskritischen
 * Stammdaten seit der Entstehung des Entwurfs geändert?
 *
 * Ein Rechnungsentwurf trägt seinen eigenen `companySnapshot` und behält ihn —
 * das ist die bestehende, ausdrücklich begründete Regel. Für die meisten Felder
 * ist das richtig: Zahlungsziel, Skonto und Zahlungsbedingungen sind
 * **Entscheidungen** dieser einen Rechnung, kein veralteter Abzug.
 *
 * Für eine Handvoll Felder ist der eingefrorene Wert dagegen schlicht
 * **falsch**, sobald der Betrieb ihn ändert: Eine Rechnung mit der alten
 * Bankverbindung leitet Geld auf ein Konto, das gerade aufgegeben wird, und
 * eine Rechnung unter der alten Firmierung trägt eine unrichtige Pflichtangabe.
 *
 * Deshalb vergleicht dieser Dienst genau diese Felder — nicht mehr. Er
 * entscheidet nichts; er stellt nur fest.
 */

/** Rechtliche Absenderidentität. */
const LEGAL_IDENTITY_FIELDS = [
  'companyName',
  'legalForm',
  'street',
  'zip',
  'city',
  'country',
  'taxNumber',
  'vatId',
] as const;

/** Das Konto, auf das der Kunde zahlen soll. */
const PAYMENT_ACCOUNT_FIELDS = ['bankName', 'iban', 'bic'] as const;

export const CRITICAL_COMPANY_FIELDS = [
  ...LEGAL_IDENTITY_FIELDS,
  ...PAYMENT_ACCOUNT_FIELDS,
] as const;

export type CriticalCompanyField = (typeof CRITICAL_COMPANY_FIELDS)[number];

/**
 * Felder, deren Schreibweise keine fachliche Änderung ist.
 *
 * `DE89 3704 0044 0532 0130 00` und `de8937040044053201300` bezeichnen dasselbe
 * Konto; eine Warnung dafür wäre reiner Lärm. Firmenname und Anschrift werden
 * bewusst **nicht** so behandelt: „Müller Bau GmbH" und „Müller Bau GmbH & Co.
 * KG" sind zwei verschiedene Unternehmen, und der Unterschied darf nicht
 * wegnormalisiert werden.
 */
const CASE_AND_SPACE_INSENSITIVE: ReadonlySet<CriticalCompanyField> = new Set([
  'iban',
  'bic',
  'vatId',
]);

function normalize(field: CriticalCompanyField, value: string | undefined | null): string {
  const raw = (value ?? '').trim();
  if (!CASE_AND_SPACE_INSENSITIVE.has(field)) return raw;
  return raw.replace(/\s+/g, '').toUpperCase();
}

/**
 * Die geänderten kritischen Felder — leer, wenn alles unverändert ist.
 *
 * `null`, `undefined` und der leere String gelten einheitlich als „nicht
 * gesetzt": Ein Feld, das nie befüllt war und weiterhin leer ist, hat sich
 * nicht geändert.
 */
export function findCriticalCompanyProfileDrift(
  snapshot: CompanyProfile | undefined,
  profile: CompanyProfile,
): CriticalCompanyField[] {
  if (!snapshot) return [];
  return CRITICAL_COMPANY_FIELDS.filter(
    (field) => normalize(field, snapshot[field]) !== normalize(field, profile[field]),
  );
}

/**
 * Übernimmt **ausschliesslich** die kritischen Felder in den Snapshot.
 *
 * Alles andere bleibt, wie es im Entwurf steht — Logo, Primärfarbe,
 * Fußnoten, Kontaktdaten und sämtliche Standardwerte für Zahlungsziel und
 * Skonto. Ein halb erneuerter Absender wäre schlechter als beide reinen
 * Zustände, deshalb ist die Übernahme innerhalb der kritischen Felder
 * vollständig und ausserhalb gar nicht.
 */
export function applyCriticalCompanyProfileFields(
  snapshot: CompanyProfile,
  profile: CompanyProfile,
): CompanyProfile {
  const next: CompanyProfile = { ...snapshot };
  for (const field of CRITICAL_COMPANY_FIELDS) {
    next[field] = profile[field];
  }
  return next;
}

/**
 * Kennzeichen des verglichenen Profilstands.
 *
 * Eine Bestätigung gilt **nur** für den Stand, gegen den sie erteilt wurde:
 * Ändert der Betrieb danach erneut etwas, entsteht ein anderes Kennzeichen und
 * die Rückfrage erscheint wieder. Ein blosses „schon bestätigt" wäre eine
 * Zusage auf ewig — und genau die wäre gefährlich.
 */
export function buildCriticalCompanyFingerprint(profile: CompanyProfile): string {
  return CRITICAL_COMPANY_FIELDS.map((field) => `${field}=${normalize(field, profile[field])}`).join(
    '|',
  );
}

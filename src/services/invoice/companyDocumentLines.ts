import type { CompanyProfile } from '../../types/models';

/**
 * INVOICE-PDF-COMPANY-BLOCK-01 — die semantischen Firmenzeilen eines Belegs.
 *
 * Der Anlass ist ein belegter Ausgabekonflikt: Bildschirm-/Druckansicht und
 * das tatsächlich versendete PDF zeigten unterschiedliche Firmenangaben. Die
 * Registerzeile war zweimal zu formulieren — einmal im `InvoiceFooter`, einmal
 * im PDF — und genau daraus entsteht die nächste Abweichung.
 *
 * Deshalb steht die Regel hier **einmal**: eine reine Funktion ohne React, ohne
 * pdf-lib, ohne Zustand. Beide Ausgabewege lesen sie, keiner formuliert sie
 * neu. Das ist ausdrücklich **kein** Dokumentdesign-Framework — es ist eine
 * Zeichenkette und die Frage, wann sie entfällt.
 */

/** Der Wortlaut aus der bestehenden Darstellung — bewusst nicht neu erfunden. */
export const MANAGING_DIRECTOR_LABEL = 'Geschäftsführer/Inhaber';
export const REGISTRATION_AUTHORITY_LABEL = 'Registergericht';

/**
 * Die Registerangabe, oder ein leerer String.
 *
 * Ein Beleg darf keine halbe Pflichtangabe tragen: Fehlt eines der beiden
 * Felder, steht nur das vorhandene da — ohne Trennzeichen, das ins Leere
 * zeigt. Sind beide leer, entfällt die Zeile vollständig; ein Platzhalter auf
 * einer finalen Rechnung wäre schlimmer als die Lücke.
 */
export function formatRegisterLine(company: Partial<CompanyProfile>): string {
  const authority = (company.registrationAuthority ?? '').trim();
  const number = (company.registrationNumber ?? '').trim();
  if (!authority && !number) return '';
  if (!authority) return number;
  return [`${REGISTRATION_AUTHORITY_LABEL}: ${authority}`, number].filter(Boolean).join(' · ');
}

/**
 * Die Vertretungszeile, oder ein leerer String.
 *
 * Der gespeicherte Wert wird **unverändert** übernommen. `managingDirector` ist
 * ein Freitextfeld, in dem auch mehrere Namen stehen dürfen — „Max Mustermann,
 * Erika Beispiel" ist eine gültige Angabe und keine Liste, die hier
 * aufzutrennen wäre. Ein Komma kann ebenso gut Teil eines einzelnen Namens
 * sein; jede Heuristik erfände hier Personen oder zerschnitte einen Namen.
 */
export function formatManagingDirectorLine(company: Partial<CompanyProfile>): string {
  const value = (company.managingDirector ?? '').trim();
  if (!value) return '';
  return `${MANAGING_DIRECTOR_LABEL}: ${value}`;
}

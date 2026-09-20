/**
 * BRIEFE-01B — das Geschäftsschreiben als eigene fachliche Entität.
 *
 * Ein Brief ist kein Nebenprodukt einer Nachricht, sondern ein Dokument mit
 * eigenem Lebenslauf: Er entsteht als Entwurf, wird irgendwann fertiggestellt
 * und ist ab dann ein historischer Beleg. Genau diese zwei Zustände gibt es,
 * mehr braucht ein kleiner Betrieb nicht.
 *
 * **Der Versand gehört ausdrücklich nicht hierher.** Ob ein Brief per E-Mail
 * hinausging, führt der Versandweg in seinem eigenen Datensatz
 * (`DeliveryIntent` mit `documentKind: 'letter'`). Würde der Versandstand am
 * Brief hängen, wäre nach dem zweiten Versuch nicht mehr unterscheidbar, was
 * der Brief ist und was mit ihm geschah.
 */
import type { CompanyProfile } from './models';
import type { SyncableEntity } from './sync';

/**
 * `draft` — in Arbeit, jederzeit änderbar, Absender und Empfänger werden noch
 * aus den aktuellen Stammdaten vorbelegt.
 *
 * `finalized` — abgeschlossen. Der fachliche Inhalt steht fest und darf sich
 * durch spätere Änderungen am Firmenprofil oder am Kundenstamm nicht mehr
 * verschieben.
 */
export const BUSINESS_LETTER_STATUSES = ['draft', 'finalized'] as const;
export type BusinessLetterStatus = (typeof BUSINESS_LETTER_STATUSES)[number];

/**
 * Die Anschrift des Empfängers — bewusst als eigene Felder am Brief und nicht
 * als Verweis auf den Kundenstamm.
 *
 * Der Verweis (`customerId`) sagt, an wen der Brief ging; diese Felder sagen,
 * **wohin er tatsächlich adressiert war**. Zieht der Kunde später um, bleibt
 * der abgeschickte Brief richtig.
 */
export interface BusinessLetterRecipient {
  name: string;
  company?: string;
  street: string;
  zip: string;
  city: string;
  country?: string;
}

export interface BusinessLetter extends SyncableEntity {
  id: string;
  /** Der Arbeitsbereich, zu dem der Brief gehört. */
  workspaceId: string;
  subject: string;
  body: string;
  /** Das Datum, das auf dem Brief steht — vom Nutzer änderbar (ISO, nur Tag). */
  letterDate: string;
  recipient: BusinessLetterRecipient;
  /** Bezug zum Kundenstamm, falls der Empfänger von dort stammt. */
  customerId?: string;
  /** Bezug zum Auftrag, falls der Brief zu einem Vorgang gehört. */
  vorgangId?: string;
  status: BusinessLetterStatus;
  /**
   * Die Absenderdaten, wie sie bei der Fertigstellung galten.
   *
   * Im Entwurf bleibt das Feld leer: Dort wird beim Anzeigen das aktuelle
   * Firmenprofil benutzt, und Korrekturen daran sollen sich noch auswirken.
   * Mit der Fertigstellung wird es gefüllt und ist danach die Wahrheit über
   * diesen Brief — dieselbe Regel, die das Produkt für freigegebene Rechnungen
   * bereits zusagt („Bereits freigegebene Rechnungen bleiben unverändert").
   */
  companySnapshot?: CompanyProfile;
  /** Das Archivdokument zum erzeugten PDF; entsteht erst in einem späteren Block. */
  documentId?: string;
  createdAt: string;
  updatedAt?: string;
}

/** Die Felder, die beim Anlegen und Ändern von aussen kommen dürfen. */
export interface BusinessLetterInput {
  subject: string;
  body: string;
  letterDate?: string;
  recipient: BusinessLetterRecipient;
  customerId?: string;
  vorgangId?: string;
}

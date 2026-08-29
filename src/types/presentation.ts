/**
 * SHARED-PRESENTATION-CONTEXT-01 — gemeinsame Präsentationsdaten.
 *
 * Zweck: Rechnung, Angebot, Brief, E-Mail und PDF sollen sich Absender,
 * Empfänger und Projektbezug nicht jeweils selbst zusammensuchen. Heute tun
 * sie das — `invoicePrintModel` löst anders auf als `communicationContextService`,
 * und beide kennen `customerId` nicht.
 *
 * Was dieser Context ausdrücklich **nicht** ist:
 *
 *  - Keine zweite fachliche Wahrheit. Er wird aus bereits aufgelösten bzw.
 *    eingefrorenen Werten abgeleitet, nie gespeichert und nie synchronisiert.
 *  - Keine Identity Engine. Wer der Kunde ist, entscheidet der Fachcode über
 *    `customerId`; hier reist die ID nur als Herkunftsnachweis mit.
 *  - Kein Rechnungsmodell. Positionen, Mengen, Preise, Steuer, Abschläge,
 *    Skonto, Leistungszeitraum und Rechnungsnummer bleiben im Fachobjekt. Ein
 *    Renderer bekommt später beides: Fachmodell **und** diesen Context.
 *  - Kein Branding. Logo, Farben, Typografie und Template-Auswahl folgen im
 *    Branding-Block; `logoDataUrl` wird hier bewusst nicht übernommen.
 */

/** Feste Version des Präsentationsvertrags. Kein Schema-/Cloud-Versionssystem. */
export const SHARED_PRESENTATION_CONTEXT_VERSION = 1;

/**
 * Woher die Daten einer Partei stammen. Der Context **löst nichts auf** — die
 * Herkunft wird vom Aufrufer mitgegeben und hier nur transparent mitgeführt.
 * Bewusst auf Partei-Ebene statt feldweise: Für die Frage „warum steht dieser
 * Name auf dem Dokument" genügt das, und mehr wäre Ballast.
 */
export type PresentationSource =
  | 'draft_snapshot'
  | 'invoice_snapshot'
  | 'vorgang_snapshot'
  | 'customer_master_snapshot'
  | 'current_company_snapshot'
  | 'document_override';

/**
 * Gemeinsame Parteidaten. Alles ausser `name` ist optional: Fehlende Angaben
 * bleiben leer — der Context erfindet nichts.
 */
export interface PresentationParty {
  name: string;
  contactPerson?: string;
  street?: string;
  zip?: string;
  city?: string;
  country?: string;
  email?: string;
  phone?: string;
  website?: string;
}

/**
 * Der Absender trägt zusätzlich die rechnungs- und briefkopfrelevanten
 * Firmenangaben. Alle Felder stammen aus dem vorhandenen `CompanyProfile` —
 * es wird kein neues Geschäftsfeld erfunden.
 */
export interface PresentationIssuer extends PresentationParty {
  legalForm?: string;
  taxNumber?: string;
  vatId?: string;
  bankName?: string;
  iban?: string;
  bic?: string;
  managingDirector?: string;
}

/** Projektbezug, soweit vorhanden. */
export interface PresentationProject {
  vorgangId: string;
  title?: string;
  site?: string;
}

/** Umfeld des Dokuments — nicht sein Inhalt. */
export interface PresentationDocumentEnvironment {
  type: string;
  locale: string;
}

export interface PresentationProvenance {
  issuer: PresentationSource;
  recipient: PresentationSource;
}

/**
 * `draft` — noch veränderliche Fassung, dargestellt wird der übergebene
 *           Entwurfs-Snapshot.
 * `final` — finalisiert/historisch, dargestellt werden ausschliesslich die
 *           eingefrorenen Snapshots.
 */
export type PresentationMode = 'draft' | 'final';

export interface SharedPresentationContext {
  version: typeof SHARED_PRESENTATION_CONTEXT_VERSION;
  mode: PresentationMode;
  issuer: PresentationIssuer;
  recipient: PresentationParty;
  /**
   * Reine Herkunftsreferenz auf den Kundenstamm. Wird nie dargestellt und vom
   * Builder nie aufgelöst.
   */
  recipientCustomerId?: string;
  project?: PresentationProject;
  document: PresentationDocumentEnvironment;
  provenance: PresentationProvenance;
}

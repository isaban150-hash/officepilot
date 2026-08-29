/**
 * SHARED-PRESENTATION-CONTEXT-01B — der gemeinsame Präsentations-Builder.
 *
 * Reine Funktionen: keine Store-Zugriffe, keine Services, kein Netz, keine
 * Persistenz, keine Outbox. Gleiche Eingabe ergibt denselben Context.
 *
 * Die beiden Modi sind **getrennte Funktionen mit getrennten Eingaben**, nicht
 * eine Funktion mit optionalen Parametern. So gibt es im finalen Pfad kein
 * Feld, über das neben den Snapshots noch eine zweite Quelle hereinreichen und
 * als Rückfallebene dienen könnte.
 *
 * Was diese Trennung **nicht** leistet: Sie kann nicht prüfen, ob das
 * übergebene `CompanyProfile` tatsächlich ein historischer Stand ist oder das
 * aktuelle Profil. Beides hat denselben Typ. Die Garantie dieses Bausteins
 * lautet daher genau:
 *
 *   - er liest selbst keine Live-Quelle,
 *   - er hat keinen Customer- oder Company-Lookup,
 *   - er hat keinen Live-Fallback,
 *   - er verwendet ausschliesslich die übergebenen Objekte.
 *
 * Dass diese Objekte im finalen Pfad wirklich die eingefrorenen Snapshots
 * sind, muss der spätere produktive Aufrufer gewährleisten.
 *
 * Der Builder trifft **keine** fachliche Entscheidung. Er vergleicht keine
 * Namen, liest keinen Kundenstamm, erkennt keine Eigenfirma und ergänzt nichts.
 * Er stellt dar, was ihm übergeben wurde.
 */
import type { CompanyProfile, CustomerBilling } from '../../types/models';
import {
  SHARED_PRESENTATION_CONTEXT_VERSION,
  type PresentationDocumentEnvironment,
  type PresentationIssuer,
  type PresentationParty,
  type PresentationProject,
  type PresentationSource,
  type SharedPresentationContext,
} from '../../types/presentation';

/**
 * Fehlender Text wird zu `undefined` — mehr geschieht nicht.
 *
 * Bewusst **ohne** `trim()`: Ein Snapshot ist ein historischer Wert. Ihn beim
 * Darstellen stillschweigend zu säubern hiesse, das Dokument zu verändern —
 * und sei es nur um ein Leerzeichen. Steht in einem eingefrorenen Kundenstand
 * `' Musterstraße 1 '`, dann stand das dort, und genau das wird gezeigt.
 * Normalisierung gehört an die Stelle, an der die Werte entstehen.
 *
 *   undefined → undefined
 *   null      → undefined
 *   ''        → undefined
 *   sonst     → unverändert
 */
function optionalText(value: string | undefined | null): string | undefined {
  return value === undefined || value === null || value === '' ? undefined : value;
}

/**
 * Absender aus dem Firmenprofil. `logoDataUrl` wird bewusst **nicht**
 * übernommen: Asset- und Logo-Historie gehören in den Branding-Block.
 * Zahlungsdefaults und Steuerhinweise bleiben ebenfalls draussen — sie sind
 * Rechnungsfachlichkeit, nicht Absenderidentität.
 */
function toPresentationIssuer(profile: CompanyProfile): PresentationIssuer {
  return {
    name: profile.companyName,
    contactPerson: optionalText(profile.contactPerson),
    street: optionalText(profile.street),
    zip: optionalText(profile.zip),
    city: optionalText(profile.city),
    country: optionalText(profile.country),
    email: optionalText(profile.email),
    phone: optionalText(profile.phone),
    website: optionalText(profile.website),
    legalForm: optionalText(profile.legalForm),
    taxNumber: optionalText(profile.taxNumber),
    vatId: optionalText(profile.vatId),
    bankName: optionalText(profile.bankName),
    iban: optionalText(profile.iban),
    bic: optionalText(profile.bic),
    managingDirector: optionalText(profile.managingDirector),
  };
}

/** Empfänger aus den Rechnungs-/Kontaktdaten. `CustomerBilling` kennt kein Land. */
function toPresentationParty(billing: CustomerBilling): PresentationParty {
  return {
    name: billing.name,
    contactPerson: optionalText(billing.contactPerson),
    street: optionalText(billing.street),
    zip: optionalText(billing.zip),
    city: optionalText(billing.city),
    email: optionalText(billing.email),
    phone: optionalText(billing.phone),
  };
}

function toPresentationProject(
  project: PresentationProject | undefined,
): PresentationProject | undefined {
  if (!project) return undefined;
  return {
    vorgangId: project.vorgangId,
    title: optionalText(project.title),
    site: optionalText(project.site),
  };
}

export interface DraftSharedPresentationContextInput {
  /** Der beim Entwurf eingefrorene Firmenstand — nicht das Live-Profil. */
  companySnapshot: CompanyProfile;
  /** Der beim Entwurf eingefrorene Empfängerstand. */
  customerBilling: CustomerBilling;
  /** Nur Herkunftsreferenz; wird nicht aufgelöst und nicht dargestellt. */
  recipientCustomerId?: string;
  project?: PresentationProject;
  document: PresentationDocumentEnvironment;
  /**
   * Woher die übergebenen Werte stammen. Der Aufrufer weiss es, der Builder
   * nicht. Ohne Angabe gilt die Vorgabe für Entwürfe.
   */
  issuerSource?: PresentationSource;
  recipientSource?: PresentationSource;
}

/**
 * Entwurfsfassung.
 *
 * Entscheidend: Auch ein Entwurf ist bereits ein Snapshot. Wird der
 * Kundenstamm nach dem Anlegen geändert, darf das blosse erneute Öffnen des
 * Entwurfs seine Anschrift nicht ändern. Deshalb nimmt diese Funktion den
 * Entwurfs-Snapshot entgegen und **keine** Live-Quelle, zwischen der sie
 * abwägen könnte.
 *
 * Ob bei der *Ersterzeugung* eines Entwurfs der Kundenstamm über `customerId`
 * übernommen wird, ist eine Frage des Fachcodes — nicht dieser Schicht.
 */
export function buildDraftSharedPresentationContext(
  input: DraftSharedPresentationContextInput,
): SharedPresentationContext {
  return {
    version: SHARED_PRESENTATION_CONTEXT_VERSION,
    mode: 'draft',
    issuer: toPresentationIssuer(input.companySnapshot),
    recipient: toPresentationParty(input.customerBilling),
    recipientCustomerId: optionalText(input.recipientCustomerId),
    project: toPresentationProject(input.project),
    document: { type: input.document.type, locale: input.document.locale },
    provenance: {
      issuer: input.issuerSource ?? 'draft_snapshot',
      recipient: input.recipientSource ?? 'draft_snapshot',
    },
  };
}

export interface FinalSharedPresentationContextInput {
  /** Beim Finalisieren eingefroren. Pflicht — es gibt keinen Ersatz. */
  companySnapshot: CompanyProfile;
  /** Beim Finalisieren eingefroren. Pflicht — es gibt keinen Ersatz. */
  customerSnapshot: CustomerBilling;
  recipientCustomerId?: string;
  project?: PresentationProject;
  document: PresentationDocumentEnvironment;
}

/**
 * Finalisierte/historische Fassung.
 *
 * Dargestellt wird ausschliesslich, was übergeben wurde. Diese Funktion holt
 * sich nirgends ein aktuelles Profil oder einen Kundenstamm, und sie füllt
 * insbesondere **keine leeren Snapshot-Felder** aus anderen Quellen auf: Genau
 * das wäre die rückwirkende Änderung eines Dokuments, die es zu verhindern
 * gilt. Dass die Eingaben die eingefrorenen Stände sind, verantwortet der
 * Aufrufer — der Typ allein kann das nicht unterscheiden.
 *
 * Fehlt ein Snapshot, wird geworfen statt ausgewichen — dasselbe harte
 * Verhalten, das `buildInvoicePrintModelFromInvoice` bereits durchhält. Der
 * Typ verlangt beide Snapshots ohnehin; die Prüfung fängt Aufrufer ab, die
 * ohne Typprüfung ankommen (Cloud-Payload, Altbestand, JavaScript).
 */
export function buildFinalSharedPresentationContext(
  input: FinalSharedPresentationContextInput,
): SharedPresentationContext {
  if (!input.companySnapshot) {
    throw new Error(
      'SHARED-PRESENTATION-CONTEXT: companySnapshot fehlt – finalisierte Dokumente haben keinen Live-Fallback.',
    );
  }
  if (!input.customerSnapshot) {
    throw new Error(
      'SHARED-PRESENTATION-CONTEXT: customerSnapshot fehlt – finalisierte Dokumente haben keinen Live-Fallback.',
    );
  }

  return {
    version: SHARED_PRESENTATION_CONTEXT_VERSION,
    mode: 'final',
    issuer: toPresentationIssuer(input.companySnapshot),
    recipient: toPresentationParty(input.customerSnapshot),
    recipientCustomerId: optionalText(input.recipientCustomerId),
    project: toPresentationProject(input.project),
    document: { type: input.document.type, locale: input.document.locale },
    provenance: { issuer: 'invoice_snapshot', recipient: 'invoice_snapshot' },
  };
}

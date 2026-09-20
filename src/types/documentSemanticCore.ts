/**
 * DOKUMENTVERSTAENDNIS-01B — der semantische Kern eines eingegangenen Schreibens.
 *
 * Die Leitidee: **Bedeutung vor Dokumentart.** Bis hierher hing fast alles an
 * `ClassifiedDocumentKind` — 115 fest verdrahtete Arten, und was keine davon
 * traf, wurde zu „Sonstiges" und verlor seinen fachlichen Gehalt. Eine
 * Mängelanzeige mit zwei Fristen und einer Forderung sah danach aus wie ein
 * leeres Blatt mit Absender.
 *
 * Dieser Kern beschreibt stattdessen, was in einem Schreiben *steht*, in
 * Begriffen, die für jedes Schreiben gelten: worum es geht, wer etwas will, bis
 * wann, welche Beträge vorkommen und welche Rolle sie haben. Eine unbekannte
 * Schreibensart ist damit kein Sonderfall mehr, sondern der Normalfall.
 *
 * Bewusst **keine zweite Gehirn-Architektur**: Der Kern hängt als ein Feld an
 * `BusinessInterpretationResult`, übernimmt dessen Sicherheitsvokabular
 * (`BusinessFactCertainty`) und dessen Fristtypen (`BusinessDeadlineType`), und
 * er ist wie das ganze Interpretationsergebnis **nur lesend**. Er verknüpft
 * nichts, legt nichts an und bucht nichts.
 */
import type { BusinessDeadlineType, BusinessFactCertainty } from './businessInterpretation';

/**
 * Die Belegstelle im Text. Bewusst schlicht: der Textausschnitt, aus dem die
 * Angabe stammt. Wer eine Angabe anzweifelt, soll nachlesen können, worauf sie
 * beruht — dieselbe Absicht wie `EvidenceRef` in `DocumentAnalysisResult`, nur
 * ohne dessen Zonen- und Seitenapparat, den der Fliesstext hier nicht hergibt.
 */
export interface SemanticEvidence {
  snippet: string;
}

/* ------------------------------------------------------------------ *
 * DOKUMENT-FACHWISSEN-01I1 — Bescheinigungen auseinanderhalten
 * ------------------------------------------------------------------ */

/**
 * Welche Art von Bescheinigung ein Dokument ist.
 *
 * Drei Arten, die sich in ihren Wörtern ähneln und in ihrer Wirkung nicht:
 *
 *   `construction_withholding_exemption` — Freistellungsbescheinigung nach
 *        § 48b EStG. Der Auftraggeber behält die Bauabzugsteuer **nicht** ein.
 *   `reverse_charge_construction_status` — Bescheinigung USt 1 TG nach
 *        § 13b UStG. Der Leistungsempfänger schuldet die **Umsatzsteuer**.
 *   `domestic_establishment` — Bescheinigung USt 1 TS über die Ansässigkeit
 *        im Inland.
 *
 * Die beiden ersten in dieselbe Schublade zu werfen wäre der teuerste Fehler
 * dieser Familie: Die eine sagt, dass nichts einbehalten wird, die andere,
 * dass die Steuerschuld übergeht. Wer sie verwechselt, stellt seine Rechnung
 * falsch.
 */
export type SemanticCertificateType =
  | 'construction_withholding_exemption'
  | 'reverse_charge_construction_status'
  | 'domestic_establishment';

/**
 * Paragraf und Gesetz als Angabe, nicht als Fliesstext.
 *
 * Erst damit lässt sich prüfen, ob ein Dokument einem Thema **widerspricht**.
 * Im Freitext sind „§ 48b EStG" und „§ 13b UStG" zwei ähnliche Zeichenketten;
 * hier sind es zwei verschiedene Gesetze.
 *
 * `subsection` steht nur da, wenn der Absatz wirklich im Text stand. Geraten
 * wird er nie — und gerade bei § 13b entscheidet er, um welche der beiden
 * Bescheinigungen es geht.
 */
export interface SemanticLegalReference {
  /** Kürzel des Gesetzes, z. B. 'EStG' oder 'UStG'. */
  law: string;
  /** Paragraf mit etwaigem Buchstaben, z. B. '48b' oder '13b'. */
  paragraph: string;
  /** Absatz, nur wenn belegt. */
  subsection?: string;
}

/**
 * Die erkannte Bescheinigungsart samt ihrer Belege.
 *
 * `type` fehlt bewusst, wenn die Signale sich widersprechen oder zu schwach
 * sind. Ein leeres Feld ist eine Aussage: Wir wissen es nicht. Eine geratene
 * Art wäre schlimmer als keine.
 *
 * Aussteller, Zweck und Geltungsdauer stehen **nicht** hier — sie stehen
 * bereits in `subject`, `purpose` und `deadlines`. Sie zu verdoppeln hiesse,
 * zwei Wahrheiten über dieselbe Sache zu führen.
 */
export interface SemanticCertificate {
  type?: SemanticCertificateType;
  legalReferences: SemanticLegalReference[];
  /** Amtliche Formularkennung, normalisiert — z. B. 'USt 1 TG'. */
  formId?: string;
  certainty: BusinessFactCertainty;
  evidence?: SemanticEvidence;
}

/** Ein Einzelwert mit Sicherheit und Beleg. */
export interface SemanticValue<T> {
  value: T;
  certainty: BusinessFactCertainty;
  evidence?: SemanticEvidence;
}

/**
 * Fristarten. Die fünf handlungsbezogenen kommen unverändert aus
 * `BusinessDeadlineType`; zwei kommen hinzu, und beide bedeuten ausdrücklich
 * **keine Handlung**:
 *
 * `validity_period_end` — ein Gültigkeitsende, etwa bei einer
 * Freistellungsbescheinigung. Bis heute erschien der 31.08.2029 dort als
 * „FRIST", als müsse jemand bis dahin etwas tun. Es ist das Gegenteil: bis
 * dahin ist alles in Ordnung.
 *
 * `informational` — ein Datum, das erwähnt wird, ohne zu verpflichten (eine
 * Begehung, ein Lieferdatum, ein Vertragsbeginn).
 */
export type SemanticDeadlineType =
  | BusinessDeadlineType
  | 'validity_period_end'
  | 'informational';

export interface SemanticDeadline {
  /** ISO-Tagesdatum. */
  date: string;
  type: SemanticDeadlineType;
  /** Wofür die Frist gilt, in einem kurzen Satzteil. */
  appliesTo: string;
  /**
   * Muss der eigene Betrieb bis dahin handeln?
   *
   * Der entscheidende Unterschied, und getrennt vom Typ gehalten: Auch eine
   * `response_due` kann den anderen treffen. Nur `true` darf Druck erzeugen.
   */
  actionRequired: boolean;
  certainty: BusinessFactCertainty;
  evidence?: SemanticEvidence;
}

/** Wen eine Pflicht trifft. */
export type SemanticObligationParty = 'own_company' | 'counterparty' | 'unknown';

export interface SemanticObligation {
  who: SemanticObligationParty;
  /** Was zu tun ist, in eigenen Worten. */
  what: string;
  /** ISO-Tagesdatum, falls die Pflicht befristet ist. */
  byWhen?: string;
  certainty: BusinessFactCertainty;
  evidence?: SemanticEvidence;
}

/**
 * Die Rolle eines Betrags.
 *
 * Der teuerste Fehler des bisherigen Standes war, dass ein Betrag einfach ein
 * Betrag war. Eine Rechnung zeigte 2.880,00 EUR — den ersten Posten statt der
 * Rechnungssumme von 4.188,80 EUR. Und in einer Mängelanzeige standen
 * 5.000,00 EUR, die der Kunde **einbehält**; als Forderung gelesen wäre daraus
 * beinahe eine Verbindlichkeit geworden.
 */
export type SemanticAmountRole =
  | 'invoice_total'
  | 'net_amount'
  | 'tax_amount'
  | 'line_item'
  | 'outstanding_amount'
  | 'fee'
  | 'total_claim'
  | 'retention'
  | 'credit_amount'
  | 'other';

export interface SemanticAmount {
  value: number;
  currency: 'EUR';
  role: SemanticAmountRole;
  /**
   * Ist das eine Forderung **an uns**?
   *
   * Nur wahr, wenn der Text das hergibt. Ein Einbehalt des Kunden, ein
   * Nettoteilbetrag oder eine Gutschrift sind es nicht — und ohne dieses
   * Merkmal darf aus keinem Betrag eine Buchung werden.
   */
  isClaimAgainstUs: boolean;
  certainty: BusinessFactCertainty;
  evidence?: SemanticEvidence;
}

/** Ist das Schreiben überhaupt an den eigenen Betrieb gerichtet? */
export interface SemanticRecipientCheck {
  addressedToOwnCompany: 'yes' | 'no' | 'unknown';
  /** Woran es erkannt wurde — Firmenname, Strasse, Steuernummer. */
  matchedOn: string[];
  certainty: BusinessFactCertainty;
}

/**
 * Ein möglicher Kunde oder Auftrag — ausdrücklich ein **Vorschlag**.
 *
 * `reasons` trägt den Grund in Klartext, damit ein späterer Oberflächenblock
 * nicht „Vertrauen Sie mir" sagen muss, sondern „weil der Absender so heisst
 * und das Bauvorhaben im Text steht".
 */
export interface SemanticPartyCandidate {
  id: string;
  name: string;
  /** 0 bis 1. Kein erfundener Wert: er entsteht aus abzählbaren Treffern. */
  score: number;
  reasons: string[];
}

/**
 * Buchführungsrelevanz — bedeutungsbasiert, nicht artenbasiert.
 *
 * Der bisherige Schutz war eine Positivliste mit genau zwei Dokumentarten
 * (`mahnung`, `zahlungserinnerung`). Er stand und fiel mit der Klassifikation,
 * und genau die versagt bei unbekannten Schreiben. Diese Einschätzung entsteht
 * dagegen aus dem, was im Text steht.
 *
 * `none` — keine Buchung, kein Bezug. Ein Mängelschreiben, ein
 * Behördenbescheid ohne Zahlung, gewöhnliche Post.
 * `reference_only` — verweist auf einen **vorhandenen** Beleg. Eine Mahnung ist
 * kein Beleg; wer sie bucht, hat die Verbindlichkeit doppelt.
 * `booking_candidate` — könnte ein Beleg sein. Mehr nicht: vorschlagen ja,
 * ausführen nur nach Bestätigung.
 */
export type SemanticAccountingRelevance = 'none' | 'reference_only' | 'booking_candidate';

export interface SemanticAccounting {
  relevance: SemanticAccountingRelevance;
  /** Warum — in Klartext, für Anzeige und Nachvollziehbarkeit. */
  reasons: string[];
  certainty: BusinessFactCertainty;
}

export interface DocumentSemanticCore {
  /** Nur lesen. Dieser Kern führt nichts aus und speichert nichts. */
  readonly readOnly: true;
  /**
   * Die echte Betreffzeile — oder gar keine.
   *
   * Bis hierher wurde ein Betreff aus Bruchstücken zusammengesetzt und wie eine
   * Erkenntnis angezeigt („Westfalen Projektbau · Ein wichtiges Schreiben von
   * GmbH: Gerade erfasst: Sonstiges"). Ein fehlender Betreff ist ehrlicher als
   * ein erfundener.
   */
  /**
   * DOKUMENT-FACHWISSEN-01I1 — die erkannte Bescheinigungsart.
   *
   * Fehlt bei jedem Dokument, das keine Bescheinigung ist — also bei fast
   * allen. Vorhanden und ohne `type`, wenn Signale vorliegen, aber keines
   * trägt.
   */
  certificate?: SemanticCertificate;
  subject?: SemanticValue<string>;
  /** Das Anliegen in einem Satz. */
  purpose?: SemanticValue<string>;
  deadlines: SemanticDeadline[];
  obligations: SemanticObligation[];
  amounts: SemanticAmount[];
  recipientCheck: SemanticRecipientCheck;
  customerCandidates: SemanticPartyCandidate[];
  vorgangCandidates: SemanticPartyCandidate[];
  accounting: SemanticAccounting;
  /**
   * Die eine Frist, bis zu der der eigene Betrieb handeln muss — falls es sie
   * gibt. Sie ist die Brücke zum bestehenden `InboxItem.deadline`, das ein
   * einzelnes Feld ist und von mehreren Produktwegen gelesen wird.
   */
  primaryActionDeadline?: SemanticDeadline;
}

/** Ein leerer Kern — für Dokumente, aus denen sich nichts ablesen liess. */
export function emptyDocumentSemanticCore(): DocumentSemanticCore {
  return {
    readOnly: true,
    deadlines: [],
    obligations: [],
    amounts: [],
    recipientCheck: { addressedToOwnCompany: 'unknown', matchedOn: [], certainty: 'uncertain' },
    customerCandidates: [],
    vorgangCandidates: [],
    accounting: { relevance: 'none', reasons: [], certainty: 'uncertain' },
  };
}

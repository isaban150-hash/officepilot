/**
 * DOKUMENT-ASSISTENT-01E — der semantische Kern als Promptabschnitt.
 *
 * Der Kern aus 01B ist ein reichhaltiges Objekt. Ihn vollständig zu
 * serialisieren wäre Ballast: Der Prompt hat eine Größengrenze, und jede Zeile,
 * die keine Frage beantwortet, verwässert die, die es tun. Hier entstehen
 * deshalb nur die Zeilen, nach denen ein Betrieb tatsächlich fragt.
 *
 * Zwei Dinge sind dabei wichtiger als Vollständigkeit:
 *
 * 1. **Die Rolle steht beim Betrag.** „5.000,00 EUR" allein hat schon einmal
 *    beinahe eine Zahlungspflicht erzeugt, wo ein Einbehalt gemeint war. Jede
 *    Betragszeile sagt deshalb ausdrücklich, ob es eine Forderung an uns ist.
 * 2. **Unsicherheit bleibt Unsicherheit.** Ein Kunden- oder Auftragskandidat
 *    wird als Vorschlag ausgewiesen, nie als Zuordnung. Der Assistent darf aus
 *    einem Kandidaten keine Tatsache machen.
 */
import type {
  DocumentSemanticCore,
  SemanticAmount,
  SemanticDeadline,
  SemanticDeadlineType,
} from '../../types/documentSemanticCore';

/** Was eine Frist bedeutet — in Worten, nicht als Enum-Wert. */
const FRIST_BEDEUTUNG: Record<SemanticDeadlineType, string> = {
  payment_due: 'Zahlungsfrist',
  response_due: 'Antwortfrist',
  document_submission_due: 'Frist zur Einreichung von Unterlagen',
  service_due: 'Frist zur Leistungserbringung',
  termination_notice: 'Kündigungsfrist',
  validity_period_end: 'Ende der Gültigkeit (KEINE Handlungsfrist)',
  informational: 'nur genannter Termin (KEINE Handlungsfrist)',
};

const BETRAGS_ROLLE: Record<SemanticAmount['role'], string> = {
  invoice_total: 'Rechnungsbetrag',
  net_amount: 'Nettobetrag',
  tax_amount: 'enthaltene Umsatzsteuer',
  line_item: 'Einzelposten',
  outstanding_amount: 'offener Betrag',
  fee: 'Gebühr',
  total_claim: 'Gesamtforderung',
  retention: 'Einbehalt der Gegenseite',
  credit_amount: 'Gutschrift zu unseren Gunsten',
  other: 'Bedeutung nicht sicher erkannt',
};

function datum(iso: string): string {
  const t = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return t ? `${t[3]}.${t[2]}.${t[1]}` : iso;
}

function betrag(wert: number): string {
  return `${wert.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} EUR`;
}

function fristZeile(frist: SemanticDeadline): string {
  const handlung = frist.actionRequired
    ? 'Handlung durch uns erforderlich'
    : 'KEINE Handlung durch uns erforderlich';
  return `${datum(frist.date)} — ${FRIST_BEDEUTUNG[frist.type]} (${frist.appliesTo}); ${handlung}`;
}

function betragsZeile(b: SemanticAmount): string {
  const forderung = b.isClaimAgainstUs
    ? 'ist eine Forderung an uns'
    : 'ist KEINE Forderung an uns — daraus entsteht keine Zahlungspflicht';
  return `${betrag(b.value)} — ${BETRAGS_ROLLE[b.role]}; ${forderung}`;
}

const BUCHUNG_TEXT: Record<DocumentSemanticCore['accounting']['relevance'], string> = {
  none: 'Kein Buchungsbeleg. Aus diesem Schreiben entsteht keine Ausgabe.',
  reference_only:
    'Verweist auf einen bereits vorhandenen Beleg. Keine neue Ausgabe — sonst stünde die Verbindlichkeit doppelt in den Büchern.',
  booking_candidate:
    'Könnte ein eigener Beleg sein. Eine Übernahme ist nur nach ausdrücklicher Bestätigung durch den Nutzer möglich.',
};

/**
 * Die Zeilen des Abschnitts. Leere Bereiche entfallen ganz — eine Überschrift
 * ohne Inhalt ist für das Modell nur ein Anlass zum Spekulieren.
 */
export function buildSemanticPromptLines(core: DocumentSemanticCore | undefined): string[] {
  if (!core) return [];
  const zeilen: string[] = [];

  if (core.subject) zeilen.push(`Betreff (im Dokument gelesen): ${core.subject.value}`);
  if (core.purpose) zeilen.push(`Anliegen: ${core.purpose.value}`);

  const eigene = core.obligations.filter((p) => p.who === 'own_company');
  for (const pflicht of eigene) {
    zeilen.push(
      `Von uns verlangt: ${pflicht.what}${pflicht.byWhen ? ` (bis ${datum(pflicht.byWhen)})` : ''}`,
    );
  }
  for (const pflicht of core.obligations.filter((p) => p.who === 'counterparty')) {
    zeilen.push(`Die Gegenseite kündigt an: ${pflicht.what}`);
  }

  for (const frist of core.deadlines) {
    zeilen.push(`Termin: ${fristZeile(frist)}`);
  }
  if (core.deadlines.length > 0 && !core.primaryActionDeadline) {
    zeilen.push(
      'Es gibt in diesem Schreiben KEINE Frist, bis zu der wir handeln müssen. Nenne keine der genannten Daten als Handlungsfrist.',
    );
  }

  for (const b of core.amounts) {
    zeilen.push(`Betrag: ${betragsZeile(b)}`);
  }
  if (core.amounts.length > 0 && !core.amounts.some((b) => b.isClaimAgainstUs)) {
    zeilen.push(
      'Keiner der genannten Beträge ist eine Forderung an uns. Formuliere daraus keine Zahlungspflicht.',
    );
  }

  zeilen.push(`Buchführung: ${BUCHUNG_TEXT[core.accounting.relevance]}`);

  if (core.recipientCheck.addressedToOwnCompany === 'yes') {
    zeilen.push('Das Schreiben ist an unseren Betrieb gerichtet.');
  } else if (core.recipientCheck.addressedToOwnCompany === 'unknown') {
    zeilen.push('Ob das Schreiben an unseren Betrieb gerichtet ist, wurde nicht sicher erkannt.');
  }

  /*
   * Kandidaten sind ausdrücklich Vorschläge. Die Formulierung im Prompt nimmt
   * dem Modell die Möglichkeit, daraus eine Zuordnung zu machen.
   */
  /*
   * Der Name steht allein und unverziert. Die Begründung stand hier zunächst
   * dahinter, sie enthält den Namen aber ein zweites Mal in Anführungszeichen —
   * das Modell gab daraufhin Sätze wie „die Aufträge oder" aus, also die Liste
   * ohne die Namen. Kurz ist hier verlässlicher als vollständig.
   */
  for (const k of core.customerCandidates) {
    zeilen.push(`Möglicher Kunde (NICHT bestätigt, nur Vorschlag): ${k.name}`);
  }
  for (const k of core.vorgangCandidates) {
    zeilen.push(`Möglicher Auftrag (NICHT bestätigt, nur Vorschlag): ${k.name}`);
  }
  if (core.customerCandidates.length > 0 || core.vorgangCandidates.length > 0) {
    zeilen.push(
      'Stelle Kunden- und Auftragsvorschläge niemals als bestätigte Zuordnung dar. Sage ausdrücklich, dass die Zuordnung noch nicht bestätigt ist.',
    );
  }

  return zeilen;
}

/**
 * Derselbe Inhalt als Fliesstext für die Ausgabeprüfung.
 *
 * Der Ausgabewächter vergleicht die Antwort mit dem erlaubten Quelltext. Ohne
 * diese Zeilen dort gälte eine richtige Aussage aus dem Kern als erfunden und
 * würde verworfen.
 */
export function buildSemanticAllowedSourceText(core: DocumentSemanticCore | undefined): string {
  return buildSemanticPromptLines(core).join('\n');
}

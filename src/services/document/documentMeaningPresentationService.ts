/**
 * DOKUMENTVERSTAENDNIS-01C — aus Bedeutung wird Sprache.
 *
 * 01B hat den semantischen Kern gebaut; hier wird er in Sätze übersetzt, die
 * ein Handwerker im Vorbeigehen versteht. Es entsteht **keine neue Engine**:
 * Dieser Dienst rechnet nichts aus, er formuliert nur, was der Kern bereits
 * weiss, und entscheidet, was davon überhaupt gezeigt werden soll.
 *
 * Zwei Regeln bestimmen alles:
 *
 * 1. **Keine erfundenen Tatsachen.** Was der Kern nicht belegt, erscheint nicht
 *    oder erscheint ausdrücklich als unsicher. Lieber eine Leerstelle als eine
 *    Behauptung.
 * 2. **Kein technisches Vokabular.** Weder `booking_candidate` noch
 *    `service_due` noch eine Konfidenzzahl haben in der Oberfläche etwas
 *    verloren. Der Betrieb liest Deutsch, nicht Enum.
 */
import type {
  DocumentSemanticCore,
  SemanticAmount,
  SemanticDeadline,
  SemanticDeadlineType,
  SemanticPartyCandidate,
} from '../../types/documentSemanticCore';
import { buildDocumentSemanticCore } from './documentSemanticCoreService';
import { findSemanticPartyCandidates } from './documentSemanticPartyMatchService';
import { getCompanyProfileStoreSnapshot } from '../companyProfileService';
import { getCustomerStoreSnapshot } from '../customerStoreService';
import { getAllVorgaenge } from '../vorgangService';
import type { TranslationKey } from '../../i18n';

export type MeaningActionNeed = 'yes' | 'no' | 'unclear';

export interface MeaningDeadlineRow {
  /** „Termin bestätigen bis 22.09.2026" — ein fertiger Satz, kein Datum allein. */
  text: string;
  /** Nur echte Handlungsfristen dürfen drängen. */
  isAction: boolean;
}

export interface MeaningObligationRow {
  text: string;
  /** „bis 30.09.2026" — nur wenn die Pflicht wirklich befristet ist. */
  byWhen?: string;
}

export interface MeaningAmountRow {
  amount: string;
  explanation: string;
}

export interface MeaningCandidateRow {
  id: string;
  name: string;
  reason: string;
  /** Ein knapper Treffer ist ein Vorschlag, keine Feststellung. */
  uncertain: boolean;
}

export interface DocumentMeaningView {
  /**
   * DOKUMENT-FACHWISSEN-01I1 — die erkannte Bescheinigungsart, in Klartext.
   *
   * Fehlt bei fast allen Dokumenten. Bei unsicherer oder widersprüchlicher
   * Erkennung bleibt sie leer: Lieber nichts sagen als sicher klingen.
   */
  certificateLabelKey?: TranslationKey;
  subject?: string;
  purpose?: string;
  actionNeed: MeaningActionNeed;
  actionNeedLabelKey: TranslationKey;
  obligations: MeaningObligationRow[];
  deadlines: MeaningDeadlineRow[];
  amounts: MeaningAmountRow[];
  accountingLabelKey: TranslationKey;
  accountingHintKey: TranslationKey;
  customerCandidates: MeaningCandidateRow[];
  vorgangCandidates: MeaningCandidateRow[];
  nextStepKey: TranslationKey;
  /** Was ehrlicherweise offenbleibt. */
  uncertainties: TranslationKey[];
  /** Nichts Belegbares gefunden — die Oberfläche zeigt dann gar nichts. */
  isEmpty: boolean;
}

/* ------------------------------------------------------------------ */
/* Datum                                                               */
/* ------------------------------------------------------------------ */

function alsDeutschesDatum(iso: string): string {
  const teile = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return teile ? `${teile[3]}.${teile[2]}.${teile[1]}` : iso;
}

/* ------------------------------------------------------------------ */
/* Fristen                                                             */
/* ------------------------------------------------------------------ */

/**
 * Was eine Frist bedeutet, in einem Satzanfang.
 *
 * Ein Gültigkeitsende bekommt bewusst eine ganz andere Sprache: „Gültig bis"
 * statt „bis … erledigen". Genau diese Verwechslung liess eine
 * Freistellungsbescheinigung wie eine Aufforderung aussehen.
 */
const FRIST_TEXT: Record<SemanticDeadlineType, string> = {
  payment_due: 'Zahlung bis',
  response_due: 'Antwort bis',
  document_submission_due: 'Unterlagen einreichen bis',
  service_due: 'Leistung erbringen bis',
  termination_notice: 'Kündigungsfrist bis',
  validity_period_end: 'Gültig bis',
  informational: 'Termin',
};

function fristZeile(frist: SemanticDeadline): MeaningDeadlineRow {
  const datum = alsDeutschesDatum(frist.date);
  const einleitung = FRIST_TEXT[frist.type] ?? 'Termin';
  return {
    text: frist.type === 'informational' ? `${einleitung}: ${datum}` : `${einleitung} ${datum}`,
    isAction: frist.actionRequired,
  };
}

/* ------------------------------------------------------------------ */
/* Beträge                                                             */
/* ------------------------------------------------------------------ */

function formatBetrag(wert: number): string {
  return `${wert.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
}

/**
 * Was ein Betrag bedeutet — in einem Satz, den man nicht missverstehen kann.
 *
 * Der Einbehalt ist der wichtigste Fall: 5.000 € auf einer Mängelanzeige sind
 * kein Geld, das der Betrieb zahlen muss, sondern Geld, das er vorerst nicht
 * bekommt. Optisch dürfen die beiden sich nie ähneln.
 */
function betragsErklaerung(betrag: SemanticAmount): string {
  switch (betrag.role) {
    case 'retention':
      return 'Laut Schreiben wird dieser Betrag vorerst einbehalten. Es ist keine Zahlung von Ihnen.';
    case 'credit_amount':
      return 'Gutschrift zu Ihren Gunsten. Es ist keine Zahlung von Ihnen.';
    case 'fee':
      return 'Zusätzliche Gebühr.';
    case 'total_claim':
      return 'Offene Gesamtforderung laut Schreiben.';
    case 'outstanding_amount':
      return 'Noch offener Betrag.';
    case 'invoice_total':
      return 'Rechnungsbetrag.';
    case 'net_amount':
      return 'Nettobetrag, ohne Umsatzsteuer.';
    case 'tax_amount':
      return 'Enthaltene Umsatzsteuer.';
    case 'line_item':
      return 'Einzelposten aus der Aufstellung.';
    default:
      return 'Im Schreiben genannter Betrag. Bedeutung nicht sicher erkannt.';
  }
}

/**
 * Welche Beträge überhaupt gezeigt werden.
 *
 * Nicht jeder gefundene Betrag hilft. Netto, Steuer und Einzelposten stehen
 * ohnehin auf dem Papier; hier zählt, was der Betrieb wissen muss. Ist eine
 * Forderung dabei, steht sie vorn — sonst bleibt der Bereich schlank.
 */
function waehleBetraege(core: DocumentSemanticCore): SemanticAmount[] {
  const wichtig = core.amounts.filter(
    (b) => b.role === 'total_claim' || b.role === 'outstanding_amount' || b.role === 'retention' ||
      b.role === 'credit_amount' || b.role === 'invoice_total' || b.role === 'fee',
  );
  if (wichtig.length > 0) {
    /* Forderungen zuerst, danach nach Höhe — die grosse Zahl trägt die Aussage. */
    return [...wichtig]
      .sort((a, b) => Number(b.isClaimAgainstUs) - Number(a.isClaimAgainstUs) || b.value - a.value)
      .slice(0, 4);
  }
  /* Kein aussagekräftiger Betrag: lieber gar keiner als ein irreführender. */
  return [];
}

/* ------------------------------------------------------------------ */
/* Handlungsbedarf                                                     */
/* ------------------------------------------------------------------ */

/**
 * Muss der Betrieb etwas tun?
 *
 * Ausdrücklich **nicht** aus der Dokumentart abgeleitet — sonst wäre jedes
 * „Sonstiges" wieder bedeutungslos. Entschieden wird aus eigenen Pflichten und
 * echten Handlungsfristen.
 */
function ermittleHandlungsbedarf(core: DocumentSemanticCore): MeaningActionNeed {
  const eigenePflichten = core.obligations.filter((p) => p.who === 'own_company');
  const handlungsfristen = core.deadlines.filter((f) => f.actionRequired);

  /* Ein Termin, bis zu dem wir handeln müssen, oder eine befristete Pflicht. */
  if (handlungsfristen.length > 0 || eigenePflichten.some((p) => p.byWhen)) return 'yes';

  /*
   * Eine Pflicht **ohne** Frist ist oft gar keine Aufforderung, sondern ein
   * Hinweis zum Gebrauch: „Bitte legen Sie diese Bescheinigung Ihren
   * Auftraggebern vor." Daraus ein „Ja" zu machen, erzeugte bei einer
   * Freistellungsbescheinigung eine Aufgabe, die es nicht gibt. Ehrlicher ist
   * „Nicht sicher erkannt" — die Pflichten stehen darunter trotzdem.
   */
  if (eigenePflichten.length > 0) return 'unclear';

  /* Nichts gelesen heisst nicht „nichts zu tun". */
  if (core.obligations.length === 0 && core.deadlines.length === 0 && !core.subject) return 'unclear';
  return 'no';
}

/* ------------------------------------------------------------------ */
/* Buchführung und nächster Schritt                                    */
/* ------------------------------------------------------------------ */

const BUCHUNG_LABEL: Record<DocumentSemanticCore['accounting']['relevance'], TranslationKey> = {
  none: 'documentMeaning.accounting.none',
  reference_only: 'documentMeaning.accounting.reference',
  booking_candidate: 'documentMeaning.accounting.candidate',
};

const BUCHUNG_HINWEIS: Record<DocumentSemanticCore['accounting']['relevance'], TranslationKey> = {
  none: 'documentMeaning.accounting.noneHint',
  reference_only: 'documentMeaning.accounting.referenceHint',
  booking_candidate: 'documentMeaning.accounting.candidateHint',
};

/**
 * Der nächste Schritt — aus der Bedeutung, nicht aus der Dokumentart.
 *
 * Für ein als „Sonstiges" eingestuftes Schreiben mit erkannten Pflichten darf
 * hier niemals mehr nur „klären" stehen. Das war der Kern des Problems: Die
 * Klassifikation war das Tor zur Hilfe, und wer durchfiel, bekam keine.
 */
function ermittleNaechstenSchritt(
  core: DocumentSemanticCore,
  bedarf: MeaningActionNeed,
): TranslationKey {
  if (core.accounting.relevance === 'reference_only') {
    return 'documentMeaning.next.checkExistingRecord';
  }
  if (core.accounting.relevance === 'booking_candidate') {
    return 'documentMeaning.next.reviewAndBook';
  }
  if (bedarf === 'yes') {
    const hatKandidaten = core.customerCandidates.length > 0 || core.vorgangCandidates.length > 0;
    return hatKandidaten
      ? 'documentMeaning.next.confirmAndAnswer'
      : 'documentMeaning.next.answerRequired';
  }
  if (bedarf === 'no') return 'documentMeaning.next.fileOnly';
  return 'documentMeaning.next.reviewYourself';
}

/* ------------------------------------------------------------------ */
/* Kandidaten                                                          */
/* ------------------------------------------------------------------ */

/** Ab hier gilt ein Treffer als belastbar genug, um ihn ohne Warnung zu zeigen. */
const SICHER_AB = 0.8;

function kandidatenZeilen(kandidaten: SemanticPartyCandidate[]): MeaningCandidateRow[] {
  return kandidaten.map((k) => ({
    id: k.id,
    name: k.name,
    /* Die erste Begründung ist die tragende; mehr verwirrt nur. */
    reason: k.reasons[0] ?? '',
    uncertain: k.score < SICHER_AB || kandidaten.length > 1,
  }));
}

/* ------------------------------------------------------------------ */
/* Zusammenbau                                                         */
/* ------------------------------------------------------------------ */

export interface MeaningViewInput {
  /** Der Volltext des Schreibens. */
  text: string;
  /** Der erkannte Absender, falls bekannt. */
  sender?: string;
}

export function buildDocumentMeaningView(input: MeaningViewInput): DocumentMeaningView {
  const text = input.text ?? '';
  if (!text.trim()) return leereAnsicht();

  const core = buildDocumentSemanticCore({
    text,
    companyProfile: getCompanyProfileStoreSnapshot() ?? null,
  });
  const kandidaten = findSemanticPartyCandidates({
    text,
    sender: input.sender,
    customers: getCustomerStoreSnapshot(),
    vorgaenge: getAllVorgaenge(),
  });
  const vollstaendig: DocumentSemanticCore = {
    ...core,
    customerCandidates: kandidaten.customerCandidates,
    vorgangCandidates: kandidaten.vorgangCandidates,
  };

  return viewAusKern(vollstaendig);
}

/** Für Aufrufer, die den Kern bereits haben — etwa aus der Interpretation. */
export function buildDocumentMeaningViewFromCore(core: DocumentSemanticCore): DocumentMeaningView {
  return viewAusKern(core);
}

/**
 * DOKUMENT-FACHWISSEN-01I1 — die Bescheinigungsart als lesbarer Satz.
 *
 * Nur bei belastbarer Erkennung. „Widersprüchlich" und „unklar" erzeugen
 * absichtlich gar keine Zeile: Eine Angabe, die danebenstehen könnte, ist in
 * einem Bereich, der „Was bedeutet dieses Dokument?" überschrieben ist,
 * schlimmer als eine fehlende.
 */
function bescheinigungsLabel(core: DocumentSemanticCore): TranslationKey | undefined {
  const art = core.certificate;
  if (!art?.type) return undefined;
  if (art.certainty !== 'detected' && art.certainty !== 'proposed') return undefined;
  switch (art.type) {
    case 'construction_withholding_exemption':
      return 'documentMeaning.certificate.constructionExemption';
    case 'reverse_charge_construction_status':
      return 'documentMeaning.certificate.reverseChargeStatus';
    case 'domestic_establishment':
      return 'documentMeaning.certificate.domesticEstablishment';
    default:
      return undefined;
  }
}

function viewAusKern(core: DocumentSemanticCore): DocumentMeaningView {
  const bedarf = ermittleHandlungsbedarf(core);
  const certificateLabelKey = bescheinigungsLabel(core);

  /*
   * Nur eigene Pflichten erscheinen unter „Was muss ich tun?". Was die
   * Gegenseite ankündigt, ist keine Aufgabe des Betriebs und hätte dort nichts
   * zu suchen — es steht bei den Beträgen, wo es hingehört.
   */
  const obligations: MeaningObligationRow[] = core.obligations
    .filter((p) => p.who === 'own_company')
    .slice(0, 5)
    .map((p) => ({
      text: p.what,
      byWhen: p.byWhen ? alsDeutschesDatum(p.byWhen) : undefined,
    }));

  /* Handlungsfristen zuerst, danach Gültigkeiten und blosse Termine. */
  const deadlines = [...core.deadlines]
    .filter((f) => f.type !== 'informational' || f.appliesTo !== 'Briefdatum')
    .sort((a, b) => Number(b.actionRequired) - Number(a.actionRequired) || a.date.localeCompare(b.date))
    .slice(0, 6)
    .map(fristZeile);

  const amounts = waehleBetraege(core).map((b) => ({
    amount: formatBetrag(b.value),
    explanation: betragsErklaerung(b),
  }));

  const uncertainties: TranslationKey[] = [];
  if (!core.subject) uncertainties.push('documentMeaning.uncertain.noSubject');
  if (core.recipientCheck.addressedToOwnCompany === 'unknown') {
    uncertainties.push('documentMeaning.uncertain.recipient');
  }
  if (core.customerCandidates.length === 0 && core.vorgangCandidates.length === 0) {
    uncertainties.push('documentMeaning.uncertain.noAssignment');
  }

  const istLeer =
    !core.subject &&
    !core.purpose &&
    obligations.length === 0 &&
    deadlines.length === 0 &&
    amounts.length === 0 &&
    core.customerCandidates.length === 0 &&
    core.vorgangCandidates.length === 0;

  return {
    ...(certificateLabelKey ? { certificateLabelKey } : {}),
    subject: core.subject?.value,
    purpose: core.purpose?.value,
    actionNeed: bedarf,
    actionNeedLabelKey:
      bedarf === 'yes'
        ? 'documentMeaning.action.yes'
        : bedarf === 'no'
          ? 'documentMeaning.action.no'
          : 'documentMeaning.action.unclear',
    obligations,
    deadlines,
    amounts,
    accountingLabelKey: BUCHUNG_LABEL[core.accounting.relevance],
    accountingHintKey: BUCHUNG_HINWEIS[core.accounting.relevance],
    customerCandidates: kandidatenZeilen(core.customerCandidates),
    vorgangCandidates: kandidatenZeilen(core.vorgangCandidates),
    nextStepKey: ermittleNaechstenSchritt(core, bedarf),
    uncertainties,
    isEmpty: istLeer,
  };
}

function leereAnsicht(): DocumentMeaningView {
  return {
    actionNeed: 'unclear',
    actionNeedLabelKey: 'documentMeaning.action.unclear',
    obligations: [],
    deadlines: [],
    amounts: [],
    accountingLabelKey: 'documentMeaning.accounting.none',
    accountingHintKey: 'documentMeaning.accounting.noneHint',
    customerCandidates: [],
    vorgangCandidates: [],
    nextStepKey: 'documentMeaning.next.reviewYourself',
    uncertainties: [],
    isEmpty: true,
  };
}

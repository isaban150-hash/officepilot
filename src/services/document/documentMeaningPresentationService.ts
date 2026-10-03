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
  SemanticComplaint,
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
  /** EINGANG-01D-2 — Art der Frist, damit die Anzeige der Hauptdokument-Wahrheit folgen kann. */
  type?: SemanticDeadlineType;
}

export interface MeaningObligationRow {
  text: string;
  /** „bis 30.09.2026" — nur wenn die Pflicht wirklich befristet ist. */
  byWhen?: string;
}

export interface MeaningAmountRow {
  amount: string;
  explanation: string;
  /** EINGANG-01D-2 — der Betrag ist laut Text eine Forderung an uns. */
  isClaim?: boolean;
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
  /**
   * BROWSER-ACCEPTANCE-FIX 01 / A3 — fertige Sätze aus der Rechnungswahrheit.
   * Nur bei einer eigenen, verknüpften Ausgangsrechnung gesetzt; sie haben dann
   * Vorrang vor den Schlüsseln oben.
   */
  actionNeedText?: string;
  nextStepText?: string;
  /** Kunde und Auftrag stehen fest (Verknüpfung), sie sind keine Vorschläge. */
  assignmentFromInvoice?: boolean;
  /** Was ehrlicherweise offenbleibt. */
  uncertainties: TranslationKey[];
  /** Nichts Belegbares gefunden — die Oberfläche zeigt dann gar nichts. */
  isEmpty: boolean;
  /** EINGANG-02C — Angaben des Absenders einer Beschwerde, nie bestätigte Wahrheit. */
  complaint?: SemanticComplaint;
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

/** EINGANG-02A-2B — Satzanfang einer relativen Frist („Antwort: binnen 14 Tagen …"). */
const RELATIV_TEXT: Partial<Record<SemanticDeadlineType, string>> = {
  payment_due: 'Zahlung',
  response_due: 'Antwort',
  document_submission_due: 'Unterlagen einreichen',
  service_due: 'Leistung erbringen',
  termination_notice: 'Kündigung',
};

function fristZeile(frist: SemanticDeadline): MeaningDeadlineRow {
  const datum = alsDeutschesDatum(frist.date);
  const einleitung = FRIST_TEXT[frist.type] ?? 'Termin';
  return {
    text: frist.type === 'informational' ? `${einleitung}: ${datum}` : `${einleitung} ${datum}`,
    isAction: frist.actionRequired,
    type: frist.type,
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
   * EINGANG-02A-2B — eine relative Frist („binnen 14 Tagen nach Erhalt") ist
   * eine Handlung mit offenem Datum, und ein ausdrücklicher Informationshinweis
   * ohne jede Pflicht heisst „nichts zu tun".
   */
  if ((core.relativeDeadlines?.length ?? 0) > 0) return 'yes';
  if (core.informationOnly) return 'no';

  /*
   * 02A-2B — eine sicher typisierte eigene Pflicht ohne Datum („Bitte nehmen
   * Sie hierzu Stellung", „Wir benötigen noch den Nachweis") ist eine Handlung.
   * Der Gebrauchshinweis einer Bescheinigung trägt keine Art und bleibt unten.
   */
  if (eigenePflichten.some((p) => p.kind) && !core.certificate?.type) return 'yes';

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

/**
 * BROWSER-ACCEPTANCE-FIX 01 / A3 — die eigene, verknüpfte Ausgangsrechnung.
 *
 * OfficeTakt hat sie selbst erzeugt; Kunde, Auftrag und Zahlungsstand stehen
 * über die Rechnungsverknüpfung fest. Die Leseregeln für eingehende Post
 * (mögliche Kunden, Handlungsbedarf aus Pflichten, Unsicherheiten der
 * Zuordnung) würden hier Zweifel erfinden, die es nicht gibt:
 *
 *   * keine Kandidatensuche — die Verknüpfung gewinnt, es gibt nichts zu wählen;
 *   * Handlung und nächster Schritt aus dem Rechnungsstatus, nicht geraten;
 *   * keine Zuordnungs-/Empfänger-Unsicherheit;
 *   * Pflichten und Fristen im Text richten sich an den Kunden, nicht an den
 *     Betrieb — sie erscheinen nur zur Kenntnis.
 *
 * Betreff, Zweck, Beträge und Termine bleiben sichtbar: Die Analyse wird nicht
 * versteckt, sie wird richtig eingeordnet. Eingehende Dokumente laufen
 * unverändert über `buildDocumentMeaningView`.
 */
export interface OwnInvoiceMeaningInput {
  text: string;
  customerName?: string;
  vorgang?: { id: string; title: string };
  action: { need: MeaningActionNeed; text: string; nextStep: string };
}

export function buildOwnInvoiceMeaningView(input: OwnInvoiceMeaningInput): DocumentMeaningView {
  const core = buildDocumentSemanticCore({
    text: input.text ?? '',
    companyProfile: getCompanyProfileStoreSnapshot() ?? null,
  });
  const basis = viewAusKern({ ...core, customerCandidates: [], vorgangCandidates: [] });

  const customerName = input.customerName?.trim();
  const vorgangTitle = input.vorgang?.title.trim();
  const fest = (id: string, name: string): MeaningCandidateRow => ({
    id,
    name,
    reason: '',
    uncertain: false,
  });

  return {
    ...basis,
    actionNeed: input.action.need,
    actionNeedText: input.action.text,
    nextStepText: input.action.nextStep || undefined,
    obligations: [],
    deadlines: basis.deadlines.map((frist) => ({ ...frist, isAction: false })),
    accountingLabelKey: 'documentMeaning.accounting.ownInvoice',
    accountingHintKey: 'documentMeaning.accounting.ownInvoiceHint',
    customerCandidates: customerName ? [fest('invoice-customer', customerName)] : [],
    vorgangCandidates:
      input.vorgang && vorgangTitle ? [fest(input.vorgang.id, vorgangTitle)] : [],
    assignmentFromInvoice: true,
    uncertainties: [],
    isEmpty: false,
  };
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
  /*
   * EINGANG-02C — eine eingehende Beschwerde ohne eigene Pflicht ist nicht
   * „nichts zu tun": Der Absender meldet oder fordert etwas, das zu prüfen ist.
   * Ehrlich ist dann „nicht sicher erkannt" mit „selbst ansehen".
   */
  const grundBedarf = ermittleHandlungsbedarf(core);
  const bedarf: MeaningActionNeed =
    core.complaint?.direction === 'incoming' && grundBedarf === 'no' ? 'unclear' : grundBedarf;
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

  /*
   * Handlungsfristen zuerst, danach Gültigkeiten und blosse Termine.
   * EINGANG-02A-2B — relative Fristen stehen im Wortlaut davor; ein Datum
   * wird nicht berechnet.
   */
  const relativeZeilen: MeaningDeadlineRow[] = (core.relativeDeadlines ?? []).map((frist) => ({
    text: `${(frist.kind && RELATIV_TEXT[frist.kind]) || 'Frist'}: ${frist.phrase}`,
    isAction: true,
    ...(frist.kind ? { type: frist.kind } : {}),
  }));
  const deadlines = [
    ...relativeZeilen,
    ...[...core.deadlines]
      .filter((f) => f.type !== 'informational' || f.appliesTo !== 'Briefdatum')
      .sort((a, b) => Number(b.actionRequired) - Number(a.actionRequired) || a.date.localeCompare(b.date))
      .map(fristZeile),
  ].slice(0, 6);

  const amounts = waehleBetraege(core).map((b) => ({
    amount: formatBetrag(b.value),
    explanation: betragsErklaerung(b),
    isClaim: b.isClaimAgainstUs,
  }));

  const uncertainties: TranslationKey[] = [];
  /* 02A-2B — Handlung erkannt, Datum nicht bestimmt: das sagen, nicht raten. */
  if (relativeZeilen.length > 0) {
    uncertainties.push('documentMeaning.uncertain.relativeDeadline');
  } else if (bedarf === 'yes' && !core.deadlines.some((f) => f.actionRequired) && !obligations.some((p) => p.byWhen)) {
    uncertainties.push('documentMeaning.uncertain.noDeadline');
  }
  if (!core.subject) uncertainties.push('documentMeaning.uncertain.noSubject');
  if (core.recipientCheck.addressedToOwnCompany === 'unknown') {
    uncertainties.push('documentMeaning.uncertain.recipient');
  }
  if (core.customerCandidates.length === 0 && core.vorgangCandidates.length === 0) {
    uncertainties.push('documentMeaning.uncertain.noAssignment');
  }

  /* 02A-2B — ein ausdrücklicher Informationshinweis ist Inhalt: „Muss ich etwas tun? Nein". */
  const istLeer =
    !core.informationOnly &&
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
    isEmpty: istLeer && !core.complaint,
    ...(core.complaint ? { complaint: core.complaint } : {}),
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

/**
 * EINGANG-01D-2 — die Anzeige folgt der Hauptdokument-Wahrheit.
 *
 * Der Bereich liest den ganzen Text. Hängt an einer Lieferantengutschrift die
 * Kopie der Originalrechnung, stünden deren „Zahlung bis …", „Offene
 * Gesamtforderung" und ein „Muss ich etwas tun? Ja" als Aussagen der
 * Gutschrift da — obwohl die kanonische Wahrheit (01D-1) keine Zahlungsfrist
 * und keine Forderung kennt. Für eine Gutschrift entfallen deshalb
 * Zahlungsfristen und Forderungsbeträge; der Handlungsbedarf richtet sich nach
 * den verbleibenden eigenen Fristen und Pflichten bzw. der kanonischen Frist.
 * Andere Dokumentarten bleiben unverändert.
 */
export interface MeaningMainDocument {
  classifiedKind?: string;
  /** Kanonische Frist des Eingangs (JJJJ-MM-TT) oder null. */
  deadline?: string | null;
}

export function alignDocumentMeaningViewWithMainDocument(
  view: DocumentMeaningView,
  main: MeaningMainDocument | undefined,
): DocumentMeaningView {
  if (!main || main.classifiedKind !== 'gutschrift') return view;
  const deadlines = view.deadlines.filter((row) => row.type !== 'payment_due');
  const amounts = view.amounts.filter((row) => !row.isClaim);
  const ownAction =
    deadlines.some((row) => row.isAction) || view.obligations.some((row) => Boolean(row.byWhen)) || Boolean(main.deadline);
  const actionNeed: MeaningActionNeed =
    view.actionNeed === 'yes' && !ownAction ? (view.obligations.length > 0 ? 'unclear' : 'no') : view.actionNeed;
  return {
    ...view,
    deadlines,
    amounts,
    actionNeed,
    actionNeedLabelKey:
      actionNeed === 'yes'
        ? 'documentMeaning.action.yes'
        : actionNeed === 'no'
          ? 'documentMeaning.action.no'
          : 'documentMeaning.action.unclear',
  };
}

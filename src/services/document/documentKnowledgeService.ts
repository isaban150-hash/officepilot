/**
 * DOKUMENT-ASSISTENT-01H3 — wann belegtes Fachwissen gebraucht wird.
 *
 * **Die wichtigste Entscheidung ist das Weglassen.**
 *
 * Ein Assistent, der bei jeder Frage seinen ganzen Wissensbestand in den
 * Prompt kippt, wird nicht klüger, sondern unschärfer: Das Modell bekommt
 * Steuerregeln vorgelegt, während jemand nach einem Betrag gefragt hat, und
 * beginnt, beides zu verbinden. Deshalb ist die Voreinstellung **kein**
 * Fachwissen, und der Abruf muss begründet werden.
 *
 * **Woran erkannt wird, dass es gebraucht wird.**
 *
 * Zwei Wege, und beide führen über die Frage — nie über das Dokument allein:
 *
 *   1. Die Frage nennt das Thema selbst („Muss mein Auftraggeber
 *      Bauabzugsteuer einbehalten?"). Dann ist die Sache klar.
 *   2. Die Frage nennt es nicht, bezieht sich aber erkennbar auf **dieses**
 *      Dokument, und das Dokument ist eine Freistellungsbescheinigung („Was
 *      passiert nach dem 31.08.2029?"). Der Bezug kann auch über ein Datum
 *      laufen, das im Dokument steht — wer danach fragt, fragt danach.
 *
 * Dass das Dokument zum Thema passt, genügt für sich allein **nicht**. Sonst
 * bekäme „Wie hoch ist der Betrag?" eine Steuerregel beigelegt, und „Was ist
 * eine Abschlagsrechnung?" würde in der Bauabzugsteuer landen, nur weil
 * zufällig eine Bescheinigung offen ist.
 *
 * **Was hier nicht passiert:** keine neue Texterkennung, kein Netzabruf, kein
 * allgemeines Abrufsystem. Der Bestand liegt im Programm, die Suche ist die
 * vorhandene aus 01H1.
 *
 * **01I1 hat eine dritte Bedingung ergänzt.** Die Frage darf ein Thema
 * anfragen — sie darf aber nicht bestimmen, was das Dokument ist. Seither
 * muss das Dokument das Thema tragen, und eine belastbar erkannte andere
 * Bescheinigungsart schliesst es aus. Das Wort „Freistellungsbescheinigung"
 * in einer Frage ist deren Gegenstand, kein Beweis.
 */
import {
  KNOWLEDGE_TOPICS_PRODUKTIV,
  KNOWLEDGE_TOPIC_BAUABZUGSTEUER,
  KNOWLEDGE_TOPIC_FREISTELLUNG,
  KNOWLEDGE_TOPIC_FREISTELLUNG_ANTRAG,
  KNOWLEDGE_TOPIC_FREISTELLUNG_GUELTIGKEIT,
  KNOWLEDGE_TOPIC_UST1TG,
  KNOWLEDGE_TOPIC_UST1TS,
} from '../domainKnowledge/domainKnowledgeRegistry';
import { findKnowledgeStatements } from '../domainKnowledge/domainKnowledgeRetrieval';
import type { KnowledgeHit } from '../../types/domainKnowledge';
import type { AreaAiKnowledgeSource } from '../../types/areaAi';
import type {
  SemanticCertificate,
  SemanticCertificateType,
} from '../../types/documentSemanticCore';
import { isCertificateTypeReliable } from './documentCertificateRecognition';

/**
 * Nennt die Frage das Thema selbst?
 *
 * `eibe` steht mit Wortgrenzen da, und das ist kein Schönheitsfehler: Ohne sie
 * trifft es mitten in „Schr-eibe-n" — und jede Frage nach irgendeinem
 * Schreiben hätte Steuerregeln im Gepäck. Kurze Kürzel brauchen Grenzen.
 */
const FRAGE_NENNT_THEMA =
  /(bauabzug|abzugsteuer|abzugssteuer|freistellungsbescheinigung|freistellung|§\s*48|paragraf\s*48|\b48b\b|steuerabzug|\beibe\b)/i;

/**
 * Eine reine Nachschlagefrage — die braucht nie Fachwissen.
 *
 * „Bis wann ist die Bescheinigung gültig?" ist keine Frage nach dem Recht,
 * sondern nach einer Zeile im Schreiben. Wer hier eine Vorschrift beilegt,
 * lädt das Modell dazu ein, aus einer Auskunft eine Belehrung zu machen.
 */
const NACHSCHLAGEFRAGE =
  /^(wie hoch|wie viel|welcher betrag|welche summe|welche nummer|wer ist|bis wann|ab wann|an welchem tag|welches datum)/i;

/** Bezieht sich die Frage erkennbar auf das vorliegende Schreiben? */
const BEZUG_AUF_DOKUMENT =
  /(diese|dieser|dieses|diesem|diesen|das dokument|dem dokument|das schreiben|dem schreiben|die bescheinigung|der bescheinigung|hier|danach|dafür|dafuer)/i;

export interface DocumentKnowledgeSignals {
  question: string;
  /** Die Dokumentart, sofern bekannt — reines Signal, kein Tor. */
  classifiedKind?: string | null;
  /** Betreff und Anliegen aus dem semantischen Kern. */
  subject?: string | null;
  purpose?: string | null;
  /** Daten, die im Dokument stehen (z. B. Gültigkeitsende) — für den Datumsbezug. */
  documentDates?: readonly (string | null | undefined)[];
  /**
   * DOKUMENT-FACHWISSEN-01I1 — die erkannte Bescheinigungsart des Dokuments.
   *
   * Sie darf ein Thema ausschliessen, das ihr widerspricht — und sie darf
   * eines bestaetigen, das zu ihr passt. Fehlt sie, entscheidet wie bisher
   * die Beschreibung des Dokuments.
   */
  certificate?: SemanticCertificate;
  /** Der Stichtag. Immer ausdrücklich, nie heimlich die Uhr lesen. */
  asOf: string;
}

/**
 * Welche Themen für diese Frage abgerufen werden — meistens keines.
 *
 * Die Reihenfolge der Prüfungen ist Teil der Zusage: Erst wird ausgeschlossen,
 * dann eingeschlossen.
 */
export function resolveKnowledgeTopics(signals: DocumentKnowledgeSignals): string[] {
  const frage = signals.question.trim();
  if (!frage) return [];

  /* 1 — Nachschlagefragen bekommen nie Fachwissen. */
  if (NACHSCHLAGEFRAGE.test(frage)) return [];

  /*
   * DOKUMENT-FACHWISSEN-01I2 — ein belastbar erkanntes Papier bestimmt sein
   * eigenes Thema.
   *
   * Das ist die Umkehrung der alten Reihenfolge, und sie ist der ganze Punkt:
   * Nicht die Frage sagt, worum es geht, sondern das Dokument. Deshalb kann
   * „Hat das mit Bauabzugsteuer zu tun?" auf einer USt 1 TG keine
   * § 48b-Regeln mehr herbeirufen — die Frage wählt kein Thema, sie stellt
   * nur fest, dass es um dieses Dokument geht.
   */
  const erkannt = erkannteBescheinigung(signals);
  if (erkannt) {
    if (!frageBetrifftDasDokument(signals, frage)) return [];
    const eigenes = THEMA_JE_BESCHEINIGUNG[erkannt];
    if (!eigenes) return [];
    return [eigenes === 'freistellungsfamilie' ? themaAusWortlaut(frage) : eigenes];
  }

  const nenntThema = FRAGE_NENNT_THEMA.test(frage);
  if (!nenntThema && !bezugAufThemadokument(signals, frage)) return [];

  const thema = themaAusWortlaut(frage);

  /*
   * DOKUMENT-FACHWISSEN-01I1 — die Frage darf das Dokument nicht umschreiben.
   *
   * Bis hierher genügte das Wort „Freistellungsbescheinigung" in der Frage,
   * um § 48b-Wissen zu laden — auf jedes Dokument, auch auf eine
   * Mängelanzeige oder eine USt 1 TG. Das ist falsch herum gedacht: In der
   * Frage „Ist das eine Freistellungsbescheinigung?" ist das Wort der
   * **Gegenstand** der Frage, nicht ein Beweis über das Papier.
   *
   * Deshalb entscheidet ab jetzt das Dokument mit. Widerspricht es, wird
   * nichts geladen; bestätigt es nichts, wird ebenfalls nichts geladen. Die
   * zweite Hälfte ist die unbequeme: Bei einem unbekannten Dokument bleibt
   * die allgemeine Auskunft aus. Sie liesse sich heute nicht zuverlässig als
   * blosser Vergleich kennzeichnen, und eine allgemeine Regel, die neben
   * einem fremden Schreiben steht, liest sich wie eine Aussage über dieses
   * Schreiben. Lieber keine Auskunft als eine, die auf das falsche Papier
   * gemünzt wirkt.
   */
  if (dokumentWiderspricht(signals, thema)) return [];
  if (!dokumentBestaetigt(signals, thema)) return [];

  return [thema];
}

/** Die belastbar erkannte Art — oder nichts. */
function erkannteBescheinigung(
  signals: DocumentKnowledgeSignals,
): SemanticCertificateType | undefined {
  return isCertificateTypeReliable(signals.certificate) ? signals.certificate?.type : undefined;
}

/**
 * Welches Wissen zu welchem Papier gehört.
 *
 * `freistellungsfamilie` ist kein Thema, sondern ein Hinweis: Bei der
 * Freistellungsbescheinigung gibt es vier Themen, und welches gemeint ist,
 * sagt erst die Frage (Antrag, Gültigkeit, Bauabzugsteuer, Grundlagen).
 *
 * Seit 01I3 hat auch die USt 1 TS ihr eigenes Thema. Drei Papiere, drei
 * Themen, keine Erbschaft: Was zu einem Dokument nicht belegt ist, holt es
 * sich nicht vom Nachbarn.
 */
const THEMA_JE_BESCHEINIGUNG: Partial<Record<SemanticCertificateType, string>> = {
  construction_withholding_exemption: 'freistellungsfamilie',
  reverse_charge_construction_status: KNOWLEDGE_TOPIC_UST1TG,
  domestic_establishment: KNOWLEDGE_TOPIC_UST1TS,
};

/**
 * Geht die Frage dieses Dokument etwas an?
 *
 * Absichtlich weit, denn das Papier ist bereits erkannt — hier droht kein
 * fremdes Thema mehr, sondern nur unnötiger Ballast. Eng genug bleibt es
 * trotzdem: „Was ist eine Abschlagsrechnung?" fällt heraus, weil es weder
 * dieses Dokument noch eines seiner Themen berührt.
 */
function frageBetrifftDasDokument(
  signals: DocumentKnowledgeSignals,
  frage: string,
): boolean {
  if (FRAGE_NENNT_THEMA.test(frage)) return true;
  if (FRAGE_NENNT_UMSATZSTEUER.test(frage)) return true;
  if (FRAGE_ZUR_GELTUNG.test(frage)) return true;
  if (BEZUG_AUF_DOKUMENT.test(frage)) return true;
  if (VERFAHRENSWORT.test(frage)) return true;
  return nenntEinDatumAusDemDokument(frage, signals.documentDates);
}

/**
 * Umsatzsteuerliche Stichworte — nur als Themenbezug, nie als Erkennung.
 *
 * Die Formularkennungen stehen hier, damit „Hat das mit USt 1 TG zu tun?" als
 * Frage zum vorliegenden Papier durchgeht. Sie **bestimmen** dabei nichts:
 * Welches Papier vorliegt, hat die Erkennung längst entschieden, und eine
 * Frage nach der anderen Bescheinigung holt deren Wissen nicht herbei.
 */
const FRAGE_NENNT_UMSATZSTEUER =
  /(umsatzsteuer|mehrwertsteuer|\b13b\b|§\s*13|steuerschuldner|reverse[\s-]?charge|auftraggeber|leistungsempf(ä|ae)nger|abrechnen|rechnung stellen|ausweisen|ans(ä|ae)ssig|betriebsst(ä|ae)tte|inland|ausland|ust\s*1\s*t[gs])/i;

/** Fragen nach der Geltung — „Wie lange gilt sie?" gehört dazu. */
const FRAGE_ZUR_GELTUNG =
  /(wie lange|gilt|g(ü|ue)ltig|geltungsdauer|l(ä|ae)uft ab|ablauf|befristet|widerruf)/i;

/**
 * Welche Bescheinigungsart ein Thema voraussetzt — für den Weg **ohne**
 * belastbare Erkennung.
 *
 * Dort führt nur die Frage zu einem Thema, und dann muss das Dokument
 * wenigstens über Art oder Betreff dazupassen. Die vier Einträge gehören alle
 * zur Freistellungsbescheinigung; das Thema der USt 1 TG steht hier nicht,
 * weil es auf diesem Weg gar nicht entstehen kann — es kommt ausschliesslich
 * aus der erkannten Bescheinigung.
 */
const THEMA_BRAUCHT_BESCHEINIGUNG: Record<string, SemanticCertificateType> = {
  [KNOWLEDGE_TOPIC_BAUABZUGSTEUER]: 'construction_withholding_exemption',
  [KNOWLEDGE_TOPIC_FREISTELLUNG]: 'construction_withholding_exemption',
  [KNOWLEDGE_TOPIC_FREISTELLUNG_ANTRAG]: 'construction_withholding_exemption',
  [KNOWLEDGE_TOPIC_FREISTELLUNG_GUELTIGKEIT]: 'construction_withholding_exemption',
};

/**
 * Sagt das Dokument belastbar etwas anderes, als das Thema voraussetzt?
 *
 * Nur eine belastbar erkannte Art widerspricht. „Unklar" und „widersprüchlich"
 * widersprechen nicht — sie wissen es bloss nicht, und Unwissen ist kein
 * Gegenbeweis.
 */
function dokumentWiderspricht(signals: DocumentKnowledgeSignals, thema: string): boolean {
  const gebraucht = THEMA_BRAUCHT_BESCHEINIGUNG[thema];
  if (!gebraucht) return false;
  if (!isCertificateTypeReliable(signals.certificate)) return false;
  return signals.certificate?.type !== gebraucht;
}

/** Trägt das Dokument das Thema — über seine Art oder über seine Beschreibung? */
function dokumentBestaetigt(signals: DocumentKnowledgeSignals, thema: string): boolean {
  const gebraucht = THEMA_BRAUCHT_BESCHEINIGUNG[thema];
  if (
    gebraucht &&
    isCertificateTypeReliable(signals.certificate) &&
    signals.certificate?.type === gebraucht
  ) {
    return true;
  }
  /*
   * Der bisherige Weg bleibt: Auch ohne saubere Bescheinigungserkennung — etwa
   * bei schwacher Texterkennung — trägt eine eindeutige Dokumentart oder ein
   * eindeutiger Betreff das Thema weiterhin.
   */
  return dokumentGehoertZumThema(signals);
}

/**
 * Der zweite Weg: Die Frage bezieht sich auf dieses Dokument, und dieses
 * Dokument gehört zum Thema.
 */
/**
 * GESAMTABNAHME-01J — dieselbe Breite wie bei einer erkannten Bescheinigung.
 *
 * In der Abnahme fiel auf, dass Folgefragen ohne Themenwort leer ausgingen:
 * „Muss mein Auftraggeber 15 Prozent einbehalten?", „Wie bekomme ich eine
 * neue?", „Wie kann mein Auftraggeber sie prüfen?" — alle drei auf einer
 * Freistellungsbescheinigung, und keine bekam die belegten Aussagen, obwohl
 * genau sie die Antwort tragen. So fragt aber jeder: Das Papier liegt vor,
 * man zeigt darauf und sagt „sie", „eine neue", „15 Prozent".
 *
 * Die Enge stammte daher, dass dieser Weg noch die alte, schmale Prüfung
 * benutzte, während der Weg über die erkannte Bescheinigungsart längst die
 * breitere hat. Jetzt benutzen beide dieselbe — die Bedingung davor bleibt
 * unverändert streng: Das Dokument muss zum Thema gehören.
 */
function bezugAufThemadokument(signals: DocumentKnowledgeSignals, frage: string): boolean {
  if (!dokumentGehoertZumThema(signals)) return false;
  return frageBetrifftDasDokument(signals, frage);
}

/**
 * Wer bei offener Bescheinigung nach dem Finanzamt oder einem Antrag fragt,
 * fragt nach dieser Sache.
 *
 * „Kann ich beim Finanzamt Fristverlängerung beantragen?" nennt das Thema
 * nicht beim Namen und zeigt auch nicht auf das Schreiben — gemeint ist es
 * trotzdem. Ohne diesen Weg bliebe die Antwort bei „steht nicht im Dokument",
 * obwohl eine belegte Auskunft über den Antragsweg vorliegt.
 *
 * Greift **nur** bei einem Dokument, das ohnehin zum Thema gehört; bei einer
 * Mahnung löst dasselbe Wort nichts aus.
 */
const VERFAHRENSWORT =
  /(finanzamt|beantrag|antrag|verlänger|verlaenger|erneuer|elster|bekomme ich|erhalte ich|eine neue|neue bescheinigung)/i;

function dokumentGehoertZumThema(signals: DocumentKnowledgeSignals): boolean {
  const felder = [signals.classifiedKind, signals.subject, signals.purpose]
    .filter((wert): wert is string => typeof wert === 'string' && wert.length > 0)
    .join(' ');
  return /(freistellungsbescheinigung|bauabzug|48b)/i.test(felder);
}

/**
 * Ein Datum aus dem Schreiben in der Frage ist ein Bezug auf das Schreiben.
 *
 * Wer „Was passiert nach dem 31.08.2029?" fragt, während genau dieses Datum
 * im Dokument als Ende der Geltungsdauer steht, fragt nach dem Dokument —
 * auch ohne das Wort „diese".
 */
function nenntEinDatumAusDemDokument(
  frage: string,
  daten: readonly (string | null | undefined)[] | undefined,
): boolean {
  if (!daten || daten.length === 0) return false;
  for (const datum of daten) {
    if (!datum) continue;
    if (frage.includes(datum)) return true;
    const deutsch = alsDeutschesDatum(datum);
    if (deutsch && frage.includes(deutsch)) return true;
  }
  return false;
}

function alsDeutschesDatum(iso: string): string | null {
  const treffer = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!treffer) return null;
  return `${treffer[3]}.${treffer[2]}.${treffer[1]}`;
}

/**
 * Welcher Ausschnitt des Themas gemeint ist.
 *
 * Grob absichtlich: Vier Schubladen, keine Feinsortierung. Lieber eine Aussage
 * zu viel im Prompt als die passende nicht dabei — und alles auf einmal ist
 * ohnehin ausgeschlossen.
 */
function themaAusWortlaut(frage: string): string {
  if (/(beantrag|antrag|neue|erneuer|verlänger|verlaenger|bekomme ich|erhalte ich|unterlagen|elster|formular)/i.test(frage)) {
    return KNOWLEDGE_TOPIC_FREISTELLUNG_ANTRAG;
  }
  if (/(gültig|gueltig|geltungsdauer|läuft ab|laeuft ab|ablauf|danach|nach dem|verfällt|verfaellt|prüfen|pruefen|eibe)/i.test(frage)) {
    return KNOWLEDGE_TOPIC_FREISTELLUNG_GUELTIGKEIT;
  }
  if (/(einbehalt|abzug|abzugsteuer|abzugssteuer|bauabzug|15 prozent|prozent)/i.test(frage)) {
    return KNOWLEDGE_TOPIC_BAUABZUGSTEUER;
  }
  return KNOWLEDGE_TOPIC_FREISTELLUNG;
}

/**
 * Die Aussagen, die dem Modell vorgelegt werden dürfen.
 *
 * Nur `usable` — also das, was zum Stichtag als geltendes, belegtes Wissen
 * dienen darf. Was abgelaufen, noch nicht in Kraft oder zu lange ungeprüft
 * ist, erreicht den Prompt gar nicht erst. Die Entscheidung darüber trifft
 * weiterhin die Richtlinie aus 01H1 und nicht dieses Modul.
 */
export function findDocumentKnowledge(signals: DocumentKnowledgeSignals): KnowledgeHit[] {
  const themen = resolveKnowledgeTopics(signals);
  if (themen.length === 0) return [];

  const gesammelt = new Map<string, KnowledgeHit>();
  for (const thema of themen) {
    /* Nur Themen aus dem ausgelieferten Bestand; alles andere bleibt unangetastet. */
    if (!KNOWLEDGE_TOPICS_PRODUKTIV.includes(thema)) continue;
    for (const treffer of findKnowledgeStatements({ topic: thema, asOf: signals.asOf }).usable) {
      gesammelt.set(treffer.statement.id, treffer);
    }
  }
  return [...gesammelt.values()];
}

/* ------------------------------------------------------------------ *
 * Die Prüfung der Belege
 * ------------------------------------------------------------------ */

/**
 * Aus behaupteten Kennungen werden belegte Quellen — oder gar keine.
 *
 * Das Modell nennt Kennungen. Das ist eine Behauptung, und sie wird wie eine
 * behandelt: Gültig ist eine Kennung nur, wenn sie in **dieser** Anfrage
 * tatsächlich vorgelegt wurde. Eine erfundene Kennung fällt damit von selbst
 * heraus, und eine echte, die zu einer anderen Frage gehört, ebenso.
 *
 * Adressen kommen niemals aus dem Modelltext. Sie werden hier aus dem Bestand
 * geholt — das ist der Unterschied zwischen einer Quellenangabe und einem
 * Link, den jemand geschrieben hat, der auch Sätze erfindet.
 */
export function verifyUsedKnowledge(
  claimedIds: readonly string[] | undefined,
  offered: readonly KnowledgeHit[],
): AreaAiKnowledgeSource[] {
  if (!claimedIds || claimedIds.length === 0) return [];

  const vorgelegt = new Map(offered.map((hit) => [hit.statement.id, hit]));
  const belege: AreaAiKnowledgeSource[] = [];
  const gesehen = new Set<string>();

  for (const id of claimedIds) {
    const hit = vorgelegt.get(id.trim());
    if (!hit || gesehen.has(hit.statement.id)) continue;
    /*
     * Doppelt geprüft: `offered` enthält nur verwendbare Aussagen, aber diese
     * Zusage darf nicht davon abhängen, dass der Aufrufer das eingehalten hat.
     */
    if (!hit.freshness.usableAsCurrent) continue;
    gesehen.add(hit.statement.id);
    belege.push({
      statementId: hit.statement.id,
      statement: hit.statement.statement,
      sourceTitle: hit.source.title,
      publisher: hit.source.publisher,
      ...(sichereQuellenadresse(hit.source.url) ? { url: hit.source.url } : {}),
      reviewedAt: hit.statement.reviewedAt,
    });
  }

  return belege;
}

/**
 * Welche Adresse verlinkt werden darf.
 *
 * Nur `https`. `javascript:` und `data:` sind die bekannten Wege, aus einem
 * Verweis eine Ausführung zu machen; `http` würde den Benutzer ungeschützt
 * weiterschicken. Da die Adresse ohnehin nur aus dem eigenen Bestand stammt,
 * ist diese Prüfung ein zweiter Riegel — und genau deshalb steht sie hier.
 */
export function sichereQuellenadresse(url: string | undefined): boolean {
  if (!url) return false;
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * DOKUMENT-ASSISTENT-01H2 / 01H2B — welche Art von Aussage ist das?
 *
 * **Warum diese Datei hier liegt und nicht im Client.**
 *
 * Die Prüfung entstand in 01H2 im Browser. 01H2 hat dabei selbst festgestellt,
 * dass sie damit umgehbar ist: Wer den KI-Endpunkt unmittelbar anspricht,
 * bekommt die Antwort des Modells ungeprüft. Eine Schranke, die nur im Client
 * steht, ist eine Bitte, keine Grenze.
 *
 * Also steht die Regel jetzt dort, wo beide Seiten sie erreichen — neben
 * `aiContract.ts`, nach demselben bewährten Muster: **reines** TypeScript,
 * keine Deno-API, kein Node, keine Oberfläche, kein Import. Die Edge Function
 * führt sie aus, der Client führt dieselbe aus, und die Vitest-Umgebung prüft
 * genau diese eine Datei.
 *
 * Zwei Kopien wären der eigentliche Fehler: Sie laufen auseinander, und dann
 * gilt irgendwann im Browser etwas anderes als auf dem Server — ohne dass es
 * jemandem auffällt.
 *
 * **Warum es die Prüfung überhaupt gibt.**
 *
 * Bisher entschied ein Wort über eine ganze Antwort: Stand irgendwo im Text
 * `rechtsberatung`, wurde alles verworfen. Genau das traf die *richtige*
 * Antwort am härtesten — denn ein sorgfältiger Assistent schreibt „Das ist
 * keine Rechtsberatung“, und dieser Satz enthält das verbotene Wort. Der
 * Benutzer bekam daraufhin gar nichts.
 *
 * Nicht das Wort ist gefährlich, sondern die **Art der Behauptung**:
 *
 *   `general_information`        — allgemeine Einordnung ohne Entscheidung
 *                                  über diesen Betrieb („Eine Mängelanzeige
 *                                  setzt üblicherweise eine Frist.“),
 *                                  ebenso jede Wiedergabe dessen, was im
 *                                  Dokument steht.
 *   `uncertain_individual`       — es geht um diesen Fall, aber der Vorbehalt
 *                                  steht dabei („Ob das hier zutrifft, sollten
 *                                  Sie prüfen lassen.“).
 *   `binding_individual_decision`— eine Entscheidung über diesen Fall, ohne
 *                                  Vorbehalt („Sie können diese Kosten
 *                                  steuerlich absetzen.“) oder eine
 *                                  angemasste Beraterrolle.
 *
 * Nur die dritte Klasse darf nicht stehen bleiben.
 *
 * **Was hier ausdrücklich nicht versucht wird.**
 *
 * Deutsches Recht zu verstehen. Das kann keine Mustererkennung, und der
 * Versuch würde eine Sicherheit vortäuschen, die es nicht gibt. Geprüft wird
 * nur eine Handvoll Merkmale: Wird jemand persönlich angesprochen? Geht es um
 * ein Rechts- oder Steuerthema? Steht ein Vorbehalt dabei? Beruft sich der
 * Satz auf das Dokument?
 *
 * Deshalb bleibt die Prüfung bewusst grob — und ihre Folge bewusst mild: Ein
 * beanstandeter Satz entfällt, die übrige Antwort bleibt. Ein zu strenger
 * Filter, der die ganze Antwort nimmt, richtet mehr Schaden an als ein Satz
 * zu viel oder zu wenig.
 *
 * **Dieser Block schaltet kein Fachwissen frei.** Er erlaubt dem Assistenten,
 * das zu sagen, was er ohnehin belegen kann, ohne an einem Wort zu scheitern.
 * Belegte Fachaussagen kommen erst mit 01H3 aus `domainKnowledge` hinzu.
 */

export type LegalClaimClass =
  | 'general_information'
  | 'uncertain_individual'
  | 'binding_individual_decision';

export interface LegalClaimFinding {
  /** Der beanstandete Satz, gekürzt — für Protokoll und Test, nicht für die Oberfläche. */
  segment: string;
  /** Woran es lag. Ebenfalls intern. */
  reason: string;
}

export interface LegalClaimReview {
  findings: LegalClaimFinding[];
  /**
   * Der Text ohne die beanstandeten Sätze — oder `null`, wenn nichts
   * Brauchbares übrig bleibt. `null` heisst: fail-closed, hier darf nichts
   * durch.
   */
  safeText: string | null;
}

/* ------------------------------------------------------------------ *
 * Merkmale
 * ------------------------------------------------------------------ */

/**
 * Eine angemasste Beraterrolle. Das ist der eine Fall, der unabhängig von
 * allem anderen nicht stehen bleiben darf: Der Assistent gibt vor, etwas zu
 * sein, was er nicht ist.
 */
const ROLLENANMASSUNG: readonly RegExp[] = [
  /ich berate sie (rechtlich|steuerlich|anwaltlich)/,
  /(als|ihr|ihre) (rechtsanwalt|anwalt|anwältin|steuerberater|steuerberaterin)\b/,
  /(dies|das|hier) ist (eine )?(rechtsberatung|steuerberatung)/,
  /(dies|das) stellt eine (rechtsberatung|steuerberatung) dar/,
];

/** Eine Verbindlichkeitszusage — „darauf können Sie sich verlassen“. */
const VERBINDLICHKEITSZUSAGE: readonly RegExp[] = [
  /rechtsverbindlich/,
  /rechtsg(ü|ue)ltig/,
  /rechtlich bindend/,
  /garantiere? (ihnen )?(rechtlich|steuerlich)/,
  /garantiert (rechtlich|steuerlich)/,
  /steuerlich garantiert/,
  /gerichtlich durchsetzbar/,
];

/**
 * Eine Erfolgs- oder Zulässigkeitszusage.
 *
 * Diese Sätze kommen ohne Ansprache und ohne Fachwort aus und sind trotzdem
 * die folgenschwersten: „Der Antrag wird genehmigt." „Die 5.000 EUR dürfen
 * rechtmässig einbehalten werden." Wer darauf vertraut, handelt — und der
 * Schaden entsteht erst später, bei jemand anderem.
 *
 * Sie werden wie die Verbindlichkeitszusage behandelt, mit zwei Ausnahmen:
 * Eine Verneinung entwertet sie, und ein Vorbehalt macht sie zur blossen
 * Einschätzung („Möglicherweise wird der Antrag genehmigt.").
 */
const ERFOLGSZUSAGE: readonly RegExp[] = [
  /(wird|werden|ist|sind) (hiermit )?(genehmigt|bewilligt|stattgegeben|abgelehnt|anerkannt)/,
  /(darf|dürfen|kann|können) .{0,30}(rechtm(ä|ae)(ß|ss)ig|rechtlich|zul(ä|ae)ssig|einbehalten werden)/,
  /rechtm(ä|ae)(ß|ss)ig (einbehalten|gekürzt|verweigert|zurückbehalten)/,
  /(ist|sind) (rechtlich )?(zul(ä|ae)ssig|unzul(ä|ae)ssig|verj(ä|ae)hrt|wirksam|unwirksam)/,
  /haben (sie )?(einen |keinen )?anspruch auf/,
  /(definitiv|in jedem fall|auf jeden fall|sicher) .{0,30}(absetz|haft|anspruch|zul(ä|ae)ssig)/,
];

/**
 * Geht es um diesen konkreten Fall?
 *
 * Nicht nur die persönliche Ansprache zählt. „Das ist steuerlich absetzbar"
 * spricht niemanden an und ist trotzdem eine Entscheidung über genau diesen
 * Beleg — hinweisende Wörter gehören deshalb dazu.
 *
 * Absichtlich weit gefasst: Lieber einmal zu oft nachsehen, ob ein Vorbehalt
 * dabeisteht, als eine Einzelfallentscheidung zu übersehen. Für sich genommen
 * blockiert keines dieser Wörter etwas — es braucht immer ein Fachthema dazu.
 */
const FALLBEZUG =
  /\b(sie|ihnen|ihr|ihre|ihren|ihrem|ihrer|ihres|wir|uns|unser|unsere|unserem|ich|mein|meine|meinen|meinem|das|dies|diese|dieser|dieses|diesen|diesem|hier)\b/;

/**
 * Geht es um ein Rechts- oder Steuerthema?
 *
 * Hier stehen die Themen, bei denen eine unbedachte Zusage teuer wird. Ein
 * einzelnes dieser Wörter blockiert **nichts** — es sorgt nur dafür, dass
 * nach einem Vorbehalt gesucht wird.
 */
const FACHTHEMA =
  /(absetzbar|absetzen|vorsteuer|steuerfrei|steuerpflichtig|steuerlich|haften|haftung|haftbar|verj(ä|ae)hr|verpflichtet|verpflichtung|anspruch|ansprüche|schadensersatz|schadenersatz|klage|klagen|verklag|strafbar|bu(ß|ss)geld|zwangsgeld|gesetzlich|rechtlich|gerichtlich|widerspruch einlegen|kündigen|kündigung)/;

/**
 * Ein Vorbehalt — der Satz entscheidet nicht, er ordnet ein.
 *
 * Wer die zuständige Stelle nennt, entscheidet nicht selbst — deshalb zählt
 * `zuständig` als Vorbehalt: „Für steuerliche Fragen ist das Finanzamt
 * zuständig" verweist weiter, statt den Fall zu erledigen.
 *
 * `können` und `müssen` stehen bewusst **nicht** hier: „Sie können das
 * absetzen“ ist eine Entscheidung, kein Vorbehalt. Und „Sie müssen die
 * Mängel bis zum 30.09. beseitigen“ ist eine Tatsache aus dem Dokument —
 * die wird über den Beleg erkannt, nicht über ein Hilfsverb.
 */
const VORBEHALT =
  /(in der regel|üblicherweise|in vielen fällen|häufig|möglicherweise|vermutlich|unter umständen|im einzelfall|einzelfallabhängig|kommt darauf an|hängt (davon |vom |von )|grunds(ä|ae)tzlich|ohne gew(ä|ae)hr|keine rechtsberatung|keine steuerberatung|kein rechtsrat|nicht abschlie(ß|ss)end|nicht verbindlich|lassen sie|prüfen lassen|klären lassen|(sollten|können) sie .{0,40}(prüfen|klären|erfragen)|bitte .{0,40}(prüfen|klären|erfragen)|wenden sie sich|zuständig|zuständigkeit|ich kann (das )?nicht (sicher )?(sagen|beurteilen)|steht nicht im dokument|geht aus dem dokument nicht hervor)/;

/**
 * Beruft sich der Satz auf das Dokument?
 *
 * Das ist die Herkunftsprüfung, und sie ist bewusst die **erste**: Was im
 * Schreiben steht, gibt der Assistent wieder — er entscheidet es nicht. Eine
 * Frist aus einer Mängelanzeige bleibt eine Tatsache, auch wenn „müssen“
 * darin vorkommt.
 */
const DOKUMENTBELEG =
  /(laut dokument|im dokument|das dokument|dieses dokument|dem dokument|im schreiben|laut schreiben|dem schreiben|des schreibens|in der mängelanzeige|in der rechnung|in der bescheinigung|der absender|die absenderin|der aussteller|gem(ä|ae)ß dem|nach dem schreiben|dort (steht|heißt|heisst)|darin (steht|heißt|heisst))/;

function enthaelt(text: string, muster: readonly RegExp[]): RegExp | null {
  for (const regex of muster) {
    if (regex.test(text)) return regex;
  }
  return null;
}

/**
 * Steht vor der Fundstelle eine Verneinung?
 *
 * „Diese Auskunft ist nicht rechtsverbindlich“ und „Das ersetzt keine
 * Steuerberatung“ sind genau die Sätze, die wir uns wünschen. Sie enthalten
 * dieselben Wörter wie die Zusagen, die wir verhindern wollen — der
 * Unterschied liegt allein in der Verneinung davor.
 */
function istVerneint(text: string, treffer: RegExp): boolean {
  const stelle = text.search(treffer);
  if (stelle < 0) return false;
  const davor = text.slice(Math.max(0, stelle - 60), stelle);
  return /\b(kein|keine|keinen|keiner|keinerlei|nicht|nie|niemals|ersetzt|ersetzen|statt)\b/.test(davor);
}

/* ------------------------------------------------------------------ *
 * Einordnung
 * ------------------------------------------------------------------ */

export function classifyLegalClaim(segment: string): LegalClaimClass {
  const text = segment.toLowerCase();

  /*
   * 1 — Herkunft zuerst. Ein Satz, der sich auf das Dokument beruft, gibt
   *     wieder statt zu entscheiden. Das gilt auch dann, wenn er ein
   *     Rechtsthema nennt: „Laut Schreiben sind Sie zur Nacherfüllung
   *     verpflichtet“ ist eine Tatsache über das Schreiben.
   */
  if (DOKUMENTBELEG.test(text)) {
    return 'general_information';
  }

  /* 2 — Angemasste Rolle oder Verbindlichkeitszusage, sofern nicht verneint. */
  const rolle = enthaelt(text, ROLLENANMASSUNG);
  if (rolle && !istVerneint(text, rolle)) {
    return 'binding_individual_decision';
  }
  const zusage = enthaelt(text, VERBINDLICHKEITSZUSAGE);
  if (zusage && !istVerneint(text, zusage)) {
    return 'binding_individual_decision';
  }

  /* 3 — Erfolgs- oder Zulässigkeitszusage, sofern nicht verneint. */
  const erfolg = enthaelt(text, ERFOLGSZUSAGE);
  if (erfolg && !istVerneint(text, erfolg)) {
    return VORBEHALT.test(text) ? 'uncertain_individual' : 'binding_individual_decision';
  }

  /* 4 — Entscheidung über diesen Fall? Nur mit Fallbezug *und* Fachthema. */
  if (FALLBEZUG.test(text) && FACHTHEMA.test(text)) {
    return VORBEHALT.test(text) ? 'uncertain_individual' : 'binding_individual_decision';
  }

  return 'general_information';
}

/* ------------------------------------------------------------------ *
 * Zerlegung
 * ------------------------------------------------------------------ */

/**
 * Zerlegt in Sätze — ohne an Datumsangaben zu zerbrechen.
 *
 * „bis zum 30.09.2026“ enthält drei Punkte und ist ein Satzteil, kein
 * Satzende. Dieselbe Falle hat schon einmal eine Fristauswertung
 * auseinandergerissen; die Lehre steht hier als Regel: Ein Punkt beendet
 * einen Satz nur, wenn danach Abstand und ein Grossbuchstabe folgen.
 *
 * Entscheidend ist, was **nach** dem Punkt steht, nicht davor: In
 * „31.08.2029. Danach" steht vor dem zweiten Punkt eine Ziffer, und er
 * beendet trotzdem den Satz. In „01.09.2026" folgt dem Punkt unmittelbar
 * eine Ziffer — dort endet nichts.
 */
export function splitIntoClaimSegments(text: string): string[] {
  const segmente: string[] = [];
  let start = 0;

  for (let i = 0; i < text.length; i += 1) {
    const zeichen = text[i];
    const istZeilenende = zeichen === '\n';
    const istSatzzeichen = zeichen === '.' || zeichen === '!' || zeichen === '?';
    if (!istZeilenende && !istSatzzeichen) continue;

    if (istSatzzeichen && !istEchtesSatzende(text, i)) continue;

    segmente.push(text.slice(start, i + 1));
    start = i + 1;
  }

  if (start < text.length) segmente.push(text.slice(start));
  return segmente.filter((teil) => teil.trim().length > 0);
}

/**
 * Abkürzungen, hinter denen kein Satz endet.
 *
 * Sichtbar geworden an einer echten Antwort: „Für spezifische steuerliche
 * Fragen, z. B. Beratung, …" wurde hinter dem `z.` getrennt, das Bruchstück
 * fiel weg — und der Benutzer las einen Satz mit einem Loch darin. Ein
 * entfernter Satz ist vertretbar, ein zerschnittener nicht.
 */
const ABKUERZUNGEN = new Set([
  'z', 'b', 'bzw', 'ggf', 'evtl', 'ca', 'inkl', 'exkl', 'inkl', 'nr', 'abs',
  'vgl', 'bspw', 'u', 'a', 'd', 'h', 'ff', 's', 'sog', 'etc', 'max', 'min',
]);

function istEchtesSatzende(text: string, position: number): boolean {
  if (text[position] !== '.') return true;

  /* Steht davor eine Abkürzung, endet hier nichts. */
  const wortDavor = text.slice(0, position).match(/([A-Za-zÄÖÜäöüß]+)$/u)?.[1];
  if (wortDavor && ABKUERZUNGEN.has(wortDavor.toLowerCase())) return false;

  const rest = text.slice(position + 1);
  if (!rest.trim()) return true;

  /* Nach dem Punkt muss Abstand kommen und danach ein Grossbuchstabe. */
  const fortsetzung = rest.match(/^\s+(\S)/u);
  if (!fortsetzung) return false;
  const naechstes = fortsetzung[1] ?? '';
  if (/\d/.test(naechstes)) return false;
  return naechstes === naechstes.toUpperCase();
}

/* ------------------------------------------------------------------ *
 * Prüfung
 * ------------------------------------------------------------------ */

/**
 * So wenig darf nicht übrig bleiben.
 *
 * Ein Rest von zwei Wörtern ist keine Antwort, sondern ein Trümmerstück —
 * und ein Trümmerstück verwirrt mehr als eine ehrliche Absage.
 */
const MINDESTLAENGE_BRAUCHBAR = 25;

export function reviewLegalClaims(text: string): LegalClaimReview {
  const findings: LegalClaimFinding[] = [];
  const behalten: string[] = [];

  for (const segment of splitIntoClaimSegments(text)) {
    if (classifyLegalClaim(segment) === 'binding_individual_decision') {
      findings.push({
        segment: segment.trim().slice(0, 160),
        reason: 'Entscheidung über den Einzelfall ohne Vorbehalt',
      });
      continue;
    }
    behalten.push(segment);
  }

  if (findings.length === 0) {
    return { findings, safeText: text };
  }

  const rest = behalten.join('').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return { findings, safeText: rest.length >= MINDESTLAENGE_BRAUCHBAR ? rest : null };
}

/* ------------------------------------------------------------------ *
 * Modellantworten
 * ------------------------------------------------------------------ */

/**
 * Dieselbe Prüfung, aber für das, was ein Modell tatsächlich zurückgibt.
 *
 * Der Dokument-Assistent verlangt ein JSON-Objekt. Dessen Rohtext ist keine
 * Prosa: `{"directAnswer":"…","explanation":"…"}` enthält keine Satzenden an
 * den Stellen, wo Sätze enden. Würde man ihn wie Fliesstext zerlegen, wäre die
 * ganze Antwort **ein** Segment — und die Prüfung fiele auf genau das zurück,
 * was dieser Block abschaffen soll: alles oder nichts.
 *
 * Deshalb wird geprüft, was der Benutzer später liest, und nur das.
 */
export function reviewAiAnswerText(text: string): LegalClaimReview {
  const alsJson = pruefeJsonAntwort(text);
  return alsJson ?? reviewLegalClaims(text);
}

/** Zwei Zeichen genügen, um zu entscheiden, ob es sich um JSON handelt. */
function pruefeJsonAntwort(text: string): LegalClaimReview | null {
  const start = text.indexOf('{');
  const ende = text.lastIndexOf('}');
  if (start < 0 || ende <= start) return null;

  let objekt: Record<string, unknown>;
  try {
    const geparst: unknown = JSON.parse(text.slice(start, ende + 1));
    if (!geparst || typeof geparst !== 'object' || Array.isArray(geparst)) return null;
    objekt = geparst as Record<string, unknown>;
  } catch {
    return null;
  }

  const findings: LegalClaimFinding[] = [];
  const gepruefte: Record<string, unknown> = { ...objekt };
  for (const [schluessel, wert] of Object.entries(objekt)) {
    if (typeof wert !== 'string' || !wert.trim()) continue;
    const pruefung = reviewLegalClaims(wert);
    findings.push(...pruefung.findings);
    gepruefte[schluessel] = pruefung.safeText ?? '';
  }

  if (findings.length === 0) return { findings, safeText: text };

  /*
   * Bleibt die Kernantwort leer, übernimmt der erste unbeanstandete Satz der
   * Begründung ihre Stelle. Sonst entstünde ein Objekt mit leerer Antwort —
   * der Leser sähe geschweifte Klammern statt einer Auskunft.
   */
  const direkt = typeof gepruefte.directAnswer === 'string' ? gepruefte.directAnswer.trim() : '';
  const erklaerung =
    typeof gepruefte.explanation === 'string' ? gepruefte.explanation.trim() : '';
  if (!direkt) {
    const ersterSatz = splitIntoClaimSegments(erklaerung)[0]?.trim() ?? '';
    if (!ersterSatz) return { findings, safeText: null };
    gepruefte.directAnswer = ersterSatz;
  }

  const uebrig = Object.values(gepruefte)
    .filter((wert): wert is string => typeof wert === 'string')
    .join(' ')
    .trim();
  if (uebrig.length < MINDESTLAENGE_BRAUCHBAR) return { findings, safeText: null };

  return { findings, safeText: JSON.stringify(gepruefte) };
}

/* ------------------------------------------------------------------ *
 * Die gemeinsame Absicherung
 * ------------------------------------------------------------------ */

/**
 * Welche Fachketten serverseitig geprüft werden.
 *
 * Es sind die drei, die dem Benutzer **Fliesstext auf eine Frage** liefern —
 * genau dort kann eine Einzelfallentscheidung entstehen.
 *
 * Bewusst **nicht** dabei:
 *
 *   `document_facts`      liefert eine strukturierte Feldzuordnung, keinen
 *                         Antworttext. Ein entfernter Satz wäre dort ein
 *                         beschädigter Datensatz.
 *   `communication_draft` liefert einen Briefentwurf, den der Benutzer vor
 *                         dem Versand sieht und freigibt. Diese Kette hat
 *                         eine eigene Prüfung mit anderen Anforderungen
 *                         (Beträge, Termine); ihr dieselbe Logik
 *                         überzustülpen, hiesse zwei verschiedene Fragen mit
 *                         derselben Antwort zu behandeln.
 */
export const SERVER_CLAIM_GUARDED_OPERATIONS: readonly string[] = [
  'document_question',
  'vorgang_question',
  'assistant',
];

export function isServerClaimGuardedOperation(operation: string): boolean {
  return SERVER_CLAIM_GUARDED_OPERATIONS.includes(operation);
}

/**
 * Was zurückgeht, wenn nichts Brauchbares übrig bleibt.
 *
 * Keine Fehlermeldung, kein Code, kein Hinweis auf eine Prüfung — der Satz
 * sagt, was gilt, und wohin die Frage gehört. Er muss die Prüfung selbst
 * bestehen; ein Ersatztext, der erneut beanstandet würde, wäre eine Falle.
 */
export const NEUTRAL_CLAIM_FALLBACK_TEXT =
  'Dazu kann hier keine belastbare Auskunft gegeben werden. Bitte sehen Sie im Originaldokument nach oder fragen Sie eine fachkundige Stelle.';

export interface GuardedAnswer {
  /** Der Text, der weitergegeben werden darf — nie `null`. */
  text: string;
  /** Wurde etwas entfernt? Nur für das Protokoll. */
  removed: number;
  /** Musste der neutrale Ersatz einspringen? */
  replaced: boolean;
}

/**
 * Die eine Entscheidung, die Server und Client gemeinsam treffen.
 *
 * Erst der milde Weg: den beanstandeten Satz entfernen, den Rest behalten.
 * Erst wenn davon nichts Brauchbares bleibt, der neutrale Ersatz. So ist die
 * Grenze geschlossen, ohne dass eine ganze Auskunft an einem Satz zerbricht.
 */
export function guardAiAnswerText(text: string): GuardedAnswer {
  const review = reviewAiAnswerText(text);
  if (review.findings.length === 0) {
    return { text, removed: 0, replaced: false };
  }
  if (review.safeText === null) {
    return { text: NEUTRAL_CLAIM_FALLBACK_TEXT, removed: review.findings.length, replaced: true };
  }
  return { text: review.safeText, removed: review.findings.length, replaced: false };
}

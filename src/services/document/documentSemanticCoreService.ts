/**
 * DOKUMENTVERSTAENDNIS-01B — liest den semantischen Kern aus dem Text.
 *
 * Bewusst **deterministisch**: Fristen, Beträge, Pflichten und die
 * Buchungseinschätzung entscheiden über Geld und Termine. Was dort passiert,
 * muss nachrechenbar sein und bei gleichem Text zweimal dasselbe ergeben. Wo
 * später eine sprachliche Analyse ergänzt, tut sie es als zusätzlicher
 * Vorschlag — nicht als Ersatz dieser Regeln.
 *
 * Der Dienst liest nur. Er verknüpft nichts, legt nichts an und bucht nichts.
 */
import type {
  DocumentSemanticCore,
  SemanticAmount,
  SemanticAmountRole,
  SemanticDeadline,
  SemanticDeadlineType,
  SemanticObligation,
  SemanticRecipientCheck,
  SemanticRelativeDeadline,
  SemanticRequestedDocument,
  SemanticValue,
} from '../../types/documentSemanticCore';
import { emptyDocumentSemanticCore } from '../../types/documentSemanticCore';
import { recognizeCertificate } from './documentCertificateRecognition';
import { readDunningSemantics } from './dunningText';
import { readComplaintSemantics, splitClauses } from './complaintText';
import { hasInstitutionalPrecedence } from './complaintLetter';
import { getCompanyProfileStoreSnapshot } from '../companyProfileService';
import type { CompanyProfile } from '../../types/models';

/* ------------------------------------------------------------------ */
/* Textwerkzeuge                                                       */
/* ------------------------------------------------------------------ */

function zeilen(text: string): string[] {
  return text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((z) => z.trim())
    .filter(Boolean);
}

function ausschnitt(quelle: string, maxLaenge = 160): string {
  const sauber = quelle.replace(/\s+/g, ' ').trim();
  return sauber.length <= maxLaenge ? sauber : `${sauber.slice(0, maxLaenge - 1)}…`;
}

/** Deutsches Tagesdatum in ISO. Nur echte Kalenderdaten, kein Raten. */
function toIsoDatum(tag: string, monat: string, jahr: string): string | null {
  const t = Number(tag);
  const m = Number(monat);
  let j = Number(jahr);
  if (jahr.length === 2) j += j < 70 ? 2000 : 1900;
  if (!Number.isFinite(t) || !Number.isFinite(m) || !Number.isFinite(j)) return null;
  if (m < 1 || m > 12 || t < 1 || t > 31) return null;
  const datum = new Date(Date.UTC(j, m - 1, t));
  if (datum.getUTCMonth() !== m - 1 || datum.getUTCDate() !== t) return null;
  return datum.toISOString().slice(0, 10);
}

const DATUM = /(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{2,4})/g;

interface DatumsTreffer {
  iso: string;
  index: number;
  roh: string;
}

function findeDaten(text: string): DatumsTreffer[] {
  const treffer: DatumsTreffer[] = [];
  DATUM.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = DATUM.exec(text)) !== null) {
    const iso = toIsoDatum(m[1], m[2], m[3]);
    if (iso) treffer.push({ iso, index: m.index, roh: m[0] });
  }
  return treffer;
}

/**
 * Der Satz, in dem eine Fundstelle steht. Er trägt die Bedeutung, nicht das Wort.
 *
 * Ein Punkt beendet nur dann einen Satz, wenn keine Ziffer unmittelbar davor
 * steht. Sonst zerfiele „gilt vom 01.09.2026 bis zum 31.08.2029" in
 * Bruchstücke — und mit ihnen ginge genau die Aussage verloren, die das Datum
 * einordnet. Das war der Grund, warum ein Gültigkeitsende zunächst weiterhin
 * als Handlungsfrist durchging.
 */
const SATZENDE = /[.!?](?=\s|$)/g;

function istEchtesSatzende(text: string, position: number): boolean {
  const davor = text[position - 1];
  if (!davor || !/\d/.test(davor)) return true;
  /* Nach einer Zahl nur dann, wenn ein neuer Satz erkennbar beginnt. */
  return /^\s+[A-ZÄÖÜ]/.test(text.slice(position + 1, position + 4));
}

function satzUm(text: string, index: number): string {
  let start = 0;
  let ende = text.length;

  SATZENDE.lastIndex = 0;
  let treffer: RegExpExecArray | null;
  while ((treffer = SATZENDE.exec(text)) !== null) {
    if (!istEchtesSatzende(text, treffer.index)) continue;
    if (treffer.index < index) start = treffer.index + 1;
    else {
      ende = treffer.index + 1;
      break;
    }
  }

  const umbruchVor = text.lastIndexOf('\n', Math.max(0, index - 1));
  if (umbruchVor + 1 > start) start = umbruchVor + 1;
  const umbruchNach = text.indexOf('\n', index);
  if (umbruchNach > index && umbruchNach < ende) ende = umbruchNach;

  return text.slice(start, ende).replace(/\s+/g, ' ').trim();
}

/* ------------------------------------------------------------------ */
/* Betreff                                                             */
/* ------------------------------------------------------------------ */

const BETREFF_MARKER = /^(betreff|betr\.?|subject)\s*[:\-]\s*(.+)$/i;

/**
 * Wörter, an denen ein Geschäftsschreiben seinen Gegenstand nennt. Sie dienen
 * nur dazu, die Betreffzeile **zu finden** — nicht dazu, eine Schreibensart zu
 * bestimmen. Ein Schreiben, das keines dieser Wörter trägt, bekommt schlicht
 * keinen Betreff, statt einen erfundenen.
 */
const BETREFF_HINWEISE =
  /(anzeige|mahnung|rechnung|gutschrift|bescheinigung|bescheid|kündigung|kuendigung|nachtrag|vertrag|angebot|auftrag|bestätigung|bestaetigung|erinnerung|aufforderung|anfrage|mitteilung|antrag|beschwerde|reklamation|abnahme|behinderung|schreiben zu|zur rechnung|zum auftrag|bauvorhaben)/i;

const ANREDE = /^(sehr geehrte|sehr geehrter|guten tag|liebe|hallo)/i;

/**
 * Sucht die echte Betreffzeile.
 *
 * Zwei Wege, beide belegbar: eine ausdrücklich mit „Betreff:" gekennzeichnete
 * Zeile, oder — der Normalfall im deutschen Geschäftsbrief — die letzte
 * inhaltstragende Zeile **vor der Anrede**. Findet sich keine, bleibt der
 * Betreff leer.
 */
function findeBetreff(text: string): SemanticValue<string> | undefined {
  const alle = zeilen(text);

  for (const zeile of alle) {
    const m = BETREFF_MARKER.exec(zeile);
    if (m && m[2].trim().length >= 3) {
      return { value: m[2].trim(), certainty: 'confirmed_by_existing_state', evidence: { snippet: ausschnitt(zeile) } };
    }
  }

  const anredeIndex = alle.findIndex((z) => ANREDE.test(z));
  if (anredeIndex > 0) {
    for (let i = anredeIndex - 1; i >= 0 && i >= anredeIndex - 4; i -= 1) {
      const kandidat = alle[i];
      if (kandidat.length < 8 || kandidat.length > 140) continue;
      if (findeDaten(kandidat).length > 0 && kandidat.length < 40) continue;
      if (!BETREFF_HINWEISE.test(kandidat)) continue;
      return { value: kandidat, certainty: 'detected', evidence: { snippet: ausschnitt(kandidat) } };
    }
  }

  return undefined;
}

/* ------------------------------------------------------------------ */
/* Fristen                                                             */
/* ------------------------------------------------------------------ */

interface FristRegel {
  muster: RegExp;
  type: SemanticDeadlineType;
  actionRequired: boolean;
  appliesTo: string;
}

/**
 * Die Regeln beschreiben **Bedeutungen**, keine Dokumentarten. „bis zum … zu
 * beseitigen" ist eine Leistungsfrist, ganz gleich, ob das Schreiben eine
 * Mängelanzeige, eine Behinderungsanzeige oder etwas Unbekanntes ist.
 *
 * Reihenfolge zählt: Die erste passende Regel gewinnt, und die eindeutigsten
 * stehen oben.
 */
const FRIST_REGELN: FristRegel[] = [
  {
    muster: /(gilt|gültig|gueltig)\s+(vom\s+\S+\s+)?bis(\s+zum)?\b|gültigkeit|gueltigkeit|läuft ab am|laeuft ab am/i,
    type: 'validity_period_end',
    actionRequired: false,
    appliesTo: 'Gültigkeit',
  },
  {
    /*
     * EINGANG-02A-2A — „fällig" allein ist keine Zahlung (auch Leistungen werden
     * fällig). Erst mit einem Zahlungsgegenstand im selben Satz — Betrag,
     * Gebühr, Beitrag, Selbstbeteiligung, Forderung — ist es eine Zahlungsfrist:
     * „Gebühr 75,00 EUR, fällig am …", „Der Betrag ist am … fällig".
     */
    muster:
      /(überweis|ueberweis|zahl(en|ung|bar)|begleich|zahlungsziel|zahlbar bis|ohne abzug)|(betr(a|ä)g|gebühr|gebuehr|beitrag|beiträg|beitraeg|selbstbeteiligung|forderung)\w*.{0,120}?(fällig|faellig)|(fällig|faellig).{0,120}?(betr(a|ä)g|gebühr|gebuehr|beitrag|beiträg|beitraeg|selbstbeteiligung|forderung)/i,
    type: 'payment_due',
    actionRequired: true,
    appliesTo: 'Zahlung',
  },
  {
    /* 02A-2A — „Nehmen Sie … Stellung", „beantworten Sie", „Teilen Sie uns … mit". */
    muster:
      /(bestätigen|bestaetigen|antwort|rückmeldung|rueckmeldung|stellungnahme|\bstellung\b|mitteilen|melden sie|teilen\s+sie\b.{0,120}?\bmit\b)/i,
    type: 'response_due',
    actionRequired: true,
    appliesTo: 'Antwort',
  },
  {
    /*
     * 02A-2A — getrennte Verbform „Reichen Sie … ein", „wir benötigen …" und
     * „senden/schicken Sie …" nur mit einem Dokument-Gegenstand: „Bitte senden
     * Sie das Leergut zurück" ist keine Unterlagenfrist.
     */
    muster:
      /(einreichen|vorlegen|übersenden|uebersenden|zusenden|zurücksenden|zuruecksenden|nachweis|unterlagen|reichen\s+sie\b.{0,120}?\bein\b|(senden|schicken)\s+sie\b.{0,80}?\b(belege?|fotos?|bilder|kopien?|dokumente?|bescheinigung\w*|formular\w*|erklärung\w*|erklaerung\w*|rechnungen?)\b|benötig|benoetig)/i,
    type: 'document_submission_due',
    actionRequired: true,
    appliesTo: 'Unterlagen',
  },
  {
    muster: /(beseitig|nachbesser|mängel|maengel|ausführ|ausfuehr|fertigstell|leist|liefer|abnahme|instandsetz)/i,
    type: 'service_due',
    actionRequired: true,
    appliesTo: 'Leistung',
  },
  {
    muster: /(kündig|kuendig|vertragsende|beendigung)/i,
    type: 'termination_notice',
    actionRequired: true,
    appliesTo: 'Kündigung',
  },
];

/** „bis zum 30.09.2026" — die sprachliche Markierung einer echten Frist. */
const FRIST_MARKER = /\b(bis\s+(zum\s+|spätestens\s+|spaetestens\s+)?|spätestens\s+(am\s+)?|spaetestens\s+(bis\s+)?|frist\w*\s+(zum\s+|bis\s+)?|zahlbar\s+bis\s+|fällig\s+(am\s+|bis\s+)?|faellig\s+(am\s+|bis\s+)?)$/i;
/** 02A-2A — „Der Betrag ist am 31.10.2026 fällig": die Markierung steht nach dem Datum. */
const FRIST_MARKER_DANACH = /^\s*(fällig|faellig)\b/i;
/** 02A-2A — nur diese Arten werden durch ein nachgestelltes „fällig" belegt. */
const FAELLIG_DANACH_TYPEN: ReadonlySet<SemanticDeadlineType> = new Set(['payment_due', 'service_due']);
/*
 * 02A-2A — eine vergangene Fälligkeit ist keine Handlungsfrist: „war am …",
 * „waren/wurde am …", „bereits am …", „war bereits am …", „ist seit dem …",
 * „war fällig am …" und „… fällig gewesen". Geprüft wird nur unmittelbar am
 * Datum, damit „…, der bereits fällig war, bis zum 15.10.2026" die echte
 * Frist behält. „bereits/schon am …" allein zählt nur mit nachgestelltem
 * „fällig" — „Bitte reichen Sie … bereits zum 20.10.2026 ein" bleibt Frist.
 */
const VERGANGENHEIT_DAVOR =
  /\b(seit|war|waren|wurde|wurden)\s+(?:(?:bereits|schon|fällig|faellig)\s+)?(?:(?:am|dem|zum|seit)\s+)?(?:dem\s+)?$/i;
const BEREITS_DAVOR = /\b(bereits|schon)\s+(am|zum)\s+$/i;
const VERGANGENHEIT_DANACH = /^\s*(fällig|faellig)\s+gewesen\b/i;

/*
 * 02A-2A — eine verneinte Handlung ist keine Frist und keine Pflicht: „Es sind
 * keine weiteren Unterlagen erforderlich", „Von Ihnen ist nichts weiter zu
 * veranlassen". Steht im selben Satz eine ausdrückliche Aufforderung („Bitte
 * senden Sie …"), gilt die Aufforderung.
 */
const VERNEINTE_HANDLUNG =
  /\bkeine\s+weiteren\b|\bnicht\s+(mehr\s+)?(erforderlich|notwendig|nötig|noetig)\b|\bnichts\s+(weiter|mehr)\b|\bentfällt\b|\bentfaellt\b/i;
const AUSDRUECKLICHE_AUFFORDERUNG =
  /\bbitte\b|\b(reichen|senden|schicken|zahlen|überweisen|ueberweisen|nehmen|teilen|beantworten|bestätigen|bestaetigen)\s+sie\b|\bwir\s+(benötigen|benoetigen)\b/i;

function istVerneinteHandlung(satz: string): boolean {
  return VERNEINTE_HANDLUNG.test(satz) && !AUSDRUECKLICHE_AUFFORDERUNG.test(satz);
}

/**
 * Das Briefdatum steht im Kopf und ist keine Frist. Es wird an seiner Stellung
 * erkannt — frühe Fundstelle, typischerweise nach einem Ortsnamen.
 */
function istBriefdatum(text: string, treffer: DatumsTreffer): boolean {
  const davor = text.slice(Math.max(0, treffer.index - 40), treffer.index);
  if (/[A-Za-zÄÖÜäöüß]{3,},\s*$/.test(davor)) return true;
  return treffer.index < Math.min(320, text.length * 0.2) && !/\bbis\b|frist|fällig|faellig/i.test(davor);
}

/*
 * EINGANG-02C — „Bitte nehmen Sie bis zum 15.10. Stellung und beseitigen Sie
 * den Mangel bis zum 31.10." nennt zwei Fristen zweier Aufforderungen. Die Art
 * einer Frist liest sich aus ihrem Teilsatz; steht dasselbe Datum in mehreren
 * Teilsätzen, bleibt es beim ganzen Satz.
 */
function teilsatzMit(satz: string, datum: string): string {
  const teile = splitClauses(satz);
  if (teile.length < 2) return satz;
  const mit = teile.filter((teil) => teil.includes(datum));
  return mit.length === 1 ? mit[0] : satz;
}

/** EINGANG-02C — was die Gegenseite selbst zusagt („Wir melden uns bis …"). */
const ZUSAGE_DER_GEGENSEITE =
  /\bwir\s+(?:melden\s+uns|antworten|werden\s+(?:uns|ihnen|sie)\b|senden\s+ihnen|schicken\s+ihnen|informieren\s+sie|kommen\s+(?:auf\s+sie\s+)?zur(?:ü|ue)ck|geben\s+ihnen|teilen\s+ihnen|liefern)\b|\bmelden\s+wir\s+uns\b/i;

/*
 * Nacharbeit 1 — „Wir geben Ihnen Gelegenheit, sich bis … zu äußern", „Wir
 * teilen Ihnen mit, dass der Betrag bis … zu zahlen ist", „Wir informieren
 * Sie, dass die Unterlagen bis … einzureichen sind": Der Absender teilt eine
 * Handlung des Empfängers mit. Ein eingebetteter zu-Infinitiv einer
 * Empfängerhandlung (oder die eingeräumte „Gelegenheit") geht der Zusage vor.
 */
const EINGEBETTETE_EMPFAENGERPFLICHT =
  /\bgelegenheit\b|\bzu\s+(?:zahlen|begleichen|überweisen|ueberweisen|entrichten|übermitteln|uebermitteln|übersenden|uebersenden|äußern|aeussern|nehmen|erbringen|leisten|beseitigen|melden)\b|\b(?:einzureichen|vorzulegen|einzuzahlen|nachzureichen|einzusenden|zuzusenden|nachzuweisen|abzugeben)\b/i;

function istZusageDerGegenseite(satz: string): boolean {
  return (
    ZUSAGE_DER_GEGENSEITE.test(satz) &&
    !EINGEBETTETE_EMPFAENGERPFLICHT.test(satz) &&
    !AUSDRUECKLICHE_AUFFORDERUNG.test(satz) &&
    !PFLICHT_AN_UNS.test(satz) &&
    !PFLICHT_AN_UNS_SIE_FORM.test(satz)
  );
}

function leseFristen(text: string): SemanticDeadline[] {
  const gefunden: SemanticDeadline[] = [];
  const gesehen = new Set<string>();

  for (const treffer of findeDaten(text)) {
    const satz = teilsatzMit(satzUm(text, treffer.index), treffer.roh);
    const davor = text.slice(Math.max(0, treffer.index - 30), treffer.index);
    const danach = text.slice(treffer.index + treffer.roh.length, treffer.index + treffer.roh.length + 20);
    /* „war am 27.08.2026 fällig", „seit dem …": ein vergangener Fälligkeitstag, keine Frist. */
    const istVergangeneFaelligkeit =
      VERGANGENHEIT_DAVOR.test(davor) ||
      VERGANGENHEIT_DANACH.test(danach) ||
      (BEREITS_DAVOR.test(davor) && FRIST_MARKER_DANACH.test(danach));
    const markerDavor = FRIST_MARKER.test(davor) && !istVergangeneFaelligkeit;
    const markerDanach = FRIST_MARKER_DANACH.test(danach) && !istVergangeneFaelligkeit;
    const hatFristMarker = markerDavor || markerDanach;

    let type: SemanticDeadlineType = 'informational';
    let actionRequired = false;
    let appliesTo = 'Hinweis';

    const regel = FRIST_REGELN.find((r) => r.muster.test(satz));
    if (regel) {
      type = regel.type;
      appliesTo = regel.appliesTo;
      /*
       * 02A-2A — das nachgestellte „fällig" belegt nur eine Fälligkeit von
       * Zahlung oder Leistung, keine Antwort- oder Unterlagenfrist.
       */
      const markerTraegt = markerDavor || (markerDanach && FAELLIG_DANACH_TYPEN.has(regel.type));
      actionRequired = regel.actionRequired && markerTraegt;
      /*
       * Ein Gültigkeitsende bleibt immer handlungsfrei — auch wenn im selben
       * Satz „bis zum" steht. Genau dieser Satz machte aus dem 31.08.2029 einer
       * Freistellungsbescheinigung eine vermeintliche Handlungsfrist.
       */
      if (type === 'validity_period_end') actionRequired = false;
    } else if (markerDavor) {
      /*
       * Ersatzregel nur für „bis zum …" vor dem Datum. „Die Rechnung ist am …
       * fällig" ohne belegte Art bleibt Hinweis statt erfundener Antwortfrist.
       */
      type = 'response_due';
      appliesTo = 'Handlung';
      actionRequired = true;
    }

    /*
     * „gilt vom 01.09.2026 bis zum 31.08.2029" nennt zwei Daten. Nur das zweite
     * ist das Ende der Gültigkeit; das erste ist ihr Beginn und stand bis hier
     * ebenfalls als „Gültig bis" da.
     */
    if (/\b(vom|ab)\s+$/i.test(davor)) {
      type = 'informational';
      actionRequired = false;
      appliesTo = 'Beginn';
    }

    if (istBriefdatum(text, treffer) && !hatFristMarker) {
      type = 'informational';
      actionRequired = false;
      appliesTo = 'Briefdatum';
    }

    if (istVerneinteHandlung(satz) || istVergangeneFaelligkeit) {
      type = 'informational';
      actionRequired = false;
      appliesTo = 'Hinweis';
    }

    /*
     * EINGANG-02C — „Wir melden uns bis zum 20.10.2026" ist eine Zusage der
     * Gegenseite, keine eigene Antwortfrist. Eine Aufforderung an uns im
     * selben Teilsatz („Bitte …", „<Verb> Sie", „Wir fordern …") geht vor.
     */
    if (istZusageDerGegenseite(satz)) {
      type = 'informational';
      actionRequired = false;
      appliesTo = 'Zusage der Gegenseite';
    }

    const schluessel = `${treffer.iso}|${type}`;
    if (gesehen.has(schluessel)) continue;
    gesehen.add(schluessel);

    gefunden.push({
      date: treffer.iso,
      type,
      appliesTo,
      actionRequired,
      certainty: regel && hatFristMarker ? 'detected' : 'uncertain',
      evidence: { snippet: ausschnitt(satz) },
    });
  }

  return gefunden;
}

/* ------------------------------------------------------------------ */
/* Pflichten                                                           */
/* ------------------------------------------------------------------ */

const PFLICHT_AN_UNS =
  /(wir fordern sie auf|sie werden aufgefordert|bitte (?:bestätigen|bestaetigen|übersenden|uebersenden|teilen|senden|legen|zahlen|überweisen|ueberweisen|beseitigen|reichen)|sie sind verpflichtet|haben sie zu|ist von ihnen|wir bitten sie)/i;
/*
 * EINGANG-02A-2A — Aufforderungen in der Sie-Form und Zahlungspflichten ohne
 * „bitte": „Nehmen Sie … Stellung", „Teilen Sie uns … mit", „Reichen Sie …
 * ein", „Wir benötigen …", „Die Gebühr … ist … zu zahlen". Alle richten sich
 * an den Empfänger — Aussagen der Gegenseite
 * („Wir werden Ihnen … senden", „Die Versicherung wird Stellung nehmen")
 * treffen keine dieser Formen.
 */
const PFLICHT_AN_UNS_SIE_FORM =
  /\b(nehmen\s+sie\b.{0,80}?\bstellung\b|(?:be)?antworten\s+sie\b|teilen\s+sie\b.{0,120}?\bmit\b|reichen\s+sie\b.{0,120}?\bein\b|(senden|schicken|zahlen|überweisen|ueberweisen)\s+sie\b|wir\s+(benötigen|benoetigen)\b|wir\s+bitten\s+um\s+(ihre\s+|eine\s+)?(rückmeldung|rueckmeldung|antwort|stellungnahme|zahlung|übersendung|uebersendung|zusendung|mitteilung|bestätigung|bestaetigung)\b|ist\b.{0,80}?\bzu\s+(zahlen|begleichen|überweisen|ueberweisen)\b|(?:beseitigen|beheben)\s+sie\b|bessern\s+sie\b.{0,80}?\bnach\b|wir\s+(?:fordern|verlangen|erwarten)\b(?:\s+von\s+ihnen)?.{0,40}?\b(?:nachbesserung|nacherfüllung|nacherfuellung|mängelbeseitigung|maengelbeseitigung|mangelbeseitigung|beseitigung|stellungnahme|rückmeldung|rueckmeldung|antwort)\b)/i;
/*
 * 02A-2A — „Der Betrag ist am … fällig" ist eine Zahlungspflicht nur, wenn der
 * Satz eine aktuelle Handlungsfrist trägt. „Der Rechnungsbetrag war am …
 * fällig" beschreibt die Vergangenheit und ist keine Pflicht.
 */
const PFLICHT_FAELLIG =
  /(betr(a|ä)g|gebühr|gebuehr|beitrag|beiträg|beitraeg|selbstbeteiligung|forderung)\w*.{0,100}?(fällig|faellig)/i;
const PFLICHT_AN_ANDERE =
  /(wir werden|wir behalten uns vor|wir verrechnen|wir erstatten|behalten wir|wir melden uns|melden wir uns|wir antworten)/i;

/*
 * EINGANG-02A-2B — Fristen ohne Kalenderdatum: „innerhalb von zwei Wochen nach
 * Zugang dieses Schreibens", „binnen 14 Tagen nach Erhalt", „innerhalb eines
 * Monats nach Bekanntgabe", „innerhalb der gesetzlichen Frist",
 * „unverzüglich". Der Treffer ist die Originalphrase — ein Datum entsteht
 * daraus nie.
 */
const RELATIVE_FRIST = new RegExp(
  [
    String.raw`\b(?:innerhalb|binnen)\s+(?:von\s+)?(?:\d{1,3}|eine[rs]?|zwei|drei|vier|fünf|fuenf|sechs|sieben|acht|zehn|zwölf|zwoelf|vierzehn)\s+(?:tag(?:e|en)?|woche(?:n)?|monat(?:s|e|en)?)\b` +
      String.raw`(?:\s+(?:nach|ab|seit)\s+(?:(?:dem|der|des)\s+)?(?:zugang|erhalt|bekanntgabe|zustellung|eingang|datum)\b` +
      String.raw`(?:\s+(?:dieses|diese[rs]?|des|unseres|unserer|ihres|ihrer)\s+[a-zäöüß]+)?)?`,
    String.raw`\b(?:innerhalb|binnen)\s+der\s+(?:gesetzlichen|genannten|vorgeschriebenen|vorgegebenen)\s+frist\b`,
    String.raw`\bunverzüglich\b`,
    String.raw`\bunverzueglich\b`,
    String.raw`\bumgehend\b`,
  ].join('|'),
  'i',
);

const RELATIVE_FRIST_GILT_FUER: Partial<Record<SemanticDeadlineType, string>> = {
  payment_due: 'Zahlung',
  response_due: 'Antwort',
  document_submission_due: 'Unterlagen',
  service_due: 'Leistung',
  termination_notice: 'Kündigung',
};

/*
 * EINGANG-02A-2B — ausdrücklicher Hinweis, dass ein Schreiben nur informiert.
 * Er zählt erst, wenn der Kern weder eigene Pflicht noch Handlungsfrist noch
 * relative Frist noch eine Forderung an uns gefunden hat.
 */
const INFORMATIONS_HINWEIS =
  /\bzu\s+ihrer\s+(?:information|kenntnis(?:nahme)?)\b|\bzur\s+(?:kenntnis(?:nahme)?|information)\b|\bnichts\s+(?:weiter|mehr|weiteres)\s+zu\s+veranlassen\b|\bkein(?:e|en)?\s+(?:weiteren?\s+)?handlungsbedarf\b|\bkeine\s+weiteren\s+unterlagen\b|\bbearbeitung\s+(?:wurde\s+eingeleitet|dauert\s+(?:noch\s+)?an|andauert)\b|\bwir\s+haben\b.{0,80}?\baufgenommen\b|\bwir\s+bestätigen\s+(?:ihnen\s+)?den\s+eingang\b|\bwir\s+bestaetigen\s+(?:ihnen\s+)?den\s+eingang\b/i;

const HANDLUNGSFRIST_TYPEN: ReadonlySet<SemanticDeadlineType> = new Set([
  'payment_due',
  'response_due',
  'document_submission_due',
  'service_due',
  'termination_notice',
]);

/** 02A-2A — Pflichtart aus derselben Regeltabelle wie die Fristen. */
function pflichtArt(satz: string, frist: SemanticDeadline | undefined): SemanticObligation['kind'] {
  if (frist?.actionRequired && HANDLUNGSFRIST_TYPEN.has(frist.type)) {
    return frist.type as SemanticObligation['kind'];
  }
  const regel = FRIST_REGELN.find((r) => r.actionRequired && r.muster.test(satz));
  return regel ? (regel.type as SemanticObligation['kind']) : undefined;
}

/* ------------------------------------------------------------------ */
/* EINGANG-02A-2C — angeforderte Unterlagen                            */
/* ------------------------------------------------------------------ */

/** „- Rechnung", „• Fotos", „1. Kostenvoranschlag", „2) Nachweis". */
const LISTENPUNKT = /^\s*(?:[-–•*]|\d{1,2}[.)])\s+(.+?)\s*$/;
/** Die Einleitungszeile muss nach Unterlagen fragen — nicht jede Aufzählung ist eine Anforderung. */
const UNTERLAGEN_KONTEXT =
  /(einreich|reichen\s+sie\b.*\bein\b|vorleg|übersend|uebersend|zusend|\bsenden\b|\bschicken\b|benötig|benoetig|unterlagen|nachweis|dokumente|belege)/i;
/** Beträge, Daten, Kontaktangaben sind keine Unterlagen. */
const KEINE_UNTERLAGE = /(\d+,\d{2}|\beur\b|€|\d{1,2}\.\d{1,2}\.\d{2,4}|@|straße|strasse|\bstr\.|\btel\b|telefon)/i;
/** Fürwörter und Satzglieder verraten einen Nebensatz statt einer Unterlage. */
const KEIN_LISTENEINTRAG = /\b(sie|uns|wir|ihnen|ob|dass|wenn|bitte)\b/i;
/** „Bitte senden Sie uns Rechnung, Fotos und Reparaturbericht." */
const INLINE_UNTERLAGEN =
  /\b(?:übersenden|uebersenden|zusenden|senden|schicken|reichen|benötigen|benoetigen)\s+(?:sie\s+)?(?:uns\s+)?(?:bitte\s+)?(?:noch\s+)?(?:(?:bis|spätestens|spaetestens)\s+(?:zum\s+|am\s+)?\d{1,2}\.\d{1,2}\.\d{2,4}\s+)?(?:folgende\s+)?(.+?)(?:\s+(?:bis|spätestens|spaetestens|innerhalb|binnen|unverzüglich|unverzueglich|umgehend|zurück|zurueck|ein)\b.*)?[.!]?$/i;

function unterlagenEintrag(roh: string): string | undefined {
  const label = roh.replace(/[.;,]+$/, '').replace(/\s+/g, ' ').trim();
  if (label.length < 2 || label.length > 60 || KEINE_UNTERLAGE.test(label)) return undefined;
  return label;
}

interface UnterlagenListe {
  /** Die zusammengefasste Pflichtzeile, normalisiert wie die Sätze. */
  satz: string;
  labels: string[];
}

/**
 * Eine Einleitungszeile mit Doppelpunkt und Unterlagenkontext, gefolgt von
 * Listenpunkten, wird zu einer Pflichtzeile („Wir benötigen: Kostenvoranschlag,
 * Fotos, Versicherungsnachweis."). Ist auch nur ein Punkt keine Unterlage
 * (Betrag, Datum, Adresse), bleibt der Block unverändert — fail-safe.
 */
function fasseUnterlagenListenZusammen(text: string): { text: string; listen: UnterlagenListe[] } {
  const zeilen = text.replace(/\r\n/g, '\n').split('\n');
  const aus: string[] = [];
  const listen: UnterlagenListe[] = [];
  for (let i = 0; i < zeilen.length; i += 1) {
    const zeile = zeilen[i];
    if (/:\s*$/.test(zeile) && UNTERLAGEN_KONTEXT.test(zeile)) {
      const punkte: string[] = [];
      let j = i + 1;
      while (j < zeilen.length && LISTENPUNKT.test(zeilen[j])) {
        punkte.push(LISTENPUNKT.exec(zeilen[j])![1]);
        j += 1;
      }
      const labels = punkte.map(unterlagenEintrag);
      if (punkte.length > 0 && labels.every((l): l is string => Boolean(l))) {
        const satz = `${zeile.trim().replace(/:\s*$/, '')}: ${(labels as string[]).join(', ')}.`;
        aus.push(satz);
        listen.push({ satz: satz.replace(/\s+/g, ' ').trim(), labels: labels as string[] });
        i = j - 1;
        continue;
      }
    }
    aus.push(zeile);
  }
  return { text: aus.join('\n'), listen };
}

/** Inline-Aufzählung in einer Einreichpflicht — erst ab zwei Unterlagen eine Liste. */
function inlineUnterlagen(satz: string): string[] {
  const treffer = INLINE_UNTERLAGEN.exec(satz)?.[1];
  if (!treffer || treffer.includes(':')) return [];
  const teile = treffer.split(/\s*,\s*|\s+und\s+|\s+sowie\s+/).map((t) => t.trim()).filter(Boolean);
  if (teile.length < 2) return [];
  const labels = teile.map((t) => (KEIN_LISTENEINTRAG.test(t) || t.split(/\s+/).length > 4 ? undefined : unterlagenEintrag(t)));
  return labels.every((l): l is string => Boolean(l)) ? (labels as string[]) : [];
}

/**
 * Pflichten stehen im Fliesstext, nicht in Feldern. Gelesen wird satzweise:
 * Wer wird angesprochen, was soll geschehen, bis wann.
 */
function lesePflichten(
  rohtext: string,
  fristen: SemanticDeadline[],
): { obligations: SemanticObligation[]; requestedDocuments: SemanticRequestedDocument[] } {
  const ergebnis: SemanticObligation[] = [];
  const unterlagen: SemanticRequestedDocument[] = [];
  const { text, listen } = fasseUnterlagenListenZusammen(rohtext);
  const saetze = text
    .replace(/\r\n/g, '\n')
    /*
     * Dieselbe Regel wie bei den Satzgrenzen (`istEchtesSatzende`): nicht an
     * Datumspunkten trennen — nach einer Zahl nur, wenn ein neuer Satz mit
     * Großbuchstaben beginnt (02A-2A: „… am 01.09.2026. Bitte …").
     */
    .split(/(?<=[a-zäöüß)][.!?])\s+|(?<=\d[.!?])\s+(?=[A-ZÄÖÜ])|\n/)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    /* EINGANG-02C — zwei Aufforderungen in einem Satz sind zwei Pflichten. */
    .flatMap((s) => splitClauses(s))
    .filter((s) => s.length > 15);

  for (const satz of saetze) {
    if (istVerneinteHandlung(satz)) continue;
    const fristenImSatz = findeDaten(satz)
      .map((d) => fristen.find((f) => f.date === d.iso))
      .filter((f): f is SemanticDeadline => Boolean(f));
    const anUns =
      PFLICHT_AN_UNS.test(satz) ||
      PFLICHT_AN_UNS_SIE_FORM.test(satz) ||
      (PFLICHT_FAELLIG.test(satz) && fristenImSatz.some((f) => f.actionRequired));
    const anAndere = !anUns && PFLICHT_AN_ANDERE.test(satz);
    if (!anUns && !anAndere) continue;

    /*
     * 02A-2A — das Pflichtdatum ist die Handlungsfrist im Satz, nicht das
     * erste Datum: „Zu Ihrem Schaden vom 01.09.2026 reichen Sie bitte … bis
     * zum 20.10.2026 ein" → 20.10. Ohne Handlungsfrist bleibt es beim
     * bisherigen Verhalten.
     */
    const passendeFrist = fristenImSatz.find((f) => f.actionRequired) ?? fristenImSatz[0];
    const kind = anUns ? pflichtArt(satz, passendeFrist) : undefined;
    /*
     * 02A-2B — eine relative Frist gilt nur für eine eigene Pflicht ohne
     * absolutes Handlungsdatum und bleibt im Wortlaut; es wird nichts gerechnet.
     */
    const relativeDeadline =
      anUns && !passendeFrist?.actionRequired ? RELATIVE_FRIST.exec(satz)?.[0].replace(/\s+/g, ' ').trim() : undefined;

    /* 02A-2C — die Unterlagen einer eigenen Einreichpflicht, im Wortlaut. */
    if (anUns && kind === 'document_submission_due') {
      const labels = listen.find((l) => l.satz === satz)?.labels ?? inlineUnterlagen(satz);
      for (const label of labels) {
        unterlagen.push({ label, obligationIndex: ergebnis.length, evidence: { snippet: ausschnitt(satz) } });
      }
    }

    ergebnis.push({
      who: anUns ? 'own_company' : 'counterparty',
      what: ausschnitt(satz, 180),
      byWhen: passendeFrist?.date,
      ...(kind ? { kind } : {}),
      ...(relativeDeadline ? { relativeDeadline } : {}),
      certainty: 'detected',
      evidence: { snippet: ausschnitt(satz) },
    });
    if (ergebnis.length >= 8) break;
  }

  return { obligations: ergebnis, requestedDocuments: unterlagen };
}

/* ------------------------------------------------------------------ */
/* Beträge                                                             */
/* ------------------------------------------------------------------ */

const BETRAG = /(-?\d{1,3}(?:\.\d{3})*(?:,\d{2})|-?\d+,\d{2})\s*(?:EUR|€)/gi;

interface BetragsRegel {
  muster: RegExp;
  role: SemanticAmountRole;
  claim: boolean;
}

/**
 * Auch hier: Bedeutung, nicht Dokumentart. Entscheidend ist `claim` — ob der
 * Betrag eine Forderung **an uns** ist. Ein Einbehalt des Kunden und ein
 * Nettoteilbetrag sind es nicht, und ohne dieses Merkmal entsteht später keine
 * Buchung.
 */
const BETRAGS_REGELN: BetragsRegel[] = [
  { muster: /(behalten|einbehalt|zurückbehalt|zurueckbehalt|sicherheitseinbehalt)/i, role: 'retention', claim: false },
  { muster: /(gutschrift|erstattung|rückvergütung|rueckverguetung|verrechnet)/i, role: 'credit_amount', claim: false },
  { muster: /(mahngebühr|mahngebuehr|gebühr|gebuehr|säumnis|saeumnis|verzugs)/i, role: 'fee', claim: true },
  { muster: /(insgesamt|gesamtforderung|gesamtbetrag|zusammen)/i, role: 'total_claim', claim: true },
  { muster: /(umsatzsteuer|mehrwertsteuer|ust\.?|mwst)/i, role: 'tax_amount', claim: false },
  { muster: /(nettobetrag|netto)/i, role: 'net_amount', claim: false },
  { muster: /(rechnungsbetrag|bruttobetrag|endbetrag|rechnungssumme|zahlbetrag)/i, role: 'invoice_total', claim: true },
  { muster: /(offener betrag|offenstehend|rückstand|rueckstand|noch offen)/i, role: 'outstanding_amount', claim: true },
  { muster: /^\s*(pos|position)\b/i, role: 'line_item', claim: false },
];

/**
 * Von mehreren passenden Regeln gewinnt die, deren Wort dem Betrag am
 * **nächsten** steht — nicht die, die in der Liste oben steht.
 *
 * „…Mahngebuehren von 5,00 EUR, insgesamt also 4.291,50 EUR": Für den zweiten
 * Betrag steht „insgesamt" unmittelbar davor, „Mahngebuehren" weit davor. Ohne
 * diese Regel trügen beide die Rolle „Gebühr", und die Gesamtforderung ginge
 * gegen fünf Euro verloren.
 */
function naechsteRegel(kontext: string): BetragsRegel | undefined {
  let beste: BetragsRegel | undefined;
  let besterAbstand = Number.POSITIVE_INFINITY;

  for (const regel of BETRAGS_REGELN) {
    const suche = new RegExp(regel.muster.source, `${regel.muster.flags.replace('g', '')}g`);
    let letzte = -1;
    let treffer: RegExpExecArray | null;
    while ((treffer = suche.exec(kontext)) !== null) {
      letzte = treffer.index;
      if (treffer.index === suche.lastIndex) suche.lastIndex += 1;
    }
    if (letzte === -1) continue;

    const abstand = kontext.length - letzte;
    if (abstand < besterAbstand) {
      besterAbstand = abstand;
      beste = regel;
    }
  }
  return beste;
}

/* EINGANG-02C — „… 2.000,00 EUR ein", „… einbehalten": der Betrag des Einbehalts. */
const EINBEHALT_DANACH = /^[^.;]{0,25}?\b(?:ein|einbehalten|zurückbehalten|zurueckbehalten)\b/i;
/* EINGANG-02C — „Ihre Rechnung RE-100 über …": ein zitierter Rechnungsbetrag, keine Forderung an uns. */
const ZITIERTE_RECHNUNG = /\brechnung\b[^.\n]{0,40}\s(?:über|ueber)\s*$/i;
const RECHNUNGSBETRAG_ZITIERT: BetragsRegel = { muster: /$^/, role: 'invoice_total', claim: false };

function leseBetraege(text: string): SemanticAmount[] {
  const ergebnis: SemanticAmount[] = [];
  BETRAG.lastIndex = 0;
  let m: RegExpExecArray | null;

  while ((m = BETRAG.exec(text)) !== null) {
    const roh = m[1];
    const wert = Number(roh.replace(/\./g, '').replace(',', '.'));
    if (!Number.isFinite(wert)) continue;

    const satz = satzUm(text, m.index);
    /*
     * Die Rolle steht unmittelbar vor dem Betrag — „insgesamt also 4.291,50 EUR".
     * Der ganze Satz taugt dafür nicht: In „zuzueglich Mahngebuehren von 5,00 EUR,
     * insgesamt also 4.291,50 EUR" trügen sonst beide Beträge dieselbe Rolle, und
     * die Gesamtforderung ginge gegen die Mahngebühr verloren.
     */
    const zeilenAnfang = text.lastIndexOf('\n', Math.max(0, m.index - 1)) + 1;
    const naheUmgebung = text.slice(Math.max(zeilenAnfang, m.index - 60), m.index);
    const nahRegel = naechsteRegel(naheUmgebung);
    let regel = nahRegel ?? naechsteRegel(satz);
    /*
     * EINGANG-02C — ein Einbehalt gehört nur zu seinem eigenen Betrag. In „Von
     * Ihrer Rechnung RE-100 über 10.000,00 EUR behalten wir 2.000,00 EUR ein"
     * ist 10.000,00 EUR der zitierte Rechnungsbetrag, nicht der Einbehalt.
     */
    if (!nahRegel && regel?.role === 'retention') {
      const danach = text.slice(m.index + m[0].length, m.index + m[0].length + 30);
      if (!EINBEHALT_DANACH.test(danach)) regel = ZITIERTE_RECHNUNG.test(naheUmgebung) ? RECHNUNGSBETRAG_ZITIERT : undefined;
    }

    /*
     * Ein negativer Betrag ist nie eine Forderung an uns — er zeigt in die
     * andere Richtung. Gutschriften kommen so ohne eigene Dokumentart aus.
     */
    const negativ = wert < 0 || /^-/.test(roh);

    ergebnis.push({
      value: Math.abs(wert),
      currency: 'EUR',
      /*
       * WEISS-Nacharbeit — auf einer Gutschrift sind „Nettobetrag -240,00" und
       * „Umsatzsteuer -45,60" Netto und Steuer, keine eigenen Gutschriften;
       * sonst stünden drei „Gutschriften zu Ihren Gunsten" nebeneinander.
       */
      role: negativ
        ? regel?.role === 'net_amount' || regel?.role === 'tax_amount'
          ? regel.role
          : 'credit_amount'
        : (regel?.role ?? 'other'),
      isClaimAgainstUs: negativ ? false : (regel?.claim ?? false),
      certainty: regel ? 'detected' : 'uncertain',
      evidence: { snippet: ausschnitt(satz) },
    });
    if (ergebnis.length >= 12) break;
  }

  return ergebnis;
}

/* ------------------------------------------------------------------ */
/* Empfängerprüfung                                                    */
/* ------------------------------------------------------------------ */

function normalisiere(wert: string): string {
  return wert
    .toLowerCase()
    .replace(/[^a-zäöüß0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** EINGANG-02C — steht der eigene Betrieb als erste Zeile (Briefkopf) über dem Schreiben? */
function traegtEigenenBriefkopf(text: string, eigeneFirma: string | undefined): boolean {
  const eigen = normalisiere(eigeneFirma ?? '');
  if (eigen.length < 4) return false;
  const kopf = normalisiere(zeilen(text)[0] ?? '');
  return kopf === eigen || kopf.startsWith(`${eigen} `);
}

function pruefeEmpfaenger(text: string, profil: CompanyProfile | null): SemanticRecipientCheck {
  if (!profil) return { addressedToOwnCompany: 'unknown', matchedOn: [], certainty: 'uncertain' };

  const heuhaufen = normalisiere(text);
  const treffer: string[] = [];

  const name = profil.companyName?.trim();
  if (name) {
    /* Der Rechtsformzusatz variiert; der Kern des Namens trägt die Erkennung. */
    const kern = normalisiere(name.replace(/\b(gmbh|ug|ag|kg|ohg|e\.?k\.?|gbr|mbh|co)\b/gi, ''));
    if (kern.length >= 4 && heuhaufen.includes(kern)) treffer.push(name);
  }
  if (profil.street?.trim() && heuhaufen.includes(normalisiere(profil.street))) treffer.push(profil.street);
  if (profil.zip?.trim() && heuhaufen.includes(normalisiere(profil.zip))) treffer.push(profil.zip);
  if (profil.taxNumber?.trim() && heuhaufen.includes(normalisiere(profil.taxNumber))) {
    treffer.push(profil.taxNumber);
  }

  if (treffer.length >= 2) {
    return { addressedToOwnCompany: 'yes', matchedOn: treffer, certainty: 'confirmed_by_existing_state' };
  }
  if (treffer.length === 1) {
    return { addressedToOwnCompany: 'yes', matchedOn: treffer, certainty: 'detected' };
  }
  return { addressedToOwnCompany: 'unknown', matchedOn: [], certainty: 'uncertain' };
}

/* ------------------------------------------------------------------ */
/* Anliegen                                                           */
/* ------------------------------------------------------------------ */

/**
 * Das Anliegen in einem Satz — zusammengesetzt aus dem, was wirklich gelesen
 * wurde. Kein Textbaustein, der Bedeutung vortäuscht: Ohne Betreff und ohne
 * Pflicht bleibt es leer.
 */
function baueAnliegen(
  betreff: SemanticValue<string> | undefined,
  pflichten: SemanticObligation[],
  fristen: SemanticDeadline[],
): SemanticValue<string> | undefined {
  const eigene = pflichten.filter((p) => p.who === 'own_company');
  const handlungsfristen = fristen.filter((f) => f.actionRequired);

  if (!betreff && eigene.length === 0) return undefined;

  const teile: string[] = [];
  if (betreff) teile.push(betreff.value);
  if (eigene.length === 1) teile.push('Eine Handlung wird verlangt.');
  else if (eigene.length > 1) teile.push(`${eigene.length} Handlungen werden verlangt.`);
  if (handlungsfristen.length === 1) {
    /* In der gewohnten Schreibweise — das Anliegen wird gelesen, nicht gerechnet. */
    const iso = handlungsfristen[0].date;
    const t = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
    teile.push(`Frist: ${t ? `${t[3]}.${t[2]}.${t[1]}` : iso}.`);
  }
  else if (handlungsfristen.length > 1) {
    teile.push(`${handlungsfristen.length} Fristen zu beachten.`);
  }

  return {
    value: teile.join(' '),
    certainty: betreff ? betreff.certainty : 'detected',
    evidence: betreff?.evidence,
  };
}

/* ------------------------------------------------------------------ */
/* Buchführungsrelevanz                                                */
/* ------------------------------------------------------------------ */

const BELEG_HINWEIS = /(rechnung\s*(nr|nummer|-nr)|rechnungsbetrag|rechnungsnummer|zahlbar bis|zahlungsziel|leistungszeitraum|umsatzsteuer|ust-?idnr)/i;
const VERWEIS_HINWEIS =
  /(mahnung|zahlungserinnerung|erinnern|erneut|bereits|trotz unserer|mahngebühr|mahngebuehr|zur rechnung\s|offene rechnung|rückstand|rueckstand)/i;
const KEINE_ZAHLUNG = /(eine zahlung .{0,30}(ist|wird) nicht|keine zahlung|nicht zu leisten|zahlung ist nicht)/i;

/**
 * Die bedeutungsbasierte Einschätzung — das Herz der Buchungsschranke.
 *
 * Sie fragt nie, welche Dokumentart vorliegt, sondern nur, was der Text sagt:
 * Verweist er auf einen bestehenden Beleg? Fordert er überhaupt Geld von uns?
 * Steht sogar ausdrücklich da, dass nichts zu zahlen ist?
 */
function schaetzeBuchung(
  text: string,
  betraege: SemanticAmount[],
): DocumentSemanticCore['accounting'] {
  const gruende: string[] = [];

  if (KEINE_ZAHLUNG.test(text)) {
    gruende.push('Im Schreiben steht ausdrücklich, dass keine Zahlung zu leisten ist.');
    return { relevance: 'none', reasons: gruende, certainty: 'detected' };
  }

  const forderungen = betraege.filter((b) => b.isClaimAgainstUs);

  if (VERWEIS_HINWEIS.test(text)) {
    gruende.push('Das Schreiben verweist auf einen bereits vorhandenen Beleg.');
    gruende.push('Eine neue Ausgabe würde die Verbindlichkeit ein zweites Mal anlegen.');
    return { relevance: 'reference_only', reasons: gruende, certainty: 'detected' };
  }

  if (forderungen.length === 0) {
    if (betraege.length > 0) {
      gruende.push('Es kommen Beträge vor, aber keiner davon ist eine Forderung an den eigenen Betrieb.');
    } else {
      gruende.push('Im Schreiben kommt kein Betrag vor.');
    }
    return { relevance: 'none', reasons: gruende, certainty: betraege.length > 0 ? 'detected' : 'uncertain' };
  }

  if (BELEG_HINWEIS.test(text)) {
    gruende.push('Das Schreiben trägt die Merkmale eines eigenständigen Belegs.');
    gruende.push('Eine Buchung darf vorgeschlagen werden — bestätigt werden muss sie trotzdem.');
    return { relevance: 'booking_candidate', reasons: gruende, certainty: 'detected' };
  }

  gruende.push('Es wird Geld gefordert, aber die Belegmerkmale einer Rechnung fehlen.');
  gruende.push('Vor einer Buchung ist zu klären, worauf sich die Forderung bezieht.');
  return { relevance: 'reference_only', reasons: gruende, certainty: 'uncertain' };
}

/* ------------------------------------------------------------------ */
/* Zusammenbau                                                         */
/* ------------------------------------------------------------------ */

export interface SemanticCoreInput {
  text: string;
  companyProfile: CompanyProfile | null;
}

/**
 * Baut den semantischen Kern. Die Dokumentart wird bewusst **nicht**
 * übergeben — nichts hier darf davon abhängen, ob die Klassifikation getroffen
 * hat.
 */
export function buildDocumentSemanticCore(input: SemanticCoreInput): DocumentSemanticCore {
  const text = input.text ?? '';
  if (!text.trim()) return emptyDocumentSemanticCore();

  const subject = findeBetreff(text);
  const deadlines = leseFristen(text);
  const pflichtLesung = lesePflichten(text, deadlines);
  const obligations = pflichtLesung.obligations;
  let requestedDocuments = pflichtLesung.requestedDocuments;
  /*
   * EINGANG-02B — Mahnungs-Semantik. Beim gerichtlichen Mahnbescheid ist die
   * Widerspruchsfrist („innerhalb von zwei Wochen nach Zustellung") die
   * eigentliche Reaktionsfrist: Sie bleibt als eigene Antwortpflicht mit
   * relativer Frist im Wortlaut erhalten — nie als Datum, nie als Zahlung.
   */
  const dunning = readDunningSemantics(text);
  if (dunning?.stage === 'court_dunning') {
    for (const satz of text.replace(/\r\n/g, '\n').split(/(?<=[a-zäöüß)][.!?])\s+|\n/)) {
      if (!/widerspruch/i.test(satz)) continue;
      const phrase = RELATIVE_FRIST.exec(satz)?.[0].replace(/\s+/g, ' ').trim();
      if (!phrase || obligations.some((p) => p.relativeDeadline === phrase)) continue;
      obligations.push({
        who: 'own_company',
        what: ausschnitt(satz, 180),
        kind: 'response_due',
        relativeDeadline: phrase,
        certainty: 'detected',
        evidence: { snippet: ausschnitt(satz) },
      });
    }
  }
  const amounts = leseBetraege(text);
  /*
   * EINGANG-02C — Beschwerde, Reklamation, Mängelanzeige. Trägt das Schreiben
   * den eigenen Briefkopf, ist es ein eigenes Schreiben: Seine Aufforderungen,
   * Fristen und Beträge richten sich an den Empfänger, nicht an uns.
   */
  const eigeneFirma = input.companyProfile?.companyName ?? getCompanyProfileStoreSnapshot()?.companyName;
  /*
   * Nacharbeit 1 — ein Behörden- oder Versicherungsschreiben (02A-1) ist keine
   * Beschwerde gegen uns, auch wenn es „Beanstandung" oder „Ihre Beschwerde"
   * im Titel trägt; es behält seine institutionelle Lesart.
   */
  const complaint = hasInstitutionalPrecedence(text, { ownCompanyName: eigeneFirma })
    ? undefined
    : readComplaintSemantics(text, { ownLetterhead: traegtEigenenBriefkopf(text, eigeneFirma) });
  if (complaint?.direction === 'outgoing') {
    obligations.forEach((pflicht, index) => {
      if (pflicht.who === 'own_company') obligations[index] = { ...pflicht, who: 'counterparty' };
    });
    for (const frist of deadlines) frist.actionRequired = false;
    amounts.forEach((betrag, index) => {
      amounts[index] = {
        ...betrag,
        isClaimAgainstUs: false,
        ...(betrag.role === 'credit_amount' ? { role: 'other' as const } : {}),
      };
    });
    requestedDocuments = [];
  }
  const recipientCheck = pruefeEmpfaenger(text, input.companyProfile);
  const accounting = schaetzeBuchung(text, amounts);
  const purpose = baueAnliegen(subject, obligations, deadlines);

  /*
   * Die primäre Handlungsfrist: die früheste, bei der der eigene Betrieb
   * tatsächlich handeln muss. Sie speist das bestehende einzelne
   * `InboxItem.deadline`, ohne die übrigen Fristen zu verlieren.
   */
  const primaryActionDeadline = deadlines
    .filter((f) => f.actionRequired)
    .sort((a, b) => a.date.localeCompare(b.date))[0];

  /*
   * DOKUMENT-FACHWISSEN-01I1 — die Bescheinigungsart.
   *
   * Steht hier, weil sie zur Bedeutung des Dokuments gehört und nicht zur
   * Klassifikation: Ob ein Papier eine Freistellungsbescheinigung oder eine
   * USt 1 TG ist, entscheidet sein Inhalt, nicht der Ablageordner. Wie alles
   * in diesem Kern hängt sie an keinem `ClassifiedDocumentKind`.
   */
  const certificate = recognizeCertificate(text);

  /* EINGANG-02A-2B — relative Fristen eigener Pflichten, im Wortlaut. */
  const relativeDeadlines: SemanticRelativeDeadline[] = obligations
    .filter((p) => p.who === 'own_company' && p.relativeDeadline)
    .map((p) => ({
      phrase: p.relativeDeadline!,
      appliesTo: (p.kind && RELATIVE_FRIST_GILT_FUER[p.kind]) || 'Handlung',
      ...(p.kind ? { kind: p.kind } : {}),
      certainty: 'uncertain' as const,
      ...(p.evidence ? { evidence: p.evidence } : {}),
    }));

  /*
   * EINGANG-02A-2B — reine Information nur bei ausdrücklichem Hinweis und
   * ohne jede Handlung: keine eigene Pflicht, keine Handlungsfrist, keine
   * relative Frist, keine Forderung an uns.
   */
  const informationsTreffer =
    !obligations.some((p) => p.who === 'own_company') &&
    !deadlines.some((f) => f.actionRequired) &&
    relativeDeadlines.length === 0 &&
    !amounts.some((b) => b.isClaimAgainstUs)
      ? INFORMATIONS_HINWEIS.exec(text)
      : null;
  const informationOnly = informationsTreffer
    ? { evidence: { snippet: ausschnitt(satzUm(text, informationsTreffer.index)) } }
    : undefined;

  return {
    readOnly: true,
    ...(certificate ? { certificate } : {}),
    ...(relativeDeadlines.length > 0 ? { relativeDeadlines } : {}),
    ...(informationOnly ? { informationOnly } : {}),
    ...(requestedDocuments.length > 0 ? { requestedDocuments } : {}),
    ...(dunning ? { dunning } : {}),
    ...(complaint ? { complaint } : {}),
    subject,
    purpose,
    deadlines,
    obligations,
    amounts,
    recipientCheck,
    customerCandidates: [],
    vorgangCandidates: [],
    accounting,
    primaryActionDeadline,
  };
}

/** Der maßgebliche Betrag, falls es einen gibt — nie einfach der erste im Text. */
export function resolvePrimaryClaimAmount(core: DocumentSemanticCore): SemanticAmount | undefined {
  const forderungen = core.amounts.filter((b) => b.isClaimAgainstUs);
  if (forderungen.length === 0) return undefined;
  const rangfolge: SemanticAmountRole[] = ['total_claim', 'outstanding_amount', 'invoice_total', 'fee'];
  for (const rolle of rangfolge) {
    const treffer = forderungen.find((b) => b.role === rolle);
    if (treffer) return treffer;
  }
  return forderungen.reduce((groesster, b) => (b.value > groesster.value ? b : groesster));
}

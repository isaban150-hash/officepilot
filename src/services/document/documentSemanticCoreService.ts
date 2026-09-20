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
  SemanticValue,
} from '../../types/documentSemanticCore';
import { emptyDocumentSemanticCore } from '../../types/documentSemanticCore';
import { recognizeCertificate } from './documentCertificateRecognition';
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
    muster: /(überweis|ueberweis|zahl(en|ung|bar)|begleich|zahlungsziel|zahlbar bis|ohne abzug)/i,
    type: 'payment_due',
    actionRequired: true,
    appliesTo: 'Zahlung',
  },
  {
    muster: /(bestätigen|bestaetigen|antwort|rückmeldung|rueckmeldung|stellungnahme|mitteilen|melden sie)/i,
    type: 'response_due',
    actionRequired: true,
    appliesTo: 'Antwort',
  },
  {
    muster: /(einreichen|vorlegen|übersenden|uebersenden|zusenden|zurücksenden|zuruecksenden|nachweis|unterlagen)/i,
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

/**
 * Das Briefdatum steht im Kopf und ist keine Frist. Es wird an seiner Stellung
 * erkannt — frühe Fundstelle, typischerweise nach einem Ortsnamen.
 */
function istBriefdatum(text: string, treffer: DatumsTreffer): boolean {
  const davor = text.slice(Math.max(0, treffer.index - 40), treffer.index);
  if (/[A-Za-zÄÖÜäöüß]{3,},\s*$/.test(davor)) return true;
  return treffer.index < Math.min(320, text.length * 0.2) && !/\bbis\b|frist|fällig|faellig/i.test(davor);
}

function leseFristen(text: string): SemanticDeadline[] {
  const gefunden: SemanticDeadline[] = [];
  const gesehen = new Set<string>();

  for (const treffer of findeDaten(text)) {
    const satz = satzUm(text, treffer.index);
    const davor = text.slice(Math.max(0, treffer.index - 30), treffer.index);
    const hatFristMarker = FRIST_MARKER.test(davor);

    let type: SemanticDeadlineType = 'informational';
    let actionRequired = false;
    let appliesTo = 'Hinweis';

    const regel = FRIST_REGELN.find((r) => r.muster.test(satz));
    if (regel) {
      type = regel.type;
      appliesTo = regel.appliesTo;
      actionRequired = regel.actionRequired && hatFristMarker;
      /*
       * Ein Gültigkeitsende bleibt immer handlungsfrei — auch wenn im selben
       * Satz „bis zum" steht. Genau dieser Satz machte aus dem 31.08.2029 einer
       * Freistellungsbescheinigung eine vermeintliche Handlungsfrist.
       */
      if (type === 'validity_period_end') actionRequired = false;
    } else if (hatFristMarker) {
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
const PFLICHT_AN_ANDERE = /(wir werden|wir behalten uns vor|wir verrechnen|wir erstatten|behalten wir)/i;

/**
 * Pflichten stehen im Fliesstext, nicht in Feldern. Gelesen wird satzweise:
 * Wer wird angesprochen, was soll geschehen, bis wann.
 */
function lesePflichten(text: string, fristen: SemanticDeadline[]): SemanticObligation[] {
  const ergebnis: SemanticObligation[] = [];
  const saetze = text
    .replace(/\r\n/g, '\n')
    /* Dieselbe Regel wie bei den Satzgrenzen: nicht an Datumspunkten trennen. */
    .split(/(?<=[a-zäöüß)][.!?])\s+|\n/)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter((s) => s.length > 15);

  for (const satz of saetze) {
    const anUns = PFLICHT_AN_UNS.test(satz);
    const anAndere = !anUns && PFLICHT_AN_ANDERE.test(satz);
    if (!anUns && !anAndere) continue;

    const datenImSatz = findeDaten(satz);
    const passendeFrist = datenImSatz
      .map((d) => fristen.find((f) => f.date === d.iso))
      .find((f): f is SemanticDeadline => Boolean(f));

    ergebnis.push({
      who: anUns ? 'own_company' : 'counterparty',
      what: ausschnitt(satz, 180),
      byWhen: passendeFrist?.date,
      certainty: 'detected',
      evidence: { snippet: ausschnitt(satz) },
    });
    if (ergebnis.length >= 8) break;
  }

  return ergebnis;
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
    const regel = naechsteRegel(naheUmgebung) ?? naechsteRegel(satz);

    /*
     * Ein negativer Betrag ist nie eine Forderung an uns — er zeigt in die
     * andere Richtung. Gutschriften kommen so ohne eigene Dokumentart aus.
     */
    const negativ = wert < 0 || /^-/.test(roh);

    ergebnis.push({
      value: Math.abs(wert),
      currency: 'EUR',
      role: negativ ? 'credit_amount' : (regel?.role ?? 'other'),
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
  const obligations = lesePflichten(text, deadlines);
  const amounts = leseBetraege(text);
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

  return {
    readOnly: true,
    ...(certificate ? { certificate } : {}),
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

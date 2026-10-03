/**
 * EINGANG-02C — was eine Beschwerde, Reklamation oder Mängelanzeige im
 * Wortlaut sagt.
 *
 * Rein deterministisch und nur lesend: der sichere Titel, was der Absender
 * meldet, was er fordert oder ankündigt, und welche Bezüge er nennt. Alles
 * bleibt eine Angabe des Absenders — keine Bewertung, ob ein Mangel besteht
 * oder eine Forderung berechtigt ist. Fristen, Pflichten und Beträge liest
 * weiter der semantische Kern; hier wird nur zugeordnet.
 */
import type {
  SemanticComplaint,
  SemanticComplaintDemand,
  SemanticComplaintDemandKind,
  SemanticComplaintEscalation,
  SemanticComplaintType,
} from '../../types/documentSemanticCore';

/* ------------------------------------------------------------------ */
/* Titel                                                               */
/* ------------------------------------------------------------------ */

const TITEL_WOERTER: Array<[SemanticComplaintType, string]> = [
  ['defect_claim', String.raw`m(?:ä|ae)ngelr(?:ü|ue)ge|mangelr(?:ü|ue)ge`],
  ['defect_notice', String.raw`m(?:ä|ae)ngelanzeige|mangelanzeige`],
  [
    'remedy_request',
    String.raw`aufforderung\s+zur\s+(?:nachbesserung|nacherf(?:ü|ue)llung|m(?:ä|ae)ngelbeseitigung|mangelbeseitigung)|nachbesserungsaufforderung|(?:letzte\s+)?frist(?:setzung)?\s+zur\s+(?:m(?:ä|ae)ngel|mangel)beseitigung`,
  ],
  ['damage_claim', String.raw`schadens?ersatzforderung`],
  ['reclamation', String.raw`reklamation`],
  ['objection', String.raw`beanstandung`],
  ['complaint', String.raw`beschwerde`],
];

/*
 * Ein Titel ist eine eigene kurze Zeile im Kopf, die mit dem Beschwerdewort
 * beginnt — höchstens nach einem Bezug mit Gedankenstrich („Auftrag AU-… –
 * Mängelanzeige") oder nach „Betreff:". Ein Wort im Fliesstext oder in einer
 * Rechnungsposition („Pos 1 Beseitigung Beschwerde Nachbar …") ist kein Titel.
 */
const TITEL_PRAEFIX = String.raw`(?:(?:betreff|betr\.?)\s*:\s*|[^\n]{1,50}?\s[-–]\s+)?`;
const TITEL_ENDE = String.raw`(?=$|[\s:–-])`;
const TITEL_REGELN = TITEL_WOERTER.map(
  ([type, wort]) => [type, new RegExp(String.raw`^${TITEL_PRAEFIX}(?:${wort})${TITEL_ENDE}`, 'i')] as const,
);
const ANREDE = /^(sehr geehrte|sehr geehrter|guten tag|liebe|hallo)/i;

function kopfZeilen(text: string): string[] {
  const zeilen = text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((zeile) => zeile.trim())
    .filter(Boolean)
    .slice(0, 15);
  const anrede = zeilen.findIndex((zeile) => ANREDE.test(zeile));
  return anrede >= 0 ? zeilen.slice(0, anrede) : zeilen;
}

/** Der sichere Beschwerdetitel im Kopf — oder `undefined`. */
export function detectComplaintTitle(text: string): { type: SemanticComplaintType; line: string } | undefined {
  for (const zeile of kopfZeilen(text)) {
    if (zeile.length > 90 || /[.!?]$/.test(zeile)) continue;
    const regel = TITEL_REGELN.find(([, muster]) => muster.test(zeile));
    if (regel) return { type: regel[0], line: zeile };
  }
  return undefined;
}

export function hasComplaintTitle(text: string): boolean {
  return detectComplaintTitle(text) !== undefined;
}

/* ------------------------------------------------------------------ */
/* Sätze und Teilsätze                                                 */
/* ------------------------------------------------------------------ */

/*
 * „Bitte nehmen Sie bis zum 15.10. Stellung und beseitigen Sie den Mangel bis
 * zum 31.10." sind zwei Aufforderungen. Getrennt wird nur vor einem neuen
 * „<Verb> Sie" — „Kosten und Fristen" bleiben ein Satzglied.
 */
export const KLAUSEL_TRENNER = /\s+und\s+(?=(?:bitte\s+)?[a-zäöüß]+\s+sie\b)/i;

export function splitClauses(satz: string): string[] {
  return satz.split(KLAUSEL_TRENNER).map((teil) => teil.trim()).filter(Boolean);
}

function saetze(text: string): string[] {
  return text
    .replace(/\r\n/g, '\n')
    .split(/(?<=[a-zäöüß)][.!?])\s+|(?<=\d[.!?])\s+(?=[A-ZÄÖÜ])|\n/)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter((s) => s.length > 8);
}

/* ------------------------------------------------------------------ */
/* Forderungen und Ankündigungen                                       */
/* ------------------------------------------------------------------ */

/** An den Empfänger gerichtet: „Bitte …", „<Verb> Sie", „Wir fordern …". */
const AN_EMPFAENGER =
  /\bbitte\b|\b(?:beseitigen|beheben|nehmen|teilen|senden|schicken|reichen|zahlen|überweisen|ueberweisen|erstatten|bessern|ersetzen)\s+sie\b|\bwir\s+(?:fordern|verlangen|erwarten)\b|\b(?:fordern|verlangen|erwarten)\s+wir\b|\bsie\s+werden\s+aufgefordert\b/i;
const GELD_FORDERUNG = /\b(?:fordern|verlangen|geltend|erwarten)\b/i;
const WIR = /\bwir\b/i;

interface ForderungsRegel {
  kind: SemanticComplaintDemandKind;
  muster: RegExp;
  gilt: (teil: string) => boolean;
}

const FORDERUNGS_REGELN: ForderungsRegel[] = [
  {
    kind: 'remedy',
    muster: /nachbesser|nacherf(?:ü|ue)ll|m(?:ä|ae)ngelbeseitigung|mangelbeseitigung|beseitig|beheben|instandsetz/i,
    gilt: (teil) => AN_EMPFAENGER.test(teil),
  },
  { kind: 'statement', muster: /\bstellung(?:nahme)?\b/i, gilt: (teil) => AN_EMPFAENGER.test(teil) },
  {
    kind: 'documents',
    muster: /\b(?:fotos?|bilder|aufma(?:ß|ss)|protokoll|nachweis\w*|unterlagen|lieferschein\w*|rechnungskopie)\b/i,
    gilt: (teil) =>
      AN_EMPFAENGER.test(teil) && /\b(?:senden|schicken|übersenden|uebersenden|zusenden|reichen|vorlegen)\b/i.test(teil),
  },
  { kind: 'damages', muster: /schadens?ersatz/i, gilt: (teil) => AN_EMPFAENGER.test(teil) || GELD_FORDERUNG.test(teil) },
  {
    kind: 'reimbursement',
    muster: /\berstattung\b|\berstatten\b|\bersatz\s+der\b[^.]{0,30}kosten|\bkosten\b[^.]{0,30}\b(?:ersetzen|erstatten)\b/i,
    gilt: (teil) => AN_EMPFAENGER.test(teil) || GELD_FORDERUNG.test(teil),
  },
  { kind: 'reduction', muster: /\bminder(?:n|ung)\b/i, gilt: (teil) => WIR.test(teil) },
  {
    kind: 'retention',
    muster: /\b(?:behalten|einbehalten|einbehalt|zurückbehalt|zurueckbehalt)\w*/i,
    gilt: (teil) => WIR.test(teil),
  },
  {
    kind: 'payment',
    muster: /\b(?:überweisen|ueberweisen|zahlen|begleichen)\s+sie\b|\bbitte\s+(?:überweisen|ueberweisen|zahlen)\b/i,
    gilt: () => true,
  },
];

const GELD_ARTEN: ReadonlySet<SemanticComplaintDemandKind> = new Set([
  'damages',
  'reimbursement',
  'reduction',
  'retention',
  'payment',
]);

const BETRAG = /(\d{1,3}(?:\.\d{3})*,\d{2}|\d+,\d{2})\s*(?:EUR|€)/gi;
const BIS_DATUM =
  /\bbis\s+(?:zum\s+|spätestens\s+(?:zum\s+)?|spaetestens\s+(?:zum\s+)?)?(\d{1,2})\.(\d{1,2})\.(\d{4})\b/i;

function zahl(roh: string): number {
  return Number(roh.replace(/\./g, '').replace(',', '.'));
}

/*
 * Der Betrag gehört zur Forderung, wenn er ihr folgt („behalten wir … 2.000,00
 * EUR ein", „Schadenersatz in Höhe von 3.000,00 EUR"); sonst der nächste
 * davor („3.000,00 EUR Schadenersatz"). Der Rechnungsbetrag in „Ihrer Rechnung
 * über 10.000,00 EUR behalten wir … 2.000,00 EUR ein" bleibt so Rechnungsbetrag.
 */
function gebundenerBetrag(teil: string, stichwort: number): number | undefined {
  const treffer = [...teil.matchAll(BETRAG)].map((m) => ({ index: m.index ?? 0, wert: zahl(m[1]) }));
  const danach = treffer.find((t) => t.index > stichwort);
  if (danach) return danach.wert;
  const davor = treffer.filter((t) => t.index < stichwort).pop();
  return davor?.wert;
}

function bisDatum(teil: string): string | undefined {
  const m = BIS_DATUM.exec(teil);
  if (!m) return undefined;
  return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
}

function ausschnitt(quelle: string, max = 160): string {
  const t = quelle.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** Was der Absender verlangt oder ankündigt — je Teilsatz, ohne Dubletten. */
export function readComplaintDemands(text: string): SemanticComplaintDemand[] {
  const ergebnis: SemanticComplaintDemand[] = [];
  for (const satz of saetze(text)) {
    for (const teil of splitClauses(satz)) {
      for (const regel of FORDERUNGS_REGELN) {
        const treffer = regel.muster.exec(teil);
        if (!treffer || !regel.gilt(teil)) continue;
        const amount = GELD_ARTEN.has(regel.kind) ? gebundenerBetrag(teil, treffer.index) : undefined;
        const byWhen = bisDatum(teil);
        if (ergebnis.some((d) => d.kind === regel.kind && d.amount === amount && d.byWhen === byWhen)) continue;
        ergebnis.push({
          kind: regel.kind,
          ...(amount !== undefined ? { amount } : {}),
          ...(byWhen ? { byWhen } : {}),
          evidence: { snippet: ausschnitt(teil) },
        });
      }
    }
  }
  return ergebnis.slice(0, 8);
}

/* ------------------------------------------------------------------ */
/* Meldungen, Ankündigungen, Bezüge                                    */
/* ------------------------------------------------------------------ */

const BEANSTANDUNG =
  /(undicht|schlie(?:ß|ss)t\s+nicht|unvollst(?:ä|ae)ndig|nicht\s+eingehalten|falsche[snm]?\s+material|\bzu\s+hoch\b|\bschaden\b|mangelhaft|nicht\s+erschienen|\bm(?:ä|ae)ngel\b|\bmangel\b|defekt|besch(?:ä|ae)digt|wassereintritt|unzufrieden|gesprungen|\briss\b|feucht|schimmel|nicht\s+funktion)/i;
const KEINE_MELDUNG = /^(sehr geehrte|mit freundlichen|anlage)/i;

/** Was der Absender meldet — Sätze ohne Aufforderung, im Wortlaut. */
function readComplaintReports(text: string, titel?: string): Array<{ snippet: string }> {
  const meldungen: Array<{ snippet: string }> = [];
  for (const satz of saetze(text)) {
    if (titel && satz === titel) continue;
    if (KEINE_MELDUNG.test(satz) || !BEANSTANDUNG.test(satz)) continue;
    if (AN_EMPFAENGER.test(satz)) continue;
    if (FORDERUNGS_REGELN.some((regel) => regel.muster.test(satz) && regel.gilt(satz))) continue;
    meldungen.push({ snippet: ausschnitt(satz) });
    if (meldungen.length >= 3) break;
  }
  return meldungen;
}

const ESKALATION: Array<[SemanticComplaintEscalation, RegExp]> = [
  ['substitute_performance', /ersatzvornahme/i],
  ['legal_action', /\b(?:rechts)?anwalt\b|gerichtliche\s+schritte|\bklage\b|\bgerichtlich/i],
];

const BEZUG =
  /\b(auftrag(?:snummer)?|rechnung(?:snummer)?|vorgang|angebot(?:snummer)?)\s*(?:nr\.?\s*)?[:#]?\s*([A-Z]{1,6}-[A-Z0-9][\w/-]*\d[\w/-]*)/gi;
const BEZUG_ART = (wort: string): 'order' | 'invoice' | 'case' | 'offer' =>
  /^auftrag/i.test(wort) ? 'order' : /^rechnung/i.test(wort) ? 'invoice' : /^angebot/i.test(wort) ? 'offer' : 'case';

function readComplaintReferences(text: string): NonNullable<SemanticComplaint['references']> {
  const bezuege: NonNullable<SemanticComplaint['references']> = [];
  for (const m of text.matchAll(BEZUG)) {
    const number = m[2].replace(/[.,;:/-]+$/, '');
    if (bezuege.some((b) => b.number.toLowerCase() === number.toLowerCase())) continue;
    bezuege.push({ kind: BEZUG_ART(m[1]), number });
  }
  return bezuege.slice(0, 5);
}

/**
 * Die ganze Beschwerde-Semantik — oder `undefined`. Ohne sicheren Titel nur
 * bei einer ausdrücklichen Geldforderung wegen Schaden oder Minderung.
 */
export function readComplaintSemantics(
  text: string,
  options: { ownLetterhead: boolean },
): SemanticComplaint | undefined {
  const titel = detectComplaintTitle(text);
  const demands = readComplaintDemands(text);
  const geldOhneTitel = demands.find((d) => d.kind === 'damages' || d.kind === 'reduction');
  if (!titel && !geldOhneTitel) return undefined;
  const escalation = ESKALATION.filter(([, muster]) => muster.test(text)).map(([art]) => art);
  const references = readComplaintReferences(text);
  return {
    type: titel?.type ?? (geldOhneTitel?.kind === 'reduction' ? 'objection' : 'damage_claim'),
    direction: options.ownLetterhead ? 'outgoing' : 'incoming',
    reports: readComplaintReports(text, titel?.line),
    demands,
    ...(escalation.length > 0 ? { escalation } : {}),
    ...(references.length > 0 ? { references } : {}),
  };
}

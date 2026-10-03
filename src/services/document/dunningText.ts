/**
 * EINGANG-02B — was eine eingehende Mahnung im Wortlaut sagt.
 *
 * Rein deterministisch und nur lesend: Mahnstufe, die genannten
 * Rechnungsnummern und die beschrifteten Forderungsteile. Keine Finanzlogik,
 * keine Bewertung, ob die Forderung berechtigt ist. Wo nichts eindeutig
 * beschriftet ist, bleibt der Wert leer.
 */
import type { SemanticDunning, SemanticDunningStage } from '../../types/documentSemanticCore';

/** Die Stufe, vom gewichtigsten Signal her gelesen. */
const STUFEN: Array<[SemanticDunningStage, RegExp]> = [
  ['court_dunning', /\b(?:gerichtlicher\s+)?mahnbescheid\b|\bmahngericht\b/i],
  ['collection', /\binkasso(?:büro|buero|unternehmen)?\b|\bforderungsschreiben\b/i],
  ['final_dunning', /\bletzte\s+mahnung\b|\bletztmalige\s+(?:mahnung|zahlungsaufforderung)\b/i],
  ['dunning', /\b(?:\d\.\s*|erste\s+|zweite\s+|dritte\s+)?mahnung\b|\bzahlungsaufforderung\b/i],
  ['payment_reminder', /\bzahlungserinnerung\b/i],
];

/** Eine Mahnung im Kopf (Titelzeile) — Grundlage für die Seitenwahrheit. */
const MAHN_TITEL =
  /^(?:\d\.\s*|erste\s+|zweite\s+|dritte\s+|letzte\s+)?(?:mahnung|zahlungserinnerung|zahlungsaufforderung)\b|^(?:gerichtlicher\s+)?mahnbescheid\b|^forderungsschreiben\b/i;

function titelZeilen(text: string): string[] {
  return text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((zeile) => zeile.trim())
    .filter(Boolean)
    .slice(0, 10);
}

/*
 * Der Titel entscheidet die Stufe: „Letzte Mahnung … sonst Inkasso" oder
 * „… sonst gerichtlicher Mahnbescheid" ist eine Androhung, keine höhere Stufe.
 * Ohne Mahntitel gilt der erste Treffer im ganzen Text.
 */
export function detectDunningStage(text: string): SemanticDunningStage | undefined {
  const quelle = titelZeilen(text).find((zeile) => MAHN_TITEL.test(zeile)) ?? text;
  return STUFEN.find(([, muster]) => muster.test(quelle))?.[0];
}

/** Trägt eine Seite eine Mahnung als eigenen Titel (eine der ersten Zeilen)? */
export function hasDunningTitle(text: string): boolean {
  return titelZeilen(text).some((zeile) => MAHN_TITEL.test(zeile));
}

/*
 * „Rechnungsnummer RE-100", „Rechnungs-Nr. RE-100", „Rechnung Nr. RE-100",
 * „(Unsere) Rechnung RE-100 vom …", „Re.-Nr. RE-100". Die Nummer muss eine
 * Ziffer tragen und mit Buchstaben+Ziffer oder mindestens drei Ziffern
 * beginnen — so bleiben „Rechnung vom 01.09.2026" und „Rechnung über
 * 1.000,00 EUR" ohne Treffer.
 */
const BEZUGS_NUMMER =
  /\b(?:rechnungs[\s-]*(?:nummer|nr\.?)|rechnung(?:\s+(?:nr\.?|nummer))?|re\.?[\s-]*nr\.?)\s*[:#]?\s*((?:[A-Z]{1,6}[-/]?\d|\d{3,})[\w./-]*)/gi;

/** Die im Mahntext genannten Rechnungsnummern, in Reihenfolge und ohne Dubletten. */
export function extractDunningInvoiceReferences(text: string): string[] {
  const gefunden: string[] = [];
  for (const treffer of text.matchAll(BEZUGS_NUMMER)) {
    const nummer = treffer[1].replace(/[.,;:/-]+$/, '');
    if (!/\d/.test(nummer)) continue;
    if (!gefunden.some((n) => n.toLowerCase() === nummer.toLowerCase())) gefunden.push(nummer);
  }
  return gefunden;
}

const BETRAG = String.raw`(\d{1,3}(?:\.\d{3})*,\d{2}|\d+,\d{2})\s*(?:EUR|€)`;
const LABELS = {
  principal: /^(?:hauptforderung|offene\s+forderung|offener\s+(?:rechnungs)?betrag|rechnungsbetrag)\b/i,
  fees: /^(?:mahnkosten|mahngebühr(?:en)?|mahngebuehr(?:en)?|inkassokosten|inkassogebühr(?:en)?|inkassogebuehr(?:en)?)\b/i,
  interest: /^(?:verzugszinsen|zinsen)\b/i,
  total: /^(?:gesamtforderung|gesamtbetrag|zu\s+zahlender\s+betrag|zahlbetrag)\b/i,
} as const;

function betragAusZeile(zeile: string): number | undefined {
  const treffer = new RegExp(BETRAG, 'i').exec(zeile);
  if (!treffer) return undefined;
  const wert = Number.parseFloat(treffer[1].replace(/\./g, '').replace(',', '.'));
  return Number.isFinite(wert) ? wert : undefined;
}

/**
 * Die beschrifteten Forderungsteile — nur aus Zeilen bzw. Sätzen, die mit dem
 * Label beginnen. Nichts wird aus der Reihenfolge erraten.
 */
export function extractDunningClaim(text: string): Pick<SemanticDunning, 'principalAmount' | 'reminderFees' | 'interestAmount' | 'totalClaim'> {
  const teile = text
    .replace(/\r\n/g, '\n')
    .split(/\n|(?<=[a-zäöüß)][.!?])\s+/)
    .map((teil) => teil.trim())
    .filter(Boolean);
  let principalAmount: number | undefined;
  let reminderFees: number | undefined;
  let interestAmount: number | undefined;
  let totalClaim: number | undefined;
  for (const teil of teile) {
    const wert = betragAusZeile(teil);
    if (wert === undefined) continue;
    if (LABELS.principal.test(teil) && principalAmount === undefined) principalAmount = wert;
    else if (LABELS.fees.test(teil)) reminderFees = Math.round(((reminderFees ?? 0) + wert) * 100) / 100;
    else if (LABELS.interest.test(teil)) interestAmount = Math.round(((interestAmount ?? 0) + wert) * 100) / 100;
    else if (LABELS.total.test(teil) && totalClaim === undefined) totalClaim = wert;
  }
  return {
    ...(principalAmount !== undefined ? { principalAmount } : {}),
    ...(reminderFees !== undefined ? { reminderFees } : {}),
    ...(interestAmount !== undefined ? { interestAmount } : {}),
    ...(totalClaim !== undefined ? { totalClaim } : {}),
  };
}

/** Die ganze Mahnungs-Semantik eines Textes — oder `undefined`, wenn er keine Mahnung ist. */
export function readDunningSemantics(text: string): SemanticDunning | undefined {
  const stage = detectDunningStage(text);
  if (!stage) return undefined;
  const invoiceReferences = extractDunningInvoiceReferences(text);
  return {
    stage,
    ...(invoiceReferences.length > 0 ? { invoiceReferences } : {}),
    ...extractDunningClaim(text),
  };
}

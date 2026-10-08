/**
 * P1 MITARBEITERZAHLUNGEN — der Betrag in Worten für die Auszahlungsquittung.
 *
 * Bewusst eng: Nur der geprüfte Bereich von 0,01 € bis 9.999.999,99 € wird
 * ausgeschrieben — genau die Spanne, die eine Mitarbeiterzahlung überhaupt
 * haben darf. Alles andere (null, negativ, mehr als zwei Nachkommastellen,
 * nicht endlich) ergibt `null`, und die Quittung lässt die Zeile weg. Eine
 * falsch ausgeschriebene Zahl auf einem unterschriebenen Beleg wäre schlimmer
 * als keine.
 */

export const AMOUNT_IN_WORDS_MIN_CENTS = 1;
export const AMOUNT_IN_WORDS_MAX_CENTS = 999_999_999;

const EINER = [
  'null', 'eins', 'zwei', 'drei', 'vier', 'fünf', 'sechs', 'sieben', 'acht', 'neun',
  'zehn', 'elf', 'zwölf', 'dreizehn', 'vierzehn', 'fünfzehn', 'sechzehn', 'siebzehn',
  'achtzehn', 'neunzehn',
];

const ZEHNER = [
  '', '', 'zwanzig', 'dreißig', 'vierzig', 'fünfzig', 'sechzig', 'siebzig', 'achtzig', 'neunzig',
];

/** 1–99; `eins` als Wortende, `ein` vor „und…". */
function unterHundert(n: number): string {
  if (n < 20) return EINER[n];
  const einer = n % 10;
  const zehner = ZEHNER[Math.floor(n / 10)];
  if (einer === 0) return zehner;
  return `${einer === 1 ? 'ein' : EINER[einer]}und${zehner}`;
}

/** 1–999, als ein zusammengeschriebenes Wort. */
function unterTausend(n: number): string {
  const hunderter = Math.floor(n / 100);
  const rest = n % 100;
  const kopf = hunderter > 0 ? `${hunderter === 1 ? 'ein' : EINER[hunderter]}hundert` : '';
  return rest > 0 ? `${kopf}${unterHundert(rest)}` : kopf;
}

/** 1–999.999 — Tausender werden angehängt, nicht getrennt. */
function unterMillion(n: number): string {
  const tausender = Math.floor(n / 1000);
  const rest = n % 1000;
  const kopf = tausender > 0 ? `${tausender === 1 ? 'ein' : unterTausend(tausender)}tausend` : '';
  return rest > 0 ? `${kopf}${unterTausend(rest)}` : kopf;
}

/**
 * Eine ganze Zahl von 0 bis 9.999.999 in Worten. Millionen stehen als eigenes
 * Wort davor („zwei Millionen dreihunderttausend").
 */
export function integerToGermanWords(n: number): string | null {
  if (!Number.isInteger(n) || n < 0 || n > 9_999_999) return null;
  if (n === 0) return EINER[0];
  const millionen = Math.floor(n / 1_000_000);
  const rest = n % 1_000_000;
  const teile: string[] = [];
  if (millionen > 0) {
    teile.push(millionen === 1 ? 'eine Million' : `${unterTausend(millionen)} Millionen`);
  }
  if (rest > 0) teile.push(unterMillion(rest));
  return teile.join(' ');
}

/** Ganze Cent oder `null`, wenn der Betrag mehr als zwei Nachkommastellen trägt. */
function toExactCents(amount: number): number | null {
  if (typeof amount !== 'number' || !Number.isFinite(amount)) return null;
  const cents = Math.round(amount * 100);
  if (Math.abs(cents - amount * 100) > 1e-6) return null;
  return cents;
}

/**
 * „eintausendzweihundertvierunddreißig Euro und sechsundfünfzig Cent".
 *
 * Ein einzelner Euro oder Cent heisst „ein Euro" / „ein Cent"; ganze Beträge
 * enden ohne Cent-Teil. Ausserhalb des geprüften Bereichs: `null`.
 */
export function formatEuroAmountInWords(amount: number): string | null {
  const cents = toExactCents(amount);
  if (cents === null) return null;
  if (cents < AMOUNT_IN_WORDS_MIN_CENTS || cents > AMOUNT_IN_WORDS_MAX_CENTS) return null;

  const euro = Math.floor(cents / 100);
  const cent = cents % 100;
  const euroWort = euro === 1 ? 'ein' : integerToGermanWords(euro);
  if (euroWort === null) return null;
  const euroTeil = `${euroWort} Euro`;
  if (cent === 0) return euroTeil;
  const centWort = cent === 1 ? 'ein' : unterHundert(cent);
  return `${euroTeil} und ${centWort} Cent`;
}

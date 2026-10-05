/**
 * BANKABGLEICH-V1 BLOCK 1 — Bankbeträge deterministisch in Cent lesen.
 *
 * Warum ein eigener Parser und nicht `Number(value)`: Ein deutscher
 * Bankexport schreibt `1.234,56`. `Number('1.234,56')` ist `NaN`, und
 * `parseFloat('1.234,56')` ist `1.234` — also ein Euro statt
 * zwölfhundert. Beides wäre hier falsches Geld, das zweite sogar still.
 *
 * Die Regel ist bewusst **entscheidbar statt klug**: Das *letzte* Trennzeichen
 * entscheidet, ob es Dezimaltrenner ist, und nur dann, wenn danach genau zwei
 * Ziffern stehen. Alles, was diese Regel nicht eindeutig beantwortet, ist
 * `null` — eine nicht gelesene Zeile ist ehrlich, eine geratene ist gefährlich.
 */

/** Was nach dem Trennzeichen stehen darf, damit es als Dezimaltrenner gilt. */
const DEZIMALSTELLEN = 2;

/**
 * Währungshinweise, die ein Export an den Betrag hängt. Nur diese, und nur am
 * Rand — ein Zeichen mitten im Betrag bleibt ein Grund zur Ablehnung.
 */
const WAEHRUNG = /\s*(?:€|EUR|eur)\s*$/;

/**
 * Der Betrag als Cent, oder `null`, wenn die Schreibweise nicht eindeutig ist.
 *
 * Erkannt werden `123,45`, `1.234,56`, `123.45`, `1,234.56`, `1234`, jeweils
 * auch negativ mit führendem `-`, mit nachgestelltem `-` (so schreiben einige
 * Exporte Soll-Beträge) und in Klammern.
 */
export function parseBankAmountToCents(raw: string | null | undefined): number | null {
  if (raw == null) return null;
  let text = String(raw).trim();
  if (!text) return null;

  text = text.replace(WAEHRUNG, '').trim();
  if (!text) return null;

  /* Klammern sind die kaufmännische Schreibweise für „negativ". */
  let negativ = false;
  const klammer = /^\((.*)\)$/.exec(text);
  if (klammer) {
    negativ = true;
    text = (klammer[1] ?? '').trim();
  }

  /* Vorzeichen vorn oder hinten — beides kommt in Bankexporten vor. */
  if (text.startsWith('-')) {
    negativ = !negativ;
    text = text.slice(1).trim();
  } else if (text.startsWith('+')) {
    text = text.slice(1).trim();
  } else if (text.endsWith('-')) {
    negativ = !negativ;
    text = text.slice(0, -1).trim();
  } else if (text.endsWith('+')) {
    text = text.slice(0, -1).trim();
  }

  /* Schmale Leerzeichen als Tausendertrenner kommen aus Tabellenprogrammen. */
  text = text.replace(/[\s  ]/g, '');
  if (!text) return null;

  /* Ab hier sind nur noch Ziffern und Trennzeichen erlaubt. */
  if (!/^[0-9.,]+$/.test(text)) return null;

  const letzterPunkt = text.lastIndexOf('.');
  const letztesKomma = text.lastIndexOf(',');
  const letzter = Math.max(letzterPunkt, letztesKomma);

  let ganz: string;
  let bruch: string;

  if (letzter === -1) {
    ganz = text;
    bruch = '';
  } else {
    const nachkomma = text.slice(letzter + 1);
    if (nachkomma.length === DEZIMALSTELLEN && /^[0-9]+$/.test(nachkomma)) {
      /* Das letzte Trennzeichen trennt die Cent ab. */
      ganz = text.slice(0, letzter);
      bruch = nachkomma;
    } else if (/^[0-9]{3}$/.test(nachkomma)) {
      /*
       * Genau drei Ziffern dahinter: ein Tausendertrenner, kein Dezimaltrenner.
       * `1.234` ist eintausendzweihundertvierunddreissig.
       */
      ganz = text;
      bruch = '';
    } else {
      /* Weder Cent noch Tausender — hier endet die Eindeutigkeit. */
      return null;
    }
  }

  /* Im Ganzzahlteil dürfen nur noch Tausendertrenner stehen. */
  const ganzZiffern = ganz.replace(/[.,]/g, '');
  if (!/^[0-9]*$/.test(ganzZiffern)) return null;
  if (!ganzZiffern && !bruch) return null;

  /* Ein Trenner im Ganzzahlteil muss immer drei Ziffern gruppieren. */
  if (/[.,]/.test(ganz)) {
    const gruppen = ganz.split(/[.,]/);
    if (gruppen.length > 1) {
      const [erste, ...weitere] = gruppen;
      if (!erste || erste.length > 3) return null;
      if (weitere.some((gruppe) => !/^[0-9]{3}$/.test(gruppe))) return null;
    }
  }

  const cents = Number(ganzZiffern || '0') * 100 + Number(bruch || '0');
  if (!Number.isSafeInteger(cents)) return null;
  return negativ ? -cents : cents;
}

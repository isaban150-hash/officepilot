/** Cent-based money helpers for invoice totals (no raw float pass-through). */

export function isValidMoneyNumber(value: number): boolean {
  return typeof value === 'number' && Number.isFinite(value);
}

/*
 * FINANZ-CORE-01A — exakte Dezimalrechnung wie auf dem Server.
 *
 * Bisher rechnete der Client Menge × Einzelpreis in Gleitkomma und rundete
 * danach mit `Number.EPSILON`. Der Server rechnet `round(menge * preis * 100)`
 * exakt in `numeric`. Bei halben Centbeträgen lief das auseinander: 0,5 × 20,15
 * ergibt binär 10,07499… und im Client 10,07 €, auf dem Server 10,08 € — die
 * Freigabe scheiterte deterministisch mit `invoice_totals_mismatch`.
 *
 * Jetzt nimmt der Client dieselbe Basis wie der Server: die kürzeste
 * rundreisefähige Schreibweise der Zahl (genau die, die JSON an den Server
 * schickt und die PostgreSQL als `numeric` liest), multipliziert als ganze Zahl
 * und rundet einmal kaufmännisch, also halb weg von null — wie `round()` in
 * PostgreSQL.
 */
interface ExactDecimal {
  digits: bigint;
  scale: number;
}

function toExactDecimal(value: number): ExactDecimal {
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(String(value));
  if (!match) throw new Error(`keine Dezimalzahl: ${value}`);
  const [, sign, intPart, fracPart = '', exponent] = match;
  let digits = BigInt(intPart + fracPart);
  let scale = fracPart.length - (exponent ? Number(exponent) : 0);
  if (scale < 0) {
    digits *= 10n ** BigInt(-scale);
    scale = 0;
  }
  return { digits: sign ? -digits : digits, scale };
}

/** Auf `targetScale` Nachkommastellen, halb weg von null (wie `round()` in PostgreSQL). */
function roundExact(value: ExactDecimal, targetScale: number): bigint {
  if (value.scale <= targetScale) return value.digits * 10n ** BigInt(targetScale - value.scale);
  const divisor = 10n ** BigInt(value.scale - targetScale);
  const negative = value.digits < 0n;
  const magnitude = negative ? -value.digits : value.digits;
  let rounded = magnitude / divisor;
  if ((magnitude % divisor) * 2n >= divisor) rounded += 1n;
  return negative ? -rounded : rounded;
}

/** Round a euro amount to the nearest cent. */
export function roundMoney(amount: number): number {
  if (!isValidMoneyNumber(amount)) return NaN;
  return toCents(amount) / 100;
}

export function toCents(amount: number): number {
  if (!isValidMoneyNumber(amount)) return NaN;
  return Number(roundExact(toExactDecimal(amount), 2));
}

export function fromCents(cents: number): number {
  if (!Number.isFinite(cents)) return NaN;
  return cents / 100;
}

/** Line total in cents: quantity × unit price, exakt, then round once. */
export function lineTotalCents(quantity: number, unitPrice: number): number {
  if (!isValidMoneyNumber(quantity) || !isValidMoneyNumber(unitPrice)) return NaN;
  const q = toExactDecimal(quantity);
  const p = toExactDecimal(unitPrice);
  return Number(roundExact({ digits: q.digits * p.digits, scale: q.scale + p.scale }, 2));
}

export function lineTotalMoney(quantity: number, unitPrice: number): number {
  return fromCents(lineTotalCents(quantity, unitPrice));
}

/**
 * FINANZ-CORE-01A — die Zeile einer Rechnung oder eines Angebots.
 *
 * Gedruckt und an den Server gesendet wird der Einzelpreis auf Cent
 * (`roundMoney`); der Server rechnet die Zeile mit genau diesem Preis nach.
 * Rechnete der Client mit einem feineren Preis (etwa 0,045 € aus einem
 * Nachtrag), stimmten Beleg und Server nicht überein — und die Zeile wäre
 * für den Kunden nicht nachrechenbar (10 × 0,05 € ≠ 0,45 €).
 */
export function billingLineTotalCents(quantity: number, unitPrice: number): number {
  return lineTotalCents(quantity, roundMoney(unitPrice));
}

export function billingLineTotalMoney(quantity: number, unitPrice: number): number {
  return fromCents(billingLineTotalCents(quantity, unitPrice));
}

export function sumCents(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0);
}

/** VAT in cents from net cents and percent rate (e.g. 19). */
export function taxCentsFromNet(netCents: number, taxRatePercent: number): number {
  if (!Number.isFinite(netCents) || !Number.isFinite(taxRatePercent)) return NaN;
  if (taxRatePercent <= 0) return 0;
  return Math.round((netCents * taxRatePercent) / 100);
}

/**
 * BEREICH-7-V1 — Weiterberechnungspreis in Cent: Einkaufsnetto plus optionaler
 * prozentualer Aufschlag.
 *
 * **Genau eine Rundung.** Zuerst den Aufschlag zu runden und ihn dann zu
 * addieren wäre eine zweite Rundungsstelle und würde bei krummen Sätzen um
 * einen Cent abweichen — deshalb steht hier ein einziger `Math.round` über dem
 * fertigen Produkt, wie in `taxCentsFromNet` auch.
 *
 * Aufschlag `0` ergibt den Einkaufspreis **exakt** und nicht nur ungefähr:
 * Der Faktor ist dann 1, und `Math.round` eines ganzzahligen Centbetrags ist
 * dieser Betrag.
 *
 * Ein negativer Satz ist kein Rabattmodell, sondern ein Eingabefehler, und
 * wird deshalb hier nicht abgefangen, sondern vom Dienst abgewiesen.
 */
export function rebillPriceCents(netCents: number, markupPercent: number): number {
  if (!Number.isFinite(netCents) || !Number.isFinite(markupPercent)) return NaN;
  if (markupPercent === 0) return netCents;
  return Math.round((netCents * (100 + markupPercent)) / 100);
}

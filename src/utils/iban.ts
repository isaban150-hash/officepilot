/**
 * BROWSER-ACCEPTANCE-FIX 01 / B2 — IBAN-Prüfung (ISO 13616).
 *
 * Bisher galt jede Zeichenfolge aus 15–34 Buchstaben/Ziffern als IBAN; eine
 * deutsche IBAN mit 23 statt 22 Zeichen ging so unbemerkt auf Rechnungen.
 * Geprüft wird jetzt:
 *
 *   1. Normalisierung: Leerzeichen entfernen, Grossbuchstaben
 *   2. Zeichen: nur A–Z und 0–9
 *   3. Aufbau: zwei Buchstaben Ländercode, zwei Ziffern Prüfziffer
 *   4. Ländercode bekannt und länderspezifische Länge
 *   5. Prüfziffer nach Mod-97 (Rest 1)
 *
 * Keine Abhängigkeit, keine Netzwerkabfrage — ob das Konto existiert, kann
 * keine IBAN-Prüfung sagen, nur ob die Nummer in sich stimmig ist.
 */

/** Länge je Land laut IBAN-Register (SWIFT). */
export const IBAN_LENGTHS: Readonly<Record<string, number>> = {
  AD: 24, AE: 23, AL: 28, AT: 20, AZ: 28, BA: 20, BE: 16, BG: 22, BH: 22, BR: 29,
  BY: 28, CH: 21, CR: 22, CY: 28, CZ: 24, DE: 22, DK: 18, DO: 28, EE: 20, EG: 29,
  ES: 24, FI: 18, FO: 18, FR: 27, GB: 22, GE: 22, GI: 23, GL: 18, GR: 27, GT: 28,
  HR: 21, HU: 28, IE: 22, IL: 23, IQ: 23, IS: 26, IT: 27, JO: 30, KW: 30, KZ: 20,
  LB: 28, LC: 32, LI: 21, LT: 20, LU: 20, LV: 21, LY: 25, MC: 27, MD: 24, ME: 22,
  MK: 19, MR: 27, MT: 31, MU: 30, NL: 18, NO: 15, PK: 24, PL: 28, PS: 29, PT: 25,
  QA: 29, RO: 24, RS: 22, SA: 24, SC: 31, SE: 24, SI: 19, SK: 24, SM: 27, ST: 25,
  SV: 28, TL: 23, TN: 24, TR: 26, UA: 29, VA: 22, VG: 24, XK: 20,
};

export type IbanProblem = 'empty' | 'characters' | 'format' | 'country' | 'length' | 'checksum';

export type IbanCheck =
  | { valid: true; normalized: string }
  | { valid: false; problem: IbanProblem; normalized: string; expectedLength?: number };

export function normalizeIban(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/g, '').toUpperCase();
}

/** Rest der Division durch 97, stückweise — die Zahl ist zu gross für `number`. */
function mod97(digits: string): number {
  let remainder = 0;
  for (let index = 0; index < digits.length; index += 7) {
    remainder = Number(`${remainder}${digits.slice(index, index + 7)}`) % 97;
  }
  return remainder;
}

export function checkIban(value: string | null | undefined): IbanCheck {
  const normalized = normalizeIban(value);
  if (!normalized) return { valid: false, problem: 'empty', normalized };
  if (!/^[A-Z0-9]+$/.test(normalized)) return { valid: false, problem: 'characters', normalized };
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]+$/.test(normalized)) return { valid: false, problem: 'format', normalized };

  const expectedLength = IBAN_LENGTHS[normalized.slice(0, 2)];
  if (!expectedLength) return { valid: false, problem: 'country', normalized };
  if (normalized.length !== expectedLength) {
    return { valid: false, problem: 'length', normalized, expectedLength };
  }

  const rearranged = `${normalized.slice(4)}${normalized.slice(0, 4)}`;
  const digits = rearranged.replace(/[A-Z]/g, (letter) => String(letter.charCodeAt(0) - 55));
  if (mod97(digits) !== 1) return { valid: false, problem: 'checksum', normalized };

  return { valid: true, normalized };
}

export function isValidIban(value: string | null | undefined): boolean {
  return checkIban(value).valid;
}

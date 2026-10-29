/**
 * EINRICHTUNG-01 (AP6; Vertrag 1.19, F-05, E-04) — Absendername von E-Mails, serverseitig.
 *
 * Wortgleich mit `src/services/company/senderDisplayName.ts`; der Test `einrichtung01AbsenderAp6` prüft beide mit
 * denselben Testvektoren. Kein Deno-Import, damit Vitest das Modul direkt laden kann.
 *
 * Gilt nur für den Absendernamen. Rechnungs- und Angebots-PDFs bleiben unverändert (FINANZ-CORE-01A, Gold).
 */

function collapse(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/** Vergleichsform: ohne Groß/klein, Leerzeichen zusammengefasst, ohne abschließende Punkte und Kommas. */
function comparable(value: string): string {
  return collapse(value).toLowerCase().replace(/[.,\s]+$/u, '');
}

/**
 * Leere Rechtsform → nur der Name. Endet der Name schon auf die Rechtsform (an einer Wortgrenze), bleibt der Name.
 * Sonst Name, Leerzeichen, Rechtsform.
 */
export function composeSenderLegalName(companyName: unknown, legalForm: unknown): string {
  const name = typeof companyName === 'string' ? collapse(companyName) : '';
  const form = typeof legalForm === 'string' ? collapse(legalForm) : '';
  if (!form) return name;
  if (!name) return form;
  const n = comparable(name);
  const f = comparable(form);
  if (f && n.endsWith(f)) {
    const before = n.length - f.length;
    if (before === 0 || !/[\p{L}\p{N}]/u.test(n.charAt(before - 1))) return name;
  }
  return `${name} ${form}`;
}

export const SENDER_DISPLAY_NAME_MAX_CODE_POINTS = 120;

/** Zeilenumbrüche und andere Steuerzeichen (C0, DEL, Zeilen- und Absatztrenner), aus Zeichencodes gebaut. */
const CONTROL_CHARACTERS = new RegExp(
  `[${String.fromCharCode(0x00)}-${String.fromCharCode(0x1f)}${String.fromCharCode(0x7f)}${String.fromCharCode(0x2028)}${String.fromCharCode(0x2029)}]`,
);

export type SenderDisplayNameProblem = 'too_long' | 'line_break' | 'forbidden_character';

/**
 * Prüfregel für einen eigenen Anzeigenamen (E-04): optional, höchstens 120 Codepunkte, ohne Zeilenumbruch und
 * Steuerzeichen, ohne `<`, `>`, `"` und `@`. Ein gespeicherter Name, der die Regel verletzt (Altbestand vor AP6), wird
 * beim Versand nicht verwendet; dann gilt der Rückfall nach der Regel oben.
 */
export function senderDisplayNameProblem(value: string): SenderDisplayNameProblem | null {
  const text = value.trim();
  if (!text) return null;
  if ([...text].length > SENDER_DISPLAY_NAME_MAX_CODE_POINTS) return 'too_long';
  if (CONTROL_CHARACTERS.test(text)) return 'line_break';
  if (/[<>"@]/.test(text)) return 'forbidden_character';
  return null;
}

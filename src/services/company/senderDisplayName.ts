/**
 * EINRICHTUNG-01 (AP6; Vertrag 1.19, F-05, E-04) — Absendername von E-Mails: die eine Formatierungsregel für Firmenname
 * und Rechtsform und die Prüfregel für einen eigenen Anzeigenamen.
 *
 * Wortgleich in der Edge-Funktion (`supabase/functions/_shared/senderDisplayName.ts`); der Test
 * `einrichtung01AbsenderAp6` prüft beide mit denselben Testvektoren. Der Server weist einen ungültigen Anzeigenamen
 * beim Speichern mit `display_name_invalid` ab (Migration 20261202120000).
 *
 * Gilt nur für den Absendernamen. Rechnungs- und Angebots-PDFs nutzen weiterhin `companyLegalName` (FINANZ-CORE-01A,
 * Gold) und bleiben unverändert.
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
 * Prüfregel für einen eigenen Anzeigenamen (E-04): optional (leer → Rückfall nach der Regel oben), höchstens 120
 * Codepunkte, ohne Zeilenumbruch und Steuerzeichen, ohne `<`, `>`, `"` und `@` — damit auch keine E-Mail-Adresse.
 * Leerzeichen am Rand zählen nicht (sie werden beim Speichern entfernt).
 */
export function senderDisplayNameProblem(value: string): SenderDisplayNameProblem | null {
  const text = value.trim();
  if (!text) return null;
  if ([...text].length > SENDER_DISPLAY_NAME_MAX_CODE_POINTS) return 'too_long';
  if (CONTROL_CHARACTERS.test(text)) return 'line_break';
  if (/[<>"@]/.test(text)) return 'forbidden_character';
  return null;
}

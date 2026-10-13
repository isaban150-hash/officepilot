/**
 * FINANZ-CORE-01A (WEISS-Nacharbeit N14) — die Firmierung: Firmenname und Rechtsform,
 * einmal und überall gleich zusammengesetzt.
 *
 * Bisher setzten XML, PDF, Mail und Brief `[Firmenname, Rechtsform].join(' ')` blind
 * zusammen. Trug der Name die Rechtsform schon („Muster Handwerk GmbH" + „GmbH"), stand
 * „Muster Handwerk GmbH GmbH" auf dem Beleg und in BT-27.
 *
 * Die Regel: Endet der Name bereits auf die Rechtsform — als eigene Wörter, ohne Rücksicht
 * auf Gross-/Kleinschreibung, Punkte und Leerraum („GmbH & Co. KG" = „GmbH & Co KG") —,
 * bleibt er, wie er ist. Sonst kommt die Rechtsform dahinter. Ein Wortteil zählt nicht:
 * „Bauwerk Prag" + „AG" bleibt „Bauwerk Prag AG".
 */

/** Ohne Punkte und Leerraum, klein: „e. K." = „e.K." = „eK". */
function compact(value: string): string {
  return value.toLocaleLowerCase('de-DE').replace(/[.\s]/g, '');
}

/**
 * Endet der Name bereits auf diese Rechtsform? Verglichen werden ganze Wörter vom Ende her
 * — ohne Punkte und Leerraum —, nie ein Wortteil.
 */
export function companyNameCarriesLegalForm(companyName: string, legalForm: string): boolean {
  const form = compact(legalForm);
  if (!form) return false;
  const words = companyName.trim().split(/\s+/).filter(Boolean);
  for (let start = words.length - 1; start >= 0; start -= 1) {
    const tail = compact(words.slice(start).join(''));
    if (tail === form) return true;
    if (tail.length > form.length) return false;
  }
  return false;
}

/** Firmenname und Rechtsform, wie sie auf dem Beleg stehen — ohne Doppelung. */
export function formatCompanyLegalName(
  companyName: string | null | undefined,
  legalForm: string | null | undefined,
): string {
  const name = (companyName ?? '').trim().replace(/\s+/g, ' ');
  const form = (legalForm ?? '').trim().replace(/\s+/g, ' ');
  if (!form) return name;
  if (!name) return form;
  return companyNameCarriesLegalForm(name, form) ? name : `${name} ${form}`;
}

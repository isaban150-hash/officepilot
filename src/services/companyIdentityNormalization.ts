/**
 * OWN-COMPANY-NAME-NORMALIZATION-01 — ein kanonischer Wert für Firmennamen.
 *
 * Derselbe Betrieb schreibt sich in Dokumenten oft anders als im Firmenprofil:
 * „Çırmak Haustechnik GmbH" im Profil, „Cirmak Haustechnik GmbH" im Vertrag.
 * Ohne Faltung galten das zwei Firmen — und die eigene Firma war in ihrem
 * eigenen Vertrag nicht identifizierbar.
 *
 * **Deterministische kanonische Normalisierung, kein Ähnlichkeitsmaß.**
 * Gefaltet wird ein Zeichen auf sein Grundzeichen; verglichen wird danach
 * weiterhin auf vollständige Gleichheit. Es gibt hier keine Levenshtein-
 * Distanz, kein Fuzzy Matching, keine Teilstring-Regel und keine Phonetik.
 *
 * Die Faltung ist **nicht umkehrbar**: Aus dem Ergebnis lässt sich die
 * ursprüngliche Schreibweise nicht zurückgewinnen, und verschiedene Eingaben
 * können denselben Wert ergeben. Genau das ist beabsichtigt — der Wert dient
 * dem Vergleich, nicht der Anzeige.
 *
 * **Bewusst nicht enthalten:** Transliterationen wie `ue → ü`, `oe → ö` oder
 * `ae → ä`. Sie würden „Neuer", „Steuer" oder „Baer" mit verändern. `Müller`
 * und `Mueller` bleiben deshalb verschieden; `Müller` und `Muller` werden
 * durch die Diakritika-Faltung gleich.
 *
 * Abhängigkeitsfrei nach dem Vorbild von `customerOwnCompanyGuard`: kein Store,
 * kein Profil, keine Fachlogik.
 */

/**
 * Zeichen, die sich durch die Unicode-Zerlegung **nicht** in Grundzeichen und
 * Kombinationszeichen auflösen und deshalb ausdrücklich zugeordnet werden.
 *
 * `ı` (punktloses i) ist der Fall, der diesen Sprint ausgelöst hat. Die Liste
 * bleibt bewusst kurz: Jeder Eintrag ist eine eigene Entscheidung, keine
 * allgemeine Regel. Zeichen wie `ø`, `đ` oder `ł` sind hier absichtlich nicht
 * enthalten — sie kämen erst dazu, wenn ein realer Fall sie verlangt.
 */
const NON_DECOMPOSING_FOLDINGS: ReadonlyArray<readonly [RegExp, string]> = [
  [/ı/g, 'i'],
];

/**
 * Kanonischer Vergleichswert eines Firmennamens.
 *
 * Reihenfolge mit Absicht: erst zerlegen und die Kombinationszeichen
 * entfernen, dann die Sonderzuordnungen, dann zusammensetzen, Leerraum
 * vereinheitlichen und kleinschreiben. `ß` bleibt erhalten — eine Zuordnung auf
 * `ss` wäre eine weitere Transliteration ohne Bezug zu diesem Fall.
 */
export function normalizeCompanyIdentityName(value: string | undefined | null): string {
  let folded = (value ?? '')
    .normalize('NFD')
    // Unicode-Kombinationszeichen: aus `Ç` wird `C`, aus `ö` wird `o`.
    .replace(/[̀-ͯ]/g, '');

  for (const [pattern, replacement] of NON_DECOMPOSING_FOLDINGS) {
    folded = folded.replace(pattern, replacement);
  }

  return folded.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();
}

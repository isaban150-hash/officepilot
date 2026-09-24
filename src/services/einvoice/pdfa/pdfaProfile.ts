/**
 * E-RECHNUNG-04E1 — die PDF/A-Stufe und warum genau diese.
 *
 * ## Warum PDF/A-3 und nicht PDF/A-2
 *
 * PDF/A-1 und PDF/A-2 verbieten eingebettete Dateien beliebigen Typs. Erst
 * PDF/A-3 (ISO 19005-3:2012) erlaubt sie — und genau darauf beruht ZUGFeRD /
 * Factur-X: Der Beleg ist ein PDF, in dem die maschinenlesbare Rechnung als
 * XML-Anhang steckt. Ohne PDF/A-3 gibt es keine hybride Rechnung.
 *
 * ## Warum Stufe U und nicht B
 *
 * ISO 19005-3 kennt drei Konformitätsstufen:
 *
 *  - **B** (basic) — das Aussehen ist reproduzierbar. Mehr nicht.
 *  - **U** (unicode) — zusätzlich trägt *jeder* Text eine Unicode-Zuordnung, ist
 *    also verlässlich durchsuch- und extrahierbar.
 *  - **A** (accessible) — zusätzlich Tagging, Lesereihenfolge, Strukturbaum.
 *
 * Die ZUGFeRD-/Factur-X-Spezifikation lässt alle drei zu. Die Wahl fällt hier
 * trotzdem bewusst auf **U**, aus zwei Gründen:
 *
 * 1. **Sie kostet nichts.** Der bestehende Renderer bettet seit
 *    PDF-TEXT-RENDERING-01B Liberation Sans als Unicode-Schrift ein. Eine
 *    Messung mit veraPDF gegen das heutige, unveränderte Rechnungs-PDF ergab
 *    145 bestandene und drei fehlgeschlagene Regeln — keine davon aus dem
 *    Schriften- oder Unicode-Bereich. Die Stufe U war faktisch schon erfüllt,
 *    bevor dieser Block begann.
 * 2. **Ein Rechnungsarchiv lebt von Durchsuchbarkeit.** Ein Beleg, aus dem sich
 *    zehn Jahre später kein Text herausziehen lässt, erfüllt die Form und
 *    verfehlt den Zweck. Stufe B würde das erlauben, Stufe U schliesst es aus.
 *
 * Stufe **A** bleibt bewusst aussen vor: Sie verlangt einen vollständigen
 * Strukturbaum (Überschriften, Tabellen, Lesereihenfolge). Der Renderer zeichnet
 * heute absolut positionierten Text ohne Semantik; das nachzurüsten wäre ein
 * eigener Umbau des Layouts und nicht Gegenstand dieses Blocks.
 *
 * Die Stufe ist hier eine Konstante und kein Schalter: Es gibt keinen Fall, in
 * dem OfficeTakt absichtlich das schwächere B erzeugen sollte.
 */

/** ISO 19005-3:2012 — der Teil, der eingebettete Dateien erlaubt. */
export const PDFA_PART = 3 as const;

/** Siehe Modulkopf: U, weil die Schrifteinbettung sie ohnehin hergibt. */
export const PDFA_CONFORMANCE = 'U' as const;

export type PdfAConformance = typeof PDFA_CONFORMANCE;

/**
 * Der OutputIntent-Subtype ist auch in PDF/A-2 und -3 unverändert `GTS_PDFA1` —
 * die `1` bezeichnet nicht den Standardteil, sondern die Registrierung des
 * Schlüssels. Ein `GTS_PDFA3` gibt es nicht.
 */
export const PDFA_OUTPUT_INTENT_SUBTYPE = 'GTS_PDFA1' as const;

/** Kennung des Ausgabebedingungs-Profils, siehe `src/assets/color/README.md`. */
export const PDFA_OUTPUT_CONDITION_IDENTIFIER = 'sRGB IEC61966-2.1';
export const PDFA_OUTPUT_CONDITION_REGISTRY = 'http://www.color.org';

/**
 * Trägt die erzeugende Software in die Metadaten ein. Bewusst versioniert: Wenn
 * sich am Aufbau etwas ändert, ist am Beleg ablesbar, welcher Stand ihn erzeugt
 * hat.
 */
export const PDFA_PRODUCER = 'OfficeTakt PDF/A-3 1';

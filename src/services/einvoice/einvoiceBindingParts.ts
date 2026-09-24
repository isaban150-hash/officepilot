/**
 * E-RECHNUNG-04E3 — wie die beiden E-Rechnungsformate nebeneinander am Beleg hängen.
 *
 * Beide sind strukturierte Darstellungen derselben Rechnung und tragen deshalb
 * dieselbe Rolle `structured`. Unterschieden werden sie über die Unterrolle
 * `part` — serverseitig längst Teil des eindeutigen Index, clientseitig seit
 * 04E3 auch. **Keine neue Rolle, keine neue Tabelle, keine Migration.**
 *
 * Eine dritte Datei hängt unverändert daneben: das normale Archiv-PDF unter
 * `archive` ohne Unterrolle. Die drei koexistieren damit ohne jede Kollision.
 */

/** Die XRechnung als CII-XML. */
export const XRECHNUNG_BINDING_PART = 'xrechnung-cii';

/** Die ZUGFeRD-Rechnung als hybrides PDF/A-3U. */
export const ZUGFERD_BINDING_PART = 'zugferd-en16931';

/**
 * Bindungen aus 04D3 tragen noch **keine** Unterrolle.
 *
 * Als dort die XRechnung entstand, gab es clientseitig kein `part`; sie liegt
 * als `structured` ohne Unterrolle am Beleg. Diese Bindungen dürfen nicht
 * verlorengehen — an ihnen hängen bereits erzeugte und in die Cloud
 * gesicherte Belege.
 *
 * Erkannt wird eine solche Altbindung deshalb bewusst **nicht** allein daran,
 * dass die Unterrolle fehlt: Sie muss zusätzlich vom Dateityp her eine
 * XRechnung sein. Sonst würde später ein ZUGFeRD-PDF, dem aus irgendeinem
 * Grund die Unterrolle fehlte, fälschlich als XRechnung ausgeliefert — und der
 * Empfänger bekäme ein PDF, wo er XML erwartet.
 */
export const LEGACY_XRECHNUNG_MIME_TYPES = ['application/xml', 'text/xml'] as const;

export function looksLikeLegacyXRechnungFile(mimeType: string | undefined | null): boolean {
  const value = (mimeType ?? '').trim().toLowerCase();
  return (LEGACY_XRECHNUNG_MIME_TYPES as readonly string[]).includes(value);
}

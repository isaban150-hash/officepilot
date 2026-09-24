/**
 * E-RECHNUNG-04E1 — das ICC-Profil für den OutputIntent.
 *
 * Aufbau bewusst identisch zu `invoicePdfFonts`: Die Datei liegt im Repository,
 * Vite liefert sie als Asset aus, geladen wird einmal pro Sitzung und danach aus
 * dem Cache. Kein CDN, kein Netzzugriff nach aussen, offlinefähig — ein
 * Rechnungs-PDF darf nicht davon abhängen, ob gerade eine fremde Seite erreichbar
 * ist. Ein fehlgeschlagener Ladevorgang wird nicht zwischengespeichert, damit ein
 * späterer Versuch erneut greifen kann.
 *
 * Herkunft, Prüfsumme und Lizenz des Profils stehen in
 * `src/assets/color/README.md`.
 */
import iccProfileUrl from '../../../assets/color/sRGB2014.icc?url';

export type PdfAColorProfileLoader = (url: string) => Promise<Uint8Array>;

/**
 * Die Anzahl der Farbkanäle des Profils. Sie steht im PDF als `/N` am
 * ICC-Stream und muss zum Farbraum passen — sRGB ist dreikanalig. Ein falscher
 * Wert hier macht das Dokument ungültig, deshalb keine Ableitung zur Laufzeit,
 * sondern eine Konstante neben der Datei, zu der sie gehört.
 */
export const PDFA_ICC_COMPONENT_COUNT = 3;

async function fetchProfileBytes(url: string): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`icc_fetch_failed:${response.status}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

let loader: PdfAColorProfileLoader = fetchProfileBytes;
let cache: Promise<Uint8Array> | null = null;

/**
 * Nur für Tests: ersetzt die Ladefunktion. In der Anwendung wird sie nicht
 * aufgerufen; der Standardweg bleibt `fetch` auf das gebündelte Asset.
 */
export function setPdfAColorProfileLoader(next: PdfAColorProfileLoader | null): void {
  loader = next ?? fetchProfileBytes;
  cache = null;
}

export function loadPdfAColorProfile(): Promise<Uint8Array> {
  if (cache) return cache;

  const pending = loader(iccProfileUrl).catch((error: unknown) => {
    cache = null;
    throw error;
  });
  cache = pending;
  return pending;
}

/**
 * PDF-TEXT-RENDERING-01B — Laden der eingebetteten Unicode-Schriften.
 *
 * Die Standardschriften von `pdf-lib` kodieren WinAnsi. Für ein Rechnungsdokument
 * ist das zu wenig: Ein Firmenname wie `Çırmak` wäre nicht darstellbar. Deshalb
 * werden Liberation Sans Regular und Bold (SIL OFL 1.1, siehe
 * `src/assets/fonts/README.md`) eingebettet.
 *
 * Die Dateien liegen im Repository und werden von Vite als Asset ausgeliefert —
 * kein CDN, kein Netzzugriff nach aussen, offlinefähig. Geladen wird einmal pro
 * Sitzung und danach aus dem Cache; ein fehlgeschlagener Ladevorgang wird nicht
 * zwischengespeichert, damit ein späterer Versuch erneut greifen kann.
 */
import regularFontUrl from '../../assets/fonts/LiberationSans-Regular.ttf?url';
import boldFontUrl from '../../assets/fonts/LiberationSans-Bold.ttf?url';

export type InvoicePdfFontWeight = 'regular' | 'bold';

export type InvoicePdfFontLoader = (url: string) => Promise<Uint8Array>;

const FONT_URLS: Record<InvoicePdfFontWeight, string> = {
  regular: regularFontUrl,
  bold: boldFontUrl,
};

async function fetchFontBytes(url: string): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`font_fetch_failed:${response.status}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

let loader: InvoicePdfFontLoader = fetchFontBytes;
const cache = new Map<InvoicePdfFontWeight, Promise<Uint8Array>>();

/**
 * Nur für Tests: ersetzt die Ladefunktion. In der Anwendung wird sie nicht
 * aufgerufen; der Standardweg bleibt `fetch` auf das gebündelte Asset.
 */
export function setInvoicePdfFontLoader(next: InvoicePdfFontLoader | null): void {
  loader = next ?? fetchFontBytes;
  cache.clear();
}

export function loadInvoicePdfFont(weight: InvoicePdfFontWeight): Promise<Uint8Array> {
  const cached = cache.get(weight);
  if (cached) return cached;

  const pending = loader(FONT_URLS[weight]).catch((error: unknown) => {
    cache.delete(weight);
    throw error;
  });
  cache.set(weight, pending);
  return pending;
}

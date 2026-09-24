/**
 * PDF-TEXT-RENDERING-01B — Schriftdateien im Test von der Platte laden.
 *
 * In der Anwendung liefert Vite die Schriften als Asset aus und der Standardlader
 * holt sie per `fetch`. Im Test gibt es keinen Server hinter dieser URL, also
 * werden die Dateien direkt aus `src/assets/fonts` gelesen — dieselben Bytes, die
 * auch gebündelt werden. Damit prüfen die Tests die echte Schrift und nicht einen
 * Platzhalter.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { setInvoicePdfFontLoader } from '../services/invoice/invoicePdfFonts';
import { setPdfAColorProfileLoader } from '../services/einvoice/pdfa/pdfaColorProfile';

const FONT_DIRECTORY = path.resolve(process.cwd(), 'src/assets/fonts');

setInvoicePdfFontLoader(async (url) => {
  const fileName = path.basename(url.split('?')[0]);
  return new Uint8Array(await readFile(path.join(FONT_DIRECTORY, fileName)));
});

/*
 * E-RECHNUNG-04E1 — dasselbe für das ICC-Profil des PDF/A-OutputIntents. Auch
 * hier gilt: die echten Bytes aus `src/assets/color`, kein Platzhalter. Ein
 * erfundenes Profil würde jede Konformitätsprüfung wertlos machen.
 */
const COLOR_DIRECTORY = path.resolve(process.cwd(), 'src/assets/color');

setPdfAColorProfileLoader(async (url) => {
  const fileName = path.basename(url.split('?')[0]);
  return new Uint8Array(await readFile(path.join(COLOR_DIRECTORY, fileName)));
});

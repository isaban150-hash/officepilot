/**
 * STEUERBERATER-06C — das Übergabepaket.
 *
 * Ein ZIP mit dem, was ein Steuerberater braucht: die Buchungsdaten, die
 * Originalbelege, das Abschlussmanifest und einen Prüfbericht, der sagt, was
 * fehlt.
 *
 * **Kein DATEV.** Das Manifest sagt das ausdrücklich und nennt die Gründe, statt
 * sie zu verschweigen. Eine Datei, die „DATEV" heisst und es nicht ist, wäre
 * schlimmer als keine.
 *
 * Die Dokumente kommen über dieselben Lader wie die Monatsmappe
 * (`MonatsmappeDocumentLoaders`) — keine zweite Ladewelt, keine zweite
 * Namensregel. Das Paket ist **read-only**: Es verändert weder Belege noch
 * Kontierungen noch die Abschlussrevision.
 */
import JSZip from 'jszip';
import type {
  MonatsmappeBeleg,
  MonatsmappeModel,
} from '../steuerberater/monatsmappeModelService';
import type { MonatsmappeDocumentLoaders } from '../steuerberater/monatsmappeExportService';
import { safeFileNamePart } from '../steuerberater/monatsmappeModelService';
import { buildBookingCsv, type BookingExport } from './accountingBookingExportService';
import type { AccountingPeriodClosure } from '../../types/accountingPeriod';

export interface ExportPackageInput {
  readonly model: MonatsmappeModel;
  readonly bookings: BookingExport;
  readonly closure: AccountingPeriodClosure;
  readonly currentFingerprint: string;
  readonly workspaceId: string;
  readonly exportedAt: string;
}

export type ExportPackageResult =
  | { ok: true; blob: Blob; fileName: string; documentCount: number; manifest: Record<string, unknown> }
  | { ok: false; reason: 'document_load_failed'; failed: Array<{ id: string; fileName: string; detail: string }> };

/** Die Ordnerstruktur — flach genug, dass man sie ohne Erklärung versteht. */
const FOLDER = {
  abschluss: '00_Abschluss',
  buchungen: '01_Buchungsdaten',
  ausgang: '02_Ausgangsrechnungen',
  eingang: '03_Eingangsbelege',
  stornos: '04_Stornos_Gutschriften',
} as const;

/**
 * Ein Dateiname, der garantiert nur ein Dateiname ist.
 *
 * Die Monatsmappe baut ihre Namen bereits ueber `safeFileNamePart` — aber
 * diese Zusage gilt dort, nicht hier. Ein Paket, das Bytes in Ordner
 * schreibt, darf sich nicht darauf verlassen, dass ein Aufrufer sauber war:
 * Ein Name mit `../` aus einem Lieferantennamen wuerde sonst aus dem
 * Paketordner herausfuehren. Geprueft wird hier, wo geschrieben wird.
 *
 * Endung und Stamm werden getrennt bereinigt, damit `.pdf` erhalten bleibt.
 */
export function sanitizeEntryFileName(value: string): string {
  const raw = value.split(/[\\/]/).pop() ?? '';
  const dot = raw.lastIndexOf('.');
  const stamm = dot > 0 ? raw.slice(0, dot) : raw;
  const endung = dot > 0 ? raw.slice(dot + 1) : '';
  const sicher = safeFileNamePart(stamm, 80);
  const sichereEndung = endung ? safeFileNamePart(endung, 8) : '';
  return sichereEndung ? `${sicher}.${sichereEndung}` : sicher;
}

function folderForBeleg(beleg: MonatsmappeBeleg): string {
  if (beleg.belegart === 'rechnungsstorno' || beleg.belegart === 'ausgabenstorno') {
    return FOLDER.stornos;
  }
  return beleg.belegart === 'ausgangsrechnung' ? FOLDER.ausgang : FOLDER.eingang;
}

/**
 * Baut das Paket.
 *
 * Das Gate hat vorher entschieden, **ob** exportiert werden darf; diese
 * Funktion entscheidet nur noch, **was** hineinkommt.
 */
export async function buildAccountingExportPackage(
  input: ExportPackageInput,
  loaders: MonatsmappeDocumentLoaders,
): Promise<ExportPackageResult> {
  const { model, bookings, closure, exportedAt } = input;
  const zip = new JSZip();
  const rootName = `Steuerberater_${model.monthKey}_Revision-${closure.revision}`;
  const root = zip.folder(rootName)!;

  /* ---------------- Buchungsdaten ---------------- */
  root.folder(FOLDER.buchungen)!.file('buchungen.csv', buildBookingCsv(bookings));

  /* ---------------- Originalbelege ---------------- */
  const failed: Array<{ id: string; fileName: string; detail: string }> = [];
  const usedPaths = new Set<string>();
  let documentCount = 0;

  /*
   * Nur Belege, die auch in den Buchungsdaten stehen. Ein Beleg ohne
   * bestätigte Kontierung gehört nicht ins Paket — und das Gate hat einen
   * solchen Monat ohnehin nicht durchgelassen.
   */
  const exportierteIds = new Set(bookings.rows.map((row) => row.sourceId));

  for (const beleg of [...model.ausgangsrechnungen, ...model.eingangsbelege, ...model.stornos]) {
    if (!exportierteIds.has(beleg.id)) continue;

    for (const source of beleg.documents) {
      const folderName = folderForBeleg(beleg);
      let fileName = sanitizeEntryFileName(source.fileName);
      /*
       * Keine Datei wird still überschrieben. Bei einer Namenskollision
       * bekommt die zweite eine stabile Ergänzung aus ihrer Kennung — der
       * bestehende Monatsmappen-Export bricht hier ab, was für eine Übergabe
       * zu hart wäre: Der Nutzer könnte es nicht beheben.
       */
      if (usedPaths.has(`${folderName}/${fileName}`)) {
        const dot = fileName.lastIndexOf('.');
        const stamm = dot > 0 ? fileName.slice(0, dot) : fileName;
        const endung = dot > 0 ? fileName.slice(dot) : '';
        fileName = `${stamm}__${beleg.id}${endung}`;
      }
      const path = `${folderName}/${fileName}`;
      if (usedPaths.has(path)) continue;
      usedPaths.add(path);

      try {
        const bytes =
          source.kind === 'invoice_pdf'
            ? await loaders.invoicePdf(beleg.id)
            : source.kind === 'invoice_correction_pdf'
              ? await loaders.invoiceCorrectionPdf(beleg.id)
              : await loaders.fileRefBytes(source.fileRefId!);
        root.folder(folderName)!.file(fileName, bytes);
        documentCount += 1;
      } catch (error) {
        failed.push({
          id: beleg.id,
          fileName,
          detail: error instanceof Error ? error.message : 'load_failed',
        });
      }
    }
  }

  if (failed.length > 0) return { ok: false, reason: 'document_load_failed', failed };

  /* ---------------- Abschluss und Prüfbericht ---------------- */
  const manifest: Record<string, unknown> = {
    format: 'officetakt-steuerberater-paket',
    version: 1,
    workspaceId: input.workspaceId,
    monthKey: model.monthKey,
    revision: closure.revision,
    closedAt: closure.closedAt,
    closedBy: closure.closedBy ?? null,
    /* Der Fingerprint des Abschlusses — nicht umgeschrieben, nur zitiert. */
    closureFingerprint: closure.fingerprint,
    currentFingerprint: input.currentFingerprint,
    exportedAt,
    chartOfAccounts: bookings.chartOfAccounts,
    counts: {
      buchungen: bookings.totals.belegCount,
      dokumente: documentCount,
      belegeOhneDokument: bookings.withoutDocument.length,
    },
    summen: {
      netto: bookings.totals.netto,
      steuer: bookings.totals.steuer,
      brutto: bookings.totals.brutto,
    },
    exportart: 'steuerberater_paket',
    /*
     * Ausdrücklich: Dies ist **kein** DATEV-Buchungsstapel, und hier steht,
     * warum. Wer das Paket bekommt, soll es nicht für etwas halten, was es
     * nicht ist.
     */
    datevFormat: false,
    datevNichtVerfuegbarWeil: [
      'Keine verifizierte DATEV-Formatspezifikation hinterlegt (Header, Formatversion, Feldreihenfolge, Encoding).',
      'Kein Gegenkonto und keine Buchungsrichtung im Datenmodell — eine Kontierung nennt nur das Sachkonto.',
      'Kein Steuer-/BU-Schluessel; der Steuerstatus ist eine fachliche Angabe, kein DATEV-Schluessel.',
      'Keine Berater- und Mandantennummer und kein Wirtschaftsjahresbeginn hinterlegt.',
    ],
    hinweis:
      'Uebergabepaket aus OfficeTakt. Keine doppelte Buchfuehrung, kein DATEV-Format, keine Festschreibung.',
  };

  const abschluss = root.folder(FOLDER.abschluss)!;
  abschluss.file('manifest.json', JSON.stringify(manifest, null, 2));
  abschluss.file('pruefbericht.txt', buildPruefbericht(bookings, manifest));

  const blob = await zip.generateAsync({ type: 'blob' });
  return { ok: true, blob, fileName: `${rootName}.zip`, documentCount, manifest };
}

/**
 * Der Prüfbericht — was ein Mensch wissen will, bevor er das Paket weitergibt.
 *
 * Insbesondere: welche Belege **kein** Originaldokument haben. Das blockiert
 * den Export nicht (die Monatsmappe behandelt es seit jeher als Hinweis, und
 * ein Papierbeleg ohne Scan ist kein Fehler des Nutzers), aber es wird
 * benannt.
 */
export function buildPruefbericht(
  bookings: BookingExport,
  manifest: Record<string, unknown>,
): string {
  const zeilen: string[] = [
    `Steuerberater-Paket ${bookings.monthKey}`,
    `Erstellt: ${String(manifest.exportedAt)}`,
    `Abschluss: Revision ${String(manifest.revision)} vom ${String(manifest.closedAt)}`,
    /*
     * 01H — das Manifest darf `null` tragen, wenn niemand bekannt ist; das ist
     * dort die Wahrheit. Ein Mensch liest hier aber keinen Rohwert.
     */
    `Abgeschlossen von: ${
      typeof manifest.closedBy === 'string' && manifest.closedBy.trim()
        ? `Benutzer-ID ${manifest.closedBy}`
        : 'Nicht verfügbar'
    }`,
    `Kontenrahmen: ${bookings.chartOfAccounts}`,
    '',
    'Kontrollsummen',
    `  Belege: ${bookings.totals.belegCount}`,
    `  Netto:  ${bookings.totals.netto.toFixed(2)}`,
    `  Steuer: ${bookings.totals.steuer.toFixed(2)}`,
    `  Brutto: ${bookings.totals.brutto.toFixed(2)}`,
    '',
  ];

  if (bookings.withoutDocument.length > 0) {
    zeilen.push(`Originalbeleg fehlt (${bookings.withoutDocument.length}):`);
    for (const entry of bookings.withoutDocument) {
      zeilen.push(`  ${entry.belegnummer} (${entry.sourceId})`);
    }
    zeilen.push(
      '  Hinweis: Diese Belege sind gebucht, aber ohne Originaldokument im Paket.',
    );
  } else {
    zeilen.push('Zu allen gebuchten Belegen liegt ein Originaldokument bei.');
  }

  zeilen.push(
    '',
    'Kein DATEV-Buchungsstapel. Gruende:',
    ...(manifest.datevNichtVerfuegbarWeil as string[]).map((grund) => `  - ${grund}`),
    '',
    'Dieses Paket ist eine Uebergabedarstellung, keine Buchfuehrung und keine',
    'Festschreibung.',
  );

  return `${zeilen.join('\r\n')}\r\n`;
}

export { FOLDER as EXPORT_PACKAGE_FOLDERS };

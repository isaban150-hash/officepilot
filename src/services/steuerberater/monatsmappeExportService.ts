/**
 * FINANZ-CORE-DURABILITY-01D — Steuerberater-Monatsmappe: Paket bauen.
 *
 * Ablauf: Freigabe (Rolle lokal + serverseitig) -> Modell aus den kanonischen
 * Speichern -> Dokumente (Rechnungs-PDF deterministisch erzeugt, Originale ueber
 * die Datei-Wahrheit inkl. Lazy-Download) -> ZIP -> Download.
 *
 * Kein stiller Teilerfolg: Jeder Ausgang ist benannt. Ein fehlendes Dokument
 * (keine Datei-Referenz) ist ein gekennzeichneter Zustand im Paket; eine Datei,
 * die es geben muesste, aber nicht geladen werden kann, bricht den Export ab.
 */
import JSZip from 'jszip';
import { isSupabaseConfigured, getSupabaseClient } from '../../lib/supabase';
import { buildPersistedStateSnapshot } from '../persistenceService';
import { resolveCloudWorkspaceId } from '../workspace/workspaceSyncPayloadService';
import { resolveWorkspaceWriteAccess } from '../workspace/workspaceRoleService';
import { listInvoiceEntries } from '../invoice/invoiceRegistryService';
import { getAllExpensesFromStore } from '../expenseStore';
import { getDocumentStoreSnapshot } from '../documentService';
import { getInboxItems } from '../inboxService';
import { getDocumentFileBlob, getDocumentFileRefStoreSnapshot } from '../documentFileStoreService';
import { generateApprovedInvoicePdf, generateInvoiceCorrectionPdf } from '../invoicePdfService';
import { downloadBackupBlob } from '../backupExportService';
import {
  BELEGART_FOLDER,
  buildMonatsmappeModel,
  buildUebersichtCsv,
  buildZahlungenCsv,
  isValidMonthKey,
  type MonatsmappeInput,
  type MonatsmappeModel,
} from './monatsmappeModelService';

export type MonatsmappeExportOutcome =
  | 'exported'
  | 'empty'
  | 'forbidden'
  | 'invalid_month'
  | 'data_unavailable'
  | 'document_load_failed'
  | 'export_failed';

export interface MonatsmappeExportSummary {
  monthKey: string;
  filename: string;
  ausgangsrechnungen: number;
  eingangsbelege: number;
  stornos: number;
  zahlungen: number;
  dokumente: number;
  fehlendeDokumente: MonatsmappeModel['fehlendeDokumente'];
  stornosOhneDatum: MonatsmappeModel['stornosOhneDatum'];
}

export type MonatsmappeExportResult =
  | { outcome: 'exported'; summary: MonatsmappeExportSummary; blob: Blob }
  | { outcome: 'empty'; monthKey: string }
  | { outcome: 'forbidden'; detail?: string }
  | { outcome: 'invalid_month' }
  | { outcome: 'data_unavailable'; detail?: string }
  | { outcome: 'document_load_failed'; failed: Array<{ id: string; belegnummer: string; fileName: string; detail: string }> }
  | { outcome: 'export_failed'; detail?: string };

export function buildMonatsmappeFilename(monthKey: string): string {
  return `OfficePilot_Steuerberater_${monthKey}.zip`;
}

/**
 * Berechtigung: lokal (ohne Cloud) immer; mit Cloud owner/admin — und
 * serverseitig bestaetigt (`assert_workspace_finance_export`), damit die
 * Oberflaeche nie die einzige Grenze ist.
 */
export async function assertMonatsmappeAllowed(input: {
  userId: string | null | undefined;
  client?: ReturnType<typeof getSupabaseClient> | null;
}): Promise<{ allowed: true } | { allowed: false; detail?: string }> {
  const cloud = isSupabaseConfigured();
  const access = resolveWorkspaceWriteAccess({ userId: input.userId, cloudConfigured: cloud });
  if (!access.canWrite) return { allowed: false, detail: access.reason };
  if (!cloud) return { allowed: true };

  const client = input.client ?? getSupabaseClient();
  const workspaceId = resolveCloudWorkspaceId(buildPersistedStateSnapshot());
  if (!client || !workspaceId) return { allowed: false, detail: 'workspace_missing' };
  /*
   * 01D2 — Netzwerk-/Serverfehler ist keine Freigabe und kein "lokaler Betrieb":
   * Ohne serverseitige Bestaetigung bleibt der Export verboten.
   */
  try {
    const { error } = await client.rpc('assert_workspace_finance_export', { p_workspace_id: workspaceId });
    if (error) return { allowed: false, detail: error.message };
    return { allowed: true };
  } catch (error) {
    return { allowed: false, detail: error instanceof Error ? error.message : 'network' };
  }
}

export function collectMonatsmappeInput(monthKey: string): MonatsmappeInput {
  return {
    monthKey,
    invoices: listInvoiceEntries(),
    expenses: getAllExpensesFromStore(),
    documents: getDocumentStoreSnapshot(),
    inboxItems: getInboxItems(),
    fileRefs: getDocumentFileRefStoreSnapshot(),
  };
}

export interface MonatsmappeDocumentLoaders {
  invoicePdf: (invoiceId: string) => Promise<Uint8Array>;
  invoiceCorrectionPdf: (invoiceId: string) => Promise<Uint8Array>;
  fileRefBytes: (fileRefId: string) => Promise<Uint8Array>;
}

function defaultLoaders(input: MonatsmappeInput): MonatsmappeDocumentLoaders {
  const invoiceById = new Map(input.invoices.map((entry) => [entry.invoice.id, entry.invoice]));
  const refById = new Map(input.fileRefs.map((ref) => [ref.id, ref]));
  return {
    invoicePdf: async (invoiceId) => {
      const invoice = invoiceById.get(invoiceId);
      if (!invoice) throw new Error('invoice_not_found');
      const result = await generateApprovedInvoicePdf(invoice);
      if (!result.ok) throw new Error(`pdf_${result.reason}`);
      return result.bytes;
    },
    invoiceCorrectionPdf: async (invoiceId) => {
      const invoice = invoiceById.get(invoiceId);
      if (!invoice) throw new Error('invoice_not_found');
      const result = await generateInvoiceCorrectionPdf(invoice);
      if (!result.ok) throw new Error(`pdf_${result.reason}`);
      return result.bytes;
    },
    fileRefBytes: async (fileRefId) => {
      const ref = refById.get(fileRefId);
      if (!ref) throw new Error('file_ref_not_found');
      const blob = await getDocumentFileBlob(ref, [{ type: 'guest' }]);
      if (!blob) throw new Error('blob_unavailable');
      return new Uint8Array(await blob.arrayBuffer());
    },
  };
}

/** Baut das ZIP aus Modell und Ladern — testbar ohne Browser-Download. */
export async function buildMonatsmappeZip(
  model: MonatsmappeModel,
  loaders: MonatsmappeDocumentLoaders,
  generatedAt: string = new Date().toISOString(),
): Promise<{ ok: true; blob: Blob; documentCount: number } | { ok: false; failed: Array<{ id: string; belegnummer: string; fileName: string; detail: string }> }> {
  const zip = new JSZip();
  const root = zip.folder(model.monthKey)!;
  root.file('Uebersicht.csv', buildUebersichtCsv(model));
  root.file('Zahlungen.csv', buildZahlungenCsv(model));

  const failed: Array<{ id: string; belegnummer: string; fileName: string; detail: string }> = [];
  let documentCount = 0;
  const usedNames = new Set<string>();

  const groups: Array<[string, MonatsmappeModel['ausgangsrechnungen']]> = [
    [BELEGART_FOLDER.ausgangsrechnung, model.ausgangsrechnungen],
    [BELEGART_FOLDER.eingangsbeleg, model.eingangsbelege],
    // 01D2 — Stornos/Korrekturen in der Periode des Stornodatums
    [BELEGART_FOLDER.rechnungsstorno, model.stornos],
  ];
  for (const [folderName, belege] of groups) {
    // Ordner nur anlegen, wenn er Inhalt bekommt (kein leerer Stornos-Ordner).
    if (!belege.some((beleg) => beleg.documents.length > 0)) continue;
    const folder = root.folder(folderName)!;
    for (const beleg of belege) {
      for (const source of beleg.documents) {
        const path = `${folderName}/${source.fileName}`;
        if (usedNames.has(path)) {
          failed.push({ id: beleg.id, belegnummer: beleg.belegnummer, fileName: source.fileName, detail: 'filename_collision' });
          continue;
        }
        usedNames.add(path);
        try {
          const bytes =
            source.kind === 'invoice_pdf'
              ? await loaders.invoicePdf(beleg.id)
              : source.kind === 'invoice_correction_pdf'
                ? await loaders.invoiceCorrectionPdf(beleg.id)
                : await loaders.fileRefBytes(source.fileRefId!);
          folder.file(source.fileName, bytes);
          documentCount += 1;
        } catch (error) {
          failed.push({ id: beleg.id, belegnummer: beleg.belegnummer, fileName: source.fileName, detail: error instanceof Error ? error.message : 'load_failed' });
        }
      }
    }
  }
  if (failed.length > 0) return { ok: false, failed };

  root.file(
    'Manifest.json',
    JSON.stringify(
      {
        format: 'officepilot-steuerberater-monatsmappe',
        version: 1,
        monthKey: model.monthKey,
        generatedAt,
        counts: {
          ausgangsrechnungen: model.ausgangsrechnungen.length,
          eingangsbelege: model.eingangsbelege.length,
          zahlungenAusgang: model.zahlungenAusgang.length,
          zahlungenEingang: model.zahlungenEingang.length,
          stornos: model.stornos.length,
          dokumente: documentCount,
        },
        fehlendeDokumente: model.fehlendeDokumente,
        stornosOhneDatum: model.stornosOhneDatum,
        hinweis: 'Abgeleitete Uebergabedarstellung aus OfficePilot. Keine Kontierung, keine Buchfuehrungswahrheit.',
      },
      null,
      2,
    ),
  );
  if (model.fehlendeDokumente.length > 0) {
    root.file(
      'Fehlende_Dokumente.txt',
      model.fehlendeDokumente.map((entry) => `${entry.belegart};${entry.id};${entry.belegnummer}`).join('\r\n') + '\r\n',
    );
  }
  const blob = await zip.generateAsync({ type: 'blob' });
  return { ok: true, blob, documentCount };
}

export async function buildMonatsmappeExport(input: {
  monthKey: string;
  userId: string | null | undefined;
  collect?: (monthKey: string) => MonatsmappeInput;
  loaders?: MonatsmappeDocumentLoaders;
  skipGate?: boolean;
}): Promise<MonatsmappeExportResult> {
  if (!isValidMonthKey(input.monthKey)) return { outcome: 'invalid_month' };

  if (!input.skipGate) {
    const gate = await assertMonatsmappeAllowed({ userId: input.userId });
    if (!gate.allowed) return { outcome: 'forbidden', detail: gate.detail };
  }

  let data: MonatsmappeInput;
  let model: MonatsmappeModel;
  try {
    data = (input.collect ?? collectMonatsmappeInput)(input.monthKey);
    model = buildMonatsmappeModel(data);
  } catch (error) {
    return { outcome: 'data_unavailable', detail: error instanceof Error ? error.message : undefined };
  }
  if (model.isEmpty) return { outcome: 'empty', monthKey: input.monthKey };

  try {
    const built = await buildMonatsmappeZip(model, input.loaders ?? defaultLoaders(data));
    if (!built.ok) return { outcome: 'document_load_failed', failed: built.failed };
    return {
      outcome: 'exported',
      blob: built.blob,
      summary: {
        monthKey: model.monthKey,
        filename: buildMonatsmappeFilename(model.monthKey),
        ausgangsrechnungen: model.ausgangsrechnungen.length,
        eingangsbelege: model.eingangsbelege.length,
        stornos: model.stornos.length,
        zahlungen: model.zahlungenAusgang.length + model.zahlungenEingang.length,
        dokumente: built.documentCount,
        fehlendeDokumente: model.fehlendeDokumente,
        stornosOhneDatum: model.stornosOhneDatum,
      },
    };
  } catch (error) {
    return { outcome: 'export_failed', detail: error instanceof Error ? error.message : undefined };
  }
}

/** Nutzerweg: bauen und herunterladen. */
export async function exportMonatsmappe(input: { monthKey: string; userId: string | null | undefined }): Promise<MonatsmappeExportResult> {
  const result = await buildMonatsmappeExport(input);
  if (result.outcome !== 'exported') return result;
  try {
    downloadBackupBlob(result.blob, result.summary.filename);
    return result;
  } catch (error) {
    return { outcome: 'export_failed', detail: error instanceof Error ? error.message : 'download_failed' };
  }
}

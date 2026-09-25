/**
 * STEUERBERATER-06C — der Nutzerweg: prüfen, bauen, herunterladen.
 *
 * Bewusst ein eigener schmaler Dienst zwischen Oberfläche und Paketbau. Er
 * macht dreierlei, und alles davon gehört nicht in eine Komponente:
 *
 *   1. Er fragt das Gate **unmittelbar vor** dem Bauen erneut. Zwischen dem
 *      Rendern der Seite und dem Klick kann sich etwas geändert haben.
 *   2. Er reicht denselben Zugriffsschutz durch, der für die Monatsmappe gilt
 *      (`assertMonatsmappeAllowed`) — dieselbe Übergabe, dieselbe Grenze.
 *   3. Er lädt herunter über den vorhandenen Weg; keine zweite Downloadlogik.
 *
 * Und er schliesst **nie** einen Monat ab.
 */
import {
  assertMonatsmappeAllowed,
  collectMonatsmappeInput,
} from '../steuerberater/monatsmappeExportService';
import type { MonatsmappeDocumentLoaders } from '../steuerberater/monatsmappeExportService';
import { buildMonatsmappeModel, isValidMonthKey } from '../steuerberater/monatsmappeModelService';
import { downloadBackupBlob } from '../backupExportService';
import { getAllAccountingAssignments } from './accountingStore';
import { getChartOfAccounts } from './accountingSettingsService';
import { evaluateAccountingExportReadiness } from './accountingExportGateService';
import { buildBookingExport } from './accountingBookingExportService';
import { buildAccountingExportPackage } from './accountingExportPackageService';
import { getWorkspaceStoreSnapshot } from '../workspace/workspaceStore';
import type { AccountingExportReadiness } from './accountingExportGateService';

export type AccountingExportOutcome =
  | { outcome: 'exported'; fileName: string; documentCount: number; manifest: Record<string, unknown> }
  | { outcome: 'invalid_month' }
  | { outcome: 'forbidden'; detail?: string }
  | { outcome: 'blocked'; readiness: AccountingExportReadiness }
  | { outcome: 'document_load_failed'; failed: Array<{ id: string; fileName: string; detail: string }> }
  | { outcome: 'export_failed'; detail?: string };

export interface AccountingExportRunInput {
  monthKey: string;
  userId: string | null | undefined;
  /** Nur für Tests: umgeht Zugriffsprüfung bzw. Lader. */
  skipGate?: boolean;
  loaders?: MonatsmappeDocumentLoaders;
  download?: (blob: Blob, fileName: string) => void;
}

/** Baut das Paket, ohne es herunterzuladen — testbar ohne Browser. */
export async function buildAccountingExport(
  input: AccountingExportRunInput,
): Promise<{ result: AccountingExportOutcome; blob?: Blob }> {
  if (!isValidMonthKey(input.monthKey)) return { result: { outcome: 'invalid_month' } };

  if (!input.skipGate) {
    const gate = await assertMonatsmappeAllowed({ userId: input.userId });
    if (!gate.allowed) return { result: { outcome: 'forbidden', detail: gate.detail } };
  }

  /*
   * Das Gate **jetzt** erneut. Die Seite kann seit dem Rendern veraltet sein,
   * und ein Export auf einen veralteten Stand wäre genau das, was 06C
   * verhindern soll.
   */
  const readiness = evaluateAccountingExportReadiness(input.monthKey);
  if (!readiness.packageAllowed || !readiness.state.activeClosure) {
    return { result: { outcome: 'blocked', readiness } };
  }

  try {
    const data = collectMonatsmappeInput(input.monthKey);
    const model = buildMonatsmappeModel(data);
    const bookings = buildBookingExport(model, getAllAccountingAssignments(), getChartOfAccounts());

    const built = await buildAccountingExportPackage(
      {
        model,
        bookings,
        closure: readiness.state.activeClosure,
        currentFingerprint: readiness.state.currentFingerprint,
        workspaceId: getWorkspaceStoreSnapshot()?.id ?? '',
        exportedAt: new Date().toISOString(),
      },
      input.loaders ?? (await defaultLoadersFor(data)),
    );

    if (!built.ok) return { result: { outcome: 'document_load_failed', failed: built.failed } };
    return {
      result: {
        outcome: 'exported',
        fileName: built.fileName,
        documentCount: built.documentCount,
        manifest: built.manifest,
      },
      blob: built.blob,
    };
  } catch (error) {
    return {
      result: {
        outcome: 'export_failed',
        detail: error instanceof Error ? error.message : undefined,
      },
    };
  }
}

/**
 * Dieselben Lader wie die Monatsmappe.
 *
 * Über einen dynamischen Import, weil `defaultLoaders` dort modulintern ist —
 * der Umweg über `buildMonatsmappeExport` würde ein zweites ZIP bauen. Statt
 * die Funktion dort zu exportieren und damit ihre Kapselung aufzubrechen, wird
 * hier dieselbe Zusammensetzung gebildet.
 */
async function defaultLoadersFor(
  data: ReturnType<typeof collectMonatsmappeInput>,
): Promise<MonatsmappeDocumentLoaders> {
  const [{ generateApprovedInvoicePdf, generateInvoiceCorrectionPdf }, { getDocumentFileBlob }] =
    await Promise.all([
      import('../invoicePdfService'),
      import('../documentFileStoreService'),
    ]);

  const invoiceById = new Map(data.invoices.map((entry) => [entry.invoice.id, entry.invoice]));
  const refById = new Map(data.fileRefs.map((ref) => [ref.id, ref]));

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

/** Der Nutzerweg: bauen und herunterladen. */
export async function exportAccountingPackage(
  input: AccountingExportRunInput,
): Promise<AccountingExportOutcome> {
  const { result, blob } = await buildAccountingExport(input);
  if (result.outcome !== 'exported' || !blob) return result;
  try {
    (input.download ?? downloadBackupBlob)(blob, result.fileName);
    return result;
  } catch (error) {
    return {
      outcome: 'export_failed',
      detail: error instanceof Error ? error.message : 'download_failed',
    };
  }
}

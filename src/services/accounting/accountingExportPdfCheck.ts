/**
 * FINANZ-CORE-01A (BUH-05) — welche Rechnungen des Monats lassen sich nicht als PDF erzeugen?
 *
 * Das Steuerberater-Paket erzeugt die Rechnungs-PDFs beim Export neu und prüft sie dabei voll.
 * Eine Altrechnung ohne bestätigten Leistungszeitraum liess den Export scheitern — der Status
 * stand trotzdem auf „bereit", und die Meldung nannte weder Beleg noch Grund. Diese Vorprüfung
 * zeigt dieselbe Prüfung schon vor dem Klick, mit Rechnung und Grund.
 *
 * Geprüft werden genau die Rechnungen, deren PDF ins Paket gehört (Ausgangsrechnungen des
 * Monats); die Korrektur-PDF eines Stornos prüft der Export selbst und meldet sie einzeln.
 */
import { validateFinalizedInvoiceForPdf } from '../invoiceValidationService';
import { collectMonatsmappeInput } from '../steuerberater/monatsmappeInputService';
import { buildMonatsmappeModel } from '../steuerberater/monatsmappeModelService';
import type { TranslationKey } from '../../i18n';

export interface AccountingExportPdfProblem {
  invoiceId: string;
  invoiceNumber: string;
  vorgangId: string | null;
  messageKey: TranslationKey;
}

export function findAccountingExportPdfProblems(monthKey: string): AccountingExportPdfProblem[] {
  const input = collectMonatsmappeInput(monthKey);
  const model = buildMonatsmappeModel(input);
  const imPaket = new Set(
    model.ausgangsrechnungen
      .filter((beleg) => beleg.documents.some((source) => source.kind === 'invoice_pdf'))
      .map((beleg) => beleg.id),
  );
  const problems: AccountingExportPdfProblem[] = [];
  for (const { invoice, vorgangId } of input.invoices) {
    if (!imPaket.has(invoice.id)) continue;
    const grund = validateFinalizedInvoiceForPdf(invoice).blockingErrors[0];
    if (grund) {
      problems.push({ invoiceId: invoice.id, invoiceNumber: invoice.number, vorgangId, messageKey: grund.messageKey });
    }
  }
  return problems;
}

/**
 * Die Kennung, mit der der PDF-Lader des Pakets scheitert: der konkrete Prüfgrund, wenn es einen
 * gibt (etwa „Leistungszeitraum nicht bestätigt"), sonst die technische Ursache.
 */
export function pdfLoadFailureDetail(result: {
  reason: string;
  validation?: { blockingErrors: ReadonlyArray<{ messageKey: string }> };
}): string {
  const grund = result.reason === 'validation_failed' ? result.validation?.blockingErrors[0]?.messageKey : undefined;
  return grund ? `pdf_validation_failed:${grund}` : `pdf_${result.reason}`;
}

/**
 * Ein gescheiterter Beleg des Exports in lesbarer Form: der Grund als Übersetzungsschlüssel.
 * Der Lader liefert `pdf_validation_failed:<Prüfgrund>` für Rechnungs-PDFs (siehe
 * `accountingExportRunner`), sonst eine technische Kennung.
 */
export function describeAccountingExportFailure(detail: string): TranslationKey {
  const [kennung, grund] = detail.split(':', 2);
  if (kennung === 'pdf_validation_failed' && grund) return grund as TranslationKey;
  if (kennung?.startsWith('pdf_')) return 'accountingExport.failure.pdf' as TranslationKey;
  if (kennung === 'blob_unavailable' || kennung === 'file_ref_not_found') {
    return 'accountingExport.failure.file' as TranslationKey;
  }
  return 'accountingExport.failure.unknown' as TranslationKey;
}

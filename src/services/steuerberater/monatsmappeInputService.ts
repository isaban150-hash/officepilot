/**
 * REAL-PRODUCT-TEST-01B — die kanonischen Eingangsdaten der Monatsmappe.
 *
 * Genau eine Sammelstelle für alles, was `buildMonatsmappeModel` braucht.
 * Export (ZIP) und sichtbare Monatsübersicht (Steuerberater-Seite, Heute)
 * lesen dieselbe Eingabe — es gibt keine zweite Zählung neben dem Modell.
 * Bewusst ohne JSZip/PDF-Abhängigkeiten, damit die Übersicht leicht bleibt.
 */
import { listInvoiceEntries } from '../invoice/invoiceRegistryService';
import { getAllExpensesFromStore } from '../expenseStore';
import { getDocumentStoreSnapshot } from '../documentService';
import { getInboxItems } from '../inboxService';
import { getDocumentFileRefStoreSnapshot } from '../documentFileStoreService';
import type { MonatsmappeInput } from './monatsmappeModelService';

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

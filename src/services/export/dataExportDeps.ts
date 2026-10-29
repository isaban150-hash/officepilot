/**
 * EINRICHTUNG-01 (AP7; Vertrag 1.24) — die echten Bausteine des lesbaren Exports. Getrennt vom Ablauf
 * (`dataExportService`), damit dessen Tests Kontowechsel, Rollenentzug, späte Antworten und Abbruch nachstellen können.
 *
 * Keine neue Engine: Abzug über den bestehenden Abgleich, Dateien über die vorhandenen Speicher- und Cloud-Wege (ohne
 * Übernahme in den lokalen Bestand), Finanzzustände über `collectUnconfirmedFinancialSources` (FINANZ-CORE-01A),
 * Download nach dem Muster aus AP0 (`downloadBackupBlob`).
 */
import { getSupabaseClient, isSupabaseConfigured } from '../../lib/supabase';
import type { AppPersistedState, CompanyDocument } from '../../types/models';
import type { SyncOutboxEntry } from '../../types/sync';
import { collectUnconfirmedFinancialSources, type UnconfirmedFinancialSource } from '../accounting/unconfirmedFinancialSources';
import { downloadBackupBlob } from '../backupExportService';
import { downloadWorkspaceFileBytes } from '../document/intakeCloudSyncService';
import { isGeneratedInvoiceDocumentKind } from '../document/generatedInvoiceDocumentKind';
import { getDocumentFileBlob, getDocumentFileRefStoreSnapshot } from '../documentFileStoreService';
import { getDocumentFileRepresentationBindingStoreSnapshot } from '../documentFileRepresentationBindingStoreService';
import { downloadEmailAttachment, rpcListEmailMessages } from '../email/emailMessageCloudService';
import { isPayoutReceiptDocumentId } from '../employee/payoutReceiptDocumentId';
import { getUnconfirmedInvoicePaymentKeys } from '../invoice/invoicePaymentConfirmationStore';
import { resolveInvoiceNet } from '../invoice/invoiceNetResolution';
import { getOpenAmount } from '../invoicePaymentService';
import { isBusinessLetterDocument } from '../letter/businessLetterArchiveService';
import { isOwnOfferDocument } from '../offer/offerArchiveService';
import { buildPersistedStateSnapshot, getLastPersistSuccess } from '../persistenceService';
import { resolveInvoiceBelegDatum } from '../steuerberater/monatsmappeModelService';
import { getActiveStorageAccount, getActiveStorageKey } from '../storage/storageScopeService';
import { isSupabaseSyncAllowed } from '../sync/cloudSyncAllowlist';
import { isSyncIdentityHaltReport } from '../sync/syncCoordinator';
import { getSyncOutboxSnapshot } from '../sync/syncOutboxService';
import { isOutboxEntryHeld } from '../sync/syncOutboxOriginService';
import { bindDirectOperation } from '../sync/syncRunIdentityService';
import { runSyncFromUi } from '../sync/syncUiService';
import { getActiveWorkspaceAccessRecord, refreshWorkspaceAccess } from '../workspace/workspaceAccessService';
import { resolveWorkspaceDataExportAccess, resolveWorkspaceWriteAccess } from '../workspace/workspaceRoleService';
import { getWorkspaceStoreSnapshot } from '../workspace/workspaceStore';
import type { DataExportGap } from './dataExportOverview';
import type { DataExportDeps } from './dataExportService';

const QUELLE: Record<UnconfirmedFinancialSource['sourceType'], { area: string; label: string }> = {
  expense: { area: 'Ausgaben', label: 'Ausgabe' },
  employee_payment: { area: 'Mitarbeiterzahlungen', label: 'Mitarbeiterzahlung' },
  accounting_assignment: { area: 'Kontierungen', label: 'Kontierung' },
  invoice_payment: { area: 'Zahlungseingänge', label: 'Zahlung zur Rechnung' },
};

const GRUND: Record<UnconfirmedFinancialSource['reason'], string> = {
  ausstehend: 'wartet auf den Abgleich',
  wiederholbar: 'Abgleich gescheitert, wird wiederholt',
  konflikt: 'Konflikt mit dem Cloud-Stand',
  abgewiesen_ungeklaert: 'vom Server abgewiesen, ungeklärt',
  neuanlage_abgewiesen: 'Neuanlage vom Server abgewiesen',
  nicht_gesichert: 'nicht vom Server bestätigt',
};

/**
 * D-05.7 — offene, abgewiesene oder unbestätigte Finanzzustände aller Monate mit Finanzdaten, je Quelle einmal (mit dem
 * ersten betroffenen Monat). Nur Feststellung: kein Abschluss, keine Übergabe, kein Exportstatus.
 */
export function collectDataExportFinanceGaps(
  state: AppPersistedState,
  outbox: readonly SyncOutboxEntry[],
  cloudMode: boolean,
  unconfirmedInvoicePayments: ReadonlySet<string>,
): DataExportGap[] {
  const invoices = (state.invoiceEntries ?? []).map((entry) => entry.invoice);
  const expenses = state.expenses ?? [];
  const employeePayments = state.employeePayments ?? [];
  const monate = new Set<string>();
  const merke = (value: string | null | undefined) => {
    if (value && /^\d{4}-\d{2}/.test(value)) monate.add(value.slice(0, 7));
  };
  for (const expense of expenses) {
    merke(expense.issueDate);
    for (const payment of expense.payments ?? []) merke(payment.date);
  }
  for (const invoice of invoices) {
    merke(resolveInvoiceBelegDatum(invoice));
    for (const payment of invoice.payments ?? []) merke(payment.date);
  }
  for (const payment of employeePayments) merke(payment.paymentDate);
  for (const entry of outbox) for (const monat of entry.affectedMonths ?? []) merke(monat);

  const inputs = {
    outbox,
    expenses,
    employeePayments,
    assignments: state.accountingAssignments ?? [],
    invoices,
    unconfirmedInvoicePayments,
    cloudMode,
  };
  const erste = new Map<string, { monat: string; quelle: UnconfirmedFinancialSource }>();
  for (const monat of [...monate].sort()) {
    for (const quelle of collectUnconfirmedFinancialSources(monat, inputs)) {
      const key = `${quelle.sourceType}:${quelle.sourceId}:${quelle.paymentId ?? ''}:${quelle.reason}`;
      if (!erste.has(key)) erste.set(key, { monat, quelle });
    }
  }
  return [...erste.values()].map(({ monat, quelle }) => ({
    kind: 'finance_unconfirmed' as const,
    area: QUELLE[quelle.sourceType].area,
    description: `${QUELLE[quelle.sourceType].label}${quelle.paymentId ? ` (Zahlung ${quelle.paymentId})` : ''}: ${GRUND[quelle.reason]}; wirkt ab ${monat}. Monatsabschluss und Steuerberater-Paket bleiben nach ihren eigenen Regeln.`,
    reference: quelle.sourceId,
  }));
}

const ordnerCache = new WeakMap<AppPersistedState, { ausgaben: Set<string>; mitarbeiter: Set<string> }>();

/** Ordner im ZIP: gespeicherte erzeugte PDFs unter `pdf/…`, Originale unter `dateien/<bereich>/…`. */
export function dataExportDocumentFolder(document: CompanyDocument, state: AppPersistedState): string {
  if (isOwnOfferDocument(document)) return 'pdf/angebote';
  if (isBusinessLetterDocument(document)) return 'pdf/briefe';
  if (isPayoutReceiptDocumentId(document.id)) return 'pdf/quittungen';
  if (isGeneratedInvoiceDocumentKind(document)) return 'dateien/rechnungen';
  let sets = ordnerCache.get(state);
  if (!sets) {
    const ausgaben = new Set<string>();
    for (const expense of state.expenses ?? []) {
      if (expense.archiveDocumentId) ausgaben.add(expense.archiveDocumentId);
      for (const payment of expense.payments ?? []) if (payment.proofDocumentId) ausgaben.add(payment.proofDocumentId);
    }
    const mitarbeiter = new Set<string>();
    for (const payment of state.employeePayments ?? []) if (payment.proofDocumentId) mitarbeiter.add(payment.proofDocumentId);
    sets = { ausgaben, mitarbeiter };
    ordnerCache.set(state, sets);
  }
  if (sets.ausgaben.has(document.id)) return 'dateien/ausgaben';
  if (sets.mitarbeiter.has(document.id)) return 'dateien/mitarbeiterzahlungen';
  return 'dateien/dokumente';
}

export function createDefaultDataExportDeps(input: { userEmail: string }): DataExportDeps {
  const cloudConfigured = isSupabaseConfigured();
  const schreibauskunft = () => resolveWorkspaceWriteAccess({ userId: getActiveStorageAccount()?.userId ?? null, cloudConfigured });
  return {
    now: () => new Date(),
    cloudConfigured: () => cloudConfigured && schreibauskunft().reason !== 'local_only',
    storageKey: getActiveStorageKey,
    account: () => ({ userId: getActiveStorageAccount()?.userId ?? null, email: input.userEmail }),
    workspaceId: () => getWorkspaceStoreSnapshot()?.id ?? null,
    bind: (startStorageKey) => bindDirectOperation(getSupabaseClient(), startStorageKey),
    refreshRole: async (client) => {
      const result = await refreshWorkspaceAccess(client ?? undefined);
      return result.ok ? result.record.role : null;
    },
    currentRole: () => getActiveWorkspaceAccessRecord()?.role ?? null,
    localExportAllowed: () => resolveWorkspaceDataExportAccess(schreibauskunft()),
    outbox: getSyncOutboxSnapshot,
    isHeld: isOutboxEntryHeld,
    cloudSyncAllowed: isSupabaseSyncAllowed,
    pull: async () => {
      const vorher = getActiveStorageKey();
      try {
        const report = await runSyncFromUi();
        if (getActiveStorageKey() !== vorher || report.errors.some((error) => error.outboxId === 'storage-scope-changed')) return 'scope_changed';
        return isSyncIdentityHaltReport(report) || report.errorCount > 0 ? 'failed' : 'ok';
      } catch {
        return 'failed';
      }
    },
    snapshot: buildPersistedStateSnapshot,
    lastPersistOk: getLastPersistSuccess,
    fileRefs: getDocumentFileRefStoreSnapshot,
    bindings: getDocumentFileRepresentationBindingStoreSnapshot,
    readLocalFile: (ref) => getDocumentFileBlob(ref),
    downloadCloudFile: (ref, client) =>
      downloadWorkspaceFileBytes({
        storagePath: ref.cloud?.storagePath ?? '',
        expectedHash: ref.contentHash ?? '',
        expectedSize: ref.fileSize,
        client: client ?? undefined,
      }),
    listSentEmails: (workspaceId, client) => rpcListEmailMessages({ workspaceId, limit: 500 }, client ?? undefined),
    downloadEmailAttachment: (attachment, client) => downloadEmailAttachment(attachment, client ?? undefined),
    unconfirmedInvoicePayments: getUnconfirmedInvoicePaymentKeys,
    unconfirmedFinance: (state, outbox, cloud) => collectDataExportFinanceGaps(state, outbox, cloud, getUnconfirmedInvoicePaymentKeys()),
    invoiceNetCents: (invoice) => {
      const result = resolveInvoiceNet(invoice);
      return result.ok ? result.netCents : null;
    },
    invoiceOpenAmount: getOpenAmount,
    documentFolder: dataExportDocumentFolder,
    download: (blob, fileName) => {
      const { revoke } = downloadBackupBlob(blob, fileName);
      return { revoke };
    },
  };
}

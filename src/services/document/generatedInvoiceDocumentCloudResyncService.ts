/**
 * FINANZ-CORE-01A (STO-07) — das Archivdokument einer freigegebenen Rechnung
 * automatisch in die Cloud nachholen.
 *
 * Bei der Freigabe entsteht das Archivdokument lokal, danach wird es in die
 * Cloud gesendet (GENERATED-INVOICE-DOCUMENT-CLOUD-05C1). Scheiterte dieser
 * letzte Schritt, blieb es bisher für immer nur auf diesem Gerät: Ein
 * Wiederholungsweg war vorgesehen („Das ist 05D"), aber nie gebaut. Andere
 * Geräte bekamen den Beleg nie, und die E-Rechnungsbindung meldete dauerhaft
 * `einvoice_binding_pending: Rechnungsbeleg liegt noch nicht in der Cloud`.
 *
 * Derselbe Weg wie bei der Freigabe, nur später:
 *
 *   - Grundlage ist ein **vollständiger** Abzug der Cloud-Dokumente samt
 *     Grabsteinen. Fehlt zu einer Rechnung dort jede Zeile, wird gesendet; ein
 *     gelöschtes Dokument wird nie wiederbelebt.
 *   - Gesendet wird das vorhandene lokale Dokument mit seiner Kennung; der
 *     Server ist über die Rechnung idempotent (`linked_invoice_id`) — es kann
 *     keine zweite Zeile entstehen.
 *   - Nur Dokumente freigegebener Rechnungen; Fremdbelege und Altbelege ohne
 *     Belegart reisen weiterhin nicht (`isCloudEligibleGeneratedInvoiceDocument`).
 *   - Ein Lauf frühestens alle zehn Minuten; ein gescheiterter Versand wird
 *     frühestens nach diesem Abstand wiederholt, ein Konflikt in dieser
 *     Sitzung nicht.
 *
 * Lokal wird nichts verändert; die kanonische Cloud-Zeile führt der nächste
 * Dokument-Abzug wie gewohnt zusammen.
 */
import type { CompanyDocument } from '../../types/models';
import { syncGeneratedInvoiceDocumentToCloud, type GeneratedInvoiceDocumentSyncOutcome } from '../invoiceArchiveService';
import { getAllDocuments } from '../documentService';
import { findInvoiceById } from '../invoice/invoiceRegistryService';
import { isEntitySyncActive } from '../sync/syncMetaService';
import { isCloudEligibleGeneratedInvoiceDocument } from './documentCloudPullOrchestrator';
import {
  GENERATED_INVOICE_DOCUMENT_KIND,
  pullDocumentsFromCloud,
  type DocumentCloudPullResult,
} from './workspaceDocumentCloudService';

const MIN_INTERVAL_MS = 10 * 60 * 1000;

export interface GeneratedInvoiceDocumentResyncReport {
  skipped?: 'throttled' | 'pull_failed';
  candidates: number;
  synced: number;
  failed: number;
}

export interface GeneratedInvoiceDocumentResyncDeps {
  now?: () => number;
  documents?: () => CompanyDocument[];
  isInvoiceFinalized?: (invoiceId: string) => boolean;
  pull?: () => Promise<DocumentCloudPullResult>;
  push?: (document: CompanyDocument) => Promise<GeneratedInvoiceDocumentSyncOutcome>;
}

let lastRunAt: number | null = null;
let inFlight: Promise<GeneratedInvoiceDocumentResyncReport> | null = null;
const failedAt = new Map<string, number>();
const conflicted = new Set<string>();

function defaultIsInvoiceFinalized(invoiceId: string): boolean {
  const invoice = findInvoiceById(invoiceId);
  return invoice?.status === 'vorbereitet' || invoice?.status === 'versendet';
}

async function run(
  deps: GeneratedInvoiceDocumentResyncDeps,
  now: number,
): Promise<GeneratedInvoiceDocumentResyncReport> {
  const report: GeneratedInvoiceDocumentResyncReport = { candidates: 0, synced: 0, failed: 0 };
  const pulled = await (deps.pull ?? (() => pullDocumentsFromCloud()))();
  if (pulled.outcome !== 'synced') return { ...report, skipped: 'pull_failed' };
  lastRunAt = now;

  // Grabsteine eingeschlossen: Eine gelöschte Zeile beweist, dass die Cloud den Beleg kennt.
  const known = new Set(
    pulled.rows
      .filter((row) => row.documentKind === GENERATED_INVOICE_DOCUMENT_KIND)
      .map((row) => row.linkedInvoiceId),
  );
  const isFinalized = deps.isInvoiceFinalized ?? defaultIsInvoiceFinalized;
  const push = deps.push ?? syncGeneratedInvoiceDocumentToCloud;

  for (const document of (deps.documents ?? getAllDocuments)()) {
    if (!isEntitySyncActive(document) || !isCloudEligibleGeneratedInvoiceDocument(document)) continue;
    const invoiceId = document.linkedInvoiceId!.trim();
    if (known.has(invoiceId) || conflicted.has(invoiceId) || !isFinalized(invoiceId)) continue;
    const lastFailure = failedAt.get(invoiceId);
    if (lastFailure !== undefined && now - lastFailure < MIN_INTERVAL_MS) continue;
    report.candidates += 1;
    const outcome = await push(document);
    if (outcome === 'synced') {
      failedAt.delete(invoiceId);
      known.add(invoiceId);
      report.synced += 1;
    } else if (outcome === 'conflict') {
      conflicted.add(invoiceId);
      report.failed += 1;
    } else if (outcome !== 'not_applicable' && outcome !== 'supabase_not_configured') {
      failedAt.set(invoiceId, now);
      report.failed += 1;
    }
  }
  return report;
}

/** Ein Nachholungslauf; gleichzeitige Aufrufe teilen sich denselben Lauf. */
export function resyncGeneratedInvoiceDocuments(
  deps: GeneratedInvoiceDocumentResyncDeps = {},
  options: { force?: boolean } = {},
): Promise<GeneratedInvoiceDocumentResyncReport> {
  if (inFlight) return inFlight;
  const now = (deps.now ?? Date.now)();
  if (!options.force && lastRunAt !== null && now - lastRunAt < MIN_INTERVAL_MS) {
    return Promise.resolve({ candidates: 0, synced: 0, failed: 0, skipped: 'throttled' });
  }
  inFlight = run(deps, now)
    .catch(() => ({ candidates: 0, synced: 0, failed: 0, skipped: 'pull_failed' as const }))
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

/** Nur für Tests. */
export function resetGeneratedInvoiceDocumentResyncForTests(): void {
  lastRunAt = null;
  inFlight = null;
  failedAt.clear();
  conflicted.clear();
}

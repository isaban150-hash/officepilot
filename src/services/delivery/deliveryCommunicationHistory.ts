/**
 * E-MAIL-07C — die Kommunikationshistorie eines Kunden bzw. Vorgangs.
 *
 * Quellen, zusammengeführt über die Versand-Kennung (nie doppelt):
 *   1. `list_workspace_document_deliveries_for_context` — Versandaufträge mit
 *      gespeichertem Kontext (07C-Spalten customer_id / vorgang_id),
 *   2. `list_workspace_document_deliveries_for_documents` (HALBZEIT-FIX B6,
 *      Migration 20261013120000) — ältere Versandaufträge ohne gespeicherten
 *      Kontext (z. B. 01J) über die Kennungen der Rechnungen und Dokumente,
 *      die nachweislich zu diesem Kunden bzw. Vorgang gehören. EINE Anfrage
 *      für alle Dokumente; nur bei mehr als 250 Kennungen je Art in Blöcken.
 * Danach zählt nur, was nachweislich dazugehört (`deliveryBelongsTo`).
 *
 * Übergang: Kennt die Cloud die Bulk-RPC noch nicht (PGRST202 — Migration
 * nicht angewendet), gilt bis dahin der bisherige, auf versandfähige Dokumente
 * begrenzte Weg je Dokument. Die Erkennung wird nach einer Frist erneut
 * geprüft; nach der Remote-Migration greift der Bulk-Weg von selbst.
 *
 * Nur lesend. Keine Daten werden zusammengeführt oder gelöscht.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseClient } from '../../lib/supabase';
import type { DocumentDelivery } from '../../types/documentDelivery';
import type { CompanyDocument, VorgangInvoice } from '../../types/models';
import { getDocumentStoreSnapshot } from '../documentService';
import { getInvoiceStoreSnapshot } from '../invoice/invoiceStore';
import { parseDocumentDeliveryRow } from './documentDeliveryContract';
import { findArchivedDocumentPdfFileRefId, rpcListWorkspaceDocumentDeliveries } from './documentDeliveryCloudService';
import {
  collectContextDocumentIdentities,
  deliveryBelongsTo,
  groupDeliveryThreads,
  type DeliveryContext,
  type DeliveryThread,
} from './deliveryCommunicationContext';
import { resolveDeliveryWorkspaceId } from './sendDocumentOrchestrator';

export type CommunicationHistoryResult =
  | { ok: true; threads: DeliveryThread[]; incomplete: boolean }
  | { ok: false; error: 'not_configured' | 'workspace_missing' | 'failed' };

/** Serverseitige Grenze der Bulk-RPC je Art (Migration 20261013120000). */
export const BULK_IDS_PER_KIND = 250;
/** Nach dieser Frist wird eine fehlende Bulk-RPC erneut geprüft (Remote-Migration kann inzwischen angewendet sein). */
const BULK_MISSING_RECHECK_MS = 10 * 60 * 1000;
const PARALLEL_LIMIT = 4;

let bulkMissingSince: number | null = null;

/** Nur für Tests: Feature-Erkennung zurücksetzen. */
export function resetBulkDeliveryRpcDetectionForTests(): void {
  bulkMissingSince = null;
}

function isMissingRpc(error: { code?: string; message?: string }): boolean {
  return error.code === 'PGRST202' || /could not find the function/i.test(error.message ?? '');
}

function parseRows(data: unknown): DocumentDelivery[] | null {
  if (!Array.isArray(data)) return null;
  const rows: DocumentDelivery[] = [];
  for (const row of data) {
    const parsed = parseDocumentDeliveryRow(row);
    if (parsed) rows.push(parsed);
  }
  return rows;
}

function chunk<T>(items: T[], size: number): T[][] {
  const blocks: T[][] = [];
  for (let index = 0; index < items.length; index += size) blocks.push(items.slice(index, index + size));
  return blocks;
}

async function inBatches<T, R>(items: T[], run: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  for (let index = 0; index < items.length; index += PARALLEL_LIMIT) {
    results.push(...(await Promise.all(items.slice(index, index + PARALLEL_LIMIT).map(run))));
  }
  return results;
}

/** Eine Rechnung kann einen Versand haben, sobald sie einmal finalisiert war. */
export function invoiceCanHaveDelivery(invoice: Pick<VorgangInvoice, 'status'>): boolean {
  return invoice.status !== 'entwurf';
}

/** Ein Archivdokument kann einen Versand haben, wenn eine PDF-Datei gebunden ist (auch nach dem Löschen). */
export function documentCanHaveDelivery(document: Pick<CompanyDocument, 'id' | 'fileRefId' | 'mimeType'>): boolean {
  return Boolean(findArchivedDocumentPdfFileRefId(document));
}

/** `null` = die Cloud kennt die Kontext-RPC noch nicht. */
async function listByStoredContext(
  supabase: SupabaseClient,
  workspaceId: string,
  target: DeliveryContext,
): Promise<DocumentDelivery[] | null | 'failed'> {
  const { data, error } = await supabase.rpc('list_workspace_document_deliveries_for_context', {
    p_workspace_id: workspaceId,
    p_customer_id: target.customerId ?? null,
    p_vorgang_id: target.vorgangId ?? null,
  });
  if (error) return isMissingRpc(error) ? null : 'failed';
  return parseRows(data) ?? 'failed';
}

/**
 * HALBZEIT-FIX B6 — alle Versandaufträge der übergebenen Dokumente in einer
 * Anfrage (je 250 Kennungen je Art ein Block). `'missing'` = RPC in der Cloud
 * noch nicht vorhanden.
 */
async function listByDocumentsBulk(
  supabase: SupabaseClient,
  workspaceId: string,
  identities: { invoiceIds: string[]; documentIds: string[] },
): Promise<DocumentDelivery[] | 'missing' | 'failed'> {
  const invoiceBlocks = chunk(identities.invoiceIds, BULK_IDS_PER_KIND);
  const documentBlocks = chunk(identities.documentIds, BULK_IDS_PER_KIND);
  const rounds = Math.max(invoiceBlocks.length, documentBlocks.length);
  const rows: DocumentDelivery[] = [];
  for (let round = 0; round < rounds; round += 1) {
    const { data, error } = await supabase.rpc('list_workspace_document_deliveries_for_documents', {
      p_workspace_id: workspaceId,
      p_invoice_ids: invoiceBlocks[round] ?? [],
      p_document_ids: documentBlocks[round] ?? [],
    });
    if (error) return isMissingRpc(error) ? 'missing' : 'failed';
    const parsed = parseRows(data);
    if (!parsed) return 'failed';
    rows.push(...parsed);
  }
  return rows;
}

/** Übergangsweg bis zur Remote-Migration: je versandfähigem Dokument eine Lese-RPC. */
async function listByDocumentsSingly(
  supabase: SupabaseClient,
  workspaceId: string,
  identities: { invoiceIds: string[]; documentIds: string[] },
): Promise<{ rows: DocumentDelivery[]; incomplete: boolean }> {
  const perInvoice = await inBatches(identities.invoiceIds, (clientInvoiceId) =>
    rpcListWorkspaceDocumentDeliveries({ workspaceId, identity: { clientInvoiceId } }, supabase),
  );
  const perDocument = await inBatches(identities.documentIds, (clientDocumentId) =>
    rpcListWorkspaceDocumentDeliveries({ workspaceId, identity: { kind: 'other', clientDocumentId } }, supabase),
  );
  const rows: DocumentDelivery[] = [];
  let incomplete = false;
  for (const result of [...perInvoice, ...perDocument]) {
    if (result.ok) rows.push(...result.deliveries);
    else incomplete = true;
  }
  return { rows, incomplete };
}

export async function loadCommunicationHistory(
  target: DeliveryContext,
  deps: { client?: SupabaseClient | null; workspaceId?: string; now?: () => number } = {},
): Promise<CommunicationHistoryResult> {
  if (!target.customerId && !target.vorgangId) return { ok: true, threads: [], incomplete: false };
  const supabase = deps.client ?? getSupabaseClient();
  if (!supabase) return { ok: false, error: 'not_configured' };
  const workspaceId = deps.workspaceId ?? resolveDeliveryWorkspaceId();
  if (!workspaceId) return { ok: false, error: 'workspace_missing' };
  const now = deps.now ?? Date.now;

  const identities = collectContextDocumentIdentities(target, {
    invoices: getInvoiceStoreSnapshot()
      .filter((entry) => invoiceCanHaveDelivery(entry.invoice))
      .map((entry) => ({ id: entry.invoice.id })),
    documents: getDocumentStoreSnapshot()
      .filter((document) => documentCanHaveDelivery(document))
      .map((document) => ({ id: document.id })),
  });
  const hasDocuments = identities.invoiceIds.length > 0 || identities.documentIds.length > 0;

  let incomplete = false;
  const collected = new Map<string, DocumentDelivery>();
  const add = (deliveries: DocumentDelivery[]) => {
    for (const delivery of deliveries) collected.set(delivery.id, delivery);
  };

  const stored = await listByStoredContext(supabase, workspaceId, target);
  if (stored === 'failed') incomplete = true;
  else if (stored) add(stored);

  if (hasDocuments) {
    const bulkKnownMissing = bulkMissingSince !== null && now() - bulkMissingSince < BULK_MISSING_RECHECK_MS;
    const bulk = bulkKnownMissing ? 'missing' : await listByDocumentsBulk(supabase, workspaceId, identities);
    if (bulk === 'missing') {
      if (!bulkKnownMissing) bulkMissingSince = now();
      const single = await listByDocumentsSingly(supabase, workspaceId, identities);
      add(single.rows);
      if (single.incomplete) incomplete = true;
    } else if (bulk === 'failed') {
      incomplete = true;
    } else {
      bulkMissingSince = null;
      add(bulk);
    }
  }

  if (collected.size === 0 && incomplete && stored === 'failed') return { ok: false, error: 'failed' };
  const relevant = [...collected.values()].filter((delivery) => deliveryBelongsTo(delivery, target));
  return { ok: true, threads: groupDeliveryThreads(relevant), incomplete };
}

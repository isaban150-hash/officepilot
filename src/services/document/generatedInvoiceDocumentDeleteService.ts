/**
 * OFFICEPILOT-GENERATED-DOCUMENT-CLOUD-WIRING-05C1B — Löschen mit Cloud-Grabstein.
 *
 * Ein Grabstein-RPC allein genügt nicht: Solange die reale Löschaktion ihn
 * nicht benutzt, verschwindet das Dokument lokal, während die aktive Cloud-
 * Zeile stehen bleibt — und der nächste Bootstrap bringt es zurück.
 *
 * Deshalb dieselbe Reihenfolge wie beim sicheren Zahlungs-Reversal:
 * **erst die Cloud, dann lokal**. Umgekehrt entstünde der gefährlichste
 * Zustand — lokal gelöscht, Cloud aktiv.
 *
 * Betroffen ist ausschliesslich das erzeugte Ausgangsrechnungs-Dokument.
 * Tankbelege, Verträge, Briefe und Fotos behalten unverändert den rein lokalen
 * Löschweg aus fa953da.
 */
import { deleteDocument, getDocumentById } from '../documentService';
import type { CompanyDocument } from '../../types/models';
import {
  isDocumentCloudSynced,
  pullDocumentsFromCloud,
  tombstoneDocumentInCloud,
} from './workspaceDocumentCloudService';
import { isCloudEligibleGeneratedInvoiceDocument } from './documentCloudPullOrchestrator';

/** Fehlerschlüssel, wenn die Cloud-Löschung nicht bewiesen werden konnte. */
export const DOCUMENT_DELETE_CLOUD_UNCONFIRMED_KEY = 'document.delete.cloudUnconfirmed';

export type GeneratedInvoiceDocumentDeleteResult =
  | { ok: true; document: CompanyDocument }
  | { ok: false; errorKey: string };

/**
 * Löscht ein Dokument — für erzeugte Rechnungsdokumente erst nach bewiesener
 * Cloud-Löschung.
 *
 * Der Ablauf:
 *
 *   1. Fremddokument? Dann unverändert der bestehende lokale Weg.
 *   2. Cloud-Grabstein setzen. `synced` → lokal löschen.
 *   3. Sonst **nachweisen**: Ein erfolgreicher Pull, in dem diese Rechnung kein
 *      aktives Dokument hat, beweist, dass keine Kopie zurückkehren kann.
 *      Erst dieser Beweis erlaubt das lokale Löschen.
 *   4. Ohne Beweis: kein Löschen, sichtbarer Grund.
 *
 * `supabase_not_configured` ist ausdrücklich **kein** Beweis. Es heisst „ich
 * kann nicht nachsehen", nicht „dort ist nichts".
 */
export async function deleteGeneratedInvoiceDocumentWithCloud(
  documentId: string,
): Promise<GeneratedInvoiceDocumentDeleteResult> {
  const document = getDocumentById(documentId);
  if (!document) return { ok: false, errorKey: 'document.notFound' };

  // Fremddokumente: unveränderter lokaler Löschweg, kein einziger Cloud-Aufruf.
  if (!isCloudEligibleGeneratedInvoiceDocument(document)) {
    return finishLocalDelete(documentId);
  }

  const tombstone = await tombstoneDocumentInCloud({ clientDocumentId: documentId });
  if (isDocumentCloudSynced(tombstone.outcome)) {
    return finishLocalDelete(documentId);
  }

  /*
   * Der Nachweisversuch. Er ersetzt die Stornierung nicht — er beantwortet nur
   * die Frage, ob es überhaupt etwas zu stornieren gab. Ein Dokument, das nie
   * in die Cloud gelangt ist, darf nicht für immer unlöschbar sein.
   */
  const invoiceId = document.linkedInvoiceId!.trim();
  const pulled = await pullDocumentsFromCloud();
  if (pulled.outcome !== 'synced') {
    return { ok: false, errorKey: DOCUMENT_DELETE_CLOUD_UNCONFIRMED_KEY };
  }

  const knownActive = pulled.rows.some(
    (row) => row.linkedInvoiceId === invoiceId && !row.deletedAt,
  );
  if (knownActive) {
    // Es gibt sie, und die Stornierung ist gescheitert. Kein Scheinerfolg.
    return { ok: false, errorKey: DOCUMENT_DELETE_CLOUD_UNCONFIRMED_KEY };
  }

  return finishLocalDelete(documentId);
}

/** Der bestehende Soft-Delete aus fa953da — unverändert, nur nachgelagert. */
function finishLocalDelete(documentId: string): GeneratedInvoiceDocumentDeleteResult {
  const result = deleteDocument(documentId);
  if (!result.success) return { ok: false, errorKey: result.errorKey };
  return { ok: true, document: result.document };
}

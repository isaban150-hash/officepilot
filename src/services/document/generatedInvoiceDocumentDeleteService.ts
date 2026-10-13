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
 * Tankbelege, Verträge, Briefe und Fotos behalten den lokalen Löschweg aus
 * fa953da — seit BARZAHLUNG-V1 NACHTRAG 1 mit einer einzigen lesenden
 * Rückfrage vorab, ob das Dokument der Nachweis einer Zahlung ist.
 */
import {
  DOCUMENT_DELETE_FINALIZED_INVOICE_KEY,
  deleteDocument,
  getDocumentById,
  isFinalizedInvoiceArchiveDocument,
} from '../documentService';
import type { CompanyDocument } from '../../types/models';
import {
  isDocumentCloudSynced,
  isDocumentPaymentProofInCloud,
  pullDocumentsFromCloud,
  tombstoneDocumentInCloud,
} from './workspaceDocumentCloudService';
import { isCloudEligibleGeneratedInvoiceDocument } from './documentCloudPullOrchestrator';
import { isFinalPermissionDenialMessage } from '../sync/syncRoleDenial';
import {
  resolveWorkspaceWriteAccess,
  UNKNOWN_CLOUD_ACTOR,
  type WorkspaceActor,
} from '../workspace/workspaceRoleService';

/** Die Ablehnung aus `tombstone_workspace_document` (20261019120000). */
const FINALIZED_INVOICE_SERVER_MESSAGE = 'festgeschriebenen Rechnung kann nicht geloescht werden';

/** Fehlerschlüssel, wenn die Cloud-Löschung nicht bewiesen werden konnte. */
export const DOCUMENT_DELETE_CLOUD_UNCONFIRMED_KEY = 'document.delete.cloudUnconfirmed';

/** GO-LIVE-SECURITY-01 — Löschen ist Verwaltung: nur Inhaber und Admin. */
export const DOCUMENT_DELETE_FORBIDDEN_KEY = 'document.delete.forbidden';

export type GeneratedInvoiceDocumentDeleteResult =
  | { ok: true; document: CompanyDocument }
  | { ok: false; errorKey: string };

/**
 * Löscht ein Dokument — für erzeugte Rechnungsdokumente erst nach bewiesener
 * Cloud-Löschung.
 *
 * Der Ablauf:
 *
 *   1. Fremddokument? Dann der bestehende lokale Weg (nach der Nachweis-Rückfrage).
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
  actor?: WorkspaceActor,
): Promise<GeneratedInvoiceDocumentDeleteResult> {
  /*
   * GO-LIVE-SECURITY-01 — vor jeder lokalen Änderung. Der Server weist
   * Grabsteine von Mitgliedern auf beiden Wegen ab (Archivdokument über den
   * Eingangsweg, Rechnungsdokument über `tombstone_workspace_document`). Ein
   * lokaler Löschversuch erzeugte sonst ein Dokument, das nur auf diesem Gerät
   * fehlt. Ohne Angabe gilt die strengste Annahme (Cloud, Rolle unbekannt).
   */
  if (!resolveWorkspaceWriteAccess(actor ?? UNKNOWN_CLOUD_ACTOR).canWrite) {
    return { ok: false, errorKey: DOCUMENT_DELETE_FORBIDDEN_KEY };
  }

  const document = getDocumentById(documentId);
  if (!document) return { ok: false, errorKey: 'document.notFound' };

  /*
   * BROWSER-ACCEPTANCE-FIX 01 / A1 — Beleg einer festgeschriebenen Rechnung:
   * kein Grabstein-Versuch, kein lokales Löschen.
   */
  if (isFinalizedInvoiceArchiveDocument(document)) {
    return { ok: false, errorKey: DOCUMENT_DELETE_FINALIZED_INVOICE_KEY };
  }

  /*
   * BARZAHLUNG-V1 NACHTRAG 1 — vor dem lokalen Löschen den Server fragen.
   *
   * Eine stornierte Zahlung fällt aus der lokalen Projektion heraus, trägt
   * ihren Nachweis in der Cloud aber weiter. Ohne diese Rückfrage wäre das
   * Dokument lokal verschwunden, und der Abgleich hätte danach für immer
   * abgelehnt — der Nutzer sähe nur ein stilles Scheitern.
   *
   * Kann der Server nicht gefragt werden, bleibt es beim lokalen Schutz:
   * Wir blockieren nicht, nur weil gerade kein Netz da ist. Der Server
   * weist einen unzulässigen Grabstein ohnehin ab.
   */
  const serverBlockiert = await isDocumentPaymentProofInCloud(documentId);
  if (serverBlockiert) {
    return { ok: false, errorKey: 'document.delete.blocked.paymentProof' };
  }

  // Fremddokumente: lokaler Löschweg — ausser der lesenden Nachweis-Rückfrage oben kein Cloud-Aufruf.
  if (!isCloudEligibleGeneratedInvoiceDocument(document)) {
    return finishLocalDelete(documentId);
  }

  const tombstone = await tombstoneDocumentInCloud({ clientDocumentId: documentId });
  if (isDocumentCloudSynced(tombstone.outcome)) {
    return finishLocalDelete(documentId);
  }
  // Der Server kennt die Rechnung als festgeschrieben, auch wenn sie lokal fehlt.
  if (tombstone.outcome === 'failed' && tombstone.detail?.includes(FINALIZED_INVOICE_SERVER_MESSAGE)) {
    return { ok: false, errorKey: DOCUMENT_DELETE_FINALIZED_INVOICE_KEY };
  }
  // GO-LIVE-SECURITY-01 — die Rolle reicht nach Serverstand nicht: nichts wird lokal gelöscht.
  // KONTOSPERRE — ebenso "Kein Zugriff" und account_blocked (gesperrtes Konto, keine Mitgliedschaft).
  if (tombstone.outcome === 'failed' && isFinalPermissionDenialMessage(tombstone.detail)) {
    return { ok: false, errorKey: DOCUMENT_DELETE_FORBIDDEN_KEY };
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

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
  DOCUMENT_DELETE_RETENTION_KEY,
  deleteDocument,
  getDocumentById,
  getDocumentRetention,
  isFinalizedInvoiceArchiveDocument,
} from '../documentService';
import { retentionBlocksDelete } from './documentRetention';
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
import { getActiveStorageAccount, getActiveStorageKey } from '../storage/storageScopeService';
import { bindDirectOperation, type DirectOperationBinding } from '../sync/syncRunIdentityService';
import { getSupabaseClient } from '../../lib/supabase';
import { buildPersistedStateSnapshot } from '../persistenceService';
import { resolveCloudWorkspaceId } from '../workspace/workspaceSyncPayloadService';

/** Die Ablehnung aus `tombstone_workspace_document` (20261019120000). */
const FINALIZED_INVOICE_SERVER_MESSAGE = 'festgeschriebenen Rechnung kann nicht geloescht werden';

/** Fehlerschlüssel, wenn die Cloud-Löschung nicht bewiesen werden konnte. */
export const DOCUMENT_DELETE_CLOUD_UNCONFIRMED_KEY = 'document.delete.cloudUnconfirmed';

/** GO-LIVE-SECURITY-01 — Löschen ist Verwaltung: nur Inhaber und Admin. */
export const DOCUMENT_DELETE_FORBIDDEN_KEY = 'document.delete.forbidden';

/** DOKUMENTE-01 / D-017 — ohne ausdrückliche Prüfbestätigung wird nichts gelöscht. */
export const DOCUMENT_DELETE_RETENTION_CONFIRM_KEY = 'document.delete.retention.confirmRequired';

/** DOKUMENTE-01 (DOK-WEISS-DIREKT) — inzwischen ist ein anderes Konto oder ein anderer Betrieb aktiv. */
export const DOCUMENT_DELETE_IDENTITY_CHANGED_KEY = 'document.delete.identityChanged';

/** DOKUMENTE-01 (DOK-WEISS-DIREKT) — im Kontobereich ohne bestätigte Anmeldung keine Cloud-Löschung. */
export const DOCUMENT_DELETE_IDENTITY_UNCONFIRMED_KEY = 'document.delete.identityUnconfirmed';

/** Der Grund der Aufbewahrungsabweisungen aus 20261125120000 (Frist läuft, Einstufung). */
const RETENTION_SERVER_MARKER = 'Aufbewahrungs';

export interface DocumentDeleteOptions {
  /**
   * DOKUMENTE-01 / D-017 — der Nutzer hat ausdrücklich bestätigt, dass er die
   * Aufbewahrung geprüft hat. Nötig für jedes Dokument ohne laufende Frist:
   * „prüfen" und rechnerisch abgelaufen (Ablaufhemmung, § 147 Abs. 3 AO).
   */
  aufbewahrungGeprueft?: boolean;
}

export type GeneratedInvoiceDocumentDeleteResult =
  | { ok: true; document: CompanyDocument }
  | { ok: false; errorKey: string };

/**
 * Löscht ein Dokument — für erzeugte Rechnungsdokumente erst nach bewiesener
 * Cloud-Löschung.
 *
 * Der Ablauf:
 *
 *   0. Rolle, festgeschriebene Rechnung und — DOKUMENTE-01 / D-017 — Aufbewahrung:
 *      während der Frist nie, sonst nur mit ausdrücklicher Prüfbestätigung.
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
  options: DocumentDeleteOptions = {},
): Promise<GeneratedInvoiceDocumentDeleteResult> {
  /*
   * DOKUMENTE-01 (DOK-WEISS-DIREKT) — der Vorgang gehört dem Bereich (Betrieb, Konto, Sicht), in dem er aufgerufen
   * wurde: festgehalten vor der ersten asynchronen Grenze. Handelt der Aufrufer für ein anderes Konto als das des
   * Bereichs (veraltete Oberfläche), gibt es keinen Vorgang.
   */
  const startBereich = getActiveStorageKey();
  const startKonto = getActiveStorageAccount();
  const startBetrieb = cloudBetriebBeimAufruf();
  if (startKonto && actor?.userId && actor.userId !== startKonto.userId) {
    return { ok: false, errorKey: DOCUMENT_DELETE_IDENTITY_CHANGED_KEY };
  }

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
   * DOKUMENTE-01 / D-017 — vor jedem Cloud-Aufruf. Während der gesetzlichen
   * Frist wird nicht gelöscht. Ohne laufende Frist („prüfen" oder rechnerisch
   * abgelaufen) nur nach ausdrücklicher Bestätigung, dass die Aufbewahrung
   * geprüft ist: Unklare Fälle löscht OfficeTakt nie von selbst.
   */
  if (retentionBlocksDelete(getDocumentRetention(document))) {
    return { ok: false, errorKey: DOCUMENT_DELETE_RETENTION_KEY };
  }
  if (!options.aufbewahrungGeprueft) {
    return { ok: false, errorKey: DOCUMENT_DELETE_RETENTION_CONFIRM_KEY };
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
  /*
   * DOKUMENTE-01 (DOK-WEISS-DIREKT) — ab hier liegen Serverrückfragen zwischen Aufruf und Änderung. Jede Anfrage
   * geht mit bestätigter Anmeldung über den an den Vorgang gebundenen Client; nach jeder Rückfrage und unmittelbar
   * vor jeder Änderung wird geprüft, dass Bereich und Anmeldung noch die des Aufrufs sind. Sonst: Abbruch ohne
   * Erfolg, nichts im neuen Bestand gelöscht oder eingereiht. Die Sperren selbst bleiben, wie sie sind.
   */
  const vorgang = await bindDirectOperation(getSupabaseClient(), startBereich);
  if (!vorgang) return { ok: false, errorKey: DOCUMENT_DELETE_IDENTITY_CHANGED_KEY };
  // Alle Rückfragen gehen an den Betrieb des Aufrufs, nie an den, der beim Senden gerade aktiv wäre.
  const verbindung = vorgang.client
    ? { client: vorgang.client, ...(startBetrieb ? { workspaceId: startBetrieb } : {}) }
    : undefined;

  const serverBlockiert = await isDocumentPaymentProofInCloud(documentId, verbindung);
  if (!(await vorgang.stillValid())) return { ok: false, errorKey: DOCUMENT_DELETE_IDENTITY_CHANGED_KEY };
  if (serverBlockiert) {
    return { ok: false, errorKey: 'document.delete.blocked.paymentProof' };
  }

  // Fremddokumente: lokaler Löschweg — ausser der lesenden Nachweis-Rückfrage oben kein Cloud-Aufruf.
  if (!isCloudEligibleGeneratedInvoiceDocument(document)) {
    return finishLocalDelete(documentId, vorgang);
  }

  // Eine Cloud-Löschung im Kontobereich nur mit bestätigter Anmeldung und deren Zugang — nie mit dem, den das SDK
  // gerade liefert.
  if (startKonto && !vorgang.confirmed) {
    return { ok: false, errorKey: DOCUMENT_DELETE_IDENTITY_UNCONFIRMED_KEY };
  }
  const tombstone = await tombstoneDocumentInCloud({ clientDocumentId: documentId }, verbindung);
  if (!(await vorgang.stillValid())) return { ok: false, errorKey: DOCUMENT_DELETE_IDENTITY_CHANGED_KEY };
  if (isDocumentCloudSynced(tombstone.outcome)) {
    return finishLocalDelete(documentId, vorgang);
  }
  // Der Server kennt die Rechnung als festgeschrieben, auch wenn sie lokal fehlt.
  if (tombstone.outcome === 'failed' && tombstone.detail?.includes(FINALIZED_INVOICE_SERVER_MESSAGE)) {
    return { ok: false, errorKey: DOCUMENT_DELETE_FINALIZED_INVOICE_KEY };
  }
  // DOKUMENTE-01 — der Server kennt eine laufende Frist, die dieses Gerät nicht kannte.
  if (tombstone.outcome === 'failed' && tombstone.detail?.includes(RETENTION_SERVER_MARKER)) {
    return { ok: false, errorKey: DOCUMENT_DELETE_RETENTION_KEY };
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
  const pulled = await pullDocumentsFromCloud(verbindung);
  if (!(await vorgang.stillValid())) return { ok: false, errorKey: DOCUMENT_DELETE_IDENTITY_CHANGED_KEY };
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

  return finishLocalDelete(documentId, vorgang);
}

/** Der Cloud-Betrieb des aktiven Bestands beim Aufruf; ohne lösbaren Betrieb entscheiden die Cloud-Aufrufe wie bisher. */
function cloudBetriebBeimAufruf(): string | undefined {
  try {
    return resolveCloudWorkspaceId(buildPersistedStateSnapshot()).trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Der bestehende Soft-Delete aus fa953da — unverändert, nur nachgelagert.
 *
 * DOKUMENTE-01 (DOK-WEISS-DIREKT) — unmittelbar davor, ohne weiteres Warten: Ist noch der Bereich des Aufrufs aktiv?
 * Nur dann trifft die Löschung (samt Auftrag, der beim Speichern entsteht) dessen Bestand.
 */
function finishLocalDelete(documentId: string, vorgang: DirectOperationBinding): GeneratedInvoiceDocumentDeleteResult {
  if (!vorgang.scopeStillActive()) return { ok: false, errorKey: DOCUMENT_DELETE_IDENTITY_CHANGED_KEY };
  const result = deleteDocument(documentId);
  if (!result.success) return { ok: false, errorKey: result.errorKey };
  return { ok: true, document: result.document };
}

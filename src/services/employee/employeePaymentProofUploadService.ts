/**
 * P1 MITARBEITERZAHLUNGEN — die unterschriebene Quittung als Nachweis einer
 * Mitarbeiterzahlung hochladen.
 *
 * Kein zweiter Dokumentweg: Dieser Dienst ist nur der Adapter von „Datei oder
 * Foto zu dieser Zahlung" zur bestehenden Zweistufe des Uploads
 * (`processDocumentFileForPreview` → `executePendingDocumentDecision`) und zur
 * bestehenden Archivübergabe (`confirmDocumentFilingDecision` →
 * `handoffInboxItemToArchive`). Prüfung, 10-MB-Grenze, OCR, Klassifikation und
 * Duplikaterkennung laufen dort unverändert.
 *
 * Was dieser Adapter selbst entscheidet:
 *  * Berechtigung — nur Inhaber und Verwaltung (dieselbe Schreibfreigabe wie
 *    die Mitarbeiterzahlungen selbst).
 *  * Ziel — der Nachweis gehört zu genau einer, nicht stornierten Zahlung.
 *  * Ablage — erst nach dem ausdrücklichen „Als Nachweis speichern", dann
 *    sofort und dauerhaft archiviert (Mitarbeiter/Zahlungsnachweise/<Jahr>).
 *    Der Eingang bleibt kein aktiver Vorgang, wird nicht zu einem
 *    Steuerberater-unklaren Posten und bietet keine Ausgabe an.
 *  * Kein Überschreiben — „Bestehendes aktualisieren" gibt es hier nicht. Liegt
 *    derselbe Inhalt schon im Archiv, wird dieses Dokument als Nachweis
 *    verwendet; ein fremdes Dokument wird nie verändert.
 */
import { getDocumentById, handoffInboxItemToArchive, updateDocument } from '../documentService';
import {
  buildDocumentFilingDecisionDraft,
  confirmDocumentFilingDecision,
  rebuildFilingDecisionDraft,
} from '../documentFilingDecisionService';
import { resolveImportInboxDocumentOptionsFromIntakeCarry } from '../documentFileIntakeTransformPlanCarryContextService';
import {
  executePendingDocumentDecision,
  isPendingDocumentDecisionResultIntake,
} from '../pendingDocumentDecisionService';
import {
  discardPendingDocumentIntake,
  processDocumentFileForPreview,
  type PendingDocumentIntake,
} from '../pendingDocumentIntakeService';
import { getCompanyProfile } from '../companyProfileService';
import { patchInboxItem } from '../inboxService';
import {
  resolveWorkspaceWriteAccess,
  type WorkspaceWriteAccess,
} from '../workspace/workspaceRoleService';
import type { EmployeePayment } from '../../types/employee';
import { isEmployeePaymentReversed } from '../../types/employee';
import { getEmployeePaymentById, setEmployeePaymentProof } from './employeePaymentService';

export interface EmployeeProofUploadDeps {
  userId?: string | null;
  cloudConfigured?: boolean;
  /** Vorab aufgelöster Zugriff (Tests, Seite); sonst über den Workspace-Resolver. */
  access?: WorkspaceWriteAccess;
}

export type EmployeeProofPrepareError =
  | 'not_permitted'
  | 'not_found'
  | 'reversed'
  | 'too_large'
  | 'invalid_type'
  | 'preview_failed';

export type EmployeeProofPrepareResult =
  | {
      ok: true;
      pending: PendingDocumentIntake;
      fileName: string;
      /** Gleicher Inhalt liegt schon vor — im Archiv (wird verwendet) oder im Eingang. */
      duplicate: { type: 'inbox' | 'document'; id: string } | null;
    }
  | { ok: false; error: EmployeeProofPrepareError };

export type EmployeeProofSaveError =
  | 'not_permitted'
  | 'not_found'
  | 'reversed'
  | 'in_progress'
  | 'duplicate_inbox'
  | 'proof_is_receipt'
  | 'intake_failed'
  | 'filing_failed'
  | 'archive_failed'
  | 'link_failed';

export type EmployeeProofSaveResult =
  | { ok: true; documentId: string; reusedExisting: boolean; payment: EmployeePayment }
  | { ok: false; error: EmployeeProofSaveError; detail?: string; inboxItemId?: string; documentId?: string };

/** Läuft für diese Zahlung gerade eine Ablage? (Doppelklick, parallele Aufrufe) */
const inFlight = new Set<string>();

function accessOf(deps: EmployeeProofUploadDeps): WorkspaceWriteAccess {
  return (
    deps.access ??
    resolveWorkspaceWriteAccess({ userId: deps.userId, cloudConfigured: deps.cloudConfigured ?? false })
  );
}

/** Ziel prüfen: vorhanden und nicht storniert. */
function targetOf(paymentId: string): { ok: true; payment: EmployeePayment } | { ok: false; error: 'not_found' | 'reversed' } {
  const payment = getEmployeePaymentById(paymentId);
  if (!payment) return { ok: false, error: 'not_found' };
  if (isEmployeePaymentReversed(payment)) return { ok: false, error: 'reversed' };
  return { ok: true, payment };
}

/**
 * Stufe 1 — Datei prüfen und die bestehende Vorschau erzeugen. Es wird noch
 * nichts gespeichert; ein Abbruch verwirft die zwischengespeicherte Datei.
 */
export async function prepareEmployeePaymentProofUpload(
  paymentId: string,
  file: File,
  deps: EmployeeProofUploadDeps = {},
): Promise<EmployeeProofPrepareResult> {
  if (accessOf(deps).canWrite !== true) return { ok: false, error: 'not_permitted' };
  const ziel = targetOf(paymentId);
  if (!ziel.ok) return { ok: false, error: ziel.error };

  const preview = await processDocumentFileForPreview(file);
  if (!preview.success) {
    if (preview.error === 'file_too_large') return { ok: false, error: 'too_large' };
    if (preview.error === 'invalid_type') return { ok: false, error: 'invalid_type' };
    return { ok: false, error: 'preview_failed' };
  }
  const match = preview.pending.storageRecommendation.duplicateMatch;
  return {
    ok: true,
    pending: preview.pending,
    fileName: file.name,
    duplicate: match ? { type: match.type, id: match.id } : null,
  };
}

/** Stufe 1 abbrechen — die zwischengespeicherte Datei wird freigegeben, nichts bleibt liegen. */
export function cancelEmployeePaymentProofUpload(pending: PendingDocumentIntake | null | undefined): void {
  discardPendingDocumentIntake(pending);
}

function yearOf(payment: EmployeePayment): string {
  return /^\d{4}/.exec(payment.paymentDate)?.[0] ?? new Date().getFullYear().toString();
}

function linkExisting(paymentId: string, documentId: string): EmployeeProofSaveResult {
  const verknuepft = setEmployeePaymentProof(paymentId, documentId);
  if (verknuepft.success) {
    return { ok: true, documentId, reusedExisting: true, payment: verknuepft.payment };
  }
  if (verknuepft.errorKey === 'employeePayment.error.proofIsReceipt') {
    return { ok: false, error: 'proof_is_receipt', documentId };
  }
  if (verknuepft.errorKey === 'employeePayment.error.reversed') return { ok: false, error: 'reversed' };
  return { ok: false, error: 'link_failed', detail: verknuepft.errorKey, documentId };
}

/**
 * Stufe 2 — „Als Nachweis speichern": dauerhaft ablegen, direkt archivieren,
 * `proofDocumentId` setzen. Geld bewegt sich dabei nicht; an Betrag, Datum
 * oder Art der Zahlung ändert sich nichts.
 */
export async function saveEmployeePaymentProofUpload(
  paymentId: string,
  pending: PendingDocumentIntake,
  deps: EmployeeProofUploadDeps = {},
): Promise<EmployeeProofSaveResult> {
  if (accessOf(deps).canWrite !== true) {
    discardPendingDocumentIntake(pending);
    return { ok: false, error: 'not_permitted' };
  }
  if (inFlight.has(paymentId)) return { ok: false, error: 'in_progress' };
  inFlight.add(paymentId);
  try {
    const ziel = targetOf(paymentId);
    if (!ziel.ok) {
      discardPendingDocumentIntake(pending);
      return { ok: false, error: ziel.error };
    }
    const zahlung = ziel.payment;

    /* Gleicher Inhalt schon vorhanden: nie ein zweites Dokument, nie ein fremdes überschreiben. */
    const duplikat = pending.storageRecommendation.duplicateMatch;
    if (duplikat?.type === 'document') {
      discardPendingDocumentIntake(pending);
      if (!getDocumentById(duplikat.id)) return { ok: false, error: 'intake_failed', detail: 'existing_document_missing' };
      return linkExisting(paymentId, duplikat.id);
    }
    if (duplikat?.type === 'inbox') {
      discardPendingDocumentIntake(pending);
      return { ok: false, error: 'duplicate_inbox', inboxItemId: duplikat.id };
    }

    /* Bestehende Entscheidung → dauerhaft gespeichert, als Eingangsposten. */
    const titel = `Unterschriebene Auszahlungsquittung ${zahlung.receiptReference} – ${zahlung.employeeName}`;
    const ergebnis = await executePendingDocumentDecision(pending, 'save_permanently', {
      importSource: 'upload',
      titleHint: titel,
    });
    if (!isPendingDocumentDecisionResultIntake(ergebnis)) {
      discardPendingDocumentIntake(pending);
      return { ok: false, error: 'intake_failed', detail: 'outcome' in ergebnis ? ergebnis.outcome : 'unknown' };
    }
    if (!ergebnis.success) {
      discardPendingDocumentIntake(pending);
      return { ok: false, error: 'intake_failed', detail: ergebnis.error };
    }
    if (ergebnis.duplicate) {
      const vorhanden = ergebnis.existing;
      if (vorhanden?.type === 'document') return linkExisting(paymentId, vorhanden.id);
      return { ok: false, error: 'duplicate_inbox', inboxItemId: vorhanden?.id };
    }
    /*
     * Festgehalten, nicht geraten: Der Nutzer lädt genau diese Datei als
     * unterschriebene Quittung dieser Zahlung hoch. Die allgemeine Erkennung
     * hielte sie für eine „Quittung" (Ausgabenbeleg) und leitete daraus
     * Kategorie Steuer, den Ordner Eingangsrechnungen und die Empfehlung
     * „Als Ausgabe speichern" ab. Als Lohnunterlage ist sie, was sie ist: ein
     * Mitarbeiterdokument — ohne Ausgabe, abgeheftet unter Personal. Gesetzt
     * vor der Ablagebestätigung, damit Ordner, Gedächtnis und Papierregister
     * dieselbe Einordnung tragen.
     */
    const eingang =
      patchInboxItem(ergebnis.inboxItem.id, {
        classifiedKind: 'lohnunterlagen',
        documentType: 'sonstiges',
        recommendedAction: 'archivieren',
        officePilotSuggestion: `Unterschriebene Auszahlungsquittung zur Mitarbeiterzahlung ${zahlung.receiptReference} – als Nachweis abgelegt, keine Ausgabe.`,
        userModified: true,
      }) ?? ergebnis.inboxItem;

    /* Ablageort ausdrücklich bestätigen — Personal, Mitarbeiter/Zahlungsnachweise/<Jahr>. */
    const jahr = yearOf(zahlung);
    const entwurf = rebuildFilingDecisionDraft(eingang, buildDocumentFilingDecisionDraft(eingang), {
      scope: 'company',
      companyAreaId: 'mitarbeiter',
      digitalPath: `/Mitarbeiter/Zahlungsnachweise/${jahr}/`,
      digitalFolderName: `Zahlungsnachweise ${jahr}`,
      paperFolderId: 'paper-personal',
      paperRegister: 'Lohn',
    });
    const bestaetigt = confirmDocumentFilingDecision(eingang.id, entwurf);
    if (!bestaetigt) return { ok: false, error: 'filing_failed', inboxItemId: eingang.id };

    /* Direkt ins Archiv — ohne „Bestehendes aktualisieren". */
    const firma = getCompanyProfile().companyName?.trim() ?? '';
    const uebergabe = handoffInboxItemToArchive(
      bestaetigt,
      firma,
      resolveImportInboxDocumentOptionsFromIntakeCarry(eingang.id),
    );
    if (!uebergabe.success) {
      return {
        ok: false,
        error: 'archive_failed',
        detail: uebergabe.errorKey,
        inboxItemId: eingang.id,
        ...(uebergabe.document ? { documentId: uebergabe.document.id } : {}),
      };
    }

    /*
     * Die allgemeine Archivübergabe leitet Kategorie und Papierordner aus der
     * Art ab; für eine Lohnunterlage ergibt das „Sonstiges". Der Nachweis einer
     * Mitarbeiterzahlung gehört — wie die Quittung selbst — in die Kategorie
     * Personal und in den bestätigten Papierordner. Nur an diesem eben
     * angelegten Dokument, nie an einem bestehenden.
     */
    const papier = bestaetigt.paperFiling;
    const korrektur: { category?: 'personal'; paperFolder?: NonNullable<typeof papier> } = {};
    if (uebergabe.document.category !== 'personal') korrektur.category = 'personal';
    if (
      papier &&
      (uebergabe.document.paperFolder?.folderId !== papier.folderId ||
        uebergabe.document.paperFolder?.register !== papier.register)
    ) {
      korrektur.paperFolder = { ...papier };
    }
    if (!uebergabe.reusedExistingDocument && Object.keys(korrektur).length > 0) {
      updateDocument(uebergabe.document.id, korrektur);
    }

    const verknuepft = setEmployeePaymentProof(paymentId, uebergabe.document.id);
    if (!verknuepft.success) {
      return { ok: false, error: 'link_failed', detail: verknuepft.errorKey, documentId: uebergabe.document.id };
    }
    return { ok: true, documentId: uebergabe.document.id, reusedExisting: false, payment: verknuepft.payment };
  } finally {
    inFlight.delete(paymentId);
  }
}

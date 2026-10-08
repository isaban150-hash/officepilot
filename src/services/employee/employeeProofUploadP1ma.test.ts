/**
 * P1 MITARBEITERZAHLUNGEN — „Unterschriebene Quittung hochladen".
 *
 * Echte Produktionsfunktionen: Vorschau (`processDocumentFileForPreview`),
 * Entscheidung (`executePendingDocumentDecision`), Ablagebestätigung und
 * Archivübergabe, Blob-Speicher, Duplikaterkennung. Ersetzt wird nur der
 * PDF-Textextraktor (kein pdf.js im Test). Neutrale Beispieldaten.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useDocumentBlobDatabaseReset } from '../../test/documentBlobTestReset';
import {
  cancelEmployeePaymentProofUpload,
  prepareEmployeePaymentProofUpload,
  saveEmployeePaymentProofUpload,
} from './employeePaymentProofUploadService';
import { createEmployee } from './employeeService';
import {
  confirmEmployeePayment,
  getEmployeePaymentById,
  prepareEmployeePaymentConfirmation,
  reverseEmployeePayment,
} from './employeePaymentService';
import { ensurePayoutReceiptArchived, loadPayoutReceiptOriginal, resetPayoutReceiptArchiveForTests } from './payoutReceiptArchiveService';
import { deleteDocument, getAllDocuments, getDocumentById } from '../documentService';
import { getDocumentFileRefById } from '../documentFileStoreService';
import { filterActiveItems, getInboxItems, getInboxStoreSnapshot } from '../inboxService';
import { createExpenseFromInbox, getExpensePrefillForInbox, isDocumentActionAvailable } from '../officeActionService';
import { collectSteuerberaterMonthFindings } from '../steuerberaterOverviewService';
import { hydrateCompanyProfileStore } from '../companyProfileService';
import { setPdfTextExtractorForTests } from '../uploadTextExtractionService';
import { resetSyncClientForTests } from '../sync/syncClientService';
import { getAllExpenses } from '../expenseService';
import { getDocumentMemoryByDocumentId } from '../officePilotMemoryService';
import { buildDocumentExplanation } from '../memory/documentExplanationService';
import { DEFAULT_COMPANY_PROFILE } from '../../data/companyProfileDefaults';
import type { WorkspaceWriteAccess } from '../workspace/workspaceRoleService';
import type { EmployeePayment } from '../../types/employee';

const WS = '00000000-0000-4000-8000-00000000e1c1';
const OWNER: WorkspaceWriteAccess = { canWrite: true, canIntake: true, role: 'owner', reason: 'owner_or_admin' };
const MEMBER: WorkspaceWriteAccess = { canWrite: false, canIntake: true, role: 'member', reason: 'member' };

const QUITTUNG_TEXT =
  'Auszahlungsquittung\nQuittung über eine Barauszahlung\nMitarbeiter/in Erika Beispiel\nBetrag 800,00 €\n' +
  'Ich bestätige, den oben genannten Betrag in bar erhalten zu haben.\nUnterschrift Empfänger/in';

function pdf(marker: string): File {
  const bytes = new TextEncoder().encode(`%PDF-1.4\n${marker}\n%%EOF`);
  return new File([bytes], `quittung-${marker}.pdf`, { type: 'application/pdf' });
}

function barzahlung(betrag = '800'): EmployeePayment {
  const mitarbeiter = createEmployee({ name: 'Erika Beispiel' });
  if (!mitarbeiter.success) throw new Error('mitarbeiter');
  const vorbereitet = prepareEmployeePaymentConfirmation({
    employeeId: mitarbeiter.employee.id,
    kind: 'wage',
    amount: betrag,
    paymentDate: '2026-10-02',
    paymentMethod: 'cash',
  });
  if (!vorbereitet.ok) throw new Error(vorbereitet.errorKey);
  const ergebnis = confirmEmployeePayment(vorbereitet.intent);
  if (!ergebnis.success) throw new Error(ergebnis.errorKey);
  return ergebnis.payment;
}

async function hochladen(paymentId: string, file: File) {
  const vorbereitet = await prepareEmployeePaymentProofUpload(paymentId, file, { access: OWNER });
  if (!vorbereitet.ok) throw new Error(vorbereitet.error);
  return saveEmployeePaymentProofUpload(paymentId, vorbereitet.pending, { access: OWNER });
}

useDocumentBlobDatabaseReset();

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-08T10:00:00.000Z'));
  resetPayoutReceiptArchiveForTests();
  resetSyncClientForTests({
    deviceId: 'dev-a',
    workspaceId: 'local-ws-a',
    serverWorkspaceId: WS,
    createdAt: '2026-01-01T00:00:00.000Z',
    syncPolicy: 'cloud_ready',
  });
  hydrateCompanyProfileStore({ ...DEFAULT_COMPANY_PROFILE, companyName: 'Beispiel Haustechnik', legalForm: 'GmbH' });
  setPdfTextExtractorForTests(() => QUITTUNG_TEXT);
});

afterEach(() => {
  setPdfTextExtractorForTests(null);
  vi.useRealTimers();
});

describe('Unterschriebene Quittung als Nachweis', () => {
  it('Vorschau speichert nichts; Abbrechen hinterlässt nichts', async () => {
    const zahlung = barzahlung();
    const vorbereitet = await prepareEmployeePaymentProofUpload(zahlung.id, pdf('vorschau'), { access: OWNER });
    expect(vorbereitet.ok).toBe(true);
    expect(getInboxStoreSnapshot()).toHaveLength(0);
    expect(getAllDocuments()).toHaveLength(0);
    if (vorbereitet.ok) cancelEmployeePaymentProofUpload(vorbereitet.pending);
    expect(getEmployeePaymentById(zahlung.id)?.proofDocumentId).toBeUndefined();
    expect(getInboxStoreSnapshot()).toHaveLength(0);
  });

  it('„Als Nachweis speichern" archiviert direkt und setzt proofDocumentId', async () => {
    const zahlung = barzahlung();
    const ergebnis = await hochladen(zahlung.id, pdf('unterschrieben-1'));
    expect(ergebnis).toMatchObject({ ok: true, reusedExisting: false });
    if (!ergebnis.ok) return;

    const dokument = getDocumentById(ergebnis.documentId)!;
    expect(dokument).toBeTruthy();
    expect(dokument.title).toBe(`Unterschriebene Auszahlungsquittung ${zahlung.receiptReference} – Erika Beispiel`);
    expect(dokument.digitalFolder.path).toBe('/Mitarbeiter/Zahlungsnachweise/2026/');
    expect(dokument.paperFolder).toMatchObject({ folderId: 'paper-personal', register: 'Lohn' });
    /* Dauerhaft gespeichert, nicht nur vorübergehend lokal. */
    expect(getDocumentFileRefById(dokument.fileRefId!)?.lifecycleStatus).not.toBe('temp');

    expect(getEmployeePaymentById(zahlung.id)?.proofDocumentId).toBe(dokument.id);
    /* Geldfelder unberührt. */
    expect(getEmployeePaymentById(zahlung.id)).toMatchObject({ amount: 800, paymentDate: '2026-10-02', kind: 'wage' });
  });

  it('wird als Mitarbeiterdokument eingeordnet — Personal, einheitlicher Papierordner, keine Ausgabenempfehlung', async () => {
    const zahlung = barzahlung();
    const ergebnis = await hochladen(zahlung.id, pdf('einordnung'));
    if (!ergebnis.ok) throw new Error(ergebnis.error);
    const dokument = getDocumentById(ergebnis.documentId)!;
    expect(dokument).toMatchObject({ category: 'personal', classifiedKind: 'lohnunterlagen' });
    expect(dokument.paperFolder).toMatchObject({ folderId: 'paper-personal', register: 'Lohn' });
    /* Die Ablagekarte liest das Gedächtnis — es trägt denselben Ordner. */
    expect(getDocumentMemoryByDocumentId(dokument.id)?.paperFolder).toMatchObject({ folderId: 'paper-personal', register: 'Lohn' });
    const erklaerung = buildDocumentExplanation({ documentId: dokument.id });
    expect(JSON.stringify(erklaerung ?? {})).not.toMatch(/Als Ausgabe speichern|Ausgabenbeleg/);
  });

  it('bleibt kein aktiver Eingang, bietet keine Ausgabe an und ist kein unklarer Steuerberater-Fall', async () => {
    const zahlung = barzahlung();
    const ergebnis = await hochladen(zahlung.id, pdf('unterschrieben-2'));
    if (!ergebnis.ok) throw new Error(ergebnis.error);

    const eingang = getInboxStoreSnapshot().find((item) => item.archiveDocumentId === ergebnis.documentId)!;
    expect(eingang).toMatchObject({ status: 'abgelegt', importedToArchive: true });
    expect(filterActiveItems(getInboxItems()).some((item) => item.id === eingang.id)).toBe(false);

    expect(isDocumentActionAvailable('record_expense', eingang)).toBe(false);
    expect(isDocumentActionAvailable('check_payment', eingang)).toBe(false);
    expect(createExpenseFromInbox(eingang)).toEqual({ ok: false, errorKey: 'employeePayment.proof.noExpense' });
    expect(getExpensePrefillForInbox(eingang.id)).toBeNull();
    expect(getAllExpenses()).toEqual([]);

    expect(collectSteuerberaterMonthFindings('2026-10').unclearDocuments).toEqual([]);
    /* Und er ist löschgeschützt. */
    expect(deleteDocument(ergebnis.documentId).success).toBe(false);
  });

  it('derselbe Inhalt wird nicht ein zweites Mal abgelegt und kein fremdes Dokument verändert', async () => {
    const erste = barzahlung('100');
    const zweite = barzahlung('200');
    const datei = pdf('gleicher-inhalt');
    const a = await hochladen(erste.id, datei);
    if (!a.ok) throw new Error(a.error);
    const titelVorher = getDocumentById(a.documentId)!.title;
    const anzahlVorher = getAllDocuments().length;

    const b = await hochladen(zweite.id, pdf('gleicher-inhalt'));
    expect(b).toMatchObject({ ok: true, reusedExisting: true, documentId: a.documentId });
    expect(getAllDocuments()).toHaveLength(anzahlVorher);
    expect(getDocumentById(a.documentId)!.title).toBe(titelVorher);
  });

  it('die erzeugte, nicht unterschriebene Quittung wird nicht als Nachweis angenommen', async () => {
    const zahlung = barzahlung();
    const quittung = await ensurePayoutReceiptArchived(zahlung.id);
    if (!quittung.ok) throw new Error('quittung');
    const original = await loadPayoutReceiptOriginal(zahlung.id);
    if (!original.ok) throw new Error('original');
    const datei = new File([await original.blob.arrayBuffer()], 'quittung.pdf', { type: 'application/pdf' });

    const ergebnis = await hochladen(zahlung.id, datei);
    expect(ergebnis).toMatchObject({ ok: false, error: 'proof_is_receipt' });
    expect(getEmployeePaymentById(zahlung.id)?.proofDocumentId).toBeUndefined();
  });

  it('nur Inhaber und Verwaltung; nicht für stornierte Zahlungen', async () => {
    const zahlung = barzahlung();
    expect(await prepareEmployeePaymentProofUpload(zahlung.id, pdf('mitglied'), { access: MEMBER })).toEqual({
      ok: false,
      error: 'not_permitted',
    });
    reverseEmployeePayment(zahlung.id, 'Storno Test');
    expect(await prepareEmployeePaymentProofUpload(zahlung.id, pdf('storno'), { access: OWNER })).toEqual({
      ok: false,
      error: 'reversed',
    });
    expect(getInboxStoreSnapshot()).toHaveLength(0);
  });

  it('ein Doppelklick auf „Als Nachweis speichern" legt nur einmal ab', async () => {
    const zahlung = barzahlung();
    const vorbereitet = await prepareEmployeePaymentProofUpload(zahlung.id, pdf('doppelklick'), { access: OWNER });
    if (!vorbereitet.ok) throw new Error(vorbereitet.error);
    const [a, b] = await Promise.all([
      saveEmployeePaymentProofUpload(zahlung.id, vorbereitet.pending, { access: OWNER }),
      saveEmployeePaymentProofUpload(zahlung.id, vorbereitet.pending, { access: OWNER }),
    ]);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    expect([a, b].find((r) => !r.ok)).toMatchObject({ error: 'in_progress' });
    expect(getAllDocuments()).toHaveLength(1);
  });
});

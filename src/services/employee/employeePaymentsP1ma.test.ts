/**
 * P1 MITARBEITERZAHLUNGEN — Fachvertrag der Mitarbeiter und Mitarbeiterzahlungen.
 *
 * Echte Dienste, echter Speicher, echte Outbox; kein Netz. Neutrale
 * Beispieldaten.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as employeeService from './employeeService';
import { createEmployee, listEmployees, setEmployeeActive, updateEmployee } from './employeeService';
import {
  confirmEmployeePayment,
  findPayrollExpensesForMonth,
  listEmployeePayments,
  parseEmployeePaymentAmount,
  prepareEmployeePaymentConfirmation,
  reverseEmployeePayment,
  setEmployeePaymentProof,
  setEmployeePaymentReceipt,
} from './employeePaymentService';
import * as employeePaymentService from './employeePaymentService';
import {
  EMPLOYEE_PAYMENT_REFERENCE_PATTERN,
  buildEmployeePaymentReference,
  isEmployeePaymentReference,
} from './employeePaymentReference';
import { getEmployeePaymentStoreSnapshot, hydrateEmployeePaymentStore } from './employeeStore';
import { isPayrollDocumentKind } from '../payrollDocumentKind';
import { addDocument, addDocumentWithId, deleteDocument, getDocumentById, getDocumentDeleteBlockReason } from '../documentService';
import { getSyncOutboxSnapshot } from '../sync/syncOutboxService';
import { resetSyncClientForTests } from '../sync/syncClientService';
import { getWorkspaceMembersSnapshot } from '../workspace/workspaceStore';
import { getAllExpenses } from '../expenseService';
import { getAllExpenseOverview } from '../expenseOverviewService';
import { hydrateExpenseStore } from '../expenseStore';
import { getAllAccountingAssignments } from '../accounting/accountingStore';
import { buildBankSuggestions } from '../bank/bankSuggestionService';
import { hydrateInboxStore } from '../inboxService';
import {
  createExpenseFromInbox,
  getExpensePrefillForInbox,
  isDocumentActionAvailable,
} from '../officeActionService';
import { isFinanceReferenceOnlyKind } from '../documentFinanceReferenceService';
import { t } from '../../i18n';
import type { EmployeePaymentDraft, EmployeePaymentKind } from '../../types/employee';
import type { Expense } from '../../types/expense';
import type { BankTransaction } from '../../types/bankTransaction';
import type { InboxItem } from '../../types/models';

const WS = '00000000-0000-4000-8000-00000000e1a1';
const OTHER_WS = '00000000-0000-4000-8000-00000000e1a2';
const OWNER = 'usr-owner-p1ma';

function mitarbeiter(name = 'Erika Beispiel', personnelNumber?: string) {
  const result = createEmployee({ name, personnelNumber }, { userId: OWNER });
  if (!result.success) throw new Error(result.errorKey);
  return result.employee;
}

function entwurf(employeeId: string, patch: Partial<EmployeePaymentDraft> = {}): EmployeePaymentDraft {
  return {
    employeeId,
    kind: 'wage',
    amount: '1.250,00',
    paymentDate: '2026-10-01',
    paymentMethod: 'cash',
    ...patch,
  };
}

function erfasse(draft: EmployeePaymentDraft, paymentId?: string) {
  const prepared = prepareEmployeePaymentConfirmation(draft, { paymentId });
  if (!prepared.ok) throw new Error(prepared.errorKey);
  const confirmed = confirmEmployeePayment(prepared.intent, { userId: OWNER });
  if (!confirmed.success) throw new Error(confirmed.errorKey);
  return confirmed.payment;
}

function archivDokument(title = 'Quittung unterschrieben') {
  const result = addDocument({ title, category: 'personal' });
  if (!result.success) throw new Error(result.errorKey);
  return result.document;
}

function lohnEingang(kind: 'lohnabrechnung' | 'lohnunterlagen' | 'eingangsrechnung', id = `inbox-${kind}`): InboxItem {
  return {
    id,
    title: kind === 'eingangsrechnung' ? 'Rechnung Baustoff Meyer R-77' : 'Lohnabrechnung Oktober 2026',
    documentType: kind === 'eingangsrechnung' ? 'eingangsrechnung' : 'lohnabrechnung',
    classifiedKind: kind,
    sender: kind === 'eingangsrechnung' ? 'Baustoff Meyer GmbH' : 'Steuerbüro Beispiel',
    priority: 'mittel',
    deadline: null,
    digitalFolder: { id: 'dig-1', name: 'Test', path: '/test/' },
    paperFiling: { folderId: 'paper-personal', register: 'Lohn', label: 'Personal' },
    status: 'neu',
    receivedAt: '2026-10-02',
    recommendedAction: 'zuordnen',
    recognizedData: {},
    officePilotSuggestion: '',
    nextTaskLabel: '',
    securityHint: '',
  } as InboxItem;
}

function ausgabe(overrides: Partial<Expense> = {}): Expense {
  return {
    id: 'exp-lohn-1',
    status: 'gebucht',
    category: 'personal',
    supplierName: 'Steuerbüro Beispiel',
    invoiceNumber: 'LA-10',
    title: 'Lohnabrechnung Oktober',
    description: '',
    issueDate: '2026-10-05',
    paymentDueDate: null,
    taxStatus: 'standard_19',
    netAmount: 1000,
    taxAmount: 0,
    grossAmount: 1000,
    currency: 'EUR',
    paymentStatus: 'offen',
    payments: [],
    positions: [],
    allocations: [],
    classifiedKind: 'lohnabrechnung',
    isCreditNote: false,
    dedupeKey: 'lohn|la-10',
    tags: [],
    digitalFolder: { id: 'dig', name: 'Ausgaben', path: '/Ausgaben/' },
    paperFolder: { folderId: 'f', register: 'A', label: 'x' },
    createdAt: '2026-10-05T10:00:00.000Z',
    updatedAt: '2026-10-05T10:00:00.000Z',
    ...overrides,
  } as Expense;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-08T10:00:00.000Z'));
  resetSyncClientForTests({
    deviceId: 'dev-a',
    workspaceId: 'local-ws-a',
    serverWorkspaceId: WS,
    createdAt: '2026-01-01T00:00:00.000Z',
    syncPolicy: 'cloud_ready',
  });
});

afterEach(() => {
  vi.useRealTimers();
});

/* ================================================================== */
describe('Mitarbeiter — anlegen, umbenennen, deaktivieren', () => {
  it('legt an, benennt um und deaktiviert — ohne Löschfunktion', () => {
    const erika = mitarbeiter('Erika Beispiel', 'P-01');
    expect(erika).toMatchObject({ name: 'Erika Beispiel', personnelNumber: 'P-01', active: true });
    expect(erika.sync?.version).toBe(0);

    const umbenannt = updateEmployee(erika.id, { name: 'Erika Muster' }, { userId: OWNER });
    expect(umbenannt.success).toBe(true);
    expect(setEmployeeActive(erika.id, false).success).toBe(true);
    expect(listEmployees({ includeInactive: false })).toHaveLength(0);
    expect(listEmployees({ includeInactive: true })[0]).toMatchObject({ name: 'Erika Muster', active: false });
    expect(setEmployeeActive(erika.id, true).success).toBe(true);

    /* Gelöscht wird nie — es gibt keinen Weg dafür. */
    expect(Object.keys(employeeService).some((name) => /delete|remove/i.test(name))).toBe(false);
    expect(Object.keys(employeePaymentService).some((name) => /delete|remove/i.test(name))).toBe(false);
  });

  it('prüft Name und eindeutige Personalnummer', () => {
    expect(createEmployee({ name: '   ' })).toEqual({ success: false, errorKey: 'employee.error.nameRequired' });
    expect(createEmployee({ name: 'x'.repeat(121) })).toEqual({ success: false, errorKey: 'employee.error.nameTooLong' });
    mitarbeiter('A', 'P-7');
    expect(createEmployee({ name: 'B', personnelNumber: 'p-7' })).toEqual({
      success: false,
      errorKey: 'employee.error.personnelNumberTaken',
    });
  });

  it('ist kein Benutzerkonto: keine Benutzer-, Rollen- oder Login-Felder, keine Mitgliederänderung', () => {
    const vorher = getWorkspaceMembersSnapshot();
    const erika = mitarbeiter();
    expect(Object.keys(erika).sort()).toEqual(
      ['active', 'createdAt', 'createdBy', 'id', 'name', 'sync', 'updatedAt', 'updatedBy'].sort(),
    );
    expect(JSON.stringify(erika)).not.toMatch(/userId|role|email|password|login/i);
    expect(getWorkspaceMembersSnapshot()).toEqual(vorher);
  });

  it('reiht Anlage und Änderung für die Cloud ein (Basisversion 0)', () => {
    const erika = mitarbeiter();
    updateEmployee(erika.id, { name: 'Erika Neu' });
    const eintraege = getSyncOutboxSnapshot().filter((entry) => entry.entityType === 'employee');
    expect(eintraege).toHaveLength(1);
    expect(eintraege[0]).toMatchObject({ entityId: erika.id, version: 0 });
  });

  it('Umbenennen lässt erfasste Zahlungen beim Namen zum Zahlungszeitpunkt', () => {
    const erika = mitarbeiter('Erika Beispiel');
    const zahlung = erfasse(entwurf(erika.id));
    updateEmployee(erika.id, { name: 'Erika Umbenannt' });
    expect(employeePaymentService.getEmployeePaymentById(zahlung.id)?.employeeName).toBe('Erika Beispiel');
  });
});

/* ================================================================== */
describe('Mitarbeiterzahlung — Prüfung und Confirm-first', () => {
  it('erfasst alle fünf Arten; „Sonstige" braucht eine Notiz', () => {
    const erika = mitarbeiter();
    const arten: EmployeePaymentKind[] = ['wage', 'advance', 'reimbursement', 'travel', 'other'];
    for (const kind of arten) {
      const zahlung = erfasse(entwurf(erika.id, { kind, note: kind === 'other' ? 'Werkzeuggeld' : undefined }));
      expect(zahlung.kind).toBe(kind);
    }
    expect(listEmployeePayments()).toHaveLength(5);

    const ohneNotiz = prepareEmployeePaymentConfirmation(entwurf(erika.id, { kind: 'other' }));
    expect(ohneNotiz).toMatchObject({ ok: false, errorKey: 'employeePayment.error.noteRequired', field: 'note' });
  });

  it('Betrag größer 0, höchstens zwei Nachkommastellen, nicht über der Grenze', () => {
    const erika = mitarbeiter();
    expect(prepareEmployeePaymentConfirmation(entwurf(erika.id, { amount: '0' }))).toMatchObject({ ok: false, errorKey: 'employeePayment.error.amountInvalid' });
    expect(prepareEmployeePaymentConfirmation(entwurf(erika.id, { amount: '-5' }))).toMatchObject({ ok: false, errorKey: 'employeePayment.error.amountInvalid' });
    expect(prepareEmployeePaymentConfirmation(entwurf(erika.id, { amount: '1,005' }))).toMatchObject({ ok: false, errorKey: 'employeePayment.error.amountPrecision' });
    expect(prepareEmployeePaymentConfirmation(entwurf(erika.id, { amount: '10000000' }))).toMatchObject({ ok: false, errorKey: 'employeePayment.error.amountTooHigh' });
    expect(parseEmployeePaymentAmount('1.234,56')).toBe(1234.56);
    expect(parseEmployeePaymentAmount('1234.56')).toBe(1234.56);
  });

  it('kennt keine Vorgabe für die Zahlungsart', () => {
    const erika = mitarbeiter();
    const ohneArt = prepareEmployeePaymentConfirmation(entwurf(erika.id, { paymentMethod: '' }));
    expect(ohneArt).toMatchObject({ ok: false, errorKey: 'employeePayment.error.methodRequired', field: 'paymentMethod' });
  });

  it('Lohnmonat nur bei Lohn/Gehalt; Datum nicht in der Zukunft; deaktiviert nimmt keine neue Zahlung', () => {
    const erika = mitarbeiter();
    expect(prepareEmployeePaymentConfirmation(entwurf(erika.id, { kind: 'advance', wageMonth: '2026-10' }))).toMatchObject({
      ok: false,
      errorKey: 'employeePayment.error.wageMonthOnlyForWage',
    });
    expect(prepareEmployeePaymentConfirmation(entwurf(erika.id, { paymentDate: '2026-10-20' }))).toMatchObject({
      ok: false,
      errorKey: 'employeePayment.error.dateInFuture',
    });
    setEmployeeActive(erika.id, false);
    expect(prepareEmployeePaymentConfirmation(entwurf(erika.id))).toMatchObject({
      ok: false,
      errorKey: 'employeePayment.error.employeeInactive',
    });
  });

  it('Confirm-first: die Zusammenfassung schreibt nichts; Abbrechen hinterlässt nichts', () => {
    const erika = mitarbeiter();
    const vorbereitet = prepareEmployeePaymentConfirmation(entwurf(erika.id));
    expect(vorbereitet.ok).toBe(true);
    expect(listEmployeePayments()).toHaveLength(0);
    expect(getSyncOutboxSnapshot().filter((entry) => entry.entityType === 'employee_payment')).toHaveLength(0);
    /* Abbrechen = die Absicht verwerfen: es bleibt nichts zurück. */
    expect(getEmployeePaymentStoreSnapshot()).toEqual([]);

    if (!vorbereitet.ok) return;
    const bestaetigt = confirmEmployeePayment(vorbereitet.intent, { userId: OWNER });
    expect(bestaetigt.success).toBe(true);
    expect(listEmployeePayments()).toHaveLength(1);
    const eintraege = getSyncOutboxSnapshot().filter((entry) => entry.entityType === 'employee_payment');
    expect(eintraege).toHaveLength(1);
    expect(eintraege[0]).toMatchObject({ entityId: vorbereitet.intent.paymentId, operation: 'create' });
  });

  it('Doppelklick und Wiederholung erzeugen keine zweite Zahlung; abweichende Daten sind ein Konflikt', () => {
    const erika = mitarbeiter();
    const vorbereitet = prepareEmployeePaymentConfirmation(entwurf(erika.id), { paymentId: 'pay-fest-1' });
    if (!vorbereitet.ok) throw new Error('vorbereitung');
    const erst = confirmEmployeePayment(vorbereitet.intent);
    const zweit = confirmEmployeePayment(vorbereitet.intent);
    expect(erst).toMatchObject({ success: true, replayed: false });
    expect(zweit).toMatchObject({ success: true, replayed: true });
    expect(listEmployeePayments()).toHaveLength(1);

    const anders = prepareEmployeePaymentConfirmation(entwurf(erika.id, { amount: '99,00' }), { paymentId: 'pay-fest-1' });
    if (!anders.ok) throw new Error('vorbereitung');
    expect(confirmEmployeePayment(anders.intent)).toEqual({ success: false, errorKey: 'employeePayment.error.idConflict' });
    expect(listEmployeePayments()).toHaveLength(1);
    expect(listEmployeePayments()[0].amount).toBe(1250);
  });

  it('der Vorschuss wird nicht als Aufwand behandelt — wörtlich und tatsächlich', () => {
    const erika = mitarbeiter();
    erfasse(entwurf(erika.id, { kind: 'advance', amount: '300' }));
    expect(t('employeePayment.hint.advance')).toBe('Dieser Vorschuss wird nicht als Aufwand behandelt.');
    expect(getAllExpenses()).toEqual([]);
  });
});

/* ================================================================== */
describe('MZ-Referenz', () => {
  it('ist stabil, wohlgeformt und aus Betrieb und Zahlungs-Id abgeleitet', () => {
    const erika = mitarbeiter();
    const zahlung = erfasse(entwurf(erika.id), 'pay-ref-1');
    expect(zahlung.receiptReference).toMatch(EMPLOYEE_PAYMENT_REFERENCE_PATTERN);
    expect(zahlung.receiptReference.startsWith('MZ-20261001-')).toBe(true);
    expect(isEmployeePaymentReference(zahlung.receiptReference)).toBe(true);
    expect(zahlung.receiptReference).toBe(buildEmployeePaymentReference(WS, 'pay-ref-1', '2026-10-01'));
    expect(buildEmployeePaymentReference(WS, 'pay-ref-1', '2026-10-01')).toBe(zahlung.receiptReference);

    /* Unverändert nach Umbenennung, Nachweis und Storno. */
    updateEmployee(erika.id, { name: 'Neu' });
    const doc = archivDokument();
    setEmployeePaymentProof(zahlung.id, doc.id);
    reverseEmployeePayment(zahlung.id, 'Doppelt erfasst');
    expect(employeePaymentService.getEmployeePaymentById(zahlung.id)?.receiptReference).toBe(zahlung.receiptReference);
  });

  it('unterscheidet sich zwischen Betrieben und Zahlungen; eine lokale Kollision wird abgewiesen', () => {
    const a = buildEmployeePaymentReference(WS, 'pay-x', '2026-10-01');
    const b = buildEmployeePaymentReference(OTHER_WS, 'pay-x', '2026-10-01');
    const c = buildEmployeePaymentReference(WS, 'pay-y', '2026-10-01');
    expect(new Set([a, b, c]).size).toBe(3);

    const erika = mitarbeiter();
    const vorbereitet = prepareEmployeePaymentConfirmation(entwurf(erika.id), { paymentId: 'pay-x' });
    if (!vorbereitet.ok) throw new Error('vorbereitung');
    hydrateEmployeePaymentStore([
      {
        id: 'pay-andere',
        employeeId: erika.id,
        employeeName: erika.name,
        kind: 'wage',
        amount: 10,
        paymentDate: '2026-10-01',
        paymentMethod: 'cash',
        receiptReference: a,
        createdAt: '2026-10-01T08:00:00.000Z',
      },
    ]);
    expect(confirmEmployeePayment(vorbereitet.intent)).toEqual({ success: false, errorKey: 'employeePayment.error.referenceConflict' });
  });
});

/* ================================================================== */
describe('Storno', () => {
  it('verlangt einen Grund, ist idempotent und löscht nichts', () => {
    const erika = mitarbeiter();
    const zahlung = erfasse(entwurf(erika.id));
    expect(reverseEmployeePayment(zahlung.id, 'ab')).toEqual({ success: false, errorKey: 'employeePayment.error.reasonRequired' });
    expect(reverseEmployeePayment(zahlung.id, 'x'.repeat(301))).toEqual({ success: false, errorKey: 'employeePayment.error.reasonTooLong' });

    const erst = reverseEmployeePayment(zahlung.id, 'Falscher Betrag', { userId: OWNER });
    expect(erst).toMatchObject({ success: true, replayed: false });
    const zweit = reverseEmployeePayment(zahlung.id, 'Anderer Grund');
    expect(zweit).toMatchObject({ success: true, replayed: true });

    const gespeichert = employeePaymentService.getEmployeePaymentById(zahlung.id)!;
    expect(gespeichert).toMatchObject({ reversalReason: 'Falscher Betrag', reversedBy: OWNER, amount: 1250 });
    expect(gespeichert.reversedAt).toBeTruthy();
    expect(listEmployeePayments()).toHaveLength(1);
    expect(getSyncOutboxSnapshot().find((entry) => entry.entityId === zahlung.id)).toBeTruthy();
  });

  it('nach dem Storno keine neue Quittung und keine Nachweisänderung', () => {
    const erika = mitarbeiter();
    const zahlung = erfasse(entwurf(erika.id));
    reverseEmployeePayment(zahlung.id, 'Storno Test');
    const doc = archivDokument();
    expect(setEmployeePaymentReceipt(zahlung.id, doc.id)).toEqual({ success: false, errorKey: 'employeePayment.error.reversed' });
    expect(setEmployeePaymentProof(zahlung.id, doc.id)).toEqual({ success: false, errorKey: 'employeePayment.error.reversed' });
  });
});

/* ================================================================== */
describe('Quittung und Nachweis — geldfrei', () => {
  it('receiptDocumentId wird genau einmal gesetzt, nur bei Barzahlung', () => {
    const erika = mitarbeiter();
    const bar = erfasse(entwurf(erika.id));
    const a = addDocumentWithId({ title: 'Auszahlungsquittung', category: 'personal' }, `emp-receipt-${bar.id}`);
    const b = archivDokument('Andere Datei');
    if (!a.success) throw new Error('doc');
    expect(setEmployeePaymentReceipt(bar.id, a.document.id)).toMatchObject({ success: true, replayed: false });
    expect(setEmployeePaymentReceipt(bar.id, a.document.id)).toMatchObject({ success: true, replayed: true });
    expect(setEmployeePaymentReceipt(bar.id, b.id)).toEqual({ success: false, errorKey: 'employeePayment.error.receiptAlreadySet' });

    const bank = erfasse(entwurf(erika.id, { paymentMethod: 'bank' }));
    expect(setEmployeePaymentReceipt(bank.id, b.id)).toEqual({ success: false, errorKey: 'employeePayment.error.receiptOnlyCash' });
    const ohneDok = erfasse(entwurf(erika.id, { amount: '5' }));
    expect(setEmployeePaymentReceipt(ohneDok.id, 'doc-gibt-es-nicht')).toEqual({ success: false, errorKey: 'employeePayment.error.receiptNotFound' });
  });

  it('der Nachweis ändert sich ohne Geldbewegung; eine erzeugte Quittung ist kein Nachweis', () => {
    const erika = mitarbeiter();
    const zahlung = erfasse(entwurf(erika.id));
    const quittung = addDocumentWithId({ title: 'Quittung', category: 'personal' }, `emp-receipt-${zahlung.id}`);
    if (!quittung.success) throw new Error('doc');
    setEmployeePaymentReceipt(zahlung.id, quittung.document.id);

    const vorher = employeePaymentService.getEmployeePaymentById(zahlung.id)!;
    const nachweis = archivDokument();
    expect(setEmployeePaymentProof(zahlung.id, nachweis.id)).toMatchObject({ success: true });
    const nachher = employeePaymentService.getEmployeePaymentById(zahlung.id)!;
    for (const feld of ['amount', 'paymentDate', 'kind', 'paymentMethod', 'employeeId', 'receiptReference'] as const) {
      expect(nachher[feld]).toEqual(vorher[feld]);
    }
    expect(nachher.proofDocumentId).toBe(nachweis.id);

    expect(setEmployeePaymentProof(zahlung.id, quittung.document.id)).toEqual({ success: false, errorKey: 'employeePayment.error.proofIsReceipt' });
    const fremd = addDocumentWithId({ title: 'Fremde Quittung', category: 'personal' }, 'emp-receipt-andere-zahlung');
    if (!fremd.success) throw new Error('doc');
    expect(setEmployeePaymentProof(zahlung.id, fremd.document.id)).toEqual({ success: false, errorKey: 'employeePayment.error.proofIsReceipt' });
    expect(prepareEmployeePaymentConfirmation(entwurf(erika.id, { proofDocumentId: fremd.document.id }))).toMatchObject({
      ok: false,
      errorKey: 'employeePayment.error.proofIsReceipt',
    });
  });

  it('Quittung und Nachweis sind löschgeschützt — auch nach dem Storno', () => {
    const erika = mitarbeiter();
    const zahlung = erfasse(entwurf(erika.id));
    const quittung = addDocumentWithId({ title: 'Quittung', category: 'personal' }, `emp-receipt-${zahlung.id}`);
    if (!quittung.success) throw new Error('doc');
    setEmployeePaymentReceipt(zahlung.id, quittung.document.id);
    const nachweis = archivDokument();
    setEmployeePaymentProof(zahlung.id, nachweis.id);

    for (const id of [quittung.document.id, nachweis.id]) {
      expect(getDocumentDeleteBlockReason(getDocumentById(id)!)).toBe('payment_proof');
      expect(deleteDocument(id).success).toBe(false);
    }
    reverseEmployeePayment(zahlung.id, 'Storno Test');
    for (const id of [quittung.document.id, nachweis.id]) {
      expect(deleteDocument(id).success).toBe(false);
      expect(getDocumentById(id)).toBeTruthy();
    }
    /* Gegenprobe: ein unbeteiligtes Dokument bleibt löschbar. */
    const frei = archivDokument('Unbeteiligt');
    expect(deleteDocument(frei.id).success).toBe(true);
  });

  it('Datenschutz-Spiegel: Quittung nur mit fester Kennung, Belege nie mit Rechnungsbezug', () => {
    const erika = mitarbeiter();
    const zahlung = erfasse(entwurf(erika.id));
    const andere = erfasse(entwurf(erika.id, { amount: '7' }));

    /* Der Server schützt die Quittung an ihrer festen Kennung — eine andere nimmt er nicht an. */
    const beliebig = archivDokument('Quittung mit beliebiger Kennung');
    expect(setEmployeePaymentReceipt(zahlung.id, beliebig.id)).toEqual({ success: false, errorKey: 'employeePayment.error.receiptInvalid' });
    const fremdeQuittung = addDocumentWithId({ title: 'Quittung der anderen Zahlung', category: 'personal' }, `emp-receipt-${andere.id}`);
    if (!fremdeQuittung.success) throw new Error('doc');
    expect(setEmployeePaymentReceipt(zahlung.id, fremdeQuittung.document.id)).toEqual({ success: false, errorKey: 'employeePayment.error.receiptInvalid' });
    expect(employeePaymentService.getEmployeePaymentById(zahlung.id)?.receiptDocumentId).toBeFalsy();

    /* Ein Dokument mit Rechnungsbezug ist kein Beleg einer Mitarbeiterzahlung — weder beim Erfassen noch später. */
    const rechnung = addDocument({ title: 'Ausgangsrechnung RE-2026-001', category: 'ausgangsrechnung', linkedInvoiceId: 'inv-1' });
    if (!rechnung.success) throw new Error(rechnung.errorKey);
    expect(setEmployeePaymentProof(zahlung.id, rechnung.document.id)).toEqual({ success: false, errorKey: 'employeePayment.error.proofNotAllowed' });
    expect(prepareEmployeePaymentConfirmation(entwurf(erika.id, { proofDocumentId: rechnung.document.id }))).toMatchObject({
      ok: false,
      errorKey: 'employeePayment.error.proofNotAllowed',
      field: 'proof',
    });
    expect(employeePaymentService.getEmployeePaymentById(zahlung.id)?.proofDocumentId).toBeFalsy();
  });

  it('eine feste Dokumentkennung wird nie überschrieben', () => {
    const erst = addDocumentWithId({ title: 'Eins', category: 'personal' }, 'emp-receipt-fest');
    const zweit = addDocumentWithId({ title: 'Zwei', category: 'personal' }, 'emp-receipt-fest');
    expect(erst.success).toBe(true);
    expect(zweit).toEqual({ success: false, errorKey: 'document.idTaken' });
    expect(getDocumentById('emp-receipt-fest')?.title).toBe('Eins');
  });
});

/* ================================================================== */
describe('Keine Doppelzählung: keine Ausgabe, keine Buchung, kein Bankvorschlag', () => {
  it('Mitarbeiterzahlungen aller Arten erzeugen nichts in Ausgaben, Kontierung oder Bankabgleich', () => {
    const erika = mitarbeiter();
    for (const kind of ['wage', 'advance', 'reimbursement', 'travel'] as const) {
      erfasse(entwurf(erika.id, { kind, amount: '250', paymentMethod: kind === 'travel' ? 'bank' : 'cash' }));
    }
    expect(getAllExpenses()).toEqual([]);
    expect(getAllExpenseOverview()).toEqual([]);
    expect(getAllAccountingAssignments()).toEqual([]);

    const bewegung = {
      id: 'bt-1',
      accountKey: '',
      importId: 'imp-1',
      fileName: 'konto.csv',
      importedAt: '2026-10-08T09:00:00.000Z',
      bookingDate: '2026-10-01',
      amountCents: -25000,
      counterparty: 'Erika Beispiel',
      purpose: 'Reisekosten',
    } as BankTransaction;
    const vorschlag = buildBankSuggestions([bewegung]).get('bt-1');
    expect(vorschlag?.candidates ?? []).toEqual([]);
  });
});

/* ================================================================== */
describe('Lohnabrechnung — keine zweite Wahrheit als Ausgabe', () => {
  it('isPayrollDocumentKind ist eng: nur Lohnabrechnung und Lohnunterlagen', () => {
    expect(isPayrollDocumentKind('lohnabrechnung')).toBe(true);
    expect(isPayrollDocumentKind('lohnunterlagen')).toBe(true);
    expect(isPayrollDocumentKind('eingangsrechnung')).toBe(false);
    expect(isPayrollDocumentKind(undefined)).toBe(false);
    /* Nicht über die Bezugsdokument-Liste gelöst. */
    expect(isFinanceReferenceOnlyKind('lohnabrechnung')).toBe(false);
  });

  it('bietet keine Ausgabe an, legt keine an und belegt das Formular nicht vor', () => {
    for (const kind of ['lohnabrechnung', 'lohnunterlagen'] as const) {
      const item = lohnEingang(kind);
      hydrateInboxStore([item]);
      expect(isDocumentActionAvailable('record_expense', item, kind)).toBe(false);
      expect(isDocumentActionAvailable('check_payment', item, kind)).toBe(false);
      expect(createExpenseFromInbox(item)).toEqual({ ok: false, errorKey: 'payroll.error.noExpense' });
      expect(getExpensePrefillForInbox(item.id)).toBeNull();
    }
    expect(getAllExpenses()).toEqual([]);
    expect(t('payroll.hint.text')).toBe(
      'Lohnauszahlungen erfassen Sie unter Finanzen → Mitarbeiterzahlungen. Die Lohnabrechnung selbst bucht Ihr Steuerberater.',
    );
  });

  it('Gegenprobe: eine Eingangsrechnung bleibt als Ausgabe erfassbar', () => {
    const item = lohnEingang('eingangsrechnung');
    hydrateInboxStore([item]);
    expect(isDocumentActionAvailable('record_expense', item, 'eingangsrechnung')).toBe(true);
  });

  it('erkennt eine nicht stornierte Lohnabrechnungs-Ausgabe im selben Monat (Warnung, nichts wird umgebucht)', () => {
    hydrateExpenseStore([
      ausgabe(),
      ausgabe({ id: 'exp-storniert', status: 'storniert', cancelledAt: '2026-10-06T10:00:00.000Z' }),
      ausgabe({ id: 'exp-anderer-monat', issueDate: '2026-09-28' }),
      ausgabe({ id: 'exp-material', classifiedKind: 'eingangsrechnung', category: 'material' }),
    ]);
    expect(findPayrollExpensesForMonth('2026-10').map((expense) => expense.id)).toEqual(['exp-lohn-1']);
    expect(getAllExpenses()).toHaveLength(4);
  });

  it('der Hinweis im Ausgabenformular ist nicht blockierend formuliert', () => {
    expect(t('expense.personalHint')).toContain('Lohnabrechnungen nicht zusätzlich als Ausgabe erfassen');
  });
});

/* ================================================================== */
describe('P1MA WEISS — mögliche Doppelzahlung: Hinweis, keine Sperre', () => {
  const finde = employeePaymentService.findPossibleDuplicateEmployeePayments;

  it('erkennt dieselbe gültige Zahlung — Mitarbeiter, Zahlungsgrund, Betrag, Datum und Zahlungsweg', () => {
    const erika = mitarbeiter();
    const erste = erfasse(entwurf(erika.id));
    const zweite = prepareEmployeePaymentConfirmation(entwurf(erika.id));
    if (!zweite.ok) throw new Error(zweite.errorKey);
    expect(finde(zweite.intent).map((zahlung) => zahlung.id)).toEqual([erste.id]);

    /* Ein einziges abweichendes Merkmal genügt: kein Hinweis. */
    const max = mitarbeiter('Max Muster');
    for (const anders of [
      entwurf(max.id),
      entwurf(erika.id, { kind: 'advance' }),
      entwurf(erika.id, { amount: '1.250,01' }),
      entwurf(erika.id, { paymentDate: '2026-10-02' }),
      entwurf(erika.id, { paymentMethod: 'bank' }),
    ]) {
      const vorbereitet = prepareEmployeePaymentConfirmation(anders);
      if (!vorbereitet.ok) throw new Error(vorbereitet.errorKey);
      expect(finde(vorbereitet.intent)).toEqual([]);
    }
  });

  it('eine technische Doppelübermittlung ist keine Doppelzahlung — dieselbe Kennung wird als Wiederholung erkannt', () => {
    const erika = mitarbeiter();
    const vorbereitet = prepareEmployeePaymentConfirmation(entwurf(erika.id), { paymentId: 'pay-fest' });
    if (!vorbereitet.ok) throw new Error(vorbereitet.errorKey);
    expect(confirmEmployeePayment(vorbereitet.intent, { userId: OWNER })).toMatchObject({ success: true, replayed: false });
    expect(finde(vorbereitet.intent)).toEqual([]);
    expect(confirmEmployeePayment(vorbereitet.intent, { userId: OWNER })).toMatchObject({ success: true, replayed: true });
    expect(listEmployeePayments()).toHaveLength(1);
  });

  it('stornierte Zahlungen zählen nicht; die bewusste zweite gleiche Zahlung bleibt erfassbar', () => {
    const erika = mitarbeiter();
    const storniert = erfasse(entwurf(erika.id));
    reverseEmployeePayment(storniert.id, 'Falscher Betrag');
    const korrektur = prepareEmployeePaymentConfirmation(entwurf(erika.id));
    if (!korrektur.ok) throw new Error(korrektur.errorKey);
    expect(finde(korrektur.intent)).toEqual([]);

    const erste = erfasse(entwurf(erika.id, { amount: '50' }));
    const zweite = prepareEmployeePaymentConfirmation(entwurf(erika.id, { amount: '50' }));
    if (!zweite.ok) throw new Error(zweite.errorKey);
    expect(finde(zweite.intent).map((zahlung) => zahlung.id)).toEqual([erste.id]);
    expect(confirmEmployeePayment(zweite.intent, { userId: OWNER })).toMatchObject({ success: true, replayed: false });
    expect(listEmployeePayments().filter((zahlung) => zahlung.amount === 50)).toHaveLength(2);
  });
});

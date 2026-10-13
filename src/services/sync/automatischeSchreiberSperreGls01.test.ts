/**
 * GO-LIVE-SECURITY-01 / KONTOSPERRE — indirekte automatische Einreihungswege.
 *
 * Neben den direkten Backfill-Wegen gibt es automatische Abläufe, die Fachdaten im Speicher
 * ändern; erst der Änderungsverfolger macht daraus einen Sendeauftrag. Für ihn sähe das wie
 * eine Nutzeränderung aus — er hätte eine endgültige Abweisung abgelöst und die Entität ohne
 * Nutzeraktion erneut gesendet. Geprüft mit den echten Modulen (Aufgabenspeicher, persistAll,
 * Änderungsverfolger, applySyncPullCandidateSafely):
 *
 *   I1 Aufgabenabgleich nach einem angewendeten Abzug schließt eine endgültig abgewiesene
 *      Aufgabe lokal — kein neuer Auftrag; ohne Abweisung wird die Erledigung wie bisher gesendet.
 *   I2 Täglicher Aufgabenabgleich beim Start — ebenso.
 *   I3 Eine bewusste Nutzeraktion (Aufgabe erledigen) nach der Abweisung erzeugt einen neuen
 *      Auftrag und löst die alte Abweisung ab.
 *   I4 Der automatische Schreibbereich ist verschachtelbar und endet auch bei einem Fehler.
 *   I5 Vertrag: alle bekannten automatischen Schreiber laufen im Schreibbereich.
 *   I6 Bootstrap (Betriebsdaten/Firmenprofil in die Speicher) reiht kein abgewiesenes Firmenprofil neu ein.
 *   I7 Automatische Angebotsablage beim Öffnen reiht kein abgewiesenes Angebot neu ein.
 *   I8 Automatische Briefablage beim Öffnen reiht keinen abgewiesenen Brief neu ein.
 *
 * Neutrale Beispieldaten, kein Netzwerk.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestVorgang } from '../../test/fixtures';
import { resetTestStores } from '../../test/resetStores';
import { hydrateVorgangStore } from '../vorgangService';
import { completeTask, syncOverdueInvoiceTasks } from '../taskEngineService';
import { getAllTasksFromStore, setTaskStoreForTests } from '../taskStore';
import { isTaskOpen } from '../taskNormalize';
import { resetDailyInvoicePaymentTaskReconcileForTests, runDailyInvoicePaymentTaskReconcile } from '../invoice/invoicePaymentTaskSync';
import { buildPersistedStateSnapshot, persistAll } from '../persistenceService';
import { applySyncPullCandidateSafely } from './syncPullPersistService';
import { createEmptySyncSimulationReport } from './syncSimulationReportService';
import { resetSyncChangeTrackerForTests } from './syncChangeTrackerService';
import {
  getSyncOutboxSnapshot,
  isAutomaticSyncWriteActive,
  resetSyncOutboxForTests,
  runAutomaticSyncWrite,
} from './syncOutboxService';
import { resetSyncCoordinatorForTests } from './syncCoordinator';
import { createSyncClient, resetSyncClientForTests } from './syncClientService';
import { applyWorkspaceStateToStores } from '../workspace/workspaceProvisioningService';
import { DEFAULT_COMPANY_PROFILE } from '../../data/companyProfileDefaults';
import { hydrateDocumentStore } from '../documentService';
import { getOfferById, hydrateOffers } from '../offer/offerService';
import { ensureOfferArchived } from '../offer/offerArchiveService';
import { getBusinessLetterById, hydrateBusinessLetters } from '../businessLetterService';
import { ensureBusinessLetterArchived } from '../letter/businessLetterArchiveService';
import type { CompanyDocument } from '../../types/models';
import type { Offer } from '../../types/offer';
import type { BusinessLetter } from '../../types/businessLetter';
import type { SyncEntityType } from '../../types/sync';
import type { AppPersistedState, Task, VorgangInvoice } from '../../types/models';
import type { SyncCoordinatorReport, SyncOutboxEntry } from '../../types/sync';

const VORGANG = 'v-sperre-aufgabe';
const INVOICE = 'inv-sperre-aufgabe';
const GESPERRT = 'Kein Zugriff auf Workspace';

function rechnung(payments: VorgangInvoice['payments'] = []): VorgangInvoice {
  return {
    id: INVOICE,
    number: 'RE-2026-201',
    type: 'abschlag',
    abschlagNumber: 1,
    positions: [{ id: 'l1', orderPositionId: 'op1', description: 'Leistung', quantity: 10, unit: 'Stunden', unitPrice: 100, lineTotal: 1000 }],
    subtotal: 1000,
    taxStatus: 'standard_19',
    amount: 1190,
    status: 'versendet',
    date: '2026-06-01',
    createdAt: '2026-06-01T10:00:00.000Z',
    issueDate: '2026-06-01',
    sentAt: '2026-06-01T12:00:00.000Z',
    paymentDueDate: '2026-06-15',
    customerSnapshot: { name: 'Beispiel Kunde', contactPerson: '', street: '', zip: '', city: '', email: '', phone: '' },
    payments,
  } as VorgangInvoice;
}

const BEZAHLT = [{ id: 'pay-remote', date: '2026-09-01', amount: 1190, createdAt: '2026-09-01T10:00:00.000Z' }];

/** Überfällige Rechnung mit automatisch angelegter Überfälligkeitsaufgabe; liefert deren Kennung. */
function aufgabeAnlegen(): string {
  hydrateVorgangStore([createTestVorgang({ id: VORGANG, title: 'Bad Sperrprobe', invoices: [rechnung()] })]);
  setTaskStoreForTests([]);
  expect(syncOverdueInvoiceTasks('2026-09-01')).toHaveLength(1);
  persistAll();
  return ueberfaellig()[0]!.id;
}

const ueberfaellig = (): Task[] =>
  getAllTasksFromStore().filter((task) => task.taskKind === 'payment_overdue' && task.sourceId === INVOICE);

function abgewiesen(taskId: string): SyncOutboxEntry {
  return {
    id: `out-task-${taskId}`,
    entityType: 'task',
    entityId: taskId,
    operation: 'create',
    version: 1,
    queuedAt: '2026-09-01T10:00:00.000Z',
    retryCount: 1,
    status: 'failed',
    lastErrorMessage: GESPERRT,
    lastErrorRetryable: false,
  };
}

const aufgabenAuftraege = (taskId: string) => getSyncOutboxSnapshot().filter((entry) => entry.entityType === 'task' && entry.entityId === taskId);
const offen = (taskId: string) => aufgabenAuftraege(taskId).filter((entry) => ['pending', 'error', 'blocked'].includes(entry.status));

/** Der Cloud-Stand: dieselbe Rechnung, von einem anderen Gerät bezahlt. */
function cloudBezahlt(local: AppPersistedState): AppPersistedState {
  return {
    ...local,
    invoiceEntries: (local.invoiceEntries ?? []).map((entry) =>
      entry.invoice.id === INVOICE ? { ...entry, invoice: { ...entry.invoice, payments: BEZAHLT } as VorgangInvoice } : entry,
    ),
  };
}

function bericht(): SyncCoordinatorReport {
  return { ...createEmptySyncSimulationReport('2026-09-02T10:00:00.000Z'), retryAttempts: 0, uploadCount: 0, downloadCount: 0 } as SyncCoordinatorReport;
}

beforeEach(() => {
  localStorage.clear();
  resetTestStores();
  resetSyncOutboxForTests();
  resetSyncChangeTrackerForTests();
  resetSyncCoordinatorForTests();
  resetDailyInvoicePaymentTaskReconcileForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('I — automatische Schreiber reihen keine endgültig abgewiesene Entität neu ein', () => {
  it('I1 Aufgabenabgleich nach einem angewendeten Abzug: Aufgabe lokal erledigt, kein neuer Auftrag', () => {
    const taskId = aufgabeAnlegen();
    resetSyncOutboxForTests([abgewiesen(taskId)]);
    persistAll();

    const applied = applySyncPullCandidateSafely({ state: cloudBezahlt(buildPersistedStateSnapshot()), report: bericht() });
    expect(applied.persisted).toBe(true);
    expect(ueberfaellig().every((task) => !isTaskOpen(task))).toBe(true); // lokal erledigt
    expect(offen(taskId)).toEqual([]);
    expect(aufgabenAuftraege(taskId)).toEqual([expect.objectContaining({ status: 'failed' })]);
  });

  it('I1-Gegenstück: ohne Abweisung wird die Erledigung wie bisher als Änderung gesendet', () => {
    const taskId = aufgabeAnlegen();
    resetSyncOutboxForTests([]);
    persistAll();

    applySyncPullCandidateSafely({ state: cloudBezahlt(buildPersistedStateSnapshot()), report: bericht() });
    expect(offen(taskId)).toEqual([expect.objectContaining({ status: 'pending' })]);
  });

  it('I2 täglicher Aufgabenabgleich beim Start: kein neuer Auftrag für die abgewiesene Aufgabe', () => {
    const taskId = aufgabeAnlegen();
    // Die Rechnung ist inzwischen bezahlt (lokal), der Abgleich läuft erst am nächsten Tag.
    hydrateVorgangStore([createTestVorgang({ id: VORGANG, title: 'Bad Sperrprobe', invoices: [rechnung(BEZAHLT)] })]);
    persistAll();
    resetSyncOutboxForTests([abgewiesen(taskId)]);

    expect(runDailyInvoicePaymentTaskReconcile(new Date('2026-09-02T08:00:00.000Z'))).toBe(true);
    expect(ueberfaellig().every((task) => !isTaskOpen(task))).toBe(true);
    expect(offen(taskId)).toEqual([]);
  });

  it('I3 eine bewusste Nutzeraktion nach der Abweisung: neuer Auftrag, alte Abweisung abgelöst', () => {
    const taskId = aufgabeAnlegen();
    const alt = abgewiesen(taskId);
    resetSyncOutboxForTests([alt]);
    persistAll();

    expect(completeTask(taskId)).not.toBeNull();
    expect(offen(taskId)).toEqual([expect.objectContaining({ status: 'pending' })]);
    expect(aufgabenAuftraege(taskId).find((entry) => entry.id === alt.id)?.status).toBe('completed');
  });

  it('I4 der Schreibbereich ist verschachtelbar und endet auch bei einem Fehler', () => {
    expect(isAutomaticSyncWriteActive()).toBe(false);
    runAutomaticSyncWrite(() => {
      runAutomaticSyncWrite(() => expect(isAutomaticSyncWriteActive()).toBe(true));
      expect(isAutomaticSyncWriteActive()).toBe(true);
    });
    expect(() =>
      runAutomaticSyncWrite(() => {
        throw new Error('Abbruch');
      }),
    ).toThrow('Abbruch');
    expect(isAutomaticSyncWriteActive()).toBe(false);
  });
});

const WS = 'ws-automatik-sperre';

function denial(entityType: SyncEntityType, entityId: string): SyncOutboxEntry {
  return {
    id: `out-${entityType}-${entityId}`,
    entityType,
    entityId,
    operation: 'update',
    version: 1,
    queuedAt: '2026-09-01T10:00:00.000Z',
    retryCount: 1,
    status: 'failed',
    lastErrorMessage: GESPERRT,
    lastErrorRetryable: false,
  };
}

const offenFuer = (entityType: SyncEntityType, entityId: string) =>
  getSyncOutboxSnapshot().filter(
    (entry) => entry.entityType === entityType && entry.entityId === entityId && ['pending', 'error', 'blocked'].includes(entry.status),
  );

function archivDokument(overrides: Partial<CompanyDocument>): CompanyDocument {
  return {
    id: 'doc-ablage',
    title: 'Ablage',
    category: 'sonstiges',
    issuer: 'Beispiel GmbH',
    recognizedText: '',
    issueDate: '2026-09-21',
    validUntil: null,
    digitalFolder: { id: 'dig-x', name: 'Ablage', path: '/Ablage/' },
    paperFolder: { folderId: 'ordner-x', register: 'A', label: 'Ordner' },
    tags: [],
    linkedCompany: 'Beispiel GmbH',
    linkedVorgang: null,
    archived: true,
    createdAt: '2026-09-21T10:00:00.000Z',
    ...overrides,
  } as CompanyDocument;
}

const SYNC = { updatedAt: '2026-09-21T10:00:00.000Z', version: 1, deleted: false, deviceId: 'device-automatik', workspaceId: WS };

function freigegebenesAngebot(): Offer {
  return {
    id: 'offer-sperre',
    workspaceId: WS,
    offerNumber: 'AN-2026-0099',
    offerSequenceNumber: 99,
    status: 'freigegeben',
    customer: { name: 'Beispiel Kunde', contactPerson: '', street: 'Weg 1', zip: '12345', city: 'Stadt', email: '', phone: '' },
    title: 'Badsanierung',
    baustelle: 'Weg 1',
    positions: [],
    taxStatus: 'standard_19',
    offerDate: '2026-09-21',
    validUntil: '2026-10-21',
    introText: '',
    closingText: '',
    paymentTermsText: '',
    createdAt: '2026-09-21T10:00:00.000Z',
    sync: SYNC,
  } as unknown as Offer;
}

function fertigerBrief(): BusinessLetter {
  return {
    id: 'brief-sperre',
    workspaceId: WS,
    subject: 'Mitteilung',
    body: 'Sehr geehrte Damen und Herren.',
    letterDate: '2026-09-21',
    recipient: { name: 'Beispiel Kunde', street: 'Weg 1', zip: '12345', city: 'Stadt' },
    status: 'finalized',
    createdAt: '2026-09-21T10:00:00.000Z',
    sync: SYNC,
  } as unknown as BusinessLetter;
}

describe('I6–I8 — Bootstrap und automatische Ablage', () => {
  beforeEach(() => {
    resetSyncClientForTests({ ...createSyncClient(), deviceId: 'device-automatik', workspaceId: WS, serverWorkspaceId: WS, syncPolicy: 'cloud_ready' });
  });

  function bootstrapMitGeaendertemProfil(): void {
    persistAll(); // Vergleichsbasis des Verfolgers
    applyWorkspaceStateToStores({
      ...buildPersistedStateSnapshot(),
      companyProfile: { ...DEFAULT_COMPANY_PROFILE, companyName: 'Cloudstand GmbH', street: 'Cloudweg 1' },
    });
  }

  it('I6 Bootstrap: Firmenprofil aus der Cloud übernommen — kein neuer Auftrag für das abgewiesene Profil', () => {
    resetSyncOutboxForTests([denial('company_profile', WS)]);
    bootstrapMitGeaendertemProfil();
    expect(offenFuer('company_profile', WS)).toEqual([]);
  });

  it('I6-Gegenstück: ohne Abweisung reiht der Bootstrap die Änderung wie bisher ein', () => {
    resetSyncOutboxForTests([]);
    bootstrapMitGeaendertemProfil();
    expect(offenFuer('company_profile', WS)).toHaveLength(1);
  });

  async function angebotAblegen(): Promise<void> {
    hydrateOffers([freigegebenesAngebot()]);
    hydrateDocumentStore([archivDokument({ id: 'doc-angebot', classifiedKind: 'angebot', linkedOfferId: 'offer-sperre' })]);
    persistAll();
    const ergebnis = await ensureOfferArchived('offer-sperre');
    expect(ergebnis).toMatchObject({ ok: true, created: false });
    expect(getOfferById('offer-sperre')?.archiveDocumentId).toBe('doc-angebot');
  }

  it('I7 Angebotsablage beim Öffnen: Archivlink lokal gesetzt, kein neuer Auftrag für das abgewiesene Angebot', async () => {
    resetSyncOutboxForTests([denial('offer', 'offer-sperre')]);
    await angebotAblegen();
    expect(offenFuer('offer', 'offer-sperre')).toEqual([]);
  });

  it('I7-Gegenstück: ohne Abweisung wird der Archivlink wie bisher gesendet', async () => {
    resetSyncOutboxForTests([]);
    await angebotAblegen();
    expect(offenFuer('offer', 'offer-sperre')).toHaveLength(1);
  });

  async function briefAblegen(): Promise<void> {
    hydrateBusinessLetters([fertigerBrief()]);
    // Mit Datei am Dokument: keine PDF-Erzeugung, nur der fehlende Rückverweis wird nachgezogen.
    hydrateDocumentStore([archivDokument({ id: 'doc-brief', category: 'geschaeftsschreiben', linkedLetterId: 'brief-sperre', fileRefId: 'file-brief' })]);
    persistAll();
    const ergebnis = await ensureBusinessLetterArchived(fertigerBrief());
    expect(ergebnis).toMatchObject({ ok: true, created: false });
    expect(getBusinessLetterById('brief-sperre')?.documentId).toBe('doc-brief');
  }

  it('I8 Briefablage beim Öffnen: Dokumentverweis lokal gesetzt, kein neuer Auftrag für den abgewiesenen Brief', async () => {
    resetSyncOutboxForTests([denial('business_letter', 'brief-sperre')]);
    await briefAblegen();
    expect(offenFuer('business_letter', 'brief-sperre')).toEqual([]);
  });

  it('I8-Gegenstück: ohne Abweisung wird der Dokumentverweis wie bisher gesendet', async () => {
    resetSyncOutboxForTests([]);
    await briefAblegen();
    expect(offenFuer('business_letter', 'brief-sperre')).toHaveLength(1);
  });
});

describe('I5 — Vertrag: die bekannten automatischen Schreiber laufen im Schreibbereich', () => {
  const lies = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), 'utf8');

  it.each([
    ['Aufgabenabgleich nach einem Abzug', 'src/services/sync/syncPullPersistService.ts', /runAutomaticSyncWrite\(\(\) => reconcileInvoicePaymentTasks\(\)\)/],
    ['täglicher Aufgabenabgleich', 'src/services/invoice/invoicePaymentTaskSync.ts', /runAutomaticSyncWrite\(\(\) => reconcileInvoicePaymentTasks\(\{ today: day \}\)\)/],
    ['Nachtrags-Abzug', 'src/services/orderAmendment/orderAmendmentCloudPullOrchestrator.ts', /runAutomaticSyncWrite\(\(\) => \{\s*hydrateVorgangStore\(merge\.vorgaenge\);\s*return persistAll\(\);/],
    ['Rechnungsentwurfs-Spiegel beim Start', 'src/services/invoice/invoiceDraftCloudBridge.ts', /runAutomaticSyncWrite\(\(\) => applyLocalDraftCommitToMirror\(record, draft\)\)/],
    ['Bootstrap: Betriebsdaten/Firmenprofil', 'src/services/workspace/workspaceProvisioningService.ts', /runAutomaticSyncWrite\(\(\) => persistAll\(state\.setup\)\)/],
    ['Mitglieds-Angleich Leistungszeitraum', 'src/services/invoice/invoiceServicePeriodConfirmService.ts', /runAutomaticSyncWrite\(\(\) => resetInvoiceServicePeriodConfirmation\(vorgangId, invoiceId, false\)\)/],
    ['Mitglieds-Angleich Versandstand', 'src/services/invoiceSentService.ts', /runAutomaticSyncWrite\(\(\) => restoreInvoiceSentState\(vorgangId, invoiceId, target\)\)/],
    ['Angebotsablage (Rückverweis)', 'src/services/offer/offerArchiveService.ts', /runAutomaticSyncWrite\(\(\) => attachArchiveDocumentToOffer\(offer\.id, viaBackLink\.id\)\)/],
    ['Angebotsablage (neu)', 'src/services/offer/offerArchiveService.ts', /runAutomaticSyncWrite\(\(\) => attachArchiveDocumentToOffer\(offer\.id, result\.document\.id\)\)/],
    // FINANZ-CORE-01A (ANG-08/ANG-13) — Ablage unter fester Kennung und Versandstatus aus der Versandhistorie.
    ['Angebotsablage (Dokument)', 'src/services/offer/offerArchiveService.ts', /runAutomaticSyncWrite\(\(\) => addDocumentWithId\(/],
    ['Angebot versendet aus Versandhistorie', 'src/services/offer/offerDeliveryStatus.ts', /runAutomaticSyncWrite\(\(\) => markOfferSent\(offerId\)\)/],
    ['Briefablage (Rückverweis)', 'src/services/letter/businessLetterArchiveService.ts', /runAutomaticSyncWrite\(\(\) => attachArchiveDocumentToLetter\(letter\.id, ueberRueckweg\.id\)\)/],
    ['Briefablage (neu)', 'src/services/letter/businessLetterArchiveService.ts', /runAutomaticSyncWrite\(\(\) => attachArchiveDocumentToLetter\(letter\.id, ergebnis\.document\.id\)\)/],
    ['Briefablage (PDF-Bindung)', 'src/services/letter/businessLetterArchiveService.ts', /runAutomaticSyncWrite\(\(\) => persistAll\(\)\)/],
    ['Analyse beim ersten Ansehen', 'src/services/intakeWorkflowService.ts', /runAutomaticSyncWrite\(\(\) => commitDocumentWorkResultFromAnalysis\(workflow, item\)\)/],
  ])('%s', (_name, datei, muster) => {
    expect(lies(datei)).toMatch(muster);
  });

  it('der Änderungsverfolger nimmt im Schreibbereich den gesperrten Weg', () => {
    expect(lies('src/services/sync/syncChangeTrackerService.ts')).toMatch(
      /if \(isAutomaticSyncWriteActive\(\)\) \{\s*enqueueBackfillSyncOutbox\(auftrag\);\s*\} else \{\s*enqueueSyncOutbox\(auftrag\);/,
    );
  });

  it('nur bewusste Nutzerschritte rufen den Aufgabenabgleich außerhalb des Schreibbereichs', () => {
    // Zahlung, Rücknahme, Storno — jeweils direkt nach einer Nutzeraktion.
    const direkt = ['src/services/invoicePaymentService.ts', 'src/services/invoice/invoiceCancellationService.ts'];
    for (const datei of direkt) expect(lies(datei)).toMatch(/reconcileInvoicePaymentTasks\(\{ invoiceId/);
  });
});
